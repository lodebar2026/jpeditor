// 字形字典的 OCR 兜底：GT 语料自举完之后仍未定字符的形状类，**每类送一次 OCR**。
//
// 为什么还需要它：自举只能标出 GT 里出现过的字。目录页的曲名首句、首句索引、
// 花边框里的注解正文都没有 GT，字典盖不到（约 2550 类 / 19000 个实例）。
//
// 「每类只送一次」是这条路划算的关键——两万个实例只要跑两千多次推理。
//
// 这是矢量路里**唯一要起浏览器的建库步骤**（PaddleOCR 走 onnxruntime-web）。
// 跑完产物落盘，之后的识别与对比仍然是纯查表、不碰 OCR。
//
//   npm run build && npm run build:cli && node gen-glyphdict.mjs && node gen-glyphocr.mjs
//   node gen-glyphocr.mjs --min=2      # 只补实例数 ≥2 的类（默认 1，即全补）
import { readFile, writeFile } from "node:fs/promises";
import { serveDist, launchPage } from "./scripts/harness.mjs";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
);
const MIN = Number(flags.min ?? 1);
const DICT = "testdata/500/glyphdict.json";

const dict = JSON.parse(await readFile(DICT, "utf8"));
const todo = Object.values(dict.classes).filter((c) => !c.char && c.d && c.bbox && c.count >= MIN);
console.log(`未定形状类 ${Object.values(dict.classes).filter((c) => !c.char).length}，本次送 OCR ${todo.length}（实例 ${todo.reduce((a, c) => a + c.count, 0)}）`);
if (!todo.length) process.exit(0);

const { port, close } = await serveDist("dist");
const { page, browser } = await launchPage({ quiet: true });
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__omr, null, { timeout: 60000 });

const t0 = Date.now();
const BATCH = 64;
const results = [];
for (let i = 0; i < todo.length; i += BATCH) {
  const chunk = todo.slice(i, i + BATCH).map((c) => ({ key: c.key, d: c.d, bbox: c.bbox }));
  const got = await page.evaluate(async (items) => {
    const omr = await window.__omr;
    window.__ocr ??= omr.paddleOcrBackend();
    const ocr = window.__ocr;
    const canvases = items.map((it) => {
      // PaddleOCR rec 吃 48 高的图。字形是白底黑字、居中、留一圈边。
      const cv = new OffscreenCanvas(48, 48);
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 48, 48);
      const [x0, y0, x1, y1] = it.bbox;
      const w = Math.max(x1 - x0, 0.1);
      const h = Math.max(y1 - y0, 0.1);
      const s = Math.min(38 / w, 38 / h);
      ctx.translate(24, 24);
      ctx.scale(s, -s); // PDF 的 y 轴朝上，canvas 朝下
      ctx.translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
      ctx.fillStyle = "#000";
      ctx.fill(new Path2D(it.d));
      return cv;
    });
    return await ocr.recognizeTexts(canvases);
  }, chunk);
  got.forEach((text, k) => results.push({ key: chunk[k].key, text }));
  if ((i / BATCH) % 5 === 0) process.stdout.write(`\r  ${Math.min(i + BATCH, todo.length)}/${todo.length}…`);
}
process.stdout.write("\r");
console.log(`OCR 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

await browser.close();
close();

// 回写：只收**恰好一个字符**的结果。多字符说明这一格切歪了或识别发散，宁可留空。
let filled = 0;
let empty = 0;
let multi = 0;
let junk = 0;
for (const r of results) {
  // NFKC 规范化：PaddleOCR 时不时吐出康熙部首（⼼ U+2F3C、⼀ U+2F00）这类兼容字形，
  // 长得一样但码位不同，搜索、比对都会落空。
  const t = (r.text ?? "").trim().normalize("NFKC");
  if (!t) {
    empty++;
    continue;
  }
  if ([...t].length !== 1) {
    multi++;
    continue;
  }
  // 只收像字的结果。PaddleOCR 认不出时会吐 ■ □ 之类的占位符，
  // 收进字典就成了歌词里凭空多出的字（实测 ■ 一项就多出 337 处）。
  if (!/[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e0-9A-Za-z·♭#]/.test(t)) {
    junk++;
    continue;
  }
  dict.classes[r.key].char = t;
  dict.classes[r.key].source = "ocr";
  filled++;
}
await writeFile(DICT, JSON.stringify(dict));

const all = Object.values(dict.classes);
const defined = all.filter((c) => c.char);
const cov = defined.reduce((a, c) => a + c.count, 0) / all.reduce((a, c) => a + c.count, 0);
console.log(`补上 ${filled}，空 ${empty}，多字符丢弃 ${multi}，非字符丢弃 ${junk}`);
console.log(`→ ${DICT}：${all.length} 类，已定 ${defined.length}，覆盖实例 ${(cov * 100).toFixed(2)}%`);
