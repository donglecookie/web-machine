export type SearchResult={title:string;url:string};
const EVAL_SOURCE=`(() => {
  const primary = Array.from(document.querySelectorAll(".result__a"));
  const source = primary.length ? primary : Array.from(document.querySelectorAll("a[href]")).filter((a) => a.href && !a.href.includes("duckduckgo.com"));
  return source.map((a) => ({ title: (a.textContent || "").trim(), url: a.href })).slice(0, 15);
})()`;

// Uses DuckDuckGo's no-JS HTML endpoint via the existing browser page - no external search API/key needed.
export async function searchWeb(page:any,query:string):Promise<SearchResult[]>{
 await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,{waitUntil:"domcontentloaded",timeout:30000});
 const raw=await page.evaluate(EVAL_SOURCE);
 return raw.map((r:any)=>{
  try{
   const u=new URL(r.url,"https://duckduckgo.com");
   const real=u.searchParams.get("uddg");
   return{title:r.title,url:real?decodeURIComponent(real):r.url};
  }catch{return r;}
 }).filter((r:any)=>r.url&&/^https?:\/\//.test(r.url)&&!r.url.includes("duckduckgo.com")).slice(0,8);
}
