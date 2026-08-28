export const FILE_RE=/\.pdf(?:$|[?#])/i;
export const KEYWORD_RE=/download|attachment|첨부|다운로드|pdf/i;
export function sameHost(a:string,b:string):boolean{
 try{return new URL(a).hostname===new URL(b).hostname;}catch{return false;}
}
