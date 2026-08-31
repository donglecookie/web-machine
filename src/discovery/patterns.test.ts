import {test} from "node:test";
import assert from "node:assert/strict";
import {KEYWORD_RE,SUBMIT_INTENT_RE,RESET_INTENT_RE,DESTRUCTIVE_INTENT_RE,sameHost,resolveFileUrl,tokenize,relevanceRatioTokens,relevanceRatio,detectFileType,FILE_TYPES} from "./patterns.js";

const PDF=FILE_TYPES.find(t=>t.name==="pdf")!;
const XLSX=FILE_TYPES.find(t=>t.name==="xlsx")!;

test("KEYWORD_RE matches common download/file keywords, Korean and English", () => {
 assert.ok(KEYWORD_RE.test("다운로드"));
 assert.ok(KEYWORD_RE.test("Download now"));
 assert.ok(KEYWORD_RE.test("첨부파일"));
 assert.ok(!KEYWORD_RE.test("전체보기"));
});

test("sameHost compares hostnames only, ignoring path/protocol quirks", () => {
 assert.ok(sameHost("https://a.com/x","https://a.com/y"));
 assert.ok(!sameHost("https://a.com/x","https://b.com/x"));
 assert.ok(!sameHost("not a url","https://a.com/x"));
});

test("detectFileType picks the type named in the instruction (not always PDF)", () => {
 assert.equal(detectFileType("2025년 예산안 엑셀 파일 받아줘").name,"xlsx");
 assert.equal(detectFileType("발표자료 파워포인트 찾아줘").name,"pptx");
 assert.equal(detectFileType("압축파일로 된 소스코드").name,"zip");
 assert.equal(detectFileType("이미지 다운로드").name,"image");
});

test("detectFileType falls back to the 'any' wildcard (not any single format) when nothing specific is named", () => {
 const result=detectFileType("2025학년도 9월 모의평가 사회문화");
 assert.equal(result.name,"any");
 assert.ok(result.extRe.test("https://x.com/a.pdf")); // still matches known formats
 assert.ok(result.extRe.test("https://x.com/a.xlsx"));
});

test("resolveFileUrl (pdf) returns the url itself when it already ends in .pdf", () => {
 assert.equal(resolveFileUrl("https://a.com/doc.pdf",PDF),"https://a.com/doc.pdf");
 assert.ok(!resolveFileUrl("https://a.com/doc.pdf",XLSX)); // wrong type for the requested policy
});

test("resolveFileUrl (xlsx) matches .xlsx/.xls urls the same way", () => {
 assert.equal(resolveFileUrl("https://a.com/budget.xlsx",XLSX),"https://a.com/budget.xlsx");
 assert.equal(resolveFileUrl("https://a.com/budget.xls",XLSX),"https://a.com/budget.xls");
});

test("resolveFileUrl unwraps a file url hidden in a query parameter (viewer-style wrapper)", () => {
 const wrapped="https://a.com/viewer.html?file="+encodeURIComponent("https://cdn.a.com/real.pdf")+"&x=1";
 assert.equal(resolveFileUrl(wrapped,PDF),"https://cdn.a.com/real.pdf");
});

test("resolveFileUrl returns null when no matching file is found anywhere", () => {
 assert.equal(resolveFileUrl("https://a.com/viewer.html?file=https%3A%2F%2Fa.com%2Fdoc.html",PDF),null);
 assert.equal(resolveFileUrl("not a url at all",PDF),null);
});

test("tokenize splits on whitespace/punctuation and drops single-character tokens", () => {
 assert.deepEqual(tokenize("2025학년도 9월 모의평가 사회문화"),["2025학년도","9월","모의평가","사회문화"]);
 assert.deepEqual(tokenize("ab-c_de(f)gh"),["ab","de","gh"]); // single-char tokens (c, f) are dropped
});

test("relevanceRatioTokens scores fraction of instruction tokens found in the text", () => {
 const tokens=tokenize("2025학년도 9월 모의평가 사회문화");
 assert.equal(relevanceRatioTokens("2025년 고3 9월 모평(평가원) 사회문화_문제지.pdf",tokens)>=0.5,true);
 // Wrong subject AND wrong year/month - relevance should be near zero, not just "less than the exact match"
 assert.equal(relevanceRatioTokens("2023년 고3 6월 모평(평가원) 한문Ⅰ_문제지.pdf",tokens)<0.5,true);
});

test("relevanceRatioTokens matches a 4-digit year regardless of Korean suffix (regression: '2025학년도' in the instruction failed to match a '2025년' filter button due to the different suffix, so all year buttons tied at zero relevance and the fallback clicked through them in raw order, overwriting the correct one)", () => {
 const tokens=tokenize("2025학년도 9월 모의평가 사회문화");
 assert.ok(relevanceRatioTokens("2025년",tokens)>0);
 assert.equal(relevanceRatioTokens("2025년",tokens),relevanceRatioTokens("2025학년도",tokens));
 assert.equal(relevanceRatioTokens("2024년",tokens),0); // a different year must not accidentally match
});

test("relevanceRatioTokens matches through a middle dot in the candidate text (regression: '사회문화' in the instruction failed to match '사회·문화' as actually written on real sites, silently under-scoring relevance all session)", () => {
 const tokens=tokenize("2025학년도 9월 모의평가 사회문화");
 const withDot=relevanceRatioTokens("2025년 고3 9월 모평(평가원) 사회·문화",tokens);
 const withoutDot=relevanceRatioTokens("2025년 고3 9월 모평(평가원) 사회문화",tokens);
 assert.equal(withDot,withoutDot);
 assert.ok(withDot>=0.5);
});

test("relevanceRatio (convenience wrapper) matches relevanceRatioTokens for the same inputs", () => {
 const instruction="2025학년도 9월 모의평가 사회문화";
 const text="2025년 고3 9월 모평(평가원) 사회문화_문제지.pdf";
 assert.equal(relevanceRatio(text,instruction),relevanceRatioTokens(text,tokenize(instruction)));
});

test("SUBMIT_INTENT_RE matches genuine search/submit button text", () => {
 assert.ok(SUBMIT_INTENT_RE.test("검색"));
 assert.ok(SUBMIT_INTENT_RE.test("모의고사 찾기"));
 assert.ok(SUBMIT_INTENT_RE.test("Search"));
});

test("SUBMIT_INTENT_RE does NOT match a filter-reset button (regression: '필터' was removed after a real 'clear all filters' button falsely counted as submitted)", () => {
 assert.ok(!SUBMIT_INTENT_RE.test("선택된 필터 모두 지우기"));
 assert.ok(!SUBMIT_INTENT_RE.test("상세 조건"));
});

test("RESET_INTENT_RE matches filter-reset buttons (regression: mechanical fallback once picked '초기화' and wiped out a just-selected filter)", () => {
 assert.ok(RESET_INTENT_RE.test("원하는 모의고사를 찾아보세요 초기화"));
 assert.ok(RESET_INTENT_RE.test("선택된 필터 모두 지우기"));
 assert.ok(RESET_INTENT_RE.test("Clear all filters"));
});

test("RESET_INTENT_RE matches 'go back' and clipboard-only actions (regression: mechanical fallback undid progress by clicking '뒤로 가기' after reaching the correct exam page, then wasted picks on '링크 복사'/'공유하기')", () => {
 assert.ok(RESET_INTENT_RE.test("2025년 고3 9월 모평(평가원) 사회·문화 뒤로 가기"));
 assert.ok(RESET_INTENT_RE.test("2025년 고3 9월 모평(평가원) 사회·문화 링크 복사"));
 assert.ok(RESET_INTENT_RE.test("2025년 고3 9월 모평(평가원) 사회·문화 공유하기"));
 assert.ok(RESET_INTENT_RE.test("Go back"));
});

test("RESET_INTENT_RE does not match unrelated buttons, including a benign 'clear search text' action", () => {
 assert.ok(!RESET_INTENT_RE.test("검색어 지우기")); // clears only the search box text, not filters - harmless
 assert.ok(!RESET_INTENT_RE.test("검색"));
 assert.ok(!RESET_INTENT_RE.test("받기"));
});

test("DESTRUCTIVE_INTENT_RE matches irreversible/account-affecting actions, Korean and English", () => {
 assert.ok(DESTRUCTIVE_INTENT_RE.test("로그아웃"));
 assert.ok(DESTRUCTIVE_INTENT_RE.test("계정 탈퇴하기"));
 assert.ok(DESTRUCTIVE_INTENT_RE.test("게시글 삭제"));
 assert.ok(DESTRUCTIVE_INTENT_RE.test("구독 신청"));
 assert.ok(DESTRUCTIVE_INTENT_RE.test("Log out"));
 assert.ok(DESTRUCTIVE_INTENT_RE.test("Delete this file"));
});

test("DESTRUCTIVE_INTENT_RE does not match ordinary read/navigate actions", () => {
 assert.ok(!DESTRUCTIVE_INTENT_RE.test("받기"));
 assert.ok(!DESTRUCTIVE_INTENT_RE.test("검색"));
 assert.ok(!DESTRUCTIVE_INTENT_RE.test("2025년 고3 9월 모평 사회문화"));
});

test("relevanceRatio treats an instruction with no meaningful tokens as fully relevant", () => {
 assert.equal(relevanceRatio("anything.pdf",""),1);
});
