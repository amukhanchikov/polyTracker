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

// Bulk Category Variables
let customCategories = {};
try { customCategories = JSON.parse(localStorage.getItem('polytracker_categories') || '{}'); } catch(e) { console.warn('Corrupted categories in localStorage, resetting'); }
let activeEditConditionId = null;
let activeBulkOldLabel = null; // Track old label for bulk rename

let currentPositionsData = [];
let currentSortCol = localStorage.getItem('polytracker_sortCol') || 'value';
let currentSortAsc = localStorage.getItem('polytracker_sortAsc') === 'true';
let expandedCategories = JSON.parse(localStorage.getItem('polytracker_expanded') || '{}');
let searchFilter = '';
// Icon mapping for known category labels
const ICON_MAP = {
    'trump': 'user',
    'iran': 'globe',
    'israel': 'globe',
    'middle east': 'globe',
    'politics': 'landmark',
    'oscars': 'award',
    'movies': 'award',
    'oscars / movies': 'award',
    'oil': 'droplet',
    'crypto': 'bitcoin',
    'bitcoin': 'bitcoin',
    'ai': 'cpu',
    'sports': 'trophy',
    'economy': 'trending-up',
    'geopolitics': 'globe'
};

// Toast notification (replaces alert)
function showToast(msg, type = 'error') {
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast-notification toast-' + type;
    toast.innerHTML = `<span>${msg}</span><button onclick="this.parentElement.remove()">×</button>`;
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentElement) toast.remove(); }, 5000);
}

// Formatters
const formatCurrency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
const formatPct = (val) => (val > 0 ? '+' : '') + val.toFixed(2) + '%';
const formatTime = (ts) => {
    if(!ts) return '';
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('en-US', {hour: '2-digit', minute:'2-digit', month: 'short', day: 'numeric'});
};

// Throttled fetch: limits concurrent requests to avoid 429 rate limits
function createThrottledFetcher(concurrency = 5) {
    let active = 0;
    const queue = [];
    
    function next() {
        if (queue.length === 0 || active >= concurrency) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        fn().then(resolve, reject).finally(() => { active--; next(); });
    }
    
    return function throttledFetch(fn) {
        return new Promise((resolve, reject) => {
            queue.push({ fn, resolve, reject });
            next();
        });
    };
}

const throttle = createThrottledFetcher(15);

// Fetch Historical Metrics from CLOB (with retry on 429)
async function getHistoricalMetrics(assetId) {
    const doFetch = async (attempt = 0) => {
        try {
            const res = await fetch(`https://clob.polymarket.com/prices-history?market=${assetId}&interval=1d`);
            if (res.status === 429 && attempt < 3) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                return doFetch(attempt + 1);
            }
            if (!res.ok) return null;
        
        const data = await res.json();
        const history = data.history;
        
        if (history && history.length > 0) {
            const cutoff24h = (Date.now() / 1000) - (24 * 3600);
            const cutoff1h = (Date.now() / 1000) - 3600;
            const latestPrice = history[history.length - 1].p;
            
            let histPrice24h = history[0].p;
            let histTime24h = history[0].t;
            let histPrice1h = history[0].p;
            let histTime1h = history[0].t;

            for (let entry of history) {
                if (entry.t >= cutoff24h) {
                    histPrice24h = entry.p;
                    histTime24h = entry.t;
                    break;
                }
            }
            for (let entry of history) {
                if (entry.t >= cutoff1h) {
                    histPrice1h = entry.p;
                    histTime1h = entry.t;
                    break;
                }
            }
            
            return {
                pct24h: histPrice24h > 0 ? ((latestPrice - histPrice24h) / histPrice24h) * 100 : null,
                price24h: histPrice24h,
                time24h: histTime24h,
                pct1h: histPrice1h > 0 ? ((latestPrice - histPrice1h) / histPrice1h) * 100 : null,
                price1h: histPrice1h,
                time1h: histTime1h
            };
        }
    } catch(e) {
        console.warn('Failed to fetch price history for', assetId);
    }
    return null;
    }; // end doFetch
    return doFetch();
}

// Category resolution: custom overrides → title-based matching
function resolveCategory(conditionId, title) {
    let label = 'Other';
    
    if (customCategories[conditionId]) {
        label = customCategories[conditionId];
    } else {
        const tLower = (title || '').toLowerCase();
        
        // Highly specific tags replicating Polymarket's Collections toolbar
        if (tLower.includes('trump')) label = 'Trump';
        else if (tLower.includes('iran')) label = 'Iran';
        else if (tLower.includes('israel') || tLower.includes('hezbollah') || tLower.includes('lebanon') || tLower.includes('gaza')) label = 'Middle East';
        else if (tLower.includes('russia') || tLower.includes('ukraine') || tLower.includes('zelenskyy') || tLower.includes('putin') || tLower.includes('biden') || tLower.includes('president') || tLower.includes('harris')) label = 'Politics';
        else if (tLower.includes('oscar') || tLower.includes('actor') || tLower.includes('actress') || tLower.includes('movie') || tLower.includes('film') || tLower.includes('winner')) label = 'Oscars / Movies';
        else if (tLower.includes('oil') || tLower.includes('gas') || tLower.includes('crude')) label = 'Oil';
        else if (tLower.includes('btc') || tLower.includes('bitcoin') || tLower.includes('crypto') || tLower.includes('eth') || tLower.includes('solana')) label = 'Crypto';
        else if (tLower.includes('ai') || tLower.includes('deepseek') || tLower.includes('openai') || tLower.includes('sam altman')) label = 'AI';
        else if (tLower.includes('super bowl') || tLower.includes('nfl') || tLower.includes('nba') || tLower.includes('champions league') || tLower.includes('madrid')) label = 'Sports';
        else if (tLower.includes('fed') || tLower.includes('inflation') || tLower.includes('cpi') || tLower.includes('rate cut') || tLower.includes('microstrategy')) label = 'Economy';
        else if (tLower.includes('ceasefire') || tLower.includes('military') || tLower.includes('conflict') || tLower.includes('war') || tLower.includes('regime') || tLower.includes('netanyahu') || tLower.includes('minister') || tLower.includes('election') || tLower.includes('pahlavi')) label = 'Geopolitics';
    }

    const id = label.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const icon = ICON_MAP[label.toLowerCase()] || ICON_MAP[id] || 'tag';

    return { id, label, icon };
}

// Show skeleton loading placeholder
function showSkeleton() {
    // Preserve height to prevent scroll jumping
    const currentHeight = tableWrapper.offsetHeight;
    if (currentHeight > 100) tableWrapper.style.minHeight = currentHeight + 'px';
    
    const cols = 6;
    let html = `<table class="positions-table"><thead><tr>
        <th>Market</th><th>Cur. Price</th><th>Weight (%)</th><th>1h % Δ</th><th>24h % Δ</th><th>Value (USDC)</th>
    </tr></thead><tbody>`;
    for (let i = 0; i < 8; i++) {
        html += `<tr class="skeleton-row">
            <td><div style="display:flex;align-items:center;gap:1rem"><div class="skeleton-bar" style="width:40px;height:40px;border-radius:8px"></div><div><div class="skeleton-bar w-wide" style="margin-bottom:6px"></div><div class="skeleton-bar w-mid"></div></div></div></td>
            <td><div class="skeleton-bar w-sm"></div></td>
            <td><div class="skeleton-bar w-sm"></div></td>
            <td><div class="skeleton-bar w-sm"></div></td>
            <td><div class="skeleton-bar w-sm"></div></td>
            <td><div class="skeleton-bar w-mid"></div></td>
        </tr>`;
    }
    html += '</tbody></table>';
    tableWrapper.innerHTML = html;
}

// Fetch and Render Data
async function analyzeWallet(address) {
    // UI State — show skeleton immediately, no spinner overlay
    dashboard.classList.remove('hidden');
    loadingOverlay.classList.add('hidden');
    showSkeleton();
    tradesList.innerHTML = '';

    try {
        // 2. Fetch Activity (Parallelized)
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
                lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide', nodes: [tradesList] });
            } catch(e) {
                console.error('Activity fetch failed', e);
            }
        };

        // Start both fetches in parallel
        const activityPromise = fetchActivity();

        // 1. Fetch Positions
        const posRes = await fetch(`https://data-api.polymarket.com/positions?user=${address}`);
        if (!posRes.ok) throw new Error("Failed to fetch positions");
        const allPositions = await posRes.json();
        
        // Filter Open Positions (size > 0 — include all non-dust positions)
        const positions = allPositions.filter(p => p.size > 0 && p.currentValue > 0);
        positions.sort((a,b) => (b.currentValue || 0) - (a.currentValue || 0));
        
        positionCountEl.innerText = positions.length;

        let totalVal = 0;
        let totalPnl = 0;

        // Fetch price histories concurrently (main bottleneck — uses sessionStorage cache)
        let positionRowsData = await Promise.all(positions.map(async p => {
            // Check sessionStorage cache for price history
            const cacheKey = 'ph_' + p.asset;
            let histData = null;
            try {
                const cached = sessionStorage.getItem(cacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    // Cache valid for 5 minutes
                    if (Date.now() - parsed._ts < 300000) histData = parsed;
                }
            } catch(e) {}
            
            if (!histData) {
                histData = await throttle(() => getHistoricalMetrics(p.asset));
                if (histData) {
                    try { sessionStorage.setItem(cacheKey, JSON.stringify({ ...histData, _ts: Date.now() })); } catch(e) {}
                }
            }
            
            // Category from title (instant, no API call)
            const categoryObj = resolveCategory(p.conditionId, p.title || '');
            const curPrice = (p.currentValue || 0) / parseFloat(p.size || 1);
            const entryPrice = parseFloat(p.avgPrice || 0);
            const roi = entryPrice > 0 ? ((curPrice - entryPrice) / entryPrice) * 100 : 0;

            // Build Polymarket URL from position data
            const marketUrl = p.eventSlug 
                ? `https://polymarket.com/event/${p.eventSlug}` 
                : (p.slug ? `https://polymarket.com/event/${p.slug}` : null);

            return { 
                ...p, 
                pctChange24h: histData ? histData.pct24h : null,
                histPrice: histData ? histData.price24h : null,
                histTime: histData ? histData.time24h : null,
                pctChange1h: histData ? histData.pct1h : null,
                hist1hPrice: histData ? histData.price1h : null,
                hist1hTime: histData ? histData.time1h : null,
                curPrice: curPrice,
                roi: roi,
                category: categoryObj,
                marketUrl: marketUrl
            };
        }));
        
        // Calculate Totals First to get weights
        currentPositionsData = positionRowsData;
        const { totV, totP, totChange24h } = calculateTotalVal();

        // Assign weights
        currentPositionsData.forEach(p => {
            p.weight = totV > 0 ? ((p.currentValue || 0) / totV) * 100 : 0;
        });

        renderTable();

        totalValueEl.innerText = formatCurrency(totV);
        totalPnlEl.className = `stat-value ${totP >= 0 ? 'positive' : 'negative'}`;
        totalPnlEl.innerText = formatCurrency(totP);
        
        const total24hChangeEl = document.getElementById('total-24h-change');
        total24hChangeEl.className = `stat-value ${totChange24h >= 0 ? 'positive' : 'negative'}`;
        total24hChangeEl.innerText = `${totChange24h > 0 ? '+' : ''}${formatCurrency(totChange24h)}`;


        // Wait for activity to finish if needed for final state (though UI updates progressively)
        await activityPromise;

    } catch (e) {
        showToast('Error fetching data. Ensure the wallet address is correct.', 'error');
        console.error(e);
    } finally {
        loadingOverlay.classList.add('hidden');
        // Save successfully analyzed wallet
        localStorage.setItem('polytracker_wallet', address);
    }
}

// Event Listeners
searchBtn.addEventListener('click', () => {
    const val = searchInput.value.trim();
    if(val) analyzeWallet(val);
});

// Position filter/search
const positionSearchInput = document.getElementById('position-search');
const clearSearchBtn = document.getElementById('clear-search');
let searchDebounce = null;

function updateSearchFilter() {
    searchFilter = positionSearchInput.value.trim();
    clearSearchBtn.classList.toggle('visible', searchFilter.length > 0);
    renderTable();
}

positionSearchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(updateSearchFilter, 200);
});

clearSearchBtn.addEventListener('click', () => {
    positionSearchInput.value = '';
    searchFilter = '';
    clearSearchBtn.classList.remove('visible');
    renderTable();
});

// Keyboard shortcut: / or Ctrl+K to focus search
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
    renderTable();
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
        countdownSec = intervalSec; // reset countdown
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
    // Spin animation
    refreshNowBtn.classList.add('spinning');
    setTimeout(() => refreshNowBtn.classList.remove('spinning'), 600);
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
// expandedCategories already declared globally above

window.toggleCategory = function(catId) {
    const isExpanded = expandedCategories[catId] !== false;
    expandedCategories[catId] = !isExpanded;
    localStorage.setItem('polytracker_expanded', JSON.stringify(expandedCategories));
    renderTable();
};

groupToggle.addEventListener('change', () => {
    localStorage.setItem('polytracker_grouped', groupToggle.checked);
    currentSortCol = 'value';
    currentSortAsc = false;
    renderTable();
});

// Category Overrides
window.openCategoryModal = function(conditionId, title, currentCat) {
    activeEditConditionId = conditionId;
    modalMarketTitle.innerText = title;
    const initialVal = currentCat !== 'Other' ? currentCat : '';
    categoryInput.value = initialVal;
    categoryModal.classList.remove('hidden');
    
    // Auto-select text on open
    setTimeout(() => {
        categoryInput.focus();
        categoryInput.select();
    }, 50);
    
    const cloud = document.getElementById('category-tags-cloud');
    
    if (cloud) {
        const usedLabels = new Set();
        currentPositionsData.forEach(p => {
            if (p.category && p.category.label && p.category.label !== 'Other') {
                usedLabels.add(p.category.label);
            }
        });
        
        const sortedLabels = Array.from(usedLabels).sort();
        
        if (sortedLabels.length === 0) {
            cloud.innerHTML = '<div style="font-size:0.8rem; color:var(--text-muted); padding:0.5rem">No categories in use. Type to create one.</div>';
        } else {
            cloud.innerHTML = sortedLabels.map(l => {
                const isActive = l.toLowerCase() === initialVal.toLowerCase();
                return `<button class="category-tag ${isActive ? 'active' : ''}" onclick="selectCategoryTag('${l.replace(/'/g, "\\'")}')">${l}</button>`;
            }).join('');
        }
    }
};

window.openBulkRenameModal = function(e, oldLabel) {
    e.stopPropagation(); // Don't toggle expansion
    activeBulkOldLabel = oldLabel;
    activeEditConditionId = null;
    modalMarketTitle.innerText = `Renaming all positions in "${oldLabel}"`;
    categoryInput.value = oldLabel;
    categoryModal.classList.remove('hidden');
    
    setTimeout(() => {
        categoryInput.focus();
        categoryInput.select();
    }, 50);
    
    openCategoryModal(null, modalMarketTitle.innerText, oldLabel);
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
        // Bulk Rename logic
        currentPositionsData.forEach(p => {
            if (p.category && p.category.label === activeBulkOldLabel) {
                if (newCat) {
                    customCategories[p.conditionId] = newCat;
                } else {
                    delete customCategories[p.conditionId];
                }
            }
        });
        activeBulkOldLabel = null;
    } else if (activeEditConditionId) {
        // Single position logic
        const conditionIdToUpdate = activeEditConditionId;
        if (newCat) {
            customCategories[conditionIdToUpdate] = newCat;
        } else {
            delete customCategories[conditionIdToUpdate];
        }
    } else {
        closeCategoryModal();
        return;
    }
    
    localStorage.setItem('polytracker_categories', JSON.stringify(customCategories));
    closeCategoryModal();
    
    // Re-analyze categories
    for (let p of currentPositionsData) {
        p.category = resolveCategory(p.conditionId, p.title);
    }

    // Wrap in setTimeout to decouple from modal closing cycle and prevent "drifting" feel
    setTimeout(() => {
        renderTable();
    }, 10);
});

categoryModal.addEventListener('click', (e) => {
    if (e.target === categoryModal) closeCategoryModal();
});
categoryInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') saveCategoryBtn.click();
});

function calculateTotalVal() {
    let totV = 0; let totP = 0; let totChange24h = 0;
    currentPositionsData.forEach(p => {
        totV += p.currentValue || 0;
        totP += p.cashPnl || 0;
        if (p.histPrice !== null) {
            totChange24h += (p.curPrice - p.histPrice) * p.size;
        }
    });
    return { totV, totP, totChange24h };
}

function renderTable() {
    // Preserve height to prevent scroll jumping
    const currentHeight = tableWrapper.offsetHeight;
    if (currentHeight > 100) tableWrapper.style.minHeight = currentHeight + 'px';
    
    tableWrapper.innerHTML = '';

    const isGrouped = groupToggle.checked;
    
    // Apply search filter
    const filterLower = searchFilter.toLowerCase();
    const filtered = filterLower 
        ? currentPositionsData.filter(p => (p.title || '').toLowerCase().includes(filterLower))
        : currentPositionsData;
    
    // Update position count: show filtered / total
    if (filterLower && filtered.length !== currentPositionsData.length) {
        positionCountEl.textContent = filtered.length + ' / ' + currentPositionsData.length;
    } else {
        positionCountEl.textContent = currentPositionsData.length;
    }
    
    // Sort logic
    const sorted = [...filtered].sort((a, b) => {
        let valA, valB;
        switch(currentSortCol) {
            case 'market': valA = a.title || ''; valB = b.title || ''; break;
            case 'outcome': valA = a.outcome || ''; valB = b.outcome || ''; break;
            case 'shares': valA = a.size || 0; valB = b.size || 0; break;
            case 'entryPrice': valA = a.avgPrice || 0; valB = b.avgPrice || 0; break;
            case 'currentPrice': valA = a.curPrice || 0; valB = b.curPrice || 0; break;
            case 'weight': valA = a.weight || 0; valB = b.weight || 0; break;
            case 'change1h': valA = a.pctChange1h !== null ? a.pctChange1h : -9999; valB = b.pctChange1h !== null ? b.pctChange1h : -9999; break;
            case 'change24h': valA = a.pctChange24h !== null ? a.pctChange24h : -9999; valB = b.pctChange24h !== null ? b.pctChange24h : -9999; break;
            case 'value': valA = a.currentValue || 0; valB = b.currentValue || 0; break;
            default: valA = a.currentValue || 0; valB = b.currentValue || 0; break;
        }
        
        if (valA < valB) return currentSortAsc ? -1 : 1;
        if (valA > valB) return currentSortAsc ? 1 : -1;
        return 0;
    });

    const getIconHTML = (colStr) => {
        const isCurrent = currentSortCol === colStr;
        const cls = isCurrent ? (currentSortAsc ? 'asc' : 'desc') : '';
        return `<i data-lucide="chevrons-up-down" class="sort-icon"></i>`;
    };

    const getThClass = (colStr) => {
        return currentSortCol === colStr ? `sortable ${currentSortAsc ? 'asc' : 'desc'}` : 'sortable';
    };

    const tableHTMLStart = `
        <table class="positions-table">
            <thead>
                <tr>
                    <th data-sort="market" class="${getThClass('market')}" style="width: 40%;">Market ${getIconHTML('market')}</th>
                    <th data-sort="currentPrice" class="${getThClass('currentPrice')}" style="width: 12%;">Cur. Price ${getIconHTML('currentPrice')}</th>
                    <th data-sort="weight" class="${getThClass('weight')}" style="width: 12%;">Weight (%) ${getIconHTML('weight')}</th>
                    <th data-sort="change1h" class="${getThClass('change1h')}" style="width: 10%;">1h % Δ ${getIconHTML('change1h')}</th>
                    <th data-sort="change24h" class="${getThClass('change24h')}" style="width: 10%;">24h % Δ ${getIconHTML('change24h')}</th>
                    <th data-sort="value" class="${getThClass('value')}" style="width: 16%;">Value (USDC) ${getIconHTML('value')}</th>
                </tr>
            </thead>
            <tbody>
    `;

    const getRowHTML = (p) => {
        const pnlClass = p.cashPnl >= 0 ? 'value-positive' : 'value-negative';
        const roiClass = p.roi >= 0 ? 'value-positive' : 'value-negative';
        const roiText = formatPct(p.roi);
        const change1hClass = p.pctChange1h !== null ? (p.pctChange1h >= 0 ? 'value-positive' : 'value-negative') : '';
        const change1hText = p.pctChange1h !== null ? formatPct(p.pctChange1h) : 'N/A';
        const changeClass = p.pctChange24h !== null ? (p.pctChange24h >= 0 ? 'value-positive' : 'value-negative') : '';
        const changeText = p.pctChange24h !== null ? formatPct(p.pctChange24h) : 'N/A';
        const outcomeClass = p.outcome ? p.outcome.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
        const isYesNo = ['yes', 'no'].includes(outcomeClass);
        
        // Formulate exactly replicating "Yes 34.5¢  8,902.7 shares"
        const entryCents = (parseFloat(p.avgPrice || 0) * 100).toFixed(1) + '¢';
        const formattedShares = parseFloat(p.size).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}) + ' shares';
        
        return `
            <tr>
                <td>
                    <div class="market-cell">
                        <img src="${p.icon || 'https://polymarket.com/favicon.ico'}" alt="Icon" class="market-img" onerror="this.src='https://polymarket.com/favicon.ico'">
                        <div>
                            <div class="market-title-wrap">
                                ${p.marketUrl 
                                    ? `<a href="${p.marketUrl}" target="_blank" rel="noopener noreferrer" class="market-title" title="${p.title.replace(/"/g, '&quot;')}" style="color: inherit; text-decoration: none;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${p.title}</a>`
                                    : `<div class="market-title" title="${p.title.replace(/"/g, '&quot;')}">${p.title}</div>`
                                }
                                <button class="edit-category-btn" title="Override Category" onclick="openCategoryModal('${p.conditionId}', '${(p.title || '').replace(/'/g, "\\'").replace(/"/g, '&quot;')}', '${(p.category && p.category.label ? p.category.label : '').replace(/'/g, "\\'")}')">
                                    <i data-lucide="pencil" style="width: 12px; height: 12px;"></i>
                                </button>
                            </div>
                            <div class="market-details">
                                <span class="outcome-inline-badge ${isYesNo ? outcomeClass : ''}">${p.outcome || '-'} ${entryCents}</span>
                                <span>${formattedShares}</span>
                            </div>
                        </div>
                    </div>
                </td>
                <td class="num">${((p.curPrice || 0) * 100).toFixed(1)}¢</td>
                <td class="num">${p.weight ? p.weight.toFixed(2) + '%' : '0.00%'}</td>
                <td class="num ${change1hClass}">${change1hText}</td>
                <td class="num ${changeClass}">${changeText}</td>
                <td class="num">
                    <div class="value-cell-stack">
                        <span class="value-main">${formatCurrency(p.currentValue)}</span>
                        <span class="value-sub ${pnlClass}">
                            ${p.cashPnl > 0 ? '+' : ''}${formatCurrency(p.cashPnl)} (${p.roi > 0 ? '+' : ''}${p.roi.toFixed(2)}%)
                        </span>
                    </div>
                </td>
            </tr>
        `;
    };

    let finalHTML = '';

    if (isGrouped) {
        // Group data
        const groups = {};
        sorted.forEach(p => {
            const cid = p.category.id;
            if(!groups[cid]) {
                groups[cid] = { id: cid, label: p.category.label, icon: p.category.icon, items: [], totalVal: 0, totalPnl: 0, totalWeight: 0 };
            }
            groups[cid].items.push(p);
            groups[cid].totalVal += p.currentValue || 0;
            groups[cid].totalPnl += p.cashPnl || 0;
            groups[cid].totalWeight += p.weight || 0;
        });

        // Sort groups by total value
        const sortedGroups = Object.values(groups).sort((a,b) => b.totalVal - a.totalVal);

        finalHTML += tableHTMLStart;
        for (const g of sortedGroups) {
            const pnlClass = g.totalPnl >= 0 ? 'value-positive' : 'value-negative';
            const weightStr = g.totalWeight.toFixed(2) + '%';
            const totalCost = g.totalVal - g.totalPnl;
            const groupRoi = totalCost > 0 ? (g.totalPnl / totalCost) * 100 : 0;
            
            const isExpanded = expandedCategories[g.id] !== false;
            const chevronIcon = isExpanded ? 'chevron-down' : 'chevron-right';
            
            finalHTML += `
                <tr class="category-row" onclick="toggleCategory('${g.id}')">
                    <td>
                        <div class="category-row-left">
                            <i data-lucide="${chevronIcon}" class="category-row-icon" style="opacity: 0.6;"></i>
                            <div class="category-label-wrap">
                                <i data-lucide="${g.icon}" class="category-row-icon"></i> 
                                <span class="category-label-text">${g.label}</span>
                                <button class="rename-category-btn" title="Rename Category" onclick="openBulkRenameModal(event, '${g.label.replace(/'/g, "\\'")}')">
                                    <i data-lucide="edit-3"></i>
                                </button>
                            </div>
                        </div>
                    </td>
                    <td class="num cat-stat"></td>
                    <td class="num cat-stat">${weightStr}</td>
                    <td class="num cat-stat"></td>
                    <td class="num cat-stat"></td>
                    <td class="num">
                        <div class="value-cell-stack">
                            <span class="value-main">${formatCurrency(g.totalVal)}</span>
                            <span class="value-sub ${pnlClass}">
                                ${g.totalPnl > 0 ? '+' : ''}${formatCurrency(g.totalPnl)} (${groupRoi > 0 ? '+' : ''}${groupRoi.toFixed(2)}%)
                            </span>
                        </div>
                    </td>
                </tr>
            `;
            if (isExpanded) {
                for (const p of g.items) {
                    finalHTML += getRowHTML(p);
                }
            }
        }
        finalHTML += `</tbody></table>`;
    } else {
        finalHTML += tableHTMLStart;
        for (const p of sorted) {
            finalHTML += getRowHTML(p);
        }
        finalHTML += `</tbody></table>`;
    }

    tableWrapper.innerHTML = finalHTML;

    // Empty state
    if (sorted.length === 0 && currentPositionsData.length > 0) {
        tableWrapper.innerHTML += `<div class="empty-state"><i data-lucide="search-x" style="width:32px;height:32px;opacity:0.3"></i><p>No positions match "${searchFilter}"</p></div>`;
    } else if (currentPositionsData.length === 0) {
        tableWrapper.innerHTML += `<div class="empty-state"><i data-lucide="inbox" style="width:32px;height:32px;opacity:0.3"></i><p>No open positions found</p></div>`;
    }

    // Use requestAnimationFrame to ensure layout is ready and minimize "drifting" feel
    requestAnimationFrame(() => {
        lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide', nodes: [tableWrapper] });
        
        // Use an additional frame to ensure icons are painted before clearing minHeight
        requestAnimationFrame(() => {
            tableWrapper.style.minHeight = '';
        });
    });
}

// Auto-run on load for demo address or saved wallet
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
