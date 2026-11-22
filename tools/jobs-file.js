// Reads the sponsor register and reads/writes web/data/jobs.js. Each fetcher replaces only its own
// source's listings, so the scripts can be run in any order or on their own.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildIndex, key, tokens } = require('./sponsor-match');
const { sortJobs } = require('./job-filters');

const DATA = path.join(__dirname, '..', 'web', 'data');
const JOBS_FILE = path.join(DATA, 'jobs.js');

function loadScript(file, name) {
  if (!fs.existsSync(file)) return null;
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  return sandbox.window[name];
}

function loadSponsors() {
  const data = loadScript(path.join(DATA, 'sponsors.js'), 'SPONSOR_DATA');
  if (!data) throw new Error('web/data/sponsors.js not found: run tools/build-sponsors.js first');
  const match = buildIndex(data.sponsors.map(s => s[0]));
  // Sponsor details attached to each job, so the app can show the licence without the 7 MB register.
  const describe = (m) => {
    const s = data.sponsors[m.index];
    return { name: s[0], town: s[1], county: s[2], licences: s[3].map(([t, r]) => data.types[t] + ' — ' + data.routes[r]), match: m.quality };
  };
  // NHS bodies appear on job boards with shortened names ("Mersey Care NHSFT", "University Hospital of North Midlands"),
  // so this looser index, over NHS and health-board entries only, ignores "NHS / Foundation / Trust" and plural endings.
  const NHS_STOP = new Set(['nhs', 'nhsft', 'ft', 'foundation', 'trust', 'the', 'of', 'and']);
  const nhsKey = name => tokens(name).filter(w => !NHS_STOP.has(w)).map(w => w === 'healthcare' ? 'health' : w.replace(/s$/, '')).join(' ');
  const nhsIndex = new Map();
  data.sponsors.forEach((s, i) => { if (/\bnhs\b|health board|\btrust\b/i.test(s[0])) { const k = nhsKey(s[0]); if (k.length >= 6 && !nhsIndex.has(k)) nhsIndex.set(k, i); } });
  const nhsMatch = name => { const i = nhsIndex.get(nhsKey(name)); return i == null ? null : { index: i, quality: 'strong' }; };
  return { match, describe, nhsMatch };
}

const loadJobs = () => loadScript(JOBS_FILE, 'JOB_DATA') || { meta: {}, jobs: [] };

// Same company + same title counts as one vacancy even when two boards carry it.
const dupKey = j => key(j.company) + '|' + j.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Local calendar date (YYYY-MM-DD), so "new today" follows the UK day rather than UTC.
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// firstSeen: the day a vacancy was first collected. It carries over from the previous file (same id, or the same company +
// title), so re-fetching a source doesn't make old jobs look new. Listings from before firstSeen existed take the old
// file's fetch date.
function stampFirstSeen(prevJobs, prevMeta, jobs) {
  const baseline = prevMeta.fetched ? localDate(new Date(prevMeta.fetched)) : localDate();
  const byId = new Map(prevJobs.map(j => [j.id, j])), byDup = new Map(prevJobs.map(j => [dupKey(j), j]));
  for (const j of jobs) {
    const p = byId.get(j.id) || byDup.get(dupKey(j));
    j.firstSeen = p ? p.firstSeen || baseline : localDate();
  }
}

// category: 'dotnet' (default, the original .NET listings) or 'care'. A run replaces only its own source + category.
function saveSource(source, jobs, metaExtra = {}, category = 'dotnet') {
  const prev = loadJobs();
  const others = prev.jobs.filter(j => !(j.source === source && (j.category || 'dotnet') === category));
  jobs.forEach(j => { j.category = category; });
  stampFirstSeen(prev.jobs, prev.meta, jobs);
  const seen = new Set(others.map(dupKey));
  const fresh = jobs.filter(j => !seen.has(dupKey(j)) && seen.add(dupKey(j)));
  const all = sortJobs(others.concat(fresh));
  const sources = [...new Set(all.map(j => j.source))].sort();
  const meta = { ...prev.meta, ...metaExtra, fetched: new Date().toISOString(), source: sources.join(' + ') + ' (direct employers only)' };
  fs.writeFileSync(JOBS_FILE, 'window.JOB_DATA=' + JSON.stringify({ meta, jobs: all }, null, 1) + ';\n');
  console.log(`${source} [${category}]: kept ${fresh.length} jobs (${jobs.length - fresh.length} duplicates of other sources); file now has ${all.length}`);
}

module.exports = { loadSponsors, loadJobs, loadScript, saveSource, dupKey, localDate, JOBS_FILE };
