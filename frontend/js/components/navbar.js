/**
 * @file components/navbar.js
 * @brief Top navigation bar component
 *
 * Contains: App branding, connection status indicator,
 * network interface selector, connect/disconnect/reset buttons.
 *
 * Template is injected by app.js, init() binds all events.
 */

const SVNavbar = {

    /** @private Callback references set during init() */
    _callbacks: {},

    /**
     * Returns the navbar HTML template
     * @returns {string} HTML string
     */
    getTemplate() {
        return `
            <nav class="navbar">
                <div class="nav-brand">
                    <span class="nav-icon">⚡</span>
                    <span class="nav-title">SV Subscriber</span>
                    <span class="nav-subtitle">IEC 61850-9-2LE</span>
                </div>
                <div class="nav-controls">
                    <div class="status-indicator" id="statusIndicator">
                        <span class="status-dot disconnected"></span>
                        <span class="status-text">Disconnected</span>
                    </div>
                    <select id="interfaceSelect" class="input-field nav-select" title="Select network interface">
                        <option value="">-- Select Interface --</option>
                    </select>
                    <button class="btn btn-secondary btn-sm" id="btnRefreshInterfaces" title="Refresh interface list">🔄</button>
                    <button class="btn btn-primary" id="btnConnect" title="Start SV capture">▶ Capture</button>
                    <button class="btn btn-danger" id="btnDisconnect" title="Stop capture" style="display:none;">⏹ Stop</button>
                    <button class="btn btn-secondary" id="btnReset" title="Reset all data">↻ Reset</button>
                    <button class="btn btn-export" id="btnExportPcap" title="Export last session as PCAP file">💾 Export PCAP</button>
                </div>
            </nav>
        `;
    },

    /**
     * Initialize navbar — bind button events
     * @param {Object} callbacks - { onConnect, onDisconnect, onReset }
     */
    init(callbacks = {}) {
        this._callbacks = callbacks;

        document.getElementById('btnConnect').addEventListener('click', () => this._callbacks.onConnect?.());
        document.getElementById('btnDisconnect').addEventListener('click', () => this._callbacks.onDisconnect?.());
        document.getElementById('btnReset').addEventListener('click', () => this._callbacks.onReset?.());
        document.getElementById('btnRefreshInterfaces').addEventListener('click', () => this.refreshInterfaces());
        document.getElementById('btnExportPcap').addEventListener('click', () => this.exportPcap());
    },

    /**
     * Update connection status indicator
     * @param {string} text  - Status text
     * @param {string} state - CSS class: 'connected' | 'disconnected' | 'error'
     */
    updateStatus(text, state) {
        const dot = document.querySelector('.status-dot');
        const label = document.querySelector('.status-text');
        if (dot) dot.className = 'status-dot ' + state;
        if (label) label.textContent = text;
    },

    /**
     * Toggle UI elements based on connection state
     * @param {boolean} connected
     */
    setConnectedState(connected) {
        document.getElementById('btnConnect').style.display = connected ? 'none' : '';
        document.getElementById('btnDisconnect').style.display = connected ? '' : 'none';
        document.getElementById('interfaceSelect').disabled = connected;
    },

    /**
     * Get the currently selected network interface name
     * @returns {string} Interface device name or empty string
     */
    getSelectedInterface() {
        return document.getElementById('interfaceSelect').value;
    },

    /**
     * Fetch network interfaces from C++ Npcap layer and populate dropdown
     */
    async refreshInterfaces() {
        try {
            const result = await backendCall('list_interfaces');
            if (!result || !result.interfaces) return;

            const select = document.getElementById('interfaceSelect');
            const currentValue = select.value;

            select.innerHTML = '<option value="">-- Select Interface --</option>';

            result.interfaces.forEach((iface, idx) => {
                const opt = document.createElement('option');
                opt.value = iface.name;

                let label = `[${idx}] ${iface.description || iface.name}`;
                if (iface.has_mac && iface.mac !== '00:00:00:00:00:00') {
                    label += ` [${iface.mac}]`;
                }
                opt.textContent = label;
                opt.title = iface.name;
                select.appendChild(opt);
            });

            if (currentValue) select.value = currentValue;
            console.log('[navbar] Found', result.interfaces.length, 'interfaces');
        } catch (err) {
            console.error('[navbar] Failed to list interfaces:', err);
        }
    },

    /**
     * Export the most recent completed session as a PCAP file.
     * Queries available sessions, exports the latest one with stored frames.
     */
    async exportPcap() {
        const btn = document.getElementById('btnExportPcap');
        const origText = btn.textContent;

        try {
            btn.disabled = true;
            btn.textContent = '⏳ Exporting...';

            // Get list of sessions
            const result = await backendCall('db_list_sessions');
            if (!result || !result.sessions || result.sessions.length === 0) {
                this.updateStatus('No sessions to export', 'error');
                setTimeout(() => this.updateStatus(
                    SVApp.connected ? 'Capturing' : 'Ready',
                    SVApp.connected ? 'connected' : 'disconnected'
                ), 3000);
                return;
            }

            // Find the latest session with stored frames
            const session = result.sessions.find(s => s.storedFrames > 0);
            if (!session) {
                this.updateStatus('No frames stored yet', 'error');
                setTimeout(() => this.updateStatus(
                    SVApp.connected ? 'Capturing' : 'Ready',
                    SVApp.connected ? 'connected' : 'disconnected'
                ), 3000);
                return;
            }

            // Export PCAP (empty path = save next to database)
            const exportResult = await backendCall('db_export_pcap', {
                sessionId: session.id,
                outputPath: '',
            });

            if (exportResult && exportResult.path) {
                this.updateStatus(`PCAP saved: ${exportResult.path}`, 'connected');
                console.log('[navbar] PCAP exported:', exportResult.path);

                // Reset status after 5 seconds
                setTimeout(() => this.updateStatus(
                    SVApp.connected ? 'Capturing' : 'Ready',
                    SVApp.connected ? 'connected' : 'disconnected'
                ), 5000);
            }
        } catch (err) {
            console.error('[navbar] PCAP export failed:', err);
            this.updateStatus('Export failed: ' + (err.message || err), 'error');
            setTimeout(() => this.updateStatus(
                SVApp.connected ? 'Capturing' : 'Ready',
                SVApp.connected ? 'connected' : 'disconnected'
            ), 4000);
        } finally {
            btn.disabled = false;
            btn.textContent = origText;
        }
    }
};
