// server.js (FINAL - With Correct API Job Handling)

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const url = require('url');
const axios = require('axios');

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

// --- Environment Variables ---
const ADMIN_CODE = process.env.ADMIN_CODE;
const SERVER_SIDE_SECRET = process.env.SERVER_SIDE_SECRET;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const PRICEAPI_COM_KEY = process.env.PRICEAPI_COM_KEY;

const jobQueue = [];
let workerSocket = null;
let workerActiveJobs = new Set();
let isMaintenanceModeEnabled = false;

// --- WebSocket Server (for the scraper) ---
const wss = new WebSocketServer({ server });
function dispatchJob() { if (!workerSocket || jobQueue.length === 0) return; const nextQuery = jobQueue.shift(); workerSocket.send(JSON.stringify({ type: 'NEW_JOB', query: nextQuery }));}
wss.on('connection', (ws, req) => { const parsedUrl = url.parse(req.url, true); const secret = parsedUrl.query.secret; if (secret !== SERVER_SIDE_SECRET) { ws.close(); return; } console.log("✅ A concurrent worker has connected."); workerSocket = ws; workerActiveJobs.clear(); ws.on('message', (message) => { try { const msg = JSON.parse(message); if (msg.type === 'REQUEST_JOB') { dispatchJob(); }  else if (msg.type === 'JOB_STARTED') { workerActiveJobs.add(msg.query.toLowerCase()); } else if (msg.type === 'JOB_COMPLETE') { workerActiveJobs.delete(msg.query.toLowerCase()); } } catch (e) { console.error("Error parsing message from worker:", e); } }); ws.on('close', () => { console.log("❌ The worker has disconnected."); workerSocket = null; workerActiveJobs.clear(); jobQueue.length = 0; }); });

// --- API HELPER FUNCTIONS (Transplanted from your old code) ---
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function cleanGoogleUrl(googleUrl) { if (!googleUrl || !googleUrl.includes('?q=')) return googleUrl; try { const url = new URL(googleUrl); return url.searchParams.get('q') || googleUrl; } catch (e) { return googleUrl; } }
function formatImageUrl(url) { const placeholder = 'https://via.placeholder.com/150/E2E8F0/A0AEC0?text=Image+N/A'; if (!url || typeof url !== 'string') return placeholder; if (url.startsWith('//')) return `https:${url}`; if (!url.startsWith('http')) return placeholder; return url; }

// --- GENERAL HELPER FUNCTIONS ---
const ACCESSORY_KEYWORDS = [ 'strap', 'band', 'protector', 'case', 'charger', 'cable', 'stand', 'dock', 'adapter', 'film', 'glass', 'cover', 'guide', 'replacement', 'screen', 'magsafe', 'camera' ];
const REFURBISHED_KEYWORDS = [ 'refurbished', 'renewed', 'pre-owned', 'preowned', 'used', 'open-box', 'as new' ];
const MIN_MAIN_PRODUCT_PRICE = 400;
const detectItemCondition = (title) => { const lowerCaseTitle = title.toLowerCase(); return REFURBISHED_KEYWORDS.some(keyword => lowerCaseTitle.includes(keyword)) ? 'Refurbished' : 'New'; };
const filterForIrrelevantAccessories = (results) => { return results.filter(item => !ACCESSORY_KEYWORDS.some(keyword => item.title.toLowerCase().includes(keyword))); };
const filterForMainDevice = (results) => { const negativePhrases = ['for ', 'compatible with', 'fits ']; return results.filter(item => !negativePhrases.some(phrase => item.title.toLowerCase().includes(phrase))); };
const filterResultsByQuery = (results, query) => { const queryKeywords = query.toLowerCase().split(' ').filter(word => word.length > 2); if (queryKeywords.length === 0) return results; return results.filter(item => { const itemTitle = item.title.toLowerCase(); return queryKeywords.every(keyword => itemTitle.includes(keyword)); }); };
const detectSearchIntent = (query) => { const queryLower = query.toLowerCase(); return ACCESSORY_KEYWORDS.some(keyword => queryLower.includes(keyword)); };

// --- PARSING FUNCTIONS ---
function parsePythonResults(results) { return results.map(item => { const fullText = item.title; const priceMatch = fullText.match(/\$\s?[\d,]+(\.\d{2})?/); const priceString = priceMatch ? priceMatch[0] : null; const price = priceMatch ? parseFloat(priceString.replace(/[^0-9.]/g, '')) : null; const words = fullText.split(' '); const store = words[0]; if (!price) return null; return { title: fullText, price: price, price_string: priceString, store: store, url: item.url || '#' }; }).filter(Boolean); }

// --- API CALLING FUNCTIONS (Transplanted and adapted) ---
async function searchPricerAPI(query) {
    try {
        const regionalQuery = `${query} australia`;
        const response = await axios.request({ method: 'GET', url: 'https://pricer.p.rapidapi.com/str', params: { q: regionalQuery }, headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': 'pricer.p.rapidapi.com' } });
        return response.data.map(item => ({ title: item?.title || 'Title Not Found', price_string: item?.price || 'N/A', url: cleanGoogleUrl(item?.link), image: item?.img, store: item?.shop ? item.shop.replace(' from ', '') : 'Pricer API' }));
    } catch (err) { console.error("Pricer API search failed:", err.message); return []; }
}
async function searchPriceApiCom(query) {
    let allResults = [];
    try {
        // 1. Submit jobs to the API
        const jobsToSubmit = [{ source: 'amazon', topic: 'product_and_offers', key: 'term', values: query }, { source: 'ebay', topic: 'search_results', key: 'term', values: query, condition: 'any' }, { source: 'google_shopping', topic: 'search_results', key: 'term', values: query, condition: 'any' }];
        const jobPromises = jobsToSubmit.map(job => axios.post('https://api.priceapi.com/v2/jobs', { token: PRICEAPI_COM_KEY, country: 'au', ...job }).then(res => ({ ...res.data, source: job.source, topic: job.topic })).catch(err => { console.error(`Failed to submit job for source: ${job.source}`, err.response?.data?.message || err.message); return null; }) );
        const jobResponses = (await Promise.all(jobPromises)).filter(Boolean);
        if (jobResponses.length === 0) return [];
        
        // --- MODIFICATION: Added the log you requested ---
        console.log(`[Backup API] Created ${jobResponses.length} jobs for "${query}". Waiting 30s for processing...`);

        // 2. Wait for the API to process the jobs
        await wait(30000);

        // 3. Download the resulting JSON files
        const resultPromises = jobResponses.map(job => axios.get(`https://api.priceapi.com/v2/jobs/${job.job_id}/download.json`, { params: { token: PRICEAPI_COM_KEY } }).then(res => ({ ...res.data, source: job.source, topic: job.topic })).catch(err => { console.error(`Failed to fetch results for job ID ${job.job_id}`, err.response?.data?.message || err.message); return null; }) );
        const downloadedResults = (await Promise.all(resultPromises)).filter(Boolean);
        
        // 4. Parse the data from the downloaded files
        for (const data of downloadedResults) {
            let mapped = []; const sourceName = data.source;
            if (data.topic === 'product_and_offers') { const products = data.results?.[0]?.products || []; mapped = products.map(item => ({ title: item?.name || 'Title Not Found', price: item?.price, price_string: item?.offer?.price_string || (item?.price ? `$${item.price.toFixed(2)}` : 'N/A'), url: item?.url, image: item?.image, store: item?.shop?.name || sourceName }));
            } else if (data.topic === 'search_results') { const searchResults = data.results?.[0]?.content?.search_results || []; mapped = searchResults.map(item => { let price = null; let price_string = 'N/A'; if (item.price) { price = parseFloat(item.price_with_shipping) || parseFloat(item.price); price_string = item.price_string || `$${parseFloat(item.price).toFixed(2)}`; } else if (item.min_price) { price = parseFloat(item.min_price); price_string = `From $${price.toFixed(2)}`; } if (item.name && price !== null) return { title: item.name, price: price, price_string: price_string, url: item.url, image: item.img_url, store: item.shop_name || sourceName }; return null; }).filter(Boolean); }
            allResults = allResults.concat(mapped);
        }
        return allResults;
    } catch (err) { console.error("A critical error occurred in the searchPriceApiCom function:", err.message); return []; }
}

// --- MAIN ROUTES ---
app.get('/search', async (req, res) => { if (isMaintenanceModeEnabled) { return res.status(503).json({ error: 'Service is currently in maintenance mode. Please try again later.' }); } const { query } = req.query; if (!query) return res.status(400).json({ error: 'Search query is required' }); try { const visitorIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress; trafficLog.totalSearches++; trafficLog.uniqueVisitors.add(visitorIp); trafficLog.searchHistory.unshift({ query: query, timestamp: new Date().toISOString() }); if (trafficLog.searchHistory.length > MAX_HISTORY) { trafficLog.searchHistory.splice(MAX_HISTORY); } } catch (e) {} const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { const cachedData = searchCache.get(cacheKey); if (Date.now() - cachedData.timestamp < CACHE_DURATION_MS) { return res.json(cachedData.results); } } if (workerSocket) { const isQueued = jobQueue.includes(query); const isActive = workerActiveJobs.has(cacheKey); if (!isQueued && !isActive) { jobQueue.push(query); workerSocket.send(JSON.stringify({ type: 'NOTIFY_NEW_JOB' })); } return res.status(202).json({ message: "Search has been queued." }); } else { return res.status(503).json({ error: "Service is temporarily unavailable." }); }});
app.get('/results/:query', (req, res) => { if (isMaintenanceModeEnabled) { return res.status(503).json({ error: 'Service is currently in maintenance mode.' }); } const { query } = req.params; const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { return res.status(200).json(searchCache.get(cacheKey).results); } else { return res.status(202).send(); }});

// --- DATA SUBMISSION ENDPOINTS ---
app.post('/submit-results', (req, res) => {
    const { secret, query, results } = req.body;
    if (secret !== SERVER_SIDE_SECRET) { return res.status(403).send('Forbidden'); }
    if (!query || !results) { return res.status(400).send('Bad Request: Missing query or results.'); }
    
    console.log(`[SCRAPER] Received ${results.length} raw results for "${query}". Filtering...`);
    let allResults = parsePythonResults(results);
    const isAccessorySearch = detectSearchIntent(query);
    
    let finalFilteredResults;
    if (isAccessorySearch) {
        finalFilteredResults = filterResultsByQuery(allResults, query);
    } else {
        const priceFiltered = allResults.filter(item => item.price >= MIN_MAIN_PRODUCT_PRICE);
        const accessoryFiltered = filterForIrrelevantAccessories(priceFiltered);
        finalFilteredResults = filterForMainDevice(accessoryFiltered);
    }
    
    const sortedResults = finalFilteredResults.sort((a, b) => a.price - b.price).map(item => ({ ...item, condition: detectItemCondition(item.title) }));
    searchCache.set(query.toLowerCase(), { results: sortedResults, timestamp: Date.now() });
    console.log(`[SCRAPER] SUCCESS: Cached ${sortedResults.length} filtered results for "${query}".`);
    res.status(200).send('Results filtered and cached successfully.');
});

app.post('/report-failure', async (req, res) => {
    const { secret, query } = req.body;
    if (secret !== SERVER_SIDE_SECRET) { return res.status(403).send('Forbidden'); }
    if (!query) { return res.status(400).send('Bad Request: Missing query.'); }
    
    console.log(`[FALLBACK] Primary scraper failed for "${query}". Triggering backup APIs...`);
    res.status(200).send('Failure reported. Backup API initiated.');

    try {
        const [pricerResults, priceApiComResults] = await Promise.all([ searchPricerAPI(query), searchPriceApiCom(query) ]);
        let allResults = [...pricerResults, ...priceApiComResults]
            .map(item => ({ ...item, price: parseFloat(String(item.price_string || item.price).replace(/[^0-9.]/g, '')), image: formatImageUrl(item.image) }))
            .filter(item => !isNaN(item.price));
        
        console.log(`[Backup API] Received ${allResults.length} initial results for "${query}". Filtering...`);
        const isAccessorySearch = detectSearchIntent(query);

        let finalFilteredResults;
        if (isAccessorySearch) {
            finalFilteredResults = filterResultsByQuery(allResults, query);
        } else {
            const priceFiltered = allResults.filter(item => item.price >= MIN_MAIN_PRODUCT_PRICE);
            const accessoryFiltered = filterForIrrelevantAccessories(priceFiltered);
            finalFilteredResults = filterForMainDevice(accessoryFiltered);
        }

        const sortedResults = finalFilteredResults.sort((a, b) => a.price - b.price).map(item => ({ ...item, condition: detectItemCondition(item.title) }));
        searchCache.set(query.toLowerCase(), { results: sortedResults, timestamp: Date.now() });
        console.log(`[Backup API] SUCCESS: Cached ${sortedResults.length} filtered results for "${query}".`);
    } catch (error) {
        console.error(`[Backup API] A critical error occurred during the fallback for "${query}":`, error);
        searchCache.set(query.toLowerCase(), { results: [], timestamp: Date.now() });
    }
});

// --- ADMIN ROUTES ---
app.post('/admin/traffic-data', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); } res.json({ totalSearches: trafficLog.totalSearches, uniqueVisitors: trafficLog.uniqueVisitors.size, searchHistory: trafficLog.searchHistory, isServiceDisabled: isMaintenanceModeEnabled }); });
app.post('/admin/toggle-maintenance', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); } isMaintenanceModeEnabled = !isMaintenanceModeEnabled; const message = `Service has been ${isMaintenanceModeEnabled ? 'DISABLED' : 'ENABLED'}.`; console.log(`MAINTENANCE MODE: ${message}`); res.json({ isServiceDisabled: isMaintenanceModeEnabled, message: message }); });

server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
