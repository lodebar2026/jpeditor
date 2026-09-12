// 文本谱的「按乐句重排」——**把断点换算到文本谱自己的行上**。
//
// 断句本身不在这里：它是格式无关的（`score/phrase.ts::computePhraseBreaks` 只吃 Score），
// `.jpwabc` 与文本谱共用同一套权重、同一套分页口径（`applybreaks.ts::pageBreakLines`）。
// 这里只做两件 `.jpwabc` 那条路不需要的事：
//
//   1. **断点 → AST 位置**。Score 的断点是「第 n 小节之前」/「某个 Chord 之后」，
//      而文本谱的行是 `ScoreLine`，落点得是「某个声部的第 k 个元素之前」。
//      桥是 `puToScore` 的 `noteMap`（Chord → AST 音符）。
//   2. **多声部对齐**。断点只按主旋律（`parts[0]`）算，但合唱谱四个声部得在**同一拍位**
//      断行，否则各声部行长不一、`layout.ts::alignVoices` 会把它们拧成一团。
//      对齐按**累计时值**做，不按元素下标——各声部的元素个数本来就不一样。
//
// 产出是一份「新的行划分」（`PuNewLine[]`），消费者（`relayout.ts`）据此重排文本。
// 无 DOM 依赖。

import { Fraction } from "../common/fraction";
import { pageBreakLines } from "../score/applybreaks";
import { computePhraseBreaks, type FitMetric } from "../score/phrase";
import { chooseLineLayout } from "../score/applybreaks";
import type { Chord, Score } from "../score/score";
import { elementQuarters, linesOfVoice, tupletRatios, voiceNumbers } from "./ast";
import type { MusicElement, NoteElement, PuDoc, PuSong, ScoreLine } from "./ast";
import { puToScore } from "./toscore";

/** 乐句排版时一页排几行。与 `jpscore.ts::PAGE_LINES` 同义，两种格式必须是同一个数。 */
const PAGE_LINES = 4;

/** 一个声部在某一新行上占的元素区间（半开区间，下标是该声部**整曲元素流**的下标）。 */
export interface PuLineSeg {
  voice: number;
  from: number;
  to: number;
}

/** 重排后的一行（一个「系统」：同组各声部各一条）。 */
export interface PuNewLine {
  segs: PuLineSeg[];
  /** 本行行尾换页（下一行另起一页）。 */
  pageAfter: boolean;
}

/** 某个声部整曲的元素流：把它的各条 `ScoreLine` 首尾接起来。 */
export interface VoiceStream {
  voice: number;
  lines: readonly ScoreLine[];
  /** 平行于元素流：每个元素属于哪一条源行、在源行里是第几个。 */
  origin: Array<{ lineIdx: number; elIdx: number }>;
  elements: MusicElement[];
  /** 平行于元素流：该元素**之前**的累计时值（四分音符为 1）。 */
  ticks: Fraction[];
}

/** 把一个声部的所有曲行接成一条元素流（含累计时值，多连音按比例折算）。 */
export function voiceStream(song: PuSong, voice: number): VoiceStream {
  const lines = linesOfVoice(song, voice);
  const st: VoiceStream = { voice, lines, origin: [], elements: [], ticks: [] };
  let tick = new Fraction(0);
  lines.forEach((line, lineIdx) => {
    const ratios = tupletRatios(line);
    line.elements.forEach((el, elIdx) => {
      st.origin.push({ lineIdx, elIdx });
      st.elements.push(el);
      st.ticks.push(tick);
      const r = ratios[elIdx];
      const q = elementQuarters(el);
      tick = tick.plus(r ? q.timesInt(r.num).divInt(r.den) : q);
    });
  });
  return st;
}

/** 在行首领起的小节线：反复开始要印在新行的行首，其余的都该留在上一行行尾。 */
function opensLine(el: MusicElement): boolean {
  return el.kind === "barline" && (el.type === "repeat-start" || el.type === "repeat-both");
}

/**
 * 把切点挪到**元素之间该断的地方**。
 *
 * 小节线与 `~`/`^` 的时值都是 0，按累计时值找过来会正落在它们身上；而谱面上小节线是
 * 上一行的收尾（`|` 印在行末），只有 `|:` 是下一行的起头。不校这一下，多声部对齐出来的
 * 行会以一根小节线开头、主旋律那行却没有。
 */
function alignCut(els: readonly MusicElement[], k: number): number {
  let at = k;
  while (at < els.length && !opensLine(els[at]!)
    && (els[at]!.kind === "barline" || els[at]!.kind === "beat-boundary")) at += 1;
  while (at > 0 && opensLine(els[at - 1]!)) at -= 1;
  return at;
}

/** 元素流里第一个累计时值 ≥ tick 的下标（对齐用；找不到就是流末）。 */
function indexAtTick(st: VoiceStream, tick: Fraction): number {
  for (let i = 0; i < st.ticks.length; i++) {
    if (st.ticks[i]!.compareTo(tick) >= 0) return alignCut(st.elements, i);
  }
  return st.elements.length;
}

/** 量行长的尺子。**必须量本函数交给它的那份 Score**：`FitMetric.spans` 以 Chord 对象身份为键，
 *  拿另一份 Score 量出来的 span 一个都对不上，`chooseLineLayout` 会以为「怎么都放得下」，
 *  于是一律并成两句一行（73《我主耶稣是生命源》一行 8 小节、排出来还得硬折）。 */
export type FitMeasure = (score: Score) => FitMetric | null;

/**
 * 算出这一首该怎么按乐句分行。
 *
 * @param measure 真实坐标的行长尺子（`App._puPhraseMeasure`）。不给就只按小节数断，
 *                行长目标是 `phrase.ts` 的出厂值——与 `.jpwabc` 那条路同一个口径。
 * @returns 新的行划分；这份文档没有可排的曲行时返回 null。
 */
export function puPhraseLines(
  doc: PuDoc, songIdx = 0, opt: { measure?: FitMeasure | null } = {},
): PuNewLine[] | null {
  const song = doc.songs[songIdx];
  if (!song) return null;
  const noteMap = new Map<Chord, NoteElement>();
  const score = puToScore(doc, { song: songIdx, noteMap, forExpanded: true });
  const part = score?.parts[0];
  if (!part) return null;

  const voices = voiceNumbers(song);
  const streams = new Map<number, VoiceStream>();
  for (const v of voices) streams.set(v, voiceStream(song, v));
  if (streams.size === 0) return null;

  // 主旋律是哪个声部：断点都落在它上面（`forExpanded` 已把带歌词的声部排到 parts[0]）。
  const where = new Map<NoteElement, { voice: number; idx: number }>();
  for (const st of streams.values()) {
    st.elements.forEach((el, idx) => {
      if (el.kind === "note") where.set(el, { voice: st.voice, idx });
    });
  }
  const firstChord = part.measures.flatMap((m) => m.entries).find((e) => noteMap.has(e as Chord));
  const leadEl = firstChord ? noteMap.get(firstChord as Chord) : undefined;
  const lead = streams.get((leadEl && where.get(leadEl)?.voice) ?? voices[0]!);
  if (!lead) return null;

  const breaks = computePhraseBreaks(part, { pageLines: PAGE_LINES });
  const fit = opt.measure?.(score) ?? null;
  if (fit) chooseLineLayout(part, breaks, 0, { fit });

  // Score 断点 → 主旋律元素流下标（「在此元素之前起新行」）。
  const idxOf = (ch: Chord): number | null => {
    const el = noteMap.get(ch);
    const at = el ? where.get(el) : undefined;
    return at && at.voice === lead.voice ? at.idx : null;
  };
  const cuts = new Set<number>();
  const sectionAt = new Set<number>(); // 这些切点之前是段末（主歌/副歌分界）
  part.measures.forEach((m, mid) => {
    if (mid > 0 && breaks.measureBreaks.has(mid)) {
      // 小节边界：落在本小节第一个音符之前（小节线元素留在上一行行尾）
      const first = m.entries.find((e) => noteMap.has(e as Chord)) as Chord | undefined;
      const raw = first ? idxOf(first) : null;
      const i = raw === null ? null : alignCut(lead.elements, raw);
      if (i !== null && i > 0) {
        cuts.add(i);
        if (breaks.sectionStarts.has(mid)) sectionAt.add(i);
      }
    }
    for (const e of m.entries) {
      const ch = e as Chord;
      if (!noteMap.has(ch)) continue;
      if (!breaks.midBreaks.has(ch) && !breaks.sectionCutChords.has(ch)) continue;
      const i = idxOf(ch);
      if (i === null) continue;
      // 行内断点：在该音符**之后**换行；跟在它后面的增时线属于同一个音，一并带走
      let at = i + 1;
      while (at < lead.elements.length && lead.elements[at]!.kind === "sustain") at += 1;
      at = alignCut(lead.elements, at);
      if (at > 0 && at < lead.elements.length) {
        cuts.add(at);
        if (breaks.sectionCutChords.has(ch)) sectionAt.add(at);
      }
    }
  });

  // 切点 → 各声部同拍位的切点 → 新的行
  const starts = [0, ...[...cuts].sort((a, b) => a - b)];
  const sectionEnds = new Set<number>(); // 1 基新行号：该行是段末
  const lines: PuNewLine[] = [];
  starts.forEach((from, i) => {
    const to = starts[i + 1] ?? lead.elements.length;
    const tickFrom = lead.ticks[from] ?? new Fraction(0);
    const tickTo = to < lead.ticks.length ? lead.ticks[to]! : null;
    const segs: PuLineSeg[] = [];
    for (const v of voices) {
      const st = streams.get(v)!;
      const a = st === lead ? from : indexAtTick(st, tickFrom);
      const b = st === lead ? to : tickTo === null ? st.elements.length : indexAtTick(st, tickTo);
      if (b > a) segs.push({ voice: v, from: a, to: b });
    }
    if (segs.length > 0) lines.push({ segs, pageAfter: false });
    if (to < lead.elements.length && sectionAt.has(to)) sectionEnds.add(lines.length);
  });
  if (lines.length === 0) return null;

  // 分页：与 `.jpwabc` 同一个助手，同一套「放不下才在段界换页」的口径。
  const pageAt = pageBreakLines(lines.length, sectionEnds, PAGE_LINES);
  lines.forEach((l, i) => {
    l.pageAfter = pageAt.has(i + 1) && i + 1 < lines.length;
  });
  return lines;
}
