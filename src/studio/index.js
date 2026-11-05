import { requireStudioOwner } from "./auth.js";
import { extractListingPackage } from "./zip.js";
import { generateListingPreview } from "./seo.js";
import { getStudioReadiness } from "./readiness.js";

// Listing Studio MVP: authenticated preview ONLY. No Etsy write functions are imported.
const MAX_ZIP_BYTES = 20_000_000;
function error(status, message) { throw Object.assign(new Error(message), { status }); }
function responseHeaders() { return { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }; }

async function boundedBody(request) {
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_ZIP_BYTES) error(413, "ZIP exceeds 20 MB.");
  if (!request.body) error(400, "A ZIP file is required.");
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ZIP_BYTES) { await reader.cancel(); error(413, "ZIP exceeds 20 MB."); }
    chunks.push(value);
  }
  const data = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
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
  if (!["/studio", "/studio/preview", "/studio/ready"].includes(url.pathname)) error(404, "Not found.");
  if (url.pathname === "/studio" && request.method !== "GET") error(405, "Method not allowed.");
  if (url.pathname === "/studio/preview" && request.method !== "POST") error(405, "Method not allowed.");
  if (url.pathname === "/studio/ready" && request.method !== "GET") error(405, "Method not allowed.");
  if (env.STUDIO_ENABLED !== "preview") error(503, "Studio is not enabled.");
  await authorize(request, env);
  if (url.pathname === "/studio/ready") return Response.json(await getStudioReadiness(env), { headers: responseHeaders() });
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

function renderStudio() {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  const html = String.raw`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ColorCity999 | Listing Studio Preview</title>
<style>
:root{font-family:system-ui,sans-serif;color:#272035;background:#f6f3ff}*{box-sizing:border-box}
body{margin:0;padding:32px 16px}main{max-width:920px;margin:auto}h1{margin:0;font-size:2rem}
p,.muted{color:#675e76}header{margin-bottom:24px}.panel{background:#fff;padding:26px;border-radius:20px;box-shadow:0 3px 18px #30135410;margin-bottom:18px}
label{display:block;margin:14px 0 6px;font-weight:650}input{width:100%;padding:13px;border:1px solid #c8bfd9;border-radius:9px;background:#fff}
button{border:0;border-radius:10px;padding:13px 18px;background:#7549c9;color:white;font-weight:700;cursor:pointer;margin-top:18px}button:disabled{opacity:.6;cursor:wait}
.state{margin-top:14px;white-space:pre-wrap}.two{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:650px){.two{grid-template-columns:1fr}}
.tags{display:flex;gap:7px;flex-wrap:wrap}.tag{border-radius:18px;background:#f2ebff;padding:7px 10px;font-size:.8rem}
img.cover{max-width:100%;max-height:350px;object-fit:contain;border-radius:12px;border:1px solid #eee}
pre{white-space:pre-wrap;font-family:inherit;line-height:1.5}.warning{border-left:4px solid #b87516;padding-left:12px}
</style></head>
<body><main><header><h1>ColorCity999 Listing Studio</h1><p>Private preview · Your Etsy shop is never modified by this page.</p></header>
<section class="panel"><form id="form">
<label for="zip">One ZIP containing exactly one PDF and 1–10 cover/preview images</label>
<input id="zip" type="file" accept=".zip,application/zip" required>
<label for="title">Book title (optional; otherwise read from the PDF filename)</label>
<input id="title" type="text" maxlength="120" placeholder="Example: Mia and Max Alphabet Adventures">
<button type="submit" id="go">Generate listing preview</button>
<div class="state" id="status" role="status"></div></form></section>
<section id="result" hidden class="panel"><h2 id="listingTitle"></h2><div class="two">
<div><img id="hero" class="cover" hidden alt="First preview image from ZIP"><h3>Files found</h3><div id="assets"></div></div>
<div><h3>13 tags</h3><div class="tags" id="tags"></div><h3>Product</h3><p id="metadata"></p></div>
</div><h3>Description</h3><pre id="description"></pre><p class="warning" id="review"></p></section>
</main>
<script nonce="${nonce}">
const form=document.getElementById("form"), go=document.getElementById("go");
const status=document.getElementById("status"), result=document.getElementById("result");
form.addEventListener("submit",async event=>{
  event.preventDefault();
  const file=document.getElementById("zip").files[0];
  if(!file){status.textContent="Choose your ZIP.";return;}
  if(file.size>20000000){status.textContent="ZIP must be 20 MB or smaller.";return;}
  go.disabled=true;result.hidden=true;status.textContent="Inspecting ZIP and generating SEO metadata…";
  try {
    const title=document.getElementById("title").value.trim();
    const response=await fetch("/studio/preview",{
      method:"POST",headers:{"Content-Type":"application/zip","X-Book-Title":title},body:file
    });
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||"Preview failed.");
    document.getElementById("listingTitle").textContent=data.listing.title;
    document.getElementById("description").textContent=data.listing.description;
    document.getElementById("metadata").textContent="Digital PDF · $"+data.listing.price.toFixed(2)+" · Preview only";
    document.getElementById("review").textContent=data.reviewNotes.join(" ");
    const tagBox=document.getElementById("tags");tagBox.replaceChildren();
    for(const tag of data.listing.tags){const item=document.createElement("span");item.className="tag";item.textContent=tag;tagBox.append(item);}
    const assets=document.getElementById("assets");assets.replaceChildren();
    for(const f of [data.digitalFile,...data.images]){
      const p=document.createElement("p");p.textContent=f.name+" ("+Math.round(f.bytes/1024)+" KB)";assets.append(p);
    }
    const img=document.getElementById("hero");img.hidden=!data.heroDataUrl;
    if(data.heroDataUrl)img.src=data.heroDataUrl;else img.removeAttribute("src");
    result.hidden=false;status.textContent="Preview generated. No Etsy write requests were sent.";
  }catch(error){status.textContent=error.message;}finally{go.disabled=false;}
});
</script></body></html>`;
  return new Response(html, { headers: {
    ...responseHeaders(), "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  } });
}
