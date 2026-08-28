import {FILE_RE} from "./patterns.js";
export type Candidate={kind:string;text:string;url?:string;selector?:string;score:number;nav:boolean};
const EVAL_SOURCE=`(() => {
  const a = [];
  function add(kind, e, url) {
    const text = (e.innerText || e.textContent || e.getAttribute("aria-label") || e.title || "").trim().replace(/\\s+/g, " ").slice(0, 300);
    if (text || url) a.push({ kind, text, url: url || undefined, selector: e.id ? "#" + CSS.escape(e.id) : undefined, nav: Boolean(e.closest("nav,header")) });
  }
  document.querySelectorAll("a[href],[download],button,[role=button],iframe[src]").forEach((e) => {
    if (e.hasAttribute("download")) add("download", e, e.href || e.getAttribute("href"));
    else if (e.tagName === "A") add("link", e, e.href);
    else if (e.tagName === "IFRAME") add("frame", e, e.src);
    else add("button", e);
  });
  return a;
})()`;
const MAX_CANDIDATES=30;
export async function inspect(page:any):Promise<Candidate[]>{
 const xs=await page.evaluate(EVAL_SOURCE);
 const scored=xs.map((x:any)=>{const s=x.text.toLowerCase();let score=0;if(/pdf|첨부|다운로드|download|문제|사회문화|사회·문화|파일|attachment/.test(s))score+=60;if(x.kind==="download")score+=40;if(FILE_RE.test(x.url||""))score+=100;return{...x,score};});
 const seen=new Set<string>();
 const deduped=scored.filter((c:any)=>{const key=`${c.kind}|${c.text}|${c.url||""}`;if(seen.has(key))return false;seen.add(key);return true;});
 return deduped.sort((a:any,b:any)=>b.score-a.score).slice(0,MAX_CANDIDATES);
}
