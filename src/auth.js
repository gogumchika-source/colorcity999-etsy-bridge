const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const OAUTH_COOKIE = "oauth_session";
const OAUTH_TTL_SECONDS = 600;

export function getAuthorizationUrl(env, redirectUri, scopes) {
  return createAuthorizationResponse(env, redirectUri, scopes);
}

async function createAuthorizationResponse(env, redirectUri, scopes) {
  const state = randomHex(32);
  const verifier = randomHex(64);
  const challenge = await sha256Base64Url(verifier);
  const oauthData = JSON.stringify({ state, verifier });
  const signature = await sign(oauthData, env.ETSY_SHARED_SECRET);
  const cookieValue = base64UrlEncode(oauthData) + "." + signature;

  const authUrl = new URL("https://www.etsy.com/oauth/connect");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", getEtsyKeystring(env));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": OAUTH_COOKIE + "=" + cookieValue + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + OAUTH_TTL_SECONDS,
      "Cache-Control": "no-store",
    },
  });
}

export async function handleOAuthCallback(request, env, { redirectUri }) {
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return oauthFailure("Etsy authorization was not completed.", 400);

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) return oauthFailure("Missing OAuth authorization data.", 400);

  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const session = cookies[OAUTH_COOKIE];
  if (!session) return oauthFailure("OAuth session expired. Start the connection again.", 400);

  const parts = session.split(".");
  if (parts.length !== 2) return oauthFailure("Invalid OAuth session.", 400);

  let oauthData;
  try {
    oauthData = base64UrlDecode(parts[0]);
  } catch {
    return oauthFailure("Invalid OAuth session.", 400);
  }

  const expectedSignature = await sign(oauthData, env.ETSY_SHARED_SECRET);
  if (!timingSafeEqual(parts[1], expectedSignature)) {
    return oauthFailure("Invalid OAuth session signature.", 400);
  }

  let parsed;
  try {
    parsed = JSON.parse(oauthData);
  } catch {
    return oauthFailure("Invalid OAuth session.", 400);
  }

  if (returnedState !== parsed.state || !parsed.verifier) {
    return oauthFailure("OAuth state validation failed.", 400);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: getEtsyKeystring(env),
    redirect_uri: redirectUri,
    code,
    code_verifier: parsed.verifier,
  });

  const tokenResponse = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!tokenResponse.ok) {
    console.error("Etsy authorization-code exchange failed.", { status: tokenResponse.status });
    return oauthFailure("Etsy authorization could not be completed. Please try again.", 502);
  }

  let token;
  try {
    token = await tokenResponse.json();
  } catch {
    console.error("Etsy authorization response was not valid JSON.");
    return oauthFailure("Etsy authorization returned an invalid response.", 502);
  }

  if (!token.access_token || !token.refresh_token || !token.expires_in) {
    console.error("Etsy authorization response was missing required fields.");
    return oauthFailure("Etsy authorization returned incomplete credentials.", 502);
  }

  const userId = getUserIdFromAccessToken(token.access_token);
  const record = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + Number(token.expires_in) * 1000,
    userId,
    tokenType: token.token_type || "Bearer",
    scope: token.scope || "",
    shopId: null,
    shopName: null,
    updatedAt: Date.now(),
  };

  await env.ETSY_KV.put("etsy:oauth", JSON.stringify(record));

  try {
    const shop = await fetchOwnerShop(env, userId, token.access_token);
    if (shop?.shop_id) {
      record.shopId = shop.shop_id;
      record.shopName = shop.shop_name || null;
      await env.ETSY_KV.put("etsy:oauth", JSON.stringify(record));
    }
  } catch (error) {
    console.error("Etsy shop discovery failed after authorization.", { message: error?.message });
  }

  return new Response("ColorCity999 is now authorized with Etsy. You can close this page.", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": OAUTH_COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    },
  });
}

async function fetchOwnerShop(env, userId, accessToken) {
  const response = await fetch(
    "https://api.etsy.com/v3/application/users/" + encodeURIComponent(userId) + "/shops",
    {
      headers: {
        "x-api-key": getEtsyKeystring(env) + ":" + env.ETSY_SHARED_SECRET,
        Authorization: "Bearer " + accessToken,
        Accept: "application/json",
      },
    }
  );
  if (!response.ok) throw new Error("Shop discovery failed with status " + response.status + ".");
  const payload = await response.json();
  if (Array.isArray(payload)) return payload[0] || null;
  if (Array.isArray(payload?.results)) return payload.results[0] || null;
  return payload?.shop_id ? payload : null;
}

function getUserIdFromAccessToken(accessToken) {
  const separator = accessToken.indexOf(".");
  const userId = separator > 0 ? accessToken.slice(0, separator) : "";
  if (!/^\d+$/.test(userId)) throw new Error("Etsy access token did not contain a valid user ID.");
  return userId;
}

function getEtsyKeystring(env) {
  const value = env.ETSY_KEYSTRING;
  if (!value) throw Object.assign(new Error("Etsy application keystring is not configured."), { status: 503 });
  return value;
}

export function requireBridgeAuth(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw httpError(401, "Authentication required.");
  const supplied = authorization.slice(7).trim();
  if (!supplied || !timingSafeEqual(supplied, env.BRIDGE_API_SECRET)) {
    throw httpError(401, "Authentication failed.");
  }
}

function oauthFailure(message, status) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Base64Url(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(hash));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
