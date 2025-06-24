import os
import time
import asyncio
from asyncio import Queue
import json
import requests
import undetected_chromedriver as uc
from bs4 import BeautifulSoup
from urllib.parse import quote_plus, urljoin, urlparse, parse_qs, unquote
from dotenv import load_dotenv
import websockets
import re
import shutil
import signal
import sys

load_dotenv()
RENDER_SERVER_URL = os.getenv("RENDER_SERVER_URL")
SERVER_SIDE_SECRET = os.getenv("SERVER_SIDE_SECRET")

# --- Configuration ---
MAX_CONCURRENT_JOBS = 3
MAX_CHROME_INSTANCES = 6
PAGES_TO_DOWNLOAD = 20
STAGGER_DELAY = 0.5
BASE_DOWNLOAD_FOLDER = 'scraped_jobs'

active_jobs = set()
driver_pool = Queue()
driver_processes = []

def slugify(value):
    # --- FIX: Clean quotes from the query to prevent filesystem errors ---
    value = value.replace('"', '')
    value = re.sub(r'[^\w\s-]', '', value).strip().lower()
    value = re.sub(r'[-\s]+', '-', value)
    return value

async def create_driver_pool():
    print(f"--- Creating a persistent pool of {MAX_CHROME_INSTANCES} browser instances... ---")
    for i in range(MAX_CHROME_INSTANCES):
        try:
            options = uc.ChromeOptions(); options.add_argument('--disable-blink-features=AutomationControlled'); options.add_argument('--no-sandbox'); options.add_argument('--disable-dev-shm-usage')
            driver = uc.Chrome(options=options, headless=True, use_subprocess=True)
            driver_processes.append(driver); await driver_pool.put(driver); print(f" > Instance {i+1}/{MAX_CHROME_INSTANCES} created.")
        except Exception as e: print(f"--- ERROR: Failed to create a driver instance: {e} ---")
    if not driver_pool.empty(): print("--- Browser pool created successfully. ---")

async def download_worker(query, page_num, query_folder_path):
    driver = await driver_pool.get()
    try:
        await asyncio.sleep(STAGGER_DELAY); encoded_query = quote_plus(query); start_value = ((page_num - 1) * 20) + 1; url = f"https://staticice.com.au/cgi-bin/search.cgi?q={encoded_query}&start={start_value}&links=20&showadres=1&pos=2"
        loop = asyncio.get_running_loop(); await loop.run_in_executor(None, driver.get, url); page_source = driver.page_source
        if "Description" in page_source and "Price" in page_source:
            file_path = os.path.join(query_folder_path, f"page_{page_num}.html");
            with open(file_path, 'w', encoding='utf-8') as f: f.write(page_source)
    except Exception as e: print(f"  > [{query}] ERROR on page {page_num}: {str(e).splitlines()[0]}")
    finally: await driver_pool.put(driver)

async def concurrent_download_phase(query, query_folder_path):
    print(f"--- [Job: {query}] PHASE 1: DOWNLOADING ---"); os.makedirs(query_folder_path, exist_ok=True)
    tasks = [asyncio.create_task(download_worker(query, page_num, query_folder_path)) for page_num in range(1, PAGES_TO_DOWNLOAD + 1)]
    await asyncio.gather(*tasks); print(f"--- [Job: {query}] Download phase complete. ---")

# --- MAJOR REWRITE: This function is now defensive and resilient to malformed rows ---
def parser_phase(query, query_folder_path):
    print(f"--- [Job: {query}] PHASE 2: Parsing with RESILIENT, STRUCTURED extraction ---")
    
    results = []
    seen_urls = set()
    staticice_base_url = "https://staticice.com.au"
    html_files = sorted([f for f in os.listdir(query_folder_path) if f.endswith('.html')])

    if not html_files:
        return []

    for file_name in html_files:
        file_path = os.path.join(query_folder_path, file_name)
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            soup = BeautifulSoup(f.read(), 'html.parser')

            for row in soup.find_all('tr', valign='top'):
                cells = row.find_all('td')
                if len(cells) < 2:
                    continue

                # --- Defensive Extraction Block ---
                try:
                    # 1. Safely extract Price and URL
                    price_cell = cells[0]
                    link_tag = price_cell.find('a')
                    if not link_tag: continue

                    price_string = link_tag.get_text(strip=True)
                    if not price_string or not price_string.startswith('$'): continue
                    
                    redirect_link_raw = link_tag.get('href')
                    if not redirect_link_raw: continue
                    
                    redirect_link_absolute = urljoin(staticice_base_url, redirect_link_raw)
                    final_url = redirect_link_absolute
                    try:
                        parsed_url_components = urlparse(redirect_link_absolute)
                        query_params = parse_qs(parsed_url_components.query)
                        if 'newurl' in query_params: final_url = unquote(query_params['newurl'][0])
                    except Exception: pass
                    
                    if final_url in seen_urls: continue
                    seen_urls.add(final_url)

                    # 2. Safely extract Title
                    desc_cell = cells[1]
                    title_node = desc_cell.contents[0] if desc_cell.contents else None
                    # Ensure the node exists and is a string before stripping
                    if not title_node or not hasattr(title_node, 'strip'): continue
                    title = title_node.strip().replace('...', '').strip()
                    if not title: continue # Skip if title is empty

                    # 3. Safely extract Store Name
                    store_font = desc_cell.find('font')
                    store = "Unknown Store"
                    if store_font:
                        # Extract text robustly and clean it up
                        store_text_raw = store_font.get_text(separator=' ', strip=True)
                        if store_text_raw:
                            store = store_text_raw.split('|')[0].split('(')[0].strip()

                    # 4. Assemble the final result
                    final_title_string = f"{store} {title} {price_string}"
                    results.append({"title": final_title_string, "url": final_url})

                except Exception as e:
                    # This will catch any unexpected error in a single row and allow the loop to continue
                    # print(f"  > Skipping a malformed row due to error: {e}")
                    continue

    print(f"--- [Job: {query}] Found {len(results)} valid, structured product listings.")
    return results

async def process_job(query, ws):
    if query in active_jobs: return
    active_jobs.add(query); await ws.send(json.dumps({"type": "JOB_STARTED", "query": query}))
    query_folder_path = None
    try:
        print(f"--- [STARTING] Job for: \"{query}\". Active jobs: {len(active_jobs)}/{MAX_CONCURRENT_JOBS} ---")
        slugified_query = slugify(query); query_folder_path = os.path.join(BASE_DOWNLOAD_FOLDER, slugified_query)
        await concurrent_download_phase(query, query_folder_path)
        loop = asyncio.get_running_loop()
        
        results_as_objects = await loop.run_in_executor(None, parser_phase, query, query_folder_path)

        print(f"--- [Job: {query}] Submitting {len(results_as_objects)} results to server...")
        payload = {"secret": SERVER_SIDE_SECRET, "query": query, "results": results_as_objects}
        await loop.run_in_executor(None, lambda: requests.post(f"{RENDER_SERVER_URL}/submit-results", json=payload, timeout=30))
    except Exception as e: print(f"--- [FATAL ERROR] Job for \"{query}\" failed: {e} ---")
    finally:
        if query_folder_path and os.path.exists(query_folder_path):
            try: shutil.rmtree(query_folder_path)
            except Exception as e: print(f"  > CLEANUP ERROR for '{query}': {e}")
        active_jobs.discard(query); await ws.send(json.dumps({"type": "JOB_COMPLETE", "query": query})); await ws.send(json.dumps({"type": "REQUEST_JOB"}))
        print(f"--- [FINISHED] Job for \"{query}\". Active jobs: {len(active_jobs)}/{MAX_CONCURRENT_JOBS} ---")


# --- Main loop and shutdown logic (unchanged) ---
async def main():
    await create_driver_pool()
    ws_url_base = RENDER_SERVER_URL.replace('http', 'ws'); ws_url_with_secret = f"{ws_url_base}?secret={SERVER_SIDE_SECRET}"
    while True:
        try:
            async with websockets.connect(ws_url_with_secret) as websocket:
                print(f"✅ Connected to Render server. Worker capacity: {MAX_CONCURRENT_JOBS} jobs, using a pool of {MAX_CHROME_INSTANCES} browsers.")
                for _ in range(MAX_CONCURRENT_JOBS): await websocket.send(json.dumps({"type": "REQUEST_JOB"}))
                async for message in websocket:
                    try:
                        job = json.loads(message)
                        if job.get('type') == 'NEW_JOB':
                            query = job['query']
                            if len(active_jobs) < MAX_CONCURRENT_JOBS and query not in active_jobs:
                                asyncio.create_task(process_job(query, websocket))
                        elif job.get('type') == 'NOTIFY_NEW_JOB':
                            if len(active_jobs) < MAX_CONCURRENT_JOBS: await websocket.send(json.dumps({"type": "REQUEST_JOB"}))
                    except Exception as e: print(f"Error processing message: {e}")
        except Exception as e: print(f"❌ Disconnected from server: {e}. Will try to reconnect in 10 seconds..."); active_jobs.clear(); await asyncio.sleep(10)

def shutdown_drivers():
    print("\n--- Shutting down all persistent browser instances... ---")
    for driver in driver_processes:
        try: driver.quit()
        except Exception as e: print(f"  > Could not quit a driver instance (may have already closed): {e}")
    print("--- Shutdown complete. ---")

def signal_handler(sig, frame):
    print(f'Caught signal {sig}, initiating graceful shutdown...'); shutdown_drivers(); sys.exit(0)

if __name__ == "__main__":
    if not RENDER_SERVER_URL or not SERVER_SIDE_SECRET: print("ERROR: Please create a .env file and set RENDER_SERVER_URL and SERVER_SIDE_SECRET.")
    else:
        signal.signal(signal.SIGINT, signal_handler); signal.signal(signal.SIGTERM, signal_handler)
        try: asyncio.run(main())
        except Exception as e: print(f"--- An unexpected error caused the main loop to exit: {e} ---")
        finally: print("--- Main loop has exited. Performing final cleanup. ---"); shutdown_drivers()
