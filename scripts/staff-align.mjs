// 五线谱那条路的**共用引导**：识别全书 → 找首页 → 切曲目范围 → 与 GT 对齐。
// `staff-diff.mjs`（对拍）与 `gen-stafflyrics.mjs`（拿 GT 自举字形）共用这一份，
// **对齐判据只写在这里一处**——两边各写一份迟早会分叉。
//
// 判据的原委见 docs/实现/五线谱识别.md 的「对拍」一节。
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  openPdf, eachPage, loadCli, ZMZQ_PDF, ZMZQ_GT_DIR,
  xmlStaffNotes, xmlStaffTypes, xmlTitles, xmlLyricVerses, xmlSlurMarks, xmlStaffPitches, xmlMeasureCount, gtRepeats, gtKeyTime,
} from "./node-harness.mjs";

/** 在 `hay` 的前若干音里找与 `needle` 最像的一个等长窗口，返回相似度。
 *  步长取一个音——窗口一共只有几十个，逐个试也不贵。 */
export function bestWindow(hay, needle, maxStart = 24) {
  if (!needle.length) return 0;
  let best = 0;
  for (let s = 0; s <= Math.min(maxStart, Math.max(0, hay.length - 1)); s++) {
    const v = sim(hay.slice(s, s + needle.length), needle);
    if (v > best) best = v;
    if (best === 1) break;
  }
  return best;
}

/** 编辑距离。曲目对齐与对拍共用。 */
export function lev(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return Math.max(n, m);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[m];
}

/** 相似度（0~1），按两者较长的一个归一。 */
export const sim = (a, b) => (Math.max(a.length, b.length) ? 1 - lev(a, b) / Math.max(a.length, b.length) : 0);

/** 繁→简（书上是繁体、GT 是简体）。opencc-js 的 t2cn 词表，Node 可用。 */
export async function loadT2S() {
  const { Converter } = await import("opencc-js/t2cn");
  return Converter({ from: "tw", to: "cn" });
}

/** 简→繁。建字形字典时要把 GT（简体）转成**书上印的那个字形**再投票，
 *  否则字典会把全书吐成简体——那不是这本书的原文。词表约 1MB，只有建库那一路加载。 */
export async function loadS2T() {
  const { Converter } = await import("opencc-js/cn2t");
  return Converter({ from: "cn", to: "tw" });
}

/**
 * 跑完整条流水线并把曲目对上 GT。
 *
 * @param opts.onPage 逐页回调，拿到 `recognizeStaffPage` 的原始结果（建字典那一路要用）
 * @returns { songs, pageInfo, spans, results }
 */
export async function alignSongs(opts = {}) {
  const quiet = opts.quiet ?? false;
  const log = (...a) => { if (!quiet) console.log(...a); };

    // ── GT ────────────────────────────────────────────────────────────────────
  const gtFiles = (await readdir(ZMZQ_GT_DIR)).filter((f) => f.endsWith(".musicxml")).sort();
  const songs = [];
  for (const f of gtFiles) {
    const xml = await readFile(join(ZMZQ_GT_DIR, f), "utf8");
    const t = xmlTitles(xml);
    songs.push({ file: f, id: f.split(".")[0], ...t, notes: xmlStaffNotes(xml), types: xmlStaffTypes(xml), verses: xmlLyricVerses(xml), slurs: xmlSlurMarks(xml), pitches: xmlStaffPitches(xml), measures: xmlMeasureCount(xml), repeats: gtRepeats(xml), keyFifths: gtKeyTime(xml).fifths });
  }
  log(`GT ${songs.length} 首`);

  // ── 页面：抽标题 + 识别 ─────────────────────────────────────────────────────
  const cli = opts.cli ?? await loadCli();
  // 正文字形字典：没显式传就自动加载（`null` 表示明确不要——建库的第一轮就是这么跑的）。
  let textLookup = opts.textLookup;
  if (textLookup === undefined) {
    try {
      textLookup = new cli.TextGlyphLookup(JSON.parse(await readFile("src/staffomr/lyricglyphs.json", "utf8")));
    } catch {
      textLookup = null;
    }
  }
  const look = cli.makeLookup(JSON.parse(await readFile("src/staffomr/glyphmap.json", "utf8")));
  const { doc, OPS } = await openPdf(ZMZQ_PDF);

  /**
   * 页面上方的曲名候选。
   *
   * 规则而非常量：以**页高的上五分之一**为标题带；带内按 y 归行（同一行的 run 纵向重叠）；
   * 每行既出「整行拼起来」的文本，也出每个 run 自己的文本——中文标题常被拆成
   * 「主我跟 / 祢 / 走」三段（中间那个字在另一套字体里），整行拼起来才对得上；
   * 而英文标题多半自己就是一个 run。
   */
  /** 字形 → 字符：字形字典优先，没有就退回 ToUnicode。 */
  const charOf = (font, g) => (textLookup ? textLookup.lookup(font, g) : g.unicode);

  function titleCandidates(runs, pageH) {
    const band = runs.filter((r) => r.bbox.y < pageH * 0.2 && r.glyphs.length && !/Maestro|Opus|Anastasia|Frets/.test(r.font));
    if (!band.length) return [];
    const rows = [];
    for (const r of band.slice().sort((a, b) => a.bbox.y - b.bbox.y)) {
      const row = rows.find((q) => r.bbox.y < q.bottom && q.top < r.bbox.y + r.bbox.h);
      if (row) {
        row.runs.push(r);
        row.top = Math.min(row.top, r.bbox.y);
        row.bottom = Math.max(row.bottom, r.bbox.y + r.bbox.h);
      } else rows.push({ runs: [r], top: r.bbox.y, bottom: r.bbox.y + r.bbox.h });
    }
    const out = [];
    for (const row of rows) {
      row.runs.sort((a, b) => a.bbox.x - b.bbox.x);
      const size = Math.max(...row.runs.map((r) => r.sizeDev));
      const whole = row.runs.map((r) => r.glyphs.map((g) => g.unicode).join("")).join("").trim();
      if (whole) out.push({ text: whole, size });
      for (const r of row.runs) {
        const t = r.glyphs.map((g) => charOf(r.font, g)).join("").trim();
        if (t && t !== whole) out.push({ text: t, size: r.sizeDev });
      }
    }
    return out.sort((p, q) => q.size - p.size);
  }

  const pageInfo = [];
  let carryTime; // 拍号跨页继承
  const t0 = Date.now();
  await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
    const r = await cli.recognizeStaffPage(page, OPS, look, pn, { textLookup: textLookup ?? undefined, carryTime });
    carryTime = r.carryTime;
    await opts.onPage?.(r, pn);
    const runs = r.page.objs.filter((o) => o.run).map((o) => o.run);
    pageInfo.push({
      pn,
      hasStaff: r.hasStaff,
      songStart: r.hasStaff && isSongStart(runs, r.page),
      titles: r.hasStaff ? titleCandidates(runs, r.page.height) : [],
      // GT 是**单声部**（主旋律）。谱面上 SATB / 钢琴谱一个系统有好几行，
      // 主旋律在最上面那行——只取每个系统的顶行，否则一首歌的音符数会翻倍
      // （实测 152 首 阿爸父 GT74 → 146，正好两倍）。
      notes: melody(r).map((n) => (n.rest ? "R" : n.step + n.octave)),
      types: melody(r).map((n) => durType(n)),
      slurs: melody(r).map((n) => slurMark(n)),
      pitches: melody(r).map((n) => (n.rest ? "R" : n.step + (n.alter > 0 ? "+".repeat(n.alter) : n.alter < 0 ? "-".repeat(-n.alter) : "") + n.octave)),
      // 逐段歌词：把这一页所有谱行的第 n 段按谱行顺序接起来
      verses: verseTexts(r),
      // 逐段歌词的**字形序列**（拿 GT 自举字形字典用，见 gen-stafflyrics.mjs）
      lyricGlyphs: versesGlyphs(cli, r),
      // 标题那一行的字形序列。标题用的是**另一套显示字体**（24~27pt 的黑体/圆体），
      // 与歌词字体不是同一批类，光靠歌词投票读不出标题——所以单独收一份。
      titleGlyphs: titleRowGlyphs(cli, runs, r.page.height),
      staves: r.page.staves.length,
      // 小节数：只数每个系统**顶行**的（GT 是单声部）
      measures: r.page.systems.reduce((a, sys) => a + sys.top.bars.length, 0),
      // 反复与结构性小节线（只数每个系统顶行的）
      repeats: r.page.systems.reduce((a, sys) => a + sys.top.bars.filter((b) => b.leftRepeat || b.rightRepeat).length, 0),
      barStyles: r.page.systems.reduce((a, sys) => a + sys.top.bars.filter((b) => b.rightStyle).length, 0),
      // 房号（按 `<ending>` 的个数记，起讫各算一个，与 gtRepeats 的口径一致）
      endings: r.page.systems.reduce(
        (a, sys) => a + sys.top.bars.filter((b) => b.endingStart).length + sys.top.bars.filter((b) => b.endingStop).length,
        0,
      ),
      octaves: r.octaves.length,
      // 本页的调号（升号计正、降号计负），取第一个系统顶行的那一份。
      // 对拍要用：**这本书印的调常与 GT 不同**（实测 272 首谱面 G 大调、GT E 大调），
      // 整首差一个纯音程不是读错，与「整首差一个八度」是同一类事，得分开记。
      fifths: pageFifths(r),
    });
  });
  log(`识别 ${doc.numPages} 页 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  /**
   * 这一页是不是**一首歌的起头**。
   *
   * 判据（规则，不是页号表）：第一行谱**之上**有一条明显比正文大的文本
   * ——书上每首歌的抬头就是「大字标题」。倍数取正文字号中位数的 1.6 倍：
   * 歌词/和弦/术语都在正文字号上下，只有标题跳出来。
   * 续页没有标题，第一行谱之上顶多有页眉（与正文同号或更小）。
   */
  function isSongStart(runs, pg) {
    if (!pg.staves.length) return false;
    const top = Math.min(...pg.staves.map((s) => s.box.top));
    const body = runs.filter((r) => r.glyphs.length && !/Maestro|Opus|Anastasia|Frets/.test(r.font)).map((r) => r.sizeDev).sort((a, b) => a - b);
    if (!body.length) return false;
    const med = body[body.length >> 1];
    return runs.some((r) => r.glyphs.length && r.bbox.y + r.bbox.h < top && r.sizeDev >= med * 1.6 && !/Maestro|Opus|Anastasia|Frets/.test(r.font));
  }

  /** 标题行的字形序列：标题带里**字号最大**、且不是纯 ASCII 的那一行。 */
  function titleRowGlyphs(cli, runs, pageH) {
    const band = runs.filter((r) => r.bbox.y < pageH * 0.2 && r.glyphs.length && !/Maestro|Opus|Anastasia|Frets/.test(r.font));
    if (!band.length) return [];
    const rows = [];
    for (const r of band.slice().sort((a, b) => a.bbox.y - b.bbox.y)) {
      const row = rows.find((q) => r.bbox.y < q.bottom && q.top < r.bbox.y + r.bbox.h);
      if (row) {
        row.runs.push(r);
        row.top = Math.min(row.top, r.bbox.y);
        row.bottom = Math.max(row.bottom, r.bbox.y + r.bbox.h);
      } else rows.push({ runs: [r], top: r.bbox.y, bottom: r.bbox.y + r.bbox.h });
    }
    let best = null;
    for (const row of rows) {
      const size = Math.max(...row.runs.map((r) => r.sizeDev));
      const ascii = row.runs.every((r) => r.glyphs.every((g) => /^[\x20-\x7e]?$/.test(g.unicode)));
      if (ascii) continue;
      if (!best || size > best.size) best = { row, size };
    }
    if (!best) return [];
    const out = [];
    for (const r of best.row.runs.slice().sort((a, b) => a.bbox.x - b.bbox.x)) {
      for (const g of r.glyphs) {
        const id = cli.glyphClassKey(r.font, g);
        if (!id) continue;
        out.push({
          text: charOf(r.font, g),
          ids: [id],
          sig: cli.glyphSig(g),
          uni: g.unicode,
          w: r.sizeDev > 0 ? g.bbox.w / r.sizeDev : 0,
          h: r.sizeDev > 0 ? g.bbox.h / r.sizeDev : 0,
        });
      }
    }
    return out;
  }

  /** **逐段**歌词的字形类键序列：`{1: [{text, ids}], 2: [...]}`。
   *  `ids` 为空的音节（没有轮廓的西文字体）照样留着占位——对齐要靠位置。 */
  function versesGlyphs(cli, r) {
    const order = new Map(r.page.staves.map((s, i) => [s, i]));
    const out = {};
    for (const line of r.lyricLines.slice().sort((a, b) => (order.get(a.staff) ?? 0) - (order.get(b.staff) ?? 0))) {
      const arr = (out[line.verse] ??= []);
      for (const syl of line.syllables) {
        const g0 = syl.glyphs[0];
        arr.push({
          text: syl.text,
          ids: syl.glyphs.map((g) => cli.glyphClassKey(syl.font, g)).filter(Boolean),
          // 形近补字要用的签名（只带首个字形的：投票也只投单字形音节）
          sig: g0 ? cli.glyphSig(g0) : undefined,
          uni: g0?.unicode ?? "",
          // 单字形音节的墨迹尺寸（em）。建库那一路靠它把标点挡在外面——
          // 标点的墨迹只有半个字大，而 GT 那侧的标点已经被归一化抹掉了。
          w: g0 && syl.sizeDev > 0 ? g0.bbox.w / syl.sizeDev : 0,
          h: g0 && syl.sizeDev > 0 ? g0.bbox.h / syl.sizeDev : 0,
        });
      }
    }
    return out;
  }

  /** 逐段歌词：`{1: "...", 2: "..."}`。歌词行按它所属谱行的上下顺序接起来。 */
  function verseTexts(r) {
    const order = new Map(r.page.staves.map((s, i) => [s, i]));
    const by = new Map();
    for (const line of r.lyricLines.slice().sort((a, b) => (order.get(a.staff) ?? 0) - (order.get(b.staff) ?? 0))) {
      by.set(line.verse, (by.get(line.verse) ?? "") + line.syllables.map((s) => s.text).join(""));
    }
    return Object.fromEntries(by);
  }

  /** 逐音的弧线标记，口径与 `xmlSlurMarks` 一致。 */
  function slurMark(n) {
    let t = "";
    if (n.slurStart) t += "s";
    if (n.slurStop) t += "S";
    if (n.tieStart) t += "t";
    if (n.tieStop) t += "T";
    return t || ".";
  }

  /** 每个系统顶行的音符，按系统从上到下、行内从左到右。 */
  function melody(r) {
    const tops = new Set(r.page.systems.map((s) => s.top));
    const order = new Map(r.page.systems.map((s, i) => [s.top, i]));
    return r.notes
      // 和弦里的附加音不算旋律（引子的柱状和弦、双音都靠它剔掉）；
      // 一行谱写了两个声部时只取第一声部（GT 是单声部主旋律）
      .filter((n) => tops.has(n.staff) && !n.chordExtra && n.voice === 1)
      .sort((a, b) => order.get(a.staff) - order.get(b.staff) || a.x - b.x);
  }

  /** 这一页的调号：第一个系统顶行的调号记号，升号计正、降号计负。 */
  function pageFifths(r) {
    const st = r.page.systems[0]?.top ?? r.page.staves[0];
    if (!st) return null;
    const key = r.ctx.get(st)?.key ?? [];
    const sharps = key.filter((k) => k.code === "accidentalSharp").length;
    const flats = key.filter((k) => k.code === "accidentalFlat").length;
    return sharps - flats;
  }

  function durType(n) {
    const map = [[2, "breve"], [1, "whole"], [1 / 2, "half"], [1 / 4, "quarter"], [1 / 8, "eighth"], [1 / 16, "16th"], [1 / 32, "32nd"], [1 / 64, "64th"]];
    let best = "quarter";
    let bd = Infinity;
    for (const [v, name] of map) {
      const d = Math.abs(v - n.base);
      if (d < bd) { bd = d; best = name; }
    }
    return best + ".".repeat(n.dots);
  }

  // ── 曲目 ↔ 页码 ─────────────────────────────────────────────────────────────
  //
  // 两步：
  //   1. 按判据找出**所有首页**（第一行谱之上有一条 ≥ 正文字号 1.6 倍的文本），
  //      曲子的页范围由相邻首页切开。只按「对上标题的那些」切范围会把中间没对上的曲子
  //      整个吞进来（实测 018 首从 159 个音涨到 384 个）。
  //   2. 首页 ↔ GT 用**动态规划**对齐（两边都按顺序排，GT 的曲号跟着成书顺序，
  //      书里另有 GT 没收的曲子，所以是「带跳过的单调匹配」）。
  //      配对分数取「标题相同」与「开头音符序列相似度」的较大者：
  //      **光靠标题只对上 64/222**——几档 CJK 字体的 ToUnicode 是坏的（标题读成乱码），
  //      而 GT 里只有 97 首写了英文名。音符那一路不依赖任何字体。
  const t2s = await loadT2S();
  const normEn = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normZh = (s) => t2s(s).replace(/[\s\u3000·．.,，、:：]/g, "");

  const index = new Map();
  for (const s of songs) {
    if (s.en) index.set("en:" + normEn(s.en), s);
    if (s.zh) index.set("zh:" + normZh(s.zh), s);
  }

  const startPages = pageInfo.filter((p) => p.songStart).map((p) => p.pn);
  const pageOf = new Map(pageInfo.map((p) => [p.pn, p]));
  log(`按判据找到首页 ${startPages.length} 个`);

  /** 首页 → 该曲的页范围与音符（下一首页之前，中途遇到没有谱表的页也断开）。 */
  const spans = startPages.map((page, i) => {
    let end = i + 1 < startPages.length ? startPages[i + 1] - 1 : doc.numPages;
    for (let p = page; p <= end; p++) if (!pageOf.get(p)?.hasStaff) { end = p - 1; break; }
    const notes = [];
    const types = [];
    const slurs = [];
    const pitches = [];
    let measures = 0;
    let repeats = 0;
    let barStyles = 0;
    let endings = 0;
    let octaves = 0;
    const verses = {};
    const lyricGlyphs = {};
    for (let p = page; p <= end; p++) {
      notes.push(...(pageOf.get(p)?.notes ?? []));
      types.push(...(pageOf.get(p)?.types ?? []));
      slurs.push(...(pageOf.get(p)?.slurs ?? []));
      pitches.push(...(pageOf.get(p)?.pitches ?? []));
      measures += pageOf.get(p)?.measures ?? 0;
      repeats += pageOf.get(p)?.repeats ?? 0;
      barStyles += pageOf.get(p)?.barStyles ?? 0;
      endings += pageOf.get(p)?.endings ?? 0;
      octaves += pageOf.get(p)?.octaves ?? 0;
      for (const [v, a] of Object.entries(pageOf.get(p)?.lyricGlyphs ?? {})) (lyricGlyphs[v] ??= []).push(...a);
      for (const [v, t] of Object.entries(pageOf.get(p)?.verses ?? {})) verses[v] = (verses[v] ?? "") + t;
    }
    const fifths = pageOf.get(page)?.fifths ?? null;
    const titleHit = (pageOf.get(page)?.titles ?? [])
      .map((t) => index.get(/[\u4e00-\u9fff]/.test(t.text) ? "zh:" + normZh(t.text) : "en:" + normEn(t.text)))
      .find(Boolean);
    return { from: page, to: end, notes, types, slurs, pitches, measures, repeats, barStyles, endings, octaves, fifths, verses, lyricGlyphs, titleGlyphs: pageOf.get(page)?.titleGlyphs ?? [], titleHit };
  });


  /** 开头 HEAD 个音的相似度。整首比太慢（464×222），开头已经足够分辨。 */
  const HEAD = 32;
  const headOf = (a) => a.slice(0, HEAD);
  /**
   * 接受一次配对的最低分。
   *
   * 门槛是拿**歌词**扫出来的——歌词是配对的照妖镜：配错了曲，歌词准确率立刻掉到 0
   * （而音符相似度还能有个五六成，因为同调的赞美诗旋律本来就像）。
   * 实测 0.5 → 135 首但 62 首歌词全错；0.65 → 98 首、歌词全错的降到 31 首；
   * 再往上（0.7）多花 4 首只换回 4 首。取 0.65。
   */
  const MATCH_MIN = Number(process.env.MATCH_MIN ?? 0.65);

  /** 这一段谱面的歌词里汉字占多少（0~1）。 */
  const cjkRatio = (span) => {
    let cjk = 0;
    let all = 0;
    for (const t of Object.values(span.verses ?? {})) {
      for (const ch of t) {
        if (/\s/.test(ch)) continue;
        all++;
        if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) cjk++;
      }
    }
    return all ? cjk / all : 0;
  };

  /**
   * **同一首歌这本书印两遍**（中文歌词版 + 英文歌词版），两版的音符序列几乎一样，
   * 标题也各自能对上（GT 里中英文标题都有）。光看音符或标题分不出该配哪一版，
   * 而 GT 的歌词是中文——中文那一版才是对的。
   *
   * 于是给「歌词里有汉字」的那一段加一点分。加分要**小**：只在平手时起作用，
   * 不能盖过音符相似度本身的高低。
   */
  //
  // **实测这条加分在本书上没赚到**（歌词档 49.9% → 49.6%）：那些配到英文版的曲子，
  // 谱面上根本没有音符对得上的中文版可挑——加分只会把它们推给别的、更不像的中文段。
  // 留着并置零，是为了记下这条试过、结论是什么。
  const CJK_BONUS = 0;

  const score = (span, song) => {
    if (span.titleHit && span.titleHit !== song) return 0; // 标题已经指名别人，不许改判
    let base;
    if (span.titleHit === song) {
      base = 1;
    } else {
      // 音符数差一倍以上的一律不配：开头三十几个音撞上是有可能的（同调同起句），
      // 但整首长度差一倍就不是同一首。
      const ratio = span.notes.length / Math.max(song.notes.length, 1);
      if (ratio < 0.5 || ratio > 2) return 0;
      // 谱面常常比 GT 多一段**引子**（p205 头一行是柱状和弦的前奏，GT 从第 5 小节起），
      // 从头比会被引子顶掉。改成：拿 GT 的开头去谱面的前若干音里找**最像的一个窗口**。
      base = bestWindow(span.notes, headOf(song.notes));
      if (base < MATCH_MIN) return base;
    }
    return base + (cjkRatio(span) > 0.3 ? CJK_BONUS : 0);
  };

  // 谱面这一段的歌词里汉字占比（对拍那边要用来分「英文版」与「真读错」）
  for (const sp of spans) sp.cjkRatio = cjkRatio(sp);

  // **全局贪心配对**（不加单调约束）。
  // 本以为可以按顺序对齐——GT 曲号跟着成书顺序，书里另有 GT 没收的曲子。
  // 实测不成立：这本 PDF 是几本册子拼起来的「全系列」，后半段不按曲号走
  // （152 首在 p281、010 首在 p467）。加了单调约束会把不同册的曲子整批丢掉。
  // 所以按分数从高到低贪心，一首 GT、一个首页各只用一次。
  const pairs = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = 0; j < songs.length; j++) {
      const sc = score(spans[i], songs[j]);
      if (sc >= MATCH_MIN) pairs.push([sc, i, j]);
    }
  }
  pairs.sort((a, b) => b[0] - a[0]);
  const usedSpan = new Set();
  const usedSong = new Set();
  const results = [];
  for (const [, i, j] of pairs) {
    if (usedSpan.has(i) || usedSong.has(j)) continue;
    usedSpan.add(i);
    usedSong.add(j);
    const sp = spans[i];
    results.push({ song: songs[j], from: sp.from, to: sp.to, cjkRatio: sp.cjkRatio, notes: sp.notes, types: sp.types, slurs: sp.slurs, pitches: sp.pitches, measures: sp.measures, repeats: sp.repeats, barStyles: sp.barStyles, endings: sp.endings, octaves: sp.octaves, fifths: sp.fifths, verses: sp.verses, lyricGlyphs: sp.lyricGlyphs, titleGlyphs: sp.titleGlyphs });
  }
  results.sort((a, b) => a.from - b.from);
  log(`对上 ${results.length}/${songs.length} 首（其中标题直接命中 ${spans.filter((s) => s.titleHit).length} 个首页）`);


  return { cli, doc, OPS, songs, pageInfo, spans, results, t2s, normEn, normZh, textLookup };
}
