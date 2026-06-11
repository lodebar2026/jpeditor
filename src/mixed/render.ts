// 混排渲染器。从 musicpp model/render.cpp 移植。
// 输入：MixedScore（已排版）；输出：Group（含 GraphicLine/TextFrame）。
// 单位：tenths（与 MixedScore 一致）。
// SMuFL 字形用 TextFrame + font.family="Bravura"（等价 SmuflText，无需 LayoutOptions）。

import { Fraction } from "../common/fraction";
import { Matrix33, Point } from "../common/geom";
import { GraphicLine, GraphicPath, Group, TextFrame } from "../layout/layout";
import { Font } from "../layout/font";
import { GlyphCodes } from "../smufl/smufl";
import {
  BarGlyph,
  BeamVal,
  ClefSig,
  GroupSymbol,
  MeasureData,
  MixedOptions,
  MixedScore,
  Notation,
  Sys,
  SysStaff,
  TimeSig,
  smuflWidth,
} from "./model";

// -----------------------------------------------------------------------
// primitives

function addLine(g: Group, x1: number, y1: number, x2: number, y2: number, lw: number): void {
  const l = new GraphicLine();
  l.p0 = new Point(x1, y1);
  l.p1 = new Point(x2, y2);
  l.strokeColor = 0xff000000;
  l.strokeWidth = lw;
  g.add(l);
}

/** SMuFL glyph via TextFrame with Bravura family. */
function addSmufl(g: Group, glyph: string, x: number, y: number, size: number): void {
  const t = new TextFrame();
  t.text = glyph;
  t.font = new Font("Bravura", size);
  t.color = 0xff000000;
  t.x = x;
  t.y = y;
  g.add(t);
}

/** SMuFL glyph with scale transform. */
function addSmuflScaled(
  g: Group,
  glyph: string,
  x: number,
  y: number,
  size: number,
  scx: number,
  scy: number,
): void {
  const grp = new Group();
  const m = new Matrix33();
  m.setAffine([scx, 0, 0, scy, x, y]);
  grp.matrix = m;
  addSmufl(grp, glyph, 0, 0, size);
  g.add(grp);
}

function addFilledQuad(
  g: Group,
  lx: number, ly: number,
  rx: number, ry: number,
  thick: number,
): void {
  const p = new GraphicPath();
  p.fill = true;
  p.stroke = false;
  p.fillColor = 0xff000000;
  p.moveTo(lx, ly);
  p.lineTo(lx, ly + thick);
  p.lineTo(rx, ry + thick);
  p.lineTo(rx, ry);
  p.close();
  g.add(p);
}

// -----------------------------------------------------------------------
// drawNotesNormal（render.cpp:953 drawNotesNormal + drawChord stem/flag）

export function drawNotesNormal(
  eng: MixedOptions,
  container: Group,
  md: MeasureData,
  subStaff: number,
): void {
  const fs = eng.musicFont.size;
  const meta = eng.meta;

  // ---- noteheads, rests, stems, flags ----
  for (const ch of md.chords) {
    const code = ch.sym();
    if (!code) continue;

    for (const n of ch.notes) {
      if (n.staff !== subStaff) continue;
      if (!n.visible) continue;

      let x: number;
      const cue = ch.cue || ch.grace;
      const scale = cue ? eng.cueSize : 1;

      if (ch.measureRest) {
        const mif = md.measureInfo;
        const endPos = mif.getEntPos(mif.dur);
        x = (mif.dataPos + endPos) / 2 - 7;
      } else {
        x = n.x;
        if (cue) {
          x = ch.stemX();
          if (!n.rightSide()) x -= smuflWidth(meta, code) * scale;
          if (ch.noteType.compareTo(new Fraction(1)) >= 0) x += 5;
        }
        if (x < 0) continue;
      }

      let y = n.cy();
      if (code === GlyphCodes.restWhole) y -= 10;

      if (scale !== 1) {
        addSmuflScaled(container, code, x, y, fs, scale, scale);
      } else {
        addSmufl(container, code, x, y, fs);
      }
    }

    // stem and flag (skip rests, whole notes, half notes with beams)
    if (ch.rest) continue;
    if (ch.noteType.compareTo(new Fraction(4)) >= 0) continue; // whole: no stem

    const sx = ch.stemX();
    // stemY local = stemY() - md.staffY(subStaff) but for sub=0 staffY=0
    const sy = ch.stemY() - md.staffY(subStaff);
    const ty = ch.tailY(true) - md.staffY(subStaff);

    // flag (only if unbeamed)
    if (ch.beams.length === 0) {
      const flagCode = ch.tailSym(ch.stemUp);
      if (flagCode) {
        const scale = ch.cue ? eng.cueSize : 1;
        if (scale !== 1) {
          addSmuflScaled(container, flagCode, sx, ty, fs, scale, scale);
        } else {
          addSmufl(container, flagCode, sx, ty, fs);
        }
      }
    }

    addLine(container, sx, sy, sx, ty, eng.lineWidths.stem);
  }

  // ---- ledger lines, dots, accidentals from NoteEntries ----
  for (const ent of md.noteEntries) {
    if (ent.subStaff !== subStaff) continue;

    for (const [ledgerLine, [lx1, lx2]] of ent.leger.ranges) {
      const ly = -ledgerLine * 5;
      addLine(container, lx1 - 3, ly, lx2 + 3, ly, eng.lineWidths.leger);
    }

    if (md.chords.some((ch) => ch.dot > 0 && !ch.rest)) {
      for (const dotLine of ent.dot.dots) {
        addSmufl(container, GlyphCodes.augmentationDot, ent.dot.dotPos, -5 * dotLine, fs);
      }
    }

    for (const it of ent.acc.accidentals) {
      if (it.xpos === null) continue;
      let ax = it.xpos - 1;
      const ay = -it.line * 5;
      const sc = it.scale;
      for (const sym of it.symbols) {
        if (sc !== 1) {
          addSmuflScaled(container, sym, ax, ay, fs, sc, sc);
        } else {
          addSmufl(container, sym, ax, ay, fs);
        }
        ax += smuflWidth(meta, sym) * sc;
      }
    }
  }
}

// -----------------------------------------------------------------------
// drawBeams（render.cpp BeamLevelData::drawNormal + drawBeam）

/** One item of a beam run: start/end chord (null = hook), level. */
interface BeamItem {
  start: import("./model").MChord | null;
  end: import("./model").MChord | null;
  level: number;
}

function buildBeamItems(
  chords: import("./model").MChord[],
): BeamItem[] {
  const items: BeamItem[] = [];
  for (let lev = 0; lev < 10; lev++) {
    let start: import("./model").MChord | null = null;
    let last: import("./model").MChord | null = null;
    let found = false;
    for (const ch of chords) {
      if (lev >= ch.beams.length) continue;
      const bv = ch.beams[lev];
      switch (bv) {
        case BeamVal.Continue:
          last = ch;
          break;
        case BeamVal.End:
          items.push({ start, end: ch, level: lev });
          found = true;
          start = null; last = null;
          break;
        case BeamVal.Backward:
          items.push({ start: null, end: ch, level: lev });
          found = true;
          break;
        case BeamVal.Forward:
          items.push({ start: ch, end: null, level: lev });
          found = true;
          break;
        case BeamVal.Begin:
          start = ch;
          break;
      }
    }
    if (!found && start && last) {
      items.push({ start, end: last, level: lev });
      found = true;
    }
    if (!found) break;
  }
  return items;
}

function drawBeamGroup(
  container: Group,
  chords: import("./model").MChord[],
  stfY: number,
  scale: number,
): void {
  const items = buildBeamItems(chords);
  if (items.length === 0) return;

  const first = chords[0];
  const last = chords[chords.length - 1];
  const x1g = first.stemX();
  const y1g = first.tailY(true) - stfY;
  const x2g = last.stemX();
  const y2g = last.tailY(true) - stfY;
  const slope = x2g !== x1g ? (y2g - y1g) / (x2g - x1g) : 0;
  const hookLen = 12;
  const thick = 5.0 * scale;

  for (const it of items) {
    let lx: number, ly: number, rx: number, ry: number;
    const up = it.start?.stemUp ?? it.end?.stemUp ?? true;
    const dy = -(it.level * 8) * (up ? -1 : 1) + (up ? 0 : -5);

    if (it.start) {
      lx = it.start.stemX();
      ly = it.start.tailY(true) - stfY;
    } else {
      rx = it.end!.stemX();
      ry = it.end!.tailY(true) - stfY;
      lx = rx - hookLen;
      ly = ry - hookLen * slope;
    }
    if (it.end) {
      rx = it.end.stemX();
      ry = it.end.tailY(true) - stfY;
    } else {
      rx = lx + hookLen;
      ry = ly + hookLen * slope;
    }

    ly += dy * scale;
    ry += dy * scale;
    addFilledQuad(container, lx, ly, rx, ry, thick);
  }
}

export function drawBeams(
  container: Group,
  md: MeasureData,
  subStaff: number,
): void {
  const stfY = md.staffY(subStaff);
  for (const grp of md.beams) {
    const relevantChords = grp.chords.filter((ch) =>
      ch.notes.some((n) => n.staff === subStaff),
    );
    if (relevantChords.length === 0) continue;
    drawBeamGroup(container, grp.chords, stfY, 1);
  }
  for (const grp of md.graceBeams) {
    const relevantChords = grp.chords.filter((ch) =>
      ch.notes.some((n) => n.staff === subStaff),
    );
    if (relevantChords.length === 0) continue;
    drawBeamGroup(container, grp.chords, stfY, 0.8);
  }
}

function translated(x: number, y: number): Group {
  const g = new Group();
  const m = new Matrix33();
  m.setAffine([1, 0, 0, 1, x, y]);
  g.matrix = m;
  return g;
}

// -----------------------------------------------------------------------
// drawStaff

function drawStaff(eng: MixedOptions, container: Group, sysStf: SysStaff, ypos: number, w: number): void {
  const nota = sysStf.partStaff.getNotation(new Fraction(0));
  if (nota === Notation.JianPu) return;

  const grp = translated(0, ypos);
  for (let l = 0; l < sysStf.staffLines; l++) {
    addLine(grp, 0, l * 10, w, l * 10, eng.lineWidths.staff);
  }
  container.add(grp);
}

// -----------------------------------------------------------------------
// drawClef

function drawClef(clef: ClefSig, container: Group, xpos: number, fontSize: number, sc = 1): void {
  const y = 50 - clef.line * 10;
  if (sc !== 1) {
    addSmuflScaled(container, clef.sign, xpos, y, fontSize, sc, sc);
  } else {
    addSmufl(container, clef.sign, xpos, y, fontSize);
  }
}

// -----------------------------------------------------------------------
// drawKeyAccid

function drawKeyAccid(
  container: Group,
  clef: ClefSig,
  num: number,
  sym: string,
  skip: number,
  xOff: number,
  fontSize: number,
): void {
  const inc = 4;
  const initStep = num > 0 ? 52 : 48;
  const maxStep = num > 0 ? 46 : 44;
  const sk = Math.abs(skip);
  for (let i = sk; i < Math.abs(num); i++) {
    let step = initStep + i * inc;
    while (step > maxStep) step -= 7;
    let base = clef.topPitch();
    while (base < 45) base += 7;
    const line = step - base;
    const y = -line * 5.0;
    addSmufl(container, sym, 10.0 * (i - sk) + xOff, y, fontSize);
  }
}

function drawKey(
  eng: MixedOptions,
  container: Group,
  mif: import("./model").MeasureInfo,
  ps: import("./model").PartStaff,
  x: number,
): void {
  const key = ps.getKey(mif.offset);
  const clef = ps.getClef(mif.offset);
  const cancel = key.cancel;
  const cur = key.fifths;
  if (cur === 0 && cancel === 0) return;

  const g = cur > 0 ? GlyphCodes.accidentalSharp : GlyphCodes.accidentalFlat;
  const grp = new Group();
  const fs = eng.musicFont.size;

  if (cancel * cur < 0) {
    drawKeyAccid(grp, clef, cancel, GlyphCodes.accidentalNatural, 0, 0, fs);
    drawKeyAccid(grp, clef, cur, g, 0, Math.abs(cancel) * 10, fs);
  } else {
    if (Math.abs(cur) > Math.abs(cancel)) {
      drawKeyAccid(grp, clef, cur, g, 0, 0, fs);
    } else {
      const skip = Math.abs(cur - cancel);
      drawKeyAccid(grp, clef, cancel, GlyphCodes.accidentalNatural, Math.abs(cur), 0, fs);
      drawKeyAccid(grp, clef, cur, g, 0, skip * 10, fs);
    }
  }
  if (grp.children.length > 0) {
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1, x, 0]);
    grp.matrix = m;
    container.add(grp);
  }
}

// -----------------------------------------------------------------------
// drawTime

function drawTime(
  eng: MixedOptions,
  container: Group,
  mif: import("./model").MeasureInfo,
  ps: import("./model").PartStaff,
  x: number,
): void {
  const time = ps.getTime(mif.offset);
  const grp = new Group();
  const fs = eng.musicFont.size;

  if (time.symbol) {
    const sym =
      time.beats === 2 ? GlyphCodes.timeSigCutCommon : GlyphCodes.timeSigCommon;
    addSmufl(grp, sym, 0, 20, fs);
  } else {
    addSmufl(grp, TimeSig.makeNumber(time.beats), 0, 10, fs);
    addSmufl(grp, TimeSig.makeNumber(time.beatType), 0, 30, fs);
  }

  if (grp.children.length > 0) {
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1, x, 0]);
    grp.matrix = m;
    container.add(grp);
  }
}

// -----------------------------------------------------------------------
// drawBarlineItem

function drawBarlineItem(
  eng: MixedOptions,
  container: Group,
  style: BarGlyph,
  x: number,
  top: number,
  bot: number,
): void {
  const lw = eng.lineWidths;
  switch (style) {
    case BarGlyph.Single:
      addLine(container, x, top, x, bot, lw.lightBarline);
      break;
    case BarGlyph.Double:
      addLine(container, x, top, x, bot, lw.lightBarline);
      addLine(container, x + lw.lightBarline + eng.barlineDist, top, x + lw.lightBarline + eng.barlineDist, bot, lw.lightBarline);
      break;
    case BarGlyph.Final:
      addLine(container, x, top, x, bot, lw.lightBarline);
      addLine(container, x + lw.lightBarline + eng.barlineDist + lw.heavyBarline / 2, top, x + lw.lightBarline + eng.barlineDist + lw.heavyBarline / 2, bot, lw.heavyBarline);
      break;
    case BarGlyph.ReverseFinal:
      addLine(container, x + lw.heavyBarline / 2, top, x + lw.heavyBarline / 2, bot, lw.heavyBarline);
      addLine(container, x + lw.heavyBarline + eng.barlineDist, top, x + lw.heavyBarline + eng.barlineDist, bot, lw.lightBarline);
      break;
    case BarGlyph.HeavyHeavy:
      addLine(container, x + lw.heavyBarline / 2, top, x + lw.heavyBarline / 2, bot, lw.heavyBarline);
      addLine(container, x + lw.heavyBarline + eng.barlineDist + lw.heavyBarline / 2, top, x + lw.heavyBarline + eng.barlineDist + lw.heavyBarline / 2, bot, lw.heavyBarline);
      break;
    case BarGlyph.None:
    default:
      break;
  }
}

function drawRepeatDots(eng: MixedOptions, container: Group, sys: Sys, x: number): void {
  for (const st of sys.staves) {
    if (!st.staffVisible) continue;
    const y0 = sys.ypos(st.partStaff.order);
    addSmufl(container, GlyphCodes.repeatDot, x, y0 + 15, eng.musicFont.size);
    addSmufl(container, GlyphCodes.repeatDot, x, y0 + 25, eng.musicFont.size);
  }
}

// -----------------------------------------------------------------------
// drawBarline

function drawBarline(eng: MixedOptions, container: Group, sys: Sys): void {
  const styles: (BarGlyph | null)[] = [];
  const xpos: number[] = [];

  const m0 = sys.measures[0];
  styles.push(null);
  xpos.push(m0.xpos() + m0.leftBarlinePos);

  for (let idx = 0; idx < sys.measures.length; idx++) {
    const m = sys.measures[idx];
    let dx = 0;
    if (idx + 1 < sys.measures.length) dx = -sys.measures[idx + 1].sibKeyOffset;
    styles.push(m.rightBarline ?? BarGlyph.Single);
    xpos.push(m.xpos() + m.width + dx);
  }

  if (sys.timeChangeWidth > 0) xpos[xpos.length - 1] -= sys.timeChangeWidth + 5;
  if (sys.keyChangeWidth > 0) xpos[xpos.length - 1] -= sys.keyChangeWidth + 5;

  // merge left barlines into styles array
  for (let idx = 0; idx < sys.measures.length; idx++) {
    const m = sys.measures[idx];
    if (m.leftBarline !== null) {
      const orig = styles[idx];
      if (orig === null || orig === BarGlyph.Single) styles[idx] = m.leftBarline;
    }
  }

  const grps = sys.barlineGroups();
  const scr = sys.score;

  for (let i = 0; i < styles.length; i++) {
    const st = styles[i];
    if (st === null) continue;
    const x = xpos[i];

    for (const [first, last] of grps) {
      const stb = sys.staves[last];
      const top = sys.ypos(first);
      const bot = sys.ypos(last) + stb.height();
      drawBarlineItem(eng, container, st, x, top, bot);
    }

    const mid = i + sys.firstMeasure;
    if (i < styles.length - 1 && mid < scr.measures.length && scr.measures[mid].forward) {
      drawRepeatDots(eng, container, sys, x + 7);
    }
    if (i > 0 && mid > 0 && scr.measures[mid - 1].backward) {
      drawRepeatDots(eng, container, sys, x - 12);
    }
  }

  // connecting left vertical line
  if (sys.visibleStaves() > 1) {
    addLine(container, 0.5, 0, 0.5, sys.height(), 1);
  }
}

// -----------------------------------------------------------------------
// drawPartGroups

function drawPartGroups(container: Group, sys: Sys): void {
  const eng = sys.score.options;
  for (const grp of sys.score.partGroups) {
    if (grp.symbol === GroupSymbol.None) continue;
    const [first, last] = sys.visibleStavesOf(grp);
    if (first < 0) continue;
    const y0 = sys.ypos(first);
    const y1 = sys.ypos(last) + sys.staves[last].height();

    if (grp.symbol === GroupSymbol.Bracket) {
      const lw = 5;
      const bx = -10 + lw / 2 - 0.5;
      addLine(container, bx, y0 - 5, bx, y1 + 5, lw);
      addSmufl(container, GlyphCodes.bracketTop, -10, y0 - 4, eng.musicFont.size);
      addSmufl(container, GlyphCodes.bracketBottom, -10, y1 + 4, eng.musicFont.size);
    } else if (grp.symbol === GroupSymbol.Brace) {
      const scaleX = 3.0;
      const scaleY = (y1 - y0) / 40;
      addSmuflScaled(container, GlyphCodes.brace, -14, y1, eng.musicFont.size, scaleX, scaleY);
    }
  }
}

// -----------------------------------------------------------------------
// drawSysStaff

function drawSysStaff(container: Group, sys: Sys, st: SysStaff, ypos: number): void {
  const scr = sys.score;
  const eng = scr.options;
  const ps = st.partStaff;

  drawStaff(eng, container, st, ypos, sys.width());

  let xpos = 0;
  for (const m of sys.measures) {
    const grp = translated(xpos, ypos);
    container.add(grp);

    const nota = ps.getNotation(m.offset);
    const isJp = nota === Notation.JianPu;
    const nsys = m === sys.measures[0];

    if (nsys && !isJp && m.clefPos !== null) {
      drawClef(ps.getClef(m.offset), grp, m.clefPos, eng.musicFont.size);
    }
    if (nsys && !isJp && m.keyPos !== null) {
      drawKey(eng, grp, m, ps, m.keyPos - m.sibKeyOffset);
    } else if (!nsys && ps.keyChange(m.offset) && m.keyPos !== null && !isJp) {
      drawKey(eng, grp, m, ps, m.keyPos - m.sibKeyOffset);
    }
    if (ps.timeChange(m.offset) && m.timePos !== null && !isJp) {
      drawTime(eng, grp, m, ps, m.timePos);
    }

    // trailing clef/key/time for next system
    if (m === sys.measures[sys.measures.length - 1]) {
      let endPos = m.width;
      if (sys.timeChangeWidth > 0 && m.index + 1 < scr.measures.length) {
        endPos -= sys.timeChangeWidth + 5;
        const next = scr.measures[m.index + 1];
        if (!isJp) drawTime(eng, grp, next, ps, endPos);
      }
      if (sys.keyChangeWidth > 0 && m.index + 1 < scr.measures.length) {
        endPos -= sys.keyChangeWidth + 5;
        const next = scr.measures[m.index + 1];
        if (!isJp) drawKey(eng, grp, next, ps, endPos);
      }
    }

    // notes, beams (skip JianPu — handled by M4 mixed layer)
    if (!isJp) {
      const md = ps.part.measures[m.index];
      if (md) {
        drawNotesNormal(eng, grp, md, ps.subIndex);
        drawBeams(grp, md, ps.subIndex);
      }
    }

    xpos += m.width;
  }
}

// -----------------------------------------------------------------------
// drawSystem / drawPage

export function drawSystem(container: Group, sys: Sys): Group {
  const scr = sys.score;
  const eng = scr.options;
  const res = new Group();
  container.add(res);

  let ypos = 0;
  for (const st of sys.staves) {
    if (!st.staffVisible) continue;
    ypos += st.distance;
    drawSysStaff(res, sys, st, ypos);
    ypos += st.height();
  }

  drawBarline(eng, res, sys);
  drawPartGroups(res, sys);
  return res;
}

export function drawPage(score: MixedScore, pageIndex: number): Group {
  const pg = score.pages[pageIndex];
  const defs = score.defaults;
  const res = new Group();

  for (const sys of pg.systems) {
    const gr = drawSystem(res, sys);
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1, defs.leftMargin + sys.leftMargin, defs.topMargin + sys.distance]);
    gr.matrix = m;
  }

  return res;
}

