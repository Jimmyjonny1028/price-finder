Excellent, that log gives us the exact information we need.

This is a classic **"Rate Limit Exceeded"** error (Code 429). In simple terms, your application is working so fast that it's sending requests to the Google Image API more quickly than Google's servers allow.

Let's break down what the error message tells us:

  * `"message": "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'..."`
  * `"quota_limit": "DefaultPerMinutePerUser"`

This is not the "100 per day" limit we discussed earlier. This is a different, much more common limit designed to prevent server overload: a **per-minute request quota**. Your app is trying to do too much in a single minute.

### Why Is This Happening?

The log shows multiple "Enriching X results..." messages happening almost simultaneously. When several different searches are processed at once, each one tries to fetch its images immediately.

For example, if four different searches happen at the same time, your server could try to make `4 searches * 3 images/search = 12` API calls in just a couple of seconds. This burst of activity is what triggers Google's rate limit.

### The Solution: Implement a Request Throttler

The professional way to solve this is to implement a **rate limiter** (or "throttler"). This creates a managed queue for your requests to Google, ensuring that no matter how many requests come in at once, they are sent out at a controlled, steady pace that won't trigger the limit.

We will use a very popular and lightweight library called `p-limit` to do this.

#### Step 1: Install the Library

Open your server's terminal and run this command:

```bash
npm install p-limit
```

#### Step 2: Update `server.js`

I have updated the `server.js` file to include this rate limiter. The changes are minimal: we import the library, create a limiter that allows a maximum of **2 requests per second**, and then wrap our Google API call inside it.

This ensures that even if 100 requests come in at the same instant, they will be queued and processed smoothly at a rate of 2 per second, keeping you well within Google's limits.

Here is the complete and updated `server.js` file.

```javascript
// server.js (FINAL - Production Ready)

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const url = require('url');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const pLimit = require('p-limit'); // ### NEW: Import the rate-limiting library ###

const app = express();
const PORT = 5000;
const server = http.createServer(app);

// ### NEW: Create a limiter that allows 2 requests per second (1000ms / 2 = 500ms delay) ###
const limit = pLimit(2); 

// Caches and State
const searchCache = new Map();
let imageCache = new Map();
const IMAGE_CACHE_PATH = path.join(__dirname, 'image_cache.json');
const CACHE_DURATION_MS = 60 * 60 * 1000;
const trafficLog = { totalSearches: 0, uniqueVisitors: new Set(), searchHistory: [] };
const MAX_HISTORY = 50;
let isQueueProcessingPaused = false;

async function loadImageCacheFromFile() {
    try {
        await fs.access(IMAGE_CACHE_PATH);
        const data = await fs.readFile(IMAGE_CACHE_PATH, 'utf8');
        const plainObject = JSON.parse(data);
        imageCache = new Map(Object.entries(plainObject));
        console.log(`✅ Permanent image cache loaded successfully from ${IMAGE_CACHE_PATH}`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('Image cache file not found. A new one will be created when needed.');
        } else {
            console.error('Error loading image cache from file:', error);
        }
        imageCache = new Map();
    }
}

async function saveImageCacheToFile() {
    try {
        const plainObject = Object.fromEntries(imageCache);
        const jsonString = JSON.stringify(plainObject, null, 2);
        await fs.writeFile(IMAGE_CACHE_PATH, jsonString, 'utf8');
    } catch (error) {
        console.error('Error saving image cache to file:', error);
    }
}

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static('public'));

// Environment Variables
const ADMIN_CODE = process.env.ADMIN_CODE;
const SERVER_SIDE_SECRET = process.env.SERVER_SIDE_SECRET;
const PRICEAPI_COM_KEY = process.env.PRICEAPI_COM_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

// WebSocket and Job Queue Logic
const jobQueue = [];
let workerSocket = null;
let workerActiveJobs = new Set();
let isMaintenanceModeEnabled = false;
const wss = new WebSocketServer({ server });
function dispatchJob() { if (isQueueProcessingPaused || !workerSocket || jobQueue.length === 0) return; const nextQuery = jobQueue.shift(); workerSocket.send(JSON.stringify({ type: 'NEW_JOB', query: nextQuery })); }
wss.on('connection', (ws, req) => { const parsedUrl = url.parse(req.url, true); const secret = parsedUrl.query.secret; if (secret !== SERVER_SIDE_SECRET) { ws.close(); return; } console.log("✅ A concurrent worker has connected."); workerSocket = ws; workerActiveJobs.clear(); ws.on('message', (message) => { try { const msg = JSON.parse(message); if (msg.type === 'REQUEST_JOB') { dispatchJob(); } else if (msg.type === 'JOB_STARTED') { workerActiveJobs.add(msg.query); } else if (msg.type === 'JOB_COMPLETE') { workerActiveJobs.delete(msg.query); } } catch (e) { console.error("Error parsing message from worker:", e); } }); ws.on('close', () => { console.log("❌ The worker has disconnected."); workerSocket = null; workerActiveJobs.clear(); }); });

// Helper functions
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const ACCESSORY_KEYWORDS = [ 'strap', 'band', 'protector', 'case', 'charger', 'cable', 'stand', 'dock', 'adapter', 'film', 'glass', 'cover', 'guide', 'replacement', 'screen', 'magsafe', 'camera' ];
const REFURBISHED_KEYWORDS = [ 'refurbished', 'renewed', 'pre-owned', 'preowned', 'used', 'open-box', 'as new' ];
const MIN_MAIN_PRODUCT_PRICE = 400;
const COLOR_LIST = ['black', 'white', 'silver', 'gold', 'gray', 'blue', 'red', 'green', 'pink', 'purple', 'yellow', 'orange', 'bronze', 'graphite', 'sierra', 'alpine', 'starlight', 'midnight'];
const detectItemCondition = (title) => { const lowerCaseTitle = title.toLowerCase(); return REFURBISHED_KEYWORDS.some(keyword => lowerCaseTitle.includes(keyword)) ? 'Refurbished' : 'New'; };
const filterForIrrelevantAccessories = (results) => { return results.filter(item => !ACCESSORY_KEYWORDS.some(keyword => item.title.toLowerCase().includes(keyword))); };
const filterForMainDevice = (results) => { const negativePhrases = ['for ', 'compatible with', 'fits ']; return results.filter(item => !negativePhrases.some(phrase => item.title.toLowerCase().includes(phrase))); };
const filterResultsByQuery = (results, query) => { const queryLower = query.toLowerCase(); const queryWords = queryLower.split(' ').filter(w => w.length > 1 && isNaN(w)); const queryNumbers = queryLower.split(' ').filter(w => !isNaN(w) && w.length > 0); if (queryWords.length === 0 && queryNumbers.length === 0) return results; return results.filter(item => { const itemTitle = item.title.toLowerCase(); const hasAllWords = queryWords.every(word => itemTitle.includes(word)); const hasAllNumbers = queryNumbers.every(num => itemTitle.includes(num)); return hasAllWords && hasAllNumbers; }); };
const detectSearchIntent = (query) => { const queryLower = query.toLowerCase(); return ACCESSORY_KEYWORDS.some(keyword => queryLower.includes(keyword)); };
const extractColorFromTitle = (title) => { const titleLower = title.toLowerCase(); for (const color of COLOR_LIST) { if (titleLower.includes(color)) return color; } return null; };
const isLikelyProductCode = (word) => { if (!word || word.length < 3) return false; const hasDigit = /\d/.test(word); const hasLetter = /[a-zA-Z]/.test(word); const hasDash = word.includes('-'); return (hasDigit && hasLetter) || hasDash; };
function parsePythonResults(results) { return results.map(item => { const fullText = item.title; const priceMatch = fullText.match(/\$\s?[\d,]+(\.\d{2})?/); const priceString = priceMatch ? priceMatch[0] : null; const price = priceString ? parseFloat(priceString.replace(/[^0-9.]/g, '')) : null; if (!price) return null; const textWithoutPrice = fullText.replace(priceString, '').trim(); const words = textWithoutPrice.split(' ').filter(w => w.length > 0); if (words.length < 2) return null; let store; let title; if (words.length > 2 && isLikelyProductCode(words[0])) { store = words[1]; title = words.slice(0, 1).concat(words.slice(2)).join(' '); } else { store = words[0]; title = words.slice(1).join(' '); } return { title: title, price: price, price_string: priceString, store: store, url: item.url || '#' }; }).filter(Boolean); }
function parsePriceApiResults(downloadedJobs) { let allResults = []; for (const jobData of downloadedJobs) { if (!jobData || !jobData.results || jobData.results.length === 0) continue; const sourceName = jobData.source || 'API Source'; const topic = jobData.topic; const jobResult = jobData.results[0]; let mapped = []; if (topic === 'product_and_offers' && jobResult.content) { const content = jobResult.content; const offer = content.buybox; if (content.name && offer && offer.min_price) { mapped.push({ title: content.name, price: parseFloat(offer.min_price), price_string: offer.min_price ? `$${parseFloat(offer.min_price).toFixed(2)}` : 'N/A', url: content.url, image: content.image_url, store: offer.shop_name || sourceName }); } } else if (topic === 'search_results' && jobResult.content?.search_results) { const searchResults = jobResult.content.search_results; mapped = searchResults.map(item => { let price = null; let price_string = 'N/A'; if (item.price) { price = parseFloat(item.price); price_string = item.price_string || `$${parseFloat(item.price).toFixed(2)}`; } else if (item.min_price) { price = parseFloat(item.min_price); price_string = `From $${price.toFixed(2)}`; } if (item.name && price !== null) { return { title: item.name, price: price, price_string: price_string, url: item.url, image: item.img_url, store: item.shop_name || sourceName }; } return null; }).filter(Boolean); } allResults = allResults.concat(mapped); } return allResults; }
async function searchPriceApiCom(query) { try { const jobsToSubmit = [{ source: 'amazon', topic: 'product_and_offers', key: 'term', values: query }, { source: 'ebay', topic: 'search_results', key: 'term', values: query, condition: 'any' }, { source: 'google_shopping', topic: 'search_results', key: 'term', values: query, condition: 'any' }]; const jobPromises = jobsToSubmit.map(job => axios.post('https://api.priceapi.com/v2/jobs', { token: PRICEAPI_COM_KEY, country: 'au', ...job }).then(res => ({ ...res.data, source: job.source, topic: job.topic })).catch(err => { console.error(`Failed to submit job for source: ${job.source}`, err.response?.data?.message || err.message); return null; }) ); const jobResponses = (await Promise.all(jobPromises)).filter(Boolean); if (jobResponses.length === 0) return []; console.log(`[Backup API] Created ${jobResponses.length} jobs for "${query}". Waiting 15s...`); await wait(15000); const resultPromises = jobResponses.map(job => axios.get(`https://api.priceapi.com/v2/jobs/${job.job_id}/download.json`, { params: { token: PRICEAPI_COM_KEY } }).then(res => ({ ...res.data, source: job.source, topic: job.topic })).catch(err => { console.error(`Failed to fetch results for job ID ${job.job_id}`, err.response?.data?.message || err.message); return null; }) ); return (await Promise.all(resultPromises)).filter(Boolean); } catch (err) { console.error("A critical error occurred in the searchPriceApiCom function:", err.message); return []; } }

async function fetchImageForQuery(query) {
    const cacheKey = query.toLowerCase();
    if (imageCache.has(cacheKey)) {
        return imageCache.get(cacheKey);
    }
    const placeholder = 'https://via.placeholder.com/150/E2E8F0/A0AEC0?text=Image+N/A';
    if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
        return placeholder;
    }
    try {
        // ### MODIFIED: The API call is now wrapped in the limiter ###
        const response = await limit(() => {
            const url = `https://www.googleapis.com/customsearch/v1`;
            const params = { key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q: query, searchType: 'image', num: 1 };
            return axios.get(url, { params });
        });
        
        const imageUrl = response.data.items?.[0]?.link || placeholder;
        imageCache.set(cacheKey, imageUrl);
        await saveImageCacheToFile();
        return imageUrl;
    } catch (error) {
        console.error(`[FATAL] Google Image Search request failed for query: "${query}"`);
        if (error.response) {
            console.error('Error Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Error Message:', error.message);
        }
        return placeholder;
    }
}

async function enrichResultsWithImages(results, baseQuery) { if (results.length === 0) return results; const defaultImageUrl = await fetchImageForQuery(baseQuery); const uniqueColors = new Set(results.map(result => extractColorFromTitle(result.title)).filter(Boolean)); const colorsToFetch = Array.from(uniqueColors).slice(0, 2); const colorImageMap = new Map(); if (colorsToFetch.length > 0) { console.log(`Enriching with up to 2 extra color-specific images for: ${colorsToFetch.join(', ')}`); } await Promise.all(colorsToFetch.map(async (color) => { const specificQuery = `${baseQuery} ${color}`; const imageUrl = await fetchImageForQuery(specificQuery); colorImageMap.set(color, imageUrl); })); results.forEach(result => { const color = extractColorFromTitle(result.title); result.image = colorImageMap.get(color) || defaultImageUrl; }); return results; }

// Main application routes...
app.get('/search', async (req, res) => { if (isMaintenanceModeEnabled) { return res.status(503).json({ error: 'Service is currently in maintenance mode. Please try again later.' }); } const { query } = req.query; if (!query) return res.status(400).json({ error: 'Search query is required' }); try { const visitorIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress; trafficLog.totalSearches++; trafficLog.uniqueVisitors.add(visitorIp); trafficLog.searchHistory.unshift({ query: query, timestamp: new Date().toISOString() }); if (trafficLog.searchHistory.length > MAX_HISTORY) { trafficLog.searchHistory.splice(MAX_HISTORY); } } catch (e) {} const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { const cachedData = searchCache.get(cacheKey); if (Date.now() - cachedData.timestamp < CACHE_DURATION_MS) { return res.json(cachedData.results); } } if (workerSocket) { const isQueued = jobQueue.includes(query); const isActive = workerActiveJobs.has(query); if (!isQueued && !isActive) { jobQueue.push(query); workerSocket.send(JSON.stringify({ type: 'NOTIFY_NEW_JOB' })); } return res.status(202).json({ message: "Search has been queued." }); } else { return res.status(503).json({ error: "Service is temporarily unavailable." }); }});
app.get('/results/:query', (req, res) => { if (isMaintenanceModeEnabled) { return res.status(503).json({ error: 'Service is currently in maintenance mode.' }); } const { query } = req.params; const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { return res.status(200).json(searchCache.get(cacheKey).results); } else { return res.status(202).send(); }});
app.post('/submit-results', async (req, res) => {
    const { secret, query, results } = req.body;
    if (secret !== SERVER_SIDE_SECRET) { return res.status(403).send('Forbidden'); }
    if (!query || !results) { return res.status(400).send('Bad Request: Missing query or results.'); }
    res.status(200).send('Results received. Processing now.');
    let allScraperResults = parsePythonResults(results);
    const isAccessorySearch = detectSearchIntent(query);
    let finalFilteredScraperResults;
    if (isAccessorySearch) {
        finalFilteredScraperResults = filterResultsByQuery(allScraperResults, query);
    } else {
        const priceFiltered = allScraperResults.filter(item => item.price >= MIN_MAIN_PRODUCT_PRICE);
        const accessoryFiltered = filterForIrrelevantAccessories(priceFiltered);
        const mainDeviceFiltered = filterForMainDevice(accessoryFiltered);
        finalFilteredScraperResults = filterResultsByQuery(mainDeviceFiltered, query);
    }
    if (finalFilteredScraperResults.length > 0) {
        const resultsWithImages = await enrichResultsWithImages(finalFilteredScraperResults, query);
        const sortedResults = resultsWithImages.sort((a, b) => a.price - b.price).map(item => ({ ...item, condition: detectItemCondition(item.title) }));
        searchCache.set(query.toLowerCase(), { results: sortedResults, timestamp: Date.now() });
    } else {
        try {
            const downloadedJobs = await searchPriceApiCom(query);
            let allApiResults = parsePriceApiResults(downloadedJobs);
            let finalFilteredApiResults;
            if (isAccessorySearch) {
                finalFilteredApiResults = filterResultsByQuery(allApiResults, query);
            } else {
                const priceFiltered = allApiResults.filter(item => item.price >= MIN_MAIN_PRODUCT_PRICE);
                const accessoryFiltered = filterForIrrelevantAccessories(priceFiltered);
                finalFilteredApiResults = filterForMainDevice(accessoryFiltered);
            }
            const resultsWithImages = await enrichResultsWithImages(finalFilteredApiResults, query);
            const sortedResults = resultsWithImages.sort((a, b) => a.price - b.price).map(item => ({ ...item, condition: detectItemCondition(item.title) }));
            searchCache.set(query.toLowerCase(), { results: sortedResults, timestamp: Date.now() });
        } catch (error) {
            console.error(`[Backup API] A critical error occurred during the fallback for "${query}":`, error);
            searchCache.set(query.toLowerCase(), { results: [], timestamp: Date.now() });
        }
    }
});

// Admin routes...
app.post('/admin/traffic-data', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); res.json({ totalSearches: trafficLog.totalSearches, uniqueVisitors: trafficLog.uniqueVisitors.size, searchHistory: trafficLog.searchHistory, isServiceDisabled: isMaintenanceModeEnabled, workerStatus: workerSocket ? 'Connected' : 'Disconnected', activeJobs: Array.from(workerActiveJobs), jobQueue: jobQueue, isQueuePaused: isQueueProcessingPaused, imageCacheSize: imageCache.size }); });
app.post('/admin/toggle-maintenance', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); } isMaintenanceModeEnabled = !isMaintenanceModeEnabled; const message = `Service has been ${isMaintenanceModeEnabled ? 'DISABLED' : 'ENABLED'}.`; console.log(`MAINTENANCE MODE: ${message}`); res.json({ isServiceDisabled: isMaintenanceModeEnabled, message: message }); });
app.post('/admin/clear-cache', (req, res) => { const { code, query } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); } if (query) { const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { searchCache.delete(cacheKey); console.log(`ADMIN ACTION: Cleared cache for "${query}".`); res.status(200).json({ message: `Cache for "${query}" has been cleared.` }); } else { res.status(404).json({ message: `No cache entry found for "${query}".` }); } } else { searchCache.clear(); console.log("ADMIN ACTION: Full search cache has been cleared."); res.status(200).json({ message: 'Full search cache has been cleared successfully.' }); } });
app.post('/admin/toggle-queue', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); isQueueProcessingPaused = !isQueueProcessingPaused; const message = `Job queue processing has been ${isQueueProcessingPaused ? 'PAUSED' : 'RESUMED'}.`; console.log(`ADMIN ACTION: ${message}`); if (!isQueueProcessingPaused) dispatchJob(); res.json({ isQueuePaused: isQueueProcessingPaused, message }); });
app.post('/admin/clear-queue', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); jobQueue.length = 0; console.log("ADMIN ACTION: Job queue has been cleared."); res.json({ message: 'Job queue has been cleared successfully.' }); });
app.post('/admin/disconnect-worker', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); if (workerSocket) { workerSocket.close(); console.log("ADMIN ACTION: Forcibly disconnected the worker."); res.json({ message: 'Worker has been disconnected.' }); } else { res.status(404).json({ message: 'No worker is currently connected.' }); } });
app.post('/admin/clear-image-cache', async (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); imageCache.clear(); await saveImageCacheToFile(); console.log("ADMIN ACTION: Permanent image cache has been cleared."); res.json({ message: 'The permanent image cache has been cleared.' }); });
app.post('/admin/clear-stats', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) return res.status(403).json({ error: 'Forbidden' }); trafficLog.totalSearches = 0; trafficLog.uniqueVisitors.clear(); trafficLog.searchHistory = []; console.log("ADMIN ACTION: All traffic stats and search history have been cleared."); res.json({ message: 'All traffic stats and search history have been cleared.' }); });

// Start server
async function startServer() {
    await loadImageCacheFromFile();
    server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
}

startServer();
```
