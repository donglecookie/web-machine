import "dotenv/config";
import http from "node:http";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {createStagehand} from "../runtime/stagehand.js";
import {WebMachine} from "../machine/WebMachine.js";
import {discoverAndFetch} from "../discover.js";
import {logger} from "../runtime/logger.js";

const PORT=Number(process.env.WEB_PORT)||3000;
const DOWNLOADS_DIR=path.resolve("downloads");

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
const activeJobIds=new Set<string>(); // jobs currently inside runSearch() - see the process-level safety net below
const JOB_TTL_MS=10*60*1000; // finished jobs are dropped after this so `jobs` doesn't grow forever across a long-running server process

function sweepOldJobs():void{
 const cutoff=Date.now()-JOB_TTL_MS;
 for(const[id,job] of jobs)if(job.status!=="running"&&job.startedAt<cutoff)jobs.delete(id);
}

// This is a long-running service, not a one-shot script like src/test.ts - an error from deep
// inside the browser-automation stack that Node treats as "uncaught" (e.g. certain child-
// process failures surface as an unhandled 'error' event, not a promise rejection a try/catch
// can intercept) would otherwise crash the whole process, taking down every other in-flight
// job with it. Logging and continuing is the right behavior here specifically because each
// job already fails independently and safely into its own job.status="error" via runSearch()'s
// own try/catch - but an error THIS net catches bypassed that entirely, which would otherwise
// leave whichever job caused it stuck at status:"running" forever (silently spinning on the
// page, never resolving). Tracking which jobs are currently active lets this net mark them
// failed too, not just keep the server itself alive.
function failActiveJobs(message:string):void{
 for(const id of activeJobIds){
  const job=jobs.get(id);
  if(job)jobs.set(id,{status:"error",result:{ok:false,message},startedAt:job.startedAt});
 }
 activeJobIds.clear();
}
process.on("uncaughtException",e=>{
 const message=e instanceof Error?e.message:String(e);
 logger.error("web.uncaught_exception",{message});
 failActiveJobs(message);
});
process.on("unhandledRejection",e=>{
 const message=e instanceof Error?e.message:String(e);
 logger.error("web.unhandled_rejection",{message});
 failActiveJobs(message);
});

// One machine per job, not a shared long-lived one: each search gets a fresh browser and
// closes it when done, mirroring how src/test.ts already behaves - a page/tab left open from a
// previous search shouldn't silently influence the next one.
async function runSearch(jobId:string,query:string,targetUrl:string|undefined):Promise<void>{
 activeJobIds.add(jobId);
 let machine:WebMachine|undefined;
 try{
  const stagehand=await createStagehand();
  machine=new WebMachine(stagehand);
  let result:unknown;
  if(targetUrl){
   await machine.open(targetUrl);
   result=await machine.fetch(query,16);
  }else{
   await machine.open("about:blank");
   result=await discoverAndFetch(machine,stagehand,query);
  }
  jobs.set(jobId,{status:"done",result,startedAt:jobs.get(jobId)!.startedAt});
 }catch(e){
  jobs.set(jobId,{status:"error",result:{ok:false,message:e instanceof Error?e.message:String(e)},startedAt:jobs.get(jobId)!.startedAt});
 }finally{
  activeJobIds.delete(jobId);
  if(machine)await machine.close().catch(()=>{});
 }
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
   const body=JSON.parse(Buffer.concat(chunks).toString("utf-8")||"{}");
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
   runSearch(jobId,query,targetUrl);
   res.writeHead(202,{"Content-Type":"application/json"});
   res.end(JSON.stringify({jobId}));
   return;
  }
  if(req.method==="GET"&&req.url?.startsWith("/api/status/")){
   const jobId=req.url.slice("/api/status/".length);
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
