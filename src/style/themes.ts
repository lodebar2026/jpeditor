// 内置主题：级联的最底层。**切主题 = 换一整层**。
//
// | 主题        | 谁在用                                  |
// |-------------|-----------------------------------------|
// | projection  | 编辑器「展开」档（两种格式）与导出 PPTX |
// | print       | 编辑器「原样」档（`.jpwabc` 与文本谱）  |
// | book        | 成书重排（scripts/rebuild.mjs）         |
// | staff       | 五线谱 / 混排                           |
//
// 编辑器里主题由排版模式决定（展开 → projection、原样 → print），切模式按钮就是整层切换。
// 数值一律写成它们原来的样子（裸数字 = pt）：改写成比例会有浮点尾差，破几何基线。
//
// 无 DOM 依赖。
import type { StyleLayer } from "./cascade";

/** 老版展开档的「出厂默认」（投影片 960×540，字号 28/48/36）。 */
export const PPTX_PAGE = { w: 960, h: 540, fontSize: 28, titleSize: 48, creditSize: 36 } as const;

/** 「展开」档只有这两种投影片比例（1 排版单位 = 1pt，导出 PPTX 要的就是这个）。
 *  **不给实际纸张**：展开是投影用的，一屏一段（用户口径：「不需要纸张设置，只要 2 种比例」）。 */
export const PAGE_RATIOS: Record<string, [number, number]> = {
  "16:9": [960, 540],
  "4:3": [720, 540],
};

/** 原样档能选的纸：**实际纸张尺寸**（pt，1pt = 1/72 in），外加一档「长图」。
 *  长图不是纸——它是一张连续长纸，宽度取 `LONG_IMAGE_WIDTH`、高度由内容说了算。
 *  **这里没有 16:9 / 4:3**：那是投影片的比例，只归展开档。 */
export const PAPER_SIZES: Record<string, [number, number] | null> = {
  A4: [595, 842],
  A5: [420, 595],
  B5: [499, 709],
  Letter: [612, 792],
  长图: null,
};

/** 「原样」档能选的纸（含长图）。 */
export const ORIGINAL_PAPERS = ["A4", "A5", "B5", "Letter", "长图"] as const;

/** 「长图」那一档的纸宽。取文本谱「原版」量到的那一份（`pu/metrics.ts::PRINT.pageWidth`）
 *  ——两者本就是同一种观感，长图也就该同宽。 */
export const LONG_IMAGE_WIDTH = 1000;

/** 出厂纸。原样档与文本谱「原版」档一贯的观感都是长图。 */
export const PAPER_DEFAULT = "长图";

/** 这个纸张名在不在表里。 */
export const isPaper = (k: unknown): k is string =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(PAPER_SIZES, k);

const INK = 0xff000000;
const PAPER_WHITE = 0xffffffff;

export type ThemeId = "projection" | "print" | "book" | "staff";

export const THEMES: Record<ThemeId, StyleLayer> = {
  projection: [
    {
      set: {
        roles: { note: { size: PPTX_PAGE.fontSize }, title: { size: PPTX_PAGE.titleSize }, credit: { size: PPTX_PAGE.creditSize } },
        page: { w: PPTX_PAGE.w, h: PPTX_PAGE.h, ink: INK, background: PAPER_WHITE },
        jianpu: { preset: "pptx" },
      },
    },
  ],
  print: [
    { set: { page: { paper: PAPER_DEFAULT, ink: INK, background: PAPER_WHITE }, jianpu: { preset: "original" } } },
    // 文本谱不给字号：那一路的尺寸是实测来的一整套，缺省 = 跟随版式量到的原尺寸
    { when: { engine: "jianpu" }, set: { roles: { note: { size: PPTX_PAGE.fontSize } } } },
  ],
  // 成书的其余一切在 `book` 块（bookstyle.json），由调用方作为第二层叠上
  book: [{ set: { jianpu: { preset: "book" } } }],
  staff: [{ set: { staff: { preset: "musicpp" } } }],
};

/** 编辑器排版模式 → 主题。 */
export function themeOfMode(mode: "expanded" | "original"): "projection" | "print" {
  return mode === "expanded" ? "projection" : "print";
}
