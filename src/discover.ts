import {searchWeb} from "./discovery/websearch.js";
import {newBudget} from "./files/resolver.js";

// Given only a query (no site), find the target file by:
// 1. Searching the web for candidate sites likely to host it (our own extract()-based search layer).
// 2. Trying each candidate in turn with the same site-navigation engine (WebMachine.fetch),
//    since visiting any particular site is just a means to the end of getting the content.
export async function discoverAndFetch(machine:any,stagehand:any,query:string,maxSites=3,maxStepsPerSite=6){
 if(!machine.page)return{ok:false,message:"machine.open() must be called before discoverAndFetch().",attempts:[]};
 const results=await searchWeb(machine.page,stagehand,query);
 if(!results.length)return{ok:false,message:"Web search returned no candidate sites.",attempts:[]};

 // One shared LLM-call budget across every candidate site, not a fresh one per site - so a
 // multi-site search job has an overall cost ceiling instead of up to maxSites times the
 // per-site ceiling.
 const budget=newBudget(40);
 const attempts:any[]=[];
 for(const r of results.slice(0,maxSites)){
  try{
   await machine.open(r.url);
   const outcome=await machine.fetch(query,maxStepsPerSite,budget);
   attempts.push({site:r.url,title:r.title,outcome});
   if(outcome.ok)return{...outcome,site:r.url,attempts};
  }catch(e){
   attempts.push({site:r.url,title:r.title,error:e instanceof Error?e.message:String(e)});
  }
 }
 return{ok:false,message:"No candidate site yielded the target file.",attempts};
}
