// Adapter between two genuinely different message protocols:
// - Stagehand's ClientLLM interface (Anthropic/MCP-style): messages carry content as a typed
//   block (or array of blocks: text/image/tool_use/tool_result), and requests/responses come
//   in TWO distinct shapes - a tool-calling shape (act/observe) and a structured-output shape
//   with a required JSON schema (extract).
// - OpenRouter's API (OpenAI-compatible): messages carry a flat string `content`, tool calls
//   live in a separate `tool_calls` array, tool results are their own `role:"tool"` message,
//   and structured output is requested via `response_format:{type:"json_schema",...}`.
// This file translates in both directions so any OpenAI-compatible endpoint (OpenRouter here,
// but the same adapter works for any other OpenAI-format provider) can act as a Stagehand model.

type Block=
 |{type:"text";text:string}
 |{type:"image";data:string;mimeType:string}
 |{type:"tool_use";id:string;name:string;input:any}
 |{type:"tool_result";toolUseId:string;content:Array<{type:"text";text:string}|{type:"image";data:string;mimeType:string}>;isError?:boolean};

type StagehandMessage={role:"user"|"assistant";content:string|Block|Block[]};
type StagehandTool={name:string;description?:string;inputSchema?:Record<string,unknown>};

// Two request shapes, discriminated by whether responseFormat.type is "json_schema" (extract,
// wants one structured object back) or the request has tools/toolChoice instead (act/observe,
// wants a tool call back).
type StagehandRequest={
 messages:StagehandMessage[];
 systemPrompt?:string;
 temperature?:number;
 tools?:StagehandTool[];
 toolChoice?:{mode?:"required"|"auto"|"none"};
 responseFormat?:{type:"text"}|{type:"json_schema";name:string;description?:string;schema:unknown};
};
type StagehandResponse=
 |{role:"assistant";content:Block[];stopReason?:string;usage?:{inputTokens:number;outputTokens:number;totalTokens:number};outputFormat:"text"}
 |{role:"assistant";content:Block[];stopReason?:string;usage?:{inputTokens:number;outputTokens:number;totalTokens:number};outputFormat:"json_schema";structuredContent:any};

// Stagehand's content is a string, a single block, or an array of blocks; a tool_result block
// becomes its own separate OpenAI `role:"tool"` message, since OpenAI has no equivalent of an
// inline tool-result block within a user/assistant message.
export function toOpenAIMessages(messages:StagehandMessage[],systemPrompt?:string):any[]{
 const out:any[]=systemPrompt?[{role:"system",content:systemPrompt}]:[];
 for(const m of messages){
  if(typeof m.content==="string"){out.push({role:m.role,content:m.content});continue;}
  const blocks:Block[]=Array.isArray(m.content)?m.content:[m.content];
  const textParts:string[]=[];
  const toolCalls:any[]=[];
  for(const block of blocks){
   if(block.type==="text")textParts.push(block.text);
   else if(block.type==="tool_use")toolCalls.push({id:block.id,type:"function",function:{name:block.name,arguments:JSON.stringify(block.input)}});
   else if(block.type==="tool_result"){
    const text=block.content.filter((c):c is{type:"text";text:string}=>c.type==="text").map(c=>c.text).join("\n");
    out.push({role:"tool",tool_call_id:block.toolUseId,content:text});
   }
   // image blocks are not translated (rare in act/observe text flows) - dropped rather than
   // silently mis-encoded, since a wrong image encoding is worse than a missing one here.
  }
  if(textParts.length||toolCalls.length){
   const msg:any={role:m.role,content:textParts.join("\n")||null};
   if(toolCalls.length)msg.tool_calls=toolCalls;
   out.push(msg);
  }
 }
 return out;
}

export function toOpenAITools(tools?:StagehandTool[]):any[]|undefined{
 if(!tools?.length)return undefined;
 return tools.map(t=>({type:"function",function:{name:t.name,description:t.description||"",parameters:t.inputSchema||{type:"object",properties:{}}}}));
}

// The reverse direction: an OpenAI-shaped choice becomes Stagehand's block-array response.
export function fromOpenAIChoiceText(choice:any,usage:any):StagehandResponse{
 const content:Block[]=[];
 const msg=choice?.message||{};
 if(msg.content)content.push({type:"text",text:String(msg.content)});
 for(const tc of msg.tool_calls||[]){
  let input:Record<string,unknown>={};
  try{input=JSON.parse(tc.function?.arguments||"{}");}catch{}
  content.push({type:"tool_use",id:tc.id||`call_${Math.random().toString(36).slice(2)}`,name:tc.function?.name||"",input});
 }
 return{
  role:"assistant",
  content,
  stopReason:choice?.finish_reason,
  usage:usage?{inputTokens:usage.prompt_tokens||0,outputTokens:usage.completion_tokens||0,totalTokens:usage.total_tokens||0}:undefined,
  outputFormat:"text"
 };
}

export function fromOpenAIChoiceJsonSchema(choice:any,usage:any):StagehandResponse{
 const raw=String(choice?.message?.content||"{}");
 let structuredContent:any={};
 try{structuredContent=JSON.parse(raw);}catch{/* leave as {} if the model didn't return valid JSON */}
 return{
  role:"assistant",
  content:[{type:"text",text:raw}],
  stopReason:choice?.finish_reason,
  usage:usage?{inputTokens:usage.prompt_tokens||0,outputTokens:usage.completion_tokens||0,totalTokens:usage.total_tokens||0}:undefined,
  outputFormat:"json_schema",
  structuredContent
 };
}

export type OpenAICompatibleClientOptions={apiKey:string;model:string;baseURL?:string;headers?:Record<string,string>};

// Builds a Stagehand ClientLLM ({generate}) backed by any OpenAI-compatible chat completions
// endpoint. Defaults to OpenRouter's endpoint; pass baseURL to point at a different compatible
// provider (self-hosted, Azure, etc.) without touching the translation logic above.
export function createOpenAICompatibleClient(opts:OpenAICompatibleClientOptions){
 const baseURL=opts.baseURL||"https://openrouter.ai/api/v1";
 return{
  async generate(input:StagehandRequest,signal?:AbortSignal):Promise<StagehandResponse>{
   const wantsJsonSchema=input.responseFormat?.type==="json_schema";
   const body:any={
    model:opts.model,
    messages:toOpenAIMessages(input.messages,input.systemPrompt),
    ...(input.temperature!==undefined?{temperature:input.temperature}:{})
   };
   if(wantsJsonSchema){
    const rf=input.responseFormat as{type:"json_schema";name:string;description?:string;schema:unknown};
    body.response_format={type:"json_schema",json_schema:{name:rf.name,description:rf.description,schema:rf.schema,strict:false}};
   }else{
    const tools=toOpenAITools(input.tools);
    if(tools){body.tools=tools;if(input.toolChoice?.mode)body.tool_choice=input.toolChoice.mode;}
   }
   const res=await fetch(`${baseURL}/chat/completions`,{
    method:"POST",
    headers:{"Content-Type":"application/json",Authorization:`Bearer ${opts.apiKey}`,...opts.headers},
    body:JSON.stringify(body),
    signal
   });
   if(!res.ok)throw new Error(`OpenAI-compatible endpoint error: HTTP ${res.status} ${await res.text().catch(()=>"")}`);
   const data:any=await res.json();
   const choice=data?.choices?.[0];
   if(!choice)throw new Error(`OpenAI-compatible endpoint returned no choices: ${JSON.stringify(data).slice(0,300)}`);
   return wantsJsonSchema?fromOpenAIChoiceJsonSchema(choice,data.usage):fromOpenAIChoiceText(choice,data.usage);
  }
 };
}
