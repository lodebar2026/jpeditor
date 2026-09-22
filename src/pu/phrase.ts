// 文本谱的「按乐句重排」——**把断点换算到文本谱自己的行上**。
//
// 断句本身不在这里：它是格式无关的（`score/phrase.ts::computePhraseBreaks` 只经断句输入接口读谱），
// `.jpwabc` 与文本谱共用同一套权重、同一套分页口径（`applybreaks.ts::pageBreakLines`）。
// 这里只做两件 `.jpwabc` 那条路不需要的事：
//
//   1. **断点 → AST 位置**。断点是「第 n 小节之前」/「某个和弦之后」，
//      而文本谱的行是 `ScoreLine`，落点得是「某个声部的第 k 个元素之前」。
//      断句直接吃 `ScoreDoc` 拼出的输入（`phrasesong.ts`），桥是它的 `idOf`（和弦 → 元素 id）
//      再经排版行视图的 `elementOf` 回到行里的元素（元素带原文区间，重排据此切原文）。
//   2. **多声部对齐**。断点只按主旋律（`parts[0]`）算，但合唱谱四个声部得在**同一拍位**
//      断行，否则各声部行长不一、`layout.ts::alignVoices` 会把它们拧成一团。
//      对齐按**累计时值**做，不按元素下标——各声部的元素个数本来就不一样。
//
// 产出是一份「新的行划分」（`PuNewLine[]`），消费者（`relayout.ts`）据此重排文本。
// 无 DOM 依赖。

import { Fraction } from "../common/fraction";
import { chooseLineLayout, fitForInput, pageBreakLines } from "../score/applybreaks";
import { computePhraseBreaks } from "../score/phrase";
import { chordsOf, type PhraseChord } from "../score/phraseinput";
import type { JChord, JScore } from "../layout/input";
import { elementQuarters, linesOfVoice, tupletRatios, voiceNumbers } from "./ast";
import type { MusicElement, NoteElement, PuSong, ScoreLine, SourceSpan } from "./ast";
import { phrasePartOfSong } from "./phrasesong";
import { jianpuInputOfDoc } from "../model/jianpuinput";
import type { ElementId, ScoreDoc } from "../model/doc";
import { docView } from "./slots";

/** 乐句排版时一页排几行。分页与断句共用这一个数。 */
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

/** 量行长的尺子：按本函数交给它的那份引擎输入量自然跨度（和弦按元素 id 对回断句输入）。 */
export type FitMeasure = (score: JScore) => { width: number; spans: ReadonlyMap<JChord, { x0: number; x1: number }> } | null;

/**
 * 算出这一首该怎么按乐句分行。
 *
 * @param measure 真实坐标的行长尺子（`App._puPhraseMeasure`）。不给就只按小节数断，
 *                行长目标是 `phrase.ts` 的出厂值——与 `.jpwabc` 那条路同一个口径。
 * @returns 新的行划分；这份文档没有可排的曲行时返回 null。
 */
export function puPhraseLines(
  sdoc: ScoreDoc, songIdx = 0, opt: { measure?: FitMeasure | null } = {},
): PuNewLine[] | null {
  const view = docView(sdoc);
  const song = view.songs[songIdx];
  if (!song) return null;
  // 断句输入从 `ScoreDoc` 出；断点经「和弦 → id → 行里的元素」回到原文（重排改写的是原文本身）
  const input = phrasePartOfSong(sdoc, songIdx);
  if (!input) return null;
  const part = input.part;
  const noteMap = new Map<PhraseChord, NoteElement>();
  for (const [ch, id] of input.idOf) {
    const el = view.elementOf.get(id);
    if (el?.kind === "note") noteMap.set(ch, el);
  }

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
  const firstChord = part.measures.flatMap((m) => chordsOf(m)).find((c) => noteMap.has(c));
  const leadEl = firstChord ? noteMap.get(firstChord) : undefined;
  const lead = streams.get((leadEl && where.get(leadEl)?.voice) ?? voices[0]!);
  if (!lead) return null;

  const breaks = computePhraseBreaks(part, { pageLines: PAGE_LINES });
  if (opt.measure) {
    const score = jianpuInputOfDoc(sdoc, { song: songIdx, forExpanded: true });
    const measured = score?.parts[0] ? opt.measure(score) : null;
    if (measured) chooseLineLayout(part, breaks, 0, { fit: fitForInput(measured, input.idOf) });
  }

  // 断点 → 主旋律元素流下标（「在此元素之前起新行」）。
  const idxOf = (ch: PhraseChord): number | null => {
    const el = noteMap.get(ch);
    const at = el ? where.get(el) : undefined;
    return at && at.voice === lead.voice ? at.idx : null;
  };
  const cuts = new Set<number>();
  const sectionAt = new Set<number>(); // 这些切点之前是段末（主歌/副歌分界）
  part.measures.forEach((m, mid) => {
    if (mid > 0 && breaks.measureBreaks.has(mid)) {
      // 小节边界：落在本小节第一个音符之前（小节线元素留在上一行行尾）
      const first = chordsOf(m).find((c) => noteMap.has(c));
      const raw = first ? idxOf(first) : null;
      const i = raw === null ? null : alignCut(lead.elements, raw);
      if (i !== null && i > 0) {
        cuts.add(i);
        if (breaks.sectionStarts.has(mid)) sectionAt.add(i);
      }
    }
    for (const ch of chordsOf(m)) {
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
    const segs = segsOf(voices, streams, lead, from, to);
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

/** 主旋律元素流 `[from, to)` 这一行 → 各声部同拍位的那一段。 */
function segsOf(
  voices: readonly number[], streams: ReadonlyMap<number, VoiceStream>, lead: VoiceStream, from: number, to: number,
): PuLineSeg[] {
  const tickFrom = lead.ticks[from] ?? new Fraction(0);
  const tickTo = to < lead.ticks.length ? lead.ticks[to]! : null;
  const segs: PuLineSeg[] = [];
  for (const v of voices) {
    const st = streams.get(v)!;
    const a = st === lead ? from : indexAtTick(st, tickFrom);
    const b = st === lead ? to : tickTo === null ? st.elements.length : indexAtTick(st, tickTo);
    if (b > a) segs.push({ voice: v, from: a, to: b });
  }
  return segs;
}

/**
 * **照原文现有的行结构**，只在元素 `afterId` 之后加一刀（`add`）或去掉它后面那一刀（与下一行合并）。
 * 可视化编辑增删文本谱换行用：文本谱的换行就是另起一行 `Q:`，没有符号可增删，只能重切行
 * （写回复用乐句重排那套原文搬运，`relayout.ts::relayoutPuBreak`）。
 *
 * @returns 新的行划分；元素不在这首里、或这一刀加不上 / 去不掉时返回 null
 */
export function puLinesEdited(
  sdoc: ScoreDoc, songIdx: number, edit: { afterId: ElementId; add: boolean; page: boolean },
): PuNewLine[] | null {
  const view = docView(sdoc);
  const song = view.songs[songIdx];
  const el = view.elementOf.get(edit.afterId);
  if (!song || !el) return null;
  const voices = voiceNumbers(song);
  const streams = new Map(voices.map((v) => [v, voiceStream(song, v)] as const));
  // 刀落在这个元素所在的声部上，其余声部按拍位跟
  let lead: VoiceStream | undefined;
  let idx = -1;
  for (const st of streams.values()) {
    const i = st.elements.indexOf(el);
    if (i >= 0) {
      lead = st;
      idx = i;
      break;
    }
  }
  if (!lead) return null;
  const pageOf = new Map<ScoreLine, number>();
  song.pages.forEach((pg, p) => pg.groups.forEach((g) => g.voices.forEach((l) => pageOf.set(l, p))));
  // 现有的行：主旋律元素流里换了源行的地方
  const cuts = new Set<number>();
  const pageCuts = new Set<number>();
  for (let i = 1; i < lead.origin.length; i++) {
    const a = lead.origin[i - 1]!.lineIdx;
    const b = lead.origin[i]!.lineIdx;
    if (a === b) continue;
    cuts.add(i);
    if (pageOf.get(lead.lines[a]!) !== pageOf.get(lead.lines[b]!)) pageCuts.add(i);
  }
  if (edit.add) {
    // 在该元素之后换行：跟在它后面的增时线属于同一个音，一并留在这一行
    let at = idx + 1;
    while (at < lead.elements.length && lead.elements[at]!.kind === "sustain") at += 1;
    at = alignCut(lead.elements, at);
    if (at <= 0 || at >= lead.elements.length) return null;
    cuts.add(at);
    if (edit.page) pageCuts.add(at);
  } else {
    const at = [...cuts].filter((c) => c > idx).sort((a, b) => a - b)[0];
    if (at === undefined) return null;
    cuts.delete(at);
    pageCuts.delete(at);
  }
  const starts = [0, ...[...cuts].sort((a, b) => a - b)];
  const lines: PuNewLine[] = [];
  starts.forEach((from, i) => {
    const to = starts[i + 1] ?? lead.elements.length;
    const segs = segsOf(voices, streams, lead, from, to);
    if (segs.length > 0) lines.push({ segs, pageAfter: pageCuts.has(to) });
  });
  return lines.length > 0 ? lines : null;
}

/**
 * 一个断点：**新行从这个元素起**。
 *
 * 两个消费者各取所需：写回 `ScoreDoc` 的那条路（123/ABC，`model/relayout.ts`）按 `id` 找回
 * 模型里的元素；改写原文的那条路（`.jpwabc`）按 `source` 在原文上下刀。小节线没有 `ElementId`
 * （模型里它挂在 `Measure.barlines` 上，不是元素），所以 `|:` 领起的新行 `id` 取它后面那个音
 * ——落到小节级换行上是同一个位置；`source` 仍是 `|:` 自己的，原文才切得对。
 */
export interface PhraseCut {
  id: ElementId | null;
  source: SourceSpan | null;
  /** 这一行另起一页 */
  page: boolean;
}

/**
 * 按乐句重排的断点（不含第一行的行首）。**与格式无关**：`puPhraseLines` 只经断句输入读谱，
 * 文本谱 / 123 / ABC / `.jpwabc` 拼出的 `ScoreDoc` 都吃得下。
 */
export function phraseCuts(
  sdoc: ScoreDoc, songIdx = 0, opt: { measure?: FitMeasure | null } = {},
): PhraseCut[] | null {
  const lines = puPhraseLines(sdoc, songIdx, opt);
  if (!lines) return null;
  const view = docView(sdoc);
  const song = view.songs[songIdx];
  if (!song) return null;
  const streams = new Map(voiceNumbers(song).map((v) => [v, voiceStream(song, v)] as const));
  const cuts: PhraseCut[] = [];
  lines.forEach((line, i) => {
    if (i === 0) return;
    // 各声部同拍位起头，取哪一条都落在同一个位置；段首那一条最全（主旋律优先排在前）
    const seg = line.segs[0];
    const st = seg ? streams.get(seg.voice) : undefined;
    if (!seg || !st) return;
    let id: ElementId | null = null;
    let source: SourceSpan | null = null;
    for (let k = seg.from; k < seg.to; k++) {
      const el = st.elements[k]!;
      if (source === null && el.source.length > 0) source = el.source;
      const got = view.idOf.get(el);
      if (id === null && got !== undefined) id = got;
      if (id !== null && source !== null) break;
    }
    cuts.push({ id, source, page: lines[i - 1]!.pageAfter });
  });
  return cuts;
}
