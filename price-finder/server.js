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

let liveState = {
    theme: 'default',
    rainEventTimestamp: 0,
    onlineUsers: 0
};
const IMAGE_CACHE_PATH = path.join(__dirname, 'image_cache.json');
const LIVE_STATE_PATH = path.join(__dirname, 'public', 'live_state.json');

// --- Helper Functions ---
async function updateLiveStateFile() { liveState.onlineUsers = onlineUserTimeouts.size; try { await fs.writeFile(LIVE_STATE_PATH, JSON.stringify(liveState, null, 2), 'utf8'); } catch (error) { console.error('Error writing live state file:', error); } }
async function loadImageCacheFromFile() { try { await fs.access(IMAGE_CACHE_PATH); const data = await fs.readFile(IMAGE_CACHE_PATH, 'utf8'); const plainObject = JSON.parse(data); imageCache = new Map(Object.entries(plainObject)); console.log(`✅ Permanent image cache loaded successfully from ${IMAGE_CACHE_PATH}`); } catch (error) { if (error.code === 'ENOENT') { console.log('Image cache file not found. A new one will be created when needed.'); } else { console.error('Error loading image cache from file:', error); } imageCache = new Map(); } }
async function saveImageCacheToFile() { try { const plainObject = Object.fromEntries(imageCache); const jsonString = JSON.stringify(plainObject, null, 2); await fs.writeFile(IMAGE_CACHE_PATH, jsonString, 'utf8'); } catch (error) { console.error('Error saving image cache to file:', error); } }

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static('public'));

const ADMIN_CODE = process.env.ADMIN_CODE;
const SERVER_SIDE_SECRET = process.env.SERVER_SIDE_SECRET;
const PRICEAPI_COM_KEY = process.env.PRICEAPI_COM_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

const jobQueue = [];
let workerSocket = null;
let workerActiveJobs = new Set();
const wss = new WebSocketServer({ server });
function dispatchJob() { if (isQueueProcessingPaused || !workerSocket || jobQueue.length === 0) return; const nextQuery = jobQueue.shift(); workerSocket.send(JSON.stringify({ type: 'NEW_JOB', query: nextQuery })); }
wss.on('connection', (ws, req) => { const parsedUrl = url.parse(req.url, true); const secret = parsedUrl.query.secret; if (secret !== SERVER_SIDE_SECRET) { ws.close(); return; } console.log("✅ A concurrent worker has connected."); workerSocket = ws; workerActiveJobs.clear(); ws.on('message', (message) => { try { const msg = JSON.parse(message); if (msg.type === 'REQUEST_JOB') { dispatchJob(); } else if (msg.type === 'JOB_STARTED') { workerActiveJobs.add(msg.query); } else if (msg.type === 'JOB_COMPLETE') { workerActiveJobs.delete(msg.query); } } catch (e) { console.error("Error parsing message from worker:", e); } }); ws.on('close', () => { console.log("❌ The worker has disconnected."); workerSocket = null; workerActiveJobs.clear(); }); });

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const REFURBISHED_KEYWORDS = [ 'refurbished', 'renewed', 'pre-owned', 'preowned', 'used', 'open-box', 'as new' ];
const COMPONENT_KEYWORDS = ['ssd', 'hdd', 'ram', 'memory', 'cooler', 'fan', 'power supply', 'psu', 'motherboard', 'cpu', 'processor', 'gpu', 'graphics card', 'strap', 'band', 'protector', 'case', 'charger', 'cable', 'stand', 'dock', 'adapter', 'film', 'glass', 'cover'];
const MAIN_PRODUCT_PRICE_THRESHOLD = 200;
const COLOR_LIST = ['black', 'white', 'silver', 'gold', 'gray', 'blue', 'red', 'green', 'pink', 'purple', 'yellow', 'orange', 'bronze', 'graphite', 'sierra', 'alpine', 'starlight', 'midnight'];
const detectItemCondition = (title) => { const lowerCaseTitle = title.toLowerCase(); return REFURBISHED_KEYWORDS.some(keyword => lowerCaseTitle.includes(keyword)) ? 'Refurbished' : 'New'; };
const detectSearchIntent = (query) => { const queryLower = query.toLowerCase(); return COMPONENT_KEYWORDS.some(keyword => queryLower.includes(keyword)); };
const extractColorFromTitle = (title) => { const titleLower = title.toLowerCase(); for (const color of COLOR_LIST) { if (titleLower.includes(color)) return color; } return null; };

// ### FIXED: This function is now extremely simple because the scraper sends clean data ###
function parsePythonResults(results) {
    return results.map(item => {
        const price = item.price_string ? parseFloat(item.price_string.replace(/[^0-9.]/g, '')) : null;
        if (!price || !item.store || !item.title) return null;
        return {
            title: item.title,
            price: price,
            price_string: item.price_string,
            store: item.store,
            url: item.url || '#'
        };
    }).filter(Boolean);
}

function parsePriceApiResults(downloadedJobs) { let allResults = []; for (const jobData of downloadedJobs) { if (!jobData || !jobData.results || jobData.results.length === 0) continue; const sourceName = jobData.source || 'API Source'; const topic = jobData.topic; const jobResult = jobData.results[0]; let mapped = []; if (topic === 'product_and_offers' && jobResult.content) { const content = jobResult.content; const offer = content.buybox; if (content.name && offer && offer.min_price) { mapped.push({ title: content.name, price: parseFloat(offer.min_price), price_string: offer.min_price ? `$${parseFloat(offer.min_price).toFixed(2)}` : 'N/A', url: content.url, image: content.image_url, store: offer.shop_name || sourceName }); } } else if (topic === 'search_results' && jobResult.content?.search_results) { const searchResults = jobResult.content.search_results; mapped = searchResults.map(item => { let price = null; let price_string = 'N/A'; if (item.price) { price = parseFloat(item.price); price_string = item.price_string || `$${parseFloat(item.price).toFixed(2)}`; } else if (item.min_price) { price = parseFloat(item.min_price); price_string = `From $${price.toFixed(2)}`; } if (item.name && price !== null) { return { title: item.name, price: price, price_string: price_string, url: item.url, image: item.img_url, store: item.shop_name || sourceName }; } return null; }).filter(Boolean); } allResults = allResults.concat(mapped); } return allResults; }
function filterPriceOutliers(results) { if (results.length < 5) return results; const sortedResults = [...results].sort((a, b) => a.price - b.price); let cutOffIndex = 0; const GAP_MULTIPLIER = 2.5; const MIN_PRICE_FOR_JUMP = 100; for (let i = 0; i < sortedResults.length - 1; i++) { const currentPrice = sortedResults[i].price; const nextPrice = sortedResults[i+1].price; if (nextPrice > currentPrice * GAP_MULTIPLIER && nextPrice > MIN_PRICE_FOR_JUMP) { cutOffIndex = i + 1; } } if (cutOffIndex > 0) { console.log(`[Price Outlier Filter] Discarding ${cutOffIndex} items cheaper than the main product cluster.`); return sortedResults.slice(cutOffIndex); } return sortedResults; }
function filterAndRankResults(results, query) { const queryLower = query.toLowerCase(); const queryWords = queryLower.split(' ').filter(w => w.length > 2 && isNaN(w)); if (queryWords.length === 0) return results; const requiredScore = queryWords.length > 1 ? 2 : 1; const filtered = results.filter(item => { const titleLower = item.title.toLowerCase(); let score = 0; queryWords.forEach(word => { if (titleLower.includes(word)) { score++; } }); return score >= requiredScore; }); console.log(`[Relevance Filter] Kept ${filtered.length}/${results.length} results that matched at least ${requiredScore} query terms.`); return filtered; }
async function searchPriceApiCom(query) { try { const negative_keywords = ['case', 'protector', 'strap', 'charger', 'band', 'replacement', 'film', 'glass', 'cover']; const jobsToSubmit = [ { source: 'amazon', country: 'au', topic: 'product_and_offers', key: 'term', values: query }, { source: 'ebay', country: 'au', topic: 'search_results', key: 'term', values: query, condition: 'any' }, { source: 'google_shopping', country: 'au', topic: 'search_results', key: 'term', values: query, condition: 'any', negative_keywords: negative_keywords.join(',') } ]; const jobPromises = jobsToSubmit.map(job => axios.post('https://api.priceapi.com/v2/jobs', { token: PRICEAPI_COM_KEY, ...job }).then(res => ({ ...res.data, source: job.source, topic: job.topic })).catch(err => { console.error(`Failed to submit job for source: ${job.source}`, err.response?.data?.message || err.message); return null; }) ); const jobResponses = (await Promise.all(jobPromises)).filter(Boolean); if (jobResponses.length === 0) return []; console.log(`[Backup API] Created ${jobResponses.length} jobs for "${query}". Waiting 15s...`); await wait(15000); const resultPromises = jobResponses.map(job => axios.get(`https://api.priceapi.com/v2/jobs/${job.job_id}/download.json`, { params: { token: PRICEAPI_COM_KEY } }).then(res => ({ ...res.data, source: job.source, topic: job.topic })).catch(err => { console.error(`Failed to fetch results for job ID ${job.job_id}`, err.response?.data?.message || err.message); return null; }) ); return (await Promise.all(resultPromises)).filter(Boolean); } catch (err) { console.error("A critical error occurred in the searchPriceApiCom function:", err.message); return []; } }
async function fetchImageForQuery(query) { const cacheKey = query.toLowerCase(); if (imageCache.has(cacheKey)) { return imageCache.get(cacheKey); } const placeholder = 'https://via.placeholder.com/150/E2E8F0/A0AEC0?text=Image+N/A'; if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) { return placeholder; } try { const response = await limit(() => { const url = `https://www.googleapis.com/customsearch/v1`; const params = { key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q: query, searchType: 'image', num: 1 }; return axios.get(url, { params }); }); const imageUrl = response.data.items?.
