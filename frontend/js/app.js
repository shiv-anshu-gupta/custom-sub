/**
 * @file app.js
 * @brief Slim orchestrator for SV Subscriber — Tauri Desktop App
 *
 * Assembles the page from components, manages state and the polling loop.
 * All processing (decoding, analysis, capture) happens in C++ backend.
 *
 * Data Flow:
 *   JS invoke('command') → Rust #[tauri::command] → C++ extern "C" → JSON → JS
 *
 * Components loaded (via <script> tags before this file):
 *   backendCall()  — utils/backend.js
 *   SVNavbar       — components/navbar.js
 *   SVStats        — components/stats.js
 *   SVConfig       — components/config.js
 *   SVTable        — components/table.js
 *   SVAnalysis     — components/analysis.js
 *   SVFrameView    — components/frameview.js
 */

// ============================================================================
// Global App State (UI-only, no processing logic)
// ============================================================================

const SVApp = {
    connected: false,
    pollInterval: null,
    pollRate: 300,
    pollRateMin: 200,       // Adaptive: fastest
    pollRateMax: 2000,      // Adaptive: slowest

    lastFrameIndex: 0,
    activeTab: 'table',
    autoScroll: true,
    channelCount: 8,
    channelMask: 0xFF,

    lastStatTotal: 0,
    lastStatTime: 0,

    // ── Decoupled polling/rendering state ──

    /** @private Prevents overlapping polls */
    _pollInFlight: false,
    /** @private JS-side row buffer — table renders from this via replaceData */
    _rowBuffer: [],
    /** @private Max rows kept in JS buffer (= max table rows) */
    _maxBufferRows: 2000,
    /** @private Pending frames for chart update (always buffered regardless of tab) */
    _pendingChartFrames: [],
    /** @private Last analysis data for chart */
    _chartAnalysis: null,
    /** @private Pending frames for analysis event log (batched until render) */
    _pendingAnalysisFrames: [],
    /** @private Fixed-interval render timer (replaces rAF — predictable 2×/sec) */
    _renderTimer: null,
    /** @private Dirty flag — set when buffer has new data */
    _tableDirty: false,
    /** @private Channel columns detected and added */
    _channelsDetected: false,
    /** @private Throttle frame viewer updates (expensive DOM rebuild) */
    _lastFrameViewUpdate: 0,
    _frameViewThrottleMs: 1000,
    /** @private Set when user is actively typing in search — defers table replacement */
    _userInteracting: false,
    /** @private True once first SV data is received (for navbar status transition) */
    _dataReceived: false,
    /** @private First pcap timestamp (µs) — used to compute relative time per frame */
    _firstTimestamp: null,

    // ── SQLite Recording State ──

    /** @private Active SQLite session ID (null when not recording) */
    _dbSessionId: null,
    /** @private Last analysis summary from poll (for DB session end) */
    _lastAnalysis: null,
};

// ============================================================================
// Page Assembly — Build DOM from component templates
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {

    // ── Assemble full page from component templates ──
    const app = document.getElementById('app');
    app.innerHTML = `
        ${SVNavbar.getTemplate()}

        <div class="main-container">
            ${SVStats.getTemplate()}
            ${SVConfig.getTemplate()}
            ${SVTiming.getTemplate()}

            <!-- Tabs -->
            <div class="tab-bar">
                <button class="tab active" data-tab="table">📋 Data Table</button>
                <button class="tab" data-tab="analysis">🔍 Analysis</button>
                <button class="tab" data-tab="chart">📈 Waveform</button>
                <button class="tab" data-tab="phasor">🔄 Phasor</button>
            </div>

            <!-- Tab: Data Table -->
            <div class="tab-content active" id="tab-table">
                ${SVTable.getTemplate()}
            </div>

            <!-- Tab: Analysis -->
            <div class="tab-content" id="tab-analysis">
                ${SVFrameView.getTemplate()}
            </div>

            <!-- Tab: Waveform Chart -->
            <div class="tab-content" id="tab-chart">
                ${SVChart.getTemplate()}
            </div>

            <!-- Tab: Phasor Diagram -->
            <div class="tab-content" id="tab-phasor">
                ${SVPhasor.getTemplate()}
            </div>
        </div>

        <footer class="footer">
            <span id="footerStatus">Ready</span>
            <span id="footerBuffer">Buffer: 0 / 5000</span>
        </footer>
    `;

    // ── Initialize all components ──
    SVNavbar.init({
        onConnect: connect,
        onDisconnect: disconnect,
        onReset: resetAll,
    });

    SVStats.init();
    SVConfig.init();
    SVTiming.init();
    SVTable.init();
    SVAnalysis.init();
    SVFrameView.init();
    SVChart.init();
    SVPhasor.init();

    initTabs();

    // Auto-load network interfaces on startup
    SVNavbar.refreshInterfaces();

    SVNavbar.updateStatus('Ready', 'disconnected');
    console.log('[app] SV Subscriber initialized — component architecture');

    // ── Pause rendering AND polling when window/tab is hidden (Page Visibility API) ──
    // Stopping polling while hidden eliminates all IPC pressure on C++/Rust
    // while the user can't see the data anyway.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopRenderLoop();
            stopPolling();   // Stop IPC poll — no point draining the C++ ring
        } else if (SVApp.connected) {
            startRenderLoop();
            startPolling();  // Resume when tab is visible again
            SVApp._tableDirty = true; // Force refresh on return
        }
    });
});

// ============================================================================
// Connection Management
// ============================================================================

async function connect() {
    try {
        const iface = SVNavbar.getSelectedInterface();
        if (!iface) {
            SVNavbar.updateStatus('Select an interface first', 'error');
            return;
        }

        SVNavbar.updateStatus('Connecting...', 'disconnected');

        const { svID, smpCntMax } = SVConfig.getValues();

        await backendCall('init_subscriber', { svId: svID, smpCntMax });
        await backendCall('capture_open', { device: iface });
        await backendCall('capture_start');

        SVApp.connected = true;
        SVApp.lastStatTime = Date.now();
        SVApp.lastStatTotal = 0;
        SVApp.lastFrameIndex = 0;
        SVApp._dataReceived = false;

        SVNavbar.updateStatus('Waiting for SV data...', 'connected');
        SVNavbar.setConnectedState(true);
        SVConfig.setDisabled(true);
        SVConfig.resetDisplay();      // Clear stale delta state from prior capture
        SVTiming.setDisabled(true);
        SVTiming.startSession();       // Start timing session tracking

        // Start SQLite recording session (non-fatal if DB unavailable)
        try {
            const timingConfig = SVTiming.getConfig();
            const dbResult = await backendCall('db_start_session', {
                config: {
                    svId: svID,
                    smpCntMax: smpCntMax,
                    interfaceName: iface,
                    captureMode: timingConfig.captureMode,
                    durationSec: timingConfig.durationSec,
                    repeatMode: timingConfig.repeatMode,
                    repeatCount: timingConfig.repeatCount,
                }
            });
            SVApp._dbSessionId = dbResult.sessionId;
            console.log('[app] SQLite recording started — session #' + dbResult.sessionId);
        } catch (err) {
            console.warn('[app] SQLite session start failed (non-fatal):', err);
            SVApp._dbSessionId = null;
        }

        startPolling();
    } catch (err) {
        console.error('[app] Connect failed:', err);
        SVNavbar.updateStatus('Failed: ' + (err.message || err), 'error');
    }
}

async function disconnect(isAutoStop = false) {
    try {
        await backendCall('capture_stop');
        await backendCall('capture_close');
    } catch (err) {
        console.error('[app] Disconnect error:', err);
    }

    SVApp.connected = false;
    SVApp._pollInFlight = false;
    SVApp._tableDirty = false;
    stopPolling();
    stopRenderLoop();

    // End SQLite recording session (before timing, since timing may trigger repeat)
    const totalFrames = SVApp.lastFrameIndex;
    if (SVApp._dbSessionId) {
        try {
            const analysis = SVApp._lastAnalysis || {};
            await backendCall('db_end_session', {
                sessionId: SVApp._dbSessionId,
                summary: {
                    frameCount: analysis.totalFrames || totalFrames || 0,
                    durationMs: SVTiming._firstPacketTime > 0
                        ? Date.now() - SVTiming._firstPacketTime : 0,
                    dataTimeMs: SVTiming._activeDataTimeMs || 0,
                    avgFrameRate: SVTiming._timingStats?.avgFrameRate || 0,
                    missingCount: analysis.missingCount || 0,
                    oooCount: analysis.outOfOrderCount || 0,
                    duplicateCount: analysis.duplicateCount || 0,
                    errorCount: analysis.errorCount || 0,
                }
            });
            console.log('[app] SQLite session #' + SVApp._dbSessionId + ' ended');
        } catch (err) {
            console.warn('[app] SQLite session end failed (non-fatal):', err);
        }
        SVApp._dbSessionId = null;
    }

    // End timing session — check if repeat is needed
    let shouldRepeat = false;

    if (isAutoStop) {
        // Timed capture ended — check repeat
        const result = SVTiming.endSession(totalFrames);
        shouldRepeat = result.shouldRepeat;
    } else {
        // User manually stopped — force-stop all repeats
        SVTiming.forceStop(totalFrames);
    }

    if (shouldRepeat) {
        // Schedule repeat: reset → reconnect after brief pause
        SVNavbar.updateStatus('Restarting...', 'connected');
        setTimeout(async () => {
            await resetAll();
            await connect();
        }, 1000);
    } else {
        SVNavbar.updateStatus('Disconnected', 'disconnected');
        SVNavbar.setConnectedState(false);
        SVConfig.setDisabled(false);
        SVTiming.setDisabled(false);
    }
}

/**
 * Called by SVTiming when a timed capture duration expires.
 * Triggers auto-stop → potential repeat cycle.
 */
function onTimedCaptureExpired() {
    if (!SVApp.connected) return;
    console.log('[app] Timed capture expired — auto-stopping');
    disconnect(true); // true = auto-stop, triggers repeat check
}

async function resetAll() {
    await backendCall('reset');
    SVApp.lastFrameIndex = 0;
    SVApp._rowBuffer = [];
    SVApp._pendingAnalysisFrames = [];
    SVApp._pendingChartFrames = [];
    SVApp._channelsDetected = false;
    SVApp._tableDirty = false;
    SVApp._dataReceived = false;
    SVApp._lastAnalysis = null;
    SVApp._rowCounter = 0;
    SVApp._firstTimestamp = null;

    SVTable.clear();
    SVAnalysis.clear();
    SVFrameView.clear();
    SVChart.clear();
    SVPhasor.clear();
    SVTiming.clear();

    SVStats.updateCards({
        totalFrames: 0, svID: '—', missingCount: 0,
        outOfOrderCount: 0, duplicateCount: 0, errorCount: 0, lastSmpCnt: '—'
    });
    SVStats.updateFooter(0, 20000, SVApp.connected);
    SVConfig.resetDisplay();

    console.log('[app] State reset');
}

// ============================================================================
// Data Polling — Fetches data from C++ ring buffer
// ============================================================================

function startPolling() {
    if (SVApp.pollInterval) return;
    SVApp.pollInterval = true;
    schedulePoll();
    startRenderLoop();
    console.log('[app] Polling started at', SVApp.pollRate, 'ms');
}

function stopPolling() {
    SVApp.pollInterval = false;
    console.log('[app] Polling stopped');
}

/** Fixed-rate render loop — independent of polling.
 *  Runs every 1000ms (1×/sec). Only does work when _tableDirty is set.
 *  This is the KEY fix: rendering is decoupled from data arrival rate. */
function startRenderLoop() {
    if (SVApp._renderTimer) return;
    SVApp._renderTimer = setInterval(renderUI, 1000);
    console.log('[app] Render loop started (1000ms interval)');
}

function stopRenderLoop() {
    if (SVApp._renderTimer) {
        clearInterval(SVApp._renderTimer);
        SVApp._renderTimer = null;
    }
}

/** Schedule next poll AFTER current one finishes — prevents stacking */
function schedulePoll() {
    if (!SVApp.pollInterval) return;
    setTimeout(async () => {
        await pollData();
        schedulePoll();
    }, SVApp.pollRate);
}

/**
 * Poll data from C++ backend.
 *
 * KEY DESIGN: Polling is DECOUPLED from rendering.
 *   - Poll: fetch data → push to JS buffer → update stats (cheap) → done
 *   - Render: single deduped rAF → replaceData on Tabulator (only visible rows)
 *
 * This prevents rAF stacking — multiple polls can run between renders,
 * buffer accumulates, but only ONE render ever fires per animation frame.
 */
async function pollData() {
    if (!SVApp.connected || SVApp._pollInFlight) return;
    SVApp._pollInFlight = true;

    try {
        const result = await backendCall('poll_data', {
            startIndex: SVApp.lastFrameIndex,
            maxFrames: 2000
        });

        if (!result) return;

        // ── Detect backend reset (auto-detect smpCntMax triggers full reset) ──
        // After reset, g_totalReceived restarts from 0 while lastFrameIndex is stale.
        // Without this check, poll always sends startIndex > totalReceived = empty forever.
        if (result.totalReceived !== undefined && result.totalReceived < SVApp.lastFrameIndex) {
            console.warn('[app] Backend reset detected (totalReceived=%d < lastFrameIndex=%d) — resync',
                         result.totalReceived, SVApp.lastFrameIndex);
            SVApp.lastFrameIndex = 0;
            SVApp._rowBuffer = [];
            SVApp._lastRenderedIndex = 0;
            SVTable._lastRenderedIndex = 0;
            SVTable._tableRowCount = 0;
            // Soft-reset chart timeline (keeps plot alive, no placeholder flash)
            SVApp._pendingChartFrames = [];
            SVChart.resetData();
        }

        const hasFrames = result.frames && result.frames.length > 0;

        // ── Adaptive poll rate ──
        // Ring nearly full (≥80% of maxFrames returned): poll faster to drain.
        // Idle (no frames): back off to reduce unnecessary IPC pressure.
        if (hasFrames && result.frames.length >= 1600) {
            SVApp.pollRate = Math.max(SVApp.pollRate - 50, SVApp.pollRateMin);
        } else if (!hasFrames) {
            SVApp.pollRate = Math.min(SVApp.pollRate + 100, SVApp.pollRateMax);
        } else {
            SVApp.pollRate = 300;
        }

        // ── Stats update (cheap textContent, no DOM creation — safe to do inline) ──
        if (result.analysis) {
            SVStats.updateCards(result.analysis);
            SVApp._lastAnalysis = result.analysis;  // Store for DB session end
        }
        if (result.captureStats) SVStats.updateCapture(result.captureStats);

        // ── Config bar / badge updates (throttled to 1×/sec) ──
        // These update DOM elements that change slowly (detected sample rate,
        // capture counters, API-mode badge, timestamp precision badge).
        // Running them on every poll (~3×/sec) wastes main-thread time for
        // changes the user can't perceive at that frequency.
        const _now = Date.now();
        if (!SVApp._lastBadgeUpdate || (_now - SVApp._lastBadgeUpdate) >= 1000) {
            SVApp._lastBadgeUpdate = _now;
            SVConfig.update(result.analysis || null, result.captureStats || null);
            if (result.analysis) SVConfig.updateNpcapApiBadge(result.analysis);
            if (result.timestampInfo) SVConfig.updateTimestampBadge(result.timestampInfo);
            SVTiming.update(result.analysis || null, result.captureStats || null);
        }

        // ── Phasor data (DFT/FFT computed in C++ MKL backend) ──
        if (result.phasor) {
            SVPhasor.update(result.phasor);
        } else if (result.frames && result.frames.length > 0) {
            console.warn('[app] poll result has frames but NO phasor key!', Object.keys(result));
        }

        // ── Timing session live updates handled in throttled block above ──

        if (result.status) {
            SVStats.updateFooter(
                result.status.bufferUsed || 0,
                result.status.bufferCapacity || 20000,
                SVApp.connected
            );
        }

        // ── Handle gap: C++ reports if ring buffer overflowed since last read ──
        if (result.gap) {
            console.warn('[app] Ring buffer overflow — %d frames lost (indices %d–%d). Analysis counters are still accurate.',
                         (result.gapTo || 0) - (result.gapFrom || 0) + 1,
                         result.gapFrom || 0, result.gapTo || 0);
            // Replace buffer entirely on next batch — don't concatenate across gap
            SVApp._rowBuffer = [];
            // Soft-reset chart timeline (keeps plot alive, no placeholder flash)
            SVApp._pendingChartFrames = [];
            SVChart.resetData();
        }

        // ── Handle JSON truncation (4 MB C++ buffer reached) ──
        // C++ set truncated:true instead of silently cutting off JSON.
        // Accept the partial frame batch — analysis totals are still accurate.
        if (result.truncated) {
            console.warn('[app] Poll response truncated — partial frame batch accepted');
        }

        // ── Buffer new rows (NO DOM work — just array push) ──
        if (hasFrames) {
            // Update navbar on first data arrival
            if (!SVApp._dataReceived) {
                SVApp._dataReceived = true;
                SVNavbar.updateStatus('Capturing', 'connected');
            }

            // Track position using actual returned frame index (not count).
            // This ensures we resume from the correct position on next poll.
            SVApp.lastFrameIndex = result.frames[result.frames.length - 1].index + 1;

            // One-time channel detection
            if (!SVApp._channelsDetected && result.frames[0].channelCount) {
                SVApp.channelCount = result.frames[0].channelCount;
                SVApp._channelsDetected = true;
                SVTable.addChannelColumns(SVApp.channelCount);
            }

            // Map lean frames → flat rows with pre-computed search string
            for (const f of result.frames) {
                const quality = SVTable.getPacketQuality(f);
                SVApp._rowCounter = (SVApp._rowCounter || 0) + 1;
                // Compute relative time from capture start
                if (f.timestamp && !SVApp._firstTimestamp) {
                    SVApp._firstTimestamp = f.timestamp;
                }
                const relTimeUs = (f.timestamp && SVApp._firstTimestamp)
                    ? (f.timestamp - SVApp._firstTimestamp) : 0;

                const row = {
                    index:    f.index,       // Hidden: used for backend get_frame_detail
                    rowNum:   SVApp._rowCounter, // Visible: user-friendly 1, 2, 3...
                    timestamp: f.timestamp || 0, // Raw pcap timestamp (microseconds)
                    relTime:  relTimeUs,     // Microseconds since capture start
                    svID:     f.svID,
                    smpCnt:   f.smpCnt,
                    errors:   f.errors,
                    analysis: f.analysis,
                    noASDU:   f.noASDU || 1,   // Original wire frame ASDU count
                    asduIndex: f.asduIndex || 0, // Which ASDU within the wire frame
                    _quality: quality,
                };
                // Build flat channel fields + search string parts
                const searchParts = [f.index, f.svID, f.smpCnt, quality];
                if (f.channels) {
                    for (let i = 0; i < f.channels.length; i++) {
                        row[`ch_${i}`] = f.channels[i];
                        searchParts.push(f.channels[i]);
                    }
                }
                // Pre-computed lowercase string for O(1) text search
                row._searchStr = searchParts.join(' ').toLowerCase();
                SVApp._rowBuffer.push(row);
            }

            // Trim buffer (slice avoids O(n) element shifting of splice)
            if (SVApp._rowBuffer.length > SVApp._maxBufferRows) {
                SVApp._rowBuffer = SVApp._rowBuffer.slice(-SVApp._maxBufferRows);
            }

            // Queue analysis frames (only if analysis tab is visible)
            if (SVApp.activeTab === 'analysis') {
                for (const f of result.frames) {
                    SVApp._pendingAnalysisFrames.push(f);
                }
                // Cap pending queue to prevent memory growth
                if (SVApp._pendingAnalysisFrames.length > 200) {
                    SVApp._pendingAnalysisFrames.splice(0,
                        SVApp._pendingAnalysisFrames.length - 200);
                }
            }

            // Always queue chart frames (chart buffers internally)
            for (const f of result.frames) {
                SVApp._pendingChartFrames.push(f);
            }
            // Cap pending chart queue
            if (SVApp._pendingChartFrames.length > 10000) {
                SVApp._pendingChartFrames.splice(0,
                    SVApp._pendingChartFrames.length - 10000);
            }
            SVApp._chartAnalysis = result.analysis || null;

            SVApp._tableDirty = true;
        }

    } catch (err) {
        console.error('[app] Poll error:', err);
        // Backoff on repeated errors to prevent crash loop
        SVApp.pollRate = Math.min(SVApp.pollRate + 200, SVApp.pollRateMax);
    } finally {
        SVApp._pollInFlight = false;
    }
}

/**
 * Batched UI render — runs via fixed setInterval (500ms = 2×/sec).
 *
 * CRITICAL DESIGN:
 *   - Completely independent of poll rate
 *   - Skips immediately if no new data (_tableDirty check)
 *   - Multiple polls between renders just accumulate in _rowBuffer
 *   - Fixed 2×/sec ensures UI stays responsive regardless of data rate
 */
function renderUI() {
    if (!SVApp._tableDirty) return; // Nothing new — skip entirely

    // ── Table: skip replacement while user is actively searching/filtering ──
    // Data continues buffering; _tableDirty stays true so next tick catches up
    if (SVApp._rowBuffer.length > 0 && !SVApp._userInteracting) {
        SVApp._tableDirty = false;
        SVTable.replaceRows(SVApp._rowBuffer);
    }

    // ── Analysis tab (only process when visible) ──
    if (SVApp.activeTab === 'analysis') {
        // Process accumulated analysis events
        if (SVApp._pendingAnalysisFrames.length > 0) {
            SVAnalysis.addNewFrames(SVApp._pendingAnalysisFrames);
            SVApp._pendingAnalysisFrames = [];
        }

        // Throttled frame viewer — max 1×/sec, requires full detail fetch
        if (!SVFrameView._currentFrame && SVApp._rowBuffer.length > 0) {
            const now = Date.now();
            if (now - SVApp._lastFrameViewUpdate > SVApp._frameViewThrottleMs) {
                SVApp._lastFrameViewUpdate = now;
                const lastIdx = SVApp._rowBuffer[SVApp._rowBuffer.length - 1].index;
                backendCall('get_frame_detail', { frameIndex: lastIdx })
                    .then(detail => {
                        if (detail && typeof detail === 'object') {
                            SVFrameView.showFrame(detail);
                        }
                    })
                    .catch(() => {
                        // Fallback: build frame from last row buffer entry
                        const last = SVApp._rowBuffer[SVApp._rowBuffer.length - 1];
                        if (last) SVFrameView.showFrame(SVTable._rowToFrame(last));
                    });
            }
        }
    }
    // ── Chart tab (always process — chart handles its own buffering) ──
    if (SVApp._pendingChartFrames.length > 0) {
        SVChart.addFrames(SVApp._pendingChartFrames, SVApp._chartAnalysis);
        SVApp._pendingChartFrames = [];
    }
}

// ============================================================================
// Tab Management
// ============================================================================

/**
 * Switch to a tab programmatically (also used by row click → analysis).
 * @param {string} tabId - 'table' or 'analysis'
 */
function switchToTab(tabId) {
    if (SVApp.activeTab === tabId) return;

    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    document.getElementById('tab-' + tabId).classList.add('active');
    SVApp.activeTab = tabId;
}

function initTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchToTab(tab.dataset.tab));
    });
}


