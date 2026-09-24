// ABC 的临时记号（§4.2）：音名 + 记号是**绝对**的——`K:F` 里的 `B` 是 B♭，`=B` 是 B 本位，`^B` 是 B♯；
// 记号管到本小节末，只管同音名同八度的音。简谱的记号却相对调号、按唱名延续（`jianpu.ts::AccidentalCarry`）。
// 读写两端各走一个方向，共用这一份状态规则，写出的 ABC 读回来音高才对：
//   - 读：音名 + 面上的记号 → 实际音高（`resolveAbcPitches`），度数再由 `assignDegrees` 从音高推
//   - 写：只有度数的音（123/文本谱/`.jpwabc`）→ 实际音高 + 面上要印的记号（`withAbcPitches`）

import type { Accidental, Key, Measure, Pitch, Song } from "../model/doc";
import { AccidentalCarry, assignDegrees, continuesMeasure } from "../model/jianpu";
import { MusicCommon, keyAlter } from "../score/jppitch";

const STEPS = "CDEFGAB";

const ALTER_OF: Readonly<Record<Accidental, number>> = {
  "double-flat": -2, flat: -1, natural: 0, sharp: 1, "double-sharp": 2,
};
const ACC_OF: Readonly<Record<number, Accidental>> = {
  [-2]: "double-flat", [-1]: "flat", 0: "natural", 1: "sharp", 2: "double-sharp",
};

/** 调号的升降号数。123 认不出 `fifths` 而只留了拼写的（`xmlproject.ts::projectPart` 同一口径）按拼写补。 */
function fifthsOf(key: Key): number {
  if (key.fifths === 0 && key.spelling && key.spelling !== "none") {
    const f = MusicCommon.keyNameToFifth(key.spelling);
    if (f >= -7 && f <= 7) return f;
  }
  return key.fifths;
}

/** 一小节里 ABC 记号的延续状态：同音名同八度 → 实际升降。 */
class AbcCarry {
  private alters = new Map<string, number>();
  constructor(private readonly fifths: number) {}

  private expected(p: Pick<Pitch, "step" | "octave">): number {
    return this.alters.get(p.step + p.octave) ?? keyAlter(STEPS.indexOf(p.step), this.fifths);
  }

  /** 读：面上的记号（没有就沿用本小节前面的，再没有就是调号）→ 实际升降。 */
  sounding(p: Pick<Pitch, "step" | "octave">, written?: Accidental): number {
    if (!written) return this.expected(p);
    const alter = ALTER_OF[written];
    this.alters.set(p.step + p.octave, alter);
    return alter;
  }

  /** 写：实际音高 → 面上要印的记号（与调号、本小节前面的都相同就不印）。 */
  written(p: Pitch): Accidental | undefined {
    if (p.alter === this.expected(p)) return undefined;
    this.alters.set(p.step + p.octave, p.alter);
    return ACC_OF[p.alter];
  }
}

/** 逐小节走一首歌的和弦音，每小节（拆开的后半接着前半）给一份新的延续状态。 */
function eachMeasure(song: Song, fn: (m: Measure, key: Key, fresh: boolean) => void): void {
  for (const part of song.parts) {
    let key: Key = song.key ?? { fifths: 0 };
    part.measures.forEach((m, mi) => {
      if (m.attrs?.key) key = m.attrs.key;
      fn(m, key, !continuesMeasure(part.measures[mi - 1], m));
    });
  }
}

/** ABC 读入：把音名 + 面上记号换成实际音高，再按简谱规则推度数（面上的简谱记号由 `AccidentalCarry.mark` 定）。 */
export function resolveAbcPitches(song: Song): void {
  let carry = new AbcCarry(0);
  eachMeasure(song, (m, key, fresh) => {
    if (fresh) carry = new AbcCarry(fifthsOf(key));
    for (const el of m.elements) {
      if (el.kind !== "chord") continue;
      for (const n of el.notes) if (n.pitch) n.pitch = { ...n.pitch, alter: carry.sounding(n.pitch, n.accidental) };
    }
  });
  for (const part of song.parts) assignDegrees(part, song.key ?? { fifths: 0 });
}

/** 有没有只给度数、没有绝对音高的音（简谱形状的来源）。 */
function hasDegreeOnly(song: Song): boolean {
  return song.parts.some((p) => p.measures.some((m) => m.elements.some((el) =>
    el.kind === "chord" && el.notes.some((n) => !n.pitch && n.degree && n.degree.number > 0))));
}

/** ABC 写出前：简谱形状的歌在克隆上补实际音高（`AccidentalCarry.pitch`，按唱名延续），
 *  再按 ABC 规则重定面上的记号。已经带音高的歌原样返回。 */
export function withAbcPitches(src: Song): Song {
  if (!hasDegreeOnly(src)) return src;
  const song: Song = structuredClone(src);
  let jp = new AccidentalCarry();
  let abc = new AbcCarry(0);
  eachMeasure(song, (m, key, fresh) => {
    const k: Key = { ...key, fifths: fifthsOf(key) };
    if (fresh) {
      jp = new AccidentalCarry();
      abc = new AbcCarry(k.fifths);
    }
    for (const el of m.elements) {
      if (el.kind !== "chord") continue;
      for (const n of el.notes) {
        const fromDegree = n.degree && n.degree.number > 0 ? jp.pitch(n.degree, k) : undefined;
        n.pitch ??= fromDegree;
        if (!n.pitch) continue;
        const acc = abc.written(n.pitch);
        if (acc) n.accidental = acc;
        else delete n.accidental;
      }
    }
  });
  return song;
}
