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

export function measureGlyphText(
  text: string,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: "normal" | "bold" = "normal",
): TextMetrics {
  const key = `${fontFamily}${fontWeight}${fontSizePx}${text}`;
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
  const b = t.getBBox();
  const m: TextMetrics = {
    width,
    bbox: new Rect(b.x, b.y, b.x + b.width, b.y + b.height),
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
  const key = `${fontFamily}${fontWeight}${fontSizePx}`;
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
