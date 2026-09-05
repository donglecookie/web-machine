import type {Budget} from "./resolver.js";
import {shrinkCandidateCap} from "./resolver.js";

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

 /** Marks the LLM path as spent for the rest of the run (used for errors that would fail
  *  identically on every retry, e.g. exhausted credits). */
 exhaustBudget(budget:Budget):void{
  budget.llmCalls=budget.maxLlmCalls;
 }
}
