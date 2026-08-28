import {z} from "zod";
export type SearchResult={title:string;url:string};

const RESULTS_SCHEMA=z.object({
 results:z.array(z.object({title:z.string().nullable(),url:z.string().nullable()}))
});

// Bing wraps organic result links in a /ck/a?...&u=a1<base64url> click-tracking redirect;
// unwrap it to get the real destination.
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

function decodeEntities(s:string):string{
 return s.replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">");
}

const HTML_RESULT_RE=/<h2>\s*<a\s+href="([^"]+)"[^>]*>(.*?)<\/a>\s*<\/h2>/gis;

// Primary strategy: fetch Bing's server-rendered HTML directly (no browser, no LLM) and
// regex-parse the organic result links. Fast and free; works because these results are
// present in the raw HTML response, not injected by client-side JS.
async function fetchHtmlResults(query:string):Promise<SearchResult[]>{
 const res=await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`,{
  headers:{
   "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
   "Accept-Language":"en-US,en;q=0.9"
  }
 }).catch(()=>null);
 if(!res||!res.ok)return[];
 const html=await res.text();
 const seen=new Set<string>();
 const out:SearchResult[]=[];
 for(const m of html.matchAll(HTML_RESULT_RE)){
  const url=unwrapBingRedirect(m[1]);
  const title=decodeEntities(m[2].replace(/<[^>]+>/g,"")).trim();
  if(!url||!/^https?:\/\//.test(url)||isNoise(url)||seen.has(url))continue;
  seen.add(url);
  out.push({title,url});
  if(out.length>=8)break;
 }
 return out;
}

// Fallback strategy: if the plain HTML fetch is blocked/changed, use the existing browser +
// LLM to read the results page semantically instead of relying on brittle regex/selectors.
async function extractResultsViaBrowser(page:any,stagehand:any,query:string):Promise<SearchResult[]>{
 await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`,{waitUntil:"domcontentloaded",timeout:30000});
 await page.waitForSelector("#b_results",{timeout:10000}).catch(()=>{});
 let extracted:any=null;
 try{
  extracted=await stagehand.extract(
   "List the organic web search result titles and their destination URLs on this search results page. Ignore ads, the search engine's own navigation/help pages, and 'People also ask' boxes.",
   RESULTS_SCHEMA,
   {page,timeout:45000}
  );
 }catch(e){console.error("search: browser fallback extract() threw:",e instanceof Error?e.message:String(e));}

 const seen=new Set<string>();
 return((extracted?.data?.results)||[])
  .map((r:any)=>({title:r.title||"",url:r.url?unwrapBingRedirect(r.url):""}))
  .filter((r:SearchResult)=>r.url&&/^https?:\/\//.test(r.url)&&!isNoise(r.url))
  .filter((r:SearchResult)=>{if(seen.has(r.url))return false;seen.add(r.url);return true;})
  .slice(0,8);
}

export async function searchWeb(page:any,stagehand:any,query:string):Promise<SearchResult[]>{
 const direct=await fetchHtmlResults(query);
 if(direct.length)return direct;
 console.error("search: plain HTML fetch returned no results, falling back to browser+LLM extraction");
 const results=await extractResultsViaBrowser(page,stagehand,query);
 if(!results.length){
  const title=await page.title().catch(()=>"?");
  console.error(`search: no usable results on "${title}" either`);
 }
 return results;
}
