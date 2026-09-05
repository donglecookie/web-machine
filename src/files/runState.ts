// All of the mutable bookkeeping a single resolve() run carries, plus the rules for updating
// it. Previously these lived as five separate `let`s scattered through a ~450-line function,
// with each update rule (how far to shrink, warn only once, keep only the last few rejects,
// when to stop retrying the scoped observe) inlined at its use site - so the rules were spread
// across the file and couldn't be exercised without driving a whole browser run.
//
// This deliberately holds state only. Decisions stay in the pure functions (evaluatePick,
// isFilterFlowIncomplete, pickFallbackCandidate, classifyObserveError) and the sequencing
// stays in resolve(); mixing those back in here would just relocate the god-object problem.

export const RECENT_REJECTS_SHOWN=5;
const DEFAULT_MAX_LLM_CALLS=20;
const CAP_FLOOR={button:10,link:5};

// A per-run cap on actual LLM calls (observe + act), independent of maxSteps. maxSteps alone
// doesn't bound cost: a single "step" can trigger an observe() plus one or two act() calls
// (self-heal fallback, search-box typing). Passing one Budget across multiple resolve() calls
// (e.g. across several candidate sites in discoverAndFetch) lets the caller cap total spend
// for the whole job, not just per site.
//
// Lives here rather than in resolver.ts so RunState doesn't have to import back from the
// module that imports it - the two were mutually dependent before, which works but is a
// fragile shape to leave in place.
export type Budget={llmCalls:number;maxLlmCalls:number};
export function newBudget(maxLlmCalls=DEFAULT_MAX_LLM_CALLS):Budget{return{llmCalls:0,maxLlmCalls};}

/** Marks the LLM path spent for the rest of the run (for errors that would fail identically
 *  on every retry, e.g. exhausted credits). A free function on Budget rather than a RunState
 *  method: it only ever touches the budget, never any RunState field. */
export function exhaustBudget(budget:Budget):void{
 budget.llmCalls=budget.maxLlmCalls;
}

// Halves the candidate cap (with a floor so it never shrinks to the point of excluding
// everything) in response to a request-too-large error - adaptive to this run only, not a
// global default, since a provider with more headroom shouldn't be penalized by a cap sized
// for this one's limit.
export function shrinkCandidateCap(cap:{button:number;link:number}):{button:number;link:number}{
 return{button:Math.max(CAP_FLOOR.button,Math.floor(cap.button/2)),link:Math.max(CAP_FLOOR.link,Math.floor(cap.link/2))};
}

export class RunState {
 /** Candidate caps for prompt size, shrunk adaptively if the provider rejects oversized requests. */
 candidateCap:{button:number;link:number};
 /** How many times the main-scoped observe found nothing; past the limit we stop trying it. */
 private mainScopeMisses=0;
 private readonly mainScopeMissLimit:number;
 /** Picks observe() proposed that policy rejected - surfaced back to the model so it doesn't re-propose them. */
 private readonly rejected:string[]=[];
 /** Ensures the "falling back to free heuristics" notice is logged once, not once per step. */
 private degradedNotice=false;

 constructor(opts:{buttonCap:number;linkCap:number;mainScopeMissLimit:number}){
  this.candidateCap={button:opts.buttonCap,link:opts.linkCap};
  this.mainScopeMissLimit=opts.mainScopeMissLimit;
 }

 /** True while the main-scoped observe is still worth attempting on this site. */
 get shouldTryMainScope():boolean{
  return this.mainScopeMisses<this.mainScopeMissLimit;
 }

 recordMainScopeMiss():void{
  this.mainScopeMisses++;
 }

 recordRejectedPick(description:string):void{
  if(description)this.rejected.push(description);
 }

 /** Most recent rejects only: older ones are far less likely to be re-proposed, and every
  *  entry costs prompt tokens on a budget this project has repeatedly hit its limits on. */
 recentRejects():string[]{
  return this.rejected.slice(-RECENT_REJECTS_SHOWN);
 }

 shrinkCandidateCap():void{
  this.candidateCap=shrinkCandidateCap(this.candidateCap);
 }

 /** Returns true the first time only, so callers can log a one-off notice without tracking
  *  their own flag. */
 claimDegradedNotice():boolean{
  if(this.degradedNotice)return false;
  this.degradedNotice=true;
  return true;
 }
}
