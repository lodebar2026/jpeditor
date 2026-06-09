// Ported from mp/layout/layout.kt. Pure model + geometry; SVG emission lives in
// painter.ts. Skija Path/Canvas/Font replaced by GraphicPath command lists,
// the common geom types, and the Font abstraction (measurement via SVG/canvas).

import { Fraction } from "../common/fraction";
import { Point, Rect, Matrix33, newMatrix, Colors } from "../common/geom";
import { pathTightBounds } from "../common/measure";
import { Font } from "./font";
import { MetaData, GlyphCodes } from "../smufl/smufl";
import * as S from "../score/score";

function getOrNull<T>(arr: T[], i: number): T | null {
  return i >= 0 && i < arr.length ? arr[i] : null;
}

export function pointRotate(p: Point, cos: number, sin: number): Point {
  return p.rotate(cos, sin);
}

// ---------------- PageItem hierarchy ----------------

export class PageItem {
  parent: PageItem | null = null;
  children: PageItem[] = [];
  _width = 0;
  _height = 0;
  matrix: Matrix33 = newMatrix();
  classes = new Set<string>();
  data: unknown = null;
  _selected = false;
  selectable = false;

  get selected(): boolean {
    return this._selected;
  }
  set selected(v: boolean) {
    this._selected = v;
  }

  get bound(): Rect {
    return new Rect(0, 0, this.width, this.height);
  }

  changeColor(clr: number): void {
    for (const it of this.children) it.changeColor(clr);
    if (this instanceof TextFrame) {
      this.color = clr;
    } else if (this instanceof GraphicLine) {
      this.strokeColor = clr;
    } else if (this instanceof GraphicPath) {
      if (this.stroke) this.strokeColor = clr;
      if (this.fill) this.fillColor = clr;
    }
  }

  pos(root: PageItem | null): Point {
    let loc = new Point(this.x, this.y);
    if (this.parent === root) return loc;
    const pp = this.parent!.pos(root);
    loc = loc.offset(pp);
    return loc;
  }

  get x(): number {
    return this.matrix.translateX;
  }
  set x(v: number) {
    this.matrix.translateX = v;
  }
  get y(): number {
    return this.matrix.translateY;
  }
  set y(v: number) {
    this.matrix.translateY = v;
  }
  get width(): number {
    return this._width;
  }
  set width(v: number) {
    this._width = v;
  }
  get height(): number {
    return this._height;
  }
  set height(v: number) {
    this._height = v;
  }

  get childrenBound(): Rect {
    let r = new Rect();
    for (const ch of this.children) {
      let rr = ch instanceof Group ? ch.childrenBound : ch.bound;
      rr = rr.offset(ch.x, ch.y);
      r = r.union(rr);
    }
    return r;
  }

  update(): void {
    let r = new Rect();
    for (const ch of this.children) {
      ch.update();
      let rr1 = ch.bound;
      rr1 = rr1.offset(ch.x, ch.y);
      r = r.union(rr1);
    }
    this.width = r.right;
    this.height = r.bottom;
  }

  add(pageItem: PageItem): void {
    this.children.push(pageItem);
    pageItem.parent = this;
  }
}

export type PathSeg = { op: "M" | "L" | "C" | "Z"; pts: number[] };

export class GraphicPath extends PageItem {
  segs: PathSeg[] = [];
  strokeWidth = 1;
  strokeColor = 0;
  fillColor = 0;
  stroke = false;
  fill = false;

  get d(): string {
    let s = "";
    for (const seg of this.segs) {
      if (seg.op === "Z") s += "Z";
      else s += `${seg.op}${seg.pts.join(" ")} `;
    }
    return s.trim();
  }

  override update(): void {
    const bnd = this.computeTightBounds();
    this.width = bnd.width;
    this.height = bnd.height;
    this.x += bnd.left;
    this.y += bnd.top;
    this.offset(-bnd.left, -bnd.top);
  }

  offset(dx: number, dy: number): void {
    for (const seg of this.segs) {
      for (let i = 0; i < seg.pts.length; i += 2) {
        seg.pts[i] += dx;
        seg.pts[i + 1] += dy;
      }
    }
  }
  moveTo(x: number | Point, y = 0): void {
    if (x instanceof Point) this.segs.push({ op: "M", pts: [x.x, x.y] });
    else this.segs.push({ op: "M", pts: [x, y] });
  }
  lineTo(x: number | Point, y = 0): void {
    if (x instanceof Point) this.segs.push({ op: "L", pts: [x.x, x.y] });
    else this.segs.push({ op: "L", pts: [x, y] });
  }
  cubicTo(p1: Point, p2: Point, p3: Point): void;
  cubicTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
  cubicTo(
    a: number | Point,
    b?: number | Point,
    c?: number | Point,
    d?: number,
    e?: number,
    f?: number,
  ): void {
    if (a instanceof Point) {
      const p1 = a, p2 = b as Point, p3 = c as Point;
      this.segs.push({ op: "C", pts: [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y] });
    } else {
      this.segs.push({ op: "C", pts: [a, b as number, c as number, d!, e!, f!] });
    }
  }
  computeTightBounds(): Rect {
    if (this.segs.length === 0) return new Rect();
    return pathTightBounds(this.d);
  }
  close(): void {
    this.segs.push({ op: "Z", pts: [] });
  }
}

export class Group extends PageItem {
  get minY(): number | null {
    if (this.children.length === 0) return null;
    return this.children.reduce((m, c) => (c.y < m.y ? c : m)).y;
  }
  get minX(): number | null {
    if (this.children.length === 0) return null;
    return this.children.reduce((m, c) => (c.x < m.x ? c : m)).x;
  }
  get maxX(): number | null {
    if (this.children.length === 0) return null;
    const it = this.children.reduce((m, c) => (c.x + c.width > m.x + m.width ? c : m));
    return it.x + it.width;
  }
  get maxY(): number | null {
    if (this.children.length === 0) return null;
    const it = this.children.reduce((m, c) => (c.y + c.height > m.y + m.height ? c : m));
    return it.y + it.height;
  }

  normalizeX(): void {
    if (this.children.length === 0) return;
    const mx = this.minX!;
    for (const it of this.children) it.x -= mx;
    this.x += mx;
  }
  normalizeY(): void {
    if (this.children.length === 0) return;
    const mx = this.minY!;
    for (const it of this.children) it.y -= mx;
    this.y += mx;
  }

  override update(): void {
    for (const it of this.children) it.update();
    const bnd = this.childrenBound;
    for (const it of this.children) {
      it.x -= bnd.left;
      it.y -= bnd.top;
    }
    this.x += bnd.left;
    this.y += bnd.top;
    this.width = bnd.width;
    this.height = bnd.height;
  }
}

export class TextFrame extends PageItem {
  text = "";
  color = Colors.black;
  font!: Font;
  previous: TextFrame | null = null;
  next: TextFrame | null = null;

  measureText(beg = 0, len = -1): number {
    const str = len < 0 ? this.text.substring(beg) : this.text.substring(beg, beg + len);
    return this.font.measureText(str);
  }

  override get bound(): Rect {
    const fm = this.font.metrics;
    return new Rect(0, fm.ascent, this.width, fm.descent);
  }

  override update(): void {
    this.width = this.measureText();
    this.height = this.font.size;
  }
}

export class GraphicLine extends PageItem {
  p0 = new Point();
  p1 = new Point();
  strokeWidth = 1;
  strokeColor = 0;

  override update(): void {
    this.y += this.p0.y;
    this.x += this.p0.x;
    this.p1 = this.p1.offset(-this.p0.x, -this.p0.y);
    this.p0 = new Point(0, 0);
    this.width = Math.abs(this.p1.x);
    this.height = Math.abs(this.p1.y);
    if (this.p0.x === this.p1.x) this.width = this.strokeWidth;
    if (this.p0.y === this.p1.y) this.height = this.strokeWidth;
  }
}

export class SmuflText extends TextFrame {
  asPath = false;
  meta: MetaData;
  constructor(options: LayoutOptions) {
    super();
    this.meta = options.smuflMeta;
    this.font = options.smuflFont;
  }
  override get bound(): Rect {
    const first = this.text[0];
    const box = this.meta.getBBox(first);
    if (!box) throw new Error("no smufl bbox");
    const dy1 = (box.bBoxNE[1] * this.font.size) / 4;
    const dy2 = (box.bBoxSW[1] * this.font.size) / 4;
    const l = (box.bBoxSW[0] * this.font.size) / 4;
    const r = (box.bBoxNE[0] * this.font.size) / 4;
    return new Rect(l, dy2, r, dy1);
  }
}

export class JpOctaveDot extends TextFrame {
  constructor() {
    super();
    this.text = ".";
    this.selectable = true;
  }
  override get bound(): Rect {
    const bnd = LayoutOptions.charBound(this.font, this.text[0]);
    return new Rect(0, bnd.top, this.width, bnd.bottom);
  }
}

export class JpNumber extends TextFrame {
  constructor() {
    super();
    this.selectable = true;
  }
  get left(): number {
    return this.measureText(0, 1) / 2;
  }
  get right(): number {
    return this.measureText(0, 1) / 2 + this.measureText(1);
  }
  get cx(): number {
    return this.measureText(0, 1) / 2;
  }
  get numberPos(): number {
    let end = this.text.length;
    if (this.text.endsWith("·")) end--;
    return this.measureText(0, end);
  }
  override get bound(): Rect {
    const bnd = LayoutOptions.charBound(this.font, this.text[0]);
    return new Rect(0, bnd.top, this.width, bnd.bottom);
  }
}

export class Lyric extends TextFrame {
  _widths = [0, 0, 0];
  constructor() {
    super();
    this.selectable = true;
  }
  get left(): number {
    return this._widths[0] + this._widths[1] / 2;
  }
  get right(): number {
    return this._widths[1] / 2 + this._widths[2];
  }
  override update(): void {
    let sl = "", sc = "", sr = "";
    if (this.text.length === 1) {
      sc = this.text;
    } else {
      const punct = "1234567890.,;'\"!?。：，；！？“”｡､";
      let pos = 0;
      while (pos < this.text.length) {
        const c = this.text[pos];
        if (punct.includes(c)) sl += c;
        else break;
        pos++;
      }
      while (pos < this.text.length) {
        const c = this.text[pos];
        if (!punct.includes(c)) sc += c;
        else break;
        pos++;
      }
      sr = this.text.substring(pos);
    }
    this._widths[0] = this.measureText(0, sl.length);
    this._widths[1] = this.measureText(sl.length, sc.length);
    this._widths[2] = this.measureText(sl.length + sc.length, sr.length);
    this.width = this._widths[0] + this._widths[1] + this._widths[2];
    this.height = this.font.size;
  }
}

export abstract class SlurTieBase extends Group {
  static calcSlurPoints(pl: Point, pr: Point): [Point, Point, number] {
    const xr = pr.x, xl = pl.x, yr = pr.y, yl = pl.y;
    const dx = xr - xl, dy = yr - yl;
    const square = dx * dx + dy * dy;
    const dist = Math.sqrt(square);
    const theta = Math.atan2(dy, dx);
    const cos = Math.cos(-theta);
    const sin = Math.sin(-theta);
    const xlen = Math.min(dist * 0.04 + 10, dist * 0.25);
    let h = Math.log10(dist) * 17 - 16;
    h *= -1;
    let p1 = new Point(xlen, h).rotate(cos, sin);
    let p2 = new Point(dist - xlen, h).rotate(cos, sin);
    p1 = p1.offset(xl, yl);
    p2 = p2.offset(xl, yl);
    return [p1, p2, cos];
  }

  init(pl: Point, pr: Point, thickness: number, clr: number): void {
    let [pt0, pt1, cos] = SlurTieBase.calcSlurPoints(pl, pr);
    const lw0 = thickness / cos;

    // (the "line" object is computed but not added in the original; skipped)

    const obj = new GraphicPath();
    obj.fill = true;
    obj.stroke = true;
    obj.strokeWidth = 1.0;
    obj.strokeColor = clr;
    obj.fillColor = clr;
    obj.moveTo(pl);
    obj.cubicTo(pt0, pt1, pr);
    pt0 = pt0.offset(lw0 / 2, 0);
    pt1 = pt1.offset(0, lw0 / 2);
    obj.cubicTo(pt1, pt0, pl);
    obj.close();

    const box = obj.computeTightBounds();
    obj.offset(-box.left, -box.top);
    obj.x = 0;
    obj.y = 0;
    obj.width = box.width;
    obj.height = box.height;

    this.add(obj);
    this.x = box.left;
    this.y = box.top;
    this.width = box.width;
    this.height = box.height;
  }
}
export class Tie extends SlurTieBase {}
export class Slur extends SlurTieBase {}

// ---------------- Entry hierarchy ----------------

export abstract class Entry {
  group = new Group();
  selected = false;
  line!: Line;
  constructor() {
    this.group.classes.add("entry");
  }
  update(): void {
    this.group.update();
  }
  abstract entryItem(): PageItem | null;
  entryWidth(): number {
    return this.entryItem()?.width ?? 0;
  }
}

export class KeySig extends Entry {
  constructor(key: S.Key, opt: LayoutOptions) {
    super();
    const names = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
    const name = names[key.fifths + 7];
    const tf = new TextFrame();
    tf.color = opt.color;
    tf.y = -opt.numberSize;
    tf.text = `转1=${name}`;
    tf.font = opt.lrcFont.scaled(0.6);
    const w = tf.measureText();
    tf.x = -w / 2;
    this.group.add(tf);
    this.group.data = this;
  }
  entryItem(): PageItem | null {
    return null;
  }
  override entryWidth(): number {
    return 0;
  }
}

export class TimeSig extends Entry {
  hline!: GraphicLine;
  width = 0;
  beats: number;
  beatType: number;
  constructor(beats: number, beatType: number, opt: LayoutOptions) {
    super();
    this.beats = beats;
    this.beatType = beatType;
    this.layout(opt);
    this.group.data = this;
  }
  static fromTime(t: S.Time, opt: LayoutOptions): TimeSig {
    return new TimeSig(t.beats, t.beatType, opt);
  }
  entryItem(): PageItem | null {
    return this.hline;
  }
  override entryWidth(): number {
    return this.width;
  }
  layout(opt: LayoutOptions): void {
    const top = (-opt.numberSize * 23) / 28;
    const bot = (opt.numberSize * 5) / 28;
    const cy = (bot + top) / 2;
    const font = opt.numberFont.withBold().makeWithSize(opt.numberSize * 0.75);
    const tf1 = new TextFrame();
    tf1.color = opt.color;
    tf1.font = font;
    tf1.text = String(this.beats);
    const w1 = tf1.measureText();
    const tf2 = new TextFrame();
    tf2.font = font;
    tf2.color = opt.color;
    tf2.text = String(this.beatType);
    const w2 = tf2.measureText();
    this.width = Math.max(w1, w2);
    const ln = new GraphicLine();
    ln.strokeWidth = 1.5;
    ln.strokeColor = opt.color;
    const y = cy - ln.strokeWidth / 2;
    ln.p0 = new Point(0, y);
    ln.p1 = new Point(this.width, y);
    tf1.y = y - opt.numberSize * 0.1;
    tf1.x = (this.width - w1) / 2;
    tf2.y = y + opt.numberSize * 0.625;
    tf2.x = (this.width - w2) / 2;
    this.hline = ln;
    this.group.add(tf1);
    this.group.add(tf2);
    this.group.add(ln);
  }
}

export class NoteEntry extends Entry {
  chord!: S.Chord;
  lrc: Lyric | null = null;
  number: JpNumber | null = null;
  accidental: TextFrame | null = null;
  beams = 0;
  octaveDot: JpOctaveDot[] = [];
  notations: SmuflText[] = [];

  constructor() {
    super();
    this.group.data = this;
  }
  get jpOctave(): number {
    return this.chord.notes[0].jpOctave;
  }
  get numberPos(): number {
    return this.number!.numberPos;
  }
  addAccidental(tf: TextFrame): void {
    this.accidental = tf;
    this.group.add(tf);
  }
  add(item: JpNumber | Lyric): void {
    if (item instanceof JpNumber) {
      this.number = item;
      this.group.add(item);
    } else {
      this.lrc = item;
      this.group.add(item);
    }
  }
  get left(): number {
    return this.number !== null ? this.number.left : 0;
  }
  get cx(): number {
    return this.number!.x + this.number!.cx;
  }
  get right(): number {
    return this.number?.right ?? 0;
  }
  entryItem(): TextFrame | null {
    return this.number;
  }
  get beginOfSlurTied(): boolean {
    if (this.chord.slurStart) return true;
    if (this.chord.notes[0].tieStart) return true;
    return false;
  }
  get endOfSlurTied(): boolean {
    if (this.chord.slurEnd) return true;
    if (this.chord.notes[0].tieEnd) return true;
    return false;
  }
  entryTop(opt: LayoutOptions): number {
    const nt = this.chord.notes[0];
    const bnd = opt.numberBound("1");
    const dotBnd = opt.numberBound(".");
    let ypos = bnd.top;
    if (nt.jpOctave > 0) {
      ypos -= (nt.jpOctave + 0.5) * dotBnd.height * 1.5;
    }
    return ypos - opt.numberSize / 8;
  }
  entryBottom(options: LayoutOptions): number {
    const oct = this.chord.notes[0].jpOctave;
    let y = this.chord.beams * options.jpBeamDist;
    if (oct < 0) {
      const numSize = options.numberFont.size;
      y += numSize * ((-oct - 1) * 0.175 + 0.25);
      y += numSize / 4;
    }
    return y;
  }

  static addAccidental(it: JpNumber, options: LayoutOptions, ch: S.Chord, ent: NoteEntry): void {
    const alt = ch.notes[0].jpAlter;
    if (alt !== " ") {
      const tf = new SmuflText(options);
      tf.color = options.color;
      if (options.smuflAsPath) tf.asPath = true;
      let smufl: string;
      switch (alt) {
        case "b": smufl = GlyphCodes.accidentalFlat; break;
        case "#": smufl = GlyphCodes.accidentalSharp; break;
        case "n": smufl = GlyphCodes.accidentalNatural; break;
        default: throw new Error("");
      }
      const yOffset = alt === "b" ? 0.1 : 0; // 简谱中降号下移
      tf.text = smufl;
      const kernMap: Record<string, number> = { "4": 0.1, "2": -0.07, "1": -0.07 };
      let xx = -tf.font.size * 0.2;
      xx += (kernMap[it.text[0]] ?? 0) * tf.font.size;
      const numBnd = options.numberBound("1");
      let yy = numBnd.top;
      yy += options.smuflFont.size * yOffset;
      const sc = 0.8;
      tf.matrix.setAffine([sc, 0, 0, sc, xx * sc, yy]);
      ent.addAccidental(tf);
    }
  }
  static octaveDot(ch: S.Chord, options: LayoutOptions, ent: NoteEntry): void {
    const oct = ch.notes[0].jpOctave;
    const numBound = options.numberBound("1");
    const dotBound = options.numberBound(".");
    for (let d = 0; d < Math.abs(oct); d++) {
      const tf = new JpOctaveDot();
      tf.font = options.numberFont;
      tf.color = options.color;
      const numSize = options.numberFont.size;
      if (oct >= 0) {
        tf.y = numBound.top - (d + 0.5) * dotBound.height * 1.5;
      } else {
        tf.y = numSize * (d * 0.175 + 0.25);
        tf.y += ch.beams * options.jpBeamDist;
      }
      ent.group.add(tf);
      ent.octaveDot.push(tf);
    }
  }
  static addLyric(ch: S.Chord, options: LayoutOptions, ent: NoteEntry, it: JpNumber, lrc: number): void {
    for (const l of ch.notes[0].lyrics) {
      if (!l.refrain) {
        if (l.number !== lrc) continue;
      }
      let text = l.text;
      if (options.ignoreVerseNumber) {
        for (let idx = 0; idx < l.text.length; idx++) {
          const _ch = l.text[idx];
          if ((_ch >= "0" && _ch <= "9") || _ch === ".") {
            // skip leading verse number/dot
          } else {
            text = l.text.substring(idx);
            break;
          }
        }
      }
      const lit = new Lyric();
      lit.font = options.lrcFont;
      lit.y = 1.0 * options.numberFont.size;
      lit.text = options.halfWidthPunct ? CJKUtil.toHalfWidth(text) : text;
      lit.color = options.color;
      lit.update();
      lit.x = it.left - lit.left;
      ent.add(lit);
    }
  }
  static addNotations(ch: S.Chord, options: LayoutOptions, ent: NoteEntry): void {
    if (ch.fermata) {
      const t = new SmuflText(options);
      t.color = options.color;
      t.text = GlyphCodes.fermataAbove;
      t.y = ent.entryTop(options);
      const hasSlurTied = ent.beginOfSlurTied || ent.endOfSlurTied;
      if (hasSlurTied) t.y -= options.smuflFont.size / 4;
      t.x += ent.numberPos / 2;
      t.x -= t.bound.width / 2;
      ent.group.add(t);
      ent.notations.push(t);
    }
  }
  static fromChord(res: Entry[], ch: S.Chord, lrc: number, options: LayoutOptions): void {
    let ent = new NoteEntry();
    ent.beams = ch.beams;
    ent.chord = ch;
    let it = new JpNumber();
    it.color = options.color;
    it.text = ch.notes[0].number;
    it.font = options.numberFont;
    ent.add(it);
    NoteEntry.addAccidental(it, options, ch, ent);
    if (ch.beats <= 1) {
      for (let d = 0; d < ch.dot; d++) it.text += "·";
    }
    NoteEntry.octaveDot(ch, options, ent);
    NoteEntry.addLyric(ch, options, ent, it, lrc);
    NoteEntry.addNotations(ch, options, ent);
    ent.update();
    res.push(ent);
    for (let i = 1; i < ch.beats; i++) {
      ent = new NoteEntry();
      ent.chord = ch;
      const num = ch.rest ? "0" : "-";
      it = new JpNumber();
      it.text = num;
      it.color = options.color;
      it.font = options.numberFont;
      ent.add(it);
      ent.update();
      res.push(ent);
    }
  }
}

export class Barline extends Entry {
  constructor(final: boolean, opt: LayoutOptions) {
    super();
    this.group.data = this;
    const top = (-opt.numberSize * 23) / 28;
    const bot = (opt.numberSize * 5) / 28;
    const heavyWidth = 3.5;
    const res = this.group;
    const widths = [1.5];
    if (final) widths.push(heavyWidth);
    const dist = heavyWidth;
    let xpos = 0;
    for (const w of widths) {
      const l = new GraphicLine();
      l.strokeColor = opt.color;
      l.x = xpos + w / 2;
      l.p0 = new Point(0, top);
      l.p1 = new Point(0, bot);
      l.strokeWidth = w;
      xpos += w + dist;
      res.add(l);
    }
    res.update();
  }
  entryItem(): PageItem | null {
    return this.group.children[0];
  }
}

export class LineBreak extends Entry {
  newPage = false;
  constructor() {
    super();
    this.group.width = 0;
    this.group.height = 0;
    this.group.data = this;
  }
  entryItem(): PageItem | null {
    return null;
  }
}

export class BeamLine extends GraphicLine {
  level = 0;
  left: NoteEntry | null = null;
  right: NoteEntry | null = null;
  constructor(lev: number, l: NoteEntry, r: NoteEntry, opt: LayoutOptions) {
    super();
    this.selectable = true;
    this.level = lev;
    this.left = l;
    this.right = r;
    const grp = l.line.group;
    this.p0 = l.entryItem()!.pos(grp);
    this.p1 = r.entryItem()!.pos(grp);
    this.p1 = this.p1.offset(r.numberPos, 0);
    this.p0 = new Point(this.p0.x, opt.jpBeamDist * lev);
    this.p1 = new Point(this.p1.x, opt.jpBeamDist * lev);
    this.strokeWidth = 1.25;
    this.strokeColor = opt.color;
    this.x = this.p0.x;
    this.p1 = this.p1.offset(-this.p0.x, 0);
    this.p0 = new Point(0, this.p0.y);
  }
}

// ---------------- Line / layout ----------------

class EntryItemInfo {
  dist = 0;
  rate = 0;
  entry: Entry | null = null;
}

class Page {
  lines: Line[] = [];
}

export class Line {
  group = new Group();
  entries: Entry[] = [];
  beams: BeamLine[] = [];
  maxBeamLevel = 0;
  chordEntry = new Map<S.Chord, NoteEntry>();

  private addEntry(e: Entry): void {
    if (e instanceof NoteEntry) {
      if (e.number?.text === "-") {
        // beat-extension dash: not a chord anchor
      } else {
        this.chordEntry.set(e.chord, e);
      }
    }
    this.entries.push(e);
    this.group.add(e.group);
    e.line = this;
  }

  private entryX(e: Entry): number {
    let res = e.group.x;
    const it = e.entryItem();
    if (it === null) return res;
    res += it.x;
    return res;
  }

  private adjust(width: number, maxHorizontalScale: number): void {
    const infos: EntryItemInfo[] = [];
    let idx = 0;
    for (const e of this.entries) {
      const next = getOrNull(this.entries, idx + 1);
      if (next === null) break;
      if (next instanceof LineBreak) break;
      const xx = this.entryX(e);
      const xxNext = this.entryX(next);
      const dist = xxNext - xx - e.entryWidth();
      if (dist < -1) throw new Error("neg dist");
      const smallDist = e instanceof NoteEntry && !(next instanceof Barline);
      const it = new EntryItemInfo();
      it.entry = e;
      it.dist = dist;
      it.rate = smallDist ? 2 : 1;
      if (next instanceof TimeSig) it.rate = 0.1;
      infos.push(it);
      idx++;
      if (idx === this.entries.length - 1) break;
    }
    infos.sort((a, b) => {
      const diff = a.dist * b.rate - b.dist * a.rate;
      if (diff < 0) return -1;
      else if (diff === 0) return a.rate < b.rate ? -1 : a.rate > b.rate ? 1 : 0;
      else return 1;
    });

    let right = 0;
    let lastVisible: Entry | null = null;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!(e instanceof LineBreak)) {
        if (lastVisible === null) lastVisible = e;
      }
      const r = e.group.x + e.group.childrenBound.right;
      if (r > right) right = r;
      if (e instanceof NoteEntry) {
        if (e.lrc !== null) break;
      }
    }
    let extra = width - right;
    const maxExtra = maxHorizontalScale * right;
    let dontMoveLastBarline = false;
    if (extra > maxExtra) {
      extra = maxExtra;
      dontMoveLastBarline = true;
      console.error("space too large!");
    }

    let totalDist = 0;
    let totalRate = 0;
    let end = 0;
    let share = 0;
    for (let i = 0; i <= infos.length; i++) {
      end = i;
      if (i === infos.length) break;
      const it = infos[i];
      const curShare = it.dist / it.rate;
      share = (extra + totalDist + it.dist) / (totalRate + it.rate);
      if (share < curShare) break;
      totalDist += it.dist;
      totalRate += it.rate;
    }
    share = (extra + totalDist) / totalRate;

    const offsets = new Map<Entry, number>();
    for (let i = 0; i < end; i++) {
      const it = infos[i];
      const dist = share * it.rate;
      offsets.set(it.entry!, dist - it.dist);
    }
    let offset = 0;
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        for (const dot of e.octaveDot) {
          dot.x = e.number!.x + e.number!.cx - dot.width / 2;
        }
      }
      e.group.x += offset;
      if (offsets.has(e)) offset += offsets.get(e)!;
    }
    if (!dontMoveLastBarline) this.adjustLastBarline(lastVisible, width);
  }

  private adjustLastBarline(lastVisible: Entry | null, width: number): void {
    if (!(lastVisible instanceof Barline)) return;
    const prev = this.entries.indexOf(lastVisible) - 1;
    const prevEnt = getOrNull(this.entries, prev);
    if (!(prevEnt instanceof NoteEntry)) return;
    const dx = lastVisible.group.x - (prevEnt.group.x + prevEnt.number!.right);
    const maxDx = prevEnt.number!.font.size * 3;
    const space = width - lastVisible.group.bound.right - lastVisible.group.x;
    if (space > 0) lastVisible.group.x += Math.min(space, maxDx - dx);
  }

  private calcXPos(): void {
    for (const e of this.entries) e.group.normalizeX();
    let curX = 0;
    this.entries.forEach((e, idx) => {
      const it = e.entryItem();
      let x = 0;
      let w = 0;
      if (it !== null) x = it.x;
      w = e.entryWidth();
      if (e instanceof Barline) {
        const next = getOrNull(this.entries, idx + 1);
        if (!(next instanceof TimeSig)) curX += it!.height / 5;
      }
      if (e instanceof TimeSig) curX += it!.height / 5;
      e.group.x = curX - x;
      curX += w;
    });
    curX = 0;
    let offset = 0;
    for (const e of this.entries) {
      let lrc: Lyric | null = null;
      if (e instanceof NoteEntry) lrc = e.lrc;
      if (lrc === null) {
        e.group.x += offset;
        continue;
      }
      const xx = Math.max(curX - lrc.x, e.group.x + offset);
      offset = xx - e.group.x;
      e.group.x = xx;
      curX = xx + lrc.x + lrc.width;
    }
  }

  private doLineBreak(width: number): Line[] {
    const res: Line[] = [];
    let idx = 0;
    while (idx < this.entries.length) {
      let last = idx;
      const grp = this.entries[idx].group;
      const l = grp.x;
      while (last < this.entries.length) {
        const lastGrp = this.entries[last].group;
        if (this.entries[last] instanceof LineBreak) {
          last++;
          break;
        }
        const r = lastGrp.x + (lastGrp.maxX ?? 0);
        if (r - l < width) {
          last++;
          continue;
        }
        break;
      }
      const line = new Line();
      for (let i = idx; i < last; i++) line.addEntry(this.entries[i]);
      res.push(line);
      idx = last;
    }
    return res;
  }

  private updateXPos(l: Line, width: number, maxHorizontalScale: number): void {
    const first = l.entries[0];
    const dx = first.group.x;
    for (const e of l.entries) e.group.x -= dx;
    const last = l.entries[l.entries.length - 1];
    if (last.group.width < 0) throw new Error("");
    l.adjust(width, maxHorizontalScale);
  }

  private layoutVertically(lines: Line[], opt: LayoutOptions, height: number): Group[] {
    const top = opt.marginTop;
    const maxDist = opt.maxLineDist;
    const dist = opt.staffDist;
    const res: Page[] = [];
    let bottomOfLastLine = 0;
    let pageBreak = false;
    for (const l of lines) {
      let newPage = res.length === 0;
      l.group.update();
      if (bottomOfLastLine + l.group.height + dist > height) newPage = true;
      if (pageBreak) {
        newPage = true;
        pageBreak = false;
      }
      if (newPage) {
        res.push(new Page());
        bottomOfLastLine = 0;
      } else {
        bottomOfLastLine += dist;
      }
      l.group.y = bottomOfLastLine;
      bottomOfLastLine += l.group.height;
      const pg = res[res.length - 1];
      pg.lines.push(l);
      const lst = l.entries[l.entries.length - 1];
      if (lst instanceof LineBreak) pageBreak = lst.newPage;
    }
    const grps: Group[] = [];
    let y = 0;
    for (const pg of res) {
      const grp = new Group();
      let totalHeight = 0;
      for (const l of pg.lines) {
        grp.add(l.group);
        totalHeight += l.group.height;
      }
      if (pg.lines.length > 1) {
        let dd = (height - totalHeight) / (pg.lines.length - 1);
        y = top;
        if (dd > maxDist) {
          y += ((dd - maxDist) * (pg.lines.length - 1)) / 2;
          dd = maxDist;
        }
        for (const ll of pg.lines) {
          const l = ll.group;
          l.y = y;
          y += l.height + dd;
        }
      } else {
        pg.lines[0].group.y = opt.marginTop;
      }
      grp.update();
      grps.push(grp);
    }
    return grps;
  }

  private addSlurTie(a: S.Note, b: S.Note, ypos: number, thickness: number, clr: number): void {
    const ena = this.chordEntry.get(a.chord);
    const enb = this.chordEntry.get(b.chord);
    const grp = new Tie();
    let pl = new Point(ena!.cx, ypos);
    let pr = new Point(enb!.cx, ypos);
    const dx = ena!.number!.font.size / 14;
    if (a.tiePrev !== null || a.tupletEnd) pl = pl.offset(dx, 0);
    if (b.tieNext !== null) pr = pr.offset(-dx, 0);
    pr = pr.offset(enb!.group.x - ena!.group.x, 0);
    grp.init(pl, pr, thickness, clr);
    grp.x += ena!.group.x;
    grp.normalizeX();
    grp.normalizeY();
    this.group.add(grp);
  }

  private addTie(opt: LayoutOptions): void {
    const thickness = opt.slurTieThickness;
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const nt = e.chord.notes[0];
      if (!nt.tieStart) continue;
      const ent = this.chordEntry.get(nt.chord);
      if (!ent) {
        console.error("no entry for tied");
        continue;
      }
      const endCh = nt.tieNext?.chord;
      const endEntry = endCh ? this.chordEntry.get(endCh) : undefined;
      if (!endEntry) continue;
      const ypos = Math.min(this.tiedTop(e, opt, true), this.tiedTop(endEntry, opt, false));
      this.addSlurTie(nt, nt.tieNext!, ypos, thickness, opt.color);
    }
  }
  private tiedTop(ent: NoteEntry, opt: LayoutOptions, left: boolean): number {
    let res = ent.entryTop(opt);
    const nt = ent.chord.notes[0];
    if (left) {
      if (nt.tupletBegin) res -= opt.numberSize / 2;
    } else {
      if (nt.tupletEnd) res -= opt.numberSize / 2;
    }
    return res;
  }
  private slurTop(ent: NoteEntry, opt: LayoutOptions, left: boolean): number {
    let res = ent.entryTop(opt);
    const nt = ent.chord.notes[0];
    if (left) {
      if (nt.tieStart) res -= opt.numberSize / 8;
    } else {
      if (nt.tieEnd) res -= opt.numberSize / 8;
    }
    if (nt.tupletEnd || nt.tupletBegin) res -= opt.numberSize / 2;
    return res;
  }
  private addSlur(opt: LayoutOptions): void {
    const thickness = opt.slurTieThickness;
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const nt = e.chord.notes[0];
      if (!e.chord.slurStart) continue;
      const endCh = e.chord.slurEndChord;
      const endEntry = endCh ? this.chordEntry.get(endCh) : undefined;
      if (!endEntry) continue;
      const ypos = Math.min(this.slurTop(e, opt, true), this.slurTop(endEntry, opt, false));
      const nb = endCh!.notes[0];
      this.addSlurTie(nt, nb, ypos, thickness, opt.color);
    }
  }

  layout(width: number, height: number, opt: LayoutOptions): Group[] {
    this.calcXPos();
    const lines = this.doLineBreak(width);
    for (const l of lines) {
      this.updateXPos(l, width, opt.maxHorizontalScale);
      l.addBeams(opt);
      l.addTuplet(opt);
      l.addTie(opt);
      l.addSlur(opt);
      l.updateLyricY(opt);
      l.group.normalizeY();
      l.group.update();
    }
    return this.layoutVertically(lines, opt, height);
  }

  private getEntry(ch: S.Chord): NoteEntry | null {
    return this.chordEntry.get(ch) ?? null;
  }

  addTuplet(opt: LayoutOptions): void {
    const tuplets = new Set<S.Tuplet>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const t = e.chord.notes[0].tuplet;
      if (!t) continue;
      tuplets.add(t);
    }
    const numberSize = opt.numberFont.size;
    for (const t of tuplets) {
      const start = this.getEntry(t.first.chord);
      if (!start) {
        console.error("no begin entry for tuplet");
        continue;
      }
      const end = this.getEntry(t.last.chord);
      if (!end) {
        console.error("no end entry for tuplet");
        continue;
      }
      const leftItem = start.entryItem()! as JpNumber;
      const rightItem = end.entryItem()! as JpNumber;
      const left = leftItem.pos(this.group).x + leftItem.cx;
      let right = rightItem.pos(this.group).x + rightItem.cx;
      if (end.beginOfSlurTied) right -= opt.numberSize / 14;
      const width = right - left;
      const ypos = Math.min(start.entryTop(opt), end.entryTop(opt));
      const y = -numberSize * 0.25;
      const tupGrp = new Group();
      tupGrp.x = left;
      tupGrp.y = ypos;
      const path = new GraphicPath();
      path.strokeWidth = 1;
      path.fill = false;
      path.stroke = true;
      path.strokeColor = opt.color;
      path.moveTo(0, 0);
      path.lineTo(0, y);
      path.lineTo(width / 2 - numberSize / 3, y);
      path.moveTo(width, 0);
      path.lineTo(width, y);
      path.lineTo(width / 2 + numberSize / 3, y);
      const txt = new SmuflText(opt);
      txt.color = opt.color;
      txt.text = GlyphCodes.tuplet3;
      const w = txt.measureText();
      txt.x = width / 2 - w / 2;
      txt.y = -numberSize * 0.05;
      tupGrp.add(path);
      tupGrp.add(txt);
      this.group.add(tupGrp);
    }
  }

  addBeams(opt: LayoutOptions): void {
    const groups = new Set<S.BeamGroup>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const grp = e.chord.beamGroup;
      if (!grp) continue;
      groups.add(grp);
    }
    let maxLev = 0;
    for (const g of groups) {
      let level = 1;
      for (;;) {
        const pairs = new Map<NoteEntry, NoteEntry>();
        let start: NoteEntry | null = null;
        for (const ch of g.chords) {
          if (ch.beams < level) {
            start = null;
            continue;
          }
          if (start === null) start = this.getEntry(ch);
          if (start === null || this.getEntry(ch) === null) continue;
          pairs.set(start, this.getEntry(ch)!);
        }
        if (pairs.size === 0) break;
        maxLev = Math.max(maxLev, level);
        for (const [k, v] of pairs) {
          const l = new BeamLine(level, k, v, opt);
          this.beams.push(l);
          this.group.add(l);
        }
        level++;
      }
    }
    this.maxBeamLevel = maxLev;
  }

  updateLyricY(opt: LayoutOptions): void {
    let dy = opt.numberSize * 0.4;
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        const ey = e.entryBottom(opt);
        dy = Math.max(dy, ey);
      }
    }
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        if (e.lrc === null) continue;
        e.lrc.y += dy;
      }
    }
  }

  connectTextFrames(): void {
    const lrcs: Lyric[] = [];
    const numbers: TextFrame[] = [];
    for (const it of this.entries) {
      if (it instanceof Barline) {
        const tf = it.group.children[0];
        if (tf instanceof TextFrame) numbers.push(tf);
      }
      if (!(it instanceof NoteEntry)) continue;
      if (it.lrc) lrcs.push(it.lrc);
      if (it.number) numbers.push(it.number);
    }
    lrcs.forEach((it, idx) => {
      it.previous = getOrNull(lrcs, idx - 1);
      it.next = getOrNull(lrcs, idx + 1);
    });
    numbers.forEach((it, idx) => {
      it.previous = getOrNull(numbers, idx - 1);
      it.next = getOrNull(numbers, idx + 1);
    });
  }

  load(m: S.Measure, lrc: number, options: LayoutOptions, final: boolean): void {
    if (m.timeChange && m.index !== 0) {
      const ts = TimeSig.fromTime(m.time, options);
      this.entries.push(ts);
    }
    if (m.keyChange && m.index !== 0) {
      const key = new KeySig(m.key, options);
      const first = m.entries[0];
      if (first instanceof S.Chord) {
        if (first.slurStart) key.group.y -= options.numberSize / 4;
      }
      this.entries.push(key);
    }
    let hasBarline = false;
    for (const ch of m.entries) {
      if (ch instanceof S.LineBreak) {
        const ignore = ch.pass !== null && ch.pass !== lrc;
        if (!ignore) {
          const br = new LineBreak();
          br.newPage = ch.newPage;
          this.entries.push(br);
        }
        continue;
      } else if (ch instanceof S.Chord) {
        NoteEntry.fromChord(this.entries, ch, lrc, options);
      } else if (ch instanceof S.BarlineEntry) {
        const ent = new Barline(final, options);
        ent.update();
        this.entries.push(ent);
        hasBarline = true;
      }
    }
    if (!hasBarline) {
      const ent = new Barline(final, options);
      ent.update();
      if (this.entries[this.entries.length - 1] instanceof LineBreak) {
        this.entries.splice(this.entries.length - 1, 0, ent);
      } else {
        this.entries.push(ent);
      }
    }
  }
}

// ---------------- options / CJK util ----------------

export class CJKUtil {
  static readonly halfPunctMap: Record<string, string> = {
    "。": "｡", "，": ",", "、": "､", "？": "?", "！": "!", "：": ":", "；": ";",
  };
  static toHalfWidth(s: string): string {
    let res = "";
    for (const c of s) res += CJKUtil.halfPunctMap[c] ?? c;
    return res;
  }
}

export class LayoutOptions {
  static charBound(font: Font, ch: string): Rect {
    return font.charBound(ch);
  }

  color = Colors.black;
  lrcFont: Font;
  numberFont: Font;
  smuflFont: Font;
  smuflMeta = new MetaData();

  smuflAsPath = false;
  halfWidthPunct = true;
  ignoreVerseNumber = true;
  slurTieThickness = 4;
  staffDist = 0;
  marginTop: number;
  marginBottom: number;
  marginLeft = 50;
  maxLineDist: number;
  maxHorizontalScale = 2.0;
  jpBeamDist: number;

  constructor(public fontSize: number) {
    // Original used 苹方-简 / Microsoft YaHei; in the webview we rely on the
    // system CJK font via a CSS stack.
    const cjk = "PingFang SC, Microsoft YaHei, sans-serif";
    this.lrcFont = new Font(cjk, fontSize);
    this.numberFont = new Font(cjk, fontSize);
    this.smuflFont = new Font("Bravura", fontSize);
    this.marginTop = fontSize * 1.5;
    this.marginBottom = fontSize * 3;
    this.maxLineDist = fontSize * 0.75;
    this.jpBeamDist = fontSize / 8;
  }

  get lrcSize(): number {
    return this.lrcFont.size;
  }
  set lrcSize(v: number) {
    this.lrcFont = this.lrcFont.makeWithSize(v);
  }
  get numberSize(): number {
    return this.numberFont.size;
  }
  set numberSize(v: number) {
    this.numberFont = this.numberFont.makeWithSize(v);
  }

  numberBound(ch: string): Rect {
    return LayoutOptions.charBound(this.lrcFont, ch);
  }
}

export class Layout {
  options: LayoutOptions;
  pages: Group[] = [];
  constructor(public fontSize: number) {
    this.options = new LayoutOptions(fontSize);
  }

  private parseBreakDur(s: string): Map<string, number> {
    const pgs = s.replace(/\|/g, "\n").replace(/\./g, " ").split("\n");
    const res = new Map<string, number>();
    let last = new Fraction(0);
    for (const pg of pgs) {
      if (pg.length === 0) continue;
      const lines = pg.split(" ");
      for (const it of lines) {
        if (it.trim().length === 0) continue;
        let str = it.trim();
        let v = 1;
        if (str.includes("{")) {
          v = 0;
          str = str.replace(/\{/g, "").replace(/\}/g, "");
        }
        const dur = Fraction.fromString(str);
        last = last.plus(dur);
        res.set(last.toString(), v);
      }
      res.set(last.toString(), 2);
    }
    return res;
  }

  durationInfo(s: string, total: Fraction, pass: number | null): Map<string, number> {
    const durInfo = new Map<string, number>();
    const ss = substringAfter(s, "=").trim();
    if (s.includes("LinesPerPage")) {
      const arr = ss.split("|").map((x) => parseInt(x, 10));
      const lineCnt = arr.reduce((a, b) => a + b, 0);
      const dur = total.divInt(lineCnt);
      let pos = new Fraction(0);
      for (const it of arr) {
        for (let i = 0; i < it; i++) {
          const v = i === it - 1 ? 2 : 1;
          pos = pos.plus(dur);
          durInfo.set(pos.toString(), v);
        }
      }
    } else {
      for (const [k, v] of this.parseBreakDur(ss)) durInfo.set(k, v);
    }
    if (pass !== null) {
      const keys = [...durInfo.keys()];
      for (let i = 1; i < pass; i++) {
        for (const k of keys) {
          const t = Fraction.fromString(k).plus(total.timesInt(i));
          durInfo.set(t.toString(), durInfo.get(k)!);
        }
      }
    }
    return durInfo;
  }

  breakByDur(l: Line, s: string, total: Fraction, pass: number | null): void {
    const durInfo = this.durationInfo(s, total, pass);
    let tick = new Fraction(0);
    const newEnt: Entry[] = [];
    let lineBeg = 0;
    let lastChord: S.Chord | null = null;
    let lastTick: Fraction | null = null;
    for (const e of l.entries) {
      let isNote = false;
      let end = tick;
      if (e instanceof NoteEntry) {
        const ch = e.chord;
        if (ch !== lastChord) {
          isNote = true;
          end = end.plus(ch.duration!);
          lastChord = ch;
        }
      }
      let doBreak = durInfo.has(tick.toString());
      if (!(isNote || e instanceof KeySig)) doBreak = false;
      if (lastTick !== null && lastTick.equals(tick)) doBreak = false;
      if (doBreak) {
        if (durInfo.get(tick.toString()) === 0) {
          while (newEnt.length > lineBeg) newEnt.splice(lineBeg, 1);
        } else {
          const br = new LineBreak();
          br.newPage = durInfo.get(tick.toString()) === 2;
          newEnt.push(br);
          lineBeg = newEnt.length;
        }
        lastTick = tick;
      }
      newEnt.push(e);
      tick = end;
    }
    l.entries = newEnt;
  }

  fromScore(scr: S.Score, dur: string | null, width: number, height: number): void {
    this.pages = [];
    const cw = width - this.options.marginLeft * 2;
    const ch = height - this.options.marginTop - this.options.marginBottom;
    const p = scr.parts[0];
    if (dur !== null) scr.clearSystemBreak();
    const l = new Line();
    const repMeasures = scr.playData.measures;
    repMeasures.forEach((it, idx) => {
      for (let mid = it.mid; mid < it.end; mid++) {
        const m = p.measures[mid];
        const pass = it.pass;
        m.autoBeamGroup();
        const final = mid === it.end - 1 && idx === repMeasures.length - 1;
        l.load(m, pass, this.options, final);
      }
      if (it.endOfPass && dur === null) {
        const lst = l.entries[l.entries.length - 1];
        if (!(lst instanceof LineBreak)) l.entries.push(new LineBreak());
        (l.entries[l.entries.length - 1] as LineBreak).newPage = true;
      }
    });
    if (dur !== null) {
      const part = scr.parts[0];
      const mea = part.measures[part.measures.length - 1];
      const total = mea.position.plus(mea.duration);
      let pass: number | null = null;
      if (scr.playData.isSimpple) pass = scr.playData.measures.length;
      this.breakByDur(l, dur, total, pass);
    }
    l.connectTextFrames();
    for (const g of l.layout(cw, ch, this.options)) this.pages.push(g);
    this.titleAndPageNumber(scr.title, width, height, cw);
  }

  titleAndPageNumber(title: string, width: number, height: number, cw: number): void {
    this.pages.forEach((pg, idx) => {
      pg.x += this.options.marginLeft;
      const tf = new TextFrame();
      tf.font = this.options.lrcFont.scaled(0.8);
      tf.text = title.split("\n")[0];
      tf.color = this.options.color;
      tf.x = (cw - tf.measureText()) / 2;
      tf.y = height - this.options.marginBottom * 0.5 - pg.y;
      tf.update();
      const tf1 = new TextFrame();
      tf1.text = `${idx + 1}/${this.pages.length}`;
      tf1.color = this.options.color;
      tf1.x = 0.8 * width;
      tf1.y = tf.y;
      tf1.font = tf.font;
      tf1.update();
      pg.add(tf);
      pg.add(tf1);
    });
  }
}

function substringAfter(s: string, delim: string): string {
  const i = s.indexOf(delim);
  return i < 0 ? s : s.substring(i + delim.length);
}
