import { etsyRequest, getValidAccessToken } from "./etsy.js";

export async function getConnectionStatus(env, { allowRefresh = true } = {}) {
  const record = await env.ETSY_KV.get("etsy:oauth", { type: "json" });

  if (!record?.refreshToken || !record?.userId) {
    return { connected: false, provider: "etsy" };
  }

  try {
    const accessToken = await getValidAccessToken(env, { allowRefresh });
    let shopId = record.shopId || null;
    let shopName = record.shopName || null;

    if (shopId) {
      const shop = await fetchJson(await etsyRequest(env, "/shops/" + encodeURIComponent(shopId), { headers: {}, allowRefresh }));
      shopId = shop.shop_id || shopId;
      shopName = shop.shop_name || shopName;
    }

    return {
      connected: true,
      provider: "etsy",
      userId: record.userId,
      shopId,
      shopName,
      accessTokenExpiresAt: record.expiresAt,
      scope: record.scope || null,
      accessTokenValid: Boolean(accessToken),
    };
  } catch (error) {
    return {
      connected: false,
      provider: "etsy",
      userId: record.userId,
      shopId: record.shopId || null,
      error: "Etsy authorization is unavailable.",
    };
  }
}

export async function getShop(env, { allowRefresh = true } = {}) {
  const record = await env.ETSY_KV.get("etsy:oauth", { type: "json" });
  if (!record?.userId) throw httpError(503, "Etsy is not connected.");

  if (record.shopId) {
    return fetchJson(await etsyRequest(env, "/shops/" + encodeURIComponent(record.shopId), { allowRefresh }));
  }

  const payload = await fetchJson(
    await etsyRequest(env, "/users/" + encodeURIComponent(record.userId) + "/shops", { allowRefresh })
  );
  const shop = Array.isArray(payload) ? payload[0] : (payload && payload.results ? payload.results[0] : payload);

  if (!shop?.shop_id) throw httpError(404, "No Etsy shop was found for the connected account.");

  await env.ETSY_KV.put(
    "etsy:oauth",
    JSON.stringify({
      ...record,
      shopId: shop.shop_id,
      shopName: shop.shop_name || null,
      updatedAt: Date.now(),
    })
  );

  return shop;
}

export async function getListings(env, { allowRefresh = true, state = "active", limit = 25, offset = 0 } = {}) {
  const shop = await getShop(env, { allowRefresh });
  const safeLimit = clampInteger(limit, 1, 100, 25);
  const safeOffset = clampInteger(offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const params = new URLSearchParams({
    state,
    limit: String(safeLimit),
    offset: String(safeOffset),
  });

  return fetchJson(
    await etsyRequest(
      env,
      "/shops/" + encodeURIComponent(shop.shop_id) + "/listings?" + params.toString(),
      { allowRefresh }
    )
  );
}

export async function getListing(env, listingId, { allowRefresh = true } = {}) {
  const id = parseListingId(listingId);
  return fetchJson(await etsyRequest(env, "/listings/" + id, { allowRefresh }));
}

export async function updateListing(env, listingId, fields, { allowRefresh = true } = {}) {
  const id = parseListingId(listingId);
  const shop = await getShop(env, { allowRefresh });
  const existing = await getListing(env, id, { allowRefresh });

  if (String(existing.shop_id) !== String(shop.shop_id)) {
    throw httpError(403, "Listing does not belong to the connected Etsy shop.");
  }

  const payload = validateListingUpdate(fields);
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      for (const item of value) body.append(key, item);
    } else {
      body.append(key, String(value));
    }
  }

  return fetchJson(
    await etsyRequest(
      env,
      "/shops/" + encodeURIComponent(shop.shop_id) + "/listings/" + id,
      {
        method: "PATCH",
        body,
        allowRefresh,
      }
    )
  );
}

const ALLOWED_UPDATE_FIELDS = new Set([
  "title",
  "description",
  "tags",
  "state",
  "section_id",
  "taxonomy_id",
]);

function validateListingUpdate(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw httpError(400, "Request body must be a JSON object.");
  }

  const keys = Object.keys(fields);
  if (!keys.length) throw httpError(400, "At least one listing field is required.");

  for (const key of keys) {
    if (!ALLOWED_UPDATE_FIELDS.has(key)) {
      throw httpError(400, "Unsupported listing field: " + key);
    }
  }

  const output = {};

  if ("title" in fields) {
    if (typeof fields.title !== "string" || !fields.title.trim()) {
      throw httpError(400, "title must be a non-empty string.");
    }
    output.title = fields.title;
  }

  if ("description" in fields) {
    if (typeof fields.description !== "string") {
      throw httpError(400, "description must be a string.");
    }
    output.description = fields.description;
  }

  if ("tags" in fields) {
    if (!Array.isArray(fields.tags) || fields.tags.length > 13) {
      throw httpError(400, "tags must be an array with at most 13 items.");
    }
    for (const tag of fields.tags) {
      if (typeof tag !== "string" || !tag.trim() || tag.length > 20) {
        throw httpError(400, "Each tag must be a non-empty string of at most 20 characters.");
      }
    }
    output.tags = fields.tags;
  }

  if ("state" in fields) {
    if (!["active", "inactive"].includes(fields.state)) {
      throw httpError(400, "state must be active or inactive.");
    }
    output.state = fields.state;
  }

  for (const key of ["section_id", "taxonomy_id"]) {
    if (key in fields) {
      const value = Number(fields[key]);
      if (!Number.isInteger(value) || value < 1) {
        throw httpError(400, key + " must be a positive integer.");
      }
      output[key] = value;
    }
  }

  return output;
}

function parseListingId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw httpError(400, "listing_id must be a positive integer.");
  return id;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function fetchJson(response) {
  if (!response.ok) {
    console.error("Etsy API request failed.", { status: response.status });
    throw httpError(response.status === 401 ? 502 : response.status, "Etsy API request failed.");
  }
  return response.json();
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
