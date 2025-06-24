// public/script.js (FINAL, with static examples and banner fix)

// --- Element Selection (Complete) ---
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
const permanentMessageBanner = document.getElementById('permanent-message-banner');
const themeNotificationEl = document.getElementById('theme-notification');
const adminButton = document.getElementById('admin-button');
const adminPanel = document.getElementById('admin-panel');
const closeAdminPanel = document.getElementById('close-admin-panel');
const totalSearchesEl = document.getElementById('total-searches');
const uniqueVisitorsEl = document.getElementById('unique-visitors');
const usersOnlineEl = document.getElementById('users-online');
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
const topSearchesListEl = document.getElementById('top-searches-list');
const adminPermanentMessageForm = document.getElementById('permanent-message-form');
const adminPermanentMessageInput = document.getElementById('permanent-message-input');
const adminClearPermanentMessageButton = document.getElementById('clear-permanent-message-button');
const adminFlashMessageForm = document.getElementById('flash-message-form');
const adminFlashMessageInput = document.getElementById('flash-message-input');

// --- Global State ---
let fullResults = [];
let availableStores = [];
let selectedStores = new Set();
let loadingInterval;
const loadingMessages = [ "Contacting local scraper...", "Searching retailers...", "Analyzing search results...", "Compiling the best deals...", "This may take a minute...", "Almost finished..." ];
let currentLocalTheme = 'default';
let lastSeenRainEvent = 0;
let lastSeenFlashTimestamp = 0;
let notificationTimeout;
let currentAdminCode = null;

// --- Main Event Listeners ---
searchForm.addEventListener('submit', handleSearch);
resultsContainer.addEventListener('click', (event) => {
    if (event.target.classList.contains('example-link')) {
        event.preventDefault();
        searchInput.value = event.target.textContent;
        handleSearch(new Event('submit'));
    }
});
sortSelect.addEventListener('change', applyFiltersAndSort);
conditionFilterSelect.addEventListener('change', applyFiltersAndSort);
storeFilterButton.addEventListener('click', () => { storeFilterPanel.classList.toggle('hidden'); });
storeSelectAllButton.addEventListener('click', () => { updateAllCheckboxes(true); });
storeUnselectAllButton.addEventListener('click', () => { updateAllCheckboxes(false); });
storeFilterList.addEventListener('change', (event) => { if (event.target.type === 'checkbox') { const store = event.target.dataset.store; if (event.target.checked) { selectedStores.add(store); } else { selectedStores.delete(store); } updateStoreFilterButtonText(); applyFiltersAndSort(); } });
document.addEventListener('click', (event) => { if (!storeFilterButton.contains(event.target) && !storeFilterPanel.contains(event.target)) { storeFilterPanel.classList.add('hidden'); } });
adminButton.addEventListener('click', () => { const code = prompt("Please enter the admin code:"); if (code) { fetchAdminData(code); } });
closeAdminPanel.addEventListener('click', () => { adminPanel.style.display = 'none'; });
adminPanel.addEventListener('click', (event) => { if (event.target === adminPanel) { adminPanel.style.display = 'none'; } });

// --- Core Application Logic ---
function showGenericError() {
    const example1 = `<a href="#" class="example-link">Xbox Series X</a>`;
    const example2 = `<a href="#" class="example-link">Sony WH-1000XM5</a>`;
    resultsContainer.innerHTML = `<p>Sorry! Our database doesnt currently contain this product or a error has occured please try again later.<br><br>Maybe try a popular search like: ${example1} or ${example2}.</p>`;
}
async function handleSearch(event) {
    if (event) event.preventDefault();
    const searchTerm = searchInput.value.trim();
    if (!searchTerm) { resultsContainer.innerHTML = '<p>Please enter a product to search for.</p>'; return; }
    searchButton.disabled = true;
    controlsContainer.style.display = 'none';
    resultsContainer.innerHTML = '';
    let messageIndex = 0;
    loaderText.textContent = loadingMessages[messageIndex];
    loader.classList.remove('hidden');
    loader.classList.remove('polling');
    if (loadingInterval) clearInterval(loadingInterval);
    loadingInterval = setInterval(() => { messageIndex = (messageIndex + 1) % loadingMessages.length; loaderText.textContent = loadingMessages[messageIndex]; }, 5000);
    try {
        const response = await fetch(`/search?query=${encodeURIComponent(searchTerm)}`);
        if (!response.ok) { throw new Error('Server search request failed.'); }
        if (response.status === 202) {
            loader.classList.add('polling');
            pollForResults(searchTerm);
            return;
        }
        const data = await response.json();
        processResults(data, searchTerm);
    } catch (error) {
        console.error("Failed to fetch data:", error);
        showGenericError();
    } finally {
        if (!loader.classList.contains('polling')) {
            searchButton.disabled = false;
            loader.classList.add('hidden');
            clearInterval(loadingInterval);
        }
    }
}
function pollForResults(query, attempt = 1) {
    const maxAttempts = 60;
    const interval = 5000;
    if (attempt > maxAttempts) {
        loader.classList.remove('polling');
        loader.classList.add('hidden');
        showGenericError();
        searchButton.disabled = false;
        clearInterval(loadingInterval);
        return;
    }
    fetch(`/results/${encodeURIComponent(query)}`).then(res => {
        if (res.status === 200) return res.json();
        if (res.status === 202) { setTimeout(() => pollForResults(query, attempt + 1), interval); return null; }
        throw new Error('Server returned an error during polling.');
    }).then(data => {
        if (data) {
            console.log("Polling successful. Received final data object.");
            loader.classList.remove('polling');
            loader.classList.add('hidden');
            searchButton.disabled = false;
            clearInterval(loadingInterval);
            processResults(data, query);
        }
    }).catch(error => {
        console.error("Polling failed:", error);
        loader.classList.remove('polling');
        loader.classList.add('hidden');
        showGenericError();
        searchButton.disabled = false;
        clearInterval(loadingInterval);
    });
}
function processResults(data, query) {
    fullResults = data.results || [];
    if (fullResults.length === 0) {
        showGenericError();
    } else {
        populateAndShowControls();
        applyFiltersAndSort();
    }
}
function applyFiltersAndSort() { /* ... unchanged ... */ }
function populateAndShowControls() { /* ... unchanged ... */ }
function updateStoreFilterButtonText() { /* ... unchanged ... */ }
function updateAllCheckboxes(checked) { /* ... unchanged ... */ }
function renderResults(results) { /* ... unchanged ... */ }

// --- "Fun" and Real-time Features ---
function makeItRain() { /* ... unchanged ... */ }
function showFlashMessage(message, duration = 10000) { /* ... unchanged ... */ }
async function pollForLiveState() { /* ... unchanged ... */ }
function applyTheme(themeName, showNotification = false) { /* ... unchanged ... */ }
async function initializeState() { /* ... unchanged ... */ }
initializeState();

// --- ADMIN PANEL EVENT LISTENERS ---
adminPermanentMessageForm.addEventListener('submit', (e) => { e.preventDefault(); setPermanentMessage(adminPermanentMessageInput.value); });
adminClearPermanentMessageButton.addEventListener('click', clearPermanentMessage);
adminFlashMessageForm.addEventListener('submit', (e) => { e.preventDefault(); sendFlashMessage(adminFlashMessageInput.value); });
// ... all other admin listeners from previous versions

// --- ADMIN PANEL FUNCTIONS ---
async function fetchAdminData(code) { /* ... unchanged ... */ }
async function performAdminAction(url, actionName, confirmation = null, body = {}) { /* ... unchanged ... */ }
async function setTheme(themeName) { /* ... unchanged ... */ }
async function clearCache(isFullClear) { /* ... unchanged ... */ }
function updateMaintenanceStatus(isDisabled) { /* ... unchanged ... */ }
function updateQueueStatus(isPaused) { /* ... unchanged ... */ }
async function setPermanentMessage(message) { await performAdminAction('/admin/set-permanent-message', 'set permanent message', null, { message }); adminPermanentMessageInput.value = ""; }
async function clearPermanentMessage() { if (confirm("Are you sure you want to clear the permanent message?")) { await performAdminAction('/admin/clear-permanent-message', 'clear permanent message'); } }
async function sendFlashMessage(message) { if (!message.trim()) { alert("Please enter a message to send."); return; } await performAdminAction('/admin/flash-message', 'send flash message', null, { message }); adminFlashMessageInput.value = ""; }
