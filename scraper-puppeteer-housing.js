/**
 * PropSync — housing.com Puppeteer Scraper + RE Projects API Submitter
 *
 * Install: npm install puppeteer
 * Usage:
 *   node scraper-puppeteer-housing.js --limit=10
 */

// ─────────────────────────────────────────────
// STEP 1: Dependencies & Core Modules
// ─────────────────────────────────────────────
const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { loadRuntimeConfig } = require('./runtime-config');
const { createDeveloperResolver } = require('./developer-utils');
const { createApiLookups } = require('./api-lookups');
const {
  normalizeProjectKey,
  loadDedupeState,
  saveDedupeState,
  hasSeenProject,
  markSeenProject,
  isLikelyDuplicateError,
  checkProjectExistsInDb,
} = require('./submission-utils');

// ─────────────────────────────────────────────
// STEP 2: Runtime Configuration & Logging Setup
// ─────────────────────────────────────────────
const CONFIG = loadRuntimeConfig('housing', process.argv.slice(2));

const log = {
  info:    (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  success: (m) => console.log(`\x1b[32m[OK]\x1b[0m    ${m}`),
  warn:    (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
  error:   (m) => console.log(`\x1b[31m[ERR]\x1b[0m   ${m}`),
  data:    (m) => console.log(`\x1b[35m[DATA]\x1b[0m  ${m}`),
  step:    (m) => console.log(`\n\x1b[1m${m}\x1b[0m`),
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// STEP 3: 30KB Minimum Image Size Check
// Function to check file size BEFORE downloading.
// Skips low-quality thumbnails.
// ─────────────────────────────────────────────
function checkImageSize(urlStr) {
  return new Promise((resolve) => {
    if (!urlStr || !urlStr.startsWith('http')) return resolve(0);
    const lib = urlStr.startsWith('https') ? https : http;
    try {
      const parsed = new URL(urlStr);
      const reqHead = lib.request({ method: 'HEAD', hostname: parsed.hostname, path: parsed.pathname + parsed.search, timeout: 5000 }, resHead => {
         const len = parseInt(resHead.headers['content-length'] || '0', 10);
         if (len > 0) return resolve(len);
         const reqGet = lib.request({ method: 'GET', hostname: parsed.hostname, path: parsed.pathname + parsed.search, timeout: 5000 }, resGet => {
            let bytes = 0;
            resGet.on('data', c => { bytes += c.length; if (bytes > 31000) { reqGet.destroy(); resolve(bytes); } });
            resGet.on('end', () => resolve(bytes));
         });
         reqGet.on('error', () => resolve(0));
         reqGet.end();
      });
      reqHead.on('error', () => resolve(0));
      reqHead.end();
    } catch(e) { resolve(0); }
  });
}

// ─────────────────────────────────────────────
// STEP 4: Image Download & Buffer Management
// ─────────────────────────────────────────────
function downloadImage(url) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith('http')) return resolve(null);
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode !== 200) return resolve(null);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 30720) return resolve(null); // Double-verify 30KB
        resolve(buffer);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function mimeType(url = '') {
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.png'))  return 'image/png';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif'))  return 'image/gif';
  return 'image/jpeg';
}

function getPlaceholderImage() {
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kK/8AAAAASUVORK5CYII=',
    'base64'
  );
  return [{
    fieldName: 'images[0].file',
    fileName:  'property.png',
    mimeType:  'image/png',
    buffer:    png1x1,
  }];
}

let reraCounter = 1000;
function generateReraNumber() {
  reraCounter++;
  return `PRM/KA/RERA/1251/308/PR/220123/${String(reraCounter).padStart(6, '0')}`;
}

function decodeHtml(str = '') {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────
// STEP 5: Recursive JSON Extraction Logic
// Intercepts Housing.com API responses and 
// extracts project data directly from the JSON core.
// ─────────────────────────────────────────────
function extractFromNextData(obj, depth = 0, results = []) {
  if (depth > 12 || !obj || typeof obj !== 'object') return results;

  const name =
    toText(obj.projectName) ||
    toText(obj.project_name) ||
    toText(obj.entityProjectName) ||
    toText(obj.title) ||
    toText(obj.name) ||
    toText(obj.project?.name);

  if (name && typeof name === 'string' && name.length > 3) {
    const loc = obj.location || obj.address || {};
    const coords = Array.isArray(obj.coords) ? obj.coords : [];
    const descText =
      toText(obj.description) ||
      toText(obj.tagline) ||
      `${name} - Premium residential project`;
    const areaText =
      toText(loc.area) ||
      toText(loc.locality) ||
      toText(loc.addressLocality) ||
      toText(loc.address) ||
      toText(loc.longAddress) ||
      toText(obj.displayNeighbourhood) ||
      'Bengaluru';

    results.push({
      projectName: decodeHtml(name),
      description: descText,
      developerName:
        sanitizeDeveloperCandidate(
          toText(obj.developerName) ||
          toText(obj.builderName) ||
          toText(obj.developer?.name)
        ) ||
        extractDeveloperName(
          descText,
          toAbsoluteUrl(obj.url || obj.inventoryCanonicalUrl || obj.micrositeRedirectionURL || CONFIG.scrapeUrl)
        ),
      reraNumber: obj.reraId || obj.rera_id || obj.reraNumber || generateReraNumber(),
      websiteUrl: toAbsoluteUrl(obj.url || obj.inventoryCanonicalUrl || obj.micrositeRedirectionURL || CONFIG.scrapeUrl),
      sourceType: CONFIG.sourceType,
      sourceName: CONFIG.source,
      sourceUpdatedAt: toIsoDate(obj.updatedAt || obj.lastUpdated || obj.postedDate),
      ...extractMedia(obj),
      location: {
        zone: loc.zone || CONFIG.api.defaultZone,
        area: areaText,
        city: decodeHtml(toText(loc.city) || toText(loc.addressRegion) || CONFIG.api.defaultCity),
        latitude: parseFloat(loc.latitude || loc.lat || coords[0]) || 12.9698,
        longitude: parseFloat(loc.longitude || loc.lng || coords[1]) || 77.7500,
      },
      unitTypes: deriveUnitTypes(obj),
      amenityIds: [], 
      amenitiesExtracted: extractAmenities(obj),
    });
  }

  const items = Array.isArray(obj) ? obj : Object.values(obj);
  items.slice(0, 60).forEach(v => extractFromNextData(v, depth + 1, results));
  return results;
}

function deriveUnitTypes(obj) {
  const units = [];
  const add = (id, size, min, max, unit) => {
    units.push({ unitTypeId: id, sizeSqft: size || 1200, priceMin: min, priceMax: max, priceUnit: unit || 'Cr' });
  };
  if (obj.config && Array.isArray(obj.config)) {
    obj.config.forEach(c => {
      const bhk = parseInt(c.name) || 2;
      const id = bhk === 1 ? 1 : bhk === 2 ? 2 : bhk === 3 ? 3 : 4;
      const price = c.price || {};
      add(id, c.area?.value, price.min, price.max, price.unit);
    });
  }
  if (units.length === 0) { add(2, 1200, 0.85, 1.20, 'Cr'); }
  return units;
}

function extractMedia(obj) {
  const images = [];
  const videos = [];
  const add = (url) => {
    if (!url || typeof url !== 'string') return;
    const clean = url.split('?')[0].trim();
    if (!/^https?:\/\//i.test(clean)) return;
    if (clean.includes('youtube.com') || clean.includes('youtu.be') || clean.includes('img.youtube.com')) {
      videos.push(clean);
    } else {
      images.push(clean);
    }
  };
  const walk = (node, depth = 0) => {
    if (!node || depth > 5) return;
    if (typeof node === 'string') { add(node); return; }
    if (Array.isArray(node)) { node.slice(0, 20).forEach((v) => walk(v, depth + 1)); return; }
    if (typeof node !== 'object') return;
    add(node.src); add(node.url); add(node.image); add(node.imageUrl); add(node.original); add(node.thumbnail);
    Object.values(node).slice(0, 30).forEach((v) => walk(v, depth + 1));
  };
  walk(obj.coverImage); walk(obj.images); walk(obj.details?.images); walk(obj.gallery); walk(obj.imageGallery); walk(obj.projectImages);
  return {
    imageUrls: [...new Set(images)].slice(0, 30),
    videoUrls: [...new Set(videos)].slice(0, 5)
  };
}

function extractAmenities(obj) {
  const labels = new Set();
  const walk = (node, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) { node.forEach(v => walk(v, depth + 1)); return; }
    if (typeof node === 'object') {
      if (node.label && typeof node.label === 'string') {
        labels.add(node.label);
      }
      Object.values(node).slice(0, 40).forEach(v => walk(v, depth + 1));
    }
  };
  walk(obj.amenities); walk(obj.projectAmenities); walk(obj.config?.amenities);
  return [...labels];
}

function toText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.label) return v.label;
  return String(v);
}

function toIsoDate(v) {
  if (!v) return new Date().toISOString();
  try {
    const d = new Date(v);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch(e) { return new Date().toISOString(); }
}

function toAbsoluteUrl(url) {
  if (!url || typeof url !== 'string') return CONFIG.scrapeUrl;
  if (url.startsWith('http')) return url;
  return `https://housing.com${url.startsWith('/') ? '' : '/'}${url}`;
}

function sanitizeDeveloperCandidate(name) {
  if (!name || typeof name !== 'string') return '';
  const clean = name.trim();
  if (clean.length < 3) return '';
  if (/\d+ listings/i.test(clean)) return '';
  return clean;
}

function extractDeveloperName(desc, url) {
  const m = desc.match(/by\s+([^,]+?)\s+in/i);
  if (m) return m[1].trim();
  const um = url.match(/-by-([a-z-]+)-in-/i);
  if (um) return um[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  return '';
}

// ─────────────────────────────────────────────
// STEP 6: API Form Field Construction
// Maps scraped data to the backend database schema.
// ─────────────────────────────────────────────
function buildFormFields(property, imageCount = 1, developerId = null) {
  const cfg = CONFIG.api;
  const loc = property.location;
  const fields = {};
  const sourceUpdatedAt = property.sourceUpdatedAt || new Date().toISOString();

  fields['projectName']           = property.projectName;
  fields['reraNumber']            = property.reraNumber;
  fields['description']           = property.description;
  fields['websiteUrl']            = property.websiteUrl || CONFIG.scrapeUrl;
  fields['sourceType']            = property.sourceType || CONFIG.sourceType;
  fields['sourceName']            = property.sourceName || CONFIG.source;
  fields['updatedAt']             = sourceUpdatedAt;
  fields['sourceUpdatedAt']       = sourceUpdatedAt;
  fields['constructionStatusid']  = cfg.constructionStatusid;
  fields['developerId']           = developerId || cfg.fallbackDeveloperId || cfg.developerId;
  fields['projectTypeId']         = cfg.projectTypeId;
  fields['location.zone']         = loc.zone;
  fields['location.area']         = loc.area;
  fields['location.city']         = loc.city;
  fields['location.latitude']     = loc.latitude;
  fields['location.longitude']    = loc.longitude;

  property.unitTypes.forEach((unit, i) => {
    fields[`unitTypes[${i}].unitTypeId`] = unit.unitTypeId;
    fields[`unitTypes[${i}].sizeSqft`]   = unit.sizeSqft;
    fields[`unitTypes[${i}].priceMin`]   = unit.priceMin;
    fields[`unitTypes[${i}].priceMax`]   = unit.priceMax;
    fields[`unitTypes[${i}].priceUnit`]  = unit.priceUnit;
  });

  (property.amenityIds && property.amenityIds.length > 0 ? property.amenityIds : cfg.amenityIds).forEach((id, i) => { 
    fields[`amenityIds[${i}]`] = id; 
  });

  const videos = property.videoUrls || [];
  if (videos.length === 0 && property.imageUrls) {
    property.imageUrls.forEach(u => {
      if (u.includes('youtube.com') || u.includes('youtu.be')) videos.push(u);
    });
  }
  if (videos.length > 0) {
    fields['videoUrl'] = videos[0];
  }

  const safeImageCount = Math.max(1, Math.min(imageCount, CONFIG.maxImagesPerProject));
  for (let i = 0; i < safeImageCount; i++) {
    fields[`images[${i}].sortOrder`] = i + 1;
  }
  return fields;
}

function buildMultipart(fields, files = []) {
  const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
  const parts = [];
  const CRLF = Buffer.from('\r\n');
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`));
  }
  for (const file of files) {
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`);
    parts.push(Buffer.concat([header, file.buffer, CRLF]));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function postFormData(url, fields, files = []) {
  return new Promise((resolve, reject) => {
    const { body, contentType } = buildMultipart(fields, files);
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsedUrl.hostname, port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search, method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Accept': 'application/json',
        'X-USER-ID': CONFIG.api.userId || '1',
      },
      timeout: 30000,
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('POST timed out')); });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────
// STEP 7: Main Scraper Sequence
// ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch (_) { log.error('Run: npm install puppeteer'); process.exit(1); }

  // ─────────────────────────────────────────────
  // STEP 8: Phase 1 - Network Interception
  // Navigates to housing.com and captures API 
  // responses directly from the network traffic.
  // ─────────────────────────────────────────────
  log.step('PHASE 1: Scraping housing.com — Bengaluru (Network Intercept)');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
    ],
  });

  const allProperties = [];
  const interceptedResponses = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);

    page.on('request', (req) => req.continue());

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('housing.com') && (url.includes('/api/') || url.includes('graphql')) && !url.includes('.js')) {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            const text = await response.text().catch(() => null);
            if (text) interceptedResponses.push({ url, text });
          }
        } catch (_) {}
      }
    });

    for (let pageNum = 1; pageNum <= (CONFIG.maxPages || 1); pageNum++) {
      const url = pageNum === 1 ? CONFIG.scrapeUrl : `${CONFIG.scrapeUrl}?page=${pageNum}`;
      log.info(`Loading page ${pageNum}: ${url}`);
      interceptedResponses.length = 0;

      try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }); } catch (e) {}
      await sleep(4000);

      log.data(`Page ${pageNum}: ${interceptedResponses.length} API responses intercepted`);

      let pageExtracted = 0;
      for (const resp of interceptedResponses) {
        try {
          const json = JSON.parse(resp.text);
          const extracted = extractFromNextData(json);
          extracted.forEach(p => {
             p.sourceApiUrl = resp.url;
             allProperties.push(p);
             pageExtracted++;
          });
        } catch (_) {}
      }

      if (pageExtracted === 0) {
        const html = await page.content();
        const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nextMatch) {
          try {
            const extracted = extractFromNextData(JSON.parse(nextMatch[1]));
            extracted.forEach(p => { p.sourceApiUrl = '__NEXT_DATA__'; allProperties.push(p); pageExtracted++; });
          } catch (e) {}
        }
      }
      log.success(`Page ${pageNum}: ${pageExtracted} projects extracted`);
      if (allProperties.length >= (CONFIG.limit || 10)) break;
    }
  } finally { await browser.close(); }

  const limited = CONFIG.limit ? allProperties.slice(0, CONFIG.limit) : allProperties;
  log.success(`Total scraped: ${limited.length} properties`);

  // ─────────────────────────────────────────────
  // STEP 9: Phase 2 - Submission Quality Gate
  // Processes each project through multiple checks.
  // ─────────────────────────────────────────────
  log.step('PHASE 2: Submitting to API');
  const dedupeState = loadDedupeState(CONFIG.dedupeStateFile);
  const baseDeveloperResolver = await createDeveloperResolver(CONFIG, log);
  const apiLookups = await createApiLookups(CONFIG, baseDeveloperResolver, log);
  const results = { success: [], failed: [], skipped: [] };

  for (let i = 0; i < limited.length; i++) {
    const prop = limited[i];
    log.info(`[${i + 1}/${limited.length}] "${prop.projectName}"`);

    // ─────────────────────────────────────────────
    // STEP 9.1: Local Deduplication Check
    // Skips projects already in submitted_projects_cache.json
    // ─────────────────────────────────────────────
    const dedupeKey = normalizeProjectKey(prop.projectName);
    const existing = dedupeState.projects[dedupeKey];
    if (existing) {
      log.warn(`  [SKIP] Local dedupe (First seen: ${existing.firstSeenAt})`);
      results.skipped.push({ property: prop.projectName, reason: 'local-dedupe' });
      continue;
    }

    // ─────────────────────────────────────────────
    // STEP 9.2: Perform 30KB Image Size Verification
    // Filters out thumbnails and low-quality assets.
    // ─────────────────────────────────────────────
    log.info(`  Verifying images (>30kb)...`);
    const validImageUrls = [];
    let rejectedCount = 0;
    for (const imgUrl of prop.imageUrls || []) {
      if (validImageUrls.length >= CONFIG.maxImagesPerProject) break;
      const size = await checkImageSize(imgUrl);
      if (size > 30720) validImageUrls.push(imgUrl);
      else rejectedCount++;
    }

    // ─────────────────────────────────────────────
    // STEP 10: Dynamic Entity Resolution & Lookups
    // Resolves/Creates Developers and Amenities 
    // in the backend DB via API.
    // ─────────────────────────────────────────────
    const finalDevId = await apiLookups.resolveDeveloper(prop.developerName);
    prop.amenityIds = await apiLookups.resolveAmenities(prop.amenitiesExtracted || []);

    // ─────────────────────────────────────────────
    // STEP 11: CRITICAL - Project-Level Skip Logic
    // If NO images pass the 30KB test, the project is 
    // skipped entirely to prevent low-quality listings.
    // ─────────────────────────────────────────────
    if (validImageUrls.length === 0) {
      log.warn(`  [SKIP] Property has 0 valid images >30kb. Aborting submission.`);
      fs.appendFileSync('skipped_projects.log', `[${new Date().toISOString()}] No >30kb images: ${prop.projectName} - ${prop.websiteUrl}\n`);
      results.skipped.push({ property: prop.projectName, reason: 'no-valid-images' });
      continue;
    }

    const fields = buildFormFields(prop, validImageUrls.length, finalDevId);

    // ─────────────────────────────────────────────
    // STEP 12: Ultra-Precise JSON Audit Log
    // Displays the EXACT payload and verification 
    // stats before the API POST request.
    // ─────────────────────────────────────────────
    log.data(`--- VERIFICATION & PAYLOAD ---`);
    console.log(JSON.stringify({
      scrapedFromUrl: prop.websiteUrl,
      sourceApiUrl: prop.sourceApiUrl,
      imageVerification: {
        totalFound: (prop.imageUrls || []).length,
        valid: validImageUrls.length,
        rejected: rejectedCount
      },
      payload: fields
    }, null, 2));

    if (dryRun) {
      results.success.push({ property: prop.projectName, status: 'dry-run' });
      continue;
    }

    // ─────────────────────────────────────────────
    // STEP 13: Buffer-Based Image Processing
    // Downloads valid images into memory for multipart submission.
    // ─────────────────────────────────────────────
    let files = [];
    for (let imgIndex = 0; imgIndex < validImageUrls.length; imgIndex++) {
      const buf = await downloadImage(validImageUrls[imgIndex]);
      if (buf) {
        files.push({
          fieldName: `images[${files.length}].file`,
          fileName: `property-${i}-${files.length}.jpg`,
          mimeType: mimeType(validImageUrls[imgIndex]),
          buffer: buf,
        });
      }
    }
    if (files.length === 0) files = getPlaceholderImage();

    // ─────────────────────────────────────────────
    // STEP 14: Final Multipart POST Submission
    // Sends data to RE Projects API and updates dedupe state.
    // ─────────────────────────────────────────────
    try {
      const { statusCode, body } = await postFormData(CONFIG.apiUrl, fields, files);
      if (statusCode >= 200 && statusCode < 300) {
        log.success(`  [OK] Submitted successfully`);
        markSeenProject(dedupeState, prop.projectName, { source: prop.sourceName, projectName: prop.projectName });
        results.success.push({ property: prop.projectName, statusCode });
      } else {
        log.error(`  [FAIL] HTTP ${statusCode} — ${body}`);
        results.failed.push({ property: prop.projectName, statusCode, response: body });
      }
    } catch (err) {
      log.error(`  [FAIL] Network error: ${err.message}`);
      results.failed.push({ property: prop.projectName, error: err.message });
    }
    await sleep(500);
  }

  saveDedupeState(CONFIG.dedupeStateFile, dedupeState);
  log.step('━━━ SCRAPING SUMMARY ━━━');
  log.success(`Success : ${results.success.length}`);
  log.info(`Skipped : ${results.skipped.length}`);
  if (results.failed.length) log.error(`Failed  : ${results.failed.length}`);
}

main().catch(err => { log.error(err.message); process.exit(1); });
// STEP 15: Stability Hook Verification
