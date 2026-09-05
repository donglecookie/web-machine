import {test} from "node:test";
import assert from "node:assert/strict";
import {resolve,newBudget,estimateTokens} from "./resolver.js";

// These exercise resolve()'s ORCHESTRATION - the loop that wires the pure decision functions
// together (budget accounting, retry ordering, early-exit conditions). Until now only the pure
// functions had direct tests, and this control flow was verified solely by watching real
// browser runs: slow, non-deterministic, API-credit-consuming, and unable to assert on
// internal state like "how many LLM calls did that actually cost". Fakes make those assertions
// possible and let regressions surface in CI instead of mid-session.

type FakeOpts={
 candidates?:any[];
 observeResults?:any[];      // consumed in order, one per observe() call
 observeErrors?:(string|null)[]; // if set at an index, observe() throws that message instead
 urls?:string[];             // page.url() sequence; last value repeats
 hasMain?:boolean;           // whether page.locator("main").count() reports an element
 unclickableSelectors?:string[]; // selectors whose .click() always rejects, simulating a
                                  // structurally-present-but-not-actually-interactable element
                                  // (e.g. hidden inside a collapsed nav menu)
};

function makeFakes(opts:FakeOpts={}){
 const observeCalls:any[]=[];
 const actCalls:string[]=[];
 let urlIdx=0;
 const urls=opts.urls??["https://x.test/"];
 const page:any={
  url:async()=>urls[Math.min(urlIdx,urls.length-1)],
  goto:async()=>{urlIdx++;return true;},
  locator:(sel:string)=>({
   __selector:sel,
   click:async()=>{if(opts.unclickableSelectors?.includes(sel))throw new Error("Node does not have a layout object");},
   waitFor:async()=>{},
   count:async()=>(sel==="main"?(opts.hasMain??true)?1:0:1),
  }),
  waitForTimeout:async()=>{},
  // inspect() calls page.evaluate to scrape candidates; return them directly.
  evaluate:async()=>opts.candidates??[],
  click:async()=>{},
 };
 const stagehand:any={
  observe:async(_prompt:string,options:any)=>{
   const i=observeCalls.length;
   observeCalls.push(options);
   const err=opts.observeErrors?.[i];
   if(err)throw new Error(err);
   return opts.observeResults?.[i]??{data:[]};
  },
  act:async(target:string)=>{actCalls.push(target);},
  browser:{context:{pages:async()=>[page]}},
 };
 return{page,stagehand,observeCalls,actCalls};
}

test("estimateTokens counts CJK far more heavily than ASCII (a single average would badly under-count Korean prompts)", () => {
 const korean="사회문화모의평가";      // 8 chars
 const ascii="abcdefgh";              // 8 chars - same length, so any difference is per-char weight
 assert.equal(korean.length,ascii.length);
 assert.ok(estimateTokens(korean)>estimateTokens(ascii));
});

test("estimateTokens grows with length and returns 0 for empty input", () => {
 assert.equal(estimateTokens(""),0);
 assert.ok(estimateTokens("a".repeat(400))>estimateTokens("a".repeat(40)));
});

test("resolve returns a direct hit without spending any LLM budget when the page already exposes a matching file link", async () => {
 const {page,stagehand}=makeFakes({
  candidates:[{kind:"link",text:"사회문화 문제지",url:"https://x.test/exam.pdf",selector:"a1",nav:false}],
 });
 const budget=newBudget(5);
 const out:any=await resolve(stagehand,page,"사회문화",3,budget);
 assert.equal(out.ok,true);
 assert.equal(out.url,"https://x.test/exam.pdf");
 assert.equal(budget.llmCalls,0,"a direct match must not cost an LLM call");
});

test("resolve does not call observe() at all once the budget is already exhausted (free mechanical path only)", async () => {
 const {page,stagehand,observeCalls}=makeFakes({
  candidates:[{kind:"button",text:"사회문화",selector:"b1",nav:false}],
 });
 const budget=newBudget(0);
 await resolve(stagehand,page,"사회문화",2,budget);
 assert.equal(observeCalls.length,0);
});

test("resolve passes cache:true and a page handle on every observe call (cache lets identical instruction+page repeats skip an LLM round-trip)", async () => {
 const {page,stagehand,observeCalls}=makeFakes({
  candidates:[{kind:"button",text:"사회문화",selector:"b1",nav:false}],
 });
 await resolve(stagehand,page,"사회문화",1,newBudget(5));
 assert.ok(observeCalls.length>0);
 for(const o of observeCalls){
  assert.equal(o.cache,true);
  assert.ok(o.page);
 }
});

test("resolve never attempts the main-scoped observe on a page confirmed to have no <main> (regression: inferring this from an empty observe() result never actually fired - Stagehand's own internal fallback to the full DOM still returns real results, so a live run kept re-triggering, and re-erroring on, the scoped call every single step)", async () => {
 const {page,stagehand,observeCalls}=makeFakes({
  candidates:[
   {kind:"button",text:"사회문화 하나",selector:"b1",nav:false},
   {kind:"button",text:"사회문화 둘",selector:"b2",nav:false},
  ],
  observeResults:[{data:[]},{data:[]},{data:[]},{data:[]}],
  hasMain:false,
 });
 await resolve(stagehand,page,"사회문화",3,newBudget(20));
 const scoped=observeCalls.filter(o=>o.locator);
 assert.equal(scoped.length,0,"a page with no <main> should never even attempt the scoped call");
});

test("resolve does attempt the main-scoped observe when the page actually has one", async () => {
 const {page,stagehand,observeCalls}=makeFakes({
  candidates:[{kind:"button",text:"사회문화",selector:"b1",nav:false}],
  hasMain:true,
 });
 await resolve(stagehand,page,"사회문화",1,newBudget(5));
 const scoped=observeCalls.filter(o=>o.locator);
 assert.ok(scoped.length>0);
});

test("resolve treats a credits error as permanent: it stops calling observe() for the rest of the run rather than retrying a call certain to fail identically", async () => {
 const {page,stagehand,observeCalls}=makeFakes({
  candidates:[
   {kind:"button",text:"사회문화 하나",selector:"b1",nav:false},
   {kind:"button",text:"사회문화 둘",selector:"b2",nav:false},
   {kind:"button",text:"사회문화 셋",selector:"b3",nav:false},
  ],
  observeErrors:["OpenAI-compatible endpoint error: HTTP 402 requires more credits"],
 });
 await resolve(stagehand,page,"사회문화",4,newBudget(20));
 assert.equal(observeCalls.length,1,"after a 402, no further observe calls should be attempted");
});

test("resolve records history entries carrying both the url and the action, so later steps can scope decisions to the current page", async () => {
 const {page,stagehand}=makeFakes({
  candidates:[{kind:"button",text:"사회문화",selector:"b1",nav:false}],
 });
 const out:any=await resolve(stagehand,page,"사회문화",1,newBudget(0));
 assert.ok(Array.isArray(out.history));
 for(const h of out.history){
  assert.equal(typeof h.url,"string");
  assert.ok(h.action);
 }
});

test("resolve tells act() to clear the search field before typing, not just type (regression: 'type X' alone was sometimes interpreted as appending to whatever the field already held, producing a self-concatenated, unmatchable query and stalling the run on a search-button click loop)", async () => {
 const {page,stagehand,actCalls}=makeFakes({
  candidates:[{kind:"button",text:"사회문화",selector:"b1",nav:false}],
  observeResults:[{data:[{description:"Search input box",selector:"xpath=/html/body/input[1]"}]}],
 });
 await resolve(stagehand,page,"사회문화",2,newBudget(5));
 const searchAct=actCalls.find(a=>a.toLowerCase().includes("search"));
 assert.ok(searchAct,"expected a search-typing act() call");
 assert.match(searchAct!,/clear/i);
});

test("resolve tries the next-best fallback candidate if the top one turns out not to be actually clickable (regression: a candidate hidden inside a collapsed nav menu is structurally present but has no layout box, so its click always fails - previously this ended the whole run on step one instead of trying anything else)", async () => {
 const {page,stagehand}=makeFakes({
  candidates:[
   {kind:"link",text:"숨겨진 메뉴 항목",selector:"hidden1",nav:true},
   {kind:"button",text:"사회문화",selector:"visible1",nav:false},
  ],
  unclickableSelectors:["hidden1"],
 });
 const out:any=await resolve(stagehand,page,"사회문화",3,newBudget(0));
 assert.equal(out.history.at(-1)?.action?.selector,"visible1","should have moved on to the next candidate after the first failed to click");
});

test("resolve gives up only after the top few fallback candidates all fail to click, not just the first", async () => {
 const {page,stagehand}=makeFakes({
  candidates:[
   {kind:"link",text:"a",selector:"h1",nav:false},
   {kind:"link",text:"b",selector:"h2",nav:false},
   {kind:"link",text:"c",selector:"h3",nav:false},
  ],
  unclickableSelectors:["h1","h2","h3"],
 });
 const out:any=await resolve(stagehand,page,"사회문화",3,newBudget(0));
 assert.equal(out.ok,false);
 assert.equal(out.history.length,0,"no history entry should be recorded for attempts that never actually succeeded");
});
