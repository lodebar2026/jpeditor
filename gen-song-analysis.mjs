// 简谱 OMR「按歌谱」全流程分析 HTML（参考 gen-lyric-doc.mjs）：对**单个**歌谱跑真实管线，
// 借 window.__lyricTrace 抓歌词各步 I/O，并把识别数字/歌词与 GT(.jpwabc) 对齐标出误读，逐步解释：
//   原图→二值图 → 音符(逐格数字 rec，vs GT) → 歌词(切块压缩→48px二值条→整块 rec，含「祂」等)。
// 用法：npm run build && node gen-song-analysis.mjs <歌谱名> [out.html]   （需本地 Edge，建议工作树为 v6 构建）
//   <歌谱名> 为 testdata/ 下歌谱目录名（可子串匹配）；命中多个取第一个。缺省时列出可选歌谱。
import { createServer } from "node:http";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const TESTDATA = join(process.cwd(), "testdata");
const FILTER = process.argv[2] || "";
const MIME = { ".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".woff2":"font/woff2",".svg":"image/svg+xml",".wasm":"application/wasm" };

function decodeJpwabc(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return Buffer.from(buf.slice(2)).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) { const s = Buffer.from(buf.slice(2)); s.swap16(); return s.toString("utf16le"); }
  return buf.toString("utf8");
}
// GT .Voice 里的数字序列（0-7，按出现序；用于与识别逐格对齐）
function gtDigits(text) {
  const outD = []; let inV = false;
  for (const ln of text.split(/\r?\n/)) {
    const t = ln.trim();
    if (t.startsWith(".")) { inV = /^\.voice/i.test(t); continue; }
    if (!inV || !t) continue;
    const s = ln.replace(/\$\([^)]*\)/g, " ");
    for (const m of s.matchAll(/[0-7]/g)) outD.push(+m[0]);
  }
  return outD;
}

async function findSongs(filter) {
  const out = [];
  for (const d of (await readdir(TESTDATA, { withFileTypes: true })).filter(d => d.isDirectory())) {
    if (filter && !d.name.includes(filter)) continue;
    const files = await readdir(join(TESTDATA, d.name));
    const img = files.find(f => /\.(jpg|jpeg|png)$/i.test(f)) || files.find(f => /\.pdf$/i.test(f));
    const gt = files.find(f => /\.jpwabc$/i.test(f));
    if (img && gt) out.push({ name: d.name, img: join(TESTDATA, d.name, img), gt: join(TESTDATA, d.name, gt) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

// 单个歌谱：必须给歌谱名。缺省或未命中 → 列出可选歌谱并退出。
const all = await findSongs("");
if (!FILTER) { console.log("用法：node gen-song-analysis.mjs <歌谱名> [out.html]\n可选歌谱：\n  " + all.map(s => s.name).join("\n  ")); process.exit(1); }
const song = (await findSongs(FILTER))[0];
if (!song) { console.log(`未找到匹配「${FILTER}」的歌谱。可选：\n  ` + all.map(s => s.name).join("\n  ")); process.exit(1); }
const OUT = process.argv[3] || `omr-analysis-${song.name}.html`;

const server = createServer(async (q,r)=>{try{let p=decodeURIComponent((q.url??"/").split("?")[0]);if(p==="/")p="/index.html";const d=await readFile(join(ROOT,normalize(p)));r.writeHead(200,{"content-type":MIME[extname(p)]??"application/octet-stream"});r.end(d);}catch{r.writeHead(404);r.end("nf");}});
await new Promise(r=>server.listen(0,r));
const port=server.address().port;
const browser=await chromium.launch({channel:"msedge",headless:true});
const page=await browser.newPage({viewport:{width:1400,height:1000}}); await page.goto(`http://localhost:${port}/`,{waitUntil:"networkidle"}); await page.waitForTimeout(400);

const data = [];
{
  const b64=Buffer.from(await readFile(song.img)).toString("base64");
  const mime = song.img.toLowerCase().endsWith(".pdf")?"application/pdf":"image/jpeg";
  const gd = gtDigits(decodeJpwabc(await readFile(song.gt)));
  const d = await page.evaluate(async({b64,mime,gd})=>{
    const omr=await window.__omr;const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
    const bin=await omr.decodeToBinary(bytes,mime);const W=bin.w,H=bin.h;
    const bcv=document.createElement("canvas");bcv.width=W;bcv.height=H;const bx=bcv.getContext("2d");const bim=bx.createImageData(W,H);
    for(let i=0;i<bin.data.length;i++){const v=bin.data[i]?0:255;const p=i*4;bim.data[p]=bim.data[p+1]=bim.data[p+2]=v;bim.data[p+3]=255;}
    bx.putImageData(bim,0,0);
    let ocv=bcv, sx=1, sy=1, hasOrig=false;
    try{const bmp=await createImageBitmap(new Blob([bytes],{type:mime}));ocv=document.createElement("canvas");ocv.width=bmp.width;ocv.height=bmp.height;ocv.getContext("2d").drawImage(bmp,0,0);sx=bmp.width/W;sy=bmp.height/H;hasOrig=true;}catch{}
    const url=c=>c.toDataURL("image/png");
    const scaled=(cv,tw)=>{const s=tw/cv.width;const c=document.createElement("canvas");c.width=tw;c.height=Math.round(cv.height*s);const g=c.getContext("2d");g.imageSmoothingEnabled=false;g.drawImage(cv,0,0,c.width,c.height);return url(c);};
    const crop=(src,x,y,w,h,dw,dh,SC)=>{const c=document.createElement("canvas");c.width=Math.max(1,Math.round(w*SC));c.height=Math.max(1,Math.round(h*SC));const g=c.getContext("2d");g.imageSmoothingEnabled=false;g.drawImage(src,x,y,dw,dh,0,0,c.width,c.height);return url(c);};

    window.__lyricTrace={};
    const score=await omr.recognizeJianpu(bin,omr.paddleOcrBackend());
    const T=window.__lyricTrace;

    // ---- 逐格数字 vs GT 对齐（Levenshtein 回溯，数字值序列） ----
    const flat=[]; score.rows.forEach((r,ri)=>r.nums.forEach((n,ci)=>flat.push({ri,ci,digit:n.digit,bbox:n.bbox})));
    const rec=flat.map(f=>f.digit), m=rec.length, n=gd.length;
    const dp=Array.from({length:m+1},()=>new Int32Array(n+1));
    for(let i=0;i<=m;i++)dp[i][0]=i; for(let j=0;j<=n;j++)dp[0][j]=j;
    for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(rec[i-1]===gd[j-1]?0:1));
    const errIdx=new Map(); // flatIndex -> gt digit（替换）；插入(识别多出)标 -1
    let i=m,j=n;
    while(i>0&&j>0){
      if(rec[i-1]===gd[j-1]&&dp[i][j]===dp[i-1][j-1]){i--;j--;}
      else if(dp[i][j]===dp[i-1][j-1]+1){errIdx.set(i-1,gd[j-1]);i--;j--;}      // 替换
      else if(dp[i][j]===dp[i-1][j]+1){errIdx.set(i-1,-1);i--;}                 // 识别多(插入)
      else{j--;}                                                                // 识别漏(删除)
    }
    while(i>0){errIdx.set(i-1,-1);i--;}
    const editDist=dp[m][n];

    // ---- 每行：note-band 二值条 + 数字表 + 误读格放大(orig/bin) ----
    const rows=score.rows.map((r,ri)=>{
      if(!r.nums.length) return {ri,empty:true};
      const y0=Math.max(0,Math.min(...r.nums.map(x=>x.bbox.y))-12),y1=Math.min(H,Math.max(...r.nums.map(x=>x.bbox.y+x.bbox.h))+12),rh=y1-y0;
      const bandBin=crop(bcv,0,y0,W,rh,W,rh,1.3);
      const cells=r.nums.map((nn,ci)=>{
        const fi=flat.findIndex(f=>f.ri===ri&&f.ci===ci);
        const err=errIdx.has(fi); const gtv=err?errIdx.get(fi):null;
        const c={ci,digit:nn.digit,err,gt:gtv};
        if(err){const bb=nn.bbox,pad=5,SC=9,cx=Math.max(0,bb.x-pad),cy=Math.max(0,bb.y-pad),cw=Math.min(W-cx,bb.w+2*pad),ch=Math.min(H-cy,bb.h+2*pad);
          c.bin=crop(bcv,cx,cy,cw,ch,cw,ch,SC); if(hasOrig)c.orig=crop(ocv,cx*sx,cy*sy,cw,ch,cw*sx,ch*sy,SC);}
        return c;
      });
      return {ri,bandBin,cells};
    });

    // ---- 歌词条：全部列出，标注含 祂/他/她 者 ----
    const strips=(T.chunks||[]).map((ck,s)=>{
      const r=(T.recPerChunk&&T.recPerChunk[s])||[]; const recStr=r.map(x=>x.ch).join("");
      const strip=omr.buildStrip(bcv,ck.cells,48,ck.maxGap);const t=document.createElement("canvas");t.width=strip.width;t.height=strip.height;t.getContext("2d").drawImage(strip,0,0);
      const x0=Math.min(...ck.cells.map(c=>c.x)),x1=Math.max(...ck.cells.map(c=>c.x+c.w)),cy0=Math.min(...ck.cells.map(c=>c.y)),cy1=Math.max(...ck.cells.map(c=>c.y+c.h));
      const ow=x1-x0,oh=cy1-cy0,pad=4; const orig=hasOrig?crop(ocv,(x0-pad)*sx,(cy0-pad)*sy,ow+2*pad,oh+2*pad,(ow+2*pad)*sx,(oh+2*pad)*sy,2):null;
      return {rowIdx:ck.rowIdx,verse:ck.verse,rec:recStr,strip:url(t),orig,ta:/[祂他她]/.test(recStr)};
    });

    return {W,H,hasOrig,orig:hasOrig?scaled(ocv,900):null,bin:scaled(bcv,900),
      recCount:m,gtCount:n,editDist,noteAcc:1-editDist/Math.max(m,n,1),rows,strips};
  },{b64,mime,gd});
  data.push({name:song.name, isPdf:mime==="application/pdf", ...d});
  console.log(`  ${song.name}: 音符 ${(d.noteAcc*100).toFixed(1)}% (识别${d.recCount}/GT${d.gtCount}, 编辑距离${d.editDist}), 歌词条${d.strips.length}`);
}
await browser.close(); server.close();

// ---------- 组装 HTML ----------
const esc=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const taSub=s=>esc(s).replace(/他/g,'<span class="ta-err">他</span>').replace(/[祂祢]/g,c=>`<span class="ta-ok">${c}</span>`);

let html=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>简谱 OMR 全流程分析 · ${esc(song.name)}</title>
<style>
 body{font:15px/1.75 -apple-system,"PingFang SC",sans-serif;max-width:1180px;margin:0 auto;padding:24px;color:#1a1a1a}
 h1{font-size:25px} h2{margin-top:44px;border-bottom:2px solid #39f;padding-bottom:6px;color:#136}
 h3{margin-top:26px;color:#345} h4{margin:18px 0 6px;color:#456}
 .muted{color:#777} code{background:#f2f4f7;padding:1px 5px;border-radius:4px}
 nav{background:#f7f9fc;border:1px solid #e0e6ee;border-radius:8px;padding:12px 18px;margin:16px 0}
 nav a{margin-right:16px;font-weight:bold}
 .flow{background:#eef6ff;border-left:4px solid #39f;padding:10px 16px;border-radius:0 6px 6px 0;margin:12px 0}
 .two{display:flex;gap:14px;flex-wrap:wrap}
 .two .col{flex:1;min-width:340px} .two img{width:100%;border:1px solid #ddd;border-radius:4px;background:#fff}
 .band img{width:100%;image-rendering:pixelated;border:1px solid #ddd;background:#fff;margin:4px 0}
 .digits{font-family:ui-monospace,monospace;font-size:15px;line-height:2;word-break:break-all}
 .digits .e{color:#e11;font-weight:bold;background:#fde;padding:0 3px;border-radius:3px}
 .errbox{background:#fff5f5;border:1px solid #f3c;border-radius:8px;padding:12px 16px;margin:14px 0}
 .grid{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-end;margin:8px 0}
 .cell{text-align:center} .cell img{display:block;border:1px solid #ccc;background:#fff;image-rendering:pixelated;max-width:200px} .cell .cap{font-size:12px;color:#666;margin-top:3px}
 .ta-ok{color:#080;font-weight:bold} .ta-err{color:#e11;font-weight:bold}
 .strips{display:flex;flex-wrap:wrap;gap:6px 12px;margin:8px 0}
 .strip{display:inline-block;text-align:center} .strip img{display:block;background:#fff;max-height:52px;border:1px solid #eee}
 .strip.ta{outline:2px solid #2a7;border-radius:4px;padding:2px}
 .strip .t{font-size:14px;font-weight:bold;color:#136;margin-top:2px}
 .stat{font-size:15px} .stat b{font-size:18px}
 table.sum{border-collapse:collapse;margin:10px 0;font-size:14px} .sum th,.sum td{border:1px solid #ccc;padding:4px 10px;text-align:center} .sum th{background:#f0f4f8}
</style></head><body>
<h1>简谱 OMR 全流程分析 · ${esc(song.name)}</h1>
<div class="flow"><b>识别管线</b>（<code>src/omr/</code>，PaddleOCR PP-OCRv6_small rec，onnxruntime 本地推理）：<br>
① <code>decodeToBinary</code> 原图→二值图（通道自适应 + Sauvola 局部阈值）→
② <code>recognizeJianpu</code> 连通域/几何启发式切出<b>数字格</b>，逐格 rec→CTC 取 0-7（0=休止）；同时数下划线(减时)/增时线/八度点 →
③ <code>recognizeLyrics</code> 乐谱行下方歌词带切字格→均匀切块→压缩过宽字距→缩 48px <b>二值条</b>整块 rec →
④ 音节按源图 x 单调最近对齐到音符 → <code>toMusicXml</code> → 排版。<br>
下面：<b>原图/二值图</b> → <b>逐格数字（与 GT 对齐，<span class="ta-err">红=误读</span>）</b> → <b>歌词条（<span class="ta-ok">绿框=含祂/他</span>）</b>。</div>`;

for (const d of data) {
  html+=`<h2 id="s-${encodeURIComponent(d.name)}">${esc(d.name)}</h2>
  <p class="stat">尺寸 ${d.W}×${d.H}${d.isPdf?"（PDF 抽内嵌位图）":""} ｜ 音符 <b>${(d.noteAcc*100).toFixed(1)}%</b>（识别 ${d.recCount} 格 / GT ${d.gtCount}，编辑距离 ${d.editDist}）｜ 歌词条 ${d.strips.length} 个${d.strips.some(s=>s.ta)?`，其中含祂/他 ${d.strips.filter(s=>s.ta).length} 个`:""}</p>`;

  html+=`<h3>Step 0 · 原图 → 二值图</h3>
  <p class="muted"><code>decodeToBinary</code>：Sauvola 局部阈值二值化，后续所有几何与 OCR 都在二值图上做。二值化是<b>误读的主要来源</b>——过粗糊死、淡印打碎都发生在这一步。</p>
  <div class="two"><div class="col"><div class="muted">${d.hasOrig?"原图":"（PDF 无彩色原图）"}</div>${d.orig?`<img src="${d.orig}">`:""}</div>
   <div class="col"><div class="muted">二值图</div><img src="${d.bin}"></div></div>`;

  html+=`<h3>Step 1–2 · 音符：逐格数字 rec（与 GT 对齐）</h3>
  <p class="muted">连通域切出数字格，每格缩放送 rec→CTC 取 0-7。下面逐乐谱行：二值 note-band + 识别数字串（<span class="digits"><span class="e">红底</span></span>=与 GT 不符），误读格给出<b>原图/二值放大对照</b>。</p>`;
  const errRows=[];
  for (const r of d.rows) {
    if (r.empty) continue;
    const seq=r.cells.map(c=>c.err?`<span class="e" title="GT=${c.gt===-1?'(多识)':c.gt}">${c.digit}</span>`:c.digit).join(" ");
    html+=`<div class="band"><h4>乐谱行 ${r.ri+1}</h4><img src="${r.bandBin}"><div class="digits">${seq}</div></div>`;
    for (const c of r.cells) if (c.err && c.gt!==-1) errRows.push({ri:r.ri,ci:c.ci,...c});
  }
  if (!errRows.length) html+=`<p class="ta-ok">✓ 本曲数字与 GT 完全一致（除对齐容差）。</p>`;
  for (const c of errRows) {
    html+=`<div class="errbox"><b>行${c.ri+1} 第${c.ci+1}格：</b>GT=<span class="ta-ok">${c.gt}</span> → 识别成 <span class="ta-err">${c.digit}</span>
      <div class="grid">${c.orig?`<div class="cell"><img src="${c.orig}"><div class="cap">原图（9×）</div></div>`:""}
        <div class="cell"><img src="${c.bin}"><div class="cap">二值图 = OCR 实际输入（9×）</div></div></div></div>`;
  }

  html+=`<h3>Step 3 · 歌词：切块 → 压缩字距 → 48px 二值条整块 rec</h3>
  <p class="muted">歌词带切字格后均匀切块，块内把过宽字间空白压到 ≈0.35 字宽，缩到 48px 高送 PaddleOCR（多字上下文远比逐字准）。<span class="ta-ok">绿框</span>=含「祂/他」条子（第三人称神，赞美诗常用）。</p>
  <div class="strips">${d.strips.map(s=>`<div class="strip${s.ta?" ta":""}" title="行${s.rowIdx+1} W${s.verse+1}"><img src="${s.strip}"><div class="t">${taSub(s.rec)}</div></div>`).join("")}</div>`;
  const tas=d.strips.filter(s=>s.ta&&s.orig);
  if (tas.length) {
    html+=`<h4>含「祂/他」条子 · 原图区域 vs 48px 二值条</h4>`;
    for (const s of tas) html+=`<div class="grid">
      <div class="cell strip"><img src="${s.orig}" style="max-height:70px"><div class="cap">原图区域</div></div>
      <div class="cell strip"><img src="${s.strip}" style="max-height:70px"><div class="cap">送 OCR 的 48px 二值条</div></div>
      <div class="cell" style="text-align:left"><div class="cap">行${s.rowIdx+1} · W${s.verse+1}</div><div class="digits">${taSub(s.rec)}</div></div></div>`;
  }
}
html+=`</body></html>`;
await writeFile(OUT, html);
console.log("已生成", OUT, `(${(html.length/1024).toFixed(0)}KB, ${data.length} 首)`);
