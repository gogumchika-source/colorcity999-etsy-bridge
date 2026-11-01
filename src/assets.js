const UPLOAD_PREFIX = "mcp:asset-upload:";
const ASSET_PREFIX = "mcp:staged-asset:";
const ASSET_DATA_PREFIX = "mcp:staged-file:";
const SESSION_TTL_SECONDS = 1800;
const ASSET_TTL_SECONDS = 86400;
const MAX_IMAGE_BYTES = 10000000;
const MAX_DIGITAL_BYTES = 20000000;

export async function createAssetUploadSession(env, origin) {
  requireAssetStorage(env);
  const code = randomHex(32);
  const key = UPLOAD_PREFIX + await sha256(code);
  await env.ETSY_KV.put(
    key,
    JSON.stringify({ expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000, imagesRemaining: 10, digitalFilesRemaining: 5 }),
    { expirationTtl: SESSION_TTL_SECONDS }
  );
  return {
    uploadCode: code,
    uploadPage: new URL("/assets/upload", origin).toString(),
    expiresInSeconds: SESSION_TTL_SECONDS,
    limits: { previewImages: 10, digitalFiles: 5, imageMaxBytes: MAX_IMAGE_BYTES, digitalFileMaxBytes: MAX_DIGITAL_BYTES },
    instructions: "Open the upload page, paste the code, select Preview image or Digital file, then upload each file. Wait for each upload to finish.",
  };
}

export function renderAssetUploadPage() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ColorCity999 asset staging</title><style>body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:680px;color:#211b2d;background:#f6f3ff}main{background:white;border-radius:16px;padding:1.5rem;box-shadow:0 5px 24px #0001}label{display:block;margin:1rem 0 .4rem}input,select,button{font:inherit}input,select{width:100%;padding:.7rem;box-sizing:border-box}button{margin-top:1rem;padding:.75rem 1rem;background:#5438b8;color:white;border:0;border-radius:8px}#status{white-space:pre-wrap;margin-top:1rem}</style></head>
<body><main><h1>Stage listing files</h1><p>This temporary upload page accepts the one-time code returned by the ColorCity999 bridge. Codes expire after 30 minutes.</p>
<label for="code">One-time upload code</label><input id="code" autocomplete="off" spellcheck="false">
<label for="kind">File type</label><select id="kind"><option value="image">Preview image</option><option value="digital_file">Digital download</option></select>
<label for="files">Choose files</label><input id="files" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf,application/zip">
<button id="upload" type="button">Upload selected files</button><div id="status" role="status"></div></main>
<script>
const button=document.getElementById("upload"),statusBox=document.getElementById("status");
button.addEventListener("click",async()=>{
 const code=document.getElementById("code").value.trim(),kind=document.getElementById("kind").value,files=[...document.getElementById("files").files];
 if(!code||!files.length){statusBox.textContent="Enter the code and choose at least one file.";return;}
 button.disabled=true;statusBox.textContent="";
 try{for(const file of files){
  statusBox.textContent+="Uploading "+file.name+"…\\n";
  const response=await fetch("/assets/upload",{method:"POST",headers:{"Authorization":"Bearer "+code,"Content-Type":file.type||"application/octet-stream","X-Asset-Purpose":kind,"X-Asset-Name":encodeURIComponent(file.name)},body:file});
  const result=await response.json();if(!response.ok)throw new Error(result.error||"Upload failed.");
  statusBox.textContent+="Staged "+file.name+" as "+result.assetId+"\\n";
 }}catch(error){statusBox.textContent+="Stopped: "+error.message;}finally{button.disabled=false;}
});
</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

export async function handleAssetUpload(request, env) {
  requireAssetStorage(env);
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw httpError(401, "Upload code required.");
  const code = authorization.slice(7).trim();
  if (!/^[a-f0-9]{64}$/i.test(code)) throw httpError(401, "Upload code is invalid or expired.");

  const sessionKey = UPLOAD_PREFIX + await sha256(code);
  const session = await env.ETSY_KV.get(sessionKey, { type: "json" });
  if (!session || session.expiresAt <= Date.now()) {
    await env.ETSY_KV.delete(sessionKey);
    throw httpError(401, "Upload code is invalid or expired.");
  }

  const purpose = request.headers.get("X-Asset-Purpose");
  if (purpose !== "image" && purpose !== "digital_file") throw httpError(400, "Choose a valid asset type.");
  if (purpose === "image" && session.imagesRemaining <= 0) throw httpError(400, "This upload code has no preview-image slots left.");
  if (purpose === "digital_file" && session.digitalFilesRemaining <= 0) throw httpError(400, "This upload code has no digital-file slots left.");

  const maxBytes = purpose === "image" ? MAX_IMAGE_BYTES : MAX_DIGITAL_BYTES;
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw httpError(413, "File exceeds the size limit.");
  const bytes = await readLimitedBody(request, maxBytes);
  const name = safeFileName(request.headers.get("X-Asset-Name") || "");
  const contentType = normalizeContentType(request.headers.get("Content-Type") || "");
  validateAsset(name, contentType, bytes, purpose);

  const assetId = randomHex(16);
  await env.ETSY_KV.put(ASSET_DATA_PREFIX + assetId, bytes, { expirationTtl: ASSET_TTL_SECONDS });

  const nextSession = {
    ...session,
    ...(purpose === "image" ? { imagesRemaining: session.imagesRemaining - 1 } : { digitalFilesRemaining: session.digitalFilesRemaining - 1 }),
  };
  await env.ETSY_KV.put(sessionKey, JSON.stringify(nextSession), { expirationTtl: Math.max(60, Math.ceil((session.expiresAt - Date.now()) / 1000)) });
  const metadata = { assetId, purpose, name, contentType, bytes: bytes.byteLength, expiresAt: Date.now() + ASSET_TTL_SECONDS * 1000 };
  await env.ETSY_KV.put(ASSET_PREFIX + assetId, JSON.stringify(metadata), { expirationTtl: ASSET_TTL_SECONDS });

  return Response.json(
    { staged: true, assetId, purpose, name, bytes: bytes.byteLength, expiresInSeconds: ASSET_TTL_SECONDS },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function listStagedAssets(env) {
  requireAssetStorage(env);
  const listed = await env.ETSY_KV.list({ prefix: ASSET_PREFIX, limit: 50 });
  const assets = [];
  for (const item of listed.keys || []) {
    const metadata = await env.ETSY_KV.get(item.name, { type: "json" });
    if (!metadata) continue;
    if (metadata.expiresAt <= Date.now()) {
      await deleteStagedAsset(env, metadata);
      continue;
    }
    assets.push({
      assetId: metadata.assetId,
      purpose: metadata.purpose,
      name: metadata.name,
      contentType: metadata.contentType,
      bytes: metadata.bytes,
      expiresAt: metadata.expiresAt,
    });
  }
  return { assets, hasMore: listed.list_complete === false };
}

export async function getStagedAsset(env, assetId, purpose) {
  requireAssetStorage(env);
  if (typeof assetId !== "string" || !/^[a-f0-9]{32}$/i.test(assetId)) throw httpError(400, "asset_id is invalid.");
  const metadata = await env.ETSY_KV.get(ASSET_PREFIX + assetId, { type: "json" });
  if (!metadata || metadata.expiresAt <= Date.now()) {
    if (metadata) await deleteStagedAsset(env, metadata);
    throw httpError(404, "Staged asset was not found or has expired.");
  }
  if (metadata.purpose !== purpose) throw httpError(400, "Staged asset has the wrong file type.");
  const bytes = await env.ETSY_KV.get(ASSET_DATA_PREFIX + assetId, { type: "arrayBuffer" });
  if (!bytes) throw httpError(404, "Staged file storage is unavailable.");
  return { metadata, bytes: new Uint8Array(bytes) };
}

export async function deleteStagedAsset(env, metadata) {
  if (metadata?.assetId) {
    await env.ETSY_KV.delete(ASSET_DATA_PREFIX + metadata.assetId);
    await env.ETSY_KV.delete(ASSET_PREFIX + metadata.assetId);
  }
}

async function readLimitedBody(request, maxBytes) {
  if (!request.body) throw httpError(400, "A file is required.");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw httpError(413, "File exceeds the size limit.");
    }
    chunks.push(value);
  }
  if (size === 0) throw httpError(400, "A file is required.");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateAsset(name, contentType, bytes, purpose) {
  const extension = name.toLowerCase().split(".").pop();
  if (purpose === "image") {
    if (!["image/jpeg", "image/png", "image/webp"].includes(contentType) || !["jpg", "jpeg", "png", "webp"].includes(extension)) {
      throw httpError(400, "Preview images must be JPG, PNG, or WebP files.");
    }
    const valid = (contentType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      || (contentType === "image/png" && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      || (contentType === "image/webp" && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP");
    if (!valid) throw httpError(400, "Image content did not match its file type.");
    return;
  }
  const isPdf = extension === "pdf" && (contentType === "application/pdf" || contentType === "application/octet-stream") && ascii(bytes, 0, 5) === "%PDF-";
  const isZip = extension === "zip" && ["application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(contentType) && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isPdf && !isZip) throw httpError(400, "Digital downloads must be valid PDF or ZIP files.");
}

function ascii(bytes, start, length) {
  let value = "";
  for (let index = start; index < Math.min(start + length, bytes.length); index++) value += String.fromCharCode(bytes[index]);
  return value;
}

function normalizeContentType(value) {
  return value.split(";")[0].trim().toLowerCase();
}

function safeFileName(value) {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch {}
  const name = decoded.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.length > 120) throw httpError(400, "File name is invalid.");
  return name;
}

function requireAssetStorage(env) {
  if (!env.ETSY_KV) throw httpError(503, "Temporary file staging is not configured.");
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
