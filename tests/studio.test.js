import test from "node:test";
import assert from "node:assert/strict";
import { extractListingPackage } from "../src/studio/zip.js";
import { validateGeneratedListing, generateListingPreview } from "../src/studio/seo.js";
import { handleStudio } from "../src/studio/index.js";
import worker from "../worker.js";
import { requireStudioOwner } from "../src/studio/auth.js";
import { deflateRawSync } from "node:zlib";

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
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const sample = () => zip([["Mia_and_Max_Alphabet.pdf", pdf], ["02-page.png", png], ["cover.png", png]]);
const tags = ["alphabet coloring","abc coloring book","letters for kids","printable activity","kids coloring pdf","learning alphabet","coloring download","letter coloring","preschool letters","school activity","printable alphabet","kids art project","digital coloring"];
const aiResponse = { title: "Alphabet Coloring Book Printable PDF for Kids", description: "A printable alphabet-themed PDF coloring activity. Instant digital download; no physical item is shipped.", tags };

test("ZIP extracts a single PDF and orders cover before the other preview images", async () => {
  const extracted = await extractListingPackage(sample());
  assert.equal(extracted.pdf.name, "Mia_and_Max_Alphabet.pdf");
  assert.deepEqual(extracted.images.map(x => x.name), ["cover.png", "02-page.png"]);
  assert.equal(extracted.images[0].bytes.byteLength, png.length);
});
test("ZIP rejects traversal, missing images and falsely named assets", async () => {
  await assert.rejects(extractListingPackage(zip([["../escape.pdf", pdf], ["cover.png", png]])), /Unsafe ZIP path/);
  await assert.rejects(extractListingPackage(zip([["book.pdf", pdf]])), /exactly one PDF/);
  await assert.rejects(extractListingPackage(zip([["book.pdf", pdf], ["cover.png", Buffer.from("not a PNG")]])), /signature/);
});
test("AI metadata validation enforces 13 unique short tags", () => {
  const listing = validateGeneratedListing(aiResponse);
  assert.equal(listing.price, 9.99);
  assert.equal(listing.tags.length, 13);
  assert.equal(listing.state, "preview_only");
  assert.throws(() => validateGeneratedListing({ ...aiResponse, tags: ["duplicate", ...Array(12).fill("duplicate")] }), /unique/);
  assert.throws(() => validateGeneratedListing({ ...aiResponse, tags: tags.slice(0, 12) }), /exactly 13/);
});
test("Workers AI adapter produces a validated, preview-only listing", async () => {
  let calls = 0;
  const ai = { run: async (model, options) => {
    calls++;
    assert.equal(model, "@cf/meta/llama-3.1-8b-instruct-fp8");
    assert.match(options.messages[1].content, /Alphabet/);
    return { response: JSON.stringify(aiResponse) };
  }};
  const result = await generateListingPreview(ai, {
    label: "Alphabet Coloring Book", pdfName: "Alphabet.pdf", imageNames: ["cover.png"]
  });
  assert.equal(calls, 1);
  assert.equal(result.tags.length, 13);
  assert.equal(result.state, "preview_only");
});
test("worker has Studio disabled by default, and rejects a missing owner configuration", async () => {
  const request = new Request("https://bridge.test/studio");
  const off = await worker.fetch(request, {});
  assert.equal(off.status, 503);
  const noOwner = await worker.fetch(request, { STUDIO_ENABLED: "preview" });
  assert.equal(noOwner.status, 503);
});
test("owner-gated Studio renders a preview UI, never publication controls", async () => {
  const response = await handleStudio(new Request("https://bridge.test/studio"), {
    STUDIO_ENABLED: "preview"
  }, { authorize: async () => ({ email: "test@example.test" }) });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Generate listing preview/);
  assert.match(html, /No Etsy write/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
test("preview request extracts sample ZIP and AI metadata, without any Etsy calls", async () => {
  let aiCalls = 0;
  const env = { STUDIO_ENABLED: "preview", AI: { run: async () => {
    aiCalls++;
    return { response: JSON.stringify(aiResponse) };
  }}};
  const request = new Request("https://bridge.test/studio/preview", {
    method: "POST",
    headers: { "Content-Type": "application/zip", Origin: "https://bridge.test" },
    body: sample()
  });
  const response = await handleStudio(request, env, { authorize: async () => ({ email: "test@example.test" }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(aiCalls, 1);
  assert.equal(result.noEtsyWrites, true);
  assert.equal(result.mode, "preview_only");
  assert.equal(result.digitalFile.name, "Mia_and_Max_Alphabet.pdf");
  assert.equal(result.images.length, 2);
  assert.equal(result.listing.tags.length, 13);
  assert.match(result.heroDataUrl, /^data:image\/png;base64,/);
});
test("cross-origin upload fails before extraction or AI inference", async () => {
  await assert.rejects(handleStudio(new Request("https://bridge.test/studio/preview", {
    method: "POST",
    headers: { Origin: "https://evil.test", "Content-Type": "application/zip" },
    body: sample()
  }), { STUDIO_ENABLED: "preview", AI: { run: async () => { throw new Error("must not run"); } } }, {
    authorize: async () => {}
  }), error => error.status === 403);
});

test("a normal deflate-compressed ZIP is extracted and verified", async () => {
  const compressed = zip([["Alphabet.pdf", pdf], ["cover.png", png]], true);
  const result = await extractListingPackage(compressed);
  assert.equal(result.pdf.name, "Alphabet.pdf");
  assert.equal(result.images[0].name, "cover.png");
});
test("Cloudflare Access owner JWT verifies signature, owner email and audience", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  globalThis.fetch = async () => Response.json({ keys: [{ ...jwk, kid: "test-key" }] });
  const env = { STUDIO_ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com", STUDIO_ACCESS_AUD: "studio-audience", STUDIO_ALLOWED_EMAIL: "owner@example.test" };
  const encode = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const head = encode({ alg: "RS256", kid: "test-key" });
  async function token(changes = {}) {
    const payload = encode({
      iss: "https://test-team.cloudflareaccess.com", aud: ["studio-audience"], email: "owner@example.test",
      exp: Math.floor(Date.now() / 1000) + 300, ...changes
    });
    const input = head + "." + payload;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
    return input + "." + Buffer.from(signature).toString("base64url");
  }
  const request = token => new Request("https://bridge.test/studio", { headers: { "Cf-Access-Jwt-Assertion": token } });
  assert.deepEqual(await requireStudioOwner(request(await token()), env), { email: "owner@example.test" });
  await assert.rejects(requireStudioOwner(request(await token({ email: "intruder@example.test" })), env), e => e.status === 403);
  await assert.rejects(requireStudioOwner(request(await token({ aud: ["different-audience"] })), env), e => e.status === 403);
  await assert.rejects(requireStudioOwner(request((await token()).slice(0, -2) + "xx"), env), e => e.status === 401);
});
