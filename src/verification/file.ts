import {readFile,stat} from "node:fs/promises";import {createHash} from "node:crypto";
export async function verify(filePath:string){
 const info=await stat(filePath);const data=await readFile(filePath);const isPdf=data.subarray(0,5).toString()==="%PDF-";
 // isPdf must gate success, not just ride along as metadata: a non-empty non-PDF response
 // (e.g. an HTML error/login page saved where a PDF was expected) is not a successful fetch.
 return{ok:info.size>0&&isPdf,isPdf,size:info.size,sha256:createHash("sha256").update(data).digest("hex")};
}
