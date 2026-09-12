// `PuDoc` → `ScoreDoc`：把文本谱语料迁进 123。
//
// 与 `topu.ts` 互逆，但**两者都是过渡件**：R2 收尾后文本谱解析器直接产 `ScoreDoc`，
// 这个文件随 `PuDoc` 一起退役。
//
// 转换的难点是结构差异：`PuDoc` 是**扁平元素流 + 下标区间配对**，`ScoreDoc` 是
// **小节层级 + id 配对**。所以要先按 barline 切小节，同时建「下标 → 元素 id」的映射，
// 再把 Mark 的下标区间翻成 id。**映射一次建好，不要边转边算**。

import type {
  LyricLine as PuLyricLine,
  MusicElement,
  NoteElement,
  PuDoc,
  ScoreLine,
} from "../pu/ast";
import type {
  Barline,
  BeamVal,
  Chord,
  Element,
  ElementId,
  Lyric,
  Mark,
  Measure,
  Part,
  ScoreDoc,
  Song,
  Sustain,
} from "./doc";
import { IdGen, emptyDoc, emptySong } from "./helpers";

/** `PuDoc` 的 BarlineType → `ScoreDoc` 的 bar-style + repeat。 */
function fromPuBarline(type: string): Barline {
  const b: Barline = { location: "right" };
  switch (type) {
    case "end": b.style = "light-heavy"; break;
    case "double": b.style = "light-light"; break;
    case "repeat-start": b.style = "heavy-light"; b.repeat = "forward"; break;
    case "repeat-end": b.style = "light-heavy"; b.repeat = "backward"; break;
    case "repeat-both": b.style = "light-heavy"; b.repeat = "backward"; break;
    case "hidden": b.style = "dotted"; break;
    case "invisible": b.style = "none"; break;
    default: b.style = "regular"; break;
  }
  return b;
}

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

interface LineResult {
  measures: Measure[];
  /** 元素流下标 → `ScoreDoc` 元素 id（Mark 的区间靠它翻译） */
  idAt: Map<number, ElementId>;
  /** 参与对位的元素（按顺序），歌词按它铺回去 */
  anchors: Element[];
}

/** 一行曲 → 小节数组。 */
function convertLine(line: ScoreLine, ids: IdGen, startMeasureNo: number): LineResult {
  const measures: Measure[] = [];
  const idAt = new Map<number, ElementId>();
  const anchors: Element[] = [];
  let mea: Measure = { number: String(startMeasureNo), elements: [] };
  let lastChord: Chord | null = null;

  const flush = (bar?: Barline): void => {
    if (bar) (mea.barlines ??= []).push(bar);
    if (mea.elements.length || mea.barlines?.length) measures.push(mea);
    mea = { number: String(startMeasureNo + measures.length), elements: [] };
    lastChord = null;
  };

  for (let i = 0; i < line.elements.length; i++) {
    const el: MusicElement = line.elements[i]!;
    switch (el.kind) {
      case "barline":
        flush(fromPuBarline(el.type));
        break;

      case "sustain": {
        if (!lastChord) break;
        const su: Sustain = { id: ids.next() };
        if (el.chord) su.harmony = { root: { step: "C", alter: 0 }, kind: "", text: el.chord };
        if (el.source) su.source = el.source;
        (lastChord.sustains ??= []).push(su);
        lastChord.duration = durationFrom(
          4 << (lastChord.beams?.length ?? 0),
          lastChord.duration.dots,
          lastChord.sustains.length,
        );
        idAt.set(i, su.id);
        if (el.lyricAnchor) anchors.push(lastChord);
        break;
      }

      case "note": {
        const n = el as NoteElement;
        const beams = beamsOf(n.duration);
        const ch: Chord = {
          kind: "chord",
          id: ids.next(),
          notes: [],
          duration: durationFrom(n.duration, n.dots, 0),
          voice: line.voice,
          staff: 1,
          source: n.source,
        };
        if (n.pitch === 0) {
          ch.rest = {};
          // 隐藏休止：`PuDoc` 用 hidden 标记，`ScoreDoc` 用 printObject=false
          if (n.hidden) ch.printObject = false;
        } else {
          const note: { degree: { number: number; octaveShift: number; accidental?: NoteElement["accidental"] } } = {
            degree: { number: n.pitch, octaveShift: n.octave },
          };
          if (n.accidental) note.degree.accidental = n.accidental;
          ch.notes.push(note as Chord["notes"][number]);
        }
        if (beams > 0) ch.beams = Array.from({ length: beams }, () => "continue" as BeamVal);
        if (n.chord) ch.harmony = { root: { step: "C", alter: 0 }, kind: "", text: n.chord };
        const fermata = n.ornaments.some((o) => /^(yc|fermata)$/i.test(o.name));
        const arts = n.ornaments.filter((o) => !/^(yc|fermata)$/i.test(o.name)).map((o) => o.name);
        if (fermata || arts.length) {
          ch.notations = { ...(fermata ? { fermata: true } : {}), ...(arts.length ? { articulations: arts } : {}) };
        }
        // 倚音：`PuDoc` 挂在主音符上，`ScoreDoc` 是独立的 grace 元素，放在主音符之前
        for (const g of n.graceBefore) {
          mea.elements.push({
            kind: "chord",
            id: ids.next(),
            notes: [{ degree: { number: g.pitch === 0 ? 1 : g.pitch, octaveShift: g.octave } }],
            duration: { divisions: 0, dots: 0 },
            grace: {},
            voice: line.voice,
            staff: 1,
            source: g.source,
          });
        }
        mea.elements.push(ch);
        idAt.set(i, ch.id);
        lastChord = ch;
        if (n.lyricAnchor) anchors.push(ch);
        break;
      }

      default:
        // beat-boundary（`~`/`^`）在 123 里由**空白分组**表达，不进模型；
        // inline-layer（`{bz}`/`{dsb}`）本轮不转，由迁移报表记为「无法表达」
        break;
    }
  }
  flush();
  return { measures, idAt, anchors };
}

/** 歌词铺回音符：`PuDoc` 按行存音节序列，`ScoreDoc` 挂在元素上。 */
function attachLyrics(anchors: readonly Element[], lyrics: readonly PuLyricLine[]): void {
  for (const line of lyrics) {
    for (let k = 0; k < line.syllables.length && k < anchors.length; k++) {
      const syl = line.syllables[k]!;
      if (syl.text === "") continue; // 空串 = 跳过这个音符
      const l: Lyric = { number: line.verseFrom, text: syl.text };
      if (line.verseTo !== line.verseFrom) l.numberTo = line.verseTo;
      if (syl.trailingPunctuation) l.trailingPunctuation = syl.trailingPunctuation;
      if (k === 0 && line.annotation !== undefined) l.verseLabel = line.annotation;
      if (syl.source) l.source = syl.source;
      (anchors[k]!.lyrics ??= []).push(l);
    }
  }
}

/** Mark：下标区间 → id 配对。 */
function convertMarks(line: ScoreLine, r: LineResult, out: Mark[]): void {
  for (const m of line.marks) {
    // volta 在 `ScoreDoc` 里是 `Barline.ending`（MusicXML 口径），不是 Mark
    if (m.type === "volta") {
      applyVolta(r, m.start, m.end, m.caption);
      continue;
    }
    const type: Mark["type"] | null =
      m.type === "slur" ? "slur" : m.type === "tuplet" ? "tuplet" : m.type === "crescendo" || m.type === "decrescendo" ? "wedge" : null;
    if (type === null) continue;
    const start = nearestId(r.idAt, m.start, 1);
    const end = nearestId(r.idAt, m.end, -1);
    if (start === undefined || end === undefined) continue;
    const mk: Mark = { type, start, end };
    if (m.level) mk.level = m.level;
    if (type === "tuplet") {
      const actual = Number(m.caption ?? 3);
      mk.tupletActual = Number.isFinite(actual) ? actual : 3;
      mk.tupletNormal = 2;
    }
    if (m.continuationToNext) mk.continuesToNext = true;
    if (m.continuationFromPrevious) mk.continuesFromPrevious = true;
    out.push(mk);
  }
}

/** 下标可能落在 barline（没有 id）上，按方向找最近的有 id 的元素。 */
function nearestId(idAt: Map<number, ElementId>, from: number, dir: 1 | -1): ElementId | undefined {
  for (let i = from; i >= 0 && i < from + 64 * dir * dir; i += dir) {
    const id = idAt.get(i);
    if (id !== undefined) return id;
    if (dir === -1 && i === 0) break;
  }
  return undefined;
}

/** 房号：`PuDoc` 的 volta Mark → 起止小节的 `Barline.ending`。 */
function applyVolta(r: LineResult, start: number, end: number, caption: string | undefined): void {
  const numbers = (caption ?? "1").split(/[.,]/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const nums = numbers.length ? numbers : [1];
  const startId = nearestId(r.idAt, start, 1);
  const endId = nearestId(r.idAt, end, -1);
  if (startId === undefined) return;
  for (const mea of r.measures) {
    const has = (id: ElementId): boolean =>
      mea.elements.some((e) => e.id === id) ||
      mea.elements.some((e) => e.kind === "chord" && (e.sustains ?? []).some((s) => s.id === id));
    if (has(startId)) {
      const existing = (mea.barlines ?? []).find((b) => b.location === "left");
      const ending = { numbers: nums, type: "start" as const, text: nums.join(".") };
      if (existing) existing.ending = ending;
      else (mea.barlines ??= []).push({ location: "left", ending });
    }
    if (endId !== undefined && has(endId)) {
      const right = (mea.barlines ?? []).find((b) => b.location === "right");
      const ending = { numbers: nums, type: "stop" as const, text: nums.join(".") };
      if (right) right.ending = ending;
      else (mea.barlines ??= []).push({ location: "right", style: "light-heavy", ending });
    }
  }
}

/** `PuDoc` → `ScoreDoc`。一首 `PuSong` 对一首 `Song`。 */
export function puToScoreDoc(pu: PuDoc): ScoreDoc {
  const doc = emptyDoc("pu");
  doc.source = pu.source;
  doc.diagnostics = [...pu.diagnostics];
  const ids = new IdGen();

  for (const ps of pu.songs) {
    const song: Song = emptySong();
    const meta = ps.metadata;
    if (meta.titles[0] !== undefined) song.work.title = meta.titles[0];
    song.work.subtitles = meta.titles.slice(1);
    if (meta.authors.length) {
      song.identification = { creators: meta.authors.map((t) => ({ type: "composer", text: t })) };
    }
    if (meta.mode !== undefined) {
      song.key = { fifths: 0, spelling: meta.mode };
      if (meta.tonic !== undefined && meta.tonic !== "1") song.key.tonicDegree = meta.tonic;
    }
    const m0 = meta.meters[0];
    if (m0) song.time = { beats: m0.numerator, beatType: m0.denominator, parenthesized: m0.parenthesized };
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
    const byVoice = new Map<number, Part>();
    const marks: Mark[] = [];
    for (const page of ps.pages) {
      for (const group of page.groups) {
        for (const line of group.voices) {
          let part = byVoice.get(line.voice);
          if (!part) {
            part = { id: `P${line.voice}`, measures: [] };
            if (line.caption !== undefined) part.name = line.caption;
            byVoice.set(line.voice, part);
          }
          const r = convertLine(line, ids, part.measures.length + 1);
          attachLyrics(r.anchors, line.lyrics);
          convertMarks(line, r, marks);
          // 行尾换行：`PuDoc` 的行就是排版行
          const last = r.measures[r.measures.length - 1];
          if (last) last.print = { newSystem: true };
          part.measures.push(...r.measures);
        }
      }
    }
    song.parts = [...byVoice.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
    song.marks = marks;
    doc.songs.push(song);
  }
  return doc;
}
