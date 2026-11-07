export function renderStudio() {
  const nonce = crypto.randomUUID();
  return new Response(String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ColorCity999 | Listing Studio</title><style>
:root{font-family:system-ui,sans-serif;color:#292137;background:#f6f3ff}*{box-sizing:border-box}body{margin:0;padding:32px 16px}main{max-width:920px;margin:auto}h1{margin:0;font-size:2rem}p{line-height:1.6}.muted{color:#675e76}header{margin-bottom:24px}.panel{background:white;padding:26px;border-radius:20px;box-shadow:0 3px 18px #30135410;margin-bottom:18px}label{display:block;margin:14px 0 6px;font-weight:650}input,select,textarea{width:100%;padding:12px;border:1px solid #c8bfd9;border-radius:9px;background:white;font:inherit}textarea{min-height:180px}input[type=checkbox]{width:auto;margin-right:8px}button{border:0;border-radius:10px;padding:13px 18px;background:#7549c9;color:white;font-weight:700;cursor:pointer;margin-top:18px}button:disabled{opacity:.55;cursor:default}.state{margin-top:14px;white-space:pre-wrap}img{max-width:100%;max-height:350px;object-fit:contain;border-radius:12px}a{color:#6239aa}#files{white-space:pre-wrap}.warning{border-left:4px solid #b87516;padding-left:12px}[hidden]{display:none!important}
</style></head><body><main><header><h1>ColorCity999 Listing Studio</h1><p class="muted">Give your product in chat. Its listing and files are prepared for an unpublished Etsy draft. You review and press Publish in Etsy.</p></header>
<section class="panel"><h2>Your Etsy connection</h2><p id="readiness">Checking private Studio settings…</p>
<form method="post" action="/studio/connect"><button id="connect">Connect Etsy for drafts</button></form>
<p class="muted">Only your ColorCity999 shop can connect. Publishing is disabled in this tool.</p></section>
<section class="panel"><h2>Your product, ready for Etsy</h2>
<p>When you send a product in chat, its actual PDF and images are checked and its title, description, 13 search tags and category are prepared for you.</p>
<p class="muted">Defaults: $9.99 USD · AI-artwork disclosure included · Unpublished draft only</p>
<form id="preparedForm"><label for="preparedZip">Prepared product ZIP</label><input id="preparedZip" type="file" accept=".zip,application/zip" required>
<button id="prepareDraft" disabled>Upload prepared draft</button></form>
<p class="state" id="preparedStatus" role="status"></p><a id="preparedLink" hidden target="_blank" rel="noopener noreferrer">Open draft in Etsy to review and publish</a></section>
<details><summary>Manual preview and editing</summary>
<section class="panel"><h2>1. Upload your book</h2><form id="form">
<label for="zip">One ZIP containing exactly one PDF and 1–10 cover/preview images</label><input id="zip" type="file" accept=".zip,application/zip" required>
<p class="muted">Up to 20 MB. Use JPG or PNG images when saving to Etsy. Your original PDF is the customer download.</p>
<label for="title">Book title (optional; otherwise read from the PDF filename)</label><input id="title" maxlength="120" placeholder="Example: Mia and Max Alphabet Adventures">
<button id="go">Generate listing preview</button><div class="state" id="status" role="status"></div></form></section>
<section class="panel" id="result" hidden><h2>2. Review your listing</h2><img id="hero" hidden alt="First preview image from ZIP"><p id="files"></p>
<p class="warning">Suggested text comes from filenames and the book title. Check every claim against your PDF, including ages, page count and print size.</p>
<label for="editTitle">Listing title</label><input id="editTitle" maxlength="140">
<label for="editDescription">Description</label><textarea id="editDescription" maxlength="5000"></textarea>
<label for="editTags">13 tags, separated by commas</label><input id="editTags">
<label for="price">Price <span id="currency"></span></label><input id="price" type="number" min="0.01" step="0.01" inputmode="decimal">
<label for="categoryQuery">Find an Etsy category</label><input id="categoryQuery" value="coloring"><button type="button" id="findCategory">Find categories</button>
<label for="category">Etsy category</label><select id="category"><option value="">Search, then choose a category</option></select>
<label><input type="checkbox" id="reviewed">I reviewed the text, tags, price, category, PDF and images. I have the rights to sell this original product, made in 2020–2026.</label>
<button type="button" id="saveDraft" disabled>Save draft to Etsy</button><div id="draftStatus" class="state" role="status"></div>
<a id="draftLink" hidden target="_blank" rel="noopener noreferrer">Review draft in Etsy</a>
<p class="muted">This saves a new unpublished draft with your PDF and images. No existing listings are edited. Publishing requires a separate decision from you.</p></section>
</details></main><script nonce="${nonce}">
const el=id=>document.getElementById(id), status=el('status'), draftStatus=el('draftStatus');
let connection=null, selectedZip=null, draftComplete=false, busy=false;
function allowSave(){el('saveDraft').disabled=busy||!connection?.draftCreationEnabled||!selectedZip||!el('reviewed').checked||!el('category').value||draftComplete;}
async function request(url,options){const response=await fetch(url,options);let data;try{data=await response.json();}catch{throw new Error('Your session may have expired. Reload the page and sign in again.');}return {response,data};}
for(const id of ['reviewed','category'])el(id).addEventListener('change',allowSave);
el('zip').addEventListener('change',()=>{selectedZip=null;el('result').hidden=true;allowSave();});
fetch('/studio/connection').then(async response=>{
 if(!response.ok)throw new Error();connection=await response.json();el('currency').textContent=connection.currency?'('+connection.currency+')':'';
 el('connect').textContent=connection.liveVerified?'Reconnect Etsy':'Connect Etsy for drafts';
 el('readiness').textContent=connection.liveVerified?'Owner login verified · Etsy connected · Draft creation ready · Publishing disabled':'Owner login verified · Connect Etsy before saving a draft. You can generate a preview first.';el('prepareDraft').disabled=!connection.draftCreationEnabled;allowSave();
}).catch(()=>{el('readiness').textContent='Owner login verified · Etsy connection is not available yet. Preview generation remains available.';});
el('preparedForm').addEventListener('submit',async event=>{
 event.preventDefault();const file=el('preparedZip').files[0];if(!file)return;
 if(file.size>20000000){el('preparedStatus').textContent='Prepared ZIP must be 20 MB or smaller.';return;}
 el('prepareDraft').disabled=true;el('preparedZip').disabled=true;el('preparedLink').hidden=true;el('preparedStatus').textContent='Checking the product and category, uploading its draft, then verifying the saved details…';
 try{
  const body=new FormData();body.append('package',file);const {response,data}=await request('/studio/prepare',{method:'POST',body});
  if(data.reviewUrl){const url=new URL(data.reviewUrl);if(url.origin==='https://www.etsy.com'){el('preparedLink').href=url.href;el('preparedLink').hidden=false;}}
  if(!response.ok)throw new Error(data.error||'The draft could not be verified.');
  if(!data.readbackVerified)throw new Error('The upload finished, but Etsy verification is incomplete. Review the draft before publishing.');
  el('preparedStatus').textContent='Draft '+data.listingId+' is ready. Etsy read-back confirmed the listing details, price, AI disclosure, PDF and preview images. Open it in Etsy, review, and press Publish when you approve.';
 }catch(error){el('preparedStatus').textContent=error.message;el('prepareDraft').disabled=!connection?.draftCreationEnabled;}
 finally{el('preparedZip').disabled=false;}
});
el('form').addEventListener('submit',async event=>{
 event.preventDefault();const file=el('zip').files[0];if(!file)return;
 if(file.size>20000000){status.textContent='ZIP must be 20 MB or smaller.';return;}
 busy=true;el('go').disabled=true;el('result').hidden=true;selectedZip=null;allowSave();status.textContent='Inspecting ZIP and generating listing text…';
 try{
  const {response,data}=await request('/studio/preview',{method:'POST',headers:{'Content-Type':'application/zip','X-Book-Title':el('title').value.trim()},body:file});
  if(!response.ok)throw new Error(data.error||'Preview failed.');
  el('editTitle').value=data.listing.title;el('editDescription').value=data.listing.description;el('editTags').value=data.listing.tags.join(', ');el('price').value=data.listing.price.toFixed(2);
  el('files').textContent=[data.digitalFile,...data.images].map(f=>f.name+' ('+Math.round(f.bytes/1024)+' KB)').join('\n');
  el('hero').hidden=!data.heroDataUrl;if(data.heroDataUrl)el('hero').src=data.heroDataUrl;else el('hero').removeAttribute('src');
  selectedZip=file;draftComplete=false;el('reviewed').checked=false;draftStatus.textContent='';el('draftLink').hidden=true;el('result').hidden=false;
  status.textContent='Preview generated. No Etsy write requests were sent.';
 }catch(error){status.textContent=error.message;}finally{busy=false;el('go').disabled=false;allowSave();}
});
el('findCategory').addEventListener('click',async()=>{
 draftStatus.textContent='Finding Etsy categories…';
 try{
  const {response,data}=await request('/studio/taxonomy?q='+encodeURIComponent(el('categoryQuery').value));if(!response.ok)throw new Error(data.error||'Category search failed.');
  el('category').replaceChildren(new Option('Choose a category',''));for(const c of data.categories)el('category').add(new Option(c.name,c.id));
  draftStatus.textContent=data.categories.length?'Choose the category that matches your book.':'No categories found. Try another search.';allowSave();
 }catch(error){draftStatus.textContent=error.message;}
});
el('saveDraft').addEventListener('click',async()=>{
 if(el('saveDraft').disabled)return;busy=true;el('go').disabled=true;el('zip').disabled=true;allowSave();draftStatus.textContent='Creating your unpublished draft and uploading its files… Keep this page open.';
 const data=new FormData();data.append('package',selectedZip);data.append('listing',JSON.stringify({title:el('editTitle').value,description:el('editDescription').value,tags:el('editTags').value.split(',').map(x=>x.trim()),price:el('price').value,taxonomyId:Number(el('category').value),currency:connection.currency,reviewed:el('reviewed').checked}));
 try{
  const result=await request('/studio/draft',{method:'POST',body:data});
  if(result.data.reviewUrl){const target=new URL(result.data.reviewUrl);if(target.origin==='https://www.etsy.com'){el('draftLink').href=target.href;el('draftLink').hidden=false;}}
  if(!result.response.ok)throw new Error(result.data.error||'Draft could not be completed. Review Etsy before retrying.');
  draftComplete=true;draftStatus.textContent='Draft '+result.data.listingId+' saved with its PDF and preview images. It is unpublished. Review it in Etsy; publishing requires your separate approval.';
 }catch(error){draftStatus.textContent=error.message;}finally{busy=false;el('go').disabled=false;el('zip').disabled=false;allowSave();}
});
</script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'self' https://www.etsy.com; frame-ancestors 'none'; base-uri 'none'" } });
}
