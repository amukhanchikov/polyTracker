import { formatCurrency, escapeHtml, fetchWithTimeout, FETCH_TIMEOUT_MS } from './utils.js';

export async function fetchActivity(address, tradesList, elements, signal) {
    const { grossSpentEl, grossCashInEl } = elements;

    try {
        const actRes = await fetchWithTimeout(
            `https://data-api.polymarket.com/activity?user=${address}&limit=200`,
            FETCH_TIMEOUT_MS,
            signal
        );
        if (!actRes.ok) return null;
        const activities = await actRes.json();
        const cutoff = (Date.now() / 1000) - (24 * 3600);
        const recent = activities.filter(a => a.timestamp && a.timestamp >= cutoff);

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
                byMarket.set(key, { title: key, items: [], totalOut: 0, totalIn: 0 });
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

        // Render grouped list sorted by total volume desc
        const groups = [...byMarket.values()]
            .sort((a, b) => (b.totalOut + b.totalIn) - (a.totalOut + a.totalIn));

        const tFrag = document.createDocumentFragment();
        tradesList.innerHTML = '';

        groups.forEach(g => {
            const net = g.totalIn - g.totalOut;
            const isPositive = net >= 0;
            const count = g.items.length;
            const countLabel = count === 1 ? '1 trade' : `${count} trades`;
            const hasRedeem = g.items.some(i => i.type === 'REDEEM');

            const iconName  = hasRedeem ? 'trophy' : (isPositive ? 'arrow-up-right' : 'arrow-down-left');
            const iconClass = hasRedeem ? 'redeem'  : (isPositive ? 'sell' : 'buy');

            const li = document.createElement('li');
            li.className = 'trade-item trade-group';
            li.innerHTML = `
                <div class="trade-icon ${iconClass}">
                    <i data-lucide="${iconName}"></i>
                </div>
                <div class="trade-details">
                    <div class="trade-group-header">
                        <span class="trade-market">${escapeHtml(g.title)}</span>
                        <span class="trade-count">${countLabel}</span>
                        <span class="trade-net ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : ''}${formatCurrency(net)}</span>
                    </div>
                </div>
            `;
            tFrag.appendChild(li);
        });

        tradesList.appendChild(tFrag);
        if (window.lucide) window.lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide', nodes: [tradesList] });
    } catch(e) {
        if (e.name === 'AbortError') return;
        console.error('Activity fetch failed', e);
    }
}
