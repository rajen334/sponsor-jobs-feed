// Job sources and sponsorship rules shared by the PC (tools/fetch-intl.js, Node) and the app's internet sync (phone or browser,
// no PC, server or key): LinkedIn's public job search in the UK, Ireland, Germany and the Netherlands, sponsor matching per
// country, what an advert says about sponsorship, and the sponsorship likelihood shown on every job.
(function (root) {
  const SM = typeof module !== 'undefined' && module.exports ? require('../tools/sponsor-match') : root.SponsorMatch;

  const COUNTRIES = {
    UK: { name: 'United Kingdom', short: 'UK', currency: '£' },
    IE: { name: 'Ireland', short: 'Ireland', currency: '€' },
    DE: { name: 'Germany', short: 'Germany', currency: '€' },
    NL: { name: 'Netherlands', short: 'Netherlands', currency: '€' },
  };

  // LinkedIn searches per category and country. Germany and the Netherlands add searches for adverts that mention visas
  // or relocation, since employers there needn't hold a licence. Care searches use the local job titles.
  const TECH_VISA = { dotnet: ['.NET visa sponsorship', 'C# relocation'], qa: ['QA engineer visa sponsorship', 'test automation relocation'] };
  const QUERIES = {
    dotnet: { all: ['.NET Developer', 'C# Developer', 'Senior .NET Developer', '.NET Engineer'] },
    qa: { all: ['QA Engineer', 'Test Automation Engineer', 'Software Tester', 'SDET'] },
    care: { UK: ['Care Assistant', 'Healthcare Assistant', 'Support Worker', 'Care Worker'], IE: ['Healthcare Assistant', 'Care Assistant', 'Home Care Assistant'],
      DE: ['Pflegehelfer', 'Pflegeassistent', 'Care Assistant'], NL: ['Zorgmedewerker', 'Helpende zorg', 'Care Assistant'] },
  };
  const queries = (cat, country) => [...(QUERIES[cat][country] || QUERIES[cat].all), ...(country === 'DE' || country === 'NL' ? TECH_VISA[cat] || [] : [])];

  /* ---- Role checks ---- */
  const DOTNET = /\.net\b|\bc#|dotnet|asp\.net|blazor/i, OTHER_STACK = /\b(python|java(?!script)|c\+\+|golang|rust|php|ruby|scala|kotlin|swift|salesforce|sap|dynamics 365|d365)(?![\w+])/i;
  const QA = /\b(qa|tester|testing|test (?:engineer|analyst|lead|manager|automation)|sdet|quality assurance|automation engineer|testautomatisierung|softwaretester)\b/i;
  const NOT_SOFTWARE_QA = /\b(electrical|mechanical|food|chemical|laborator|clinical|medical device|manufacturing|construction|civil|hvac|water|qc|auditor|pharma|lab)\b/i;
  const CARE = /\b(care (?:assistant|worker|giver)|carer|healthcare assistant|health care assistant|support worker|home care|hca|pflegehelfer\w*|pflegeassist\w*|altenpflegehelfer\w*|betreuungskraft|zorgmedewerker|helpende|verzorgende|thuiszorg)\b/i;
  // Nursing roles are left out of care (nurses, nursing associates, and their German and Dutch titles).
  const NURSING = /\b(nurses?|nursing associate|rgn|rmn|pflegefachkraft|pflegefachfrau|pflegefachmann|krankenschwester|gesundheits- und krankenpfleger\w*|verpleegkundige)\b/i;
  const NOT_LEVEL = /\b(junior|jnr|graduate|trainee|apprentice\w*|intern|internship|werkstudent\w*|praktik\w*|stagiair|stage|azubi|ausbildung|head of|director|vp)\b/i;
  const NOT_PERMANENT = /\b(contract|freelance\w*|temporary|temp|fixed[- ]term|ftc|befristet\w*|interim|zzp|day rate)\b/i;
  const SENIOR_CARE = /\b(senior|manager|lead|leader|coordinator|deputy|teamleit\w*|leitung)\b/i;
  function roleOk(cat, title, text) {
    if (NOT_PERMANENT.test(title)) return false;
    if (cat === 'care') return CARE.test(title) && !NURSING.test(title) && !SENIOR_CARE.test(title) && !/\b(intern|praktik\w*|ausbildung|stage)\b/i.test(title);
    if (NOT_LEVEL.test(title)) return false;
    if (cat === 'qa') return QA.test(title) && !NOT_SOFTWARE_QA.test(title);
    if (DOTNET.test(title)) return true;
    if (OTHER_STACK.test(title) || !/\b(developer|engineer|programmer|entwickler|ontwikkelaar)\b/i.test(title)) return false;
    return text == null || (text.match(/\.net\b|\bc#/gi) || []).length >= 2;     // a generic title needs the stack in the advert
  }
  const levelOf = t => /\b(lead|principal|staff|head|architect)\b/i.test(t) ? 'Lead' : /\b(senior|sr\.?|snr)\b/i.test(t) ? 'Senior' : 'Mid';

  /* ---- What the advert says about sponsorship (UK and EU wording) ---- */
  const NO_SPONSOR = new RegExp([
    /\b(?:no|not|unable to|cannot|can't|won't|will not|do not|does not|don't|are not able to|is not able to)\s+(?:able to\s+)?(?:offer|provide|support|consider|accept)?\s*(?:any\s+)?(?:visa\s+|work\s+)?sponsor(?:ship|ing)?\b/.source,
    /sponsorship\s+(?:is\s+)?(?:not|unavailable|isn't)\b|without\s+(?:the\s+need\s+for\s+)?(?:current\s+or\s+future\s+)?(?:visa\s+)?sponsorship|not\s+(?:require|need)\s+(?:visa\s+)?sponsorship|no\s+visa\s+sponsorship/.source,
    // Plain "must have the right to work" is boilerplate even at sponsors; "already", "full" or "unrestricted" rule sponsorship out.
    /(?:must|need to|should)\s+already\s+(?:have|hold|possess)\s+(?:a\s+|the\s+)?(?:valid\s+)?(?:right to work|work permit|work authori[sz]ation)|(?:full|unrestricted|existing)\s+(?:uk\s+|eu\s+)?right to work|must\s+(?:have|hold)\s+(?:a\s+|an\s+)?(?:valid\s+)?eu\s+work\s+permit/.source,
    /(?:eu|eea)\s+(?:citizenship|passport|work permit)\s+(?:is\s+)?(?:required|essential|mandatory)|unable to\s+(?:offer|provide)\s+(?:a\s+)?(?:visa|work permit)|without (?:the need for )?(?:a )?work permit/.source,
    /\bkeine?\s+(?:visum|visa|arbeitserlaubnis|visa-?sponsoring|sponsoring)|arbeitserlaubnis\s+(?:für\s+(?:deutschland|die eu)\s+)?(?:ist\s+)?(?:zwingend\s+)?(?:erforderlich|vorausgesetzt)/.source,
    /\bgeen\s+(?:visum|sponsoring|werkvergunning)|werkvergunning\s+(?:is\s+)?(?:vereist|verplicht)|stamp\s+4\s+(?:visa\s+)?(?:is\s+)?(?:required|essential)/.source,
  ].join('|'), 'i');
  const YES_SPONSOR = new RegExp([
    /visa\s+sponsorship\s+(?:is\s+|can\s+be\s+|will\s+be\s+)?(?:available|offered|provided|considered|possible)|(?:can|will|able\s+to|happy\s+to|open\s+to)\s+(?:offer|provide|support|consider)\s+(?:visa\s+|skilled\s+worker\s+)?sponsorship/.source,
    /sponsorship\s+(?:is\s+)?(?:available|offered|provided)|skilled\s+worker\s+(?:visa\s+)?sponsorship|we\s+(?:do\s+)?sponsor\s+visas|sponsorship\s+for\s+the\s+right\s+candidate|(?:can|will|are\s+able\s+to|able\s+to|happy\s+to)\s+sponsor\b/.source,
    /tier\s?2\s+(?:visa\s+)?sponsorship|sponsorship\s+(?:can|could)\s+be\s+(?:offered|provided|considered|arranged)|(?:offer|offering|provide|providing|including)\s+(?:visa\s+|skilled\s+worker\s+)?sponsorship|sponsorship\s+(?:is\s+)?on\s+offer/.source,
    /visa\s+(?:support|assistance)|relocation\s+(?:package|support|assistance|bonus|budget|allowance)|(?:eu\s+)?blue\s+card|blaue\s+karte|visa-?unterst(?:ü|ue)tzung|umzugs?(?:unterst(?:ü|ue)tzung|hilfe|pauschale)/.source,
    /kennismigrant|highly\s+skilled\s+migrant|30%[- ](?:ruling|regeling)|critical\s+skills\s+(?:employment\s+)?permit|(?:employment|work)\s+permits?\s+(?:will\s+be|can\s+be|is|are)\s+(?:provided|arranged|supported|sponsored)|work\s+permit\s+(?:support|sponsorship)/.source,
  ].join('|'), 'i');
  const sponsorshipSignal = text => NO_SPONSOR.test(text) ? 'not offered' : YES_SPONSOR.test(text) ? 'offered' : 'not mentioned';

  /* ---- Text helpers ---- */
  const plainText = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  // Keeps only simple formatting tags, so descriptions from job boards render safely in the app.
  function sanitise(html) {
    return (html || '').replace(/<(script|style|iframe|object)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/?([a-z0-9]+)[^>]*>/gi, (t, tag) => {
        tag = tag.toLowerCase();
        if (!['p', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'br', 'h2', 'h3', 'h4'].includes(tag)) return ' ';
        if (tag === 'h2' || tag === 'h3') tag = 'h4';
        return t.startsWith('</') ? `</${tag}>` : tag === 'br' ? '<br>' : `<${tag}>`;
      }).replace(/(<br>\s*){3,}/g, '<br><br>').replace(/\s{2,}/g, ' ').trim();
  }
  // Annual pay in £ or €: "£55,000 - £65,000", "€60k–€75k", "55.000 € - 70.000 €".
  function parseSalary(text) {
    const num = s => { const v = parseFloat(s.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.')); return /k/i.test(s) || v < 1000 ? v * 1000 : v; };
    const N = '(\\d{2,3}(?:[.,]\\d{3})?\\s?k?)';
    const pats = [new RegExp(`([£€])\\s?${N}\\s*(?:-|–|to|bis)\\s*[£€]?\\s?${N}`, 'i'), new RegExp(`${N}\\s?([£€])\\s*(?:-|–|to|bis)\\s*${N}\\s?[£€]`, 'i'),
      new RegExp(`(?:up to|circa|c\\.|around|salary[^£€]{0,20}|bis zu)\\s*([£€])\\s?${N}`, 'i')];
    for (const [i, re] of pats.entries()) {
      const m = text.match(re); if (!m) continue;
      const cur = i === 1 ? m[2] : m[1], lo = num(i === 1 ? m[1] : m[2]), hi = i === 2 ? lo : num(m[3]);
      if (lo >= 15000 && hi <= 400000 && hi >= lo) return { lo, hi, currency: cur, text: m[0].trim() };
    }
    return null;
  }

  /* ---- Sponsors per country ---- */
  const LEGAL_INTL = /\b(?:b\.?\s?v\.?|n\.?\s?v\.?|v\.?o\.?f\.?|gmbh(?:\s*&\s*co\.?\s*kg)?|ag|se|kg|dac|uc|unlimited(?: company)?|designated activity company|teoranta|limited|ltd|plc|holdings?|ireland|nederland|netherlands|deutschland|germany|europe|emea)\b\.?/gi;
  const intlName = n => (n || '').replace(LEGAL_INTL, ' ').replace(/\s+/g, ' ').trim();
  // UK: the Home Office register (web/data/sponsors.js); a direct employer needs an A-rated Skilled Worker licence.
  function ukSponsors(data) {
    const match = SM.buildIndex(data.sponsors.map(s => s[0]));
    return name => {
      const m = match(name); if (!m) return null;
      const s = data.sponsors[m.index];
      return { name: s[0], town: s[1], county: s[2], licences: s[3].map(([t, r]) => data.types[t] + ' — ' + data.routes[r]), match: m.quality };
    };
  }
  const skilledWorkerA = sp => (sp?.licences || []).some(l => /^Worker \(A/.test(l) && /Skilled Worker/.test(l));
  // Ireland (DETE permits issued to companies) and the Netherlands (IND recognised sponsors), from web/data/intl-sponsors.js.
  function intlSponsors(data) {
    const nl = SM.buildIndex(data.nl.map(intlName)), ie = SM.buildIndex(data.ie.map(r => intlName(r[0])));
    return {
      NL: name => { const m = nl(intlName(name)); return m && { name: data.nl[m.index], register: 'IND recognised sponsor', match: m.quality }; },
      IE: name => { const m = ie(intlName(name)); if (!m) return null; const [n, cur, prev, last] = data.ie[m.index];
        return { name: n, register: 'DETE employment permits', permits: { thisYear: cur, lastYear: prev, last, years: data.meta.ie.years.map(y => y.year) }, match: m.quality }; },
    };
  }

  /* ---- Sponsorship likelihood ----
     No country publishes when each employer last sponsored someone, except Ireland (permits issued per company per month).
     So the score combines the evidence that is public: the advert's own wording, the employer's licence or register entry,
     Irish permit counts and dates, the last time this employer advertised sponsorship (collected by this app since
     30 Oct 2026), employer size, and whether the salary meets the UK Skilled Worker threshold. */
  const UK_THRESHOLD = 41700;                     // general Skilled Worker salary threshold since 22 July 2025
  const fmtMonth = ym => ym ? new Date(ym + '-15').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '';
  function likelihood(j, evidence) {
    const r = [], add = (pts, text) => { score += pts; if (text) r.push({ pts, text }); };
    let score = 0;
    const country = j.country || 'UK', ev = evidence && evidence[SM.key(j.sponsor?.name || j.company)];
    if (j.sponsorship === 'offered') add(3, 'The advert offers visa sponsorship or visa support');
    else if (j.sponsorship === 'nhs statement') add(1, 'NHS Jobs standard sponsorship paragraph only');
    if (ev?.lastOffered && !(j.sponsorship === 'offered' && ev.count <= 1)) add(ev.count >= 3 ? 2 : 1, `Advertised sponsorship ${ev.count > 1 ? `${ev.count} times, last` : ''} on ${new Date(ev.lastOffered + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`.replace('  ', ' '));
    if (country === 'UK') {
      if (skilledWorkerA(j.sponsor)) add(1, 'A-rated Skilled Worker sponsor licence');
      if ((j.sponsor?.licences || []).some(l => /Premium|SME\+/.test(l))) add(1, 'Premium or SME+ sponsor rating');
      if ((j.sponsor?.licences || []).some(l => /Global Business Mobility/.test(l))) add(1, 'Also licensed for intra-company transfers (large international employer)');
      if (j.nhs) add(1, 'NHS employers sponsor regularly');
      if (j.category === 'care' && j.sponsorship !== 'offered') add(0, 'Care worker visas: since July 2025 only people already in the UK can switch to a new sponsor');
      const pay = j.salaryTo || j.salaryFrom;
      if (j.category !== 'care' && pay) pay >= UK_THRESHOLD ? add(1, `Salary meets the £${UK_THRESHOLD.toLocaleString('en-GB')} Skilled Worker threshold`)
        : add(-2, `Salary is below the £${UK_THRESHOLD.toLocaleString('en-GB')} Skilled Worker threshold (lower rates apply only to new entrants and some other cases)`);
    } else if (country === 'IE' && j.sponsor?.permits) {
      const p = j.sponsor.permits, [y] = p.years;
      if (p.thisYear >= 10) add(3, `${p.thisYear} employment permits issued to this employer in ${y}, the last in ${fmtMonth(p.last)}`);
      else if (p.thisYear > 0) add(2, `${p.thisYear} employment permit${p.thisYear > 1 ? 's' : ''} issued to this employer in ${y}, the last in ${fmtMonth(p.last)}`);
      else if (p.lastYear > 0) add(1, `${p.lastYear} employment permit${p.lastYear > 1 ? 's' : ''} issued to this employer in ${y - 1}, none so far in ${y}`);
    } else if (country === 'NL' && j.sponsor) add(2, 'Recognised sponsor with the IND (can bring in highly skilled migrants)');
    else if (country === 'DE' && j.sponsorship !== 'offered') add(0, 'Germany has no sponsor register: any employer can hire through the EU Blue Card. Ask about visa support.');
    if (j.companySize?.band === 'Large') add(1, 'Large employer');
    if (j.employerType === 'Agency') add(-1, 'Recruitment agency: the employer isn\'t named');
    const level = score >= 5 ? 'High' : score >= 3 ? 'Good' : score >= 1 ? 'Possible' : 'Low';
    return { level, score, reasons: r.filter(x => x.text).map(x => x.text) };
  }

  /* ---- LinkedIn public job search ---- */
  const pick = (html, re) => plainText((html.match(re) || [])[1]);
  const searchUrl = (kw, country, start) => `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(COUNTRIES[country].name)}&f_TPR=r2592000&start=${start}`;
  const detailUrl = id => 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/' + id;
  function parseSearch(html) {
    return html.split('<li>').slice(1).map(c => ({ id: (c.match(/urn:li:jobPosting:(\d+)/) || [])[1], title: pick(c, /base-search-card__title[^>]*>([\s\S]*?)<\/h3>/),
      company: pick(c, /base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/), location: pick(c, /job-search-card__location[^>]*>([\s\S]*?)<\/span>/),
      posted: ((c.match(/datetime="([^"]+)"/) || [])[1] || '').slice(0, 10) })).filter(c => c.id && c.title);
  }
  // The job as stored in web/data/jobs.js, or null when the advert is closed, not the role, temporary or rules sponsorship out.
  function parseJob(card, html, country, cat) {
    if (!html || /closed-job|No longer accepting applications/i.test(html)) return null;
    const descHtml = (html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '', plain = plainText(descHtml);
    if (!roleOk(cat, card.title, plain)) return null;
    const crit = Object.fromEntries([...html.matchAll(/description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g)].map(x => [plainText(x[1]), plainText(x[2])]));
    if (/contract|temporary|internship|volunteer/i.test(crit['Employment type'] || '')) return null;
    const sponsorship = sponsorshipSignal(plain);
    if (sponsorship === 'not offered') return null;
    const sal = parseSalary(pick(html, /salary compensation__salary[^>]*>([\s\S]*?)<\/div>/) + ' ' + card.title + ' ' + plain);
    const applyUrl = ((html.match(/<code id="applyUrl"[^>]*><!--"([^"]+)"/) || [])[1] || '').replace(/&amp;/g, '&');
    const loc = card.location.replace(new RegExp(',\\s*(?:' + Object.values(COUNTRIES).map(c => c.name).join('|') + ')$'), '');
    return {
      id: 'li-' + card.id, title: card.title, company: card.company, country, category: cat,
      level: cat === 'care' ? 'Care' : levelOf(card.title), location: loc, region: '', postcode: '',
      workingOption: /remote/i.test(card.title + ' ' + loc) ? 'remote' : /hybrid/i.test(card.title + ' ' + plain.slice(0, 600)) ? 'hybrid' : '',
      contract: 'Permanent', fullTime: !/part-time/i.test(crit['Employment type'] || ''),
      salaryFrom: sal ? sal.lo : null, salaryTo: sal ? sal.hi : null, currency: sal ? sal.currency : COUNTRIES[country].currency,
      salaryText: sal ? sal.text : 'Salary not disclosed', posted: card.posted, expires: '', skills: [],
      description: sanitise(descHtml), sponsorship, source: country === 'UK' ? 'LinkedIn' : `LinkedIn ${COUNTRIES[country].short}`,
      sourceUrl: 'https://www.linkedin.com/jobs/view/' + card.id, applyUrl: applyUrl.startsWith('http') ? applyUrl : '',
      seniorityLabel: crit['Seniority level'] || '',
    };
  }
  // Who the employer is, by country; null drops the job. Agencies are kept only when the advert offers sponsorship.
  function sponsorFor(job, country, registers) {
    const agency = SM.isAgency(job.company);
    if (agency) return job.sponsorship === 'offered' ? { employerType: 'Agency', sponsor: null } : null;
    const sp = country === 'UK' ? registers.UK && registers.UK(job.company) : registers[country] ? registers[country](job.company) : null;
    if (country === 'UK') return skilledWorkerA(sp) ? { employerType: 'Direct', sponsor: sp } : null;
    // Ireland and the Netherlands: a register entry or an advert that offers sponsorship. Germany: the advert must offer it.
    if (sp || job.sponsorship === 'offered') return { employerType: 'Direct', sponsor: sp || null };
    return null;
  }

  // Runs the searches and reads each candidate advert. http(url) -> Promise<string>; onProgress({ step, done, total, found }).
  async function collect({ countries, cats, http, registers, pages = 2, maxDetails = 30, delay = 700, onProgress = () => {}, stop = () => false }) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const plan = cats.flatMap(cat => countries.flatMap(country => queries(cat, country).map(kw => ({ cat, country, kw }))));
    const jobs = [], seen = new Set();
    let done = 0;
    for (const group of cats.flatMap(cat => countries.map(country => ({ cat, country })))) {
      const cards = new Map();
      for (const q of plan.filter(p => p.cat === group.cat && p.country === group.country)) {
        for (let p = 0; p < pages && !stop(); p++) {
          let html = '';
          try { html = await http(searchUrl(q.kw, q.country, p * 10)); } catch (e) { onProgress({ step: `${COUNTRIES[q.country].short} ${q.kw}: ${e.message}`, done, total: plan.length, found: jobs.length }); }
          await sleep(delay);
          const found = parseSearch(html);
          for (const c of found) if (!seen.has(c.id) && roleOk(group.cat, c.title)) { seen.add(c.id); cards.set(c.id, c); }
          if (found.length < 10) break;
        }
        done++;
        onProgress({ step: `${COUNTRIES[q.country].short} · ${q.kw}`, done, total: plan.length, found: jobs.length });
      }
      // Read adverts from likely sponsors first: UK licensed employers, Irish and Dutch register entries, then the rest.
      const ranked = [...cards.values()].map(c => ({ c, known: !SM.isAgency(c.company) && !!(registers[group.country] && registers[group.country](c.company)) }))
        .filter(x => group.country !== 'UK' || x.known || SM.isAgency(x.c.company)).sort((a, b) => b.known - a.known).slice(0, maxDetails);
      for (const { c } of ranked) {
        if (stop()) break;
        let html = '';
        try { html = await http(detailUrl(c.id)); } catch { /* skipped */ }
        await sleep(delay);
        const job = parseJob(c, html, group.country, group.cat);
        const who = job && sponsorFor(job, group.country, registers);
        if (who) { jobs.push({ ...job, ...who }); onProgress({ step: `${COUNTRIES[group.country].short} · ${job.title} at ${job.company}`, done, total: plan.length, found: jobs.length }); }
      }
    }
    return jobs;
  }

  const api = { COUNTRIES, QUERIES, queries, roleOk, levelOf, NO_SPONSOR, YES_SPONSOR, sponsorshipSignal, plainText, sanitise, parseSalary,
    ukSponsors, intlSponsors, skilledWorkerA, likelihood, UK_THRESHOLD, searchUrl, detailUrl, parseSearch, parseJob, sponsorFor, collect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobSources = api;
})(typeof window !== 'undefined' ? window : globalThis);
