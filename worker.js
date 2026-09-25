const REDIRECT_URI =
  "https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/callback";

const SCOPES = "listings_r listings_w shops_r";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("ColorCity999 Etsy Bridge is online!");
    }

    if (url.pathname === "/oauth/start") {
      return startOAuth(env);
    }

    if (url.pathname === "/oauth/callback") {
      return handleCallback(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function startOAuth(env) {
  const state = randomString(32);
  const verifier = randomString(64);

  const challenge = await sha256Base64Url(verifier);

  const oauthData = JSON.stringify({
    state,
    verifier,
  });

  const signature = await sign(oauthData, env.ETSY_SHARED_SECRET);

  const cookieValue =
    base64UrlEncode(oauthData) + "." + signature;

  const authUrl = new URL("https://www.etsy.com/oauth/connect");

  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env.ETSY_KEYSTRING);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie":
        `oauth_session=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

async function handleCallback(request, env) {
  const url = new URL(request.url);

  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return new Response(
      `Etsy authorization failed: ${error}\n${errorDescription || ""}`,
      { status: 400 }
    );
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");

  if (!code || !returnedState) {
    return new Response("Missing OAuth code or state.", { status: 400 });
  }

  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const session = cookies.oauth_session;

  if (!session) {
    return new Response(
      "OAuth session expired. Please start the connection again.",
      { status: 400 }
    );
  }

  const parts = session.split(".");

  if (parts.length !== 2) {
    return new Response("Invalid OAuth session.", { status: 400 });
  }

  const oauthData = base64UrlDecode(parts[0]);
  const signature = parts[1];

  const expectedSignature = await sign(
    oauthData,
    env.ETSY_SHARED_SECRET
  );

  if (!timingSafeEqual(signature, expectedSignature)) {
    return new Response("Invalid OAuth session signature.", {
      status: 400,
    });
  }

  const { state, verifier } = JSON.parse(oauthData);

  if (returnedState !== state) {
    return new Response("OAuth state mismatch.", { status: 400 });
  }

  const body = new URLSearchParams();

  body.set("grant_type", "authorization_code");
  body.set("client_id", env.ETSY_KEYSTRING);
  body.set("redirect_uri", REDIRECT_URI);
  body.set("code", code);
  body.set("code_verifier", verifier);

  const tokenResponse = await fetch(
    "https://api.etsy.com/v3/public/oauth/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  const tokenText = await tokenResponse.text();

  if (!tokenResponse.ok) {
    return new Response(
      `Etsy token exchange failed:\n\n${tokenText}`,
      { status: 500 }
    );
  }

  const token = JSON.parse(tokenText);

  return new Response(
    "SUCCESS!\n\nColorCity999 is now authorized with Etsy.\n\n" +
      "OAuth access token received successfully.\n" +
      "Do not share this page or its URL.",
    {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Set-Cookie":
          "oauth_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      },
    }
  );
}

function randomString(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function sha256Base64Url(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);

  return base64UrlEncode(
    String.fromCharCode(...new Uint8Array(hash))
  );
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );

  return base64UrlEncode(
    String.fromCharCode(...new Uint8Array(signature))
  );
}

function base64UrlEncode(value) {
  return btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);

  return atob(padded);
}

function parseCookies(cookieHeader) {
  const cookies = {};

  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    cookies[name] = value;
  }

  return cookies;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
