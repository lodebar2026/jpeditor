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
import { loadCli, openPdf, loadCorpus, readSongGt, jpwSections, gtNoteDigits, gtLyricVerses, gtHarmonies, collectSongGlyphs, isCreditWordGlyph } from "./scripts/node-harness.mjs";

/** `.Title` 里的 `WordsByAndMusicBy`。**取最后一条非空的**：有的文件写了两条，
 *  第一条是空的；`=` 后面只吃横向空白，吃到换行就会把下一行整条卷进来。 */
function creditField(titleSec) {
  let out = "";
  for (const m of (titleSec ?? "").matchAll(/WordsByAndMusicBy[^\S\r\n]*=[^\S\r\n]*\{?([^}\r\n]*)\}?/g)) {
    if (m[1].trim()) out = m[1];
  }
  return out;
}

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
for (const m of pm.map) {
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
    classes.set(key, {
      count: 1,
      h: o.obj.bbox.h,
      w: o.obj.bbox.w,
      d: cli.toSvgPath(o.obj.data),
      bbox: rb ? [rb.x0, rb.y0, rb.x1, rb.y1].map((v) => Math.round(v * 100) / 100) : null,
    });
  }
  return key;
};
const bot = (o) => o.obj.bbox.y + o.obj.bbox.h;

const items = []; // { id, notes:[key], verses:[[key]], title:[key] }
const invCache = new Map();
for (const [id, entries] of byId) {
  const song = songs.get(id);
  if (!song?.jpwabc) continue;
  const notes = [];
  const verseRows = [];
  const title = [];
  const chords = [];
  const credits = [];
  const category = [];
  const footers = [];
  for (const e of entries) {
    let inv = invCache.get(e.page);
    if (!inv) {
      const g = await doc.getPage(e.page);
      const vp = await cli.extractVectorPage(g, OPS);
      g.cleanup();
      inv = cli.classifyPage(vp, profile);
      invCache.set(e.page, inv);
    }
    const got = collectSongGlyphs(inv, e, profile, cli.shapeKey);
    for (const o of got.notes) notes.push(noteOf(o));
    for (const o of got.title) title.push(noteOf(o));
    for (const o of got.chords) chords.push(noteOf(o));
    // 词曲署名：**按基线分行再按 x 排**（作词一行、作曲一行交错排，照 x 直读会串行）
    {
      const lines = [];
      for (const o of inv.objs
        .filter((x) => x.cls === "credit" && !x.dup && x.obj.bbox.y >= (e.yFrom ?? 0) && x.obj.bbox.y < (e.yTo ?? 1e9))
        .sort((a, b) => bot(a) - bot(b))) {
        const last = lines[lines.length - 1];
        // 容差 5 而不是 3：生卒年印得略高，卡在 3 上会被切成另一行、排到人名前面（同 pdf-diff）
        if (last && bot(o) - last.bot <= 5) last.items.push(o);
        else lines.push({ bot: bot(o), items: [o] });
      }
      // 标点（`：` `.` `(` `)`）不进这条序列：GT 那边只留字与数，留着两边永远对不齐
      for (const ln of lines)
        for (const o of ln.items.sort((a, b) => a.obj.bbox.x - b.obj.bbox.x)) if (isCreditWordGlyph(o.obj.bbox)) credits.push(noteOf(o));
    }
    if (e.startsHere) {
      for (const o of inv.objs.filter((x) => x.cls === "category" && !x.dup).sort((a, b) => a.obj.bbox.x - b.obj.bbox.x))
        category.push(noteOf(o));
      // 页脚是「·书页码·」。首曲 001 在 PDF 第 33 页、书页 1，故书页码 = PDF 页 − 32。
      footers.push({ keys: inv.objs.filter((x) => x.cls === "footer" && !x.dup).sort((a, b) => a.obj.bbox.x - b.obj.bbox.x).map(noteOf), text: `\u00b7${e.page - 32}\u00b7` });
    }
    got.verses.forEach((ln, vi) => {
      (verseRows[vi] ??= []).push(...ln);
    });
  }
  if (invCache.size > 40) invCache.clear();

  const gt = await readSongGt(song);
  const sec = jpwSections(gt.jpwabc);
  items.push({
    id,
    gtNotes: gtNoteDigits(sec.Voice || ""),
    gtVerses: gtLyricVerses(sec.Words || "").map((v) => v.chars),
    gtTitle: song.title,
    gtChords: gt.musicxml ? gtHarmonies(gt.musicxml).join("") : "",
    gtCategory: (song.category ?? "").replace(/\s+/g, ""),
    // GT 的署名字段：`词曲：(加)宣信(1843-1919)`。谱面上的标点/空格随排版走，只留字与数
    gtCredit: (creditField(sec.Title))
      .replace(/\\n/g, "")
      .match(/[\u4e00-\u9fff0-9A-Za-z]/g)
      ?.join("") ?? "",
    notes,
    verses: verseRows.map((r) => r.map(noteOf)),
    title,
    chords,
    credits,
    category,
    footers,
  });
}
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

// ── 自举
/** key → char（已定）。 */
const known = new Map(seed);
for (const [k] of known) if (!classes.has(k)) classes.set(k, { count: 0, h: 0, w: 0, d: "" });
const sourceOf = new Map();
for (const k of known.keys()) sourceOf.set(k, "manual");

/** 用当前字典把形状序列翻成字符数组（未知为 null）。 */
const decode = (keys) => keys.map((k) => known.get(k) ?? null);

/**
 * 对齐 GT 字符串与页面形状序列，把对上的位置记票。
 * 已知形状：字符相同给高分、不同给罚分；未知形状：给一个中性偏正的分（当通配），
 * 这样它更倾向于落在对应的 GT 字符上，从而被标注出来。
 */
function alignVote(gtStr, keys, votes) {
  const n = gtStr.length;
  const m = keys.length;
  if (!n || !m || Math.abs(n - m) > Math.max(8, Math.min(n, m) * 0.4)) return;
  const dec = decode(keys);
  const vote = (k, ch, w) => {
    if (known.has(k)) return;
    const v = votes.get(k) ?? new Map();
    v.set(ch, (v.get(ch) ?? 0) + w);
    votes.set(k, v);
  };

  // 长度完全相等 = 无歧义直配，一次就能定案（权重 3，抵得上三次 DP 对齐的票）。
  // 标题尤其依赖这条：一首一个标题、字几乎不重复，靠投票永远凑不够票数
  //（实测只靠 DP 投票时标题准确率卡在 73%）。
  // 前提是这条序列里**已经认识的字**大体对得上，否则说明整条是错位的，不能信。
  if (n === m) {
    let kn = 0;
    let ok = 0;
    for (let t = 0; t < m; t++) {
      if (dec[t] !== null) {
        kn++;
        if (dec[t] === gtStr[t]) ok++;
      }
    }
    if (kn === 0 || ok / kn >= 0.6) {
      for (let t = 0; t < m; t++) vote(keys[t], gtStr[t], 3);
      return;
    }
  }
  const GAP = -1.2;
  const score = (i, j) => {
    const c = dec[j];
    if (c === null) return 0.6; // 未知形状：通配
    return c === gtStr[i] ? 2 : -1.5;
  };
  // DP
  // 用普通数组存：Float32Array 会把双精度加法的结果截断，回溯时的等值比较就永远不成立。
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = i * GAP;
  for (let j = 1; j <= m; j++) dp[0][j] = j * GAP;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.max(dp[i - 1][j - 1] + score(i - 1, j - 1), dp[i - 1][j] + GAP, dp[i][j - 1] + GAP);
    }
  }
  // 回溯
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (dp[i][j] === dp[i - 1][j - 1] + score(i - 1, j - 1)) {
      vote(keys[j - 1], gtStr[i - 1], 1);
      i--;
      j--;
    } else if (dp[i][j] === dp[i - 1][j] + GAP) i--;
    else j--;
  }
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
    const cls = classes.get(k);
    const flat = cls && cls.h > 0 && cls.w >= cls.h * 2.5;
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

const dict = { book: "hymn500", quant: 50, classes: {} };
for (const [key, c] of classes) {
  dict.classes[key] = {
    key,
    char: known.get(key) ?? null,
    source: sourceOf.get(key) ?? null,
    count: c.count,
    h: Math.round(c.h * 100) / 100,
    w: Math.round(c.w * 100) / 100,
    bbox: c.bbox ?? null,
    d: c.d,
  };
}
await writeFile(OUT, JSON.stringify(dict));
const defined = Object.values(dict.classes).filter((c) => c.char).length;
console.log(`→ ${OUT}：${Object.keys(dict.classes).length} 类，已定 ${defined}`);
