// Structured logging, replacing ad-hoc console.error calls whose formats had drifted apart
// enough that a run's output couldn't be filtered or parsed mechanically - every line now
// carries a level and a stable event name, with details as named fields rather than baked
// into free-form prose.
//
// Writes to stderr so log output never contaminates the JSON result on stdout, which callers
// (and src/test.ts) parse.

export type LogLevel="debug"|"info"|"warn"|"error";
export type LogFields=Record<string,unknown>;

const LEVEL_ORDER:Record<LogLevel,number>={debug:10,info:20,warn:30,error:40};

// Default threshold is "info"; set LOG_LEVEL=debug for verbose runs or =error to quiet things
// down without editing code.
function activeLevel():LogLevel{
 const raw=(process.env.LOG_LEVEL||"info").toLowerCase();
 return (raw in LEVEL_ORDER?raw:"info") as LogLevel;
}

function formatFields(fields?:LogFields):string{
 if(!fields)return"";
 const parts=Object.entries(fields)
  .filter(([,v])=>v!==undefined)
  .map(([k,v])=>`${k}=${typeof v==="string"?v:JSON.stringify(v)}`);
 return parts.length?` ${parts.join(" ")}`:"";
}

export function log(level:LogLevel,event:string,fields?:LogFields):void{
 if(LEVEL_ORDER[level]<LEVEL_ORDER[activeLevel()])return;
 console.error(`[${level}] ${event}${formatFields(fields)}`);
}

export const logger={
 debug:(event:string,fields?:LogFields)=>log("debug",event,fields),
 info:(event:string,fields?:LogFields)=>log("info",event,fields),
 warn:(event:string,fields?:LogFields)=>log("warn",event,fields),
 error:(event:string,fields?:LogFields)=>log("error",event,fields),
};
