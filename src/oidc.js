let cachedConfig = null;

export async function authorizeMcpRequest(request, env, requiredScope) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    throw httpError(401, "OAuth bearer token required.", {
      "WWW-Authenticate": 'Bearer resource_metadata="' + new URL("/.well-known/oauth-protected-resource", request.url).toString() + '"',
    });
  }

  const issuer = normalizeIssuer(env.MCP_AUTH_ISSUER);
  const audience = env.MCP_AUTH_AUDIENCE;
  if (!issuer || !audience) throw httpError(503, "MCP OAuth verification is not configured.");

  const token = authorization.slice(7).trim();
  const claims = await verifyJwt(token, issuer, audience);
  if (env.MCP_ALLOWED_SUBJECT && claims.sub !== env.MCP_ALLOWED_SUBJECT) {
    throw httpError(403, "This account is not allowed to use the ColorCity999 bridge.");
  }

  const scopes = new Set(
    typeof claims.scope === "string"
      ? claims.scope.split(/\s+/).filter(Boolean)
      : Array.isArray(claims.permissions)
        ? claims.permissions
        : []
  );
  if (requiredScope && !scopes.has(requiredScope)) {
    throw httpError(403, "The connected account does not have the required bridge permission.");
  }
  return claims;
}

export function protectedResourceMetadata(request, env) {
  const issuer = normalizeIssuer(env.MCP_AUTH_ISSUER);
  if (!issuer) throw httpError(503, "MCP OAuth verification is not configured.");
  return {
    resource: new URL("/mcp", request.url).toString(),
    authorization_servers: [issuer],
    scopes_supported: ["etsy:read", "etsy:write", "etsy:publish"],
    bearer_methods_supported: ["header"],
  };
}

async function verifyJwt(token, issuer, audience) {
  const parts = token.split(".");
  if (parts.length !== 3) throw httpError(401, "Invalid OAuth access token.");
  let header;
  let claims;
  let signature;
  try {
    header = JSON.parse(decodeBase64Url(parts[0]));
    claims = JSON.parse(decodeBase64Url(parts[1]));
    signature = decodeBase64UrlBytes(parts[2]);
  } catch {
    throw httpError(401, "Invalid OAuth access token.");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw httpError(401, "Unsupported OAuth access token.");
  }

  const config = await getOpenIdConfig(issuer);
  const keys = await getJwks(config.jwks_uri, issuer);
  const jwk = keys.find((item) => item.kid === header.kid && (!item.use || item.use === "sig"));
  if (!jwk) {
    cachedConfig = null;
    throw httpError(401, "OAuth signing key was not found.");
  }

  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
  } catch {
    throw httpError(401, "OAuth signing key is invalid.");
  }

  const signedContent = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const signatureValid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signature,
    signedContent
  );
  if (!signatureValid) throw httpError(401, "OAuth access token signature is invalid.");

  const now = Math.floor(Date.now() / 1000);
  const tokenAudiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== issuer ||
    !tokenAudiences.includes(audience) ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30)) ||
    typeof claims.sub !== "string" ||
    !claims.sub
  ) {
    throw httpError(401, "OAuth access token is expired or intended for another service.");
  }
  return claims;
}

async function getOpenIdConfig(issuer) {
  if (cachedConfig?.issuer === issuer && cachedConfig.expiresAt > Date.now()) return cachedConfig.config;
  let response;
  try {
    response = await fetch(issuer + ".well-known/openid-configuration", {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
  } catch {
    throw httpError(503, "OAuth provider discovery is unavailable.");
  }
  if (!response.ok) throw httpError(503, "OAuth provider discovery is unavailable.");
  let config;
  try {
    config = await response.json();
  } catch {
    throw httpError(503, "OAuth provider discovery returned invalid data.");
  }
  if (config.issuer !== issuer || typeof config.jwks_uri !== "string" || !config.jwks_uri.startsWith("https://")) {
    throw httpError(503, "OAuth provider discovery does not match the configured issuer.");
  }
  cachedConfig = { issuer, expiresAt: Date.now() + 300_000, config };
  return config;
}

async function getJwks(jwksUri, issuer) {
  if (cachedConfig?.issuer === issuer && Array.isArray(cachedConfig.keys) && cachedConfig.keysExpiresAt > Date.now()) {
    return cachedConfig.keys;
  }
  let response;
  try {
    response = await fetch(jwksUri, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
  } catch {
    throw httpError(503, "OAuth signing keys are unavailable.");
  }
  if (!response.ok) throw httpError(503, "OAuth signing keys are unavailable.");
  let body;
  try {
    body = await response.json();
  } catch {
    throw httpError(503, "OAuth signing keys returned invalid data.");
  }
  if (!Array.isArray(body.keys)) throw httpError(503, "OAuth signing keys returned invalid data.");
  cachedConfig = {
    ...(cachedConfig || {}),
    issuer,
    keys: body.keys,
    keysExpiresAt: Date.now() + 300_000,
  };
  return body.keys;
}

function normalizeIssuer(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) return null;
  return value.endsWith("/") ? value : value + "/";
}

function decodeBase64Url(value) {
  return new TextDecoder().decode(decodeBase64UrlBytes(value));
}

function decodeBase64UrlBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function httpError(status, message, headers = {}) {
  return Object.assign(new Error(message), { status, headers });
}
