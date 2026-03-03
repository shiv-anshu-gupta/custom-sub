/**
 * @file components/FrameViewer.js
 * @fileoverview Frame Structure Viewer - Wireshark-style SV Frame Visualization
 * @module FrameViewer
 * @description
 * Displays IEC 61850-9-2 SV frame structure in a tree format.
 * 
 * Frame Structure:
 * - Ethernet Header (18 bytes with VLAN)
 * - SV PDU (savPdu): APPID, Length, Reserved
 * - APDU: noASDU, seqASDU
 * - ASDU: svID, smpCnt, confRev, smpSynch, seqData
 */

import store from '../store/index.js';
import * as tauriClient from '../utils/tauriClient.js';
import { showToast } from '../plugins/toast.js';
import { registerDropZone } from '../utils/dragManager.js';

/** @private */
const { invoke } = window.__TAURI__?.core || {};
/** @private */
const isTauri = typeof invoke === 'function';

// ============================================================================
// MODULE STATE
// ============================================================================

/** @private */
let _initialized = false;
/** @private */
const _elements = {};
/** @private */
let _expandedNodes = new Set(['frame', 'ethernet', 'sv-pdu', 'apdu', 'asdu-0', 'seqdata-0']);
/** @private */
let _realFrameBytes = null;
/** @private */
let _isLiveMode = false;
/** @private */
let _isEditMode = false;
/** @private */
let _currentHighlightedNode = null;

// ============================================================================
// DOM TEMPLATE
// ============================================================================

/**
 * Get HTML template
 * @memberof module:FrameViewer
 * @returns {string} HTML template
 */
export function getTemplate() {
    const currentAsdu = store.get('config.noAsdu') || 1;
    
    return `
        <section class="card" id="frame-viewer-module">
            <div class="card-header">
                <h2>Frame Structure</h2>
                <div class="frame-header-actions">
                    <div class="asdu-inline-selector">
                        <label>ASDUs:</label>
                        <select id="asduSelect" class="asdu-select">
                            <option value="1" ${currentAsdu === 1 ? 'selected' : ''}>1</option>
                            <option value="4" ${currentAsdu === 4 ? 'selected' : ''}>4</option>
                            <option value="8" ${currentAsdu === 8 ? 'selected' : ''}>8</option>
                        </select>
                    </div>
                    <button class="btn-icon" id="refreshFrameBtn" title="Refresh">↻</button>
                    <button class="btn-icon" id="expandAllBtn" title="Expand All">+</button>
                    <button class="btn-icon" id="collapseAllBtn" title="Collapse All">−</button>
                </div>
            </div>
            <div class="card-body frame-viewer-body">
                <!-- Data source indicator with edit controls -->
                <div class="frame-data-source" id="frameDataSource">
                    <span class="source-indicator calculated">📐 Calculated</span>
                    <div class="frame-edit-controls">
                        <button class="btn-edit-frame" id="btnEditFrame" title="Edit frame values">✏️ Edit</button>
                        <button class="btn-save-frame hidden" id="btnSaveFrame" title="Save changes">💾 Save</button>
                    </div>
                </div>
                
                <!-- Wireshark-style Tree View -->
                <div class="packet-tree" id="packetTree">
                    <!-- Tree will be dynamically generated -->
                </div>
                
                <!-- HexaDecimal Panel -->
                <div class="hex-panel" id="hexPanel">
                    <div class="hex-panel-header">
                        <span>Hexadecimal Value</span>
                        <button class="btn-icon btn-small" id="toggleHexPanel" title="Toggle Hex">▼</button>
                    </div>
                    <div class="hex-panel-content" id="hexPanelContent">
                        <div class="hex-view" id="hexView"></div>
                    </div>
                </div>
            </div>
        </section>
    `;
}

// ============================================================================
// TREE NODE GENERATION
// ============================================================================

/**
 * Create a tree node HTML
 * @param {Object} node - Node configuration
 * @returns {string} HTML string
 */
function createTreeNode(node) {
    const {
        id,
        label,
        value = '',
        hexValue = '',
        offset = '',
        length = '',
        children = [],
        colorClass = '',
        isLeaf = false,
        isEditable = false,
        isDraggable = false,
        channelId = null,
        channelIndex = null
    } = node;

    const hasChildren = children.length > 0;
    const isExpanded = _expandedNodes.has(id);
    const expandIcon = hasChildren ? (isExpanded ? '▼' : '▶') : '•';
    const expandClass = hasChildren ? 'expandable' : 'leaf';
    const expandedClass = isExpanded ? 'expanded' : 'collapsed';

    let offsetHtml = '';
    if (offset !== '' || length !== '') {
        offsetHtml = `<span class="node-offset">[${offset}:${length}]</span>`;
    }

    let valueHtml = '';
    if (value) {
        valueHtml = `<span class="node-value">${value}</span>`;
    }

    let hexHtml = '';
    if (hexValue) {
        hexHtml = `<span class="node-hex">${hexValue}</span>`;
    }

    // Inline editing controls for seqData parent (add channel button)
    let editControlsHtml = '';
    if (isEditable) {
        editControlsHtml = `
            <div class="seqdata-controls">
                <button class="btn-icon btn-add-channel" onclick="event.stopPropagation(); window.frameViewerAddChannel()" title="Add Channel">+</button>
            </div>
        `;
    }

    // Drag handle and controls for draggable channel items
    let dragControlsHtml = '';
    if (isDraggable && channelId !== null) {
        const availableChannels = store.getAvailableChannels();
        const allChannels = store.getChannels();
        
        // Build dropdown options
        const dropdownOptions = allChannels.map(ch => 
            `<option value="${ch.id}" ${ch.id === channelId ? 'selected' : ''}>${ch.id}</option>`
        ).join('');
        
        dragControlsHtml = `
            <div class="channel-drag-controls">
                <span class="drag-handle" data-channel-index="${channelIndex}" data-channel-id="${channelId}" title="Drag to reorder">≡</span>
                <select class="channel-select" onchange="window.frameViewerChangeChannel(${channelIndex}, this.value)" onclick="event.stopPropagation()" title="Change channel">
                    ${dropdownOptions}
                </select>
                <button class="btn-icon btn-remove" onclick="event.stopPropagation(); window.frameViewerRemoveChannel(${channelIndex})" title="Remove">×</button>
            </div>
        `;
    }

    let childrenHtml = '';
    if (hasChildren) {
        const childNodes = children.map(child => createTreeNode(child)).join('');
        childrenHtml = `<div class="tree-children ${isExpanded ? '' : 'hidden'}" id="children-${id}">${childNodes}</div>`;
    }

    // Only add data attributes for channel nodes (NO draggable on outer div - only on drag handle)
    const channelDataAttr = isDraggable ? `data-channel-id="${channelId}" data-channel-index="${channelIndex}"` : '';
    
    // Add byte range data attributes for hex highlighting (Wireshark-style)
    const byteStart = typeof offset === 'number' ? offset : -1;
    const byteLen = typeof length === 'number' ? length : -1;
    const byteRangeAttr = byteStart >= 0 && byteLen > 0 ? `data-byte-start="${byteStart}" data-byte-length="${byteLen}"` : '';

    return `
        <div class="tree-node ${expandClass} ${expandedClass} ${colorClass} ${isDraggable ? 'channel-draggable' : ''}"
             data-node-id="${id}" ${channelDataAttr} ${byteRangeAttr}>
            <div class="tree-node-header" onclick="window.frameViewerToggleNode('${id}')"
                 onmouseenter="window.frameViewerHighlightBytes('${id}')"
                 onmouseleave="window.frameViewerClearHighlight()">
                ${dragControlsHtml}
                <span class="expand-icon">${expandIcon}</span>
                <span class="node-label">${label}</span>
                ${valueHtml}
                ${hexHtml}
                ${offsetHtml}
                ${editControlsHtml}
            </div>
            ${childrenHtml}
        </div>
    `;
}

/**
 * Build the complete frame tree structure
 * @param {Object} config - Current configuration
 * @returns {Array} Array of root nodes
 */
function buildFrameTree(config) {
    const smpCnt = store.get('data.stats.smpCnt') || 0;
    const noAsdu = config.noAsdu || 1;
    const selectedChannels = store.get('config.selectedChannels') || [];
    const channelCount = selectedChannels.length;
    
    // Get current standard
    const standard = store.get('config.standard') || '9-2LE';
    const standardConfig = store.get('config.standardConfig') || {};
    const standardName = standardConfig.name || 'IEC 61850 9-2 LE';
    
    // Calculate dynamic lengths based on actual channel count
    const svIdLen = (config.svID || 'MU01').length;
    const seqDataLen = 2 + (channelCount * 8); // TL + (value + quality per channel)
    const asduContentLen = 2 + svIdLen + 4 + 6 + 3 + seqDataLen + 6; // svID TL + smpCnt + confRev + smpSynch + seqData + overhead
    const asduTotalLen = asduContentLen + 2; // Plus ASDU sequence tag
    const apduContentLen = 3 + (noAsdu * asduTotalLen) + 4; // noASDU TL + ASDUs + seqASDU overhead
    const svPduLen = apduContentLen + 4; // Plus savPdu header
    const totalFrameSize = 18 + 8 + svPduLen; // Ethernet + SV header + PDU
    const totalBits = totalFrameSize * 8;
    
    // Parse MAC addresses for hex display
    const dstMacHex = config.dstMAC.replace(/:/g, ' ');
    const srcMacHex = config.srcMAC.replace(/:/g, ' ');
    
    // Calculate VLAN TCI
    const tci = ((config.vlanPriority & 0x07) << 13) | (config.vlanID & 0x0FFF);
    
    // APPID hex
    const appIdNum = typeof config.appID === 'number' ? config.appID : parseInt(config.appID, 16);
    const appIdHex = appIdNum.toString(16).toUpperCase().padStart(4, '0');
    
    // Build tree structure (Wireshark-style)
    const tree = [
        // Frame (root level - like Wireshark)
        {
            id: 'frame',
            label: 'Frame',
            value: `${totalFrameSize} bytes on wire (${totalBits} bits)`,
            colorClass: 'frame-node',
            children: [
                {
                    id: 'frame-encap',
                    label: 'Encapsulation type',
                    value: 'Ethernet (1)',
                    isLeaf: true,
                    children: []
                },
                {
                    id: 'frame-time',
                    label: 'Arrival Time',
                    value: new Date().toISOString(),
                    isLeaf: true,
                    children: []
                },
                {
                    id: 'frame-len',
                    label: 'Frame Length',
                    value: `${totalFrameSize} bytes (${totalBits} bits)`,
                    isLeaf: true,
                    children: []
                },
                {
                    id: 'frame-captured',
                    label: 'Capture Length',
                    value: `${totalFrameSize} bytes (${totalBits} bits)`,
                    isLeaf: true,
                    children: []
                },
                {
                    id: 'frame-protocols',
                    label: 'Protocols in frame',
                    value: 'eth:ethertype:vlan:ethertype:sv',
                    isLeaf: true,
                    children: []
                }
            ]
        },
        // Ethernet II Header
        {
            id: 'ethernet',
            label: 'Ethernet II',
            value: `Src: ${config.srcMAC}, Dst: ${config.dstMAC}`,
            offset: 0,
            length: 18,
            colorClass: 'ethernet-node',
            children: [
                {
                    id: 'eth-dst',
                    label: 'Destination',
                    value: config.dstMAC,
                    hexValue: dstMacHex,
                    offset: 0,
                    length: 6,
                    isLeaf: true,
                    children: []
                },
                {
                    id: 'eth-src',
                    label: 'Source',
                    value: config.srcMAC,
                    hexValue: srcMacHex,
                    offset: 6,
                    length: 6,
                    isLeaf: true,
                    children: []
                },
                {
                    id: 'eth-vlan',
                    label: '802.1Q Virtual LAN',
                    value: `PRI: ${config.vlanPriority}, VID: ${config.vlanID}`,
                    offset: 12,
                    length: 4,
                    children: [
                        {
                            id: 'vlan-tpid',
                            label: 'TPID',
                            value: '0x8100',
                            hexValue: '81 00',
                            offset: 12,
                            length: 2,
                            isLeaf: true,
                            children: []
                        },
                        {
                            id: 'vlan-pri',
                            label: 'Priority',
                            value: `${config.vlanPriority}`,
                            offset: 14,
                            length: '3 bits',
                            isLeaf: true,
                            children: []
                        },
                        {
                            id: 'vlan-cfi',
                            label: 'CFI',
                            value: '0',
                            offset: 14,
                            length: '1 bit',
                            isLeaf: true,
                            children: []
                        },
                        {
                            id: 'vlan-vid',
                            label: 'VLAN ID',
                            value: `${config.vlanID}`,
                            offset: 14,
                            length: '12 bits',
                            isLeaf: true,
                            children: []
                        }
                    ]
                },
                {
                    id: 'eth-type',
                    label: 'Type',
                    value: 'IEC 61850 SV (0x88BA)',
                    hexValue: '88 BA',
                    offset: 16,
                    length: 2,
                    isLeaf: true,
                    children: []
                }
            ]
        },
        // SV PDU (Sampled Values Protocol Data Unit)
        {
            id: 'sv-pdu',
            label: `IEC 61850 Sampled Values`,
            value: `${standardName}`,
            offset: 18,
            length: svPduLen + 8,
            colorClass: 'sv-pdu-node',
            children: [
                {
                    id: 'sv-appid',
                    label: 'APPID',
                    value: `0x${appIdHex} (${appIdNum})`,
                    hexValue: appIdHex.match(/.{2}/g).join(' '),
                    offset: 18,
                    length: 2,
                    isLeaf: true,
                    children: []
                },
                {
                    id: 'sv-length',
                    label: 'Length',
                    value: `${svPduLen}`,
                    offset: 20,
                    length: 2,
                    isLeaf: true,
                    children: []
                },
                {
                    id: 'sv-res1',
                    label: 'Reserved 1',
                    value: config.simulate ? '0x8000 (Simulation)' : '0x0000',
                    hexValue: config.simulate ? '80 00' : '00 00',
                    offset: 22,
                    length: 2,
                    isLeaf: true,
                    children: []
                },
                {
                    id: 'sv-res2',
                    label: 'Reserved 2',
                    value: '0x0000',
                    hexValue: '00 00',
                    offset: 24,
                    length: 2,
                    isLeaf: true,
                    children: []
                },
                // APDU (Application Protocol Data Unit)
                {
                    id: 'apdu',
                    label: 'savPdu',
                    value: `${noAsdu} ASDU(s), ${channelCount} channels`,
                    offset: 26,
                    length: apduContentLen,
                    colorClass: 'apdu-node',
                    children: [
                        {
                            id: 'apdu-noasdu',
                            label: 'noASDU',
                            value: `${noAsdu}`,
                            offset: 28,
                            length: 3,
                            isLeaf: true,
                            children: []
                        },
                        {
                            id: 'apdu-seqasdu',
                            label: 'seqASDU',
                            value: `${noAsdu} item(s)`,
                            offset: 31,
                            length: '2+',
                            children: buildAsduNodes(config, noAsdu, smpCnt)
                        }
                    ]
                }
            ]
        }
    ];
    
    return tree;
}

/**
 * Build ASDU nodes for each ASDU in the frame
 */
function buildAsduNodes(config, noAsdu, smpCnt) {
    const asdus = [];
    const selectedChannels = store.get('config.selectedChannels') || [];
    const channelCount = selectedChannels.length;
    
    // Calculate dynamic ASDU size
    const svIdLen = (config.svID || 'MU01').length;
    const seqDataLen = 2 + (channelCount * 8); // TL + (value + quality per channel)
    const asduContentLen = 2 + svIdLen + 4 + 6 + 3 + seqDataLen + 4; // svID TL + smpCnt + confRev + smpSynch + seqData
    
    for (let i = 0; i < noAsdu; i++) {
        const asduOffset = 33 + (i * asduContentLen);
        
        asdus.push({
            id: `asdu-${i}`,
            label: `ASDU ${i + 1}`,
            value: `${channelCount} channels`,
            offset: asduOffset,
            length: asduContentLen,
            colorClass: 'asdu-node',
            children: [
                {
                    id: `asdu-${i}-svid`,
                    label: 'svID',
                    value: `"${config.svID}"`,
                    offset: asduOffset + 2,
                    length: 2 + config.svID.length,
                    isLeaf: true,
                    children: []
                },
                {
                    id: `asdu-${i}-smpcnt`,
                    label: 'smpCnt',
                    value: `${smpCnt}`,
                    offset: asduOffset + 4 + config.svID.length,
                    length: 4,
                    isLeaf: true,
                    children: []
                },
                {
                    id: `asdu-${i}-confrev`,
                    label: 'confRev',
                    value: `${config.confRev}`,
                    offset: asduOffset + 8 + config.svID.length,
                    length: 6,
                    isLeaf: true,
                    children: []
                },
                {
                    id: `asdu-${i}-smpsynch`,
                    label: 'smpSynch',
                    value: getSmpSynchText(config.smpSynch),
                    offset: asduOffset + 14 + config.svID.length,
                    length: 3,
                    isLeaf: true,
                    children: []
                },
                buildSeqDataNode(i, config, smpCnt, asduOffset + 17 + config.svID.length)
            ]
        });
    }
    
    return asdus;
}

/**
 * Build seqData parent node with editable channels
 */
function buildSeqDataNode(asduIndex, config, smpCnt, offset) {
    const selectedChannels = store.get('config.selectedChannels') || [];
    const channelCount = selectedChannels.length;
    const byteSize = channelCount * 8;
    
    return {
        id: `seqdata-${asduIndex}`,
        label: 'seqData',
        value: `${byteSize} bytes (${channelCount} channels × 8 bytes)`,
        offset: offset,
        length: byteSize + 2,
        colorClass: 'seqdata-node seqdata-editable',
        isEditable: true,
        children: buildSeqDataChannelNodes(asduIndex, config, smpCnt, selectedChannels)
    };
}

/**
 * Build seqData channel nodes from selected channels
 */
function buildSeqDataChannelNodes(asduIndex, config, smpCnt, selectedChannels) {
    // Channel metadata for calculations
    const CHANNEL_META = {
        'Ia': { label: 'Ia (Current A)', type: 'current', phaseOffset: 0 },
        'Ib': { label: 'Ib (Current B)', type: 'current', phaseOffset: -120 },
        'Ic': { label: 'Ic (Current C)', type: 'current', phaseOffset: 120 },
        'In': { label: 'In (Current N)', type: 'current', phaseOffset: 0, isNeutral: true },
        'Va': { label: 'Va (Voltage A)', type: 'voltage', phaseOffset: 0 },
        'Vb': { label: 'Vb (Voltage B)', type: 'voltage', phaseOffset: -120 },
        'Vc': { label: 'Vc (Voltage C)', type: 'voltage', phaseOffset: 120 },
        'Vn': { label: 'Vn (Voltage N)', type: 'voltage', phaseOffset: 0, isNeutral: true }
    };
    
    // Calculate estimated sample values based on smpCnt
    const sampleRate = config.sampleRate || 4800;
    const frequency = config.frequency || 60;
    const t = smpCnt / sampleRate;
    const omega = 2 * Math.PI * frequency;
    
    // Get amplitude from config or use defaults
    const currentAmp = config.currentAmplitude || 1000;
    const voltageAmp = config.voltageAmplitude || 11547;
    
    return selectedChannels.map((channelId, idx) => {
        const meta = CHANNEL_META[channelId] || { 
            label: channelId, 
            type: 'custom', 
            phaseOffset: 0 
        };
        
        let value = 0;
        if (!meta.isNeutral) {
            const phaseRad = (meta.phaseOffset * Math.PI) / 180;
            const amplitude = meta.type === 'current' ? currentAmp : voltageAmp;
            value = Math.round(amplitude * Math.sin(omega * t + phaseRad));
        }
        
        const hexValue = int32ToHex(value);
        
        return {
            id: `seqdata-${asduIndex}-ch-${idx}`,
            label: meta.label,
            value: '',
            offset: `+${idx * 8}`,
            length: 8,
            channelId: channelId,
            channelIndex: idx,
            isDraggable: true,
            children: [
                {
                    id: `seqdata-${asduIndex}-ch-${idx}-val`,
                    label: 'Value',
                    value: formatChannelValueWithRaw(value, meta.type),
                    hexValue: hexValue,
                    offset: `+${idx * 8}`,
                    length: 4,
                    isLeaf: true,
                    children: []
                },
                {
                    id: `seqdata-${asduIndex}-ch-${idx}-q`,
                    label: 'Quality',
                    value: '0x00000000 (Good)',
                    hexValue: '00 00 00 00',
                    offset: `+${idx * 8 + 4}`,
                    length: 4,
                    isLeaf: true,
                    children: []
                }
            ]
        };
    });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getSmpSynchText(value) {
    const texts = {
        0: '0 (None)',
        1: '1 (Local)',
        2: '2 (Global/GPS)'
    };
    return texts[value] || `${value}`;
}

function stringToHex(str) {
    return str.split('').map(c => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function int32ToHex(num) {
    return [
        (num >> 24) & 0xFF,
        (num >> 16) & 0xFF,
        (num >> 8) & 0xFF,
        num & 0xFF
    ].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function formatChannelValue(value, type) {
    if (typeof value !== 'number') return '0';
    const unit = type === 'current' ? 'A' : 'V';
    return `${value.toFixed(2)} ${unit}`;
}

/**
 * Format channel value with raw integer for display
 */
function formatChannelValueWithRaw(rawValue, type) {
    // Scale factors: current ~1000 per amp, voltage ~100 per volt
    const scaleFactor = type === 'current' ? 1000 : 100;
    const engValue = rawValue / scaleFactor;
    const unit = type === 'current' ? 'A' : 'V';
    return `${engValue.toFixed(3)} ${unit} (raw: ${rawValue})`;
}

/**
 * Calculate approximate frame size based on selectedChannels
 * 
 * Frame structure:
 *   Ethernet Header: 14 bytes (or 18 with VLAN)
 *   SV Header: 8 bytes (APPID + Length + Reserved1 + Reserved2)
 *   APDU overhead: ~6 bytes (tags + lengths)
 *   Per ASDU:
 *     - ASDU header: 2 bytes (tag + length)
 *     - svID: 2 + svID.length bytes
 *     - smpCnt: 4 bytes
 *     - confRev: 6 bytes  
 *     - smpSynch: 3 bytes
 *     - seqData: 2 + (channelCount * 8) bytes
 */
function calculateFrameSize(config) {
    const selectedChannels = store.get('config.selectedChannels') || [];
    const channelCount = selectedChannels.length;
    
    const ethernetHeader = 18; // Includes VLAN
    const svHeader = 8;
    const apduOverhead = 6;
    const svIdLen = (config.svID || 'MU01').length;
    const seqDataLen = 2 + (channelCount * 8); // 2 bytes TL + 8 bytes per channel
    const asduOverhead = 2 + svIdLen + 4 + 6 + 3 + seqDataLen;
    const noAsdu = config.noAsdu || 1;
    return ethernetHeader + svHeader + apduOverhead + (asduOverhead * noAsdu);
}

// ============================================================================
// BACKEND INTEGRATION - FETCH REAL FRAME DATA
// ============================================================================

/**
 * Fetch actual frame bytes from the C++ backend
 * @param {number} smpCnt - Sample count to use (default 0)
 * @returns {Promise<Uint8Array|null>} Frame bytes or null if failed
 */
async function fetchRealFrameFromBackend(smpCnt = 0) {
    if (!isTauri) {
        console.warn('[FrameViewer] Tauri not available, using calculated values');
        return null;
    }
    
    try {
        const response = await invoke('get_sample_frame', { smpCnt });
        if (response && response.frameBytes && response.frameBytes.length > 0) {
            console.log(`[FrameViewer] ✅ Got real frame: ${response.frameSize} bytes`);
            return new Uint8Array(response.frameBytes);
        }
    } catch (err) {
        console.warn('[FrameViewer] Failed to get real frame:', err);
    }
    return null;
}

/**
 * Fetch current channel values from running publisher
 * @returns {Promise<{values: number[], smpCnt: number}|null>}
 */
async function fetchCurrentChannelValues() {
    if (!isTauri) return null;
    
    try {
        const response = await invoke('get_current_channel_values');
        if (response && response.values) {
            return {
                values: response.values,
                smpCnt: response.smpCnt
            };
        }
    } catch (err) {
        // Silent fail - publisher may not be running
    }
    return null;
}

/**
 * Parse real frame bytes to extract field values
 * @param {Uint8Array} bytes - Frame bytes
 * @returns {Object} Parsed frame structure
 */
function parseRealFrame(bytes) {
    if (!bytes || bytes.length < 26) return null;
    
    const parsed = {
        dstMAC: formatMacBytes(bytes.slice(0, 6)),
        srcMAC: formatMacBytes(bytes.slice(6, 12)),
        hasVlan: bytes[12] === 0x81 && bytes[13] === 0x00,
        vlanPriority: 0,
        vlanID: 0,
        etherType: 0,
        appID: 0,
        pduLength: 0,
        reserved1: 0,
        reserved2: 0,
        apduOffset: 0,
        frameSize: bytes.length
    };
    
    let offset = 12;
    
    // Check for VLAN
    if (parsed.hasVlan) {
        const tci = (bytes[14] << 8) | bytes[15];
        parsed.vlanPriority = (tci >> 13) & 0x07;
        parsed.vlanID = tci & 0x0FFF;
        offset = 16;
    }
    
    // EtherType
    parsed.etherType = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    
    // SV Header
    parsed.appID = (bytes[offset] << 8) | bytes[offset + 1];
    parsed.pduLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    parsed.reserved1 = (bytes[offset + 4] << 8) | bytes[offset + 5];
    parsed.reserved2 = (bytes[offset + 6] << 8) | bytes[offset + 7];
    parsed.apduOffset = offset + 8;
    
    // Parse APDU if present
    if (parsed.apduOffset < bytes.length) {
        const apduStart = parsed.apduOffset;
        if (bytes[apduStart] === 0x60) {
            // Parse savPdu
            parsed.apdu = parseAPDU(bytes, apduStart);
        }
    }
    
    return parsed;
}

/**
 * Parse APDU (Application PDU) from bytes
 */
function parseAPDU(bytes, offset) {
    const apdu = { tag: bytes[offset], length: 0, noAsdu: 1, asdus: [] };
    
    // Get length (handle 2-byte length encoding)
    let lenOffset = offset + 1;
    if (bytes[lenOffset] & 0x80) {
        const lenBytes = bytes[lenOffset] & 0x7F;
        apdu.length = 0;
        for (let i = 0; i < lenBytes; i++) {
            apdu.length = (apdu.length << 8) | bytes[lenOffset + 1 + i];
        }
        lenOffset += lenBytes + 1;
    } else {
        apdu.length = bytes[lenOffset];
        lenOffset++;
    }
    
    // Parse noASDU (tag 0x80)
    let pos = lenOffset;
    if (bytes[pos] === 0x80) {
        apdu.noAsdu = bytes[pos + 2];
        pos += 3;
    }
    
    // Parse seqASDU (tag 0xA2)
    if (bytes[pos] === 0xA2) {
        pos++; // skip tag
        // Skip length
        if (bytes[pos] & 0x80) {
            pos += (bytes[pos] & 0x7F) + 1;
        } else {
            pos++;
        }
        
        // Parse each ASDU
        for (let i = 0; i < apdu.noAsdu && pos < bytes.length; i++) {
            const asdu = parseASDU(bytes, pos);
            if (asdu) {
                apdu.asdus.push(asdu);
                pos = asdu.endOffset;
            } else {
                break;
            }
        }
    }
    
    return apdu;
}

/**
 * Parse a single ASDU from bytes
 */
function parseASDU(bytes, offset) {
    if (bytes[offset] !== 0x30) return null;
    
    const asdu = { 
        tag: 0x30, 
        offset: offset,
        svID: '', 
        smpCnt: 0, 
        confRev: 0, 
        smpSynch: 0,
        seqData: [],
        endOffset: offset
    };
    
    let pos = offset + 1;
    
    // Get length
    let len = bytes[pos];
    if (len & 0x80) {
        const lenBytes = len & 0x7F;
        len = 0;
        for (let i = 0; i < lenBytes; i++) {
            len = (len << 8) | bytes[pos + 1 + i];
        }
        pos += lenBytes + 1;
    } else {
        pos++;
    }
    
    asdu.endOffset = offset + len + 2;
    const endPos = pos + len;
    
    // Parse TLV fields
    while (pos < endPos) {
        const tag = bytes[pos];
        const fieldLen = bytes[pos + 1];
        pos += 2;
        
        switch (tag) {
            case 0x80: // svID
                asdu.svID = String.fromCharCode(...bytes.slice(pos, pos + fieldLen));
                break;
            case 0x82: // smpCnt
                asdu.smpCnt = (bytes[pos] << 8) | bytes[pos + 1];
                break;
            case 0x83: // confRev
                asdu.confRev = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | 
                               (bytes[pos + 2] << 8) | bytes[pos + 3];
                break;
            case 0x85: // smpSynch
                asdu.smpSynch = bytes[pos];
                break;
            case 0x87: // seqData
                const chCount = Math.floor(fieldLen / 8);
                for (let i = 0; i < chCount && (pos + i * 8 + 7) < endPos; i++) {
                    const valueOffset = pos + i * 8;
                    const value = (bytes[valueOffset] << 24) | (bytes[valueOffset + 1] << 16) |
                                 (bytes[valueOffset + 2] << 8) | bytes[valueOffset + 3];
                    const quality = (bytes[valueOffset + 4] << 24) | (bytes[valueOffset + 5] << 16) |
                                   (bytes[valueOffset + 6] << 8) | bytes[valueOffset + 7];
                    asdu.seqData.push({ 
                        value: value > 0x7FFFFFFF ? value - 0x100000000 : value, 
                        quality 
                    });
                }
                break;
        }
        pos += fieldLen;
    }
    
    return asdu;
}

/**
 * Format bytes as MAC address string
 */
function formatMacBytes(bytes) {
    return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
}

// ============================================================================
// HEX DUMP GENERATION (Wireshark-style with byte-level highlighting support)
// ============================================================================

/**
 * Generate hex dump from real frame bytes with individual byte spans for highlighting
 * @param {Uint8Array} bytes - Frame bytes
 * @returns {string} HTML hex dump
 */
function generateHexDumpFromBytes(bytes) {
    let html = '';
    const bytesPerLine = 16;
    
    for (let i = 0; i < bytes.length; i += bytesPerLine) {
        const offsetStr = i.toString(16).toUpperCase().padStart(4, '0');
        const hexParts = [];
        const asciiParts = [];
        
        for (let j = 0; j < bytesPerLine; j++) {
            const byteIndex = i + j;
            if (byteIndex < bytes.length) {
                const byte = bytes[byteIndex];
                const hexStr = byte.toString(16).toUpperCase().padStart(2, '0');
                // Each byte wrapped in span with data-byte-index for highlighting
                hexParts.push(`<span class="hex-byte" data-byte-index="${byteIndex}">${hexStr}</span>`);
                const asciiChar = byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.';
                asciiParts.push(`<span class="ascii-char" data-byte-index="${byteIndex}">${asciiChar}</span>`);
            } else {
                // Padding for incomplete lines
                hexParts.push(`<span class="hex-byte hex-padding">  </span>`);
                asciiParts.push(`<span class="ascii-char ascii-padding"> </span>`);
            }
        }
        
        // Group hex bytes (8 + 8 with gap in middle)
        const hexLeft = hexParts.slice(0, 8).join(' ');
        const hexRight = hexParts.slice(8).join(' ');
        
        html += `<div class="hex-line" data-line-offset="${i}">`;
        html += `<span class="hex-offset">${offsetStr}</span>`;
        html += `<span class="hex-bytes">${hexLeft}  ${hexRight}</span>`;
        html += `<span class="hex-ascii">${asciiParts.join('')}</span>`;
        html += `</div>`;
    }
    
    return html;
}

function generateHexDump(config) {
    // If we have real frame bytes, use them
    if (_realFrameBytes && _realFrameBytes.length > 0) {
        return generateHexDumpFromBytes(_realFrameBytes);
    }
    
    // Otherwise, generate calculated bytes
    const bytes = [];
    
    // Destination MAC
    config.dstMAC.split(':').forEach(h => bytes.push(parseInt(h, 16)));
    // Source MAC
    config.srcMAC.split(':').forEach(h => bytes.push(parseInt(h, 16)));
    // VLAN Tag
    bytes.push(0x81, 0x00);
    const tci = ((config.vlanPriority & 0x07) << 13) | (config.vlanID & 0x0FFF);
    bytes.push((tci >> 8) & 0xFF, tci & 0xFF);
    // EtherType
    bytes.push(0x88, 0xBA);
    // APPID
    const appId = typeof config.appID === 'number' ? config.appID : parseInt(config.appID, 16);
    bytes.push((appId >> 8) & 0xFF, appId & 0xFF);
    // Length (placeholder)
    bytes.push(0x00, 0x6C);
    // Reserved1
    bytes.push(config.simulate ? 0x80 : 0x00, 0x00);
    // Reserved2
    bytes.push(0x00, 0x00);
    // APDU start
    bytes.push(0x60, 0x66); // savPdu tag + length
    bytes.push(0x80, 0x01, config.noAsdu || 1); // noASDU
    bytes.push(0xA2, 0x61); // seqASDU tag + length
    bytes.push(0x30, 0x5F); // ASDU SEQUENCE
    // svID
    bytes.push(0x80, config.svID.length);
    for (let i = 0; i < config.svID.length; i++) {
        bytes.push(config.svID.charCodeAt(i));
    }
    
    // Use the same function for consistent byte-level spans
    return generateHexDumpFromBytes(new Uint8Array(bytes));
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the Frame Viewer module
 * @memberof module:FrameViewer
 * @param {HTMLElement} container - Container element to inject template
 */
export function init(container) {
    if (_initialized) {
        console.warn('[FrameViewer] Already initialized');
        return;
    }
    
    console.log('[FrameViewer] Initializing...');
    
    // Inject template
    container.innerHTML = getTemplate();
    
    // Cache elements
    _cacheElements();
    
    // Setup global toggle function
    window.frameViewerToggleNode = toggleNode;
    
    // Bind events
    _bindEvents();
    
    // Subscribe to store changes
    _subscribeToStore();
    
    // Setup global channel editing functions
    window.frameViewerAddChannel = addChannel;
    window.frameViewerRemoveChannel = removeChannel;
    window.frameViewerChangeChannel = changeChannel;
    
    // Setup global hex highlight functions (Wireshark-style)
    window.frameViewerHighlightBytes = highlightBytesForNode;
    window.frameViewerClearHighlight = clearHexHighlight;
    
    // Setup drag and drop for channel reordering
    _setupChannelDragDrop();
    
    // Initial update
    updateFrameViewer();
    
    _initialized = true;
    console.log('[FrameViewer] ✅ Initialized');
}

// ============================================================================
// ELEMENT CACHING
// ============================================================================

function _cacheElements() {
    _elements.packetTree = document.getElementById('packetTree');
    _elements.hexView = document.getElementById('hexView');
    _elements.hexPanel = document.getElementById('hexPanel');
    _elements.hexPanelContent = document.getElementById('hexPanelContent');
    _elements.asduSelect = document.getElementById('asduSelect');
    _elements.toggleHexPanel = document.getElementById('toggleHexPanel');
    _elements.expandAllBtn = document.getElementById('expandAllBtn');
    _elements.collapseAllBtn = document.getElementById('collapseAllBtn');
    _elements.refreshFrameBtn = document.getElementById('refreshFrameBtn');
    _elements.frameDataSource = document.getElementById('frameDataSource');
    _elements.btnEditFrame = document.getElementById('btnEditFrame');
    _elements.btnSaveFrame = document.getElementById('btnSaveFrame');
}

// ============================================================================
// EVENT BINDING
// ============================================================================

function _bindEvents() {
    // Toggle hex panel
    if (_elements.toggleHexPanel) {
        _elements.toggleHexPanel.addEventListener('click', () => {
            _elements.hexPanelContent.classList.toggle('collapsed');
            _elements.toggleHexPanel.textContent = 
                _elements.hexPanelContent.classList.contains('collapsed') ? '▶' : '▼';
        });
    }
    
    // Expand all
    if (_elements.expandAllBtn) {
        _elements.expandAllBtn.addEventListener('click', () => {
            document.querySelectorAll('.tree-node.expandable').forEach(node => {
                const nodeId = node.dataset.nodeId;
                _expandedNodes.add(nodeId);
            });
            updateFrameViewer();
        });
    }
    
    // Collapse all
    if (_elements.collapseAllBtn) {
        _elements.collapseAllBtn.addEventListener('click', () => {
            _expandedNodes.clear();
            updateFrameViewer();
        });
    }
    
    // Refresh/fetch real frame from backend
    if (_elements.refreshFrameBtn) {
        _elements.refreshFrameBtn.addEventListener('click', () => {
            refreshRealFrame();
        });
    }
    
    // ASDU count selector
    if (_elements.asduSelect) {
        _elements.asduSelect.addEventListener('change', (e) => {
            const asduCount = parseInt(e.target.value, 10);
            store.setConfig({ noAsdu: asduCount });
            updateFrameViewer();
        });
    }
    
    // Edit button - enter edit mode
    if (_elements.btnEditFrame) {
        _elements.btnEditFrame.addEventListener('click', () => {
            enterEditMode();
        });
    }
    
    // Save button - save and exit edit mode
    if (_elements.btnSaveFrame) {
        _elements.btnSaveFrame.addEventListener('click', () => {
            saveAndExitEditMode();
        });
    }
}

// ============================================================================
// NODE TOGGLE
// ============================================================================

function toggleNode(nodeId) {
    if (_expandedNodes.has(nodeId)) {
        _expandedNodes.delete(nodeId);
    } else {
        _expandedNodes.add(nodeId);
    }
    
    // Update just the affected node
    const node = document.querySelector(`[data-node-id="${nodeId}"]`);
    if (node) {
        const children = document.getElementById(`children-${nodeId}`);
        const icon = node.querySelector('.expand-icon');
        
        if (_expandedNodes.has(nodeId)) {
            node.classList.remove('collapsed');
            node.classList.add('expanded');
            if (children) children.classList.remove('hidden');
            if (icon) icon.textContent = '▼';
        } else {
            node.classList.remove('expanded');
            node.classList.add('collapsed');
            if (children) children.classList.add('hidden');
            if (icon) icon.textContent = '▶';
        }
    }
}

// ============================================================================
// HEX HIGHLIGHTING (Wireshark-style)
// When hovering over tree nodes, corresponding bytes in hex dump get highlighted
// ============================================================================

/**
 * Highlight bytes in hex dump corresponding to a tree node
 * @param {string} nodeId - The node ID being hovered
 */
function highlightBytesForNode(nodeId) {
    // Clear any existing highlights first
    clearHexHighlight();
    
    // Find the node element to get byte range
    const node = document.querySelector(`[data-node-id="${nodeId}"]`);
    if (!node) return;
    
    const byteStart = parseInt(node.dataset.byteStart, 10);
    const byteLength = parseInt(node.dataset.byteLength, 10);
    
    // If no valid byte range, try to get from parent or skip
    if (isNaN(byteStart) || isNaN(byteLength) || byteLength <= 0) {
        return;
    }
    
    const byteEnd = byteStart + byteLength - 1;
    
    // Highlight the tree node header
    const header = node.querySelector('.tree-node-header');
    if (header) {
        header.classList.add('hex-correlated');
    }
    
    // Highlight corresponding bytes in hex dump
    const hexView = _elements.hexView;
    if (!hexView) return;
    
    // Find and highlight all bytes in range
    for (let i = byteStart; i <= byteEnd; i++) {
        // Highlight hex byte
        const hexByte = hexView.querySelector(`.hex-byte[data-byte-index="${i}"]`);
        if (hexByte) {
            hexByte.classList.add('hex-highlight');
        }
        
        // Also highlight corresponding ASCII character
        const asciiByte = hexView.querySelector(`.ascii-char[data-byte-index="${i}"]`);
        if (asciiByte) {
            asciiByte.classList.add('hex-highlight');
        }
    }
    
    // Store current highlighted node
    _currentHighlightedNode = nodeId;
    
    // Scroll hex view to show highlighted bytes if needed
    const firstHighlighted = hexView.querySelector('.hex-byte.hex-highlight');
    if (firstHighlighted) {
        const hexContent = _elements.hexPanelContent;
        if (hexContent && !hexContent.classList.contains('collapsed')) {
            // Check if element is visible
            const rect = firstHighlighted.getBoundingClientRect();
            const containerRect = hexContent.getBoundingClientRect();
            
            if (rect.top < containerRect.top || rect.bottom > containerRect.bottom) {
                firstHighlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }
}

/**
 * Clear all hex highlighting
 */
function clearHexHighlight() {
    // Clear hex byte highlights
    document.querySelectorAll('.hex-byte.hex-highlight, .ascii-char.hex-highlight').forEach(el => {
        el.classList.remove('hex-highlight');
    });
    
    // Clear tree node header highlight
    document.querySelectorAll('.tree-node-header.hex-correlated').forEach(el => {
        el.classList.remove('hex-correlated');
    });
    
    _currentHighlightedNode = null;
}

// ============================================================================
// EDIT MODE FUNCTIONS
// ============================================================================

// Editable field definitions - which fields in the frame can be edited
// Note: Source MAC (eth-src) is NOT editable - it's determined by the selected network interface
const EDITABLE_FIELDS = [
    { nodeId: 'eth-dst', configKey: 'dstMAC', label: 'Destination MAC', type: 'mac' },
    { nodeId: 'vlan-pri', configKey: 'vlanPriority', label: 'VLAN Priority', type: 'number', min: 0, max: 7 },
    { nodeId: 'vlan-vid', configKey: 'vlanID', label: 'VLAN ID', type: 'number', min: 0, max: 4095 },
    { nodeId: 'sv-appid', configKey: 'appID', label: 'APPID', type: 'hex' },
    { nodeId: 'asdu-0-svid', configKey: 'svID', label: 'svID', type: 'text', maxLength: 65 },
    { nodeId: 'asdu-0-confrev', configKey: 'confRev', label: 'confRev', type: 'number', min: 1 },
    { nodeId: 'asdu-0-smpsynch', configKey: 'smpSynch', label: 'smpSynch', type: 'select', options: [
        { value: 0, label: '0 - Not Synchronized' },
        { value: 1, label: '1 - Local Sync' },
        { value: 2, label: '2 - Global Sync (GPS)' }
    ]}
];

/**
 * Enter edit mode - convert values to input fields
 */
function enterEditMode() {
    if (_isEditMode) return;
    _isEditMode = true;
    
    console.log('[FrameViewer] Entering edit mode');
    
    // Show save button, update edit button style
    if (_elements.btnEditFrame) {
        _elements.btnEditFrame.classList.add('active');
    }
    if (_elements.btnSaveFrame) {
        _elements.btnSaveFrame.classList.remove('hidden');
    }
    
    // Add edit-mode class to packet tree
    if (_elements.packetTree) {
        _elements.packetTree.classList.add('edit-mode');
    }
    
    // Convert each editable field to input
    EDITABLE_FIELDS.forEach(field => {
        const node = document.querySelector(`[data-node-id="${field.nodeId}"]`);
        if (!node) return;
        
        const valueSpan = node.querySelector('.node-value');
        if (!valueSpan) return;
        
        const currentValue = store.get(`config.${field.configKey}`);
        
        // Create appropriate input based on type
        let inputHtml = '';
        
        switch (field.type) {
            case 'mac':
                inputHtml = `<input type="text" class="frame-edit-input" data-field="${field.configKey}" 
                    value="${currentValue}" pattern="^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$" 
                    placeholder="XX:XX:XX:XX:XX:XX" title="${field.label}">`;
                break;
                
            case 'hex':
                const hexVal = typeof currentValue === 'number' 
                    ? '0x' + currentValue.toString(16).toUpperCase().padStart(4, '0')
                    : currentValue;
                inputHtml = `<input type="text" class="frame-edit-input" data-field="${field.configKey}" 
                    value="${hexVal}" placeholder="0x4000" title="${field.label}">`;
                break;
                
            case 'number':
                inputHtml = `<input type="number" class="frame-edit-input" data-field="${field.configKey}" 
                    value="${currentValue}" ${field.min !== undefined ? `min="${field.min}"` : ''} 
                    ${field.max !== undefined ? `max="${field.max}"` : ''} title="${field.label}">`;
                break;
                
            case 'text':
                inputHtml = `<input type="text" class="frame-edit-input" data-field="${field.configKey}" 
                    value="${currentValue}" ${field.maxLength ? `maxlength="${field.maxLength}"` : ''} 
                    title="${field.label}">`;
                break;
                
            case 'select':
                const options = field.options.map(opt => 
                    `<option value="${opt.value}" ${currentValue == opt.value ? 'selected' : ''}>${opt.label}</option>`
                ).join('');
                inputHtml = `<select class="frame-edit-input frame-edit-select" data-field="${field.configKey}" title="${field.label}">
                    ${options}
                </select>`;
                break;
        }
        
        // Store original display value and replace with input
        valueSpan.dataset.originalValue = valueSpan.textContent;
        valueSpan.innerHTML = inputHtml;
        valueSpan.classList.add('editing');
    });
}

/**
 * Save changes and exit edit mode
 * Syncs changes to both store AND backend (Rust/C++)
 */
async function saveAndExitEditMode() {
    if (!_isEditMode) return;
    
    console.log('[FrameViewer] Saving and exiting edit mode');
    
    // Collect values from all inputs
    const updates = {};
    
    EDITABLE_FIELDS.forEach(field => {
        const input = document.querySelector(`.frame-edit-input[data-field="${field.configKey}"]`);
        if (!input) return;
        
        let value = input.value;
        
        // Parse value based on type
        switch (field.type) {
            case 'hex':
                // Convert hex string to number
                value = parseInt(value.replace('0x', ''), 16) || 0;
                break;
            case 'number':
            case 'select':
                value = parseInt(value, 10);
                break;
            case 'mac':
                // Normalize MAC format
                value = value.toUpperCase().replace(/[^0-9A-F:]/g, '');
                break;
        }
        
        updates[field.configKey] = value;
    });
    
    // Update store with all values at once
    store.setConfig(updates);
    
    // ════════════════════════════════════════════════════════════════════════════
    // SYNC TO BACKEND (Rust/C++) - Makes the application "authentic"
    // This ensures config changes go directly to the native code, not just JS
    // ════════════════════════════════════════════════════════════════════════════
    try {
        console.log('[FrameViewer] 📤 Syncing config to Rust backend...');
        const serverData = store.getDataForServer();
        await tauriClient.updateConfig(serverData.config);
        console.log('[FrameViewer] ✅ Config synced to backend successfully!');
        showToast('Configuration saved', 'success');
    } catch (err) {
        console.error('[FrameViewer] ❌ Failed to sync config to backend:', err);
        showToast('Failed to sync config: ' + (err.message || err), 'error');
    }
    
    // Exit edit mode
    _isEditMode = false;
    
    // Hide save button, update edit button style
    if (_elements.btnEditFrame) {
        _elements.btnEditFrame.classList.remove('active');
    }
    if (_elements.btnSaveFrame) {
        _elements.btnSaveFrame.classList.add('hidden');
    }
    
    // Remove edit-mode class
    if (_elements.packetTree) {
        _elements.packetTree.classList.remove('edit-mode');
    }
    
    // Refresh the frame viewer to show updated values
    updateFrameViewer();
    
    console.log('[FrameViewer] ✅ Changes saved:', updates);
}

/**
 * Cancel edit mode without saving
 */
function cancelEditMode() {
    if (!_isEditMode) return;
    
    _isEditMode = false;
    
    // Hide save button
    if (_elements.btnEditFrame) {
        _elements.btnEditFrame.classList.remove('active');
    }
    if (_elements.btnSaveFrame) {
        _elements.btnSaveFrame.classList.add('hidden');
    }
    
    // Remove edit-mode class
    if (_elements.packetTree) {
        _elements.packetTree.classList.remove('edit-mode');
    }
    
    // Refresh to restore original values
    updateFrameViewer();
}

// ============================================================================
// STORE SUBSCRIPTION
// ============================================================================

function _subscribeToStore() {
    store.subscribe('config.*', (value, path) => {
        console.log(`[FrameViewer] Config changed: ${path}, updating frame viewer`);
        updateFrameViewer();
    });
    
    store.subscribe('data.stats.smpCnt', () => {
        // Just update smpCnt display without full rebuild
        const smpCnt = store.get('data.stats.smpCnt') || 0;
        const smpCntNode = document.querySelector('[data-node-id="asdu-0-smpcnt"] .node-value');
        if (smpCntNode) {
            smpCntNode.textContent = `${smpCnt}`;
        }
        const hexNode = document.querySelector('[data-node-id="asdu-0-smpcnt"] .node-hex');
        if (hexNode) {
            hexNode.textContent = `82 02 ${(smpCnt >> 8 & 0xFF).toString(16).padStart(2, '0')} ${(smpCnt & 0xFF).toString(16).padStart(2, '0')}`.toUpperCase();
        }
    });
    
    store.subscribe('data.channels', () => {
        updateChannelValues();
    });
    
    // Subscribe to selectedChannels changes
    store.subscribe('config.selectedChannels', () => {
        updateFrameViewer();
    });
}

// ============================================================================
// CHANNEL EDITING FUNCTIONS
// ============================================================================

/**
 * Add a new channel to seqData
 */
function addChannel() {
    const available = store.getAvailableChannels();
    if (available.length === 0) {
        console.warn('[FrameViewer] No available channels to add');
        return;
    }
    
    // Add first available channel
    const toAdd = available[0];
    store.addSelectedChannel(toAdd.id);
    console.log(`[FrameViewer] Added channel: ${toAdd.id}`);
}

/**
 * Remove a channel from seqData
 * @param {number} index - Channel index to remove
 */
function removeChannel(index) {
    const selected = store.getSelectedChannels();
    if (index < 0 || index >= selected.length) return;
    
    const channelId = selected[index];
    store.removeSelectedChannel(channelId);
    console.log(`[FrameViewer] Removed channel at index ${index}: ${channelId}`);
}

/**
 * Change channel at specific position
 * @param {number} index - Position in seqData
 * @param {string} newChannelId - New channel ID
 */
function changeChannel(index, newChannelId) {
    store.changeSelectedChannelAt(index, newChannelId);
    console.log(`[FrameViewer] Changed channel at ${index} to ${newChannelId}`);
}

// ============================================================================
// DRAG AND DROP FOR CHANNEL REORDERING (Mouse-based)
// ============================================================================

let _isDragging = false;
let _draggedElement = null;
let _draggedIndex = null;
let _dragClone = null;

function _setupChannelDragDrop() {
    const packetTree = _elements.packetTree;
    if (!packetTree) return;
    
    // Use mouse events for more reliable drag-drop in WebView
    packetTree.addEventListener('mousedown', (e) => {
        const dragHandle = e.target.closest('.drag-handle');
        if (!dragHandle) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        const node = dragHandle.closest('.channel-draggable');
        if (!node) return;
        
        _isDragging = true;
        _draggedElement = node;
        _draggedIndex = parseInt(node.dataset.channelIndex, 10);
        _startY = e.clientY;
        
        // Create a visual clone for dragging
        _dragClone = node.cloneNode(true);
        _dragClone.classList.add('drag-clone');
        _dragClone.style.cssText = `
            position: fixed;
            left: ${node.getBoundingClientRect().left}px;
            top: ${e.clientY - 15}px;
            width: ${node.offsetWidth}px;
            opacity: 0.8;
            pointer-events: none;
            z-index: 10000;
            background: var(--card-bg, white);
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            border-radius: 4px;
        `;
        document.body.appendChild(_dragClone);
        
        node.classList.add('dragging');
        
        console.log('[FrameViewer] Mouse drag started for channel index:', _draggedIndex);
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!_isDragging || !_dragClone) return;
        
        // Move the clone
        _dragClone.style.top = `${e.clientY - 15}px`;
        
        // Find potential drop target
        const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
        if (!elemBelow) return;
        
        const dropTarget = elemBelow.closest('.channel-draggable');
        
        // Clear all drag-over states
        document.querySelectorAll('.channel-draggable.drag-over').forEach(el => {
            el.classList.remove('drag-over');
        });
        
        // Highlight drop target
        if (dropTarget && dropTarget !== _draggedElement) {
            dropTarget.classList.add('drag-over');
        }
    });
    
    document.addEventListener('mouseup', (e) => {
        if (!_isDragging) return;
        
        // Remove clone
        if (_dragClone) {
            _dragClone.remove();
            _dragClone = null;
        }
        
        // Find drop target
        const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
        const dropTarget = elemBelow?.closest('.channel-draggable');
        
        if (dropTarget && dropTarget !== _draggedElement) {
            const dropIndex = parseInt(dropTarget.dataset.channelIndex, 10);
            
            console.log(`[FrameViewer] Dropping: moving channel from ${_draggedIndex} to ${dropIndex}`);
            
            // Reorder in store
            store.reorderSelectedChannel(_draggedIndex, dropIndex);
        }
        
        // Cleanup
        if (_draggedElement) {
            _draggedElement.classList.remove('dragging');
        }
        
        document.querySelectorAll('.channel-draggable.drag-over').forEach(el => {
            el.classList.remove('drag-over');
        });
        
        _isDragging = false;
        _draggedElement = null;
        _draggedIndex = null;
        
        console.log('[FrameViewer] Mouse drag ended');
    });
    
    // ========================================================================
    // EXTERNAL DROP ZONE - Accept channels from ChannelsDisplay component
    // ========================================================================
    
    /**
     * We use BOTH systems for maximum compatibility:
     * 1. dragManager (mouse events) - More reliable, works across all containers
     * 2. HTML5 drag events - Fallback for native drag support
     * 
     * dragManager approach:
     * - ChannelsDisplay starts drag via dragManager.startDrag()
     * - We register frame-viewer-module as drop zone
     * - dragManager handles all mouse tracking
     * - On drop, our callback is fired
     */
    
    const frameViewerModule = document.getElementById('frame-viewer-module');
    
    // Helper function to show drop zone feedback
    function showDropZoneFeedback() {
        if (packetTree) {
            packetTree.querySelectorAll('.seqdata-node').forEach(node => {
                node.classList.add('drop-zone-active');
            });
            packetTree.classList.add('external-drag-active');
        }
        if (frameViewerModule) {
            frameViewerModule.classList.add('drop-target-active');
        }
        console.log('[FrameViewer] Drop zone feedback shown');
    }
    
    // Helper function to hide drop zone feedback
    function hideDropZoneFeedback() {
        if (packetTree) {
            packetTree.querySelectorAll('.seqdata-node').forEach(node => {
                node.classList.remove('drop-zone-active');
            });
            packetTree.classList.remove('external-drag-active');
        }
        if (frameViewerModule) {
            frameViewerModule.classList.remove('drop-target-active');
        }
    }
    
    // ========================================
    // REGISTER DROP ZONE WITH DRAG MANAGER
    // This is the primary/reliable method using mouse events
    // ========================================
    
    if (frameViewerModule) {
        registerDropZone('frame-viewer', {
            element: frameViewerModule,
            acceptTypes: ['channel'],  // Accept 'channel' type drags
            
            // Called when channel is dropped on FrameViewer
            onDrop: (channelId, dragType) => {
                console.log('[FrameViewer] Channel dropped via dragManager:', channelId);
                
                // Check if channel is already in selectedChannels
                const selectedChannels = store.get('config.selectedChannels') || [];
                if (selectedChannels.includes(channelId)) {
                    console.log('[FrameViewer] Channel already exists:', channelId);
                    showToast(`${channelId} is already in the frame`, 'warning');
                    return;
                }
                
                // Add channel to selectedChannels
                store.addSelectedChannel(channelId);
                
                console.log('[FrameViewer] ✅ Channel added:', channelId);
                showToast(`${channelId} added to frame`, 'success');
            },
            
            // Called when drag enters FrameViewer area
            onDragEnter: () => {
                showDropZoneFeedback();
            },
            
            // Called when drag leaves FrameViewer area
            onDragLeave: () => {
                hideDropZoneFeedback();
            }
        });
        
        console.log('[FrameViewer] Drop zone registered with dragManager');
    }
}

// ============================================================================
// UPDATE FUNCTIONS
// ============================================================================

/**
 * Refresh frame viewer with real data from backend
 */
async function refreshRealFrame() {
    const smpCnt = store.get('data.stats.smpCnt') || 0;
    
    // Show loading state
    if (_elements.frameDataSource) {
        _elements.frameDataSource.innerHTML = '<span class="source-indicator loading">⏳ Fetching...</span>';
    }
    
    try {
        const bytes = await fetchRealFrameFromBackend(smpCnt);
        if (bytes && bytes.length > 0) {
            _realFrameBytes = bytes;
            _isLiveMode = true;
            
            // Update source indicator
            if (_elements.frameDataSource) {
                _elements.frameDataSource.innerHTML = 
                    `<span class="source-indicator live">📡 Real Frame (${bytes.length} bytes)</span>`;
            }
            
            // Update hex dump with real bytes
            if (_elements.hexView) {
                _elements.hexView.innerHTML = generateHexDumpFromBytes(bytes);
            }
            
            // Parse and update tree with real values
            const parsed = parseRealFrame(bytes);
            if (parsed) {
                updateTreeWithRealData(parsed);
            }
            
            console.log('[FrameViewer] ✅ Updated with real frame data');
        } else {
            // Fall back to calculated
            _realFrameBytes = null;
            _isLiveMode = false;
            
            if (_elements.frameDataSource) {
                _elements.frameDataSource.innerHTML = 
                    '<span class="source-indicator calculated">📐 Calculated (backend unavailable)</span>';
            }
            updateFrameViewer();
        }
    } catch (err) {
        console.warn('[FrameViewer] Error fetching frame:', err);
        _realFrameBytes = null;
        _isLiveMode = false;
        
        if (_elements.frameDataSource) {
            _elements.frameDataSource.innerHTML = 
                '<span class="source-indicator error">❌ Error (using calculated)</span>';
        }
        updateFrameViewer();
    }
}

/**
 * Update tree nodes with real parsed data
 */
function updateTreeWithRealData(parsed) {
    // Update Ethernet fields
    const dstMacNode = document.querySelector('[data-node-id="eth-dst"] .node-value');
    if (dstMacNode) dstMacNode.textContent = parsed.dstMAC;
    
    const srcMacNode = document.querySelector('[data-node-id="eth-src"] .node-value');
    if (srcMacNode) srcMacNode.textContent = parsed.srcMAC;
    
    // Update APPID
    const appIdNode = document.querySelector('[data-node-id="sv-appid"] .node-value');
    if (appIdNode) {
        const appIdHex = parsed.appID.toString(16).toUpperCase().padStart(4, '0');
        appIdNode.textContent = `0x${appIdHex} (${parsed.appID})`;
    }
    
    // Update PDU Length
    const lenNode = document.querySelector('[data-node-id="sv-length"] .node-value');
    if (lenNode) lenNode.textContent = `${parsed.pduLength} bytes`;
    
    // Update Reserved1 (simulation flag)
    const res1Node = document.querySelector('[data-node-id="sv-res1"] .node-value');
    if (res1Node) {
        const res1Hex = parsed.reserved1.toString(16).toUpperCase().padStart(4, '0');
        res1Node.textContent = parsed.reserved1 ? `0x${res1Hex} (Simulation)` : '0x0000';
    }
    
    // Update ASDU fields if parsed
    if (parsed.apdu && parsed.apdu.asdus && parsed.apdu.asdus.length > 0) {
        const asdu = parsed.apdu.asdus[0];
        
        const svIdNode = document.querySelector('[data-node-id="asdu-0-svid"] .node-value');
        if (svIdNode) svIdNode.textContent = `"${asdu.svID}"`;
        
        const smpCntNode = document.querySelector('[data-node-id="asdu-0-smpcnt"] .node-value');
        if (smpCntNode) smpCntNode.textContent = `${asdu.smpCnt}`;
        
        const confRevNode = document.querySelector('[data-node-id="asdu-0-confrev"] .node-value');
        if (confRevNode) confRevNode.textContent = `${asdu.confRev}`;
        
        const smpSynchNode = document.querySelector('[data-node-id="asdu-0-smpsynch"] .node-value');
        if (smpSynchNode) smpSynchNode.textContent = getSmpSynchText(asdu.smpSynch);
        
        // Update channel values
        const channelIds = ['Ia', 'Ib', 'Ic', 'In', 'Va', 'Vb', 'Vc', 'Vn'];
        asdu.seqData.forEach((ch, idx) => {
            if (idx < channelIds.length) {
                const chId = channelIds[idx];
                const valueNode = document.querySelector(`[data-node-id="seqdata-0-${chId}-val"] .node-value`);
                if (valueNode) {
                    const type = chId.startsWith('I') ? 'current' : 'voltage';
                    // Convert to engineering units (divide by scale factor)
                    const scaleFactor = type === 'current' ? 1000 : 100;
                    const engValue = ch.value / scaleFactor;
                    valueNode.textContent = `${engValue.toFixed(3)} ${type === 'current' ? 'A' : 'V'} (raw: ${ch.value})`;
                }
                
                const qualNode = document.querySelector(`[data-node-id="seqdata-0-${chId}-q"] .node-value`);
                if (qualNode) {
                    const qualHex = ch.quality.toString(16).toUpperCase().padStart(8, '0');
                    qualNode.textContent = ch.quality === 0 ? '0x00000000 (Good)' : `0x${qualHex}`;
                }
            }
        });
    }
}

/**
 * Update frame viewer display from store
 * @memberof module:FrameViewer
 */
export function updateFrameViewer() {
    const config = {
        dstMAC: store.get('config.dstMAC') || '01:0C:CD:04:00:00',
        srcMAC: store.get('config.srcMAC') || '00:00:00:00:00:01',
        appID: store.get('config.appID') || 0x4000,
        svID: store.get('config.svID') || 'MU01',
        confRev: store.get('config.confRev') || 1,
        smpSynch: store.get('config.smpSynch') || 2,
        vlanPriority: store.get('config.vlanPriority') || 4,
        vlanID: store.get('config.vlanID') || 0,
        noAsdu: store.get('config.noAsdu') || 1,
        simulate: store.get('config.simulate') || false,
        sampleRate: store.get('config.sampleRate') || 4800,
        frequency: store.get('config.frequency') || 60,
        currentAmplitude: store.get('config.currentAmplitude') || 1000,
        voltageAmplitude: store.get('config.voltageAmplitude') || 11547
    };
    
    // Calculate frame size (used for validation/logging only)
    const frameSize = calculateFrameSize(config);
    console.log(`[FrameViewer] Frame size: ${frameSize} bytes, srcMAC: ${config.srcMAC}`);
    
    // Build and render tree
    const tree = buildFrameTree(config);
    if (_elements.packetTree) {
        _elements.packetTree.innerHTML = tree.map(node => createTreeNode(node)).join('');
    }
    
    // Update hex dump
    if (_elements.hexView) {
        _elements.hexView.innerHTML = generateHexDump(config);
    }
}

/**
 * Update channel values from live data
 */
function updateChannelValues() {
    const channels = store.get('data.channels') || {};
    const channelIds = ['Ia', 'Ib', 'Ic', 'In', 'Va', 'Vb', 'Vc', 'Vn'];
    
    channelIds.forEach(id => {
        const valueNode = document.querySelector(`[data-node-id="seqdata-0-${id}-val"] .node-value`);
        if (valueNode) {
            const channelData = channels[id] || { value: 0 };
            const value = typeof channelData === 'object' ? channelData.value : channelData;
            const type = id.startsWith('I') ? 'current' : 'voltage';
            valueNode.textContent = formatChannelValue(value, type);
        }
    });
}

// ============================================================================
// PUBLIC API
// ============================================================================

export const FrameViewer = {
    init,
    getTemplate,
    updateFrameViewer,
    refreshRealFrame
};

export default FrameViewer;
