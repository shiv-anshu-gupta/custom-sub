/**
 * @file components/stats.js
 * @brief Statistics cards and footer component
 *
 * Displays analysis summary cards:
 *   Total Frames | Stream ID | Missing | Out-of-Order |
 *   Errors | Last SmpCnt | Pkts/sec
 *
 * Also manages the footer status bar and capture stats updates.
 */

const SVStats = {

    /**
     * Returns the stat cards row HTML template
     * @returns {string} HTML string
     */
    getTemplate() {
        return `
            <div class="cards-row">
                <div class="card card-stat">
                    <div class="card-label">Total Frames</div>
                    <div class="card-value" id="statTotalFrames">0</div>
                </div>
                <div class="card card-stat">
                    <div class="card-label">Stream ID</div>
                    <div class="card-value" id="statSvID">—</div>
                </div>
                <div class="card card-stat card-ok">
                    <div class="card-label">Missing Seq</div>
                    <div class="card-value" id="statMissing">0</div>
                </div>
                <div class="card card-stat card-ok">
                    <div class="card-label">Out-of-Order</div>
                    <div class="card-value" id="statOutOfOrder">0</div>
                </div>
                <div class="card card-stat card-ok">
                    <div class="card-label">Errors</div>
                    <div class="card-value" id="statErrors">0</div>
                </div>
                <div class="card card-stat">
                    <div class="card-label">Last SmpCnt</div>
                    <div class="card-value" id="statLastSmpCnt">—</div>
                </div>
                <div class="card card-stat">
                    <div class="card-label">Pkts/sec</div>
                    <div class="card-value" id="statPktRate">0</div>
                </div>
                <div class="card card-stat">
                    <div class="card-label">Capture Time</div>
                    <div class="card-value card-value-sm" id="statCaptureTime">00:00</div>
                </div>
            </div>
        `;
    },

    init() {
        // Cache DOM references — eliminates ~15 getElementById calls per 250ms poll
        this._dom = {
            totalFrames: document.getElementById('statTotalFrames'),
            svID:        document.getElementById('statSvID'),
            missing:     document.getElementById('statMissing'),
            outOfOrder:  document.getElementById('statOutOfOrder'),
            errors:      document.getElementById('statErrors'),
            lastSmpCnt:  document.getElementById('statLastSmpCnt'),
            pktRate:     document.getElementById('statPktRate'),            captureTime:  document.getElementById('statCaptureTime'),            footerBuffer: document.getElementById('footerBuffer'),
            footerStatus: document.getElementById('footerStatus'),
        };
        // Cache card parent elements — avoids .closest() DOM traversal
        this._cards = {};
        for (const key of ['missing', 'outOfOrder', 'errors']) {
            if (this._dom[key]) this._cards[key] = this._dom[key].closest('.card');
        }
        // Track last written values to skip redundant DOM writes
        this._prev = {};
    },

    /**
     * Update analysis summary cards from C++ backend data
     * @param {Object} data - Analysis summary from poll_data
     */
    updateCards(data) {
        const d = this._dom, p = this._prev;

        const tf = (data.totalFrames || 0).toLocaleString();
        if (p.tf !== tf) { d.totalFrames.textContent = tf; p.tf = tf; }

        const sid = data.svID || '—';
        if (p.sid !== sid) { d.svID.textContent = sid; p.sid = sid; }

        const setCard = (key, value, warnAt, errorAt) => {
            const formatted = (value || 0).toLocaleString();
            if (p[key] !== formatted) { d[key].textContent = formatted; p[key] = formatted; }
            const cls = value >= errorAt ? 'card-error' : (value >= warnAt ? 'card-warn' : 'card-ok');
            if (p[key + 'C'] !== cls) {
                this._cards[key].className = 'card card-stat ' + cls;
                p[key + 'C'] = cls;
            }
        };

        setCard('missing', data.missingCount, 1, 10);
        setCard('outOfOrder', data.outOfOrderCount, 1, 5);
        setCard('errors', data.errorCount, 1, 5);

        const sc = data.lastSmpCnt !== undefined ? String(data.lastSmpCnt) : '—';
        if (p.sc !== sc) { d.lastSmpCnt.textContent = sc; p.sc = sc; }
    },

    /**
     * Update capture statistics (packet rate only — config bar elements
     * are now managed by SVConfig.update() for proper ownership)
     * @param {Object} stats - Capture stats from poll_data
     */
    updateCapture(stats) {
        const p = this._prev;

        // Calculate packet rate (Pkts/sec card in stats row)
        const now = Date.now();
        if (SVApp.lastStatTime > 0) {
            const dt = (now - SVApp.lastStatTime) / 1000;
            if (dt > 0.1) {
                const dPkts = (stats.packetsSV || 0) - SVApp.lastStatTotal;
                const rate = Math.round(dPkts / dt).toLocaleString();
                if (p.rate !== rate && this._dom.pktRate) {
                    this._dom.pktRate.textContent = rate; p.rate = rate;
                }
            }
        }
        SVApp.lastStatTime = now;
        SVApp.lastStatTotal = stats.packetsSV || 0;

        // Capture elapsed time — only show when actual SV packets have been received
        // (C++ captureElapsedMs counts from capture_start, but we only display
        //  once packetsSV > 0 to avoid misleading "running" when no data flows)
        if (stats.captureElapsedMs !== undefined && this._dom.captureTime) {
            if ((stats.packetsSV || 0) > 0) {
                const elapsed = stats.captureElapsedMs;
                const sec = Math.floor(elapsed / 1000);
                const m = Math.floor(sec / 60);
                const s = sec % 60;
                const timeStr = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
                if (p.capTime !== timeStr) {
                    this._dom.captureTime.textContent = timeStr;
                    p.capTime = timeStr;
                }
            } else {
                // No SV packets yet — show waiting indicator
                if (p.capTime !== '—') {
                    this._dom.captureTime.textContent = '—';
                    p.capTime = '—';
                }
            }
        }
    },

    /**
     * Update footer status bar
     * @param {number} used     - Ring buffer frames used
     * @param {number} capacity - Ring buffer total capacity
     * @param {boolean} connected - Current connection state
     */
    updateFooter(used, capacity, connected) {
        const p = this._prev;
        const buf = `Buffer: ${used.toLocaleString()} / ${capacity.toLocaleString()}`;
        if (p.buf !== buf) { this._dom.footerBuffer.textContent = buf; p.buf = buf; }
        const st = connected ? 'Receiving data...' : 'Ready';
        if (p.st !== st) { this._dom.footerStatus.textContent = st; p.st = st; }
    }
};
