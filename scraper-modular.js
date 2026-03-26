const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { loadRuntimeConfig } = require('./runtime-config');
const { createDeveloperResolver } = require('./developer-utils');
const { createApiLookups } = require('./api-lookups');
const { loadDedupeState, saveDedupeState, normalizeProjectKey } = require('./submission-utils');

// Import core logic from existing scraper
const housing = require('./scraper-puppeteer-housing');

const log = {
  info: (m) => console.log(`[INFO] ${m}`),
  success: (m) => console.log(`[OK] ${m}`),
  warn: (m) => console.log(`[WARN] ${m}`),
  error: (m) => console.error(`[ERR] ${m}`),
};

async function discover(config) {
  log.info(`Discovering projects at: ${config.scrapeUrl}`);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

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

    await page.goto(config.scrapeUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));

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

    if (allProjects.length === 0) {
      log.warn('No projects in JSON. Falling back to DOM extraction...');
      const rawCards = await page.evaluate(() => {
        // detail page detection
        const h1 = document.querySelector('h1')?.innerText?.trim();
        if (window.location.href.includes('/projects/page/') && h1) {
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

      // Normalize DOM cards
      rawCards.forEach(c => {
        allProjects.push({
          ...c,
          imageUrls: c.imageUrls || [],
          videoUrls: [],
          reraNumber: null,
          developerName: '',
          sourceType: config.sourceType,
          sourceName: config.source,
          sourceUpdatedAt: new Date().toISOString(),
          possessionDate: null,
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

async function enrich(prop, config) {
  log.info(`Enriching project: ${prop.projectName}`);
  
  // Initialization of lookups
  const baseDeveloperResolver = await createDeveloperResolver(config, log);
  const apiLookups = await createApiLookups(config, baseDeveloperResolver, log);
  
  // Resolve Developer & Amenities
  const devName = prop.developerName || 'Unknown';
  let devId = await apiLookups.resolveDeveloper(devName);
  const amenityIds = await apiLookups.resolveAmenities(prop.amenitiesExtracted || []);

  // Build the submission-ready object
  // Note: We don't download images here, we let n8n handle the post or we do it in a later step.
  // Actually, the current scraper does image check and downloads before submission.
  // We'll keep the enrichment pure (meta data) and maybe add an image-verify task.
  
  const fields = housing.buildFormFields(prop, prop.imageUrls, [], devId, amenityIds);
  
  return {
    ...prop,
    devId,
    amenityIds,
    formFields: fields,
    isDedupeKey: normalizeProjectKey(prop.projectName)
  };
}

async function main() {
  const args = process.argv.slice(2);
  const task = args.find(a => a.startsWith('--task='))?.split('=')[1] || 'discover';
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
    const prop = JSON.parse(dataArg);
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
