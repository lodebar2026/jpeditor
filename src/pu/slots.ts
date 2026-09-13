// `ScoreDoc` → **排版行视图**：文本谱排版器、`ScoreDoc → Score`、双向定位共用的那一份铺排。
//
// ## 为什么要有这一层
//
// 文本谱「原样」档不自动断行：一个系统就是一行，行内按符号逐个步进、记号按行内区间画。
// 所以排版必须先把 `ScoreDoc`（声部 → 小节 → 元素，id 配对）**线性化成一行一行的符号流**——
// 这是排版的事，不是模型的事，任何记谱排版器都要做这一步。以前这一步混在文本谱 AST 里
// （`PuDoc` 本身就是扁平流），现在 `ScoreDoc` 是唯一语义模型，线性化规则就收在这里，**只写一次**：
//
// - 行内顺序：夹层（`before`）→ 主音 / 承接前音的增时线 → 各增时线（带各自夹层）→ 有样式的右小节线（带夹层）→ 行末夹层；
//   倚音折进宿主音符；左小节线不出现（它的信息由前一小节右线与房号承载）。
// - 行里每个符号都带 `refs[i]`：它的 `ElementId` 与引用的 `ScoreDoc` 对象。播放高亮、双向定位一律按 id 认。
// - 跨行记号按行切段（续接标记、续行 level）、房号由 `Barline.ending` 还原成行内区间、歌词按行级版式铺回。
//
// 视图里符号的形状沿用 `pu/ast.ts` 的元素类型（排版器与导出的几何代码按这些字段写成，原样复用），
// 但**入口只收 `ScoreDoc`**。`scripts/pu-scoredoc-check.mjs` 用 `scoreDocToPu` 把视图拼回 `PuDoc`，
// 与解析器直出的逐字段比对，证明这份铺排对 全语料文本谱无损。
//
// `dialect` 缺省填 `"shige"` 只是为了让下游取到一份印刷观感的度量（`metricsFor`），
// **不表示 123 是诗歌本方言**。

import type {
  BarlineElement,
  BarlineType,
  LyricLine as PuLyricLine,
  LyricSyllable,
  Mark as PuMark,
  Metadata,
  MusicElement,
  NoteElement,
  Ornament,
  PuDoc,
  PuSong,
  ScoreLine,
  ScorePage,
  SustainElement,
  VoiceGroup,
} from "./ast";
import type { Dialect } from "./dialect";
import { projectForJianpu } from "../model/jianpuproject";
import type {
  Barline,
  Chord,
  ElementId,
  InlineItem,
  LyricLineInfo,
  Mark,
  Measure,
  Part,
  ScoreDoc,
  SourceOrnament,
  Song,
  SourceSpan,
  Space,
  Sustain,
} from "../model/doc";

const ZERO: SourceSpan = { line: 0, column: 0, offset: 0, length: 0 };

/** 小节线样式 + 反复 → `PuDoc` 的 BarlineType。 */
function puBarlineType(b: Barline): BarlineType {
  if (b.repeat === "forward") return "repeat-start";
  if (b.repeat === "backward") return b.alsoForward ? "repeat-both" : "repeat-end";
  switch (b.style) {
    case "none": return b.noWidth ? "hidden" : "invisible";
    case "light-light": return "double";
    case "light-heavy": return "end";
    case "heavy-light": return "double";
    case "dotted": return "hidden";
    default: return "normal";
  }
}

const puOrnaments = (os: readonly SourceOrnament[] | undefined): Ornament[] =>
  (os ?? []).map((o) => ({ name: o.name, level: o.level, source: ZERO }));

/** 和弦上的记号：有原名就照原名（文本谱来源），否则由语义投影推（123 来源）。 */
function chordOrnaments(ch: Chord): Ornament[] {
  if (ch.ornaments) return puOrnaments(ch.ornaments);
  const out: Ornament[] = [];
  if (ch.notations?.fermata) out.push({ name: "yc", level: 0, source: ZERO });
  for (const a of ch.notations?.articulations ?? []) out.push({ name: a, level: 0, source: ZERO });
  return out;
}

/** 一个和弦 → 文本谱音符（主音或倚音）。 */
function noteOf(ch: Chord, graceBefore: NoteElement[]): NoteElement {
  const deg = ch.notes[0]?.degree;
  const beams = ch.beams?.length;
  const n: NoteElement = {
    kind: "note",
    // 节奏音符在 `PuDoc` 里是 pitch 9 + sound "rhythm"（番茄写 `9`、诗歌本写 `X`）
    pitch: (ch.rhythm ? 9 : ch.rest ? 0 : (deg?.number ?? 0)) as NoteElement["pitch"],
    sound: ch.rhythm ? "rhythm" : ch.rest ? "rest" : "note",
    hidden: ch.printObject === false,
    // 倚音不占对位格；123 来源的倚音没有这一位
    lyricAnchor: ch.lyricAnchor ?? (ch.grace ? false : !ch.rest),
    octave: deg?.octaveShift ?? ch.rest?.octaveShift ?? 0,
    // 123 的倚音不记减时线，按八分画
    duration: beams === undefined && ch.grace ? 8 : 4 << (beams ?? 0),
    dots: ch.duration.dots,
    ornaments: chordOrnaments(ch),
    graceBefore,
    graceAfter: [],
    code: "",
    source: ch.source ?? ZERO,
  };
  if (deg?.accidental) n.accidental = deg.accidental;
  if (ch.harmony?.text !== undefined) n.chord = ch.harmony.text;
  if (ch.sectionWord !== undefined) n.annotation = ch.sectionWord;
  return n;
}

function sustainOf(src: {
  harmony?: Chord["harmony"];
  sectionWord?: string;
  ornaments?: SourceOrnament[];
  lyricAnchor?: boolean;
  source?: SourceSpan;
}): SustainElement {
  const s: SustainElement = {
    kind: "sustain",
    duration: 4,
    lyricAnchor: src.lyricAnchor ?? false,
    ornaments: puOrnaments(src.ornaments),
    code: "-",
    source: src.source ?? ZERO,
  };
  if (src.harmony?.text !== undefined) s.chord = src.harmony.text;
  if (src.sectionWord !== undefined) s.annotation = src.sectionWord;
  return s;
}

type Anchor = Chord | Sustain | Space;

/** 行里一个符号的来源。 */
export interface SlotRef {
  /** 元素 id（音符和弦、承接增时线的和弦、增时线、`Space`）；小节线与夹层没有 */
  id?: ElementId;
  chord?: Chord;
  space?: Space;
  sustain?: Sustain;
  barline?: Barline;
  measure: Measure;
}

/** 把一段小节铺成扁平元素流时要带出去的东西。 */
interface RowBuild {
  elements: MusicElement[];
  /** 与 `elements` 平行 */
  refs: SlotRef[];
  /** 元素 id → 行内下标。`PuDoc` 的 Mark 用下标区间配对 */
  indexOf: Map<ElementId, number>;
  /** 参与对位的元素（按顺序），歌词按它铺 */
  anchors: Anchor[];
  /** 小节 → [首元素下标, 末元素下标（含右小节线）] */
  measureSpan: Map<Measure, { first: number; last: number }>;
}

function pushInline(row: RowBuild, items: readonly InlineItem[] | undefined, measure: Measure): void {
  for (const it of items ?? []) {
    row.refs.push({ measure });
    if (it.kind === "boundary") {
      row.elements.push({
        kind: "beat-boundary",
        behavior: it.behavior,
        code: it.behavior === "join" ? "~" : "^",
        source: it.source ?? ZERO,
      });
    } else {
      const sub = buildRow(it.measures);
      row.elements.push({
        kind: "inline-layer",
        role: it.role,
        elements: sub.elements,
        marks: [...segmentMarks(it.marks, [sub], 0), ...rowVoltas([it.measures], [sub])[0]!],
        code: "",
        source: it.source ?? ZERO,
      });
    }
  }
}

function buildRow(measures: readonly Measure[]): RowBuild {
  const row: RowBuild = { elements: [], refs: [], indexOf: new Map(), anchors: [], measureSpan: new Map() };
  for (const mea of measures) {
    const first = row.elements.length;
    // **左小节线不输出为元素**：`PuDoc` 里 barline 元素就是小节分隔，行首再来一根会凭空
    // 多出一个空小节（`toscore.ts` 随即 `measure has no chord` 抛错）。
    // 它携带的信息已由「前一小节的右线」与房号的 volta mark 承载。
    let pendingGrace: NoteElement[] = [];
    let lastNote: NoteElement | null = null;
    for (const el of mea.elements) {
      if (el.kind === "space") {
        // `y`（无时值占位）与 `x`（不可见休止）都落成**隐藏音符**：
        // `PuDoc` 没有无时值占位，`hidden` 的 0 是最接近的东西。
        // `y` 不参与对位（`lyricAnchor: false`），与诗歌本的 `9` 同口径。
        const n: NoteElement = {
          kind: "note",
          pitch: 0,
          sound: "rest",
          hidden: true,
          lyricAnchor: el.spacer === "x",
          octave: 0,
          duration: el.spacer === "x" ? 4 << (el.beams?.length ?? 0) : 4,
          dots: el.duration?.dots ?? 0,
          ornaments: [],
          graceBefore: [],
          graceAfter: [],
          code: el.spacer,
          source: el.source ?? ZERO,
        };
        if (el.harmony?.text) n.chord = el.harmony.text;
        if (pendingGrace.length) {
          n.graceBefore = pendingGrace;
          pendingGrace = [];
        }
        row.indexOf.set(el.id, row.elements.length);
        row.elements.push(n);
        row.refs.push({ id: el.id, space: el, measure: mea });
        if (n.lyricAnchor) row.anchors.push(el);
        continue;
      }
      const ch = el;
      // 倚音：前倚音攒着挂到下一个主音，后倚音挂回刚才那个主音
      if (ch.grace) {
        const g = noteOf(ch, []);
        if (ch.grace.after && lastNote) lastNote.graceAfter.push(g);
        else pendingGrace.push(g);
        continue;
      }
      pushInline(row, ch.before, mea);
      let head: MusicElement;
      if (ch.continued) {
        head = sustainOf({ ...ch, lyricAnchor: ch.lyricAnchor ?? !ch.rest });
      } else {
        head = noteOf(ch, pendingGrace);
        pendingGrace = [];
        lastNote = head;
      }
      row.indexOf.set(ch.id, row.elements.length);
      row.elements.push(head);
      row.refs.push({ id: ch.id, chord: ch, measure: mea });
      if (head.lyricAnchor) row.anchors.push(ch);
      // 增时线展开：`PuDoc` 里它们是独立元素
      for (const su of ch.sustains ?? []) {
        pushInline(row, su.before, mea);
        row.indexOf.set(su.id, row.elements.length);
        const s = sustainOf(su);
        row.elements.push(s);
        row.refs.push({ id: su.id, chord: ch, sustain: su, measure: mea });
        if (s.lyricAnchor) row.anchors.push(su);
      }
    }
    // 只有房号、没有线的「右线」是行末补出来挂 ending 的，原文那里没有小节线
    const right = (mea.barlines ?? []).find((b) => b.location === "right");
    if (right && right.style !== undefined) {
      pushInline(row, right.before, mea);
      row.elements.push(puBar(right));
      row.refs.push({ barline: right, measure: mea });
    }
    pushInline(row, mea.trailing, mea);
    // 跨度只数有归属的符号与小节线（夹层不算），房号的起止偏移以此为基准（`Ending.startOffset/endOffset`）
    let f = -1;
    let l = -1;
    for (let i = first; i < row.elements.length; i++) {
      const ref = row.refs[i]!;
      if (ref.id === undefined && !ref.barline) continue;
      if (f < 0) f = i;
      l = i;
    }
    row.measureSpan.set(mea, f < 0 ? { first, last: Math.max(first, row.elements.length - 1) } : { first: f, last: l });
  }
  return row;
}

function puBar(b: Barline): BarlineElement {
  const e: BarlineElement = {
    kind: "barline",
    type: puBarlineType(b),
    ornaments: b.ornaments ? puOrnaments(b.ornaments) : [],
    code: "|",
    source: b.source ?? ZERO,
  };
  if (!b.ornaments && b.jump) e.ornaments.push({ name: b.jump, level: 0, source: ZERO });
  if (b.time) {
    e.temporaryMeter = {
      numerator: b.time.beats,
      denominator: b.time.beatType,
      parenthesized: b.time.parenthesized ?? false,
    };
  }
  if (b.annotation !== undefined) e.annotation = b.annotation;
  return e;
}

/** 行内的歌词。有 `print.lyricLines`（文本谱来源）就照它的版式还原；否则按段号铺，全空的行不产生。 */
function rowLyrics(row: RowBuild, infos: readonly LyricLineInfo[] | undefined): PuLyricLine[] {
  if (infos) {
    return infos.map((info, lineIdx) => {
      const syllables: LyricSyllable[] = [];
      for (let a = 0; a < Math.min(info.count, row.anchors.length); a++) {
        const hit = (row.anchors[a]!.lyrics ?? []).find(
          (l) =>
            l.number === info.verseFrom &&
            (l.numberTo ?? l.number) === info.verseTo &&
            (l.lineIndex === undefined || l.lineIndex === lineIdx),
        );
        const syl: LyricSyllable = { text: hit?.text ?? "", source: hit?.source ?? ZERO };
        if (hit?.trailingPunctuation) syl.trailingPunctuation = hit.trailingPunctuation;
        syllables.push(syl);
      }
      const line: PuLyricLine = {
        verseFrom: info.verseFrom,
        verseTo: info.verseTo,
        annotationGap: info.annotationGap,
        syllables,
        source: ZERO,
      };
      if (info.annotation !== undefined) line.annotation = info.annotation;
      if (info.joinBrace) line.joinBrace = true;
      return line;
    });
  }
  const verses = new Set<number>();
  for (const a of row.anchors) {
    for (const l of a.lyrics ?? []) {
      for (let v = l.number; v <= (l.numberTo ?? l.number); v++) verses.add(v);
    }
  }
  const out: PuLyricLine[] = [];
  for (const v of [...verses].sort((a, b) => a - b)) {
    const syllables: LyricSyllable[] = [];
    let label: string | undefined;
    for (const a of row.anchors) {
      const hit = (a.lyrics ?? []).find((l) => v >= l.number && v <= (l.numberTo ?? l.number));
      if (hit?.verseLabel !== undefined) label = hit.verseLabel;
      const syl: LyricSyllable = { text: hit?.text ?? "", source: hit?.source ?? ZERO };
      if (hit?.trailingPunctuation) syl.trailingPunctuation = hit.trailingPunctuation;
      syllables.push(syl);
    }
    // 全空就不产生这一行
    if (!syllables.some((s) => s.text !== "")) continue;
    const line: PuLyricLine = { verseFrom: v, verseTo: v, annotationGap: 20, syllables, source: ZERO };
    if (label !== undefined) line.annotation = label;
    out.push(line);
  }
  return out;
}

/** Mark：id 配对 → 第 `rowIdx` 行的下标区间。跨行的截断在行边界、打上续接标记，
 *  续行那一段的 level 取 `continuationLevels`。 */
function segmentMarks(marks: readonly Mark[], rows: readonly RowBuild[], rowIdx: number): PuMark[] {
  const row = rows[rowIdx]!;
  const rowOf = (id: ElementId): number => rows.findIndex((r) => r.indexOf.has(id));
  const out: PuMark[] = [];
  for (const m of marks) {
    // tie 在简谱里与圆滑线同形，归 slur；pedal/octaveShift/lyricExtend 没有对应物
    const type: PuMark["type"] | null =
      m.type === "slur" || m.type === "tied" ? "slur"
        : m.type === "tuplet" ? "tuplet"
          : m.type === "wedge" ? (m.wedgeType === "diminuendo" ? "decrescendo" : "crescendo")
            : null;
    if (type === null) continue;
    // 起点写在上一行行尾的：上一行补一段空的起头
    if (m.leadInPreviousLine && rows[rowIdx + 1]?.indexOf.has(m.start)) {
      out.push({
        type, start: row.elements.length - (m.leadBack ?? 0), end: Math.max(0, row.elements.length - 1),
        level: m.level ?? 0, source: ZERO, continuationToNext: true,
      });
      continue;
    }
    const a = row.indexOf.get(m.start);
    const b = row.indexOf.get(m.end);
    const startRow = a !== undefined ? rowIdx : rowOf(m.start);
    const endRow = b !== undefined ? rowIdx : rowOf(m.end);
    if (a === undefined && b === undefined) {
      // 两端都不在本行：只有跨过本行的才画（中间整行都在弧下）
      if (startRow < 0 || endRow < 0 || rowIdx < startRow || rowIdx > endRow) continue;
    }
    if (m.collapsed) {
      if (a !== undefined) out.push({ type, start: a + 1, end: a, level: m.level ?? 0, source: ZERO });
      continue;
    }
    const seg = (startRow >= 0 ? rowIdx - startRow : 0) + (m.leadInPreviousLine ? 1 : 0);
    const pm: PuMark = {
      type,
      start: a !== undefined ? a - (m.startLead ?? 0) : 0,
      end: b !== undefined ? b + (m.endTrail ?? 0) : Math.max(0, row.elements.length - 1),
      level: seg === 0 ? (m.level ?? 0) : (m.continuationLevels?.[seg - 1] ?? m.level ?? 0),
      source: ZERO,
    };
    if (a === undefined || m.continuesFromPrevious || (m.leadInPreviousLine && seg === 1)) pm.continuationFromPrevious = true;
    if (b === undefined) pm.continuationToNext = true;
    if (m.tupletActual !== undefined) pm.caption = String(m.tupletActual);
    out.push(pm);
  }
  return out;
}

const captionOfEnding = (e: NonNullable<Barline["ending"]>): string | undefined =>
  e.captionless ? undefined : (e.text ?? e.numbers.join("."));

/** 房号：`Barline.ending` → Mark volta（`PuDoc` 的排版器靠它画跳房子）。跨行的拆成各行一段。 */
function rowVoltas(measuresByRow: readonly (readonly Measure[])[], rows: readonly RowBuild[]): PuMark[][] {
  const out: PuMark[][] = rows.map(() => []);
  interface Open {
    ending: NonNullable<Barline["ending"]>;
    startRow: number;
    start: number;
    fromPrev: boolean;
  }
  /** 开着的房号。一般至多一个；文本谱解析器会留下跨行不收口的、与后面的重叠 */
  let open: Open[] = [];
  const levelOf = (o: Open, r: number): number => {
    const seg = r - o.startRow;
    return seg === 0 ? (o.ending.level ?? 0) : (o.ending.continuationLevels?.[seg - 1] ?? 0);
  };
  const mark = (o: Open, r: number, end: number): PuMark => {
    const pm: PuMark = { type: "volta", start: o.start, end, level: levelOf(o, r), source: ZERO };
    const caption = captionOfEnding(o.ending);
    if (caption !== undefined) pm.caption = caption;
    if (o.fromPrev) pm.continuationFromPrevious = true;
    return pm;
  };
  measuresByRow.forEach((measures, r) => {
    const row = rows[r]!;
    open = open.map((o) => ({ ...o, start: 0, fromPrev: true }));
    for (const mea of measures) {
      const span = row.measureSpan.get(mea)!;
      for (const b of mea.barlines ?? []) {
        if (b.location !== "left" || b.ending?.type !== "start") continue;
        const e = b.ending;
        const caption = captionOfEnding(e);
        if (e.collapsed) {
          const pm: PuMark = { type: "volta", start: span.first, end: span.first - 1, level: e.level ?? 0, source: ZERO };
          if (caption !== undefined) pm.caption = caption;
          out[r]!.push(pm);
          continue;
        }
        if (e.leadInPreviousLine && r > 0) {
          const prev = rows[r - 1]!;
          const pm: PuMark = {
            type: "volta", start: prev.elements.length, end: Math.max(0, prev.elements.length - 1),
            level: e.level ?? 0, source: ZERO, continuationToNext: true,
          };
          if (caption !== undefined) pm.caption = caption;
          out[r - 1]!.push(pm);
          open.push({ ending: e, startRow: r - 1, start: 0, fromPrev: true });
          continue;
        }
        open.push({ ending: e, startRow: r, start: span.first + (e.startOffset ?? 0), fromPrev: false });
      }
      for (const right of mea.barlines ?? []) {
        if (right.location === "right" && right.ending?.danglingLead) {
          const pm: PuMark = {
            type: "volta", start: row.elements.length, end: Math.max(0, row.elements.length - 1),
            level: right.ending.level ?? 0, source: ZERO, continuationToNext: true,
          };
          const caption = captionOfEnding(right.ending);
          if (caption !== undefined) pm.caption = caption;
          out[r]!.push(pm);
          continue;
        }
        if (right.location !== "right" || !right.ending || right.ending.type === "start" || !open.length) continue;
        const stop = right.ending;
        // 有配对号按号收，否则收最近开的那个
        let k = stop.pair !== undefined ? open.findIndex((o) => o.ending.pair === stop.pair) : -1;
        if (k < 0) k = open.length - 1;
        const o = open[k]!;
        const pm = mark(o, r, span.last + (stop.endOffset ?? 0));
        if (stop.type === "discontinue") pm.openEnd = true;
        out[r]!.push(pm);
        open.splice(k, 1);
      }
    }
    for (const o of open) out[r]!.push({ ...mark(o, r, Math.max(0, row.elements.length - 1)), continuationToNext: true });
  });
  return out;
}

function toMetadata(song: Song): Metadata {
  const meta: Metadata = {
    titles: [],
    authors: [],
    remarks: [],
    meters: [],
    tempos: [],
    topLeft: [],
    topRight: [],
    bottomLeft: [],
    bottomCenter: [],
    bottomRight: [],
    fontSizes: [],
    margins: [],
    options: [],
  };
  if (song.work.title !== undefined) meta.titles.push(song.work.title);
  meta.titles.push(...song.work.subtitles);
  if (song.work.version !== undefined) meta.version = song.work.version;
  for (const c of song.identification?.creators ?? []) meta.authors.push(c.text);
  if (song.key) {
    if (song.key.display !== undefined) meta.mode = song.key.display;
    else if (song.key.spelling && song.key.spelling !== "none") meta.mode = song.key.spelling;
    if (song.key.tonicDegree && song.key.tonicDegree !== "1") meta.tonic = song.key.tonicDegree;
  }
  for (const t of [song.time, ...(song.extraTimes ?? [])]) {
    if (!t) continue;
    meta.meters.push({ numerator: t.beats, denominator: t.beatType, parenthesized: t.parenthesized ?? false });
  }
  for (const t of song.tempos ?? []) meta.tempos.push(t);
  meta.remarks.push(...(song.remarks ?? []));
  const pt = song.pageText;
  if (pt) {
    if (pt.indexLeft !== undefined) meta.indexLeft = pt.indexLeft;
    if (pt.indexRight !== undefined) meta.indexRight = pt.indexRight;
    meta.topLeft.push(...pt.topLeft);
    meta.topRight.push(...pt.topRight);
    meta.bottomLeft.push(...pt.bottomLeft);
    meta.bottomCenter.push(...pt.bottomCenter);
    meta.bottomRight.push(...pt.bottomRight);
  }
  // 文档内样式指令原文（`FontSize:` / `Margin:` / 其它）交给 metrics 解释
  for (const r of song.style?.raw ?? []) {
    if (/^fontsize$/i.test(r.key)) meta.fontSizes.push(r.value);
    else if (/^margin$/i.test(r.key)) meta.margins.push(r.value);
    else meta.options.push({ key: r.key, value: r.value });
  }
  return meta;
}

interface SystemRow {
  /** `print.system`（文本谱来源才有） */
  system: number | undefined;
  measures: Measure[];
}

/** 一个声部按系统切开（模型口径：带 `print` 的小节**起**新系统，见 `doc.ts::Print`）。 */
function splitSystems(part: Part): SystemRow[] {
  const rows: SystemRow[] = [];
  let cur: Measure[] = [];
  let sys: number | undefined;
  for (const m of part.measures) {
    if (m.print?.newSystem || m.print?.newPage) {
      if (cur.length) rows.push({ system: sys, measures: cur });
      cur = [];
      sys = m.print.system;
    }
    cur.push(m);
  }
  if (cur.length) rows.push({ system: sys, measures: cur });
  return rows.length ? rows : [{ system: undefined, measures: [] }];
}

/** 一行（一个声部在一个系统里的那一段）。形状同 `ScoreLine`，另带来源。 */
export interface RowView extends ScoreLine {
  part: Part;
  measures: Measure[];
  /** 与 `elements` 平行 */
  refs: SlotRef[];
}

export interface SystemView extends VoiceGroup {
  /** 全曲第几个系统 */
  system: number;
  voices: RowView[];
}

export interface PageView extends ScorePage {
  groups: SystemView[];
}

export interface SongView extends PuSong {
  song: Song;
  pages: PageView[];
}

export interface DocView {
  dialect: Dialect;
  doc: ScoreDoc;
  songs: SongView[];
  /** 行里的符号 → 它的 id（高亮、定位用） */
  idOf: Map<MusicElement, ElementId>;
  /** id → 行里的符号（一个 id 只对应一个符号） */
  elementOf: Map<ElementId, MusicElement>;
  /** 歌词音节 → 它跟的那个符号的 id */
  syllableOwner: Map<LyricSyllable, ElementId>;
}

function toPuSong(song: Song, index: number): SongView {
  const perPart = song.parts.map((p) => splitSystems(p));
  /** 文本谱来源：一组不一定含全部声部，按 `print.system` 对回同一组；其余按行序号 */
  const bySystem = perPart.some((rows) => rows.some((r) => r.system !== undefined));
  const voiceOf = (pi: number): number => {
    const m = bySystem ? /^P(\d+)$/.exec(song.parts[pi]!.id) : null;
    return m ? Number(m[1]) : pi + 1;
  };
  // 各声部的全部行先建好——跨行记号要看别的行有没有端点
  const builds = perPart.map((rows) => rows.map((row) => buildRow(row.measures)));
  const voltas = perPart.map((rows, pi) => rowVoltas(rows.map((r) => r.measures), builds[pi]!));

  const systems = new Map<number, { pi: number; r: number }[]>();
  perPart.forEach((rows, pi) => {
    rows.forEach((row, r) => {
      const key = bySystem ? (row.system ?? r) : r;
      let list = systems.get(key);
      if (!list) systems.set(key, (list = []));
      list.push({ pi, r });
    });
  });

  const pages: PageView[] = [];
  let page: PageView = { index: 0, groups: [] };
  for (const key of [...systems.keys()].sort((a, b) => a - b)) {
    const voices: RowView[] = [];
    let texts: string[] = [];
    let newPage = false;
    for (const { pi, r } of systems.get(key)!) {
      const part = song.parts[pi]!;
      const build = builds[pi]![r]!;
      const p = perPart[pi]![r]!.measures[0]?.print;
      if (bySystem && p?.newPage) newPage = true;
      if (p?.texts) texts = p.texts;
      const line: RowView = {
        part,
        measures: perPart[pi]![r]!.measures,
        refs: build.refs,
        voice: voiceOf(pi),
        elements: build.elements,
        marks: [...segmentMarks(song.marks, builds[pi]!, r), ...voltas[pi]![r]!],
        lyrics: rowLyrics(build, p?.lyricLines),
        raw: "",
        source: ZERO,
      };
      const caption = bySystem ? p?.caption : part.name;
      if (caption !== undefined) line.caption = caption;
      if (p?.variant !== undefined) line.variant = p.variant;
      voices.push(line);
    }
    if (newPage && page.groups.length) {
      pages.push(page);
      page = { index: pages.length, groups: [] };
    }
    page.groups.push({
      index: page.groups.length,
      system: key,
      texts: texts.map((t) => ({ text: t, source: ZERO })),
      voices,
    });
  }
  pages.push(page);
  return { index, song, metadata: toMetadata(song), pages };
}

const views = new WeakMap<ScoreDoc, DocView>();

/** 一份 `ScoreDoc` 的排版行视图。**同一份文档只建一次**：排版器、`scoreDocToScore`、双向定位拿到的是同一批对象。 */
export function docView(doc: ScoreDoc): DocView {
  const hit = views.get(doc);
  if (hit) return hit;
  const view: DocView = {
    dialect: (doc.puDialect ?? "shige") as Dialect,
    doc,
    // MusicXML 读进来的先投成简谱形状（长音拆增时线、减时线按 `<type>` 算、和弦补原文）
    songs: doc.songs.map((s, i) => toPuSong(projectForJianpu(s), i)),
    idOf: new Map(),
    elementOf: new Map(),
    syllableOwner: new Map(),
  };
  for (const sv of view.songs) {
    for (const pg of sv.pages) {
      for (const g of pg.groups) {
        for (const row of g.voices) {
          row.elements.forEach((el, i) => {
            const id = row.refs[i]!.id;
            if (id === undefined) return;
            view.idOf.set(el, id);
            if (!view.elementOf.has(id)) view.elementOf.set(id, el);
          });
          const anchors = row.elements.filter((el) => (el.kind === "note" || el.kind === "sustain") && el.lyricAnchor);
          for (const line of row.lyrics) {
            line.syllables.forEach((syl, k) => {
              const owner = anchors[k] && view.idOf.get(anchors[k]!);
              if (owner !== undefined) view.syllableOwner.set(syl, owner);
            });
          }
        }
      }
    }
  }
  views.set(doc, view);
  return view;
}

/** 视图拼回 `PuDoc`。**只给校验脚本用**（`scripts/pu-scoredoc-check.mjs`），产品代码一律用 `docView`。 */
export function scoreDocToPu(doc: ScoreDoc): PuDoc {
  const v = docView(doc);
  return { dialect: v.dialect, source: doc.source ?? "", songs: v.songs, diagnostics: doc.diagnostics };
}
