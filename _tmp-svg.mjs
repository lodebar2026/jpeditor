import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
const [inp,out]=process.argv.slice(2);
const b=await chromium.launch({channel:"msedge"});
const p=await b.newPage({viewport:{width:900,height:500}});
await p.setContent(`<body style="margin:0">${await readFile(inp,"utf8")}</body>`);
await writeFile(out, await (await p.$("svg")).screenshot());
await b.close();
