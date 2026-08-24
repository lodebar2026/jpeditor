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
 */
export function enforceLineCapacity(part: Part, breaks: PhraseBreaks, cells: number, targetMeas = 4): void {
  const ms = part.measures;
  if (!ms.length || cells <= 0) return;
  const cut = [...breaks.measureBreaks].sort((a, b) => a - b);
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
