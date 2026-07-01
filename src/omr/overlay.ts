// 识别模式叠加渲染：把二值图 + 识别结果（RecognizedScore）渲成一张 SVG，
// 背景为二值化源图、其上按**源图像素坐标**半透明叠加识别出的数字/八度点/减时线/
// 附点/增时线/小节线/歌词，供用户逐音核对识别准确度。坐标与二值图同空间，直接用。

import type { Binary, RecognizedScore, JpNum, Rect } from "./types";
import { rcx, rcy, rright } from "./types";
import { srcCanvasOf } from "./lyrics";
import { measureGlyphText } from "../common/measure";

const SVG_NS = "http://www.w3.org/2000/svg";
// 叠加数字用的字体（须与 styles.css 的 .omr-overlay text 一致，含 700 粗细）。
const NUM_FONT = "PingFang SC";

// 数字字形的「墨迹高 ÷ font-size」比例：SVG font-size 是 em 框，数字实际墨迹只占约 0.7，
// 故直接用 bbox.h 当 font-size 会画得比原图小。测一次比例，反推让墨迹高 == 目标高（原图音符高）。
let _emPerInk = 0;
function digitFontSize(targetInkH: number): number {
  if (!_emPerInk) {
    const probe = 100;
    const ink = measureGlyphText("8", NUM_FONT, probe, "bold").bbox.height;
    _emPerInk = ink > 0 ? probe / ink : 1.4; // 回退经验值 ~1.4
  }
  return targetInkH * _emPerInk;
}

/** 二值图 → PNG dataURL（黑字白底，作叠加背景）。 */
function binDataUrl(bin: Binary): string {
  const off = srcCanvasOf(bin); // OffscreenCanvas（黑字白底）
  const cv = document.createElement("canvas");
  cv.width = bin.w;
  cv.height = bin.h;
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  ctx.drawImage(off, 0, 0);
  return cv.toDataURL("image/png");
}

function line(x1: number, y1: number, x2: number, y2: number, w: number, cls?: string): SVGLineElement {
  const l = document.createElementNS(SVG_NS, "line");
  l.setAttribute("x1", String(x1));
  l.setAttribute("y1", String(y1));
  l.setAttribute("x2", String(x2));
  l.setAttribute("y2", String(y2));
  l.setAttribute("stroke-width", String(w));
  if (cls) l.setAttribute("class", cls);
  return l;
}

function dot(cx: number, cy: number, r: number): SVGCircleElement {
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", String(cx));
  c.setAttribute("cy", String(cy));
  c.setAttribute("r", String(r));
  return c;
}

function text(x: number, y: number, s: string, size: number, anchor = "middle"): SVGTextElement {
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("x", String(x));
  t.setAttribute("y", String(y));
  t.setAttribute("font-size", String(size));
  t.setAttribute("text-anchor", anchor);
  t.setAttribute("dominant-baseline", "middle");
  t.textContent = s;
  return t;
}

/** 画一个音符及其全部简谱修饰（数字、八度点、减时下划线、附点、增时横线）。
 *  字号/修饰尺度统一用全谱平均音符高 noteH；**纵向统一贴本行中线 cy**（传入的整行公共基线），
 *  以 cy±H/2 当作统一音符框、横向仍按各音符 bbox 取位——使同一行音符落在一条直线上。 */
function renderNum(g: SVGGElement, n: JpNum, noteH: number, cy: number, dotR: number): void {
  const b: Rect = n.bbox;
  const cx = rcx(b);
  const H = noteH;
  const top = cy - H / 2, bot = cy + H / 2; // 统一音符框上/下沿（替代各自 bbox.y/bottom）

  // 数字（0=休止 → 0）：字号反推自「墨迹高==统计原图音符高 H」，不再直接把 H 当 em 框（会偏小）。
  g.appendChild(text(cx, cy, String(n.digit), digitFontSize(H)));

  // 减时下划线（div 条）：数字正下方，每条间距固定。先画，下方留出最末一条的位置，
  // 低音点要错到它下面（简谱约定：减时线在数字与低八度点之间）。
  const divGap = H * 0.13;
  let divBottom = bot; // 最末一条减时线的 y（无减时线即音符框下沿）
  if (n.div > 0) {
    const lw = Math.max(2.2, H * 0.11);   // 减时线画粗、画明显
    const ext = H * 0.08;                  // 略伸出数字两侧，更像下划线、更醒目
    for (let i = 0; i < n.div; i++) {
      const ly = bot + divGap + i * divGap;
      g.appendChild(line(b.x - ext, ly, rright(b) + ext, ly, lw, "omr-mark"));
      divBottom = ly;
    }
  }

  // 八度点：octave>0 上方、<0 下方，|octave| 个。低音点从减时线下方起，避免与下划线重叠。
  const oct = n.octave;
  if (oct !== 0) {
    const r = dotR; // 统计原图点径
    // 数字字号增大后墨迹已顶到音符框上/下沿，八度点须离框远些才不粘连。
    const gap = H * 0.38;
    const step = r * 3;
    const lowBase = (n.div > 0 ? divBottom + divGap : bot) + gap; // 低音点首点基线（让过减时线）
    for (let i = 0; i < Math.abs(oct); i++) {
      const oy = oct > 0 ? top - gap - i * step : lowBase + i * step;
      g.appendChild(dot(cx, oy, r));
    }
  }

  // 附点（dot）：数字右侧，dot 个圆点（用统计原图点径）
  if (n.dot > 0) {
    const r = dotR;
    for (let i = 0; i < n.dot; i++) {
      g.appendChild(dot(rright(b) + r * 2 + i * r * 3, cy, r));
    }
  }

  // 增时横线（augment '-'）：纵向贴本行中线 cy，横向**按识别到的源图横块位置**绘制
  // （增时线占下一拍音符位、间距远宽于固定值；用源位才与原图对齐）。无源位时退回固定间距。
  if (n.augment > 0) {
    const lw = Math.max(1.5, H * 0.08);
    const rects = n.augmentRects;
    if (rects && rects.length) {
      for (const r of rects) g.appendChild(line(r.x, cy, rright(r), cy, lw, "omr-mark"));
    } else {
      const len = H * 0.55, startGap = H * 0.3;
      for (let i = 0; i < n.augment; i++) {
        const lx = rright(b) + startGap + i * (len + H * 0.3);
        g.appendChild(line(lx, cy, lx + len, cy, lw, "omr-mark"));
      }
    }
  }
}

/** 一组数的平均值（空集回退 fallback）。 */
function mean(xs: number[], fallback: number): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback;
}

/** 一组数的中位数（空集回退 fallback）。 */
function median(xs: number[], fallback: number): number {
  if (!xs.length) return fallback;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** 最小二乘拟合一条直线 y=m·x+c，返回 x→y 的求值函数。
 *  用于把同一行音符/歌词的纵向中心拟合成一条**可倾斜**的直线（图片可能歪）——
 *  既顺着倾斜走、又抹平单元抖动，而非强行压到同一水平 y。点 <2 时退化为水平线。 */
function fitLine(pts: { x: number; y: number }[]): (x: number) => number {
  const n = pts.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => pts[0].y;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-6) { const my = sy / n; return () => my; }
  const m = (n * sxy - sx * sy) / d, c = (sy - m * sx) / n;
  return (x) => m * x + c;
}

/** 歌词单字叠加：按 y 聚成 verse 行，每行把各字**纵向中心**最小二乘拟合成一条（可倾斜）直线，
 *  逐字落到该直线对应 x 处、按中心(middle)对齐——顺着图片倾斜走，同时把"一"这类矮字
 *  （其 bbox 中心与正常字同高）拉回行中心，消除上下错位。
 *  **字号按本行实际字距取**（min 字高、字距）：密排行字距小于字高，用全局/字高会画得过大而互相重叠，
 *  故每行单独取 min(中位字高, 中位字距) 当字号，既贴源图大小又不重叠。 */
function renderLyricsAligned(g: SVGGElement, regions: { text: string; bbox: Rect }[], lyrH: number): void {
  if (!regions.length) return;
  const sorted = [...regions].sort((a, b) => rcy(a.bbox) - rcy(b.bbox));
  const lines: { text: string; bbox: Rect }[][] = [];
  for (const r of sorted) {
    const ln = lines.find((L) => Math.abs(median(L.map((k) => rcy(k.bbox)), 0) - rcy(r.bbox)) < lyrH * 0.7);
    if (ln) ln.push(r); else lines.push([r]);
  }
  for (const ln of lines) {
    const byX = [...ln].sort((a, b) => rcx(a.bbox) - rcx(b.bbox));
    const cxs = byX.map((r) => rcx(r.bbox));
    const gaps = cxs.slice(1).map((v, i) => v - cxs[i]);
    const medH = median(ln.map((r) => r.bbox.h), lyrH);
    const medGap = gaps.length ? median(gaps, medH) : medH;
    const fs = Math.min(medH, medGap); // 字号取本行 min(字高,字距)，密排行不溢出相邻字
    const fit = fitLine(ln.map((r) => ({ x: rcx(r.bbox), y: rcy(r.bbox) })));
    for (const r of ln) {
      const x = rcx(r.bbox);
      // 把**首字**中心对到 bbox 中心（音符对位锚点），尾随标点向右自然拖出、不再把整串
      // 居中而把可见汉字左拽——否则带标点音节(说，/降，)会左移半个标点宽，与右邻字重叠。
      const t = text(x - fs / 2, fit(x), r.text, fs, "start");
      t.setAttribute("class", "omr-lyric");
      g.appendChild(t);
    }
  }
}

/** 页眉文本叠加：字号贴源图 bbox 高（标题大小本就不一）。**只设字号、不拉伸字形**。
 *  有逐字源位(chars)时——展开排布的标题/著作者行按 OCR 字位逐字对位(每字按中心居中)，
 *  不再整行左对齐挤在一头；否则整行按 bbox 左上角左对齐绘制。 */
function renderHeaderRegion(g: SVGGElement, r: { text: string; bbox: Rect; chars?: { text: string; cx: number }[] }, cls: string): void {
  const b = r.bbox;
  const fs = b.h * 0.92;
  if (r.chars && r.chars.length) {
    const cy = b.y + b.h / 2;
    for (const c of r.chars) {
      const t = text(c.cx, cy, c.text, fs, "middle"); // 按 OCR 源位居中，逐字对位
      t.setAttribute("class", cls);
      g.appendChild(t);
    }
    return;
  }
  const t = text(b.x, b.y + b.h * 0.82, r.text, fs, "start");
  t.setAttribute("dominant-baseline", "alphabetic");
  t.setAttribute("class", cls);
  g.appendChild(t);
}

/** 一条音符上方弧线（圆滑线/连音线）：从 a 到 b 顶上凸起的二次贝塞尔。
 *  坐标用**叠加里音符的实际绘制位置**——横向 x、纵向音符框顶 topY、统一字号 h，
 *  而非源图 bbox（源图两端 bbox.y 高低不一会把弧画歪）。 */
function arc(x1: number, top1: number, x2: number, top2: number, h: number, cls: string): SVGPathElement {
  const gap = h * 0.25;
  const y1 = top1 - gap, y2 = top2 - gap;
  const span = Math.abs(x2 - x1);
  const lift = Math.min(h * 1.2, gap + span * 0.18); // 弧高随跨度，封顶
  const cx = (x1 + x2) / 2, cy = Math.min(y1, y2) - lift;
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke-width", String(Math.max(1.5, h * 0.06)));
  p.setAttribute("class", cls);
  return p;
}

/** 配对并画出 slur(圆滑线)/tie(连音线) 弧。按阅读序用栈配对 start/stop，仅同行内绘弧。
 *  弧端点取音符在叠加中的实际绘制位置：x=rcx(bbox)、顶=fit(x)-noteH/2（与 renderNum 同一斜线/字号）。 */
function renderSlursTies(g: SVGGElement, score: RecognizedScore, rowFits: ((x: number) => number)[], noteH: number): void {
  type N = { cx: number; top: number; row: number; n: JpNum };
  const flat: N[] = [];
  score.rows.forEach((row, ri) => row.nums.forEach((n) => {
    const cx = rcx(n.bbox);
    flat.push({ cx, top: rowFits[ri](cx) - noteH / 2, row: ri, n });
  }));
  const slurStack: N[] = [], tieStack: N[] = [];
  for (const it of flat) {
    if (it.n.slurStop) { const s = slurStack.pop(); if (s && s.row === it.row) g.appendChild(arc(s.cx, s.top, it.cx, it.top, noteH, "omr-slur")); }
    if (it.n.tieStop) { const s = tieStack.pop(); if (s && s.row === it.row) g.appendChild(arc(s.cx, s.top, it.cx, it.top, noteH, "omr-tie")); }
    if (it.n.slurStart) slurStack.push(it);
    if (it.n.tieStart) tieStack.push(it);
  }
}

/** 二值图 + RecognizedScore → 叠加核对 SVG：二值底图打底 + 半透明识别叠加（页眉/音符/弧线按原位，透出底图对位）。 */
export function renderRecognitionSvg(bin: Binary, score: RecognizedScore): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "omr-recognize");
  svg.setAttribute("viewBox", `0 0 ${bin.w} ${bin.h}`);
  svg.style.width = "100%";
  svg.style.display = "block";

  // 背景：二值化源图（与识别叠加均衡显示，作对位参考）
  const img = document.createElementNS(SVG_NS, "image");
  img.setAttribute("x", "0");
  img.setAttribute("y", "0");
  img.setAttribute("width", String(bin.w));
  img.setAttribute("height", String(bin.h));
  // 现代浏览器用无前缀 href 即可，旧渲染器认 xlink:href；两者都设最稳。
  const url = binDataUrl(bin);
  img.setAttributeNS("http://www.w3.org/1999/xlink", "href", url);
  img.setAttribute("href", url);
  svg.appendChild(img);

  // 叠加层（半透明，透出底图对位；opacity 与 pointer-events 由 CSS 控）
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "omr-overlay");

  // 统计平均字号：音符、歌词各按全谱 bbox 高的平均值统一字号（避免逐元素 bbox 抖动）。
  const noteH = mean(score.rows.flatMap((row) => row.nums.map((n) => n.bbox.h)), 24);
  const lyrH = mean((score.lyricRegions ?? []).map((r) => r.bbox.h), noteH);
  // 八度点/附点半径：优先用识别到的源图统计点径（dotDiam），无则退回按字号推算。
  const dotR = Math.max(1.2, score.dotDiam ? score.dotDiam / 2 : noteH * 0.08);

  // 页眉文本按识别到的源图位置/字号叠加（标题字号本就不一，保留各自 bbox 字号）
  for (const r of score.headerRegions ?? []) renderHeaderRegion(g, r, "omr-header");
  // 歌词：按 verse 行聚类、整行落同一基线叠加（避免"一"等矮字上下错位）
  renderLyricsAligned(g, score.lyricRegions ?? [], lyrH);

  // 小节线统一长度：取各行高度均值（略放大露头），所有小节线等长，免逐行长短不一。
  const barLen = mean(score.rows.map((r) => r.bottomY - r.topY), noteH * 1.6) * 1.15;
  const barW = Math.max(2.5, noteH * 0.08);
  // 各行音符中心拟合成一条（可倾斜）直线：音符/小节线/弧线都落在这条线上，顺图片倾斜走、抹平抖动。
  const rowFits = score.rows.map((row) => fitLine(row.nums.map((n) => ({ x: rcx(n.bbox), y: rcy(n.bbox) }))));
  score.rows.forEach((row, ri) => {
    const fit = rowFits[ri];
    // 小节线：统一长度(均值)，中点落在本行音符中线 fit(bx) 上（与音符同一条斜线）。
    for (const bx of row.barlineXs) {
      const cy = fit(bx);
      g.appendChild(line(bx, cy - barLen / 2, bx, cy + barLen / 2, barW, "omr-barline"));
    }
    // 音符 + 修饰：逐符落到 fit 对应 x 处，字号统一平均音符高。
    for (const n of row.nums) renderNum(g, n, noteH, fit(rcx(n.bbox)), dotR);
  });

  // 圆滑线/连音线弧（在音符之上）：端点取音符在叠加中的实际绘制位置（同一斜线/字号）
  renderSlursTies(g, score, rowFits, noteH);

  svg.appendChild(g);
  return svg;
}
