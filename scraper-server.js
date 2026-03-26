const http = require('http');
const { runFromArgs } = require('./n8n-runner');

const PORT = Number.parseInt(process.env.PORT || process.env.SCRAPER_PORT || '3001', 10);
const HOST = process.env.HOST || process.env.SCRAPER_HOST || '0.0.0.0';
const TRIGGER_TOKEN = (process.env.SCRAPER_TRIGGER_TOKEN || '').trim();
const DEFAULT_SOURCE = (process.env.SCRAPER_DEFAULT_SOURCE || '99acres').trim();
const DEFAULT_MODE = (process.env.SCRAPER_DEFAULT_MODE || 'daily').trim();
const ALLOW_CONCURRENT_RUNS = String(process.env.SCRAPER_ALLOW_CONCURRENT || 'false').toLowerCase() === 'true';
const BODY_LIMIT_BYTES = 1024 * 1024;

const ALLOWED_SOURCES = new Set(['housing', '99acres']);
const ALLOWED_MODES = new Set(['daily', 'bootstrap']);

let activeRun = null;
let lastRun = null;

function log(message, extra) {
  const line = `[scraper-server] ${message}`;
  if (extra) {
    console.log(line, extra);
    return;
  }
  console.log(line);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > BODY_LIMIT_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });

    req.on('error', reject);
  });
}

function getAuthToken(req) {
  const headerToken = String(req.headers['x-trigger-token'] || '').trim();
  if (headerToken) return headerToken;

  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  return '';
}

function isAuthorized(req) {
  if (!TRIGGER_TOKEN) return true;
  return getAuthToken(req) === TRIGGER_TOKEN;
}

function normalizeSources(body) {
  if (Array.isArray(body.sources)) {
    return body.sources.map((value) => String(value).trim()).filter(Boolean);
  }

  const sourceValue = body.sources ?? body.source ?? DEFAULT_SOURCE;
  return String(sourceValue)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function pushArg(args, key, value) {
  if (value == null) return;
  const trimmed = String(value).trim();
  if (!trimmed) return;
  args.push(`--${key}=${trimmed}`);
}

function buildRunnerArgs(body) {
  const sources = normalizeSources(body);
  if (sources.length === 0) {
    throw new Error('At least one source is required');
  }

  const invalidSources = sources.filter((source) => !ALLOWED_SOURCES.has(source));
  if (invalidSources.length > 0) {
    throw new Error(`Unsupported source(s): ${invalidSources.join(', ')}`);
  }

  const mode = String(body.mode || DEFAULT_MODE).trim();
  if (!ALLOWED_MODES.has(mode)) {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  const args = [];
  args.push(sources.length > 1 ? `--sources=${sources.join(',')}` : `--source=${sources[0]}`);
  args.push(`--mode=${mode}`);
  
  if (body.task) pushArg(args, 'task', body.task);
  if (body.data) pushArg(args, 'data', typeof body.data === 'string' ? body.data : JSON.stringify(body.data));

  if (body.dryRun === true || body.dryRun === 'true') args.push('--dry-run');
  if (body.scrapeOnly === true || body.scrapeOnly === 'true') args.push('--scrape-only');
  if (body.submitOnly === true || body.submitOnly === 'true') args.push('--submit-only');
  if (body.debug === true || body.debug === 'true') args.push('--debug');

  pushArg(args, 'limit', body.limit);
  pushArg(args, 'since-days', body.sinceDays);
  pushArg(args, 'since-hours', body.sinceHours);
  pushArg(args, 'max-images', body.maxImages);
  pushArg(args, 'api-url', body.apiUrl);
  pushArg(args, 'output-file', body.outputFile);
  pushArg(args, 'report-file', body.reportFile);
  pushArg(args, 'dedupe-file', body.dedupeFile);
  pushArg(args, 'project-exists-url', body.projectExistsUrl);

  return {
    args,
    mode,
    sources,
  };
}

async function handleRun(req, res) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  if (activeRun && !ALLOW_CONCURRENT_RUNS) {
    sendJson(res, 409, {
      ok: false,
      error: 'A scraper run is already in progress',
      activeRun,
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
    return;
  }

  let requestMeta;
  try {
    requestMeta = buildRunnerArgs(body);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
    return;
  }

  activeRun = {
    startedAt: new Date().toISOString(),
    mode: requestMeta.mode,
    sources: requestMeta.sources,
  };

  log('Starting scraper run', activeRun);

  try {
    const result = await runFromArgs(requestMeta.args, {
      onChildLog: (text) => process.stderr.write(text),
    });

    lastRun = {
      startedAt: activeRun.startedAt,
      finishedAt: new Date().toISOString(),
      ok: result.ok,
      mode: requestMeta.mode,
      sources: requestMeta.sources,
    };

    sendJson(res, result.ok ? 200 : 500, {
      ok: result.ok,
      request: activeRun,
      result,
    });
  } catch (error) {
    lastRun = {
      startedAt: activeRun.startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      mode: requestMeta.mode,
      sources: requestMeta.sources,
      error: error.message,
    };

    sendJson(res, 500, {
      ok: false,
      request: activeRun,
      error: error.message,
    });
  } finally {
    log('Finished scraper run', lastRun);
    activeRun = null;
  }
}

function handleHealth(_req, res) {
  sendJson(res, 200, {
    ok: true,
    service: 're-scraper',
    status: activeRun ? 'running' : 'idle',
    activeRun,
    lastRun,
    defaults: {
      source: DEFAULT_SOURCE,
      mode: DEFAULT_MODE,
      allowConcurrentRuns: ALLOW_CONCURRENT_RUNS,
      requiresToken: Boolean(TRIGGER_TOKEN),
    },
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    handleHealth(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/run') {
    await handleRun(req, res);
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: 'Not found',
    endpoints: ['GET /health', 'POST /run'],
  });
});

server.listen(PORT, HOST, () => {
  log(`Listening on http://${HOST}:${PORT}`);
});
