// Safe, bounded ZIP extraction for the Studio preview. No external dependencies.
const MAX_ARCHIVE = 20_000_000;
const MAX_ITEMS = 40;
const MAX_TOTAL = 45_000_000;
const types = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

function fail(message) { throw Object.assign(new Error(message), { status: 400 }); }
function u16(view, pos) { if (pos < 0 || pos + 2 > view.byteLength) fail("Truncated ZIP."); return view.getUint16(pos, true); }
function u32(view, pos) { if (pos < 0 || pos + 4 > view.byteLength) fail("Truncated ZIP."); return view.getUint32(pos, true); }
function signature(view, pos, sig) { if (u32(view, pos) !== sig) fail("Invalid ZIP directory."); }
function suffix(name) { return Object.keys(types).find(ext => name.toLowerCase().endsWith(ext)); }

async function inflate(data, method, max) {
  if (method === 0) { if (data.length > max) fail("ZIP file exceeds its limit."); return data; }
  if (method !== 8 || typeof DecompressionStream !== "function") fail("Only stored and deflate ZIP files are supported.");
  let reader;
  try { reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader(); }
  catch { fail("Deflate decompression is not supported in this runtime."); }
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel(); fail("ZIP file expands beyond its limit."); }
      chunks.push(value);
    }
  } catch (error) { if (error.status) throw error; fail("Damaged or unsupported compressed ZIP file."); }
  const out = new Uint8Array(total); let cursor = 0;
  for (const chunk of chunks) { out.set(chunk, cursor); cursor += chunk.byteLength; }
  return out;
}

function crc32(bytes) {
  let crc = -1;
  for (const b of bytes) {
    crc ^= b;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

function verifySignature(bytes, kind) {
  const head = (...prefix) => prefix.every((b, i) => bytes[i] === b);
  if (kind === "application/pdf") return head(37, 80, 68, 70, 45);
  if (kind === "image/png") return head(137, 80, 78, 71, 13, 10, 26, 10);
  if (kind === "image/jpeg") return head(255, 216, 255);
  if (kind === "image/webp") return head(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
  return false;
}

export async function extractListingPackage(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 22 || bytes.length > MAX_ARCHIVE) fail("ZIP must be between 22 bytes and 20 MB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (u32(view, p) === 0x06054b50 && p + 22 + u16(view, p + 20) === bytes.length) { end = p; break; }
  }
  if (end < 0 || u16(view, end + 4) !== 0 || u16(view, end + 6) !== 0) fail("Invalid or multi-volume ZIP.");
  const count = u16(view, end + 10);
  const directorySize = u32(view, end + 12);
  const start = u32(view, end + 16);
  if (count < 1 || count > MAX_ITEMS || count !== u16(view, end + 8) || start === 0xffffffff || start + directorySize > end) fail("Unsupported ZIP directory.");
  let pos = start, total = 0; const entries = [];
  for (let i = 0; i < count; i++) {
    signature(view, pos, 0x02014b50);
    const flags = u16(view, pos + 8), method = u16(view, pos + 10);
    const checksum = u32(view, pos + 16), compressed = u32(view, pos + 20), expanded = u32(view, pos + 24);
    const nameLen = u16(view, pos + 28), extra = u16(view, pos + 30), comment = u16(view, pos + 32);
    const local = u32(view, pos + 42);
    const after = pos + 46 + nameLen + extra + comment;
    if (after > start + directorySize || (flags & 1) || ![0, 8].includes(method) || [compressed, expanded, local].includes(0xffffffff)) fail("Encrypted or unsupported ZIP entry.");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos = after;
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").some(seg => seg === ".." || seg === ".") || /^[a-z]:/i.test(name)) fail("Unsafe ZIP path.");
    if (name.endsWith("/")) continue;
    const ext = suffix(name);
    if (!ext) continue; // harmless README / metadata is ignored
    const kind = types[ext], limit = kind === "application/pdf" ? 20_000_000 : 10_000_000;
    if (expanded > limit || (total += expanded) > MAX_TOTAL) fail("ZIP contains files beyond size limits.");
    entries.push({ name, kind, method, checksum, compressed, expanded, local, limit });
  }
  if (pos !== start + directorySize) fail("ZIP directory length mismatch.");
  const pdfs = entries.filter(x => x.kind === "application/pdf");
  const images = entries.filter(x => x.kind.startsWith("image/"));
  if (pdfs.length !== 1 || images.length < 1 || images.length > 10) fail("ZIP needs exactly one PDF and 1–10 JPG/PNG/WebP previews.");
  const results = [];
  for (const item of entries) {
    signature(view, item.local, 0x04034b50);
    const dataPos = item.local + 30 + u16(view, item.local + 26) + u16(view, item.local + 28);
    if (dataPos + item.compressed > start) fail("Invalid ZIP entry offset.");
    const extracted = await inflate(bytes.subarray(dataPos, dataPos + item.compressed), item.method, item.limit);
    if (extracted.length !== item.expanded || crc32(extracted) !== item.checksum || !verifySignature(extracted, item.kind)) fail("Damaged ZIP entry or mismatched file signature.");
    results.push({ name: item.name, kind: item.kind, bytes: extracted });
  }
  const rank = item => /(^|\/)(cover|front|hero)([-_.]|$)/i.test(item.name) ? -1 : 0;
  const orderedImages = results.filter(x => x.kind.startsWith("image/")).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { pdf: results.find(x => x.kind === "application/pdf"), images: orderedImages, count: entries.length };
}
