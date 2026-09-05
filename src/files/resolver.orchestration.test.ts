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
};

function makeFakes(opts:FakeOpts={}){
 const observeCalls:any[]=[];
 const actCalls:string[]=[];
 let urlIdx=0;
 const urls=opts.urls??["https://x.test/"];
 const page:any={
  url:async()=>urls[Math.min(urlIdx,urls.length-1)],
  goto:async()=>{urlIdx++;return true;},
  locator:(sel:string)=>({__selector:sel,click:async()=>{},waitFor:async()=>{}}),
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

test("resolve stops attempting the main-scoped observe after it comes back empty (regression: retrying a locator that can't resolve produced repeated CDP frame errors on main-less sites)", async () => {
 const {page,stagehand,observeCalls}=makeFakes({
  candidates:[
   {kind:"button",text:"사회문화 하나",selector:"b1",nav:false},
   {kind:"button",text:"사회문화 둘",selector:"b2",nav:false},
  ],
  observeResults:[{data:[]},{data:[]},{data:[]},{data:[]}],
 });
 await resolve(stagehand,page,"사회문화",3,newBudget(20));
 const scoped=observeCalls.filter(o=>o.locator);
 assert.equal(scoped.length,1,"main-scoped observe should be tried once, then abandoned for this run");
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
