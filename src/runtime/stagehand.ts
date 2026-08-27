import {Stagehand, localBrowser} from "@browserbasehq/stagehand";
import {chromium} from "playwright";
import path from "node:path";
export async function createStagehand(){
 const model=process.env.STAGEHAND_MODEL||"openai/gpt-4o-mini";
 const executablePath=process.env.CHROME_PATH||chromium.executablePath();
 const launch:any={headless:true,acceptDownloads:true,downloadsPath:path.resolve("downloads"),args:["--no-sandbox","--disable-setuid-sandbox"],executablePath};
 const browser=await localBrowser.launch(launch);
 const stagehand=await Stagehand.create({browser,model:model as any});
 return stagehand;
}
