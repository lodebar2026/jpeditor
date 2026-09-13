// `PuDoc` → `ScoreDoc`：文本谱进语义模型的**唯一入口**。
//
// ## 判据：无损
//
// 文本谱的排版、导出、试听、双向定位都要改吃 `ScoreDoc`（`docs/待办.md` §1.1），
// 所以这里转过去的东西必须**足以原样还原出那份 `PuDoc`**——少一样，排版就少画一样。
// 回归是 `scripts/pu-scoredoc-check.mjs`：`PuDoc → ScoreDoc → PuDoc` 逐字段比对，差异为 0。
// 文本谱特有、MusicXML 装不下的东西（记号原名与 level、`~`/`^`、临时伴奏层、行级歌词版式）
// 放在 `doc.ts` 里标明来源的字段上，语义那一侧（`notations` / `Barline.ending` / `Mark`）照常填。
//
// ## 结构差异
//
// `PuDoc` 是**扁平元素流 + 下标区间配对**，`ScoreDoc` 是**小节层级 + id 配对**。
// 先按 barline 切小节，同时建「下标 → 元素 id」的映射，再把 Mark 的下标区间翻成 id。
// **映射一次建好，不要边转边算**。
//
// 行结构：`PuDoc` 的一个 `VoiceGroup` 是一个系统。每个声部在该组那一行的**首小节**上
// 挂 `print.newSystem` + `print.system`（组序号）——一组不一定含全部声部，靠组序号对回去。

import type {
  BarlineElement,
  LyricLine as PuLyricLine,
  Mark as PuMark,
  MusicElement,
  NoteElement,
  Ornament,
  PuDoc,
  ScoreLine,
} from "../pu/ast";
import type {
  Barline,
  BeamVal,
  Chord,
  ElementId,
  InlineItem,
  Lyric,
  LyricLineInfo,
  Mark,
  Measure,
  Part,
  ScoreDoc,
  SourceOrnament,
  Song,
  Sustain,
} from "./doc";
import { normalizeSpelling } from "../j123/fields";
import { IdGen, emptyDoc, emptySong } from "./helpers";

/** `PuDoc` 的 BarlineType → `ScoreDoc` 的 bar-style + repeat。 */
function fromPuBarline(el: BarlineElement): Barline {
  const b: Barline = { location: "right" };
  switch (el.type) {
    case "end": b.style = "light-heavy"; break;
    case "double": b.style = "light-light"; break;
    case "repeat-start": b.style = "heavy-light"; b.repeat = "forward"; break;
    case "repeat-end": b.style = "light-heavy"; b.repeat = "backward"; break;
    case "repeat-both": b.style = "light-heavy"; b.repeat = "backward"; b.alsoForward = true; break;
    // `|/` 不显形也不占宽、`|*` 不显形但占宽：MusicXML 两者都只能是 none
    case "hidden": b.style = "none"; b.noWidth = true; break;
    case "invisible": b.style = "none"; break;
    default: b.style = "regular"; break;
  }
  if (el.ornaments.length) b.ornaments = ornamentsOf(el.ornaments);
  if (el.temporaryMeter) {
    b.time = { beats: el.temporaryMeter.numerator, beatType: el.temporaryMeter.denominator };
    if (el.temporaryMeter.parenthesized) b.time.parenthesized = true;
  }
  if (el.annotation !== undefined) b.annotation = el.annotation;
  b.source = el.source;
  return b;
}

const ornamentsOf = (os: readonly Ornament[]): SourceOrnament[] =>
  os.map((o) => ({ name: o.name, level: o.level }));

/** 时值分母（4=四分）→ 减时线层数。 */
function beamsOf(duration: number): number {
  let n = 0;
  let d = duration;
  while (d > 4 && n < 6) {
    d /= 2;
    n++;
  }
  return n;
}

const DIVISIONS = 48;

function durationFrom(duration: number, dots: number, sustains: number): Chord["duration"] {
  const beams = beamsOf(duration);
  const base = DIVISIONS >> Math.min(beams, 6);
  let total = base;
  let add = base;
  for (let k = 0; k < dots; k++) {
    add = Math.floor(add / 2);
    total += add;
  }
  total += sustains * DIVISIONS;
  const types = ["quarter", "eighth", "16th", "32nd", "64th", "128th", "256th"] as const;
  return { divisions: total, type: types[Math.min(beams, 6)]!, dots };
}

const harmonyOf = (text: string): Chord["harmony"] => ({ root: { step: "C", alter: 0 }, kind: "", text });

/** 一个音符（主音或倚音）→ 和弦。倚音不占时值，但减时线层数要留着（排版画它）。 */
function chordOfNote(n: NoteElement, voice: number, ids: IdGen, grace: Chord["grace"]): Chord {
  const beams = beamsOf(n.duration);
  const ch: Chord = {
    kind: "chord",
    id: ids.next(),
    notes: [],
    duration: grace ? { ...durationFrom(n.duration, n.dots, 0), divisions: 0 } : durationFrom(n.duration, n.dots, 0),
    voice,
    staff: 1,
    source: n.source,
  };
  if (grace) ch.grace = grace;
  if (n.sound === "rhythm") {
    // 节奏音符（文本谱的 `X`、番茄的 `9`）：有声无音高，123 写 `X`
    ch.rhythm = true;
  } else if (n.pitch === 0) {
    ch.rest = n.octave ? { octaveShift: n.octave } : {};
  } else {
    const note: { degree: { number: number; octaveShift: number; accidental?: NoteElement["accidental"] } } = {
      degree: { number: n.pitch, octaveShift: n.octave },
    };
    if (n.accidental) note.degree.accidental = n.accidental;
    ch.notes.push(note as Chord["notes"][number]);
  }
  // 隐藏音符：`PuDoc` 用 hidden 标记，`ScoreDoc` 用 printObject=false（123 写 `x`）
  if (n.hidden) ch.printObject = false;
  // 对位缺省是「非休止」（`doc.ts::Chord.lyricAnchor`），只记例外；倚音一律记（123 的倚音缺省不对位）
  if (grace || n.lyricAnchor !== (n.pitch !== 0 || n.sound === "rhythm")) ch.lyricAnchor = n.lyricAnchor;
  if (beams > 0) ch.beams = Array.from({ length: beams }, () => "continue" as BeamVal);
  if (n.chord !== undefined) ch.harmony = harmonyOf(n.chord);
  // `"(副歌)"` 这类音符上方的注记：`PuDoc` 存 `annotation`，模型里归 `sectionWord`
  if (n.annotation !== undefined) ch.sectionWord = n.annotation;
  if (n.ornaments.length) {
    ch.ornaments = ornamentsOf(n.ornaments);
    // 语义投影（123 与导出用）
    const fermata = n.ornaments.some((o) => /^(yc|fermata)$/i.test(o.name));
    const arts = n.ornaments.filter((o) => !/^(yc|fermata)$/i.test(o.name)).map((o) => o.name);
    ch.notations = { ...(fermata ? { fermata: true } : {}), ...(arts.length ? { articulations: arts } : {}) };
  }
  // 八度/时值以外的修饰在 `code` 里，不进模型（排版不看它）
  return ch;
}

interface LineResult {
  measures: Measure[];
  /** 元素流下标 → `ScoreDoc` 元素 id（Mark 的区间靠它翻译） */
  idAt: Map<number, ElementId>;
  /** 元素流下标 → 它落在第几小节（房号要找小节） */
  measureAt: Map<number, number>;
  /** 参与对位的元素（按顺序），歌词按它铺回去 */
  anchors: (Chord | Sustain)[];
  /** 这一行元素流的长度 */
  length: number;
}

/** 跨行承接状态：行首的 `-` 要照抄的前音 */
interface Carry {
  last: Chord | null;
}

/** 一行曲（或一段临时伴奏层）→ 小节数组。 */
function convertLine(
  elements: readonly MusicElement[],
  voice: number,
  ids: IdGen,
  startMeasureNo: number,
  carry: Carry,
  elementIds?: Map<MusicElement, ElementId>,
): LineResult {
  const measures: Measure[] = [];
  const idAt = new Map<number, ElementId>();
  const measureAt = new Map<number, number>();
  const anchors: (Chord | Sustain)[] = [];
  let mea: Measure = { number: String(startMeasureNo), elements: [] };
  /** 本小节里增时线可以并进去的那个和弦；小节线后清空（跨线的 `-` 是承接前音） */
  let host: Chord | null = null;
  /** 还没找到宿主的夹层（`~`/`^`/临时伴奏），挂到下一个符号上 */
  let pending: InlineItem[] = [];

  const takePending = (target: { before?: InlineItem[] }): void => {
    if (pending.length) {
      target.before = pending;
      pending = [];
    }
  };
  const flush = (bar?: Barline): void => {
    if (bar) (mea.barlines ??= []).push(bar);
    if (mea.elements.length || mea.barlines?.length) measures.push(mea);
    mea = { number: String(startMeasureNo + measures.length), elements: [] };
    host = null;
  };

  for (let i = 0; i < elements.length; i++) {
    const el: MusicElement = elements[i]!;
    switch (el.kind) {
      case "barline": {
        const b = fromPuBarline(el);
        takePending(b);
        measureAt.set(i, measures.length);
        flush(b);
        break;
      }

      case "sustain": {
        if (!host) {
          // 小节线/行首之后的 `-`：承接前音的延长。它自己印成一条增时线
          const prev = carry.last;
          const ch: Chord = {
            kind: "chord",
            id: ids.next(),
            notes: prev ? prev.notes.map((nt) => ({ ...(nt.degree ? { degree: { ...nt.degree } } : {}) })) : [],
            duration: durationFrom(4, 0, 0),
            voice,
            staff: 1,
            continued: true,
            source: el.source,
          };
          if (prev?.rest || !prev) ch.rest = {};
          if (prev?.rhythm) ch.rhythm = true;
          if (el.lyricAnchor !== (!ch.rest || !!ch.rhythm)) ch.lyricAnchor = el.lyricAnchor;
          if (el.chord !== undefined) ch.harmony = harmonyOf(el.chord);
          if (el.annotation !== undefined) ch.sectionWord = el.annotation;
          if (el.ornaments.length) ch.ornaments = ornamentsOf(el.ornaments);
          takePending(ch);
          mea.elements.push(ch);
          idAt.set(i, ch.id);
          elementIds?.set(el, ch.id);
          measureAt.set(i, measures.length);
          if (el.lyricAnchor) anchors.push(ch);
          host = ch;
          carry.last = ch;
          break;
        }
        const su: Sustain = { id: ids.next(), source: el.source };
        if (el.chord !== undefined) su.harmony = harmonyOf(el.chord);
        if (el.annotation !== undefined) su.sectionWord = el.annotation;
        if (el.ornaments.length) su.ornaments = ornamentsOf(el.ornaments);
        if (el.lyricAnchor) su.lyricAnchor = true;
        takePending(su);
        (host.sustains ??= []).push(su);
        host.duration = durationFrom(4 << (host.beams?.length ?? 0), host.duration.dots, host.sustains.length);
        idAt.set(i, su.id);
        elementIds?.set(el, su.id);
        measureAt.set(i, measures.length);
        if (el.lyricAnchor) anchors.push(su);
        break;
      }

      case "note": {
        const n = el;
        // 倚音：`PuDoc` 挂在主音符上，`ScoreDoc` 是独立的 grace 元素，前倚音在主音之前、后倚音在之后
        for (const g of n.graceBefore) mea.elements.push(chordOfNote(g, voice, ids, {}));
        const ch = chordOfNote(n, voice, ids, undefined);
        takePending(ch);
        mea.elements.push(ch);
        for (const g of n.graceAfter) mea.elements.push(chordOfNote(g, voice, ids, { after: true }));
        idAt.set(i, ch.id);
        elementIds?.set(n, ch.id);
        measureAt.set(i, measures.length);
        host = ch;
        carry.last = ch;
        if (n.lyricAnchor) anchors.push(ch);
        break;
      }

      case "beat-boundary":
        pending.push({ kind: "boundary", behavior: el.behavior, source: el.source });
        break;

      case "inline-layer": {
        // 伴奏层是独立的一小段元素流：自带小节与记号，承接状态不跟主旋律串
        const sub = convertLine(el.elements, voice, ids, 1, { last: null }, elementIds);
        const marks: Mark[] = [];
        convertMarks(el.marks, sub, marks, { pending: new Map() }, sub.measures);
        pending.push({ kind: "layer", role: el.role, measures: sub.measures, marks, source: el.source });
        break;
      }
    }
  }
  // 行末剩下的夹层：挂在最后一个小节上（行里一个小节都没有时单独成一个空小节）
  if (pending.length) {
    if (mea.elements.length || mea.barlines?.length || measures.length === 0) {
      mea.trailing = pending;
      measures.push(mea);
      mea = { number: String(startMeasureNo + measures.length), elements: [] };
    } else {
      measures[measures.length - 1]!.trailing = pending;
    }
    pending = [];
  }
  flush();
  return { measures, idAt, measureAt, anchors, length: elements.length };
}

/** 歌词铺回音符：`PuDoc` 按行存音节序列，`ScoreDoc` 挂在元素上；行这一级的版式记进 `print.lyricLines`。 */
function attachLyrics(anchors: readonly (Chord | Sustain)[], lyrics: readonly PuLyricLine[]): LyricLineInfo[] {
  const infos: LyricLineInfo[] = [];
  const rangeKey = (l: PuLyricLine): string => `${l.verseFrom}-${l.verseTo}`;
  const dup = new Set<string>();
  const seen = new Set<string>();
  for (const l of lyrics) (seen.has(rangeKey(l)) ? dup : seen).add(rangeKey(l));
  for (const [lineIdx, line] of lyrics.entries()) {
    const info: LyricLineInfo = {
      verseFrom: line.verseFrom,
      verseTo: line.verseTo,
      annotationGap: line.annotationGap,
      count: line.syllables.length,
    };
    if (line.annotation !== undefined) info.annotation = line.annotation;
    if (line.joinBrace) info.joinBrace = true;
    infos.push(info);
    let labelled = false;
    for (let k = 0; k < line.syllables.length && k < anchors.length; k++) {
      const syl = line.syllables[k]!;
      // 空串 = 跳过这个音符；只剩标点的（「心|，|难」）要留着，标点得画
      if (syl.text === "" && !syl.trailingPunctuation) continue;
      const l: Lyric = { number: line.verseFrom, text: syl.text };
      if (line.verseTo !== line.verseFrom) l.numberTo = line.verseTo;
      if (syl.trailingPunctuation) l.trailingPunctuation = syl.trailingPunctuation;
      // 印刷段号挂在该段**第一个非空**音节上（与 `j123/parse.ts` 同口径）
      if (!labelled && line.annotation !== undefined) {
        l.verseLabel = line.annotation;
        labelled = true;
      }
      if (dup.has(rangeKey(line))) l.lineIndex = lineIdx;
      l.source = syl.source;
      const a = anchors[k]!;
      (a.lyrics ??= []).push(l);
    }
  }
  return infos;
}

/** 跨行记号的待合并状态。`PuDoc` 把一条跨行弧拆成两条（各带 continuation 标记），
 *  而 123 里跨行弧就是**一对 `(` `)`**（中间夹着 `$` 换行），所以要合回一条——
 *  不合的话 emit 会在续接行的行首多写一个 `(`，往返就错层。 */
interface CrossState {
  /** 按类型排队。**不能用 level 当 key**——`PuDoc` 跨行时会给续接那条重新编 level
   *  （见过 3 → 1），拿 level 配对永远配不上。同类多条就按先后顺序配。 */
  pending: Map<string, Mark[]>;
}

/** 跨行未收口的房号：起点那条小节线上的 ending，等续行收尾。
 *  起在行尾（本行已无小节可挂）时 `start` 为空，先记下房号与 level，到续行首小节再建 */
interface OpenVolta {
  start: NonNullable<Barline["ending"]> | null;
  lead?: { caption: string; level: number; placeholder: { mea: Measure; bar: Barline } };
}

/** Mark：下标区间 → id 配对。房号另走 `applyVolta`（`ScoreDoc` 里是 `Barline.ending`）。 */
function convertMarks(
  marks: readonly PuMark[],
  r: LineResult,
  out: Mark[],
  cross: CrossState,
  measures: Measure[],
  voltas?: { open: OpenVolta[] },
): void {
  for (const m of marks) {
    if (m.type === "volta") {
      applyVolta(r, m, measures, voltas ?? { open: [] });
      continue;
    }
    const type: Mark["type"] = m.type === "slur" ? "slur" : m.type === "tuplet" ? "tuplet" : "wedge";
    const start = nearestId(r.idAt, m.start, 1);
    const end = nearestId(r.idAt, m.end, -1);
    /** 端点离最近符号的偏移（`Mark.startLead/endTrail`） */
    const lead = start === undefined ? 0 : nearestIndex(r.idAt, m.start, 1)! - m.start;
    const trail = end === undefined ? 0 : m.end - nearestIndex(r.idAt, m.end, -1)!;
    const setTrail = (mk: Mark): void => {
      if (trail > 0 && !m.continuationToNext) mk.endTrail = trail;
      else delete mk.endTrail;
    };
    const key = m.type;
    if (start === undefined && m.continuationToNext && !m.continuationFromPrevious) {
      // 起点在行尾：本行没有符号可挂，占个位，等续行来了再定起点（`Mark.leadInPreviousLine`）
      const lm: Mark = { type, start: -1, end: -1, leadInPreviousLine: true, continuesToNext: true };
      if (m.level) lm.level = m.level;
      if (r.length - m.start > 0) lm.leadBack = r.length - m.start;
      if (m.type === "crescendo") lm.wedgeType = "crescendo";
      if (m.type === "decrescendo") lm.wedgeType = "diminuendo";
      const q = cross.pending.get(key);
      if (q) q.push(lm);
      else cross.pending.set(key, [lm]);
      continue;
    }
    if (start === undefined && end !== undefined && m.start > m.end && !m.continuationToNext && !m.continuationFromPrevious) {
      const mk: Mark = { type, start: end, end, collapsed: true };
      if (m.level) mk.level = m.level;
      if (m.type === "crescendo") mk.wedgeType = "crescendo";
      if (m.type === "decrescendo") mk.wedgeType = "diminuendo";
      out.push(mk);
      continue;
    }
    if (start === undefined || end === undefined) continue;
    // 续接行：把终点接回上一行那条，不再产生新的一条
    if (m.continuationFromPrevious) {
      const queue = cross.pending.get(key);
      const head = queue?.shift();
      if (head) {
        if (head.start === -1) {
          head.start = start;
          if (lead > 0) head.startLead = lead;
          out.push(head);
        }
        head.end = end;
        setTrail(head);
        delete head.continuesToNext;
        (head.continuationLevels ??= []).push(m.level);
        if (m.continuationToNext) {
          head.continuesToNext = true;
          queue!.push(head);
        }
        continue;
      }
    }
    const mk: Mark = { type, start, end };
    if (lead > 0 && !m.continuationFromPrevious) mk.startLead = lead;
    setTrail(mk);
    if (m.level) mk.level = m.level;
    if (m.type === "crescendo") mk.wedgeType = "crescendo";
    if (m.type === "decrescendo") mk.wedgeType = "diminuendo";
    if (type === "tuplet") {
      // 显示数字只在原文写了时才有；没写时 123 与导出按 3 连音处理
      const actual = Number(m.caption);
      if (m.caption !== undefined && Number.isFinite(actual)) mk.tupletActual = actual;
      mk.tupletNormal = 2;
    }
    if (m.continuationFromPrevious) mk.continuesFromPrevious = true;
    if (m.continuationToNext) {
      mk.continuesToNext = true;
      const q = cross.pending.get(key);
      if (q) q.push(mk);
      else cross.pending.set(key, [mk]);
    }
    out.push(mk);
  }
}

/** 同 `nearestId`，返回的是下标。 */
function nearestIndex(idAt: Map<number, ElementId>, from: number, dir: 1 | -1): number | undefined {
  for (let i = from; i >= 0 && i < from + 64; i += dir) {
    if (idAt.has(i)) return i;
    if (dir === -1 && i === 0) break;
  }
  return undefined;
}

/** 下标可能落在 barline（没有 id）上，按方向找最近的有 id 的元素。 */
function nearestId(idAt: Map<number, ElementId>, from: number, dir: 1 | -1): ElementId | undefined {
  for (let i = from; i >= 0 && i < from + 64; i += dir) {
    const id = idAt.get(i);
    if (id !== undefined) return id;
    if (dir === -1 && i === 0) break;
  }
  return undefined;
}

/** 第 k 小节在行里的首/末下标（只数有归属的符号与小节线，与 `pu/slots.ts` 的小节跨度同口径） */
function measureEdge(r: LineResult, k: number, which: "first" | "last"): number | undefined {
  let hit: number | undefined;
  for (const [i, mk] of r.measureAt) {
    if (mk !== k) continue;
    if (hit === undefined || (which === "first" ? i < hit : i > hit)) hit = i;
  }
  return hit;
}

/** 下标 → 所在小节。落在无 id 的东西上时按方向找最近有归属的。 */
function nearestMeasure(r: LineResult, from: number, dir: 1 | -1): number | undefined {
  for (let i = from; i >= 0 && i < from + 64; i += dir) {
    const k = r.measureAt.get(i);
    if (k !== undefined) return k;
    if (dir === -1 && i === 0) break;
  }
  return undefined;
}

let voltaPair = 0;

/** 房号：`PuDoc` 的 volta Mark → 起止小节的 `Barline.ending`。跨行的合成一个 start…stop。 */
function applyVolta(r: LineResult, m: PuMark, measures: Measure[], voltas: { open: OpenVolta[] }): void {
  const caption = m.caption ?? "1";
  const stopType = m.openEnd ? ("discontinue" as const) : ("stop" as const);

  const putStart = (mea: Measure, ending: NonNullable<Barline["ending"]>): void => {
    // 同一处起两个房号（解析器留下的不收口房号与新房号重叠）时各占一条左线，不互相覆盖
    const existing = (mea.barlines ?? []).find((b) => b.location === "left");
    if (existing && !existing.ending) existing.ending = ending;
    else if (existing) mea.barlines!.push({ location: "left", ending });
    else (mea.barlines ??= []).unshift({ location: "left", ending });
  };
  const makeStart = (cap: string, level: number): NonNullable<Barline["ending"]> => {
    const ns = cap.split(/[.,]/).map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0);
    const e: NonNullable<Barline["ending"]> = { numbers: ns.length ? ns : [1], type: "start", text: cap };
    if (m.caption === undefined) e.captionless = true;
    if (level) e.level = level;
    return e;
  };

  let start: NonNullable<Barline["ending"]> | null = null;
  if (m.continuationFromPrevious) {
    const head = voltas.open.shift();
    if (head?.start) {
      start = head.start;
      (start.continuationLevels ??= []).push(m.level);
    } else if (head?.lead) {
      const ph = head.lead.placeholder;
      ph.mea.barlines = (ph.mea.barlines ?? []).filter((b) => b !== ph.bar);
      if (!ph.mea.barlines.length) delete ph.mea.barlines;
      // 上一行行尾起头的：房号挂到本行首小节，标明上一行有一段空起头
      const k = nearestMeasure(r, m.start, 1);
      const mea = k === undefined ? undefined : measures[k];
      if (!mea) return;
      start = makeStart(head.lead.caption, head.lead.level);
      start.leadInPreviousLine = true;
      start.continuationLevels = [m.level];
      putStart(mea, start);
    }
  }
  if (!start) {
    const k = nearestMeasure(r, m.start, 1);
    const mea = k === undefined ? undefined : measures[k];
    if (!mea) {
      if (m.continuationToNext) {
        // 先挂个占位：后面若再没有续行接上，它就是解析器留下的孤段（`Ending.danglingLead`）
        const last = measures[measures.length - 1];
        if (!last) return;
        const e = makeStart(caption, m.level);
        e.danglingLead = true;
        const bar: Barline = { location: "right", ending: e };
        (last.barlines ??= []).push(bar);
        voltas.open.push({ start: null, lead: { caption, level: m.level, placeholder: { mea: last, bar } } });
      }
      return;
    }
    start = makeStart(caption, m.level);
    const first = measureEdge(r, k!, "first");
    if (first !== undefined && m.start !== first) start.startOffset = m.start - first;
    putStart(mea, start);
    const kEnd = m.continuationToNext ? undefined : nearestMeasure(r, m.end, -1);
    if (kEnd !== undefined && kEnd < k!) {
      start.collapsed = true;
      return;
    }
  }
  if (m.continuationToNext) {
    voltas.open.push({ start });
    return;
  }
  const k = nearestMeasure(r, m.end, -1);
  const mea = k === undefined ? undefined : measures[k];
  if (!mea) return;
  start.pair ??= ++voltaPair;
  const ending: NonNullable<Barline["ending"]> = { numbers: start.numbers, type: stopType, text: start.text ?? caption, pair: start.pair };
  const last = measureEdge(r, k!, "last");
  if (last !== undefined && m.end !== last) ending.endOffset = m.end - last;
  const right = (mea.barlines ?? []).find((b) => b.location === "right");
  if (right && !right.ending) right.ending = ending;
  else (mea.barlines ??= []).push({ location: "right", ending });
}

export interface PuToScoreDocOptions {
  /** 传入一个空 Map，转换时填上「原文元素（音符/增时线）→ 元素 id」。
   *  乐句重排要用：它改写的是原文，断点要从 `Score` 经 id 找回原文元素（`pu/phrase.ts`）。 */
  elementIds?: Map<MusicElement, ElementId>;
}

/** `PuDoc` → `ScoreDoc`。一首 `PuSong` 对一首 `Song`。 */
export function puToScoreDoc(pu: PuDoc, options: PuToScoreDocOptions = {}): ScoreDoc {
  const doc: ScoreDoc = emptyDoc("pu");
  doc.puDialect = pu.dialect;
  doc.source = pu.source;
  doc.diagnostics = [...pu.diagnostics];
  const ids = new IdGen();

  for (const ps of pu.songs) {
    const song: Song = emptySong();
    const meta = ps.metadata;
    if (meta.titles[0] !== undefined) song.work.title = meta.titles[0];
    song.work.subtitles = meta.titles.slice(1);
    if (meta.version !== undefined) song.work.version = meta.version;
    if (meta.authors.length) {
      song.identification = { creators: meta.authors.map((t) => ({ type: "composer", text: t })) };
    }
    if (meta.mode !== undefined || meta.tonic !== undefined) {
      song.key = { fifths: 0 };
      if (meta.mode !== undefined) {
        // `meta.mode` 是谱面原文，语料里常写音乐符号 `♭A`——归一成 ASCII 才能往返幂等；原文另存
        song.key.spelling = normalizeSpelling(meta.mode);
        if (song.key.spelling !== meta.mode) song.key.display = meta.mode;
      }
      if (meta.tonic !== undefined && meta.tonic !== "1") song.key.tonicDegree = meta.tonic;
    }
    const [m0, ...mRest] = meta.meters;
    if (m0) song.time = { beats: m0.numerator, beatType: m0.denominator, parenthesized: m0.parenthesized };
    if (mRest.length) {
      song.extraTimes = mRest.map((m) => ({ beats: m.numerator, beatType: m.denominator, parenthesized: m.parenthesized }));
    }
    if (meta.tempos.length) song.tempos = [...meta.tempos];
    if (meta.remarks.length) song.remarks = [...meta.remarks];
    // **所有七项都要看**：只写了 `TR:` 或只写了 `BL:` 的谱（语料里很常见）也得建起 pageText
    if (
      meta.indexLeft !== undefined ||
      meta.indexRight !== undefined ||
      meta.topLeft.length ||
      meta.topRight.length ||
      meta.bottomLeft.length ||
      meta.bottomCenter.length ||
      meta.bottomRight.length
    ) {
      song.pageText = {
        ...(meta.indexLeft !== undefined ? { indexLeft: meta.indexLeft } : {}),
        ...(meta.indexRight !== undefined ? { indexRight: meta.indexRight } : {}),
        topLeft: meta.topLeft,
        topRight: meta.topRight,
        bottomLeft: meta.bottomLeft,
        bottomCenter: meta.bottomCenter,
        bottomRight: meta.bottomRight,
      };
    }
    const raw: { key: string; value: string }[] = [];
    for (const f of meta.fontSizes) raw.push({ key: "FontSize", value: f });
    for (const g of meta.margins) raw.push({ key: "Margin", value: g });
    for (const o of meta.options) raw.push({ key: o.key, value: o.value });
    if (raw.length) song.style = { raw };

    // 声部：同一声部号在各 VoiceGroup（排版行）里的片段要接起来
    const byVoice = new Map<number, { part: Part; carry: Carry; voltas: { open: OpenVolta[] } }>();
    const marks: Mark[] = [];
    const cross = new Map<number, CrossState>();
    let system = 0;
    ps.pages.forEach((page, pageIdx) => {
      page.groups.forEach((group, groupIdx) => {
        group.voices.forEach((line: ScoreLine, voiceIdx) => {
          let pv = byVoice.get(line.voice);
          if (!pv) {
            const part: Part = { id: `P${line.voice}`, measures: [] };
            if (line.caption !== undefined) part.name = line.caption;
            pv = { part, carry: { last: null }, voltas: { open: [] } };
            byVoice.set(line.voice, pv);
          }
          const r = convertLine(line.elements, line.voice, ids, pv.part.measures.length + 1, pv.carry, options.elementIds);
          if (r.measures.length === 0) r.measures.push({ number: String(pv.part.measures.length + 1), elements: [] });
          const lyricLines = attachLyrics(r.anchors, line.lyrics);
          let cs = cross.get(line.voice);
          if (!cs) cross.set(line.voice, (cs = { pending: new Map() }));
          convertMarks(line.marks, r, marks, cs, r.measures, pv.voltas);
          // 行首小节：模型口径「本小节起新系统」（`doc.ts::Print`），附上行这一级的东西
          const first = r.measures[0]!;
          const p: NonNullable<Measure["print"]> = { newSystem: true, system };
          if (groupIdx === 0 && pageIdx > 0) p.newPage = true;
          if (voiceIdx === 0) {
            const texts = group.texts.map((t) => t.text);
            if (texts.length) p.texts = texts;
          }
          if (line.caption !== undefined) p.caption = line.caption;
          if (line.variant !== undefined) p.variant = line.variant;
          if (lyricLines.length) p.lyricLines = lyricLines;
          first.print = p;
          pv.part.measures.push(...r.measures);
        });
        system++;
      });
    });
    song.parts = [...byVoice.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.part);
    // 文本谱每行行尾都换行：123 写出时最后一行也带 `$`
    for (const part of song.parts) part.endBreak = "system";
    for (const part of song.parts) {
      for (let i = 0; i < part.measures.length; i++) part.measures[i]!.number = String(i + 1);
    }
    song.marks = marks;
    doc.songs.push(song);
  }
  return doc;
}
