/**
 * @file sv_subscriber.cc
 * @brief SV Subscriber - Display Buffer, Analysis & JSON Engine
 * 
 * This module stores decoded SV frames, runs sequence analysis,
 * and provides a JSON-based interface for the frontend.
 * 
 * Designed for Tauri FFI:
 *   - All exported functions are extern "C" with simple types
 *   - JSON output for easy Rust string handling → JS frontend
 *   - Display buffer protected by mutex (drain thread writes, UI reads)
 * 
 * Data Flow (High-Perf SPSC Pipeline):
 * ```
 * SV Publisher → Npcap → sv_highperf_capture_feed() [lock-free]
 *                              │
 *                              ▼
 *                        SPSC Ring (1M slots, lock-free)
 *                              │
 *                              ▼
 *                        Drain Thread (batch 100K)
 *                              │
 *                              ▼
 *                   sv_subscriber_feed_decoded() [mutex]
 *                              │ m
 *                              ▼
 *                   Display Ring Buffer (5K) + Analysis
 *                              │
 *                              ▼
 *                   sv_subscriber_get_*_json() → Frontend
 * ```
 */

#include "sv_decoder.h"
#include "sv_highperf.h"
#include "sv_phasor.h"
#include "sv_phasor_csv.h"
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cstdarg>
#include <mutex>

/*============================================================================
 * Configuration
 *============================================================================*/

#define MAX_STORED_FRAMES   20000   /**< Ring buffer capacity (~2s @9600fps, ~250s @80Hz). Sized so JS can read sequentially at 2000 frames/poll before overflow */
#define POLL_JSON_BUF_SIZE  1048576 /**< Combined poll response buffer (1MB — supports 2000 frames/poll with 8ch) */
#define DETAIL_JSON_BUF_SIZE 4096   /**< Buffer for single frame detail */

/*============================================================================
 * Module State
 *============================================================================*/

/** Stored decoded frame with analysis result */
typedef struct {
    SvDecodedFrame  frame;
    SvAnalysisResult analysis;
    uint8_t         used;       /**< 1 if slot is occupied */
} StoredFrame;

static StoredFrame*  g_frames = nullptr;       /**< Heap-allocated: 20K × ~3KB ≈ 58 MB */
static uint32_t     g_writeIndex = 0;       /**< Next write position (ring) */
static uint32_t     g_totalReceived = 0;    /**< Total frames ever received */
static uint32_t     g_frameSequence = 0;    /**< Sequential frame counter */

static SvAnalysisState g_analysis;          /**< Analysis state for main stream */
static bool         g_initialized = false;
static bool         g_smpcnt_autodetected = false;  /**< True once smpCntMax auto-detected */
static uint16_t     g_observed_max_smpcnt = 0;      /**< Highest smpCnt seen so far */
static std::mutex   g_mutex;

/*============================================================================
 * Duplicate Timestamp Tracking (Per-svID)
 *
 * Detects when multiple packets from the SAME stream arrive with the same
 * pcap timestamp. This is a key diagnostic for npcap API comparison:
 *   - sendQueue:  batches packets → many share the same timestamp
 *   - sendPacket: sends one-by-one → each gets a unique timestamp
 *
 * Per-svID tracking prevents false positives when multiple publishers
 * (e.g., MU01 + MU02) send simultaneously — their packets naturally share
 * a pcap timestamp but are different streams, NOT duplicate timestamps.
 *
 * Tracked metrics:
 *   g_dup_ts_total     — Total frames that share timestamp with previous
 *                         frame FROM THE SAME svID
 *   g_dup_ts_groups    — Number of groups of ≥2 consecutive same-timestamp
 *                         frames within the same svID
 *   g_dup_ts_max_group — Largest group size seen (e.g., 80 = one full cycle batched)
 *   g_dup_ts_streams[] — Per-svID tracking state (indexed by svID_hash, 256 buckets)
 *============================================================================*/

/** Per-stream dup-timestamp tracking state */
typedef struct {
    uint64_t last_ts;       /**< Previous frame's timestamp (µs) for this svID */
    uint32_t cur_group;     /**< Current consecutive same-ts group size (0=no frames yet) */
} DupTsStream;

static uint64_t     g_dup_ts_total = 0;       /**< Total duplicate-timestamp frames */
static uint64_t     g_dup_ts_groups = 0;      /**< Number of dup-timestamp groups */
static uint32_t     g_dup_ts_max_group = 0;   /**< Largest group of same-ts frames */
static DupTsStream  g_dup_ts_streams[256];    /**< Per-svID tracking (indexed by svID_hash) */

/*============================================================================
 * Per-Stream State — Multi-publisher support
 *
 * Each discovered svID gets a SubStream entry with:
 *   - Its own CSV phasor stream index (for independent CSV logging)
 *   - Independent smpCnt auto-detection (each MU may run at different rate)
 *   - Per-stream frame counter for auto-detection threshold
 *
 * The first discovered stream is the "primary" stream, used for:
 *   - Display phasor (sv_phasor.h — frontend phasor diagram)
 *   - Main analysis state (g_analysis — used in poll JSON)
 *============================================================================*/

#define MAX_SUB_STREAMS     16

typedef struct {
    char        svID[SV_DEC_MAX_SVID_LEN + 1];
    int         csvStreamIdx;           /**< Index into phasor_csv streams (-1 = not yet registered) */
    uint8_t     active;
    uint8_t     smpcnt_autodetected;    /**< 1 = smpCntMax detected for this stream */
    uint16_t    observed_max_smpcnt;    /**< Highest smpCnt seen so far */
    uint16_t    samplesPerCycle;        /**< Derived from observed smpCntMax */
    uint32_t    totalFrames;            /**< Per-stream frame counter */
    SvAnalysisState analysis;           /**< Per-stream sequence/duplicate tracking */
} SubStream;

static SubStream    g_subStreams[MAX_SUB_STREAMS];
static int          g_subStreamCount = 0;
static int          g_primaryStreamIdx = -1;    /**< First discovered stream (for display phasor) */

/**
 * @brief Derive samples-per-cycle from smpCntMax
 *
 * Standard IEC 61850-9-2 rates:
 *   80 spc × 50Hz = 4000 Hz (smpCntMax = 3999)
 *   80 spc × 60Hz = 4800 Hz (smpCntMax = 4799)
 *  256 spc × 50Hz = 12800 Hz (smpCntMax = 12799)
 *  256 spc × 60Hz = 15360 Hz (smpCntMax = 15359)
 */
static uint16_t derive_spc(uint16_t smpCntMax)
{
    uint32_t totalRate = (uint32_t)smpCntMax + 1;
    if (totalRate <= 256) return (uint16_t)totalRate;
    if (totalRate % 60 == 0 && (totalRate / 60 == 80 || totalRate / 60 == 256))
        return (uint16_t)(totalRate / 60);
    if (totalRate % 50 == 0 && (totalRate / 50 == 80 || totalRate / 50 == 256))
        return (uint16_t)(totalRate / 50);
    return 80; /* Fallback: standard 80 spc */
}

/**
 * @brief Find or register a SubStream by svID
 *
 * If the svID is already known, returns its index.
 * Otherwise registers a new SubStream (smpCnt auto-detection pending).
 *
 * @param svID  Stream identifier
 * @return SubStream index (0..MAX_SUB_STREAMS-1), or -1 if full
 */
static int find_or_register_substream(const char *svID)
{
    if (!svID || svID[0] == '\0') return -1;

    /* Search existing */
    for (int i = 0; i < g_subStreamCount; i++) {
        if (g_subStreams[i].active && strcmp(g_subStreams[i].svID, svID) == 0)
            return i;
    }

    /* Register new */
    if (g_subStreamCount >= MAX_SUB_STREAMS) {
        printf("[subscriber] WARNING: max streams (%d) reached, ignoring '%s'\n",
               MAX_SUB_STREAMS, svID);
        return -1;
    }

    int idx = g_subStreamCount;
    SubStream *ss = &g_subStreams[idx];
    memset(ss, 0, sizeof(SubStream));
    strncpy(ss->svID, svID, SV_DEC_MAX_SVID_LEN);
    ss->svID[SV_DEC_MAX_SVID_LEN] = '\0';
    ss->active = 1;
    ss->csvStreamIdx = -1;  /* Will be set after smpCnt auto-detection */

    if (g_primaryStreamIdx < 0) {
        g_primaryStreamIdx = idx;
    }

    g_subStreamCount++;
    printf("[subscriber] Auto-discovered stream '%s' (index %d, primary=%s)\n",
           svID, idx, (idx == g_primaryStreamIdx) ? "yes" : "no");
    return idx;
}

/** Buffer for combined poll response */
static char g_pollBuf[POLL_JSON_BUF_SIZE];

/** Buffer for single frame detail (on-demand, frame viewer) */
static char g_detailBuf[DETAIL_JSON_BUF_SIZE];

/*============================================================================
 * Initialization
 *============================================================================*/

extern "C" {

/**
 * @brief Initialize the subscriber
 * 
 * @param svID       Stream ID to track (e.g., "MU01"). Empty string = track all.
 * @param smpCntMax  Maximum sample count before wrap (e.g., 3999 for 4000Hz, 4799 for 4800Hz)
 */
void sv_subscriber_init(const char *svID, uint16_t smpCntMax)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    
    /* Allocate display ring buffer on heap (too large for stack: ~400 MB) */
    if (!g_frames) {
        g_frames = (StoredFrame*)calloc(MAX_STORED_FRAMES, sizeof(StoredFrame));
        if (!g_frames) {
            printf("[subscriber] FATAL: Failed to allocate display buffer (%zu MB)\n",
                   (size_t)(MAX_STORED_FRAMES * sizeof(StoredFrame)) / (1024*1024));
            return;
        }
        printf("[subscriber] Display buffer allocated: %d slots × %zu bytes = %zu MB\n",
               MAX_STORED_FRAMES, sizeof(StoredFrame),
               (size_t)(MAX_STORED_FRAMES * sizeof(StoredFrame)) / (1024*1024));
    } else {
        memset(g_frames, 0, (size_t)MAX_STORED_FRAMES * sizeof(StoredFrame));
    }
    
    g_writeIndex = 0;
    g_totalReceived = 0;
    g_frameSequence = 0;
    
    sv_analysis_init(&g_analysis, svID ? svID : "", smpCntMax);
    g_initialized = true;
    g_smpcnt_autodetected = false;
    g_observed_max_smpcnt = 0;
    
    /* Reset multi-stream state */
    memset(g_subStreams, 0, sizeof(g_subStreams));
    g_subStreamCount = 0;
    g_primaryStreamIdx = -1;
    
    /* Initialize phasor CSV module (multi-stream ready — streams registered on auto-discovery) */
    sv_phasor_csv_init_module();
    
    /* Initialize display phasor engine if smpCntMax is known */
    if (smpCntMax > 0) {
        uint16_t spc = derive_spc(smpCntMax);
        sv_phasor_init(spc, PHASOR_MAX_CHANNELS, PHASOR_MODE_FULL_CYCLE);
    }
    
    /* Initialize lock-free SPSC pipeline */
    sv_highperf_init();
    printf("[subscriber] SPSC pipeline initialized\n");
    
    printf("[subscriber] Initialized: svID='%s', smpCntMax=%u, buffer=%d frames, "
           "multi-stream=ready (max %d streams)\n",
           svID ? svID : "(all)", smpCntMax, MAX_STORED_FRAMES, MAX_SUB_STREAMS);
}

/*============================================================================
 * Feed Decoded Frame — Called by drain thread with pre-decoded compact frames
 *
 * Data path: SPSC ring → drain thread → this function → display buffer
 *
 * The mutex protects g_frames[] which is shared between:
 *   - Drain thread (writes via this function)
 *   - UI poll thread (reads via get_poll_json / get_frame_detail_json)
 *
 * Lock duration is short (~200ns) because there's no decode work inside.
 *============================================================================*/

int sv_subscriber_feed_decoded(const SvCompactFrame *compact, const char *svID)
{
    if (!compact || !g_initialized || !g_frames) return -1;
    
    std::lock_guard<std::mutex> lock(g_mutex);
    
    StoredFrame *slot = &g_frames[g_writeIndex % MAX_STORED_FRAMES];
    SvDecodedFrame *frame = &slot->frame;
    
    /* Populate frame from compact — zero only first ASDU (skip unused 7 ASDUs = ~2KB) */
    frame->errors = 0;
    frame->noASDU = 0;
    frame->asduCount = 0;
    frame->rawLength = 0;
    memset(&frame->header, 0, sizeof(SvFrameHeader));
    frame->frameIndex = g_frameSequence++;
    frame->timestamp_us = compact->timestamp_us;
    frame->header.appID = compact->appID;
    frame->noASDU = compact->noASDU;  /* Original from wire (1,2,4,8,16) */
    frame->asduCount = 1;             /* Always 1: each compact frame = 1 ASDU */
    frame->errors = compact->errors;
    
    SvASDU *asdu = &frame->asdus[0];
    memset(asdu, 0, sizeof(SvASDU));  /* Zero only the one ASDU we use */
    
    /* Store ASDU index AFTER memset (which ASDU in the original frame is this) */
    asdu->asduIndex = compact->asduIndex;
    strncpy(asdu->svID, svID, SV_DEC_MAX_SVID_LEN);
    asdu->svID[SV_DEC_MAX_SVID_LEN] = '\0';
    asdu->smpCnt = compact->smpCnt;
    asdu->confRev = compact->confRev;
    asdu->smpSynch = compact->smpSynch;
    asdu->channelCount = compact->channelCount;
    asdu->errors = compact->errors;
    
    for (int ch = 0; ch < compact->channelCount && ch < SV_DEC_MAX_CHANNELS; ch++) {
        asdu->values[ch] = compact->values[ch];
        asdu->quality[ch] = compact->quality[ch];
    }
    
    /* Auto-detect smpCntMax — GLOBAL (for primary stream / g_analysis) */
    if (!g_smpcnt_autodetected) {
        if (compact->smpCnt > g_observed_max_smpcnt) {
            g_observed_max_smpcnt = compact->smpCnt;
        }
        if (compact->smpCnt == 0 && g_observed_max_smpcnt > 0 && g_totalReceived > 10) {
            g_smpcnt_autodetected = true;
            char savedSvID[SV_DEC_MAX_SVID_LEN + 1];
            strncpy(savedSvID, g_analysis.svID, SV_DEC_MAX_SVID_LEN);
            savedSvID[SV_DEC_MAX_SVID_LEN] = '\0';
            sv_analysis_init(&g_analysis, savedSvID, g_observed_max_smpcnt);
            
            memset(g_frames, 0, (size_t)MAX_STORED_FRAMES * sizeof(StoredFrame));
            g_writeIndex = 0;
            g_totalReceived = 0;
            g_frameSequence = 0;
            
            /* Reset dup-ts tracking on auto-detect reset */
            g_dup_ts_total = 0;
            g_dup_ts_groups = 0;
            g_dup_ts_max_group = 0;
            memset(g_dup_ts_streams, 0, sizeof(g_dup_ts_streams));
            
            /* Re-initialize display phasor with newly detected spc */
            {
                uint16_t spc = derive_spc(g_observed_max_smpcnt);
                sv_phasor_init(spc, PHASOR_MAX_CHANNELS, PHASOR_MODE_FULL_CYCLE);
            }
            
            printf("[subscriber] Auto-detected smpCntMax=%u (sampleRate=%u Hz)\n",
                   g_observed_max_smpcnt, (unsigned)(g_observed_max_smpcnt + 1));
            return 0;
        }
    }
    
    /* ── Multi-Stream Auto-Discovery (moved up for per-stream analysis) ── */
    int sidx = find_or_register_substream(svID);
    SubStream *ss = (sidx >= 0) ? &g_subStreams[sidx] : NULL;

    if (ss) {
        ss->totalFrames++;

        /* Per-stream smpCnt auto-detection */
        if (!ss->smpcnt_autodetected) {
            if (compact->smpCnt > ss->observed_max_smpcnt) {
                ss->observed_max_smpcnt = compact->smpCnt;
            }
            if (compact->smpCnt == 0 && ss->observed_max_smpcnt > 0
                && ss->totalFrames > 10) {
                ss->smpcnt_autodetected = 1;
                ss->samplesPerCycle = derive_spc(ss->observed_max_smpcnt);

                /* Init per-stream analysis with this stream's svID and smpCntMax */
                sv_analysis_init(&ss->analysis, ss->svID, ss->observed_max_smpcnt);

                /* Register this stream's CSV phasor engines */
                ss->csvStreamIdx = sv_phasor_csv_register_stream(
                    ss->svID, ss->samplesPerCycle, compact->channelCount);
                /* Auto-start shared CSV file (no-op if already open) */
                sv_phasor_csv_auto_start(NULL);

                /* If this is the primary stream, also init display phasor */
                if (sidx == g_primaryStreamIdx) {
                    sv_phasor_init(ss->samplesPerCycle, PHASOR_MAX_CHANNELS,
                                   PHASOR_MODE_FULL_CYCLE);
                }

                printf("[subscriber] Stream '%s' smpCntMax=%u spc=%u csvIdx=%d\n",
                       ss->svID, ss->observed_max_smpcnt,
                       ss->samplesPerCycle, ss->csvStreamIdx);
            }
        }
    }

    /* ── Run analysis — per-stream if available, else global fallback ── */
    if (ss && ss->smpcnt_autodetected) {
        /* Per-stream analysis: duplicate/missing/OoO is tracked per svID */
        sv_analysis_process(&ss->analysis, frame, &slot->analysis);
        /* Also feed global analysis for primary stream (poll JSON summary) */
        if (sidx == g_primaryStreamIdx) {
            SvAnalysisResult tmp;
            sv_analysis_process(&g_analysis, frame, &tmp);
        }
    } else {
        /* Fallback: global analysis (before per-stream smpCntMax is known) */
        sv_analysis_process(&g_analysis, frame, &slot->analysis);
    }

    /* ── Duplicate Timestamp Detection (Per-svID) ── */
    DupTsStream *dts = &g_dup_ts_streams[compact->svID_hash];
    if (dts->cur_group > 0 && compact->timestamp_us == dts->last_ts) {
        g_dup_ts_total++;
        dts->cur_group++;
        if (dts->cur_group == 2) {
            g_dup_ts_groups++;
        }
        if (dts->cur_group > g_dup_ts_max_group) {
            g_dup_ts_max_group = dts->cur_group;
        }
    } else {
        dts->cur_group = 1;
    }
    dts->last_ts = compact->timestamp_us;
    slot->analysis.dupTsGroupSize = dts->cur_group;

    /* ── Per-Stream CSV + Phasor Feeding ── */
    if (ss) {
        /* Feed to per-stream CSV phasor engines */
        if (ss->smpcnt_autodetected && ss->csvStreamIdx >= 0) {
            sv_phasor_csv_feed_stream(ss->csvStreamIdx,
                                      compact->values, compact->channelCount,
                                      compact->timestamp_us);
        }

        /* Feed display phasor (frontend) — primary stream only */
        if (sidx == g_primaryStreamIdx) {
            sv_phasor_feed_sample(compact->values, compact->channelCount,
                                  compact->timestamp_us);
        }
    }
    
    slot->used = 1;
    g_writeIndex++;
    g_totalReceived++;
    
    return 0;
}

/*============================================================================
 * JSON Data Retrieval (for Frontend via Tauri FFI)
 *============================================================================*/

/**
 * @brief Helper: Append to JSON buffer with bounds checking
 */
static int json_append(char *buf, size_t bufLen, size_t *pos, const char *fmt, ...)
{
    if (*pos >= bufLen - 1) return -1; /* Already full — prevent SIZE_MAX wrap */
    
    va_list args;
    va_start(args, fmt);
    int written = vsnprintf(buf + *pos, bufLen - *pos, fmt, args);
    va_end(args);
    
    if (written < 0 || (size_t)written >= bufLen - *pos) {
        *pos = bufLen - 1; /* Clamp to end — null terminator preserved */
        buf[*pos] = '\0';
        return -1; /* Truncated */
    }
    *pos += (size_t)written;
    return 0;
}

/**
 * @brief Reset subscriber state
 */
void sv_subscriber_reset(void)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    
    if (g_frames) {
        memset(g_frames, 0, (size_t)MAX_STORED_FRAMES * sizeof(StoredFrame));
    }
    g_writeIndex = 0;
    g_totalReceived = 0;
    g_frameSequence = 0;
    
    /* Reset duplicate timestamp tracking */
    g_dup_ts_total = 0;
    g_dup_ts_groups = 0;
    g_dup_ts_max_group = 0;
    memset(g_dup_ts_streams, 0, sizeof(g_dup_ts_streams));
    
    sv_analysis_reset(&g_analysis);
    
    /* Reset phasor engines */
    sv_phasor_reset();
    sv_phasor_csv_reset();
    
    /* Reset multi-stream state */
    for (int i = 0; i < g_subStreamCount; i++) {
        g_subStreams[i].totalFrames = 0;
        g_subStreams[i].smpcnt_autodetected = 0;
        g_subStreams[i].observed_max_smpcnt = 0;
        sv_analysis_reset(&g_subStreams[i].analysis);
    }
    
    printf("[subscriber] State reset\n");
}

/*============================================================================
 * Combined Poll Response — Single call replaces get_frames + get_analysis
 *                          + get_status + get_capture_stats
 *============================================================================*/

/**
 * @brief Get all polling data in a single JSON response
 * 
 * Combines frames, analysis, status, and capture stats into one JSON object.
 * This avoids 4 separate IPC round-trips from the frontend.
 * Uses its own buffer (g_pollBuf) to avoid conflicts with other JSON functions.
 * 
 * @param startIndex  Start from this frame index
 * @param maxFrames   Maximum number of frames to return
 * @return JSON string with all poll data
 */
const char* sv_subscriber_get_poll_json(uint32_t startIndex, uint32_t maxFrames)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    
    size_t pos = 0;
    char *buf = g_pollBuf;
    size_t bufLen = POLL_JSON_BUF_SIZE;
    
    /* --- Start root object --- */
    json_append(buf, bufLen, &pos, "{");
    
    /* --- 1. Analysis summary (small, goes first) --- */
    json_append(buf, bufLen, &pos,
        "\"analysis\":{\"svID\":\"%s\",\"totalFrames\":%llu,"
        "\"missingCount\":%llu,\"outOfOrderCount\":%llu,"
        "\"duplicateCount\":%llu,\"errorCount\":%llu,"
        "\"lastSmpCnt\":%u,\"expectedSmpCnt\":%u,"
        "\"smpCntMax\":%u,"
        "\"dupTsTotal\":%llu,\"dupTsGroups\":%llu,"
        "\"dupTsMaxGroup\":%u},",
        g_analysis.svID,
        (unsigned long long)g_analysis.totalFrames,
        (unsigned long long)g_analysis.missingCount,
        (unsigned long long)g_analysis.outOfOrderCount,
        (unsigned long long)g_analysis.duplicateCount,
        (unsigned long long)g_analysis.errorCount,
        g_analysis.lastSmpCnt,
        g_analysis.expectedSmpCnt,
        g_analysis.smpCntMax,
        (unsigned long long)g_dup_ts_total,
        (unsigned long long)g_dup_ts_groups,
        g_dup_ts_max_group);
    
    /* --- 2. Status (small) --- */
    uint32_t bufUsed = (g_totalReceived < MAX_STORED_FRAMES) ? g_totalReceived : MAX_STORED_FRAMES;
    json_append(buf, bufLen, &pos,
        "\"status\":{\"initialized\":%s,\"totalReceived\":%u,"
        "\"bufferCapacity\":%d,\"bufferUsed\":%u},",
        g_initialized ? "true" : "false",
        g_totalReceived,
        MAX_STORED_FRAMES,
        bufUsed);
    
    /* --- 3. Frames (LEAN — only fields needed for table + event log) --- */
    
    uint32_t totalStored = bufUsed;
    uint32_t oldestIndex = (g_totalReceived > MAX_STORED_FRAMES) 
                          ? (g_totalReceived - MAX_STORED_FRAMES) : 0;
    
    if (maxFrames == 0) maxFrames = 2000;
    if (maxFrames > totalStored) maxFrames = totalStored;
    
    /* Sequential read with gap detection.
     * Let the client read sequentially from where it left off. If the client
     * fell behind (ring buffer overwritten), report the gap so JS can handle
     * it cleanly. This is how production SCADA/HMI systems work:
     * - Analysis engine sees 100% of frames (via SPSC drain thread)
     * - Display table reads sequentially, gaps reported not hidden */
    uint8_t gap = 0;
    uint32_t gapFrom = 0;
    uint32_t gapTo = 0;
    
    if (startIndex < oldestIndex) {
        /* Client fell behind — ring buffer overwritten unread frames */
        gap = 1;
        gapFrom = startIndex;
        gapTo = oldestIndex - 1;
        startIndex = oldestIndex;
    }
    
    /* Don't overshoot past what's available */
    if (startIndex > g_totalReceived) startIndex = g_totalReceived;
    
    /* Compute actual frames available from startIndex */
    uint32_t available = (g_totalReceived > startIndex) ? (g_totalReceived - startIndex) : 0;
    if (maxFrames > available) maxFrames = available;
    
    json_append(buf, bufLen, &pos, "\"totalReceived\":%u,\"oldestIndex\":%u,"
        "\"gap\":%s,\"gapFrom\":%u,\"gapTo\":%u,\"frames\":[",
        g_totalReceived, oldestIndex,
        gap ? "true" : "false", gapFrom, gapTo);
    
    uint32_t count = 0;
    for (uint32_t i = startIndex; i < g_totalReceived && count < maxFrames; i++) {
        uint32_t slot = i % MAX_STORED_FRAMES;
        StoredFrame *sf = &g_frames[slot];
        
        if (!sf->used) continue;
        
        SvDecodedFrame *f = &sf->frame;
        
        if (count > 0) json_append(buf, bufLen, &pos, ",");
        
        /* Use first ASDU for basic fields */
        const SvASDU *a = (f->asduCount > 0) ? &f->asdus[0] : NULL;
        
        char errStr[256];
        uint32_t allErrors = f->errors;
        if (a) allErrors |= a->errors;
        sv_format_errors(allErrors, errStr, sizeof(errStr));
        
        /* Lean frame — table + event-log fields only.
         * Full detail (MAC, VLAN, quality) via get_frame_detail on demand. */
        json_append(buf, bufLen, &pos, 
            "{\"index\":%u,\"timestamp\":%llu,\"svID\":\"%s\",\"smpCnt\":%u,"
            "\"channelCount\":%u,\"errors\":%u,\"errorStr\":\"%s\","
            "\"noASDU\":%u,\"asduIndex\":%u,",
            f->frameIndex,
            (unsigned long long)f->timestamp_us,
            a ? a->svID : "",
            a ? a->smpCnt : 0,
            a ? a->channelCount : 0,
            allErrors,
            errStr,
            f->noASDU,
            a ? a->asduIndex : 0);
        
        /* Channel values only (quality via get_frame_detail) */
        json_append(buf, bufLen, &pos, "\"channels\":[");
        if (a) {
            for (int ch = 0; ch < a->channelCount; ch++) {
                if (ch > 0) json_append(buf, bufLen, &pos, ",");
                json_append(buf, bufLen, &pos, "%d", a->values[ch]);
            }
        }
        json_append(buf, bufLen, &pos, "],");
        
        /* Analysis result (includes per-frame dup-timestamp group size) */
        json_append(buf, bufLen, &pos, 
            "\"analysis\":{\"flags\":%u,\"expected\":%u,\"actual\":%u,\"gapSize\":%u,"
            "\"missingFrom\":%u,\"missingTo\":%u,\"dupTsGroupSize\":%u}}",
            sf->analysis.flags,
            sf->analysis.expectedSmpCnt,
            sf->analysis.actualSmpCnt,
            sf->analysis.gapSize,
            sf->analysis.missingFrom,
            sf->analysis.missingTo,
            sf->analysis.dupTsGroupSize);
        
        count++;
        
        if (pos > bufLen - 512) break;
    }
    
    json_append(buf, bufLen, &pos, "],");
    
    /* --- 4. Phasor computation results --- */
    const SvPhasorResult *ph = sv_phasor_get_result();
    json_append(buf, bufLen, &pos,
        "\"phasor\":{\"valid\":%s,\"mode\":%u,"
        "\"windowSize\":%u,\"samplesPerCycle\":%u,"
        "\"computeCount\":%u,\"timestamp\":%llu,"
        "\"channels\":[",
        ph->valid ? "true" : "false",
        ph->mode,
        ph->windowSize,
        ph->samplesPerCycle,
        ph->computeCount,
        (unsigned long long)ph->timestamp_us);
    
    if (ph->valid) {
        for (uint8_t ch = 0; ch < ph->channelCount; ch++) {
            if (ch > 0) json_append(buf, bufLen, &pos, ",");
            json_append(buf, bufLen, &pos, "{\"mag\":%.4f,\"ang\":%.4f}",
                       ph->channels[ch].magnitude,
                       ph->channels[ch].angle_deg);
        }
    }
    json_append(buf, bufLen, &pos, "]}}");
    
    return g_pollBuf;
}

/**
 * @brief Get full detail for a single frame (on-demand, for frame structure viewer)
 *
 * Only called when user clicks a row. Returns ALL fields including Ethernet
 * headers, MAC addresses, VLAN, quality array, etc.
 *
 * @param frameIndex  The frame index to look up
 * @return JSON string with full frame detail, or "{}" if not found
 */
const char* sv_subscriber_get_frame_detail_json(uint32_t frameIndex)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    
    size_t pos = 0;
    char *buf = g_detailBuf;
    size_t bufLen = DETAIL_JSON_BUF_SIZE;
    
    /* Check if frame is still in ring buffer */
    uint32_t oldestIndex = (g_totalReceived > MAX_STORED_FRAMES)
                          ? (g_totalReceived - MAX_STORED_FRAMES) : 0;
    
    if (frameIndex < oldestIndex || frameIndex >= g_totalReceived) {
        snprintf(buf, bufLen, "{}");
        return g_detailBuf;
    }
    
    uint32_t slot = frameIndex % MAX_STORED_FRAMES;
    StoredFrame *sf = &g_frames[slot];
    
    if (!sf->used || sf->frame.frameIndex != frameIndex) {
        snprintf(buf, bufLen, "{}");
        return g_detailBuf;
    }
    
    SvDecodedFrame *f = &sf->frame;
    const SvASDU *a = (f->asduCount > 0) ? &f->asdus[0] : NULL;
    
    uint32_t allErrors = f->errors;
    if (a) allErrors |= a->errors;
    char errStr[256];
    sv_format_errors(allErrors, errStr, sizeof(errStr));
    
    /* Full frame with all Ethernet header fields */
    json_append(buf, bufLen, &pos,
        "{\"index\":%u,\"timestamp\":%llu,\"svID\":\"%s\",\"smpCnt\":%u,"
        "\"confRev\":%u,\"smpSynch\":%u,\"channelCount\":%u,"
        "\"appID\":\"0x%04X\",\"errors\":%u,\"errorStr\":\"%s\",\"noASDU\":%u,\"asduIndex\":%u,"
        "\"dstMAC\":\"%02X:%02X:%02X:%02X:%02X:%02X\","
        "\"srcMAC\":\"%02X:%02X:%02X:%02X:%02X:%02X\","
        "\"vlanID\":%u,\"vlanPriority\":%u,\"hasVLAN\":%u,"
        "\"svLength\":%u,\"reserved1\":%u,\"reserved2\":%u,",
        f->frameIndex,
        (unsigned long long)f->timestamp_us,
        a ? a->svID : "",
        a ? a->smpCnt : 0,
        a ? a->confRev : 0,
        a ? a->smpSynch : 0,
        a ? a->channelCount : 0,
        f->header.appID,
        allErrors,
        errStr,
        f->noASDU,
        a ? a->asduIndex : 0,
        f->header.dstMAC[0], f->header.dstMAC[1], f->header.dstMAC[2],
        f->header.dstMAC[3], f->header.dstMAC[4], f->header.dstMAC[5],
        f->header.srcMAC[0], f->header.srcMAC[1], f->header.srcMAC[2],
        f->header.srcMAC[3], f->header.srcMAC[4], f->header.srcMAC[5],
        f->header.vlanID,
        f->header.vlanPriority,
        f->header.hasVLAN,
        f->header.svLength,
        f->header.reserved1,
        f->header.reserved2);
    
    /* Channel values */
    json_append(buf, bufLen, &pos, "\"channels\":[");
    if (a) {
        for (int ch = 0; ch < a->channelCount; ch++) {
            if (ch > 0) json_append(buf, bufLen, &pos, ",");
            json_append(buf, bufLen, &pos, "%d", a->values[ch]);
        }
    }
    json_append(buf, bufLen, &pos, "],\"quality\":[");
    if (a) {
        for (int ch = 0; ch < a->channelCount; ch++) {
            if (ch > 0) json_append(buf, bufLen, &pos, ",");
            json_append(buf, bufLen, &pos, "%u", a->quality[ch]);
        }
    }
    json_append(buf, bufLen, &pos, "],");
    
    /* Analysis result (includes per-frame dup-timestamp group size) */
    json_append(buf, bufLen, &pos,
        "\"analysis\":{\"flags\":%u,\"expected\":%u,\"actual\":%u,\"gapSize\":%u,"
        "\"missingFrom\":%u,\"missingTo\":%u,\"dupTsGroupSize\":%u}}",
        sf->analysis.flags,
        sf->analysis.expectedSmpCnt,
        sf->analysis.actualSmpCnt,
        sf->analysis.gapSize,
        sf->analysis.missingFrom,
        sf->analysis.missingTo,
        sf->analysis.dupTsGroupSize);
    
    return g_detailBuf;
}

/**
 * @brief Set phasor computation mode (called from frontend via Tauri FFI)
 *
 * @param mode  0 = HALF_CYCLE (Task 1), 1 = FULL_CYCLE (Task 2)
 */
void sv_subscriber_set_phasor_mode(uint8_t mode)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    sv_phasor_set_mode(mode);
}

/**
 * @brief Start CSV phasor logging (called from frontend via Tauri FFI)
 *
 * @param filepath  Absolute path for the CSV file
 * @return 0 on success, -1 on failure
 */
int sv_subscriber_csv_start(const char *filepath)
{
    return sv_phasor_csv_start(filepath);
}

/**
 * @brief Stop CSV phasor logging
 */
void sv_subscriber_csv_stop(void)
{
    sv_phasor_csv_stop();
}

/**
 * @brief Get CSV logger status as JSON (multi-stream aware)
 *
 * Returns aggregate status + per-stream details:
 * {"logging":bool, "rowsWritten":N, "streamCount":N,
 *  "half":{...}, "full":{...}, "slide":{...},
 *  "streams":[{"svID":"MU01","spc":80,"channels":8, ...}, ...]}
 */
const char* sv_subscriber_csv_status_json(void)
{
    static char buf[4096];
    PhasorCsvStatus st;
    sv_phasor_csv_get_status(&st);

    size_t pos = 0;
    size_t bufLen = sizeof(buf);

    /* Aggregate status */
    pos += snprintf(buf + pos, bufLen - pos,
        "{\"logging\":%s,\"rowsWritten\":%llu,\"streamCount\":%d,"
        "\"half\":{\"computeCount\":%u,\"avgTimeUs\":%.3f,"
        "\"minTimeUs\":%.3f,\"maxTimeUs\":%.3f,\"lastTimeUs\":%.3f},"
        "\"full\":{\"computeCount\":%u,\"avgTimeUs\":%.3f,"
        "\"minTimeUs\":%.3f,\"maxTimeUs\":%.3f,\"lastTimeUs\":%.3f},"
        "\"slide\":{\"computeCount\":%u,\"avgTimeUs\":%.3f,"
        "\"minTimeUs\":%.3f,\"maxTimeUs\":%.3f,\"lastTimeUs\":%.3f}",
        st.logging ? "true" : "false",
        (unsigned long long)st.rowsWritten,
        st.streamCount,
        st.half.computeCount, st.half.avgComputeTimeUs,
        st.half.minComputeTimeUs > 1e11 ? 0.0 : st.half.minComputeTimeUs,
        st.half.maxComputeTimeUs,
        st.half.lastComputeTimeUs,
        st.full.computeCount, st.full.avgComputeTimeUs,
        st.full.minComputeTimeUs > 1e11 ? 0.0 : st.full.minComputeTimeUs,
        st.full.maxComputeTimeUs,
        st.full.lastComputeTimeUs,
        st.slide.computeCount, st.slide.avgComputeTimeUs,
        st.slide.minComputeTimeUs > 1e11 ? 0.0 : st.slide.minComputeTimeUs,
        st.slide.maxComputeTimeUs,
        st.slide.lastComputeTimeUs);

    /* Per-stream details */
    int nStreams = sv_phasor_csv_get_stream_count();
    pos += snprintf(buf + pos, bufLen - pos, ",\"streams\":[");
    for (int i = 0; i < nStreams && pos < bufLen - 512; i++) {
        PhasorCsvStreamStatus sst;
        sv_phasor_csv_get_stream_status(i, &sst);
        if (!sst.active) continue;

        if (i > 0) pos += snprintf(buf + pos, bufLen - pos, ",");
        pos += snprintf(buf + pos, bufLen - pos,
            "{\"svID\":\"%s\",\"spc\":%u,\"channels\":%u,"
            "\"half\":{\"count\":%u,\"avg\":%.3f,\"min\":%.3f,\"max\":%.3f},"
            "\"full\":{\"count\":%u,\"avg\":%.3f,\"min\":%.3f,\"max\":%.3f},"
            "\"slide\":{\"count\":%u,\"avg\":%.3f,\"min\":%.3f,\"max\":%.3f}}",
            sst.svID,
            sst.samplesPerCycle,
            sst.channelCount,
            sst.half.computeCount, sst.half.avgComputeTimeUs,
            sst.half.minComputeTimeUs > 1e11 ? 0.0 : sst.half.minComputeTimeUs,
            sst.half.maxComputeTimeUs,
            sst.full.computeCount, sst.full.avgComputeTimeUs,
            sst.full.minComputeTimeUs > 1e11 ? 0.0 : sst.full.minComputeTimeUs,
            sst.full.maxComputeTimeUs,
            sst.slide.computeCount, sst.slide.avgComputeTimeUs,
            sst.slide.minComputeTimeUs > 1e11 ? 0.0 : sst.slide.minComputeTimeUs,
            sst.slide.maxComputeTimeUs);
    }
    pos += snprintf(buf + pos, bufLen - pos, "]}");

    return buf;
}

} /* extern "C" */
