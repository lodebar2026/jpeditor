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

/** 把 bin 的一块矩形区域裁成白底黑字画布（带 2px 留白）。 */
function cropCanvas(bin: Binary, r: Rect): OffscreenCanvas {
  const pad = 2;
  const W = r.w + pad * 2, H = r.h + pad * 2;
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  const img = new ImageData(W, H);
  for (let i = 0; i < img.data.length; i += 4) { img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = 255; }
  for (let yy = 0; yy < r.h; yy++) {
    for (let xx = 0; xx < r.w; xx++) {
      const sx = r.x + xx, sy = r.y + yy;
      if (sx < 0 || sy < 0 || sx >= bin.w || sy >= bin.h) continue;
      if (bin.data[sy * bin.w + sx]) {
        const p = ((yy + pad) * W + (xx + pad)) * 4;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = 0;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

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

interface LyricCell { rect: Rect; verse: number; }

/** 识别歌词并写回各音符的 lyrics[]。staff 为乐谱行(按出现顺序)，comps 为全图连通块。 */
export async function recognizeLyrics(
  bin: Binary, comps: Component[], staff: StaffRow[], numH: number, ocr: OcrBackend,
): Promise<void> {
  if (!ocr.recognizeTexts || !staff.length) return;

  const charMin = numH * 0.5; // 歌词字号下限（约等于音符字号）
  const cells: LyricCell[] = [];
  const canvases: OffscreenCanvas[] = [];

  for (let i = 0; i < staff.length; i++) {
    const row = staff[i];
    const yTop = row.bottomY + Math.round(numH * 0.15);
    const yBot = i + 1 < staff.length ? staff[i + 1].topY - Math.round(numH * 0.15) : bin.h;
    if (yBot - yTop < charMin) continue;

    // 取带内字号大小的连通块
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
      for (const cellRect of mergeToChars(ln, charH)) {
        cells.push({ rect: cellRect, verse });
        canvases.push(cropCanvas(bin, cellRect));
      }
    });
  }

  if (!canvases.length) return;
  const texts = await ocr.recognizeTexts(canvases);

  // 按乐谱行分组对齐：每个 cell 属于某行(由 y 决定)。重新定位 cell 到行。
  for (let i = 0; i < staff.length; i++) {
    const row = staff[i];
    const yTop = row.bottomY;
    const yBot = i + 1 < staff.length ? staff[i + 1].topY : bin.h;
    // 该行的 cells（按 verse 再按 x）
    const byVerse = new Map<number, Array<{ x: number; ch: string }>>();
    for (let k = 0; k < cells.length; k++) {
      const cy = cells[k].rect.y + cells[k].rect.h / 2;
      if (cy < yTop || cy >= yBot) continue;
      const ch = (texts[k].match(/[一-鿿]/) || [])[0];
      if (!ch || !isHanzi(ch)) continue;
      const v = cells[k].verse;
      if (!byVerse.has(v)) byVerse.set(v, []);
      byVerse.get(v)!.push({ x: rcx(cells[k].rect), ch });
    }
    const notes = row.nums;
    if (!notes.length) continue;
    for (const [verse, chars] of byVerse) {
      chars.sort((a, b) => a.x - b.x);
      // 单调最近分配：字按 x 顺序，音符指针只前进
      let ni = 0;
      for (const { x, ch } of chars) {
        // 推进到 x 最接近的音符（不回退）
        while (ni + 1 < notes.length && Math.abs(rcx(notes[ni + 1].bbox) - x) <= Math.abs(rcx(notes[ni].bbox) - x)) ni++;
        const nt = notes[ni];
        if (!nt.lyrics) nt.lyrics = [];
        nt.lyrics[verse] = (nt.lyrics[verse] || "") + ch;
        if (ni < notes.length - 1) ni++; // 一字一符：用掉即前进
      }
    }
  }
}
