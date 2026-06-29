// Minimal in-browser .xlsx reader for the Wongnai delivery reports.
// An .xlsx file is a ZIP of XML parts: we read the ZIP central directory by
// hand, inflate entries with DecompressionStream('deflate-raw'), and parse
// the worksheet/sharedStrings XML with regexes. No third-party deps.

import { DELIVERY_HEADER_ALIASES } from './helpers.js';

function readUInt32LE(view, off) { return view.getUint32(off, true); }
function readUInt16LE(view, off) { return view.getUint16(off, true); }

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns a Map of { entryName -> Uint8Array(contents) } for a .xlsx/.zip file.
async function readZip(buf) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const entries = new Map();
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (readUInt32LE(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP end-of-directory record).');
  const count = readUInt16LE(view, eocd + 10);
  let off = readUInt32LE(view, eocd + 16);
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (readUInt32LE(view, off) !== 0x02014b50) break;
    const method = readUInt16LE(view, off + 10);
    const compSize = readUInt32LE(view, off + 20);
    const nameLen = readUInt16LE(view, off + 28);
    const extraLen = readUInt16LE(view, off + 30);
    const commentLen = readUInt16LE(view, off + 32);
    const localOff = readUInt32LE(view, off + 42);
    const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    const lNameLen = readUInt16LE(view, localOff + 26);
    const lExtraLen = readUInt16LE(view, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    entries.set(name, method === 0 ? raw : await inflateRaw(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x?[0-9a-fA-F]+;/g,
      m => String.fromCodePoint(parseInt(m.slice(2, -1), m[2] === 'x' ? 16 : 10)));
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const parts = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXmlEntities(t[1]));
    out.push(parts.join(''));
  }
  return out;
}

function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n; // 1-based
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = cm[1], attrs = cm[2], inner = cm[3] || '';
      const t = (attrs.match(/t="([^"]+)"/) || [])[1];
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = decodeXmlEntities((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
      else if (v !== undefined) val = v;
      cells[colIndex(ref)] = val;
    }
    const max = Math.max(0, ...Object.keys(cells).map(Number));
    const arr = [];
    for (let i = 1; i <= max; i++) arr.push(cells[i] ?? '');
    rows.push(arr);
  }
  return rows;
}

// Reads an .xlsx ArrayBuffer and returns the first worksheet with data, as an
// array of row arrays. Row 0 (the header) has its labels normalized via
// DELIVERY_HEADER_ALIASES (e.g. "time" -> "date", "menuName" stays as-is).
export async function parseXlsxRows(arrayBuffer) {
  const zip = await readZip(arrayBuffer);
  const sharedXml = zip.get('xl/sharedStrings.xml');
  const decoder = new TextDecoder('utf-8');
  const shared = parseSharedStrings(sharedXml ? decoder.decode(sharedXml) : '');
  const names = [...zip.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  let rows = [];
  for (const name of names) {
    const candidate = parseSheet(decoder.decode(zip.get(name)), shared);
    if (candidate.length > 1) { rows = candidate; break; }
  }
  if (rows.length) {
    rows[0] = rows[0].map(h => DELIVERY_HEADER_ALIASES[String(h).trim().toLowerCase()] || String(h).trim());
  }
  return rows;
}
