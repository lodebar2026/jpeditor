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
import { loadCli, openPdf, loadCorpus, readSongGt, jpwSections, gtNoteDigits, gtLyricVerses, gtHarmonies, gtKeyTime, gtSlurTie, gtRepeats, collectSongGlyphs, csvRow } from "./scripts/node-harness.mjs";

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
const readSeq = (arr) => arr.map((o) => (o.cls === "lyricYi" ? "一" : charOf.get(cli.shapeKey(o.obj.data)) ?? "�")).join("");
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
const lyricNorm = (t) => (t.replace(SECTION_WORDS, "").match(/[\u4e00-\u9fff]/g) ?? []).join("");
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

  const notes = [];
  const verseRows = [];
  const title = [];
  const chords = [];
  const keyMeters = [];
  const arcs = [];
  let repeatDots = 0;
  let brackets = 0;
  let objTotal = 0;
  let unclassified = 0;
  let storyChars = 0;
  let folds = 0;
  for (const e of entries) {
    let inv = invCache.get(e.page);
    if (!inv) {
      const g = await doc.getPage(e.page);
      const vp = await cli.extractVectorPage(g, OPS);
      g.cleanup();
      inv = cli.classifyPage(vp, profile);
      invCache.set(e.page, inv);
    }
    objTotal += inv.objs.length;
    unclassified += inv.unclassified.length;
    storyChars += inv.objs.filter((o) => o.cls === "storyText" && !o.dup && o.obj.bbox.y >= (e.yFrom ?? 0) && o.obj.bbox.y < (e.yTo ?? 1e9)).length;
    const got = collectSongGlyphs(inv, e, profile, cli.shapeKey);
    folds += got.folds ?? 0;
    const inSpan = (o) => o.obj.bbox.y >= (e.yFrom ?? 0) && o.obj.bbox.y < (e.yTo ?? 1e9);
    for (const o of inv.objs) {
      if (o.dup || !inSpan(o)) continue;
      if (o.cls === "keyMeter") keyMeters.push(o);
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

  // ── 圆滑线 / 连音线：两边都表示成「覆盖了第几个到第几个音符」。
  //    矢量层分不出圆滑线和连音线（都是一条弧），故 GT 侧把 slur 与 tied 合起来比。
  const gtST = gt.musicxml ? gtSlurTie(gt.musicxml) : null;
  const gtArcs = gtST ? [...gtST.slurs, ...gtST.ties].sort((a, b) => a[0] - b[0] || a[1] - b[1]) : [];
  const noteIndex = new Map(notes.map((n, i) => [n, i]));
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

  const recNotes = dropParens(readSeq(notes));
  const recTitle = readSeq(title);
  // 有些「歌词行」其实是和弦行或音符行被归错了（读出来一个汉字都没有）。
  // 它们混进段落配对会制造假的「PDF 多出一段」，先按汉字占比剔掉，单列一栏。
  const rawVerses = verseRows.map(readSeq);
  const isLyricish = (t) => {
    const han = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
    return t.length > 0 && han / t.length >= 0.3;
  };
  const lyricish = rawVerses.filter(isLyricish);
  const recVerses = lyricish.map(lyricNorm);
  const recPunct = lyricish.map(punctOnly).join("");
  const misLyric = rawVerses.filter((t) => !isLyricish(t));
  // 和弦以 **musicxml 的 `<harmony>`** 为基准——`.jpwabc` 根本装不下和弦，
  // 这是「musicxml 为主、jpwabc 为辅」里 musicxml 独有的那一块。
  // 谱面上和弦带里还混着调号拍号（「1=F 4/4」），比对前按和弦的样子筛一遍。
  const recChordRaw = readSeq(chords);
  // **升降号在前**（谱面与 musicxml 侧都写作 `#Fm`、`♭B`）。
  // 写成「音名在后跟升降号」会把 `#` 算给前一个和弦——`G` 后面跟着 `#Fm` 就读成了 `G#` + `Fm`，
  // 整串跟着错位（实测 028 首八项和弦差异里六项是这么来的）。
  // 数字后缀只认真实存在的（6/7/9/11/13）：不限的话调号「1=F 4/4」里的 `F4` 会被当成一个和弦。
  const CHORD_TOKEN = /(?:#|♭|b)?[A-G](?:maj|min|sus|dim|aug|add|m)?(?:6|7|9|11|13)?(?:\/(?:#|♭|b)?[A-G])?/g;
  const normChords = (t) => (t.match(CHORD_TOKEN) ?? []).join("|");
  const recChords = normChords(recChordRaw);
  const gtChords = gt.musicxml ? normChords(gtHarmonies(gt.musicxml).join("")) : "";
  const dChord = alignOps(gtChords.split("|").filter(Boolean), recChords.split("|").filter(Boolean));

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
    verseDiffs.push({ verse: pr.i + 1, pdfVerse: pr.j + 1, gt: a, rec: b, ...d, ...splitOps(d.ops) });
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
    (keyOk === false ? 1 : 0) +
    (meterOk === false ? 1 : 0);
  // 反复与房号**只记录、不计进内容差异**：识别侧只有几何（反复冒号的点、房号括线），
  // 三连音的括线脚、别处的小圆点都会混进来，数量对不上是判据太粗，不是 GT 与 PDF 不一致。
  const unreadDiffs =
    sNote.unread.length + sTitle.unread.length + verseDiffs.reduce((a, d) => a + d.unread.length, 0);

  const r = {
    id,
    title: song.title,
    folds,
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
    meterGt: gtKT && gtKT.beats ? `${gtKT.beats}/${gtKT.beatType}` : "",
    meterRec: recMeter,
    meterOk,
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
    chordAcc: gtChords ? 1 - dChord.dist / Math.max(gtChords.split("|").length, recChords.split("|").length, 1) : null,
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
  "内容差异合计", "音符内容差异", "歌词内容差异", "标题内容差异", "和弦内容差异", "弧线内容差异",
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
      r.sNote.content.length,
      r.verseDiffs.reduce((a, d) => a + d.content.length, 0),
      r.sTitle.content.length,
      r.chordDiffs ?? "",
      r.arcDiffs ?? "",
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
      r.keyOk == null ? "" : r.keyOk ? "对" : "不同",
      r.meterGt,
      r.meterRec,
      r.meterOk == null ? "" : r.meterOk ? "对" : "不同",
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
    sum((r) => r.sNote.content.length),
    sum((r) => r.verseDiffs.reduce((a, d) => a + d.content.length, 0)),
    sum((r) => r.sTitle.content.length),
    sum((r) => r.chordDiffs ?? 0),
    sum((r) => r.arcDiffs ?? 0),
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
  if (!r.contentDiffs) L.push("  （无）");
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
    L.push(`  和弦 ${r.chordDiffs} 项（GT<harmony> ${r.chordGt} / PDF ${r.chordRec}）`);
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
  if (r.keyOk === false) L.push(`  调号不同：GT「${r.keyGt}」 PDF「${r.keyRec || "(没读到)"}」`);
  if (r.meterOk === false) L.push(`  拍号不同：GT「${r.meterGt}」 PDF「${r.meterRec || "(没读到)"}」`);

  L.push("", `## 未识别 ${r.unreadDiffs} 处（字形没读出来，不是两边的差异）`);
  if (r.unreadDiffs) {
    if (r.sNote.unread.length) L.push(`  音符 ${r.sNote.unread.length}：` + r.sNote.unread.map(([, gi, , g2]) => `GT[${gi}]=${g2 || "?"}`).join(" "));
    for (const d of r.verseDiffs) {
      if (!d.unread.length) continue;
      L.push(`  歌词第 ${d.verse} 段 ${d.unread.length}：` + d.unread.map(([, gi, , g2]) => `@${gi}=${g2 || "?"}`).join(" "));
    }
    if (r.sTitle.unread.length) L.push(`  标题 ${r.sTitle.unread.length}`);
  } else L.push("  （无）");

  L.push("", "## 版面（记录，不算差异）");
  L.push(`  歌词折行归并 ${r.folds} 字`);
  L.push(`  标点差异 ${r.punctDiffs} 处（GT ${r.gtPunctN} / PDF ${r.recPunctN}；标点位置随排版走，不算录错）`);
  if (r.noteRepeat > 1) L.push(`  **PDF 把旋律印了 ${r.noteRepeat} 遍**（GT 只记一遍，靠多段歌词表示）`);
  if (r.misLyric?.length) {
    L.push(`  ${r.misLyric.length} 行被归成歌词但读不出汉字（多半是和弦行/音符行归错了），已排除：`);
    for (const v of r.misLyric) L.push(`    「${v.slice(0, 36)}${v.length > 36 ? "…" : ""}」`);
  }
  if (r.extraVerses?.length) {
    L.push(`  PDF 多出 ${r.extraVerses.length} 行歌词（GT 里没有对应段，多为副歌另起行）：`);
    for (const v of r.extraVerses) L.push(`    「${v.slice(0, 40)}${v.length > 40 ? "…" : ""}」（${v.length} 字）`);
  }
  if (r.gtOnlyVerses?.length) {
    L.push(`  GT 有 ${r.gtOnlyVerses.length} 段在 PDF 里没找到对应：`);
    for (const v of r.gtOnlyVerses) L.push(`    「${v.slice(0, 40)}${v.length > 40 ? "…" : ""}」（${v.length} 字）`);
  }
  L.push(`  段数 GT ${r.verses.split("/")[0]} / PDF ${r.verses.split("/")[1]}`);
  L.push(`  调号 GT「${r.keyGt}」PDF「${r.keyRec}」  拍号 GT「${r.meterGt}」PDF「${r.meterRec}」`);
  L.push(
    `  反复 GT ${r.repeatGt} / PDF ${r.repeatRec}，房号 GT ${r.endingGt} / PDF ${r.endingRec}` +
      `（识别侧只有几何，判据粗，不计进内容差异）`,
  );
  L.push(`  和弦 GT ${r.chordGt} / PDF ${r.chordRec}${r.chordAcc != null ? `（准确率 ${(r.chordAcc * 100).toFixed(1)}%）` : ""}，花边框正文 ${r.storyChars} 字`);
  L.push("", `## 覆盖：页面对象 ${r.objTotal}，未归类 ${r.unclassified}`);
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
    ` / 调号拍号 ${sum((r) => (r.keyOk === false ? 1 : 0) + (r.meterOk === false ? 1 : 0))}）`,
);
{
  const k = rows.filter((r) => r.keyOk != null);
  const m = rows.filter((r) => r.meterOk != null);
  const a = rows.filter((r) => r.arcAcc != null);
  if (k.length) console.log(`调号对 ${k.filter((r) => r.keyOk).length}/${k.length}（${((k.filter((r) => r.keyOk).length / k.length) * 100).toFixed(1)}%）  拍号对 ${m.filter((r) => r.meterOk).length}/${m.length}（${((m.filter((r) => r.meterOk).length / m.length) * 100).toFixed(1)}%）`);
  if (a.length) console.log(`弧线平均准确率 ${((a.reduce((x, r) => x + r.arcAcc, 0) / a.length) * 100).toFixed(2)}%（GT 合计 ${sum((r) => r.arcGt)} 条 / PDF ${sum((r) => r.arcRec)} 条）`);
  console.log(`反复 GT ${sum((r) => r.repeatGt)} / PDF ${sum((r) => r.repeatRec)}；房号 GT ${sum((r) => r.endingGt)} / PDF ${sum((r) => r.endingRec)}`);
}
{
  const withC = rows.filter((r) => r.chordAcc != null);
  if (withC.length) console.log(`和弦平均准确率 ${((withC.reduce((a, r) => a + r.chordAcc, 0) / withC.length) * 100).toFixed(2)}%（${withC.length} 首有 <harmony>）`);
}
console.log(
  `未识别合计 ${sum((r) => r.unreadDiffs)}，折行归并 ${sum((r) => r.folds)} 字，` +
    `非歌词行剔除 ${sum((r) => r.misLyric?.length ?? 0)}，标点差异 ${sum((r) => r.punctDiffs)}，未归类对象 ${sum((r) => r.unclassified)}`,
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
