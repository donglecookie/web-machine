import "dotenv/config";
import http from "node:http";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {fork} from "node:child_process";
import {logger} from "../runtime/logger.js";

const PORT=Number(process.env.WEB_PORT)||3000;
const DOWNLOADS_DIR=path.resolve("downloads");
const WORKER_PATH=path.join(path.dirname(fileURLToPath(import.meta.url)),"worker.ts");

// A search can genuinely take minutes (real browser automation, several LLM round-trips) - a
// single request/response that blocks for that whole duration was found in practice to hit
// "Load failed" in the browser, almost certainly Codespaces' port-forwarding proxy dropping a
// connection that goes that long without any bytes flowing. The fix is the standard one for
// long-running web operations: POST starts a background job and returns immediately with an
// id; the page polls a cheap status endpoint every couple seconds until it's done. Every
// individual HTTP request this way completes in milliseconds, so there's never a connection
// left open long enough for a proxy to consider it idle and kill it.
type Job={status:"running"|"done"|"error";result?:unknown;startedAt:number};
const jobs=new Map<string,Job>();
const JOB_TTL_MS=10*60*1000; // finished jobs are dropped after this so `jobs` doesn't grow forever across a long-running server process

function sweepOldJobs():void{
 const cutoff=Date.now()-JOB_TTL_MS;
 for(const[id,job] of jobs)if(job.status!=="running"&&job.startedAt<cutoff)jobs.delete(id);
}

// Runs the actual search in its OWN process (worker.ts), not inside this shared server
// process - this is the real fix for "a search shouldn't be able to affect the server at
// all", not just catching whatever it throws. An earlier version ran the search in-process and
// relied on process-level uncaughtException/unhandledRejection handlers to survive a crash
// from deep inside the browser-automation stack - but Node's own docs are explicit that
// continuing after an uncaughtException leaves the process in an undefined state, and some
// failure modes (a raw process.exit() somewhere in a dependency, a native-code crash) can't be
// caught by JS-level handlers at all regardless. A genuinely separate OS process can crash any
// way whatsoever and the only thing the parent ever sees is a normal 'exit' event - there is
// no path from "this search misbehaved" to "the server went down" left at all, by
// construction, not by best-effort recovery.
// --import tsx makes the child load .ts files directly too, the same way this project's own
// test:unit script already runs TypeScript without a separate compile step.
function runSearchInWorker(jobId:string,query:string,targetUrl:string|undefined):void{
 const child=fork(WORKER_PATH,[],{execArgv:["--import","tsx"]});
 const finish=(status:"done"|"error",result:unknown)=>{
  const job=jobs.get(jobId);
  if(job&&job.status==="running")jobs.set(jobId,{status,result,startedAt:job.startedAt});
  child.kill();
 };
 child.on("message",(msg:{ok:boolean;result:unknown})=>finish(msg.ok?"done":"error",msg.result));
 child.on("error",e=>finish("error",{ok:false,message:`worker failed to start: ${e.message}`}));
 child.on("exit",(code,signal)=>{
  // A worker that already reported its result via 'message' calls process.exit(0) itself
  // right after - finish() already ran and set a real status, so this exit is expected and a
  // no-op here (finish() only acts while status is still "running"). This branch is what
  // catches the case the message never arrived at all: whatever went wrong, it stayed
  // entirely inside the worker's own process.
  if(code!==0)finish("error",{ok:false,message:signal?`worker process was killed by signal ${signal}`:`worker process exited unexpectedly (code ${code})`});
 });
 child.send({query,targetUrl});
}

const PAGE=`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>web-machine</title>
<style>
 :root{color-scheme:light dark}
 body{font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.5}
 h1{font-size:1.25rem}
 form{display:flex;flex-direction:column;gap:.75rem;margin:1.5rem 0}
 label{font-size:.875rem;font-weight:600}
 input{font-size:1rem;padding:.5rem;border:1px solid #8888;border-radius:6px;background:transparent;color:inherit}
 button{font-size:1rem;padding:.6rem;border:none;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}
 button:disabled{opacity:.5;cursor:wait}
 #status{margin:1rem 0;font-size:.9rem;color:#888}
 #result{white-space:pre-wrap;background:#8881;padding:1rem;border-radius:8px;font-size:.85rem;overflow-x:auto;display:none}
 a.download{display:inline-block;margin-top:.75rem;font-weight:600}
</style>
</head>
<body>
<h1>web-machine</h1>
<p>찾을 파일을 설명하고, 시작할 사이트가 있으면 URL도 함께 입력하세요. 비워두면 웹 검색부터 시작합니다. 시간이 좀 걸릴 수 있어요(보통 1~3분) - 이 페이지를 닫지 말고 기다려 주세요.</p>
<form id="f">
 <div><label for="query">무엇을 찾을까요</label><br><input id="query" required placeholder="예: 2025학년도 9월 모의평가 사회문화"></div>
 <div><label for="url">시작 URL (선택)</label><br><input id="url" placeholder="예: https://mogogo.kr"></div>
 <button id="submit" type="submit">찾기 시작</button>
</form>
<div id="status"></div>
<pre id="result"></pre>
<script>
const f=document.getElementById("f"),statusEl=document.getElementById("status"),result=document.getElementById("result"),submit=document.getElementById("submit");
let pollTimer=null;
let elapsed=0;

function stopPolling(){if(pollTimer){clearInterval(pollTimer);pollTimer=null;}submit.disabled=false;}

function renderDone(data){
 statusEl.textContent=data.result&&data.result.ok?"완료":"실패";
 result.style.display="block";
 let text=JSON.stringify(data.result,null,2);
 result.textContent=text;
 const existing=document.querySelector("a.download");
 if(existing)existing.remove();
 if(data.result&&data.result.path){
  const a=document.createElement("a");
  a.className="download";a.href="/downloads/"+encodeURIComponent(data.result.path.split("/").pop());
  a.textContent="⬇ 받은 파일 열기";a.target="_blank";
  result.after(a);
 }
}

async function poll(jobId){
 elapsed+=2;
 try{
  const res=await fetch("/api/status/"+jobId);
  if(!res.ok){statusEl.textContent="상태 확인 실패 (서버가 재시작됐을 수 있어요)";stopPolling();return;}
  const data=await res.json();
  if(data.status==="running"){
   statusEl.textContent="찾는 중입니다... ("+elapsed+"초 경과)";
   return;
  }
  renderDone(data);
  stopPolling();
 }catch(err){
  statusEl.textContent="연결 확인 중 오류, 재시도합니다...";
 }
}

f.addEventListener("submit",async(e)=>{
 e.preventDefault();
 submit.disabled=true;
 result.style.display="none";
 elapsed=0;
 statusEl.textContent="시작하는 중...";
 const query=document.getElementById("query").value;
 const url=document.getElementById("url").value;
 try{
  const res=await fetch("/api/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query,url})});
  if(!res.ok){
   const err=await res.json().catch(()=>({message:"알 수 없는 오류"}));
   statusEl.textContent="시작 실패: "+(err.message||"알 수 없는 오류");
   submit.disabled=false;
   return;
  }
  const{jobId}=await res.json();
  statusEl.textContent="찾는 중입니다...";
  pollTimer=setInterval(()=>poll(jobId),2000);
 }catch(err){
  statusEl.textContent="시작 중 오류: "+err.message;
  submit.disabled=false;
 }
});
</script>
</body>
</html>`;

const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==="GET"&&req.url==="/"){
   res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
   res.end(PAGE);
   return;
  }
  if(req.method==="POST"&&req.url==="/api/run"){
   const chunks:Buffer[]=[];
   for await(const chunk of req)chunks.push(chunk as Buffer);
   let body:{query?:unknown;url?:unknown};
   try{body=JSON.parse(Buffer.concat(chunks).toString("utf-8")||"{}");}
   catch{
    res.writeHead(400,{"Content-Type":"application/json"});
    res.end(JSON.stringify({message:"invalid JSON body"}));
    return;
   }
   const query=typeof body.query==="string"?body.query.trim():"";
   const targetUrl=(typeof body.url==="string"?body.url.trim():"")||undefined;
   if(!query){
    res.writeHead(400,{"Content-Type":"application/json"});
    res.end(JSON.stringify({message:"query is required"}));
    return;
   }
   sweepOldJobs();
   const jobId=randomUUID();
   jobs.set(jobId,{status:"running",startedAt:Date.now()});
   logger.info("web.run_start",{jobId,query,url:targetUrl||"(search)"});
   // Deliberately not awaited: the job runs in the background and the response returns
   // immediately, which is the whole point of the job/poll split (see the comment above).
   runSearchInWorker(jobId,query,targetUrl);
   res.writeHead(202,{"Content-Type":"application/json"});
   res.end(JSON.stringify({jobId}));
   return;
  }
  if(req.method==="GET"&&req.url?.startsWith("/api/status/")){
   const jobId=req.url.slice("/api/status/".length).split("?")[0];
   const job=jobs.get(jobId);
   if(!job){
    res.writeHead(404,{"Content-Type":"application/json"});
    res.end(JSON.stringify({message:"unknown job"}));
    return;
   }
   res.writeHead(200,{"Content-Type":"application/json"});
   res.end(JSON.stringify({status:job.status,result:job.result}));
   return;
  }
  if(req.method==="GET"&&req.url?.startsWith("/downloads/")){
   // Serve only a bare filename from the fixed downloads directory - no path segments, so a
   // request can't walk outside it (e.g. "/downloads/../.env").
   const name=decodeURIComponent(req.url.slice("/downloads/".length));
   if(!name||name.includes("/")||name.includes("..")){
    res.writeHead(400);res.end("Bad filename");return;
   }
   const filePath=path.join(DOWNLOADS_DIR,name);
   try{
    const data=await readFile(filePath);
    res.writeHead(200,{"Content-Disposition":`attachment; filename="${name}"`});
    res.end(data);
   }catch{
    res.writeHead(404);res.end("Not found");
   }
   return;
  }
  res.writeHead(404);res.end("Not found");
 }catch(e){
  logger.error("web.request_failed",{message:e instanceof Error?e.message:String(e)});
  res.writeHead(500,{"Content-Type":"application/json"});
  res.end(JSON.stringify({message:"internal error"}));
 }
});

server.listen(PORT,()=>{
 console.log(`web-machine UI listening on http://localhost:${PORT}`);
 console.log("Codespaces에서는 '포트' 탭에 자동으로 뜨는 링크를 클릭하세요.");
});
