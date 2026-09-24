// `.jpwabc`（`JpwFile`）→ `ScoreDoc`。编辑器谱面（经 `model/jianpuinput.ts::jianpuInputOfJpw`）、试听、
// 转 123/ABC、导出 MusicXML、能力表都从这里出。
//
// 两步：
// - 源文怎么读（照原 JP-Word 移植来的口径）：`{(3}` 三连音、倚音、`{YanYin}`、
//   `(`/`)` 靠「前面欠着几个 `(`」分弧线收尾与三连音收尾、`"1=X"` 转调、拍号 token、`$` 换行、
//   临时记号到小节线清零、歌词按「源文小节序号 + 第几个音符」起排——切成「源文小节」（`SrcMeasure`）；
// - 落成模型：每根小节线都切小节、空小节的线并进下一小节左线、换行记「之后」再翻成「起」
//   （写在小节中间的 `$` 另记在前一个和弦的 `lineBreakAfter` 上）、倚音作独立 grace 元素。
//
// 曲首 `|:|` 连写在源文小节里是一个空小节（歌词落点照样数它，口径不能变），落模型时并掉。

import { JpwFile, RepeatSection, type Section } from "../jpword/jpwfile";
import type { JpwToken } from "../jpword/lex";
import { MusicCommon, applyJpPitch, type JpKeyState } from "../score/jppitch";
import { SIMPLE_DIVISIONS, type Barline, type BeamVal, type Chord, type Lyric, type Mark, type Measure, type Part, type PlayPass, type ScoreDoc, type Song, type SourceSpan, type Sustain } from "./doc";
import { IdGen, breaksAfterToStart, emptyDoc, emptySong } from "./helpers";
import type { BreakKind } from "./helpers";
import { creatorTypeOf } from "./metakeys";


/** 减时线/附点/增时线 → 模型时值（名义时值，连音比例另记在 Mark 上）。 */
export function durationOf(beams: number, dots: number, beats: number): Chord["duration"] {
  const base = SIMPLE_DIVISIONS >> Math.min(beams, 6);
  let total = base;
  let add = base;
  for (let k = 0; k < dots; k++) {
    add = Math.floor(add / 2);
    total += add;
  }
  total += beats * SIMPLE_DIVISIONS;
  const types = ["quarter", "eighth", "16th", "32nd", "64th", "128th", "256th"] as const;
  return { divisions: total, type: types[Math.min(beams, 6)]!, dots };
}

/** `.jpwabc` 的 jpAlter（`b`/`n`/`#`/空格）→ 模型的 Accidental。 */
export function accidentalOf(jpAlter: string): "sharp" | "flat" | "natural" | undefined {
  switch (jpAlter) {
    case "#": return "sharp";
    case "b": return "flat";
    case "n": return "natural";
    default: return undefined;
  }
}

/** `.Repeat` 的一行：`起[.音符]-止[.音符]V段号[P]`。与 `jpwfile.ts::RepeatSection` 同形。 */
const REPEAT_ROW = /^(\d+)(?:\.(\d+))?-(\d+)(?:\.(\d+))?V(\d+)(P)?$/i;

/** `.Repeat` 原文行 → `Song.playOrder`。`起.n` / `止.n` 解析成该小节第 n 个非倚音元素的 id。 */
export function convertRepeat(rows: readonly string[], part: Part | undefined): PlayPass[] {
  const out: PlayPass[] = [];
  const parsed = rows.flatMap((r) => r.split(",")).map((raw) => REPEAT_ROW.exec(raw.trim())).filter((m) => m !== null);
  // **小节号有 0 起与 1 起两种写法**：500 首里带 `.Repeat` 的 7 份 JP-Word 文件一律 0 起（`0-22V1`，最大号 = 小节数 − 1），
  // 本仓库测试语料与写出端（`tojpw.ts`）是 1 起。0 在 1 起的写法里不可能出现，而第一遍总从头唱、0 起的写法必有 `0-`，
  // 故「出现 0 就整份按 0 起」。按 1 起硬读 0 起的文件，演唱顺序里会有第 −1 小节，原样档排版直接抛错（伟大的主等 7 首）。
  const base = parsed.some((m) => Number(m[1]) === 0) ? 1 : 0;
  for (const m of parsed) {
    const p: PlayPass = { fromMeasure: Number(m[1]) + base, toMeasure: Number(m[3]) + base, verse: Number(m[5]) };
    if (m[6]) p.pageBreakAfter = true;
    if (part) {
      if (m[2]) {
        const id = nthNoteId(part, p.fromMeasure, Number(m[2]));
        if (id !== undefined) p.fromElement = id;
      }
      if (m[4]) {
        const id = nthNoteId(part, p.toMeasure, Number(m[4]));
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

// ───────────────────────── 第一步：源文 → 源文小节 ─────────────────────────

/** 一个倚音（`{6,}`），音高照主音那样按调号与小节内临时记号落好 */
export interface SrcGrace {
  number: string;
  jpOctave: number;
  jpAlter: string;
  pitch: number;
  step: string;
  rest: boolean;
}

export interface SrcNote {
  kind: "note";
  number: string;
  jpOctave: number;
  jpAlter: string;
  /** MIDI 音高（`applyJpPitch`，休止为 0） */
  pitch: number;
  step: string;
  rest: boolean;
  beams: number;
  /** 总拍数：初值 1，每个 `-` 再加一 */
  beats: number;
  dot: number;
  slurStart: boolean;
  slurEnds: number;
  fermata: boolean;
  tupletBegin: boolean;
  tupletEnd: boolean;
  graces: SrcGrace[];
  lyrics: { number: number; text: string; source?: SourceSpan }[];
  source?: SourceSpan;
}

export interface SrcBar {
  kind: "bar";
  style: NonNullable<Barline["style"]>;
  repeat?: "forward" | "backward";
  source?: SourceSpan;
}

export interface SrcBreak {
  kind: "break";
  page: boolean;
  /** `$(…)` 在原文里的位置。只给编辑用（`doc.ts::BreakSource`） */
  source?: SourceSpan;
}

export type SrcEntry = SrcNote | SrcBar | SrcBreak;

/** 源文小节：按原文的小节线切（歌词按它数小节） */
export interface SrcMeasure {
  entries: SrcEntry[];
  fifths: number;
  time: { beats: number; beatType: number };
  keyChange: boolean;
  timeChange: boolean;
}

/** `.Voice` token → 原文 `SourceSpan`（`.Voice` 正文是各行以 `\n` 拼的，行号经 `Section.lineOffsets` 折回） */
function spanOf(sec: Section, t: JpwToken): SourceSpan | undefined {
  const lineOffset = sec.lineOffsets[t.line];
  const lineNo = sec.lineNos[t.line];
  if (lineOffset === undefined || lineNo === undefined) return undefined;
  return { line: lineNo, column: t.column, offset: lineOffset + t.column, length: t.end - t.start };
}

/** 一个音符 token。 */
function readNote(txt: string, stat: JpKeyState & { inTuplet: boolean; slurDepth: number }): SrcNote {
  const nt: SrcNote = {
    kind: "note", number: "0", jpOctave: 0, jpAlter: " ", pitch: 0, step: " ", rest: false,
    beams: 0, beats: 1, dot: 0, slurStart: false, slurEnds: 0, fermata: false,
    tupletBegin: false, tupletEnd: false, graces: [], lyrics: [],
  };
  let acc = "";
  const tupletText = "{(3}";
  if (txt.includes(tupletText)) {
    if (stat.inTuplet) throw new Error("");
    nt.tupletBegin = true;
    stat.inTuplet = true;
    txt = txt.replace(tupletText, "");
  }
  // 倚音 `{6,}` / `{57}`：必须排在 `{(3}` 剥掉之后
  const graceMatch = txt.match(/\{([#b0-7',gd]+)\}/);
  if (graceMatch) {
    for (const g of graceMatch[1]!.matchAll(/(#b|#|b)?([0-7])([',gd]*)/g)) {
      const gn = { number: g[2]!, jpOctave: 0, jpAlter: " ", pitch: 0, step: " ", rest: false, chord: { rest: false } };
      if (g[1] === "#b") gn.jpAlter = "n";
      else if (g[1] === "#" || g[1] === "b") gn.jpAlter = g[1];
      for (const c of g[3]!) {
        if (c === ",") gn.jpOctave -= 1;
        else if (c === "'") gn.jpOctave += 1;
      }
      applyJpPitch(stat, gn); // 倚音的临时记号照样落进 stat.alter
      nt.graces.push({ number: gn.number, jpOctave: gn.jpOctave, jpAlter: gn.jpAlter, pitch: gn.pitch, step: gn.step, rest: gn.rest });
    }
    txt = txt.replace(graceMatch[0], "");
  }
  const artMatch = txt.match(/\{(?:DunYin|BoYin|YanYin|ZhongYin)(?:,(?:DunYin|BoYin|YanYin|ZhongYin))*\}/);
  if (artMatch) {
    if (artMatch[0].includes("YanYin")) nt.fermata = true;
    txt = txt.replace(artMatch[0], "");
  }
  let opened = 0;
  for (const ch of txt) {
    if (ch >= "0" && ch <= "9") {
      nt.number = ch;
      switch (acc) {
        case "#": nt.jpAlter = "#"; break;
        case "b": nt.jpAlter = "b"; break;
        case "#b": nt.jpAlter = "n"; break;
      }
      continue;
    }
    switch (ch) {
      case ",": nt.jpOctave -= 1; break;
      case "'": nt.jpOctave++; break;
      case "_": nt.beams += 1; break;
      case "-": nt.beats++; break;
      case ".": nt.dot++; break;
      case "#":
      case "b": acc += ch; break;
      case "(":
        nt.slurStart = true;
        opened++; // 本音符自己开的 `(` 要到下一个音符才轮到配对
        break;
      case ")":
        // 前面还欠着 `(` 就先收弧；欠完了、又正在三连音里，才是三连音的收尾（158《一件礼物》m3）
        if (stat.slurDepth > 0) {
          stat.slurDepth--;
          nt.slurEnds++;
        } else if (stat.inTuplet) {
          stat.inTuplet = false;
          nt.tupletEnd = true;
        } else {
          nt.slurEnds++;
        }
        break;
    }
  }
  stat.slurDepth += opened;
  const pitched = { ...nt, pitch: 0, chord: { rest: false } };
  applyJpPitch(stat, pitched);
  nt.pitch = pitched.pitch;
  nt.step = pitched.step;
  nt.rest = pitched.rest;
  return nt;
}

/** `.Voice` → 源文小节。 */
function readVoice(sec: VoiceSectionLike, fifths: number, time: { beats: number; beatType: number }): SrcMeasure[] {
  const out: SrcMeasure[] = [];
  let mea: SrcMeasure | null = null;
  let newMeasure = false;
  const stat = { basePitch: MusicCommon.getBasePitch(MusicCommon.keys[fifths + 7]!), fifths, alter: {} as Record<string, number>, inTuplet: false, slurDepth: 0 };
  const tupNotes: SrcNote[] = [];
  let pendingTime: SrcMeasure["time"] | null = null;
  let pendingKey: number | null = null;
  const open = (): SrcMeasure => {
    const m: SrcMeasure = { entries: [], fifths, time, keyChange: false, timeChange: false };
    out.push(m);
    return m;
  };

  for (const tok of sec.voiceData) {
    if (tok.type === "note") {
      if (mea === null || newMeasure) {
        mea = open();
        newMeasure = false;
        if (pendingTime !== null) {
          mea.time = pendingTime;
          mea.timeChange = true;
          pendingTime = null;
        }
        if (pendingKey !== null) {
          mea.fifths = pendingKey;
          mea.keyChange = true;
          stat.basePitch = MusicCommon.getBasePitch(MusicCommon.keys[pendingKey + 7]!);
          stat.fifths = pendingKey;
          stat.alter = {};
          pendingKey = null;
        }
      }
      const nt = readNote(tok.text, stat);
      nt.source = spanOf(sec, tok);
      if (nt.tupletEnd || nt.tupletBegin) tupNotes.push(nt);
      mea.entries.push(nt);
    } else if (tok.type === "barline") {
      // 曲首就写小节线（`|:3_ …`）：开一个小节收它，不置 newMeasure
      if (mea === null) {
        mea = open();
        newMeasure = false;
      }
      const txt = tok.text;
      const bar: SrcBar = { kind: "bar", style: "regular" };
      switch (txt) {
        case "|": bar.style = "regular"; break;
        case "|]": bar.style = "light-heavy"; break;
        case "[|]": bar.style = "none"; break;
        case "||": bar.style = "light-light"; break;
        case "|:": bar.style = "heavy-light"; bar.repeat = "forward"; break;
        case ":|": bar.style = "light-heavy"; bar.repeat = "backward"; break;
        default: throw new Error(`bad barline: ${txt}`);
      }
      bar.source = spanOf(sec, tok);
      mea.entries.push(bar);
      newMeasure = mea.entries.length > 1;
      stat.alter = {};
    } else if (tok.type === "timesig") {
      const m2 = /^(\d+)\/(\d+)/.exec(tok.text);
      if (m2) pendingTime = { beats: parseInt(m2[1]!, 10), beatType: parseInt(m2[2]!, 10) };
    } else if (tok.type === "string") {
      const m2 = /^"1=([#b]?[A-G])"$/.exec(tok.text);
      if (m2) pendingKey = MusicCommon.keyNameToFifth(m2[1]!);
    } else if (tok.type === "return") {
      const ret = tok.text;
      const args = substringBefore(substringAfter(ret, "("), ")").split(",");
      mea?.entries.push({
        kind: "break",
        page: args.length >= 4 && args[3]!.toLowerCase() === "true",
        source: spanOf(sec, tok),
      });
    }
  }

  // 三连音首尾两两配对，配反了抛错（与 `score.ts::doPairTuplet` / `Tuplet` 构造同口径）
  for (let i = 0; i < Math.floor(tupNotes.length / 2); i++) {
    if (tupNotes[2 * i]!.tupletEnd || tupNotes[2 * i + 1]!.tupletBegin) throw new Error("");
  }
  // 没有标记的小节沿用上一次的调号/拍号
  let curTime = time;
  let curKey = fifths;
  for (const m of out) {
    if (m.timeChange) curTime = m.time;
    else m.time = curTime;
    if (m.keyChange) curKey = m.fifths;
    else m.fifths = curKey;
  }
  return out;
}

type VoiceSectionLike = Section & { voiceData: JpwToken[] };

/** 歌词落点：按源文小节数，小节中间的换行也让小节序号加一。 */
function assignLyrics(measures: readonly SrcMeasure[], f: JpwFile): void {
  for (const seg of f.getLyric()?.segments ?? []) {
    const notes: SrcNote[] = [];
    let mid = 0;
    for (const m of measures) {
      mid++;
      let nid = 0;
      for (const ent of m.entries) {
        if (ent.kind === "break") {
          if (ent !== m.entries[m.entries.length - 1]) {
            mid++;
            nid = 0;
          }
          continue;
        }
        if (ent.kind !== "note") continue;
        nid++;
        if (mid < seg.measure) continue;
        if (mid === seg.measure && nid < seg.noteIndex) continue;
        notes.push(ent);
      }
    }
    let idx = 0;
    for (const it of seg.data) {
      if (idx >= notes.length) break;
      for (let pass = seg.passFirst; pass <= seg.passLast; pass++) {
        if (it.text.length > 0) notes[idx]!.lyrics.push({ number: pass, text: it.text, ...(it.source ? { source: { ...it.source } } : {}) });
      }
      idx++;
    }
  }
}

// ───────────────────────── 第二步：源文小节 → 模型 ─────────────────────────

/** 照原 `fromscore.ts::convertPart`（非 `forMusicXml`）。 */
function buildPart(src: readonly SrcMeasure[], ids: IdGen, marks: Mark[]): Part {
  const part: Part = { id: "P1", measures: [] };
  let prevKeyFifths: number | null = null;
  let prevTime = "";
  const breakAfterOf = new Map<Measure, BreakKind>();
  /** 开着的弧线（栈，嵌套双弧后开先闭；跨小节常见） */
  const openSlurs: number[] = [];
  let openTuplet: number | null = null;
  /** 刚读到的 `$`：之后同一小节里还有音符，才算小节中间换行 */
  let pendingInline: { chord: Chord; kind: "system" | "page" } | null = null;

  for (const sm of src) {
    let mea: Measure = { number: String(part.measures.length + 1), elements: [] };
    const timeKey = `${sm.time.beats}/${sm.time.beatType}`;
    if (prevKeyFifths === null || sm.keyChange || sm.fifths !== prevKeyFifths) {
      mea.attrs = { ...(mea.attrs ?? {}), key: { fifths: sm.fifths } };
    }
    if (prevTime === "" || sm.timeChange || timeKey !== prevTime) {
      mea.attrs = { ...(mea.attrs ?? {}), time: { beats: sm.time.beats, beatType: sm.time.beatType } };
    }
    prevKeyFifths = sm.fifths;
    prevTime = timeKey;
    openTuplet = null;
    pendingInline = null;

    for (const ent of sm.entries) {
      if (ent.kind === "break") {
        // `$` 是「这一小节之后」换行；小节线先到、新小节还空着时挂到刚收尾的那一个
        const target = mea.elements.length > 0 ? mea : part.measures[part.measures.length - 1] ?? mea;
        breakAfterOf.set(target, ent.page ? "page" : "system");
        // 写在小节中间（后面还有音符）的，另在前一个和弦上记原位（见 `Chord.lineBreakAfter`）
        const last = mea.elements.length > 0 ? mea.elements[mea.elements.length - 1] : undefined;
        pendingInline = last?.kind === "chord" ? { chord: last, kind: ent.page ? "page" : "system" } : null;
        if (ent.source) {
          const els = target.elements;
          (part.breakSources ??= []).push({ page: ent.page, after: els[els.length - 1]?.id ?? null, source: ent.source });
        }
        continue;
      }
      if (ent.kind === "bar") {
        // 每根小节线都是小节分隔；小节里还没有元素时算下一小节的左线
        const b: Barline = { location: "right", style: ent.style };
        if (ent.repeat) b.repeat = ent.repeat;
        if (ent.source) b.source = ent.source;
        pendingInline = null;
        if (mea.elements.length === 0) {
          const left = (mea.barlines ?? []).find((x) => x.location === "left");
          if (left) {
            left.style ??= b.style;
            left.repeat ??= b.repeat;
          } else {
            (mea.barlines ??= []).push({ ...b, location: "left" });
          }
        } else {
          (mea.barlines ??= []).push(b);
          part.measures.push(mea);
          mea = { number: String(part.measures.length + 1), elements: [] };
        }
        continue;
      }
      if (pendingInline) {
        pendingInline.chord.lineBreakAfter = pendingInline.kind;
        pendingInline = null;
      }
      const ch: Chord = {
        kind: "chord",
        id: ids.next(),
        notes: [],
        duration: durationOf(ent.beams, ent.dot, Math.max(0, ent.beats - 1)),
        voice: 1,
        staff: 1,
      };
      if (ent.source) ch.source = ent.source;
      if (ent.rest) ch.rest = {};
      const num = Number(ent.number);
      if (Number.isFinite(num) && num !== 0) {
        const acc = accidentalOf(ent.jpAlter);
        ch.notes.push({
          // `.jpwabc` 只有简谱度数，不填绝对音高：从前照 `fromscore` 抄了个只有音名字母、八度恒为 0 的 `pitch`，
          // 导出 MusicXML 时投影层（`xmlproject.ts`）见有音高就不再按度数 + 调号推，整首掉到第 0 八度
          degree: { number: num, octaveShift: ent.jpOctave, ...(acc ? { accidental: acc } : {}) },
        });
      }
      if (ent.beams > 0) ch.beams = Array.from({ length: ent.beams }, () => "continue" as BeamVal);
      for (let k = 0; k < ent.beats - 1; k++) {
        const su: Sustain = { id: ids.next() };
        (ch.sustains ??= []).push(su);
      }
      if (ent.fermata) ch.notations = { fermata: true };
      for (const g of ent.graces) {
        const gnum = Number(g.number);
        const gacc = accidentalOf(g.jpAlter);
        mea.elements.push({
          kind: "chord",
          id: ids.next(),
          notes: [{ degree: { number: Number.isFinite(gnum) && gnum > 0 ? gnum : 1, octaveShift: g.jpOctave, ...(gacc ? { accidental: gacc } : {}) } }],
          duration: { divisions: 0, dots: 0 },
          grace: {},
          voice: 1,
          staff: 1,
        });
      }
      for (const lr of ent.lyrics) (ch.lyrics ??= []).push({ number: lr.number, text: lr.text, ...(lr.source ? { source: lr.source } : {}) } as Lyric);
      mea.elements.push(ch);

      // 同一音符上「收上一条、再起下一条」：先收后起
      for (let k = 0; k < ent.slurEnds; k++) {
        const start = openSlurs.pop();
        if (start !== undefined) marks.push({ type: "slur", start, end: ch.id, level: openSlurs.length });
      }
      if (ent.slurStart) openSlurs.push(ch.id);
      if (ent.tupletBegin) openTuplet = ch.id;
      if (openTuplet !== null && ent.tupletEnd) {
        marks.push({ type: "tuplet", start: openTuplet, end: ch.id, tupletActual: 3, tupletNormal: 2 });
        openTuplet = null;
      }
    }
    if (mea.elements.length || mea.barlines?.length) part.measures.push(mea);
  }

  // 空小节并入下一小节的左线（`|:|` 连写）；它之后的换行挂到前一小节
  const merged: Measure[] = [];
  let carry: Barline[] = [];
  for (const m of part.measures) {
    if (m.elements.length === 0) {
      for (const b of m.barlines ?? []) carry.push({ ...b, location: "left" });
      const after = breakAfterOf.get(m);
      if (after && merged.length) {
        const prev = merged[merged.length - 1]!;
        if (breakAfterOf.get(prev) !== "page") breakAfterOf.set(prev, after);
      }
      continue;
    }
    if (carry.length) {
      m.barlines = [...carry, ...(m.barlines ?? [])];
      carry = [];
    }
    merged.push(m);
  }
  if (carry.length && merged.length) {
    const last = merged[merged.length - 1]!;
    last.barlines = [...(last.barlines ?? []), ...carry.map((b) => ({ ...b, location: "right" as const }))];
  }
  part.measures = merged;
  breaksAfterToStart(part, breakAfterOf);
  for (let i = 0; i < part.measures.length; i++) part.measures[i]!.number = String(i + 1);
  return part;
}

function unescape(str: string): string {
  return str.replace(/\\n/g, "\n");
}

/** 读 `.jpwabc` 原文的那一步：
 *  `.Voice` 切成源文小节、歌词落到音符上。`.Voice` 缺失或解析失败时抛错。 */
export function readJpwSource(f: JpwFile): {
  measures: SrcMeasure[];
  fifths: number;
  time: { beats: number; beatType: number };
  /** 歌词的最大遍数（`.Words` 各段 `passLast` 取大；没有歌词为 0） */
  passes: number;
} {
  const title = f.getTitle();
  const fifths = MusicCommon.keyNameToFifth(title?.key ?? "C");
  const [beats, beatType] = (title?.meter ?? "4/4").split("/");
  const time = { beats: parseInt(beats!, 10), beatType: parseInt(beatType!, 10) };
  const voice = f.getVoice();
  if (!voice) throw new Error("没有 .Voice");
  const measures = readVoice(voice as VoiceSectionLike, fifths, time);
  assignLyrics(measures, f);
  let passes = 0;
  for (const seg of f.getLyric()?.segments ?? []) passes = Math.max(passes, seg.passLast);
  return { measures, fifths, time, passes };
}

/** `.jpwabc` → `ScoreDoc`。`.Voice` 缺失或解析失败时抛错。 */
export function jpwToScoreDoc(f: JpwFile): ScoreDoc {
  const doc = emptyDoc("jpwabc");
  const ids = new IdGen();
  const song: Song = emptySong();
  const title = f.getTitle();
  const titleText = unescape(title?.title ?? "");
  if (titleText) song.work.title = titleText;
  const author = title?.wordsMusicBy ?? null;
  if (author !== null && unescape(author)) {
    const text = unescape(author);
    song.credits = [{ text }];
    // 词曲一行当作者行，123 才写得出 `C:`
    // 类型按标签定，只在整条是**一行**时认（多行「作词：…\n作曲：…」拼成一条，不拆，免得改 `C:` 的写出）
    if (text !== titleText) {
      const one = text.replace(/\n/g, " ");
      song.identification = { creators: [{ type: (text.includes("\n") ? null : creatorTypeOf(one)) ?? "composer", text: one }] };
    }
  }

  // 速度（`.Title` 的 `Expression ♩=NN`），试听与转 123 的 `Q:` 都要
  if (title?.tempo) song.tempos = [title.tempo];
  const src = readJpwSource(f).measures;

  const m0 = src[0];
  if (m0) {
    song.key = { fifths: m0.fifths };
    song.time = { beats: m0.time.beats, beatType: m0.time.beatType };
  }
  const marks: Mark[] = [];
  song.parts = [buildPart(src, ids, marks)];
  song.marks = marks;
  const rows = f.getSection(RepeatSection)?.data;
  if (rows?.length) {
    const play = convertRepeat(rows, song.parts[0]);
    if (play.length) song.playOrder = play;
  }
  doc.songs.push(song);
  return doc;
}

// Kotlin substringAfter/substringBefore semantics.
function substringAfter(s: string, delim: string): string {
  const i = s.indexOf(delim);
  return i < 0 ? s : s.substring(i + delim.length);
}
function substringBefore(s: string, delim: string): string {
  const i = s.indexOf(delim);
  return i < 0 ? s : s.substring(0, i);
}
