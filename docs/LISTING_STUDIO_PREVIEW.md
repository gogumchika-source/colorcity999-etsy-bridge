# ColorCity999 Listing Studio — preview branch

**Scope: development-only test version. No Etsy writes and no production deployment.**

## What this branch implements

- New private-facing GET /studio HTML interface; submit one ZIP up to 20 MB.
- POST /studio/preview accepts ZIP bytes, expands one original PDF plus 1–10 JPG/PNG/WebP preview images, returns file manifest and first small preview image. Nothing is persisted.
- Rejects encrypted, unsupported, truncated, ZIP64, unsafe-path, oversized or malformed archives; validates CRC and basic asset signatures. Total decompressed assets are bounded.
- Uses Workers AI to generate a candidate Etsy title, truthful description and exactly 13 unique tags (20 characters max). Model output is validated and retry-on-invalid. Metadata is derived only from names and the optional title; it cannot verify page count or actual contents.
- Returns an editable-*in-future* listing preview. No Etsy drafts, upload calls, state updates or publishing controls are present.
- Authenticates *every* Studio request using a verified Cloudflare Access JWT, exact audience, owner email, expiry and RS256 signature. This is separate from legacy API and MCP authentication. No user access is granted in this branch until configured.
- Existing MCP, Etsy API and production routes are left intact.

## Deployment stays blocked pending separate owner approval

Do NOT merge this branch or configure production based only on these tests.
Never expose secrets in GitHub or chat.

Before deploying a preview:
1. Configure a Cloudflare Access application protecting /studio and /studio/preview; Access policy must allow only the owner.
2. Set Worker config: STUDIO_ENABLED=preview, STUDIO_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com, STUDIO_ACCESS_AUD=<Access application audience>, STUDIO_ALLOWED_EMAIL=<verified owner email>. Keep owner identity private; do not commit real values.
3. Add a Workers AI binding named AI if approved. It has potential usage costs; confirm limits first.
4. Confirm owner-only access and negative tests before uploading personal or sellable assets.
5. Verify Workers AI output with a sample ZIP, then review SEO and sample cover. Preview is not a listing.
6. Verify Etsy listings_w scope separately before extending the feature to a real draft.
7. Add a separate draft/upload/publish phase after explicit owner review. Reuse the existing draft-first API, preserving the PUBLISH <listing_id> approval gate.

## Safe development testing

Run: npm test

The tests create an in-memory, minimal original PDF and PNG and a stored ZIP archive. They exercise ZIP extraction, path rejection, metadata validation and preview responses with a mocked Workers AI binding. No external Etsy, Auth0, Cloudflare or AI network calls are made by the tests.

## Limits and known gaps

- Not yet deployed; cannot be used in production.
- The preview is NOT an Etsy draft; no file is uploaded to Etsy.
- Workers AI is not configured on production by this change; live AI output is unverified.
- Deflated ZIP entries require runtime support for DecompressionStream("deflate-raw"); stored ZIP entries are fully covered by automated tests.
- ZIP artwork integrity is checked only using basic signatures; true PDF/image rendering and copyright/asset-quality checks require manual review.
- Actual SEO relevance and listing category are not yet verified against Etsy taxonomy. Price is defaulted to $9.99.
- All source material stays in memory for one request and is not retained as a staged upload. A later draft workflow must add guarded temporary storage and idempotent retries.
- Do not use the legacy /assets/upload route for Studio automatically; it is a separate MCP workflow.


## Step 5 — Owner access and Etsy write-grant readiness (November 5, 2026)

ChatGPT Plus workflow uses Cloudflare Access for private Studio login. It does not depend on the separate Auth0/ChatGPT MCP setup.

### Development preview: isolated Worker
The branch includes wrangler.studio-preview.jsonc with a separate Worker name, Workers AI binding, and STUDIO_ENABLED=preview. This isolated Worker has NO production ETSY_KV binding and NO existing Etsy/bridge secrets. It cannot publish or read production OAuth tokens.

Owner-approved setup steps, NOT performed here:
1. In Cloudflare, enable Zero Trust, then use a verified account.
2. Only after explicit deployment approval, deploy the distinct preview Worker using: wrangler deploy --config wrangler.studio-preview.jsonc
3. Workers & Pages > colorcity999-listing-studio-preview > Access > Protect this Worker behind Access > All traffic.
4. Allow exactly the verified owner's email in an Access policy; do not permit a whole email domain or all account members.
5. Obtain the actual Cloudflare Access team domain and Access application audience. Set STUDIO_ACCESS_TEAM_DOMAIN, STUDIO_ACCESS_AUD and STUDIO_ALLOWED_EMAIL securely for the preview Worker. Do not commit real owner details or secrets.
6. Check denied anonymous access and denied non-owner access. The Worker also verifies the Access JWT signature and audience.
7. Authenticate as owner, open /studio and /studio/ready, and test a harmless ZIP. The preflight will report Etsy write scope UNVERIFIED because this separate preview Worker intentionally has no production KV.

### Etsy listings_w — existing production Worker
The development branch updates the existing GitHub bridge-health workflow to log only the boolean listing-write permission (granted, missing or not verified) from the protected /api/status response. It never outputs tokens, full scopes, or owner identity. This Action update will NOT run in production until separately approved and merged. Main pushes also deploy production automatically.

If the protected status proves listings_w is missing, the shop owner must complete Etsy consent themselves at:
https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/start

Do not paste OAuth codes, cookies, access tokens or bridge API secrets. The OAuth callback implementation now reports the permission actually granted, not just requested; that code is also NOT deployed yet.

### Remaining deliberate gates
- Workers AI can create SEO candidates, but has only been unit-tested using mocked model responses; live inference and costs are not verified.
- The isolated preview does not create Etsy drafts or upload real files.
- Publishing requires a future reviewed draft/upload integration, idempotency safeguards and separate approval.
- When Studio moves into the current production Worker, Access must protect ONLY Studio paths (/studio, /studio/preview, /studio/ready), not the whole Worker. Protecting the whole current Worker could break OAuth callbacks and GitHub health checks.
- Studio's current ZIP limit is 20 MB; larger files require controlled upload improvements.
