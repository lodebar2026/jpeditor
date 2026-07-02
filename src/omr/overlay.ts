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
    // 低音点：紧贴减时线（无减时线则贴音符框下沿）下方，只留一个小间距，
    // 不再复用上点的大 gap——否则低音点离音符太远（简谱约定低音点紧邻减时线）。
    const lowGap = Math.max(r * 1.6, H * 0.14);
    const lowBase = (n.div > 0 ? divBottom : bot) + lowGap; // 低音点首点基线（贴减时线下方）
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
/** 歌词按 y 聚成 verse 行（返回按 y 升序、即 W1、W2… 的行组）。 */
function clusterLyricLines(regions: { text: string; bbox: Rect }[], lyrH: number): { text: string; bbox: Rect }[][] {
  const sorted = [...regions].sort((a, b) => rcy(a.bbox) - rcy(b.bbox));
  const lines: { text: string; bbox: Rect }[][] = [];
  for (const r of sorted) {
    const ln = lines.find((L) => Math.abs(median(L.map((k) => rcy(k.bbox)), 0) - rcy(r.bbox)) < lyrH * 0.7);
    if (ln) ln.push(r); else lines.push([r]);
  }
  return lines;
}

/** 各 verse 行的中心 y（按 W1、W2… 顺序）。歌词命中框竖向定位用。 */
function verseBands(regions: { text: string; bbox: Rect }[], lyrH: number): number[] {
  return clusterLyricLines(regions, lyrH).map((ln) => median(ln.map((r) => rcy(r.bbox)), 0));
}

function renderLyricsAligned(g: SVGGElement, regions: { text: string; bbox: Rect }[], lyrH: number): void {
  if (!regions.length) return;
  const lines = clusterLyricLines(regions, lyrH);
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
function renderSlursTies(g: SVGGElement, score: RecognizedScore, rowFits: ((x: number) => number)[], noteH: number, rowFilter?: Set<number>): void {
  type N = { cx: number; top: number; row: number; n: JpNum };
  const flat: N[] = [];
  score.rows.forEach((row, ri) => {
    if (rowFilter && !rowFilter.has(ri)) return;
    row.nums.forEach((n) => {
      const cx = rcx(n.bbox);
      flat.push({ cx, top: rowFits[ri](cx) - noteH / 2, row: ri, n });
    });
  });
  const slurStack: N[] = [], tieStack: N[] = [];
  for (const it of flat) {
    if (it.n.slurStop) { const s = slurStack.pop(); if (s && s.row === it.row) g.appendChild(arc(s.cx, s.top, it.cx, it.top, noteH, "omr-slur")); }
    if (it.n.tieStop) { const s = tieStack.pop(); if (s && s.row === it.row) g.appendChild(arc(s.cx, s.top, it.cx, it.top, noteH, "omr-tie")); }
    if (it.n.slurStart) slurStack.push(it);
    if (it.n.tieStart) tieStack.push(it);
  }
}

/** 识别视图：原位叠加 / 附近浮窗 / 仅原图。 */
export type RecogView = "inplace" | "floating" | "original";

/** 全谱统一的绘制统计（音符/歌词字号、点径、小节线尺度、各行拟合斜线）。三视图共用，保持一致。 */
interface Stats {
  noteH: number;
  lyrH: number;
  dotR: number;
  barLen: number;
  barW: number;
  rowFits: ((x: number) => number)[];
}

function computeStats(score: RecognizedScore): Stats {
  const noteH = mean(score.rows.flatMap((row) => row.nums.map((n) => n.bbox.h)), 24);
  const lyrH = mean((score.lyricRegions ?? []).map((r) => r.bbox.h), noteH);
  const dotR = Math.max(1.2, score.dotDiam ? score.dotDiam / 2 : noteH * 0.08);
  const barLen = mean(score.rows.map((r) => r.bottomY - r.topY), noteH * 1.6) * 1.15;
  const barW = Math.max(2.5, noteH * 0.08);
  const rowFits = score.rows.map((row) => fitLine(row.nums.map((n) => ({ x: rcx(n.bbox), y: rcy(n.bbox) }))));
  return { noteH, lyrH, dotR, barLen, barW, rowFits };
}

/** 构建识别结果叠加层 `<g.omr-overlay>`。opts 控制画哪些行/是否画页眉/歌词——供全图叠加与浮窗复用。 */
function buildOverlayGroup(
  score: RecognizedScore,
  stats: Stats,
  opts?: { rows?: number[]; header?: boolean; lyrics?: boolean },
): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "omr-overlay");
  const rowSet = opts?.rows ? new Set(opts.rows) : null;
  const { noteH, lyrH, dotR, barLen, barW, rowFits } = stats;

  if (opts?.header !== false) {
    for (const r of score.headerRegions ?? []) renderHeaderRegion(g, r, "omr-header");
  }
  if (opts?.lyrics !== false) {
    renderLyricsAligned(g, score.lyricRegions ?? [], lyrH);
  }
  score.rows.forEach((row, ri) => {
    if (rowSet && !rowSet.has(ri)) return;
    const fit = rowFits[ri];
    for (const bx of row.barlineXs) {
      const cy = fit(bx);
      g.appendChild(line(bx, cy - barLen / 2, bx, cy + barLen / 2, barW, "omr-barline"));
    }
    for (const n of row.nums) renderNum(g, n, noteH, fit(rcx(n.bbox)), dotR);
  });
  renderSlursTies(g, score, rowFits, noteH, rowSet ?? undefined);
  return g;
}

/** 透明命中层 `<g.omr-hits>`：每个可点选对象一个透明 rect，带 data 属性供 app 定位到 jpwabc 代码。
 *  音符 data-i=第i个音符（== flatten 顺序 == JpwMeta 索引）；歌词 data-i/data-verse；页眉 data-kind=title/author。 */
function buildHitLayer(score: RecognizedScore, stats: Stats): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "omr-hits");
  const flat = score.rows.flatMap((row, ri) => row.nums.map((n) => ({ n, ri })));
  // 每个乐谱行**各自下方**的 verse 行带中心（按 y 升序即 W1、W2…）。多 system 谱各行歌词各归各行，
  // 不能用全谱 verseBands（那会把 system2+ 的歌词命中框错放到 system1 的 y）。
  const allLyr = score.lyricRegions ?? [];
  const rowBands: number[][] = score.rows.map((row, ri) => {
    const nextTop = ri + 1 < score.rows.length ? score.rows[ri + 1].topY : Infinity;
    const zone = allLyr.filter((r) => rcy(r.bbox) > row.bottomY && rcy(r.bbox) < nextTop);
    return verseBands(zone, stats.lyrH);
  });

  const hit = (b: Rect, attrs: Record<string, string>): void => {
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("x", String(b.x));
    r.setAttribute("y", String(b.y));
    r.setAttribute("width", String(Math.max(1, b.w)));
    r.setAttribute("height", String(Math.max(1, b.h)));
    for (const [k, v] of Object.entries(attrs)) r.setAttribute(k, v);
    g.appendChild(r);
  };

  flat.forEach(({ n, ri }, i) => {
    hit(n.bbox, { "data-kind": "note", "data-i": String(i), class: "omr-hit" });
    // 歌词命中：横向按音符 bbox，竖向落到**本行下方**对应 verse 行带中心。
    const lyr = n.lyrics ?? [];
    for (let v = 0; v < lyr.length; v++) {
      const by = rowBands[ri][v];
      if (!lyr[v] || by === undefined) continue;
      // 歌词命中框用统计出的汉字字号（lyrH×lyrH 方框），横向以音符中心对齐——
      // 而非各音符宽窄不一的 bbox.w，使悬停/选中高亮与实际汉字大小相符。
      hit(
        { x: rcx(n.bbox) - stats.lyrH / 2, y: by - stats.lyrH / 2, w: stats.lyrH, h: stats.lyrH },
        { "data-kind": "lyric", "data-i": String(i), "data-verse": String(v), class: "omr-hit" },
      );
    }
  });

  const title = (score.title ?? "").trim();
  for (const r of score.headerRegions ?? []) {
    const isTitle = title.length > 0 && r.text.trim() === title;
    hit(r.bbox, isTitle
      ? { "data-kind": "title", class: "omr-hit" }
      : { "data-kind": "author", "data-text": r.text.trim(), class: "omr-hit" });
  }
  return g;
}

function baseImage(bin: Binary): SVGImageElement {
  const img = document.createElementNS(SVG_NS, "image");
  img.setAttribute("x", "0");
  img.setAttribute("y", "0");
  img.setAttribute("width", String(bin.w));
  img.setAttribute("height", String(bin.h));
  const url = binDataUrl(bin);
  img.setAttributeNS("http://www.w3.org/1999/xlink", "href", url);
  img.setAttribute("href", url);
  return img;
}

/** 二值图 + RecognizedScore → 识别核对 SVG。视图：
 *  - inplace：二值底图 + 半透明识别叠加（原位）。
 *  - floating/original：仅二值底图（浮窗由 app 悬停时另建）。
 *  三视图均附透明命中层，供点选定位 jpwabc 代码 / 悬停高亮。 */
export function renderRecognitionSvg(bin: Binary, score: RecognizedScore, view: RecogView = "inplace"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "omr-recognize");
  svg.setAttribute("viewBox", `0 0 ${bin.w} ${bin.h}`);
  svg.style.width = "100%";
  svg.style.display = "block";

  svg.appendChild(baseImage(bin));

  const stats = computeStats(score);
  if (view === "inplace") svg.appendChild(buildOverlayGroup(score, stats));
  svg.appendChild(buildHitLayer(score, stats));
  return svg;
}

/** 一行的竖向内容范围（含八度点 + 本行下方歌词带），供浮窗 viewBox 竖向裁剪。横向用整幅源图宽以便 1:1 对比。 */
function rowContentExtent(score: RecognizedScore, stats: Stats, ri: number): { top: number; bottom: number } {
  const row = score.rows[ri];
  const nextTop = ri + 1 < score.rows.length ? score.rows[ri + 1].topY : Infinity;
  const zone = (score.lyricRegions ?? []).filter((r) => rcy(r.bbox) > row.bottomY && rcy(r.bbox) < nextTop);
  const bands = verseBands(zone, stats.lyrH);
  const top = row.topY - stats.noteH;
  const bottom = (bands.length ? Math.max(row.bottomY, ...bands) + stats.lyrH : row.bottomY) + stats.noteH * 0.4;
  return { top, bottom };
}

/** 浮窗 SVG：full=true 时宽度撑满容器（与源图同宽、列对齐，便于对比）；否则按 viewBox 定宽（页眉用）。 */
function popupSvg(bin: Binary, vb: { x: number; y: number; w: number; h: number }, g: SVGGElement, full: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "omr-recognize");
  svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  if (full) {
    svg.style.width = "100%";
    svg.style.height = "auto";
  } else {
    const w = Math.min(bin.w, 480);
    svg.style.width = `${w}px`;
    svg.style.height = `${(w * vb.h) / vb.w}px`;
  }
  svg.style.display = "block";
  svg.appendChild(g);
  return svg;
}

/** 浮窗：单行识别数据（干净渲染）。横向用整幅源图宽（列与源图对齐），竖向裁到该行+其下方歌词带。
 *  返回 svg 及该行内容在源图的竖向范围（srcTop/srcBottom），供 app 定位到当前 system 之下（不盖歌词）。 */
export function renderRowPopup(bin: Binary, score: RecognizedScore, rowIndex: number): { svg: SVGSVGElement; srcTop: number; srcBottom: number } {
  const stats = computeStats(score);
  const g = buildOverlayGroup(score, stats, { rows: [rowIndex], header: false, lyrics: true });
  const ext = rowContentExtent(score, stats, rowIndex);
  const vb = { x: 0, y: ext.top, w: bin.w, h: ext.bottom - ext.top };
  return { svg: popupSvg(bin, vb, g, true), srcTop: ext.top, srcBottom: ext.bottom };
}

/** 浮窗：整块页眉信息（干净渲染，整幅宽，返回竖向范围供 app 定位到页眉之下）。 */
export function renderHeaderPopup(bin: Binary, score: RecognizedScore): { svg: SVGSVGElement; srcTop: number; srcBottom: number } {
  const stats = computeStats(score);
  const g = buildOverlayGroup(score, stats, { rows: [], header: true, lyrics: false });
  const regs = score.headerRegions ?? [];
  if (!regs.length) {
    return { svg: popupSvg(bin, { x: 0, y: 0, w: bin.w, h: stats.noteH }, g, true), srcTop: 0, srcBottom: stats.noteH };
  }
  const minY = Math.min(...regs.map((r) => r.bbox.y));
  const maxY = Math.max(...regs.map((r) => r.bbox.y + r.bbox.h));
  const pad = stats.lyrH * 0.5;
  const vb = { x: 0, y: minY - pad, w: bin.w, h: maxY - minY + pad * 2 };
  return { svg: popupSvg(bin, vb, g, true), srcTop: minY, srcBottom: maxY };
}
