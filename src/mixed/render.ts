// 混排渲染器。从 musicpp model/render.cpp 移植。
// 输入：MixedScore（已排版）；输出：Group（含 GraphicLine/TextFrame）。
// 单位：tenths（与 MixedScore 一致）。
// SMuFL 字形用 TextFrame + font.family="Bravura"（等价 SmuflText，无需 LayoutOptions）。

import { Fraction } from "../common/fraction";
import { Matrix33, Point } from "../common/geom";
import { GraphicLine, GraphicPath, Group, TextFrame } from "../layout/layout";
import { GlyphCodes } from "../smufl/smufl";
import {
  BarGlyph,
  BeamVal,
  ClefSig,
  Ending,
  GroupSymbol,
  LrcExtend,
  MeasureData,
  MixedOptions,
  MixedPart,
  MixedScore,
  MLyric,
  Notation,
  Slur,
  Sys,
  SysStaff,
  Tied,
  TimeSig,
  Tuplet,
  calcSlurPoints,
  fGe,
  fLt,
  slurTiedPos,
  slurTiedPosForJp,
  smuflWidth,
} from "./model";
import { Font } from "../layout/font";

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

// -----------------------------------------------------------------------
// drawSlurTied / drawTied / drawSlur（render.cpp:1073-1329）

/** Bezier slur/tie lens shape (render.cpp::drawSlurTied). */
function drawSlurTied(
  container: Group,
  plx: number, ply: number,
  prx: number, pry: number,
  above: boolean,
): void {
  const [pt0, pt1, cos] = calcSlurPoints({ x: plx, y: ply }, { x: prx, y: pry }, above);
  const lw0 = 6 / cos;

  // filled lens
  const path = new GraphicPath();
  path.fill = true;
  path.stroke = false;
  path.fillColor = 0xff000000;
  path.moveTo(plx, ply);
  path.cubicTo(pt0.x, pt0.y, pt1.x, pt1.y, prx, pry);
  path.cubicTo(pt1.x, pt1.y + lw0 / 2, pt0.x, pt0.y + lw0 / 2, plx, ply);
  path.close();

  // thin stroke outline
  const path2 = new GraphicPath();
  path2.fill = false;
  path2.stroke = true;
  path2.strokeColor = 0xff000000;
  path2.strokeWidth = 0.7;
  path2.moveTo(plx, ply);
  path2.cubicTo(pt0.x, pt0.y + lw0 / 4, pt1.x, pt1.y + lw0 / 4, prx, pry);

  container.add(path);
  container.add(path2);
}

/** Draw tie (render.cpp::drawTied). */
function drawTied(
  sys: Sys,
  eng: MixedOptions,
  container: Group,
  obj: Tied,
  forceNota?: Notation,
): void {
  const begin = sys.beginTick();
  const end = sys.endTick();
  if (fGe(obj.startTick, end)) return;
  if (fLt(obj.endTick, begin)) return;

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
    if (chr.voice > 1 && hasPrev) return;
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

  drawSlurTied(container, plx, ply, prx, pry, above);
}

/** Draw slur (render.cpp::drawSlur). */
function drawSlur(
  sys: Sys,
  eng: MixedOptions,
  container: Group,
  slur: Slur,
  forceNota?: Notation,
): void {
  const begin = sys.beginTick();
  const end = sys.endTick();
  if (fGe(slur.startTick, end)) return;
  if (fLt(slur.endTick, begin)) return;
  if (!slur.startNote) return;

  const hasPrev = fLt(slur.startTick, begin);
  const hasNext = fGe(slur.endTick, end);

  let chl = hasPrev ? null : slur.startChord();
  let chr = hasNext ? null : slur.endChord();

  const refCh = chl ?? chr!;
  let nota = refCh.notes[0].partStaff().getNotation(refCh.tick());
  if (forceNota !== undefined) nota = forceNota;

  const above = slur.above;
  let plx = 0, ply = 0, prx = 0, pry = 0;

  if (nota === Notation.JianPu) {
    if (!chr || !chl) return;
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

  drawSlurTied(container, plx, ply, prx, pry, above);
}

// -----------------------------------------------------------------------
// drawLrcExtend（render.cpp::drawLrcExtend）

function drawLrcExtend(
  sys: Sys,
  _eng: MixedOptions,
  container: Group,
  ext: LrcExtend,
): void {
  const begin = sys.beginTick();
  const end = sys.endTick();
  if (fGe(ext.startTick, end)) return;
  if (fLt(ext.endTick, begin)) return;

  const hasPrev = fLt(ext.startTick, begin);
  const hasNext = fGe(ext.endTick, end);
  if (hasPrev || hasNext) return;

  if (!ext.start || !ext.stop) return;
  const mifL = ext.startChord().measure.measureInfo;
  const mifR = ext.endChord().measure.measureInfo;
  const lrcLeft = ext.start.x + mifL.xpos() + ext.start.xOffset + ext.start.width;
  const lrcRight = ext.stop.x + mifR.xpos() + ext.stop.xOffset;
  const y = -ext.start.y;
  addLine(container, lrcLeft, y, lrcRight, y, 1);
}

// -----------------------------------------------------------------------
// drawTuplet（render.cpp::drawTuplet）

function drawTuplet(eng: MixedOptions, container: Group, obj: Tuplet): void {
  const chl = obj.startChord();
  const chr = obj.endChord();
  const nota = chl.notes[0].partStaff().getNotation(chl.tick());
  const above = obj.above;

  let plx = chl.stemX() + chl.measure.xpos();
  let ply = 0;
  let prx = chr.stemX() + chr.measure.xpos();
  let pry = 0;

  const sign = above ? 1 : -1;

  if (nota === Notation.JianPu) {
    const ntl = chl.notes[0];
    const ntr = chr.notes[0];
    plx = ntl.x + chl.measure.xpos();
    prx = ntr.x + chr.measure.xpos();
    const dot = Math.max(
      ntl.octaveJp(eng.addOctaveJpForKeyA),
      ntr.octaveJp(eng.addOctaveJpForKeyA),
    );
    ply = pry = dot > 0 ? -4 : 3;
  } else {
    // determine bracket: use when stem direction matches above or no beams
    let bracket = true;
    if (obj.bracket !== null) {
      bracket = obj.bracket;
    } else if (above === chl.stemUp) {
      bracket = chl.beams.length === 0;
    }

    if (above === chl.stemUp) {
      ply = chl.tailY(true) - 10 * sign;
    } else {
      ply = chl.stemY() - 15 * sign;
    }
    if (above === chr.stemUp) {
      pry = chr.tailY(true) - 10 * sign;
    } else {
      pry = chr.stemY() - 15 * sign;
    }

    ply -= sign * 10;
    pry -= sign * 10;

    const hlen = 10;
    if (bracket) {
      const k = prx !== plx ? (pry - ply) / (prx - plx) : 0;
      const dx = (prx - plx - 20) / 2;
      const bpath = new GraphicPath();
      bpath.fill = false;
      bpath.stroke = true;
      bpath.strokeColor = 0xff000000;
      bpath.strokeWidth = 1;
      bpath.moveTo(plx, ply + sign * hlen);
      bpath.lineTo(plx, ply);
      bpath.lineTo(plx + dx, ply + dx * k);
      bpath.moveTo(prx, pry + sign * hlen);
      bpath.lineTo(prx, pry);
      bpath.lineTo(prx - dx, pry - dx * k);
      container.add(bpath);
    }
  }

  const cx = (plx + prx) / 2;
  const cy = (ply + pry) / 2;
  const numStr = Tuplet.makeNumber(obj.timeModification.denominator);
  const numW = TimeSig.width(eng.meta, obj.timeModification.denominator) *
    (eng.musicFont.size / 40);
  addSmufl(container, numStr, cx - numW / 2, cy + eng.musicFont.size * 0.3, eng.musicFont.size);
}

// -----------------------------------------------------------------------
// drawEnding（render.cpp::drawEnding）

function drawEnding(container: Group, obj: Ending, sys: Sys, mixed: boolean): void {
  const mifL = obj.startMeasure;
  const mifR = obj.endMeasure;
  let left = mifL.xpos() + mifL.dataPos - 5 - mifL.sibKeyOffset;
  let right = mifR.xpos() + mifR.dataEnd;

  const scr = sys.score;
  const idx = mifR.index + 1;
  if (idx < scr.measures.length) {
    right -= scr.measures[idx].sibKeyOffset;
  }

  let yPos: number | null = null;
  if (mixed && sys.staves.length > 0) {
    const eng = scr.options;
    const st = sys.staves[0];
    if (st.hasHarmony) {
      yPos = -st.harmonyY + 12;
    } else {
      yPos = -st.minY - eng.mixStaffDist - eng.mixStaffHeight;
    }
  }

  const eng = scr.options;
  const y0 = -30.0;
  const vlen = 20.0;
  const hlen = 10.0;

  const bpath = new GraphicPath();
  bpath.fill = false;
  bpath.stroke = true;
  bpath.strokeColor = 0xff000000;
  bpath.strokeWidth = 1;

  const leftV = true;
  const rightV = obj.hasStop;

  if (leftV) {
    bpath.moveTo(left, y0 + vlen);
    bpath.lineTo(left, y0);
  } else {
    bpath.moveTo(left, y0);
  }
  bpath.lineTo(right, y0);
  if (rightV) {
    bpath.lineTo(right, y0 + vlen);
  }

  const grp = translated(0, yPos ?? 0);
  grp.add(bpath);

  const numFont = new Font(eng.wordFont, 20 / (scr.scaling > 0 ? scr.scaling : 0.45));
  const numT = new TextFrame();
  numT.text = obj.number;
  numT.font = numFont;
  numT.color = 0xff000000;
  numT.x = left + hlen;
  numT.y = y0 + vlen;
  grp.add(numT);

  container.add(grp);
}

// -----------------------------------------------------------------------
// drawLrc（render.cpp::drawLrc）

function drawLrcHyphen(
  eng: MixedOptions,
  lrc: MLyric,
  container: Group,
  mifXpos: number,
): void {
  const next = lrc.next!;
  const mifL = lrc.measure.measureInfo;
  const mifR = next.measure.measureInfo;

  const l = lrc.x + lrc.xOffset + lrc.width;
  let r = next.x + next.xOffset;
  if (mifR !== mifL) {
    if (mifL.system !== mifR.system) {
      r = mifR.system!.width() - mifXpos;
    } else {
      r += mifR.xpos() - mifXpos;
    }
  }
  const cx = (l + r) / 2;
  const hyp = eng.chineseHyphen ? "—" : "-";
  const t = new TextFrame();
  t.text = hyp;
  t.font = lrc.font;
  t.color = 0xff000000;
  const hypW = lrc.font.measureText(hyp);
  t.x = cx - hypW / 2;
  t.y = -lrc.y;
  container.add(t);
}

export function drawLrc(
  eng: MixedOptions,
  container: Group,
  data: MeasureData,
  subStaff: number,
): void {
  const mifXpos = data.measureInfo.xpos();
  for (const lrc of data.lyrics) {
    if (lrc.staff !== subStaff) continue;
    if (lrc.empty) continue;
    const x = lrc.x;
    if (x < 0) continue;

    if (lrc.next) {
      drawLrcHyphen(eng, lrc, container, mifXpos);
    }

    const t = new TextFrame();
    t.text = lrc.text;
    t.font = lrc.font;
    t.color = 0xff000000;
    t.x = x + lrc.xOffset;
    t.y = -lrc.y;
    container.add(t);

    if (lrc.prefix) {
      const pref = new TextFrame();
      pref.text = lrc.prefix;
      pref.font = lrc.font;
      pref.color = 0xff000000;
      const cnt = lrc.prefix.length;
      pref.x = x - (40 + (cnt - 2) * 12);
      pref.y = -lrc.y;
      container.add(pref);
    }
  }
}

// -----------------------------------------------------------------------
// drawHarmony（render.cpp::drawHarmony, simplified: plain text）

export function drawHarmony(
  eng: MixedOptions,
  container: Group,
  data: MeasureData,
  subStaff: number,
  scaling: number,
): void {
  const fontsz = eng.harmonySize / (scaling > 0 ? scaling : 0.45);
  const font = new Font(eng.wordFont, fontsz);
  for (const h of data.harmonies) {
    if (h.staff !== subStaff) continue;
    const text = h.asPlainText();
    const width = font.measureText(text);
    const t = new TextFrame();
    t.text = text;
    t.font = font;
    t.color = 0xff000000;
    t.x = h.x - width / 2 + 6.5;
    t.y = -h.y;
    container.add(t);
  }
}

// -----------------------------------------------------------------------
// drawLineObjs（render.cpp::drawLineObjs）— span objects per part per system

function drawLineObjs(container: Group, sys: Sys, p: MixedPart): void {
  const scr = sys.score;
  const eng = scr.options;

  const grp = translated(0, sys.yposPart(p));
  container.add(grp);

  const firstStf = p.staves[0];
  const t = sys.measures[0].offset;
  const nota = firstStf.getNotation(t);
  const mixed = nota === Notation.Mixed;

  if (mixed) {
    let miny = 0;
    for (const st of sys.staves) {
      if (st.part() !== p) continue;
      miny = st.minY;
    }
    const grpJp = translated(0, miny - eng.mixStaffDist - eng.mixStaffHeight);
    grp.add(grpJp);

    for (const sl of p.slurs) {
      drawSlur(sys, eng, grp, sl, Notation.Normal);
      const nts = sl.startChord().notes;
      const nt = sl.above ? nts[nts.length - 1] : nts[0];
      if (nt.layer !== 1) continue;
      drawSlur(sys, eng, grpJp, sl, Notation.JianPu);
    }
    for (const obj of p.tied) {
      drawTied(sys, eng, grp, obj, Notation.Normal);
      const nt = obj.startNote;
      if (!nt || nt.layer !== 1) continue;
      drawTied(sys, eng, grpJp, obj, Notation.Mixed);
    }
  } else {
    for (const sl of p.slurs) {
      drawSlur(sys, eng, grp, sl);
    }
    for (const obj of p.tied) {
      drawTied(sys, eng, grp, obj);
    }
  }

  if (nota !== Notation.JianPu) {
    for (const ext of p.lrcExtends) {
      drawLrcExtend(sys, eng, grp, ext);
    }
  }

  for (const obj of p.tuplets) {
    if (!sys.overlap(obj)) continue;
    if (sys.contains(obj.startTick) && sys.contains(obj.endTick)) {
      drawTuplet(eng, grp, obj);
    }
  }

  for (const obj of p.endings) {
    if (!sys.overlap(obj)) continue;
    if (sys.contains(obj.startTick) && sys.contains(obj.endTick)) {
      drawEnding(grp, obj, sys, mixed);
    }
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
        drawLrc(eng, grp, md, ps.subIndex);
        drawHarmony(eng, grp, md, ps.subIndex, scr.scaling);
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
  for (const p of scr.parts) {
    drawLineObjs(res, sys, p);
  }
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

