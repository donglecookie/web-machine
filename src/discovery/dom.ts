import {KEYWORD_RE,FileType,ANY_FILE_TYPE,relevanceRatioTokens} from "./patterns.js";
export type Candidate={kind:string;text:string;url?:string;selector?:string;fallbackSelector?:string;score:number;nav:boolean};
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
  function stableId(el) {
    // Tag each candidate with our own attribute and select by it. Structural paths (CSS
    // nth-of-type chains, XPath) describe a position that silently stops matching the moment
    // the page re-renders, and mixing the two formats made "is this the element I already
    // tried?" a string comparison that could never succeed across formats. An injected id is
    // one format, survives re-render as long as the node does, and stays comparable.
    let id = el.getAttribute("data-wm-id");
    if (!id) { id = "wm" + (window.__wmSeq = (window.__wmSeq || 0) + 1); el.setAttribute("data-wm-id", id); }
    return id;
  }
  function add(kind, e, url) {
    let text = (e.innerText || e.textContent || e.getAttribute("aria-label") || e.title || "").trim().replace(/\\s+/g, " ").slice(0, 300);
    if (text.length > 0 && text.length <= 6) {
      const ctx = nearbyLabel(e);
      if (ctx && !text.includes(ctx)) text = ctx + " " + text;
    }
    if (text || url) a.push({
      kind, text, url: url || undefined,
      selector: '[data-wm-id="' + stableId(e) + '"]',
      // Keep the structural path too: it's the only usable handle if the page replaces the
      // node (dropping our attribute with it) between scraping and clicking.
      fallbackSelector: cssPath(e) || undefined,
      nav: Boolean(e.closest("nav,header")),
    });
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
export async function inspect(page:any,fileType:FileType=ANY_FILE_TYPE,instructionTokens:string[]=[]):Promise<Candidate[]>{
 const xs=await page.evaluate(EVAL_SOURCE);
 // Hoisted out of the per-candidate loop below: aliases are a small, fixed list (and already
 // lowercase in every FILE_TYPES entry) - no reason to re-lowercase them for every candidate.
 const lowerAliases=fileType.aliases.map(a=>a.toLowerCase());
 // This is a coarse initial ranking only - genuine relevance-to-instruction ranking (fuzzy
 // matching + candidate-pool-based token weighting) happens later in resolver.ts, once the
 // full candidate list for a step is known. But without ANY instruction-awareness here, a
 // page with many same-shaped candidates (e.g. one filter/문제지/정답지/해설지 button group
 // per subject, times dozens of subjects) can genuinely exceed MAX_CANDIDATES before it even
 // reaches resolver.ts - and since none of those buttons match the generic KEYWORD_RE (no
 // literal "download"/"받기" text), they all tie at score 0, so the ACTUAL target subject can
 // get truncated away by nothing more than raw DOM order, before any relevance sorting
 // downstream gets a chance to save it. A modest instruction-relevance boost here (unweighted
 // - there's no full candidate pool yet to compute token weights from) is enough to keep a
 // genuinely matching candidate alive into the pool that resolver.ts actually sees.
 const scored=xs.map((x:any)=>{
  const s=x.text.toLowerCase();
  let score=0;
  if(KEYWORD_RE.test(s)||lowerAliases.some(a=>s.includes(a)))score+=60;
  if(x.kind==="download")score+=40;
  if(fileType.extRe.test(x.url||""))score+=100;
  if(instructionTokens.length)score+=relevanceRatioTokens(x.text,instructionTokens)*200;
  return{...x,score};
 });
 const seen=new Set<string>();
 // Include the selector in the de-dup key: several genuinely distinct elements (e.g. three
 // separate "다운로드" buttons under different tabs) can share identical text/kind/url, and
 // collapsing them by text alone would silently discard all but one option.
 const deduped=scored.filter((c:any)=>{const key=`${c.kind}|${c.text}|${c.url||""}|${c.selector||""}`;if(seen.has(key))return false;seen.add(key);return true;});
 return deduped.sort((a:any,b:any)=>b.score-a.score).slice(0,MAX_CANDIDATES);
}
