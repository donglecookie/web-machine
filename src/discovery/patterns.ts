export function sameHost(a:string,b:string):boolean{
 try{return new URL(a).hostname===new URL(b).hostname;}catch{return false;}
}

// Generic "download intent" words - independent of which file TYPE is being sought, these
// signal that a link/button is meant to hand over a file at all.
export const KEYWORD_RE=/download|attachment|첨부|다운로드|받기|저장/i;

// Distinct from KEYWORD_RE (download intent): this specifically detects "submit/search"
// intent, used to judge whether a multi-step filter flow has actually been submitted yet.
// Deliberately narrow - e.g. "필터" ("filter") was tried here once and had to be removed: a
// real "선택된 필터 모두 지우기" (clear all filters) button contains that word too, which would
// have falsely counted as "submitted" the moment that reset button's text was recorded.
export const SUBMIT_INTENT_RE=/검색|찾기|search|submit/i;

// A "reset/clear" action always undoes progress rather than making it - there's no scenario
// in this project's forward-progressing flow (select filters -> submit -> open result) where
// clicking one helps. Excluded from candidates entirely (not just the LLM prompt) so the
// judgment-free mechanical fallback can't grab one either.
// Actions that can never help reach the goal, regardless of filter-flow state: undoing
// progress (reset/clear/back) or side-channel actions with no bearing on finding a file
// (copy link, share). Seen in practice: the mechanical fallback grabbed a "뒤로 가기" (go
// back) button after correctly reaching the target page, undoing that progress, and later
// wasted two picks on "링크 복사"/"공유하기" (copy link/share) - clipboard actions that could
// never lead to a download. Excluded from candidates entirely (not just the LLM prompt) so
// the judgment-free mechanical fallback can't grab any of these either.
export const RESET_INTENT_RE=/초기화|필터.*지우기|지우기.*필터|clear all|reset|뒤로\s*가기|뒤로가기|이전\s*(페이지|화면)|go\s*back|링크\s*복사|공유하기|copy\s*link|\bshare\b/i;

// Structural backstop for the "never log out/delete/purchase/subscribe" prompt instruction -
// prose alone has repeatedly proven insufficient in this codebase (the model has ignored
// similarly-worded guidance for other cases too), so this pattern is also checked directly
// against what was actually about to be clicked, not just written into the prompt.
export const DESTRUCTIVE_INTENT_RE=/로그아웃|탈퇴|삭제|결제|구매|구독\s*(신청|취소)?|log\s*out|sign\s*out|delete|unsubscribe|purchase|checkout/i;

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
 mimeRe:RegExp; // matches this type's real Content-Type header (often doesn't contain the
                // extension/name as a substring, e.g. xlsx is "...spreadsheetml.sheet")
};

// Extend this list to support more file types - each entry is self-contained (extension
// pattern, content signature, MIME pattern, and the words that imply it), so adding one
// doesn't require touching resolver/verification logic elsewhere.
export const FILE_TYPES:FileType[]=[
 {name:"pdf",primaryExt:"pdf",extRe:/\.pdf(?:$|[?#])/i,magic:b=>b.subarray(0,5).toString()==="%PDF-",aliases:["pdf"],mimeRe:/\bpdf\b/i},
 {name:"xlsx",primaryExt:"xlsx",extRe:/\.xlsx?(?:$|[?#])/i,magic:b=>isZipContainer(b)||isOleContainer(b),aliases:["엑셀","excel","xlsx","xls","스프레드시트","spreadsheet"],mimeRe:/spreadsheetml|ms-excel/i},
 {name:"docx",primaryExt:"docx",extRe:/\.docx?(?:$|[?#])/i,magic:b=>isZipContainer(b)||isOleContainer(b),aliases:["워드","word","docx","한글워드"],mimeRe:/wordprocessingml|msword/i},
 {name:"pptx",primaryExt:"pptx",extRe:/\.pptx?(?:$|[?#])/i,magic:b=>isZipContainer(b)||isOleContainer(b),aliases:["파워포인트","powerpoint","pptx","ppt","슬라이드","slide"],mimeRe:/presentationml|ms-powerpoint/i},
 {name:"hwp",primaryExt:"hwp",extRe:/\.hwpx?(?:$|[?#])/i,magic:b=>isOleContainer(b)||isZipContainer(b),aliases:["한글파일","hwp","hwpx"],mimeRe:/hwp/i},
 {name:"zip",primaryExt:"zip",extRe:/\.(?:zip|7z|rar)(?:$|[?#])/i,magic:b=>isZipContainer(b)||b.subarray(0,4).toString("hex")==="52617221"||b.subarray(0,2).toString("hex")==="377a",aliases:["압축","압축파일","zip","알집"],mimeRe:/\bzip\b|x-rar|7z-compressed|x-compress/i},
 {name:"image",primaryExt:"png",extRe:/\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i,magic:b=>{
  const hex=b.subarray(0,4).toString("hex");
  return hex.startsWith("89504e47")||hex.startsWith("ffd8")||hex.startsWith("47494638")||b.subarray(8,12).toString()==="WEBP";
 },aliases:["이미지","사진","image","png","jpg","jpeg"],mimeRe:/^image\//i},
 {name:"csv",primaryExt:"csv",extRe:/\.csv(?:$|[?#])/i,magic:b=>!/^\s*<(!doctype|html)/i.test(b.subarray(0,100).toString("utf8")),aliases:["csv"],mimeRe:/\bcsv\b/i}, // plain text has no reliable signature, but reject the obvious false-positive case (an HTML error/login page saved where a CSV was expected)
];
// A wildcard policy for when the instruction doesn't name any specific format: rather than
// silently assuming PDF (or any other single type), match against every known extension, and
// verify against every known REAL signature. csv is excluded from the wildcard's magic check
// since its own check (reject obvious HTML, accept everything else) is far weaker than the
// others' actual binary signatures and would let too much through if it were included here -
// it still applies its own check when csv is explicitly requested by name, just not as a
// fallback for arbitrary unnamed downloads.
const VERIFIABLE_TYPES=FILE_TYPES.filter(t=>t.name!=="csv");
export const ANY_FILE_TYPE:FileType={
 name:"any",
 primaryExt:"",
 extRe:new RegExp(FILE_TYPES.map(t=>t.extRe.source).join("|"),"i"),
 magic:b=>VERIFIABLE_TYPES.some(t=>t.magic(b)),
 aliases:[],
 mimeRe:/(?!)/ // never matches - extension inference for downloads always uses FILE_TYPES directly, not this wildcard
};

// Pick the target file type from what the instruction actually asks for. When nothing specific
// is named, don't default to any one format (PDF included) - that would just be a different
// flavor of the same bias this was built to remove. Fall back to the "any known type" wildcard
// instead, so an unqualified request stays genuinely format-agnostic.
export function detectFileType(instruction:string):FileType{
 const lower=instruction.toLowerCase();
 return FILE_TYPES.find(t=>t.aliases.some(a=>lower.includes(a.toLowerCase())))||ANY_FILE_TYPE;
}

// File-format viewers (PDF.js, Office Online embeds, etc.) often load the actual file via a
// query parameter on a wrapper/viewer URL (e.g. "viewer.html?file=...%2Freal.pdf") rather
// than the visible URL itself ending in the right extension. Unwrap that case so we resolve
// the real file, not the viewer page.
export function resolveFileUrl(url:string,fileType:FileType=ANY_FILE_TYPE):string|null{
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

// Korean compound names are often written with a middle dot for readability (e.g. "사회·문화")
// while an instruction referring to the same thing usually omits it (e.g. "사회문화") - strip
// it before comparing so that single character doesn't silently break an otherwise-exact match.
function stripMiddleDot(s:string):string{
 return s.replace(/·/g,"");
}

// Character-bigram overlap (Dice coefficient) - a general, language-agnostic way to score how
// similar two short strings are, without needing exact substring containment. This is what
// makes matching robust to morphological variation generally (differing particles/suffixes,
// spacing, minor spelling differences) instead of hand-coding one exception at a time for
// every specific pattern noticed in testing (a search for "앵무새 사진" or "스페인 지도" hits
// the exact same class of variation as "사회문화"/"사회·문화" did, just in a different domain).
function bigrams(s:string):Set<string>{
 const out=new Set<string>();
 if(s.length<2){if(s)out.add(s);return out;}
 for(let i=0;i<s.length-1;i++)out.add(s.slice(i,i+2));
 return out;
}
function diceCoefficient(a:string,b:string):number{
 if(a===b)return 1;
 const A=bigrams(a),B=bigrams(b);
 if(!A.size||!B.size)return 0;
 let overlap=0;
 for(const g of A)if(B.has(g))overlap++;
 return (2*overlap)/(A.size+B.size);
}
const FUZZY_MATCH_THRESHOLD=0.6;

// Scores a single instruction token against a candidate's text. Three tiers, tried in order:
// 1. Exact substring - the common case, full credit.
// 2. Bare-digit match for tokens containing a year (19xx/20xx) - a school year like
//    "2025학년도" and a calendar-year filter button labeled "2025년" refer to the same year
//    but differ in suffix. Kept as an explicit numeric check rather than folded into the
//    general fuzzy tier below: adjacent years (e.g. "2024"/"2025") share enough digits that
//    bigram overlap alone can't reliably tell them apart, which would risk treating the WRONG
//    year as a match.
// 3. Fuzzy bigram overlap against the candidate's own tokens - the general fallback for
//    everything else (morphological/spelling variation), at partial credit proportional to
//    how close the match is, so a near-match still outranks a candidate with no relation at
//    all instead of scoring identically to it.
function tokenMatchScore(normalizedText:string,textTokens:string[],tok:string):number{
 if(normalizedText.includes(tok))return 1;
 const year=tok.match(/(19|20)\d{2}/)?.[0];
 if(year)return normalizedText.includes(year)?1:0;
 if(!textTokens.length)return 0;
 let best=0;
 for(const tt of textTokens){const d=diceCoefficient(tok,tt);if(d>best)best=d;}
 return best>=FUZZY_MATCH_THRESHOLD?best:0;
}

// Not every instruction word is equally informative: in an exam search, "모의고사"/"문제지"
// appears on nearly every candidate and says little about which one is right, while
// "사회문화" appears on very few and is the actual distinguishing signal. In an image search
// like "앵무새 사진", "사진" is similarly generic while "앵무새" is what actually matters. This
// computes that weighting directly from the current candidate pool (how many candidates each
// token appears in) - no external word-frequency corpus needed, and it naturally adapts to
// whatever the candidates on THIS page look like rather than assuming any one domain's
// vocabulary. Optional: omitting it (or passing texts=[]) falls back to treating every token
// equally, which is still a reasonable default when there's no candidate pool yet to learn from.
export function computeTokenWeights(tokens:string[],candidateTexts:string[]):Map<string,number>{
 const weights=new Map<string,number>();
 const n=candidateTexts.length;
 if(!n){for(const tok of tokens)weights.set(tok,1);return weights;}
 const normalized=candidateTexts.map(t=>stripMiddleDot(t.toLowerCase()));
 for(const tok of tokens){
  const docFreq=normalized.filter(t=>t.includes(tok)).length;
  // Smoothed inverse document frequency: common tokens (high docFreq) approach a weight of
  // ~1, rare/distinctive ones (low docFreq) go higher - never below 1, so no token actively
  // hurts a match, it just doesn't help as much as a distinctive one would.
  weights.set(tok,Math.log((n+1)/(docFreq+1))+1);
 }
 return weights;
}

export function relevanceRatioTokens(text:string,tokens:string[],weights?:Map<string,number>):number{
 if(!tokens.length)return 1;
 const normalizedText=stripMiddleDot(text.toLowerCase());
 const textTokens=tokenize(normalizedText);
 let scoreSum=0,weightSum=0;
 for(const tok of tokens){
  const w=weights?.get(tok)??1;
  scoreSum+=tokenMatchScore(normalizedText,textTokens,tok)*w;
  weightSum+=w;
 }
 return weightSum?scoreSum/weightSum:0;
}
export function relevanceRatio(text:string,instruction:string):number{
 return relevanceRatioTokens(text,tokenize(instruction));
}
