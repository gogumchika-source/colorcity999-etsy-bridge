import { etsyRequest, getValidAccessToken } from "./etsy.js";

export async function getConnectionStatus(env) {
  const record = await env.ETSY_KV.get("etsy:oauth", { type: "json" });

  if (!record?.refreshToken || !record?.userId) {
    return { connected: false, provider: "etsy" };
  }

  try {
    const accessToken = await getValidAccessToken(env);
    let shopId = record.shopId || null;
    let shopName = record.shopName || null;

    if (shopId) {
      const shop = await fetchJson(await etsyRequest(env, "/shops/" + encodeURIComponent(shopId), { headers: {} }));
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

export async function getShop(env) {
  const record = await env.ETSY_KV.get("etsy:oauth", { type: "json" });
  if (!record?.userId) throw httpError(503, "Etsy is not connected.");

  if (record.shopId) {
    return fetchJson(await etsyRequest(env, "/shops/" + encodeURIComponent(record.shopId)));
  }

  const shop = await fetchJson(
    await etsyRequest(env, "/users/" + encodeURIComponent(record.userId) + "/shops")
  );

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
