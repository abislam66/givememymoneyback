// Pull the plain text out of a Word (.docx) file, in memory, with no extra packages.
// A .docx is a zip; the words live in word/document.xml. Table cells become tabs and rows become lines,
// so bill and EOB tables still read as rows for Gemini. Nothing is written to disk.
const zlib = require('zlib');

const MAX_XML_BYTES = 20e6; // guard against a "zip bomb"

class DocxError extends Error {}

function entry(buf, wanted) {
  // End of central directory record: last 22+ bytes, found by its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new DocxError('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
      throw new DocxError('unsupported compression');
    }
    p += 46 + skip;
  }
  throw new DocxError('no document text');
}

function xmlToText(xml) {
  return xml
    .replace(/<\/w:p>\s*<\/w:tc>/g, '</w:tc>') // a cell's last paragraph ends the cell, not the line
    .replace(/<w:tab\/>|<\/w:tc>/g, '\t')
    .replace(/<w:br\/>|<w:cr\/>|<\/w:p>|<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// base64 .docx -> text. Throws DocxError when the file isn't a readable Word document.
function docxText(base64) {
  let buf;
  try { buf = Buffer.from(base64, 'base64'); } catch (e) { throw new DocxError('bad data'); }
  try {
    return xmlToText(entry(buf, 'word/document.xml').toString('utf8'));
  } catch (e) {
    throw e instanceof DocxError ? e : new DocxError(e.message);
  }
}

module.exports = { docxText, xmlToText, DocxError };
