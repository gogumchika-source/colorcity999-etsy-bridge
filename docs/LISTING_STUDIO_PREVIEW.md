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
