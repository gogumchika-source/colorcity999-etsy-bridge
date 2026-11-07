import { deflateRawSync, deflateSync } from 'node:zlib';
function crc32(buffer) {
  let crc = -1;
  for (const b of buffer) {
    crc ^= b;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function zip(entries, useDeflate = false) {
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, dataInput] of entries) {
    const nameBytes = Buffer.from(name), original = Buffer.from(dataInput);
    const data = useDeflate ? deflateRawSync(original) : original;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(original), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(original.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc32(original), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(original.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralData = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralData, eocd]);
}
const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
function pngChunk(kind, bytes) {
  const type = Buffer.from(kind), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
  return Buffer.concat([size, type, bytes, crc]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2000, 0); ihdr.writeUInt32BE(2000, 4); ihdr[8] = 8;
const pixels = Buffer.alloc(2001 * 2000, 255); for (let y = 0; y < 2000; y++) pixels[y * 2001] = 0;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);
const sample = () => zip([["Mia_and_Max_Alphabet.pdf", pdf], ["02-page.png", png], ["cover.png", png]]);

export { sample, zip, pdf, png };
