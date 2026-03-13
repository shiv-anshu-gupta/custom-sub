/**
 * @file sv_phasor_csv.cc
 * @brief Single-File Core Performance CSV Logger
 *
 * All auto-discovered streams write to ONE shared CSV file.
 * CSV captures FFT timing data ONLY (no magnitude/angle).
 * Channel counts and stream counts are fully dynamic from wire data.
 *
 * Three FFT modes per stream:
 *   Mode 0 — Half-cycle:  Window = N/2, non-overlapping
 *   Mode 1 — Full-cycle:  Window = N,   non-overlapping
 *   Mode 2 — Sliding:     Window = N,   1-sample shift, full FFT per sample
 *
 * CSV columns (10 perf columns + dynamic channel mag/angle):
 *   timestamp_us, svID, num_channels, mode, window_size,
 *   samples_per_cycle, compute_count, compute_time_us, cpu_percent, ram_mb,
 *   Ch0_mag, Ch0_ang, Ch1_mag, Ch1_ang, ... (as many as max channels seen)
 *
 * Performance timing uses Windows QueryPerformanceCounter for sub-µs accuracy.
 */

#include "sv_phasor_csv.h"
#include <mkl_dfti.h>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <cstdlib>

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>     /* GetProcessMemoryInfo */
#include <direct.h>   /* _getcwd */
#else
#include <time.h>
#include <unistd.h>
#endif

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/*============================================================================
 * High-Resolution Timer
 *============================================================================*/

static double timer_freq_inv = 0.0; /* 1.0 / QPC frequency (seconds per tick) */

static void timer_init(void)
{
#ifdef _WIN32
    LARGE_INTEGER freq;
    QueryPerformanceFrequency(&freq);
    timer_freq_inv = 1000000.0 / (double)freq.QuadPart; /* µs per tick */
#endif
}

static double timer_now_us(void)
{
#ifdef _WIN32
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return (double)t.QuadPart * timer_freq_inv;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1e6 + (double)ts.tv_nsec / 1000.0;
#endif
}

/*============================================================================
 * Process CPU & Memory Sampling
 *
 * CPU%  — Delta of kernel+user time between samples, divided by wall-clock
 *         delta.  GetProcessTimes has ~15.6ms resolution on Windows, so we
 *         rate-limit CPU sampling to once per 200ms — fast enough to capture
 *         trends but slow enough to get non-zero deltas.  Between samples
 *         we return the last measured value.
 *
 * RAM   — Working set from GetProcessMemoryInfo (physical pages resident
 *         in RAM right now).  Reported in MB.  Sampled every call (cheap).
 *============================================================================*/

#ifdef _WIN32
static ULONGLONG g_prevCpuKernel = 0;
static ULONGLONG g_prevCpuUser   = 0;
static ULONGLONG g_prevCpuWall   = 0;
static double    g_lastCpuPct    = 0.0;
static double    g_lastCpuSampleTime = 0.0; /* timer_now_us() of last sample */

static inline ULONGLONG ft_to_u64(const FILETIME *ft)
{
    return ((ULONGLONG)ft->dwHighDateTime << 32) | ft->dwLowDateTime;
}

/**
 * Get current process CPU usage (%).
 * Rate-limited to one actual measurement per 200ms; returns cached value
 * in between.  First call initialises baseline and returns 0.
 */
static double get_process_cpu_percent(void)
{
    /* Rate-limit: only re-sample every 200ms (200000 µs) */
    double now = timer_now_us();
    if (g_lastCpuSampleTime > 0 && (now - g_lastCpuSampleTime) < 200000.0) {
        return g_lastCpuPct;  /* Return cached value */
    }

    FILETIME createTime, exitTime, kernelTime, userTime;
    if (!GetProcessTimes(GetCurrentProcess(),
                         &createTime, &exitTime, &kernelTime, &userTime)) {
        return g_lastCpuPct;
    }
    FILETIME nowFt;
    GetSystemTimeAsFileTime(&nowFt);

    ULONGLONG k = ft_to_u64(&kernelTime);
    ULONGLONG u = ft_to_u64(&userTime);
    ULONGLONG w = ft_to_u64(&nowFt);

    if (g_prevCpuWall > 0) {
        ULONGLONG dCpu  = (k + u) - (g_prevCpuKernel + g_prevCpuUser);
        ULONGLONG dWall = w - g_prevCpuWall;
        if (dWall > 0) {
            g_lastCpuPct = 100.0 * (double)dCpu / (double)dWall;
        }
    }
    g_prevCpuKernel = k;
    g_prevCpuUser   = u;
    g_prevCpuWall   = w;
    g_lastCpuSampleTime = now;
    return g_lastCpuPct;
}

/**
 * Get current process working-set (physical RAM) in MB.
 */
static double get_process_ram_mb(void)
{
    PROCESS_MEMORY_COUNTERS pmc;
    pmc.cb = sizeof(pmc);
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
        return (double)pmc.WorkingSetSize / (1024.0 * 1024.0);
    }
    return 0.0;
}
#else
static double get_process_cpu_percent(void) { return 0.0; }
static double get_process_ram_mb(void) { return 0.0; }
#endif

/*============================================================================
 * Per-Engine State (3 engines per stream: half, full, slide)
 *============================================================================*/

typedef struct {
    /* Configuration */
    uint8_t     mode;               /* 0 = half, 1 = full, 2 = slide */
    uint16_t    samplesPerCycle;    /* Full cycle size (N) */
    uint32_t    windowSize;         /* Actual window: N/2 or N */
    uint8_t     maxChannels;        /* Array bound (from registration) */
    uint8_t     actualChannels;     /* Real channels from wire (updated each feed) */

    /* MKL FFT */
    DFTI_DESCRIPTOR_HANDLE fftHandle;
    double      fftWork[2 * PCSV_MAX_WINDOW_SIZE]; /* Complex FFT buffer */

    /* Sample buffers: [channel][sample_index] */
    double      sampleBuf[PCSV_MAX_CHANNELS][PCSV_MAX_WINDOW_SIZE];
    uint32_t    bufPos;             /* Current write position */
    uint64_t    lastTimestamp;      /* Timestamp of most recent sample */

    /* Sliding-window state (mode 2 only) */
    uint8_t     windowFull;         /* 1 once first N samples collected */
    uint32_t    ringHead;           /* Circular write pointer (0..N-1) */
    uint32_t    slideStep;          /* Run FFT every N/4 samples, not every sample */
    uint32_t    slideCount;         /* Counter mod slideStep */

    /* Results (latest computation) */
    double      magnitude[PCSV_MAX_CHANNELS];
    double      angleDeg[PCSV_MAX_CHANNELS];
    uint8_t     channelCount;
    uint8_t     valid;

    /* Stats */
    PhasorCsvModeStats stats;
    uint8_t     initialized;
} PhasorEngine;

/*============================================================================
 * Per-Stream State — Each stream has 3 engines (no per-stream file)
 *============================================================================*/

typedef struct {
    PhasorEngine half;              /* Engine 0: half-cycle */
    PhasorEngine full;              /* Engine 1: full-cycle */
    PhasorEngine slide;             /* Engine 2: sliding window */

    char        svID[PCSV_MAX_SVID_LEN + 1];
    uint8_t     channelCount;       /* Actual channels from wire */
    uint8_t     active;             /* 1 = registered and usable */
} StreamCsvSet;

/*============================================================================
 * Module State — Single shared CSV file for all streams
 *============================================================================*/

#define PCSV_INTERNAL_MAX_STREAMS  32  /* Internal array bound (not exposed) */

static StreamCsvSet g_csvStreams[PCSV_INTERNAL_MAX_STREAMS];
static int          g_csvStreamCount = 0;
static uint8_t      g_moduleInit = 0;

/* Shared CSV file (one file for ALL streams) */
static FILE        *g_csvFile = NULL;
static uint8_t      g_csvHeaderWritten = 0;
static uint64_t     g_csvRowsWritten = 0;
static uint8_t      g_csvMaxChannels = 0;  /* Max channels across all streams */

/*============================================================================
 * Internal: Create MKL FFT descriptor for an engine
 *============================================================================*/

static int engine_create_fft(PhasorEngine *eng)
{
    if (eng->fftHandle) {
        DftiFreeDescriptor(&eng->fftHandle);
        eng->fftHandle = NULL;
    }

    MKL_LONG N = (MKL_LONG)eng->samplesPerCycle; /* FFT size = full cycle */
    MKL_LONG status;

    status = DftiCreateDescriptor(&eng->fftHandle, DFTI_DOUBLE, DFTI_COMPLEX, 1, N);
    if (status != DFTI_NO_ERROR) {
        printf("[phasor_csv] ERROR: MKL DftiCreateDescriptor failed (mode=%s, N=%lld, status=%lld)\n",
               eng->mode == 0 ? "half" : "full", (long long)N, (long long)status);
        return -1;
    }

    status = DftiCommitDescriptor(eng->fftHandle);
    if (status != DFTI_NO_ERROR) {
        printf("[phasor_csv] ERROR: MKL DftiCommitDescriptor failed (mode=%s, status=%lld)\n",
               eng->mode == 0 ? "half" : "full", (long long)status);
        DftiFreeDescriptor(&eng->fftHandle);
        eng->fftHandle = NULL;
        return -1;
    }

    return 0;
}

/*============================================================================
 * Internal: Initialize a single engine
 *============================================================================*/

static int engine_init(PhasorEngine *eng, uint8_t mode,
                       uint16_t samplesPerCycle, uint8_t maxChannels)
{
    memset(eng, 0, sizeof(PhasorEngine));

    eng->mode = mode;
    eng->samplesPerCycle = samplesPerCycle;
    eng->maxChannels = (maxChannels > PCSV_MAX_CHANNELS)
                           ? PCSV_MAX_CHANNELS : maxChannels;

    /* Half-cycle uses N/2 samples; full-cycle and slide use N */
    eng->windowSize = (mode == 0)
                          ? (uint32_t)(samplesPerCycle / 2)
                          : (uint32_t)samplesPerCycle;

    /* Sliding-window extra state */
    eng->windowFull = 0;
    eng->ringHead   = 0;
    /* Step = N/4 → ~200 FFTs/sec instead of 4000 FFTs/sec (~20× reduction) */
    eng->slideStep  = (eng->windowSize / 4 > 0) ? eng->windowSize / 4 : 1;
    eng->slideCount = 0;

    /* Initialize stats with sentinel values */
    eng->stats.minComputeTimeUs = 1e12;
    eng->stats.maxComputeTimeUs = 0.0;

    if (engine_create_fft(eng) != 0) {
        return -1;
    }

    eng->initialized = 1;
    return 0;
}

/*============================================================================
 * Internal: Compute phasors for one engine (all channels)
 *============================================================================*/

static void engine_compute(PhasorEngine *eng)
{
    if (!eng->fftHandle) return;

    uint32_t N = eng->samplesPerCycle;  /* FFT size (always full cycle) */
    uint32_t W = eng->windowSize;       /* Actual signal samples */
    uint8_t  nch = eng->actualChannels ? eng->actualChannels : eng->maxChannels;

    for (uint8_t ch = 0; ch < nch; ch++) {
        /* Fill FFT input as complex: [Re0,Im0, Re1,Im1, ...] */
        for (uint32_t i = 0; i < W; i++) {
            eng->fftWork[2 * i]     = eng->sampleBuf[ch][i];
            eng->fftWork[2 * i + 1] = 0.0;
        }
        /* Zero-pad (for half-cycle: samples W..N-1 = 0+0j) */
        for (uint32_t i = W; i < N; i++) {
            eng->fftWork[2 * i]     = 0.0;
            eng->fftWork[2 * i + 1] = 0.0;
        }

        /* MKL complex FFT inplace */
        MKL_LONG status = DftiComputeForward(eng->fftHandle, eng->fftWork);
        if (status != DFTI_NO_ERROR) {
            eng->magnitude[ch] = 0.0;
            eng->angleDeg[ch]  = 0.0;
            continue;
        }

        /* Extract fundamental (bin 1): X[1] = fftWork[2] + j*fftWork[3] */
        double re = eng->fftWork[2];
        double im = eng->fftWork[3];

        double magRaw = sqrt(re * re + im * im);
        eng->magnitude[ch] = 2.0 * magRaw / (double)W;
        eng->angleDeg[ch]  = atan2(im, re) * (180.0 / M_PI);
    }

    eng->channelCount = nch;
    eng->valid = 1;
}

/*============================================================================
 * Internal: CSV output — single shared file, perf + channel phasors
 *============================================================================*/

static void write_csv_header(void)
{
    if (!g_csvFile || g_csvHeaderWritten) return;

    fprintf(g_csvFile, "timestamp_us,svID,num_channels,mode,window_size,"
                       "samples_per_cycle,compute_count,compute_time_us,"
                       "cpu_percent,ram_mb");

    /* Dynamic channel columns based on max channels across all streams */
    for (uint8_t i = 0; i < g_csvMaxChannels; i++) {
        fprintf(g_csvFile, ",Ch%u_mag,Ch%u_ang", i, i);
    }
    fprintf(g_csvFile, "\n");
    fflush(g_csvFile);
    g_csvHeaderWritten = 1;
    printf("[phasor_csv] CSV header written (10 perf + %u channels x2 = %u total columns)\n",
           g_csvMaxChannels, 10 + g_csvMaxChannels * 2);
}

static void write_csv_row(const char *svID, uint8_t numChannels,
                           const PhasorEngine *eng, double computeTimeUs)
{
    if (!g_csvFile) return;
    if (!g_csvHeaderWritten) write_csv_header();

    const char *modeStr = (eng->mode == 0) ? "half"
                       : (eng->mode == 1) ? "full"
                       :                    "slide";

    double cpuPct = get_process_cpu_percent();
    double ramMb  = get_process_ram_mb();

    fprintf(g_csvFile, "%llu,%s,%u,%s,%u,%u,%u,%.3f,%.2f,%.2f",
            (unsigned long long)eng->lastTimestamp,
            svID, numChannels, modeStr,
            eng->windowSize, eng->samplesPerCycle,
            eng->stats.computeCount, computeTimeUs,
            cpuPct, ramMb);

    /* Write channel mag/angle — actual channels get real data, rest padded 0 */
    for (uint8_t ch = 0; ch < g_csvMaxChannels; ch++) {
        if (ch < eng->channelCount && eng->valid) {
            fprintf(g_csvFile, ",%.6f,%.4f",
                    eng->magnitude[ch], eng->angleDeg[ch]);
        } else {
            fprintf(g_csvFile, ",0.000000,0.0000");
        }
    }

    fprintf(g_csvFile, "\n");
    g_csvRowsWritten++;
    if (g_csvRowsWritten % 100 == 0) fflush(g_csvFile);
}

/*============================================================================
 * Internal: Feed one sample to a single engine (half/full), with stream ctx
 *============================================================================*/

static void engine_feed_with_stream(const char *svID, PhasorEngine *eng,
                                     const int32_t *values, uint8_t channelCount,
                                     uint64_t timestamp_us)
{
    if (!eng->initialized || !eng->fftHandle) return;

    uint8_t nch = (channelCount < eng->maxChannels)
                      ? channelCount : eng->maxChannels;

    eng->actualChannels = nch;

    /* Store sample into per-channel buffers */
    for (uint8_t ch = 0; ch < nch; ch++) {
        eng->sampleBuf[ch][eng->bufPos] = (double)values[ch];
    }
    for (uint8_t ch = nch; ch < eng->maxChannels; ch++) {
        eng->sampleBuf[ch][eng->bufPos] = 0.0;
    }

    eng->bufPos++;
    eng->lastTimestamp = timestamp_us;

    /* Window complete? → Run FFT with timing */
    if (eng->bufPos >= eng->windowSize) {
        double t0 = timer_now_us();

        engine_compute(eng);

        double t1 = timer_now_us();
        double elapsed = t1 - t0;

        /* Update stats */
        eng->stats.computeCount++;
        eng->stats.lastComputeTimeUs = elapsed;
        eng->stats.totalComputeTimeUs += elapsed;
        eng->stats.avgComputeTimeUs =
            eng->stats.totalComputeTimeUs / (double)eng->stats.computeCount;
        if (elapsed < eng->stats.minComputeTimeUs)
            eng->stats.minComputeTimeUs = elapsed;
        if (elapsed > eng->stats.maxComputeTimeUs)
            eng->stats.maxComputeTimeUs = elapsed;

        /* Write perf row to shared CSV */
        write_csv_row(svID, nch, eng, elapsed);

        /* Reset buffer for next window (non-overlapping) */
        eng->bufPos = 0;
    }
}

/*============================================================================
 * Internal: Feed one sample to the SLIDING engine (mode 2), with stream ctx
 *
 * Phase 1 (bootstrap): Collect N samples like normal → first FFT.
 * Phase 2 (sliding):   Every new sample overwrites the oldest in a circular
 *                      buffer, then runs a FULL N-point FFT immediately.
 *============================================================================*/

static void engine_feed_slide_with_stream(const char *svID, PhasorEngine *eng,
                                           const int32_t *values,
                                           uint8_t channelCount,
                                           uint64_t timestamp_us)
{
    if (!eng->initialized || !eng->fftHandle) return;

    uint8_t nch = (channelCount < eng->maxChannels)
                      ? channelCount : eng->maxChannels;
    uint32_t W = eng->windowSize;

    eng->actualChannels = nch;

    if (!eng->windowFull) {
        /* ---- Phase 1: bootstrap — fill the first window ---- */
        for (uint8_t ch = 0; ch < nch; ch++) {
            eng->sampleBuf[ch][eng->bufPos] = (double)values[ch];
        }
        for (uint8_t ch = nch; ch < eng->maxChannels; ch++) {
            eng->sampleBuf[ch][eng->bufPos] = 0.0;
        }
        eng->bufPos++;
        eng->lastTimestamp = timestamp_us;

        if (eng->bufPos >= W) {
            double t0 = timer_now_us();
            engine_compute(eng);
            double t1 = timer_now_us();
            double elapsed = t1 - t0;

            eng->stats.computeCount++;
            eng->stats.lastComputeTimeUs = elapsed;
            eng->stats.totalComputeTimeUs += elapsed;
            eng->stats.avgComputeTimeUs =
                eng->stats.totalComputeTimeUs / (double)eng->stats.computeCount;
            eng->stats.minComputeTimeUs = elapsed;
            eng->stats.maxComputeTimeUs = elapsed;

            write_csv_row(svID, nch, eng, elapsed);

            eng->windowFull = 1;
            eng->ringHead = 0;
        }
        return;
    }

    /* ---- Phase 2: sliding — overwrite oldest, then FFT ---- */
    for (uint8_t ch = 0; ch < nch; ch++) {
        eng->sampleBuf[ch][eng->ringHead] = (double)values[ch];
    }
    for (uint8_t ch = nch; ch < eng->maxChannels; ch++) {
        eng->sampleBuf[ch][eng->ringHead] = 0.0;
    }
    eng->ringHead = (eng->ringHead + 1) % W;
    eng->lastTimestamp = timestamp_us;

    /* Skip FFT until slideStep boundary — reduces FFT rate from 4000/s to ~200/s */
    eng->slideCount++;
    if (eng->slideCount < eng->slideStep) return;
    eng->slideCount = 0;

    /* Linearize the circular buffer for engine_compute() */
    double tmpBuf[PCSV_MAX_WINDOW_SIZE];
    if (eng->ringHead != 0) {
        for (uint8_t ch = 0; ch < nch; ch++) {
            uint32_t h = eng->ringHead;
            memcpy(tmpBuf,         &eng->sampleBuf[ch][h], (W - h) * sizeof(double));
            memcpy(tmpBuf + (W-h), &eng->sampleBuf[ch][0], h * sizeof(double));
            memcpy(eng->sampleBuf[ch], tmpBuf, W * sizeof(double));
        }
        eng->ringHead = 0;
    }

    double t0 = timer_now_us();
    engine_compute(eng);
    double t1 = timer_now_us();
    double elapsed = t1 - t0;

    eng->stats.computeCount++;
    eng->stats.lastComputeTimeUs = elapsed;
    eng->stats.totalComputeTimeUs += elapsed;
    eng->stats.avgComputeTimeUs =
        eng->stats.totalComputeTimeUs / (double)eng->stats.computeCount;
    if (elapsed < eng->stats.minComputeTimeUs)
        eng->stats.minComputeTimeUs = elapsed;
    if (elapsed > eng->stats.maxComputeTimeUs)
        eng->stats.maxComputeTimeUs = elapsed;

    write_csv_row(svID, nch, eng, elapsed);
}

/*============================================================================
 * Internal: Initialize all 3 engines in a StreamCsvSet
 *============================================================================*/

static int stream_init_engines(StreamCsvSet *set, uint16_t samplesPerCycle,
                                uint8_t maxChannels)
{
    if (engine_init(&set->half,  0, samplesPerCycle, maxChannels) != 0) return -1;
    if (engine_init(&set->full,  1, samplesPerCycle, maxChannels) != 0) return -1;
    if (engine_init(&set->slide, 2, samplesPerCycle, maxChannels) != 0) return -1;
    return 0;
}

static void stream_destroy_engines(StreamCsvSet *set)
{
    if (set->half.fftHandle)  { DftiFreeDescriptor(&set->half.fftHandle);  set->half.fftHandle  = NULL; }
    if (set->full.fftHandle)  { DftiFreeDescriptor(&set->full.fftHandle);  set->full.fftHandle  = NULL; }
    if (set->slide.fftHandle) { DftiFreeDescriptor(&set->slide.fftHandle); set->slide.fftHandle = NULL; }
    set->half.initialized = 0;
    set->full.initialized = 0;
    set->slide.initialized = 0;
}

static void stream_reset_engine(PhasorEngine *eng)
{
    eng->bufPos = 0;
    eng->lastTimestamp = 0;
    eng->valid = 0;
    eng->windowFull = 0;
    eng->ringHead = 0;
    memset(eng->sampleBuf, 0, sizeof(eng->sampleBuf));
    eng->stats.computeCount = 0;
    eng->stats.totalComputeTimeUs = 0;
    eng->stats.avgComputeTimeUs = 0;
    eng->stats.minComputeTimeUs = 1e12;
    eng->stats.maxComputeTimeUs = 0;
}

/*============================================================================
 * Internal: Generate timestamp string for filenames
 *============================================================================*/

static void get_timestamp_str(char *buf, size_t len)
{
#ifdef _WIN32
    SYSTEMTIME st;
    GetLocalTime(&st);
    snprintf(buf, len, "%04d%02d%02d_%02d%02d%02d",
             st.wYear, st.wMonth, st.wDay,
             st.wHour, st.wMinute, st.wSecond);
#else
    time_t now = time(NULL);
    struct tm *tm_val = localtime(&now);
    strftime(buf, len, "%Y%m%d_%H%M%S", tm_val);
#endif
}

/*============================================================================
 * Public API — Multi-Stream
 *============================================================================*/

extern "C" {

int sv_phasor_csv_init_module(void)
{
    timer_init();
    memset(g_csvStreams, 0, sizeof(g_csvStreams));
    g_csvStreamCount = 0;
    g_csvFile = NULL;
    g_csvHeaderWritten = 0;
    g_csvRowsWritten = 0;
    g_csvMaxChannels = 0;
    g_moduleInit = 1;
    printf("[phasor_csv] Module initialized (dynamic streams, single CSV)\n");
    return 0;
}

int sv_phasor_csv_register_stream(const char *svID, uint16_t samplesPerCycle,
                                   uint8_t channelCount)
{
    if (!g_moduleInit) {
        sv_phasor_csv_init_module();
    }

    if (!svID || svID[0] == '\0') {
        printf("[phasor_csv] ERROR: empty svID\n");
        return -1;
    }
    if (samplesPerCycle == 0 || samplesPerCycle > PCSV_MAX_WINDOW_SIZE) {
        printf("[phasor_csv] ERROR: invalid samplesPerCycle=%u\n", samplesPerCycle);
        return -1;
    }

    /* Check if already registered */
    for (int i = 0; i < g_csvStreamCount; i++) {
        if (g_csvStreams[i].active && strcmp(g_csvStreams[i].svID, svID) == 0) {
            printf("[phasor_csv] Stream '%s' already registered at index %d\n", svID, i);
            return i;
        }
    }

    if (g_csvStreamCount >= PCSV_INTERNAL_MAX_STREAMS) {
        printf("[phasor_csv] ERROR: max streams (%d) reached\n", PCSV_INTERNAL_MAX_STREAMS);
        return -1;
    }

    int idx = g_csvStreamCount;
    StreamCsvSet *set = &g_csvStreams[idx];
    memset(set, 0, sizeof(StreamCsvSet));
    strncpy(set->svID, svID, PCSV_MAX_SVID_LEN);
    set->svID[PCSV_MAX_SVID_LEN] = '\0';
    set->channelCount = channelCount;

    /* Track maximum channel count for CSV header columns */
    if (channelCount > g_csvMaxChannels) {
        g_csvMaxChannels = channelCount;
    }

    if (stream_init_engines(set, samplesPerCycle, channelCount) != 0) {
        printf("[phasor_csv] ERROR: engine init failed for '%s'\n", svID);
        return -1;
    }

    set->active = 1;
    g_csvStreamCount++;

    printf("[phasor_csv] Registered stream '%s' at index %d (spc=%u, ch=%u, "
           "half=%u, full=%u, slide=%u)\n",
           svID, idx, samplesPerCycle, channelCount,
           set->half.windowSize, set->full.windowSize, set->slide.windowSize);
    return idx;
}

int sv_phasor_csv_reinit_stream(int streamIdx, uint16_t samplesPerCycle,
                                 uint8_t channelCount)
{
    if (streamIdx < 0 || streamIdx >= g_csvStreamCount) return -1;
    StreamCsvSet *set = &g_csvStreams[streamIdx];
    if (!set->active) return -1;

    stream_destroy_engines(set);
    set->channelCount = channelCount;

    if (stream_init_engines(set, samplesPerCycle, channelCount) != 0) {
        printf("[phasor_csv] ERROR: reinit failed for '%s'\n", set->svID);
        set->active = 0;
        return -1;
    }

    printf("[phasor_csv] Reinit stream '%s' (spc=%u, ch=%u)\n",
           set->svID, samplesPerCycle, channelCount);
    return 0;
}

void sv_phasor_csv_feed_stream(int streamIdx, const int32_t *values,
                                uint8_t channelCount, uint64_t timestamp_us)
{
    /* No CSV file open → nothing to compute or write.  This guard eliminates
     * all three FFT engines (~32 000 calls/sec) during normal live viewing. */
    if (!g_csvFile) return;

    if (streamIdx < 0 || streamIdx >= g_csvStreamCount) return;
    StreamCsvSet *set = &g_csvStreams[streamIdx];
    if (!set->active || !values) return;

    /* Feed all three engines for this stream */
    engine_feed_with_stream(set->svID, &set->half,  values, channelCount, timestamp_us);
    engine_feed_with_stream(set->svID, &set->full,  values, channelCount, timestamp_us);
    engine_feed_slide_with_stream(set->svID, &set->slide, values, channelCount, timestamp_us);
}

int sv_phasor_csv_start(const char *filepath)
{
    /* Close existing file if open */
    if (g_csvFile) sv_phasor_csv_stop();

    if (!filepath || filepath[0] == '\0') {
        printf("[phasor_csv] ERROR: empty filepath\n");
        return -1;
    }

    g_csvFile = fopen(filepath, "w");
    if (!g_csvFile) {
        printf("[phasor_csv] ERROR: cannot open '%s'\n", filepath);
        return -1;
    }

    g_csvHeaderWritten = 0;
    g_csvRowsWritten = 0;
    printf("[phasor_csv] CSV started: %s\n", filepath);
    return 0;
}

int sv_phasor_csv_auto_start(const char *dir)
{
    /* If file already open, do nothing (idempotent) */
    if (g_csvFile) return 0;

    char timestamp[64];
    get_timestamp_str(timestamp, sizeof(timestamp));

    char filepath[512];
    char cwd[256] = ".";
    if (!dir || dir[0] == '\0') {
#ifdef _WIN32
        _getcwd(cwd, sizeof(cwd));
#else
        getcwd(cwd, sizeof(cwd));
#endif
        dir = cwd;
    }
    snprintf(filepath, sizeof(filepath), "%s/sv_perf_%s.csv", dir, timestamp);

    return sv_phasor_csv_start(filepath);
}

void sv_phasor_csv_stop(void)
{
    if (g_csvFile) {
        fflush(g_csvFile);
        fclose(g_csvFile);
        printf("[phasor_csv] CSV closed (%llu rows)\n",
               (unsigned long long)g_csvRowsWritten);
        g_csvFile = NULL;
        g_csvHeaderWritten = 0;
    }
}

void sv_phasor_csv_reset(void)
{
    for (int i = 0; i < g_csvStreamCount; i++) {
        StreamCsvSet *set = &g_csvStreams[i];
        if (!set->active) continue;
        stream_reset_engine(&set->half);
        stream_reset_engine(&set->full);
        stream_reset_engine(&set->slide);
    }
    printf("[phasor_csv] All engines reset\n");
}

void sv_phasor_csv_destroy(void)
{
    sv_phasor_csv_stop();
    for (int i = 0; i < g_csvStreamCount; i++) {
        StreamCsvSet *set = &g_csvStreams[i];
        stream_destroy_engines(set);
        set->active = 0;
    }
    g_csvStreamCount = 0;
    g_moduleInit = 0;
    printf("[phasor_csv] All streams destroyed\n");
}

int sv_phasor_csv_get_stream_count(void)
{
    return g_csvStreamCount;
}

void sv_phasor_csv_get_stream_status(int streamIdx,
                                      PhasorCsvStreamStatus *status)
{
    if (!status) return;
    memset(status, 0, sizeof(PhasorCsvStreamStatus));

    if (streamIdx < 0 || streamIdx >= g_csvStreamCount) return;
    StreamCsvSet *set = &g_csvStreams[streamIdx];
    if (!set->active) return;

    strncpy(status->svID, set->svID, PCSV_MAX_SVID_LEN);
    status->svID[PCSV_MAX_SVID_LEN] = '\0';
    status->active          = set->active;
    status->channelCount    = set->channelCount;
    status->samplesPerCycle = set->half.samplesPerCycle;
    status->half            = set->half.stats;
    status->full            = set->full.stats;
    status->slide           = set->slide.stats;
}

/*============================================================================
 * Legacy API — backward-compatible wrappers (operate on stream 0 / shared file)
 *============================================================================*/

int sv_phasor_csv_init(uint16_t samplesPerCycle, uint8_t maxChannels)
{
    if (!g_moduleInit) sv_phasor_csv_init_module();
    int idx = sv_phasor_csv_register_stream("default", samplesPerCycle, maxChannels);
    return (idx >= 0) ? 0 : -1;
}

void sv_phasor_csv_feed(const int32_t *values, uint8_t channelCount,
                        uint64_t timestamp_us)
{
    if (g_csvStreamCount > 0 && g_csvStreams[0].active) {
        sv_phasor_csv_feed_stream(0, values, channelCount, timestamp_us);
    }
}

void sv_phasor_csv_get_status(PhasorCsvStatus *status)
{
    if (!status) return;
    memset(status, 0, sizeof(PhasorCsvStatus));

    status->logging     = (g_csvFile != NULL) ? 1 : 0;
    status->rowsWritten = g_csvRowsWritten;
    status->streamCount = g_csvStreamCount;

    /* Return first stream's per-mode stats for legacy compat */
    if (g_csvStreamCount > 0 && g_csvStreams[0].active) {
        status->half  = g_csvStreams[0].half.stats;
        status->full  = g_csvStreams[0].full.stats;
        status->slide = g_csvStreams[0].slide.stats;
    }
}

int sv_phasor_csv_reinit(uint16_t samplesPerCycle, uint8_t maxChannels)
{
    for (int i = 0; i < g_csvStreamCount; i++) {
        if (g_csvStreams[i].active) {
            sv_phasor_csv_reinit_stream(i, samplesPerCycle, maxChannels);
        }
    }
    return 0;
}

} /* extern "C" */
