import {inspect,Candidate} from "../discovery/dom.js";
import {FILE_RE,KEYWORD_RE,sameHost} from "../discovery/patterns.js";
import {readdir} from "node:fs/promises";

// Strategy order (most general/common first, most site-specific last):
// 1. Direct match already visible on the page (PDF link / same-site download) - zero LLM calls
// 2. One grounded LLM decision per step: given the ranked DOM candidates, either click one,
//    use the site's search feature (if visible), or navigate somewhere more specific.
// 3. Mechanical fallback: click the top-scoring unclicked candidate if the LLM step fails.
// After any click, also check whether it triggered a native browser download (common for
// JS-driven "download" buttons that never expose a plain href), and whether it opened a new
// tab (common for the same reason) - in which case tracking switches to that tab.

const CALL_TIMEOUT=60000;
const TOP_N_NAV=4;
const TOP_N_CONTENT=6;
const RECAP_STEPS=8;
const DOWNLOADS_DIR="downloads";

function summarize(candidates:Candidate[]):string{
 const nav=candidates.filter(c=>c.nav).slice(0,TOP_N_NAV);
 const content=candidates.filter(c=>!c.nav).slice(0,TOP_N_CONTENT);
 const picked=[...nav,...content].filter((c,i,arr)=>arr.findIndex(x=>x.text===c.text&&x.url===c.url)===i);
 return picked.map((c,i)=>`${i+1}. [${c.kind}${c.nav?"/nav":""}] "${c.text.slice(0,80)}"${c.url?` -> ${c.url}`:""}`).join("\n")||"(none)";
}

// Short-term memory of what this same resolve() run has already tried, so multi-step flows
// (e.g. selecting several filters before a search button becomes meaningful) aren't repeated
// or forgotten between steps - each LLM call otherwise reasons from a blank slate.
function recap(history:any[]):string{
 const recent=history.slice(-RECAP_STEPS);
 if(!recent.length)return"(none - first step)";
 return recent.map((h,i)=>`${i+1}. "${h.action?.text||h.action?.description||"?"}"`).join("\n");
}

function isSamePageHash(candidateUrl:string,currentUrl:string):boolean{
 try{
  const c=new URL(candidateUrl),u=new URL(currentUrl);
  return c.origin===u.origin&&c.pathname===u.pathname&&c.search===u.search&&c.hash!=="";
 }catch{return false;}
}

async function snapshotDownloads():Promise<Set<string>>{
 try{return new Set(await readdir(DOWNLOADS_DIR));}catch{return new Set();}
}

async function newDownloadedFile(before:Set<string>):Promise<string|null>{
 try{
  const after=await readdir(DOWNLOADS_DIR);
  const added=after.find(f=>!before.has(f)&&!f.endsWith(".crdownload")&&!f.endsWith(".tmp"));
  return added?`${DOWNLOADS_DIR}/${added}`:null;
 }catch{return null;}
}

// A click can open a new tab or kill the old tab's session (common for JS-driven download
// buttons/popups). After acting, re-sync to whichever page is actually alive/current.
async function syncActivePage(stagehand:any,current:any):Promise<any>{
 try{
  const pages=await stagehand.browser.context.pages();
  if(!pages.length)return current;
  if(current){
   try{if(pages.some((p:any)=>p.pageId===current.pageId))return current;}catch{}
  }
  return pages[pages.length-1];
 }catch{return current;}
}

export async function resolve(stagehand:any,page:any,instruction:string,maxSteps=8){
 const history:any[]=[];
 // observe() already grounds a concrete selector, so execute it directly via the
 // Playwright-style Locator API (no LLM call) instead of re-asking the model what to do.
 // Only fall back to the LLM-driven act() (which re-reasons and self-heals) if the direct
 // click fails - e.g. the page changed shape between observing and clicking. Bounded to a
 // short timeout so a missing/stale selector fails fast into the fallback rather than
 // waiting out the locator's own default actionability timeout first.
 const clickFast=(selector:string)=>new Promise<boolean>(resolve=>{
  const timer=setTimeout(()=>resolve(false),8000);
  page.locator(selector).click().then(
   ()=>{clearTimeout(timer);resolve(true);},
   ()=>{clearTimeout(timer);resolve(false);}
  );
 });
 const act=(target:any)=>stagehand.act(target,{page,timeout:CALL_TIMEOUT}).then(()=>true,()=>false);
 const click=async(selector:string,fallbackInstruction:string)=>await clickFast(selector)||await act(fallbackInstruction);

 for(let i=0;i<maxSteps;i++){
  const url=await page.url().catch(()=>history[history.length-1]?.url||"");
  if(FILE_RE.test(url))return{ok:true,url,history};

  const candidates=await inspect(page).catch(()=>[]);
  const direct=candidates.find(c=>c.url&&FILE_RE.test(c.url))
   ||candidates.find(c=>c.url&&sameHost(c.url,url)&&!isSamePageHash(c.url,url)&&KEYWORD_RE.test(c.text));
  if(direct?.url){history.push({url,action:direct});return{ok:true,url:direct.url,history};}

  const beforeFiles=await snapshotDownloads();
  let acted=false;
  let selector:string|undefined;
  try{
   const obs=await stagehand.observe(`Goal: find "${instruction}".

Prior actions this session (don't repeat; if mid-flow through filters, continue it):
${recap(history)}

Page candidates:
${summarize(candidates)}

Next action:
- Exact file link/button above (or elsewhere on page) -> pick it.
- Mid multi-step filter flow -> pick next unset filter, then submit.
- Already-clicked submit/search with no new results -> don't click it again; find an actual result link instead.
- Site search box visible and likely faster -> use it.
- Else -> most specific relevant nav (category/date/article), not generic links.
Never repeat a prior action or pick something that leaves the page unchanged.
Never pick actions that log out, delete, purchase, subscribe, or otherwise make an irreversible/account-affecting change - only read/navigate/search actions.`,{page,timeout:CALL_TIMEOUT});
   const next=obs?.data?.[0];
   if(next?.selector&&await click(next.selector,`Click "${next.description}".`)){
    selector=next.selector;
    history.push({url,action:{kind:"observe",text:next.description,selector:next.selector}});
    if(/search|검색/i.test(next.description)){
     await page.waitForTimeout(300);
     await act(`Type "${instruction}" into the search input field and press Enter to submit the search.`);
     await page.waitForTimeout(1000);
    }
    acted=true;
   }
  }catch(e){console.error("observe step failed:",e instanceof Error?e.message:String(e));}

  if(!acted){
   const clicked=new Set(history.map(h=>h.action?.selector).filter(Boolean));
   const action=candidates.find(c=>(c.kind==="button"||c.kind==="link")&&!(c.selector&&clicked.has(c.selector)));
   if(!action)break;
   selector=action.selector;
   history.push({url,action});
   const ok=action.selector
    ?await click(action.selector,`Click the element with selector ${action.selector}.`)
    :action.url
    ?await page.goto(action.url,{waitUntil:"domcontentloaded",timeout:CALL_TIMEOUT}).then(()=>true,()=>false)
    :false;
   if(!ok)break;
   acted=true;
  }

  // Genuine stuck-loop detection: the exact same element chosen twice in a row, despite being
  // told not to. (URL staying the same is NOT itself a sign of being stuck - many sites drive
  // multi-step filter flows entirely through client-side state on one URL.)
  const prev=history[history.length-2]?.action?.selector;
  if(selector&&selector===prev){
   console.error(`resolve: clicked the same element twice in a row ("${selector}") with no detectable file/download - stopping.`);
   break;
  }

  if(acted){
   await page.waitForTimeout(3000);
   page=await syncActivePage(stagehand,page);
   const downloadedFile=await newDownloadedFile(beforeFiles);
   if(downloadedFile)return{ok:true,downloadedFile,history};
   const postClickUrl=await page.url().catch(()=>"");
   if(FILE_RE.test(postClickUrl))return{ok:true,url:postClickUrl,history};
  }

  await page.waitForTimeout(500);
 }
 return{ok:false,history};
}
