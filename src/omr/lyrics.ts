// 简谱歌词识别 + 逐音节↔音符对齐。
// musicpp 的 jianpu.cpp::processLrc 只找出歌词行范围，真正"字↔符头"对齐(text.cpp::mergeLyricByNotes)
// 在另一套 PDF 模型里、按 x 重叠完成。这里照其原则用 x 对齐：
//   1. 在每个乐谱行下方的"歌词带"里取字号大小的连通块；按 y 分成若干 verse 行(W1/W2…)。
//   2. 行内把连通块(汉字常由多个偏旁连通块组成)按 x 邻近并成"字格"。
//   3. 每个字格裁成画布 → PaddleOCR 识别汉字。
//   4. 按 x 单调最近，把每个汉字分配给本乐谱行里 x 最接近的音符(melisma→某些音符无字，正确)。
import type { Binary, Component, JpNum, Rect, StaffRow, TextRegion } from "./types";
import { rright, rbottom, rcx, rcy } from "./types";
import type { OcrBackend } from "./ocr";

const median = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
const isHanzi = (c: string) => /[一-鿿]/.test(c);
// 歌词里贴在字尾的标点。简谱印刷用全角，但 PP-OCR 常把 ，；：！？ 识成半角 , ; : ! ? ——
// 一并收下、统一折成全角（与 GT 一致；半角句点 . 不收，避免撞段号 "1." / 小数点）。
const LYRIC_PUNCT = /[，。、；：！？…—,;:!?]/;
const PUNCT_FULL: Record<string, string> = { ",": "，", ";": "；", ":": "：", "!": "！", "?": "？" };
const normPunct = (ch: string) => PUNCT_FULL[ch] ?? ch;

/** 把一行(同 y)的连通块按 x 邻近并成字格。返回每个字格的合并包围盒，按 x 排序。 */
export function mergeToChars(line: Component[], charH: number): Rect[] {
  const sorted = [...line].sort((a, b) => a.bbox.x - b.bbox.x);
  const cells: Rect[] = [];
  const gap = charH * 0.28;       // 偏旁间距 < 此值算同字
  const maxW = charH * 1.7;       // 单字最大宽度，避免把两字并一起
  for (const c of sorted) {
    const b = c.bbox;
    const last = cells[cells.length - 1];
    if (last && b.x <= rright(last) + gap && (rright(b) - last.x) <= maxW) {
      // 并入上一个字格
      const x = Math.min(last.x, b.x), y = Math.min(last.y, b.y);
      last.w = Math.max(rright(last), rright(b)) - x;
      last.h = Math.max(rbottom(last), rbottom(b)) - y;
      last.x = x; last.y = y;
    } else {
      cells.push({ ...b });
    }
  }
  return cells;
}

// 一个 rec 块：本乐谱行(rowIdx)某 verse 的若干相邻字格（拼一条横图整体 rec）。
interface Chunk { rowIdx: number; verse: number; cells: Rect[]; }

// 调试可视化用：设 globalThis.__lyricTrace={} 后 recognizeLyrics 逐步把各阶段 I/O 记进来（供生成算法说明 HTML）。
export interface LyricTrace {
  numH?: number; charMin?: number; slope?: number; charW?: number;
  rows?: Array<{ rowIdx: number; yTop: number; yBot: number; charH: number;
    bandBoxes: Rect[]; noteBoxes: Rect[]; verses: Array<{ verse: number; cells: Rect[]; cov: number; longGapBefore?: boolean[] }> }>;
  chunks?: Array<{ rowIdx: number; verse: number; cells: Rect[]; crop: Rect }>;
  recPerChunk?: Array<Array<{ ch: string; xFrac: number }>>;
  placed?: Record<string, Array<{ x: number; ch: string }>>;
  aligned?: Record<string, Array<{ noteX: number; noteBox: Rect; lyric: string }>>;
}
const STRIP_H = 48, STRIP_MAXW = 300; // rec 宽上限 320 → 单条限 ~5 字免压扁

/** 整幅二值图 → 黑字白底源画布（供拼条裁剪）。 */
export function srcCanvasOf(bin: Binary): OffscreenCanvas {
  const cv = new OffscreenCanvas(bin.w, bin.h);
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  const img = new ImageData(bin.w, bin.h);
  for (let i = 0; i < bin.data.length; i++) { const v = bin.data[i] ? 0 : 255; const p = i * 4; img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** 裁一块字格所覆盖的**自然连续区域**(保留原始字间距/渲染，不重拼)，缩到高 STRIP_H 整体 rec。
 *  自然排版让 PP-OCR 远比逐字/拼接 rec 准；块按宽度上限切，避免长行被压扁(rec 宽上限 320)。 */
export function buildStrip(src: OffscreenCanvas, cells: Rect[], H = STRIP_H): OffscreenCanvas {
  const x0 = Math.min(...cells.map((r) => r.x));
  const x1 = Math.max(...cells.map((r) => r.x + r.w));
  const y0 = Math.min(...cells.map((r) => r.y));
  const y1 = Math.max(...cells.map((r) => r.y + r.h));
  const pad = 4;
  const sw = x1 - x0 + pad * 2, sh = y1 - y0 + pad * 2;
  const W = Math.max(1, Math.round(sw * H / sh));
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(src, x0 - pad, y0 - pad, sw, sh, 0, 0, W, H);
  return cv;
}

/** 把一行字格按自然宽度上限切成若干块（每块缩到 H 后 ≤ ~300px → 不超 rec 宽上限 320）。 */
export function chunkCells(cells: Rect[]): Rect[][] {
  const chunks: Rect[][] = [];
  let cur: Rect[] = [];
  const widthAtH = (rs: Rect[]) => {
    const x0 = Math.min(...rs.map((r) => r.x)), x1 = Math.max(...rs.map((r) => r.x + r.w));
    const y0 = Math.min(...rs.map((r) => r.y)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    return (x1 - x0) * STRIP_H / (y1 - y0);
  };
  for (const r of cells) {
    if (cur.length && widthAtH([...cur, r]) > STRIP_MAXW) { chunks.push(cur); cur = []; }
    cur.push(r);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ── 全局斜率 + 错切（deslant）───────────────────────────────────────────────
// 前设：音符/歌词各在同一条（可能倾斜）线上，全图共用一个斜率 k=dy/dx。
// 用每个谱行「最左 vs 最右音符」中心连线的斜率、跨行取中位得 k（小节线竖直不粘连，音符即便
// 粘连其中心仍给可用基线）。deslant-y：dcy = y - k*x —— 同一斜线上的点 dcy 相同 → 斜线变水平，
// 便于按 y 分 verse 行、按 x 做列投影分字。x 不受斜率影响，故 x 方向的分割仍在原坐标进行。
export function globalSlope(staff: StaffRow[]): number {
  const slopes: number[] = [];
  for (const row of staff) {
    if (row.nums.length < 2) continue;
    let L = row.nums[0], R = row.nums[0];
    for (const n of row.nums) {
      if (n.bbox.x < L.bbox.x) L = n;
      if (rright(n.bbox) > rright(R.bbox)) R = n;
    }
    const dx = rcx(R.bbox) - rcx(L.bbox);
    if (Math.abs(dx) < 1) continue;
    const s = (rcy(R.bbox) - rcy(L.bbox)) / dx;
    if (Math.abs(s) < 0.5) slopes.push(s); // 防退化（几乎不可能 >0.5）
  }
  return slopes.length ? median(slopes) : 0;
}

// 一个投影字块：源图 x 区间 + deslant-y 上下界（ink 实际纵向范围）+ 与前一块的原始间隙(px)。
interface ProjBlock { x0: number; x1: number; dyTop: number; dyBot: number; gapBefore: number; }

/** 对一条 verse 行做**斜率感知的列投影**分字（替代连通域 mergeToChars）。
 *  在该行 ink 的 deslant-y 窗口内逐列累加前景像素 → 成 run；相邻 run 间隙 < mergeGap（偏旁内间隙）
 *  并成一个字块（**粘连字整体保留、绝不硬切**）；每块记与前块的原始间隙(px)，供上层据 charW 判长空白。
 *  同时记每列 ink 的 deslant-y 上下界，产出每块真实 y 范围（供裁条/定位/字高统计）。 */
function projectLine(bin: Binary, line: Component[], k: number, mergeGap: number): ProjBlock[] {
  const w = bin.w, h = bin.h, data = bin.data;
  const x0 = Math.max(0, Math.min(...line.map((c) => c.bbox.x)));
  const x1 = Math.min(w - 1, Math.max(...line.map((c) => rright(c.bbox))));
  if (x1 <= x0) return [];
  // 本行 ink 的 deslant-y 窗口（用连通块的 deslant 上下界 + 少量留白）。
  const dyLo = Math.min(...line.map((c) => c.bbox.y - k * rcx(c.bbox))) - 2;
  const dyHi = Math.max(...line.map((c) => rbottom(c.bbox) - k * rcx(c.bbox))) + 2;
  const n = x1 - x0 + 1;
  const cnt = new Int32Array(n);
  const colTop = new Float64Array(n).fill(Infinity);
  const colBot = new Float64Array(n).fill(-Infinity);
  for (let x = x0; x <= x1; x++) {
    const yLo = Math.max(0, Math.round(dyLo + k * x));
    const yHi = Math.min(h - 1, Math.round(dyHi + k * x));
    const i = x - x0;
    for (let y = yLo; y <= yHi; y++) {
      if (data[y * w + x]) { cnt[i]++; const dyv = y - k * x; if (dyv < colTop[i]) colTop[i] = dyv; if (dyv > colBot[i]) colBot[i] = dyv; }
    }
  }
  // 列廓 → run（含 ink 的连续列）→ 按间隙并成字块。
  const runs: { x0: number; x1: number; dyTop: number; dyBot: number }[] = [];
  let rs = -1;
  for (let i = 0; i < n; i++) {
    if (cnt[i] > 0) { if (rs < 0) rs = i; }
    else if (rs >= 0) { runs.push(mkRun(rs, i - 1)); rs = -1; }
  }
  if (rs >= 0) runs.push(mkRun(rs, n - 1));
  function mkRun(a: number, b: number) {
    let t = Infinity, bo = -Infinity;
    for (let i = a; i <= b; i++) { if (colTop[i] < t) t = colTop[i]; if (colBot[i] > bo) bo = colBot[i]; }
    return { x0: x0 + a, x1: x0 + b, dyTop: t, dyBot: bo };
  }
  const blocks: ProjBlock[] = [];
  for (const r of runs) {
    const last = blocks[blocks.length - 1];
    const gap = last ? r.x0 - last.x1 : Infinity;
    if (last && gap < mergeGap) { // 偏旁内间隙 → 并入上一字块（不切）
      last.x1 = r.x1; last.dyTop = Math.min(last.dyTop, r.dyTop); last.dyBot = Math.max(last.dyBot, r.dyBot);
    } else {
      blocks.push({ x0: r.x0, x1: r.x1, dyTop: r.dyTop, dyBot: r.dyBot, gapBefore: gap });
    }
  }
  return blocks;
}

/** 把「尾随标点大小的小墨块」并入前一字块：小墨块(宽<0.45charW)、紧贴前字(自身间隙非长空白)、
 *  且其后就是乐句断点(长空白/行末) → 判为该字的尾随标点，并入前块。使字块=汉字+尾随标点，
 *  裁条时标点落进同一自然区域整体 rec（读得出淡逗号则免几何补回；结构上也不再是游离小格）。 */
function mergePunctBlocks(blocks: ProjBlock[], charW: number, longGap: number): ProjBlock[] {
  if (blocks.length < 2) return blocks;
  const out = blocks.map((b) => ({ ...b }));
  for (let i = out.length - 1; i >= 1; i--) {
    const b = out[i];
    if (b.x1 - b.x0 + 1 >= charW * 0.45) continue;   // 只并标点大小的小墨块
    if (b.gapBefore > longGap) continue;             // 它自己在长空白后 → 是下句首字，别并
    if (i !== out.length - 1 && out[i + 1].gapBefore <= longGap) continue; // 后面不是乐句断点 → 不像尾随标点
    const p = out[i - 1];
    p.x1 = Math.max(p.x1, b.x1); p.dyTop = Math.min(p.dyTop, b.dyTop); p.dyBot = Math.max(p.dyBot, b.dyBot);
    out.splice(i, 1);                                 // 移除后：其后块的 gapBefore（即那道长空白）不变，仍正确
  }
  return out;
}

/** 投影字块 → 源图 Rect（deslant-y 在块中心 x 处折回原坐标；小块内斜率影响可忽略）。 */
function blockRect(b: ProjBlock, k: number): Rect {
  const xc = (b.x0 + b.x1) / 2;
  const y = b.dyTop + k * xc, yb = b.dyBot + k * xc;
  return { x: b.x0, y, w: b.x1 - b.x0 + 1, h: Math.max(1, yb - y) };
}

/** 识别歌词并写回各音符的 lyrics[]；返回每个歌词单元的源图定位+字号（识别模式按原位/原字号叠加）。
 *  staff 为乐谱行(按出现顺序)，comps 为全图连通块。 */
export async function recognizeLyrics(
  bin: Binary, comps: Component[], staff: StaffRow[], numH: number, ocr: OcrBackend,
): Promise<TextRegion[]> {
  const regions: TextRegion[] = [];
  if (!ocr.recognizeTexts || !staff.length) return regions;

  const charMin = numH * 0.5; // 歌词字号下限（约等于音符字号）
  const src = srcCanvasOf(bin);
  const chunks: Chunk[] = [];
  const strips: OffscreenCanvas[] = [];
  const TR = (globalThis as { __lyricTrace?: LyricTrace }).__lyricTrace; // 调试可视化：设置后逐步记录 I/O

  // S0 全局斜率 + deslant-y（同一斜线上的点 dcy 相同 → 斜线变水平）。
  const k = globalSlope(staff);
  const dcy = (c: Component) => c.cy - k * c.cx;             // 连通块中心的 deslant-y
  const dTop = (nums: JpNum[]) => Math.min(...nums.map((n) => n.bbox.y - k * rcx(n.bbox)));
  const dBot = (nums: JpNum[]) => Math.max(...nums.map((n) => rbottom(n.bbox) - k * rcx(n.bbox)));
  if (TR) { TR.numH = numH; TR.charMin = charMin; TR.slope = k; TR.rows = []; }

  for (let i = 0; i < staff.length; i++) {
    const row = staff[i];
    if (!row.nums.length) continue;
    // S1 歌词带（deslant 空间）：本谱行 deslant 下缘 → 下一谱行 deslant 上缘。
    const yTop = dBot(row.nums) + numH * 0.15;
    const yBot = i + 1 < staff.length && staff[i + 1].nums.length
      ? dTop(staff[i + 1].nums) - numH * 0.15 : Infinity;
    if (yBot - yTop < charMin) continue;

    const inBand = (c: Component) => { const y = dcy(c); return y >= yTop && y <= yBot; };
    const band = comps.filter((c) => { const b = c.bbox; return inBand(c) && b.h >= charMin && b.w >= charMin * 0.4; });
    if (!band.length) continue;

    // S2① 按 deslant-y 分 verse 行（斜线已拉平，同一行 dcy 相近）。
    const sortedY = [...band].sort((a, b) => dcy(a) - dcy(b));
    const lines: Component[][] = [];
    for (const c of sortedY) {
      const ln = lines.find((L) => Math.abs(median(L.map(dcy)) - dcy(c)) < numH * 0.7);
      if (ln) ln.push(c); else lines.push([c]);
    }
    // 细而宽的横笔（如"一"，高度不足 charMin）：并入 deslant-y 足够近的 verse 行，扩其 x 范围/投影窗口。
    for (const c of comps) {
      const b = c.bbox;
      if (!inBand(c) || b.h >= charMin || b.h < 2 || b.w < charMin * 0.6) continue;
      const ln = lines.find((L) => Math.abs(median(L.map(dcy)) - dcy(c)) < numH * 0.45);
      if (ln) ln.push(c);
    }
    // 行末/句末标点（；。，等）小巧、不在 band，落在末字右侧空档 → 只扫到字身右缘就永远采不到。
    // 把**紧邻行左右缘（±~1 字宽）的 punct 尺寸小墨块**并入该行，精确扩 x 窗口（不盲扫空白，避免
    // 引入杂点/邻行噪声）；随后投影成块、由 mergePunctBlocks 并入相邻汉字。
    for (const c of comps) {
      const b = c.bbox;
      if (!inBand(c) || b.h >= charMin || b.h < 3 || b.w >= charMin) continue; // 只收小墨块(punct 尺寸)
      const ln = lines.find((L) => Math.abs(median(L.map(dcy)) - dcy(c)) < numH * 0.5);
      if (!ln) continue;
      const lx0 = Math.min(...ln.map((k2) => k2.bbox.x)), lx1 = Math.max(...ln.map((k2) => rright(k2.bbox)));
      if ((c.cx > lx1 && c.cx <= lx1 + numH * 1.1) || (c.cx < lx0 && c.cx >= lx0 - numH * 1.1)) ln.push(c);
    }

    // S3 逐 verse 行投影分字 → 字块（原始间隙待定长空白）。
    const mergeGap = numH * 0.22; // 偏旁内间隙上限（charW≈numH，用于初并；不切粘连）
    const lineBlocks = lines.map((ln) => projectLine(bin, ln, k, mergeGap));
    // S2② 字宽统计 → 筛等宽候选 → 字高统计。
    const allBlocks = lineBlocks.flat();
    const widths = allBlocks.map((b) => b.x1 - b.x0 + 1).filter((w) => w >= numH * 0.4 && w <= numH * 1.8);
    const charW = median(widths) || numH;
    const candH = allBlocks.filter((b) => { const w = b.x1 - b.x0 + 1; return w >= charW * 0.7 && w <= charW * 1.3; })
      .map((b) => b.dyBot - b.dyTop);
    const charH = median(candH) || charW;
    const longGap = charW * 0.6; // 长空白（乐句/标点后）→ 分块边界
    // 把尾随标点小墨块并入前一字块（字块 = 汉字 + 尾随标点，裁条时一起 rec）。
    const mergedBlocks = lineBlocks.map((blocks) => mergePunctBlocks(blocks, charW, longGap));
    if (TR) TR.charW = charW;

    // S4 注记过滤：真歌词行横向铺满谱行；"(副歌)"/"徐震宇译"/CCLI 版权等注记只占局部。
    const noteX0 = Math.min(...row.nums.map((n) => n.bbox.x));
    const noteX1 = Math.max(...row.nums.map((n) => rright(n.bbox)));
    const noteSpan = Math.max(1, noteX1 - noteX0);
    const lineInfo = mergedBlocks.map((blocks) => {
      const cells = blocks.map((b) => blockRect(b, k));
      const longGapBefore = blocks.map((b) => b.gapBefore > longGap);
      const lx0 = cells.length ? Math.min(...cells.map((c) => c.x)) : 0;
      const lx1 = cells.length ? Math.max(...cells.map((c) => rright(c))) : 0;
      return { cells, longGapBefore, cov: cells.length ? (lx1 - lx0) / noteSpan : 0 };
    });
    const maxCov = Math.max(0, ...lineInfo.map((L) => L.cov));
    const kept = lineInfo.filter((L) => L.cells.length && (L.cov >= maxCov - 1e-9 || L.cov >= 0.35));

    const rowT = TR ? { rowIdx: i, yTop, yBot, charH, bandBoxes: band.map((c) => c.bbox),
      noteBoxes: row.nums.map((n) => n.bbox), verses: [] as Array<{ verse: number; cells: Rect[]; cov: number; longGapBefore?: boolean[] }> } : null;
    if (TR && rowT) TR.rows!.push(rowT);

    kept.forEach(({ cells, longGapBefore, cov }, verse) => {
      if (rowT) rowT.verses.push({ verse, cells, cov, longGapBefore });
      // S5 先在长空白边界断成段，各段再按 STRIP_MAXW 宽上限二次切成 rec 块。
      let segStart = 0;
      const segments: Rect[][] = [];
      for (let ci = 1; ci <= cells.length; ci++) {
        if (ci === cells.length || longGapBefore[ci]) { segments.push(cells.slice(segStart, ci)); segStart = ci; }
      }
      for (const seg of segments) for (const chunkCellsArr of chunkCells(seg)) {
        chunks.push({ rowIdx: i, verse, cells: chunkCellsArr });
        strips.push(buildStrip(src, chunkCellsArr));
        if (TR) { const x0 = Math.min(...chunkCellsArr.map((r) => r.x)), y0 = Math.min(...chunkCellsArr.map((r) => r.y));
          const x1 = Math.max(...chunkCellsArr.map((r) => rright(r))), y1 = Math.max(...chunkCellsArr.map((r) => rbottom(r)));
          (TR.chunks ??= []).push({ rowIdx: i, verse, cells: chunkCellsArr, crop: { x: x0 - 4, y: y0 - 4, w: x1 - x0 + 8, h: y1 - y0 + 8 } }); }
      }
    });
  }

  if (!strips.length) return regions;
  const STRIP_PAD = 4; // 与 buildStrip 一致：strip 源区在 cells 两侧各扩 pad，xFrac 换算 x 时要算进去
  // 优先用**带字位**的 rec：每字带 xFrac → 直接落回源图 x，免去"字数↔连通块格数"按序硬配（错位根源）。
  const posMode = !!ocr.recognizeTextsPos;
  const textsPos = posMode ? await ocr.recognizeTextsPos!(strips) : null;
  const texts = posMode ? null : await ocr.recognizeTexts(strips);
  if (TR) TR.recPerChunk = textsPos ?? texts!.map((s) => [...s].map((ch) => ({ ch, xFrac: 0 })));

  // 每块识别字汇总到 (row,verse)，再按 x 单调最近分配给音符。
  // 单元 = 一个汉字 + 紧随其后的尾随标点（，。、；！？等）：简谱标点向左贴前一字、不占音符，
  // 故并入该音节字符串而非另立单元（保持单元↔音符对齐）。段号数字等非汉字非标点 → 直接丢弃、自然不占位。
  const perLine = new Map<string, Array<{ x: number; ch: string; region?: TextRegion }>>();
  const lineSeen = new Set<string>();
  for (let s = 0; s < chunks.length; s++) {
    const { rowIdx, verse, cells } = chunks[s];
    const key = `${rowIdx}:${verse}`;
    const isFirstChunk = !lineSeen.has(key);
    lineSeen.add(key);
    if (!perLine.has(key)) perLine.set(key, []);
    const placed = perLine.get(key)!;
    // 字格纵向范围 + 中位字宽（仅供识别模式叠加按源图定位/取大小）
    const cy0 = Math.min(...cells.map((c) => c.y)), cy1 = Math.max(...cells.map((c) => rbottom(c)));
    const charW = median(cells.map((c) => c.w)) || (cy1 - cy0);

    if (posMode) {
      // 用 OCR 字位 xFrac → 源图 x（strip 源区 [x0-pad, x1+pad] 线性映射到内容宽度）。
      const x0 = Math.min(...cells.map((c) => c.x)) - STRIP_PAD;
      const x1 = Math.max(...cells.map((c) => rright(c))) + STRIP_PAD;
      const span = Math.max(1, x1 - x0);
      for (const { ch, xFrac } of textsPos![s]) {
        const sx = x0 + xFrac * span;
        if (isHanzi(ch)) {
          const region: TextRegion = { text: ch, bbox: { x: sx - charW / 2, y: cy0, w: charW, h: cy1 - cy0 } };
          placed.push({ x: sx, ch, region });
          regions.push(region);
        } else if (LYRIC_PUNCT.test(ch) && placed.length) {
          const p = normPunct(ch);
          placed[placed.length - 1].ch += p;                        // 尾随标点贴前一字（折全角，不移位、不另立单元）
          if (regions.length) regions[regions.length - 1].text += p;
        }
      }
    } else {
      // 回退：后端无字位时，沿用"字↔连通块格"按序映射 + 段号几何剔除（首格落在第一个音符中心左侧 → 段号丢弃）。
      const toks: string[] = [];
      for (const ch of texts![s]) {
        if (isHanzi(ch)) toks.push(ch);
        else if (LYRIC_PUNCT.test(ch) && toks.length) toks[toks.length - 1] += normPunct(ch);
      }
      if (!toks.length) continue;
      let mapCells = cells;
      const notes0 = staff[rowIdx].nums;
      if (isFirstChunk && cells.length > 1 && notes0.length &&
          rright(cells[0]) < rcx(notes0[0].bbox)) mapCells = cells.slice(1);
      for (let j = 0; j < toks.length; j++) {
        const ci = toks.length === mapCells.length ? j : Math.min(mapCells.length - 1, Math.floor(j * mapCells.length / toks.length));
        const region: TextRegion = { text: toks[j], bbox: mapCells[ci] };
        placed.push({ x: rcx(mapCells[ci]), ch: toks[j], region });
        regions.push(region);
      }
    }
  }

  if (TR) { TR.placed = {}; for (const [k, p] of perLine) TR.placed[k] = p.map(({ x, ch }) => ({ x, ch })); }

  // 投影已在自然上下文里把尾随标点并进字块、由 OCR 直接读出（并折全角）→ 不再需要几何补标点。
  for (const [key, placed] of perLine) {
    const [rowIdx, verse] = key.split(":").map(Number);
    const notes = staff[rowIdx].nums;
    if (!notes.length) continue;
    placed.sort((a, b) => a.x - b.x);
    const M = placed.length;
    let ni = 0;
    for (let k = 0; k < M; k++) {
      const { x, ch } = placed[k];
      // 给后续字各留一个音符的上限：第 k 字最多落到 notes.length-(M-k)。
      // 否则贪心 x-最近会因某字 x 略偏右而跳格(多留一个空白 melisma)，
      // 误差向行尾累积，把末尾两字挤进同一音符（实测「人·心怎能说尽」错位即此）。
      const maxNi = Math.max(0, notes.length - (M - k));
      while (ni + 1 < notes.length && ni + 1 <= maxNi &&
             Math.abs(rcx(notes[ni + 1].bbox) - x) <= Math.abs(rcx(notes[ni].bbox) - x)) ni++;
      if (ni > maxNi) ni = maxNi;
      const nt = notes[ni];
      if (!nt.lyrics) nt.lyrics = [];
      nt.lyrics[verse] = (nt.lyrics[verse] || "") + ch;
      if (ni < notes.length - 1) ni++;
    }
    if (TR) (TR.aligned ??= {})[key] = notes.map((n) => ({ noteX: rcx(n.bbox), noteBox: n.bbox, lyric: n.lyrics?.[verse] || "" }));
  }
  return regions;
}
