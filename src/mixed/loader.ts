// 混排 MusicXML → MixedScore 加载器。从 musicpp mxml/parser.cpp 移植。
// 信任 MusicXML 内嵌版面（default-x、measure width、print new-system/new-page）。

import { Fraction } from "../common/fraction";
import { Font } from "../layout/font";
import { GlyphCodes } from "../smufl/smufl";
import {
  Arpeggiate,
  BeamGroup,
  BeamVal,
  BarGlyph,
  ClefSig,
  Encoder,
  fEq,
  GroupSymbol,
  HarmonyDegreeType,
  KeySig,
  LCR,
  LrcExtend,
  MChord,
  MeasureData,
  MeasureInfo,
  MeasureText,
  MLyric,
  MixedOptions,
  MixedPart,
  MixedScore,
  MNote,
  MPage,
  Notation,
  NotationItem,
  PartGroup,
  PartStaff,
  ScoreCredit,
  Sys,
  SysStaff,
  TimeSig,
} from "./model";

// ---------------- DOM helpers ----------------

function elems(parent: Element, tag: string): Element[] {
  const out: Element[] = [];
  for (const n of Array.from(parent.children)) if (n.tagName === tag) out.push(n);
  return out;
}
function elem(parent: Element, tag: string): Element | null {
  for (const n of Array.from(parent.children)) if (n.tagName === tag) return n;
  return null;
}
function txt(parent: Element, tag: string): string | null {
  const e = elem(parent, tag);
  return e ? (e.textContent?.trim() ?? "") : null;
}
function floatOf(parent: Element, tag: string): number | null {
  const t = txt(parent, tag);
  return t !== null && t !== "" ? parseFloat(t) : null;
}
function intOf(parent: Element, tag: string): number | null {
  const t = txt(parent, tag);
  return t !== null && t !== "" ? parseInt(t, 10) : null;
}
function attrFloat(el: Element, attr: string): number | null {
  const v = el.getAttribute(attr);
  return v !== null && v !== "" ? parseFloat(v) : null;
}
function attrInt(el: Element, attr: string): number | null {
  const v = el.getAttribute(attr);
  return v !== null && v !== "" ? parseInt(v, 10) : null;
}

// ---------------- Pitch ----------------

const STEP_DIATONIC: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const STEP_CHROMATIC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function calcWrittenPitch(noteEl: Element, transposeSteps: number): number {
  const pit = elem(noteEl, "pitch");
  if (!pit) return -1;
  const step = txt(pit, "step") ?? "C";
  const octave = intOf(pit, "octave") ?? 4;
  return octave * 7 + (STEP_DIATONIC[step] ?? 0) + transposeSteps;
}

function calcSoundPitch(noteEl: Element): number {
  const pit = elem(noteEl, "pitch");
  if (!pit) return 0;
  const step = txt(pit, "step") ?? "C";
  const octave = intOf(pit, "octave") ?? 4;
  const alter = floatOf(pit, "alter") ?? 0;
  return (octave + 1) * 12 + (STEP_CHROMATIC[step] ?? 0) + Math.round(alter);
}

// ---------------- Note type ----------------

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

function noteTypeFraction(typeName: string): Fraction {
  return NOTE_TYPE_MAP[typeName] ?? new Fraction(1);
}

// ---------------- Clef / Key / Time constructors ----------------

function makeClef(clefEl: Element): ClefSig {
  const sign = txt(clefEl, "sign") ?? "G";
  const octChange = intOf(clefEl, "clef-octave-change") ?? 0;
  const c = new ClefSig();
  switch (sign) {
    case "G": c.sign = octChange === -1 ? GlyphCodes.gClef8vb : GlyphCodes.gClef; break;
    case "F": c.sign = GlyphCodes.fClef; break;
    case "C": c.sign = GlyphCodes.cClef; break;
    case "percussion": c.sign = GlyphCodes.unpitchedPercussionClef1; break;
    case "TAB": c.sign = GlyphCodes.sixStringTabClef; break;
    default: c.sign = GlyphCodes.gClef;
  }
  c.line = intOf(clefEl, "line") ?? 2;
  return c;
}

function makeKey(keyEl: Element): KeySig {
  const k = new KeySig();
  k.fifths = intOf(keyEl, "fifths") ?? 0;
  const cancelEl = elem(keyEl, "cancel");
  if (cancelEl) k.cancel = parseInt(cancelEl.textContent ?? "0", 10);
  return k;
}

function makeTime(timeEl: Element): TimeSig {
  const t = new TimeSig();
  t.beats = intOf(timeEl, "beats") ?? 4;
  t.beatType = intOf(timeEl, "beat-type") ?? 4;
  t.symbol =
    timeEl.getAttribute("symbol") === "common" ||
    timeEl.getAttribute("symbol") === "cut";
  return t;
}

// ---------------- Barline ----------------

function barGlyphFromStyle(style: string): BarGlyph | null {
  switch (style) {
    case "regular": return BarGlyph.Single;
    case "light-light": return BarGlyph.Double;
    case "light-heavy": return BarGlyph.Final;
    case "heavy-light": return BarGlyph.ReverseFinal;
    case "heavy-heavy": return BarGlyph.HeavyHeavy;
    case "none": return BarGlyph.None;
    default: return null;
  }
}

/** 力度元素名（如「mf」「sfz」）逐字母 → Bravura 力度字形串，对齐 loader.cpp::convertDynamicsStr。 */
function convertDynamicsStr(s: string): string {
  const map: Record<string, string> = {
    p: GlyphCodes.dynamicPiano,
    m: GlyphCodes.dynamicMezzo,
    f: GlyphCodes.dynamicForte,
    r: GlyphCodes.dynamicRinforzando,
    s: GlyphCodes.dynamicSforzando,
    z: GlyphCodes.dynamicZ,
    n: GlyphCodes.dynamicNiente,
  };
  let res = "";
  for (const c of s) {
    const g = map[c];
    if (g === undefined) return ""; // 非标准力度名（musicpp 此处 assert），忽略
    res += g;
  }
  return res;
}

/** <beat-unit> 音符类型 → 节拍记号字形，对齐 loader.cpp::makeMetronomeStr（仅四分音符）。 */
function metNoteGlyph(noteType: string): string {
  // musicpp 只实现了四分音符；其余暂以四分音符字形兜底。
  if (noteType !== "quarter") console.warn("metronome beat-unit not supported:", noteType);
  return GlyphCodes.metNoteQuarterUp;
}

function parseEndingNums(s: string): Set<number> {
  const res = new Set<number>();
  for (const part of s.split(",")) {
    const n = parseInt(part.trim(), 10);
    if (!isNaN(n)) res.add(n);
  }
  return res;
}

// ---------------- Per-part measure loading ----------------

interface TieRef { note: MNote; pitch: number; endTick: Fraction }
interface SlurRef { num: number; chord: MChord; above: boolean | null }
interface TupletRef { num: number; chord: MChord; actual: number; normal: number }

class PartLoader {
  part: MixedPart;
  score: MixedScore;
  partEl: Element;
  measureEls: Element[];
  stemYMap = new Map<MNote, number>(); // note → stem default-y
  stemNotes = new Set<MNote>(); // 有 <stem> 元素的音符（parser.cpp stemDir）
  hasBeamEl = false; // 本声部是否出现过 <beam>（无则自动按拍分组符杠，供 OMR 谱用）
  transposeSteps = 0;

  tieStarts: TieRef[] = [];
  tieStops: TieRef[] = [];
  slurStarts = new Map<number, SlurRef>();
  tupletStarts = new Map<number, TupletRef>();
  // lrc linking: num → [MLyric list in order]
  lrcByNum = new Map<string, MLyric[]>();
  // lyric extend (melisma) points, paired 2-by-2 in processLrcExtend
  lrcExtendPts: { note: MNote; lrc: MLyric; tick: Fraction; stop: boolean }[] = [];
  // 本声部自己的 ending 端点（print-object="no" 不计入），对齐 musicpp 按 part 收集，
  // 避免反复记号在每个声部都被画一遍。
  endingPts: { mif: MeasureInfo; nums: Set<number>; start: boolean; stop: boolean }[] = [];

  // 琶音：当前小节内按 offset 聚合的音符（loadMeasure 末尾成组）。
  arpegNotes = new Map<string, MNote[]>();
  // wedge/pedal 端点（parser.cpp processWedge/processPedal：全声部收集后配对）。
  wedgePts: {
    mif: MeasureInfo;
    tick: Fraction;
    staff: number;
    type: "crescendo" | "diminuendo" | "stop";
    relX: number | null;
    defY: number | null;
  }[] = [];
  pedalPts: {
    mif: MeasureInfo;
    tick: Fraction;
    staff: number;
    line: boolean;
    stop: boolean;
    ypos: number;
  }[] = [];

  constructor(part: MixedPart, score: MixedScore, partEl: Element) {
    this.part = part;
    this.score = score;
    this.partEl = partEl;
    this.measureEls = elems(partEl, "measure");
  }

  load(): void {
    let staveCount = 1;
    const firstMea = this.measureEls[0];
    if (firstMea) {
      for (const at of elems(firstMea, "attributes")) {
        const sv = intOf(at, "staves");
        if (sv !== null) staveCount = sv;
        const tr = elem(at, "transpose");
        if (tr) this.transposeSteps = intOf(tr, "diatonic") ?? 0;
      }
    }
    for (let i = 0; i < staveCount; i++) {
      const ps = new PartStaff(this.part, i);
      this.part.staves.push(ps);
    }

    // 绝对 tick 必须在 loadMeasure 之前就设到 mif.offset，否则 processAttributes 记录的
    // clef/key/time 变化全落在 tick 0、互相覆盖（对齐 musicpp parser.cpp:1291，offset 在
    // loadAttributes 之前赋值）。后面 1312 行的全局 offset pass 会再统一一次（多声部规范化）。
    let div = 1;
    let runTick = new Fraction(0);
    for (let mid = 0; mid < this.measureEls.length; mid++) {
      const mea = this.measureEls[mid];
      const mif = this.score.measures[mid];
      if (!mif) continue;
      mif.offset = runTick;
      div = this.loadMeasure(mea, mif, div);
      runTick = runTick.plus(mif.dur);
    }

    this.calcStemLen();
    if (!this.hasBeamEl) this.autoBeamPart();
    this.formatBeams();
    // 符干/符杠就绪后再排记号（fermata 等），使 tailY 取到最终符干末端，避免 fermataBelow
    // 压住后续加长的符干（musicpp parser.cpp:2914）。
    for (const md of this.part.measures) md.layoutNotations();
    this.processTied();
    this.processEnding();
    this.pairWedges();
    this.pairPedals();
    this.processLrcExtend();
    this.part.guessTiedPlacement();
  }

  // calcTicksAndDur: compute per-child offsets + measure duration
  private calcTicksAndDur(
    mea: Element,
    div: number,
  ): { offsets: Map<Element, Fraction>; durs: Map<Element, Fraction>; dur: Fraction } {
    const offsets = new Map<Element, Fraction>();
    const durs = new Map<Element, Fraction>();
    let tick = new Fraction(0);
    let end = new Fraction(0);
    let curDiv = div;

    for (const it of Array.from(mea.children)) {
      const tag = it.tagName;

      if (tag === "backup") {
        const durVal = intOf(it, "duration");
        if (durVal !== null) {
          tick = tick.minus(new Fraction(durVal, curDiv));
          if (tick.compareTo(new Fraction(0)) < 0) tick = new Fraction(0);
        }
        offsets.set(it, tick);
        durs.set(it, new Fraction(0));
        continue;
      }
      if (tag === "forward") {
        const durVal = intOf(it, "duration");
        const dur = durVal !== null ? new Fraction(durVal, curDiv) : new Fraction(0);
        offsets.set(it, tick);
        durs.set(it, dur);
        tick = tick.plus(dur);
        if (tick.compareTo(end) > 0) end = tick;
        continue;
      }

      if (tag === "attributes") {
        for (const child of Array.from(it.children)) {
          if (child.tagName === "divisions") {
            const dv = parseInt(child.textContent ?? "1", 10);
            if (dv > 0) curDiv = dv;
          }
        }
      }

      let delta = new Fraction(0);
      // harmony 的 <offset>：MuseScore 用它把同一拍上的第二个和弦符号往右挪开，避免重叠。
      // 仅对 MuseScore 生效（其它软件的 x 定位另有调校，勿动）。
      if (
        tag === "direction" ||
        (tag === "harmony" && this.score.encoder === Encoder.MuseScore)
      ) {
        const offsetEl = elem(it, "offset");
        if (offsetEl) {
          const ov = parseFloat(offsetEl.textContent ?? "0");
          delta = new Fraction(Math.round(ov), curDiv);
        }
      }

      offsets.set(it, tick.plus(delta));
      let dur = new Fraction(0);
      if (tag === "note") {
        const durVal = intOf(it, "duration");
        if (durVal !== null) dur = new Fraction(durVal, curDiv);
        const isChord = elem(it, "chord") !== null;
        if (!isChord) {
          tick = tick.plus(dur);
          if (tick.compareTo(end) > 0) end = tick;
        }
      }
      durs.set(it, dur);
    }
    return { offsets, durs, dur: end };
  }

  private loadMeasure(mea: Element, mif: MeasureInfo, prevDiv: number): number {
    let div = prevDiv;
    const firstAttr = elem(mea, "attributes");
    if (firstAttr) {
      const dv = intOf(firstAttr, "divisions");
      if (dv !== null && dv > 0) div = dv;
    }

    const { offsets, durs, dur } = this.calcTicksAndDur(mea, div);
    if (dur.compareTo(mif.dur) > 0) mif.dur = dur;
    mif.number = mea.getAttribute("number") ?? mif.number;
    const widthAttr = attrFloat(mea, "width");
    if (widthAttr !== null) mif.width = widthAttr;

    const md = this.part.newMeasure();
    md.measureInfo = mif;

    this.arpegNotes.clear();
    let curChord: MChord | null = null;

    for (const it of Array.from(mea.children)) {
      const tag = it.tagName;
      const tick = offsets.get(it) ?? new Fraction(0);
      if (tag === "attributes") {
        this.processAttributes(it, mif.offset.plus(tick));
        const dv = intOf(it, "divisions");
        if (dv !== null && dv > 0) div = dv;
      } else if (tag === "note") {
        curChord = this.processNote(it, md, mif, tick, durs.get(it) ?? new Fraction(0), curChord);
      } else if (tag === "harmony") {
        this.processHarmony(it, md, tick);
      } else if (tag === "direction") {
        this.processDirection(it, md, tick);
      } else if (tag === "barline") {
        this.processBarline(it, mif);
      }
    }

    for (const ch of md.chords) {
      if (ch.rest && fEq(ch.dur, mif.dur)) ch.measureRest = true;
    }

    md.splitLayer();
    md.layoutNotes(this.score.options.meta, this.score.encoder === Encoder.Sibelius);
    // layoutNotations 不在此处调用：它依赖最终符干长度（fermataBelow 等记号按 tailY 定位），
    // 而 stemLen 要等 calcStemLen/formatBeams 之后才就绪。改在 finalize 里统一后处理，
    // 对齐 musicpp（parser.cpp:2914「after stem & beam info done」）。

    // 琶音成组（parser.cpp:1972）：同 offset 一组，按 staff、line 排序后回填 nt.arpeg。
    for (const notes of this.arpegNotes.values()) {
      const arp = new Arpeggiate();
      notes.sort((a, b) => (a.staff !== b.staff ? a.staff - b.staff : a.line() - b.line()));
      for (const n of notes) n.arpeg = arp;
      arp.notes = notes;
      md.arpegs.push(arp);
    }
    return div;
  }

  private processAttributes(attrEl: Element, tick: Fraction): void {
    for (const clefEl of elems(attrEl, "clef")) {
      const num = (attrInt(clefEl, "number") ?? 1) - 1;
      if (num < this.part.staves.length) this.part.staves[num].clef.set(tick, makeClef(clefEl));
    }
    for (const keyEl of elems(attrEl, "key")) {
      const ks = makeKey(keyEl);
      for (const stf of this.part.staves) stf.key.set(tick, ks);
    }
    for (const timeEl of elems(attrEl, "time")) {
      const ts = makeTime(timeEl);
      for (const stf of this.part.staves) stf.time.set(tick, ts);
    }
  }

  private processNote(
    noteEl: Element,
    md: MeasureData,
    mif: MeasureInfo,
    tick: Fraction,
    dur: Fraction,
    prevChord: MChord | null,
  ): MChord {
    const isChord = elem(noteEl, "chord") !== null;
    const isGrace = elem(noteEl, "grace") !== null;

    let ch: MChord;
    if (!isChord || prevChord === null) {
      ch = md.newChord();
      ch.offset = tick;
      ch.dur = dur;
      ch.rest = elem(noteEl, "rest") !== null;
      ch.grace = isGrace;
      ch.cue = elem(noteEl, "cue") !== null;
      ch.voice = (intOf(noteEl, "voice") ?? 1) - 1;
      ch.dot = elems(noteEl, "dot").length;

      // timeModification 单独累乘；noteType 纯由 <type> 决定（musicpp parser.cpp:620-665）
      const tm = elem(noteEl, "time-modification");
      if (tm) {
        const actual = intOf(tm, "actual-notes") ?? 1;
        const normal = intOf(tm, "normal-notes") ?? 1;
        ch.timeModification = new Fraction(normal, actual);
      }
      const typeName = txt(noteEl, "type");
      if (typeName) {
        ch.noteType = noteTypeFraction(typeName);
      } else {
        // 无 <type>：整小节休止（noteType=4 全休止符字形）
        ch.noteType = new Fraction(4);
        ch.measureRest = true;
      }

      this.processBeam(ch, noteEl, md);
    } else {
      ch = prevChord;
    }

    const nt = ch.newNote();
    nt.staff = (intOf(noteEl, "staff") ?? 1) - 1;

    if (ch.rest) {
      nt.writtenPitch = -1;
      nt.soundPitch = 0;
    } else {
      nt.writtenPitch = calcWrittenPitch(noteEl, this.transposeSteps);
      nt.soundPitch = calcSoundPitch(noteEl);
      nt.alter = floatOf(elem(noteEl, "pitch") ?? document.createElement("x"), "alter") ?? 0;
    }

    nt.x = attrFloat(noteEl, "default-x") ?? -1;
    // 每音符显示尺寸（<type size="cue">）——musicpp Note::size==1（render.cpp:963）。
    const typeEl = elem(noteEl, "type");
    if (typeEl && typeEl.getAttribute("size") === "cue") nt.size = 1;

    const accEl = elem(noteEl, "accidental");
    if (accEl) {
      nt.parenthesesAcc = accEl.getAttribute("parentheses") === "yes";
      switch (accEl.textContent?.trim()) {
        case "flat": nt.acc = GlyphCodes.accidentalFlat; break;
        case "sharp": nt.acc = GlyphCodes.accidentalSharp; break;
        case "natural": nt.acc = GlyphCodes.accidentalNatural; break;
        case "double-sharp": nt.acc = GlyphCodes.accidentalDoubleSharp; break;
        case "flat-flat": nt.acc = GlyphCodes.accidentalDoubleFlat; break;
      }
    }

    nt.visible = noteEl.getAttribute("print-object") !== "no";

    const stemEl = elem(noteEl, "stem");
    if (stemEl) {
      ch.stemUp = stemEl.textContent?.trim() === "up";
      this.stemNotes.add(nt);
      const sy = attrFloat(stemEl, "default-y");
      if (sy !== null) this.stemYMap.set(nt, sy);
    } else if (!ch.rest && ch.noteType.compareTo(new Fraction(4)) < 0) {
      // 无 <stem> 且需符干（非全音符）的谱（如 OMR 生成、未给符干方向）：按符头相对中线
      // 位置定默认方向（中线 line=-4 及以上朝下，其下朝上），并登记以便 calcStemLen 给长度。
      ch.stemUp = nt.line() < -4;
      this.stemNotes.add(nt);
    }

    const nhEl = elem(noteEl, "notehead");
    if (nhEl?.textContent?.trim() === "slash") ch.slash = true;

    this.processTieEl(noteEl, nt, ch.tick());
    const arp = this.processNotations(noteEl, ch, mif);
    if (arp) {
      const key = `${ch.offset.numerator}/${ch.offset.denominator}`;
      const arr = this.arpegNotes.get(key) ?? [];
      arr.push(nt);
      this.arpegNotes.set(key, arr);
    }
    if (!ch.rest) this.processLrc(noteEl, md, ch, nt);
    void mif;
    return ch;
  }

  private processBeam(ch: MChord, noteEl: Element, md: MeasureData): void {
    const beamEls = elems(noteEl, "beam");
    if (beamEls.length === 0) return;
    this.hasBeamEl = true;
    const beamMap = new Map<number, BeamVal>();
    for (const b of beamEls) {
      const num = (attrInt(b, "number") ?? 1) - 1;
      switch (b.textContent?.trim()) {
        case "begin": beamMap.set(num, BeamVal.Begin); break;
        case "continue": beamMap.set(num, BeamVal.Continue); break;
        case "end": beamMap.set(num, BeamVal.End); break;
        case "forward hook": beamMap.set(num, BeamVal.Forward); break;
        case "backward hook": beamMap.set(num, BeamVal.Backward); break;
      }
    }
    if (beamMap.size === 0) return;
    const maxIdx = Math.max(...beamMap.keys());
    ch.beams = [];
    for (let i = 0; i <= maxIdx; i++) ch.beams.push(beamMap.get(i) ?? BeamVal.Continue);

    if (ch.beams[0] === BeamVal.Begin) {
      const g = new BeamGroup();
      (ch.grace ? md.graceBeams : md.beams).push(g);
      g.chords.push(ch);
    } else {
      const arr = ch.grace ? md.graceBeams : md.beams;
      if (arr.length > 0) arr[arr.length - 1].chords.push(ch);
    }
  }

  private processLrc(noteEl: Element, md: MeasureData, ch: MChord, nt: MNote): void {
    for (const lrcEl of elems(noteEl, "lyric")) {
      const lrc = md.newLyric();
      lrc.chord = ch;
      lrc.offset = ch.offset;
      lrc.num = lrcEl.getAttribute("number") ?? "1";
      lrc.name = lrcEl.getAttribute("name") ?? "";
      lrc.staff = nt.staff;
      lrc.x = nt.x;

      let y = attrFloat(lrcEl, "default-y") ?? -1;
      const ry = attrFloat(lrcEl, "relative-y");
      if (ry !== null) y += ry;
      lrc.y = y;

      const just = lrcEl.getAttribute("justify");
      if (just === "right") lrc.halign = LCR.Right;
      else if (just === "left") lrc.halign = LCR.Left;
      else lrc.halign = LCR.Center;

      const syllabic = txt(lrcEl, "syllabic") ?? "single";
      lrc.begin = syllabic === "single" || syllabic === "begin";
      lrc.end = syllabic === "single" || syllabic === "end";

      let text = "";
      for (const textEl of elems(lrcEl, "text")) {
        text += textEl.textContent?.trim() ?? "";
      }
      if (text.length > 0 && /^\d/.test(text)) {
        const dotPos = text.indexOf(".");
        if (dotPos >= 0) {
          lrc.prefix = text.slice(0, dotPos + 1);
          text = text.slice(dotPos + 1);
        }
      }
      lrc.text = text;
      lrc.font = this.score.defaults.lyricFont;

      lrc.updateWidth(this.score.options.meta);

      // register for prev/next linking
      const arr = this.lrcByNum.get(lrc.num) ?? [];
      arr.push(lrc);
      this.lrcByNum.set(lrc.num, arr);

      // lyric extend (melisma): collect points, paired later
      const extEl = elem(lrcEl, "extend");
      if (extEl) {
        const stop = extEl.getAttribute("type") === "stop";
        this.lrcExtendPts.push({ note: nt, lrc, tick: ch.tick(), stop });
      }
    }
  }

  /** Pair lyric extend points 2-by-2 (musicpp parser.cpp:753 processLrcExtend)。 */
  processLrcExtend(): void {
    const pts = [...this.lrcExtendPts];
    const numOf = (s: string) => {
      const n = parseInt(s, 10);
      return isNaN(n) ? 0 : n;
    };
    // 仅当存在显式 <extend type="stop"> 时才按 start/stop 两两配对（musicpp parser.cpp:753）。
    // Sibelius 等导出全用裸 <extend/>（无 type），此时每个都是独立 melisma 的起点，
    // 不能两两配对（否则线会跨过中间音节连到后一个歌词上）。
    const hasStop = pts.some((p) => p.stop);
    if (hasStop) {
      pts.sort((a, b) => {
        const na = numOf(a.lrc.num);
        const nb = numOf(b.lrc.num);
        if (na !== nb) return na - nb;
        const c = a.tick.compareTo(b.tick);
        if (c !== 0) return c;
        return (a.stop ? 1 : 0) - (b.stop ? 1 : 0);
      });
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const pa = pts[i];
        const pb = pts[i + 1];
        const ext: LrcExtend = this.part.newLrcExtend();
        ext.startNote = pa.note;
        ext.endNote = pb.note;
        ext.startTick = pa.note.chord.tick();
        ext.endTick = pb.note.chord.tick();
        ext.start = pa.lrc;
        ext.stop = pb.lrc;
      }
      return;
    }

    // 裸 extend：melisma 终点 = 同一 verse 的下一个音节起点；但若中途遇到休止符
    // （该声部停唱），melisma 即结束，终点取休止前最后一个续腔音，不得跨过休止连到
    // 休止之后的歌词。先按全局 tick 收集本声部各谱表的全部和弦用于边界扫描。
    const seqByStaff = new Map<number, MChord[]>();
    for (const md of this.part.measures) {
      for (const ch of md.chords) {
        const staff = ch.notes[0]?.staff ?? 0;
        let arr = seqByStaff.get(staff);
        if (!arr) {
          arr = [];
          seqByStaff.set(staff, arr);
        }
        arr.push(ch);
      }
    }
    for (const arr of seqByStaff.values()) {
      arr.sort((a, b) => a.tick().compareTo(b.tick()));
    }

    for (const pt of pts) {
      const list = this.lrcByNum.get(pt.lrc.num) ?? [];
      const idx = list.indexOf(pt.lrc);
      const nextLrc = idx >= 0 ? list[idx + 1] : null;
      const startTick = pt.note.chord.tick();
      const nextTick = nextLrc?.chord ? nextLrc.chord.tick() : null;

      // 扫描本声部（同谱表）起始音之后、下一个音节之前，寻首个休止符。
      const seq = seqByStaff.get(pt.note.staff) ?? [];
      let lastMelisma: MNote | null = null;
      let restBefore = false;
      for (const ch of seq) {
        const t = ch.tick();
        if (t.compareTo(startTick) <= 0) continue;
        if (nextTick && t.compareTo(nextTick) >= 0) break;
        if (ch.rest) {
          restBefore = true;
          break;
        }
        lastMelisma = ch.notes[0] ?? lastMelisma;
      }

      const ext: LrcExtend = this.part.newLrcExtend();
      ext.startNote = pt.note;
      ext.start = pt.lrc;
      ext.startTick = startTick;
      if (restBefore) {
        // 被休止打断：止于休止前最后一个续腔音（其右缘，见 drawLrcExtend）。
        // 若休止紧跟在带 extend 的音之后（无续腔音），则不画。
        if (!lastMelisma) {
          this.part.lrcExtends.pop();
          continue;
        }
        ext.endNote = lastMelisma;
        ext.stop = null;
        ext.endTick = lastMelisma.chord.tick();
      } else if (nextLrc?.chord) {
        ext.endNote = nextLrc.chord.notes[0];
        ext.stop = nextLrc;
        ext.endTick = nextTick!;
      } else {
        // 无续腔音也无下一音节 → 撤销
        this.part.lrcExtends.pop();
      }
    }
  }

  linkLyrics(): void {
    for (const arr of this.lrcByNum.values()) {
      for (let i = 1; i < arr.length; i++) {
        const prev = arr[i - 1];
        const cur = arr[i];
        if (prev.end) continue;
        if (cur.begin) continue;
        prev.next = cur;
        cur.prev = prev;
      }
    }
  }

  private processTieEl(noteEl: Element, nt: MNote, tick: Fraction): void {
    for (const notEl of elems(noteEl, "notations")) {
      for (const tiedEl of elems(notEl, "tied")) {
        const ty = tiedEl.getAttribute("type");
        if (ty === "start") {
          nt.tieBegin = true;
          this.tieStarts.push({ note: nt, pitch: nt.writtenPitch, endTick: tick.plus(nt.chord.dur) });
        } else if (ty === "stop") {
          nt.tieEnd = true;
          this.tieStops.push({ note: nt, pitch: nt.writtenPitch, endTick: tick });
        }
      }
    }
  }

  private processNotations(noteEl: Element, ch: MChord, _mif: MeasureInfo): boolean {
    let arp = false;
    for (const notEl of elems(noteEl, "notations")) {
      // fermata（parser.cpp:1446 processNotations）。type=inverted → 下方。
      for (const ferEl of elems(notEl, "fermata")) {
        const item = new NotationItem();
        item.above = ferEl.getAttribute("type") !== "inverted";
        item.symbol = item.above ? GlyphCodes.fermataAbove : GlyphCodes.fermataBelow;
        ch.notations.push(item);
      }
      // arpeggiate（parser.cpp:1461）—— 实际上下竖波浪线在 loadMeasure 末尾成组。
      if (elems(notEl, "arpeggiate").length > 0) arp = true;
      // articulations（parser.cpp:1463）—— 重音/断奏/保持音/marcato/staccatissimo。
      // above/symbol 初始按上方字形，最终上下由 layoutNotations::setAbove 决定。
      for (const artEl of elems(notEl, "articulations")) {
        for (const a of Array.from(artEl.children)) {
          const item = new NotationItem();
          switch (a.tagName) {
            case "strong-accent":
              item.above = a.getAttribute("type") !== "down";
              item.symbol = item.above ? GlyphCodes.articMarcatoAbove : GlyphCodes.articMarcatoBelow;
              break;
            case "accent":
              item.symbol = GlyphCodes.articAccentAbove;
              break;
            case "staccato":
              item.symbol = GlyphCodes.articStaccatoAbove;
              break;
            case "tenuto":
              item.symbol = GlyphCodes.articTenutoAbove;
              break;
            case "staccatissimo":
              item.symbol = GlyphCodes.articStaccatissimoAbove;
              break;
            default:
              // spiccato/stress/breath-mark/caesura 等：musicpp 未绘制，忽略。
              continue;
          }
          ch.notations.push(item);
        }
      }
      for (const slurEl of elems(notEl, "slur")) {
        const ty = slurEl.getAttribute("type");
        const num = attrInt(slurEl, "number") ?? 1;
        // parser.cpp::processSlur —— placement 优先，缺省时退回 orientation
        // （Sibelius 导出用 orientation="over/under"，无 placement）。
        const pl = slurEl.getAttribute("placement");
        const ori = slurEl.getAttribute("orientation");
        const above =
          pl === "above" ? true
          : pl === "below" ? false
          : ori === "over" ? true
          : ori === "under" ? false
          : null;
        if (ty === "start") {
          this.slurStarts.set(num, { num, chord: ch, above });
        } else if (ty === "stop") {
          const ref = this.slurStarts.get(num);
          if (ref) {
            const sl = this.part.newSlur();
            sl.startTick = ref.chord.tick();
            sl.endTick = ch.tick();
            sl.startNote = ref.chord.notes[ref.chord.notes.length - 1];
            sl.endNote = ch.notes[ch.notes.length - 1];
            if (ref.above !== null) sl.above = ref.above;
            this.slurStarts.delete(num);
          }
        }
      }
      for (const tupEl of elems(notEl, "tuplet")) {
        const ty = tupEl.getAttribute("type");
        const num = attrInt(tupEl, "number") ?? 1;
        if (ty === "start") {
          const tm = elem(noteEl, "time-modification");
          const actual = tm ? (intOf(tm, "actual-notes") ?? 3) : 3;
          const normal = tm ? (intOf(tm, "normal-notes") ?? 2) : 2;
          this.tupletStarts.set(num, { num, chord: ch, actual, normal });
        } else if (ty === "stop") {
          const ref = this.tupletStarts.get(num);
          if (ref) {
            const tup = this.part.newTuplet();
            tup.startTick = ref.chord.tick();
            tup.endTick = ch.tick().plus(ch.dur);
            tup.startNote = ref.chord.notes[0];
            tup.endNote = ch.notes[0];
            tup.timeModification = new Fraction(ref.normal, ref.actual);
            const br = tupEl.getAttribute("bracket");
            if (br === "yes") tup.bracket = true;
            else if (br === "no") tup.bracket = false;
            this.tupletStarts.delete(num);
          }
        }
      }
    }
    return arp;
  }

  /** <direction> 文本（words / dynamics / metronome），对应 musicpp loader.cpp::processDirection。 */
  private processDirection(dirEl: Element, md: MeasureData, tick: Fraction): void {
    const blk = md.newText();
    blk.offset = tick;
    blk.staff = (intOf(dirEl, "staff") ?? 1) - 1;
    let hasText = false;
    for (const dt of elems(dirEl, "direction-type")) {
      for (const child of Array.from(dt.children)) {
        switch (child.tagName) {
          case "words":
            if (this.processWords(blk, child as Element)) hasText = true;
            break;
          case "dynamics":
            if (this.processDynamic(blk, child as Element)) hasText = true;
            break;
          case "metronome":
            if (this.processMetronome(blk, child as Element)) hasText = true;
            break;
          case "segno":
            this.processSegno(blk, false);
            hasText = true;
            break;
          case "coda":
            this.processSegno(blk, true);
            hasText = true;
            break;
          case "wedge":
            this.collectWedge(child as Element, md, tick, blk.staff);
            break;
          case "pedal":
            this.collectPedal(child as Element, md, tick, blk.staff);
            break;
        }
      }
    }
    // Sibelius 右对齐文本以右边缘为锚点（parser.cpp::parse 尾部 isSib 分支）。
    if (this.score.encoder === Encoder.Sibelius && blk.justify === LCR.Right) {
      blk.x -= blk.width();
    }
    if (!hasText) md.textBlocks.pop();
  }

  /** <wedge>（渐强/渐弱松叶）端点收集，配对在 pairWedges（parser.cpp:1069 processWedge）。 */
  private collectWedge(el: Element, md: MeasureData, tick: Fraction, staff: number): void {
    const ty = el.getAttribute("type");
    if (ty !== "crescendo" && ty !== "diminuendo" && ty !== "stop") return;
    this.wedgePts.push({
      mif: md.measureInfo,
      tick: md.measureInfo.offset.plus(tick),
      staff,
      type: ty,
      relX: attrFloat(el, "relative-x"),
      defY: attrFloat(el, "default-y"),
    });
  }

  /** <pedal>（踏板线）端点收集，配对在 pairPedals（parser.cpp:1150 processPedal）。 */
  private collectPedal(el: Element, md: MeasureData, tick: Fraction, staff: number): void {
    const ty = el.getAttribute("type");
    // 仅处理 start/stop 配对（sostenuto/change 等不绘制）。
    if (ty !== "start" && ty !== "stop") return;
    const line = el.getAttribute("line") === "yes";
    const dy = attrFloat(el, "default-y");
    this.pedalPts.push({
      mif: md.measureInfo,
      tick: md.measureInfo.offset.plus(tick),
      staff,
      line,
      stop: ty === "stop",
      ypos: dy !== null ? -dy : 0,
    });
  }

  /** wedge 端点按 staff 配对成 Wedge（parser.cpp:1069）。 */
  private pairWedges(): void {
    const staves = this.part.staves.length;
    for (let s = 0; s < staves; s++) {
      const pts = this.wedgePts.filter((p) => p.staff === s);
      let start: (typeof pts)[number] | null = null;
      for (const p of pts) {
        if (p.type === "stop") {
          if (!start) continue;
          const w = this.part.newWedge();
          w.staff = s;
          w.crescendo = start.type === "crescendo";
          w.startTick = start.tick;
          w.endTick = p.tick;
          w.startMeasure = start.mif;
          w.endMeasure = p.mif;
          if (start.relX !== null) w.dxLeft = start.relX;
          if (p.relX !== null) w.dxRight = p.relX;
          if (start.defY !== null) w.ypos = -start.defY;
          start = null;
        } else {
          start = p;
        }
      }
    }
  }

  /** pedal 端点排序后两两配对成 PedalLine（parser.cpp:1150）。 */
  private pairPedals(): void {
    const pts = [...this.pedalPts].sort((a, b) => {
      if (a.staff !== b.staff) return a.staff - b.staff;
      if (a.line !== b.line) return (a.line ? 1 : 0) - (b.line ? 1 : 0);
      const c = a.tick.compareTo(b.tick);
      if (c !== 0) return c;
      return (a.stop ? 1 : 0) - (b.stop ? 1 : 0);
    });
    for (let i = 1; i < pts.length; ) {
      const prev = pts[i - 1];
      const cur = pts[i];
      if (prev.stop || !cur.stop || prev.line !== cur.line) {
        i++;
        continue;
      }
      const ln = this.part.newPedalLine();
      ln.sign = false;
      ln.line = prev.line;
      ln.startTick = prev.tick;
      ln.startMeasure = prev.mif;
      ln.endMeasure = cur.mif;
      ln.endTick = cur.tick;
      ln.ypos = prev.ypos;
      ln.staff = prev.staff;
      i += 2;
    }
  }

  /** <segno> / <coda> 记号（parser.cpp::processSegno / processCoda）。
   *  位置不取 default-x：本工程文本块统一由 updateDataXPos 按 offset 的 getEntPos 定位，
   *  与 musicpp 直接用 default-x 的策略不同；这里只保留 y=45 与 +15 的小幅右移。 */
  private processSegno(blk: MeasureText, coda: boolean): void {
    blk.y = 45; // todo: parser.cpp 同样硬编码
    blk.x += 15;
    const font = new Font("Bravura", this.score.defaults.musicTextFont.size / this.score.scaling);
    blk.add(coda ? GlyphCodes.coda : GlyphCodes.segno, font, true);
  }

  /** <words> 文本（如「(副歌)」），对应 loader.cpp::processWords。 */
  private processWords(blk: MeasureText, wEl: Element): boolean {
    const dy = attrFloat(wEl, "default-y");
    if (dy !== null) blk.y = dy;
    const rx = attrFloat(wEl, "relative-x");
    if (rx !== null) blk.x = rx;
    const just = wEl.getAttribute("justify");
    if (just === "right") blk.justify = LCR.Right;
    else if (just === "center") blk.justify = LCR.Center;
    const text = wEl.textContent ?? "";
    if (!text) return false;
    blk.add(text, this.makeWordsFont(wEl));
    return true;
  }

  /** <dynamics>（如 <mf/>、<sfz/>、<other-dynamics>），对应 loader.cpp::processDynamic。
   *  标准力度子元素名逐字母转成 Bravura 力度字形；<other-dynamics> 用其原文。 */
  private processDynamic(blk: MeasureText, dynEl: Element): boolean {
    const dy = attrFloat(dynEl, "default-y");
    if (dy !== null) blk.y = dy;
    const rx = attrFloat(dynEl, "relative-x");
    if (rx !== null) blk.x = rx;
    let any = false;
    const font = new Font("Bravura", 16 / this.score.scaling);
    for (const child of Array.from(dynEl.children)) {
      if (child.tagName === "other-dynamics") {
        const text = child.textContent ?? "";
        if (text) {
          blk.add(text, this.makeWordsFont(child as Element));
          any = true;
        }
      } else {
        const glyphs = convertDynamicsStr(child.tagName);
        if (glyphs) {
          blk.add(glyphs, font, true);
          any = true;
        }
      }
    }
    return any;
  }

  /** <metronome>（<beat-unit> + <per-minute>），对应 loader.cpp::processMetronome。 */
  private processMetronome(blk: MeasureText, metEl: Element): boolean {
    const wordFont = this.makeWordsFont(metEl);
    // webview 只注册了 "Bravura" @font-face（styles.css）；"BravuraText" 未注册会回退成
    // 缺字形的方框。Bravura 含同一套 metNote 字形，故用 Bravura。
    const noteFont = new Font("Bravura", wordFont.size);
    let any = false;
    for (const child of Array.from(metEl.children)) {
      if (child.tagName === "beat-unit") {
        const gl = metNoteGlyph(child.textContent?.trim() ?? "quarter");
        blk.add(gl, noteFont, true);
        any = true;
      } else if (child.tagName === "per-minute") {
        blk.add(" = " + (child.textContent?.trim() ?? ""), wordFont);
        any = true;
      }
    }
    return any;
  }

  /** MusicXML <words> 字体 → tenths 空间字号（pt / scaling，对齐 loader.cpp::makeFont）。 */
  private makeWordsFont(wEl: Element): Font {
    const fam = wEl.getAttribute("font-family") ?? "Times New Roman";
    const szAttr = wEl.getAttribute("font-size");
    const sz = szAttr ? parseFloat(szAttr) : 16;
    const bold = wEl.getAttribute("font-weight") === "bold";
    return new Font(fam, sz / this.score.scaling, bold);
  }

  private processHarmony(harmEl: Element, md: MeasureData, tick: Fraction): void {
    const h = md.newHarmony();
    h.offset = tick;
    h.y = attrFloat(harmEl, "default-y") ?? -1;
    h.staff = (attrInt(harmEl, "staff") ?? 1) - 1;

    const rootEl = elem(harmEl, "root");
    if (rootEl) {
      h.root.step = txt(rootEl, "root-step") ?? "C";
      h.root.alter = floatOf(rootEl, "root-alter") ?? 0;
    }
    const bassEl = elem(harmEl, "bass");
    if (bassEl) {
      h.bass = {
        step: txt(bassEl, "bass-step") ?? "C",
        alter: floatOf(bassEl, "bass-alter") ?? 0,
      };
    }
    const kindEl = elem(harmEl, "kind");
    if (kindEl) {
      h.kind = kindEl.textContent?.trim() ?? "";
      h.kindText = kindEl.getAttribute("text");
      h.useSymbols = kindEl.getAttribute("use-symbols") === "yes";
      h.parenthesesDegrees =
        kindEl.getAttribute("parentheses-degrees") === "yes" ||
        this.score.encoder === Encoder.Sibelius;
    }
    for (const degEl of elems(harmEl, "degree")) {
      const val = intOf(degEl, "degree-value") ?? 0;
      const alter = floatOf(degEl, "degree-alter") ?? 0;
      const typeStr = txt(degEl, "degree-type") ?? "add";
      let type: HarmonyDegreeType;
      switch (typeStr) {
        case "subtract": type = HarmonyDegreeType.Subtract; break;
        case "alter": type = HarmonyDegreeType.Alter; break;
        default: type = HarmonyDegreeType.Add;
      }
      h.degree.push({ value: val, alter, type });
    }
  }

  private processBarline(blEl: Element, mif: MeasureInfo): void {
    const loc = blEl.getAttribute("location") ?? "right";
    const style = txt(blEl, "bar-style");
    if (style) {
      const g = barGlyphFromStyle(style);
      if (g !== null) {
        if (loc === "left") mif.leftBarline = g;
        else mif.rightBarline = g;
      }
    }
    const repEl = elem(blEl, "repeat");
    if (repEl) {
      if (repEl.getAttribute("direction") === "backward") mif.backward = true;
      else mif.forward = true;
    }
    const endingEl = elem(blEl, "ending");
    // print-object="no" 的 ending 不参与绘制（parser.cpp::processEnding 1232）；ending 端点按
    // 本声部收集（musicpp 逐声部读 barline），否则全局 MeasureInfo 会让每个声部都画一遍。
    if (endingEl && endingEl.getAttribute("print-object") !== "no") {
      const nums = parseEndingNums(endingEl.getAttribute("number") ?? "");
      if (nums.size > 0) {
        const ty = endingEl.getAttribute("type");
        if (loc === "left") {
          if (ty === "start") this.endingPts.push({ mif, nums, start: true, stop: false });
        } else {
          if (ty === "stop") this.endingPts.push({ mif, nums, start: false, stop: true });
          else if (ty === "discontinue")
            this.endingPts.push({ mif, nums, start: false, stop: false });
        }
      }
    }
  }

  /** 无 <beam> 的谱（OMR 生成）：按拍自动把相邻的短音符（八分及更短）分组成符杠。
   *  仅在整声部无任何 <beam> 时启用；真实制谱谱都带 <beam>，不受影响。 */
  private autoBeamPart(): void {
    const one = new Fraction(1);
    const levelsOf = (ch: MChord) => Math.max(0, Math.round(-Math.log2(ch.noteType.toFloat())));
    for (let mi = 0; mi < this.part.measures.length; mi++) {
      const md = this.part.measures[mi];
      if (md.beams.length > 0) continue;
      const mif = this.score.measures[mi];
      const ts = this.part.staves[0]?.getTime(mif.offset);
      // 每拍时值（四分音符单位）：复拍(x/8 且 beats 为 3 的倍数)按附点四分成组，否则按分母音符。
      let beatLen = 1;
      if (ts) beatLen = ts.beatType === 8 && ts.beats % 3 === 0 ? 1.5 : 4 / ts.beatType;
      const chords = [...md.chords].filter((c) => !c.grace).sort((a, b) => a.offset.compareTo(b.offset));
      let run: MChord[] = [];
      const flush = () => {
        if (run.length >= 2) {
          const g = new BeamGroup();
          // 符杠组内符干方向须统一：取离中线(line=-4)最远的音符决定——在中线之上则整组朝下，
          // 否则朝上（否则同一符杠两端符干反向，符杠画歪/穿头）。
          let extreme = 0; // line+4，绝对值最大者胜
          for (const c of run) {
            for (const nt of c.notes) {
              const dev = nt.line() + 4;
              if (Math.abs(dev) > Math.abs(extreme)) extreme = dev;
            }
          }
          const groupUp = extreme < 0;
          for (const c of run) c.stemUp = groupUp;
          for (let i = 0; i < run.length; i++) {
            const ch = run[i];
            const lv = levelsOf(ch);
            ch.beams = [];
            for (let L = 0; L < lv; L++) {
              const prevHas = i > 0 && levelsOf(run[i - 1]) > L;
              const nextHas = i < run.length - 1 && levelsOf(run[i + 1]) > L;
              ch.beams.push(
                prevHas && nextHas ? BeamVal.Continue
                  : !prevHas && nextHas ? BeamVal.Begin
                  : prevHas && !nextHas ? BeamVal.End
                  : i === 0 ? BeamVal.Forward : BeamVal.Backward,
              );
            }
            g.chords.push(ch);
          }
          md.beams.push(g);
        }
        run = [];
      };
      let curBeat = -1;
      for (const ch of chords) {
        if (ch.rest || ch.noteType.compareTo(one) >= 0) { flush(); curBeat = -1; continue; }
        const beat = Math.floor(ch.offset.toFloat() / beatLen + 1e-6);
        if (run.length > 0 && beat !== curBeat) flush();
        run.push(ch);
        curBeat = beat;
      }
      flush();
    }
  }

  private calcStemLen(): void {
    // parser.cpp::calcStemLen —— 仅有 <stem> 的音符算符干长；有 default-y 用之，
    // 否则回退 35（grace 乘 cueSize）。无符干（全音符）保持默认 0。
    const cueSize = this.score.options.cueSize;
    for (const nt of this.stemNotes) {
      const ch = nt.chord;
      const sy = this.stemYMap.get(nt);
      if (sy !== undefined) {
        ch.stemLen = Math.abs(-nt.cy() - sy);
      } else {
        ch.stemLen = ch.grace ? 35 * cueSize : 35;
      }
    }
  }

  /** 符杠组符干长度/斜率（styler.cpp BeamGroup::format，经 guessStemDir/parser 2911 调用）。
   *  先按 stemUp 差异标记 doubleDir，再 format(0)。跨谱表的 dy 需系统排版后才知，此处用 0；
   *  本工程混排谱的符杠均在单一谱表内，crossStaff() 为假，format 内部也会把 dy 归零。 */
  private formatBeams(): void {
    for (const md of this.part.measures) {
      for (const g of md.beams) {
        if (g.chords.length === 0) continue;
        // beam-over-rest：符杠内的休止符无 <stem>，stemUp 取默认 true。若两侧音符均为
        // stem-down，会被误判 doubleDir；而 doubleDir 的 calcSlopeLen 分支不做「下符头避让」
        // （非 doubleDir 分支才有 +35 最小符干），导致八度等宽和弦的符杠穿过下符头。
        // 休止符不画符干，把方向对齐到本组首个真实音符即可消除假 doubleDir。
        const ref = g.chords.find((ch) => !ch.rest) ?? g.chords[0];
        for (const ch of g.chords) {
          if (ch.rest) ch.stemUp = ref.stemUp;
        }
        g.doubleDir = g.chords.some((ch) => ch.stemUp !== ref.stemUp);
        g.format(0);
      }
    }
  }

  private processTied(): void {
    const done = new Set<MNote>();
    for (const start of this.tieStarts) {
      if (done.has(start.note)) continue;
      for (const stop of this.tieStops) {
        if (done.has(stop.note)) continue;
        if (!fEq(stop.endTick, start.endTick)) continue;
        if (stop.pitch !== start.pitch) continue;
        done.add(start.note);
        done.add(stop.note);
        const tied = this.part.newTied();
        tied.startNote = start.note;
        tied.endNote = stop.note;
        tied.startTick = start.note.chord.tick();
        tied.endTick = start.endTick;
        break;
      }
    }
  }

  /** 对齐 musicpp parser.cpp::processEnding：收集所有反复记号端点（按绝对 tick），排序后
   *  相邻两两配对。左反复记号（start）在小节起点，右反复记号（stop/discontinue）在小节末端。
   *  此处 mif.offset 已在 PartLoader 主循环里赋为绝对 tick，可直接取用。 */
  private processEnding(): void {
    type EndingPt = { tick: Fraction; mif: MeasureInfo; nums: Set<number>; stop: boolean };
    const pts: EndingPt[] = this.endingPts.map((p) => ({
      tick: p.start ? p.mif.offset : p.mif.endTick(),
      mif: p.mif,
      nums: p.nums,
      stop: p.stop,
    }));
    pts.sort((a, b) => a.tick.compareTo(b.tick));
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const a = pts[i];
      const b = pts[i + 1];
      const end = this.part.newEnding();
      end.startTick = a.tick;
      end.endTick = b.tick;
      end.startMeasure = a.mif;
      end.endMeasure = b.mif;
      end.number = [...a.nums].sort((x, y) => x - y).join(",");
      end.hasStop = b.stop;
    }
  }
}

// ---------------- Layout pass ----------------

// ---- 自动版面（无内嵌坐标时，如 OMR 生成的 MusicXML）----
// 真实制谱软件（Sibelius/Finale）导出的 MusicXML 自带 <measure width>、音符 default-x、
// <print new-system/new-page>，本工程默认信任之。OMR（omr/musicxml.ts）产出的 MusicXML
// 只有音高/时值、没有任何版面坐标 → 所有音符坍缩到 x≈0、谱表零宽。此处按节奏自动计算
// 小节宽度、折行、并把音符横向铺开，使无坐标的谱也能正常混排显示。

// 每音符按时值给一个"槽宽"（tenths）。时值越长间距越大（近似 Gould 的次线性增长）。
const AUTO_MIN_SLOT = 22;
const AUTO_END_PAD = 16;   // 末音符到小节线的余量
const AUTO_LEFT_DATA = 16; // 小节左侧到首音符的名义留白（折行用的自然宽）
const AUTO_FIRST_LEAD = 60; // 行首小节谱号/调号/拍号占位估算
const AUTO_NOTE_PAD = 8;    // 铺开音符时两端留白

function autoSlotWidth(durQuarters: number): number {
  const d = durQuarters > 0 ? durQuarters : 0.25;
  return Math.max(AUTO_MIN_SLOT, 30 * Math.pow(d, 0.6));
}

/** 该 MusicXML 是否自带版面坐标（任一小节有 width 或任一音符有 default-x）。 */
function hasEmbeddedLayout(score: MixedScore): boolean {
  for (const mif of score.measures) if (mif.width > 0) return true;
  for (const part of score.parts) {
    for (const md of part.measures) {
      for (const ch of md.chords) {
        for (const nt of ch.notes) if (nt.x >= 0) return true;
      }
    }
  }
  return false;
}

/** 某小节内所有声部音符的节奏槽：offset(measure-relative) → 自然累计 x + 该 offset 的槽宽。 */
function autoMeasureSlots(score: MixedScore, mi: number): { offset: Fraction; nat: number; slot: number }[] {
  const durAt = new Map<string, { offset: Fraction; dur: number }>();
  for (const part of score.parts) {
    const md = part.measures[mi];
    if (!md) continue;
    for (const ch of md.chords) {
      if (ch.grace) continue;
      const key = ch.offset.toString();
      const dq = ch.dur.toFloat();
      const prev = durAt.get(key);
      // 同 offset 多声部/和弦取最短时值定间距（较密者主导）。
      if (!prev || dq < prev.dur) durAt.set(key, { offset: ch.offset, dur: dq });
    }
  }
  const entries = [...durAt.values()].sort((a, b) => a.offset.compareTo(b.offset));
  const slots: { offset: Fraction; nat: number; slot: number }[] = [];
  let nat = 0;
  for (const e of entries) {
    const slot = autoSlotWidth(e.dur);
    slots.push({ offset: e.offset, nat, slot });
    nat += slot;
  }
  return slots;
}

/** 计算每小节自然宽度 + 按页宽折行，返回强制换行的小节索引集合。 */
function autoLayoutWidths(score: MixedScore): Set<number> {
  const natSpan: number[] = [];
  for (let i = 0; i < score.measures.length; i++) {
    const slots = autoMeasureSlots(score, i);
    const span = slots.length ? slots[slots.length - 1].nat + slots[slots.length - 1].slot : AUTO_MIN_SLOT;
    natSpan[i] = span;
    score.measures[i].width = AUTO_LEFT_DATA + span + AUTO_END_PAD;
  }

  const d = score.defaults;
  const avail = d.pageWidth - d.leftMargin - d.rightMargin;
  const breaks = new Set<number>([0]);
  let cur = AUTO_FIRST_LEAD;
  let firstInLine = true;
  for (let i = 0; i < score.measures.length; i++) {
    const w = score.measures[i].width;
    if (!firstInLine && cur + w > avail) {
      breaks.add(i);
      cur = AUTO_FIRST_LEAD + w;
      firstInLine = false;
    } else {
      cur += w;
      firstInLine = false;
    }
  }
  return breaks;
}

/** 折行后拉伸每个 system 的小节宽度以铺满页宽（末行保持自然宽，不拉伸）。 */
function autoJustifySystems(score: MixedScore): void {
  const d = score.defaults;
  for (let si = 0; si < score.systems.length; si++) {
    const sys = score.systems[si];
    if (!sys.measures.length) continue;
    const avail = d.pageWidth - d.leftMargin - d.rightMargin - sys.leftMargin - sys.rightMargin;
    // 行首小节预留谱号/调号/拍号占位，使拉伸后仍有容纳区。
    sys.measures[0].width += AUTO_FIRST_LEAD;
    let sum = 0;
    for (const m of sys.measures) sum += m.width;
    if (sum <= 0) continue;
    const isLast = si === score.systems.length - 1;
    // 末行只在溢出时缩，不主动拉满（符合常规制谱：不把弱起短行撑满）。
    let scale = avail / sum;
    if (isLast && scale > 1) scale = 1;
    for (const m of sys.measures) m.width *= scale;
  }
}

/** layoutAttr 之后：把每小节音符横向铺到 [dataPos, dataEnd] 内（按节奏槽比例）。 */
function autoPlaceNotes(score: MixedScore): void {
  for (let i = 0; i < score.measures.length; i++) {
    const mif = score.measures[i];
    const slots = autoMeasureSlots(score, i);
    if (!slots.length) continue;
    const natTotal = slots[slots.length - 1].nat + slots[slots.length - 1].slot;
    // 行首小节 dataPos 紧贴谱号/调号/拍号右缘，首音符须再留一段净空，否则贴着拍号。
    const hasAttr = mif.clefPos !== null || mif.keyPos !== null || mif.timePos !== null;
    const left = mif.dataPos + AUTO_NOTE_PAD + (hasAttr ? AUTO_ATTR_GAP : 0);
    const right = mif.dataEnd - AUTO_NOTE_PAD;
    const inner = Math.max(right - left, AUTO_MIN_SLOT);
    const xOf = new Map<string, number>();
    for (const s of slots) {
      xOf.set(s.offset.toString(), left + (natTotal > 0 ? (s.nat / natTotal) * inner : 0));
    }
    const meta = score.options.meta;
    for (const part of score.parts) {
      const md = part.measures[i];
      if (!md) continue;
      for (const ch of md.chords) {
        if (ch.grace) continue;
        const x = xOf.get(ch.offset.toString());
        if (x === undefined) continue;
        for (const nt of ch.notes) nt.x = x;
      }
      // NoteEntry（加线/附点/临时记号）在解析期 layoutNotes 时按未定位的 x(-1) 算过一次，
      // 加线会画到谱表最左端而非音符下方；音符 x 定好后按最终位置重排。
      for (const ent of md.noteEntries) ent.layout(meta, false);
      // 符杠斜率/端点依赖音符 x，解析期(x=-1)算出的是 NaN/退化值 → 重排。
      for (const g of md.beams) {
        if (g.chords.length === 0) continue;
        const ref = g.chords.find((c) => !c.rest) ?? g.chords[0];
        for (const c of g.chords) if (c.rest) c.stemUp = ref.stemUp;
        g.doubleDir = g.chords.some((c) => c.stemUp !== ref.stemUp);
        g.format(0);
      }
      // 歌词：解析时 lrc.x 取的是尚未定位的音符 x(-1)，此处按音符最终位置补正 x
      //（否则 drawLrc 里 x<0 被跳过，歌词不显示）。y 在下面按 system 统一定。
      for (const lrc of md.lyrics) {
        const x = xOf.get(lrc.offset.toString());
        if (x !== undefined) lrc.x = x;
      }
      // 速度/文字记号：无 default-y 时默认落在谱表内（y≈0）与音符重叠，抬到谱表上方；
      // 字号统一到歌词字号（含节拍音符字形），避免 OMR 速度记号偏小。
      const lyrSize = score.defaults.lyricFont.size;
      for (const t of md.textBlocks) {
        if (t.y <= 0) t.y = AUTO_DIRECTION_Y;
        for (const it of t.data) {
          if (it.font.size > 0) it.font = it.font.scaled(lyrSize / it.font.size);
        }
      }
    }
  }

  // 歌词 y：逐 system 取该行音符/符干/下方 slur-tie 的最低点统一下移，让各 verse 行整齐
  // 且不与下探的符干/加线/符杠/圆滑线重叠（固定偏移在低音+朝下符干/下方 slur 时会被压住）。
  const four = new Fraction(4);
  const chordLow = (ch: MChord): number => {
    let low = 0;
    for (const nt of ch.notes) low = Math.max(low, nt.cy());
    if (!ch.stemUp && ch.noteType.compareTo(four) < 0) low = Math.max(low, ch.tailY(false));
    return low;
  };
  for (const sys of score.systems) {
    let maxDown = 40; // 谱表底线（cy 向下为正）
    const t0 = sys.measures[0].offset;
    const t1 = sys.measures[sys.measures.length - 1].endTick();
    for (const mif of sys.measures) {
      for (const part of score.parts) {
        const md = part.measures[mif.index];
        if (!md) continue;
        for (const ch of md.chords) {
          if (ch.grace || ch.rest) continue;
          const low = chordLow(ch);
          if (low > maxDown) maxDown = low;
        }
      }
    }
    // 实际画在谱表下方的 slur/tie 才参与避让：渲染层对 简谱/混排 记号一律把 slur/tie 画到
    // 上方（render.ts drawSlur/drawTied，jianpu 惯例），故那些谱表用 above=true 不下探；仅当
    // 该谱表是普通五线谱且 slur/tie 判为下方(above=false)时，弧线在端点音符下方再下探 SAG。
    for (const part of score.parts) {
      for (const sp of [...part.slurs, ...part.tied]) {
        if (!sp.startNote || !sp.endNote) continue;
        if (sp.endTick.compareTo(t0) <= 0 || sp.startTick.compareTo(t1) >= 0) continue;
        const nota = part.staves[sp.startNote.staff]?.getNotation(sp.startTick);
        const drawnAbove = nota === Notation.Mixed || nota === Notation.JianPu ? true : sp.above;
        if (drawnAbove) continue;
        const low = Math.max(chordLow(sp.startNote.chord), chordLow(sp.endNote.chord)) + AUTO_SLUR_SAG;
        if (low > maxDown) maxDown = low;
      }
    }
    const base = maxDown + AUTO_LYRIC_GAP;
    for (const mif of sys.measures) {
      for (const part of score.parts) {
        const md = part.measures[mif.index];
        if (!md) continue;
        for (const lrc of md.lyrics) {
          const verse = Math.max(0, (parseInt(lrc.num, 10) || 1) - 1);
          lrc.y = -(base + verse * AUTO_LYRIC_ROW);
        }
      }
    }
  }
}

// 标题/词曲信息：OMR MusicXML 的 <credit> 无 default-x/-y/font-size，且标题只在
// <work-title> 里（未作为 credit）→ 全挤在页首同一位置、无字号区分。此处按页面重排：
// 标题居中大字，作词/作曲逐行居中小字，堆叠在标题下方。
const AUTO_TITLE_FS = 26;
const AUTO_CREDIT_FS = 14;
const AUTO_LYRIC_GAP = 20;   // 音符/符干/slur 最低点到首行歌词基线的净空（tenths）
const AUTO_LYRIC_ROW = 22;   // 相邻 verse 行距
const AUTO_DIRECTION_Y = 46; // 速度记号默认高度（谱表上方）
const AUTO_ATTR_GAP = 16;    // 行首小节谱号/调号/拍号右缘到首音符的额外净空
const AUTO_SLUR_SAG = 16;    // 下方 slur/tie 弧线相对端点音符再下探的量

function autoLayoutHeader(score: MixedScore): void {
  const d = score.defaults;
  const cx = d.pageWidth / 2;
  const creds: ScoreCredit[] = [];
  let yTop = d.topMargin + 8; // 自上边距向下累积基线（top-down）
  if (score.title) {
    yTop += AUTO_TITLE_FS;
    creds.push({
      page: 0, text: score.title, type: "title",
      x: cx, y: d.pageHeight - yTop, justify: LCR.Center, fontSize: AUTO_TITLE_FS,
    });
    yTop += 10;
  }
  // 原有 credit（作词/作曲…）按顺序堆到标题下方，居中小字。
  for (const c of score.credits) {
    if (!c.text) continue;
    yTop += AUTO_CREDIT_FS + 4;
    creds.push({
      page: 0, text: c.text, type: c.type,
      x: cx, y: d.pageHeight - yTop, justify: LCR.Center, fontSize: AUTO_CREDIT_FS,
    });
  }
  score.credits = creds;
}

function buildSystemsAndPages(score: MixedScore, xmlParts: Element[], extraBreaks?: Set<number>): void {
  const newSystem = new Set<number>(extraBreaks ?? []);
  const newPage = new Set<number>();

  for (const pt of xmlParts) {
    let mid = 0;
    for (const mea of elems(pt, "measure")) {
      for (const pr of elems(mea, "print")) {
        if (pr.getAttribute("new-page") === "yes") {
          newPage.add(mid);
          newSystem.add(mid);
          if (mid > 0) score.measures[mid].showBarNumber = true;
        } else if (pr.getAttribute("new-system") === "yes") {
          newSystem.add(mid);
          if (mid > 0) score.measures[mid].showBarNumber = true;
        }
      }
      mid++;
    }
  }

  for (let i = 0; i < score.measures.length; i++) {
    const mif = score.measures[i];
    const needNewSys = score.systems.length === 0 || newSystem.has(i);
    if (!needNewSys) {
      const sys = score.systems[score.systems.length - 1];
      sys.measures.push(mif);
      mif.system = sys;
    } else {
      const sys = new Sys();
      sys.score = score;
      sys.firstMeasure = i;
      sys.measures.push(mif);
      mif.system = sys;
      sys.index = score.systems.length;
      for (const part of score.parts) {
        for (const ps of part.staves) {
          sys.staves.push(new SysStaff(ps));
        }
      }
      score.systems.push(sys);
    }
  }

  for (const sys of score.systems) {
    const needNewPage = score.pages.length === 0 || newPage.has(sys.firstMeasure);
    if (needNewPage) {
      const pg = new MPage();
      pg.systems.push(sys);
      score.pages.push(pg);
    } else {
      score.pages[score.pages.length - 1].systems.push(sys);
    }
  }
}

/**
 * 空谱表隐藏：MusicXML 用 <attributes><staff-details print-object="no/yes"> 切换某谱表可见性，
 * 状态跨系统延续（loader.cpp::processStaffDetails + updateSystemLayout 的 visPrev）。
 * 在每个 system 的 firstMeasure 处应用累积可见性快照。
 */
function applyStaffVisibility(score: MixedScore, xmlParts: Element[]): void {
  // measureIdx → (全局谱表序号 → 可见)
  const changes = new Map<number, Map<number, boolean>>();
  let stfOff = 0;
  let pid = 0;
  for (const ptEl of xmlParts) {
    const part = score.parts[pid++];
    let mid = 0;
    for (const mea of elems(ptEl, "measure")) {
      for (const at of elems(mea, "attributes")) {
        for (const det of elems(at, "staff-details")) {
          const po = det.getAttribute("print-object");
          if (po === null) continue;
          const num = (attrInt(det, "number") ?? 1) - 1;
          const g = stfOff + num;
          let m = changes.get(mid);
          if (!m) {
            m = new Map();
            changes.set(mid, m);
          }
          m.set(g, po !== "no");
        }
      }
      mid++;
    }
    stfOff += part.staves.length;
  }
  if (changes.size === 0) return;

  const total = stfOff;
  const sysByFirst = new Map<number, Sys>();
  for (const sys of score.systems) sysByFirst.set(sys.firstMeasure, sys);

  const visPrev = new Array<boolean>(total).fill(true);
  for (let mid = 0; mid < score.measures.length; mid++) {
    const ch = changes.get(mid);
    if (ch) for (const [g, v] of ch) visPrev[g] = v;
    const sys = sysByFirst.get(mid);
    if (sys) {
      for (let i = 0; i < sys.staves.length && i < total; i++) {
        sys.staves[i].staffVisible = visPrev[i];
      }
    }
  }
}

function updateLayoutByPrint(score: MixedScore, xmlParts: Element[]): void {
  for (const sys of score.systems) {
    let stfOff = 0;
    let pid = 0;
    for (const ptEl of xmlParts) {
      const part = score.parts[pid++];
      const mea = elems(ptEl, "measure")[sys.firstMeasure];
      if (!mea) { stfOff += part.staves.length; continue; }
      for (const pr of elems(mea, "print")) {
        const sl = elem(pr, "system-layout");
        if (sl) {
          const smEl = elem(sl, "system-margins");
          if (smEl) {
            sys.leftMargin = floatOf(smEl, "left-margin") ?? sys.leftMargin;
            sys.rightMargin = floatOf(smEl, "right-margin") ?? sys.rightMargin;
          }
          const topDist = floatOf(sl, "top-system-distance");
          const sysDist = floatOf(sl, "system-distance");
          const dist = topDist ?? sysDist;
          if (dist !== null) sys.distance = dist;
        }
        for (const stfLayEl of elems(pr, "staff-layout")) {
          const num = (attrInt(stfLayEl, "number") ?? 1) - 1;
          const dist = floatOf(stfLayEl, "staff-distance");
          const stfIdx = stfOff + num;
          if (dist !== null && stfIdx < sys.staves.length) {
            sys.staves[stfIdx].distance = dist;
          }
        }
      }
      stfOff += part.staves.length;
    }
  }

  // Default distances
  for (const sys of score.systems) {
    let firstVisible = true;
    for (const st of sys.staves) {
      if (!st.staffVisible) { st.distance = 0; continue; }
      if (firstVisible) { st.distance = 0; firstVisible = false; }
      else if (st.distance === 0) st.distance = 80;
    }
    if (sys.distance === 0) sys.distance = 80;
  }

  // Convert relative system distances to absolute Y positions per page.
  // MusicXML: top-system-distance (first system per page) = absolute from page top margin.
  //           system-distance (subsequent systems) = gap from previous system bottom.
  for (const pg of score.pages) {
    let absY = 0;
    let prevHeight = 0;
    for (let si = 0; si < pg.systems.length; si++) {
      const sys = pg.systems[si];
      if (si === 0) {
        absY = sys.distance; // already absolute
      } else {
        absY = absY + prevHeight + sys.distance;
        sys.distance = absY;
      }
      prevHeight = sys.height();
    }
  }
}

function layoutAttr(score: MixedScore): void {
  for (const mif of score.measures) {
    const sys = mif.system;
    const nsys = sys.firstMeasure === mif.index;

    let hasClef = nsys;
    let hasKey = nsys;
    let keyChange = false;
    let timeChange = false;
    let keyWidth = 0;
    let timeWidth = 0;

    for (const st of sys.staves) {
      if (!st.staffVisible) continue;
      const ps = st.partStaff;
      if (ps.keyChange(mif.offset)) {
        if (nsys && mif.index > 0) {
          const prev = score.measures[mif.index - 1];
          const prevStf = prev.system.staves.find((s) => s.partStaff === ps);
          if (prevStf?.staffVisible) keyChange = true;
        } else {
          keyChange = true;
        }
      }
      if (ps.timeChange(mif.offset)) timeChange = true;

      if (hasKey || keyChange) {
        const ks = ps.getKey(mif.offset);
        const w = keyChangeWidthCalc(ks.cancel, ks.fifths);
        if (w > keyWidth) keyWidth = w;
        for (const part of score.parts) {
          const md = part.measures[mif.index];
          if (md) {
            for (const h of md.harmonies) {
              if (fEq(h.offset, new Fraction(0))) mif.keyOffestJP = -20;
            }
          }
        }
      }
      if (timeChange) {
        const ts = ps.getTime(mif.offset);
        const w = timeSigWidthCalc(ts);
        if (w > timeWidth) timeWidth = w;
      }
    }

    let xpos = 5;
    if (hasClef) { mif.clefPos = xpos; xpos += 32; }
    if (hasKey || keyChange) { mif.keyPos = xpos; xpos += keyWidth; }
    if (timeChange) { mif.timePos = xpos; xpos += timeWidth; }
    if (mif.forward && nsys) { mif.leftBarlinePos = xpos + 20; xpos += 30; }
    mif.dataPos = xpos;
    mif.dataEnd = mif.width;

    if (nsys && mif.index > 0) {
      const prev = score.measures[mif.index - 1];
      const psys = prev.system;
      if (keyChange) {
        psys.keyChangeWidth = keyWidth;
        prev.dataEnd -= keyWidth + 5;
      }
      if (timeChange) {
        psys.timeChangeWidth = timeWidth;
        prev.dataEnd -= timeWidth + 5;
        const last = psys.measures[psys.measures.length - 1];
        if (last) last.width += timeWidth + 5;
      }
    }

    // 宽右小节线（终止线/双线等）占的横向宽度从 dataEnd 扣除，使 ending 括号右端与
    // 反复记号留出间隙（parser.cpp:2828-2848）。
    if (mif.rightBarline !== null) {
      const lws = score.options.lineWidths;
      const dist = score.options.barlineDist;
      let blw = 0;
      switch (mif.rightBarline) {
        case BarGlyph.Final:
          blw = lws.heavyBarline + lws.lightBarline + dist;
          break;
        case BarGlyph.Double:
          blw = lws.lightBarline * 2 + dist;
          break;
        case BarGlyph.HeavyHeavy:
          blw = lws.heavyBarline * 2 + dist;
          break;
        default:
          break;
      }
      mif.dataEnd -= blw;
    }
  }
}

function keyChangeWidthCalc(cancel: number, key: number): number {
  let res = 5;
  if (cancel * key < 0) {
    res += (Math.abs(cancel) + Math.abs(key)) * 10;
  } else {
    res += Math.max(Math.abs(key), Math.abs(cancel)) * 10;
    if (Math.abs(cancel) > 0 && Math.abs(key) > 0 && Math.sign(cancel) !== Math.sign(key)) {
      res += Math.min(Math.abs(key), Math.abs(cancel)) * 10;
    }
  }
  return res;
}

function timeSigWidthCalc(ts: TimeSig): number {
  if (ts.symbol) return 30;
  const digits = (n: number) => String(n).length;
  return Math.max(digits(ts.beats), digits(ts.beatType)) * 10;
}

function updateEntPos(score: MixedScore): void {
  for (let i = 0; i < score.measures.length; i++) {
    const mif = score.measures[i];
    for (const part of score.parts) {
      const md = part.measures[i];
      if (!md) continue;
      for (const ch of md.chords) {
        if (ch.rest && fEq(ch.dur, mif.dur)) continue;
        mif.entPos.set(ch.offset, ch.entX());
      }
    }
  }
}

function updateDataXPos(score: MixedScore): void {
  for (const part of score.parts) {
    for (let i = 0; i < score.measures.length; i++) {
      const mif = score.measures[i];
      const md = part.measures[i];
      if (!md) continue;
      for (const h of md.harmonies) h.x = mif.getEntPos(h.offset);
      for (const t of md.textBlocks) {
        if (t.data.length) t.x += mif.getEntPos(t.offset);
      }
    }
  }
}

function loadPartGroups(score: MixedScore, partListEl: Element): void {
  const partsByPid = new Map<string, MixedPart>();
  for (const p of score.parts) partsByPid.set(p.pid, p);

  const groups: PartGroup[] = [];
  const active: PartGroup[] = [];

  for (const child of Array.from(partListEl.children)) {
    if (child.tagName === "score-part") {
      const pid = child.getAttribute("id") ?? "";
      const pp = partsByPid.get(pid);
      if (!pp) continue;
      if (active.length === 0) {
        const g = new PartGroup();
        g.parts.push(pp);
        groups.push(g);
      } else {
        for (const g of active) g.parts.push(pp);
      }
    } else if (child.tagName === "part-group") {
      const ty = child.getAttribute("type");
      const num = child.getAttribute("number") ?? "1";
      if (ty === "start") {
        const g = new PartGroup();
        g.number = num;
        const symEl = elem(child, "group-symbol");
        if (symEl) {
          const sv = symEl.textContent?.trim();
          if (sv === "brace") g.symbol = GroupSymbol.Brace;
          else if (sv === "bracket") g.symbol = GroupSymbol.Bracket;
        }
        const blEl = elem(child, "group-barline");
        if (blEl) g.barline = blEl.textContent?.trim() === "yes";
        groups.push(g);
        active.push(g);
      } else if (ty === "stop") {
        const idx = active.findIndex((g) => g.number === num);
        if (idx >= 0) active.splice(idx, 1);
      }
    }
  }

  for (const g of groups) {
    if (g.parts.length === 1 && g.parts[0].staves.length > 1) g.barline = true;
  }
  score.partGroups = groups;
}

function extractTitle(root: Element): string {
  for (const cr of elems(root, "credit")) {
    const ct = elem(cr, "credit-type");
    if (ct?.textContent?.trim() !== "title") continue;
    const cw = elem(cr, "credit-words");
    const t = cw?.textContent?.trim();
    if (t) return t;
  }
  const work = elem(root, "work");
  if (work) {
    const wt = txt(work, "work-title")?.trim();
    if (wt) return wt;
  }
  return txt(root, "movement-title")?.trim() ?? "";
}

// ---------------- Top-level entry point ----------------

/**
 * MusicXML text → MixedScore.
 * Caller must provide a fully-constructed MixedOptions (with loaded MetaData).
 * Equivalent to musicpp mxml::load().
 */
export function loadMixedXml(xmlText: string, options: MixedOptions): MixedScore {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("MusicXML 解析失败: " + err.textContent);
  const root = doc.documentElement;

  const score = new MixedScore(options);

  // Encoder detection
  const identEl = elem(root, "identification");
  if (identEl) {
    const encEl = elem(identEl, "encoding");
    if (encEl) {
      for (const swEl of elems(encEl, "software")) {
        const sw = swEl.textContent ?? "";
        if (sw.includes("Sibelius")) score.encoder = Encoder.Sibelius;
        else if (sw.includes("MuseScore")) score.encoder = Encoder.MuseScore;
      }
    }
  }

  // Scaling
  const defsEl = elem(root, "defaults");
  if (defsEl) {
    const scEl = elem(defsEl, "scaling");
    if (scEl) {
      const mm = floatOf(scEl, "millimeters") ?? 7.0;
      const tenths = floatOf(scEl, "tenths") ?? 40.0;
      score.scaling = (mm * 72) / 25.4 / tenths;
    }
    // Page size
    const plEl = elem(defsEl, "page-layout");
    if (plEl) {
      const w = floatOf(plEl, "page-width");
      const h = floatOf(plEl, "page-height");
      if (w !== null) score.defaults.pageWidth = w;
      if (h !== null) score.defaults.pageHeight = h;
      for (const mrg of elems(plEl, "page-margins")) {
        const ty = mrg.getAttribute("type") ?? "both";
        const l = floatOf(mrg, "left-margin");
        const r = floatOf(mrg, "right-margin");
        const t = floatOf(mrg, "top-margin");
        const b = floatOf(mrg, "bottom-margin");
        if (ty === "odd" || ty === "both") {
          if (l !== null) score.defaults.leftMargin = l;
          if (r !== null) score.defaults.rightMargin = r;
          if (t !== null) score.defaults.topMargin = t;
          if (b !== null) score.defaults.bottomMargin = b;
        }
      }
    }
    // Lyric font
    const lfEl = elem(defsEl, "lyric-font");
    if (lfEl) {
      const family = lfEl.getAttribute("font-family") ?? score.defaults.lyricFont.family;
      const sz = parseFloat(lfEl.getAttribute("font-size") ?? "0") || score.defaults.lyricFont.size;
      const ptToTenths = (pt: number) => pt / score.scaling;
      score.defaults.lyricFont = new Font(family, ptToTenths(sz));
    }
    const wfEl = elem(defsEl, "word-font");
    if (wfEl) {
      const family = wfEl.getAttribute("font-family") ?? score.defaults.wordFont.family;
      const sz = parseFloat(wfEl.getAttribute("font-size") ?? "0") || score.defaults.wordFont.size;
      const ptToTenths = (pt: number) => pt / score.scaling;
      score.defaults.wordFont = new Font(family, ptToTenths(sz));
    }
  }
  if (score.scaling === 0) score.scaling = (7.0 * 72) / 25.4 / 40.0;

  // Credits
  for (const crEl of elems(root, "credit")) {
    const pid = (attrInt(crEl, "page") ?? 1) - 1;
    const cwEl = elem(crEl, "credit-words");
    const ctEl = elem(crEl, "credit-type");
    if (cwEl) {
      const justify = cwEl.getAttribute("justify") ?? "left";
      score.credits.push({
        page: pid,
        text: cwEl.textContent?.trim() ?? "",
        type: ctEl?.textContent?.trim() ?? null,
        x: attrFloat(cwEl, "default-x") ?? 0,
        y: attrFloat(cwEl, "default-y") ?? 0,
        justify: justify === "right" ? LCR.Right : justify === "center" ? LCR.Center : LCR.Left,
        fontSize: parseFloat(cwEl.getAttribute("font-size") ?? "0") || 0,
      });
    }
  }

  score.title = extractTitle(root);

  // Pre-create MeasureInfo array
  const partEls = elems(root, "part");
  const numMeasures = partEls[0] ? elems(partEls[0], "measure").length : 0;
  for (let i = 0; i < numMeasures; i++) {
    const mif = new MeasureInfo();
    mif.index = i;
    score.measures.push(mif);
  }

  // Create parts
  for (const ptEl of partEls) {
    const part = new MixedPart();
    part.score = score;
    part.pid = ptEl.getAttribute("id") ?? "";
    score.parts.push(part);
  }

  // Load per-part data
  for (let i = 0; i < partEls.length; i++) {
    const pl = new PartLoader(score.parts[i], score, partEls[i]);
    pl.load();
    pl.linkLyrics();
  }

  // Staff order
  let ord = 0;
  for (const part of score.parts) for (const st of part.staves) st.order = ord++;

  // Global measure offsets
  let tick = new Fraction(0);
  for (const mif of score.measures) {
    mif.offset = tick;
    tick = tick.plus(mif.dur);
  }

  // 跨小节对象的 startTick/endTick 必须在 mif.offset 赋值后再算：slur/tied 在
  // PartLoader 阶段解析（那时 mif.offset 还是 0），故此处用真实绝对 tick 重算，
  // 否则系统归属判定（drawSlur/drawTied 的 begin/end 比较）全错，slur/tie 会错画到
  // 第一小节。对应 musicpp mxml/loader.cpp::processSlur（在整 part 加载后统一解析）。
  for (const part of score.parts) {
    for (const sl of part.slurs) {
      sl.startTick = sl.startChord().tick();
      sl.endTick = sl.endChord().tick();
    }
    for (const t of part.tied) {
      t.startTick = t.startChord().tick();
      t.endTick = t.endChord().tick();
    }
    // ending 同理：startMeasure/endMeasure 在 PartLoader 阶段就确定，但其绝对 tick
    // 依赖 mif.offset（此处才赋值）。左反复记号 tick = 起始小节 offset，右反复记号
    // tick = 结束小节末端，对齐 musicpp parser.cpp 用 offsets[bl]+mif->offset 配对。
    for (const e of part.endings) {
      e.startTick = e.startMeasure.offset;
      e.endTick = e.endMeasure.endTick();
    }
  }

  // processJpBeam
  for (const part of score.parts) {
    for (const md of part.measures) md.processJpBeam();
  }

  // Layout pass。无内嵌版面坐标（OMR 生成谱）时自动计算小节宽度/折行/音符横向位置。
  const autoLayout = !hasEmbeddedLayout(score);
  if (autoLayout) autoLayoutHeader(score);
  const autoBreaks = autoLayout ? autoLayoutWidths(score) : undefined;
  buildSystemsAndPages(score, partEls, autoBreaks);
  applyStaffVisibility(score, partEls);
  updateLayoutByPrint(score, partEls);
  if (autoLayout) autoJustifySystems(score);
  layoutAttr(score);
  if (autoLayout) autoPlaceNotes(score);
  updateEntPos(score);
  updateDataXPos(score);

  // Part groups
  const partListEl = elem(root, "part-list");
  if (partListEl) loadPartGroups(score, partListEl);

  // Sibelius fixes（parser.cpp:2890-2895，行首调号变更偏移须在 layoutAttr/updateDataXPos 之后）
  if (score.encoder === Encoder.Sibelius) {
    for (const sys of score.systems) sys.fixSibKeyChange();
    for (const part of score.parts) part.fixTieForSib();
  }

  return score;
}
