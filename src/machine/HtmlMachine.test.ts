import {test} from "node:test";
import assert from "node:assert/strict";
import {HtmlMachine} from "./HtmlMachine.js";

const html=new HtmlMachine();

test("extractLinks finds double-quoted href links", () => {
 const links=html.extractLinks(`<a href="https://example.com/a">A</a>`,"https://example.com/");
 assert.equal(links.length,1);
 assert.equal(links[0].url,"https://example.com/a");
 assert.equal(links[0].text,"A");
});

test("extractLinks finds single-quoted href links (regression: a fixed double-quote assumption silently dropped every link on pages using single quotes, which real sites - Bing among them - do use, and was the root cause of a real search returning zero organic results despite the raw HTML containing dozens of links)", () => {
 const links=html.extractLinks(`<a href='https://example.com/b'>B</a>`,"https://example.com/");
 assert.equal(links.length,1);
 assert.equal(links[0].url,"https://example.com/b");
 assert.equal(links[0].text,"B");
});

test("extractLinks finds links regardless of attribute order (href not necessarily first)", () => {
 const links=html.extractLinks(`<a class="result-link" href="https://example.com/c" target="_blank">C</a>`,"https://example.com/");
 assert.equal(links.length,1);
 assert.equal(links[0].url,"https://example.com/c");
});

test("extractLinks tolerates extra whitespace around the href attribute", () => {
 const links=html.extractLinks(`<a  href = "https://example.com/d" >D</a>`,"https://example.com/");
 assert.equal(links.length,1);
 assert.equal(links[0].url,"https://example.com/d");
});

test("extractLinks resolves relative URLs against the given base", () => {
 const links=html.extractLinks(`<a href="/path/page">E</a>`,"https://example.com/base/");
 assert.equal(links.length,1);
 assert.equal(links[0].url,"https://example.com/path/page");
});

test("extractLinks strips nested markup from link text", () => {
 const links=html.extractLinks(`<a href="https://example.com/f"><span>F</span> text</a>`,"https://example.com/");
 assert.equal(links.length,1);
 assert.equal(links[0].text,"F text");
});

test("extractLinks finds multiple links of mixed quote styles in the same document", () => {
 const doc=`
  <a href="https://example.com/1">One (double)</a>
  <a href='https://example.com/2'>Two (single)</a>
  <a class="x" href="https://example.com/3" data-y="z">Three (attrs before/after)</a>
 `;
 const links=html.extractLinks(doc,"https://example.com/");
 assert.equal(links.length,3);
 assert.deepEqual(links.map(l=>l.url),["https://example.com/1","https://example.com/2","https://example.com/3"]);
});

test("extractLinks returns an empty array for HTML with no links", () => {
 assert.deepEqual(html.extractLinks("<div>no links here</div>","https://example.com/"),[]);
});

test("extractLinks silently skips a malformed href it cannot resolve to a valid URL, rather than throwing", () => {
 const links=html.extractLinks(`<a href="not a valid url and has spaces\t\x00">bad</a><a href="https://example.com/ok">good</a>`,"https://example.com/");
 assert.ok(links.some(l=>l.url==="https://example.com/ok"));
});
