// Daily update: refreshes the sponsor register when the Home Office publishes a new one, re-runs the job fetchers
// switched on in tools/daily-sources.json, then finalize-jobs.js (which drops closed and expired adverts) and
// geocode-jobs.js (coordinates for the distance shown in the app).
// Jobs first collected today keep firstSeen = today, and the app marks them "New today".
// Progress goes to logs/refresh-status.json, which the app's Sync panel reads through tools/serve.js.
// Usage: node tools/daily-refresh.js [--preset quick|dotnet|qa|care|all] [--only reed-dotnet,nhs] [--no-register] [--no-jobs] [--force-register]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadJobs, localDate, JOBS_FILE } = require('./jobs-file');

const ROOT = path.join(__dirname, '..');
const REGISTER_DIR = path.join(ROOT, '..');                      // the register CSVs sit next to the SponsorJobs folder
const SPONSORS_FILE = path.join(ROOT, 'web', 'data', 'sponsors.js');
const LOCK = path.join(ROOT, 'logs', 'refresh.lock');
const STATUS = path.join(ROOT, 'logs', 'refresh-status.json');
const REGISTER_API = 'https://www.gov.uk/api/content/government/publications/register-of-licensed-sponsors-workers';
const argv = process.argv.slice(2), flag = f => argv.includes(f);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

// Every fetcher the daily run knows about. Each one replaces only its own listings in web/data/jobs.js, so they run one at
// a time. "care" and "nhs" cover two boards each (fetch-care.js: Reed and CV-Library; fetch-nhs.js: NHS Jobs and NHS Scotland).
const SOURCES = {
  'reed-dotnet': ['fetch-jobs.js', '--cat', 'dotnet'],
  'linkedin-dotnet': ['fetch-linkedin.js', '--cat', 'dotnet'],
  'cvlibrary-dotnet': ['fetch-cvlibrary.js', '--cat', 'dotnet'],
  'reed-qa': ['fetch-jobs.js', '--cat', 'qa'],
  'linkedin-qa': ['fetch-linkedin.js', '--cat', 'qa'],
  'cvlibrary-qa': ['fetch-cvlibrary.js', '--cat', 'qa'],
  'care': ['fetch-care.js'],
  'care-reed': ['fetch-care.js', '--no-cvlibrary'],          // Reed only, for the public GitHub feed
  'nhs': ['fetch-nhs.js'],
  // Ireland, Germany and the Netherlands (LinkedIn), one category at a time.
  'intl-dotnet': ['fetch-intl.js', '--cat', 'dotnet'],
  'intl-qa': ['fetch-intl.js', '--cat', 'qa'],
  'intl-care': ['fetch-intl.js', '--cat', 'care'],
};
// Sync options offered in the app. "all" is the daily list in daily-sources.json.
const PRESETS = {
  quick: ['reed-dotnet', 'reed-qa', 'nhs'],
  dotnet: ['reed-dotnet', 'linkedin-dotnet', 'cvlibrary-dotnet'],
  qa: ['reed-qa', 'linkedin-qa', 'cvlibrary-qa'],
  care: ['care', 'nhs'],
  europe: ['intl-dotnet', 'intl-qa', 'intl-care'],
};

function config() {
  const file = path.join(__dirname, 'daily-sources.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { register: true, sources: [] };
  const only = opt('--only'), preset = opt('--preset');
  if (preset && preset !== 'all' && !PRESETS[preset]) throw new Error(`unknown preset: ${preset}. Known: ${Object.keys(PRESETS).join(', ')}, all`);
  const sources = only ? only.split(',').map(s => s.trim()).filter(Boolean) : PRESETS[preset] || cfg.sources || [];
  const unknown = sources.filter(s => !SOURCES[s]);
  if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(', ')}. Known: ${Object.keys(SOURCES).join(', ')}`);
  return { preset: preset || (only ? 'custom' : 'all'), register: cfg.register !== false && !flag('--no-register'), sources: flag('--no-jobs') ? [] : sources };
}

// One run at a time: the scheduled task and the dev server's start-up refresh could otherwise overlap.
function takeLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  if (fs.existsSync(LOCK)) {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < 6 * 3600e3) { console.log(`another refresh is running (${LOCK}, started ${Math.round(age / 60e3)} min ago); stopping`); return false; }
    console.log('removing a stale lock from a run that didn\'t finish');
  }
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}

let status = {};
const setStatus = s => { status = { ...status, ...s, updated: new Date().toISOString() }; fs.writeFileSync(STATUS, JSON.stringify(status, null, 1)); };

const node = (script, args = []) => spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: ROOT, stdio: 'inherit' }).status === 0;
const currentRegister = () => (fs.existsSync(SPONSORS_FILE) && (fs.readFileSync(SPONSORS_FILE, 'utf8').slice(0, 400).match(/"source":"([^"]+)"/) || [])[1]) || '';

// The GOV.UK publication page lists the latest register CSV as an attachment; a new file name means a new register.
async function refreshRegister() {
  const res = await fetch(REGISTER_API, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('GOV.UK content API: HTTP ' + res.status);
  const page = await res.json();
  const csv = (page.details?.attachments || []).find(a => a.content_type === 'text/csv' || /\.csv$/i.test(a.url || ''));
  if (!csv) throw new Error('no CSV attachment on the register page');
  const name = decodeURIComponent(csv.url.split('/').pop());
  if (name === currentRegister() && !flag('--force-register')) { console.log(`register is current (${name})`); return { file: name, changed: false }; }
  const dest = path.join(REGISTER_DIR, name);
  if (!fs.existsSync(dest)) {
    console.log(`downloading ${csv.url}`);
    const r = await fetch(csv.url);
    if (!r.ok) throw new Error('register download: HTTP ' + r.status);
    const text = await r.text();
    if (!/^﻿?"?Organisation Name/i.test(text)) throw new Error('register download doesn\'t look like the sponsor register CSV');
    fs.writeFileSync(dest + '.part', text); fs.renameSync(dest + '.part', dest);
  }
  if (!node('build-sponsors.js', [dest])) throw new Error('build-sponsors.js failed');
  return { file: name, changed: true };
}

(async () => {
  const started = new Date();
  console.log(`\n=== daily refresh ${started.toLocaleString('en-GB')}`);
  const cfg = config();
  if (!takeLock()) return;
  const steps = [...(cfg.register ? ['register'] : []), ...cfg.sources, 'finalize', 'geocode'];
  const step = id => setStatus({ step: id, done: steps.indexOf(id) });
  setStatus({ running: true, pid: process.pid, preset: cfg.preset, startedAt: started.toISOString(), steps, step: steps[0], done: 0,
    finishedAt: null, ok: null, error: null, summary: null });
  try {
    const before = loadJobs();
    const beforeIds = new Set(before.jobs.map(j => j.id));
    const log = [];

    let register = { file: currentRegister(), changed: false };
    if (cfg.register) {
      step('register');
      try { register = await refreshRegister(); log.push({ id: 'register', ok: true, changed: register.changed }); }
      catch (e) { console.warn('!!! register refresh failed: ' + e.message); log.push({ id: 'register', ok: false, error: e.message }); }
      // Irish permit counts and the Dutch IND register change monthly at most, but they are small to fetch.
      if (cfg.sources.some(id => id.startsWith('intl-'))) log.push({ id: 'intl-register', ok: node('build-intl-sponsors.js') });
    }
    // When each job board last synced, shown in the app (runs from before this was recorded come from the last run's log).
    const sourceRuns = before.meta.sourceRuns ? { ...before.meta.sourceRuns }
      : Object.fromEntries((before.meta.refreshLog || []).filter(l => l.ok && l.minutes != null).map(l => [l.id, before.meta.lastRefresh]));
    for (const id of cfg.sources) {
      const t = Date.now();
      step(id);
      console.log(`\n=== ${id} (${new Date().toLocaleTimeString('en-GB')})`);
      const ok = node(SOURCES[id][0], SOURCES[id].slice(1));
      if (!ok) console.warn(`!!! ${id} failed`);
      log.push({ id, ok, minutes: +((Date.now() - t) / 60e3).toFixed(1) });
      if (ok) sourceRuns[id] = new Date().toISOString();
    }
    step('finalize');
    console.log('\n=== finalize');
    if (!node('finalize-jobs.js')) throw new Error('finalize-jobs.js failed');
    console.log('\n=== geocode');
    step('geocode');
    log.push({ id: 'geocode', ok: node('geocode-jobs.js') });       // distances in the app; a failure leaves the jobs listed

    // Listings that no fetcher has touched since firstSeen was added take the previous fetch date, so they don't show as new.
    const data = loadJobs(), today = localDate();
    const baseline = before.meta.fetched ? localDate(new Date(before.meta.fetched)) : today;
    data.jobs.forEach(j => { if (!j.firstSeen) j.firstSeen = beforeIds.has(j.id) ? baseline : today; });
    const afterIds = new Set(data.jobs.map(j => j.id));
    const added = data.jobs.filter(j => !beforeIds.has(j.id)).length, removed = [...beforeIds].filter(id => !afterIds.has(id)).length;
    data.meta = { ...data.meta, previousRefresh: before.meta.lastRefresh || before.meta.fetched || null, lastRefresh: new Date().toISOString(),
      newToday: data.jobs.filter(j => j.firstSeen === today).length, addedLastRun: added, removedLastRun: removed,
      register: register.file, refreshLog: log, sourceRuns };
    fs.writeFileSync(JOBS_FILE, 'window.JOB_DATA=' + JSON.stringify(data, null, 1) + ';\n');
    console.log(`\n=== done in ${((Date.now() - started) / 60e3).toFixed(1)} min: ${data.jobs.length} jobs, ${added} new, ${removed} removed (closed, expired or gone from the board); register ${register.file}${register.changed ? ' (updated)' : ''}`);
    if (log.some(l => !l.ok)) process.exitCode = 1;
    setStatus({ running: false, step: null, done: steps.length, finishedAt: new Date().toISOString(), ok: !log.some(l => !l.ok),
      error: log.filter(l => !l.ok).map(l => l.id + ' failed').join('; ') || null,
      summary: { jobs: data.jobs.length, added, removed, newToday: data.meta.newToday } });
  } catch (e) {
    setStatus({ running: false, finishedAt: new Date().toISOString(), ok: false, error: e.message });
    throw e;
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
