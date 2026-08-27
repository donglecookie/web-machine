import {Stagehand, localBrowser} from "@browserbasehq/stagehand";
import {chromium} from "playwright";
import path from "node:path";
const API_KEY_ENV_VARS=["GROQ_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY"];
export async function createStagehand(){
 const model=process.env.STAGEHAND_MODEL||"groq/openai/gpt-oss-120b";
 const executablePath=process.env.CHROME_PATH||chromium.executablePath();
 const apiKey=API_KEY_ENV_VARS.map(k=>process.env[k]).find(Boolean);
 const modelConfig:any={modelName:model};
 if(apiKey)modelConfig.apiKey=apiKey;
 const launch:any={headless:true,acceptDownloads:true,downloadsPath:path.resolve("downloads"),args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"],executablePath};
 const browser=await localBrowser.launch(launch);
 return Stagehand.create({browser,model:modelConfig,logging:{level:"info"}});
}
