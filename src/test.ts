import "dotenv/config";import {createStagehand} from "./runtime/stagehand.js";import {WebMachine} from "./machine/WebMachine.js";
const stagehand=await createStagehand();const machine=new WebMachine(stagehand);
try{
 const target=process.env.TEST_URL;
 const query=process.argv.slice(2).join(" ");
 if(!target||!query){
  console.error("Usage: TEST_URL=<start url> npm run test -- <what to find>");
  process.exitCode=1;
 }else{
  console.log("TARGET:",target);console.log("QUERY:",query);
  await machine.open(target);
  console.log("PAGE:",await machine.page.url());
  console.log("TITLE:",await machine.page.title());
  const result=await machine.fetch(query,10);
  console.log(JSON.stringify(result,null,2));
  if(result.ok)console.log(`\nSUCCESS: ${result.path}`);
  else process.exitCode=1;
 }
}catch(e){
 console.error("FAILED:",e instanceof Error?e.stack||e.message:e);
 process.exitCode=1;
}finally{await machine.close();}
