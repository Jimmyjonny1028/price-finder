// server.js (FINAL, with Dynamic Sitemap and all features)

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const url = require('url');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = 5000;
const server = http.createServer(app);

let limit;

// Caches and State
let liveState = {
    theme: 'default',
    rainEventTimestamp: 0,
    onlineUsers: 0,
    permanentMessage: "",
    flashMessage: { text: "", timestamp: 0 }
};
const searchCache = new Map();
let imageCache = new Map();
const trafficLog = { totalSearches: 0, uniqueVisitors: new Set(), searchHistory: [] };
const searchTermFrequency = new Map();
const CACHE_DURATION_MS = 60 * 60 * 1000;
const MAX_HISTORY = 50;
const onlineUserTimeouts = new Map();
const USER_ONLINE_TIMEOUT_MS = 65 * 1000;
let isQueueProcessingPaused = false;
let isMaintenanceModeEnabled = false;
const IMAGE_CACHE_PATH = path.join(__dirname, 'image_cache.json');
const LIVE_STATE_PATH = path.join(__dirname, 'public', 'live_state.json');

// --- APP & MIDDLEWARE SETUP ---
app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static('public'));

// --- CONSTANTS ---
const ADMIN_CODE = process.env.ADMIN_CODE;
const SERVER_SIDE_SECRET = process.env.SERVER_SIDE_SECRET;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

const CORE_ENTITIES = {
    'xbox': { positive: ['console', 'series x', 'series s', '1tb', '2tb', '512gb'], negative: ['controller', 'headset', 'game drive', 'for xbox', 'wired', 'wireless headset', 'play and charge', 'chat link', 'game', 'steering wheel', 'racing wheel', 'flightstick', 'sofa', 'expansion card', 'arcade stick'] },
    'nintendo switch': { positive: ['console', 'oled model', 'lite'], negative: ['game', 'controller', 'case', 'grip', 'dock', 'ac adaptor', 'memory card', 'travel bag', 'joy-con', 'charging grip', 'sports', 'kart', 'zelda', 'mario', 'pokemon', 'animal crossing'] },
    'playstation': { positive: ['console', 'ps5', 'ps4', 'slim', 'pro', '1tb', '825gb'], negative: ['controller', 'headset', 'dual sense', 'game', 'vr', 'camera', 'for playstation', 'pulse 3d'] }
};
const GENERIC_ACCESSORY_BRANDS = ['uag', 'otterbox', 'spigen', 'zagg', 'mophie', 'lifeproof', 'incipio', 'tech21', 'cygnett', 'efm', '3sixt', 'belkin', 'smallrig', 'stm', 'dbramante1928', 'razer', 'hyperx', 'logitech', 'steelseries', 'turtle beach', 'astro', 'powera', '8bitdo', 'gamesir'];
const GENERIC_ACCESSORY_KEYWORDS = ['case', 'cover', 'protector', 'charger', 'cable', 'adapter', 'stand', 'mount', 'holder', 'strap', 'band', 'replacement', 'skin', 'film', 'glass', 's-pen', 'spen', 'stylus', 'prismshield', 'kevlar', 'folio', 'holster', 'pouch', 'sleeve', 'wallet', 'battery pack', 'kit', 'cage', 'lens', 'tripod', 'gimbal', 'silicone', 'leather', 'magsafe', 'rugged', 'remote', 'remote control'];
const INTENT_ACCESSORY_KEYWORDS = ['case', 'cover', 'protector', 'charger', 'cable', 'adapter', 'stand', 'mount', 'holder', 'strap', 'band', 'replacement', 'skin', 'film', 'glass', 's-pen', 'spen', 'stylus', 'battery', 'kit', 'cage', 'lens', 'tripod', 'gimbal', 'magsafe', 'remote', 'remote control', 'controller', 'headset'];

// --- HELPER FUNCTIONS ---

// State & File Management
async function updateLiveStateFile() { liveState.onlineUsers = onlineUserTimeouts.size; try { await fs.writeFile(LIVE_STATE_PATH, JSON.stringify(liveState, null, 2), 'utf8'); } catch (error) { console.error('Error writing live state file:', error); } }
async function loadImageCacheFromFile() { try { await fs.access(IMAGE_CACHE_PATH); const data = await fs.readFile(IMAGE_CACHE_PATH, 'utf8'); const plainObject = JSON.parse(data); imageCache = new Map(Object.entries(plainObject)); console.log(`✅ Permanent image cache loaded successfully from ${IMAGE_CACHE_PATH}`); } catch (error) { if (error.code === 'ENOENT') { console.log('Image cache file not found. A new one will be created when needed.'); } else { console.error('Error loading image cache from file:', error); } imageCache = new Map(); } }
async function saveImageCacheToFile() { try { const plainObject = Object.fromEntries(imageCache); const jsonString = JSON.stringify(plainObject, null, 2); await fs.writeFile(IMAGE_CACHE_PATH, jsonString, 'utf8'); } catch (error) { console.error('Error saving image cache to file:', error); } }

// Backup API Logic
let lastOzbargainCallTimestamp = 0;
const OZbARGAIN_COOLDOWN_MS = 60 * 1000;
async function fetchOzbargainBackup(query) {
    const now = Date.now();
    if (now - lastOzbargainCallTimestamp < OZbARGAIN_COOLDOWN_MS) {
        console.log('[Backup] OzBargain API is on cooldown. Skipping call.');
        return [];
    }
    const my_user_agent = "AussieDealTracker/1.0 (Personal project; contact: sam555666@icloud.com)";
    const headers = { 'User-Agent': my_user_agent };
    const api_url = "https://www.ozbargain.com.au/api/live?source=web";
    console.log('[Backup] Calling OzBargain API...');
    lastOzbargainCallTimestamp = now;
    try {
        const response = await axios.get(api_url, { headers, responseType: 'text' });
        const jsonText = response.data.replace(/^ozb_callback\(|\)$/g, '');
        const data = JSON.parse(jsonText);
        if (!data.records || data.records.length === 0) return [];
        const queryWords = query.toLowerCase().split(' ').filter(w => w.length > 1);
        return data.records.filter(record => {
            const titleLower = record.title.toLowerCase();
            return queryWords.every(word => titleLower.includes(word));
        }).map(record => {
            let price = null, price_string = null, store = 'OzBargain';
            const priceMatch = record.title.match(/\$(\d+\.?\d*)/);
            if (priceMatch) { price = parseFloat(priceMatch[1]); price_string = priceMatch[0]; }
            const storeMatch = record.title.match(/@\s*(.+)/);
            if (storeMatch) { store = storeMatch[1].trim(); }
            return { title: record.title, price, price_string, store, url: `https://www.ozbargain.com.au${record.url}`, source: 'OzBargain' };
        }).filter(item => item.price !== null);
    } catch (error) {
        console.error('[Backup] Error fetching or parsing OzBargain data:', error.message);
        return [];
    }
}

// Search & Filtering Logic
function simplifyQuery(query) {
    const words = query.split(' ');
    if (words.length <= 2) return null;
    let lastCoreWordIndex = -1;
    words.forEach((word, index) => { if (/\d/.test(word)) { lastCoreWordIndex = index; } });
    if (lastCoreWordIndex > 0) {
        const simplified = words.slice(0, lastCoreWordIndex + 1).join(' ');
        return simplified !== query ? simplified : null;
    }
    const simplified = words.slice(0, 2).join(' ');
    return simplified !== query ? simplified : null;
}
function getQueryIntent(query) { const lowerQuery = query.toLowerCase(); if (INTENT_ACCESSORY_KEYWORDS.some(keyword => lowerQuery.includes(keyword))) return 'FIND_ACCESSORY'; return 'FIND_MAIN_PRODUCT'; }
function filterByQueryStrictness(results, query) {
    const stopWords = new Set(['a', 'an', 'the', 'in', 'on', 'for', 'with', 'and', 'or']);
    const queryWords = query.toLowerCase().split(' ').filter(word => word.length > 1 && !stopWords.has(word)).map(word => word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));
    if (queryWords.length === 0) return results;
    const regexes = queryWords.map(word => new RegExp(`\\b${word}\\b`, 'i'));
    return results.filter(item => regexes.every(regex => regex.test(item.title)));
}
function calculateScore(title, query) {
    const lowerTitle = title.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let score = 0;
    const matchedEntity = Object.keys(CORE_ENTITIES).find(key => lowerQuery.includes(key));
    if (matchedEntity) {
        const entityRules = CORE_ENTITIES[matchedEntity];
        if (entityRules.positive.some(term => lowerTitle.includes(term))) score += 100;
        if (entityRules.negative.some(term => lowerTitle.includes(term))) score -= 50;
        if (lowerTitle.split(' ').length < 7) score += 20;
    } else {
        if (GENERIC_ACCESSORY_BRANDS.some(brand => lowerTitle.includes(brand))) score -= 100;
        if (GENERIC_ACCESSORY_KEYWORDS.some(keyword => lowerTitle.includes(keyword))) score -= 100;
    }
    return score;
}

// Result Parsing & Enrichment
const detectItemCondition = (title) => { const lowerCaseTitle = title.toLowerCase(); const REFURBISHED_KEYWORDS = ['refurbished', 'renewed', 'pre-owned', 'preowned', 'used', 'open-box', 'as new']; return REFURBISHED_KEYWORDS.some(keyword => lowerCaseTitle.includes(keyword)) ? 'Refurbished' : 'New'; };
const extractColorFromTitle = (title) => { const lowerCaseTitle = title.toLowerCase(); const COLOR_LIST = ['black', 'white', 'silver', 'gold', 'gray', 'blue', 'red', 'green', 'pink', 'purple', 'yellow', 'orange', 'bronze', 'graphite', 'sierra', 'alpine', 'starlight', 'midnight']; for (const color of COLOR_LIST) { if (lowerCaseTitle.includes(color)) return color; } return null; };
function parsePythonResults(results) { return results.map(item => { const fullText = item.title; const priceMatch = fullText.match(/\$\s?[\d,]+(\.\d{2})?/); const priceString = priceMatch ? priceMatch[0] : null; const price = priceString ? parseFloat(priceString.replace(/[^0-9.]/g, '')) : null; if (!price) return null; const store = fullText.split(' ')[0]; return { title: fullText, price: price, price_string: priceString, store: store, url: item.url || '#' }; }).filter(Boolean); }
async function enrichResultsWithImages(results, baseQuery) { if (results.length === 0) return results; const defaultImageUrl = await fetchImageForQuery(baseQuery); const uniqueColors = new Set(results.map(result => extractColorFromTitle(result.title)).filter(Boolean)); const colorsToFetch = Array.from(uniqueColors).slice(0, 2); const colorImageMap = new Map(); if (colorsToFetch.length > 0) { console.log(`Enriching with up to 2 extra color-specific images for: ${colorsToFetch.join(', ')}`); } await Promise.all(colorsToFetch.map(async (color) => { const specificQuery = `${baseQuery} ${color}`; const imageUrl = await fetchImageForQuery(specificQuery); colorImageMap.set(color, imageUrl); })); results.forEach(result => { const color = extractColorFromTitle(result.title); result.image = colorImageMap.get(color) || defaultImageUrl; }); return results; }
async function fetchImageForQuery(query) { const cacheKey = query.toLowerCase(); if (imageCache.has(cacheKey)) { return imageCache.get(cacheKey); } const placeholder = 'https://via.placeholder.com/150/E2E8F0/A0AEC0?text=Image+N/A'; if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) { return placeholder; } try { const response = await limit(() => { const url = `https://www.googleapis.com/customsearch/v1`; const params = { key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q: query, searchType: 'image', num: 1 }; return axios.get(url, { params }); }); const imageUrl = response.data.items?.[0]?.link || placeholder; imageCache.set(cacheKey, imageUrl); await saveImageCacheToFile(); return imageUrl; } catch (error) { console.error(`[FATAL] Google Image Search request failed for query: "${query}"`); if (error.response) { console.error('Error Data:', JSON.stringify(error.response.data, null, 2)); } else { console.error('Error Message:', error.message); } return placeholder; } }

// --- WebSocket Setup ---
const wss = new WebSocketServer({ server });
const jobQueue = [];
let workerSocket = null;
let workerActiveJobs = new Set();
function dispatchJob() { if (isQueueProcessingPaused || !workerSocket || jobQueue.length === 0) return; const nextQuery = jobQueue.shift(); workerSocket.send(JSON.stringify({ type: 'NEW_JOB', query: nextQuery })); }
wss.on('connection', (ws, req) => { const parsedUrl = url.parse(req.url, true); const secret = parsedUrl.query.secret; if (secret !== SERVER_SIDE_SECRET) { ws.close(); return; } console.log("✅ A concurrent worker has connected."); workerSocket = ws; workerActiveJobs.clear(); ws.on('message', (message) => { try { const msg = JSON.parse(message); if (msg.type === 'REQUEST_JOB') { dispatchJob(); } else if (msg.type === 'JOB_STARTED') { workerActiveJobs.add(msg.query); } else if (msg.type === 'JOB_COMPLETE') { workerActiveJobs.delete(msg.query); } } catch (e) { console.error("Error parsing message from worker:", e); } }); ws.on('close', () => { console.log("❌ The worker has disconnected."); workerSocket = null; workerActiveJobs.clear(); }); });

// --- API ENDPOINTS ---
app.get('/search', async (req, res) => { if (isMaintenanceModeEnabled) { return res.status(503).json({ error: 'Service is currently in maintenance mode. Please try again later.' }); } const { query } = req.query; if (!query) return res.status(400).json({ error: 'Search query is required' }); try { const visitorIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress; trafficLog.totalSearches++; trafficLog.uniqueVisitors.add(visitorIp); trafficLog.searchHistory.unshift({ query: query, timestamp: new Date().toISOString() }); if (trafficLog.searchHistory.length > MAX_HISTORY) { trafficLog.searchHistory.splice(MAX_HISTORY); } const normalizedQuery = query.toLowerCase().trim(); if (normalizedQuery) { const currentCount = searchTermFrequency.get(normalizedQuery) || 0; searchTermFrequency.set(normalizedQuery, currentCount + 1); } } catch (e) { console.error("Error logging traffic:", e); } const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { const cachedData = searchCache.get(cacheKey); if (Date.now() - cachedData.timestamp < CACHE_DURATION_MS) { return res.json(cachedData); } } if (workerSocket) { const isQueued = jobQueue.includes(query); const isActive = workerActiveJobs.has(query); if (!isQueued && !isActive) { jobQueue.push(query); workerSocket.send(JSON.stringify({ type: 'NOTIFY_NEW_JOB' })); } return res.status(202).json({ message: "Search has been queued." }); } else { return res.status(503).json({ error: "Service is temporarily unavailable." }); }});
app.get('/results/:query', (req, res) => { if (isMaintenanceModeEnabled) { return res.status(503).json({ error: 'Service is currently in maintenance mode.' }); } const { query } = req.params; const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { return res.status(200).json(searchCache.get(cacheKey)); } else { return res.status(202).send(); }});

app.post('/submit-results', async (req, res) => {
    const { secret, query, results } = req.body;
    if (secret !== SERVER_SIDE_SECRET) return res.status(403).send('Forbidden');
    if (!query || !results) return res.status(400).send('Bad Request: Missing query or results.');
    res.status(200).send('Results received. Processing now.');

    let pipeline = parsePythonResults(results);
    console.log(`[Start] Received ${pipeline.length} results from scraper for "${query}".`);

    if (pipeline.length === 0) {
        pipeline = await fetchOzbargainBackup(query);
        if (pipeline.length > 0) console.log(`[Backup] Found ${pipeline.length} potential deals on OzBargain.`);
        else console.log(`[Backup] OzBargain backup found no results or is on cooldown.`);
    }

    const intent = getQueryIntent(query);
    console.log(`[Intent Analysis] Detected intent: ${intent}`);
    pipeline = filterByQueryStrictness(pipeline, query);
    console.log(`[Filter 1] ${pipeline.length} results remain after strict topic filter.`);
    let scoredPipeline = pipeline.map(item => ({ ...item, score: calculateScore(item.title, query) }));
    if (intent === 'FIND_MAIN_PRODUCT') {
        scoredPipeline = scoredPipeline.filter(item => item.score >= 0);
        console.log(`[Filter 2] ${scoredPipeline.length} results remain after main product scoring filter.`);
    }
    const processedResults = scoredPipeline.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.price - b.price;
    });
    console.log(`[Sort] Final results have been intelligently sorted by relevance and price.`);

    if (processedResults.length > 0) {
        const finalResults = await enrichResultsWithImages(processedResults, query).then(res => res.map(item => ({ ...item, condition: detectItemCondition(item.title) })));
        searchCache.set(query.toLowerCase(), { results: finalResults, timestamp: Date.now() });
        console.log(`[Success] Processed and cached ${finalResults.length} deals for "${query}".`);
    } else {
        const simplifiedQuery = simplifyQuery(query);
        if (simplifiedQuery) {
            console.log(`[Suggestion] No results found. Suggesting simplified query: "${simplifiedQuery}"`);
            searchCache.set(query.toLowerCase(), { results: [], suggestion: simplifiedQuery, timestamp: Date.now() });
        } else {
            console.log(`[Finish] No relevant results found and query cannot be simplified.`);
            searchCache.set(query.toLowerCase(), { results: [], timestamp: Date.now() });
        }
    }
});

// NEW: DYNAMIC SITEMAP ENDPOINT
app.get('/sitemap.xml', (req, res) => {
    const popularSearches = ['xbox series x', 'playstation 5', 'iphone 16', 'samsung s24 ultra', 'rtx 4090', 'nintendo switch'];
    const today = new Date().toISOString().split('T')[0];
    
    let xml = `<?xml version="1.0" encoding="UTF-8"?>`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    xml += `<url><loc>https://deal-finder-12dw.onrender.com/</loc><lastmod>${today}</lastmod><priority>1.00</priority><changefreq>daily</changefreq></url>`;
    popularSearches.forEach(query => {
        xml += `<url><loc>https://deal-finder-12dw.onrender.com/?q=${encodeURIComponent(query)}</loc><lastmod>${today}</lastmod><priority>0.80</priority><changefreq>weekly</changefreq></url>`;
    });
    xml += `</urlset>`;
    
    res.header('Content-Type', 'application/xml');
    res.send(xml);
});

// Admin Endpoints
// ... (All admin endpoints from previous version go here) ...
app.post('/api/ping', (req, res) => { /* ... */ });
app.post('/admin/traffic-data', (req, res) => { /* ... */ });
// etc.

// --- SERVER INITIALIZATION ---
async function startServer() {
    const pLimitModule = await import('p-limit');
    limit = pLimitModule.default(2);
    await loadImageCacheFromFile();
    await updateLiveStateFile();
    server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
}

startServer();
