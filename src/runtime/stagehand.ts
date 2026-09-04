import {Stagehand, localBrowser} from "@browserbasehq/stagehand";
import {chromium} from "playwright";
import path from "node:path";
import {createOpenAICompatibleClient} from "./openaiCompatibleClient.js";
const PROVIDER_API_KEY_ENV_VAR:Record<string,string>={groq:"GROQ_API_KEY",google:"GOOGLE_GENERATIVE_AI_API_KEY",openai:"OPENAI_API_KEY",anthropic:"ANTHROPIC_API_KEY",cerebras:"CEREBRAS_API_KEY"};
export async function createStagehand(){
 // Stagehand's model field only accepts a whitelisted set of providers (openai/anthropic/
 // google/groq/cerebras) - anything else (OpenRouter, a self-hosted OpenAI-compatible server,
 // etc.) needs the translation adapter in openaiCompatibleClient.ts. This path is provider-
 // agnostic on purpose: unlike a specific vendor's endpoint, an arbitrary OpenAI-compatible
 // API has no sensible default baseURL or model to assume, so both must be given explicitly.
 // Validated before launching the browser below - failing here after already spawning a
 // browser process would leak it, since there'd be nothing left to close it.
 const compatApiKey=process.env.OPENAI_COMPATIBLE_API_KEY;
 const compatBaseURL=process.env.OPENAI_COMPATIBLE_BASE_URL;
 const compatModel=process.env.OPENAI_COMPATIBLE_MODEL;
 if(compatApiKey&&(!compatBaseURL||!compatModel))throw new Error("OPENAI_COMPATIBLE_API_KEY is set but OPENAI_COMPATIBLE_BASE_URL and/or OPENAI_COMPATIBLE_MODEL is missing - both are required since there's no default provider to assume for an arbitrary OpenAI-compatible endpoint.");

 const executablePath=process.env.CHROME_PATH||chromium.executablePath();
 const launch:any={headless:true,acceptDownloads:true,downloadsPath:path.resolve("downloads"),args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"],executablePath};
 const browser=await localBrowser.launch(launch);

 // Stagehand.create() itself can still fail after the browser above is already running (e.g.
 // an invalid/decommissioned model name rejected by its own schema validation - hit more than
 // once in practice). Nothing else in this call chain holds a reference to `browser` if that
 // happens, so without closing it here explicitly, the process leaks and lingers until killed
 // manually before the next run.
 try{
  if(compatApiKey&&compatBaseURL&&compatModel){
   return await Stagehand.create({browser,model:createOpenAICompatibleClient({apiKey:compatApiKey,baseURL:compatBaseURL,model:compatModel}),logging:{level:"info"}});
  }
  const model=process.env.STAGEHAND_MODEL||"groq/openai/gpt-oss-120b";
  // Match the API key to the provider the model string actually specifies, rather than
  // grabbing whichever provider's key happens to exist first in a fixed-order list - otherwise
  // switching STAGEHAND_MODEL to a different provider while an old key from a previous
  // provider is still sitting in .env silently sends the WRONG key to the new provider.
  const provider=model.split("/")[0];
  const apiKey=process.env[PROVIDER_API_KEY_ENV_VAR[provider]||""];
  const modelConfig:any={modelName:model};
  if(apiKey)modelConfig.apiKey=apiKey;
  return await Stagehand.create({browser,model:modelConfig,logging:{level:"info"}});
 }catch(e){
  await browser.close().catch(()=>{});
  throw e;
 }
}
