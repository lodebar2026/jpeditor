// 混排（五线谱+简谱）数据模型。从 musicpp model/model.hpp + model.cpp 移植
// （dolce::Score/Part/Staff/Chord/Note/System/SysStaff 等）。
// 单位：tenths（五线谱高 40，线距 10），y 向下，五线谱顶线 y=0。
// 水平位置全部信任 MusicXML 内嵌版面（default-x / measure width）。

import { Fraction } from "../common/fraction";
import { Font } from "../layout/font";
import { MetaData, GlyphCodes } from "../smufl/smufl";

// ---------------- Fraction helpers (boost::rational 比较语义) ----------------

export function fLt(a: Fraction, b: Fraction): boolean {
  return a.compareTo(b) < 0;
}
export function fLe(a: Fraction, b: Fraction): boolean {
  return a.compareTo(b) <= 0;
}
export function fGt(a: Fraction, b: Fraction): boolean {
  return a.compareTo(b) > 0;
}
export function fGe(a: Fraction, b: Fraction): boolean {
  return a.compareTo(b) >= 0;
}
export function fEq(a: Fraction, b: Fraction): boolean {
  return a.compareTo(b) === 0;
}

/** map<rational,T>：按 Fraction 排序的 map，getAt = upper_bound 前驱（floor 查找）。 */
export class TickMap<T> {
  entries: { t: Fraction; v: T }[] = [];

  set(t: Fraction, v: T): void {
    let lo = 0,
      hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].t.compareTo(t) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo < this.entries.length && fEq(this.entries[lo].t, t)) {
      this.entries[lo].v = v;
    } else {
      this.entries.splice(lo, 0, { t, v });
    }
  }

  /** 最后一个 key<=t 的值（map::upper_bound 后 --it）。空表/全大于 t 时返回 null。 */
  getAt(t: Fraction): T | null {
    let res: T | null = null;
    for (const e of this.entries) {
      if (e.t.compareTo(t) > 0) break;
      res = e.v;
    }
    return res;
  }

  /** 是否存在恰好等于 t 的 key（Staff::keyChange 等）。 */
  changeAt(t: Fraction): boolean {
    return this.entries.some((e) => fEq(e.t, t));
  }

  get size(): number {
    return this.entries.length;
  }
  get last(): { t: Fraction; v: T } | null {
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }
}

// ---------------- 谱号/调号/拍号/记谱法 ----------------

export enum Notation {
  Normal,
  Shape,
  JianPu,
  Mixed,
}

export class ClefSig {
  sign = GlyphCodes.gClef;
  line = 0;

  /** 顶线（第五线）的 writtenPitch（octave*7+step 序数）。G 谱号顶线 F5=38。 */
  topPitch(): number {
    switch (this.sign) {
      case GlyphCodes.unpitchedPercussionClef1:
      case GlyphCodes.gClef:
        return 38;
      case GlyphCodes.gClef8vb:
        return 31;
      case GlyphCodes.fClef:
        return 26;
      case GlyphCodes.cClef:
        return 32;
      case GlyphCodes.sixStringTabClef:
        return 38;
      default:
        console.error("unknown clef sign", this.sign.charCodeAt(0).toString(16));
        return 38;
    }
  }
}

export class KeySig {
  fifths = 0;
  cancel = 0;
}

/** model.cpp::accidentalSym — acc 取 -1/0/1，csym 时用小号字形。 */
export function accidentalSym(acc: number, csym: boolean): string {
  if (csym) {
    if (acc === 1) return GlyphCodes.csymAccidentalSharp;
    if (acc === -1) return GlyphCodes.csymAccidentalFlat;
    return GlyphCodes.csymAccidentalNatural;
  }
  if (acc === 1) return GlyphCodes.accidentalSharp;
  if (acc === -1) return GlyphCodes.accidentalFlat;
  return GlyphCodes.accidentalNatural;
}

/**
 * 小节内临时记号推算（model.cpp::AccidentalStat）。简谱临时记号要按调号推算，
 * 而非直接照搬 MusicXML 的 <accidental>：例如 1=♭B 调里 E♮ 相对音阶第 4 级
 * （E♭）升高半音，应显示 ♯4 而非 ♮4。
 */
export class AccidentalStat {
  fifths: number;
  private alter = new Map<number, number>();
  constructor(fifths = 0) {
    this.fifths = fifths;
  }
  /** 返回需要绘制的记号值（-1/0/1），null 表示无需绘制。 */
  process(step: number, alt: number): number | null {
    step = ((step % 7) + 7) % 7;
    const sign = this.fifths === 0 ? 0 : this.fifths > 0 ? 1 : -1;
    let cur: number;
    let changed = false;
    if (this.alter.has(step)) {
      cur = this.alter.get(step)!;
      changed = true;
    } else {
      cur = 0;
      if (this.fifths !== 0) {
        for (let i = 1; i <= Math.abs(this.fifths); i++) {
          const v = ((i * 4 - 2) * sign + 1 + 35) % 7;
          if (v === step % 7) {
            cur = sign;
            break;
          }
        }
      }
    }
    if (cur === alt) return null;
    this.alter.set(step, alt);
    const diff = alt - cur;
    return changed ? 0 : diff;
  }
}

export class TimeSig {
  beats = 4;
  beatType = 4;
  symbol = false;

  static makeNumber(t: number): string {
    const zero = GlyphCodes.timeSig0.charCodeAt(0);
    let res = "";
    for (const c of String(t)) res += String.fromCharCode(zero + c.charCodeAt(0) - 48);
    return res;
  }
  static width(fm: MetaData, t: number): number {
    let res = 0;
    for (const g of TimeSig.makeNumber(t)) res += smuflWidth(fm, g);
    return res;
  }
}

// ---------------- SMuFL 度量（FontMeta，metadata 单位×10 转 tenths） ----------------

export function smuflWidth(fm: MetaData, glyph: string): number {
  const box = fm.getBBox(glyph);
  if (!box) return 0;
  return (box.bBoxNE[0] - box.bBoxSW[0]) * 10;
}
export function smuflTop(fm: MetaData, glyph: string): number {
  const box = fm.getBBox(glyph);
  return box ? box.bBoxNE[1] * 10 : 0;
}
export function smuflBottom(fm: MetaData, glyph: string): number {
  const box = fm.getBBox(glyph);
  return box ? box.bBoxSW[1] * 10 : 0;
}
export function smuflCutOut(
  fm: MetaData,
  glyph: string,
  which: "cutOutNE" | "cutOutNW" | "cutOutSE" | "cutOutSW",
): { x: number; y: number } | null {
  const an = fm.getAnchor(glyph);
  const pt = an?.[which];
  return pt ? { x: pt[0] * 10, y: pt[1] * 10 } : null;
}

// ---------------- Staff（per-staff 谱号/调号/拍号/记谱法时间线） ----------------

export class PartStaff {
  part: MixedPart;
  subIndex: number;
  order = 0;
  key = new TickMap<KeySig>();
  clef = new TickMap<ClefSig>();
  time = new TickMap<TimeSig>();
  notation = new TickMap<Notation>();

  constructor(part: MixedPart, subIndex: number) {
    this.part = part;
    this.subIndex = subIndex;
    this.notation.set(new Fraction(0), Notation.Normal);
  }

  getTopPitch(t: Fraction): number {
    return this.getClef(t).topPitch();
  }
  getClef(t: Fraction): ClefSig {
    return this.clef.getAt(t) ?? new ClefSig();
  }
  getKey(t: Fraction): KeySig {
    return this.key.getAt(t) ?? new KeySig();
  }
  getTime(t: Fraction): TimeSig {
    return this.time.getAt(t) ?? new TimeSig();
  }
  getNotation(t: Fraction): Notation {
    return this.notation.getAt(t) ?? Notation.Normal;
  }
  clefChange(t: Fraction): boolean {
    return this.clef.changeAt(t);
  }
  keyChange(t: Fraction): boolean {
    return this.key.changeAt(t);
  }
  timeChange(t: Fraction): boolean {
    return this.time.changeAt(t);
  }
}

// ---------------- Note / Chord ----------------

export enum BeamVal {
  Begin,
  Continue,
  End,
  Forward,
  Backward,
}

export class NotationItem {
  symbol = "";
  dx = 0;
  y = 0;
  above = true;

  /** model.cpp:1096 NotationItem::isFermata */
  isFermata(): boolean {
    return this.symbol === GlyphCodes.fermataBelow || this.symbol === GlyphCodes.fermataAbove;
  }

  /** model.cpp:1100 NotationItem::setAbove —— 翻转上/下时同时换字形。 */
  setAbove(ab: boolean): void {
    if (this.above === ab) return;
    this.above = ab;
    const rev = NotationItem.revertMap[this.symbol];
    if (rev) this.symbol = rev;
  }

  private static revertMap: Record<string, string> = {
    [GlyphCodes.fermataAbove]: GlyphCodes.fermataBelow,
    [GlyphCodes.fermataBelow]: GlyphCodes.fermataAbove,
    [GlyphCodes.articAccentAbove]: GlyphCodes.articAccentBelow,
    [GlyphCodes.articAccentBelow]: GlyphCodes.articAccentAbove,
    [GlyphCodes.articStaccatoAbove]: GlyphCodes.articStaccatoBelow,
    [GlyphCodes.articStaccatoBelow]: GlyphCodes.articStaccatoAbove,
    [GlyphCodes.articTenutoAbove]: GlyphCodes.articTenutoBelow,
    [GlyphCodes.articTenutoBelow]: GlyphCodes.articTenutoAbove,
    [GlyphCodes.articStaccatissimoAbove]: GlyphCodes.articStaccatissimoBelow,
    [GlyphCodes.articStaccatissimoBelow]: GlyphCodes.articStaccatissimoAbove,
    [GlyphCodes.articMarcatoAbove]: GlyphCodes.articMarcatoBelow,
    [GlyphCodes.articMarcatoBelow]: GlyphCodes.articMarcatoAbove,
  };
}

export class MNote {
  chord: MChord;
  entry: NoteEntry | null = null;

  layer = 0;
  soundPitch = 0;
  writtenPitch = -1;
  alter = 0;
  staff = 0;
  /** 显示尺寸：1=cue（小符头），0=正常（MusicXML <type size="cue">）。 */
  size = 0;

  tieBegin = false;
  tieEnd = false;
  parenthesesAcc = false;
  visible = true;
  flipped = false;
  /** 所属琶音组（无则 null）。 */
  arpeg: Arpeggiate | null = null;

  /** 显式临时记号（SMuFL 字形，"" 表示无）。 */
  acc = "";
  x = -1;

  constructor(chord: MChord) {
    this.chord = chord;
  }

  endTick(): Fraction {
    return this.chord.offset.plus(this.chord.dur);
  }
  rightSide(): boolean {
    const res = !this.chord.stemUp;
    return this.flipped ? !res : res;
  }
  partStaff(): PartStaff {
    return this.chord.measure.part.staves[this.staff];
  }
  clefSig(): ClefSig {
    return this.partStaff().getClef(this.chord.tick());
  }
  line(): number {
    const t = this.chord.tick();
    return this.writtenPitch - this.partStaff().getTopPitch(t);
  }
  cy(): number {
    return -this.line() * 5;
  }
  cx(meta: MetaData): number {
    return this.x + this.chord.noteheadWidth(meta) / 2;
  }
  rightXForTie(meta: MetaData): number {
    let res = this.x + this.chord.noteheadWidth(meta);
    if (this.chord.dot) res += 3 + this.chord.dot * 4;
    return res;
  }

  // ---- 简谱音名换算（model.cpp:176-218）----
  degreeWithBase(): { degree: number; base: number } {
    const t = this.chord.tick();
    const k = this.partStaff().getKey(t);
    const base = (4 * k.fifths + 28) % 7;
    return { degree: this.writtenPitch - base, base };
  }
  degree(): number {
    return this.degreeWithBase().degree;
  }
  number(): string {
    if (this.chord.rest) return "0";
    const deg = this.degree();
    return String.fromCharCode(49 + (((deg % 7) + 7) % 7)); // '1'+deg%7
  }
  /** 简谱八度点数（>0 上加点，<0 下加点）。 */
  octaveJp(addOctaveJpForKeyA: boolean): number {
    if (this.chord.rest) return 0;
    const { degree, base } = this.degreeWithBase();
    let res = Math.floor(degree / 7) - 4;
    if (base === 6) res += 1; // 规范 p.243
    if (addOctaveJpForKeyA && base === 5) res += 1;
    return res;
  }

  static sortByPitchWr(v: MNote[]): void {
    v.sort((a, b) => a.writtenPitch - b.writtenPitch);
  }
  static sortByPitchSnd(v: MNote[]): void {
    v.sort((a, b) =>
      a.writtenPitch !== b.writtenPitch
        ? a.writtenPitch - b.writtenPitch
        : a.chord.voice - b.chord.voice,
    );
  }
}

export class MChord {
  measure: MeasureData;
  offset = new Fraction(0);

  rest = false;
  grace = false;
  cue = false;
  measureRest = false;
  doubleSide = false;
  slash = false;

  voice = 0;
  dot = 0;
  stemLen = 0; // 无符干（全音符）默认 0，与 musicpp 一致；有符干者在 calcStemLen 赋值
  stemUp = true;
  stemExtra = 0; // 跨谱表符杠时符干延伸量（model.hpp stemExtra / styler.cpp calcSlopeLen）

  dur = new Fraction(0);
  noteType = new Fraction(1);
  timeModification = new Fraction(1);

  notes: MNote[] = [];
  beams: BeamVal[] = [];
  notations: NotationItem[] = [];

  constructor(measure: MeasureData) {
    this.measure = measure;
  }

  newNote(): MNote {
    const n = new MNote(this);
    this.notes.push(n);
    return n;
  }

  tick(): Fraction {
    return this.measure.measureInfo.offset.plus(this.offset);
  }

  hasNotation(above: boolean): boolean {
    return this.notations.some((it) => it.above === above);
  }

  /** 时值区间是否相交（model.cpp:1825 Chord::overlape）。 */
  overlape(ch: MChord): boolean {
    const t0 = this.tick();
    const t1 = t0.plus(this.dur);
    const t2 = ch.tick();
    const t3 = t2.plus(ch.dur);
    if (t0.compareTo(t3) >= 0) return false;
    if (t1.compareTo(t2) <= 0) return false;
    return true;
  }

  /** 简谱减时线条数。 */
  jpBeamCount(): number {
    let dur = this.noteType;
    let res = 0;
    while (fLt(dur, new Fraction(1))) {
      res += 1;
      dur = dur.timesInt(2);
    }
    return res;
  }

  /** 音符头/休止符 SMuFL 字形（Chord::sym，model.cpp:1696）。 */
  sym(): string {
    const nt = this.noteType;
    if (this.rest) {
      if (this.measureRest) return GlyphCodes.restWhole;
      if (fEq(nt.timesInt(4), new Fraction(1))) return GlyphCodes.rest16th;
      if (fEq(nt.timesInt(2), new Fraction(1))) return GlyphCodes.rest8th;
      if (nt.equals(1)) return GlyphCodes.restQuarter;
      if (nt.equals(2)) return GlyphCodes.restHalf;
      if (nt.equals(4)) return GlyphCodes.restWhole;
      if (fEq(nt.timesInt(8), new Fraction(1))) return GlyphCodes.rest32nd;
      console.error("unknown rest type", nt.toString());
      return GlyphCodes.restQuarter;
    }
    if (this.slash) {
      if (fLe(nt, new Fraction(1))) return GlyphCodes.noteheadSlashVerticalEnds;
      return GlyphCodes.noteheadSlashDiamondWhite; // half/whole slash
    }
    if (fLe(nt, new Fraction(1))) return GlyphCodes.noteheadBlack;
    if (nt.equals(2)) return GlyphCodes.noteheadHalf;
    if (nt.equals(4)) return GlyphCodes.noteheadWhole;
    console.error("unknown note type", nt.toString());
    return GlyphCodes.noteheadBlack;
  }

  /** 符尾旗字形（Chord::tailSym），四分及以上无旗返回 ""。 */
  tailSym(up: boolean): string {
    const nt = this.noteType;
    if (this.rest || fGe(nt, new Fraction(1))) return "";
    if (fEq(nt.timesInt(8), new Fraction(1)))
      return up ? GlyphCodes.flag32ndUp : GlyphCodes.flag32ndDown;
    if (fEq(nt.timesInt(4), new Fraction(1)))
      return up ? GlyphCodes.flag16thUp : GlyphCodes.flag16thDown;
    if (fEq(nt.timesInt(2), new Fraction(1)))
      return up ? GlyphCodes.flag8thUp : GlyphCodes.flag8thDown;
    return "";
  }

  noteheadWidth(meta: MetaData): number {
    return smuflWidth(meta, this.sym());
  }

  /** 符干 x（Chord::stemX，常量音头宽 11 与源一致）。 */
  stemX(): number {
    const nt = this.notes[0];
    const nw = 11;
    if (this.stemUp) return nt.x + nw;
    if (nt.flipped) return this.notes[1].x;
    return nt.x;
  }

  entX(): number {
    return this.notes[0].x;
  }

  tailNote(): MNote {
    return this.stemUp ? this.notes[this.notes.length - 1] : this.notes[0];
  }
  stemNote(): MNote {
    return this.stemUp ? this.notes[0] : this.notes[this.notes.length - 1];
  }

  /** 符干末端 y（Chord::tailY）。 */
  tailY(addMeaY: boolean): number {
    const tn = this.tailNote();
    let res = tn.cy();
    if (addMeaY) res += this.measure.staffY(tn.staff);
    return this.stemUp ? res - this.stemLen : res + this.stemLen;
  }

  /** 符干起点 y（音符头侧，Chord::stemY）。 */
  stemY(): number {
    const tn = this.stemNote();
    return this.measure.staffY(tn.staff) + tn.cy();
  }

  offsetXPos(dx: number): void {
    for (const nt of this.notes) nt.x += dx;
  }

  sort(): void {
    MNote.sortByPitchWr(this.notes);
  }

  /** 二度音程翻转音符头（Chord::autoFlip）。 */
  autoFlip(): void {
    let arr = this.notes;
    let inc = 1;
    if (!this.stemUp) {
      inc = -1;
      arr = [...arr].reverse();
    }
    let lastFlipped = false;
    let last: MNote | null = null;
    for (const n of arr) {
      if (n.writtenPitch <= 0) continue;
      if (!last || lastFlipped) {
        last = n;
        lastFlipped = false;
        continue;
      }
      const diff = n.writtenPitch - last.writtenPitch;
      if (diff === inc || diff === 0) {
        lastFlipped = true;
        this.doubleSide = true;
        n.flipped = true;
      } else {
        lastFlipped = false;
      }
      last = n;
    }
  }

  static sortByOffset(arr: MChord[]): void {
    arr.sort((a, b) => a.offset.compareTo(b.offset));
  }
}

// ---------------- NoteEntry 布局（加线/附点/临时记号避碰） ----------------

export class LegerLayout {
  ranges = new Map<number, [number, number]>();

  addNote(line: number, left: number, right: number): void {
    let first: number;
    let last: number;
    if (line > 1) {
      last = line;
      if (last % 2 !== 0) last -= 1;
      first = 2;
    } else if (line <= -10) {
      last = -10;
      first = line;
      if (first % 2 !== 0) first += 1;
    } else {
      return;
    }
    for (let l = first; l <= last; l += 2) {
      if (l <= 0 && l >= -8) continue;
      const old = this.ranges.get(l);
      if (old) {
        this.ranges.set(l, [Math.min(old[0], left), Math.max(old[1], right)]);
      } else {
        this.ranges.set(l, [left, right]);
      }
    }
  }
}

interface AccSegment {
  x: number;
  top: number;
  bottom: number;
}

export class AccItem {
  line = 0;
  text = "";
  symbols: string[] = [];
  up = 0;
  down = 0;
  width = 0;
  scale = 1;
  xpos: number | null = null;
  cutOutNE: { x: number; y: number } | null = null;
  cutOutNW: { x: number; y: number } | null = null;
  cutOutSE: { x: number; y: number } | null = null;
  cutOutSW: { x: number; y: number } | null = null;
}

export class AccidentalLayout {
  bound: AccSegment[] = [];
  accidentals: AccItem[] = [];
  meta: MetaData;

  constructor(meta: MetaData) {
    this.meta = meta;
  }

  addNoteBound(line: number, x: number): void {
    this.bound.push({ x, top: -(line + 1) * 5, bottom: -(line - 1) * 5 });
  }

  addNote(line: number, x: number, acc: string, paren: boolean, scale: number): void {
    this.addNoteBound(line, x);
    const m = this.meta;
    const item = new AccItem();
    item.line = line;
    item.scale = scale;
    if (paren) {
      const lp = GlyphCodes.accidentalParensLeft;
      const rp = GlyphCodes.accidentalParensRight;
      item.text = lp + acc + rp;
      item.symbols = [lp, acc, rp];
      item.cutOutNE = smuflCutOut(m, rp, "cutOutNE");
      item.cutOutSE = smuflCutOut(m, rp, "cutOutSE");
      item.cutOutNW = smuflCutOut(m, lp, "cutOutNW");
      item.cutOutSW = smuflCutOut(m, lp, "cutOutSW");
      item.width = smuflWidth(m, lp) + smuflWidth(m, rp) + smuflWidth(m, acc);
      item.down = -Math.min(smuflBottom(m, lp), smuflBottom(m, rp), smuflBottom(m, acc));
      item.up = -Math.min(smuflTop(m, lp), smuflTop(m, rp), smuflTop(m, acc));
    } else {
      item.text = acc;
      item.symbols = [acc];
      item.cutOutNE = smuflCutOut(m, acc, "cutOutNE");
      item.cutOutSE = smuflCutOut(m, acc, "cutOutSE");
      item.cutOutNW = smuflCutOut(m, acc, "cutOutNW");
      item.cutOutSW = smuflCutOut(m, acc, "cutOutSW");
      item.down = -smuflBottom(m, acc);
      item.up = -smuflTop(m, acc);
      item.width = smuflWidth(m, acc);
    }
    this.accidentals.push(item);
  }

  private tryPutItem(acc: AccItem): number {
    const segs: AccSegment[] = [];
    const sc = acc.scale;
    const refY = -acc.line * 5;
    let top = acc.up + refY;
    if (acc.cutOutNE) {
      const y = acc.cutOutNE.y + top;
      segs.push({ x: -sc * acc.cutOutNE.x, top, bottom: y });
      top = y;
    }
    let bot = acc.down + refY;
    if (acc.cutOutSE) {
      const y = bot - sc * acc.cutOutSE.y;
      segs.push({ x: -sc * acc.cutOutSE.x, top: y, bottom: bot });
      bot = y;
    }
    segs.push({ x: 0, top, bottom: bot });
    let res = Infinity;
    for (const s of segs) {
      let leftMost = Infinity;
      for (const b of this.bound) {
        if (b.top >= s.bottom) continue;
        if (s.top >= b.bottom) continue;
        leftMost = Math.min(leftMost, b.x);
      }
      res = Math.min(res, leftMost - s.x);
    }
    return res - acc.width * sc;
  }

  private putItem(pos: number, acc: AccItem): void {
    const segs: AccSegment[] = [];
    const refY = -acc.line * 5;
    let top = acc.up + refY;
    if (acc.cutOutNW) {
      const y = acc.cutOutNW.y + refY;
      segs.push({ x: pos + acc.cutOutNW.x, top, bottom: y });
      top = y;
    }
    let bot = acc.down + refY;
    if (acc.cutOutSW) {
      const y = acc.cutOutSW.y + refY;
      segs.push({ x: pos + acc.cutOutSW.x, top: y, bottom: bot });
      bot = y;
    }
    segs.push({ x: pos, top, bottom: bot });
    acc.xpos = pos;
    for (const s of segs) this.bound.push(s);
  }

  update(): void {
    this.accidentals.sort((a, b) => b.line - a.line);
    for (;;) {
      let best: AccItem | null = null;
      let bestPos = -Infinity;
      for (const it of this.accidentals) {
        if (it.xpos !== null) continue;
        const pos = this.tryPutItem(it);
        if (pos > bestPos) {
          best = it;
          bestPos = pos;
        }
      }
      if (!best) break;
      this.putItem(bestPos - 1, best);
    }
  }
}

export class DotLayout {
  mutipleVoice = false;
  notes: MNote[] = [];
  dots = new Set<number>();
  dotPos = 0;

  addNote(n: MNote): void {
    this.notes.push(n);
  }

  update(meta: MetaData): void {
    this.dots.clear();
    this.dotPos = 0;
    const done = new Set<MNote>();
    const count = new Map<number, number>();
    for (const n of this.notes) {
      const l = n.line();
      if (l % 2 !== 0) {
        this.dots.add(l);
        done.add(n);
      } else {
        count.set(l, (count.get(l) ?? 0) + 1);
      }
      const w = smuflWidth(meta, n.chord.sym());
      this.dotPos = Math.max(this.dotPos, n.x + w + 3);
    }
    for (const n of this.notes) {
      if (done.has(n)) continue;
      const l = n.line();
      if ((count.get(l) ?? 0) > 1) {
        this.dots.add(n.chord.stemUp ? l + 1 : l - 1);
        done.add(n);
      }
    }
    for (const n of this.notes) {
      if (done.has(n)) continue;
      const l = n.line();
      if (this.dots.has(l + 1)) {
        this.dots.add(l - 1);
        done.add(n);
        continue;
      }
      if (this.dots.has(l - 1)) {
        this.dots.add(l + 1);
        done.add(n);
        continue;
      }
      if (this.mutipleVoice) {
        this.dots.add(n.chord.stemUp ? l + 1 : l - 1);
      } else {
        this.dots.add(l + 1);
      }
      done.add(n);
    }
  }
}

export class NoteEntry {
  notes: MNote[] = [];
  measure: MeasureData;
  leger = new LegerLayout();
  dot = new DotLayout();
  acc: AccidentalLayout;
  subStaff = 0;
  offset = new Fraction(0);

  constructor(measure: MeasureData, meta: MetaData) {
    this.measure = measure;
    this.acc = new AccidentalLayout(meta);
  }

  layout(meta: MetaData, sibelius: boolean): void {
    this.dot = new DotLayout();
    this.leger = new LegerLayout();
    this.acc = new AccidentalLayout(meta);

    if (sibelius) this.layoutChords(meta); // must before dot.layout

    for (const n of this.notes) {
      const line = n.line();
      const left = n.x;
      if (n.chord.dot > 0) this.dot.addNote(n);
      if (n.chord.rest) continue;
      const w = smuflWidth(meta, n.chord.sym());
      const right = n.x + w;
      this.leger.addNote(line, left, right);
      if (n.acc !== "") {
        this.acc.addNote(line, left, n.acc, n.parenthesesAcc, 1);
      } else {
        this.acc.addNoteBound(line, left);
      }
    }
    this.dot.update(meta);
    this.acc.update();
  }

  /** Sibelius 同 entry 多 chord 的水平错位修正（NoteEntry::layoutChords）。 */
  private layoutChords(meta: MetaData): void {
    const chords = new Set<MChord>();
    for (const n of this.notes) {
      const ch = n.chord;
      if (ch.rest || ch.grace) continue;
      chords.add(ch);
    }
    const arr = [...chords];
    arr.sort((a, b) => {
      const va = fGe(a.noteType, new Fraction(4)) ? 0 : a.stemUp ? 1 : -1;
      const vb = fGe(b.noteType, new Fraction(4)) ? 0 : b.stemUp ? 1 : -1;
      return va - vb;
    });
    for (let i = 0; i < arr.length; i++) {
      const ch = arr[i];
      const top = ch.notes[ch.notes.length - 1].writtenPitch;
      const bot = ch.notes[0].writtenPitch;
      const sym = ch.sym();
      for (let j = i + 1; j < arr.length; j++) {
        const chj = arr[j];
        const top2 = chj.notes[chj.notes.length - 1].writtenPitch;
        const bot2 = chj.notes[0].writtenPitch;
        if (top2 < bot - 1) continue;
        if (bot2 > top + 1) continue;
        let same = bot2 === top || top2 === bot;
        let sameNH = sym === chj.sym() && ch.dot === chj.dot;
        if (sym === GlyphCodes.noteheadWhole) sameNH = false;
        if (!sameNH) same = false;
        if (same) continue;
        const dw = chj.noteheadWidth(meta);
        const dx = chj.stemX() - ch.stemX();
        if (chj.dot > ch.dot) {
          if (dx > dw) {
            // keep
          } else {
            ch.offsetXPos(-dw);
          }
        } else if (Math.abs(dx) < dw) {
          ch.offsetXPos(dw);
        }
      }
    }
  }
}

// ---------------- 歌词 / 和弦记号 / 文本块 ----------------

export enum LCR {
  Left,
  Center,
  Right,
}

export class MLyric {
  measure: MeasureData;
  offset = new Fraction(0);
  num = "1";
  name = "";
  text = "";
  prefix = "";
  font!: Font;
  chord: MChord | null = null;

  begin = true;
  end = true;
  extend: Fraction | null = null;

  x = -1;
  y = -1;
  xOffset = 0;
  width = 0;
  staff = 0;
  halign = LCR.Center;
  prev: MLyric | null = null;
  next: MLyric | null = null;

  constructor(measure: MeasureData) {
    this.measure = measure;
  }

  get empty(): boolean {
    return this.text.length === 0;
  }

  /** [前导非CJK宽, CJK段宽, 尾随非CJK宽]（Lyric::widthInfo 移植）。
   *  注意：前缀（段落号）不计入，由 drawLrc 单独按固定偏移摆放。 */
  widthInfo(): [number, number, number] {
    const chars = [...this.text];
    if (chars.length === 0) return [0, 0, 0];
    const widths = chars.map((c) => this.font.measureText(c));
    const punct = "「」（），。！；：、“”？｡";
    const isCjk = (ch: string) => ch.charCodeAt(0) > 0x80 && !punct.includes(ch);
    let first = 0;
    let last = chars.length - 1;
    for (let i = 0; i < chars.length; i++) if (isCjk(chars[i])) { first = i; break; }
    for (let i = chars.length - 1; i >= 0; i--) if (isCjk(chars[i])) { last = i; break; }
    let prev = 0, cjk = 0, extra = 0;
    for (let i = 0; i < widths.length; i++) {
      if (i < first) prev += widths[i];
      else if (i <= last) cjk += widths[i];
      else extra += widths[i];
    }
    return [prev, cjk, extra];
  }

  /** 解析后计算 xOffset/width（parser.cpp processLrc 尾部）。 */
  updateWidth(meta: MetaData): void {
    const wArr = this.widthInfo();
    let dx = 0;
    if (this.halign === LCR.Center) {
      dx = -(wArr[0] + wArr[1] / 2);
      if (this.chord) dx += this.chord.noteheadWidth(meta) / 2;
    } else if (this.halign === LCR.Right) {
      dx = -(wArr[0] + wArr[1] + wArr[2]);
    }
    this.xOffset = dx;
    this.width = wArr[0] + wArr[1] + wArr[2];
  }
}

export enum HarmonyDegreeType {
  Add,
  Alter,
  Subtract,
}

export interface HarmonyStepAlter {
  step: string;
  alter: number;
}

export class MHarmony {
  measure: MeasureData;
  offset = new Fraction(0);
  root: HarmonyStepAlter = { step: "C", alter: 0 };
  bass: HarmonyStepAlter | null = null;
  degree: { value: number; alter: number; type: HarmonyDegreeType }[] = [];
  kind = "";
  kindText: string | null = null;
  useSymbols = false;
  parenthesesDegrees = false;
  x = 0;
  y = 0;
  staff = 0;

  constructor(measure: MeasureData) {
    this.measure = measure;
  }

  /** 纯文本形式（仅用于 calcMixedStaffY 的宽度粗估）。 */
  asPlainText(): string {
    let res = this.root.step;
    if (this.root.alter === 1) res += "#";
    else if (this.root.alter === -1) res += "b";
    res += harmonyKindSuffix(this.kind, this.kindText);
    for (const d of this.degree) {
      if (d.type === HarmonyDegreeType.Add) res += "add" + d.value;
    }
    if (this.bass) {
      res += "/" + this.bass.step;
      if (this.bass.alter === 1) res += "#";
      else if (this.bass.alter === -1) res += "b";
    }
    return res;
  }

  /** 富文本分段（Harmony::asText 移植）：升降号用 SMuFL csym 字形，后缀上标。 */
  asText(): HarmonySeg[] {
    const segs: HarmonySeg[] = [];
    const stepAlter = (sa: HarmonyStepAlter) => {
      segs.push({ text: sa.step, music: false, superscript: 0, dy: 0 });
      if (sa.alter === 1) segs.push({ text: GlyphCodes.csymAccidentalSharp, music: true, superscript: 0, dy: 0 });
      else if (sa.alter === -1) segs.push({ text: GlyphCodes.csymAccidentalFlat, music: true, superscript: 0, dy: 0 });
    };
    stepAlter(this.root);

    let kt = "";
    let useSym = false;
    let sym = "";
    if (this.kindText !== null && this.kindText !== "") {
      kt = this.kindText;
    } else if (this.kind === "half-diminished") {
      useSym = true; sym = GlyphCodes.csymHalfDiminished;
    } else if (this.kind === "augmented") {
      useSym = true; sym = GlyphCodes.csymAugmented;
    } else if (this.kind === "diminished-seventh" || this.kind === "diminished") {
      useSym = true; sym = GlyphCodes.csymDiminished;
    } else if (this.kind === "power") {
      kt = "5";
    } else {
      const abbr = abbrKindText(this.kind);
      if (abbr) kt = abbr;
      else if (this.kind === "major" || this.kind === "") { /* no suffix */ }
      else { kt = "<" + this.kind + ">"; console.warn("unknown harmony kind:", this.kind); }
    }

    // 前导 m 留在基线，其余后缀上标
    if (kt === "m" || kt === "m7" || kt === "m9" || kt === "m6") {
      segs.push({ text: "m", music: false, superscript: 0, dy: 0 });
      kt = kt.substring(1);
    }
    if (kt) {
      segs.push({ text: kt, music: false, superscript: 1, dy: 0 });
    } else if (useSym) {
      segs.push({ text: sym, music: true, superscript: 1, dy: 0 });
      if (this.kind === "diminished-seventh" || this.kind === "half-diminished") {
        segs.push({ text: "7", music: false, superscript: 1, dy: 0 });
      }
    }

    // degrees（add / alter / sus4）
    if (this.degree.length > 1) {
      let deg = "";
      if (isSus4(this.degree)) deg = "sus4";
      if (deg) {
        if (this.parenthesesDegrees) segs.push({ text: "(", music: false, superscript: 1, dy: 0 });
        segs.push({ text: deg, music: false, superscript: 1, dy: 0 });
        if (this.parenthesesDegrees) segs.push({ text: ")", music: false, superscript: 1, dy: 0 });
      }
    } else if (this.degree.length === 1) {
      const d = this.degree[0];
      let deg = "";
      if (d.type === HarmonyDegreeType.Add) {
        deg = "add";
      } else if (d.type === HarmonyDegreeType.Alter) {
        if (this.parenthesesDegrees) segs.push({ text: "(", music: false, superscript: 0, dy: 0 });
        if (d.alter === -1) segs.push({ text: GlyphCodes.csymAccidentalFlat, music: true, superscript: 0, dy: 7.5 });
        else if (d.alter === 1) segs.push({ text: GlyphCodes.csymAccidentalSharp, music: true, superscript: 0, dy: 7.5 });
        segs.push({ text: String(d.value), music: false, superscript: 0, dy: 0 });
        if (this.parenthesesDegrees) segs.push({ text: ")", music: false, superscript: 0, dy: 0 });
      }
      if (kt === "6" && d.type === HarmonyDegreeType.Add && d.value === 9) {
        // 6/9：合并到上一段后缀
        const last = segs[segs.length - 1];
        if (last) last.text += "/9";
      } else if (deg) {
        deg += String(d.value);
        if (this.parenthesesDegrees) deg = "(" + deg + ")";
        segs.push({ text: deg, music: false, superscript: 1, dy: 0 });
      }
    }

    if (this.bass) {
      segs.push({ text: "/", music: false, superscript: 0, dy: 0 });
      stepAlter(this.bass);
    }
    return segs;
  }
}

/** Harmony 文本分段：music=用 SMuFL 字形；superscript=±1 上/下标；dy=基线偏移。 */
export interface HarmonySeg {
  text: string;
  music: boolean;
  superscript: number;
  dy: number;
}

/** MusicXML kind → 缩写（Harmony::abbrKindText 移植）。 */
function abbrKindText(kind: string): string {
  switch (kind) {
    case "minor-seventh": return "m7";
    case "major-seventh": return "maj7";
    case "major-ninth": return "maj9";
    case "diminished-seventh": return "dim7";
    case "suspended-fourth": return "(sus4)";
    case "dominant": return "7";
    case "dominant-ninth": return "9";
    case "major-sixth": return "6";
    case "minor": return "m";
    case "minor-ninth": return "m9";
    case "minor-sixth": return "m6";
    case "major": return "";
    default: return "";
  }
}

function isSus4(degree: { value: number; type: HarmonyDegreeType }[]): boolean {
  if (degree.length < 2) return false;
  return (
    degree[0].type === HarmonyDegreeType.Add && degree[0].value === 4 &&
    degree[1].type === HarmonyDegreeType.Subtract && degree[1].value === 3
  );
}

/** MusicXML harmony kind → 习惯后缀（覆盖语料常见 kind，未知的回退 kindText）。 */
export function harmonyKindSuffix(kind: string, kindText: string | null): string {
  switch (kind) {
    case "major":
    case "":
      return "";
    case "minor":
      return "m";
    case "augmented":
      return "aug";
    case "diminished":
      return "dim";
    case "dominant":
      return "7";
    case "major-seventh":
      return "maj7";
    case "minor-seventh":
      return "m7";
    case "diminished-seventh":
      return "dim7";
    case "half-diminished":
      return "m7b5";
    case "major-sixth":
      return "6";
    case "minor-sixth":
      return "m6";
    case "suspended-fourth":
      return "sus4";
    case "suspended-second":
      return "sus2";
    case "dominant-ninth":
      return "9";
    case "major-ninth":
      return "maj9";
    case "minor-ninth":
      return "m9";
    case "power":
      return "5";
    default:
      if (kindText !== null) return kindText;
      console.warn("unknown harmony kind:", kind);
      return kind;
  }
}

export interface TextBlockItem {
  font: Font;
  text: string;
  dy: number;
  music: boolean;
  superscript: number;
}

export class TextBlock {
  data: TextBlockItem[] = [];
  x = 0;
  y = 0;
  justify = LCR.Left;
  title = false;

  add(text: string, font: Font, music = false): void {
    this.data.push({ font, text, dy: 0, music, superscript: 0 });
  }

  width(): number {
    let res = 0;
    for (const it of this.data) {
      if (it.text === "\n") continue;
      res += it.font.measureText(it.text);
    }
    return res;
  }

  /** 总高度；vec 收集每行行高（TextBlock::height(vector&)）。 */
  height(vec?: number[]): number {
    let lineH = 0;
    let res = 0;
    for (const it of this.data) {
      if (it.text === "\n") {
        vec?.push(lineH);
        res += lineH;
        lineH = 0;
        continue;
      }
      const fm = it.font.metrics;
      lineH = Math.max(lineH, fm.descent - fm.ascent);
    }
    if (lineH > 0) {
      vec?.push(lineH);
      res += lineH;
    }
    return res;
  }

  text(): string {
    return this.data.map((d) => d.text).join("");
  }
}

export class MeasureText extends TextBlock {
  measure: MeasureData;
  offset = new Fraction(0);
  staff = 0;
  relative = false;

  constructor(measure: MeasureData) {
    super();
    this.measure = measure;
  }
}

// ---------------- BeamGroup ----------------

export class BeamGroup {
  chords: MChord[] = [];
  jp = false;
  doubleDir = false;

  /** 最小二乘斜率（styler.cpp::leastSquare）。 */
  private static leastSquare(pts: { x: number; y: number }[]): number {
    let t1 = 0, t2 = 0, t3 = 0, t4 = 0;
    for (const p of pts) {
      t1 += p.x * p.x;
      t2 += p.x;
      t3 += p.x * p.y;
      t4 += p.y;
    }
    const n = pts.length;
    return (t3 * n - t2 * t4) / (t1 * n - t2 * t2);
  }

  /** 音高走向位掩码（styler.cpp::pitchDirection）：bit0=同高 bit1=降 bit2=升。 */
  pitchDirection(): number {
    const noteCnt = new Set<number>();
    for (const ch of this.chords) noteCnt.add(ch.notes.length);
    let res = 0;
    if (noteCnt.size === 1) {
      const first = this.chords[0];
      let nts = [...first.notes];
      MNote.sortByPitchWr(nts);
      for (const ch of this.chords) {
        if (ch === first) continue;
        const nts2 = [...ch.notes];
        MNote.sortByPitchWr(nts2);
        for (let i = 0; i < nts.length; i++) {
          const n2 = nts2[i];
          const n1 = nts[i];
          let bit: number;
          if (n1.writtenPitch === n2.writtenPitch) bit = 0;
          else if (n1.writtenPitch < n2.writtenPitch) bit = 2;
          else bit = 1;
          res |= 1 << bit;
          if (res === 7) return res;
        }
        nts = nts2;
      }
      return res;
    }

    const refChords: MChord[] = [this.chords[0]];
    if (this.chords.length >= 3) refChords.push(this.chords[this.chords.length - 1]);
    for (const refCh of refChords) {
      const nts = [...refCh.notes];
      MNote.sortByPitchWr(nts);
      const refs: MNote[] = [nts[0]];
      if (nts.length > 1) refs.push(nts[nts.length - 1]);
      for (const ref of refs) {
        for (const ch of this.chords) {
          if (ch === refCh) continue;
          for (const nt of ch.notes) {
            let bit = 0;
            if (nt.writtenPitch === ref.writtenPitch) bit = 0;
            else if (nt.writtenPitch < ref.writtenPitch) bit = 1;
            else bit = 2;
            if (ch.offset.compareTo(refCh.offset) > 0) {
              // keep
            } else {
              if (bit === 1) bit = 2;
              else if (bit === 2) bit = 1;
            }
            res |= 1 << bit;
            if (res === 7) return res;
          }
        }
      }
    }
    return res;
  }

  /** 是否跨谱表（styler.cpp::crossStaff）。 */
  crossStaff(): boolean {
    const staves = new Set<number>();
    for (const ch of this.chords) {
      for (const nt of ch.notes) {
        staves.add(nt.staff);
        if (staves.size > 1) return true;
      }
    }
    return false;
  }

  /** 按斜率求各和弦符干长（styler.cpp::calcSlopeLen）。 */
  private calcSlopeLen(dy: number): void {
    const pts: { x: number; y: number }[] = [];
    for (const ch of this.chords) {
      const nt = ch.tailNote();
      let y = nt.cy();
      if (nt.staff === 1) y += dy;
      pts.push({ x: ch.stemX(), y });
    }
    let slope = BeamGroup.leastSquare(pts);
    const thres = 0.3;
    if (slope > thres) slope = thres;
    else if (slope < -thres) slope = -thres;

    if (this.doubleDir) {
      let minYUp = Infinity, maxYDown = -Infinity, downId = -1, upId = -1;
      for (let idx = 0; idx < this.chords.length; idx++) {
        const up = this.chords[idx].stemUp;
        const y = pts[idx].y;
        if (up) {
          if (y < minYUp) { minYUp = y; upId = idx; }
        } else {
          if (y > maxYDown) { maxYDown = y; downId = idx; }
        }
      }
      const cy = (maxYDown + minYUp) / 2 - 2.5;
      const cx = (pts[upId].x + pts[downId].x) / 2;
      for (let tr = 0; tr < 2; tr++) {
        let minLen = Infinity;
        for (let idx = 0; idx < this.chords.length; idx++) {
          const ch = this.chords[idx];
          const up = ch.stemUp;
          const inc = up ? -1 : 1;
          const flipped = up !== this.chords[0].stemUp;
          if (flipped) ch.stemExtra = inc * ch.beams.length * 8 - 3;
          const ypos = (pts[idx].x - cx) * slope + cy;
          ch.stemLen = inc * (ypos - pts[idx].y);
          minLen = Math.min(minLen, ch.stemLen);
        }
        if (minLen < 35) slope = 0;
        else break;
      }
    } else {
      let minLen = Infinity;
      for (let idx = 0; idx < this.chords.length; idx++) {
        const ch = this.chords[idx];
        const up = ch.stemUp;
        const inc = up ? -1 : 1;
        const dx = pts[idx].x - pts[0].x;
        const ypos = dx * slope + pts[0].y;
        const len = inc * (ypos - pts[idx].y) + 35;
        if (len < minLen) minLen = len;
        ch.stemLen = len;
      }
      const diff = 35 - minLen;
      for (const ch of this.chords) ch.stemLen += diff;
    }
  }

  /** 计算符杠组各符干长度与延伸（styler.cpp::BeamGroup::format）。 */
  format(dy: number): void {
    const dir = this.pitchDirection();
    if (!this.crossStaff()) dy = 0;
    if (this.doubleDir || dir === 2 || dir === 4) {
      this.calcSlopeLen(dy);
    } else if ((dir === 3 || dir === 5) && this.chords.length === 2) {
      this.calcSlopeLen(dy);
    } else {
      // 水平符杠
      let minP = 1000, maxP = -1;
      for (const ch of this.chords) {
        for (const n of ch.notes) {
          if (n.writtenPitch < minP) minP = n.writtenPitch;
          if (n.writtenPitch > maxP) maxP = n.writtenPitch;
        }
      }
      const up = this.chords[0].stemUp;
      if (up) {
        for (const ch of this.chords) {
          const tn = ch.tailNote();
          ch.stemLen = (maxP + 7 - tn.writtenPitch) * 5;
        }
      } else {
        for (const ch of this.chords) {
          const tn = ch.tailNote();
          ch.stemLen = (tn.writtenPitch - (minP - 7)) * 5;
        }
      }
    }
  }
}

// ---------------- MeasureData（声部内单小节内容，dolce::MusicData） ----------------

export class MeasureData {
  measureInfo!: MeasureInfo;
  part!: MixedPart;

  chords: MChord[] = [];
  lyrics: MLyric[] = [];
  harmonies: MHarmony[] = [];
  textBlocks: MeasureText[] = [];
  arpegs: Arpeggiate[] = [];

  beams: BeamGroup[] = [];
  graceBeams: BeamGroup[] = [];
  jpBeams: BeamGroup[] = [];
  layerNum = 0;
  noteEntries: NoteEntry[] = [];

  newChord(): MChord {
    const ch = new MChord(this);
    this.chords.push(ch);
    return ch;
  }
  newLyric(): MLyric {
    const l = new MLyric(this);
    this.lyrics.push(l);
    return l;
  }
  newHarmony(): MHarmony {
    const h = new MHarmony(this);
    this.harmonies.push(h);
    return h;
  }
  newText(): MeasureText {
    const t = new MeasureText(this);
    this.textBlocks.push(t);
    return t;
  }

  system(): Sys {
    return this.measureInfo.system;
  }

  /** 该 part 内 subStaff 的 y 偏移（MusicData::staffY）。 */
  staffY(stf: number): number {
    if (stf === 0) return 0;
    const sys = this.system();
    let res = 0;
    for (const st of sys.staves) {
      const ps = st.partStaff;
      if (ps.part === this.part) {
        if (ps.subIndex === stf) {
          res += st.distance;
          break;
        } else if (st.staffVisible) {
          res += st.height();
        }
      }
    }
    return res;
  }

  xpos(): number {
    return this.measureInfo.xpos();
  }

  // ---- splitLayer（model.cpp:877）：按音高链分配 layer，layer==1 为最高声部 ----

  private getFirstUnknown(): MNote | null {
    for (const ent of this.chords) {
      for (let idx = ent.notes.length - 1; idx >= 0; idx--) {
        const n = ent.notes[idx];
        if (!n.visible) continue;
        if (n.layer === 0) {
          const prev = idx - 1;
          if (prev >= 0) {
            const ntPrev = ent.notes[prev];
            if (ntPrev.layer === 0 && ntPrev.writtenPitch === n.writtenPitch) {
              return ntPrev;
            }
          }
          return n;
        }
      }
    }
    return null;
  }

  private getUnknownByTick(t: Fraction): MNote | null {
    for (const ent of this.chords) {
      if (fLt(ent.offset, t)) continue;
      for (let idx = ent.notes.length - 1; idx >= 0; idx--) {
        const n = ent.notes[idx];
        if (!n.visible) continue;
        if (n.layer === 0) {
          const prev = idx - 1;
          if (prev >= 0) {
            const ntPrev = ent.notes[prev];
            if (
              ntPrev.layer === 0 &&
              ntPrev.writtenPitch === n.writtenPitch &&
              ntPrev.x < n.x
            ) {
              return ntPrev;
            }
          }
          return n;
        }
      }
    }
    return null;
  }

  splitLayer(): void {
    this.chords.sort((a, b) => a.offset.compareTo(b.offset));
    for (const ent of this.chords) {
      ent.notes.sort((a, b) => a.writtenPitch - b.writtenPitch);
    }
    let layer = 1;
    for (;;) {
      const unk = this.getFirstUnknown();
      if (!unk) break;
      unk.layer = layer;
      let end = unk.endTick();
      for (;;) {
        const next = this.getUnknownByTick(end);
        if (!next) break;
        next.layer = layer;
        end = next.endTick();
      }
      layer += 1;
    }
    this.layerNum = layer - 1;
  }

  /** 简谱减时线分组（MusicData::processJpBeam）。 */
  processJpBeam(): void {
    const layer: MChord[] = [];
    let stf = -1;
    for (const ch of this.chords) {
      for (const nt of ch.notes) {
        if (nt.layer === 1) {
          layer.push(ch);
          stf = nt.staff;
          break;
        }
      }
    }
    if (stf < 0) return;
    MChord.sortByOffset(layer);
    const pstf = this.part.staves[stf];
    const t0 = this.measureInfo.offset;
    const ts = pstf.getTime(t0);
    const expect = new Fraction(ts.beats * 4, ts.beatType);
    let skip = expect.minus(this.measureInfo.dur);
    const measures = this.part.measures;
    if (this === measures[measures.length - 1]) {
      skip = new Fraction(0);
    } else {
      const next = measures[this.measureInfo.index + 1];
      if (fEq(skip, next.measureInfo.dur)) skip = new Fraction(0);
    }

    let prevBeat = -1;
    let beatSize = new Fraction(1);
    if (ts.beatType === 4 || ts.beatType === 2) {
      // quarter/half beat
    } else if (ts.beatType === 8 && ts.beats % 3 === 0) {
      beatSize = new Fraction(3, 2);
    } else {
      console.warn("processJpBeam: unsupported time", ts.beats, ts.beatType);
    }
    for (const ch of layer) {
      if (ch.jpBeamCount() < 1) continue;
      const t = skip.plus(ch.offset);
      const b = Math.floor(t.div(beatSize).toFloat());
      if (prevBeat !== b) {
        const g = new BeamGroup();
        g.jp = true;
        g.chords.push(ch);
        this.jpBeams.push(g);
        prevBeat = b;
      } else {
        this.jpBeams[this.jpBeams.length - 1].chords.push(ch);
      }
    }
  }

  /** 建 NoteEntry + Sibelius 翻转修正（MusicData::layoutNotes）。 */
  layoutNotes(meta: MetaData, sibelius: boolean): void {
    for (const ch of this.chords) {
      ch.sort();
      ch.autoFlip();
      if (sibelius) {
        for (const nt of ch.notes) {
          if (nt.flipped) {
            const width = smuflWidth(meta, ch.sym());
            nt.x += ch.stemUp ? width : -width;
          }
        }
      }
    }

    const staves = this.part.staves.length;
    const entries: Map<string, NoteEntry>[] = [];
    for (let i = 0; i < staves; i++) entries.push(new Map());
    for (const ch of this.chords) {
      if (ch.grace) continue;
      const t = ch.offset;
      for (const nt of ch.notes) {
        const m = entries[nt.staff];
        const key = t.toString();
        let ent = m.get(key);
        if (!ent) {
          ent = new NoteEntry(this, meta);
          this.noteEntries.push(ent);
          ent.subStaff = nt.staff;
          ent.offset = t;
          m.set(key, ent);
        }
        nt.entry = ent;
        ent.notes.push(nt);
      }
    }

    this.fixPitchForRest();
    for (const ent of this.noteEntries) ent.layout(meta, sibelius);
  }

  /**
   * 记号（fermata 等）上/下与纵向位置（model.cpp:968 MusicData::layoutNotations）。
   * 须在 stem/beam 信息就绪后调用。当前仅 fermata 走了 loader，articulation 字形未移植。
   */
  layoutNotations(): void {
    const notaChords = this.chords.filter((ch) => ch.notations.length > 0);
    const part2 = this.part.pid === "P2";

    for (const ch of notaChords) {
      let minv = Infinity;
      let maxv = -Infinity;
      for (const ch2 of this.chords) {
        if (!ch2.overlape(ch)) continue;
        minv = Math.min(minv, ch2.voice);
        maxv = Math.max(maxv, ch2.voice);
      }
      const single = minv === maxv;
      const above = single ? !ch.stemUp : ch.voice === minv;

      let noteSide = single;
      const nt = above ? ch.notes[ch.notes.length - 1] : ch.notes[0];
      const hasStem = fLt(ch.noteType, new Fraction(4));
      if (!(hasStem && ch.stemUp === above)) noteSide = true;

      for (const it of ch.notations) {
        // musicpp 以「原始字形是否 fermataAbove」判定，setAbove 之前取值。
        const fermata = it.symbol === GlyphCodes.fermataAbove;
        if (fermata) {
          it.setAbove(single ? !part2 : above);
          noteSide = it.above !== ch.stemUp;
        } else {
          it.setAbove(above);
        }

        const inc = it.above ? -1 : 1;
        let y = noteSide ? nt.cy() + 5 * inc : ch.tailY(false);
        const tenuto =
          it.symbol === GlyphCodes.articTenutoBelow || it.symbol === GlyphCodes.articTenutoAbove;
        y += 5 * inc;
        if (tenuto) {
          if (y % 10 === 0 && noteSide) {
            const ln = nt.line();
            if (ln < 0 && ln > -8) y += 5 * inc;
          }
        }
        if (fermata) {
          // staff 外
          if (it.above) {
            if (y > -10) y = -10;
          } else if (!noteSide) {
            it.dx -= 5;
          }
        }
        it.y = y;
      }
    }
  }

  /** 休止符纵向位置（MusicData::fixPitchForRest）。 */
  private fixPitchForRest(): void {
    for (const ent of this.noteEntries) {
      for (const nt of ent.notes) {
        if (nt.writtenPitch >= 0) continue;
        const top = nt.clefSig().topPitch();
        if (ent.notes.length === 1) {
          nt.writtenPitch = top - 4;
        } else {
          let minVoice = Infinity;
          let maxVoice = -Infinity;
          let minPitch = Infinity;
          let maxPitch = -Infinity;
          for (const n2 of ent.notes) {
            const v = n2.chord.voice;
            if (v < minVoice) minVoice = v;
            if (v > maxVoice) maxVoice = v;
            const p = n2.writtenPitch;
            if (p < 0) continue;
            if (p < minPitch) minPitch = p;
            if (p > maxPitch) maxPitch = p;
          }
          const v = nt.chord.voice;
          let res: number;
          maxPitch += 5;
          minPitch -= 5;
          if (v === minVoice) {
            res = top - 2;
            if (res < maxPitch) res = maxPitch;
            if ((res - top) % 2 !== 0) res++;
          } else {
            res = top - 8;
            if (res > minPitch) res = minPitch;
            if ((res - top) % 2 !== 0) res--;
          }
          nt.writtenPitch = res;
        }
      }
    }
  }
}

// ---------------- MeasureInfo（全局小节版面信息，dolce::Measure） ----------------

export enum EndingType {
  None,
  Start,
  Stop,
  Discontinue,
}

/** 小节线样式（musicpp 用 SMuFL 字形枚举，这里独立枚举；实际用线绘制）。 */
export enum BarGlyph {
  Single,
  Double,
  HeavyHeavy,
  Final,
  ReverseFinal,
  None, // bar-style none：占位且不可见
}

export class MeasureInfo {
  system!: Sys;
  number = "";

  endingNum = new Set<number>();
  leftEndingType = EndingType.None;
  rightEndingType = EndingType.None;

  index = 0;
  dur = new Fraction(0);
  offset = new Fraction(0);
  width = 0;

  forward = false;
  backward = false;

  clefPos: number | null = null;
  keyPos: number | null = null;
  timePos: number | null = null;
  keyOffestJP: number | null = null;
  leftBarlinePos = 0;
  dataPos = 0;
  dataEnd = 0;
  showBarNumber = false;
  sibKeyOffset = 0;

  entPos = new TickMap<number>();

  leftBarline: BarGlyph | null = null;
  rightBarline: BarGlyph | null = null;

  endTick(): Fraction {
    return this.dur.plus(this.offset);
  }

  /** 小节内 tick → x（Measure::getEntPos，相邻插值）。 */
  getEntPos(t: Fraction): number {
    let offset = 0;
    if (fEq(t, this.dur)) {
      const scr = this.system.score;
      if (this.index + 1 < scr.measures.length) {
        offset = -scr.measures[this.index + 1].sibKeyOffset;
      }
    }
    if (this.entPos.size === 0) {
      if (t.equals(0)) return Math.max(this.dataPos, 10);
      if (fEq(t, this.dur)) return this.width + offset;
      return this.dataPos;
    }
    if (fEq(t, this.dur)) return this.dataEnd + offset;
    // lower_bound(t)
    const entries = this.entPos.entries;
    let idx = entries.length;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].t.compareTo(t) >= 0) {
        idx = i;
        break;
      }
    }
    let next: number;
    let nextTick: Fraction;
    if (idx === entries.length) {
      next = this.width;
      nextTick = this.dur;
    } else if (fEq(entries[idx].t, t)) {
      return entries[idx].v;
    } else {
      next = entries[idx].v;
      nextTick = entries[idx].t;
    }
    const prevE = entries[idx - 1];
    if (!prevE) return this.dataPos;
    const dt = nextTick.minus(prevE.t).toFloat();
    const dtSub = t.minus(prevE.t).toFloat();
    const k = (next - prevE.v) / dt;
    return prevE.v + dtSub * k;
  }

  /** 小节在 system 内的 x 起点（Measure::xpos）。 */
  xpos(): number {
    let res = 0;
    for (const m of this.system.measures) {
      if (m === this) return res;
      res += m.width;
    }
    return res;
  }
}

// ---------------- Span objects（跨小节对象） ----------------

export class SpanObj {
  part!: MixedPart;
  startTick = new Fraction(0);
  endTick = new Fraction(0);
  above = false;
}

export class SpanOverNotes extends SpanObj {
  startNote: MNote | null = null;
  endNote: MNote | null = null;

  startChord(): MChord {
    return this.startNote!.chord;
  }
  endChord(): MChord {
    return this.endNote!.chord;
  }
}

export class Slur extends SpanOverNotes {}

export class Tied extends SpanOverNotes {
  yOffsetType = 0; // 0 middle, 1 up, -1 below
}

export class Tuplet extends SpanOverNotes {
  timeModification = new Fraction(1);
  bracket: boolean | null = null;

  static makeNumber(t: number): string {
    const zero = GlyphCodes.tuplet0.charCodeAt(0);
    let res = "";
    for (const c of String(t)) res += String.fromCharCode(zero + c.charCodeAt(0) - 48);
    return res;
  }
}

export class Ending extends SpanObj {
  startMeasure!: MeasureInfo;
  endMeasure!: MeasureInfo;
  number = "";
  hasStop = false;
}

/** 渐强/渐弱松叶（model.hpp:860 Wedge）。 */
export class Wedge extends SpanObj {
  startMeasure!: MeasureInfo;
  endMeasure!: MeasureInfo;
  crescendo = false;
  staff = 0;
  ypos = 0;
  dxLeft = 0;
  dxRight = 0;
}

/** 踏板线（model.hpp:873 PedalLine）。 */
export class PedalLine extends SpanObj {
  startMeasure!: MeasureInfo;
  endMeasure!: MeasureInfo;
  sign = false;
  line = false;
  staff = 0;
  ypos = 0;
}

/** 琶音（model.hpp:435 Arpeggiate）：同一 offset 上的一组音符。 */
export class Arpeggiate {
  notes: MNote[] = [];
}

export class LrcExtend extends SpanOverNotes {
  start: MLyric | null = null;
  stop: MLyric | null = null;
}

// ---------------- Part ----------------

export class MixedPart {
  score!: MixedScore;
  pid = "";
  measures: MeasureData[] = [];
  staves: PartStaff[] = [];

  slurs: Slur[] = [];
  tied: Tied[] = [];
  tuplets: Tuplet[] = [];
  endings: Ending[] = [];
  wedges: Wedge[] = [];
  pedalLines: PedalLine[] = [];
  lrcExtends: LrcExtend[] = [];

  newMeasure(): MeasureData {
    const m = new MeasureData();
    m.part = this;
    this.measures.push(m);
    return m;
  }
  newSlur(): Slur {
    const s = new Slur();
    s.part = this;
    this.slurs.push(s);
    return s;
  }
  newTied(): Tied {
    const s = new Tied();
    s.part = this;
    this.tied.push(s);
    return s;
  }
  newTuplet(): Tuplet {
    const s = new Tuplet();
    s.part = this;
    this.tuplets.push(s);
    return s;
  }
  newEnding(): Ending {
    const s = new Ending();
    s.part = this;
    this.endings.push(s);
    return s;
  }
  newWedge(): Wedge {
    const s = new Wedge();
    s.part = this;
    this.wedges.push(s);
    return s;
  }
  newPedalLine(): PedalLine {
    const s = new PedalLine();
    s.part = this;
    this.pedalLines.push(s);
    return s;
  }
  newLrcExtend(): LrcExtend {
    const s = new LrcExtend();
    s.part = this;
    this.lrcExtends.push(s);
    return s;
  }

  setLyricFont(f: Font): void {
    for (const md of this.measures) {
      for (const lrc of md.lyrics) lrc.font = f;
    }
  }

  calcMixedStaffY(): void {
    for (const sys of this.score.systems) {
      for (const st of sys.staves) {
        if (st.part() !== this) continue;
        st.calcMixedStaffY(sys);
      }
    }
  }

  /** Part::guessTiedPlacement（连音线方向推断）。 */
  guessTiedPlacement(): void {
    interface Pt {
      note: MNote;
      begin: boolean;
      up: boolean;
      hasDir: boolean;
      isTie: boolean;
      owner: Tied | null;
      other: Pt | null;
    }
    const ptsBegin = new Map<NoteEntry | null, Pt[]>();
    const ptsEnd = new Map<NoteEntry | null, Pt[]>();
    const push = (m: Map<NoteEntry | null, Pt[]>, k: NoteEntry | null, v: Pt) => {
      const arr = m.get(k);
      if (arr) arr.push(v);
      else m.set(k, [v]);
    };

    for (const sl of this.slurs) {
      const startNotes = sl.startChord().notes;
      const endNotes = sl.endChord().notes;
      const pta: Pt = {
        note: sl.above ? startNotes[startNotes.length - 1] : startNotes[0],
        begin: true,
        up: sl.above,
        hasDir: true,
        isTie: false,
        owner: null,
        other: null,
      };
      push(ptsBegin, pta.note.entry, pta);
      const ptb: Pt = {
        note: sl.above ? endNotes[endNotes.length - 1] : endNotes[0],
        begin: false,
        up: sl.above,
        hasDir: true,
        isTie: false,
        owner: null,
        other: null,
      };
      push(ptsEnd, ptb.note.entry, ptb);
      pta.other = ptb;
      ptb.other = pta;
    }
    for (const sl of this.tied) {
      const pta: Pt = {
        note: sl.startNote!,
        begin: true,
        up: sl.above,
        hasDir: false,
        isTie: true,
        owner: sl,
        other: null,
      };
      push(ptsBegin, pta.note.entry, pta);
      const ptb: Pt = {
        note: sl.endNote!,
        begin: false,
        up: sl.above,
        hasDir: false,
        isTie: true,
        owner: sl,
        other: null,
      };
      push(ptsEnd, ptb.note.entry, ptb);
      pta.other = ptb;
      ptb.other = pta;
    }

    const updateDirByVoice = (pts: Map<NoteEntry | null, Pt[]>) => {
      for (const [ent, vec] of pts) {
        if (!ent) continue;
        let minVoice = Infinity;
        let maxVoice = -Infinity;
        let hasUnknown = false;
        for (const nt of ent.notes) {
          const v = nt.chord.voice;
          if (v > maxVoice) maxVoice = v;
          if (v < minVoice) minVoice = v;
        }
        for (const pt of vec) if (!pt.hasDir) hasUnknown = true;
        if (!hasUnknown) continue;
        if (minVoice !== maxVoice) {
          for (const pt of vec) {
            if (pt.hasDir) continue;
            pt.hasDir = true;
            pt.other!.hasDir = true;
            pt.up = pt.note.chord.voice === minVoice;
            pt.other!.up = pt.up;
          }
        }
      }
    };
    const updateDirByPitch = (pts: Map<NoteEntry | null, Pt[]>) => {
      for (const [, vec] of pts) {
        if (vec.length < 2) continue;
        vec.sort((a, b) => a.note.writtenPitch - b.note.writtenPitch);
        const mid = Math.floor(vec.length / 2);
        for (let i = 0; i < vec.length; i++) {
          const pt = vec[i];
          if (pt.hasDir) continue;
          pt.hasDir = true;
          pt.other!.hasDir = true;
          pt.up = i >= mid;
          pt.other!.up = pt.up;
        }
      }
    };
    updateDirByVoice(ptsBegin);
    updateDirByVoice(ptsEnd);
    updateDirByPitch(ptsBegin);
    updateDirByPitch(ptsEnd);

    const eng = this.score.options;
    for (const sl of this.tied) {
      let ent = sl.startNote!.entry;
      let singleNote = (ent?.notes.length ?? 0) === 1;
      const vecB = ptsBegin.get(ent) ?? [];
      if (vecB.length !== 1) continue;
      const pta = vecB[0];
      ent = sl.endNote!.entry;
      if ((ent?.notes.length ?? 0) !== 1) singleNote = false;
      const vecE = ptsEnd.get(ent) ?? [];
      if (vecE.length !== 1) continue;
      const ptb = vecE[0];
      if (pta.hasDir) {
        sl.above = pta.up;
      } else {
        let ch = sl.startNote!.chord;
        if (fGe(ch.noteType, new Fraction(4))) ch = sl.endNote!.chord;
        const up = !ch.stemUp;
        sl.above = up;
        pta.up = up;
        ptb.up = up;
        pta.hasDir = true;
        ptb.hasDir = true;
      }

      const sym = sl.startNote!.chord.sym();
      const mifL = sl.startChord().measure.measureInfo;
      const mifR = sl.endChord().measure.measureInfo;
      const lx = sl.startNote!.x + smuflWidth(eng.meta, sym);
      const rx = sl.endNote!.x;
      let dx = rx - lx;
      if (mifL !== mifR) dx += mifL.width;
      if (singleNote || dx < 20) {
        sl.yOffsetType = sl.above ? 1 : -1;
      }
    }
    for (const [, vec] of ptsEnd) {
      for (const pt of vec) {
        if (!pt.owner) continue;
        if (!pt.hasDir) continue;
        pt.owner.above = pt.up;
      }
    }
  }

  /** Sibelius tie 元素不成对的修正（Part::fixTieForSib + TieProcessor）。 */
  fixTieForSib(): void {
    const startNotes = new Map<string, MNote[]>();
    const stopNotes = new Map<string, MNote[]>();
    const ticks: Fraction[] = [];
    const seen = new Set<string>();
    for (const md of this.measures) {
      for (const ch of md.chords) {
        if (ch.rest) continue;
        const t = ch.tick();
        for (const nt of ch.notes) {
          if (nt.tieBegin) {
            const k = t.plus(ch.dur).toString();
            if (!seen.has(k)) {
              seen.add(k);
              ticks.push(t.plus(ch.dur));
            }
            const arr = startNotes.get(k);
            if (arr) arr.push(nt);
            else startNotes.set(k, [nt]);
          }
          if (nt.tieEnd) {
            const k = t.toString();
            if (!seen.has(k)) {
              seen.add(k);
              ticks.push(t);
            }
            const arr = stopNotes.get(k);
            if (arr) arr.push(nt);
            else stopNotes.set(k, [nt]);
          }
        }
      }
    }
    const connect = (va: MNote[], vb: MNote[]): boolean => {
      if (va.length !== vb.length) return false;
      MNote.sortByPitchSnd(va);
      MNote.sortByPitchSnd(vb);
      for (let i = 0; i < va.length; i++) {
        if (va[i].soundPitch !== vb[i].soundPitch) return false;
      }
      for (let i = 0; i < va.length; i++) {
        va[i].tieBegin = true;
        vb[i].tieEnd = true;
      }
      return true;
    };
    ticks.sort((a, b) => a.compareTo(b));
    for (const t of ticks) {
      const va = startNotes.get(t.toString()) ?? [];
      let vb = stopNotes.get(t.toString()) ?? [];
      if (connect(va, vb)) continue;
      if (vb.length === 0) {
        console.warn("bad tie at", t.toString());
        continue;
      }
      const md = vb[0].chord.measure;
      vb = [];
      const pitches = new Set<number>();
      for (const nt of va) pitches.add(nt.soundPitch);
      for (const ch of md.chords) {
        if (!fEq(ch.tick(), t) || ch.rest) continue;
        for (const nt of ch.notes) {
          if (pitches.has(nt.soundPitch)) vb.push(nt);
        }
      }
      connect(va, vb);
    }
  }
}

// ---------------- PartGroup / SysStaff / System / Page ----------------

export enum GroupSymbol {
  None,
  Bracket,
  Brace,
}

export class PartGroup {
  parts: MixedPart[] = [];
  number = "";
  barline = false;
  symbol = GroupSymbol.None;
}

export class SysStaff {
  partStaff: PartStaff;
  distance = 0;
  staffLines = 5;
  staffScale = 1;
  staffVisible = true;

  // for mix
  minY = 0;
  harmonyY = 0;
  hasHarmony = false;

  constructor(partStaff: PartStaff) {
    this.partStaff = partStaff;
  }

  height(): number {
    return this.staffScale * (this.staffLines - 1) * 10;
  }
  part(): MixedPart {
    return this.partStaff.part;
  }
  subIndex(): number {
    return this.partStaff.subIndex;
  }

  /** SysStaff::calcMixedStaffY（model.cpp:2849）。slur bbox 通过回调求得（渲染层提供）。 */
  calcMixedStaffY(sys: Sys): void {
    let miny = -10; // 防止混排简谱离五线谱太近
    const eng = sys.score.options;
    const first = sys.firstMeasure;
    const cnt = sys.measures.length;
    const pt = this.part();
    const nota = this.partStaff.getNotation(sys.measures[0].offset);
    const mixed = nota === Notation.Mixed;
    for (let m = first; m < first + cnt; m++) {
      const mea = pt.measures[m];
      for (const ch of mea.chords) {
        if (fLt(ch.noteType, new Fraction(4)) && ch.stemUp) {
          let y = ch.tailY(true);
          if (ch.notations.length) y -= 20;
          if (y < miny) miny = y;
        }
      }
    }
    for (const sl of pt.slurs) {
      if (!sys.overlap(sl)) continue;
      if (!sl.above) continue;
      if (sys.contains(sl.startTick) && sys.contains(sl.endTick)) {
        const [pl, pr] = slurTiedPos(eng, sl.startChord(), sl.endChord(), true);
        const [pt0, pt1] = calcSlurPoints(pl, pr, true);
        // 三次贝塞尔 y 范围：取四个控制点 y 的最小值近似（够用：仅决定简谱层高度）
        const top = Math.min(pl.y, pt0.y, pt1.y, pr.y);
        miny = Math.min(miny, top - 1);
      }
    }

    this.minY = miny;

    const cntM = sys.measures.length;
    let dy = 5;
    for (let i = 0; i < cntM; i++) {
      const mid = first + i;
      const md = pt.measures[mid];
      const mif = md.measureInfo;
      const harmonyTexts = new Map<string, string>();
      for (const h of md.harmonies) {
        this.hasHarmony = true;
        const t = mif.offset.plus(h.offset);
        harmonyTexts.set(t.toString(), h.asPlainText());
      }
      for (const ch of md.chords) {
        const t = mif.offset.plus(ch.offset);
        const ht = harmonyTexts.get(t.toString());
        if (ht === undefined) continue;
        let slurEnd = false;
        let slurMiddle = false;
        for (const sl of pt.slurs) {
          if (fEq(sl.startTick, t) || fEq(sl.endTick, t)) {
            slurEnd = true;
          } else if (fLt(sl.startTick, t) && fGt(sl.endTick, t)) {
            slurMiddle = true;
            break;
          }
        }
        let tiedEnd = false;
        let tiedMiddle = false;
        for (const sl of pt.tied) {
          if (fEq(sl.startTick, t) || fEq(sl.endTick, t)) {
            tiedEnd = true;
          } else if (fLt(sl.startTick, t) && fGt(sl.endTick, t)) {
            tiedMiddle = true;
            break;
          }
        }
        let yy = 5;
        for (const nt of ch.notes) {
          if (nt.layer !== 1) continue;
          const oct = nt.octaveJp(eng.addOctaveJpForKeyA);
          if (oct > 0) yy += 5;
        }
        const offset = ht.length > 1 ? 10 : 5;
        if (slurMiddle) yy += 15;
        else if (slurEnd) yy += offset;
        if (tiedMiddle) yy += 15;
        else if (tiedEnd) yy += offset;
        if (yy > dy) dy = yy;
      }
    }

    let yval = this.minY - eng.mixStaffDist - eng.mixStaffHeight;
    if (!mixed) yval = this.minY - eng.mixStaffDist;
    if (dy < 8) dy = 8;
    this.harmonyY = -yval + dy;
  }

  /** SysStaff::getYBound（model.cpp:2745）。返回 [top, bot]（top 为上方延伸量，向上为正）。 */
  getYBound(sys: Sys): [number, number] {
    let minY = -60;
    let maxY = -Infinity;
    const pt = this.part();
    const t0 = sys.measures[0].offset;
    const t1 = sys.measures[sys.measures.length - 1].endTick();
    const nota = this.partStaff.getNotation(t0);
    const mixed = nota === Notation.Mixed;
    if (mixed) maxY = -this.minY + 35;
    let hasEnding = false;
    for (const e of pt.endings) {
      if (fGe(e.startTick, t1)) continue;
      if (fLe(e.endTick, t0)) continue;
      hasEnding = true;
    }
    let hasSlur = false;
    for (const sl of pt.slurs) {
      if (fGe(sl.startTick, t1)) continue;
      if (fLe(sl.endTick, t0)) continue;
      if (sl.startNote!.staff !== this.partStaff.subIndex) continue;
      hasSlur = true;
    }
    for (const sl of pt.tied) {
      if (fGe(sl.startTick, t1)) continue;
      if (fLe(sl.endTick, t0)) continue;
      if (sl.startNote!.staff !== this.partStaff.subIndex) continue;
      hasSlur = true;
    }
    if (hasSlur && mixed) maxY += 15;
    const first = sys.firstMeasure;
    const cnt = sys.measures.length;
    for (let m = first; m < first + cnt; m++) {
      const mea = pt.measures[m];
      for (const h of mea.harmonies) {
        let y = h.y + 10;
        if (hasEnding) y += 25;
        if (y > maxY) maxY = y;
      }
      for (const lrc of mea.lyrics) {
        const y = lrc.y - 10;
        if (y < minY) minY = y;
      }
      for (const t of mea.textBlocks) {
        const h: number[] = [];
        const hh = t.height(h);
        if (h.length === 0) continue;
        let y = t.y + h[0];
        if (y > maxY) maxY = y;
        y = t.y - hh;
        if (y < minY) minY = y;
      }
      for (const ch of mea.chords) {
        let y: number;
        if (fLt(ch.noteType, new Fraction(4))) {
          if (ch.stemUp) {
            y = -ch.tailY(false);
            if (ch.hasNotation(true)) y += 20;
            if (y > maxY) maxY = y;
          } else {
            y = -ch.tailY(false);
            if (ch.hasNotation(false)) y -= 20;
            if (y < minY) minY = y;
          }
        }
        if (ch.notes.length) {
          y = -ch.notes[0].cy() - 5;
          if (y < minY) minY = y;
        }
      }
    }
    if (maxY === -Infinity) maxY = 0;
    return [maxY, minY];
  }
}

export class Sys {
  score!: MixedScore;
  index = 0;
  distance = 0;
  firstMeasure = 0;
  leftMargin = 0;
  rightMargin = 0;

  keyChangeWidth = 0;
  timeChangeWidth = 0;

  measures: MeasureInfo[] = [];
  staves: SysStaff[] = [];

  top(): number {
    return this.distance;
  }

  ypos(stf: number): number {
    let res = 0;
    for (let i = 0; i <= stf; i++) {
      if (this.staves[i].staffVisible) {
        res += this.staves[i].distance;
        if (i < stf) res += this.staffHeight(i);
      }
    }
    return res;
  }

  yposPart(p: MixedPart, sub = 0): number {
    let res = 0;
    for (const stf of this.staves) {
      if (!stf.staffVisible) continue;
      res += stf.distance;
      if (stf.part() === p && sub === stf.subIndex()) break;
      res += stf.height();
    }
    return res;
  }

  visibleStavesOf(grp: PartGroup): [number, number] {
    let first = -1;
    let last = -1;
    for (const p of grp.parts) {
      for (const st of p.staves) {
        const stf = st.order;
        if (!this.staves[stf].staffVisible) continue;
        if (first < 0) first = stf;
        last = stf;
      }
    }
    return [first, last];
  }

  width(): number {
    let res = 0;
    for (const m of this.measures) res += m.width;
    return res;
  }

  height(): number {
    let res = 0;
    for (let i = 0; i < this.staves.length; i++) {
      if (this.staves[i].staffVisible) {
        res += this.staffHeight(i);
        res += this.staves[i].distance;
      }
    }
    return res;
  }

  staffHeight(i: number): number {
    const stf = this.staves[i];
    return stf.staffScale * (stf.staffLines - 1) * 10;
  }

  visibleStaves(): number {
    let cnt = 0;
    for (const st of this.staves) if (st.staffVisible) cnt++;
    return cnt;
  }

  overlap(obj: SpanObj): boolean {
    const start = this.measures[0].offset;
    const last = this.measures[this.measures.length - 1];
    const end = last.offset.plus(last.dur);
    if (fGe(obj.startTick, end)) return false;
    if (fLe(obj.endTick, start)) return false;
    return true;
  }

  contains(t: Fraction): boolean {
    const start = this.measures[0].offset;
    const last = this.measures[this.measures.length - 1];
    const end = last.offset.plus(last.dur);
    return fGe(t, start) && fLe(t, end);
  }

  beginTick(): Fraction {
    return this.measures[0].offset;
  }
  endTick(): Fraction {
    const last = this.measures[this.measures.length - 1];
    return last.offset.plus(last.dur);
  }

  /** 跨 part 小节线分组（System::barlineGroups）。 */
  barlineGroups(): Map<number, number> {
    const single = new Set<number>();
    const partStart = new Map<MixedPart, number>();
    const partEnd = new Map<MixedPart, number>();
    let stf = 0;
    for (const p of this.score.parts) {
      partStart.set(p, stf);
      stf += p.staves.length;
      partEnd.set(p, stf);
    }
    const pool: [number, number][] = [];
    const overlapR = (a: [number, number], b: [number, number]) =>
      a[0] < b[1] && b[0] < a[1];
    for (const grp of this.score.partGroups) {
      if (!grp.barline) continue;
      const pa = grp.parts[0];
      const pb = grp.parts[grp.parts.length - 1];
      let p: [number, number] = [partStart.get(pa)!, partEnd.get(pb)!];
      for (let i = pool.length - 1; i >= 0; i--) {
        if (overlapR(pool[i], p)) {
          p = [Math.min(pool[i][0], p[0]), Math.max(pool[i][1], p[1])];
          pool.splice(i, 1);
        }
      }
      pool.push(p);
    }
    for (let i = 0; i < this.staves.length; i++) {
      if (this.staves[i].staffVisible) single.add(i);
    }
    const groups = new Map<number, number>();
    for (const p of pool) {
      let first = -1;
      let last = -1;
      for (let i = p[0]; i < p[1]; i++) {
        single.delete(i);
        if (this.staves[i].staffVisible) {
          if (first < 0) first = i;
          last = i;
        }
      }
      if (first < 0) continue;
      groups.set(first, last);
    }
    for (const it of single) groups.set(it, it);
    return groups;
  }

  /** Sibelius 行首调号变更的偏移（System::fixSibKeyChange）。 */
  fixSibKeyChange(): void {
    for (let i = 1; i < this.measures.length; i++) {
      const cur = this.measures[i];
      if (cur.keyPos === null) continue;
      let endPos = 0;
      if (cur.clefPos !== null) endPos = cur.clefPos;
      let nextPos = cur.dataPos;
      if (cur.timePos !== null) nextPos = cur.timePos;
      cur.sibKeyOffset = nextPos - endPos;
    }
  }

  /** System::getYBound：[top, bot]。 */
  getYBound(): [number, number] {
    let first = -1;
    let last = -1;
    let idx = 0;
    for (const st of this.staves) {
      if (!st.staffVisible) {
        idx++;
        continue;
      }
      if (first < 0) first = idx;
      last = idx;
      idx++;
    }
    const [top] = this.staves[first].getYBound(this);
    let [, bot] = this.staves[last].getYBound(this);
    bot -= this.ypos(last);
    return [top, bot];
  }
}

export class PageText extends TextBlock {}

export class MPage {
  width = 0;
  height = 0;
  left = 0;
  right = 0;
  top = 0;
  bottom = 0;
  systems: Sys[] = [];
  texts: PageText[] = [];

  newText(): PageText {
    const t = new PageText();
    this.texts.push(t);
    return t;
  }
}

// ---------------- 选项（Engraver） / Defaults / Score ----------------

export interface LineWidths {
  staff: number;
  jpBeam: number;
  leger: number;
  stem: number;
  beam: number;
  heavyBarline: number;
  lightBarline: number;
}

/** 简谱/混排数字字体栈（musicpp 用 Source Han Sans SC，找不到时回退系统中文黑体）。 */
export const JP_FONT_FAMILY = "Source Han Sans SC, PingFang SC, Microsoft YaHei, sans-serif";

export class MixedOptions {
  // Engraver（model.hpp:1049）常量原样照搬
  mixStaffHeight = 30;
  mixStaffDist = 5;
  octaveDotDist = 6;
  addOctaveJpForKeyA = false;
  beamDistJP = 5;
  harmonyYPos = -60;

  hideBarNumber = false; // 对齐 musicpp model.hpp:1062（默认显示小节号）
  initialKeyTime = true;
  showKeyChangeJp = true; // PAO 混排显示简谱调号「1=X」（util/pao.cpp:999）
  lineWidths: LineWidths = {
    staff: 1,
    jpBeam: 1,
    leger: 1.5,
    stem: 1,
    beam: 5,
    heavyBarline: 5,
    lightBarline: 1.5,
  };
  barlineDist = 5;
  slurStemDy = 15;
  lrcHWID = true;
  chineseHyphen = false;
  harmonySize = 9;
  jpTopDy = 0;
  jpGraceScale = 0.6;
  cueSize = 0.8;

  meta: MetaData;
  musicFont: Font;
  jianpuFont: Font;
  mixFont: Font;
  wordFont = "Times New Roman";

  constructor(meta: MetaData) {
    this.meta = meta;
    this.musicFont = new Font("Bravura", 40);
    this.jianpuFont = new Font(JP_FONT_FAMILY, 30);
    this.mixFont = new Font(JP_FONT_FAMILY, (30 * this.mixStaffHeight) / 40);
  }
}

export class MixedDefaults {
  pageWidth = 1200;
  pageHeight = 1697;
  leftMargin = 85;
  rightMargin = 85;
  topMargin = 85;
  bottomMargin = 85;
  wordFont = new Font("Times New Roman", 20);
  lyricFont = new Font("Times New Roman", 20);
  musicTextFont = new Font("Bravura Text", 20);
}

export enum Encoder {
  Unknown,
  Sibelius,
  Finale,
  MuseScore,
}

export interface ScoreCredit {
  page: number;
  text: string;
  type: string | null;
  x: number;
  y: number;
  justify: LCR;
  fontSize: number;
}

export class MixedScore {
  scaling = 1;
  encoder = Encoder.Unknown;
  measures: MeasureInfo[] = [];
  parts: MixedPart[] = [];
  pages: MPage[] = [];
  systems: Sys[] = [];
  partGroups: PartGroup[] = [];

  options: MixedOptions;
  defaults = new MixedDefaults();
  title = "";
  credits: ScoreCredit[] = [];

  constructor(options: MixedOptions) {
    this.options = options;
  }

  newPart(): MixedPart {
    const p = new MixedPart();
    p.score = this;
    this.parts.push(p);
    return p;
  }

  newMeasure(): MeasureInfo {
    const m = new MeasureInfo();
    m.index = this.measures.length;
    this.measures.push(m);
    return m;
  }

  numMeasures(): number {
    return this.measures.length;
  }
}

// ---------------- slur/tied 几何（SpanObj 静态方法，model.cpp:2582-2740） ----------------

export interface Pt2 {
  x: number;
  y: number;
}

/** 贝塞尔控制点（SpanObj::calcSlurPoints）。返回 [p1, p2, cos]。 */
export function calcSlurPoints(pl: Pt2, pr: Pt2, up: boolean): [Pt2, Pt2, number] {
  const dx = pr.x - pl.x;
  const dy = pr.y - pl.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const theta = Math.atan2(dy, dx);
  const cos = Math.cos(-theta);
  const sin = Math.sin(-theta);
  const xlen = Math.min(dist * 0.04 + 10, dist * 0.25);
  let h = Math.log10(Math.max(dist, 1e-6)) * 17 - 16;
  if (up) h *= -1;
  const rot = (p: Pt2): Pt2 => ({ x: p.x * cos + p.y * sin, y: p.y * cos - p.x * sin });
  const p1 = rot({ x: xlen, y: h });
  const p2 = rot({ x: dist - xlen, y: h });
  p1.x += pl.x;
  p1.y += pl.y;
  p2.x += pl.x;
  p2.y += pl.y;
  return [p1, p2, cos];
}

/** 五线谱 slur/tied 锚点（SpanObj::slurTiedPos）。 */
export function slurTiedPos(
  eng: MixedOptions,
  chl: MChord | null,
  chr: MChord | null,
  above: boolean,
): [Pt2, Pt2] {
  const pl: Pt2 = { x: 0, y: 0 };
  const pr: Pt2 = { x: 0, y: 0 };
  if (chl) pl.x = chl.stemX() + chl.measure.xpos();
  if (chr) pr.x = chr.stemX() + chr.measure.xpos();

  let near = false;
  if (chl && chr) {
    const dt = chr.tick().minus(chl.tick());
    if (fEq(dt, chl.dur)) near = true;
  }

  let yoff = 5;
  let inc = 1;
  if (above) {
    inc = -1;
    yoff *= -1;
  }
  const stemDistDx = 3;
  const four = new Fraction(4);
  if (chl) {
    if (chl.stemUp === above) {
      pl.y = chl.tailY(true) + yoff;
      if (fLt(chl.noteType, four) && chl.beams.length === 0 && near) {
        pl.y -= eng.slurStemDy * inc;
        pl.x += stemDistDx;
      }
    } else {
      if (!above) pl.x -= 13;
      pl.y = chl.stemY() + yoff * 2;
    }
  }
  if (chr) {
    if (chr.stemUp === above) {
      pr.y = chr.tailY(true) + yoff;
      if (fLt(chr.noteType, four) && chr.beams.length === 0 && near) {
        pr.y -= eng.slurStemDy * inc;
        pr.x -= stemDistDx;
      }
    } else {
      pr.y = chr.stemY() + yoff * 2;
    }
  }
  if (chl && chr) {
    if (chl.stemUp !== above || fGe(chl.noteType, four)) {
      if (pl.y < pr.y && !above) {
        pl.y += inc * 3;
      }
      if (chr.stemUp !== above) pl.x += 5;
    }
    if (chr.stemUp !== above) {
      if (above) pr.x += 7;
      else pr.x -= 5;
    }
  }
  if (!chl) pl.y = pr.y;
  if (!chr) pr.y = pl.y;
  return [pl, pr];
}

/** 简谱层 slur/tied 锚点（SpanObj::slurTiedPosForJp）。 */
export function slurTiedPosForJp(
  eng: MixedOptions,
  chl: MChord,
  chr: MChord,
  checkTied = false,
): [Pt2, Pt2] {
  const refLeft = chl.stemNote();
  const refRight = chr.stemNote();
  const pl: Pt2 = { x: refLeft.cx(eng.meta) + chl.measure.xpos(), y: 0 };
  const pr: Pt2 = { x: refRight.cx(eng.meta) + chr.measure.xpos(), y: 0 };
  let dot = 0;
  let hasTied = false;
  for (const nt of chl.notes) {
    if (nt.layer === 1) {
      const dd = nt.octaveJp(eng.addOctaveJpForKeyA);
      if (dd > dot) dot = dd;
      if (checkTied && nt.tieBegin) hasTied = true;
    }
  }
  for (const nt of chr.notes) {
    if (nt.layer === 1) {
      const dd = nt.octaveJp(eng.addOctaveJpForKeyA);
      if (dd > dot) dot = dd;
    }
  }
  pl.y = 4 - dot * 6;
  pr.y = 4 - dot * 6;
  if (hasTied) {
    pl.y -= 5;
    pr.y -= 5;
  }
  pl.y -= eng.jpTopDy;
  pr.y -= eng.jpTopDy;
  return [pl, pr];
}
