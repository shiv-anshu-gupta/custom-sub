/**
 * @file sv_decoder.h
 * @brief IEC 61850-9-2LE Sampled Values Packet Decoder
 * 
 * This header defines the decoder API for parsing SV packets.
 * It is the counterpart to sv_encoder.h used in the SV Publisher.
 * 
 * Packet Structure (decoded layer by layer):
 * ```
 * ┌──────────────────────────────────────────────┐
 * │ Ethernet Header (14B / 18B with VLAN)        │
 * │  ├─ Dst MAC (6B)                             │
 * │  ├─ Src MAC (6B)                             │
 * │  ├─ [VLAN Tag] (4B optional)                 │
 * │  └─ EtherType = 0x88BA (2B)                  │
 * ├──────────────────────────────────────────────┤
 * │ SV Header (8B)                               │
 * │  ├─ AppID (2B)                               │
 * │  ├─ Length (2B)                               │
 * │  └─ Reserved (4B)                            │
 * ├──────────────────────────────────────────────┤
 * │ savPdu (ASN.1 BER)                           │
 * │  ├─ noASDU [0x80]                            │
 * │  └─ seqASDU [0xA2]                           │
 * │     └─ ASDU [0x30] (repeated)                │
 * │        ├─ svID [0x80]                        │
 * │        ├─ datSet [0x81] (optional)           │
 * │        ├─ smpCnt [0x82]                      │
 * │        ├─ confRev [0x83]                     │
 * │        ├─ refrTm [0x84] (optional)           │
 * │        ├─ smpSynch [0x85]                    │
 * │        ├─ smpRate [0x86] (optional)          │
 * │        └─ seqData [0x87]                     │
 * │           └─ channels × (4B val + 4B qual)   │
 * └──────────────────────────────────────────────┘
 * ```
 * 
 * Designed for Tauri FFI: All functions use extern "C" with simple
 * struct parameters that can be called from Rust.
 */

#ifndef SV_DECODER_H
#define SV_DECODER_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*============================================================================
 * Constants
 *============================================================================*/

#define SV_DEC_MAX_CHANNELS     20      /**< Max channels per ASDU */
#define SV_DEC_MAX_ASDUS        8       /**< Max ASDUs per frame */
#define SV_DEC_MAX_SVID_LEN     64      /**< Max svID string length */
#define SV_DEC_MAX_DATSET_LEN   128     /**< Max datSet reference length */
#define SV_ETHERTYPE            0x88BA  /**< SV EtherType */
#define SV_VLAN_ETHERTYPE       0x8100  /**< 802.1Q VLAN tag */

/*============================================================================
 * Error Bitmask (for frame validation)
 *============================================================================*/

#define SV_ERR_NONE                 0x00000000
#define SV_ERR_BUFFER_TOO_SHORT     0x00000001  /**< Packet shorter than minimum */
#define SV_ERR_WRONG_ETHERTYPE      0x00000002  /**< Not 0x88BA */
#define SV_ERR_INVALID_SV_LENGTH    0x00000004  /**< SV length field inconsistent */
#define SV_ERR_BER_DECODE_FAIL      0x00000008  /**< ASN.1 BER parsing failed */
#define SV_ERR_MISSING_SAVPDU       0x00000010  /**< No savPdu tag (0x60) */
#define SV_ERR_MISSING_NOASDU       0x00000020  /**< No noASDU field */
#define SV_ERR_MISSING_SEQASDU      0x00000040  /**< No seqASDU field */
#define SV_ERR_MISSING_SVID         0x00000080  /**< ASDU missing svID */
#define SV_ERR_MISSING_SMPCNT       0x00000100  /**< ASDU missing smpCnt */
#define SV_ERR_MISSING_CONFREV      0x00000200  /**< ASDU missing confRev */
#define SV_ERR_MISSING_SEQDATA      0x00000400  /**< ASDU missing seqData */
#define SV_ERR_ASDU_COUNT_MISMATCH  0x00000800  /**< Actual ASDUs ≠ noASDU value */
#define SV_ERR_CHANNEL_DATA_SHORT   0x00001000  /**< seqData length not multiple of 8 */

/*============================================================================
 * Analysis Error Types
 *============================================================================*/

#define SV_ANALYSIS_MISSING_SEQ     0x00010000  /**< Missing sequence number(s) */
#define SV_ANALYSIS_OUT_OF_ORDER    0x00020000  /**< smpCnt arrived out of order */
#define SV_ANALYSIS_DUPLICATE       0x00040000  /**< Duplicate smpCnt detected */

/*============================================================================
 * Data Structures
 *============================================================================*/

/**
 * @brief Decoded Ethernet + SV frame header
 */
typedef struct {
    uint8_t     dstMAC[6];          /**< Destination MAC address */
    uint8_t     srcMAC[6];          /**< Source MAC address */
    uint16_t    vlanID;             /**< VLAN ID (0 if no VLAN) */
    uint8_t     vlanPriority;       /**< VLAN priority (0-7) */
    uint8_t     hasVLAN;            /**< 1 if VLAN tag present */
    uint16_t    etherType;          /**< Should be 0x88BA */
    uint16_t    appID;              /**< Application ID */
    uint16_t    svLength;           /**< SV length field */
    uint16_t    reserved1;          /**< Reserved field 1 */
    uint16_t    reserved2;          /**< Reserved field 2 */
} SvFrameHeader;

/**
 * @brief Decoded single ASDU from an SV packet
 */
typedef struct {
    /* Mandatory fields */
    char        svID[SV_DEC_MAX_SVID_LEN + 1];     /**< Stream identifier (null-terminated) */
    uint16_t    smpCnt;                              /**< Sample counter */
    uint32_t    confRev;                             /**< Configuration revision */
    uint8_t     smpSynch;                            /**< Synchronization status */
    
    /* Optional fields */
    char        datSet[SV_DEC_MAX_DATSET_LEN + 1];  /**< Dataset reference (optional) */
    uint8_t     hasDatSet;                           /**< 1 if datSet present */
    uint16_t    smpRate;                             /**< Sample rate (optional) */
    uint8_t     hasSmpRate;                          /**< 1 if smpRate present */
    uint8_t     smpMod;                              /**< Sample mode (optional) */
    uint8_t     hasSmpMod;                           /**< 1 if smpMod present */
    
    /* Channel data: value + quality pairs */
    int32_t     values[SV_DEC_MAX_CHANNELS];         /**< Channel values (big-endian decoded) */
    uint32_t    quality[SV_DEC_MAX_CHANNELS];        /**< Channel quality flags */
    uint8_t     channelCount;                        /**< Number of decoded channels */
    
    /* Per-ASDU validation */
    uint32_t    errors;                              /**< Error bitmask for this ASDU */
    
    /* Position within original frame */
    uint8_t     asduIndex;                           /**< 0-based index of this ASDU in the frame */
} SvASDU;

/**
 * @brief Complete decoded SV frame
 */
typedef struct {
    SvFrameHeader   header;                         /**< Ethernet + SV header */
    uint8_t         noASDU;                         /**< Declared ASDU count */
    uint8_t         asduCount;                      /**< Actual decoded ASDU count */
    SvASDU          asdus[SV_DEC_MAX_ASDUS];        /**< Decoded ASDUs */
    
    /* Frame-level validation */
    uint32_t        errors;                         /**< Frame-level error bitmask */
    
    /* Metadata */
    size_t          rawLength;                      /**< Original raw packet length */
    uint64_t        timestamp_us;                   /**< Capture timestamp (microseconds) */
    uint32_t        frameIndex;                     /**< Sequential frame number */
} SvDecodedFrame;

/*============================================================================
 * Analysis State - Tracks sequence integrity across frames
 *============================================================================*/

/**
 * @brief Per-stream analysis state for sequence tracking
 * 
 * One instance per unique svID being tracked.
 */
typedef struct {
    char        svID[SV_DEC_MAX_SVID_LEN + 1];     /**< Stream being tracked */
    uint16_t    lastSmpCnt;                          /**< Last received smpCnt */
    uint16_t    expectedSmpCnt;                      /**< Next expected smpCnt */
    uint8_t     initialized;                         /**< 1 after first frame received */
    
    /* Counters */
    uint64_t    totalFrames;                         /**< Total frames received */
    uint64_t    missingCount;                        /**< Total missing sequence numbers */
    uint64_t    outOfOrderCount;                     /**< Total out-of-order frames */
    uint64_t    duplicateCount;                      /**< Total duplicate smpCnt */
    uint64_t    errorCount;                          /**< Total frames with errors */
    
    /* Wrap-around tracking */
    uint16_t    smpCntMax;                           /**< Max smpCnt before wrap (e.g., 3999 for 4kHz) */
} SvAnalysisState;

/**
 * @brief Result of analyzing one frame
 */
typedef struct {
    uint32_t    flags;                  /**< Analysis flags (SV_ANALYSIS_*) */
    uint16_t    expectedSmpCnt;         /**< What we expected */
    uint16_t    actualSmpCnt;           /**< What we got */
    uint16_t    missingFrom;            /**< First missing smpCnt (if gap) */
    uint16_t    missingTo;              /**< Last missing smpCnt (if gap) */
    uint16_t    gapSize;                /**< Number of missing samples */
    uint32_t    dupTsGroupSize;         /**< Consecutive frames with same pcap timestamp (1=unique) */
} SvAnalysisResult;

/*============================================================================
 * Decoder API
 *============================================================================*/

/**
 * @brief Decode a raw SV Ethernet frame
 * 
 * Parses the complete packet: Ethernet header → SV header → BER payload → ASDUs
 * 
 * @param[in]  buffer      Raw packet bytes
 * @param[in]  length      Packet length in bytes
 * @param[out] frame       Decoded frame result
 * @return 0 on success (may still have non-fatal errors in frame->errors),
 *         -1 on fatal decode failure
 */
int sv_decoder_decode_frame(const uint8_t *buffer, size_t length, SvDecodedFrame *frame);

/**
 * @brief Get human-readable error string
 * 
 * @param error_bit  Single error bit from SV_ERR_* or SV_ANALYSIS_*
 * @return Static string describing the error
 */
const char* sv_decoder_error_string(uint32_t error_bit);

/**
 * @brief Check if frame has any errors
 */
int sv_decoder_has_errors(const SvDecodedFrame *frame);

/*============================================================================
 * Analysis API
 *============================================================================*/

/**
 * @brief Initialize analysis state for a stream
 * 
 * @param[out] state       Analysis state to initialize
 * @param[in]  svID        Stream ID to track (null-terminated)
 * @param[in]  smpCntMax   Max sample count before wrap (e.g., 3999 for 4000Hz)
 */
void sv_analysis_init(SvAnalysisState *state, const char *svID, uint16_t smpCntMax);

/**
 * @brief Analyze a decoded frame for sequence integrity
 * 
 * Checks for:
 *   - Missing sequence numbers (gaps in smpCnt)
 *   - Out-of-order delivery (smpCnt < expected but not wrap-around)
 *   - Duplicate smpCnt values
 * 
 * @param[in,out] state   Analysis state (updated with new frame info)
 * @param[in]     frame   Decoded frame to analyze
 * @param[out]    result  Analysis result
 * @return 0 on success
 */
int sv_analysis_process(SvAnalysisState *state, const SvDecodedFrame *frame,
                        SvAnalysisResult *result);

/**
 * @brief Reset analysis counters (keep svID and smpCntMax)
 */
void sv_analysis_reset(SvAnalysisState *state);

/*============================================================================
 * Utility
 *============================================================================*/

/**
 * @brief Format MAC address as string "XX:XX:XX:XX:XX:XX"
 * @param[in]  mac    6-byte MAC address
 * @param[out] str    Output buffer (at least 18 bytes)
 * @param[in]  strLen Size of output buffer
 */
void sv_format_mac(const uint8_t *mac, char *str, size_t strLen);

/**
 * @brief Format error bitmask as comma-separated string
 * @param[in]  errors  Error bitmask
 * @param[out] str     Output buffer
 * @param[in]  strLen  Size of output buffer
 */
void sv_format_errors(uint32_t errors, char *str, size_t strLen);

#ifdef __cplusplus
}
#endif

#endif /* SV_DECODER_H */
