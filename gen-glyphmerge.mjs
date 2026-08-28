// 形状类归并：把**同一个字形**被切成好几个形状类的那些合起来，标注取齐。
//
//   npm run build:cli && node gen-glyphdict.mjs && node gen-glyphocr.mjs && node gen-glyphmerge.mjs
//   node gen-glyphmerge.mjs --dry     # 只看报告，不写字典
//
// 为什么需要：`shapeKey` 把轮廓按高度归一到 50 格再 `Math.round` 取整。一个汉字有上千个
// 坐标，页面上同一个字印在不同位置时坐标差着零点零几个点——单看每个坐标都不影响取整，
// 但上千个里总有一两个正好卡在 .5 上翻过去，键就变了。实测全书 16190 个形状类里，
// 按 32×32 签名归并只剩 12345 组：**近四千个类是同一个字形的分身**。
//
// 分身本身不致命（各自学各自的字），坏在**分身可能学到不同的字**：011 首第 3 段
// 「晨光著现」印了两遍，两个「著」的轮廓一模一样（32×32 签名逐位相同、路径 501 段
// 只差末位四舍五入），却分属两个类，一个被投成「着」一个被投成「著」，同一段里
// 前后不一。全书这样的冲突组有 26 个。
//
// 归并要**挡住细长条**：签名按 max(w,h) 等比缩放，「一」（10.4×0.4）、目录的引导点行、
// 注解框的「十」字纹样边压扁之后都是同一条横带，签名撞在一起。真正的字近方，
// 按 min/max ≥ 0.25 一卡就分开了（实测不卡的话会把 81 个类错并成一组）。
//
// 纯 Node，不起浏览器。
import { readFile, writeFile } from "node:fs/promises";
import { loadCli, openPdf, loadCorpus, readSongGt, xmlLyricVerses } from "./scripts/node-harness.mjs";

const DICT = "testdata/500/glyphdict.json";
const dry = process.argv.includes("--dry");
const cli = await loadCli();
const { doc, OPS } = await openPdf();
const dict = JSON.parse(await readFile(DICT, "utf8"));
const cls = new Map();
for (const c of Object.values(dict.classes)) cls.set(c.key, c);

/** 细长条不参与归并：签名等比压扁之后它们全长一个样。 */
const slim = (c) => Math.min(c.w, c.h) / Math.max(c.w, c.h, 0.01) < 0.25;

// `gen-glyphdict` 归并时已经把代表键写进了每个类的 `g` 字段，直接用，不必再扫一遍全书。
// 只有拿旧字典（没有 `g`）来跑时才回落到扫页面算签名。
const hasG = [...cls.values()].some((c) => c.g);
const sigOf = new Map();
const pagesOf = new Map(); // key → 出现在哪几页（票数打平时按 GT 再投一次）
if (hasG) {
  for (const c of cls.values()) if (!slim(c)) sigOf.set(c.key, c.g ?? c.key);
} else {
  for (let pn = 1; pn <= doc.numPages; pn++) {
    const g = await doc.getPage(pn);
    const vp = await cli.extractVectorPage(g, OPS);
    g.cleanup();
    for (const o of vp.objs) {
      const k = cli.shapeKey(o.data);
      const c = cls.get(k);
      if (!c || slim(c)) continue;
      (pagesOf.get(k) ?? pagesOf.set(k, new Set()).get(k)).add(pn);
      if (!sigOf.has(k)) sigOf.set(k, cli.encodeSig(cli.shapeSig(o.data)));
    }
  }
}

/**
 * 票数打平时回到 GT 语料再投一次：候选字里在全书歌词/标题中出现得多的那个胜。
 *
 * 只在**实例数打平**（4:4 这种，同一个字画两遍）时才走到这里，所以判据可以简单，
 * 但必须保守：赢家要**至少两倍**于第二名才算数，否则返回 null 让调用方保留原判。
 * 归并一改就是全书几十处一起改，宁可留着一处不一致，也别整批改错。
 *
 * **别把这条路放宽**：按字频投票会一律选中常用字，异体字/生僻字永远输——「祂 vs 衪」
 * 它就会投出「祂」。之所以还安全，是因为两者签名本就不同、根本进不了同一组
 * （实测全书 3 组签名冲突全被 ±12% 尺寸闸挡住）。真要放宽同组判据，这里得跟着重想。
 *
 * `ks` 这几个类出现在哪几页本可以拿来缩小语料范围，但常走的那条路（字典带 `g` 字段）
 * 根本不扫页面、没有页信息，所以一律按全书字频算。
 */
function gtVote(ks, cands) {
  if (cands.length < 2) return cands[0] ?? null;
  const n = cands.map((ch) => [ch, (gtText.match(new RegExp(ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length]);
  n.sort((a, b) => b[1] - a[1]);
  if (!n[0][1]) return null;
  return n[0][1] >= Math.max(1, n[1][1]) * 2 ? n[0][0] : null;
}

/** GT 语料的全部歌词与标题，连成一串供 `gtVote` 数字频。 */
const gtText = await (async () => {
  const { songs } = await loadCorpus();
  const parts = [];
  for (const song of songs.values()) {
    parts.push(song.title ?? "");
    const gt = await readSongGt(song);
    if (gt.musicxml) parts.push([...xmlLyricVerses(gt.musicxml).values()].join(""));
  }
  return parts.join("\n");
})();

const groups = new Map();
for (const [k, s] of sigOf) (groups.get(s) ?? groups.set(s, []).get(s)).push(k);

let merged = 0;
let filled = 0;
let filledInst = 0;
let fixed = 0;
let fixedInst = 0;
const ties = [];
const tieBroken = [];
for (const ks of groups.values()) {
  if (ks.length < 2) continue;
  // 组内还要**尺寸相近**：签名是等比缩放的，大一号的同形字（标题里的字）签名一样，
  // 但它们本来就是两回事，字典按尺寸分类更准。
  const ref = cls.get(ks[0]);
  if (ks.some((k) => Math.abs(cls.get(k).h - ref.h) > ref.h * 0.12 || Math.abs(cls.get(k).w - ref.w) > ref.w * 0.12)) continue;
  merged++;
  const votes = new Map();
  for (const k of ks) {
    const c = cls.get(k);
    if (c.char) votes.set(c.char, (votes.get(c.char) ?? 0) + c.count);
  }
  if (!votes.size) continue;
  const rank = [...votes].sort((a, b) => b[1] - a[1]);
  let win = rank[0][0];
  if (rank.length > 1 && rank[0][1] === rank[1][1]) {
    // 类里的实例数打平（同一个字画两遍，4:4 这种），回到 GT 再投一次
    const w = gtVote(ks, [...votes.keys()]);
    if (!w) {
      // 还是分不出：宁可留着这一处差异，也别把全书几十处一起改错
      ties.push(rank.map(([ch, n]) => `${ch}:${n}`).join(" / "));
      continue;
    }
    win = w;
    tieBroken.push(`${rank.map(([ch, n]) => `${ch}:${n}`).join(" / ")} → ${w}`);
  }
  for (const k of ks) {
    const c = cls.get(k);
    if (!c.char) {
      c.char = win;
      c.source = "merge";
      filled++;
      filledInst += c.count;
    } else if (c.char !== win) {
      c.char = win;
      c.source = "merge";
      fixed++;
      fixedInst += c.count;
    }
  }
}

console.log(
  `形状类 ${cls.size}（细长条 ${[...cls.values()].filter(slim).length} 不参与），按签名分 ${groups.size} 组，其中 ${merged} 组不止一个类\n` +
    `  标注取齐：改 ${fixed} 类（实例 ${fixedInst}）\n` +
    `  由同组兄弟补上标注：${filled} 类（实例 ${filledInst}）\n` +
    `  实例数打平、回到 GT 投出来的：${tieBroken.length} 组${tieBroken.length ? "　" + tieBroken.join("　") : ""}\n` +
    `  两轮都打平、保持原样：${ties.length} 组${ties.length ? "　" + ties.join("　") : ""}`,
);
if (!dry) {
  await writeFile(DICT, JSON.stringify(dict));
  console.log(`→ ${DICT}`);
}
