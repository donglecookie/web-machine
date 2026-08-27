import {inspect,Candidate} from "../discovery/dom.js";
import {z} from "zod";
const extractSchema=z.object({url:z.string().nullable(),text:z.string().nullable()});
export async function resolve(stagehand:any,page:any,instruction:string,maxSteps=8){
 const history:any[]=[];const seen=new Set<string>();
 for(let i=0;i<maxSteps;i++){
  const url=await page.url();if(seen.has(url))break;seen.add(url);
  if(/\.pdf(?:$|[?#])/i.test(url))return{ok:true,url,history};
  const candidates=await inspect(page);
  const direct=candidates.find(x=>x.url&&/\.pdf(?:$|[?#])/i.test(x.url))||candidates.find(x=>x.url&&/download|attachment|첨부|다운로드|pdf/i.test(`${x.text} ${x.url}`));
  if(direct?.url){history.push({url,action:direct});return{ok:true,url:direct.url,history};}
  const semantic=await stagehand.extract(`Find the most relevant link, button, attachment, or downloadable PDF for: ${instruction}. Return the visible text and URL if available.`,extractSchema,{page,timeout:45000});
  const candidate=extractCandidate(semantic?.data);
  if(candidate?.url){history.push({url,action:candidate});return{ok:true,url:candidate.url,history};}
  let acted=false;
  try{
   const obs=await stagehand.observe(`Find the single best link, menu item, or button on this page to click next that moves closer to finding: ${instruction}. Prefer specific categories, dates, or article links over generic/unrelated navigation. Avoid links that stay on the current page.`,{page,timeout:45000});
   const next=obs?.data?.[0];
   if(next?.selector){
    history.push({url,action:{kind:"observe",text:next.description,selector:next.selector}});
    await stagehand.act(next,{page,timeout:45000});
    acted=true;
   }
  }catch(e){console.error("observe step failed:",e instanceof Error?e.message:String(e));}
  if(!acted){
   const action=candidates.find(x=>(x.kind==="button"||x.kind==="link")&&!(x.url&&seen.has(x.url)));
   if(!action)break;
   history.push({url,action});
   try{
    if(action.selector)await stagehand.act(`Click the element with selector ${action.selector}.`,{page,timeout:30000});
    else if(action.url)await page.goto(action.url,{waitUntil:"domcontentloaded",timeout:30000});
   }catch{break;}
  }
  await page.waitForTimeout(500);
 }
 return{ok:false,history};
}
function extractCandidate(v:any):Candidate|null{
 if(!v||typeof v.url!=="string")return null;
 return{kind:"semantic",text:v.text||"",url:v.url,score:100};
}
