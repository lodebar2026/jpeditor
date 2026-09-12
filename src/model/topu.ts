// `ScoreDoc` → `PuDoc`：**临时桥**。
//
// ## 它为什么存在
//
// 123 需要排版、MusicXML 导出、MIDI、按乐句重排，而这些现成实现全都吃 `PuDoc`
// （`pu/painter.ts` 排版、`pu/toxml.ts` 无损导出 MusicXML、`pu/toscore.ts` → `Score` → MIDI）。
// 与其为 123 重写一遍，先转成 `PuDoc` 借用——这是本轮不重写下游的唯一办法。
//
// ## 它什么时候删
//
// R2 收尾时把 `PuPainter` / `toxml` / `toscore` 直接改吃 `ScoreDoc`，然后删掉本文件。
// 在此之前**不要往这里加功能**——加功能意味着把 `PuDoc` 的寿命延长。
//
// ## 已知有损（转过去就丢，所以这几样只在 `ScoreDoc` 与 `.123` 里活着）
//
// - `playOrder` 的 **skip/limit**（音符级端点）：`PuDoc` 没有这个概念，`Score.RepeatSpec` 才有
// - **曲号** `X:`：`Metadata` 没有这个字段
// - **样式引用** `I:style`：`Metadata.options` 只能存原文，语义归样式层
// - 五线谱侧的一切（`clef` / `staves` / `transpose` / `pedal` / `partGroups` / `defaults`）
//
// `dialect` 填 `"shige"` 只是为了让下游取到一份印刷观感的度量（`metricsFor`），
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
  PuDoc,
  PuSong,
  ScoreLine,
  ScorePage,
  SustainElement,
  VoiceGroup,
} from "../pu/ast";
import type {
  Barline,
  Chord,
  Element,
  ElementId,
  Lyric,
  Measure,
  Part,
  ScoreDoc,
  Song,
  SourceSpan,
} from "./doc";

const ZERO: SourceSpan = { line: 0, column: 0, offset: 0, length: 0 };

/** 小节线样式 + 反复 → `PuDoc` 的 BarlineType。 */
function puBarlineType(b: Barline): BarlineType {
  if (b.repeat === "forward") return "repeat-start";
  if (b.repeat === "backward") return "repeat-end";
  switch (b.style) {
    case "none": return "invisible";
    case "light-light": return "double";
    case "light-heavy": return "end";
    case "heavy-light": return "double";
    case "dotted": return "hidden";
    default: return "normal";
  }
}

/** 时值：`ScoreDoc` 用 divisions，`PuDoc` 用**分母**（4=四分、8=八分）。
 *  由减时线层数直接算，比从 divisions 反推可靠——divisions 里已经并进了增时线。 */
function puDuration(ch: Chord): number {
  return 4 << (ch.beams?.length ?? 0);
}

/** 一个 `ScoreDoc` 元素 → 若干 `PuDoc` 元素（增时线要展开成独立的 SustainElement）。 */
function toPuElements(el: Element): MusicElement[] {
  const out: MusicElement[] = [];
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
    out.push(n);
    return out;
  }

  const ch = el;
  const note = ch.notes[0];
  const deg = note?.degree;
  const n: NoteElement = {
    kind: "note",
    // 节奏音符在 `PuDoc` 里是 pitch 9 + sound "rhythm"（番茄写 `9`、诗歌本写 `X`）
    pitch: (ch.rhythm ? 9 : ch.rest ? 0 : (deg?.number ?? 0)) as NoteElement["pitch"],
    sound: ch.rhythm ? "rhythm" : ch.rest ? "rest" : "note",
    hidden: ch.printObject === false,
    lyricAnchor: !ch.rest,
    octave: deg?.octaveShift ?? 0,
    duration: puDuration(ch),
    dots: ch.duration.dots,
    ornaments: [],
    graceBefore: (ch.grace ? [] : graceOf(ch)),
    graceAfter: [],
    code: "",
    source: ch.source ?? ZERO,
  };
  if (deg?.accidental) n.accidental = deg.accidental;
  if (ch.harmony?.text) n.chord = ch.harmony.text;
  if (ch.notations?.fermata) n.ornaments.push({ name: "yc", level: 0, source: ZERO });
  for (const a of ch.notations?.articulations ?? []) {
    n.ornaments.push({ name: a, level: 0, source: ZERO });
  }
  out.push(n);

  // 增时线展开：`PuDoc` 里它们是独立元素
  for (const su of ch.sustains ?? []) {
    const s: SustainElement = {
      kind: "sustain",
      duration: 4,
      lyricAnchor: false,
      ornaments: [],
      code: "-",
      source: su.source ?? ZERO,
    };
    if (su.harmony?.text) s.chord = su.harmony.text;
    out.push(s);
  }
  return out;
}

/** 倚音：`ScoreDoc` 把倚音做成独立的 `grace` 和弦，`PuDoc` 挂在主音符的 `graceBefore` 上。
 *  这里只处理「紧跟在倚音之后的那个音符」，由调用方先把倚音摘出来。 */
function graceOf(_ch: Chord): NoteElement[] {
  return [];
}

/** 按 `print.newSystem` / `newPage` 把一个声部的小节切成排版行。 */
function splitSystems(part: Part): Measure[][] {
  const rows: Measure[][] = [];
  let cur: Measure[] = [];
  for (const m of part.measures) {
    cur.push(m);
    if (m.print?.newSystem || m.print?.newPage) {
      rows.push(cur);
      cur = [];
    }
  }
  if (cur.length) rows.push(cur);
  return rows.length ? rows : [[]];
}

interface RowBuild {
  elements: MusicElement[];
  /** 元素 id → 行内下标。`PuDoc` 的 Mark 用下标区间配对 */
  indexOf: Map<ElementId, number>;
  /** 参与对位的元素下标（按顺序），歌词按它铺 */
  anchors: number[];
  /** 挂在各锚点上的歌词（按段号） */
  lyricsAt: Map<number, Lyric[]>;
  /** 房号区间：`PuDoc` 用 Mark volta 表达，而 `ScoreDoc` 用 `Barline.ending`（MusicXML 口径），
   *  这里按行收集起止下标 */
  voltas: { numbers: number[]; start: number; end: number }[];
}

function buildRow(measures: readonly Measure[]): RowBuild {
  const row: RowBuild = { elements: [], indexOf: new Map(), anchors: [], lyricsAt: new Map(), voltas: [] };
  /** 开着的房号：遇到 ending stop 或行尾时收 */
  let openVolta: { numbers: number[]; start: number } | null = null;
  for (const mea of measures) {
    const left = (mea.barlines ?? []).find((b) => b.location === "left");
    // **左小节线不输出为元素**：`PuDoc` 里 barline 元素就是小节分隔，行首再来一根会凭空
    // 多出一个空小节（`toscore.ts` 随即 `measure has no chord` 抛错）。
    // 它携带的信息已由「前一小节的右线」与房号的 volta mark 承载。
    if (left?.ending?.type === "start") {
      openVolta = { numbers: left.ending.numbers, start: row.elements.length };
    }
    let pendingGrace: NoteElement[] = [];
    for (const el of mea.elements) {
      // 倚音先攒着，挂到下一个实音符的 graceBefore
      if (el.kind === "chord" && el.grace) {
        for (const gn of el.notes) {
          pendingGrace.push({
            kind: "note",
            pitch: (gn.degree?.number ?? 1) as NoteElement["pitch"],
            sound: "note",
            hidden: false,
            lyricAnchor: false,
            octave: gn.degree?.octaveShift ?? 0,
            duration: 8,
            dots: 0,
            ornaments: [],
            graceBefore: [],
            graceAfter: [],
            code: "",
            source: el.source ?? ZERO,
          });
        }
        continue;
      }
      const made = toPuElements(el);
      if (pendingGrace.length && made[0]?.kind === "note") {
        (made[0] as NoteElement).graceBefore = pendingGrace;
        pendingGrace = [];
      }
      for (let k = 0; k < made.length; k++) {
        const idx = row.elements.length;
        row.elements.push(made[k]!);
        if (k === 0) row.indexOf.set(el.id, idx);
        const m = made[k]!;
        if ((m.kind === "note" || m.kind === "sustain") && m.lyricAnchor) {
          row.anchors.push(idx);
          if (k === 0 && el.lyrics?.length) row.lyricsAt.set(row.anchors.length - 1, el.lyrics);
        }
      }
      // 增时线的 id 也要能被 Mark 引用
      if (el.kind === "chord") {
        let off = 1;
        for (const su of el.sustains ?? []) {
          row.indexOf.set(su.id, row.elements.length - (el.sustains!.length - off));
          off++;
        }
      }
    }
    const right = (mea.barlines ?? []).find((b) => b.location === "right");
    if (right) row.elements.push(puBar(right));
    if (right?.ending?.type === "stop" && openVolta) {
      row.voltas.push({ numbers: openVolta.numbers, start: openVolta.start, end: row.elements.length - 1 });
      openVolta = null;
    }
  }
  if (openVolta) {
    row.voltas.push({ numbers: openVolta.numbers, start: openVolta.start, end: row.elements.length - 1 });
  }
  return row;
}

function puBar(b: Barline): BarlineElement {
  const e: BarlineElement = {
    kind: "barline",
    type: puBarlineType(b),
    ornaments: [],
    code: "|",
    source: b.source ?? ZERO,
  };
  if (b.jump) e.ornaments.push({ name: b.jump, level: 0, source: ZERO });
  return e;
}

/** 行内的歌词：按段号铺成 `LyricLine`。空锚点填空串（`PuDoc` 用空串表示「跳过一个音符」）。 */
function rowLyrics(row: RowBuild): PuLyricLine[] {
  const verses = new Set<number>();
  for (const ls of row.lyricsAt.values()) {
    for (const l of ls) {
      for (let v = l.number; v <= (l.numberTo ?? l.number); v++) verses.add(v);
    }
  }
  const out: PuLyricLine[] = [];
  for (const v of [...verses].sort((a, b) => a - b)) {
    const syllables: LyricSyllable[] = [];
    let label: string | undefined;
    for (let a = 0; a < row.anchors.length; a++) {
      const ls = row.lyricsAt.get(a) ?? [];
      const hit = ls.find((l) => v >= l.number && v <= (l.numberTo ?? l.number));
      if (hit?.verseLabel !== undefined) label = hit.verseLabel;
      const syl: LyricSyllable = { text: hit?.text ?? "", source: hit?.source ?? ZERO };
      if (hit?.trailingPunctuation) syl.trailingPunctuation = hit.trailingPunctuation;
      syllables.push(syl);
    }
    // 全空就不产生这一行
    if (!syllables.some((s) => s.text !== "")) continue;
    const line: PuLyricLine = {
      verseFrom: v,
      verseTo: v,
      annotationGap: 20,
      syllables,
      source: ZERO,
    };
    if (label !== undefined) line.annotation = label;
    out.push(line);
  }
  return out;
}

/** Mark：id 配对 → 行内下标区间。跨行的 Mark 截断在行边界，并打上续接标记。 */
function rowMarks(song: Song, rows: readonly RowBuild[], rowIdx: number): PuMark[] {
  const row = rows[rowIdx]!;
  const out: PuMark[] = [];
  for (const m of song.marks) {
    const a = row.indexOf.get(m.start);
    const b = row.indexOf.get(m.end);
    if (a === undefined && b === undefined) continue;
    // `PuDoc` 的 MarkType 只有 slur/tuplet/crescendo/decrescendo/volta。
    // tie 在简谱里与圆滑线同形，归 slur；wedge/pedal/octaveShift/lyricExtend 没有对应物——
    // 渐强渐弱在 `ScoreDoc` 里是 `Direction`（MusicXML 口径），本轮不转。
    const type: PuMark["type"] | null =
      m.type === "slur" || m.type === "tied" ? "slur" : m.type === "tuplet" ? "tuplet" : null;
    if (type === null) continue;
    const pm: PuMark = {
      type,
      start: a ?? 0,
      end: b ?? row.elements.length - 1,
      level: m.level ?? 0,
      source: ZERO,
    };
    if (a === undefined) pm.continuationFromPrevious = true;
    if (b === undefined) pm.continuationToNext = true;
    if (m.tupletActual) pm.caption = String(m.tupletActual);
    out.push(pm);
  }
  // 房号：`Barline.ending` → Mark volta（`PuDoc` 的排版器靠它画跳房子）
  for (const v of row.voltas) {
    out.push({
      type: "volta",
      start: v.start,
      end: v.end,
      level: 0,
      caption: v.numbers.join("."),
      source: ZERO,
    });
  }
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
  for (const c of song.identification?.creators ?? []) meta.authors.push(c.text);
  if (song.key) {
    if (song.key.spelling && song.key.spelling !== "none") meta.mode = song.key.spelling;
    if (song.key.tonicDegree && song.key.tonicDegree !== "1") meta.tonic = song.key.tonicDegree;
  }
  if (song.time) {
    meta.meters.push({
      numerator: song.time.beats,
      denominator: song.time.beatType,
      parenthesized: song.time.parenthesized ?? false,
    });
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

function toPuSong(song: Song, index: number): PuSong {
  // 各声部按系统行切开，第 i 行的各声部组成一个 VoiceGroup（同时发声、上下堆叠）
  const perPart = song.parts.map((p) => splitSystems(p));
  const rowCount = Math.max(1, ...perPart.map((r) => r.length));
  const groups: VoiceGroup[] = [];
  for (let r = 0; r < rowCount; r++) {
    const builds: RowBuild[] = [];
    const voices: ScoreLine[] = [];
    for (let pi = 0; pi < song.parts.length; pi++) {
      const measures = perPart[pi]![r];
      if (!measures) continue;
      const build = buildRow(measures);
      builds.push(build);
      const line: ScoreLine = {
        voice: pi + 1,
        elements: build.elements,
        marks: [],
        lyrics: rowLyrics(build),
        raw: "",
        source: ZERO,
      };
      const name = song.parts[pi]!.name;
      if (name !== undefined) line.caption = name;
      voices.push(line);
    }
    // Mark 要在所有行建完之后再填（跨行续接要看别的行有没有端点）
    for (let k = 0; k < voices.length; k++) {
      voices[k]!.marks = rowMarks(song, builds, k);
    }
    groups.push({ index: r, texts: [], voices });
  }
  const pages: ScorePage[] = [{ index: 0, groups }];
  return { index, metadata: toMetadata(song), pages };
}

/** `ScoreDoc` → `PuDoc`。见文件头的「已知有损」。 */
export function scoreDocToPu(doc: ScoreDoc): PuDoc {
  return {
    dialect: "shige",
    source: doc.source ?? "",
    songs: doc.songs.map(toPuSong),
    diagnostics: doc.diagnostics,
  };
}
