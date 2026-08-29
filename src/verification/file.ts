import {readFile,stat} from "node:fs/promises";import {createHash} from "node:crypto";
import {FileType,FILE_TYPES} from "../discovery/patterns.js";
const DEFAULT_FILE_TYPE=FILE_TYPES[0]; // pdf

export async function verify(filePath:string,fileType:FileType=DEFAULT_FILE_TYPE){
 const info=await stat(filePath);const data=await readFile(filePath);const matchesType=fileType.magic(data);
 // matchesType must gate success, not just ride along as metadata: a non-empty response that
 // isn't actually the requested file type (e.g. an HTML error/login page saved where a PDF
 // was expected) is not a successful fetch.
 return{ok:info.size>0&&matchesType,matchesType,fileType:fileType.name,size:info.size,sha256:createHash("sha256").update(data).digest("hex")};
}
