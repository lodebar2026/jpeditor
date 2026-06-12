// 混排渲染器。从 musicpp model/render.cpp 移植。
// 输入：MixedScore（已排版）；输出：Group（含 GraphicLine/TextFrame）。
// 单位：tenths（与 MixedScore 一致）。
// SMuFL 字形用 TextFrame + font.family="Bravura"（等价 SmuflText，无需 LayoutOptions）。

import { Fraction } from "../common/fraction";
import { Matrix33, Point } from "../common/geom";
import { GraphicLine, GraphicPath, Group, TextFrame } from "../layout/layout";
import { GlyphCodes } from "../smufl/smufl";
import {
  AccidentalStat,
  accidentalSym,
  BarGlyph,
  BeamVal,
  ClefSig,
  Ending,
  GroupSymbol,
  LCR,
  LrcExtend,
  MeasureData,
  MeasureText,
  MixedOptions,
  MixedPart,
  MLyric,
  MNote,
  Notation,
  PedalLine,
  Slur,
  Sys,
  SysStaff,
  Tied,
  TimeSig,
  Tuplet,
  Wedge,
  calcSlurPoints,
  fGe,
  fLt,
  slurTiedPos,
  slurTiedPosForJp,
  smuflBottom,
  smuflTop,
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
      const cue = n.size === 1 || ch.cue || ch.grace;
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
          if (ch.noteType.compareTo(new Fraction(4)) >= 0) x += 5;
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
    // 符干末端含 stemExtra（render.cpp:401-406：跨谱表符杠延伸符干以接到符杠）。
    const extra = ch.stemUp ? -ch.stemExtra : ch.stemExtra;
    const ty = ch.tailY(true) + extra - md.staffY(subStaff);

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

  // ---- notations (fermata 等) —— render.cpp:328 drawChord 非简谱分支 ----
  for (const ch of md.chords) {
    if (ch.notations.length === 0 || ch.notes.length === 0) continue;
    if (ch.notes[0].staff !== subStaff) continue;
    const stemX = ch.stemX();
    for (const nota of ch.notations) {
      let x = stemX + nota.dx;
      if (ch.stemUp && ch.noteType.compareTo(new Fraction(4)) < 0) {
        x -= ch.noteheadWidth(meta);
      }
      addSmufl(container, nota.symbol, x, nota.y, fs);
    }
  }

  // ---- arpeggio（render.cpp:2234 drawMeasureMeta）：竖向波浪线，整 part 画一次 ----
  if (subStaff === 0) {
    for (const arp of md.arpegs) {
      if (arp.notes.length === 0) continue;
      const n0 = arp.notes[0];
      const n1 = arp.notes[arp.notes.length - 1];
      const y0 = md.staffY(n0.staff) + n0.cy() + 5;
      const y1 = md.staffY(n1.staff) + n1.cy() - 5;
      const cnt = Math.max(1, Math.ceil((y0 - y1) / 12.0));
      const str = GlyphCodes.wiggleTrillSlow.repeat(cnt);
      const x = md.measureInfo.getEntPos(n0.chord.offset) - 12;
      const grp = new Group();
      const m = new Matrix33();
      m.setAffine([0, 1, -1, 0, x, y1]); // translate(x,y1) ∘ rotate(90°)
      grp.matrix = m;
      addSmufl(grp, str, 0, 0, fs);
      container.add(grp);
    }
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

  let above = slur.above;
  let plx = 0, ply = 0, prx = 0, pry = 0;

  if (nota === Notation.JianPu) {
    above = true; // 简谱层 slur 一律朝上（render.cpp::drawSlur）
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

  if (!ext.start || !ext.stop) return;

  const hasPrev = fLt(ext.startTick, begin);
  const hasNext = fGe(ext.endTick, end);

  // 跨系统时分段：musicpp render.cpp:1262-1265 留作 //todo，此处补全——
  // 续接段从本系统内容起点画，跨出段画到本系统末尾（对齐 Sibelius 原谱）。
  const m0 = sys.measures[0];
  const mLast = sys.measures[sys.measures.length - 1];
  const sysLeft = m0.xpos() + m0.dataPos;
  const sysRight = mLast.xpos() + mLast.width;

  let left: number;
  let right: number;
  if (hasPrev) {
    left = sysLeft;
  } else {
    const mifL = ext.startChord().measure.measureInfo;
    left = ext.start.x + mifL.xpos() + ext.start.xOffset + ext.start.width;
  }
  if (hasNext) {
    right = sysRight;
  } else {
    const mifR = ext.endChord().measure.measureInfo;
    right = ext.stop.x + mifR.xpos() + ext.stop.xOffset;
  }

  const y = -ext.start.y;
  addLine(container, left, y, right, y, 1);
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
    // 端点对齐到简谱数字中心（render.cpp:1393：ntl->x + 数字宽/2）。
    const wl = eng.jianpuFont.measureText(ntl.number());
    const wr = eng.jianpuFont.measureText(ntr.number());
    plx = ntl.x + wl / 2 + chl.measure.xpos();
    prx = ntr.x + wr / 2 + chr.measure.xpos();
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
  const fsScale = eng.musicFont.size / 40;
  const numW = TimeSig.width(eng.meta, obj.timeModification.denominator) * fsScale;
  // 数字垂直居中：cy + 字形高/2（render.cpp:1455-1457 txt->height/2）。
  const g0 = numStr[0] ?? "";
  const numH = (smuflTop(eng.meta, g0) - smuflBottom(eng.meta, g0)) * fsScale;
  addSmufl(container, numStr, cx - numW / 2, cy + numH / 2, eng.musicFont.size);
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

  const grp = translated(0, yPos !== null ? yPos - vlen : 0);
  grp.add(bpath);

  const numFont = new Font(eng.wordFont, 20);
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
// drawWedge / drawPedalLine（render.cpp::drawWedge / drawPedalLine）
// container 已平移到 part 顶（yposPart(p,0)）；ypos 加上 staff 内偏移。

function partStaffOffset(sys: Sys, p: MixedPart, staff: number): number {
  return sys.yposPart(p, staff) - sys.yposPart(p, 0);
}

function drawWedge(container: Group, obj: Wedge, sys: Sys): void {
  const ypos = partStaffOffset(sys, obj.part, obj.staff) + obj.ypos;
  const mifL = obj.startMeasure;
  const mifR = obj.endMeasure;
  const left = mifL.getEntPos(obj.startTick.minus(mifL.offset)) + mifL.xpos();
  const right = mifR.getEntPos(obj.endTick.minus(mifR.offset)) + mifR.xpos();

  const h = 15.0 / 2;
  let topX: number, botX: number, centerX: number;
  if (obj.crescendo) {
    topX = right;
    botX = right;
    centerX = left;
  } else {
    topX = left;
    botX = left;
    centerX = right;
  }

  const path = new GraphicPath();
  path.fill = false;
  path.stroke = true;
  path.strokeColor = 0xff000000;
  path.strokeWidth = 1;
  path.moveTo(topX, ypos + h);
  path.lineTo(centerX, ypos);
  path.lineTo(botX, ypos - h);
  container.add(path);
}

function drawPedalLine(container: Group, obj: PedalLine, sys: Sys): void {
  const ypos = partStaffOffset(sys, obj.part, obj.staff) + obj.ypos;
  const mifL = obj.startMeasure;
  const mifR = obj.endMeasure;
  const left = mifL.getEntPos(obj.startTick.minus(mifL.offset)) + mifL.xpos();
  const right = mifR.getEntPos(obj.endTick.minus(mifR.offset)) + mifR.xpos();

  const vlen = 10;
  const path = new GraphicPath();
  path.fill = false;
  path.stroke = true;
  path.strokeColor = 0xff000000;
  path.strokeWidth = 1;
  path.moveTo(left, ypos - vlen);
  path.lineTo(left, ypos);
  path.lineTo(right, ypos);
  path.lineTo(right, ypos - vlen);
  container.add(path);
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
  mixed: boolean,
): void {
  const fontsz = eng.harmonySize / (scaling > 0 ? scaling : 0.45);
  const wordFont = new Font(eng.wordFont, fontsz);
  // SMuFL csym 字形（升降号/和弦质量）。musicpp（render.cpp:541）用 "Bravura Text" 内联变体，
  // 但本工程 webview 只注册了 "Bravura"（styles.css @font-face），且其含同一套记号字形，故用 Bravura。
  const musicFont = new Font("Bravura", fontsz);
  // 整小节休止的混排小节，offset==0 的和弦标记右移 15（render.cpp:504-515）。
  const measureRest =
    mixed && data.chords.length === 1 && data.chords[0].measureRest;
  for (const h of data.harmonies) {
    if (h.staff !== subStaff) continue;
    const mixedOffsetForRest =
      measureRest && h.offset.compareTo(new Fraction(0)) === 0 ? 15 : 0;
    const segs = h.asText();

    // 总宽：未缩放的 advance 之和（对齐 musicpp TextBlock::width 的居中口径）
    let width = 0;
    for (const s of segs) width += (s.music ? musicFont : wordFont).measureText(s.text);

    const grp = new Group();
    let xpos = 0;
    for (const s of segs) {
      const font = s.music ? musicFont : wordFont;
      const t = new TextFrame();
      t.text = s.text;
      t.font = font;
      t.color = 0xff000000;
      let scl = 1;
      if (s.superscript === 1 || s.superscript === -1) {
        scl = 0.75;
        const dy = s.superscript === 1 ? -font.size / 4 : font.size / 4;
        const g = new Group();
        const m = new Matrix33();
        m.setAffine([scl, 0, 0, scl, xpos, dy]);
        g.matrix = m;
        g.add(t);
        grp.add(g);
      } else {
        t.x = xpos;
        t.y = s.dy;
        grp.add(t);
      }
      xpos += font.measureText(s.text) * scl;
    }

    const m = new Matrix33();
    m.setAffine([
      1, 0, 0, 1,
      h.x - width / 2 + 6.5 + mixedOffsetForRest,
      -h.y + wordFont.metrics.descent,
    ]);
    grp.matrix = m;
    container.add(grp);
  }
}

// -----------------------------------------------------------------------
// drawTextBlock（render.cpp::drawTextBlock）— <direction> 文本（如「(副歌)」）

/** 绘制单个 TextBlock（逐行 justify，对齐 render.cpp::drawTextBlock 非 useTextArea 分支）。 */
function drawTextBlock(container: Group, t: MeasureText): void {
  if (t.data.length === 0) return;

  // 逐行宽/高
  const lineW: number[] = [];
  const lineH: number[] = [];
  let w = 0;
  let h = 0;
  for (const it of t.data) {
    if (it.text === "\n") {
      lineW.push(w);
      lineH.push(h);
      w = 0;
      h = 0;
      continue;
    }
    w += it.font.measureText(it.text);
    const fm = it.font.metrics;
    h = Math.max(h, fm.descent - fm.ascent);
  }
  lineW.push(w);
  lineH.push(h);
  const totalW = Math.max(...lineW);

  let line = 0;
  let xpos = 0;
  let ypos = 0;
  let first = true;
  for (const it of t.data) {
    const content = it.text;
    if (content === "\n") {
      line += 1;
      if (line >= lineH.length) break;
      ypos += lineH[line] * 1.444;
    }
    if (first || content === "\n") {
      const diff = totalW - lineW[line];
      xpos = t.justify === LCR.Right ? diff : t.justify === LCR.Center ? diff / 2 : 0;
    }
    first = false;
    if (content === "\n") continue;

    const tf = new TextFrame();
    tf.text = content;
    tf.font = it.font;
    tf.color = 0xff000000;
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1, t.x + xpos, -t.y + ypos]);
    tf.matrix = m;
    container.add(tf);
    xpos += it.font.measureText(content);
  }
}

function drawTextBlocks(container: Group, data: MeasureData, subStaff: number): void {
  for (const t of data.textBlocks) {
    if (t.staff !== subStaff) continue;
    drawTextBlock(container, t);
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

  for (const obj of p.wedges) {
    if (!sys.overlap(obj)) continue;
    if (sys.contains(obj.startTick) && sys.contains(obj.endTick)) {
      drawWedge(grp, obj, sys);
    }
  }

  for (const obj of p.pedalLines) {
    if (!sys.overlap(obj)) continue;
    if (sys.contains(obj.startTick) && sys.contains(obj.endTick)) {
      drawPedalLine(grp, obj, sys);
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
  const inc = num > 0 ? 4 : 3; // 降号步进为 3（render.cpp drawKeyAccid）
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
  repForBack = false,
): number {
  // 整组小节线右缘对齐到 x（向左生长），与谱线右端接齐（render.cpp drawBarlineItem）。
  const lw = eng.lineWidths;
  const light = lw.lightBarline;
  const thick = lw.heavyBarline;
  const dist = eng.barlineDist;
  const widths: number[] = [];
  if (repForBack) {
    // 反复结束/双向反复：light-heavy-light（与左侧 Final 合并的情况）。
    widths.push(light, thick, light);
  } else {
    switch (style) {
      case BarGlyph.Single: widths.push(light); break;
      case BarGlyph.Double: widths.push(light, light); break;
      case BarGlyph.HeavyHeavy: widths.push(thick, thick); break;
      case BarGlyph.Final: widths.push(light, thick); break;
      case BarGlyph.ReverseFinal: widths.push(thick, light); break;
      case BarGlyph.None:
      default:
        return 0;
    }
  }
  let w = 0;
  for (const ww of widths) w += ww;
  w += (widths.length - 1) * dist;
  let xx = x - w;
  for (const ww of widths) {
    const cx = xx + ww / 2;
    addLine(container, cx, top, cx, bot, ww);
    xx += dist + ww;
  }
  return w;
}

/** 反复双点。主谱画两个 repeatDot（第 2、3 间），混排谱在上方简谱层再画一组缩小版。
 *  对齐 render.cpp::drawRepeatDots（mixStaves 分支）。 */
function drawRepeatDots(
  eng: MixedOptions,
  container: Group,
  sys: Sys,
  x: number,
  mixStaves: Set<number>,
): void {
  for (let i = 0; i < sys.staves.length; i++) {
    const st = sys.staves[i];
    if (!st.staffVisible) continue;
    const y0 = sys.ypos(i);
    if (mixStaves.has(i)) {
      const yoff = st.minY - eng.mixStaffHeight - eng.mixStaffDist;
      const sc = eng.mixStaffHeight / 40;
      const fs = eng.musicFont.size;
      addSmuflScaled(container, GlyphCodes.repeatDot, x, y0 + yoff + 15 * sc, fs, sc, sc);
      addSmuflScaled(container, GlyphCodes.repeatDot, x, y0 + yoff + 25 * sc, fs, sc, sc);
    }
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
    // 小节号（render.cpp:1706-1712）。默认 hideBarNumber=true 时不显示。
    if (m.showBarNumber && !eng.hideBarNumber) {
      const num = new TextFrame();
      num.text = m.number;
      num.font = new Font(eng.wordFont, 20);
      num.color = 0xff000000;
      num.x = m.xpos();
      num.y = -25;
      container.add(num);
    }
    let dx = 0;
    if (idx + 1 < sys.measures.length) dx = -sys.measures[idx + 1].sibKeyOffset;
    styles.push(m.rightBarline ?? BarGlyph.Single);
    xpos.push(m.xpos() + m.width + dx);
  }

  if (sys.timeChangeWidth > 0) xpos[xpos.length - 1] -= sys.timeChangeWidth + 5;
  if (sys.keyChangeWidth > 0) xpos[xpos.length - 1] -= sys.keyChangeWidth + 5;

  // merge left barlines into styles array（lightHeavyLight：左 Final 与右 Final 合并成
  // light-heavy-light 的双向反复，render.cpp drawBarline）。
  const lightHeavyLight = new Set<number>();
  for (let idx = 0; idx < sys.measures.length; idx++) {
    const m = sys.measures[idx];
    if (m.leftBarline !== null) {
      const orig = styles[idx];
      if (orig === null || orig === BarGlyph.Single) styles[idx] = m.leftBarline;
      else if (orig === BarGlyph.Final) lightHeavyLight.add(idx);
    }
  }

  const grps = sys.barlineGroups();
  const scr = sys.score;

  // 混排谱所在的 staff 下标集合 + 其 minY（render.cpp drawBarline）。
  const t0 = sys.measures[0].offset;
  const mixStaves = new Set<number>();
  let miny = 0;
  for (let i = 0; i < sys.staves.length; i++) {
    if (sys.staves[i].partStaff.getNotation(t0) === Notation.Mixed) {
      miny = sys.staves[i].minY;
      mixStaves.add(i);
    }
  }

  for (let i = 0; i < styles.length; i++) {
    const st = styles[i];
    if (st === null) continue;
    let x = xpos[i];
    const rep = lightHeavyLight.has(i);
    let width = 0;

    for (const [first, last] of grps) {
      const stb = sys.staves[last];
      const top = sys.ypos(first);
      const bot = sys.ypos(last) + stb.height();

      if (rep) x += 15;

      // mixed jp-staff barline segment above main staff
      if (mixStaves.has(first)) {
        const mixTop = miny + top - eng.mixStaffHeight - eng.mixStaffDist;
        const mixBot = mixTop + eng.mixStaffHeight;
        drawBarlineItem(eng, container, st, x, mixTop, mixBot, rep);
      }

      width = drawBarlineItem(eng, container, st, x, top, bot, rep);
    }

    const mid = i + sys.firstMeasure;
    if (i < styles.length - 1 && mid < scr.measures.length && scr.measures[mid].forward) {
      drawRepeatDots(eng, container, sys, x + 7, mixStaves);
    }
    if (i > 0 && mid > 0 && scr.measures[mid - 1].backward) {
      drawRepeatDots(eng, container, sys, x - (width + 7), mixStaves);
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

// -----------------------------------------------------------------------
// M4: 简谱混排层（drawNotesJianPu / drawJpBeams / drawAccidentalJianPu /
//               drawJpTimeSignature）

/** Draw jianpu number layer for one measure（render.cpp::drawNotesJianPu）。 */
function drawNotesJianPu(
  eng: MixedOptions,
  container: Group,
  md: MeasureData,
  subStaff: number,
  mix: boolean,
): void {
  const staffHeight = mix ? eng.mixStaffHeight : 40;
  const sc = staffHeight / 40;
  const font = mix ? eng.mixFont : eng.jianpuFont;
  const mif = md.measureInfo;
  const meta = eng.meta;

  for (const ch of md.chords) {
    if (ch.slash) continue;
    for (const n of ch.notes) {
      if (n.staff !== subStaff) continue;
      if (!n.visible) continue;
      if (mix) {
        if (n.layer !== 1) continue;
        if (ch.cue) continue;
      }

      let x: number;
      let measureRest = false;
      if (ch.rest) {
        if (ch.measureRest) measureRest = true;
        const dur = ch.dur;
        if (dur.compareTo(mif.dur) === 0) measureRest = true;
      }

      if (measureRest) {
        x = mif.dataPos + 5;
        // 宽小节再右移 10（render.cpp:834-839）。
        const dataWidth = mif.dataEnd - mif.dataPos;
        const numw = font.measureText("0") * mif.dur.toInt();
        if (dataWidth > 2 * numw) x += 10;
      } else {
        x = n.cx(meta);
        if (n.x < 0) continue;
      }

      const num = n.number();
      const str = String(num);
      const nw = font.measureText(str);
      x -= nw / 2;

      // grace：数字缩小并整体上移（render.cpp:856-869）。
      const graceSc = ch.grace ? eng.jpGraceScale : 1;
      const graceDy = ch.grace ? -30 : 0;
      let ypos = font.size;
      if (ch.grace) ypos *= 0.1;

      if (ch.grace) {
        const g = new Group();
        const m = new Matrix33();
        m.setAffine([graceSc, 0, 0, graceSc, x, ypos]);
        g.matrix = m;
        const t = new TextFrame();
        t.text = str;
        t.font = font;
        t.color = 0xff000000;
        g.add(t);
        container.add(g);
      } else {
        const t = new TextFrame();
        t.text = str;
        t.font = font;
        t.color = 0xff000000;
        t.x = x;
        t.y = ypos;
        container.add(t);
      }

      // octave dots
      const oct = n.octaveJp(eng.addOctaveJpForKeyA);
      if (oct !== 0) {
        let octY: number;
        if (oct > 0) {
          octY = 3 - eng.jpTopDy;
        } else {
          octY = staffHeight + eng.beamDistJP * ch.jpBeamCount();
          octY -= 2;
        }
        const dotStr = ".";
        const dotW = font.measureText(dotStr);
        for (let i = 0; i < Math.abs(oct); i++) {
          const dx0 = x + nw / 2 - dotW / 2;
          const dy0 = octY + i * eng.octaveDotDist * sc * graceSc + graceDy;
          if (ch.grace) {
            const g = new Group();
            const m = new Matrix33();
            m.setAffine([graceSc, 0, 0, graceSc, dx0, dy0]);
            g.matrix = m;
            const dd = new TextFrame();
            dd.text = dotStr;
            dd.font = font;
            dd.color = 0xff000000;
            g.add(dd);
            container.add(g);
          } else {
            const dd = new TextFrame();
            dd.text = dotStr;
            dd.font = font;
            dd.color = 0xff000000;
            dd.x = dx0;
            dd.y = dy0;
            container.add(dd);
          }
        }
      }

      // duration extensions / dots
      const noteType = ch.noteType;
      const one = new Fraction(1);
      if (noteType.compareTo(one) > 0) {
        // noteType > 1 (half, whole, etc.): draw dashes
        const dur = ch.dur;
        const end = dur.plus(ch.offset);
        const endPos = mif.getEntPos(end);
        // 截断取整（对齐 boost::rational_cast<int>），整小节休止用小节时值分子（render.cpp:920-923）。
        let cnt = dur.toInt();
        if (measureRest) cnt = mif.dur.numerator;
        const dx = cnt > 0 ? (endPos - x) / cnt : 0;
        for (let c = 1; c < cnt; c++) {
          const xx = x + dx * c;
          const dig = ch.rest ? "0" : "-";
          const rep = new TextFrame();
          rep.text = dig;
          rep.font = font;
          rep.color = 0xff000000;
          rep.x = xx;
          rep.y = ypos;
          container.add(rep);
        }
      } else {
        // noteType <= 1: draw augmentation dots
        for (let d = 0; d < ch.dot; d++) {
          const dd = new TextFrame();
          dd.text = ".";
          dd.font = font;
          dd.color = 0xff000000;
          const dotDx = (nw / 2 + 10) * (mix ? 0.75 : 1);
          dd.x = x + dotDx;
          dd.y = font.size * 0.75;
          container.add(dd);
        }
      }
    }
  }
}

/** Draw jp beam underlines for one measure（render.cpp::BeamLevelData::drawJianPu）。 */
function drawJpBeams(
  eng: MixedOptions,
  container: Group,
  md: MeasureData,
  mix: boolean,
): void {
  const staffHeight = mix ? eng.mixStaffHeight : 40;
  const sc = staffHeight / 40;
  const diff = 40 - staffHeight;
  const font = mix ? eng.mixFont : eng.jianpuFont;
  const meta = eng.meta;

  for (const grp of md.jpBeams) {
    if (grp.chords.length === 0) continue;
    // skip cue groups
    if (grp.chords.some((ch) => ch.cue)) continue;

    for (let lev = 0; lev < 10; lev++) {
      // 收集本层的连续减时线段（render.cpp:32-58 processLevelJp）——同层可有多段，
      // 不能用全局首/尾连成一条。
      type MChord = import("./model").MChord;
      const runs: [MChord, MChord][] = [];
      let start: MChord | null = null;
      let end: MChord | null = null;
      for (const ch of grp.chords) {
        if (ch.jpBeamCount() <= lev) {
          if (start && end) runs.push([start, end]);
          start = null;
          end = null;
          continue;
        }
        if (!start) start = ch;
        end = ch;
      }
      if (start && end) runs.push([start, end]);
      if (runs.length === 0) break;

      for (const [first, last] of runs) {
        const ntL = first.notes.find((n) => n.layer === 1 || !mix) ?? first.notes[0];
        const ntR = last.notes.find((n) => n.layer === 1 || !mix) ?? last.notes[0];

        const grace = first.grace;
        const graceSc = grace ? eng.jpGraceScale : 1;
        const numL = ntL.number();
        const numR = ntR.number();
        // 端点 = 数字中心 ±数字宽/2（grace 整体按 jpGraceScale 缩放，render.cpp:146-160）。
        const lx =
          ntL.x + (first.noteheadWidth(meta) / 2 - font.measureText(numL) / 2) * graceSc;
        const rx =
          ntR.x + (last.noteheadWidth(meta) / 2 + font.measureText(numR) / 2) * graceSc;
        let y = lev * eng.beamDistJP * sc + 35 - diff * 0.8;

        if (grace) {
          // grace 减时线上移并加尾钩（render.cpp:165-186）。
          y -= 29;
          const cx = (rx + lx) / 2;
          const hook = new GraphicPath();
          hook.fill = false;
          hook.stroke = true;
          hook.strokeColor = 0xff000000;
          hook.strokeWidth = 1;
          hook.moveTo(cx, y);
          hook.lineTo(cx, y + 5);
          hook.cubicTo(cx, y + 10, cx, y + 10, cx + 10, y + 10);
          hook.lineTo(cx + 10, y + 10);
          const oct = ntL.octaveJp(eng.addOctaveJpForKeyA);
          if (oct < 0 && ntL === ntR) {
            const g = translated(0, 10);
            g.add(hook);
            container.add(g);
          } else {
            container.add(hook);
          }
        }

        addLine(container, lx, y, rx, y, eng.lineWidths.jpBeam);
      }
    }
  }
}

/** Draw accidentals for jp layer（render.cpp::drawAccidentalJianPu）。 */
function drawAccidentalJianPu(
  eng: MixedOptions,
  container: Group,
  md: MeasureData,
  subStaff: number,
): void {
  const meta = eng.meta;
  const sc = 0.75;
  // 收集本子谱号、本小节的简谱层音符，按时值排序后用 AccidentalStat 推算临时记号
  // （render.cpp::drawAccidentalJianPu）——简谱记号要按调号推算，不能直接照搬
  // MusicXML 的 <accidental>。
  const notes: MNote[] = [];
  for (const ch of md.chords) {
    if (ch.rest) continue;
    for (const n of ch.notes) {
      if (n.staff !== subStaff) continue;
      if (!n.visible) continue;
      if (n.layer !== 1) continue;
      if (n.x < 0) continue;
      notes.push(n);
    }
  }
  notes.sort((a, b) => a.chord.offset.compareTo(b.chord.offset));

  const ps = md.part.staves[subStaff];
  const key = ps.getKey(md.measureInfo.offset);
  const stat = new AccidentalStat(key.fifths);

  for (const n of notes) {
    const alt = stat.process(n.writtenPitch % 7, n.alter);
    if (alt === null) continue;
    const sym = accidentalSym(alt, true);
    const w = smuflWidth(meta, sym);
    const grp2 = new Group();
    const m = new Matrix33();
    m.setAffine([sc, 0, 0, sc, n.x - w * sc - 2, 20]);
    grp2.matrix = m;
    addSmufl(grp2, sym, 0, 0, eng.musicFont.size);
    container.add(grp2);
  }
}

/** Draw time signature for jp/mixed staff（render.cpp::drawTime Mixed branch）。 */
function drawJpTimeSignature(
  eng: MixedOptions,
  container: Group,
  mif: import("./model").MeasureInfo,
  ps: import("./model").PartStaff,
  x: number,
): void {
  const time = ps.getTime(mif.offset);
  const staffHeight = eng.mixStaffHeight;
  const sc = staffHeight / 40;
  const font = eng.mixFont;

  const beats = String(time.beats);
  const beatType = String(time.beatType);
  const w1 = font.measureText(beats);
  const w2 = font.measureText(beatType);
  const lineW = Math.max(w1, w2) + 1;

  const grp = translated(x, 0);

  // 数字垂直偏移 = jianpuFont 降部 × 缩放（render.cpp:2085-2088 Mixed 分支）。
  const dy = eng.jianpuFont.metrics.descent * sc;
  const t1 = new TextFrame();
  t1.text = beats;
  t1.font = font;
  t1.color = 0xff000000;
  t1.x = 0;
  t1.y = sc * (20 - dy);
  grp.add(t1);

  const t2 = new TextFrame();
  t2.text = beatType;
  t2.font = font;
  t2.color = 0xff000000;
  t2.x = 0;
  t2.y = sc * (40 + dy);
  grp.add(t2);

  addLine(grp, -1, staffHeight / 2, lineW, staffHeight / 2, 1.5);
  container.add(grp);
}

/** Draw jianpu key indicator「1=X」for jp/mixed staff（render.cpp::drawKey JianPu/Mixed 分支）。 */
function drawJpKey(
  eng: MixedOptions,
  container: Group,
  mif: import("./model").MeasureInfo,
  ps: import("./model").PartStaff,
  st: SysStaff,
): void {
  const key = ps.getKey(mif.offset);
  const cur = key.fifths;
  const names = "CGDAEBFC";

  let name = mif.index !== 0 ? "转" : "";
  name += "1=";
  let keyName: string;
  let acc = 0;
  if (cur >= 0) {
    keyName = names[cur] ?? "C";
    if (cur >= 6) acc = 1;
  } else {
    keyName = names[7 + cur] ?? "C";
    if (cur < -1) acc = -1;
  }

  let x = (mif.keyPos ?? 0) - mif.sibKeyOffset;
  if (mif.keyOffestJP !== null) x += mif.keyOffestJP;
  let center = true;
  if (mif === mif.system.measures[0]) {
    center = false;
    x = 0;
  }

  // y relative to main staff top line (negative = above); Mixed branch
  let y = -70;
  if (mif.index === 0) y -= 30; // 避开和弦
  else y = -st.harmonyY;

  const jpFont = eng.jianpuFont;
  if (acc !== 0) {
    const grp = new Group();
    const str1 = new TextFrame();
    str1.text = name;
    str1.font = jpFont;
    str1.color = 0xff000000;
    grp.add(str1);
    let w = jpFont.measureText(name) + 7;

    const accSym = acc < 0 ? GlyphCodes.accidentalFlat : GlyphCodes.accidentalSharp;
    const sc = jpFont.size / 40;
    addSmuflScaled(grp, accSym, w, -10, eng.musicFont.size, sc, sc);
    w += 12;

    const str2 = new TextFrame();
    str2.text = keyName;
    str2.font = jpFont;
    str2.color = 0xff000000;
    str2.x = w;
    grp.add(str2);
    w += jpFont.measureText(keyName);

    if (center) x -= w / 2;
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1, x, y]);
    grp.matrix = m;
    container.add(grp);
  } else {
    name += keyName;
    const ff = new Font(eng.wordFont, jpFont.size * 0.75);
    const t = new TextFrame();
    t.text = name;
    t.font = ff;
    t.color = 0xff000000;
    if (center) x -= ff.measureText(name) / 2;
    t.x = x;
    t.y = y;
    container.add(t);
  }
}

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

    // notes, beams, lyrics, harmony
    if (!isJp) {
      const md = ps.part.measures[m.index];
      if (md) {
        drawNotesNormal(eng, grp, md, ps.subIndex);
        drawBeams(grp, md, ps.subIndex);
        drawLrc(eng, grp, md, ps.subIndex);
        drawHarmony(eng, grp, md, ps.subIndex, scr.scaling, nota === Notation.Mixed);
        drawTextBlocks(grp, md, ps.subIndex);
      }
    }

    // M4: 简谱混排层（只在 Mixed 通知第一 sub-staff 时绘制）
    if (nota === Notation.Mixed && ps.subIndex === 0) {
      const md = ps.part.measures[m.index];
      if (md) {
        const jpOffY = st.minY - eng.mixStaffDist - eng.mixStaffHeight;
        const grpJp = translated(0, jpOffY);
        grp.add(grpJp);

        // jianpu key「1=X」at first measure overall or on key change (drawn in main group)
        if (eng.showKeyChangeJp && (m.index === 0 || ps.keyChange(m.offset)) && m.keyPos !== null) {
          drawJpKey(eng, grp, m, ps, st);
        }

        // jp 拍号：曲首及任何拍号变更处（对齐 render.cpp drawSysStaff mixed 分支，
        // 条件统一为 timeChange——layoutAttr 仅在变更时分配 timePos）。
        if (ps.timeChange(m.offset) && m.timePos !== null) {
          drawJpTimeSignature(eng, grpJp, m, ps, m.timePos);
        }
        // 系统末尾的预告拍号（下一系统起始的新拍号）——与主谱 trailing 一致，
        // 对齐 render.cpp:2361-2363 的 if(mixed) drawTime(...Mixed...)。
        if (
          m === sys.measures[sys.measures.length - 1] &&
          sys.timeChangeWidth > 0 &&
          m.index + 1 < scr.measures.length
        ) {
          const next = scr.measures[m.index + 1];
          drawJpTimeSignature(eng, grpJp, next, ps, m.width - sys.timeChangeWidth - 5);
        }

        drawNotesJianPu(eng, grpJp, md, ps.subIndex, true);
        drawAccidentalJianPu(eng, grpJp, md, ps.subIndex);
        drawJpBeams(eng, grpJp, md, true);
      }
    }

    xpos += m.width;
  }
}

// -----------------------------------------------------------------------
// drawSystem

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
