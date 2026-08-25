// 成书重排的**版面判据断言**：那些「排出来就是难看」的毛病，一条一条变成可执行的检查。
//
//   npm run build && node rebuild.mjs --book=…   # 先跑出底本
//   node line-check.mjs                          # 断言（不起浏览器）
//   node line-check.mjs --write-baseline         # 认可当前全书数字，写基线
//
// 底本两份，都由 rebuild.mjs 产出：
//   pdf-out/rebuild-lines.json     逐行事实（applybreaks.ts::describeLines）
//   pdf-out/rebuild-drawlist.json  逐页绝对坐标（段落词落位、歌词有没有压字）
//
// 输出两层：**全书基线门槛**（各档违例数不得高于 testdata/500/line-check-baseline.json）
// 与**定点断言**（用户点名的那十几首，逐条写死期望）。任一层不过就退出码 1。
import { readFile, writeFile } from "node:fs/promises";
import { makeMetrics } from "./scripts/textmetrics.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const OUTDIR = flags.out ?? "pdf-out";
const BASELINE = flags.baseline ?? "testdata/500/line-check-baseline.json";
const only = flags.one ? String(flags.one).split(",") : null;

const style = JSON.parse(await readFile(flags.style ?? "testdata/500/bookstyle.json", "utf8"));
const metrics = await makeMetrics(style);

const lineDoc = JSON.parse(await readFile(`${OUTDIR}/rebuild-lines.json`, "utf8"));
const drawDoc = JSON.parse(await readFile(`${OUTDIR}/rebuild-drawlist.json`, "utf8"));

// ── 判据的阈值。都是「明显难看」那一档，不是审美偏好。
const SHORT_RATIO = 0.4;      // 中间行短于版心容量的这个比例 = 过短
const LAST_PAIR_RATIO = 0.6;  // 末两行的长度比低于此 = 不均匀
const LONG_HEAD_BEATS = 2;    // 行首这么长的音 + 标点 = 上一句的收尾被甩到了行首
const OVERLAP_TOL = 0.5;      // 歌词墨迹相压超过这么多 pt 才算（pen 位置有舍入）

/** 一档检查的违例集合。 */
const kinds = {
  L1: "行首残小节里只有休止",
  L2: "中间行过短（一小节 / 不足容量四成）",
  L3: "行首是半拍休止、且弱起与本曲其余行不一致",
  L4: "行首是带标点的长音（上一句的收尾）",
  L5: "末两行长短悬殊",
  L6: "段落词挂出版心",
  L7: "相邻歌词墨迹相压",
};
const bad = Object.fromEntries(Object.keys(kinds).map((k) => [k, []]));
let substSkipped = 0; // 因字体回退判不了的相邻歌词对（见 L7）
const hit = (k, id, note) => bad[k].push({ id, note });

// ────────────────────────────────────────────── 逐行事实（L1~L5）
for (const song of lineDoc.songs) {
  if (only && !only.includes(song.id)) continue;
  const ls = song.lines ?? [];
  if (!ls.length) continue;
  const cap = song.cells || 0;

  ls.forEach((l, i) => {
    const last = i === ls.length - 1;
    // L1 半小节休止起头（整小节休止不算——完整的休止小节归上一行或下一行都行）
    if (!l.head.hasNote && !l.head.full) hit("L1", song.id, `第 ${i + 1} 行：${l.head.dur} 拍休止 + 小节线`);
    // L2 中间行过短
    if (!last && !l.section) {
      if (l.bars <= 1 && l.beats < (l.head.full ? 4 : 8))
        hit("L2", song.id, `第 ${i + 1} 行只有 ${l.bars} 小节 / ${l.cells} 格`);
      else if (cap > 0 && l.cells < cap * SHORT_RATIO)
        hit("L2", song.id, `第 ${i + 1} 行 ${l.cells} 格 / 容量 ${cap}`);
    }
    // L4 行首带标点的长音
    if (i > 0 && l.head.firstBeats >= LONG_HEAD_BEATS && l.head.firstPunct > 0)
      hit("L4", song.id, `第 ${i + 1} 行以 ${l.head.firstBeats} 拍「${l.tail.text ? "" : ""}」长音 + 标点起头`);
  });

  // L3 **行首那个半拍休止**：它是下一句起唱前的留白，本该留在上一行行尾。
  // 但「半拍休止 + 半拍音符」这种弱起本身没问题——只要与本曲多数行一样长就行
  //（用户口径：为了工整，各行都以同样长的不完整小节起头是对的）。判据与
  // phrase.ts::headPenalty 的那一条一一对应，这里只是把它验出来。
  const heads = ls.map((l) => Number(l.head.dur.toFixed(3)));
  if (heads.length > 1) {
    const tally = new Map();
    for (const b of heads) tally.set(b, (tally.get(b) ?? 0) + 1);
    const mode = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    ls.forEach((l, i) => {
      if (i === 0) return; // 第一行的弱起就是本曲的弱起，断句挪不动它
      if (!(l.head.rest && l.head.firstDur > 0 && l.head.firstDur <= 0.5)) return;
      if (Math.abs(l.head.dur - mode) > 0.01)
        hit("L3", song.id, `第 ${i + 1} 行以半拍休止起头、弱起 ${l.head.dur} 拍，本曲多数是 ${mode} 拍`);
    });
  }

  // L5 每段末两行（段界把曲子分段；末段就是曲末）
  const segs = [[]];
  for (const l of ls) {
    segs[segs.length - 1].push(l);
    if (l.section) segs.push([]);
  }
  for (const seg of segs) {
    if (seg.length < 2) continue;
    const [a, b] = seg.slice(-2);
    const lo = Math.min(a.cells, b.cells), hi = Math.max(a.cells, b.cells);
    if (hi > 0 && lo / hi < LAST_PAIR_RATIO) hit("L5", song.id, `末两行 ${a.cells} / ${b.cells} 格`);
  }
}

// ────────────────────────────────────────────── 版面几何（L6/L7）
/** 版心左右缘（对开页镜像，与 rebuild.mjs::contentEdges 同一口径）。 */
function edges(pageNo) {
  const m = style.page.margin;
  const odd = pageNo % 2 === 1;
  return { left: odd ? m.inner : m.outer, right: style.page.w - (odd ? m.outer : m.inner) };
}
const songOfPage = (dp) => dp.meta?.songs?.[0]?.id ?? "?";
for (const dp of drawDoc.pages) {
  if (dp.meta?.kind !== "score") continue;
  const id = songOfPage(dp);
  if (only && !only.includes(id)) continue;
  const { left, right } = edges(dp.pageNo);
  for (const it of dp.items) {
    if (it.t !== "text") continue;
    if (it.role === "sectionWord") {
      const x0 = Math.min(...it.xs);
      const x1 = Math.max(...it.xs) + metrics.advance("sectionWord", [...it.text].pop(), it.size);
      if (x0 < left - 0.5 || x1 > right + 0.5)
        hit("L6", id, `p${dp.pageNo}「${it.text}」x ${x0.toFixed(1)}~${x1.toFixed(1)}，版心 ${left.toFixed(1)}~${right.toFixed(1)}`);
    }
  }
  // 同一基线上的歌词逐个比对右缘与下一个的左缘
  const rows = new Map();
  for (const it of dp.items) {
    if (it.t !== "text" || it.role !== "lyric") continue;
    const k = Math.round(it.y * 2) / 2;
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(it);
  }
  for (const [, row] of rows) {
    row.sort((a, b) => Math.min(...a.xs) - Math.min(...b.xs));
    for (let i = 0; i + 1 < row.length; i++) {
      const a = row[i], b = row[i + 1];
      // 按**墨迹**算，不按 advance——全角标点的墨只占方框的一角，照 advance 算处处是「压字」
      const aCh = [...a.text].pop();
      const bCh = [...b.text][0];
      // 书里字体没有的字（半角 CJK 标点 `｡､`）由 pdfwrite 换成全角等价字画出来，
      // 画出来的比排版器量的宽——那是**字体回退**的账，不是排版判据的账，这里判不了，跳过。
      // 全书 121 处都是这一类，另见 docs/实现/矢量PDF识别.md。
      if (!metrics.hasGlyph("lyric", aCh) || !metrics.hasGlyph("lyric", bCh)) { substSkipped++; continue; }
      const aEnd = Math.max(...a.xs) + (metrics.ink("lyric", aCh, a.size)?.right ?? 0);
      const bStart = Math.min(...b.xs) + (metrics.ink("lyric", bCh, b.size)?.left ?? 0);
      if (aEnd - bStart > OVERLAP_TOL)
        hit("L7", id, `p${dp.pageNo}「${a.text}」压住「${b.text}」${(aEnd - bStart).toFixed(1)}pt`);
    }
  }
}

// ────────────────────────────────────────────── 定点断言（用户点名的那批）
/** 每条：曲号 → [档, 期望违例数（一律 0）]，另加几条只对这首成立的具体期望。 */
const SPOT = {
  "020": ["L1"],
  "022": ["L2"], "319": ["L2"], "374": ["L2"], "378": ["L2"], "390": ["L2"], "419": ["L2"],
  "024": ["L6"], "371": ["L6"], "381": ["L6"],
  "125": ["L5"], "404": ["L5"],
  "372": ["L1", "L3"], "402": ["L1", "L3"],
  "373": ["L4"],
  "376": ["L7"],
};
const spotFails = [];
for (const [id, ks] of Object.entries(SPOT)) {
  if (only && !only.includes(id)) continue;
  if (!lineDoc.songs.some((s) => s.id === id)) continue; // 没排这首就不判
  for (const k of ks) {
    const v = bad[k].filter((x) => x.id === id);
    if (v.length) spotFails.push(`${id} ${k}（${kinds[k]}）：${v.map((x) => x.note).join("；")}`);
  }
}
// 373《跟随我》：每一句都收在「跟随我」的长音上，四行一样长。
// 第 3 行例外——那一句的收尾是「生命，」，它的标点顺延到了弧尾那个无词音符上（tail 文本为空）。
{
  const s = lineDoc.songs.find((x) => x.id === "373");
  if (s && (!only || only.includes("373"))) {
    const tails = s.lines.map((l) => l.tail.text.replace(/[，。！？…；、：]$/, ""));
    const me = tails.filter((t) => t === "我").length;
    const cs = s.lines.map((l) => l.cells);
    const spread = Math.max(...cs) - Math.min(...cs);
    if (me < 3) spotFails.push(`373 应有 ≥3 行收在「我」上，实际：${tails.join(" / ")}`);
    if (spread > 2) spotFails.push(`373 四行应一样长，实际 ${cs.join(" / ")} 格`);
  }
}

// ────────────────────────────────────────────── 汇总
const counts = Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, v.length]));
const songsWith = Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, new Set(v.map((x) => x.id)).size]));
console.log(`底本：${lineDoc.songs.length} 首 / ${drawDoc.pages.length} 页${substSkipped ? `（字体回退跳过 ${substSkipped} 对歌词）` : ""}`);
for (const k of Object.keys(kinds)) {
  const sample = bad[k].slice(0, 3).map((x) => `${x.id} ${x.note}`).join("｜");
  console.log(`  ${k} ${kinds[k]}：${counts[k]} 处 / ${songsWith[k]} 首${sample ? `　例：${sample}` : ""}`);
}

if ("write-baseline" in flags) {
  await writeFile(BASELINE, JSON.stringify({ songs: lineDoc.songs.length, counts }, null, 2) + "\n");
  console.log(`→ 基线已写入 ${BASELINE}`);
  process.exit(0);
}

let fail = false;
if (spotFails.length) {
  fail = true;
  console.log(`\n✗ 定点断言 ${spotFails.length} 条不过：`);
  for (const f of spotFails) console.log(`   ${f}`);
} else if (!only) {
  console.log("\n✓ 定点断言全过");
}

// 全书基线门槛：只在**排了整本**时才判（单曲试排的数字没有可比性）
let base = null;
try { base = JSON.parse(await readFile(BASELINE, "utf8")); } catch { /* 还没有基线 */ }
if (base && !only && lineDoc.songs.length >= base.songs * 0.9) {
  const worse = Object.keys(kinds).filter((k) => counts[k] > (base.counts[k] ?? 0));
  if (worse.length) {
    fail = true;
    console.log(`✗ 全书基线回退：${worse.map((k) => `${k} ${base.counts[k] ?? 0}→${counts[k]}`).join("，")}`);
  } else {
    const better = Object.keys(kinds).filter((k) => counts[k] < (base.counts[k] ?? 0));
    const gain = better.map((k) => `${k} ${base.counts[k]}→${counts[k]}`).join("，");
    console.log(better.length ? `✓ 全书基线变好（${gain}），记得 --write-baseline` : "✓ 全书基线持平");
  }
} else if (!base) {
  console.log("（还没有基线文件，跑 --write-baseline 立一个）");
}
process.exit(fail ? 1 : 0);
