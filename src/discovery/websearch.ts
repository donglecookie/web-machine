export type SearchResult={title:string;url:string};

// Brave Search API - a real, ToS-compliant search API (free tier available), unlike scraping
// a search engine's results page directly, which is fragile and often blocked by bot detection.
export async function searchWeb(query:string):Promise<SearchResult[]>{
 const apiKey=process.env.BRAVE_API_KEY;
 if(!apiKey)throw new Error("BRAVE_API_KEY is not set. Get a free key at https://brave.com/search/api/");
 const res=await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`,{
  headers:{Accept:"application/json","X-Subscription-Token":apiKey}
 });
 if(!res.ok)throw new Error(`Brave Search API error: HTTP ${res.status}`);
 const data:any=await res.json();
 const results=(data?.web?.results||[]).map((r:any)=>({title:r.title||"",url:r.url}));
 return results.filter((r:SearchResult)=>r.url).slice(0,8);
}
