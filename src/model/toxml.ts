// `ScoreDoc` → MusicXML（**直通**，不经 `PuDoc`）。与 `fromxml.ts` 互逆。
//
// ## 为什么敢全量重写
//
// 保存策略是「模型未改动 → 原样写回；改动过 → 全量重写」。语义（音、和弦、力度、多声部、`<print>` 行结构、
// `<credit>` 版式…）从模型写；MusicXML 独有的表层（坐标、符干、对齐、字体、读不懂的属性与子节点）不在模型里，
// 而在 `fromxml.ts` 绑定的原节点上（`xmlsurface.ts`）——写出时**通用回填**：
//
// - 属性：原节点上写出端没写、也不归写出端管（`OWNS[标签].attrs`）的，按原顺序接在后面；
// - 子节点：写出端写了的逐个配对原节点（有绑定的用绑定，其余按「标签 + 同标签第几个」，个别按编号），递归回填；
//   原节点里没配上的，标签归写出端管（`OWNS[标签].kids`）就是模型删了它、丢掉，否则原样保留，
//   插在它原先前面最近一个配上的兄弟之后（原文合法，保住相对次序就合 schema）。
//
// 所以 **`fromxml.ts` 每读一个语义字段，这里的 `OWNS` 就要认领它**，否则原节点上那份会被回填、与模型打架
// （例如 `note@print-object`：改成可见后不能从原节点带回 `no`）。
// 导出时五线谱引擎排出来的版面（`ToXmlOptions.layout`，`mixed/engrave.ts`）由写出端显式写，回填跳过同名的。
//
// ## 元素顺序是硬要求
//
// MusicXML 的 `<measure>` 子元素顺序有语义：`<attributes>` 要在音符前、`<harmony>` 要在
// 它修饰的音符前、`<barline location="left">` 要在最前、`right` 要在最后。
// **顺序错了 MuseScore 会拒绝打开或静默错位**，所以这里按固定次序拼，不要图省事重排。

import type {
  Barline,
  Chord,
  Credit,
  Defaults,
  Direction,
  DirectionPart,
  FontSpec,
  Harmony,
  Key,
  Lyric,
  Mark,
  Measure,
  MeasureAttrs,
  Note,
  Part,
  Print,
  ScoreDoc,
  Song,
  Time,
} from "./doc";
import { harmonyXml as chordTextXml } from "../score/harmonyxml";
import { projectForMusicXml, type ProjectOptions } from "./xmlproject";
import { SOURCE_ID_PREFIX } from "./helpers";
import { surfaceOf, type EngravedLayout, type Position, type PrintLayout } from "./xmlsurface";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");

/** 一层缩进两格，与 MuseScore 的输出习惯一致。 */
const ind = (depth: number): string => "  ".repeat(depth);

// ───────────────────────── 输出树与表层回填 ─────────────────────────

/** 写出端先建树、最后序列化：回填表层要在子节点齐了之后才能配对。 */
interface XNode {
  name: string;
  /** 已拼好的属性串（带前导空格） */
  attrs: string;
  kids: XNode[];
  /** 已转义的文字：`<name>text</name>` */
  text?: string;
  /** 原样的一段 XML（可多行，按所在层级重新缩进） */
  raw?: string;
  /** 子节点与自己写在同一行（`<dynamics><mf/></dynamics>`） */
  inline?: boolean;
  /** 原节点（表层） */
  sur?: Element;
  /** 覆盖 `OWNS[name].attrs`（`<credit-words>` 第二行起的版式只从原节点来） */
  ownAttrs?: readonly string[];
}

/** 写出端管的属性与子节点：原节点上的这些以模型为准（模型没写就是没有），不回填。
 *  `kids: "*"` = 子节点全由写出端定。表里没有的标签：属性一个不管、子节点一个不管（没配上的全部回填）。
 *  `same`：写出端管、但模型不记缺省值的属性——写出端没写、原文写的恰是缺省值时照原文带回（`print-object="yes"`）。
 *  **只写 `layout`（导出版面）来的不要列**（小节 `width`、`<stem>`、`<system-layout>`…）：模型里没有它们，列了就会丢原文的。 */
const OWNS: Readonly<Record<string, { attrs?: readonly string[]; kids?: readonly string[] | "*"; same?: Readonly<Record<string, string>> }>> = {
  "score-partwise": { attrs: ["version"], kids: ["work", "movement-title", "identification", "defaults", "credit", "part-list", "part"] },
  work: { kids: ["work-number", "work-title"] },
  identification: { kids: ["creator", "rights", "encoding", "miscellaneous"] },
  creator: { attrs: ["type"] },
  encoding: { kids: ["software"] },
  miscellaneous: { kids: ["miscellaneous-field"] },
  "miscellaneous-field": { attrs: ["name"] },
  defaults: { kids: ["scaling", "page-layout"] },
  scaling: { kids: "*" },
  "page-layout": { kids: ["page-height", "page-width", "page-margins"] },
  "page-margins": { attrs: ["type"], kids: "*" },
  "lyric-font": { attrs: ["font-family", "font-size", "font-weight", "font-style"] },
  credit: { attrs: ["page"], kids: ["credit-type", "credit-words"] },
  "credit-words": { attrs: ["default-x", "default-y", "justify", "halign", "font-family", "font-size", "font-weight"] },
  "part-list": { kids: ["part-group", "score-part"] },
  "part-group": { attrs: ["type", "number"], kids: ["group-symbol", "group-name", "group-abbreviation", "group-barline"] },
  "score-part": { attrs: ["id"], kids: ["part-name", "part-abbreviation"] },
  part: { attrs: ["id"], kids: ["measure"] },
  measure: {
    attrs: ["number", "implicit"],
    kids: ["print", "barline", "attributes", "direction", "harmony", "note", "backup", "forward", "sound"],
  },
  print: { attrs: ["new-system", "new-page"] },
  attributes: { kids: ["divisions", "key", "time", "staves", "clef", "transpose"] },
  key: { kids: ["cancel", "fifths", "mode", "key-step", "key-alter"] },
  time: { attrs: ["symbol"], kids: ["beats", "beat-type"] },
  clef: { attrs: ["number"], kids: ["sign", "line", "clef-octave-change"] },
  transpose: { kids: ["diatonic", "chromatic", "octave-change"] },
  note: {
    attrs: ["print-object"],
    same: { "print-object": "yes" },
    kids: [
      "grace", "cue", "chord", "pitch", "unpitched", "rest", "duration", "tie", "voice", "type", "dot", "accidental",
      "time-modification", "notehead", "staff", "beam", "notations", "lyric",
    ],
  },
  grace: { attrs: ["slash"] },
  rest: { attrs: ["measure"] },
  pitch: { kids: "*" },
  unpitched: { kids: "*" },
  tie: { attrs: ["type"] },
  type: { attrs: ["size"] },
  accidental: { attrs: ["parentheses"] },
  "time-modification": { kids: ["actual-notes", "normal-notes"] },
  beam: { attrs: ["number"] },
  notations: { kids: ["slur", "tied", "tuplet", "fermata", "arpeggiate", "articulations", "ornaments", "technical"] },
  slur: { attrs: ["type", "number", "placement", "orientation"] },
  tied: { attrs: ["type", "number"] },
  tuplet: { attrs: ["type", "number", "bracket", "placement"] },
  fermata: { attrs: ["type"], same: { type: "upright" } },
  articulations: { kids: "*" },
  ornaments: { kids: "*" },
  technical: { kids: "*" },
  lyric: { attrs: ["number", "name"], kids: ["syllabic", "text", "extend", "elision"] },
  extend: { attrs: ["type"] },
  harmony: { attrs: ["staff"], kids: ["root", "kind", "bass", "degree", "offset"] },
  root: { kids: "*" },
  kind: { attrs: ["text", "use-symbols", "parentheses-degrees"] },
  bass: { kids: "*" },
  degree: { kids: "*" },
  direction: { attrs: ["placement"], kids: ["direction-type", "offset", "staff"] },
  "direction-type": { kids: "*" },
  dynamics: { kids: "*" },
  wedge: { attrs: ["type"] },
  metronome: { kids: ["beat-unit", "beat-unit-dot", "per-minute"] },
  bracket: { attrs: ["type", "line-end", "line-type"] },
  pedal: { attrs: ["type", "line"] },
  "octave-shift": { attrs: ["type"] },
  sound: { attrs: ["dacapo", "dalsegno", "fine", "segno", "coda", "tocoda", "tempo"] },
  barline: { attrs: ["location"], kids: ["bar-style", "ending", "repeat"] },
  ending: { attrs: ["number", "type", "print-object"], same: { "print-object": "yes" } },
  repeat: { attrs: ["direction", "times"] },
};

/** 子节点按编号配对的标签（按「第几个」配会配错：起止交错、层号跳号）。 */
const MATCH_KEY: Readonly<Record<string, readonly string[]>> = {
  "part-group": ["type", "number"],
  slur: ["type", "number"],
  tied: ["type", "number"],
  tuplet: ["type", "number"],
  beam: ["number"],
  lyric: ["number"],
  clef: ["number"],
  "staff-layout": ["number"],
  "page-margins": ["type"],
  barline: ["location"],
};

const attrMap = (attrs: string): Map<string, string> => {
  const m = new Map<string, string>();
  for (const a of attrs.matchAll(/\s([\w:.-]+)="([^"]*)"/g)) m.set(a[1]!, a[2]!);
  return m;
};

const keyOf = (keys: readonly string[], get: (k: string) => string | null | undefined): string =>
  keys.map((k) => get(k) ?? "").join("\u0000");

/** 序列化原节点，去掉它在源文件里的整体缩进（按收尾行的缩进左移），再按所在层级重新缩进——
 *  不去的话每往返一次子行缩进加深一层，重写结果不是定点。 */
function serializeDedented(el: Element): string {
  const lines = new XMLSerializer().serializeToString(el).split("\n");
  if (lines.length < 2) return lines[0]!;
  const base = /^ */.exec(lines[lines.length - 1]!)![0].length;
  return lines.map((l, i) => (i === 0 ? l : l.slice(Math.min(base, /^ */.exec(l)![0].length)))).join("\n");
}

/** 原节点上要接在后面的属性。 */
function carriedAttrs(n: XNode, sur: Element): string {
  const written = attrMap(n.attrs);
  const own = n.ownAttrs ?? OWNS[n.name]?.attrs ?? [];
  const same = OWNS[n.name]?.same;
  let out = "";
  for (const a of Array.from(sur.attributes)) {
    if (written.has(a.name) || (own.includes(a.name) && same?.[a.name] !== a.value)) continue;
    out += ` ${a.name}="${escAttr(a.value)}"`;
  }
  return out;
}

/** 子节点配对原节点，并把没配上、不归写出端管的原子节点插回去。 */
function mergeKids(n: XNode, sur: Element): XNode[] {
  const orig = Array.from(sur.children);
  const used = new Map<Element, XNode>();
  for (const k of n.kids) if (k.sur && k.sur.parentElement === sur && !used.has(k.sur)) used.set(k.sur, k);
  for (const k of n.kids) {
    if (k.sur || k.raw !== undefined) continue;
    const keys = MATCH_KEY[k.name];
    const mine = keys ? keyOf(keys, (a) => attrMap(k.attrs).get(a)) : "";
    const hit = orig.find((c) => c.tagName === k.name && !used.has(c) && (!keys || keyOf(keys, (a) => c.getAttribute(a)) === mine));
    if (!hit) continue;
    k.sur = hit;
    used.set(hit, k);
  }
  const own = OWNS[n.name]?.kids;
  if (own === "*") return n.kids;
  const out = [...n.kids];
  let head = 0;
  const placed = new Map<Element, XNode>(used);
  orig.forEach((c, i) => {
    if (used.has(c) || own?.includes(c.tagName)) return;
    const node: XNode = { name: "", attrs: "", kids: [], raw: serializeDedented(c) };
    let at = -1;
    for (let j = i - 1; j >= 0 && at < 0; j--) {
      const prev = placed.get(orig[j]!);
      if (prev) at = out.indexOf(prev) + 1;
    }
    if (at < 0) at = head++;
    out.splice(at, 0, node);
    placed.set(c, node);
  });
  return out;
}

function serializeNode(n: XNode, depth: number, lines: string[]): void {
  if (n.raw !== undefined) {
    for (const line of n.raw.split("\n")) lines.push(ind(depth) + line);
    return;
  }
  const sur = n.sur;
  const attrs = sur ? n.attrs + carriedAttrs(n, sur) : n.attrs;
  const kids = sur && n.text === undefined ? mergeKids(n, sur) : n.kids;
  if (n.text !== undefined) lines.push(`${ind(depth)}<${n.name}${attrs}>${n.text}</${n.name}>`);
  else if (kids.length === 0) lines.push(`${ind(depth)}<${n.name}${attrs}/>`);
  else if (n.inline) {
    const inner: string[] = [];
    for (const k of kids) serializeNode(k, 0, inner);
    lines.push(`${ind(depth)}<${n.name}${attrs}>${inner.join("")}</${n.name}>`);
  } else {
    lines.push(`${ind(depth)}<${n.name}${attrs}>`);
    for (const k of kids) serializeNode(k, depth + 1, lines);
    lines.push(`${ind(depth)}</${n.name}>`);
  }
}

class Out {
  private readonly root: XNode = { name: "", attrs: "", kids: [] };
  private readonly stack: XNode[] = [this.root];

  private add(n: XNode): XNode {
    this.stack[this.stack.length - 1]!.kids.push(n);
    return n;
  }

  /** 开一个元素（`close` 收口）。`inline`：子节点写在同一行 */
  open(name: string, attrs = "", sur?: Element, inline = false): XNode {
    const n = this.add({ name, attrs, kids: [], ...(sur ? { sur } : {}), ...(inline ? { inline } : {}) });
    this.stack.push(n);
    return n;
  }

  close(): void {
    this.stack.pop();
  }

  /** 空元素 `<name attrs/>`（原节点有子节点时回填后可能不空） */
  leaf(name: string, attrs = "", sur?: Element): XNode {
    return this.add({ name, attrs, kids: [], ...(sur ? { sur } : {}) });
  }

  /** 文字元素 `<name attrs>text</name>` */
  text(name: string, text: string | number, attrs = "", sur?: Element): XNode {
    return this.add({ name, attrs, kids: [], text: typeof text === "string" ? esc(text) : String(text), ...(sur ? { sur } : {}) });
  }

  /** 原样的一段 XML */
  raw(xml: string): void {
    this.add({ name: "", attrs: "", kids: [], raw: xml });
  }

  toString(): string {
    const lines: string[] = [];
    for (const k of this.root.kids) serializeNode(k, 0, lines);
    return lines.join("\n");
  }
}

/** 版面坐标 → 属性串（带前导空格；没有则空串）。 */
function posAttrs(pos: Position | undefined): string {
  if (!pos) return "";
  const a: string[] = [];
  if (pos.defaultX !== undefined) a.push(`default-x="${pos.defaultX}"`);
  if (pos.defaultY !== undefined) a.push(`default-y="${pos.defaultY}"`);
  if (pos.relativeX !== undefined) a.push(`relative-x="${pos.relativeX}"`);
  if (pos.relativeY !== undefined) a.push(`relative-y="${pos.relativeY}"`);
  return a.length ? " " + a.join(" ") : "";
}

/** 字体 → 属性串（带前导空格；没有则空串）。见 `doc.ts::FontSpec`。 */
function fontAttrs(f: FontSpec | undefined): string {
  if (!f) return "";
  const a: string[] = [];
  if (f.family !== undefined) a.push(`font-family="${escAttr(f.family)}"`);
  if (f.size !== undefined) a.push(`font-size="${f.size}"`);
  if (f.weight !== undefined) a.push(`font-weight="${escAttr(f.weight)}"`);
  if (f.style !== undefined) a.push(`font-style="${escAttr(f.style)}"`);
  return a.length ? " " + a.join(" ") : "";
}

/** 写出这一遍的上下文：导出版面（可无）与是否带源 id。 */
interface Ctx {
  layout?: EngravedLayout;
  sourceIds: boolean;
}

// ───────────────────────── 头部 ─────────────────────────

function writeKey(o: Out, k: Key): void {
  o.open("key");
  if (k.cancel !== undefined) o.text("cancel", k.cancel);
  o.text("fifths", k.fifths);
  if (k.mode) o.text("mode", k.mode);
  for (const a of k.explicitAccidentals ?? []) {
    o.text("key-step", a.step);
    o.text("key-alter", a.alter);
  }
  o.close();
}

function writeTime(o: Out, t: Time): void {
  o.open("time", t.symbol ? ` symbol="${escAttr(t.symbol)}"` : "");
  o.text("beats", t.beats);
  o.text("beat-type", t.beatType);
  o.close();
}

type SystemLayout = NonNullable<PrintLayout["systemLayout"]>;

function writeSystemLayout(o: Out, sl: SystemLayout, bothMargins: boolean): void {
  o.open("system-layout");
  if (sl.leftMargin !== undefined || sl.rightMargin !== undefined) {
    o.open("system-margins");
    if (bothMargins || sl.leftMargin !== undefined) o.text("left-margin", sl.leftMargin ?? 0);
    if (bothMargins || sl.rightMargin !== undefined) o.text("right-margin", sl.rightMargin ?? 0);
    o.close();
  }
  if (sl.systemDistance !== undefined) o.text("system-distance", sl.systemDistance);
  if (sl.topSystemDistance !== undefined) o.text("top-system-distance", sl.topSystemDistance);
  o.close();
}

function writeDefaults(o: Out, def: Defaults | undefined, sl: SystemLayout | undefined): void {
  if (!def && !sl) return;
  o.open("defaults");
  if (def?.scaling) {
    o.open("scaling");
    o.text("millimeters", def.scaling.millimeters);
    o.text("tenths", def.scaling.tenths);
    o.close();
  }
  const pl = def?.pageLayout;
  if (pl) {
    o.open("page-layout");
    if (pl.pageHeight !== undefined) o.text("page-height", pl.pageHeight);
    if (pl.pageWidth !== undefined) o.text("page-width", pl.pageWidth);
    for (const mg of pl.margins ?? []) {
      o.open("page-margins", ` type="${mg.oddEven ?? "both"}"`);
      o.text("left-margin", mg.left);
      o.text("right-margin", mg.right);
      o.text("top-margin", mg.top);
      o.text("bottom-margin", mg.bottom);
      o.close();
    }
    o.close();
  }
  if (sl) writeSystemLayout(o, sl, true);
  if (def?.lyricFont) o.leaf("lyric-font", fontAttrs(def.lyricFont));
  o.close();
}

function writeCredit(o: Out, c: Credit): void {
  const sur = surfaceOf(c);
  o.open("credit", c.page ? ` page="${c.page}"` : ' page="1"', sur);
  if (c.type) o.text("credit-type", c.type);
  const attrs: string[] = [];
  if (c.x !== undefined) attrs.push(`default-x="${c.x}"`);
  if (c.y !== undefined) attrs.push(`default-y="${c.y}"`);
  if (c.justify) attrs.push(`justify="${c.justify}"`);
  if (c.halign) attrs.push(`halign="${c.halign}"`);
  if (c.fontFamily !== undefined) attrs.push(`font-family="${escAttr(c.fontFamily)}"`);
  if (c.fontSize !== undefined) attrs.push(`font-size="${c.fontSize}"`);
  if (c.fontWeight !== undefined) attrs.push(`font-weight="${escAttr(c.fontWeight)}"`);
  const a = attrs.length ? " " + attrs.join(" ") : "";
  (c.words ?? c.text.split("\n")).forEach((line, i) => {
    // 模型只记首个 `<credit-words>` 的版式；有原节点时第二行起的版式全从原节点来（各行字体可以不同）
    if (i > 0 && sur) o.text("credit-words", line).ownAttrs = [];
    else o.text("credit-words", line, a);
  });
  o.close();
}

// ───────────────────────── 音符 ─────────────────────────

function harmonyXml(o: Out, h: Harmony, cx: Ctx): void {
  // 简谱来源只有和弦原文（`"Cm7"`），结构交给和弦文字解析
  if (!h.kind && h.text) {
    o.raw(chordTextXml(h.text, h.offset ?? 0));
    return;
  }
  o.open("harmony", posAttrs(cx.layout?.pos.get(h)) + (h.staff !== undefined ? ` staff="${h.staff}"` : ""), surfaceOf(h));
  o.open("root");
  o.text("root-step", h.root.step);
  if (h.root.alter) o.text("root-alter", h.root.alter);
  o.close();
  const kindAttrs =
    (h.kindText !== undefined ? ` text="${escAttr(h.kindText)}"` : "") +
    (h.useSymbols ? ' use-symbols="yes"' : "") + (h.parenthesesDegrees ? ' parentheses-degrees="yes"' : "");
  o.text("kind", h.kind, kindAttrs);
  if (h.bass) {
    o.open("bass");
    o.text("bass-step", h.bass.step);
    if (h.bass.alter) o.text("bass-alter", h.bass.alter);
    o.close();
  }
  for (const g of h.degrees ?? []) {
    o.open("degree");
    o.text("degree-value", g.value);
    o.text("degree-alter", g.alter);
    o.text("degree-type", g.type);
    o.close();
  }
  if (h.offset) o.text("offset", h.offset);
  o.close();
}

function lyricXml(o: Out, l: Lyric, cx: Ctx): void {
  const number = l.numberText ?? (l.refrain ? "chorus" : String(l.number));
  const name = l.name !== undefined ? ` name="${escAttr(l.name)}"` : "";
  o.open("lyric", ` number="${escAttr(number)}"${name}${posAttrs(cx.layout?.pos.get(l))}`, surfaceOf(l));
  if (l.syllabic) o.text("syllabic", l.syllabic);
  o.text("text", (l.leadingPunctuation ?? "") + l.text + (l.trailingPunctuation ?? ""));
  if (l.extend) o.leaf("extend", l.extendType ? ` type="${l.extendType}"` : "");
  o.close();
}

/** 一个音符元素上要挂的 `<notations>`（含跨元素记号的起止）。 */
function notationsXml(o: Out, n: Chord["notations"], starts: Mark[], stops: Mark[]): void {
  const has =
    n?.articulations?.length ||
    n?.ornaments?.length ||
    n?.technical?.length ||
    n?.fermata ||
    n?.arpeggiate ||
    n?.glissando ||
    starts.length ||
    stops.length;
  if (!has) return;
  // 按类型、编号定序：`song.marks` 的次序随配对收口的先后变（和弦音上的记号并进来后重读会翻），写出不能跟着翻
  const order = (m: Mark): number => ["tied", "slur", "tuplet"].indexOf(m.type) * 1000 + (m.number ?? 1);
  starts = [...starts].sort((a, b) => order(a) - order(b));
  stops = [...stops].sort((a, b) => order(a) - order(b));
  o.open("notations");
  // 同一个音上先收后起（`)(` 接连两条弧：收前一条、起后一条），按编号配对时次序错了就会配成自起自收；
  // 真·自起自收（起止同一个音）的收口放最后
  const self = new Set(starts.filter((m) => stops.includes(m)));
  const writeStop = (m: Mark): void => {
    if (m.type === "slur" || m.type === "tied" || m.type === "tuplet") {
      o.leaf(m.type, ` type="stop" number="${m.number ?? 1}"`, surfaceOf(m, "stop"));
    }
  };
  for (const m of stops) if (!self.has(m)) writeStop(m);
  for (const m of starts) {
    const pl = m.placement ? ` placement="${m.placement}"` : "";
    const sur = surfaceOf(m, "start");
    if (m.type === "slur") {
      const ori = m.orientation ? ` orientation="${m.orientation}"` : "";
      o.leaf("slur", ` type="start" number="${m.number ?? 1}"${pl}${ori}`, sur);
    } else if (m.type === "tied") o.leaf("tied", ` type="start" number="${m.number ?? 1}"`, sur);
    else if (m.type === "tuplet") {
      const br = m.bracket !== undefined ? ` bracket="${m.bracket ? "yes" : "no"}"` : "";
      o.leaf("tuplet", ` type="start" number="${m.number ?? 1}"${br}${pl}`, sur);
    }
  }
  for (const m of stops) if (self.has(m)) writeStop(m);
  if (n?.fermata) o.leaf("fermata", n.fermataInverted ? ' type="inverted"' : "");
  if (n?.arpeggiate) o.leaf("arpeggiate");
  for (const [tag, list] of [["articulations", n?.articulations], ["ornaments", n?.ornaments], ["technical", n?.technical]] as const) {
    if (!list?.length) continue;
    o.open(tag);
    for (const a of list) o.leaf(a);
    o.close();
  }
  o.close();
}

/** 一个 `Chord` → 一条或多条 `<note>`（和弦音从第二个起带 `<chord/>`）。 */
function chordXml(o: Out, ch: Chord, starts: Mark[], stops: Mark[], cx: Ctx): void {
  let k = 0;
  const writeOne = (note: Note | null, isChordNote: boolean, withNotations: boolean): void => {
    // 源 id（`ToXmlOptions.sourceIds`）：XML 的 id 要唯一，和弦音从第二个起加序号
    const idAttr = cx.sourceIds ? ` id="${SOURCE_ID_PREFIX}${ch.id}${k++ > 0 ? `-${k - 1}` : ""}"` : "";
    const attrs = idAttr + posAttrs(cx.layout?.pos.get(note ?? ch)) + (ch.printObject === false ? ' print-object="no"' : "");
    o.open("note", attrs, surfaceOf(note ?? ch));
    if (ch.grace) o.leaf("grace", ch.grace.slash ? ' slash="yes"' : "");
    if (ch.cue) o.leaf("cue");
    if (isChordNote) o.leaf("chord");
    if (ch.rest) {
      o.leaf("rest", ch.rest.measure ? ' measure="yes"' : "");
    } else if (note?.pitch) {
      o.open("pitch");
      o.text("step", note.pitch.step);
      if (note.pitch.alter) o.text("alter", note.pitch.alter);
      o.text("octave", note.pitch.octave);
      o.close();
    } else if (ch.rhythm) {
      // 节奏音符（有声无音高）：斜线符头
      o.open("unpitched");
      o.text("display-step", "B");
      o.text("display-octave", 4);
      o.close();
    } else {
      o.leaf("rest");
    }
    // 倚音没有 duration（MusicXML 规定）
    if (!ch.grace) o.text("duration", Math.max(0, Math.round(ch.duration.divisions)));
    for (const t of [note?.tie?.start ? "start" : null, note?.tie?.stop ? "stop" : null]) {
      if (t) o.leaf("tie", ` type="${t}"`);
    }
    o.text("voice", ch.voice);
    if (ch.duration.type) {
      const size = isChordNote ? note?.typeSize : (ch.typeSize ?? note?.typeSize);
      o.text("type", ch.duration.type, size ? ` size="${escAttr(size)}"` : "");
    }
    for (let i = 0; i < ch.duration.dots; i++) o.leaf("dot");
    if (note?.accidental) o.text("accidental", note.accidental, note.accidentalParentheses ? ' parentheses="yes"' : "");
    if (ch.duration.timeMod) {
      o.open("time-modification");
      o.text("actual-notes", ch.duration.timeMod.actual);
      o.text("normal-notes", ch.duration.timeMod.normal);
      o.close();
    }
    const stem = note ? cx.layout?.stems.get(note) : undefined;
    if (stem) o.text("stem", stem);
    if (ch.rhythm && !isChordNote) o.text("notehead", "slash");
    else if (note?.notehead) o.text("notehead", note.notehead);
    if (ch.staff > 1) o.text("staff", ch.staff);
    // number 是层号：按下标算，不能 indexOf（两层同为 begin 时会都写成 1）
    (ch.beams ?? []).forEach((b, i) => o.text("beam", b, ` number="${i + 1}"`));
    // 跨元素记号挂回原来那个音（`Mark.startNote/endNote`），其余记号与歌词挂首音
    const idx = note ? ch.notes.indexOf(note) : 0;
    notationsXml(
      o,
      withNotations ? ch.notations : undefined,
      starts.filter((m) => (m.startNote ?? 0) === idx || (idx === 0 && (m.startNote ?? 0) >= ch.notes.length)),
      stops.filter((m) => (m.endNote ?? 0) === idx || (idx === 0 && (m.endNote ?? 0) >= ch.notes.length)),
    );
    if (withNotations) for (const l of ch.lyrics ?? []) lyricXml(o, l, cx);
    o.close();
  };

  if (ch.notes.length === 0) {
    writeOne(null, false, true);
    return;
  }
  ch.notes.forEach((n, i) => writeOne(n, i > 0, i === 0));
}

/** `<sound>` 的属性串（带前导空格；没有则空串）。 */
function soundAttrs(s: NonNullable<Direction["sound"]>): string {
  const a: string[] = [];
  if (s.dacapo) a.push('dacapo="yes"');
  if (s.dalsegno) a.push(`dalsegno="${escAttr(s.dalsegno)}"`);
  if (s.fine) a.push('fine="yes"');
  if (s.segno) a.push(`segno="${escAttr(s.segno)}"`);
  if (s.coda) a.push(`coda="${escAttr(s.coda)}"`);
  if (s.tocoda) a.push(`tocoda="${escAttr(s.tocoda)}"`);
  if (s.tempo !== undefined) a.push(`tempo="${s.tempo}"`);
  return a.map((x) => " " + x).join("");
}

function directionXml(o: Out, dir: Direction, cx: Ctx): void {
  if (dir.type === "sound") {
    // 小节级 `<sound>`：播放语义从模型写，其余属性与子元素（`<swing>`…）由原节点回填
    const sur = surfaceOf(dir);
    if (dir.sound || sur) o.leaf("sound", dir.sound ? soundAttrs(dir.sound) : "", sur);
    return;
  }
  const pl = dir.placement ? ` placement="${dir.placement}"` : "";
  o.open("direction", pl, surfaceOf(dir));
  o.open("direction-type");
  directionPartXml(o, dir, surfaceOf(dir, "part"), cx);
  for (const part of dir.more ?? []) directionPartXml(o, part, surfaceOf(part), cx);
  o.close();
  if (dir.offset !== undefined) o.text("offset", dir.offset);
  if (dir.sound) {
    const a = soundAttrs(dir.sound);
    if (a) o.leaf("sound", a);
  }
  if (dir.staff !== undefined && dir.staff > 1) o.text("staff", dir.staff);
  o.close();
}

/** `<direction-type>` 下的一个子元素。 */
function directionPartXml(o: Out, dir: DirectionPart, sur: Element | undefined, cx: Ctx): void {
  const pos = posAttrs(cx.layout?.pos.get(dir));
  const fs = cx.layout?.fontSize.get(dir);
  const lay = pos + (fs !== undefined ? ` font-size="${fs}"` : "");
  switch (dir.type) {
    case "dynamics":
      o.open("dynamics", lay, sur, true);
      o.leaf(dir.text || "mf");
      o.close();
      break;
    case "words":
    case "rehearsal":
      o.text(dir.type, dir.text ?? "", lay, sur);
      break;
    case "wedge":
      o.leaf("wedge", ` type="${dir.spanType === "stop" ? "stop" : dir.wedgeType ?? "crescendo"}"${pos}`, sur);
      break;
    case "metronome":
      o.open("metronome", lay, sur);
      o.text("beat-unit", dir.tempo?.beatUnit ?? "quarter");
      if (dir.tempo?.beatUnitDot) o.leaf("beat-unit-dot");
      o.text("per-minute", dir.tempo?.perMinuteText ?? dir.tempo?.perMinute ?? 90);
      o.close();
      break;
    case "bracket":
      // 伴奏括弧（简谱来源才带起止）；MusicXML 读进来的没有 spanType，照旧写空元素（原文的属性由表层回填）
      if (dir.spanType) o.leaf("bracket", ` type="${dir.spanType}" line-end="down" line-type="solid"`, sur);
      else o.leaf("bracket", "", sur);
      break;
    case "pedal":
    case "octave-shift": {
      const line = dir.line !== undefined ? ` line="${dir.line ? "yes" : "no"}"` : "";
      o.leaf(dir.type, ` type="${dir.spanType ?? "start"}"${line}${pos}`, sur);
      break;
    }
    default:
      o.leaf(dir.type, pos, sur);
      break;
  }
}

function barlineXml(o: Out, b: Barline): void {
  o.open("barline", ` location="${b.location === "middle" ? "middle" : b.location}"`, surfaceOf(b));
  if (b.style) o.text("bar-style", b.style);
  if (b.ending) {
    const t = b.ending.type;
    const nums = b.ending.numbers.join(",");
    const po = b.ending.printObject === false ? ' print-object="no"' : "";
    o.text("ending", b.ending.text ?? nums, ` number="${nums}" type="${t}"${po}`);
  }
  if (b.repeat) {
    const times = b.repeatTimes && b.repeatTimes > 2 ? ` times="${b.repeatTimes}"` : "";
    o.leaf("repeat", ` direction="${b.repeat}"${times}`);
  }
  o.close();
}

function printXml(o: Out, p: Print | undefined, lay: PrintLayout | undefined): void {
  if (!p && !lay) return;
  const a: string[] = [];
  if (p?.newSystem) a.push('new-system="yes"');
  if (p?.newPage) a.push('new-page="yes"');
  o.open("print", a.length ? " " + a.join(" ") : "", p ? surfaceOf(p) : undefined);
  if (lay?.systemLayout) writeSystemLayout(o, lay.systemLayout, false);
  for (const sl of lay?.staffLayouts ?? []) {
    const n = sl.staff !== undefined ? ` number="${sl.staff}"` : "";
    if (sl.staffDistance === undefined) {
      o.leaf("staff-layout", n);
      continue;
    }
    o.open("staff-layout", n);
    o.text("staff-distance", sl.staffDistance);
    o.close();
  }
  o.close();
}

function attributesXml(o: Out, attrs: MeasureAttrs): void {
  o.open("attributes", "", surfaceOf(attrs));
  if (attrs.divisions !== undefined) o.text("divisions", attrs.divisions);
  if (attrs.key) writeKey(o, attrs.key);
  if (attrs.time) writeTime(o, attrs.time);
  if (attrs.staves !== undefined) o.text("staves", attrs.staves);
  for (const c of attrs.clefs ?? []) {
    o.open("clef", c.staff ? ` number="${c.staff}"` : "");
    o.text("sign", c.sign);
    if (c.line !== undefined) o.text("line", c.line);
    if (c.octaveChange !== undefined) o.text("clef-octave-change", c.octaveChange);
    o.close();
  }
  if (attrs.transpose) {
    o.open("transpose");
    if (attrs.transpose.diatonic !== undefined) o.text("diatonic", attrs.transpose.diatonic);
    o.text("chromatic", attrs.transpose.chromatic);
    if (attrs.transpose.octaveChange !== undefined) o.text("octave-change", attrs.transpose.octaveChange);
    o.close();
  }
  o.close();
}

function measureXml(
  o: Out,
  m: Measure,
  marksByStart: Map<number, Mark[]>,
  marksByEnd: Map<number, Mark[]>,
  cx: Ctx,
): void {
  const width = cx.layout?.widths.get(m);
  const mAttrs = (m.implicit ? ' implicit="yes"' : "") + (width !== undefined ? ` width="${width}"` : "");
  o.open("measure", ` number="${escAttr(m.number)}"${mAttrs}`, surfaceOf(m));
  // 顺序是硬要求：print → 左线 → attributes → direction → (harmony/note)* → 右线
  printXml(o, m.print, cx.layout?.prints.get(m));
  for (const b of m.barlines ?? []) if (b.location === "left") barlineXml(o, b);
  if (m.attrs) attributesXml(o, m.attrs);
  // 记号按 afterElements 插回原位（缺省在小节开头；超出元素个数的落到小节末）
  const count = m.elements.length;
  const dirAt = (dir: Direction): number => Math.min(dir.afterElements ?? 0, count);
  // 游标：元素/记号带 `onset`（多声部）时补 `<backup>`/`<forward>` 挪过去；`end` 是前一个元素的终点（`onset` 缺省值）
  let cursor = 0;
  let end = 0;
  const moveTo = (target: number): void => {
    if (target < cursor) {
      o.open("backup");
      o.text("duration", cursor - target);
      o.close();
    } else if (target > cursor) {
      o.open("forward");
      o.text("duration", target - cursor);
      o.close();
    }
    cursor = target;
  };
  const writeLaterAttrs = (i: number): void => {
    for (const la of m.laterAttrs ?? []) {
      if (Math.min(la.afterElements, count) !== i) continue;
      moveTo(la.onset ?? end);
      attributesXml(o, la.attrs);
    }
  };
  const writeDir = (dir: Direction): void => {
    if (dir.type !== "sound") moveTo(dir.onset ?? end);
    directionXml(o, dir, cx);
  };
  const writeHarmony = (h: Harmony, owner: number): void => {
    moveTo(h.onset ?? owner);
    harmonyXml(o, h, cx);
  };
  for (const dir of m.directions ?? []) if (dirAt(dir) === 0) writeDir(dir);
  let i = 0;
  for (const el of m.elements) {
    // 小节中间的小节线按 afterElements 插回去，丢了会把两个小节并成一个
    for (const b of m.barlines ?? []) {
      if (b.location === "middle" && b.afterElements === i) barlineXml(o, b);
    }
    if (i > 0) writeLaterAttrs(i);
    if (i > 0) for (const dir of m.directions ?? []) if (dirAt(dir) === i) writeDir(dir);
    const onset = el.onset ?? end;
    if (el.kind === "chord") {
      if (el.harmony) writeHarmony(el.harmony, onset);
      for (const h of el.laterHarmonies ?? []) writeHarmony(h, onset);
      // 长音中途换和弦（挂在增时线上）：`<harmony>` 排在所辖音符之前，拍位靠 offset
      for (const su of el.sustains ?? []) if (su.harmony) writeHarmony(su.harmony, onset);
      moveTo(onset);
      chordXml(o, el, marksByStart.get(el.id) ?? [], marksByEnd.get(el.id) ?? [], cx);
      if (!el.grace) cursor += Math.max(0, Math.round(el.duration.divisions));
      end = cursor;
    } else if (el.spacer === "x" && el.duration) {
      // 不可见休止：占时值
      if (el.harmony) writeHarmony(el.harmony, onset);
      moveTo(onset);
      cursor += Math.max(0, Math.round(el.duration.divisions));
      end = cursor;
      o.open("note", ' print-object="no"');
      o.leaf("rest");
      o.text("duration", Math.max(0, Math.round(el.duration.divisions)));
      o.text("voice", el.voice);
      if (el.duration.type) o.text("type", el.duration.type);
      o.close();
    } else if (el.harmony) {
      // `y` 占位符只为挂和弦（规范 §8.1）——MusicXML 里就是一个孤立的 `<harmony>`
      writeHarmony(el.harmony, onset);
    }
    i += 1;
  }
  if (count > 0) writeLaterAttrs(count);
  if (count > 0) for (const dir of m.directions ?? []) if (dirAt(dir) === count) writeDir(dir);
  // `<forward>` 撑出来的空拍（`Measure.duration`）：补一个 `<forward>` 把游标推到小节末
  if (m.duration !== undefined && m.duration > cursor) moveTo(m.duration);
  for (const b of m.barlines ?? []) if (b.location === "right") barlineXml(o, b);
  o.close();
}

function partXml(o: Out, part: Part, song: Song, cx: Ctx): void {
  const byStart = new Map<number, Mark[]>();
  const byEnd = new Map<number, Mark[]>();
  const add = (map: Map<number, Mark[]>, id: number, m: Mark): void => {
    const list = map.get(id);
    if (list) list.push(m);
    else map.set(id, [m]);
  };
  for (const m of song.marks ?? []) {
    // 只有这三种在 MusicXML 里挂在 `<notations>` 上；wedge/pedal/octaveShift 走 `<direction>`
    if (m.type !== "slur" && m.type !== "tied" && m.type !== "tuplet") continue;
    add(byStart, m.start, m);
    add(byEnd, m.end, m);
  }
  o.open("part", ` id="${escAttr(part.id)}"`, surfaceOf(part));
  for (const m of part.measures) measureXml(o, m, byStart, byEnd, cx);
  o.close();
}

export interface ToXmlOptions extends ProjectOptions {
  /** 取第几首（多曲文件、文本谱 `-----` 分曲）。默认第一首 */
  song?: number;
  /** 每个 `<note>` 带 `id="jp<源元素 id>"`：文本格式派生五线谱（`export.ts::sourceMusicXmlBare`）读回后，
   *  `fromxml` 把它记成 `Chord.srcId`，五线谱上点的音才对得回代码区。**只给这条内部路径用**，导出文件不带。 */
  sourceIds?: boolean;
  /** 导出版面（`mixed/engrave.ts::engraveScoreDoc` 排出来的坐标、小节宽、系统间距、符干），键是本文档的模型对象 */
  layout?: EngravedLayout;
}

/** `ScoreDoc` → MusicXML 文本（含 XML 声明与 DOCTYPE）。**MusicXML 的唯一写出端**：
 *  简谱来源先经 `xmlproject.ts` 投成 MusicXML 形状，MusicXML 读进来的原样序列化（表层从原节点回填）。 */
export function scoreDocToMusicXml(doc: ScoreDoc, options: ToXmlOptions = {}): string {
  const src = doc.songs[options.song ?? 0];
  if (!src) throw new Error("这份文档里没有曲子");
  const song = projectForMusicXml(src, options);
  const cx: Ctx = { sourceIds: options.sourceIds === true, ...(options.layout ? { layout: options.layout } : {}) };
  // 文本格式投影出来的一律署上本应用（<encoding><software>）：混排引擎据此认 `<harmony><offset>` 等本写出端的写法
  const projected = song !== src;
  const o = new Out();
  o.raw('<?xml version="1.0" encoding="UTF-8"?>');
  o.raw(
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" ' +
      '"http://www.musicxml.org/dtds/partwise.dtd">',
  );
  o.open("score-partwise", ' version="3.1"', surfaceOf(song));
  if (song.work.number || song.work.title) {
    o.open("work");
    if (song.work.number) o.text("work-number", song.work.number);
    if (song.work.title) o.text("work-title", song.work.title);
    o.close();
  }
  if (song.work.movementTitle) o.text("movement-title", song.work.movementTitle);
  if (song.identification || song.meta || projected) {
    o.open("identification");
    for (const c of song.identification?.creators ?? []) o.text("creator", c.text, ` type="${escAttr(c.type)}"`);
    if (song.identification?.rights) o.text("rights", song.identification.rights);
    o.open("encoding");
    for (const sw of song.identification?.software ?? ["jpeditor"]) o.text("software", sw);
    o.close();
    // 扩展 meta（`model/metakeys.ts`）。schema 顺序：creator*, rights*, encoding?, source?, relation*, miscellaneous?
    const meta = Object.entries(song.meta ?? {});
    if (meta.length) {
      o.open("miscellaneous");
      for (const [name, vals] of meta) {
        for (const v of vals) o.text("miscellaneous-field", v, ` name="${escAttr(name)}"`);
      }
      o.close();
    }
    o.close();
  }
  writeDefaults(o, song.defaults, cx.layout?.systemLayout);
  for (const c of song.credits ?? []) writeCredit(o, c);

  o.open("part-list");
  const groups = song.partGroups ?? [];
  for (const g of groups) {
    o.open("part-group", ` type="start" number="${escAttr(g.number)}"`);
    if (g.symbol) o.text("group-symbol", g.symbol);
    if (g.name) o.text("group-name", g.name);
    if (g.abbrev) o.text("group-abbreviation", g.abbrev);
    if (g.groupBarline) o.text("group-barline", "yes");
    o.close();
  }
  for (const p of song.parts) {
    o.open("score-part", ` id="${escAttr(p.id)}"`, surfaceOf(p, "score-part"));
    // MuseScore 兼容：`<part-name>` 留空并 print-object="no"（见 MusicXML-导出.md）
    if (p.name) o.text("part-name", p.name);
    else o.leaf("part-name", ' print-object="no"');
    if (p.abbrev) o.text("part-abbreviation", p.abbrev);
    o.close();
  }
  for (const g of groups) o.leaf("part-group", ` type="stop" number="${escAttr(g.number)}"`);
  o.close();

  for (const p of song.parts) partXml(o, p, song, cx);
  o.close();
  return o.toString() + "\n";
}
