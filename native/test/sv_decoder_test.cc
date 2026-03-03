/**
 * @file sv_decoder_test.cc
 * @brief Test program for SV Decoder
 * 
 * Creates a synthetic SV packet (using the same format as your encoder),
 * decodes it, and verifies all fields match.
 * 
 * Build: cmake --build build
 * Run:   ./build/sv_decoder_test
 */

#include "sv_decoder.h"
#include "asn1_ber_decoder.h"
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cassert>

/* Subscriber function declarations (extern "C" in sv_subscriber.cc) */
extern "C" {
    void sv_subscriber_init(const char *svID, uint16_t smpCntMax);
    int  sv_subscriber_feed_packet(const uint8_t *buffer, size_t length, uint64_t timestamp_us);
    const char* sv_subscriber_get_frames_json(uint32_t startIndex, uint32_t maxFrames);
    const char* sv_subscriber_get_analysis_json(void);
    const char* sv_subscriber_get_status_json(void);
    void sv_subscriber_reset(void);
}

/*============================================================================
 * Build a test SV packet (same format as your sv_encoder_impl.cc)
 *============================================================================*/

static size_t build_test_packet(uint8_t *buffer, uint16_t smpCnt, 
                                 const char *svID, int32_t *samples, int channelCount)
{
    size_t pos = 0;
    
    /* Ethernet Header */
    // Dst MAC: 01:0C:CD:04:00:00 (SV multicast)
    buffer[pos++] = 0x01; buffer[pos++] = 0x0C; buffer[pos++] = 0xCD;
    buffer[pos++] = 0x04; buffer[pos++] = 0x00; buffer[pos++] = 0x00;
    // Src MAC: 00:11:22:33:44:55
    buffer[pos++] = 0x00; buffer[pos++] = 0x11; buffer[pos++] = 0x22;
    buffer[pos++] = 0x33; buffer[pos++] = 0x44; buffer[pos++] = 0x55;
    
    /* EtherType: SV (0x88BA) */
    buffer[pos++] = 0x88;
    buffer[pos++] = 0xBA;
    
    /* APPID = 0x4000 */
    buffer[pos++] = 0x40;
    buffer[pos++] = 0x00;
    
    /* Length placeholder */
    size_t lengthPos = pos;
    buffer[pos++] = 0;
    buffer[pos++] = 0;
    
    /* Reserved (4 bytes) */
    buffer[pos++] = 0; buffer[pos++] = 0;
    buffer[pos++] = 0; buffer[pos++] = 0;
    
    /* savPdu (tag 0x60) */
    buffer[pos++] = 0x60;
    size_t savPduLenPos = pos;
    buffer[pos++] = 0;  /* Length placeholder (1 byte for small packets) */
    
    /* noASDU = 1 */
    buffer[pos++] = 0x80;
    buffer[pos++] = 0x01;
    buffer[pos++] = 0x01;
    
    /* seqASDU (tag 0xA2) */
    buffer[pos++] = 0xA2;
    size_t seqASDULenPos = pos;
    buffer[pos++] = 0;
    
    /* ASDU (tag 0x30) */
    buffer[pos++] = 0x30;
    size_t asduLenPos = pos;
    buffer[pos++] = 0;
    
    /* svID (tag 0x80) */
    size_t svIDLen = strlen(svID);
    buffer[pos++] = 0x80;
    buffer[pos++] = (uint8_t)svIDLen;
    memcpy(buffer + pos, svID, svIDLen);
    pos += svIDLen;
    
    /* smpCnt (tag 0x82) */
    buffer[pos++] = 0x82;
    buffer[pos++] = 0x02;
    buffer[pos++] = (smpCnt >> 8) & 0xFF;
    buffer[pos++] = smpCnt & 0xFF;
    
    /* confRev (tag 0x83) = 1 */
    buffer[pos++] = 0x83;
    buffer[pos++] = 0x04;
    buffer[pos++] = 0x00;
    buffer[pos++] = 0x00;
    buffer[pos++] = 0x00;
    buffer[pos++] = 0x01;
    
    /* smpSynch (tag 0x85) = 2 (GPS) */
    buffer[pos++] = 0x85;
    buffer[pos++] = 0x01;
    buffer[pos++] = 0x02;
    
    /* seqData (tag 0x87) */
    uint8_t seqDataLen = channelCount * 8;
    buffer[pos++] = 0x87;
    buffer[pos++] = seqDataLen;
    
    for (int i = 0; i < channelCount; i++) {
        int32_t val = samples[i];
        buffer[pos++] = (val >> 24) & 0xFF;
        buffer[pos++] = (val >> 16) & 0xFF;
        buffer[pos++] = (val >> 8) & 0xFF;
        buffer[pos++] = val & 0xFF;
        /* Quality = 0 */
        buffer[pos++] = 0x00;
        buffer[pos++] = 0x00;
        buffer[pos++] = 0x00;
        buffer[pos++] = 0x00;
    }
    
    /* Fill in lengths */
    buffer[asduLenPos] = (uint8_t)(pos - asduLenPos - 1);
    buffer[seqASDULenPos] = (uint8_t)(pos - seqASDULenPos - 1);
    buffer[savPduLenPos] = (uint8_t)(pos - savPduLenPos - 1);
    
    /* APDU Length = savPduLen + 10 */
    size_t savPduLen = pos - savPduLenPos - 1;
    size_t apduLen = savPduLen + 10;
    buffer[lengthPos] = (apduLen >> 8) & 0xFF;
    buffer[lengthPos + 1] = apduLen & 0xFF;
    
    /* Pad to 60 bytes */
    while (pos < 60) buffer[pos++] = 0;
    
    return pos;
}

/*============================================================================
 * Tests
 *============================================================================*/

static void test_basic_decode() {
    printf("=== Test: Basic Decode ===\n");
    
    uint8_t buffer[256];
    int32_t samples[8] = { 325000, -162500, -162500, 0, 1414, -707, -707, 0 };
    
    size_t pktLen = build_test_packet(buffer, 42, "MU01", samples, 8);
    printf("  Packet size: %zu bytes\n", pktLen);
    
    SvDecodedFrame frame;
    int rc = sv_decoder_decode_frame(buffer, pktLen, &frame);
    
    assert(rc == 0);
    assert(frame.errors == 0);
    assert(frame.header.etherType == 0x88BA);
    assert(frame.header.appID == 0x4000);
    assert(frame.noASDU == 1);
    assert(frame.asduCount == 1);
    
    SvASDU *asdu = &frame.asdus[0];
    assert(strcmp(asdu->svID, "MU01") == 0);
    assert(asdu->smpCnt == 42);
    assert(asdu->confRev == 1);
    assert(asdu->smpSynch == 2);
    assert(asdu->channelCount == 8);
    assert(asdu->values[0] == 325000);
    assert(asdu->values[1] == -162500);
    assert(asdu->values[7] == 0);
    assert(asdu->quality[0] == 0);
    
    char macStr[18];
    sv_format_mac(frame.header.dstMAC, macStr, sizeof(macStr));
    printf("  Dst MAC: %s\n", macStr);
    sv_format_mac(frame.header.srcMAC, macStr, sizeof(macStr));
    printf("  Src MAC: %s\n", macStr);
    printf("  svID: %s, smpCnt: %u, confRev: %u\n", asdu->svID, asdu->smpCnt, asdu->confRev);
    printf("  Channels: %d, Values: [%d, %d, %d, %d, ...]\n",
           asdu->channelCount, asdu->values[0], asdu->values[1], asdu->values[2], asdu->values[3]);
    
    printf("  PASSED\n\n");
}

static void test_analysis_missing_sequence() {
    printf("=== Test: Missing Sequence Detection ===\n");
    
    SvAnalysisState state;
    sv_analysis_init(&state, "MU01", 3999);
    
    uint8_t buffer[256];
    int32_t samples[4] = { 100, 200, 300, 400 };
    SvAnalysisResult result;
    
    // Send smpCnt 0, 1, 2, then skip to 5
    for (uint16_t i = 0; i < 3; i++) {
        size_t len = build_test_packet(buffer, i, "MU01", samples, 4);
        SvDecodedFrame frame;
        sv_decoder_decode_frame(buffer, len, &frame);
        sv_analysis_process(&state, &frame, &result);
    }
    
    // Now send smpCnt=5 (skipping 3, 4)
    size_t len = build_test_packet(buffer, 5, "MU01", samples, 4);
    SvDecodedFrame frame;
    sv_decoder_decode_frame(buffer, len, &frame);
    sv_analysis_process(&state, &frame, &result);
    
    printf("  Expected: 3, Got: 5\n");
    printf("  Flags: 0x%08X\n", result.flags);
    printf("  Gap size: %u (from %u to %u)\n", result.gapSize, result.missingFrom, result.missingTo);
    
    assert(result.flags & SV_ANALYSIS_MISSING_SEQ);
    assert(result.gapSize == 2);
    assert(result.missingFrom == 3);
    assert(result.missingTo == 4);
    assert(state.missingCount == 2);
    
    printf("  PASSED\n\n");
}

static void test_subscriber_json() {
    printf("=== Test: Subscriber JSON Output ===\n");
    
    sv_subscriber_init("MU01", 3999);
    
    uint8_t buffer[256];
    int32_t samples[4] = { 1000, -2000, 3000, -4000 };
    
    // Feed 5 packets
    for (uint16_t i = 0; i < 5; i++) {
        size_t len = build_test_packet(buffer, i, "MU01", samples, 4);
        sv_subscriber_feed_packet(buffer, len, i * 250); // 250us apart
    }
    
    // Get frames JSON
    const char *json = sv_subscriber_get_frames_json(0, 10);
    printf("  Frames JSON (first 200 chars):\n  %.200s...\n\n", json);
    
    // Get analysis JSON
    const char *analysisJson = sv_subscriber_get_analysis_json();
    printf("  Analysis JSON:\n  %s\n\n", analysisJson);
    
    // Get status JSON
    const char *statusJson = sv_subscriber_get_status_json();
    printf("  Status JSON:\n  %s\n\n", statusJson);
    
    printf("  PASSED\n\n");
}

static void test_error_detection() {
    printf("=== Test: Error Detection ===\n");
    
    // Test 1: Wrong EtherType
    uint8_t badPacket1[60] = {0};
    badPacket1[12] = 0x08; badPacket1[13] = 0x00; // IP EtherType instead of SV
    
    SvDecodedFrame frame;
    int rc = sv_decoder_decode_frame(badPacket1, 60, &frame);
    assert(rc == -1);
    assert(frame.errors & SV_ERR_WRONG_ETHERTYPE);
    printf("  Wrong EtherType: detected (errors=0x%08X)\n", frame.errors);
    
    // Test 2: Buffer too short
    uint8_t shortPacket[10] = {0};
    rc = sv_decoder_decode_frame(shortPacket, 10, &frame);
    assert(rc == -1);
    printf("  Short buffer: detected (errors=0x%08X)\n", frame.errors);
    
    printf("  PASSED\n\n");
}

/*============================================================================
 * Main
 *============================================================================*/

int main() {
    printf("╔══════════════════════════════════════════╗\n");
    printf("║  SV Decoder Test Suite                   ║\n");
    printf("╚══════════════════════════════════════════╝\n\n");
    
    test_basic_decode();
    test_analysis_missing_sequence();
    test_subscriber_json();
    test_error_detection();
    
    printf("╔══════════════════════════════════════════╗\n");
    printf("║  ALL TESTS PASSED                        ║\n");
    printf("╚══════════════════════════════════════════╝\n");
    
    return 0;
}
