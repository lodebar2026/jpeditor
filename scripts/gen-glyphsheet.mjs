// 未定字形的人工确认表：把仍然读不出的形状类按实例数排序，轮廓原样画成对照表，
// 每格标出「所在页 / 角色 / 实例数 / 机器猜测」，另出一份 TSV 供人工填字。
//
//   node gen-glyphsheet.mjs                 # → pdf-out/glyphsheet-*.svg + pdf-out/glyphsheet.tsv
//   node gen-glyphsheet.mjs --from=layout   # 待确认的直接从 pdf-layout.json 取（含花边框正文）
//   node gen-glyphsheet.mjs --apply=x.tsv   # 把填好的 TSV 写进 校对.db 的 glyph_fix（confirmed_by=human）
//
// 为什么值得一做：这些字形在矢量层是干净的，渲染出来一眼就认得——
// 「，」被逐类 OCR 读成 9、「。」读成 O、年份区间的「～」留成空，都是这么看出来的。
// **纯 Node，不起浏览器。**
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { openDb, loadGlyphFixes, recordGlyphFixes } from "./checkdb.mjs";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
);
const DICT = flags.dict ?? "testdata/500/glyphdict.json";
const COLS = Number(flags.cols ?? 10);
const ROWS = Number(flags.rows ?? 12);

const db = openDb();

// ── --apply：把填好的 TSV 写回库
if (flags.apply) {
  const rows = [];
  const ignored = [];
  for (const line of (await readFile(flags.apply, "utf8")).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [key, ch] = line.split("\t");
    if (!key || !ch || !ch.trim()) continue;
    // 「-」= 这压根不是字（拍号分数线、引导点、八度点被归错类），
    // 别给它编一个字，标成 ignored 让它从待补表里退场。
    if (ch.trim() === "-") ignored.push(key.trim());
    else rows.push({ shape_key: key.trim(), char: ch.trim(), source: "human" });
  }
  const st = db.prepare(`UPDATE glyph_fix SET confirmed_by='human', confirmed_at=? WHERE shape_key=?`);
  recordGlyphFixes(db, rows);
  const now = new Date().toISOString();
  for (const r of rows) st.run(now, r.shape_key);
  const ig = db.prepare(`UPDATE unread_glyph SET status='ignored', updated_at=? WHERE shape_key=?`);
  for (const k of ignored) ig.run(now, k);
  db.close();
  console.log(`写入 glyph_fix ${rows.length} 条（confirmed_by=human），标成「不是字」${ignored.length} 条`);
  process.exit(0);
}

const dict = JSON.parse(await readFile(DICT, "utf8"));
const fixes = loadGlyphFixes(db);
const repOf = (k) => dict.classes[k]?.g ?? k;
const dictChar = new Map();
for (const c of Object.values(dict.classes)) if (c.char) dictChar.set(c.key, c.char);
const charOf = (k) => fixes[k] ?? fixes[repOf(k)] ?? dictChar.get(k) ?? null;

// 取哪一批待确认的字形，两条路：
//  - 默认：`unread_glyph` 表（relayout --db 落库，形状键 + 实例数 + 首现页 + 角色）。
//  - `--from=layout`：直接扫 pdf-layout.json 里**所有**文本的未定类。花边框正文的缺字
//    多半进不了 `unread_glyph`（那张表是重排那条路落的），可它们正是最该人工看一眼的
//    ——剩下的高频缺字里，单个弯引号「“」「”」字典里只有成对的那一版（7.9×5.4），
//    形状对不上，模糊匹配（gen-glyphfuzzy）救不了，只能人眼定案。
let rows;
if (flags.from === "layout") {
  const { pages } = JSON.parse(await readFile(flags.layout ?? "pdf-layout.json", "utf8"));
  const acc = new Map();
  const scan = (chars, page, role) => {
    for (const c of chars ?? []) {
      if (charOf(c.key) || !dict.classes[c.key]?.d) continue;
      const e = acc.get(c.key) ?? { shape_key: c.key, instances: 0, first_page: page, role, guess_char: null };
      e.instances++;
      acc.set(c.key, e);
    }
  };
  for (const p2 of pages) {
    for (const b of p2.storyBoxes ?? []) for (const l of b.lines ?? []) scan(l.chars, p2.page, "story");
    for (const l of p2.textLines ?? []) scan(l.chars, p2.page, "text");
    if (p2.header) scan(p2.header.chars, p2.page, "header");
    for (const sg of p2.songs ?? []) {
      for (const l of [sg.numberRun, sg.titleRun, sg.keyMeterRun, ...(sg.creditRuns ?? [])]) if (l) scan(l.chars, p2.page, "credit");
      for (const y of sg.systems ?? []) for (const l of [...(y.chordLines ?? []), ...(y.lyricLines ?? [])]) scan(l.chars, p2.page, "lyric");
    }
  }
  rows = [...acc.values()].sort((a, b) => b.instances - a.instances);
} else {
  rows = db
    .prepare(`SELECT shape_key, instances, first_page, role, guess_char FROM unread_glyph WHERE status='pending' ORDER BY instances DESC`)
    .all()
    .filter((r) => !charOf(r.shape_key) && dict.classes[r.shape_key]?.d);
}
db.close();
console.log(`仍未定的形状类 ${rows.length}，实例 ${rows.reduce((a, r) => a + r.instances, 0)}`);
if (!rows.length) process.exit(0);

// 上下文：这个字形所在行长什么样（未定的位置标成 ⟦?⟧）。光看轮廓分不出
// 「.」「·」「。」这类圆点，得看它落在哪句话里、贴不贴基线。
const LAYOUT = flags.layout ?? "pdf-layout.json";
const ctx = new Map();
{
  const { pages } = JSON.parse(await readFile(LAYOUT, "utf8"));
  const want = new Set(rows.map((r) => r.shape_key));
  const scan = (chars, page) => {
    for (let i = 0; i < chars.length; i++) {
      if (!want.has(chars[i].key) || ctx.has(chars[i].key)) continue;
      const near = chars.slice(Math.max(0, i - 8), i + 9);
      ctx.set(chars[i].key, {
        page,
        text: near.map((c, k) => (near[k] === chars[i] ? "⟦?⟧" : charOf(c.key) ?? "□")).join(""),
        geom: `${chars[i].w.toFixed(1)}x${chars[i].h.toFixed(1)}`,
      });
    }
  };
  for (const p2 of pages) {
    for (const b of p2.storyBoxes) for (const l of b.lines) scan(l.chars, p2.page);
    for (const l of p2.textLines) scan(l.chars, p2.page);
    if (p2.header) scan(p2.header.chars, p2.page);
    for (const sg of p2.songs) {
      for (const l of [sg.numberRun, sg.titleRun, sg.keyMeterRun, ...sg.creditRuns]) if (l) scan(l.chars, p2.page);
      for (const y of sg.systems) for (const l of [...y.chordLines, ...y.lyricLines]) scan(l.chars, p2.page);
    }
  }
}

await mkdir("pdf-out", { recursive: true });
const CELL = 78;
const per = COLS * ROWS;
const esc = (t) => String(t).replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c]);
const sheets = Math.ceil(rows.length / per);
for (let s = 0; s < sheets; s++) {
  const part = rows.slice(s * per, (s + 1) * per);
  const parts = [];
  part.forEach((r, i) => {
    const cls = dict.classes[r.shape_key];
    const [x0, y0, x1, y1] = cls.bbox;
    const w = Math.max(x1 - x0, 0.01);
    const h = Math.max(y1 - y0, 0.01);
    const k = Math.min(46 / w, 46 / h);
    const cx = (i % COLS) * CELL + 12;
    const cy = Math.floor(i / COLS) * CELL + 12;
    parts.push(
      `<rect x="${cx}" y="${cy}" width="${CELL - 8}" height="${CELL - 8}" fill="none" stroke="#ccc"/>` +
        `<g transform="translate(${cx + (CELL - 8) / 2},${cy + 50}) scale(${k},${-k}) translate(${-(x0 + x1) / 2},${-y0})"><path d="${cls.d}" fill="#000"/></g>` +
        `<text x="${cx + 3}" y="${cy + 64}" font-size="8" fill="#666">${esc(`${s * per + i + 1} ${r.role ?? ""} ×${r.instances}`)}</text>` +
        `<text x="${cx + 3}" y="${cy + 72}" font-size="8" fill="#a00">${esc(r.guess_char ? `猜:${r.guess_char}` : `p${r.first_page ?? "?"}`)}</text>`,
    );
  });
  const W = COLS * CELL + 16;
  const H = ROWS * CELL + 24;
  await writeFile(
    `pdf-out/glyphsheet-${String(s + 1).padStart(2, "0")}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>`,
  );
}
await writeFile(
  "pdf-out/glyphsheet.tsv",
  "# 形状键\t字（填这一列）\t序号\t角色\t实例\t首现页\t机器猜测\t尺寸\t上下文\n" +
    rows
      .map((r, i) =>
        [r.shape_key, "", i + 1, r.role ?? "", r.instances, r.first_page ?? "", r.guess_char ?? "",
         ctx.get(r.shape_key)?.geom ?? "", ctx.get(r.shape_key)?.text ?? ""].join("\t"),
      )
      .join("\n"),
);
console.log(`→ pdf-out/glyphsheet-01..${String(sheets).padStart(2, "0")}.svg（每页 ${per} 格，按实例数降序）`);
console.log("→ pdf-out/glyphsheet.tsv（填第二列后 node gen-glyphsheet.mjs --apply=pdf-out/glyphsheet.tsv）");
