import {Stagehand, localBrowser} from "@browserbasehq/stagehand";
import {chromium} from "playwright";
import path from "node:path";
import {createOpenAICompatibleClient} from "./openaiCompatibleClient.js";
const API_KEY_ENV_VARS=["GROQ_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY"];
export async function createStagehand(){
 const executablePath=process.env.CHROME_PATH||chromium.executablePath();
 const launch:any={headless:true,acceptDownloads:true,downloadsPath:path.resolve("downloads"),args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"],executablePath};
 const browser=await localBrowser.launch(launch);

 // OpenRouter (or any other OpenAI-compatible endpoint) isn't in Stagehand's built-in
 // provider whitelist (openai/anthropic/google/groq/cerebras only), so it needs the
 // translation adapter in openaiCompatibleClient.ts to work at all. Opt-in via
 // OPENROUTER_API_KEY; falls back to the normal built-in-provider path otherwise.
 const openRouterKey=process.env.OPENROUTER_API_KEY;
 if(openRouterKey){
  const model=process.env.OPENROUTER_MODEL||"openai/gpt-4o-mini";
  return Stagehand.create({browser,model:createOpenAICompatibleClient({apiKey:openRouterKey,model}),logging:{level:"info"}});
 }

 const model=process.env.STAGEHAND_MODEL||"groq/openai/gpt-oss-120b";
 const apiKey=API_KEY_ENV_VARS.map(k=>process.env[k]).find(Boolean);
 const modelConfig:any={modelName:model};
 if(apiKey)modelConfig.apiKey=apiKey;
 return Stagehand.create({browser,model:modelConfig,logging:{level:"info"}});
}
