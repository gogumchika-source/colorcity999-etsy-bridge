# Owner-only Studio draft workflow

This change is deployed only to `colorcity999-listing-studio-preview`. Do not merge it into main or run the production deploy workflow. The original Etsy bridge is unchanged in Cloudflare.

The Studio's existing Cloudflare Access policy and JWT checks remain required on every request. Its own SQLite-backed Durable Object stores a separate OAuth record and draft journal. There is no binding to production KV, no production API secret, and no generic Etsy proxy.

Configure `ETSY_KEYSTRING` and `ETSY_SHARED_SECRET` only as encrypted Cloudflare secrets. Preserve all existing `STUDIO_ACCESS_*` and `STUDIO_ALLOWED_EMAIL` secrets. Register the exact separate callback `https://colorcity999-listing-studio-preview.gogumchika.workers.dev/studio/oauth/callback` in the existing Etsy app, keeping the production callback registered.

The connection requests only `listings_r listings_w shops_r`, uses PKCE, single-use expiring state and a secure HttpOnly session cookie, and verifies the configured shop ID before storing tokens. Actual granted scopes are checked; requesting a scope is never treated as proof it was granted. No tokens, email addresses or private configuration values belong in this public repository.

Generate a preview, review and edit its title, description, 13 tags, price in the connected shop currency, and an actual Etsy taxonomy category. Confirm rights and product details, then explicitly click **Save draft to Etsy**. The Studio creates a digital draft and uploads its PDF and JPG/PNG images. It never edits an existing active listing. The review link opens Etsy's draft editor.

Publishing is intentionally unavailable: the new account object's only Etsy writes are POSTs to draft creation and asset uploads. It has no PATCH, deletion or publish route. The owner decides separately whether to publish a particular draft in Etsy.

The original ZIP is processed in memory, not retained. A strongly consistent journal keyed by ZIP SHA-256 prevents duplicate creation across retries and browser sessions. Before each Etsy write, a durable in-flight marker is saved. Uncertain network outcomes stop for manual review; they are never automatically retried. Completed uploads are recorded separately, and files can only be attached while the managed listing remains a draft in the configured shop. Retries with the same ZIP return the existing draft rather than creating another.

Local tests mock Etsy and Workers AI; no real listing is created by them. Live setup verifies owner login, the separate OAuth consent and shop reads. The first real product draft must be reviewed by the owner before its Save draft action. Workers Free supports SQLite-backed Durable Objects; no paid plan or paid service is enabled by this setup.

The preview deployment workflow runs only on `feature/studio-owner-drafts` with an explicit `[deploy-studio]` commit marker. It tests first, enforces the separate Worker name and absence of production KV, deploys with the preview configuration, preserves dashboard variables, and checks anonymous redirects. It never runs the production deployment job.
