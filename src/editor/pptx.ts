// Vector PPTX export — ports mp/layout/pptx.kt (POI) to hand-written OOXML.
// Walks the page tree into shapes (text boxes / custGeom freeforms), assembles a
// minimal valid .pptx deck, and zips with fflate. SMuFL glyphs become outline
// freeforms via opentype.js (Bravura.otf).

import { zipSync, type Zippable } from "fflate";
import * as opentype from "opentype.js";
import {
  GraphicLine,
  GraphicPath,
  PageItem,
  SmuflText,
  TextFrame,
  type PathSeg,
} from "../layout/layout";
import type { JinpuPainter } from "../layout/painter";

const EMU = (v: number) => Math.round(v * 12700); // 1 pt = 12700 EMU

function xml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}
function hex(argb: number): string {
  return ((argb >>> 0) & 0xffffff).toString(16).padStart(6, "0").toUpperCase();
}

// ---------------- shape model ----------------
interface TextShape {
  kind: "text";
  x: number; y: number; w: number; h: number;
  text: string; size: number; colorHex: string; bold: boolean; family: string; cjk: boolean;
}
interface GeomShape {
  kind: "geom";
  x: number; y: number; w: number; h: number;
  segs: PathSeg[]; // local, 0-based
  fillHex: string | null; strokeHex: string | null; strokeW: number;
}
type Shape = TextShape | GeomShape;

let bravuraFont: opentype.Font | null = null;
async function loadBravura(): Promise<opentype.Font> {
  if (!bravuraFont) {
    const buf = await fetch("/redist/Bravura.otf").then((r) => r.arrayBuffer());
    bravuraFont = opentype.parse(buf);
  }
  return bravuraFont;
}

function hasCJK(s: string): boolean {
  for (const ch of s) if (ch.codePointAt(0)! >= 0x100) return true;
  return false;
}

function glyphSegs(font: opentype.Font, ch: string, size: number): { segs: PathSeg[]; bbox: { x1: number; y1: number; x2: number; y2: number } } | null {
  const g = font.charToGlyph(ch);
  if (!g) return null;
  const p = g.getPath(0, 0, size); // baseline at y=0, y-down
  const segs: PathSeg[] = [];
  for (const c of p.commands) {
    if (c.type === "M") segs.push({ op: "M", pts: [c.x, c.y] });
    else if (c.type === "L") segs.push({ op: "L", pts: [c.x, c.y] });
    else if (c.type === "C") segs.push({ op: "C", pts: [c.x1, c.y1, c.x2, c.y2, c.x, c.y] });
    else if (c.type === "Q") {
      // convert quadratic to cubic (custGeom has no quad)
      const prev = segs[segs.length - 1];
      const x0 = prev.pts[prev.pts.length - 2], y0 = prev.pts[prev.pts.length - 1];
      const c1x = x0 + (2 / 3) * (c.x1 - x0), c1y = y0 + (2 / 3) * (c.y1 - y0);
      const c2x = c.x + (2 / 3) * (c.x1 - c.x), c2y = c.y + (2 / 3) * (c.y1 - c.y);
      segs.push({ op: "C", pts: [c1x, c1y, c2x, c2y, c.x, c.y] });
    } else if (c.type === "Z") segs.push({ op: "Z", pts: [] });
  }
  const bb = p.getBoundingBox();
  return { segs, bbox: { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 } };
}

// ---------------- tree walk -> shapes ----------------
function collectShapes(item: PageItem, font: opentype.Font, out: Shape[]): void {
  if (item instanceof GraphicLine) {
    const pp = item.pos(null);
    const x0 = item.p0.x + pp.x, y0 = item.p0.y + pp.y;
    const x1 = item.p1.x + pp.x, y1 = item.p1.y + pp.y;
    const ox = Math.min(x0, x1), oy = Math.min(y0, y1);
    out.push({
      kind: "geom", x: ox, y: oy, w: Math.max(Math.abs(x1 - x0), 0.01), h: Math.max(Math.abs(y1 - y0), 0.01),
      segs: [{ op: "M", pts: [x0 - ox, y0 - oy] }, { op: "L", pts: [x1 - ox, y1 - oy] }],
      fillHex: null, strokeHex: hex(item.strokeColor), strokeW: item.strokeWidth,
    });
    return;
  }
  if (item instanceof GraphicPath) {
    const pp = item.pos(null);
    out.push({
      kind: "geom", x: pp.x, y: pp.y, w: Math.max(item.width, 0.01), h: Math.max(item.height, 0.01),
      segs: item.segs,
      fillHex: item.fill ? hex(item.fillColor) : null,
      strokeHex: item.stroke ? hex(item.strokeColor) : null,
      strokeW: item.strokeWidth,
    });
    return;
  }
  if (item instanceof SmuflText) {
    const pp = item.pos(null);
    const size = item.font.size * item.matrix.scaleY;
    const scale = size / font.unitsPerEm;
    let cx = 0;
    for (const ch of item.text) {
      const g = glyphSegs(font, ch, size);
      if (g) {
        const { segs, bbox } = g;
        const ox = bbox.x1, oy = bbox.y1;
        const local = segs.map((s) => ({ op: s.op, pts: s.pts.map((v, i) => v - (i % 2 === 0 ? ox : oy)) }));
        out.push({
          kind: "geom", x: pp.x + cx + ox, y: pp.y + oy,
          w: Math.max(bbox.x2 - bbox.x1, 0.01), h: Math.max(bbox.y2 - bbox.y1, 0.01),
          segs: local, fillHex: hex(item.color), strokeHex: null, strokeW: 0,
        });
      }
      cx += (font.charToGlyph(ch).advanceWidth ?? 0) * scale;
    }
    return;
  }
  if (item instanceof TextFrame) {
    const pp = item.pos(null);
    const fm = item.font.metrics;
    const height = fm.descent - fm.ascent;
    const sz = item.font.size * item.matrix.scaleY;
    out.push({
      kind: "text", x: pp.x, y: pp.y + fm.descent - height - sz / 20,
      w: Math.max(item.width, 1), h: height,
      text: item.text, size: sz, colorHex: hex(item.color),
      bold: item.font.bold, family: item.font.family, cjk: hasCJK(item.text),
    });
    return;
  }
  // Group / bare PageItem: recurse
  for (const ch of item.children) collectShapes(ch, font, out);
}

// ---------------- OOXML shape builders ----------------
function geomXml(s: GeomShape, id: number): string {
  const W = EMU(s.w), H = EMU(s.h);
  let path = "";
  for (const seg of s.segs) {
    const p = (i: number) => `<a:pt x="${EMU(seg.pts[i])}" y="${EMU(seg.pts[i + 1])}"/>`;
    if (seg.op === "M") path += `<a:moveTo>${p(0)}</a:moveTo>`;
    else if (seg.op === "L") path += `<a:lnTo>${p(0)}</a:lnTo>`;
    else if (seg.op === "C") path += `<a:cubicBezTo>${p(0)}${p(2)}${p(4)}</a:cubicBezTo>`;
    else if (seg.op === "Z") path += `<a:close/>`;
  }
  const fill = s.fillHex ? `<a:solidFill><a:srgbClr val="${s.fillHex}"/></a:solidFill>` : `<a:noFill/>`;
  const ln = s.strokeHex
    ? `<a:ln w="${EMU(s.strokeW)}"><a:solidFill><a:srgbClr val="${s.strokeHex}"/></a:solidFill></a:ln>`
    : `<a:ln><a:noFill/></a:ln>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="g${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${EMU(s.x)}" y="${EMU(s.y)}"/><a:ext cx="${W}" cy="${H}"/></a:xfrm>` +
    `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="${W}" b="${H}"/>` +
    `<a:pathLst><a:path w="${W}" h="${H}">${path}</a:path></a:pathLst></a:custGeom>${fill}${ln}</p:spPr>` +
    `<p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`;
}

function textXml(s: TextShape, id: number): string {
  const sz = Math.round(s.size * 100);
  const ea = s.cjk ? `<a:ea typeface="${xml(s.family)}"/>` : "";
  const b = s.bold ? ` b="1"` : "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${EMU(s.x)}" y="${EMU(s.y)}"/><a:ext cx="${EMU(s.w)}" cy="${EMU(s.h)}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="b"><a:spAutoFit/></a:bodyPr><a:lstStyle/>` +
    `<a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="${sz}"${b}><a:solidFill><a:srgbClr val="${s.colorHex}"/></a:solidFill>` +
    `<a:latin typeface="${xml(s.family)}"/>${ea}</a:rPr><a:t>${xml(s.text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function slideXml(shapes: Shape[]): string {
  let body = "";
  let id = 2;
  for (const s of shapes) body += s.kind === "text" ? textXml(s, id++) : geomXml(s, id++);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `${body}</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`;
}

// ---------------- deck scaffold ----------------
function buildDeck(slides: string[], wEmu: number, hEmu: number): Zippable {
  const files: Record<string, string> = {};
  const ct =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
    slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("") +
    `</Types>`;
  files["[Content_Types].xml"] = ct;
  files["_rels/.rels"] =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;

  const sldIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  files["ppt/presentation.xml"] =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
    `<p:sldSz cx="${wEmu}" cy="${hEmu}"/><p:notesSz cx="${hEmu}" cy="${wEmu}"/></p:presentation>`;

  const presRels = [`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`]
    .concat(slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`))
    .concat([`<Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`]);
  files["ppt/_rels/presentation.xml.rels"] =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels.join("")}</Relationships>`;

  files["ppt/theme/theme1.xml"] = THEME;
  files["ppt/slideMasters/slideMaster1.xml"] = slideMasterXml(wEmu, hEmu);
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`;
  files["ppt/slideLayouts/slideLayout1.xml"] = SLIDE_LAYOUT;
  files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;

  slides.forEach((sl, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = sl;
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;
  });

  const enc = new TextEncoder();
  const z: Zippable = {};
  for (const [k, v] of Object.entries(files)) z[k] = enc.encode(v);
  return z;
}

export async function buildPptx(painter: JinpuPainter): Promise<Uint8Array> {
  const font = await loadBravura();
  const slides = painter.layout.pages.map((pg) => {
    const shapes: Shape[] = [];
    collectShapes(pg, font, shapes);
    return slideXml(shapes);
  });
  const deck = buildDeck(slides, EMU(painter.pageWidth), EMU(painter.pageHeight));
  return zipSync(deck);
}

// Minimal theme / master / layout (enough for PowerPoint + LibreOffice).
const THEME =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements>` +
  `<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
  `<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>` +
  `<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>` +
  `<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>` +
  `<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>` +
  `<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
  `<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
  `<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
  `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
  `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>` +
  `</a:themeElements></a:theme>`;

function slideMasterXml(_w: number, _h: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>` +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
    `<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;
}

const SLIDE_LAYOUT =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">` +
  `<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>` +
  `<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sldLayout>`;
