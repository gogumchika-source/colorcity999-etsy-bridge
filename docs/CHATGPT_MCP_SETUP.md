# ChatGPT MCP bridge setup

This change adds a remote MCP endpoint for ChatGPT and a draft-first digital listing workflow. It is not ready to deploy until the identity provider, R2 bucket, and Etsy write permission are configured.

## What the bridge exposes

Remote MCP endpoint:

\`https://colorcity999-etsy-bridge.gogumchika.workers.dev/mcp\`

Protected resource metadata:

\`https://colorcity999-etsy-bridge.gogumchika.workers.dev/.well-known/oauth-protected-resource\`

Tools:

- Read shop connection, listings, listing details, and PII-redacted orders.
- Create digital listings as drafts.
- Create a short-lived upload code, then upload preview images and PDF/ZIP files through the staging page.
- Upload staged assets to a draft created by this bridge.
- Publish a draft only through a separate tool call after it has at least one preview image and one downloadable file. Publishing requires the exact confirmation string \`PUBLISH <listing_id>\`.

The bridge does not delete or deactivate listings. Seller Stats (visits, views, favorites, traffic sources) are not included because the current Etsy API access in this project does not provide a verified endpoint for those analytics.

## Required owner setup

Do not put secrets in GitHub, this document, or chat messages.

### 1. Create the temporary asset bucket

Create an R2 bucket named:

\`colorcity999-etsy-staging-assets\`

The Wrangler binding is \`ETSY_ASSETS\`. Add an R2 lifecycle rule to delete objects under \`staging/\` after one day. The bridge also deletes an asset immediately after Etsy accepts it, but this rule removes abandoned uploads.

### 2. Configure OAuth for the ChatGPT MCP connection

Use an existing OAuth/OIDC provider or create a private Auth0 tenant. Configure it to:

- issue signed JWT access tokens using RS256;
- use a custom API audience, for example \`https://colorcity999-etsy-bridge/api\`;
- issue scopes \`etsy:read\`, \`etsy:write\`, and \`etsy:publish\`;
- issue refresh tokens for \`offline_access\`;
- allow only the ColorCity999 owner to sign in and receive the three bridge permissions.

For Auth0, the values entered into Cloudflare are:

- \`MCP_AUTH_ISSUER\`: the Auth0 tenant issuer, including its trailing slash;
- \`MCP_AUTH_AUDIENCE\`: the custom API audience.

Set both as Cloudflare Worker secrets. Optionally set \`MCP_ALLOWED_SUBJECT\` to the exact owner subject identifier for a second access check. Never send a token or client secret to the bridge developer in chat.

When adding the custom MCP server in ChatGPT, configure OAuth with that provider's authorization and token endpoints, client credentials, and scopes. Add the exact redirect URI shown by ChatGPT to the provider's allowed callback URLs. Request \`openid offline_access etsy:read etsy:write etsy:publish\`. Confirm that discovery metadata advertises refresh/offline access.

Temporary files are stored as binary Workers KV values, limited to 10 MB per preview image and 20 MB per PDF/ZIP. Both the binary and metadata keys expire after 24 hours, and successful Etsy uploads delete them immediately. Cloudflare KV supports binary values up to 25 MiB, so the configured limits fit within that service limit.

### 2. Grant Etsy listing-write access

In the Etsy developer app, keep this callback registered:

\`https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/callback\`

The bridge requests only:

\`listings_r listings_w shops_r transactions_r\`

After deploying the updated scope, the Etsy shop owner must visit \`/oauth/start\` and approve the new listing permission. Existing tokens do not gain scopes automatically.

### 4. Configure Cloudflare

Keep the existing Etsy and bridge secrets. Add \`MCP_AUTH_ISSUER\` and \`MCP_AUTH_AUDIENCE\` as Worker secrets. Ensure the R2 bucket binding exists before deploying.

The current repository deploy workflow deploys production when \`main\` changes. Review and merge the change only after CI passes and the owner has configured the required Cloudflare resources and secrets. Do not run a production deployment from a feature branch.

## Add the app to ChatGPT

On ChatGPT web, a Business workspace requires an admin or owner to create and publish custom MCP apps. Enterprise/Edu permissions depend on workspace RBAC.

1. Open Plugins / Apps and add a custom MCP server.
2. Use the endpoint above and configure OAuth with the approved provider.
3. Scan the tools and review every read/write action.
4. Create and install the draft app. Publish it to the workspace only after the listing write actions are reviewed.
5. Ask the bridge to check the Etsy connection before creating a draft.

ChatGPT may display a confirmation prompt for write actions. The publish tool also requires an explicit confirmation phrase; do not call it for a draft unless the owner asked to publish that listing.

## Uploading a listing's product files

1. Ask ChatGPT to create an asset upload session.
2. Open the returned upload page, paste its one-time code, choose preview image or digital file, and upload each asset.
3. Ask ChatGPT to list staged assets, create a digital draft, and attach the selected preview images and PDF/ZIP.
4. Review the draft in Etsy. To publish, explicitly ask ChatGPT and confirm \`PUBLISH <listing_id>\`.

Upload codes expire after 30 minutes. Unused staged files expire after 24 hours in KV and are removed from R2 by the lifecycle rule. Each file is checked for type and size before staging.

## Verification checklist

- [ ] PR CI passes.
- [ ] Auth0/OIDC issuer, audience, scopes, and owner access policy are set.
- [ ] Etsy authorization has \`listings_w\`.
- [ ] Worker is deployed with secrets and bindings.
- [ ] ChatGPT OAuth scan discovers the MCP tools and remains connected after token expiry.
- [ ] Read actions return real ColorCity999 data.
- [ ] Draft creation, staging, Etsy file/image upload, and publish are tested on a low-risk listing.
- [ ] The production app exposes only the reviewed actions.
