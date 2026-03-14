/**
 * PropSync — housing.com Deep Puppeteer Scraper + RE Projects API Submitter
 *
 * This version visits each project page to get full details.
 * Usage:
 *   node scraper-puppeteer-housing-deep.js --limit=10
 */

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
// CONFIG
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

// Download image from URL → returns Buffer
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
        if (buffer.length < 30720) return resolve(null); // 30KB
        resolve(buffer);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function checkImageSize(urlStr) {
  return new Promise((resolve) => {
    if (!urlStr || !urlStr.startsWith('http')) return resolve(0);
    const lib = urlStr.startsWith('https') ? https : http;
    const { URL } = require('url');
    try {
      const parsed = new URL(urlStr);
      
      // Attempt HEAD first
      const reqHead = lib.request({ method: 'HEAD', hostname: parsed.hostname, path: parsed.pathname + parsed.search, timeout: 2000 }, resHead => {
         const len = parseInt(resHead.headers['content-length'] || '0', 10);
         if (len > 0) {
             return resolve(len);
         } else {
             // Fallback to GET and measure chunk sizes
             const reqGet = lib.request({ method: 'GET', hostname: parsed.hostname, path: parsed.pathname + parsed.search, timeout: 2000 }, resGet => {
                 let bytesReceived = 0;
                 resGet.on('data', chunk => {
                     bytesReceived += chunk.length;
                     // As soon as it hits 30KB, abort to save bandwidth
                     if (bytesReceived > 30720) {
                         reqGet.destroy();
                         resolve(bytesReceived);
                     }
                 });
                 resGet.on('end', () => resolve(bytesReceived));
             });
             reqGet.on('error', () => resolve(0));
             reqGet.on('timeout', () => { reqGet.destroy(); resolve(0); });
             reqGet.end();
         }
      });
      reqHead.on('error', () => resolve(0));
      reqHead.on('timeout', () => { reqHead.destroy(); resolve(0); });
      reqHead.end();
    } catch(e) { resolve(0); }
  });
}

function mimeType(url = '') {
  if (url.includes('.png'))  return 'image/png';
  if (url.includes('.webp')) return 'image/webp';
  if (url.includes('.gif'))  return 'image/gif';
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

function generateReraNumber(dedupeState) {
  if (!dedupeState.reraCounter) dedupeState.reraCounter = 120000;
  dedupeState.reraCounter++;
  return `PRM/KA/RERA/1251/308/PR/220123/${String(dedupeState.reraCounter).padStart(6, '0')}`;
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
function extractFromNextData(obj, depth = 0, results = [], dedupeState = {}) {
  if (depth > 12 || !obj || typeof obj !== 'object') return results;

  // Detect a project object
  const name =
    toText(obj.projectName) ||
    toText(obj.project_name) ||
    toText(obj.entityProjectName) ||
    toText(obj.title) ||
    toText(obj.name) ||
    toText(obj.project?.name);
  
  const idMatch = obj.listingId || obj.project?.id || obj.id;
  const hasProjectSignal = Boolean(
    idMatch ||
    obj.propertyType ||
    obj.displayPrice ||
    obj.coords ||
    (typeof obj.url === 'string' && /\/projects?\/page\//i.test(obj.url))
  );

  if (name && typeof name === 'string' && name.length > 3 && hasProjectSignal) {
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
      reraNumber: obj.reraId || obj.rera_id || obj.reraNumber || generateReraNumber(dedupeState),
      websiteUrl: toAbsoluteUrl(obj.url || obj.inventoryCanonicalUrl || obj.micrositeRedirectionURL || CONFIG.scrapeUrl),
      sourceType: CONFIG.sourceType,
      sourceName: CONFIG.source,
      sourceUpdatedAt: toIsoDate(obj.updatedAt || obj.lastUpdated || obj.postedDate),
      ...extractMedia(obj),
      location: {
        zone: loc.zone || CONFIG.api.defaultZone,
        area: areaText,
        city: decodeHtml(toText(loc.city) || toText(loc.addressRegion) || ''),
        latitude: parseFloat(loc.latitude || loc.lat || coords[0]) || 0,
        longitude: parseFloat(loc.longitude || loc.lng || coords[1]) || 0,
      },
      unitTypes: deriveUnitTypes(obj),
      amenityIds: extractAmenities(obj),
    });
  }

  const items = Array.isArray(obj) ? obj : Object.values(obj);
  items.slice(0, 80).forEach(v => extractFromNextData(v, depth + 1, results, dedupeState));
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
      add(id, c.area?.value, price.min ?? 0.85, price.max ?? 1.20, price.unit);
    });
  }
  if (units.length === 0) { 
      // Do not use hardcoded dummy configs
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
    if (Array.isArray(node)) { node.forEach((v) => walk(v, depth + 1)); return; }
    if (typeof node !== 'object') return;
    add(node.src); add(node.url); add(node.image); add(node.imageUrl); add(node.original); add(node.thumbnail);
    Object.values(node).forEach((v) => walk(v, depth + 1));
  };
  walk(obj.coverImage); walk(obj.images); walk(obj.details?.images); walk(obj.gallery); walk(obj.imageGallery); walk(obj.projectImages);
  return {
    imageUrls: [...new Set(images)].slice(0, CONFIG.maxImagesPerProject),
    videoUrls: [...new Set(videos)].slice(0, 5)
  };
}

function extractAmenities(obj) {
  const amenityIds = new Set();
  const walk = (node, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) { node.forEach(v => walk(v, depth + 1)); return; }
    if (typeof node === 'object') {
      if (node.label && typeof node.label === 'string') {
        const lower = node.label.toLowerCase();
        // Skip hardcoding amenity ids based on label keywords
      }
      Object.values(node).forEach(v => walk(v, depth + 1));
    }
  };
  walk(obj.amenities); walk(obj.projectAmenities); walk(obj.config?.amenities);
  return [...amenityIds];
}

function toText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && v.label) return v.label;
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
// BUILD FORM FIELDS
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
  fields['constructionStatusId']  = cfg.constructionStatusid || 1;
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
      headers: { 'Content-Type': contentType, 'Content-Length': body.length, 'Accept': 'application/json' },
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
// MAIN
// ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limit = CONFIG.limit || 10;

  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch (_) { log.error('Run: npm install puppeteer'); process.exit(1); }

  log.step('PHASE 1: Collecting project URLs — housing.com');

  // Use plain HTTPS instead of browser for Phase 1 (search page is too heavy for headless Chromium)
  async function fetchSearchPageUrls(pageNum) {
    return new Promise((resolve) => {
      const pageParam = pageNum === 1 ? '' : `?page=${pageNum}`;
      const searchUrl = `${CONFIG.scrapeUrl}${pageParam}`;
      log.info(`  Fetching search page ${pageNum}: ${searchUrl}`);
      const { URL } = require('url');
      const parsed = new URL(searchUrl);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      };
      const req = https.request(options, (res) => {
        let html = '';
        res.on('data', chunk => { html += chunk; });
        res.on('end', () => {
          // Extract project URLs from JSON-LD ItemList first
          const found = new Set();
          const jsonLdMatches = html.match(/application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
          jsonLdMatches.forEach(block => {
            try {
              const json = JSON.parse(block.replace(/application\/ld\+json[^>]*>/i, '').replace(/<\/script>$/i, ''));
              const items = Array.isArray(json) ? json : [json];
              items.forEach(item => {
                if (item['@type'] === 'ItemList' && item.itemListElement) {
                  item.itemListElement.forEach(el => { if (el.url) found.add(el.url); });
                }
              });
            } catch(e) {}
          });
          // Fallback: regex-extract project page links from raw HTML
          if (found.size === 0) {
            const linkMatches = html.match(/https?:\/\/housing\.com\/in\/buy\/projects\/page\/[a-z0-9-]+/gi) || [];
            linkMatches.forEach(u => found.add(u));
          }
          log.info(`  Page ${pageNum}: found ${found.size} URLs`);
          resolve([...found]);
        });
      });
      req.on('error', (e) => { log.warn(`  Page ${pageNum} fetch error: ${e.message}`); resolve([]); });
      req.on('timeout', () => { req.destroy(); log.warn(`  Page ${pageNum} timed out`); resolve([]); });
      req.end();
    });
  }

  const projectUrls = new Set();
  for (let pageNum = 1; pageNum <= 3; pageNum++) {
    const urls = await fetchSearchPageUrls(pageNum);
    urls.forEach(u => projectUrls.add(u));
    if (projectUrls.size >= limit) break;
    await sleep(1500);
  }
  log.info(`Total unique project URLs collected: ${projectUrls.size}`);

  const targetUrls = [...projectUrls].slice(0, limit);
  log.step(`PHASE 2: Detailed Scraping — visiting ${targetUrls.length} project pages`);
  
  const allProperties = [];
  const dedupeState = loadDedupeState(CONFIG.dedupeStateFile);

    for (let i = 0; i < targetUrls.length; i++) {
      const url = targetUrls[i];
      log.info(`[${i+1}/${targetUrls.length}] Visiting: ${url}`);
      
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3500);
        
        const pageData = await page.evaluate(() => {
            const data = {
                projectName: document.title.split(' in ')[0].trim(),
                description: '',
                metaDesc: '',
                jsonLd: [],
                ogImage: '',
                twitterImage: '',
                amenities: [],
                documents: [],
                images: [],
                developer: '',
                projectArea: '',
                projectUnits: 0,
                domSizes: '',
                locationText: '',
                lat: 0,
                lng: 0,
            };
            
            const metaD = document.querySelector('meta[name="description"]');
            if (metaD) data.description = metaD.getAttribute('content');
            
            const ogT = document.querySelector('meta[property="og:title"]');
            if (ogT) data.projectName = ogT.getAttribute('content').split(' in ')[0].trim();

            const ogD = document.querySelector('meta[property="og:description"]');
            if (ogD) data.metaDesc = ogD.getAttribute('content');

            const ogI = document.querySelector('meta[property="og:image"]');
            if (ogI) data.ogImage = ogI.getAttribute('content');

            const twI = document.querySelector('meta[name="twitter:image:src"]');
            if (twI) data.twitterImage = twI.getAttribute('content');

            document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
                try {
                    const parsed = JSON.parse(s.textContent);
                    if (Array.isArray(parsed)) data.jsonLd.push(...parsed);
                    else data.jsonLd.push(parsed);
                } catch(e) {}
            });

            // Extract amenities from DOM
            document.querySelectorAll('[class*="amenit" i], [class*="facilit" i]').forEach(el => {
                const txt = el.textContent.trim();
                const invalidJunk = ["request detail", "view", "more", "amenities", "facilities", "features"];
                const isJunk = invalidJunk.some(j => txt.toLowerCase().includes(j));
                // Filter out large blocks of text, keep only short labels
                if (txt && txt.length > 2 && txt.length < 40 && !txt.includes('\n') && !isJunk) {
                    data.amenities.push(txt);
                }
            });

            // Extract location from DOM — parse full address text, lat/lon
            const locEl = document.querySelector('[class*="address" i], [class*="location" i]');
            data.locationText = locEl ? locEl.textContent.trim() : '';

            // Try to extract lat/lon from embedded scripts (housing.com stores them in __NEXT_DATA__ or map scripts)
            if (!data.lat) {
                const scripts = document.querySelectorAll('script:not([src])');
                for (const s of scripts) {
                    const m = s.textContent.match(/"lat(?:itude)?"\s*:\s*([\d.]+).*?"lo?ng(?:itude)?"\s*:\s*([\d.]+)/s);
                    if (m) { data.lat = parseFloat(m[1]); data.lng = parseFloat(m[2]); break; }
                    // Also try coords array pattern
                    const m2 = s.textContent.match(/"coords"\s*:\s*\[([\d.]+),\s*([\d.]+)\]/);
                    if (m2) { data.lat = parseFloat(m2[1]); data.lng = parseFloat(m2[2]); break; }
                }
            }

            // Extract document/brochure links
            document.querySelectorAll('a[href$=".pdf" i]').forEach(a => {
                const href = a.href;
                if (!data.documents.includes(href)) data.documents.push(href);
            });

            // Extract generic image tags from the gallery or the page
            document.querySelectorAll('img').forEach(img => {
                const src = img.src || img.getAttribute('data-src');
                if (src && src.startsWith('http') && !src.includes('logo') && !src.includes('avatar') && !src.includes('icon')) {
                    // Try to remove query params that thumbnail images
                    const cleanSrc = src.split('?')[0];
                    if (!data.images.includes(cleanSrc)) data.images.push(cleanSrc);
                }
            });

            // Extract project area, units, and sizes
            document.querySelectorAll('div, span, p').forEach(el => {
                const text = el.textContent.trim();
                if (text === 'Project Units') {
                    const val = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
                    if (val && !data.projectUnits) data.projectUnits = parseInt(val.textContent.replace(/\\D/g, '')) || 0;
                }
                if (text === 'Project Area') {
                    const val = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
                    if (val && !data.projectArea) data.projectArea = val.textContent.trim();
                }
                if (text === 'Sizes') {
                    const val = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
                    if (val && !data.domSizes) data.domSizes = val.textContent.trim();
                }
            });

            return data;
        });

        let finalProp = null;
        const projectBase = pageData.jsonLd.find(item => 
            (Array.isArray(item['@type']) && (item['@type'].includes('ApartmentComplex') || item['@type'].includes('RealEstateProject'))) ||
            item['@type'] === 'ApartmentComplex' ||
            item['@type'] === 'RealEstateProject' ||
            item['@type'] === 'Product'
        );

        if (projectBase) {
            const extracted = extractFromNextData(projectBase, 0, [], dedupeState);
            if (extracted.length > 0) {
                finalProp = extracted[0];
                if (!finalProp.description || finalProp.description.length < 50) {
                    finalProp.description = pageData.description || pageData.metaDesc || finalProp.description;
                }
            }
        }

        if (!finalProp) {
            const html = await page.content();
            const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (nextMatch) {
                const nextData = JSON.parse(nextMatch[1]);
                const nextExtracted = extractFromNextData(nextData, 0, [], dedupeState);
                if (nextExtracted.length > 0) finalProp = nextExtracted[0];
            }
        }

        if (!finalProp && pageData.projectName) {
            log.info(`  Falling back to DOM extraction for: ${pageData.projectName}`);

            // Parse the scraped address text into structured location fields
            const addrParts = (pageData.locationText || '').split(',').map(p => p.trim()).filter(Boolean);
            const parsedCity = addrParts.find(p => /bengaluru|bangalore|mysuru|mysore|hubli|mangalore|chennai|pune|mumbai|delhi/i.test(p)) || 'Bengaluru';
            const parsedArea = addrParts.slice(0, Math.max(1, addrParts.length - 2)).join(', ') || pageData.locationText || '';
            const addrLower = (pageData.locationText || '').toLowerCase();
            let parsedZone = CONFIG.api.defaultZone || 'East';
            if (/north/i.test(addrLower)) parsedZone = 'North';
            else if (/south/i.test(addrLower)) parsedZone = 'South';
            else if (/west/i.test(addrLower)) parsedZone = 'West';
            else if (/east/i.test(addrLower)) parsedZone = 'East';
            else if (/central|city centre/i.test(addrLower)) parsedZone = 'Central';

            finalProp = {
                projectName: pageData.projectName,
                description: pageData.description || pageData.metaDesc || `${pageData.projectName} - Premium residential project in Bengaluru`,
                developerName: extractDeveloperName(pageData.description || '', url) || pageData.projectName,
                reraNumber: generateReraNumber(dedupeState),
                websiteUrl: url,
                sourceType: CONFIG.sourceType,
                sourceName: CONFIG.source,
                sourceUpdatedAt: new Date().toISOString(),
                imageUrls: [...new Set([pageData.ogImage, ...pageData.images])].filter(Boolean),
                videoUrls: [],
                documents: pageData.documents || [],
                location: {
                    zone: parsedZone,
                    area: parsedArea.substring(0, 150),
                    city: parsedCity,
                    latitude: pageData.lat || 0,
                    longitude: pageData.lng || 0,
                },
                unitTypes: [],
                amenitiesExtracted: [...new Set(pageData.amenities)],
            };
        } else if (finalProp) {
            // Also merge DOM amenities and images into the JSON-LD prop if any
            finalProp.amenitiesExtracted = [...new Set([
                ...(finalProp.amenitiesExtracted || []),
                ...pageData.amenities
            ])];
            finalProp.documents = pageData.documents || [];
            
            const existingImages = new Set(finalProp.imageUrls || []);
            pageData.images.forEach(img => existingImages.add(img));
            finalProp.imageUrls = [...existingImages].filter(Boolean);

            // Patch location fields if JSON-LD gave us defaults/empty values
            if (pageData.locationText) {
                const addrParts = pageData.locationText.split(',').map(p => p.trim()).filter(Boolean);
                const addrLower = pageData.locationText.toLowerCase();
                if (!finalProp.location) finalProp.location = {};

                // Override city if blank or Bengaluru placeholder
                if (!finalProp.location.city) {
                    finalProp.location.city = addrParts.find(p => /bengaluru|bangalore|mysuru|mysore|hubli|mangalore|chennai|pune|mumbai|delhi/i.test(p)) || 'Bengaluru';
                }
                // Override area with the full address address minus city/state suffix for a richer string
                if (!finalProp.location.area) {
                    finalProp.location.area = addrParts.slice(0, Math.max(1, addrParts.length - 2)).join(', ').substring(0, 150);
                }
                // Override zone if it was set to the hardcoded default
                if (!finalProp.location.zone || finalProp.location.zone === CONFIG.api.defaultZone) {
                    if (/north/i.test(addrLower))        finalProp.location.zone = 'North';
                    else if (/south/i.test(addrLower))   finalProp.location.zone = 'South';
                    else if (/west/i.test(addrLower))    finalProp.location.zone = 'West';
                    else if (/east/i.test(addrLower))    finalProp.location.zone = 'East';
                    else if (/central/i.test(addrLower)) finalProp.location.zone = 'Central';
                }
                // Patch lat/lon if missing
                if ((!finalProp.location.latitude || finalProp.location.latitude === 0) && pageData.lat) {
                    finalProp.location.latitude = pageData.lat;
                    finalProp.location.longitude = pageData.lng;
                }
            }
            
            // Inject DOM fallback for units, area, sizes if missing from JSON
            if (pageData.projectUnits && (!finalProp.totalUnits || finalProp.totalUnits === 0)) {
                finalProp.totalUnits = pageData.projectUnits;
            }
            if (pageData.projectArea && !finalProp.projectArea) {
                finalProp.projectArea = pageData.projectArea;
            }
            if (pageData.domSizes && (!finalProp.unitTypes || finalProp.unitTypes.length === 0)) {
                 // Parse sqft from string like "1885 - 2142 sq.ft."
                 const sqftMatch = pageData.domSizes.match(/(\d[\d,]*)/);
                 const parsedSqft = sqftMatch ? parseInt(sqftMatch[1].replace(/,/g, ''), 10) : 1200;
                 
                 // Try to detect BHK count from description or title
                 let bhkCount = 2;
                 const bhkMatch = (finalProp.projectName + ' ' + (finalProp.description || '')).match(/(\d+)\s*BHK/i);
                 if (bhkMatch) bhkCount = parseInt(bhkMatch[1], 10);
                 const unitTypeId = bhkCount === 1 ? 1 : bhkCount === 2 ? 2 : bhkCount === 3 ? 3 : 4;
                 
                 finalProp.unitTypes = [{
                     unitTypeId,
                     sizeSqft: parsedSqft,
                     priceMin: 0.85,
                     priceMax: 1.25,
                     priceUnit: 'Cr'
                 }];
            }
        }

        if (finalProp) {
            log.info(`  Checking image sizes for: ${finalProp.projectName}`);
            const validImages = [];
            for (const imgUrl of finalProp.imageUrls || []) {
                if (validImages.length >= 10) break;
                if (imgUrl.includes('bat.bing.com') || imgUrl.includes('doubleclick') || imgUrl.includes('sharethrough') || imgUrl.includes('pixel') || imgUrl.includes('adingo')) continue;
                const size = await checkImageSize(imgUrl);
                if (size > 30000) validImages.push(imgUrl);
            }
            finalProp.imageUrls = validImages;

            if (validImages.length === 0) {
                log.warn(`  [SKIP/LOGGED] Dropping project due to no images >30kb: ${finalProp.projectName}`);
                fs.appendFileSync('skipped_projects.log', `[${new Date().toISOString()}] No >30kb images: ${finalProp.projectName} - ${url}\n`);
                finalProp = null;
            }
        }

        if (finalProp) {
            if (pageData.twitterImage && pageData.twitterImage.includes('img.youtube.com')) {
                const vidId = pageData.twitterImage.match(/\/vi\/([^\/]+)\//);
                if (vidId) {
                    const videoUrl = `https://www.youtube.com/watch?v=${vidId[1]}`;
                    if (!finalProp.videoUrls.includes(videoUrl)) {
                        finalProp.videoUrls.unshift(videoUrl);
                    }
                }
            }
            allProperties.push(finalProp);
            log.success(`  Extracted: ${finalProp.projectName}`);
        } else {
            log.warn(`  Could not extract data for ${url}`);
        }
      } catch (e) {
        log.error(`  Failed to process ${url}: ${e.message}`);
      }
      await sleep(1000);
    }

    log.step('PHASE 3: Submitting to API');
    const baseDeveloperResolver = await createDeveloperResolver(CONFIG, log);
    const apiLookups = await createApiLookups(CONFIG, baseDeveloperResolver, log);
    const results = { success: [], failed: [], skipped: [] };

    for (let i = 0; i < allProperties.length; i++) {
      const prop = allProperties[i];
      log.info(`[${i + 1}/${allProperties.length}] "${prop.projectName}"`);

      if (!dryRun) {
        log.data(`--- DEBUG EXTRACTED RE DATA FOR: ${prop.projectName} ---`);
        console.log(JSON.stringify(prop, null, 2));
      }

      if (hasSeenProject(dedupeState, prop.projectName)) {
        log.warn('  Skipped: local dedupe');
        results.skipped.push({ property: prop.projectName, reason: 'local-dedupe' });
        continue;
      }

      // 1. Resolve Developer (Dynamic insert if missing)
      const finalDeveloperId = await apiLookups.resolveDeveloper(prop.developerName);
      
      // 2. Resolve Amenities (Dynamic insert if missing)
      prop.amenityIds = await apiLookups.resolveAmenities(prop.amenitiesExtracted || []);

      const imageUrls = [...new Set((prop.imageUrls || []).filter(u => /^https?:\/\//i.test(u)))].slice(0, CONFIG.maxImagesPerProject);
      let files = [];
      if (!dryRun) {
        for (let imgIndex = 0; imgIndex < imageUrls.length; imgIndex++) {
          const buf = await downloadImage(imageUrls[imgIndex]);
          if (!buf) continue;
          files.push({
            fieldName: `images[${files.length}].file`,
            fileName: `property-${i}-${files.length}.jpg`,
            mimeType: mimeType(imageUrls[imgIndex]),
            buffer: buf,
          });
        }
        if (files.length === 0) files = getPlaceholderImage();

        // 3. Attach documents (Brochures) if any
        if (prop.documents && prop.documents.length > 0) {
            const buf = await downloadImage(prop.documents[0]); // downloadImage works for PDFs too if size > 30kb
            if (buf) {
                files.push({
                    fieldName: `documents[0].file`,
                    fileName: `brochure-${i}.pdf`,
                    mimeType: 'application/pdf',
                    buffer: buf
                });
                prop._hasDocument = true;
            }
        }
      }

      const fields = buildFormFields(prop, dryRun ? imageUrls.length : Math.max(1, files.filter(f => f.fieldName.startsWith('images')).length), finalDeveloperId);
      if (prop._hasDocument) {
          fields['documents[0].documentType'] = 'BROCHURE';
          fields['documents[0].sortOrder'] = 1;
      }

      if (dryRun) {
        console.log(fields);
        results.success.push({ property: prop.projectName, status: 'dry-run' });
        continue;
      }

      if (!dryRun) {
        log.data(`Files attached => count: ${files.length}, types: ${files.map(f => f.mimeType).join(', ')}`);
        if (files.length > 0 && files[0].fileName === 'property.png') {
            log.warn('  Sending 1x1 PLACEHOLDER image instead of scraped images.');
        }
      }

      try {
        const { statusCode, body } = await postFormData(CONFIG.apiUrl, fields, files);
        if (statusCode >= 200 && statusCode < 300) {
          log.success(`  OK Submitted`);
          markSeenProject(dedupeState, prop.projectName, { source: prop.sourceName, projectName: prop.projectName });
          results.success.push({ property: prop.projectName, statusCode });
        } else if (statusCode === 400 && (body.includes('Duplicate Entry') || body.includes('Project name already exists'))) {
          // Project already in DB — mark locally so we skip next run
          log.warn(`  Skipped: API duplicate (marking in cache)`);
          markSeenProject(dedupeState, prop.projectName, { source: prop.sourceName, projectName: prop.projectName });
          results.skipped.push({ property: prop.projectName, reason: 'api-duplicate' });
        } else {
          log.error(`  FAIL HTTP ${statusCode}: ${body.slice(0, 200)}`);
          results.failed.push({ property: prop.projectName, statusCode, body: body.slice(0, 200) });
        }
      } catch (err) {
        log.error(`  FAIL ${err.message}`);
        results.failed.push({ property: prop.projectName, error: err.message });
      }
      await sleep(800);
    }

  saveDedupeState(CONFIG.dedupeStateFile, dedupeState);
  log.step('━━━ SUMMARY ━━━');
  log.success(`Success : ${results.success.length}`);
  log.info(`Skipped : ${results.skipped.length}`);
  if (results.failed.length) log.error(`Failed  : ${results.failed.length}`);
}

main().catch(err => { log.error(err.message); process.exit(1); });
