// 简谱歌词识别 + 逐音节↔音符对齐。
// musicpp 的 jianpu.cpp::processLrc 只找出歌词行范围，真正"字↔符头"对齐(text.cpp::mergeLyricByNotes)
// 在另一套 PDF 模型里、按 x 重叠完成。这里照其原则用 x 对齐：
//   1. 在每个乐谱行下方的"歌词带"里取字号大小的连通块；按 y 分成若干 verse 行(W1/W2…)。
//   2. 行内把连通块(汉字常由多个偏旁连通块组成)按 x 邻近并成"字格"。
//   3. 每个字格裁成画布 → PaddleOCR 识别汉字。
//   4. 按 x 单调最近，把每个汉字分配给本乐谱行里 x 最接近的音符(melisma→某些音符无字，正确)。
import type { Binary, Component, Rect, StaffRow, TextRegion } from "./types";
import { rright, rbottom, rcx } from "./types";
import type { OcrBackend } from "./ocr";

const median = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
const isHanzi = (c: string) => /[一-鿿]/.test(c);
// 歌词里贴在字尾的全角标点（简谱印刷用全角；半角多为页眉/版权噪声，不收）。
const LYRIC_PUNCT = /[，。、；：！？…—]/;

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

  for (let i = 0; i < staff.length; i++) {
    const row = staff[i];
    const yTop = row.bottomY + Math.round(numH * 0.15);
    const yBot = i + 1 < staff.length ? staff[i + 1].topY - Math.round(numH * 0.15) : bin.h;
    if (yBot - yTop < charMin) continue;

    const inBand = (c: Component) => { const cy = c.bbox.y + c.bbox.h / 2; return cy >= yTop && cy <= yBot; };
    const band = comps.filter((c) => { const b = c.bbox; return inBand(c) && b.h >= charMin && b.w >= charMin * 0.4; });
    if (!band.length) continue;

    // 按 y 分 verse 行（只用正常字号块定行，避免减时线等横笔干扰）
    const charH = median(band.map((c) => c.bbox.h)) || numH;
    const sortedY = [...band].sort((a, b) => a.cy - b.cy);
    const lines: Component[][] = [];
    for (const c of sortedY) {
      const ln = lines.find((L) => Math.abs(median(L.map((k) => k.cy)) - c.cy) < charH * 0.7);
      if (ln) ln.push(c); else lines.push([c]);
    }

    // 细而宽的横笔（如"一"——高度仅笔画粗细，远不及 charMin，整字会被上面漏掉）：
    // 只在它纵向落进某条 verse 行（与该行中线足够近）时并入，从而排除减时线等乐谱区横块。
    for (const c of comps) {
      const b = c.bbox;
      if (!inBand(c) || b.h >= charMin || b.h < 2 || b.w < charMin * 0.6) continue;
      const ln = lines.find((L) => Math.abs(median(L.map((k) => k.cy)) - c.cy) < charH * 0.45);
      if (ln) ln.push(c);
    }

    // 真歌词行横向铺满整个乐谱行；像 "(副歌)" 标签、页脚 "徐震宇译"/CCLI 版权这类注记只占局部，
    // 会被 y-聚类当成多余 verse 行，挤错副歌的 verse 序号。按"横跨乐谱行宽度的占比"剔除：
    // 保留本行覆盖率最高的那条，其余覆盖率 <0.35 的判为注记丢弃。（实测真行 0.83~0.98、注记 0.08/0.21）
    const noteX0 = Math.min(...row.nums.map((n) => n.bbox.x));
    const noteX1 = Math.max(...row.nums.map((n) => rright(n.bbox)));
    const noteSpan = Math.max(1, noteX1 - noteX0);
    const lineInfo = lines.map((ln) => {
      const cells = mergeToChars(ln, charH);
      const lx0 = Math.min(...cells.map((c) => c.x)), lx1 = Math.max(...cells.map((c) => rright(c)));
      return { cells, cov: (lx1 - lx0) / noteSpan };
    });
    const maxCov = Math.max(0, ...lineInfo.map((L) => L.cov));
    const kept = lineInfo.filter((L) => L.cov >= maxCov - 1e-9 || L.cov >= 0.35);

    kept.forEach(({ cells }, verse) => {
      for (const chunkCellsArr of chunkCells(cells)) {
        chunks.push({ rowIdx: i, verse, cells: chunkCellsArr });
        strips.push(buildStrip(src, chunkCellsArr));
      }
    });
  }

  if (!strips.length) return regions;
  const STRIP_PAD = 4; // 与 buildStrip 一致：strip 源区在 cells 两侧各扩 pad，xFrac 换算 x 时要算进去
  // 优先用**带字位**的 rec：每字带 xFrac → 直接落回源图 x，免去"字数↔连通块格数"按序硬配（错位根源）。
  const posMode = !!ocr.recognizeTextsPos;
  const textsPos = posMode ? await ocr.recognizeTextsPos!(strips) : null;
  const texts = posMode ? null : await ocr.recognizeTexts(strips);

  // 每块识别字汇总到 (row,verse)，再按 x 单调最近分配给音符。
  // 单元 = 一个汉字 + 紧随其后的尾随标点（，。、；！？等）：简谱标点向左贴前一字、不占音符，
  // 故并入该音节字符串而非另立单元（保持单元↔音符对齐）。段号数字等非汉字非标点 → 直接丢弃、自然不占位。
  const perLine = new Map<string, Array<{ x: number; ch: string }>>();
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
          placed.push({ x: sx, ch });
          regions.push({ text: ch, bbox: { x: sx - charW / 2, y: cy0, w: charW, h: cy1 - cy0 } });
        } else if (LYRIC_PUNCT.test(ch) && placed.length) {
          placed[placed.length - 1].ch += ch;                       // 尾随标点贴前一字（不移位、不另立单元）
          if (regions.length) regions[regions.length - 1].text += ch;
        }
      }
    } else {
      // 回退：后端无字位时，沿用"字↔连通块格"按序映射 + 段号几何剔除（首格落在第一个音符中心左侧 → 段号丢弃）。
      const toks: string[] = [];
      for (const ch of texts![s]) {
        if (isHanzi(ch)) toks.push(ch);
        else if (LYRIC_PUNCT.test(ch) && toks.length) toks[toks.length - 1] += ch;
      }
      if (!toks.length) continue;
      let mapCells = cells;
      const notes0 = staff[rowIdx].nums;
      if (isFirstChunk && cells.length > 1 && notes0.length &&
          rright(cells[0]) < rcx(notes0[0].bbox)) mapCells = cells.slice(1);
      for (let j = 0; j < toks.length; j++) {
        const ci = toks.length === mapCells.length ? j : Math.min(mapCells.length - 1, Math.floor(j * mapCells.length / toks.length));
        placed.push({ x: rcx(mapCells[ci]), ch: toks[j] });
        regions.push({ text: toks[j], bbox: mapCells[ci] });
      }
    }
  }

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
  }
  return regions;
}
