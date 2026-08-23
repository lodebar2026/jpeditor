// 矢量 PDF 识别 ↔ GT 语料 逐项对比，产出 pdf-diff.csv 与 pdf-diff/ 下的逐首差异报告。
//
//   npm run build:cli && node gen-pagemap.mjs && node gen-glyphdict.mjs && node pdf-diff.mjs
//   node pdf-diff.mjs 028            # 只跑一首
//   node pdf-diff.mjs --limit=30     # 只跑前 30 首
//
// 基准：`500/*.musicxml` 为主、`jpw/*.jpwabc` 为辅（当前实现先对 jpwabc 那一路，
// 它直接承载简谱层的表述：音符数字、歌词分段、标题、词曲）。
// **纯 Node，不起浏览器。**
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadCli, openPdf, loadCorpus, readSongGt, jpwSections, gtNoteDigits, gtLyricVerses, gtHarmonies, gtKeyTime, gtSlurTie, gtRepeats, collectSongGlyphs, csvRow, CORPUS_PDF, isCreditWordGlyph } from "./scripts/node-harness.mjs";

/** `.Title` 里的 `WordsByAndMusicBy`。**取最后一条非空的**：有的文件写了两条，
 *  第一条是空的；`=` 后面只吃横向空白，吃到换行就会把下一行整条卷进来。 */
function creditField(titleSec) {
  let out = "";
  for (const m of (titleSec ?? "").matchAll(/WordsByAndMusicBy[^\S\r\n]*=[^\S\r\n]*\{?([^}\r\n]*)\}?/g)) {
    if (m[1].trim()) out = m[1];
  }
  return out;
}

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const filters = args.filter((a) => !a.startsWith("--"));
const OUTDIR = "pdf-diff";

const cli = await loadCli();
const { doc, OPS } = await openPdf();
const { songs } = await loadCorpus();
const pm = JSON.parse(await readFile("testdata/500/pagemap.json", "utf8"));
const dict = JSON.parse(await readFile("testdata/500/glyphdict.json", "utf8"));
const charOf = new Map();
for (const c of Object.values(dict.classes)) if (c.char) charOf.set(c.key, c.char);

const sample = [];
for (let p = 40; p <= 200; p += 4) {
  const g = await doc.getPage(p);
  sample.push(await cli.extractVectorPage(g, OPS));
  g.cleanup();
}
const profile = cli.detectProfile(sample, "hymn500");

/** 带回溯的编辑脚本：返回 [op, gtIdx, recIdx, gtTok, recTok]，op ∈ sub/ins/del。 */
function alignOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = i;
  for (let j = 1; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      dp[i][j] = Math.min(dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), dp[i - 1][j] + 1, dp[i][j - 1] + 1);
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      if (a[i - 1] !== b[j - 1]) ops.push(["sub", i - 1, j - 1, a[i - 1], b[j - 1]]);
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push(["del", i - 1, j, a[i - 1], ""]);
      i--;
    } else {
      ops.push(["ins", i, j - 1, "", b[j - 1]]);
      j--;
    }
  }
  return { ops: ops.reverse(), dist: dp[n][m] };
}
const acc = (a, b, dist) => 1 - dist / Math.max(a.length, b.length, 1);

/** 把编辑脚本分成两摞：
 *  - content：**GT 与 PDF 真的不一样**（录错的音符、写岔的歌词字）——这才是要找的
 *  - unread：字形没读出来（识别侧是 `�`），是本工具的局限，不是两边的差异
 *  折行那类版面差异在更早一步就归并掉了，另计一栏，不进这里。 */
/**
 * 段落配对：GT 的各段与 PDF 的各段**按相似度匹配**，不按下标硬对。
 *
 * 谱面上常常多出 GT 里没有的歌词行（副歌另起一行、末行折行没并干净），
 * 一旦错位一位，按下标比下去每一段都全错——实测 068 首因此报出 230 项假差异，
 * 而它其实只是 PDF 多了一行副歌。
 *
 * 配不上的两边各自列出来：GT 有而 PDF 没找到的、PDF 有而 GT 没有的。
 */
function matchVerses(gtVerses, recVerses) {
  const cands = [];
  for (let i = 0; i < gtVerses.length; i++) {
    for (let j = 0; j < recVerses.length; j++) {
      const a = gtVerses[i];
      const b = recVerses[j];
      if (!a.length && !b.length) continue;
      // 长度差太大的先筛掉，省下大头的 DP
      if (Math.min(a.length, b.length) < Math.max(a.length, b.length) * 0.35) continue;
      const d = alignOps(a, b).dist;
      cands.push({ i, j, sim: 1 - d / Math.max(a.length, b.length, 1) });
    }
  }
  cands.sort((x, y) => y.sim - x.sim);
  const usedG = new Set();
  const usedR = new Set();
  const pairs = [];
  for (const c of cands) {
    if (usedG.has(c.i) || usedR.has(c.j) || c.sim < 0.35) continue;
    usedG.add(c.i);
    usedR.add(c.j);
    pairs.push(c);
  }
  return {
    pairs: pairs.sort((a, b) => a.i - b.i),
    gtOnly: gtVerses.map((_, i) => i).filter((i) => !usedG.has(i) && gtVerses[i].length),
    recOnly: recVerses.map((_, j) => j).filter((j) => !usedR.has(j) && recVerses[j].length),
  };
}

/**
 * 从「GT 有 PDF 无」里拣出**共用副歌**：谱面上副歌只印一遍（挂在某一段的行上），
 * `.jpwabc` 却给每一段都记了一遍（135 首的四段各带一遍「求主耶稣进入我心…」）。
 * 那不是漏印、更不是录错，是两边表述不同——单列一栏，不进内容差异。
 *
 * 判据保守：**连着缺的一整串**（≥6 字）要能在**别的段**里原样找到，才算共用副歌。
 * 找不到的照旧算内容差异。
 */
function splitSharedRefrain(ops, others) {
  const content = [];
  const shared = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const text = run.map((op) => op[3]).join("");
    (text.length >= 6 && others.some((o) => o.includes(text)) ? shared : content).push(...run);
    run = [];
  };
  for (const op of ops) {
    if (op[0] === "del") run.push(op);
    else {
      flush();
      content.push(op);
    }
  }
  flush();
  return { content, shared };
}

function splitOps(ops) {
  const content = [];
  const unread = [];
  for (const op of ops) (op[4] === "\ufffd" ? unread : content).push(op);
  return { content, unread };
}

const byId = new Map();
for (const m of pm.map) {
  const a = byId.get(m.id) ?? [];
  a.push(m);
  byId.set(m.id, a);
}
const bot = (o) => o.obj.bbox.y + o.obj.bbox.h;
// lyricYi 是按「与歌词共基线」认出来的「一」，轮廓与扁横条撞键，不进字典，直接给字。
const charAt = (o) => (o.cls === "lyricYi" ? "一" : charOf.get(cli.shapeKey(o.obj.data)) ?? "\ufffd");
const readSeq = (arr) => arr.map(charAt).join("");
// 圆滑线在 .Voice 里写成 `(` `)`，谱面上却画成弧（另有 slur 对象），两边语义不同，
// 不参与音符序列比对。
const dropParens = (s) => s.replace(/[()（）]/g, "");

/** 歌词比对前的归一：**只留汉字**。
 *
 * 剔掉两类东西，它们都不是「歌词录错」，留着只会淹没真正的差异：
 *  - 和弦。谱面上和弦印在谱行上方、与歌词只隔一线，总有一部分被归进歌词
 *    （实测「PDF 有 GT 无」里 #334、7:235，还有一串 F/C/D/G）。
 *  - 标点。谱面的标点跟着字走，GT 里的位置未必一致——一进一出各四百来处，
 *    是排版差异不是录错，另计一栏。
 * 「副歌」这类段落标记同样不算歌词。 */
const SECTION_WORDS = /(副歌|间奏|前奏|尾声|反复|齐唱|独唱|合唱)/g;
// `\ufffd`（读不出的字形）要**留着**：抹掉的话对齐时它就成了「GT 有 PDF 无」，
// 字典的窟窿会被记成「录错」——那是本工具的局限，该进「未识别」那一栏。
const lyricNorm = (t) => (t.replace(SECTION_WORDS, "").match(/[\u4e00-\u9fff\ufffd]/g) ?? []).join("");
/** 与 `lyricNorm` 同一套规则，但保留每个字对应的页面对象——画差异标记要拿它定位。
 *  两者必须一致：这里改了那里也要改。 */
const lyricNormSeq = (items) => {
  const text = items.map((it) => it.ch).join("");
  const drop = new Set();
  for (const m of text.matchAll(SECTION_WORDS)) for (let k = 0; k < m[0].length; k++) drop.add(m.index + k);
  return items.filter((it, i) => !drop.has(i) && /[\u4e00-\u9fff\ufffd]/.test(it.ch));
};
/** 只取标点，用来单独统计标点差异。 */
const punctOnly = (t) => (t.match(/[\u3000-\u303f\uff01-\uff20\uff3b-\uff65]/g) ?? []).join("");

await mkdir(OUTDIR, { recursive: true });
const rows = [];
const invCache = new Map();
let count = 0;
const limit = flags.limit ? Number(flags.limit) : Infinity;

for (const [id, entries] of byId) {
  const song = songs.get(id);
  if (!song?.jpwabc) continue;
  if (filters.length && !filters.some((f) => id.includes(f) || song.title.includes(f))) continue;
  if (count++ >= limit) break;

  const marks = [];
  const badVerseNos = [];
  const boxOf = (o) => ({ page: o.page, idx: o.idx, box: [o.obj.bbox.x, o.obj.bbox.y, o.obj.bbox.w, o.obj.bbox.h] });
  const notes = [];
  const verseRows = [];
  const title = [];
  const chords = [];
  const keyMeters = [];
  const credits = [];
  const arcs = [];
  let repeatDots = 0;
  let brackets = 0;
  let objTotal = 0;
  let unclassified = 0;
  let storyChars = 0;
  let folds = 0;
  let strayLines = 0;
  for (const e of entries) {
    let inv = invCache.get(e.page);
    if (!inv) {
      const g = await doc.getPage(e.page);
      const vp = await cli.extractVectorPage(g, OPS);
      g.cleanup();
      inv = cli.classifyPage(vp, profile);
      invCache.set(e.page, inv);
    }
    // 画差异标记要知道对象在哪一页、在 inv.objs 里排第几（pdf-mark.mjs 按下标取回轮廓）
    inv.objs.forEach((o, i) => {
      o.page ??= e.page;
      o.idx ??= i;
    });
    objTotal += inv.objs.length;
    unclassified += inv.unclassified.length;
    storyChars += inv.objs.filter((o) => o.cls === "storyText" && !o.dup && o.obj.bbox.y >= (e.yFrom ?? 0) && o.obj.bbox.y < (e.yTo ?? 1e9)).length;
    const got = collectSongGlyphs(inv, e, profile, cli.shapeKey);
    folds += got.folds ?? 0;
    strayLines += got.dropped ?? 0;
    // 谱面印错的段号：标红，并在上方用黄色补上按位置该有的段号
    for (const bad of got.misprintedNo ?? []) {
      badVerseNos.push(bad);
      for (const o of bad.objs) marks.push({ ...boxOf(o), kind: "wrong", what: "段号", gt: `${bad.want + 1}.` });
      const b = bad.objs[0].obj.bbox;
      marks.push({ page: bad.objs[0].page, kind: "missing", what: "段号", text: `${bad.want + 1}.`, box: [b.x, b.y - b.h * 1.15, b.h, b.h] });
    }
    const inSpan = (o) => o.obj.bbox.y >= (e.yFrom ?? 0) && o.obj.bbox.y < (e.yTo ?? 1e9);
    for (const o of inv.objs) {
      if (o.dup || !inSpan(o)) continue;
      if (o.cls === "keyMeter") keyMeters.push(o);
      else if (o.cls === "credit") credits.push(o);
      else if (o.cls === "slur") arcs.push({ o, bandNotes: null });
      else if (o.cls === "repeatDot") repeatDots++;
      else if (o.cls === "bracket") brackets++;
    }
    // 圆滑线覆盖了哪几个音符：拿弧的**两个端点**各找同谱行里最近的音符。
    // 先前用「音符中心落在弧的横向范围内」来框，短弧常常一个音符都框不住
    // （弧画在两个音符之间，两头都够不着中心），全书因此少认了近千条弧。
    for (const a of arcs) {
      if (a.bandNotes) continue;
      const ab = a.o.obj.bbox;
      const same = got.notes.filter((n) => n.row === a.o.row);
      if (same.length < 2) {
        a.bandNotes = [];
        continue;
      }
      const nearest = (x) =>
        same.reduce((best, n) => {
          const c = n.obj.bbox.x + n.obj.bbox.w / 2;
          const bc = best.obj.bbox.x + best.obj.bbox.w / 2;
          return Math.abs(c - x) < Math.abs(bc - x) ? n : best;
        }, same[0]);
      const s0 = nearest(ab.x);
      const s1 = nearest(ab.x + ab.w);
      a.bandNotes = s0 === s1 ? [] : [s0, s1];
    }
    notes.push(...got.notes);
    chords.push(...got.chords);
    title.push(...got.title);
    got.verses.forEach((ln, vi) => (verseRows[vi] ??= []).push(...ln));
  }
  if (invCache.size > 40) invCache.clear();

  const gt = await readSongGt(song);
  const sec = jpwSections(gt.jpwabc);
  const gtNotes = dropParens(gtNoteDigits(sec.Voice || ""));

  // ── 调号拍号：GT 取 musicxml 的 <key>/<time>，识别侧从 keyMeter 那一撮文本里解析。
  //    谱面常写两个调（「1=F (1=D)」主调 + 括号里的替代调），GT 只记一个，命中任一即算对。
  const gtKT = gt.musicxml ? gtKeyTime(gt.musicxml) : null;
  const kmText = keyMeters
    .sort((a, b) => a.obj.bbox.x - b.obj.bbox.x || a.obj.bbox.y - b.obj.bbox.y)
    .map((o) => charOf.get(cli.shapeKey(o.obj.data)) ?? "")
    .join("");
  // 等号的字形被字典读成「二」（它就是两条平行横线），两种写法都认
  const recKeys = [...kmText.matchAll(/1\s*[=二]\s*([#♭b]?)\s*([A-G])/g)].map((m) => (m[1] ? m[1].replace("b", "♭") : "") + m[2]);
  // 拍号是**上下叠放**的：分数线之上是分子、之下是分母。
  // 不能按 kmText 的先后取前两个数字——那串是按 x 排的，上下两个数字 x 几乎相同，
  // 谁先谁后全看零点几个点的抖动，于是 3/4 有 98 首被读成了 4/3。
  // 也不能一个数字只取一位，否则 12/8 会变成 1/8。
  const kmLine = keyMeters.find((o) => o.obj.bbox.h < 1 && o.obj.bbox.w > 3);
  let recMeter = "";
  if (kmLine) {
    const lb = kmLine.obj.bbox;
    const pick = (up) =>
      keyMeters
        .filter((o) => {
          const b = o.obj.bbox;
          if (b.h < 1) return false;
          const cx2 = b.x + b.w / 2;
          if (cx2 < lb.x - 2 || cx2 > lb.x + lb.w + 2) return false;
          return up ? b.y + b.h <= lb.y + 1 : b.y >= lb.y - 1;
        })
        .sort((a, b) => a.obj.bbox.x - b.obj.bbox.x)
        .map((o) => charOf.get(cli.shapeKey(o.obj.data)) ?? "")
        .join("")
        .replace(/\D/g, "");
    const num = pick(true);
    const den = pick(false);
    if (num && den) recMeter = `${num}/${den}`;
  }
  const keyOk = gtKT ? recKeys.includes(gtKT.key) : null;
  const meterOk = gtKT && gtKT.beats ? recMeter === `${gtKT.beats}/${gtKT.beatType}` : null;
  // **读到了但与 GT 不同 ≠ 读错。** GT 的调号有一批是按主音和弦订正过的（谱面印 `1=G`、
  // musicxml 记 `1=F`），那是两边表述不同，不是识别问题——单列一档，不进内容差异。
  // 真正的识别失败是「没读到」。拍号同理（`4/4` ↔ `2/2` 是记法之别）。
  const keyState = keyOk == null ? null : keyOk ? "ok" : recKeys.length ? "differs" : "missing";
  const meterState = meterOk == null ? null : meterOk ? "ok" : recMeter ? "differs" : "missing";

  // ── 词曲署名：GT 取 `.Title` 的 `WordsByAndMusicBy`，识别侧取归类为 credit 的那一撮。
  //    两边的标点/空格/换行都随排版走，**只比汉字、拉丁字母与数字**。
  //    署名是两行交错排的（作词一行、作曲一行），要**先按基线分行再按 x 排**，
  //    照 x 一路读会把两行的字母穿插起来。
  const creditNorm = (t) => (t.replace(/\\n/g, "").match(/[\u4e00-\u9fff0-9A-Za-z\ufffd]/g) ?? []).join("");
  const gtCredit = creditNorm(creditField(sec.Title));
  const creditLines = [];
  for (const o of [...credits].sort((a, b) => a.obj.bbox.y + a.obj.bbox.h - (b.obj.bbox.y + b.obj.bbox.h))) {
    const bot = o.obj.bbox.y + o.obj.bbox.h;
    const last = creditLines[creditLines.length - 1];
    // 同一行的容差要**松一点**：署名里的生卒年印得略高（`(1820-1915)` 的基线比人名高四五个点），
    // 卡在 3 点上会把它切成另一行，而行是按基线排的，年份于是跑到人名前面
    //（197 首读成「18201915作词美芬尼…」）。
    if (last && bot - last.bot <= 5) last.items.push(o);
    else creditLines.push({ bot, items: [o] });
  }
  // 标点不进序列（判据见 `isCreditWordGlyph`，与建库那边共用）：GT 侧只留字与数，
  // 识别侧要是把 `：` `.` `(` `)` 留成 `�`，凭空多出九百多处「未识别」。
  const recCredit = creditNorm(
    creditLines
      .map((ln) =>
        ln.items
          .sort((a, b) => a.obj.bbox.x - b.obj.bbox.x)
          .filter((o) => isCreditWordGlyph(o.obj.bbox))
          .map(charAt)
          .join(""),
      )
      .join(""),
  );
  const dCredit = gtCredit ? alignOps(gtCredit, recCredit) : null;
  const sCredit = dCredit ? splitOps(dCredit.ops) : null;

  // ── 圆滑线 / 连音线：两边都表示成「覆盖了第几个到第几个音符」。
  //    矢量层分不出圆滑线和连音线（都是一条弧），故 GT 侧把 slur 与 tied 合起来比。
  const gtST = gt.musicxml ? gtSlurTie(gt.musicxml) : null;
  const gtArcs = gtST ? [...gtST.slurs, ...gtST.ties].sort((a, b) => a[0] - b[0] || a[1] - b[1]) : [];
  // 音符序号只数**真的音符数字**：识别侧的 note 里混着升降号（谱面上它印在音符左上方）
  // 和读不出的字形，每混进一个，弧的两端就同时错一位——全书 373 项「区间不同」里
  // 250 项是这种两端等量平移（+1+1 140 项、+2+2 77 项…）。
  const noteIndex = new Map();
  {
    let k = 0;
    for (const n of notes) {
      const c = charOf.get(cli.shapeKey(n.obj.data)) ?? "";
      noteIndex.set(n, k);
      if (/[0-7]/.test(c)) k++;
    }
  }
  const recArcs = arcs
    .filter((a) => a.bandNotes && a.bandNotes.length >= 2)
    .map((a) => [noteIndex.get(a.bandNotes[0]) ?? -1, noteIndex.get(a.bandNotes[a.bandNotes.length - 1]) ?? -1])
    .filter(([x, y]) => x >= 0 && y > x)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const dArc = alignOps(gtArcs.map((v) => v.join("-")), recArcs.map((v) => v.join("-")));

  // ── 反复与房号：识别侧只有几何（反复冒号的点、房号括线），拿数量比。
  const gtRep = gt.musicxml ? gtRepeats(gt.musicxml) : null;
  const recRepeats = Math.round(repeatDots / 2); // 一个反复记号两个点
  const repeatDelta = gtRep ? recRepeats - gtRep.repeats.length : null;
  const endingDelta = gtRep ? brackets - gtRep.endings.length : null;
  const gtVerseRaw = gtLyricVerses(sec.Words || "").map((v) => v.chars);
  const gtVerses = gtVerseRaw.map(lyricNorm);
  const gtPunct = gtVerseRaw.map(punctOnly).join("");

  // 识别侧的音符里混着升降号（谱面上印在音符左上方，归类时归到了音符带）与读不出的字形。
  // **升降号两边口径不一致**（GT 侧 `gtNoteDigits` 只取 0-7），得一并剔掉才比得准；
  // `�` 留着，那是「未识别」不是「录错」。
  const noteSeq = notes.map((o) => ({ ch: charAt(o), o })).filter((it) => /[0-7\ufffd]/.test(it.ch));
  const recNotes = noteSeq.map((it) => it.ch).join("");
  const recTitle = readSeq(title);
  const titleSeq = lyricNormSeq(title.map((o) => ({ ch: charAt(o), o })));
  // 有些「歌词行」其实是和弦行或音符行被归错了（读出来一个汉字都没有）。
  // 它们混进段落配对会制造假的「PDF 多出一段」，先按汉字占比剔掉，单列一栏。
  const verseSeqs = verseRows.map((row) => row.map((o) => ({ ch: charAt(o), o })));
  const rawVerses = verseRows.map(readSeq);
  const isLyricish = (t) => {
    const han = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
    return t.length > 0 && han / t.length >= 0.3;
  };
  const lyricish = rawVerses.filter(isLyricish);
  const recVerseSeqs = verseSeqs.filter((_, i) => isLyricish(rawVerses[i])).map(lyricNormSeq);
  const recVerses = lyricish.map(lyricNorm);
  const recPunct = lyricish.map(punctOnly).join("");
  const misLyric = rawVerses.filter((t) => !isLyricish(t));
  // 和弦以 **musicxml 的 `<harmony>`** 为基准——`.jpwabc` 根本装不下和弦，
  // 这是「musicxml 为主、jpwabc 为辅」里 musicxml 独有的那一块。
  // 谱面上和弦带里还混着调号拍号（「1=F 4/4」），比对前按和弦的样子筛一遍。
  const recChordRaw = readSeq(chords);
  // 和弦要**按记号成撮地读**，不能把整行拼成一串再切：一串里混着音符的升降号
  // （谱面上印在音符左上方，归类时落进和弦带）和读不出的字形，拼在一起之后
  // 一个孤零零的 `#` 会粘到后面那个和弦头上（`C→#C`、`G→#G`）、一个孤零零的数字
  // 会粘成后缀（`F→F9`）。同一个和弦的字母彼此挨着（间距不到一个音符宽），
  // 与相邻和弦之间隔着大半个小节。门槛试过 3/4/5/7/9 个点，3~5 都一样，取 4。
  const chordGroups = [];
  {
    let cur = null;
    for (const o of chords) {
      const b = o.obj.bbox;
      if (cur && cur.row === o.row && b.x - cur.x1 <= 4) {
        cur.text += charOf.get(cli.shapeKey(o.obj.data)) ?? "";
        cur.x1 = Math.max(cur.x1, b.x + b.w);
        cur.objs.push(o);
      } else {
        cur = { row: o.row, x1: b.x + b.w, text: charOf.get(cli.shapeKey(o.obj.data)) ?? "", objs: [o] };
        chordGroups.push(cur);
      }
    }
  }
  // **升降号在前**（谱面与 musicxml 侧都写作 `#Fm`、`♭B`）。
  // 写成「音名在后跟升降号」会把 `#` 算给前一个和弦——`G` 后面跟着 `#Fm` 就读成了 `G#` + `Fm`，
  // 整串跟着错位（实测 028 首八项和弦差异里六项是这么来的）。
  // 数字后缀只认真实存在的（6/7/9/11/13）：不限的话调号「1=F 4/4」里的 `F4` 会被当成一个和弦。
  const CHORD_TOKEN = /(?:#|♭|b)?[A-G](?:maj|min|sus|dim|aug|add|m)?(?:6|7|9|11|13)?(?:\/(?:#|♭|b)?[A-G])?/g;
  // 先抹掉和弦里不可能出现的字符再切 token：和弦带里夹着读不出的字形（`�`）与标点——
  // 谱面上的 `♭` 常被拆成两个对象、其中一个读成「，」，夹在中间就把 `♭B` 切成了 `B`
  // （`♭B→B` 是全书最多的一类和弦差异，41 处）。
  const normChords = (t) => (t.replace(/[^0-9A-Za-z#♭/]/g, "").match(CHORD_TOKEN) ?? []).join("|");
  // 一撮可能切出不止一个和弦记号；每个记号都记着这一撮的对象，够画标记用了
  const recChordSeq = [];
  for (const g of chordGroups) for (const tok of normChords(g.text).split("|").filter(Boolean)) recChordSeq.push({ ch: tok, objs: g.objs });
  const recChords = recChordSeq.map((it) => it.ch).join("|");
  const gtChords = gt.musicxml ? normChords(gtHarmonies(gt.musicxml).join("")) : "";
  // **谱面把旋律印两遍时，和弦也跟着印两遍**（见下面音符那段的同一件事）：
  // musicxml 只记一遍，直接比会把整整一遍和弦报成几十项「PDF 有 GT 无」
  // （024 首 GT 23 / PDF 48，26 项差异里全是这么来的）。同样先试 GT 重复 k 遍。
  const gtChordArr = gtChords.split("|").filter(Boolean);
  const recChordArr = recChords.split("|").filter(Boolean);
  let dChord = alignOps(gtChordArr, recChordArr);
  let chordRepeat = 1;
  for (let k = 2; k <= 4; k++) {
    if (!gtChordArr.length) break;
    if (Math.abs(recChordArr.length - gtChordArr.length * k) > gtChordArr.length * 0.3) continue;
    const rep = [];
    for (let i = 0; i < k; i++) rep.push(...gtChordArr);
    const d = alignOps(rep, recChordArr);
    if (d.dist < dChord.dist) {
      dChord = d;
      chordRepeat = k;
    }
  }

  // **谱面可能把旋律印了两遍**（各段词长不同时常这么排），而 .jpwabc 只记一遍、
  // 靠多段歌词表示。直接比会把整整一遍旋律报成上百项「PDF 有 GT 无」（实测 024 首 71 项）。
  // 先试 GT 重复 k 遍，取最贴合的那个，重复本身当结构差异单列。
  let dNote = alignOps(gtNotes, recNotes);
  let noteRepeat = 1;
  for (let k = 2; k <= 4; k++) {
    if (!gtNotes.length) break;
    if (Math.abs(recNotes.length - gtNotes.length * k) > gtNotes.length * 0.3) continue;
    const d = alignOps(gtNotes.repeat(k), recNotes);
    if (d.dist < dNote.dist) {
      dNote = d;
      noteRepeat = k;
    }
  }
  const gtNotesEff = noteRepeat > 1 ? gtNotes.repeat(noteRepeat) : gtNotes;
  // 标题同样只比汉字：它的标点也是随排版走的（「圣哉，圣哉，圣哉」的顿号常识别不全）
  const gtTitleN = lyricNorm(song.title);
  const recTitleN = lyricNorm(recTitle);
  const dTitle = alignOps(gtTitleN, recTitleN);
  const sNote = splitOps(dNote.ops);
  const sTitle = splitOps(dTitle.ops);
  const verseDiffs = [];
  let lyricDist = 0;
  let lyricLen = 0;
  const vm = matchVerses(gtVerses, recVerses);
  for (const pr of vm.pairs) {
    const a = gtVerses[pr.i];
    const b = recVerses[pr.j];
    const d = alignOps(a, b);
    const sp = splitOps(d.ops);
    const sr = splitSharedRefrain(sp.content, recVerses.filter((_, j) => j !== pr.j));
    verseDiffs.push({
      verse: pr.i + 1,
      pdfVerse: pr.j + 1,
      gt: a,
      rec: b,
      recSeq: recVerseSeqs[pr.j] ?? [],
      ...d,
      ...sp,
      content: sr.content,
      shared: sr.shared,
    });
    lyricDist += d.dist;
    lyricLen += Math.max(a.length, b.length);
  }
  // 配不上的两边各自记账：GT 有而 PDF 没找到的算内容差异（可能真的漏印/漏识别），
  // PDF 有而 GT 没有的多半是副歌另起行之类的版面差异，单列不计进内容差异。
  for (const i of vm.gtOnly) {
    lyricDist += gtVerses[i].length;
    lyricLen += gtVerses[i].length;
  }
  const extraVerses = vm.recOnly.map((j) => recVerses[j]);

  // 括号不能省：`a + b?.length || 0` 会先算加法，歌词里没有 � 时 b?.length 是
  // undefined，整个式子变成 NaN，再被 `|| 0` 吞成 0，音符那部分也一起丢了。
  const unread = (recNotes.match(/�/g) ?? []).length + (recVerses.join("").match(/�/g)?.length ?? 0);

  const contentDiffs =
    sNote.content.length +
    sTitle.content.length +
    verseDiffs.reduce((a, d) => a + d.content.length, 0) +
    (gtChords ? dChord.ops.length : 0) +
    (gtST ? dArc.ops.length : 0) +
    (keyState === "missing" ? 1 : 0) +
    (meterState === "missing" ? 1 : 0);
  // 反复与房号**只记录、不计进内容差异**：识别侧只有几何（反复冒号的点、房号括线），
  // 三连音的括线脚、别处的小圆点都会混进来，数量对不上是判据太粗，不是 GT 与 PDF 不一致。
  const unreadDiffs =
    sNote.unread.length + sTitle.unread.length + (sCredit?.unread.length ?? 0) + verseDiffs.reduce((a, d) => a + d.unread.length, 0);

  // ── 差异标记：把每一处差异落到**具体的页面对象**上，供 pdf-mark.mjs 生成标记版 PDF。
  //    红 = 页面读出来的这个对象有问题（录错 / 页面多出）；黄 = GT 有而页面没有，补在原位；
  //    橙 = 字形没读出来（本工具的局限，不是录错）。
  const markOps = (ops, seq, what) => {
    for (const [op, , ri, g2, b2] of ops) {
      if (op === "ins" || op === "sub") {
        const it = seq[ri];
        if (!it) continue;
        const objs = it.objs ?? [it.o];
        for (const o of objs) marks.push({ ...boxOf(o), kind: b2 === "\ufffd" ? "unread" : "wrong", what, gt: op === "sub" ? g2 : "" });
      } else if (op === "del") {
        // 页面没有这个字：贴在左邻居右侧（没有左邻居就贴右邻居左侧）。
        // **连着缺的一串要并成一条**：一段词整块没印时，每个字各标一条会几十条叠在同一点上。
        const prev = seq[ri - 1];
        const next = seq[ri];
        const anchorObj = (prev?.objs ?? (prev ? [prev.o] : []))?.slice(-1)[0] ?? (next?.objs ?? (next ? [next.o] : []))?.[0];
        if (!anchorObj) continue;
        const b = anchorObj.obj.bbox;
        const last = marks[marks.length - 1];
        if (last && last.kind === "missing" && last.what === what && last.anchor === anchorObj.idx && last.page === anchorObj.page) {
          last.text += (what === "和弦" ? " " : "") + g2; // 和弦是一个个记号，连写会糊成一串
          continue;
        }
        marks.push({
          page: anchorObj.page,
          kind: "missing",
          what,
          text: g2,
          anchor: anchorObj.idx,
          box: [prev ? b.x + b.w : b.x - b.h, b.y, b.h, b.h],
        });
      }
    }
  };
  markOps(sNote.content.concat(sNote.unread), noteSeq, "音符");
  markOps(sTitle.content.concat(sTitle.unread), titleSeq, "标题");
  for (const d of verseDiffs) markOps(d.content.concat(d.unread), d.recSeq, `歌词第 ${d.verse} 段`);
  if (gtChords) markOps(dChord.ops, recChordSeq, "和弦");
  if (keyState === "missing" || meterState === "missing") {
    for (const o of keyMeters) marks.push({ ...boxOf(o), kind: "wrong", what: "调号拍号", gt: "" });
    const first = keyMeters[0];
    if (first) {
      const b = first.obj.bbox;
      const want = [keyState === "missing" ? gtKT?.key && `1=${gtKT.key}` : "", meterState === "missing" ? `${gtKT?.beats}/${gtKT?.beatType}` : ""].filter(Boolean).join(" ");
      marks.push({ page: first.page, kind: "missing", what: "调号拍号", text: want, box: [b.x, b.y - b.h * 1.4, b.h, b.h] });
    }
  }

  // 「表述或结构不一致」：两边都没错，只是记法/排法不同。**单独记一类**，不混进内容差异，
  // 也不当成没事——它们是回改 GT 或改排版判据时要看的东西。
  const sharedRefrain = verseDiffs.reduce((a, d) => a + (d.shared?.length ?? 0), 0);
  const structDiffs =
    (badVerseNos.length ?? 0) +
    sharedRefrain +
    (keyState === "differs" ? 1 : 0) +
    (meterState === "differs" ? 1 : 0) +
    (noteRepeat > 1 ? 1 : 0) +
    (chordRepeat > 1 ? 1 : 0) +
    extraVerses.length +
    vm.gtOnly.length +
    folds +
    alignOps(gtPunct, recPunct).dist;

  const r = {
    id,
    title: song.title,
    folds,
    strayLines,
    contentDiffs,
    unreadDiffs,
    sNote,
    sTitle,
    pages: entries.map((e) => e.page).join(" "),
    noteAcc: acc(gtNotesEff, recNotes, dNote.dist),
    noteGt: gtNotes.length,
    noteRec: recNotes.length,
    noteDiffs: dNote.ops.length,
    lyricAcc: lyricLen ? 1 - lyricDist / lyricLen : 1,
    keyGt: gtKT ? `1=${gtKT.key}` : "",
    keyRec: recKeys.map((k) => `1=${k}`).join(" "),
    keyOk,
    keyState,
    meterGt: gtKT && gtKT.beats ? `${gtKT.beats}/${gtKT.beatType}` : "",
    meterRec: recMeter,
    meterOk,
    meterState,
    arcGt: gtArcs.length,
    arcRec: recArcs.length,
    arcDiffs: gtST ? dArc.ops.length : null,
    arcAcc: gtST ? 1 - dArc.dist / Math.max(gtArcs.length, recArcs.length, 1) : null,
    dArc,
    gtArcs,
    repeatGt: gtRep ? gtRep.repeats.length : 0,
    repeatRec: recRepeats,
    repeatDelta,
    endingGt: gtRep ? gtRep.endings.length : 0,
    endingRec: brackets,
    endingDelta,
    punctDiffs: alignOps(gtPunct, recPunct).dist,
    gtPunctN: gtPunct.length,
    recPunctN: recPunct.length,
    gtOnlyVerses: vm.gtOnly.map((i) => gtVerses[i]),
    extraVerses,
    misLyric,
    lyricDiffs: verseDiffs.reduce((a, d) => a + d.ops.length, 0),
    verses: `${gtVerses.length}/${recVerses.length}`,
    titleAcc: acc(gtTitleN, recTitleN, dTitle.dist),
    gtTitleN,
    recTitle,
    chords: recChordRaw.length,
    chordGt: gtChords ? gtChords.split("|").filter(Boolean).length : 0,
    chordRec: recChords ? recChords.split("|").filter(Boolean).length : 0,
    chordDiffs: gtChords ? dChord.ops.length : null,
    chordRepeat,
    chordAcc: gtChords ? 1 - dChord.dist / Math.max(gtChordArr.length * chordRepeat, recChordArr.length, 1) : null,
    dChord,
    storyChars,
    objTotal,
    unclassified,
    unread,
    dNote,
    verseDiffs,
    dTitle,
    gtNotes: gtNotesEff,
    recNotes,
    noteRepeat,
    structDiffs,
    sharedRefrain,
    gtCredit,
    recCredit,
    creditDiffs: sCredit ? sCredit.content.length : null,
    creditAcc: gtCredit ? acc(gtCredit, recCredit, dCredit.dist) : null,
    sCredit,
    marks,
    badVerseNos: badVerseNos.map((b) => b.want + 1),
  };
  rows.push(r);
}

// ── CSV
// 列的组织按「这一栏说明什么」分三摞：
//   内容差异 —— GT 与 PDF 真的不一样，这是对比要找的东西
//   未识别   —— 字形没读出来，本工具的局限，不是两边的差异
//   版面     —— 折行、段数这类排版事实，记录但不算差异
const head = [
  "曲号", "曲名", "页",
  "内容差异合计", "表述结构不一致", "音符内容差异", "歌词内容差异", "标题内容差异", "和弦内容差异", "弧线内容差异", "词曲署名差异",
  "未识别合计", "音符未识别", "歌词未识别",
  "折行", "标点差异", "段数GT/识别",
  "音符准确率", "音符GT数", "音符识别数", "歌词准确率", "标题准确率", "识别标题",
  "和弦准确率", "和弦GT数", "和弦PDF数",
  "弧线准确率", "弧线GT数", "弧线PDF数",
  "调号GT", "调号PDF", "调号对", "拍号GT", "拍号PDF", "拍号对",
  "反复GT", "反复PDF", "房号GT", "房号PDF",
  "花边框正文", "对象总数", "未归类",
];
const csv = [csvRow(head)];
for (const r of rows) {
  csv.push(
    csvRow([
      r.id,
      r.title,
      r.pages,
      r.contentDiffs,
      r.structDiffs,
      r.sNote.content.length,
      r.verseDiffs.reduce((a, d) => a + d.content.length, 0),
      r.sTitle.content.length,
      r.chordDiffs ?? "",
      r.arcDiffs ?? "",
      r.creditDiffs ?? "",
      r.unreadDiffs,
      r.sNote.unread.length,
      r.verseDiffs.reduce((a, d) => a + d.unread.length, 0),
      r.folds,
      r.punctDiffs,
      r.verses,
      (r.noteAcc * 100).toFixed(1),
      r.noteGt,
      r.noteRec,
      (r.lyricAcc * 100).toFixed(1),
      (r.titleAcc * 100).toFixed(1),
      r.recTitle,
      r.chordAcc != null ? (r.chordAcc * 100).toFixed(1) : "",
      r.chordGt,
      r.chordRec,
      r.arcAcc != null ? (r.arcAcc * 100).toFixed(1) : "",
      r.arcGt,
      r.arcRec,
      r.keyGt,
      r.keyRec,
      r.keyState == null ? "" : { ok: "对", differs: "不同调", missing: "没读到" }[r.keyState],
      r.meterGt,
      r.meterRec,
      r.meterState == null ? "" : { ok: "对", differs: "不同记法", missing: "没读到" }[r.meterState],
      r.repeatGt,
      r.repeatRec,
      r.endingGt,
      r.endingRec,
      r.storyChars,
      r.objTotal,
      r.unclassified,
    ]),
  );
}
const avg = (f) => rows.reduce((a, r) => a + f(r), 0) / Math.max(rows.length, 1);
const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
csv.push(
  csvRow([
    "合计/平均", "", "",
    sum((r) => r.contentDiffs),
    sum((r) => r.structDiffs),
    sum((r) => r.sNote.content.length),
    sum((r) => r.verseDiffs.reduce((a, d) => a + d.content.length, 0)),
    sum((r) => r.sTitle.content.length),
    sum((r) => r.chordDiffs ?? 0),
    sum((r) => r.arcDiffs ?? 0),
    sum((r) => r.creditDiffs ?? 0),
    sum((r) => r.unreadDiffs),
    sum((r) => r.sNote.unread.length),
    sum((r) => r.verseDiffs.reduce((a, d) => a + d.unread.length, 0)),
    sum((r) => r.folds),
    sum((r) => r.punctDiffs),
    "",
    (avg((r) => r.noteAcc) * 100).toFixed(1), "", "",
    (avg((r) => r.lyricAcc) * 100).toFixed(1),
    (avg((r) => r.titleAcc) * 100).toFixed(1),
    "", "", "", "", "",
  ]),
);
await writeFile("pdf-diff.csv", "﻿" + csv.join("\n"));

// ── 差异标记：按页归拢，交给 pdf-mark.mjs 盖在原件上（见那个脚本的注释）
{
  const byPage = {};
  for (const r of rows)
    for (const m of r.marks ?? []) {
      (byPage[m.page] ??= []).push({ id: r.id, ...m, page: undefined });
    }
  await writeFile(
    "pdf-diff-marks.json",
    JSON.stringify({ pdf: CORPUS_PDF, songs: rows.length, marks: Object.values(byPage).reduce((a, v) => a + v.length, 0), pages: byPage }),
  );
}

// ── 逐首明细。**按「这是什么」分节**：
//    内容差异是 GT 与 PDF 真的不一样（要找的就是它）；
//    未识别是本工具没读出字形；折行、段数是版面事实。三者分开，互不污染。
for (const r of rows) {
  const L = [`# ${r.id} ${r.title}    页 ${r.pages}`, ""];
  const fmt = (ops, gtStr, ctx = 6) =>
    ops.map(([op, gi, ri, g2, b2]) => {
      const around = gtStr.slice(Math.max(0, gi - ctx), gi) + "▸" + gtStr.slice(gi, gi + ctx);
      return `    ${op === "sub" ? "不同" : op === "del" ? "GT有·PDF无" : "PDF有·GT无"}  @GT[${gi}]  GT=${g2 || "-"}  PDF=${b2 || "-"}    …${around}…`;
    });

  L.push(`## 内容差异 ${r.contentDiffs} 项（GT 与 PDF 不一致）`);

  if (r.sNote.content.length) {
    L.push(`  音符 ${r.sNote.content.length} 项（GT ${r.noteGt}${r.noteRepeat > 1 ? `×${r.noteRepeat}遍` : ""} / PDF ${r.noteRec}）`);
    L.push(...fmt(r.sNote.content, r.gtNotes));
  }
  for (const d of r.verseDiffs) {
    if (!d.content.length) continue;
    L.push(`  歌词第 ${d.verse} 段 ${d.content.length} 项（GT ${d.gt.length} / PDF ${d.rec.length}，配到 PDF 第 ${d.pdfVerse} 行）`);
    L.push(...fmt(d.content, d.gt, 5));
  }
  if (r.sTitle.content.length) {
    L.push(`  标题 ${r.sTitle.content.length} 项：GT「${r.title}」 PDF「${r.recTitle}」`);
    L.push(...fmt(r.sTitle.content, r.gtTitleN, 4));
  }

  if (r.chordDiffs != null && r.chordDiffs > 0) {
    L.push(`  和弦 ${r.chordDiffs} 项（GT<harmony> ${r.chordGt}${r.chordRepeat > 1 ? `×${r.chordRepeat}遍` : ""} / PDF ${r.chordRec}）`);
    const gtSeq = r.dChord.ops;
    for (const [op, gi, ri, g2, b2] of gtSeq.slice(0, 40))
      L.push(`    ${op === "sub" ? "不同" : op === "del" ? "GT有·PDF无" : "PDF有·GT无"}  @${gi}  GT=${g2 || "-"}  PDF=${b2 || "-"}`);
    if (gtSeq.length > 40) L.push(`    …（共 ${gtSeq.length} 项）`);
  }

  if (r.arcDiffs != null && r.arcDiffs > 0) {
    L.push(`  圆滑线/连音线 ${r.arcDiffs} 项（GT ${r.arcGt} 条 / PDF ${r.arcRec} 条，按覆盖的音符区间比）`);
    for (const [op, gi, ri, g2, b2] of r.dArc.ops.slice(0, 30))
      L.push(`    ${op === "sub" ? "区间不同" : op === "del" ? "GT有·PDF无" : "PDF有·GT无"}  @${gi}  GT=${g2 || "-"}  PDF=${b2 || "-"}`);
    if (r.dArc.ops.length > 30) L.push(`    …（共 ${r.dArc.ops.length} 项）`);
  }
  if (r.keyState === "missing") L.push(`  调号没读到（GT「${r.keyGt}」）`);
  if (r.meterState === "missing") L.push(`  拍号没读到（GT「${r.meterGt}」）`);

  // 词曲署名单列一节：这一路刚接上，拉丁小字号的字典还很稀，混进内容差异会把别的项盖住。
  if (r.sCredit?.content.length) {
    L.push("", `## 词曲署名 ${r.sCredit.content.length} 项（单列，不计进内容差异）`);
    L.push(`  GT「${r.gtCredit}」`, `  PDF「${r.recCredit}」`);
    L.push(...fmt(r.sCredit.content, r.gtCredit, 4));
  }

  // 为 0 的项一律不印：一首没几处差异的曲子，报告里全是「0 处」「（无）」反而看不见重点。
  if (r.unreadDiffs) {
    L.push("", `## 未识别 ${r.unreadDiffs} 处（字形没读出来，不是两边的差异）`);
    if (r.sNote.unread.length) L.push(`  音符 ${r.sNote.unread.length}：` + r.sNote.unread.map(([, gi, , g2]) => `GT[${gi}]=${g2 || "?"}`).join(" "));
    for (const d of r.verseDiffs) {
      if (!d.unread.length) continue;
      L.push(`  歌词第 ${d.verse} 段 ${d.unread.length}：` + d.unread.map(([, gi, , g2]) => `@${gi}=${g2 || "?"}`).join(" "));
    }
    if (r.sTitle.unread.length) L.push(`  标题 ${r.sTitle.unread.length}`);
    if (r.sCredit?.unread.length) L.push(`  词曲署名 ${r.sCredit.unread.length}`);
  }

  // 「表述或结构不一致」：两边都没错、只是记法/排法不同。**单列一类**，既不混进内容差异，
  // 也不当作没发生——回改 GT 或调排版判据时看的就是这一节。
  const mis = [];
  const ms = (t) => mis.push(t);
  if (r.badVerseNos?.length) ms(`  谱面段号印错 ${r.badVerseNos.length} 处（按位置应是第 ${r.badVerseNos.join("、")} 段），已按位置归段并标红`);
  if (r.sharedRefrain) ms(`  共用副歌 ${r.sharedRefrain} 字（谱面只印一遍，GT 每段各记一遍）`);
  if (r.keyState === "differs") ms(`  调号与谱面不同：GT「${r.keyGt}」PDF「${r.keyRec}」（GT 按主音和弦订正过）`);
  if (r.meterState === "differs") ms(`  拍号记法不同：GT「${r.meterGt}」PDF「${r.meterRec}」`);
  if (r.noteRepeat > 1) ms(`  PDF 把旋律印了 ${r.noteRepeat} 遍（GT 只记一遍，靠多段歌词表示）`);
  if (r.chordRepeat > 1) ms(`  PDF 把和弦印了 ${r.chordRepeat} 遍`);
  if (r.folds) ms(`  歌词折行归并 ${r.folds} 字（排不下折到下一行，不是新的一段）`);
  if (r.punctDiffs) ms(`  标点差异 ${r.punctDiffs} 处（GT ${r.gtPunctN} / PDF ${r.recPunctN}；标点位置随排版走）`);
  if (r.extraVerses?.length) {
    ms(`  PDF 多出 ${r.extraVerses.length} 行歌词（GT 里没有对应段，多为副歌另起行）：`);
    for (const v of r.extraVerses) ms(`    「${v.slice(0, 40)}${v.length > 40 ? "…" : ""}」（${v.length} 字）`);
  }
  if (r.gtOnlyVerses?.length) {
    ms(`  GT 有 ${r.gtOnlyVerses.length} 段在 PDF 里没找到对应：`);
    for (const v of r.gtOnlyVerses) ms(`    「${v.slice(0, 40)}${v.length > 40 ? "…" : ""}」（${v.length} 字）`);
  }
  if (mis.length) L.push("", `## 表述或结构不一致 ${r.structDiffs} 项（两边都没错，记法/排法不同）`, ...mis);

  const layout = [];
  const lay = (t) => layout.push(t);
  if (r.strayLines) lay(`  歌词带里剔掉的非歌词对象 ${r.strayLines} 个（零星记号 / 曲末经文出处）`);
  if (r.misLyric?.length) {
    lay(`  ${r.misLyric.length} 行被归成歌词但读不出汉字（多半是和弦行/音符行归错了），已排除：`);
    for (const v of r.misLyric) lay(`    「${v.slice(0, 36)}${v.length > 36 ? "…" : ""}」`);
  }
  const [vg, vr] = r.verses.split("/");
  if (vg !== vr) lay(`  段数 GT ${vg} / PDF ${vr}`);
  if (r.repeatGt !== r.repeatRec || r.endingGt !== r.endingRec)
    lay(
      `  反复 GT ${r.repeatGt} / PDF ${r.repeatRec}，房号 GT ${r.endingGt} / PDF ${r.endingRec}` +
        `（识别侧只有几何，判据粗，不计进内容差异）`,
    );
  if (r.storyChars) lay(`  花边框正文 ${r.storyChars} 字`);
  if (layout.length) L.push("", "## 版面（记录，不算差异）", ...layout);
  L.push("", `## 覆盖：页面对象 ${r.objTotal}${r.unclassified ? `，未归类 ${r.unclassified}` : ""}`);
  L.push(`   准确率：音符 ${(r.noteAcc * 100).toFixed(1)}%  歌词 ${(r.lyricAcc * 100).toFixed(1)}%  标题 ${(r.titleAcc * 100).toFixed(1)}%`);
  await writeFile(`${OUTDIR}/${r.id}.txt`, L.join("\n"));
}

console.log(`${rows.length} 首`);
console.log(`音符平均 ${(avg((r) => r.noteAcc) * 100).toFixed(2)}%  歌词平均 ${(avg((r) => r.lyricAcc) * 100).toFixed(2)}%  标题平均 ${(avg((r) => r.titleAcc) * 100).toFixed(2)}%`);
console.log(
  `内容差异合计 ${sum((r) => r.contentDiffs)}（音符 ${sum((r) => r.sNote.content.length)}` +
    ` / 歌词 ${sum((r) => r.verseDiffs.reduce((a, d) => a + d.content.length, 0))}` +
    ` / 标题 ${sum((r) => r.sTitle.content.length)}` +
    ` / 和弦 ${sum((r) => r.chordDiffs ?? 0)}` +
    ` / 弧线 ${sum((r) => r.arcDiffs ?? 0)}` +
    ` / 调号拍号没读到 ${sum((r) => (r.keyState === "missing" ? 1 : 0) + (r.meterState === "missing" ? 1 : 0))}）`,
);
{
  const k = rows.filter((r) => r.keyOk != null);
  const m = rows.filter((r) => r.meterOk != null);
  const a = rows.filter((r) => r.arcAcc != null);
  const st = (rows2, field, kind) => rows2.filter((r) => r[field] === kind).length;
  if (k.length)
    console.log(
      `调号 对 ${st(k, "keyState", "ok")}/${k.length}（${((st(k, "keyState", "ok") / k.length) * 100).toFixed(1)}%）` +
        `，与谱面不同调 ${st(k, "keyState", "differs")}（GT 按主音和弦订正过，不算录错），没读到 ${st(k, "keyState", "missing")}\n` +
        `拍号 对 ${st(m, "meterState", "ok")}/${m.length}（${((st(m, "meterState", "ok") / m.length) * 100).toFixed(1)}%）` +
        `，记法不同 ${st(m, "meterState", "differs")}，没读到 ${st(m, "meterState", "missing")}`,
    );
  if (a.length) console.log(`弧线平均准确率 ${((a.reduce((x, r) => x + r.arcAcc, 0) / a.length) * 100).toFixed(2)}%（GT 合计 ${sum((r) => r.arcGt)} 条 / PDF ${sum((r) => r.arcRec)} 条）`);
  console.log(`反复 GT ${sum((r) => r.repeatGt)} / PDF ${sum((r) => r.repeatRec)}；房号 GT ${sum((r) => r.endingGt)} / PDF ${sum((r) => r.endingRec)}`);
}
{
  const withCr = rows.filter((r) => r.creditAcc != null);
  if (withCr.length)
    console.log(
      `词曲署名平均 ${((withCr.reduce((a, r) => a + r.creditAcc, 0) / withCr.length) * 100).toFixed(2)}%（${withCr.length} 首有署名）` +
        `——**不计进内容差异**：这一路刚接上，拉丁小字号的字典还很稀，会把另外几项盖住`,
    );
  const withC = rows.filter((r) => r.chordAcc != null);
  if (withC.length) console.log(`和弦平均准确率 ${((withC.reduce((a, r) => a + r.chordAcc, 0) / withC.length) * 100).toFixed(2)}%（${withC.length} 首有 <harmony>）`);
}
console.log(
  `表述或结构不一致合计 ${sum((r) => r.structDiffs)}（共用副歌 ${sum((r) => r.sharedRefrain)} 字 / 折行 ${sum((r) => r.folds)} 字 / 标点 ${sum((r) => r.punctDiffs)} / 段号印错 ${sum((r) => r.badVerseNos?.length ?? 0)} 处 / 调号拍号记法 ${sum((r) => (r.keyState === "differs" ? 1 : 0) + (r.meterState === "differs" ? 1 : 0))} / 旋律或和弦印两遍 ${sum((r) => (r.noteRepeat > 1 ? 1 : 0) + (r.chordRepeat > 1 ? 1 : 0))} / PDF 多出 ${sum((r) => r.extraVerses.length)} 段 / GT 多出 ${sum((r) => r.gtOnlyVerses.length)} 段）\n` +
  `未识别合计 ${sum((r) => r.unreadDiffs)}（其中词曲署名 ${sum((r) => r.sCredit?.unread.length ?? 0)}），` +
    `歌词带里剔掉的非歌词对象 ${sum((r) => r.strayLines)} 个，非歌词行 ${sum((r) => r.misLyric?.length ?? 0)}，未归类对象 ${sum((r) => r.unclassified)}`,
);
// 分两档报：和弦是新接上的一路、准确率还低，混在一起会把另外三项的成绩盖住
const cleanNoChord = rows.filter(
  (r) => r.sNote.content.length + r.sTitle.content.length + r.verseDiffs.reduce((a, d) => a + d.content.length, 0) === 0,
).length;
const cleanAll = rows.filter((r) => r.contentDiffs === 0).length;
console.log(
  `**内容完全一致：音符+歌词+标题 ${cleanNoChord}/${rows.length}（${((cleanNoChord / rows.length) * 100).toFixed(1)}%）；` +
    `再算上和弦 ${cleanAll}/${rows.length}（${((cleanAll / rows.length) * 100).toFixed(1)}%）**`,
);
const worst = [...rows].sort((a, b) => b.contentDiffs - a.contentDiffs).slice(0, 8);
console.log("内容差异最多:", worst.map((r) => `${r.id}:${r.contentDiffs}项`).join(" "));
console.log(`→ pdf-diff.csv, ${OUTDIR}/<曲号>.txt`);
