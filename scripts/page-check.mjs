// 分页版面的**几何判据**：`.jpwabc` 与文本谱两种格式、展开 / 原样两档共用一套。
//
//   npm run build && node scripts/page-check.mjs            # 断言
//   node scripts/page-check.mjs --write-baseline            # 认可当前数字，写基线
//   node scripts/page-check.mjs --one=沧海 --fmt=pu          # 只跑曲名含「沧海」的文本谱
//
// 判据（容差同 line-check.mjs::OVERLAP_TOL）：
//   P1  叶子越出纸面
//   P2  同页相邻谱行（`system` 标记的块）墨迹盒相压——且横向确有交叠
//   P3  谱面以外的东西（页脚曲名、页码、标题块）压到谱面上
//   P4  同一条谱行、同一段歌词里相邻两个字相压
//
// 谱行块与歌词靠 PageItem.classes 认（`system` / `lyric`，见 layout.ts::layoutVertically、
// Lyric 构造函数与 pu/painter.ts::paintPage / paintSyllables）——构建会压缩类名，instanceof 用不上。
// 墨迹盒：文字取紧墨迹（见 probeInPage::inkOf），线与路径取 PageItem.bound。
// 断言的是「不得多于基线」，外加点名曲子的定点断言。
//
// 输出两层：各格式 × 判据的违例总数（不得高于基线 testdata/page-check-baseline.json），
// 与定点断言（用户点名的两首：P2 = 0、P4 = 0）。任一层不过就退出码 1。
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { serveDist, launchPage, loadApp } from "./harness.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const BASELINE = flags.baseline ?? "testdata/page-check-baseline.json";
const TOL = 0.5;
/** 定点断言：这两首的**文本谱**在这两条判据上必须为 0（用户点名的相压都出在文本谱）。
 *  `.jpwabc` 的沧海一声笑展开档另有 2 处 P4：源文件里 `W1` 写过了第 15 小节、又有一行
 *  `W1-6@15:` 给同一批音符挂「啦」，两份词抢同一个音——那是歌词归属的语义，不是排版。 */
const PINNED = { 沧海一声笑: ["P2", "P4"], 我今来就你: ["P2", "P4"] };
const PINNED_FMT = "pu";

/** 配置矩阵。`expanded` 只有投影片比例；原样档字号一般不会那么大，只跑默认字号。 */
const CONFIGS = [
  { key: "展开 16:9", expanded: true, ratio: "16:9", font: 0 },
  { key: "展开 16:9 44pt", expanded: true, ratio: "16:9", font: 44 },
  { key: "展开 4:3", expanded: true, ratio: "4:3", font: 0 },
  { key: "展开 4:3 44pt", expanded: true, ratio: "4:3", font: 44 },
  { key: "原样 长图", expanded: false, paper: "长图", font: 0 },
  { key: "原样 A4", expanded: false, paper: "A4", font: 0 },
];

async function fixtures() {
  const out = [];
  const td = "testdata";
  for (const f of await readdir(join(td, "pu"))) {
    if (/\.(pu|jps)$/i.test(f)) out.push({ name: basename(f, extname(f)), fmt: "pu", path: join(td, "pu", f) });
  }
  for (const d of await readdir(td, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "pu" || d.name === "500") continue;
    const files = await readdir(join(td, d.name)).catch(() => []);
    if (files.includes("gt.tomato.pu")) out.push({ name: d.name, fmt: "pu", path: join(td, d.name, "gt.tomato.pu") });
    const jp = files.find((f) => /\.jpwabc$/i.test(f));
    if (jp) out.push({ name: d.name, fmt: "jpwabc", path: join(td, d.name, jp) });
  }
  return out
    .filter((f) => !flags.fmt || f.fmt === flags.fmt)
    .filter((f) => !flags.one || String(flags.one).split(",").some((s) => f.name.includes(s)));
}

/** 页面里跑：按当前配置排好后量四条判据。返回 { pages, P1..P4: [{page, amount, what}] }。 */
function probeInPage(TOL) {
  const app = window.__app;
  const painter = app.docFormat === "pu" ? app.puPainter : app.painter;
  const res = { pages: 0, P1: [], P2: [], P3: [], P4: [] };
  if (!painter) return res;
  const pages = painter.layout.pages;
  res.pages = pages.length;
  const hasCls = (it, c) => it.classes && it.classes.has(c);
  const up = (it, c) => { for (let p = it; p; p = p.parent) if (hasCls(p, c)) return p; return null; };
  // 文字取**紧墨迹**（Font.charBound）：字体的 ascent/descent 盒太松——连谱号那类字形高达
  // 4 em，多声部谱组的盒子被它撑得压到上下两组，歌词的 descent 也会「压」到页脚上。
  // **横向也要真墨迹**：TextFrame.inkBound 那个开关只收纵向、横向仍是 0..字宽（字面框），
  // 汉字字面框左右自带留白，按它判「相压」的其实是框贴框（「日|子」框叠 4pt、墨迹恰好相碰）。
  // SMuFL 字形（SmuflText）自己重写了 bound，照用。
  const inkOf = (it) => {
    if (typeof it.text !== "string" || !it.font?.charBound || !it.text.trim() || it.smufl) return it.bound;
    const b = it.font.charBound(it.text);
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  };
  const absBox = (it) => {
    const b = inkOf(it), o = it.pos(null);
    return { l: o.x + b.left, t: o.y + b.top, r: o.x + b.right, b: o.y + b.bottom };
  };
  const empty = (x) => !(x.r - x.l > 0.01 && x.b - x.t > 0.01);
  const union = (a, x) => (a ? { l: Math.min(a.l, x.l), t: Math.min(a.t, x.t), r: Math.max(a.r, x.r), b: Math.max(a.b, x.b) } : { ...x });
  const hOverlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l);
  const r1 = (v) => Math.round(v * 10) / 10;
  pages.forEach((pg, pi) => {
    const { w, h } = painter.pageSize(pi);
    const systems = new Map(); // system item → box
    const lyrics = new Map(); // lyric item → { box, sys }
    const others = [];
    const walk = (it) => {
      if (it.children && it.children.length) { for (const c of it.children) walk(c); return; }
      const box = absBox(it);
      if (empty(box)) return;
      const out = Math.max(-box.l, -box.t, box.r - w, box.b - h);
      if (out > TOL) res.P1.push({ page: pi, amount: r1(out), what: String(it.text ?? "").slice(0, 12) });
      const sys = up(it, "system");
      if (sys) systems.set(sys, union(systems.get(sys), box));
      else others.push({ box, what: String(it.text ?? "").slice(0, 12) });
      const lyr = up(it, "lyric");
      if (lyr && sys) {
        const cur = lyrics.get(lyr);
        lyrics.set(lyr, { box: union(cur?.box, box), sys, text: (cur?.text ?? "") + String(it.text ?? "") });
      }
    };
    walk(pg);
    // P2：同页相邻谱行
    const boxes = [...systems.values()].sort((a, b) => a.t - b.t);
    for (let i = 1; i < boxes.length; i++) {
      const a = boxes[i - 1], b = boxes[i];
      const ov = a.b - b.t;
      if (ov > TOL && hOverlap(a, b) > TOL) res.P2.push({ page: pi, amount: r1(ov), what: `行${i}/${i + 1}` });
    }
    // P3：谱面外的东西压到谱面
    for (const o of others) {
      for (const s of boxes) {
        const v = Math.min(o.box.b, s.b) - Math.max(o.box.t, s.t);
        if (v > TOL && hOverlap(o.box, s) > TOL) { res.P3.push({ page: pi, amount: r1(v), what: o.what }); break; }
      }
    }
    // P4：同一谱行、同一基线（段）上相邻两个字相压
    const bySysLine = new Map();
    for (const { box, sys, text } of lyrics.values()) {
      const k = sys;
      if (!bySysLine.has(k)) bySysLine.set(k, []);
      bySysLine.get(k).push({ box, text });
    }
    for (const list of bySysLine.values()) {
      const rows = [];
      for (const it of list.sort((a, b) => a.box.b - b.box.b)) {
        const row = rows.find((r) => Math.abs(r.y - it.box.b) < 1);
        if (row) row.items.push(it); else rows.push({ y: it.box.b, items: [it] });
      }
      for (const row of rows) {
        const xs = row.items.sort((a, b) => a.box.l - b.box.l);
        for (let i = 1; i < xs.length; i++) {
          const ov = xs[i - 1].box.r - xs[i].box.l;
          if (ov > TOL) res.P4.push({ page: pi, amount: r1(ov), what: `${xs[i - 1].text}|${xs[i].text}` });
        }
      }
    }
  });
  return res;
}

const list = await fixtures();
if (!list.length) { console.error("没有匹配的语料"); process.exit(1); }
const { port, close: closeServer } = await serveDist();
const { browser, page, errors } = await launchPage({ viewport: { width: 1280, height: 900 }, quiet: true });
// 每次进页前清掉持久化设置：上一首切过的档与纸不该串到下一首
await page.addInitScript(() => { try { localStorage.clear(); } catch { /* 无痕 */ } });

const rows = [];
for (const fx of list) {
  await loadApp(page, port, { wait: 600 });
  const b64 = Buffer.from(await readFile(fx.path)).toString("base64");
  const name = basename(fx.path);
  await page.evaluate(({ b64, name }) => {
    window.__app.importBytes(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), name);
  }, { b64, name });
  for (const cfg of CONFIGS) {
    const got = await page.evaluate(({ cfg, fmt, TOL, probeSrc }) => {
      const app = window.__app;
      app.setProfile(cfg.expanded);
      if (fmt === "pu") {
        app.applyRenderSettings(cfg.expanded
          ? { puExpandedRatio: cfg.ratio, puExpandedFontSize: cfg.font }
          : { puPaper: cfg.paper, puFontSize: cfg.font });
      } else if (cfg.expanded) {
        const [pageW, pageH] = cfg.ratio === "4:3" ? [720, 540] : [960, 540];
        app.applyRenderSettings({ pageW, pageH, fontSize: cfg.font || 28 });
      } else {
        app.applyRenderSettings({ jpPaper: cfg.paper, fontSize: cfg.font || 28 });
      }
      // eslint-disable-next-line no-new-func
      return new Function("TOL", `return (${probeSrc})(TOL);`)(TOL);
    }, { cfg, fmt: fx.fmt, TOL, probeSrc: probeInPage.toString() });
    rows.push({ fx, cfg, got });
  }
}

// ── 汇总
const JUDGES = ["P1", "P2", "P3", "P4"];
const totals = {};
for (const { fx, got } of rows) {
  for (const j of JUDGES) totals[`${fx.fmt}.${j}`] = (totals[`${fx.fmt}.${j}`] ?? 0) + got[j].length;
}
console.log("曲子 | 格式 | 配置 | 页数 | P1 P2 P3 P4 | 最严重的几处");
for (const { fx, cfg, got } of rows) {
  const n = JUDGES.map((j) => got[j].length);
  if (n.every((v) => v === 0)) continue;
  const worst = JUDGES.flatMap((j) => got[j].map((v) => ({ j, ...v })))
    .sort((a, b) => b.amount - a.amount).slice(0, 3)
    .map((v) => `${v.j} p${v.page + 1} ${v.amount}pt ${v.what}`).join("；");
  console.log(`${fx.name} | ${fx.fmt} | ${cfg.key} | ${got.pages} | ${n.join(" ")} | ${worst}`);
}
console.log("\n违例总数：" + JSON.stringify(totals));

let bad = 0;
const fail = (m) => { console.log("  ✗ " + m); bad++; };

// 定点断言
console.log("\n【定点】");
for (const [song, judges] of Object.entries(PINNED)) {
  for (const { fx, cfg, got } of rows.filter((r) => r.fx.name === song && r.fx.fmt === PINNED_FMT)) {
    for (const j of judges) {
      if (got[j].length) fail(`${song}（${fx.fmt}，${cfg.key}）${j} ${got[j].length} 处，最大 ${Math.max(...got[j].map((v) => v.amount))}pt`);
    }
  }
}

// 基线门槛（只在全量跑时比，--one/--fmt 过滤时总数不可比）
const full = !flags.one && !flags.fmt;
if (flags["write-baseline"]) {
  if (!full) { console.error("--write-baseline 要全量跑（不能带 --one / --fmt）"); process.exit(1); }
  await writeFile(BASELINE, JSON.stringify({ totals }, null, 2) + "\n");
  console.log(`\n已写基线 ${BASELINE}`);
} else if (full) {
  console.log("\n【基线】");
  let base = null;
  try { base = JSON.parse(await readFile(BASELINE, "utf8")); } catch { console.log("  （没有基线文件，跳过；先跑 --write-baseline）"); }
  if (base) {
    for (const [k, v] of Object.entries(totals)) {
      const b = base.totals?.[k] ?? 0;
      if (v > b) fail(`${k} ${v} 处，多于基线 ${b}`);
      else if (v < b) console.log(`  ↓ ${k} ${b} → ${v}（可 --write-baseline 收紧）`);
    }
  }
}

// 「slur/tie 有一端不在本行」是简谱排版器展开反复时的既有提示（弧跨遍次被切开），不是本脚本要抓的
const real = errors.filter((e) => !/favicon|slur\/tie 有一端不在本行/.test(e));
if (real.length) { console.log("控制台报错：\n" + real.slice(0, 10).join("\n")); bad++; }
console.log(bad === 0 ? "\n✓ 全部通过" : `\n✗ ${bad} 项不过`);
await browser.close();
closeServer();
process.exit(bad === 0 ? 0 : 1);
