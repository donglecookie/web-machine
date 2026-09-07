// Runs entirely in its own child process (spawned via node:child_process's fork() from
// server.ts) - not just try/caught within the shared server process. This is the actual fix
// for "a search shouldn't be able to affect the server at all", replacing an earlier approach
// that relied on process-level uncaughtException/unhandledRejection handlers in the shared
// process to survive a crash from deep inside the browser-automation stack. That approach
// only ever "recovers" after the fact, and Node's own docs are explicit that continuing
// after an uncaughtException leaves the process in an undefined state - not a real guarantee.
// A child process crashing (any way at all - an uncaught exception, a raw process.exit()
// somewhere in a dependency, even a native-code crash) only ever takes down this one process;
// the parent observes it via a normal 'exit' event and was never at risk.
import "dotenv/config";
import {createStagehand} from "../runtime/stagehand.js";
import {WebMachine} from "../machine/WebMachine.js";
import {discoverAndFetch} from "../discover.js";

type JobRequest={query:string;targetUrl?:string};
type JobResponse={ok:boolean;result:unknown};

// Deliberately `once`, not `on`: this worker handles exactly one job and exits - `once` makes
// that guarantee structural (a second message, however it arrived, is simply ignored) rather
// than relying on process.exit() to happen fast enough to prevent a second handler run.
process.once("message",async(msg:JobRequest)=>{
 let machine:WebMachine|undefined;
 let response:JobResponse;
 try{
  const stagehand=await createStagehand();
  machine=new WebMachine(stagehand);
  let result:unknown;
  if(msg.targetUrl){
   await machine.open(msg.targetUrl);
   result=await machine.fetch(msg.query,16);
  }else{
   await machine.ensurePage();
   result=await discoverAndFetch(machine,stagehand,msg.query);
  }
  response={ok:true,result};
 }catch(e){
  response={ok:false,result:{ok:false,message:e instanceof Error?e.message:String(e)}};
 }finally{
  if(machine)await machine.close().catch(()=>{});
 }
 process.send?.(response);
 process.exit(0);
});
