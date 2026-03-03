/**
 * @file sv_native.h
 * @brief Header for Tauri FFI - C interface for Rust
 */

#ifndef SV_NATIVE_H
#define SV_NATIVE_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================================
// STRUCTURES
// ============================================================================

/**
 * Network interface information
 */
typedef struct NpcapInterface {
    char name[256];
    char description[256];
    uint8_t mac[6];
    int has_mac;
} NpcapInterface;

/**
 * Transmission statistics
 */
typedef struct TransmitStats {
    uint64_t packets_sent;
    uint64_t packets_failed;
    uint64_t packets_queued;
    uint64_t bytes_sent;
    uint64_t bytes_queued;
    uint64_t rate_bytes_sent;
    uint64_t rate_packets_sent;
    uint64_t rate_window_start_ms;
    double current_bps;
    double current_pps;
    double peak_bps;
    double peak_pps;
    uint64_t session_start_ms;
    uint64_t session_end_ms;       // Track when session ended
    uint64_t last_packet_ms;
    double avg_packet_size;
    double avg_interval_us;
    uint64_t last_interval_us;
    int session_active;
} TransmitStats;

// ============================================================================
// ERROR HANDLING
// ============================================================================

const char* sv_get_last_error(void);

// ============================================================================
// NETWORK INTERFACE FUNCTIONS
// ============================================================================

int npcap_list_interfaces(NpcapInterface* interfaces, int max_count);
const char* npcap_get_last_error(void);
int npcap_open(const char* device_name);
void npcap_close(void);
int npcap_is_open(void);

// ============================================================================
// STATISTICS FUNCTIONS
// ============================================================================

void npcap_stats_reset(void);
void npcap_stats_session_start(void);
void npcap_stats_session_end(void);
void npcap_stats_update_rates(void);
void npcap_stats_get(TransmitStats* stats);
uint64_t npcap_stats_get_duration_ms(void);
void npcap_stats_format_rate(double bps, char* buf, size_t buflen);

// ============================================================================
// PUBLISHER FUNCTIONS
// ============================================================================

int npcap_publisher_configure(
    const char* svID,
    uint16_t appID,
    uint32_t confRev,
    uint8_t smpSynch,
    const uint8_t* srcMAC,
    const uint8_t* dstMAC,
    int vlanPriority,
    int vlanID,
    uint64_t sampleRate,
    double frequency,
    double voltageAmplitude,
    double currentAmplitude,
    uint8_t asduCount,
    uint8_t channelCount
);

int npcap_publisher_start(void);
int npcap_publisher_stop(void);
int npcap_publisher_is_running(void);

// ============================================================================
// SEND MODE FUNCTIONS
// ============================================================================

/**
 * Set the packet sending mechanism
 * @param mode - 0=AUTO (sendqueue if available, else single),
 *               1=SENDQUEUE (force batch mode, best for PCIe NICs),
 *               2=SENDPACKET (force immediate mode, best for USB adapters)
 * @return 0 on success, -1 on error (invalid mode or publishing in progress)
 */
int npcap_set_send_mode(int mode);

/**
 * Get the current send mode
 * @return Current mode (0=auto, 1=sendqueue, 2=sendpacket)
 */
int npcap_get_send_mode(void);

// ============================================================================
// DURATION & REPEAT MODE FUNCTIONS
// ============================================================================

/**
 * Set duration and repeat mode for publishing
 * @param durationSeconds - Duration in seconds (0 = continuous/infinite)
 * @param repeatEnabled - Whether repeat mode is enabled
 * @param repeatInfinite - If repeatEnabled, true = infinite loop
 * @param repeatCount - Number of times to repeat (if not infinite)
 * @return 0 on success
 */
int npcap_set_duration_mode(
    uint32_t durationSeconds,
    int repeatEnabled,
    int repeatInfinite,
    uint32_t repeatCount
);

/**
 * Get remaining time in seconds
 * @return Remaining seconds (0 if continuous mode or complete)
 */
uint32_t npcap_get_remaining_seconds(void);

/**
 * Get current repeat cycle number
 * @return Current cycle (0-based)
 */
uint32_t npcap_get_current_repeat_cycle(void);

/**
 * Check if duration has completed
 * @return 1 if complete, 0 if still running
 */
int npcap_is_duration_complete(void);

// ============================================================================
// EQUATION/CHANNEL FUNCTIONS
// ============================================================================

/**
 * Set equations for channels
 * @param equations - String format: "id1:equation1|id2:equation2|..."
 * @return 0 on success, -1 on error
 */
int npcap_set_equations(const char* equations);

// ============================================================================
// FRAME INSPECTION FUNCTIONS
// ============================================================================

/**
 * Get a sample frame with current configuration
 * Returns the actual encoded frame bytes that would be transmitted
 * @param outBuffer - Buffer to receive frame bytes (should be at least 256 bytes)
 * @param bufferSize - Size of the output buffer
 * @param outFrameSize - Actual frame size written
 * @param smpCnt - Sample count to use (0 for current)
 * @return 0 on success, -1 on error
 */
int npcap_get_sample_frame(uint8_t* outBuffer, size_t bufferSize, size_t* outFrameSize, uint32_t smpCnt);

/**
 * Get current channel values being transmitted
 * @param outValues - Array to receive 8 channel values (must be int32_t[8])
 * @return 0 on success, -1 on error
 */
int npcap_get_current_channel_values(int32_t* outValues);

/**
 * Get current sample count
 * @return Current sample count value
 */
uint32_t npcap_get_current_smp_cnt(void);

#ifdef __cplusplus
}
#endif

#endif /* SV_NATIVE_H */
