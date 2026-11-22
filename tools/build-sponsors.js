// Converts the Home Office sponsor register CSV into web/data/sponsors.js
// Usage: node tools/build-sponsors.js <register.csv>
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) { console.error('usage: node build-sponsors.js <register.csv>'); process.exit(1); }

function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const clean = s => (s || '').replace(/\s+/g, ' ').trim();
const rows = parseCsv(fs.readFileSync(src, 'utf8').replace(/^﻿/, '')).slice(1).filter(r => clean(r[0]));

// Lookup tables keep the payload small: each sponsor stores indexes, not repeated strings.
const types = [], routes = [], idx = (arr, v) => { let i = arr.indexOf(v); if (i < 0) { arr.push(v); i = arr.length - 1; } return i; };
const byKey = new Map();
for (const r of rows) {
  const name = clean(r[0]), town = clean(r[1]), county = clean(r[2]);
  const key = (name + '|' + town + '|' + county).toLowerCase();
  let s = byKey.get(key);
  if (!s) { s = [name, town, county, []]; byKey.set(key, s); }
  const t = idx(types, clean(r[3])), ro = idx(routes, clean(r[4]));
  if (!s[3].some(p => p[0] === t && p[1] === ro)) s[3].push([t, ro]);
}
const sponsors = [...byKey.values()].sort((a, b) => a[0].localeCompare(b[0], 'en', { sensitivity: 'base' }));

const out = path.join(__dirname, '..', 'web', 'data', 'sponsors.js');
const meta = { source: path.basename(src), rows: rows.length, generated: new Date().toISOString().slice(0, 10) };
fs.writeFileSync(out, 'window.SPONSOR_DATA=' + JSON.stringify({ meta, types, routes, sponsors }) + ';\n');
console.log(`${rows.length} rows -> ${sponsors.length} sponsor entries, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
