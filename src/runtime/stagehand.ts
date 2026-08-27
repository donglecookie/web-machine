import {Stagehand, localBrowser} from "@browserbasehq/stagehand";
import {chromium} from "playwright";
import path from "node:path";
export async function createStagehand(){
 const model=process.env.STAGEHAND_MODEL||"google/gemini-3.6-flash";
 const executablePath=process.env.CHROME_PATH||chromium.executablePath();
 const launch:any={headless:true,acceptDownloads:true,downloadsPath:path.resolve("downloads"),args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"],executablePath};
 const browser=await localBrowser.launch(launch);
 const apiKey=process.env.GOOGLE_GENERATIVE_AI_API_KEY||process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY;
 const stagehand=await Stagehand.create({browser,model:{modelName:model as any,apiKey},logging:{level:"info"}});
 return stagehand;
}
