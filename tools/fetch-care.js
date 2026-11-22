// Collects frontline healthcare vacancies (care worker, home care, support worker, healthcare assistant;
// nursing roles are left out)
// into web/data/jobs.js (category "care").
// Every job from a direct employer with an A-rated Skilled Worker sponsor licence is kept, and tagged with what the
// advert says about sponsorship: 'offered', 'not mentioned', 'not offered', or 'professional only' when the company's
// adverts limit sponsorship to RQF 6 / nursing / registered roles. Adverts from consultancies and recruitment
// agencies are kept only when the advert offers sponsorship, and are labelled "Agency". Senior, lead and management
// roles are left out, and so is every company listed in tools/care-exclude.json (e.g. HICA Group).
// It also keeps tools/care-evidence.json: for each employer, the latest advert date in which it offered
// care sponsorship. (The Home Office doesn't publish certificate-of-sponsorship dates per company.)
// Usage: node tools/fetch-care.js [--no-cvlibrary]
const fs = require('fs');
const path = require('path');
const { isAgency, key } = require('./sponsor-match');
const F = require('./job-filters');
const C = require('./care-filters');
const { loadSponsors, saveSource } = require('./jobs-file');

// Direct employers: every frontline role (the licence is checked on each card). Agencies: only adverts about sponsorship.
const REED_KEYWORDS = ['care worker', 'carer', 'home carer', 'care assistant', 'support worker', 'healthcare assistant', 'domiciliary care worker',
  'live in carer', 'care worker visa sponsorship', 'care worker certificate of sponsorship'];
const REED_AGENCY_KEYWORDS = ['care worker visa sponsorship', 'care worker sponsorship', 'support worker visa sponsorship', 'healthcare assistant sponsorship',
  'care worker sponsorship transfer', 'live in carer sponsorship'];
const CVL_SEARCHES = ['care-worker-jobs?tempperm=Permanent', 'home-care-worker-jobs?tempperm=Permanent', 'care-assistant-jobs?tempperm=Permanent',
  'support-worker-jobs?tempperm=Permanent', 'domiciliary-care-worker-jobs?tempperm=Permanent', 'healthcare-assistant-jobs?tempperm=Permanent',
  'care-worker-jobs?q=sponsorship', 'search-jobs?q=carer+visa+sponsorship'];
// --no-cvlibrary: Reed only (the public GitHub feed doesn't scrape CV-Library).
const NO_CVL = process.argv.includes('--no-cvlibrary');
const REED_PAGES = 40, REED_AGENCY_PAGES = 3, CVL_PAGES = 12, DELAY_MS = 500;
const AGENCY_TYPE = 1;                                                       // Reed's ouType for recruitment agencies
const CONSULTANCY = /consult(?:ancy|ancies|ants?|ing)\b|agency|staff(?:ing)?\s+(?:solutions|services)|\bnursing\s+services\b/i;
const EVIDENCE_FILE = path.join(__dirname, 'care-evidence.json');
const today = new Date().toISOString().slice(0, 10);

async function nextData(url) {
  const html = await F.getText(url);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  try { return m ? JSON.parse(m[1]).props.pageProps : null; } catch { return null; }
}

(async () => {
  const { match, describe } = loadSponsors();
  const excluded = C.excludedCompanies();
  const isExcluded = name => !name || excluded.has(key(name));
  // The A-rated Skilled Worker licence held by this company, if any.
  const licenceOf = name => {
    const m = match(name); if (!m) return null;
    const d = describe(m);
    return C.hasSkilledWorkerA(d) && !excluded.has(key(d.name)) ? d : null;
  };
  // Who posted it: a direct employer needs its own licence; a consultancy or agency is checked on the advert's wording.
  const poster = (name, agencyFlag) => {
    if (isExcluded(name)) return null;
    const agency = agencyFlag || isAgency(name) || CONSULTANCY.test(name);
    const sponsor = licenceOf(name);
    return agency ? { agency, sponsor } : sponsor ? { agency, sponsor } : null;
  };

  /* ---- Reed: direct employers, then agencies and consultancies ---- */
  const reed = new Map();
  for (const [query, pages, keywords] of [['direct=true', REED_PAGES, REED_KEYWORDS], ['agency=true', REED_AGENCY_PAGES, REED_AGENCY_KEYWORDS]]) {
    for (const kw of keywords) {
      for (let page = 1; page <= pages; page++) {
        const pp = await nextData(`https://www.reed.co.uk/jobs?keywords=${encodeURIComponent(kw)}&${query}&pageno=${page}`);
        await F.sleep(DELAY_MS);
        const jobs = pp?.searchResults?.jobs || [];
        for (const j of jobs) if (!reed.has(j.jobDetail.jobId)) reed.set(j.jobDetail.jobId, { d: j.jobDetail, url: j.url, ouUrl: j.ouUrl });
        console.log(`reed "${kw}" [${query}] p${page}: ${jobs.length} (unique ${reed.size})`);
        if (jobs.length < 25) break;
      }
    }
  }

  /* ---- CV-Library ---- */
  const cvl = new Map();
  for (const s of NO_CVL ? [] : CVL_SEARCHES) {
    for (let page = 1; page <= CVL_PAGES; page++) {
      const html = await F.getTextCurl(`https://www.cv-library.co.uk/${s}&posted=28&offset=${(page - 1) * 20}`);
      await F.sleep(DELAY_MS);
      const cards = html.split(/data-qa="job-card-\d+"/).slice(1).map(c => ({
        href: (c.match(/<a href="(\/job\/\d+[^"]*)"/) || [])[1],
        title: F.plainText((c.match(/data-qa="job-title-link"[^>]*>([\s\S]*?)<\/a>/) || [])[1]),
        company: F.plainText((c.match(/data-qa="job-card-company-link-\d+"[^>]*>([\s\S]*?)<\/(?:span|a)>/) || [])[1]),
        location: F.plainText((c.match(/data-qa="job-card-location-\d+"[^>]*>([\s\S]*?)<\/div><\/div>/) || [])[1]),
        salary: F.plainText((c.match(/data-qa="job-card-salary-\d+"[^>]*>([\s\S]*?)<\/div>/) || [])[1]),
      })).filter(c => c.href && c.title);
      let added = 0;
      for (const c of cards) if (!cvl.has(c.href)) { cvl.set(c.href, c); added++; }
      console.log(`cv-library "${s}" p${page}: ${cards.length} (unique ${cvl.size})`);
      if (!cards.length || !added) break;
    }
  }

  /* ---- read each candidate advert ---- */
  const checked = [];   // { job, company, status }
  for (const { d, url, ouUrl } of reed.values()) {
    const title = (d.jobTitle || '').trim(), employer = (d.ouName || '').trim();
    if (!C.isCareRole(title)) continue;
    const who = poster(employer, d.ouType === AGENCY_TYPE); if (!who) continue;
    const { agency, sponsor } = who;
    const pp = await nextData('https://www.reed.co.uk' + url); await F.sleep(DELAY_MS);
    const jd = pp?.consolidatedJobDetails?.jobDetails;
    if (!jd || !jd.isLive || jd.isSuspended) continue;
    const loc = jd.jobLocation || {};
    if (loc.countryCode && loc.countryCode !== 'GB') continue;
    const full = F.sanitise(jd.description), plain = F.plainText(full), description = F.trimHtml(full, C.DESC_MAX);
    const sal = jd.jobSalary || {}, hourly = d.salaryType === 1;
    checked.push({ company: employer, status: C.careSponsorship(plain), job: {
      id: 'reed-' + jd.id, title, company: employer, employerType: agency ? 'Agency' : 'Direct', level: 'Care', careKind: C.careKind(title),
      location: [...new Set([loc.townName || loc.locationName, loc.countyName].filter(Boolean))].join(', '),
      region: loc.regionName || '', postcode: loc.postCode || '', workingOption: 'onsite',
      contract: jd.jobContractType?.name || (jd.isTemp ? 'Temporary' : 'Permanent'), fullTime: !!jd.jobEmploymentHours?.isFullTime,
      salaryFrom: !hourly && d.salaryType === 5 ? (sal.fromPerAnnum || d.salaryFrom || null) : null,
      salaryTo: !hourly && d.salaryType === 5 ? (sal.toPerAnnum || d.salaryTo || null) : null,
      hourlyFrom: hourly ? d.salaryFrom || null : null, hourlyTo: hourly ? d.salaryTo || d.salaryFrom || null : null,
      salaryText: (sal.displaySalary || '').replace(/£ /g, '£') || 'Pay not disclosed',
      posted: (jd.displayDate || jd.createdDate || '').slice(0, 10), expires: (jd.expiryDate || '').slice(0, 10),
      skills: [], description, inUkOnly: C.IN_UK_ONLY.test(plain),
      source: 'Reed.co.uk', sourceUrl: 'https://www.reed.co.uk' + url, companyProfileUrl: ouUrl ? 'https://www.reed.co.uk' + ouUrl : '', sponsor } });
  }
  for (const c of cvl.values()) {
    if (!C.isCareRole(c.title)) continue;
    const who = poster(c.company, false); if (!who) continue;
    const { agency, sponsor } = who;
    const html = await F.getTextCurl('https://www.cv-library.co.uk' + c.href); await F.sleep(DELAY_MS);
    const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map(x => { try { return JSON.parse(x[1]); } catch { return null; } }).find(x => x && x['@type'] === 'JobPosting');
    if (!ld || (ld.validThrough && new Date(ld.validThrough) < new Date())) continue;
    const full = F.sanitise(ld.description), plain = F.plainText(full), description = F.trimHtml(full, C.DESC_MAX);
    const v = ld.baseSalary?.value || {}, unit = (v.unitText || '').toUpperCase(), addr = ld.jobLocation?.address || {};
    const pay = C.parseCarePay(c.salary);
    checked.push({ company: c.company, status: C.careSponsorship(plain), job: {
      id: 'cvl-' + (c.href.match(/\/job\/(\d+)/) || [])[1], title: c.title, company: c.company, employerType: agency ? 'Agency' : 'Direct', level: 'Care', careKind: C.careKind(c.title),
      location: c.location || [addr.addressLocality, addr.addressRegion].filter(Boolean).join(', '), region: addr.addressRegion || '', postcode: addr.postalCode || '',
      workingOption: 'onsite', contract: (ld.employmentType || []).includes('TEMPORARY') ? 'Temporary' : 'Permanent', fullTime: (ld.employmentType || []).includes('FULL_TIME'),
      salaryFrom: unit === 'YEAR' ? v.minValue || v.value || null : null, salaryTo: unit === 'YEAR' ? v.maxValue || v.value || null : null,
      hourlyFrom: unit === 'HOUR' ? v.minValue || v.value || null : pay?.hourlyFrom || null, hourlyTo: unit === 'HOUR' ? v.maxValue || v.value || null : pay?.hourlyTo || null,
      salaryText: c.salary || 'Pay not disclosed', posted: (ld.datePosted || '').slice(0, 10), expires: (ld.validThrough || '').slice(0, 10),
      skills: [], description, inUkOnly: C.IN_UK_ONLY.test(plain),
      source: 'CV-Library', sourceUrl: 'https://www.cv-library.co.uk' + c.href.split('?')[0], companyProfileUrl: '', sponsor } });
  }

  /* ---- company-level decision ---- */
  // Any advert limiting sponsorship to RQF 6 / nurses / registered roles means the company isn't sponsoring care workers,
  // so its non-nursing jobs are tagged 'professional only'. Companies are keyed by register name, or advertised name for agencies.
  const coKey = x => key(x.job.sponsor?.name || x.job.company);
  const restricted = new Set(checked.filter(x => x.status === 'professional only').map(coKey));
  for (const x of checked) if (restricted.has(coKey(x)) && x.job.careKind !== 'Nurse') x.status = 'professional only';
  // Direct employers (licensed): every advert. Agencies and consultancies: only adverts that offer sponsorship.
  const kept = checked.filter(x => !/temporary/i.test(x.job.contract) && (x.job.employerType === 'Direct' || x.status === 'offered'));

  /* ---- evidence log: latest advert offering care sponsorship, per company ---- */
  const ev = fs.existsSync(EVIDENCE_FILE) ? JSON.parse(fs.readFileSync(EVIDENCE_FILE, 'utf8')) : { companies: {} };
  for (const x of checked) {
    const k = coKey(x), e = ev.companies[k] || (ev.companies[k] = { name: x.job.sponsor?.name || x.job.company, licensed: !!x.job.sponsor, firstSeen: today });
    e.lastChecked = today;
    if (restricted.has(k)) e.restricted = 'Sponsorship limited to RQF 6 / nursing / registered roles';
    if (x.status === 'offered' && x.job.posted && (!e.lastSponsoredAdvert || x.job.posted > e.lastSponsoredAdvert)) e.lastSponsoredAdvert = x.job.posted;
  }
  ev.updated = today;
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(ev, null, 1));
  for (const x of kept) {
    const e = ev.companies[coKey(x)];
    x.job.careEvidence = { lastSponsoredAdvert: e.lastSponsoredAdvert || '', firstSeen: e.firstSeen };
    x.job.sponsorship = x.status;
  }

  // CARE_DUMP=<file> writes every checked advert's verdict and sponsorship sentences, for reviewing the rules.
  if (process.env.CARE_DUMP) fs.writeFileSync(process.env.CARE_DUMP, JSON.stringify(checked.map(x => ({ status: x.status, title: x.job.title, company: x.job.company, url: x.job.sourceUrl,
    sentences: [...F.plainText(x.job.description).matchAll(/[^.]{0,140}(?:sponsor|visa|right to work|cos\b)[^.]{0,140}/gi)].map(m => m[0].trim()).slice(0, 4) })), null, 1));
  const counts = checked.reduce((m, x) => (m[x.status] = (m[x.status] || 0) + 1, m), {});
  console.log(`checked ${checked.length} care adverts (${checked.filter(x => x.job.employerType === 'Agency').length} agency/consultancy):`, counts, `| restricted companies: ${[...restricted].join(', ') || 'none'}`);
  const bySource = s => kept.filter(x => x.job.source === s).map(x => x.job);
  for (const x of kept) console.log(`  + ${x.job.title} @ ${x.job.company} [${x.job.employerType}${x.job.sponsor ? ', licence: ' + x.job.sponsor.name : ''}] ${x.job.salaryText}${x.job.inUkOnly ? ' (in-UK switching)' : ''}`);
  saveSource('Reed.co.uk', bySource('Reed.co.uk'), { careReedScanned: reed.size }, 'care');
  if (!NO_CVL) saveSource('CV-Library', bySource('CV-Library'), { careCvlibraryScanned: cvl.size, careUpdated: today }, 'care');
})();
