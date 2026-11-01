# ChatGPT MCP bridge setup

This change adds a remote MCP endpoint for ChatGPT and a draft-first digital listing workflow. Before it can work, configure an OAuth identity provider and grant the Etsy app listing-write permission.

## What the bridge exposes

Remote MCP endpoint:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev/mcp`

Protected-resource metadata:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev/.well-known/oauth-protected-resource`

Available tools:

- Read shop connection, listings, listing details, and PII-redacted orders.
- Search Etsy seller taxonomy and return category IDs.
- Create digital listings as drafts.
- Create a short-lived upload code, then stage preview images and PDF/ZIP files through a browser upload page.
- Attach staged assets to drafts created by this bridge.
- Publish a draft through a separate tool call after Etsy confirms it has a preview image and downloadable file. The call requires the exact phrase `PUBLISH <listing_id>`.

The bridge does not delete or deactivate listings. Etsy Seller Stats (visits, views, favorites, traffic sources) are not exposed because this bridge has no verified Etsy API route for those analytics.

## Owner setup

Never put secrets or tokens in GitHub, this document, or chat messages.

### 1. Configure an OAuth/OIDC provider

Use an OAuth/OIDC provider that issues RS256-signed JWT access tokens and refresh tokens. Auth0 is one option.

For Auth0:

1. Create an Auth0 API with identifier exactly:
   `https://colorcity999-etsy-bridge.gogumchika.workers.dev/mcp`
   This must match the bridge's advertised `resource` URL and the JWT access token's `aud` claim.
2. Enable the API permissions `etsy:read`, `etsy:write`, and `etsy:publish`.
3. Enable Auth0's **Resource Parameter Compatibility Profile** under Tenant Settings > Advanced. ChatGPT sends the MCP resource indicator; Auth0 must map that `resource` value to the API audience. Without this option, Auth0 may issue an opaque or wrong-audience token and the bridge will reject it.
4. Enable refresh-token / offline access for the ChatGPT OAuth application. Check that the issuer's discovery document advertises `offline_access`.
5. Restrict sign-in to the ColorCity999 owner account. Grant `etsy:read` for reading, `etsy:write` for drafts and file uploads, and `etsy:publish` only for an owner-authorized publish action.
6. In the Auth0 application, allow the exact callback URL ChatGPT displays when you configure the connection. Do not guess or reuse the Etsy callback; the ChatGPT OAuth callback is different.

Configure these Cloudflare Worker secrets:

- `MCP_AUTH_ISSUER`: the Auth0 issuer URL, including its trailing slash.
- `MCP_AUTH_AUDIENCE`: `https://colorcity999-etsy-bridge.gogumchika.workers.dev/mcp`
- Optional `MCP_ALLOWED_SUBJECT`: the exact owner subject identifier for an additional account restriction.

The issuer and audience are optional for deploying the code but required for authenticated MCP requests. Never send the Auth0 client secret or a token in chat.

When configuring the ChatGPT app, choose OAuth and request `openid offline_access etsy:read etsy:write etsy:publish`. Confirm the provider issues a refresh token so the connection can remain active.

### 2. Grant Etsy listing-write access

Keep this exact callback registered in the Etsy developer app:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/callback`

The bridge requests `listings_r listings_w shops_r transactions_r`. After deploying this change, the Etsy shop owner must visit:

`https://colorcity999-etsy-bridge.gogumchika.workers.dev/oauth/start`

Then approve the new Etsy listing permission. Existing Etsy tokens do not gain `listings_w` automatically.

### 3. Configure Cloudflare and deploy

Keep the existing Etsy and bridge secrets. Add `MCP_AUTH_ISSUER` and `MCP_AUTH_AUDIENCE` as Worker secrets. Temporary upload files use the existing `ETSY_KV` binding; no additional storage resource is required.

Files are limited to 10,000,000 bytes per preview image and 20,000,000 bytes per PDF/ZIP. Staged files expire after 24 hours and are deleted after successful Etsy upload. Workers KV is eventually consistent; if an upload does not appear immediately, wait up to a minute and check again.

The production deploy workflow runs when `main` changes. Merge after CI passes and the two OAuth secrets are configured. A feature-branch preview is not a production deployment.

### 4. Add the app in ChatGPT

Custom MCP connections and write actions are available on ChatGPT Business, Enterprise, and Edu web workspaces. On Business, only workspace admins/owners can create and publish these custom apps. Enterprise/Edu admins control member permissions through RBAC.

1. Open the workspace's Plugins/Apps settings and add a custom MCP server.
2. Set the MCP endpoint to `https://colorcity999-etsy-bridge.gogumchika.workers.dev/mcp`.
3. Choose OAuth; enter the approved provider endpoints and client credentials. Add the exact ChatGPT callback from that screen to the provider's allowed callback URLs.
4. Scan the tools, review read/write/publish actions, then create the app. Publish it to the workspace only after the permissions are approved.
5. Connect the app in a chat and run `etsy_connection_status` before creating a draft.

ChatGPT can ask for confirmation before write actions. The bridge's publish action also requires a separate publish tool call with `PUBLISH <listing_id>`.

## Create and upload a listing

1. Ask ChatGPT to create an asset upload session.
2. Open the returned upload page, enter its one-time code, and upload preview images and the final PDF/ZIP.
3. Ask ChatGPT to list the staged assets, create the digital draft, and attach the chosen images and download file.
4. Review the draft in Etsy. To publish, explicitly request publication and confirm the listing ID.

Upload codes expire after 30 minutes. Unused staged files expire after 24 hours. The bridge validates file extension, declared type, and basic file signature before staging.

## Verification checklist

- [ ] PR CI passes.
- [ ] Auth0 API audience is the exact MCP resource URL and Resource Parameter Compatibility Profile is enabled.
- [ ] The owner is the only authorized account and has the intended bridge scopes.
- [ ] Worker issuer/audience secrets are configured.
- [ ] Etsy authorization has `listings_w`.
- [ ] Worker is deployed with the existing KV binding and required Etsy secrets.
- [ ] ChatGPT discovers the tools and stays connected after access-token expiry.
- [ ] Read actions return ColorCity999 data.
- [ ] Draft creation, file/image upload, and publication are verified in Etsy.
- [ ] Workspace admins publish only the reviewed actions.
