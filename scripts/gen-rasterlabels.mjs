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
        strips.push({ key, w: strip.w, h: strip.h, data: Array.from(strip.data) });
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
const BATCH = 8;
let done = 0;
for (let i = 0; i < strips.length; i += BATCH) {
  const chunk = strips.slice(i, i + BATCH);
  const got = await page.evaluate(async (list) => {
    const omr = await window.__omr;
    window.__ocr ??= omr.paddleOcrBackend();
    const out = [];
    for (const it of list) {
      // **定位交给 DBNet**：带里除了标签还压着上一行谱的歌词、弧线、力度，
      // 几何闸分不开（六种调法全试过，见 `stafflabel.ts` 的说明）。
      // `recognizeRegion` 检测出各行文本框、逐框 rec，回来的是**带内坐标**。
      const bin = { w: it.w, h: it.h, data: Uint8Array.from(it.data) };
      let lines = [];
      try {
        lines = await window.__ocr.recognizeRegion(bin, { x: 0, y: 0, w: it.w, h: it.h });
      } catch {
        lines = [];
      }
      window.__ocr ??= omr.paddleOcrBackend();
      // **框右边的分部号要单独捡。** DBNet 按行框字，`Soprano 1` 的词距够宽时
      // 那个孤立的窄 `1` 既进不了框、也不够它单独成一框（实测破碎 p9 顶行谱面
      // 印着 `Soprano 1`，框只有 145px 宽、读出 `Soprano`，于是与第三行的
      // `Soprano` 同名，两条声部就分不开）。而分部号正是分开它们的要害。
      // 做法：在框右边一小段里找孤立的窄墨块，交给 `recognizeDigits`。
      const digitOf = async (bb) => {
        const x0 = Math.round(bb.x + bb.w);
        const xEnd = Math.min(it.w, Math.round(x0 + bb.h * 3));
        const yA = Math.max(0, Math.round(bb.y));
        const yB = Math.min(it.h, Math.round(bb.y + bb.h));
        const col = [];
        for (let x = x0; x < xEnd; x++) {
          let ink = 0;
          for (let y = yA; y < yB; y++) if (bin.data[y * it.w + x]) ink++;
          col.push(ink);
        }
        let a = col.findIndex((v) => v > 0);
        if (a < 0) return "";
        let b = a;
        while (b + 1 < col.length && (col[b + 1] || col[b + 2])) b++;
        const w = b - a + 1;
        if (w < bb.h * 0.1 || w > bb.h * 0.8) return ""; // 不像一个数字
        // **还要够高**：框右边常跟着逗号、连音点、力度的残笔，那些只占一两行
        // （实测 `Men,` 后面那一小坨被读成了 `1`，整行成了 `M1`）。
        let tall = 0;
        for (let x = a; x <= b; x++) tall = Math.max(tall, col[x]);
        if (tall < (yB - yA) * 0.4) return "";
        const rect = { x: x0 + a - 1, y: yA, w: w + 2, h: yB - yA };
        try {
          const [d] = await window.__ocr.recognizeDigits(bin, [rect]);
          return d >= 0 && d <= 9 ? String(d) : "";
        } catch {
          return "";
        }
      };
      const withNum = [];
      for (const l of lines) {
        const d = /[0-9]\s*$/.test(l.text) ? "" : await digitOf(l.bbox);
        withNum.push({ text: l.text + d, y: l.bbox.y + l.bbox.h / 2, x: l.bbox.x });
      }
      out.push(withNum);
    }
    return out;
  }, chunk);
  got.forEach((lines, k) => {
    // **取最靠近谱行的那一行**（带的下沿就是谱行顶线）；同高的取最靠左的。
    // 认不出声部名的行不存，免得把力度、表情文字当标签。
    //
    // 试过**先把同一文字行的框按 x 拼起来**（DBNet 按行框字，`Soprano 1` 的词距够宽
    // 时会切成两框）：各档指标一分不动，认得出的声部名反而从 24 个掉到 21 个
    // （拼进了相邻的力度、表情文字，反倒认不出了）。破碎 p9 顶行那个读丢的 `1`
    // 也不是切框切掉的——框里有它，是 rec 没读出来。
    const named = lines.filter((l) => cli.normalizeLabel(l.text));
    const pick = named.sort((a, b) => b.y - a.y || a.x - b.x)[0];
    if (pick) cache[chunk[k].key] = pick.text;
    done++;
  });
  if ((i / BATCH) % 5 === 0) process.stdout.write(`\r  ${Math.min(i + BATCH, strips.length)}/${strips.length}…`);
}
process.stdout.write("\r");
console.log(`OCR 用时 ${((Date.now() - t1) / 1000).toFixed(1)}s，跑完 ${done} 条`);
await browser.close();
close();

await writeFile(DICT, JSON.stringify(cache));
console.log(`→ ${DICT}（认得出声部名的 ${Object.keys(cache).length} 条：` +
  `${[...new Set(Object.values(cache).map((t) => cli.normalizeLabel(t)))].sort().join(" ")}）`);
