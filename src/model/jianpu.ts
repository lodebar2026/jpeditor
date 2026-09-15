// **简谱语义层**：从 `ScoreDoc` 取简谱要印的派生量——唱名与八度点、相对调号的临时记号（小节内延续）、
// 减时线/增时线/附点、和弦原文、谱表上下文、旋律取音、延音线与跨元素记号的对端。
//
// ## 为什么单独一层
//
// 这些量曾有三到四份各自的实现（简谱引擎输入、混排简谱叠层、时值投影、导出的反向延续），
// 收拢到这里后 `scripts/jianpu-semantic-check.mjs` 三方逐音比过（500 首 + 另 4 个语料目录）。
// 统一时定下的口径（括号里是本层的取法）：
//
// - 来源印的提醒记号（上一小节 `#5`、这一小节 `<accidental>natural</accidental>`）：
//   （**不印**——JP-Word 原稿 180《脱离捆绑》就没印，记号只按音高延续判）
// - 同一唱名一小节里改两次（`b6 → 6 → b6`）：（**按相对调号的偏移命名**，第三个印 `b` 不印还原号）
// - 声部逐拍 `<backup>` 交错：（**旋律 = 该谱表最小 voice 的最高音**，不接「最高音链」）
// - 双升/双降：（**印双升/双降**；语料 0 例。简谱引擎输入只有单字符记号位，印 `#`/`b`）
//
// ## 口径
//
// - **按记谱音高**：`<pitch>` 与 `<key>` 都是记谱的，唱名直接由两者算。`<transpose>` 只影响实际发声，
//   这里**不叠加**（混排曾把 `diatonic` 加进音高、调号却没加，两者对不上；语料 0 例）。
// - 调号是声部级的（`MeasureAttrs.key`，MusicXML 的 `<key number>` 按谱表分调号语料 0 例，模型未分）；
//   谱号按谱表取。`attrsAt(part, staff, i)` 是查询入口，将来模型分谱表调号时只改它。
// - 派生量**不存进 `ScoreDoc`**（`Note.degree` 是例外：它是简谱来源的一手数据，MusicXML 来源由
//   `assignDegrees` 补上），见 `docs/待办.md` §3.1「派生量不存进 ScoreDoc」。
//
// 无 DOM 依赖（Node CLI 要 import）。

import type {
  Accidental,
  Chord,
  Clef,
  Degree,
  Element,
  ElementId,
  Harmony,
  Key,
  Mark,
  Measure,
  Note,
  Part,
  Pitch,
  Song,
  Time,
  Transpose,
} from "./doc";
import { jpPitch, jpTonicOctaveShift, keyAlter, tonicStep } from "../score/jppitch";
import { harmonyToText } from "../score/harmonyparse";

const STEPS = "CDEFGAB";

// ───────────────────────── 音高 ↔ 度数 ─────────────────────────

/** 简谱度数 → 绝对音高（单音，不看小节内延续——那要 `AccidentalCarry.pitch`）。**直接转调 `jppitch.ts::jpPitch`**。
 *  面上的记号**相对调号**：`1=F` 里 `#4` 是 B 本位（调号的 B♭ 升半音），还原号是回到调号本身。
 *  （`helpers.ts` 旧版按绝对 alter 算，`1=F` 的 `#4` 会成 B♯，与 `xmlproject.ts` 的延续口径相反；它没有调用方。） */
export function pitchFromDegree(degree: Degree, key: Key): Pitch | null {
  if (degree.number === 0) return null; // 休止
  return new AccidentalCarry().pitch(degree, key);
}

/** 绝对音高 → 简谱度数（唱名 + 八度点）。
 *
 *  算式与 `score.ts::Note.init` / 混排 `MNote.octaveJp` 同源：`b=(4f+28)%7`、`oct=floor((wr-b)/7)-4`，
 *  再加 `jpTonicOctaveShift`（主音字母为 B 的调降一个八度，《简谱通用规范》23-24 页）。
 *  临时记号不在这里判（要小节内延续状态），由调用方给 `accidental` 或用 `AccidentalCarry`。 */
export function degreeFromPitch(pitch: Pitch, key: Key, accidental?: Accidental): Degree {
  const idx = STEPS.indexOf(pitch.step);
  const wr = idx + pitch.octave * 7;
  const b = tonicStep(key.fifths);
  const number = ((((wr - b) % 7) + 7) % 7) + 1;
  const octaveShift = Math.floor((wr - b) / 7) - 4 + jpTonicOctaveShift(key.fifths);
  const d: Degree = { number, octaveShift };
  if (accidental) d.accidental = accidental;
  return d;
}

const ACC_BY_OFFSET: Readonly<Record<number, Accidental>> = {
  [-2]: "double-flat", [-1]: "flat", 0: "natural", 1: "sharp", 2: "double-sharp",
};
const OFFSET_BY_ACC: Readonly<Record<Accidental, number>> = {
  "double-flat": -2, flat: -1, natural: 0, sharp: 1, "double-sharp": 2,
};

/** 一小节里（一条谱表上）**按唱名延续**的临时记号状态。简谱的升降号相对调号：
 *  `1=F` 里 `#4` 是 B 本位；同一小节后面的 `4` 沿用 `#4`，直到再写记号。
 *
 *  两个方向共用同一份状态规则，写出的 123 读回来音高才对：
 *  - `mark`：音高 → 面上要印的记号（MusicXML 来源进简谱）
 *  - `pitch`：度数 + 面上的记号 → 音高（简谱来源进 MusicXML） */
export class AccidentalCarry {
  /** 唱名 → 相对调号的半音偏移 */
  private offsets = new Map<number, number>();

  /** 这个音要不要印记号：相对调号的偏移与本小节已延续的不同才印，按偏移命名。 */
  mark(pitch: Pitch, key: Key): Accidental | undefined {
    const { number } = degreeFromPitch(pitch, key);
    const offset = pitch.alter - keyAlter(STEPS.indexOf(pitch.step), key.fifths);
    const expected = this.offsets.get(number) ?? 0;
    this.offsets.set(number, offset);
    return offset !== expected ? ACC_BY_OFFSET[offset] : undefined;
  }

  /** 度数（带面上的记号）→ 音高，并更新延续状态。拼写字母取自调号（`jppitch.ts::jpPitch`）。 */
  pitch(degree: Degree, key: Key): Pitch {
    if (degree.accidental) {
      const off = OFFSET_BY_ACC[degree.accidental];
      if (off === 0) this.offsets.delete(degree.number);
      else this.offsets.set(degree.number, off);
    }
    const p = jpPitch(degree.number, degree.octaveShift, key.fifths);
    return { step: p.step as Pitch["step"], alter: p.alter + (this.offsets.get(degree.number) ?? 0), octave: p.octave };
  }
}

// ───────────────────────── 调号拼写 ─────────────────────────

/** 调号的主音拼写（前置形：`"D"`、`"bB"`、`"#F"`）。来源给了 `spelling`（文本谱/123/ABC）就用它；
 *  只有 `fifths` 的（MusicXML）由升降号数推：`tonic: "major"` 取大调主音（简谱 `1=` 用），
 *  `"mode"` 在 `mode` 为 minor/aeolian 时取关系小调主音（ABC `K:Am` 用）。
 *
 *  以前 MusicXML → 123/ABC 两个写出端都回落成 `C`：D 大调的谱转出来是 `K:1=C`，整首移了调。 */
export function keySpelling(key: Key, tonic: "major" | "mode" = "major"): string {
  if (key.spelling) return key.spelling;
  const minor = tonic === "mode" && (key.mode === "minor" || key.mode === "aeolian");
  const idx = (tonicStep(key.fifths) + (minor ? 5 : 0)) % 7;
  const alter = keyAlter(idx, key.fifths);
  return (alter > 0 ? "#" : alter < 0 ? "b" : "") + STEPS[idx];
}

// ───────────────────────── 谱表上下文 ─────────────────────────

export interface ResolvedAttrs {
  divisions: number;
  key: Key;
  time?: Time;
  clef?: Clef;
  transpose?: Transpose;
}

/** 第 `i` 小节起点、第 `staff` 条谱表上生效的属性（向前找最近一次设定）。
 *  调号目前是声部级的（见文件头「口径」），谱号按谱表筛。 */
export function attrsAt(part: Part, staff: number, i: number, fallbackKey: Key = { fifths: 0 }): ResolvedAttrs {
  const r: ResolvedAttrs = { divisions: 1, key: fallbackKey };
  const n = Math.min(i, part.measures.length - 1);
  for (let k = 0; k <= n; k += 1) applyAttrs(r, part.measures[k]!, staff);
  return r;
}

function applyAttrs(r: ResolvedAttrs, m: Measure, staff: number): void {
  const a = m.attrs;
  if (!a) return;
  if (a.divisions !== undefined) r.divisions = a.divisions;
  if (a.key) r.key = a.key;
  if (a.time) r.time = a.time;
  if (a.transpose) r.transpose = a.transpose;
  const clef = a.clefs?.find((c) => (c.staff ?? 1) === staff);
  if (clef) r.clef = clef;
}

// ───────────────────────── 度数补全 ─────────────────────────

/** 本小节元素的**起拍**（四分音符为 1），按声部各自累计。倚音与占位符的起拍是它后面那个音的。 */
function onsets(m: Measure, divisions: number): Map<Element, number> {
  const pos = new Map<number, number>();
  const out = new Map<Element, number>();
  for (const el of m.elements) {
    const at = pos.get(el.voice) ?? 0;
    out.set(el, at);
    const d = el.kind === "chord" ? (el.grace ? 0 : el.duration.divisions) : (el.duration?.divisions ?? 0);
    pos.set(el.voice, at + d / divisions);
  }
  return out;
}

/** 按绝对音高给一个声部**重算**简谱度数与面上要印的临时记号。
 *
 *  **按起拍先后**过音（同一拍按原文次序，倚音在主音前）——多声部逐拍 `<backup>` 交错时原文次序不是时间次序。
 *  来源的 `<accidental>` 不看（提醒记号不照印，见文件头）。
 *
 *  每条谱表两份延续状态：
 *  - **旋律**（简谱印出来的那个音：该谱表最小 voice 的 `topNote`）只跟旋律音延续。和弦内声部改过的唱名不算数——
 *    赞美之泉 085《复兴的火》第 6 小节 `F A♭ C D` 和弦之后旋律的 A♭，简谱引擎与混排都印 `b6`。
 *    123 也只写这一路（`emit123.ts::emits`），读回时 `AccidentalCarry.pitch` 同样只沿旋律延续，两边对得上
 *  - 其余音（内声部、第二 voice）跟全部音延续，只供五线谱侧与导出参考 */
export function assignDegrees(part: Part, initialKey: Key): void {
  const r: ResolvedAttrs = { divisions: 1, key: initialKey };
  part.measures.forEach((m) => {
    applyAttrs(r, m, 1);
    const at = onsets(m, r.divisions);
    const order = m.elements
      .map((el, i) => ({ el, i }))
      .sort((a, b) => at.get(a.el)! - at.get(b.el)! || a.i - b.i);
    const melodyVoice = new Map<number, number>();
    for (const el of m.elements) {
      if (el.kind === "chord" && el.voice < (melodyVoice.get(el.staff) ?? Infinity)) melodyVoice.set(el.staff, el.voice);
    }
    const lanes = new Map<number, { melody: AccidentalCarry; all: AccidentalCarry }>();
    for (const { el } of order) {
      if (el.kind !== "chord") continue;
      let lane = lanes.get(el.staff);
      if (!lane) lanes.set(el.staff, (lane = { melody: new AccidentalCarry(), all: new AccidentalCarry() }));
      const top = el.voice === melodyVoice.get(el.staff) ? topNote(el) : undefined;
      for (const n of el.notes) {
        if (!n.pitch) continue;
        const d = degreeFromPitch(n.pitch, r.key);
        const byAll = lane.all.mark(n.pitch, r.key);
        const acc = n === top ? lane.melody.mark(n.pitch, r.key) : byAll;
        if (acc) d.accidental = acc;
        n.degree = d;
      }
    }
  });
}

/** 用绝对音高补出简谱度数（已有度数的不动）。调号取小节的 `attrs.key`，没有就取本曲的（缺省 C 大调）。
 *  面上的记号照来源给的 `accidental`（ABC 的记号就是写在谱面上的）。
 *  **只给音高、不给度数的来源（ABC、MusicXML）都要过这一步**——简谱排版、`emit123`、播放都按度数走。 */
export function fillDegreesFromPitch(song: Song): void {
  const key = song.key ?? { fifths: 0 };
  for (const part of song.parts) {
    let cur: Key = key;
    for (const m of part.measures) {
      if (m.attrs?.key) cur = m.attrs.key;
      for (const el of m.elements) {
        if (el.kind !== "chord") continue;
        for (const n of el.notes) {
          if (n.degree || !n.pitch) continue;
          n.degree = degreeFromPitch(n.pitch, cur, n.accidental);
        }
      }
    }
  }
}

// ───────────────────────── 时值 → 简谱写法 ─────────────────────────

/** `<type>` → 以四分音符为 1 的名义时值 */
export const TYPE_QUARTERS: Readonly<Record<string, number>> = {
  maxima: 32, long: 16, breve: 8, whole: 4, half: 2, quarter: 1,
  eighth: 1 / 2, "16th": 1 / 4, "32nd": 1 / 8, "64th": 1 / 16, "128th": 1 / 32, "256th": 1 / 64,
};

/** 这个元素的名义时值（四分音符为 1）：优先 `<type>` + 附点，没有 type（整小节休止等）才按 divisions 折算。 */
export function nominalQuarters(el: Element, divisions: number): number {
  const d = el.duration;
  if (!d) return 0;
  const base = d.type ? TYPE_QUARTERS[d.type] : undefined;
  if (base !== undefined) {
    let q = base;
    let add = base;
    for (let k = 0; k < d.dots; k++) {
      add /= 2;
      q += add;
    }
    return q;
  }
  let q = d.divisions / divisions;
  if (d.timeMod) q = (q * d.timeMod.actual) / d.timeMod.normal;
  return q;
}

/** 名义时值 → 简谱写法：减时线条数、附点数、增时线条数。 */
export function jianpuShape(q: number): { beams: number; dots: number; sustains: number } {
  if (q >= 1) {
    // 四分以上：一个四分（或附点四分）本体 + 若干增时线。附点二分 = `5 - -`
    const sustains = Math.max(0, Math.floor(q + 1e-9) - 1);
    const body = q - sustains;
    const dots = body >= 1.75 - 1e-9 ? 2 : body >= 1.5 - 1e-9 ? 1 : 0;
    return { beams: 0, dots, sustains };
  }
  // 四分以下：减时线条数由基本时值定，附点照记
  for (const dots of [0, 1, 2]) {
    const factor = dots === 0 ? 1 : dots === 1 ? 1.5 : 1.75;
    const base = q / factor;
    const beams = Math.log2(1 / base);
    if (Math.abs(beams - Math.round(beams)) < 1e-6) return { beams: Math.round(beams), dots, sustains: 0 };
  }
  return { beams: Math.max(1, Math.round(Math.log2(1 / q))), dots: 0, sustains: 0 };
}

/** 减时线条数（MusicXML 形状的元素）。 */
export function beamCount(el: Element, divisions: number): number {
  return jianpuShape(nominalQuarters(el, divisions)).beams;
}

// ───────────────────────── 和弦原文 ─────────────────────────

/** 结构化和弦 → 简谱面上印的原文（`"Am7"`、`"G/B"`）。有原文 `text` 时直接用原文。
 *  混排的富文本和弦（上标、`°`/`+` 字形、`(sus4)` 括号）是**印法**，从同一个结构排，不是另一份语义。 */
export function harmonyText(h: Harmony): string {
  return harmonyToText(h);
}

// ───────────────────────── 旋律取音 ─────────────────────────

/** 简谱层印哪一路：**最小谱表上的最小 voice**。本小节没有和弦时为 `undefined`。 */
export function melodyLane(m: Measure): { staff: number; voice: number } | undefined {
  let lane: { staff: number; voice: number } | undefined;
  for (const el of m.elements) {
    if (el.kind !== "chord") continue;
    if (!lane || el.staff < lane.staff || (el.staff === lane.staff && el.voice < lane.voice)) {
      lane = { staff: el.staff, voice: el.voice };
    }
  }
  return lane;
}

/** 简谱层的旋律：`melodyLane` 那一路的和弦（含休止与倚音），按原文次序。给了 `staff` 就取那条谱表上的最小 voice。 */
export function melodyChords(m: Measure, staff?: number): Chord[] {
  if (staff === undefined) {
    const lane = melodyLane(m);
    return lane ? m.elements.filter((el): el is Chord => el.kind === "chord" && el.staff === lane.staff && el.voice === lane.voice) : [];
  }
  let voice = Infinity;
  for (const el of m.elements) if (el.kind === "chord" && el.staff === staff && el.voice < voice) voice = el.voice;
  return m.elements.filter((el): el is Chord => el.kind === "chord" && el.staff === staff && el.voice === voice);
}

const midiOf = (p: Pitch): number => p.octave * 12 + [0, 2, 4, 5, 7, 9, 11][STEPS.indexOf(p.step)]! + p.alter;

/** MIDI 音高（中央 C = 60）。 */
export const midiPitch = (p: Pitch): number => midiOf(p) + 12;

/** 和弦里简谱印的那个音：音高最高者；没有绝对音高（简谱来源）时取度数最高者，再没有取第一个。 */
export function topNote(ch: Chord): Note | undefined {
  let best: Note | undefined;
  let bestV = -Infinity;
  // 画小的音（`<type size="cue">`，和弦里的上方装饰声部）不是旋律：有正常大小的音就只在它们里挑
  const normal = ch.notes.some((n) => n.typeSize !== "cue");
  for (const n of ch.notes) {
    if (normal && n.typeSize === "cue") continue;
    const v = n.pitch ? midiOf(n.pitch) : n.degree ? n.degree.octaveShift * 7 + n.degree.number : -Infinity;
    if (v > bestV) {
      best = n;
      bestV = v;
    }
  }
  return best ?? ch.notes[0];
}

// ───────────────────────── 对端 ─────────────────────────

/** 跨元素记号（弧、延音线记号、连音、渐强…）按**元素 id** 建的起止索引。 */
export function marksByElement(song: Song): { starts: Map<ElementId, Mark[]>; ends: Map<ElementId, Mark[]> } {
  const starts = new Map<ElementId, Mark[]>();
  const ends = new Map<ElementId, Mark[]>();
  const add = (map: Map<ElementId, Mark[]>, id: ElementId, mk: Mark): void => {
    const list = map.get(id);
    if (list) list.push(mk);
    else map.set(id, [mk]);
  };
  for (const mk of song.marks ?? []) {
    add(starts, mk.start, mk);
    add(ends, mk.end, mk);
  }
  return { starts, ends };
}

/** 延音线（`Note.tie.start`）的对端：同谱表同声部**往后第一个**带 `tie.stop`、音高相同的音。
 *  跨小节、跨行都靠它（`Note.tie` 只是起止标志，不带对端）。 */
export function tieTargets(part: Part): Map<Note, { chord: Chord; note: Note }> {
  const out = new Map<Note, { chord: Chord; note: Note }>();
  const open = new Map<string, { note: Note; key: string }[]>();
  const pitchKey = (n: Note): string =>
    n.pitch ? `${n.pitch.step}${n.pitch.alter}/${n.pitch.octave}` : n.degree ? `d${n.degree.number}/${n.degree.octaveShift}` : "";
  for (const m of part.measures) {
    for (const el of m.elements) {
      if (el.kind !== "chord") continue;
      const lane = `${el.staff}:${el.voice}`;
      for (const n of el.notes) {
        if (n.tie?.stop) {
          const list = open.get(lane);
          const k = pitchKey(n);
          const i = list?.findIndex((o) => o.key === k) ?? -1;
          if (list && i >= 0) {
            out.set(list[i]!.note, { chord: el, note: n });
            list.splice(i, 1);
          }
        }
        if (n.tie?.start) {
          const list = open.get(lane) ?? [];
          list.push({ note: n, key: pitchKey(n) });
          open.set(lane, list);
        }
      }
    }
  }
  return out;
}
