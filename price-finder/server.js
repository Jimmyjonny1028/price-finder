// server.js (FINAL - Receiver with Maintenance Mode)

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

// --- NEW: Maintenance Mode "Kill Switch" ---
let isServiceDisabled = false;

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static('public'));

const ADMIN_CODE = process.env.ADMIN_CODE;
const SERVER_SIDE_SECRET = process.env.SERVER_SIDE_SECRET;

const jobQueue = [];
let workerSocket = null;
let isWorkerBusy = false;

const wss = new WebSocketServer({ server });

function triggerNextJob() { if (isWorkerBusy || jobQueue.length === 0 || !workerSocket) { return; } isWorkerBusy = true; const nextQuery = jobQueue.shift(); console.log(`Worker is free. Sending new job "${nextQuery}"...`); workerSocket.send(JSON.stringify({ type: 'NEW_JOB', query: nextQuery })); }
wss.on('connection', (ws, req) => { const parsedUrl = url.parse(req.url, true); const secret = parsedUrl.query.secret; if (secret !== SERVER_SIDE_SECRET) { console.log("A client tried to connect with the wrong secret."); ws.close(); return; } console.log("✅ A trusted worker has connected."); workerSocket = ws; isWorkerBusy = false; triggerNextJob(); ws.on('message', (message) => { try { const msg = JSON.parse(message); if (msg.type === 'JOB_COMPLETE') { console.log(`Worker has completed job for "${msg.query}". It is now free.`); isWorkerBusy = false; triggerNextJob(); } } catch (e) { console.error("Error parsing message from worker:", e); } }); ws.on('close', () => { console.log("❌ The trusted worker has disconnected."); workerSocket = null; isWorkerBusy = true; jobQueue.length = 0; console.log("Job queue has been cleared."); }); ws.on('error', (error) => { console.error("WebSocket error:", error); }); });
const ACCESSORY_KEYWORDS = [ 'strap', 'band', 'protector', 'case', 'charger', 'cable', 'stand', 'dock', 'adapter', 'film', 'glass', 'cover', 'guide', 'replacement' ];
const REFURBISHED_KEYWORDS = [ 'refurbished', 'renewed', 'pre-owned', 'preowned', 'used', 'open-box', 'as new' ];
const detectItemCondition = (title) => { const lowerCaseTitle = title.toLowerCase(); return REFURBISHED_KEYWORDS.some(keyword => lowerCaseTitle.includes(keyword)) ? 'Refurbished' : 'New'; };
function formatImageUrl(url) { const placeholder = 'https://via.placeholder.com/150/E2E8F0/A0AEC0?text=Image+N/A'; if (!url || typeof url !== 'string') return placeholder; if (url.startsWith('//')) return `https:${url}`; if (!url.startsWith('http')) return placeholder; return url; }
const filterForIrrelevantAccessories = (results) => { return results.filter(item => !ACCESSORY_KEYWORDS.some(keyword => item.title.toLowerCase().includes(keyword))); };
const filterForMainDevice = (results) => { const negativePhrases = ['for ', 'compatible with', 'fits ']; return results.filter(item => !negativePhrases.some(phrase => item.title.toLowerCase().includes(phrase))); };
const filterByPriceAnomalies = (results) => { if (results.length < 5) return results; const prices = results.map(r => r.price).sort((a, b) => a - b); const mid = Math.floor(prices.length / 2); const medianPrice = prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2; const priceThreshold = medianPrice * 0.20; console.log(`Median price is $${medianPrice.toFixed(2)}. Filtering out items cheaper than $${priceThreshold.toFixed(2)}.`); return results.filter(item => item.price >= priceThreshold); };
const filterResultsByQuery = (results, query) => { const queryKeywords = query.toLowerCase().split(' ').filter(word => word.length > 0); if (queryKeywords.length === 0) return results; return results.filter(item => { const itemTitle = item.title.toLowerCase(); return queryKeywords.every(keyword => itemTitle.includes(keyword)); }); };
const detectSearchIntent = (query) => { const queryLower = query.toLowerCase(); return ACCESSORY_KEYWORDS.some(keyword => queryLower.includes(keyword)); };

app.get('/search', async (req, res) => {
    if (isServiceDisabled) { return res.status(503).json({ error: 'Service is temporarily down for maintenance. Please try again later.' }); }
    const { query } = req.query; if (!query) return res.status(400).json({ error: 'Search query is required' });
    try { const visitorIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress; trafficLog.totalSearches++; trafficLog.uniqueVisitors.add(visitorIp); trafficLog.searchHistory.unshift({ query: query, timestamp: new Date().toISOString() }); if (trafficLog.searchHistory.length > MAX_HISTORY) { trafficLog.searchHistory.splice(MAX_HISTORY); } } catch (e) {}
    const cacheKey = query.toLowerCase();
    if (searchCache.has(cacheKey)) { const cachedData = searchCache.get(cacheKey); if (Date.now() - cachedData.timestamp < CACHE_DURATION_MS) { console.log(`Serving results for "${query}" from CACHE!`); return res.json(cachedData.results); } }
    if (workerSocket) {
        if (!jobQueue.includes(query)) { jobQueue.push(query); console.log(`Query "${query}" added to the job queue. Position: ${jobQueue.length}`); } else { console.log(`Query "${query}" is already in the queue.`); }
        triggerNextJob();
        return res.status(202).json({ message: "Search is in the queue and will be processed by your local worker." });
    } else { return res.status(503).json({ error: "Service is temporarily unavailable. The scraper worker is not connected." }); }
});

app.post('/submit-results', (req, res) => {
    const { secret, query, results } = req.body;
    if (secret !== SERVER_SIDE_SECRET) { return res.status(403).send('Forbidden'); }
    if (!query || !results) { return res.status(400).send('Bad Request: Missing query or results.'); }
    console.log(`Received ${results.length} results for "${query}" from local worker.`);
    const isAccessorySearch = detectSearchIntent(query);
    let allResults = results.map(item => ({ ...item, price: parseFloat(String(item.price_string || '').replace(/[^0-9.]/g, '')), condition: detectItemCondition(item.title), image: formatImageUrl(item.image) })).filter(item => !isNaN(item.price));
    let finalFilteredResults;
    if (isAccessorySearch) { finalFilteredResults = filterResultsByQuery(allResults, query); } 
    else { const accessoryFiltered = filterForIrrelevantAccessories(allResults); const mainDeviceFiltered = filterForMainDevice(accessoryFiltered); const queryFiltered = filterResultsByQuery(mainDeviceFiltered, query); finalFilteredResults = filterByPriceAnomalies(queryFiltered); }
    const sortedResults = finalFilteredResults.sort((a, b) => a.price - b.price);
    const finalPayload = sortedResults.map(({ source, ...rest }) => rest);
    searchCache.set(query.toLowerCase(), { results: finalPayload, timestamp: Date.now() });
    console.log(`SUCCESS: Cached ${sortedResults.length} filtered results for "${query}".`);
    res.status(200).send('Results cached successfully.');
});

app.post('/admin/traffic-data', (req, res) => {
    const { code } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); }
    res.json({ totalSearches: trafficLog.totalSearches, uniqueVisitors: trafficLog.uniqueVisitors.size, searchHistory: trafficLog.searchHistory, isServiceDisabled: isServiceDisabled });
});

app.post('/admin/toggle-maintenance', (req, res) => {
    const { code } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); }
    isServiceDisabled = !isServiceDisabled;
    console.log(`MAINTENANCE MODE TOGGLED. Service is now ${isServiceDisabled ? 'DISABLED' : 'ENABLED'}.`);
    res.status(200).json({ message: `Service is now ${isServiceDisabled ? 'disabled' : 'enabled'}.`, isServiceDisabled: isServiceDisabled });
});

server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
