// 力度记号：把**认出来的那个字母**连同它旁边的字母拼成一个记号（`mf` / `ff` / `mp`…）。
//
// 位图路的力度检出其实早就有了——字典里 `dynamicForte` 26 个类实例、`dynamicMP` 8 个，
// 实测宁静 p2 那个 `f` 到 Maestro 模板只有 19。缺的是两件事：
//   1. 从来没调过 `findNotations` / `attachDynamics`（在 `recognize.ts` 里补上了）；
//   2. **`mf` 印出来是两个字母**（`m` 一个块、`f` 一个块），只认 `f` 就把 `mf` 读成 `f`。
//
// 第 2 件在这里做。`m` 那个块本身是认不出的：它落在字典的 `dynamicForte` 类里
// （实测距离 71~98，而真 `f` 只有 19），或者干脆被当成实心符头
// （1.87×1.17 格，正在符头的尺寸档里——实测破碎 p3/p6 都是这样）。
// 所以不靠字典认它，**靠版式**：力度是一串**贴在一起、坐同一条基线**的字母，
// 其中至少有一个是字典认得出的；旁边那些按**宽高**分是哪个字母。
import type { Sym } from "../staffomr/model";
import type { ContourMap } from "./contour";
import type { RasterUnit } from "./staffline";

export interface RasterDynamic {
  /** 记号的左端 x 与纵向中心（`attachDynamicTexts` 按它找最近的音符）。 */
  px: number;
  py: number;
  /** 拼出来的力度文本（`f` / `mf` / `ff` / `mp`…）。 */
  text: string;
}

/**
 * 字母之间的间隙。力度字母是**斜体、连着写**的：实测 `mf` 的两个块在 x 上还**重叠**
 * （`m` 的右缘越过 `f` 的左缘 9 px）。而歌词里紧挨着的汉字有半格以上的字距
 * ——实测宁静 p2 那个 `f` 右边 0.5 格处就是「在」字，照 0.7 格的间隙会把它拼成 `ff`。
 * 所以间隙的上限卡在**贴着**（0.15 格），下限允许重叠 0.8 格。
 */
const GAP_MAX = 0.15;
const GAP_MIN = -0.8;
/** 两个字母的**纵向中心**差上限（斜体 `f` 上下都出头，底边对不齐，中心才齐）。 */
const CY_TOL = 0.4;
/** 相对锚字母的高度比：`m`/`p` 只有一截 x 高，另一个 `f` 与锚同高。 */
const SHORT_RATIO: [number, number] = [0.33, 0.62];
const TALL_RATIO: [number, number] = [0.85, 1.15];

/** 按宽高判这个块是哪个力度字母（`hr` = 相对锚字母的高度比）。判不出返回 null。 */
function letterOf(w: number, h: number, hr: number): string | null {
  if (hr >= TALL_RATIO[0] && hr <= TALL_RATIO[1] && w >= 1.4 && w <= 2.8) return "f"; // 与锚同高：又一个 f
  if (hr >= SHORT_RATIO[0] && hr <= SHORT_RATIO[1] && w >= 1.4 && w <= 2.4) return "m"; // 扁而宽：m
  if (hr > SHORT_RATIO[1] && hr < TALL_RATIO[0] && w >= 0.9 && w <= 1.8) return "p"; // x 高加一条下伸：p
  void h;
  return null;
}

/**
 * 把字典认出来的力度块与紧挨着的字母块拼成记号。
 *
 * **只从字典认出来的块往外长**，不凭空认一串字母：`m`/`p` 那种形状在谱面上遍地都是
 * （符头、歌词偏旁），单独判必然过检。一串里有一个字典认得出的字母当锚，才算数。
 */
export function groupDynamics(anchors: Sym[], map: ContourMap, unit: RasterUnit): RasterDynamic[] {
  const sp = unit.space;
  const out: RasterDynamic[] = [];
  const used = new Set<Sym>();
  const sorted = [...anchors].sort((a, b) => a.box.left - b.box.left);
  for (const a of sorted) {
    if (used.has(a)) continue;
    const aw = (a.box.right - a.box.left) / sp;
    const ah = (a.box.bottom - a.box.top) / sp;
    const acy = (a.box.top + a.box.bottom) / 2;
    // `dynamicMP` 是**一个字形就是「mp」**，不必再拼
    if (a.code === "dynamicMP") {
      out.push({ px: a.box.left, py: acy, text: "mp" });
      continue;
    }
    // 锚自己是哪个字母：字典把 `m` 也归进 `dynamicForte` 类（实测距离 71~98，
    // 而真 `f` 只有 19），所以不认字典给的名，按宽高自己判。
    const own = ah >= 2.0 ? "f" : ah <= 1.5 && aw >= 1.4 ? "m" : "p";
    let left = a.box.left;
    let right = a.box.right;
    const parts: { x: number; ch: string }[] = [{ x: a.box.left, ch: own }];
    const refH = own === "f" ? ah : ah / 0.45; // 锚是 m 时，按 x 高反推那一串的字号
    for (let again = true; again; ) {
      again = false;
      for (const c of map.contours) {
        const b = c.bbox;
        if (parts.some((p) => Math.abs(p.x - b.x) < 1)) continue;
        if (Math.abs(b.y + b.h / 2 - acy) > sp * CY_TOL) continue;
        const gapL = (left - (b.x + b.w)) / sp;
        const gapR = (b.x - right) / sp;
        const near = (gapL >= GAP_MIN && gapL <= GAP_MAX) || (gapR >= GAP_MIN && gapR <= GAP_MAX);
        if (!near) continue;
        const ch = letterOf(c.w, c.h, c.h / refH);
        if (!ch) continue;
        parts.push({ x: b.x, ch });
        left = Math.min(left, b.x);
        right = Math.max(right, b.x + b.w);
        again = true;
      }
    }
    // 串里的其它锚要一并标记掉（`ff` 的两个 `f` 都是锚，`mf` 的 `m` 也常是）
    for (const b of sorted) if (b !== a && b.box.left >= left - 1 && b.box.right <= right + 1) used.add(b);
    const text = parts.sort((p, q) => p.x - q.x).map((p) => p.ch).join("");
    if (!VALID.has(text)) continue; // 拼不出一个像样的力度就整个丢掉（宁可少，不可编）
    out.push({ px: left, py: acy, text });
  }
  return out;
}

/** 认得下的力度文本。拼出别的（`fm`、`mm`…）说明拼错了，整个丢掉。 */
const VALID = new Set(["p", "pp", "ppp", "mp", "mf", "f", "ff", "fff", "sf", "sfz", "fp"]);
