import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioAccount, CALLBACK, STUDIO_ORIGIN, validateDraft } from '../src/studio/account.js';
import { renderStudio } from '../src/studio/ui.js';
import { handleStudio } from '../src/studio/index.js';
import worker from '../worker.js';
import { sample } from './studio-fixtures.js';

const token = { accessToken: '111.private-access', refreshToken: '111.private-refresh', userId: '111', shopId: 51212373,
  expiresAt: Date.now() + 3600000, scope: 'listings_r listings_w shops_r', currency: 'USD' };
const env = { ETSY_KEYSTRING: 'test-key', ETSY_SHARED_SECRET: 'test-secret', STUDIO_ETSY_SHOP_ID: '51212373' };
const listing = { title: 'Original Coloring Book PDF', description: 'Original printable coloring pages. Digital PDF, no physical item.',
  price: '9.99', currency: 'USD', taxonomyId: 42, reviewed: true, tags: Array.from({ length: 13 }, (_, i) => 'tag ' + i) };
function fixture(record = token) {
  const data = new Map(record ? [['etsy:oauth', structuredClone(record)]] : []);
  const storage = { get: async k => structuredClone(data.get(k)), put: async (k, v) => { data.set(k, structuredClone(v)); }, delete: async k => data.delete(k) };
  const account = new StudioAccount({ storage }, env);
  return { data, account };
}
function draftRequest(input = listing) {
  const body = new FormData(); body.append('package', new Blob([sample()], { type: 'application/zip' }), 'book.zip');
  body.append('listing', JSON.stringify(input));
  return new Request('https://studio.internal/draft', { method: 'POST', body });
}
function etsyMock({ failUpload = false, active = false } = {}) {
  const writes = [];
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method || 'GET';
    if (method === 'POST') {
      writes.push({ path, body: options.body });
      if (path.endsWith('/listings')) return Response.json({ listing_id: 1001, shop_id: 51212373, state: 'draft' });
      if (failUpload) throw new Error('interrupted');
      return Response.json(path.endsWith('/files') ? { listing_file_id: 2001 } : { listing_image_id: 3001 });
    }
    if (path.endsWith('/seller-taxonomy/nodes')) return Response.json({ results: [{ id: 42, name: 'Coloring Books', children: [] }] });
    if (path.endsWith('/shops/51212373')) return Response.json({ shop_id: 51212373, currency_code: 'USD' });
    if (path.endsWith('/listings/1001')) return Response.json({ listing_id: 1001, shop_id: 51212373, state: active ? 'active' : 'draft' });
    throw new Error('Unexpected call: ' + path);
  };
  return { fetch, writes };
}

test('draft details require explicit review, 13 unique tags, valid price and currency', () => {
  validateDraft(listing);
  for (const change of [{ reviewed: false }, { price: '0' }, { price: '1.999' }, { tags: ['one'] }, { taxonomyId: -1 }, { currency: '' }]) assert.throws(() => validateDraft({ ...listing, ...change }));
});
test('readiness returns safe statuses, never private tokens or raw scopes', async () => {
  const { account } = fixture();
  const response = await account.fetch(new Request('https://studio.internal/ready'));
  const text = await response.text();
  assert.equal(JSON.parse(text).draftCreationEnabled, true);
  for (const value of [token.accessToken, token.refreshToken, token.scope, env.ETSY_SHARED_SECRET]) assert.ok(!text.includes(value));
  assert.equal(JSON.parse(text).publishingEnabled, false);
});
test('a reviewed package creates exactly one digital draft and uploads PDF plus images, never publishes', async t => {
  const { account } = fixture(), mock = etsyMock(); t.mock.method(globalThis, 'fetch', mock.fetch);
  const response = await account.fetch(draftRequest()); const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.complete, true); assert.equal(result.state, 'draft');
  assert.equal(mock.writes.length, 4); assert.equal(mock.writes[0].body.get('type'), 'download');
  assert.equal(mock.writes[0].body.has('state'), false);
  assert.equal(mock.writes[1].body.get('file').type, 'application/pdf');
  const repeat = await account.fetch(draftRequest({ ...listing, title: 'Changed title' }));
  assert.equal((await repeat.json()).alreadyCreated, true); assert.equal(mock.writes.length, 4);
});
test('simultaneous retries serialize and reuse the single completed draft', async t => {
  const { account } = fixture(), mock = etsyMock(); t.mock.method(globalThis, 'fetch', mock.fetch);
  const responses = await Promise.all([account.fetch(draftRequest()), account.fetch(draftRequest())]);
  assert.deepEqual(responses.map(x => x.status), [200, 200]); assert.equal(mock.writes.length, 4);
});
test('an interrupted upload is journaled and retries cannot duplicate it, including after object restart', async t => {
  const { account, data } = fixture(), mock = etsyMock({ failUpload: true }); t.mock.method(globalThis, 'fetch', mock.fetch);
  assert.equal((await account.fetch(draftRequest())).status, 502);
  const resumed = new StudioAccount({ storage: { get: async k => structuredClone(data.get(k)), put: async (k, v) => data.set(k, structuredClone(v)) } }, env);
  const response = await resumed.fetch(draftRequest()); const result = await response.json();
  assert.equal(response.status, 409); assert.equal(result.listingId, 1001); assert.equal(mock.writes.length, 2);
});
test('a draft activated outside Studio cannot receive further uploads', async t => {
  const { account } = fixture(), mock = etsyMock({ active: true }); t.mock.method(globalThis, 'fetch', mock.fetch);
  assert.equal((await account.fetch(draftRequest())).status, 409); assert.equal(mock.writes.length, 1);
});
test('wrong shop, missing scope and wrong currency fail before writing to Etsy', async t => {
  const mock = etsyMock(); t.mock.method(globalThis, 'fetch', mock.fetch);
  for (const record of [{ ...token, shopId: 123 }, { ...token, scope: 'listings_r' }, null]) assert.equal((await fixture(record).account.fetch(draftRequest())).status, 503);
  assert.equal((await fixture().account.fetch(draftRequest({ ...listing, currency: 'EUR' }))).status, 409); assert.equal(mock.writes.length, 0);
});
test('OAuth uses exact preview callback, minimal scopes, PKCE, expiring single-use state and secure cookie', async () => {
  const { account, data } = fixture(null);
  const start = await account.fetch(new Request('https://studio.internal/connect', { method: 'POST' }));
  const target = new URL(start.headers.get('Location'));
  assert.equal(target.origin, 'https://www.etsy.com'); assert.equal(target.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(target.searchParams.get('scope'), 'listings_r listings_w shops_r'); assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.match(start.headers.get('Set-Cookie'), /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
  const bad = await account.fetch(new Request('https://studio.internal/callback?state=bad&code=bad'));
  assert.equal(bad.status, 400); assert.ok(data.has('oauth:pending'));
});
test('OAuth verifies the expected shop before storing any credential and consumes state once', async t => {
  const { account, data } = fixture(null);
  const start = await account.fetch(new Request('https://studio.internal/connect', { method: 'POST' }));
  const url = new URL(start.headers.get('Location')); const cookie = start.headers.get('Set-Cookie').split(';')[0];
  t.mock.method(globalThis, 'fetch', async target => String(target).endsWith('/oauth/token')
    ? Response.json({ access_token: '111.access', refresh_token: '111.refresh', expires_in: 3600, scope: 'listings_r listings_w shops_r' })
    : Response.json({ results: [{ shop_id: 999, currency_code: 'USD' }] }));
  const request = () => new Request('https://studio.internal/callback?state=' + url.searchParams.get('state') + '&code=private-code', { headers: { Cookie: cookie } });
  assert.equal((await account.fetch(request())).status, 403); assert.ok(!data.has('etsy:oauth'));
  assert.equal((await account.fetch(request())).status, 400);
});
test('Studio protects connection and draft routes with owner authentication and same-origin POST guard', async () => {
  for (const path of ['/studio/connect', '/studio/draft']) await assert.rejects(handleStudio(new Request(STUDIO_ORIGIN + path, { method: 'POST', headers: { Origin: 'https://evil.invalid' } }), { STUDIO_ENABLED: 'preview', STUDIO_ACCOUNT: {} }, { authorize: async () => {} }), /Cross-origin/);
  const response = await worker.fetch(new Request(STUDIO_ORIGIN + '/studio/connection'), { STUDIO_ENABLED: 'preview', STUDIO_ISOLATED: 'true' });
  assert.equal(response.status, 503);
  assert.equal((await fixture().account.fetch(new Request('https://studio.internal/publish', { method: 'POST' }))).status, 404);
});
test('UI script parses and exposes review, connection and draft controls without publication actions', async () => {
  const html = await renderStudio().text(); const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script)); assert.match(html, /Save draft to Etsy/); assert.match(html, /Publishing is disabled/);
  assert.ok(!script.includes('/publish'));
});
