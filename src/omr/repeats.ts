// 反复小节线（||: / :||）与一、二房（volta ending）识别。
// 反复号靠「上下点对 + 邻近竖线」判方向；ending 靠横贯谱行上方的超扁顶括线判范围，
// 左端小号数字交给现有数字 OCR。识别结果锚定到边界相邻音符，由 musicxml.ts 输出结构元素。
import type { Binary, Component, Rect, StaffRow } from "./types";
import { rcx, rcy, rright } from "./types";
import type { OcrBackend } from "./ocr";
import { median } from "./geom";

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
  /** 房号数字块，左→右（`1. 2. 3. 5.` 这样的多房共用号会有多块）。 */
  labels: Rect[];
}

/** 括线左端是否有下垂短竖（房括号的立脚）。房括号 ⌐ 必有它；歌词/连音线等长横墨线没有，
 *  故它是把搜索窗口放深后仍能挡住误检的形态特征。 */
function hasLeftHook(bin: Binary, b: Rect, numH: number): boolean {
  const need = Math.max(2, Math.round(numH * 0.35));
  for (let x = b.x; x <= Math.min(bin.w - 1, b.x + Math.max(1, Math.round(numH * 0.25))); x++) {
    let run = 0;
    for (let y = b.y; y < Math.min(bin.h, b.y + numH * 1.6); y++) {
      if (bin.data[y * bin.w + x]) { if (++run >= need) return true; } else run = 0;
    }
  }
  return false;
}

function endingCandidates(bin: Binary, comps: Component[], rows: StaffRow[], numH: number): EndingCandidate[] {
  const out: EndingCandidate[] = [];
  for (const row of rows) {
    if (!row.nums.length) continue;
    const rowTop = median(row.nums.map((n) => n.bbox.y));
    const nx0 = row.nums[0].bbox.x, nx1 = rright(row.nums[row.nums.length - 1].bbox);
    const runs: Rect[] = [];
    // 括线到数字顶的距离随谱面松紧变化很大：行内有圆滑线时括线被顶到 ~2.8 字号高处
    // （沧海一声笑的 1./4./6. 三房实测 y 差 29px、numH 11）。窗口停在 1.8 字号会整片漏掉，
    // 故放深到 3.4 字号，误检交给 hasLeftHook 的立脚形态挡。
    const y0 = Math.max(0, Math.floor(rowTop - numH * 3.4));
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
      if (!hasLeftHook(bin, b, numH)) continue;
      // 房号印在括线左端内侧，是一串独立小连通块。一个房括号可辖多遍（`1. 2. 3. 5.`），
      // 故不再只取最高的一块，而是从左端起把**连续**的同高小块全收下，右侧留够 5 字号。
      const near = comps.filter((c) =>
        rcx(c.bbox) >= b.x - numH * 0.1 && rcx(c.bbox) <= b.x + numH * 5 &&
        rcy(c.bbox) >= b.y - numH * 0.2 && rcy(c.bbox) <= b.y + numH * 0.9 &&
        c.bbox.h >= numH * 0.18 && c.bbox.h <= numH * 0.9 && c.bbox.w <= numH * 0.9)
        .sort((a, z) => a.bbox.x - z.bbox.x);
      // 号与号之间的小圆点（`1.` 的点）高度只有数字的三成，按最高块的 0.55 倍剔掉，
      // 免得当成一位房号送去 OCR。
      const hMax = Math.max(0, ...near.map((c) => c.bbox.h));
      const labels: Rect[] = [];
      for (const c of near) {
        if (c.bbox.h < hMax * 0.55) continue;
        // 断在第一个大空档：单房号谱的窗口右侧若有别的墨（八度点、弧脚）不会被卷进来。
        if (labels.length && c.bbox.x - rright(labels[labels.length - 1]) > numH * 1.2) break;
        labels.push(c.bbox);
      }
      const bracket: Component = { id: -1, bbox: b, area: b.w, cx: rcx(b), cy: rcy(b) };
      out.push({ bracket, row, labels });
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
  // 所有房号数字块摊平成一批送 OCR（每个候选的块数不定），再按 offset 收回。
  const flat: Rect[] = [];
  const span = endings.map((e) => { const at = flat.length; flat.push(...e.labels); return { at, n: e.labels.length }; });
  const rec = flat.length ? await ocr.recognizeDigits(bin, flat) : [];
  const recognized = new Map<EndingCandidate, number[]>();
  endings.forEach((e, i) => {
    const nums: number[] = [];
    for (let k = 0; k < span[i].n; k++) {
      const d = rec[span[i].at + k];
      if (d >= 1 && d <= 9 && !nums.includes(d)) nums.push(d);
    }
    if (nums.length) recognized.set(e, nums);
  });
  endings.forEach((e, i) => {
    // 小号房号过淡时 OCR 可能为空；常规谱按 1/2 成对出现，按阅读序作安全回退。
    const nums = recognized.get(e) ?? [(i % 2) + 1];
    const number = nums.join(",");
    const b = e.bracket.bbox;
    const covered = e.row.nums.filter((n) =>
      rcx(n.bbox) >= b.x - numH * 0.5 && rcx(n.bbox) <= rright(b) + numH * 0.5);
    if (!covered.length) return;
    covered[0].endingStart = number;
    covered[covered.length - 1].endingStop = number;
  });
}
