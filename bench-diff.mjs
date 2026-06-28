import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
const ROOT=join(process.cwd(),"dist");const IMG="testdata/日光之下/日光之下简谱.jpg";const GT="testdata/日光之下/日光之下.jpwabc";
const MIME={".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".woff2":"font/woff2",".svg":"image/svg+xml",".wasm":"application/wasm"};
function dec(b){if(b[0]===0xff&&b[1]===0xfe)return Buffer.from(b.slice(2)).toString("utf16le");return b.toString("utf8");}
const hanzi=s=>(s.match(/[一-鿿]/g)||[]);
function voiceToks(text){const lines=text.split(/\r?\n/);let inV=false;const t=[];for(const ln of lines){const s=ln.trim();if(s.startsWith(".")){inV=/^\.voice/i.test(s);continue;}if(!inV||!s)continue;const c=ln.replace(/\$\([^)]*\)/g," ").replace(/[()\]]/g," ").replace(/\|/g," | ");for(const raw of c.split(/\s+/)){if(!raw)continue;if(raw==="|"){t.push("|");continue;}const m=raw.match(/^([0-7])([',]*)?(_*)(-*)(\.*)/);if(!m)continue;const o=(m[2]||"").split("").reduce((a,ch)=>a+(ch==="'"?1:-1),0);t.push(`${m[1]}${o>0?"'".repeat(o):o<0?",".repeat(-o):""}${"_".repeat((m[3]||"").length)}`);for(let i=0;i<(m[4]||"").length;i++)t.push("-");}}return t;}
// 编辑脚本(对齐)
function alignOps(a,b){const m=a.length,n=b.length;const dp=Array.from({length:m+1},()=>new Array(n+1).fill(0));for(let i=0;i<=m;i++)dp[i][0]=i;for(let j=0;j<=n;j++)dp[0][j]=j;for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1));const ops=[];let i=m,j=n;while(i>0||j>0){if(i>0&&j>0&&a[i-1]===b[j-1]){i--;j--;}else if(i>0&&j>0&&dp[i][j]===dp[i-1][j-1]+1){ops.push(["sub",i-1,j-1,a[i-1],b[j-1]]);i--;j--;}else if(j>0&&dp[i][j]===dp[i][j-1]+1){ops.push(["ins",i,j-1,null,b[j-1]]);j--;}else{ops.push(["del",i-1,j,a[i-1],null]);i--;}}return ops.reverse();}

const server=createServer(async(req,res)=>{try{let p=decodeURIComponent((req.url??"/").split("?")[0]);if(p==="/")p="/index.html";const d=await readFile(join(ROOT,normalize(p)));res.writeHead(200,{"content-type":MIME[extname(p)]??"application/octet-stream"});res.end(d);}catch{res.writeHead(404);res.end("nf");}});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await chromium.launch({channel:"msedge",headless:true});const page=await browser.newPage();
await page.goto(`http://localhost:${port}/`,{waitUntil:"networkidle"});await page.waitForTimeout(500);
const b64=Buffer.from(await readFile(IMG)).toString("base64");
const jpw=await page.evaluate(async({b64})=>{const omr=await window.__omr;const by=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const bin=await omr.decodeToBinary(by,"image/jpeg");const sc=await omr.recognizeJianpu(bin,omr.paddleOcrBackend());const xml=omr.toMusicXml(sc);window.__app.importBytes(new TextEncoder().encode(xml),"o.musicxml");return window.__app.getText();},{b64});

const gtText=dec(await readFile(GT));
const gT=voiceToks(gtText),rT=voiceToks(jpw);
console.log(`\n##### 音符 token: GT ${gT.length} / 识别 ${rT.length} #####`);
const ops=alignOps(gT,rT);
let sub=0,ins=0,del=0;
for(const[k,gi,ri,ga,rb] of ops){const ctx=gi>=0?gT.slice(Math.max(0,gi-2),gi+1).join(" "):"";
  if(k==="sub"){sub++;console.log(`  替换 @GT#${gi}: 「${ga}」→「${rb}」  (上下文: …${ctx})`);}
  else if(k==="ins"){ins++;console.log(`  多出 @识别#${ri}: 「${rb}」`);}
  else{del++;console.log(`  漏掉 @GT#${gi}: 「${ga}」`);}}
console.log(`  小计：替换 ${sub} 漏 ${del} 多 ${ins}`);

// 歌词
function verse(tag){const lines=gtText.split(/\r?\n/);let on=false,s="";for(const ln of lines){if(ln.startsWith(tag)){on=true;continue;}if(on){if(/^[A-Z]\d+@/.test(ln)||ln.startsWith("."))break;s+=ln;}}return hanzi(s).join("");}
const lines=jpw.split(/\r?\n/);let inW=false;const wbuf=[];for(const ln of lines){const t=ln.trim();if(t.startsWith(".")){inW=/^\.words/i.test(t);continue;}if(inW)wbuf.push(ln);}
const gen={};{let cur=null;for(const ln of wbuf){const m=ln.match(/^(W\d+)@/);if(m){cur=m[1];gen[cur]="";continue;}if(cur)gen[cur]+=ln;}}
for(const[name,tag] of [["W1","W1@"],["W2","W2@"]]){
  const g=verse(tag),r=hanzi(gen[name]||"").join("");
  console.log(`\n##### 歌词 ${name}: GT ${g.length} / 识别 ${r.length} #####`);
  for(const[k,gi,ri,ga,rb] of alignOps([...g],[...r])){
    if(k==="sub")console.log(`  替换 @${gi}: ${ga}→${rb}  (…${g.slice(Math.max(0,gi-3),gi)}[${ga}]${g.slice(gi+1,gi+3)}…)`);
    else if(k==="ins")console.log(`  多出: ${rb}`);
    else console.log(`  漏掉 @${gi}: ${ga}  (…${g.slice(Math.max(0,gi-3),gi)}[${ga}]${g.slice(gi+1,gi+3)}…)`);}
}
await browser.close();server.close();
