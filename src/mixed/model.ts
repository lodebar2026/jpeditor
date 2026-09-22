// 五线谱引擎（混排）的**版面态**。从 musicpp model/model.hpp + model.cpp 移植
// （dolce::Score/Part/Staff/Chord/Note/System/SysStaff 等）。
// 单位：tenths（五线谱高 40，线距 10），y 向下，五线谱顶线 y=0。
// 水平位置信任 MusicXML 内嵌版面（default-x / measure width），没有时走自动版面（`layoutpass.ts`）。
//
// **这里不是模型**：根对象 `StaffLayout` 与各版面节点只存引擎自己算出来的东西
// （坐标、符干、符杠、系统与页、按 tick 查的谱号/调号/拍号索引），语义经各节点的 `src` 从 `ScoreDoc` 取。

import { Fraction } from "../common/fraction";
import { Point } from "../common/geom";
import { Font } from "../layout/font";
import { SlurTieBase, type SlurStyle } from "../layout/pageitem";
import { MIXED_PUNCT, type CompressMode } from "../common/cjkpunct";
import { MetaData, GlyphCodes } from "../smufl/smufl";
import type { Chord as DocChord, Direction as DocDirection, Harmony as DocHarmony, Lyric as DocLyric, Mark as DocMark, Note as DocNote, Song } from "../model/doc";
import { beamCount } from "../model/jianpu";

const STEP_CHROMATIC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// noteType 以四分音符为单位（musicpp parser.cpp:625-665）：quarter=1、whole=4、eighth=1/2…
const NOTE_TYPE_MAP: Record<string, Fraction> = {
  "1024th": new Fraction(1, 256),
  "512th": new Fraction(1, 128),
  "256th": new Fraction(1, 64),
  "128th": new Fraction(1, 32),
  "64th": new Fraction(1, 16),
  "32nd": new Fraction(1, 8),
  "16th": new Fraction(1, 4),
  eighth: new Fraction(1, 2),
  quarter: new Fraction(1),
  half: new Fraction(2),
  whole: new Fraction(4),
  breve: new Fraction(8),
  long: new Fraction(16),
};

export function noteTypeFraction(typeName: string): Fraction {
  return NOTE_TYPE_MAP[typeName] ?? new Fraction(1);
}


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

/**
 * 各行视觉高度（用于 getYBound 的垂直延伸估算）：音乐字形按真实包围盒
 * （smuflTop/Bottom 以 em=musicEm 为基准，再按字号缩放），文本按字体 ascent/descent。
 * 修正 TextBlock.height() 用 Bravura 字体度量导致力度/节拍记号虚高、撑大谱表间距的问题。
 */
function tightLineHeights(t: TextBlock, meta: MetaData, musicEm: number, textBySize = false): number[] {
  const h: number[] = [];
  let lineH = 0;
  for (const it of t.data) {
    if (it.text === "\n") {
      h.push(lineH);
      lineH = 0;
      continue;
    }
    let ih: number;
    if (textBySize) {
      // 歌本口径：行高按字号（原排版程序 Font::height() 就是字号，model.cpp TextBlock::height），记号也一样。
      // 字体 ascent−descent 约 1.45 个字号，按它算多行文字块会虚高（《我心等候祢》拆行后被挤成两页）；
      // 记号按墨高算则比原程序矮，《基督是锚》segno 那行谱会上移约 11 tenths
      ih = it.nominalSize ?? it.font.size;
    } else if (it.music) {
      let gh = 0;
      for (const ch of it.text) gh = Math.max(gh, smuflTop(meta, ch) - smuflBottom(meta, ch));
      ih = gh * (musicEm > 0 ? it.font.size / musicEm : 1);
    } else {
      const fm = it.font.metrics;
      ih = fm.descent - fm.ascent;
    }
    if (ih > lineH) lineH = ih;
  }
  if (lineH > 0) h.push(lineH);
  return h;
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
  part: PartLayout;
  subIndex: number;
  order = 0;
  key = new TickMap<KeySig>();
  clef = new TickMap<ClefSig>();
  time = new TickMap<TimeSig>();
  notation = new TickMap<Notation>();

  constructor(part: PartLayout, subIndex: number) {
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

export class NoteLayout {
  chord: ChordLayout;
  entry: NoteEntry | null = null;
  /** `ScoreDoc` 里对应的音（`layout.ts` 挂上；休止与无音高的节奏音符为 null）。简谱叠层的唱名/八度/临时记号从它的 `degree` 取 */
  src: DocNote | null = null;
  /** 简谱叠层印的就是这个音（语义层 `melodyChords` 那一路的 `topNote`，休止也算） */
  jpMelody = false;
  /** 谱表上的位置（记谱音高按调式音级计，含移调）。有音高时 `layout.ts` 按 `src.pitch` 算好；
   *  **休止由 `fixPitchForRest` 排到谱表上**，所以它是版面坐标、不是只读的语义 */
  writtenPitch = -1;
  /** 延音线起止（读入时照 `<tie>`，Sibelius 不成对的由 `fixTieForSib` 补） */
  tieBegin = false;
  tieEnd = false;
  flipped = false;
  /** 所属琶音组（无则 null）。 */
  arpeg: Arpeggiate | null = null;
  x = -1;

  constructor(chord: ChordLayout) {
    this.chord = chord;
  }

  // ---- 语义：一律从 ScoreDoc 取 ----
  /** 发音音高（MIDI 口径，休止与无音高为 0） */
  get soundPitch(): number {
    const p = this.src?.pitch;
    if (this.chord.rest || !p) return 0;
    return (p.octave + 1) * 12 + (STEP_CHROMATIC[p.step] ?? 0) + Math.round(p.alter);
  }
  get alter(): number {
    return this.chord.rest ? 0 : this.src?.pitch?.alter ?? 0;
  }
  /** 所在谱表（0 基） */
  get staff(): number {
    return (this.chord.src?.staff ?? 1) - 1;
  }
  /** 显示尺寸：1=cue（小符头），0=正常（MusicXML <type size="cue">）。 */
  get size(): number {
    return (this.src?.typeSize ?? this.chord.src?.typeSize) === "cue" ? 1 : 0;
  }
  get visible(): boolean {
    return this.chord.src?.printObject !== false;
  }
  get parenthesesAcc(): boolean {
    return this.src?.accidental ? this.src.accidentalParentheses === true : false;
  }
  /** 面上印的临时记号（SMuFL 字形，"" 表示无）。 */
  get acc(): string {
    switch (this.src?.accidental?.trim()) {
      case "flat": return GlyphCodes.accidentalFlat;
      case "sharp": return GlyphCodes.accidentalSharp;
      case "natural": return GlyphCodes.accidentalNatural;
      case "double-sharp": return GlyphCodes.accidentalDoubleSharp;
      case "flat-flat": return GlyphCodes.accidentalDoubleFlat;
      default: return "";
    }
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

  // ---- 简谱写法：一律取语义层给的度数（`model/jianpu.ts::assignDegrees`，读 MusicXML 时已算好）----
  number(): string {
    if (this.chord.rest) return "0";
    return String(this.src?.degree?.number ?? 0);
  }
  /** 简谱八度点数（>0 上加点，<0 下加点）。 */
  octaveJp(): number {
    if (this.chord.rest) return 0;
    return this.src?.degree?.octaveShift ?? 0;
  }
  /** 简谱面上要印的临时记号（1 升 / -1 降 / 0 还原），不印为 null。延续规则在语义层（`AccidentalCarry`） */
  jpAccidental(): number | null {
    const acc = this.src?.degree?.accidental;
    if (!acc) return null;
    return acc.includes("sharp") ? 1 : acc.includes("flat") ? -1 : 0;
  }

  static sortByPitchWr(v: NoteLayout[]): void {
    v.sort((a, b) => a.writtenPitch - b.writtenPitch);
  }
  static sortByPitchSnd(v: NoteLayout[]): void {
    v.sort((a, b) =>
      a.writtenPitch !== b.writtenPitch
        ? a.writtenPitch - b.writtenPitch
        : a.chord.voice - b.chord.voice,
    );
  }
}

export class ChordLayout {
  measure: PartMeasureLayout;
  /** `ScoreDoc` 里对应的和弦 */
  readonly src: DocChord;
  /** 所在小节的 divisions（时值换算用） */
  readonly divisions: number;
  /** 小节内起点（四分音符为 1）：`<backup>`/`<forward>` 游标折算好的，引擎一切按它定时间 */
  offset = new Fraction(0);
  /** 整小节休止（读到时按那一刻的小节长判；无 `<type>` 的休止也算） */
  measureRest = false;
  doubleSide = false;

  stemLen = 0; // 无符干（全音符）默认 0，与 musicpp 一致；有符干者在 calcStemLen 赋值
  stemUp = true;
  stemExtra = 0; // 跨谱表符杠时符干延伸量（model.hpp stemExtra / styler.cpp calcSlopeLen）

  notes: NoteLayout[] = [];
  /** 符杠逐层状态（照 `<beam>`，整声部没写时由自动符杠补） */
  beams: BeamVal[] = [];
  notations: NotationItem[] = [];

  constructor(measure: PartMeasureLayout, src: DocChord, divisions: number) {
    this.measure = measure;
    this.src = src;
    this.divisions = divisions;
    this.measureRest = !src.duration.type;
  }

  // ---- 语义：一律从 ScoreDoc 取 ----
  get rest(): boolean {
    return this.src.rest !== undefined;
  }
  get grace(): boolean {
    return this.src.grace !== undefined;
  }
  get cue(): boolean {
    return this.src.cue === true;
  }
  /** 声部（0 基） */
  get voice(): number {
    return this.src.voice - 1;
  }
  get dot(): number {
    return this.src.duration.dots;
  }
  /** 斜线符头（节奏记谱） */
  get slash(): boolean {
    return this.src.notes.some((n) => n.notehead?.trim() === "slash");
  }
  /** 实际时值（四分音符为 1） */
  get dur(): Fraction {
    return new Fraction(this.src.duration.divisions, this.divisions);
  }
  /** 符号时值（四分音符为 1，纯由 `<type>` 决定；没有 `<type>` 按全音符字形） */
  get noteType(): Fraction {
    const t = this.src.duration.type;
    return t ? noteTypeFraction(t) : new Fraction(4);
  }
  /** 连音比（normal / actual） */
  get timeModification(): Fraction {
    const tm = this.src.duration.timeMod;
    return tm ? new Fraction(tm.normal, tm.actual) : new Fraction(1);
  }

  newNote(): NoteLayout {
    const n = new NoteLayout(this);
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
  overlape(ch: ChordLayout): boolean {
    const t0 = this.tick();
    const t1 = t0.plus(this.dur);
    const t2 = ch.tick();
    const t3 = t2.plus(ch.dur);
    if (t0.compareTo(t3) >= 0) return false;
    if (t1.compareTo(t2) <= 0) return false;
    return true;
  }

  /** 简谱减时线条数（语义层 `jianpuShape`）。 */
  jpBeamCount(): number {
    return beamCount(this.src, this.divisions);
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

  tailNote(): NoteLayout {
    return this.stemUp ? this.notes[this.notes.length - 1] : this.notes[0];
  }
  stemNote(): NoteLayout {
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
    NoteLayout.sortByPitchWr(this.notes);
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
    let last: NoteLayout | null = null;
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

  static sortByOffset(arr: ChordLayout[]): void {
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
  notes: NoteLayout[] = [];
  dots = new Set<number>();
  dotPos = 0;

  addNote(n: NoteLayout): void {
    this.notes.push(n);
  }

  update(meta: MetaData): void {
    this.dots.clear();
    this.dotPos = 0;
    const done = new Set<NoteLayout>();
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
  notes: NoteLayout[] = [];
  measure: PartMeasureLayout;
  leger = new LegerLayout();
  dot = new DotLayout();
  acc: AccidentalLayout;
  subStaff = 0;
  offset = new Fraction(0);

  constructor(measure: PartMeasureLayout, meta: MetaData) {
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
    const chords = new Set<ChordLayout>();
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

export class LyricLayout {
  measure: PartMeasureLayout;
  /** `ScoreDoc` 里对应的歌词 */
  readonly src: DocLyric;
  readonly chord: ChordLayout;
  offset = new Fraction(0);
  font!: Font;
  /** 标点挤压档（`MixedOptions.lrcHWID` → 半身式）：量宽与绘制共用这一个，绝不能各走各的。 */
  compress: CompressMode = "halfwidth";
  extend: Fraction | null = null;

  x = -1;
  y = -1;
  xOffset = 0;
  width = 0;
  prev: LyricLayout | null = null;
  next: LyricLayout | null = null;

  constructor(measure: PartMeasureLayout, src: DocLyric, chord: ChordLayout) {
    this.measure = measure;
    this.src = src;
    this.chord = chord;
  }

  // ---- 语义：一律从 ScoreDoc 取 ----
  /** 段号原文（分段按它） */
  get num(): string {
    return this.src.numberText ?? String(this.src.number);
  }
  get name(): string {
    return this.src.name ?? "";
  }
  /** 印在首字前的段落号（`1.圣` 的 `1.`）与去掉它的正文 */
  private get split(): { prefix: string; text: string } {
    const text = this.src.text.trim();
    if (text.length > 0 && /^\d/.test(text)) {
      const dot = text.indexOf(".");
      if (dot >= 0) return { prefix: text.slice(0, dot + 1), text: text.slice(dot + 1) };
    }
    return { prefix: "", text };
  }
  get text(): string {
    return this.split.text;
  }
  get prefix(): string {
    return this.split.prefix;
  }
  /** 词首 / 词尾（`<syllabic>`） */
  get begin(): boolean {
    const s = this.src.syllabic ?? "single";
    return s === "single" || s === "begin";
  }
  get end(): boolean {
    const s = this.src.syllabic ?? "single";
    return s === "single" || s === "end";
  }
  get staff(): number {
    return this.chord.src.staff - 1;
  }
  get halign(): LCR {
    return this.src.justify === "right" ? LCR.Right : this.src.justify === "left" ? LCR.Left : LCR.Center;
  }

  get empty(): boolean {
    return this.text.length === 0;
  }

  /** [前导非CJK宽, CJK段宽, 尾随非CJK宽]（Lyric::widthInfo 移植）。
   *  注意：前缀（段落号）不计入，由 drawLrc 单独按固定偏移摆放。 */
  widthInfo(): [number, number, number] {
    const chars = [...this.text];
    if (chars.length === 0) return [0, 0, 0];
    const isCjk = (ch: string) => ch.charCodeAt(0) > 0x80 && !MIXED_PUNCT.includes(ch);
    let first = 0;
    let last = chars.length - 1;
    for (let i = 0; i < chars.length; i++) if (isCjk(chars[i])) { first = i; break; }
    for (let i = chars.length - 1; i >= 0; i--) if (isCjk(chars[i])) { last = i; break; }
    // 宽度取**标点挤压后**的笔位（见 common/cjkpunct.ts）：居中的锚点跟着挪，绘制端拿的是同一串坐标。
    // 档位照 `compress`——歌词走半身式（musicpp 的 `lrcHWID` → 歌词字体开 OpenType `halt`），
    // 不是 `Font.run()` 缺省的全身式 `clreq`：两派压出来的总宽、居中偏移与逐字落点都不同。
    const { xs, width } = this.font.run(this.text, this.compress);
    const at = (i: number): number => (i <= 0 ? 0 : i >= xs.length ? width : xs[i]);
    return [at(first), at(last + 1) - at(first), width - at(last + 1)];
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

export class HarmonyLayout {
  measure: PartMeasureLayout;
  /** `ScoreDoc` 里对应的和弦符号 */
  readonly src: DocHarmony;
  offset = new Fraction(0);
  x = 0;
  y = 0;

  constructor(measure: PartMeasureLayout, src: DocHarmony) {
    this.measure = measure;
    this.src = src;
  }

  // ---- 语义：一律从 ScoreDoc 取 ----
  get root(): HarmonyStepAlter {
    return { step: this.src.root.step, alter: this.src.root.alter };
  }
  get bass(): HarmonyStepAlter | null {
    return this.src.bass ? { step: this.src.bass.step, alter: this.src.bass.alter } : null;
  }
  get degree(): { value: number; alter: number; type: HarmonyDegreeType }[] {
    return (this.src.degrees ?? []).map((g) => ({
      value: g.value,
      alter: g.alter,
      type: g.type === "subtract" ? HarmonyDegreeType.Subtract : g.type === "alter" ? HarmonyDegreeType.Alter : HarmonyDegreeType.Add,
    }));
  }
  get kind(): string {
    return this.src.kind.trim();
  }
  get kindText(): string | null {
    return this.src.kindText ?? null;
  }
  get useSymbols(): boolean {
    return this.src.useSymbols === true;
  }
  /** 加音加括号（Sibelius 导出一律加，照 musicpp） */
  get parenthesesDegrees(): boolean {
    return this.src.parenthesesDegrees === true || this.measure.part.score.encoder === Encoder.Sibelius;
  }
  get staff(): number {
    return (this.src.staff ?? 1) - 1;
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

    // MuseScore 把 A7sus4 输出成 kind=suspended-fourth + text="74" + <degree>add 7</degree>，
    // 直接采用 text "74" 会排成错乱的 A⁷⁴add7。此时忽略 kindText，规范展示成 A7(sus4)。
    // 仅针对 MuseScore：其它软件（Sibelius/Finale）对 sus 和弦的记法不同，勿动。
    const addSeventh = this.degree.find(
      (d) => d.type === HarmonyDegreeType.Add && d.value === 7,
    );
    const susFourthSeventh =
      this.measure.part.score.encoder === Encoder.MuseScore &&
      this.kind === "suspended-fourth" &&
      !!addSeventh;
    // susFourthSeventh 时把 add 7 度并入后缀，剩余度数照常渲染。
    const degrees = susFourthSeventh
      ? this.degree.filter((d) => d !== addSeventh)
      : this.degree;

    let kt = "";
    let useSym = false;
    let sym = "";
    if (susFourthSeventh) {
      kt = "7(sus4)";
    } else if (this.kindText !== null && this.kindText !== "") {
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
    if (degrees.length > 1) {
      let deg = "";
      if (isSus4(degrees)) deg = "sus4";
      if (deg) {
        if (this.parenthesesDegrees) segs.push({ text: "(", music: false, superscript: 1, dy: 0 });
        segs.push({ text: deg, music: false, superscript: 1, dy: 0 });
        if (this.parenthesesDegrees) segs.push({ text: ")", music: false, superscript: 1, dy: 0 });
      }
    } else if (degrees.length === 1) {
      const d = degrees[0];
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
  /** 原程序里这项的字号（换了字体、画的字号跟着换算时记下原值；歌本按字号算行高用它） */
  nominalSize?: number;
}

export class TextBlock {
  data: TextBlockItem[] = [];
  x = 0;
  y = 0;
  justify = LCR.Left;
  title = false;

  /** 文字里的换行拆成「项 + 换行项」（TextBlock::add 的 boost::split）：`<words>` 原文带换行就是多行 */
  add(text: string, font: Font, music = false, nominalSize?: number): void {
    text.split("\n").forEach((s, i) => {
      if (i > 0) this.data.push({ font, text: "\n", dy: 0, music, superscript: 0 });
      if (s) this.data.push({ font, text: s, dy: 0, music, superscript: 0, ...(nominalSize !== undefined ? { nominalSize } : {}) });
    });
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
  measure: PartMeasureLayout;
  offset = new Fraction(0);
  staff = 0;
  /** x 是否相对拍位（updateDataXPos 再加拍位 x）；false 时 x 就是小节内坐标（只写 default-x 的 `<words>`） */
  relative = true;
  /** y 是自动铺排给的缺省高度（原文没写 default-y）：混排时要让到简谱层之上（`formatMixedScore`） */
  autoY = false;
  /** `ScoreDoc` 里对应的 `<direction>`（导出时把排好的高度写回，`engrave.ts`） */
  src: DocDirection | null = null;

  constructor(measure: PartMeasureLayout) {
    super();
    this.measure = measure;
  }
}

// ---------------- BeamGroup ----------------

export class BeamGroup {
  chords: ChordLayout[] = [];
  jp = false;
  doubleDir = false;

  /** 源谱没写符干方向时，整组**一起**定一个方向：离中线（line = −4）最远的音在上方就朝下、在下方就朝上；
   *  上下一样远看哪边的音多，还一样就朝下（常规制谱）。逐和弦各猜会让同一根符杠两头符干反向。 */
  unifyStemDir(): void {
    let above = 0, below = 0, nAbove = 0, nBelow = 0;
    for (const ch of this.chords) {
      if (ch.rest) continue;
      for (const nt of ch.notes) {
        const dev = nt.line() + 4; // > 0 在中线之上
        if (dev > 0) { above = Math.max(above, dev); nAbove++; }
        else if (dev < 0) { below = Math.max(below, -dev); nBelow++; }
      }
    }
    const up = below > above || (below === above && nBelow > nAbove);
    for (const ch of this.chords) ch.stemUp = up;
  }

  /** 方向定好之后（或音符 x 变了）重排：休止（不画符干）跟本组首个实音，再标 `doubleDir`、按斜率算各符干长。 */
  refresh(): void {
    if (this.chords.length === 0) return;
    // beam-over-rest：符杠内的休止符无 <stem>，stemUp 取默认 true。若两侧音符均为
    // stem-down，会被误判 doubleDir；而 doubleDir 的 calcSlopeLen 分支不做「下符头避让」
    // （非 doubleDir 分支才有 +35 最小符干），导致八度等宽和弦的符杠穿过下符头。
    const ref = this.chords.find((ch) => !ch.rest) ?? this.chords[0]!;
    for (const ch of this.chords) if (ch.rest) ch.stemUp = ref.stemUp;
    this.doubleDir = this.chords.some((ch) => ch.stemUp !== ref.stemUp);
    this.format(0);
  }

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
      NoteLayout.sortByPitchWr(nts);
      for (const ch of this.chords) {
        if (ch === first) continue;
        const nts2 = [...ch.notes];
        NoteLayout.sortByPitchWr(nts2);
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

    const refChords: ChordLayout[] = [this.chords[0]];
    if (this.chords.length >= 3) refChords.push(this.chords[this.chords.length - 1]);
    for (const refCh of refChords) {
      const nts = [...refCh.notes];
      NoteLayout.sortByPitchWr(nts);
      const refs: NoteLayout[] = [nts[0]];
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

// ---------------- PartMeasureLayout（声部内单小节内容，dolce::MusicData） ----------------

export class PartMeasureLayout {
  measureInfo!: MeasureLayout;
  part!: PartLayout;

  chords: ChordLayout[] = [];
  lyrics: LyricLayout[] = [];
  harmonies: HarmonyLayout[] = [];
  textBlocks: MeasureText[] = [];
  arpegs: Arpeggiate[] = [];

  beams: BeamGroup[] = [];
  graceBeams: BeamGroup[] = [];
  jpBeams: BeamGroup[] = [];
  noteEntries: NoteEntry[] = [];

  newChord(src: DocChord, divisions: number): ChordLayout {
    const ch = new ChordLayout(this, src, divisions);
    this.chords.push(ch);
    return ch;
  }
  newLyric(src: DocLyric, chord: ChordLayout): LyricLayout {
    const l = new LyricLayout(this, src, chord);
    this.lyrics.push(l);
    return l;
  }
  newHarmony(src: DocHarmony): HarmonyLayout {
    const h = new HarmonyLayout(this, src);
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

  /** 和弦按起点、和弦内的音按记谱音高排好（musicpp splitLayer 的前半；分层那半由语义层的旋律取音代替） */
  sortChords(): void {
    this.chords.sort((a, b) => a.offset.compareTo(b.offset));
    for (const ent of this.chords) {
      ent.notes.sort((a, b) => a.writtenPitch - b.writtenPitch);
    }
  }

  /** 简谱减时线分组（MusicData::processJpBeam）。 */
  processJpBeam(): void {
    const layer: ChordLayout[] = [];
    let stf = -1;
    for (const ch of this.chords) {
      for (const nt of ch.notes) {
        if (nt.jpMelody) {
          layer.push(ch);
          stf = nt.staff;
          break;
        }
      }
    }
    if (stf < 0) return;
    ChordLayout.sortByOffset(layer);
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

// ---------------- MeasureLayout（全局小节版面信息，dolce::Measure） ----------------

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

export class MeasureLayout {
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
  /** `<measure implicit="yes">`：不计小节号（小节中间换行拆出的后半、弱起） */
  implicit = false;
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
  part!: PartLayout;
  startTick = new Fraction(0);
  endTick = new Fraction(0);
  above = false;
}

export class SpanOverNotes extends SpanObj {
  startNote: NoteLayout | null = null;
  endNote: NoteLayout | null = null;

  startChord(): ChordLayout {
    return this.startNote!.chord;
  }
  endChord(): ChordLayout {
    return this.endNote!.chord;
  }
}

export class Slur extends SpanOverNotes {
  /** 源谱没写朝向：等符干定好后由 `guessTiedPlacement` 定 */
  autoDir = false;
  /** 源标记（导出时把排出来的方向写回去） */
  mark: DocMark | null = null;
}

export class Tied extends SpanOverNotes {
  yOffsetType = 0; // 0 middle, 1 up, -1 below
}

export class Tuplet extends SpanOverNotes {
  timeModification = new Fraction(1);
  bracket: boolean | null = null;

  /** 五线谱上括号/数字两端的 y（render.cpp::drawTuplet：在符杠一侧贴符尾，在符头一侧离符干端 15，再外推 10）。 */
  staffEnds(): [number, number] {
    const sign = this.above ? 1 : -1;
    const endY = (ch: ChordLayout) =>
      (this.above === ch.stemUp ? ch.tailY(true) - 10 * sign : ch.stemY() - 15 * sign) - sign * 10;
    return [endY(this.startChord()), endY(this.endChord())];
  }

  static makeNumber(t: number): string {
    const zero = GlyphCodes.tuplet0.charCodeAt(0);
    let res = "";
    for (const c of String(t)) res += String.fromCharCode(zero + c.charCodeAt(0) - 48);
    return res;
  }
}

export class Ending extends SpanObj {
  startMeasure!: MeasureLayout;
  endMeasure!: MeasureLayout;
  number = "";
  hasStop = false;
}

/** 渐强/渐弱松叶（model.hpp:860 Wedge）。 */
export class Wedge extends SpanObj {
  startMeasure!: MeasureLayout;
  endMeasure!: MeasureLayout;
  crescendo = false;
  staff = 0;
  ypos = 0;
  dxLeft = 0;
  dxRight = 0;
}

/** 踏板线（model.hpp:873 PedalLine）。 */
export class PedalLine extends SpanObj {
  startMeasure!: MeasureLayout;
  endMeasure!: MeasureLayout;
  sign = false;
  line = false;
  staff = 0;
  ypos = 0;
}

/** 琶音（model.hpp:435 Arpeggiate）：同一 offset 上的一组音符。 */
export class Arpeggiate {
  notes: NoteLayout[] = [];
}

export class LrcExtend extends SpanOverNotes {
  start: LyricLayout | null = null;
  stop: LyricLayout | null = null;
}

// ---------------- Part ----------------

export class PartLayout {
  score!: StaffLayout;
  pid = "";
  measures: PartMeasureLayout[] = [];
  staves: PartStaff[] = [];

  slurs: Slur[] = [];
  tied: Tied[] = [];
  tuplets: Tuplet[] = [];
  endings: Ending[] = [];
  wedges: Wedge[] = [];
  pedalLines: PedalLine[] = [];
  lrcExtends: LrcExtend[] = [];

  /** 没写朝向的弧画在音符上方让开下面的歌词：`StaffLayout.arcsAbove` 的谱，且本声部有歌词。
   *  没歌词的照常规制谱：延音线与符干反向，圆滑线所跨符干全朝上时在下方。 */
  get arcsAbove(): boolean {
    return this.score.arcsAbove && this.measures.some((md) => md.lyrics.length > 0);
  }

  newMeasure(): PartMeasureLayout {
    const m = new PartMeasureLayout();
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

  /** 圆滑线起止之间（含两端）同声部的实音符干是否全朝上 */
  private slurStemsAllUp(sl: Slur): boolean {
    const a = sl.startChord();
    const b = sl.endChord();
    const t0 = a.tick();
    const t1 = b.tick();
    for (const md of this.measures) {
      for (const ch of md.chords) {
        if (ch.rest || ch.notes.length === 0 || ch.voice !== a.voice) continue;
        const t = ch.tick();
        if (t.compareTo(t0) < 0 || t.compareTo(t1) > 0) continue;
        if (!ch.stemUp) return false;
      }
    }
    return a.stemUp && b.stemUp;
  }

  /** Part::guessTiedPlacement（连音线方向推断）。 */
  guessTiedPlacement(): void {
    interface Pt {
      note: NoteLayout;
      begin: boolean;
      up: boolean;
      hasDir: boolean;
      isTie: boolean;
      owner: Tied | null;
      other: Pt | null;
    }
    const arcsAbove = this.arcsAbove;
    for (const sl of this.slurs) {
      if (!sl.autoDir) continue;
      if (arcsAbove) sl.above = true;
      else if (this.score.arcsAbove) sl.above = !this.slurStemsAllUp(sl);
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
        // 同一个单音上起的弧（圆滑线带着延音线）：没有上下之分，弧朝上的谱都朝上
        const oneNote = arcsAbove && vec.every((pt) => pt.note === vec[0]!.note);
        for (let i = 0; i < vec.length; i++) {
          const pt = vec[i];
          if (pt.hasDir) continue;
          pt.hasDir = true;
          pt.other!.hasDir = true;
          pt.up = oneNote || i >= mid;
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
        const up = arcsAbove || !ch.stemUp;
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
    const startNotes = new Map<string, NoteLayout[]>();
    const stopNotes = new Map<string, NoteLayout[]>();
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
    const connect = (va: NoteLayout[], vb: NoteLayout[]): boolean => {
      if (va.length !== vb.length) return false;
      NoteLayout.sortByPitchSnd(va);
      NoteLayout.sortByPitchSnd(vb);
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
  parts: PartLayout[] = [];
  number = "";
  barline = false;
  symbol = GroupSymbol.None;
}

/** 三次贝塞尔 B(t)（t∈[0,1]）在一个坐标分量上的最小值：比较端点与 B'(t)=0 的内部极值点。 */
function cubicMinY(p0: number, p1: number, p2: number, p3: number): number {
  let min = Math.min(p0, p3);
  // B'(t)/3 = a t² + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const at = (t: number) => {
    if (t <= 0 || t >= 1) return;
    const u = 1 - t;
    min = Math.min(min, u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3);
  };
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) at(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const s = Math.sqrt(d);
      at((-b + s) / (2 * a));
      at((-b - s) / (2 * a));
    }
  }
  return min;
}

/** 和弦符号画出来的上下沿，相对 `HarmonyLayout.y`（向上为正）：`drawHarmony` 把基线放在 `y − descent`。 */
export function harmonyBand(score: StaffLayout): [number, number] {
  const eng = score.options;
  const m = new Font(eng.wordFont, eng.harmonySize / score.scaling).metrics;
  return [-m.ascent - m.descent, -2 * m.descent];
}

/** 同上，最大值。 */
function cubicMaxY(p0: number, p1: number, p2: number, p3: number): number {
  return -cubicMinY(-p0, -p1, -p2, -p3);
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
  part(): PartLayout {
    return this.partStaff.part;
  }
  subIndex(): number {
    return this.partStaff.subIndex;
  }

  /** SysStaff::calcMixedStaffY（model.cpp:2849）。slur bbox 通过回调求得（渲染层提供）。 */
  calcMixedStaffY(sys: Sys): void {
    const eng = sys.score.options;
    const first = sys.firstMeasure;
    const cnt = sys.measures.length;
    const pt = this.part();
    const nota = this.partStaff.getNotation(sys.measures[0].offset);
    const mixed = nota === Notation.Mixed;
    // 防止混排简谱离五线谱太近；纯五线谱（自动铺排的五线谱档）就从顶线量起
    let miny = mixed ? -10 : 0;
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
        const [pt0, pt1] = SlurTieBase.calcSlurPoints(
          new Point(pl.x, pl.y), new Point(pr.x, pr.y), mixedSlurStyle(true));
        // 曲线紧包围盒上沿（照 CGPathGetPathBoundingBox；控制点不在曲线上，取控制点最小值会偏高）
        const top = cubicMinY(pl.y, pt0.y, pt1.y, pr.y);
        miny = Math.min(miny, top - 1);
      }
    }

    // 放到上方的连音数字（自动铺排：符杠在上时数字随符杠，见 layoutpass.ts::autoPlaceTuplets）
    const fsScale = eng.musicFont.size / 40;
    for (const t of pt.tuplets) {
      if (!t.above || !sys.contains(t.startTick) || !sys.contains(t.endTick)) continue;
      const [ly, ry] = t.staffEnds();
      const g0 = Tuplet.makeNumber(t.timeModification.denominator)[0] ?? "";
      const numH = (smuflTop(eng.meta, g0) - smuflBottom(eng.meta, g0)) * fsScale;
      miny = Math.min(miny, (ly + ry) / 2 - numH / 2 - 2);
    }

    // 自动铺排（原谱没坐标）再看几样 musicpp 不看的上沿：符头（朝下符干的高音）、上方记号、上方延音线、
    // 跨行的上方弧。五线谱档的和弦也靠这个 minY 定高（`painter.ts::placeAboveStaff`）
    if (sys.score.autoLayout) {
      const sub = this.partStaff.subIndex;
      for (let m = first; m < first + cnt; m++) {
        for (const ch of pt.measures[m]?.chords ?? []) {
          if (ch.rest || ch.notes[0]?.staff !== sub) continue;
          let top = Infinity;
          for (const nt of ch.notes) top = Math.min(top, nt.cy() - 6);
          if (fLt(ch.noteType, new Fraction(4)) && ch.stemUp) top = Math.min(top, ch.tailY(true));
          if (ch.hasNotation(true)) top -= 20;
          miny = Math.min(miny, top);
        }
      }
      const arcs = [
        ...pt.tied.map((t) => tiedEnds(sys, eng, t, Notation.Normal)),
        ...pt.slurs.map((sl) => slurEnds(sys, eng, sl, Notation.Normal)),
      ];
      for (const e of arcs) if (e?.above) miny = Math.min(miny, arcExtent(e)[0] - 2);
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
          if (!nt.jpMelody) continue;
          const oct = nt.octaveJp();
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
        // 自动铺排按真实字高（和弦字号按 scaling 折算后约 18 tenths）；带坐标的谱照 musicpp 的 10
        let y = h.y + (sys.score.autoLayout ? harmonyBand(sys.score)[0] : 10);
        if (hasEnding) y += 25;
        if (y > maxY) maxY = y;
      }
      for (const lrc of mea.lyrics) {
        const y = lrc.y - 10;
        if (y < minY) minY = y;
      }
      for (const t of mea.textBlocks) {
        // 文本垂直延伸：音乐字形（力度/节拍记号）用真实包围盒，避免 Bravura 字体 em 框
        // 虚高（descent-ascent 可达 ~14 个 staff space）把谱表间距撑大；文本用字体度量。
        const h = tightLineHeights(t, sys.score.options.meta, sys.score.options.musicFont.size, sys.score.options.textLineHeightBySize);
        if (h.length === 0) continue;
        const hh = h.reduce((a, b) => a + b, 0);
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
  score!: StaffLayout;
  index = 0;
  distance = 0;
  firstMeasure = 0;
  leftMargin = 0;
  rightMargin = 0;

  keyChangeWidth = 0;
  timeChangeWidth = 0;

  measures: MeasureLayout[] = [];
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

  yposPart(p: PartLayout, sub = 0): number {
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
    const partStart = new Map<PartLayout, number>();
    const partEnd = new Map<PartLayout, number>();
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
  beamDistJP = 5;
  harmonyYPos = -60;

  hideBarNumber = false; // 对齐 musicpp model.hpp:1062（默认显示小节号）
  initialKeyTime = true;
  showKeyChangeJp = true; // PAO 混排显示简谱调号「1=X」（util/pao.cpp:999）
  /** 简谱调号「1=X」按 jianpuFont 排（render.cpp::drawKey 原样，歌本用）；缺省按 mixFont 随混排谱高缩小（编辑器视图） */
  jpKeyJianpuFont = false;
  /** 混排简谱拍号照 musicpp 的旧版笔位（KL2020 成品口径）；缺省仍走共用的现代简谱拍号，避免影响其他歌本。 */
  musicppJpTimeSig = false;
  /** 将歌词中文标点的原字形墨迹居中到 `halt` 实测格（KL2020/musicpp PDF 兼容）。 */
  musicppHwidGlyphs = false;
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
  /** 歌词字体开 hwid（→ OpenType `halt`，标点占半身）：歌本（`pdflayout/songbook.ts`）开，
   *  对齐 util/pao.cpp:1002；编辑器视图不开（wasm.cpp:36 同样 false），歌词标点仍按全身式
   *  上下文挤压（`clreq`）排。 */
  lrcHWID = false;
  chineseHyphen = false;
  /** 只留旋律：读完整条（含弧/延音线配对与方向推断）之后删掉非旋律音，
   *  再按首音重猜符干方向并重排符杠（musicpp Part::removeNoneMelody → guessStemDir）。
   *  歌本清单里 `layout.melody-only` 的曲目开。 */
  melodyOnly = false;
  /** 谱行包围盒里文字的行高按字号算（原排版程序口径，歌本 `pdflayout/songbook.ts` 开）；缺省按字体 ascent−descent */
  textLineHeightBySize = false;
  harmonySize = 9;
  /** 谱里没写 `<page-layout>` 时用的纸（pt，编辑器设置里那张）；`heightPt` 为 null 是长图（不分页）。
   *  不给就用 `MixedDefaults`（A4）。写了 `<page-layout>` 的谱（歌本、第三方）照用自己的。 */
  page: { widthPt: number; heightPt: number | null } | null = null;
  jpTopDy = 0;
  // ── 简谱层附件相对数字的位置。缺省值即原排版程序的常量
  //    （render.cpp::drawNotesJianPu 875-947、BeamLevelData::drawJianPu:159），单位 tenths；
  //    `@staff` 里按 sp 写（1sp = 10 tenths，见 style/staff.ts）。
  /** 高音点首点基线（render.cpp 的 `5-2`），再减 `jpTopDy` */
  jpOctaveUpY = 3;
  /** 低音点首点基线 = `mixStaffHeight + beamDistJP × 减时线层数` 再加这个（render.cpp 的 `-2`） */
  jpOctaveDownDy = -2;
  /** 第一层减时线基准 y，再按 `(40 − mixStaffHeight) × 0.8` 上提（render.cpp 的 `35 - diff*0.8`） */
  jpBeamTopY = 35;
  /** 附点笔位 = 数字左缘 + `(数字 advance/2 + 这个) × 0.75`（render.cpp 的 `width/2+10`，mix 再乘 0.75） */
  jpDotDx = 10;
  /** 附点基线 = `字号 × 0.75` 再加这个 */
  jpDotDy = 0;
  jpGraceScale = 0.6;
  cueSize = 0.8;

  meta: MetaData;
  musicFont: Font;
  jianpuFont: Font;
  wordFont = "Times New Roman";

  /** 谱表上那层简谱用的字：`jianpuFont` 按 `mixStaffHeight / 40` 缩小（musicpp 的
   *  `30 × mixStaffHeight/40`，出厂即 22.5）。**派生量**——换了简谱字体或谱高它自己跟着走，
   *  样式表也就不必（不能）单独设它。 */
  get mixFont(): Font {
    return this.jianpuFont.makeWithSize((this.jianpuFont.size * this.mixStaffHeight) / 40);
  }

  constructor(meta: MetaData) {
    this.meta = meta;
    this.musicFont = new Font("Bravura", 40);
    this.jianpuFont = new Font(JP_FONT_FAMILY, 30);
  }
}

/** MusicXML 生态惯用的 `<scaling>`：7mm 对 40 tenths，折成 pt / tenths。 */
export const DEFAULT_SCALING = (7 * 72) / 25.4 / 40;

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
  /** 本应用的写出端（`model/toxml.ts`，文本格式派生与导出的 MusicXML） */
  Jpeditor,
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

export class StaffLayout {
  /** `ScoreDoc` 里对应的曲子 */
  readonly song: Song;
  /** 版面单位换算：pt / tenths（`<scaling>` 算出，页面尺寸与字号都按它换到 tenths）。
   *  没写 `<scaling>` 取 MusicXML 惯用的 7mm/40tenths——从前初值是 1，缺 `<defaults>` 的谱（文本格式派生、识别出的）
   *  一切按 pt 给的字号（和弦、标题、音乐文字）都只剩一半。 */
  scaling = DEFAULT_SCALING;
  measures: MeasureLayout[] = [];
  parts: PartLayout[] = [];
  pages: MPage[] = [];
  systems: Sys[] = [];
  partGroups: PartGroup[] = [];

  options: MixedOptions;
  /** 页面与字体缺省值（tenths） */
  defaults = new MixedDefaults();
  /** 排好的标题块（原谱没有坐标时由 `autoLayoutHeader` 重排） */
  credits: ScoreCredit[] = [];
  /** 原谱不带版面坐标、由 `layoutpass.ts` 自动铺排（文本格式派生、识别出的）。纵向避让那几条只对它开 */
  autoLayout = false;
  /** 没写朝向的圆滑线、没有多声部/和弦可依的延音线一律画在音符上方（让开下面的歌词）：自动铺排的谱，以及本应用导出的谱
   *  （读回来要与导出前一样）。别的谱照 musicpp：圆滑线缺省在下、延音线与符干反向。 */
  get arcsAbove(): boolean {
    return this.autoLayout || this.encoder === Encoder.Jpeditor;
  }
  /** 长图：不分页，页高由内容定（排版时 `defaults.pageHeight` 只是名义值，装页后 `painter.ts` 换成实际高） */
  longImage = false;

  constructor(options: MixedOptions, song: Song) {
    this.options = options;
    this.song = song;
  }

  /** 导出这份谱的软件（Sibelius / MuseScore 各有几处照 musicpp 的修正），任一条 `<software>` 认得就算 */
  get encoder(): Encoder {
    let e = Encoder.Unknown;
    for (const sw of this.song.identification?.software ?? []) {
      if (sw.includes("Sibelius")) e = Encoder.Sibelius;
      else if (sw.includes("MuseScore")) e = Encoder.MuseScore;
      else if (sw === "jpeditor") e = Encoder.Jpeditor;
    }
    return e;
  }

  /** 标题：`credit-type` 为 title 的首条，没有取 `<work-title>` / `<movement-title>` */
  get title(): string {
    return (
      this.song.credits?.find((c) => c.type?.trim() === "title" && c.text.trim())?.text.trim() ??
      (this.song.work.title?.trim() || this.song.work.movementTitle?.trim() || "")
    );
  }

  newPart(): PartLayout {
    const p = new PartLayout();
    p.score = this;
    this.parts.push(p);
    return p;
  }

  newMeasure(): MeasureLayout {
    const m = new MeasureLayout();
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

/**
 * 混排（五线谱层与简谱层）的弧线样式。
 *
 * 这几个数原先是 `drawSlurTied` 里的字面量（`lw0 = 6`、纯黑、描边 0.7）——
 * musicpp render.cpp:1076-1104 就是这么写死的。弧的几何与画法**与谱面那一路共用**
 * `SlurTieBase`（layout/layout.ts），差别全在这个 style 上：
 *
 *   - `maxHeight`/`minHeight`/`flatSpan`/`flatRatio` **一律不设** → 退化成 musicpp 的
 *     裸对数公式（那几条上下限与扁平长连音线是本项目为简谱加的，五线谱不要）。
 *   - `side` 跟着符干走；简谱层恒为 `above = true`。
 *
 * 唯一与旧副本不同的地方：`SlurTieBase.arcHeight` 有一条 1.2 的下限，而裸公式在
 * `dist < 10.2` 时算出的弧高比它还小（再短就变负、弧会翻过来开口朝上）。
 * 那是旧副本的缺陷，不是特性。
 */
export function mixedSlurStyle(above: boolean): SlurStyle {
  return {
    thickness: 6,
    color: 0xff000000,
    outlineWidth: 0.7,
    side: above ? "up" : "down",
  };
}

/** 五线谱 slur/tied 锚点（SpanObj::slurTiedPos）。 */
export function slurTiedPos(
  eng: MixedOptions,
  chl: ChordLayout | null,
  chr: ChordLayout | null,
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
  chl: ChordLayout,
  chr: ChordLayout,
  checkTied = false,
): [Pt2, Pt2] {
  const refLeft = chl.stemNote();
  const refRight = chr.stemNote();
  const pl: Pt2 = { x: refLeft.cx(eng.meta) + chl.measure.xpos(), y: 0 };
  const pr: Pt2 = { x: refRight.cx(eng.meta) + chr.measure.xpos(), y: 0 };
  let dot = 0;
  let hasTied = false;
  for (const nt of chl.notes) {
    if (nt.jpMelody) {
      const dd = nt.octaveJp();
      if (dd > dot) dot = dd;
      if (checkTied && nt.tieBegin) hasTied = true;
    }
  }
  for (const nt of chr.notes) {
    if (nt.jpMelody) {
      const dd = nt.octaveJp();
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

// ---------------- slur / tie 画在哪（绘制与避让共用） ----------------

/** 一条弧在本系统里的两端（系统内坐标，y 相对第一谱表顶线、向下为正）与朝向。 */
export interface ArcEnds {
  plx: number;
  ply: number;
  prx: number;
  pry: number;
  above: boolean;
}

/** Tie（render.cpp::drawTied）在本系统里画出来的两端。本系统画不出来返回 null。 */
export function tiedEnds(
  sys: Sys,
  eng: MixedOptions,
  obj: Tied,
  forceNota?: Notation,
): ArcEnds | null {
  const begin = sys.beginTick();
  const end = sys.endTick();
  if (fGe(obj.startTick, end)) return null;
  if (fLt(obj.endTick, begin)) return null;

  const hasPrev = fLt(obj.startTick, begin);
  const hasNext = fGe(obj.endTick, end);

  const chl = obj.startChord();
  const chr = obj.endChord();
  let ntl = obj.startNote;
  let ntr = obj.endNote;

  if (hasPrev) { ntl = null; }
  else if (hasNext) { ntr = null; }

  let nota = chl.notes[0].partStaff().getNotation(chl.tick());
  if (forceNota !== undefined) nota = forceNota;

  let above = obj.above;
  let plx = 0, ply = 0, prx = 0, pry = 0;

  if (nota === Notation.JianPu || nota === Notation.Mixed) {
    above = true;
    if (chr.voice > 1 && hasPrev) return null;
    const [pl, pr] = slurTiedPosForJp(eng, chl, chr);
    plx = pl.x; ply = pl.y;
    prx = pr.x; pry = pr.y;
  } else {
    if (ntl) {
      const rx = ntl.rightXForTie(eng.meta) + 3;
      plx = rx + chl.measure.xpos();
    }
    if (ntr) {
      prx = ntr.x - 3 + chr.measure.xpos();
    }

    const nt = ntl ?? ntr!;
    const ch = ntl ? chl : chr;
    const stfY = ch.measure.staffY(nt.staff);
    ply = pry = nt.cy() + stfY;

    if (obj.yOffsetType !== 0) {
      ply -= obj.yOffsetType * 8;
      pry = ply;
      let xOffLeft = false;
      const four = new Fraction(4);
      if (fLt(chl.noteType, four)) {
        xOffLeft = chl.stemUp !== above;
      } else {
        xOffLeft = true;
      }
      if (ntl && xOffLeft) {
        plx = ntl.cx(eng.meta) + chl.measure.xpos();
      }
      let xOffRight = false;
      if (fLt(chr.noteType, four)) {
        if (chr.stemUp) xOffRight = true;
      } else {
        xOffRight = true;
      }
      if (ntr && xOffRight) {
        prx = ntr.cx(eng.meta) + chr.measure.xpos();
      }
    }
  }

  if (hasPrev) {
    if (nota === Notation.JianPu) {
      plx = 0;
    } else {
      plx = sys.measures[0].dataPos;
    }
  }
  if (hasNext) {
    const last = sys.measures[sys.measures.length - 1];
    prx = last.xpos() + last.dataEnd;
  }

  return { plx, ply, prx, pry, above };
}

/** slur 在本系统里画出来的两端（render.cpp::drawSlur）。本系统画不出来返回 null。 */
export function slurEnds(
  sys: Sys,
  eng: MixedOptions,
  slur: Slur,
  forceNota?: Notation,
): ArcEnds | null {
  const begin = sys.beginTick();
  const end = sys.endTick();
  if (fGe(slur.startTick, end)) return null;
  if (fLt(slur.endTick, begin)) return null;
  if (!slur.startNote) return null;

  const hasPrev = fLt(slur.startTick, begin);
  const hasNext = fGe(slur.endTick, end);

  let chl = hasPrev ? null : slur.startChord();
  let chr = hasNext ? null : slur.endChord();

  const refCh = chl ?? chr!;
  let nota = refCh.notes[0].partStaff().getNotation(refCh.tick());
  if (forceNota !== undefined) nota = forceNota;

  let above = slur.above;
  let plx = 0, ply = 0, prx = 0, pry = 0;

  if (nota === Notation.JianPu) {
    above = true; // 简谱层 slur 一律朝上（render.cpp::drawSlur）
    if (!chr || !chl) return null;
    const [pl, pr] = slurTiedPosForJp(eng, chl, chr, true);
    plx = pl.x; ply = pl.y;
    prx = pr.x; pry = pr.y;
  } else {
    const [pl, pr] = slurTiedPos(eng, chl, chr, above);
    plx = pl.x; ply = pl.y;
    prx = pr.x; pry = pr.y;
  }

  if (hasPrev) {
    plx = sys.measures[0].dataPos;
  }
  if (hasNext) {
    const last = sys.measures[sys.measures.length - 1];
    prx = last.xpos() + last.dataEnd;
  }

  return { plx, ply, prx, pry, above };
}

/** 弧（连同月牙的厚度）画出来的纵向范围 [顶, 底]：几何与 `render.ts::drawSlurTied` 同一份（`SlurTieBase` + `mixedSlurStyle`）。 */
export function arcExtent(e: ArcEnds): [number, number] {
  const style = mixedSlurStyle(e.above);
  const pl = new Point(e.plx, e.ply);
  const pr = new Point(e.prx, e.pry);
  const [p0, p1, cos] = SlurTieBase.calcSlurPoints(pl, pr, style);
  const lw = style.thickness / cos / 2; // 回程两个控制点下压的量
  const top = Math.min(cubicMinY(pl.y, p0.y, p1.y, pr.y), cubicMinY(pl.y, p0.y + lw, p1.y + lw, pr.y));
  const bot = Math.max(cubicMaxY(pl.y, p0.y, p1.y, pr.y), cubicMaxY(pl.y, p0.y + lw, p1.y + lw, pr.y));
  return [top, bot];
}
