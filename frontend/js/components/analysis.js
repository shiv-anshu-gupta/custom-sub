/**
 * @file components/analysis.js
 * @brief Compact event log for SV stream quality analysis
 *
 * Shows a single compact, scrollable event log below the Frame Structure
 * viewer. Events are colour-coded by type (MISS / OOO / ERR / DUP) and
 * clicking a row navigates the Data Table to that frame.
 *
 * The top cards row already shows aggregate counters, and the frame viewer
 * shows per-frame analysis, so this log adds chronological event history
 * without duplicating information in large panels.
 */

const SVAnalysis = {

    /** @private Unified event list (all categories) */
    _events: [],
    _maxEvents: 200,
    /** @private Running counters — avoids full-array recount on every badge update */
    _counts: { MISS: 0, OOO: 0, ERR: 0, DUP: 0 },

    /**
     * Returns a compact event log panel template
     * @returns {string} HTML string
     */
    getTemplate() {
        return `
            <div class="event-log-panel" id="eventLogPanel">
                <div class="event-log-header">
                    <div class="event-log-title">
                        <span class="event-log-icon">📋</span>
                        <span>Event Log</span>
                        <span class="event-log-count" id="eventLogCount">0</span>
                    </div>
                    <div class="event-log-badges">
                        <span class="evl-badge evl-miss" id="evlMissCount" title="Missing sequences">MISS 0</span>
                        <span class="evl-badge evl-ooo" id="evlOooCount" title="Out-of-order">OOO 0</span>
                        <span class="evl-badge evl-err" id="evlErrCount" title="Decode errors">ERR 0</span>
                        <span class="evl-badge evl-dup" id="evlDupCount" title="Duplicates">DUP 0</span>
                    </div>
                    <button class="btn-sm" id="btnClearLog" title="Clear event log">Clear</button>
                </div>
                <div class="event-log-body" id="eventLogBody">
                    <div class="event-log-empty" id="eventLogEmpty">No quality events — stream is clean</div>
                </div>
            </div>
        `;
    },

    init() {
        const btn = document.getElementById('btnClearLog');
        if (btn) btn.addEventListener('click', () => this.clear());
    },

    /**
     * Clear all events and reset the log
     */
    clear() {
        this._events = [];
        this._counts = { MISS: 0, OOO: 0, ERR: 0, DUP: 0 };
        const body = document.getElementById('eventLogBody');
        if (body) body.innerHTML = '<div class="event-log-empty" id="eventLogEmpty">No quality events — stream is clean</div>';
        this._updateBadges();
    },

    // ====================================================================
    // Incremental Update — called from pollData() with new frames
    // ====================================================================

    /**
     * Process newly arrived frames, extract events, render incrementally.
     * Uses DocumentFragment append for new events (avoids full innerHTML rebuild).
     * @param {Array} frames - New frames from poll_data
     */
    addNewFrames(frames) {
        const newEvents = [];

        for (const f of frames) {

            // Decode / structure errors
            if (f.errors > 0) {
                const ev = {
                    type: 'ERR', css: 'evl-err',
                    index: f.index, smpCnt: f.smpCnt,
                    text: f.errorStr || 'Decode error'
                };
                this._events.push(ev);
                newEvents.push(ev);
            }

            // C++ analysis flags
            if (f.analysis) {
                const flags = f.analysis.flags || 0;

                if (flags & 0x10000) {
                    const ev = {
                        type: 'MISS', css: 'evl-miss',
                        index: f.index, smpCnt: f.smpCnt,
                        text: `Gap of ${f.analysis.gapSize} (${f.analysis.missingFrom} → ${f.analysis.missingTo})`
                    };
                    this._events.push(ev);
                    newEvents.push(ev);
                }
                if (flags & 0x20000) {
                    const ev = {
                        type: 'OOO', css: 'evl-ooo',
                        index: f.index, smpCnt: f.smpCnt,
                        text: `Expected ${f.analysis.expected}, got ${f.analysis.actual}`
                    };
                    this._events.push(ev);
                    newEvents.push(ev);
                }
                if (flags & 0x40000) {
                    const ev = {
                        type: 'DUP', css: 'evl-dup',
                        index: f.index, smpCnt: f.smpCnt,
                        text: `smpCnt=${f.smpCnt} repeated`
                    };
                    this._events.push(ev);
                    newEvents.push(ev);
                }
            }
        }

        // Update running counters for new events
        for (const ev of newEvents) this._counts[ev.type]++;

        // Trim oldest events (requires full DOM rebuild + counter recompute)
        let needsFullRender = false;
        if (this._events.length > this._maxEvents) {
            this._events = this._events.slice(-this._maxEvents);
            this._counts = { MISS: 0, OOO: 0, ERR: 0, DUP: 0 };
            for (const ev of this._events) this._counts[ev.type]++;
            needsFullRender = true;
        }

        if (newEvents.length > 0) {
            if (needsFullRender) {
                this._render();
            } else {
                this._appendEvents(newEvents);
            }
        }
    },

    /**
     * Append new events to DOM incrementally using DocumentFragment.
     * Much faster than full innerHTML rebuild for small batches.
     * @private
     * @param {Array} events - New event objects to append
     */
    _appendEvents(events) {
        const body = document.getElementById('eventLogBody');
        if (!body) return;

        // Remove empty placeholder if present
        const empty = document.getElementById('eventLogEmpty');
        if (empty) empty.remove();

        // Trim old DOM nodes to keep max 100 visible
        const maxVisible = 100;
        const excess = body.children.length + events.length - maxVisible;
        for (let i = 0; i < excess && body.firstChild; i++) {
            body.removeChild(body.firstChild);
        }

        // Single DOM insertion via DocumentFragment
        const frag = document.createDocumentFragment();
        for (const ev of events) {
            const div = document.createElement('div');
            div.className = 'evl-row';
            div.setAttribute('onclick', `SVTable.scrollToFrame(${ev.index})`);
            div.innerHTML =
                `<span class="evl-badge ${ev.css}">${ev.type}</span>` +
                `<span class="evl-frame">#${ev.index}</span>` +
                `<span class="evl-smpcnt">smpCnt ${ev.smpCnt}</span>` +
                `<span class="evl-detail">${ev.text}</span>`;
            frag.appendChild(div);
        }
        body.appendChild(frag);
        body.scrollTop = body.scrollHeight;

        this._updateBadges();
    },

    // ====================================================================
    // Render
    // ====================================================================

    /** @private Render the event log body + badge counters */
    _render() {
        const body = document.getElementById('eventLogBody');
        if (!body) return;

        // Show last 100 events (newest at bottom, auto-scroll)
        const visible = this._events.slice(-100);

        if (visible.length === 0) {
            body.innerHTML = '<div class="event-log-empty" id="eventLogEmpty">No quality events — stream is clean</div>';
        } else {
            let html = '';
            for (const ev of visible) {
                html += `<div class="evl-row" onclick="SVTable.scrollToFrame(${ev.index})">` +
                    `<span class="evl-badge ${ev.css}">${ev.type}</span>` +
                    `<span class="evl-frame">#${ev.index}</span>` +
                    `<span class="evl-smpcnt">smpCnt ${ev.smpCnt}</span>` +
                    `<span class="evl-detail">${ev.text}</span>` +
                    `</div>`;
            }
            body.innerHTML = html;
            body.scrollTop = body.scrollHeight;
        }

        this._updateBadges();
    },

    /** @private Update the compact badge counters in the header */
    _updateBadges() {
        const c = this._counts;
        const total = this._events.length;
        const el = (id, text) => { const e = document.getElementById(id); if (e) e.textContent = text; };

        el('eventLogCount', total);
        el('evlMissCount', `MISS ${c.MISS}`);
        el('evlOooCount', `OOO ${c.OOO}`);
        el('evlErrCount', `ERR ${c.ERR}`);
        el('evlDupCount', `DUP ${c.DUP}`);
    }
};
