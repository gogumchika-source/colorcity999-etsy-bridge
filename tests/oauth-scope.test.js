import test from "node:test";
import assert from "node:assert/strict";
import { getAuthorizationUrl, handleOAuthCallback } from "../src/auth.js";

const callbackUri = "https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/callback";

async function simulateEtsyAuthorization(t, grantedScopes, shopDiscoveryOK = true) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const writes = [];
  const env = {
    ETSY_KEYSTRING: "test-keystring",
    ETSY_SHARED_SECRET: "test-shared-secret",
    ETSY_KV: { put: async (key, record) => writes.push({ key, record: JSON.parse(record) }) }
  };
  const start = await getAuthorizationUrl(env, callbackUri, "listings_r listings_w shops_r transactions_r");
  assert.equal(start.status, 302);
  const connect = new URL(start.headers.get("Location"));
  const cookie = start.headers.get("Set-Cookie").split(";")[0];
  const state = connect.searchParams.get("state");
  const code = "test-code-not-real";
  globalThis.fetch = async input => {
    const u = String(input);
    if (u === "https://api.etsy.com/v3/public/oauth/token") {
      return Response.json({
        access_token: "12345.fake-access-token", refresh_token: "12345.fake-refresh-token",
        token_type: "Bearer", expires_in: 3600, scope: grantedScopes
      });
    }
    if (u.endsWith("/users/12345/shops")) {
      if (!shopDiscoveryOK) return new Response("Service unavailable", { status: 503 });
      return Response.json({ results: [{ shop_id: 51212373, shop_name: "ColorCity999" }] });
    }
    throw new Error("Unexpected mocked external request");
  };
  const response = await handleOAuthCallback(new Request(callbackUri + "?code=" + code + "&state=" + state, {
    headers: { Cookie: cookie }
  }), env, { redirectUri: callbackUri });
  return { status: response.status, html: await response.text(), writes };
}

test("OAuth callback reports confirmed Etsy listings_w only when actually granted", async t => {
  const result = await simulateEtsyAuthorization(t, "listings_r listings_w shops_r transactions_r");
  assert.equal(result.status, 200);
  assert.match(result.html, /Etsy listings_w grant confirmed/);
  assert.match(result.html, /Shop API responded/);
  assert.equal(result.writes.at(-1).record.scope.includes("listings_w"), true);
  assert.equal(result.html.includes("fake-access-token"), false);
});
test("OAuth callback reports missing scope, even if originally requested by bridge", async t => {
  const result = await simulateEtsyAuthorization(t, "listings_r shops_r transactions_r");
  assert.equal(result.status, 200);
  assert.match(result.html, /Etsy listings_w grant missing or unverified/);
  assert.doesNotMatch(result.html, /Etsy listings_w grant confirmed/);
});
test("OAuth callback does not falsely claim shop verification when discovery fails", async t => {
  const result = await simulateEtsyAuthorization(t, "listings_r listings_w shops_r transactions_r", false);
  assert.equal(result.status, 200);
  assert.match(result.html, /Shop discovery was not completed/);
  assert.doesNotMatch(result.html, /Shop API responded/);
});
