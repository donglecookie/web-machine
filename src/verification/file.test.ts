import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {verify} from "./file.js";

async function withTempFile(name:string,data:Buffer,fn:(filePath:string)=>Promise<void>){
 const dir=await mkdtemp(path.join(os.tmpdir(),"web-machine-test-"));
 const filePath=path.join(dir,name);
 await writeFile(filePath,data);
 try{await fn(filePath);}finally{await rm(dir,{recursive:true,force:true});}
}

test("verify() succeeds for a real PDF (starts with %PDF-) and non-empty", async () => {
 await withTempFile("real.pdf",Buffer.from("%PDF-1.4\n...fake but valid-looking pdf bytes..."),async(filePath)=>{
  const result=await verify(filePath);
  assert.equal(result.ok,true);
  assert.equal(result.isPdf,true);
  assert.ok(result.size>0);
  assert.equal(result.sha256.length,64); // sha256 hex digest length
 });
});

test("verify() fails for a non-PDF file even if it has content (e.g. an HTML error page saved as .pdf)", async () => {
 await withTempFile("fake.pdf",Buffer.from("<!DOCTYPE html><html>not a pdf</html>"),async(filePath)=>{
  const result=await verify(filePath);
  assert.equal(result.ok,false); // isPdf must gate ok, not just ride along as metadata
  assert.equal(result.isPdf,false);
  assert.ok(result.size>0); // it did download something, just not the right thing
 });
});

test("verify() fails for an empty file", async () => {
 await withTempFile("empty.pdf",Buffer.alloc(0),async(filePath)=>{
  const result=await verify(filePath);
  assert.equal(result.ok,false);
  assert.equal(result.size,0);
 });
});

test("verify() rejects (does not silently succeed) for a missing file", async () => {
 await assert.rejects(()=>verify("/nonexistent/path/does-not-exist.pdf"));
});
