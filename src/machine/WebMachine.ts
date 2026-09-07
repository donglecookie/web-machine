import {resolve,newBudget,Budget,type HistoryEntry} from "../files/resolver.js";import {download} from "../files/download.js";import {verify} from "../verification/file.js";import {HtmlMachine} from "./HtmlMachine.js";import {tokenize,relevanceRatioTokens,detectFileType,AD_DOMAINS} from "../discovery/patterns.js";import type {Stagehand,Page} from "@browserbasehq/stagehand";
const BLOCKED_DOMAINS=AD_DOMAINS;
const RELEVANCE_WARN_THRESHOLD=0.5;

// What fetch() can actually return, kept accurate to what the code below produces (this was
// found to be unenforced dead weight during a review pass - nothing declared it as a return
// type, so nothing checked that every branch actually matched its shape; annotating fetch()
// with it surfaced a real gap, fixed alongside this: downloadAndVerify()'s failure branch had
// no `message` when verification itself failed, only when the download threw an exception -
// a caller could get ok:false with no explanation of why).
export type FetchResult=
 // url is absent for a native browser download (no plain link was ever followed, the file
 // just appeared) - path is always present on success either way, since that's what actually
 // got saved and verified.
 |{ok:true;url?:string;path:string;verification:unknown;history:HistoryEntry[];warning?:string}
 |{ok:false;message:string;history:HistoryEntry[];url?:string;path?:string;verification?:unknown};

export function withRelevanceCheck<T extends {ok:boolean;path?:string;url?:string;history?:HistoryEntry[]}>(result:T,instruction:string):T&{warning?:string}{
 if(!result.ok)return result;
 const path=result.path||result.url||"";
 // A CDN often serves the actual file at an opaque, coded URL (e.g. EBSI's
 // "s_samun_mun_A1AT6KCF.pdf") that carries no readable information about what it is - the
 // saved filename inherits that same opacity. The actions that led here usually still have
 // the original descriptive label somewhere though (e.g. the link text
 // "...사회·문화_문제지.pdf 원본 열기" before its href was followed) - but not necessarily in
 // the VERY LAST action: a native-download trigger (e.g. clicking "받기") is itself
 // undescriptive, while the actually-descriptive exam-name click can be a step or two
 // earlier. Checking a short recent window, not just the final entry, covers both shapes.
 const recentTexts:string[]=(result.history||[]).slice(-3).map(h=>h.action?.text).filter((t):t is string=>Boolean(t));
 const instructionTokens=tokenize(instruction); // instruction is the same across every check below - tokenize once, not per call
 const pathRelevance=relevanceRatioTokens(path,instructionTokens);
 const bestText=recentTexts.reduce((best,t)=>{
  const r=relevanceRatioTokens(t,instructionTokens);
  return r>best.r?{text:t,r}:best;
 },{text:"",r:0});
 const relevance=Math.max(pathRelevance,bestText.r);
 if(relevance<RELEVANCE_WARN_THRESHOLD){
  const evidence=bestText.r>pathRelevance?`"${bestText.text}" (path "${path}" itself is not descriptive)`:`"${path}"`;
  return{...result,warning:`Downloaded file may not match the request (relevance ${(relevance*100).toFixed(0)}% - verify manually): ${evidence}`};
 }
 return result;
}

export class WebMachine{
 page!:Page;
 private policySet=false;
 private readonly html=new HtmlMachine();
 constructor(private readonly stagehand:Stagehand){}
 async open(url:string){
  await this.ensurePage();
  for(let attempt=0;attempt<2;attempt++){
   try{await this.page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});return;}
   catch(e){if(attempt===1)throw e;}
  }
 }
 // Grabs a usable page and applies the ad-domain block, without navigating anywhere. Split out
 // of open() for callers that need SOME page handle but not a specific destination - notably
 // discoverAndFetch(), which only needs machine.page to exist before it immediately navigates
 // to the actual search engine URL itself. Routing that case through open("about:blank") first
 // was observed in practice to produce CDP errors ("Inspected target navigated or closed")
 // right as the very next real navigation started - about:blank is a real navigation with its
 // own settle/instrumentation work, and starting a second navigation before that settles is a
 // plausible source of exactly this race. Skipping the pointless middle destination avoids the
 // race outright instead of tuning timing around it.
 async ensurePage(){
  const pages=await this.stagehand.browser.context.pages();
  this.page=pages[pages.length-1]||this.page;
  if(!this.policySet){
   try{await this.stagehand.browser.context.setDomainPolicy({blockedDomains:BLOCKED_DOMAINS});}catch{}
   this.policySet=true;
  }
 }
 private async downloadAndVerify(url:string,history:HistoryEntry[],fileType:ReturnType<typeof detectFileType>):Promise<FetchResult>{
  try{
   const file=await download(url);
   const verification=await verify(file.path,fileType);
   if(!verification.ok)return{ok:false,message:`Downloaded file failed verification (expected type: ${fileType.name}).`,url:file.url,path:file.path,verification,history};
   return{ok:true,url:file.url,path:file.path,verification,history};
  }catch(e){return{ok:false,url,message:e instanceof Error?e.message:String(e),history};}
 }
 async fetch(instruction:string,maxSteps=8,budget:Budget=newBudget()):Promise<FetchResult>{
  const fileType=detectFileType(instruction);
  // Fast path: check the raw HTML of the current page for an obvious direct file link
  // before spinning up the full browser-driven resolve() loop.
  const currentUrl=this.page?await this.page.url().catch(()=>null):null;
  if(currentUrl&&currentUrl!=="about:blank"){
   const direct=await this.html.findDirectFile(currentUrl,fileType).catch(()=>null);
   if(direct)return withRelevanceCheck(await this.downloadAndVerify(direct,[{url:currentUrl,action:{kind:"html-direct",url:direct}}],fileType),instruction);
  }

  let found:Awaited<ReturnType<typeof resolve>>;
  try{found=await resolve(this.stagehand,this.page,instruction,maxSteps,budget);}
  catch(e){return{ok:false,message:`resolve failed: ${e instanceof Error?e.message:String(e)}`,history:[]};}
  if(found.downloadedFile){
   try{
    const verification=await verify(found.downloadedFile,fileType);
    if(!verification.ok)return{ok:false,message:`Downloaded file failed verification (expected type: ${fileType.name}).`,path:found.downloadedFile,verification,history:found.history};
    return withRelevanceCheck({ok:true,path:found.downloadedFile,verification,history:found.history},instruction);
   }catch(e){return{ok:false,message:e instanceof Error?e.message:String(e),history:found.history};}
  }
  if(!found.ok||!found.url)return{ok:false,message:"No file URL found.",history:found.history};
  return withRelevanceCheck(await this.downloadAndVerify(found.url,found.history,fileType),instruction);
 }
 async close(){
  try{await this.stagehand.close();}
  catch{try{await this.stagehand.browser?.close();}catch{}}
 }
}
