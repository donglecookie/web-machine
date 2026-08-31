import {inspect,Candidate} from "../discovery/dom.js";
import {KEYWORD_RE,SUBMIT_INTENT_RE,RESET_INTENT_RE,DESTRUCTIVE_INTENT_RE,sameHost,resolveFileUrl,tokenize,relevanceRatioTokens,detectFileType,FileType} from "../discovery/patterns.js";
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
const TOP_N_BUTTON=30;
const TOP_N_LINK=15;
const RECAP_STEPS=8;
const DOWNLOADS_DIR="downloads";
const DEFAULT_MAX_LLM_CALLS=20;

// A per-run cap on actual LLM calls (observe + act), independent of maxSteps. maxSteps alone
// doesn't bound cost: a single "step" can trigger an observe() plus one or two act() calls
// (self-heal fallback, search-box typing). Passing one Budget across multiple resolve() calls
// (e.g. across several candidate sites in discoverAndFetch) lets the caller cap total spend
// for the whole job, not just per site.
export type Budget={llmCalls:number;maxLlmCalls:number};
export function newBudget(maxLlmCalls=DEFAULT_MAX_LLM_CALLS):Budget{return{llmCalls:0,maxLlmCalls};}

// A fixed candidate count can never be "right" for every site - some pages have 3 relevant
// links, others have hundreds. So instead of tuning the cap to any one site's volume, rank
// both buttons and content links by how well their own text matches the instruction (exam
// titles usually do share literal words with what's being searched for, e.g. "사회문화") and
// take the most relevant ones regardless of how many total candidates exist. This helps most
// for links; filter/selector button labels are often categorical rather than lexical (e.g. a
// "사회탐구" button won't textually match an instruction asking for "사회문화"), so relevance
// sorting is only a tie-break bonus there (ties fall back to original order, a stable sort) -
// which is why buttons still get a much broader inclusion cap than links.
function summarize(candidates:Candidate[],tokens:string[]):string{
 const byRelevance=(c:Candidate)=>relevanceRatioTokens(c.text,tokens);
 const nav=candidates.filter(c=>c.nav).slice(0,TOP_N_NAV);
 const buttons=candidates.filter(c=>!c.nav&&c.kind==="button")
  .map(c=>({c,r:byRelevance(c)})).sort((a,b)=>b.r-a.r).slice(0,TOP_N_BUTTON).map(x=>x.c);
 const links=candidates.filter(c=>!c.nav&&c.kind!=="button")
  .map(c=>({c,r:byRelevance(c)})).sort((a,b)=>b.r-a.r).slice(0,TOP_N_LINK).map(x=>x.c);
 const picked=[...nav,...buttons,...links].filter((c,i,arr)=>arr.findIndex(x=>x.text===c.text&&x.url===c.url)===i);
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

export async function resolve(stagehand:any,page:any,instruction:string,maxSteps=8,budget:Budget=newBudget()){
 const history:any[]=[];
 let budgetWarned=false;
 const fileType:FileType=detectFileType(instruction);
 const instructionTokens=tokenize(instruction); // instruction never changes across this run - tokenize once, not per loop iteration
 // observe() picks that get rejected (link/non-interactive/reset/destructive) don't go into
 // history, since they weren't real actions - but without SOME record, the next LLM call has
 // no idea a suggestion was already rejected and can re-propose the identical one. Tracked
 // separately (not in history) so it doesn't look like something we actually clicked.
 const rejectedPicks:string[]=[];
 // observe() already grounds a concrete selector, so execute it directly via the
 // Playwright-style Locator API (no LLM call) instead of re-asking the model what to do.
 // Only fall back to the LLM-driven act() (which re-reasons and self-heals) if the direct
 // click fails - e.g. the page changed shape between observing and clicking. Bounded to a
 // short timeout so a missing/stale selector fails fast into the fallback rather than
 // waiting out the locator's own default actionability timeout first.
 const clickFast=(selector:string)=>new Promise<boolean>(settle=>{
  const timer=setTimeout(()=>settle(false),8000);
  page.locator(selector).click().then(
   ()=>{clearTimeout(timer);settle(true);},
   ()=>{clearTimeout(timer);settle(false);}
  );
 });
 const act=(target:any)=>{budget.llmCalls++;return stagehand.act(target,{page,timeout:CALL_TIMEOUT}).then(()=>true,()=>false);};
 const click=async(selector:string,fallbackInstruction:string)=>await clickFast(selector)||await act(fallbackInstruction);

 // observe()'s xpath selectors and our own dom.ts CSS-path selectors are different formats
 // that can never be string-matched against each other, so we can't reliably look up "what
 // kind of element did the LLM just pick" from our candidate list. Resolve it directly
 // instead by evaluating the xpath's actual tag name - this is format-agnostic and lets us
 // enforce policy (e.g. "no links while a filter flow is incomplete") against what was
 // REALLY clicked, not just what we happened to list as a candidate.
 //
 // Also walks up to the nearest <a> ancestor (via closest()), not just the exact node: sites
 // commonly wrap an icon/span/div inside an <a> for styling, and observe() sometimes targets
 // that inner element rather than the anchor itself - checking only the exact tag missed this
 // twice in practice (once inert, once navigating to a completely unrelated result).
 async function resolveTarget(xpathSelector:string):Promise<{tagName:string;isInsideLink:boolean}|null>{
  if(!xpathSelector.startsWith("xpath="))return null;
  try{
   const raw=xpathSelector.slice(6);
   return await page.evaluate(`(() => {
    const r = document.evaluate(${JSON.stringify(raw)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const el = r.singleNodeValue;
    if (!el) return null;
    return { tagName: el.tagName, isInsideLink: Boolean(el.closest && el.closest('a')) };
   })()`);
  }catch{return null;}
 }
 // Structural/layout containers (page regions, headings) are never legitimate click targets,
 // regardless of filter-flow state - clicking one does nothing. Seen repeatedly in practice:
 // the model sometimes picks one of these instead of the actual button/link sitting inside or
 // near it (e.g. a <header> instead of the "받기" button it contains).
 const NON_INTERACTIVE_TAGS=new Set(["HEADER","MAIN","NAV","SECTION","ARTICLE","ASIDE","FOOTER","H1","H2","H3","H4","H5","H6"]);

 for(let i=0;i<maxSteps;i++){
  const url=await page.url().catch(()=>history[history.length-1]?.url||"");
  const resolvedCurrentUrl=resolveFileUrl(url,fileType);
  if(resolvedCurrentUrl)return{ok:true,url:resolvedCurrentUrl,history};

  const candidates=await inspect(page,fileType).catch(()=>[]);
  const direct=candidates.find(c=>c.url&&resolveFileUrl(c.url,fileType))
   ||candidates.find(c=>c.url&&sameHost(c.url,url)&&!isSamePageHash(c.url,url)&&KEYWORD_RE.test(c.text));
  if(direct?.url){const resolvedUrl=resolveFileUrl(direct.url,fileType)||direct.url;history.push({url,action:direct});return{ok:true,url:resolvedUrl,history};}

  // If the current page already shows a download-intent candidate (a "받기"-style button),
  // that's a strong signal this page itself is the destination, not a waypoint - there's no
  // good reason to navigate away to a "related item" link instead of using what's already
  // here. Seen in practice: on exactly such a page, the model picked a generic, low-relevance
  // sidebar link ("관련 시험 항목" / related exam item) instead of the visible "받기" button,
  // landing on a completely unrelated exam. This check is independent of filter-flow state,
  // since it happens well after any filter flow has already completed.
  const currentPageHasDownloadIntent=candidates.some(c=>KEYWORD_RE.test(c.text));

  // Exclude already-clicked selectors from the candidate text we show the LLM, and enforce
  // it as a hard constraint in the mechanical fallback below. Note this is not an absolute
  // guarantee for the LLM path: observe() inspects the live page itself, not just our text
  // hints, so it can in principle still name an already-clicked element - which is exactly
  // why the stuck-loop check further down remains a necessary second line of defense.
  const clicked=new Set(history.map(h=>h.action?.selector).filter(Boolean));

  // A prose instruction alone ("finish the filter flow before clicking a result link") isn't
  // reliable - LLMs sometimes ignore it and grab a keyword-matching-but-wrong-date link from
  // an unrelated "popular/featured" list anyway (seen repeatedly in practice). If recent
  // actions look like filter/category picks (short button-style labels, not a submit action)
  // but nothing matching search/submit intent has happened yet, treat the flow as incomplete
  // and reject any observe() pick that resolves to a real <a> link (checked directly below,
  // not by matching against our candidate list - selector formats differ and can't be
  // string-matched) - only filter buttons and the eventual submit button stay selectable.
  const hasPickedFilter=history.some(h=>h.action?.kind==="button"&&!h.action?.nav&&!SUBMIT_INTENT_RE.test(h.action?.text||""));
  const hasSubmitted=history.some(h=>SUBMIT_INTENT_RE.test(h.action?.text||""));
  const filterFlowIncomplete=hasPickedFilter&&!hasSubmitted;
  let freshCandidates=candidates.filter(c=>!(c.selector&&clicked.has(c.selector))&&!RESET_INTENT_RE.test(c.text));
  if(filterFlowIncomplete)freshCandidates=freshCandidates.filter(c=>c.kind!=="link");

  const beforeFiles=await snapshotDownloads();
  let acted=false;
  let selector:string|undefined;
  let actionText="";
  if(budget.llmCalls<budget.maxLlmCalls){
   try{
    budget.llmCalls++;
    const obs=await stagehand.observe(`Goal: find "${instruction}".

Prior actions this session (most recent last; the elements below are already excluded from the candidate list so you can't pick them again). Use this to judge whether a filter flow is still in progress:
${recap(history)}${rejectedPicks.length?`\n\nAlready rejected this session (not real progress - don't re-suggest these): ${rejectedPicks.slice(-5).join("; ")}`:""}

Page candidates:
${summarize(freshCandidates,instructionTokens)}

Next action:
- If any filters were already set in prior actions above (a category/date/etc. was picked, most recent last) but no search/submit button has been clicked yet, that flow is INCOMPLETE - pick the next unset filter, or the submit/search button, even if a matching-looking result link is also visible. A link that only coincidentally shares words with the goal (e.g. from a "popular/featured" list, not the actual filtered results) can be the wrong item entirely - finishing and submitting the filters first gets the genuinely matching result.
- Exact file link/button above (or elsewhere on page) -> pick it, once no filter flow is left incomplete.
- Already-clicked submit/search with no new results -> find an actual result link instead.
- Site search box visible and likely faster -> use it.
- Else -> most specific relevant nav (category/date/article), not generic links.
Only pick a genuinely clickable, interactive element (a real button or link) - never pick a heading, title, label, or other plain descriptive text just because it names the right thing; find the actual button/link near it instead.
Never pick actions that log out, delete, purchase, subscribe, or otherwise make an irreversible/account-affecting change - only read/navigate/search actions.`,{page,timeout:CALL_TIMEOUT});
    const next=obs?.data?.[0];
    const nextTarget=next?.selector?await resolveTarget(next.selector):null;
    const nextTag=nextTarget?.tagName??null;
    const nextIsLink=nextTag==="A"||Boolean(nextTarget?.isInsideLink);
    const nextIsNonInteractive=Boolean(nextTag&&NON_INTERACTIVE_TAGS.has(nextTag));
    const nextText=next?.description||"";
    const nextIsReset=RESET_INTENT_RE.test(nextText);
    const nextIsDestructive=DESTRUCTIVE_INTENT_RE.test(nextText);
    const nextLooksLikeDownload=KEYWORD_RE.test(nextText);
    const nextRelevance=relevanceRatioTokens(nextText,instructionTokens);
    const nextIsDistraction=currentPageHasDownloadIntent&&nextIsLink&&!nextLooksLikeDownload&&nextRelevance===0;
    const rejectPick=(filterFlowIncomplete&&nextIsLink)||nextIsNonInteractive||nextIsReset||nextIsDestructive||nextIsDistraction;
    if(next?.selector&&!rejectPick&&await click(next.selector,`Click "${next.description}".`)){
     selector=next.selector;
     actionText=next.description||"";
     history.push({url,action:{kind:nextIsLink?"link":"button",text:next.description,selector:next.selector}});
     if(/search|검색/i.test(next.description)){
      await page.waitForTimeout(300);
      await act(`Type "${instruction}" into the search input field and press Enter to submit the search.`);
      await page.waitForTimeout(1000);
     }
     acted=true;
    }else if(rejectPick){
     const reason=nextIsDestructive?"looks like a destructive/irreversible action (log out, delete, purchase, etc.)"
      :nextIsReset?"looks like a reset/clear action that would undo progress"
      :nextIsNonInteractive?`resolves to a non-interactive layout element (<${nextTag}>)`
      :nextIsDistraction?`navigates away to an unrelated page (relevance ${(nextRelevance*100).toFixed(0)}%) while a download button is already visible on the current page`
      :`resolves to a link (${nextTag==="A"?"<a>":`<${nextTag}> inside an <a>`}) while a filter flow looks incomplete`;
     rejectedPicks.push(nextText);
     console.error(`resolve: rejected observe() pick "${next.description}" - it ${reason}; falling back to mechanical selection.`);
    }
   }catch(e){
    const msg=e instanceof Error?e.message:String(e);
    console.error("observe step failed:",msg);
    // A payment/credits error (e.g. an exhausted OpenRouter balance) will fail identically on
    // every subsequent call too - retrying wastes the rest of the step budget on calls that
    // are certain to fail. Treat it like budget exhaustion: stop attempting the LLM path for
    // the remainder of this run and rely on the free mechanical fallback instead.
    if(/\b402\b|insufficient.*credit|requires more credits|payment required/i.test(msg)){
     budget.llmCalls=budget.maxLlmCalls;
     if(!budgetWarned){console.error("resolve: LLM provider rejected the request for insufficient credits - continuing with free heuristic clicks only.");budgetWarned=true;}
    }
   }
  }else if(!budgetWarned){
   console.error(`resolve: LLM call budget exhausted (${budget.maxLlmCalls}) - continuing with free heuristic clicks only.`);
   budgetWarned=true;
  }

  if(!acted){
   // Prefer non-nav (content/filter) candidates over generic chrome (menu/home links): with
   // no LLM guidance, blindly clicking a nav link is far more likely to reset/reload the page
   // (losing any expanded filter state) than to make real progress. Also rank by relevance to
   // the instruction first (same scoring summarize() already uses for the prompt text) rather
   // than raw DOM order - seen in practice: a genuinely matching filter/result (e.g. a
   // "사회·문화 문제지" button) can sit later in the DOM than several irrelevant ones (grade/
   // subject buttons for unrelated values), and raw-order selection picks the wrong one first.
   // Uses clickFast() only (never the LLM self-heal fallback) so this path stays free even
   // once the budget is spent.
   const byRelevance=[...freshCandidates].sort((a,b)=>relevanceRatioTokens(b.text,instructionTokens)-relevanceRatioTokens(a.text,instructionTokens));
   const action=byRelevance.find(c=>!c.nav&&(c.kind==="button"||c.kind==="link"))
    ||byRelevance.find(c=>c.kind==="button"||c.kind==="link");
   if(!action)break;
   selector=action.selector;
   actionText=action.text||"";
   history.push({url,action});
   const ok=action.selector
    ?await clickFast(action.selector)
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
   const resolvedPostClickUrl=resolveFileUrl(postClickUrl,fileType);
   if(resolvedPostClickUrl)return{ok:true,url:resolvedPostClickUrl,history};
   if(KEYWORD_RE.test(actionText))console.error(`resolve: after clicking "${actionText}", current URL is: ${postClickUrl} (unchanged from before: ${postClickUrl===url})`);
  }

  await page.waitForTimeout(500);
 }
 return{ok:false,history};
}
