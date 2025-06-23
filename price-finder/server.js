// server.js (FINAL VERSION - PriceAPI.com EXCLUSIVE)

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.static('public'));

// We only need the key for PriceAPI.com in this version
const PRICEAPI_COM_KEY = process.env.PRICEAPI_COM_KEY;

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const filterResultsByQuery = (results, query) => {
    const queryKeywords = query.toLowerCase().split(' ').filter(word => word.length > 1 && isNaN(word));
    if (queryKeywords.length === 0) return results;
    return results.filter(item => item.title.toLowerCase().includes(queryKeywords.join(' ')));
};

const filterForIrrelevantAccessories = (results) => {
    const negativeKeywords = [
        'strap', 'band', 'protector', 'case', 'charger', 'cable', 
        'stand', 'dock', 'adapter', 'film', 'glass', 'cover', 'guide'
    ];
    return results.filter(item => {
        const itemTitle = item.title.toLowerCase();
        return !negativeKeywords.some(keyword => itemTitle.includes(keyword));
    });
};

app.get('/search', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: 'Search query is required' });

    console.log(`Starting PriceAPI.com search for: ${query}`);
    try {
        // We now for: ${query}`);
    try {
        // We now only call the one powerful function
        const allResults = await searchPriceApiCom(query);
        console.log(`Received ${allResults.length} initial results from PriceAPI.com.`);

        const relevantResults = filterForIrrelevantAccessories(allResults);
        console.log(`Kept ${relevantResults.length} results after accessory filtering.`);
        
        const filteredResults = filterResultsByQuery(relevantResults, query);
        console.log(`Kept ${filteredResults.length} results after keyword filtering.`);

        const validResults = filteredResults.filter(item => item.price !== null && !isNaN(item.price));
        console.log(`Found ${validResults.length} valid, sorted offers.`);

        const sortedResults = validResults.sort((a, b) => a.price - b.price);

        res.json(sortedResults);
    } catch (error) {
        console.error("Error in the main search handler:", error);
        res.status(500).json({ error: 'Failed to fetch data from APIs' });
    }
});

// The searchPricerAPI function has been removed.

async function searchPriceApiCom(query) {
    let allResults = [];
    try {
        const jobsToSubmit = [
            { source: 'amazon', topic: 'product_and_offers', key: 'term', values: query },
            { source: 'ebay', topic: 'search_results', key: 'term', values: query },
            { source: 'google_shopping', topic: 'search_results', key: 'term', values: query }
        ];

        console.log(`Submitting ${jobsToSubmit.length} jobs to PriceAPI.com...`);
        const jobPromises = jobsToSubmit.map(job =>
            axios.post('https://api.priceapi.com/v2/jobs', { token: PRICEAPI_COM_KEY, country: 'au', max_pages: 1, ...job })
            .then(res => ({ ...res.data, source: job.source, topic: job.topic }))
            .catch(err => {
                console.error(`Failed to submit job for source: ${job.source}`, err.response?.data?.message || err.message);
                return null;
            })
        );
        
        const jobResponses = (await Promise.all(jobPromises)).filter(Boolean);
        if (jobResponses.length === 0) return [];
        
        console.log(`Jobs submitted. IDs: ${jobResponses.map(j => j.job_id).join(', ')}. Waiting...`);
        await wait(30000);

        console.log("Fetching results for completed jobs...");
        const resultPromises = jobResponses.map(job =>
            axios.get(`https://api.priceapi.com/v2/jobs/${job.job_id}/download.json`, { params: { token: PRICEAPI_COM_KEY } })
            .then(res => ({ ...res.data, source: job.source, topic: job.topic }))
            .catch(err => {
                console.error(`Failed to fetch results for job ID ${job.job_id} (${job.source})`, err.response?.data?.message || err.message);
                return null;
            })
        );

        const downloadedResults = (await Promise.all(resultPromises)).filter(Boolean);

        for (const data of downloadedResults) {
            let mapped = [];
            if (data.topic === 'product_and_offers') {
                const products = data.results?.[0]?.products || [];
                mapped = products.map(item => ({
                    source: `PriceAPI (${data.source})`,
                    title: item?.name || 'Title Not Found',
                    price: item?.price,
                    price_string: item?.offer?.price_string || (item?.price ? `$${item.price.toFixed(2)}` : 'N/A'),
                    url: item?.url || '#',
                    image: item?.image || 'https://via.placeholder.com/100',
                    store: item?.shop?.name || data.source
                }));
            } else if (data.topic === 'search_results') {
                const products = data.results || [];
                mapped = products.map(item => ({
                    source: `PriceAPI (${data.source})`,
                    title: item?.search_result?.name || 'Title Not Found',
                    price: parseFloat(item?.search_result?.min_price) || null,
                    price_string: item?.search_result?.min_price ? `$${item.search_result.min_price}` : 'N/A',
                    url: item?.search_result?.url || '#',
                    image: item?.search_result?.image_url || 'https://via.placeholder.com/100',
                    store: data.source
                }));
            }
            const validMapped = mapped.filter(item => item.title && item.price);
            allResults = allResults.concat(validMapped);
        }
        console.log(`Retrieved ${allResults.length} valid results from PriceAPI.com sources.`);
        return allResults;

    } catch (err) {
        console.error("A critical error occurred in the searchPriceApiCom function:", err.message);
        return [];
    }
}

app.listen(PORT, () => {
    console.log(`Server is running! Open your browser to http://localhost:${PORT}`);
});k
