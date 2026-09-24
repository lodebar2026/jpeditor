// **断行的读写对**：模型里的换行 ↔ 「新行从哪个元素起」。
//
// 断行是「这份谱怎么印」的事实（见 `docs/待办.md` §3「原则」），随文档保存、往返。模型里分两处记：
// 小节级的在 `Measure.print.newSystem/newPage`（本小节**起**新系统，口径见 `helpers.ts::breaksAfterToStart`），
// 小节中间的在前一个和弦（或它的增时线）的 `lineBreakAfter` 上。排版引擎与断句交出来的都是
// 「行首元素」——这里负责两种说法互换：
//
// - `breaksOf`：读出模型里现有的断行（回归比对用：写出 → 读回，断点集合应不变）；
// - `applyBreaks`：把一组行首写进模型，**替换**原有断行。用它的有三处：乐句重排写回 123/ABC
//   （`relayout.ts::relayoutDocBreaks`，`snap`）、导出 MusicXML 时照简谱视图重断（`xmlproject.ts`，
//   `source` / `inline`）、跨格式另存为带上简谱视图的断行（`App.convertTo`，`source`）。
//
// 小节中间的行首怎么落由 `mid` 定：原位记（`inline`）、挪到下一根小节线（`snap`，123 乐句重排：
// `$` 写在代码行中间读回时歌词块会跟着断）、只留源文本来就写明的（`source`，简谱一行排不下自己在
// 小节中间折的只是版面宽度的产物，顺延到下一小节）。多声部各声部的切点对不齐，小节中间的一律顺延。

import type { Chord, Element, ElementId, Measure, Song, Sustain } from "./doc";
import { inlineBreakOf } from "./emitutil";
import type { BreakKind } from "./helpers";

/** 新的一行从这个元素（和弦或增时线）起。`page`：这一行起新页。 */
export interface LineStart {
  id: ElementId;
  page?: boolean;
}

export interface ApplyBreaksOptions {
  /** 小节中间的行首：`inline` 原位记 `lineBreakAfter`；`snap` 挪到下一根小节线；
   *  `source` 只留源文本来就在那里换行的（原位），其余挪到下一根小节线。 */
  mid: "inline" | "snap" | "source";
  /** `write`：清掉原有换页，按 `LineStart.page` 重写；`keep`：原有换页不动（行首集合里没有换页信息时）。 */
  pages: "write" | "keep";
}

/** 模型里一个元素的位置。`sustain` 是它在宿主和弦 `sustains` 里的下标（元素自己时为 null）。 */
interface Spot {
  part: number;
  measure: number;
  index: number;
  sustain: number | null;
}

/** 整首的「元素 id → 位置」。倚音也在里面（落点算小节起头时要把它们跳过）。 */
function spotsOf(song: Song): Map<ElementId, Spot> {
  const out = new Map<ElementId, Spot>();
  song.parts.forEach((part, pi) => {
    part.measures.forEach((mea, mi) => {
      mea.elements.forEach((el, ei) => {
        out.set(el.id, { part: pi, measure: mi, index: ei, sustain: null });
        if (el.kind !== "chord") return;
        (el.sustains ?? []).forEach((su, si) => {
          out.set(su.id, { part: pi, measure: mi, index: ei, sustain: si });
        });
      });
    });
  });
  return out;
}

const isGrace = (el: Element | undefined): boolean => el?.kind === "chord" && !!el.grace;

/** 第 `ei` 个元素前面紧挨着的倚音跟着它走：往前退到倚音串的头。 */
function graceHead(mea: Measure, ei: number): number {
  let j = ei;
  while (j > 0 && isGrace(mea.elements[j - 1])) j--;
  return j;
}

/** 第 `ei` 个元素之前没有正经的和弦（只有倚音或非和弦元素）= 这个落点就是小节起头。 */
function atMeasureStart(mea: Measure, ei: number): boolean {
  for (let i = 0; i < ei; i++) {
    const el = mea.elements[i]!;
    if (el.kind === "chord" && !el.grace) return false;
  }
  return true;
}

/** 落点**之前**那一个挂得住换行的东西（上一个和弦的最后一根增时线，没有增时线就是和弦自己），
 *  以及源文在那里原本记的换行。挂不住（前面是 `Space` 之类）返回 null。 */
function hostBefore(mea: Measure, spot: Spot): { host: Chord | Sustain; was: BreakKind | null } | null {
  // 落点在某根增时线上：换行落在它前一根上（第一根则落在宿主音符之后）
  if (spot.sustain !== null) {
    const chord = mea.elements[spot.index];
    if (chord?.kind !== "chord") return null;
    const host = spot.sustain > 0 ? (chord.sustains?.[spot.sustain - 1] ?? chord) : chord;
    return { host, was: host.lineBreakAfter ?? null };
  }
  const prev = mea.elements[graceHead(mea, spot.index) - 1];
  if (prev?.kind !== "chord") return null;
  const sustains = prev.sustains ?? [];
  return { host: sustains[sustains.length - 1] ?? prev, was: inlineBreakOf(prev) };
}

/** 清掉整首现有的换行（`pages: keep` 时换页留着）。 */
function clearBreaks(song: Song, pages: ApplyBreaksOptions["pages"]): void {
  for (const part of song.parts) {
    for (const mea of part.measures) {
      if (mea.print) {
        delete mea.print.newSystem;
        delete mea.print.system; // 文本谱的组序号跟着旧行结构作废（单声部才走到这里，见 applyBreaks）
        if (pages === "write") delete mea.print.newPage;
        if (Object.keys(mea.print).length === 0) delete mea.print;
      }
      for (const el of mea.elements) {
        if (el.kind !== "chord") continue; // `Space`（`y`/`x`）没有换行位
        delete el.lineBreakAfter;
        for (const su of el.sustains ?? []) delete su.lineBreakAfter;
      }
      for (const b of mea.barlines ?? []) delete b.lineBreakAfter;
    }
  }
}

/**
 * 把一组行首写进模型的换行位，**替换**原有的断行。改的是传进来的这首。
 *
 * 行首都该在同一个声部里（排版与断句都只看旋律那一路）：取第一个认得出行首的声部，其余声部的忽略；
 * 小节级换行各声部在同一小节上断。多声部的文本谱（带组序号 `print.system`）各声部小节对不齐，不重断。
 *
 * @returns 有没有落下任何换行。一个行首都对不上（id 过期）时不改模型、返回 false
 */
export function applyBreaks(song: Song, starts: Iterable<LineStart>, opt: ApplyBreaksOptions): boolean {
  // 多声部的文本谱：一组不一定含全部声部，各声部的小节号对不齐（靠 `print.system` 对回同一组），
  // 按小节号给各声部同时断会断错组——不重断，留源文的行
  if (song.parts.length > 1 && song.parts.some((p) => p.measures.some((m) => m.print?.system !== undefined))) return false;
  const where = spotsOf(song);
  const byPart = new Map<number, Array<{ spot: Spot; page: boolean }>>();
  for (const s of starts) {
    const spot = where.get(s.id);
    if (!spot) continue;
    const list = byPart.get(spot.part) ?? [];
    list.push({ spot, page: !!s.page });
    byPart.set(spot.part, list);
  }
  const pi = Math.min(...byPart.keys());
  const hits = byPart.get(pi);
  if (!hits) return false;
  hits.sort((a, b) => a.spot.measure - b.spot.measure || a.spot.index - b.spot.index || (a.spot.sustain ?? -1) - (b.spot.sustain ?? -1));

  // 先定落点（`source` 要读源文原有的换行，所以在清掉之前）
  const measureStarts = new Map<number, boolean>(); // 小节 → 是否换页
  const inline: Array<{ host: Chord | Sustain; kind: BreakKind; mi: number }> = [];
  const single = song.parts.length === 1;
  for (const { spot, page } of hits) {
    const mea = song.parts[pi]!.measures[spot.measure]!;
    let mi = spot.measure;
    if (spot.sustain !== null || !atMeasureStart(mea, spot.index)) {
      const h = opt.mid === "snap" || !single ? null : hostBefore(mea, spot);
      const kind = !h ? null
        : opt.mid === "source" ? h.was
        : opt.pages === "write" ? (page ? "page" : "system")
        : (h.was ?? "system");
      if (h && kind) {
        inline.push({ host: h.host, kind, mi: spot.measure });
        continue;
      }
      mi = spot.measure + 1; // 挪到下一根小节线
    }
    if (mi <= 0 || mi >= song.parts[pi]!.measures.length) continue;
    measureStarts.set(mi, (measureStarts.get(mi) ?? false) || page);
  }
  if (measureStarts.size === 0 && inline.length === 0) return false;
  // 小节中间换行在下一小节上另记一份小节级的（见下），那里再有一个行首就是同一处，并掉：
  // 只剩半个小节的一行模型写不出来（解析器读 `a $ b | $ c` 也只留一处）
  for (const { mi } of inline) measureStarts.delete(mi + 1);

  clearBreaks(song, opt.pages);
  for (const part of song.parts) {
    for (const [mi, page] of measureStarts) {
      const target = part.measures[mi];
      if (!target) continue;
      target.print = { ...target.print, newSystem: true };
      if (page && opt.pages === "write") target.print.newPage = true;
    }
  }
  if (opt.pages === "write") {
    for (const { host, kind } of inline) host.lineBreakAfter = kind;
  } else {
    // 换页留着原样时：小节中间的换页在下一小节上另记了一份小节级的（`.jpwabc`），这一页其实从本小节中间
    // 这一刀起——归到这一刀上（同一小节里只认最后那刀）。
    const paged = new Set<number>();
    for (let k = inline.length - 1; k >= 0; k--) {
      const { host, mi } = inline[k]!;
      let kind = inline[k]!.kind;
      const nextPage = song.parts[0]?.measures[mi + 1]?.print?.newPage === true;
      if (!paged.has(mi) && (kind === "page" || nextPage)) kind = "page";
      else if (kind === "page") kind = "system";
      host.lineBreakAfter = kind;
      if (kind !== "page") continue;
      paged.add(mi);
      for (const part of song.parts) {
        const pr = part.measures[mi + 1]?.print;
        if (!pr) continue;
        delete pr.newPage;
        if (Object.keys(pr).length === 0) delete part.measures[mi + 1]!.print;
      }
    }
  }
  // 模型的约定（`doc.ts::Chord.lineBreakAfter`，各解析器都这样记）：小节中间的换行在下一小节上照
  // 「这一小节之后」另记一份小节级的，只认小节级换行的消费者（排版行视图等）才看得到它；种类取本小节最后那刀
  const last = new Map<number, BreakKind>();
  for (const { mi, host } of inline) last.set(mi, host.lineBreakAfter!);
  for (const part of song.parts) {
    for (const [mi, kind] of last) {
      const next = part.measures[mi + 1];
      if (!next) continue;
      next.print = { ...next.print, newSystem: true };
      if (kind === "page") next.print.newPage = true;
    }
  }
  return true;
}

/** 第 `ei` 个元素起（含）往后第一个正经和弦的 id；倚音跳过（它们跟着主音走）。 */
function mainChordFrom(mea: Measure, ei: number): ElementId | null {
  for (let i = ei; i < mea.elements.length; i++) {
    const el = mea.elements[i]!;
    if (el.kind === "chord" && !el.grace) return el.id;
  }
  return null;
}

/**
 * 读出一首现有的断行：第一声部上的行首元素，按谱序。小节级的取该小节第一个和弦（倚音跳过），
 * 小节中间的取换行之后紧跟的那个元素（增时线之后的取下一根增时线或下一个和弦）；
 * 它在下一小节上另记的那份小节级的不另算。
 * 全曲末尾之后的换行（`Part.endBreak`）没有行首，不算。
 */
export function breaksOf(song: Song): LineStart[] {
  const out: LineStart[] = [];
  const part = song.parts[0];
  if (!part) return out;
  const seen = new Set<ElementId>();
  const add = (id: ElementId | null, page: boolean): void => {
    if (id === null || seen.has(id)) return;
    seen.add(id);
    out.push(page ? { id, page } : { id });
  };
  let inlineBefore = false; // 上一小节有小节中间的换行：本小节的小节级换行是它另记的那一份
  part.measures.forEach((mea, mi) => {
    if (mi > 0 && !inlineBefore && (mea.print?.newSystem || mea.print?.newPage)) add(firstChordFrom(mi), !!mea.print.newPage);
    inlineBefore = mea.elements.some((el) => inlineBreakOf(el) !== null);
    mea.elements.forEach((el, ei) => {
      if (el.kind !== "chord") return;
      const sus = el.sustains ?? [];
      // 和弦自己带的：换在它（连同增时线）之后；增时线上的：换在那根之后
      if (el.lineBreakAfter) add(nextAfter(ei, sus.length), el.lineBreakAfter === "page");
      sus.forEach((su, si) => {
        if (su.lineBreakAfter) add(nextAfter(ei, si + 1), su.lineBreakAfter === "page");
      });
    });
    /** 第 `from` 小节起第一个正经和弦（行首是空小节时往后找，诗歌本 `|/` 起头的行读进来就是这样） */
    function firstChordFrom(from: number): ElementId | null {
      for (let i = from; i < part!.measures.length; i++) {
        const id = mainChordFrom(part!.measures[i]!, 0);
        if (id !== null) return id;
      }
      return null;
    }
    /** 第 `ei` 个和弦的第 `si` 根增时线（`si` 超出就是下一个元素起）。落在小节末就是下一小节的行首。 */
    function nextAfter(ei: number, si: number): ElementId | null {
      const el = mea.elements[ei];
      const sus = el?.kind === "chord" ? (el.sustains ?? []) : [];
      if (si < sus.length) return sus[si]!.id;
      return mainChordFrom(mea, ei + 1) ?? firstChordFrom(mi + 1);
    }
  });
  return out;
}
