// public/script.js (FINAL - With Silent Polling)

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
const loadingMessages = [ "Sending request to your personal scraper...", "Searching Google Shopping & eBay...", "Checking Amazon & other major retailers...", "Analyzing search results...", "Compiling all the deals...", "This may take a minute...", "Almost finished..." ];

searchForm.addEventListener('submit', handleSearch);
sortSelect.addEventListener('change', applyFiltersAndSort);
storeFilterSelect.addEventListener('change', applyFiltersAndSort);
conditionFilterSelect.addEventListener('change', applyFiltersAndSort);

async function handleSearch(event) {
    event.preventDefault();
    const searchTerm = searchInput.value.trim();
    if (!searchTerm) { resultsContainer.innerHTML = '<p>Please enter a product to search for.</p>'; return; }
    searchButton.disabled = true;
    controlsContainer.style.display = 'none';
    resultsContainer.innerHTML = '';
    let messageIndex = 0;
    loaderText.textContent = loadingMessages[messageIndex];
    loader.classList.remove('hidden');
    loader.classList.remove('polling');
    // The loading message will now cycle continuously until results are found.
    loadingInterval = setInterval(() => { messageIndex = (messageIndex + 1) % loadingMessages.length; loaderText.textContent = loadingMessages[messageIndex]; }, 5000);
    try {
        const response = await fetch(`/search?query=${encodeURIComponent(searchTerm)}`);
        if (!response.ok) { const errorData = await response.json(); throw new Error(errorData.error || `Server returned an error: ${response.statusText}`); }
        if (response.status === 202) {
            loader.classList.add('polling');
            pollForResults(searchTerm); return;
        }
        const results = await response.json();
        if (results.length > 0) { fullResults = results; populateAndShowControls(); applyFiltersAndSort(); }
        else { resultsContainer.innerHTML = `<p>No cached results found. Please ensure your local scraper is running and try again.</p>`; }
    } catch (error) { console.error("Failed to fetch data:", error); resultsContainer.innerHTML = `<p class="error">An error occurred: ${error.message}</p>`;
    } finally { if (!loader.classList.contains('polling')) { searchButton.disabled = false; loader.classList.add('hidden'); clearInterval(loadingInterval); } }
}

function pollForResults(query, attempt = 1) {
    const maxAttempts = 60; const interval = 5000;
    if (attempt > maxAttempts) { loader.classList.remove('polling'); loader.classList.add('hidden'); resultsContainer.innerHTML = `<p class="error">The search took too long. Please check your local scraper and backup API, then try again.</p>`; searchButton.disabled = false; clearInterval(loadingInterval); return; }
    
    fetch(`/results/${encodeURIComponent(query)}`)
        .then(res => {
            if (res.status === 200) { return res.json(); } // Success
            
            // MODIFICATION: Simplified logic for "Still working"
            if (res.status === 202) {
                console.log(`Attempt ${attempt}: Results not ready, checking again in ${interval}ms.`); 
                setTimeout(() => pollForResults(query, attempt + 1), interval);
                return null; // Stop the promise chain
            }
            throw new Error('Server returned an error during polling.');
        })
        .then(results => {
            if (results) {
                console.log("Polling successful. Found results.");
                loader.classList.remove('polling'); loader.classList.add('hidden'); searchButton.disabled = false; clearInterval(loadingInterval);
                fullResults = results;
                if (fullResults.length === 0) { resultsContainer.innerHTML = `<p>The scraper and backup API found no matching results for "${query}".</p>`; }
                else { populateAndShowControls(); applyFiltersAndSort(); }
            }
        })
        .catch(error => { console.error("Polling failed:", error); loader.classList.remove('polling'); loader.classList.add('hidden'); resultsContainer.innerHTML = `<p class="error">An error occurred while checking for results.</p>`; searchButton.disabled = false; clearInterval(loadingInterval); });
}

function applyFiltersAndSort() { const sortBy = sortSelect.value; const storeFilter = storeFilterSelect.value; const conditionFilter = conditionFilterSelect.value; let processedResults = [...fullResults]; if (conditionFilter === 'new') { processedResults = processedResults.filter(item => item.condition === 'New'); } else if (conditionFilter === 'refurbished') { processedResults = processedResults.filter(item => item.condition === 'Refurbished'); } if (storeFilter !== 'all') { processedResults = processedResults.filter(item => item.store === storeFilter); } if (sortBy === 'price-asc') { processedResults.sort((a, b) => a.price - b.price); } else if (sortBy === 'price-desc') { processedResults.sort((a, b) => b.price - a.price); } renderResults(processedResults); }
function populateAndShowControls() { sortSelect.value = 'price-asc'; storeFilterSelect.innerHTML = '<option value="all">All Stores</option>'; conditionFilterSelect.value = 'all'; const stores = [...new Set(fullResults.map(item => item.store))].sort(); stores.forEach(store => { const option = document.createElement('option'); option.value = store; option.textContent = store; storeFilterSelect.appendChild(option); }); controlsContainer.style.display = 'flex'; }
function renderResults(results) { resultsContainer.innerHTML = `<h2>Best Prices for ${searchInput.value.trim()}</h2>`; if (results.length === 0) { resultsContainer.innerHTML += `<p>No results match the current filters.</p>`; return; } results.forEach(offer => { const card = document.createElement('div'); card.className = 'result-card'; const isLinkValid = offer.url && offer.url !== '#'; const linkAttributes = isLinkValid ? `href="${offer.url}" target="_blank" rel="noopener noreferrer"` : `href="#" class="disabled-link"`; const conditionBadge = offer.condition === 'Refurbished' ? `<span class="condition-badge">Refurbished</span>` : ''; card.innerHTML = ` <div class="result-image"> <img src="${offer.image}" alt="${offer.title}" onerror="this.style.display='none';"> </div> <div class="result-info"> <h3>${offer.title}</h3> <p>Sold by: <strong>${offer.store}</strong> ${conditionBadge}</p> </div> <div class="result-price"> <a ${linkAttributes}> ${offer.price_string} </a> </div> `; resultsContainer.appendChild(card); }); }
const adminButton = document.getElementById('admin-button'); const adminPanel = document.getElementById('admin-panel'); const closeAdminPanel = document.getElementById('close-admin-panel'); const totalSearchesEl = document.getElementById('total-searches'); const uniqueVisitorsEl = document.getElementById('unique-visitors'); const searchHistoryListEl = document.getElementById('search-history-list'); const toggleMaintenanceButton = document.getElementById('toggle-maintenance-button'); const maintenanceStatusEl = document.getElementById('maintenance-status'); let currentAdminCode = null;
adminButton.addEventListener('click', () => { const code = prompt("Please enter the admin code:"); if (code) { fetchAdminData(code); } }); closeAdminPanel.addEventListener('click', () => { adminPanel.style.display = 'none'; }); adminPanel.addEventListener('click', (event) => { if (event.target === adminPanel) { adminPanel.style.display = 'none'; } }); toggleMaintenanceButton.addEventListener('click', toggleMaintenanceMode); async function fetchAdminData(code) { currentAdminCode = code; try { const response = await fetch('/admin/traffic-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }), }); if (!response.ok) { alert('Incorrect code.'); return; } const data = await response.json(); totalSearchesEl.textContent = data.totalSearches; uniqueVisitorsEl.textContent = data.uniqueVisitors; updateMaintenanceStatus(data.isServiceDisabled); searchHistoryListEl.innerHTML = ''; if(data.searchHistory.length > 0) { data.searchHistory.forEach(item => { const li = document.createElement('li'); const timestamp = new Date(item.timestamp).toLocaleString(); li.textContent = `"${item.query}" at ${timestamp}`; searchHistoryListEl.appendChild(li); }); } else { searchHistoryListEl.innerHTML = '<li>No searches recorded yet.</li>'; } adminPanel.style.display = 'flex'; } catch (error) { console.error("Error fetching admin data:", error); alert("An error occurred while fetching stats."); } } async function toggleMaintenanceMode() { if (!currentAdminCode) { alert("Please open the admin panel with a valid code first."); return; } try { const response = await fetch('/admin/toggle-maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: currentAdminCode }), }); if (!response.ok) { throw new Error("Failed to toggle maintenance mode."); } const data = await response.json(); updateMaintenanceStatus(data.isServiceDisabled); alert(data.message); } catch (error) { console.error("Error toggling maintenance mode:", error); alert("An error occurred."); } } function updateMaintenanceStatus(isDisabled) { if (isDisabled) { maintenanceStatusEl.textContent = 'DISABLED'; maintenanceStatusEl.className = 'disabled'; } else { maintenanceStatusEl.textContent = 'ENABLED'; maintenanceStatusEl.className = 'enabled'; } }
