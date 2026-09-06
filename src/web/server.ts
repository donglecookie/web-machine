import "dotenv/config";
import http from "node:http";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {createStagehand} from "../runtime/stagehand.js";
import {WebMachine} from "../machine/WebMachine.js";
import {discoverAndFetch} from "../discover.js";
import {logger} from "../runtime/logger.js";

const PORT=Number(process.env.WEB_PORT)||3000;
const DOWNLOADS_DIR=path.resolve("downloads");

// One machine per request, not a shared long-lived one: each search gets a fresh browser and
// closes it when done, mirroring how src/test.ts already behaves - a page/tab left open from a
// previous search shouldn't silently influence the next one.
async function runSearch(query:string,targetUrl:string|undefined):Promise<{ok:boolean;json:unknown}>{
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
  return{ok:true,json:result};
 }catch(e){
  return{ok:false,json:{ok:false,message:e instanceof Error?e.message:String(e)}};
 }finally{
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
<p>찾을 파일을 설명하고, 시작할 사이트가 있으면 URL도 함께 입력하세요. 비워두면 웹 검색부터 시작합니다.</p>
<form id="f">
 <div><label for="query">무엇을 찾을까요</label><br><input id="query" required placeholder="예: 2025학년도 9월 모의평가 사회문화"></div>
 <div><label for="url">시작 URL (선택)</label><br><input id="url" placeholder="예: https://mogogo.kr"></div>
 <button id="submit" type="submit">찾기 시작</button>
</form>
<div id="status"></div>
<pre id="result"></pre>
<script>
const f=document.getElementById("f"),status=document.getElementById("status"),result=document.getElementById("result"),submit=document.getElementById("submit");
f.addEventListener("submit",async(e)=>{
 e.preventDefault();
 submit.disabled=true;
 result.style.display="none";
 status.textContent="찾는 중입니다... (사이트 구조에 따라 최대 몇 분 걸릴 수 있어요)";
 const query=document.getElementById("query").value;
 const url=document.getElementById("url").value;
 try{
  const res=await fetch("/api/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query,url})});
  const data=await res.json();
  status.textContent=data.ok?"완료":"실패";
  result.style.display="block";
  let text=JSON.stringify(data.json,null,2);
  if(data.json&&data.json.path){
   text+="\\n\\n다운로드: /downloads/"+encodeURIComponent(data.json.path.split("/").pop());
  }
  result.textContent=text;
  if(data.json&&data.json.path){
   const a=document.createElement("a");
   a.className="download";a.href="/downloads/"+encodeURIComponent(data.json.path.split("/").pop());
   a.textContent="⬇ 받은 파일 열기";a.target="_blank";
   result.after(a);
  }
 }catch(err){
  status.textContent="오류: "+err.message;
 }finally{
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
    res.end(JSON.stringify({ok:false,json:{message:"query is required"}}));
    return;
   }
   logger.info("web.run_start",{query,url:targetUrl||"(search)"});
   const out=await runSearch(query,targetUrl);
   res.writeHead(200,{"Content-Type":"application/json"});
   res.end(JSON.stringify(out));
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
  res.end(JSON.stringify({ok:false,json:{message:"internal error"}}));
 }
});

server.listen(PORT,()=>{
 console.log(`web-machine UI listening on http://localhost:${PORT}`);
 console.log("Codespaces에서는 '포트' 탭에 자동으로 뜨는 링크를 클릭하세요.");
});
