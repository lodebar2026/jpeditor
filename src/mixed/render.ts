// 混排渲染器。从 musicpp model/render.cpp 移植。
// 输入：StaffLayout（已排版）；输出：Group（含 GraphicLine/TextFrame）。
// 单位：tenths（与 StaffLayout 一致）。
// SMuFL 字形用 TextFrame + font.family="Bravura"（等价 SmuflText，无需 LayoutOptions）。

import { Fraction } from "../common/fraction";
import { punctClass } from "../common/cjkpunct";
import { Matrix33, Point } from "../common/geom";
// `Slur` 这个名字在 model.ts 里是**跨度对象**（哪两个音符之间有弧），
// layout.ts 里的是**画出来的那条弧**，所以起个别名区分。
import { GraphicPath, Group, Slur as SlurArc, TextFrame } from "../layout/pageitem";
import { GlyphCodes } from "../smufl/smufl";
import {
  BarGlyph,
  BeamVal,
  ClefSig,
  Ending,
  GroupSymbol,
  LCR,
  LrcExtend,
  PartMeasureLayout,
  MeasureText,
  MixedOptions,
  PartLayout,
  LyricLayout,
  Notation,
  PedalLine,
  Slur,
  Sys,
  SysStaff,
  Tied,
  TimeSig,
  Tuplet,
  Wedge,
  mixedSlurStyle,
  fGe,
  fLt,
  smuflBottom,
  smuflTop,
  smuflWidth,
  slurEnds,
  tiedEnds,
  harmonyBand,
} from "./model";
import { Font } from "../layout/font";
import { layoutHarmonySegs } from "../layout/harmony";
import { addLine, addSmufl, addSmuflScaled, chordGroup, STAFF_SYSTEM, translated, type StaffSystemData } from "./prims";
import { drawJianpuOverlay } from "./jianpuoverlay";

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
  md: PartMeasureLayout,
  subStaff: number,
): void {
  const fs = eng.musicFont.size;
  const meta = eng.meta;

  // ---- noteheads, rests, stems, flags ----
  // 每个和弦收进一个带元素 id 的组（`chordGroup`），编辑器放播放线、认点选用；有东西画才建
  for (const ch of md.chords) {
    const code = ch.sym();
    if (!code) continue;
    let cg: Group | null = null;
    const chordGrp = (): Group => {
      if (!cg) {
        cg = chordGroup(ch.src.id);
        container.add(cg);
      }
      return cg;
    };

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
        addSmuflScaled(chordGrp(), code, x, y, fs, scale, scale);
      } else {
        addSmufl(chordGrp(), code, x, y, fs);
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
          addSmuflScaled(chordGrp(), flagCode, sx, ty, fs, scale, scale);
        } else {
          addSmufl(chordGrp(), flagCode, sx, ty, fs);
        }
      }
    }

    addLine(chordGrp(), sx, sy, sx, ty, eng.lineWidths.stem);
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

    // 附点无条件照 ent.dot.dots 画（render.cpp:1031）：原先还要求本小节存在「非休止的附点音符」，
    // 小节里只有附点休止时（《那一天正来临》）算好的附点会被整条吞掉。
    for (const dotLine of ent.dot.dots) {
      addSmufl(container, GlyphCodes.augmentationDot, ent.dot.dotPos, -5 * dotLine, fs);
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
  start: import("./model").ChordLayout | null;
  end: import("./model").ChordLayout | null;
  level: number;
}

function buildBeamItems(
  chords: import("./model").ChordLayout[],
): BeamItem[] {
  const items: BeamItem[] = [];
  for (let lev = 0; lev < 10; lev++) {
    let start: import("./model").ChordLayout | null = null;
    let last: import("./model").ChordLayout | null = null;
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
  chords: import("./model").ChordLayout[],
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
  md: PartMeasureLayout,
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

/**
 * 月牙形的 slur/tie（render.cpp::drawSlurTied）。
 *
 * 几何与画法**与谱面那一路共用** `SlurTieBase`（layout/layout.ts）——
 * 这里原本是它的逐行副本（同一个 `xlen = min(dist*0.04+10, dist*0.25)`、
 * 同一个 `log10(dist)*17-16`、同一个「去程 cubic + 回程两个控制点各下压 lw0/2」的
 * 填充月牙 + `lw0/4` 细描边），差别只是把 SlurStyle 全部写死成常量。
 * 现在常量收在 `mixedSlurStyle` 里（见那儿的注释）。
 */
function drawSlurTied(
  container: Group,
  plx: number, ply: number,
  prx: number, pry: number,
  above: boolean,
): void {
  const arc = new SlurArc();
  arc.init(new Point(plx, ply), new Point(prx, pry), mixedSlurStyle(above));
  container.add(arc);
}

function drawTied(sys: Sys, eng: MixedOptions, container: Group, obj: Tied, forceNota?: Notation): void {
  const e = tiedEnds(sys, eng, obj, forceNota);
  if (e) drawSlurTied(container, e.plx, e.ply, e.prx, e.pry, e.above);
}

function drawSlur(sys: Sys, eng: MixedOptions, container: Group, slur: Slur, forceNota?: Notation): void {
  const e = slurEnds(sys, eng, slur, forceNota);
  if (e) drawSlurTied(container, e.plx, e.ply, e.prx, e.pry, e.above);
}

// -----------------------------------------------------------------------
// drawLrcExtend（render.cpp::drawLrcExtend）

function drawLrcExtend(
  sys: Sys,
  eng: MixedOptions,
  container: Group,
  ext: LrcExtend,
): void {
  const begin = sys.beginTick();
  const end = sys.endTick();
  if (fGe(ext.startTick, end)) return;
  if (fLt(ext.endTick, begin)) return;

  // stop 为空＝melisma 被休止打断，终点取 endNote（休止前最后续腔音）；否则取下一音节。
  if (!ext.start || (!ext.stop && !ext.endNote)) return;

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
    if (ext.stop) {
      right = ext.stop.x + mifR.xpos() + ext.stop.xOffset;
    } else {
      // 休止打断：止于最后续腔音的右缘
      const en = ext.endNote!;
      right = en.x + smuflWidth(eng.meta, en.chord.sym()) + mifR.xpos();
    }
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
      ntl.octaveJp(),
      ntr.octaveJp(),
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

    [ply, pry] = obj.staffEnds();

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

  // yPos − 30 是房号数字的基线、再往上 20 是括线
  let yPos: number | null = null;
  if ((mixed || scr.autoLayout) && sys.staves.length > 0) {
    const eng = scr.options;
    const st = sys.staves[0];
    if (st.hasHarmony) {
      // 自动铺排的和弦按真实字高（约 18 tenths）：数字基线放到和弦顶上方 4；带坐标的谱照 musicpp
      yPos = scr.autoLayout ? -(st.harmonyY + 3 + harmonyBand(scr)[0]) + 26 : -st.harmonyY + 12;
    } else if (mixed) {
      yPos = -st.minY - eng.mixStaffDist - eng.mixStaffHeight;
    } else {
      yPos = Math.min(20, st.minY + 26); // 20 = 不给 yPos 时的缺省位置；高音、上方弧再往上让
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

function partStaffOffset(sys: Sys, p: PartLayout, staff: number): number {
  return sys.yposPart(p, staff) - sys.yposPart(p, 0);
}

// 跨系统截断：musicpp（render.cpp:2196）仅在 start/end 同属本 system 时绘制松叶，
// wedge 跨换行就整条丢弃。这里主动 diverge——把松叶在每个相交 system 内裁到系统
// 左右边界，端点高度按 tick 线性插值，使断开的渐强/渐弱线在两个系统上各画一段。
function drawWedge(container: Group, obj: Wedge, sys: Sys): void {
  const ypos = partStaffOffset(sys, obj.part, obj.staff) + obj.ypos;
  const mifL = obj.startMeasure;
  const mifR = obj.endMeasure;

  // 端点是否落在当前 system；不在则裁到系统边界。左边界用首小节的数据起点
  // （getEntPos(0)，即谱号/调号之后的音符起始），避免续接段压到行首谱号/调号；
  // 右边界用系统宽（行尾）。
  const startInSys = mifL.system === sys;
  const endInSys = mifR.system === sys;
  const firstMif = sys.measures[0];
  const xL = startInSys
    ? mifL.getEntPos(obj.startTick.minus(mifL.offset)) + mifL.xpos()
    : firstMif.getEntPos(new Fraction(0));
  const xR = endInSys
    ? mifR.getEntPos(obj.endTick.minus(mifR.offset)) + mifR.xpos()
    : sys.width();

  const h = 15.0 / 2;
  // 真实端点：渐强尖端在 start（高 0）、宽口在 end（高 h），渐弱相反。
  // 落在系统边界的断点不按 tick 插值（否则尖端附近的续接段开度过小），固定取
  // BREAK_FRAC×h，使断开的松叶在续接系统上有明显开口。
  const BREAK_FRAC = 0.6;
  const realL = obj.crescendo ? 0 : h;
  const realR = obj.crescendo ? h : 0;
  const hL = startInSys ? realL : h * BREAK_FRAC;
  const hR = endInSys ? realR : h * BREAK_FRAC;

  const path = new GraphicPath();
  path.fill = false;
  path.stroke = true;
  path.strokeColor = 0xff000000;
  path.strokeWidth = 1;
  // 上、下两条边各为独立线段；尖端处两端高度同为 0 自然汇于一点。
  path.moveTo(xL, ypos + hL);
  path.lineTo(xR, ypos + hR);
  path.moveTo(xL, ypos - hL);
  path.lineTo(xR, ypos - hR);
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
  lrc: LyricLayout,
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
  data: PartMeasureLayout,
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
    // 标点挤压：`widthInfo` 量的就是挤压后的宽度，绘制拿同一串笔位（档位同为 `lrc.compress`）。
    if ([...lrc.text].length > 1) {
      const chars = [...lrc.text];
      const run = lrc.font.run(lrc.text, lrc.compress);
      if (eng.musicppHwidGlyphs && lrc.compress === "halfwidth") {
        // musicpp 在字体上真正开 `hwid`，PDF 输出则只有字符和笔位。
        // 不把标点换成 ASCII：保留“，；「《等中文字形，只将其墨迹中心
        // 摆到 `halt` 实测得到的那个 advance 格中心。这也避免全角左括号
        // 按半宽笔位画时被后一字盖住。
        t.charXs = run.xs.map((x0, i) => {
          if (punctClass(chars[i]!) === "none") return x0;
          const x1 = run.xs[i + 1] ?? run.width;
          const ink = lrc.font.charBound(chars[i]!);
          return (x0 + x1) / 2 - (ink.left + ink.right) / 2;
        });
      } else {
        t.charXs = run.xs;
      }
    }
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
  data: PartMeasureLayout,
  subStaff: number,
  scaling: number,
  mixed: boolean,
): void {
  const fontsz = eng.harmonySize / (scaling > 0 ? scaling : 0.45);
  const wordFont = new Font(eng.wordFont, fontsz);
  // SMuFL csym 字形（升降号/和弦质量）。musicpp（render.cpp:541）明确使用同字号的
  // "Bravura Text"。不能拿 Bravura 乘一个统一比例代替：两款字体的 csym 升降号等大，
  // diminished/augmented 等质量字形却不是同一比例；只有实际 Text 字体能逐字形对齐。
  const musicFont = new Font("Bravura Text", fontsz);
  // 整小节休止的混排小节，offset==0 的和弦标记右移 15（render.cpp:504-515）。
  const measureRest =
    mixed && data.chords.length === 1 && data.chords[0].measureRest;
  for (const h of data.harmonies) {
    if (h.staff !== subStaff) continue;
    const mixedOffsetForRest =
      measureRest && h.offset.compareTo(new Fraction(0)) === 0 ? 15 : 0;
    const segs = h.asText();

    // 总宽照 musicpp TextBlock::width：上/下标按 0.75 缩放后的 advance。按未缩放算，A(sus4) 这类
    // 长上标的和弦会整体左偏（KL2020《基督是锚》第 9 小节偏 18 tenths）
    const width = segs.reduce((w, s) => w + (s.music ? musicFont : wordFont).measureText(s.text) * (s.superscript ? 0.75 : 1), 0);
    // 分段排版与文本谱共用（src/layout/harmony.ts）
    const grp = layoutHarmonySegs(segs, wordFont, musicFont, 0xff000000);

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
  const bySize = t.measure.part.score.options.textLineHeightBySize;

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
    // 行高与谱行包围盒（model.ts::tightLineHeights）同一口径：歌本按字号（musicpp Font::height()），
    // 否则多行文字块画得比包围盒高，压进下面的简谱与歌词（《那一天正来临》开头的楷体引言）
    const fm = it.font.metrics;
    h = Math.max(h, bySize ? (it.nominalSize ?? it.font.size) : fm.descent - fm.ascent);
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

function drawTextBlocks(container: Group, data: PartMeasureLayout, subStaff: number): void {
  for (const t of data.textBlocks) {
    if (t.staff !== subStaff) continue;
    drawTextBlock(container, t);
  }
}

// -----------------------------------------------------------------------
// drawLineObjs（render.cpp::drawLineObjs）— span objects per part per system

function drawLineObjs(container: Group, sys: Sys, p: PartLayout): void {
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
      if (!nt.jpMelody) continue;
      drawSlur(sys, eng, grpJp, sl, Notation.JianPu);
    }
    for (const obj of p.tied) {
      drawTied(sys, eng, grp, obj, Notation.Normal);
      const nt = obj.startNote;
      if (!nt || !nt.jpMelody) continue;
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
    // 与 musicpp 不同：相交即绘制，drawWedge 内部按系统边界裁断（跨换行的松叶）。
    drawWedge(grp, obj, sys);
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
  mif: import("./model").MeasureLayout,
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
  mif: import("./model").MeasureLayout,
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
        // 末小节的数据区/小节线已经另留了 5 tenths 间距；预告拍号自身只退它的宽度。
        // musicpp render.cpp::drawSysStaff 同样是 `endPos -= timeChangeWidth`。
        endPos -= sys.timeChangeWidth;
        const next = scr.measures[m.index + 1];
        if (!isJp) drawTime(eng, grp, next, ps, endPos);
      }
      if (sys.keyChangeWidth > 0 && m.index + 1 < scr.measures.length) {
        // 与 musicpp 一致：5 tenths 是小节线与预告属性之间的空隙，不属于调号宽度。
        endPos -= sys.keyChangeWidth;
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

    // 简谱叠层（混排第一子谱表）：`jianpuoverlay.ts`
    if (nota === Notation.Mixed && ps.subIndex === 0) drawJianpuOverlay(grp, sys, st, m);

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
  let top: number | null = null;
  for (const st of sys.staves) {
    if (!st.staffVisible) continue;
    ypos += st.distance;
    // 谱表带上沿：混排第一子谱表连同上方的简谱层（与 `drawJianpuOverlay` 的 jpOffY 同式）
    const mixedTop = st.partStaff.getNotation(new Fraction(0)) === Notation.Mixed && st.partStaff.subIndex === 0
      ? ypos + st.minY - eng.mixStaffDist - eng.mixStaffHeight
      : ypos;
    top ??= mixedTop;
    drawSysStaff(res, sys, st, ypos);
    ypos += st.height();
  }
  res.classes.add(STAFF_SYSTEM);
  res.data = { top: top ?? 0, bottom: ypos } satisfies StaffSystemData;

  drawBarline(eng, res, sys);
  drawPartGroups(res, sys);
  for (const p of scr.parts) {
    drawLineObjs(res, sys, p);
  }
  return res;
}
