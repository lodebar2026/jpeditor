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
function classify(comps: Component[]): { c: Classified; numH: number } {
  // 估计数字字号：取"近似方形且较大"连通块的高度中位数
  const squarish = comps.filter((k) => {
    const r = k.bbox.w / k.bbox.h;
    return r > 0.35 && r < 1.6 && k.bbox.h >= 6;
  });
  const numH = median(squarish.map((k) => k.bbox.h)) || 16;

  const c: Classified = { blocks: [], barlines: [], hlines: [], dots: [] };
  for (const k of comps) {
    const { w, h } = k.bbox;
    // 小节线：细高竖条（高 ≳ 字号，宽很窄）
    if (h >= numH * 0.85 && w <= Math.max(2, numH * 0.35)) { c.barlines.push(k); continue; }
    // 独立横线：扁宽（增时线/分隔），且不够高不足以含数字
    if (w >= numH * 0.6 && h <= Math.max(3, numH * 0.32)) { c.hlines.push(k); continue; }
    // 小点：八度点/附点
    if (w <= numH * 0.45 && h <= numH * 0.45) { c.dots.push(k); continue; }
    // 数字块：高度接近字号（可略高于字号以容纳粘连的下划线），宽度不限（连音会更宽）
    if (h >= numH * 0.55 && h <= numH * 2.0 && w >= numH * 0.3) { c.blocks.push(k); continue; }
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
): JpNum[] {
  const out: JpNum[] = [];
  for (let i = 0; i < rowCores.length; i++) {
    const d = rowCores[i].bbox;
    const next = rowCores[i + 1]?.bbox;
    // 增时线右界：行末音符(如 6--- 整小节长音)无下一音符，须放宽到无穷，否则只数到第一根 '-'；
    // 同 y 高度约束已能防越界到别行。
    const augR = next ? next.x : Number.POSITIVE_INFINITY;
    let octave = 0, dot = 0, augment = 0;

    const dcx = rcx(d), dcy = rcy(d);
    for (const k of cls.dots) {
      const kb = k.bbox;
      // 右侧附点：在数字右侧近处、垂直居中。
      if (rcx(kb) > rright(d) && rcx(kb) < rright(d) + numH * 0.8 && Math.abs(rcy(kb) - dcy) < numH * 0.5) { dot++; continue; }
      // 八度点：须足够大(排除噪点小斑)、水平居中于数字、且紧贴上/下方（间隙 < 0.8×字号）。
      // 阈值据实测分布定（真八度点 w/h≈0.21~0.30×numH、|dx|≤0.14；噪点误判那个是 0.09×0.11、dx=0.45）：
      // 尺寸下限 0.15、居中收到 0.4，两道独立门都能剔除噪点，且对真点留足余量。
      if (kb.w < numH * 0.15 || kb.h < numH * 0.15) continue;
      if (Math.abs(rcx(kb) - dcx) > numH * 0.4) continue;
      const gapAbove = d.y - rbottom(kb);  // 点在数字上方的间隙
      const gapBelow = kb.y - rbottom(d);  // 点在数字下方的间隙
      if (gapAbove >= -1 && gapAbove < numH * 0.8) octave++;       // 上点 → 高八度
      else if (gapBelow >= -1 && gapBelow < numH * 0.8) octave--;  // 下点 → 低八度
    }
    octave = Math.max(-3, Math.min(3, octave)); // 简谱八度极少超过 ±2~3
    let div = 0;
    for (const k of cls.hlines) {
      const kb = k.bbox;
      // 独立横线在数字右侧、与数字同高 → 增时线 '-'
      if (kb.x >= rright(d) - 1 && kb.x < augR && Math.abs(rcy(kb) - rcy(d)) < numH * 0.6 &&
          overlapX(kb, d) < kb.w * 0.4) { augment++; continue; }
      // 减时线(下划线)：数字**正下方**的独立横线，x 与数字重叠；多条上下堆叠 → div 多层。
      const below = kb.y - rbottom(d);
      if (below > -numH * 0.2 && below < numH * 0.75 && overlapX(kb, d) >= Math.min(kb.w, d.w) * 0.4) div++;
    }
    out.push({ digit: ocrDigit(d), bbox: d, dot, octave, div, augment });
  }
  return out;
}

export async function recognizeJianpu(bin: Binary, ocr: OcrBackend): Promise<RecognizedScore> {
  const comps = connectedComponents(bin, 4);
  const { c, numH } = classify(comps);

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
    const barlineXs = c.barlines
      .filter((b) => Math.min(rbottom(b.bbox), botY) - Math.max(b.bbox.y, topY) >= rowH * 0.7)
      .map((b) => rcx(b.bbox))
      .sort((a, b) => a - b);
    return { rd, topY, botY, barlineXs };
  });

  // 关键启发式：乐谱行有小节线穿过，歌词/标题行没有。先筛出乐谱行，
  // **只对乐谱行做 OCR**——避免把歌词汉字也送去识别（拖慢且污染结果）；整曲无小节线则回退全部。
  const withBars = rowMeta.filter((m) => m.barlineXs.length > 0);
  const staff = withBars.length ? withBars : rowMeta;

  const allDigits = staff.flatMap((m) => m.rd);
  const recog = await ocr.recognizeDigits(bin, allDigits.map((k) => k.bbox));
  const digitCache = new Map<Rect, number>();
  allDigits.forEach((k, i) => digitCache.set(k.bbox, recog[i] ?? 0));
  const ocrDigit = (b: Rect) => digitCache.get(b) ?? 0;

  const allRows: StaffRow[] = staff.map((m) => ({
    topY: m.topY, bottomY: m.botY, barlineXs: m.barlineXs,
    nums: buildJpNums(m.rd, numH, c, ocrDigit),
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
  if (ocr.recognizeTexts) await recognizeLyrics(bin, comps, useRows, numH, ocr);

  // 页眉：标题/作词/作曲/调号/速度（同样仅 PaddleOCR 后端）。
  let title: string | undefined, credits: string[] | undefined;
  let fifths = 0, tempo: number | undefined;
  if (ocr.recognizeTexts && useRows.length) {
    const h = await recognizeHeader(bin, comps, useRows[0].topY, numH, ocr);
    title = h.title; credits = h.credits.length ? h.credits : undefined;
    if (h.fifths !== undefined) fifths = h.fifths;
    tempo = h.tempo;
  }

  return { key: "C", fifths, beats: 4, beatType: 4, rows: useRows, title, credits, tempo };
}
