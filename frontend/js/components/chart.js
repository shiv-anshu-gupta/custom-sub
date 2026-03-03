/**
 * @file components/chart.js
 * @brief Live SV Waveform Chart — uPlot oscilloscope for IEC 61850-9-2
 *
 * Professional oscilloscope-style waveform display:
 *   - Smooth scrolling (no flicker/blink)
 *   - Stable Y-axis (auto-ranges once, then locks to prevent bounce)
 *   - requestAnimationFrame batched rendering
 *   - Time-based X-axis from unwrapped smpCnt (IEC 61850 standard)
 *
 * Data pipeline:
 *   C++ ring buffer → poll_data JSON → app.js → SVChart.addFrames()
 *
 * Each frame has: { smpCnt, channels: [int32,...], timestamp }
 *
 * Three display modes:
 *   1. Continuous — scrolling window, always appending
 *   2. 60-cycle  — fixed 60-cycle window, refreshed every ~1s
 *   3. N-cycle   — configurable N-cycle window, refreshed every 60/N s
 *
 * Hold button freezes the display (data still buffers in background).
 */

const SVChart = {

    // ── uPlot instance ──
    _plot: null,
    _initialized: false,
    _resizeObs: null,

    // ── Display state ──
    _held: false,           // Freeze display

    // ── Mode: 'continuous' | 'fixed60' | 'fixedN' ──
    _mode: 'continuous',
    _nCycles: 60,
    _nominalFreq: 50,       // 50 Hz or 60 Hz
    _smpCntMax: 3999,       // Auto-updated from backend analysis

    // ── Derived (recomputed when params change) ──
    _samplesPerCycle: 80,   // (smpCntMax+1) / nominalFreq
    _windowSamples: 4800,   // nCycles * samplesPerCycle
    _refreshMs: 1000,       // How often to update in fixed modes

    // ── smpCnt unwrap → relative time (IEC 61850 professional X-axis) ──
    // smpCnt wraps around every cycle (e.g., 0→3999→0→3999).
    // We "unwrap" the rollover to get a monotonic counter, then convert
    // to relative time in seconds: time = unwrapped / sampleRate.
    _smpCntOffset: 0,       // Accumulated offset from detected rollovers
    _lastSmpCnt: -1,        // Previous frame's smpCnt (for rollover detection)

    // ── Data buffers ──
    // Incoming samples accumulate here between refreshes
    _buf: { x: [], ch: [] },   // ch = array of arrays, one per channel
    // Currently displayed data (fed to uPlot)
    _plotX: [],
    _plotCh: [],               // array of arrays
    _channelCount: 0,
    _maxSamples: 20000,        // Cap for continuous mode
    _lastRefresh: 0,

    // ── Smooth rendering (anti-flicker) ──
    _rafPending: false,        // requestAnimationFrame guard
    _dataDirty: false,         // New data waiting to be rendered
    _lastRenderTs: 0,          // Timestamp of last actual render (throttle)
    _renderIntervalMs: 150,    // Minimum ms between renders (~7fps — smooth enough, no flicker)
    _yScaleLocked: false,      // Y-axis locked after stabilization
    _yScaleV: null,            // Locked Y scale: { min, max }
    _yScaleI: null,            // (unused, kept for compat)
    _yStableCount: 0,          // Samples seen before locking Y
    _yTrackMin: Infinity,      // Running min across all channels
    _yTrackMax: -Infinity,     // Running max across all channels

    // ── Channel appearance ──
    _colors: [
        '#f85149', '#3fb950', '#58a6ff', '#d29922',   // Ch0  Ch1  Ch2  Ch3
        '#bc8cff', '#39d2c0', '#f0883e', '#8b949e',   // Ch4  Ch5  Ch6  Ch7
        '#e3b341', '#f778ba', '#a5d6ff', '#7ee787',   // Ch8  Ch9  Ch10 Ch11
        '#ffa657', '#d2a8ff', '#56d4dd', '#ff7b72',   // Ch12 Ch13 Ch14 Ch15
        '#79c0ff', '#b1bac4', '#ffd33d', '#ff9bce',   // Ch16 Ch17 Ch18 Ch19
    ],
    _names: [
        'Ch0', 'Ch1', 'Ch2', 'Ch3', 'Ch4', 'Ch5', 'Ch6', 'Ch7',
        'Ch8', 'Ch9', 'Ch10', 'Ch11', 'Ch12', 'Ch13', 'Ch14', 'Ch15',
        'Ch16', 'Ch17', 'Ch18', 'Ch19',
    ],
    _visible: [],  // bool per channel

    // ====================================================================
    // TEMPLATE
    // ====================================================================

    getTemplate() {
        return `
        <div class="chart-panel" id="chartPanel">
            <!-- Mode tabs -->
            <div class="chart-mode-tabs">
                <button class="chart-mode-tab active" data-mode="continuous">① Continuous</button>
                <button class="chart-mode-tab" data-mode="fixed60">② 60 Cycles (1s refresh)</button>
                <button class="chart-mode-tab" data-mode="fixedN">③ N Cycles (60/N s refresh)</button>

                <div class="chart-ctrl-group" id="chartNGroup" style="display:none">
                    <label class="chart-ctrl-label">N =</label>
                    <input id="chartN" type="number" class="input-field chart-num-input"
                           value="10" min="1" max="600">
                </div>

                <div class="chart-ctrl-group">
                    <label class="chart-ctrl-label">Freq</label>
                    <select id="chartFreq" class="input-field chart-select-sm">
                        <option value="50" selected>50 Hz</option>
                        <option value="60">60 Hz</option>
                    </select>
                </div>

                <div class="chart-ctrl-sep"></div>
                <button class="btn btn-sm chart-btn-hold" id="chartHold">⏸ Hold</button>
                <button class="btn btn-sm chart-btn-hold" id="chartAutoScale" title="Unlock Y-axis and auto-range again">🔓 Auto Y</button>
                <div class="chart-ctrl-sep"></div>
                <div class="chart-ch-toggles" id="chartToggles"></div>
                <span class="chart-status-text" id="chartStatus">Waiting for data…</span>
            </div>
            <!-- Plot area -->
            <div class="chart-container" id="chartContainer">
                <div class="chart-placeholder" id="chartPlaceholder">
                    <div class="chart-placeholder-icon">📈</div>
                    <div>Start capturing to see SV waveforms</div>
                </div>
            </div>
        </div>`;
    },

    // ====================================================================
    // INIT — bind events once
    // ====================================================================

    init() {
        if (this._initialized) return;

        // Mode sub-tab buttons
        document.querySelectorAll('.chart-mode-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.chart-mode-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._setMode(btn.dataset.mode);
            });
        });

        document.getElementById('chartN')
            .addEventListener('change', e => {
                this._nCycles = Math.max(1, Math.min(600, +e.target.value || 60));
                this._recompute();
            });

        document.getElementById('chartFreq')
            .addEventListener('change', e => {
                this._nominalFreq = +e.target.value;
                this._recompute();
            });

        document.getElementById('chartHold')
            .addEventListener('click', () => this._toggleHold());

        document.getElementById('chartAutoScale')
            .addEventListener('click', () => this._unlockYScale());

        // Start in continuous mode (Option 1)
        this._mode = 'continuous';
        this._recompute();
        this._initialized = true;
        console.log('[chart] init done');
    },

    // ====================================================================
    // PUBLIC: addFrames  — called from app.js renderUI()
    // ====================================================================

    /**
     * Feed new decoded frames into the chart.
     * @param {Array} frames  — raw frames from poll_data (same objects table uses)
     * @param {Object|null} analysis — analysis summary (contains smpCntMax)
     */
    addFrames(frames, analysis) {
        if (!frames || !frames.length) return;

        // ── HOLD guard — must be FIRST ──
        // When held, touch absolutely nothing. The display is frozen.
        // If this check were later (after Y-tracking / smpCnt unwrap),
        // setScale() or data-clearing side-effects would redraw the grid
        // without re-rendering series paths, causing grid-only flicker.
        if (this._held) return;

        // One-time channel setup on first data
        if (this._channelCount === 0 && frames[0].channels) {
            this._setupChannels(frames[0].channels.length);
        }

        // Auto-update smpCntMax from backend
        if (analysis && analysis.smpCntMax && analysis.smpCntMax !== this._smpCntMax) {
            this._smpCntMax = analysis.smpCntMax;
            this._recompute();
            // smpCntMax changed → sampleRate changed → old unwrap offset is invalid.
            // Reset timeline so new data uses the correct rate from t=0.
            this._smpCntOffset = 0;
            this._lastSmpCnt = -1;
            this._plotX = [];
            for (let i = 0; i < this._channelCount; i++) this._plotCh[i] = [];
        }

        // Push every sample into the accumulation buffer.
        // X-axis uses unwrapped smpCnt → relative time (seconds).
        // This ensures monotonically increasing X values (no diagonal lines
        // from smpCnt rollover) and gives engineers a real time axis.
        const sampleRate = this._smpCntMax + 1; // e.g., 4000 Hz or 4800 Hz
        for (const f of frames) {
            if (!f.channels) continue;

            // Detect smpCnt rollover (e.g., 3999 → 0)
            if (this._lastSmpCnt >= 0 && f.smpCnt < this._lastSmpCnt
                && (this._lastSmpCnt - f.smpCnt) > (sampleRate / 2)) {
                this._smpCntOffset += sampleRate;
            }
            this._lastSmpCnt = f.smpCnt;

            // Convert to relative time in seconds
            const timeSec = (f.smpCnt + this._smpCntOffset) / sampleRate;
            this._buf.x.push(timeSec);

            for (let i = 0; i < this._channelCount; i++) {
                this._buf.ch[i].push(f.channels[i] ?? 0);
            }

            // Track Y-axis range for stable locking
            if (!this._yScaleLocked) {
                for (let i = 0; i < this._channelCount; i++) {
                    const v = f.channels[i] ?? 0;
                    if (v < this._yTrackMin) this._yTrackMin = v;
                    if (v > this._yTrackMax) this._yTrackMax = v;
                }
            }
        }

        // Auto-lock Y scale after sufficient data (2 full cycles = stable range)
        if (!this._yScaleLocked) {
            this._yStableCount += frames.length;
            if (this._yStableCount >= this._samplesPerCycle * 2) {
                this._lockYScale();
            }
        }

        // Cap accumulation buffer (safety)
        const capBuf = this._maxSamples * 2;
        if (this._buf.x.length > capBuf) {
            const trim = this._buf.x.length - capBuf;
            this._buf.x.splice(0, trim);
            for (let i = 0; i < this._channelCount; i++)
                this._buf.ch[i].splice(0, trim);
        }

        // Mark data dirty and schedule a render via requestAnimationFrame.
        // This batches multiple addFrames() calls into a single paint —
        // prevents redundant repaints and flicker. This is how professional
        // charting apps (TradingView, Grafana) handle high-frequency data.
        this._dataDirty = true;
        this._scheduleRender();
    },

    /**
     * Clear everything — called on full reset (stop capture, manual reset).
     * Destroys the uPlot instance and shows placeholder.
     */
    clear() {
        this._buf = { x: [], ch: [] };
        this._plotX = [];
        this._plotCh = [];
        this._channelCount = 0;
        this._lastRefresh = 0;
        this._held = false;
        this._smpCntOffset = 0;
        this._lastSmpCnt = -1;
        this._dataDirty = false;
        this._rafPending = false;
        this._resetYTracking();
        if (this._plot) { this._plot.destroy(); this._plot = null; }

        const ph = document.getElementById('chartPlaceholder');
        if (ph) ph.style.display = '';

        const holdBtn = document.getElementById('chartHold');
        if (holdBtn) { holdBtn.textContent = '⏸ Hold'; holdBtn.classList.remove('chart-btn-held'); }

        const st = document.getElementById('chartStatus');
        if (st) st.textContent = 'Waiting for data…';
    },

    /**
     * Soft data-only reset — clears data arrays and resets the smpCnt unwrap
     * timeline, but keeps the uPlot instance alive and channels configured.
     *
     * Used on data discontinuities (backend auto-detect reset, ring buffer
     * overflow gap). Professional oscilloscopes never blank their display —
     * they silently reset internal state and continue drawing.
     */
    resetData() {
        // Clear data arrays but keep channel configuration
        this._buf.x = [];
        for (let i = 0; i < this._channelCount; i++) this._buf.ch[i] = [];
        this._plotX = [];
        for (let i = 0; i < this._channelCount; i++) this._plotCh[i] = [];

        // Reset smpCnt unwrap state — new data starts a fresh timeline
        this._smpCntOffset = 0;
        this._lastSmpCnt = -1;
        this._lastRefresh = 0;
        this._dataDirty = false;

        // Reset Y tracking so scale adapts to new data
        this._resetYTracking();

        // If plot exists, feed it empty data so axes stay visible
        if (this._plot) {
            const emptyData = [[]];
            for (let i = 1; i < this._plot.series.length; i++) emptyData.push([]);
            this._plot.setData(emptyData);
        }

        const st = document.getElementById('chartStatus');
        if (st) st.textContent = 'Resyncing…';
    },

    // ====================================================================
    // INTERNAL — mode / params
    // ====================================================================

    _setMode(mode) {
        this._mode = mode;
        document.getElementById('chartNGroup').style.display =
            mode === 'fixedN' ? '' : 'none';
        if (mode === 'fixed60') this._nCycles = 60;
        this._recompute();
        // Flush display buffer for clean switch
        this._plotX = [];
        this._plotCh = [];
    },

    /** Recompute derived values from nominalFreq / smpCntMax / nCycles */
    _recompute() {
        this._samplesPerCycle = Math.round((this._smpCntMax + 1) / this._nominalFreq);
        this._windowSamples = this._nCycles * this._samplesPerCycle;
        this._refreshMs = (this._mode === 'fixedN')
            ? Math.max(200, Math.round((60 / this._nCycles) * 1000))
            : 1000;
    },

    // ====================================================================
    // INTERNAL — Y-axis scale management (anti-flicker)
    //
    // Professional approach: let the scale auto-range for the first 2
    // cycles to learn the signal amplitude, then LOCK it. This prevents
    // the constant Y-axis bounce that causes visual flicker.
    //
    // The user can unlock with the "Auto Y" button if signal changes.
    //
    // This is the same approach used by:
    //   - OMICRON SVScout (locks Y after initial range settled)
    //   - Siemens SIGUARD PDP (fixed Y ranges per channel type)
    //   - National Instruments LabVIEW (auto-scale then hold)
    // ====================================================================

    /** Reset Y-axis tracking state */
    _resetYTracking() {
        this._yScaleLocked = false;
        this._yScaleV = null;
        this._yScaleI = null;
        this._yStableCount = 0;
        this._yTrackMin = Infinity;
        this._yTrackMax = -Infinity;
    },

    /** Lock Y-axis scale based on observed data range */
    _lockYScale() {
        // Add 10% padding above and below for visual breathing room
        const pad = (min, max) => {
            const range = max - min;
            if (range === 0) return { min: min - 1, max: max + 1 };
            return { min: min - range * 0.1, max: max + range * 0.1 };
        };

        if (this._yTrackMin < Infinity) {
            this._yScaleV = pad(this._yTrackMin, this._yTrackMax);
        }

        this._yScaleLocked = true;

        // Apply locked scale to EXISTING plot using setScale() API.
        // NO destroy/recreate — that causes visible DOM flash.
        if (this._plot && this._yScaleV) {
            this._plot.setScale('Y', this._yScaleV);
        }

        console.log('[chart] Y-axis locked — Y:', this._yScaleV);
    },

    /** Unlock Y-axis (user clicks "Auto Y" button) */
    _unlockYScale() {
        this._resetYTracking();
        // Don't destroy — just let the next setData() auto-range
        this._dataDirty = true;
        this._scheduleRender();
        console.log('[chart] Y-axis unlocked — auto-ranging');
    },

    // ====================================================================
    // INTERNAL — channel setup (run once when first frame arrives)
    // ====================================================================

    _setupChannels(count) {
        this._channelCount = count;
        this._visible = new Array(count).fill(true);
        this._buf.ch = [];
        this._plotCh = [];
        for (let i = 0; i < count; i++) {
            this._buf.ch.push([]);
            this._plotCh.push([]);
        }

        // Build toggle buttons
        const box = document.getElementById('chartToggles');
        if (!box) return;
        box.innerHTML = '';
        for (let i = 0; i < count; i++) {
            const btn = document.createElement('button');
            btn.className = 'ch-toggle active';
            btn.textContent = this._names[i] || `C${i}`;
            btn.style.borderColor = this._colors[i];
            btn.style.color = this._colors[i];
            btn.addEventListener('click', () => {
                this._visible[i] = !this._visible[i];
                btn.classList.toggle('active', this._visible[i]);
                // Rebuild plot with new series
                if (this._plot) { this._plot.destroy(); this._plot = null; }
                this._dataDirty = true;
                this._scheduleRender();
            });
            box.appendChild(btn);
        }
    },

    // ====================================================================
    // INTERNAL — requestAnimationFrame based render scheduling
    //
    // Instead of rendering immediately on every addFrames() call, we
    // schedule a single render on the next animation frame. This:
    //   - Batches multiple data updates into one paint
    //   - Syncs with the browser's 60fps vsync (no tearing)
    //   - Prevents redundant repaints that cause flicker
    //
    // This is the standard approach for high-performance charting:
    //   - TradingView uses rAF for all chart updates
    //   - Grafana batches data into rAF cycles
    //   - NI LabVIEW Web uses a similar frame-sync mechanism
    // ====================================================================

    _scheduleRender() {
        if (this._rafPending) return; // Already scheduled
        this._rafPending = true;

        requestAnimationFrame(() => {
            this._rafPending = false;
            if (!this._dataDirty || this._held) return;

            const now = Date.now();

            // Enforce minimum interval between renders.
            // This is the key anti-flicker mechanism: even though data may
            // arrive faster, we only repaint at ~7fps (150ms). This gives
            // the canvas enough time between clears to appear stable.
            // Professional SCADA/HMI systems use similar 4-10fps display rates.
            const elapsed = now - this._lastRenderTs;
            if (elapsed < this._renderIntervalMs) {
                // Too soon — reschedule for later
                this._scheduleRender();
                return;
            }

            this._dataDirty = false;
            this._lastRenderTs = now;

            if (this._mode === 'continuous') {
                this._renderContinuous();
            } else {
                // Fixed window: only refresh at the configured interval
                if (now - this._lastRefresh >= this._refreshMs) {
                    this._renderWindow();
                    this._lastRefresh = now;
                } else {
                    // Data arrived but interval not reached yet — reschedule
                    this._dataDirty = true;
                    this._scheduleRender();
                }
            }
        });
    },

    // ====================================================================
    // INTERNAL — Continuous mode
    // ====================================================================

    _renderContinuous() {
        // Append accumulated buffer to plot arrays
        if (this._buf.x.length > 0) {
            this._plotX.push(...this._buf.x);
            for (let i = 0; i < this._channelCount; i++)
                this._plotCh[i].push(...this._buf.ch[i]);

            // Clear accumulation buffer
            this._buf.x = [];
            for (let i = 0; i < this._channelCount; i++) this._buf.ch[i] = [];
        }

        // Trim to max
        if (this._plotX.length > this._maxSamples) {
            const cut = this._plotX.length - this._maxSamples;
            this._plotX.splice(0, cut);
            for (let i = 0; i < this._channelCount; i++)
                this._plotCh[i].splice(0, cut);
        }

        this._pushToPlot();
    },

    // ====================================================================
    // INTERNAL — Fixed window mode (60-cycle / N-cycle)
    // ====================================================================

    _renderWindow() {
        if (this._buf.x.length === 0) return;

        // Take the last windowSamples from the buffer
        const n = Math.min(this._buf.x.length, this._windowSamples);
        const start = this._buf.x.length - n;
        this._plotX = this._buf.x.slice(start);
        for (let i = 0; i < this._channelCount; i++)
            this._plotCh[i] = this._buf.ch[i].slice(start);

        this._pushToPlot();
    },

    // ====================================================================
    // INTERNAL — push current data to uPlot
    // ====================================================================

    _pushToPlot() {
        if (this._plotX.length < 2) return;

        const container = document.getElementById('chartContainer');
        if (!container) return;

        // Hide placeholder
        const ph = document.getElementById('chartPlaceholder');
        if (ph) ph.style.display = 'none';

        // Build uPlot data: [ x[], ch0[], ch1[], ... ] (only visible)
        const data = [this._plotX];
        const visCh = [];
        for (let i = 0; i < this._channelCount; i++) {
            if (this._visible[i]) {
                data.push(this._plotCh[i]);
                visCh.push(i);
            }
        }
        if (visCh.length === 0) return;

        // Create plot if needed, or if series count changed.
        // Once created, we only call setData() — never recreate.
        if (!this._plot || (this._plot.series.length - 1) !== visCh.length) {
            if (this._plot) this._plot.destroy();
            this._plot = this._createPlot(container, data, visCh);
            // Re-apply locked Y scales to the freshly created plot
            // (e.g., after a channel toggle rebuild)
            if (this._yScaleLocked) {
                if (this._yScaleV) this._plot.setScale('Y', this._yScaleV);
            }
        } else {
            // ── Update existing plot ──
            // Use batch() to group setData + setScale into ONE atomic canvas
            // draw. Without batch(), each call triggers a separate synchronous
            // commit() (clear canvas → draw grid → draw series). If the browser
            // composites between the two draws, the user sees blank grids
            // without series (the Hold-button bug).
            this._plot.batch(() => {
                if (this._yScaleLocked) {
                    // Locked Y: skip scale recalc (no Y-axis flicker).
                    // Manually set X (it scrolls), Y stays pinned from _lockYScale().
                    this._plot.setData(data, false);
                    this._plot.setScale('x', {
                        min: this._plotX[0],
                        max: this._plotX[this._plotX.length - 1],
                    });
                } else {
                    // Unlocked Y (first ~160 samples): full auto-range.
                    this._plot.setData(data);
                }
            });
        }

        // Status text
        const st = document.getElementById('chartStatus');
        if (st) {
            const cyc = (this._plotX.length / this._samplesPerCycle).toFixed(1);
            const tMax = this._plotX.length > 0 ? this._plotX[this._plotX.length - 1].toFixed(3) : '0.000';
            const lockIcon = this._yScaleLocked ? '🔒' : '🔓';
            st.textContent = `${lockIcon} ${this._plotX.length} smp · ${cyc} cyc · ${tMax}s`;
        }
    },

    // ====================================================================
    // INTERNAL — create uPlot instance
    // ====================================================================

    _createPlot(container, data, visCh) {
        const w = container.clientWidth || 600;
        const h = container.clientHeight || 300;

        // Series: index 0 = X axis (blank label)
        const series = [{}];
        for (const ch of visCh) {
            series.push({
                label: this._names[ch] || `Ch${ch}`,
                stroke: this._colors[ch % this._colors.length],
                width: 1.5,
                scale: 'Y',
            });
        }

        // Check if any current channel is visible
        const hasY = visCh.length > 0;

        // Y-axis scale config — single unified Y scale.
        // Always created with auto:true for initial range discovery.
        // After 2 cycles, _lockYScale() calls setScale() to pin the range,
        // and all subsequent setData(data, false) calls skip scale recalc
        // entirely — this is what eliminates the Y-axis flicker.
        const yScale = { auto: true };

        const opts = {
            width: w,
            height: h,
            series,
            scales: {
                x: { time: false },
                Y: yScale,
            },
            axes: [
                { stroke: '#8b949e', grid: { stroke: 'rgba(48,54,61,0.6)' },
                  font: '11px Consolas', label: 'Time (s)', labelFont: '11px Consolas', labelSize: 16 },
                { scale: 'Y', stroke: '#58a6ff', grid: { stroke: 'rgba(48,54,61,0.4)' },
                  font: '10px Consolas', label: 'Value', labelFont: '10px Consolas', labelSize: 16, size: 65 },
            ],
            cursor: { drag: { x: true, y: true, setScale: true } },
            legend: { show: true, live: true },
        };

        const plot = new uPlot(opts, data, container);

        // Auto-resize when container changes size
        if (!this._resizeObs) {
            this._resizeObs = new ResizeObserver(() => {
                if (this._plot && container.clientWidth > 0) {
                    this._plot.setSize({
                        width: container.clientWidth,
                        height: container.clientHeight,
                    });
                }
            });
            this._resizeObs.observe(container);
        }

        return plot;
    },

    // ====================================================================
    // INTERNAL — hold toggle
    // ====================================================================

    _toggleHold() {
        this._held = !this._held;
        const btn = document.getElementById('chartHold');
        if (btn) {
            btn.textContent = this._held ? '▶ Resume' : '⏸ Hold';
            btn.classList.toggle('chart-btn-held', this._held);
        }
        const st = document.getElementById('chartStatus');
        if (st && this._held) st.textContent = '⏸ HELD';

        // On resume, immediately render buffered data
        if (!this._held && this._buf.x.length > 0) {
            this._dataDirty = true;
            this._scheduleRender();
        }
    },
};
