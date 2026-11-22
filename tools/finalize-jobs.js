// Final pass over web/data/jobs.js after the fetchers have run:
//  - drops roles that aren't really .NET/C# (e.g. a Python role whose advert mentions C# once),
//    agency jobs whose advert doesn't offer visa sponsorship,
//    temporary or fixed-term roles, adverts past their closing date, and adverts with no closing date
//    posted more than STALE_DAYS ago (LinkedIn shows no closing date);
//  - adds company websites from tools/company-sites.json (keys: company names, case-insensitive)
//    and company sizes from tools/company-sizes.json;
//  - fills in the visa-sponsorship wording signal for older listings;
//  - drops every advert whose wording rules sponsorship out ("no visa sponsorship", "must already have the right to work");
//  - keeps Irish, German and Dutch jobs (fetch-intl.js, j.country) on their own rules: the UK register doesn't apply to them;
//  - records, per employer, each advert seen offering sponsorship (tools/sponsor-evidence.json, kept across runs) and
//    copies the summary into meta.evidence, which the app's sponsorship likelihood uses.
const fs = require('fs');
const path = require('path');
const { key } = require('./sponsor-match');
const F = require('./job-filters');
const C = require('./care-filters');
const S = require('../web/sources');
const { loadJobs, loadSponsors, JOBS_FILE } = require('./jobs-file');

const data = loadJobs();
const { match, describe, nhsMatch } = loadSponsors();
const sitesFile = path.join(__dirname, 'company-sites.json');
const sites = fs.existsSync(sitesFile) ? JSON.parse(fs.readFileSync(sitesFile, 'utf8')) : {};
const byKey = new Map(Object.entries(sites).map(([name, url]) => [key(name), url]));
const today = new Date().toISOString().slice(0, 10);
const STALE_DAYS = 60, staleBefore = new Date(Date.now() - STALE_DAYS * 864e5).toISOString().slice(0, 10);
const closed = j => j.expires ? j.expires < today : !!j.posted && j.posted < staleBefore;
// Contract wording inside a description, for adverts not labelled as contracts.
const CONTRACT_TEXT = /\b(?:inside|outside) ir35\b|\bday rate\b|£\s?\d{3,4}\s?(?:-|–|to)?\s?(?:£\s?\d{3,4}\s?)?(?:per|a|\/)\s?day\b|\b\d{1,2}[- ]months?\s+(?:initial\s+)?(?:contract|fixed[- ]term|ftc)\b|\b(?:fixed[- ]term|temporary)\s+(?:contract|role|position)\b|\bthis is a (?:contract|temporary|temp) (?:role|position)\b/i;

const dropped = [];
const excludedCare = C.excludedCompanies();
// Care & health listings (fetch-care.js, fetch-nhs.js): frontline role, and an A-rated Skilled Worker licence for direct
// employers. Every advert from a licensed employer is kept and tagged with its sponsorship wording; agency adverts need
// to offer sponsorship. The fetchers store the verdict from the full advert (descriptions are shortened), so it's reused.
function careStatus(j, text) {
  if (j.sponsorship && j.sponsorship !== 'not mentioned') return j.sponsorship;
  return j.nhs ? C.nhsSponsorship(text, j.nhsStatement) : C.careSponsorship(text);
}
function keepCare(j) {
  const text = F.plainText(j.description);
  const status = careStatus(j, text);
  const reason = !(j.nhs ? C.isNhsRole(j.title) : C.isCareRole(j.title)) ? 'not a frontline healthcare role'
    : excludedCare.has(key(j.company)) || (j.sponsor && excludedCare.has(key(j.sponsor.name))) ? 'company excluded (care-exclude.json)'
    : status === 'not offered' || status === 'professional only' ? 'advert rules out sponsorship for this role'
    : j.employerType === 'Agency' && status !== 'offered' ? 'agency advert without sponsorship'
    // Care employers often label ongoing posts "Contract" (an employment contract), so only temporary roles are dropped.
    : /temp/i.test(j.contract || '') ? 'temporary'
    : closed(j) ? 'closed' : '';
  if (reason) { dropped.push(`care, ${reason}: ${j.title} @ ${j.company}`); return false; }
  const m = match(C.nhsRegisterName(j.company)) || (j.nhs && nhsMatch(j.company)) || (j.sponsor && match(j.sponsor.name));
  const sponsor = m && describe(m), licensed = !!sponsor && C.hasSkilledWorkerA(sponsor);
  j.sponsorship = status;
  // Consultancies and agencies are kept on the advert's own sponsorship wording; direct employers need the licence.
  if (!licensed && j.employerType !== 'Agency') { dropped.push(`care, no A-rated Skilled Worker licence: ${j.title} @ ${j.company}`); return false; }
  if (licensed) j.sponsor = sponsor; else delete j.sponsor;
  return true;
}
// Ireland, Germany and the Netherlands: employers that have hired from abroad and can sponsor (Irish permits, IND recognised
// sponsor, or a German advert offering visa support), open to people moving from the UK. Rules in web/sources.js.
function keepIntl(j) {
  const reason = F.sponsorshipSignal(F.plainText(j.description)) === 'not offered' ? 'advert rules out sponsorship'
    : S.abroadReason(j) || (closed(j) ? 'closed' : '');
  if (reason) { dropped.push(`${j.country}, ${reason}: ${j.title} @ ${j.company}`); return false; }
  return true;
}
data.jobs = data.jobs.filter(j => {
  if (j.country && j.country !== 'UK') return keepIntl(j);
  if (j.category === 'care') return keepCare(j);
  const text = F.plainText(j.description);
  const sponsorship = F.sponsorshipSignal(text);
  const agency = (j.employerType || (j.sponsor ? 'Direct' : 'Agency')) === 'Agency';
  const qa = j.category === 'qa';
  const reason = qa && !F.isQaRole(j.title, text) ? 'not a software QA / testing role'
    : !qa && F.isQaTitle(j.title) ? 'QA / testing role (listed under QA)'
    : !qa && !F.isDotnetRole(j.title, text) ? 'not a .NET role'
    : sponsorship === 'not offered' ? 'advert rules out sponsorship'
    // Agency clients are unnamed, so an agency job is only kept when the advert offers sponsorship.
    : agency && sponsorship !== 'offered' ? `agency, sponsorship ${sponsorship}`
    : F.NOT_PERMANENT.test(j.title) || (j.contract && !/permanent/i.test(j.contract)) || CONTRACT_TEXT.test(text) ? 'contract or temporary'
    : closed(j) ? 'closed' : '';
  if (reason) { dropped.push(`${reason}: ${j.title} @ ${j.company}`); return false; }
  // Re-check direct employers with the current matcher, so a tightened rule also cleans older listings.
  if (j.employerType !== 'Agency' && j.sponsor) {
    const m = match(j.company);
    if (!m) { dropped.push(`no sponsor match: ${j.title} @ ${j.company}`); return false; }
    j.sponsor = describe(m);
    if (!qa && !S.skilledWorkerA(j.sponsor)) { dropped.push(`no A-rated Skilled Worker licence: ${j.title} @ ${j.company}`); return false; }
  } else if (!agency && !qa) { dropped.push(`not on the sponsor register: ${j.title} @ ${j.company}`); return false; }
  return true;
});

// Employee ranges from fetch-company-sizes.js. LinkedIn's bands don't split at 250, so Medium is 51–500.
const sizesFile = path.join(__dirname, 'company-sizes.json');
const sizes = fs.existsSync(sizesFile) ? JSON.parse(fs.readFileSync(sizesFile, 'utf8')) : {};
function sizeOf(company) {
  const range = sizes[company]?.employees;
  if (!range) return null;
  const nums = range.replace(/,/g, '').match(/\d+/g).map(Number);
  const upper = range.includes('+') ? Infinity : nums[nums.length - 1];
  return { employees: range, band: upper <= 50 ? 'Small' : upper <= 500 ? 'Medium' : 'Large' };
}

let withSite = 0;
for (const j of data.jobs) {
  const size = sizeOf(j.company);
  if (size) j.companySize = size; else delete j.companySize;
  j.employerType = j.employerType || (j.sponsor ? 'Direct' : 'Agency');
  if (j.category === 'care') { j.level = 'Care'; j.careKind = j.nhs ? C.nhsKind(j.title) : C.careKind(j.title); }
  else {
    j.level = F.levelOf(j.title); j.sponsorship = F.sponsorshipSignal(F.plainText(j.description));
    if (j.category === 'qa') j.qaKind = F.qaKind(j.title, F.plainText(j.description));
  }
  const url = byKey.get(key(j.company)) || (j.sponsor && byKey.get(key(j.sponsor.name)));
  if (url) { j.website = url; withSite++; } else delete j.website;
}
// Sponsorship evidence per employer, kept across runs: every advert seen offering sponsorship, and the latest date.
// Seeded with the care adverts' "last sponsored advert" dates collected before this file existed.
const EVIDENCE_FILE = path.join(__dirname, 'sponsor-evidence.json');
const evidence = fs.existsSync(EVIDENCE_FILE) ? JSON.parse(fs.readFileSync(EVIDENCE_FILE, 'utf8')) : {};
const careEvidence = fs.existsSync(path.join(__dirname, 'care-evidence.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'care-evidence.json'), 'utf8')).companies || {} : {};
for (const c of Object.values(careEvidence)) if (c.lastSponsoredAdvert) {
  const e = evidence[key(c.name)] ||= { ids: [], lastOffered: '' };
  if (c.lastSponsoredAdvert > e.lastOffered) e.lastOffered = c.lastSponsoredAdvert;
}
for (const j of data.jobs) if (j.sponsorship === 'offered') {
  const e = evidence[key(j.sponsor?.name || j.company)] ||= { ids: [], lastOffered: '' };
  if (!e.ids.includes(j.id)) e.ids = [...e.ids, j.id].slice(-50);
  const d = j.posted || today;
  if (d > e.lastOffered) e.lastOffered = d;
}
fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(evidence, null, 1));
data.meta.evidence = Object.fromEntries(Object.entries(evidence).map(([k, e]) => [k, { lastOffered: e.lastOffered, count: Math.max(e.ids.length, 1) }]));
const intl = require('./jobs-file').loadScript(path.join(__dirname, '..', 'web', 'data', 'intl-sponsors.js'), 'INTL_SPONSORS');
if (intl) data.meta.intlSponsors = intl.meta;

F.sortJobs(data.jobs);
fs.writeFileSync(JOBS_FILE, 'window.JOB_DATA=' + JSON.stringify(data, null, 1) + ';\n');

const direct = data.jobs.filter(j => j.employerType === 'Direct').length;
const care = data.jobs.filter(j => j.category === 'care').length, qaCount = data.jobs.filter(j => j.category === 'qa').length;
console.log(`${data.jobs.length} jobs (${data.jobs.length - care - qaCount} .NET, ${care} care & health, ${qaCount} QA; ${direct} direct, ${data.jobs.length - direct} agency); ${withSite} with a company website`);
if (dropped.length) console.log('dropped:\n  ' + dropped.join('\n  '));
const noSite = [...new Set(data.jobs.filter(j => !j.website && j.employerType === 'Direct').map(j => j.company))];
if (noSite.length) console.log('direct employers without a website entry: ' + noSite.join('; '));
