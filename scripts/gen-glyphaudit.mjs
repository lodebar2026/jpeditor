// 「同字多形」审计：把**同一个字底下形状明显不一样的类**捞出来给人看。
//
//   node gen-glyphaudit.mjs                 # → pdf-out/glyphaudit-*.svg + pdf-out/glyphaudit.tsv
//   node gen-glyphaudit.mjs 祂 他           # 只看这几个字
//   node gen-glyphaudit.mjs --apply=x.tsv   # 填好的 TSV 写进 校对.db 的 glyph_fix
//
// 为什么需要这一件：**GT 自举投票标不出 GT 里没有的字**。
// 第 5 首页面上真印的是「衪」（原书错字，写「祂」才对），可 GT 语料里「衪」是 0 次
// ——500/*.musicxml 有 739 个「祂」/ 0 个「衪」，.jpwabc 里那 4 个「衪」全在 .Title，
// 而标题 GT 取的是文件名（一律写「祂」）。于是真印「衪」的形状类只可能拿到「祂」这一票，
// 3 分 100% 一致直接定案。它有了 char 就**永远不进 unread_glyph**（那张表只收读不出的），
// gen-glyphsheet 的人工确认表里也看不见——错字就这么永远藏住了。
//
// 判据：同一个字、**同一尺寸族内**（同族才可比：不同字号的同一个字轮廓段数本来就不同），
// 段数偏离本族中位数超过 SEG_TOL 的类记为可疑。实测「祂」名下 11×10.9 那族四个类
// 一律 segs=86（示字旁），而 11×10.6 的 14322tm-1ihdlun 是 segs=94——多出来的 8 段
// 正是衣字旁比示字旁多的那一笔，画出来一眼就是「衪」。
//
// **纯 Node，不起浏览器。**
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { openDb, loadGlyphFixes, recordGlyphFixes } from "./checkdb.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const only = new Set(args.filter((a) => !a.startsWith("--")));
const DICT = flags.dict ?? "testdata/500/glyphdict.json";
const COLS = Number(flags.cols ?? 8);
const ROWS = Number(flags.rows ?? 8);
/** 段数偏离本尺寸族中位数多少算可疑。0.04 时全书 ~200 类，人扫得完。 */
const SEG_TOL = Number(flags.tol ?? 0.04);
/** 尺寸族的宽容度：宽高各在 ±12% 内算同族（与 gen-glyphmerge 的尺寸闸一致）。 */
const SIZE_TOL = 0.12;

const db = openDb();

// ── --apply：把填好的 TSV 写回库（与 gen-glyphsheet 同一套口径）
if (flags.apply) {
  const rows = [];
  for (const line of (await readFile(flags.apply, "utf8")).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [key, ch] = line.split("\t");
    if (!key || !ch || !ch.trim() || ch.trim() === "=") continue; // 「=」= 维持原判
    rows.push({ shape_key: key.trim(), char: ch.trim(), source: "human" });
  }
  recordGlyphFixes(db, rows);
  const now = new Date().toISOString();
  const st = db.prepare(`UPDATE glyph_fix SET confirmed_by='human', confirmed_at=? WHERE shape_key=?`);
  for (const r of rows) st.run(now, r.shape_key);
  db.close();
  console.log(`写入 glyph_fix ${rows.length} 条（confirmed_by=human）`);
  process.exit(0);
}

const dict = JSON.parse(await readFile(DICT, "utf8"));
const fixes = loadGlyphFixes(db);
const charOf = (k) => fixes[k] ?? dict.classes[k]?.char ?? null;
const segsOf = (d) => (d.match(/[MLC]/g) ?? []).length;
const dim = (c) => [c.bbox[2] - c.bbox[0], c.bbox[3] - c.bbox[1]];

// 字 → 它名下的所有形状类
const byChar = new Map();
for (const c of Object.values(dict.classes)) {
  const ch = charOf(c.key);
  if (!ch || !c.d) continue;
  if (only.size && !only.has(ch)) continue;
  const a = byChar.get(ch) ?? [];
  a.push(c);
  byChar.set(ch, a);
}

// 同尺寸族内比段数
const suspects = [];
for (const [ch, list] of byChar) {
  if (list.length < 2) continue;
  // 按尺寸聚族：贪心，与已有族的代表宽高各在 ±12% 内就并进去
  const fams = [];
  for (const c of [...list].sort((a, b) => dim(b)[1] - dim(a)[1])) {
    const [w, h] = dim(c);
    const f = fams.find((f) => Math.abs(f.w - w) <= f.w * SIZE_TOL && Math.abs(f.h - h) <= f.h * SIZE_TOL);
    if (f) f.items.push(c);
    else fams.push({ w, h, items: [c] });
  }
  for (const f of fams) {
    if (f.items.length < 2) continue;
    const segs = f.items.map((c) => segsOf(c.d)).sort((a, b) => a - b);
    const mid = segs[segs.length >> 1];
    if (!mid) continue;
    for (const c of f.items) {
      const s = segsOf(c.d);
      const dev = Math.abs(s - mid) / mid;
      if (dev < SEG_TOL) continue;
      // 本族里最像「正统写法」的那个（段数 = 中位、实例最多），拿来并排给人比
      const peer = f.items.filter((x) => segsOf(x.d) === mid).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
      suspects.push({ ch, cls: c, segs: s, mid, dev, peer, fam: `${f.w.toFixed(1)}x${f.h.toFixed(1)}` });
    }
  }
}
suspects.sort((a, b) => b.dev - a.dev || (b.cls.count ?? 0) - (a.cls.count ?? 0));
db.close();

console.log(`可疑类 ${suspects.length}（同字同尺寸族内段数偏离中位 ≥${(SEG_TOL * 100).toFixed(0)}%），涉及 ${new Set(suspects.map((s) => s.ch)).size} 个字`);
if (!suspects.length) process.exit(0);
for (const s of suspects.slice(0, 15))
  console.log(`  ${s.ch}  ${s.cls.key.padEnd(18)} segs=${s.segs}（本族中位 ${s.mid}，偏 ${(s.dev * 100).toFixed(0)}%）n=${s.cls.count ?? "?"} 族 ${s.fam}`);

// ── 对照表：可疑类与本族「正统写法」并排画，人一眼就分得出多的是哪一笔
await mkdir("pdf-out", { recursive: true });
const CELL = 108;
const esc = (t) => String(t).replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c]);
const glyph = (c, x, y, box) => {
  const [x0, y0, x1, y1] = c.bbox;
  const k = Math.min(box / Math.max(x1 - x0, 0.01), box / Math.max(y1 - y0, 0.01));
  return `<g transform="translate(${x},${y}) scale(${k},${-k}) translate(${-(x0 + x1) / 2},${-y0})"><path d="${c.d}" fill="#000"/></g>`;
};
const per = COLS * ROWS;
const sheets = Math.ceil(suspects.length / per);
for (let s = 0; s < sheets; s++) {
  const part = suspects.slice(s * per, (s + 1) * per);
  const parts = [];
  part.forEach((r, i) => {
    const cx = (i % COLS) * CELL + 8;
    const cy = Math.floor(i / COLS) * CELL + 8;
    const half = (CELL - 12) / 2;
    // 左＝可疑类，右＝本族正统写法（灰）
    parts.push(
      `<rect x="${cx}" y="${cy}" width="${CELL - 12}" height="${CELL - 12}" fill="none" stroke="#ccc"/>` +
        `<line x1="${cx + half}" y1="${cy}" x2="${cx + half}" y2="${cy + CELL - 12}" stroke="#eee"/>` +
        glyph(r.cls, cx + half / 2, cy + 58, 44) +
        (r.peer ? glyph(r.peer, cx + half + half / 2, cy + 58, 44) : "") +
        `<text x="${cx + 3}" y="${cy + 72}" font-size="8" fill="#666">${esc(`${s * per + i + 1} 「${r.ch}」×${r.cls.count ?? "?"}`)}</text>` +
        `<text x="${cx + 3}" y="${cy + 82}" font-size="8" fill="#a00">${esc(`segs ${r.segs} vs ${r.mid}`)}</text>` +
        `<text x="${cx + 3}" y="${cy + 92}" font-size="7" fill="#999">${esc(r.cls.key)}</text>`,
    );
  });
  const W = COLS * CELL + 16;
  const H = ROWS * CELL + 16;
  await writeFile(
    `pdf-out/glyphaudit-${String(s + 1).padStart(2, "0")}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>`,
  );
}
await writeFile(
  "pdf-out/glyphaudit.tsv",
  "# 形状键\t真正的字（填这一列；「=」表示维持原判）\t序号\t现判\t实例\t段数\t本族中位\t偏离\t尺寸族\n" +
    suspects
      .map((r, i) => [r.cls.key, "", i + 1, r.ch, r.cls.count ?? "", r.segs, r.mid, `${(r.dev * 100).toFixed(0)}%`, r.fam].join("\t"))
      .join("\n"),
);
console.log(`→ pdf-out/glyphaudit-01..${String(sheets).padStart(2, "0")}.svg（左＝可疑，右＝本族正统写法）`);
console.log("→ pdf-out/glyphaudit.tsv（填第二列后 node gen-glyphaudit.mjs --apply=pdf-out/glyphaudit.tsv）");
