// 逐页排版信息：把每一页的版面构成抽成结构化描述，产出 pdf-layout.json / pdf-pages.csv /
// pdf-pages/summary.md 与逐页明细。
//
//   npm run build:cli && node gen-pagemap.mjs && node gen-glyphdict.mjs
//   node page-report.mjs              # 全书
//   node page-report.mjs 55-62        # 页范围
//
// **纯 Node，不起浏览器。**
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadCli, openPdf, parsePageRange, csvRow } from "./scripts/node-harness.mjs";

const args = process.argv.slice(2);
const rangeSpec = args.find((a) => !a.startsWith("--")) ?? "";
const OUTDIR = "pdf-pages";

const cli = await loadCli();
const { doc, OPS } = await openPdf();
const pm = JSON.parse(await readFile("testdata/500/pagemap.json", "utf8"));
const dict = JSON.parse(await readFile("testdata/500/glyphdict.json", "utf8"));
const charOf = new Map();
for (const c of Object.values(dict.classes)) if (c.char) charOf.set(c.key, c.char);
const lookup = (o) => { const key = cli.shapeKey(o.obj.data);
  // lyricYi 是按几何认出来的「一」，它的轮廓在字典里跟扁横条撞键，不能查字典
  return { ch: o.cls === "lyricYi" ? "一" : charOf.get(key) ?? null, key };
};

const sample = [];
for (let p = 40; p <= 200; p += 4) {
  const g = await doc.getPage(p);
  sample.push(await cli.extractVectorPage(g, OPS));
  g.cleanup();
}
const profile = cli.detectProfile(sample, "hymn500");

const entriesByPage = new Map();
for (const m of pm.map) {
  const a = entriesByPage.get(m.page) ?? [];
  a.push(m);
  entriesByPage.set(m.page, a);
}

const pages = parsePageRange(rangeSpec, doc.numPages);
await mkdir(OUTDIR, { recursive: true });

const specs = [];
// 有几类字（三连音数字、段号、段落词）PageSpec 里没有独立字段，只在归类结果里。
// 顺带把它们的字高收下来，gen-bookstyle 才能给这几个角色定字号——否则要为这点数据
// 把 666 页的 classifyPage 再跑一遍。
const CLASS_HIST = ["tupletNum", "verseNum", "sectionWord", "category", "songNumber", "title", "note", "lyric"];
const classHeights = Object.fromEntries(CLASS_HIST.map((c) => [c, []]));
for (const pn of pages) {
  const g = await doc.getPage(pn);
  const vec = await cli.extractVectorPage(g, OPS);
  g.cleanup();
  const inv = cli.classifyPage(vec, profile);
  for (const o of inv.objs) {
    if (o.dup) continue;
    const a = classHeights[o.cls];
    if (a) a.push(Number(o.obj.bbox.h.toFixed(3)));
  }
  specs.push(cli.buildPageSpec(vec, inv, lookup, entriesByPage.get(pn) ?? []));
}

await writeFile("pdf-layout.json", JSON.stringify({ pdf: pm.pdf, profile, classHeights, pages: specs }));

// ── CSV：一页一行
const head = ["页", "类型", "尺寸", "曲号", "标题", "页眉", "页脚", "谱行", "花边框", "线框", "文本行", "真实文字层", "对象数", "未安置", "仅兜底收走", "未读出"];
const csv = [csvRow(head)];
for (const s of specs) {
  csv.push(
    csvRow([
      s.page,
      s.kind,
      `${s.size[0]}×${s.size[1]}`,
      s.songs.map((x) => (x.startsHere ? x.id : `(${x.id})`)).join(" "),
      s.songs.map((x) => x.titleRun?.text ?? "").filter(Boolean).join(" "),
      s.header?.text ?? "",
      s.footer?.text ?? "",
      s.songs.reduce((a, x) => a + x.systems.length, 0),
      s.storyBoxes.length,
      s.frames.length,
      s.textLines.length,
      s.hasRawText ? "有" : "",
      s.coverage.total,
      s.coverage.unplaced,
      s.coverage.fallback,
      s.coverage.unread,
    ]),
  );
}
await writeFile("pdf-pages.csv", "﻿" + csv.join("\n"));

// ── 逐页明细
for (const s of specs) {
  const L = [`# 第 ${s.page} 页  [${s.kind}]  ${s.size[0]}×${s.size[1]}${s.rotation ? ` 旋转${s.rotation}°` : ""}`, ""];
  if (s.header) L.push(`页眉：「${s.header.text}」 @${s.header.box.x.toFixed(0)},${s.header.box.y.toFixed(0)} 字号 ${s.header.size}`);
  if (s.footer) L.push(`页脚：「${s.footer.text}」 @${s.footer.box.x.toFixed(0)},${s.footer.box.y.toFixed(0)} 字号 ${s.footer.size}`);
  for (const song of s.songs) {
    L.push("", `── 曲目 ${song.id}${song.startsHere ? "" : "（续页）"}  GT 曲名「${song.gtTitle}」  y ${song.yFrom.toFixed(0)}–${song.yTo.toFixed(0)}`);
    if (song.numberRun) L.push(`   曲号「${song.numberRun.text}」 @${song.numberRun.box.x.toFixed(0)},${song.numberRun.box.y.toFixed(0)} 字号 ${song.numberRun.size}`);
    if (song.keyMeterRun) L.push(`   调号拍号「${song.keyMeterRun.text}」 @${song.keyMeterRun.box.x.toFixed(0)},${song.keyMeterRun.box.y.toFixed(0)}`);
    if (song.titleRun) L.push(`   标题「${song.titleRun.text}」 @${song.titleRun.box.x.toFixed(0)},${song.titleRun.box.y.toFixed(0)} 字号 ${song.titleRun.size}`);
    for (const c of song.creditRuns) L.push(`   署名「${c.text}」 @${c.box.x.toFixed(0)},${c.box.y.toFixed(0)} 字号 ${c.size}`);
    for (const sys of song.systems) {
      L.push(`   谱行 ${sys.index}  y ${sys.noteTop}–${sys.noteBottom}  x ${sys.x0}–${sys.x1}  小节线 ${sys.barlineXs.length} 条`);
      L.push(`     音符(${sys.notes.length})：${sys.notes.map((n) => n.ch).join("")}`);
      sys.chordLines.forEach((ln, i) => L.push(`     和弦${i + 1}：${ln.text}`));
      sys.lyricLines.forEach((ln, i) => L.push(`     歌词${i + 1}：${ln.text}`));
    }
  }
  for (const b of s.storyBoxes) {
    L.push("", `── 花边文字框 @${b.box.x.toFixed(0)},${b.box.y.toFixed(0)} ${b.box.w.toFixed(0)}×${b.box.h.toFixed(0)}  纹样 ${b.frame.tiles} 片（单片 ${b.frame.tileW?.toFixed(1)}×${b.frame.tileH?.toFixed(1)}）`);
    for (const ln of b.lines) L.push(`   ${ln.text}`);
  }
  if (s.frames.length) {
    L.push("", "── 线框");
    const by = {};
    for (const f of s.frames) {
      const k = `${f.type}${f.dash ? "(虚线)" : ""}`;
      (by[k] ??= []).push(f);
    }
    for (const [k, v] of Object.entries(by)) L.push(`   ${k} ×${v.length}  例：${v[0].box.w.toFixed(1)}×${v[0].box.h.toFixed(1)} 线宽 ${v[0].lineWidth}`);
  }
  if (s.textLines.length) {
    L.push("", `── 其它文本行 ${s.textLines.length}`);
    for (const ln of s.textLines.slice(0, 60)) L.push(`   ${ln.text}`);
    if (s.textLines.length > 60) L.push(`   …（共 ${s.textLines.length} 行）`);
  }
  if (s.hasRawText) L.push("", "⚠ 本页含**未转曲的真实文字对象**，需另走 getTextContent() 抽取");
  L.push(
    "",
    `── 覆盖：对象 ${s.coverage.total}，未安置 ${s.coverage.unplaced}，` +
      `仅被文本行兜底收走 ${s.coverage.fallback}，未读出字形 ${s.coverage.unread}`,
  );
  L.push(`   分类：${Object.entries(s.coverage.byClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ")}`);
  await writeFile(`${OUTDIR}/${String(s.page).padStart(3, "0")}.txt`, L.join("\n"));
}

// ── 汇总
const kinds = {};
const frameTypes = {};
let unplaced = 0;
let fallback = 0;
let unread = 0;
let total = 0;
const rawTextPages = [];
const storyPages = [];
for (const s of specs) {
  kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
  for (const f of s.frames) {
    const k = `${f.type}${f.dash ? "(虚线)" : ""}`;
    frameTypes[k] = (frameTypes[k] ?? 0) + 1;
  }
  for (const b of s.storyBoxes) frameTypes["ornament(花边框)"] = (frameTypes["ornament(花边框)"] ?? 0) + 1;
  unplaced += s.coverage.unplaced;
  fallback += s.coverage.fallback;
  unread += s.coverage.unread;
  total += s.coverage.total;
  if (s.hasRawText) rawTextPages.push(s.page);
  if (s.storyBoxes.length) storyPages.push(s.page);
}
const md = [
  `# 逐页排版信息汇总`,
  ``,
  `PDF：${pm.pdf}`,
  `统计页数：${specs.length} / 全书 ${doc.numPages}`,
  ``,
  `## 页型`,
  ...Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}：${v} 页`),
  ``,
  `## 边框类型`,
  ...Object.entries(frameTypes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}：${v}`),
  ``,
  `## 覆盖`,
  `- 对象总数 ${total}`,
  `- 未安置 ${unplaced}`,
  `  （注意：\`textLines\` 是兜底字段，会把剩下的对象都收走，所以这个数结构上恒为 0，`,
  `   别拿它当「都看懂了」的凭据。真正的对象级核对在 \`relayout.mjs --mode=outline\`。）`,
  `- **仅被文本行兜底收走 ${fallback}**（没能落进曲目/页眉/页脚/花边框等结构化字段的那部分）`,
  `- 未读出字形 ${unread}（字形字典长尾未覆盖）`,
  ``,
  `## 需要特别处理的页`,
  `- 含**未转曲真实文字**：${rawTextPages.length ? rawTextPages.join(", ") : "无"}（这些页要另走 getTextContent()）`,
  `- 含**花边文字框**：${storyPages.length} 页${storyPages.length ? `（${storyPages.slice(0, 20).join(", ")}${storyPages.length > 20 ? " …" : ""}）` : ""}`,
  `- 空白页：${specs.filter((s) => s.kind === "blank").map((s) => s.page).join(", ") || "无"}`,
  ``,
].join("\n");
await writeFile(`${OUTDIR}/summary.md`, md);

console.log(`${specs.length} 页  未安置 ${unplaced}（结构上恒为 0，见 summary）  仅兜底收走 ${fallback}  未读出 ${unread}`);
console.log("页型:", Object.entries(kinds).map(([k, v]) => `${k}:${v}`).join(" "));
console.log("边框:", Object.entries(frameTypes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(" "));
console.log(`→ pdf-layout.json, pdf-pages.csv, ${OUTDIR}/summary.md, ${OUTDIR}/<页>.txt`);
