// 五线谱字形建库：全书扫一遍音乐字体的字形 → 按轮廓聚成形状类 → 码位表自举 →
// 分身归并 → 出 `src/staffomr/glyphmap.json` 与人工确认表 `staff-out/glyphsheet.html`。
//
// 为什么要这一步（详见 docs/实现/五线谱识别.md）：同一个字形在书里被切成好几个子集、
// 码位各不相同（Maestro 113 个码位其实只有 83 个字形），只查码位表必错。轮廓是逐位相同的。
//
// 用法：
//   node gen-staffglyphs.mjs                 建库（保留已有的人工标注）
//   node gen-staffglyphs.mjs --reset         从头建（丢掉人工标注，慎用）
//   node gen-staffglyphs.mjs --pages=1-50    只扫一段（调试）
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { openPdf, eachPage, parsePageRange, loadCli, ZMZQ_PDF } from "./node-harness.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const reset = args.includes("--reset");
const OUT_JSON = "src/staffomr/glyphmap.json";
const OUT_DIR = "staff-out";

const cli = await loadCli();
const { doc, OPS } = await openPdf(ZMZQ_PDF);
const pages = parsePageRange(argOf("pages"), doc.numPages);

const b = new cli.StaffGlyphBuilder();
const t0 = Date.now();
await eachPage(doc, pages, async (page, pn) => {
  b.addPage(await cli.extractTextPage(page, OPS, { scale: 1 }), pn);
});
const dict = b.finish("赞美之泉");
console.log(`扫 ${pages.length} 页 ${((Date.now() - t0) / 1000).toFixed(1)}s，形状类 ${dict.classes.length}`);

// 保留上一版的人工标注（`manual` 才保留：table/merge 每次重算）
if (!reset && existsSync(OUT_JSON)) {
  const old = JSON.parse(await readFile(OUT_JSON, "utf8"));
  const manual = new Map();
  for (const c of old.classes ?? []) if (c.source === "manual" && c.smufl) manual.set(cli.classId(c.family, c.key), c.smufl);
  let kept = 0;
  for (const c of dict.classes) {
    const m = manual.get(cli.classId(c.family, c.key));
    if (m) { c.smufl = m; c.source = "manual"; kept++; }
  }
  console.log(`沿用人工标注 ${kept}/${manual.size} 条`);
}

const nTable = cli.bootstrapByTable(dict);
const nMerge = cli.mergeTwins(dict);
console.log(`码位表自举 ${nTable} 类，分身归并 ${nMerge} 类`);

// 人工标注最后压一道（可信度最高，覆盖前面两步）
const manual = JSON.parse(await readFile("src/staffomr/glyphmanual.json", "utf8"));
const { hit, stale } = cli.applyManual(dict, manual.rules);
console.log(`人工标注命中 ${hit} 类 / 规则 ${manual.rules.length} 条`);
if (stale.length) {
  console.log("！以下人工规则没匹配到任何类（字典变了？回 staff-out/undone.html 看）：");
  for (const r of stale) console.log(`   ${r.family} u+${r.uni.toString(16)} ${r.w}x${r.h} → ${r.smufl}`);
}

const byFam = new Map();
for (const c of dict.classes) {
  const e = byFam.get(c.family) ?? { n: 0, done: 0, inst: 0, miss: 0 };
  e.n++; e.inst += c.count;
  if (c.smufl) e.done++; else e.miss += c.count;
  byFam.set(c.family, e);
}
console.log("家族            类数  已定  未定字形数");
for (const [f, e] of [...byFam].sort((a, b) => b[1].inst - a[1].inst))
  console.log(`  ${f.padEnd(14)} ${String(e.n).padStart(4)} ${String(e.done).padStart(5)} ${String(e.miss).padStart(10)}`);
const undone = dict.classes.filter((c) => !c.smufl);
console.log(`未定类 ${undone.length}，涉及字形 ${undone.reduce((a, c) => a + c.count, 0)}`);

await writeFile(OUT_JSON, JSON.stringify(dict, null, 1));
console.log("→", OUT_JSON);

// ── 人工确认表 ──────────────────────────────────────────────────────────────
// 一页看完：按家族分组，每个类画出代表轮廓 + 已定的名字 + 码位与实例数。
// 未定的排在最前面（那才是要人看的）。
await mkdir(OUT_DIR, { recursive: true });
const cell = (c) => {
  // 轮廓是字形坐标（em=1，y 向上），画到 100×100 的框里要翻 y
  const s = 80 / Math.max(c.h || 1, c.w || 1, 0.2);
  return `<div class="c ${c.smufl ? "ok" : "no"}">
  <svg viewBox="-50 -70 100 110"><g transform="scale(${s.toFixed(2)},${-s.toFixed(2)})"><path d="${c.d}" fill="#000"/></g></svg>
  <div class="n">${c.smufl ?? "？"}</div>
  <div class="m">${c.source ?? ""} ×${c.count}<br>code ${c.codes.join(",")}<br>${c.w.toFixed(3)}×${c.h.toFixed(3)} p${c.page}</div>
</div>`;
};
let html = `<meta charset="utf-8"><title>五线谱字形确认表</title><style>
body{font:12px/1.4 -apple-system,sans-serif;background:#fafafa;margin:16px}
h2{margin:24px 0 8px}
.g{display:flex;flex-wrap:wrap;gap:6px}
.c{width:110px;border:1px solid #ddd;background:#fff;padding:4px;text-align:center}
.c.no{border-color:#c00;background:#fff6f6}
.c svg{width:100px;height:110px;display:block}
.n{font-weight:600;font-size:11px;word-break:break-all}
.m{color:#888;font-size:10px}
</style>`;
for (const [fam] of [...byFam].sort((a, b) => b[1].inst - a[1].inst)) {
  const list = dict.classes.filter((c) => c.family === fam).sort((a, b) => (a.smufl ? 1 : 0) - (b.smufl ? 1 : 0) || b.count - a.count);
  html += `<h2>${fam}（${list.length} 类，未定 ${list.filter((c) => !c.smufl).length}）</h2><div class="g">${list.map(cell).join("")}</div>`;
}
await writeFile(`${OUT_DIR}/glyphsheet.html`, html);
console.log("→", `${OUT_DIR}/glyphsheet.html`);
