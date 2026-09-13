// 123 方言的写出端。只回答基类问的那几个问题，其余全在 `emit.ts`。

import type { Chord, Element, Note, Song } from "../model/doc";
import { AbcFamilyEmitter, type MarkIndex } from "./emit";
import { projectForJianpu } from "../model/jianpuproject";
import { harmonyToText } from "../score/harmonyparse";

const ACC_TEXT: Readonly<Record<string, string>> = {
  sharp: "#",
  flat: "b",
  natural: "n",
  "double-sharp": "##",
  "double-flat": "bb",
};

export class Emitter123 extends AbcFamilyEmitter {
  protected readonly versionLine = "%123-1.0";
  protected override readonly tiesAsSlurs = true;

  /** MusicXML 读进来的歌先投成简谱形状：123 的 `-` 是增时线、`_` 是减时线，照 MusicXML 的 type/beam 直写会写错时值 */
  override emitSong(song: Song, fallbackNumber?: number): string {
    return super.emitSong(projectForJianpu(song), fallbackNumber);
  }

  /** 度数 + 八度点。变音记号**前置**（简谱惯例）。 */
  protected noteText(n: Note): string {
    const d = n.degree;
    if (!d) {
      // 只有绝对音高、没有度数（从 MusicXML 来且还没换算）——写成 0 并留给调用方报降级
      return n.pitch ? "0" : "";
    }
    let s = "";
    if (d.accidental) s += ACC_TEXT[d.accidental] ?? "";
    s += String(d.number);
    s += d.octaveShift > 0 ? "'".repeat(d.octaveShift) : ",".repeat(-d.octaveShift);
    return s;
  }

  /** `printObject === false` 是**不可见休止**，123 有专门的 `x`，写成 `0` 会丢掉「不可见」。 */
  protected restText(ch: Chord): string {
    return ch.printObject === false ? "x" : "0";
  }

  protected durationText(el: Element): string {
    const beams = el.kind === "chord" ? el.beams?.length ?? 0 : el.beams?.length ?? 0;
    const dots = el.kind === "chord" ? el.duration.dots : el.duration?.dots ?? 0;
    return "_".repeat(beams) + ".".repeat(dots);
  }

  /** 增时线（各自可带弧的起止）。**这是 123 独有的**：ABC 的 `-` 是 tie。 */
  protected override sustainsText(ch: Chord, mi?: MarkIndex): string {
    let s = "";
    for (const su of ch.sustains ?? []) {
      s += "(".repeat(mi?.slurStart.get(su.id) ?? 0);
      s += su.harmony ? ` "${harmonyToText(su.harmony)}"-` : "-";
      s += ")".repeat(mi?.slurEnd.get(su.id) ?? 0);
    }
    return s;
  }

  /** 主音唱名非 1 时写简谱首调形（`6=E`），否则写 `1=X`。 */
  protected keyText(song: Song): string | null {
    const k = song.key;
    if (!k) return null;
    if (k.spelling === "none") return "none";
    const sp = k.spelling ?? "C";
    const degree = k.tonicDegree ?? "1";
    return `${degree}=${sp}`;
  }
}

export const EMITTER_123 = new Emitter123();
