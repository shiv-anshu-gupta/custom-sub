/**
 * @file components/phasor.js
 * @brief Phasor Diagram Component — Visual display of DFT/FFT phasor results
 *
 * Displays a polar phasor diagram (circle with rotating arrows) for
 * voltage and current channels computed by the MKL FFT backend.
 *
 * Data flow:
 *   C++ sv_phasor (MKL FFT) → poll_data JSON → app.js → SVPhasor.update()
 *
 * Features:
 *   - Canvas-based phasor diagram with magnitude arrows
 *   - Color-coded channels (Va/Vb/Vc = red/green/blue, Ia/Ib/Ic = orange/cyan/purple)
 *   - Half-cycle / Full-cycle toggle (calls set_phasor_mode Tauri command)
 *   - Values legend with magnitude + angle per channel
 *   - Auto-scaling: arrows scale to largest magnitude
 */

const SVPhasor = {

    /** @private Canvas rendering context */
    _ctx: null,
    _canvas: null,
    _initialized: false,

    /** @private Last phasor data from poll */
    _data: null,

    /** @private Current mode: 0 = half-cycle, 1 = full-cycle */
    _mode: 1,

    /** @private Channel appearance (lookup table — only entries matching actual channelCount are used) */
    _colors: [
        '#f85149', '#3fb950', '#58a6ff', '#d29922',   // Ch0 Ch1 Ch2 Ch3
        '#f0883e', '#39d2c0', '#bc8cff', '#8b949e',   // Ch4 Ch5 Ch6 Ch7
        '#e3b341', '#f778ba', '#a5d6ff', '#7ee787',   // Ch8  Ch9  Ch10 Ch11
        '#ffa657', '#d2a8ff', '#56d4dd', '#ff7b72',   // Ch12 Ch13 Ch14 Ch15
        '#79c0ff', '#b1bac4', '#ffd33d', '#ff9bce',   // Ch16 Ch17 Ch18 Ch19
    ],
    _names: [
        'Ch0', 'Ch1', 'Ch2', 'Ch3', 'Ch4', 'Ch5', 'Ch6', 'Ch7',
        'Ch8', 'Ch9', 'Ch10', 'Ch11', 'Ch12', 'Ch13', 'Ch14', 'Ch15',
        'Ch16', 'Ch17', 'Ch18', 'Ch19',
    ],

    /** @private Animation state */
    _animFrame: null,

    // ====================================================================
    // TEMPLATE
    // ====================================================================

    getTemplate() {
        return `
        <div class="phasor-panel" id="phasorPanel">
            <div class="phasor-layout">
                <!-- Left: Canvas Diagram -->
                <div class="phasor-diagram-wrap">
                    <div class="phasor-toolbar">
                        <span class="phasor-title">⚡ Phasor Diagram</span>
                        <div class="phasor-mode-toggle">
                            <button class="phasor-mode-btn active" data-mode="1" id="btnFullCycle">Full Cycle</button>
                            <button class="phasor-mode-btn" data-mode="0" id="btnHalfCycle">Half Cycle</button>
                        </div>
                        <span class="phasor-status" id="phasorStatus">Waiting for data...</span>
                    </div>
                    <canvas id="phasorCanvas" width="500" height="500"></canvas>
                </div>

                <!-- Right: Values Legend -->
                <div class="phasor-legend" id="phasorLegend">
                    <div class="phasor-legend-title">Channel Values</div>
                    <div class="phasor-legend-header">
                        <span class="phasor-legend-ch">Ch</span>
                        <span class="phasor-legend-mag">Magnitude</span>
                        <span class="phasor-legend-ang">Angle (°)</span>
                    </div>
                    <div id="phasorLegendRows"></div>
                    <div class="phasor-info" id="phasorInfo">
                        <div>Mode: <span id="phasorModeLabel">Full Cycle</span></div>
                        <div>Window: <span id="phasorWindowSize">—</span> samples</div>
                        <div>SPC: <span id="phasorSPC">—</span></div>
                        <div>Computations: <span id="phasorComputeCount">0</span></div>
                    </div>
                </div>
            </div>
        </div>
        `;
    },

    // ====================================================================
    // INIT
    // ====================================================================

    init() {
        this._canvas = document.getElementById('phasorCanvas');
        if (!this._canvas) return;
        this._ctx = this._canvas.getContext('2d');
        this._initialized = true;

        // Mode toggle buttons
        document.getElementById('btnFullCycle').addEventListener('click', () => this.setMode(1));
        document.getElementById('btnHalfCycle').addEventListener('click', () => this.setMode(0));

        // Draw empty diagram
        this._drawEmpty();
    },

    // ====================================================================
    // MODE SWITCHING
    // ====================================================================

    async setMode(mode) {
        this._mode = mode;

        // Update button states
        document.getElementById('btnFullCycle').classList.toggle('active', mode === 1);
        document.getElementById('btnHalfCycle').classList.toggle('active', mode === 0);

        // Update label
        document.getElementById('phasorModeLabel').textContent = mode === 1 ? 'Full Cycle' : 'Half Cycle';

        // Send to backend
        try {
            await backendCall('set_phasor_mode', { mode });
        } catch (err) {
            console.error('[phasor] set_phasor_mode failed:', err);
        }
    },

    // ====================================================================
    // UPDATE — called from app.js with poll data
    // ====================================================================

    /**
     * Update phasor display with new data from poll
     * @param {Object} phasorData - { valid, mode, windowSize, samplesPerCycle, computeCount, timestamp, channels: [{mag, ang}] }
     */
    update(phasorData) {
        if (!this._initialized || !phasorData) return;
        this._data = phasorData;

        // Debug: log first few updates to help diagnose issues
        if (!this._logCount) this._logCount = 0;
        if (this._logCount < 10) {
            console.log('[phasor] update:', JSON.stringify(phasorData));
            this._logCount++;
        }

        // Update info panel (always, even when not valid — helps debug)
        document.getElementById('phasorWindowSize').textContent = phasorData.windowSize || '—';
        document.getElementById('phasorSPC').textContent = phasorData.samplesPerCycle || '—';
        document.getElementById('phasorComputeCount').textContent = phasorData.computeCount || 0;
        document.getElementById('phasorModeLabel').textContent =
            phasorData.mode === 0 ? 'Half Cycle' : 'Full Cycle';

        if (phasorData.valid && phasorData.channels && phasorData.channels.length > 0) {
            document.getElementById('phasorStatus').textContent =
                `Compute #${phasorData.computeCount} — ${phasorData.channels.length} ch`;
            document.getElementById('phasorStatus').className = 'phasor-status phasor-status-ok';

            this._updateLegend(phasorData.channels);
            this._drawDiagram(phasorData.channels);
        } else {
            // Show diagnostic info in status
            const reason = !phasorData.valid ? 'valid=false' :
                           (!phasorData.channels ? 'no channels' :
                            'channels empty');
            document.getElementById('phasorStatus').textContent =
                `Waiting... (${reason}, compute=${phasorData.computeCount || 0}, spc=${phasorData.samplesPerCycle || 0}, win=${phasorData.windowSize || 0})`;
            document.getElementById('phasorStatus').className = 'phasor-status';
            this._drawEmpty();
        }
    },

    // ====================================================================
    // LEGEND — channel values table
    // ====================================================================

    _updateLegend(channels) {
        const container = document.getElementById('phasorLegendRows');
        if (!container) return;

        let html = '';
        for (let i = 0; i < channels.length; i++) {
            const ch = channels[i];
            const name = this._names[i] || `Ch${i}`;
            const color = this._colors[i] || '#8b949e';
            const mag = ch.mag !== undefined ? ch.mag.toFixed(2) : '—';
            const ang = ch.ang !== undefined ? ch.ang.toFixed(2) : '—';

            html += `
                <div class="phasor-legend-row">
                    <span class="phasor-legend-ch">
                        <span class="phasor-ch-dot" style="background:${color}"></span>
                        ${name}
                    </span>
                    <span class="phasor-legend-mag">${mag}</span>
                    <span class="phasor-legend-ang">${ang}°</span>
                </div>
            `;
        }
        container.innerHTML = html;
    },

    // ====================================================================
    // CANVAS — Phasor Diagram Drawing
    // ====================================================================

    _drawEmpty() {
        if (!this._ctx) return;
        const ctx = this._ctx;
        const W = this._canvas.width;
        const H = this._canvas.height;
        const cx = W / 2;
        const cy = H / 2;
        const R = Math.min(cx, cy) - 40;

        ctx.clearRect(0, 0, W, H);
        this._drawGrid(ctx, cx, cy, R);

        // "No data" text
        ctx.fillStyle = '#6e7681';
        ctx.font = '14px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Waiting for phasor data...', cx, cy);
    },

    _drawGrid(ctx, cx, cy, R) {
        // Background
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);

        // Concentric circles (25%, 50%, 75%, 100%)
        ctx.strokeStyle = '#21262d';
        ctx.lineWidth = 1;
        for (let frac = 0.25; frac <= 1.0; frac += 0.25) {
            ctx.beginPath();
            ctx.arc(cx, cy, R * frac, 0, 2 * Math.PI);
            ctx.stroke();
        }

        // Cross-hairs (axes)
        ctx.strokeStyle = '#30363d';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - R - 10, cy);
        ctx.lineTo(cx + R + 10, cy);
        ctx.moveTo(cx, cy - R - 10);
        ctx.lineTo(cx, cy + R + 10);
        ctx.stroke();

        // Axis labels
        ctx.fillStyle = '#6e7681';
        ctx.font = '11px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('0°', cx + R + 20, cy + 4);
        ctx.fillText('90°', cx, cy - R - 14);
        ctx.fillText('180°', cx - R - 22, cy + 4);
        ctx.fillText('270°', cx, cy + R + 18);

        // 30-degree radial tick marks
        ctx.strokeStyle = '#21262d';
        ctx.lineWidth = 0.5;
        for (let deg = 0; deg < 360; deg += 30) {
            if (deg % 90 === 0) continue; // skip axes
            const rad = deg * Math.PI / 180;
            ctx.beginPath();
            ctx.moveTo(cx + (R - 5) * Math.cos(rad), cy - (R - 5) * Math.sin(rad));
            ctx.lineTo(cx + (R + 5) * Math.cos(rad), cy - (R + 5) * Math.sin(rad));
            ctx.stroke();
        }
    },

    _drawDiagram(channels) {
        if (!this._ctx) return;
        const ctx = this._ctx;
        const W = this._canvas.width;
        const H = this._canvas.height;
        const cx = W / 2;
        const cy = H / 2;
        const R = Math.min(cx, cy) - 40;

        ctx.clearRect(0, 0, W, H);
        this._drawGrid(ctx, cx, cy, R);

        // Find max magnitude for auto-scaling
        let maxMag = 0;
        for (const ch of channels) {
            if (ch.mag > maxMag) maxMag = ch.mag;
        }
        if (maxMag === 0) maxMag = 1; // avoid division by zero

        // Separate V and I channels for layered drawing
        // Draw I channels first (behind), then V channels (on top)
        const vChannels = []; // indices 0-3
        const iChannels = []; // indices 4-7

        for (let i = 0; i < channels.length; i++) {
            if (i < 4) vChannels.push(i);
            else iChannels.push(i);
        }

        // Draw I channels (thinner, behind)
        for (const i of iChannels) {
            this._drawArrow(ctx, cx, cy, R, channels[i], maxMag, this._colors[i], 2.5, 0.6);
        }

        // Draw V channels (thicker, on top)
        for (const i of vChannels) {
            this._drawArrow(ctx, cx, cy, R, channels[i], maxMag, this._colors[i], 3.5, 1.0);
        }

        // Draw center dot
        ctx.fillStyle = '#e6edf3';
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
        ctx.fill();

        // Scale label (in corner)
        ctx.fillStyle = '#6e7681';
        ctx.font = '10px Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`Scale: ${maxMag.toFixed(1)} = 100%`, 10, H - 10);
    },

    /**
     * Draw a single phasor arrow
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} cx - center x
     * @param {number} cy - center y
     * @param {number} R  - max radius
     * @param {Object} ch - { mag, ang } (angle in degrees)
     * @param {number} maxMag - for normalization
     * @param {string} color
     * @param {number} lineWidth
     * @param {number} alpha - opacity (0-1)
     */
    _drawArrow(ctx, cx, cy, R, ch, maxMag, color, lineWidth, alpha) {
        if (!ch || ch.mag === undefined || ch.mag === 0) return;

        const normMag = ch.mag / maxMag;       // 0..1
        const len = normMag * R * 0.9;          // arrow length (90% of radius max)
        const rad = (ch.ang || 0) * Math.PI / 180; // convert to radians

        // Arrow tip position (standard math: 0° = right, CCW positive)
        // Canvas Y is inverted, so we negate the sin component
        const tipX = cx + len * Math.cos(rad);
        const tipY = cy - len * Math.sin(rad);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';

        // Draw shaft
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();

        // Draw arrowhead
        const headLen = 10;
        const headAngle = 0.4; // ~23 degrees
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(
            tipX - headLen * Math.cos(rad - headAngle),
            tipY + headLen * Math.sin(rad - headAngle)
        );
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(
            tipX - headLen * Math.cos(rad + headAngle),
            tipY + headLen * Math.sin(rad + headAngle)
        );
        ctx.stroke();

        // Draw label at tip
        const labelDist = len + 16;
        const labelX = cx + labelDist * Math.cos(rad);
        const labelY = cy - labelDist * Math.sin(rad);

        ctx.globalAlpha = 1.0;
        ctx.font = 'bold 11px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
            (this._names[this._getChannelIndex(ch, color)] || ''),
            labelX, labelY
        );

        ctx.restore();
    },

    /**
     * Reverse-lookup channel index from color (for label)
     */
    _getChannelIndex(ch, color) {
        return this._colors.indexOf(color);
    },

    // ====================================================================
    // RESET / CLEAR
    // ====================================================================

    clear() {
        this._data = null;
        if (this._initialized) {
            this._drawEmpty();
            const container = document.getElementById('phasorLegendRows');
            if (container) container.innerHTML = '';
            document.getElementById('phasorComputeCount').textContent = '0';
            document.getElementById('phasorWindowSize').textContent = '—';
            document.getElementById('phasorSPC').textContent = '—';
            document.getElementById('phasorStatus').textContent = 'Waiting for data...';
            document.getElementById('phasorStatus').className = 'phasor-status';
        }
    },
};
