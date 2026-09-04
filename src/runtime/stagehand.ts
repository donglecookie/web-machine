import {Stagehand, localBrowser} from "@browserbasehq/stagehand";
import {chromium} from "playwright";
import path from "node:path";
import {createOpenAICompatibleClient} from "./openaiCompatibleClient.js";
const API_KEY_ENV_VARS=["GROQ_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY"];
export async function createStagehand(){
 const executablePath=process.env.CHROME_PATH||chromium.executablePath();
 const launch:any={headless:true,acceptDownloads:true,downloadsPath:path.resolve("downloads"),args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"],executablePath};
 const browser=await localBrowser.launch(launch);

 // Stagehand's model field only accepts a whitelisted set of providers (openai/anthropic/
 // google/groq/cerebras) - anything else (OpenRouter, a self-hosted OpenAI-compatible server,
 // etc.) needs the translation adapter in openaiCompatibleClient.ts. This path is provider-
 // agnostic on purpose: unlike a specific vendor's endpoint, an arbitrary OpenAI-compatible
 // API has no sensible default baseURL or model to assume, so both must be given explicitly.
 const compatApiKey=process.env.OPENAI_COMPATIBLE_API_KEY;
 if(compatApiKey){
  const baseURL=process.env.OPENAI_COMPATIBLE_BASE_URL;
  const model=process.env.OPENAI_COMPATIBLE_MODEL;
  if(!baseURL||!model)throw new Error("OPENAI_COMPATIBLE_API_KEY is set but OPENAI_COMPATIBLE_BASE_URL and/or OPENAI_COMPATIBLE_MODEL is missing - both are required since there's no default provider to assume for an arbitrary OpenAI-compatible endpoint.");
  return Stagehand.create({browser,model:createOpenAICompatibleClient({apiKey:compatApiKey,baseURL,model}),logging:{level:"info"}});
 }

 const model=process.env.STAGEHAND_MODEL||"groq/openai/gpt-oss-120b";
 const apiKey=API_KEY_ENV_VARS.map(k=>process.env[k]).find(Boolean);
 const modelConfig:any={modelName:model};
 if(apiKey)modelConfig.apiKey=apiKey;
 return Stagehand.create({browser,model:modelConfig,logging:{level:"info"}});
}
