// Vector PPTX export — ports mp/layout/pptx.kt (POI) to hand-written OOXML.
// Walks the page tree into shapes (text boxes / custGeom freeforms), assembles a
// minimal valid .pptx deck, and zips with fflate. SMuFL glyphs become outline
// freeforms via opentype.js (Bravura.otf).

import { zipSync, type Zippable } from "fflate";
import * as opentype from "opentype.js";
import { asset } from "../common/asset";
import {
  BeamLine,
  GraphicLine,
  GraphicPath,
  Group,
  JpNumber,
  JpOctaveDot,
  PageItem,
  SmuflText,
  TextFrame,
  type PathSeg,
} from "../layout/layout";
import { walkPageItem, type ItemVisitor } from "../layout/walk";


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
  text: string; size: number; colorHex: string; bold: boolean; family: string;
  /** 段落对齐。默认左对齐；音符数字走居中（见 TARGET_ADVANCE 那一段）。 */
  align?: "l" | "ctr";
}
interface GeomShape {
  kind: "geom";
  x: number; y: number; w: number; h: number;
  segs: PathSeg[]; // local, 0-based
  fillHex: string | null; strokeHex: string | null; strokeW: number;
}
type Shape = TextShape | GeomShape;

// ---------------- 目标字体（.pptx 里真正会用来渲染的那一份）的度量 ----------------
//
// 排版是拿浏览器里的 **PingFang SC** 量的（`common/measure.ts`，「在哪测量就在哪绘制」），
// 但这份 .pptx 里写进去的字体是 **Microsoft YaHei**（见 `pptTypeface`——投影机与 Windows
// 上真正会用的那一份，也是 2019 年那批成品 .pptx `ppt500/` 用的）。两套字度量不同：
//
//   · descent：PingFang 0.357 em，YaHei 536/2048 = 0.2617 em。文本框是 `anchor="b"`，
//     descent 拿错了整页文字就整体下沉（28pt 上 1.3pt），而减时线/八度点/小节线是矢量、
//     坐标是绝对的——于是**文字与谱面记号整体错开**，减时线看着贴在数字底下。
//   · 数字宽：YaHei 是**等宽数字**（一律 1201/2048 = 0.5864 em），PingFang 是比例数字
//     （"1" 只有 0.401 em）。所以 "1" 的八度点与减时线偏得最厉害。
//
// 于是这里按目标字体重新落位：竖向拿 YaHei 的 descent 定框底，横向把音符数字**居中**
// 到目标宽度的框里、框心落在排版的墨迹中心 `JpNumber.cx` 上——八度点、附点、弧、
// 三连音括线、和弦全都锚在那个 cx 上，数字回到那儿，所有装饰就一起对齐了。
// 数字取自 msyh.ttf 的 hmtx/hhea，与 `ppt500/` 里量到的完全一致。
const TARGET_UPM = 2048;
const TARGET_DESCENT = 536 / TARGET_UPM;
/** 目标字体里这几个字的 advance（em 比例）。**表外的字一律照排版量到的宽度走**：
 *  汉字两套字都是 1 em，本来就对得上，只有西文数字/连字符这类比例字形对不上。 */
const TARGET_ADVANCE: Record<string, number> = {
  "-": 886 / TARGET_UPM,
  ".": 493 / TARGET_UPM,
  "\u00b7": 493 / TARGET_UPM,
  ...Object.fromEntries([..."0123456789"].map((d) => [d, 1201 / TARGET_UPM])),
};

/** 目标字体里数字的**墨迹右缘**（em 比例，advance 的起点算 0）。0–9 落在
 *  0.512~0.551 之间（YaHei 是等宽数字），取中间值——附点要按它摆，见 augDotX。 */
const TARGET_DIGIT_INK_RIGHT = 0.532;

/** 目标字体里这一串字有多宽（pt）。**整串都在表里才认**，否则返回 null = 照旧。 */
function targetWidth(text: string, size: number): number | null {
  let w = 0;
  for (const ch of text) {
    const a = TARGET_ADVANCE[ch];
    if (a === undefined) return null;
    w += a;
  }
  return w * size;
}

/** 这个音符数字在 .pptx 里的横向占位：以排版的墨迹中心 `cx` 为心、目标字体的宽度
 *  `tw` 为宽。**只认单字**（`cx` 记的是首字的墨迹中心），多字的 `tw` 为 null、
 *  半宽退回排版量到的 advance。 */
function numberSpan(num: JpNumber): { cx: number; half: number; tw: number | null } {
  const size = num.font.size * num.matrix.scaleY;
  const tw = [...num.text].length === 1 ? targetWidth(num.text, size) : null;
  return { cx: num.pos(null).x + num.cx, half: (tw ?? num.numberPos) / 2, tw };
}

/** 收尾类标点（跟在字后面的那些）→ 目标字体里的**半角形**。
 *
 * 为什么要换字符：DrawingML 一个 run 只能整串连排，所以带逐字笔位（`TextFrame.charXs`，
 * 标点挤压的产物）的歌词要拆成逐字文本框才落得回排版量好的坐标。可**标点单独成一个框**
 * 在 .pptx 里就散了——目标字体（Microsoft YaHei）的全角逗号墨迹在字身**正中**
 * （0.40~0.55 em），摆进半角格里正好顶到下一个字，看着像挂在后一个字头上（用户口径：
 * 「逗号展示有问题」）。
 *
 * 办法照 2019 年那批成品（`ppt500/`）：**标点并进前一个字的 run、并换成半角形**
 * （那批片子里就是 `主,`、`祢｡`、`亚!`）。一个 run 连排出来，标点正好落在排版
 * 给它的那半格里，且与前一个字咬合。**只管收尾类**：开头类（`（`、`「`）跟的是
 * 后一个字，并进去会把那个字往左拉 0.26 em、与音符对不上，全书也只有十来处，照旧单独成框。
 *
 * 排版那一端不做这种事（`common/cjkpunct.ts` 的「换字符」老做法早退休了，SVG 逐字笔位
 * 摆得准）——这里换只是**目标字体的适配**，与 TARGET_ADVANCE 那一层同一个道理。
 */
const TRAIL_PUNCT: Record<string, string> = {
  "\uff0c": ",", "\u3002": "\uff61", "\uff1b": ";", "\uff1a": ":",
  "\uff01": "!", "\uff1f": "?", "\u3001": "\uff64",
  "\uff09": ")", "\u300d": "\uff63", "\u300f": "\uff63",
};

/** 附点的横向落点（圆的**左缘**，绝对坐标，口径同 `JpOctaveDot.x`）。
 *
 * 排版把附点摆在「数字**墨迹**右缘 → 条目右缘」的正中（`layout.ts::addAugDots` 的口径），
 * 可那两头都是拿 PingFang 量的：PingFang 的 "1" 又窄又靠左、`·` 的 advance 又比 YaHei 宽
 * 一倍，换成 YaHei 渲染后 "1." 只剩 3.1pt 而 "5." 有 6.6pt，一眼看得出不匀。
 * .pptx 这一端索性照 2019 年那批成品来：**离数字墨迹右缘固定 0.165 em**，各数字一样宽
 * （成品里量到 28pt 上 4.7pt）；多个附点之间按目标字体 `.` 的 advance 排。
 */
const TARGET_AUG_GAP = 0.165;
function augDotX(num: JpNumber, index: number): number {
  const size = num.font.size * num.matrix.scaleY;
  const { cx, half } = numberSpan(num);
  const inkRight = cx - half + TARGET_DIGIT_INK_RIGHT * size;
  return inkRight + TARGET_AUG_GAP * size + TARGET_ADVANCE["."] * size * index;
}

let bravuraFont: opentype.Font | null = null;
async function loadBravura(): Promise<opentype.Font> {
  if (!bravuraFont) {
    const buf = await fetch(asset("redist/Bravura.otf")).then((r) => r.arrayBuffer());
    bravuraFont = opentype.parse(buf);
  }
  return bravuraFont;
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
//
// 遍历骨架与另外三路共用（layout/walk.ts），但**坐标不走矩阵累积**：这里用
// `item.pos(null)` 拿到叶子相对页根的绝对位置，所以 visitor 不需要携带任何东西（M = void）。
// 与那三路一样，叶子的子级不再往下走。
function shapeVisitor(font: opentype.Font, out: Shape[]): ItemVisitor<void> {
  return {
    descend: () => undefined,
    descendChildren: (item) =>
      !(item instanceof GraphicLine || item instanceof GraphicPath || item instanceof TextFrame),
    line: (item) => {
      const pp = item.pos(null);
      let x0 = item.p0.x + pp.x, x1 = item.p1.x + pp.x;
      const y0 = item.p0.y + pp.y, y1 = item.p1.y + pp.y;
      // 减时线：排版给的两端是**排版字体**的数字 advance 边缘，可 .pptx 里画出来的
      // 数字是目标字体的宽度（见 TARGET_ADVANCE）。按目标宽度把两端接回数字盒，
      // 否则 "1" 底下那道线短一截、还整体偏左。
      if (item instanceof BeamLine && item.left?.number && item.right?.number) {
        const l = numberSpan(item.left.number), r = numberSpan(item.right.number);
        x0 = l.cx - l.half;
        x1 = r.cx + r.half;
      }
      const ox = Math.min(x0, x1), oy = Math.min(y0, y1);
      out.push({
        kind: "geom", x: ox, y: oy, w: Math.max(Math.abs(x1 - x0), 0.01), h: Math.max(Math.abs(y1 - y0), 0.01),
        segs: [{ op: "M", pts: [x0 - ox, y0 - oy] }, { op: "L", pts: [x1 - ox, y1 - oy] }],
        fillHex: null, strokeHex: hex(item.strokeColor), strokeW: item.strokeWidth,
      });
    },
    path: (item) => {
      const pp = item.pos(null);
      const x = item instanceof JpOctaveDot && item.aug
        ? augDotX(item.aug.num, item.aug.index)
        : pp.x;
      out.push({
        kind: "geom", x, y: pp.y, w: Math.max(item.width, 0.01), h: Math.max(item.height, 0.01),
        segs: item.segs,
        fillHex: item.fill ? hex(item.fillColor) : null,
        strokeHex: item.stroke ? hex(item.strokeColor) : null,
        strokeW: item.strokeWidth,
      });
    },
    text: (item) => {
      // SMuFL **转曲**：PPT 里不能指望装了 Bravura，字形拆成 custGeom 路径
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
            const local = segs.map((sg) => ({ op: sg.op, pts: sg.pts.map((v, i) => v - (i % 2 === 0 ? ox : oy)) }));
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
      const pp = item.pos(null);
      const fm = item.font.metrics;
      const height = fm.descent - fm.ascent;
      const sz = item.font.size * item.matrix.scaleY;
      // `TextFrame.y` 是**基线**；框是 `anchor="b"`，所以框底 = 基线 + **目标字体**的
      // descent（不是浏览器量到的那个，见 TARGET_DESCENT）。框高只影响框顶，随便给。
      const y = pp.y + TARGET_DESCENT * sz - height;
      const mk = (text: string, x: number, w: number, align?: "l" | "ctr"): TextShape => ({
        kind: "text", x, y, w: Math.max(w, 1), h: height,
        text, size: sz, colorHex: hex(item.color),
        bold: item.font.bold, family: item.font.family, align,
      });
      // 音符数字：按目标字体的宽度给框并**居中**，框心落在排版的墨迹中心上。
      if (item instanceof JpNumber) {
        const { cx, half, tw } = numberSpan(item);
        if (tw !== null) {
          out.push(mk(item.text, cx - half, tw, "ctr"));
          return;
        }
      }
      // **逐字笔位**（标点挤压的产物，见 layout.ts::TextFrame.charXs）：DrawingML 的
      // 一个 run 只能整串连排，字距没法逐字给，所以带 charXs 的文本要**拆成逐字文本框**
      // 才落得回排版量好的那串坐标。不拆的话挤压在 PPT 里整个失效——歌词的标点回到全角，
      // 整行比屏幕上宽出一截（这正是导出的谱看着比屏幕「胖」的原因）。
      // 代价是一条歌词变成几个形状，PPT 里不好整串编辑；没有 charXs 的文本仍是一个 run。
      const chars = [...item.text];
      if (item.charXs && item.charXs.length === chars.length && chars.length > 1) {
        const xs = item.charXs;
        // 逐字成框，但**收尾标点并进前一个字**并换半角形（见 TRAIL_PUNCT）。
        const groups: { at: number; text: string }[] = [];
        for (let i = 0; i < chars.length; i++) {
          const half = TRAIL_PUNCT[chars[i]];
          if (half !== undefined && groups.length > 0) {
            groups[groups.length - 1].text += half;
          } else {
            groups.push({ at: i, text: chars[i] });
          }
        }
        for (let g = 0; g < groups.length; g++) {
          const x = xs[groups[g].at];
          const next = g + 1 < groups.length ? xs[groups[g + 1].at] : item.width;
          out.push(mk(groups[g].text, pp.x + x, next - x));
        }
        return;
      }
      out.push(mk(item.text, pp.x, item.width));
    },
  };
}

function collectShapes(item: PageItem, font: opentype.Font, out: Shape[]): void {
  walkPageItem(item, undefined, shapeVisitor(font, out));
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
  const family = pptTypeface(s.family);
  const b = s.bold ? ` b="1"` : "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${EMU(s.x)}" y="${EMU(s.y)}"/><a:ext cx="${EMU(s.w)}" cy="${EMU(s.h)}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="b" horzOverflow="overflow" vertOverflow="overflow"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
    `<a:p><a:pPr algn="${s.align ?? "l"}"/><a:r><a:rPr lang="zh-CN" sz="${sz}"${b}><a:solidFill><a:srgbClr val="${s.colorHex}"/></a:solidFill>` +
    `<a:latin typeface="${xml(family)}"/><a:ea typeface="${xml(family)}"/></a:rPr><a:t>${xml(s.text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

/** DrawingML accepts one typeface, not a CSS fallback list. The layout font
 * stack deliberately includes Microsoft YaHei, which is also the font used by
 * the original desktop PPTX exporter and is present on supported Windows. */
function pptTypeface(cssFamily: string): string {
  const families = cssFamily.split(",").map((f) => f.trim().replace(/^(['"])(.*)\1$/, "$2"));
  const yahei = families.find((f) => f.toLowerCase() === "microsoft yahei");
  if (yahei) return yahei;
  return families.find((f) => !/^(?:sans-serif|serif|monospace|system-ui)$/i.test(f)) || "Arial";
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

/** buildPptx 只用到页面树与页面尺寸，简谱与文本谱两种排版器都满足。 */
export interface PptxSource {
  layout: { pages: Group[] };
  pageWidth: number;
  pageHeight: number;
}

export async function buildPptx(painter: PptxSource): Promise<Uint8Array> {
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
