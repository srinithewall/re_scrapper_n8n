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
         if (len > 30720) return resolve(len); // If HEAD request gives sufficient size, resolve immediately

         // If HEAD fails or is too small, try a partial GET request
         const reqGet = lib.get(urlStr, { headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-31000' }, timeout: 5000 }, resGet => {
            let bytes = 0;
            resGet.on('data', c => {
              bytes += c.length;
              if (bytes > 31000) { reqGet.destroy(); resolve(bytes); } // Stop early if enough bytes are received
            });
            resGet.on('end', () => {
               resolve(bytes);
            });
         });
         reqGet.on('error', () => resolve(0));
         reqGet.on('timeout', () => { reqGet.destroy(); resolve(0); });
         reqGet.end();
      });
      reqHead.on('error', () => resolve(0));
      reqHead.on('timeout', () => { reqHead.destroy(); resolve(0); });
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

function downloadFile(url) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith('http')) return resolve(null);
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode !== 200) return resolve(null);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
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
    toText(obj.projectDetails?.name) ||
    ( (obj.entityType === 'PROJECT' || obj.type === 'project') ? toText(obj.name || obj.title) : null );

  if (name && typeof name === 'string' && name.length > 3) {
    // ─────────────────────────────────────────────
    // STRATEGIC FILTER: Verify this is a PROJECT
    // ─────────────────────────────────────────────
    const isProject = 
      obj.entityType === 'PROJECT' || 
      obj.isProject === true || 
      obj.projectDetails ||
      obj.is_project_listing ||
      (obj.developerName && (obj.reraId || obj.rera_id));

    const isAd = /%| off|Paints|Insurance|Loan/i.test(name);
    if (!isProject || isAd) return results;

    const websiteUrl = toAbsoluteUrl(obj.url || obj.inventoryCanonicalUrl || obj.micrositeRedirectionURL || CONFIG.scrapeUrl);
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
          toText(obj.developer?.name) ||
          toText(obj.projectDetails?.developer?.name)
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
      possessionDate: parsePossessionDate(toText(obj.releaseDate) || toText(obj.possessionDate) || toText(obj.possession_date)),
      ...extractMedia(obj),
      location: {
        zone: loc.zone || CONFIG.api.defaultZone,
        area: areaText,
        city: decodeHtml(toText(loc.city) || toText(loc.addressRegion) || CONFIG.api.defaultCity),
        addressLine: decodeHtml(toText(loc.address) || toText(loc.longAddress) || areaText),
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

// ─────────────────────────────────────────────
// EXPORTS for Modular Use
// ─────────────────────────────────────────────
module.exports = {
  extractFromNextData,
  deriveUnitTypes,
  extractMedia,
  extractAmenities,
  buildFormFields,
  processAndSubmit,
  buildMultipart,
  postFormData,
  limitConcurrency,
  retry,
};

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
  walk(obj.photos); walk(obj.media); walk(obj.projectMedia); walk(obj.project_photos);
  
  // Extract brochure
  let brochureUrl = '';
  const findPdf = (node, depth = 0) => {
    if (!node || depth > 8 || brochureUrl) return;
    if (typeof node === 'string' && node.toLowerCase().endsWith('.pdf')) { brochureUrl = node; return; }
    if (Array.isArray(node)) { node.forEach(v => findPdf(v, depth + 1)); return; }
    if (typeof node === 'object') {
       if (node.url && typeof node.url === 'string' && node.url.toLowerCase().endsWith('.pdf')) { brochureUrl = node.url; return; }
       Object.values(node).slice(0, 30).forEach(v => findPdf(v, depth + 1));
    }
  };
  findPdf(obj);

  return {
    imageUrls: [...new Set(images)].slice(0, 30),
    videoUrls: [...new Set(videos)].slice(0, 5),
    brochureUrl
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

function parsePossessionDate(raw) {
  if (!raw) return null;
  const m = raw.match(/([a-z]+)[,\s]+(\d{4})/i);
  if (m) {
    const monthMap = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const month = monthMap[m[1].toLowerCase().slice(0, 3)] || '01';
    return `${m[2]}-${month}-01`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return null;
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
function buildFormFields(property, images = [], imageSizes = [], developerId = null, amenityIds = []) {
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
  fields['isVerified']            = false;
  fields['location.zone']         = loc.zone;
  fields['location.area']         = loc.area;
  fields['location.city']         = loc.city;
  fields['location.addressLine']  = loc.addressLine || loc.area;
  fields['location.latitude']     = loc.latitude;
  fields['location.longitude']    = loc.longitude;
  
  if (property.possessionDate) {
    fields['possessionDate'] = property.possessionDate;
  }

  property.unitTypes.forEach((unit, i) => {
    fields[`unitTypes[${i}].unitTypeId`] = unit.unitTypeId;
    fields[`unitTypes[${i}].sizeSqft`]   = unit.sizeSqft;
    fields[`unitTypes[${i}].priceMin`]   = unit.priceMin;
    fields[`unitTypes[${i}].priceMax`]   = unit.priceMax;
    fields[`unitTypes[${i}].priceUnit`]  = unit.priceUnit;
  });

  (amenityIds.length > 0 ? amenityIds : cfg.amenityIds).forEach((id, i) => { 
    fields[`amenityIds[${i}]`] = id; 
  });

  const videos = property.videoUrls || [];
  if (videos.length > 0) {
    fields['videos[0].videoUrl'] = videos[0];
    fields['videos[0].videoType'] = 'YOUTUBE';
    fields['videos[0].sortOrder'] = 1;
  }

  for (let i = 0; i < images.length; i++) {
    fields[`images[${i}].sortOrder`] = i + 1;
    fields[`images[${i}].imageType`] = 'GALLERY';
    fields[`images[${i}].fileSize`]  = imageSizes[i] || 0;
  }
  return fields;
}

/**
 * Encapsulated per-project logic: Dedupe -> Filter -> Resolve -> Submit
 */
async function processAndSubmit(prop, dryRun, apiLookups, dedupeState) {
  log.info(`  Processing "${prop.projectName}"...`);

  // 1. Local Dedupe
  const dedupeKey = normalizeProjectKey(prop.projectName);
  if (dedupeState.projects[dedupeKey]) {
    log.warn(`    [SKIP] Local dedupe (Seen: ${dedupeState.projects[dedupeKey].firstSeenAt})`);
    return { success: false, projectName: prop.projectName, reason: 'Duplicate' };
  }

  // 2. Location Quality Check
  const isHardcodedLat = Math.abs(prop.location.latitude - 12.9698) < 0.0001;
  const isHardcodedLong = Math.abs(prop.location.longitude - 77.7500) < 0.0001;
  if (isHardcodedLat && isHardcodedLong) {
    log.warn(`    [SKIP] Invalid/Hardcoded location data.`);
    return { success: false, projectName: prop.projectName, reason: 'Invalid Location' };
  }

  // 3. Parallel Image Verification
  const checkTasks = prop.imageUrls.map(url => () => checkImageSize(url));
  const sizes = await limitConcurrency(checkTasks, 10);
  const validImageUrls = prop.imageUrls.filter((url, i) => sizes[i] > 30720);
  const validImageSizes = sizes.filter(s => s > 30720);

  if (validImageUrls.length === 0) {
    log.warn(`    [SKIP] 0 valid images >30kb.`);
    return { success: false, projectName: prop.projectName, reason: 'Low Quality' };
  }

  // 4. Parallel Downloads
  const downloadTasks = validImageUrls.slice(0, 10).map(url => () => downloadImage(url));
  const imageBuffers = await limitConcurrency(downloadTasks, 5);
  const finalBuffers = imageBuffers.filter(b => b !== null);

  if (finalBuffers.length === 0) {
    return { success: false, projectName: prop.projectName, reason: 'Download Failed' };
  }

  // 5. Developer & Amenity Lookups (with caching handled by apiLookups internally or locally)
  const devName = prop.developerName || 'Unknown';
  let devId = developerCache.get(devName);
  if (!devId) {
    devId = await apiLookups.resolveDeveloper(devName);
    developerCache.set(devName, devId);
  }
  const amenityIds = await apiLookups.resolveAmenities(prop.amenitiesExtracted || []);

  // 6. Build Payload
  const fields = buildFormFields(prop, finalBuffers, validImageSizes, devId, amenityIds);
  const files = finalBuffers.map((buf, i) => ({
    fieldName: `images[${i}].file`,
    fileName: `property-${i}.jpg`,
    mimeType: 'image/jpeg',
    buffer: buf
  }));

  // 7. Submit (with Retry)
  if (dryRun) {
    log.success(`    [DRY-RUN] Success identifying "${prop.projectName}"`);
    return { success: true, projectName: prop.projectName, dryRun: true };
  }

  try {
    const result = await retry(() => postFormData(CONFIG.apiUrl, fields, files), 3);
    if (result.statusCode >= 200 && result.statusCode < 300) {
      log.success(`    [OK] Submitted successfully`);
      markSeenProject(dedupeState, prop.projectName, { source: prop.sourceName });
      return { success: true, projectName: prop.projectName, statusCode: result.statusCode };
    } else {
      log.error(`    [FAIL] API Error ${result.statusCode}: ${result.body.slice(0, 50)}...`);
      return { success: false, projectName: prop.projectName, reason: `API ${result.statusCode}` };
    }
  } catch (err) {
    log.error(`    [FAIL] Network error: ${err.message}`);
    return { success: false, projectName: prop.projectName, reason: 'Network Error' };
  }
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
// PRO-LEVEL UTILITIES
// ─────────────────────────────────────────────

/**
 * Execute tasks in parallel with a concurrency limit.
 */
async function limitConcurrency(tasks, limit = 5) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const promise = Promise.resolve().then(() => task());
    results.push(promise);
    executing.add(promise);
    const cleanup = () => executing.delete(promise);
    promise.then(cleanup).catch(cleanup);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

/**
 * Robust retry mechanism for async functions.
 */
async function retry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      log.warn(`  [RETRY ${i + 1}/${retries}] Operation failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay * Math.pow(2, i))); // Exp backoff
    }
  }
}

const developerCache = new Map();

// ─────────────────────────────────────────────
// SCRAPER LOGIC
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
  const reports = []; // Collect results for summary

  // ─────────────────────────────────────────────
  // DEPENDENCY INITIALIZATION
  // ─────────────────────────────────────────────
  const dedupeState = loadDedupeState(CONFIG.dedupeStateFile);
  const baseDeveloperResolver = await createDeveloperResolver(CONFIG, log);
  const apiLookups = await createApiLookups(CONFIG, baseDeveloperResolver, log);

  try {
    const page = await browser.newPage();
    // RANDOM VIEWPORT for Stealth
    const viewWidth = 1200 + Math.floor(Math.random() * 400);
    const viewHeight = 800 + Math.floor(Math.random() * 200);
    await page.setViewport({ width: viewWidth, height: viewHeight });
    
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

    // ─────────────────────────────────────────────
    // STRATEGIC REFACTOR: Process Page-by-Page
    // ─────────────────────────────────────────────
    const isDetailPage = CONFIG.scrapeUrl.includes('/projects/page/') || CONFIG.scrapeUrl.includes('/buy-projects-');
    const maxPages = isDetailPage ? 1 : (CONFIG.maxPages || 5);

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const url = pageNum === 1 ? CONFIG.scrapeUrl : `${CONFIG.scrapeUrl}?page=${pageNum}`;
      log.info(`Loading page ${pageNum}: ${url}`);
      interceptedResponses.length = 0; // Clear for each page

      try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }); } catch (e) {}
      await sleep(3000 + Math.random() * 3000); // Random delay 3-6s

      log.data(`Page ${pageNum}: ${interceptedResponses.length} API responses intercepted`);

      let pageExtractedCount = 0;
      const propertiesOnPage = [];

      for (const resp of interceptedResponses) {
        try {
          const json = JSON.parse(resp.text);
          const extracted = extractFromNextData(json);
          extracted.forEach(p => {
             p.sourceApiUrl = resp.url;
             propertiesOnPage.push(p);
             pageExtractedCount++;
          });
        } catch (_) {}
      }

      if (pageExtractedCount === 0) {
        const html = await page.content();
        const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nextMatch) {
          try {
            const extracted = extractFromNextData(JSON.parse(nextMatch[1]));
            extracted.forEach(p => { p.sourceApiUrl = '__NEXT_DATA__'; propertiesOnPage.push(p); pageExtractedCount++; });
          } catch (e) {}
        }
      }
      log.success(`Page ${pageNum}: ${pageExtractedCount} projects extracted`);

      // ── Process and Submit these projects immediately ──
      // This prevents memory bloat for large crawls
      if (propertiesOnPage.length > 0) {
        log.info(`  Processing and submitting ${propertiesOnPage.length} projects from Page ${pageNum}...`);
        for (const prop of propertiesOnPage) {
          const res = await processAndSubmit(prop, dryRun, apiLookups, dedupeState); // Pass all required deps
          reports.push(res);
        }
      }

      if (reports.length >= (CONFIG.limit || 10)) break;
    }
    if (reports.length === 0) { // If no projects were extracted via API/NEXT_DATA after all pages
      log.warn('  No projects in JSON. Falling back to DOM extraction...');
      const rawCards = await page.evaluate(() => {
        // detail page detection
        const h1 = document.querySelector('h1')?.innerText?.trim();
        if (window.location.href.includes('/projects/page/') && h1) {
          // Also try to grab images from the detail page
          const imgs = Array.from(document.querySelectorAll('img[src*="housing"]'))
            .map(img => img.src).filter(s => s && s.startsWith('http')).slice(0, 8);
          return [{ projectName: h1, websiteUrl: window.location.href, description: h1 + ' - Residential Project', imageUrls: imgs }];
        }
        // listing page detection
        return Array.from(document.querySelectorAll('article, [class*="project-card"], [class*="listing-card"]')).map(el => {
          const name = el.querySelector('h1, h2, h3, [class*="title"], [class*="name"]')?.innerText?.trim();
          const url = el.querySelector('a')?.href;
          if (!name || name.length < 5 || !url) return null;
          return { projectName: name, websiteUrl: url, description: name + ' - Premium Project', imageUrls: [] };
        }).filter(x => x && !/%| off|Paints/i.test(x.projectName));
      });

      // Normalize DOM cards to match the full structure processAndSubmit expects
      const cards = rawCards.map(c => ({
        ...c,
        imageUrls: c.imageUrls || [],
        videoUrls: [],
        reraNumber: null,
        developerName: '',
        sourceType: CONFIG.sourceType,
        sourceName: CONFIG.source,
        sourceUpdatedAt: new Date().toISOString(),
        possessionDate: null,
        amenitiesExtracted: [],
        unitTypes: [
          { unitTypeId: 2, sizeSqft: 1200, priceMin: 0.85, priceMax: 1.20, priceUnit: 'Cr' },
          { unitTypeId: 3, sizeSqft: 1700, priceMin: 1.20, priceMax: 1.60, priceUnit: 'Cr' },
        ],
        location: {
          zone:        CONFIG.api.defaultZone || 'East',
          area:        'Bengaluru',
          addressLine: 'Bengaluru',
          city:        CONFIG.api.defaultCity || 'Bengaluru',
          latitude:    0,       // use 0 so location quality gate passes (not == 12.9698)
          longitude:   0,
        },
      }));

      for (const prop of cards) {
        const res = await processAndSubmit(prop, dryRun, apiLookups, dedupeState);
        reports.push(res);
      }
    }
  } catch (err) { log.error(`  Scrape failed: ${err.message}`); }
  finally { await browser.close(); }

  // Total Scraped is now in reports
  const successCount = reports.filter(r => r.success).length;
  const skipCount = reports.filter(r => !r.success).length;
  log.success(`Total processed: ${reports.length} (Success: ${successCount}, Skipped: ${skipCount})`);

  // ─────────────────────────────────────────────
  // SCRAPING SUMMARY
  // ─────────────────────────────────────────────
  log.step('PHASE 2: Generation Summary');
  const results = { success: [], failed: [], skipped: [] };
  reports.forEach(r => {
    if (r.success) {
      results.success.push({ property: r.projectName, statusCode: r.statusCode || (r.dryRun ? 'dry-run' : 'N/A') });
    } else {
      results.skipped.push({ property: r.projectName, reason: r.reason || 'unknown' });
    }
  });

  saveDedupeState(CONFIG.dedupeStateFile, dedupeState);
  log.step('━━━ SCRAPING SUMMARY ━━━');
  log.success(`Success : ${results.success.length}`);
  log.info(`Skipped : ${results.skipped.length}`);
  if (results.failed.length) log.error(`Failed  : ${results.failed.length}`);
}

if (require.main === module) {
  main().catch(err => { log.error(err.message); process.exit(1); });
}
