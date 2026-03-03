/**
 * @file sv_phasor.h
 * @brief Real-Time Phasor Estimation using Intel MKL FFT
 *
 * Implements two DFT-based phasor computation modes:
 *   Task 1: Half-cycle window (N/2 samples), jump half-cycle
 *   Task 2: Full-cycle window (N samples), jump full-cycle
 *
 * Uses Intel MKL DFTI for hardware-accelerated FFT.
 *
 * Phasor = Magnitude (peak) + Angle (degrees)
 *   For a signal x[n] = A·cos(ωn + φ):
 *     Magnitude = A (peak value, same unit as raw samples)
 *     Angle     = φ (degrees, -180° to +180°)
 *
 * Data flow:
 *   Raw samples (int32_t[]) → sv_phasor_feed_sample()
 *     → buffer fills up to window_size
 *     → MKL FFT → extract fundamental bin
 *     → PhasorResult (mag + angle per channel)
 */

#ifndef SV_PHASOR_H
#define SV_PHASOR_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*============================================================================
 * Constants
 *============================================================================*/

#define PHASOR_MAX_CHANNELS     20      /**< Max channels to process */
#define PHASOR_MAX_WINDOW_SIZE  256     /**< Max samples per cycle (256 spc systems) */

/** Phasor computation modes */
#define PHASOR_MODE_HALF_CYCLE  0       /**< Task 1: ½ cycle window, jump ½ cycle */
#define PHASOR_MODE_FULL_CYCLE  1       /**< Task 2: 1 cycle window, jump 1 cycle */

/*============================================================================
 * Data Structures
 *============================================================================*/

/**
 * @brief Single-channel phasor value
 */
typedef struct {
    double magnitude;       /**< Peak magnitude (same unit as raw input) */
    double angle_deg;       /**< Phase angle in degrees (-180 to +180) */
} SvPhasorValue;

/**
 * @brief Complete phasor computation result (all channels)
 */
typedef struct {
    SvPhasorValue channels[PHASOR_MAX_CHANNELS];
    uint8_t     channelCount;       /**< Number of channels computed */
    uint8_t     valid;              /**< 1 = result available, 0 = still buffering */
    uint8_t     mode;               /**< Current mode: PHASOR_MODE_* */
    uint32_t    windowSize;         /**< Samples used for this computation */
    uint32_t    samplesPerCycle;    /**< Full cycle sample count (e.g., 80) */
    uint32_t    computeCount;       /**< Total FFTs computed since init */
    uint64_t    timestamp_us;       /**< Timestamp of last sample in window */
} SvPhasorResult;

/*============================================================================
 * API
 *============================================================================*/

/**
 * @brief Initialize the phasor computation engine
 *
 * Creates MKL FFT descriptor and pre-allocates buffers.
 * Must be called before feeding samples.
 *
 * @param samplesPerCycle  Samples per full power cycle (e.g., 80 for 4800Hz@60Hz)
 * @param maxChannels      Number of channels to process (typically 8)
 * @param mode             PHASOR_MODE_HALF_CYCLE or PHASOR_MODE_FULL_CYCLE
 * @return 0 on success, -1 on failure (MKL init error)
 */
int sv_phasor_init(uint16_t samplesPerCycle, uint8_t maxChannels, uint8_t mode);

/**
 * @brief Feed one sample (all channels) to the phasor engine
 *
 * Buffers samples until window is full, then automatically computes FFT.
 *
 * @param values        Channel values array (int32_t, raw from SV packet)
 * @param channelCount  Number of valid channels in values[]
 * @param timestamp_us  Sample timestamp (microseconds)
 * @return 1 if a new phasor result was computed, 0 if still buffering, -1 on error
 */
int sv_phasor_feed_sample(const int32_t *values, uint8_t channelCount, uint64_t timestamp_us);

/**
 * @brief Get the latest phasor computation result
 *
 * Returns pointer to internal result struct. Valid until next computation.
 *
 * @return Pointer to latest result (always valid, check .valid field)
 */
const SvPhasorResult* sv_phasor_get_result(void);

/**
 * @brief Change the computation mode
 *
 * Switches between half-cycle and full-cycle DFT.
 * Resets the sample buffer (current partial window is discarded).
 *
 * @param mode  PHASOR_MODE_HALF_CYCLE or PHASOR_MODE_FULL_CYCLE
 */
void sv_phasor_set_mode(uint8_t mode);

/**
 * @brief Reset the phasor engine (clear buffers, keep configuration)
 */
void sv_phasor_reset(void);

/**
 * @brief Destroy the phasor engine (free MKL resources)
 */
void sv_phasor_destroy(void);

#ifdef __cplusplus
}
#endif

#endif /* SV_PHASOR_H */
