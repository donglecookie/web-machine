export type SearchResult={title:string;url:string};
const EVAL_SOURCE=`(() => Array.from(document.querySelectorAll("a[href]"))
  .map((a) => ({ title: (a.textContent || "").trim(), url: a.href }))
  .filter((r) => r.title)
  .slice(0, 80))()`;

// Bing wraps organic result links in a /ck/a?...&u=a1<base64url> click-tracking redirect;
// unwrap it so we get the real destination instead of a bing.com URL.
function unwrapBingRedirect(href:string):string{
 try{
  const u=new URL(href);
  if(/(^|\.)bing\.com$/.test(u.hostname)&&u.pathname==="/ck/a"){
   let enc=u.searchParams.get("u")||"";
   if(enc.startsWith("a1"))enc=enc.slice(2);
   const decoded=Buffer.from(enc,"base64url").toString("utf8");
   if(/^https?:\/\//.test(decoded))return decoded;
  }
 }catch{}
 return href;
}

function isNoise(url:string):boolean{
 try{const h=new URL(url).hostname;return /(^|\.)bing\.com$/.test(h)||/(^|\.)microsoft\.com$/.test(h);}
 catch{return true;}
}

// Uses Bing's HTML search results via the existing browser page - no external search API/key needed.
export async function searchWeb(page:any,query:string):Promise<SearchResult[]>{
 await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`,{waitUntil:"domcontentloaded",timeout:30000});
 await page.waitForSelector("#b_results",{timeout:10000}).catch(()=>{});
 const raw=await page.evaluate(EVAL_SOURCE);
 const seen=new Set<string>();
 const results=raw
  .map((r:any)=>({title:r.title,url:unwrapBingRedirect(r.url)}))
  .filter((r:any)=>r.url&&/^https?:\/\//.test(r.url)&&!isNoise(r.url))
  .filter((r:any)=>{if(seen.has(r.url))return false;seen.add(r.url);return true;})
  .slice(0,8);
 if(!results.length){
  const title=await page.title().catch(()=>"?");
  const url=await page.url().catch(()=>"?");
  const snippet=await page.evaluate("document.body ? document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,300) : '(no body)'").catch(()=>"?");
  console.error(`search: no results parsed. landed on "${title}" (${url}), raw anchors: ${raw.length}, body snippet: ${JSON.stringify(snippet)}`);
 }
 return results;
}
