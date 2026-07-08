// 简谱结构识别（移植 jianpu.cpp recognition_jp 的几何启发式，OpenCV→纯 TS）。
// 流程：连通域 → 估计字号 → 分类(数字块/小节线/横线/点) → 数字块内部拆分(下划线/相邻数字)
//        → 按行分组 → 归并八度点/增时线/附点 → OCR 数字 → 按小节线切分。
//
// 关键修复（相对 musicpp 初版移植）：
//   1. 减时下划线常与数字相连成同一连通域，初版用"独立横线"判 div 会漏判 → 改为在
//      每个数字块底部带状区域内直接数下划线层数得 div。
//   2. 带下划线的连音（如 6_5_）会粘成一个宽连通域，初版 classify 因 w>numH 直接丢弃 →
//      现按列投影把宽块切成多个数字格。
import type { Binary, Component, JpNum, Rect, StaffRow, RecognizedScore } from "./types";
import { rright, rbottom, rcx, rcy } from "./types";
import { connectedComponents } from "./ccl";
import type { OcrBackend } from "./ocr";
import { recognizeLyrics } from "./lyrics";
import { recognizeHeader } from "./header";
import { detectSlurs } from "./slur";

const overlapX = (a: Rect, b: Rect) => Math.max(0, Math.min(rright(a), rright(b)) - Math.max(a.x, b.x));
const median = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };

/** 一个数字格：紧包围盒 + 自身下划线条数(div)。 */
interface DigitCore {
  bbox: Rect;
  div: number;
}

interface Classified {
  blocks: Component[];   // 数字（块，可能含下划线/粘连，待拆分）
  barlines: Component[]; // 小节线（高瘦竖条）
  hlines: Component[];   // 独立横线（增时线 '-' / 分隔线）
  dots: Component[];     // 小点（八度点/附点）
}

// jianpu.cpp: findBarline/analyze_barline/analyze_hline/analyze_dot —— 按形状分类连通域。
/** 高/低八度的窄数字（尤其唯一单竖笔的 "1"）常与其八度点 4-连通粘成一个**过高的窄竖块**
 *  （点 + 竖笔），落进"终止/粗小节线"判据被整块丢弃 —— 但**数字字形不含点**，故顶/底部这个
 *  与主笔隔着低墨谷的小墨斑必是八度点。按行墨廓在谷处切开，返回 { dot, digit } 两个合成连通块
 *  （dot 归 c.dots 供 buildJpNums 记八度、digit 归 c.blocks 正常识别）；非此形态返回 null。 */
function splitMergedOctaveDot(bin: Binary, b: Rect, numH: number): { dot: Component; digit: Component } | null {
  // 仅"过高、但仍有真实笔宽的窄竖块"才可能是点+数字笔：真小节线常细至 1~2px（下限剔之），
  // 数字笔即便是最窄的 "1" 也有可观宽度（≈0.3~0.55字号）。
  if (b.h <= numH * 1.05 || b.w < numH * 0.3 || b.w > numH * 0.6) return null;
  const ink = rowInk(bin, b);
  const strokeInk = median(ink.filter((v) => v > 0)) || 1;
  const mk = (y0: number, y1: number): Component | null => {
    const t = tightBox(bin, b, 0, b.w, y0, y1);
    return t ? { id: -1, bbox: t, area: t.w * t.h, cx: rcx(t), cy: rcy(t) } : null;
  };
  // 在顶部窗口(高八度点)或底部窗口(低八度点)找与主笔隔开的低墨谷。
  const tryCut = (winLo: number, winHi: number, dotAtTop: boolean): { dot: Component; digit: Component } | null => {
    let v = -1, vMin = Infinity;
    for (let y = winLo; y < winHi; y++) if (ink[y] < vMin) { vMin = ink[y]; v = y; }
    if (v < 0 || vMin > strokeInk * 0.6) return null; // 无清晰低墨谷 → 非点+笔（真小节线墨廓均匀）
    const dotSeg = dotAtTop ? mk(0, v) : mk(v + 1, b.h);
    const digSeg = dotAtTop ? mk(v + 1, b.h) : mk(0, v);
    if (!dotSeg || !digSeg) return null;
    const dh = dotSeg.bbox.h, dgh = digSeg.bbox.h;
    // 点须是真墨斑(≥0.13字号见方、≤0.5字号)、数字笔须够高(≥0.55字号)且宽度像数字(≥0.28字号)。
    // 宽度下限把 1~2px 的细小节线/扫描竖纹挡在门外（它们墨廓也会有单像素起伏被误当"谷"）。
    if (dh > numH * 0.5 || dotSeg.bbox.w > numH * 0.5 || dotSeg.bbox.w < numH * 0.13) return null;
    if (dgh < numH * 0.55 || dgh > numH * 1.7 || digSeg.bbox.w > numH * 0.7 || digSeg.bbox.w < numH * 0.28) return null;
    return { dot: dotSeg, digit: digSeg };
  };
  return tryCut(Math.round(numH * 0.12), Math.round(numH * 0.6), true) ??
    tryCut(b.h - Math.round(numH * 0.6), b.h - Math.round(numH * 0.12), false);
}

function classify(comps: Component[], bin: Binary): { c: Classified; numH: number } {
  // 估计数字字号：取"近似方形且较大"连通块的高度中位数
  const squarish = comps.filter((k) => {
    const r = k.bbox.w / k.bbox.h;
    return r > 0.35 && r < 1.6 && k.bbox.h >= 6;
  });
  const numH = median(squarish.map((k) => k.bbox.h)) || 16;

  const c: Classified = { blocks: [], barlines: [], hlines: [], dots: [] };
  // 高瘦竖块可能是"八度点 + 窄数字"粘连体（数字不含点）：优先切开、把点与数字笔各归其类，
  // 否则会被下面的小节线判据整块吞掉而丢音（实测高八度 "1̇" 在单行简谱里 h 恰同真小节线）。
  const barCand = (w: number, h: number) =>
    (h >= numH * 0.85 && w <= Math.max(2, numH * 0.35)) || (h >= numH * 1.3 && w <= numH * 0.6 && h / w >= 2.2);
  for (const k of comps) {
    const { w, h } = k.bbox;
    if (barCand(w, h)) {
      const sp = splitMergedOctaveDot(bin, k.bbox, numH);
      if (sp) { c.dots.push(sp.dot); c.blocks.push(sp.digit); continue; }
    }
    // 小节线：细高竖条（高 ≳ 字号，宽很窄）
    if (h >= numH * 0.85 && w <= Math.max(2, numH * 0.35)) { c.barlines.push(k); continue; }
    // 终止线/粗小节线：比普通小节线粗（w 可达 ~0.5字号），但仍明显高瘦——高于一个字号且 h/w≥2.2。
    // 否则会落进下面的数字块判据被 OCR 成 "1"（实测末尾 ▮ 终止线 w15 h56 → 误识两个 1）。
    if (h >= numH * 1.3 && w <= numH * 0.6 && h / w >= 2.2) { c.barlines.push(k); continue; }
    // 独立横线：扁宽（增时线/分隔），且不够高不足以含数字
    if (w >= numH * 0.6 && h <= Math.max(3, numH * 0.32)) { c.hlines.push(k); continue; }
    // 小点：八度点/附点
    if (w <= numH * 0.45 && h <= numH * 0.45) { c.dots.push(k); continue; }
    // 数字块：高度接近字号（可略高于字号以容纳粘连的下划线），宽度不限（连音会更宽）。
    if (h >= numH * 0.55 && h <= numH * 2.0 && w >= numH * 0.3) { c.blocks.push(k); continue; }
    // 淡印的窄音符（典型是 "1"：二值化常只留上半截）高度会略低于一般阈值——窄竖块（w≤0.6字号）
    // 单独放宽到 0.5。但**只放窄块**：宽而矮的块多是下划线/碎片，放进来会凭空多识一个音（实测
    // 日光末行 w52 h24 误成 "7"）。
    if (w >= numH * 0.3 && w <= numH * 0.6 && h >= numH * 0.5 && h <= numH * 2.0) { c.blocks.push(k); continue; }
  }
  // 「细高竖条」既可能是小节线，也可能是数字 "1"（一条竖笔）。二者宽都很窄、高都 ≳ 字号，
  // 形状难分；但**同一张图里真小节线高度集中成簇、且远高于数字**（实测：世上小节线 h≈35~49、
  // "1" 仅 h≈16~24；日光小节线 h≈45~70）。故按候选高度中位数剔除明显偏矮者（<0.55×中位高）
  // → 它们其实是 "1"，改归数字块，否则会凭空丢音又多出假小节线。真小节线占多数时中位数稳健。
  if (c.barlines.length >= 4) {
    const medH = median(c.barlines.map((k) => k.bbox.h));
    const real: Component[] = [];
    for (const k of c.barlines) {
      if (k.bbox.h < medH * 0.55) {
        // 偏矮 → 多半是数字 "1"。但终止/复纵线（‖）的细线常因扫描淡而偏矮，它紧贴另一根
        // 竖线（间距 < 0.7×字号、同 y）——这种有近邻的不当 "1"，保留为小节线。
        const paired = c.barlines.some((o) => o !== k &&
          Math.abs(rcx(o.bbox) - rcx(k.bbox)) < numH * 0.7 && Math.abs(rcy(o.bbox) - rcy(k.bbox)) < numH);
        if (!paired) { c.blocks.push(k); continue; }
      }
      real.push(k);
    }
    c.barlines = real;
  }
  return { c, numH };
}

/** 块内每列前景像素数（在 [y0, yLimit) 行范围内统计）。 */
function columnInk(bin: Binary, b: Rect, y0: number, yLimit: number): number[] {
  const cols = new Array(b.w).fill(0);
  for (let xx = 0; xx < b.w; xx++) {
    let cnt = 0;
    for (let yy = y0; yy < yLimit; yy++) {
      if (bin.data[(b.y + yy) * bin.w + (b.x + xx)]) cnt++;
    }
    cols[xx] = cnt;
  }
  return cols;
}

/** 块内每行前景像素数（[0, b.h)）。用于探测「弧帽 + 数字」纵向结构。 */
function rowInk(bin: Binary, b: Rect): number[] {
  const rows = new Array(b.h).fill(0);
  for (let yy = 0; yy < b.h; yy++) {
    let cnt = 0;
    for (let xx = 0; xx < b.w; xx++) {
      if (bin.data[(b.y + yy) * bin.w + (b.x + xx)]) cnt++;
    }
    rows[yy] = cnt;
  }
  return rows;
}

/** 在 [x0,x1) 列、[y0,yLimit) 行范围内求前景紧包围盒（相对块原点的绝对坐标）。 */
function tightBox(bin: Binary, b: Rect, x0: number, x1: number, y0: number, yLimit: number): Rect | null {
  let minX = x1, maxX = x0 - 1, minY = yLimit, maxY = -1;
  for (let yy = y0; yy < yLimit; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      if (bin.data[(b.y + yy) * bin.w + (b.x + xx)]) {
        if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
        if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: b.x + minX, y: b.y + minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// 探测「圆滑线弧帽 + 数字」粘连块：弧线常贴着它跨越的两个数字顶端，4-连通把弧与数字粘成
// 一个**明显超高(h>1.2字号)**的块。结构（实测）：顶部弧帽(单段宽笔)→两条下垂弧尾(低墨谷)→
// 底部 ~一个字号的数字体。据**行墨廓线**找谷底、把数字体定位到底部，弧帽切出来供 detectSlurs 用。
// 返回 { bodyTop: 数字体起始行(块内偏移，0=无弧), arc: 弧帽紧包围盒|null }。
function mergedArcSplit(bin: Binary, b: Rect, numH: number): { bodyTop: number; arc: Rect | null } {
  if (b.h <= numH * 1.2 || b.w < numH * 1.2) return { bodyTop: 0, arc: null };
  const rows = rowInk(bin, b);
  const maxInk = Math.max(...rows);
  // 在 [0.3字号, 块高-0.6字号) 内找最低墨行（弧尾与数字体之间的谷）。
  const lo = Math.floor(numH * 0.3), hi = Math.floor(b.h - numH * 0.6);
  let vIdx = -1, vMin = Infinity;
  for (let y = lo; y < hi; y++) if (rows[y] < vMin) { vMin = rows[y]; vIdx = y; }
  if (vIdx < 0 || vMin >= maxInk * 0.3) return { bodyTop: 0, arc: null }; // 无清晰分隔 → 不是弧
  // 数字体顶：自谷底下行找首个墨量回升到 0.35×峰值 的行。
  let bodyTop = vIdx;
  for (let y = vIdx; y < b.h; y++) if (rows[y] >= maxInk * 0.35) { bodyTop = y; break; }
  // 弧帽高须在 [0.2, 0.85]×字号（短于一个数字），数字体须 ≥0.7字号；否则疑似两数字纵向粘连，弃。
  if (bodyTop < numH * 0.2 || bodyTop > numH * 0.85 || b.h - bodyTop < numH * 0.7) return { bodyTop: 0, arc: null };
  const arc = tightBox(bin, b, 0, b.w, 0, bodyTop);
  if (!arc || arc.w < b.w * 0.55) return { bodyTop: 0, arc: null }; // 弧帽须横跨大半块宽
  return { bodyTop, arc };
}

// 把一个数字块拆成若干数字格，并测出共享的下划线条数(div)。
// jianpu.cpp 用形态学分离横线；这里用"底部带状宽行 = 下划线"+"上部列投影空隙 = 数字间隔"。
function splitBlock(bin: Binary, comp: Component, numH: number): { cores: DigitCore[]; arc: Rect | null } {
  const b = comp.bbox;
  // 减时线(下划线)在本图里是数字**正下方的独立横线连通块**(归入 c.hlines)，并不在数字块内
  //（数字块高度≈字号，块内底部宽行其实是数字自身的底横笔，初版据此判 div 会把 5/6/2/3 全部误判）。
  // 因此 div 不在此处测，改到 buildJpNums 里按"数字下方的 hline"统计（见 underlineDiv）。
  const div = 0;
  // 圆滑线弧帽常与所跨数字粘连成超高块 → 仅**取出弧帽**(供 detectSlurs)；数字格仍按整块切分。
  // （不据弧帽裁数字体：块包围盒常跨到相邻独立数字上，裁后底带会漏进邻字像素 → 重复数字。）
  const { arc } = mergedArcSplit(bin, b, numH);
  const yLimit = b.h;

  // 2) 上部按列投影空隙切分（仅当块明显宽于一个数字时才尝试，避免把单个数字切碎）。
  const cores: DigitCore[] = [];
  if (b.w <= numH * 1.4) {
    const box = tightBox(bin, b, 0, b.w, 0, yLimit) ?? { x: b.x, y: b.y, w: b.w, h: yLimit };
    cores.push({ bbox: box, div });
    return { cores, arc };
  }
  const cols = columnInk(bin, b, 0, yLimit);
  // 收集前景列的连续段（空列 = 间隔）
  const segs: Array<[number, number]> = [];
  let s = -1;
  for (let xx = 0; xx < b.w; xx++) {
    if (cols[xx] > 0) { if (s < 0) s = xx; }
    else if (s >= 0) { segs.push([s, xx]); s = -1; }
  }
  if (s >= 0) segs.push([s, b.w]);
  // 过滤过窄的噪声段（< numH*0.25），把它们并入相邻段
  const minSeg = numH * 0.3;
  const merged: Array<[number, number]> = [];
  for (const [a, e] of segs) {
    if (e - a < minSeg && merged.length) merged[merged.length - 1][1] = e;
    else merged.push([a, e]);
  }
  for (const [a, e] of merged.length ? merged : segs) {
    const box = tightBox(bin, b, a, e, 0, yLimit);
    if (box) cores.push({ bbox: box, div });
  }
  return { cores: cores.length ? cores : [{ bbox: { x: b.x, y: b.y, w: b.w, h: yLimit }, div }], arc };
}

// 按 y 把数字格分行（贪心：行内 y 重叠或中心接近）。
function groupRows(cores: DigitCore[], numH: number): DigitCore[][] {
  const sorted = [...cores].sort((a, b) => rcy(a.bbox) - rcy(b.bbox));
  const rows: DigitCore[][] = [];
  for (const d of sorted) {
    let placed = false;
    for (const row of rows) {
      const ry = median(row.map((k) => rcy(k.bbox)));
      if (Math.abs(rcy(d.bbox) - ry) < numH * 0.7) { row.push(d); placed = true; break; }
    }
    if (!placed) rows.push([d]);
  }
  for (const row of rows) row.sort((a, b) => a.bbox.x - b.bbox.x);
  return rows;
}

// 为一行的每个数字格归并修饰（八度点/增时线/附点），div 已随数字格带入。
function buildJpNums(
  rowCores: DigitCore[], numH: number, cls: Classified, ocrDigit: (b: Rect) => number,
  arcs: Component[], barlineXs: number[], dotSizes: number[],
): JpNum[] {
  const out: JpNum[] = [];
  for (let i = 0; i < rowCores.length; i++) {
    const d = rowCores[i].bbox;
    const next = rowCores[i + 1]?.bbox;
    // 右侧修饰（附点/增时线）必与本音符同属一小节：不得越过本音符后的第一根小节线。
    // 否则末音符会跨过小节线把下一小节的点/横线吞进来（实测「2_ |1-」把 1 的附点与增时线
    // 误并到 2_ → 2. 且漏掉 1 的增时）。无后续小节线则不限。
    const nextBar = barlineXs.find((x) => x > rright(d) - 1);
    const rightLimit = nextBar ?? Number.POSITIVE_INFINITY;
    // 增时线右界：行末音符(如 6--- 整小节长音)无下一音符，须放宽到无穷，否则只数到第一根 '-'；
    // 同 y 高度约束已能防越界到别行。再以本小节右界封顶。
    const augR = Math.min(next ? next.x : Number.POSITIVE_INFINITY, rightLimit);
    let octave = 0, dot = 0, augment = 0;
    // 数字先识别（附点判定要用到：休止 0 不接附点 —— 见下）。
    // "1" 是简谱唯一单竖笔，明显比其它数字窄（实测 ≈0.45~0.55字号，其余 ≈0.9字号）：极窄块若被
    // OCR 误判成别的数字（淡印/碎裂的 "1" 常被读成 4/7），按宽度纠回 1；不动休止 0（圆形、不窄）。
    let digit = ocrDigit(d);
    if (digit > 1 && d.w <= numH * 0.55) digit = 1;

    const dcx = rcx(d), dcy = rcy(d);
    // 右侧附点窗口：附点紧跟其修饰的音符，但实测它常落在到下一音符空隙的中段（约 50%，
    // 即 ~1.3×字号外），远超固定的 0.8×字号窗。改用空隙相对界——取本音符右缘到下一音符左缘
    // 间隙的前 60%（无下一音符则放宽到 1.6×字号）；垂直居中(|Δcy|<0.5)已排除上/下八度点，
    // 60% 上界确保把点归给本音符而非下一音符（下一音符的八度点居中于其自身，落在 60% 之外）。
    const dotMaxX = Math.min(
      next ? rright(d) + (next.x - rright(d)) * 0.6 : rright(d) + numH * 1.6,
      rightLimit,
    );
    for (const k of cls.dots) {
      const kb = k.bbox;
      // 右侧附点：在数字右侧空隙前段、**真正垂直居中**、且尺寸够大（非噪点）。
      // 阈值据 5 首实测分布定（按 numH 自适应缩放）：真附点 w/h≈0.29~0.45×numH、|Δcy|≤0.16×numH；
      // 误检要么是噪点小斑(≤0.08×numH)、要么是邻音符的下八度点(Δcy≈0.3~0.43×numH、偏右偏下)。
      // 尺寸下限 0.15 剔噪点、居中收到 0.25×numH 剔偏下的八度点 —— 两道独立门各自留足真附点余量。
      // 休止 0 不接附点：实测尾随休止右侧常有终止线碎块/噪点被误当附点（为基督 r5 末 "0" → 误 "0."）；
      // 简谱附点休止极罕见，且休止右侧本就无修饰，按 digit!=0 一刀剔除，对真音符附点无损。
      if (digit !== 0 && rcx(kb) > rright(d) && rcx(kb) < dotMaxX &&
          kb.w >= numH * 0.15 && kb.h >= numH * 0.15 &&
          Math.abs(rcy(kb) - dcy) < numH * 0.25) { dot++; dotSizes.push((kb.w + kb.h) / 2); continue; }
      // 八度点：须足够大(排除噪点小斑)、水平居中于数字、且紧贴上/下方（间隙 < 0.8×字号）。
      // 阈值据实测分布定（真八度点 w/h≈0.21~0.30×numH、|dx|≤0.14；噪点误判那个是 0.09×0.11、dx=0.45）：
      // 尺寸下限 0.15、居中收到 0.4，两道独立门都能剔除噪点，且对真点留足余量。
      if (kb.w < numH * 0.15 || kb.h < numH * 0.15) continue;
      if (Math.abs(rcx(kb) - dcx) > numH * 0.4) continue;
      const gapAbove = d.y - rbottom(kb);  // 点在数字上方的间隙
      const gapBelow = kb.y - rbottom(d);  // 点在数字下方的间隙
      if (gapAbove >= -1 && gapAbove < numH * 0.8) {
        // 圆滑线弧帽的左/右"落脚"碎片常断成一个小斑、正落在弧端正下方、贴着数字顶——会被误当高八度点。
        // 判据：有一条弧线(宽薄连通块)横跨此斑、且其**底缘正落在斑的纵向区间内** (dotTop, dotBot+0.15字号]
        // ——即弧脚下垂到与小斑重叠，小斑就是断开的弧脚。**关键**：真高八度点(如日光行3 弧下的 2'/3')
        // 的弧线整体在点**上方**(弧底缘高于点顶 → 不重叠)，或弧实为下方下划线(弧底缘远在点底之下)，
        // 两者都落在窗口外，不会误剔。(实测：基督弧底-点顶=+9/弧底-点底=-3 命中；日光 -5/-16 不命中。)
        const isArcFoot = arcs.some((arc) => {
          const ab = arc.bbox;
          return rbottom(ab) > kb.y && rbottom(ab) <= rbottom(kb) + numH * 0.15 &&
            rcx(kb) >= ab.x - numH * 0.4 && rcx(kb) <= rright(ab) + numH * 0.4;
        });
        if (!isArcFoot) { octave++; dotSizes.push((kb.w + kb.h) / 2); }  // 上点 → 高八度
      } else if (gapBelow >= -1 && gapBelow < numH * 0.8) { octave--; dotSizes.push((kb.w + kb.h) / 2); }  // 下点 → 低八度
    }
    octave = Math.max(-3, Math.min(3, octave)); // 简谱八度极少超过 ±2~3
    let div = 0;
    const augmentRects: Rect[] = [];
    for (const k of cls.hlines) {
      const kb = k.bbox;
      // 独立横线在数字右侧、与数字同高 → 增时线 '-'
      if (kb.x >= rright(d) - 1 && kb.x < augR && Math.abs(rcy(kb) - rcy(d)) < numH * 0.6 &&
          overlapX(kb, d) < kb.w * 0.4) { augment++; augmentRects.push(kb); continue; }
      // 减时线(下划线)：数字**正下方**的独立横线，x 与数字重叠；多条上下堆叠 → div 多层。
      const below = kb.y - rbottom(d);
      if (below > -numH * 0.2 && below < numH * 0.75 && overlapX(kb, d) >= Math.min(kb.w, d.w) * 0.4) div++;
    }
    out.push({ digit, bbox: d, dot, octave, div, augment, augmentRects });
  }
  return out;
}

/** 数字框中央横带的前景占比（x∈[0.28,0.72]×y∈[0.42,0.58]）：简谱 "0" 是空心椭圆环，中带几乎无墨
 *  （实测各图真 0 ≤0.47）；被二值化糊死的 "3"（中间横笔连成一条穿心的"斜线"）中带占满（3 恒 ≥0.7）。
 *  → 判"读成 0 却中带有横笔"= 实为糊住的 3 等，供 0 误判复原（简谱 0 从不带斜线）。 */
function midbandInk(bin: Binary, b: Rect): number {
  const x0 = Math.round(b.x + b.w * 0.28), x1 = Math.round(b.x + b.w * 0.72);
  const y0 = Math.round(b.y + b.h * 0.42), y1 = Math.round(b.y + b.h * 0.58);
  let n = 0, t = 0;
  for (let y = Math.max(0, y0); y < Math.min(bin.h, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(bin.w, x1); x++) { t++; if (bin.data[y * bin.w + x]) n++; }
  return t ? n / t : 0;
}

export async function recognizeJianpu(bin: Binary, ocr: OcrBackend): Promise<RecognizedScore> {
  const comps = connectedComponents(bin, 4);
  const { c, numH } = classify(comps, bin);

  // 数字块 → 数字格（拆分粘连/连音，并测各自下划线 div）。
  // 与数字粘连的圆滑线弧帽在此切出，作为合成连通块补进 comps 供 detectSlurs 检测。
  const allCores: DigitCore[] = [];
  const mergedArcs: Rect[] = [];
  for (const blk of c.blocks) {
    const { cores, arc } = splitBlock(bin, blk, numH);
    allCores.push(...cores);
    if (arc) mergedArcs.push(arc);
  }
  const arcComps: Component[] = mergedArcs.map((bb, i) => ({
    id: 1_000_000 + i, bbox: bb, area: bb.w * bb.h, cx: bb.x + bb.w / 2, cy: bb.y + bb.h / 2,
  }));

  const rowsC = groupRows(allCores, numH).filter((r) => r.length >= 3);
  // 每行的 y 范围 + 穿过的小节线。
  const rowMeta = rowsC.map((rd) => {
    const topY = Math.min(...rd.map((k) => k.bbox.y));
    const botY = Math.max(...rd.map((k) => rbottom(k.bbox)));
    // 小节线须**纵向贯穿本行**（覆盖本行 [topY,botY] 的大部分）。歌词行竖笔在行下方、
    // 与本行纵向重叠≈0 → 自然被滤掉。用"重叠占比"而非两道紧边界阈值：后者会因竖线起点
    // 偏几像素(如行3 x=466 顶部仅低 1.2px)就误杀真线。
    const rowH = botY - topY;
    // 纵向贯穿本行的小节线候选（覆盖本行 [topY,botY] 的大部分）。歌词行竖笔在行下方、
    // 与本行纵向重叠≈0 → 自然被滤掉。
    const spanning = c.barlines.filter(
      (b) => Math.min(rbottom(b.bbox), botY) - Math.max(b.bbox.y, topY) >= rowH * 0.7,
    );
    // 真小节线是贯穿整个谱行的高竖线（实测远高于数字行：基督更美 h118 vs 数字 h55）；而数字 "1"
    // 的竖笔、扫描里的细竖纹等"伪小节线"仅约一个字高、且常仅 1px 宽，会撞上面的贯穿判据。它们与真线
    // 同 x 反复出现 → 凭单条 overlap 难剔。但**同一谱行内真小节线高度集中成簇且明显最高**：按本行候选
    // 的最大高度设相对门（<0.6×行内最高 → 丢弃）即可干净分开——基督更美 h44<0.6×118 被剔，而日光
    // (45~70)、世上(真 35~49)行内最高与真线同簇，整簇保留。绝对/字号比阈值跨图不通，故用行内相对。
    const maxH = Math.max(0, ...spanning.map((b) => b.bbox.h));
    const barlineXs = spanning
      .filter((b) => b.bbox.h >= maxH * 0.6)
      .map((b) => rcx(b.bbox))
      .sort((a, b) => a - b);
    return { rd, topY, botY, barlineXs };
  });

  // 关键启发式：乐谱行有小节线穿过，歌词/标题行没有。先筛出乐谱行，
  // **只对乐谱行做 OCR**——避免把歌词汉字也送去识别（拖慢且污染结果）；整曲无小节线则回退全部。
  const withBars = rowMeta.filter((m) => m.barlineXs.length > 0);
  const staff = withBars.length ? withBars : rowMeta;

  const allDigits = staff.flatMap((m) => m.rd);
  // rec 输入裁剪：连通域偶尔只截到半个字（淡印/断笔的 "1" 竖笔断开，块高≈半个字高 → 送 rec 成半字被
  // 误读，如"1"读成"4"）。据本行数字带统计高度把过矮的块纵向补到整字高（cellOf 按 rect 从二值图裁，
  // 会把带内断开的另一半笔画一并纳入）。带 [topY,botY] 由数字核算出、不含下划线/八度点 → 补高安全。
  // 仅补高、不动 x/w，且只作用于 rec 裁剪；几何(八度/附点/div/缓存键)仍用原 bbox。
  const recRects = staff.flatMap((m) => {
    const bandH = m.botY - m.topY;
    return m.rd.map((k) =>
      k.bbox.h < bandH * 0.7 ? { x: k.bbox.x, y: m.topY, w: k.bbox.w, h: bandH } : k.bbox,
    );
  });
  const recog = await ocr.recognizeDigits(bin, recRects);
  const digitCache = new Map<Rect, number>();
  allDigits.forEach((k, i) => digitCache.set(k.bbox, recog[i] ?? 0));
  const ocrDigit = (b: Rect) => digitCache.get(b) ?? 0;

  // 圆滑线弧帽候选（宽而薄的连通块）：用于在 buildJpNums 里把弧脚碎片从"高八度点"中剔除。
  const arcCands = [...comps, ...arcComps].filter((k) => {
    const b = k.bbox;
    return b.w >= numH * 0.8 && b.h >= 2 && b.h <= numH * 0.8 && b.w / b.h >= 2;
  });

  const dotSizes: number[] = []; // 累积所有被采纳的八度点/附点源图直径 → 取中位数当统计点径
  const allRows: StaffRow[] = staff.map((m) => ({
    topY: m.topY, bottomY: m.botY, barlineXs: m.barlineXs,
    nums: buildJpNums(m.rd, numH, c, ocrDigit, arcCands, m.barlineXs, dotSizes),
  }));

  // 剔除「和弦标记行」等伪乐谱行：五线谱上方的 G/D7/Am… 和弦字母被 OCR 成非数字→几乎全是
  // 休止(digit 0)，且贯穿小节线很少。实测真乐谱行休止占比 ≤18%、小节线 ≥4；伪行休止 ≥79%、
  // 线 ≤2，间隔极大。用「休止占比 < 0.5」即可干净分开（保留余量，避免误杀含少量休止的真行）。
  const rows = allRows.filter((r) => {
    if (!r.nums.length) return false;
    const rest = r.nums.filter((n) => n.digit === 0).length;
    return rest / r.nums.length < 0.5;
  });
  // 整曲都被判伪行（极端情况）则回退，至少出点东西。
  const useRows = rows.length ? rows : allRows;

  // 圆滑线/连音线：检测音符上方弧形连通块 → 置位起止音符（不依赖 OCR 后端）。
  // comps 之外再补上与数字粘连、已被切出的弧帽（arcComps）。
  detectSlurs([...comps, ...arcComps], useRows, numH);

  // 歌词：仅当后端支持中文文本识别(PaddleOCR)时，识别乐谱行下方歌词并按 x 对齐到音符。
  let lyricRegions: RecognizedScore["lyricRegions"];
  if (ocr.recognizeTexts) {
    const lr = await recognizeLyrics(bin, comps, useRows, numH, ocr);
    lyricRegions = lr.length ? lr : undefined;
  }

  // digit=0 误判复原（取数字候选排序里首个非零值）。两条独立线索，任一命中即复原：
  //  ① 休止符不带歌词，故「digit=0 却对齐到歌词」几乎必是退化字形被 CTC 误判成空白→默认 0；
  //  ② 简谱 "0" 是空心环、从不带斜线；「digit=0 却中央横带占满」= 糊死的 "3" 等被读成"内含斜线的 0"。
  if (ocr.rankDigits) {
    const bad: JpNum[] = [];
    for (const r of useRows) for (const n of r.nums) {
      if (n.digit !== 0) continue;
      const alignedToLyric = n.lyrics?.some((s) => s && s.trim());
      const notHollowRing = midbandInk(bin, n.bbox) >= 0.65;
      if (alignedToLyric || notHollowRing) bad.push(n);
    }
    if (bad.length) {
      const ranks = await ocr.rankDigits(bin, bad.map((n) => n.bbox));
      bad.forEach((n, i) => {
        const nz = ranks[i]?.find((d) => d !== 0);
        if (nz !== undefined) n.digit = nz;
      });
    }
  }

  // 页眉：标题/作词/作曲/调号/速度（同样仅 PaddleOCR 后端）。
  let title: string | undefined, credits: string[] | undefined;
  let fifths = 0, tempo: number | undefined;
  let beats = 4, beatType = 4;
  let headerRegions: RecognizedScore["headerRegions"];
  if (ocr.recognizeTexts && useRows.length) {
    const h = await recognizeHeader(bin, comps, useRows[0].topY, numH, ocr);
    title = h.title; credits = h.credits.length ? h.credits : undefined;
    if (h.fifths !== undefined) fifths = h.fifths;
    if (h.beats !== undefined && h.beatType !== undefined) { beats = h.beats; beatType = h.beatType; }
    tempo = h.tempo;
    headerRegions = h.regions.length ? h.regions : undefined;
  }

  const dotDiam = dotSizes.length ? median(dotSizes) : undefined;

  return { key: "C", fifths, beats, beatType, rows: useRows, title, credits, tempo, headerRegions, lyricRegions, dotDiam };
}
