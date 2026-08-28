// Lightweight machine: fetches raw server-rendered HTML via plain HTTP - no browser, no JS
// execution, no LLM. Used as a fast/free first attempt everywhere a page needs to be read,
// before falling back to the full browser-driven WebMachine for pages that need real
// interaction (clicks, JS-rendered content, native downloads).

const DEFAULT_HEADERS={
 "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
 "Accept-Language":"en-US,en;q=0.9"
};
const FILE_RE=/\.pdf(?:$|[?#])/i;
const KEYWORD_RE=/download|attachment|첨부|다운로드|pdf/i;
const LINK_RE=/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
const MAX_STEPS_DEFAULT=6;

export type HtmlLink={url:string;text:string};

function sameHost(a:string,b:string):boolean{
 try{return new URL(a).hostname===new URL(b).hostname;}catch{return false;}
}

// Crude relevance heuristic for choosing which link to follow next, with no LLM involved:
// how many distinctive words from the instruction appear in the link's own text.
function tokenize(s:string):string[]{
 return s.toLowerCase().split(/[\s,·\-–—/|]+/).map(t=>t.trim()).filter(t=>t.length>=2);
}
function overlapScore(text:string,tokens:string[]):number{
 const t=text.toLowerCase();
 return tokens.reduce((n,tok)=>n+(t.includes(tok)?1:0),0);
}

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
 async findDirectFile(url:string):Promise<string|null>{
  const html=await this.fetchHtml(url);
  if(!html)return null;
  const links=this.extractLinks(html,url);
  const direct=links.find(l=>FILE_RE.test(l.url))
   ||links.find(l=>sameHost(l.url,url)&&KEYWORD_RE.test(l.text));
  return direct?.url||null;
 }

 // Multi-hop version: follow same-site links purely via HTTP, no browser/LLM, scoring each
 // page's candidate links by word overlap with the instruction. Good for static/server-rendered
 // sites; sites that need real interaction (JS, clicks, forms) won't be reachable this way and
 // should fall back to WebMachine instead.
 async resolve(startUrl:string,instruction:string,maxSteps=MAX_STEPS_DEFAULT){
  const history:any[]=[];
  const tokens=tokenize(instruction);
  const seen=new Set<string>();
  let url=startUrl;

  for(let i=0;i<maxSteps;i++){
   if(seen.has(url))break;
   seen.add(url);
   if(FILE_RE.test(url))return{ok:true,url,history};

   const html=await this.fetchHtml(url);
   if(!html)break;
   const links=this.extractLinks(html,url);
   console.error(`HtmlMachine: ${url} -> ${html.length} bytes, ${links.length} links`);

   const direct=links.find(l=>FILE_RE.test(l.url))
    ||links.find(l=>sameHost(l.url,url)&&KEYWORD_RE.test(l.text));
   if(direct){history.push({url,action:direct});return{ok:true,url:direct.url,history};}

   const next=links
    .filter(l=>!seen.has(l.url)&&sameHost(l.url,startUrl))
    .map(l=>({...l,score:overlapScore(l.text,tokens)}))
    .filter(l=>l.score>0)
    .sort((a,b)=>b.score-a.score)[0];
   if(!next)break;
   history.push({url,action:next});
   url=next.url;
  }
  return{ok:false,history};
 }
}
