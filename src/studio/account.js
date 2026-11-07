import { etsyRequest } from '../etsy.js';
import { extractListingPackage } from './zip.js';
import { listingDefaults, validateEtsyText, checkPackage, selectCategory, AI_DISCLOSURE } from './standards.js';

export const STUDIO_ORIGIN = 'https://colorcity999-listing-studio-preview.gogumchika.workers.dev';
export const CALLBACK = STUDIO_ORIGIN + '/studio/oauth/callback';
const SCOPES = 'listings_r listings_w shops_r';
const COOKIE = '__Host-studio_oauth';
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const json = (data, status = 200) => Response.json(data, { status, headers });
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const writeGranted = record => typeof record?.scope === 'string' && record.scope.split(/\s+/).includes('listings_w');
const results = data => Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];

// One strongly consistent account object owns ONLY this Studio's OAuth and draft journal.
// There is no production KV binding, generic proxy, PATCH, delete or publish operation.
export class StudioAccount {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.tail = Promise.resolve();
    this.apiEnv = { ...env, ETSY_KV: {
      get: async key => (await ctx.storage.get(key)) ?? null,
      put: async (key, value) => ctx.storage.put(key, JSON.parse(value)),
    } };
  }
  async fetch(request) {
    const task = this.tail.then(() => this.route(request));
    this.tail = task.catch(() => {});
    try { return await task; }
    catch (error) { return json({ ...(error.safeJob || {}), error: error.status ? error.message : 'Studio request failed. Try again or review the existing draft in Etsy.' }, error.status || 502); }
  }
  async route(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ready' && request.method === 'GET') return this.status(false);
    if (url.pathname === '/connection' && request.method === 'GET') return this.status(true);
    if (url.pathname === '/connect' && request.method === 'POST') return this.connect();
    if (url.pathname === '/callback' && request.method === 'GET') return this.callback(request);
    if (url.pathname === '/taxonomy' && request.method === 'GET') return this.taxonomy(url.searchParams.get('q'));
    if (url.pathname === '/draft' && request.method === 'POST') return this.draft(request);
    if (url.pathname === '/prepare' && request.method === 'POST') return this.prepare(request);
    return json({ error: 'Not found.' }, 404);
  }
  configured() {
    return Boolean(this.env.ETSY_KEYSTRING && this.env.ETSY_SHARED_SECRET && /^\d+$/.test(this.env.STUDIO_ETSY_SHOP_ID || ''));
  }
  async status(live) {
    const record = await this.ctx.storage.get('etsy:oauth');
    let connected = Boolean(this.configured() && record?.refreshToken && String(record.shopId) === this.env.STUDIO_ETSY_SHOP_ID);
    let verified = false;
    if (live && connected) {
      try {
        const shop = await this.read('/shops/' + this.env.STUDIO_ETSY_SHOP_ID);
        verified = String(shop.shop_id) === this.env.STUDIO_ETSY_SHOP_ID;
        connected = verified;
      } catch { connected = false; }
    }
    return json({ configured: this.configured(), connected, liveVerified: verified,
      listingWriteScope: writeGranted(record) ? 'granted' : 'unverified',
      currency: connected ? record.currency : null, draftCreationEnabled: connected && writeGranted(record), publishingEnabled: false });
  }
  async connect() {
    if (!this.configured()) fail(503, 'Etsy connection settings are not configured yet.');
    const session = random(), state = random(), verifier = random();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // One pending owner consent at a time; expires in ten minutes and is consumed once.
    await this.ctx.storage.put('oauth:pending', { sessionHash: await digest(new TextEncoder().encode(session)), state, verifier, expires: Date.now() + 600000 });
    const url = new URL('https://www.etsy.com/oauth/connect');
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: this.env.ETSY_KEYSTRING,
      redirect_uri: CALLBACK, scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { ...headers, Location: url.toString(),
      'Set-Cookie': COOKIE + '=' + session + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600' } });
  }
  async callback(request) {
    const url = new URL(request.url);
    const pending = await this.ctx.storage.get('oauth:pending');
    const session = (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!pending || !session || pending.expires < Date.now() ||
      await digest(new TextEncoder().encode(session)) !== pending.sessionHash || url.searchParams.get('state') !== pending.state) fail(400, 'Etsy sign-in session expired or is invalid. Start Connect Etsy again.');
    await this.ctx.storage.delete('oauth:pending');
    if (url.searchParams.has('error') || !url.searchParams.get('code')) fail(400, 'Etsy authorization was not completed.');
    const response = await fetch('https://api.etsy.com/v3/public/oauth/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: this.env.ETSY_KEYSTRING,
        redirect_uri: CALLBACK, code: url.searchParams.get('code'), code_verifier: pending.verifier }) });
    if (!response.ok) fail(502, 'Etsy authorization could not be completed. Start Connect Etsy again.');
    const token = await response.json();
    const userId = typeof token.access_token === 'string' ? token.access_token.split('.')[0] : '';
    if (!/^\d+$/.test(userId) || !token.refresh_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || !writeGranted(token)) fail(502, 'Etsy did not confirm the required listing permission.');
    const shopResponse = await fetch('https://api.etsy.com/v3/application/users/' + userId + '/shops', {
      headers: { 'x-api-key': this.env.ETSY_KEYSTRING + ':' + this.env.ETSY_SHARED_SECRET,
        Authorization: 'Bearer ' + token.access_token, Accept: 'application/json' } });
    if (!shopResponse.ok) fail(502, 'Unable to verify the Etsy shop.');
    const data = await shopResponse.json();
    const shop = results(data).find(x => String(x.shop_id) === this.env.STUDIO_ETSY_SHOP_ID) || (String(data.shop_id) === this.env.STUDIO_ETSY_SHOP_ID ? data : null);
    if (!shop || !/^[A-Z]{3}$/.test(shop.currency_code || '')) fail(403, 'This Etsy account is not the configured ColorCity999 shop.');
    await this.ctx.storage.put('etsy:oauth', { accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000, userId, scope: token.scope,
      shopId: shop.shop_id, currency: shop.currency_code, updatedAt: Date.now() });
    return new Response(null, { status: 303, headers: { ...headers, Location: STUDIO_ORIGIN + '/studio',
      'Set-Cookie': COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' } });
  }
  async read(path) {
    const response = await etsyRequest(this.apiEnv, path);
    if (!response.ok) fail(502, 'Etsy connection check failed. Reconnect Etsy if needed.');
    return response.json();
  }
  async taxonomy(query) {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 80) fail(400, 'Enter at least two characters to find a category.');
    const tree = await this.read('/seller-taxonomy/nodes');
    const matches = [];
    const visit = (nodes, parents = []) => {
      for (const node of nodes || []) {
        const path = [...parents, node.name];
        if (!node.children?.length && path.join(' ').toLowerCase().includes(query.trim().toLowerCase())) matches.push({ id: node.id, name: path.join(' > ') });
        visit(node.children, path);
      }
    };
    visit(tree.results);
    return json({ categories: matches.slice(0, 40) });
  }
  async mutate(path, body) {
    // Never automatically retry a write; an ambiguous response must be reconciled manually.
    const response = await etsyRequest(this.apiEnv, path, { method: 'POST', body, allowRefresh: false });
    if (!response.ok) {
      const rejected = [400,401,403,404,413,415,422].includes(response.status);
      throw Object.assign(new Error(rejected ? 'Etsy rejected this draft or file (HTTP ' + response.status + '). The confirmed rejection can be corrected without creating another draft.' : 'Etsy did not confirm the upload. Review the existing draft in Etsy before trying another package.'), { status: 502, confirmedRejection: rejected });
    }
    return response.json();
  }
  async draft(request) {
    const record = await this.ctx.storage.get('etsy:oauth');
    if (!this.configured() || !record?.refreshToken || !writeGranted(record) || String(record.shopId) !== this.env.STUDIO_ETSY_SHOP_ID) fail(503, 'Connect the ColorCity999 Etsy shop first.');
    const form = await request.formData();
    const file = form.get('package');
    if (!file || typeof file.arrayBuffer !== 'function' || file.size > 20000000) fail(400, 'Choose one ZIP no larger than 20 MB.');
    let input;
    try { input = JSON.parse(form.get('listing')); } catch { fail(400, 'Listing details are invalid.'); }
    input = listingDefaults(input);
    validateDraft(input);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pkg = await extractListingPackage(bytes);
    return this.savePackage(input, pkg);
  }
  async prepare(request) {
    const form = await request.formData(), file = form.get('package');
    if (!file || typeof file.arrayBuffer !== 'function' || file.size > 20000000) fail(400, 'Choose one prepared product ZIP no larger than 20 MB.');
    const pkg = await extractListingPackage(new Uint8Array(await file.arrayBuffer()));
    const metadata = pkg.listingMetadata;
    if (!metadata || metadata.reviewed !== true || metadata.schemaVersion !== 1) fail(422, 'This product has not been prepared yet. Send the product in chat so its actual PDF, images and listing can be checked.');
    const category = selectCategory(await this.read('/seller-taxonomy/nodes'), metadata);
    const input = listingDefaults({ ...metadata, taxonomyId: category.id });
    validateDraft(input);
    checkPackage(pkg, { strictImages: true });
    return this.savePackage(input, pkg);
  }
  async savePackage(input, pkg) {
    const record = await this.ctx.storage.get('etsy:oauth');
    if (!this.configured() || !record?.refreshToken || !writeGranted(record) || String(record.shopId) !== this.env.STUDIO_ETSY_SHOP_ID) fail(503, 'Connect the ColorCity999 Etsy shop first.');
    const packageChecks = checkPackage(pkg);
    const packageHash = await digest(pkg.pdf.bytes);
    // The same PDF always resolves to one journal, even if ZIP compression or listing metadata changes.
    const key = 'draft:' + packageHash;
    let job = await this.ctx.storage.get(key);
    const fingerprint = await digest(new TextEncoder().encode(JSON.stringify(input)));
    if (job?.complete) {
      await this.verifyDraft(job, job.expectedListing, job.packageChecks.images.length);
      return json({ ...publicJob(job), alreadyCreated: true });
    }
    if (job?.inFlight) return json({ ...publicJob(job), error: 'A previous Etsy response was interrupted. Review this draft in Etsy; automatic retries are blocked to avoid duplicates.' }, 409);
    if (job && job.fingerprint !== fingerprint) fail(409, 'This ZIP already has a draft in progress. Keep the original details or review it in Etsy.');
    if (!job) job = { fingerprint, uploaded: [], createdAt: Date.now(), listingId: null, complete: false, expectedListing: input, packageChecks };
    // Read checks refresh the token before the first write; write requests never refresh/retry.
    const shop = await this.read('/shops/' + this.env.STUDIO_ETSY_SHOP_ID);
    if (String(shop.shop_id) !== this.env.STUDIO_ETSY_SHOP_ID || shop.currency_code !== input.currency) fail(409, 'Shop currency changed. Reload the connection and review the price.');
    if (!job.listingId) {
      const tree = await this.read('/seller-taxonomy/nodes');
      const ids = new Set();
      const visit = nodes => { for (const n of nodes || []) { if (!n.children?.length) ids.add(n.id); visit(n.children); } };
      visit(tree.results);
      if (!ids.has(input.taxonomyId)) fail(400, 'Choose a current Etsy category.');
      const body = new URLSearchParams({ quantity: '999', title: input.title.trim(), description: input.description.trim(),
        price: Number(input.price).toFixed(2), taxonomy_id: String(input.taxonomyId), type: 'download',
        who_made: 'i_did', when_made: '2020_2026', is_supply: 'false', should_auto_renew: 'false' });
      body.set('tags', input.tags.map(tag => tag.trim()).join(','));
      job.inFlight = 'create'; await this.ctx.storage.put(key, job);
      let listing;
      try { listing = await this.mutate('/shops/' + this.env.STUDIO_ETSY_SHOP_ID + '/listings', body); }
      catch (error) { if (error.confirmedRejection) await this.ctx.storage.delete(key); throw error; }
      if (!Number.isSafeInteger(listing.listing_id) || listing.state !== 'draft' || String(listing.shop_id) !== this.env.STUDIO_ETSY_SHOP_ID) fail(502, 'Etsy did not confirm a draft for this shop. Review the listing in Etsy.');
      job.listingId = listing.listing_id; job.inFlight = null; await this.ctx.storage.put(key, job);
    }
    const assets = [{ ...pkg.pdf, purpose: 'files' }, ...pkg.images.map(x => ({ ...x, purpose: 'images' }))];
    for (let i = 0; i < assets.length; i++) {
      if (job.uploaded.includes(i)) continue;
      const listing = await this.read('/listings/' + job.listingId);
      if (listing.state !== 'draft' || String(listing.shop_id) !== this.env.STUDIO_ETSY_SHOP_ID) fail(409, 'Only this Studio-created draft can receive files. No active listings are changed.');
      const asset = assets[i], body = new FormData();
      const name = asset.purpose === 'files' ? packageChecks.customerFilename : asset.name.split('/').pop();
      body.append(asset.purpose === 'files' ? 'file' : 'image', new Blob([asset.bytes], { type: asset.kind }), name);
      if (asset.purpose === 'files') body.append('name', name);
      else body.append('alt_text', String(input.imageAltTexts?.[asset.name] || '').slice(0, 500));
      body.append('rank', String(asset.purpose === 'files' ? 1 : i));
      job.inFlight = 'upload:' + i; await this.ctx.storage.put(key, job);
      let uploaded;
      try { uploaded = await this.mutate('/shops/' + this.env.STUDIO_ETSY_SHOP_ID + '/listings/' + job.listingId + '/' + asset.purpose, body); }
      catch (error) { if (error.confirmedRejection) { job.inFlight = null; await this.ctx.storage.put(key, job); } error.safeJob = publicJob(job); throw error; }
      if (!(uploaded.listing_image_id || uploaded.listing_file_id || uploaded.file_id)) fail(502, 'Etsy did not confirm the uploaded file. Review the draft in Etsy.');
      job.uploaded.push(i); job.inFlight = null; await this.ctx.storage.put(key, job);
    }
    try { await this.verifyDraft(job, input, pkg.images.length); }
    catch (error) { error.safeJob = publicJob(job); throw error; }
    job.complete = true; job.readbackVerified = true; job.verifiedAt = Date.now(); await this.ctx.storage.put(key, job);
    return json(publicJob(job));
  }
  async verifyDraft(job, input, imageCount) {
    const listing = await this.read('/listings/' + job.listingId);
    if (listing.state !== 'draft' || String(listing.shop_id) !== this.env.STUDIO_ETSY_SHOP_ID) fail(409, 'This product is no longer an unpublished draft in the configured shop. No changes were made.');
    const images = results(await this.read('/listings/' + job.listingId + '/images'));
    const files = results(await this.read('/shops/' + this.env.STUDIO_ETSY_SHOP_ID + '/listings/' + job.listingId + '/files'));
    const price = typeof listing.price === 'object' ? Number(listing.price.amount) / Number(listing.price.divisor) : Number(listing.price);
    const currency = listing.price?.currency_code || listing.currency_code;
    const actualTags = Array.isArray(listing.tags) ? listing.tags.map(x=>x.trim().toLowerCase()).sort() : [];
    const expectedTags = [...input.tags].sort();
    if (listing.title !== input.title || listing.description !== input.description || !listing.description.includes(AI_DISCLOSURE) ||
      (!listing.is_digital && listing.type !== 'download') || listing.taxonomy_id !== input.taxonomyId ||
      Math.round(price * 100) !== Math.round(Number(input.price) * 100) || currency !== input.currency ||
      JSON.stringify(actualTags) !== JSON.stringify(expectedTags) || images.length !== imageCount || files.length !== 1) {
      fail(409, 'Etsy saved the draft, but its read-back checks did not match all prepared details. Review the draft before publishing.');
    }
  }
}

export function validateDraft(input) {
  if (!input || input.reviewed !== true) fail(400, 'Review and approve the listing details before saving a draft.');
  for (const [key, max] of [['title', 140], ['description', 5000]]) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].trim().length > max) fail(400, 'Check the listing ' + key + '.');
  if (!Array.isArray(input.tags) || input.tags.length !== 13 || new Set(input.tags.map(x => typeof x === 'string' ? x.trim().toLowerCase() : '')).size !== 13 || input.tags.some(x => typeof x !== 'string' || !x.trim() || x.length > 20)) fail(400, 'Use 13 unique tags, each 1–20 characters.');
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(String(input.price)) || Number(input.price) <= 0) fail(400, 'Use a positive price with up to two decimal places.');
  if (!Number.isSafeInteger(input.taxonomyId) || input.taxonomyId < 1 || !/^[A-Z]{3}$/.test(input.currency || '')) fail(400, 'Choose an Etsy category and confirm the shop currency.');
  validateEtsyText(input);
}
function publicJob(job) {
  return { listingId: job.listingId, state: 'draft', complete: job.complete, uploadedFiles: job.uploaded.length,
    publishingEnabled: false, readbackVerified: Boolean(job.readbackVerified), packageChecks: job.packageChecks,
    reviewUrl: job.listingId ? 'https://www.etsy.com/your/shops/me/listing-editor/edit/' + job.listingId : null };
}
