// Collects NHS England and NHS Wales (NHS Jobs) and NHS Scotland (jobs.scot.nhs.uk) frontline healthcare vacancies into
// web/data/jobs.js, category "care". A job is kept when:
//  - the title is a Band 2–4 frontline role: healthcare / nursing / clinical support worker, HCA or nursing assistant
//    (nurses, nursing associates, senior, charge, specialist and management posts are left out),
//  - the NHS body holds an A-rated Skilled Worker licence on the register,
//  - and it's a permanent post that hasn't closed.
// Each job is tagged with what the advert says about sponsorship: 'offered', 'not offered', 'not mentioned', or 'nhs statement'
// when it carries only the standard NHS Jobs sponsorship paragraph, which appears on every advert, whatever the role.
// Usage: node tools/fetch-nhs.js [--dry]
const fs = require('fs');
const path = require('path');
const { key } = require('./sponsor-match');
const F = require('./job-filters');
const C = require('./care-filters');
const { loadSponsors, saveSource } = require('./jobs-file');

const KEYWORDS = ['healthcare support worker', 'health care assistant', 'nursing support worker', 'clinical support worker',
  'nursing assistant', 'care assistant', 'support worker', 'healthcare assistant'];
// --dry: one results page per keyword and nothing written, for checking the parsing.
const DRY = process.argv.includes('--dry');
const NHSJOBS_PAGES = DRY ? 1 : 150, SCOT_PAGES = DRY ? 1 : 12, DELAY_MS = 600, PARALLEL = 4;
const EVIDENCE_FILE = path.join(__dirname, 'care-evidence.json');
const today = new Date().toISOString().slice(0, 10);
// Plain text, with numeric entities such as &#xA3; (£) decoded.
const text = s => F.plainText((s || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)));
const isoDate = s => {                                       // "26 October 2026" or "26/10/2026"
  const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date((s || '').replace(/^.*?(\d{1,2} \w+ \d{4}).*$/, '$1') + ' UTC');
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
};
const salaryRange = s => {
  const n = ((s || '').match(/£\s?[\d,]+(?:\.\d+)?/g) || []).map(x => +x.replace(/[£,\s]/g, '')).filter(x => x > 5000);
  return { from: n[0] || null, to: n[1] || n[0] || null };
};
// Runs fn over items with a few requests in flight at once.
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const item = items[i++]; await fn(item); await F.sleep(DELAY_MS); } }));
}
const between = (h, start, end) => { const i = h.indexOf(start); if (i < 0) return ''; const j = h.indexOf(end, i + start.length); return h.slice(i, j < 0 ? i + 20000 : j); };

(async () => {
  const { match, describe, nhsMatch } = loadSponsors();
  const excluded = C.excludedCompanies();
  const licenceOf = board => {
    const name = C.nhsRegisterName(board);
    if (!name || excluded.has(key(name))) return null;
    const m = match(name) || nhsMatch(board); if (!m) return null;
    const d = describe(m);
    return C.hasSkilledWorkerA(d) ? d : null;
  };
  const checked = [];   // { status, job }
  const noLicence = new Set();

  /* ---- NHS England and NHS Wales via NHS Jobs ---- */
  const wales = new Map();
  for (const kw of KEYWORDS) {
    const bands = 'BAND_2,BAND_3,BAND_4';
    for (let page = 1; page <= NHSJOBS_PAGES; page++) {
      const h = await F.getTextCurl(`https://www.jobs.nhs.uk/candidate/search/results?keyword=${encodeURIComponent(kw)}&payBand=${bands}&page=${page}`);
      await F.sleep(DELAY_MS);
      const cards = h.split('data-test="search-result"').slice(1).map(p => ({
        ref: (p.match(/href="\/candidate\/jobadvert\/([^"?]+)/) || [])[1],
        title: text((p.match(/data-test="search-result-job-title"[^>]*>([\s\S]*?)<\/a>/) || [])[1]),
        employer: text((p.match(/data-test="search-result-location">\s*<h3[^>]*>([\s\S]*?)<div/) || [])[1]),
      })).filter(c => c.ref);
      let added = 0;
      for (const c of cards) if (!wales.has(c.ref)) { wales.set(c.ref, c); added++; }
      if (page % 10 === 1 || cards.length < 10) console.log(`nhs jobs "${kw}" p${page}: ${cards.length} (unique ${wales.size})`);
      if (cards.length < 10 || !added) break;
    }
  }
  const nhsCandidates = [...wales.values()].filter(c => {
    if (!C.isNhsRole(c.title)) return false;
    if (!licenceOf(c.employer)) { noLicence.add(c.employer); return false; }
    return true;
  });
  console.log(`NHS Jobs: ${nhsCandidates.length} frontline adverts at licensed bodies to read`);
  let done = 0;
  await pool(nhsCandidates, PARALLEL, async c => {
    const sponsor = licenceOf(c.employer);
    const url = 'https://www.jobs.nhs.uk/candidate/jobadvert/' + c.ref;
    const h = await F.getTextCurl(url);
    if (++done % 100 === 0) console.log(`  read ${done}/${nhsCandidates.length}`);
    if (!h) return;
    const field = id => text((h.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</(?:p|span|h1)>`)) || [])[1]);
    const statementBlock = between(h, 'id="tier-two-sponsorship"', '</div>');
    const hasStatement = C.NHS_STATEMENT.test(text(statementBlock));
    const descHtml = between(h, 'id="job_overview"', 'id="dbs-container"').replace(/^[^>]*>/, '<div>');
    const full = F.sanitise(descHtml), plain = text(full), description = F.trimHtml(full, C.DESC_MAX);
    const sal = salaryRange(field('range_salary'));
    const company = field('employer_name') || c.employer, nation = C.nhsNation(company), title = field('heading') || c.title;
    checked.push({ status: C.nhsSponsorship(plain, hasStatement), job: {
      id: (nation === 'Wales' ? 'nhsw-' : 'nhse-') + c.ref, title, company, employerType: 'Direct', level: 'Care',
      careKind: C.nhsKind(title), nhs: nation, location: [field('employer_town'), nation].filter(Boolean).join(', '), region: nation, postcode: field('employer_postcode'),
      workingOption: 'onsite', contract: field('contract_type') || 'Permanent', fullTime: /full/i.test(text(between(h, 'id="working_pattern_heading"', '</p>'))),
      salaryFrom: sal.from, salaryTo: sal.to, salaryText: field('range_salary').replace(/\s*per annum$/i, '') || 'Pay not shown', band: field('payscheme-band'),
      posted: isoDate(field('date_posted')), expires: isoDate(field('closing_date')), skills: [], description,
      inUkOnly: C.IN_UK_ONLY.test(plain), nhsStatement: hasStatement, source: 'NHS Jobs', sourceUrl: url, companyProfileUrl: '', sponsor } });
  });

  /* ---- NHS Scotland via jobs.scot.nhs.uk ---- */
  const scot = new Map();
  for (const kw of KEYWORDS) {
    for (let page = 1; page <= SCOT_PAGES; page++) {
      const h = await F.getTextCurl(`https://apply.jobs.scot.nhs.uk/Home/_JobCard?Skip=${(page - 1) * 12}&Take=12&what=${encodeURIComponent(kw)}`);
      await F.sleep(DELAY_MS);
      const total = +((h.match(/totalMatchRecords" value="(\d+)"/) || [])[1] || 0);
      // Each card: a title link (data-testid="a-job-detail-…"), then <p class="jobdetailsitem salary"><strong>Salary:</strong> …</p> etc.
      const cards = h.split(/href="\/Job\/JobDetail\?JobId=(?=\d+" data-testid="a-job-detail)/).slice(1).map(p => {
        const item = cls => text(((p.match(new RegExp(`class="jobdetailsitem ${cls}"[^>]*>([\\s\\S]*?)</p>`)) || [])[1] || '').replace(/<strong>[\s\S]*?<\/strong>/, ''));
        return { id: (p.match(/^(\d+)/) || [])[1], title: text((p.match(/^\d+"[^>]*>([\s\S]*?)<\/a>/) || [])[1]), salary: item('salary'), employer: item('school'),
          contract: item('employmenttype'), location: item('location'), posted: item('livedate'), closes: item('closingdate') };
      }).filter(c => c.id);
      let added = 0;
      for (const c of cards) if (!scot.has(c.id)) { scot.set(c.id, c); added++; }
      console.log(`nhs scotland "${kw}" p${page}: ${cards.length} of ${total} (unique ${scot.size})`);
      if (page * 12 >= total || !added) break;
    }
  }
  for (const c of scot.values()) {
    if (!C.isNhsRole(c.title)) continue;
    if (/bank|fixed|temp/i.test(c.contract)) continue;
    const sponsor = licenceOf(c.employer); if (!sponsor) { noLicence.add(c.employer); continue; }
    const url = 'https://apply.jobs.scot.nhs.uk/Job/JobDetail?JobId=' + c.id;
    const h = await F.getTextCurl(url); await F.sleep(DELAY_MS);
    const full = F.sanitise(between(h, 'id="Media_Rich_Advert"', 'data-testid="div-job-other-details"').replace(/^[^>]*>/, '<div>'));
    const plain = text(full), description = F.trimHtml(full, C.DESC_MAX), sal = salaryRange(c.salary);
    checked.push({ status: C.nhsSponsorship(plain, false), job: {
      id: 'nhss-' + c.id, title: c.title, company: c.employer, employerType: 'Direct', level: 'Care', careKind: C.nhsKind(c.title), nhs: 'Scotland',
      location: [c.location, 'Scotland'].filter(Boolean).join(', '), region: 'Scotland', postcode: '', workingOption: 'onsite',
      contract: c.contract || 'Permanent', fullTime: false, salaryFrom: sal.from, salaryTo: sal.to, salaryText: c.salary || 'Pay not shown', band: (c.salary.match(/Band\s*\d\w?/i) || [''])[0],
      posted: isoDate(c.posted), expires: isoDate(c.closes), skills: [], description, inUkOnly: C.IN_UK_ONLY.test(plain), nhsStatement: false,
      source: 'NHS Scotland Jobs', sourceUrl: url, companyProfileUrl: '', sponsor } });
  }

  /* ---- keep, log evidence, save ---- */
  const kept = checked.filter(x => !/bank|fixed|temp/i.test(x.job.contract) && !(x.job.expires && x.job.expires < today));
  const ev = fs.existsSync(EVIDENCE_FILE) ? JSON.parse(fs.readFileSync(EVIDENCE_FILE, 'utf8')) : { companies: {} };
  for (const x of checked) {
    const k = key(x.job.sponsor.name), e = ev.companies[k] || (ev.companies[k] = { name: x.job.sponsor.name, licensed: true, firstSeen: today });
    e.lastChecked = today;
    // Only an advert's own wording counts as evidence; the standard NHS Jobs paragraph is on every advert.
    if (x.status === 'offered' && x.job.posted && (!e.lastSponsoredAdvert || x.job.posted > e.lastSponsoredAdvert)) e.lastSponsoredAdvert = x.job.posted;
  }
  ev.updated = today;
  if (!DRY) fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(ev, null, 1));
  for (const x of kept) {
    const e = ev.companies[key(x.job.sponsor.name)];
    x.job.careEvidence = { lastSponsoredAdvert: e.lastSponsoredAdvert || null, firstSeen: e.firstSeen };
    x.job.sponsorship = x.status;
  }
  const counts = checked.reduce((m, x) => (m[x.status] = (m[x.status] || 0) + 1, m), {});
  console.log(`checked ${checked.length} NHS frontline adverts at licensed boards:`, counts);
  if (noLicence.size) console.log('boards without an A-rated Skilled Worker licence match: ' + [...noLicence].join('; '));
  const byNation = kept.reduce((m, x) => (m[x.job.nhs] = (m[x.job.nhs] || 0) + 1, m), {});
  console.log('kept by nation:', byNation);
  if (DRY) {
    checked.filter(x => x.status !== 'nhs statement').forEach(x => console.log(`\n[${x.status}] ${x.job.title} @ ${x.job.company}\n  ` +
      ([...text(x.job.description).matchAll(/[^.]{0,140}(?:sponsor|visa\b)[^.]{0,140}/gi)].map(m => m[0].trim()).slice(0, 3).join('\n  ') || '(no sponsorship wording)')));
    return;
  }
  saveSource('NHS Jobs (Wales)', [], {}, 'care');   // listings from before NHS England was added
  saveSource('NHS Jobs', kept.filter(x => x.job.nhs !== 'Scotland').map(x => x.job), { nhsJobsScanned: wales.size }, 'care');
  saveSource('NHS Scotland Jobs', kept.filter(x => x.job.nhs === 'Scotland').map(x => x.job), { nhsScotlandScanned: scot.size, nhsUpdated: today }, 'care');
})();
