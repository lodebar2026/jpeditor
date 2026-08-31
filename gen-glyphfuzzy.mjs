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

/** d 串的各条子路径包围盒（只需 M 分段与坐标，指令字母当分隔符即可）。 */
const subBoxes = (d) =>
  d
    .split("M")
    .slice(1)
    .map((seg) => {
      const nums = (seg.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      const xs = nums.filter((_, i) => i % 2 === 0);
      const ys = nums.filter((_, i) => i % 2 === 1);
      return xs.length && ys.length
        ? { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
        : null;
    })
    .filter(Boolean);

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

// ── 第二条路：**上下文规则**补那些签名救不了的字
//
// 生卒年份之间的连接号：字典里 `-`/`—`/`～` 一个都没有（原书这个字形从没在别处出现过），
// 签名匹配无从下手。但它的上下文强到不用猜——**横条，两侧紧邻都是数字**：
// 全书 26 个这样的横条里 18 个两侧都是数字（`1872⟦?⟧1958`、`1483⟦?⟧1546`…），
// 画出来是直的实心横条，不是波浪线，所以是连字符不是「～」。
// 宽度按字身分档：不到 0.95 个字身是半角 `-`（实测 0.52~0.81），到了就是全角 `—`。
// （`gen-storyocr` 的注释里也记着「Martin Luther 1483-1546」的连字符是半角。）
//
// **同一趟还纠句读点的错标**（`source=rule-punct-shape`）：逐类 OCR 在这个尺寸上
// 只会瞎猜，把「，」读成 9 / J / 2、「、」读成 1（全书 117 个实例的顿号全标成了 1，
// 023 首那句「配得荣耀、尊贵、权柄」于是成了「配得荣耀1 1」——顿号不是锚点，
// 「尊贵」「权柄」两段也就跟着补不回来）。判据三条一起：
//   1. **矮**：墨迹高不到正文的 0.45（真的数字与字母都 ≥0.7）；
//   2. 当前读作的正是那几个「这个尺寸上不可能」的字符；
//   3. **一笔**（单条子路径）——挡住冒号那种两点、等号那种两横；
// 再按**宽高比**分族：逗号的钩窄高（1.5×2.6 → 0.58），顿号的撇宽扁（3.2×2.9 → 1.08）。
// 更扁的（6.3×1.6 → 3.9）是波浪号，交给 rule-dash 与人工确认表，这里不碰。
const SUSPECT_LABEL = /^[9J21]$/;
const punctShape = new Map(); // key → Map(char → 票数)
const ruleFills = new Map(); // key → Map(char → 票数)
{
  const j = JSON.parse(await readFile(flags.layout ?? "pdf-layout.json", "utf8"));
  const isDigit = (c) => c && /[0-9]/.test(c);
  const scan = (chars) => {
    const cs = chars ?? [];
    const hs = cs.map((c) => c.h).sort((a, b) => a - b);
    const body = hs[Math.floor(hs.length * 0.7)] || 1;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const now = charOf(c.key);
      if (now && SUSPECT_LABEL.test(now) && c.h <= body * 0.45) {
        const shape = dict.classes[c.key];
        const ratio = c.w / Math.max(c.h, 0.01);
        const want = ratio < 0.8 ? "，" : ratio < 1.6 ? "、" : null;
        if (want && shape?.d && subBoxes(shape.d).length === 1) {
          if (!punctShape.has(c.key)) punctShape.set(c.key, new Map());
          const v = punctShape.get(c.key);
          v.set(want, (v.get(want) ?? 0) + 1);
        }
      }
      if (now) continue;
      if (!(c.w > c.h * 3 && c.h < body * 0.25 && c.w > body * 0.4 && c.w < body * 1.3)) continue;
      if (!isDigit(cs[i - 1] && charOf(cs[i - 1].key)) || !isDigit(cs[i + 1] && charOf(cs[i + 1].key))) continue;
      const want = c.w / body < 0.95 ? "-" : "—";
      if (!ruleFills.has(c.key)) ruleFills.set(c.key, new Map());
      const v = ruleFills.get(c.key);
      v.set(want, (v.get(want) ?? 0) + 1);
    }
  };
  for (const p2 of j.pages) {
    for (const b of p2.storyBoxes ?? []) for (const l of b.lines ?? []) scan(l.chars);
    for (const l of p2.textLines ?? []) scan(l.chars);
    for (const sg of p2.songs ?? []) for (const l of sg.creditRuns ?? []) scan(l.chars);
  }
}
// 一个类的实例分属两族（宽高比骑在界上）就整类不动——分不清就别猜。
const punctShapeRows = [...punctShape]
  .map(([k, v]) => {
    const sorted = [...v].sort((a, b) => b[1] - a[1]);
    const tot = sorted.reduce((a, r) => a + r[1], 0);
    return { k, ch: sorted[0][0], n: sorted[0][1], tot, was: charOf(k) };
  })
  .filter((r) => r.n === r.tot);
if (punctShapeRows.length) {
  const byC = new Map();
  for (const r of punctShapeRows) byC.set(r.ch, (byC.get(r.ch) ?? 0) + r.n);
  console.log(
    `\n字形规则纠正句读点 ${punctShapeRows.length} 类 / ${punctShapeRows.reduce((a, r) => a + r.n, 0)} 实例：` +
      [...byC].map(([c, n]) => `「${c}」×${n}`).join(" "),
  );
}
const ruleRows = [...ruleFills].map(([k, v]) => {
  const [ch, n] = [...v].sort((a, b) => b[1] - a[1])[0];
  return { k, ch, n };
});
if (ruleRows.length) {
  const byC = new Map();
  for (const r of ruleRows) byC.set(r.ch, (byC.get(r.ch) ?? 0) + r.n);
  console.log(
    `\n上下文规则补字 ${ruleRows.length} 类 / ${ruleRows.reduce((a, r) => a + r.n, 0)} 实例` +
      `（年份区间连接号：${[...byC].map(([c, n]) => `「${c}」×${n}`).join(" ")}）`,
  );
}

// ── 第三条路：**字形规则**认冒号
//
// 这本书的「：」印成上下两个小圆点。它跟签名匹配无缘（未读的那 9 个小类各自只有
// 一两个实例、尺寸零散），更要命的是**字典里已经把它标错了**：636 个实例的那一类
// 被 GT 自举投票标成了「经」——署名行「作词：」在 GT 里对着「经」字的位置，
// 投票就那么定下来了，全书唯一一个「墨迹不到 1.4×4.1pt 却标着汉字」的类。
// 投票救不了自己，字形判据可以：**两条子路径、各自近圆、一般大、上下分离、
// 每点只占整体高的三成以内**。全书 14 个类照这条判下来全是冒号（4 个已标「：」、
// 1 个错标「经」、9 个未读），一个「？」「；」都没混进来——问号的钩占了大半个字身，
// 分号的下点带尾巴，两条比例闸各挡一个。
const COLON = "："; // 全角：524 个实例在「作词：」这种中文语境，与字典里已标注的那 4 类取齐
const isColonShape = (c) => {
  if (!c.d || !(c.w > 0 && c.h > 0)) return false;
  if (!(c.w / c.h > 0.2 && c.w / c.h < 0.6)) return false;
  const bs = subBoxes(c.d);
  if (bs.length !== 2) return false;
  const [a, b] = bs.sort((p, q) => p.y0 - q.y0);
  const aw = a.x1 - a.x0, ah = a.y1 - a.y0, bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  if (!(aw > 0 && ah > 0 && bw > 0 && bh > 0)) return false;
  if (!(aw / ah > 0.7 && aw / ah < 1.5 && bw / bh > 0.7 && bw / bh < 1.5)) return false; // 各自近圆
  if (!(aw / bw > 0.7 && aw / bw < 1.4 && ah / bh > 0.7 && ah / bh < 1.4)) return false; // 一般大
  if (Math.max(ah, bh) > c.h * 0.35) return false; // 点只占一小截（挡问号的钩）
  if (Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) > aw * 0.5) return false; // 上下对齐
  return b.y0 > a.y1; // 两点分开
};
const colonRows = Object.values(dict.classes)
  .filter((c) => isColonShape(c) && charOf(c.key) !== COLON)
  .map((c) => ({ k: c.key, was: charOf(c.key), n: c.count }));
if (colonRows.length)
  console.log(
    `\n字形规则认出冒号 ${colonRows.length} 类 / ${colonRows.reduce((a, r) => a + r.n, 0)} 实例` +
      `（原先：${colonRows.map((r) => `${r.was ?? "未读"}×${r.n}`).join(" ")}）`,
  );

// ── 第五条路：**数字块里夹着的标点**
//
// 生卒年与经文出处在矢量层常常是一个对象（「1483－」「1808～1889」「1:4」），
// 那件标点在块内部、不是独立字形，OCR 也读丢。判据（子路径按 x 聚成字符组、
// 组数减标点组数等于位数）写在 `glyphdict.ts::blockPunct`——`gen-storyocr`
// 补完字之后还要再走一遍同一条，所以放在那边共用。
const inBlockRows = [];
for (const c of Object.values(dict.classes)) {
  const ch = charOf(c.key);
  if (!ch || !c.d) continue;
  const text = cli.blockPunct(c.d, ch);
  if (text) inBlockRows.push({ k: c.key, ch: text, was: ch, n: c.count });
}
if (inBlockRows.length)
  console.log(
    `\n数字块里夹着的标点 ${inBlockRows.length} 类：${inBlockRows.slice(0, 8).map((r) => r.ch).join(" ")}${inBlockRows.length > 8 ? " …" : ""}`,
  );

// ── 第六条路：**西文的大小写与 0/o、1/l**
//
// 拉丁小字号那一族字典还很稀，自举投票分不开形状只差尺寸的那几对：
// 275「Charlotte Elliott」读成「Char10tte E1110tt」（l→1、o→0）、
// 294「Crosby」读成「Cr0Sby」。字形上分不开，**尺寸上分得开**：
//   - 同形的大小写（`o c s v w x z u`）差一个 x-height：拿同一行里
//     已经认得的小写（`acemnorsuvwxz`）与大写/数字/升部字母各取中位数当尺，
//     标成大写或 `0` 的那些，墨迹只到 x-height 就是小写。
//   - `1`、`l`、`i`：这套无衬线体的 `l` 就是一条竖，宽不到行高的两成（实测 0.10~0.12），
//     真数字 `1` 是 0.29~0.63；而**同样宽窄的竖条，一笔是 `l`、两笔（竖 + 上头一点）是 `i`**
//     ——275 的「Elliott」三个竖条一模一样，就靠这一条分出 `lli`。
// 一个类的**所有**实例都判可疑才改——同一个字形不会一会儿大写一会儿小写。
const CASE_PAIR = { "0": "o", O: "o", C: "c", S: "s", V: "v", W: "w", X: "x", Z: "z", U: "u" };
const X_LOW = new Set([..."acemnorsuvwxz"]);
const X_TALL = new Set([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789bdfhklt"]);
/** 窄竖条是 `l` 还是 `i`：一笔是 `l`，两笔且上头那笔又矮又在最上面的是 `i`。 */
const vertChar = (key, now) => {
  const cl = dict.classes[key];
  if (!cl?.d) return null;
  const bs = subBoxes(cl.d);
  const want = bs.length === 1 ? "l" : bs.length === 2 ? (() => {
    const [a, b] = [...bs].sort((p, q) => p.y0 - q.y0);
    const h = Math.max(...bs.map((x) => x.y1)) - Math.min(...bs.map((x) => x.y0));
    // PDF 系 y 朝上：点在上面（y 大的那段）且矮
    return b.y1 - b.y0 <= h * 0.3 && a.y1 - a.y0 >= h * 0.5 ? "i" : null;
  })() : null;
  return want && want !== now ? want : null;
};
const caseVote = new Map(); // key → { bad, all, want }
{
  const j = JSON.parse(await readFile(flags.layout ?? "pdf-layout.json", "utf8"));
  const med = (v) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : 0);
  const scan = (chars) => {
    const lat = (chars ?? []).filter((c) => {
      const t = charOf(c.key);
      return t && [...t].length === 1 && /[A-Za-z0-9]/.test(t);
    });
    if (lat.length < 4) return;
    const xh = med(lat.filter((c) => X_LOW.has(charOf(c.key))).map((c) => c.h));
    const cap = med(lat.filter((c) => X_TALL.has(charOf(c.key))).map((c) => c.h));
    const H = med(lat.map((c) => c.h));
    if (!(xh > 0 && cap > xh * 1.15)) return;
    for (const c of lat) {
      const ch = charOf(c.key);
      const want = /^[1lI]$/.test(ch) && c.w <= H * 0.2 ? vertChar(c.key, ch) : c.h <= xh * 1.12 && c.h <= cap * 0.9 ? CASE_PAIR[ch] : null;
      const rec = caseVote.get(c.key) ?? { bad: 0, all: 0, want: null };
      rec.all++;
      if (want) {
        rec.bad++;
        rec.want = want;
      }
      caseVote.set(c.key, rec);
    }
  };
  for (const p2 of j.pages) {
    for (const b of p2.storyBoxes ?? []) for (const l of b.lines ?? []) scan(l.chars);
    for (const l of p2.textLines ?? []) scan(l.chars);
    for (const sg of p2.songs ?? []) {
      for (const l of sg.creditRuns ?? []) scan(l.chars);
      if (sg.titleRun) scan(sg.titleRun.chars);
    }
  }
}
const caseRows = [...caseVote]
  .filter(([, r]) => r.want && r.bad === r.all)
  .map(([k, r]) => ({ k, ch: r.want, was: charOf(k), n: r.all }));
if (caseRows.length) {
  const by = new Map();
  for (const r of caseRows) by.set(`${r.was}→${r.ch}`, (by.get(`${r.was}→${r.ch}`) ?? 0) + r.n);
  console.log(`\n西文大小写 / 0o / 1l 纠正 ${caseRows.length} 类 / ${caseRows.reduce((a, r) => a + r.n, 0)} 实例：${[...by].map(([t, n]) => `${t}×${n}`).join(" ")}`);
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
recordGlyphFixes(db, [
  ...take.map((r) => ({ shape_key: r.k, char: r.ch, source: "fuzzy" })),
  ...ruleRows.map((r) => ({ shape_key: r.k, char: r.ch, source: "rule-dash" })),
  ...colonRows.map((r) => ({ shape_key: r.k, char: COLON, source: "rule-colon" })),
  ...punctShapeRows.map((r) => ({ shape_key: r.k, char: r.ch, source: "rule-punct-shape" })),
  ...inBlockRows.map((r) => ({ shape_key: r.k, char: r.ch, source: "rule-dash-inblock" })),
  ...caseRows.map((r) => ({ shape_key: r.k, char: r.ch, source: "rule-latin-case" })),
]);
db.close();
console.log(
  `\n→ 校对.db 的 glyph_fix 写入 ${take.length} 条（source=fuzzy）+ ${ruleRows.length} 条（source=rule-dash）` +
    ` + ${colonRows.length} 条（rule-colon）+ ${punctShapeRows.length} 条（rule-punct-shape）` +
    ` + ${inBlockRows.length} 条（rule-dash-inblock）+ ${caseRows.length} 条（rule-latin-case）；人工确认过的不覆盖`,
);
