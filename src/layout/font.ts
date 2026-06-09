// Replaces org.jetbrains.skija.Font/Typeface. A Font is just a CSS family +
// pixel size (+ bold); measurement goes through the SVG/canvas helpers so it
// agrees with rendering.

import { Rect } from "../common/geom";
import { measureGlyphText, measureFontMetrics } from "../common/measure";

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

  /** tight glyph bbox (Skija font.getPath(gid).bounds). */
  charBound(ch: string): Rect {
    return measureGlyphText(ch, this.family, this.size, this.weight).bbox;
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
