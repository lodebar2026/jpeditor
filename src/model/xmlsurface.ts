// MusicXML **表层**：`ScoreDoc` 之外的旁表，装 MusicXML 独有、别的格式与排版器都不读的东西。
//
// ## 为什么不进 `ScoreDoc`
//
// 版面坐标（`default-x/-y`、`relative-x/-y`）、小节宽、符干、对齐、字体、`<system-layout>`、`<staff-details>`、
// slur 贝塞尔、`<supports>`、`repeat winged`……只有两个用处：`.musicxml` 改动后整份重写不丢、五线谱引擎照原版面排。
// 以前逐项往模型里加字段，加一项丢一项（`layout-attr-check` 的「仍丢」表就是这么来的）。
// 现在与简谱那套同理——**不存进模型、经查询层取**（简谱的是 `jianpu.ts`，那边是由语义派生，这边是从原文现读）：
//
// - `fromxml.ts` 读语义进模型，同时把每个模型对象**绑**到它的原始 DOM 节点（本文件的 WeakMap，不在模型里）；
// - 五线谱引擎要的坐标、符干、对齐、字体经下面的查询函数从原节点现读；
// - 写出端 `toxml.ts` 按「写出端认得的属性/子节点」之外，把原节点其余的属性与子节点**通用回填**。
//
// 克隆出来的对象没有表层（= 文本来源），一律照常；对象被丢弃时旁表随之回收。
// 导出时五线谱引擎排出来的版面（`mixed/engrave.ts`）是另一个来源，形如 `EngravedLayout`，经 `ToXmlOptions.layout` 交给写出端，同样不写进模型。

import type { FontSpec, HAlign, Measure, MeasureAttrs, Note, Print, Song } from "./doc";
import { child, children } from "../score/xmldom";

/** 版面坐标（tenths，口径同 MusicXML 的 `default-x/-y`、`relative-x/-y`）。 */
export interface Position {
  defaultX?: number;
  defaultY?: number;
  relativeX?: number;
  relativeY?: number;
}

/** `<print>` 里的版式（系统与谱表间距）。 */
export interface PrintLayout {
  systemLayout?: { systemDistance?: number; topSystemDistance?: number; leftMargin?: number; rightMargin?: number };
  /** `<staff-layout number>`：本系统各谱表离上一谱表的距离 */
  staffLayouts?: { staff?: number; staffDistance?: number }[];
}

export type StemDir = "up" | "down" | "none" | "double";

// ───────────────────────── 绑定 ─────────────────────────

/** 对象 → 槽位 → 原节点。槽位：缺省 `""`；`Part` 另有 `"score-part"`；`Mark` 有 `"start"` / `"stop"`；
 *  `Direction` 另有 `"part"`（它自己那条 `<direction-type>` 子元素，`more` 里的各绑各的缺省槽）。 */
const SURFACE = new WeakMap<object, Map<string, Element>>();

export function bindSurface(obj: object, el: Element, slot = ""): void {
  let m = SURFACE.get(obj);
  if (!m) SURFACE.set(obj, (m = new Map()));
  if (!m.has(slot)) m.set(slot, el);
}

export function surfaceOf(obj: object | null | undefined, slot = ""): Element | undefined {
  return obj ? SURFACE.get(obj)?.get(slot) : undefined;
}

// ───────────────────────── 查询层 ─────────────────────────

const attrNum = (el: Element | null | undefined, name: string): number | undefined => {
  const t = el?.getAttribute(name);
  if (t === null || t === undefined || t === "") return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
};

const childNum = (el: Element | null, tag: string): number | undefined => {
  const t = el ? child(el, tag)?.textContent : undefined;
  if (t === undefined || t === null) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
};

/** 版面坐标元素：`DirectionPart` 取它那条 direction-type 子元素，其余取绑定的节点本身。 */
const posHost = (obj: object): Element | undefined => surfaceOf(obj, "part") ?? surfaceOf(obj);

function readPos(el: Element | undefined): Position | undefined {
  if (!el) return undefined;
  const p: Position = {};
  const dx = attrNum(el, "default-x");
  const dy = attrNum(el, "default-y");
  const rx = attrNum(el, "relative-x");
  const ry = attrNum(el, "relative-y");
  if (dx !== undefined) p.defaultX = dx;
  if (dy !== undefined) p.defaultY = dy;
  if (rx !== undefined) p.relativeX = rx;
  if (ry !== undefined) p.relativeY = ry;
  return Object.keys(p).length ? p : undefined;
}

/** 原文的版面坐标：`Note`（所在 `<note>`）、无音的 `Chord`、`Lyric`、`Harmony`、`DirectionPart`。 */
export function xmlPos(obj: object | null | undefined): Position | undefined {
  return obj ? readPos(posHost(obj)) : undefined;
}

/** `<measure width>`（tenths）。 */
export function measureWidth(m: Measure): number | undefined {
  return attrNum(surfaceOf(m), "width");
}

/** `<stem>` 的方向与 `default-y`（符干末端）。 */
export function noteStem(note: Note | null | undefined): { dir: StemDir; y?: number } | undefined {
  const el = note ? surfaceOf(note) : undefined;
  const st = el ? child(el, "stem") : null;
  const dir = st?.textContent?.trim();
  if (dir !== "up" && dir !== "down" && dir !== "none" && dir !== "double") return undefined;
  const y = attrNum(st, "default-y");
  return y === undefined ? { dir } : { dir, y };
}

const align = (el: Element | undefined, name: string): HAlign | undefined => {
  const v = el?.getAttribute(name);
  return v === "left" || v === "center" || v === "right" ? v : undefined;
};

/** `justify` / `halign` / `valign`（`Lyric`、`DirectionPart`）。 */
export function xmlAlign(obj: object): { justify?: HAlign; halign?: HAlign; valign?: string } {
  const el = posHost(obj);
  const out: { justify?: HAlign; halign?: HAlign; valign?: string } = {};
  const j = align(el, "justify");
  const h = align(el, "halign");
  const v = el?.getAttribute("valign");
  if (j) out.justify = j;
  if (h) out.halign = h;
  if (v) out.valign = v;
  return out;
}

function readFont(el: Element | null | undefined): FontSpec | undefined {
  if (!el) return undefined;
  const f: FontSpec = {};
  const fam = el.getAttribute("font-family");
  if (fam !== null) f.family = fam;
  const size = attrNum(el, "font-size");
  if (size !== undefined) f.size = size;
  const w = el.getAttribute("font-weight");
  if (w !== null) f.weight = w;
  const st = el.getAttribute("font-style");
  if (st !== null) f.style = st;
  return Object.keys(f).length ? f : undefined;
}

/** 文字的字体属性：`Lyric` 取首个 `<text>`，`DirectionPart` 取它那条子元素。 */
export function xmlFont(obj: object): FontSpec | undefined {
  const own = surfaceOf(obj, "part");
  if (own) return readFont(own);
  const el = surfaceOf(obj);
  if (!el) return undefined;
  return readFont(el.tagName === "lyric" ? child(el, "text") : el);
}

/** `<attributes>` 里的 `<staff-details number print-object>`。 */
export function staffDetailsOf(attrs: MeasureAttrs | undefined): { staff?: number; printObject?: boolean }[] {
  const el = attrs ? surfaceOf(attrs) : undefined;
  if (!el) return [];
  return children(el, "staff-details").map((sd) => {
    const out: { staff?: number; printObject?: boolean } = {};
    const n = sd.getAttribute("number");
    if (n) out.staff = Number(n);
    const po = sd.getAttribute("print-object");
    if (po) out.printObject = po !== "no";
    return out;
  });
}

/** 原文 `<print>` 的系统与谱表间距。 */
export function printLayout(p: Print | undefined): PrintLayout | undefined {
  const el = p ? surfaceOf(p) : undefined;
  if (!el) return undefined;
  const out: PrintLayout = {};
  const sl = child(el, "system-layout");
  if (sl) {
    const sys: NonNullable<PrintLayout["systemLayout"]> = {};
    const sd = childNum(sl, "system-distance");
    const td = childNum(sl, "top-system-distance");
    if (sd !== undefined) sys.systemDistance = sd;
    if (td !== undefined) sys.topSystemDistance = td;
    const mg = child(sl, "system-margins");
    const lm = childNum(mg, "left-margin");
    const rm = childNum(mg, "right-margin");
    if (lm !== undefined) sys.leftMargin = lm;
    if (rm !== undefined) sys.rightMargin = rm;
    if (Object.keys(sys).length) out.systemLayout = sys;
  }
  const staffLayouts = children(el, "staff-layout").map((s) => {
    const o: { staff?: number; staffDistance?: number } = {};
    const n = attrNum(s, "number");
    if (n !== undefined) o.staff = n;
    const sd = childNum(s, "staff-distance");
    if (sd !== undefined) o.staffDistance = sd;
    return o;
  });
  if (staffLayouts.length) out.staffLayouts = staffLayouts;
  return Object.keys(out).length ? out : undefined;
}

/** `<defaults>` 里模型不存的两种字体（五线谱引擎用：记号字号、文字缺省字体）。 */
export function defaultsFonts(song: Song): { musicFont?: FontSpec; wordFont?: FontSpec } {
  const root = surfaceOf(song);
  const def = root ? child(root, "defaults") : null;
  if (!def) return {};
  const out: { musicFont?: FontSpec; wordFont?: FontSpec } = {};
  const mf = child(def, "music-font");
  const wf = child(def, "word-font");
  // 元素在就算（属性全缺也要：五线谱引擎按「有这个元素」取缺省）
  if (mf) out.musicFont = readFont(mf) ?? {};
  if (wf) out.wordFont = readFont(wf) ?? {};
  return out;
}

/** 这份 MusicXML 是否自带版面坐标（任一小节有 width 或任一音符有 default-x）。 */
export function hasEmbeddedLayout(song: Song): boolean {
  for (const part of song.parts) {
    for (const m of part.measures) {
      const w = measureWidth(m);
      if (w !== undefined && w > 0) return true;
      for (const el of m.elements) {
        if (el.kind !== "chord") continue;
        const has = el.notes.length === 0
          ? xmlPos(el)?.defaultX !== undefined
          : el.notes.some((n) => xmlPos(n)?.defaultX !== undefined);
        if (has) return true;
      }
    }
  }
  return false;
}

// ───────────────────────── 导出版面 ─────────────────────────

/** 五线谱引擎给导出排出来的版面（`mixed/engrave.ts`），经 `ToXmlOptions.layout` 交给写出端。
 *  纸、scaling、标题块、换行这些模型本来就有的仍写进模型，这里只装表层的。 */
export interface EngravedLayout {
  /** `<defaults><system-layout>` */
  systemLayout?: NonNullable<PrintLayout["systemLayout"]>;
  /** 各小节宽（tenths） */
  widths: Map<Measure, number>;
  /** 行首小节的 `<print>` 版式 */
  prints: Map<Measure, PrintLayout>;
  /** `Note` / 无音 `Chord` / `Lyric` / `Harmony` / `DirectionPart` 的坐标 */
  pos: Map<object, Position>;
  /** 排出来的符干方向（原文没写的） */
  stems: Map<Note, "up" | "down">;
  /** 自动放置的文字记号统一过的字号（pt） */
  fontSize: Map<object, number>;
}

export function emptyEngravedLayout(): EngravedLayout {
  return { widths: new Map(), prints: new Map(), pos: new Map(), stems: new Map(), fontSize: new Map() };
}
