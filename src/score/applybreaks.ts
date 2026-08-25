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
import type { PhraseBreaks } from "./phrase";

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
  // 行边界 = 小节末断点 ∪ **行内断点所在的小节**。行内断点也把行切开了，漏算它们就会在
  // 已经够短的行上再补一刀：弱起谱（005《荣耀归与天父》每句都收在小节中间的长音上）
  // 一条小节末断点都没有，只算 measureBreaks 等于把整曲看成一行，机械地每 6 小节切一次。
  // 行内断点落在小节中间，这里按「该小节归上一行」近似——容量保险本来就只是个兜底。
  const midMi = new Set<number>();
  if (useMidBreaks) {
    for (let i = 0; i < ms.length; i++)
      for (const c of chordsOf(ms[i]))
        if (breaks.midBreaks.has(c) || breaks.sectionCutChords.has(c)) midMi.add(i + 1);
  }
  const cut = [...new Set([...breaks.measureBreaks, ...midMi])].sort((a, b) => a - b);
  const bounds = [0, ...cut.filter((i) => i > 0 && i < ms.length), ms.length];
  for (let b = 0; b + 1 < bounds.length; b++) {
    let from = bounds[b];
    const to = bounds[b + 1];
    while (true) {
      let used = 0;
      let at = -1;
      // 小节数也设一道闸：格数是近似（增时线在乐句分析里按 0.7 折算，排版器却是整格），
      // 光看格数会漏掉「九小节一行」这种——006 的主歌就是这样，排版器随后硬折，
      // 甩出一行只剩 "3 2 1--"。
      const hardMeas = Math.max(targetMeas + 1, Math.ceil(targetMeas * 1.5));
      for (let i = from; i < to; i++) {
        const c = measureCells(ms[i]);
        const meas = i - from + 1;
        // 已经装了东西又要溢出（或已经太多小节），就在这一小节**之前**断
        if (used > 0 && (used + c > cells || meas > hardMeas)) {
          at = i;
          break;
        }
        used += c;
      }
      if (at <= from || at >= to) break;
      breaks.measureBreaks.add(at);
      from = at;
    }
  }
}

/** 断点把曲子切成的一行：格数 + 这一行末尾那个断点（小节末 `mi`：在第 mi 小节后换行；行内：`chord`）。 */
interface BreakLine {
  cells: number;
  mi: number | null;
  chord: Chord | null;
  /** 段界（另起一页）不可合并。 */
  section: boolean;
}

/** 按断点把 part 切成行（与 applyPhraseBreaks 的遍历顺序一致）。末行没有断点，`mi`/`chord` 皆 null。 */
function breakLines(part: Part, breaks: PhraseBreaks, useMidBreaks: boolean): BreakLine[] {
  const cellsOf = (c: Chord): number => Math.max(1, Math.floor(c.beats) || 1);
  const out: BreakLine[] = [];
  let cur = 0;
  part.measures.forEach((m, i) => {
    for (const c of chordsOf(m)) {
      cur += cellsOf(c);
      if (!useMidBreaks) continue;
      if (breaks.midBreaks.has(c) || breaks.sectionCutChords.has(c)) {
        out.push({ cells: cur, mi: null, chord: c, section: breaks.sectionCutChords.has(c) });
        cur = 0;
      }
    }
    if (breaks.measureBreaks.has(i + 1) || breaks.sectionStarts.has(i + 1)) {
      out.push({ cells: cur, mi: i + 1, chord: null, section: breaks.sectionStarts.has(i + 1) });
      cur = 0;
    }
  });
  if (cur > 0) out.push({ cells: cur, mi: null, chord: null, section: false });
  return out;
}

/**
 * **两两并短行**：相邻两行都远短于版心容量、且并起来仍放得下时，删掉中间那个断点。
 *
 * 乐句分析的行长目标是「小节数」（`targetMeas`，默认 4），但每小节几格随拍号而变——
 * 005《荣耀归与天父》每小节才 3.2 格，4 小节只有 13 格，而版心放得下 27 格：一句一行，
 * 每行只用了半幅版心，还要被 justify 拉开，看着空。原书这首就是**一行两句**。
 * 反过来 001《圣哉，圣哉，圣哉》一句 16 格、两句 32 格 > 容量 31，就并不动，仍是一句一行。
 *
 * 只删断点、不新造断点：行末原本收在标点/长音上，并完之后**行末仍是标点**（保留后一个断点），
 * 所以「行末收在标点上」的比例不会因此下降。段界（另起一页）与末行不参与。
 * 只并一轮、成对推进——连锁并下去会把三四句挤成一行，那就走到另一个极端了。
 *
 * @param cells 一行放得下几格（`browser.ts::measureCellsPerLine` 实测）
 * @param shortRatio 「短行」的判据：行格数 < 容量 × 该比例。默认 0.6
 * @param slack 并出来的行要留几格余量。「格」是近似——同样的格数，歌词字多的行更宽
 *        （007《荣耀归与我主》量出 32 格，30 格的行就被排版器折了），
 *        并到贴着容量上限最容易溢出。调用方发现二次折行时先加这个，再考虑整首收紧格数。
 * @returns 并掉的断点数
 */
export function mergeShortLines(
  part: Part,
  breaks: PhraseBreaks,
  cells: number,
  opt: { useMidBreaks?: boolean; shortRatio?: number; slack?: number } = {},
): number {
  const useMidBreaks = opt.useMidBreaks ?? true;
  const shortRatio = opt.shortRatio ?? 0.6;
  const slack = opt.slack ?? 0;
  if (cells <= 0) return 0;
  const lines = breakLines(part, breaks, useMidBreaks);
  const short = cells * shortRatio;
  let merged = 0;
  for (let i = 0; i + 1 < lines.length; ) {
    const a = lines[i], b = lines[i + 1];
    // a 的断点是要删的那个：段界不能删；末行（chord/mi 皆 null）也不该并进来——
    // 它没有断点可删，且末行本来就允许短。
    const canDrop = !a.section && (a.mi !== null || a.chord !== null);
    if (canDrop && a.cells < short && b.cells < short && a.cells + b.cells <= cells - slack) {
      if (a.mi !== null) breaks.measureBreaks.delete(a.mi);
      if (a.chord) breaks.midBreaks.delete(a.chord);
      merged++;
      i += 2; // 成对推进：并完这一对就跳过，不再拿并出来的长行去并第三句
    } else {
      i++;
    }
  }
  return merged;
}
