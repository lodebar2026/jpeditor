// 文本层：歌词 / 和弦 / 速度 / 表情 / 乐器名 / 文本框 / 方框字 / 小节号。
// 移植自 musicpp `qtomr/TextAnalyze.cpp`（+ `qomr.cpp::findHarmonies` 的调用顺序）。
//
// musicpp 到**打标为止**就结束了——它的 `toxml.cpp` 并不导出歌词与和弦。
// 「把歌词逐字挂到音符上」那一段是本仓新加的（`buildLyricLines` / `attachLyrics`），
// 口径照简谱那条路（`src/omr/lyrics.ts`）：**逐字挂音符**，一行歌词 = 一个 verse。
import type { VecGlyph } from "../omr/vectext";
import type { TextGlyphLookup } from "./textglyphs";
import { type Box, PObj, SPage, Staff, between, overlapX, overlapY, xSpace, ySpace } from "./model";

/** 一段文本的纯文字内容（ToUnicode 的结果，可能是乱码，见文档「坏 ToUnicode」一节）。
 *  名字带 `objText` 前缀是为了不与 `pdflayout/bookmeta.ts::runText` 撞——那份收的是
 *  500 首那条转曲路的 `TextRun`，两边的入参类型完全不同。 */
export function objText(o: PObj): string {
  return o.run ? o.run.glyphs.map((g) => g.unicode).join("") : "";
}

/**
 * `TextAnalyze` 的构造：收「不在谱表五线之内」的文字对象与非虚线的水平段。
 * 落在谱线之间的文字是谱内元素（力度、指法），不进这一摊。
 */
function collectTexts(pg: SPage): { texts: PObj[]; hlines: Box[] } {
  const texts: PObj[] = [];
  for (const o of pg.objs) {
    if (!o.run) continue;
    if (o.symbols.length) continue; // 音乐字体的对象归 findSymbols
    let inStaff = false;
    const cy = (o.box.top + o.box.bottom) / 2;
    for (const st of pg.staves) {
      if (Math.abs(st.middleStep(cy)) <= 4) {
        inStaff = true;
        break;
      }
    }
    if (inStaff) continue;
    texts.push(o);
  }
  const hlines = pg.segs.filter((s) => s.isH && !s.hasAnyTag()).map((s) => s.box);
  return { texts, hlines };
}

const isStepChar = (c: string): boolean => c >= "A" && c <= "G";

/** 单个和弦记号的语法。与 `src/omr/chordline.ts::CHORD_TOKEN_RE` 同一条
 *  （根音必须大写、长后缀在前），**改一处要两处一起改**。 */
const CHORD_TOKEN_RE = /^[A-G][#♯b♭]?(?:maj|min|dim|aug|sus|add|m|M)?\d*(?:sus\d*|add\d*)?(?:\/[A-G][#♯b♭]?)?/;

export interface TextAnalysis {
  lyric: PObj[];
  harmony: PObj[];
  tempo: PObj[];
  expression: PObj[];
  instrument: PObj[];
  measureNumber: PObj[];
  boxed: PObj[];
  textFrame: PObj[];
}

/** `Page::findHarmonies` 的调用顺序，**别调**：先歌词、再和弦、再和弦后缀…… */
export function analyzeText(pg: SPage): TextAnalysis {
  const { texts, hlines } = collectTexts(pg);
  const kind = new Map<PObj, keyof TextAnalysis>();
  const sp = pg.normalStaffSpace || pg.space;

  // ── 和弦记号（**先于**歌词判） ────────────────────────────────────────────
  //
  // 这一步是本仓加的，musicpp 没有。原因：musicpp 的 `markHarmony` 只认三种形状
  // （含 `/`、单个大写音名、`X Y`），本书的 `D m7` / `B♭Maj7` / `A dim/E♭` 一个都不沾边；
  // 而歌词那一步的判据（纵向跨过某条水平线的 y）会把和弦一并收成歌词
  // ——实测 p100 的 `G` 被挂成了第二段歌词。所以先把**明确是和弦记号**的挑出来。
  // 记号语法复用简谱那条路的 `CHORD_TOKEN_RE`（根音必须大写，理由见那边的注释）。
  for (const t of texts) {
    if (kind.has(t)) continue;
    const raw = objText(t).replace(/\s+/g, "");
    if (!raw) continue;
    const m = CHORD_TOKEN_RE.exec(raw);
    if (m && m[0].length === raw.length) kind.set(t, "harmony");
  }

  // ── markHarmonySuffix（**提前到歌词之前**） ────────────────────────────────
  //
  // musicpp 把它排在 markLyric 之后。本书不行：`Maj7` / `m7` / `sus4` 这些后缀是独立的
  // 文本对象，歌词那一步会先把它们收成第二段歌词（实测 p100 的第二段唱出了「26 7 m7」），
  // 于是和弦只剩一个光根音。挪到歌词之前，两边都对。
  // `m7` / `sus4` / `maj7` 是紧跟在和弦根音**右边、同一行**的另一个文本对象。
  for (const t of texts) {
    if (kind.has(t)) continue;
    for (const [h, k] of kind) {
      if (k !== "harmony") continue;
      if (!overlapY(t.box, h.box)) continue;
      const dist = t.box.left - h.box.right;
      const hh = h.box.bottom - h.box.top;
      // musicpp 的上限是根音盒高的一半（≈0.7 格）。本书的和弦印成 `A dim/E♭`——
      // 根音与后缀之间**有一个空格**，实测间隙 10pt ≈ 2 格，那条门槛全卡掉。
      // 放到两格：同一行里相邻的两个和弦间隔十格开外，不会误并。
      if (dist < -hh / 4 || dist > Math.max(hh / 2, 2 * sp)) continue;
      kind.set(t, "harmony");
      break;
    }
  }

  // ── markLyric（含 markHyphen） ─────────────────────────────────────────────
  // 判据照原文：先找**带连字符且不含数字**的文本，记下它们的中心 y；
  // 再把水平线（歌词的延长线）的上沿也记进去；凡纵向跨过这些 y 的文本都是歌词。
  // 「不含数字」那条是要害——`D m7/C` 这类和弦也带 `-` 之外的记号，数字一票否决。
  const cys: number[] = [];
  for (const t of texts) {
    const s = objText(t);
    if (!s.includes("-")) continue;
    if (/[0-9]/.test(s)) continue;
    cys.push((t.box.top + t.box.bottom) / 2);
    kind.set(t, "lyric");
  }
  for (const l of hlines) cys.push(l.top);
  for (const t of texts) {
    if (kind.has(t)) continue;
    if (cys.some((y) => between(t.box.top, t.box.bottom, y))) kind.set(t, "lyric");
  }

  // ── 中文歌词行的补锚（本仓新加） ──────────────────────────────────────────
  //
  // 上面那两个锚点都是**西文**的：带连字符的音节、音节之间的延长线。
  // 这本书的中文歌词逐字一个音节、字与字之间既不连字也不拉线，
  // 一整行下来一个锚点都没有——整行歌词就此丢掉
  // （实测 p27 第一行谱下的「田中的白鷺鷥無欠缺什麼」，那一首歌词只剩后五行）。
  //
  // 补的这一道是**自校准**的：拿这一页已经认定的歌词学出「字体 + 字号 + 离谱表底多远」，
  // 同字体同字号、落在同一条带里的未定文本也算歌词。不写绝对几何——
  // 那会把版权行、段落词、表情记号一并收进来。
  const known = texts.filter((t) => kind.get(t) === "lyric" && t.run);
  if (known.length) {
    /** 这段文本上方最近的那行谱（没有就是 null）。 */
    const staffAbove = (t: PObj): Staff | null => {
      let best: Staff | null = null;
      for (const st of pg.staves) {
        if (st.box.bottom > (t.box.top + t.box.bottom) / 2) continue;
        if (!best || st.box.bottom > best.box.bottom) best = st;
      }
      return best;
    };
    const fonts = new Set(known.map((t) => t.run!.font));
    const sizes = known.map((t) => t.run!.sizeDev).sort((a, b) => a - b);
    const size = sizes[sizes.length >> 1];
    let maxOff = 0;
    for (const t of known) {
      const st = staffAbove(t);
      if (st) maxOff = Math.max(maxOff, t.box.top - st.box.bottom);
    }
    if (maxOff > 0) {
      for (const t of texts) {
        if (kind.has(t) || !t.run) continue;
        if (!fonts.has(t.run.font)) continue;
        if (Math.abs(t.run.sizeDev - size) > size * 0.05) continue;
        const st = staffAbove(t);
        if (!st) continue;
        const off = t.box.top - st.box.bottom;
        // 落在已知歌词那条带里（宽一格的余量），且没越过下一行谱
        if (off < 0 || off > maxOff + sp) continue;
        const next = pg.staves.find((q) => q.box.top > st.box.bottom && q.box.top < t.box.bottom);
        if (next) continue;
        kind.set(t, "lyric");
      }
    }
  }

  // ── markHarmony ───────────────────────────────────────────────────────────
  // 判据照原文：含 `/`（转位和弦）；或整段就是一个大写音名；或 `X Y` 两个音名夹一个空格。
  for (const t of texts) {
    if (kind.has(t)) continue;
    let s = objText(t);
    let harm = s.includes("/");
    if (s.endsWith(" ")) s = s.slice(0, -1);
    if (s.length === 1 && isStepChar(s)) harm = true;
    if (s.length === 3 && s[1] === " " && isStepChar(s[0]) && isStepChar(s[2])) harm = true;
    if (harm) kind.set(t, "harmony");
  }

  // ── findInstrumentName ────────────────────────────────────────────────────
  // 系统线**左边**、纵向相交、离得不远的文字是声部名。
  for (const l of pg.segsWithTag("SysLine")) {
    for (const t of texts) {
      if (kind.has(t)) continue;
      if (t.box.left > l.box.right) continue;
      if (!overlapY(l.box, t.box)) continue;
      if (xSpace(l.box, t.box) > 6 * sp) continue;
      kind.set(t, "instrument");
    }
  }

  // ── findTempo ─────────────────────────────────────────────────────────────
  // 带 `=` 的那一段（`♩= 72`）连同同一行里**间距不超过三格**的左右邻居。
  for (const eq of pg.objs) {
    if (!eq.run || eq.hasAnyTag() || kind.has(eq)) continue;
    if (!objText(eq).includes("=")) continue;
    const row = pg.objs.filter((o) => o.run && overlapY(o.box, eq.box)).sort((a, b) => a.box.left - b.box.left);
    const idx = row.indexOf(eq);
    if (idx < 0) continue;
    let first = idx;
    for (let i = idx; i > 0; i--) {
      if (xSpace(row[i].box, row[i - 1].box) > 3 * sp) break;
      first = i - 1;
    }
    let last = idx;
    for (let i = idx; i < row.length - 1; i++) {
      if (xSpace(row[i].box, row[i + 1].box) > 3 * sp) break;
      last = i + 1;
    }
    for (let i = first; i <= last; i++) if (!kind.has(row[i])) kind.set(row[i], "tempo");
  }

  // ── findExpression ────────────────────────────────────────────────────────
  for (const t of texts) {
    if (kind.has(t)) continue;
    if (EXPRESSIONS.has(objText(t).trim().toLowerCase())) kind.set(t, "expression");
  }

  // ── findMeasureNumber ─────────────────────────────────────────────────────
  // 纯数字（或数字加连字符），且与某条系统线上下相邻。
  const syslines = pg.segsWithTag("SysLine");
  for (const o of pg.objs) {
    if (!o.run || o.hasAnyTag() || kind.has(o)) continue;
    const s = objText(o).trim();
    if (!/^[\d-]+$/.test(s)) continue;
    for (const l of syslines) {
      if (!overlapX(o.box, l.box)) continue;
      if (ySpace(o.box, l.box) > 3 * sp) continue;
      kind.set(o, "measureNumber");
      break;
    }
  }

  // ── findBoxedText ─────────────────────────────────────────────────────────
  // 描边矩形里圈住的文字（段落名「Chorus」之类）。
  for (const o of pg.objs) {
    if (o.hasAnyTag() || !o.path) continue;
    if (!o.path.paint.toLowerCase().includes("stroke")) continue;
    if (o.path.curves) continue;
    const inside = texts.filter((t) => !kind.has(t) && overlapX(t.box, o.box) && overlapY(t.box, o.box));
    if (!inside.length) continue;
    for (const t of inside) kind.set(t, "boxed");
  }

  // ── findTextFrames ────────────────────────────────────────────────────────
  // 同字体同字号、上下相接、左/右/中任一对齐的若干行 = 一个文本框（版权声明之类）。
  const poss = pg.objs.filter((o) => o.run && !o.hasAnyTag() && !kind.has(o) && !o.symbols.length).sort((a, b) => a.box.top - b.box.top);
  const usedIdx = new Set<number>();
  for (let i = 0; i < poss.length; i++) {
    if (usedIdx.has(i)) continue;
    const arr = [i];
    let boxI = poss[i].box;
    let cxI = (boxI.left + boxI.right) / 2;
    const szI = poss[i].run!.sizeDev;
    const fnI = poss[i].run!.font;
    for (let j = i + 1; j < poss.length; j++) {
      if (usedIdx.has(j)) continue;
      if (Math.abs(szI - poss[j].run!.sizeDev) > sp / 10) continue;
      if (fnI !== poss[j].run!.font) continue;
      const boxJ = poss[j].box;
      const cxJ = (boxJ.left + boxJ.right) / 2;
      if (ySpace(boxJ, boxI) > 2 * sp) continue;
      if (Math.abs(boxI.left - boxJ.left) < sp || Math.abs(boxI.right - boxJ.right) < sp || Math.abs(cxI - cxJ) < sp) {
        arr.push(j);
        boxI = boxJ;
        cxI = cxJ;
      }
    }
    if (arr.length <= 1) continue;
    for (const k of arr) {
      usedIdx.add(k);
      kind.set(poss[k], "textFrame");
    }
  }

  const out: TextAnalysis = { lyric: [], harmony: [], tempo: [], expression: [], instrument: [], measureNumber: [], boxed: [], textFrame: [] };
  const TAG = {
    lyric: "Lyric",
    harmony: "Harmony",
    tempo: "Tempo",
    expression: "Expression",
    instrument: "Instrument",
    measureNumber: "MeasureNumber",
    boxed: "Boxed",
    textFrame: "TextFrame",
  } as const;
  for (const [o, k] of kind) {
    out[k].push(o);
    o.addTag(TAG[k]);
  }
  return out;
}

/** `findExpression` 的表情术语表，照抄 musicpp 原文（小写比对）。 */
const EXPRESSIONS = new Set(
  [
    "a tempo", "unis.", "cresc.", "sub.", "sim.", "l.h.", "r.h.", "rubato",
    "cresc. al fine", "no rit.", "poco rit.", "dim. e rit.", "molto rall.",
    "molto rit.", "poco rall.", "rit.", "n.c.", "s.a.", "t.b.", "rall.",
    "cresc. poco a poco", "driving to the end", "slightly slower",
    "slightly broader", "with great rejoicing", "soprano", "alto", "freely",
    "slowly", "with motion", "s.a. unison", "t.b. unison", "c instrument",
    "expressively", "handbells", "tambourine", "gradually building",
    "(a few sopranos)", "(l.h. over)",
  ].map((s) => s.toLowerCase()),
);

// ── 歌词 → 音节 ─────────────────────────────────────────────────────────────

/** 一个音节：文字 + 它在页面上的中心 x。 */
export interface Syllable {
  text: string;
  cx: number;
  left: number;
  right: number;
  /** 后面跟着连字符（与下一个音节同属一个词）。 */
  hyphen: boolean;
  /** 组成它的字形。拿 GT 自举字形字典要用（见 `textglyphs.ts`）：
   *  ToUnicode 坏掉的那几档字体里 `text` 是乱码，字形轮廓才是唯一可信的身份。 */
  glyphs: VecGlyph[];
  /** 字形所属的字体家族与设备字号（查字典与建库都要，别再回头去 objs 里找）。 */
  font: string;
  sizeDev: number;
}

/**
 * 去掉**重描**出来的重复音节。
 *
 * 这一批 PDF 会把同一段文字画两遍（小节线也是这么画的，见 page.ts::mergeRedrawn）。
 * 不去重的话歌词里会冒出「春天现现香」「呼呼」「地上地上」这种叠字。
 *
 * 判据：**同一个字**且横向几乎重合（中心差不到自身宽度的三成）。
 * 只按位置不看字的话，会把「一一」「永永远远」这种真叠字也压掉。
 */
function dedupeSyllables(list: Syllable[]): Syllable[] {
  const out: Syllable[] = [];
  for (const s of list) {
    const prev = out[out.length - 1];
    if (prev && prev.text === s.text && Math.abs(prev.cx - s.cx) < (s.right - s.left) * 0.3) continue;
    out.push(s);
  }
  return out;
}

/** 这个字符是不是「认得出来的正文字符」：汉字、ASCII 可打印、常见中文标点。
 *  不在其列的多半是坏 ToUnicode 漏出来的乱码。 */
function isKnownChar(c: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff65\x20-\x7e]/.test(c);
}

/** 一行歌词：属于某一行谱的一段（第几段由行的上下顺序定）。 */
export interface LyricLine {
  staff: Staff;
  verse: number;
  top: number;
  syllables: Syllable[];
}

/**
 * 歌词文本 → 逐音节。
 *
 * 汉字一字一音节；拉丁文按空格断词、词内按 `-` 再断音节。
 * **连字符与延长线本身不是音节**（`-`、`--`、`__`），照 musicpp `replaceLrc` 的做法跳过。
 */
export function splitSyllables(o: PObj, dict?: TextGlyphLookup): Syllable[] {
  const run = o.run;
  if (!run) return [];
  const em = run.sizeDev || 1;
  const out: Syllable[] = [];
  let cur: { chars: string[]; left: number; right: number; glyphs: VecGlyph[] } | null = null;
  const flush = (hyphen: boolean) => {
    if (!cur) return;
    const text = cur.chars.join("").trim();
    // 纯数字的不是歌词：那是**小节号**（`findMeasureNumber` 只认得贴着系统线的那些，
    // 印在框里的漏网）与行首的段号「1.」。GT 那边也把段号剔掉了。
    if (text && !/^[-_–—]+$/.test(text) && !/^\d+[.．、]?$/.test(text)) {
      out.push({ text, cx: (cur.left + cur.right) / 2, left: cur.left, right: cur.right, hyphen, glyphs: cur.glyphs, font: run.font, sizeDev: run.sizeDev });
    }
    cur = null;
  };
  for (const g of run.glyphs) {
    // 字形字典优先于 ToUnicode：本书几档 CJK 字体的 ToUnicode 是坏的（见 textglyphs.ts）
    const c = dict ? dict.lookup(run.font, g) : g.unicode;
    // **认不出来的小墨迹一律不输出**。那些是标点（「，」「。」之类）：
    // 字形字典按 GT 的歌词自举，而 GT 那侧的标点被归一掉了，所以标点的类永远定不了案，
    // 只能带着坏 ToUnicode 的乱码漏出来——实测占了中文歌词错字的一大半。
    // 吐一个乱码字比不吐更糟：不吐至少不会把后面的字顶偏。
    if (c && !isKnownChar(c) && g.bbox.w < em * 0.5 && g.bbox.h < em * 0.5) {
      flush(false);
      continue;
    }
    // **整字见方的墨迹，却只读出一个 ASCII 字符：那是这套字体的全角空格。**
    // 这本书的歌词逐字一个文本对象，每个字后面跟一个这样的字形（全书 1754 个），
    // 它的 ToUnicode 是 `!`、轮廓是个空的字身框，量出来正好一个 em 见方。
    // 真的 ASCII 字母不会填满一个 em 见方，汉字则由字形字典给出汉字——
    // 所以这一条只会打中它。从前是靠形近补字歪打正着把它标成「1」、
    // 再被「纯数字不是歌词」那条剔掉的，字典一重建就露馅（歌词里冒出一串 `!`）。
    // `bboxEstimated` 的不算数：那是没有轮廓、按 advance 估的盒，量不出真墨迹。
    if (!g.bboxEstimated && g.bbox.w >= em * 0.8 && g.bbox.h >= em * 0.8 && c && /^[\x20-\x7e]$/.test(c)) {
      flush(false);
      continue;
    }
    if (!c || c === " " || c === "　") {
      flush(false);
      continue;
    }
    if (c === "-" || c === "–" || c === "—") {
      flush(true);
      continue;
    }
    if (c === "_") {
      flush(false);
      continue;
    }
    const cjk = /[㐀-鿿豈-﫿＀-￯]/.test(c);
    if (cjk) {
      flush(false);
      out.push({ text: c, cx: g.bbox.x + g.bbox.w / 2, left: g.bbox.x, right: g.bbox.x + g.bbox.w, hyphen: false, glyphs: [g], font: run.font, sizeDev: run.sizeDev });
      continue;
    }
    if (!cur) cur = { chars: [], left: g.bbox.x, right: g.bbox.x + g.bbox.w, glyphs: [] };
    cur.chars.push(c);
    cur.glyphs.push(g);
    cur.right = g.bbox.x + g.bbox.w;
  }
  flush(false);
  return out;
}

/**
 * 把歌词对象归成「哪一行谱的第几段」。
 *
 * 规则：一行歌词属于**它上方最近的那行谱**；同一行谱下方的歌词行按 y 从上到下
 * 依次是第 1、2、3 段。归行用纵向重叠（同一段歌词可能拆成好几个文本对象）。
 */
export function buildLyricLines(pg: SPage, lyrics: PObj[], dict?: TextGlyphLookup): LyricLine[] {
  const rows: { top: number; bottom: number; objs: PObj[] }[] = [];
  for (const o of lyrics.slice().sort((a, b) => a.box.top - b.box.top)) {
    const row = rows.find((r) => o.box.top < r.bottom && r.top < o.box.bottom);
    if (row) {
      row.objs.push(o);
      row.top = Math.min(row.top, o.box.top);
      row.bottom = Math.max(row.bottom, o.box.bottom);
    } else rows.push({ top: o.box.top, bottom: o.box.bottom, objs: [o] });
  }
  const byStaff = new Map<Staff, { top: number; objs: PObj[] }[]>();
  // 歌词离它那行谱有多远才算「不是这行的」：三个谱表高。
  // 不设上限的话，页脚的版权声明会被算成最后一行谱的歌词
  // （实测 p154 的 "Copyright 1953 S. K. Hine…" 就是这么混进去的）。
  const maxGap = Math.max(...pg.staves.map((s) => s.box.bottom - s.box.top), 1) * 3;
  for (const r of rows) {
    // 上方最近的那行谱
    let best: Staff | null = null;
    let bestD = Infinity;
    for (const st of pg.staves) {
      const d = r.top - st.box.bottom;
      if (d < 0) continue;
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    if (!best || bestD > maxGap) continue;
    const a = byStaff.get(best) ?? [];
    a.push({ top: r.top, objs: r.objs });
    byStaff.set(best, a);
  }
  const out: LyricLine[] = [];
  for (const [staff, rs] of byStaff) {
    rs.sort((a, b) => a.top - b.top);
    rs.forEach((r, i) => {
      const syllables = dedupeSyllables(r.objs.flatMap((o) => splitSyllables(o, dict)).sort((a, b) => a.cx - b.cx));
      if (syllables.length) out.push({ staff, verse: i + 1, top: r.top, syllables });
    });
  }
  return out;
}

// ── 挂到音符上 ──────────────────────────────────────────────────────────────

interface NoteLike {
  staff: Staff;
  rest: boolean;
  x: number;
  lyrics?: { verse: number; text: string; hyphen: boolean }[];
  chord?: string;
}

/**
 * 歌词逐音节挂到音符上。
 *
 * **休止不挂词**（谱面上歌词只写在发声的音上）。同一行谱内按 x 双指针就近配对，
 * 保持顺序——不保持顺序的话，一个音节撞上邻音就会把后面整行错位。
 */
export function attachLyrics(notes: NoteLike[], lines: LyricLine[]): void {
  for (const line of lines) {
    const cand = notes.filter((n) => n.staff === line.staff && !n.rest).sort((a, b) => a.x - b.x);
    if (!cand.length) continue;
    let ni = 0;
    for (const syl of line.syllables) {
      // 往前推到「再往前就更远」为止
      while (ni + 1 < cand.length && Math.abs(cand[ni + 1].x - syl.cx) < Math.abs(cand[ni].x - syl.cx)) ni++;
      const n = cand[ni];
      (n.lyrics ??= []).push({ verse: line.verse, text: syl.text, hyphen: syl.hyphen });
      if (ni + 1 < cand.length) ni++;
    }
  }
}

/**
 * 和弦文本 → 挂到音符上。
 *
 * 谱面把根音与后缀印成**两个文本对象**（`D` + `m7`），`markHarmonySuffix` 已经各自打了标，
 * 这里按「同一行、左右相接」再拼回一个记号；根音里的升降号是音乐字体的字形
 * （`accidentalFlat` / `accidentalSharp`），照本仓和弦的写法**提到根音之后**写成 ASCII。
 */
export function attachHarmonies(pg: SPage, notes: NoteLike[], harmonies: PObj[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  // **先按行归组、行内再按 x 排**。直接 `sort(top, left)` 不行：根音与后缀的
  // 基线差个零点几 pt（`D`@y128 与 `m7`@y127），一排下来会把所有根音排到所有后缀前面，
  // 于是一个都拼不上。
  const rows: { top: number; bottom: number; objs: PObj[] }[] = [];
  for (const o of harmonies.slice().sort((a, b) => a.box.top - b.box.top)) {
    const row = rows.find((r) => o.box.top < r.bottom && r.top < o.box.bottom);
    if (row) {
      row.objs.push(o);
      row.top = Math.min(row.top, o.box.top);
      row.bottom = Math.max(row.bottom, o.box.bottom);
    } else rows.push({ top: o.box.top, bottom: o.box.bottom, objs: [o] });
  }
  const groups: { text: string; box: Box }[] = [];
  for (const row of rows) {
    row.objs.sort((a, b) => a.box.left - b.box.left);
    let last: { text: string; box: Box } | null = null;
    for (const o of row.objs) {
      const t = objText(o).trim();
      if (!t) continue;
      // 同一个和弦记号的根音与后缀是紧挨着的两个对象（`D` + `m7`、`B` + `Maj7`、`A` + `dim`）。
      // 门槛取两个线距——`A dim` 中间有个空格，实测 10pt ≈ 2 格；
      // 而同一行里相邻的两个和弦间隔十格开外，不会误并。
      if (last && o.box.left - last.box.right < 2 * sp) {
        last.text += t;
        last.box = {
          left: last.box.left,
          right: Math.max(last.box.right, o.box.right),
          top: Math.min(last.box.top, o.box.top),
          bottom: Math.max(last.box.bottom, o.box.bottom),
        };
      } else {
        last = { text: t, box: { ...o.box } };
        groups.push(last);
      }
    }
  }
  // 谱面上的升降号是乐谱字形，混在和弦带里；补进对应的记号
  for (const s of pg.symbols) {
    if (s.code !== "accidentalFlat" && s.code !== "accidentalSharp") continue;
    if (s.hasTag("Key") || s.hasTag("Accidental")) continue;
    const g = groups.find((q) => overlapY(q.box, s.box) && s.box.left >= q.box.left && s.box.left - q.box.right < sp);
    if (!g) continue;
    // 升降号写在根音**之后**（`Bb` / `F#`）——`harmonyXml` 是这么解的。
    // 谱面印的是 `B♭Maj7`（升降号在根音后、后缀前），拼出来的 `BMaj7b` 解不出，
    // 所以插在第一个字母后面，而不是往末尾追加。
    g.text = g.text.slice(0, 1) + (s.code === "accidentalFlat" ? "b" : "#") + g.text.slice(1);
    g.box.right = Math.max(g.box.right, s.box.right);
  }
  for (const g of groups) {
    const text = g.text.replace(/\s+/g, "");
    if (!text) continue;
    // 和弦印在音符**上方**：挂给它下面那行谱里 x 最近、且不在它左边太多的那个音符
    let best: NoteLike | null = null;
    let bestD = Infinity;
    for (const n of notes) {
      if (n.staff.box.top < g.box.bottom) continue; // 只看和弦下方的谱行
      const d = Math.abs(n.x - g.box.left);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (best && bestD < sp * 6) best.chord ??= text;
  }
}
