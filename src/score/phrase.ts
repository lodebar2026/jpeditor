// 乐句分析：综合歌词标点 + 音乐信号（延长号/终止线/长音/休止/连线）与「重复旋律」结构，
// 在小节边界上找乐句断点，并凑成不太稀疏也不太密的行长。供 scoreToJpwabc 的乐句排版模式使用。
// 返回 measureBreaks（作为「新行起点」的小节下标，与 Measure.newSystem 同义）与 midBreaks
// （在弱起谱里乐句尾——休止/长音——被并进下一小节时，改在该「行内」和弦后换行；含标点/句号处）。

import { Chord, Part } from "./score";
import { BarStyle } from "./enums";
import { Fraction } from "../common/fraction";

export interface PhraseBreaks {
  measureBreaks: Set<number>; // 小节边界换行：在该下标小节前起新行
  midBreaks: Set<Chord>;      // 行内换行：在该和弦（乐句尾休止/长音）之后换行，不加小节线
}

// 句末 / 句中标点（读 Note.lyrics 原文，未被 jpscore 剥离）。
const PUNCT_END = /[。！？…]$/;
const PUNCT_MID = /[，、；：]$/;

// 行长以「小节数」计（简谱/圣诗按小节成行，与音符密度无关）。经验初值，可回归调参。
const MIN_MEAS = 3;
const TARGET_MEAS = 4;
const MAX_MEAS = 7;

function chordsOf(m: { entries: unknown[] }): Chord[] {
  return m.entries.filter((e): e is Chord => e instanceof Chord);
}

// 小节旋律指纹：各和弦「音级+八度」（休止记 R），供重复段检测与平行断行复用。
function measureFp(chords: Chord[]): string {
  return chords
    .map((c) => {
      const nt = c.notes[0];
      if (!nt || c.rest) return "R";
      return nt.number + ":" + nt.jpOctave;
    })
    .join(",");
}

export function computePhraseBreaks(part: Part): PhraseBreaks {
  const measures = part.measures;
  const n = measures.length;
  const measureBreaks = new Set<number>();
  const midBreaks = new Set<Chord>();
  if (n <= 1) return { measureBreaks, midBreaks };

  const chordsPer = measures.map((m) => chordsOf(m));
  const fpPer = chordsPer.map((cs) => measureFp(cs));

  // 重复旋律：找指纹序列上的极大重复连续段（长度≥2 节），其两端边界加分。
  const repeatEdges = new Set<number>(); // 小节下标 i：i 之后是重复段边界
  for (let L = 2; L <= Math.floor(n / 2); L++) {
    for (let a = 0; a + L <= n; a++) {
      for (let b = a + L; b + L <= n; b++) {
        let same = true;
        for (let k = 0; k < L; k++) {
          if (fpPer[a + k] !== fpPer[b + k] || fpPer[a + k] === "") { same = false; break; }
        }
        if (!same) continue;
        repeatEdges.add(a - 1); repeatEdges.add(a + L - 1);
        repeatEdges.add(b - 1); repeatEdges.add(b + L - 1);
      }
    }
  }

  // 每小节实际时值（各和弦时值之和，弱起/末小节都稳）；用于把绝对位置换算成「小节数」（单位无关）。
  const measureDur = chordsPer.map((cs) => cs.reduce((s, c) => s + (c.duration?.toFloat() ?? 0), 0) || 1);

  // 把所有和弦拍平成有序序列，逐和弦记：所在小节、是否小节末、以「小节数」为单位的结束位置（可含小数）。
  interface CInfo { chord: Chord; mi: number; isLast: boolean; pos: number; }
  const flat: CInfo[] = [];
  for (let i = 0; i < n; i++) {
    const cs = chordsPer[i];
    for (let k = 0; k < cs.length; k++) {
      const c = cs[k];
      const within = c.position.plus(c.duration ?? new Fraction(0)).toFloat() / measureDur[i];
      flat.push({ chord: c, mi: i, isLast: k === cs.length - 1, pos: i + Math.min(1, within) });
    }
  }
  const K = flat.length;
  if (K === 0) return { measureBreaks, midBreaks };

  // 逐和弦：slur+tie 括号深度（>0 不可断，否则拆断 ( )）；歌词标点分「顺延」到其所在 slur/tie 组收尾、
  // 并越过紧随的休止（句号音符后常带休止，断点应落在休止之后，如基督更美的 1 0）→ 归到该可断和弦。
  const depthAfter = new Array<number>(K).fill(0);
  const punctAfter = new Array<number>(K).fill(0);
  {
    let depth = 0;
    let pending = 0;
    for (let idx = 0; idx < K; idx++) {
      const c = flat[idx].chord;
      const nt = c.notes[0];
      if (nt?.tieStart) depth++;
      if (c.slurStart) depth++;
      const lrc = nt?.lyrics.find((l) => l.number === 1 || l.refrain) ?? nt?.lyrics[0];
      const txt = lrc?.text ?? "";
      const p = PUNCT_END.test(txt) ? 6 : PUNCT_MID.test(txt) ? 4 : 0;
      if (p > pending) pending = p;
      if (nt?.tieEnd && depth > 0) depth--;
      if (c.slurEnd && depth > 0) depth--;
      depthAfter[idx] = depth;
      // 顺延规则：仅当「本音符是音符且其后紧跟本小节内的休止」时继续顺延（句号音符尾随的休止就是落点）；
      // 一旦到了休止本身就在此落定，不再卷入随后的八分弱起休止（世上句号后 0 落定、不吞下一句 0_）。
      const next = flat[idx + 1];
      const carryOn = !c.rest && !!next && next.chord.rest && next.chord.beams === 0 && next.mi === flat[idx].mi;
      if (depth === 0 && !carryOn) { punctAfter[idx] = pending; pending = 0; }
    }
  }

  // 断点候选的乐句强度分（在该和弦之后换行）。
  const scoreAt = (idx: number): number => {
    const ci = flat[idx];
    const c = ci.chord;
    let s = punctAfter[idx]; // 句号 6 / 逗号 4（已顺延到 slur/tie/休止 收尾）
    if (c.fermata) s += 5;
    if (c.beats >= 2) s += 4;              // 长音收尾
    if (c.rest && c.beams === 0) s += 1;   // 四分及以上休止（弱信号）
    if (ci.isLast) {
      const m = measures[ci.mi];
      if (m.repeatBackward || m.barline === BarStyle.LIGHT_HEAVY || m.barline === BarStyle.LIGHT_LIGHT) s += 5;
      if (repeatEdges.has(ci.mi)) s += 4;
    }
    return s;
  };

  // 候选断点：括号闭合（depth 0）且「小节末」或「带乐句信号」的和弦；末音强制入选（曲末）。
  const cand: number[] = [];
  for (let idx = 0; idx < K; idx++) {
    if (depthAfter[idx] !== 0) continue;
    if (flat[idx].isLast || scoreAt(idx) > 0) cand.push(idx);
  }
  if (cand[cand.length - 1] !== K - 1) cand.push(K - 1);
  const M = cand.length;

  // 全局 DP（类 Knuth-Plass）：行长以「小节数」计（含小数，跨弱起/切分仍准），
  // 最小化 Σ(行长偏差² + 断点弱罚)。断点可落在小节中间（如句号在小节内的 slur/tie 收尾）。
  const ends = [0, ...cand.map((i) => flat[i].pos)]; // ends[0]=曲首；断点 b∈1..M 对应 cand[b-1]
  const INF = Number.POSITIVE_INFINITY;
  const BASE_BREAK = 8;
  const lenCost = (meas: number): number => (meas > MAX_MEAS ? INF : (meas - TARGET_MEAS) ** 2);

  const dp = new Array<number>(M + 1).fill(INF);
  const nextB = new Array<number>(M + 1).fill(-1);
  dp[M] = 0;
  for (let a = M - 1; a >= 0; a--) {
    for (let b = a + 1; b <= M; b++) {
      const meas = ends[b] - ends[a];
      if (meas > MAX_MEAS) break;
      if (b < M && meas < MIN_MEAS) continue; // 非末行须达 MIN；末行可短
      const bc = b === M ? 0 : Math.max(0, BASE_BREAK - scoreAt(cand[b - 1]));
      const cost = lenCost(meas) + bc + dp[b];
      if (cost < dp[a]) { dp[a] = cost; nextB[a] = b; }
    }
  }

  // 回溯：每个选中断点 cand[b-1]，小节末→小节边界换行，否则→行内换行。
  for (let a = nextB[0]; a > 0 && a < M; a = nextB[a]) {
    const ci = flat[cand[a - 1]];
    if (ci.isLast) measureBreaks.add(ci.mi + 1);
    else midBreaks.add(ci.chord);
  }
  return { measureBreaks, midBreaks };
}
