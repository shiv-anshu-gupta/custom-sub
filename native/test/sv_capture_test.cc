/**
 * @file sv_capture_test.cc
 * @brief Standalone SV Capture Test - Verifies capture layer works with your SV Publisher
 * 
 * Usage:
 *   sv_capture_test.exe                  (lists interfaces, prompts user to pick one)
 *   sv_capture_test.exe <interface_idx>  (directly opens interface by index)
 * 
 * Run your SV Publisher on the same machine / network, then run this.
 * It will print every captured SV frame to the console.
 */

#include "../include/sv_capture.h"
#include "../include/sv_decoder.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <chrono>
#include <thread>

#ifdef _WIN32
#include <windows.h>
#endif

/*============================================================================
 * Extern declarations for subscriber functions
 *============================================================================*/
extern "C" {
    void sv_subscriber_init(const char *svID, uint16_t smpCntMax);
    int  sv_subscriber_feed_packet(const uint8_t *buffer, size_t length, uint64_t timestamp_us);
    const char* sv_subscriber_get_frames_json(uint32_t startIndex, uint32_t maxFrames);
    const char* sv_subscriber_get_analysis_json(void);
    const char* sv_subscriber_get_status_json(void);
    void sv_subscriber_reset(void);
}

/*============================================================================
 * Signal Handler for clean shutdown
 *============================================================================*/
static volatile int g_running = 1;

static void signal_handler(int sig) {
    (void)sig;
    printf("\n[test] Ctrl+C received, stopping...\n");
    g_running = 0;
}

/*============================================================================
 * Main
 *============================================================================*/
int main(int argc, char* argv[]) {
    printf("============================================================\n");
    printf("  SV Subscriber - Capture Test\n");
    printf("  IEC 61850-9-2LE Sampled Values\n");
    printf("============================================================\n");
    printf("  Usage: sv_capture_test [interface_idx] [smpCntMax]\n");
    printf("  Examples:\n");
    printf("    sv_capture_test 0          (interface 0, auto-detect rate)\n");
    printf("    sv_capture_test 0 79       (interface 0, smpCnt wraps at 79)\n");
    printf("    sv_capture_test 0 3999     (interface 0, 4000 Hz)\n");
    printf("============================================================\n\n");
    
    /* Register signal handler */
    signal(SIGINT, signal_handler);
    
    /* Step 1: Load Npcap DLL */
    printf("[1] Loading Npcap DLL...\n");
    if (!sv_capture_load_dll()) {
        printf("FATAL: %s\n", sv_capture_get_error());
        printf("\nMake sure Npcap is installed: https://npcap.com/\n");
        return 1;
    }
    printf("    OK\n\n");
    
    /* Step 2: List interfaces */
    printf("[2] Enumerating network interfaces...\n");
    SvCaptureInterface interfaces[SV_CAP_MAX_INTERFACES];
    int count = sv_capture_list_interfaces(interfaces, SV_CAP_MAX_INTERFACES);
    
    if (count <= 0) {
        printf("FATAL: No interfaces found. Run as Administrator?\n");
        printf("Error: %s\n", sv_capture_get_error());
        return 1;
    }
    
    printf("\n    Available interfaces:\n");
    printf("    %-4s %-40s %s\n", "Idx", "Description", "MAC");
    printf("    %-4s %-40s %s\n", "---", "----------------------------------------", "-----------------");
    
    for (int i = 0; i < count; i++) {
        char mac_str[20] = "N/A";
        if (interfaces[i].has_mac) {
            snprintf(mac_str, sizeof(mac_str), "%02X:%02X:%02X:%02X:%02X:%02X",
                     interfaces[i].mac[0], interfaces[i].mac[1], interfaces[i].mac[2],
                     interfaces[i].mac[3], interfaces[i].mac[4], interfaces[i].mac[5]);
        }
        printf("    [%d]  %-40s %s\n", i,
               interfaces[i].description[0] ? interfaces[i].description : interfaces[i].name,
               mac_str);
    }
    
    /* Step 3: Select interface */
    int selected = -1;
    
    if (argc > 1) {
        selected = atoi(argv[1]);
        printf("\n    Using command-line selection: %d\n", selected);
    } else {
        printf("\n    Enter interface index (0-%d): ", count - 1);
        fflush(stdout);
        if (scanf("%d", &selected) != 1) {
            printf("Invalid input\n");
            return 1;
        }
    }
    
    if (selected < 0 || selected >= count) {
        printf("FATAL: Invalid interface index %d\n", selected);
        return 1;
    }
    
    printf("    Selected: %s\n\n", 
           interfaces[selected].description[0] ? interfaces[selected].description : interfaces[selected].name);
    
    /* Step 4: Initialize subscriber */
    /* Parse smpCntMax from CLI or use 0 for auto-detect */
    uint16_t smpCntMax = 0; /* 0 = auto-detect from first wrap-around */
    if (argc > 2) {
        smpCntMax = (uint16_t)atoi(argv[2]);
    }
    
    printf("[3] Initializing SV subscriber...\n");
    if (smpCntMax > 0) {
        sv_subscriber_init("", smpCntMax);
        printf("    OK (svID filter: all, smpCntMax: %u)\n\n", smpCntMax);
    } else {
        sv_subscriber_init("", 65535); /* Start with large max, auto-detect will fix it */
        printf("    OK (svID filter: all, smpCntMax: auto-detect)\n\n");
    }
    
    /* Step 5: Open interface */
    printf("[4] Opening interface for capture...\n");
    if (sv_capture_open(interfaces[selected].name) != 0) {
        printf("FATAL: %s\n", sv_capture_get_error());
        printf("    Try running as Administrator\n");
        return 1;
    }
    printf("    OK (BPF filter: ether proto 0x88ba)\n\n");
    
    /* Step 6: Start capture */
    printf("[5] Starting capture...\n");
    if (sv_capture_start() != 0) {
        printf("FATAL: Failed to start capture\n");
        sv_capture_close();
        return 1;
    }
    printf("    OK - Capture thread running\n\n");
    
    printf("============================================================\n");
    printf("  LISTENING for SV packets on: %s\n", 
           interfaces[selected].description[0] ? interfaces[selected].description : interfaces[selected].name);
    printf("  Press Ctrl+C to stop\n");
    printf("============================================================\n\n");
    
    /* Step 7: Monitor loop - print stats every second */
    uint64_t lastSvCount = 0;
    uint32_t lastFrameIndex = 0;
    int seconds = 0;
    
    while (g_running) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1000));
        seconds++;
        
        /* Get capture stats */
        SvCaptureStats stats;
        sv_capture_get_stats(&stats);
        
        /* Print periodic status */
        printf("[%4ds] Pkts: %llu | SV: %llu | Drop: %llu | Bytes: %llu",
               seconds,
               (unsigned long long)stats.packetsReceived,
               (unsigned long long)stats.packetsSV,
               (unsigned long long)stats.packetsDropped,
               (unsigned long long)stats.bytesReceived);
        
        /* Calculate rate */
        uint64_t newSv = stats.packetsSV - lastSvCount;
        printf(" | Rate: %llu pkt/s", (unsigned long long)newSv);
        lastSvCount = stats.packetsSV;
        
        printf("\n");
        
        /* Print last few decoded frames if we have new ones */
        if (stats.packetsSV > 0) {
            const char* json = sv_subscriber_get_frames_json(lastFrameIndex, 5);
            if (json) {
                /* Quick parse: just look for smpCnt values in the JSON for display */
                const char* p = json;
                int framesPrinted = 0;
                
                while ((p = strstr(p, "\"svID\":\"")) != NULL && framesPrinted < 3) {
                    /* Extract svID */
                    p += 8;
                    char svid[65] = {0};
                    int j = 0;
                    while (*p && *p != '"' && j < 64) svid[j++] = *p++;
                    
                    /* Find smpCnt */
                    const char* sc = strstr(p, "\"smpCnt\":");
                    uint32_t smpCnt = 0;
                    if (sc) {
                        sc += 9;
                        smpCnt = (uint32_t)atoi(sc);
                    }
                    
                    /* Find channelCount */
                    const char* cc = strstr(p, "\"channelCount\":");
                    uint32_t chCount = 0;
                    if (cc) {
                        cc += 15;
                        chCount = (uint32_t)atoi(cc);
                    }
                    
                    /* Find first few channel values */
                    const char* ch = strstr(p, "\"channels\":[");
                    char chvals[128] = {0};
                    if (ch) {
                        ch += 12;
                        int k = 0;
                        while (*ch && *ch != ']' && k < 100) chvals[k++] = *ch++;
                    }
                    
                    /* Find errors */
                    const char* err = strstr(p, "\"errorStr\":\"");
                    char errstr[64] = {0};
                    if (err) {
                        err += 12;
                        int k = 0;
                        while (*err && *err != '"' && k < 63) errstr[k++] = *err++;
                    }
                    
                    /* Find analysis flags */
                    const char* af = strstr(p, "\"flags\":");
                    uint32_t flags = 0;
                    if (af) {
                        af += 8;
                        flags = (uint32_t)atoi(af);
                    }
                    
                    printf("         Frame: svID=%-8s smpCnt=%-5u ch=%u vals=[%s]",
                           svid, smpCnt, chCount, chvals);
                    
                    if (flags & 0x10000) printf(" MISSING_SEQ");
                    if (flags & 0x20000) printf(" OUT_OF_ORDER");
                    if (flags & 0x40000) printf(" DUPLICATE");
                    if (strcmp(errstr, "OK") != 0 && errstr[0]) printf(" err=%s", errstr);
                    
                    printf("\n");
                    framesPrinted++;
                }
                
                /* Update frame index (rough: add SV count since last check) */
                lastFrameIndex += (uint32_t)newSv;
            }
        }
        
        /* Print analysis summary every 10 seconds */
        if (seconds % 10 == 0 && stats.packetsSV > 0) {
            const char* analysis = sv_subscriber_get_analysis_json();
            printf("\n  ---- Analysis Summary ----\n");
            printf("  %s\n", analysis);
            printf("  --------------------------\n\n");
        }
    }
    
    /* Cleanup */
    printf("\n[test] Stopping capture...\n");
    sv_capture_stop();
    sv_capture_close();
    
    /* Final summary */
    printf("\n============================================================\n");
    printf("  Capture Complete\n");
    printf("============================================================\n");
    
    const char* final_analysis = sv_subscriber_get_analysis_json();
    printf("Analysis: %s\n", final_analysis);
    
    const char* final_status = sv_subscriber_get_status_json();
    printf("Status:   %s\n\n", final_status);
    
    return 0;
}
