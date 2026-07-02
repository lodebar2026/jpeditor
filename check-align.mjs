// 检查 OMR 结果的「歌词↔音符对位」是否正确。
// .Words 里每个汉字占一个音符、`/` 占一个音符(melisma 续前字/空), 标点贴前字不占音符。
// 于是把每 verse 展开成「逐音符序列」(汉字→该字, / →续记号 ·), 与 GT 逐音符序列做 Levenshtein。
// 这比 flat CER 更能反映对位: 一处 / 错位会导致其后整体错位。
// 另外验证「音符总数 == 各 verse 音符格数」这一对齐前提是否成立。
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const TESTDATA = join(process.cwd(), "testdata");
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".bmp": "image/bmp", ".webp": "image/webp" };
const filters = process.argv.slice(2);

function dec(b){ if(b[0]===0xff&&b[1]===0xfe)return Buffer.from(b.slice(2)).toString("utf16le"); if(b[0]===0xfe&&b[1]===0xff){const s=Buffer.from(b.slice(2));s.swap16();return s.toString("utf16le");} return b.toString("utf8"); }
const isHan = (c) => /[一-鿿]/.test(c);
const PUNCT = "，。、；：？！,.;:?!（）()《》「」“”‘’—…·　 \t";

// verse → 逐音符 token 序列。汉字→字; '/'→'·'(续/空音符); 标点/空白→跳过(贴前字, 不占音符)
function verseNoteSeq(text){
  const verses = new Map(); let inW=false, cur=null;
  for(const ln of text.split(/\r?\n/)){
    const t=ln.trim();
    if(t.startsWith(".")){ inW=/^\.words/i.test(t); continue; }
    if(!inW) continue;
    const h=t.match(/^W(\d+)/);
    if(h){ cur=h[1]; if(!verses.has(cur))verses.set(cur,[]); continue; }
    if(cur==null) continue;
    for(const c of ln){
      if(c==="/") verses.get(cur).push("·");
      else if(isHan(c)) verses.get(cur).push(c);
      else if(PUNCT.includes(c)) {/*贴前字*/}
      // 其它字符忽略
    }
  }
  return verses;
}
function lev(a,b){const m=a.length,n=b.length;if(!m)return n;if(!n)return m;let p=[...Array(n+1).keys()];for(let i=1;i<=m;i++){const c=[i];for(let j=1;j<=n;j++)c[j]=Math.min(p[j]+1,c[j-1]+1,p[j-1]+(a[i-1]===b[j-1]?0:1));p=c;}return p[n];}
const acc=(g,r)=>1-lev(g,r)/Math.max(g.length,r.length,1);

// 反复段(D.S./段落反复)在 GT 里照唱词抄了一遍, 但图上只印一次、OMR 只读一次。
// 剔掉「整段又在前文连续出现过」的最长后缀(=照抄的反复段), 循环到稳定。(同 measure-all.trimRepeatedSuffix)
function trimRepeatedSuffix(s, minLen = 8) {
  let cur = s;
  for (;;) {
    const n = cur.length; let cut = 0;
    for (let L = Math.floor(n / 2); L >= minLen; L--) {
      if (cur.slice(0, n - L).includes(cur.slice(n - L))) { cut = L; break; }
    }
    if (!cut) return cur;
    cur = cur.slice(0, n - cut);
  }
}
// 在「逐音符序列(含 · 续记号)」上剔反复后缀: 反复段无 / 标记(纯汉字), 故用汉字投影定位裁剪量,
// 再从尾部按汉字计数删对应音格(顺带删掉夹带的 · 续记号)。
function trimSeqRepeat(seq){
  const han = seq.filter(t=>t!=="·").join("");
  const kept = trimRepeatedSuffix(han);
  let rm = han.length - kept.length;
  if(rm<=0) return seq;
  let i=seq.length;
  while(i>0 && rm>0){ i--; if(seq[i]!=="·") rm--; }
  return seq.slice(0,i);
}

async function findSongs(){
  const out=[];
  for(const name of (await readdir(TESTDATA,{withFileTypes:true})).filter(d=>d.isDirectory())){
    const dir=join(TESTDATA,name.name); const files=await readdir(dir);
    const img=files.find(f=>IMG_EXT.has(extname(f).toLowerCase()));
    const gt=files.find(f=>extname(f).toLowerCase()===".jpwabc");
    if(!img||!gt) continue;
    if(filters.length&&!filters.some(f=>name.name.includes(f))) continue;
    out.push({name:name.name,img:join(dir,img),gt:join(dir,gt)});
  }
  return out.sort((a,b)=>a.name.localeCompare(b.name,"zh"));
}

const server=createServer(async(req,res)=>{try{let p=decodeURIComponent((req.url??"/").split("?")[0]);if(p==="/")p="/index.html";const d=await readFile(join(ROOT,normalize(p)));res.writeHead(200,{"content-type":MIME[extname(p)]??"application/octet-stream"});res.end(d);}catch{res.writeHead(404);res.end("nf");}});
await new Promise(r=>server.listen(0,r));
const port=server.address().port;
const browser=await chromium.launch({channel:"msedge",headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}});
await page.goto(`http://localhost:${port}/`,{waitUntil:"networkidle"}); await page.waitForTimeout(800);

const songs=await findSongs();
for(const song of songs){
  const mime=MIME[extname(song.img).toLowerCase()]??"image/jpeg";
  const b64=Buffer.from(await readFile(song.img)).toString("base64");
  let rec;
  try{
    rec=await page.evaluate(async({b64,mime})=>{
      const omr=await window.__omr;
      const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
      const bin=await omr.decodeToBinary(bytes,mime);
      const score=await omr.recognizeJianpu(bin,omr.paddleOcrBackend());
      window.__app.importBytes(new TextEncoder().encode(omr.toMusicXml(score)),"omr.musicxml");
      return window.__app.getText();
    },{b64,mime});
  }catch(e){ console.log(`✗ ${song.name}: ${String(e).slice(0,100)}`); continue; }
  const gt=dec(await readFile(song.gt));
  const gV=verseNoteSeq(gt), rV=verseNoteSeq(rec);
  console.log(`\n=== ${song.name} ===`);
  for(const [v,gseq0] of gV){
    const gseq=trimSeqRepeat(gseq0), rseq=trimSeqRepeat(rV.get(v)??[]);
    // 对位只看「有字/续记号」结构: 汉字→字, ·→·。识别错字(字 vs 另一字)前后不错位→视为对位正确;
    // 只有 续记号错位(字↔·) 或 增删移位 才算对位错。
    // 末尾漏识(最后一个续记号之后的字增删)不算错位: 其后无续记号→不可能错位, 纯识别漏/多字 → 剔掉尾部裸字再比。
    const trimTail=(seq)=>{ let e=seq.length; while(e>0&&seq[e-1]!=="·") e--; return seq.slice(0,e); };
    const norm=(seq)=>trimTail(seq.map(t=>t==="·"?"·":"字"));
    const gN=norm(gseq), rN=norm(rseq);
    const a=acc(gN,rN);
    // 对位错位诊断: 找首个结构不同的音符位置
    let firstDiff=-1; const n=Math.min(gN.length,rN.length);
    for(let i=0;i<n;i++){ if(gN[i]!==rN[i]){firstDiff=i;break;} }
    const gGaps=gseq.filter(x=>x==="·").length, rGaps=rseq.filter(x=>x==="·").length;
    console.log(`  W${v}: 对位准确率 ${(a*100).toFixed(1)}%  (GT ${gseq.length}音格/识 ${rseq.length}音格, GT续记号 ${gGaps}/识 ${rGaps})`);
    if(a<1){
      const around=(seq,i)=>seq.slice(Math.max(0,i-2),i+6).join("");
      if(firstDiff>=0) console.log(`     首处对位差异 @音格${firstDiff}:  GT …${around(gseq,firstDiff)}…  识…${around(rseq,firstDiff)}…`);
      else console.log(`     长度不同(前缀一致): GT尾 …${gseq.slice(-6).join("")}  识尾 …${rseq.slice(-6).join("")}`);
    }
  }
}
await browser.close(); server.close();
