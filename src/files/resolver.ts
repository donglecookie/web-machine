import {inspect,Candidate} from "../discovery/dom.js";
import {KEYWORD_RE,SUBMIT_INTENT_RE,RESET_INTENT_RE,DESTRUCTIVE_INTENT_RE,sameHost,resolveFileUrl,tokenize,relevanceRatioTokens,computeTokenWeights,detectFileType,FileType} from "../discovery/patterns.js";
import type {Stagehand,Page,Locator,StagehandClientObserveOptions} from "@browserbasehq/stagehand";
import {readdir} from "node:fs/promises";
import {logger} from "../runtime/logger.js";
import {RunState,shrinkCandidateCap,exhaustBudget,newBudget,type Budget} from "./runState.js";
// Re-exported so existing importers (WebMachine, discover, tests) keep a single import site
// even though these now live with the run-state they belong to.
export {newBudget,shrinkCandidateCap,exhaustBudget,type Budget} from "./runState.js";

// A single recorded step: what was clicked, on which page. Typed rather than `any` so that
// e.g. reading `.action.kind` or `.url` is checked - these fields are read in several places
// (filter-flow detection, ignoreLocators scoping, relevance checking in WebMachine).
export type HistoryEntry={url:string;action:Candidate|{kind:string;text?:string;selector?:string;url?:string;nav?:boolean;score?:number}};

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
const MAIN_SCOPE_MISS_LIMIT=1;
// Soft ceiling for our own prompt text. Set well under the smallest provider limit seen in
// practice (Groq's free tier at 8000 TPM) because our text is only PART of what gets sent -
// Stagehand adds its own accessibility-tree snapshot of the page on top, and that portion is
// not something this estimate can see. Leaving that much headroom is what makes the estimate
// useful despite being approximate.
const PROMPT_TOKEN_SOFT_LIMIT=2500;

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
export function isFilterFlowIncomplete(history:HistoryEntry[]):boolean{
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

// Rough token estimate for a prompt string, used to shrink oversized prompts BEFORE sending
// rather than only reacting to a provider rejection afterwards (a rejected call is pure waste:
// it costs a full round-trip and returns nothing). Deliberately a cheap heuristic, not a real
// tokenizer - loading one would add a dependency and startup cost to save a rejection that
// this approximation already avoids. Chars-per-token differs sharply by script: ASCII averages
// ~4, but CJK (this project's common case) is closer to ~1.5, so they're counted separately
// instead of applying one average that would badly under-count Korean prompts.
export function estimateTokens(text:string):number{
 let cjk=0;
 for(const ch of text)if(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch))cjk++;
 const ascii=text.length-cjk;
 return Math.ceil(cjk/1.5+ascii/4);
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
function recap(history:HistoryEntry[]):string{
 const recent=history.slice(-RECAP_STEPS);
 if(!recent.length)return"(none - first step)";
 return recent.map((h,i)=>`${i+1}. "${h.action?.text||"?"}"`).join("\n");
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
async function syncActivePage(stagehand:Stagehand,current:Page):Promise<Page>{
 try{
  const pages=await stagehand.browser.context.pages();
  if(!pages.length)return current;
  if(current){
   try{if(pages.some(p=>p.pageId===current.pageId))return current;}catch{}
  }
  return pages[pages.length-1];
 }catch{return current;}
}

export async function resolve(stagehand:Stagehand,page:Page,instruction:string,maxSteps=8,budget:Budget=newBudget()){
 const history:HistoryEntry[]=[];
 const fileType:FileType=detectFileType(instruction);
 const instructionTokens=tokenize(instruction); // instruction never changes across this run - tokenize once, not per loop iteration
 // All per-run mutable bookkeeping (candidate caps, main-scope misses, rejected picks,
 // one-shot notices) lives in one object with its update rules, instead of several loose
 // `let`s whose rules were inlined at each use site across this function. See runState.ts.
 const state=new RunState({buttonCap:TOP_N_BUTTON,linkCap:TOP_N_LINK,mainScopeMissLimit:MAIN_SCOPE_MISS_LIMIT});
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
 const act=(target:string)=>{budget.llmCalls++;return stagehand.act(target,{page,timeout:CALL_TIMEOUT}).then(()=>true,()=>false);};
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
    const buildPrompt=(cap:{button:number;link:number})=>`Goal: find "${instruction}".

Prior actions (excluded from candidates below; use to judge if a filter flow is still in progress):
${recap(history)}${state.recentRejects().length?`\nAlready rejected, don't re-suggest: ${state.recentRejects().join("; ")}`:""}

Page candidates:
${summarize(freshCandidates,scoreCandidate,cap)}

Next action:
- Filters set but not submitted yet -> finish filters or submit first, even if a tempting result link is visible (it may be from an unrelated list).
- No filter flow pending -> pick the exact file link/button.
- Already submitted with no new results -> pick an actual result link.
- Search box visible and faster -> use it.
- Else -> most specific nav, not generic links.
Pick only real clickable buttons/links, never headings or labels.
Never log out, delete, purchase, subscribe, or make other irreversible changes.`;
    // Shrink the prompt BEFORE sending if it already looks too big for the provider, instead
    // of only reacting to a rejection after the fact - a rejected call costs a full round-trip
    // and yields nothing. Uses the same shrink step as the post-rejection path so both
    // converge on the same floor, and stops as soon as it fits or can't shrink further.
    let effectiveCap=state.candidateCap;
    let promptText=buildPrompt(effectiveCap);
    while(estimateTokens(promptText)>PROMPT_TOKEN_SOFT_LIMIT){
     const next=shrinkCandidateCap(effectiveCap);
     if(next.button===effectiveCap.button&&next.link===effectiveCap.link)break;
     effectiveCap=next;
     promptText=buildPrompt(effectiveCap);
    }
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
    const samePageSelectors=history.filter(h=>h.url===url).map(h=>h.action?.selector).filter((s):s is string=>Boolean(s));
    const ignoreLocators=[...new Set(samePageSelectors)].map(toLocator).filter((l):l is Locator=>l!==null);
    // Typed against Stagehand's own options type (not Record<string,unknown>) so a wrong key
    // or wrong value type is a compile error here rather than a runtime schema rejection -
    // its schema is $strict, so an unknown/mistyped key is rejected outright at call time.
    // cache:true lets Stagehand short-circuit an identical instruction+page pair without an
    // LLM round-trip. Worth enabling here specifically because this loop retries the same
    // instruction against the same page in several situations (the main-scope fallback below,
    // and steps where a click didn't change the page), which is exactly the repeat shape a
    // cache can serve.
    const observeOpts=(extra:StagehandClientObserveOptions={}):StagehandClientObserveOptions=>
     ({page,timeout:CALL_TIMEOUT,cache:true,...(ignoreLocators.length?{ignoreLocators}:{}),...extra});
    budget.llmCalls++;
    // Once locator:"main" has failed to narrow anything MAIN_SCOPE_MISS_LIMIT times, stop
    // attempting it for the rest of this run: on a site with no <main> at all, every attempt
    // still costs Stagehand a real frame/AX-tree resolution internally - which was observed to
    // throw CDP errors ("Frame with the given frameId is not found") on this exact codepath
    // once the page had navigated since the locator was last resolved. Set to 1, not 2: two
    // separate real runs against the same main-less site both produced Stagehand's own
    // "Unable to narrow scope with locator" warning on the very first attempt - that warning
    // specifically means the locator itself couldn't resolve at all (not "resolved but empty
    // for this particular query"), which is unambiguous enough evidence on its own that a
    // second, deliberately-more-lenient chance wasn't actually buying any real safety margin,
    // just an extra guaranteed-repeat error.
    const tryMainScope=state.shouldTryMainScope;
    // The scoped attempt swallows its error so an unusable locator can fall through to the
    // unscoped retry - but NOT every error deserves that retry. A provider-level failure
    // (exhausted credits, prompt already over the token ceiling) will fail identically on the
    // retry, so re-raise those immediately and let the handler below react once, instead of
    // silently spending a second doomed call on every single step.
    let obs=null;
    if(tryMainScope){
     try{
      obs=await stagehand.observe(promptText,observeOpts({locator:page.locator("main")}));
     }catch(scopedErr){
      const kind=classifyObserveError(scopedErr instanceof Error?scopedErr.message:String(scopedErr));
      if(kind!=="other")throw scopedErr;
      obs=null;
     }
     if(!obs?.data?.length)state.recordMainScopeMiss();
    }
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
     state.recordRejectedPick(nextText);
     logger.warn("resolve.pick_rejected",{pick:next.description,reason:evaluation.reason,fallback:"mechanical"});
    }
   }catch(e){
    const msg=e instanceof Error?e.message:String(e);
    logger.error("resolve.observe_failed",{message:msg});
    const errorKind=classifyObserveError(msg);
    // A payment/credits error (e.g. an exhausted OpenRouter balance) will fail identically on
    // every subsequent call too - retrying wastes the rest of the step budget on calls that
    // are certain to fail. Treat it like budget exhaustion: stop attempting the LLM path for
    // the remainder of this run and rely on the free mechanical fallback instead.
    if(errorKind==="credits-exhausted"){
     exhaustBudget(budget);
     if(state.claimDegradedNotice())logger.warn("resolve.credits_exhausted",{action:"continuing with free heuristic clicks only"});
    }else if(errorKind==="request-too-large"){
     // Unlike the credits case above, waiting would NOT help here either - retrying sends the
     // identical oversized prompt and fails identically again. The candidate list is what's
     // driving prompt size on a page with many similarly-shaped buttons (seen in practice), so
     // shrink it for the rest of this run instead.
     state.shrinkCandidateCap();
     logger.warn("resolve.request_too_large",{buttons:state.candidateCap.button,links:state.candidateCap.link,scope:"rest of this run"});
    }
   }
  }else if(state.claimDegradedNotice()){
   logger.warn("resolve.budget_exhausted",{maxLlmCalls:budget.maxLlmCalls,action:"continuing with free heuristic clicks only"});
  }

  if(!acted){
   // clickFast() only (never the LLM self-heal fallback) so this path stays free even once
   // the budget is spent. See pickFallbackCandidate for the selection policy itself.
   const action=pickFallbackCandidate(freshCandidates,scoreCandidate);
   if(!action)break;
   selector=action.selector;
   actionText=action.text||"";
   history.push({url,action});
   // Try the stable data-wm-id selector first, then the structural path: if the page replaced
   // the node between scraping and clicking, our injected attribute went with it, and the
   // structural path is the only remaining handle.
   const fallbackSelector=("fallbackSelector" in action?action.fallbackSelector:undefined);
   const ok=action.selector
    ?await clickFast(action.selector)||(fallbackSelector?await clickFast(fallbackSelector):false)
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
   logger.warn("resolve.stuck_loop",{selector,action:"stopping"});
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
  if(KEYWORD_RE.test(actionText))logger.debug("resolve.download_click_no_change",{action:actionText,url:postClickUrl,unchanged:postClickUrl===url});
 }
 return{ok:false,history};
}
