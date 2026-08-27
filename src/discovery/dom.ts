export type Candidate={kind:string;text:string;url?:string;selector?:string;score:number};
const EVAL_SOURCE=`(() => {
  const a = [];
  function add(kind, e, url) {
    const text = (e.innerText || e.textContent || e.getAttribute("aria-label") || e.title || "").trim().replace(/\\s+/g, " ").slice(0, 300);
    if (text || url) a.push({ kind, text, url: url || undefined, selector: e.id ? "#" + CSS.escape(e.id) : undefined });
  }
  document.querySelectorAll("a[href]").forEach((e) => add("link", e, e.href));
  document.querySelectorAll("[download]").forEach((e) => add("download", e, e.href || e.getAttribute("href")));
  document.querySelectorAll("button,[role=button]").forEach((e) => add("button", e));
  document.querySelectorAll("iframe[src]").forEach((e) => add("frame", e, e.src));
  return a;
})()`;
const MAX_CANDIDATES=40;
export async function inspect(page:any):Promise<Candidate[]>{
 const xs=await page.evaluate(EVAL_SOURCE);
 const scored=xs.map((x:any)=>{const s=`${x.text} ${x.url||""}`.toLowerCase();let score=0;if(/pdf|첨부|다운로드|download|문제|사회문화|사회·문화|파일|attachment/.test(s))score+=60;if(x.kind==="download")score+=40;if(/\.pdf(?:$|[?#])/i.test(x.url||""))score+=100;return{...x,score};});
 const seen=new Set<string>();
 const deduped=scored.filter((c:any)=>{const key=`${c.kind}|${c.text}|${c.url||""}`;if(seen.has(key))return false;seen.add(key);return true;});
 return deduped.sort((a:any,b:any)=>b.score-a.score).slice(0,MAX_CANDIDATES);
}
