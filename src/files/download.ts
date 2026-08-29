import {mkdir,writeFile} from "node:fs/promises";import path from "node:path";
import {FILE_TYPES} from "../discovery/patterns.js";
const DOWNLOAD_TIMEOUT_MS=30000;
const MAX_BYTES=100*1024*1024; // 100MB safety cap - refuse to save unexpectedly huge responses

function safeName(name:string):string{
 const base=path.basename(name)||"download";
 return base.replace(/[^\w.\-가-힣]/g,"_").slice(0,200)||"download";
}

// If the URL itself had no usable extension, fall back to content-type sniffing across every
// known file type rather than assuming PDF specifically.
function inferExtension(contentType:string):string{
 const ct=contentType.toLowerCase();
 const match=FILE_TYPES.find(t=>ct.includes(t.name)||ct.includes(t.primaryExt));
 return match?`.${match.primaryExt}`:"";
}

export async function download(url:string){
 await mkdir("downloads",{recursive:true});
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),DOWNLOAD_TIMEOUT_MS);
 let r:Response;
 try{r=await fetch(url,{redirect:"follow",signal:controller.signal});}
 catch(e){throw new Error(`Download request failed or timed out: ${e instanceof Error?e.message:String(e)}`);}
 finally{clearTimeout(timer);}
 if(!r.ok)throw new Error(`HTTP ${r.status} while downloading ${r.url}`);
 const declaredLength=Number(r.headers.get("content-length")||0);
 if(declaredLength>MAX_BYTES)throw new Error(`File too large (${declaredLength} bytes, max ${MAX_BYTES}).`);
 const buf=Buffer.from(await r.arrayBuffer());
 if(!buf.length)throw new Error("Downloaded file is empty.");
 if(buf.length>MAX_BYTES)throw new Error(`File too large (${buf.length} bytes, max ${MAX_BYTES}).`);
 let name=safeName(new URL(r.url).pathname);
 if(!/\.[A-Za-z0-9]{1,8}$/.test(name))name+=inferExtension(r.headers.get("content-type")||"");
 const out=path.join("downloads",name);
 await writeFile(out,buf);
 return{path:out,url:r.url,size:buf.length,contentType:r.headers.get("content-type")||""};
}
