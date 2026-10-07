# ColorCity999 Etsy Bridge

Production foundation for the ColorCity999 Etsy integration running on Cloudflare Workers.

## Architecture

The bridge is a Cloudflare Worker that:

1. Authenticates the ColorCity999 Etsy account with OAuth 2.0 Authorization Code + PKCE.
2. Stores Etsy access and refresh tokens in Cloudflare Workers KV.
3. Refreshes expired access tokens automatically and stores the newly returned refresh token.
4. Provides a reusable Etsy API request layer.
5. Exposes protected bridge endpoints for connection status and shop data.
6. Keeps Etsy credentials and bridge credentials out of Git and HTTP responses.

Source layout:

- `worker.js` — HTTP routing and top-level error handling.
- `src/auth.js` — Etsy OAuth Authorization Code + PKCE and bridge authentication.
- `src/etsy.js` — token validation/refresh and reusable Etsy API requests.
- `src/api.js` — protected bridge API operations.
- `wrangler.jsonc` — Cloudflare Worker and KV configuration.

No runtime dependencies are required.

## URLs

Production Worker:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev`

OAuth start:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/start`

OAuth callback:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/callback`

Protected API:

- `GET /api/status`
- `GET /api/shop`
- `GET /api/orders?min_created=<unix-seconds>&max_created=<unix-seconds>&limit=100&offset=0` (requires `transactions_r`; returns a bounded, PII-redacted summary)

## Cloudflare setup

### 1. Workers KV

The Worker requires a KV binding named `ETSY_KV`.

The repository intentionally does not contain a namespace ID. Wrangler supports automatic resource provisioning for bindings without IDs. Alternatively, create the namespace in Cloudflare and add its real ID to the binding before deployment.

CLI option:

`npx wrangler kv namespace create ETSY_KV`

Do not invent or fabricate a KV namespace ID.

Cloudflare KV is eventually consistent. This bridge stores one Etsy credential record and is designed for low-frequency credential writes. If future automation needs high-frequency concurrent writes or strict atomic refresh coordination, use a Durable Object for credential coordination rather than simulating transactions with KV.

### 2. Worker secrets

Configure these as Cloudflare Worker secrets. Never put their values in Git.

- `ETSY_KEYSTRING` — Etsy application keystring/client ID.
- `ETSY_SHARED_SECRET` — Etsy application shared secret.
- `BRIDGE_API_SECRET` — a new, independently generated high-entropy secret for `/api/*`.

Examples:

`npx wrangler secret put ETSY_KEYSTRING`

`npx wrangler secret put ETSY_SHARED_SECRET`

`npx wrangler secret put BRIDGE_API_SECRET`

Use different values for all three secrets.

### 3. Etsy application callback

Register this exact OAuth callback in the Etsy developer application:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/callback`

The existing scopes are preserved:

`listings_r listings_w shops_r`

They should not be broadened without a concrete feature requirement.

## Deploy

From the repository:

`npx wrangler deploy`

Before deployment, ensure the KV binding and required secrets exist.

## OAuth connection

Open:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/start`

The Worker creates a random OAuth state and PKCE verifier, signs a short-lived OAuth session cookie, and redirects to Etsy.

After Etsy redirects back:

1. The callback validates the signed state and PKCE session.
2. The authorization code is exchanged server-side.
3. Access and refresh tokens are stored in KV.
4. The Etsy user ID is obtained from the access-token prefix.
5. The Worker attempts to discover the user's shop and stores its shop ID.
6. The browser receives only a generic success message.

Raw Etsy token-exchange response bodies are never returned to the browser.

## Protected API authentication

All `/api/*` endpoints require:

`Authorization: Bearer <BRIDGE_API_SECRET>`

Example:

`curl -H "Authorization: Bearer $BRIDGE_API_SECRET" https://colorcity999-etsy-bridge.gogumchika.workers.dev/api/status`

Never put the bridge secret in a URL query string.

### GET /api/status

Returns non-secret connection metadata such as:

- connection state;
- Etsy user ID;
- stored shop ID/name when known;
- access-token expiry timestamp;
- granted OAuth scopes.

It never returns access or refresh tokens.

### GET /api/shop

Returns the connected Etsy shop resource from Etsy.

It never returns the OAuth credentials used to retrieve it.

### GET /api/orders

Returns receipts only for the requested Unix timestamp window. Both `min_created` and `max_created` are required. The page size is 1 to 100. The response includes order status, timestamps, totals, and listing line items while excluding buyer names, email addresses, mailing addresses, and message text.

## Token refresh

Etsy access tokens are short-lived. Before an Etsy request, the bridge checks the stored expiry with a safety window. When the token is expired or close to expiry, it performs a refresh grant.

Etsy returns a new access token and refresh token. The bridge stores both, preserving refresh-token rotation.

If an Etsy API request returns HTTP 401, the bridge re-reads the latest credential record and either uses a newer token already stored by another request or refreshes before retrying once.

Workers KV is eventually consistent. This handles the expected single-shop, low-concurrency case without adding unnecessary infrastructure. A future multi-tenant/high-concurrency version should use a Durable Object for refresh coordination.

## Security

- No OAuth tokens are committed to Git.
- No Etsy shared secret is committed to Git.
- No bridge API secret is committed to Git.
- OAuth callback errors do not expose Etsy token-exchange response bodies.
- Bridge API authentication uses a dedicated secret and constant-time comparison.
- OAuth session cookies are HttpOnly, Secure, SameSite=Lax, and short-lived.
- API responses are marked `Cache-Control: no-store`.
- The bridge never returns OAuth access or refresh tokens.
- Keep `.env`, `.dev.vars`, token dumps, Cloudflare credentials, and secret-bearing logs out of Git.

## Phase 1 acceptance checklist

- [ ] Create/bind the `ETSY_KV` namespace.
- [ ] Configure `ETSY_KEYSTRING`.
- [ ] Configure `ETSY_SHARED_SECRET`.
- [ ] Generate and configure `BRIDGE_API_SECRET`.
- [ ] Register the exact Etsy callback URL.
- [ ] Deploy the Worker.
- [ ] Open `/oauth/start` and authorize ColorCity999.
- [ ] Verify `/api/status` with the bridge secret.
- [ ] Verify `/api/shop` with the bridge secret.
- [ ] Confirm credentials never appear in GitHub or HTTP responses.

## Security warning

This repository is public. That is compatible with the architecture only because real credentials are stored as Cloudflare secrets and OAuth tokens are stored in Cloudflare KV. If a credential is ever committed, rotate it immediately.
