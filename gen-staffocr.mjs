// 正文字形字典的 **OCR 兜底**：GT 自举完之后仍未定的形状类，每类送一次 OCR。
//
// 为什么还需要它（同 500 首那本的 `gen-glyphocr.mjs`）：自举只能标出**对上了 GT 的
// 那些曲子的歌词里出现过**的字。全书 222 首里只对上一百首，剩下的字没人教。
// 实测识别出来的中文歌词里还有 6% 是字典没覆盖、带着坏 ToUnicode 漏出来的乱码。
//
// 「每类只送一次」是这条路划算的关键。
//
// 这是五线谱路里**唯一要起浏览器的建库步骤**（PaddleOCR 走 onnxruntime-web）。
// 跑完产物落盘，之后的识别仍然是纯查表、不碰 OCR。
//
//   npm run build && npm run build:cli && node gen-stafflyrics.mjs && node gen-staffocr.mjs
//   node gen-staffocr.mjs --min=3     # 只补实例数 ≥3 的类（默认 2）
import { readFile, writeFile } from "node:fs/promises";
import { serveDist, launchPage } from "./scripts/harness.mjs";
import { openPdf, eachPage, loadCli, ZMZQ_PDF } from "./scripts/node-harness.mjs";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
);
const MIN = Number(flags.min ?? 2);
const DICT = "src/staffomr/lyricglyphs.json";

const dict = JSON.parse(await readFile(DICT, "utf8"));
const cli = await loadCli();
const byId = new Map(dict.classes.map((c) => [cli.textClassId(c.font, c.key), c]));
const todo = new Map(); // id → { d, bbox }
for (const c of dict.classes) if (!c.char && c.count >= MIN) todo.set(cli.textClassId(c.font, c.key), null);
console.log(`未定类 ${dict.classes.filter((c) => !c.char).length}，其中实例 ≥${MIN} 的 ${todo.size} 类`);
if (!todo.size) process.exit(0);

// ── 扫一遍书，把这些类的轮廓收齐 ────────────────────────────────────────────
// 字典是按 id 登记的（`TextGlyphBuilder.ensure`），没存轮廓；OCR 要把字形画出来，
// 所以这里回头再扫一遍。**只收待办那些类**，见一个记一个。
const look = cli.makeLookup(JSON.parse(await readFile("src/staffomr/glyphmap.json", "utf8")));
const textLookup = new cli.TextGlyphLookup(dict);
const { doc, OPS } = await openPdf(ZMZQ_PDF);
let left = todo.size;
await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
  if (!left) return;
  const r = await cli.recognizeStaffPage(page, OPS, look, pn, { textLookup });
  for (const line of r.lyricLines) {
    for (const syl of line.syllables) {
      for (const g of syl.glyphs) {
        const id = cli.glyphClassKey(syl.font, g);
        if (!id || !todo.has(id) || todo.get(id)) continue;
        if (!g.outline?.length) continue;
        const b = outlineBounds(g.outline);
        if (!b) continue;
        todo.set(id, { d: cli.outlineToPath(g.outline), bbox: b });
        left--;
      }
    }
  }
});
const items = [...todo].filter(([, v]) => v).map(([id, v]) => ({ id, ...v }));
console.log(`收到轮廓 ${items.length}/${todo.size} 类（其余只出现在没归成歌词行的文本里）`);
if (!items.length) process.exit(0);

// ── 送 OCR ──────────────────────────────────────────────────────────────────
const { port, close } = await serveDist("dist");
const { page, browser } = await launchPage({ quiet: true });
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__omr, null, { timeout: 60000 });

const t0 = Date.now();
const BATCH = 64;
const results = [];
for (let i = 0; i < items.length; i += BATCH) {
  const chunk = items.slice(i, i + BATCH);
  const got = await page.evaluate(async (list) => {
    const omr = await window.__omr;
    window.__ocr ??= omr.paddleOcrBackend();
    const ocr = window.__ocr;
    const canvases = list.map((it) => {
      // PaddleOCR rec 吃 48 高的图。字形是白底黑字、居中、留一圈边。
      const [x0, y0, x1, y1] = it.bbox;
      const w = Math.max(x1 - x0, 1e-6);
      const h = Math.max(y1 - y0, 1e-6);
      const cv = new OffscreenCanvas(48, 48);
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 48, 48);
      const s = Math.min(38 / w, 38 / h);
      ctx.translate(24, 24);
      ctx.scale(s, -s); // 字形坐标 y 朝上，canvas 朝下
      ctx.translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
      ctx.fillStyle = "#000";
      ctx.fill(new Path2D(it.d));
      return cv;
    });
    return await ocr.recognizeTexts(canvases);
  }, chunk);
  got.forEach((text, k) => results.push({ id: chunk[k].id, text }));
  if ((i / BATCH) % 5 === 0) process.stdout.write(`\r  ${Math.min(i + BATCH, items.length)}/${items.length}…`);
}
process.stdout.write("\r");
console.log(`OCR 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close();
close();

// ── 回写 ────────────────────────────────────────────────────────────────────
// 只收**恰好一个字符**且像字的结果。多字符说明这一格切歪了；PaddleOCR 认不出时
// 会吐 ■ □ 之类的占位符，收进字典就成了歌词里凭空多出的字。
const OKCH = /[一-鿿　-〿！-～0-9A-Za-z]/;
let filled = 0, empty = 0, multi = 0, junk = 0;
for (const r of results) {
  const t = (r.text ?? "").trim().normalize("NFKC");
  if (!t) { empty++; continue; }
  if ([...t].length !== 1) { multi++; continue; }
  if (!OKCH.test(t)) { junk++; continue; }
  const c = byId.get(r.id);
  if (!c) continue;
  c.char = t;
  c.source = "ocr";
  filled++;
}
await writeFile(DICT, JSON.stringify(dict, null, 1));
const defined = dict.classes.filter((c) => c.char);
const cov = defined.reduce((a, c) => a + c.count, 0) / dict.classes.reduce((a, c) => a + c.count, 0);
console.log(`补上 ${filled}，空 ${empty}，多字符丢弃 ${multi}，非字符丢弃 ${junk}`);
console.log(`→ ${DICT}：${dict.classes.length} 类，已定 ${defined.length}，覆盖实例 ${(cov * 100).toFixed(2)}%`);

/** 轮廓（DrawOPS 扁平流）的紧包围盒。 */
function outlineBounds(data) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let i = 0;
  const arity = [2, 2, 6, 4, 0];
  while (i < data.length) {
    const n = arity[data[i++]];
    if (n === undefined) break;
    for (let k = 0; k < n; k += 2) {
      const x = data[i + k], y = data[i + k + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    i += n;
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}
