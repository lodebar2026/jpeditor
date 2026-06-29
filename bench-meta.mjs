import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
const ROOT=join(process.cwd(),"dist");const IMG="testdata/日光之下/日光之下简谱.jpg";const GT="testdata/日光之下/日光之下.jpwabc";
const MIME={".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".woff2":"font/woff2",".svg":"image/svg+xml",".wasm":"application/wasm"};
function dec(b){if(b[0]===0xff&&b[1]===0xfe)return Buffer.from(b.slice(2)).toString("utf16le");return b.toString("utf8");}
const server=createServer(async(req,res)=>{try{let p=decodeURIComponent((req.url??"/").split("?")[0]);if(p==="/")p="/index.html";const d=await readFile(join(ROOT,normalize(p)));res.writeHead(200,{"content-type":MIME[extname(p)]??"application/octet-stream"});res.end(d);}catch{res.writeHead(404);res.end("nf");}});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await chromium.launch({channel:"msedge",headless:true});const page=await browser.newPage();
await page.goto("http://localhost:"+port+"/",{waitUntil:"networkidle"});await page.waitForTimeout(500);
const b64=Buffer.from(await readFile(IMG)).toString("base64");
const r=await page.evaluate(async({b64})=>{const omr=await window.__omr;const by=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const bin=await omr.decodeToBinary(by,"image/jpeg");const sc=await omr.recognizeJianpu(bin,omr.paddleOcrBackend());const xml=omr.toMusicXml(sc);window.__app.importBytes(new TextEncoder().encode(xml),"o.musicxml");return {jpw:window.__app.getText(), xml};},{b64});
const gt=dec(await readFile(GT));
function head(t){return t.split(/\.Voice/i)[0];}
console.log("===== GT 头部(.Title) =====\n"+head(gt));
console.log("===== 生成 头部 =====\n"+head(r.jpw));
const slur=t=>{const v=t.split(/\.Voice/i)[1]?.split(/\.Words/i)[0]||"";return (v.match(/\(/g)||[]).length;};
console.log("===== slur(括号组) 数: GT="+slur(gt)+" 生成="+slur(r.jpw));
console.log("===== MusicXML 含 slur/tie/work-title/creator? "+JSON.stringify({slur:/<slur/.test(r.xml),tied:/<tied/.test(r.xml),tie:/<tie[ >]/.test(r.xml),workTitle:/<work-title/.test(r.xml),creator:/<creator/.test(r.xml),movementTitle:/<movement-title/.test(r.xml)}));
await browser.close();server.close();
