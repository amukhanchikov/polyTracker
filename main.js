import { showToast, formatCurrency, escapeHtml, isValidAddress, cleanupOldCache, CACHE_TTL_MS, CACHE_PREFIX, SEARCH_DEBOUNCE_MS, fetchWithTimeout, FETCH_TIMEOUT_MS } from './utils.js';
import { getHistoricalMetrics, throttle, getUSDCBalance } from './api.js';
import { loadCustomCategories, saveCustomCategories, resolveCategory } from './categoryManager.js';
import { showSkeleton, calculateTotalVal, renderTable, setGroupSort, getGroupSort } from './ui.js';
import { fetchActivity } from './activity.js';

// localStorage keys
const LS = {
    WALLETS: 'polytracker_wallets',
    WALLET_OLD: 'polytracker_wallet',
    SORT_COL: 'polytracker_sortCol',
    SORT_ASC: 'polytracker_sortAsc',
    EXPANDED: 'polytracker_expanded',
    GROUPED: 'polytracker_grouped',
    REFRESH_INTERVAL: 'polytracker_refreshInterval',
};

// DOM Elements
const walletInput = document.getElementById('wallet-input');
const addWalletBtn = document.getElementById('add-wallet-btn');
const loadingOverlay = document.getElementById('loading');
const dashboard = document.getElementById('dashboard');

// Stats Elements
const totalPortfolioEl = document.getElementById('total-portfolio');
const totalValueEl = document.getElementById('total-value');
const freeUsdcEl = document.getElementById('free-usdc');
const totalPnlEl = document.getElementById('total-pnl');
const total24hChangeEl = document.getElementById('total-24h-change');
const total1hChangeEl = document.getElementById('total-1h-change');
const positionCountEl = document.getElementById('position-count');
const grossSpentEl = document.getElementById('gross-spent');
const grossCashInEl = document.getElementById('gross-cash-in');

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

// Wallet colors — up to 6 distinct wallets
const WALLET_COLORS = ['#58a6ff', '#3fb950', '#ffa657', '#d2a8ff', '#ff7b72', '#79c0ff'];

// Consolidated Application State
const state = {
    customCategories: loadCustomCategories(),
    activeEditConditionId: null,
    activeBulkOldLabel: null,
    wallets: [], // [{ address, colorIdx, positions, freeUsdc, abortController }]
    sortCol: localStorage.getItem(LS.SORT_COL) || 'value',
    sortAsc: localStorage.getItem(LS.SORT_ASC) === 'true',
    expandedCategories: JSON.parse(localStorage.getItem(LS.EXPANDED) || '{}'),
    searchFilter: '',
    lastUpdated: null,
};

let activityAbortController = null;

let _positionsCache = null;
function invalidatePositionsCache() { _positionsCache = null; }
function getAllPositions() {
    if (!_positionsCache) _positionsCache = state.wallets.flatMap(w => w.positions);
    return _positionsCache;
}

function getNextColorIdx() {
    const used = new Set(state.wallets.map(w => w.colorIdx));
    for (let i = 0; i < WALLET_COLORS.length; i++) {
        if (!used.has(i)) return i;
    }
    return state.wallets.length % WALLET_COLORS.length;
}

function saveWallets() {
    localStorage.setItem(LS.WALLETS, JSON.stringify(state.wallets.map(w => w.address)));
}

// ===========================
//   WALLET CHIP UI
// ===========================
function renderWalletChips() {
    const chipsEl = document.getElementById('wallet-chips');
    if (!chipsEl) return;

    chipsEl.innerHTML = state.wallets.map(w => {
        const color = WALLET_COLORS[w.colorIdx % WALLET_COLORS.length];
        const short = w.address.slice(0, 6) + '…' + w.address.slice(-4);
        return `<span class="wallet-chip" data-address="${escapeHtml(w.address)}">
            <span class="wallet-dot" style="background:${color}"></span>
            <span class="wallet-addr" title="${escapeHtml(w.address)}">${escapeHtml(short)}</span>
            <button class="wallet-chip-remove" data-action="remove-wallet" data-address="${escapeHtml(w.address)}" title="Remove wallet">×</button>
        </span>`;
    }).join('');

    // Show/hide chips container
    chipsEl.classList.toggle('has-chips', state.wallets.length > 0);
}

// ===========================
//   ADD / REMOVE WALLETS
// ===========================
function addWallet(address) {
    const norm = address.toLowerCase();
    if (state.wallets.find(w => w.address.toLowerCase() === norm)) {
        showToast('This wallet is already being tracked', 'error');
        return;
    }

    const wallet = {
        address,
        colorIdx: getNextColorIdx(),
        positions: [],
        freeUsdc: null,
        abortController: null,
    };
    state.wallets.push(wallet);
    saveWallets();
    renderWalletChips();

    dashboard.classList.remove('hidden');
    loadingOverlay.classList.add('hidden');

    if (getAllPositions().length === 0) showSkeleton(tableWrapper);

    loadWalletData(wallet);
    refreshAllActivity();
}

function removeWallet(address) {
    const idx = state.wallets.findIndex(w => w.address.toLowerCase() === address.toLowerCase());
    if (idx === -1) return;

    const wallet = state.wallets[idx];
    if (wallet.abortController) wallet.abortController.abort();
    state.wallets.splice(idx, 1);
    invalidatePositionsCache();

    saveWallets();
    renderWalletChips();

    if (state.wallets.length === 0) {
        stopLastUpdatedTicker();
        state.lastUpdated = null;
        dashboard.classList.add('hidden');
        tableWrapper.innerHTML = '';
        tradesList.innerHTML = '';
        totalValueEl.innerText = '$0.00';
        totalPortfolioEl.innerText = '$0.00';
        freeUsdcEl.innerHTML = '<span class="stat-loading-dots">···</span>';
        totalPnlEl.innerText = '$0.00';
        positionCountEl.innerText = '0';
    } else {
        updateTotalsAndRender();
        refreshAllActivity();
    }
}

// ===========================
//   TOTALS & RENDER
// ===========================
function updateTotalsAndRender() {
    const allPositions = getAllPositions();
    const { totV, totP, totChange24h, totChange1h } = calculateTotalVal(allPositions);

    allPositions.forEach(p => {
        p.weight = totV > 0 ? ((p.currentValue || 0) / totV) * 100 : 0;
    });

    dispatchRender();

    totalValueEl.innerText = formatCurrency(totV);
    totalPnlEl.className = `stat-value ${totP >= 0 ? 'positive' : 'negative'}`;
    totalPnlEl.innerText = formatCurrency(totP);

    const allFreeUsdc = state.wallets.reduce((s, w) => s + (w.freeUsdc || 0), 0);
    totalPortfolioEl.innerText = formatCurrency(totV + allFreeUsdc);

    total24hChangeEl.className = `stat-value ${totChange24h >= 0 ? 'positive' : 'negative'}`;
    total24hChangeEl.innerText = `${totChange24h > 0 ? '+' : ''}${formatCurrency(totChange24h)}`;

    total1hChangeEl.className = `stat-value ${totChange1h >= 0 ? 'positive' : 'negative'}`;
    total1hChangeEl.innerText = `${totChange1h > 0 ? '+' : ''}${formatCurrency(totChange1h)}`;

    positionCountEl.innerText = allPositions.length;
}

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

let lastUpdatedIntervalId = null;
function startLastUpdatedTicker() {
    if (lastUpdatedIntervalId) return; // already running
    lastUpdatedIntervalId = setInterval(() => {
        if (state.lastUpdated) {
            lastUpdatedEl.textContent = formatLastUpdated(state.lastUpdated);
        }
    }, 5000);
}
function stopLastUpdatedTicker() {
    if (lastUpdatedIntervalId) {
        clearInterval(lastUpdatedIntervalId);
        lastUpdatedIntervalId = null;
    }
}

function dispatchRender() {
    renderTable({
        tableWrapper,
        positionCountEl,
        isGrouped: groupToggle.checked,
        searchFilter: state.searchFilter,
        currentPositionsData: getAllPositions(),
        currentSortCol: state.sortCol,
        currentSortAsc: state.sortAsc,
        expandedCategories: state.expandedCategories,
        showWalletBadge: state.wallets.length > 1,
    });
}

// ===========================
//   LOAD WALLET DATA
// ===========================
async function loadWalletData(wallet, { bypassCache = false } = {}) {
    if (wallet.abortController) wallet.abortController.abort();
    wallet.abortController = new AbortController();
    const { signal } = wallet.abortController;

    const refreshBtn = document.getElementById('refresh-now-btn');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    try {
        const posRes = await fetchWithTimeout(
            `https://data-api.polymarket.com/positions?user=${wallet.address}`,
            FETCH_TIMEOUT_MS,
            signal
        );
        if (!posRes.ok) throw new Error('Failed to fetch positions');
        const allPositions = await posRes.json();

        if (signal.aborted) return;

        const positions = allPositions.filter(p => p.size > 0 && p.currentValue > 0);
        positions.sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));

        const color = WALLET_COLORS[wallet.colorIdx % WALLET_COLORS.length];

        invalidatePositionsCache();
        wallet.positions = positions.map(p => {
            const categoryObj = resolveCategory(p.conditionId, p.title || '', state.customCategories);
            const curPrice = (Number(p.currentValue) || 0) / (parseFloat(p.size) || 1);
            const entryPrice = parseFloat(p.avgPrice) || 0;
            const roi = entryPrice > 0 ? ((curPrice - entryPrice) / entryPrice) * 100 : 0;
            const marketUrl = p.eventSlug
                ? `https://polymarket.com/event/${p.eventSlug}`
                : (p.slug ? `https://polymarket.com/event/${p.slug}` : null);

            return {
                ...p,
                walletAddress: wallet.address,
                walletColor: color,
                pctChange24h: null, histPrice: null, histTime: null,
                pctChange1h: null, hist1hPrice: null, hist1hTime: null,
                curPrice, roi, category: categoryObj, marketUrl,
            };
        });

        updateTotalsAndRender();

        // Fetch free USDC in background
        getUSDCBalance(wallet.address, signal).then(balance => {
            if (signal.aborted) return;
            wallet.freeUsdc = balance;
            const allFreeUsdc = state.wallets.reduce((s, w) => s + (w.freeUsdc || 0), 0);
            const { totV } = calculateTotalVal(getAllPositions());
            freeUsdcEl.innerText = allFreeUsdc > 0 ? formatCurrency(allFreeUsdc) : (balance === null ? 'N/A' : '$0.00');
            totalPortfolioEl.innerText = formatCurrency(totV + allFreeUsdc);
        });

        // Load historical metrics in background
        Promise.all(wallet.positions.map(async p => {
            if (signal.aborted) return;

            const cacheKey = CACHE_PREFIX + p.asset;
            let histData = null;
            if (!bypassCache) {
                try {
                    const cached = localStorage.getItem(cacheKey);
                    if (cached) {
                        const parsed = JSON.parse(cached);
                        if (Date.now() - parsed._ts < CACHE_TTL_MS) histData = parsed;
                    }
                } catch (e) {}
            }

            if (!histData) {
                histData = await throttle(() => getHistoricalMetrics(p.asset, signal));
                if (histData) {
                    try { localStorage.setItem(cacheKey, JSON.stringify({ ...histData, _ts: Date.now() })); } catch (e) {}
                }
            }

            if (histData && !signal.aborted) {
                if (histData.latestPrice != null) {
                    p.curPrice = histData.latestPrice;
                    p.currentValue = p.curPrice * (parseFloat(p.size) || 0);
                    const entryPrice = parseFloat(p.avgPrice) || 0;
                    const cost = entryPrice * (parseFloat(p.size) || 0);
                    p.cashPnl = p.currentValue - cost;
                    p.roi = entryPrice > 0 ? ((p.curPrice - entryPrice) / entryPrice) * 100 : 0;
                }
                p.histPrice = histData.price24h;
                p.histTime = histData.time24h;
                p.hist1hPrice = histData.price1h;
                p.hist1hTime = histData.time1h;
                p.sparkline = histData.sparkline || null;
                p.pctChange24h = histData.pct24h ?? null;
                p.pctChange1h  = histData.pct1h  ?? null;
            }
        })).then(() => {
            if (!signal.aborted) {
                updateTotalsAndRender();
                state.lastUpdated = Date.now();
                if (lastUpdatedEl) lastUpdatedEl.textContent = formatLastUpdated(state.lastUpdated);
                startLastUpdatedTicker();
            }
        }).catch(console.error).finally(() => {
            if (refreshBtn) refreshBtn.classList.remove('spinning');
        });

    } catch (e) {
        if (e.name === 'AbortError') return;
        const short = wallet.address.slice(0, 8) + '…';
        showToast(`Error fetching ${short}. Check the address and try again.`, 'error');
        console.error(e);
        if (refreshBtn) refreshBtn.classList.remove('spinning');
    }
}

// ===========================
//   ACTIVITY (ALL WALLETS)
// ===========================
function refreshAllActivity() {
    if (activityAbortController) activityAbortController.abort();
    activityAbortController = new AbortController();

    const addresses = state.wallets.map(w => w.address);
    if (addresses.length === 0) return;

    tradesList.innerHTML = '';
    fetchActivity(addresses, tradesList, { grossSpentEl, grossCashInEl }, activityAbortController.signal);
}

// ===========================
//   REFRESH ALL WALLETS
// ===========================
function refreshAllWallets() {
    for (const wallet of state.wallets) {
        loadWalletData(wallet, { bypassCache: true });
    }
    refreshAllActivity();
}

// ===========================
//   INPUT HANDLERS
// ===========================
function handleAddWallet() {
    const val = walletInput.value.trim();
    if (!val) return;
    if (!isValidAddress(val)) {
        showToast('Invalid wallet address. Expected format: 0x… (42 characters)', 'error');
        return;
    }
    addWallet(val);
    walletInput.value = '';
}

addWalletBtn.addEventListener('click', handleAddWallet);
walletInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleAddWallet();
});

// Remove wallet via chip × button
document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove-wallet"]');
    if (btn) {
        removeWallet(btn.dataset.address);
    }
});

// ===========================
//   POSITION SEARCH FILTER
// ===========================
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

// ===========================
//   COLUMN SORTING
// ===========================
document.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;

    const col = th.dataset.sort;
    if (state.sortCol === col) {
        state.sortAsc = !state.sortAsc;
    } else {
        state.sortCol = col;
        state.sortAsc = col === 'market' || col === 'outcome';
    }
    localStorage.setItem(LS.SORT_COL, state.sortCol);
    localStorage.setItem(LS.SORT_ASC, String(state.sortAsc));

    // Update group sort only when all groups are collapsed
    if (groupToggle.checked) {
        const categoryRows = document.querySelectorAll('.category-row');
        const existingIds = [...categoryRows].map(r => r.dataset.categoryId);
        const allCollapsed = existingIds.length > 0 &&
            existingIds.every(id => state.expandedCategories[id] === false);
        if (allCollapsed) {
            setGroupSort(state.sortCol, state.sortAsc);
        }
    }
    dispatchRender();
});

// ===========================
//   AUTO-REFRESH TIMER
// ===========================
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
        if (state.wallets.length > 0) refreshAllWallets();
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
    refreshCountdown.textContent = m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`;
}

refreshSelect.value = localStorage.getItem(LS.REFRESH_INTERVAL) || '0';
refreshSelect.addEventListener('change', () => {
    const val = parseInt(refreshSelect.value);
    localStorage.setItem(LS.REFRESH_INTERVAL, String(val));
    startAutoRefresh(val);
});

const refreshNowBtn = document.getElementById('refresh-now-btn');
refreshNowBtn.addEventListener('click', () => {
    if (state.wallets.length === 0) return;
    const interval = parseInt(refreshSelect.value);
    if (interval > 0) {
        countdownSec = interval;
        startAutoRefresh(interval);
    }
    refreshAllWallets();
});

// ===========================
//   GROUP TOGGLE
// ===========================
groupToggle.checked = localStorage.getItem(LS.GROUPED) === 'true';

groupToggle.addEventListener('change', () => {
    localStorage.setItem(LS.GROUPED, groupToggle.checked);
    dispatchRender();
});

// ===========================
//   LONG-PRESS FOR MOBILE CATEGORY EDIT
// ===========================
let longPressTimer = null;
tableWrapper.addEventListener('touchstart', (e) => {
    const marketCell = e.target.closest('.market-cell');
    if (!marketCell) return;
    const editBtn = marketCell.querySelector('[data-action="edit-category"]');
    if (!editBtn) return;
    longPressTimer = setTimeout(() => {
        longPressTimer = null;
        const conditionId = decodeURIComponent(editBtn.dataset.condition || '');
        const title = editBtn.dataset.title || '';
        const currentCat = editBtn.dataset.cat || '';
        openCategoryModal(conditionId, title, currentCat);
    }, 500);
}, { passive: true });
tableWrapper.addEventListener('touchend', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}, { passive: true });
tableWrapper.addEventListener('touchmove', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}, { passive: true });

// ===========================
//   TABLE ACTION DELEGATION
// ===========================
document.addEventListener('click', (e) => {
    const categoryRow = e.target.closest('[data-action="toggle-category"]');
    if (categoryRow) {
        if (e.target.closest('[data-action="bulk-rename"]')) return;
        const catId = categoryRow.dataset.categoryId;
        const isExpanded = state.expandedCategories[catId] !== false;
        state.expandedCategories[catId] = !isExpanded;
        localStorage.setItem(LS.EXPANDED, JSON.stringify(state.expandedCategories));

        // If all collapsed now, restore sort indicator to group sort
        const categoryRows = document.querySelectorAll('.category-row');
        const existingIds = [...categoryRows].map(r => r.dataset.categoryId);
        const allCollapsed = existingIds.length > 0 &&
            existingIds.every(id => state.expandedCategories[id] === false);
        if (allCollapsed) {
            const gs = getGroupSort();
            state.sortCol = gs.col;
            state.sortAsc = gs.asc;
            localStorage.setItem(LS.SORT_COL, state.sortCol);
            localStorage.setItem(LS.SORT_ASC, String(state.sortAsc));
        }
        dispatchRender();
        return;
    }

    const editBtn = e.target.closest('[data-action="edit-category"]');
    if (editBtn) {
        const conditionId = decodeURIComponent(editBtn.dataset.condition || '');
        const title = editBtn.dataset.title || '';
        const currentCat = editBtn.dataset.cat || '';
        openCategoryModal(conditionId, title, currentCat);
        return;
    }

    const renameBtn = e.target.closest('[data-action="bulk-rename"]');
    if (renameBtn) {
        e.stopPropagation();
        const oldLabel = renameBtn.dataset.oldLabel || '';
        openBulkRenameModal(oldLabel);
        return;
    }

    const tagBtn = e.target.closest('[data-action="select-tag"]');
    if (tagBtn) {
        categoryInput.value = tagBtn.dataset.label || '';
        updateCategoryTagHighlights();
        return;
    }
});

// ===========================
//   CATEGORY MODAL
// ===========================
function openCategoryModal(conditionId, title, currentCat) {
    state.activeEditConditionId = conditionId;
    state.activeBulkOldLabel = null;
    modalMarketTitle.innerText = title;
    const initialVal = currentCat !== 'Other' ? currentCat : '';
    categoryInput.value = initialVal;
    categoryModal.classList.remove('hidden');
    categoryModal.setAttribute('role', 'dialog');
    categoryModal.setAttribute('aria-modal', 'true');

    setTimeout(() => { categoryInput.focus(); categoryInput.select(); }, 50);
    buildCategoryTagsCloud(initialVal);
}

function openBulkRenameModal(oldLabel) {
    state.activeBulkOldLabel = oldLabel;
    state.activeEditConditionId = null;
    modalMarketTitle.innerText = `Renaming all positions in "${oldLabel}"`;
    categoryInput.value = oldLabel;
    categoryModal.classList.remove('hidden');
    categoryModal.setAttribute('role', 'dialog');
    categoryModal.setAttribute('aria-modal', 'true');

    setTimeout(() => { categoryInput.focus(); categoryInput.select(); }, 50);
    buildCategoryTagsCloud(oldLabel);
}

function buildCategoryTagsCloud(initialVal) {
    if (!categoryTagsCloud) return;

    const usedLabels = new Set();
    getAllPositions().forEach(p => {
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
    const allPositions = getAllPositions();

    if (state.activeBulkOldLabel) {
        allPositions.forEach(p => {
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

    for (const w of state.wallets) {
        for (const p of w.positions) {
            p.category = resolveCategory(p.conditionId, p.title, state.customCategories);
        }
    }

    dispatchRender();
});

categoryModal.addEventListener('click', (e) => {
    if (e.target === categoryModal) closeCategoryModal();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !categoryModal.classList.contains('hidden')) {
        closeCategoryModal();
    }
});

categoryInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') saveCategoryBtn.click();
});

categoryModal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = categoryModal.querySelectorAll('input, button:not([disabled])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
    }
});

// ===========================
//   AUTO-RUN ON LOAD
// ===========================
window.onload = () => {
    cleanupOldCache();

    // Migrate old single-wallet storage
    let savedWallets = null;
    try {
        savedWallets = JSON.parse(localStorage.getItem(LS.WALLETS));
    } catch (e) {}

    if (!savedWallets) {
        const old = localStorage.getItem(LS.WALLET_OLD);
        if (old && isValidAddress(old)) {
            savedWallets = [old];
            localStorage.setItem(LS.WALLETS, JSON.stringify(savedWallets));
        }
    }

    if (Array.isArray(savedWallets) && savedWallets.length > 0) {
        // Re-hydrate wallets without triggering fetches individually yet
        savedWallets.forEach(addr => {
            if (!isValidAddress(addr)) return;
            state.wallets.push({
                address: addr,
                colorIdx: getNextColorIdx(),
                positions: [],
                freeUsdc: null,
                abortController: null,
            });
        });
        renderWalletChips();

        dashboard.classList.remove('hidden');
        showSkeleton(tableWrapper);

        state.wallets.forEach(w => loadWalletData(w));
        refreshAllActivity();
    }

    const savedInterval = parseInt(localStorage.getItem(LS.REFRESH_INTERVAL) || '0');
    if (savedInterval > 0) startAutoRefresh(savedInterval);
};
