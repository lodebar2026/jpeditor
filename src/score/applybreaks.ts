// 把乐句分析的断点写到 Score 上（成书重排用）。
//
// 与 jpscore.ts 那条路的分工：
//   scoreToJpwabc({phrase:true})  Score → .jpwabc 文本，断点写成 `$(true)` / `$(true,0,0,true)`，
//                                 编辑器要的是文本，所以走那条；代价是**经过 jpwabc 这层会降采样**
//                                 （和弦、装饰音、部分 barline 装不下）。
//   applyPhraseBreaks（本文件）    Score → Score，断点直接写成 `LineBreak` entry，
//                                 就是 layout.ts:1402 消费的那个东西。成书重排走这条，
//                                 数据一路不落地成文本，和弦与结构都能带到排版。
//
// 无 DOM 依赖。
import { Chord, LineBreak, Measure, Part } from "./score";
import { headFpOf, lyricPunctScore, mainLyricText, type PhraseBreaks } from "./phrase";

export interface ApplyBreakOptions {
  /** 每页几行。**0 = 不按行数换页**——成书排版走这个：一页装多少行交给
   *  layout 的 layoutVertically 按页高决定，硬定 4 行会让每页空掉半页。
   *  编辑器那条路（jpscore）仍是 4。 */
  linesPerPage?: number;
  /** 段落起点（主歌/副歌…）是否另起一页。成书里一首歌通常连排，默认不换。 */
  sectionNewPage?: boolean;
  /** 是否采用**行内断点**（`midBreaks`：在小节中间的和弦后换行）。
   *  弱起谱里乐句尾常被并进下一小节，行内断点就是为那种情形留的；
   *  但成书要的是**每行都在小节线上收尾**（原书就是这样），所以那边关掉它。 */
  useMidBreaks?: boolean;
}

export interface ApplyBreakResult {
  lines: number;
  pages: number;
}

function chordsOf(m: Measure): Chord[] {
  return m.entries.filter((e): e is Chord => e instanceof Chord);
}

function insertAfter(m: Measure, c: Chord, newPage: boolean): void {
  const i = m.entries.indexOf(c);
  const lb = new LineBreak(m);
  lb.newPage = newPage;
  // 与 Measure.lineBreak 同理：位置要跟着断点和弦走，否则 autoBeamGroup 的排序会把它挪到节首。
  lb.position = c.duration ? c.position.plus(c.duration) : c.position;
  m.entries.splice(i < 0 ? m.entries.length : i + 1, 0, lb);
}

/**
 * @param part   一般是 score.parts[0]
 * @param breaks computePhraseBreaks(part) 的结果
 */
export function applyPhraseBreaks(part: Part, breaks: PhraseBreaks, opt: ApplyBreakOptions = {}): ApplyBreakResult {
  const linesPerPage = opt.linesPerPage ?? 4;
  const sectionNewPage = opt.sectionNewPage ?? false;
  const useMidBreaks = opt.useMidBreaks ?? true;
  const ms = part.measures;
  let lines = 0;
  let pages = 1;
  // 段落起点一定换页，但**不能连着换两次**：段界落在小节内部（sectionCutChords）时，
  // 那个小节的末尾往往同时也是 measureBreaks 里的一条。
  let justPaged = false;

  const brk = (write: (page: boolean) => void, forcePage: boolean): void => {
    lines++;
    const page = forcePage || (linesPerPage > 0 && !justPaged && lines % linesPerPage === 0);
    write(page);
    if (page) {
      pages++;
      lines = 0;
    }
    justPaged = page;
  };

  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    for (const c of chordsOf(m)) {
      if (!useMidBreaks) break;
      if (!breaks.midBreaks.has(c) && !breaks.sectionCutChords.has(c)) continue;
      brk((page) => insertAfter(m, c, page), sectionNewPage && breaks.sectionCutChords.has(c));
    }
    const next = i + 1;
    if (next < ms.length && (breaks.measureBreaks.has(next) || breaks.sectionStarts.has(next))) {
      brk((page) => m.lineBreak(page), sectionNewPage && breaks.sectionStarts.has(next));
    }
  }
  return { lines, pages };
}

/** 一个小节占多少格（一个音符 1 格，长音的每根增时线各占 1 格）。与 phrase.ts 的口径一致。 */
function measureCells(m: Measure): number {
  let n = 0;
  for (const c of chordsOf(m)) n += Math.max(1, Math.floor(c.beats) || 1);
  return n;
}

/**
 * 容量保险：把**放不下的行**按小节切开。
 *
 * 乐句分析给的是「哪里断最自然」，但断点凭据稀疏时（弱起、整段连着圆滑线）它会交出
 * 一个九小节的长行；排版器随后按宽度硬折，甩出一个只剩两三个音的尾巴
 * （实测 006《颂赞归与耶稣圣名》就是这样：一行塞满 + 一行 "3 2 1--"）。
 * 所以在写 LineBreak 之前先按容量补几刀，切点取最接近目标行长的小节边界。
 *
 * @param cells 一行放得下几格（由排版器实测，见 browser.ts::measureCellsPerLine）
 * @param useMidBreaks 调用方是否会采用行内断点（与 applyPhraseBreaks 的同名选项保持一致）。
 *        不采用时行内断点不切行，这里也不能把它当行边界。
 */
export function enforceLineCapacity(part: Part, breaks: PhraseBreaks, cells: number, targetMeas = 4, useMidBreaks = true): void {
  const ms = part.measures;
  if (!ms.length || cells <= 0) return;
  // 小节数也设一道闸：格数是近似（增时线在乐句分析里按 0.7 折算，排版器却是整格），
  // 光看格数会漏掉「九小节一行」这种——006 的主歌就是这样，排版器随后硬折，
  // 甩出一行只剩 "3 2 1--"。
  const hardMeas = Math.max(targetMeas + 1, Math.ceil(targetMeas * 1.5));
  const pre = [0];
  for (const m of ms) pre.push(pre[pre.length - 1] + measureCells(m));
  // **照真正的行来判**（`describeLines`），别拿小节下标去重建行边界：行内断点落在小节中间，
  // 按「该小节归上一行」近似出来的边界与真实的行差着一格，于是一条本来放得下的行被判成超容量
  // 又切一刀，甩出个六格的小尾巴（286《耶和华祝福满满》的第 3 行）。
  for (const l of describeLines(part, breaks, useMidBreaks)) {
    const k = Math.max(Math.ceil(l.cells / cells), Math.ceil(l.bars / hardMeas));
    if (k <= 1) continue;
    // 能落刀的只有**这一行内部**的小节线：行首若是残小节，第一刀最早只能落在下一条小节线上
    const from = l.head.full ? l.fromMi : l.fromMi + 1;
    const to = l.mi !== null || l.chord === null ? l.toMi + 1 : l.toMi; // 行尾收在小节线上才算到 toMi
    for (const at of splitEvenly(from, to, pre, k)) breaks.measureBreaks.add(at);
  }
}

/**
 * 把 [from,to) 这一段**均匀**切成 k 行，返回切点（小节下标）。
 *
 * 原来是贪心：从左往右塞满就切一刀，于是 9 小节 / 容量 4 小节切成 4+4+1，
 * 末尾甩出一个只有一小节的行（22/319/374/378/390/419 那一批「中间行过短」的来源之一）。
 * 改成按「每行 总量/k」找最接近的小节边界落刀：同样是 9 小节，切成 3+3+3。
 */
function splitEvenly(from: number, to: number, pre: number[], k: number): number[] {
  const meas = to - from;
  const total = pre[to] - pre[from];
  if (meas <= 1 || k <= 1) return [];
  const n = Math.min(k, meas);
  const cuts: number[] = [];
  let prev = from;
  for (let j = 1; j < n; j++) {
    const want = pre[from] + (total * j) / n;
    // 落刀范围：至少给前面留一小节，也要给后面剩下的 n-j 行各留一小节
    let best = -1;
    for (let i = prev + 1; i <= to - (n - j); i++)
      if (best < 0 || Math.abs(pre[i] - want) < Math.abs(pre[best] - want)) best = i;
    if (best < 0) break;
    cuts.push(best);
    prev = best;
  }
  return cuts;
}

/** 一行的行首「残小节」：从行首到第一条小节线之间的那点内容。 */
export interface LineHead {
  /** 残小节的**时值**（`Chord.duration` 之和；`Chord.beats` 是增时线格数，不是时值）。
   *  整小节起头时就是该小节的全长。 */
  dur: number;
  /** 行首是不是小节起点（false = 从小节中间起头，弱起/长音收尾之后） */
  full: boolean;
  /** 残小节里有没有音符（false = 只有休止） */
  hasNote: boolean;
  /** 残小节占多少**格**（`tidyLineHeads` 判「并到上一行放不放得下」要用它，
   *  不能拿整行的格数——那会把「并两拍休止」误判成「并一整行」）。 */
  cells: number;
  /** 行首第一个和弦：是不是休止、几条符杠、几拍 */
  rest: boolean;
  beams: number;
  firstBeats: number;
  /** 行首第一个和弦的**时值**（判「行首是不是半拍休止」用） */
  firstDur: number;
  /** 行首第一个和弦的歌词标点分：**带标点的长音**是上一句的收尾，不该出现在行首（373） */
  firstPunct: number;
  /** 行首第一个和弦的主歌词（「这一行从哪个字起唱」，line-check 的定点断言要用） */
  text: string;
}

/** 一行的行末：最后一个和弦的歌词末字与其标点分（句末 6 / 句中 4 / 无 0）。 */
export interface LineTail {
  text: string;
  punct: number;
  beats: number;
  /** 行末往前**最近的那个有词的字**。行末落在延音（tie）或休止上时 `text` 是空的，
   *  可这一句唱到哪儿是明摆着的——往前找到那个字才知道「这一行收在哪里」。
   *  断句方案快照记的就是它。 */
  lastWord: string;
  /** 同上，那个字的标点分。行末落在无词的拖腔上时 `text` 是空的，光看它分不出
   *  「乐句唱完了、行末是收尾的长音」与「句子没唱完、断在了拖腔中间」
   *  ——后者会把词从中间劈开（077《耶稣我主荣耀王》的「殷｜勤」）。 */
  lastWordPunct: number;
}

/** 断点把曲子切成的一行。`mi`/`chord` 是**这一行末尾**那个断点（小节末 `mi`：在第 mi 小节后换行；
 *  行内：`chord`）；末行没有断点，两者皆 null。 */
export interface LineInfo {
  cells: number;
  /** 这一行的**时值**（Σ `Chord.duration`，即多少拍）。
   *  `beats` 是增时线格数、`cells` 是视觉宽度，都不是时长；断句方案快照记的是这个。 */
  dur: number;
  /** 这一行覆盖的小节下标区间（含端点；从小节中间起头/收尾时与相邻行共享一个小节） */
  fromMi: number;
  toMi: number;
  /** 整小节数（行内收在小节线上的次数） */
  bars: number;
  beats: number;
  head: LineHead;
  tail: LineTail;
  /** 行首的旋律指纹（`phrase.ts::headFpOf`）：两行相同 = 平行乐句开头。 */
  headFp: string;
  mi: number | null;
  chord: Chord | null;
  /** 段界（另起一页）不可合并。 */
  section: boolean;
}

/** 一个和弦占多少格（一个音符 1 格，长音的每根增时线各占 1 格）。 */
const cellsOfChord = (c: Chord): number => Math.max(1, Math.floor(c.beats) || 1);

/**
 * 按断点把 part 切成行，并把**判断版面好坏要用的事实**一并算出来
 * （行首残小节、行末歌词标点、格数、小节数）。
 *
 * `mergeShortLines` / `tidyLineHeads` / `rebuild.mjs` 的逐行报告共用这一份——
 * 各数各的就会出现「检查脚本说没问题、排出来还是难看」。
 */
export function describeLines(part: Part, breaks: PhraseBreaks, useMidBreaks: boolean): LineInfo[] {
  interface FC { chord: Chord; mi: number; k: number; isLast: boolean }
  const flat: FC[] = [];
  part.measures.forEach((m, i) => {
    const cs = chordsOf(m);
    cs.forEach((c, k) => flat.push({ chord: c, mi: i, k, isLast: k === cs.length - 1 }));
  });
  const out: LineInfo[] = [];
  let start = 0;
  const emit = (end: number, mi: number | null, chord: Chord | null, section: boolean): void => {
    const seg = flat.slice(start, end + 1);
    if (!seg.length) return;
    start = end + 1;
    // 行首残小节：从行首到第一条小节线（整行都在一个小节里时就是整行）
    const headEnd = seg.findIndex((f) => f.isLast);
    const head = seg.slice(0, headEnd < 0 ? seg.length : headEnd + 1);
    const last = seg[seg.length - 1];
    const text = mainLyricText(last.chord);
    out.push({
      cells: seg.reduce((n, f) => n + cellsOfChord(f.chord), 0),
      dur: seg.reduce((n, f) => n + (f.chord.duration?.toFloat() ?? 0), 0),
      fromMi: seg[0].mi,
      toMi: last.mi,
      bars: seg.filter((f) => f.isLast).length,
      beats: seg.reduce((n, f) => n + f.chord.beats, 0),
      head: {
        dur: head.reduce((n, f) => n + (f.chord.duration?.toFloat() ?? 0), 0),
        full: seg[0].k === 0,
        hasNote: head.some((f) => !f.chord.rest),
        cells: head.reduce((n, f) => n + cellsOfChord(f.chord), 0),
        rest: seg[0].chord.rest,
        beams: seg[0].chord.beams,
        firstBeats: seg[0].chord.beats,
        firstDur: seg[0].chord.duration?.toFloat() ?? 0,
        firstPunct: lyricPunctScore(seg[0].chord),
        text: mainLyricText(seg[0].chord),
      },
      tail: (() => {
        // 行末落在延音／休止上时 `text` 是空的，往前找到最后一个有词的字
        let lastWord = "";
        let lastWordPunct = 0;
        for (let j = seg.length - 1; j >= 0; j--) {
          const t = mainLyricText(seg[j].chord);
          if (!t) continue;
          lastWord = t;
          lastWordPunct = lyricPunctScore(seg[j].chord);
          break;
        }
        return { text, punct: lyricPunctScore(last.chord), beats: last.chord.beats, lastWord, lastWordPunct };
      })(),
      headFp: headFpOf(seg.map((f) => f.chord)),
      mi,
      chord,
      section,
    });
  };
  flat.forEach((f, idx) => {
    if (useMidBreaks && (breaks.midBreaks.has(f.chord) || breaks.sectionCutChords.has(f.chord)))
      return emit(idx, null, f.chord, breaks.sectionCutChords.has(f.chord));
    if (f.isLast && (breaks.measureBreaks.has(f.mi + 1) || breaks.sectionStarts.has(f.mi + 1)))
      emit(idx, f.mi + 1, null, breaks.sectionStarts.has(f.mi + 1));
  });
  emit(flat.length - 1, null, null, false);
  return out;
}

/**
 * **行首不留半个小节的休止**：一行从「休止 + 小节线」起头（残小节里一个音符都没有）时，
 * 把那点休止并到上一行去——下一行开头是个空拍，唱的人不知道要等谁
 * （020《向主歌唱》、193《主恩更多》第二行）。整小节的休止同理（整节挂到上一行；
 * 用户口径：完整的休止小节放上一行或下一行都行，有问题的是**半个小节**的休止）。
 *
 * 这是**兜底**：断句本身在 phrase.ts 的 DP 里就按同一条判据罚过了，但
 * `enforceLineCapacity` / `mergeShortLines` 会在 DP 之后造出新的行首，那些 DP 管不到。
 *
 * @param cells 一行放得下几格；并到上一行放不下就维持原判（0 = 不验容量）
 */
export function tidyLineHeads(part: Part, breaks: PhraseBreaks, opt: { useMidBreaks?: boolean; cells?: number } = {}): number {
  const useMidBreaks = opt.useMidBreaks ?? true;
  const cells = opt.cells ?? 0;
  const lines = describeLines(part, breaks, useMidBreaks);
  let moved = 0;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (cur.head.hasNote) continue;
    if (prev.section) continue;          // 段界（另起一页）不能挪
    if (cur.fromMi === cur.toMi && cur.bars === 0) continue; // 整行都在一个小节里：没有小节线可挪到
    // 并过去的**只是行首那个残小节**，不是整行——原来这里拿的是 `cur.cells`（整行格数），
    // 于是「并两拍休止」被算成「并一整行」，放不下就不并了
    //（282《我的灯需要油》第 3 行：上一行 32 格 + 本行 22 格 = 54 > 容量 33，
    //   实际要并过去的只有 2 格）。
    const headCells = Math.max(1, cur.head.cells);
    if (cells > 0 && prev.cells + headCells > cells) continue;
    if (prev.mi !== null) breaks.measureBreaks.delete(prev.mi);
    if (prev.chord) breaks.midBreaks.delete(prev.chord);
    breaks.measureBreaks.add(cur.fromMi + 1);
    moved++;
  }
  return moved;
}

/**
 * **每两句并一行**（B 档，见 `chooseLineLayout`）。
 *
 * 乐句分析给的是「一句一行」，而原书绝大多数是**一行两句**：005《荣耀归与天父》每小节才
 * 3.2 格，4 小节只有 13 格，版心却放得下 27 格——一句一行每行只用半幅版心，还要被 justify
 * 拉开，看着空。反过来 001《圣哉，圣哉，圣哉》一句 16 格、两句 32 格 > 容量 31，两句一行
 * 就放不下，那首本来也确实是一句一行。
 *
 * 与旧的 `mergeShortLines` 的差别：那个是**逐对局部判**（两行都短于容量六成才并），
 * 同一首里于是有的地方并了、有的地方没并，行长反而更不齐。这里改成**全首一个口径**：
 * 段内从头起两两并，段界处重新起对，段内落单的末行留着。放不放得下由调用方统一验。
 *
 * 只删断点、不新造断点。但**并出来的行末必须仍是乐句边界**——删掉 a 的断点等于让
 * a+b 合成一行，那一行的行末就是 b 的行末，b 收在哪儿决定了并出来好不好看。
 * 096《哈利路亚！感谢主》的「哈利路亚」唱好几遍，某个断点正落在「哈利｜路亚」中间，
 * 一并行就把「哈利」留在了行末。判据是**行末收在标点上、或收在长音上**——
 * 长音收尾（一字多音唱完、行末那个音没有词）同样是乐句的落点，只认标点会把它们也挡掉。
 *
 * @returns 并掉的断点数
 */
export function mergePairsUniform(part: Part, breaks: PhraseBreaks, useMidBreaks: boolean): number {
  const lines = describeLines(part, breaks, useMidBreaks);
  // **先看能不能全首一致地并**：一半并一半不并，行长反而更不齐——020《向主歌唱》
  // 前四行各 4~5 小节没并、末两行并成 8 小节，那一行就明显比谁都长。
  // 并不齐就整档放弃（`chooseLineLayout` 会退到一句一行）。
  const canPairAt = (i: number): boolean => {
    const a = lines[i];
    const b = lines[i + 1];
    if (!b) return false;
    if (a.section) return false;
    if (a.mi !== null && breaks.forced?.has(a.mi)) return false;
    if (a.mi === null && a.chord === null) return false;
    // b 是并出来那一行的行末：它没收在乐句落点上就别并（末行除外，末行本来就是曲末）
    const bIsLast = i + 1 === lines.length - 1;
    return bIsLast || b.tail.punct > 0 || b.tail.beats >= 2;
  };
  for (let i = 0; i + 1 < lines.length; i += 2) if (!canPairAt(i)) return 0;
  let merged = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const a = lines[i];
    if (a.mi !== null) breaks.measureBreaks.delete(a.mi);
    if (a.chord) breaks.midBreaks.delete(a.chord);
    merged++;
  }
  return merged;
}

/** 一行放不放得下、是不是碎行——`chooseLineLayout` 判「这一档可不可行」的两条。 */
function linesAreOk(lines: LineInfo[], cells: number): boolean {
  for (let i = 0; i < lines.length; i++) {
    if (cells > 0 && lines[i].cells > cells) return false;
    // 中间行只剩一小节（且不足四拍/八拍）= 碎行。末行本来就可以短。
    if (i < lines.length - 1 && !lines[i].section) {
      const l = lines[i];
      if (l.bars <= 1 && l.beats < (l.head.full ? 4 : 8)) return false;
    }
  }
  return true;
}

/** `PhraseBreaks` 的浅拷贝（Chord 引用共享，只复制四个 Set）。 */
function cloneBreaks(b: PhraseBreaks): PhraseBreaks {
  return {
    measureBreaks: new Set(b.measureBreaks),
    midBreaks: new Set(b.midBreaks),
    sectionStarts: new Set(b.sectionStarts),
    sectionCutChords: new Set(b.sectionCutChords),
    refrainCut: b.refrainCut,
    forced: new Set(b.forced),
  };
}

/** 在第 mi 小节**之前**断行会不会切断一条圆滑线／连音线／反复房。 */
function cutsThroughSpan(part: Part, mi: number): boolean {
  const ms = part.measures;
  if (mi <= 0 || mi >= ms.length) return false;
  // 反复房：房整体不可拆，只有房的收尾处才能断
  let inEnding = false;
  for (let i = 0; i < mi; i++) {
    if (ms[i].endingLeft) inEnding = true;
    if (ms[i].endingRight !== null) inEnding = false;
  }
  if (inEnding) return true;
  // 弧线：上一小节最后一个和弦起了弧／连音线，而本小节头一个和弦收它
  const prev = chordsOf(ms[mi - 1]);
  const cur = chordsOf(ms[mi]);
  const a = prev[prev.length - 1];
  const b = cur[0];
  if (!a || !b) return false;
  if (a.slurStart && b.slurEnd) return true;
  if (a.notes[0]?.tieStart && b.notes[0]?.tieEnd) return true;
  return false;
}

/**
 * **均匀排版**（C 档）：乐句断点排出来的行放不下版心时的兜底。
 *
 * **不丢开乐句断点**——试过完全按容量机械均分（169《全新的你》排出 13 行、215 甩出一行
 * 只有 9 格），比原样还难看。做法是在乐句断点的基础上收拾两件事：
 *   1. 放不下的行按容量**均分**补刀（`splitEvenly`，与 `enforceLineCapacity` 同一份），
 *      落刀点若会切断圆滑线／反复房就往后挪一节——用户口径「尽量避免 slur/ending 等跨行」；
 *   2. 补出来的**碎行**（只剩一小节）并回上一行。
 * 段界（主歌↔副歌）自始至终保留——「尽量主歌副歌不同行」。
 */
function evenLayout(part: Part, breaks: PhraseBreaks, cells: number): PhraseBreaks {
  const out = cloneBreaks(breaks);
  const ms = part.measures;
  if (cells <= 0 || !ms.length) return out;
  const pre = [0];
  for (const m of ms) pre.push(pre[pre.length - 1] + measureCells(m));
  for (const l of describeLines(part, out, true)) {
    if (l.cells <= cells) continue;
    const k = Math.ceil(l.cells / cells);
    const from = l.head.full ? l.fromMi : l.fromMi + 1;
    const to = l.mi !== null || l.chord === null ? l.toMi + 1 : l.toMi;
    for (const at of splitEvenly(from, to, pre, k)) {
      let mi = at;
      while (mi < to && cutsThroughSpan(part, mi)) mi++;
      if (mi < to) out.measureBreaks.add(mi);
    }
  }
  mergeSliverLines(part, out, true, cells);
  return out;
}

/**
 * **碎行并回上一行**：只剩一小节、又唱不满一句的行（497《这世界非我家》曾切出一行 2 格）。
 *
 * 碎行是**按容量补刀**留下的（`enforceLineCapacity` / `evenLayout` 都按格数均分，
 * 遇上格数分布不均的段就会切出个尾巴），断句本身不会这么断。所以这是一道**收尾**：
 * 排版模式定下来、容量保险也补完刀之后再跑一次。
 *
 * 段界与跳转记号处的断点（`PhraseBreaks.forced`）不动。并过去放不下就维持原判——
 * 宁可留个短行，也别撑爆版心。
 *
 * @param cells 一行放得下几格（0 = 不验容量）
 * @returns 并掉的断点数
 */
export function mergeSliverLines(part: Part, breaks: PhraseBreaks, useMidBreaks: boolean, cells = 0): number {
  const lines = describeLines(part, breaks, useMidBreaks);
  let merged = 0;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (prev.section) continue;
    if (cur.bars > 1 || cur.beats >= (cur.head.full ? 4 : 8)) continue;
    if (prev.mi !== null && breaks.forced.has(prev.mi)) continue;
    if (cells > 0 && prev.cells + cur.cells > cells) continue;
    if (prev.mi !== null) breaks.measureBreaks.delete(prev.mi);
    else if (prev.chord) breaks.midBreaks.delete(prev.chord);
    else continue;
    merged++;
  }
  return merged;
}

/**
 * **整首的排版模式阶梯**（成书那条路）。
 *
 * 「排不排得下」只在这里用——断句本身只看内容（见 `phrase.ts::PhraseOptions.contentOnly`）。
 * 按 **B → A → C** 取第一个可行的（原书绝大多数是一行两句，所以两句一行是首选；
 * 一句一行是它放不下时的退让；均匀排版是乐句根本排不下时的兜底）：
 *
 *   B  每 2 句一行（`mergePairsUniform`）
 *   A  按乐句排版（断点原样用）
 *   C  均匀排版（`evenLayout`）
 *
 * 「可行」= 每行都放得下，且中间没有只剩一小节的碎行。
 * 选中的那一档**写回 `breaks`**（原地改，调用方拿到的就是最终断点）。
 *
 * @param cells 一行放得下几格（`browser.ts::measureCellsPerLine` 实测）
 * @returns 选中的档
 */
export function chooseLineLayout(
  part: Part,
  breaks: PhraseBreaks,
  cells: number,
  opt: { useMidBreaks?: boolean; allowPairs?: boolean } = {},
): "pairs" | "phrase" | "even" {
  const useMidBreaks = opt.useMidBreaks ?? true;
  const allowPairs = opt.allowPairs ?? true;
  const write = (from: PhraseBreaks): void => {
    breaks.measureBreaks.clear();
    for (const v of from.measureBreaks) breaks.measureBreaks.add(v);
    breaks.midBreaks.clear();
    for (const v of from.midBreaks) breaks.midBreaks.add(v);
  };
  const phrase = cloneBreaks(breaks);
  const phraseLines = describeLines(part, phrase, useMidBreaks);
  // **只在一句一行明显太稀时才考虑两句一行**。用户口径：「排不排得下只用于……是否采用
  // 每 2 句放在一行的按乐句排版」。不设这道闸的话，凡是并得下的都会去并——实测全书
  // 184 首改走 pairs、行数直接减半，那不是「原书一行两句」，那是把谱压扁。
  // 判据取中位行长：多数行还不到版心六成，才说明一句一行确实空。
  const medCells = (() => {
    const cs = phraseLines.map((l) => l.cells).sort((x, y) => x - y);
    return cs.length ? cs[Math.floor(cs.length / 2)] : 0;
  })();
  const sparse = cells > 0 && medCells > 0 && medCells < cells * 0.6;
  if (allowPairs && sparse) {
    const pairs = cloneBreaks(breaks);
    // 返回 0 = 并不成（不能全首一致地并），那就不是 pairs 档——原来这里不看返回值，
    // 于是「没并」也被标成 pairs，行数一行没少（全书 40 首都这样）。
    const merged = mergePairsUniform(part, pairs, useMidBreaks);
    if (merged > 0 && linesAreOk(describeLines(part, pairs, useMidBreaks), cells)) {
      write(pairs);
      return "pairs";
    }
  }
  if (linesAreOk(phraseLines, cells)) return "phrase";
  write(evenLayout(part, phrase, cells));
  return "even";
}
