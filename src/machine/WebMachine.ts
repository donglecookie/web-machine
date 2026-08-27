import {resolve} from "../files/resolver.js";import {download} from "../files/download.js";import {verify} from "../verification/file.js";
const BLOCKED_DOMAINS=[
 "googlesyndication.com","doubleclick.net","google-analytics.com","googletagmanager.com",
 "adtrafficquality.google","fundingchoicesmessages.google.com","googleadservices.com",
 "amazon-adsystem.com","facebook.net","connect.facebook.net"
];
export class WebMachine{
 page:any;
 constructor(private readonly stagehand:any){}
 async open(url:string){
  const pages=await this.stagehand.browser.context.pages();
  this.page=pages[0];
  try{await this.stagehand.browser.context.setDomainPolicy({blockedDomains:BLOCKED_DOMAINS});}catch{}
  for(let attempt=0;attempt<2;attempt++){
   try{await this.page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});return;}
   catch(e){if(attempt===1)throw e;}
  }
 }
 async fetch(instruction:string,maxSteps=8){
  let found:any;
  try{found=await resolve(this.stagehand,this.page,instruction,maxSteps);}
  catch(e){return{ok:false,message:`resolve failed: ${e instanceof Error?e.message:String(e)}`,history:[]};}
  if(!found.ok||!found.url)return{ok:false,message:"No file URL found.",history:found.history};
  try{const file=await download(found.url);const verification=await verify(file.path);return{ok:verification.ok,url:file.url,path:file.path,verification,history:found.history};}
  catch(e){return{ok:false,url:found.url,message:e instanceof Error?e.message:String(e),history:found.history};}
 }
 async close(){
  try{await this.stagehand.close();}
  catch{try{await this.stagehand.browser?.close();}catch{}}
 }
}
