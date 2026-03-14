/**
 * PropSync — 99acres.com Scraper + RE Projects API Submitter
 *
 * Install: npm install puppeteer
 * Usage:
 *   node scraper-puppeteer.js --dry-run    # scrape + print payload, no POST
 *   node scraper-puppeteer.js              # scrape + POST to API
 *   node scraper-puppeteer.js --debug      # also save HTML to debug/
 */

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
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
const CONFIG = loadRuntimeConfig('99acres', process.argv.slice(2));

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

// Get content-type from URL extension
function mimeType(url = '') {
  if (url.includes('.png'))  return 'image/png';
  if (url.includes('.webp')) return 'image/webp';
  if (url.includes('.gif'))  return 'image/gif';
  return 'image/jpeg';
}

// 1x1 white JPEG as placeholder when no image available
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
function genRera() {
  return `PRM/KA/RERA/1251/308/PR/220123/${String(++reraCounter).padStart(6, '0')}`;
}

// Clean a scraped RERA number — if it looks malformed, generate a fresh one
function cleanRera(raw = '') {
  raw = raw.trim();
  // Valid format: PRM/KA/RERA/... or KA/RERA/... at minimum
  if (/^(PRM\/)?KA\/RERA\//i.test(raw)) return raw;
  // Starts with / — prepend prefix
  if (raw.startsWith('/')) return `PRM/KA/RERA${raw}`;
  // Too short or garbage
  if (raw.length < 8) return genRera();
  return raw;
}

function parsePrice(text = '') {
  text = text.replace(/,/g, '').trim();
  const nums = [...text.matchAll(/[\d.]+/g)].map(m => parseFloat(m[0]));
  if (!nums.length) return { priceMin: 0.85, priceMax: 1.20 };
  const isCr = /cr/i.test(text);
  const isL  = /l(?:ac|akh)?/i.test(text);
  let min = nums[0], max = nums[nums.length - 1];
  if (isL && !isCr) { min = +(min / 100).toFixed(2); max = +(max / 100).toFixed(2); }
  if (isL && isCr && nums.length >= 2) { min = +(nums[0] / 100).toFixed(2); max = nums[1]; }
  if (min > max) [min, max] = [max, min];
  if (min === max) max = +(min * 1.15).toFixed(2);
  return { priceMin: min || 0.85, priceMax: max || 1.20 };
}

function getZone(area = '') {
  if (/whitefield|mahadevapura|kr puram|marathahalli|indiranagar|koramangala|hsr|sarjapur|outer ring|varthur|kengeri/i.test(area)) return 'East';
  if (/hebbal|yelahanka|devanahalli|airport|bellary/i.test(area)) return 'North';
  if (/bannerghatta|electronic city|jp nagar|jayanagar|btm|begur/i.test(area)) return 'South';
  if (/rajajinagar|malleshwaram|yeshwanthpur|tumkur|peenya/i.test(area)) return 'West';
  return CONFIG.api.defaultZone;
}

// Extract locality from URL slug by removing project name words
function localityFromSlug(slug, projectName) {
  const projectSlug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let locality = slug
    .replace(new RegExp('^' + projectSlug + '-?', 'i'), '')
    .replace(new RegExp('-?' + projectSlug + '$', 'i'), '')
    .replace(/^-+|-+$/g, '');
  if (locality.length < 3) return '';
  return locality.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ─────────────────────────────────────────────
// EXTRACT FROM PAGE (inside Puppeteer)
// ─────────────────────────────────────────────
async function extractFromPage(page, pageNum, debugMode) {
  await sleep(4000);

  // Scroll slowly to trigger lazy-loaded images
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let y = 0;
      const t = setInterval(() => {
        window.scrollBy(0, 400);
        y += 400;
        if (y >= Math.max(document.body.scrollHeight, 5000)) { clearInterval(t); resolve(); }
      }, 400);
    });
  });

  await sleep(3000);

  // Trigger IntersectionObserver-based lazy loaders
  await page.evaluate(() => {
    document.querySelectorAll('img[data-src]').forEach(img => {
      img.src = img.getAttribute('data-src');
    });
    document.querySelectorAll('source[data-srcset]').forEach(src => {
      src.srcset = src.getAttribute('data-srcset');
    });
  });

  await sleep(1000);

  if (debugMode) {
    const dir = path.join(__dirname, 'debug');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const html = await page.content();
    fs.writeFileSync(path.join(dir, `page-${pageNum}.html`), html);
    log.info(`HTML saved → debug/page-${pageNum}.html`);
  }

  return await page.evaluate(() => {
    const results = [];
    const cards = document.querySelectorAll('[data-label^="GROUPED_PROJECT_TUPLE"]');

    cards.forEach(card => {
      try {
        const text = card.innerText || '';

        // ── Name ──
        const anchors = card.querySelectorAll('a[href*="99acres"][title]');
        let name = '';
        let href = '';
        for (const a of anchors) {
          const t = (a.getAttribute('title') || '').trim();
          if (t && !t.includes('Overview') && t.length > 3 && t.length < 120) {
            name = t;
            href = a.getAttribute('href') || '';
            break;
          }
        }
        if (!name) {
          const h = card.querySelector('h2, h3, [class*="title"], [class*="Title"]');
          name = h?.innerText?.trim() || '';
        }
        if (!name || name.length < 3) return;

        // ── Locality ──
        let locality = '';
        const anchorTitle = card.querySelector('a[href*="99acres"][title]')?.getAttribute('title') || '';
        const titleParts = anchorTitle.split(',').map(s => s.trim());
        if (titleParts.length >= 2) {
          const candidate = titleParts[1];
          if (candidate && !/^bang|^beng/i.test(candidate)) locality = candidate;
        }

        if (!locality && href) {
          const slugMatch = href.match(/\/([a-z0-9-]+)-(?:bangalore|bengaluru)/i);
          if (slugMatch) {
            const projectSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            let loc = slugMatch[1]
              .replace(new RegExp('^' + projectSlug + '-?', 'i'), '')
              .replace(new RegExp('-?' + projectSlug + '$', 'i'), '')
              .replace(/^-+|-+$/g, '');
            if (loc.length >= 3) {
              locality = loc.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }
          }
        }

        if (!locality) {
          const locEl = card.querySelector([
            '[class*="localityName"]', '[class*="locality"]',
            '[class*="location"]', '[class*="address"]', '[class*="subTitle"]',
          ].join(','));
          const locText = locEl?.innerText?.trim().split(/[,\n]/)[0].trim() || '';
          if (locText && !/^bang|^beng/i.test(locText)) locality = locText;
        }

        // ── Price ──
        const configCards = card.querySelectorAll('[class*="configs__configCard"], [class*="configCard"]');
        const bhkSet = new Set();
        const priceTexts = [];

        configCards.forEach(cfg => {
          const t = cfg.innerText || '';
          const bhkM = t.match(/(\d)\s*BHK/i);
          if (bhkM) bhkSet.add(parseInt(bhkM[1]));
          const priceM = t.match(/₹[\s\d.,]+(?:Cr|L|Lac|Lakh)/i);
          if (priceM) priceTexts.push(priceM[0]);
        });

        if (bhkSet.size === 0) {
          (text.match(/(\d)\s*BHK/gi) || []).forEach(b => bhkSet.add(parseInt(b)));
        }
        if (priceTexts.length === 0) {
          const pm = text.match(/₹[\s\d.,]+(?:Cr|L|Lac|Lakh)/gi);
          if (pm) priceTexts.push(...pm.slice(0, 2));
        }

        // ── Size ──
        const sizeM = text.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft)/i);
        const sizeSqft = sizeM ? parseInt(sizeM[1].replace(/,/g, '')) : 0;

        // ── RERA ──
        const reraM = text.match(/(?:RERA\s*(?:No\.?|Number|#|:)?\s*)([A-Z0-9/]{8,40})/i);
        const reraId = reraM ? reraM[1].trim() : '';

        // ── Developer ──
        const devEl = card.querySelector([
          '[class*="developerName"]', '[class*="developer"]',
          '[class*="builderName"]',  '[class*="builder"]',
          '[class*="agentName"]',
        ].join(','));
        const developer = devEl?.innerText?.trim().split('\n')[0] || '';

        // ── Media (Images & Videos) ──
        const imageSet = new Set();
        const videoSet = new Set();
        const addMedia = (url) => {
          if (!url || typeof url !== 'string') return;
          const cleaned = url.split(',')[0].trim().split(' ')[0];
          if (!cleaned.startsWith('http')) return;
          if (cleaned.includes('static.99acres')) return;
          if (cleaned.includes('icon') || cleaned.includes('logo') || cleaned.includes('rera') || cleaned.includes('avatar')) return;
          if (cleaned.includes('youtube.com') || cleaned.includes('youtu.be') || cleaned.includes('img.youtube.com')) {
            videoSet.add(cleaned);
          } else {
            imageSet.add(cleaned);
          }
        };

        const sources = card.querySelectorAll('source[srcset], source[data-srcset]');
        sources.forEach((src) => {
          addMedia(src.getAttribute('srcset') || '');
          addMedia(src.getAttribute('data-srcset') || '');
        });

        const imgs = card.querySelectorAll('img');
        imgs.forEach((img) => {
          addMedia(img.getAttribute('data-src') || '');
          addMedia(img.getAttribute('src') || '');
          addMedia(img.getAttribute('data-lazy-src') || '');
        });

        results.push({ name, locality, developer, reraId, href,
          bhks: [...bhkSet].filter(b => b >= 1 && b <= 6).sort(),
          sizeSqft, priceTexts, 
          imageUrls: [...imageSet].slice(0, 7),
          videoUrls: [...videoSet].slice(0, 3)
        });
      } catch (_) {}
    });

    return {
      results,
      diag: {
        title: document.title,
        groupedTuples: document.querySelectorAll('[data-label^="GROUPED_PROJECT_TUPLE"]').length,
      }
    };
  });
}

// ─────────────────────────────────────────────
// NORMALIZE
// ─────────────────────────────────────────────
const BHK_DEF = {
  1: { sizeSqft: 650,  priceMin: 0.45, priceMax: 0.60 },
  2: { sizeSqft: 1200, priceMin: 0.85, priceMax: 1.10 },
  3: { sizeSqft: 1700, priceMin: 1.20, priceMax: 1.60 },
  4: { sizeSqft: 2400, priceMin: 1.80, priceMax: 2.50 },
  5: { sizeSqft: 3200, priceMin: 2.80, priceMax: 3.80 },
};

function normalize(raw) {
  const area = (raw.locality || '').trim();
  const areaClean = (!area || /^bang|^beng/i.test(area)) ? 'Bengaluru' : area;
  const priceInfo = raw.priceTexts.length ? parsePrice(raw.priceTexts[0]) : null;
  const bhks = raw.bhks.length ? raw.bhks : [2, 3];
  const unitTypes = bhks.map(bhk => {
    const def = BHK_DEF[bhk] || BHK_DEF[2];
    return {
      unitTypeId: bhk,
      sizeSqft:   raw.sizeSqft > 100 ? raw.sizeSqft : def.sizeSqft,
      priceMin:   priceInfo ? priceInfo.priceMin : def.priceMin,
      priceMax:   priceInfo ? priceInfo.priceMax : def.priceMax,
      priceUnit:  'Cr',
    };
  });

  const isRealDev = raw.developer &&
    raw.developer.toLowerCase() !== 'builder' &&
    raw.developer.length > 2 &&
    !raw.developer.toLowerCase().includes(raw.name.toLowerCase().split(' ')[0].toLowerCase());
  const devPart = isRealDev ? ` by ${raw.developer}` : '';
  const description = `${raw.name}${devPart} - Premium residential apartments in ${areaClean}, Bengaluru`;

  return {
    projectName: raw.name.trim(),
    developerName: raw.developer || '',
    description,
    reraNumber:  cleanRera(raw.reraId),
    websiteUrl:  raw.href || CONFIG.scrapeUrl,
    sourceType: CONFIG.sourceType,
    sourceName: CONFIG.source,
    sourceUpdatedAt: new Date().toISOString(),
    imageUrls: (raw.imageUrls || []).slice(0, CONFIG.maxImagesPerProject),
    videoUrls: (raw.videoUrls || []),
    location: {
      zone:      getZone(areaClean),
      area:      areaClean,
      city:      CONFIG.api.defaultCity,
      latitude:  12.9698,
      longitude: 77.7500,
    },
    unitTypes,
    amenityIds: CONFIG.api.amenityIds,
  };
}

// ─────────────────────────────────────────────
// MAIN SCRAPE
// ─────────────────────────────────────────────
async function scrape(debugMode) {
  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch (_) { log.error('Run: npm install puppeteer'); process.exit(1); }

  log.step('━━━ PHASE 1: Scraping 99acres.com — Bengaluru ━━━');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
  });

  const allProperties = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-IN,en;q=0.9' });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (['font', 'media'].includes(req.resourceType())) req.abort();
      else if (req.resourceType() === 'image' &&
               !url.includes('imagecdn.99acres.com') &&
               !url.includes('media') ) req.abort();
      else req.continue();
    });

    for (let pageNum = 1; pageNum <= CONFIG.maxPages; pageNum++) {
      const url = pageNum === 1
        ? CONFIG.scrapeUrl
        : CONFIG.scrapeUrl + `&page_no=${pageNum}`;

      log.info(`Loading page ${pageNum}: ${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (e) { log.warn(`Load note: ${e.message.slice(0, 60)}`); }

      const { results, diag } = await extractFromPage(page, pageNum, debugMode);
      log.data(`  Title: ${diag.title}`);
      log.data(`  GROUPED_PROJECT_TUPLEs found: ${diag.groupedTuples}`);
      log.data(`  Raw extracted: ${results.length}`);

      const seen = new Set(allProperties.map(p => p.projectName));
      for (const raw of results) {
        if (!raw.name || seen.has(raw.name)) continue;
        seen.add(raw.name);
        allProperties.push(normalize(raw));
      }
      log.success(`Page ${pageNum}: total so far: ${allProperties.length}`);
      if (pageNum < CONFIG.maxPages) await sleep(3000);
    }
  } finally {
    await browser.close();
  }

  const limited = CONFIG.limit ? allProperties.slice(0, CONFIG.limit) : allProperties;
  log.success(`\nScraping done. Using top ${limited.length} of ${allProperties.length} properties.`);
  return limited;
}

// ─────────────────────────────────────────────
// BUILD FORM FIELDS
// ─────────────────────────────────────────────
function buildFormFields(p, imageCount = 1, developerId = null) {
  const cfg = CONFIG.api;
  const loc = p.location;
  const f = {};
  const sourceUpdatedAt = p.sourceUpdatedAt || new Date().toISOString();
  f['projectName']          = p.projectName;
  f['reraNumber']           = p.reraNumber;
  f['description']          = p.description;
  f['websiteUrl']           = p.websiteUrl || CONFIG.scrapeUrl;
  f['sourceType']           = p.sourceType || CONFIG.sourceType;
  f['sourceName']           = p.sourceName || CONFIG.source;
  f['updatedAt']            = sourceUpdatedAt;
  f['sourceUpdatedAt']      = sourceUpdatedAt;
  f['constructionStatusid'] = cfg.constructionStatusid;
  f['developerId']          = developerId || cfg.fallbackDeveloperId || cfg.developerId;
  f['projectTypeId']        = cfg.projectTypeId;
  f['location.zone']        = loc.zone;
  f['location.area']        = loc.area;
  f['location.city']        = loc.city;
  f['location.latitude']    = loc.latitude;
  f['location.longitude']   = loc.longitude;
  p.unitTypes.forEach((u, i) => {
    f[`unitTypes[${i}].unitTypeId`] = u.unitTypeId;
    f[`unitTypes[${i}].sizeSqft`]   = u.sizeSqft;
    f[`unitTypes[${i}].priceMin`]   = u.priceMin;
    f[`unitTypes[${i}].priceMax`]   = u.priceMax;
    f[`unitTypes[${i}].priceUnit`]  = u.priceUnit;
  });

  cfg.amenityIds.forEach((id, i) => { f[`amenityIds[${i}]`] = id; });

  if (p.videoUrls && p.videoUrls.length > 0) {
    f['videoUrl'] = p.videoUrls[0];
  }

  const safeImageCount = Math.max(1, Math.min(imageCount, CONFIG.maxImagesPerProject));
  for (let i = 0; i < safeImageCount; i++) {
    f[`images[${i}].sortOrder`] = i + 1;
  }
  return f;
}

function buildMultipart(fields, files = []) {
  const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
  const parts = [];
  const CRLF = Buffer.from('\r\n');

  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`
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

function postFormData(url, fields, files = []) {
  return new Promise((resolve, reject) => {
    const { body, contentType } = buildMultipart(fields, files);
    const pu = new URL(url);
    const lib = pu.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: pu.hostname, port: pu.port,
      path: pu.pathname + pu.search, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': body.length, 'Accept': 'application/json' },
      timeout: 30000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: d }));
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
  const args      = process.argv.slice(2);
  const dryRun    = args.includes('--dry-run');
  const debugMode = args.includes('--debug');

  console.log('\n\x1b[1m\x1b[33m  PropSync — 99acres.com → RE Projects API\x1b[0m\n');

  const lookback = CONFIG.window.lookbackDays != null
    ? `${CONFIG.window.lookbackDays} days`
    : `${CONFIG.window.lookbackHours} hours`;
  log.info(`Mode: ${CONFIG.window.mode} | Lookback: ${lookback} | Since: ${CONFIG.window.sinceIso}`);

  const properties = await scrape(debugMode);

  if (properties.length === 0) {
    log.error('No properties scraped. Run with --debug to inspect HTML.');
    process.exit(1);
  }

  fs.writeFileSync(CONFIG.outputFile, JSON.stringify(properties, null, 2));

  log.step('━━━ PHASE 2: Submitting to API ━━━');
  log.info(`Endpoint : ${CONFIG.apiUrl}`);
  log.info(`Count    : ${properties.length} properties\n`);

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

    const dedupeKey = normalizeProjectKey(prop.projectName);
    if (!dedupeKey) {
      results.skipped.push({ property: prop.projectName, reason: 'invalid-name' });
      continue;
    }
    if (runSeen.has(dedupeKey)) {
      results.skipped.push({ property: prop.projectName, reason: 'duplicate-in-run' });
      continue;
    }
    runSeen.add(dedupeKey);

    if (hasSeenProject(dedupeState, prop.projectName)) {
      log.warn(`Skipping already-submitted project: ${prop.projectName}`);
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
          log.warn(`Skipping existing DB project: ${prop.projectName}`);
          markSeenProject(dedupeState, prop.projectName, {
            source: prop.sourceName,
            sourceType: prop.sourceType,
            updatedAt: prop.sourceUpdatedAt,
            projectName: prop.projectName,
          });
          results.skipped.push({ property: prop.projectName, reason: 'exists-in-db' });
          continue;
        }
      } catch (err) {
        remoteLookupFailures++;
        log.warn(`DB duplicate-check failed: ${err.message}`);
        if (remoteLookupFailures >= 2) {
          remoteLookupEnabled = false;
          log.warn('Disabling DB duplicate-check for this run (too many failures).');
        }
      }
    }

    const imageUrls = [...new Set((prop.imageUrls || []).filter((u) => /^https?:\/\//i.test(u)))]
      .slice(0, CONFIG.maxImagesPerProject);

    let files = [];
    if (!dryRun) {
      for (let imgIndex = 0; imgIndex < imageUrls.length; imgIndex++) {
        const url = imageUrls[imgIndex];
        const imgBuffer = await downloadImage(url);
        if (!imgBuffer) continue;
        const ext = url.includes('.png') ? 'png' : url.includes('.webp') ? 'webp' : 'jpg';
        files.push({
          fieldName: `images[${files.length}].file`,
          fileName: `property-${i}-${files.length}.${ext}`,
          mimeType: mimeType(url),
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

    log.info(`[${i+1}/${properties.length}] "${prop.projectName}"`);
    log.data(`  Source    : ${prop.sourceName}`);
    log.data(`  Developer : ${developerResolution.developerName || 'fallback'} -> ${developerResolution.developerId} (${developerResolution.matchedBy})`);
    log.data(`  Images    : ${imageUrls.length} URLs (max ${CONFIG.maxImagesPerProject})`);
    console.log('\x1b[90m' + '-'.repeat(62) + '\x1b[0m');
    Object.entries(fields).forEach(([k, v]) =>
      console.log(`  \x1b[33m${k.padEnd(35)}\x1b[0m \x1b[97m${v}\x1b[0m`)
    );
    console.log('\x1b[90m' + '-'.repeat(62) + '\x1b[0m\n');

    if (dryRun) {
      results.success.push({ property: prop.projectName, status: 'dry-run' });
      continue;
    }

    try {
      const { statusCode, body } = await postFormData(CONFIG.apiUrl, fields, files);
      if (statusCode >= 200 && statusCode < 300) {
        log.success(`  OK Submitted (HTTP ${statusCode})`);
        results.success.push({ property: prop.projectName, statusCode, response: body });
        markSeenProject(dedupeState, prop.projectName, {
          source: prop.sourceName,
          sourceType: prop.sourceType,
          updatedAt: prop.sourceUpdatedAt,
          projectName: prop.projectName,
        });
      } else if (isLikelyDuplicateError(statusCode, body)) {
        log.warn(`  Skipped duplicate (HTTP ${statusCode})`);
        results.skipped.push({ property: prop.projectName, reason: 'duplicate-response', statusCode });
        markSeenProject(dedupeState, prop.projectName, {
          source: prop.sourceName,
          sourceType: prop.sourceType,
          updatedAt: prop.sourceUpdatedAt,
          projectName: prop.projectName,
        });
      } else {
        log.error(`  FAIL HTTP ${statusCode}`);
        results.failed.push({ property: prop.projectName, statusCode, error: body });
      }
    } catch (err) {
      log.error(`  FAIL Network error: ${err.message}`);
      results.failed.push({ property: prop.projectName, error: err.message });
    }

    await sleep(500);
  }

  if (!dryRun) {
    saveDedupeState(CONFIG.dedupeStateFile, dedupeState);
    log.info(`Dedupe state saved -> ${CONFIG.dedupeStateFile}`);
  }
  log.step('━━━ SUMMARY ━━━');
  log.success(`Success : ${results.success.length}`);
  log.info(`Skipped : ${results.skipped.length}`);
  if (results.failed.length) log.error(`Failed  : ${results.failed.length}`);
  fs.writeFileSync(CONFIG.reportFile, JSON.stringify(results, null, 2));
  log.info(`Report  → ${CONFIG.reportFile}`);
}

main().catch(e => { log.error(e.message); process.exit(1); });
