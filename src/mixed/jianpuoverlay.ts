// 混排的**简谱叠层**：压在五线谱第一子谱表上方的那一行简谱（`1=X`、拍号、数字、临时记号、八度点、附点/增时线、减时线）。
// 从 musicpp model/render.cpp 的 Mixed 分支移植（印哪个音、唱名/八度/临时记号/减时线条数改从语义层 `model/jianpu.ts` 取）；五线谱层在 `render.ts`，两层只经 `SysStaff.minY`（叠层带的位置）相接。
//
// **逐音成柱**：每个音一个 `<g>`，里面依次是临时记号、数字、八度点、附点或增时线；减时线是跨音的，各柱画完再画。
// 原先照 musicpp 按遍画（先整小节的数字、再整小节的临时记号、再减时线），页面树不同、画出来的像素一致
// （`scripts/mixed-pixel-dump.mjs` 基线逐页比过）。

import { Fraction } from "../common/fraction";
import { Matrix33 } from "../common/geom";
import { GraphicPath, Group, TextFrame } from "../layout/pageitem";
import { Font } from "../layout/font";
import { jpDot, jpTimeSigItems } from "../layout/jpglyph";
import { GlyphCodes } from "../smufl/smufl";
import {
  accidentalSym,
  ChordLayout,
  PartMeasureLayout,
  MeasureLayout,
  MixedOptions,
  NoteLayout,
  PartStaff,
  Sys,
  SysStaff,
  smuflWidth,
} from "./model";
import { addLine, addSmufl, addSmuflScaled, translated } from "./prims";

const BLACK = 0xff000000;

/** 一个小节的简谱叠层。`grp` 是这个小节在五线谱层里的组（原点在谱表顶线、小节左缘）。 */
export function drawJianpuOverlay(grp: Group, sys: Sys, st: SysStaff, m: MeasureLayout): void {
  const scr = sys.score;
  const eng = scr.options;
  const ps = st.partStaff;
  const md = ps.part.measures[m.index];
  if (!md) return;
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

  for (const ch of md.chords) {
    for (const n of ch.notes) {
      const col = new Group();
      const alt = accidentalOf(ch, n, ps.subIndex);
      if (alt !== null) drawAccidental(eng, col, n, alt);
      drawColumn(eng, col, md, ch, n, ps.subIndex);
      if (col.children.length) grpJp.add(col);
    }
  }
  drawJpBeams(eng, grpJp, md);
}

/** 这个音在简谱层要印的临时记号：语义层按旋律延续算好的（`Degree.accidental`），不照搬 MusicXML 的 <accidental>。 */
function accidentalOf(ch: ChordLayout, n: NoteLayout, subStaff: number): number | null {
  if (ch.rest || n.staff !== subStaff || !n.visible || !n.jpMelody || n.x < 0) return null;
  return n.jpAccidental();
}

/** 临时记号：数字左侧的小号 SMuFL 字形。 */
function drawAccidental(eng: MixedOptions, col: Group, n: NoteLayout, alt: number): void {
  const sc = 0.75;
  const sym = accidentalSym(alt, true);
  const w = smuflWidth(eng.meta, sym);
  const g = new Group();
  const mtx = new Matrix33();
  mtx.setAffine([sc, 0, 0, sc, n.x - w * sc - 2, 20]);
  g.matrix = mtx;
  addSmufl(g, sym, 0, 0, eng.musicFont.size);
  col.add(g);
}

/** 一个音的数字、八度点、增时线或附点（render.cpp::drawNotesJianPu）。 */
function drawColumn(eng: MixedOptions, col: Group, md: PartMeasureLayout, ch: ChordLayout, n: NoteLayout, subStaff: number): void {
  if (ch.slash) return;
  if (n.staff !== subStaff) return;
  if (!n.visible) return;
  if (!n.jpMelody) return;
  if (ch.cue) return;
  const sc = eng.mixStaffHeight / 40;
  const font = eng.mixFont;
  const mif = md.measureInfo;

  let x: number;
  let measureRest = false;
  if (ch.rest) {
    if (ch.measureRest) measureRest = true;
    if (ch.dur.compareTo(mif.dur) === 0) measureRest = true;
  }

  if (measureRest) {
    x = mif.dataPos + 5;
    // 宽小节再右移 10（render.cpp:834-839）。
    const dataWidth = mif.dataEnd - mif.dataPos;
    const numw = font.measureText("0") * mif.dur.toInt();
    if (dataWidth > 2 * numw) x += 10;
  } else {
    x = n.cx(eng.meta);
    if (n.x < 0) return;
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
    const mtx = new Matrix33();
    mtx.setAffine([graceSc, 0, 0, graceSc, x, ypos]);
    g.matrix = mtx;
    g.add(textAt(str, font, 0, 0));
    col.add(g);
  } else {
    col.add(textAt(str, font, x, ypos));
  }

  // octave dots
  const oct = n.octaveJp();
  if (oct !== 0) {
    // **位置一律照 render.cpp:875-903**：高音点 `5-2`；低音点从谱高起算、每多一层减时线加
    // 一个 `beamDistJP`（注意原实现这里**不乘** sc），再 −2；逐点步距 `octaveDotDist*sc`。
    // 早先改成「按减时线墨迹底往下均分」的自算口径，与成品差一档，红蓝对照里整排点都错开。
    let octY: number;
    if (oct > 0) {
      octY = eng.jpOctaveUpY - eng.jpTopDy;
    } else {
      octY = eng.mixStaffHeight + eng.beamDistJP * ch.jpBeamCount() + eng.jpOctaveDownDy;
    }
    const step = eng.octaveDotDist * sc;
    // 八度点是**实心矢量圆**，不是字体里的 `.` 字形（三条简谱路统一，见 jpglyph.ts）。
    // 圆按中心定位，而原实现给的是 `.` 的**笔位**（基线），所以要把圆心挪到该字形的墨心上。
    const db = font.charBound(".");
    const r = (db.bottom - db.top) / 2;
    const inkDx = (db.left + db.right) / 2 - font.measureText(".") / 2;
    const inkDy = (db.top + db.bottom) / 2;
    for (let i = 0; i < Math.abs(oct); i++) {
      const cx0 = x + nw / 2 + inkDx;
      const cy0 = octY + i * step * graceSc + graceDy + inkDy;
      if (ch.grace) {
        const g = new Group();
        const mtx = new Matrix33();
        mtx.setAffine([graceSc, 0, 0, graceSc, cx0, cy0]);
        g.matrix = mtx;
        g.add(jpDot(0, 0, r, BLACK));
        col.add(g);
      } else {
        col.add(jpDot(cx0, cy0, r, BLACK));
      }
    }
  }

  if (ch.noteType.compareTo(new Fraction(1)) > 0) {
    // 长于四分音符：增时线（休止写 0）
    const end = ch.dur.plus(ch.offset);
    const endPos = mif.getEntPos(end);
    // 截断取整（对齐 boost::rational_cast<int>），整小节休止用小节时值分子（render.cpp:920-923）。
    let cnt = ch.dur.toInt();
    if (measureRest) cnt = mif.dur.numerator;
    const dx = cnt > 0 ? (endPos - x) / cnt : 0;
    for (let c = 1; c < cnt; c++) col.add(textAt(ch.rest ? "0" : "-", font, x + dx * c, ypos));
  } else {
    // 附点：**实心矢量圆**（与八度点、谱面那一路统一，见 jpglyph.ts / layout.ts::addAugDots），
    // 位置照 render.cpp:938-947——笔位 `x + (数字 advance/2 + 10) * 0.75`、基线 `字号 * 0.75`；
    // 圆心再挪到 `.` 字形的墨心上（原实现画的是字形，我们画圆）。多个附点按原实现叠在同一处，
    // 这里按 advance 顺排（成品无双附点，不影响）。
    const db = font.charBound(".");
    const r = (db.bottom - db.top) / 2;
    const inkDx = (db.left + db.right) / 2;
    const inkDy = (db.top + db.bottom) / 2;
    const adv = font.measureText(".");
    const px = x + (nw / 2 + eng.jpDotDx) * 0.75;
    for (let d = 0; d < ch.dot; d++) {
      col.add(jpDot(px + d * adv + inkDx, font.size * 0.75 + eng.jpDotDy + inkDy, r, BLACK));
    }
  }
}

function textAt(text: string, font: Font, x: number, y: number): TextFrame {
  const t = new TextFrame();
  t.text = text;
  t.font = font;
  t.color = BLACK;
  t.x = x;
  t.y = y;
  return t;
}

/** 减时线（render.cpp::BeamLevelData::drawJianPu）：跨音的，各柱画完再画。 */
function drawJpBeams(eng: MixedOptions, container: Group, md: PartMeasureLayout): void {
  const sc = eng.mixStaffHeight / 40;
  const font = eng.mixFont;
  const meta = eng.meta;

  for (const grp of md.jpBeams) {
    if (grp.chords.length === 0) continue;
    // skip cue groups
    if (grp.chords.some((ch) => ch.cue)) continue;

    for (let lev = 0; lev < 10; lev++) {
      // 收集本层的连续减时线段（render.cpp:32-58 processLevelJp）——同层可有多段，
      // 不能用全局首/尾连成一条。
      const runs: [ChordLayout, ChordLayout][] = [];
      let start: ChordLayout | null = null;
      let end: ChordLayout | null = null;
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
        const ntL = first.notes.find((n) => n.jpMelody) ?? first.notes[0];
        const ntR = last.notes.find((n) => n.jpMelody) ?? last.notes[0];

        const grace = first.grace;
        const graceSc = grace ? eng.jpGraceScale : 1;
        const numL = ntL.number();
        const numR = ntR.number();
        // 端点 = 数字中心 ±数字宽/2（grace 整体按 jpGraceScale 缩放，render.cpp:146-160）。
        const lx = ntL.x + (first.noteheadWidth(meta) / 2 - font.measureText(numL) / 2) * graceSc;
        const rx = ntR.x + (last.noteheadWidth(meta) / 2 + font.measureText(numR) / 2) * graceSc;
        // 纵向照 render.cpp:159：`level*beamDistJP*sc + 35 − (40 − mixStaffHeight)*0.8`。
        // 早先按「数字墨迹底 + font.size/9」自算，谱高 30 时比成品高 1.5 tenths。
        let y = lev * eng.beamDistJP * sc + eng.jpBeamTopY - (40 - eng.mixStaffHeight) * 0.8;

        if (grace) {
          // grace 减时线上移并加尾钩（render.cpp:165-186）。
          y -= 29;
          const cx = (rx + lx) / 2;
          const hook = new GraphicPath();
          hook.fill = false;
          hook.stroke = true;
          hook.strokeColor = BLACK;
          hook.strokeWidth = 1;
          hook.moveTo(cx, y);
          hook.lineTo(cx, y + 5);
          hook.cubicTo(cx, y + 10, cx, y + 10, cx + 10, y + 10);
          hook.lineTo(cx + 10, y + 10);
          const oct = ntL.octaveJp();
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

/** Draw time signature for jp/mixed staff（render.cpp::drawTime Mixed branch）。 */
function drawJpTimeSignature(
  eng: MixedOptions,
  container: Group,
  mif: MeasureLayout,
  ps: PartStaff,
  x: number,
): void {
  const time = ps.getTime(mif.offset);
  const staffHeight = eng.mixStaffHeight;
  const font = eng.mixFont;

  const grp = translated(x, 0);

  // 拍号走公共那一份（jpglyph.ts::jpTimeSigItems）：两个数字**横向居中**于分数线，
  // 一切长度按**小节线高度**的比例。原先这里两个数字都贴 x=0 左对齐、纵向按 musicpp
  // 的 staff space 常量（`sc*(20−dy)` / `sc*(40+dy)`）给，与谱面、文本谱三处口径各不相同。
  //
  // 基准高度取这条谱表的高（简谱层的小节线就是这么高），基线取谱表底——
  // jpTimeSigItems 里的 y 都是相对基线的，谱表顶 y=0 故基线在 staffHeight。
  const r = jpTimeSigItems(time.beats, time.beatType, {
    height: staffHeight,
    centerY: staffHeight / 2 - staffHeight,
    ruleWidth: 1.5,
    color: 0xff000000,
    font,
    // 混排的拍号数字**保留原大小**：musicpp 的 mixFont 就是 `30 × mixStaffHeight/40`，
    // 即 0.75 H（谱面那一路是 0.5625 H）。居中与「长度按 H 的比例」照统一那份走，
    // 只有字号与下面三档间距各留各的。
    digitRatio: 0.75,
    // 竖向不必给：`jpTimeSigItems` 按「减时线与音符」那一格排（TIME_SIG_GAP_EM ×
    // 拍值字号，墨迹到墨迹），字号一改自己跟着走。
    //
    // 分数线长度得给：默认那个 0.28125 H 是按谱面档的数字（0.5625 H）反算的，
    // 配 0.75 H 的数字线比数字还窄，整条藏在数字底下。musicpp 原式是
    // `max(w1,w2) + 2`（mixFont 22.5 的数字 advance ≈ 12.4，共 14.4 = 0.48 H），
    // 与参考排版（Praise as One 成书 PDF）量到的 14.4 一致。
    ruleLengthRatio: 0.48,
  });
  for (const item of r.items) {
    item.y += staffHeight;
    grp.add(item);
  }
  container.add(grp);
}

/** Draw jianpu key indicator「1=X」for jp/mixed staff（render.cpp::drawKey JianPu/Mixed 分支）。 */
function drawJpKey(
  eng: MixedOptions,
  container: Group,
  mif: MeasureLayout,
  ps: PartStaff,
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

  // 混排谱表上的简谱以 mixFont（按 mixStaffHeight 缩小）排号，转调记号同步用 mixFont，
  // 否则 jianpuFont(30) 比谱面数字(22.5)明显偏大。render.cpp drawKey 用 jianpuFont 是因其
  // 混排谱高为 40；此处随谱高等比缩放，r 即 mixStaffHeight/40。
  const jpFont = eng.jpKeyJianpuFont ? eng.jianpuFont : eng.mixFont;
  const r = jpFont.size / eng.jianpuFont.size;
  if (acc !== 0) {
    const grp = new Group();
    const str1 = new TextFrame();
    str1.text = name;
    str1.font = jpFont;
    str1.color = 0xff000000;
    grp.add(str1);
    let w = jpFont.measureText(name) + 7 * r;

    const accSym = acc < 0 ? GlyphCodes.accidentalFlat : GlyphCodes.accidentalSharp;
    const sc = jpFont.size / 40;
    addSmuflScaled(grp, accSym, w, -10 * r, eng.musicFont.size, sc, sc);
    w += 12 * r;

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

