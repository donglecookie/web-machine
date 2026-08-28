import {resolve} from "../files/resolver.js";import {download} from "../files/download.js";import {verify} from "../verification/file.js";import {HtmlMachine} from "./HtmlMachine.js";
const BLOCKED_DOMAINS=[
 "googlesyndication.com","doubleclick.net","google-analytics.com","googletagmanager.com",
 "adtrafficquality.google","fundingchoicesmessages.google.com","googleadservices.com",
 "amazon-adsystem.com","facebook.net","connect.facebook.net"
];
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
 async fetch(instruction:string,maxSteps=8){
  // Fast path: check the raw HTML of the current page for an obvious direct file link
  // before spinning up the full browser-driven resolve() loop.
  const currentUrl=await this.page?.url().catch(()=>null);
  if(currentUrl&&currentUrl!=="about:blank"){
   const direct=await this.html.findDirectFile(currentUrl).catch(()=>null);
   if(direct)return this.downloadAndVerify(direct,[{url:currentUrl,action:{kind:"html-direct",url:direct}}]);
  }

  let found:any;
  try{found=await resolve(this.stagehand,this.page,instruction,maxSteps);}
  catch(e){return{ok:false,message:`resolve failed: ${e instanceof Error?e.message:String(e)}`,history:[]};}
  if(found.downloadedFile){
   try{const verification=await verify(found.downloadedFile);return{ok:verification.ok,path:found.downloadedFile,verification,history:found.history};}
   catch(e){return{ok:false,message:e instanceof Error?e.message:String(e),history:found.history};}
  }
  if(!found.ok||!found.url)return{ok:false,message:"No file URL found.",history:found.history};
  return this.downloadAndVerify(found.url,found.history);
 }
 async close(){
  try{await this.stagehand.close();}
  catch{try{await this.stagehand.browser?.close();}catch{}}
 }
}
