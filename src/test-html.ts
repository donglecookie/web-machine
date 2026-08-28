import {HtmlMachine} from "./machine/HtmlMachine.js";
const [startUrl,...rest]=process.argv.slice(2);
const query=rest.join(" ");
if(!startUrl||!query){
 console.error("Usage: npm run test:html -- <start-url> <what to find>");
 process.exit(1);
}
console.log("START:",startUrl);
console.log("QUERY:",query);
const result=await new HtmlMachine().resolve(startUrl,query);
console.log(JSON.stringify(result,null,2));
process.exitCode=result.ok?0:1;
