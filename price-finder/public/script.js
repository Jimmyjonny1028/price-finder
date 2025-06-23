// public/script.js (FINAL)

// --- Element Selection ---
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const searchButton = document.getElementById('search-button');
const resultsContainer = document.getElementById('results-container');
const loader = document.getElementById('loader');
const loaderText = document.querySelector('#loader p');
const controlsContainer = document.getElementById('controls-container');
const sortSelect = document.getElementById('sort-select');
const conditionFilterSelect = document.getElementById('condition-filter-select');
const storeFilterButton = document.getElementById('store-filter-button');
const storeFilterPanel = document.getElementById('store-filter-panel');
const storeFilterList = document.getElementById('store-filter-list');
const storeSelectAllButton = document.getElementById('store-select-all-button');
const storeUnselectAllButton = document.getElementById('store-unselect-all-button');

// --- Global State ---
let fullResults = [];
let availableStores = [];
let selectedStores = new Set();
let loadingInterval;
const loadingMessages = [ "Contacting local scraper...", "Searching Google Shopping & eBay...", "Checking Amazon & other major retailers...", "Analyzing search results...", "Compiling all the deals...", "This may take a minute...", "Almost finished..." ];
const sessionID = Date.now().toString(36) + Math.random().toString(36).substring(2); // ### NEW: Unique ID for this browser session

// --- Main Event Listeners ---
searchForm.addEventListener('submit', handleSearch);
sortSelect.addEventListener('change', applyFiltersAndSort);
conditionFilterSelect.addEventListener('change', applyFiltersAndSort);
storeFilterButton.addEventListener('click', () => { storeFilterPanel.classList.toggle('hidden'); });
storeSelectAllButton.addEventListener('click', () => { updateAllCheckboxes(true); });
storeUnselectAllButton.addEventListener('click', () => { updateAllCheckboxes(false); });
storeFilterList.addEventListener('change', (event) => { if (event.target.type === 'checkbox') { const store = event.target.dataset.store; if (event.target.checked) { selectedStores.add(store); } else { selectedStores.delete(store); } updateStoreFilterButtonText(); applyFiltersAndSort(); } });
document.addEventListener('click', (event) => { if (!storeFilterButton.contains(event.target) && !storeFilterPanel.contains(event.target)) { storeFilterPanel.classList.add('hidden'); } });

// --- Core Application Logic ---
async function handleSearch(event) { event.preventDefault(); const searchTerm = searchInput.value.trim(); if (!searchTerm) { resultsContainer.innerHTML = '<p>Please enter a product to search for.</p>'; return; } searchButton.disabled = true; controlsContainer.style.display = 'none'; resultsContainer.innerHTML = ''; let messageIndex = 0; loaderText.textContent = loadingMessages[messageIndex]; loader.classList.remove('hidden'); loader.classList.remove('polling'); loadingInterval = setInterval(() => { messageIndex = (messageIndex + 1) % loadingMessages.length; loaderText.textContent = loadingMessages[messageIndex]; }, 5000); try { const response = await fetch(`/search?query=${encodeURIComponent(searchTerm)}`); if (!response.ok) { const errorData = await response.json(); throw new Error(errorData.error || `Server returned an error: ${response.statusText}`); } if (response.status === 202) { loader.classList.add('polling'); pollForResults(searchTerm); return; } const results = await response.json(); if (results.length > 0) { fullResults = results; populateAndShowControls(); applyFiltersAndSort(); } else { resultsContainer.innerHTML = `<p>No cached results found.</p>`; } } catch (error) { console.error("Failed to fetch data:", error); resultsContainer.innerHTML = `<p class="error">An error occurred: ${error.message}</p>`; } finally { if (!loader.classList.contains('polling')) { searchButton.disabled = false; loader.classList.add('hidden'); clearInterval(loadingInterval); } } }
function pollForResults(query, attempt = 1) { const maxAttempts = 60; const interval = 5000; if (attempt > maxAttempts) { loader.classList.remove('polling'); loader.classList.add('hidden'); resultsContainer.innerHTML = `<p class="error">The search took too long. Please check your local scraper and backup API, then try again.</p>`; searchButton.disabled = false; clearInterval(loadingInterval); return; } fetch(`/results/${encodeURIComponent(query)}`).then(res => { if (res.status === 200) return res.json(); if (res.status === 202) { setTimeout(() => pollForResults(query, attempt + 1), interval); return null; } throw new Error('Server returned an error during polling.'); }).then(results => { if (results) { console.log("Polling successful. Found results."); loader.classList.remove('polling'); loader.classList.add('hidden'); searchButton.disabled = false; clearInterval(loadingInterval); fullResults = results; if (fullResults.length === 0) { resultsContainer.innerHTML = `<p>The scraper and backup API found no matching results for "${query}".</p>`; } else { populateAndShowControls(); applyFiltersAndSort(); } } }).catch(error => { console.error("Polling failed:", error); loader.classList.remove('polling'); loader.classList.add('hidden'); resultsContainer.innerHTML = `<p class="error">An error occurred while checking for results.</p>`; searchButton.disabled = false; clearInterval(loadingInterval); }); }
function applyFiltersAndSort() { const sortBy = sortSelect.value; const conditionFilter = conditionFilterSelect.value; let processedResults = [...fullResults]; if (conditionFilter === 'new') { processedResults = processedResults.filter(item => item.condition === 'New'); } else if (conditionFilter === 'refurbished') { processedResults = processedResults.filter(item => item.condition === 'Refurbished'); } if (selectedStores.size > 0 && selectedStores.size < availableStores.length) { processedResults = processedResults.filter(item => selectedStores.has(item.store)); } if (sortBy === 'price-asc') { processedResults.sort((a, b) => a.price - b.price); } else if (sortBy === 'price-desc') { processedResults.sort((a, b) => b.price - a.price); } renderResults(processedResults); }
function populateAndShowControls() { sortSelect.value = 'price-asc'; conditionFilterSelect.value = 'all'; availableStores = [...new Set(fullResults.map(item => item.store))].sort(); storeFilterList.innerHTML = ''; selectedStores.clear(); availableStores.forEach(store => { const li = document.createElement('li'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = `store-${store}`; checkbox.dataset.store = store; checkbox.checked = true; const label = document.createElement('label'); label.htmlFor = `store-${store}`; label.textContent = store; li.appendChild(checkbox); li.appendChild(label); storeFilterList.appendChild(li); selectedStores.add(store); }); updateStoreFilterButtonText(); controlsContainer.style.display = 'flex'; }
function updateStoreFilterButtonText() { if (selectedStores.size === availableStores.length) { storeFilterButton.textContent = 'All Stores'; } else if (selectedStores.size === 0) { storeFilterButton.textContent = 'No Stores Selected'; } else if (selectedStores.size === 1) { storeFilterButton.textContent = `${selectedStores.values().next().value}`; } else { storeFilterButton.textContent = `${selectedStores.size} Stores Selected`; } }
function updateAllCheckboxes(checked) { document.querySelectorAll('#store-filter-list input[type="checkbox"]').forEach(cb => { cb.checked = checked; if (checked) { selectedStores.add(cb.dataset.store); } else { selectedStores.clear(); } }); updateStoreFilterButtonText(); applyFiltersAndSort(); }
function renderResults(results) { resultsContainer.innerHTML = `<h2>Best Prices for ${searchInput.value.trim()}</h2>`; if (results.length === 0) { resultsContainer.innerHTML += `<p>No results match the current filters.</p>`; return; } results.forEach(offer => { const card = document.createElement('div'); card.className = 'result-card'; const isLinkValid = offer.url && offer.url !== '#'; const linkAttributes = isLinkValid ? `href="${offer.url}" target="_blank" rel="noopener noreferrer"` : `href="#" class="disabled-link"`; const conditionBadge = offer.condition === 'Refurbished' ? `<span class="condition-badge">Refurbished</span>` : ''; card.innerHTML = ` <div class="result-image"> <img src="${offer.image}" alt="${offer.title}" onerror="this.style.display='none';"> </div> <div class="result-info"> <h3>${offer.title}</h3> <p>Sold by: <strong>${offer.store}</strong> ${conditionBadge}</p> </div> <div class="result-price"> <a ${linkAttributes}> ${offer.price_string} </a> </div> `; resultsContainer.appendChild(card); }); }

// --- "Fun" and Utility Features ---
function makeItRain() { const rainContainer = document.body; for (let i = 0; i < 40; i++) { const money = document.createElement('span'); money.textContent = '💰'; money.style.position = 'fixed'; money.style.top = `${Math.random() * -20}vh`; money.style.left = `${Math.random() * 100}vw`; money.style.fontSize = `${Math.random() * 2 + 1}rem`; money.style.zIndex = '9999'; money.style.transition = 'top 2s ease-in, transform 2s ease-in-out'; money.style.pointerEvents = 'none'; rainContainer.appendChild(money); setTimeout(() => { money.style.top = '110vh'; money.style.transform = `rotate(${Math.random() * 720}deg)`; }, 10); setTimeout(() => { money.remove(); }, 2100); } }

// ### NEW: Heartbeat function to keep user session alive ###
async function sendHeartbeat() {
    try {
        await fetch('/api/ping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionID: sessionID })
        });
    } catch (error) {
        // We don't need to show an error if a ping fails
        console.error('Heartbeat failed.', error);
    }
}

let currentLocalTheme = 'default';
async function pollForThemeChanges() { try { const response = await fetch('/api/get-theme'); const data = await response.json(); if (data.theme && data.theme !== currentLocalTheme) { console.log(`Applying new global theme: ${data.theme}`); document.body.className = `theme-${data.theme}`; currentLocalTheme = data.theme; } } catch (error) { console.error('Failed to poll for theme:', error); } }

// Initial calls on page load
sendHeartbeat();
pollForThemeChanges();
// Set up recurring tasks
setInterval(sendHeartbeat, 30000); // Send a ping every 30 seconds
setInterval(pollForThemeChanges, 20000); 


// --- ADMIN PANEL LOGIC ---
const adminButton = document.getElementById('admin-button');
const adminPanel = document.getElementById('admin-panel');
const closeAdminPanel = document.getElementById('close-admin-panel');
let currentAdminCode = null;
const totalSearchesEl = document.getElementById('total-searches');
const uniqueVisitorsEl = document.getElementById('unique-visitors');
const usersOnlineEl = document.getElementById('users-online'); // ### NEW: Select the online users element
const searchHistoryListEl = document.getElementById('search-history-list');
const maintenanceStatusEl = document.getElementById('maintenance-status');
const workerStatusEl = document.getElementById('worker-status');
const activeJobsCountEl = document.getElementById('active-jobs-count');
const activeJobsListEl = document.getElementById('active-jobs-list');
const jobQueueCountEl = document.getElementById('job-queue-count');
const jobQueueListEl = document.getElementById('job-queue-list');
const queueStatusEl = document.getElementById('queue-status');
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
const makeItRainButton = document.getElementById('make-it-rain-button');
const currentThemeDisplay = document.getElementById('current-theme-display');

adminButton.addEventListener('click', () => { const code = prompt("Please enter the admin code:"); if (code) { fetchAdminData(code); } });
closeAdminPanel.addEventListener('click', () => { adminPanel.style.display = 'none'; });
adminPanel.addEventListener('click', (event) => { if (event.target === adminPanel) { adminPanel.style.display = 'none'; } });
toggleMaintenanceButton.addEventListener('click', () => performAdminAction('/admin/toggle-maintenance', 'toggle maintenance'));
clearFullCacheButton.addEventListener('click', () => clearCache(true));
singleCacheClearForm.addEventListener('submit', (e) => { e.preventDefault(); clearCache(false); });
toggleQueueButton.addEventListener('click', () => performAdminAction('/admin/toggle-queue', 'toggle queue'));
disconnectWorkerButton.addEventListener('click', () => performAdminAction('/admin/disconnect-worker', 'disconnect worker', 'Are you sure you want to disconnect the worker?'));
clearQueueButton.addEventListener('click', () => performAdminAction('/admin/clear-queue', 'clear queue', 'Are you sure you want to clear the entire job queue?'));
clearImageCacheButton.addEventListener('click', () => performAdminAction('/admin/clear-image-cache', 'clear image cache', 'Are you sure you want to clear the permanent image cache?'));
clearStatsButton.addEventListener('click', () => performAdminAction('/admin/clear-stats', 'clear stats', 'Are you sure you want to clear ALL traffic stats and search history?'));
makeItRainButton.addEventListener('click', makeItRain);
document.getElementById('theme-controls').addEventListener('click', (event) => { if (event.target.classList.contains('theme-button')) { const theme = event.target.dataset.theme; setTheme(theme); } });

async function fetchAdminData(code) { currentAdminCode = code; try { const response = await fetch('/admin/traffic-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }), }); if (!response.ok) { alert('Incorrect code.'); return; } const data = await response.json(); workerStatusEl.textContent = data.workerStatus; workerStatusEl.className = data.workerStatus === 'Connected' ? 'enabled' : 'disabled'; updateQueueStatus(data.isQueuePaused); jobQueueCountEl.textContent = data.jobQueue.length; jobQueueListEl.innerHTML = ''; if (data.jobQueue.length > 0) { data.jobQueue.forEach(job => { const li = document.createElement('li'); li.textContent = `"${job}"`; jobQueueListEl.appendChild(li); }); } else { jobQueueListEl.innerHTML = '<li>Queue is empty.</li>'; } activeJobsCountEl.textContent = data.activeJobs.length; activeJobsListEl.innerHTML = ''; if (data.activeJobs.length > 0) { data.activeJobs.forEach(job => { const li = document.createElement('li'); li.textContent = `"${job}"`; activeJobsListEl.appendChild(li); }); } else { activeJobsListEl.innerHTML = '<li>No active jobs.</li>'; } imageCacheSizeEl.textContent = data.imageCacheSize; updateMaintenanceStatus(data.isServiceDisabled); totalSearchesEl.textContent = data.totalSearches; uniqueVisitorsEl.textContent = data.uniqueVisitors; usersOnlineEl.textContent = data.onlineUsers; searchHistoryListEl.innerHTML = ''; if (data.searchHistory.length > 0) { data.searchHistory.forEach(item => { const li = document.createElement('li'); const timestamp = new Date(item.timestamp).toLocaleString(); li.textContent = `"${item.query}" at ${timestamp}`; searchHistoryListEl.appendChild(li); }); } else { searchHistoryListEl.innerHTML = '<li>No searches recorded yet.</li>'; } currentThemeDisplay.textContent = data.currentTheme.charAt(0).toUpperCase() + data.currentTheme.slice(1); adminPanel.style.display = 'flex'; } catch (error) { console.error("Error fetching admin data:", error); alert("An error occurred while fetching stats."); } }
async function performAdminAction(url, actionName, confirmation = null, body = {}) { if (!currentAdminCode) { alert("Please open the admin panel with a valid code first."); return; } if (confirmation && !confirm(confirmation)) return; try { const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: currentAdminCode, ...body }), }); const data = await response.json(); if (!response.ok) throw new Error(data.message || `Failed to ${actionName}.`); alert(data.message); fetchAdminData(currentAdminCode); } catch (error) { console.error(`Error during ${actionName}:`, error); alert(`An error occurred: ${error.message}`); } }
async function setTheme(themeName) { await performAdminAction('/admin/set-theme', 'set theme', null, { theme: themeName }); pollForThemeChanges(); }
async function clearCache(isFullClear) { const queryToClear = singleCacheInput.value.trim(); if (!isFullClear && !queryToClear) { alert("Please enter a query to clear."); return; } const confirmation = isFullClear ? "Are you sure you want to clear the entire search cache?" : null; if (confirmation && !confirm(confirmation)) return; try { const response = await fetch('/admin/clear-cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: currentAdminCode, query: isFullClear ? null : queryToClear }), }); const data = await response.json(); if (!response.ok) throw new Error(data.message); alert(data.message); if (!isFullClear) singleCacheInput.value = ''; fetchAdminData(currentAdminCode); } catch (error) { console.error("Error clearing cache:", error); alert(`An error occurred: ${error.message}`); } }
function updateMaintenanceStatus(isDisabled) { if (isDisabled) { maintenanceStatusEl.textContent = 'DISABLED'; maintenanceStatusEl.className = 'disabled'; } else { maintenanceStatusEl.textContent = 'ENABLED'; maintenanceStatusEl.className = 'enabled'; } }
function updateQueueStatus(isPaused) { if (isPaused) { queueStatusEl.textContent = 'PAUSED'; queueStatusEl.className = 'disabled'; } else { queueStatusEl.textContent = 'RUNNING'; queueStatusEl.className = 'enabled'; } }
