const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const TOKEN_KEY = "etsy:oauth";
const EXPIRY_SAFETY_SECONDS = 60;

export async function getValidAccessToken(env) {
  const record = await readTokenRecord(env);
  if (!record?.accessToken || !record?.refreshToken) throw httpError(503, "Etsy is not connected.");

  if (record.expiresAt > Date.now() + EXPIRY_SAFETY_SECONDS * 1000) {
    return record.accessToken;
  }

  return refreshAccessToken(env, record);
}

export async function etsyRequest(env, path, options = {}) {
  let accessToken = await getValidAccessToken(env);
  let response = await rawEtsyRequest(env, path, accessToken, options);

  if (response.status !== 401) return response;

  const latest = await readTokenRecord(env);
  if (!latest?.refreshToken) throw httpError(503, "Etsy is not connected.");

  if (latest.accessToken && latest.accessToken !== accessToken) {
    accessToken = latest.accessToken;
  } else {
    accessToken = await refreshAccessToken(env, latest);
  }

  response = await rawEtsyRequest(env, path, accessToken, options);
  if (response.status === 401) {
    console.error("Etsy API rejected the refreshed access token.", { path });
    throw httpError(502, "Etsy authorization was rejected.");
  }
  return response;
}

async function rawEtsyRequest(env, path, accessToken, options) {
  return fetch("https://api.etsy.com/v3/application" + path, {
    method: options.method || "GET",
    headers: {
      "x-api-key": env.ETSY_KEYSTRING + ":" + env.ETSY_SHARED_SECRET,
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body
      ? typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body)
      : undefined,
  });
}

async function refreshAccessToken(env, record) {
  const latest = await readTokenRecord(env);
  if (latest?.accessToken && latest.expiresAt > Date.now() + EXPIRY_SAFETY_SECONDS * 1000) {
    return latest.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.ETSY_KEYSTRING,
    refresh_token: latest?.refreshToken || record.refreshToken,
  });

  const response = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    console.error("Etsy refresh-token request failed.", { status: response.status });
    throw httpError(502, "Etsy authorization could not be refreshed.");
  }

  let token;
  try {
    token = await response.json();
  } catch {
    console.error("Etsy refresh-token response was not valid JSON.");
    throw httpError(502, "Etsy returned an invalid refresh response.");
  }

  if (!token.access_token || !token.refresh_token || !token.expires_in) {
    console.error("Etsy refresh-token response was incomplete.");
    throw httpError(502, "Etsy returned incomplete refresh credentials.");
  }

  const updated = {
    ...latest,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + Number(token.expires_in) * 1000,
    tokenType: token.token_type || "Bearer",
    scope: token.scope || latest?.scope || "",
    updatedAt: Date.now(),
  };

  await env.ETSY_KV.put(TOKEN_KEY, JSON.stringify(updated));
  return updated.accessToken;
}

async function readTokenRecord(env) {
  return env.ETSY_KV.get(TOKEN_KEY, { type: "json" });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
