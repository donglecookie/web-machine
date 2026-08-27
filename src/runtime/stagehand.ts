import {Stagehand} from "@browserbasehq/stagehand";
import path from "node:path";
export async function createStagehand(){
 const model=process.env.STAGEHAND_MODEL||"openai/gpt-4o-mini";
 const executablePath=process.env.CHROME_PATH;
 const launch:any={headless:true,acceptDownloads:true,downloadsPath:path.resolve("downloads"),args:["--no-sandbox","--disable-setuid-sandbox"]};
 if(executablePath)launch.executablePath=executablePath;
 const stagehand=new Stagehand({env:"LOCAL",model,localBrowserLaunchOptions:launch,verbose:1,selfHeal:true});
 await stagehand.init();
 return stagehand;
}
