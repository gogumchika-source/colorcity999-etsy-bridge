// Fail-closed Cloudflare Access JWT verification for the future private Studio.
// No Auth0/MCP credentials are reused and no secrets enter the browser.
function denied(status, message) { throw Object.assign(new Error(message), { status }); }
function b64(s) {
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4);
  return Uint8Array.from(atob(normalized), c => c.charCodeAt(0));
}
export async function requireStudioOwner(request, env) {
  const domain = env.STUDIO_ACCESS_TEAM_DOMAIN;
  const audience = env.STUDIO_ACCESS_AUD;
  const owner = env.STUDIO_ALLOWED_EMAIL;
  if (typeof domain !== "string" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) ||
      typeof audience !== "string" || !audience.trim() ||
      typeof owner !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner)) {
    denied(503, "Listing Studio authentication has not been configured.");
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  if (!token) denied(401, "Private Studio login is required.");
  const parts = token.split(".");
  if (parts.length !== 3) denied(401, "Invalid Access token.");
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64(parts[1])));
  } catch { denied(401, "Invalid Access token."); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") denied(401, "Unsupported Access token.");
  const expectedIssuer = "https://" + domain;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== expectedIssuer || !audiences.includes(audience) ||
      !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000 ||
      (payload.nbf && payload.nbf > Date.now() / 1000) ||
      typeof payload.email !== "string" || payload.email.toLowerCase() !== owner.toLowerCase()) {
    denied(403, "This account cannot access Listing Studio.");
  }
  let response;
  try { response = await fetch(expectedIssuer + "/cdn-cgi/access/certs", { headers: { Accept: "application/json" } }); }
  catch { denied(503, "Cloudflare Access key verification is unavailable."); }
  if (!response.ok) denied(503, "Cloudflare Access key verification is unavailable.");
  const certs = await response.json();
  const key = Array.isArray(certs.keys) && certs.keys.find(x => x.kid === header.kid && (!x.use || x.use === "sig"));
  if (!key) denied(401, "Unknown Access signing key.");
  try {
    const imported = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", imported, b64(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
    if (!ok) denied(401, "Invalid Access token signature.");
  } catch (error) { if (error.status) throw error; denied(401, "Invalid Access signing key."); }
  return { email: payload.email };
}
