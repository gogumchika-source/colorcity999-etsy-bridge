import { etsyRequest, getValidAccessToken } from "./etsy.js";
import { getStagedAsset, deleteStagedAsset } from "./assets.js";

export async function getConnectionStatus(env, { allowRefresh = true } = {}) {
  const record = await env.ETSY_KV.get("etsy:oauth", { type: "json" });
  if (!record?.refreshToken || !record?.userId) return { connected: false, provider: "etsy" };

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
  } catch {
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
  await env.ETSY_KV.put("etsy:oauth", JSON.stringify({
    ...record,
    shopId: shop.shop_id,
    shopName: shop.shop_name || null,
    updatedAt: Date.now(),
  }));
  return shop;
}

export async function getListings(env, { allowRefresh = true, state = "active", limit = 25, offset = 0 } = {}) {
  const shop = await getShop(env, { allowRefresh });
  const safeLimit = clampInteger(limit, 1, 100, 25);
  const safeOffset = clampInteger(offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const params = new URLSearchParams({ state, limit: String(safeLimit), offset: String(safeOffset) });
  return fetchJson(await etsyRequest(
    env,
    "/shops/" + encodeURIComponent(shop.shop_id) + "/listings?" + params.toString(),
    { allowRefresh }
  ));
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
  if (maxCreatedSeconds <= minCreatedSeconds) throw httpError(400, "max_created must be later than min_created.");

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
  const payload = await fetchJson(await etsyRequest(
    env,
    "/shops/" + encodeURIComponent(shop.shop_id) + "/receipts?" + params.toString(),
    { allowRefresh }
  ));
  const receipts = Array.isArray(payload.results) ? payload.results : [];
  const totalCount = Number.isInteger(payload.count) ? payload.count : receipts.length;
  return {
    window: { minCreated: minCreatedSeconds, maxCreated: maxCreatedSeconds, timezone: "UTC" },
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
      items: Array.isArray(receipt.transactions) ? receipt.transactions.map((transaction) => ({
        listingId: transaction.listing_id ?? null,
        title: typeof transaction.title === "string" ? transaction.title : null,
        quantity: Number.isInteger(transaction.quantity) ? transaction.quantity : null,
        price: safeMoney(transaction.price),
      })) : [],
    })),
  };
}

export async function getListing(env, listingId, { allowRefresh = true } = {}) {
  const id = parseListingId(listingId);
  return fetchJson(await etsyRequest(env, "/listings/" + id, { allowRefresh }));
}

export async function createDigitalDraft(env, input, { allowRefresh = true } = {}) {
  const title = requireText(input.title, "title", 140);
  const description = requireText(input.description, "description", 5000);
  const price = Number(input.price);
  const taxonomyId = positiveInteger(input.taxonomyId, "taxonomy_id");
  const quantity = input.quantity === undefined ? 999 : positiveInteger(input.quantity, "quantity");
  const tags = input.tags === undefined ? [] : input.tags;
  if (!Array.isArray(tags) || tags.length > 13 || tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 20)) {
    throw httpError(400, "tags must contain up to 13 non-empty phrases of 20 characters or fewer.");
  }
  if (!Number.isFinite(price) || price <= 0 || Math.round(price * 100) !== price * 100) {
    throw httpError(400, "price must be a positive amount with no more than two decimal places.");
  }

  const shop = await getShop(env, { allowRefresh });
  const body = new URLSearchParams();
  body.set("quantity", String(quantity));
  body.set("title", title);
  body.set("description", description);
  body.set("price", price.toFixed(2));
  body.set("who_made", "i_did");
  body.set("when_made", "made_to_order");
  body.set("is_supply", "false");
  body.set("taxonomy_id", String(taxonomyId));
  body.set("type", "download");
  for (const tag of tags) body.append("tags[]", tag.trim());

  const listing = await fetchJson(await etsyRequest(
    env,
    "/shops/" + encodeURIComponent(shop.shop_id) + "/listings",
    { method: "POST", body, allowRefresh }
  ));
  const listingId = parseListingId(listing.listing_id);
  await env.ETSY_KV.put(
    "bridge:managed-listing:" + listingId,
    JSON.stringify({ shopId: shop.shop_id, createdAt: Date.now(), type: "download" })
  );
  return {
    listingId,
    shopId: shop.shop_id,
    title: listing.title || title,
    state: listing.state || "draft",
    type: listing.type || "download",
    url: listing.url || null,
  };
}

export async function uploadListingAsset(env, listingId, assetId, purpose, { allowRefresh = true, altText = "" } = {}) {
  const id = parseListingId(listingId);
  const managed = await getManagedListing(env, id);
  const shop = await getShop(env, { allowRefresh });
  if (String(managed.shopId) !== String(shop.shop_id)) throw httpError(403, "Listing does not belong to the connected shop.");
  const listing = await getListing(env, id, { allowRefresh });
  assertDraftListing(listing, id, shop.shop_id);

  if (purpose !== "image" && purpose !== "digital_file") throw httpError(400, "purpose must be image or digital_file.");
  const { metadata, object } = await getStagedAsset(env, assetId, purpose);
  const blob = new Blob([await object.arrayBuffer()], { type: metadata.contentType });
  const form = new FormData();
  if (purpose === "image") {
    form.append("image", blob, metadata.name);
    form.append("rank", "1");
    form.append("alt_text", typeof altText === "string" ? altText.slice(0, 500) : "");
  } else {
    form.append("file", blob, metadata.name);
    form.append("name", metadata.name);
    form.append("rank", "1");
  }
  const endpoint = "/shops/" + encodeURIComponent(shop.shop_id) + "/listings/" + id + (purpose === "image" ? "/images" : "/files");
  const response = await etsyRequest(env, endpoint, { method: "POST", body: form, allowRefresh });
  const uploaded = await fetchJson(response);
  await deleteStagedAsset(env, metadata);
  return {
    listingId: id,
    assetId,
    purpose,
    uploaded: true,
    etsyAssetId: uploaded.listing_image_id ?? uploaded.listing_file_id ?? uploaded.file_id ?? null,
    fileName: metadata.name,
  };
}

export async function publishDigitalListing(env, listingId, { allowRefresh = true } = {}) {
  const id = parseListingId(listingId);
  const managed = await getManagedListing(env, id);
  const shop = await getShop(env, { allowRefresh });
  if (String(managed.shopId) !== String(shop.shop_id)) throw httpError(403, "Listing does not belong to the connected shop.");
  const listing = await getListing(env, id, { allowRefresh });
  assertDraftListing(listing, id, shop.shop_id);

  const images = await fetchJson(await etsyRequest(env, "/shops/" + encodeURIComponent(shop.shop_id) + "/listings/" + id + "/images", { allowRefresh }));
  const files = await fetchJson(await etsyRequest(env, "/shops/" + encodeURIComponent(shop.shop_id) + "/listings/" + id + "/files", { allowRefresh }));
  if (extractResults(images).length < 1) throw httpError(409, "Add at least one preview image before publishing.");
  if (extractResults(files).length < 1) throw httpError(409, "Add at least one digital download file before publishing.");

  const body = new URLSearchParams({ state: "active" });
  const published = await fetchJson(await etsyRequest(
    env,
    "/shops/" + encodeURIComponent(shop.shop_id) + "/listings/" + id,
    { method: "PATCH", body, allowRefresh }
  ));
  return { listingId: id, title: published.title || listing.title || null, state: published.state || "active", url: published.url || null };
}

async function getManagedListing(env, listingId) {
  const managed = await env.ETSY_KV.get("bridge:managed-listing:" + listingId, { type: "json" });
  if (!managed?.shopId) throw httpError(403, "The bridge only uploads or publishes drafts it created.");
  return managed;
}

function assertDraftListing(listing, listingId, shopId) {
  if (String(listing.shop_id) !== String(shopId)) throw httpError(403, "Listing does not belong to the connected shop.");
  if (String(listing.state).toLowerCase() !== "draft") throw httpError(409, "Only a bridge-created Etsy draft can be changed by this action.");
}

function extractResults(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function requireText(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw httpError(400, name + " must be non-empty and at most " + maxLength + " characters.");
  }
  return value.trim();
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw httpError(400, name + " must be a positive integer.");
  return number;
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
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.amount) || !Number.isSafeInteger(value.divisor) || value.divisor <= 0) return null;
  return { amount: value.amount, divisor: value.divisor, currencyCode: typeof value.currency_code === "string" ? value.currency_code : null };
}

function parseListingId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(400, "listing_id must be a positive integer.");
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
  if (response.status === 204) return {};
  return response.json();
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
