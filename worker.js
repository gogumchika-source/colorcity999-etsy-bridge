import { getAuthorizationUrl, handleOAuthCallback, requireBridgeAuth } from "./src/auth.js";
import { getConnectionStatus, getShop, getListings, getListing, getOrders } from "./src/api.js";

const REDIRECT_URI = "https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/callback";
const SCOPES = "listings_r shops_r transactions_r";

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/") {
        return json({ service: "ColorCity999 Etsy Bridge", status: "online" });
      }

      if (url.pathname === "/oauth/start") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        return getAuthorizationUrl(env, REDIRECT_URI, SCOPES);
      }

      if (url.pathname === "/oauth/callback") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        return handleOAuthCallback(request, env, { redirectUri: REDIRECT_URI });
      }

      if (url.pathname === "/api/status") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        requireBridgeAuth(request, env);
        const allowRefresh = request.headers.get("X-Bridge-No-Refresh") !== "true";
        return json(await getConnectionStatus(env, { allowRefresh }));
      }

      if (url.pathname === "/api/shop") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        requireBridgeAuth(request, env);
        const allowRefresh = request.headers.get("X-Bridge-No-Refresh") !== "true";
        return json(await getShop(env, { allowRefresh }));
      }

      if (url.pathname === "/api/orders") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        requireBridgeAuth(request, env);
        const allowRefresh = request.headers.get("X-Bridge-No-Refresh") !== "true";
        return json(await getOrders(env, {
          allowRefresh,
          minCreated: url.searchParams.get("min_created"),
          maxCreated: url.searchParams.get("max_created"),
          limit: url.searchParams.get("limit") ?? "100",
          offset: url.searchParams.get("offset") ?? "0",
        }));
      }

      if (url.pathname === "/api/listings") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        requireBridgeAuth(request, env);
        const allowRefresh = request.headers.get("X-Bridge-No-Refresh") !== "true";
        const state = url.searchParams.get("state") || "active";
        const limit = url.searchParams.get("limit") || "25";
        const offset = url.searchParams.get("offset") || "0";
        if (!["active", "inactive", "sold_out", "draft", "expired"].includes(state)) {
          return json({ error: "Invalid state." }, 400);
        }
        return json(await getListings(env, { allowRefresh, state, limit, offset }));
      }

      const listingMatch = url.pathname.match(/^\/api\/listings\/(\d+)$/);
      if (listingMatch) {
        requireBridgeAuth(request, env);
        const allowRefresh = request.headers.get("X-Bridge-No-Refresh") !== "true";
        const listingId = listingMatch[1];

        if (request.method === "GET") {
          return json(await getListing(env, listingId, { allowRefresh }));
        }

        return json({ error: "Method not allowed" }, 405);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return toErrorResponse(error);
    }
  },
};

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function toErrorResponse(error) {
  const status = error?.status ?? 500;
  const safeMessage = status >= 500 ? "Internal server error." : error?.message || "Request failed.";
  return json({ error: safeMessage }, status);
}
