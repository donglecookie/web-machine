import "dotenv/config";import {createStagehand} from "./runtime/stagehand.js";import {WebMachine} from "./machine/WebMachine.js";import {discoverAndFetch} from "./discover.js";
function report(result:any){
 console.log(JSON.stringify(result,null,2));
 if(result.ok)console.log(`\nSUCCESS: ${result.path}`);
 else process.exitCode=1;
}

const query=process.argv.slice(2).join(" ");
if(!query){
 console.error("Usage: npm run test -- <what to find>\n  (optionally set TEST_URL=<url> to skip web search and start on a specific site)");
 process.exit(1);
}

let machine:WebMachine|undefined;
try{
 const stagehand=await createStagehand();
 machine=new WebMachine(stagehand);
 const target=process.env.TEST_URL;
 if(target){
  console.log("TARGET:",target);console.log("QUERY:",query);
  await machine.open(target);
  console.log("PAGE:",await machine.page.url());
  console.log("TITLE:",await machine.page.title());
  report(await machine.fetch(query,16));
 }else{
  console.log("QUERY:",query);
  console.log("No TEST_URL given — searching the web for a starting site...");
  await machine.open("about:blank");
  report(await discoverAndFetch(machine,stagehand,query));
 }
}catch(e){
 console.error("FAILED:",e instanceof Error?e.stack||e.message:e);
 process.exitCode=1;
}finally{
 if(machine)await machine.close();
}
