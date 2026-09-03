// 字形字典自举：把全书的字形形状类逐个定出字符，产出 testdata/500/glyphdict.json。
//
// 转曲 PDF 没有文字层，但同一个字的轮廓在整本书里逐位相同 → 全书 30 万个字形只有约
// 9 千个形状类。给这 9 千类各定一次字符，识别就变成纯查表，**一次 OCR 都不用跑**。
//
// 标注来源与可信度：
//   manual —— testdata/500/glyph-seed.tsv，按字形肉眼判定的种子（十个曲号数字 + 音符族）。
//             只用来把页映射到曲目，是自举的起点。
//   gt     —— 拿 568 首的 .jpwabc 语料回标：GT 的歌词/标题/音符序列与页面的形状序列对齐，
//             对上哪个位置就把那个形状记一票。多首投票，票数够且够一致才采纳。
//
// 迭代：第一轮只吃「长度完全相等」的序列（无歧义直配），拿到一批字符后，
// 后面几轮用已知字符当锚点做 DP 对齐，把长度不等的序列里的空档也标出来。
//
//   npm run build:cli && node gen-pagemap.mjs && node gen-glyphdict.mjs
import { readFile, writeFile } from "node:fs/promises";
import { loadCli, openPdf, loadCorpus, mergePagemapEntries, collectSongItems } from "./node-harness.mjs";

const SEED = "testdata/500/glyph-seed.tsv";
const PAGEMAP = "testdata/500/pagemap.json";
const OUT = "testdata/500/glyphdict.json";
const ROUNDS = Number(process.env.ROUNDS ?? 4);

const cli = await loadCli();
const { doc, OPS } = await openPdf();
const { songs } = await loadCorpus();
const pm = JSON.parse(await readFile(PAGEMAP, "utf8"));

/** 种子标注（肉眼判形）。 */
const seed = new Map();
for (const line of (await readFile(SEED, "utf8")).split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue;
  const [k, c] = line.split("\t");
  if (k && c) seed.set(k, c);
}

const sample = [];
for (let p = 40; p <= 200; p += 4) {
  const g = await doc.getPage(p);
  sample.push(await cli.extractVectorPage(g, OPS));
  g.cleanup();
}
const profile = cli.detectProfile(sample, "hymn500");

// ── 一次性抽取：每首歌的音符序列 / 各段歌词序列 / 标题序列（都存形状键）
console.log("抽取页面字形序列…");
const byId = new Map();
for (const m of mergePagemapEntries(pm.map)) {
  const a = byId.get(m.id) ?? [];
  a.push(m);
  byId.set(m.id, a);
}
/** 形状类：key → { count, h, w, d } */
const classes = new Map();
const noteOf = (o) => {
  // lyricYi 按几何定案（见 inventory.ts 10c），不进字典——它的轮廓与减时线等扁横条撞键
  if (o.cls === "lyricYi") return "\u0001YI";
  const key = cli.shapeKey(o.obj.data);
  const c = classes.get(key);
  if (c) c.count++;
  else {
    // bbox 记路径**自身坐标系**下的紧包围盒：`d` 是原样导出的路径，
    // 要把它渲染出来（OCR 兜底、重排取原字形）就得知道该怎么摆。
    const rb = cli.pathBoundsRaw(o.obj.data);
    const bb = o.obj.bbox;
    classes.set(key, {
      count: 1,
      h: bb.h,
      w: bb.w,
      d: cli.toSvgPath(o.obj.data),
      bbox: rb ? [rb.x0, rb.y0, rb.x1, rb.y1].map((v) => Math.round(v * 100) / 100) : null,
      // 32×32 签名，归并同一字形的分身用。**细长条不记**：签名按 max(w,h) 等比缩放，
      // 「一」、目录引导点行、注解框的纹样边压扁之后都是同一条横带，会撞在一起。
      sig: Math.min(bb.w, bb.h) / Math.max(bb.w, bb.h, 0.01) < 0.25 ? null : cli.encodeSig(cli.shapeSig(o.obj.data)),
    });
  }
  return key;
};
const invCache = new Map();
const items = await collectSongItems({ cli, doc, OPS, profile, byId, songs, keyOf: noteOf, invCache });
console.log(`  ${items.length} 首，形状类 ${classes.size}`);

// 再扫一遍全书，把**所有文字类对象**都注册进形状表。
// 上面按 pagemap 遍历只覆盖了乐谱页里跟曲目相关的那几路；目录、首句索引、
// 花边框注解这些没有 GT 的文字从未进过字典，读出来只会是一片乱码。
// 它们自举不了，但注册进来之后可以由 gen-glyphocr.mjs 每类送一次 OCR 补上。
{
  const TEXTISH = new Set([
    "note", "lyric", "chord", "title", "songNumber", "category", "footer",
    "tocEntry", "storyText", "textLine", "verseNum", "sectionWord", "credit", "keyMeter",
  ]);
  invCache.clear();
  let extra = 0;
  for (let pn = 1; pn <= doc.numPages; pn++) {
    const g = await doc.getPage(pn);
    const vp = await cli.extractVectorPage(g, OPS);
    g.cleanup();
    const inv = cli.classifyPage(vp, profile);
    for (const o of inv.objs) {
      if (o.dup || !TEXTISH.has(o.cls)) continue;
      const before = classes.size;
      noteOf(o);
      if (classes.size > before) extra++;
    }
  }
  console.log(`  全书文字类形状表：${classes.size} 类（其中 ${extra} 类只出现在无 GT 的页上）`);
}

// ── 形状类归并：**同一个字形常被切成好几个键**，合起来再自举。
//
// `shapeKey` 把轮廓按高度归一到 50 格再取整。一个汉字上千个坐标，页面上同一个字印在
// 不同位置时坐标差着零点零几个点——单看每个坐标都不影响取整，上千个里总有一两个正好
// 卡在 .5 上翻过去，键就变了。全书 16234 个类按 32×32 签名只剩一万来组，
// **近四千个类是同一字形的分身**。
//
// 分身各学各的字就会打架：011 首「晨光著现」印两遍，两处的路径 501 段只差末位四舍五入、
// 签名逐位相同，却一个被投成「着」一个「著」，同一段里前后不一。
// **合了再投**，票攒到一处，这类冲突从根上没有了（自举完还会再多认出一批字）。
//
// 组内还要**尺寸相近**（±12%）：签名等比缩放，标题里大一号的同形字签名也一样，
// 但那本来就该分开记（渲染取原字形时要用各自的 d）。
const rep = new Map();
{
  const bySig = new Map();
  for (const [k, c] of classes) if (c.sig) (bySig.get(c.sig) ?? bySig.set(c.sig, []).get(c.sig)).push(k);
  let groups = 0;
  let folded = 0;
  for (const ks of bySig.values()) {
    if (ks.length < 2) continue;
    ks.sort((a, b) => classes.get(b).count - classes.get(a).count); // 实例最多的那个当代表
    const ref = classes.get(ks[0]);
    let n = 0;
    for (const k of ks.slice(1)) {
      const c = classes.get(k);
      if (Math.abs(c.h - ref.h) > ref.h * 0.12 || Math.abs(c.w - ref.w) > ref.w * 0.12) continue;
      rep.set(k, ks[0]);
      n++;
    }
    if (n) {
      groups++;
      folded += n;
    }
  }
  console.log(`  按签名归并：${groups} 组，${folded} 个类并进代表类（形状类 ${classes.size} → ${classes.size - folded}）`);
}
/** 原始键 → 代表键。字典最后**每个原始键都要写一条**，运行时按自己的键查得到。 */
const R = (k) => rep.get(k) ?? k;
/** 归并前的逐键信息（d / bbox / 各自的实例数），写字典时要用。
 *  **要浅拷贝**：下面把分身的实例数并进代表，共享同一个对象的话原始条目也跟着被改。 */
const rawClasses = new Map([...classes].map(([k, c]) => [k, { ...c }]));
// 票投给代表：把各分身的实例数并过去，代表之外的从投票表里撤掉
for (const [k, r] of rep) {
  const a = classes.get(r);
  const c = classes.get(k);
  if (a && c) a.count += c.count;
  classes.delete(k);
}
// 语料里记下的键也一并换成代表键
const mapKeys = (a) => a.map(R);
for (const it of items) {
  it.notes = mapKeys(it.notes);
  it.title = mapKeys(it.title);
  it.chords = mapKeys(it.chords);
  it.credits = mapKeys(it.credits);
  it.category = mapKeys(it.category);
  it.verses = it.verses.map(mapKeys);
  it.footers = it.footers.map((f) => ({ ...f, keys: mapKeys(f.keys) }));
}

// ── 自举
/** key → char（已定）。 */
const known = new Map([...seed].map(([k, v]) => [R(k), v]));
for (const [k] of known) if (!classes.has(k)) classes.set(k, { count: 0, h: 0, w: 0, d: "" });
const sourceOf = new Map();
for (const k of known.keys()) sourceOf.set(k, "manual");

/** 用当前字典把形状序列翻成字符数组（未知为 null）。 */
const decode = (keys) => keys.map((k) => known.get(k) ?? null);

/** 对齐 GT 字符串与页面形状序列，把对上的位置记票（对齐判据见 src/pdflayout/align.ts）。 */
function alignVote(gtStr, keys, votes) {
  const dec = decode(keys);
  const r = cli.alignSeq(gtStr, dec);
  if (!r) return;
  const vote = (k, ch, w) => {
    if (known.has(k)) return;
    const v = votes.get(k) ?? new Map();
    v.set(ch, (v.get(ch) ?? 0) + w);
    votes.set(k, v);
  };
  // 直配一次记 3 分（无歧义），DP 对齐一次记 1 分
  const w = r.direct ? 3 : 1;
  for (const { i, j } of r.pairs) vote(keys[j], gtStr[i], w);
}

for (let round = 1; round <= ROUNDS; round++) {
  const votes = new Map();
  for (const it of items) {
    alignVote(it.gtNotes, it.notes, votes);
    alignVote(it.gtTitle, it.title, votes);
    // 和弦来自 musicxml 的 <harmony>；页眉是曲目的分类名；页脚是「·书页码·」
    alignVote(it.gtChords, it.chords, votes);
    alignVote(it.gtCategory, it.category, votes);
    alignVote(it.gtCredit, it.credits, votes);
    for (const f of it.footers) alignVote(f.text, f.keys, votes);
    for (let v = 0; v < Math.min(it.gtVerses.length, it.verses.length); v++) {
      alignVote(it.gtVerses[v], it.verses[v], votes);
    }
  }
  // 采纳：票数够、且多数票占比够
  let added = 0;
  for (const [k, v] of votes) {
    let best = null;
    let bestN = 0;
    let total = 0;
    for (const [ch, n] of v) {
      total += n;
      if (n > bestN) {
        bestN = n;
        best = ch;
      }
    }
    // 加权票：直配一次记 3 分，DP 对齐一次记 1 分。3 分起采纳。
    // **宽扁的形状不收单字**：一个字再扁也扁不到宽是高的两倍半（「一」另有专门判据、
    // 故意不进字典）。那些是短圆滑线、减时线之类，投票时被挤到某个字上，
    // 收进字典就成了凭空多出的字（实测一个 10.6×3.0 的类被投成 `E`，
    // 全书和弦序列里凭空多出上百个 E，和弦准确率掉 1.5 个点）。
    // **「一」是例外**：它本来就扁（标题里的 16.2×3.9）。这条闸是拦「短圆滑线、减时线
    // 被投成某个字」的，不是拦「一」——挡住它，标题里的「一」就永远只能靠 OCR，
    // 而扁横条送行识别多半读成 `1`（实测 22 首标题因此把「一」读成了「1」）。
    const cls = classes.get(k);
    const flat = cls && cls.h > 0 && cls.w >= cls.h * 2.5 && best !== "一";
    if (best !== null && !flat && bestN >= 3 && bestN / total >= 0.7) {
      known.set(k, best);
      sourceOf.set(k, "gt");
      added++;
    }
  }
  const cov = [...classes.entries()].reduce((a, [k, c]) => a + (known.has(k) ? c.count : 0), 0);
  const totalInst = [...classes.values()].reduce((a, c) => a + c.count, 0);
  console.log(
    `第 ${round} 轮：新增 ${added}，已定 ${known.size}/${classes.size} 类，覆盖实例 ${(cov / totalInst * 100).toFixed(2)}%`,
  );
  if (!added) break;
}

// **每个原始键各写一条**（运行时按自己的键查表），字与来源取自它所属的代表类；
// d / bbox / 尺寸仍用各自的——渲染（OCR 兜底、重排取原字形）要的是这个键自己的轮廓。
// `g` 记代表键：gen-glyphocr 靠它一组只送一次 OCR，gen-glyphmerge 靠它回填。
const dict = { book: "hymn500", quant: 50, classes: {} };
for (const [key, c] of rawClasses) {
  const r = R(key);
  dict.classes[key] = {
    key,
    g: r === key ? undefined : r,
    char: known.get(r) ?? null,
    source: sourceOf.get(r) ?? null,
    count: c.count,
    h: Math.round(c.h * 100) / 100,
    w: Math.round(c.w * 100) / 100,
    bbox: c.bbox ?? null,
    d: c.d,
  };
}
for (const [k] of known) if (!dict.classes[k]) dict.classes[k] = { key: k, char: known.get(k), source: sourceOf.get(k) ?? null, count: 0, h: 0, w: 0, bbox: null, d: "" };
await writeFile(OUT, JSON.stringify(dict));

const defined = Object.values(dict.classes).filter((c) => c.char).length;
console.log(`→ ${OUT}：${Object.keys(dict.classes).length} 类，已定 ${defined}`);
