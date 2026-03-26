const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'scraper.config.json');

function parseArgValue(args, name) {
  const key = `--${name}=`;
  const hit = args.find((arg) => arg.startsWith(key));
  return hit ? hit.slice(key.length) : null;
}

function resolveOverride(args, name, envName) {
  const argValue = parseArgValue(args, name);
  if (argValue != null && String(argValue).trim() !== '') {
    return String(argValue).trim();
  }

  const envValue = envName ? process.env[envName] : null;
  if (envValue != null && String(envValue).trim() !== '') {
    return String(envValue).trim();
  }

  return null;
}

function resolveFilePath(baseDir, value) {
  return path.isAbsolute(value) ? value : path.join(baseDir, value);
}

function parsePositiveInt(value, label) {
  if (value == null) return null;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return n;
}

function resolveWindow(config, args) {
  const modeFromArg = parseArgValue(args, 'mode');
  const mode = (modeFromArg || config.mode || 'bootstrap').trim();
  const windowConfig = config.windows && config.windows[mode];

  if (!windowConfig) {
    throw new Error(`Mode "${mode}" not found in scraper.config.json windows`);
  }

  const overrideDays = parsePositiveInt(parseArgValue(args, 'since-days'), 'since-days');
  const overrideHours = parsePositiveInt(parseArgValue(args, 'since-hours'), 'since-hours');

  const lookbackDays = overrideDays ?? parsePositiveInt(windowConfig.lookbackDays, `${mode}.lookbackDays`);
  const lookbackHours = overrideHours ?? parsePositiveInt(windowConfig.lookbackHours, `${mode}.lookbackHours`);

  const now = Date.now();
  const cutoffMs = lookbackDays != null
    ? now - (lookbackDays * 24 * 60 * 60 * 1000)
    : now - ((lookbackHours || 24) * 60 * 60 * 1000);

  return {
    mode,
    lookbackDays,
    lookbackHours,
    sinceIso: new Date(cutoffMs).toISOString(),
  };
}

function loadRuntimeConfig(sourceName, args = process.argv.slice(2)) {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config file: ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);

  const sourceConfig = config.sources && config.sources[sourceName];
  if (!sourceConfig) {
    throw new Error(`Source "${sourceName}" not configured in scraper.config.json`);
  }
  if (sourceConfig.enabled === false) {
    throw new Error(`Source "${sourceName}" is disabled in scraper.config.json`);
  }

  const window = resolveWindow(config, args);
  const global = config.global || {};
  const overrideLimit = parsePositiveInt(parseArgValue(args, 'limit'), 'limit');
  const configuredMaxImages = parsePositiveInt(global.maxImagesPerProject, 'global.maxImagesPerProject');
  const overrideMaxImages = parsePositiveInt(resolveOverride(args, 'max-images', 'SCRAPER_MAX_IMAGES'), 'max-images');
  const maxImagesPerProject = configuredMaxImages || 7;
  const sourceLabel = sourceConfig.source || sourceConfig.sourceName || sourceName;
  const projectExistsMethod = (global.projectExistsMethod || 'GET').toUpperCase();
  const apiUrl = resolveOverride(args, 'api-url', 'SCRAPER_API_URL') || global.apiUrl;
  const developerLookupUrl = resolveOverride(args, 'developer-lookup-url', 'SCRAPER_DEVELOPER_LOOKUP_URL') || global.developerLookupUrl || '';
  const outputFileName = resolveOverride(args, 'output-file', 'SCRAPER_OUTPUT_FILE') || global.outputFile || 'scraped.json';
  const reportFileName = resolveOverride(args, 'report-file', 'SCRAPER_REPORT_FILE') || global.reportFile || 'submission_report.json';
  const dedupeFileName = resolveOverride(args, 'dedupe-file', 'SCRAPER_DEDUPE_FILE') || global.dedupeStateFile || 'submitted_projects_cache.json';
  const projectExistsUrlTemplate = resolveOverride(args, 'project-exists-url', 'SCRAPER_PROJECT_EXISTS_URL') || global.projectExistsUrlTemplate || '';

  const overrideUrl = resolveOverride(args, 'url', 'SCRAPER_URL');

  return {
    scrapeUrl: overrideUrl || sourceConfig.scrapeUrl,
    maxPages: parsePositiveInt(sourceConfig.maxPages, `${sourceName}.maxPages`) || 1,
    limit: overrideLimit ?? parsePositiveInt(sourceConfig.limit, `${sourceName}.limit`),
    requestDelay: parsePositiveInt(sourceConfig.requestDelay, `${sourceName}.requestDelay`) || 1500,
    apiUrl,
    developerLookupUrl,
    api: config.apiDefaults || {},
    outputFile: resolveFilePath(__dirname, outputFileName),
    reportFile: resolveFilePath(__dirname, reportFileName),
    dedupeStateFile: resolveFilePath(__dirname, dedupeFileName),
    projectExistsUrlTemplate,
    projectExistsMethod,
    maxImagesPerProject: overrideMaxImages || maxImagesPerProject,
    sourceName,
    source: sourceLabel,
    sourceType: 'WEB_SCRAPING',
    window,
  };
}

module.exports = {
  loadRuntimeConfig,
};
