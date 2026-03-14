const http = require('http');
const https = require('https');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid JSON response: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

function normalizeDeveloperKey(value) {
  if (!value || typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bprivate\b/g, 'pvt')
    .replace(/\blimited\b/g, 'ltd')
    .replace(/\bdevelopers?\b/g, '')
    .replace(/\bbuilders?\b/g, '')
    .replace(/\bproperties\b/g, '')
    .replace(/\bproperty\b/g, '')
    .replace(/\bprojects?\b/g, '')
    .replace(/\brealty\b/g, '')
    .replace(/\bgroup\b/g, '')
    .replace(/\binfra(structure|con)?\b/g, 'infra')
    .replace(/\bestates?\b/g, '')
    .replace(/\bhousing\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAliasMap(mappings) {
  const map = new Map();
  if (!mappings || typeof mappings !== 'object') return map;

  Object.entries(mappings).forEach(([name, id]) => {
    const key = normalizeDeveloperKey(name);
    const devId = Number.parseInt(id, 10);
    if (key && Number.isFinite(devId) && devId > 0) {
      map.set(key, devId);
    }
  });

  return map;
}

function buildLookupItems(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.value)
      ? payload.value
      : [];

  return rows
    .map((row) => ({
      id: Number.parseInt(row.id, 10),
      label: String(row.label || '').trim(),
      key: normalizeDeveloperKey(String(row.label || '')),
    }))
    .filter((row) => Number.isFinite(row.id) && row.id > 0 && row.label && row.key);
}

function findLookupMatch(key, lookupItems) {
  if (!key) return null;

  const exact = lookupItems.find((item) => item.key === key);
  if (exact) return exact;

  const near = lookupItems.filter((item) =>
    item.key.includes(key) || key.includes(item.key)
  );
  if (near.length === 1) return near[0];

  return null;
}

async function createDeveloperResolver(config, log = null) {
  const fallbackDeveloperId = Number.parseInt(
    config?.api?.fallbackDeveloperId ?? config?.api?.developerId,
    10
  );
  const aliasMap = buildAliasMap(config?.api?.developerNameMappings);
  let lookupItems = [];

  if (config?.developerLookupUrl) {
    try {
      const payload = await httpGetJson(config.developerLookupUrl);
      lookupItems = buildLookupItems(payload);
      if (log && typeof log.info === 'function') {
        log.info(`Loaded ${lookupItems.length} developers from lookup endpoint`);
      }
    } catch (err) {
      if (log && typeof log.warn === 'function') {
        log.warn(`Developer lookup unavailable: ${err.message}`);
      }
    }
  }

  return {
    fallbackDeveloperId,
    resolve(developerName) {
      const key = normalizeDeveloperKey(developerName);
      if (key && aliasMap.has(key)) {
        return {
          developerId: aliasMap.get(key),
          matchedBy: 'config-alias',
          developerName,
        };
      }

      const lookupMatch = findLookupMatch(key, lookupItems);
      if (lookupMatch) {
        return {
          developerId: lookupMatch.id,
          matchedBy: 'lookup',
          developerName: lookupMatch.label,
        };
      }

      return {
        developerId: fallbackDeveloperId,
        matchedBy: 'fallback',
        developerName: developerName || '',
      };
    },
  };
}

module.exports = {
  createDeveloperResolver,
  normalizeDeveloperKey,
};
