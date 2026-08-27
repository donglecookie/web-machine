import {inspect,Candidate} from "../discovery/dom.js";
export async function resolve(page:any,instruction:string,maxSteps=8){
 const history:any[]=[];const seen=new Set<string>();
 for(let i=0;i<maxSteps;i++){
  const url=page.url();if(seen.has(url))break;seen.add(url);
  if(/\.pdf(?:$|[?#])/i.test(url))return{ok:true,url,history};
  const candidates=await inspect(page);
  const direct=candidates.find(x=>x.url&&/\.pdf(?:$|[?#])/i.test(x.url))||candidates.find(x=>x.url&&/download|attachment|첨부|다운로드|pdf/i.test(`${x.text} ${x.url}`));
  if(direct?.url){history.push({url,action:direct});return{ok:true,url:direct.url,history};}
  const semantic=await page.extract(`Find the most relevant link, button, attachment, or downloadable PDF for: ${instruction}. Return the visible text and URL if available.`);
  const candidate=extractCandidate(semantic);
  if(candidate?.url){history.push({url,action:candidate});return{ok:true,url:candidate.url,history};}
  const action=candidates.find(x=>x.kind==="button"||x.kind==="link");
  if(!action)break;
  history.push({url,action});
  if(action.selector)await page.act(`Click the element with selector ${action.selector}.`);
  else if(action.url)await page.goto(action.url,{waitUntil:"domcontentloaded"});
  await page.waitForTimeout(500);
 }
 return{ok:false,history};
}
function extractCandidate(v:any):Candidate|null{
 const xs=Array.isArray(v)?v:Array.isArray(v?.candidates)?v.candidates:Array.isArray(v?.files)?v.files:[v];
 const x=xs.find((x:any)=>x&&typeof x.url==="string");return x?{kind:"semantic",text:x.text||x.title||"",url:x.url,score:100}:null;
}
