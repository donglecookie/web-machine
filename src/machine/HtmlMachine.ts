// Lightweight machine: fetches raw server-rendered HTML via plain HTTP - no browser, no JS
// execution, no LLM. Used as a fast/free first attempt everywhere a page needs to be read,
// before falling back to the full browser-driven WebMachine for pages that need real
// interaction (clicks, JS-rendered content, native downloads).

import {KEYWORD_RE,sameHost,resolveFileUrl,FileType,ANY_FILE_TYPE} from "../discovery/patterns.js";
const DEFAULT_HEADERS={
 "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
 "Accept-Language":"en-US,en;q=0.9"
};
const LINK_RE=/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;

export type HtmlLink={url:string;text:string};

export class HtmlMachine{
 async fetchHtml(url:string):Promise<string|null>{
  try{
   const res=await fetch(url,{headers:DEFAULT_HEADERS});
   if(!res.ok){console.error(`HtmlMachine: fetch ${url} -> HTTP ${res.status}`);return null;}
   return await res.text();
  }catch(e){
   console.error(`HtmlMachine: fetch ${url} threw:`,e instanceof Error?e.message:String(e));
   return null;
  }
 }

 extractLinks(html:string,baseUrl:string):HtmlLink[]{
  const out:HtmlLink[]=[];
  for(const m of html.matchAll(LINK_RE)){
   try{out.push({url:new URL(m[1],baseUrl).href,text:m[2].replace(/<[^>]+>/g,"").trim()});}catch{}
  }
  return out;
 }

 // Quick pass: does the raw HTML already contain an obvious direct file link, without
 // needing a browser at all? Mirrors the DOM "direct match" heuristic used by WebMachine.
 async findDirectFile(url:string,fileType:FileType=ANY_FILE_TYPE):Promise<string|null>{
  const html=await this.fetchHtml(url);
  if(!html)return null;
  const links=this.extractLinks(html,url);
  const direct=links.find(l=>resolveFileUrl(l.url,fileType))
   ||links.find(l=>sameHost(l.url,url)&&KEYWORD_RE.test(l.text));
  if(!direct?.url)return null;
  return resolveFileUrl(direct.url,fileType)||direct.url;
 }
}
