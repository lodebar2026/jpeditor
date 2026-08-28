// 书级元数据入库：pdf-layout.json（版面规格）→ 校对.db 的八张表。
//
// 原书上那些 musicxml 装不下的内容——调号拍号原文、段落词、花边框正文、目录、
// 首句索引、扉页前言、印刷页码、花边纹样——都在版面规格里躺着，这一步把它们
// 提取成结构化数据，rebuild.mjs 再照着排回去。判据全在 src/pdflayout/bookmeta.ts。
//
//   npm run build:cli && node page-report.mjs      # 先有 pdf-layout.json
//   node gen-bookmeta.mjs --check                  # 只统计不写库
//   node gen-bookmeta.mjs                          # 写 校对.db
//
// **纯 Node，不起浏览器。**
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadCli, loadCorpus } from "./scripts/node-harness.mjs";
import { openDb, loadGlyphFixes, replaceTable, newRunId, recordRun, recordDiffs } from "./scripts/checkdb.mjs";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
);
const CHECK = "check" in flags;
const cli = await loadCli();
const layout = JSON.parse(await readFile(flags.layout ?? "pdf-layout.json", "utf8"));
const specs = layout.pages;
const dict = JSON.parse(await readFile(flags.dict ?? "testdata/500/glyphdict.json", "utf8"));
const pm = JSON.parse(await readFile("testdata/500/pagemap.json", "utf8"));
const { songs } = await loadCorpus();

const db = openDb();
const fixes = loadGlyphFixes(db);
const repOf = (k) => dict.classes[k]?.g ?? k;
/** 逐字覆盖：人工/行 OCR 定案的补字优先（分身也要认，所以代表键也查一遍）。 */
const override = (key, current) => fixes[key] ?? fixes[repOf(key)] ?? (current === "�" ? null : current);

const entriesByPage = new Map();
for (const m of pm.map) {
  const a = entriesByPage.get(m.page) ?? [];
  a.push(m);
  entriesByPage.set(m.page, a);
}

const meta = cli.buildBookMeta(specs, { override, entriesByPage, noteH: cli.noteHeightOf(layout.profile) });

// 分类：album.txt 已经有一级分类（rebuild 的页眉就是按它排的），
// 顺手并进 song_meta，重排时不必再各查各的。
const catOf = (id) => songs.get(id)?.category ?? null;

const songMeta = meta.keyMeters.map((k) => ({
  song_no: k.songId,
  tonic: k.tonic,
  beats: k.beats,
  beat_type: k.beatType,
  alt_tonic: k.altTonic,
  key_raw: k.raw,
  category: catOf(k.songId),
  source_page: k.page,
}));
const sectionWords = meta.sectionWords.map((s) => ({
  song_no: s.songId,
  text: s.text,
  note_ordinal: s.noteOrdinal,
  measure_index: s.measureIndex,
  system_index: s.systemIndex,
  source_page: s.page,
}));
const annotations = meta.annotations.map((a, i) => ({
  song_no: a.songId,
  framed: a.framed ? 1 : 0,
  // 框的样子：tile 花边纹样框 / line 双细线矩形框（022、023 那种）/ none 不装框
  frame_kind: a.frame ?? (a.framed ? "tile" : "none"),
  frame_outer: a.frameOuterWidth ?? 0,
  frame_inner: a.frameInnerWidth ?? 0,
  frame_gap: a.frameGap ?? 0,
  frame_style: a.frameStyle ?? null,
  frame_edges: a.frameEdges ?? null,
  seq: i,
  text: a.text,
  size: a.size,
  box_x: +a.box.x.toFixed(2),
  box_y: +a.box.y.toFixed(2),
  box_w: +a.box.w.toFixed(2),
  box_h: +a.box.h.toFixed(2),
  source_page: a.page,
}));
const tocRows = meta.toc.map((t) => ({
  seq: t.seq, kind: t.kind, text: t.text, song_no: t.songId, printed_page: t.printedPage, source_page: t.page,
}));
const indexRows = meta.index.map((r) => ({
  seq: r.seq, kind: r.kind, index_name: r.indexName, text: r.text, song_no: r.songId, source_page: r.page,
}));
const frontRows = meta.front.map((f) => ({ source_page: f.page, kind: f.kind, title: f.title, body: f.body, note: f.note }));
const labelRows = meta.pageLabels.map((p) => ({ page: p.page, printed_label: p.label, printed_no: p.no, kind: p.kind }));
const tileRows = meta.ornaments.map((o) => ({ style_id: o.style, slot: o.slot, w: o.w, h: o.h, pitch: o.pitch, ox: o.ox, oy: o.oy, path: o.path }));

const withXml = [...songs.values()].filter((s) => s.musicxml).length;
const kmMiss = [...songs.values()].filter((s) => s.musicxml && !songMeta.some((m) => m.song_no === s.id));
console.log(`调号拍号 ${songMeta.length}（语料 ${withXml} 首，缺 ${kmMiss.length}：${kmMiss.slice(0, 6).map((s) => s.id).join(" ")}）`);
console.log(`  拍号读不出的 ${songMeta.filter((s) => !s.beats).length}，带移调建议的 ${songMeta.filter((s) => s.alt_tonic).length}`);
console.log(`段落词 ${sectionWords.length}（${[...new Set(sectionWords.map((s) => s.text))].slice(0, 8).join(" ")}）`);
console.log(`注解 ${annotations.length}（花边框 ${annotations.filter((a) => a.frame_kind === "tile").length}，线框 ${annotations.filter((a) => a.frame_kind === "line").length}，不装框 ${annotations.filter((a) => a.frame_kind === "none").length}，归不到曲目的 ${annotations.filter((a) => !a.song_no).length}）`);
console.log(`目录 ${tocRows.length} 行（条目 ${tocRows.filter((t) => t.kind === "entry").length}，一级 ${tocRows.filter((t) => t.kind === "category").length}，二级 ${tocRows.filter((t) => t.kind === "subcategory").length}）`);
console.log(`索引 ${indexRows.length} 行（诗题笔划 ${indexRows.filter((r) => r.index_name === "title").length}，歌词首句 ${indexRows.filter((r) => r.index_name === "firstline").length}，分节标题 ${indexRows.filter((r) => r.kind === "heading").length}，认到曲号 ${indexRows.filter((r) => r.song_no).length}）`);
console.log(`扉页前言 ${frontRows.length} 页，印刷页码 ${labelRows.filter((p) => p.printed_no !== null).length}/${labelRows.length}，花边样式 ${new Set(tileRows.map((t) => t.style_id)).size} 套 / 母题 ${tileRows.length} 片`);

// 与 musicxml 对拍：调号/拍号不一致的记进 diff 表交人工看
const { gtKeyTime } = await import("./scripts/node-harness.mjs");
const mismatches = [];
for (const m of songMeta) {
  const s = songs.get(m.song_no);
  if (!s?.musicxml) continue;
  const gt = gtKeyTime(await readFile(s.musicxml, "utf8"));
  if (!gt) continue;
  const norm = (t) => String(t ?? "").replace("♭", "b").replace("♯", "#");
  // GT 的 musicxml 有一大批是按**移调建议那一调**记的（文档「已知差异」里记过），
  // 所以主调或建议调对上一个就算对，两个都对不上才是真差异。
  if (norm(gt.key) !== norm(m.tonic) && norm(gt.key) !== norm(m.alt_tonic))
    mismatches.push({ song_no: m.song_no, role: "key", gt_value: gt.key, out_value: `${m.tonic}${m.alt_tonic ? `(${m.alt_tonic})` : ""}` });
  else if (gt.beats && m.beats && (gt.beats !== m.beats || gt.beatType !== m.beat_type))
    mismatches.push({ song_no: m.song_no, role: "meter", gt_value: `${gt.beats}/${gt.beatType}`, out_value: `${m.beats}/${m.beat_type}` });
}
console.log(`与 musicxml 对拍：调号/拍号不一致 ${mismatches.length}（${mismatches.slice(0, 8).map((d) => `${d.song_no} ${d.gt_value}↔${d.out_value}`).join("，")}）`);

if (meta.problems.length) {
  console.log(`\n⚠ 提取不出来的 ${meta.problems.length} 条：`);
  for (const p of meta.problems.slice(0, 25)) console.log("  " + p);
  if (meta.problems.length > 25) console.log(`  …另有 ${meta.problems.length - 25} 条，见 pdf-out/bookmeta-report.json`);
}

await mkdir("pdf-out", { recursive: true });
await writeFile(
  "pdf-out/bookmeta-report.json",
  JSON.stringify(
    {
      counts: {
        songMeta: songMeta.length, sectionWords: sectionWords.length, annotations: annotations.length,
        toc: tocRows.length, index: indexRows.length, front: frontRows.length, labels: labelRows.length, tiles: tileRows.length,
      },
      problems: meta.problems,
      keyMismatch: mismatches,
      tocHeadings: tocRows.filter((t) => t.kind !== "entry").map((t) => `${t.kind}:${t.text}`),
      sample: { keyMeter: songMeta.slice(0, 5), section: sectionWords.slice(0, 5), annotation: annotations.slice(0, 2) },
    },
    null,
    2,
  ),
);

if (CHECK) {
  db.close();
  console.log("\n--check：没有写库。→ pdf-out/bookmeta-report.json");
  process.exit(0);
}
replaceTable(db, "song_meta", ["song_no", "tonic", "beats", "beat_type", "alt_tonic", "key_raw", "category", "source_page"], songMeta);
replaceTable(db, "section_word", ["song_no", "text", "note_ordinal", "measure_index", "system_index", "source_page"], sectionWords);
replaceTable(db, "annotation", ["song_no", "framed", "frame_kind", "frame_outer", "frame_inner", "frame_gap", "frame_style", "frame_edges", "seq", "text", "size", "box_x", "box_y", "box_w", "box_h", "source_page"], annotations);
replaceTable(db, "toc_row", ["seq", "kind", "text", "song_no", "printed_page", "source_page"], tocRows);
replaceTable(db, "index_row", ["seq", "kind", "index_name", "text", "song_no", "source_page"], indexRows);
replaceTable(db, "front_page", ["source_page", "kind", "title", "body", "note"], frontRows);
replaceTable(db, "page_label", ["page", "printed_label", "printed_no", "kind"], labelRows);
replaceTable(db, "ornament_tile", ["style_id", "slot", "w", "h", "pitch", "ox", "oy", "path"], tileRows);
// 调号/拍号与 musicxml 对不上的记进 diff 表交人工看——多半是 GT 按主音和弦订正过
// （文档「已知差异」记过），但不能因为「多半」就吞掉。
const runId = newRunId("bookmeta");
recordRun(db, { run_id: runId, route: "bookmeta", artifact: "校对.db", cmd: "gen-bookmeta.mjs" });
recordDiffs(db, runId, mismatches.map((d) => ({ ...d, category: "表述或结构不一致", note: "调号拍号：谱面 ↔ musicxml" })));
db.close();
console.log(`\n→ 校对.db：批次 ${runId}，调号拍号差异 ${mismatches.length} 条进 diff`);
console.log("→ 校对.db：song_meta / section_word / annotation / toc_row / index_row / front_page / page_label / ornament_tile");
console.log("→ pdf-out/bookmeta-report.json");
