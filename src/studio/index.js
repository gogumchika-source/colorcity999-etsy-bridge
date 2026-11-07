import { renderStudio } from "./ui.js";
import { requireStudioOwner } from "./auth.js";
import { extractListingPackage } from "./zip.js";
import { generateListingPreview } from "./seo.js";
import { getStudioReadiness } from "./readiness.js";

// Listing Studio MVP: authenticated preview ONLY. No Etsy write functions are imported.
const MAX_ZIP_BYTES = 20_000_000;
function error(status, message) { throw Object.assign(new Error(message), { status }); }
function responseHeaders() { return { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }; }

async function boundedBody(request, maximum = MAX_ZIP_BYTES) {
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > maximum) error(413, "ZIP exceeds 20 MB.");
  if (!request.body) error(400, "A ZIP file is required.");
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) { await reader.cancel(); error(413, "ZIP exceeds 20 MB."); }
    chunks.push(value);
  }
  const data = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}
function boundedForwardBody(request, maximum) {
  if (Number(request.headers.get('Content-Length')) > maximum) error(413, 'ZIP exceeds 20 MB.');
  if (!request.body) error(400, 'A ZIP file is required.');
  let total = 0;
  return request.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    total += chunk.byteLength;
    if (total > maximum) error(413, 'ZIP exceeds 20 MB.');
    controller.enqueue(chunk);
  } }));
}
function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}
function humanLabel(filename) {
  return filename.split("/").pop().replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

export async function handleStudio(request, env, { authorize = requireStudioOwner } = {}) {
  const url = new URL(request.url);
  const routes = { '/studio/connect': ['POST', '/connect'], '/studio/oauth/callback': ['GET', '/callback'],
    '/studio/connection': ['GET', '/connection'], '/studio/taxonomy': ['GET', '/taxonomy'], '/studio/draft': ['POST', '/draft'], '/studio/prepare': ['POST', '/prepare'] };
  const route = routes[url.pathname];
  if (!["/studio", "/studio/preview", "/studio/ready"].includes(url.pathname) && !route) error(404, "Not found.");
  if (route && request.method !== route[0]) error(405, "Method not allowed.");
  if (url.pathname === "/studio" && request.method !== "GET") error(405, "Method not allowed.");
  if (url.pathname === "/studio/preview" && request.method !== "POST") error(405, "Method not allowed.");
  if (url.pathname === "/studio/ready" && request.method !== "GET") error(405, "Method not allowed.");
  if (env.STUDIO_ENABLED !== "preview") error(503, "Studio is not enabled.");
  await authorize(request, env);
  if (route) {
    if (!env.STUDIO_ACCOUNT) error(503, "Etsy draft connection is not configured yet.");
    if (request.method === "POST" && request.headers.get("Origin") !== url.origin) error(403, "Cross-origin requests are not allowed.");
    const stub = env.STUDIO_ACCOUNT.get(env.STUDIO_ACCOUNT.idFromName("colorcity999-owner"));
    const target = new URL("https://studio.internal" + route[1] + url.search);
    const internalHeaders = new Headers();
    if (request.headers.has("Cookie")) internalHeaders.set("Cookie", request.headers.get("Cookie"));
    let body;
    if (url.pathname === "/studio/draft" || url.pathname === '/studio/prepare') {
      if (!request.headers.get("Content-Type")?.startsWith("multipart/form-data;")) error(415, "Upload your ZIP and reviewed listing details.");
      internalHeaders.set("Content-Type", request.headers.get("Content-Type"));
      body = boundedForwardBody(request, 20_100_000);
    }
    return stub.fetch(new Request(target, { method: request.method, headers: internalHeaders, body, redirect: 'manual', ...(body ? { duplex: 'half' } : {}) }));
  }
  if (url.pathname === "/studio/ready") {
    const readiness = await getStudioReadiness(env);
    if (env.STUDIO_ACCOUNT) {
      const stub = env.STUDIO_ACCOUNT.get(env.STUDIO_ACCOUNT.idFromName("colorcity999-owner"));
      const connection = await (await stub.fetch("https://studio.internal/ready")).json();
      readiness.etsyConnection = connection;
      readiness.etsyListingWriteScope = connection.listingWriteScope;
      readiness.oauthRecord = connection.connected ? 'present' : 'absent';
      readiness.readyForFutureDraftIntegration = connection.draftCreationEnabled;
      readiness.checks.grantStatusSource = 'studio_account_storage';
      readiness.note = 'Studio account storage confirms the grant. The connection endpoint performs the separate live Etsy shop check.';
      readiness.readyForDraft = connection.draftCreationEnabled;
      readiness.publishingEnabled = false;
    }
    return Response.json(readiness, { headers: responseHeaders() });
  }
  if (url.pathname === "/studio") return renderStudio();
  if (request.headers.get("Origin") !== url.origin) error(403, "Cross-origin requests are not allowed.");
  if (request.headers.get("Content-Type") !== "application/zip") error(415, "Upload one ZIP file.");
  const file = await boundedBody(request);
  const pkg = await extractListingPackage(file);
  const rawLabel = request.headers.get("X-Book-Title");
  const label = typeof rawLabel === "string" && rawLabel.trim()
    ? rawLabel.trim().slice(0, 120)
    : humanLabel(pkg.pdf.name);
  const listing = await generateListingPreview(env.AI, {
    label, pdfName: pkg.pdf.name, imageNames: pkg.images.map(img => img.name)
  });
  const hero = pkg.images[0];
  const heroDataUrl = hero.bytes.length <= 400_000
    ? "data:" + hero.kind + ";base64," + base64(hero.bytes) : null;
  return Response.json({
    mode: "preview_only", noEtsyWrites: true, label,
    listing, digitalFile: { name: pkg.pdf.name, bytes: pkg.pdf.bytes.length },
    images: pkg.images.map(x => ({ name: x.name, bytes: x.bytes.length, kind: x.kind })),
    heroDataUrl,
    reviewNotes: [
      "Metadata is AI-generated from the filenames and supplied title, not from verified PDF artwork.",
      "Check content accuracy, print format, category, copyright, age appropriateness and all preview images.",
      "No files were saved or sent to Etsy. This preview does not create a listing."
    ]
  }, { headers: responseHeaders() });
}

