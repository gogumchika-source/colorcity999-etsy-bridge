// Owner-authenticated transfer form for agent-prepared product data.
// Uses ordinary form input, not browser-local file URLs or exported session credentials.
export function renderProductTransfer() {
  const nonce = crypto.randomUUID();
  return new Response(String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ColorCity999 | Prepared product transfer</title><style>
*{box-sizing:border-box}body{font:16px system-ui;background:#f6f3ff;color:#292137;padding:28px 16px;margin:0}main{max-width:850px;margin:auto;background:white;padding:28px;border-radius:20px}p{line-height:1.6;color:#675e76}label{display:block;font-weight:650;margin:20px 0 8px}textarea{width:100%;height:140px;resize:vertical;border:1px solid #c8bfd9;border-radius:10px;padding:12px;font:12px monospace}button{border:0;border-radius:10px;background:#7549c9;color:white;padding:13px 18px;font-weight:700;margin:16px 8px 0 0;cursor:pointer}button:disabled{opacity:.5;cursor:default}.status{white-space:pre-wrap;margin-top:20px;line-height:1.6}a{color:#6239aa}[hidden]{display:none!important}
</style></head><body><main><h1>Prepared product transfer</h1><p>Your assistant transfers the checked product here, verifies the files and listing details, then uploads an unpublished draft. You review and publish in Etsy.</p>
<form id="transferForm"><label for="productData">Prepared product data</label><textarea id="productData" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="26666668"></textarea>
<button type="button" id="checkTransfer">Check product transfer</button><button type="button" id="uploadTransfer" disabled>Upload unpublished draft</button></form>
<div class="status" id="transferStatus" role="status"></div><a id="reviewDraft" hidden target="_blank" rel="noopener noreferrer">Open draft in Etsy to review and publish</a>
<p>Default price: $9.99 USD. AI-artwork disclosure included. Publishing is disabled in Studio.</p></main>
<script nonce="${nonce}">
const data=document.getElementById('productData'),check=document.getElementById('checkTransfer'),upload=document.getElementById('uploadTransfer'),status=document.getElementById('transferStatus'),link=document.getElementById('reviewDraft');
let verifiedData=null;
data.addEventListener('input',()=>{verifiedData=null;upload.disabled=true;link.hidden=true;});
async function transfer(dryRun){
 const encoded=data.value.replace(/\s/g,'');
 if(!encoded||encoded.length>26666668||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)){status.textContent='The prepared product data is missing or invalid.';return;}
 if(!dryRun&&verifiedData!==encoded){status.textContent='Check this product transfer before uploading.';return;}
 check.disabled=true;upload.disabled=true;data.disabled=true;status.textContent=dryRun?'Checking product files, listing details and the Etsy category…':'Uploading the unpublished draft and verifying the saved result in Etsy…';
 try{
  const binary=atob(encoded);if(binary.length>20000000)throw new Error('Prepared product exceeds 20 MB.');
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0)),form=new FormData();form.append('package',new Blob([bytes],{type:'application/zip'}),'prepared-product.zip');
  const response=await fetch(dryRun?'/studio/check-package':'/studio/prepare',{method:'POST',body:form});let result;
  try{result=await response.json();}catch{throw new Error('The session or transfer was interrupted. Reload and sign in if needed.');}
  if(result.reviewUrl){const url=new URL(result.reviewUrl);if(url.origin==='https://www.etsy.com'){link.href=url.href;link.hidden=false;}}
  if(!response.ok)throw new Error(result.error||'Product transfer failed.');
  if(dryRun){
   if(!result.checked||!result.noEtsyWritesPerformed)throw new Error('Product verification was incomplete.');
   verifiedData=encoded;status.textContent='Product transfer checked. No Etsy listing was created.\n'+result.title+'\n'+result.category.name+'\n'+result.tags.length+' tags · '+result.currency+' '+Number(result.price).toFixed(2)+' · AI disclosure included\nPDF and '+result.packageChecks.images.length+' preview images verified.';
  }else{
   if(!result.readbackVerified)throw new Error('The draft was uploaded, but the saved result is not fully verified. Review it in Etsy.');
   verifiedData=null;data.value='';status.textContent='Draft '+result.listingId+' is ready. Saved title, description, tags, price, category, PDF and preview images were checked in Etsy. You can review it and press Publish when you approve.';
  }
 }catch(error){status.textContent=error.message;}finally{check.disabled=false;data.disabled=false;upload.disabled=!verifiedData;}
}
check.addEventListener('click',()=>transfer(true));upload.addEventListener('click',()=>transfer(false));
</script></body></html>`, { headers: { 'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',
    'Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } });
}
