// server.js (FINAL - With Image Enrichment)

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

const ADMIN_CODE = process.env.ADMIN_CODE;
const SERVER_SIDE_SECRET = process.env.SERVER_SIDE_SECRET;
const PRICEAPI_COM_KEY = process.env.PRICEAPI_COM_KEY;
// --- MODIFICATION: New keys for Google Image Search ---
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

const jobQueue = [];
let workerSocket = null;
let workerActiveJobs = new Set();
let isMaintenanceModeEnabled = false;

const wss = new WebSocketServer({ server });
function dispatchJob() { if (!workerSocket || jobQueue.length === 0) return; const nextQuery = jobQueue.shift(); workerSocket.send(JSON.stringify({ type: 'NEW_JOB', query: nextQuery }));}
wss.on('connection', (ws, req) => { const parsedUrl = url.parse(req.url, true); const secret = parsedUrl.query.secret; if (secret !== SERVER_SIDE_SECRET) { ws.close(); return; } console.log("✅ A concurrent worker has connected."); workerSocket = ws; workerActiveJobs.clear(); ws.on('message', (message) => { try { const msg = JSON.parse(message); if (msg.type === 'REQUEST_JOB') { dispatchJob(); }  else if (msg.type === 'JOB_STARTED') { workerActiveJobs.add(msg.query); } else if (msg.type === 'JOB_COMPLETE') { workerActiveJobs.delete(msg.query); } } catch (e) { console.error("Error parsing message from worker:", e); } }); ws.on('close', () => { console.log("❌ The worker has disconnected."); workerSocket = null; workerActiveJobs.clear(); jobQueue.length = 0; }); });

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const ACCESSORY_KEYWORDS = [ 'strap', 'band', 'protector', 'case', 'charger', 'cable', 'stand', 'dock', 'adapter', 'film', 'glass', 'cover', 'guide', 'replacement', 'screen', 'magsafe', 'camera' ];
const REFURBISHED_KEYWORDS = [ 'refurbished', 'renewed', 'pre-owned', 'preowned', 'used', 'open-box', 'as new' ];
const MIN_MAIN_PRODUCT_PRICE = 400;
// --- MODIFICATION: List of colors to look for in titles ---
const COLOR_LIST = ['black', 'white', 'silver', 'gold', 'gray', 'blue', 'red', 'green', 'pink', 'purple', 'yellow', 'orange', 'bronze', 'graphite', 'sierra', 'alpine', 'starlight', 'midnight'];

const detectItemCondition = (title) => { const lowerCaseTitle = title.toLowerCase(); return REFURBISHED_KEYWORDS.some(keyword => lowerCaseTitle.includes(keyword)) ? 'Refurbished' : 'New'; };
const filterForIrrelevantAccessories = (results) => { return results.filter(item => !ACCESSORY_KEYWORDS.some(keyword => item.title.toLowerCase().includes(keyword))); };
const filterForMainDevice = (results) => { const negativePhrases = ['for ', 'compatible with', 'fits ']; return results.filter(item => !negativePhrases.some(phrase => item.title.toLowerCase().includes(phrase))); };
const filterResultsByQuery = (results, query) => { const queryLower = query.toLowerCase(); const queryWords = queryLower.split(' ').filter(w => w.length > 1 && isNaN(w)); const queryNumbers = queryLower.split(' ').filter(w => !isNaN(w) && w.length > 0); if (queryWords.length === 0 && queryNumbers.length === 0) return results; return results.filter(item => { const itemTitle = item.title.toLowerCase(); const hasAllWords = queryWords.every(word => itemTitle.includes(word)); const hasAllNumbers = queryNumbers.every(num => itemTitle.includes(num)); return hasAllWords && hasAllNumbers; }); };
const detectSearchIntent = (query) => { const queryLower = query.toLowerCase(); return ACCESSORY_KEYWORDS.some(keyword => queryLower.includes(keyword)); };
const extractColorFromTitle = (title) => { const titleLower = title.toLowerCase(); for (const color of COLOR_LIST) { if (titleLower.includes(color)) return color; } return null; };

function parsePythonResults(results) { return results.map(item => { const fullText = item.title; const priceMatch = fullText.match(/\$\s?[\d,]+(\.\d{2})?/); const priceString = priceMatch ? priceMatch[0] : null; const price = priceString ? parseFloat(priceString.replace(/[^0-9.]/g, '')) : null; const words = fullText.split(' '); const store = words[0]; if (!price) return null; return { title: fullText, price: price, price_string: priceString, store: store, url: item.url || '#' }; }).filter(Boolean); }
function parsePriceApiResults(downloadedJobs) { let allResults = []; for (const jobData of downloadedJobs) { if (!jobData || !jobData.results || jobData.results.length === 0) continue; const sourceName = jobData.source || 'API Source'; const topic = jobData.topic; const jobResult = jobData.results[0]; let mapped = []; if (topic === 'product_and_offers' && jobResult.content) { const content = jobResult.content; const offer = content.buybox; if (content.name && offer && offer.min_price) { mapped.push({ title: content.name, price: parseFloat(offer.min_price), price_string: offer.min_price ? `$${parseFloat(offer.min_price).toFixed(2)}` : 'N/A', url: content.url, image: content.image_url, store: offer.shop_name || sourceName }); } } else if (topic === 'search_results' && jobResult.content?.search_results) { const searchResults = jobResult.content.search_results; mapped = searchResults.map(item => { let price = null; let price_string = 'N/A'; if (item.price) { price = parseFloat(item.price); price_string = item.price_string || `$${parseFloat(item.price).toFixed(2)}`; } else if (item.min_price) { price = parseFloat(item.min_price); price_string = `From $${price.toFixed(2)}`; } if (item.name && price !== null) { return { title: item.name, price: price, price_string: price_string, url: item.url, image: item.img_url, store: item.shop_name || sourceName }; } return null; }).filter(Boolean); } allResults = allResults.concat(mapped); } return allResults; }

async function searchPriceApiCom(query) { try { const jobsToSubmit = [{ source: 'amazon', topic: 'product_and_offers', key: 'term', values: query }, { source: 'ebay', topic: 'search_results', key: 'term', values: query, condition: 'any' }, { source: 'google_shopping', topic: 'search_results', key: 'term', values: query, condition: 'any' }]; const jobPromises = jobsToSubmit.map(job => axios.post('https://api.priceapi.com/v2/jobs', { token: PRICEAPI_COM_KEY, country: 'au', ...job }).then(res => ({ ...res.data, source: job.source, topic: job.topic })).catch(err => { console.error(`Failed to submit job for source: ${job.source}`, err.response?.data?.message || err.message); return null; }) ); const jobResponses = (await Promise.all(jobPromises)).filter(Boolean); if (jobResponses.length === 0) return []; console.log(`[Backup API] Created ${jobResponses.length} jobs for "${query}". Waiting 15s...`); await wait(15000); const resultPromises = jobResponses.map(job => axios.get(`https://api.priceapi.com/v2/jobs/${job.job_id}/download.json`, { params: { token: PRICEAPI_COM_KEY } }).then(res => ({ ...res.data, source: job.source, topic: job.topic })).catch(err => { console.error(`Failed to fetch results for job ID ${job.job_id}`, err.response?.data?.message || err.message); return null; }) ); return (await Promise.all(resultPromises)).filter(Boolean); } catch (err) { console.error("A critical error occurred in the searchPriceApiCom function:", err.message); return []; } }

// --- MODIFICATION: New function to fetch images ---
async function fetchImageForQuery(query) {
    const placeholder = 'https://via.placeholder.com/150/E2E8F0/A0AEC0?text=Image+N/A';
    if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) return placeholder;
    try {
        const url = `https://www.googleapis.com/customsearch/v1`;
        const params = { key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q: query, searchType: 'image', num: 1 };
        const response = await axios.get(url, { params });
        return response.data.items?.[0]?.link || placeholder;
    } catch (error) {
        console.error(`Google Image Search failed for "${query}":`, error.message);
        return placeholder;
    }
}

// --- MODIFICATION: New function to enrich results with images ---
async function enrichResultsWithImages(results, baseQuery) {
    if (results.length === 0) return results;
    console.log(`Enriching ${results.length} results with images...`);
    
    // 1. Fetch the default image for the base query once.
    const defaultImageUrl = await fetchImageForQuery(baseQuery);
    
    // 2. Create a promise for each result to find its specific image.
    const imageEnrichmentPromises = results.map(async (result) => {
        const color = extractColorFromTitle(result.title);
        let imageUrl = defaultImageUrl; // Start with the default

        if (color) {
            // If a color is found, try to get a more specific image.
            const specificQuery = `${baseQuery} ${color}`;
            imageUrl = await fetchImageForQuery(specificQuery);
        }
        
        result.image = imageUrl;
        return result;
    });

    // 3. Run all image searches concurrently and return the results.
    return Promise.all(imageEnrichmentPromises);
}


app.get('/search', async (req, res) => { if (isMaintenanceModeEnabled) { return res.status(503).json({ error: 'Service is currently in maintenance mode. Please try again later.' }); } const { query } = req.query; if (!query) return res.status(400).json({ error: 'Search query is required' }); try { const visitorIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress; trafficLog.totalSearches++; trafficLog.uniqueVisitors.add(visitorIp); trafficLog.searchHistory.unshift({ query: query, timestamp: new Date().toISOString() }); if (trafficLog.searchHistory.length > MAX_HISTORY) { trafficLog.searchHistory.splice(MAX_HISTORY); } } catch (e) {} const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { const cachedData = searchCache.get(cacheKey); if (Date.now() - cachedData.timestamp < CACHE_DURATION_MS) { return res.json(cachedData.results); } } if (workerSocket) { const isQueued = jobQueue.includes(query); const isActive = workerActiveJobs.has(query); if (!isQueued && !isActive) { jobQueue.push(query); workerSocket.send(JSON.stringify({ type: 'NOTIFY_NEW_JOB' })); } return res.status(202).json({ message: "Search has been queued." }); } else { return res.status(503).json({ error: "Service is temporarily unavailable." }); }});
app.get('/results/:query', (req, res) => { if (isMaintenanceModeEnabled) { return res.status(503).json({ error: 'Service is currently in maintenance mode.' }); } const { query } = req.params; const cacheKey = query.toLowerCase(); if (searchCache.has(cacheKey)) { return res.status(200).json(searchCache.get(cacheKey).results); } else { return res.status(202).send(); }});

app.post('/submit-results', async (req, res) => {
    const { secret, query, results } = req.body;
    if (secret !== SERVER_SIDE_SECRET) { return res.status(403).send('Forbidden'); }
    if (!query || !results) { return res.status(400).send('Bad Request: Missing query or results.'); }
    res.status(200).send('Results received. Processing now.');
    console.log(`[SCRAPER] Received ${results.length} raw results for "${query}". Filtering...`);
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
        console.log(`[SCRAPER] Found ${finalFilteredScraperResults.length} valid results after filtering.`);
        const resultsWithImages = await enrichResultsWithImages(finalFilteredScraperResults, query);
        const sortedResults = resultsWithImages.sort((a, b) => a.price - b.price).map(item => ({ ...item, condition: detectItemCondition(item.title) }));
        searchCache.set(query.toLowerCase(), { results: sortedResults, timestamp: Date.now() });
    } else {
        console.log(`[FALLBACK] Scraper results for "${query}" were all filtered out. Triggering backup API...`);
        try {
            const downloadedJobs = await searchPriceApiCom(query);
            let allApiResults = parsePriceApiResults(downloadedJobs);
            console.log(`[Backup API] Parsed ${allApiResults.length} initial results for "${query}". Filtering...`);
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
            console.log(`[Backup API] SUCCESS: Cached ${sortedResults.length} filtered results for "${query}".`);
        } catch (error) {
            console.error(`[Backup API] A critical error occurred during the fallback for "${query}":`, error);
            searchCache.set(query.toLowerCase(), { results: [], timestamp: Date.now() });
        }
    }
});

// Admin routes... (no changes needed)
app.post('/admin/traffic-data', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); } res.json({ totalSearches: trafficLog.totalSearches, uniqueVisitors: trafficLog.uniqueVisitors.size, searchHistory: trafficLog.searchHistory, isServiceDisabled: isMaintenanceModeEnabled }); });
app.post('/admin/toggle-maintenance', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); } isMaintenanceModeEnabled = !isMaintenanceModeEnabled; const message = `Service has been ${isMaintenanceModeEnabled ? 'DISABLED' : 'ENABLED'}.`; console.log(`MAINTENANCE MODE: ${message}`); res.json({ isServiceDisabled: isMaintenanceModeEnabled, message: message }); });
app.post('/admin/clear-cache', (req, res) => { const { code, query } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); } if (query) { searchCache.delete(query.toLowerCase()); console.log(`[ADMIN] Cleared cache for query: "${query}"`); res.status(200).json({ message: `Cache cleared for "${query}".` }); } else { searchCache.clear(); console.log(`[ADMIN] Cleared the entire search cache.`); res.status(200).json({ message: 'Entire search cache has been cleared.' }); } });
app.post('/admin/system-status', (req, res) => { const { code } = req.body; if (!code || code !== ADMIN_CODE) { return res.status(403).json({ error: 'Forbidden' }); } res.json({ workerConnected: workerSocket !== null, activeJobs: Array.from(workerActiveJobs), queuedJobs: jobQueue }); });

server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
