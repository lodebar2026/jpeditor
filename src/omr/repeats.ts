// 反复小节线（||: / :||）与一、二房（volta ending）识别。
// 反复号靠「上下点对 + 邻近竖线」判方向；ending 靠横贯谱行上方的超扁顶括线判范围，
// 左端小号数字交给现有数字 OCR。识别结果锚定到边界相邻音符，由 musicxml.ts 输出结构元素。
import type { Binary, Component, Rect, StaffRow } from "./types";
import { rcx, rcy, rright } from "./types";
import type { OcrBackend } from "./ocr";

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

function detectRepeatBarlines(dots: Component[], rows: StaffRow[], numH: number): void {
  for (const row of rows) {
    if (!row.nums.length || !row.barlineXs.length) continue;
    const midY = median(row.nums.map((n) => rcy(n.bbox)));
    const rowDots = dots.filter((d) => Math.abs(rcy(d.bbox) - midY) <= numH * 1.1);
    const used = new Set<Component>();
    for (let i = 0; i < rowDots.length; i++) {
      const a = rowDots[i];
      if (used.has(a)) continue;
      let mate: Component | undefined;
      for (let j = i + 1; j < rowDots.length; j++) {
        const b = rowDots[j];
        if (used.has(b)) continue;
        const dy = Math.abs(rcy(a.bbox) - rcy(b.bbox));
        const pairX = (rcx(a.bbox) + rcx(b.bbox)) / 2;
        const overlapsNote = row.nums.some((n) => Math.abs(rcx(n.bbox) - pairX) < numH * 0.4);
        if (!overlapsNote && Math.abs(rcx(a.bbox) - rcx(b.bbox)) <= numH * 0.35 &&
            dy >= numH * 0.35 && dy <= numH * 1.4) {
          mate = b;
          break;
        }
      }
      if (!mate) continue;
      const colonX = (rcx(a.bbox) + rcx(mate.bbox)) / 2;
      const barX = row.barlineXs.reduce((best, x) =>
        Math.abs(x - colonX) < Math.abs(best - colonX) ? x : best, row.barlineXs[0]);
      if (Math.abs(barX - colonX) > numH * 1.2) continue;
      used.add(a);
      used.add(mate);
      if (colonX < barX) {
        // :|| —— 冒号在竖线左侧，结束反复；锚到左侧最后一个音符。
        const prev = [...row.nums].reverse().find((n) => rcx(n.bbox) < barX);
        if (prev) prev.repeatBackward = true;
      } else {
        // ||: —— 冒号在竖线右侧，开始反复；锚到右侧第一个音符。
        const next = row.nums.find((n) => rcx(n.bbox) > barX);
        if (next) next.repeatForward = true;
      }
    }
  }
}

interface EndingCandidate {
  bracket: Component;
  row: StaffRow;
  label?: Rect;
}

function endingCandidates(bin: Binary, comps: Component[], rows: StaffRow[], numH: number): EndingCandidate[] {
  const out: EndingCandidate[] = [];
  for (const row of rows) {
    if (!row.nums.length) continue;
    const rowTop = median(row.nums.map((n) => n.bbox.y));
    const nx0 = row.nums[0].bbox.x, nx1 = rright(row.nums[row.nums.length - 1].bbox);
    const runs: Rect[] = [];
    const y0 = Math.max(0, Math.floor(rowTop - numH * 1.8));
    const y1 = Math.min(bin.h - 1, Math.ceil(rowTop - numH * 0.3));
    // 直接扫水平墨线：即使括线与左侧复纵线粘成一个高连通块，顶横线仍是一段连续 run。
    for (let y = y0; y <= y1; y++) {
      let start = -1, lastInk = -1;
      for (let x = 0; x <= bin.w; x++) {
        const ink = x < bin.w && !!bin.data[y * bin.w + x];
        if (ink) { if (start < 0) start = x; lastInk = x; }
        if (start >= 0 && ((!ink && x - lastInk > 1) || x === bin.w)) {
          const w = lastInk - start + 1;
          const overlap = Math.max(0, Math.min(lastInk + 1, nx1) - Math.max(start, nx0));
          if (w >= numH * 6 && overlap >= Math.min(w, nx1 - nx0) * 0.5) runs.push({ x: start, y, w, h: 1 });
          start = -1; lastInk = -1;
        }
      }
    }
    // 同一条横线有 1~3px 厚，会在相邻 y 重复出现；保留每个 x 区间最长的一条。
    runs.sort((a, b) => b.w - a.w);
    const unique: Rect[] = [];
    for (const r of runs) {
      const duplicate = unique.some((u) => {
        const ov = Math.max(0, Math.min(rright(r), rright(u)) - Math.max(r.x, u.x));
        return ov >= Math.min(r.w, u.w) * 0.8 && Math.abs(r.y - u.y) <= 3;
      });
      if (!duplicate) unique.push(r);
    }
    for (const b of unique) {
      // 房号印在括线左端内侧，通常是独立小连通块；选该窗口里最高/最大的块。
      const labelComps = comps.filter((c) =>
        rcx(c.bbox) >= b.x - numH * 0.1 && rcx(c.bbox) <= b.x + numH * 1.5 &&
        rcy(c.bbox) >= b.y - numH * 0.2 && rcy(c.bbox) <= b.y + numH * 0.9 &&
        c.bbox.h >= numH * 0.18 && c.bbox.h <= numH * 0.9 && c.bbox.w <= numH * 0.9);
      labelComps.sort((a, z) => z.bbox.h - a.bbox.h || z.area - a.area);
      const bracket: Component = { id: -1, bbox: b, area: b.w, cx: rcx(b), cy: rcy(b) };
      out.push({ bracket, row, label: labelComps[0]?.bbox });
    }
  }
  return out.sort((a, b) => a.bracket.bbox.y - b.bracket.bbox.y || a.bracket.bbox.x - b.bracket.bbox.x);
}

export async function detectRepeatsAndEndings(
  bin: Binary,
  comps: Component[],
  dots: Component[],
  rows: StaffRow[],
  numH: number,
  ocr: OcrBackend,
): Promise<void> {
  detectRepeatBarlines(dots, rows, numH);
  const endings = endingCandidates(bin, comps, rows, numH);
  if (!endings.length) return;
  const labels = endings.filter((e) => e.label);
  const rec = labels.length ? await ocr.recognizeDigits(bin, labels.map((e) => e.label!)) : [];
  const recognized = new Map<EndingCandidate, number>();
  labels.forEach((e, i) => {
    if (rec[i] >= 1 && rec[i] <= 9) recognized.set(e, rec[i]);
  });
  endings.forEach((e, i) => {
    // 小号房号过淡时 OCR 可能为空；常规谱按 1/2 成对出现，按阅读序作安全回退。
    const number = recognized.get(e) ?? (i % 2) + 1;
    const b = e.bracket.bbox;
    const covered = e.row.nums.filter((n) =>
      rcx(n.bbox) >= b.x - numH * 0.5 && rcx(n.bbox) <= rright(b) + numH * 0.5);
    if (!covered.length) return;
    covered[0].endingStart = number;
    covered[covered.length - 1].endingStop = number;
  });
}
