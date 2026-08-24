// 字形字典的 OCR 兜底：GT 语料自举完之后仍未定字符的形状类，**每类送一次 OCR**。
//
// 为什么还需要它：自举只能标出 GT 里出现过的字。目录页的曲名首句、首句索引、
// 花边框里的注解正文都没有 GT，字典盖不到（约 2550 类 / 19000 个实例）。
//
// 「每类只送一次」是这条路划算的关键——两万个实例只要跑两千多次推理。
//
// **两种形状分开送**：
//   - 单字：挤进 48×48，只收「恰好一个字符」的结果，多字符说明切歪了，宁可留空。
//   - **整行合成的 path**（一整行文字是一个路径对象，全书乐谱页有三千多处）：
//     按原比例摊成 48 高的长条送**行识别**，收多字符结果——那本来就是一行字。
//     这类字典帮不上忙（按字形查不到东西），OCR 是唯一的路。
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
// **同一个字形的分身一组只送一次**：`shapeKey` 对亚像素抖动不稳，同一个字常被切成
// 好几个类（`gen-glyphdict` 归并后把代表键写在 `g` 字段里）。一组送一次，
// 既省三成推理，也免得几个分身各 OCR 出一个字、彼此打架。
const groupOf = (c) => c.g ?? c.key;
const bestOfGroup = new Map();
for (const c of Object.values(dict.classes)) {
  if (!c.d || !c.bbox) continue;
  const g = groupOf(c);
  const cur = bestOfGroup.get(g);
  if (!cur || c.count > cur.count) bestOfGroup.set(g, c);
}
const groupHasChar = new Set();
for (const c of Object.values(dict.classes)) if (c.char) groupHasChar.add(groupOf(c));
const todo = [...bestOfGroup.values()].filter((c) => !groupHasChar.has(groupOf(c)) && c.count >= MIN);
/** 结果发给**整组**：分身查表时用的是自己的键，不写进去就还是读不出。 */
const members = new Map();
for (const c of Object.values(dict.classes)) (members.get(groupOf(c)) ?? members.set(groupOf(c), []).get(groupOf(c))).push(c);
const setGroup = (key, ch, src) => {
  for (const c of members.get(groupOf(dict.classes[key])) ?? [dict.classes[key]]) {
    c.char = ch;
    c.source = src;
  }
};
/** 整行合成的 path：宽是高的三倍以上。单字再扁也扁不到这个地步。 */
const isLine = (c) => c.w >= c.h * 3;
console.log(
  `未定形状类 ${Object.values(dict.classes).filter((c) => !c.char).length}，本次送 OCR ${todo.length}` +
    `（实例 ${todo.reduce((a, c) => a + c.count, 0)}；其中整行合成的 ${todo.filter(isLine).length} 类）`,
);
if (!todo.length) process.exit(0);

const { port, close } = await serveDist("dist");
const { page, browser } = await launchPage({ quiet: true });
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__omr, null, { timeout: 60000 });

const t0 = Date.now();
const BATCH = 64;
const results = [];
for (let i = 0; i < todo.length; i += BATCH) {
  const chunk = todo.slice(i, i + BATCH).map((c) => ({ key: c.key, d: c.d, bbox: c.bbox, line: isLine(c) }));
  const got = await page.evaluate(async (items) => {
    const omr = await window.__omr;
    window.__ocr ??= omr.paddleOcrBackend();
    const ocr = window.__ocr;
    const canvases = items.map((it) => {
      // PaddleOCR rec 吃 48 高的图。字形是白底黑字、居中、留一圈边。
      const [x0, y0, x1, y1] = it.bbox;
      const w = Math.max(x1 - x0, 0.1);
      const h = Math.max(y1 - y0, 0.1);
      // 整行的要**按原比例摊开**：塞进 48×48 会把一行字压成一团，什么都认不出来。
      const cw = it.line ? Math.min(2048, Math.max(48, Math.round((48 * w) / h))) : 48;
      const cv = new OffscreenCanvas(cw, 48);
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cw, 48);
      const s = it.line ? Math.min((cw - 6) / w, 38 / h) : Math.min(38 / w, 38 / h);
      ctx.translate(cw / 2, 24);
      ctx.scale(s, -s); // PDF 的 y 轴朝上，canvas 朝下
      ctx.translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
      ctx.fillStyle = "#000";
      ctx.fill(new Path2D(it.d));
      return cv;
    });
    return await ocr.recognizeTexts(canvases);
  }, chunk);
  got.forEach((text, k) => results.push({ key: chunk[k].key, text, line: chunk[k].line }));
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
  // 整行的收整串，单字的只收「恰好一个字符」——多字符说明这一格切歪了或识别发散。
  if (!r.line && [...t].length !== 1) {
    multi++;
    continue;
  }
  // 只收像字的结果。PaddleOCR 认不出时会吐 ■ □ 之类的占位符，
  // 收进字典就成了歌词里凭空多出的字（实测 ■ 一项就多出 337 处）。
  const OKCH = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e0-9A-Za-z·♭#]/;
  if (![...t].some((ch) => OKCH.test(ch))) {
    junk++;
    continue;
  }
  if (r.line) {
    // 整行里夹的占位符逐个剔掉，剩下的照收
    const cleaned = [...t].filter((ch) => OKCH.test(ch)).join("");
    if (!cleaned) {
      junk++;
      continue;
    }
    setGroup(r.key, cleaned, "ocr-line");
    filled++;
    continue;
  }
  setGroup(r.key, t, "ocr");
  filled++;
}
await writeFile(DICT, JSON.stringify(dict));

const all = Object.values(dict.classes);
const defined = all.filter((c) => c.char);
const cov = defined.reduce((a, c) => a + c.count, 0) / all.reduce((a, c) => a + c.count, 0);
console.log(`补上 ${filled}（其中整行 ${results.filter((r) => r.line && dict.classes[r.key].char).length}），空 ${empty}，多字符丢弃 ${multi}，非字符丢弃 ${junk}`);
console.log(`→ ${DICT}：${all.length} 类，已定 ${defined.length}，覆盖实例 ${(cov * 100).toFixed(2)}%`);
