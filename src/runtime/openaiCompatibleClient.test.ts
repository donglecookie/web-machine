import {test} from "node:test";
import assert from "node:assert/strict";
import {toOpenAIMessages,toOpenAITools,fromOpenAIChoiceText,fromOpenAIChoiceJsonSchema} from "./openaiCompatibleClient.js";

test("toOpenAIMessages passes through plain string content unchanged", () => {
 const out=toOpenAIMessages([{role:"user",content:"hello"}]);
 assert.deepEqual(out,[{role:"user",content:"hello"}]);
});

test("toOpenAIMessages prepends a system message when systemPrompt is given", () => {
 const out=toOpenAIMessages([{role:"user",content:"hi"}],"be helpful");
 assert.equal(out[0].role,"system");
 assert.equal(out[0].content,"be helpful");
 assert.equal(out[1].content,"hi");
});

test("toOpenAIMessages normalizes a single content block (not an array) the same as an array", () => {
 const single=toOpenAIMessages([{role:"user",content:{type:"text",text:"hi"}}]);
 const array=toOpenAIMessages([{role:"user",content:[{type:"text",text:"hi"}]}]);
 assert.deepEqual(single,array);
});

test("toOpenAIMessages converts a tool_use block into OpenAI's tool_calls array", () => {
 const out=toOpenAIMessages([{role:"assistant",content:[{type:"tool_use",id:"call_1",name:"click",input:{selector:"#btn"}}]}]);
 assert.equal(out[0].role,"assistant");
 assert.equal(out[0].tool_calls[0].id,"call_1");
 assert.equal(out[0].tool_calls[0].function.name,"click");
 assert.deepEqual(JSON.parse(out[0].tool_calls[0].function.arguments),{selector:"#btn"});
});

test("toOpenAIMessages splits a tool_result block into its own separate role:tool message", () => {
 const out=toOpenAIMessages([{role:"user",content:[{type:"tool_result",toolUseId:"call_1",content:[{type:"text",text:"done"}]}]}]);
 assert.equal(out.length,1);
 assert.equal(out[0].role,"tool");
 assert.equal(out[0].tool_call_id,"call_1");
 assert.equal(out[0].content,"done");
});

test("toOpenAIMessages combines text and tool_use blocks from the same message correctly", () => {
 const out=toOpenAIMessages([{role:"assistant",content:[{type:"text",text:"thinking..."},{type:"tool_use",id:"c1",name:"search",input:{}}]}]);
 assert.equal(out.length,1);
 assert.equal(out[0].content,"thinking...");
 assert.equal(out[0].tool_calls[0].function.name,"search");
});

test("toOpenAITools maps Stagehand tool definitions to OpenAI function-calling format", () => {
 const out=toOpenAITools([{name:"click",description:"clicks an element",inputSchema:{type:"object",properties:{selector:{type:"string"}}}}]);
 assert.equal(out?.[0].type,"function");
 assert.equal(out?.[0].function.name,"click");
 assert.equal(out?.[0].function.description,"clicks an element");
});

test("toOpenAITools returns undefined for an empty/missing tools list", () => {
 assert.equal(toOpenAITools(undefined),undefined);
 assert.equal(toOpenAITools([]),undefined);
});

test("fromOpenAIChoiceText converts plain text content into a single text block", () => {
 const out=fromOpenAIChoiceText({message:{content:"hello there"},finish_reason:"stop"},undefined);
 assert.equal(out.outputFormat,"text");
 assert.deepEqual(out.content,[{type:"text",text:"hello there"}]);
 assert.equal(out.stopReason,"stop");
});

test("fromOpenAIChoiceText converts OpenAI tool_calls into tool_use blocks with parsed input", () => {
 const out=fromOpenAIChoiceText({message:{tool_calls:[{id:"c1",function:{name:"click",arguments:'{"selector":"#x"}'}}]},finish_reason:"tool_calls"},undefined);
 assert.equal(out.content[0].type,"tool_use");
 if(out.content[0].type==="tool_use"){
  assert.equal(out.content[0].name,"click");
  assert.deepEqual(out.content[0].input,{selector:"#x"});
 }
});

test("fromOpenAIChoiceText maps OpenAI's usage field names to Stagehand's (prompt_tokens -> inputTokens etc.)", () => {
 const out=fromOpenAIChoiceText({message:{content:"x"},finish_reason:"stop"},{prompt_tokens:10,completion_tokens:5,total_tokens:15});
 assert.deepEqual(out.usage,{inputTokens:10,outputTokens:5,totalTokens:15});
});

test("fromOpenAIChoiceJsonSchema parses valid JSON content into structuredContent", () => {
 const out=fromOpenAIChoiceJsonSchema({message:{content:'{"results":[{"title":"a","url":"https://x.com"}]}'},finish_reason:"stop"},undefined);
 assert.equal(out.outputFormat,"json_schema");
 if(out.outputFormat==="json_schema")assert.deepEqual(out.structuredContent,{results:[{title:"a",url:"https://x.com"}]});
});

test("fromOpenAIChoiceJsonSchema falls back to an empty object rather than throwing on invalid JSON", () => {
 const out=fromOpenAIChoiceJsonSchema({message:{content:"not valid json"},finish_reason:"stop"},undefined);
 assert.equal(out.outputFormat,"json_schema");
 if(out.outputFormat==="json_schema")assert.deepEqual(out.structuredContent,{});
});
