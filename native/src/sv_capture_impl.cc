/**
 * @file sv_capture_impl.cc
 * @brief SV Packet Capture Layer — Linux implementation using libpcap
 *
 * Implements the API declared in sv_capture.h.
 * On Linux, libpcap is linked directly (no DLL loading).
 * Capture thread feeds packets to the high-perf SPSC pipeline
 * via sv_highperf_capture_feed().
 */

#include "sv_capture.h"
#include "sv_highperf.h"

#include <pcap/pcap.h>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cstdarg>
#include <atomic>
#include <thread>
#include <chrono>

#ifdef __linux__
#include <sys/ioctl.h>
#include <net/if.h>
#include <unistd.h>
#include <ifaddrs.h>
#include <net/ethernet.h>
#include <netpacket/packet.h>
#endif

/*============================================================================
 * State
 *============================================================================*/

static char             g_error[512] = {0};
static pcap_t*          g_pcap = nullptr;
static std::atomic<bool> g_capturing{false};
static std::thread      g_capture_thread;

/* Statistics */
static std::atomic<uint64_t> g_packets_received{0};
static std::atomic<uint64_t> g_packets_sv{0};
static std::atomic<uint64_t> g_packets_dropped{0};
static std::atomic<uint64_t> g_bytes_received{0};
static uint64_t              g_capture_start_ms = 0;

/* Timestamp info */
static int  g_tstamp_type = PCAP_TSTAMP_HOST;
static bool g_nano_active = false;

/*============================================================================
 * Error helper
 *============================================================================*/

static void set_error(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_error, sizeof(g_error), fmt, ap);
    va_end(ap);
}

/*============================================================================
 * DLL Management — No-op on Linux (libpcap linked at build time)
 *============================================================================*/

extern "C" {

int sv_capture_load_dll(void) {
    /* On Linux, libpcap is a shared library linked via -lpcap.
     * No dynamic DLL loading needed. Always succeeds. */
    return 1;
}

int sv_capture_dll_loaded(void) {
    return 1;
}

/*============================================================================
 * Interface Management
 *============================================================================*/

/**
 * Resolve MAC address for a Linux network interface via getifaddrs().
 */
static int resolve_mac(const char *ifname, uint8_t mac[6]) {
#ifdef __linux__
    struct ifaddrs *ifas = nullptr;
    if (getifaddrs(&ifas) != 0) return 0;

    int found = 0;
    for (struct ifaddrs *ifa = ifas; ifa; ifa = ifa->ifa_next) {
        if (!ifa->ifa_addr) continue;
        if (ifa->ifa_addr->sa_family != AF_PACKET) continue;
        if (strcmp(ifa->ifa_name, ifname) != 0) continue;

        struct sockaddr_ll *sll = (struct sockaddr_ll *)ifa->ifa_addr;
        if (sll->sll_halen == 6) {
            memcpy(mac, sll->sll_addr, 6);
            found = 1;
        }
        break;
    }
    freeifaddrs(ifas);
    return found;
#else
    (void)ifname; (void)mac;
    return 0;
#endif
}

int sv_capture_list_interfaces(SvCaptureInterface *interfaces, int max_count) {
    if (!interfaces || max_count <= 0) return -1;

    pcap_if_t *alldevs = nullptr;
    char errbuf[PCAP_ERRBUF_SIZE];

    if (pcap_findalldevs(&alldevs, errbuf) == -1) {
        set_error("pcap_findalldevs failed: %s", errbuf);
        return -1;
    }

    int count = 0;
    for (pcap_if_t *d = alldevs; d && count < max_count; d = d->next) {
        SvCaptureInterface *iface = &interfaces[count];
        memset(iface, 0, sizeof(*iface));

        if (d->name) {
            strncpy(iface->name, d->name, SV_CAP_MAX_NAME - 1);
        }
        if (d->description) {
            strncpy(iface->description, d->description, SV_CAP_MAX_DESC - 1);
        }

        iface->has_mac = (uint8_t)resolve_mac(d->name, iface->mac);
        count++;
    }

    pcap_freealldevs(alldevs);
    return count;
}

const char* sv_capture_list_interfaces_json(void) {
    static char json_buf[16384];
    SvCaptureInterface ifaces[SV_CAP_MAX_INTERFACES];

    int count = sv_capture_list_interfaces(ifaces, SV_CAP_MAX_INTERFACES);
    if (count < 0) count = 0;

    int pos = 0;
    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos, "{\"interfaces\":[");

    for (int i = 0; i < count; i++) {
        if (i > 0) pos += snprintf(json_buf + pos, sizeof(json_buf) - pos, ",");

        char mac_str[20] = "00:00:00:00:00:00";
        if (ifaces[i].has_mac) {
            snprintf(mac_str, sizeof(mac_str), "%02X:%02X:%02X:%02X:%02X:%02X",
                     ifaces[i].mac[0], ifaces[i].mac[1], ifaces[i].mac[2],
                     ifaces[i].mac[3], ifaces[i].mac[4], ifaces[i].mac[5]);
        }

        /* Escape backslashes and quotes in name/description for JSON safety */
        char escaped_name[SV_CAP_MAX_NAME * 2];
        char escaped_desc[SV_CAP_MAX_DESC * 2];
        {
            int j = 0;
            for (const char *s = ifaces[i].name; *s && j < (int)sizeof(escaped_name) - 2; s++) {
                if (*s == '\\' || *s == '"') escaped_name[j++] = '\\';
                escaped_name[j++] = *s;
            }
            escaped_name[j] = '\0';
        }
        {
            int j = 0;
            for (const char *s = ifaces[i].description; *s && j < (int)sizeof(escaped_desc) - 2; s++) {
                if (*s == '\\' || *s == '"') escaped_desc[j++] = '\\';
                escaped_desc[j++] = *s;
            }
            escaped_desc[j] = '\0';
        }

        pos += snprintf(json_buf + pos, sizeof(json_buf) - pos,
            "{\"name\":\"%s\",\"description\":\"%s\",\"mac\":\"%s\",\"has_mac\":%s}",
            escaped_name, escaped_desc, mac_str,
            ifaces[i].has_mac ? "true" : "false");
    }

    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos, "]}");
    return json_buf;
}

/*============================================================================
 * Open / Close
 *============================================================================*/

int sv_capture_open(const char *device_name) {
    if (!device_name || device_name[0] == '\0') {
        set_error("No device name specified");
        return -1;
    }

    if (g_pcap) {
        set_error("Interface already open — close first");
        return -1;
    }

    char errbuf[PCAP_ERRBUF_SIZE];

    /* Try to create a handle with advanced options first (for timestamp control) */
    pcap_t *handle = pcap_create(device_name, errbuf);
    if (!handle) {
        set_error("pcap_create failed: %s", errbuf);
        return -1;
    }

    pcap_set_snaplen(handle, SV_CAP_SNAPLEN);
    pcap_set_promisc(handle, SV_CAP_PROMISC);
    pcap_set_timeout(handle, SV_CAP_TIMEOUT_MS);
    pcap_set_buffer_size(handle, SV_CAP_BUFFER_SIZE);

    /* Try nanosecond timestamp precision if available */
    g_nano_active = false;
#ifdef PCAP_TSTAMP_PRECISION_NANO
    if (pcap_set_tstamp_precision(handle, PCAP_TSTAMP_PRECISION_NANO) == 0) {
        g_nano_active = true;
    }
#endif

    /* Try hardware/adapter timestamps if available */
    g_tstamp_type = PCAP_TSTAMP_HOST;
#ifdef PCAP_TSTAMP_ADAPTER
    if (pcap_set_tstamp_type(handle, PCAP_TSTAMP_ADAPTER) == 0) {
        g_tstamp_type = PCAP_TSTAMP_ADAPTER;
    }
#endif

    int rc = pcap_activate(handle);
    if (rc < 0) {
        set_error("pcap_activate failed: %s", pcap_statustostr(rc));
        pcap_close(handle);
        return -1;
    }
    if (rc > 0) {
        /* Warning — capture will still work */
        printf("[capture] pcap_activate warning: %s\n", pcap_statustostr(rc));
    }

    /* Apply BPF filter: only SV EtherType 0x88BA */
    struct bpf_program fp;
    if (pcap_compile(handle, &fp, "ether proto 0x88ba", 1, PCAP_NETMASK_UNKNOWN) == -1) {
        set_error("pcap_compile failed: %s", pcap_geterr(handle));
        pcap_close(handle);
        return -1;
    }
    if (pcap_setfilter(handle, &fp) == -1) {
        set_error("pcap_setfilter failed: %s", pcap_geterr(handle));
        pcap_freecode(&fp);
        pcap_close(handle);
        return -1;
    }
    pcap_freecode(&fp);

    g_pcap = handle;
    printf("[capture] Opened interface: %s (nano=%d, tstamp_type=%d)\n",
           device_name, g_nano_active ? 1 : 0, g_tstamp_type);
    return 0;
}

void sv_capture_close(void) {
    if (g_capturing.load()) {
        sv_capture_stop();
    }
    if (g_pcap) {
        pcap_close(g_pcap);
        g_pcap = nullptr;
        printf("[capture] Interface closed\n");
    }
}

int sv_capture_is_open(void) {
    return g_pcap ? 1 : 0;
}

/*============================================================================
 * Capture Thread
 *============================================================================*/

static void capture_thread_func() {
    printf("[capture] Capture thread started\n");

    while (g_capturing.load(std::memory_order_relaxed)) {
        struct pcap_pkthdr *header = nullptr;
        const u_char *data = nullptr;

        int rc = pcap_next_ex(g_pcap, &header, &data);

        if (rc == 1) {
            /* Packet received */
            g_packets_received.fetch_add(1, std::memory_order_relaxed);
            g_bytes_received.fetch_add(header->caplen, std::memory_order_relaxed);

            /* Convert pcap timestamp to microseconds */
            uint64_t ts_us;
            if (g_nano_active) {
                /* tv_usec field is actually nanoseconds */
                ts_us = (uint64_t)header->ts.tv_sec * 1000000ULL
                      + (uint64_t)header->ts.tv_usec / 1000ULL;
            } else {
                ts_us = (uint64_t)header->ts.tv_sec * 1000000ULL
                      + (uint64_t)header->ts.tv_usec;
            }

            /* Feed to high-perf pipeline (inline decode + SPSC push) */
            int feed_rc = sv_highperf_capture_feed(data, header->caplen, ts_us);
            if (feed_rc == 0 || feed_rc == -2) {
                /* 0 = OK, -2 = SPSC full (counted by highperf) */
                g_packets_sv.fetch_add(1, std::memory_order_relaxed);
            }
            /* feed_rc == -1 means decode error (not SV / malformed) — skip */

        } else if (rc == 0) {
            /* Timeout — no packet available, loop continues */
        } else if (rc == -1) {
            /* Error */
            printf("[capture] pcap_next_ex error: %s\n", pcap_geterr(g_pcap));
        } else if (rc == -2) {
            /* End of savefile (shouldn't happen for live capture) */
            break;
        }
    }

    printf("[capture] Capture thread stopped\n");
}

/*============================================================================
 * Capture Control
 *============================================================================*/

int sv_capture_start(void) {
    if (!g_pcap) {
        set_error("No interface open");
        return -1;
    }
    if (g_capturing.load()) {
        set_error("Already capturing");
        return -1;
    }

    /* Reset stats */
    g_packets_received.store(0, std::memory_order_relaxed);
    g_packets_sv.store(0, std::memory_order_relaxed);
    g_packets_dropped.store(0, std::memory_order_relaxed);
    g_bytes_received.store(0, std::memory_order_relaxed);
    g_capture_start_ms = (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();

    /* Initialize and start the high-perf pipeline */
    sv_highperf_init();
    sv_highperf_start_drain();

    /* Start capture thread */
    g_capturing.store(true, std::memory_order_release);
    g_capture_thread = std::thread(capture_thread_func);

    printf("[capture] Capture started\n");
    return 0;
}

int sv_capture_stop(void) {
    if (!g_capturing.load()) {
        set_error("Not capturing");
        return -1;
    }

    /* Signal capture thread to stop */
    g_capturing.store(false, std::memory_order_release);

    /* Break pcap_next_ex out of its blocking wait */
    if (g_pcap) {
        pcap_breakloop(g_pcap);
    }

    if (g_capture_thread.joinable()) {
        g_capture_thread.join();
    }

    /* Stop drain thread (processes remaining SPSC data) */
    sv_highperf_stop_drain();

    /* Collect final kernel drop stats */
    if (g_pcap) {
        struct pcap_stat ps;
        if (pcap_stats(g_pcap, &ps) == 0) {
            g_packets_dropped.store(ps.ps_drop, std::memory_order_relaxed);
        }
    }

    printf("[capture] Capture stopped\n");
    return 0;
}

int sv_capture_is_running(void) {
    return g_capturing.load(std::memory_order_relaxed) ? 1 : 0;
}

/*============================================================================
 * Statistics
 *============================================================================*/

void sv_capture_get_stats(SvCaptureStats *stats) {
    if (!stats) return;

    uint64_t now_ms = (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();

    stats->packetsReceived = g_packets_received.load(std::memory_order_relaxed);
    stats->packetsSV = g_packets_sv.load(std::memory_order_relaxed);
    stats->packetsDropped = g_packets_dropped.load(std::memory_order_relaxed);
    stats->bytesReceived = g_bytes_received.load(std::memory_order_relaxed);
    stats->captureStartTime = g_capture_start_ms;
    stats->captureElapsedMs = g_capturing.load() ? (now_ms - g_capture_start_ms) : 0;
    stats->isCapturing = g_capturing.load() ? 1 : 0;

    /* Update kernel drop stats while capturing */
    if (g_pcap && g_capturing.load()) {
        struct pcap_stat ps;
        if (pcap_stats(g_pcap, &ps) == 0) {
            stats->packetsDropped = ps.ps_drop;
            g_packets_dropped.store(ps.ps_drop, std::memory_order_relaxed);
        }
    }
}

const char* sv_capture_get_stats_json(void) {
    static char json_buf[1024];
    SvCaptureStats stats;
    sv_capture_get_stats(&stats);

    /* Also include high-perf pipeline stats */
    SvHighPerfStats hp;
    sv_highperf_get_stats(&hp);

    snprintf(json_buf, sizeof(json_buf),
        "{"
        "\"packetsReceived\":%llu,"
        "\"packetsSV\":%llu,"
        "\"packetsDropped\":%llu,"
        "\"bytesReceived\":%llu,"
        "\"captureElapsedMs\":%llu,"
        "\"isCapturing\":%s,"
        "\"spscWritten\":%llu,"
        "\"spscDropped\":%llu,"
        "\"spscReadLag\":%llu,"
        "\"drainTotal\":%llu,"
        "\"captureRatePps\":%.1f,"
        "\"throughputMbps\":%.2f"
        "}",
        (unsigned long long)stats.packetsReceived,
        (unsigned long long)stats.packetsSV,
        (unsigned long long)stats.packetsDropped,
        (unsigned long long)stats.bytesReceived,
        (unsigned long long)stats.captureElapsedMs,
        stats.isCapturing ? "true" : "false",
        (unsigned long long)hp.spscWritten,
        (unsigned long long)hp.spscDropped,
        (unsigned long long)hp.spscReadLag,
        (unsigned long long)hp.drainTotal,
        hp.captureRatePps,
        hp.throughputMbps);

    return json_buf;
}

/*============================================================================
 * Error Handling
 *============================================================================*/

const char* sv_capture_get_error(void) {
    return g_error;
}

/*============================================================================
 * Timestamp Info
 *============================================================================*/

const char* sv_capture_get_timestamp_info_json(void) {
    static char json_buf[256];

    const char *type_name;
    bool is_hw = false;

    switch (g_tstamp_type) {
#ifdef PCAP_TSTAMP_ADAPTER
        case PCAP_TSTAMP_ADAPTER:
            type_name = "adapter";
            is_hw = true;
            break;
#endif
#ifdef PCAP_TSTAMP_ADAPTER_UNSYNCED
        case PCAP_TSTAMP_ADAPTER_UNSYNCED:
            type_name = "adapter_unsynced";
            is_hw = true;
            break;
#endif
        case PCAP_TSTAMP_HOST:
        default:
            type_name = "host";
            is_hw = false;
            break;
    }

    snprintf(json_buf, sizeof(json_buf),
        "{\"tstampType\":%d,\"tstampTypeName\":\"%s\","
        "\"tstampPrecision\":%d,\"nanoActive\":%s,\"isHardware\":%s}",
        g_tstamp_type,
        type_name,
        g_nano_active ? 1 : 0,
        g_nano_active ? "true" : "false",
        is_hw ? "true" : "false");

    return json_buf;
}

} /* extern "C" */
