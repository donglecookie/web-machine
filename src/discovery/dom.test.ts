import {test} from "node:test";
import assert from "node:assert/strict";
import {inspect} from "./dom.js";
import {detectFileType} from "./patterns.js";

// inspect()'s own DOM scan (EVAL_SOURCE) runs inside a real browser page and can't be
// exercised here without one - these tests instead drive inspect()'s scoring/ranking logic
// directly by faking what page.evaluate() would have returned, the same pattern already used
// for resolve()'s orchestration tests.
function fakePage(rawCandidates:unknown[]){
 return{evaluate:async()=>rawCandidates}as any;
}

test("inspect scores an image candidate whose URL extension matches the requested image type (regression: <img> elements were never scanned as candidates at all before this, so an image search over ordinary <img src=...> content had nothing to find regardless of relevance)", async () => {
 const fileType=detectFileType("스페인 선박 이미지");
 const candidates=await inspect(fakePage([
  {kind:"image",text:"스페인 선박",selector:"img1",url:"https://example.com/spain-ship.jpg",nav:false},
  {kind:"image",text:"로고",selector:"img2",url:"https://example.com/logo.png",nav:false},
 ]),fileType,["스페인","선박","이미지"]);
 const spain=candidates.find(c=>c.selector==="img1");
 const logo=candidates.find(c=>c.selector==="img2");
 assert.ok(spain);
 assert.ok(logo);
 assert.ok(spain!.score>logo!.score,"the relevant image should outscore an unrelated one despite both matching the image extension");
});

test("inspect ranks a matching-extension image above a same-relevance non-image candidate (the +100 extension bonus applies regardless of candidate kind)", async () => {
 const fileType=detectFileType("스페인 선박 이미지");
 const candidates=await inspect(fakePage([
  {kind:"image",text:"스페인 선박",selector:"img1",url:"https://example.com/spain-ship.jpg",nav:false},
  {kind:"link",text:"스페인 선박",selector:"link1",url:"https://example.com/spain-ship",nav:false}, // same text, no image extension
 ]),fileType,["스페인","선박","이미지"]);
 const image=candidates.find(c=>c.selector==="img1")!;
 const link=candidates.find(c=>c.selector==="link1")!;
 assert.ok(image.score>link.score);
});

test("inspect returns an empty list for an empty scan", async () => {
 const candidates=await inspect(fakePage([]));
 assert.deepEqual(candidates,[]);
});

test("inspect gives an image candidate the same 'likely IS the target file' bonus as a download candidate, not just the extension-match bonus (regression: the bonus was download-kind-only, under-ranking an equally-matching image against an equally-matching download link)", async () => {
 const fileType=detectFileType("스페인 선박 이미지");
 const candidates=await inspect(fakePage([
  {kind:"image",text:"스페인 선박",selector:"img1",url:"https://example.com/spain-ship.jpg",nav:false},
  {kind:"download",text:"스페인 선박",selector:"dl1",url:"https://example.com/spain-ship.jpg",nav:false},
 ]),fileType,["스페인","선박","이미지"]);
 const image=candidates.find(c=>c.selector==="img1")!;
 const download=candidates.find(c=>c.selector==="dl1")!;
 assert.equal(image.score,download.score,"identical text/url/extension should score identically regardless of download vs image kind");
});
