// 反复跳转的**目标**记号 𝄋（segno）识别。
//
// 它不是文字，OCR 那路（lyrics.ts 的 D.C./D.S./Fine）够不着：谱面上就是一个 S 形斜杠加两个点，
// 印在谱行上方带里。判据只认这一形：
//   · 主体是一块 S + 斜笔的连通块，约一个字号高、窄于高（76《天上有粮》实测 30×47、字号 44）；
//   · 墨占 bbox 不到六成——S 是空心的，这条把同带里的和弦字母、段落方框字挡在外面；
//   · **斜笔两侧各扣一个小圆点**，这是决定性的一条：上方带里别的东西（和弦、段落词、房号、
//     倚音）都凑不出「一块空心斜体 + 两颗孤立圆点」。
// 命中后锚到正下方最近的音符，由 todoc/topu 提升为该小节**左**线上的记号（segno 是跳转目标，
// D.S. 跳回来落在这条线上，故挂左不挂右）。
import type { Component, StaffRow } from "./types";
import { rcx, rcy, rright, rbottom } from "./types";
import { probe } from "./probe";

/** 主体块是不是 segno 的 S 形：一个字号上下、窄于高、空心。 */
function segnoBody(k: Component, numH: number): boolean {
  const b = k.bbox;
  if (b.h < numH * 0.85 || b.h > numH * 1.6) return false;
  if (b.w < numH * 0.45 || b.w > numH * 1.1) return false;
  const aspect = b.w / b.h;
  if (aspect < 0.45 || aspect > 1.0) return false;
  const fill = k.area / (b.w * b.h);
  return fill >= 0.28 && fill <= 0.62;
}

/** 斜笔两侧的两颗点：都落在主体 bbox 略微放大的范围内，且分处主体中心的**对角两侧**。
 *  点从**全图连通块**里找，不走 dots 通道——那两颗点不在音符上下，归类时压根没进点通道
 *  （76《天上有粮》实测两颗 7×7、8×7 的小块只在 comps 里）。 */
function hasTwoDots(body: Component, comps: Component[], numH: number): boolean {
  const b = body.bbox;
  const pad = numH * 0.2;
  const near = comps.filter((d) => {
    if (d === body) return false;
    const s = Math.max(d.bbox.w, d.bbox.h);
    if (s < numH * 0.08 || s > numH * 0.3) return false;
    return rcx(d.bbox) >= b.x - pad && rcx(d.bbox) <= rright(b) + pad &&
      rcy(d.bbox) >= b.y - pad && rcy(d.bbox) <= rbottom(b) + pad;
  });
  if (near.length < 2) return false;
  const cy = rcy(b);
  // 一颗在中心之上、一颗在中心之下，且横向也分开（斜笔把它们分到两边）。
  const above = near.filter((d) => rcy(d.bbox) < cy);
  const below = near.filter((d) => rcy(d.bbox) > cy);
  if (!above.length || !below.length) return false;
  // 「对角」按**横向**为主：两颗点分居斜笔两侧，横向拉开得明显（76 实测中心差 25px / 字号 44），
  // 纵向只差半颗点（实测 8.5px = 0.19 字号），门槛卡在 0.2 字号就整个漏掉。
  return above.some((a) => below.some((z) =>
    Math.abs(rcx(a.bbox) - rcx(z.bbox)) >= numH * 0.2 &&
    Math.abs(rcy(a.bbox) - rcy(z.bbox)) >= numH * 0.1));
}

/** 找 segno 并锚到下方最近的音符（`JpNum.segno`）。`comps` 是全图连通块。 */
export function detectSegno(comps: Component[], rows: StaffRow[], numH: number): void {
  for (const row of rows) {
    if (!row.nums.length) continue;
    const rowTop = Math.min(...row.nums.map((n) => n.bbox.y));
    // 上方带：音符顶之上 0.2~2.8 字号。再往上就进了上一行的歌词带。
    const y0 = rowTop - numH * 2.8, y1 = rowTop - numH * 0.2;
    for (const k of comps) {
      if (rbottom(k.bbox) > y1 || k.bbox.y < y0) continue;
      if (!segnoBody(k, numH)) continue;
      if (!hasTwoDots(k, comps, numH)) continue;
      // 锚到正下方最近的音符：segno 印在小节起头上方，那一小节的左线就是跳转落点。
      const cx = rcx(k.bbox);
      let best: (typeof row.nums)[number] | undefined;
      for (const n of row.nums) {
        if (rright(n.bbox) < cx - numH * 1.5) continue;
        best = n;
        break;
      }
      if (!best) continue;
      probe("segno");
      best.segno = true;
    }
  }
}
