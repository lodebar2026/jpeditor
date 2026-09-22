// 演唱顺序：反复、房号、D.C./D.S./Coda、多段歌词逐段一遍，推成 `PlayItem[]`。
//
// 演唱顺序的唯一实现（判据从 mp/score 移植）。只经下面这组接口读谱，`ScoreDoc` 两侧拼出满足接口的纯对象：
// MusicXML 形状 `model/playdoc.ts`、简谱形状 `model/playsong.ts`。
//
// 产物 `PlayItem[]` 的消费者：试听/MIDI（`timeline.ts`）、展开档（`jianpu/expand.ts::walkPlay`）、断句。

import { Fraction } from "../common/fraction";
import { StartStopDiscontinue } from "./enums";

// ───────────────────────── 产物 ─────────────────────────

export enum PlaySpecKind {
  Dacapo,
  DalSegno,
  ToCoda,
  Fine,
}

export class JumpSpec {
  value: unknown = null;
  constructor(public kind: PlaySpecKind) {}
}

export class TimePosition {
  mid = 0;
  pass = 0;
  offset = new Fraction(0);
  constructor(m?: number, t?: Fraction) {
    if (m !== undefined && t !== undefined) {
      if (m < 0) throw new Error("");
      this.mid = m;
      this.offset = t;
    }
  }
  compareTo(a: TimePosition): number {
    const diff = this.mid - a.mid;
    if (diff !== 0) return diff;
    return this.offset.minus(a.offset).compareTo(new Fraction(0));
  }
}

export class PlayItem extends TimePosition {
  end = 0;
  endOfPass = false;
  /** 首小节要跳过的和弦个数（弱起式接入，`.Repeat` 里写作 `11.2-20V4`）。 */
  skip = 0;
  /** 末小节只取前这么多个和弦（-1 = 整节，`.Repeat` 里写作 `11.1-11.1V1`）。 */
  limit = -1;
  clone(): PlayItem {
    const p = new PlayItem();
    p.mid = this.mid;
    p.pass = this.pass;
    p.offset = this.offset;
    p.end = this.end;
    p.endOfPass = this.endOfPass;
    p.skip = this.skip;
    p.limit = this.limit;
    return p;
  }
}

export class PlayData {
  coda = new Map<string, TimePosition>();
  segno = new Map<string, TimePosition>();
  jumpTo = new Map<TimePosition, JumpSpec>();
  measures: PlayItem[] = [];
  hasRepeat = false;
  isSimpple = false; // no repeat, only multiple verse
  /** 谱面速度（♩= 每分钟拍数）。0 = 未标注，试听/导出用 timeline.ts 的默认值。
   *  来源：MusicXML `<sound tempo>` / OMR 页眉的 `♩=76` / .jpwabc `.Title` 的 `Tempo`。 */
  tempo = 0;

  get noRepeat(): boolean {
    if (this.hasRepeat) return false;
    if (this.coda.size > 0 || this.segno.size > 0) return false;
    if (this.jumpTo.size > 0) return false;
    return true;
  }
}

// ───────────────────────── 输入形状 ─────────────────────────

export interface PlayLyric {
  readonly number: number;
}

export interface PlayNote {
  readonly tieStart: boolean;
  readonly tieEnd: boolean;
  readonly lyrics: readonly PlayLyric[];
}

export interface PlayChord {
  readonly notes: readonly PlayNote[];
  /** 小节内位置（四分音符为 1） */
  readonly position: Fraction;
  readonly slurStart: boolean;
  readonly slurEnds: number;
}

export interface PlayMeasure {
  /** 和弦与其它条目混排；只取 `isPlayChord` 为真的那些。 */
  readonly entries: readonly object[];
  /** 小节时值（末和弦的位置 + 时值）。**没有和弦时抛错**，与 `layout/input.ts::measureDuration` 同口径。 */
  readonly duration: Fraction;
  readonly repeatBackward: boolean;
  readonly repeatForward: boolean;
  readonly endingLeft: boolean;
  readonly endingNum: ReadonlySet<number> | null;
  readonly endingRight: StartStopDiscontinue | null;
}

export interface PlayPart {
  readonly measures: readonly PlayMeasure[];
}

/** 跳转记号与其落点。键的**插入次序**有意义（同一小节几个记号按它先后判）。 */
export interface PlayJumps {
  readonly coda: ReadonlyMap<string, TimePosition>;
  readonly segno: ReadonlyMap<string, TimePosition>;
  readonly jumpTo: ReadonlyMap<TimePosition, JumpSpec>;
}

export function isPlayChord(e: object): e is PlayChord {
  return "notes" in e && "slurEnds" in e;
}

export interface PlayOrder {
  measures: PlayItem[];
  /** 没有反复、只是多段歌词逐段一遍 */
  isSimple: boolean;
  /** 谱面有 `:|` */
  hasRepeat: boolean;
}

// ───────────────────────── 推理 ─────────────────────────

/** 由谱面结构推演唱顺序（反复记号、房号、跳转）。反复与跳转只看 `parts[0]`，歌词段数取各声部最大值。 */
export function playOrderOf(parts: readonly PlayPart[], jumps: PlayJumps): PlayOrder {
  const rep = new RepeatProcessor(parts, jumps);
  const pos = new TimePosition();
  pos.pass = 1;
  const measures = parts[0]!.measures;
  while (pos.mid < measures.length) {
    const end = rep.process(pos);
    if (end) break;
    if (pos.pass > 10) break;
    if (rep.result.length > 20) break;
  }
  let repeatByVerse = true;
  for (const m of rep.result) {
    const mea = measures[m.end - 1]!;
    let repStart = m.mid;
    for (let mid = m.mid; mid < m.end; mid++) {
      if (measures[mid]!.repeatForward) repStart = mid;
    }
    if (!mea.repeatBackward) continue;
    const verseCnt = rep.getPassCountByLrc(repStart, m.end);
    if (verseCnt > 1) repeatByVerse = false;
  }
  // 谱面写明了 2 号以上的房（1.2.3.5./4./6.）时，演唱遍数由房号显式给定、RepeatProcessor
  // 已按房展开；不能再按歌词段数把整份结果整体乘一遍（沧海一声笑会被乘成 6 倍）。
  let hasVolta = false;
  for (const m of measures) {
    if (m.endingNum && [...m.endingNum].some((n) => n > 1)) hasVolta = true;
  }
  // D.C./D.S. 同理：跳转记号本身就把曲子展开成了多遍（本曲 `D.C. al Fine`＝全曲唱一遍、
  // 回头唱到 Fine 为止，两遍正好配两段词），再按歌词段数整体乘一遍就成了四遍。
  const hasJump = jumps.jumpTo.size > 0;
  const isSimple = rep.result.length === 1;
  if (repeatByVerse && !hasVolta && !hasJump) rep.repeatByLyric();
  const out = expandVoltaByVerse(parts[0]!, rep.result) ?? rep.result;
  return { measures: out, isSimple, hasRepeat: measures.some((m) => m.repeatBackward) };
}

/** 不推、按段数整曲逐遍（没有反复信息时的退路）。`passes` 为 0 时返回空表。 */
export function playOrderByVerses(measureCount: number, passes: number): PlayItem[] {
  const out: PlayItem[] = [];
  for (let p = 0; p < passes; p++) {
    const item = new PlayItem();
    item.pass = p + 1;
    item.mid = 0;
    item.end = measureCount;
    out.push(item);
  }
  return out;
}

/** 显式给定的演唱顺序（`.Repeat` 段）。`part0` 用来把 skip 换成小节内位置。 */
export function playOrderFromSpec(repeat: { readonly items: readonly RepeatSpecItem[] }, part0: PlayPart | undefined): PlayItem[] {
  const out: PlayItem[] = [];
  for (const it of repeat.items) {
    const pit = new PlayItem();
    pit.mid = it.first;
    pit.end = it.last + 1;
    pit.pass = it.verse;
    pit.skip = it.skip;
    pit.limit = it.limit;
    pit.endOfPass = it.page;
    // 跳过起头几个音时，试听/MIDI 侧用 offset 裁掉同样的部分（buildTimeline 只认 offset）。
    const mea = part0?.measures[it.first];
    if (it.skip > 0 && mea) pit.offset = skipOffset(mea, it.skip);
    out.push(pit);
  }
  return out;
}

/** 歌词段号的种数（原 `Part.getVerseCount`）。 */
function verseCount(part: PlayPart, beg: number, end: number): number {
  const num = new Set<number>();
  part.measures.forEach((m, idx) => {
    if (idx < beg || idx >= end) return;
    for (const ent of m.entries) {
      if (!isPlayChord(ent)) continue;
      for (const n of ent.notes) for (const l of n.lyrics) num.add(l.number);
    }
  });
  return num.size;
}

/** 「一房只有第 1 段 + 歌词段数多于房数」的赞美诗谱（如《我心等候祢》）补救展开。
 *
 *  这类谱：A 段有 V 行歌词，一房只写第 1 行（第 1 段唱完回头、不进副歌），
 *  二房起的行整体上移一行（行 k ↔ 第 k+1 段，谱面常在行首标「2./3./4.」），
 *  末尾多出来的行则是收尾再唱一遍的副歌。RepeatProcessor 只按房数推 2 遍，
 *  第 3、4 段会整个丢掉；这里按歌词行数重排。
 *
 *  条件不满足时返回 null（普通两房两段谱不受影响）。 */
function expandVoltaByVerse(part: PlayPart, items: readonly PlayItem[]): PlayItem[] | null {
  const measures = part.measures;
  if (items.length === 0) return null;

  // 唯一一个 backward 反复，且带房号；其后须紧跟二房（endingLeft）。
  let backIdx = -1;
  for (let i = 0; i < measures.length; i++) {
    if (!measures[i]!.repeatBackward) continue;
    if (backIdx >= 0) return null; // 多处反复，不处理
    backIdx = i;
  }
  if (backIdx < 0) return null;
  const volta1End = backIdx + 1; // 一房尾后一格
  if (measures[backIdx]!.endingRight === null) return null;
  let volta1Beg = -1;
  for (let i = backIdx; i >= 0; i--) {
    if (measures[i]!.endingLeft) { volta1Beg = i; break; }
  }
  if (volta1Beg < 0) return null;
  const tailBeg = volta1End;
  if (tailBeg >= measures.length || !measures[tailBeg]!.endingLeft) return null;

  // 反复起点（无 forward 记号则从头）。
  let repStart = 0;
  for (let i = 0; i < volta1Beg; i++) if (measures[i]!.repeatForward) repStart = i;
  if (repStart >= volta1Beg) return null;

  const verses = verseCount(part, 0, measures.length);
  let maxPass = 0;
  for (const it of items) if (it.pass > maxPass) maxPass = it.pass;
  if (verses <= maxPass) return null; // 段数没有多出来，交给原逻辑
  if (verseCount(part, volta1Beg, volta1End) !== 1) return null; // 一房不止第 1 段，形态不符

  const tailVerses = verseCount(part, tailBeg, measures.length);
  const out: PlayItem[] = [];
  const push = (mid: number, end: number, pass: number): PlayItem => {
    const p = new PlayItem();
    p.mid = mid;
    p.end = end;
    p.pass = pass;
    out.push(p);
    return p;
  };
  // 二房开头那几个音是这一段的结束音（与一房同位），断句上归主歌、不归副歌，
  // 这样「…惟靠祢恩典我站立。」不会被拆到副歌那页去。
  const lead = voltaLead(measures, volta1Beg, volta1End, tailBeg);
  const tailStart = (p: PlayItem): void => {
    p.skip = lead;
    if (lead > 0) p.offset = skipOffset(measures[tailBeg]!, lead);
  };
  // 第 1 遍：A 段 + 一房（连续，合成一项），唱完回头、不进副歌。
  push(repStart, volta1End, 1).endOfPass = true;
  // 第 2..V 遍：A 段用第 k 行，二房+副歌用第 k-1 行（整体上移一行）。
  for (let k = 2; k <= verses; k++) {
    push(repStart, volta1Beg, k);
    const tv = k - 1;
    if (tv <= tailVerses && lead > 0) push(tailBeg, tailBeg + 1, tv).limit = lead; // 结束音，仍归主歌那页
    out[out.length - 1]!.endOfPass = true; // 主歌段末
    if (tv <= tailVerses) {
      const p = push(tailBeg, measures.length, tv);
      tailStart(p);
      p.endOfPass = true; // 副歌段末
    }
  }
  // 二房+副歌里没用掉的行 = 收尾再唱的副歌，每行追加一遍（同样从副歌起拍接入）。
  for (let v = verses; v <= tailVerses; v++) {
    const p = push(tailBeg, measures.length, v);
    tailStart(p);
    p.endOfPass = true;
  }
  out[out.length - 1]!.endOfPass = false; // 末遍不额外换页
  return out;
}

class RepeatProcessor {
  inEnding = false;
  endingActive = false;
  loopStart = 0;
  passCount = -1;
  inJump = false;
  /** 本小节的 D.C./D.S. 被当作「房内回头记号」处理过（见 play()）：外层据此跳过收房/反复判定。 */
  loopedBack = false;
  result: PlayItem[] = [];

  constructor(private readonly parts: readonly PlayPart[], private readonly jumps: PlayJumps) {}

  private doJump(m: TimePosition, t: TimePosition): void {
    this.inJump = true;
    m.mid = t.mid;
    const cur = new PlayItem();
    cur.pass = m.pass;
    cur.mid = t.mid;
    cur.end = t.mid + 1;
    cur.offset = t.offset;
    this.result.push(cur);
  }

  private play(m: TimePosition): boolean {
    const p0 = this.parts[0]!;
    const mid = m.mid;
    const mea = p0.measures[mid]!;
    const tbeg = new TimePosition(mid, new Fraction(0));
    const tend = new TimePosition(mid, mea.duration);
    let res = false;
    let seg: string | null = null;
    let tocoda: string | null = null;
    let dacapo = false;
    for (const [t, v] of this.jumps.jumpTo) {
      if (t.compareTo(tbeg) < 0) continue;
      if (t.compareTo(tend) > 0) continue;
      if (!this.inJump && v.kind === PlaySpecKind.DalSegno) seg = v.value as string;
      // 跳回之后再遇到 D.C. 不再跳（同 D.S.），否则没有 Fine 的 D.C. 会一直绕到 pass 上限
      if (!this.inJump && v.kind === PlaySpecKind.Dacapo) dacapo = true;
      if (this.inJump && v.kind === PlaySpecKind.ToCoda) tocoda = v.value as string;
      if (this.inJump && v.kind === PlaySpecKind.Fine) res = true;
    }
    let newItem = false;
    if (this.result.length === 0) {
      newItem = true;
    } else {
      const last = this.result[this.result.length - 1]!;
      if (mid !== last.end || m.pass !== last.pass) newItem = true;
      else last.end += 1;
    }
    if (newItem) {
      const cur = new PlayItem();
      cur.pass = m.pass;
      cur.mid = mid;
      cur.end = mid + 1;
      this.result.push(cur);
    }
    if (seg !== null) {
      let t = this.jumps.segno.get(seg);
      if (t === undefined) t = new TimePosition(parseInt(seg, 10) - 1, new Fraction(0));
      this.doJump(m, t);
    }
    if (tocoda !== null) {
      let t = this.jumps.coda.get(tocoda);
      if (t === undefined) t = new TimePosition(parseInt(tocoda, 10) - 1, new Fraction(0));
      this.doJump(m, t);
      this.inJump = false;
    }
    // 写在 `:|` 小节上的 D.C.（小兔子乖乖 `:|&dc`）：先把反复唱完，最后一遍才跳回曲首
    if (dacapo && !this.inEnding && mea.repeatBackward) {
      if (this.passCount < 0) {
        this.passCount = this.getPassCountByLrc(this.loopStart, mid + 1);
        if (this.passCount <= 1) this.passCount = 2;
      }
      if (m.pass < this.passCount) dacapo = false;
    }
    if (dacapo) {
      // 房内的 D.C.（沧海一声笑的「4.」房：1.2.3.5 房带 :||、4 房改用 D.C.、6 房收尾）：
      // 房号已经把遍数列全了，这里的 D.C. 只是这一遍的回头记号，与 :|| 等价——回到曲首后
      // **后续反复照常生效**，故不进 inJump 抑制模式。房外的 D.C. 仍按老规矩（跳回后不再反复）。
      const insideVolta = this.inEnding && m.pass < this.passCount;
      m.pass++;
      m.mid = -1;
      if (insideVolta) {
        this.loopedBack = true;
        this.inEnding = false;
        this.endingActive = false;
      } else {
        this.inJump = true;
      }
    }
    return res;
  }

  private getPassCountByEnding(mid: number): number {
    let res = 0;
    const meas = this.parts[0]!.measures;
    let idx = mid;
    while (idx < meas.length) {
      const mif = meas[idx++]!;
      const nums = mif.endingNum;
      if (!nums) continue;
      for (const n of nums) if (n > res) res = n;
      if (mif.endingRight === StartStopDiscontinue.DISCONTINUE) break;
    }
    return res;
  }

  private onStartEnding(mif: PlayMeasure, pass: number): void {
    if (this.inJump) return;
    this.inEnding = true;
    this.endingActive = mif.endingNum?.has(pass) === true;
  }

  private onRightEnding(m: TimePosition, resetPass: boolean): void {
    if (this.inJump) return;
    this.endingActive = false;
    this.inEnding = false;
    if (resetPass) {
      m.pass = 1;
      this.passCount = -1;
    }
  }

  private onForward(mid: number, pass: number): void {
    if (this.inJump) return;
    if (pass > 1) return;
    this.loopStart = mid;
  }

  private onBackward(m: TimePosition, mif: PlayMeasure): void {
    if (this.inJump) return;
    if (m.pass < this.passCount) {
      m.mid = this.loopStart;
      m.pass++;
    } else {
      m.mid++;
      if (mif.endingRight === null) m.pass = 1;
    }
  }

  private update(m: TimePosition): boolean {
    let active = true;
    if (this.inEnding) active = this.endingActive;
    if (active) return this.play(m);
    return false;
  }

  private getPassCountByLrcAll(): number {
    const meas = this.parts[0]!.measures;
    return this.getPassCountByLrc(0, meas.length);
  }

  /** 段数取各声部的最大值：合唱谱的歌词常只挂在某一个声部上（圣哉三一歌挂在 Q2）。 */
  getPassCountByLrc(beg: number, end: number): number {
    return Math.max(0, ...this.parts.map((p) => verseCount(p, beg, end)));
  }

  process(m: TimePosition): boolean {
    const p0 = this.parts[0]!;
    if (m.mid < 0) throw new Error("");
    const mif = p0.measures[m.mid]!;
    if (mif.endingLeft) {
      if (this.passCount < 0) this.passCount = this.getPassCountByEnding(m.mid);
      this.onStartEnding(mif, m.pass);
    }
    if (mif.repeatForward) this.onForward(m.mid, m.pass);
    // 本遍不唱这一房（房号不含当前 pass）。它右边界上的 :|| 属于这一房、不该照唱——三房以上的谱
    // （1.2.3.5. / 4. / 6.）里，第 4 遍要跳过一房落到「4.」房，若照跳 :|| 就永远到不了后面的房。
    // 两房谱不受影响：那里 pass 已到 passCount，onBackward 本就走 m.mid++ 落到二房。
    const skippedEnding = this.inEnding && !this.endingActive;
    const fine = this.update(m);
    if (fine) return true;
    if (this.loopedBack) {
      // 房内 D.C. 已把 mid 拨回曲首、pass 进位，收房/反复判定一概跳过。
      this.loopedBack = false;
      m.mid++;
      return m.mid === p0.measures.length;
    }
    if (mif.endingRight !== null) {
      // 第一房通常在右边界同时带 backward repeat，必须保留当前 pass 让 onBackward 进入下一遍；
      // 最后一房右边界没有 backward repeat，它结束了这一组独立反复，此处要把 pass/passCount 重置，
      // 否则紧随其后的下一组 ||: 会因 pass>1 被 onForward 忽略、错误跳回上一组反复起点。
      // 「最后一房」须按房号判：多房谱中间的房（如「4.」）右边界同样没有 backward，按「无 backward
      // 即收组」会在半途把 pass 归 1，剩下的房永远唱不到、并陷入死循环。
      const lastVolta = !mif.endingNum || Math.max(...mif.endingNum) >= this.passCount;
      const closesRepeatGroup = !mif.repeatBackward && lastVolta;
      this.onRightEnding(m, mif.endingRight === StartStopDiscontinue.DISCONTINUE || closesRepeatGroup);
    }
    if (!this.inJump && mif.repeatBackward && !skippedEnding) {
      if (this.passCount < 0) {
        const beg = this.result[this.result.length - 1]!.mid;
        this.passCount = this.getPassCountByLrc(beg, m.mid + 1);
        if (this.passCount <= 1) this.passCount = 2;
      }
      this.onBackward(m, mif);
    } else {
      m.mid++;
    }
    if (m.mid < 0) {
      console.error("BAD Repeat Info");
      return true;
    }
    return m.mid === p0.measures.length;
  }

  repeatByLyric(): boolean {
    const pass = this.getPassCountByLrcAll();
    if (pass <= 1) return false;
    const itemCnt = this.result.length;
    let cur = 1;
    for (let i = 1; i < pass; i++) {
      cur++;
      for (let idx = 0; idx < itemCnt; idx++) {
        const it = this.result[idx]!.clone();
        it.pass = cur;
        this.result.push(it);
      }
      this.result[this.result.length - 1]!.endOfPass = true;
    }
    return true;
  }
}

/** 跳过 `skip` 个和弦后的小节内时值位置（PlayItem.offset 用，试听/MIDI 侧靠它裁剪）。 */
function skipOffset(m: PlayMeasure, skip: number): Fraction {
  let n = 0;
  for (const ent of m.entries) {
    if (!isPlayChord(ent)) continue;
    if (n === skip) return ent.position;
    n++;
  }
  return new Fraction(0);
}

function chordsOf(m: PlayMeasure): PlayChord[] {
  return m.entries.filter(isPlayChord);
}

/** 二房开头「与一房同位的结束音」个数：按一房的和弦数算，封顶到二房首节留一个音给副歌起拍。
 *  这几个音属于本段主歌（一房/二房各写一次的段末音），断句、分页都跟主歌走。
 *  跨连线/延音时返回 0（不把带连线的音切开）。 */
function voltaLead(measures: readonly PlayMeasure[], volta1Beg: number, volta1End: number, tailBeg: number): number {
  let n = 0;
  for (let i = volta1Beg; i < volta1End; i++) n += chordsOf(measures[i]!).length;
  const tail = chordsOf(measures[tailBeg]!);
  n = Math.min(n, tail.length - 1);
  if (n <= 0) return 0;
  for (let i = 0; i < n; i++) {
    const c = tail[i]!;
    if (c.slurStart || c.slurEnds > 0) return 0;
    if (c.notes.some((nt) => nt.tieStart || nt.tieEnd)) return 0;
  }
  return n;
}

// ───────────────────────── `.Repeat` 原文 ─────────────────────────

export class RepeatSpecItem {
  constructor(
    public first: number,
    public last: number,
    public verse: number,
    /** 首小节跳过的和弦个数（`11.2-20V4` → skip=1）。 */
    public skip = 0,
    /** 段末换页：这一段（主歌/副歌）唱完起新页，写作 `1-10V1P`。 */
    public page = false,
    /** 末小节只取前 n 个和弦（-1 = 整节），写作 `11.1-11.1V1`。 */
    public limit = -1,
  ) {}
  toString(): string {
    const head = this.skip > 0 ? `${this.first}.${this.skip + 1}` : `${this.first}`;
    const tail = this.limit >= 0 ? `${this.last}.${this.limit}` : `${this.last}`;
    return `${head}-${tail}V${this.verse}${this.page ? "P" : ""}`;
  }
}

export class RepeatSpec {
  items: RepeatSpecItem[] = [];
  constructor(s: string) {
    for (const it of s.split("\n")) {
      const arr = it.split("V");
      // 段号后可带 `P`：这一段唱完换页（乐句排版把主歌/副歌分页用）。
      const page = /p\s*$/i.test(arr[1] ?? "");
      const v = parseInt(arr[1]!, 10);
      const rng = arr[0]!.split("-");
      // 首端可写作 `小节.音符序号`（1 基），表示这一遍从该小节的第 n 个音符起接入。
      // 逗号在 .Repeat 里是条目分隔符（见 RepeatSection.parse），故用点号；
      // 旧解析器 parseInt("11.2") 仍得 11，退化成整小节接入而不是报错。
      const fst = rng[0]!.split(".");
      const first = parseInt(fst[0]!, 10) - 1;
      const skip = fst.length > 1 ? Math.max(0, parseInt(fst[1]!, 10) - 1) : 0;
      // 末端同样可写 `小节.音符个数`：这一段只唱到该小节的第 n 个音符为止。
      const lst = rng[rng.length - 1]!.split(".");
      const last = parseInt(lst[0]!, 10) - 1;
      const limit = lst.length > 1 ? Math.max(0, parseInt(lst[1]!, 10)) : -1;
      this.items.push(new RepeatSpecItem(first, last, v, skip, page, limit));
    }
  }
}
