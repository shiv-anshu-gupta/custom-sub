/**
 * @file sv_decoder_impl.cc
 * @brief IEC 61850-9-2LE Sampled Values Packet Decoder Implementation
 * 
 * Decodes raw SV Ethernet frames into structured data.
 * This is the exact reverse of sv_encoder_impl.cc.
 * 
 * Decoding pipeline:
 * 1. Parse Ethernet header (MAC addresses, VLAN, EtherType)
 * 2. Parse SV header (AppID, Length, Reserved)
 * 3. Parse savPdu BER envelope (tag 0x60)
 * 4. Extract noASDU and seqASDU
 * 5. For each ASDU: extract svID, smpCnt, confRev, smpSynch, seqData
 * 6. From seqData: extract channel values (4B) + quality (4B) pairs
 */

#include "sv_decoder.h"
#include "asn1_ber_decoder.h"
#include <cstdio>
#include <cstring>

/*============================================================================
 * Internal Helpers
 *============================================================================*/

/**
 * @brief Parse Ethernet + SV header from raw frame
 * 
 * Handles both plain Ethernet and 802.1Q VLAN-tagged frames.
 * Returns offset to start of savPdu (BER payload).
 */
static int parse_ethernet_sv_header(const uint8_t *buffer, size_t length,
                                     SvFrameHeader *header, size_t *payload_offset)
{
    if (length < 14) {
        return -1; /* Too short for Ethernet */
    }
    
    size_t pos = 0;
    
    /* Destination MAC */
    memcpy(header->dstMAC, buffer + pos, 6);
    pos += 6;
    
    /* Source MAC */
    memcpy(header->srcMAC, buffer + pos, 6);
    pos += 6;
    
    /* Check for VLAN tag */
    uint16_t typeOrVlan = ((uint16_t)buffer[pos] << 8) | buffer[pos + 1];
    
    if (typeOrVlan == SV_VLAN_ETHERTYPE) {
        /* 802.1Q VLAN tag present */
        if (length < 18) return -1;
        
        header->hasVLAN = 1;
        pos += 2; /* Skip 0x8100 */
        
        uint16_t vlanTag = ((uint16_t)buffer[pos] << 8) | buffer[pos + 1];
        header->vlanPriority = (vlanTag >> 13) & 0x07;
        header->vlanID = vlanTag & 0x0FFF;
        pos += 2;
        
        /* Next should be EtherType */
        header->etherType = ((uint16_t)buffer[pos] << 8) | buffer[pos + 1];
        pos += 2;
    } else {
        header->hasVLAN = 0;
        header->vlanID = 0;
        header->vlanPriority = 0;
        header->etherType = typeOrVlan;
        pos += 2;
    }
    
    /* Validate EtherType */
    if (header->etherType != SV_ETHERTYPE) {
        return -2; /* Wrong EtherType */
    }
    
    /* SV Header: AppID (2) + Length (2) + Reserved (4) = 8 bytes */
    if (pos + 8 > length) return -1;
    
    header->appID = ((uint16_t)buffer[pos] << 8) | buffer[pos + 1];
    pos += 2;
    
    header->svLength = ((uint16_t)buffer[pos] << 8) | buffer[pos + 1];
    pos += 2;
    
    header->reserved1 = ((uint16_t)buffer[pos] << 8) | buffer[pos + 1];
    pos += 2;
    
    header->reserved2 = ((uint16_t)buffer[pos] << 8) | buffer[pos + 1];
    pos += 2;
    
    *payload_offset = pos;
    return 0;
}

/**
 * @brief Decode a single ASDU from BER TLV data
 * 
 * Parses children of a SEQUENCE (0x30) tag to extract:
 * svID, smpCnt, confRev, smpSynch, seqData, and optional fields
 */
static int decode_asdu(const uint8_t *data, size_t len, SvASDU *asdu)
{
    memset(asdu, 0, sizeof(SvASDU));
    
    BerTLV child;
    size_t offset = 0;
    
    while (ber_decode_next_child(data, len, &offset, &child) == BER_OK) {
        switch (child.tag) {
            case 0x80: { /* svID (context [0]) */
                size_t copyLen = (child.length < SV_DEC_MAX_SVID_LEN) 
                                  ? child.length : SV_DEC_MAX_SVID_LEN;
                memcpy(asdu->svID, child.value, copyLen);
                asdu->svID[copyLen] = '\0';
                break;
            }
            
            case 0x81: { /* datSet (context [1]) - optional */
                size_t copyLen = (child.length < SV_DEC_MAX_DATSET_LEN) 
                                  ? child.length : SV_DEC_MAX_DATSET_LEN;
                memcpy(asdu->datSet, child.value, copyLen);
                asdu->datSet[copyLen] = '\0';
                asdu->hasDatSet = 1;
                break;
            }
            
            case 0x82: { /* smpCnt (context [2]) */
                if (child.length >= 2) {
                    ber_decode_uint16_be(child.value, child.length, &asdu->smpCnt);
                } else if (child.length == 1) {
                    asdu->smpCnt = child.value[0];
                }
                break;
            }
            
            case 0x83: { /* confRev (context [3]) */
                if (child.length >= 4) {
                    ber_decode_uint32_be(child.value, child.length, &asdu->confRev);
                } else {
                    uint64_t val = 0;
                    ber_decode_unsigned(child.value, child.length, &val);
                    asdu->confRev = (uint32_t)val;
                }
                break;
            }
            
            case 0x84: { /* refrTm (context [4]) - optional, skip for now */
                break;
            }
            
            case 0x85: { /* smpSynch (context [5]) */
                if (child.length >= 1) {
                    asdu->smpSynch = child.value[0];
                }
                break;
            }
            
            case 0x86: { /* smpRate (context [6]) - optional */
                if (child.length >= 2) {
                    ber_decode_uint16_be(child.value, child.length, &asdu->smpRate);
                }
                asdu->hasSmpRate = 1;
                break;
            }
            
            case 0x87: { /* seqData (context [7]) - channel data */
                /* Each channel = 4 bytes value + 4 bytes quality = 8 bytes */
                if (child.length % 8 != 0) {
                    asdu->errors |= SV_ERR_CHANNEL_DATA_SHORT;
                }
                
                uint8_t numChannels = (uint8_t)(child.length / 8);
                if (numChannels > SV_DEC_MAX_CHANNELS) {
                    numChannels = SV_DEC_MAX_CHANNELS;
                }
                
                asdu->channelCount = numChannels;
                
                for (int ch = 0; ch < numChannels; ch++) {
                    const uint8_t *chData = child.value + (ch * 8);
                    ber_decode_int32_be(chData, 4, &asdu->values[ch]);
                    ber_decode_uint32_be(chData + 4, 4, &asdu->quality[ch]);
                }
                break;
            }
            
            case 0x88: { /* smpMod (context [8]) - optional */
                if (child.length >= 1) {
                    asdu->smpMod = child.value[0];
                }
                asdu->hasSmpMod = 1;
                break;
            }
            
            default:
                /* Unknown tag - skip (forward compatibility) */
                break;
        }
    }
    
    /* Validate mandatory fields */
    if (asdu->svID[0] == '\0') asdu->errors |= SV_ERR_MISSING_SVID;
    /* Note: smpCnt=0 is valid, confRev=0 is valid, so we can't check for zero */
    
    return 0;
}

/*============================================================================
 * Public API: Frame Decoder
 *============================================================================*/

int sv_decoder_decode_frame(const uint8_t *buffer, size_t length, SvDecodedFrame *frame)
{
    if (!buffer || !frame) return -1;
    
    memset(frame, 0, sizeof(SvDecodedFrame));
    frame->rawLength = length;
    
    /* Minimum Ethernet frame size check */
    if (length < 14) {
        frame->errors |= SV_ERR_BUFFER_TOO_SHORT;
        return -1;
    }
    
    /* Step 1: Parse Ethernet + SV header */
    size_t payload_offset = 0;
    int hdr_rc = parse_ethernet_sv_header(buffer, length, &frame->header, &payload_offset);
    
    if (hdr_rc == -2) {
        frame->errors |= SV_ERR_WRONG_ETHERTYPE;
        return -1;
    }
    if (hdr_rc == -1) {
        frame->errors |= SV_ERR_BUFFER_TOO_SHORT;
        return -1;
    }
    
    /* Validate SV length field */
    size_t svPayloadLen = length - payload_offset + 8; /* +8 because svLength includes SV header */
    if (frame->header.svLength > 0 && frame->header.svLength > svPayloadLen + 8) {
        frame->errors |= SV_ERR_INVALID_SV_LENGTH;
        /* Continue anyway - non-fatal */
    }
    
    /* Step 2: Parse savPdu envelope (tag 0x60) */
    size_t remaining = length - payload_offset;
    if (remaining < 2) {
        frame->errors |= SV_ERR_BER_DECODE_FAIL;
        return -1;
    }
    
    BerTLV savPdu;
    int rc = ber_decode_tlv(buffer + payload_offset, remaining, &savPdu);
    if (rc != BER_OK || savPdu.tag != SV_DEC_TAG_SAVPDU) {
        frame->errors |= SV_ERR_MISSING_SAVPDU;
        return -1;
    }
    
    /* Step 3: Iterate savPdu children: noASDU and seqASDU */
    BerTLV savChild;
    size_t savOffset = 0;
    uint8_t foundNoASDU = 0;
    uint8_t foundSeqASDU = 0;
    const uint8_t *seqASDU_value = NULL;
    size_t seqASDU_len = 0;
    
    while (ber_decode_next_child(savPdu.value, savPdu.length, &savOffset, &savChild) == BER_OK) {
        if (savChild.tag == SV_DEC_TAG_NOASDU) {
            /* noASDU: single byte giving number of ASDUs */
            if (savChild.length >= 1) {
                frame->noASDU = savChild.value[0];
                foundNoASDU = 1;
            }
        } else if (savChild.tag == SV_DEC_TAG_SEQASDU) {
            /* seqASDU: contains the ASDU SEQUENCE elements */
            seqASDU_value = savChild.value;
            seqASDU_len = savChild.length;
            foundSeqASDU = 1;
        }
    }
    
    if (!foundNoASDU) frame->errors |= SV_ERR_MISSING_NOASDU;
    if (!foundSeqASDU) {
        frame->errors |= SV_ERR_MISSING_SEQASDU;
        return -1;
    }
    
    /* Step 4: Iterate seqASDU children: each ASDU (tag 0x30) */
    BerTLV asduTlv;
    size_t seqOffset = 0;
    uint8_t asduIndex = 0;
    
    while (ber_decode_next_child(seqASDU_value, seqASDU_len, &seqOffset, &asduTlv) == BER_OK) {
        if (asduTlv.tag != SV_DEC_TAG_ASDU) {
            continue; /* Skip unexpected tags */
        }
        
        if (asduIndex >= SV_DEC_MAX_ASDUS) {
            break; /* Safety limit */
        }
        
        /* Decode this ASDU's children */
        decode_asdu(asduTlv.value, asduTlv.length, &frame->asdus[asduIndex]);
        asduIndex++;
    }
    
    frame->asduCount = asduIndex;
    
    /* Validate ASDU count matches declaration */
    if (foundNoASDU && frame->asduCount != frame->noASDU) {
        frame->errors |= SV_ERR_ASDU_COUNT_MISMATCH;
    }
    
    return 0;
}

/*============================================================================
 * Error String Lookup
 *============================================================================*/

const char* sv_decoder_error_string(uint32_t error_bit)
{
    switch (error_bit) {
        case SV_ERR_BUFFER_TOO_SHORT:    return "Buffer too short";
        case SV_ERR_WRONG_ETHERTYPE:     return "Wrong EtherType (not 0x88BA)";
        case SV_ERR_INVALID_SV_LENGTH:   return "Invalid SV length field";
        case SV_ERR_BER_DECODE_FAIL:     return "BER decode failure";
        case SV_ERR_MISSING_SAVPDU:      return "Missing savPdu (0x60)";
        case SV_ERR_MISSING_NOASDU:      return "Missing noASDU field";
        case SV_ERR_MISSING_SEQASDU:     return "Missing seqASDU field";
        case SV_ERR_MISSING_SVID:        return "ASDU missing svID";
        case SV_ERR_MISSING_SMPCNT:      return "ASDU missing smpCnt";
        case SV_ERR_MISSING_CONFREV:     return "ASDU missing confRev";
        case SV_ERR_MISSING_SEQDATA:     return "ASDU missing seqData";
        case SV_ERR_ASDU_COUNT_MISMATCH: return "ASDU count mismatch";
        case SV_ERR_CHANNEL_DATA_SHORT:  return "Channel data length invalid";
        case SV_ANALYSIS_MISSING_SEQ:    return "Missing sequence number(s)";
        case SV_ANALYSIS_OUT_OF_ORDER:   return "Out-of-sequence data";
        case SV_ANALYSIS_DUPLICATE:      return "Duplicate sample count";
        default:                         return "Unknown error";
    }
}

int sv_decoder_has_errors(const SvDecodedFrame *frame)
{
    if (!frame) return 1;
    
    if (frame->errors != SV_ERR_NONE) return 1;
    
    for (uint8_t i = 0; i < frame->asduCount; i++) {
        if (frame->asdus[i].errors != SV_ERR_NONE) return 1;
    }
    
    return 0;
}

/*============================================================================
 * Analysis Functions
 *============================================================================*/

void sv_analysis_init(SvAnalysisState *state, const char *svID, uint16_t smpCntMax)
{
    if (!state) return;
    
    memset(state, 0, sizeof(SvAnalysisState));
    
    if (svID) {
        strncpy(state->svID, svID, SV_DEC_MAX_SVID_LEN);
        state->svID[SV_DEC_MAX_SVID_LEN] = '\0';
    }
    
    state->smpCntMax = smpCntMax;
    state->initialized = 0;
}

int sv_analysis_process(SvAnalysisState *state, const SvDecodedFrame *frame,
                        SvAnalysisResult *result)
{
    if (!state || !frame || !result) return -1;
    
    memset(result, 0, sizeof(SvAnalysisResult));
    
    /* Find the ASDU matching our svID (or use first ASDU) */
    const SvASDU *asdu = NULL;
    for (uint8_t i = 0; i < frame->asduCount; i++) {
        if (state->svID[0] == '\0' || strcmp(frame->asdus[i].svID, state->svID) == 0) {
            asdu = &frame->asdus[i];
            break;
        }
    }
    
    if (!asdu) return -1; /* No matching ASDU found */
    
    uint16_t smpCnt = asdu->smpCnt;
    result->actualSmpCnt = smpCnt;
    
    state->totalFrames++;
    
    /* Count any frame/ASDU errors */
    if (frame->errors != SV_ERR_NONE || asdu->errors != SV_ERR_NONE) {
        state->errorCount++;
    }
    
    /* First frame: just record and return */
    if (!state->initialized) {
        state->lastSmpCnt = smpCnt;
        state->expectedSmpCnt = (smpCnt + 1) % (state->smpCntMax + 1);
        state->initialized = 1;
        result->expectedSmpCnt = smpCnt;
        return 0;
    }
    
    result->expectedSmpCnt = state->expectedSmpCnt;
    
    /* Check for expected sequence */
    if (smpCnt == state->expectedSmpCnt) {
        /* Normal: received expected sample */
        state->lastSmpCnt = smpCnt;
        state->expectedSmpCnt = (smpCnt + 1) % (state->smpCntMax + 1);
    }
    else if (smpCnt == state->lastSmpCnt) {
        /* Duplicate */
        result->flags |= SV_ANALYSIS_DUPLICATE;
        state->duplicateCount++;
    }
    else {
        /* Gap or out-of-order */
        uint16_t maxCnt = state->smpCntMax;
        uint16_t expected = state->expectedSmpCnt;
        
        /* Calculate forward distance (accounting for wrap-around) */
        uint16_t forwardDist;
        if (smpCnt >= expected) {
            forwardDist = smpCnt - expected;
        } else {
            forwardDist = (maxCnt + 1 - expected) + smpCnt;
        }
        
        /* Calculate backward distance */
        uint16_t backwardDist;
        if (expected >= smpCnt) {
            backwardDist = expected - smpCnt;
        } else {
            backwardDist = (maxCnt + 1 - smpCnt) + expected;
        }
        
        if (forwardDist <= (uint16_t)(maxCnt / 2)) {
            /* Forward gap: missing samples */
            result->flags |= SV_ANALYSIS_MISSING_SEQ;
            result->missingFrom = expected;
            result->missingTo = (smpCnt == 0) ? maxCnt : (smpCnt - 1);
            result->gapSize = forwardDist;
            state->missingCount += forwardDist;
            
            state->lastSmpCnt = smpCnt;
            state->expectedSmpCnt = (smpCnt + 1) % (maxCnt + 1);
        } else {
            /* Backward: out-of-order */
            result->flags |= SV_ANALYSIS_OUT_OF_ORDER;
            state->outOfOrderCount++;
            /* Don't update expected - this was a late arrival */
        }
    }
    
    return 0;
}

void sv_analysis_reset(SvAnalysisState *state)
{
    if (!state) return;
    
    char svID[SV_DEC_MAX_SVID_LEN + 1];
    uint16_t maxCnt = state->smpCntMax;
    
    strncpy(svID, state->svID, SV_DEC_MAX_SVID_LEN);
    svID[SV_DEC_MAX_SVID_LEN] = '\0';
    
    memset(state, 0, sizeof(SvAnalysisState));
    strncpy(state->svID, svID, SV_DEC_MAX_SVID_LEN);
    state->svID[SV_DEC_MAX_SVID_LEN] = '\0';
    state->smpCntMax = maxCnt;
}

/*============================================================================
 * Utility Functions
 *============================================================================*/

void sv_format_mac(const uint8_t *mac, char *str, size_t strLen)
{
    if (!mac || !str || strLen < 18) return;
    
    snprintf(str, strLen, "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

void sv_format_errors(uint32_t errors, char *str, size_t strLen)
{
    if (!str || strLen == 0) return;
    str[0] = '\0';
    
    if (errors == SV_ERR_NONE) {
        snprintf(str, strLen, "OK");
        return;
    }
    
    size_t pos = 0;
    const uint32_t bits[] = {
        SV_ERR_BUFFER_TOO_SHORT, SV_ERR_WRONG_ETHERTYPE, SV_ERR_INVALID_SV_LENGTH,
        SV_ERR_BER_DECODE_FAIL, SV_ERR_MISSING_SAVPDU, SV_ERR_MISSING_NOASDU,
        SV_ERR_MISSING_SEQASDU, SV_ERR_MISSING_SVID, SV_ERR_MISSING_SMPCNT,
        SV_ERR_MISSING_CONFREV, SV_ERR_MISSING_SEQDATA, SV_ERR_ASDU_COUNT_MISMATCH,
        SV_ERR_CHANNEL_DATA_SHORT, SV_ANALYSIS_MISSING_SEQ, SV_ANALYSIS_OUT_OF_ORDER,
        SV_ANALYSIS_DUPLICATE
    };
    
    for (size_t i = 0; i < sizeof(bits) / sizeof(bits[0]); i++) {
        if (errors & bits[i]) {
            const char *desc = sv_decoder_error_string(bits[i]);
            size_t descLen = strlen(desc);
            
            if (pos + descLen + 2 >= strLen) break;
            
            if (pos > 0) {
                str[pos++] = ',';
                str[pos++] = ' ';
            }
            memcpy(str + pos, desc, descLen);
            pos += descLen;
            str[pos] = '\0';
        }
    }
}
