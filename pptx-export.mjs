// 500 首（或任一批 .musicxml）→ 每首一份 .pptx，按乐句排版、PPT 版面档。
//
// 走的是编辑器那条真路：`__app.importBytes(xml)` → 乐句排版 → `pptxPainter(app)`
//（PPT 档另排一遍）→ `buildPptx`，与工具栏「导出 → PPTX」同一套代码。
//
// 乐句排版的行长目标按**纸张实测**折算（`App._phraseFit` → `phrase.ts::targetMeasForFit`），
// 编辑器点「按乐句重排」走的是同一条路，所以这里出的片就是屏幕上看到的那个分行。
//
// 用法：
//   npm run build && node pptx-export.mjs                 # 全部 → pptx-out/
//   node pptx-export.mjs --out=/tmp/ppt --one=001,002      # 指定曲号
//   node pptx-export.mjs --in=<musicxml 目录> --limit=20
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import { serveDist, launchPage, loadApp } from "./scripts/harness.mjs";
import { CORPUS_ROOT, songIdOf, songRank } from "./scripts/node-harness.mjs";

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.slice(k.length + 3) : d;
};
const inDir = arg("in", join(CORPUS_ROOT, "500"));
const outDir = arg("out", join(process.cwd(), "pptx-out"));
const only = new Set((arg("one", "") || "").split(",").filter(Boolean));
const limit = Number(arg("limit", "0")) || Infinity;

const files = (await readdir(inDir))
  .filter((f) => extname(f).toLowerCase() === ".musicxml")
  .filter((f) => !only.size || only.has(songIdOf(f) ?? ""))
  .sort((a, b) => songRank(songIdOf(a) ?? "") - songRank(songIdOf(b) ?? ""))
  .slice(0, limit);
if (!files.length) { console.log(`${inDir} 下没有匹配的 .musicxml`); process.exit(1); }
await mkdir(outDir, { recursive: true });

const { port, close: closeServer } = await serveDist();
const { browser, page, errors } = await launchPage({ viewport: { width: 1280, height: 900 }, quiet: true });
await loadApp(page, port, { reveal: true, wait: 1200 });

let ok = 0;
const failed = [];
for (const f of files) {
  const xml = await readFile(join(inDir, f), "utf8");
  errors.length = 0;
  let res;
  try {
    res = await page.evaluate(async (xml) => {
      const app = window.__app;
      const { buildPptx, pptxPainter } = await window.__pptx;
      app.importBytes(new TextEncoder().encode(xml), "song.musicxml");
      app.setPhraseLayout(true);
      const painter = pptxPainter(app);
      const bytes = await buildPptx(painter);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return { b64: btoa(bin), pages: painter.layout.pages.length };
    }, xml);
  } catch (e) {
    failed.push([f, String(e).split("\n")[0].slice(0, 120)]);
    // 页面可能已经脏了，重新载入再跑下一首
    await loadApp(page, port, { reveal: true, wait: 800 });
    continue;
  }
  const name = basename(f, extname(f)) + ".pptx";
  await writeFile(join(outDir, name), Buffer.from(res.b64, "base64"));
  ok++;
  if (!res.pages) failed.push([f, "排出 0 页：" + (errors[0] ?? "无控制台线索")]);
  console.log(`${name}  ${res.pages} 页${errors.length ? `  [控制台] ${errors.join(" ｜ ").slice(0, 200)}` : ""}`);
}

await browser.close();
closeServer();
console.log(`\n共 ${files.length} 首，成功 ${ok}，失败 ${failed.length} → ${outDir}`);
for (const [f, e] of failed) console.log(`  × ${f}: ${e}`);
