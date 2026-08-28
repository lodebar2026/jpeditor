// Replaces org.jetbrains.skija.Font/Typeface. A Font is just a CSS family +
// pixel size (+ bold); measurement goes through the SVG/canvas helpers so it
// agrees with rendering.

import { Rect } from "../common/geom";
import { measureGlyphRun, measureGlyphText, measureFontMetrics, punctTrim } from "../common/measure";
import type { CompressMode } from "../common/cjkpunct";

export class Font {
  constructor(
    public family: string,
    public size: number,
    public bold = false,
  ) {}

  get familyName(): string {
    return this.family;
  }
  get weight(): "normal" | "bold" {
    return this.bold ? "bold" : "normal";
  }

  scaled(sc: number): Font {
    return new Font(this.family, this.size * sc, this.bold);
  }
  makeWithSize(sz: number): Font {
    return new Font(this.family, sz, this.bold);
  }
  withBold(): Font {
    return new Font(this.family, this.size, true);
  }

  /** advance width of str (Skija font.measureText().width). */
  measureText(str: string): number {
    if (str.length === 0) return 0;
    return measureGlyphText(str, this.family, this.size, this.weight).width;
  }

  /**
   * 一串字**标点挤压后**的逐字笔位与总宽（CLREQ，见 common/cjkpunct.ts）。
   * 字体带 `chws` 就用字体的账，不带按规则自算——两条路同一个口径。
   * 渲染端把 `xs` 原样给 `<text>` 的 `x`，绝不再叠一层 font-feature-settings（会挤两遍）。
   */
  run(str: string, mode: CompressMode = "clreq"): { xs: number[]; width: number } {
    if (str.length === 0) return { xs: [], width: 0 };
    return measureGlyphRun(str, this.family, this.size, this.weight, mode);
  }

  /** 相邻两个字之间该压掉多少像素（跨 `<text>` 的那一对标点拿它当间距下限）。 */
  punctTrim(prev: string, next: string, mode: CompressMode = "clreq"): number {
    return punctTrim(prev, next, this.family, this.size, this.weight, mode);
  }

  /** tight glyph bbox (Skija font.getPath(gid).bounds). */
  charBound(ch: string): Rect {
    return measureGlyphText(ch, this.family, this.size, this.weight).bbox;
  }

  /**
   * Horizontal centre of a glyph's *ink*, measured from the pen origin.
   * Differs from advance/2 for glyphs whose side bearings are asymmetric —
   * notably "1", which in PingFang SC is 0.88px (3.1% of an em) left of its
   * advance centre at 28px. Decorations that must look centred on a jianpu
   * digit (octave dots, slur/tie ends, tuplet brackets) anchor here rather
   * than on advance/2.
   */
  inkCenter(ch: string): number {
    const b = this.charBound(ch);
    return (b.left + b.right) / 2;
  }

  /** font-global ascent (negative) / descent (positive). */
  get metrics(): { ascent: number; descent: number } {
    return measureFontMetrics(this.family, this.size, this.weight);
  }
}

// Resolve the configured logical font names to families available in the webview.
// (Original used 苹方-简 / Microsoft YaHei / Times New Roman via system fonts.)
export function resolveFamily(name: string): string {
  return name;
}
