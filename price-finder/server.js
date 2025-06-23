// server.js (FINAL - With Working Maintenance Mode)

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const url = require('url');

const app = express();
const PORT = 5000;
const server = http.createServer(app);

const searchCache = new Map();
const CACHE_DURATION_MS = 60 * 60 * 1000;
const trafficLog = { totalSearches: 0, uniqueVisitors: new Set(), searchHistory: [] };
const MAX_HISTORY = 50;

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static('public'));

const ADMIN_CODE = process.env.ADMIN_CODE;
const SERVER_SIDE_SECRET = process.env.SERVER_SIDE_SECRET;

const jobQueue = [];
let workerSocket = null;
let workerActiveJobs = new Set();

// --- MODIFICATION 1: Add a global state for maintenance mode ---
let isMaintenanceModeEnabled = false;

const wss = new WebSocketServer({ server });

function dispatchJob() {
    if (!workerSocket || jobQueue.length === 0) return;
    const nextQuery = jobQueue.shift();
    workerSocket.send(JSON.stringify({ type: 'NEW_JOB', query: nextQuery }));
}

wss.on('connection', (ws, req) => {
    const parsedUrl = url.parse(req.url, true);
    const secret = parsedUrl.query.secret;
    if (secret !== SERVER_SIDE_SECRET) { ws.close(); return; }
    console.log("✅ A concurrent worker has connected.");
    workerSocket = ws;
    workerActiveJobs.clear();

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'REQUEST_JOB') { dispatchJob(); } 
            else if (msg.type === 'JOB_STARTED') { workerActiveJobs.add(msg.query.toLowerCase()); }
            else if (msg.type === 'JOB_COMPLETE') { workerActiveJobs.delete(msg.query.toLowerCase()); }
        } catch (e) { console.error("Error parsing message from worker:", e); }
    });
    ws.on('close', () => {
        console.log("❌ The worker has disconnected.");
        workerSocket = null;
        workerActiveJobs.clear();
        jobQueue.length = 0;
    });
});

// Helper functions (no changes needed)
const ACCESSORY_KEYWORDS = [ 'strap', 'band', 'protector', 'case', 'charger', 'cable', 'stand', 'dock', 'adapter', 'film', 'glass', 'cover', 'guide', 'replacement' ];
const REFURBISHED_KEYWORDS = [ 'refurbished', 'renewed', 'pre-owned', 'preowned', 'used', 'open-box', 'as new' ];
const detectItemCondition = (title) => { const lowerCaseTitle = title.toLowerCase(); return REFURBISHED_KEYWORDS.some(keyword => lowerCaseTitle.includes(keyword)) ? 'Refurbished' : 'New'; };
function parsePythonResults(results) { return results.map(item => { const fullText = item.title; const priceMatch = fullText.match(/\$\s?[\d,]+\.\d{2}/); const priceString = priceMatch ? priceMatch[0] : null; const price = priceMatch ? parseFloat(priceString.replace(/[^0-9.]/g, '')) : null; const words = fullText.split(' '); const store = words[0]; if (!price) return null; return { title: fullText, price: price, price_string: priceString, store: store, condition: detectItemCondition(fullText), image: 'https://via.placeholder.com/150/E2E8F0/A0AEC0?text=Image+N/A', url: item.url || '#' }; }).filter(Boolean); }
const filterForIrrelevantAccessories = (results) => { return results.filter(item => !ACCESSORY_KEYWORDS.some(keyword => item.title.toLowerCase().includes(keyword))); };
const filterForMainDevice = (results) => { const negativePhrases = ['for ', 'compatible with', 'fits ']; return results.filter(item => !negativePhrases.some(phrase => item.title.toLowerCase().includes(phrase))); };
const filterByPriceAnomalies = (results) => { if (results.length < 5) return results; const prices = results.map(r => r.price).sort((a, b) => a - b); const mid = Math.floor(prices.length / 2); const medianPrice = prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2; const priceThreshold = medianPrice * 0.20; return results.filter(item => item.price >= priceThreshold); };
const filterResultsByQuery = (results, query) => { const queryKeywords = query.toLowerCase().split(' ').filter(word => word.length > 0); if (queryKeywords.length === 0) return results; return results.filter(item => { const itemTitle = item.title.toLowerCase(); return queryKeywords.every(keyword => itemTitle.includes(keyword)); }); };
const detectSearchIntent = (query) => { const queryLower = query.toLowerCase(); return ACCESSORY_KEYWORDS.some(keyword => queryLower.includes(keyword)); };

app.get('/search', async (req, res) => {
    // --- MODIFICATION 2: Add check at the top of the search route ---
    if (isMaintenanceModeEnabled) {
        return res.status(503).json({ error: 'Service is currently in maintenance mode. Please try again later.' });
    }

    const { query } = req.query;
    if (!query) return res.status(400).json({ error: 'Search query is required' });
    try { const visitorIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress; trafficLog.totalSearches++; trafficLog.uniqueVisitors.add(visitorIp); trafficLog.searchHistory.unshift({ query: query, timestamp: new Date().toISOString() }); if (trafficLog.searchHistory.length > MAX_HISTORY) { trafficLog.searchHistory.splice(MAX_HISTORY); } } catch (e) {}
    
    const cacheKey = query.toLowerCase();
    if (searchCache.has(cacheKey)) {
        const cachedData = searchCache.get(cacheKey);
        if (Date.now() - cachedData.timestamp < CACHE_DURATION_MS) {
            return res.json(cachedData.results);
        }
    }

    if (workerSocket) {
        const isQueued = jobQueue.includes(query);
        const isActive = workerActiveJobs.has(cacheKey);
        if (!isQueued && !isActive) {
            jobQueue.push(query);
            workerSocket.send(JSON.stringify({ type: 'NOTIFY_NEW_JOB' }));
        }
        return res.status(202).json({ message: "Search has been queued." });
    } else {
        return res.status(503).json({ error: "Service is temporarily unavailable." });
    }
});

app.get('/results/:query', (req, res) => {
    // Also block polling during maintenance
    if (isMaintenanceModeEnabled) {
        return res.status(503).json({ error: 'Service is currently in maintenance mode.' });
    }
    const { query } = req.params;
    const cacheKey = query.toLowerCase();
    if (searchCache.has(cacheKey)) {
        return res.status(200).json(searchCache.get(cacheKey).results);
    } else {
        return res.status(202).send();
    }
});

app.post('/submit-results', (req, res) => {
    const { secret, query, results } = req.body;
    if (secret !== SERVER_SIDE_SECRET) { return res.status(403).send('Forbidden'); }
    if (!query || !results) { return res.status(400).send('Bad Request: Missing query or results.'); }

    console.log(`Received ${results.length} raw structured results for "${query}" from Python worker.`);
    const isAccessorySearch = detectSearchIntent(query);
    let allResults = parsePythonResults(results);
    let finalFilteredResults;
    if (isAccessorySearch) {
        finalFilteredResults = filterResultsByQuery(allResults, query);
    } else {
        const accessoryFiltered = filterForIrrelevantAccessories(allResults);
        const mainDeviceFiltered = filterForMainDevice(accessoryFiltered);
        const queryFiltered = filterResultsByQuery(mainDeviceFiltered, query);
        finalFilteredResults = filterByPriceAnomalies(queryFiltered);
    }
    const sortedResults = finalFilteredResults.sort((a, b) => a.price - b.price);
    
    searchCache.set(query.toLowerCase(), { results: sortedResults, timestamp: Date.now() });
    console.log(`SUCCESS: Cached ${sortedResults.length} filtered results for "${query}".`);
    res.status(200).send('Results cached successfully.');
});

// --- ADMIN ROUTES ---
app.post('/admin/traffic-data', (req, res) => {
    const { code } = req.body;
    if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); }
    // --- MODIFICATION 3: Report current maintenance status ---
    res.json({
        totalSearches: trafficLog.totalSearches,
        uniqueVisitors: trafficLog.uniqueVisitors.size,
        searchHistory: trafficLog.searchHistory,
        isServiceDisabled: isMaintenanceModeEnabled
    });
});

// --- MODIFICATION 4: Implement the missing toggle route ---
app.post('/admin/toggle-maintenance', (req, res) => {
    const { code } = req.body;
    if (!code || code !== ADMIN_CODE) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    // Flip the boolean state
    isMaintenanceModeEnabled = !isMaintenanceModeEnabled;
    const message = `Service has been ${isMaintenanceModeEnabled ? 'DISABLED' : 'ENABLED'}.`;
    console.log(`MAINTENANCE MODE: ${message}`);
    // Respond with the new state, as the front-end expects
    res.json({
        isServiceDisabled: isMaintenanceModeEnabled,
        message: message
    });
});

server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
