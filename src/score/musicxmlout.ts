// Score -> MusicXML 3.0 partwise。是 score/musicxml.ts::loadMusicXml 的严格逆运算：
// 导出→重新导入应得到等价 Score。输出形状照抄 src/omr/musicxml.ts（那里的注释记着已踩过的坑）。
//
// 只在**没有 MusicXML 底本**时才走这里（纯 .jpwabc）。有底本（OMR/ABC/导入的 musicxml）一律走
// musicxmlpatch.ts 在底本上做增量修改——.jpwabc 承载的信息比 MusicXML 少，整体重生成 = 降采样。
//
// 四个要害（改之前先读，每条都对应一个真实的往返 bug）：
//  (a) divisions 取全曲 Chord.duration 分母的 lcm；<duration> 永远从 Chord.duration 算，
//      绝不从 <type> 反推（三连音下两者本就不等，比例由 <time-modification> 承担）。
//  (b) octave/alter 从 pitch+step 反推：.jpwabc 来源的 Score 只设了 pitch 和 step，
//      octave/alter 恒 0（见 jpwimport.ts::calcPitch）。
//  (c) fifths 要推断，不能照抄 m.key.fifths——jpwimport 从不给 Measure.key 赋值。
//  (d) <type>/<dot> 必须与导入端 parseDuration 互逆（含 dot=1 && beats>1 → beats*=1.5）。

import { Fraction } from "../common/fraction";
import { jpPitch } from "./jppitch";
import {
  BarlineEntry,
  Chord,
  Credit,
  JumpSpec,
  Measure,
  MusicCommon,
  Note,
  PlaySpecKind,
  Score,
} from "./score";

export interface MusicXmlOutOptions {
  /** 强制调号；默认按 §(c) 推断。 */
  fifths?: number;
  /** 输出 <print new-system/new-page>，默认 true。 */
  systemBreaks?: boolean;
}

const PITCH_MAP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const escapeXml = (s: string) =>
  s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
const escapeAttr = (s: string) => escapeXml(s).replace(/"/g, "&quot;");

// ---------------- (a) divisions ----------------
function gcd(a: number, b: number): number {
  let x = Math.abs(a), y = Math.abs(b);
  while (y) { const t = x % y; x = y; y = t; }
  return x || 1;
}

/** 全曲 Chord.duration 分母的最小公倍数：三连音得 3、减时线得 2^n、附点得 2。 */
export function collectDivisions(score: Score): number {
  let div = 1;
  for (const part of score.parts) {
    for (const m of part.measures) {
      for (const e of m.entries) {
        if (!(e instanceof Chord) || !e.duration) continue;
        const den = e.duration.denominator;
        div = (div / gcd(div, den)) * den;
      }
    }
  }
  if (div > 1024) console.warn(`MusicXML 导出：divisions=${div} 过大（时值分母极不规整）`);
  return div;
}

// ---------------- (b) pitch 拼写 ----------------
/** 从 MIDI pitch + 音名字母反推 {step, alter, octave}。取使 |alter| 最小的八度，
 *  故 B#4(72)→octave 4/alter +1、Cb5(71)→octave 5/alter −1 都正确。 */
export function spellPitch(pitch: number, step: string): { step: string; alter: number; octave: number } {
  const base = PITCH_MAP[step] ?? 0;
  const octave = Math.round((pitch - base) / 12) - 1;
  return { step, alter: pitch - (octave + 1) * 12 - base, octave };
}

/** 音符相对**调号**的额外升降（= 临时记号量）。
 *  不能直接读 nt.jpAlter：那只标在记号出现的那个音上，同小节后续同音级由 AccidentalStat 延续
 *  （见 jpwimport.ts::calcPitch 的 stat.alter），jpAlter 是 " " 但音高实际带着升降。
 *  改按音高差算：pitch − 该数字在本调的自然音高。两种来源（jpw / MusicXML）基准一致。 */
export function accidentalOf(nt: Note, fifths: number): number {
  if (nt.rest || nt.number === "0") return 0;
  const natural = MusicCommon.getBasePitch(MusicCommon.keys[fifths + 7]) +
    12 * nt.jpOctave + MusicCommon.stepToPitch(nt.number);
  return nt.pitch - natural;
}

// ---------------- (c) fifths ----------------
function mode(values: number[]): number | null {
  if (!values.length) return null;
  const cnt = new Map<number, number>();
  for (const v of values) cnt.set(v, (cnt.get(v) ?? 0) + 1);
  let best = values[0], bestN = 0;
  for (const [v, n] of cnt) if (n > bestN) { best = v; bestN = n; }
  return best;
}

/** 按 jp 表述反推全曲调号。jpwimport 从不给 Measure.key 赋值（调号只活在 JpState 里），
 *  照抄 m.key.fifths 会把 1=bB 导成 C 调 + 满谱临时记号。 */
export function deriveFifths(score: Score): number {
  const bases: number[] = [];
  const letters: number[] = [];
  for (const part of score.parts) {
    for (const m of part.measures) {
      for (const e of m.entries) {
        if (!(e instanceof Chord)) continue;
        for (const nt of e.notes) {
          if (nt.rest || nt.number === "0" || nt.jpAlter !== " ") continue;
          const digit = nt.number.charCodeAt(0) - "1".charCodeAt(0);
          if (digit < 0 || digit > 6) continue;
          // calcPitch 的逐项逆：pitch = base + 12*jpOctave + stepToPitch(number)
          bases.push(nt.pitch - 12 * nt.jpOctave - MusicCommon.stepToPitch(nt.number));
          const li = MusicCommon.steps.indexOf(nt.step);
          if (li >= 0) letters.push(((li - digit) % 7 + 7) % 7);
        }
      }
    }
  }
  const base = mode(bases);
  const letter = mode(letters);
  if (base === null || letter === null) return 0;
  for (let f = -7; f <= 7; f++) {
    const name = MusicCommon.keys[f + 7];
    if (MusicCommon.getBasePitch(name) !== base) continue;
    // 字母不可省：#F 与 bG 的 basePitch 都是 66，只有拼写字母能分开。
    if (MusicCommon.steps.indexOf(name[name.length - 1]) !== letter) continue;
    return f;
  }
  return 0;
}

// ---------------- (d) type / dot ----------------
const BASES: Array<[string, number]> = [
  ["whole", 4], ["half", 2], ["quarter", 1], ["eighth", 0.5],
  ["16th", 0.25], ["32nd", 0.125], ["64th", 0.0625],
];
const BEAM_TYPE = ["quarter", "eighth", "16th", "32nd", "64th"];

/** Chord 的 (beats, beams, dot) → <type> + 附点数。与导入端 parseDuration 严格互逆：
 *  那边 type→(beats,beams) 之后还做了 `dot===1 && beats>1 → beats*=1.5`。 */
export function noteTypeOf(ch: Chord): { type: string; dots: number } {
  const { beats, beams, dot } = ch;
  if (beams > 0 && beams < BEAM_TYPE.length && beats === 1) {
    return { type: BEAM_TYPE[beams], dots: dot > 0 ? 1 : 0 };
  }
  if (beams === 0) {
    if (beats === 1) return { type: "quarter", dots: dot > 0 ? 1 : 0 };
    if (beats === 2) return { type: "half", dots: dot > 0 ? 1 : 0 };
    if (beats === 3) return { type: "half", dots: 1 };
    if (beats === 4) return { type: "whole", dots: dot > 0 ? 1 : 0 };
    if (beats === 6) return { type: "whole", dots: 1 };
  }
  return typeOfDuration(ch.duration ?? new Fraction(1));
}

/** 兜底：由总时值反推 type + 附点数（同 omr/musicxml.ts::noteTypeDots，但用 Fraction 精确比较）。 */
export function typeOfDuration(duration: Fraction): { type: string; dots: number } {
  const q = duration; // 单位已经是四分音符
  for (const [type, val] of BASES) {
    const b = frac(val);
    if (q.equals(b)) return { type, dots: 0 };
    if (q.equals(b.times(new Fraction(3, 2)))) return { type, dots: 1 };
    if (q.equals(b.times(new Fraction(7, 4)))) return { type, dots: 2 };
  }
  for (const [type, val] of BASES) if (q.compareTo(frac(val)) >= 0) return { type, dots: 0 };
  return { type: "64th", dots: 0 };
}

function frac(v: number): Fraction {
  // BASES 里的值都是 2 的幂或其倒数，×16 后必为整数。
  return new Fraction(Math.round(v * 16), 16);
}

/** 音符的最终五线谱拼写。走 jp 表述（数字+八度点+调号）而不是 spellPitch(pitch)：
 *  jpw 来源的 pitch 基准是 getBasePitch（A/B 调用 48、其余 60），直接按 pitch 定八度会差 12；
 *  jpPitch 里的 extra 修正正是为抵消 Note.init 对 fifths 3/5/−2 的 jpOctave+1。 */
export function jpSpelling(nt: Note, fifths: number): { step: string; alter: number; octave: number } {
  const digit = nt.number.charCodeAt(0) - "0".charCodeAt(0);
  if (!(digit >= 1 && digit <= 7)) return spellPitch(nt.pitch, nt.step); // 非简谱数字：退回按音高拼
  const p = jpPitch(digit, nt.jpOctave, fifths);
  return { ...p, alter: p.alter + accidentalOf(nt, fifths) };
}

// ---------------- slur / tie 配对 ----------------
/** 逐条弧线的配对结果：给 `<slur>` 分配 number，并剔除配不上对的孤立记号。 */
export interface SlurTieMap {
  /** Chord → 该处 slur 的 number（start/stop 各一个槽）。不在表里 = 该记号被剔除。 */
  slur: Map<Chord, { start?: number; stop?: number }>;
  /** 配对成功的 tie 记号（Note → 保留哪一端）。 */
  tie: Map<Note, { start?: boolean; stop?: boolean }>;
  /** 被剔除的孤立记号数。 */
  dropped: number;
}

/**
 * 全曲扫一遍，把 slur/tie 配成对。
 *
 * 两件事都非做不可：
 *  1. **孤立记号要剔除**。谱面上漏写一个 `)` 是常事（《主祢真伟大》第 3 行末 `(5__ |` 就没闭合），
 *     照单全输出的话，从那里开始后面所有弧线全部错位——一个未闭合的 start 会把后续每个 stop
 *     都吃掉，实测连锁出 14 处重叠。
 *  2. **重叠的 slur 必须写 `number`**。MusicXML 靠 number 配对，缺省都是 1，两条弧线一旦重叠
 *     就分不清谁配谁。
 *
 * 配对用栈（后开先闭，符合嵌套语义；简谱里深度基本是 1，退化成顺序配对）。
 */
export function pairSlurTies(score: Score): SlurTieMap {
  const slur = new Map<Chord, { start?: number; stop?: number }>();
  const tie = new Map<Note, { start?: boolean; stop?: boolean }>();
  let dropped = 0;
  const part = score.parts[0];
  if (!part) return { slur, tie, dropped };

  const slot = (ch: Chord) => {
    const s = slur.get(ch) ?? {};
    slur.set(ch, s);
    return s;
  };
  const tslot = (nt: Note) => {
    const s = tie.get(nt) ?? {};
    tie.set(nt, s);
    return s;
  };

  // 开放中的 slur：[number, 起始 Chord]。number 取当前最小空闲值。
  const open: Array<[number, Chord]> = [];
  const openTie: Note[] = [];
  for (const m of part.measures) {
    for (const e of m.entries) {
      if (!(e instanceof Chord)) continue;
      // 同一个和弦上 stop 在 start 之前（一条弧收、下一条起）。
      if (e.slurEnd) {
        const top = open.pop();
        if (top) slot(e).stop = top[0];
        else dropped++;
      }
      if (e.slurStart) {
        const used = new Set(open.map(([n]) => n));
        let n = 1;
        while (used.has(n)) n++;
        open.push([n, e]);
        slot(e).start = n;
      }
      for (const nt of e.notes) {
        // 延音线两端必须是同音高的实音：MusicXML 的 tied 靠音高配对，连到休止符没有意义。
        const rest = e.rest || nt.rest || nt.number === "0";
        if (nt.tieEnd) {
          const from = openTie.pop();
          if (from && !rest && from.pitch === nt.pitch) tslot(nt).stop = true;
          else { if (from) { const s = tie.get(from); if (s) delete s.start; } dropped++; }
        }
        if (nt.tieStart && !rest) { openTie.push(nt); tslot(nt).start = true; }
        else if (nt.tieStart) dropped++;
      }
    }
  }
  // 收尾还开着的：源谱漏了闭合记号，把这些 start 也剔掉，别让下游软件收到半条弧。
  for (const [, ch] of open) {
    const s = slur.get(ch);
    if (s) delete s.start;
    dropped++;
  }
  for (const nt of openTie) {
    const s = tie.get(nt);
    if (s) delete s.start;
    dropped++;
  }
  if (dropped) {
    console.warn(`MusicXML 导出：剔除了 ${dropped} 个配不上对的 slur/tie 记号（源谱记号不成对）`);
  }
  return { slur, tie, dropped };
}

// ---------------- beam（符杠 = 简谱的减时线） ----------------
/** 一个音符各层符杠的状态，`<beam number="n">` 的值。 */
export type BeamState = "begin" | "continue" | "end" | "forward hook" | "backward hook";

/**
 * 算出每个和弦各层符杠的连接状态。简谱的减时线（`Chord.beams` 条下划线）就是五线谱的符杠：
 * 一拍之内相邻的减时线音符连成一组。
 *
 * 分组直接复用 `Measure.autoBeamGroup()`——排版引擎（layout.ts:1501）用的就是它，
 * 导出与屏幕上看到的分组因此天然一致，不另写一套规则。
 *
 * 逐层（level = 1..beams）在组内找连续段：长度 ≥2 → begin/continue/end；只有一个音
 * → hook（组内前面还有音就朝后勾 `backward hook`，否则朝前勾 `forward hook`），
 * 附点八分+十六分这类就是靠 hook 表达的。
 */
export function collectBeams(score: Score): Map<Chord, Map<number, BeamState>> {
  const out = new Map<Chord, Map<number, BeamState>>();
  const part = score.parts[0];
  if (!part) return out;
  for (const m of part.measures) {
    for (const g of m.autoBeamGroup()) {
      const chords = g.chords;
      if (chords.length < 2) continue; // 单个音符不成组（没有可连的符杠）
      const maxLevel = Math.max(...chords.map((c) => c.beams));
      for (let level = 1; level <= maxLevel; level++) {
        let i = 0;
        while (i < chords.length) {
          if (chords[i].beams < level) { i++; continue; }
          let j = i;
          while (j + 1 < chords.length && chords[j + 1].beams >= level) j++;
          // 简谱的减时线是画在休止符下面的（`5_ 0_ 3_` 下划线一路连过去），但五线谱的符杠
          // 挂不到休止符上——休止符没有符干。段内只有**实音符**承载 begin/continue/end，
          // 休止符被跨过（这正是五线谱 beam over rest 的写法，与原图观感一致）。
          const solid: Chord[] = [];
          for (let k = i; k <= j; k++) if (!chords[k].rest) solid.push(chords[k]);
          const put = (ch: Chord, st: BeamState) => {
            const mm = out.get(ch) ?? new Map<number, BeamState>();
            mm.set(level, st);
            out.set(ch, mm);
          };
          if (solid.length >= 2) {
            put(solid[0], "begin");
            for (let k = 1; k < solid.length - 1; k++) put(solid[k], "continue");
            put(solid[solid.length - 1], "end");
          } else if (solid.length === 1 && level > 1) {
            // 第 1 层就孤零零一个音符时它根本不成组（写成带符尾的单音即可）；
            // 更高层单独出现才是 hook（低层已经把它连进组里了）。
            put(solid[0], i > 0 ? "backward hook" : "forward hook");
          }
          i = j + 1;
        }
      }
    }
  }
  return out;
}

// ---------------- note ----------------
export interface OutCtx {
  divisions: number;
  fifths: number;
  /** slur/tie 的配对结果；缺省时按 Score 字段原样输出（不推荐，见 pairSlurTies）。 */
  pairs?: SlurTieMap;
  /** 各和弦的符杠连接状态；缺省时不输出 `<beam>`（交给下游软件自动连）。 */
  beams?: Map<Chord, Map<number, BeamState>>;
}

function durationOf(ch: Chord, ctx: OutCtx): number {
  const d = ch.duration ?? new Fraction(1);
  const num = d.numerator * ctx.divisions;
  if (num % d.denominator !== 0) {
    console.warn(`MusicXML 导出：时值 ${d} 无法被 divisions=${ctx.divisions} 整除`);
  }
  return Math.max(1, Math.round(num / d.denominator));
}

/** nominal（按 type/dot 该有的时值）÷ 实际时值 ≠ 1 → 三连音等，需要 <time-modification>。 */
function timeModXml(ch: Chord, tp: { type: string; dots: number }): string {
  const baseVal = BASES.find(([t]) => t === tp.type)?.[1] ?? 1;
  let nominal = frac(baseVal);
  if (tp.dots === 1) nominal = nominal.times(new Fraction(3, 2));
  else if (tp.dots === 2) nominal = nominal.times(new Fraction(7, 4));
  const actual = ch.duration ?? nominal;
  if (actual.numerator === 0) return "";
  const r = nominal.div(actual);
  if (r.equals(1)) return "";
  return `<time-modification><actual-notes>${r.numerator}</actual-notes>` +
    `<normal-notes>${r.denominator}</normal-notes></time-modification>`;
}

function notationsXml(ch: Chord, nt: Note, first: boolean, pairs?: SlurTieMap): string {
  const ns: string[] = [];
  const sl = pairs?.slur.get(ch);
  const ti = pairs?.tie.get(nt);
  const tieStop = pairs ? !!ti?.stop : nt.tieEnd;
  const tieStart = pairs ? !!ti?.start : nt.tieStart;
  if (tieStop) ns.push(`<tied type="stop"/>`);
  if (tieStart) ns.push(`<tied type="start"/>`);
  if (first) {
    // 配对表在时只输出配上对的，并带 number；没有配对表才退回按字段原样输出。
    if (pairs) {
      if (sl?.stop !== undefined) ns.push(`<slur type="stop" number="${sl.stop}"/>`);
      if (sl?.start !== undefined) ns.push(`<slur type="start" number="${sl.start}"/>`);
    } else {
      if (ch.slurEnd) ns.push(`<slur type="stop"/>`);
      if (ch.slurStart) ns.push(`<slur type="start"/>`);
    }
  }
  if (nt.tupletEnd) ns.push(`<tuplet type="stop"/>`);
  if (nt.tupletBegin) ns.push(`<tuplet type="start"/>`);
  if (first && ch.fermata) ns.push(`<fermata/>`);
  return ns.length ? `<notations>${ns.join("")}</notations>` : "";
}

export function lyricsXml(nt: Note): string {
  const sorted = [...nt.lyrics].sort((a, b) => a.number - b.number);
  let out = "";
  for (const l of sorted) {
    if (!l.text.length) continue;
    if (l.number > 9) console.warn(`MusicXML 导出：verse ${l.number} > 9，导入端只读末位数字`);
    const num = l.refrain ? "chorus" : String(l.number);
    out += `<lyric number="${escapeAttr(num)}"><syllabic>single</syllabic>` +
      `<text>${escapeXml(l.text)}</text></lyric>`;
  }
  return out;
}

function beamXml(ch: Chord, ctx: OutCtx): string {
  if (ch.rest) return ""; // 休止符没有符干，挂不了 <beam>
  const st = ctx.beams?.get(ch);
  if (!st) return "";
  return [...st.entries()].sort((a, b) => a[0] - b[0])
    .map(([lv, v]) => `<beam number="${lv}">${v}</beam>`).join("");
}

/** 单个 <note>。idx>0 表示同和弦的第 2+ 个音（写 <chord/>）。 */
export function noteXml(ch: Chord, nt: Note, ctx: OutCtx, idx: number): string {
  const dur = durationOf(ch, ctx);
  const tp = noteTypeOf(ch);
  const head = idx > 0 ? "<chord/>" : "";
  const isRest = ch.rest || nt.rest || !(nt.step in PITCH_MAP) || nt.pitch <= 0;
  let body: string;
  if (isRest) {
    body = "<rest/>";
  } else {
    const p = jpSpelling(nt, ctx.fifths);
    body = `<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}` +
      `<octave>${p.octave}</octave></pitch>`;
  }
  // <tie> 是播放语义，导入端只读 <notations><tied>，两者都写才算完整 MusicXML。
  const ti = ctx.pairs?.tie.get(nt);
  const tieStop = ctx.pairs ? !!ti?.stop : nt.tieEnd;
  const tieStart = ctx.pairs ? !!ti?.start : nt.tieStart;
  const ties = (tieStop ? `<tie type="stop"/>` : "") + (tieStart ? `<tie type="start"/>` : "");
  // <beam> 只挂和弦的第一个音（同和弦其余音共用符杠），位置在 <notations> 之前。
  const beams = idx === 0 ? beamXml(ch, ctx) : "";
  return `<note>${head}${body}<duration>${dur}</duration>${ties}<voice>1</voice>` +
    `<type>${tp.type}</type>${"<dot/>".repeat(tp.dots)}${timeModXml(ch, tp)}${beams}` +
    `${notationsXml(ch, nt, idx === 0, ctx.pairs)}${lyricsXml(nt)}</note>`;
}

// ---------------- measure ----------------
function endingAttr(nums: Set<number> | null): string {
  if (!nums) return "";
  return [...nums].sort((a, b) => a - b).join(",");
}

/** 小节右端实际该画的线型。jpw 路径把 |] / || 只写进 BarlineEntry，m.barline 恒 null，
 *  兜底取本节最后一个 BarlineEntry 的 style；"regular"（普通小节线）在 MusicXML 里不写
 *  <barline>，写了反而让往返多出一个节点。patch 侧共用此函数，两边判据必须一致。 */
export function effectiveBarline(m: Measure): string | null {
  let style: string | null = m.barline;
  if (!style) {
    // 只认排在最后一个音符**之后**的 BarlineEntry：导入端 parseBarline 对 location="left"
    // 也会 push 一个 entry（位置在小节开头），不排除的话会把左端线型误当成右端的。
    for (let i = m.entries.length - 1; i >= 0; i--) {
      const e = m.entries[i];
      if (e instanceof Chord) break;
      // `|:` 虽然被 push 在本小节末尾，语义上是**下一小节**的左端，不算本小节的右端线型。
      if (e instanceof BarlineEntry && e.repeat === "forward") continue;
      if (e instanceof BarlineEntry && e.style) { style = e.style; break; }
    }
  }
  return style === "regular" ? null : style;
}

/** 本小节末尾是不是 `:|`（反复回头）。jpw 路径不设 Measure.repeatBackward，
 *  反复只以 BarlineEntry.repeat 的形式存在，导出必须据此写 `<repeat>`，
 *  否则外部软件看到的只是一根终止线，反复整个丢掉。 */
export function hasRepeatBackward(m: Measure): boolean {
  if (m.repeatBackward) return true;
  for (let i = m.entries.length - 1; i >= 0; i--) {
    const e = m.entries[i];
    if (e instanceof Chord) break;
    if (e instanceof BarlineEntry && e.repeat === "backward") return true;
  }
  return false;
}

/** 本小节开头是不是 `|:`。记号被解析进**上一小节**末尾，故要往回看一格。 */
export function hasRepeatForward(m: Measure, prev: Measure | null): boolean {
  if (m.repeatForward) return true;
  if (!prev) return false;
  for (let i = prev.entries.length - 1; i >= 0; i--) {
    const e = prev.entries[i];
    if (e instanceof Chord) break;
    if (e instanceof BarlineEntry && e.repeat === "forward") return true;
  }
  return false;
}

/** 小节左端线型（同上，jpw 路径通常只有 repeatForward）。 */
export function effectiveLeftBarline(m: Measure): string | null {
  return m.leftBarline === "regular" ? null : m.leftBarline;
}

// ---------------- 房号（volta） ----------------
export interface Volta {
  /** 本小节是某一房的开头，值为该房辖的遍数（`<ending number>` 的原文）。 */
  start?: string;
  /** 本小节是某一房的结尾。 */
  stop?: boolean;
  /** 本小节末尾要补一个反复回头（除最后一房外，每房唱完都要回到 `|:`）。 */
  repeatBack?: boolean;
}

const setKey = (s: Set<number>) => [...s].sort((a, b) => a - b).join(",");

/**
 * 从 `.Repeat` 的演唱顺序反推房号。
 *
 * `.jpwabc` 不在小节上标房号，而是用 `.Repeat` 段列出每一遍唱哪些小节（`1-4V1`、`1-3V4`、
 * `5-5V4`…，进 `PlayData.measures` 成 PlayItem）。把它翻回 MusicXML 的 `<ending>`：
 *
 *  1. 算出每个小节被哪几遍唱到（`passesOf`），按「连续且遍集合相同」切成段；
 *  2. 找**分岔点**：某段的遍集合是前一段的真子集，说明反复体在这里分头；
 *  3. 从分岔点往后连续收段，直到各段遍集合的并集**恰好等于**分岔前的全集——这一组段就是各房。
 *     并集对不上（或只有一段）就放弃：那不是房，只是「某一遍唱得短一点」。
 *
 * 判据在《沧海一声笑》上推出 `1,2,3,5` / `4` / `6`，与 OMR 从原图识别出的房号一致；
 * 《因有主同在》的 `1-28V1 / 1-8V2` 则正确地不成房。
 */
export function deriveVoltas(score: Score): Map<number, Volta> {
  const out = new Map<number, Volta>();
  const part = score.parts[0];
  const items = score.playData.measures;
  if (!part || items.length === 0) return out;
  // MusicXML 来源的 Score 已经带房号，不要再叠加推断。
  if (part.measures.some((m) => m.endingLeft || m.endingRight)) return out;

  const passesOf = new Map<number, Set<number>>();
  const allPasses = new Set<number>();
  for (const it of items) {
    allPasses.add(it.pass);
    for (let mid = it.mid; mid < it.end; mid++) {
      const s = passesOf.get(mid) ?? new Set<number>();
      s.add(it.pass);
      passesOf.set(mid, s);
    }
  }
  if (allPasses.size < 2) return out;

  // 连续且遍集合相同 → 一段
  const segs: Array<{ from: number; to: number; passes: Set<number> }> = [];
  for (const mid of [...passesOf.keys()].sort((a, b) => a - b)) {
    const p = passesOf.get(mid)!;
    const last = segs[segs.length - 1];
    if (last && last.to + 1 === mid && setKey(last.passes) === setKey(p)) last.to = mid;
    else segs.push({ from: mid, to: mid, passes: p });
  }

  const isSubset = (a: Set<number>, b: Set<number>) =>
    a.size < b.size && [...a].every((v) => b.has(v));

  for (let i = 0; i < segs.length - 1; i++) {
    if (!isSubset(segs[i + 1].passes, segs[i].passes)) continue;
    const target = segs[i].passes;
    const group: typeof segs = [];
    const acc = new Set<number>();
    for (let j = i + 1; j < segs.length; j++) {
      if ([...segs[j].passes].some((v) => acc.has(v))) break; // 遍次重叠：不是并列的房
      for (const v of segs[j].passes) acc.add(v);
      group.push(segs[j]);
      if (setKey(acc) === setKey(target)) break;
    }
    if (group.length < 2 || setKey(acc) !== setKey(target)) continue;
    group.forEach((g, k) => {
      const head = out.get(g.from) ?? {};
      head.start = setKey(g.passes);
      out.set(g.from, head);
      const tail = out.get(g.to) ?? {};
      tail.stop = true;
      // 最后一房唱完往下走，之前每一房唱完都要回到 `|:`。
      if (k < group.length - 1) tail.repeatBack = true;
      out.set(g.to, tail);
    });
    i = segs.indexOf(group[group.length - 1]); // 跳过已归房的段
  }
  return out;
}

function barlineXml(
  m: Measure, loc: "left" | "right", prev: Measure | null, volta: Volta | undefined,
): string {
  if (loc === "left") {
    const rep = hasRepeatForward(m, prev);
    // 房号：Measure 上有就用（MusicXML 来源），否则用 .Repeat 反推的（jpw 来源）。
    const ending = m.endingLeft ? endingAttr(m.endingNum) : volta?.start ?? null;
    const style = effectiveLeftBarline(m) ?? (rep ? "heavy-light" : null);
    if (!style && !rep && ending === null) return "";
    return `<barline location="left">${style ? `<bar-style>${style}</bar-style>` : ""}` +
      `${ending !== null ? `<ending number="${escapeAttr(ending)}" type="start"/>` : ""}` +
      `${rep ? `<repeat direction="forward"/>` : ""}</barline>`;
  }
  // 房末（最后一房除外）必须回头，否则外部软件走不出正确的演唱顺序。
  const rep = hasRepeatBackward(m) || !!volta?.repeatBack;
  const endType = m.endingRight ?? (volta?.stop ? "stop" : null);
  const ending = endType === null ? null
    : (m.endingRight ? endingAttr(m.endingNum) : volta?.start ?? endingAttr(m.endingNum));
  let style = effectiveBarline(m);
  if (!style && rep) style = "light-heavy";
  if (!style && !rep && endType === null) return "";
  return `<barline location="right">${style ? `<bar-style>${style}</bar-style>` : ""}` +
    `${endType !== null ? `<ending number="${escapeAttr(ending ?? "")}" type="${endType}"/>` : ""}` +
    `${rep ? `<repeat direction="backward"/>` : ""}</barline>`;
}

const JUMP_ATTR: Record<PlaySpecKind, (v: unknown) => string> = {
  [PlaySpecKind.Dacapo]: () => `dacapo="yes"`,
  [PlaySpecKind.Fine]: () => `fine="yes"`,
  [PlaySpecKind.DalSegno]: (v) => `dalsegno="${escapeAttr(String(v ?? 1))}"`,
  [PlaySpecKind.ToCoda]: (v) => `tocoda="${escapeAttr(String(v ?? 1))}"`,
};
const JUMP_WORDS: Record<PlaySpecKind, string> = {
  [PlaySpecKind.Dacapo]: "D.C.",
  [PlaySpecKind.Fine]: "Fine",
  [PlaySpecKind.DalSegno]: "D.S.",
  // 词面 "To Coda" 会命中导入端 parseSectionMark 的 SECTION_WORD_RE（coda 在白名单里），
  // 被误读成段落标记，故这一种只写 <sound>、不写 <words>。
  [PlaySpecKind.ToCoda]: "",
};

interface Event { offset: Fraction; xml: string }

/** PlayData 的 coda/segno/jumpTo → 按小节归拢的 <direction>/<sound> 事件。 */
function collectEvents(score: Score): Map<number, Event[]> {
  const out = new Map<number, Event[]>();
  const push = (mid: number, offset: Fraction, xml: string) => {
    const arr = out.get(mid) ?? [];
    arr.push({ offset, xml });
    out.set(mid, arr);
  };
  for (const [k, t] of score.playData.coda) {
    push(t.mid, t.offset, `<sound coda="${escapeAttr(k)}"/>`);
  }
  for (const [k, t] of score.playData.segno) {
    push(t.mid, t.offset, `<sound segno="${escapeAttr(k)}"/>`);
  }
  for (const [t, spec] of score.playData.jumpTo) {
    const js = spec as JumpSpec;
    const words = JUMP_WORDS[js.kind];
    const wx = words ? `<direction-type><words>${escapeXml(words)}</words></direction-type>` : "";
    push(t.mid, t.offset,
      `<direction placement="above">${wx}<sound ${JUMP_ATTR[js.kind](js.value)}/></direction>`);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.offset.compareTo(b.offset));
  return out;
}

function attributesXml(m: Measure, ctx: OutCtx, first: boolean): string {
  if (first) {
    return `<attributes><divisions>${ctx.divisions}</divisions>` +
      `<key><fifths>${ctx.fifths}</fifths></key>` +
      `<time><beats>${m.time.beats}</beats><beat-type>${m.time.beatType}</beat-type></time>` +
      `<clef><sign>G</sign><line>2</line></clef></attributes>`;
  }
  const parts: string[] = [];
  if (m.keyChange) parts.push(`<key><fifths>${m.key.fifths}</fifths></key>`);
  if (m.timeChange) {
    parts.push(`<time><beats>${m.time.beats}</beats><beat-type>${m.time.beatType}</beat-type></time>`);
  }
  return parts.length ? `<attributes>${parts.join("")}</attributes>` : "";
}

function measureXml(
  m: Measure, mid: number, ctx: OutCtx, events: Event[], opt: MusicXmlOutOptions, tempo: number,
  prev: Measure | null, volta: Volta | undefined,
): string {
  const printEl = opt.systemBreaks === false ? ""
    : m.newPage ? `<print new-page="yes"/>` : m.newSystem ? `<print new-system="yes"/>` : "";
  const attrs = attributesXml(m, ctx, mid === 0);
  const tempoEl = mid === 0 && tempo
    ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>` +
      `<per-minute>${tempo}</per-minute></metronome></direction-type>` +
      `<sound tempo="${tempo}"/></direction>`
    : "";
  // 段落标记用 <rehearsal>：导入端 parseSectionMark 对 <words> 有白名单，非白名单段名会被丢。
  const markEl = m.sectionMark
    ? `<direction placement="above"><direction-type><rehearsal>${escapeXml(m.sectionMark)}</rehearsal>` +
      `</direction-type></direction>`
    : "";

  const chords = m.entries.filter((e): e is Chord => e instanceof Chord);
  const pending = [...events];
  let body = "";
  const flush = (upto: Fraction | null) => {
    while (pending.length && (upto === null || pending[0].offset.compareTo(upto) <= 0)) {
      body += pending.shift()!.xml;
    }
  };
  if (!chords.length) {
    // 空小节：补一个整小节休止，否则 Measure.duration getter 会抛错、导入端位置也会错乱。
    const beats = m.time.beats * 4 / m.time.beatType;
    const dur = Math.max(1, Math.round(beats * ctx.divisions));
    const tp = typeOfDuration(new Fraction(Math.round(beats * 16), 16));
    body += `<note><rest/><duration>${dur}</duration><voice>1</voice><type>${tp.type}</type>` +
      `${"<dot/>".repeat(tp.dots)}</note>`;
    console.warn(`MusicXML 导出：第 ${mid + 1} 小节没有音符，已补整小节休止`);
  } else {
    let expect = new Fraction(0);
    for (const ch of chords) {
      // 位置链有空档就补休止：导入端不处理 <forward>，不补会让后续音符整体前移。
      if (ch.position.compareTo(expect) > 0) {
        const gap = ch.position.minus(expect);
        const gapDur = Math.max(1, Math.round(gap.numerator * ctx.divisions / gap.denominator));
        const tp = typeOfDuration(gap);
        body += `<note><rest/><duration>${gapDur}</duration><voice>1</voice>` +
          `<type>${tp.type}</type>${"<dot/>".repeat(tp.dots)}</note>`;
      }
      flush(ch.position);
      ch.notes.forEach((nt, i) => { body += noteXml(ch, nt, ctx, i); });
      expect = ch.position.plus(ch.duration ?? new Fraction(0));
    }
  }
  flush(null);

  return `<measure number="${mid + 1}">${printEl}${attrs}${barlineXml(m, "left", prev, volta)}` +
    `${tempoEl}${markEl}${body}${barlineXml(m, "right", null, volta)}</measure>`;
}

// ---------------- top level ----------------
function creditXml(c: Credit): string {
  const words = c.text.split("\n").filter((s) => s.length)
    .map((s) => `<credit-words>${escapeXml(s)}</credit-words>`).join("");
  return `<credit page="${c.page + 1}">` +
    `${c.type ? `<credit-type>${escapeXml(c.type)}</credit-type>` : ""}${words}</credit>`;
}

export function scoreToMusicXml(score: Score, opt: MusicXmlOutOptions = {}): string {
  const divisions = collectDivisions(score);
  // keyChange 只有 MusicXML 导入路径会置 true；jpw 路径永不置，那时才需要推断。
  const hasKey = score.parts.some((p) => p.measures.some((m) => m.keyChange));
  const fifths = opt.fifths ?? (hasKey ? (score.parts[0]?.measures[0]?.key.fifths ?? 0) : deriveFifths(score));
  const ctx: OutCtx = {
    divisions, fifths, pairs: pairSlurTies(score), beams: collectBeams(score),
  };
  const events = collectEvents(score);
  const voltas = deriveVoltas(score);

  const partsXml = score.parts.map((part, pi) => {
    const ms = part.measures.map((m, mid) =>
      measureXml(m, mid, ctx, events.get(mid) ?? [], opt, pi === 0 ? score.playData.tempo : 0,
        part.measures[mid - 1] ?? null, pi === 0 ? voltas.get(mid) : undefined),
    ).join("");
    return `<part id="P${pi + 1}">${ms}</part>`;
  }).join("");

  const partList = score.parts.map((_, pi) =>
    // 不给乐器名：Dorico/MuseScore 会把 <part-name> 当乐器名显示在谱前，简谱没有这个概念。
    // 空内容 + print-object="no"，两种软件都不显示。
    `<score-part id="P${pi + 1}"><part-name print-object="no"></part-name></score-part>`,
  ).join("");

  const workXml = score.title ? `<work><work-title>${escapeXml(score.title)}</work-title></work>` : "";
  const identXml = score.creator.size
    ? `<identification>${[...score.creator].map(([k, v]) =>
        `<creator type="${escapeAttr(k)}">${escapeXml(v)}</creator>`).join("")}</identification>`
    : "";
  const creditsXml = score.credit.map(creditXml).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.0">
${workXml}${identXml}${creditsXml}<part-list>${partList}</part-list>
${partsXml}
</score-partwise>`;
}

/** 供 patch 复用：不带 Score 上下文地生成一个 <note> 片段。 */
export function makeNoteXml(ch: Chord, nt: Note, divisions: number, fifths: number, idx: number): string {
  return noteXml(ch, nt, { divisions, fifths }, idx);
}
