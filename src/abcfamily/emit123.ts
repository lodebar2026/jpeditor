// 123 方言的写出端。只回答基类问的那几个问题，其余全在 `emit.ts`。

import type { Chord, Element, Key, Measure, Note, Song } from "../model/doc";
import { AbcFamilyEmitter, type MarkIndex } from "./emit";
import { BARE_CHORD_RE } from "./dialect123";
import { projectForJianpu } from "../model/jianpuproject";
import { harmonyText, keySpelling, melodyLane, topNote } from "../model/jianpu";

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
  protected override readonly spaceBeams = false;

  /** 123 没有音符堆（规范：和弦走符号 `"Am7"`，不做 `[1 3 5]`），一个声部也只有一路：
   *  只写简谱印的那一路（`melodyLane`）、那一路里每个和弦最高的音。其余的由 `planSave` 报「noteStack」丢失。
   *  以前挨着写成 `35`，读回来成了两个先后的音，时值翻倍（Praise as One/万古磐石 42 个音读回 84 个）。 */
  protected override emits(el: Element, mea: Measure): boolean {
    if (el.kind !== "chord") return true;
    const lane = melodyLane(mea);
    return !lane || (el.staff === lane.staff && el.voice === lane.voice);
  }

  protected override chordNotes(ch: Chord): Note[] {
    const top = topNote(ch);
    return top ? [top] : [];
  }

  /** 和弦名合规就**不带引号**（`F 3-`），后面必须跟空格——读入端按「到空白为止」切，123 的空格又不管分组。
   *  `N.C.` 这类不合规的仍写引号形。 */
  protected override chordSymbolText(text: string): string {
    return BARE_CHORD_RE.test(text) ? `${text} ` : `"${text}"`;
  }

  /** `$` 后换行：一行曲一行源码，方便与源图逐行对照。123 的代码换行不是谱面换行，读回不变。 */
  protected override breakText(newPage: boolean): string {
    return newPage ? "$$\n" : "$\n";
  }

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
      s += su.harmony ? ` ${this.chordSymbolText(harmonyText(su.harmony))}-` : "-";
      s += ")".repeat(mi?.slurEnd.get(su.id) ?? 0);
    }
    return s;
  }

  /** 主音唱名非 1 时写简谱首调形（`6=E`），否则写 `1=X`。 */
  protected keyValue(k: Key): string {
    if (k.spelling === "none") return "none";
    const sp = keySpelling(k);
    const degree = k.tonicDegree ?? "1";
    return `${degree}=${sp}`;
  }
}

export const EMITTER_123 = new Emitter123();
