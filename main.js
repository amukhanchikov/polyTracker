import { showToast, formatCurrency, formatTime } from './utils.js';
import { getHistoricalMetrics, throttle } from './api.js';
import { loadCustomCategories, saveCustomCategories, resolveCategory } from './categoryManager.js';
import { showSkeleton, calculateTotalVal, renderTable } from './ui.js';

// DOM Elements
const searchInput = document.getElementById('wallet-input');
const searchBtn = document.getElementById('search-btn');
const loadingOverlay = document.getElementById('loading');
const dashboard = document.getElementById('dashboard');

// Stats Elements
const totalValueEl = document.getElementById('total-value');
const totalPnlEl = document.getElementById('total-pnl');
const positionCountEl = document.getElementById('position-count');
const grossSpentEl = document.getElementById('gross-spent');
const grossReceivedEl = document.getElementById('gross-received');
const grossRedeemedEl = document.getElementById('gross-redeemed');
const netLiquidityEl = document.getElementById('net-liquidity');

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

// State
let customCategories = loadCustomCategories();
let activeEditConditionId = null;
let activeBulkOldLabel = null; 

let currentPositionsData = [];
let currentSortCol = localStorage.getItem('polytracker_sortCol') || 'value';
let currentSortAsc = localStorage.getItem('polytracker_sortAsc') === 'true';
let expandedCategories = JSON.parse(localStorage.getItem('polytracker_expanded') || '{}');
let searchFilter = '';

// Helper to trigger UI render with full state
function dispatchRender() {
    renderTable({
        tableWrapper,
        positionCountEl,
        isGrouped: groupToggle.checked,
        searchFilter,
        currentPositionsData,
        currentSortCol,
        currentSortAsc,
        expandedCategories
    });
}

// Fetch and Render Data
async function analyzeWallet(address) {
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
        const fetchActivity = async () => {
            try {
                const actRes = await fetch(`https://data-api.polymarket.com/activity?user=${address}&limit=200`);
                if (!actRes.ok) return null;
                const activities = await actRes.json();
                const cutoff = (Date.now() / 1000) - (24 * 3600);
                const recent = activities.filter(a => a.timestamp >= cutoff);
                
                const trades = recent.filter(a => a.type === 'TRADE');
                const redeems = recent.filter(a => a.type === 'REDEEM');

                let localGrossSpent = 0;
                let localGrossReceived = 0;
                let localGrossRedeemed = 0;

                trades.forEach(t => {
                    if (t.side === 'BUY') localGrossSpent += (t.usdcSize || 0);
                    if (t.side === 'SELL') localGrossReceived += (t.usdcSize || 0);
                });

                redeems.forEach(r => {
                    localGrossRedeemed += (r.usdcValue || r.usdcSize || 0);
                });

                const netLiquidity = (localGrossReceived + localGrossRedeemed) - localGrossSpent;

                // UI Updates
                grossSpentEl.innerText = `-${formatCurrency(localGrossSpent)}`;
                grossReceivedEl.innerText = `+${formatCurrency(localGrossReceived)}`;
                grossRedeemedEl.innerText = `+${formatCurrency(localGrossRedeemed)}`;
                
                const netFlowEl = document.getElementById('net-flow');
                
                document.getElementById('net-liquidity').className = `value ${netLiquidity >= 0 ? 'positive' : 'negative'}`;
                document.getElementById('net-liquidity').innerText = `${netLiquidity > 0 ? '+' : ''}${formatCurrency(netLiquidity)}`;
                
                netFlowEl.className = `stat-value ${netLiquidity >= 0 ? 'positive' : 'negative'}`;
                netFlowEl.innerText = `${netLiquidity > 0 ? '+' : ''}${formatCurrency(netLiquidity)}`;

                // Render Recent Trades Fragment
                const tFrag = document.createDocumentFragment();
                tradesList.innerHTML = ''; // Clear skeleton if any
                trades.slice(0, 10).forEach(t => {
                    const li = document.createElement('li');
                    li.className = 'trade-item';
                    const isBuy = t.side === 'BUY';
                    const tradePrice = t.price ? (parseFloat(t.price) * 100).toFixed(1) + '¢' : '';
                    
                    li.innerHTML = `
                        <div class="trade-icon ${isBuy ? 'buy' : 'sell'}">
                            <i data-lucide="${isBuy ? 'arrow-down-left' : 'arrow-up-right'}"></i>
                        </div>
                        <div class="trade-details">
                            <div class="top">
                                <span>${isBuy ? 'Bought' : 'Sold'}</span>
                                <span class="outcome-badge ${t.outcome ? t.outcome.toLowerCase() : ''}">${t.outcome} ${tradePrice}</span>
                                <span>for</span>
                                <strong>${formatCurrency(t.usdcSize)}</strong>
                                <span class="trade-time">${formatTime(t.timestamp)}</span>
                            </div>
                            <div class="market">${t.title}</div>
                        </div>
                    `;
                    tFrag.appendChild(li);
                });
                tradesList.appendChild(tFrag);
                if (window.lucide) window.lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide', nodes: [tradesList] });
            } catch(e) {
                console.error('Activity fetch failed', e);
            }
        };

        const activityPromise = fetchActivity();

        // Fetch Positions
        const posRes = await fetch(`https://data-api.polymarket.com/positions?user=${address}`);
        if (!posRes.ok) throw new Error("Failed to fetch positions");
        const allPositions = await posRes.json();
        
        // Filter Open Positions
        const positions = allPositions.filter(p => p.size > 0 && p.currentValue > 0);
        positions.sort((a,b) => (b.currentValue || 0) - (a.currentValue || 0));
        
        positionCountEl.innerText = positions.length;

        // Process basic position data instantly
        let positionRowsData = positions.map(p => {
            const categoryObj = resolveCategory(p.conditionId, p.title || '', customCategories);
            const curPrice = (p.currentValue || 0) / parseFloat(p.size || 1);
            const entryPrice = parseFloat(p.avgPrice || 0);
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
        
        currentPositionsData = positionRowsData;
        const updateTotalsAndRender = () => {
            const { totV, totP, totChange24h } = calculateTotalVal(currentPositionsData);
            currentPositionsData.forEach(p => {
                p.weight = totV > 0 ? ((p.currentValue || 0) / totV) * 100 : 0;
            });

            dispatchRender();

            totalValueEl.innerText = formatCurrency(totV);
            totalPnlEl.className = `stat-value ${totP >= 0 ? 'positive' : 'negative'}`;
            totalPnlEl.innerText = formatCurrency(totP);
            
            const total24hChangeEl = document.getElementById('total-24h-change');
            total24hChangeEl.className = `stat-value ${totChange24h >= 0 ? 'positive' : 'negative'}`;
            total24hChangeEl.innerText = `${totChange24h > 0 ? '+' : ''}${formatCurrency(totChange24h)}`;
        };

        // Render immediately with current values
        updateTotalsAndRender();

        let renderTimeout = null;

        // Background load historical metrics
        Promise.all(currentPositionsData.map(async p => {
            const cacheKey = 'polytracker_ph_' + p.asset;
            let histData = null;
            try {
                const cached = localStorage.getItem(cacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    if (Date.now() - parsed._ts < 300000) histData = parsed;
                }
            } catch(e) {}
            
            if (!histData) {
                histData = await throttle(() => getHistoricalMetrics(p.asset));
                if (histData) {
                    try { localStorage.setItem(cacheKey, JSON.stringify({ ...histData, _ts: Date.now() })); } catch(e) {}
                }
            }
            
            if (histData) {
                p.histPrice = histData.price24h;
                p.histTime = histData.time24h;
                p.hist1hPrice = histData.price1h;
                p.hist1hTime = histData.time1h;

                if (histData.price24h > 0) {
                    p.pctChange24h = ((p.curPrice - histData.price24h) / histData.price24h) * 100;
                }
                if (histData.price1h > 0) {
                    p.pctChange1h = ((p.curPrice - histData.price1h) / histData.price1h) * 100;
                }
                
                // Re-render minimally, debounced to avoid layout thrashing
                if (renderTimeout) clearTimeout(renderTimeout);
                renderTimeout = setTimeout(updateTotalsAndRender, 150);
            }
        })).catch(console.error).finally(() => {
            if (refreshBtn) refreshBtn.classList.remove('spinning');
        });

        await activityPromise;

    } catch (e) {
        showToast('Error fetching data. Ensure the wallet address is correct.', 'error');
        console.error(e);
    } finally {
        loadingOverlay.classList.add('hidden');
        localStorage.setItem('polytracker_wallet', address);
    }
}

// Event Listeners
searchBtn.addEventListener('click', () => {
    const val = searchInput.value.trim();
    if(val) analyzeWallet(val);
});

const positionSearchInput = document.getElementById('position-search');
const clearSearchBtn = document.getElementById('clear-search');
let searchDebounce = null;

positionSearchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
        searchFilter = positionSearchInput.value.trim();
        clearSearchBtn.classList.toggle('visible', searchFilter.length > 0);
        dispatchRender();
    }, 200);
});

clearSearchBtn.addEventListener('click', () => {
    positionSearchInput.value = '';
    searchFilter = '';
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

searchInput.addEventListener('keypress', (e) => {
    if(e.key === 'Enter') {
        const val = searchInput.value.trim();
        if(val) analyzeWallet(val);
    }
});

document.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;

    const col = th.dataset.sort;
    if (currentSortCol === col) {
        currentSortAsc = !currentSortAsc;
    } else {
        currentSortCol = col;
        currentSortAsc = col === 'market' || col === 'outcome'; // Default asc for strings
    }
    localStorage.setItem('polytracker_sortCol', currentSortCol);
    localStorage.setItem('polytracker_sortAsc', String(currentSortAsc));
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

// Init state from local storage (with safety)
groupToggle.checked = localStorage.getItem('polytracker_grouped') === 'true';

window.toggleCategory = function(catId) {
    const isExpanded = expandedCategories[catId] !== false;
    expandedCategories[catId] = !isExpanded;
    localStorage.setItem('polytracker_expanded', JSON.stringify(expandedCategories));
    dispatchRender();
};

groupToggle.addEventListener('change', () => {
    localStorage.setItem('polytracker_grouped', groupToggle.checked);
    currentSortCol = 'value';
    currentSortAsc = false;
    dispatchRender();
});

// Category Overrides
window.openCategoryModal = function(conditionId, title, currentCat) {
    activeEditConditionId = conditionId;
    modalMarketTitle.innerText = title;
    const initialVal = currentCat !== 'Other' ? currentCat : '';
    categoryInput.value = initialVal;
    categoryModal.classList.remove('hidden');
    
    setTimeout(() => {
        categoryInput.focus();
        categoryInput.select();
    }, 50);
    
    if (categoryTagsCloud) {
        const usedLabels = new Set();
        currentPositionsData.forEach(p => {
            if (p.category && p.category.label && p.category.label !== 'Other') {
                usedLabels.add(p.category.label);
            }
        });
        
        const sortedLabels = Array.from(usedLabels).sort();
        
        if (sortedLabels.length === 0) {
            categoryTagsCloud.innerHTML = '<div style="font-size:0.8rem; color:var(--text-muted); padding:0.5rem">No categories in use. Type to create one.</div>';
        } else {
            categoryTagsCloud.innerHTML = sortedLabels.map(l => {
                const isActive = l.toLowerCase() === initialVal.toLowerCase();
                return `<button class="category-tag ${isActive ? 'active' : ''}" onclick="window.selectCategoryTag('${l.replace(/'/g, "\\'")}')">${l}</button>`;
            }).join('');
        }
    }
};

window.openBulkRenameModal = function(e, oldLabel) {
    e.stopPropagation();
    activeBulkOldLabel = oldLabel;
    activeEditConditionId = null;
    modalMarketTitle.innerText = `Renaming all positions in "${oldLabel}"`;
    categoryInput.value = oldLabel;
    categoryModal.classList.remove('hidden');
    
    setTimeout(() => {
        categoryInput.focus();
        categoryInput.select();
    }, 50);
    
    window.openCategoryModal(null, modalMarketTitle.innerText, oldLabel);
};

window.selectCategoryTag = function(label) {
    categoryInput.value = label;
    updateCategoryTagHighlights();
};

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
    categoryInput.value = '';
    activeEditConditionId = null;
}

cancelCategoryBtn.addEventListener('click', closeCategoryModal);

saveCategoryBtn.addEventListener('click', () => {
    const newCat = categoryInput.value.trim();
    
    if (activeBulkOldLabel) {
        currentPositionsData.forEach(p => {
            if (p.category && p.category.label === activeBulkOldLabel) {
                if (newCat) customCategories[p.conditionId] = newCat;
                else delete customCategories[p.conditionId];
            }
        });
        activeBulkOldLabel = null;
    } else if (activeEditConditionId) {
        if (newCat) customCategories[activeEditConditionId] = newCat;
        else delete customCategories[activeEditConditionId];
    } else {
        closeCategoryModal();
        return;
    }
    
    saveCustomCategories(customCategories);
    closeCategoryModal();
    
    for (let p of currentPositionsData) {
        p.category = resolveCategory(p.conditionId, p.title, customCategories);
    }

    setTimeout(() => {
        dispatchRender();
    }, 10);
});

categoryModal.addEventListener('click', (e) => {
    if (e.target === categoryModal) closeCategoryModal();
});
categoryInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') saveCategoryBtn.click();
});

// Auto-run on load
window.onload = () => {
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
