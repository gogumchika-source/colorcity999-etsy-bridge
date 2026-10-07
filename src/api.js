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

    const shop = shopId
      ? await fetchJson(await etsyRequest(env, "/shops/" + encodeURIComponent(shopId), { headers: {}, allowRefresh }))
      : await getShop(env, { allowRefresh });
    shopId = shop.shop_id || shopId;
    shopName = shop.shop_name || shopName;

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

export async function getOrders(env, {
  allowRefresh = true,
  minCreated,
  maxCreated,
  limit = "100",
  offset = "0",
} = {}) {
  const minCreatedSeconds = parseRequiredTimestamp(minCreated, "min_created");
  const maxCreatedSeconds = parseRequiredTimestamp(maxCreated, "max_created");
  if (maxCreatedSeconds <= minCreatedSeconds) {
    throw httpError(400, "max_created must be later than min_created.");
  }

  const safeLimit = parseBoundedInteger(limit, "limit", 1, 100);
  const safeOffset = parseBoundedInteger(offset, "offset", 0, 12000);
  const shop = await getShop(env, { allowRefresh });
  const params = new URLSearchParams({
    min_created: String(minCreatedSeconds),
    max_created: String(maxCreatedSeconds),
    limit: String(safeLimit),
    offset: String(safeOffset),
    sort_on: "created",
    sort_order: "asc",
  });
  const payload = await fetchJson(
    await etsyRequest(
      env,
      "/shops/" + encodeURIComponent(shop.shop_id) + "/receipts?" + params.toString(),
      { allowRefresh }
    )
  );
  const receipts = Array.isArray(payload.results) ? payload.results : [];
  const totalCount = Number.isInteger(payload.count) ? payload.count : receipts.length;

  return {
    window: {
      minCreated: minCreatedSeconds,
      maxCreated: maxCreatedSeconds,
      timezone: "UTC",
    },
    count: totalCount,
    limit: safeLimit,
    offset: safeOffset,
    hasMore: safeOffset + receipts.length < totalCount,
    results: receipts.map((receipt) => ({
      createdTimestamp: receipt.created_timestamp ?? receipt.create_timestamp ?? null,
      status: typeof receipt.status === "string" ? receipt.status : null,
      paid: typeof receipt.is_paid === "boolean" ? receipt.is_paid : null,
      canceled: typeof receipt.is_canceled === "boolean" ? receipt.is_canceled : null,
      total: safeMoney(receipt.grandtotal),
      items: Array.isArray(receipt.transactions)
        ? receipt.transactions.map((transaction) => ({
            listingId: transaction.listing_id ?? null,
            title: typeof transaction.title === "string" ? transaction.title : null,
            quantity: Number.isInteger(transaction.quantity) ? transaction.quantity : null,
            price: safeMoney(transaction.price),
          }))
        : [],
    })),
  };
}

function parseRequiredTimestamp(value, name) {
  const parsed = Number(value);
  if (typeof value !== "string" || !value || String(parsed) !== value || !Number.isSafeInteger(parsed) || parsed < 946684800) {
    throw httpError(400, name + " must be a supported Unix timestamp in seconds.");
  }
  return parsed;
}

function parseBoundedInteger(value, name, min, max) {
  const parsed = Number(value);
  if (typeof value !== "string" || !value || String(parsed) !== value || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw httpError(400, name + " is outside the supported integer range.");
  }
  return parsed;
}

function safeMoney(value) {
  if (!value || typeof value !== "object") return null;
  if (!Number.isSafeInteger(value.amount) || !Number.isSafeInteger(value.divisor) || value.divisor <= 0) {
    return null;
  }
  return {
    amount: value.amount,
    divisor: value.divisor,
    currencyCode: typeof value.currency_code === "string" ? value.currency_code : null,
  };
}

export async function getListing(env, listingId, { allowRefresh = true } = {}) {
  const id = parseListingId(listingId);
  return fetchJson(await etsyRequest(env, "/listings/" + id, { allowRefresh }));
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
