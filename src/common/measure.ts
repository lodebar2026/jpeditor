// SVG-based text/path measurement — replaces Skija's
//   font.measureText / font.metrics / Path.computeTightBounds / font.getPath bounds.
// "Measure where you draw": getBBox/getComputedTextLength use the same browser
// engine that renders the live score SVG, so measurement and rendering agree.

import { Rect } from "./geom";
import { compressRun, pairTrimPx, type CompressMode, type Slack } from "./cjkpunct";

const SVG_NS = "http://www.w3.org/2000/svg";

let measureSvg: SVGSVGElement | null = null;
let measureText: SVGTextElement | null = null;
let measurePath: SVGPathElement | null = null;

function ensureMeasureSvg(): SVGSVGElement {
  if (measureSvg && measureSvg.isConnected) return measureSvg;
  measureSvg =
    (document.getElementById("measure-svg") as SVGSVGElement | null) ?? null;
  if (!measureSvg) {
    measureSvg = document.createElementNS(SVG_NS, "svg");
    measureSvg.id = "measure-svg";
    measureSvg.setAttribute("width", "0");
    measureSvg.setAttribute("height", "0");
    measureSvg.style.position = "absolute";
    measureSvg.style.left = "-9999px";
    measureSvg.style.top = "-9999px";
    document.body.appendChild(measureSvg);
  }
  measureText = null;
  measurePath = null;
  return measureSvg;
}

export interface TextMetrics {
  width: number;
  /** tight bounding box of the rendered text, baseline at y=0 */
  bbox: Rect;
}

// Cache measurements keyed by (text, family, size, weight). Layout measures the
// same glyphs/sizes thousands of times; caching avoids repeated reflows.
const textCache = new Map<string, TextMetrics>();

// Canvas context used for tight glyph bounds via actualBoundingBox*.
// SVG getBBox() returns the full line box for CJK fonts, not the tight glyph
// outline. Canvas actualBoundingBoxAscent/Descent matches Skija getPath bounds.
let glyphCtx: CanvasRenderingContext2D | null = null;

/** Build a Canvas/FontFaceSet font shorthand without turning an entire CSS
 * fallback list into one (non-existent) quoted family name. */
function cssFontShorthand(fontFamily: string, fontSizePx: number, fontWeight: "normal" | "bold"): string {
  const family = fontFamily.split(",").map((part) => {
    const name = part.trim().replace(/^(['"])(.*)\1$/, "$2");
    return /^(?:sans-serif|serif|monospace|system-ui)$/i.test(name)
      ? name
      : `"${name.replace(/(["\\])/g, "\\$1")}"`;
  }).join(", ");
  return `${fontWeight} ${fontSizePx}px ${family}`;
}

export function measureGlyphText(
  text: string,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: "normal" | "bold" = "normal",
  features?: FeatureList,
): TextMetrics {
  const sep = "\x01";
  const feat = featureSettings(features);
  // **features 必须进 key**：同一串字开不开 `chws` 宽度不同，共用一个 key 会串味。
  const key = `${fontFamily}${sep}${fontWeight}${sep}${fontSizePx}${sep}${feat}${sep}${text}`;
  const cached = textCache.get(key);
  if (cached) return cached;

  const svg = ensureMeasureSvg();
  if (!measureText || !measureText.isConnected) {
    measureText = document.createElementNS(SVG_NS, "text");
    svg.appendChild(measureText);
  }
  const t = measureText;
  t.setAttribute("x", "0");
  t.setAttribute("y", "0");
  t.setAttribute("font-family", fontFamily);
  t.setAttribute("font-size", String(fontSizePx));
  t.setAttribute("font-weight", fontWeight);
  // font-feature-settings 在 SVG 1.1 里不是 presentation attribute，只能走 style。
  t.style.fontFeatureSettings = feat;
  t.textContent = text;

  const width = t.getComputedTextLength();

  // Use Canvas actualBoundingBox* for tight glyph bounds.
  // getBBox() on SVG <text> returns the full em/line box for CJK fonts (e.g.
  // "." in PingFang SC measures the same height as "1"), causing octave dots
  // to be placed far above their correct position.
  // Horizontally the ink box is NOT 0..advance: PingFang SC's "1" is a narrow
  // proportional glyph whose ink centre sits 3.1% of an em left of its advance
  // centre, which visibly offsets anything centred on it (octave dots, slur
  // ends, tuplet brackets). actualBoundingBoxLeft/Right come free from the same
  // measureText() call, so keep them.
  let bboxTop: number;
  let bboxBottom: number;
  let inkLeft = 0;
  let inkRight = width;
  if (!glyphCtx) {
    const c = document.createElement("canvas");
    glyphCtx = c.getContext("2d");
  }
  if (glyphCtx) {
    glyphCtx.font = cssFontShorthand(fontFamily, fontSizePx, fontWeight);
    const cm = glyphCtx.measureText(text);
    bboxTop = -(cm.actualBoundingBoxAscent ?? fontSizePx * 0.8);
    bboxBottom = cm.actualBoundingBoxDescent ?? fontSizePx * 0.2;
    // actualBoundingBoxLeft is the distance *left* of the origin, so it is
    // positive when ink overhangs to the left — negate it to get a coordinate.
    if (cm.actualBoundingBoxLeft !== undefined) inkLeft = -cm.actualBoundingBoxLeft;
    if (cm.actualBoundingBoxRight !== undefined) inkRight = cm.actualBoundingBoxRight;
  } else {
    const b = t.getBBox();
    bboxTop = b.y;
    bboxBottom = b.y + b.height;
  }

  const m: TextMetrics = {
    width,
    bbox: new Rect(inkLeft, bboxTop, inkRight, bboxBottom),
  };
  textCache.set(key, m);
  return m;
}

const pathCache = new Map<string, Rect>();

/** Tight bounds of an SVG path "d" string (replaces Path.computeTightBounds). */
export function pathTightBounds(d: string): Rect {
  const cached = pathCache.get(d);
  if (cached) return cached;

  const svg = ensureMeasureSvg();
  if (!measurePath || !measurePath.isConnected) {
    measurePath = document.createElementNS(SVG_NS, "path");
    svg.appendChild(measurePath);
  }
  measurePath.setAttribute("d", d);
  const b = measurePath.getBBox();
  const r = new Rect(b.x, b.y, b.x + b.width, b.y + b.height);
  pathCache.set(d, r);
  return r;
}

// --- font-global metrics (ascent/descent), Skija FontMetrics convention:
//     ascent is negative (above baseline), descent positive (below) ---
let metricsCtx: CanvasRenderingContext2D | null = null;
const metricsCache = new Map<string, { ascent: number; descent: number }>();

export function measureFontMetrics(
  fontFamily: string,
  fontSizePx: number,
  fontWeight: "normal" | "bold" = "normal",
): { ascent: number; descent: number } {
  const sep = "\x01";
  const key = `${fontFamily}${sep}${fontWeight}${sep}${fontSizePx}`;
  const cached = metricsCache.get(key);
  if (cached) return cached;
  if (!metricsCtx) {
    const c = document.createElement("canvas");
    metricsCtx = c.getContext("2d");
  }
  let res = { ascent: -fontSizePx * 0.8, descent: fontSizePx * 0.2 };
  if (metricsCtx) {
    metricsCtx.font = cssFontShorthand(fontFamily, fontSizePx, fontWeight);
    const m = metricsCtx.measureText("Mg");
    const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
    const desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
    if (asc !== undefined && desc !== undefined) {
      res = { ascent: -asc, descent: desc };
    }
  }
  metricsCache.set(key, res);
  return res;
}

/** Resolve when the given font families are loaded so measurement is accurate. */
export async function ensureFontsReady(
  families: Array<{ family: string; size: number }>,
): Promise<void> {
  if (!("fonts" in document)) return;
  try {
    await Promise.all(
      families.map((f) => document.fonts.load(cssFontShorthand(f.family, f.size, "normal"))),
    );
    await document.fonts.ready;
  } catch {
    /* font load failures fall back to whatever the engine substitutes */
  }
  // Fonts changing invalidates earlier measurements.
  textCache.clear();
  pathCache.clear();
}


// ─────────────────────────────────────────── OpenType 特性
//
// 标点挤压有现成的 OpenType 特性（`chws` = CJK Contextual Half-width Spacing，
// 相邻标点自动取半角）。字体有就交给它——**在哪测量就在哪绘制**，shaping 与渲染同一个引擎；
// 没有就退回 common/cjkpunct.ts 的等效实现。两条路由 `punctTrim` 统一出口，下游只认一个数。
//
// **注意**：带 features 量多字串时，返回的 `width` 是挤压后的（SVG shaping 说了算），
// 而 `bbox` 来自 canvas（设不了 feature，量的是未挤压的连排）。要墨迹一律**逐字量**。

export type FeatureList = readonly string[];

/** 一个字两侧的实际留白（advance 减墨迹）。挤压量拿它封顶——只压空白，绝不压墨。 */
export function slackOf(
  fontFamily: string,
  fontSizePx: number,
  fontWeight: "normal" | "bold" = "normal",
): Slack {
  return (ch: string) => {
    const m = measureGlyphText(ch, fontFamily, fontSizePx, fontWeight);
    return { left: m.bbox.left, right: m.width - m.bbox.right };
  };
}

/** 横排标点挤压（上下文）。竖排是 `vchw`，本项目不排竖排。 */
export const CHWS: FeatureList = ["chws"];

/** 无条件半角标点。 */
export const HALT: FeatureList = ["halt"];

/** 挤压档 → OpenType 特性。字体没有这个特性时退回 cjkpunct 的等效实现。 */
export function featuresFor(mode: CompressMode): FeatureList {
  return mode === "halfwidth" ? HALT : mode === "clreq" ? CHWS : [];
}

function featureSettings(features?: FeatureList): string {
  if (!features || !features.length) return "";
  return features.map((f) => `"${f}" 1`).join(", ");
}

const featureCache = new Map<string, boolean>();

/**
 * 这个字体支不支持某个特性。开/关同一样本串比 advance——变了就是支持。
 * 样本用 `：“`（冒号 + 前引号，两截空白相接，`chws` 一定会压它）。
 */
export function hasFontFeature(
  fontFamily: string,
  feature: string,
  fontSizePx = 100,
  sample = "\uff1a\u201c",
): boolean {
  const key = `${fontFamily}\x01${feature}`;
  const cached = featureCache.get(key);
  if (cached !== undefined) return cached;
  const on = measureGlyphText(sample, fontFamily, fontSizePx, "normal", [feature]).width;
  const off = measureGlyphText(sample, fontFamily, fontSizePx, "normal").width;
  const res = Math.abs(on - off) > 0.01;
  featureCache.set(key, res);
  return res;
}

/**
 * 一串字的逐字笔位与总宽（`xs[i]` = 第 i 个**码点**的落笔点，相对串首 0）。
 *
 * 走 SVG 的 `getStartPositionOfChar`，拿到的是 shaping/GPOS 之后的真实笔位——
 * 字体带 `chws` 时挤压已经含在里面，不带时由 `compressRun` 按 CLREQ 自算。
 * 渲染端把这串 `xs` 原样交给 `<text>` 的 `x`，测量与绘制就一定一致。
 */
export function measureGlyphRun(
  text: string,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: "normal" | "bold" = "normal",
  mode: CompressMode = "clreq",
): { xs: number[]; width: number } {
  const chars = [...text];
  if (!chars.length) return { xs: [], width: 0 };
  const features = featuresFor(mode);
  const useFeature = !!features.length && features.some((f) => hasFontFeature(fontFamily, f, fontSizePx));
  if (!useFeature) {
    const adv = (ch: string) => measureGlyphText(ch, fontFamily, fontSizePx, fontWeight).width;
    return compressRun(chars, adv, fontSizePx, mode, slackOf(fontFamily, fontSizePx, fontWeight));
  }
  const svg = ensureMeasureSvg();
  if (!measureText || !measureText.isConnected) {
    measureText = document.createElementNS(SVG_NS, "text");
    svg.appendChild(measureText);
  }
  const t = measureText;
  t.setAttribute("x", "0");
  t.setAttribute("y", "0");
  t.setAttribute("font-family", fontFamily);
  t.setAttribute("font-size", String(fontSizePx));
  t.setAttribute("font-weight", fontWeight);
  t.style.fontFeatureSettings = featureSettings(features);
  t.textContent = text;
  const xs: number[] = [];
  let u16 = 0;
  for (const ch of chars) {
    xs.push(t.getStartPositionOfChar(u16).x);
    u16 += ch.length;
  }
  const width = t.getComputedTextLength();
  t.style.fontFeatureSettings = "";
  return { xs, width };
}

/**
 * 相邻两个字之间该压掉多少**像素**——标点挤压的**唯一出口**。
 *
 * 字体带 `chws` 就以它的实测量为准（`w(ab) < w(a)+w(b)` 的那个差），
 * 不带就按 CLREQ 折算。跨 `<text>` 的那一对标点（歌词逐字挂音符，前字的尾标点与
 * 后字的前引号分属两个元素，特性管不到）拿这个数当**间距下限**，见 layout.ts::calcXPos。
 */
export function punctTrim(
  prev: string,
  next: string,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: "normal" | "bold" = "normal",
  mode: CompressMode = "clreq",
): number {
  if (!prev || !next || mode === "none") return 0;
  const features = featuresFor(mode);
  const feat = features.find((f) => hasFontFeature(fontFamily, f, fontSizePx));
  if (feat) {
    const w = (s: string) => measureGlyphText(s, fontFamily, fontSizePx, fontWeight, features).width;
    return Math.max(0, w(prev) + w(next) - w(prev + next));
  }
  return pairTrimPx(mode, prev, next, fontSizePx, slackOf(fontFamily, fontSizePx, fontWeight));
}
