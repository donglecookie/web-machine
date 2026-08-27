import {resolve} from "../files/resolver.js";import {download} from "../files/download.js";import {verify} from "../verification/file.js";
export class WebMachine{
 constructor(private readonly stagehand:any){}
 get page(){return this.stagehand.context.pages()[0];}
 async open(url:string){await this.page.goto(url,{waitUntil:"domcontentloaded"});}
 async fetch(instruction:string,maxSteps=8){
  const found=await resolve(this.page,instruction,maxSteps);
  if(!found.ok||!found.url)return{ok:false,message:"No file URL found.",history:found.history};
  try{const file=await download(found.url);const verification=await verify(file.path);return{ok:verification.ok,url:file.url,path:file.path,verification,history:found.history};}
  catch(e){return{ok:false,url:found.url,message:e instanceof Error?e.message:String(e),history:found.history};}
 }
 async close(){await this.stagehand.close();}
}
