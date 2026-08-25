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
import { mainLyricText, punctScore, type PhraseBreaks } from "./phrase";

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
  // 小节数也设一道闸：格数是近似（增时线在乐句分析里按 0.7 折算，排版器却是整格），
  // 光看格数会漏掉「九小节一行」这种——006 的主歌就是这样，排版器随后硬折，
  // 甩出一行只剩 "3 2 1--"。
  const hardMeas = Math.max(targetMeas + 1, Math.ceil(targetMeas * 1.5));
  const pre = [0];
  for (const m of ms) pre.push(pre[pre.length - 1] + measureCells(m));
  for (let b = 0; b + 1 < bounds.length; b++) {
    const from = bounds[b];
    const to = bounds[b + 1];
    for (const at of splitEvenly(from, to, pre, cells, hardMeas)) breaks.measureBreaks.add(at);
  }
}

/**
 * 把 [from,to) 这一段**均匀**切成够短的几行，返回切点（小节下标）。
 *
 * 原来是贪心：从左往右塞满就切一刀，于是 9 小节 / 容量 4 小节切成 4+4+1，
 * 末尾甩出一个只有一小节的行（22/319/374/378/390/419 那一批「中间行过短」的来源之一）。
 * 改成先算这一段**至少要几行**，再按「每行 总量/k」找最接近的小节边界落刀：同样是 9 小节，
 * 切成 3+3+3。切完仍有超容量的行就加一行重来（段里的小节长短不一时会遇上）。
 */
function splitEvenly(from: number, to: number, pre: number[], cells: number, hardMeas: number): number[] {
  const meas = to - from;
  const total = pre[to] - pre[from];
  if (meas <= 1) return [];
  let k = Math.max(Math.ceil(total / cells), Math.ceil(meas / hardMeas));
  if (k <= 1) return []; // 放得下就别动——这一步只是兜底，不是分行的主力
  for (; k <= meas; k++) {
    const cuts: number[] = [];
    let prev = from;
    let ok = true;
    for (let j = 1; j < k && ok; j++) {
      const want = pre[from] + (total * j) / k;
      // 落刀范围：至少给前面留一小节，也要给后面剩下的 k-j 行各留一小节
      let best = -1;
      for (let i = prev + 1; i <= to - (k - j); i++)
        if (best < 0 || Math.abs(pre[i] - want) < Math.abs(pre[best] - want)) best = i;
      if (best < 0) ok = false;
      else { cuts.push(best); prev = best; }
    }
    if (!ok) continue;
    const edges = [from, ...cuts, to];
    const bad = edges.some((e, i) => i + 1 < edges.length &&
      (pre[edges[i + 1]] - pre[e] > cells || edges[i + 1] - e > hardMeas));
    if (!bad) return cuts;
    if (k === meas) return cuts; // 每行一小节都还超容量：格数量偏了，交给排版器折
  }
  return [];
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
  /** 行首第一个和弦：是不是休止、几条符杠、几拍 */
  rest: boolean;
  beams: number;
  firstBeats: number;
  /** 行首第一个和弦的**时值**（判「行首是不是半拍休止」用） */
  firstDur: number;
  /** 行首第一个和弦的歌词标点分：**带标点的长音**是上一句的收尾，不该出现在行首（373） */
  firstPunct: number;
}

/** 一行的行末：最后一个和弦的歌词末字与其标点分（句末 6 / 句中 4 / 无 0）。 */
export interface LineTail {
  text: string;
  punct: number;
  beats: number;
}

/** 断点把曲子切成的一行。`mi`/`chord` 是**这一行末尾**那个断点（小节末 `mi`：在第 mi 小节后换行；
 *  行内：`chord`）；末行没有断点，两者皆 null。 */
export interface LineInfo {
  cells: number;
  /** 这一行覆盖的小节下标区间（含端点；从小节中间起头/收尾时与相邻行共享一个小节） */
  fromMi: number;
  toMi: number;
  /** 整小节数（行内收在小节线上的次数） */
  bars: number;
  beats: number;
  head: LineHead;
  tail: LineTail;
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
      fromMi: seg[0].mi,
      toMi: last.mi,
      bars: seg.filter((f) => f.isLast).length,
      beats: seg.reduce((n, f) => n + f.chord.beats, 0),
      head: {
        dur: head.reduce((n, f) => n + (f.chord.duration?.toFloat() ?? 0), 0),
        full: seg[0].k === 0,
        hasNote: head.some((f) => !f.chord.rest),
        rest: seg[0].chord.rest,
        beams: seg[0].chord.beams,
        firstBeats: seg[0].chord.beats,
        firstDur: seg[0].chord.duration?.toFloat() ?? 0,
        firstPunct: punctScore(mainLyricText(seg[0].chord)),
      },
      tail: { text, punct: punctScore(text), beats: last.chord.beats },
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
    // 并过去的是行首那个残小节，格数按整格算（与容量口径一致）
    const headCells = Math.max(1, cur.cells);
    if (cells > 0 && prev.cells + headCells > cells) continue;
    if (prev.mi !== null) breaks.measureBreaks.delete(prev.mi);
    if (prev.chord) breaks.midBreaks.delete(prev.chord);
    breaks.measureBreaks.add(cur.fromMi + 1);
    moved++;
  }
  return moved;
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
 *        （007《荣耀归与我主》量出 32 格，30 格的行就被排版器折了），并到贴着容量上限最容易溢出。
 *        **成书那条路现在不用它**（一律 0）：二次折行改成按「实测最长行」收紧格数，
 *        比留余量准；留了余量反而会挡住本该并的两行（022 收紧后的 8+7 格）。
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
  const lines = describeLines(part, breaks, useMidBreaks);
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
