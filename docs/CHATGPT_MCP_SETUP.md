# ChatGPT MCP bridge setup

This change adds a remote MCP endpoint for ChatGPT and a draft-first digital listing workflow. Before using it, configure an OAuth identity provider and grant the Etsy app listing-write permission.

## What the bridge exposes

Remote MCP endpoint:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev/mcp`

Protected resource metadata:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev/.well-known/oauth-protected-resource`

Tools:

- Read shop connection, listings, listing details, and PII-redacted orders.
- Search Etsy seller taxonomy and return usable category IDs.
- Create digital listings as drafts.
- Create a short-lived upload code, then stage preview images and PDF/ZIP files from the browser.
- Attach staged assets to drafts created by this bridge.
- Publish a draft only through a separate tool call after Etsy confirms it has at least one preview image and one downloadable file. Publishing requires the exact confirmation string `PUBLISH <listing_id>`.

The bridge does not delete or deactivate listings. Seller Stats (visits, views, favorites, traffic sources) are not included because this project does not have a verified Etsy API endpoint for those analytics.

## Required owner setup

Do not put secrets in GitHub, this document, or chat messages.

### 1. Configure OAuth for the ChatGPT MCP connection

Use an existing OAuth/OIDC provider or create a private Auth0 tenant. Configure it to:

- issue signed JWT access tokens using RS256;
- use a custom API audience, for example `https://colorcity999-etsy-bridge/api`;
- issue scopes `etsy:read`, `etsy:write`, and `etsy:publish`;
- issue refresh tokens for `offline_access`;
- allow only the ColorCity999 owner to sign in and receive the bridge permissions.

For Auth0, configure these Cloudflare Worker secrets:

- `MCP_AUTH_ISSUER`: the Auth0 tenant issuer, including its trailing slash;
- `MCP_AUTH_AUDIENCE`: the custom API audience.

The issuer and audience are optional for deployment but required when the MCP endpoint verifies tokens. Optionally set `MCP_ALLOWED_SUBJECT` to the exact owner subject identifier for an additional access check. Never send a token or client secret in chat.

When adding the custom MCP server in ChatGPT, configure OAuth with the provider's authorization and token endpoints, client credentials, and scopes. Add the exact redirect URI shown by ChatGPT to the provider's allowed callback URLs. Request `openid offline_access etsy:read etsy:write etsy:publish`. Confirm the provider issues refresh tokens and advertises offline access in discovery metadata.

### 2. Grant Etsy listing-write access

In the Etsy developer app, keep this callback registered:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/callback`

The bridge requests only:

`listings_r listings_w shops_r transactions_r`

After deploying the updated scope, the Etsy shop owner must visit `/oauth/start` and approve the new listing permission. Existing tokens do not gain scopes automatically.

### 3. Configure Cloudflare

Keep the existing Etsy and bridge secrets. Add `MCP_AUTH_ISSUER` and `MCP_AUTH_AUDIENCE` as Worker secrets. No additional storage resource is required; temporary listing assets use the existing `ETSY_KV` binding.

Temporary files are stored as binary Workers KV values, limited to 10,000,000 bytes per preview image and 20,000,000 bytes per PDF/ZIP. The binary and metadata keys expire after 24 hours, and successful Etsy uploads delete them immediately. Workers KV supports binary values up to 25 MiB, so these per-file limits fit within the service limit.

The repository deploy workflow deploys production when `main` changes. Review and merge only after CI passes and Cloudflare OAuth secrets are configured. Do not use a feature-branch build as a production deployment.

## Add the app to ChatGPT

On ChatGPT web, Business workspaces require an admin or owner to create and publish custom MCP apps. Enterprise/Edu access depends on workspace RBAC.

1. Open Plugins / Apps and add a custom MCP server.
2. Use the endpoint above and configure OAuth with the approved provider.
3. Scan the tools and review every read/write action.
4. Create and install the draft app. Publish it to the workspace only after the listing write actions are reviewed.
5. Ask the bridge to check the Etsy connection before creating a draft.

ChatGPT may display a confirmation prompt for write actions. The publish tool also requires an explicit confirmation phrase; do not call it for a draft unless the owner asked to publish that listing.

## Uploading a listing's product files

1. Ask ChatGPT to create an asset upload session.
2. Open the returned upload page, paste its short-lived code, choose preview image or digital file, and upload each asset.
3. Ask ChatGPT to list staged assets, create a digital draft, and attach the selected preview images and PDF/ZIP.
4. Review the draft in Etsy. To publish, explicitly ask ChatGPT and confirm `PUBLISH <listing_id>`.

Upload codes expire after 30 minutes. Unused staged files expire after 24 hours in KV. Each file is checked for type and size before staging. KV updates are eventually consistent, so if a newly uploaded file does not appear in the list tool yet, wait up to a minute and check again.

## Verification checklist

- [ ] PR CI passes.
- [ ] OAuth issuer, audience, scopes, and owner access policy are set.
- [ ] Etsy authorization has `listings_w`.
- [ ] Worker is deployed with the existing KV binding and required secrets.
- [ ] ChatGPT OAuth scan discovers the MCP tools and remains connected after token expiry.
- [ ] Read actions return real ColorCity999 data.
- [ ] Draft creation, staging, Etsy file/image upload, and publish are tested on a low-risk listing.
- [ ] The production app exposes only the reviewed actions.
