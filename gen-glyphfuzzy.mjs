// 形近补字：把仍读不出的形状类，用 32×32 签名匹配到字典里**已经认得的同一个字**。
//
//   npm run build:cli && node gen-glyphfuzzy.mjs        # 写 校对.db 的 glyph_fix
//   node gen-glyphfuzzy.mjs --dry                       # 只出报告
//   node gen-glyphfuzzy.mjs --tol=28 --tolMulti=10      # 调阈值
//
// 为什么需要这一件：`shapeKey` 把轮廓按高度归一到 50 格再取整，**一个字印小一号、
// 或者笔画粗细差一点，键就变了**。注解正文的字号是 6.5~10.5pt（谱面歌词 10.4pt），
// 于是同一个「(」在注解里拿到的键与歌词里的不同，字典明明认得却查不到——
// 花边框正文 16105 字里读不出的 565 个，一大半是这种「字典里有、只是键对不上」。
//
// 判据三条，缺一不可（拿全书标定）：
//   1. **尺寸相近**（宽高各 ±25%）。签名是等比缩放的，大一号的同形字签名一样，
//      光靠签名会把标题字与正文字混作一谈。放到 25% 而不是归并那道 12%，
//      是因为这里本来就要跨字号匹配。
//   2. **签名距离够近**，**按字符长度分档**：
//      - 单字符（标点、括号、汉字）`d ≤ tol`（默认 32）。这类形状特异，实测 20~32 区间
//        的最优仍稳稳是同一个字符（`)` 一类就有 32 个实例落在 d=24）。
//      - 窄高的（括号、`！`、`；`）另给 `tolTall`（默认 40）：它们在 32×32 网格上只占
//        窄窄一条，同一个字形跨字号的签名差得比近方字形大。判别边际照样管着。
//      - 多字符（整行合成的 path，「1862」「出版」那种）`d ≤ tolMulti`（默认 12）。
//        **数字形近，这一档必须严**：实测「1862」的次优是「1892」、「434」的次优是「404」，
//        阈值一放宽就串味。
//   3. **判别边际**：次优若是**另一个字符**且距离只差 8 以内，整类弃掉——分不清就别猜。
//
// 参照库只取已标注的类。**它自己得先干净**：`gen-storyocr` 曾把 11 个窄高的括号类
// 标成「。」（3.0×9.3 的括号读成句号，而真正的「。」只有 3.1×3.1），那些错标一旦进了
// 参照库就会顺着模糊匹配扩散出去。所以这里额外挡一道「句读点不能落在高字形上」。
//
// **纯 Node，不起浏览器。** 与 `gen-storyocr.mjs`（整行送 OCR）是补字的两条路：
// 那条认字典里**没有**的字，这条认字典里**已经有、只是键对不上**的字。
import { readFile } from "node:fs/promises";
import { loadCli, openPdf, eachPage } from "./scripts/node-harness.mjs";
import { openDb, loadGlyphFixes, recordGlyphFixes } from "./scripts/checkdb.mjs";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
);
const TOL = Number(flags.tol ?? 32);
const TOL_MULTI = Number(flags.tolMulti ?? 12);
const TOL_TALL = Number(flags.tolTall ?? 40);
const MARGIN = Number(flags.margin ?? 8);
const SIZE_TOL = 0.25;
/** 尺寸闸的绝对下限（pt）：极小字形按比例卡太死。 */
const SIZE_ABS = Number(flags.sizeAbs ?? 0.6);
const dry = "dry" in flags;

const cli = await loadCli();
const { doc, OPS } = await openPdf();
const dict = JSON.parse(await readFile(flags.dict ?? "testdata/500/glyphdict.json", "utf8"));
const db = openDb();
const fixes = loadGlyphFixes(db);
const charOf = (k) => fixes[k] ?? dict.classes[k]?.char ?? null;

/** 只占字身下部的句读点：它们的墨迹必然矮，落在高字形上一定是错标。 */
const LOW_PUNCT = /^[。，、．·,.]+$/;
/**
 * **横向**细长条不参与匹配（两边都不参与）。
 *
 * 签名按 `max(w, h)` 等比缩放，「一」（10.4×0.4）、目录的引导点行、注解框的「十」字
 * 纹样边、减时线、增时线，压扁之后**全是同一条横带**，签名互相撞得一塌糊涂。
 * 不挡的话它们会串成一大团：实测有 230 个类被判成「一」，里头还有 18.5×3.0、51×4.9
 * 这种宽度——那根本不是字。
 *
 * **只挡横的，不挡竖的**（`gen-glyphmerge` 那条不分方向，这里要分）。窄高的括号、
 * `！`、`；` 的宽高比也在 0.25 上下（`(` 是 2.8×11.3 → 0.248），一并挡掉的话
 * 恰好把最值钱的那批漏了——而竖直字形的签名是有区分度的，实测它们的次优仍稳稳是
 * 同一个字符。竖的只是要求距离更严（见 TOL_TALL）。
 */
const slimH = (v) => v.w > v.h && v.h / Math.max(v.w, 0.01) < 0.25;
/** 窄高的（括号、！、；那种）：形状有区分度，但比近方字形更容易撞，阈值收严一档。 */
const tall = (v) => v.h > v.w * 2.5;
/**
 * 「一」不收。歌词里的「一」在矢量层就是一条扁横线，与减时线/装饰线同形，
 * 项目早就试过把它捞回歌词（按宽度、或直接定案），两种都让歌词准确率不升反降
 * （86.9% → 72.7% / 85.9%）——捞回来的多半不是「一」，插进序列反而造成错位。
 * 既然那条路已经定案不走，这里也不能从后门把它放进来。
 */
const NEVER = new Set(["一"]);

// ── 扫全书：形状键 → 签名 + 尺寸
const seen = new Map();
await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (g) => {
  const vp = await cli.extractVectorPage(g, OPS);
  for (const o of vp.objs) {
    const k = cli.shapeKey(o.data);
    if (seen.has(k)) continue;
    seen.set(k, { sig: cli.shapeSig(o.data), w: o.bbox.w, h: o.bbox.h });
  }
});
console.log(`扫到形状类 ${seen.size}`);

// ── 参照库：已标注、且标注与字形对得上的类
const known = [];
let dropped = 0;
for (const [k, v] of seen) {
  const ch = charOf(k);
  if (!ch) continue;
  // 句读点不该落在高字形上（真正的「。」只有 3.1×3.1）
  if (LOW_PUNCT.test(ch) && v.h > 6) {
    dropped++;
    continue;
  }
  if (slimH(v) || NEVER.has(ch)) {
    dropped++;
    continue;
  }
  known.push({ k, ch, ...v });
}
console.log(`参照库 ${known.length} 类（剔除细长条 / 句读点落在高字形上 / 「一」共 ${dropped} 类）`);

// ── 未定的类，逐个找最近邻
const unknown = [...seen].filter(([k]) => !charOf(k));
console.log(`未定的类 ${unknown.length}`);
const take = [];
const ambiguous = [];
const tooFar = [];
let slimSkipped = 0;
for (const [k, me] of unknown) {
  if (slimH(me)) {
    slimSkipped++;
    continue;
  }
  let best = null;
  let second = null;
  for (const kn of known) {
    // 尺寸闸留一个**绝对下限**：极小的字形（中点 1.2×1.0 对字典里的 1.7×1.6）
    // 只差半个点，按比例算却是 30%，一律按比例会把它们全卡掉。
    if (Math.abs(kn.w - me.w) > Math.max(Math.max(kn.w, me.w) * SIZE_TOL, SIZE_ABS)) continue;
    if (Math.abs(kn.h - me.h) > Math.max(Math.max(kn.h, me.h) * SIZE_TOL, SIZE_ABS)) continue;
    const d = cli.sigDistance(me.sig, kn.sig);
    if (!best || d < best.d) {
      second = best;
      best = { d, ch: kn.ch };
    } else if (!second || d < second.d) second = { d, ch: kn.ch };
  }
  if (!best) continue;
  const multi = [...best.ch].length > 1;
  const tol = multi ? TOL_MULTI : tall(me) ? TOL_TALL : TOL;
  const row = { k, ch: best.ch, d: best.d, w: me.w, h: me.h, multi, second };
  if (best.d > tol) tooFar.push(row);
  else if (second && second.ch !== best.ch && second.d <= best.d + MARGIN) ambiguous.push(row);
  else take.push(row);
}
console.log(`\n采纳 ${take.length} 类；因歧义弃 ${ambiguous.length}；超阈值弃 ${tooFar.length}；细长条不参与 ${slimSkipped}`);

// 采纳了哪些字
const byChar = new Map();
for (const r of take) byChar.set(r.ch, (byChar.get(r.ch) ?? 0) + 1);
console.log(
  "采纳的字（按类数）:",
  [...byChar].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([c, n]) => `${c}:${n}`).join(" "),
);
console.log("\n距离最大的 10 条（人工抽查用）:");
for (const r of [...take].sort((a, b) => b.d - a.d).slice(0, 10))
  console.log(`  d=${String(r.d).padStart(3)} →「${r.ch}」 ${r.w.toFixed(1)}x${r.h.toFixed(1)}  次优 d=${r.second?.d ?? "-"}「${r.second?.ch ?? ""}」`);
if (ambiguous.length) {
  console.log("\n分不清而弃掉的（前 10）:");
  for (const r of ambiguous.slice(0, 10)) console.log(`  ${r.w.toFixed(1)}x${r.h.toFixed(1)}  「${r.ch}」d=${r.d}  vs 「${r.second.ch}」d=${r.second.d}`);
}

// --why：按「注解里的实例数」排序，说明每个仍未定的类卡在哪一条判据上
if ("why" in flags) {
  const j = JSON.parse(await readFile("pdf-layout.json", "utf8"));
  const inStory = new Map();
  for (const s2 of j.pages) for (const b of s2.storyBoxes ?? []) for (const l of b.lines ?? []) for (const c of l.chars ?? []) {
    if (charOf(c.key)) continue;
    inStory.set(c.key, (inStory.get(c.key) ?? 0) + 1);
  }
  const why = new Map();
  for (const r of tooFar) why.set(r.k, { ...r, why: `最优「${r.ch}」d=${r.d} 超阈值` });
  for (const r of ambiguous) why.set(r.k, { ...r, why: `「${r.ch}」d=${r.d} vs 「${r.second.ch}」d=${r.second.d} 分不清` });
  const rows = [...inStory].map(([k, n]) => ({ k, n, ...(why.get(k) ?? {}) })).sort((a, b) => b.n - a.n);
  const noCand = rows.filter((r) => !r.why);
  console.log(`\n注解里仍未定 ${rows.length} 类 / ${rows.reduce((a, r) => a + r.n, 0)} 实例`);
  console.log(`  其中横向细长条或压根没候选的 ${noCand.length} 类 / ${noCand.reduce((a, r) => a + r.n, 0)} 实例`);
  console.log("  实例最多的 20 类:");
  for (const r of rows.slice(0, 20))
    console.log(`    ×${String(r.n).padStart(2)} ${r.w ? `${r.w.toFixed(1)}x${r.h.toFixed(1)}` : "细长条/无候选"}  ${r.why ?? ""}`);
}

if (dry) {
  console.log("\n--dry：没有写库。");
  db.close();
  process.exit(0);
}
recordGlyphFixes(db, take.map((r) => ({ shape_key: r.k, char: r.ch, source: "fuzzy" })));
db.close();
console.log(`\n→ 校对.db 的 glyph_fix 写入 ${take.length} 条（source=fuzzy；人工确认过的不覆盖）`);
