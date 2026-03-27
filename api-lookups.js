const http = require('http');
const https = require('https');
const { normalizeDeveloperKey } = require('./developer-utils');

// Simple wrapper for POST requests
function httpPostJson(url, data) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqData = JSON.stringify(data);
    
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(reqData)
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve({ id: null });
          }
        } else {
          resolve(null); // Return null on failure instead of throwing to keep scraper running
        }
      });
    });
    
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(reqData);
    req.end();
  });
}

function normalizeAmenityKey(name) {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Creates an API resolver that caches developers and amenities in-memory
 * and dynamically POSTs to the backend if missing.
 */
async function createApiLookups(config, developerResolver, log) {
  const baseUrl = config.developerLookupUrl 
    ? config.developerLookupUrl.replace(/\/developers$/, '') 
    : 'http://localhost:8880/api/lookups';
    
  const devUrl = `${baseUrl}/developers`;
  const amenityUrl = `${baseUrl}/amenities`;
  
  // Cache for created developer IDs in this session
  const developerCache = new Map();
  // Cache for existing / created amenity IDs
  const amenityCache = new Map();
  
  // Pre-load known amenities if possible
  try {
    const httpGetJson = require('./developer-utils').httpGetJson || async function(u) {
      return new Promise((res) => http.get(u, r => { let b=''; r.on('data', c=>b+=c); r.on('end', ()=>res(JSON.parse(b))); }));
    };
    const amenities = await httpGetJson(amenityUrl);
    if (Array.isArray(amenities)) {
      amenities.forEach(a => {
         if (a.id && a.label) amenityCache.set(normalizeAmenityKey(a.label), a.id);
      });
      log.info(`Loaded ${amenityCache.size} amenities from lookup endpoint`);
    }
  } catch(e) {
    log.warn(`Could not preload amenities: ${e.message}`);
  }

  return {
    async resolveDeveloper(developerName) {
      if (!developerName || developerName.length < 3) return config.api.fallbackDeveloperId || 1;
      
      const key = normalizeDeveloperKey(developerName);
      
      // 1. Check local session cache (created in this run)
      if (developerCache.has(key)) {
        return developerCache.get(key);
      }
      
      // 2. Check the standard developer resolver (aliases and GET cache)
      const res = developerResolver.resolve(developerName);
      if (res.matchedBy !== 'fallback') {
        return res.developerId;
      }
      
      // 3. Not found, create it dynamically
      log.info(`  [API] Creating new Developer: "${developerName}"`);
      const created = await httpPostJson(devUrl, { name: developerName });
      
      if (created && created.id) {
        log.success(`  [API] Created Developer ID ${created.id}`);
        developerCache.set(key, created.id);
        return created.id;
      }
      
      log.warn(`  [API] Failed to create Developer, using fallback`);
      return config.api.fallbackDeveloperId || 1;
    },
    
    async resolveAmenities(amenityNames) {
      const validIds = new Set(config.api.amenityIds || []); // Always include defaults (e.g., 5, 6)
      if (!Array.isArray(amenityNames) || amenityNames.length === 0) {
        return [...validIds];
      }
      
      for (const name of amenityNames) {
        const cleanName = name.replace(/[^\w\s-]/g, '').trim();
        if (cleanName.length < 3) continue;
        
        const key = normalizeAmenityKey(cleanName);
        if (!key) continue;
        
        if (amenityCache.has(key)) {
          validIds.add(amenityCache.get(key));
          continue;
        }
        
        // Dynamic creation
        log.info(`  [API] Creating new Amenity: "${cleanName}"`);
        const created = await httpPostJson(amenityUrl, { name: cleanName });
        
        if (created && created.id) {
            log.success(`  [API] Created Amenity ID ${created.id}`);
            amenityCache.set(key, created.id);
            validIds.add(created.id);
        }
      }
      
      return [...validIds];
    }
  };
}

module.exports = {
  createApiLookups
};
