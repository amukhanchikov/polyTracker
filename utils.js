// Constants
export const CACHE_TTL_MS = 300000;        // 5 minutes
export const RENDER_DEBOUNCE_MS = 150;
export const SEARCH_DEBOUNCE_MS = 200;
export const MAX_CONCURRENT_REQUESTS = 15;
export const FETCH_TIMEOUT_MS = 20000;     // 20 seconds
export const SORT_NULL_VALUE = -Infinity;
export const CACHE_MAX_AGE_MS = 86400000;  // 24 hours (for cleanup)
export const CACHE_PREFIX = 'polytracker_ph_';

// Toast notification (replaces alert)
export function showToast(msg, type = 'error') {
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast-notification toast-' + type;
    toast.textContent = msg;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => toast.remove());
    toast.appendChild(closeBtn);
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentElement) toast.remove(); }, 5000);
}

// Formatters
export const formatCurrency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
export const formatPct = (val) => (val > 0 ? '+' : '') + val.toFixed(2) + '%';
export const formatTime = (ts) => {
    if(!ts) return '';
    const d = new Date(ts * 1000);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm} ${d.getDate()} ${months[d.getMonth()]}`;
};

export function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

// Fetch with timeout via AbortController
export function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS, signal) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // If an external signal is provided, abort our controller when it fires
    if (signal) {
        signal.addEventListener('abort', () => controller.abort());
    }

    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

// Validate Ethereum address format
export function isValidAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Cleanup old localStorage cache entries
export function cleanupOldCache() {
    try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(CACHE_PREFIX)) {
                try {
                    const parsed = JSON.parse(localStorage.getItem(key));
                    if (!parsed._ts || Date.now() - parsed._ts > CACHE_MAX_AGE_MS) {
                        keysToRemove.push(key);
                    }
                } catch(e) {
                    keysToRemove.push(key);
                }
            }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch(e) {
        // Ignore storage errors
    }
}
