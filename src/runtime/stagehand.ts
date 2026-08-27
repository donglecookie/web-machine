import {Stagehand, localBrowser} from "@browserbasehq/stagehand";
import {chromium} from "playwright";
import path from "node:path";
export async function createStagehand(){
 const model=process.env.STAGEHAND_MODEL||"groq/llama-3.3-70b-versatile";
 const executablePath=process.env.CHROME_PATH||chromium.executablePath();
 const launch:any={headless:true,acceptDownloads:true,downloadsPath:path.resolve("downloads"),args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"],executablePath};
 const browser=await localBrowser.launch(launch);
 const apiKey=process.env.GROQ_API_KEY||process.env.GOOGLE_GENERATIVE_AI_API_KEY||process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY;
 const modelConfig:any={modelName:model};
 if(apiKey)modelConfig.apiKey=apiKey;
 const stagehand=await Stagehand.create({browser,model:modelConfig,logging:{level:"info"}});
 return stagehand;
}
