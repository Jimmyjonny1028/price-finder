// public/script.js (FINAL)

const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const searchButton = document.getElementById('search-button');
const resultsContainer = document.getElementById('results-container');
const loader = document.getElementById('loader');
const loaderText = document.querySelector('#loader p');
const controlsContainer = document.getElementById('controls-container');
const sortSelect = document.getElementById('sort-select');
const storeFilterSelect = document.getElementById('store-filter-select');
const conditionFilterSelect = document.getElementById('condition-filter-select');
let fullResults = [];
let loadingInterval;
const loadingMessages = [ "Contacting local scraper...", "Searching Google Shopping & eBay...", "Checking Amazon & other major retailers...", "Analyzing search results...", "Compiling all the deals...", "This may take a minute...", "Almost finished..." ];

searchForm.addEventListener('submit', handleSearch);
sortSelect.addEventListener('change', applyFiltersAndSort);
storeFilterSelect.addEventListener('change', applyFiltersAndSort);
conditionFilterSelect.addEventListener('change', applyFiltersAndSort);

async function handleSearch(event) { event.preventDefault(); const searchTerm = searchInput.value.trim(); if (!searchTerm) { resultsContainer.innerHTML = '<p>Please enter a product to search for.</p>'; return; } searchButton.disabled = true; controlsContainer.style.display = 'none'; resultsContainer.innerHTML = ''; let messageIndex = 0; loaderText.textContent = loadingMessages[messageIndex]; loader.classList.remove('hidden'); loader.classList.remove('polling'); loadingInterval = setInterval(() => { messageIndex = (messageIndex + 1) % loadingMessages.length; loaderText.textContent = loadingMessages[messageIndex]; }, 5000); try { const response = await fetch(`/search?query=${encodeURIComponent(searchTerm)}`); if (!response.ok) { const errorData = await response.json(); throw new Error(errorData.error || `Server returned an error: ${response.statusText}`); } if (response.status === 202) { loader.classList.add('polling'); pollForResults(searchTerm); return; } const results = await response.json(); if (results.length > 0) { fullResults = results; populateAndShowControls(); applyFiltersAndSort(); } else { resultsContainer.innerHTML = `<p>No cached results found.</p>`; } } catch (error) { console.error("Failed to fetch data:", error); resultsContainer.innerHTML = `<p class="error">An error occurred: ${error.message}</p>`; } finally { if (!loader.classList.contains('polling')) { searchButton.disabled = false; loader.classList.add('hidden'); clearInterval(loadingInterval); } } }
function pollForResults(query, attempt = 1) { const maxAttempts = 60; const interval = 5000; if (attempt > maxAttempts) { loader.classList.remove('polling'); loader.classList.add('hidden'); resultsContainer.innerHTML = `<p class="error">The search took too long. Please check your local scraper and backup API, then try again.</p>`; searchButton.disabled = false; clearInterval(loadingInterval); return; } fetch(`/results/${encodeURIComponent(query)}`).then(res => { if (res.status === 200) return res.json(); if (res.status === 202) { setTimeout(() => pollForResults(query, attempt + 1), interval); return null; } throw new Error('Server returned an error during polling.'); }).then(results => { if (results) { console.log("Polling successful. Found results."); loader.classList.remove('polling'); loader.classList.add('hidden'); searchButton.disabled = false; clearInterval(loadingInterval); fullResults = results; if (fullResults.length === 0) { resultsContainer.innerHTML = `<p>The scraper and backup API found no matching results for "${query}".</p>`; } else { populateAndShowControls(); applyFiltersAndSort(); } } }).catch(error => { console.error("Polling failed:", error); loader.classList.remove('polling'); loader.classList.add('hidden'); resultsContainer.innerHTML = `<p class="error">An error occurred while checking for results.</p>`; searchButton.disabled = false; clearInterval(loadingInterval); }); }
function applyFiltersAndSort() { const sortBy = sortSelect.value; const storeFilter = storeFilterSelect.value; const conditionFilter = conditionFilterSelect.value; let processedResults = [...fullResults]; if (conditionFilter === 'new') { processedResults = processedResults.filter(item => item.condition === 'New'); } else if (conditionFilter === 'refurbished') { processedResults = processedResults.filter(item => item.condition === 'Refurbished'); } if (storeFilter !== 'all') { processedResults = processedResults.filter(item => item.store === storeFilter); } if (sortBy === 'price-asc') { processedResults.sort((a, b) => a.price - b.price); } else if (sortBy === 'price-desc') { processedResults.sort((a, b) => b.price - a.price); } renderResults(processedResults); }
function populateAndShowControls() { sortSelect.value = 'price-asc'; storeFilterSelect.innerHTML = '<option value="all">All Stores</option>'; conditionFilterSelect.value = 'all'; const stores = [...new Set(fullResults.map(item => item.store))].sort(); stores.forEach(store => { const option = document.createElement('option'); option.value = store; option.textContent = store; storeFilterSelect.appendChild(option); }); controlsContainer.style.display = 'flex'; }
function renderResults(results) { resultsContainer.innerHTML = `<h2>Best Prices for ${searchInput.value.trim()}</h2>`; if (results.length === 0) { resultsContainer.innerHTML += `<p>No results match the current filters.</p>`; return; } results.forEach(offer => { const card = document.createElement('div'); card.className = 'result-card'; const isLinkValid = offer.url && offer.url !== '#'; const linkAttributes = isLinkValid ? `href="${offer.url}" target="_blank" rel="noopener noreferrer"` : `href="#" class="disabled-link"`; const conditionBadge = offer.condition === 'Refurbished' ? `<span class="condition-badge">Refurbished</span>` : ''; card.innerHTML = ` <div class="result-image"> <img src="${offer.image}" alt="${offer.title}" onerror="this.style.display='none';"> </div> <div class="result-info"> <h3>${offer.title}</h3> <p>Sold by: <strong>${offer.store}</strong> ${conditionBadge}</p> </div> <div class="result-price"> <a ${linkAttributes}> ${offer.price_string} </a> </div> `; resultsContainer.appendChild(card); }); }

// --- ADMIN PANEL LOGIC ---
const adminButton = document.getElementById('admin-button');
const adminPanel = document.getElementById('admin-panel');
const closeAdminPanel = document.getElementById('close-admin-panel');
let currentAdminCode = null;

// ### NEW: Many more admin elements selected ###
const totalSearchesEl = document.getElementById('total-searches');
const uniqueVisitorsEl = document.getElementById('unique-visitors');
const searchHistoryListEl = document.getElementById('search-history-list');
const maintenanceStatusEl = document.getElementById('maintenance-status');
const workerStatusEl = document.getElementById('worker-status');
const activeJobsCountEl = document.getElementById('active-jobs-count');
const activeJobsListEl = document.getElementById('active-jobs-list');
const jobQueueCountEl = document.getElementById('job-queue-count');
const jobQueueListEl = document.getElementById('job-queue-list');
const queueStatusEl = document.getElementById('queue-status');
const searchCacheSizeEl = document.getElementById('search-cache-size');
const imageCacheSizeEl = document.getElementById('image-cache-size');

const toggleMaintenanceButton = document.getElementById('toggle-maintenance-button');
const clearFullCacheButton = document.getElementById('clear-full-cache-button');
const singleCacheClearForm = document.getElementById('single-cache-clear-form');
const singleCacheInput = document.getElementById('single-cache-input');
const toggleQueueButton = document.getElementById('toggle-queue-button');
const disconnectWorkerButton = document.getElementById('disconnect-worker-button');
const clearQueueButton = document.getElementById('clear-queue-button');
const clearImageCacheButton = document.getElementById('clear-image-cache-button');
const clearStatsButton = document.getElementById('clear-stats-button');

// Event Listeners
adminButton.addEventListener('click', () => { const code = prompt("Please enter the admin code:"); if (code) { fetchAdminData(code); } });
closeAdminPanel.addEventListener('click', () => { adminPanel.style.display = 'none'; });
adminPanel.addEventListener('click', (event) => { if (event.target === adminPanel) { adminPanel.style.display = 'none'; } });
toggleMaintenanceButton.addEventListener('click', toggleMaintenanceMode);
clearFullCacheButton.addEventListener('click', () => clearCache(true));
singleCacheClearForm.addEventListener('submit', (e) => { e.preventDefault(); clearCache(false); });

// ### NEW: Event listeners for new admin powers ###
toggleQueueButton.addEventListener('click', toggleQueue);
disconnectWorkerButton.addEventListener('click', disconnectWorker);
clearQueueButton.addEventListener('click', clearQueue);
clearImageCacheButton.addEventListener('click', clearImageCache);
clearStatsButton.addEventListener('click', clearStats);


// ### MODIFIED: fetchAdminData now updates all the new UI elements ###
async function fetchAdminData(code) {
    currentAdminCode = code;
    try {
        const response = await fetch('/admin/traffic-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }), });
        if (!response.ok) { alert('Incorrect code.'); return; }
        const data = await response.json();
        
        // Status Section
        workerStatusEl.textContent = data.workerStatus;
        workerStatusEl.className = data.workerStatus === 'Connected' ? 'enabled' : 'disabled';
        updateQueueStatus(data.isQueuePaused);
        
        // Job Queue Section
        jobQueueCountEl.textContent = data.jobQueue.length;
        jobQueueListEl.innerHTML = '';
        if (data.jobQueue.length > 0) {
            data.jobQueue.forEach(job => {
                const li = document.createElement('li');
                li.textContent = `"${job}"`;
                jobQueueListEl.appendChild(li);
            });
        } else {
            jobQueueListEl.innerHTML = '<li>Queue is empty.</li>';
        }

        // Active Jobs Section
        activeJobsCountEl.textContent = data.activeJobs.length;
        activeJobsListEl.innerHTML = '';
        if (data.activeJobs.length > 0) {
            data.activeJobs.forEach(job => {
                const li = document.createElement('li');
                li.textContent = `"${job}"`;
                activeJobsListEl.appendChild(li);
            });
        } else {
            activeJobsListEl.innerHTML = '<li>No active jobs.</li>';
        }
        
        // Cache Section
        // Note: We don't get the full search cache content, just its size for performance.
        searchCacheSizeEl.textContent = 'N/A'; // Need a new endpoint if we want this live
        imageCacheSizeEl.textContent = data.imageCacheSize;

        // System Control Section
        updateMaintenanceStatus(data.isServiceDisabled);
        
        // Traffic Stats Section
        totalSearchesEl.textContent = data.totalSearches;
        uniqueVisitorsEl.textContent = data.uniqueVisitors;
        searchHistoryListEl.innerHTML = '';
        if (data.searchHistory.length > 0) {
            data.searchHistory.forEach(item => {
                const li = document.createElement('li');
                const timestamp = new Date(item.timestamp).toLocaleString();
                li.textContent = `"${item.query}" at ${timestamp}`;
                searchHistoryListEl.appendChild(li);
            });
        } else {
            searchHistoryListEl.innerHTML = '<li>No searches recorded yet.</li>';
        }
        
        adminPanel.style.display = 'flex';
    } catch (error) {
        console.error("Error fetching admin data:", error);
        alert("An error occurred while fetching stats.");
    }
}

// ### NEW: Functions for all the new admin powers ###
async function performAdminAction(url, actionName, confirmation = null) {
    if (!currentAdminCode) {
        alert("Please open the admin panel with a valid code first.");
        return;
    }
    if (confirmation && !confirm(confirmation)) return;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: currentAdminCode }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || `Failed to ${actionName}.`);
        alert(data.message);
        fetchAdminData(currentAdminCode); // Refresh data after action
    } catch (error) {
        console.error(`Error during ${actionName}:`, error);
        alert(`An error occurred: ${error.message}`);
    }
}

function toggleMaintenanceMode() { performAdminAction('/admin/toggle-maintenance', 'toggle maintenance'); }
function toggleQueue() { performAdminAction('/admin/toggle-queue', 'toggle queue'); }
function disconnectWorker() { performAdminAction('/admin/disconnect-worker', 'disconnect worker', 'Are you sure you want to disconnect the worker?'); }
function clearQueue() { performAdminAction('/admin/clear-queue', 'clear queue', 'Are you sure you want to clear the entire job queue?'); }
function clearImageCache() { performAdminAction('/admin/clear-image-cache', 'clear image cache', 'Are you sure you want to clear the permanent image cache?'); }
function clearStats() { performAdminAction('/admin/clear-stats', 'clear stats', 'Are you sure you want to clear ALL traffic stats and search history?'); }

async function clearCache(isFullClear) {
    const queryToClear = singleCacheInput.value.trim();
    if (!isFullClear && !queryToClear) {
        alert("Please enter a query to clear.");
        return;
    }
    const confirmation = isFullClear ? "Are you sure you want to clear the entire search cache?" : null;

    if (confirmation && !confirm(confirmation)) return;
    
    try {
        const response = await fetch('/admin/clear-cache', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: currentAdminCode, query: isFullClear ? null : queryToClear }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);
        alert(data.message);
        if (!isFullClear) singleCacheInput.value = '';
        fetchAdminData(currentAdminCode); // Refresh data
    } catch (error) {
        console.error("Error clearing cache:", error);
        alert(`An error occurred: ${error.message}`);
    }
}

// ### NEW: Helper functions to update status colors/text ###
function updateMaintenanceStatus(isDisabled) {
    if (isDisabled) {
        maintenanceStatusEl.textContent = 'DISABLED';
        maintenanceStatusEl.className = 'disabled';
    } else {
        maintenanceStatusEl.textContent = 'ENABLED';
        maintenanceStatusEl.className = 'enabled';
    }
}

function updateQueueStatus(isPaused) {
    if (isPaused) {
        queueStatusEl.textContent = 'PAUSED';
        queueStatusEl.className = 'disabled';
    } else {
        queueStatusEl.textContent = 'RUNNING';
        queueStatusEl.className = 'enabled';
    }
}
