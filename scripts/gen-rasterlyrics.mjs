// 位图歌词的 OCR 缓存：把全语料的歌词条跑一遍 PP-OCR，按**条的内容指纹**落盘。
//
//   npm run build && npm run build:cli && node scripts/gen-rasterlyrics.mjs
//   node scripts/gen-rasterlyrics.mjs --one=宁静
//
// 产物：src/rasteromr/rasterlyrics.json（`{ 指纹: [{ch, xFrac}, …] }`）
//
// **不做形状聚类、直接用 OCR 的文本。** 聚类那一版（字格 → 32×32 签名 → 每类投票
// 定字）实测把四成多的字格丢在「类里投不出过半票」上：5985 个字格聚成 1866 类，
// 只定下 969 类、覆盖 52%，歌词 35%。门槛往松扫更差（并错字、票更散），
// 往紧扫也只到 58.7% 覆盖——聚类这一步本身就是净损耗。
//
// 按内容寻址而不是按「第几页第几行」：几何判据一动，行的编号就全变了，
// 按位置存的缓存整份作废；按内容存的只要那一条的像素没变就还能用。
//
// **这是位图路里唯一要起浏览器的步骤**（PaddleOCR 走 onnxruntime-web）。
// 跑完产物落盘，之后的识别命中缓存，仍然不起浏览器——照 `gen-staffocr.mjs` 的账。
//
// **整行送 OCR，不逐格送**：PP-OCR 的 rec 是序列模型，一整条歌词的上下文能把
// 单字认不准的救回来；`recognizeTextsPos` 顺带给出每个字在条内的 x，按 x 映回字格。
import { readFile, writeFile } from "node:fs/promises";
import { serveDist, launchPage } from "./harness.mjs";
import { openPdf, eachPage, loadCli, loadChorus } from "./node-harness.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const only = argOf("one");
const DICT = "src/rasteromr/rasterlyrics.json";

const cli = await loadCli();
const look = new cli.RasterGlyphLookup(JSON.parse(await readFile("src/rasteromr/rasterglyphs.json", "utf8")));
// 已有的缓存留住：重跑只补新出现的条（几何一动指纹就变，旧条自然失效）
let cache = {};
try {
  cache = JSON.parse(await readFile(DICT, "utf8"));
} catch {
  /* 第一次跑 */
}

/** 收齐所有歌词条：裸像素 + 指纹。已经在缓存里的不再送 OCR。 */
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
      // **与识别走同一条路**：条子直接从 `recognizeRasterPage` 拿。
      // 这里原来自己复制了一份流程（另一套 `findStaffLines`/`findBlobs`/`findLyricRows`），
      // 识别那边一改判据两边就对不上、指纹全变、缓存整份落空
      // ——实测歌词从 85.0% 掉到 42.7%，还查了半天。别再复制第二份。
      const r = await cli.recognizeRasterPage(page, OPS, look, pn, {});
      if (!r.hasStaff || !r.raster) return;
      // 只收干净位图那一档（按底本形态，与 `chorus-diff` 同口径）
      if (r.raster.kind !== "mask") return;
      for (const strip of r.lyricStrips) {
        total++;
        const key = cli.stripKey(strip);
        if (cache[key] || seen.has(key)) continue;
        seen.add(key);
        // 送进浏览器的只能是可序列化的东西
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
    if (n) console.log(`${song.name}/${pdf.split("/").pop()}  新歌词条 ${n}`);
  }
}
console.log(`歌词条 ${total}（缓存已有 ${total - strips.length}，要跑 ${strips.length}），${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
    // **直接存 OCR 的结果**，字符与它在条内的 x。映到字格是识别时的事
    // （`mapCharsToCells`，两边共用一份实现）。
    cache[chunk[k].key] = chars.map((c) => ({ ch: c.ch, xFrac: c.xFrac }));
    done++;
  });
  if ((i / BATCH) % 5 === 0) process.stdout.write(`\r  ${Math.min(i + BATCH, strips.length)}/${strips.length}…`);
}
process.stdout.write("\r");
console.log(`OCR 用时 ${((Date.now() - t1) / 1000).toFixed(1)}s，跑完 ${done} 条`);
await browser.close();
close();

await writeFile(DICT, JSON.stringify(cache));
const chars = Object.values(cache).reduce((a, v) => a + v.length, 0);
console.log(`→ ${DICT}：${Object.keys(cache).length} 条，${chars} 个字符`);
