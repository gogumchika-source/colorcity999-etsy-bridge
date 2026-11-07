import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioAccount, CALLBACK, STUDIO_ORIGIN, validateDraft } from '../src/studio/account.js';
import { renderStudio } from '../src/studio/ui.js';
import { renderProductTransfer } from '../src/studio/transfer.js';
import { handleStudio } from '../src/studio/index.js';
import worker from '../worker.js';
import { sample, zip, pdf, png } from './studio-fixtures.js';
import { AI_DISCLOSURE, checkPackage, buyerFilename } from '../src/studio/standards.js';

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
  let created = {};
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method || 'GET';
    if (method === 'POST') {
      writes.push({ path, body: options.body });
      if (path.endsWith('/listings')) {
        created = { title: options.body.get('title'), description: options.body.get('description'), tags: options.body.get('tags').split(','), taxonomy_id: Number(options.body.get('taxonomy_id')), type: 'download', price: { amount: Math.round(Number(options.body.get('price')) * 100), divisor: 100, currency_code: 'USD' } };
        return Response.json({ listing_id: 1001, shop_id: 51212373, state: 'draft' });
      }
      if (failUpload) throw new Error('interrupted');
      return Response.json(path.endsWith('/files') ? { listing_file_id: 2001 } : { listing_image_id: 3001 });
    }
    if (path.endsWith('/seller-taxonomy/nodes')) return Response.json({ results: [{ id: 42, name: 'Coloring Books', children: [] }] });
    if (path.endsWith('/shops/51212373')) return Response.json({ shop_id: 51212373, currency_code: 'USD' });
    if (path.endsWith('/listings/1001')) return Response.json({ ...created, listing_id: 1001, shop_id: 51212373, state: active ? 'active' : 'draft' });
    if (path.endsWith('/listings/1001/images')) return Response.json({ results: writes.filter(x=>x.path.endsWith('/images')).map((_,i)=>({ listing_image_id: 3001+i })) });
    if (path.endsWith('/listings/1001/files')) return Response.json({ results: writes.filter(x=>x.path.endsWith('/files')).map(()=>({ listing_file_id: 2001 })) });
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
  assert.equal(result.readbackVerified, true); assert.ok(mock.writes[0].body.get('description').includes(AI_DISCLOSURE));
  assert.equal(mock.writes.length, 4); assert.equal(mock.writes[0].body.get('type'), 'download');
  assert.equal(mock.writes[0].body.get('tags'), listing.tags.join(',')); assert.equal(mock.writes[0].body.has('tags[]'), false);
  assert.equal(mock.writes[0].body.has('state'), false);
  assert.equal(mock.writes[1].body.get('file').type, 'application/pdf');
  const repeat = await account.fetch(draftRequest({ ...listing, title: 'Changed title' }));
  assert.equal((await repeat.json()).alreadyCreated, true); assert.equal(mock.writes.length, 4);
});
test('prepared ZIP automatically chooses a real category, adds disclosure and uploads only product assets', async t => {
  const { account } = fixture(), mock = etsyMock(); t.mock.method(globalThis, 'fetch', mock.fetch);
  const metadata = { ...listing, taxonomyId: undefined, price: undefined, currency: undefined, schemaVersion: 1, productType: 'coloring_book', imageAltTexts: { 'cover.png': 'Original coloring book cover.' } };
  const body = new FormData(); body.append('package', new Blob([zip([['book.pdf',pdf],['cover.png',png],['listing.json',JSON.stringify(metadata)]])]), 'prepared.zip');
  const response = await account.fetch(new Request('https://studio.internal/prepare', { method: 'POST', body }));
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.readbackVerified, true); assert.equal(mock.writes.length, 3);
  assert.equal(mock.writes[0].body.get('price'), '9.99'); assert.equal(mock.writes[0].body.get('taxonomy_id'), '42');
  assert.ok(mock.writes[0].body.get('description').includes(AI_DISCLOSURE)); assert.equal(mock.writes[2].body.get('alt_text'), metadata.imageAltTexts['cover.png']);
});
test('product transfer can verify the prepared package without creating an Etsy listing', async t => {
  const {account}=fixture(), mock=etsyMock();t.mock.method(globalThis,'fetch',mock.fetch);
  const body=new FormData();body.append('package',new Blob([zip([['book.pdf',pdf],['cover.png',png],['listing.json',JSON.stringify({...listing,schemaVersion:1,productType:'coloring_book'})]])]),'prepared.zip');
  const response=await account.fetch(new Request('https://studio.internal/check-package',{method:'POST',body}));
  const result=await response.json();assert.equal(response.status,200);assert.equal(result.checked,true);assert.equal(result.noEtsyWritesPerformed,true);assert.equal(result.tags.length,13);assert.equal(mock.writes.length,0);
});
test('metadata changes and ZIP compression do not bypass duplicate prevention for the same PDF', async t => {
  const { account } = fixture(), mock = etsyMock(); t.mock.method(globalThis, 'fetch', mock.fetch);
  const metadata = { ...listing, schemaVersion: 1, productType: 'coloring_book' };
  for (const compress of [false,true]) {
    const body = new FormData(); body.append('package',new Blob([zip([['book.pdf',pdf],['cover.png',png],['page.png',png],['listing.json',JSON.stringify(metadata)]],compress)]),'prepared.zip');
    const response = await account.fetch(new Request('https://studio.internal/prepare',{ method:'POST',body })); assert.equal(response.status,200);
  }
  assert.equal(mock.writes.length,4);
});
test('prepared path rejects missing file review and low-resolution images before any Etsy write', async t => {
  const { account } = fixture(), mock = etsyMock(); t.mock.method(globalThis, 'fetch', mock.fetch);
  const body = new FormData(); body.append('package',new Blob([sample()]),'raw.zip');
  assert.equal((await account.fetch(new Request('https://studio.internal/prepare',{ method:'POST',body }))).status,422);
  const small = Buffer.from(png); small.writeUInt32BE(1,16); small.writeUInt32BE(1,20);
  assert.throws(()=>checkPackage({pdf:{name:'book.pdf',bytes:pdf},images:[{name:'cover.png',kind:'image/png',bytes:small}]},{strictImages:true}),/2000 pixels/);
  assert.equal(mock.writes.length,0);
});
test('Etsy-invalid tags and repeated title symbols are rejected and customer filenames are safe', () => {
  assert.throws(()=>validateDraft({...listing,tags:[...listing.tags.slice(0,12),'tag!']}),/keyword phrases/);
  assert.throws(()=>validateDraft({...listing,title:'Coloring & Drawing & Learning'}),/only once/);
  assert.match(buyerFilename('folder/Original PDF (coloring) — '+ 'x'.repeat(100)+'.pdf'),/^[A-Za-z0-9._-]{1,70}$/);
});
test('a confirmed Etsy rejection clears the create marker so a corrected request can succeed', async t => {
  const {account}=fixture(), mock=etsyMock(); let rejected=false;
  t.mock.method(globalThis,'fetch',async (url,options={})=>{
    if(options.method==='POST'&&String(url).endsWith('/listings')&&!rejected){rejected=true;return Response.json({error:'Invalid input'},{status:400});}
    return mock.fetch(url,options);
  });
  assert.equal((await account.fetch(draftRequest())).status,502);
  assert.equal((await account.fetch(draftRequest())).status,200);
  assert.equal(mock.writes.length,4);
});
test('incorrect Etsy read-back cannot be reported as a ready-to-publish draft', async t => {
  const {account}=fixture(),mock=etsyMock();let listingReads=0;
  t.mock.method(globalThis,'fetch',async (url,options={})=>{
    const response=await mock.fetch(url,options);
    if((options.method||'GET')==='GET'&&String(url).endsWith('/listings/1001')&&++listingReads>3){const data=await response.json();return Response.json({...data,tags:['incorrect']});}
    return response;
  });
  const response=await account.fetch(draftRequest());const data=await response.json();assert.equal(response.status,409);assert.equal(data.readbackVerified,false);assert.ok(data.reviewUrl);
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
  for (const path of ['/studio/connect', '/studio/draft', '/studio/prepare', '/studio/check-package']) await assert.rejects(handleStudio(new Request(STUDIO_ORIGIN + path, { method: 'POST', headers: { Origin: 'https://evil.invalid' } }), { STUDIO_ENABLED: 'preview', STUDIO_ACCOUNT: {} }, { authorize: async () => {} }), /Cross-origin/);
  const response = await worker.fetch(new Request(STUDIO_ORIGIN + '/studio/connection'), { STUDIO_ENABLED: 'preview', STUDIO_ISOLATED: 'true' });
  assert.equal(response.status, 503);
  assert.equal((await fixture().account.fetch(new Request('https://studio.internal/publish', { method: 'POST' }))).status, 404);
});
test('Studio forwards OAuth redirects to the browser rather than following them inside its account binding', async () => {
  let forwarded;
  const STUDIO_ACCOUNT = { idFromName: x => x, get: () => ({ fetch: async request => {
    forwarded = request;
    return new Response(null, { status: 302, headers: { Location: 'https://www.etsy.com/oauth/connect' } });
  } }) };
  const response = await handleStudio(new Request(STUDIO_ORIGIN + '/studio/connect', { method: 'POST', headers: { Origin: STUDIO_ORIGIN } }),
    { STUDIO_ENABLED: 'preview', STUDIO_ACCOUNT }, { authorize: async () => {} });
  assert.equal(forwarded.redirect, 'manual'); assert.equal(new URL(forwarded.url).pathname, '/connect');
  assert.equal(response.status, 302); assert.equal(response.headers.get('Location'), 'https://www.etsy.com/oauth/connect');
});
test('prepared multipart upload reaches private account storage intact and rejects oversized declared bodies', async () => {
  let calls=0;
  const STUDIO_ACCOUNT={idFromName:x=>x,get:()=>({fetch:async request=>{
    calls++;const form=await request.formData();assert.equal(await form.get('package').text(),'test product bytes');
    return Response.json({received:true});
  }})};
  const body=new FormData();body.append('package',new Blob(['test product bytes']),'product.zip');
  const request=new Request(STUDIO_ORIGIN+'/studio/prepare',{method:'POST',headers:{Origin:STUDIO_ORIGIN},body});
  const response=await handleStudio(request,{STUDIO_ENABLED:'preview',STUDIO_ACCOUNT},{authorize:async()=>{}});
  assert.equal(response.status,200);assert.equal(calls,1);
  const tooLarge=new Request(STUDIO_ORIGIN+'/studio/prepare',{method:'POST',headers:{Origin:STUDIO_ORIGIN,'Content-Type':'multipart/form-data; boundary=test','Content-Length':'21000000'},body:'x'});
  await assert.rejects(handleStudio(tooLarge,{STUDIO_ENABLED:'preview',STUDIO_ACCOUNT},{authorize:async()=>{}}),/exceeds 20 MB/);
  assert.equal(calls,1);
});
test('UI script parses and exposes review, connection and draft controls without publication actions', async () => {
  const response = renderStudio();
  assert.equal(response.headers.get('Referrer-Policy'), 'same-origin'); // Native same-origin POST forms must keep their Origin header.
  const html = await response.text(); const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script)); assert.match(html, /Save draft to Etsy/); assert.match(html, /Publishing is disabled/);
  assert.ok(!script.includes('/publish'));
});
test('the transfer interface stays behind owner authentication and contains only local authenticated form requests',async()=>{
  const html=await renderProductTransfer().text();const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(()=>new Function(script));assert.match(script,/\/studio\/check-package/);assert.match(script,/\/studio\/prepare/);assert.ok(!script.includes('/publish'));
  assert.equal((await worker.fetch(new Request(STUDIO_ORIGIN+'/studio/import'),{STUDIO_ENABLED:'preview',STUDIO_ISOLATED:'true'})).status,503);
  const response=await handleStudio(new Request(STUDIO_ORIGIN+'/studio/import'),{STUDIO_ENABLED:'preview'},{authorize:async()=>{}});assert.equal(response.status,200);
});
