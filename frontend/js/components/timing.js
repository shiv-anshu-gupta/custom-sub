/**
 * @file components/timing.js
 * @brief Capture Timing, Session Management & Recording Component
 *
 * Provides publisher-symmetrical timing features for the subscriber:
 *
 * Capture Modes (mirrors SV Publisher):
 *   Continuous  — Capture indefinitely until manual stop
 *   Timed      — Capture for a fixed duration, then auto-stop
 *
 * Repeat Modes (mirrors SV Publisher):
 *   None       — Single capture session
 *   Count      — Repeat capture N times (stop → reset → start)
 *   Infinite   — Repeat forever until manual stop
 *
 * Session Recording:
 *   Each capture run (start → stop) creates a session record with:
 *     - Session ID, start/end timestamps, duration
 *     - Total frames captured, average frame rate
 *     - Capture configuration used
 *   History is preserved across repeats for future PCAP/SQLite export.
 *
 * Live Timer:
 *   During capture, shows elapsed time, remaining time (timed mode),
 *   progress bar, and session/repeat counts.
 *
 * Inter-Arrival Timing:
 *   Estimates average packet rate, inter-packet interval, and jitter
 *   from polling data (frames received per poll interval).
 */

const SVTiming = {

    // ====================================================================
    // Configuration State
    // ====================================================================

    /** @type {'continuous'|'timed'} Capture duration mode */
    captureMode: 'continuous',

    /** @type {number} Duration in seconds (when captureMode = 'timed') */
    duration: 30,

    /** @type {'none'|'count'|'infinite'} Repeat mode */
    repeatMode: 'none',

    /** @type {number} Number of repeats (when repeatMode = 'count') */
    repeatCount: 1,

    // ====================================================================
    // Runtime State
    // ====================================================================

    /** @private Session start timestamp (Date.now()) — set when capture starts */
    _sessionStartTime: 0,

    /** @private Timestamp when FIRST actual packet arrived (0 = waiting) */
    _firstPacketTime: 0,

    /** @private True once at least one SV frame has been received this session */
    _dataFlowing: false,

    /** @private Last poll timestamp where new frames were observed */
    _lastDataTime: 0,

    /** @private Frame count at last poll (to detect new arrivals) */
    _lastSeenFrames: 0,

    /** @private Stall detection: seconds without new data before "stalled" warning */
    _stallThresholdMs: 3000,

    /** @private Current data state: 'waiting' | 'active' | 'stalled' */
    _dataState: 'waiting',

    /** @private Accumulated "active data" time in ms (pauses during stalls) */
    _activeDataTimeMs: 0,

    /** @private Timestamp of last active-time accumulation tick */
    _lastActiveTimeTick: 0,

    /** @private JS-side elapsed timer ID */
    _timerInterval: null,

    /** @private Current elapsed seconds (JS-side for smooth display) */
    _elapsedSec: 0,

    /** @private Current session number (1-based) */
    _currentSession: 0,

    /** @private Total sessions completed in this capture run */
    _completedSessions: 0,

    /** @private Is a timed auto-stop pending? */
    _autoStopScheduled: false,

    /** @private Auto-stop timeout ID */
    _autoStopTimer: null,

    /** @private Is currently in a repeat-restart cycle? */
    _restartPending: false,

    /** @private Total frames across all sessions in this repeat run */
    _totalFramesAllSessions: 0,

    // ====================================================================
    // Session History (for future PCAP/SQLite export)
    // ====================================================================

    /** @type {Array<Object>} Completed session records */
    sessionHistory: [],

    /** @private Running session record being populated */
    _activeSession: null,

    // ====================================================================
    // Inter-Arrival Timing Analysis
    // ====================================================================

    /** @private Sliding window of (timestamp, frameCount) samples */
    _rateSamples: [],
    _maxRateSamples: 30,

    /** @private Computed timing stats */
    _timingStats: {
        avgInterArrivalMs: 0,
        avgFrameRate: 0,
        estimatedPubInterval: '—',
        jitterMs: 0,
    },

    // ====================================================================
    // DOM References
    // ====================================================================
    _dom: null,
    _prev: {},

    // ====================================================================
    // Template
    // ====================================================================

    /**
     * Returns the timing session bar HTML template.
     * Shown between config bar and stats cards during capture.
     * @returns {string} HTML string
     */
    getTemplate() {
        return `
            <div class="timing-session-bar" id="timingSessionBar" style="display:none;">
                <div class="timing-row">
                    <!-- Data state indicator -->
                    <div class="timing-group timing-timer-group">
                        <span class="timing-icon timing-icon-waiting" id="timingRecDot">●</span>
                        <span class="timing-state-label" id="timingStateLabel">Waiting for data...</span>
                    </div>

                    <!-- Live Timer (hidden until first packet arrives) -->
                    <div class="timing-group" id="timingElapsedGroup" style="display:none;">
                        <span class="timing-label">Data Time:</span>
                        <span class="timing-value timing-elapsed" id="timingElapsed">00:00:00</span>
                    </div>

                    <!-- Remaining (timed mode only) -->
                    <div class="timing-group" id="timingRemainingGroup" style="display:none;">
                        <span class="timing-label">Remaining:</span>
                        <span class="timing-value timing-remaining" id="timingRemaining">00:00:00</span>
                    </div>

                    <!-- Progress bar (timed mode only) -->
                    <div class="timing-progress-container" id="timingProgressGroup" style="display:none;">
                        <div class="timing-progress-bar" id="timingProgressBar"></div>
                        <span class="timing-progress-pct" id="timingProgressPct">0%</span>
                    </div>

                    <!-- Session info (repeat mode) -->
                    <div class="timing-group" id="timingSessionGroup" style="display:none;">
                        <span class="timing-label">Session:</span>
                        <span class="timing-value" id="timingSessionNum">1</span>
                        <span class="timing-label" id="timingSessionOf"></span>
                    </div>

                    <!-- Mode indicator -->
                    <div class="timing-group">
                        <span class="timing-badge" id="timingModeBadge">CONTINUOUS</span>
                    </div>

                    <!-- Timing stats (hidden until data flows) -->
                    <div class="timing-group timing-stats-group" id="timingStatsGroup" style="display:none;">
                        <span class="timing-label">Avg Rate:</span>
                        <span class="timing-value" id="timingAvgRate">—</span>
                        <span class="timing-label">fps</span>
                        <span class="timing-sep">|</span>
                        <span class="timing-label">Interval:</span>
                        <span class="timing-value" id="timingInterval">—</span>
                        <span class="timing-label">ms</span>
                    </div>

                    <!-- Session frames -->
                    <div class="timing-group">
                        <span class="timing-label">Frames:</span>
                        <span class="timing-value" id="timingFrameCount">0</span>
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * Returns the timing configuration controls template.
     * Inserted into the capture config bar.
     * @returns {string} HTML string
     */
    getConfigTemplate() {
        return `
            <div class="config-group timing-config-group">
                <label>Duration:</label>
                <select id="cfgCaptureMode" class="input-field timing-select">
                    <option value="continuous" selected>Continuous</option>
                    <option value="timed">Timed</option>
                </select>
                <input type="number" id="cfgDuration" class="input-field timing-duration-input"
                       value="30" min="1" max="86400" step="1" style="display:none;"
                       title="Capture duration">
                <select id="cfgDurationUnit" class="input-field timing-unit-select" style="display:none;">
                    <option value="sec" selected>sec</option>
                    <option value="min">min</option>
                    <option value="hr">hr</option>
                </select>
            </div>
            <div class="config-group timing-config-group">
                <label>Repeat:</label>
                <select id="cfgRepeatMode" class="input-field timing-select">
                    <option value="none" selected>None</option>
                    <option value="count">Count</option>
                    <option value="infinite">Infinite</option>
                </select>
                <input type="number" id="cfgRepeatCount" class="input-field timing-repeat-input"
                       value="3" min="1" max="10000" step="1" style="display:none;"
                       title="Number of repeats">
                <span class="timing-repeat-suffix" id="cfgRepeatSuffix" style="display:none;">times</span>
            </div>
        `;
    },

    // ====================================================================
    // Initialization
    // ====================================================================

    init() {
        this._dom = {
            bar:              document.getElementById('timingSessionBar'),
            stateLabel:       document.getElementById('timingStateLabel'),
            elapsedGroup:     document.getElementById('timingElapsedGroup'),
            elapsed:          document.getElementById('timingElapsed'),
            remaining:        document.getElementById('timingRemaining'),
            remainingGroup:   document.getElementById('timingRemainingGroup'),
            progressGroup:    document.getElementById('timingProgressGroup'),
            progressBar:      document.getElementById('timingProgressBar'),
            progressPct:      document.getElementById('timingProgressPct'),
            sessionGroup:     document.getElementById('timingSessionGroup'),
            sessionNum:       document.getElementById('timingSessionNum'),
            sessionOf:        document.getElementById('timingSessionOf'),
            modeBadge:        document.getElementById('timingModeBadge'),
            statsGroup:       document.getElementById('timingStatsGroup'),
            avgRate:          document.getElementById('timingAvgRate'),
            interval:         document.getElementById('timingInterval'),
            frameCount:       document.getElementById('timingFrameCount'),
            recDot:           document.getElementById('timingRecDot'),

            // Config controls
            captureMode:      document.getElementById('cfgCaptureMode'),
            duration:         document.getElementById('cfgDuration'),
            durationUnit:     document.getElementById('cfgDurationUnit'),
            repeatMode:       document.getElementById('cfgRepeatMode'),
            repeatCount:      document.getElementById('cfgRepeatCount'),
            repeatSuffix:     document.getElementById('cfgRepeatSuffix'),
        };
        this._prev = {};

        // Bind config change events
        if (this._dom.captureMode) {
            this._dom.captureMode.addEventListener('change', () => this._onCaptureModeChange());
        }
        if (this._dom.repeatMode) {
            this._dom.repeatMode.addEventListener('change', () => this._onRepeatModeChange());
        }

        console.log('[timing] Session timing component initialized');
    },

    // ====================================================================
    // Config Control Handlers
    // ====================================================================

    /** @private Toggle duration inputs visibility */
    _onCaptureModeChange() {
        const mode = this._dom.captureMode.value;
        const isTimed = mode === 'timed';
        if (this._dom.duration)     this._dom.duration.style.display     = isTimed ? '' : 'none';
        if (this._dom.durationUnit) this._dom.durationUnit.style.display = isTimed ? '' : 'none';
    },

    /** @private Toggle repeat count input visibility */
    _onRepeatModeChange() {
        const mode = this._dom.repeatMode.value;
        const isCount = mode === 'count';
        if (this._dom.repeatCount)  this._dom.repeatCount.style.display  = isCount ? '' : 'none';
        if (this._dom.repeatSuffix) this._dom.repeatSuffix.style.display = isCount ? '' : 'none';
    },

    /**
     * Get timing configuration from UI inputs.
     * Called by app.js before starting capture.
     * @returns {{ captureMode: string, durationSec: number, repeatMode: string, repeatCount: number }}
     */
    getConfig() {
        const mode = this._dom?.captureMode?.value || 'continuous';
        let dur = parseInt(this._dom?.duration?.value) || 30;
        const unit = this._dom?.durationUnit?.value || 'sec';

        // Convert to seconds
        if (unit === 'min') dur *= 60;
        if (unit === 'hr')  dur *= 3600;

        return {
            captureMode: mode,
            durationSec: dur,
            repeatMode:  this._dom?.repeatMode?.value || 'none',
            repeatCount: parseInt(this._dom?.repeatCount?.value) || 1,
        };
    },

    /**
     * Disable/enable timing config controls during capture
     * @param {boolean} disabled
     */
    setDisabled(disabled) {
        if (this._dom.captureMode) this._dom.captureMode.disabled = disabled;
        if (this._dom.duration)    this._dom.duration.disabled    = disabled;
        if (this._dom.durationUnit) this._dom.durationUnit.disabled = disabled;
        if (this._dom.repeatMode)  this._dom.repeatMode.disabled  = disabled;
        if (this._dom.repeatCount) this._dom.repeatCount.disabled = disabled;
    },

    // ====================================================================
    // Session Lifecycle
    // ====================================================================

    /**
     * Start a new capture session — called by app.js after capture_start succeeds.
     * Does NOT start timing yet — enters "waiting for data" state.
     * Timer only begins when first real SV packet is detected via update().
     */
    startSession() {
        const config = this.getConfig();
        this.captureMode = config.captureMode;
        this.duration    = config.durationSec;
        this.repeatMode  = config.repeatMode;
        this.repeatCount = config.repeatCount;

        // Initialize session tracking
        if (!this._restartPending) {
            // Fresh capture (not a repeat-restart)
            this._currentSession = 1;
            this._completedSessions = 0;
            this._totalFramesAllSessions = 0;
            this.sessionHistory = [];
        } else {
            this._currentSession++;
            this._restartPending = false;
        }

        this._sessionStartTime = Date.now();
        this._firstPacketTime = 0;
        this._dataFlowing = false;
        this._dataState = 'waiting';
        this._lastDataTime = 0;
        this._lastSeenFrames = 0;
        this._activeDataTimeMs = 0;
        this._lastActiveTimeTick = 0;
        this._elapsedSec = 0;
        this._rateSamples = [];
        this._timingStats = { avgInterArrivalMs: 0, avgFrameRate: 0, estimatedPubInterval: '—', jitterMs: 0 };

        // Create active session record (startTime will be overwritten when first packet arrives)
        this._activeSession = {
            sessionId:   this._currentSession,
            startTime:   null,  // Set when first packet arrives
            startTimeMs: 0,
            endTime:     null,
            endTimeMs:   null,
            durationMs:  0,
            dataTimeMs:  0,     // Actual time data was flowing
            frameCount:  0,
            avgFrameRate: 0,
            config: { ...config },
        };

        // Show session bar in "waiting" state
        this._showBar(true);
        this._updateModeBadge();
        this._updateSessionInfo();
        this._setDataState('waiting');

        // Start a lightweight check timer (monitors data state, doesn't count elapsed)
        this._startTimer();

        // NOTE: Auto-stop and real elapsed timer start ONLY when first data arrives
        // (see _onFirstPacket)

        console.log(`[timing] Session #${this._currentSession} opened — WAITING for data ` +
                     `(mode=${this.captureMode}, repeat=${this.repeatMode})`);
    },

    /**
     * @private Called when the first real SV packet is detected.
     * Transitions from "waiting" → "active", starts real timing.
     */
    _onFirstPacket() {
        const now = Date.now();
        this._firstPacketTime = now;
        this._dataFlowing = true;
        this._lastDataTime = now;
        this._lastActiveTimeTick = now;
        this._activeDataTimeMs = 0;

        // Set real session start time to first-packet time
        if (this._activeSession) {
            this._activeSession.startTime = new Date(now).toISOString();
            this._activeSession.startTimeMs = now;
        }

        this._setDataState('active');

        // NOW schedule auto-stop if timed mode (countdown from first packet, not from button click)
        if (this.captureMode === 'timed' && this.duration > 0) {
            this._scheduleAutoStop(this.duration);
        }

        console.log(`[timing] First packet received — timer started`);
    },

    /**
     * End the current capture session — called by app.js after capture stops.
     * Finalizes session record and handles repeat logic.
     * @returns {{ shouldRepeat: boolean }} Whether app.js should restart capture
     */
    endSession(totalFrames) {
        const now = Date.now();

        // Stop timers
        this._stopTimer();
        this._cancelAutoStop();

        // Finalize session record
        if (this._activeSession) {
            this._activeSession.endTime = new Date().toISOString();
            this._activeSession.endTimeMs = now;

            // Use actual data time (time packets were flowing), not wall clock
            if (this._firstPacketTime > 0) {
                this._activeSession.durationMs = now - this._firstPacketTime;
                this._activeSession.dataTimeMs = this._activeDataTimeMs;
            } else {
                // Never received any data
                this._activeSession.durationMs = 0;
                this._activeSession.dataTimeMs = 0;
            }

            this._activeSession.frameCount = totalFrames || 0;
            this._activeSession.avgFrameRate =
                this._activeSession.dataTimeMs > 0
                    ? Math.round((this._activeSession.frameCount / this._activeSession.dataTimeMs) * 1000)
                    : 0;

            // Add to history
            this.sessionHistory.push({ ...this._activeSession });
            this._totalFramesAllSessions += this._activeSession.frameCount;
            this._completedSessions++;

            console.log(`[timing] Session #${this._currentSession} ended — ` +
                        `${this._activeSession.frameCount} frames in ${this._fmtDuration(this._activeSession.durationMs)}`);
        }

        this._activeSession = null;

        // Check repeat logic
        const shouldRepeat = this._shouldRepeat();
        if (shouldRepeat) {
            this._restartPending = true;
            console.log(`[timing] Repeat scheduled — session ${this._currentSession + 1}` +
                        (this.repeatMode === 'count' ? ` of ${this.repeatCount}` : ' (infinite)'));
        } else {
            // All done — hide bar after a brief delay to show final state
            this._showBar(false);
        }

        return { shouldRepeat };
    },

    /**
     * Force-stop everything (user clicked Stop or Reset).
     * Cancels any pending repeats.
     */
    forceStop(totalFrames) {
        this._restartPending = false;
        this.endSession(totalFrames);
        // Override the shouldRepeat — user explicitly stopped
        this._restartPending = false;
        this._showBar(false);
    },

    // ====================================================================
    // Timer Management
    // ====================================================================

    /** @private Start the 100ms UI timer */
    _startTimer() {
        if (this._timerInterval) return;
        this._timerInterval = setInterval(() => this._tickTimer(), 100);
    },

    /** @private Stop the UI timer */
    _stopTimer() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
            this._timerInterval = null;
        }
    },

    /** @private Timer tick — updates display based on data state, not wall clock */
    _tickTimer() {
        const now = Date.now();

        // ── If no data received yet, show "waiting" state (no timer counting) ──
        if (!this._dataFlowing) {
            // Waiting animation is handled by CSS
            return;
        }

        // ── Stall detection: if no new frames for > threshold, mark stalled ──
        if (this._lastDataTime > 0 && (now - this._lastDataTime) > this._stallThresholdMs) {
            if (this._dataState !== 'stalled') {
                this._setDataState('stalled');
            }
            // Don't accumulate active time during a stall
        } else if (this._dataState !== 'active') {
            this._setDataState('active');
        }

        // ── Accumulate active data time (only when data is flowing, not stalled) ──
        if (this._dataState === 'active' && this._lastActiveTimeTick > 0) {
            const dt = now - this._lastActiveTimeTick;
            this._activeDataTimeMs += dt;
        }
        this._lastActiveTimeTick = now;

        // Use active data time for display (only real data-flowing time)
        const elapsedMs = this._activeDataTimeMs;
        this._elapsedSec = elapsedMs / 1000;

        // Update elapsed display
        if (this._dom.elapsed) {
            const fmt = this._fmtDuration(elapsedMs);
            if (this._prev.elapsed !== fmt) {
                this._dom.elapsed.textContent = fmt;
                this._prev.elapsed = fmt;
            }
        }

        // Update remaining display (timed mode — based on active data time)
        if (this.captureMode === 'timed' && this._firstPacketTime > 0) {
            const timeSinceFirst = now - this._firstPacketTime;
            const remainMs = Math.max(0, (this.duration * 1000) - timeSinceFirst);
            const remainFmt = this._fmtDuration(remainMs);
            if (this._prev.remain !== remainFmt && this._dom.remaining) {
                this._dom.remaining.textContent = remainFmt;
                this._prev.remain = remainFmt;
            }

            // Progress bar (based on wall time since first packet for accuracy)
            const pct = Math.min(100, (timeSinceFirst / (this.duration * 1000)) * 100);
            const pctStr = Math.round(pct) + '%';
            if (this._prev.pct !== pctStr) {
                if (this._dom.progressBar) this._dom.progressBar.style.width = pctStr;
                if (this._dom.progressPct) this._dom.progressPct.textContent = pctStr;
                this._prev.pct = pctStr;
            }
        }
    },

    /**
     * @private Set data state and update the UI indicator accordingly.
     * @param {'waiting'|'active'|'stalled'} state
     */
    _setDataState(state) {
        this._dataState = state;
        const d = this._dom;
        if (!d) return;

        // Update bar border color class
        if (d.bar) {
            d.bar.classList.remove('timing-bar-active', 'timing-bar-stalled');
            if (state === 'active')  d.bar.classList.add('timing-bar-active');
            if (state === 'stalled') d.bar.classList.add('timing-bar-stalled');
        }

        switch (state) {
            case 'waiting':
                if (d.recDot) d.recDot.className = 'timing-icon timing-icon-waiting';
                if (d.stateLabel) { d.stateLabel.textContent = 'Waiting for data...'; d.stateLabel.className = 'timing-state-label timing-state-waiting'; }
                if (d.elapsedGroup) d.elapsedGroup.style.display = 'none';
                if (d.statsGroup) d.statsGroup.style.display = 'none';
                if (d.remainingGroup) d.remainingGroup.style.display = 'none';
                if (d.progressGroup) d.progressGroup.style.display = 'none';
                break;

            case 'active':
                if (d.recDot) d.recDot.className = 'timing-icon timing-icon-active';
                if (d.stateLabel) { d.stateLabel.textContent = 'Receiving'; d.stateLabel.className = 'timing-state-label timing-state-active'; }
                if (d.elapsedGroup) d.elapsedGroup.style.display = '';
                if (d.statsGroup) d.statsGroup.style.display = '';
                if (this.captureMode === 'timed') {
                    if (d.remainingGroup) d.remainingGroup.style.display = '';
                    if (d.progressGroup) d.progressGroup.style.display = '';
                }
                break;

            case 'stalled':
                if (d.recDot) d.recDot.className = 'timing-icon timing-icon-stalled';
                if (d.stateLabel) { d.stateLabel.textContent = 'No data'; d.stateLabel.className = 'timing-state-label timing-state-stalled'; }
                // Keep elapsed/stats visible so user sees last values
                break;
        }
    },

    /** @private Schedule auto-stop after duration seconds */
    _scheduleAutoStop(durationSec) {
        this._cancelAutoStop();
        this._autoStopScheduled = true;
        this._autoStopTimer = setTimeout(() => {
            this._autoStopScheduled = false;
            console.log('[timing] Auto-stop triggered (duration expired)');
            // Signal app.js to stop capture
            if (typeof onTimedCaptureExpired === 'function') {
                onTimedCaptureExpired();
            }
        }, durationSec * 1000);
    },

    /** @private Cancel pending auto-stop */
    _cancelAutoStop() {
        if (this._autoStopTimer) {
            clearTimeout(this._autoStopTimer);
            this._autoStopTimer = null;
        }
        this._autoStopScheduled = false;
    },

    // ====================================================================
    // Repeat Logic
    // ====================================================================

    /** @private Check if capture should repeat */
    _shouldRepeat() {
        if (this.repeatMode === 'infinite') return true;
        if (this.repeatMode === 'count') {
            return this._completedSessions < this.repeatCount;
        }
        return false;
    },

    // ====================================================================
    // Live Data Update (called from pollData)
    // ====================================================================

    /**
     * Update timing stats from poll data.
     * Called every poll cycle by app.js.
     *
     * KEY DESIGN: This is the data-driven heartbeat.
     *   - Detects first packet → triggers _onFirstPacket() → starts real timer
     *   - Detects data flow / stalls → updates data state
     *   - Only counts elapsed time while data is actually flowing
     *
     * @param {Object} analysis      - Analysis summary from poll
     * @param {Object} captureStats  - Capture stats from poll
     */
    update(analysis, captureStats) {
        if (!this._dom || !this._activeSession) return;
        const p = this._prev;
        const now = Date.now();

        // ── Detect first packet arrival (data starts flowing) ──
        const currentFrames = analysis?.totalFrames || 0;

        if (!this._dataFlowing && currentFrames > 0) {
            this._onFirstPacket();
            this._lastSeenFrames = currentFrames;
        }

        // ── Track data flow: detect new frames vs stall ──
        if (this._dataFlowing && currentFrames > this._lastSeenFrames) {
            this._lastDataTime = now;
            this._lastSeenFrames = currentFrames;

            // If we were stalled, resume active-time accumulation
            if (this._dataState === 'stalled') {
                this._lastActiveTimeTick = now; // Reset tick so we don't count stall gap
                this._setDataState('active');
            }
        }

        // Update frame count display
        if (this._activeSession) {
            this._activeSession.frameCount = currentFrames;
        }

        const fcStr = currentFrames.toLocaleString();
        if (p.fc !== fcStr && this._dom.frameCount) {
            this._dom.frameCount.textContent = fcStr;
            p.fc = fcStr;
        }

        // Compute inter-arrival timing from polling deltas (only when data flows)
        if (this._dataFlowing && captureStats && captureStats.packetsSV !== undefined) {
            this._rateSamples.push({
                time: now,
                frames: captureStats.packetsSV,
            });
            if (this._rateSamples.length > this._maxRateSamples) {
                this._rateSamples.shift();
            }
            this._computeTimingStats();
        }

        // Update average rate display
        const rateStr = this._timingStats.avgFrameRate > 0
            ? this._timingStats.avgFrameRate.toLocaleString()
            : '—';
        if (p.avgRate !== rateStr && this._dom.avgRate) {
            this._dom.avgRate.textContent = rateStr;
            p.avgRate = rateStr;
        }

        // Update interval display
        const intStr = this._timingStats.avgInterArrivalMs > 0
            ? this._timingStats.avgInterArrivalMs.toFixed(2)
            : '—';
        if (p.interval !== intStr && this._dom.interval) {
            this._dom.interval.textContent = intStr;
            p.interval = intStr;
        }
    },

    /** @private Compute timing statistics from rate samples */
    _computeTimingStats() {
        const samples = this._rateSamples;
        if (samples.length < 2) return;

        // Compute average frame rate over the sample window
        const first = samples[0];
        const last = samples[samples.length - 1];
        const dtSec = (last.time - first.time) / 1000;
        const dFrames = last.frames - first.frames;

        if (dtSec > 0 && dFrames > 0) {
            const avgRate = dFrames / dtSec;
            this._timingStats.avgFrameRate = Math.round(avgRate);

            // Average inter-arrival interval (ms per frame)
            this._timingStats.avgInterArrivalMs = dtSec > 0
                ? (dtSec * 1000) / dFrames
                : 0;

            // Estimate publisher interval from known standard rates
            this._timingStats.estimatedPubInterval = this._estimatePubInterval(avgRate);
        }

        // Compute jitter from consecutive sample deltas
        if (samples.length >= 3) {
            const intervals = [];
            for (let i = 1; i < samples.length; i++) {
                const dt = samples[i].time - samples[i-1].time;
                const df = samples[i].frames - samples[i-1].frames;
                if (dt > 0 && df > 0) {
                    intervals.push(dt / df); // ms per frame in this interval
                }
            }
            if (intervals.length > 1) {
                const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
                const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
                this._timingStats.jitterMs = Math.sqrt(variance);
            }
        }
    },

    /**
     * @private Estimate the publisher's transmission interval from observed rate
     * @param {number} rate - Observed frame rate (fps)
     * @returns {string} Human-readable estimated interval
     */
    _estimatePubInterval(rate) {
        // Known IEC 61850 standard rates
        const standards = [
            { rate: 4000,  label: '250µs (4000 Hz, 80/cycle@50Hz)' },
            { rate: 4800,  label: '208µs (4800 Hz, 80/cycle@60Hz)' },
            { rate: 12800, label: '78µs (12800 Hz, 256/cycle@50Hz)' },
            { rate: 15360, label: '65µs (15360 Hz, 256/cycle@60Hz)' },
            { rate: 80,    label: '12.5ms (80 Hz, 1/cycle@80smp)' },
            { rate: 256,   label: '3.9ms (256 Hz, 1/cycle@256smp)' },
        ];

        // Find closest standard rate (within 5% tolerance)
        for (const std of standards) {
            if (Math.abs(rate - std.rate) / std.rate < 0.05) {
                return std.label;
            }
        }

        // Non-standard: compute raw interval
        const intervalMs = 1000 / rate;
        if (intervalMs < 1) return `${(intervalMs * 1000).toFixed(0)}µs`;
        return `${intervalMs.toFixed(1)}ms`;
    },

    // ====================================================================
    // Session History API (for future export)
    // ====================================================================

    /**
     * Get all completed session records.
     * Useful for PCAP/SQLite export metadata.
     * @returns {Array<Object>} Session history array
     */
    getSessionHistory() {
        return this.sessionHistory;
    },

    /**
     * Get summary of the current/last capture run.
     * @returns {Object} Summary with total frames, sessions, duration
     */
    getCaptureSummary() {
        const sessions = this.sessionHistory;
        if (sessions.length === 0) return null;

        const firstStart = sessions[0].startTimeMs;
        const lastEnd = sessions[sessions.length - 1].endTimeMs || Date.now();

        return {
            totalSessions:  sessions.length,
            totalFrames:    this._totalFramesAllSessions,
            totalDurationMs: lastEnd - firstStart,
            totalDuration:  this._fmtDuration(lastEnd - firstStart),
            firstStart:     sessions[0].startTime,
            lastEnd:        sessions[sessions.length - 1].endTime,
            avgFrameRate:   sessions.reduce((a, s) => a + s.avgFrameRate, 0) / sessions.length,
            sessions:       sessions,
        };
    },

    /**
     * Get export-ready metadata for PCAP/SQLite file headers.
     * @returns {Object} Metadata object
     */
    getExportMetadata() {
        const summary = this.getCaptureSummary();
        return {
            application:    'SV Subscriber (IEC 61850-9-2)',
            exportTime:     new Date().toISOString(),
            captureSummary: summary,
            timingConfig: {
                captureMode: this.captureMode,
                durationSec: this.duration,
                repeatMode:  this.repeatMode,
                repeatCount: this.repeatCount,
            },
            timingStats: { ...this._timingStats },
        };
    },

    // ====================================================================
    // UI Helpers
    // ====================================================================

    /** @private Show/hide the session timing bar */
    _showBar(visible) {
        if (this._dom?.bar) {
            this._dom.bar.style.display = visible ? '' : 'none';
        }
    },

    /** @private Update mode badge and toggle timed-mode UI elements */
    _updateModeBadge() {
        if (!this._dom) return;

        const isTimed = this.captureMode === 'timed';
        const badge = this._dom.modeBadge;

        if (badge) {
            if (isTimed) {
                badge.textContent = `TIMED ${this._fmtDurationShort(this.duration * 1000)}`;
                badge.className = 'timing-badge timing-badge-timed';
            } else {
                badge.textContent = 'CONTINUOUS';
                badge.className = 'timing-badge timing-badge-continuous';
            }
        }

        // Show/hide timed-mode elements
        if (this._dom.remainingGroup)  this._dom.remainingGroup.style.display  = isTimed ? '' : 'none';
        if (this._dom.progressGroup)   this._dom.progressGroup.style.display   = isTimed ? '' : 'none';
    },

    /** @private Update session/repeat info display */
    _updateSessionInfo() {
        if (!this._dom) return;
        const hasRepeat = this.repeatMode !== 'none';

        if (this._dom.sessionGroup) {
            this._dom.sessionGroup.style.display = hasRepeat ? '' : 'none';
        }
        if (this._dom.sessionNum) {
            this._dom.sessionNum.textContent = this._currentSession;
        }
        if (this._dom.sessionOf) {
            if (this.repeatMode === 'count') {
                this._dom.sessionOf.textContent = `/ ${this.repeatCount}`;
            } else if (this.repeatMode === 'infinite') {
                this._dom.sessionOf.textContent = '/ ∞';
            }
        }
    },

    /**
     * Clear all timing state (called on reset)
     */
    clear() {
        this._stopTimer();
        this._cancelAutoStop();
        this._sessionStartTime = 0;
        this._firstPacketTime = 0;
        this._dataFlowing = false;
        this._dataState = 'waiting';
        this._lastDataTime = 0;
        this._lastSeenFrames = 0;
        this._activeDataTimeMs = 0;
        this._lastActiveTimeTick = 0;
        this._elapsedSec = 0;
        this._currentSession = 0;
        this._completedSessions = 0;
        this._totalFramesAllSessions = 0;
        this._rateSamples = [];
        this._restartPending = false;
        this._activeSession = null;
        this._prev = {};
        // NOTE: sessionHistory is preserved intentionally for export
        this._showBar(false);
    },

    // ====================================================================
    // Formatting Utilities
    // ====================================================================

    /**
     * Format milliseconds to HH:MM:SS
     * @param {number} ms
     * @returns {string}
     */
    _fmtDuration(ms) {
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },

    /**
     * Format milliseconds to compact string for badge
     * @param {number} ms
     * @returns {string}
     */
    _fmtDurationShort(ms) {
        const sec = ms / 1000;
        if (sec < 60) return `${sec}s`;
        if (sec < 3600) return `${Math.round(sec / 60)}m`;
        return `${(sec / 3600).toFixed(1)}h`;
    },
};
