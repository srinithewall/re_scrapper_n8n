/**
 * test-stealth-advanced.js
 * 
 * Diagnostic script — run this BEFORE the main scraper to verify:
 *   1. Proxy is routing through India (public IP check)
 *   2. No webdriver flag leaking
 *   3. WebGL renderer is realistic (not SwiftShader)
 *   4. Housing.com loads with real content (NEXT_DATA present)
 *   5. Saves a screenshot to debug/ for visual verification
 * 
 * Usage:
 *   PROXY_URL=http://user:pass@host:port node test-stealth-advanced.js
 */

const fs   = require('fs');
const path = require('path');

const PROXY_URL  = process.env.PROXY_URL || '';
const DEBUG_DIR  = path.join(process.cwd(), 'debug');
const TARGET_URL = 'https://housing.com/in/buy/projects/bangalore/residential';

// Must match your Dockerfile's Chromium version — update after `docker build`
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36';

const log = {
  info:    (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  success: (m) => console.log(`\x1b[32m[OK]\x1b[0m    ${m}`),
  warn:    (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
  error:   (m) => console.log(`\x1b[31m[ERR]\x1b[0m   ${m}`),
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runDiagnostic() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  let puppeteer;
  try {
    puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    log.success('puppeteer-extra + StealthPlugin loaded');
  } catch (_) {
    log.error('Missing packages. Run: npm install puppeteer-extra puppeteer-extra-plugin-stealth');
    process.exit(1);
  }

  if (!PROXY_URL) {
    log.warn('No PROXY_URL set — IP check will show your AWS EC2 IP, which is likely blocked.');
  } else {
    log.info(`Proxy: ${PROXY_URL.replace(/:([^:@]+)@/, ':****@')}`);
  }

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
  ];
  if (PROXY_URL) launchArgs.push(`--proxy-server=${PROXY_URL}`);

  const browser = await puppeteer.launch({ headless: 'new', args: launchArgs });
  const page    = await browser.newPage();

  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(CHROME_UA);

  // Proxy auth
  if (PROXY_URL) {
    try {
      const parsed = new URL(PROXY_URL);
      if (parsed.username && parsed.password) {
        await page.authenticate({
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        });
      }
    } catch (e) { log.warn(`Proxy auth parse failed: ${e.message}`); }
  }

  // Stealth injections
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver',           { get: () => undefined });
    Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'languages',           { get: () => ['hi-IN', 'en-IN', 'en-US', 'en'] });
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel(R) UHD Graphics 620';
      return getParameter.call(this, parameter);
    };
    if (!window.chrome) window.chrome = { runtime: {} };
  });

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'hi-IN,en-IN;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-ch-ua': '"Chromium";v="123", "Google Chrome";v="123", "Not:A-Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  });

  // ── TEST 1: Public IP & Region ──
  log.info('\n── TEST 1: Public IP & Region ──');
  try {
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const ipData = await page.evaluate(() => JSON.parse(document.body.innerText));
    log.info(`Public IP: ${ipData.ip}`);

    // Check IP geo
    await page.goto(`https://ipapi.co/${ipData.ip}/json/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const geoText = await page.evaluate(() => document.body.innerText);
    const geo = JSON.parse(geoText);
    const countryOk = geo.country_code === 'IN';
    if (countryOk) {
      log.success(`Region: ${geo.city}, ${geo.region}, ${geo.country_name} ✓ (Indian IP confirmed)`);
    } else {
      log.error(`Region: ${geo.city}, ${geo.region}, ${geo.country_name} ✗ — NOT an Indian IP!`);
      log.error('Housing.com will geo-block this. Fix your proxy region setting.');
    }
    log.info(`ISP: ${geo.org}`);
    const isDatacenter = /amazon|aws|google|microsoft|azure|digitalocean|linode|vultr/i.test(geo.org || '');
    if (isDatacenter) {
      log.error('ISP looks like a datacenter/cloud provider — residential proxy not working!');
    } else {
      log.success('ISP looks residential ✓');
    }
  } catch (e) {
    log.error(`IP check failed: ${e.message}`);
  }

  // ── TEST 2: Browser Fingerprint ──
  log.info('\n── TEST 2: Browser Fingerprint ──');
  await page.goto('https://httpbin.org/headers', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  const fingerprint = await page.evaluate(() => {
    return {
      webdriver:           navigator.webdriver,
      deviceMemory:        navigator.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      languages:           navigator.languages,
      platform:            navigator.platform,
      pluginCount:         navigator.plugins.length,
      userAgent:           navigator.userAgent,
    };
  });
  log.info(`webdriver flag    : ${fingerprint.webdriver === undefined ? '✓ undefined (good)' : '✗ ' + fingerprint.webdriver + ' (BAD — will be detected)'}`);
  log.info(`deviceMemory      : ${fingerprint.deviceMemory}GB`);
  log.info(`hardwareConcurrency: ${fingerprint.hardwareConcurrency} cores`);
  log.info(`languages         : ${fingerprint.languages}`);
  log.info(`platform          : ${fingerprint.platform}`);
  log.info(`plugins           : ${fingerprint.pluginCount}`);
  log.info(`userAgent         : ${fingerprint.userAgent}`);

  // ── TEST 3: WebGL Renderer ──
  log.info('\n── TEST 3: WebGL Renderer ──');
  const webgl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return { vendor: 'N/A', renderer: 'N/A' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return { vendor: 'N/A', renderer: 'N/A' };
    return {
      vendor:   gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
      renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
    };
  });
  const swiftshaderDetected = /swiftshader|llvmpipe/i.test(webgl.renderer);
  if (swiftshaderDetected) {
    log.error(`WebGL Vendor  : ${webgl.vendor}  ✗ SwiftShader detected — headless fingerprint exposed!`);
    log.error(`WebGL Renderer: ${webgl.renderer}`);
  } else {
    log.success(`WebGL Vendor  : ${webgl.vendor} ✓`);
    log.success(`WebGL Renderer: ${webgl.renderer} ✓`);
  }

  // ── TEST 4: Housing.com Load ──
  log.info('\n── TEST 4: Housing.com Target Page ──');
  try {
    const response = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const httpStatus = response ? response.status() : 'unknown';
    await sleep(4000);

    const html       = await page.content();
    const title      = await page.title();
    const hasNextData = html.includes('__NEXT_DATA__');
    const htmlLen    = html.length;

    log.info(`HTTP status : ${httpStatus}`);
    log.info(`Page title  : "${title}"`);
    log.info(`HTML length : ${htmlLen.toLocaleString()} bytes`);

    if (hasNextData) {
      log.success('Has __NEXT_DATA__ : ✓ YES — real page loaded!');
    } else {
      log.error('Has __NEXT_DATA__ : ✗ NO — likely blocked or challenge page');
    }

    // Block signal check
    const blockSignals = [
      { pattern: /shield/i,                  label: 'Cloudflare Shield' },
      { pattern: /captcha/i,                 label: 'CAPTCHA' },
      { pattern: /pardon our interruption/i, label: 'Imperva block' },
      { pattern: /access denied/i,           label: 'Access Denied' },
      { pattern: /just a moment/i,           label: 'Cloudflare Challenge' },
    ];
    let blocked = false;
    for (const s of blockSignals) {
      if (s.pattern.test(title) || s.pattern.test(html.slice(0, 5000))) {
        log.error(`🚫 Block detected: ${s.label}`);
        blocked = true;
      }
    }
    if (!blocked && hasNextData) {
      log.success('✅ No block signals detected — page looks clean');
    }

    if (htmlLen < 100000) {
      log.warn(`HTML is only ${htmlLen.toLocaleString()} bytes — expected >200KB for real content`);
    } else {
      log.success(`HTML size looks real: ${htmlLen.toLocaleString()} bytes ✓`);
    }

    // Save screenshot
    const screenshotPath = path.join(DEBUG_DIR, 'test-stealth-result.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    log.success(`Screenshot saved: ${screenshotPath}`);
    log.info('Open the screenshot to visually confirm listings are visible (not a CAPTCHA screen).');

  } catch (e) {
    log.error(`Housing.com navigation failed: ${e.message}`);
  }

  await browser.close();
  log.info('\n── Diagnostic complete ──');
}

runDiagnostic().catch(err => {
  console.error('Diagnostic crashed:', err.message);
  process.exit(1);
});
