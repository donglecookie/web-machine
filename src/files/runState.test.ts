import {test} from "node:test";
import assert from "node:assert/strict";
import {RunState,RECENT_REJECTS_SHOWN} from "./runState.js";
import {newBudget} from "./resolver.js";

const mk=(o:Partial<{buttonCap:number;linkCap:number;mainScopeMissLimit:number}>={})=>
 new RunState({buttonCap:o.buttonCap??30,linkCap:o.linkCap??15,mainScopeMissLimit:o.mainScopeMissLimit??1});

test("RunState starts with the caps it was constructed with", () => {
 const s=mk({buttonCap:30,linkCap:15});
 assert.deepEqual(s.candidateCap,{button:30,link:15});
});

test("RunState.shrinkCandidateCap halves caps and never goes below the floor no matter how many rejections occur", () => {
 const s=mk();
 for(let i=0;i<10;i++)s.shrinkCandidateCap();
 assert.equal(s.candidateCap.button,10);
 assert.equal(s.candidateCap.link,5);
});

test("RunState stops advising the main-scoped observe once misses reach the limit", () => {
 const s=mk({mainScopeMissLimit:1});
 assert.equal(s.shouldTryMainScope,true);
 s.recordMainScopeMiss();
 assert.equal(s.shouldTryMainScope,false,"a main-less site should not be retried all run");
});

test("RunState honors a higher main-scope miss limit when configured", () => {
 const s=mk({mainScopeMissLimit:2});
 s.recordMainScopeMiss();
 assert.equal(s.shouldTryMainScope,true);
 s.recordMainScopeMiss();
 assert.equal(s.shouldTryMainScope,false);
});

test("RunState.recentRejects keeps only the newest entries, so an old reject can't crowd out prompt budget forever", () => {
 const s=mk();
 for(let i=1;i<=RECENT_REJECTS_SHOWN+3;i++)s.recordRejectedPick(`pick${i}`);
 const recent=s.recentRejects();
 assert.equal(recent.length,RECENT_REJECTS_SHOWN);
 assert.equal(recent.at(-1),`pick${RECENT_REJECTS_SHOWN+3}`);
 assert.ok(!recent.includes("pick1"));
});

test("RunState ignores an empty rejected description rather than padding the prompt with a blank entry", () => {
 const s=mk();
 s.recordRejectedPick("");
 assert.equal(s.recentRejects().length,0);
});

test("RunState.claimDegradedNotice returns true exactly once, so a one-off warning isn't repeated every step", () => {
 const s=mk();
 assert.equal(s.claimDegradedNotice(),true);
 assert.equal(s.claimDegradedNotice(),false);
 assert.equal(s.claimDegradedNotice(),false);
});

test("RunState.exhaustBudget marks the LLM path spent for the rest of the run", () => {
 const s=mk();
 const budget=newBudget(20);
 budget.llmCalls=3;
 s.exhaustBudget(budget);
 assert.ok(budget.llmCalls>=budget.maxLlmCalls);
});
