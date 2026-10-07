import test from "node:test";
import assert from "node:assert/strict";
import { getOrders } from "../src/api.js";

function makeEnv() {
  const record = {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: Date.now() + 60_000,
    userId: "12345",
    shopId: "98765",
    shopName: "ColorCity999",
  };
  return {
    ETSY_KEYSTRING: "test-key",
    ETSY_SHARED_SECRET: "test-secret",
    ETSY_KV: {
      get: async () => ({ ...record }),
      put: async () => {},
    },
  };
}

test("orders endpoint rejects missing, reversed, or invalid windows before making requests", async () => {
  const invalid = [
    { minCreated: null, maxCreated: "1791400000" },
    { minCreated: "1791400000", maxCreated: "1791300000" },
    { minCreated: "not-a-time", maxCreated: "1791400000" },
  ];
  for (const window of invalid) {
    await assert.rejects(
      getOrders(makeEnv(), window),
      (error) => error.status === 400
    );
  }
});

test("orders endpoint returns a bounded summary without buyer personal data", async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/shops/98765")) {
      return Response.json({ shop_id: 98765, shop_name: "ColorCity999" });
    }
    if (url.includes("/shops/98765/receipts?")) {
      return Response.json({
        count: 2,
        results: [{
          receipt_id: 24680,
          created_timestamp: 1791350000,
          status: "paid",
          is_paid: true,
          is_canceled: false,
          grandtotal: { amount: 999, divisor: 100, currency_code: "USD" },
          buyer_email: "private@example.test",
          name: "Private Buyer",
          formatted_address: "Private Address",
          message_from_buyer: "Private message",
          transactions: [{
            listing_id: 4561666517,
            title: "Cars Coloring Book",
            quantity: 1,
            price: { amount: 999, divisor: 100, currency_code: "USD" },
            buyer_user_id: 789,
          }],
        }],
      });
    }
    throw new Error("Unexpected mocked Etsy request.");
  };

  const result = await getOrders(makeEnv(), {
    minCreated: "1791300000",
    maxCreated: "1791400000",
    limit: "100",
    offset: "0",
  });

  assert.deepEqual(result.window, {
    minCreated: 1791300000,
    maxCreated: 1791400000,
    timezone: "UTC",
  });
  assert.equal(result.count, 2);
  assert.equal(result.hasMore, true);
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0].total, {
    amount: 999,
    divisor: 100,
    currencyCode: "USD",
  });
  assert.deepEqual(result.results[0].items[0], {
    listingId: 4561666517,
    title: "Cars Coloring Book",
    quantity: 1,
    price: { amount: 999, divisor: 100, currencyCode: "USD" },
  });
  for (const privateField of ["receipt_id", "buyer_email", "name", "formatted_address", "message_from_buyer"]) {
    assert.equal(Object.hasOwn(result.results[0], privateField), false);
  }
  assert.equal(Object.hasOwn(result.results[0].items[0], "buyer_user_id"), false);

  const ordersUrl = new URL(requestedUrls[1]);
  assert.equal(ordersUrl.searchParams.get("min_created"), "1791300000");
  assert.equal(ordersUrl.searchParams.get("max_created"), "1791400000");
  assert.equal(ordersUrl.searchParams.get("limit"), "100");
  assert.equal(ordersUrl.searchParams.get("offset"), "0");
});
