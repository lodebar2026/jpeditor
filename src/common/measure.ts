// SVG-based text/path measurement — replaces Skija's
//   font.measureText / font.metrics / Path.computeTightBounds / font.getPath bounds.
// "Measure where you draw": getBBox/getComputedTextLength use the same browser
// engine that renders the live score SVG, so measurement and rendering agree.

import { Rect } from "./geom";

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

export function measureGlyphText(
  text: string,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: "normal" | "bold" = "normal",
): TextMetrics {
  const sep = "\x01";
  const key = `${fontFamily}${sep}${fontWeight}${sep}${fontSizePx}${sep}${text}`;
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
  t.textContent = text;

  const width = t.getComputedTextLength();

  // Use Canvas actualBoundingBox* for tight vertical glyph bounds.
  // getBBox() on SVG <text> returns the full em/line box for CJK fonts (e.g.
  // "." in PingFang SC measures the same height as "1"), causing octave dots
  // to be placed far above their correct position.
  let bboxTop: number;
  let bboxBottom: number;
  if (!glyphCtx) {
    const c = document.createElement("canvas");
    glyphCtx = c.getContext("2d");
  }
  if (glyphCtx) {
    glyphCtx.font = `${fontWeight} ${fontSizePx}px "${fontFamily}"`;
    const cm = glyphCtx.measureText(text);
    bboxTop = -(cm.actualBoundingBoxAscent ?? fontSizePx * 0.8);
    bboxBottom = cm.actualBoundingBoxDescent ?? fontSizePx * 0.2;
  } else {
    const b = t.getBBox();
    bboxTop = b.y;
    bboxBottom = b.y + b.height;
  }

  const m: TextMetrics = {
    width,
    bbox: new Rect(0, bboxTop, width, bboxBottom),
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
    metricsCtx.font = `${fontWeight} ${fontSizePx}px "${fontFamily}"`;
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
      families.map((f) => document.fonts.load(`${f.size}px "${f.family}"`)),
    );
    await document.fonts.ready;
  } catch {
    /* font load failures fall back to whatever the engine substitutes */
  }
  // Fonts changing invalidates earlier measurements.
  textCache.clear();
  pathCache.clear();
}
