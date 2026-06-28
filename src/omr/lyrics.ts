// 简谱歌词识别 + 逐音节↔音符对齐。
// musicpp 的 jianpu.cpp::processLrc 只找出歌词行范围，真正"字↔符头"对齐(text.cpp::mergeLyricByNotes)
// 在另一套 PDF 模型里、按 x 重叠完成。这里照其原则用 x 对齐：
//   1. 在每个乐谱行下方的"歌词带"里取字号大小的连通块；按 y 分成若干 verse 行(W1/W2…)。
//   2. 行内把连通块(汉字常由多个偏旁连通块组成)按 x 邻近并成"字格"。
//   3. 每个字格裁成画布 → PaddleOCR 识别汉字。
//   4. 按 x 单调最近，把每个汉字分配给本乐谱行里 x 最接近的音符(melisma→某些音符无字，正确)。
import type { Binary, Component, Rect, StaffRow } from "./types";
import { rright, rbottom, rcx } from "./types";
import type { OcrBackend } from "./ocr";

const median = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
const isHanzi = (c: string) => /[一-鿿]/.test(c);

/** 把一行(同 y)的连通块按 x 邻近并成字格。返回每个字格的合并包围盒，按 x 排序。 */
function mergeToChars(line: Component[], charH: number): Rect[] {
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
function srcCanvasOf(bin: Binary): OffscreenCanvas {
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
function buildStrip(src: OffscreenCanvas, cells: Rect[], H = STRIP_H): OffscreenCanvas {
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
function chunkCells(cells: Rect[]): Rect[][] {
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

/** 识别歌词并写回各音符的 lyrics[]。staff 为乐谱行(按出现顺序)，comps 为全图连通块。 */
export async function recognizeLyrics(
  bin: Binary, comps: Component[], staff: StaffRow[], numH: number, ocr: OcrBackend,
): Promise<void> {
  if (!ocr.recognizeTexts || !staff.length) return;

  const charMin = numH * 0.5; // 歌词字号下限（约等于音符字号）
  const src = srcCanvasOf(bin);
  const chunks: Chunk[] = [];
  const strips: OffscreenCanvas[] = [];

  for (let i = 0; i < staff.length; i++) {
    const row = staff[i];
    const yTop = row.bottomY + Math.round(numH * 0.15);
    const yBot = i + 1 < staff.length ? staff[i + 1].topY - Math.round(numH * 0.15) : bin.h;
    if (yBot - yTop < charMin) continue;

    const band = comps.filter((c) => {
      const b = c.bbox; const cy = b.y + b.h / 2;
      return cy >= yTop && cy <= yBot && b.h >= charMin && b.w >= charMin * 0.4;
    });
    if (!band.length) continue;

    // 按 y 分 verse 行
    const charH = median(band.map((c) => c.bbox.h)) || numH;
    const sortedY = [...band].sort((a, b) => a.cy - b.cy);
    const lines: Component[][] = [];
    for (const c of sortedY) {
      const ln = lines.find((L) => Math.abs(median(L.map((k) => k.cy)) - c.cy) < charH * 0.7);
      if (ln) ln.push(c); else lines.push([c]);
    }

    lines.forEach((ln, verse) => {
      const cells = mergeToChars(ln, charH);
      for (const chunkCellsArr of chunkCells(cells)) {
        chunks.push({ rowIdx: i, verse, cells: chunkCellsArr });
        strips.push(buildStrip(src, chunkCellsArr));
      }
    });
  }

  if (!strips.length) return;
  const texts = await ocr.recognizeTexts(strips);

  // 每块的识别字按字格索引取 x，汇总到 (row,verse)，再单调最近分配给音符。
  const perLine = new Map<string, Array<{ x: number; ch: string }>>();
  for (let s = 0; s < chunks.length; s++) {
    const { rowIdx, verse, cells } = chunks[s];
    const chars = (texts[s].match(/[一-鿿]/g) || []).filter(isHanzi);
    if (!chars.length) continue;
    const key = `${rowIdx}:${verse}`;
    if (!perLine.has(key)) perLine.set(key, []);
    const placed = perLine.get(key)!;
    for (let j = 0; j < chars.length; j++) {
      const ci = chars.length === cells.length ? j : Math.min(cells.length - 1, Math.floor(j * cells.length / chars.length));
      placed.push({ x: rcx(cells[ci]), ch: chars[j] });
    }
  }

  for (const [key, placed] of perLine) {
    const [rowIdx, verse] = key.split(":").map(Number);
    const notes = staff[rowIdx].nums;
    if (!notes.length) continue;
    placed.sort((a, b) => a.x - b.x);
    let ni = 0;
    for (const { x, ch } of placed) {
      while (ni + 1 < notes.length && Math.abs(rcx(notes[ni + 1].bbox) - x) <= Math.abs(rcx(notes[ni].bbox) - x)) ni++;
      const nt = notes[ni];
      if (!nt.lyrics) nt.lyrics = [];
      nt.lyrics[verse] = (nt.lyrics[verse] || "") + ch;
      if (ni < notes.length - 1) ni++;
    }
  }
}
