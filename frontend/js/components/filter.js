/**
 * @file components/filter.js
 * @brief Search, filter, and channel toggles component
 *
 * Provides:
 *   - Text search with debounce (searches across all table columns)
 *   - Quality filter dropdown (All / Errors / Missing / OOO / Duplicates / OK)
 *   - Channel toggle buttons (show/hide individual channels)
 *   - Auto-scroll checkbox
 */

const SVFilter = {

    /** @private Debounce timer for search input */
    _debounceTimer: null,

    /**
     * Returns the filter bar HTML template
     * @returns {string} HTML string
     */
    getTemplate() {
        return `
            <div class="filter-bar">
                <div class="filter-group">
                    <label>Search:</label>
                    <input type="text" id="searchInput" placeholder="Search svID, smpCnt, errors..."
                           class="input-field">
                </div>
                <div class="filter-group">
                    <label>Filter:</label>
                    <select id="filterType" class="input-field">
                        <option value="all">All Frames</option>
                        <option value="errors">Errors Only</option>
                        <option value="missing">Missing Sequence</option>
                        <option value="out-of-order">Out-of-Order</option>
                        <option value="duplicates">Duplicates</option>
                        <option value="ok">OK Only</option>
                    </select>
                </div>
                <div class="filter-group">
                    <label>Channels:</label>
                    <div class="channel-toggles" id="channelToggles"></div>
                </div>
                <div class="filter-group">
                    <label>Auto-scroll:</label>
                    <input type="checkbox" id="autoScroll" checked>
                </div>
            </div>
        `;
    },

    /**
     * Initialize filter bar — bind search, filter, auto-scroll, channel toggles
     */
    init() {
        const searchInput = document.getElementById('searchInput');

        // Search input with 400ms debounce — defers table updates during typing
        searchInput.addEventListener('input', (e) => {
            SVApp._userInteracting = true;
            clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => {
                this._handleSearch(e.target.value);
                SVApp._userInteracting = false;
            }, 400);
        });

        // Escape to clear search
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                searchInput.value = '';
                SVApp._userInteracting = false;
                this._handleSearch('');
            }
        });

        // Filter dropdown
        document.getElementById('filterType').addEventListener('change', (e) => {
            document.getElementById('searchInput').value = '';
            if (typeof SVTable !== 'undefined') {
                SVTable.applyFilter(e.target.value);
            }
        });

        // Auto-scroll checkbox
        document.getElementById('autoScroll').addEventListener('change', (e) => {
            SVApp.autoScroll = e.target.checked;
        });

        // Initial 8-channel toggles
        this.initChannelToggles(8);
    },

    /**
     * Handle search query — routes to SVTable
     * @private
     * @param {string} query
     */
    _handleSearch(query) {
        if (typeof SVTable === 'undefined') return;

        if (query.trim() === '') {
            // Re-apply dropdown filter if set, otherwise just clear
            const filterType = document.getElementById('filterType').value;
            if (filterType !== 'all') {
                SVTable.applyFilter(filterType); // internally batches clear+add
            } else {
                SVTable.table.clearFilter();
            }
        } else {
            SVTable.search(query.trim());
        }
    },

    /**
     * Create channel toggle buttons dynamically
     * @param {number} count - Number of channels
     */
    initChannelToggles(count) {
        const container = document.getElementById('channelToggles');
        if (!container) return;
        container.innerHTML = '';

        for (let i = 0; i < count; i++) {
            const btn = document.createElement('button');
            btn.className = 'ch-toggle active';
            btn.textContent = i;
            btn.dataset.channel = i;
            btn.title = `Channel ${i}`;

            btn.addEventListener('click', () => {
                btn.classList.toggle('active');
                const bit = 1 << i;
                if (btn.classList.contains('active')) {
                    SVApp.channelMask |= bit;
                } else {
                    SVApp.channelMask &= ~bit;
                }
            });

            container.appendChild(btn);
        }
    }
};
