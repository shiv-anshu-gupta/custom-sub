/**
 * @file components/table.js
 * @brief Tabulator-based SV Packet Table component
 *
 * Columns: Number | SmpCount | svID | Channel Data (Va..In) | Packet Quality
 *
 * Stores full frame data (including Ethernet headers) so that
 * clicking a row can display the complete frame structure in SVFrameView.
 *
 * Packet Quality values:
 *   Good           — No issues detected
 *   Missed         — Missing sequence number(s)
 *   Out of Seq     — Sample arrived out of expected order
 *   Duplicate      — Same smpCnt received again
 *   Dup Timestamp  — Same pcap timestamp as previous frame (same svID)
 *   Bad Structure  — Ethernet/BER decode error
 */

const SVTable = {

    table: null,
    maxRows: 2000,

    /** @private Throttle flag for scrollToRow */
    _scrollPending: false,
    /** @private Channel columns already added */
    _channelsAdded: false,
    /** @private Last frame index sent to Tabulator (for incremental adds) */
    _lastRenderedIndex: 0,
    /** @private Approximate row count currently in Tabulator */
    _tableRowCount: 0,

    /**
     * Returns the table container HTML template
     * @returns {string} HTML string
     */
    getTemplate() {
        return '<div id="sv-table"></div>';
    },

    /**
     * Initialize Tabulator table instance and bind events
     */
    init() {
        this.table = new Tabulator('#sv-table', {
            height: '100%',
            layout: 'fitDataFill',
            movableColumns: false,
            resizableRows: false,
            selectable: 1,
            placeholder: 'No SV data received yet. Click \"Capture\" to start.',
            renderVerticalBuffer: 100,
            reactiveData: false,
            index: 'index',

            rowFormatter: (row) => {
                const data = row.getData();
                const q = data._quality;
                const el = row.getElement();
                if (q && q !== 'Good') {
                    const cls = q === 'Bad Structure' ? 'row-error' :
                                q === 'Missed' ? 'row-missing' :
                                q === 'Out of Seq' ? 'row-out-of-order' :
                                q === 'Duplicate' ? 'row-duplicate' :
                                q === 'Dup Timestamp' ? 'row-dup-timestamp' : '';
                    if (cls) el.classList.add(cls);
                }
            },

            columns: [
                {
                    title: 'No', field: 'rowNum', width: 60,
                    frozen: true, headerSort: false, formatter: 'plaintext'
                },
                {
                    title: 'Time', field: 'relTime', width: 110,
                    headerSort: false,
                    formatter: (cell) => {
                        const us = cell.getValue();
                        if (us === undefined || us === null) return '—';
                        // Show as seconds with 6 decimal places (microsecond precision)
                        const sec = us / 1000000;
                        return sec.toFixed(6);
                    }
                },
                {
                    title: 'SmpCount', field: 'smpCnt', width: 85,
                    headerSort: false, formatter: 'plaintext'
                },
                {
                    title: 'svID', field: 'svID', width: 80,
                    headerSort: false, formatter: 'plaintext'
                },
                // Dynamic channel columns (Va..In) inserted before this column
                {
                    title: 'Packet Quality', field: '_quality', width: 140,
                    headerSort: false,
                    headerFilter: 'list',
                    headerFilterParams: {
                        values: {
                            '': 'All', 'Good': 'Good', 'Missed': 'Missed',
                            'Out of Seq': 'Out of Seq', 'Duplicate': 'Duplicate',
                            'Dup Timestamp': 'Dup Timestamp',
                            'Bad Structure': 'Bad Structure'
                        }
                    },
                    formatter: (cell) => {
                        const val = cell.getValue();
                        const badges = {
                            'Good': 'badge-ok',
                            'Missed': 'badge-warn',
                            'Out of Seq': 'badge-error',
                            'Duplicate': 'badge-info',
                            'Dup Timestamp': 'badge-dup-ts',
                            'Bad Structure': 'badge-error'
                        };
                        return badges[val]
                            ? `<span class="badge ${badges[val]}">${val}</span>`
                            : val;
                    }
                }
            ],
        });

        // Row click → load frame detail for analysis tab (don't auto-switch tabs)
        this.table.on('rowClick', async (e, row) => {
            const data = row.getData();

            // Build a usable frame from row data (works even if backend fails)
            const rowFrame = this._rowToFrame(data);

            try {
                const fullFrame = await backendCall('get_frame_detail', { frameIndex: data.index });
                // Use backend frame if it looks valid, otherwise use row data
                SVFrameView.showFrame(
                    (fullFrame && typeof fullFrame === 'object' && 'smpCnt' in fullFrame)
                        ? fullFrame : rowFrame
                );
            } catch (err) {
                console.warn('[table] get_frame_detail failed, using row data:', err);
                SVFrameView.showFrame(rowFrame);
            }
        });

        console.log('[table] Tabulator initialized');
    },

    /**
     * Add channel columns dynamically (called once when first data arrives)
     * @param {number} channelCount
     */
    addChannelColumns(channelCount) {
        const existingCols = this.table.getColumns();
        if (existingCols.some(c => c.getField() && c.getField().startsWith('ch_'))) return;

        const names = [
            'Ch0', 'Ch1', 'Ch2', 'Ch3', 'Ch4', 'Ch5', 'Ch6', 'Ch7',
            'Ch8', 'Ch9', 'Ch10', 'Ch11', 'Ch12', 'Ch13', 'Ch14', 'Ch15',
            'Ch16', 'Ch17', 'Ch18', 'Ch19',
        ];

        for (let i = 0; i < channelCount && i < 20; i++) {
            const name = i < names.length ? names[i] : `Ch${i}`;
            this.table.addColumn({
                title: name,
                field: `ch_${i}`,
                width: 80,
                headerSort: false,
                formatter: 'plaintext'
            }, false, '_quality');
        }
    },

    /**
     * Determine packet quality string from C++ analysis flags
     * @param {Object} frame
     * @returns {string} Quality label
     */
    getPacketQuality(frame) {
        if (frame.errors > 0) return 'Bad Structure';
        if (frame.analysis) {
            if (frame.analysis.flags & 0x10000) return 'Missed';
            if (frame.analysis.flags & 0x20000) return 'Out of Seq';
            if (frame.analysis.flags & 0x40000) return 'Duplicate';
            if (frame.analysis.dupTsGroupSize > 1) return 'Dup Timestamp';
        }
        return 'Good';
    },

    /**
     * Incrementally update table with new rows from the buffer.
     *
     * KEY DESIGN: Uses addData() for new rows instead of replaceData().
     *   - addData() only appends new DOM elements — existing rows are UNTOUCHED
     *   - Row click events, header filter focus, scroll position all survive
     *   - replaceData() only fires periodically when old rows need cleanup
     *     (every ~3s instead of every 500ms)
     *
     * This eliminates the root cause of:
     *   - Row clicks not registering (row element destroyed mid-click)
     *   - Search input losing responsiveness (main thread blocked by full rebuild)
     *   - Header filter dropdowns resetting
     *
     * @param {Array} rows — Complete row buffer (already trimmed by caller)
     */
    replaceRows(rows) {
        if (!this.table || rows.length === 0) return;

        // Add channel columns on first data (one-time)
        if (!this._channelsAdded && rows[0] && rows[0].ch_0 !== undefined) {
            let count = 0;
            while (rows[0][`ch_${count}`] !== undefined) count++;
            this.addChannelColumns(count);
            this._channelsAdded = true;
        }

        // Determine which rows are new since last render
        const newRows = this._lastRenderedIndex > 0
            ? rows.filter(r => r.index > this._lastRenderedIndex)
            : null; // null = first render, use all rows

        this._lastRenderedIndex = rows[rows.length - 1].index;

        // Nothing new since last render → skip entirely
        if (newRows && newRows.length === 0) return;

        this.table.blockRedraw();

        if (!newRows || this._tableRowCount + newRows.length > this.maxRows * 2) {
            // Full replace: first render OR periodic cleanup when too many old rows
            // This runs roughly every 2-3 seconds instead of every 1s
            this.table.replaceData(rows);
            this._tableRowCount = rows.length;
        } else {
            // Incremental append — existing DOM rows are NEVER destroyed
            this.table.addData(newRows, false);
            this._tableRowCount += newRows.length;
        }

        this.table.restoreRedraw();

        // Throttled auto-scroll (max once per 750ms)
        if (SVApp.autoScroll && !this._scrollPending) {
            this._scrollPending = true;
            setTimeout(() => {
                this._scrollPending = false;
                if (this.table && rows.length > 0) {
                    const lastIdx = rows[rows.length - 1].index;
                    if (lastIdx !== undefined) {
                        try { this.table.scrollToRow(lastIdx, 'bottom', false); }
                        catch(e) { /* row may have scrolled out */ }
                    }
                }
            }, 750);
        }
    },

    /**
     * Apply quality filter from dropdown
     * @param {string} filterType
     */
    applyFilter(filterType) {
        if (!this.table) return;

        // blockRedraw batches clear+add into a single render pass
        this.table.blockRedraw();
        this.table.clearFilter();

        const map = {
            'errors': ['_quality', '=', 'Bad Structure'],
            'missing': ['_quality', '=', 'Missed'],
            'out-of-order': ['_quality', '=', 'Out of Seq'],
            'duplicates': ['_quality', '=', 'Duplicate'],
            'ok': ['_quality', '=', 'Good']
        };

        if (map[filterType]) {
            this.table.addFilter(...map[filterType]);
        }
        this.table.restoreRedraw();
    },

    /**
     * Full-text search across all visible columns.
     * Uses pre-computed _searchStr on each row for O(1) matching.
     * Clears previous filters first to prevent filter stacking.
     * @param {string} query
     */
    search(query) {
        if (!this.table || !query) {
            this.table?.clearFilter();
            return;
        }

        const lower = query.toLowerCase();

        // blockRedraw prevents double-render from clearFilter+addFilter
        this.table.blockRedraw();
        this.table.clearFilter();
        this.table.addFilter((data) => {
            // Fast path: use pre-computed search string
            if (data._searchStr) return data._searchStr.includes(lower);
            // Fallback for rows without precomputed string
            return String(data.index).includes(query) ||
                   (data.svID && data.svID.toLowerCase().includes(lower)) ||
                   String(data.smpCnt).includes(query) ||
                   (data._quality && data._quality.toLowerCase().includes(lower));
        });
        this.table.restoreRedraw();
    },

    /** Clear all table data and reset tracking state */
    clear() {
        if (this.table) this.table.clearData();
        this._channelsAdded = false;
        this._lastRenderedIndex = 0;
        this._tableRowCount = 0;
    },

    /**
     * Convert a flat Tabulator row into a frame object usable by SVFrameView.
     * Reconstructs the channels[] array and channelCount from flat ch_N fields.
     * @private
     * @param {Object} rowData - Row data from Tabulator getData()
     * @returns {Object} Frame-like object for SVFrameView.showFrame()
     */
    _rowToFrame(rowData) {
        const frame = {
            index:    rowData.index,
            svID:     rowData.svID,
            smpCnt:   rowData.smpCnt,
            errors:   rowData.errors || 0,
            analysis: rowData.analysis,
            noASDU:   rowData.noASDU || 1,
            asduIndex: rowData.asduIndex || 0,
        };
        // Reconstruct channels array from flat ch_0..ch_N fields
        const channels = [];
        let i = 0;
        while (rowData[`ch_${i}`] !== undefined) {
            channels.push(rowData[`ch_${i}`]);
            i++;
        }
        if (channels.length > 0) {
            frame.channels = channels;
            frame.channelCount = channels.length;
        }
        return frame;
    },

    /**
     * Scroll to a specific frame by index
     * @param {number} frameIndex
     */
    scrollToFrame(frameIndex) {
        if (this.table) this.table.scrollToRow(frameIndex, 'center', true);
    },

    /**
     * Get all current table data
     * @returns {Array}
     */
    getAllData() {
        return this.table ? this.table.getData() : [];
    }
};
