const fs = require('fs');
const http = require('http');
const https = require('https');

function normalizeProjectKey(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadDedupeState(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { version: 1, projects: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object') {
      return parsed;
    }
  } catch (_) {}
  return { version: 1, projects: {} };
}

function saveDedupeState(filePath, state) {
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function hasSeenProject(state, projectName) {
  const key = normalizeProjectKey(projectName);
  return Boolean(key && state && state.projects && state.projects[key]);
}

function markSeenProject(state, projectName, meta = {}) {
  const key = normalizeProjectKey(projectName);
  if (!key) return null;
  const nowIso = new Date().toISOString();
  const existing = state.projects[key] || {};
  const sources = new Set(Array.isArray(existing.sources) ? existing.sources : []);
  if (meta.source) sources.add(meta.source);

  state.projects[key] = {
    projectName: meta.projectName || existing.projectName || projectName,
    firstSeenAt: existing.firstSeenAt || nowIso,
    lastSeenAt: meta.updatedAt || nowIso,
    sources: [...sources],
    sourceType: meta.sourceType || existing.sourceType || 'WEB_SCRAPING',
  };
  return key;
}

function isLikelyDuplicateError(statusCode, body = '') {
  if (statusCode === 409) return true;
  const text = String(body || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('already exists') ||
    text.includes('duplicate') ||
    text.includes('already present') ||
    text.includes('unique constraint') ||
    text.includes('constraintviol') ||
    text.includes('project name already')
  );
}

function requestText(url, method = 'GET', timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: { 'Accept': 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

function parseExistsFromResponse(statusCode, body = '') {
  if (statusCode === 404) return false;
  if (statusCode === 204) return true;
  if (statusCode < 200 || statusCode >= 300) return false;
  if (!body || !String(body).trim()) return true;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    return false;
  }

  if (typeof parsed === 'boolean') return parsed;
  if (Array.isArray(parsed)) return parsed.length > 0;
  if (!parsed || typeof parsed !== 'object') return false;

  if (typeof parsed.exists === 'boolean') return parsed.exists;
  if (typeof parsed.found === 'boolean') return parsed.found;
  if (typeof parsed.present === 'boolean') return parsed.present;
  if (typeof parsed.duplicate === 'boolean') return parsed.duplicate;

  if (parsed.data != null) {
    if (typeof parsed.data === 'boolean') return parsed.data;
    if (Array.isArray(parsed.data)) return parsed.data.length > 0;
    if (typeof parsed.data === 'object') {
      if (typeof parsed.data.exists === 'boolean') return parsed.data.exists;
      if (parsed.data.id != null) return true;
      if (parsed.data.projectName) return true;
    }
  }

  return Boolean(parsed.id != null || parsed.projectName);
}

async function checkProjectExistsInDb(templateUrl, method, projectName) {
  if (!templateUrl || !projectName) {
    return { checked: false, exists: false };
  }
  const url = templateUrl.replace('{projectName}', encodeURIComponent(projectName));
  const { statusCode, body } = await requestText(url, method || 'GET');
  return {
    checked: true,
    exists: parseExistsFromResponse(statusCode, body),
    statusCode,
    body,
  };
}

module.exports = {
  normalizeProjectKey,
  loadDedupeState,
  saveDedupeState,
  hasSeenProject,
  markSeenProject,
  isLikelyDuplicateError,
  checkProjectExistsInDb,
};

