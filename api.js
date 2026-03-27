import { MAX_CONCURRENT_REQUESTS, FETCH_TIMEOUT_MS, fetchWithTimeout } from './utils.js';

// Polygon RPC endpoints (tried in order, first success wins)
const POLYGON_RPCS = [
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon.drpc.org',
];

// USDC contract addresses on Polygon (both have 6 decimals)
const USDC_NATIVE  = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC (Polymarket primary)
const USDC_BRIDGED = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (bridged, older)

function buildBalanceOfCall(contractAddress, walletAddress) {
    // Strip 0x, lowercase, left-pad to 64 hex chars (32 bytes)
    const padded = walletAddress.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
    return {
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: contractAddress, data: '0x70a08231' + padded }, 'latest'],
        id: 1,
    };
}

async function callRPC(rpcUrl, body, signal) {
    const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.result;
}

// Returns free USDC balance in dollars (native + bridged combined)
export async function getUSDCBalance(address, signal) {
    for (const rpc of POLYGON_RPCS) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const combinedSignal = signal
                ? AbortSignal.any ? AbortSignal.any([signal, controller.signal]) : controller.signal
                : controller.signal;

            const [resNative, resBridged] = await Promise.all([
                callRPC(rpc, buildBalanceOfCall(USDC_NATIVE,  address), combinedSignal),
                callRPC(rpc, buildBalanceOfCall(USDC_BRIDGED, address), combinedSignal),
            ]);
            clearTimeout(timeoutId);

            const native  = parseInt(resNative,  16) || 0;
            const bridged = parseInt(resBridged, 16) || 0;
            // Both contracts have 6 decimals
            return (native + bridged) / 1_000_000;
        } catch(e) {
            if (e.name === 'AbortError') return null;
            console.warn(`Polygon RPC failed (${rpc}):`, e.message);
        }
    }
    console.warn('All Polygon RPCs failed — free balance unavailable');
    return null;
}

// Throttled fetch: limits concurrent requests to avoid 429 rate limits
export function createThrottledFetcher(concurrency = MAX_CONCURRENT_REQUESTS) {
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

export const throttle = createThrottledFetcher();

// Fetch Historical Metrics from CLOB (with retry on 429)
export async function getHistoricalMetrics(assetId, signal) {
    const doFetch = async (attempt = 0) => {
        try {
            const res = await fetchWithTimeout(
                `https://clob.polymarket.com/prices-history?market=${assetId}&interval=1d`,
                FETCH_TIMEOUT_MS,
                signal
            );
            if (res.status === 429 && attempt < 3) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                return doFetch(attempt + 1);
            }
            if (!res.ok) return null;

            const data = await res.json();
            const history = data.history;

            if (!history || history.length === 0) return null;

            const cutoff24h = (Date.now() / 1000) - (24 * 3600);
            const cutoff1h = (Date.now() / 1000) - 3600;
            const latestPrice = history[history.length - 1].p;

            let histPrice24h = null, histTime24h = null;
            let histPrice1h = null, histTime1h = null;
            let found24h = false;

            // Single pass: history sorted ascending by timestamp
            for (const entry of history) {
                if (!found24h && entry.t >= cutoff24h) {
                    histPrice24h = entry.p;
                    histTime24h = entry.t;
                    found24h = true;
                }
                if (entry.t >= cutoff1h) {
                    histPrice1h = entry.p;
                    histTime1h = entry.t;
                    break;
                }
            }

            // Sparkline: last 24h of data (up to 48 points), normalized for SVG
            const sparkRaw = history.filter(e => e.t >= cutoff24h);
            const sparkline = sparkRaw.length >= 2 ? sparkRaw.map(e => e.p) : null;

            return {
                pct24h: histPrice24h !== null && histPrice24h > 0 ? ((latestPrice - histPrice24h) / histPrice24h) * 100 : null,
                price24h: histPrice24h,
                time24h: histTime24h,
                pct1h: histPrice1h !== null && histPrice1h > 0 ? ((latestPrice - histPrice1h) / histPrice1h) * 100 : null,
                price1h: histPrice1h,
                time1h: histTime1h,
                sparkline,
            };
        } catch(e) {
            if (e.name === 'AbortError') return null;
            console.warn('Failed to fetch price history for', assetId);
        }
        return null;
    };
    return doFetch();
}
