export type SearchResult={title:string;url:string};
const EVAL_SOURCE=`(() => {
  const primary = Array.from(document.querySelectorAll(".b_algo h2 a"));
  const source = primary.length ? primary : Array.from(document.querySelectorAll("a[href]")).filter((a) => a.href && !a.href.includes("bing.com") && !a.href.includes("microsoft.com"));
  return source.map((a) => ({ title: (a.textContent || "").trim(), url: a.href })).slice(0, 15);
})()`;

// Uses Bing's plain HTML search results via the existing browser page - no external search API/key needed.
export async function searchWeb(page:any,query:string):Promise<SearchResult[]>{
 await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`,{waitUntil:"domcontentloaded",timeout:30000});
 const raw=await page.evaluate(EVAL_SOURCE);
 const results=raw.map((r:any)=>({title:r.title,url:r.url}))
  .filter((r:any)=>r.url&&/^https?:\/\//.test(r.url)&&!r.url.includes("bing.com"))
  .slice(0,8);
 if(!results.length){
  const title=await page.title().catch(()=>"?");
  const url=await page.url().catch(()=>"?");
  const snippet=await page.evaluate("document.body ? document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,300) : '(no body)'").catch(()=>"?");
  console.error(`search: no results parsed. landed on "${title}" (${url}), raw anchors: ${raw.length}, body snippet: ${JSON.stringify(snippet)}`);
 }
 return results;
}
