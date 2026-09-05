import {inspect,Candidate} from "../discovery/dom.js";
import {KEYWORD_RE,SUBMIT_INTENT_RE,RESET_INTENT_RE,DESTRUCTIVE_INTENT_RE,sameHost,resolveFileUrl,tokenize,relevanceRatioTokens,computeTokenWeights,detectFileType,FileType} from "../discovery/patterns.js";
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
const MAIN_SCOPE_MISS_LIMIT=2;

// Structural/layout containers (page regions, headings) are never legitimate click targets,
// regardless of filter-flow state - clicking one does nothing. Seen repeatedly in practice:
// the model sometimes picks one of these instead of the actual button/link sitting inside or
// near it (e.g. a <header> instead of the "받기" button it contains).
const NON_INTERACTIVE_TAGS=new Set(["HEADER","MAIN","NAV","SECTION","ARTICLE","ASIDE","FOOTER","H1","H2","H3","H4","H5","H6"]);

// A prose instruction alone ("finish the filter flow before clicking a result link") isn't
// reliable - LLMs sometimes ignore it and grab a keyword-matching-but-wrong-date link from an
// unrelated "popular/featured" list anyway (seen repeatedly in practice). If recent actions
// look like filter/category picks (button clicks, not a submit action) but nothing matching
// search/submit intent has happened yet, the flow is incomplete. Pure function over history
// alone, independently testable without any browser/page dependency.
export function isFilterFlowIncomplete(history:any[]):boolean{
 const hasPickedFilter=history.some(h=>h.action?.kind==="button"&&!h.action?.nav&&!SUBMIT_INTENT_RE.test(h.action?.text||""));
 const hasSubmitted=history.some(h=>SUBMIT_INTENT_RE.test(h.action?.text||""));
 return hasPickedFilter&&!hasSubmitted;
}

export type PickEvaluation={reject:boolean;reason?:string;isLink:boolean};

// Decides whether an observe() pick should be honored or rejected, and why. Deliberately pure
// (plain data in, plain data out, no page/stagehand/selector-resolution inside) so this - the
// actual policy the whole reject/fallback mechanism hinges on - can be unit tested directly
// with plain objects, rather than only ever exercised indirectly through a real browser run.
export function evaluatePick(params:{
 tag:string|null;
 isInsideLink:boolean;
 description:string;
 filterFlowIncomplete:boolean;
 currentPageHasDownloadIntent:boolean;
 relevance:number;
}):PickEvaluation{
 const isLink=params.tag==="A"||params.isInsideLink;
 const isNonInteractive=Boolean(params.tag&&NON_INTERACTIVE_TAGS.has(params.tag));
 const isReset=RESET_INTENT_RE.test(params.description);
 const isDestructive=DESTRUCTIVE_INTENT_RE.test(params.description);
 const looksLikeDownload=KEYWORD_RE.test(params.description);
 const isDistraction=params.currentPageHasDownloadIntent&&isLink&&!looksLikeDownload&&params.relevance===0;
 const reject=(params.filterFlowIncomplete&&isLink)||isNonInteractive||isReset||isDestructive||isDistraction;
 if(!reject)return{reject:false,isLink};
 const reason=isDestructive?"looks like a destructive/irreversible action (log out, delete, purchase, etc.)"
  :isReset?"looks like a reset/clear action that would undo progress"
  :isNonInteractive?`resolves to a non-interactive layout element (<${params.tag}>)`
  :isDistraction?`navigates away to an unrelated page (relevance ${(params.relevance*100).toFixed(0)}%) while a download button is already visible on the current page`
  :`resolves to a link (${params.tag==="A"?"<a>":`<${params.tag}> inside an <a>`}) while a filter flow looks incomplete`;
 return{reject:true,reason,isLink};
}

// The judgment-free mechanical fallback's candidate choice: prefer non-nav (content/filter)
// candidates over generic chrome (menu/home links) - with no LLM guidance, blindly clicking a
// nav link is far more likely to reset/reload the page (losing any expanded filter state)
// than to make real progress - and rank by relevance to the instruction first rather than raw
// DOM order (a genuinely matching filter/result can sit later in the DOM than several
// irrelevant ones, and raw-order selection would pick the wrong one first).
export function pickFallbackCandidate(candidates:Candidate[],score:(c:Candidate)=>number):Candidate|undefined{
 const byRelevance=[...candidates].sort((a,b)=>score(b)-score(a));
 return byRelevance.find(c=>!c.nav&&(c.kind==="button"||c.kind==="link"))
  ||byRelevance.find(c=>c.kind==="button"||c.kind==="link");
}

// A per-run cap on actual LLM calls (observe + act), independent of maxSteps. maxSteps alone
// doesn't bound cost: a single "step" can trigger an observe() plus one or two act() calls
// (self-heal fallback, search-box typing). Passing one Budget across multiple resolve() calls
// (e.g. across several candidate sites in discoverAndFetch) lets the caller cap total spend
// for the whole job, not just per site.
export type Budget={llmCalls:number;maxLlmCalls:number};
export function newBudget(maxLlmCalls=DEFAULT_MAX_LLM_CALLS):Budget{return{llmCalls:0,maxLlmCalls};}

// Distinguishes the two provider-error shapes resolve() needs to react to differently, purely
// from the error message text (no page/network dependency, independently testable):
// - "credits-exhausted": a payment/balance error. Permanent for the rest of this run - retrying
//   wastes budget on calls certain to fail identically.
// - "request-too-large": a single request already exceeds the provider's per-minute token
//   ceiling on its own (e.g. "Limit 8000, Requested 19758"). Also not fixed by waiting - the
//   same oversized prompt would fail again - but IS fixable by sending a smaller prompt.
export type ObserveErrorKind="credits-exhausted"|"request-too-large"|"other";
export function classifyObserveError(message:string):ObserveErrorKind{
 if(/\b402\b|insufficient.*credit|requires more credits|payment required/i.test(message))return"credits-exhausted";
 if(/request too large.*tokens per minute/i.test(message))return"request-too-large";
 return"other";
}

// Halves the candidate cap (with a floor so it never shrinks to the point of excluding
// everything) in response to a request-too-large error - adaptive to this run only, not a
// global default, since a provider with more headroom shouldn't be penalized by a cap sized
// for this one's limit.
export function shrinkCandidateCap(cap:{button:number;link:number}):{button:number;link:number}{
 return{button:Math.max(10,Math.floor(cap.button/2)),link:Math.max(5,Math.floor(cap.link/2))};
}

// A fixed candidate count can never be "right" for every site - some pages have 3 relevant
// links, others have hundreds. So instead of tuning the cap to any one site's volume, rank
// both buttons and content links by how well their own text matches the instruction (exam
// titles usually do share literal words with what's being searched for, e.g. "사회문화") and
// take the most relevant ones regardless of how many total candidates exist. This helps most
// for links; filter/selector button labels are often categorical rather than lexical (e.g. a
// "사회탐구" button won't textually match an instruction asking for "사회문화"), so relevance
// sorting is only a tie-break bonus there (ties fall back to original order, a stable sort) -
// which is why buttons still get a much broader inclusion cap than links.
function summarize(candidates:Candidate[],score:(c:Candidate)=>number,cap:{button:number;link:number}):string{
 const nav=candidates.filter(c=>c.nav).slice(0,TOP_N_NAV);
 const buttons=candidates.filter(c=>!c.nav&&c.kind==="button")
  .map(c=>({c,r:score(c)})).sort((a,b)=>b.r-a.r).slice(0,cap.button).map(x=>x.c);
 const links=candidates.filter(c=>!c.nav&&c.kind!=="button")
  .map(c=>({c,r:score(c)})).sort((a,b)=>b.r-a.r).slice(0,cap.link).map(x=>x.c);
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
 // Mutable, adaptive-to-this-run candidate caps (see the "request too large" catch below) -
 // start at the normal defaults and only shrink if this specific provider/run turns out to
 // have a small enough per-minute token ceiling that the normal size doesn't fit.
 let candidateCap={button:TOP_N_BUTTON,link:TOP_N_LINK};
 // How many times locator:"main" has failed to narrow anything on THIS run - once it hits
 // MAIN_SCOPE_MISS_LIMIT, stop attempting it for the rest of this run (see the loop below).
 let mainScopeMisses=0;
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

 for(let i=0;i<maxSteps;i++){
  const url=await page.url().catch(()=>history[history.length-1]?.url||"");
  const resolvedCurrentUrl=resolveFileUrl(url,fileType);
  if(resolvedCurrentUrl)return{ok:true,url:resolvedCurrentUrl,history};

  const candidates=await inspect(page,fileType,instructionTokens).catch(()=>[]);
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
  // an unrelated "popular/featured" list anyway (seen repeatedly in practice). When the flow
  // looks incomplete (see isFilterFlowIncomplete), reject any observe() pick that resolves to
  // a real link (checked directly below, not by matching against our candidate list - selector
  // formats differ and can't be string-matched) - only filter buttons and the eventual submit
  // button stay selectable.
  const filterFlowIncomplete=isFilterFlowIncomplete(history);
  let freshCandidates=candidates.filter(c=>!(c.selector&&clicked.has(c.selector))&&!RESET_INTENT_RE.test(c.text));
  if(filterFlowIncomplete)freshCandidates=freshCandidates.filter(c=>c.kind!=="link");

  // Weight instruction tokens by how distinctive they are within THIS page's actual
  // candidates (rare token = more informative = higher weight) - computed fresh each
  // iteration since the candidate pool changes as we navigate. Falls back to uniform
  // weighting automatically when there's nothing yet to learn from (see computeTokenWeights).
  const tokenWeights=computeTokenWeights(instructionTokens,freshCandidates.map(c=>c.text));
  // Both summarize() (building the prompt) and the mechanical fallback (sorting the same
  // freshCandidates by the same relevance) run in the same iteration whenever observe()
  // fails or gets rejected - caching per-candidate scores here means each candidate's
  // relevance is computed once per iteration, not twice.
  const relevanceCache=new Map<Candidate,number>();
  const scoreCandidate=(c:Candidate):number=>{
   let v=relevanceCache.get(c);
   if(v===undefined){v=relevanceRatioTokens(c.text,instructionTokens,tokenWeights);relevanceCache.set(c,v);}
   return v;
  };

  const beforeFiles=await snapshotDownloads();
  let acted=false;
  let selector:string|undefined;
  let actionText="";
  if(budget.llmCalls<budget.maxLlmCalls){
   try{
    const promptText=`Goal: find "${instruction}".

Prior actions (excluded from candidates below; use to judge if a filter flow is still in progress):
${recap(history)}${rejectedPicks.length?`\nAlready rejected, don't re-suggest: ${rejectedPicks.slice(-5).join("; ")}`:""}

Page candidates:
${summarize(freshCandidates,scoreCandidate,candidateCap)}

Next action:
- Filters set but not submitted yet -> finish filters or submit first, even if a tempting result link is visible (it may be from an unrelated list).
- No filter flow pending -> pick the exact file link/button.
- Already submitted with no new results -> pick an actual result link.
- Search box visible and faster -> use it.
- Else -> most specific nav, not generic links.
Pick only real clickable buttons/links, never headings or labels.
Never log out, delete, purchase, subscribe, or make other irreversible changes.`;
    // Scoping observe() to the page's main content area, when one exists, cuts the
    // accessibility-tree snapshot Stagehand builds internally down to just that container
    // instead of the whole page (including header/nav/footer chrome we never care about) -
    // documented to cut token usage by up to 10x, and this internal snapshot (not our own
    // prompt text above, already trimmed earlier) is what's actually been driving the
    // oversized-request failures seen repeatedly against small-TPM providers. Falls back to
    // an unscoped call (one extra LLM call, only in this case) if "main" doesn't exist on
    // this page or happens to miss the real candidates.
    // Both `locator` and `ignoreLocators` take actual page.locator(...) objects, not raw
    // selector strings - passing plain strings compiles fine here (this file works with
    // `page`/`stagehand` typed as `any`) but is silently wrong or throws at runtime.
    // page.locator() itself accepts both bare CSS selectors and "xpath=..."-prefixed strings,
    // which covers the mixed formats `clicked` can contain (our own CSS-path selectors and
    // observe()'s own xpath selectors).
    const toLocator=(sel:string)=>{try{return page.locator(sel);}catch{return null;}};
    // Structurally exclude already-tried selectors from observe()'s own live-page reasoning,
    // not just from the candidate text we show it: observe() inspects the real page
    // independently of our summarized candidate list and can (and does, in practice) still
    // propose an element we've already excluded there - e.g. re-suggesting the exact same
    // search box twice in a row after it failed to produce any progress the first time.
    // ignoreLocators removes the resolved target (and descendants) from what observe() can
    // even see, closing that gap at the source instead of only ever catching it after the
    // fact via stuck-loop detection.
    // Only exclude selectors that belong to the CURRENT page/URL - a selector from a page
    // we've since navigated away from doesn't match anything here anyway, and worse, creating
    // a live locator object against it caused real CDP frame-tracking errors in practice
    // ("Frame with the given frameId is not found") once the site had actually navigated on
    // since that selector was recorded.
    const samePageSelectors=history.filter(h=>h.url===url).map(h=>h.action?.selector).filter(Boolean);
    const ignoreLocators=[...new Set(samePageSelectors)].map(toLocator).filter(Boolean);
    const observeOpts=(extra:Record<string,unknown>)=>({page,timeout:CALL_TIMEOUT,...(ignoreLocators.length?{ignoreLocators}:{}),...extra});
    budget.llmCalls++;
    // Once locator:"main" has failed to narrow anything MAIN_SCOPE_MISS_LIMIT times, stop
    // attempting it for the rest of this run: on a site with no <main> at all (confirmed by
    // repeated identical misses), every attempt still costs Stagehand a real frame/AX-tree
    // resolution internally - which was observed to throw CDP errors ("Frame with the given
    // frameId is not found") on this exact codepath once the page had navigated since the
    // locator was last resolved. Two misses (not one) gives one fair chance for a step where
    // main genuinely exists but happens to be empty, before concluding the SCOPE itself - not
    // just this step's content - doesn't apply here.
    const tryMainScope=mainScopeMisses<MAIN_SCOPE_MISS_LIMIT;
    let obs=tryMainScope
     ?await stagehand.observe(promptText,observeOpts({locator:page.locator("main")})).catch(()=>null)
     :null;
    if(tryMainScope&&!obs?.data?.length)mainScopeMisses++;
    if(!obs?.data?.length){
     budget.llmCalls++;
     obs=await stagehand.observe(promptText,observeOpts({}));
    }
    const next=obs?.data?.[0];
    const nextTarget=next?.selector?await resolveTarget(next.selector):null;
    const nextText=next?.description||"";
    const nextRelevance=relevanceRatioTokens(nextText,instructionTokens,tokenWeights);
    const evaluation=evaluatePick({
     tag:nextTarget?.tagName??null,
     isInsideLink:Boolean(nextTarget?.isInsideLink),
     description:nextText,
     filterFlowIncomplete,
     currentPageHasDownloadIntent,
     relevance:nextRelevance
    });
    if(next?.selector&&!evaluation.reject&&await click(next.selector,`Click "${next.description}".`)){
     selector=next.selector;
     actionText=next.description||"";
     history.push({url,action:{kind:evaluation.isLink?"link":"button",text:next.description,selector:next.selector}});
     if(/search|검색/i.test(next.description)){
      await page.waitForTimeout(300);
      await act(`Type "${instruction}" into the search input field and press Enter to submit the search.`);
      await page.waitForTimeout(1000);
     }
     acted=true;
    }else if(evaluation.reject){
     rejectedPicks.push(nextText);
     console.error(`resolve: rejected observe() pick "${next.description}" - it ${evaluation.reason}; falling back to mechanical selection.`);
    }
   }catch(e){
    const msg=e instanceof Error?e.message:String(e);
    console.error("observe step failed:",msg);
    const errorKind=classifyObserveError(msg);
    // A payment/credits error (e.g. an exhausted OpenRouter balance) will fail identically on
    // every subsequent call too - retrying wastes the rest of the step budget on calls that
    // are certain to fail. Treat it like budget exhaustion: stop attempting the LLM path for
    // the remainder of this run and rely on the free mechanical fallback instead.
    if(errorKind==="credits-exhausted"){
     budget.llmCalls=budget.maxLlmCalls;
     if(!budgetWarned){console.error("resolve: LLM provider rejected the request for insufficient credits - continuing with free heuristic clicks only.");budgetWarned=true;}
    }else if(errorKind==="request-too-large"){
     // Unlike the credits case above, waiting would NOT help here either - retrying sends the
     // identical oversized prompt and fails identically again. The candidate list is what's
     // driving prompt size on a page with many similarly-shaped buttons (seen in practice), so
     // shrink it for the rest of this run instead.
     candidateCap=shrinkCandidateCap(candidateCap);
     console.error(`resolve: request exceeded the provider's per-minute token limit - shrinking candidate list to ${candidateCap.button} buttons / ${candidateCap.link} links for the rest of this run.`);
    }
   }
  }else if(!budgetWarned){
   console.error(`resolve: LLM call budget exhausted (${budget.maxLlmCalls}) - continuing with free heuristic clicks only.`);
   budgetWarned=true;
  }

  if(!acted){
   // clickFast() only (never the LLM self-heal fallback) so this path stays free even once
   // the budget is spent. See pickFallbackCandidate for the selection policy itself.
   const action=pickFallbackCandidate(freshCandidates,scoreCandidate);
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

  // `acted` is unconditionally true by this point: every path above that leaves it false
  // (fallback found nothing, or its click failed) already `break`s out of the loop before
  // here, so there's nothing left to gate - and no reason to add another wait on top of the
  // settle-time one below.
  await page.waitForTimeout(3000);
  page=await syncActivePage(stagehand,page);
  const downloadedFile=await newDownloadedFile(beforeFiles);
  if(downloadedFile)return{ok:true,downloadedFile,history};
  const postClickUrl=await page.url().catch(()=>"");
  const resolvedPostClickUrl=resolveFileUrl(postClickUrl,fileType);
  if(resolvedPostClickUrl)return{ok:true,url:resolvedPostClickUrl,history};
  if(KEYWORD_RE.test(actionText))console.error(`resolve: after clicking "${actionText}", current URL is: ${postClickUrl} (unchanged from before: ${postClickUrl===url})`);
 }
 return{ok:false,history};
}
