// Minimal .xlsx reader: the first worksheet as an array of rows (arrays of cell text). Enough for the
// government statistics spreadsheets used here (no formulas, dates or merged-cell handling needed).
const zlib = require('zlib');

function entries(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip / xlsx file');
  const files = new Map();
  let p = buf.readUInt32LE(e + 16);
  for (let i = 0, n = buf.readUInt16LE(e + 10); i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen), local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, () => (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8'));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return files;
}

const unxml = s => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const colIndex = ref => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

function readSheet(buf) {
  const files = entries(buf);
  const shared = files.has('xl/sharedStrings.xml')
    ? [...files.get('xl/sharedStrings.xml')().matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unxml(m[1])) : [];
  const sheet = files.get('xl/worksheets/sheet1.xml')();
  return [...sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(r => {
    const row = [];
    for (const c of r[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, ref, attrs, inner = ''] = c, v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      row[colIndex(ref)] = /t="s"/.test(attrs) ? shared[+v] : /t="inlineStr"/.test(attrs) ? unxml(inner) : v != null ? unxml(v) : '';
    }
    return row;
  });
}

module.exports = { readSheet };
