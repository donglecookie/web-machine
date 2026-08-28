import {inspect,Candidate} from "../discovery/dom.js";
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
const FILE_RE=/\.pdf(?:$|[?#])/i;
const KEYWORD_RE=/download|attachment|첨부|다운로드|pdf/i;
const DOWNLOADS_DIR="downloads";

function summarize(candidates:Candidate[]):string{
 const nav=candidates.filter(c=>c.nav).slice(0,TOP_N_NAV);
 const content=candidates.filter(c=>!c.nav).slice(0,TOP_N_CONTENT);
 const picked=[...nav,...content].filter((c,i,arr)=>arr.findIndex(x=>x.text===c.text&&x.url===c.url)===i);
 return picked.map((c,i)=>`${i+1}. [${c.kind}${c.nav?"/nav":""}] "${c.text.slice(0,80)}"${c.url?` -> ${c.url}`:""}`).join("\n")||"(none detected)";
}

// Short-term memory of what this same resolve() run has already tried, so multi-step flows
// (e.g. selecting several filters before a search button becomes meaningful) aren't repeated
// or forgotten between steps - each LLM call otherwise reasons from a blank slate.
function recap(history:any[]):string{
 const recent=history.slice(-4);
 if(!recent.length)return"(nothing yet - this is the first step)";
 return recent.map((h,i)=>`${i+1}. clicked "${h.action?.text||h.action?.description||"?"}"`).join("\n");
}

function sameHost(a:string,b:string):boolean{
 try{return new URL(a).hostname===new URL(b).hostname;}catch{return false;}
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
 const act=(target:any)=>stagehand.act(target,{page,timeout:CALL_TIMEOUT}).then(()=>true,()=>false);

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
   const obs=await stagehand.observe(`Goal: find "${instruction}" on this site.

Actions already taken so far on this site (most recent last) - do not repeat these, and if they look like partial progress through a multi-step filter/selection flow, continue that flow (e.g. if a grade/level was already selected, select the matching date/subject next, then submit):
${recap(history)}

Candidate links/buttons already detected on this page (may be incomplete or approximate):
${summarize(candidates)}

Pick the single best next action:
- If one of the candidates above (or another visible link) leads directly to the exact file, choose it.
- If this page has a multi-step filter/search UI (e.g. pick a category, then a date, then submit) and some filters are already selected per the actions above, pick the next unset filter or the submit/search button.
- If a search box is visible and would likely be faster or more reliable than browsing, choose that instead.
- Otherwise choose the most specific/relevant navigation (category, date, article) over generic or unrelated links.
Avoid choosing something that would leave the page unchanged or repeat an action already taken.`,{page,timeout:CALL_TIMEOUT});
   const next=obs?.data?.[0];
   if(next?.selector&&await act(next)){
    selector=next.selector;
    history.push({url,action:{kind:"observe",text:next.description,selector:next.selector}});
    if(/search/i.test(next.description)){
     await page.waitForTimeout(300);
     await act(`Type "${instruction}" into the search input field and press Enter to submit the search.`);
     await page.waitForTimeout(1000);
    }
    acted=true;
   }
  }catch(e){console.error("observe step failed:",e instanceof Error?e.message:String(e));}

  if(!acted){
   const action=candidates.find(c=>c.kind==="button"||c.kind==="link");
   if(!action)break;
   selector=action.selector;
   history.push({url,action});
   const ok=action.selector
    ?await act(`Click the element with selector ${action.selector}.`)
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
  if(selector&&selector===prev)break;

  if(acted){
   await page.waitForTimeout(1200);
   const downloadedFile=await newDownloadedFile(beforeFiles);
   if(downloadedFile)return{ok:true,downloadedFile,history};
   page=await syncActivePage(stagehand,page);
  }

  await page.waitForTimeout(500);
 }
 return{ok:false,history};
}
