/**
 * @file sv_phasor_csv.h
 * @brief Single-File Core Performance CSV Logger — Multi-Stream FFT Benchmarking
 *
 * Runs three MKL FFT computation modes per auto-discovered stream and logs
 * performance + phasor data to a SINGLE shared CSV file.
 *
 * Three modes (Tasks 1-3):
 *   Mode 0 — Half-cycle:  Window = N/2, jump N/2 (non-overlapping)
 *   Mode 1 — Full-cycle:  Window = N,   jump N   (non-overlapping)
 *   Mode 2 — Sliding:     Window = N,   shift 1 sample, full FFT every sample
 *
 * CSV columns (performance + dynamic channel phasors):
 *   timestamp_us, svID, num_channels, mode, window_size, samples_per_cycle,
 *   compute_count, compute_time_us, cpu_percent, ram_mb,
 *   Ch0_mag, Ch0_ang, Ch1_mag, Ch1_ang, ... (dynamic per max channels)
 *
 * Architecture:
 *   - Streams  — auto-discovered from wire (fully dynamic, no predefined count)
 *   - Channels — auto-detected per stream from wire data (fully dynamic)
 *   - Engines  — 3 per stream (half/full/slide), each with own MKL descriptor
 *   - CSV file — ONE shared file for ALL streams
 *   - FFT processes ONLY actual channels from wire (not padded to array bounds)
 *
 * Data flow:
 *   Network → Npcap → SPSC ring → drain thread
 *     → sv_subscriber_feed_decoded() → per-stream auto-discovery
 *       → sv_phasor_csv_feed_stream(idx, values, channelCount, timestamp)
 *         → half engine   → FFT every N/2 samples → perf CSV row
 *         → full engine   → FFT every N   samples → perf CSV row
 *         → slide engine  → FFT every 1   sample  → perf CSV row
 */

#ifndef SV_PHASOR_CSV_H
#define SV_PHASOR_CSV_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*============================================================================
 * Array Bounds
 *
 * These are compile-time memory allocation limits for C arrays.
 * Actual channel counts and stream counts are auto-detected from wire data
 * at runtime — nothing is predefined or assumed about the publisher.
 *============================================================================*/

#define PCSV_MAX_CHANNELS       64   /**< Array bound for channels per stream */
#define PCSV_MAX_WINDOW_SIZE    512  /**< Array bound for FFT window size */
#define PCSV_MAX_SVID_LEN       65   /**< Max svID string length (incl null) */

/*============================================================================
 * Data Structures
 *============================================================================*/

/** Per-mode compute statistics */
typedef struct {
    uint32_t    computeCount;       /**< Total FFT computations */
    double      lastComputeTimeUs;  /**< Most recent FFT time (µs) */
    double      avgComputeTimeUs;   /**< Running average FFT time (µs) */
    double      minComputeTimeUs;   /**< Minimum FFT time seen (µs) */
    double      maxComputeTimeUs;   /**< Maximum FFT time seen (µs) */
    double      totalComputeTimeUs; /**< Cumulative FFT time (for avg) */
} PhasorCsvModeStats;

/** Per-stream status (for JSON/frontend) */
typedef struct {
    char        svID[PCSV_MAX_SVID_LEN + 1];
    uint8_t     active;             /**< 1 = stream registered */
    uint8_t     channelCount;       /**< Actual channels from wire */
    uint16_t    samplesPerCycle;    /**< Full cycle size (from auto-detect) */
    PhasorCsvModeStats half;
    PhasorCsvModeStats full;
    PhasorCsvModeStats slide;
} PhasorCsvStreamStatus;

/** Module-level status */
typedef struct {
    uint8_t     logging;            /**< 1 = CSV file is open */
    uint64_t    rowsWritten;        /**< Total CSV rows written */
    int         streamCount;        /**< Auto-discovered stream count */
    PhasorCsvModeStats half;        /**< First stream's stats (legacy compat) */
    PhasorCsvModeStats full;
    PhasorCsvModeStats slide;
} PhasorCsvStatus;

/*============================================================================
 * API — Module Lifecycle
 *============================================================================*/

/** Initialize module (call once at startup, before any streams) */
int  sv_phasor_csv_init_module(void);

/** Destroy all streams and free MKL resources */
void sv_phasor_csv_destroy(void);

/*============================================================================
 * API — Stream Management (called by subscriber on auto-discovery)
 *============================================================================*/

/** Register a new stream. Returns stream index or -1 on failure. */
int  sv_phasor_csv_register_stream(const char *svID, uint16_t samplesPerCycle,
                                    uint8_t channelCount);

/** Re-initialize a stream's engines (e.g., when sample rate changes) */
int  sv_phasor_csv_reinit_stream(int streamIdx, uint16_t samplesPerCycle,
                                  uint8_t channelCount);

/** Feed one sample to a stream's 3 engines */
void sv_phasor_csv_feed_stream(int streamIdx, const int32_t *values,
                                uint8_t channelCount, uint64_t timestamp_us);

/*============================================================================
 * API — CSV File (SINGLE shared file for all streams)
 *============================================================================*/

/** Open CSV at explicit filepath */
int  sv_phasor_csv_start(const char *filepath);

/** Auto-generate filename: {dir}/sv_perf_{YYYYMMDD_HHMMSS}.csv */
int  sv_phasor_csv_auto_start(const char *dir);

/** Close CSV file */
void sv_phasor_csv_stop(void);

/*============================================================================
 * API — Status & Reset
 *============================================================================*/

void sv_phasor_csv_reset(void);
void sv_phasor_csv_get_status(PhasorCsvStatus *status);
int  sv_phasor_csv_get_stream_count(void);
void sv_phasor_csv_get_stream_status(int streamIdx,
                                      PhasorCsvStreamStatus *status);

/*============================================================================
 * Legacy Wrappers (backward compat — operate on stream 0 / shared file)
 *============================================================================*/

int  sv_phasor_csv_init(uint16_t samplesPerCycle, uint8_t maxChannels);
void sv_phasor_csv_feed(const int32_t *values, uint8_t channelCount,
                        uint64_t timestamp_us);
int  sv_phasor_csv_reinit(uint16_t samplesPerCycle, uint8_t maxChannels);

#ifdef __cplusplus
}
#endif

#endif /* SV_PHASOR_CSV_H */
