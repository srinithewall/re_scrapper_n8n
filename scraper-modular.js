const fs = require('fs');
const path = require('path');
const { loadRuntimeConfig } = require('./runtime-config');
const { createDeveloperResolver } = require('./developer-utils');
const { createApiLookups } = require('./api-lookups');
const { loadDedupeState, saveDedupeState, normalizeProjectKey } = require('./submission-utils');

// Import core logic from existing scraper
const housing = require('./scraper-puppeteer-housing');

const log = {
  info:    (m) => console.log(`[INFO] ${m}`),
  success: (m) => console.log(`[OK] ${m}`),
  warn:    (m) => console.log(`[WARN] ${m}`),
  error:   (m) => console.error(`[ERR] ${m}`),
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// STEALTH CONFIG
// Set PROXY_URL env var in your Docker container:
//   docker run -e PROXY_URL=http://user:pass@host:port ...
// ─────────────────────────────────────────────
const PROXY_URL = process.env.PROXY_URL || '';

// Must match the EXACT Chromium version in your Docker image.
// After docker build, run: docker run --rm re_scrapper node -e
//   "const p=require('puppeteer-extra'); console.log(p.executablePath())"
// then: <that path> --version
// and update this string accordingly.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36';

// ─────────────────────────────────────────────
// STEALTH HELPERS
// ─────────────────────────────────────────────

/**
 * Injects realistic browser fingerprint properties.
 * Overrides the most common headless-browser tells.
 */
async function injectStealthScripts(page) {
  await page.evaluateOnNewDocument(() => {
    // 1. Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 2. Spoof hardware fingerprint
    Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'languages',           { get: () => ['hi-IN', 'en-IN', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'language',            { get: () => 'hi-IN' });
    Object.defineProperty(navigator, 'platform',            { get: () => 'Win32' });

    // 3. Override WebGL — hides the "SwiftShader" headless renderer string
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';                 // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return 'Intel(R) UHD Graphics 620'; // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, parameter);
    };

    // 4. Ensure chrome runtime object exists (headless Chrome is missing it)
    if (!window.chrome) window.chrome = { runtime: {} };

    // 5. Spoof plugin count (headless has 0 plugins — a strong bot signal)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const fakePlugins = [
          { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client',      filename: 'internal-nacl-plugin' },
        ];
        fakePlugins.length = 3;
        return fakePlugins;
      }
    });
  });
}

/**
 * Sets Indian-locale HTTP headers on every request.
 * Housing.com checks Accept-Language and sec-ch-ua for geo consistency.
 */
async function setIndianHeaders(page) {
  await page.setExtraHTTPHeaders({
    'Accept-Language':    'hi-IN,en-IN;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-ch-ua':          '"Chromium";v="123", "Google Chrome";v="123", "Not:A-Brand";v="99"',
    'sec-ch-ua-mobile':   '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest':     'document',
    'sec-fetch-mode':     'navigate',
    'sec-fetch-site':     'none',
    'sec-fetch-user':     '?1',
    'upgrade-insecure-requests': '1',
  });
}

/**
 * Simulates a human scrolling down the page in random chunks.
 */
async function humanScrollDown(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalScrolled = 0;
      const pageHeight = document.body.scrollHeight;
      const scroll = () => {
        const chunk = 200 + Math.floor(Math.random() * 400); // 200–600px per step
        window.scrollBy(0, chunk);
        totalScrolled += chunk;
        if (totalScrolled >= pageHeight * 0.8) {
          resolve();
        } else {
          setTimeout(scroll, 300 + Math.floor(Math.random() * 600)); // 300–900ms between steps
        }
      };
      scroll();
    });
  });
}

/**
 * Detects if the current page is a block/CAPTCHA screen.
 * Returns { isBlocked, reason, title }.
 */
async function detectBlock(page) {
  const title = await page.title().catch(() => '');
  const html  = await page.content().catch(() => '');

  const blockSignals = [
    { pattern: /shield/i,                   reason: 'Cloudflare Shield' },
    { pattern: /captcha/i,                  reason: 'CAPTCHA challenge' },
    { pattern: /pardon our interruption/i,  reason: 'Imperva/Incapsula block' },
    { pattern: /access denied/i,            reason: 'Access Denied' },
    { pattern: /bot detected/i,             reason: 'Bot Detected' },
    { pattern: /just a moment/i,            reason: 'Cloudflare Challenge' },
    { pattern: /ddos.protection/i,          reason: 'DDoS Protection' },
  ];

  for (const signal of blockSignals) {
    if (signal.pattern.test(title) || signal.pattern.test(html.slice(0, 5000))) {
      return { isBlocked: true, reason: signal.reason, title };
    }
  }
  return { isBlocked: false, reason: null, title };
}

// ─────────────────────────────────────────────
// DISCOVER  (main entry point for n8n)
// ─────────────────────────────────────────────
async function discover(config) {
  log.info(`Discovering projects at: ${config.scrapeUrl}`);

  // ── Load puppeteer-extra + stealth plugin ──
  let puppeteer;
  try {
    puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  } catch (_) {
    log.error('Missing packages. Run: npm install puppeteer-extra puppeteer-extra-plugin-stealth');
    process.exit(1);
  }

  if (!PROXY_URL) {
    log.warn('No PROXY_URL set. AWS EC2 IPs are blocked by Housing.com.');
    log.warn('Set env var: docker run -e PROXY_URL=http://user:pass@host:port ...');
  } else {
    log.info(`Proxy: ${PROXY_URL.replace(/:([^:@]+)@/, ':****@')}`);
  }

  // Build launch args
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
  ];
  if (PROXY_URL) launchArgs.push(`--proxy-server=${PROXY_URL}`);

  const browser = await puppeteer.launch({ headless: 'new', args: launchArgs });
  const interceptedResponses = [];

  try {
    const page = await browser.newPage();

    // Random viewport — avoids fixed-size headless fingerprint
    const viewWidth  = 1200 + Math.floor(Math.random() * 400);
    const viewHeight = 800  + Math.floor(Math.random() * 200);
    await page.setViewport({ width: viewWidth, height: viewHeight });
    await page.setUserAgent(CHROME_UA);

    // Proxy authentication
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

    // Inject stealth fingerprint scripts before any navigation
    await injectStealthScripts(page);

    // Set Indian locale headers
    await setIndianHeaders(page);

    // Network interception
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

    // ── Homepage warmup ──
    // Seeds cookies and mimics organic browsing before hitting the search page.
    // Skipping this is a strong bot signal.
    log.info('Warming up session on housing.com homepage...');
    try {
      await page.goto('https://housing.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000 + Math.random() * 2000); // 3–5s pause
      await humanScrollDown(page);
      await sleep(2000 + Math.random() * 2000); // 2–4s pause after scroll
    } catch (e) {
      log.warn(`Warmup navigation failed: ${e.message} — continuing anyway`);
    }

    // Block check after warmup
    const warmupCheck = await detectBlock(page);
    if (warmupCheck.isBlocked) {
      log.error(`Blocked at warmup: ${warmupCheck.reason} (title: "${warmupCheck.title}")`);
      log.error('Check your proxy — it may be burned or not routing through India.');
      return [];
    }
    log.info(`Warmup OK — title: "${warmupCheck.title}"`);

    // ── Navigate to target search URL ──
    log.info(`Navigating to target: ${config.scrapeUrl}`);
    try {
      await page.goto(config.scrapeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      log.warn(`Navigation error: ${e.message}`);
    }

    // Wait for listing container (more reliable than networkidle2)
    try {
      await page.waitForSelector(
        '[data-testid="srp-listing"], [class*="project-card"], [class*="listing-card"], article',
        { timeout: 12000 }
      );
    } catch (_) {
      log.warn('Listing selector not found — page may be blocked or structure changed');
    }

    // Random thinking delay: 5–15s (critical for rate limit avoidance)
    const thinkTime = 5000 + Math.random() * 10000;
    log.info(`Thinking for ${Math.round(thinkTime / 1000)}s...`);
    await sleep(thinkTime);

    // Human scroll before extraction
    await humanScrollDown(page);
    await sleep(1500 + Math.random() * 1500);

    // Block check before extraction
    const blockCheck = await detectBlock(page);
    if (blockCheck.isBlocked) {
      log.error(`Blocked on search page: ${blockCheck.reason}`);
      // Save debug screenshot if debug dir exists
      try {
        const debugDir = path.join(process.cwd(), 'debug');
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        await page.screenshot({ path: path.join(debugDir, 'block-discover.png'), fullPage: false });
        log.error('Screenshot saved to debug/block-discover.png');
      } catch (_) {}
      return [];
    }

    // Diagnostic log — key signal for whether the page is real
    const html = await page.content();
    log.info(`HTML length: ${html.length} — Has NEXT_DATA: ${html.includes('__NEXT_DATA__')}`);
    log.info(`Page title: "${blockCheck.title}"`);
    log.info(`API responses intercepted: ${interceptedResponses.length}`);

    // ── Extract from intercepted API responses ──
    const allProjects = [];
    for (const resp of interceptedResponses) {
      try {
        const json = JSON.parse(resp.text);
        const extracted = housing.extractFromNextData(json);
        extracted.forEach(p => {
          p.sourceApiUrl = resp.url;
          allProjects.push(p);
        });
      } catch (_) {}
    }

    // ── Fallback: extract from __NEXT_DATA__ in HTML ──
    if (allProjects.length === 0) {
      const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (nextMatch) {
        try {
          const extracted = housing.extractFromNextData(JSON.parse(nextMatch[1]));
          extracted.forEach(p => { p.sourceApiUrl = '__NEXT_DATA__'; allProjects.push(p); });
          log.info(`Extracted ${allProjects.length} projects from __NEXT_DATA__`);
        } catch (e) {
          log.warn(`__NEXT_DATA__ parse failed: ${e.message}`);
        }
      }
    }

    // ── Fallback: DOM extraction ──
    if (allProjects.length === 0) {
      log.warn('No projects in JSON. Falling back to DOM extraction...');
      const rawCards = await page.evaluate(() => {
        const h1 = document.querySelector('h1')?.innerText?.trim();
        if (window.location.href.includes('/projects/page/') && h1) {
          const imgs = Array.from(document.querySelectorAll('img[src*="housing"]'))
            .map(img => img.src).filter(s => s && s.startsWith('http')).slice(0, 8);
          return [{ projectName: h1, websiteUrl: window.location.href, description: h1 + ' - Residential Project', imageUrls: imgs }];
        }
        return Array.from(document.querySelectorAll('article, [class*="project-card"], [class*="listing-card"]')).map(el => {
          const name = el.querySelector('h1, h2, h3, [class*="title"], [class*="name"]')?.innerText?.trim();
          const url  = el.querySelector('a')?.href;
          if (!name || name.length < 5 || !url) return null;
          return { projectName: name, websiteUrl: url, description: name + ' - Premium Project', imageUrls: [] };
        }).filter(x => x && !/%| off|Paints/i.test(x.projectName));
      });

      rawCards.forEach(c => {
        allProjects.push({
          ...c,
          imageUrls:          c.imageUrls || [],
          videoUrls:          [],
          reraNumber:         null,
          developerName:      '',
          sourceType:         config.sourceType,
          sourceName:         config.source,
          sourceUpdatedAt:    new Date().toISOString(),
          possessionDate:     null,
          amenitiesExtracted: [],
          unitTypes: [
            { unitTypeId: 2, sizeSqft: 1200, priceMin: 0.85, priceMax: 1.20, priceUnit: 'Cr' },
          ],
          location: {
            zone:        config.api?.defaultZone || 'East',
            area:        'Bengaluru',
            addressLine: 'Bengaluru',
            city:        config.api?.defaultCity || 'Bengaluru',
            latitude:    0,
            longitude:   0,
          },
        });
      });
    }

    log.success(`Discovered ${allProjects.length} projects.`);
    return allProjects;

  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────
// ENRICH  (unchanged from original)
// ─────────────────────────────────────────────
async function enrich(prop, config) {
  log.info(`Enriching project: ${prop.projectName}`);
  
  const baseDeveloperResolver = await createDeveloperResolver(config, log);
  const apiLookups = await createApiLookups(config, baseDeveloperResolver, log);
  
  const devName = prop.developerName || 'Unknown';
  let devId = await apiLookups.resolveDeveloper(devName);
  const amenityIds = await apiLookups.resolveAmenities(prop.amenitiesExtracted || []);

  const fields = housing.buildFormFields(prop, prop.imageUrls, [], devId, amenityIds);
  
  return {
    ...prop,
    devId,
    amenityIds,
    formFields: fields,
    isDedupeKey: normalizeProjectKey(prop.projectName)
  };
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  const args   = process.argv.slice(2);
  const task   = args.find(a => a.startsWith('--task='))?.split('=')[1]   || 'discover';
  const source = args.find(a => a.startsWith('--source='))?.split('=')[1] || 'housing';
  const config = loadRuntimeConfig(source, args);

  if (task === 'discover') {
    const projects = await discover(config);
    console.log(JSON.stringify(projects, null, 2));
  } 
  else if (task === 'enrich') {
    const dataArg = args.find(a => a.startsWith('--data='))?.slice(7);
    if (!dataArg) {
      log.error('Missing --data argument for enrichment');
      process.exit(1);
    }
    const prop    = JSON.parse(dataArg);
    const enriched = await enrich(prop, config);
    console.log(JSON.stringify(enriched, null, 2));
  }
  else {
    log.error(`Unknown task: ${task}`);
    process.exit(1);
  }
}

main().catch(err => {
  log.error(err.message);
  process.exit(1);
});
