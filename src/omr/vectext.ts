// 矢量 PDF 的**文字层**抽取：把每一次 showText 拆成逐字形的位置、码位与轮廓。
//
// 与 `vector.ts` 的分工：那边只走路径（500 首那本「文字全部转曲」的歌本，文字层是空的，
// `VecExtras.hasText` 只是个布尔标记）；这边走文字。五线谱那条路（赞美之泉，Finale/Sibelius
// 直接生成的 PDF）**文字层是齐的**：符头、谱号、休止符、升降号都是 Maestro/Opus/Anastasia
// 这类音乐字体的真字符，`originalCharCode` 就是 musicpp `getSmufl()` 的输入。
//
// **本文件及其 import 链同样不得触碰 canvas / OffscreenCanvas / document**——
// Node CLI 要 import 它（理由见 vector.ts 开头）。
//
// ## 字形轮廓从哪来
//
// `getDocument({ disableFontFace: true })` 会让 worker 走 `PartialEvaluator.buildFontPaths`，
// 把每个用到的字形轮廓以 `commonObjs` 的 `"<loadedName>_path_<fontChar>"` 送出来，编码正是
// `vector.ts` 已经在解的那套 DrawOPS，坐标是**字形坐标系（em = 1，y 向上）**。
// 于是紧包围盒与形状签名都能在纯 Node 里算，不起浏览器、不用 canvas——
// 这块顶替的是 musicpp `fpdf::TextObj::getWordBounds`（pdfium 的逐字包围盒）。
// **没有 `disableFontFace: true` 就一个轮廓都拿不到**（见 scripts/node-harness.mjs 的 openPdf）。
//
// ## 变换的叠法（照 pdfjs canvas 的 showText/paintChar 逐句复现，勿凭直觉简化）
//
//   设备 = base · Tm · T(curX, curY + rise) · S(hScale·dir, -1) · T(advance, 0) · S(size, -size)
//
// 其中 `S(hScale·dir, -1)` 那个 -1 是「字形坐标 y 向上 → 文本坐标 y 向下」的翻转，
// `S(size, -size)` 再翻一次回来。两处都不能省：省掉字形会上下颠倒且大小错一个 em。
import type { Rect } from "./types";
import {
  type Mat,
  type OpsEnum,
  matMul,
  matApplyX,
  matApplyY,
  matScale,
  opsNames,
  pathBoundsRaw,
  intersectRect,
  rectsOverlap,
} from "./vector";

/** 一个字形。位置一律是**设备坐标**（y 向下，与 vector.ts 的 VecObj.bbox 同一系）。 */
export interface VecGlyph {
  /** PDF 内容流里的原始码位。查字体映射表用的就是它（Maestro 的 38 = G 谱号）。 */
  code: number;
  /** pdfjs 内部的字形键，取轮廓用（`<loadedName>_path_<fontChar>`）。 */
  fontChar: string;
  /** ToUnicode 的结果。**可能是乱码**（本书有几档 CJK 字体的 ToUnicode 是坏的）。 */
  unicode: string;
  /** 紧包围盒（设备坐标）。有轮廓时按轮廓算，没有则按 advance × 字号估。 */
  bbox: Rect;
  /** 包围盒是估出来的（没拿到轮廓）。 */
  bboxEstimated: boolean;
  /** 基线原点（设备坐标）。 */
  ox: number;
  oy: number;
  /** 字形坐标 → 设备坐标的矩阵（把 outline 直接套上去就是设备坐标）。 */
  ctm: Mat;
  /** 进距（设备坐标下的水平推进，含字距/词距）。 */
  advance: number;
  /** 字形轮廓（DrawOPS 扁平流，**字形坐标系** em=1、y 向上）；取不到为 null。 */
  outline: Float32Array | null;
  /** **贴图字**（JBIG2 位图当字用）的归一化指纹；普通字形没有。见 `maskRun`。 */
  maskSig?: string;
}

/** 一次 showText（PDF 的一个 Tj/TJ）。musicpp 的一个 `fpdf::TextObj` 对应它。 */
export interface VecTextRun {
  id: number;
  /** 字体名，**已去掉 6 位子集前缀**（`BRHFMA+Maestro` → `Maestro`）。 */
  font: string;
  /** 带子集前缀的原名，排查用。 */
  fontRaw: string;
  /** pdfjs 的 loadedName（`g_d0_f1`），取轮廓的 key 前缀。 */
  loadedName: string;
  /** 字号（PDF 单位）。真尺寸还要乘 ctm 的缩放，见 `sizeDev`。 */
  size: number;
  /** 设备坐标下的等效字号（= size × 文本矩阵与 ctm 的合成缩放）。判字号族用这个。 */
  sizeDev: number;
  glyphs: VecGlyph[];
  /** 全部字形的并集包围盒（设备坐标）。 */
  bbox: Rect;
  /** 文本渲染模式（3 = 不可见，OCR 底图那种；本书没有，但别当有墨迹处理）。 */
  renderMode: number;
  fill: string | null;
  /** 生效的裁剪框（设备坐标）；null = 未裁剪。 */
  clip: Rect | null;
}

/** 去掉 PDF 子集字体名的 6 位大写前缀：`BRHFMA+Maestro` → `Maestro`。 */
export function stripSubsetPrefix(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, "");
}

// ── 状态机 ──────────────────────────────────────────────────────────────────

interface TState {
  ctm: Mat;
  clip: Rect | null;
  fill: string | null;
  // 文字状态（PDF 里这些同样受 q/Q 管辖，故与 ctm 一起存栈）
  fontName: string | null;
  fontSize: number;
  fontDirection: number;
  fontMatrix: Mat;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
  tm: Mat;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
}

function cloneT(s: TState): TState {
  return { ...s, ctm: [...s.ctm] as Mat, tm: [...s.tm] as Mat, fontMatrix: [...s.fontMatrix] as Mat };
}

const IDENT: Mat = [1, 0, 0, 1, 0, 0];
/** pdfjs 的 FONT_IDENTITY_MATRIX。 */
const FONT_IDENTITY: Mat = [0.001, 0, 0, 0.001, 0, 0];

function emptyRect(): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

function grow(b: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number): void {
  if (x < b.x0) b.x0 = x;
  if (x > b.x1) b.x1 = x;
  if (y < b.y0) b.y0 = y;
  if (y > b.y1) b.y1 = y;
}

function toRect(b: { x0: number; y0: number; x1: number; y1: number }): Rect {
  return { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
}

/** 把字形坐标系下的紧包围盒经 ctm 变换成设备坐标的轴对齐盒（四角取包络）。 */
function boxThrough(m: Mat, x0: number, y0: number, x1: number, y1: number): Rect {
  const b = emptyRect();
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ]) {
    grow(b, matApplyX(m, x, y), matApplyY(m, x, y));
  }
  return toRect(b);
}

export interface TextExtractOptions {
  /** 设备坐标缩放（1 = PDF 点）。与 `extractVectorPage` 传同一个值，两边坐标才对得上。 */
  scale?: number;
  /** 丢弃完全落在裁剪框外的文字（默认 true，与路径那边一致）。 */
  applyClip?: boolean;
  /** 跳过不可见文字（renderMode 3）。默认 true。 */
  skipInvisible?: boolean;
  /** 取字形轮廓（默认 true）。关掉后 bbox 退回按 advance 估。 */
  withOutlines?: boolean;
}

/**
 * 抽取一页的文字对象。
 *
 * @param page pdfjs 的 PDFPageProxy（本文件不 import pdfjs）
 * @param OPS  pdfjs.OPS
 */
export async function extractTextPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  OPS: OpsEnum,
  opts: TextExtractOptions = {},
): Promise<VecTextRun[]> {
  const scale = opts.scale ?? 1;
  const applyClip = opts.applyClip ?? true;
  const skipInvisible = opts.skipInvisible ?? true;
  const withOutlines = opts.withOutlines ?? true;
  const viewport = page.getViewport({ scale });
  const base = [...viewport.transform] as Mat;
  const list = await page.getOperatorList();
  const names = opsNames(OPS);
  const pageRect: Rect = { x: 0, y: 0, w: viewport.width, h: viewport.height };
  const common = page.commonObjs;

  const out: VecTextRun[] = [];
  let id = 0;
  let st: TState = {
    ctm: base,
    clip: null,
    fill: "#000000",
    fontName: null,
    fontSize: 0,
    fontDirection: 1,
    fontMatrix: [...FONT_IDENTITY] as Mat,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    renderMode: 0,
    tm: [...IDENT] as Mat,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
  };
  const stack: TState[] = [];
  let pendingClip = false;

  // 字体对象缓存（每页几十次 setFont，commonObjs.get 不便宜）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fontCache = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getFont = (n: string): any => {
    let f = fontCache.get(n);
    if (f === undefined) {
      f = common.has(n) ? common.get(n) : null;
      fontCache.set(n, f);
    }
    return f;
  };
  // 轮廓缓存：同一个字形一页里出现几十次（符头），只解一次
  const outlineCache = new Map<string, { data: Float32Array | null; box: Rect | null }>();
  const getOutline = (loadedName: string, fontChar: string) => {
    const key = loadedName + "_path_" + fontChar;
    let v = outlineCache.get(key);
    if (v === undefined) {
      let data: Float32Array | null = null;
      try {
        // pdfjs 把轮廓存成 { path: Float16Array }（Float16 是 pdfjs 6 的省内存做法）
        const cmds = common.has(key) ? common.get(key) : null;
        const p = cmds?.path;
        if (p && p.length) data = p instanceof Float32Array ? p : new Float32Array(p);
      } catch {
        data = null;
      }
      const raw = data ? pathBoundsRaw(data) : null;
      v = { data, box: raw ? { x: raw.x0, y: raw.y0, w: raw.x1 - raw.x0, h: raw.y1 - raw.y0 } : null };
      outlineCache.set(key, v);
    }
    return v;
  };

  for (let i = 0; i < list.fnArray.length; i++) {
    const name = names[list.fnArray[i]];
    const args = list.argsArray[i];
    switch (name) {
      case "save":
        stack.push(cloneT(st));
        break;
      case "restore": {
        const prev = stack.pop();
        if (prev) st = prev;
        break;
      }
      case "transform":
        st.ctm = matMul(st.ctm, args as Mat);
        break;
      case "paintFormXObjectBegin": {
        stack.push(cloneT(st));
        const m = args[0] as Mat | null | undefined;
        if (m && m.length >= 6) st.ctm = matMul(st.ctm, m);
        const bb = args[1] as ArrayLike<number> | null | undefined;
        if (bb && bb.length >= 4) {
          const r = boxThrough(st.ctm, bb[0], bb[1], bb[2], bb[3]);
          st.clip = st.clip ? intersectRect(st.clip, r) : r;
        }
        break;
      }
      case "paintFormXObjectEnd": {
        const prev = stack.pop();
        if (prev) st = prev;
        break;
      }
      case "setFillRGBColor":
        st.fill = args[0];
        break;
      case "clip":
      case "eoClip":
        pendingClip = true;
        break;
      case "constructPath": {
        // 只为跟住裁剪状态：路径本身归 vector.ts 管
        if (!pendingClip) break;
        const paint = names[args[0]] ?? "endPath";
        const data: Float32Array | undefined = args[1]?.[0];
        const minMax = args[2] as ArrayLike<number> | undefined;
        if (paint === "endPath" && (data?.length || minMax)) {
          let r: Rect | null = null;
          if (minMax && minMax.length >= 4) r = boxThrough(st.ctm, minMax[0], minMax[1], minMax[2], minMax[3]);
          else if (data) {
            const raw = pathBoundsRaw(data);
            if (raw) r = boxThrough(st.ctm, raw.x0, raw.y0, raw.x1, raw.y1);
          }
          if (r) st.clip = st.clip ? intersectRect(st.clip, r) : r;
        }
        pendingClip = false;
        break;
      }
      case "beginText":
        st.tm = [...IDENT] as Mat;
        st.x = st.y = st.lineX = st.lineY = 0;
        break;
      case "setFont": {
        st.fontName = args[0];
        // pdfjs：负字号表示「字形方向取反」，尺寸取绝对值
        let size = args[1] as number;
        if (size < 0) {
          size = -size;
          st.fontDirection = -1;
        } else {
          st.fontDirection = 1;
        }
        st.fontSize = size;
        const f = getFont(args[0]);
        st.fontMatrix = (f?.fontMatrix as Mat) ?? ([...FONT_IDENTITY] as Mat);
        break;
      }
      case "setTextMatrix":
        // pdfjs 的 setTextMatrix 只有**一个**参数、且是数组（与 transform 的六个散参不同）
        st.tm = [...(args[0] as number[])] as Mat;
        st.x = st.y = st.lineX = st.lineY = 0;
        break;
      case "setLeading":
        st.leading = -(args[0] as number);
        break;
      case "setLeadingMoveText":
        // PDF 的 `TD`：等价于 `TL(-ty)` 再 `Td(tx, ty)`。pdfjs 的 setLeading 自己会取负，
        // 于是 leading 最终是 **+ty**。写成 -ty 会让随后每个 `T*`（nextLine）走反方向
        // ——实测 Sibelius 的符干是一串 `T*` 叠上去的，符号错了整根符干会掉到符头下面去。
        st.leading = args[1] as number;
        st.x = st.lineX += args[0] as number;
        st.y = st.lineY += args[1] as number;
        break;
      case "moveText":
        st.x = st.lineX += args[0] as number;
        st.y = st.lineY += args[1] as number;
        break;
      case "nextLine": // = moveText(0, leading)
        st.x = st.lineX;
        st.y = st.lineY += st.leading;
        break;
      case "setCharSpacing":
        st.charSpacing = args[0];
        break;
      case "setWordSpacing":
        st.wordSpacing = args[0];
        break;
      case "setHScale":
        st.hScale = (args[0] as number) / 100;
        break;
      case "setTextRise":
        st.rise = args[0];
        break;
      case "setTextRenderingMode":
        st.renderMode = args[0];
        break;
      case "showText": {
        const glyphs = args[0] as unknown[];
        if (!glyphs?.length || !st.fontName || st.fontSize === 0) break;
        const font = getFont(st.fontName);
        if (!font) break;
        if (skipInvisible && st.renderMode === 3) break;

        // 照 canvas showText：base·Tm·T(x, y+rise)·S(hScale·dir, -1)
        const hs = st.hScale * st.fontDirection;
        // T(x, y+rise) 再 S(hs, -1) 合成一步就是 [hs, 0, 0, -1, x, y+rise]
        const runM = matMul(matMul(st.ctm, st.tm), [hs, 0, 0, -1, st.x, st.y + st.rise] as Mat);
        const widthScale = st.fontSize * st.fontMatrix[0];
        const loadedName: string = font.loadedName ?? st.fontName;
        const fontRaw: string = font.name ?? st.fontName;

        const gl: VecGlyph[] = [];
        const box = emptyRect();
        let adv = 0;
        for (const g of glyphs) {
          if (typeof g === "number") {
            // TJ 的数字项：负数拉近、正数推远（单位 1/1000 em）
            adv += -g * st.fontSize / 1000;
            continue;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const gg = g as any;
          const spacing = (gg.isSpace ? st.wordSpacing : 0) + st.charSpacing;
          // 字形坐标 → 设备：runM · T(adv, 0) · S(size, -size)
          const gm = matMul(runM, [st.fontSize, 0, 0, -st.fontSize, adv, 0] as Mat);
          const ox = matApplyX(runM, adv, 0);
          const oy = matApplyY(runM, adv, 0);
          const charW = gg.width * widthScale + spacing * st.fontDirection;

          let outline: Float32Array | null = null;
          let bbox: Rect;
          let estimated = true;
          if (withOutlines) {
            const o = getOutline(loadedName, gg.fontChar);
            outline = o.data;
            if (o.box && o.box.w > 0 && o.box.h > 0) {
              bbox = boxThrough(gm, o.box.x, o.box.y, o.box.x + o.box.w, o.box.y + o.box.h);
              estimated = false;
            } else {
              bbox = estimateBox(gm, gg.width * st.fontMatrix[0], font);
            }
          } else {
            bbox = estimateBox(gm, gg.width * st.fontMatrix[0], font);
          }
          grow(box, bbox.x, bbox.y);
          grow(box, bbox.x + bbox.w, bbox.y + bbox.h);
          gl.push({
            code: gg.originalCharCode ?? -1,
            fontChar: gg.fontChar ?? "",
            unicode: gg.unicode ?? "",
            bbox,
            bboxEstimated: estimated,
            ox,
            oy,
            ctm: gm,
            advance: Math.hypot(runM[0] * charW, runM[1] * charW),
            outline,
          });
          adv += charW;
        }
        // 推进文本位置（vertical 字体本书没有，照 canvas 的水平分支）
        st.x += adv * hs;

        if (gl.length) {
          const clip = st.clip ? intersectRect(st.clip, pageRect) : null;
          const bb = toRect(box);
          if (!applyClip || !clip || rectsOverlap(bb, clip)) {
            out.push({
              id: id++,
              font: stripSubsetPrefix(fontRaw),
              fontRaw,
              loadedName,
              size: st.fontSize,
              sizeDev: st.fontSize * matScale(matMul(st.ctm, st.tm)),
              glyphs: gl,
              bbox: bb,
              renderMode: st.renderMode,
              fill: st.fill,
              clip,
            });
          }
        }
        break;
      }
      // **贴图字**：这本书把造字区的字（禰 之类）当 JBIG2 位图贴进内容流。
      // 详见下面 `maskRun` 的注释。
      case "paintImageMaskXObject":
      case "paintImageMaskXObjectGroup":
      case "paintImageMaskXObjectRepeat": {
        const items = Array.isArray(args[0]) ? args[0] : [args[0]];
        for (const it of items) {
          const r = maskRun(page, it, st, id, applyClip ? pageRect : null);
          if (r) {
            out.push(r);
            id++;
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** 贴图字用的假字体名。下游按字体名分流时（`/Maestro|Opus|…/` 那些判据）不会误伤。 */
export const MASK_FONT = "#mask";

/**
 * **一张图像蒙版 → 一个「字」**。
 *
 * 赞美之泉那本把**造字区的汉字**（禰、祂 一类，Big5 之外）不是当文字排，
 * 而是当 **JBIG2 位图**贴进内容流（`/Im2 Do`，全书 277 处、54 页）。
 * 它们在文字层、路径层、`getTextContent`、poppler 的 `pdftotext` 里**通通看不见**
 * ——一度被当成「底本自己缺字」。要拿到它们，`getDocument` 必须给 `wasmUrl`
 * （否则 pdfjs 解不开 JBIG2，会整个丢掉那个 XObject）。
 *
 * 这里把每张蒙版包成一个**只有一个字形的文本 run**，字形的 `unicode` 先留空、
 * `maskSig` 带上归一化的位图指纹，由 `staffomr/textglyphs.ts` 的字典定案成汉字。
 * 包成 run 之后，归行、断音节、挂到音符上这几步全都照常走，不必另开一条路。
 *
 * **蒙版的 0 是墨**（PDF 的 stencil mask 默认 `Decode [0 1]`，0 才落笔）。
 */
function maskRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any,
  st: TState,
  id: number,
  pageRect: Rect | null,
): VecTextRun | null {
  const objId = typeof item === "string" ? item : item?.data;
  if (typeof objId !== "string") return null;
  let o: { data?: Uint8Array; width?: number; height?: number } | null = null;
  try {
    o = page.objs.has?.(objId) === false ? null : page.objs.get(objId);
  } catch {
    o = null;
  }
  if (!o?.data || !o.width || !o.height) return null;
  // 图像的单位方块经 ctm 落到设备坐标：ctm 把 [0,1]² 映到那一块
  const box = boxThrough(st.ctm, 0, 0, 1, 1);
  if (pageRect && (box.x + box.w < 0 || box.y + box.h < 0 || box.x > pageRect.w || box.y > pageRect.h)) return null;
  const bbox: Rect = { x: box.x, y: box.y, w: box.w, h: box.h };
  const glyph: VecGlyph = {
    code: 0,
    fontChar: "",
    unicode: "",
    bbox,
    bboxEstimated: false,
    ox: box.x,
    oy: box.y + box.h,
    ctm: [...st.ctm] as Mat,
    advance: box.w,
    outline: null,
    maskSig: maskSignature(o.data as Uint8Array, o.width, o.height),
  };
  return {
    id,
    font: MASK_FONT,
    fontRaw: MASK_FONT,
    loadedName: MASK_FONT,
    size: box.h,
    // 贴图只占**墨迹**那么大，等效字号按墨迹的长边估（汉字满一个 em 见方）
    sizeDev: Math.max(box.w, box.h),
    glyphs: [glyph],
    bbox,
    renderMode: 0,
    fill: st.fill,
    clip: st.clip,
  };
}

/** 蒙版位图 → 归一化指纹（`SIG` × `SIG` 的 0/1 串，1 = 墨）。同一个字不同尺寸也能对上。 */
const MASK_SIG_N = 24;
export function maskSignature(data: Uint8Array, w: number, h: number): string {
  const stride = (w + 7) >> 3;
  let out = "";
  for (let y = 0; y < MASK_SIG_N; y++) {
    for (let x = 0; x < MASK_SIG_N; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / MASK_SIG_N));
      const sy = Math.min(h - 1, Math.floor((y * h) / MASK_SIG_N));
      out += ((data[sy * stride + (sx >> 3)] >> (7 - (sx & 7))) & 1) ? "0" : "1";
    }
  }
  return out;
}

/** 拿不到轮廓时的包围盒兜底：宽用 advance，高用字体的 ascent/descent（em 单位）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function estimateBox(gm: Mat, widthEm: number, font: any): Rect {
  const asc = typeof font?.ascent === "number" && font.ascent ? font.ascent : 0.75;
  const desc = typeof font?.descent === "number" && font.descent ? font.descent : -0.25;
  return boxThrough(gm, 0, desc, widthEm || 0.5, asc);
}

// ── 便利查询 ────────────────────────────────────────────────────────────────

/** 一页里用到的字体名（已去子集前缀）→ 字形数。判「这一页是哪家刻谱软件排的」用。 */
export function fontTally(runs: VecTextRun[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of runs) m.set(r.font, (m.get(r.font) ?? 0) + r.glyphs.length);
  return m;
}

/** 把 run 拆成逐字形的平铺列表（识别侧多半按字形而非按 run 处理）。 */
export function flatGlyphs(runs: VecTextRun[]): { run: VecTextRun; glyph: VecGlyph }[] {
  const out: { run: VecTextRun; glyph: VecGlyph }[] = [];
  for (const r of runs) for (const g of r.glyphs) out.push({ run: r, glyph: g });
  return out;
}
