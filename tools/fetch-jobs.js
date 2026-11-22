// Collects .NET / C# (default) or QA / software testing (--cat qa) vacancies from Reed.co.uk into web/data/jobs.js:
//  - direct employers whose name is on the sponsor register, and
//  - recruitment-agency adverts (the client is usually unnamed, so these are labelled "Agency").
// Usage: node tools/fetch-jobs.js [--cat dotnet|qa] [--min 42000] [--max 85000]
const { isAgency } = require('./sponsor-match');
const F = require('./job-filters');
const { loadSponsors, saveSource } = require('./jobs-file');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const SALARY_MIN = arg('min', 42000), SALARY_MAX = arg('max', 85000);
const CAT = process.argv.includes('--cat') && process.argv[process.argv.indexOf('--cat') + 1] === 'qa' ? 'qa' : 'dotnet';
const P = F.PROFILES[CAT];
const MAX_PAGES = 12, AGENCY_PAGES = 8, DELAY_MS = 700;
const DOTNET_KEYWORDS = ['.net developer', 'c# developer', '.net engineer', 'c# engineer', 'c# software engineer',
  '.net software engineer', 'senior .net', 'senior c#', 'dotnet', 'asp.net', '.net core', 'full stack .net',
  'full stack c#', 'blazor', 'azure .net', 'backend c#', 'c# .net', 'software developer c#', 'software engineer .net',
  'net developer', 'c# test automation'];
const DOTNET_AGENCY_KEYWORDS = ['.net developer', 'c# developer', '.net engineer', 'c# software engineer', 'senior .net developer',
  'senior c# developer', 'full stack .net', 'asp.net', '.net core', 'blazor'];
const QA_KEYWORDS = ['qa engineer', 'qa tester', 'software tester', 'qa analyst', 'test engineer', 'test analyst', 'senior qa engineer', 'senior test engineer',
  'qa lead', 'lead qa engineer', 'test lead', 'test automation engineer', 'automation tester', 'sdet', 'quality assurance engineer', 'performance tester'];
const QA_AGENCY_KEYWORDS = ['qa engineer', 'software tester', 'qa analyst', 'test automation engineer', 'senior qa engineer', 'qa lead', 'test lead', 'automation tester'];
const KEYWORDS = CAT === 'qa' ? QA_KEYWORDS : DOTNET_KEYWORDS, AGENCY_KEYWORDS = CAT === 'qa' ? QA_AGENCY_KEYWORDS : DOTNET_AGENCY_KEYWORDS;
const NOT_EMPLOYERS = /^(anonymous|industry[- ]leading organisation|confidential|efinancialcareers|reed|hays)$/i;
const AGENCY_TYPE = 1;                                          // Reed's ouType for recruitment agencies

async function nextData(url) {
  const html = await F.getText(url);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]).props.pageProps : null;
}

function salaryOf(d, placeholder) {
  if (placeholder || (!d.salaryFrom && !d.salaryTo) || (d.salaryTo || d.salaryFrom) < 15000) return { ok: true, disclosed: false };
  if (d.salaryType !== 5) return { ok: false };                 // only per-annum salaries are comparable
  const lo = d.salaryFrom || d.salaryTo, hi = d.salaryTo || d.salaryFrom;
  return { ok: F.inBand(lo, hi, SALARY_MIN, SALARY_MAX), disclosed: true };
}

async function search(seen, keywords, query, pages) {
  for (const kw of keywords) {
    for (let page = 1; page <= pages; page++) {
      const pp = await nextData(`https://www.reed.co.uk/jobs?keywords=${encodeURIComponent(kw)}&${query}&pageno=${page}`);
      await F.sleep(DELAY_MS);
      const jobs = pp?.searchResults?.jobs || [];
      for (const j of jobs) if (!seen.has(j.jobDetail.jobId)) seen.set(j.jobDetail.jobId, { d: j.jobDetail, url: j.url, ouUrl: j.ouUrl });
      console.log(`${kw} [${query.split('&')[0]}] p${page}: ${jobs.length} (unique ${seen.size})`);
      if (jobs.length < 25) break;
    }
  }
}

(async () => {
  const { match, describe } = loadSponsors();
  const seen = new Map();
  await search(seen, KEYWORDS, 'direct=true', MAX_PAGES);
  await search(seen, AGENCY_KEYWORDS, `agency=true&perm=true&salaryFrom=${SALARY_MIN}&salaryTo=${SALARY_MAX}`, AGENCY_PAGES);

  const candidates = [];
  for (const { d, url, ouUrl } of seen.values()) {
    let title = d.jobTitle, employer = (d.ouName || '').trim(), board = false;
    // Job boards re-posting on Reed put the real employer after the last " - " in the title.
    if (/efinancialcareers/i.test(employer)) {
      const i = title.lastIndexOf(' - '); if (i < 0) continue;
      employer = title.slice(i + 3).trim(); title = title.slice(0, i).trim(); board = true;
    }
    if (!employer || NOT_EMPLOYERS.test(employer)) continue;
    if (!P.titleOk(title) || F.EXCLUDE_LEVEL.test(title) || F.NOT_PERMANENT.test(title)) continue;
    const sal = salaryOf(d, board); if (!sal.ok) continue;
    const agency = d.ouType === AGENCY_TYPE || isAgency(employer);
    const m = agency ? null : match(employer);
    if (!agency && !m) continue;                                // direct employer without a sponsor licence
    if (agency && !P.agencyTitleOk(title)) continue;
    candidates.push({ d, url, ouUrl: board ? '' : ouUrl, sal, m, employer, title, agency });
  }
  console.log(`scanned ${seen.size} unique, ${candidates.length} candidates (${candidates.filter(c => c.agency).length} agency)`);

  const out = [];
  for (const c of candidates) {
    const pp = await nextData('https://www.reed.co.uk' + c.url); await F.sleep(DELAY_MS);
    const jd = pp?.consolidatedJobDetails?.jobDetails;
    if (!jd || !jd.isLive || jd.isSuspended || jd.isContract || jd.isTemp) continue;
    const loc = jd.jobLocation || {};
    if (loc.countryCode && loc.countryCode !== 'GB') continue;
    const description = F.sanitise(jd.description);
    const plain = F.plainText(description);
    if (!P.isRole(c.title, plain + ' ' + (jd.jobSkills || []).map(s => s.name).join(' '))) continue;
    out.push({
      id: 'reed-' + jd.id,
      title: c.title.trim(),
      company: c.employer,
      employerType: c.agency ? 'Agency' : 'Direct',
      level: F.levelOf(c.title),
      ...(CAT === 'qa' ? { qaKind: F.qaKind(c.title, plain) } : {}),
      location: [...new Set([loc.townName || loc.locationName, loc.countyName].filter(Boolean))].join(', '),
      region: loc.regionName || '',
      postcode: loc.postCode || '',
      workingOption: loc.workingOption || (loc.isRemoteJob ? 'remote' : ''),
      contract: jd.jobContractType?.name || 'Permanent',
      fullTime: !!jd.jobEmploymentHours?.isFullTime,
      salaryFrom: c.sal.disclosed ? (jd.jobSalary?.fromPerAnnum || c.d.salaryFrom || null) : null,
      salaryTo: c.sal.disclosed ? (jd.jobSalary?.toPerAnnum || c.d.salaryTo || null) : null,
      salaryText: c.sal.disclosed ? (jd.jobSalary?.displaySalary || '').replace(/£ /g, '£') : 'Salary not disclosed',
      posted: (jd.displayDate || jd.createdDate || '').slice(0, 10),
      expires: (jd.expiryDate || '').slice(0, 10),
      skills: (jd.jobSkills || []).map(s => s.name).slice(0, 12),
      description,
      sponsorship: F.sponsorshipSignal(plain),
      source: 'Reed.co.uk',
      sourceUrl: 'https://www.reed.co.uk' + c.url,
      companyProfileUrl: c.ouUrl ? 'https://www.reed.co.uk' + c.ouUrl : '',
      sponsor: c.m ? describe(c.m) : null,
    });
    console.log(`  + ${c.agency ? '[agency] ' : ''}${c.title} @ ${c.employer}${c.m ? ` [${out.at(-1).sponsor.name}]` : ''}`);
  }
  saveSource('Reed.co.uk', out, { salaryMin: SALARY_MIN, salaryMax: SALARY_MAX, [CAT + 'ReedScanned']: seen.size }, CAT);
})();
