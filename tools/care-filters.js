// Rules for the care & health category, shared by fetch-care.js, fetch-nhs.js and finalize-jobs.js.
// A healthcare job is kept when ALL of these hold:
//  - the title is a frontline role: care worker, home carer, care assistant, support worker or HCA,
//  - it isn't a nursing role (nurses and nursing associates are left out on purpose; nursing assistants and nursing support
//    workers are HCA-level roles and stay), or a senior, lead, management, specialist or other non-frontline role,
//  - a direct employer is on the sponsor register with an A-rated Skilled Worker licence (agencies need an advert that offers sponsorship),
//  - the company isn't listed in care-exclude.json.
// Every advert from a licensed employer is listed, and tagged with what it says about sponsorship
// ('offered', 'not mentioned', 'not offered', 'professional only' or 'nhs statement').
const fs = require('fs');
const path = require('path');
const { key } = require('./sponsor-match');
const F = require('./job-filters');

const NURSE = /\b(?:nurses?|rgn|rmn|rnld)\b/i;
const CARE_ROLE = /\b(?:care\s+(?:worker|assistant|giver|associate|practitioner|support\s+worker)|carers?\b|home\s*care|homecare|domiciliary|support\s+worker|health\s*care\s+assistant|healthcare\s+support\s+worker|\bhca\b|live[- ]in\s+carer|reablement|community\s+care|nurses?\b|rgn\b|rmn\b|rnld\b)/i;
// Senior care jobs are excluded on purpose, along with supervisory, specialist nursing, office and non-sponsorable (bank/relief) roles.
const NOT_FRONTLINE = /\b(?:senior|snr|sr\.?|team\s+leader|leader|lead|supervisor|manager|management|co-?ordinator|deputy|head|director|charge\s+nurse|sister|matron|specialist|advanced|consultant|educator|clinical\s+lead|nurse\s+practitioner|assessor|trainer|scheduler|administrator|admin|recruit(?:er|ment)|apprentice|student|trainee|volunteer|bank|relief|ad[- ]hoc)\b/i;

// Sponsorship is limited to RQF 6 / nurses / registered professionals: the company isn't sponsoring care workers.
const PROFESSIONAL_ONLY = /sponsor\w*[^.]{0,80}?\bonly\b[^.]{0,60}?\b(?:rqf|level\s*6|registered|nurses?|nmc|graduate)|\bonly\b[^.]{0,40}?sponsor\w*[^.]{0,60}?\b(?:rqf|level\s*6|registered|nurses?|nmc)|(?:rqf|level)\s*6[^.]{0,40}?\bonly\b|not\s+(?:able\s+to\s+)?sponsor\w*\s+(?:for\s+)?(?:care|support)\s+(?:workers?|assistants?|roles?)|(?:care|support)\s+(?:worker|assistant)\s+roles?\s+(?:are\s+)?not\s+(?:eligible\s+for\s+)?sponsor/i;
// e.g. "unable to sponsor", "unable to offer sponsorship or a switch of sponsorship", "No Skilled Worker visa sponsorship
// is available", "not currently offering Skilled Worker visa sponsorship", "unable to accept applications from individuals requiring…"
const CARE_NO = /\b(?:unable|not\s+able|cannot|can'?t|won'?t|will\s+not|do\s+not|does\s+not|don'?t|are\s+not|is\s+not)\s+(?:currently\s+)?(?:to\s+)?(?:(?:offer|provide|support|accept|consider|issue|take\s+over|apply\s+for)\w*\s+(?:[\w-]+\s+){0,4}?)?sponsor|\bno\s+(?!cost|fee|charge)(?:[\w-]+\s+){0,3}?sponsorship|sponsorship\s+(?:is\s+)?(?:not|unavailable)|not\s+(?:currently\s+)?(?:offering|providing|accepting)\s+(?:[\w-]+\s+){0,3}?sponsorship|unable\s+to\s+accept\s+applications?\s+from\s+(?:individuals|candidates|applicants|anyone|those|people)\s+(?:who\s+)?(?:requir|need)|(?:unrestricted|full)\s+right\s+to\s+work|without\s+(?:the\s+need\s+for\s+)?(?:visa\s+)?sponsorship|not\s+(?:require|need)\s+(?:visa\s+)?sponsorship|do\s+not\s+(?:hold|have)\s+a\s+sponsor|not\s+(?:be\s+)?open\s+to\s+(?:visa\s+)?sponsorship|(?:does\s+not|doesn't)\s+meet\s+the\s+home\s+office\s+criteria|surrender\w*\s+(?:the\s+|our\s+)?[\w\s]{0,20}?sponsor\w*\s+licen[cs]e|unable\s+to\s+accept\s+(?:applicants\s+)?(?:with|on)\s+skilled\s+worker|not\s+eligible\s+for\s+(?:[\w-]+\s+){0,4}?sponsorship|(?:does\s+not|doesn't)\s+meet\s+the\s+(?:eligibility\s+)?criteria\s+for\s+(?:a\s+)?(?:skilled\s+worker|health\s+(?:and|&)\s+care)|(?:unable|not\s+able|cannot|can't)\s+to\s+(?:provide|offer|issue|give|assign)\s+[^.]{0,60}?(?:certificates?\s+of\s+sponsorship|\bcos\b)|\bcos\s+cannot\s+be\s+(?:provided|offered|issued)/i;
const CARE_YES = /certificates?\s+of\s+sponsorship|\bcos\s+(?:is\s+|are\s+|can\s+be\s+)?(?:available|provided|offered|transfer)|sponsorship\s+(?:transfer|switch)|(?:transfer|switch)\w*\s+(?:of\s+)?(?:your\s+)?(?:visa|sponsorship|cos)\b|(?:we|happy\s+to|able\s+to|can|will)\s+sponsor\b|sponsorship\s+(?:for|to)\s+(?:care|support)\s+workers|skilled\s+worker\s+(?:visa\s+)?(?:sponsorship|available|offered)|sponsored\s+(?:roles?|positions?|care\s+workers?)|candidates?\s+(?:requiring|who\s+require|needing|who\s+need)\s+(?:visa\s+)?sponsorship\s+(?:must|should|will\s+need)/i;

// 'offered', 'not offered', 'professional only' or 'not mentioned' for a care advert.
// Scam warnings ("anyone requesting money for a Certificate of Sponsorship…") mention CoS without offering one.
const SCAM_WARNING = /scam|fraud|request\w*\s+(?:money|payment)|money\s+for|pay(?:ment)?\s+for|charge\s+(?:a\s+)?fee/i;
function careSponsorship(raw) {
  const text = (raw || '').replace(/[‘’]/g, "'");
  if (PROFESSIONAL_ONLY.test(text)) return 'professional only';
  if (CARE_NO.test(text)) return 'not offered';
  const offers = text.split(/(?<=[.!?·•])\s+/).filter(s => !SCAM_WARNING.test(s)).join(' ');
  if (CARE_YES.test(offers) || F.sponsorshipSignal(offers) === 'offered') return 'offered';
  return F.sponsorshipSignal(text) === 'not offered' ? 'not offered' : 'not mentioned';
}

// Only people already in the UK can now be sponsored as care workers (new overseas recruitment closed 22 July 2025).
const IN_UK_ONLY = /(?:months?|time)\s+(?:left\s+|remaining\s+)?on\s+(?:their|your)\s+(?:current\s+)?visa|(?:already|currently)\s+(?:in|living\s+in|based\s+in|residing\s+in)\s+the\s+uk|in[- ]country|switch\w*\s+(?:your\s+)?(?:visa|sponsor)|transfer\w*\s+(?:your\s+)?(?:visa|sponsorship|cos)|change\s+(?:of\s+)?sponsor/i;

// Registered nursing roles: nurses, RGN / RMN / RNLD and nursing associates (also NMC-registered). Not "nursing home",
// "nursing assistant" or "nursing support worker", which are care roles.
const NURSING_ROLE = /\b(?:nurses?|rgn|rmn|rnld)\b|\bnurs(?:e|ing)\s+associates?\b/i;
const isCareRole = title => CARE_ROLE.test(title) && !NOT_FRONTLINE.test(title) && !NURSING_ROLE.test(title);

// NHS frontline care roles (Bands 2–4): healthcare / nursing / clinical support workers and assistants.
// NHS titles use "nursing" and "clinical" for these posts, so they get their own exclusion list.
const NHS_ROLE = /\b(?:health\s*care|nursing|clinical|care|patient\s+care|maternity\s+care)\s+(?:support\s+worker|assistant)s?\b|\bnursing\s+(?:assistant|associate)|\bsupport\s+worker\b|\bhca\b|\bhcsw\b|\b(?:staff|registered|community|district|mental\s+health|theatre)?\s*nurses?\b|\brgn\b|\brmn\b/i;
const NHS_NOT_FRONTLINE = /\b(?:senior|snr|lead|leader|supervisor|manager|management|co-?ordinator|deputy|head|director|charge|sister|matron|specialist|advanced|consultant|educator|practitioner|trainee|apprentice|student|bank|relief|admin\w*|clerical|secretary|receptionist|domestic|porter|catering|housekeep\w*|estates|pharmacy|laboratory|lab|radiograph\w*|dental|occupational|physio\w*|dietetic|speech|podiatr\w*|band\s*[6-9])\b/i;
const isNhsRole = title => NHS_ROLE.test(title) && !NHS_NOT_FRONTLINE.test(title) && !NURSING_ROLE.test(title);
// Register names for NHS bodies whose public name differs.
const NHS_ALIASES = {
  'hywel dda university health board': 'Hywel Dda Health Board',
  'swansea bay university health board': 'Swansea Bay University Local Health Board',
  'velindre university nhs trust': 'Velindre NHS Trust',
  'public health wales': 'Public Health Wales NHS Trust',
  'nhs golden jubilee': 'National Waiting Times Centre Board',
  'golden jubilee national hospital': 'National Waiting Times Centre Board',
};
const nhsRegisterName = name => NHS_ALIASES[(name || '').toLowerCase().trim()] || name;
// NHS Jobs prints this paragraph on every advert, whatever the role, so on its own it isn't evidence that this
// post can be sponsored. It invites people who already hold Skilled Worker sponsorship, i.e. switching in the UK.
const NHS_STATEMENT = /Certificate of Sponsorship\s*Applications from job seekers who require current Skilled worker sponsorship[^]*?(?:alongside all other applications\.?)/i;
// 'offered' (the advert's own wording), 'nhs statement' (only the standard paragraph), or a reason to drop.
function nhsSponsorship(text, hasStatement) {
  const own = careSponsorship((text || '').replace(NHS_STATEMENT, ' '));
  if (own === 'offered' || own === 'not offered' || own === 'professional only') return own;
  return hasStatement ? 'nhs statement' : 'not mentioned';
}
const careKind = title => NURSE.test(title) ? 'Nurse'
  : /(?<!nursing\s)home\s*care|homecare|domiciliary|community|live[- ]in/i.test(title) ? 'Home care'
  : /support\s+worker/i.test(title) && !/care\s+support/i.test(title) ? 'Support worker'
  : /health\s*care\s+assistant|\bhca\b|healthcare\s+support/i.test(title) ? 'Healthcare assistant' : 'Care worker';

// A-rated Skilled Worker licence (B-rated sponsors can't assign new certificates of sponsorship).
const hasSkilledWorkerA = sponsor => (sponsor?.licences || []).some(l => /^Worker \(A/.test(l) && /Skilled Worker/.test(l));

// Companies the user knows don't sponsor care workers, e.g. sponsor only RQF 6 roles.
const EXCLUDE_FILE = path.join(__dirname, 'care-exclude.json');
function excludedCompanies() {
  const list = fs.existsSync(EXCLUDE_FILE) ? JSON.parse(fs.readFileSync(EXCLUDE_FILE, 'utf8')).companies || [] : [];
  return new Set(list.flatMap(c => [c.name, ...(c.aliases || [])]).map(key));
}

// Hourly or annual pay from text such as "£12.60 - £13.20 per hour" or "£25,500 a year".
function parseCarePay(text) {
  const m = (text || '').match(/£\s?(\d{1,2}(?:\.\d{1,2})?)\s*(?:-|–|to)?\s*(?:£\s?(\d{1,2}(?:\.\d{1,2})?))?\s*(?:per|an|a|\/)\s*(?:hour|hr)/i);
  if (m) return { hourlyFrom: +m[1], hourlyTo: +(m[2] || m[1]) };
  return null;
}

// NHS posts are either nurses or healthcare / nursing support roles.
const nhsKind = title => NURSE.test(title) && !/assistant|associate|support/i.test(title) ? 'Nurse' : 'Healthcare assistant';
// NHS Jobs carries both NHS England and NHS Wales adverts; Welsh health bodies are recognised by name.
const nhsNation = employer => /health\s+board|velindre|public\s+health\s+wales|nhs\s+wales|welsh\s+ambulance|health\s+education\s+and\s+improvement\s+wales|digital\s+health\s+and\s+care\s+wales/i.test(employer || '') ? 'Wales' : 'England';
// Long care adverts are shortened in the app; the full text stays on the original advert.
const DESC_MAX = 2500;

module.exports = { CARE_ROLE, NURSING_ROLE, NOT_FRONTLINE, careSponsorship, isCareRole, careKind, hasSkilledWorkerA, excludedCompanies, IN_UK_ONLY, parseCarePay,
  isNhsRole, nhsRegisterName, nhsSponsorship, nhsKind, nhsNation, NHS_STATEMENT, DESC_MAX };
