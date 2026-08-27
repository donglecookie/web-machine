import "dotenv/config";import {createStagehand} from "./runtime/stagehand.js";import {WebMachine} from "./machine/WebMachine.js";
const stagehand=await createStagehand();const machine=new WebMachine(stagehand);
try{
 await machine.open("https://horaeng.com");
 console.log("Browser OK:",machine.page.url());
 console.log("Title:",await machine.page.title());
 const result=await machine.fetch("2025학년도 9월 모의평가 사회문화 문제 PDF",10);
 console.log(JSON.stringify(result,null,2));
}finally{await machine.close();}
