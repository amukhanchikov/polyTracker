import { showToast, formatCurrency, escapeHtml, isValidAddress, cleanupOldCache, CACHE_TTL_MS, CACHE_PREFIX, RENDER_DEBOUNCE_MS, SEARCH_DEBOUNCE_MS, fetchWithTimeout, FETCH_TIMEOUT_MS } from './utils.js';
import { getHistoricalMetrics, throttle, getUSDCBalance } from './api.js';
import { loadCustomCategories, saveCustomCategories, resolveCategory } from './categoryManager.js';
import { showSkeleton, calculateTotalVal, renderTable } from './ui.js';
import { fetchActivity } from './activity.js';

// DOM Elements
const searchInput = document.getElementById('wallet-input');
const searchBtn = document.getElementById('search-btn');
const loadingOverlay = document.getElementById('loading');
const dashboard = document.getElementById('dashboard');

// Stats Elements
const totalPortfolioEl = document.getElementById('total-portfolio');
const totalValueEl = document.getElementById('total-value');
const freeUsdcEl = document.getElementById('free-usdc');
const totalPnlEl = document.getElementById('total-pnl');
const positionCountEl = document.getElementById('position-count');
const grossSpentEl = document.getElementById('gross-spent');
const grossReceivedEl = document.getElementById('gross-received');
const grossRedeemedEl = document.getElementById('gross-redeemed');

// Containers
const tableWrapper = document.getElementById('table-wrapper');
const tradesList = document.getElementById('trades-list');
const groupToggle = document.getElementById('group-toggle');

const categoryModal = document.getElementById('category-modal');
const categoryInput = document.getElementById('category-input');
const modalMarketTitle = document.getElementById('modal-market-title');
const saveCategoryBtn = document.getElementById('save-category');
const cancelCategoryBtn = document.getElementById('cancel-category');
const clearCategoryInputBtn = document.getElementById('clear-category-input');
const categoryTagsCloud = document.getElementById('category-tags-cloud');

// Consolidated Application State
const state = {
    customCategories: loadCustomCategories(),
    activeEditConditionId: null,
    activeBulkOldLabel: null,
    positions: [],
    sortCol: localStorage.getItem('polytracker_sortCol') || 'value',
    sortAsc: localStorage.getItem('polytracker_sortAsc') === 'true',
    expandedCategories: JSON.parse(localStorage.getItem('polytracker_expanded') || '{}'),
    searchFilter: '',
    abortController: null,
    lastUpdated: null,
    freeUsdc: null,
};

const lastUpdatedEl = document.getElementById('last-updated');

function formatLastUpdated(ts) {
    if (!ts) return '';
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 10) return 'Updated just now';
    if (sec < 60) return `Updated ${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `Updated ${min}m ago`;
    return `Updated ${Math.floor(min / 60)}h ago`;
}

setInterval(() => {
    if (lastUpdatedEl && state.lastUpdated) {
        lastUpdatedEl.textContent = formatLastUpdated(state.lastUpdated);
    }
}, 5000);

// Helper to trigger UI render with full state
function dispatchRender() {
    renderTable({
        tableWrapper,
        positionCountEl,
        isGrouped: groupToggle.checked,
        searchFilter: state.searchFilter,
        currentPositionsData: state.positions,
        currentSortCol: state.sortCol,
        currentSortAsc: state.sortAsc,
        expandedCategories: state.expandedCategories
    });
}

// Fetch and Render Data
async function analyzeWallet(address) {
    // Cancel any in-flight requests from previous call
    if (state.abortController) {
        state.abortController.abort();
    }
    state.abortController = new AbortController();
    const { signal } = state.abortController;

    // UI State — show skeleton immediately, no spinner overlay
    dashboard.classList.remove('hidden');
    loadingOverlay.classList.add('hidden');
    showSkeleton(tableWrapper);

    // Start spinner on refresh button
    const refreshBtn = document.getElementById('refresh-now-btn');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    tradesList.innerHTML = '';

    try {
        // Fetch Activity (Parallelized)
        const activityPromise = fetchActivity(address, tradesList, {
            grossSpentEl, grossReceivedEl, grossRedeemedEl
        }, signal);

        // Fetch Positions
        const posRes = await fetchWithTimeout(
            `https://data-api.polymarket.com/positions?user=${address}`,
            FETCH_TIMEOUT_MS,
            signal
        );
        if (!posRes.ok) throw new Error("Failed to fetch positions");
        const allPositions = await posRes.json();

        // Check if aborted while awaiting
        if (signal.aborted) return;

        // Filter Open Positions
        const positions = allPositions.filter(p => p.size > 0 && p.currentValue > 0);
        positions.sort((a,b) => (b.currentValue || 0) - (a.currentValue || 0));

        positionCountEl.innerText = positions.length;

        // Process basic position data instantly
        const positionRowsData = positions.map(p => {
            const categoryObj = resolveCategory(p.conditionId, p.title || '', state.customCategories);
            const curPrice = (Number(p.currentValue) || 0) / (parseFloat(p.size) || 1);
            const entryPrice = parseFloat(p.avgPrice) || 0;
            const roi = entryPrice > 0 ? ((curPrice - entryPrice) / entryPrice) * 100 : 0;
            const marketUrl = p.eventSlug
                ? `https://polymarket.com/event/${p.eventSlug}`
                : (p.slug ? `https://polymarket.com/event/${p.slug}` : null);

            return {
                ...p,
                pctChange24h: null, histPrice: null, histTime: null,
                pctChange1h: null, hist1hPrice: null, hist1hTime: null,
                curPrice, roi, category: categoryObj, marketUrl
            };
        });

        state.positions = positionRowsData;
        state.freeUsdc = null; // Will be filled async

        const updateTotalsAndRender = () => {
            if (signal.aborted) return;
            const { totV, totP, totChange24h, totChange1h } = calculateTotalVal(state.positions);
            state.positions.forEach(p => {
                p.weight = totV > 0 ? ((p.currentValue || 0) / totV) * 100 : 0;
            });

            dispatchRender();

            totalValueEl.innerText = formatCurrency(totV);
            totalPnlEl.className = `stat-value ${totP >= 0 ? 'positive' : 'negative'}`;
            totalPnlEl.innerText = formatCurrency(totP);

            // Total portfolio = positions + free USDC (if loaded)
            const totalPortfolio = totV + (state.freeUsdc || 0);
            totalPortfolioEl.innerText = formatCurrency(totalPortfolio);

            const total24hChangeEl = document.getElementById('total-24h-change');
            total24hChangeEl.className = `stat-value ${totChange24h >= 0 ? 'positive' : 'negative'}`;
            total24hChangeEl.innerText = `${totChange24h > 0 ? '+' : ''}${formatCurrency(totChange24h)}`;

            const total1hChangeEl = document.getElementById('total-1h-change');
            total1hChangeEl.className = `stat-value ${totChange1h >= 0 ? 'positive' : 'negative'}`;
            total1hChangeEl.innerText = `${totChange1h > 0 ? '+' : ''}${formatCurrency(totChange1h)}`;
        };

        // Render immediately with current values
        updateTotalsAndRender();

        // Fetch free USDC balance from Polygon in background
        getUSDCBalance(address, signal).then(balance => {
            if (signal.aborted) return;
            state.freeUsdc = balance;
            if (balance !== null) {
                freeUsdcEl.innerText = formatCurrency(balance);
                // Update total portfolio card
                const { totV } = calculateTotalVal(state.positions);
                totalPortfolioEl.innerText = formatCurrency(totV + balance);
            } else {
                freeUsdcEl.innerText = 'N/A';
            }
        });

        // Background load historical metrics — single render after all complete
        Promise.all(state.positions.map(async p => {
            if (signal.aborted) return;

            const cacheKey = CACHE_PREFIX + p.asset;
            let histData = null;
            try {
                const cached = localStorage.getItem(cacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    if (Date.now() - parsed._ts < CACHE_TTL_MS) histData = parsed;
                }
            } catch(e) {}

            if (!histData) {
                histData = await throttle(() => getHistoricalMetrics(p.asset, signal));
                if (histData) {
                    try { localStorage.setItem(cacheKey, JSON.stringify({ ...histData, _ts: Date.now() })); } catch(e) {}
                }
            }

            if (histData && !signal.aborted) {
                p.histPrice = histData.price24h;
                p.histTime = histData.time24h;
                p.hist1hPrice = histData.price1h;
                p.hist1hTime = histData.time1h;
                p.sparkline = histData.sparkline || null;

                // Use pre-calculated pct from api.js (null when window not covered → shows N/A)
                p.pctChange24h = histData.pct24h ?? null;
                p.pctChange1h  = histData.pct1h  ?? null;
            }
        })).then(() => {
            if (!signal.aborted) {
                updateTotalsAndRender();
                state.lastUpdated = Date.now();
                if (lastUpdatedEl) lastUpdatedEl.textContent = formatLastUpdated(state.lastUpdated);
            }
        }).catch(console.error).finally(() => {
            if (refreshBtn) refreshBtn.classList.remove('spinning');
        });

        await activityPromise;

    } catch (e) {
        if (e.name === 'AbortError') return;
        showToast('Error fetching data. Ensure the wallet address is correct.', 'error');
        console.error(e);
    } finally {
        loadingOverlay.classList.add('hidden');
        localStorage.setItem('polytracker_wallet', address);
    }
}

// Event Listeners — Wallet Search
searchBtn.addEventListener('click', () => {
    const val = searchInput.value.trim();
    if (!val) return;
    if (!isValidAddress(val)) {
        showToast('Invalid wallet address. Expected format: 0x... (42 characters)', 'error');
        return;
    }
    analyzeWallet(val);
});

searchInput.addEventListener('keypress', (e) => {
    if(e.key === 'Enter') {
        const val = searchInput.value.trim();
        if (!val) return;
        if (!isValidAddress(val)) {
            showToast('Invalid wallet address. Expected format: 0x... (42 characters)', 'error');
            return;
        }
        analyzeWallet(val);
    }
});

// Position Search Filter
const positionSearchInput = document.getElementById('position-search');
const clearSearchBtn = document.getElementById('clear-search');
let searchDebounce = null;

positionSearchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
        state.searchFilter = positionSearchInput.value.trim();
        clearSearchBtn.classList.toggle('visible', state.searchFilter.length > 0);
        dispatchRender();
    }, SEARCH_DEBOUNCE_MS);
});

clearSearchBtn.addEventListener('click', () => {
    positionSearchInput.value = '';
    state.searchFilter = '';
    clearSearchBtn.classList.remove('visible');
    dispatchRender();
});

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === '/' || (e.ctrlKey && e.key === 'k')) {
        e.preventDefault();
        positionSearchInput.focus();
    }
});

// Column Sorting — via event delegation
document.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;

    const col = th.dataset.sort;
    if (state.sortCol === col) {
        state.sortAsc = !state.sortAsc;
    } else {
        state.sortCol = col;
        state.sortAsc = col === 'market' || col === 'outcome'; // Default asc for strings
    }
    localStorage.setItem('polytracker_sortCol', state.sortCol);
    localStorage.setItem('polytracker_sortAsc', String(state.sortAsc));
    dispatchRender();
});

// Auto-refresh timer
const refreshSelect = document.getElementById('auto-refresh-select');
const refreshCountdown = document.getElementById('refresh-countdown');
let refreshTimer = null;
let countdownTimer = null;
let countdownSec = 0;

function startAutoRefresh(intervalSec) {
    stopAutoRefresh();
    if (intervalSec <= 0) { refreshCountdown.textContent = ''; return; }
    countdownSec = intervalSec;
    updateCountdown();
    countdownTimer = setInterval(() => {
        countdownSec--;
        if (countdownSec <= 0) countdownSec = intervalSec;
        updateCountdown();
    }, 1000);
    refreshTimer = setInterval(() => {
        countdownSec = intervalSec;
        const addr = searchInput.value.trim();
        if (addr) analyzeWallet(addr);
    }, intervalSec * 1000);
}

function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    refreshCountdown.textContent = '';
}

function updateCountdown() {
    const m = Math.floor(countdownSec / 60);
    const s = countdownSec % 60;
    refreshCountdown.textContent = m > 0 ? `${m}:${s.toString().padStart(2,'0')}` : `${s}s`;
}

refreshSelect.value = localStorage.getItem('polytracker_refreshInterval') || '0';
refreshSelect.addEventListener('change', () => {
    const val = parseInt(refreshSelect.value);
    localStorage.setItem('polytracker_refreshInterval', String(val));
    startAutoRefresh(val);
});

// Instant refresh button
const refreshNowBtn = document.getElementById('refresh-now-btn');
refreshNowBtn.addEventListener('click', () => {
    const addr = searchInput.value.trim();
    if (!addr) return;

    // Reset countdown if auto-refresh active
    const interval = parseInt(refreshSelect.value);
    if (interval > 0) {
        countdownSec = interval;
        startAutoRefresh(interval);
    }
    analyzeWallet(addr);
});

// Init state from local storage
groupToggle.checked = localStorage.getItem('polytracker_grouped') === 'true';

groupToggle.addEventListener('change', () => {
    localStorage.setItem('polytracker_grouped', groupToggle.checked);
    state.sortCol = 'value';
    state.sortAsc = false;
    dispatchRender();
});

// === Event Delegation for table actions (replaces window.* globals) ===
document.addEventListener('click', (e) => {
    // Toggle category expand/collapse
    const categoryRow = e.target.closest('[data-action="toggle-category"]');
    if (categoryRow) {
        // Ignore if click was on the rename button
        if (e.target.closest('[data-action="bulk-rename"]')) return;

        const catId = categoryRow.dataset.categoryId;
        const isExpanded = state.expandedCategories[catId] !== false;
        state.expandedCategories[catId] = !isExpanded;
        localStorage.setItem('polytracker_expanded', JSON.stringify(state.expandedCategories));
        dispatchRender();
        return;
    }

    // Edit category for single position
    const editBtn = e.target.closest('[data-action="edit-category"]');
    if (editBtn) {
        const conditionId = decodeURIComponent(editBtn.dataset.condition || '');
        const title = editBtn.dataset.title || '';
        const currentCat = editBtn.dataset.cat || '';
        openCategoryModal(conditionId, title, currentCat);
        return;
    }

    // Bulk rename category
    const renameBtn = e.target.closest('[data-action="bulk-rename"]');
    if (renameBtn) {
        e.stopPropagation();
        const oldLabel = renameBtn.dataset.oldLabel || '';
        openBulkRenameModal(oldLabel);
        return;
    }

    // Category tag selection in modal
    const tagBtn = e.target.closest('[data-action="select-tag"]');
    if (tagBtn) {
        categoryInput.value = tagBtn.dataset.label || '';
        updateCategoryTagHighlights();
        return;
    }
});

// === Category Modal Functions ===
function openCategoryModal(conditionId, title, currentCat) {
    state.activeEditConditionId = conditionId;
    state.activeBulkOldLabel = null;
    modalMarketTitle.innerText = title;
    const initialVal = currentCat !== 'Other' ? currentCat : '';
    categoryInput.value = initialVal;
    categoryModal.classList.remove('hidden');
    categoryModal.setAttribute('role', 'dialog');
    categoryModal.setAttribute('aria-modal', 'true');

    setTimeout(() => {
        categoryInput.focus();
        categoryInput.select();
    }, 50);

    buildCategoryTagsCloud(initialVal);
}

function openBulkRenameModal(oldLabel) {
    state.activeBulkOldLabel = oldLabel;
    state.activeEditConditionId = null;
    const titleText = `Renaming all positions in "${oldLabel}"`;
    modalMarketTitle.innerText = titleText;
    categoryInput.value = oldLabel;
    categoryModal.classList.remove('hidden');
    categoryModal.setAttribute('role', 'dialog');
    categoryModal.setAttribute('aria-modal', 'true');

    setTimeout(() => {
        categoryInput.focus();
        categoryInput.select();
    }, 50);

    buildCategoryTagsCloud(oldLabel);
}

function buildCategoryTagsCloud(initialVal) {
    if (!categoryTagsCloud) return;

    const usedLabels = new Set();
    state.positions.forEach(p => {
        if (p.category && p.category.label && p.category.label !== 'Other') {
            usedLabels.add(p.category.label);
        }
    });

    const sortedLabels = Array.from(usedLabels).sort();

    if (sortedLabels.length === 0) {
        categoryTagsCloud.innerHTML = '<div class="tags-cloud-empty">No categories in use. Type to create one.</div>';
    } else {
        categoryTagsCloud.innerHTML = sortedLabels.map(l => {
            const isActive = l.toLowerCase() === (initialVal || '').toLowerCase();
            return `<button class="category-tag ${isActive ? 'active' : ''}" data-action="select-tag" data-label="${escapeHtml(l)}">${escapeHtml(l)}</button>`;
        }).join('');
    }
}

function updateCategoryTagHighlights() {
    const currentVal = categoryInput.value.trim().toLowerCase();
    document.querySelectorAll('.category-tag').forEach(t => {
        t.classList.toggle('active', t.innerText.trim().toLowerCase() === currentVal);
    });
}

categoryInput.addEventListener('input', updateCategoryTagHighlights);

if (clearCategoryInputBtn) {
    clearCategoryInputBtn.addEventListener('click', () => {
        categoryInput.value = '';
        categoryInput.focus();
        updateCategoryTagHighlights();
    });
}

function closeCategoryModal() {
    categoryModal.classList.add('hidden');
    categoryModal.removeAttribute('role');
    categoryModal.removeAttribute('aria-modal');
    categoryInput.value = '';
    state.activeEditConditionId = null;
    state.activeBulkOldLabel = null;
}

cancelCategoryBtn.addEventListener('click', closeCategoryModal);

saveCategoryBtn.addEventListener('click', () => {
    const newCat = categoryInput.value.trim();

    if (state.activeBulkOldLabel) {
        state.positions.forEach(p => {
            if (p.category && p.category.label === state.activeBulkOldLabel) {
                if (newCat) state.customCategories[p.conditionId] = newCat;
                else delete state.customCategories[p.conditionId];
            }
        });
    } else if (state.activeEditConditionId) {
        if (newCat) state.customCategories[state.activeEditConditionId] = newCat;
        else delete state.customCategories[state.activeEditConditionId];
    } else {
        closeCategoryModal();
        return;
    }

    saveCustomCategories(state.customCategories);
    closeCategoryModal();

    for (let p of state.positions) {
        p.category = resolveCategory(p.conditionId, p.title, state.customCategories);
    }

    dispatchRender();
});

// Close modal on backdrop click
categoryModal.addEventListener('click', (e) => {
    if (e.target === categoryModal) closeCategoryModal();
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !categoryModal.classList.contains('hidden')) {
        closeCategoryModal();
    }
});

categoryInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') saveCategoryBtn.click();
});

// Focus trap for modal accessibility
categoryModal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = categoryModal.querySelectorAll('input, button:not([disabled])');
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
});

// Auto-run on load
window.onload = () => {
    // Cleanup old cache entries
    cleanupOldCache();

    const savedWallet = localStorage.getItem('polytracker_wallet');
    const inputVal = searchInput.value.trim();

    if (inputVal) {
        analyzeWallet(inputVal);
    } else if (savedWallet) {
        searchInput.value = savedWallet;
        analyzeWallet(savedWallet);
    }

    const savedInterval = parseInt(localStorage.getItem('polytracker_refreshInterval') || '0');
    if (savedInterval > 0) startAutoRefresh(savedInterval);
};
