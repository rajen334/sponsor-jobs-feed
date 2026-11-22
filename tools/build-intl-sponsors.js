// Builds web/data/intl-sponsors.js: public sponsor data for the non-UK countries in the app.
//  - Netherlands: the IND public register of recognised sponsors for regular labour and highly skilled migrants
//    (only recognised sponsors can apply for a highly skilled migrant permit for an employee).
//  - Ireland: DETE "employment permits issued to companies", this year and last year, month by month. This is the
//    only one of the four countries that publishes, per employer, when work permits were last issued.
//  - Germany has no sponsor register: any employer can hire through the EU Blue Card, so adverts are judged on their wording.
// Usage: node tools/build-intl-sponsors.js
const fs = require('fs');
const path = require('path');
const { readSheet } = require('./xlsx-read');

const OUT = path.join(__dirname, '..', 'web', 'data', 'intl-sponsors.js');
const IND_URL = 'https://ind.nl/en/public-register-recognised-sponsors/public-register-regular-labour-and-highly-skilled-migrants';
const DETE = 'https://enterprise.gov.ie';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const get = async (url, binary) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
};
const decode = s => s.replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

async function netherlands() {
  const html = await get(IND_URL);
  const names = [...html.matchAll(/<th scope="row">([^<]+)<\/th>\s*<td>\d+<\/td>/g)].map(m => decode(m[1]));
  if (names.length < 1000) throw new Error(`IND register: only ${names.length} sponsors found; the page layout may have changed`);
  return { source: IND_URL, count: names.length, names: [...new Set(names)] };
}

// One year's file: { name -> [total, last month with a permit (1-12)] }.
async function irelandYear(year) {
  const page = await get(`${DETE}/en/publications/employment-permit-statistics-${year}.html`);
  const href = (page.match(/href="([^"]*issued-to-companies[^"]*\.xlsx)"/i) || [])[1];
  if (!href) return null;
  const rows = readSheet(await get(DETE + href, true));
  const head = rows.findIndex(r => r.some(c => /jan/i.test(c || '')));
  const cols = rows[head].map(c => MONTHS.findIndex(m => new RegExp('\\b' + m, 'i').test(c || '')));
  const totalCol = rows[head].findIndex(c => /total/i.test(c || ''));
  const out = new Map();
  let through = 0;
  for (const r of rows.slice(head + 1)) {
    const name = decode(r[0] || '');
    if (!name || /^(grand )?total$/i.test(name)) continue;
    let last = 0;
    cols.forEach((m, i) => { if (m >= 0 && +r[i] > 0) { last = Math.max(last, m + 1); through = Math.max(through, m + 1); } });
    out.set(name, [+r[totalCol] || 0, last]);
  }
  return { year, file: DETE + href, through, companies: out };
}

(async () => {
  const nl = await netherlands();
  const thisYear = new Date().getFullYear();
  const years = (await Promise.all([thisYear, thisYear - 1].map(irelandYear))).filter(Boolean);
  if (!years.length) throw new Error('no DETE permits-by-company file found');
  const [cur, prev] = years.length === 2 ? years : [years[0], null];
  // [name, permits this year, permits last year, last month a permit was issued ("2026-10")]
  const names = new Set([...cur.companies.keys(), ...(prev ? prev.companies.keys() : [])]);
  const ie = [...names].map(n => {
    const c = cur.companies.get(n), p = prev && prev.companies.get(n);
    const last = c && c[1] ? `${cur.year}-${String(c[1]).padStart(2, '0')}` : p && p[1] ? `${prev.year}-${String(p[1]).padStart(2, '0')}` : '';
    return [n, c ? c[0] : 0, p ? p[0] : 0, last];
  });
  const data = {
    meta: { generated: new Date().toISOString().slice(0, 10),
      nl: { source: nl.source, count: nl.names.length },
      ie: { years: years.map(y => ({ year: y.year, file: y.file, through: `${y.year}-${String(y.through).padStart(2, '0')}` })), count: ie.length } },
    nl: nl.names,
    ie,
  };
  fs.writeFileSync(OUT, 'window.INTL_SPONSORS=' + JSON.stringify(data) + ';\n');
  console.log(`intl-sponsors.js: ${nl.names.length} IND recognised sponsors; ${ie.length} Irish employers with permits (${years.map(y => `${y.year} to ${y.through}`).join(', ')})`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
