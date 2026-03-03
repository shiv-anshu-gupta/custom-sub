/**
 * @file components/frameview.js
 * @brief Read-only Wireshark-style SV Frame Structure Viewer
 *
 * Displays IEC 61850-9-2 SV frame structure in a collapsible tree format,
 * showing the full protocol dissection of a captured frame:
 *
 *   Frame (metadata)
 *   └─ Ethernet II (Src MAC, Dst MAC, VLAN, EtherType)
 *      └─ IEC 61850 Sampled Values (APPID, Length, Reserved)
 *         └─ savPdu / APDU
 *            └─ ASDU (svID, smpCnt, confRev, smpSynch)
 *               └─ seqData (channel values + quality)
 *   Analysis Result (Good / Missing / OOO / Duplicate)
 *
 * Triggered by:
 *   - Clicking a row in SVTable (manual frame selection)
 *   - Auto-update from pollData (shows latest frame when on analysis tab)
 */

const SVFrameView = {

    _initialized: false,
    _expandedNodes: new Set(['frame', 'ethernet', 'sv-pdu', 'apdu', 'asdu-0', 'seqdata-0']),
    _currentFrame: null,

    /**
     * Returns the frame viewer panel HTML template
     * @returns {string} HTML string
     */
    getTemplate() {
        return `
            <div class="frame-viewer-panel" id="frameViewerPanel">
                <div class="fv-panel-header">
                    <h3>🔬 Frame Structure</h3>
                    <div class="fv-header-actions">
                        <button class="btn-sm" id="fvExpandAll" title="Expand All">+ All</button>
                        <button class="btn-sm" id="fvCollapseAll" title="Collapse All">− All</button>
                    </div>
                </div>
                <div class="fv-frame-info" id="fvFrameInfo"></div>
                <div class="fv-placeholder" id="fvPlaceholder">
                    <div class="fv-placeholder-icon">📦</div>
                    <div>Click a row in the Data Table to view its frame structure</div>
                    <div style="margin-top:4px;font-size:11px;">Or start capturing — the latest frame will be shown automatically</div>
                </div>
                <div class="fv-tree" id="fvTree"></div>
            </div>
        `;
    },

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    init() {
        if (this._initialized) return;

        // Global toggle function for onclick handlers in tree nodes
        window.svFrameViewToggle = (nodeId) => this.toggleNode(nodeId);

        // Expand/collapse buttons
        const expandBtn = document.getElementById('fvExpandAll');
        const collapseBtn = document.getElementById('fvCollapseAll');
        if (expandBtn) expandBtn.addEventListener('click', () => this.expandAll());
        if (collapseBtn) collapseBtn.addEventListener('click', () => this.collapseAll());

        this._initialized = true;
        console.log('[frameview] Frame Structure Viewer initialized');
    },

    // ========================================================================
    // PUBLIC API
    // ========================================================================

    /**
     * Display frame structure for a specific captured frame
     * @param {Object} frame - Full frame data from table row or poll_data
     */
    showFrame(frame) {
        if (!frame) return;

        // Gather all sibling ASDUs from the same wire frame
        // They are consecutive rows in the buffer with the same noASDU and timestamp
        frame._siblingAsdus = this._gatherSiblingAsdus(frame);

        this._currentFrame = frame;

        const container = document.getElementById('fvTree');
        const placeholder = document.getElementById('fvPlaceholder');
        const header = document.getElementById('fvFrameInfo');

        if (!container) return;

        // Hide placeholder, show tree
        if (placeholder) placeholder.style.display = 'none';
        container.style.display = 'block';

        // Update header info bar
        if (header) {
            const quality = this._getQualityBadge(frame);
            const noAsdu = frame.noASDU || 1;
            const foundCount = frame._siblingAsdus ? frame._siblingAsdus.length : 1;
            header.innerHTML = `
                <span class="fv-frame-label">Frame #${frame.index}</span>
                <span class="fv-frame-smpcnt">smpCnt: ${frame.smpCnt}</span>
                <span class="fv-frame-svid">svID: ${frame.svID || '—'}</span>
                <span class="fv-frame-svid">${foundCount}/${noAsdu} ASDUs</span>
                ${quality}
            `;
            header.style.display = 'flex';
        }

        // Build and render protocol tree
        const tree = this._buildFrameTree(frame);
        container.innerHTML = tree.map(node => this._createTreeNode(node)).join('');
    },

    /**
     * @private Gather all sibling ASDUs that belong to the same wire frame.
     * Uses the JS row buffer to find consecutive rows with matching noASDU.
     * @param {Object} frame - The clicked frame
     * @returns {Array} Array of frame objects, one per ASDU, sorted by asduIndex
     */
    _gatherSiblingAsdus(frame) {
        const noAsdu = frame.noASDU || 1;
        if (noAsdu <= 1) return [frame];

        const myIndex = frame.index;
        const myAsduIdx = frame.asduIndex || 0;
        const buffer = (typeof SVApp !== 'undefined') ? SVApp._rowBuffer : [];
        if (!buffer || buffer.length === 0) return [frame];

        // The sibling ASDUs should be at frame indices:
        //   myIndex - myAsduIdx  (ASDU 0)
        //   myIndex - myAsduIdx + 1  (ASDU 1)
        //   ... etc
        const firstIndex = myIndex - myAsduIdx;
        const siblings = [];

        for (let i = 0; i < noAsdu; i++) {
            const targetIdx = firstIndex + i;
            const row = buffer.find(r => r.index === targetIdx);
            if (row) {
                siblings.push(row);
            }
        }

        // Sort by asduIndex (or by frame index as fallback)
        siblings.sort((a, b) => {
            const ai = (a.asduIndex !== undefined) ? a.asduIndex : (a.index - firstIndex);
            const bi = (b.asduIndex !== undefined) ? b.asduIndex : (b.index - firstIndex);
            return ai - bi;
        });

        return siblings.length > 0 ? siblings : [frame];
    },

    /**
     * Show the latest frame from a batch (auto-update mode)
     * @param {Array} frames - Array of frames from poll_data
     */
    showLatestFrame(frames) {
        if (!frames || frames.length === 0) return;
        this.showFrame(frames[frames.length - 1]);
    },

    /**
     * Clear the frame viewer back to placeholder state
     */
    clear() {
        const container = document.getElementById('fvTree');
        const placeholder = document.getElementById('fvPlaceholder');
        const header = document.getElementById('fvFrameInfo');

        if (container) { container.innerHTML = ''; container.style.display = 'none'; }
        if (placeholder) placeholder.style.display = 'block';
        if (header) { header.innerHTML = ''; header.style.display = 'none'; }

        this._currentFrame = null;
    },

    // ========================================================================
    // TREE BUILDING — Wireshark-style protocol dissection
    // ========================================================================

    /** @private Build complete frame tree from received frame data */
    _buildFrameTree(frame) {
        const channelCount = frame.channelCount || 0;
        const channelNames = [
            'Ch0', 'Ch1', 'Ch2', 'Ch3', 'Ch4', 'Ch5', 'Ch6', 'Ch7',
            'Ch8', 'Ch9', 'Ch10', 'Ch11', 'Ch12', 'Ch13', 'Ch14', 'Ch15',
            'Ch16', 'Ch17', 'Ch18', 'Ch19',
        ];
        const noAsdu = frame.noASDU || 1;
        const asduIndex = frame.asduIndex || 0;

        // Calculate frame sizes
        const hasVlan = frame.hasVLAN || 0;
        const ethHeaderLen = hasVlan ? 18 : 14;
        const svHeaderLen = 8;
        const totalFrameSize = ethHeaderLen + svHeaderLen + (frame.svLength || 0);
        const totalBits = totalFrameSize * 8;

        const dstMAC = frame.dstMAC || '00:00:00:00:00:00';
        const srcMAC = frame.srcMAC || '00:00:00:00:00:00';
        const appID = frame.appID || '0x0000';
        const vlanID = frame.vlanID || 0;
        const vlanPriority = frame.vlanPriority || 0;
        /* Show timestamp with full µs precision (6 decimal places).
         * new Date().toISOString() only shows 3 decimals (milliseconds),
         * which makes consecutive packets look identical at >1000 smp/s.
         * We manually append the microsecond digits. */
        let timestamp = '—';
        if (frame.timestamp) {
            const totalUs = frame.timestamp;
            const totalMs = Math.floor(totalUs / 1000);
            const usWithinMs = totalUs % 1000; // 0-999 µs within the ms
            const iso = new Date(totalMs).toISOString(); // "...ss.mmmZ"
            // Replace .mmmZ → .mmmuuuZ for full microsecond precision
            timestamp = iso.slice(0, -1) + String(usWithinMs).padStart(3, '0') + 'Z';
        }
        const errorStr = frame.errorStr || '';
        const errors = frame.errors || 0;

        const tree = [
            // ── Frame (root) ──
            {
                id: 'frame',
                label: 'Frame',
                value: `${totalFrameSize} bytes on wire (${totalBits} bits), Frame #${frame.index}`,
                colorClass: 'fv-frame-root',
                children: [
                    { id: 'frame-len', label: 'Frame Length', value: `${totalFrameSize} bytes (${totalBits} bits)`, children: [] },
                    { id: 'frame-time', label: 'Arrival Time', value: timestamp, children: [] },
                    { id: 'frame-idx', label: 'Frame Number', value: `${frame.index}`, children: [] },
                    { id: 'frame-protocols', label: 'Protocols', value: hasVlan ? 'eth:vlan:sv' : 'eth:sv', children: [] },
                    errors > 0 ? { id: 'frame-errors', label: '⚠ Errors', value: errorStr, colorClass: 'fv-error-node', children: [] } : null,
                ].filter(Boolean)
            },

            // ── Ethernet II ──
            {
                id: 'ethernet',
                label: 'Ethernet II',
                value: `Src: ${srcMAC}, Dst: ${dstMAC}`,
                colorClass: 'fv-ethernet-node',
                offset: 0, length: ethHeaderLen,
                children: [
                    { id: 'eth-dst', label: 'Destination', value: dstMAC, hex: dstMAC.replace(/:/g, ' '), offset: 0, length: 6, children: [] },
                    { id: 'eth-src', label: 'Source', value: srcMAC, hex: srcMAC.replace(/:/g, ' '), offset: 6, length: 6, children: [] },
                    hasVlan ? {
                        id: 'eth-vlan', label: '802.1Q Virtual LAN',
                        value: `PRI: ${vlanPriority}, VID: ${vlanID}`,
                        offset: 12, length: 4,
                        children: [
                            { id: 'vlan-tpid', label: 'TPID', value: '0x8100', hex: '81 00', offset: 12, length: 2, children: [] },
                            { id: 'vlan-pri', label: 'Priority', value: `${vlanPriority}`, children: [] },
                            { id: 'vlan-vid', label: 'VLAN ID', value: `${vlanID}`, children: [] },
                        ]
                    } : null,
                    { id: 'eth-type', label: 'Type', value: 'IEC 61850 SV (0x88BA)', hex: '88 BA', offset: hasVlan ? 16 : 12, length: 2, children: [] }
                ].filter(Boolean)
            },

            // ── SV PDU ──
            {
                id: 'sv-pdu',
                label: 'IEC 61850 Sampled Values',
                value: `APPID: ${appID}`,
                colorClass: 'fv-svpdu-node',
                offset: ethHeaderLen,
                length: svHeaderLen + (frame.svLength || 0),
                children: [
                    { id: 'sv-appid', label: 'APPID', value: appID, offset: ethHeaderLen, length: 2, children: [] },
                    { id: 'sv-length', label: 'Length', value: `${frame.svLength || 0}`, offset: ethHeaderLen + 2, length: 2, children: [] },
                    { id: 'sv-res1', label: 'Reserved 1', value: this._formatReserved(frame.reserved1), offset: ethHeaderLen + 4, length: 2, children: [] },
                    { id: 'sv-res2', label: 'Reserved 2', value: this._formatReserved(frame.reserved2), offset: ethHeaderLen + 6, length: 2, children: [] },
                    {
                        id: 'apdu', label: 'savPdu',
                        value: `${noAsdu} ASDU(s)`,
                        colorClass: 'fv-apdu-node',
                        offset: ethHeaderLen + svHeaderLen,
                        children: [
                            { id: 'apdu-noasdu', label: 'noASDU', value: `${noAsdu}`, children: [] },
                            {
                                id: 'apdu-seqasdu', label: 'seqASDU',
                                value: `${noAsdu} item(s)`,
                                children: this._buildAsduNodes(frame, channelNames)
                            }
                        ]
                    }
                ]
            }
        ];

        // ── Analysis Result ──
        if (frame.analysis) {
            const a = frame.analysis;
            const flags = a.flags || 0;
            const children = [];

            if (flags === 0)      children.push({ id: 'analysis-ok', label: '✓ Status', value: 'Good — No issues detected', colorClass: 'fv-ok-node', children: [] });
            if (flags & 0x10000) children.push({ id: 'analysis-missing', label: '⚠ Missing Sequence', value: `Gap of ${a.gapSize} (${a.missingFrom} → ${a.missingTo})`, colorClass: 'fv-warn-node', children: [] });
            if (flags & 0x20000) children.push({ id: 'analysis-ooo', label: '⚠ Out-of-Order', value: `Expected ${a.expected}, got ${a.actual}`, colorClass: 'fv-warn-node', children: [] });
            if (flags & 0x40000) children.push({ id: 'analysis-dup', label: 'ℹ Duplicate', value: `smpCnt=${frame.smpCnt} seen again`, colorClass: 'fv-info-node', children: [] });

            tree.push({
                id: 'analysis', label: 'Analysis Result',
                value: flags === 0 ? 'OK' : `${children.length} issue(s)`,
                colorClass: flags === 0 ? 'fv-ok-node' : 'fv-warn-node',
                children
            });
        }

        return tree;
    },

    /** @private Build ASDU nodes — shows ALL ASDUs gathered from sibling rows */
    _buildAsduNodes(frame, channelNames) {
        const siblings = frame._siblingAsdus || [frame];
        const asdus = [];

        for (let i = 0; i < siblings.length; i++) {
            const s = siblings[i];
            const idx = (s.asduIndex !== undefined) ? s.asduIndex : i;
            const svID = s.svID || '';
            const smpCnt = s.smpCnt;
            const confRev = (s.confRev !== undefined) ? s.confRev : '—';
            const smpSynch = (s.smpSynch !== undefined) ? s.smpSynch : '—';

            asdus.push({
                id: `asdu-${i}`, label: `ASDU ${idx}`,
                value: `svID="${svID}", smpCnt=${smpCnt}`,
                colorClass: 'fv-asdu-node',
                children: [
                    { id: `asdu-${i}-svid`, label: 'svID [0x80]', value: `"${svID}"`, children: [] },
                    { id: `asdu-${i}-smpcnt`, label: 'smpCnt [0x82]', value: `${smpCnt}`, children: [] },
                    { id: `asdu-${i}-confrev`, label: 'confRev [0x83]', value: `${confRev}`, children: [] },
                    { id: `asdu-${i}-smpsynch`, label: 'smpSynch [0x85]', value: this._getSmpSynchText(smpSynch), children: [] },
                    this._buildSeqDataNode(i, s, channelNames)
                ]
            });
        }

        return asdus;
    },

    /** @private Build seqData node with channel values + quality */
    _buildSeqDataNode(asduNodeIndex, frame, channelNames) {
        // Support both formats: frame.channels (array) or flat ch_0..ch_N fields
        let channels = frame.channels || [];
        let channelCount = frame.channelCount || channels.length;
        if (channels.length === 0 && channelCount === 0) {
            // Try to reconstruct from flat row buffer fields
            let i = 0;
            while (frame[`ch_${i}`] !== undefined) {
                channels.push(frame[`ch_${i}`]);
                i++;
            }
            channelCount = channels.length;
        }
        const quality = frame.quality || [];
        const byteSize = channelCount * 8;

        const channelNodes = [];
        for (let ch = 0; ch < channelCount; ch++) {
            const name = ch < channelNames.length ? channelNames[ch] : `Ch${ch}`;
            const val = channels[ch] !== undefined ? channels[ch] : 0;
            const qual = quality[ch] !== undefined ? quality[ch] : 0;

            channelNodes.push({
                id: `seqdata-${asduNodeIndex}-ch-${ch}`, label: name,
                value: '', colorClass: 'fv-channel-node',
                children: [
                    { id: `seqdata-${asduNodeIndex}-ch-${ch}-val`, label: 'Value', value: `${val} (${this._formatEngValue(val, ch)})`, hex: this._int32ToHex(val), children: [] },
                    { id: `seqdata-${asduNodeIndex}-ch-${ch}-q`, label: 'Quality', value: this._getQualityText(qual), hex: this._int32ToHex(qual), colorClass: qual !== 0 ? 'fv-warn-node' : '', children: [] }
                ]
            });
        }

        return {
            id: `seqdata-${asduNodeIndex}`, label: 'seqData [0x87]',
            value: `${byteSize} bytes (${channelCount} channels × 8 bytes)`,
            colorClass: 'fv-seqdata-node',
            children: channelNodes
        };
    },

    // ========================================================================
    // TREE NODE RENDERING
    // ========================================================================

    /** @private Create a single tree node HTML */
    _createTreeNode(node) {
        const { id, label, value = '', hex = '', offset, length, children = [], colorClass = '' } = node;

        const hasChildren = children.length > 0;
        const isExpanded = this._expandedNodes.has(id);
        const expandIcon = hasChildren ? (isExpanded ? '▼' : '▶') : '•';
        const expandClass = hasChildren ? 'fv-expandable' : 'fv-leaf';
        const expandedClass = isExpanded ? 'fv-expanded' : 'fv-collapsed';

        let offsetHtml = (offset !== undefined && length !== undefined)
            ? `<span class="fv-node-offset">[${offset}:${length}]</span>` : '';
        let valueHtml = value ? `<span class="fv-node-value">${value}</span>` : '';
        let hexHtml = hex ? `<span class="fv-node-hex">${hex}</span>` : '';

        let childrenHtml = '';
        if (hasChildren) {
            const childNodes = children.map(c => this._createTreeNode(c)).join('');
            childrenHtml = `<div class="fv-tree-children ${isExpanded ? '' : 'fv-hidden'}" id="fv-children-${id}">${childNodes}</div>`;
        }

        return `
            <div class="fv-tree-node ${expandClass} ${expandedClass} ${colorClass}" data-node-id="${id}">
                <div class="fv-tree-node-header" onclick="svFrameViewToggle('${id}')">
                    <span class="fv-expand-icon">${expandIcon}</span>
                    <span class="fv-node-label">${label}</span>
                    ${valueHtml}
                    ${hexHtml}
                    ${offsetHtml}
                </div>
                ${childrenHtml}
            </div>
        `;
    },

    // ========================================================================
    // NODE TOGGLE
    // ========================================================================

    toggleNode(nodeId) {
        if (this._expandedNodes.has(nodeId)) {
            this._expandedNodes.delete(nodeId);
        } else {
            this._expandedNodes.add(nodeId);
        }

        const node = document.querySelector(`#fvTree [data-node-id="${nodeId}"]`);
        if (!node) return;

        const children = document.getElementById(`fv-children-${nodeId}`);
        const icon = node.querySelector('.fv-expand-icon');

        if (this._expandedNodes.has(nodeId)) {
            node.classList.remove('fv-collapsed');
            node.classList.add('fv-expanded');
            if (children) children.classList.remove('fv-hidden');
            if (icon) icon.textContent = '▼';
        } else {
            node.classList.remove('fv-expanded');
            node.classList.add('fv-collapsed');
            if (children) children.classList.add('fv-hidden');
            if (icon) icon.textContent = '▶';
        }
    },

    expandAll() {
        const tree = document.getElementById('fvTree');
        if (!tree) return;
        tree.querySelectorAll('.fv-tree-node.fv-expandable').forEach(node => {
            this._expandedNodes.add(node.dataset.nodeId);
        });
        if (this._currentFrame) this.showFrame(this._currentFrame);
    },

    collapseAll() {
        this._expandedNodes.clear();
        if (this._currentFrame) this.showFrame(this._currentFrame);
    },

    // ========================================================================
    // HELPER FUNCTIONS
    // ========================================================================

    /** @private Get quality badge HTML for the frame info bar */
    _getQualityBadge(frame) {
        if (frame.errors > 0) return '<span class="badge badge-error">Bad Structure</span>';
        if (frame.analysis) {
            if (frame.analysis.flags & 0x10000) return '<span class="badge badge-warn">Missed</span>';
            if (frame.analysis.flags & 0x20000) return '<span class="badge badge-error">Out of Seq</span>';
            if (frame.analysis.flags & 0x40000) return '<span class="badge badge-info">Duplicate</span>';
        }
        return '<span class="badge badge-ok">Good</span>';
    },

    /** @private */
    _getSmpSynchText(value) {
        const texts = { 0: '0 (Not Synchronized)', 1: '1 (Local)', 2: '2 (Global/GPS)' };
        return texts[value] || `${value}`;
    },

    /** @private */
    _getQualityText(qual) {
        if (qual === 0) return '0x00000000 (Good)';
        const hex = '0x' + qual.toString(16).toUpperCase().padStart(8, '0');
        const issues = [];
        if (qual & 0x01) issues.push('Validity');
        if (qual & 0x04) issues.push('Overflow');
        if (qual & 0x08) issues.push('OutOfRange');
        if (qual & 0x10) issues.push('BadRef');
        if (qual & 0x20) issues.push('Oscillatory');
        if (qual & 0x40) issues.push('Failure');
        if (qual & 0x80) issues.push('OldData');
        return issues.length > 0 ? `${hex} (${issues.join(', ')})` : hex;
    },

    /** @private */
    _formatReserved(val) {
        if (val === undefined || val === null) return '0x0000';
        const hex = '0x' + val.toString(16).toUpperCase().padStart(4, '0');
        return (val & 0x8000) ? `${hex} (Simulation)` : hex;
    },

    /** @private Convert int32 to hex display string */
    _int32ToHex(num) {
        return [(num >> 24) & 0xFF, (num >> 16) & 0xFF, (num >> 8) & 0xFF, num & 0xFF]
            .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    },

    /**
     * @private Format raw channel value to engineering units
     * Channels 0-3: Voltage (~100/V), Channels 4-7: Current (~1000/A)
     */
    _formatEngValue(rawValue, channelIndex) {
        if (channelIndex < 4) return (rawValue / 100).toFixed(2) + ' V';
        return (rawValue / 1000).toFixed(3) + ' A';
    }
};
