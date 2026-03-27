import { formatCurrency, formatTime, escapeHtml, fetchWithTimeout, FETCH_TIMEOUT_MS } from './utils.js';

export async function fetchActivity(address, tradesList, elements, signal) {
    const { grossSpentEl, grossReceivedEl, grossRedeemedEl } = elements;

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
        let localGrossReceived = 0;
        let localGrossRedeemed = 0;

        trades.forEach(t => {
            if (t.side === 'BUY') localGrossSpent += Number(t.usdcSize || 0);
            if (t.side === 'SELL') localGrossReceived += Number(t.usdcSize || 0);
        });

        redeems.forEach(r => {
            localGrossRedeemed += Number(r.usdcValue || r.usdcSize || 0);
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
        tradesList.innerHTML = '';
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
                        <span class="outcome-badge ${t.outcome ? escapeHtml(t.outcome.toLowerCase()) : ''}">${escapeHtml(t.outcome)} ${tradePrice}</span>
                        <span>for</span>
                        <strong>${formatCurrency(t.usdcSize)}</strong>
                        <span class="trade-time">${formatTime(t.timestamp)}</span>
                    </div>
                    <div class="market">${escapeHtml(t.title)}</div>
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
