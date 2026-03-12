/**
 * @file sv_subscriber.cc
 * @brief SV Subscriber Core — Display ring buffer, analysis, JSON endpoints
 *
 * This module is the central hub that:
 *   1. Receives decoded compact frames from the drain thread (sv_highperf.cc)
 *   2. Maintains a display ring buffer for UI polling
 *   3. Runs sequence analysis (gap/duplicate/out-of-order detection)
 *   4. Feeds phasor engines (sv_phasor.cc + sv_phasor_csv.cc)
 *   5. Provides JSON endpoints called from Rust FFI (ffi.rs)
 *
 * All functions are extern "C" for Tauri FFI compatibility.
 */

#include "sv_highperf.h"
#include "sv_decoder.h"
#include "sv_phasor.h"
#include "sv_phasor_csv.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cstdarg>
#include <mutex>
#include <atomic>
#include <chrono>
#include <cmath>

/*============================================================================
 * Configuration
 *============================================================================*/

#define SUB_DISPLAY_CAPACITY    20000   /**< Display ring buffer size */
#define SUB_JSON_BUF_SIZE       (4 * 1024 * 1024) /**< 4 MB JSON buffer */
#define SUB_MAX_STREAMS         32      /**< Max unique svIDs tracked */

/*============================================================================
 * Stored Frame — What the display ring buffer holds
 *============================================================================*/

typedef struct {
    uint16_t    smpCnt;
    uint32_t    confRev;
    uint8_t     smpSynch;
    uint8_t     channelCount;
    int32_t     values[SV_COMPACT_MAX_CH];
    uint32_t    quality[SV_COMPACT_MAX_CH];
    uint32_t    errors;
    uint64_t    timestamp_us;
    uint16_t    appID;
    char        svID[SV_DEC_MAX_SVID_LEN + 1];
    uint32_t    frameIndex;         /**< Global sequential index */
    uint8_t     noASDU;             /**< Original wire frame ASDU count */
    uint8_t     asduIndex;          /**< 0-based ASDU index within wire frame */

    /* Analysis result for this frame */
    uint32_t    analysisFlags;
    uint16_t    expectedSmpCnt;
    uint16_t    gapSize;
} StoredFrame;

/*============================================================================
 * Per-Stream Analysis State
 *============================================================================*/

typedef struct {
    char        svID[SV_DEC_MAX_SVID_LEN + 1];
    uint16_t    lastSmpCnt;
    uint16_t    expectedSmpCnt;
    uint8_t     initialized;
    uint16_t    smpCntMax;          /**< Max before wrap (auto-detected or configured) */
    uint8_t     channelCount;       /**< Detected channel count */

    /* Counters */
    uint64_t    totalFrames;
    uint64_t    missingCount;
    uint64_t    outOfOrderCount;
    uint64_t    duplicateCount;
    uint64_t    errorCount;

    /* Phasor CSV stream index (-1 = not registered yet) */
    int         phasorCsvIdx;
} StreamState;

/*============================================================================
 * Module State (protected by g_mutex for display buffer access)
 *============================================================================*/

static std::mutex       g_mutex;

/* Display ring buffer */
static StoredFrame*     g_ring = nullptr;
static uint32_t         g_ring_head = 0;    /**< Next write position */
static uint32_t         g_ring_count = 0;   /**< Frames currently in ring */
static uint32_t         g_total_frames = 0; /**< Global frame counter */

/* Stream tracking */
static StreamState      g_streams[SUB_MAX_STREAMS];
static int              g_stream_count = 0;

/* Configuration */
static uint16_t         g_smp_cnt_max = 65535;  /**< 65535 = auto-detect */
static uint8_t          g_phasor_mode = 1;      /**< Default: full-cycle */
static uint8_t          g_phasor_initialized = 0;

/* JSON output buffer */
static char*            g_json_buf = nullptr;
static char*            g_detail_buf = nullptr;
static char*            g_csv_status_buf = nullptr;

/*============================================================================
 * Internal: Find or create stream state
 *============================================================================*/

static StreamState* find_or_create_stream(const char *svID) {
    /* Search existing */
    for (int i = 0; i < g_stream_count; i++) {
        if (strcmp(g_streams[i].svID, svID) == 0) {
            return &g_streams[i];
        }
    }

    /* Create new */
    if (g_stream_count >= SUB_MAX_STREAMS) return nullptr;

    StreamState *s = &g_streams[g_stream_count++];
    memset(s, 0, sizeof(StreamState));
    strncpy(s->svID, svID, SV_DEC_MAX_SVID_LEN);
    s->svID[SV_DEC_MAX_SVID_LEN] = '\0';
    s->smpCntMax = g_smp_cnt_max;
    s->phasorCsvIdx = -1;

    return s;
}

/*============================================================================
 * Internal: Run sequence analysis on a frame
 *============================================================================*/

static void analyze_frame(StreamState *stream, StoredFrame *frame) {
    stream->totalFrames++;

    if (frame->errors != 0) {
        stream->errorCount++;
    }

    if (!stream->initialized) {
        stream->lastSmpCnt = frame->smpCnt;
        stream->expectedSmpCnt = (frame->smpCnt + 1) % (stream->smpCntMax + 1);
        stream->initialized = 1;
        frame->analysisFlags = 0;
        frame->expectedSmpCnt = frame->smpCnt;
        frame->gapSize = 0;
        return;
    }

    uint16_t actual = frame->smpCnt;
    uint16_t expected = stream->expectedSmpCnt;
    uint16_t wrapAt = stream->smpCntMax;

    frame->expectedSmpCnt = expected;
    frame->analysisFlags = 0;
    frame->gapSize = 0;

    if (actual == expected) {
        /* Normal — no issues */
    } else if (actual == stream->lastSmpCnt) {
        /* Duplicate */
        frame->analysisFlags |= SV_ANALYSIS_DUPLICATE;
        stream->duplicateCount++;
    } else {
        /* Gap or out-of-order */
        uint16_t gap;
        if (actual > expected) {
            gap = actual - expected;
        } else {
            gap = (wrapAt + 1 - expected) + actual;
        }

        if (gap <= (wrapAt / 2)) {
            /* Forward gap — missing samples */
            frame->analysisFlags |= SV_ANALYSIS_MISSING_SEQ;
            frame->gapSize = gap;
            stream->missingCount += gap;
        } else {
            /* Out of order */
            frame->analysisFlags |= SV_ANALYSIS_OUT_OF_ORDER;
            stream->outOfOrderCount++;
        }
    }

    stream->lastSmpCnt = actual;
    stream->expectedSmpCnt = (actual + 1) % (wrapAt + 1);
}

/*============================================================================
 * Internal: Auto-detect smpCntMax from smpCnt wrap-around
 *============================================================================*/

static void auto_detect_smp_cnt_max(StreamState *stream, uint16_t smpCnt) {
    if (g_smp_cnt_max != 65535) return; /* Not in auto-detect mode */

    /* Detect common values: 3999 (4000Hz), 4799 (4800Hz), 79 (80/cycle), etc. */
    if (stream->totalFrames > 2 && stream->lastSmpCnt > smpCnt) {
        uint16_t detected = stream->lastSmpCnt;
        if (detected > 10) { /* Sanity check */
            stream->smpCntMax = detected;
        }
    }
}

/*============================================================================
 * Feed decoded frame from drain thread (called by sv_highperf.cc)
 *============================================================================*/

extern "C" int sv_subscriber_feed_decoded(const SvCompactFrame *compact,
                                           const char *svID) {
    if (!compact || !svID) return -1;
    if (!g_ring) return -1;

    std::lock_guard<std::mutex> lock(g_mutex);

    /* Find/create stream state */
    StreamState *stream = find_or_create_stream(svID);
    if (!stream) return -1;

    /* Update channel count */
    if (compact->channelCount > stream->channelCount) {
        stream->channelCount = compact->channelCount;
    }

    /* Auto-detect smpCntMax */
    auto_detect_smp_cnt_max(stream, compact->smpCnt);

    /* Write to display ring */
    uint32_t idx = g_ring_head % SUB_DISPLAY_CAPACITY;
    StoredFrame *sf = &g_ring[idx];
    sf->smpCnt = compact->smpCnt;
    sf->confRev = compact->confRev;
    sf->smpSynch = compact->smpSynch;
    sf->channelCount = compact->channelCount;
    memcpy(sf->values, compact->values, compact->channelCount * sizeof(int32_t));
    memcpy(sf->quality, compact->quality, compact->channelCount * sizeof(uint32_t));
    sf->errors = compact->errors;
    sf->timestamp_us = compact->timestamp_us;
    sf->appID = compact->appID;
    sf->noASDU = compact->noASDU;
    sf->asduIndex = compact->asduIndex;
    strncpy(sf->svID, svID, SV_DEC_MAX_SVID_LEN);
    sf->svID[SV_DEC_MAX_SVID_LEN] = '\0';
    sf->frameIndex = g_total_frames;

    /* Run analysis */
    analyze_frame(stream, sf);

    g_ring_head++;
    if (g_ring_count < SUB_DISPLAY_CAPACITY) g_ring_count++;
    g_total_frames++;

    /* Feed phasor engine (real-time mode) */
    sv_phasor_feed_sample(compact->values, compact->channelCount,
                          compact->timestamp_us);

    /* Feed phasor CSV engine (if stream is registered) */
    if (stream->phasorCsvIdx < 0 && stream->channelCount > 0 &&
        stream->totalFrames > 10) {
        /* Auto-register stream with CSV engine */
        uint16_t spc = (stream->smpCntMax == 65535) ? 80 : (stream->smpCntMax + 1);
        stream->phasorCsvIdx = sv_phasor_csv_register_stream(
            svID, spc, stream->channelCount);
    }
    if (stream->phasorCsvIdx >= 0) {
        sv_phasor_csv_feed_stream(stream->phasorCsvIdx, compact->values,
                                   compact->channelCount, compact->timestamp_us);
    }

    return 0;
}

/*============================================================================
 * JSON Helpers
 *============================================================================*/

static int json_append(char *buf, int pos, int capacity, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    int written = vsnprintf(buf + pos, capacity - pos, fmt, args);
    va_end(args);
    if (written < 0 || pos + written >= capacity) return pos; /* truncated */
    return pos + written;
}

/*============================================================================
 * API — Initialization
 *============================================================================*/

extern "C" void sv_subscriber_init(const char *sv_id, uint16_t smp_cnt_max) {
    std::lock_guard<std::mutex> lock(g_mutex);

    /* Allocate buffers */
    if (!g_ring) {
        g_ring = (StoredFrame*)calloc(SUB_DISPLAY_CAPACITY, sizeof(StoredFrame));
    }
    if (!g_json_buf) {
        g_json_buf = (char*)malloc(SUB_JSON_BUF_SIZE);
    }
    if (!g_detail_buf) {
        g_detail_buf = (char*)malloc(SUB_JSON_BUF_SIZE);
    }
    if (!g_csv_status_buf) {
        g_csv_status_buf = (char*)malloc(8192);
    }

    /* Reset state */
    g_ring_head = 0;
    g_ring_count = 0;
    g_total_frames = 0;
    g_stream_count = 0;
    memset(g_streams, 0, sizeof(g_streams));

    g_smp_cnt_max = smp_cnt_max;

    /* Configure phasor sample count */
    uint16_t spc = (smp_cnt_max == 65535) ? 80 : (smp_cnt_max + 1);
    uint8_t nch = 8; /* default channels — will auto-detect */

    /* Initialize phasor engine (real-time) */
    if (!g_phasor_initialized) {
        sv_phasor_init(spc, nch, g_phasor_mode);
        g_phasor_initialized = 1;
    }

    /* Initialize phasor CSV module */
    sv_phasor_csv_init_module();

    /* Initialize high-perf pipeline */
    sv_highperf_init();

    printf("[subscriber] Initialized (svID filter='%s', smpCntMax=%u, spc=%u)\n",
           sv_id ? sv_id : "*", (unsigned)smp_cnt_max, (unsigned)spc);
}

/*============================================================================
 * API — Poll JSON (combined frames + analysis + phasors)
 *============================================================================*/

extern "C" const char* sv_subscriber_get_poll_json(uint32_t start_index,
                                                     uint32_t max_frames) {
    std::lock_guard<std::mutex> lock(g_mutex);

    if (!g_json_buf) return "{}";

    int pos = 0;
    int cap = SUB_JSON_BUF_SIZE;

    pos = json_append(g_json_buf, pos, cap, "{\"totalFrames\":%u,\"totalReceived\":%u,\"ringCount\":%u,",
                      g_total_frames, g_total_frames, g_ring_count);

    /* --- Frames array --- */
    pos = json_append(g_json_buf, pos, cap, "\"frames\":[");

    if (g_ring_count > 0 && max_frames > 0) {
        /* Determine range to return */
        uint32_t oldest_index = (g_total_frames > SUB_DISPLAY_CAPACITY)
            ? (g_total_frames - SUB_DISPLAY_CAPACITY) : 0;

        uint32_t from = (start_index > oldest_index) ? start_index : oldest_index;
        uint32_t to = g_total_frames;
        if ((to - from) > max_frames) from = to - max_frames;

        int first = 1;
        for (uint32_t fi = from; fi < to; fi++) {
            uint32_t ri = fi % SUB_DISPLAY_CAPACITY;
            StoredFrame *sf = &g_ring[ri];

            if (!first) pos = json_append(g_json_buf, pos, cap, ",");
            first = 0;

            pos = json_append(g_json_buf, pos, cap,
                "{\"index\":%u,\"smpCnt\":%u,\"confRev\":%u,\"smpSynch\":%u,"
                "\"channelCount\":%u,\"appID\":%u,\"timestamp\":%llu,\"errors\":%u,"
                "\"svID\":\"%s\",\"noASDU\":%u,\"asduIndex\":%u,"
                "\"analysis\":{\"flags\":%u,\"expected\":%u,\"actual\":%u,"
                "\"gapSize\":%u,\"missingFrom\":%u,\"missingTo\":%u,\"dupTsGroupSize\":1},"
                "\"channels\":[",
                sf->frameIndex, (unsigned)sf->smpCnt, (unsigned)sf->confRev,
                (unsigned)sf->smpSynch, (unsigned)sf->channelCount,
                (unsigned)sf->appID, (unsigned long long)sf->timestamp_us,
                (unsigned)sf->errors, sf->svID,
                (unsigned)sf->noASDU, (unsigned)sf->asduIndex,
                (unsigned)sf->analysisFlags, (unsigned)sf->expectedSmpCnt,
                (unsigned)sf->smpCnt,
                (unsigned)sf->gapSize,
                (unsigned)((sf->analysisFlags & SV_ANALYSIS_MISSING_SEQ) ?
                    sf->expectedSmpCnt : 0),
                (unsigned)((sf->analysisFlags & SV_ANALYSIS_MISSING_SEQ) ?
                    ((sf->expectedSmpCnt + sf->gapSize - 1) % 65536) : 0));

            for (int c = 0; c < sf->channelCount; c++) {
                pos = json_append(g_json_buf, pos, cap, "%s%d",
                                  c > 0 ? "," : "", sf->values[c]);
            }
            pos = json_append(g_json_buf, pos, cap, "]}");
        }
    }

    pos = json_append(g_json_buf, pos, cap, "],");

    /* --- Analysis summary (flattened from primary stream for frontend) --- */
    {
        uint64_t agg_total = 0, agg_missing = 0, agg_ooo = 0, agg_dup = 0, agg_err = 0;
        const char *primary_svID = "";
        uint16_t primary_smpCntMax = 0;
        uint16_t primary_lastSmpCnt = 0;

        for (int i = 0; i < g_stream_count; i++) {
            StreamState *s = &g_streams[i];
            agg_total += s->totalFrames;
            agg_missing += s->missingCount;
            agg_ooo += s->outOfOrderCount;
            agg_dup += s->duplicateCount;
            agg_err += s->errorCount;
            if (i == 0) {
                primary_svID = s->svID;
                primary_smpCntMax = s->smpCntMax;
                primary_lastSmpCnt = s->lastSmpCnt;
            }
        }

        pos = json_append(g_json_buf, pos, cap,
            "\"analysis\":{\"totalFrames\":%llu,\"svID\":\"%s\","
            "\"missingCount\":%llu,\"outOfOrderCount\":%llu,"
            "\"duplicateCount\":%llu,\"errorCount\":%llu,"
            "\"lastSmpCnt\":%u,\"smpCntMax\":%u,\"streamCount\":%d},",
            (unsigned long long)agg_total, primary_svID,
            (unsigned long long)agg_missing, (unsigned long long)agg_ooo,
            (unsigned long long)agg_dup, (unsigned long long)agg_err,
            (unsigned)primary_lastSmpCnt, (unsigned)primary_smpCntMax,
            g_stream_count);
    }

    /* --- Phasor result (real-time) --- */
    const SvPhasorResult *pr = sv_phasor_get_result();
    pos = json_append(g_json_buf, pos, cap,
        "\"phasor\":{\"valid\":%d,\"mode\":%d,\"windowSize\":%u,"
        "\"computeCount\":%u,\"channels\":[",
        pr->valid, pr->mode, pr->windowSize, pr->computeCount);
    if (pr->valid) {
        for (int c = 0; c < pr->channelCount; c++) {
            if (c > 0) pos = json_append(g_json_buf, pos, cap, ",");
            pos = json_append(g_json_buf, pos, cap, "{\"mag\":%.6f,\"ang\":%.4f}",
                              pr->channels[c].magnitude, pr->channels[c].angle_deg);
        }
    }
    pos = json_append(g_json_buf, pos, cap, "]},");

    /* --- Status (buffer usage for footer) --- */
    pos = json_append(g_json_buf, pos, cap,
        "\"status\":{\"bufferUsed\":%u,\"bufferCapacity\":%u}",
        g_ring_count, (unsigned)SUB_DISPLAY_CAPACITY);

    pos = json_append(g_json_buf, pos, cap, "}");

    if (pos >= cap) pos = cap - 1;
    g_json_buf[pos] = '\0';

    return g_json_buf;
}

/*============================================================================
 * API — Frame detail JSON (on-demand, for frame viewer)
 *============================================================================*/

extern "C" const char* sv_subscriber_get_frame_detail_json(uint32_t frame_index) {
    std::lock_guard<std::mutex> lock(g_mutex);

    if (!g_detail_buf) return "{}";

    /* Check if frame is still in the ring */
    uint32_t oldest = (g_total_frames > SUB_DISPLAY_CAPACITY)
        ? (g_total_frames - SUB_DISPLAY_CAPACITY) : 0;

    if (frame_index < oldest || frame_index >= g_total_frames) {
        snprintf(g_detail_buf, SUB_JSON_BUF_SIZE,
                 "{\"error\":\"Frame %u not in buffer (range %u..%u)\"}",
                 frame_index, oldest, g_total_frames - 1);
        return g_detail_buf;
    }

    uint32_t ri = frame_index % SUB_DISPLAY_CAPACITY;
    StoredFrame *sf = &g_ring[ri];

    int pos = 0;
    int cap = SUB_JSON_BUF_SIZE;

    pos = json_append(g_detail_buf, pos, cap,
        "{\"frameIndex\":%u,\"smpCnt\":%u,\"confRev\":%u,\"smpSynch\":%u,"
        "\"channelCount\":%u,\"appID\":%u,\"timestamp_us\":%llu,"
        "\"errors\":%u,\"svID\":\"%s\","
        "\"analysisFlags\":%u,\"expectedSmpCnt\":%u,\"gapSize\":%u,",
        sf->frameIndex, (unsigned)sf->smpCnt, (unsigned)sf->confRev,
        (unsigned)sf->smpSynch, (unsigned)sf->channelCount,
        (unsigned)sf->appID, (unsigned long long)sf->timestamp_us,
        (unsigned)sf->errors, sf->svID,
        (unsigned)sf->analysisFlags, (unsigned)sf->expectedSmpCnt,
        (unsigned)sf->gapSize);

    /* Channel details with values and quality */
    pos = json_append(g_detail_buf, pos, cap, "\"channels\":[");
    for (int c = 0; c < sf->channelCount; c++) {
        if (c > 0) pos = json_append(g_detail_buf, pos, cap, ",");
        pos = json_append(g_detail_buf, pos, cap,
            "{\"index\":%d,\"value\":%d,\"quality\":%u}",
            c, sf->values[c], (unsigned)sf->quality[c]);
    }
    pos = json_append(g_detail_buf, pos, cap, "]}");

    if (pos >= cap) pos = cap - 1;
    g_detail_buf[pos] = '\0';

    return g_detail_buf;
}

/*============================================================================
 * API — Reset
 *============================================================================*/

extern "C" void sv_subscriber_reset(void) {
    std::lock_guard<std::mutex> lock(g_mutex);

    g_ring_head = 0;
    g_ring_count = 0;
    g_total_frames = 0;
    g_stream_count = 0;
    memset(g_streams, 0, sizeof(g_streams));

    sv_phasor_reset();
    sv_phasor_csv_reset();

    printf("[subscriber] State reset\n");
}

/*============================================================================
 * API — Phasor mode
 *============================================================================*/

extern "C" void sv_subscriber_set_phasor_mode(uint8_t mode) {
    g_phasor_mode = mode;
    sv_phasor_set_mode(mode);
    printf("[subscriber] Phasor mode set to %d\n", mode);
}

/*============================================================================
 * API — CSV phasor logger wrappers (called from ffi.rs)
 *============================================================================*/

extern "C" int sv_subscriber_csv_start(const char *filepath) {
    return sv_phasor_csv_start(filepath);
}

extern "C" void sv_subscriber_csv_stop(void) {
    sv_phasor_csv_stop();
}

extern "C" const char* sv_subscriber_csv_status_json(void) {
    if (!g_csv_status_buf) {
        g_csv_status_buf = (char*)malloc(8192);
        if (!g_csv_status_buf) return "{}";
    }

    PhasorCsvStatus status;
    sv_phasor_csv_get_status(&status);

    snprintf(g_csv_status_buf, 8192,
        "{\"logging\":%s,\"rowsWritten\":%llu,\"streamCount\":%d,"
        "\"half\":{\"computeCount\":%u,\"avgTimeUs\":%.2f,\"minTimeUs\":%.2f,\"maxTimeUs\":%.2f},"
        "\"full\":{\"computeCount\":%u,\"avgTimeUs\":%.2f,\"minTimeUs\":%.2f,\"maxTimeUs\":%.2f},"
        "\"slide\":{\"computeCount\":%u,\"avgTimeUs\":%.2f,\"minTimeUs\":%.2f,\"maxTimeUs\":%.2f}}",
        status.logging ? "true" : "false",
        (unsigned long long)status.rowsWritten,
        status.streamCount,
        status.half.computeCount, status.half.avgComputeTimeUs,
        status.half.minComputeTimeUs, status.half.maxComputeTimeUs,
        status.full.computeCount, status.full.avgComputeTimeUs,
        status.full.minComputeTimeUs, status.full.maxComputeTimeUs,
        status.slide.computeCount, status.slide.avgComputeTimeUs,
        status.slide.minComputeTimeUs, status.slide.maxComputeTimeUs);

    return g_csv_status_buf;
}
