/**
 * PropSync — housing.com Scraper + RE Projects API Submitter
 *
 * Usage:
 *   node scraper.js                  # Scrape + submit all
 *   node scraper.js --dry-run        # Scrape + show payload, no POST
 *   node scraper.js --scrape-only    # Only scrape, save to scraped.json
 *   node scraper.js --submit-only    # Submit from existing scraped.json
 */

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');
const fs    = require('fs');
const { loadRuntimeConfig } = require('./runtime-config');
const { createDeveloperResolver } = require('./developer-utils');
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
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = loadRuntimeConfig('housing', process.argv.slice(2));
CONFIG.headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'max-age=0',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

// ─────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────
const log = {
  info:    (msg) => console.log(`\x1b[36m[INFO]\x1b[0m  ${msg}`),
  success: (msg) => console.log(`\x1b[32m[OK]\x1b[0m    ${msg}`),
  warn:    (msg) => console.log(`\x1b[33m[WARN]\x1b[0m  ${msg}`),
  error:   (msg) => console.log(`\x1b[31m[ERR]\x1b[0m   ${msg}`),
  data:    (msg) => console.log(`\x1b[35m[DATA]\x1b[0m  ${msg}`),
  step:    (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`),
};

// ─────────────────────────────────────────────
// HTTP GET with gzip/br decompression + redirect follow
// ─────────────────────────────────────────────
function httpGet(url, extraHeaders = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));

    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { ...CONFIG.headers, ...extraHeaders },
      timeout: 25000,
    };

    const req = lib.request(options, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsedUrl.protocol}//${parsedUrl.hostname}${res.headers.location}`;
        log.info(`Redirect → ${redirectUrl}`);
        return resolve(httpGet(redirectUrl, extraHeaders, redirectCount + 1));
      }

      // Decompress response
      const encoding = res.headers['content-encoding'];
      let stream = res;
      if (encoding === 'gzip')         stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br')      stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }));
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

// ─────────────────────────────────────────────
// FILE HELPERS
// ─────────────────────────────────────────────
function downloadImage(url) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith('http')) return resolve(null);
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) return resolve(null);
      
      const contentType = res.headers['content-type'] || '';
      if (!contentType.startsWith('image/')) return resolve(null);

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 30720) return resolve(null); // skip small images < 30KB
        resolve(buffer);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function mimeType(url = '') {
  if (url.includes('.png')) return 'image/png';
  if (url.includes('.webp')) return 'image/webp';
  if (url.includes('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function getPlaceholderImage() {
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kK/8AAAAASUVORK5CYII=',
    'base64'
  );
  return [{
    fieldName: 'images[0].file',
    fileName: 'property.png',
    mimeType: 'image/png',
    buffer: png1x1,
  }];
}

// ─────────────────────────────────────────────
// MULTIPART FORM-DATA BUILDER
// ─────────────────────────────────────────────
function buildMultipart(fields, files = []) {
  const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
  const parts = [];
  const CRLF = Buffer.from('\r\n');

  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`
    ));
  }

  for (const file of files) {
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`
    );
    parts.push(Buffer.concat([header, file.buffer, CRLF]));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ─────────────────────────────────────────────
// POST FORM-DATA TO API
// ─────────────────────────────────────────────
function postFormData(url, fields, files = []) {
  return new Promise((resolve, reject) => {
    const { body, contentType } = buildMultipart(fields, files);
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Accept': 'application/json',
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// RERA NUMBER GENERATOR
// ─────────────────────────────────────────────
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
// PARSERS
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// PARSERS
// ─────────────────────────────────────────────
function parseHousingComPage(html) {
  const properties = [];

  // Strategy 1: __NEXT_DATA__ JSON blob (most reliable for Next.js apps)
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const nextData = JSON.parse(nextMatch[1]);
      const extracted = extractFromNextData(nextData);
      properties.push(...extracted);
      if (extracted.length > 0) log.data(`  → __NEXT_DATA__: ${extracted.length} projects found`);
    } catch (e) {
      log.warn(`  __NEXT_DATA__ parse error: ${e.message}`);
    }
  }

  // Strategy 2: JSON-LD structured data
  if (properties.length === 0) {
    const jsonLdRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let jm;
    while ((jm = jsonLdRe.exec(html)) !== null) {
      try {
        const parsed = JSON.parse(jm[1]);
        const block = parsed['@graph'] ? parsed['@graph'] : [parsed];
        block.forEach(item => {
          if (['ApartmentComplex','Residence','RealEstateListing', 'SingleFamilyResidence', 'Place'].includes(item['@type'])) {
            const prop = parseJsonLdBlock(item);
            if (prop) properties.push(prop);
          }
        });
      } catch (_) {}
    }
    if (properties.length > 0) log.data(`  → JSON-LD: ${properties.length} projects found`);
  }

  // Strategy 3: HTML card fallback
  if (properties.length === 0) {
    log.warn('  → Falling back to HTML card parsing');
    properties.push(...parseHtmlCards(html));
  }

  // Deduplicate by name
  const seen = new Set();
  return properties.filter(p => {
    if (!p.projectName || p.projectName.length < 3) return false;
    if (seen.has(p.projectName)) return false;
    seen.add(p.projectName);
    return true;
  });
}

function extractFromNextData(obj, depth = 0, results = []) {
  if (depth > 12 || !obj || typeof obj !== 'object') return results;

  // Detect a project object (Simplified back to original working state)
  const name = obj.projectName || obj.project_name || obj.entityProjectName;
  if (name && typeof name === 'string' && name.length > 3) {
    const loc = obj.location || obj.address || {};
    const coords = Array.isArray(obj.coords) ? obj.coords : [];
    const descText = toText(obj.description || obj.tagline || `${name} - Premium residential project`);
    const areaText = toText(loc.area || loc.locality || loc.addressLocality || obj.displayNeighbourhood || 'Bengaluru');
    
    results.push({
      projectName: decodeHtml(name),
      description: descText,
      developerName: sanitizeDeveloperCandidate(toText(obj.developerName || obj.builderName || (obj.developer && obj.developer.name))),
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
      amenityIds: extractAmenities(obj),
    });
  }

  const items = Array.isArray(obj) ? obj : Object.values(obj);
  items.slice(0, 60).forEach(v => extractFromNextData(v, depth + 1, results));
  return results;
}

function parseJsonLdBlock(block) {
  const name = block.name || block.headline;
  if (!name) return null;
  const address = block.address || {};
  const geo = block.geo || {};
  return {
    projectName: decodeHtml(name),
    description: decodeHtml(block.description || `${name} - Premium residential project`),
    reraNumber: generateReraNumber(),
    location: {
      zone: CONFIG.api.defaultZone,
      area: decodeHtml(address.addressLocality || address.streetAddress || 'Bengaluru'),
      city: decodeHtml(address.addressRegion || CONFIG.api.defaultCity),
      latitude: parseFloat(geo.latitude) || 12.9698,
      longitude: parseFloat(geo.longitude) || 77.7501,
    },
    unitTypes: deriveUnitTypes(block),
    amenityIds: CONFIG.api.amenityIds,
  };
}

function parseHtmlCards(html) {
  const props = [];
  const cardRe = /<(?:article|div)[^>]*class="[^"]*(?:project|listing)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div)>/gi;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const card = m[1];
    const nameM = card.match(/<h[123][^>]*>([^<]{5,80})<\/h[123]>/);
    if (!nameM) continue;
    const locM  = card.match(/class="[^"]*(?:locality|location|area)[^"]*"[^>]*>([^<]+)</);
    const name  = decodeHtml(nameM[1]);
    const area  = locM ? decodeHtml(locM[1]) : 'Bengaluru';
    const bhks  = [...new Set((card.match(/(\d)\s*BHK/gi) || []).map(b => parseInt(b)))].sort();
    props.push({
      projectName: name,
      description: `${name} - Premium residential project in ${area}`,
      reraNumber: generateReraNumber(),
      location: { zone: CONFIG.api.defaultZone, area, city: CONFIG.api.defaultCity, latitude: 12.9698, longitude: 77.7500 },
      unitTypes: bhks.length > 0 ? bhks.map((b) => ({ unitTypeId: b, sizeSqft: 1200, priceMin: 0.85, priceMax: 1.20, priceUnit: 'Cr' })) : [{ unitTypeId: 2, sizeSqft: 1200, priceMin: 0.85, priceMax: 1.20, priceUnit: 'Cr' }],
      amenityIds: CONFIG.api.amenityIds,
    });
  }
  return props;
}

function deriveUnitTypes(obj) {
  const units = [];
  const add = (id, size, min, max, unit) => {
    units.push({ unitTypeId: id, sizeSqft: size || 1200, priceMin: min, priceMax: max, priceUnit: unit || 'Cr' });
  };

  // Extract from config data
  if (obj.config && Array.isArray(obj.config)) {
    obj.config.forEach(c => {
      const bhk = parseInt(c.name) || 2;
      const id = bhk === 1 ? 1 : bhk === 2 ? 2 : bhk === 3 ? 3 : 4;
      const price = c.price || {};
      add(id, c.area?.value, price.min, price.max, price.unit);
    });
  }

  // Fallback
  if (units.length === 0) {
    add(2, 1200, 0.85, 1.20, 'Cr');
  }
  return units;
}

function extractMedia(obj) {
  const images = [];
  const videos = [];
  const add = (url) => {
    if (!url || typeof url !== 'string') return;
    const clean = url.trim();
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
    imageUrls: [...new Set(images)].slice(0, CONFIG.maxImagesPerProject),
    videoUrls: [...new Set(videos)].slice(0, 5)
  };
}

function extractAmenities(obj) {
  const amenityIds = new Set(CONFIG.api.amenityIds || []);
  const walk = (node, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) { node.forEach(v => walk(v, depth + 1)); return; }
    if (typeof node === 'object') {
      if (node.label && typeof node.label === 'string') {
        const lower = node.label.toLowerCase();
        if (lower.includes('pool')) amenityIds.add(6);
        if (lower.includes('gym')) amenityIds.add(5);
        if (lower.includes('club')) amenityIds.add(5);
      }
      Object.values(node).slice(0, 40).forEach(v => walk(v, depth + 1));
    }
  };
  walk(obj.amenities); walk(obj.projectAmenities); walk(obj.config?.amenities);
  return [...amenityIds];
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
  // Try description: "by Developer Name in"
  const m = desc.match(/by\s+([^,]+?)\s+in/i);
  if (m) return m[1].trim();
  
  // Try URL: "...-by-developer-name-in-..."
  const um = url.match(/-by-([a-z-]+)-in-/i);
  if (um) return um[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  return '';
}

// ─────────────────────────────────────────────
// DATA NORMALIZER & PAYLOAD BUILDER
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

  cfg.amenityIds.forEach((id, i) => { fields[`amenityIds[${i}]`] = id; });

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

// ─────────────────────────────────────────────
// SCRAPER
// ─────────────────────────────────────────────
async function scrapeHousingCom() {
  log.step('PHASE 1: Scraping housing.com — Bengaluru');
  const allProperties = [];

  for (let page = 1; page <= CONFIG.maxPages; page++) {
    const url = page === 1 ? CONFIG.scrapeUrl : `${CONFIG.scrapeUrl}?page=${page}`;
    log.info(`Loading page ${page}: ${url}`);

    try {
      const { statusCode, body } = await httpGet(url);
      
      if (statusCode === 403) {
        log.error('Access Forbidden (403). housing.com might be blocking this IP/User-Agent.');
        break;
      }

      if (statusCode !== 200) {
        log.warn(`Unexpected status ${statusCode}, skipping`);
        continue;
      }

      const pageProps = parseHousingComPage(body);
      log.success(`Page ${page}: ${pageProps.length} properties extracted`);
      pageProps.forEach(p => log.data(`  • ${p.projectName} — ${p.location.area}`));
      allProperties.push(...pageProps);

    } catch (err) {
      log.error(`Page ${page} failed: ${err.message}`);
    }

    if (page < CONFIG.maxPages) {
      log.info(`Waiting ${CONFIG.requestDelay}ms...`);
      await sleep(CONFIG.requestDelay);
    }
  }

  const limited = CONFIG.limit ? allProperties.slice(0, CONFIG.limit) : allProperties;
  if (CONFIG.limit) {
    log.info(`Applying limit=${CONFIG.limit}. Using ${limited.length} of ${allProperties.length} scraped properties.`);
  }
  log.success(`\nTotal scraped: ${limited.length} properties`);
  return limited;
}

// ─────────────────────────────────────────────
// SUBMITTER
// ─────────────────────────────────────────────
async function submitProperties(properties, dryRun = false) {
  log.step('PHASE 2: Submitting to API');
  log.info(`Endpoint : ${CONFIG.apiUrl}`);
  log.info(`Dry run  : ${dryRun}`);
  log.info(`Total    : ${properties.length} properties\n`);

  const results = { success: [], failed: [], skipped: [] };
  const dedupeState = loadDedupeState(CONFIG.dedupeStateFile);
  const runSeen = new Set();
  let remoteLookupEnabled = Boolean(CONFIG.projectExistsUrlTemplate);
  let remoteLookupFailures = 0;
  const developerResolver = await createDeveloperResolver(CONFIG, log);

  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i];
    prop.sourceType = prop.sourceType || CONFIG.sourceType;
    prop.sourceName = prop.sourceName || CONFIG.source;
    prop.websiteUrl = prop.websiteUrl || CONFIG.scrapeUrl;
    prop.sourceUpdatedAt = prop.sourceUpdatedAt || new Date().toISOString();

    log.info(`[${i + 1}/${properties.length}] "${prop.projectName}"`);

    const dedupeKey = normalizeProjectKey(prop.projectName);
    if (!dedupeKey) {
      log.warn('  Skipped: invalid project name');
      results.skipped.push({ property: prop.projectName, reason: 'invalid-name' });
      continue;
    }
    if (runSeen.has(dedupeKey)) {
      log.warn('  Skipped: duplicate in current run');
      results.skipped.push({ property: prop.projectName, reason: 'duplicate-in-run' });
      continue;
    }
    runSeen.add(dedupeKey);

    if (hasSeenProject(dedupeState, prop.projectName)) {
      log.warn('  Skipped: already submitted earlier (local dedupe state)');
      results.skipped.push({ property: prop.projectName, reason: 'local-dedupe' });
      continue;
    }

    if (remoteLookupEnabled) {
      try {
        const lookup = await checkProjectExistsInDb(
          CONFIG.projectExistsUrlTemplate,
          CONFIG.projectExistsMethod,
          prop.projectName
        );
        if (lookup.checked && lookup.exists) {
          log.warn('  Skipped: project already exists in DB');
          markSeenProject(dedupeState, prop.projectName, {
            source: prop.sourceName,
            sourceName: prop.sourceName,
            sourceType: prop.sourceType,
            updatedAt: prop.sourceUpdatedAt,
            projectName: prop.projectName,
          });
          results.skipped.push({ property: prop.projectName, reason: 'exists-in-db' });
          continue;
        }
      } catch (err) {
        remoteLookupFailures++;
        log.warn(`  DB duplicate-check failed: ${err.message}`);
        if (remoteLookupFailures >= 2) {
          remoteLookupEnabled = false;
          log.warn('  Disabling DB duplicate-check for this run (too many failures).');
        }
      }
    }

    const imageUrls = [...new Set((prop.imageUrls || []).filter((u) => /^https?:\/\//i.test(u)))]
      .slice(0, CONFIG.maxImagesPerProject);

    let files = [];
    if (!dryRun) {
      for (let imgIndex = 0; imgIndex < imageUrls.length; imgIndex++) {
        const imgUrl = imageUrls[imgIndex];
        const imgBuffer = await downloadImage(imgUrl);
        if (!imgBuffer) continue;
        const ext = imgUrl.includes('.png') ? 'png' : imgUrl.includes('.webp') ? 'webp' : 'jpg';
        files.push({
          fieldName: `images[${files.length}].file`,
          fileName: `property-${i}-${files.length}.${ext}`,
          mimeType: mimeType(imgUrl),
          buffer: imgBuffer,
        });
      }
      if (files.length === 0) {
        files = getPlaceholderImage();
      }
    }

    const imageCount = dryRun ? Math.max(1, imageUrls.length || 1) : Math.max(1, files.length);
    const developerResolution = developerResolver.resolve(prop.developerName);
    const fields = buildFormFields(prop, imageCount, developerResolution.developerId);
    if (developerResolution.matchedBy === 'fallback') {
      log.warn(`  Developer fallback used for "${prop.projectName}"${prop.developerName ? ` (${prop.developerName})` : ''}`);
    } else {
      log.data(`  Developer : ${developerResolution.developerName} -> ${developerResolution.developerId} (${developerResolution.matchedBy})`);
    }

    if (dryRun) {
      console.log('\x1b[90m' + '-'.repeat(60) + '\x1b[0m');
      Object.entries(fields).forEach(([k, v]) => {
        console.log(`  \x1b[33m${k.padEnd(35)}\x1b[0m ${v}`);
      });
      console.log('\x1b[90m' + '-'.repeat(60) + '\x1b[0m\n');
      results.success.push({ property: prop.projectName, status: 'dry-run' });
      continue;
    }

    try {
      const { statusCode, body } = await postFormData(CONFIG.apiUrl, fields, files);
      if (statusCode >= 200 && statusCode < 300) {
        log.success(`  OK HTTP ${statusCode}`);
        try { log.data(`  ${JSON.stringify(JSON.parse(body)).slice(0, 120)}`); } catch (_) { log.data(`  ${body.slice(0, 120)}`); }
        results.success.push({ property: prop.projectName, statusCode, response: body });
        markSeenProject(dedupeState, prop.projectName, {
          source: prop.sourceName,
          sourceName: prop.sourceName,
          sourceType: prop.sourceType,
          updatedAt: prop.sourceUpdatedAt,
          projectName: prop.projectName,
        });
      } else if (isLikelyDuplicateError(statusCode, body)) {
        log.warn(`  Skipped duplicate (HTTP ${statusCode})`);
        results.skipped.push({ property: prop.projectName, reason: 'duplicate-response', statusCode });
        markSeenProject(dedupeState, prop.projectName, {
          source: prop.sourceName,
          sourceName: prop.sourceName,
          sourceType: prop.sourceType,
          updatedAt: prop.sourceUpdatedAt,
          projectName: prop.projectName,
        });
      } else {
         log.error(`  FAIL HTTP ${statusCode}: ${body.slice(0, 200)}`);
        results.failed.push({ property: prop.projectName, statusCode, error: body });
      }
    } catch (err) {
      log.error(`  FAIL ${err.message}`);
      results.failed.push({ property: prop.projectName, error: err.message });
    }

    await sleep(500);
  }

  if (!dryRun) {
    saveDedupeState(CONFIG.dedupeStateFile, dedupeState);
    log.info(`Dedupe state saved -> ${CONFIG.dedupeStateFile}`);
  }

  return results;
}

async function main() {
  const args        = process.argv.slice(2);
  const scrapeOnly  = args.includes('--scrape-only');
  const submitOnly  = args.includes('--submit-only');
  const dryRun      = args.includes('--dry-run');

  console.log('\n\x1b[1m\x1b[33m  PropSync — housing.com → RE Projects API\x1b[0m');
  console.log('  ─────────────────────────────────────────\n');

  const lookback = CONFIG.window.lookbackDays != null
    ? `${CONFIG.window.lookbackDays} days`
    : `${CONFIG.window.lookbackHours} hours`;
  log.info(`Mode: ${CONFIG.window.mode} | Lookback: ${lookback} | Since: ${CONFIG.window.sinceIso}`);

  let properties = [];

  if (!submitOnly) {
    properties = await scrapeHousingCom();

    if (properties.length === 0) {
      log.warn('No properties scraped.');
      log.warn('housing.com blocks plain HTTP. Use Puppeteer instead:');
      log.warn('  npm install puppeteer');
      log.warn('  node scraper-puppeteer.js --dry-run');
      process.exit(1);
    }

    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(properties, null, 2));
    log.success(`Scraped data saved → ${CONFIG.outputFile}`);
    if (scrapeOnly) { log.info('--scrape-only: done.'); return; }
  } else {
    if (!fs.existsSync(CONFIG.outputFile)) {
      log.error(`scraped.json not found. Run without --submit-only first.`);
      process.exit(1);
    }
    properties = JSON.parse(fs.readFileSync(CONFIG.outputFile, 'utf8'));
    if (CONFIG.limit) {
      properties = properties.slice(0, CONFIG.limit);
    }
    log.info(`Loaded ${properties.length} properties from ${CONFIG.outputFile}`);
  }

  const results = await submitProperties(properties, dryRun);

  log.step('━━━ SUMMARY ━━━');
  log.success(`Submitted OK : ${results.success.length}`);
  log.info(`Skipped      : ${results.skipped.length}`);
  if (results.failed.length > 0) {
    log.error(`Failed       : ${results.failed.length}`);
    results.failed.forEach(f => log.error(`  • ${f.property}: ${f.error || f.statusCode}`));
  }

  fs.writeFileSync(CONFIG.reportFile, JSON.stringify(results, null, 2));
  log.info(`Report saved → ${CONFIG.reportFile}`);
}

main().catch(err => {
  log.error('Fatal: ' + err.message);
  process.exit(1);
});
