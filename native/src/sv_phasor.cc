/**
 * @file sv_phasor.cc
 * @brief Real-Time Phasor Estimation using Intel MKL FFT
 *
 * Implements Task 1 (half-cycle DFT) and Task 2 (full-cycle DFT) for
 * IEC 61850 Sampled Values phasor extraction.
 *
 * Algorithm:
 *   1. Buffer incoming raw samples per channel
 *   2. When window is full (40 or 80 samples):
 *      a. Copy samples to FFT input buffer (convert int32 → double)
 *      b. Zero-pad to full cycle size (for half-window mode)
 *      c. Run MKL complex FFT (real samples with imaginary = 0)
 *      d. Extract fundamental frequency bin (bin 1)
 *      e. Compute magnitude = 2·|X[1]| / window_size
 *      f. Compute angle = atan2(Im(X[1]), Re(X[1]))
 *   3. Store result and make available via sv_phasor_get_result()
 *
 * MKL FFT details:
 *   - DFTI_DOUBLE precision, DFTI_COMPLEX domain
 *   - Inplace complex-to-complex transform
 *   - Input: real samples stored as complex (imaginary = 0)
 *   - Output: array of N complex numbers [Re(X[0]),Im(X[0]), Re(X[1]),Im(X[1]), ...]
 *   - FFT size = samplesPerCycle (always full cycle for correct bin alignment)
 *   - Fundamental at bin 1: Re = buf[2], Im = buf[3]
 */

#include "sv_phasor.h"
#include <mkl_dfti.h>
#include <cmath>
#include <cstring>
#include <cstdio>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/*============================================================================
 * Module State
 *============================================================================*/

/** Configuration */
static uint16_t g_samples_per_cycle = 80;   /**< Full cycle sample count */
static uint8_t  g_max_channels = 8;         /**< Channels to process */
static uint8_t  g_mode = PHASOR_MODE_FULL_CYCLE;
static uint32_t g_window_size = 80;         /**< Actual samples to collect per computation */

/** Sample buffer: [channel][sample_index] */
static double   g_sample_buf[PHASOR_MAX_CHANNELS][PHASOR_MAX_WINDOW_SIZE];
static uint32_t g_buf_pos = 0;              /**< Current position in sample buffer */
static uint64_t g_last_ts = 0;              /**< Timestamp of most recent sample */

/** MKL FFT */
static DFTI_DESCRIPTOR_HANDLE g_fft_handle = NULL;
static double   g_fft_work[2 * PHASOR_MAX_WINDOW_SIZE]; /**< Complex FFT buffer: [Re0,Im0,Re1,Im1,...] */

/** Result */
static SvPhasorResult g_result;
static uint32_t g_compute_count = 0;
static uint8_t  g_initialized = 0;

/*============================================================================
 * Internal: MKL FFT Setup
 *============================================================================*/

/**
 * @brief Create/recreate the MKL FFT descriptor
 *
 * Uses DFTI_COMPLEX domain to avoid packed-format compatibility issues
 * across MKL versions. Real input is stored with imaginary = 0.
 *
 * FFT size is always samplesPerCycle (full cycle) regardless of window mode.
 * For half-cycle mode, we zero-pad the input to full cycle size.
 * This ensures bin 1 always corresponds to the fundamental frequency.
 */
static int create_fft_descriptor(void)
{
    /* Free existing descriptor */
    if (g_fft_handle) {
        DftiFreeDescriptor(&g_fft_handle);
        g_fft_handle = NULL;
    }

    MKL_LONG N = (MKL_LONG)g_samples_per_cycle;
    MKL_LONG status;

    /* Create complex-to-complex FFT descriptor, double precision.
     * Using DFTI_COMPLEX avoids DFTI_REAL packed-format issues
     * (DFTI_PACK_FORMAT + DFTI_INPLACE = INCONSISTENT_CONFIGURATION in some MKL versions).
     * Real samples are stored as complex with imaginary = 0. */
    status = DftiCreateDescriptor(&g_fft_handle, DFTI_DOUBLE, DFTI_COMPLEX, 1, N);
    if (status != DFTI_NO_ERROR) {
        printf("[phasor] ERROR: MKL DftiCreateDescriptor failed (status=%lld, N=%lld)\n",
               (long long)status, (long long)N);
        return -1;
    }

    /* Commit (finalize) the descriptor — MKL optimizes the FFT plan */
    status = DftiCommitDescriptor(g_fft_handle);
    if (status != DFTI_NO_ERROR) {
        printf("[phasor] ERROR: MKL DftiCommitDescriptor failed: %lld\n", (long long)status);
        DftiFreeDescriptor(&g_fft_handle);
        g_fft_handle = NULL;
        return -1;
    }

    printf("[phasor] MKL FFT descriptor created (COMPLEX, N=%lld)\n", (long long)N);
    return 0;
}

/*============================================================================
 * Internal: Compute Phasor from Buffered Samples
 *============================================================================*/

/**
 * @brief Run FFT on all channels and extract fundamental phasor
 *
 * For each channel:
 *   1. Copy window_size samples as complex input (real part = sample, imag = 0)
 *   2. Zero-pad remaining (if half-window mode)
 *   3. Run MKL complex FFT inplace
 *   4. Extract bin 1 (fundamental): Re = buf[2], Im = buf[3]
 *   5. Compute magnitude and angle
 */
static void compute_phasors(void)
{
    if (!g_fft_handle) return;

    uint32_t N = g_samples_per_cycle;   /* FFT size (always full cycle) */
    uint32_t W = g_window_size;         /* Actual signal samples (40 or 80) */
    uint8_t nch = g_max_channels;

    for (uint8_t ch = 0; ch < nch; ch++) {
        /* 1. Fill FFT input as complex: [Re0,Im0, Re1,Im1, ...]
         *    Real part = sample value, Imaginary = 0 */
        for (uint32_t i = 0; i < W; i++) {
            g_fft_work[2 * i]     = g_sample_buf[ch][i];  /* Real */
            g_fft_work[2 * i + 1] = 0.0;                   /* Imaginary */
        }

        /* 2. Zero-pad remaining (for half-window: samples W..N-1 = 0+0j) */
        for (uint32_t i = W; i < N; i++) {
            g_fft_work[2 * i]     = 0.0;
            g_fft_work[2 * i + 1] = 0.0;
        }

        /* 3. Run MKL complex FFT (inplace — g_fft_work is overwritten with output) */
        MKL_LONG status = DftiComputeForward(g_fft_handle, g_fft_work);
        if (status != DFTI_NO_ERROR) {
            /* FFT failed — zero out this channel's result */
            g_result.channels[ch].magnitude = 0.0;
            g_result.channels[ch].angle_deg = 0.0;
            continue;
        }

        /* 4. Extract fundamental (bin 1) from complex output
         *    Complex output: [Re(X[0]),Im(X[0]), Re(X[1]),Im(X[1]), ...]
         *    Bin 1 (fundamental): Re = output[2], Im = output[3]
         */
        double re = g_fft_work[2];   /* Real part of X[1] */
        double im = g_fft_work[3];   /* Imag part of X[1] */

        /* 5. Compute magnitude and angle
         *    |X[1]| = sqrt(Re² + Im²)
         *    Peak magnitude = 2·|X[1]| / W  (scale by actual sample count, not FFT size)
         *    Angle = atan2(Im, Re) → convert to degrees
         */
        double mag_raw = sqrt(re * re + im * im);
        double magnitude = 2.0 * mag_raw / (double)W;
        double angle_rad = atan2(im, re);
        double angle_deg = angle_rad * (180.0 / M_PI);

        g_result.channels[ch].magnitude = magnitude;
        g_result.channels[ch].angle_deg = angle_deg;
    }

    /* Update result metadata */
    g_result.channelCount = nch;
    g_result.valid = 1;
    g_result.mode = g_mode;
    g_result.windowSize = W;
    g_result.samplesPerCycle = N;
    g_result.timestamp_us = g_last_ts;
    g_compute_count++;
    g_result.computeCount = g_compute_count;
}

/*============================================================================
 * Public API
 *============================================================================*/

int sv_phasor_init(uint16_t samplesPerCycle, uint8_t maxChannels, uint8_t mode)
{
    if (samplesPerCycle == 0 || samplesPerCycle > PHASOR_MAX_WINDOW_SIZE) {
        printf("[phasor] ERROR: invalid samplesPerCycle=%u (must be 1..%d)\n",
               samplesPerCycle, PHASOR_MAX_WINDOW_SIZE);
        return -1;
    }
    if (maxChannels > PHASOR_MAX_CHANNELS) {
        maxChannels = PHASOR_MAX_CHANNELS;
    }

    g_samples_per_cycle = samplesPerCycle;
    g_max_channels = maxChannels;
    g_mode = mode;

    /* Set window size based on mode */
    if (mode == PHASOR_MODE_HALF_CYCLE) {
        g_window_size = samplesPerCycle / 2;
    } else {
        g_window_size = samplesPerCycle; /* FULL_CYCLE */
    }

    /* Reset buffers */
    memset(g_sample_buf, 0, sizeof(g_sample_buf));
    g_buf_pos = 0;
    g_last_ts = 0;
    g_compute_count = 0;
    memset(&g_result, 0, sizeof(g_result));
    g_result.samplesPerCycle = samplesPerCycle;
    g_result.mode = mode;
    g_result.windowSize = g_window_size;
    g_result.channelCount = maxChannels;

    /* Create MKL FFT descriptor */
    if (create_fft_descriptor() != 0) {
        printf("[phasor] ERROR: Failed to create MKL FFT — phasor disabled\n");
        g_initialized = 0;
        return -1;
    }

    g_initialized = 1;
    printf("[phasor] Initialized: samplesPerCycle=%u, channels=%u, mode=%s, windowSize=%u\n",
           samplesPerCycle, maxChannels,
           mode == PHASOR_MODE_HALF_CYCLE ? "HALF_CYCLE" : "FULL_CYCLE",
           g_window_size);
    return 0;
}

int sv_phasor_feed_sample(const int32_t *values, uint8_t channelCount, uint64_t timestamp_us)
{
    if (!g_initialized || !g_fft_handle) return -1;
    if (!values) return -1;

    /* Limit channels to configured max */
    uint8_t nch = (channelCount < g_max_channels) ? channelCount : g_max_channels;

    /* Store this sample into per-channel buffers */
    for (uint8_t ch = 0; ch < nch; ch++) {
        g_sample_buf[ch][g_buf_pos] = (double)values[ch];
    }
    /* Zero out remaining channels if this frame has fewer */
    for (uint8_t ch = nch; ch < g_max_channels; ch++) {
        g_sample_buf[ch][g_buf_pos] = 0.0;
    }

    g_buf_pos++;
    g_last_ts = timestamp_us;

    /* Check if window is full */
    if (g_buf_pos >= g_window_size) {
        /* ── Window complete — compute FFT for all channels ── */
        compute_phasors();

        /* Reset buffer for next window (non-overlapping: jump by window_size) */
        g_buf_pos = 0;

        return 1; /* New result available */
    }

    return 0; /* Still buffering */
}

const SvPhasorResult* sv_phasor_get_result(void)
{
    return &g_result;
}

void sv_phasor_set_mode(uint8_t mode)
{
    if (mode > PHASOR_MODE_FULL_CYCLE) mode = PHASOR_MODE_FULL_CYCLE;

    g_mode = mode;

    if (mode == PHASOR_MODE_HALF_CYCLE) {
        g_window_size = g_samples_per_cycle / 2;
    } else {
        g_window_size = g_samples_per_cycle;
    }

    /* Discard current partial window */
    g_buf_pos = 0;

    /* Update result metadata */
    g_result.mode = mode;
    g_result.windowSize = g_window_size;

    printf("[phasor] Mode changed: %s (windowSize=%u)\n",
           mode == PHASOR_MODE_HALF_CYCLE ? "HALF_CYCLE" : "FULL_CYCLE",
           g_window_size);
}

void sv_phasor_reset(void)
{
    g_buf_pos = 0;
    g_last_ts = 0;
    g_compute_count = 0;
    memset(g_sample_buf, 0, sizeof(g_sample_buf));
    memset(&g_result, 0, sizeof(g_result));
    g_result.samplesPerCycle = g_samples_per_cycle;
    g_result.mode = g_mode;
    g_result.windowSize = g_window_size;

    printf("[phasor] Reset (mode=%s, windowSize=%u)\n",
           g_mode == PHASOR_MODE_HALF_CYCLE ? "HALF_CYCLE" : "FULL_CYCLE",
           g_window_size);
}

void sv_phasor_destroy(void)
{
    if (g_fft_handle) {
        DftiFreeDescriptor(&g_fft_handle);
        g_fft_handle = NULL;
    }
    g_initialized = 0;
    g_buf_pos = 0;
    g_compute_count = 0;
    memset(&g_result, 0, sizeof(g_result));

    printf("[phasor] Destroyed\n");
}
