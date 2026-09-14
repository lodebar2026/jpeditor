// 简谱数字 → 五线谱音高拼写（step/alter/octave）。原本内联在 src/omr/musicxml.ts，
// 因 MusicXML 导出（model/xmlproject.ts，原先还有 model/fromscore.ts）也要用同一套换算而提出来共享——
// 两份实现一旦漂移，导出→导入的往返数字就会错，故只留这一处。
//
// 可动 do：数字 1=主音，按调号求该音级的升降。与导入器 score.ts::Note.init 严格互逆。


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

/**
 * 无点的「1」落在 **B3(59) … A4(69)** 这一个八度里，按调号依次往上：
 * C4=60, D4=62, E4=64, F4=65, G4=67, A4=69，到 B 就翻回下面的 B3=59
 * （升降号在此基础上 ±1 半音：bB=58, bA=68, #C=61, bD=61, #F=bG=66, bE=63, bC=59）。
 * 依据是《简谱通用规范》第 23-24 页的各调音域对照表（各调都画满 C2..C6 的五线谱—简谱
 * 对照，逐行看无点的 1 落在哪个音）。
 *
 * 所以只有**主音字母是 B** 的调（B / bB）整体降一个八度 —— A / bA 不降。
 * 曾经两处口径都不对且互不一致：`getBasePitch` 按字母 `"AB"` 判（把 A/bA 也压到 A3），
 * `Note.init` 写死 fifths ∈ {3,5,-2}（含 A、又漏 bA），同一首 bA 调的谱走 .jpwabc
 * 与走 MusicXML 进来能差一个八度。
 */
export function jpTonicOctaveShift(fifths: number): number {
  return tonicStep(fifths) === 6 /* B */ ? 1 : 0;
}

/** 数字音符 → {step, alter, octave(科学记号)}。digit 1-7，octave 为简谱八度点偏移。 */
export function jpPitch(digit: number, jpOctave: number, fifths: number): {
  step: string; alter: number; octave: number;
} {
  const tonic = tonicStep(fifths);
  const degree = Math.max(1, Math.min(7, digit)) - 1; // 0-based
  const stepIdx = (tonic + degree) % 7;
  const wrap = Math.floor((tonic + degree) / 7);
  // 导入器对主音字母 B 的调会把 jpOctave +1，导出端预先 -1 抵消以保往返。
  const octave = 4 + jpOctave + wrap - jpTonicOctaveShift(fifths);
  return { step: STEPS[stepIdx], alter: keyAlter(stepIdx, fifths), octave };
}

// ---------------- 简谱表述 → Note.pitch（导入侧） ----------------
// `.jpwabc` 读入（model/fromjpw.ts）与试听输入（pu/phrasesong.ts）都要把简谱表述落成 pitch/step。
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

export class MusicCommon {
  static readonly fifthCircle = [4, 1, 5, 2, 6, 3, 7];
  static readonly steps = "CDEFGAB";
  static readonly keys = [
    "bC", "bG", "bD", "bA", "bE", "bB", "F",
    "C", "G", "D", "A", "E", "B", "#F", "#C",
  ];

  static readonly _stepToPitch: Record<string, number> = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
    "1": 0, "2": 2, "3": 4, "4": 5, "5": 7, "6": 9, "7": 11,
  };

  static stepToPitch(st: string): number {
    if (!(st in MusicCommon._stepToPitch)) throw new Error("");
    return MusicCommon._stepToPitch[st];
  }

  /**
   * 简谱数字 → 音名字母。字母取自调号的**拼写**（fifths → keys[]），不是 basePitch：
   * 同音高的升/降两种拼写字母不同（#C 的 1 是 C、bD 的 1 是 D；#F 对 bG 同理），
   * 只看 basePitch 分不开。原 Kotlin 按 basePitch 查表，bD/#C/bG/#F 四个调根本没有
   * 表项、直接抛错——`1=#C` 的谱因此整首排不出来（代码区有文本、排版是空的）。
   */
  static jpToStep(num: string, fifths: number): string {
    const tonic = MusicCommon.keys[fifths + 7];
    if (!tonic) throw new Error("");
    const letter = tonic[tonic.length - 1]; // 去掉 b/# 前缀
    const idx = MusicCommon.steps.indexOf(letter) + (num.charCodeAt(0) - "1".charCodeAt(0));
    return MusicCommon.steps[idx % 7];
  }

  /** 音名字母在该调号下的固定升降。实现只在 jppitch.ts::keyAlter 一处
   *  （原来这里另有一份用 fifthCircle 的等价实现，两份漂移就会出错音）。 */
  static getAlter(st: string, fifths: number): number {
    return keyAlter(MusicCommon.steps.indexOf(st), fifths);
  }

  static getBasePitchOfKey(key: { fifths: number }): number {
    return MusicCommon.getBasePitch(MusicCommon.keys[key.fifths + 7]);
  }

  static keyNameToFifth(n: string): number {
    let nn = n;
    if (nn.length === 2) {
      if (n[1] === "b" || n[1] === "#") nn = `${n[1]}${n[0]}`;
    }
    return MusicCommon.keys.indexOf(nn) - 7;
  }

  static getBasePitch(key: string): number {
    let res = 0;
    let step = key;
    if (step.includes("b")) {
      res = -1;
      step = step.replace(/b/g, "");
    }
    if (step.includes("#")) {
      res = 1;
      step = step.replace(/#/g, "");
    }
    res += MusicCommon.stepToPitch(step[0]);
    // 无点 1 落在 B3..A4 一个八度里，只有字母 B 的调降八度（《简谱通用规范》23-24 页的
    // 各调音域对照表；判据与 jppitch.ts::jpTonicOctaveShift 同源，那边按 fifths 判）。
    res += step[0] === "B" ? 48 : 60;
    return res;
  }
}

/** 调号（fifths）与它的调名拼写（`bB` / `#F` / `C`…）。 */
export class Key {
  fifths = 0;
  get name(): string {
    const wr = "CDEFGAB";
    const b = (4 * this.fifths + 28) % 7;
    let res = "";
    if (this.fifths < -1) res += "b";
    else if (this.fifths === 7) res += "#";
    res += wr[b];
    return res;
  }
}
