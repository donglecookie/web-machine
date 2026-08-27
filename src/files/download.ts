import {mkdir,writeFile} from "node:fs/promises";import path from "node:path";
const DOWNLOAD_TIMEOUT_MS=30000;
export async function download(url:string){
 await mkdir("downloads",{recursive:true});
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),DOWNLOAD_TIMEOUT_MS);
 let r:Response;
 try{r=await fetch(url,{redirect:"follow",signal:controller.signal});}
 catch(e){throw new Error(`Download request failed or timed out: ${e instanceof Error?e.message:String(e)}`);}
 finally{clearTimeout(timer);}
 if(!r.ok)throw new Error(`HTTP ${r.status} while downloading ${r.url}`);
 const buf=Buffer.from(await r.arrayBuffer());
 if(!buf.length)throw new Error("Downloaded file is empty.");
 let name=path.basename(new URL(r.url).pathname)||"download";
 if(!/\.[A-Za-z0-9]{1,8}$/.test(name)){const ct=r.headers.get("content-type")||"";if(ct.includes("pdf"))name+=".pdf";}
 const out=path.join("downloads",name);
 await writeFile(out,buf);
 return{path:out,url:r.url,size:buf.length,contentType:r.headers.get("content-type")||""};
}
