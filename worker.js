import { getAuthorizationUrl, handleOAuthCallback, requireBridgeAuth } from "./src/auth.js";
import { getConnectionStatus, getShop } from "./src/api.js";

const REDIRECT_URI = "https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/callback";
const SCOPES = "listings_r listings_w shops_r";

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
        return json(await getConnectionStatus(env));
      }

      if (url.pathname === "/api/shop") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        requireBridgeAuth(request, env);
        return json(await getShop(env));
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
