import {test} from "node:test";
import assert from "node:assert/strict";
import {isFilterFlowIncomplete,evaluatePick,pickFallbackCandidate,classifyObserveError,shrinkCandidateCap} from "./resolver.js";

test("isFilterFlowIncomplete is false when history is empty (nothing picked yet)", () => {
 assert.equal(isFilterFlowIncomplete([]),false);
});

test("isFilterFlowIncomplete is true after a filter button is picked but no submit yet", () => {
 const history=[{action:{kind:"button",nav:false,text:"9월"}}];
 assert.equal(isFilterFlowIncomplete(history),true);
});

test("isFilterFlowIncomplete is false once a submit/search action has happened", () => {
 const history=[
  {action:{kind:"button",nav:false,text:"9월"}},
  {action:{kind:"button",nav:false,text:"모의고사 찾기"}},
 ];
 assert.equal(isFilterFlowIncomplete(history),false);
});

test("isFilterFlowIncomplete ignores nav clicks (they aren't filter picks)", () => {
 const history=[{action:{kind:"button",nav:true,text:"메뉴 열기"}}];
 assert.equal(isFilterFlowIncomplete(history),false);
});

test("isFilterFlowIncomplete regression: a filter-reset button's own text ('필터') must not itself count as a submit action", () => {
 const history=[
  {action:{kind:"button",nav:false,text:"9월"}},
  {action:{kind:"button",nav:false,text:"선택된 필터 모두 지우기"}},
 ];
 assert.equal(isFilterFlowIncomplete(history),true);
});

test("evaluatePick allows a genuinely clickable, relevant, non-destructive pick", () => {
 const out=evaluatePick({tag:"BUTTON",isInsideLink:false,description:"받기",filterFlowIncomplete:false,currentPageHasDownloadIntent:false,relevance:1});
 assert.equal(out.reject,false);
 assert.equal(out.isLink,false);
});

test("evaluatePick rejects a link picked while the filter flow is incomplete", () => {
 const out=evaluatePick({tag:"A",isInsideLink:false,description:"2024년 고3 6월 모평 사회문화",filterFlowIncomplete:true,currentPageHasDownloadIntent:false,relevance:1});
 assert.equal(out.reject,true);
 assert.equal(out.isLink,true);
 assert.match(out.reason!,/filter flow/);
});

test("evaluatePick rejects a link even when only reachable through a nested element inside an <a> (regression: a <span>/<div> wrapped inside an anchor for styling was missed by exact-tag checks twice in practice)", () => {
 const out=evaluatePick({tag:"SPAN",isInsideLink:true,description:"어떤 링크",filterFlowIncomplete:true,currentPageHasDownloadIntent:false,relevance:1});
 assert.equal(out.reject,true);
 assert.equal(out.isLink,true);
});

test("evaluatePick rejects a non-interactive layout element regardless of filter-flow state", () => {
 const out=evaluatePick({tag:"H1",isInsideLink:false,description:"시험 제목",filterFlowIncomplete:false,currentPageHasDownloadIntent:false,relevance:1});
 assert.equal(out.reject,true);
 assert.match(out.reason!,/H1/);
});

test("evaluatePick rejects a reset/clear action", () => {
 const out=evaluatePick({tag:"BUTTON",isInsideLink:false,description:"초기화",filterFlowIncomplete:false,currentPageHasDownloadIntent:false,relevance:1});
 assert.equal(out.reject,true);
 assert.match(out.reason!,/undo progress/);
});

test("evaluatePick rejects a destructive/irreversible action", () => {
 const out=evaluatePick({tag:"BUTTON",isInsideLink:false,description:"로그아웃",filterFlowIncomplete:false,currentPageHasDownloadIntent:false,relevance:1});
 assert.equal(out.reject,true);
 assert.match(out.reason!,/destructive/);
});

test("evaluatePick rejects a distraction: a zero-relevance, non-download link away from a page that already has a download button visible", () => {
 const out=evaluatePick({tag:"A",isInsideLink:false,description:"관련 시험 항목",filterFlowIncomplete:false,currentPageHasDownloadIntent:true,relevance:0});
 assert.equal(out.reject,true);
 assert.match(out.reason!,/unrelated page/);
});

test("evaluatePick does NOT reject a link with partial relevance away from a download-ready page (only exact-zero relevance counts as a distraction, so a genuinely-related sibling link stays selectable)", () => {
 const out=evaluatePick({tag:"A",isInsideLink:false,description:"같은 시험 다른 과목 사회문화",filterFlowIncomplete:false,currentPageHasDownloadIntent:true,relevance:0.25});
 assert.equal(out.reject,false);
});

test("evaluatePick does NOT reject a download-looking link even with zero text relevance (the download keyword itself is the signal)", () => {
 const out=evaluatePick({tag:"A",isInsideLink:false,description:"다운로드",filterFlowIncomplete:false,currentPageHasDownloadIntent:true,relevance:0});
 assert.equal(out.reject,false);
});

test("pickFallbackCandidate prefers a higher-scoring non-nav candidate over a lower-scoring one", () => {
 const candidates:any=[
  {kind:"button",nav:false,text:"고1",selector:"a"},
  {kind:"button",nav:false,text:"사회문화",selector:"b"},
 ];
 const scores:Record<string,number>={a:0,b:1};
 const picked=pickFallbackCandidate(candidates,c=>scores[c.selector??""]??0);
 assert.equal(picked?.selector,"b");
});

test("pickFallbackCandidate avoids nav (chrome/menu) candidates when a non-nav option exists, even if the nav one scores higher", () => {
 const candidates:any=[
  {kind:"link",nav:true,text:"홈",selector:"nav1",url:"https://x.com/"},
  {kind:"button",nav:false,text:"고3",selector:"content1"},
 ];
 const picked=pickFallbackCandidate(candidates,()=>0);
 assert.equal(picked?.selector,"content1");
});

test("pickFallbackCandidate falls back to a nav candidate only when nothing else is available", () => {
 const candidates:any=[{kind:"link",nav:true,text:"홈",selector:"nav1",url:"https://x.com/"}];
 const picked=pickFallbackCandidate(candidates,()=>0);
 assert.equal(picked?.selector,"nav1");
});

test("pickFallbackCandidate returns undefined for an empty candidate list", () => {
 assert.equal(pickFallbackCandidate([],()=>0),undefined);
});

test("classifyObserveError recognizes a credits/payment error (regression: the exact HTTP 402 message an exhausted OpenRouter balance produced)", () => {
 const msg=`OpenAI-compatible endpoint error: HTTP 402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 16384 tokens, but can only afford 15745.","code":402}}`;
 assert.equal(classifyObserveError(msg),"credits-exhausted");
});

test("classifyObserveError recognizes a request-too-large per-minute-token error (regression: the exact Groq TPM message hit repeatedly this session)", () => {
 const msg="Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 19758, please reduce your message size and try again.";
 assert.equal(classifyObserveError(msg),"request-too-large");
});

test("classifyObserveError does not misclassify an unrelated error", () => {
 assert.equal(classifyObserveError("Navigation timeout of 60000 ms exceeded"),"other");
});

test("shrinkCandidateCap halves both button and link caps", () => {
 assert.deepEqual(shrinkCandidateCap({button:30,link:15}),{button:15,link:7});
});

test("shrinkCandidateCap never shrinks below its floor, even after repeated calls", () => {
 let cap={button:30,link:15};
 for(let i=0;i<10;i++)cap=shrinkCandidateCap(cap);
 assert.equal(cap.button,10);
 assert.equal(cap.link,5);
});
