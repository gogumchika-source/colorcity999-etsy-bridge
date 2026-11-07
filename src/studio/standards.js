// Technical checks from Etsy Help/API, reviewed 2026-11-07. Policy/rights review also needs the actual product.
export const AI_DISCLOSURE = 'This product includes artwork created with the assistance of AI tools.';
export const DEFAULT_PRICE = '9.99';
const fail = message => { throw Object.assign(new Error(message), { status: 422 }); };

export function listingDefaults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Prepared listing details are missing.');
  const input = { ...value, price: value.price ?? DEFAULT_PRICE, currency: value.currency || 'USD' };
  if (typeof input.description === 'string' && input.description.trim() && !input.description.includes(AI_DISCLOSURE)) input.description = input.description.trim() + '\n\n' + AI_DISCLOSURE;
  if (Array.isArray(input.tags)) input.tags = input.tags.map(tag => typeof tag === 'string' ? tag.trim().replace(/^#+/, '').replace(/[\u2018\u2019]/g, "'").toLowerCase() : tag);
  if (typeof input.title === 'string') input.title = input.title.trim();
  return input;
}
export function validateEtsyText(input) {
  if (/[^\p{L}\p{Nd}\p{P}\p{Sm}\p{Zs}™©®]/u.test(input.title)) fail('The listing title contains characters Etsy does not accept.');
  for (const symbol of ['%', ':', '&', '+']) if (input.title.split(symbol).length > 2) fail('Etsy allows ' + symbol + ' only once in a title.');
  if (input.tags.some(tag => !/^[\p{L}\p{Nd}][\p{L}\p{Nd} '-]*$/u.test(tag))) fail('Etsy tags must be keyword phrases using letters, numbers, spaces, apostrophes or hyphens.');
}
export function buyerFilename(original) {
  const base = original.split('/').pop().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]/g, '_');
  return (base.replace(/\.pdf$/i, '').slice(0, 66) || 'ColorCity999_Product') + '.pdf';
}
export function imageDimensions(asset) {
  const b = asset.bytes, v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (asset.kind === 'image/png' && b.length >= 24 && v.getUint32(12) === 0x49484452) return { width: v.getUint32(16), height: v.getUint32(20) };
  if (asset.kind === 'image/jpeg') {
    let at = 2;
    while (at + 8 < b.length) {
      if (b[at++] !== 255) break;
      let marker = b[at++]; while (marker === 255 && at < b.length) marker = b[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > b.length) break;
      const length = v.getUint16(at);
      if (length < 2 || at + length > b.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { width: v.getUint16(at + 5), height: v.getUint16(at + 3) };
      at += length;
    }
  }
  fail('Cannot read the dimensions of ' + asset.name + '. Use a valid JPG or PNG.');
}
export function checkPackage(pkg, { strictImages = false } = {}) {
  if (pkg.pdf.bytes.length > 20000000) fail('Etsy digital files must be 20 MB or smaller.');
  const warnings = [], images = pkg.images.map(asset => {
    if (!['image/png','image/jpeg'].includes(asset.kind)) fail('For Etsy drafts, use JPG or PNG preview images.');
    const dimensions = imageDimensions(asset);
    if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > 100000000) fail('Invalid or excessively large image dimensions.');
    if (Math.min(dimensions.width, dimensions.height) < 2000) {
      if (strictImages) fail(asset.name + ' is below Etsy\'s recommended 2000 pixels on each side. Prepare a full-resolution preview before upload.');
      warnings.push(asset.name + ': Etsy recommends at least 2000 pixels on each side.');
    }
    return { name: asset.name, ...dimensions };
  });
  return { customerFilename: buyerFilename(pkg.pdf.name), digitalFileBytes: pkg.pdf.bytes.length, images, warnings };
}
export function flattenTaxonomy(nodes, parents = []) {
  const out = [];
  for (const node of nodes || []) {
    const path = [...parents, node.name];
    if (!node.children?.length) out.push({ id: node.id, name: path.join(' > '), leaf: node.name });
    else out.push(...flattenTaxonomy(node.children, path));
  }
  return out;
}
export function selectCategory(tree, metadata) {
  const categories = flattenTaxonomy(tree.results);
  if (Number.isSafeInteger(metadata.taxonomyId)) {
    const exact = categories.find(x => x.id === metadata.taxonomyId);
    if (!exact) fail('The prepared category is not a current Etsy category.');
    return exact;
  }
  const names = { coloring_book: ['coloring books','colouring books'], activity_book: ['activity books'], learning_resource: ['learning & school','learning and school','learning resources'] };
  const preferred = names[metadata.productType];
  if (!preferred) fail('The product needs a verified category before uploading.');
  const matches = categories.filter(x => preferred.includes(x.leaf.toLowerCase()));
  const ranked = matches.map(x => ({ ...x, score: /books/i.test(x.name) ? 2 : 0 })).sort((a,b)=>b.score-a.score);
  if (!ranked.length || (ranked.length > 1 && ranked[0].score === ranked[1].score)) fail('The Etsy category is ambiguous. Prepare an exact taxonomy ID for this product.');
  return ranked[0];
}
