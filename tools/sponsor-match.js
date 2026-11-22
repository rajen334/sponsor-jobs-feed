// Company-name normalisation shared by the job fetcher (Node) and the web app (browser).
(function (root) {
  // Legal suffixes only: "Saab UK Limited" and "Saab UK" are the same company.
  const LEGAL = new Set(['ltd', 'limited', 'plc', 'llp', 'lp', 'inc', 'incorporated', 'llc', 'corp', 'corporation',
    'co', 'company', 'the', 'uk', 'gb']);
  // Filler words dropped only for the looser match on longer names.
  const SUFFIXES = new Set([...LEGAL, 'group', 'holdings', 'holding', 'international', 'services', 'and', 'of']);

  function tokens(name) {
    return (name || '').toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/\bt\/a\b.*$/, '')          // "X Ltd t/a Y" -> "X Ltd"
      .replace(/\(.*?\)/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim().split(' ').filter(Boolean);
  }

  // Core key drops legal suffixes and filler words: "Saab UK Limited" -> "saab".
  function key(name) {
    const t = tokens(name).filter(w => !SUFFIXES.has(w));
    return t.length ? t.join(' ') : tokens(name).join(' ');
  }

  // Agencies advertise for unnamed clients, so their postings can't be tied to a sponsor.
  const AGENCY = /recruit|resourc|staffing|talent|personnel|headhunt|executive search|selection|appointments|\bjobs\b|careers|consultants? ltd|\bhays\b|michael page|robert half|randstad|adecco|harnham|client server|\bnoir\b|akkodis|la fosse|oliver bernard|explore group|burns sheehan|lorien|experis|nigel frank|jefferson frank|tenth revolution|computer futures|sanderson|harvey nash|venquis|stott and may|xcede|understanding recruitment|modis|spectrum it|searchability|digital waffle|corriculo|reed\b|virtuetech|in technology group|franklin fitch|trg recruitment|salt\b|jumar|hunter bond|anson mccade|ioassociates|tiro partners|crone corkill|deerfoot|parallel consulting|matchtech|gravitas|amoria|fintellect|enigma people|identify solutions|investigo|goodman masson|oho group|mondrian alpha|vallum associates|stackstudio|hamilton barnes|pontoon|kforce|nexus jobs|ascent people|bluetownonline|the bridge it|ic resources|cpl|ten10 hire|ts tech|skillfinder|eligo|maxwell bond|rullion|langley james|tech people|resolve tech|pearson whiffin|connexa|rise technical|ntrinsic|focus cloud/i;
  const isAgency = name => AGENCY.test(name || '');

  const legalKey = name => tokens(name).filter(w => !LEGAL.has(w)).join(' ');

  // Builds a lookup from a list of sponsor names; returns match(name) -> {index, quality} | null.
  function buildIndex(names) {
    const exact = new Map(), legal = new Map(), core = new Map();
    names.forEach((n, i) => {
      const e = tokens(n).join(' '), l = legalKey(n), k = key(n);
      if (!exact.has(e)) exact.set(e, i);
      if (l && !legal.has(l)) legal.set(l, i);
      if (k && !core.has(k)) core.set(k, i);
    });
    return function match(name) {
      const e = tokens(name).join(' ');
      if (!e) return null;
      if (exact.has(e)) return { index: exact.get(e), quality: 'exact' };
      const l = legalKey(name);
      if (l.length >= 3 && legal.has(l)) return { index: legal.get(l), quality: 'strong' };
      // Dropping words like "Group" is only safe for distinctive names: "Man Group" must not become "Man & Co".
      const k = key(name);
      if (k.length >= 7 && core.has(k)) return { index: core.get(k), quality: 'strong' };
      return null;
    };
  }

  const api = { tokens, key, buildIndex, isAgency };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SponsorMatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
