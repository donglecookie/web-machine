import {test} from "node:test";
import assert from "node:assert/strict";
import {KEYWORD_RE,SUBMIT_INTENT_RE,sameHost,resolveFileUrl,tokenize,relevanceRatioTokens,relevanceRatio,detectFileType,FILE_TYPES} from "./patterns.js";

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
 assert.equal(relevanceRatioTokens("2025년 고3 9월 모평(평가원) 한문Ⅰ_문제지.pdf",tokens)<0.5,true);
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

test("relevanceRatio treats an instruction with no meaningful tokens as fully relevant", () => {
 assert.equal(relevanceRatio("anything.pdf",""),1);
});
