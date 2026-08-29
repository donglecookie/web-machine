import {KEYWORD_RE,FileType,ANY_FILE_TYPE} from "./patterns.js";
export type Candidate={kind:string;text:string;url?:string;selector?:string;score:number;nav:boolean};
const EVAL_SOURCE=`(() => {
  const a = [];
  function cssPath(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node.parentElement) {
      let part = node.tagName.toLowerCase();
      const siblings = Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName);
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.length ? parts.join(" > ") : null;
  }
  function nearbyLabel(e) {
    let node = e.parentElement;
    for (let depth = 0; depth < 3 && node; depth++, node = node.parentElement) {
      const label = node.getAttribute && node.getAttribute("aria-label");
      if (label) return label.trim();
      const heading = node.querySelector && node.querySelector("h1,h2,h3,h4,h5,h6");
      if (heading && heading.textContent.trim()) return heading.textContent.trim().slice(0, 60);
    }
    return "";
  }
  function add(kind, e, url) {
    let text = (e.innerText || e.textContent || e.getAttribute("aria-label") || e.title || "").trim().replace(/\\s+/g, " ").slice(0, 300);
    if (text.length > 0 && text.length <= 6) {
      const ctx = nearbyLabel(e);
      if (ctx && !text.includes(ctx)) text = ctx + " " + text;
    }
    if (text || url) a.push({ kind, text, url: url || undefined, selector: cssPath(e) || undefined, nav: Boolean(e.closest("nav,header")) });
  }
  document.querySelectorAll('a[href],[download],button,[role=button],[role=tab],[tabindex="0"],iframe[src],embed[src],object[data]').forEach((e) => {
    if (e.hasAttribute("download")) add("download", e, e.href || e.getAttribute("href"));
    else if (e.tagName === "A") add("link", e, e.href);
    else if (e.tagName === "IFRAME" || e.tagName === "EMBED") add("frame", e, e.src);
    else if (e.tagName === "OBJECT") add("frame", e, e.getAttribute("data"));
    else add("button", e);
  });
  return a;
})()`;
const MAX_CANDIDATES=60;
export async function inspect(page:any,fileType:FileType=ANY_FILE_TYPE):Promise<Candidate[]>{
 const xs=await page.evaluate(EVAL_SOURCE);
 // This is a coarse initial ranking only - genuine relevance-to-instruction ranking happens
 // later via relevanceRatio in resolver.ts. Here we just want a reasonable starting order and
 // a signal for the zero-LLM mechanical fallback, so the boost stays generic (download intent
 // + the requested file type's own extension), not tied to any particular site or subject.
 const scored=xs.map((x:any)=>{const s=x.text.toLowerCase();let score=0;if(KEYWORD_RE.test(s)||fileType.aliases.some(a=>s.includes(a.toLowerCase())))score+=60;if(x.kind==="download")score+=40;if(fileType.extRe.test(x.url||""))score+=100;return{...x,score};});
 const seen=new Set<string>();
 // Include the selector in the de-dup key: several genuinely distinct elements (e.g. three
 // separate "다운로드" buttons under different tabs) can share identical text/kind/url, and
 // collapsing them by text alone would silently discard all but one option.
 const deduped=scored.filter((c:any)=>{const key=`${c.kind}|${c.text}|${c.url||""}|${c.selector||""}`;if(seen.has(key))return false;seen.add(key);return true;});
 return deduped.sort((a:any,b:any)=>b.score-a.score).slice(0,MAX_CANDIDATES);
}
