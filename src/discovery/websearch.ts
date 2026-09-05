import {z} from "zod";
import {HtmlMachine} from "../machine/HtmlMachine.js";
import {logger} from "../runtime/logger.js";
import type {Stagehand,Page} from "@browserbasehq/stagehand";
export type SearchResult={title:string;url:string};

const RESULTS_SCHEMA=z.object({
 results:z.array(z.object({title:z.string().nullable(),url:z.string().nullable()}))
});
const html=new HtmlMachine();

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
function isGoogleNoise(url:string):boolean{
 try{const h=new URL(url).hostname;return /(^|\.)google\.[a-z.]+$/.test(h)||/(^|\.)gstatic\.com$/.test(h);}
 catch{return true;}
}
function unwrapGoogleRedirect(href:string):string{
 try{
  const u=new URL(href);
  if(/(^|\.)google\.[a-z.]+$/.test(u.hostname)&&u.pathname==="/url"){
   const q=u.searchParams.get("q");
   if(q&&/^https?:\/\//.test(q))return q;
  }
 }catch{}
 return href;
}

// Primary strategy: use HtmlMachine to fetch a search engine's server-rendered HTML directly
// (no browser, no LLM) and pull organic result links from it. Fast and free; works because
// these results are present in the raw HTML response, not injected by client-side JS.
async function htmlSearch(engine:string,url:string,unwrap:(u:string)=>string,noise:(u:string)=>boolean):Promise<SearchResult[]>{
 const page=await html.fetchHtml(url);
 if(!page)return[];
 const seen=new Set<string>();
 const out:SearchResult[]=[];
 const allLinks=html.extractLinks(page,url);
 for(const link of allLinks){
  const u=unwrap(link.url);
  if(!u||!/^https?:\/\//.test(u)||noise(u)||seen.has(u)||!link.text)continue;
  seen.add(u);out.push({title:link.text,url:u});
  if(out.length>=8)break;
 }
 if(!out.length)logger.debug("search.no_matches",{engine,rawLinks:allLinks.length,pageLength:page.length});
 return out;
}

// Fallback strategy: if the plain HTML fetch is blocked/changed, use the browser + LLM to
// read the results page semantically instead of relying on brittle regex/selectors.
async function browserSearch(page:Page,stagehand:Stagehand,query:string):Promise<SearchResult[]>{
 await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`,{waitUntil:"domcontentloaded",timeout:30000});
 await page.waitForSelector("#b_results",{timeout:10000}).catch(()=>{});
 let extracted:{data?:z.infer<typeof RESULTS_SCHEMA>}|null=null;
 try{
  extracted=await stagehand.extract(
   "List the organic web search result titles and their destination URLs on this search results page. Ignore ads, the search engine's own navigation/help pages, and 'People also ask' boxes.",
   RESULTS_SCHEMA,
   {page,timeout:45000}
  );
 }catch(e){logger.error("search.extract_failed",{message:e instanceof Error?e.message:String(e)});}

 const seen=new Set<string>();
 return(((extracted?.data?.results)||[])
  .map(r=>({title:r.title||"",url:r.url?unwrapBingRedirect(r.url):""}))
  .filter((r:SearchResult)=>r.url&&/^https?:\/\//.test(r.url)&&!isNoise(r.url))
  .filter((r:SearchResult)=>{if(seen.has(r.url))return false;seen.add(r.url);return true;})
  .slice(0,8));
}

export async function searchWeb(page:Page,stagehand:Stagehand,query:string):Promise<SearchResult[]>{
 const bing=await htmlSearch("Bing",`https://www.bing.com/search?q=${encodeURIComponent(query)}`,unwrapBingRedirect,isNoise);
 if(bing.length)return bing;

 const google=await htmlSearch("Google",`https://www.google.com/search?q=${encodeURIComponent(query)}&num=10`,unwrapGoogleRedirect,isGoogleNoise);
 if(google.length)return google;

 logger.info("search.html_fetch_empty",{engines:"bing,google",fallback:"browser+llm extraction"});
 const results=await browserSearch(page,stagehand,query);
 if(!results.length){
  const title=await page.title().catch(()=>"?");
  logger.warn("search.no_usable_results",{title});
 }
 return results;
}
