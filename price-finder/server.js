// server.js (FINAL, Definitive Version with Negative Filtering)

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

let liveState = { theme: 'default', rainEventTimestamp: 0, onlineUsers: 0 };
const IMAGE_CACHE_PATH = path.join(__dirname, 'image_cache.json');
const LIVE_STATE_PATH = path.join(__dirname, 'public', 'live_state.json');

// --- File System and State Functions (unchanged) ---
async function updateLiveStateFile() { liveState.onlineUsers = onlineUserTimeouts.size; try { await fs.writeFile(LIVE_STATE_PATH, JSON.stringify(liveState, null, 2), 'utf8'); } catch (error) { console.error('Error writing live state file:', error); } }
async function loadImageCacheFromFile() { try { await fs.access(IMAGE_CACHE_PATH); const data = await fs.readFile(IMAGE_CACHE_PATH, 'utf8'); const plainObject = JSON.parse(data); imageCache = new Map(Object.entries(plainObject)); console.log(`✅ Permanent image cache loaded successfully from ${IMAGE_CACHE_PATH}`); } catch (error) { if (error.code === 'ENOENT') { console.log('Image cache file not found. A new one will be created when needed.'); } else { console.error('Error loading image cache from file:', error); } imageCache = new Map(); } }
async function saveImageCacheToFile() { try { const plainObject = Object.fromEntries(imageCache); const jsonString = JSON.stringify(plainObject, null, 2); await fs.writeFile(IMAGE_CACHE_PATH, jsonString, 'utf8'); } catch (error) { console.error('Error saving image cache to file:', error); } }

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static('public'));

const ADMIN_CODE = process.env.ADMIN_CODE;
const SERVER_SIDE_SECRET = process.env.SERVER_SIDE_SECRET;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

// --- WebSocket Setup (unchanged) ---
const jobQueue = [];
let workerSocket = null;
let workerActiveJobs = new Set();
const wss = new WebSocketServer({ server });
function dispatchJob() { if (isQueueProcessingPaused || !workerSocket || jobQueue.length === 0) return; const nextQuery = jobQueue.shift(); workerSocket.send(JSON.stringify({ type: 'NEW_JOB', query: nextQuery })); }
wss.on('connection', (ws, req) => { const parsedUrl = url.parse(req.url, true); const secret = parsedUrl.query.secret; if (secret !== SERVER_SIDE_SECRET) { ws.close(); return; } console.log("✅ A concurrent worker has connected."); workerSocket = ws; workerActiveJobs.clear(); ws.on('message', (message) => { try { const msg = JSON.parse(message); if (msg.type === 'REQUEST_JOB') { dispatchJob(); } else if (msg.type === 'JOB_STARTED') { workerActiveJobs.add(msg.query); } else if (msg.type === 'JOB_COMPLETE') { workerActiveJobs.delete(msg.query); } } catch (e) { console.error("Error parsing message from worker:", e); } }); ws.on('close', () => { console.log("❌ The worker has disconnected."); workerSocket = null; workerActiveJobs.clear(); }); });


// --- FINAL, SIMPLIFIED FILTERING LOGIC ---

// This list contains words that indicate an item is an accessory or is 'for' another product.
// This is the core of the negative filter.
const NEGATIVE_KEYWORDS = [
    'case', 'cover', 'protector', 'screen', 'film', 'glass',
    'for ', 'fits', 'compatible with', 'designed for',
    'charger', 'cable', 'adapter', 'stand', 'dock', 'mount', 'holder',
    'strap', 'band', 'replacement'
];

/**
 * Checks if the user's query is intentionally for an accessory.
 * @param {string} query The user's search query.
 * @returns {boolean} True if the query likely targets an accessory.
 */
function isAccessorySearch(query) {
    const queryLower = query.toLowerCase();
    // A simplified list to check user intent.
    const accessoryIntentKeywords = ['case', 'cover', 'protector', 'charger', 'cable', 'adapter', 'stand'];
    return accessoryIntentKeywords.some(keyword => queryLower.includes(keyword));
}

/**
 * The primary filter. Ensures all words from the user's query are present in the title.
 * @param {Array<Object>} results The list of results.
 * @param {string} query The user's search query.
 * @returns {Array<Object>} Filtered results.
 */
const filterByQueryStrict = (results, query) => {
    const queryWords = query.toLowerCase().split(' ').filter(w => w.length > 0);
    if (queryWords.length === 0) return results;

    return results.filter(item => {
        const itemTitle = item.title.toLowerCase();
        return queryWords.every(word => itemTitle.includes(word));
    });
};

/**
 * Aggressively removes any item that appears to be an accessory or is "for" another product.
 * @param {Array<Object>} results The list of results to clean.
 * @returns {Array<Object>} The cleaned list, containing only main products.
 */
const filterOutAccessories = (results) => {
    return results.filter(item => {
        const itemTitle = item.title.toLowerCase();
        // If the title contains ANY of the negative keywords, discard it.
        return !NEGATIVE_KEYWORDS.some(keyword => itemTitle.includes(keyword));
    });
};


// --- UTILITY FUNCTIONS (unchanged) ---
const detectItemCondition = (title) => { const lowerCaseTitle = title.toLowerCase(); const REFURBISHED_KEYWORDS = ['refurbished', 'renewed', 'pre-owned', 'preowned', 'used', 'open-box', 'as new']; return REFURBISHED_KEYWORDS.some(keyword => lowerCaseTitle.includes(keyword)) ? 'Refurbished' : 'New'; };
const extractColorFromTitle = (title) => { const lowerCaseTitle = title.toLowerCase(); const COLOR_LIST = ['black', 'white', 'silver', 'gold', 'gray', 'blue', 'red', 'green', 'pink', 'purple', 'yellow', 'orange', 'bronze', 'graphite', 'sierra', 'alpine', 'starlight', 'midnight']; for (const color of COLOR_LIST) { if (lowerCaseTitle.includes(color)) return color; } return null; };
function parsePythonResults(results) { return results.map(item => { const fullText = item.title; const priceMatch = fullText.match(/\$\s?[\d,]+(\.\d{2})?/); const priceString = priceMatch ? priceMatch[0] : null; const price = priceString ? parseFloat(priceString.replace(/[^0-9.]/g, '')) : null; if (!price) return null; const store = fullText.split(' ')[0]; return { title: fullText, price: price, price_string: priceString, store: store, url: item.url || '#' }; }).filter(Boolean); }
async function enrichResultsWithImages(results, baseQuery) { if (results.length === 0) return results; const defaultImageUrl = await fetchImageForQuery(baseQuery); const uniqueColors = new Set(results.map(result => extractColorFromTitle(result.title)).filter(Boolean)); const colorsToFetch = Array.from(uniqueColors).slice(0, 2); const colorImageMap = new Map(); if (colorsToFetch.length > 0) { console.log(`Enriching with up to 2 extra color-specific images for: ${colorsToFetch.join(', ')}`); } await Promise.all(colorsToFetch.map(async (color) => { const specificQuery = `${baseQuery} ${color}`; const imageUrl = await fetchImageForQuery(specificQuery); colorImageMap.set(color, imageUrl); })); results.forEach(result => { const color = extractColorFromTitle(result.title); result.image = colorImageMap.get(color) || defaultImageUrl; }); return results; }
async function fetchImageForQuery(query) { const cacheKey = query.toLowerCase(); if (imageCache.has(cacheKey)) { return imageCache.get(cacheKey); } const placeholder = 'https://via.placeholder.com/150/E2E8F0/A0AEC0?text=Image+N/A'; if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) { return placeholder; } try { const response = await limit(() => { const url = `https://www.googleapis.com/customsearch/v1`; const params = { key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q: query, searchType: 'image', num: 1 }; return axios.get(url, { params }); }); const imageUrl = response.data.items?.[0]?.link || placeholder; imageCache.set(cacheKey, imageUrl); await saveImageCacheToFile(); return imageUrl; } catch (error) { console.error(`[FATAL] Google Image Search request failed for query: "${query}"`); if (error.response) { console.error('Error Data:', JSON.stringify(error.response.data, null, 2)); } else { console.error('Error Message:', error.message); } return placeholder; } }


// --- API ENDPOINTS ---
app.get('/search', async (req, res) => { if (isMaintenanceModeEnabled) { return res.status(503).json({ error: 'Service is currently in maintenance mode. Please try again later.' }); } const { query } = req.query; if (!query) return res.status(400).json({ error: 'Search query is required' }); try { const visitorIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress; trafficLog.totalSearches++; trafficLog.uniqueVisitors.add(visitorIp); trafficLog.searchHistory.unshift({ query: query, timestamp: new Date().toISOString() }); if (trafficLog.searchHistory.length > MAX_HISTORY) { trafficLog.searchHistory.splice(MAX_HISTORY); } const normalizedQuery = query.toLowerCase().trim(); if (normalizedQuery) { const currentCount = searchTermFrequency.get(normalizedQuery) || 0; searchTermFrequency.set(normalizedQuery, currentCount + 1); } } catch (e) { console.error("Error logging traffic:", e); } const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { const cachedData = searchCache.get(cacheKey); if (Date.now() - cachedData.timestamp < CACHE_DURATION_MS) { return res.json(cachedData.results); } } if (workerSocket) { const isQueued = jobQueue.includes(query); const isActive = workerActiveJobs.has(query); if (!isQueued && !isActive) { jobQueue.push(query); workerSocket.send(JSON.stringify({ type: 'NOTIFY_NEW_JOB' })); } return res.status(202).json({ message: "Search has been queued." }); } else { return res.status(503).json({ error: "Service is temporarily unavailable." }); }});
app.get('/results/:query', (req, res) => { if (isMaintenanceModeEnabled) { return res.status(503).json({ error: 'Service is currently in maintenance mode.' }); } const { query } = req.params; const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { return res.status(200).json(searchCache.get(cacheKey).results); } else { return res.status(202).send(); }});

// --- REWRITTEN: /submit-results with the final, definitive logic ---
app.post('/submit-results', async (req, res) => {
    const { secret, query, results } = req.body;
    if (secret !== SERVER_SIDE_SECRET) { return res.status(403).send('Forbidden'); }
    if (!query || !results) { return res.status(400).send('Bad Request: Missing query or results.'); }
    res.status(200).send('Results received. Processing now.');

    let pipeline = parsePythonResults(results);
    console.log(`[Start] Received ${pipeline.length} results from scraper for "${query}".`);

    // STEP 1: Strict query matching. This is the foundation.
    pipeline = filterByQueryStrict(pipeline, query);
    console.log(`[Filter 1] ${pipeline.length} results remain after strict query filter.`);

    // STEP 2: Check if the user *wants* accessories.
    if (!isAccessorySearch(query)) {
        // If not, be ruthless in removing them.
        console.log(`[Filter 2] Main product search detected. Applying negative filter to remove accessories.`);
        pipeline = filterOutAccessories(pipeline);
        console.log(`[Filter 2] ${pipeline.length} results remain after negative filter.`);
    } else {
        console.log(`[Filter 2] Accessory search detected. Skipping negative filter.`);
    }

    // STEP 3: Process the final, clean results.
    if (pipeline.length > 0) {
        const resultsWithImages = await enrichResultsWithImages(pipeline, query);
        const sortedResults = resultsWithImages.sort((a, b) => a.price - b.price).map(item => ({ ...item, condition: detectItemCondition(item.title) }));
        searchCache.set(query.toLowerCase(), { results: sortedResults, timestamp: Date.now() });
        console.log(`[Success] Processed and cached ${sortedResults.length} relevant results for "${query}".`);
    } else {
        console.log(`[Finish] No relevant results found for "${query}" after all filtering. Caching empty result.`);
        searchCache.set(query.toLowerCase(), { results: [], timestamp: Date.now() });
    }
});


// --- Admin and other endpoints (unchanged) ---
app.post('/api/ping', (req, res) => { const { sessionID } = req.body; if (!sessionID) return res.status(400).send(); if (onlineUserTimeouts.has(sessionID)) { clearTimeout(onlineUserTimeouts.get(sessionID)); } const timeoutID = setTimeout(() => { onlineUserTimeouts.delete(sessionID); updateLiveStateFile(); }, USER_ONLINE_TIMEOUT_MS); onlineUserTimeouts.set(sessionID, timeoutID); updateLiveStateFile(); res.status(200).json({ status: 'ok' }); });
app.post('/admin/traffic-data', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); const topSearches = [...searchTermFrequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([term, count]) => ({ term, count })); res.json({ totalSearches: trafficLog.totalSearches, uniqueVisitors: trafficLog.uniqueVisitors.size, searchHistory: trafficLog.searchHistory, isServiceDisabled: isMaintenanceModeEnabled, workerStatus: workerSocket ? 'Connected' : 'Disconnected', activeJobs: Array.from(workerActiveJobs), jobQueue: jobQueue, isQueuePaused: isQueueProcessingPaused, imageCacheSize: imageCache.size, currentTheme: liveState.theme, onlineUsers: liveState.onlineUsers, topSearches: topSearches }); });
app.post('/admin/toggle-maintenance', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); } isMaintenanceModeEnabled = !isMaintenanceModeEnabled; const message = `Service has been ${isMaintenanceModeEnabled ? 'DISABLED' : 'ENABLED'}.`; console.log(`MAINTENANCE MODE: ${message}`); res.json({ isServiceDisabled: isMaintenanceModeEnabled, message: message }); });
app.post('/admin/clear-cache', (req, res) => { const { code, query } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); } if (query) { const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { searchCache.delete(cacheKey); console.log(`ADMIN ACTION: Cleared cache for "${query}".`); res.status(200).json({ message: `Cache for "${query}" has been cleared.` }); } else { res.status(404).json({ message: `No cache entry found for "${query}".` }); } } else { searchCache.clear(); console.log("ADMIN ACTION: Full search cache has been cleared."); res.status(200).json({ message: 'Full search cache has been cleared successfully.' }); } });
app.post('/admin/toggle-queue', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); isQueueProcessingPaused = !isQueueProcessingPaused; const message = `Job queue processing has been ${isQueueProcessingPaused ? 'PAUSED' : 'RESUMED'}.`; console.log(`ADMIN ACTION: ${message}`); if (!isQueueProcessingPaused) dispatchJob(); res.json({ isQueuePaused: isQueueProcessingPaused, message }); });
app.post('/admin/clear-queue', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); jobQueue.length = 0; console.log("ADMIN ACTION: Job queue has been cleared."); res.json({ message: 'Job queue has been cleared successfully.' }); });
app.post('/admin/disconnect-worker', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); if (workerSocket) { workerSocket.close(); console.log("ADMIN ACTION: Forcibly disconnected the worker."); res.json({ message: 'Worker has been disconnected.' }); } else { res.status(404).json({ message: 'No worker is currently connected.' }); } });
app.post('/admin/clear-image-cache', async (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); imageCache.clear(); await saveImageCacheToFile(); console.log("ADMIN ACTION: Permanent image cache has been cleared."); res.json({ message: 'The permanent image cache has been cleared.' }); });
app.post('/admin/clear-stats', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); trafficLog.totalSearches = 0; trafficLog.uniqueVisitors.clear(); trafficLog.searchHistory = []; searchTermFrequency.clear(); console.log("ADMIN ACTION: All traffic stats and search history have been cleared."); res.json({ message: 'All traffic stats and search history have been cleared.' }); });
app.post('/admin/set-theme', async (req, res) => { const { code, theme } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); const validThemes = ['default', 'dark', 'retro', 'sepia', 'solarized', 'synthwave']; if (theme && validThemes.includes(theme)) { liveState.theme = theme; await updateLiveStateFile(); console.log(`ADMIN ACTION: Global theme changed to "${theme}".`); res.json({ message: `Theme changed to ${theme}.` }); } else { res.status(400).json({ error: 'Invalid theme specified.' }); } });
app.post('/admin/trigger-rain', async (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); liveState.rainEventTimestamp = Date.now(); await updateLiveStateFile(); console.log("ADMIN ACTION: Triggered global 'Make It Rain' event."); res.json({ message: 'Rain event triggered for all active users.' }); });

async function startServer() {
    const pLimitModule = await import('p-limit');
    limit = pLimitModule.default(2);
    await loadImageCacheFromFile();
    await updateLiveStateFile();
    server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
}

startServer();
