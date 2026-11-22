// Adds coordinates to every job in web/data/jobs.js (j.geo = [lat, lon]), so the app can show the distance from the
// user's location. Uses postcodes.io (free, no key; Ordnance Survey and ONS open data):
//  - a full postcode ("TQ2 7AA") or an outward code ("BS39") when the advert gives one;
//  - otherwise the town in the location text ("Newcastle Upon Tyne, Tyne and Wear"), matched against OS Open Names
//    settlements in the same country.
// Lookups are cached in tools/geo-cache.json, so a daily run only asks about places it hasn't seen.
// Usage: node tools/geocode-jobs.js
const fs = require('fs');
const path = require('path');
const { loadJobs, JOBS_FILE } = require('./jobs-file');

const API = 'https://api.postcodes.io';
const CACHE_FILE = path.join(__dirname, 'geo-cache.json');
const FULL_PC = /^([A-Z]{1,2}\d[A-Z\d]?) ?(\d[A-Z]{2})$/i, OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const COUNTRIES = ['England', 'Scotland', 'Wales', 'Northern Ireland'];
// Settlement types from OS Open Names, best first: a "Leeds" city beats a "Leeds" hamlet.
const RANK = ['City', 'Town', 'Village', 'Suburban Area', 'Hamlet', 'Other Settlement'];
// OS Open Names covers Great Britain only, so Northern Ireland towns go through their main postcode district.
const NI_OUTCODES = { belfast: 'BT1', derry: 'BT48', londonderry: 'BT48', lisburn: 'BT28', newry: 'BT34', bangor: 'BT20', ballymena: 'BT43',
  newtownabbey: 'BT36', craigavon: 'BT65', portadown: 'BT62', coleraine: 'BT52', antrim: 'BT41', omagh: 'BT78', enniskillen: 'BT74', armagh: 'BT61' };
// Short names job boards use for a city that OS Open Names lists under its full name (a bare "Newcastle" is a Shropshire village).
const ALIASES = { newcastle: 'Newcastle upon Tyne' };
const NOT_PLACE =/^(united kingdom|uk|england|scotland|wales|northern ireland|remote|hybrid|home ?based|various|multiple locations?|nationwide)$/i;

const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
const round = ([lat, lon]) => [+lat.toFixed(3), +lon.toFixed(3)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (attempt === 2) { console.warn('  failed', url, e.message); return undefined; }
      await sleep(2000 * (attempt + 1));
    }
  }
}

// Town candidates from the location text, most specific first, with the country when the text names one.
function placeQueries(j) {
  const text = [j.location, j.region].filter(Boolean).join(', ');
  const country = COUNTRIES.find(c => new RegExp('\\b' + c + '\\b', 'i').test(text)) || '';
  const parts = (j.location || '').split(',').map(p => p.replace(/\((?:county|region)\)/gi, '').replace(/\b(?:NHS|sites?|health centre|hospital|university|national|general)\b/gi, ' ')
    .replace(/^(?:Greater|City of)\s+|\s+Area$/gi, '').replace(/\bSt\.\s*/g, 'St ').replace(/\s+/g, ' ').trim()).filter(p => p && !NOT_PLACE.test(p) && !OUTCODE.test(p) && !FULL_PC.test(p));
  const names = [...parts];
  // "Aberdeen Royal Infirmary", "Falkirk Community Hospital": fall back to the town the site is named after.
  for (const p of parts) if (/\b(?:infirmary|community|clinic|centre|care home|royal|partnership)\b/i.test(p)) names.push(p.split(' ')[0]);
  return names.map(name => ({ name: ALIASES[name.toLowerCase()] || name, country }));
}

async function lookupOutcode(out) {
  const k = `oc:${out}`;
  if (!(k in cache)) { const r = await getJson(`${API}/outcodes/${out}`); await sleep(150); if (r === undefined) return null; cache[k] = r?.result ? round([r.result.latitude, r.result.longitude]) : null; }
  return cache[k];
}

async function lookupPlace(name, country) {
  const ni = NI_OUTCODES[name.toLowerCase()];
  if (ni && (!country || country === 'Northern Ireland')) return lookupOutcode(ni);
  const k = `place:${name.toLowerCase()}|${country}`;
  if (k in cache) return cache[k];
  const r = await getJson(`${API}/places?q=${encodeURIComponent(name)}&limit=50`); await sleep(150);
  if (r === undefined) return null;                                   // network error: don't cache, try again next run
  const hits = (r?.result || []).filter(p => [p.name_1, p.name_2].some(n => (n || '').toLowerCase() === name.toLowerCase())
    && RANK.includes(p.local_type) && (!country || p.country === country));
  hits.sort((a, b) => RANK.indexOf(a.local_type) - RANK.indexOf(b.local_type));
  return (cache[k] = hits[0] ? round([hits[0].latitude, hits[0].longitude]) : null);
}

(async () => {
  const data = loadJobs();
  // Full postcodes in bulk, 100 per request.
  const pcs = [...new Set(data.jobs.map(j => (j.postcode || '').trim().toUpperCase()).filter(p => FULL_PC.test(p)).map(p => p.replace(FULL_PC, '$1 $2')))]
    .filter(p => !(`pc:${p}` in cache));
  for (let i = 0; i < pcs.length; i += 100) {
    const r = await getJson(`${API}/postcodes`, { postcodes: pcs.slice(i, i + 100) }); await sleep(200);
    for (const { query, result } of r?.result || []) cache[`pc:${query.toUpperCase()}`] = result ? round([result.latitude, result.longitude]) : null;
  }
  let located = 0;
  for (const j of data.jobs) {
    const pc = (j.postcode || '').trim().toUpperCase();
    let geo = null;
    if (FULL_PC.test(pc)) geo = cache[`pc:${pc.replace(FULL_PC, '$1 $2')}`] || null;
    const out = FULL_PC.test(pc) ? pc.replace(FULL_PC, '$1') : OUTCODE.test(pc) ? pc : '';
    if (!geo && out) geo = await lookupOutcode(out.toUpperCase());     // terminated postcode, or only the outward code given
    for (const q of geo ? [] : placeQueries(j)) { geo = await lookupPlace(q.name, q.country); if (geo) break; }
    if (geo) { j.geo = geo; located++; } else delete j.geo;
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
  fs.writeFileSync(JOBS_FILE, 'window.JOB_DATA=' + JSON.stringify(data, null, 1) + ';\n');
  const missing = [...new Set(data.jobs.filter(j => !j.geo).map(j => j.location || '(none)'))];
  console.log(`geocoded ${located} of ${data.jobs.length} jobs` + (missing.length ? `; no location for: ${missing.slice(0, 40).join('; ')}${missing.length > 40 ? '…' : ''}` : ''));
})();
