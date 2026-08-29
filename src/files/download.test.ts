import {test} from "node:test";
import assert from "node:assert/strict";
import {inferExtension} from "./download.js";

// Regression coverage for the bug found during review: real-world Office MIME types don't
// contain the file extension/name as a literal substring, so naive substring matching against
// content-type would silently fail to recognize them.
test("inferExtension recognizes real-world Office MIME types (not just ones containing the extension as a substring)", () => {
 assert.equal(inferExtension("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),".xlsx");
 assert.equal(inferExtension("application/vnd.openxmlformats-officedocument.presentationml.presentation"),".pptx");
 assert.equal(inferExtension("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),".docx");
});

test("inferExtension recognizes legacy Office MIME types", () => {
 assert.equal(inferExtension("application/vnd.ms-excel"),".xlsx");
 assert.equal(inferExtension("application/msword"),".docx");
 assert.equal(inferExtension("application/vnd.ms-powerpoint"),".pptx");
});

test("inferExtension recognizes pdf, zip, image, and csv MIME types", () => {
 assert.equal(inferExtension("application/pdf"),".pdf");
 assert.equal(inferExtension("application/zip"),".zip");
 assert.equal(inferExtension("image/png"),".png");
 assert.equal(inferExtension("image/jpeg"),".png"); // primaryExt for the generic "image" type
 assert.equal(inferExtension("text/csv"),".csv");
});

test("inferExtension returns empty string for an unrecognized content-type", () => {
 assert.equal(inferExtension("application/octet-stream"),"");
 assert.equal(inferExtension(""),"");
});
