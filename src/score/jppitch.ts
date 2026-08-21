// 简谱数字 → 五线谱音高拼写（step/alter/octave）。原本内联在 src/omr/musicxml.ts，
// 因 MusicXML 导出（musicxmlout.ts / musicxmlpatch.ts）也要用同一套换算而提出来共享——
// 两份实现一旦漂移，导出→导入的往返数字就会错，故只留这一处。
//
// 可动 do：数字 1=主音，按调号求该音级的升降。与导入器 score.ts::Note.init 严格互逆。

import { MusicCommon } from "./score";

/** C 大调音名表（fifths=0 时 1..7 对应 C D E F G A B）。 */
export const STEPS = ["C", "D", "E", "F", "G", "A", "B"];

/** fifths→主音音级索引(0=C，CDEFGAB 顺序)。与 score.ts::Note.init 的 b=(4f+28)%7 一致，
 *  保证导出→导入数字往返一致。 */
export function tonicStep(fifths: number): number {
  return (((4 * fifths + 28) % 7) + 7) % 7;
}

// 调号升降：升序 F C G D A E B、降序 B E A D G C F（与 score.ts::getAlter/fifthCircle 同）。
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];

export function keyAlter(stepIdx: number, fifths: number): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(stepIdx) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).includes(stepIdx) ? -1 : 0;
  return 0;
}

/** 数字音符 → {step, alter, octave(科学记号)}。digit 1-7，octave 为简谱八度点偏移。 */
export function jpPitch(digit: number, jpOctave: number, fifths: number): {
  step: string; alter: number; octave: number;
} {
  const tonic = tonicStep(fifths);
  const degree = Math.max(1, Math.min(7, digit)) - 1; // 0-based
  const stepIdx = (tonic + degree) % 7;
  const wrap = Math.floor((tonic + degree) / 7);
  // 导入器对 A/B/Bb 调(fifths 3/5/-2)会把 jpOctave +1，导出端预先 -1 抵消以保往返。
  const extra = (fifths === 3 || fifths === 5 || fifths === -2) ? 1 : 0;
  const octave = 4 + jpOctave + wrap - extra;
  return { step: STEPS[stepIdx], alter: keyAlter(stepIdx, fifths), octave };
}

// ---------------- 简谱表述 → Note.pitch（导入侧） ----------------
// jpwimport（.jpwabc）与 pu/toscore（文本谱）都要把简谱表述落成 Note.pitch/step。
// 两处曾各写一份逐行同构的 calcPitch——音高或临时记号算错就是错音，故只留这一处。

/** 一个声部在小节内的调号状态。`alter` 是**小节内延续**的临时记号（按简谱数字键）。 */
export interface JpKeyState {
  basePitch: number;
  fifths: number;
  alter: Record<string, number>;
}

/** 把简谱表述（number / jpOctave / jpAlter）落成 nt.pitch 与 nt.step，并更新 stat.alter。
 *  `0` 是休止：pitch 归零、置 rest。 */
export function applyJpPitch(stat: JpKeyState, nt: {
  number: string; jpOctave: number; jpAlter: string;
  pitch: number; step: string; rest: boolean; chord: { rest: boolean };
}): void {
  if (nt.number === "0") {
    nt.pitch = 0;
    nt.rest = true;
    nt.chord.rest = true;
    return;
  }
  let res = stat.basePitch + nt.jpOctave * 12 + MusicCommon.stepToPitch(nt.number);
  nt.step = MusicCommon.jpToStep(nt.number, stat.fifths);
  switch (nt.jpAlter) {
    case "b": stat.alter[nt.number] = -1; break;
    case "n": delete stat.alter[nt.number]; break;
    case "#": stat.alter[nt.number] = 1; break;
  }
  res += stat.alter[nt.number] ?? 0;
  nt.pitch = res;
}
