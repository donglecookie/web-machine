import {resolve,newBudget,Budget} from "../files/resolver.js";import {download} from "../files/download.js";import {verify} from "../verification/file.js";import {HtmlMachine} from "./HtmlMachine.js";import {relevanceRatio} from "../discovery/patterns.js";
const BLOCKED_DOMAINS=[
 "googlesyndication.com","doubleclick.net","google-analytics.com","googletagmanager.com",
 "adtrafficquality.google","fundingchoicesmessages.google.com","googleadservices.com",
 "amazon-adsystem.com","facebook.net","connect.facebook.net"
];
const RELEVANCE_WARN_THRESHOLD=0.5;

function withRelevanceCheck(result:any,instruction:string):any{
 if(!result.ok)return result;
 const path=result.path||result.url||"";
 const relevance=relevanceRatio(path,instruction);
 if(relevance<RELEVANCE_WARN_THRESHOLD){
  return{...result,warning:`Downloaded file may not match the request (filename relevance ${(relevance*100).toFixed(0)}% - verify manually): "${path}"`};
 }
 return result;
}

export class WebMachine{
 page:any;
 private policySet=false;
 private readonly html=new HtmlMachine();
 constructor(private readonly stagehand:any){}
 async open(url:string){
  const pages=await this.stagehand.browser.context.pages();
  this.page=pages[pages.length-1]||this.page;
  if(!this.policySet){
   try{await this.stagehand.browser.context.setDomainPolicy({blockedDomains:BLOCKED_DOMAINS});}catch{}
   this.policySet=true;
  }
  for(let attempt=0;attempt<2;attempt++){
   try{await this.page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});return;}
   catch(e){if(attempt===1)throw e;}
  }
 }
 private async downloadAndVerify(url:string,history:any[]){
  try{const file=await download(url);const verification=await verify(file.path);return{ok:verification.ok,url:file.url,path:file.path,verification,history};}
  catch(e){return{ok:false,url,message:e instanceof Error?e.message:String(e),history};}
 }
 async fetch(instruction:string,maxSteps=8,budget:Budget=newBudget()){
  // Fast path: check the raw HTML of the current page for an obvious direct file link
  // before spinning up the full browser-driven resolve() loop.
  const currentUrl=this.page?await this.page.url().catch(()=>null):null;
  if(currentUrl&&currentUrl!=="about:blank"){
   const direct=await this.html.findDirectFile(currentUrl).catch(()=>null);
   if(direct)return withRelevanceCheck(await this.downloadAndVerify(direct,[{url:currentUrl,action:{kind:"html-direct",url:direct}}]),instruction);
  }

  let found:any;
  try{found=await resolve(this.stagehand,this.page,instruction,maxSteps,budget);}
  catch(e){return{ok:false,message:`resolve failed: ${e instanceof Error?e.message:String(e)}`,history:[]};}
  if(found.downloadedFile){
   try{
    const verification=await verify(found.downloadedFile);
    return withRelevanceCheck({ok:verification.ok,path:found.downloadedFile,verification,history:found.history},instruction);
   }catch(e){return{ok:false,message:e instanceof Error?e.message:String(e),history:found.history};}
  }
  if(!found.ok||!found.url)return{ok:false,message:"No file URL found.",history:found.history};
  return withRelevanceCheck(await this.downloadAndVerify(found.url,found.history),instruction);
 }
 async close(){
  try{await this.stagehand.close();}
  catch{try{await this.stagehand.browser?.close();}catch{}}
 }
}
