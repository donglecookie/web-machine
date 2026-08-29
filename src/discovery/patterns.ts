export function sameHost(a:string,b:string):boolean{
 try{return new URL(a).hostname===new URL(b).hostname;}catch{return false;}
}

// Generic "download intent" words - independent of which file TYPE is being sought, these
// signal that a link/button is meant to hand over a file at all.
export const KEYWORD_RE=/download|attachment|첨부|다운로드|받기|저장/i;

// A ZIP-container signature (PK\x03\x04 or the empty/spanned variants) covers xlsx/docx/pptx
// (which are all ZIP archives internally) as well as plain .zip files.
function isZipContainer(b:Buffer):boolean{
 if(b.length<4)return false;
 const sig=b.subarray(0,4).toString("hex");
 return sig==="504b0304"||sig==="504b0506"||sig==="504b0708";
}
// Legacy OLE compound file signature, used by old .doc/.xls/.ppt and legacy .hwp.
function isOleContainer(b:Buffer):boolean{
 return b.length>=8&&b.subarray(0,8).toString("hex")==="d0cf11e0a1b11ae1";
}

export type FileType={
 name:string;
 primaryExt:string; // e.g. "pdf" - used when inferring a filename extension from content-type
 extRe:RegExp; // matches the file's extension at the end of a path/query value
 magic:(data:Buffer)=>boolean; // verifies the downloaded bytes actually look like this type
 aliases:string[]; // Korean/English words in an instruction that imply this type
};

// Extend this list to support more file types - each entry is self-contained (extension
// pattern, content signature, and the words that imply it), so adding one doesn't require
// touching resolver/verification logic elsewhere.
export const FILE_TYPES:FileType[]=[
 {name:"pdf",primaryExt:"pdf",extRe:/\.pdf(?:$|[?#])/i,magic:b=>b.subarray(0,5).toString()==="%PDF-",aliases:["pdf"]},
 {name:"xlsx",primaryExt:"xlsx",extRe:/\.xlsx?(?:$|[?#])/i,magic:b=>isZipContainer(b)||isOleContainer(b),aliases:["엑셀","excel","xlsx","xls","스프레드시트","spreadsheet"]},
 {name:"docx",primaryExt:"docx",extRe:/\.docx?(?:$|[?#])/i,magic:b=>isZipContainer(b)||isOleContainer(b),aliases:["워드","word","docx","한글워드"]},
 {name:"pptx",primaryExt:"pptx",extRe:/\.pptx?(?:$|[?#])/i,magic:b=>isZipContainer(b)||isOleContainer(b),aliases:["파워포인트","powerpoint","pptx","ppt","슬라이드","slide"]},
 {name:"hwp",primaryExt:"hwp",extRe:/\.hwpx?(?:$|[?#])/i,magic:b=>isOleContainer(b)||isZipContainer(b),aliases:["한글파일","hwp","hwpx"]},
 {name:"zip",primaryExt:"zip",extRe:/\.(?:zip|7z|rar)(?:$|[?#])/i,magic:b=>isZipContainer(b)||b.subarray(0,4).toString("hex")==="526172"||b.subarray(0,2).toString("hex")==="377a",aliases:["압축","압축파일","zip","알집"]},
 {name:"image",primaryExt:"png",extRe:/\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i,magic:b=>{
  const hex=b.subarray(0,4).toString("hex");
  return hex.startsWith("89504e47")||hex.startsWith("ffd8")||hex.startsWith("47494638")||b.subarray(8,12).toString()==="WEBP";
 },aliases:["이미지","사진","image","png","jpg","jpeg"]},
 {name:"csv",primaryExt:"csv",extRe:/\.csv(?:$|[?#])/i,magic:()=>true,aliases:["csv"]}, // plain text, no reliable magic bytes
];
const DEFAULT_FILE_TYPE=FILE_TYPES[0]; // pdf - the common case for this project (exam papers, reports)

// Pick the target file type from what the instruction actually asks for, instead of assuming
// PDF unconditionally. Falls back to PDF when nothing more specific is named, since that
// remains the dominant real-world case here, not because other types are unsupported.
export function detectFileType(instruction:string):FileType{
 const lower=instruction.toLowerCase();
 return FILE_TYPES.find(t=>t.aliases.some(a=>lower.includes(a.toLowerCase())))||DEFAULT_FILE_TYPE;
}

// File-format viewers (PDF.js, Office Online embeds, etc.) often load the actual file via a
// query parameter on a wrapper/viewer URL (e.g. "viewer.html?file=...%2Freal.pdf") rather
// than the visible URL itself ending in the right extension. Unwrap that case so we resolve
// the real file, not the viewer page.
export function resolveFileUrl(url:string,fileType:FileType=DEFAULT_FILE_TYPE):string|null{
 if(fileType.extRe.test(url))return url;
 try{
  const u=new URL(url);
  for(const v of u.searchParams.values()){
   const decoded=decodeURIComponent(v);
   if(fileType.extRe.test(decoded)&&/^https?:\/\//i.test(decoded))return decoded;
  }
 }catch{}
 return null;
}

// verify() only confirms a file is non-empty and matches the expected type, not that it's the
// RIGHT file - a wrong same-page candidate (e.g. a different subject/date under identical
// filter selections) can still download a valid-but-irrelevant file and look like a clean
// success. This gives a rough, honest signal of whether the result plausibly matches what was
// asked for, based on how many distinctive words from the instruction appear in the resulting
// filename/URL. Also used (via relevanceRatioTokens) to rank page candidates by relevance to
// the instruction instead of relying on a fixed, site-tuned candidate count.
export function tokenize(s:string):string[]{
 return s.toLowerCase().split(/[\s,·\-–—/|_()]+/).map(t=>t.trim()).filter(t=>t.length>=2);
}
export function relevanceRatioTokens(text:string,tokens:string[]):number{
 if(!tokens.length)return 1;
 const t=text.toLowerCase();
 return tokens.filter(tok=>t.includes(tok)).length/tokens.length;
}
export function relevanceRatio(text:string,instruction:string):number{
 return relevanceRatioTokens(text,tokenize(instruction));
}
