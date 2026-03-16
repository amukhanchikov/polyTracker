export const ICON_MAP = {
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
    'sport': 'trophy',
    'sports': 'trophy',
    'economy': 'trending-up',
    'geopolitics': 'globe'
};

export function loadCustomCategories() {
    try { 
        return JSON.parse(localStorage.getItem('polytracker_categories') || '{}'); 
    } catch(e) { 
        console.warn('Corrupted categories in localStorage, resetting'); 
        return {};
    }
}

export function saveCustomCategories(customCategories) {
    localStorage.setItem('polytracker_categories', JSON.stringify(customCategories));
}

// Category resolution: custom overrides → title-based matching
export function resolveCategory(conditionId, title, customCategories) {
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
