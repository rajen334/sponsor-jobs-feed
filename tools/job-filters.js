// Rules shared by every job fetcher, so all sources apply the same filters.
const RELEVANT = /\.net\b|\bc#|\bc sharp\b|dot ?net|asp\.?net|blazor|\bnet core\b/i;
const EXCLUDE_LEVEL = /\b(junior|jnr|graduate|grad|trainee|apprentice|apprenticeship|intern|internship|placement|entry[- ]level|head of|director|vp)\b/i;
// Contract, temp and fixed-term roles are rarely visa-sponsored, so only permanent roles are kept.
const NOT_PERMANENT = /\bcontract\b|inside ir35|outside ir35|day rate|\btemporary\b|\btemp\b|fixed[- ]term|\bftc\b|maternity cover|\d+[- ]months?\b/i;
const DEV_ROLE = /developer|engineer|programmer|software|full[- ]?stack|back[- ]?end/i;
const SENIOR = /\b(senior|snr|sr\.?|lead|principal|staff|architect|expert|manager|vice president|avp)\b/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB' } });
      if (res.status === 429) { await sleep(8000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (attempt === 2) { console.warn('  failed', url, e.message); return ''; }
      await sleep(2500 * (attempt + 1));
    }
  }
  return '';
}

// Some boards reject Node's HTTP client but accept curl (bundled with Windows 10+, macOS and Linux).
function getTextCurl(url) {
  const { execFile } = require('child_process');
  const attempt = n => new Promise(resolve => execFile('curl', ['-s', '-f', '-L', '--compressed', '-A', UA, '-H', 'Accept-Language: en-GB', url],
    { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, out) => resolve(err ? null : out)));
  return (async () => {
    for (let n = 0; n < 3; n++) { const out = await attempt(n); if (out) return out; await sleep(2500 * (n + 1)); }
    console.warn('  failed', url); return '';
  })();
}

const plainText = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// Keeps only simple formatting tags so descriptions render safely inside the app.
function sanitise(html) {
  return (html || '')
    .replace(/<(script|style|iframe|object)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?([a-z0-9]+)[^>]*>/gi, (t, tag) => {
      tag = tag.toLowerCase();
      if (!['p', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'br', 'h2', 'h3', 'h4'].includes(tag)) return ' ';
      if (tag === 'h2' || tag === 'h3') tag = 'h4';
      return t.startsWith('</') ? `</${tag}>` : tag === 'br' ? '<br>' : `<${tag}>`;
    })
    .replace(/(<br>\s*){3,}/g, '<br><br>').replace(/\s{2,}/g, ' ').trim();
}

// Pulls an annual GBP range out of free text: "£55,000 - £65,000", "£60k-£75k", "up to £70k".
function parseSalary(text) {
  const n = s => { const v = parseFloat(s.replace(/,/g, '')); return /k/i.test(s) || v < 1000 ? v * 1000 : v; };
  const range = text.match(/£\s?(\d{2,3}(?:,\d{3})?k?)\s*(?:-|–|to)\s*£?\s?(\d{2,3}(?:,\d{3})?k?)/i);
  if (range) { const lo = n(range[1]), hi = n(range[2]); if (lo >= 15000 && hi <= 400000) return { lo, hi, text: range[0].trim() }; }
  const single = text.match(/(?:up to|circa|c\.|around|salary[^£]{0,20})\s*£\s?(\d{2,3}(?:,\d{3})?k?)/i);
  if (single) { const v = n(single[1]); if (v >= 15000 && v <= 400000) return { lo: v, hi: v, text: single[0].trim() }; }
  return null;
}

// What the advert itself says about visa sponsorship: 'offered', 'not offered' or 'not mentioned'.
// The wording rules (UK, plus Irish, German and Dutch phrases) are shared with the app's internet sync: web/sources.js.
const { NO_SPONSOR, YES_SPONSOR } = require('../web/sources');
function sponsorshipSignal(text) {
  if (NO_SPONSOR.test(text)) return 'not offered';
  if (YES_SPONSOR.test(text)) return 'offered';
  return 'not mentioned';
}

// A title naming .NET/C# is enough; a generic title ("Software Engineer") needs the description to
// mention the stack more than once, and a title naming another main language is not a .NET role.
const OTHER_STACK = /\b(python|java(?!script)|c\+\+|golang|go developer|rust|php|ruby|scala|kotlin|swift|node\.?js|salesforce|sap|dynamics 365|d365|power platform)(?![\w+])/i;
function isDotnetRole(title, text) {
  if (RELEVANT.test(title)) return true;
  if (OTHER_STACK.test(title)) return false;
  return (text.match(new RegExp(RELEVANT.source, 'gi')) || []).length >= 2;
}

// QA and software testing roles: QA engineer / analyst / tester, test engineer / analyst / lead, SDET, test automation.
const QA_ROLE = /\b(?:qa|q\.a\.|quality\s+assurance|tester|testing|test\s+(?:engineer|analyst|lead|manager|automation|architect|specialist|consultant|developer)|sdet|(?:test|qa|quality)\s+automation|automation\s+(?:tester|test)|software\s+development\s+engineer\s+in\s+test)\b/i;
// Hardware, lab, manufacturing, care-quality and compliance "testing" titles are not software QA.
const NOT_SOFTWARE_QA = /\b(?:electrical|electronics?|hardware|mechanical|pat|gas|water|ndt|commissioning|calibration|laborator(?:y|ies)|lab|food|chemist|chemical|pharmac\w*|clinical|medical|manufacturing|production|welding|inspector|inspection|technician|asbestos|fire|emissions|vehicle|automotive|aerospace|hvac|plumb\w*|cable|fibre|rf|battery|semiconductor|supplier|construction|civil|soil|materials|qc|regulatory|auditor|audit|haccp|operative|driving|care|nursing|housing|infrastructure|network|penetration|pen|security|cyber|drug|trials?)\b/i;
// Testing-specific terms only (not general ones like "agile" or "C#"), so DevOps or support roles with "automation" in the title don't qualify.
const SOFTWARE_TESTING = /selenium|playwright|cypress|appium|postman|rest ?assured|api testing|test automation|automated tests?|automation framework|regression test|software testing|test cases|test plans?|test scripts|test strategy|specflow|cucumber|gherkin|\bbdd\b|jmeter|\bk6\b|load testing|performance testing|sdet|manual testing|\buat\b|istqb|exploratory testing|testng|junit|nunit|xunit|defects?\b|bug tracking|quality assurance/gi;
const isQaTitle = title => QA_ROLE.test(title) && !NOT_SOFTWARE_QA.test(title);
// The title must name a QA or testing role, and the advert must read like software testing (two or more testing terms).
function isQaRole(title, text) {
  return isQaTitle(title) && (String(text || '').match(SOFTWARE_TESTING) || []).length >= 2;
}
const AUTOMATION = /selenium|playwright|cypress|appium|test automation|automated tests?|automation framework|sdet/gi;
function qaKind(title, text) {
  if (/automation|sdet|in test/i.test(title)) return 'Automation';
  if (/performance|load/i.test(title)) return 'Performance';
  return (String(text || '').match(AUTOMATION) || []).length >= 2 ? 'Automation' : 'Manual / functional';
}

// Shortens a long description at a paragraph or list-item boundary, closing any open tags.
function trimHtml(html, max) {
  if (!html || html.length <= max) return html;
  const p = html.lastIndexOf('</p>', max), li = html.lastIndexOf('</li>', max);
  const end = Math.max(p + 4, li + 5);
  let out = html.slice(0, end > max / 2 ? end : max).replace(/<[^>]*$/, '');
  for (const tag of ['strong', 'b', 'em', 'i', 'li', 'ul', 'ol', 'p', 'h4']) {
    const open = (out.match(new RegExp(`<${tag}>`, 'g')) || []).length, close = (out.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    out += `</${tag}>`.repeat(Math.max(0, open - close));
  }
  return out + '<p><i>Shortened here. The full description is on the original advert.</i></p>';
}

const inBand = (lo, hi, min, max) => hi >= min && lo <= max;
// Lead (lead, principal, staff, architect, manager) is checked before Senior, so "Senior QA Lead" is Lead.
const LEAD = /\b(lead|principal|staff|architect|manager)\b/i;
const levelOf = title => (LEAD.test(title) ? 'Lead' : SENIOR.test(title) ? 'Senior' : 'Mid');
const LEVEL_ORDER = { Mid: 0, Senior: 1, Lead: 2 };
const sortJobs = jobs => jobs.sort((a, b) => ((LEVEL_ORDER[a.level] ?? 3) - (LEVEL_ORDER[b.level] ?? 3)) || b.posted.localeCompare(a.posted));

// Per-category settings shared by the Reed, LinkedIn and CV-Library fetchers (--cat dotnet | qa).
const PROFILES = {
  dotnet: { label: '.NET / C#', titleOk: t => (RELEVANT.test(t) || DEV_ROLE.test(t)) && !isQaTitle(t), agencyTitleOk: t => RELEVANT.test(t) && !isQaTitle(t), isRole: isDotnetRole },
  qa: { label: 'QA / testing', titleOk: isQaTitle, agencyTitleOk: isQaTitle, isRole: isQaRole },
};

module.exports = { RELEVANT, EXCLUDE_LEVEL, NOT_PERMANENT, DEV_ROLE, SENIOR, UA, sleep, getText, getTextCurl, plainText, sanitise, trimHtml, parseSalary, sponsorshipSignal,
  isDotnetRole, isQaTitle, isQaRole, qaKind, inBand, levelOf, sortJobs, PROFILES };
