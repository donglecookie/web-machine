export const FILE_RE=/\.pdf(?:$|[?#])/i;
export const KEYWORD_RE=/download|attachment|첨부|다운로드|pdf/i;
export function sameHost(a:string,b:string):boolean{
 try{return new URL(a).hostname===new URL(b).hostname;}catch{return false;}
}

// PDF viewers (PDF.js and similar embeds) often load the actual file via a query parameter
// on a wrapper/viewer URL (e.g. "viewer.html?file=https%3A%2F%2Fcdn.example.com%2Fdoc.pdf")
// rather than the visible URL itself ending in .pdf. Unwrap that case so we resolve the real
// file, not the viewer page.
export function resolvePdfUrl(url:string):string|null{
 if(FILE_RE.test(url))return url;
 try{
  const u=new URL(url);
  for(const v of u.searchParams.values()){
   const decoded=decodeURIComponent(v);
   if(FILE_RE.test(decoded)&&/^https?:\/\//i.test(decoded))return decoded;
  }
 }catch{}
 return null;
}

// verify() only confirms a file is a non-empty PDF, not that it's the RIGHT PDF - a wrong
// same-page candidate (e.g. a different subject/date under identical filter selections) can
// still download a valid-but-irrelevant file and look like a clean success. This gives a
// rough, honest signal of whether the result plausibly matches what was asked for, based on
// how many distinctive words from the instruction appear in the resulting filename/URL. Also
// used (via relevanceRatioTokens) to rank page candidates by relevance to the instruction
// instead of relying on a fixed, site-tuned candidate count.
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
