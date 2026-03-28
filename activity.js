import { formatCurrency, escapeHtml, fetchWithTimeout, FETCH_TIMEOUT_MS, formatTimeShort as formatTime, SECONDS_24H } from './utils.js';

export async function fetchActivity(addresses, tradesList, elements, signal) {
    const { grossSpentEl, grossCashInEl } = elements;
    const addrList = Array.isArray(addresses) ? addresses : [addresses];

    try {
        // Fetch activity for all wallets in parallel
        const allActivities = [];
        await Promise.all(addrList.map(async addr => {
            try {
                const res = await fetchWithTimeout(
                    `https://data-api.polymarket.com/activity?user=${addr}&limit=200`,
                    FETCH_TIMEOUT_MS,
                    signal
                );
                if (!res.ok) return;
                const acts = await res.json();
                allActivities.push(...acts);
            } catch (e) {
                if (e.name !== 'AbortError') console.warn(`Activity fetch failed for ${addr}`, e);
            }
        }));

        if (signal && signal.aborted) return;

        const cutoff = (Date.now() / 1000) - SECONDS_24H;
        const recent = allActivities.filter(a => a.timestamp && a.timestamp >= cutoff);

        const trades = recent.filter(a => a.type === 'TRADE');
        const redeems = recent.filter(a => a.type === 'REDEEM');

        let localGrossSpent = 0;
        let localGrossCashIn = 0;

        trades.forEach(t => {
            if (t.side === 'BUY')  localGrossSpent  += Number(t.usdcSize || 0);
            if (t.side === 'SELL') localGrossCashIn += Number(t.usdcSize || 0);
        });
        redeems.forEach(r => {
            localGrossCashIn += Number(r.usdcValue || r.usdcSize || 0);
        });

        const netLiquidity = localGrossCashIn - localGrossSpent;

        grossSpentEl.innerText  = `-${formatCurrency(localGrossSpent)}`;
        grossCashInEl.innerText = `+${formatCurrency(localGrossCashIn)}`;

        const netLiqEl = document.getElementById('net-liquidity');
        netLiqEl.className = `value ${netLiquidity >= 0 ? 'positive' : 'negative'}`;
        netLiqEl.innerText = `${netLiquidity > 0 ? '+' : ''}${formatCurrency(netLiquidity)}`;

        // Group all activity by market title
        const allActivity = [...trades, ...redeems];
        const byMarket = new Map();
        allActivity.forEach(a => {
            const key = a.title || 'Unknown';
            if (!byMarket.has(key)) {
                byMarket.set(key, { title: key, eventSlug: a.eventSlug || '', items: [], totalOut: 0, totalIn: 0 });
            }
            const g = byMarket.get(key);
            g.items.push(a);
            if (a.type === 'TRADE' && a.side === 'BUY')  g.totalOut += Number(a.usdcSize || 0);
            if (a.type === 'TRADE' && a.side === 'SELL')  g.totalIn  += Number(a.usdcSize || 0);
            if (a.type === 'REDEEM') g.totalIn += Number(a.usdcValue || a.usdcSize || 0);
        });

        // Update header meta counter
        const metaEl = document.getElementById('activity-meta');
        if (metaEl) {
            const total = trades.length + redeems.length;
            const markets = byMarket.size;
            metaEl.textContent = total > 0
                ? `${total} trade${total !== 1 ? 's' : ''} · ${markets} market${markets !== 1 ? 's' : ''}`
                : '';
        }

        // Render grouped list sorted by most recent trade first
        const groups = [...byMarket.values()]
            .sort((a, b) => {
                const aMax = Math.max(...a.items.map(i => Number(i.timestamp) || 0));
                const bMax = Math.max(...b.items.map(i => Number(i.timestamp) || 0));
                return bMax - aMax;
            });

        tradesList.innerHTML = '';
        const tFrag = document.createDocumentFragment();

        groups.forEach(g => {
            const net = g.totalIn - g.totalOut;
            const isPositive = net >= 0;
            const count = g.items.length;
            const countLabel = count === 1 ? '1 trade' : `${count} trades`;
            const hasRedeem = g.items.some(i => i.type === 'REDEEM');
            const isExpandable = count > 1;

            const iconName  = hasRedeem ? 'trophy' : (isPositive ? 'arrow-up-right' : 'arrow-down-left');
            const iconClass = hasRedeem ? 'redeem'  : (isPositive ? 'sell' : 'buy');
            const newestTs = Math.max(...g.items.map(i => Number(i.timestamp) || 0));
            const groupTime = formatTime(newestTs);

            // Build sub-rows for individual trades
            const subRowsHTML = g.items
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                .map(item => {
                    const isBuy    = item.type === 'TRADE' && item.side === 'BUY';
                    const isRedeem = item.type === 'REDEEM';
                    const amount   = Number(item.usdcSize || item.usdcValue || 0);
                    const subIcon  = isRedeem ? 'trophy' : (isBuy ? 'arrow-down-left' : 'arrow-up-right');
                    const subClass = isRedeem ? 'redeem' : (isBuy ? 'buy' : 'sell');
                    const sign     = isBuy ? '-' : '+';
                    const amtClass = isBuy ? 'negative' : 'positive';
                    const outcome  = escapeHtml(item.outcome || '');
                    const time     = formatTime(item.timestamp);
                    return `
                        <div class="trade-sub-row">
                            <div class="trade-icon trade-icon--sm ${subClass}">
                                <i data-lucide="${subIcon}"></i>
                            </div>
                            <span class="trade-sub-outcome">${outcome}</span>
                            <span class="trade-sub-time">${time}</span>
                            <span class="trade-sub-amount ${amtClass}">${sign}${formatCurrency(amount)}</span>
                        </div>`;
                }).join('');

            const li = document.createElement('li');
            li.className = `trade-item trade-group${isExpandable ? ' is-expandable' : ''}`;
            li.innerHTML = `
                <div class="trade-icon ${iconClass}">
                    <i data-lucide="${iconName}"></i>
                </div>
                <div class="trade-details">
                    <div class="trade-group-header">
                        ${g.eventSlug
                            ? `<a href="https://polymarket.com/event/${encodeURIComponent(g.eventSlug)}" target="_blank" rel="noopener noreferrer" class="trade-market trade-market-link">${escapeHtml(g.title)}</a>`
                            : `<span class="trade-market">${escapeHtml(g.title)}</span>`
                        }
                        <span class="trade-count">${countLabel}${isExpandable ? ' <i data-lucide="chevron-down" class="trade-chevron"></i>' : ''}</span>
                        <span class="trade-time">${groupTime}</span>
                        <span class="trade-net ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : ''}${formatCurrency(net)}</span>
                    </div>
                    ${isExpandable ? `<div class="trade-sub-list">${subRowsHTML}</div>` : ''}
                </div>
            `;

            if (isExpandable) {
                li.querySelector('.trade-group-header').addEventListener('click', (e) => {
                    if (e.target.closest('a')) return; // Don't toggle when clicking market link
                    li.classList.toggle('expanded');
                });
            }

            tFrag.appendChild(li);
        });

        tradesList.appendChild(tFrag);
        if (window.lucide) window.lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide', nodes: [tradesList] });
    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error('Activity fetch failed', e);
    }
}
