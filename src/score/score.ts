// Ported from mp/score/score.kt.
// MusicXML import methods (Score.load / Part.load / Measure.load / Note.load /
// parse*) are intentionally omitted — that path moves to the Rust backend
// (Phase 5) which emits .jpwabc. This module is the model + the jpw/layout/
// repeat logic that has no MusicXML (JAXB) dependency.

import { Fraction } from "../common/fraction";
import { BarStyle, StartStopDiscontinue } from "./enums";

export { BarStyle, StartStopDiscontinue };

export class Credit {
  type: string | null = null;
  text = "";
  page = 0;
}

export class Time {
  beats = 4;
  beatType = 4;
  constructor(bts?: number, bt?: number) {
    if (bts !== undefined && bt !== undefined) {
      this.beats = bts;
      this.beatType = bt;
      if (![2, 4, 8, 16].includes(bt)) throw new Error("bad beatType");
    }
  }
}

export class Clef {
  sign = "";
}

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

export class Lyric {
  text = "";
  number = 0;
  refrain = false;
}

export function doPairTuplet(tupletNotes: Note[]): void {
  for (let i = 0; i < Math.floor(tupletNotes.length / 2); i++) {
    const a = tupletNotes[2 * i];
    const b = tupletNotes[2 * i + 1];
    const tup = new Tuplet(a, b);
    a.tuplet = tup;
    b.tuplet = tup;
  }
}

export class ParserTemp {
  slurStart: Chord | null = null;
  tieNotes: Note[] = [];
  tupletNotes: Note[] = [];
  constructor(public playData: PlayData) {}

  pairTuplet(): void {
    this.tupletNotes.sort((a, b) => a.absoluteTick.compareTo(b.absoluteTick));
    doPairTuplet(this.tupletNotes);
    this.tupletNotes = [];
  }

  pairTie(): void {
    const starts: Note[] = [];
    const ends: Note[] = [];
    for (const nt of this.tieNotes) {
      if (nt.tieStart) starts.push(nt);
      if (nt.tieEnd) ends.push(nt);
    }
    starts.sort((a, b) => a.absoluteTick.compareTo(b.absoluteTick));
    ends.sort((a, b) => a.absoluteTick.compareTo(b.absoluteTick));
    for (let i = 0; i < starts.length; i++) {
      const a = starts[i];
      if (i >= ends.length) break;
      const b = ends[i];
      a.tieNext = b;
      b.tiePrev = a;
    }
  }
}

export class BeamGroup {
  chords: Chord[] = [];
  add(chord: Chord): void {
    chord.beamGroup = this;
    this.chords.push(chord);
  }
}

export class Tuplet {
  constructor(
    public first: Note,
    public last: Note,
  ) {
    if (first.tupletEnd) throw new Error("");
    if (last.tupletBegin) throw new Error("");
  }
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

  static jpToStep(num: string, basePitch: number): string {
    let res = "C".charCodeAt(0) + (num.charCodeAt(0) - "1".charCodeAt(0));
    const mod = ((basePitch % 12) + 12) % 12;
    const delta: Record<number, number> = {
      0: 0, 2: 1, 3: 2, 4: 2, 5: 3, 7: 4, 8: 5, 9: 5, 10: 6, 11: 6,
    };
    if (!(mod in delta)) throw new Error("");
    res += delta[mod];
    if (res > "G".charCodeAt(0)) res -= 7;
    return String.fromCharCode(res);
  }

  static getAlter(st: string, fifths: number): number {
    const idx = MusicCommon.steps.indexOf(st);
    if (fifths < 0) {
      for (let i = fifths; i < 0; i++) {
        if (MusicCommon.fifthCircle[7 + i] === idx + 1) return -1;
      }
      return 0;
    } else if (fifths === 0) {
      return 0;
    } else {
      for (let i = 0; i < fifths; i++) {
        if (MusicCommon.fifthCircle[i] === idx + 1) return 1;
      }
      return 0;
    }
  }

  static getBasePitchOfKey(key: Key): number {
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
    res += "AB".includes(step[0]) ? 48 : 60;
    return res;
  }
}

export class AccidentalStat {
  alter: Record<string, number> = {};
  constructor(public fifths: number) {}

  update(step: string, alt: number): string | null {
    const def = MusicCommon.getAlter(step, this.fifths);
    const expect = step in this.alter ? this.alter[step] : def;
    if (expect === alt) return null;
    let res: string | null = null;
    if (step in this.alter) {
      if (def === alt) res = "n";
      else throw new Error("");
    } else {
      res = expect > alt ? "b" : "#";
    }
    if (def === alt) delete this.alter[step];
    else this.alter[step] = alt;
    return res;
  }

  reset(k: number): void {
    this.alter = {};
    this.fifths = k;
  }
}

export abstract class Entry {
  duration?: Fraction;
  position = new Fraction(0);
  constructor(public measure: Measure) {}
  get inited(): boolean {
    return this.duration !== undefined;
  }
}

export class LineBreak extends Entry {
  newPage = false;
  pass: number | null = null;
  constructor(mea: Measure) {
    super(mea);
    this.duration = new Fraction(0);
  }
}

export class BarlineEntry extends Entry {
  style: BarStyle | null = null;
  constructor(mea: Measure) {
    super(mea);
    this.duration = new Fraction(0);
  }
}

export class Chord extends Entry {
  notes: Note[] = [];
  dot = 0;
  beams = 0; // 减时线
  beats = 0; // 增时线
  voice = 0;
  stemUp = true;
  rest = false;
  beamGroup: BeamGroup | null = null;
  slurStart = false;
  slurEnd = false;
  slurEndChord: Chord | null = null;
  fermata = false;

  hasLrc(num: number): boolean {
    for (const nt of this.notes) {
      for (const lrc of nt.lyrics) {
        if (lrc.number !== num) continue;
        if (lrc.text.length > 0) return true;
      }
    }
    return false;
  }

  add(nt: Note): void {
    this.notes.push(nt);
    nt.chord = this;
  }
}

export class Note {
  lyrics: Lyric[] = [];
  pitch = 0;
  step = " ";
  alter = 0;
  octave = 0;
  rest = false;
  tieStart = false;
  tieEnd = false;
  tupletBegin = false;
  tupletEnd = false;
  jpOctave = 0;
  jpAlter = " "; // b,n,#
  number = "0";
  tieNext: Note | null = null;
  tiePrev: Note | null = null;
  tuplet: Tuplet | null = null;

  constructor(public chord: Chord) {}

  static readonly pitchMap: Record<string, number> = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
  };

  getLyric(v: number): Lyric | null {
    for (const it of this.lyrics) {
      if (it.number === v || it.refrain) return it;
    }
    return null;
  }

  get absoluteTick(): Fraction {
    const ch = this.chord;
    const res = ch.position;
    const mea = ch.measure;
    return res.plus(mea.position);
  }

  /** Derives jp number/octave/alter from MusicXML-derived step/octave/alter.
   *  Used by the MusicXML import path; the .jpwabc path sets these directly. */
  init(fifths: number, stat: AccidentalStat): void {
    const str = "CDEFGAB";
    const idx = str.indexOf(this.step);
    const wr = idx + this.octave * 7;
    let p = this.octave * 7 + idx;
    const b = (4 * fifths + 28) % 7;
    p -= b;
    this.number = "0";
    if (!this.rest) {
      this.number = String.fromCharCode("1".charCodeAt(0) + (p % 7));
    }
    this.jpAlter = stat.update(this.step, this.alter) ?? " ";
    this.jpOctave = Math.floor((wr - b) / 7) - 4;
    if (fifths === 3 || fifths === 5 || fifths === -2) this.jpOctave += 1;
  }
}

export class Measure {
  entries: Entry[] = [];
  key = new Key();
  time = new Time();
  keyChange = false;
  timeChange = false;
  newSystem = false;
  newPage = false;
  position = new Fraction(0);
  leftBarline: BarStyle | null = null;
  barline: BarStyle | null = null;
  repeatBackward = false;
  repeatForward = false;
  endingLeft = false;
  endingNum: Set<number> | null = null;
  endingRight: StartStopDiscontinue | null = null;

  constructor(public index: number) {}

  get duration(): Fraction {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e instanceof Chord) return e.position.plus(e.duration!);
    }
    throw new Error("measure has no chord");
  }

  add(chord: Chord): void {
    this.entries.push(chord);
    chord.measure = this;
  }

  autoBeamGroup(): BeamGroup[] {
    let groupLen = new Fraction(1);
    if (this.time.beatType === 8) {
      groupLen = groupLen.divInt(2);
      groupLen = groupLen.timesInt(3);
    }
    return this.autoBeamGroupLen(groupLen);
  }

  private autoBeamGroupLen(len: Fraction): BeamGroup[] {
    const res: BeamGroup[] = [new BeamGroup()];
    this.entries.sort((a, b) => a.position.compareTo(b.position));
    let curGroup: Fraction | null = null;
    for (const ent of this.entries) {
      if (!(ent instanceof Chord)) continue;
      const chord = ent;
      if (!chord.inited) throw new Error("");
      if (chord.beams === 0) continue;
      if (chord.duration!.compareTo(len) > 0) continue;
      const start = len.timesInt(chord.position.div(len).toInt());
      if (curGroup !== null) {
        if (!curGroup.equals(start)) curGroup = null;
      }
      if (curGroup === null) {
        res.push(new BeamGroup());
      }
      res[res.length - 1].add(chord);
      curGroup = start;
    }
    return res;
  }

  jp(): string {
    let res = "";
    for (const ent of this.entries) {
      if (!(ent instanceof Chord)) continue;
      const ch = ent;
      const nt = ch.notes[0];
      res += nt.number;
      for (let i = 1; i < ch.beats; i++) res += "-";
      for (let i = 1; i < ch.beams; i++) res += "/";
      res += " ";
    }
    res += "|";
    return res;
  }

  init(): void {
    this.removeUnused();
    const stat = new AccidentalStat(this.key.fifths);
    for (const ent of this.entries) {
      if (!(ent instanceof Chord)) continue;
      if (ent.rest) continue;
      for (const nt of ent.notes) nt.init(this.key.fifths, stat);
    }
  }

  private removeUnused(): void {
    const rem: Chord[] = [];
    for (const ent of this.entries) {
      if (!(ent instanceof Chord)) continue;
      const ch = ent;
      if (ch.voice > 1) {
        rem.push(ch);
        continue;
      }
      if (ch.notes.length <= 1) continue;
      let cur = -1;
      let maxPit = 0;
      const lrc: Lyric[] = [];
      ch.notes.forEach((nt, i) => {
        const p = nt.pitch;
        if (p > maxPit) {
          cur = i;
          maxPit = p;
        }
        lrc.push(...nt.lyrics);
      });
      const v = ch.notes[cur];
      v.lyrics = [];
      v.lyrics.push(...lrc);
      ch.notes = [v];
    }
    this.entries = this.entries.filter((e) => !(e instanceof Chord && rem.includes(e)));
  }

  parseEndingNum(s: string | null): Set<number> | null {
    if (s === null) return null;
    const res = new Set<number>();
    for (const it of s.split(",")) {
      const t = it.trim();
      if (t.length === 0) continue;
      res.add(parseInt(t, 10));
    }
    return res;
  }

  lrc(num: number): string {
    let res = "";
    for (const ent of this.entries) {
      if (!(ent instanceof Chord)) continue;
      for (const nt of ent.notes) {
        for (const lrc of nt.lyrics) {
          if (lrc.number !== num) continue;
          res += lrc.text;
        }
      }
    }
    return res;
  }

  lineBreak(pg: boolean): void {
    const lb = new LineBreak(this);
    lb.newPage = pg;
    this.entries.push(lb);
  }
}

export class Part {
  measures: Measure[] = [];

  jp(): string {
    let res = "";
    for (const m of this.measures) res += m.jp();
    return res;
  }

  getVerseCount(beg: number, end: number): number {
    const num = new Set<number>();
    this.measures.forEach((m, idx) => {
      if (idx < beg || idx >= end) return;
      for (const ent of m.entries) {
        if (!(ent instanceof Chord)) continue;
        for (const n of ent.notes) for (const l of n.lyrics) num.add(l.number);
      }
    });
    return num.size;
  }
}

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

export class PlayData {
  coda = new Map<string, TimePosition>();
  segno = new Map<string, TimePosition>();
  jumpTo = new Map<TimePosition, JumpSpec>();
  measures: PlayItem[] = [];
  hasRepeat = false;
  isSimpple = false; // no repeat, only multiple verse

  get noRepeat(): boolean {
    if (this.hasRepeat) return false;
    if (this.coda.size > 0 || this.segno.size > 0) return false;
    if (this.jumpTo.size > 0) return false;
    return true;
  }
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
  clone(): PlayItem {
    const p = new PlayItem();
    p.mid = this.mid;
    p.pass = this.pass;
    p.offset = this.offset;
    p.end = this.end;
    p.endOfPass = this.endOfPass;
    return p;
  }
}

export enum EndingType {
  None,
  Start,
  Discontinue,
}

export class Score {
  parts: Part[] = [];
  composer = "";
  lyricist = "";
  creator = new Map<string, string>();
  credit: Credit[] = [];
  title = "";
  playData = new PlayData();

  clearSystemBreak(): void {
    for (const p of this.parts) {
      for (const m of p.measures) {
        m.newPage = false;
        m.newSystem = false;
        m.entries = m.entries.filter((e) => !(e instanceof LineBreak));
      }
    }
  }

  doRepeat(repeat: RepeatSpec): void {
    for (const it of repeat.items) {
      const pit = new PlayItem();
      pit.mid = it.first;
      pit.end = it.last + 1;
      pit.pass = it.verse;
      this.playData.measures.push(pit);
    }
  }

  parseRepeatInf(): void {
    const rep = new RepeatProcessor(this);
    const pos = new TimePosition();
    pos.pass = 1;
    const measures = this.parts[0].measures;
    while (pos.mid < measures.length) {
      const end = rep.process(pos);
      if (end) break;
      if (pos.pass > 10) break;
      if (rep.result.length > 20) break;
    }
    let repeatByVerse = true;
    for (const m of rep.result) {
      const mea = measures[m.end - 1];
      let repStart = m.mid;
      for (let mid = m.mid; mid < m.end; mid++) {
        if (measures[mid].repeatForward) repStart = mid;
      }
      if (!mea.repeatBackward) continue;
      const verseCnt = rep.getPassCountByLrc(repStart, m.end);
      if (verseCnt > 1) repeatByVerse = false;
    }
    this.playData.isSimpple = rep.result.length === 1;
    if (repeatByVerse) rep.repeatByLyric();
    this.playData.measures = [];
    this.playData.measures.push(...rep.result);
    for (const m of measures) {
      if (m.repeatBackward) this.playData.hasRepeat = true;
    }
  }

  jp(): string {
    return this.parts[0].jp();
  }

  lrc(num: number): string {
    let res = "";
    for (const p of this.parts) for (const m of p.measures) res += m.lrc(num);
    return res;
  }
}

export class RepeatProcessor {
  inEnding = false;
  endingActive = false;
  loopStart = 0;
  passCount = -1;
  inJump = false;
  result: PlayItem[] = [];

  constructor(public score: Score) {}

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

  play(m: TimePosition): boolean {
    const p0 = this.score.parts[0];
    const mid = m.mid;
    const mea = p0.measures[mid];
    const tbeg = new TimePosition(mid, new Fraction(0));
    const tend = new TimePosition(mid, mea.duration);
    let res = false;
    let seg: string | null = null;
    let tocoda: string | null = null;
    let dacapo = false;
    for (const [t, v] of this.score.playData.jumpTo) {
      if (t.compareTo(tbeg) < 0) continue;
      if (t.compareTo(tend) > 0) continue;
      if (!this.inJump && v.kind === PlaySpecKind.DalSegno) seg = v.value as string;
      if (v.kind === PlaySpecKind.Dacapo) dacapo = true;
      if (this.inJump && v.kind === PlaySpecKind.ToCoda) tocoda = v.value as string;
      if (this.inJump && v.kind === PlaySpecKind.Fine) res = true;
    }
    let newItem = false;
    if (this.result.length === 0) {
      newItem = true;
    } else {
      const last = this.result[this.result.length - 1];
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
    const pd = this.score.playData;
    if (seg !== null) {
      let t = pd.segno.get(seg);
      if (t === undefined) t = new TimePosition(parseInt(seg, 10) - 1, new Fraction(0));
      this.doJump(m, t);
    }
    if (tocoda !== null) {
      let t = pd.coda.get(tocoda);
      if (t === undefined) t = new TimePosition(parseInt(tocoda, 10) - 1, new Fraction(0));
      this.doJump(m, t);
      this.inJump = false;
    }
    if (dacapo) {
      m.pass++;
      m.mid = -1;
      this.inJump = true;
    }
    return res;
  }

  private getPassCountByEnding(mid: number): number {
    let res = 0;
    const meas = this.score.parts[0].measures;
    let idx = mid;
    while (idx < meas.length) {
      const mif = meas[idx++];
      const nums = mif.endingNum;
      if (!nums) continue;
      for (const n of nums) if (n > res) res = n;
      if (mif.endingRight === StartStopDiscontinue.DISCONTINUE) break;
    }
    return res;
  }

  private onStartEnding(mif: Measure, pass: number): void {
    if (this.inJump) return;
    this.inEnding = true;
    this.endingActive = mif.endingNum?.has(pass) === true;
  }

  private onRightEnding(m: TimePosition, dist: boolean): void {
    if (this.inJump) return;
    this.endingActive = false;
    this.inEnding = false;
    if (dist) {
      m.pass = 1;
      this.passCount = -1;
    }
  }

  onForward(mid: number, pass: number): void {
    if (this.inJump) return;
    if (pass > 1) return;
    this.loopStart = mid;
  }

  onBackward(m: TimePosition, mif: Measure): void {
    if (this.inJump) return;
    if (m.pass < this.passCount) {
      m.mid = this.loopStart;
      m.pass++;
    } else {
      m.mid++;
      if (mif.endingRight === null) m.pass = 1;
    }
  }

  update(m: TimePosition): boolean {
    let active = true;
    if (this.inEnding) active = this.endingActive;
    if (active) return this.play(m);
    return false;
  }

  private getPassCountByLrcAll(): number {
    const meas = this.score.parts[0].measures;
    return this.getPassCountByLrc(0, meas.length);
  }

  getPassCountByLrc(beg: number, end: number): number {
    return this.score.parts[0].getVerseCount(beg, end);
  }

  process(m: TimePosition): boolean {
    const p0 = this.score.parts[0];
    if (m.mid < 0) throw new Error("");
    const mif = p0.measures[m.mid];
    if (mif.endingLeft) {
      if (this.passCount < 0) this.passCount = this.getPassCountByEnding(m.mid);
      this.onStartEnding(mif, m.pass);
    }
    if (mif.repeatForward) this.onForward(m.mid, m.pass);
    const fine = this.update(m);
    if (fine) return true;
    if (mif.endingRight !== null) {
      this.onRightEnding(m, mif.endingRight === StartStopDiscontinue.DISCONTINUE);
    }
    if (!this.inJump && mif.repeatBackward) {
      if (this.passCount < 0) {
        const beg = this.result[this.result.length - 1].mid;
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
        const it = this.result[idx].clone();
        it.pass = cur;
        this.result.push(it);
      }
      this.result[this.result.length - 1].endOfPass = true;
    }
    return true;
  }
}

export class RepeatSpecItem {
  constructor(
    public first: number,
    public last: number,
    public verse: number,
  ) {}
  toString(): string {
    return `${this.first}-${this.last}V${this.verse}`;
  }
}

export class RepeatSpec {
  items: RepeatSpecItem[] = [];
  constructor(s: string) {
    for (const it of s.split("\n")) {
      const arr = it.split("V");
      const v = parseInt(arr[1], 10);
      const rng = arr[0].split("-");
      const first = parseInt(rng[0], 10) - 1;
      const last = parseInt(rng[rng.length - 1], 10) - 1;
      this.items.push(new RepeatSpecItem(first, last, v));
    }
  }
}
