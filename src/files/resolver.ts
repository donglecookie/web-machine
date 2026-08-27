import {inspect} from "../discovery/dom.js";
export async function resolve(stagehand:any,page:any,instruction:string,maxSteps=8){
 const history:any[]=[];const seen=new Set<string>();
 for(let i=0;i<maxSteps;i++){
  const url=await page.url();if(seen.has(url))break;seen.add(url);
  if(/\.pdf(?:$|[?#])/i.test(url))return{ok:true,url,history};
  const candidates=await inspect(page);
  const direct=candidates.find(x=>x.url&&/\.pdf(?:$|[?#])/i.test(x.url))||candidates.find(x=>x.url&&/download|attachment|첨부|다운로드|pdf/i.test(`${x.text} ${x.url}`));
  if(direct?.url){history.push({url,action:direct});return{ok:true,url:direct.url,history};}
  let acted=false;
  try{
   const obs=await stagehand.observe(`Find the single best link, menu item, or button on this page to click next that moves closer to finding: ${instruction}. If a direct download link, attachment, or PDF for exactly this item is visible, prefer that. Otherwise prefer specific categories, dates, or article links over generic/unrelated navigation. Avoid links that stay on the current page.`,{page,timeout:60000});
   const next=obs?.data?.[0];
   if(next?.selector){
    history.push({url,action:{kind:"observe",text:next.description,selector:next.selector}});
    await stagehand.act(next,{page,timeout:60000});
    acted=true;
   }
  }catch(e){console.error("observe step failed:",e instanceof Error?e.message:String(e));}
  if(!acted){
   const action=candidates.find(x=>(x.kind==="button"||x.kind==="link")&&!(x.url&&seen.has(x.url)));
   if(!action)break;
   history.push({url,action});
   try{
    if(action.selector)await stagehand.act(`Click the element with selector ${action.selector}.`,{page,timeout:60000});
    else if(action.url)await page.goto(action.url,{waitUntil:"domcontentloaded",timeout:60000});
   }catch{break;}
  }
  await page.waitForTimeout(500);
 }
 return{ok:false,history};
}
