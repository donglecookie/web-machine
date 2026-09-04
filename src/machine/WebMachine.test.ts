import {test} from "node:test";
import assert from "node:assert/strict";
import {withRelevanceCheck} from "./WebMachine.js";

test("withRelevanceCheck passes through a failed result unchanged (no relevance check needed)", () => {
 const result={ok:false,message:"No file URL found.",history:[]};
 assert.deepEqual(withRelevanceCheck(result,"anything"),result);
});

test("withRelevanceCheck warns when neither the path nor the history text is relevant", () => {
 const result={ok:true,path:"downloads/random123.pdf",history:[{action:{text:"클릭"}}]};
 const out=withRelevanceCheck(result,"2025학년도 9월 모의평가 사회문화");
 assert.ok(out.warning);
});

test("withRelevanceCheck: an opaque CDN filename alone would warn, but the descriptive link text that led there rescues it (regression: EBSI-style coded URLs like 's_samun_mun_A1AT6KCF.pdf' carry no readable info, but the link's own text before the click usually does)", () => {
 const result={
  ok:true,
  path:"downloads/s_samun_mun_A1AT6KCF.pdf",
  history:[
   {action:{text:"보기"}},
   {action:{text:"2025년 고3 9월 모평(평가원) 사회·문화_문제지.pdf 원본 열기"}},
  ],
 };
 const out=withRelevanceCheck(result,"2025학년도 9월 모의평가 사회문화");
 assert.equal(out.warning,undefined);
});

test("withRelevanceCheck checks a short window of recent history, not just the very last action (regression: a native-download trigger like '받기' is itself undescriptive - the actually-descriptive exam-name click can be a step or two earlier, e.g. the direct-download WebMachine path where the last history entry is just the '받기' button click)", () => {
 const result={
  ok:true,
  path:"downloads/dl_a1b2c3.pdf", // opaque saved filename, same as a native-download save would produce
  history:[
   {action:{text:"9월"}},
   {action:{text:"2025년 고3 9월 모평(평가원) 사회·문화"}}, // the descriptive click - two steps back, not last
   {action:{text:"받기"}}, // last action: undescriptive on its own
  ],
 };
 const out=withRelevanceCheck(result,"2025학년도 9월 모의평가 사회문화");
 assert.equal(out.warning,undefined);
});

test("withRelevanceCheck still warns even with descriptive history text, if that text is itself irrelevant", () => {
 const result={
  ok:true,
  path:"downloads/xyz789.pdf",
  history:[{action:{text:"2024년 고2 6월 학평(부산) 수학 원본 열기"}}],
 };
 const out=withRelevanceCheck(result,"2025학년도 9월 모의평가 사회문화");
 assert.ok(out.warning);
});
