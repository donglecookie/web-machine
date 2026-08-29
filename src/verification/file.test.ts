import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {verify} from "./file.js";
import {FILE_TYPES} from "../discovery/patterns.js";

const PDF=FILE_TYPES.find(t=>t.name==="pdf")!;
const XLSX=FILE_TYPES.find(t=>t.name==="xlsx")!;

async function withTempFile(name:string,data:Buffer,fn:(filePath:string)=>Promise<void>){
 const dir=await mkdtemp(path.join(os.tmpdir(),"web-machine-test-"));
 const filePath=path.join(dir,name);
 await writeFile(filePath,data);
 try{await fn(filePath);}finally{await rm(dir,{recursive:true,force:true});}
}

test("verify() succeeds for a real PDF (starts with %PDF-) and non-empty", async () => {
 await withTempFile("real.pdf",Buffer.from("%PDF-1.4\n...fake but valid-looking pdf bytes..."),async(filePath)=>{
  const result=await verify(filePath,PDF);
  assert.equal(result.ok,true);
  assert.equal(result.matchesType,true);
  assert.equal(result.fileType,"pdf");
  assert.ok(result.size>0);
  assert.equal(result.sha256.length,64); // sha256 hex digest length
 });
});

test("verify() fails for a non-PDF file even if it has content (e.g. an HTML error page saved as .pdf)", async () => {
 await withTempFile("fake.pdf",Buffer.from("<!DOCTYPE html><html>not a pdf</html>"),async(filePath)=>{
  const result=await verify(filePath,PDF);
  assert.equal(result.ok,false); // matchesType must gate ok, not just ride along as metadata
  assert.equal(result.matchesType,false);
  assert.ok(result.size>0); // it did download something, just not the right thing
 });
});

test("verify() defaults to the 'any' wildcard policy when no fileType is given - accepts any known real format", async () => {
 await withTempFile("real.pdf",Buffer.from("%PDF-1.4\n..."),async(filePath)=>{
  const result=await verify(filePath);
  assert.equal(result.ok,true);
  assert.equal(result.fileType,"any");
 });
 const zipSignature=Buffer.from([0x50,0x4b,0x03,0x04,0,0,0,0]);
 await withTempFile("budget.xlsx",zipSignature,async(filePath)=>{
  const result=await verify(filePath); // no fileType passed - should still accept a real xlsx
  assert.equal(result.ok,true);
 });
});

test("verify() with the 'any' wildcard still rejects content matching no known format", async () => {
 await withTempFile("junk.bin",Buffer.from("not a recognizable file format at all"),async(filePath)=>{
  const result=await verify(filePath);
  assert.equal(result.ok,false);
 });
});

test("verify() supports non-PDF policies (e.g. xlsx, a ZIP-container format)", async () => {
 // xlsx files are ZIP archives internally - a minimal ZIP local-file-header signature is enough.
 const zipSignature=Buffer.from([0x50,0x4b,0x03,0x04,0,0,0,0]);
 await withTempFile("budget.xlsx",zipSignature,async(filePath)=>{
  const result=await verify(filePath,XLSX);
  assert.equal(result.ok,true);
  assert.equal(result.fileType,"xlsx");
 });
});

test("verify() rejects an xlsx-policy check against actual PDF bytes", async () => {
 await withTempFile("wrong.xlsx",Buffer.from("%PDF-1.4\n..."),async(filePath)=>{
  const result=await verify(filePath,XLSX);
  assert.equal(result.ok,false);
 });
});

test("verify() fails for an empty file", async () => {
 await withTempFile("empty.pdf",Buffer.alloc(0),async(filePath)=>{
  const result=await verify(filePath,PDF);
  assert.equal(result.ok,false);
  assert.equal(result.size,0);
 });
});

test("verify() rejects (does not silently succeed) for a missing file", async () => {
 await assert.rejects(()=>verify("/nonexistent/path/does-not-exist.pdf"));
});

test("verify() recognizes a real RAR file by its magic bytes (regression: byte-length mismatch previously made this always fail)", async () => {
 const ZIP=FILE_TYPES.find(t=>t.name==="zip")!;
 const rarSignature=Buffer.from([0x52,0x61,0x72,0x21,0x1a,0x07,0x00]); // "Rar!" + trailer
 await withTempFile("archive.rar",rarSignature,async(filePath)=>{
  const result=await verify(filePath,ZIP);
  assert.equal(result.ok,true);
 });
});

test("verify() with the csv policy rejects an HTML page saved as .csv (same false-positive class as the original PDF bug)", async () => {
 const CSV=FILE_TYPES.find(t=>t.name==="csv")!;
 await withTempFile("fake.csv",Buffer.from("<!DOCTYPE html><html>login required</html>"),async(filePath)=>{
  const result=await verify(filePath,CSV);
  assert.equal(result.ok,false);
 });
});

test("verify() with the csv policy accepts genuine delimited text content", async () => {
 const CSV=FILE_TYPES.find(t=>t.name==="csv")!;
 await withTempFile("real.csv",Buffer.from("name,age\nAlice,30\nBob,25\n"),async(filePath)=>{
  const result=await verify(filePath,CSV);
  assert.equal(result.ok,true);
 });
});
