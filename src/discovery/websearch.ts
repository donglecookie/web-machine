import {z} from "zod";
export type SearchResult={title:string;url:string};

const RESULTS_SCHEMA=z.object({
 results:z.array(z.object({title:z.string().nullable(),url:z.string().nullable()}))
});

// Bing wraps organic result links in a /ck/a?...&u=a1<base64url> click-tracking redirect;
// unwrap it in case the raw href (rather than the rendered destination) comes through.
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

// Our own lightweight "Browserbase Search"-style layer: reuse the existing browser + LLM
// (no separate search API/key) and have the model read the results page semantically instead
// of relying on brittle CSS selectors, so it keeps working even if the markup changes.
export async function searchWeb(page:any,stagehand:any,query:string):Promise<SearchResult[]>{
 await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`,{waitUntil:"domcontentloaded",timeout:30000});
 await page.waitForSelector("#b_results",{timeout:10000}).catch(()=>{});
 let extracted:any=null;
 try{
  extracted=await stagehand.extract(
   "List the organic web search result titles and their destination URLs on this search results page. Ignore ads, the search engine's own navigation/help pages, and 'People also ask' boxes.",
   RESULTS_SCHEMA,
   {page,timeout:45000}
  );
 }catch(e){console.error("search: extract() threw:",e instanceof Error?e.message:String(e));}

 const seen=new Set<string>();
 const results=((extracted?.data?.results)||[])
  .map((r:any)=>({title:r.title||"",url:r.url?unwrapBingRedirect(r.url):""}))
  .filter((r:SearchResult)=>r.url&&/^https?:\/\//.test(r.url)&&!isNoise(r.url))
  .filter((r:SearchResult)=>{if(seen.has(r.url))return false;seen.add(r.url);return true;})
  .slice(0,8);

 if(!results.length){
  const title=await page.title().catch(()=>"?");
  console.error(`search: no usable results on "${title}". raw extracted.data:`,JSON.stringify(extracted?.data));
 }
 return results;
}
