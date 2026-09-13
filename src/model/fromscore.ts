// `Score` → `ScoreDoc`：把 `.jpwabc` 与 MusicXML 来源的谱迁进 123。
//
// **过渡件**：R2 收尾后排版直接吃 `ScoreDoc`、`Score` 退役，这个文件随之删除。
//
// ## 已知有损（源头就没有，不是这里丢的）
//
// `Score` 装不下**和弦符号、力度、渐强渐弱、多声部并排**（568 份 MusicXML 100% 含
// `<harmony>`、共 12646 个，全在 `loadMusicXml` → `Score` 那一步丢掉）。所以从 `Score`
// 转出来的 `ScoreDoc` 里这些字段如实为空——**迁移报表要把它记成「降级表达」而不是规范缺口**。
//
// ## `.Repeat` 怎么来
//
// 演唱顺序表在 `.jpwabc` 的 `.Repeat` 段里，而 `Score` 只留下推导结果（`playData`）。
// 要无损就得把 `RepeatSection` 的原文一起传进来（`options.repeatRows`）。

import type { Measure as JpMeasure, Part as JpPart, Score } from "../score/score";
import { Chord as JpChord, BarlineEntry, LineBreak } from "../score/score";
import type {
  Barline,
  BeamVal,
  Chord,
  Lyric,
  Mark,
  Measure,
  Part,
  PlayPass,
  ScoreDoc,
  Song,
  Sustain,
} from "./doc";
import { IdGen, breaksAfterToStart, emptyDoc, emptySong } from "./helpers";
import type { BreakKind } from "./helpers";

const DIVISIONS = 48;

function durationOf(beams: number, dots: number, beats: number): Chord["duration"] {
  const base = DIVISIONS >> Math.min(beams, 6);
  let total = base;
  let add = base;
  for (let k = 0; k < dots; k++) {
    add = Math.floor(add / 2);
    total += add;
  }
  total += beats * DIVISIONS;
  const types = ["quarter", "eighth", "16th", "32nd", "64th", "128th", "256th"] as const;
  return { divisions: total, type: types[Math.min(beams, 6)]!, dots };
}

/** `.jpwabc` 的 jpAlter（`b`/`n`/`#`/空格）→ 模型的 Accidental。 */
function accidentalOf(jpAlter: string): Lyric extends never ? never : ("sharp" | "flat" | "natural" | undefined) {
  switch (jpAlter) {
    case "#": return "sharp";
    case "b": return "flat";
    case "n": return "natural";
    default: return undefined;
  }
}

function barlineOf(m: JpMeasure, side: "left" | "right"): Barline | null {
  const style = side === "left" ? m.leftBarline : m.barline;
  const repeat = side === "left" ? m.repeatForward : m.repeatBackward;
  if (style === null && !repeat && !(side === "left" && m.endingLeft)) return null;
  const b: Barline = { location: side };
  if (style !== null) b.style = String(style) as Barline["style"];
  if (repeat) b.repeat = side === "left" ? "forward" : "backward";
  if (m.endingNum && m.endingNum.size) {
    const numbers = [...m.endingNum];
    const ending = {
      numbers,
      // 房号**原文**要留住：语料里有 "1, 2" 带逗号这种写法，排版照原文画
      text: m.endingText ?? numbers.join("."),
      type: (side === "left" ? "start" : "stop") as "start" | "stop",
    };
    if (side === "left" && m.endingLeft) b.ending = ending;
    if (side === "right" && m.endingRight) b.ending = ending;
  }
  return b;
}

function convertPart(jp: JpPart, index: number, ids: IdGen, marks: Mark[]): Part {
  const part: Part = { id: `P${index + 1}`, measures: [] };
  let prevKeyFifths: number | null = null;
  let prevTime = "";
  /** `LineBreak` 记在哪一小节**之后**，建完再翻成模型口径（`doc.ts::Print`） */
  const breakAfterOf = new Map<Measure, BreakKind>();

  for (const jm of jp.measures) {
    let mea: Measure = { number: String(part.measures.length + 1), elements: [] };
    // 调号/拍号：只在变化处写 attrs（与 MusicXML 的口径一致）
    const fifths = jm.key.fifths;
    const timeKey = `${jm.time.beats}/${jm.time.beatType}`;
    if (prevKeyFifths === null || jm.keyChange || fifths !== prevKeyFifths) {
      mea.attrs = { ...(mea.attrs ?? {}), divisions: DIVISIONS, key: { fifths } };
    }
    if (prevTime === "" || jm.timeChange || timeKey !== prevTime) {
      mea.attrs = { ...(mea.attrs ?? {}), time: { beats: jm.time.beats, beatType: jm.time.beatType } };
    }
    prevKeyFifths = fifths;
    prevTime = timeKey;

    // MusicXML 的 `<print new-system/new-page>` 落在 `Measure.newSystem/newPage` 上
    // （`.jpwabc` 那一路是独立的 `LineBreak` entry，见下面的循环）。
    // **500 首 100% 的曲目都有 new-system**，原样排版全靠它，不能漏。
    if (jm.newPage) mea.print = { newPage: true };
    else if (jm.newSystem) mea.print = { newSystem: true };

    const left = barlineOf(jm, "left");
    if (left) (mea.barlines ??= []).push(left);

    /** 本小节内开着的弧线：`Chord.slurStart` 记起、`slurEnds` 是**计数**（嵌套双弧在末音同时收两条） */
    const openSlurs: number[] = [];
    /** 开着的三连音起点 id */
    let openTuplet: number | null = null;

    for (const ent of jm.entries) {
      if (ent instanceof LineBreak) {
        // `$` 的语义是「**这一小节之后**换行」。小节线通常先到、新小节还空着，
        // 这时要挂到刚收尾的那一个——挂在空小节上会随它一起被丢掉（与 `j123/parse.ts` 同口径）。
        const target = mea.elements.length > 0
          ? mea
          : part.measures[part.measures.length - 1] ?? mea;
        breakAfterOf.set(target, ent.newPage ? "page" : "system");
        continue;
      }
      if (ent instanceof BarlineEntry) {
        // **每根小节线都是小节分隔**——与 `j123/parse.ts` 的规则一致（有元素时遇线即收尾）。
        // `jpwimport` 允许一个 Measure 里放多根线（`:| |: |` 连写），照搬过来两侧对
        // 「哪根是右线」的判断就会不同，往返永远不幂等。这里按通行语义重新切。
        const b: Barline = { location: "right" };
        if (ent.style !== null && ent.style !== undefined) b.style = String(ent.style) as Barline["style"];
        if (ent.repeat) b.repeat = ent.repeat;
        if (mea.elements.length === 0) {
          // 还没有音符：这根属于下一小节的左线（`|:|` 连写、行首线）
          (mea.barlines ??= []).push({ ...b, location: "left" });
        } else {
          (mea.barlines ??= []).push(b);
          part.measures.push(mea);
          mea = { number: String(part.measures.length + 1), elements: [] };
        }
        continue;
      }
      if (!(ent instanceof JpChord)) continue;
      const jc = ent;
      const ch: Chord = {
        kind: "chord",
        id: ids.next(),
        notes: [],
        // `Chord.beats` 是**总拍数**（`jpwimport.ts:50` 初值 1，每个 `-` 再 ++），
        // 所以增时线条数 = beats - 1
        duration: durationOf(jc.beams, jc.dot, Math.max(0, jc.beats - 1)),
        voice: jc.voice + 1,
        staff: 1,
      };
      if (jc.rest) ch.rest = {};
      for (const nt of jc.notes) {
        const num = Number(nt.number);
        if (!Number.isFinite(num) || num === 0) continue;
        const acc = accidentalOf(nt.jpAlter);
        ch.notes.push({
          degree: { number: num, octaveShift: nt.jpOctave, ...(acc ? { accidental: acc } : {}) },
          pitch: nt.step.trim() ? { step: nt.step as "C", alter: nt.alter, octave: nt.octave } : undefined,
          ...(nt.tieStart || nt.tieEnd ? { tie: { ...(nt.tieStart ? { start: true } : {}), ...(nt.tieEnd ? { stop: true } : {}) } } : {}),
        } as Chord["notes"][number]);
      }
      if (jc.beams > 0) ch.beams = Array.from({ length: jc.beams }, () => "continue" as BeamVal);
      // 增时线：模型里是可挂载的独立对象（和弦能挂在增时线上）
      for (let k = 0; k < jc.beats - 1; k++) {
        const su: Sustain = { id: ids.next() };
        (ch.sustains ??= []).push(su);
      }
      if (jc.fermata || jc.articulations.length) {
        ch.notations = {
          ...(jc.fermata ? { fermata: true } : {}),
          ...(jc.articulations.length ? { articulations: [...jc.articulations] } : {}),
        };
      }
      if (jc.harmony) ch.harmony = { root: { step: "C", alter: 0 }, kind: "", text: jc.harmony };
      if (jc.sectionWord) ch.sectionWord = jc.sectionWord;
      // 倚音：`Score` 挂在 Chord 上，模型里是独立的 grace 元素、排在主音符之前
      for (const g of jc.graceNotes) {
        const num = Number(g.number);
        mea.elements.push({
          kind: "chord",
          id: ids.next(),
          notes: [{ degree: { number: Number.isFinite(num) && num > 0 ? num : 1, octaveShift: g.jpOctave } }],
          duration: { divisions: 0, dots: 0 },
          grace: {},
          voice: jc.voice + 1,
          staff: 1,
        });
      }
      // 歌词
      for (const nt of jc.notes) {
        for (const lr of nt.lyrics) {
          const l: Lyric = { number: lr.number, text: lr.text };
          // `W1-6:`（一行词供多段共用）在 `Score` 里是 `refrain` 标记，段号上界丢了。
          // 还原成段号区间：上界由全曲段数补（调用方在最后回填，见 `fillRefrainRange`）
          if (lr.refrain) l.refrain = true;
          (ch.lyrics ??= []).push(l);
        }
      }
      mea.elements.push(ch);

      if (jc.slurStart) openSlurs.push(ch.id);
      for (let k = 0; k < jc.slurEnds; k++) {
        const start = openSlurs.pop();
        if (start !== undefined) marks.push({ type: "slur", start, end: ch.id, level: openSlurs.length });
      }
      // 三连音：`Score` 把标记放在 Note 上（tupletBegin / tupletEnd）
      if (jc.notes.some((n) => n.tupletBegin)) openTuplet = ch.id;
      if (openTuplet !== null && jc.notes.some((n) => n.tupletEnd)) {
        const t = jc.notes.find((n) => n.tuplet)?.tuplet as { actual?: number; normal?: number } | null | undefined;
        marks.push({
          type: "tuplet",
          start: openTuplet,
          end: ch.id,
          tupletActual: t?.actual ?? 3,
          tupletNormal: t?.normal ?? 2,
        });
        openTuplet = null;
      }
    }

    // Measure 级的右线：MusicXML 那一路的小节线与反复记在 `Measure.barline` /
    // `repeatBackward` 上，没有 `BarlineEntry`，所以这里要补；`.jpwabc` 那一路已经由
    // entries 切过小节，只需把房号补上。
    const right = barlineOf(jm, "right");
    if (right) {
      const target = mea.elements.length ? mea : part.measures[part.measures.length - 1];
      if (target) {
        const rb = (target.barlines ?? []).find((x) => x.location === "right");
        if (rb) {
          if (right.ending) rb.ending = right.ending;
          if (right.repeat && !rb.repeat) rb.repeat = right.repeat;
        } else {
          (target.barlines ??= []).push(right);
        }
      }
    }
    if (mea.elements.length || mea.barlines?.length) part.measures.push(mea);
  }
  // **空小节并入下一小节的左线**：`.jpwabc` 允许两根小节线连写（`|:|`），
  // `jpwimport` 会为此造出一个没有音符的 Measure。而 123 的读入规则是
  // 「小节里还没有元素时，小节线算**左线**」，所以空小节读回时不会重现——
  // 留着它就永远不幂等。它携带的线并到后一小节前面即可。
  const merged: Measure[] = [];
  let carry: Barline[] = [];
  let carryPrint: Measure["print"];
  for (const m of part.measures) {
    if (m.elements.length === 0) {
      for (const b of m.barlines ?? []) carry.push({ ...b, location: "left" });
      // 空小节**之后**的换行（`LineBreak`）挂到**前一个**小节——跟着空小节一起丢掉的话，
      // 往返时换行位置会漂一格
      const after = breakAfterOf.get(m);
      if (after && merged.length) {
        const prev = merged[merged.length - 1]!;
        if (breakAfterOf.get(prev) !== "page") breakAfterOf.set(prev, after);
      }
      // 空小节**起**的新系统（MusicXML 的 `<print>`）顺延给下一个小节
      if (m.print) carryPrint = { ...(carryPrint ?? {}), ...m.print };
      continue;
    }
    if (carry.length) {
      m.barlines = [...carry, ...(m.barlines ?? [])];
      carry = [];
    }
    if (carryPrint) {
      m.print = { ...carryPrint, ...(m.print ?? {}) };
      carryPrint = undefined;
    }
    merged.push(m);
  }
  // 末尾残留的空小节线挂回最后一个小节的右侧
  if (carry.length && merged.length) {
    const last = merged[merged.length - 1]!;
    last.barlines = [...(last.barlines ?? []), ...carry.map((b) => ({ ...b, location: "right" as const }))];
  }
  part.measures = merged;
  breaksAfterToStart(part, breakAfterOf);
  for (let i = 0; i < part.measures.length; i++) part.measures[i]!.number = String(i + 1);
  return part;
}

/** `.Repeat` 的一行：`起[.音符]-止[.音符]V段号[P]`。与 `jpwfile.ts::RepeatSection` 同形。 */
const REPEAT_ROW = /^(\d+)(?:\.(\d+))?-(\d+)(?:\.(\d+))?V(\d+)(P)?$/i;

function convertRepeat(rows: readonly string[], part: Part | undefined): PlayPass[] {
  const out: PlayPass[] = [];
  for (const raw of rows.flatMap((r) => r.split(","))) {
    const s = raw.trim();
    if (!s) continue;
    const m = REPEAT_ROW.exec(s);
    if (!m) continue;
    const p: PlayPass = { fromMeasure: Number(m[1]), toMeasure: Number(m[3]), verse: Number(m[5]) };
    if (m[6]) p.pageBreakAfter = true;
    if (part) {
      if (m[2]) {
        const id = nthNoteId(part, Number(m[1]), Number(m[2]));
        if (id !== undefined) p.fromElement = id;
      }
      if (m[4]) {
        const id = nthNoteId(part, Number(m[3]), Number(m[4]));
        if (id !== undefined) p.toElement = id;
      }
    }
    out.push(p);
  }
  return out;
}

function nthNoteId(part: Part, measureNo: number, n: number): number | undefined {
  const m = part.measures[measureNo - 1];
  if (!m) return undefined;
  let k = 0;
  for (const el of m.elements) {
    if (el.kind === "chord" && !el.grace) {
      k++;
      if (k === n) return el.id;
    }
  }
  return undefined;
}

/** 把 `refrain` 标记还原成段号区间（`w1-N:`）。`Score` 只留「这行是副歌」，上界得靠全曲段数推。 */
function fillRefrainRange(song: Song): void {
  let maxVerse = 1;
  for (const part of song.parts) {
    for (const mea of part.measures) {
      for (const el of mea.elements) {
        for (const l of el.lyrics ?? []) maxVerse = Math.max(maxVerse, l.numberTo ?? l.number);
      }
    }
  }
  if (maxVerse <= 1) return;
  for (const part of song.parts) {
    for (const mea of part.measures) {
      for (const el of mea.elements) {
        for (const l of el.lyrics ?? []) {
          if (l.refrain && l.numberTo === undefined) l.numberTo = maxVerse;
        }
      }
    }
  }
}

export interface FromScoreOptions {
  /** `.jpwabc` 的 `.Repeat` 段原文行。不给就没有 `playOrder`——`Score` 只留推导结果，原文在 `JpwFile` 里 */
  repeatRows?: readonly string[];
  /** 曲号（`Score` 没有这个字段） */
  songNumber?: string;
  sourceFormat?: ScoreDoc["sourceFormat"];
}

/** `Score` → `ScoreDoc`。 */
export function scoreToScoreDoc(score: Score, options: FromScoreOptions = {}): ScoreDoc {
  const doc = emptyDoc(options.sourceFormat ?? "jpwabc");
  const ids = new IdGen();
  const song: Song = emptySong();
  if (options.songNumber !== undefined) song.work.number = options.songNumber;
  if (score.title) song.work.title = score.title;
  const creators: { type: string; text: string }[] = [];
  if (score.lyricist) creators.push({ type: "lyricist", text: score.lyricist });
  if (score.composer) creators.push({ type: "composer", text: score.composer });
  for (const [type, text] of score.creator ?? new Map<string, string>()) {
    if (text && !creators.some((c) => c.text === text)) creators.push({ type, text });
  }
  if (creators.length) song.identification = { creators };
  if (score.credit?.length) {
    song.credits = score.credit.map((c) => ({
      text: String((c as { words?: string }).words ?? ""),
    }));
  }

  const m0 = score.parts[0]?.measures[0];
  if (m0) {
    song.key = { fifths: m0.key.fifths };
    song.time = { beats: m0.time.beats, beatType: m0.time.beatType };
  }

  const marks: Mark[] = [];
  song.parts = score.parts.map((p, i) => convertPart(p, i, ids, marks));
  song.marks = marks;
  fillRefrainRange(song);
  if (options.repeatRows?.length) {
    const play = convertRepeat(options.repeatRows, song.parts[0]);
    if (play.length) song.playOrder = play;
  }
  doc.songs.push(song);
  return doc;
}
