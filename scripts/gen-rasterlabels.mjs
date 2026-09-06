// 声部标签的 OCR 缓存：把全语料的标签条跑一遍 PP-OCR，按**条的内容指纹**落盘。
//
//   npm run build && npm run build:cli && node scripts/gen-rasterlabels.mjs
//   node scripts/gen-rasterlabels.mjs --one=破碎
//
// 产物：src/rasteromr/rasterlabels.json（`{ 指纹: "Soprano 1" }`）
//
// 与 `gen-rasterlyrics.mjs` 是同一套架构（条子从 `recognizeRasterPage` 出、
// 按内容指纹寻址、只在这里起浏览器），判据全在 `src/rasteromr/stafflabel.ts`。
// **别在这里另切一份条**——歌词那条路上复制第二份流程的教训见那个脚本的注。
//
// 为什么要标签：跨系统连接的全局指派（`staffomr/score.ts::assignSlots`）靠
// 「谱号 + 有没有词 + 音域中位数」定谱行身份，而合唱谱的人声行前两样全一样、
// 音域又跨段落整体挪（破碎 3 行系统的女高唱 31~32、7 行系统里同一声部唱到 36）。
// 标签是唯一分得开的证据。试过「不认字、只比标签图」，签名分不开
// `Soprano` / `Soprano 1` / `Soprano 2`，见 `stafflabel.ts` 的说明。
import { readFile, writeFile } from "node:fs/promises";
import { serveDist, launchPage } from "./harness.mjs";
import { openPdf, eachPage, loadCli, loadChorus } from "./node-harness.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const only = argOf("one");
const DICT = "src/rasteromr/rasterlabels.json";

const cli = await loadCli();
const look = new cli.RasterGlyphLookup(JSON.parse(await readFile("src/rasteromr/rasterglyphs.json", "utf8")));
// 与识别用同一份模板，否则认领差异会改变条的指纹
look.templates = cli.outlineTemplates(JSON.parse(await readFile("src/staffomr/glyphmap.json", "utf8")));
let cache = {};
try {
  cache = JSON.parse(await readFile(DICT, "utf8"));
} catch {
  /* 第一次跑 */
}

/** 收齐所有标签条：裸像素 + 指纹。已经在缓存里的不再送 OCR。 */
const strips = [];
const seen = new Set();
let total = 0;
const t0 = Date.now();
for (const song of await loadChorus()) {
  if (only && !song.name.includes(only)) continue;
  for (const pdf of song.pdfs) {
    const { doc, OPS } = await openPdf(pdf);
    let n = 0;
    await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
      const r = await cli.recognizeRasterPage(page, OPS, look, pn, {});
      if (!r.hasStaff || !r.raster) return;
      for (const strip of r.labelStrips) {
        total++;
        const key = cli.labelKey(strip);
        if (cache[key] || seen.has(key)) continue;
        seen.add(key);
        const px = [];
        for (let y = 0; y < strip.h; y++) {
          let s0 = "";
          for (let x = 0; x < strip.w; x++) s0 += strip.data[y * strip.w + x] ? "1" : "0";
          px.push(s0);
        }
        strips.push({ key, w: strip.w, h: strip.h, px });
        n++;
      }
    });
    if (n) console.log(`${song.name}/${pdf.split("/").pop()}  新标签条 ${n}`);
  }
}
console.log(`标签条 ${total}（缓存已有 ${total - strips.length}，要跑 ${strips.length}），${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!strips.length) {
  console.log("没有新条要跑。");
  process.exit(0);
}

// ── 送 OCR ──────────────────────────────────────────────────────────────────
const { port, close } = await serveDist("dist");
const { page, browser } = await launchPage({ quiet: true });
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__omr, null, { timeout: 60000 });

const t1 = Date.now();
const BATCH = 24;
let done = 0;
for (let i = 0; i < strips.length; i += BATCH) {
  const chunk = strips.slice(i, i + BATCH);
  const got = await page.evaluate(async (list) => {
    const omr = await window.__omr;
    window.__ocr ??= omr.paddleOcrBackend();
    const canvases = list.map((it) => {
      // PP-OCR 的 rec 吃 48 高的图；白底黑字。
      // 试过四周留白边（`PAD = 6`，想着 PP-OCR 的 rec 吃「字周围有空白」的图），
      // **更差**：认得出声部名的条从 8 个掉到 4 个。照歌词那条路原样拉满。
      const H = 48;
      const s = H / it.h;
      const W = Math.max(8, Math.round(it.w * s));
      const cv = new OffscreenCanvas(W, H);
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      const src = new OffscreenCanvas(it.w, it.h);
      const sc = src.getContext("2d");
      const img = sc.createImageData(it.w, it.h);
      for (let y = 0; y < it.h; y++) {
        const row = it.px[y];
        for (let x = 0; x < it.w; x++) {
          const p = (y * it.w + x) * 4;
          const v = row[x] === "1" ? 0 : 255;
          img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
          img.data[p + 3] = 255;
        }
      }
      sc.putImageData(img, 0, 0);
      ctx.drawImage(src, 0, 0, W, H);
      return cv;
    });
    return await window.__ocr.recognizeTextsPos(canvases);
  }, chunk);
  got.forEach((chars, k) => {
    // 标签只要**整串文本**（`normalizeLabel` 再归一），不必逐字的 x
    cache[chunk[k].key] = chars.map((c) => c.ch).join("");
    done++;
  });
  if ((i / BATCH) % 5 === 0) process.stdout.write(`\r  ${Math.min(i + BATCH, strips.length)}/${strips.length}…`);
}
process.stdout.write("\r");
console.log(`OCR 用时 ${((Date.now() - t1) / 1000).toFixed(1)}s，跑完 ${done} 条`);
await browser.close();
close();

await writeFile(DICT, JSON.stringify(cache));
const named = Object.values(cache).filter((t) => cli.normalizeLabel(t)).length;
console.log(`→ ${DICT}（共 ${Object.keys(cache).length} 条，其中认得出声部名的 ${named} 条）`);
