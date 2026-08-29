import {test} from "node:test";
import assert from "node:assert/strict";
import {FILE_RE,KEYWORD_RE,sameHost,resolvePdfUrl,tokenize,relevanceRatioTokens,relevanceRatio} from "./patterns.js";

test("FILE_RE matches .pdf urls with query/hash/end", () => {
 assert.ok(FILE_RE.test("https://x.com/a.pdf"));
 assert.ok(FILE_RE.test("https://x.com/a.pdf?x=1"));
 assert.ok(FILE_RE.test("https://x.com/a.pdf#page=2"));
 assert.ok(!FILE_RE.test("https://x.com/a.pdfx"));
 assert.ok(!FILE_RE.test("https://x.com/a.html"));
});

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

test("resolvePdfUrl returns the url itself when it already ends in .pdf", () => {
 assert.equal(resolvePdfUrl("https://a.com/doc.pdf"),"https://a.com/doc.pdf");
});

test("resolvePdfUrl unwraps a pdf hidden in a query parameter (PDF.js-style viewer)", () => {
 const wrapped="https://a.com/viewer.html?file="+encodeURIComponent("https://cdn.a.com/real.pdf")+"&x=1";
 assert.equal(resolvePdfUrl(wrapped),"https://cdn.a.com/real.pdf");
});

test("resolvePdfUrl returns null when no .pdf is found anywhere", () => {
 assert.equal(resolvePdfUrl("https://a.com/viewer.html?file=https%3A%2F%2Fa.com%2Fdoc.html"),null);
 assert.equal(resolvePdfUrl("not a url at all"),null);
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

test("relevanceRatio treats an instruction with no meaningful tokens as fully relevant", () => {
 assert.equal(relevanceRatio("anything.pdf",""),1);
});
