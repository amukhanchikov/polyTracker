// Throttled fetch: limits concurrent requests to avoid 429 rate limits
export function createThrottledFetcher(concurrency = 5) {
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

export const throttle = createThrottledFetcher(15);

// Fetch Historical Metrics from CLOB (with retry on 429)
export async function getHistoricalMetrics(assetId) {
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
