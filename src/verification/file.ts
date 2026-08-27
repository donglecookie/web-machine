import {readFile,stat} from "node:fs/promises";import {createHash} from "node:crypto";
export async function verify(filePath:string){
 const info=await stat(filePath);const data=await readFile(filePath);const isPdf=data.subarray(0,5).toString()==="%PDF-";
 return{ok:info.size>0,isPdf,size:info.size,sha256:createHash("sha256").update(data).digest("hex")};
}
