import {inspect,Candidate} from "../discovery/dom.js";

// Strategy order (most general/common first, most site-specific last):
// 1. Direct match already visible on the page (PDF link / download / attachment) - zero LLM calls
// 2. One grounded LLM decision per step: given the ranked DOM candidates, either click one,
//    use the site's search feature (if visible), or navigate somewhere more specific.
// 3. Mechanical fallback: click the top-scoring unclicked candidate if the LLM step fails.

const TOP_N_FOR_PROMPT=8;

function summarize(candidates:Candidate[]):string{
 return candidates.slice(0,TOP_N_FOR_PROMPT).map((c,i)=>`${i+1}. [${c.kind}] "${c.text.slice(0,80)}"${c.url?` -> ${c.url}`:""}`).join("\n")||"(none detected)";
}

export async function resolve(stagehand:any,page:any,instruction:string,maxSteps=8){
 const history:any[]=[];
 let lastUrl:string|null=null;let stuckStreak=0;
 for(let i=0;i<maxSteps;i++){
  const url=await page.url();
  if(url===lastUrl){stuckStreak++;if(stuckStreak>=3)break;}else{stuckStreak=0;}
  lastUrl=url;
  if(/\.pdf(?:$|[?#])/i.test(url))return{ok:true,url,history};

  const candidates=await inspect(page);
  const direct=candidates.find(x=>x.url&&/\.pdf(?:$|[?#])/i.test(x.url))||candidates.find(x=>x.url&&/download|attachment|첨부|다운로드|pdf/i.test(`${x.text} ${x.url}`));
  if(direct?.url){history.push({url,action:direct});return{ok:true,url:direct.url,history};}

  let acted=false;
  try{
   const prompt=`Goal: find "${instruction}" on this site.
Candidate links/buttons already detected on this page (may be incomplete or approximate):
${summarize(candidates)}

Pick the single best next action:
- If one of the candidates above (or another visible link) leads directly to the exact file, choose it.
- If a search box is visible and would likely be faster or more reliable than browsing, choose that instead.
- Otherwise choose the most specific/relevant navigation (category, date, article) over generic or unrelated links.
Avoid choosing something that would leave the page unchanged.`;
   const obs=await stagehand.observe(prompt,{page,timeout:60000});
   const next=obs?.data?.[0];
   if(next?.selector){
    history.push({url,action:{kind:"observe",text:next.description,selector:next.selector}});
    await stagehand.act(next,{page,timeout:60000});
    if(/search/i.test(next.description)){
     try{
      await page.waitForTimeout(300);
      await stagehand.act(`Type "${instruction}" into the search input field and press Enter to submit the search.`,{page,timeout:60000});
      await page.waitForTimeout(1000);
     }catch{}
    }
    acted=true;
   }
  }catch(e){console.error("observe step failed:",e instanceof Error?e.message:String(e));}

  if(!acted){
   const action=candidates.find(x=>x.kind==="button"||x.kind==="link");
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
