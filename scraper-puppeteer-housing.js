/**
 * PropSync — housing.com Puppeteer Scraper + RE Projects API Submitter
 * v2 — Advanced Stealth (puppeteer-extra + Indian IP + WebGL Override)
 *
 * Install: npm install puppeteer-extra puppeteer-extra-plugin-stealth
 * Usage:
 *   PROXY_URL=http://user:pass@host:port node scraper-puppeteer-housing.js --limit=10
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
// STEALTH CONFIG
// Set PROXY_URL env var before running:
//   export PROXY_URL=http://user:pass@residential-proxy-host:port
// ─────────────────────────────────────────────
const PROXY_URL = process.env.PROXY_URL || '';

// Must match the EXACT Chromium version bundled in your Docker image.
// Run `node -e "const p=require('puppeteer'); console.log(p.executablePath())"` 
// then `<that path> --version` to get the version string and update below.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36';

// ─────────────────────────────────────────────
// STEP 3: 30KB Minimum Image Size Check
// ─────────────────────────────────────────────
function checkImageSize(urlStr) {
  return new Promise((resolve) => {
    if (!urlStr || !urlStr.startsWith('http')) return resolve(0);
    const lib = urlStr.startsWith('https') ? https : http;
    try {
      const parsed = new URL(urlStr);
      const reqHead = lib.request({ method: 'HEAD', hostname: parsed.hostname, path: parsed.pathname + parsed.search, timeout: 5000 }, resHead => {
         const len = parseInt(resHead.headers['content-length'] || '0', 10);
         if (len > 30720) return resolve(len);
         const reqGet = lib.get(urlStr, { headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-31000' }, timeout: 5000 }, resGet => {
            let bytes = 0;
            resGet.on('data', c => {
              bytes += c.length;
              if (bytes > 31000) { reqGet.destroy(); resolve(bytes); }
            });
            resGet.on('end', () => { resolve(bytes); });
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
        if (buffer.length < 30720) return resolve(null);
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

  const dedupeKey = normalizeProjectKey(prop.projectName);
  if (dedupeState.projects[dedupeKey]) {
    log.warn(`    [SKIP] Local dedupe (Seen: ${dedupeState.projects[dedupeKey].firstSeenAt})`);
    return { success: false, projectName: prop.projectName, reason: 'Duplicate' };
  }

  const isHardcodedLat = Math.abs(prop.location.latitude - 12.9698) < 0.0001;
  const isHardcodedLong = Math.abs(prop.location.longitude - 77.7500) < 0.0001;
  if (isHardcodedLat && isHardcodedLong) {
    log.warn(`    [SKIP] Invalid/Hardcoded location data.`);
    return { success: false, projectName: prop.projectName, reason: 'Invalid Location' };
  }

  const checkTasks = prop.imageUrls.map(url => () => checkImageSize(url));
  const sizes = await limitConcurrency(checkTasks, 10);
  const validImageUrls = prop.imageUrls.filter((url, i) => sizes[i] > 30720);
  const validImageSizes = sizes.filter(s => s > 30720);

  if (validImageUrls.length === 0) {
    log.warn(`    [SKIP] 0 valid images >30kb.`);
    return { success: false, projectName: prop.projectName, reason: 'Low Quality' };
  }

  const downloadTasks = validImageUrls.slice(0, 10).map(url => () => downloadImage(url));
  const imageBuffers = await limitConcurrency(downloadTasks, 5);
  const finalBuffers = imageBuffers.filter(b => b !== null);

  if (finalBuffers.length === 0) {
    return { success: false, projectName: prop.projectName, reason: 'Download Failed' };
  }

  const devName = prop.developerName || 'Unknown';
  let devId = developerCache.get(devName);
  if (!devId) {
    devId = await apiLookups.resolveDeveloper(devName);
    developerCache.set(devName, devId);
  }
  const amenityIds = await apiLookups.resolveAmenities(prop.amenitiesExtracted || []);

  const fields = buildFormFields(prop, finalBuffers, validImageSizes, devId, amenityIds);
  const files = finalBuffers.map((buf, i) => ({
    fieldName: `images[${i}].file`,
    fileName: `property-${i}.jpg`,
    mimeType: 'image/jpeg',
    buffer: buf
  }));

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

async function retry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      log.warn(`  [RETRY ${i + 1}/${retries}] Operation failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
    }
  }
}

const developerCache = new Map();

// ─────────────────────────────────────────────
// STEALTH HELPERS
// ─────────────────────────────────────────────

/**
 * Injects realistic browser fingerprint properties into the page context.
 * Overrides the most common headless-browser tells:
 *   - navigator.webdriver (set to undefined)
 *   - WebGL renderer (SwiftShader → Intel Mesa)
 *   - navigator.deviceMemory, hardwareConcurrency, languages
 *   - Chrome runtime object presence
 */
async function injectStealthScripts(page) {
  await page.evaluateOnNewDocument(() => {
    // 1. Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 2. Spoof hardware fingerprint
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'languages', { get: () => ['hi-IN', 'en-IN', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'language', { get: () => 'hi-IN' });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

    // 3. Spoof WebGL — hides the "SwiftShader" headless renderer string
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';   // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return 'Intel(R) UHD Graphics 620';  // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, parameter);
    };

    // 4. Ensure chrome runtime object exists (headless Chrome is missing it)
    if (!window.chrome) {
      window.chrome = { runtime: {} };
    }

    // 5. Spoof plugin count (headless has 0 plugins)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const fakePlugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' },
        ];
        fakePlugins.length = 3;
        return fakePlugins;
      }
    });

    // 6. Spoof screen resolution to look like a real desktop
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
  });
}

/**
 * Sets Indian-locale HTTP headers on every request.
 * Housing.com checks Accept-Language and sec-ch-ua for geo consistency.
 */
async function setIndianHeaders(page) {
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'hi-IN,en-IN;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-ch-ua': '"Chromium";v="123", "Google Chrome";v="123", "Not:A-Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  });
}

/**
 * Simulates a human scrolling down the page in random chunks.
 * Avoids the instant full-page scroll that bots typically do.
 */
async function humanScrollDown(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalScrolled = 0;
      const pageHeight = document.body.scrollHeight;
      const scroll = () => {
        // Random scroll chunk between 200px and 600px
        const chunk = 200 + Math.floor(Math.random() * 400);
        window.scrollBy(0, chunk);
        totalScrolled += chunk;
        if (totalScrolled >= pageHeight * 0.8) {
          resolve();
        } else {
          // Random pause between scroll chunks: 300ms to 900ms
          setTimeout(scroll, 300 + Math.floor(Math.random() * 600));
        }
      };
      scroll();
    });
  });
}

/**
 * Detects if the current page is a block/CAPTCHA screen.
 * Returns an object with isBlocked and reason.
 */
async function detectBlock(page) {
  const title = await page.title().catch(() => '');
  const html  = await page.content().catch(() => '');
  const status = page.url(); // post-redirect URL can also reveal blocks

  const blockSignals = [
    { pattern: /shield/i,                   reason: 'Cloudflare Shield' },
    { pattern: /captcha/i,                  reason: 'CAPTCHA challenge' },
    { pattern: /pardon our interruption/i,  reason: 'Imperva/Incapsula block' },
    { pattern: /access denied/i,            reason: 'Access Denied' },
    { pattern: /bot detected/i,             reason: 'Bot Detected' },
    { pattern: /ddos.protection/i,          reason: 'DDoS Protection' },
    { pattern: /just a moment/i,            reason: 'Cloudflare Challenge' },
  ];

  for (const signal of blockSignals) {
    if (signal.pattern.test(title) || signal.pattern.test(html.slice(0, 5000))) {
      return { isBlocked: true, reason: signal.reason, title };
    }
  }
  return { isBlocked: false, reason: null, title };
}

// ─────────────────────────────────────────────
// SCRAPER LOGIC
// ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // Load puppeteer-extra with stealth plugin
  let puppeteer;
  try {
    puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    log.success('puppeteer-extra + StealthPlugin loaded');
  } catch (_) {
    log.error('Run: npm install puppeteer-extra puppeteer-extra-plugin-stealth');
    process.exit(1);
  }

  if (!PROXY_URL) {
    log.warn('⚠️  No PROXY_URL set. AWS EC2 IPs are blocked by Housing.com.');
    log.warn('   Set env var: export PROXY_URL=http://user:pass@residential-proxy-host:port');
    log.warn('   Continuing anyway — will likely get blocked...');
  } else {
    log.info(`Proxy configured: ${PROXY_URL.replace(/:([^:@]+)@/, ':****@')}`); // mask password
  }

  log.step('PHASE 1: Scraping housing.com — Bengaluru (Network Intercept + Stealth)');

  // Build launch args
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--flag-switches-begin',
    '--disable-site-isolation-trials',
    '--flag-switches-end',
  ];
  if (PROXY_URL) {
    launchArgs.push(`--proxy-server=${PROXY_URL}`);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: launchArgs,
  });

  const allProperties = [];
  const interceptedResponses = [];
  const reports = [];

  const dedupeState = loadDedupeState(CONFIG.dedupeStateFile);
  const baseDeveloperResolver = await createDeveloperResolver(CONFIG, log);
  const apiLookups = await createApiLookups(CONFIG, baseDeveloperResolver, log);

  try {
    const page = await browser.newPage();

    // Random viewport — avoids fixed-size headless fingerprint
    const viewWidth  = 1200 + Math.floor(Math.random() * 400);
    const viewHeight = 800  + Math.floor(Math.random() * 200);
    await page.setViewport({ width: viewWidth, height: viewHeight });
    await page.setUserAgent(CHROME_UA);

    // Proxy authentication (if proxy requires user:pass)
    if (PROXY_URL) {
      try {
        const proxyParsed = new URL(PROXY_URL);
        if (proxyParsed.username && proxyParsed.password) {
          await page.authenticate({
            username: decodeURIComponent(proxyParsed.username),
            password: decodeURIComponent(proxyParsed.password),
          });
          log.info('Proxy authentication configured');
        }
      } catch (e) {
        log.warn(`Could not parse proxy credentials: ${e.message}`);
      }
    }

    // Inject stealth fingerprint scripts
    await injectStealthScripts(page);

    // Set Indian locale headers
    await setIndianHeaders(page);

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

    // ── Homepage Warmup ──
    // Visiting the homepage first seeds cookies and mimics organic browsing.
    // Skipping this is a common bot tell.
    log.info('Warming up session on housing.com homepage...');
    try {
      await page.goto('https://housing.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000 + Math.random() * 2000); // 3-5s pause
      await humanScrollDown(page);
      await sleep(2000 + Math.random() * 2000); // 2-4s pause after scroll
    } catch (e) {
      log.warn(`Warmup navigation failed: ${e.message} — continuing anyway`);
    }

    // ── Block check after warmup ──
    const warmupCheck = await detectBlock(page);
    if (warmupCheck.isBlocked) {
      log.error(`🚫 Blocked at warmup: ${warmupCheck.reason} (title: "${warmupCheck.title}")`);
      log.error('   Check your proxy — it may be burned or not routing through India.');
      await browser.close();
      process.exit(1);
    }
    log.success(`Warmup OK — page title: "${warmupCheck.title}"`);

    // ─────────────────────────────────────────────
    // STRATEGIC REFACTOR: Process Page-by-Page
    // ─────────────────────────────────────────────
    const isDetailPage = CONFIG.scrapeUrl.includes('/projects/page/') || CONFIG.scrapeUrl.includes('/buy-projects-');
    const maxPages = isDetailPage ? 1 : (CONFIG.maxPages || 5);

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const url = pageNum === 1 ? CONFIG.scrapeUrl : `${CONFIG.scrapeUrl}?page=${pageNum}`;
      log.info(`Loading page ${pageNum}: ${url}`);
      interceptedResponses.length = 0;

      try {
        // Use domcontentloaded instead of networkidle2 — less fingerprint-able
        // then wait for a known listing element instead
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (e) {
        log.warn(`Navigation error on page ${pageNum}: ${e.message}`);
      }

      // Wait for listing container OR timeout gracefully
      try {
        await page.waitForSelector(
          '[data-testid="srp-listing"], [class*="project-card"], [class*="listing-card"], article',
          { timeout: 12000 }
        );
      } catch (_) {
        log.warn(`Page ${pageNum}: listing selector not found — page may be blocked or structure changed`);
      }

      // Random thinking delay: 5-15s between pages (critical for rate limit avoidance)
      const thinkTime = 5000 + Math.random() * 10000;
      log.info(`Page ${pageNum}: thinking for ${Math.round(thinkTime / 1000)}s...`);
      await sleep(thinkTime);

      // Human scroll before extracting
      await humanScrollDown(page);
      await sleep(1500 + Math.random() * 1500);

      // Check for block screen before processing
      const blockCheck = await detectBlock(page);
      if (blockCheck.isBlocked) {
        log.error(`🚫 Page ${pageNum} blocked: ${blockCheck.reason}`);
        // Save debug screenshot
        const debugDir = path.join(process.cwd(), 'debug');
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        await page.screenshot({ path: path.join(debugDir, `block-page${pageNum}.png`), fullPage: false });
        log.error(`   Screenshot saved to debug/block-page${pageNum}.png`);
        break;
      }

      log.data(`Page ${pageNum} title: "${blockCheck.title}" — ${interceptedResponses.length} API responses intercepted`);

      // Log HTML length for diagnostics
      const html = await page.content();
      log.data(`Page ${pageNum} HTML length: ${html.length} — Has NEXT_DATA: ${html.includes('__NEXT_DATA__')}`);

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
        const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nextMatch) {
          try {
            const extracted = extractFromNextData(JSON.parse(nextMatch[1]));
            extracted.forEach(p => { p.sourceApiUrl = '__NEXT_DATA__'; propertiesOnPage.push(p); pageExtractedCount++; });
          } catch (e) {}
        }
      }
      log.success(`Page ${pageNum}: ${pageExtractedCount} projects extracted`);

      if (propertiesOnPage.length > 0) {
        log.info(`  Processing and submitting ${propertiesOnPage.length} projects from Page ${pageNum}...`);
        for (const prop of propertiesOnPage) {
          const res = await processAndSubmit(prop, dryRun, apiLookups, dedupeState);
          reports.push(res);
        }
      }

      if (reports.length >= (CONFIG.limit || 10)) break;
    }

    if (reports.length === 0) {
      log.warn('  No projects in JSON. Falling back to DOM extraction...');
      const html = await page.content();
      const rawCards = await page.evaluate(() => {
        const h1 = document.querySelector('h1')?.innerText?.trim();
        if (window.location.href.includes('/projects/page/') && h1) {
          const imgs = Array.from(document.querySelectorAll('img[src*="housing"]'))
            .map(img => img.src).filter(s => s && s.startsWith('http')).slice(0, 8);
          return [{ projectName: h1, websiteUrl: window.location.href, description: h1 + ' - Residential Project', imageUrls: imgs }];
        }
        return Array.from(document.querySelectorAll('article, [class*="project-card"], [class*="listing-card"]')).map(el => {
          const name = el.querySelector('h1, h2, h3, [class*="title"], [class*="name"]')?.innerText?.trim();
          const url = el.querySelector('a')?.href;
          if (!name || name.length < 5 || !url) return null;
          return { projectName: name, websiteUrl: url, description: name + ' - Premium Project', imageUrls: [] };
        }).filter(x => x && !/%| off|Paints/i.test(x.projectName));
      });

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
          latitude:    0,
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

  const successCount = reports.filter(r => r.success).length;
  const skipCount = reports.filter(r => !r.success).length;
  log.success(`Total processed: ${reports.length} (Success: ${successCount}, Skipped: ${skipCount})`);

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
