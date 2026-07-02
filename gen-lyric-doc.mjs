// 生成「简谱歌词+标点识别算法」图解 HTML：用 日光之下 跑真实管线，
// 借 window.__lyricTrace 抓每步 I/O，裁真实图片区域 + 画叠加框，产出 lyric-algo.html。
// 用法：npm run build && node gen-lyric-doc.mjs   （需本地 Edge）
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
// 可选参数：node gen-lyric-doc.mjs [图片路径] [输出html]（默认 日光之下）
const IMG = process.argv[2] || "testdata/日光之下/日光之下简谱.jpg";
const OUT = process.argv[3] || "lyric-algo.html";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".wasm": "application/wasm" };

const server = createServer(async (q, r) => { try { let p = decodeURIComponent((q.url ?? "/").split("?")[0]); if (p === "/") p = "/index.html"; const d = await readFile(join(ROOT, normalize(p))); r.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" }); r.end(d); } catch { r.writeHead(404); r.end("nf"); } });
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const jpgB64 = Buffer.from(await readFile(IMG)).toString("base64");
const data = await page.evaluate(async ({ b64 }) => {
  const omr = await window.__omr;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bin = await omr.decodeToBinary(bytes, "image/jpeg");
  const W = bin.w, H = bin.h;
  // 二值图 → 黑字白底画布
  const binCv = document.createElement("canvas"); binCv.width = W; binCv.height = H;
  const bctx = binCv.getContext("2d"); const img = bctx.createImageData(W, H);
  for (let i = 0; i < bin.data.length; i++) { const v = bin.data[i] ? 0 : 255; const p = i * 4; img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255; }
  bctx.putImageData(img, 0, 0);
  // 原图画布
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  const oCv = document.createElement("canvas"); oCv.width = W; oCv.height = H;
  oCv.getContext("2d").drawImage(bmp, 0, 0);

  const url = (cv) => cv.toDataURL("image/png");
  const scaled = (cv, tw) => { const s = tw / cv.width; const c = document.createElement("canvas"); c.width = tw; c.height = Math.round(cv.height * s); c.getContext("2d").drawImage(cv, 0, 0, c.width, c.height); return url(c); };
  // 从某画布裁 rect（原分辨率），可选叠加框
  const cropOv = (base, rect, boxes = []) => {
    const x = Math.max(0, Math.round(rect.x)), y = Math.max(0, Math.round(rect.y));
    const w = Math.min(W - x, Math.round(rect.w)), h = Math.min(H - y, Math.round(rect.h));
    const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h);
    const cx = c.getContext("2d"); cx.drawImage(base, x, y, w, h, 0, 0, w, h);
    for (const b of boxes) { cx.lineWidth = b.lw || 2; cx.strokeStyle = b.color; if (b.fill) { cx.fillStyle = b.fill; cx.fillRect(b.x - x, b.y - y, b.w, b.h); } cx.strokeRect(b.x - x + 0.5, b.y - y + 0.5, b.w, b.h);
      if (b.label) { cx.fillStyle = b.color; cx.font = "bold 20px sans-serif"; cx.fillText(b.label, b.x - x, b.y - y - 3); } }
    return { url: url(c), w, h };
  };

  window.__lyricTrace = {};
  const score = await omr.recognizeJianpu(bin, omr.paddleOcrBackend());
  const T = window.__lyricTrace;
  const xml = omr.toMusicXml(score);
  window.__app.importBytes(new TextEncoder().encode(xml), "o.musicxml");
  const words = window.__app.getText();

  // 概览
  const out = { W, H, numH: T.numH, charMin: T.charMin, orig: scaled(oCv, 1000), bin: scaled(binCv, 1000), words };

  // 每行：歌词带 + 字格叠加
  out.rows = (T.rows || []).map((row) => {
    const boxes = [];
    for (const b of row.bandBoxes) boxes.push({ ...b, color: "#2a7", fill: "rgba(34,187,119,0.12)", lw: 1 });
    const colors = ["#e33", "#39f", "#c6c", "#fa0"];
    row.verses.forEach((v) => { for (const c of v.cells) boxes.push({ ...c, color: colors[v.verse % 4], lw: 2 }); });
    const crop = { x: 0, y: row.yTop - 8, w: W, h: row.yBot - row.yTop + 16 };
    const im = cropOv(binCv, crop, boxes);
    return { rowIdx: row.rowIdx, yTop: row.yTop, yBot: row.yBot, charH: Math.round(row.charH),
      verses: row.verses.map((v) => ({ verse: v.verse, cov: +v.cov.toFixed(2), ncells: v.cells.length })),
      img: scaled_from(im, 1300) };
  });
  function scaled_from(im, tw) { if (im.w <= tw) return im.url; return { url: im.url, w: im.w }; } // 交给 CSS 缩放

  // OCR 切块条（原分辨率裁剪）+ rec 结果
  out.chunks = (T.chunks || []).map((ck, s) => {
    const im = cropOv(binCv, ck.crop, []);
    const rec = (T.recPerChunk && T.recPerChunk[s]) || [];
    return { rowIdx: ck.rowIdx, verse: ck.verse, img: im.url, w: im.w, h: im.h,
      rec: rec.map((r) => r.ch).join(""), chars: rec.map((r) => ({ ch: r.ch, xFrac: +r.xFrac.toFixed(3) })) };
  });

  out.placed = T.placed || {};
  // 对齐：每行 note→lyric
  out.aligned = T.aligned || {};
  return out;
}, { b64: jpgB64 });

await browser.close(); server.close();

// ---- 组装 HTML ----
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const verseName = (k) => { const [r, v] = k.split(":"); return `行${+r + 1} · W${+v + 1}`; };

function wordsSection() {
  const lines = data.words.split(/\r?\n/); let inW = false; const buf = [];
  for (const ln of lines) { const t = ln.trim(); if (t.startsWith(".")) { inW = /^\.words/i.test(t); if (inW) buf.push(".Words"); continue; } if (inW) buf.push(ln); }
  return esc(buf.join("\n"));
}

let html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>简谱歌词+标点识别算法图解 — 日光之下</title>
<style>
 body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;max-width:1360px;margin:0 auto;padding:24px;color:#222}
 h1{font-size:26px} h2{margin-top:40px;border-bottom:2px solid #39f;padding-bottom:6px;color:#136}
 h3{margin-top:24px;color:#345}
 .muted{color:#777} code{background:#f2f4f7;padding:1px 5px;border-radius:4px}
 img{max-width:100%;border:1px solid #ddd;border-radius:4px;vertical-align:top}
 .row-img{max-width:100%}
 table{border-collapse:collapse;margin:10px 0;font-size:13px} th,td{border:1px solid #ccc;padding:3px 8px;text-align:center}
 th{background:#f0f4f8}
 .strip{display:inline-block;margin:6px 10px 6px 0;vertical-align:top;text-align:center}
 .strip img{display:block;background:#fff;max-height:56px}
 .strip .t{font-size:15px;margin-top:3px;font-weight:bold;color:#136}
 .cand{display:inline-block;margin:6px;text-align:center} .cand img{display:block;max-height:120px}
 .box{background:#f7f9fc;border:1px solid #e0e6ee;border-radius:6px;padding:12px 16px;margin:12px 0}
 pre{background:#1e2530;color:#e6edf3;padding:14px;border-radius:6px;overflow:auto;font-size:13px;line-height:1.5}
 .lg{font-size:18px;letter-spacing:1px}
 .miss{color:#c00;font-weight:bold} .ok{color:#080}
 .legend span{display:inline-block;margin-right:14px} .sw{display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:middle;margin-right:4px}
</style></head><body>
<h1>简谱歌词 + 标点识别算法图解</h1>
<p class="muted">示例：<code>testdata/日光之下/日光之下简谱.jpg</code>（${data.W}×${data.H}）。全流程由真实管线 <code>recognizeLyrics</code> 跑出，各步 I/O 经 <code>globalThis.__lyricTrace</code> 抓取。字号基准 <code>numH=${data.numH}</code>、歌词字号下限 <code>charMin=${Math.round(data.charMin)}</code>。</p>

<h2>Step 0 · 输入：原图 → 二值图</h2>
<p>先 <code>decodeToBinary</code>（通道自适应 + Sauvola 局部阈值）得 1=前景的二值图，后续所有几何都在二值图上做。</p>
<div style="display:flex;gap:12px;flex-wrap:wrap">
 <div><div class="muted">原图</div><img src="${data.orig}" style="width:640px"></div>
 <div><div class="muted">二值图</div><img src="${data.bin}" style="width:640px"></div>
</div>

<h2>Step 1–2 · 全局斜率错切 + 定位歌词带 + 切 verse 行 + 投影分字</h2>
<p class="legend">
 <span><span class="sw" style="background:rgba(34,187,119,.5)"></span>歌词带连通块 (band, h≥charMin)</span>
 <span><span class="sw" style="background:#e33"></span>W1 字块</span>
 <span><span class="sw" style="background:#39f"></span>W2 字块</span>
</p>
<p>先用各谱行「最左 vs 最右音符」算全局斜率 k=${data.slope?.toFixed?.(4) ?? data.slope}（deslant-y=y-k·x，斜线拉平）。每个乐谱行下方取歌词带 → band 连通块按 deslant-y 聚成 verse 行 → 逐行做<b>斜率感知的列投影</b>分字（相邻墨 run 按偏旁内间隙并成字块，<b>粘连字整体不切</b>，长空白＝分块边界）。字宽由投影统计（charW≈${data.charW}）。下面每张图是一个乐谱行的歌词带（绿=band 块，红/蓝=W1/W2 投影字块）：</p>`;

for (const row of data.rows) {
  const imgSrc = typeof row.img === "string" ? row.img : row.img.url;
  html += `<h3>乐谱行 ${row.rowIdx + 1}（band y∈[${row.yTop}, ${row.yBot}]，charH=${row.charH}）</h3>
   <img class="row-img" src="${imgSrc}">
   <table><tr><th>verse</th><th>覆盖率 cov</th><th>字格数</th></tr>
   ${row.verses.map((v) => `<tr><td>W${v.verse + 1}</td><td>${v.cov}</td><td>${v.ncells}</td></tr>`).join("")}</table>`;
}

html += `<h2>Step 3 · 切块 → 裁自然连续区域 → 整块 OCR</h2>
<p>字块先在<b>长空白边界</b>（多在标点后）断成段，各段再按宽度切成 ≤300px（≈5 字）块；每块裁源图上那段<b>自然连续区域</b>（保留原字间距、不重拼），缩到高 48px 送 PaddleOCR。下面是<b>实际送识别的每个条子</b>及其 rec 输出：</p>
<div>`;
let curRV = "";
for (const ck of data.chunks) {
  const rv = `${ck.rowIdx}:${ck.verse}`;
  if (rv !== curRV) { curRV = rv; html += `<div style="margin-top:14px;font-weight:bold;color:#345">${verseName(rv)}</div>`; }
  html += `<div class="strip"><img src="${ck.img}"><div class="t">${esc(ck.rec)}</div></div>`;
}
html += `</div>`;

// 每条 verse 行拼出的音节串（标点已由投影+OCR 直接读出、折全角）
html += `<h3>各 verse 行识别音节串</h3><table><tr><th>行</th><th>音节串</th></tr>`;
for (const k of Object.keys(data.placed)) {
  const s = (data.placed[k] || []).map((p) => p.ch).join("");
  html += `<tr><td>${verseName(k)}</td><td style="text-align:left" class="lg">${esc(s)}</td></tr>`;
}
html += `</table>`;

// 对齐
html += `<h2>Step 4 · 音节 → 源图 x → 音符对齐</h2>
<p>每个音节按源图 x 单调最近分配给音符（melisma → 某些音符无字）。下表每条 verse 行列出各音符落到的歌词（空=melisma 延续）：</p>`;
for (const k of Object.keys(data.aligned)) {
  const arr = data.aligned[k];
  html += `<h3>${verseName(k)}</h3><table><tr><th>音符#</th>${arr.map((_, i) => `<td>${i + 1}</td>`).join("")}</tr>
   <tr><th>歌词</th>${arr.map((a) => `<td class="lg">${esc(a.lyric) || "·"}</td>`).join("")}</tr></table>`;
}

html += `<h2>最终输出 · <code>.Words</code></h2><pre>${wordsSection()}</pre>
</body></html>`;

await writeFile(OUT, html);
console.log("已生成", OUT, `(${(html.length / 1024).toFixed(0)}KB, 含 ${data.chunks.length} 个 OCR 条)`);
