// server.js

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

async function updateLiveStateFile() {
    liveState.onlineUsers = onlineUserTimeouts.size;
    try {
        await fs.writeFile(LIVE_STATE_PATH, JSON.stringify(liveState, null, 2), 'utf8');
    } catch (error) {
        console.error('Error writing live state file:', error);
    }
}

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

const ADMIN_CODE = process.env.ADMIN_CODE;
const SERVER_SIDE_SECRET = process.env.SERVER_SIDE_SECRET;
const PRICEAPI_COM_KEY = process.env.PRICEAPI_COM_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

const jobQueue = [];
let workerSocket = null;
let workerActiveJobs = new Set();
const wss = new WebSocketServer({ server });

function dispatchJob() {
    if (isQueueProcessingPaused || !workerSocket || jobQueue.length === 0) return;
    const nextQuery = jobQueue.shift();
    workerSocket.send(JSON.stringify({ type: 'NEW_JOB', query: nextQuery }));
}

wss.on('connection', (ws, req) => {
    const parsedUrl = url.parse(req.url, true);
    const secret = parsedUrl.query.secret;
    if (secret !== SERVER_SIDE_SECRET) {
        ws.close();
        return;
    }
    console.log("✅ A concurrent worker has connected.");
    workerSocket = ws;
    workerActiveJobs.clear();

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'REQUEST_JOB') {
                dispatchJob();
            } else if (msg.type === 'JOB_STARTED') {
                workerActiveJobs.add(msg.query);
            } else if (msg.type === 'JOB_COMPLETE') {
                workerActiveJobs.delete(msg.query);
            }
        } catch (e) {
            console.error("Error parsing message from worker:", e);
        }
    });

    ws.on('close', () => {
        console.log("❌ The worker has disconnected.");
        workerSocket = null;
        workerActiveJobs.clear();
    });
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const ACCESSORY_KEYWORDS = ['strap', 'band', 'protector', 'case', 'charger', 'cable', 'stand', 'dock', 'adapter', 'film', 'glass', 'cover', 'guide', 'replacement', 'screen', 'magsafe', 'camera'];
const REFURBISHED_KEYWORDS = ['refurbished', 'renewed', 'pre-owned', 'preowned', 'used', 'open-box', 'as new'];
const COMPONENT_KEYWORDS = ['ssd', 'hdd', 'ram', 'memory', 'cooler', 'fan', 'power supply', 'psu', 'motherboard', 'cpu', 'processor', 'gpu', 'graphics card'];
const MAIN_PRODUCT_PRICE_THRESHOLD = 200;
const COLOR_LIST = ['black', 'white', 'silver', 'gold', 'gray', 'blue', 'red', 'green', 'pink', 'purple', 'yellow', 'orange', 'bronze', 'graphite', 'sierra', 'alpine', 'starlight', 'midnight'];

const detectItemCondition = (title) => {
    const lowerCaseTitle = title.toLowerCase();
    return REFURBISHED_KEYWORDS.some(keyword => lowerCaseTitle.includes(keyword)) ? 'Refurbished' : 'New';
};

const filterForIrrelevantAccessories = (results) => {
    return results.filter(item => !ACCESSORY_KEYWORDS.some(keyword => item.title.toLowerCase().includes(keyword)));
};

const filterForMainDevice = (results) => {
    const negativePhrases = ['for ', 'compatible with', 'fits '];
    return results.filter(item => !negativePhrases.some(phrase => item.title.toLowerCase().includes(phrase)));
};

function scoreRelevance(itemTitle, queryWords, queryNumbers) {
    let score = 0;
    const title = itemTitle.toLowerCase();

    for (const word of queryWords) {
        if (title.includes(word)) score += 2;
    }

    for (const num of queryNumbers) {
        if (title.includes(num)) score += 3;
    }

    if (title.includes(queryWords.join(' '))) score += 5;
    if (title.includes('for ') || title.includes('compatible with')) score -= 2;

    return score;
}

function filterResultsByQuery(results, query) {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(' ').filter(w => w.length > 1 && isNaN(w));
    const queryNumbers = queryLower.split(' ').filter(w => !isNaN(w) && w.length > 0);
    if (queryWords.length === 0 && queryNumbers.length === 0) return results;

    return results
        .map(item => ({
            ...item,
            _score: scoreRelevance(item.title, queryWords, queryNumbers)
        }))
        .filter(item => item._score > 0)
        .sort((a, b) => b._score - a._score)
        .map(({ _score, ...rest }) => rest);
}
