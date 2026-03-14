/**
 * node diagnose.js — finds real property card class names
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'debug', 'page-1.html'), 'utf8');

// ── 1. Show ALL unique top-level div/article class combos that appear 5+ times
// Real listing cards repeat many times on a page
console.log('\n=== Repeated elements (likely listing cards) ===\n');
const classRe = /<(?:div|article|li|section)[^>]*class="([^"]+)"[^>]*>/g;
const freq = {};
let m;
while ((m = classRe.exec(html)) !== null) {
  const key = m[1].split(' ')[0]; // first class only
  freq[key] = (freq[key] || 0) + 1;
}
Object.entries(freq)
  .filter(([,v]) => v >= 4 && v <= 60) // repeated but not too generic
  .sort((a,b) => b[1]-a[1])
  .slice(0, 30)
  .forEach(([cls, count]) => console.log(`  ${count}x  .${cls}`));

// ── 2. Find elements that contain both a price (₹) and a size (sq.ft / BHK)
console.log('\n=== Elements containing price + BHK (real listing cards) ===\n');
const blockRe = /<(div|article|li)[^>]*class="([^"]*)"[^>]*id="([^"]*)"[^>]*>/g;
while ((m = blockRe.exec(html)) !== null) {
  const start = m.index;
  const snippet = html.slice(start, start + 2000);
  if (/₹/.test(snippet) && /BHK/i.test(snippet)) {
    console.log(`  TAG: <${m[1]}> CLASS: "${m[2]}" ID: "${m[3]}"`);
    console.log(`  SNIPPET: ${snippet.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,200)}\n`);
    break; // just show first match
  }
}

// ── 3. Also try data-label attribute — 99acres marks sections with data-label
console.log('\n=== data-label values on page ===\n');
const labelRe = /data-label="([^"]+)"/g;
const labels = new Set();
while ((m = labelRe.exec(html)) !== null) labels.add(m[1]);
[...labels].forEach(l => console.log('  ', l));

// ── 4. Find elements with id containing "TUPLE" or "LISTING" or "PROPERTY"
console.log('\n=== IDs containing TUPLE / LISTING / PROPERTY / SRP ===\n');
const idRe = /id="([^"]*(?:TUPLE|LISTING|PROPERTY|SRP|RESULT)[^"]*)"/gi;
const ids = new Set();
while ((m = idRe.exec(html)) !== null) ids.add(m[1]);
[...ids].slice(0, 20).forEach(id => console.log('  #' + id));