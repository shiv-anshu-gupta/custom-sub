/**
 * @file components/config.js
 * @brief Capture configuration bar component
 *
 * Contains: svID filter input, sample rate selector (pre-capture) /
 * detected smpCntMax display (during capture), live capture packet counters,
 * instantaneous data-rate & pps, and SPSC pipeline health.
 *
 * smpCntMax semantics (IEC 61850-9-2):
 *   The protocol's smpCnt field is a 16-bit counter that wraps at smpCntMax.
 *   Two counting modes exist:
 *     Per-cycle (9-2LE):  smpCnt 0–79  → 80 samples/cycle  → rate = 80 × freq
 *     Per-second:         smpCnt 0–3999 → 4000 samples/sec → rate = 4000 Hz
 *   The subscriber cannot know the power frequency, so it displays the
 *   detected smpCntMax and infers the likely rate for known standard values.
 *
 * Rate Display:
 *   During capture, instantaneous rates are computed client-side from
 *   consecutive poll deltas (packetsSV, bytesReceived) — NOT from the
 *   cumulative averages returned by C++.
 */

const SVConfig = {

    /** @private Cached DOM references — set in init() */
    _dom: null,
    /** @private Previous display values — skip redundant DOM writes */
    _prev: {},

    // ── Delta tracking for instantaneous rate calculation ──
    /** @private Previous poll timestamp (ms) */
    _lastPollTime: 0,
    /** @private Previous packetsSV value for delta */
    _lastPacketsSV: 0,
    /** @private Previous bytesReceived value for delta */
    _lastBytesReceived: 0,

    /**
     * Standard IEC 61850 smpCntMax → human-readable label mapping.
     *
     * Per-cycle (9-2LE): smpCnt wraps per power cycle.
     *   The actual Hz rate depends on system frequency (50 or 60 Hz).
     *
     * Per-second: smpCnt wraps once per second. Rate = smpCntMax + 1.
     */
    _KNOWN_RATES: {
        79:    { label: '80/cycle',    desc: '4,000 Hz @50 · 4,800 Hz @60' },
        255:   { label: '256/cycle',   desc: '12,800 Hz @50 · 15,360 Hz @60' },
        3999:  { label: '4,000 smp/s', desc: '80/cycle × 50 Hz' },
        4799:  { label: '4,800 smp/s', desc: '80/cycle × 60 Hz' },
        11999: { label: '12,000 smp/s', desc: '240/cycle × 50 Hz' },
        14399: { label: '14,400 smp/s', desc: '240/cycle × 60 Hz' },
    },

    /**
     * Returns the capture config bar HTML template
     * @returns {string} HTML string
     */
    getTemplate() {
        return `
            <div class="capture-config" id="captureConfig">
                <div class="config-row">
                    <div class="config-group">
                        <label>svID Filter:</label>
                        <input type="text" id="cfgSvID" class="input-field"
                               placeholder="Leave empty for all streams" value="">
                    </div>
                    <div class="config-group">
                        <label id="cfgSampleRateLabel">Sample Rate:</label>
                        <!-- Pre-capture: dropdown selector (smpCntMax values) -->
                        <select id="cfgSampleRate" class="input-field">
                            <option value="0" selected>Auto-detect</option>
                            <option value="3999">4,000 smp/s (80/cycle × 50 Hz)</option>
                            <option value="4799">4,800 smp/s (80/cycle × 60 Hz)</option>
                            <option value="11999">12,000 smp/s (240/cycle × 50 Hz)</option>
                            <option value="14399">14,400 smp/s (240/cycle × 60 Hz)</option>
                            <option value="79">80/cycle (IEC 9-2LE)</option>
                            <option value="255">256/cycle (IEC 9-2LE)</option>
                        </select>
                        <!-- During capture: shows detected smpCntMax + inferred rate -->
                        <span class="stat-inline" id="cfgDetectedRate" style="display:none">\u2014</span>
                        <span class="stat-label-inline" id="cfgDetectedRateHint" style="display:none"></span>
                    </div>
                    <div class="config-group">
                        <label>Packets:</label>
                        <span class="stat-inline" id="statCapturedPkts">0</span>
                        <span class="stat-label-inline">SV:</span>
                        <span class="stat-inline" id="statSvPkts">0</span>
                        <span class="stat-label-inline">Drop:</span>
                        <span class="stat-inline" id="statDropPkts">0</span>
                    </div>
                    <div class="config-group">
                        <label>Data Rate:</label>
                        <span class="stat-inline" id="statDataRate">0.0</span>
                        <span class="stat-label-inline" id="statDataRateUnit">Mbps</span>
                        <span class="stat-label-inline">|</span>
                        <span class="stat-inline" id="statCapRate">0</span>
                        <span class="stat-label-inline">pps</span>
                    </div>
                    <div class="config-group">
                        <label>SPSC:</label>
                        <span class="stat-inline" id="statSpscLag">0</span>
                        <span class="stat-label-inline">lag</span>
                        <span class="stat-label-inline">|</span>
                        <span class="stat-inline" id="statSpscDrop">0</span>
                        <span class="stat-label-inline">drop</span>
                    </div>
                    <div class="config-group" id="tstampBadgeGroup" style="display:none">
                        <span class="badge" id="tstampBadge">—</span>
                    </div>
                    <div class="config-group" id="npcapApiBadgeGroup" style="display:none">
                        <label>TX Mode:</label>
                        <span class="badge" id="npcapApiBadge">—</span>
                    </div>
                </div>
                <!-- Timing Configuration Row (Duration & Repeat) -->
                <div class="config-row config-row-timing" id="configTimingRow">
                    ${SVTiming.getConfigTemplate()}
                </div>
            </div>
        `;
    },

    /**
     * Initialize — cache DOM references for all config bar elements
     */
    init() {
        this._dom = {
            svID:              document.getElementById('cfgSvID'),
            sampleRate:        document.getElementById('cfgSampleRate'),
            sampleRateLabel:   document.getElementById('cfgSampleRateLabel'),
            detectedRate:      document.getElementById('cfgDetectedRate'),
            detectedRateHint:  document.getElementById('cfgDetectedRateHint'),
            capturedPkts:      document.getElementById('statCapturedPkts'),
            svPkts:            document.getElementById('statSvPkts'),
            dropPkts:          document.getElementById('statDropPkts'),
            dataRate:          document.getElementById('statDataRate'),
            dataRateUnit:      document.getElementById('statDataRateUnit'),
            capRate:           document.getElementById('statCapRate'),
            spscLag:           document.getElementById('statSpscLag'),
            spscDrop:          document.getElementById('statSpscDrop'),
            tstampBadge:       document.getElementById('tstampBadge'),
            tstampBadgeGroup:  document.getElementById('tstampBadgeGroup'),
            npcapApiBadge:     document.getElementById('npcapApiBadge'),
            npcapApiBadgeGroup: document.getElementById('npcapApiBadgeGroup'),
        };
        this._prev = {};
    },

    /**
     * Get current configuration values from UI inputs
     * @returns {{ svID: string, smpCntMax: number }}
     */
    getValues() {
        const raw = parseInt(document.getElementById('cfgSampleRate').value);
        return {
            svID: document.getElementById('cfgSvID').value.trim(),
            smpCntMax: isNaN(raw) ? 3999 : raw   // 0 = auto-detect (valid)
        };
    },

    /**
     * Enable/disable config inputs and swap dropdown ↔ detected-rate display.
     *
     * Pre-capture:  dropdown visible, detected-rate hidden
     * During capture: dropdown hidden, detected-rate shown (populated by update())
     *
     * @param {boolean} disabled - true when capture starts, false when it stops
     */
    setDisabled(disabled) {
        const d = this._dom;
        if (!d) return;

        d.svID.disabled = disabled;
        d.sampleRate.disabled = disabled;

        if (disabled) {
            // Capture active → hide dropdown, show detected smpCntMax
            d.sampleRate.style.display = 'none';
            d.sampleRateLabel.textContent = 'smpCnt Range:';
            d.detectedRate.style.display = '';
            d.detectedRateHint.style.display = '';
        } else {
            // Capture stopped → show dropdown, hide detected display
            d.sampleRate.style.display = '';
            d.sampleRateLabel.textContent = 'Sample Rate:';
            d.detectedRate.style.display = 'none';
            d.detectedRateHint.style.display = 'none';
        }
    },

    // ====================================================================
    // Number formatting helpers (locale-independent, human-readable)
    // ====================================================================

    /**
     * Format a large number with K/M suffix for compact display
     * e.g. 234567 → "235K", 1234567 → "1.2M", 850 → "850"
     * @param {number} n
     * @returns {string}
     */
    _fmtCompact(n) {
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 10e3) return Math.round(n / 1e3) + 'K';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return Math.round(n).toString();
    },

    /**
     * Format a number with standard Western grouping (comma every 3 digits)
     * Avoids Indian-locale "2,33,774" formatting from toLocaleString()
     * @param {number} n
     * @returns {string}
     */
    _fmtGrouped(n) {
        return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    },

    /**
     * Compute throughput display value and unit, auto-scaling Mbps ↔ Gbps
     * @param {number} mbps - throughput in Megabits/sec
     * @returns {{ value: string, unit: string }}
     */
    _fmtThroughput(mbps) {
        if (mbps >= 1000) return { value: (mbps / 1000).toFixed(2), unit: 'Gbps' };
        if (mbps >= 100)  return { value: mbps.toFixed(0),          unit: 'Mbps' };
        if (mbps >= 10)   return { value: mbps.toFixed(1),          unit: 'Mbps' };
        return { value: mbps.toFixed(2), unit: 'Mbps' };
    },

    /**
     * Build a human-readable string for a detected smpCntMax value.
     *
     * For known IEC 61850 standard values, return the standard label + description.
     * For non-standard values, infer whether it's per-cycle or per-second counting.
     *
     * @param {number} smpCntMax - detected maximum sample counter value
     * @returns {{ rateStr: string, hintStr: string }}
     */
    _formatSmpCntMax(smpCntMax) {
        // Known standard value?
        const known = this._KNOWN_RATES[smpCntMax];
        if (known) {
            return { rateStr: known.label, hintStr: known.desc };
        }

        const range = smpCntMax + 1;

        // Heuristic: values < 1000 are likely per-cycle counting
        if (range <= 1000) {
            return {
                rateStr: `${this._fmtGrouped(range)}/cycle`,
                hintStr: `smpCnt 0\u2013${this._fmtGrouped(smpCntMax)}`
            };
        }

        // Larger values: likely per-second counting
        return {
            rateStr: `${this._fmtGrouped(range)} smp/s`,
            hintStr: `smpCnt 0\u2013${this._fmtGrouped(smpCntMax)}`
        };
    },

    // ====================================================================
    // Live update — called every poll cycle from app.js
    // ====================================================================

    /**
     * Update config bar with live backend data.
     *
     * Instantaneous rates are computed here from consecutive poll deltas,
     * NOT from the C++ cumulative averages. This gives a real-time "current"
     * throughput and pps responsive to traffic changes.
     *
     * @param {Object} analysis      - Analysis summary (smpCntMax, etc.)
     * @param {Object} captureStats  - Capture stats (packetsSV, bytesReceived, etc.)
     */
    update(analysis, captureStats) {
        const d = this._dom;
        const p = this._prev;
        if (!d) return;

        // ── Detected smpCntMax (from analysis.smpCntMax) ──
        if (analysis && analysis.smpCntMax !== undefined) {
            const max = analysis.smpCntMax;
            let rateStr, hintStr;

            if (max > 0 && max < 65535) {
                const fmt = this._formatSmpCntMax(max);
                rateStr = fmt.rateStr;
                hintStr = fmt.hintStr;
            } else if (max === 65535) {
                rateStr = 'Detecting\u2026';
                hintStr = '';
            } else {
                rateStr = '\u2014';
                hintStr = '';
            }

            if (p.detRate !== rateStr && d.detectedRate) {
                d.detectedRate.textContent = rateStr;
                p.detRate = rateStr;
            }
            if (p.detHint !== hintStr && d.detectedRateHint) {
                d.detectedRateHint.textContent = hintStr;
                p.detHint = hintStr;
            }
        }

        // ── Capture statistics ──
        if (!captureStats) return;

        const now = Date.now();

        // ── Packet counters (grouped numbers) ──
        const setPkts = (domKey, value) => {
            const formatted = this._fmtGrouped(value || 0);
            if (p[domKey] !== formatted && d[domKey]) {
                d[domKey].textContent = formatted;
                p[domKey] = formatted;
            }
        };

        setPkts('capturedPkts', captureStats.packetsReceived);
        setPkts('svPkts',       captureStats.packetsSV);

        // Dropped packets — highlight in red when > 0
        const dropVal = this._fmtGrouped(captureStats.packetsDropped || 0);
        if (p.dropPkts !== dropVal && d.dropPkts) {
            d.dropPkts.textContent = dropVal;
            d.dropPkts.style.color = captureStats.packetsDropped > 0 ? 'var(--accent-red)' : '';
            p.dropPkts = dropVal;
        }

        // ── SPSC pipeline health ──
        const lagVal = this._fmtGrouped(captureStats.spscReadLag || 0);
        if (p.spscLag !== lagVal && d.spscLag) {
            d.spscLag.textContent = lagVal;
            p.spscLag = lagVal;
        }

        const spscDropVal = this._fmtGrouped(captureStats.spscDropped || 0);
        if (p.spscDrop !== spscDropVal && d.spscDrop) {
            d.spscDrop.textContent = spscDropVal;
            d.spscDrop.style.color = captureStats.spscDropped > 0 ? 'var(--accent-red)' : '';
            p.spscDrop = spscDropVal;
        }

        // ── Instantaneous Data Rate & PPS (computed from poll deltas) ──
        if (this._lastPollTime > 0) {
            const dtSec = (now - this._lastPollTime) / 1000;
            if (dtSec > 0.1) {
                // Instantaneous packets-per-second
                const dPkts = (captureStats.packetsSV || 0) - this._lastPacketsSV;
                const pps   = dPkts / dtSec;
                const ppsStr = this._fmtCompact(Math.max(0, pps));
                if (p.capRate !== ppsStr && d.capRate) {
                    d.capRate.textContent = ppsStr;
                    p.capRate = ppsStr;
                }

                // Instantaneous throughput (bytes → bits → Mbps)
                const dBytes = (captureStats.bytesReceived || 0) - this._lastBytesReceived;
                const mbps   = (dBytes * 8) / (dtSec * 1e6);
                const tput   = this._fmtThroughput(Math.max(0, mbps));
                if (p.dataRate !== tput.value && d.dataRate) {
                    d.dataRate.textContent = tput.value;
                    p.dataRate = tput.value;
                }
                if (p.dataRateUnit !== tput.unit && d.dataRateUnit) {
                    d.dataRateUnit.textContent = tput.unit;
                    p.dataRateUnit = tput.unit;
                }
            }
        }

        this._lastPollTime      = now;
        this._lastPacketsSV     = captureStats.packetsSV || 0;
        this._lastBytesReceived = captureStats.bytesReceived || 0;
    },

    /**
     * Update timestamp precision badge from backend timestampInfo.
     * GREEN badge = hardware adapter timestamp (nanosecond precision)
     * YELLOW badge = host/system timestamp (lower precision)
     *
     * @param {Object} tsInfo - timestampInfo from poll_data response
     */
    updateTimestampBadge(tsInfo) {
        const d = this._dom;
        if (!d || !d.tstampBadge || !d.tstampBadgeGroup) return;
        if (!tsInfo) return;

        const p = this._prev;
        const key = `${tsInfo.tstampType}_${tsInfo.nanoActive}`;
        if (p.tstampKey === key) return; // No change
        p.tstampKey = key;

        d.tstampBadgeGroup.style.display = '';

        if (tsInfo.isHardware) {
            // Hardware adapter timestamp — GREEN
            d.tstampBadge.textContent = '\u23F1 Precision Time Available';
            d.tstampBadge.className = 'badge badge-ok';
            d.tstampBadge.title = 'Hardware NIC timestamp active (adapter clock, nanosecond precision)';
        } else if (tsInfo.tstampType === 2) {
            // HOST_HIPREC — YELLOW (better than default, but not hardware)
            d.tstampBadge.textContent = '\u23F1 System Time (High-Res)';
            d.tstampBadge.className = 'badge badge-warn';
            d.tstampBadge.title = 'OS high-precision clock active (microsecond resolution)';
        } else {
            // Default HOST or fallback — YELLOW
            d.tstampBadge.textContent = '\u23F1 System Time (Lower Precision)';
            d.tstampBadge.className = 'badge badge-warn';
            d.tstampBadge.title = 'Default OS clock (~1ms resolution). Hardware timestamps not available on this adapter.';
        }
    },

    /**
     * Update npcap TX API mode badge based on duplicate timestamp analysis.
     * Infers whether publisher is using sendQueue or sendPacket from the
     * duplicate timestamp pattern:
     *   - sendQueue: batches packets → many share same timestamp (dupTsMaxGroup >> 1)
     *   - sendPacket: sends individually → unique timestamps (dupTsMaxGroup = 0 or 1)
     *
     * @param {Object} analysis - Analysis data from poll_data response
     */
    updateNpcapApiBadge(analysis) {
        const d = this._dom;
        if (!d || !d.npcapApiBadge || !d.npcapApiBadgeGroup) return;
        if (!analysis || analysis.totalFrames === undefined) return;

        // Only show after enough frames to make a determination
        if (analysis.totalFrames < 100) return;

        const p = this._prev;
        const maxGrp = analysis.dupTsMaxGroup || 0;
        const dupTotal = analysis.dupTsTotal || 0;
        const totalFrames = analysis.totalFrames || 1;
        const dupRatio = dupTotal / totalFrames;

        let mode, badgeClass, tooltip;

        if (maxGrp > 2 && dupRatio > 0.3) {
            // High duplicate ratio + large groups = sendQueue batching
            mode = 'sendQueue';
            badgeClass = 'badge badge-info';
            tooltip = `Detected sendQueue batching: ${dupRatio.toFixed(0)*100}% frames share timestamps, max group=${maxGrp}`;
        } else if (maxGrp <= 2 && dupRatio < 0.1) {
            // Very few duplicates = sendPacket (individual sends)
            mode = 'sendPacket';
            badgeClass = 'badge badge-ok';
            tooltip = `Detected sendPacket mode: ${(dupRatio*100).toFixed(1)}% dup timestamps, unique per packet`;
        } else {
            // Ambiguous or mixed
            mode = 'Mixed/Unknown';
            badgeClass = 'badge badge-warn';
            tooltip = `Inconclusive: ${(dupRatio*100).toFixed(1)}% dup timestamps, maxGroup=${maxGrp}`;
        }

        if (p.npcapApi !== mode) {
            d.npcapApiBadgeGroup.style.display = '';
            d.npcapApiBadge.textContent = mode;
            d.npcapApiBadge.className = badgeClass;
            d.npcapApiBadge.title = tooltip;
            p.npcapApi = mode;
        }
    },

    /**
     * Reset config bar display values and delta-tracking state to defaults
     */
    resetDisplay() {
        this._prev = {};
        this._lastPollTime = 0;
        this._lastPacketsSV = 0;
        this._lastBytesReceived = 0;

        if (!this._dom) return;
        const d = this._dom;
        if (d.detectedRate)     d.detectedRate.textContent = '\u2014';
        if (d.detectedRateHint) d.detectedRateHint.textContent = '';
        if (d.capturedPkts)     d.capturedPkts.textContent = '0';
        if (d.svPkts)           d.svPkts.textContent = '0';
        if (d.dropPkts)         { d.dropPkts.textContent = '0'; d.dropPkts.style.color = ''; }
        if (d.dataRate)         d.dataRate.textContent = '0.0';
        if (d.dataRateUnit)     d.dataRateUnit.textContent = 'Mbps';
        if (d.capRate)          d.capRate.textContent = '0';
        if (d.spscLag)          d.spscLag.textContent = '0';
        if (d.spscDrop)         { d.spscDrop.textContent = '0'; d.spscDrop.style.color = ''; }
        if (d.tstampBadge)      { d.tstampBadge.textContent = '\u2014'; d.tstampBadge.className = 'badge'; }
        if (d.tstampBadgeGroup) d.tstampBadgeGroup.style.display = 'none';
        if (d.npcapApiBadge)    { d.npcapApiBadge.textContent = '\u2014'; d.npcapApiBadge.className = 'badge'; }
        if (d.npcapApiBadgeGroup) d.npcapApiBadgeGroup.style.display = 'none';
    }
};
