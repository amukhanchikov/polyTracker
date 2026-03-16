import { formatCurrency, formatPct, escapeHtml } from './utils.js';

export function showSkeleton(tableWrapper) {
    // Preserve height to prevent scroll jumping
    const currentHeight = tableWrapper.offsetHeight;
    if (currentHeight > 100) tableWrapper.style.minHeight = currentHeight + 'px';
    
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

export function calculateTotalVal(currentPositionsData) {
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

function generateRowTemplate(p) {
    const pnlClass = p.cashPnl >= 0 ? 'value-positive' : 'value-negative';
    const roiClass = p.roi >= 0 ? 'value-positive' : 'value-negative';
    const change1hClass = p.pctChange1h !== null ? (p.pctChange1h >= 0 ? 'value-positive' : 'value-negative') : '';
    const change1hText = p.pctChange1h !== null ? formatPct(p.pctChange1h) : 'N/A';
    const changeClass = p.pctChange24h !== null ? (p.pctChange24h >= 0 ? 'value-positive' : 'value-negative') : '';
    const changeText = p.pctChange24h !== null ? formatPct(p.pctChange24h) : 'N/A';
    const outcomeClass = p.outcome ? p.outcome.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    const isYesNo = ['yes', 'no'].includes(outcomeClass);
    
    const entryCents = (parseFloat(p.avgPrice || 0) * 100).toFixed(1) + '¢';
    const formattedShares = parseFloat(p.size).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}) + ' shares';
    
    // XSS Protection for titles
    const safeTitle = escapeHtml(p.title);
    
    // Note: p.category.label is controlled locally, but we escape just in case
    const safeCatLabel = escapeHtml(p.category && p.category.label ? p.category.label : '');
    const encodedConditionId = encodeURIComponent(p.conditionId || '');
    // Using string replacement for onclick to safely pass escaped quotes
    const onClickAttr = `window.openCategoryModal('${encodedConditionId}', '${safeTitle.replace(/'/g, "\\'")}', '${safeCatLabel.replace(/'/g, "\\'")}')`;

    return `
        <tr>
            <td>
                <div class="market-cell">
                    <img src="${p.icon || 'https://polymarket.com/favicon.ico'}" alt="Icon" class="market-img" onerror="this.src='https://polymarket.com/favicon.ico'">
                    <div>
                        <div class="market-title-wrap">
                            ${p.marketUrl 
                                ? `<a href="${p.marketUrl}" target="_blank" rel="noopener noreferrer" class="market-title" title="${safeTitle}" style="color: inherit; text-decoration: none;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${safeTitle}</a>`
                                : `<div class="market-title" title="${safeTitle}">${safeTitle}</div>`
                            }
                            <button class="edit-category-btn" title="Override Category" onclick="${onClickAttr}">
                                <i data-lucide="pencil" style="width: 12px; height: 12px;"></i>
                            </button>
                        </div>
                        <div class="market-details">
                            <span class="outcome-inline-badge ${isYesNo ? outcomeClass : ''}">${escapeHtml(p.outcome) || '-'} ${entryCents}</span>
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
}

function comparePositions(a, b, currentSortCol, currentSortAsc) {
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
}

export function renderTable(state) {
    const {
        tableWrapper,
        positionCountEl,
        isGrouped,
        searchFilter,
        currentPositionsData,
        currentSortCol,
        currentSortAsc,
        expandedCategories
    } = state;

    // Preserve height to prevent scroll jumping
    const currentHeight = tableWrapper.offsetHeight;
    if (currentHeight > 100) tableWrapper.style.minHeight = currentHeight + 'px';
    
    tableWrapper.innerHTML = '';

    // Apply search filter
    const filterLower = (searchFilter || '').toLowerCase();
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
    const sorted = [...filtered].sort((a, b) => comparePositions(a, b, currentSortCol, currentSortAsc));

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

    const getRowHTML = generateRowTemplate;

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
                <tr class="category-row" onclick="window.toggleCategory('${g.id}')">
                    <td>
                        <div class="category-row-left">
                            <i data-lucide="${chevronIcon}" class="category-row-icon" style="opacity: 0.6;"></i>
                            <div class="category-label-wrap">
                                <i data-lucide="${g.icon}" class="category-row-icon"></i> 
                                <span class="category-label-text">${g.label}</span>
                                <button class="rename-category-btn" title="Rename Category" onclick="window.openBulkRenameModal(event, '${g.label.replace(/'/g, "\\'")}')">
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
        if (window.lucide) {
            window.lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide', nodes: [tableWrapper] });
        }
        
        // Use an additional frame to ensure icons are painted before clearing minHeight
        requestAnimationFrame(() => {
            tableWrapper.style.minHeight = '';
        });
    });
}
