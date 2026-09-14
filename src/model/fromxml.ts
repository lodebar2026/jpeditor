// MusicXML → `ScoreDoc`（**直通**，不经 `Score` 也不经 `MixedScore`）。
//
// ## 为什么要直通
//
// 以前两条路各有各的损失：`loadMusicXml → Score` 丢和弦、力度、多声部；
// 混排原先另读一遍 DOM 进 `MixedScore`，语义与排版（tenths）混在一起。而 `ScoreDoc` 两样都装得下，
// 所以 MusicXML 该直接读进它。
//
// ## 读不懂的怎么办：`raw` 原样留着
//
// 保存策略是「模型未改动 → 原样写回；改动过 → **全量重写**」（见 `docs/待办.md` §1 机制 A）。
// 全量重写不丢东西，靠的不是 patch，而是**读得全 + 读不懂的原样留着**：
// 凡本文件不认识的子节点，序列化成字符串挂到最近的 `raw` 上，`toxml.ts` 原位吐回去。
//
// 字段清单以混排原先的 DOM 读取（`mixed/loader.ts`，88 个元素，阶段 6 删）为基准；混排现在只读本模型（`mixed/layout.ts`），
// 它要的字段这里都得读到。
//
// **要 DOM**（`DOMParser`），所以只能在浏览器里跑；Node 侧的脚本走 `harness.mjs` 起页面。

import type {
  Barline,
  Chord,
  Clef,
  Credit,
  Defaults,
  Direction,
  DirectionPart,
  FontSpec,
  Element as DocElement,
  HAlign,
  Harmony,
  Key,
  Lyric,
  Mark,
  Measure,
  MeasureAttrs,
  Note,
  NoteType,
  Notations,
  Part,
  PartGroup,
  Pitch,
  Position,
  Print,
  ScoreDoc,
  Song,
  Space,
  Time,
  Transpose,
} from "./doc";
import { IdGen, emptyDoc, emptySong } from "./helpers";
import { assignDegrees } from "./jianpu";
import { child, childText, children } from "../score/xmldom";

const num = (el: Element | null, tag: string): number | undefined => {
  const t = el ? childText(el, tag) : null;
  if (t === null) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
};

const serialize = (el: Element): string => new XMLSerializer().serializeToString(el);

/** 序列化并去掉源文件里的整体缩进（按收尾行的缩进左移），`toxml.ts` 按自己的层级重新缩进——
 *  不去的话每往返一次子行缩进加深一层，重写结果不是定点。 */
function serializeDedented(el: Element): string {
  const lines = serialize(el).split("\n");
  if (lines.length < 2) return lines[0]!;
  const base = /^ */.exec(lines[lines.length - 1]!)![0].length;
  return lines.map((l, i) => (i === 0 ? l : l.slice(Math.min(base, /^ */.exec(l)![0].length)))).join("\n");
}

const attrNum = (el: Element, name: string): number | undefined => {
  const t = el.getAttribute(name);
  if (t === null || t === "") return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
};

/** 版面坐标属性；一个都没有时返回 `undefined`（不在模型里留空对象）。 */
function readPos(el: Element): Position | undefined {
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

const readAlign = (el: Element, name: string): HAlign | undefined => {
  const v = el.getAttribute(name);
  return v === "left" || v === "center" || v === "right" ? v : undefined;
};

/** 收集 `parent` 下**不在 `known` 里**的直接子节点，序列化后原样留着。 */
function rawOf(parent: Element, known: readonly string[]): string[] | undefined {
  const out: string[] = [];
  for (const c of Array.from(parent.children)) {
    if (!known.includes(c.tagName)) out.push(serialize(c));
  }
  return out.length ? out : undefined;
}

// ───────────────────────── 头部 ─────────────────────────

const KNOWN_KEY = ["fifths", "mode", "cancel", "key-step", "key-alter", "key-accidental"];

function readKey(el: Element): Key {
  const k: Key = { fifths: num(el, "fifths") ?? 0 };
  const cancel = num(el, "cancel");
  if (cancel !== undefined) k.cancel = cancel;
  const mode = childText(el, "mode");
  if (mode) k.mode = mode;
  const steps = children(el, "key-step");
  const alters = children(el, "key-alter");
  if (steps.length) {
    k.explicitAccidentals = steps.map((s, i) => ({
      step: s.textContent ?? "",
      alter: Number(alters[i]?.textContent ?? 0),
    }));
  }
  void KNOWN_KEY;
  return k;
}

function readTime(el: Element): Time {
  const t: Time = {
    beats: num(el, "beats") ?? 4,
    beatType: num(el, "beat-type") ?? 4,
  };
  const sym = el.getAttribute("symbol");
  if (sym) t.symbol = sym;
  return t;
}

function readClef(el: Element): Clef {
  const c: Clef = { sign: (childText(el, "sign") ?? "G") as Clef["sign"] };
  const line = num(el, "line");
  if (line !== undefined) c.line = line;
  const oc = num(el, "clef-octave-change");
  if (oc !== undefined) c.octaveChange = oc;
  const n = el.getAttribute("number");
  if (n) c.staff = Number(n);
  return c;
}

function readTranspose(el: Element): Transpose {
  const t: Transpose = { chromatic: num(el, "chromatic") ?? 0 };
  const d = num(el, "diatonic");
  if (d !== undefined) t.diatonic = d;
  const o = num(el, "octave-change");
  if (o !== undefined) t.octaveChange = o;
  return t;
}

function readDefaults(el: Element): Defaults {
  const d: Defaults = {};
  const sc = child(el, "scaling");
  if (sc) {
    d.scaling = {
      millimeters: num(sc, "millimeters") ?? 7,
      tenths: num(sc, "tenths") ?? 40,
    };
  }
  const pl = child(el, "page-layout");
  if (pl) {
    const page: NonNullable<Defaults["pageLayout"]> = {};
    const w = num(pl, "page-width");
    const h = num(pl, "page-height");
    if (w !== undefined) page.pageWidth = w;
    if (h !== undefined) page.pageHeight = h;
    const margins = children(pl, "page-margins").map((mg) => {
      const out: NonNullable<NonNullable<Defaults["pageLayout"]>["margins"]>[number] = {
        left: num(mg, "left-margin") ?? 0,
        right: num(mg, "right-margin") ?? 0,
        top: num(mg, "top-margin") ?? 0,
        bottom: num(mg, "bottom-margin") ?? 0,
      };
      const t = mg.getAttribute("type");
      if (t === "odd" || t === "even" || t === "both") out.oddEven = t;
      return out;
    });
    if (margins.length) page.margins = margins;
    d.pageLayout = page;
  }
  const sl = child(el, "system-layout");
  if (sl) {
    const sys: NonNullable<Defaults["systemLayout"]> = {};
    const sd = num(sl, "system-distance");
    const td = num(sl, "top-system-distance");
    if (sd !== undefined) sys.systemDistance = sd;
    if (td !== undefined) sys.topSystemDistance = td;
    const mg = child(sl, "system-margins");
    if (mg) {
      const lm = num(mg, "left-margin");
      const rm = num(mg, "right-margin");
      if (lm !== undefined) sys.leftMargin = lm;
      if (rm !== undefined) sys.rightMargin = rm;
    }
    d.systemLayout = sys;
  }
  const stl = child(el, "staff-layout");
  if (stl) {
    const sd = num(stl, "staff-distance");
    if (sd !== undefined) d.staffLayout = { staffDistance: sd };
  }
  const lf = child(el, "lyric-font");
  if (lf) d.lyricFont = readFont(lf);
  const wf = child(el, "word-font");
  if (wf) d.wordFont = readFont(wf);
  return d;
}

/** `font-family` / `font-size` / `font-weight` 三个属性；一个都没有时也返回空对象（元素本身在就要留） */
function readFont(el: Element): FontSpec {
  const f: FontSpec = {};
  const fam = el.getAttribute("font-family");
  if (fam !== null) f.family = fam;
  const size = attrNum(el, "font-size");
  if (size !== undefined) f.size = size;
  const w = el.getAttribute("font-weight");
  if (w !== null) f.weight = w;
  const st = el.getAttribute("font-style");
  if (st !== null) f.style = st;
  return f;
}

/** 同 `readFont`，但三个属性都没有时返回 `undefined`（文字元素上不留空对象） */
function readFontAttrs(el: Element): FontSpec | undefined {
  const f = readFont(el);
  return Object.keys(f).length ? f : undefined;
}

function readCredits(root: Element): Credit[] {
  const out: Credit[] = [];
  for (const c of children(root, "credit")) {
    const words = children(c, "credit-words");
    if (words.length === 0) continue;
    const cr: Credit = { text: words.map((w) => w.textContent ?? "").join("\n") };
    if (words.some((w) => (w.textContent ?? "").includes("\n"))) cr.words = words.map((w) => w.textContent ?? "");
    const type = childText(c, "credit-type");
    if (type) cr.type = type;
    const first = words[0]!;
    const x = first.getAttribute("default-x");
    const y = first.getAttribute("default-y");
    const fs = first.getAttribute("font-size");
    if (x) cr.x = Number(x);
    if (y) cr.y = Number(y);
    if (fs) cr.fontSize = Number(fs);
    const just = readAlign(first, "justify");
    if (just) cr.justify = just;
    const ha = readAlign(first, "halign");
    if (ha) cr.halign = ha;
    const page = c.getAttribute("page");
    if (page) cr.page = Number(page);
    out.push(cr);
  }
  return out;
}

function readPartGroups(partList: Element): { groups: PartGroup[]; names: Map<string, { name?: string; abbrev?: string }> } {
  const groups: PartGroup[] = [];
  const names = new Map<string, { name?: string; abbrev?: string }>();
  const open: PartGroup[] = [];
  for (const c of Array.from(partList.children)) {
    if (c.tagName === "part-group") {
      const type = c.getAttribute("type");
      const number = c.getAttribute("number") ?? "1";
      if (type === "start") {
        const g: PartGroup = { number, parts: [] };
        const sym = childText(c, "group-symbol");
        if (sym) g.symbol = sym as PartGroup["symbol"];
        const nm = childText(c, "group-name");
        if (nm) g.name = nm;
        const ab = childText(c, "group-abbreviation");
        if (ab) g.abbrev = ab;
        if (childText(c, "group-barline") === "yes") g.groupBarline = true;
        open.push(g);
        groups.push(g);
      } else {
        const i = open.findIndex((g) => g.number === number);
        if (i >= 0) open.splice(i, 1);
      }
    } else if (c.tagName === "score-part") {
      const id = c.getAttribute("id") ?? "";
      const nm = childText(c, "part-name") ?? undefined;
      const ab = childText(c, "part-abbreviation") ?? undefined;
      names.set(id, { name: nm, abbrev: ab });
      for (const g of open) g.parts.push(id);
    }
  }
  return { groups, names };
}

// ───────────────────────── 音符 ─────────────────────────

function readPitch(el: Element): Pitch {
  return {
    step: (childText(el, "step") ?? "C") as Pitch["step"],
    alter: num(el, "alter") ?? 0,
    octave: num(el, "octave") ?? 4,
  };
}

function readHarmony(el: Element): Harmony {
  const rootEl = child(el, "root");
  const kindEl = child(el, "kind");
  const h: Harmony = {
    root: {
      step: rootEl ? childText(rootEl, "root-step") ?? "C" : "C",
      alter: rootEl ? num(rootEl, "root-alter") ?? 0 : 0,
    },
    kind: kindEl?.textContent ?? "",
  };
  const kt = kindEl?.getAttribute("text");
  // `text=""` 是「不印 kind 后缀」，与缺省不同（混排按 null / "" 分），空串也要留
  if (kt !== null && kt !== undefined) h.kindText = kt;
  const kh = kindEl ? readAlign(kindEl, "halign") : undefined;
  if (kh) h.kindHalign = kh;
  const pos = readPos(el);
  if (pos) h.pos = pos;
  const bassEl = child(el, "bass");
  if (bassEl) {
    h.bass = {
      step: childText(bassEl, "bass-step") ?? "C",
      alter: num(bassEl, "bass-alter") ?? 0,
    };
  }
  const degs = children(el, "degree");
  if (degs.length) {
    h.degrees = degs.map((d) => ({
      value: num(d, "degree-value") ?? 0,
      alter: num(d, "degree-alter") ?? 0,
      type: (childText(d, "degree-type") ?? "add") as "add" | "alter" | "subtract",
    }));
  }
  const offset = num(el, "offset");
  if (offset !== undefined) h.offset = offset;
  if (kindEl?.getAttribute("use-symbols") === "yes") h.useSymbols = true;
  if (kindEl?.getAttribute("parentheses-degrees") === "yes") h.parenthesesDegrees = true;
  const st = attrNum(el, "staff");
  if (st !== undefined) h.staff = st;
  return h;
}

function readLyrics(noteEl: Element): Lyric[] {
  const out: Lyric[] = [];
  for (const l of children(noteEl, "lyric")) {
    const text = children(l, "text").map((t) => t.textContent ?? "").join("");
    const n = l.getAttribute("number");
    const lr: Lyric = { number: n ? Number(n.replace(/[^\d]/g, "")) || 1 : 1, text };
    if (n !== null && !/^\d+$/.test(n)) lr.numberText = n;
    const name = l.getAttribute("name");
    if (name !== null) lr.name = name;
    const syl = childText(l, "syllabic");
    if (syl) lr.syllabic = syl as Lyric["syllabic"];
    const ext = child(l, "extend");
    if (ext) {
      lr.extend = true;
      const et = ext.getAttribute("type");
      if (et === "start" || et === "stop" || et === "continue") lr.extendType = et;
    }
    const el2 = childText(l, "elision");
    if (el2 !== null) lr.elision = el2;
    const pos = readPos(l);
    if (pos) lr.pos = pos;
    const just = readAlign(l, "justify");
    if (just) lr.justify = just;
    out.push(lr);
  }
  return out;
}

/** `<notations>` 读进 `into`（和弦音的记号并进同一个 `Chord`：语料 14 份的 slur 起止写在和弦音上）。 */
function readNotations(noteEl: Element, marks: MarkSink, id: number, into: Notations | undefined, noteIndex = 0): Notations | undefined {
  const nots = child(noteEl, "notations");
  if (!nots) return into;
  const n: Notations = into ?? {};
  const art = child(nots, "articulations");
  if (art) {
    const list = Array.from(art.children).map((c) => c.tagName);
    if (list.length) n.articulations = list;
  }
  const orn = child(nots, "ornaments");
  if (orn) {
    const list = Array.from(orn.children).map((c) => c.tagName);
    if (list.length) n.ornaments = list;
  }
  const tech = child(nots, "technical");
  if (tech) {
    const list = Array.from(tech.children).map((c) => c.tagName);
    if (list.length) n.technical = list;
  }
  const fer = child(nots, "fermata");
  if (fer) {
    n.fermata = true;
    if (fer.getAttribute("type") === "inverted") n.fermataInverted = true;
  }
  if (child(nots, "arpeggiate")) n.arpeggiate = true;
  if (child(nots, "glissando")) n.glissando = true;
  // 跨元素记号：slur / tied / tuplet，按 number 配对
  for (const tag of ["slur", "tied", "tuplet"] as const) {
    for (const s of children(nots, tag)) {
      const type = s.getAttribute("type");
      const number = Number(s.getAttribute("number") ?? 1);
      const kind = tag === "tuplet" ? "tuplet" : tag === "tied" ? "tied" : "slur";
      if (type === "start") marks.open(kind, number, id, s, noteIndex);
      else if (type === "stop") marks.close(kind, number, id, noteIndex);
    }
  }
  return Object.keys(n).length ? n : undefined;
}

/** 跨元素记号的配对池。MusicXML 用 `number` 属性配对，同类可重叠；**按声部配**（换声部时 `nextPart`）。
 *
 *  同一编号还没收口又起一个（原文出错，合唱谱 宁静的伯利恒 8 处）：slur / tuplet **后起点顶掉前起点**
 *  （与混排 musicpp 一致；按栈配会把落单的收口配给更早的起点，横跨几小节）。
 *  tied 仍按栈配：和弦里几个音同时 `<tied type="start"/>`（编号都缺省 1）是正常写法。 */
class MarkSink {
  readonly marks: Mark[] = [];
  private open_ = new Map<string, { id: number; el: Element; note: number }[]>();

  nextPart(): void {
    this.open_.clear();
  }

  open(type: Mark["type"], number: number, id: number, el: Element, note: number): void {
    const k = `${type}#${number}`;
    const list = type === "tied" ? this.open_.get(k) ?? [] : [];
    list.push({ id, el, note });
    this.open_.set(k, list);
  }

  close(type: Mark["type"], number: number, id: number, note: number): void {
    const k = `${type}#${number}`;
    const list = this.open_.get(k);
    const started = list?.pop();
    if (!started) return;
    const m: Mark = { type, number, start: started.id, end: id };
    if (started.note) m.startNote = started.note;
    if (note) m.endNote = note;
    const pl = started.el.getAttribute("placement");
    if (pl === "above" || pl === "below") m.placement = pl;
    const ori = started.el.getAttribute("orientation");
    if (ori === "over" || ori === "under") m.orientation = ori;
    const br = started.el.getAttribute("bracket");
    if (br === "yes" || br === "no") m.bracket = br === "yes";
    if (type === "tuplet") {
      const actual = num(child(started.el, "tuplet-actual"), "tuplet-number");
      const normal = num(child(started.el, "tuplet-normal"), "tuplet-number");
      if (actual !== undefined) m.tupletActual = actual;
      if (normal !== undefined) m.tupletNormal = normal;
    }
    this.marks.push(m);
  }
}

// ───────────────────────── 小节 ─────────────────────────

const BAR_STYLE_MAP: Readonly<Record<string, string>> = {
  regular: "regular",
  dotted: "dotted",
  dashed: "dashed",
  heavy: "heavy",
  "light-light": "light-light",
  "light-heavy": "light-heavy",
  "heavy-light": "heavy-light",
  "heavy-heavy": "heavy-heavy",
  tick: "tick",
  short: "short",
  none: "none",
};

function readBarline(el: Element, elementCount: number): Barline {
  const loc = el.getAttribute("location");
  const b: Barline = {
    location: loc === "left" ? "left" : loc === "middle" ? "middle" : "right",
  };
  const style = childText(el, "bar-style");
  if (style && BAR_STYLE_MAP[style]) b.style = BAR_STYLE_MAP[style] as Barline["style"];
  const rep = child(el, "repeat");
  if (rep) {
    const dir = rep.getAttribute("direction");
    if (dir === "forward" || dir === "backward") b.repeat = dir;
    const times = rep.getAttribute("times");
    if (times) b.repeatTimes = Number(times);
  }
  const end = child(el, "ending");
  if (end) {
    const t = end.getAttribute("type");
    b.ending = {
      numbers: (end.getAttribute("number") ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
      type: t === "start" ? "start" : t === "discontinue" ? "discontinue" : "stop",
      text: end.textContent?.trim() || undefined,
    };
    if (end.getAttribute("print-object") === "no") b.ending.printObject = false;
  }
  if (b.location === "middle") b.afterElements = elementCount;
  return b;
}

function readDirection(el: Element): Direction | null {
  const items = children(el, "direction-type").flatMap((dt) => Array.from(dt.children));
  const first = items[0];
  if (!first) return null;
  const d: Direction = readDirectionPart(first);
  const offset = num(el, "offset");
  if (offset !== undefined) d.offset = offset;
  const pl = el.getAttribute("placement");
  if (pl === "above" || pl === "below") d.placement = pl;
  const st = num(el, "staff");
  if (st !== undefined) d.staff = st;
  if (items.length > 1) d.more = items.slice(1).map(readDirectionPart);
  const sound = child(el, "sound");
  if (sound) {
    const s = readSound(sound);
    if (s) d.sound = s;
  }
  return d;
}

/** `<direction-type>` 下的一个子元素（words / dynamics / wedge…）。 */
function readDirectionPart(first: Element): DirectionPart {
  const d: DirectionPart = { type: first.tagName };
  const pos = readPos(first);
  if (pos) d.pos = pos;
  const just = readAlign(first, "justify");
  if (just) d.justify = just;
  const ha = readAlign(first, "halign");
  if (ha) d.halign = ha;
  const va = first.getAttribute("valign");
  if (va) d.valign = va;
  const font = readFontAttrs(first);
  if (font) d.font = font;
  switch (first.tagName) {
    case "dynamics":
      d.text = first.firstElementChild?.tagName ?? "";
      break;
    case "words":
    case "rehearsal":
      d.text = first.textContent ?? "";
      break;
    case "wedge": {
      const t = first.getAttribute("type");
      if (t === "crescendo" || t === "diminuendo") d.wedgeType = t;
      d.spanType = t === "stop" ? "stop" : t === "continue" ? "continue" : "start";
      break;
    }
    case "metronome": {
      const bu = childText(first, "beat-unit");
      const pm = num(first, "per-minute");
      d.tempo = {};
      if (bu) d.tempo.beatUnit = bu as NoteType;
      if (pm !== undefined) d.tempo.perMinute = pm;
      const pmText = childText(first, "per-minute");
      if (pmText !== null && (pm === undefined || String(pm) !== pmText.trim())) d.tempo.perMinuteText = pmText;
      break;
    }
    case "pedal":
    case "octave-shift": {
      const t = first.getAttribute("type");
      d.spanType = t === "stop" ? "stop" : t === "continue" ? "continue" : "start";
      if (first.tagName === "pedal" && first.getAttribute("line") !== null) d.line = first.getAttribute("line") === "yes";
      break;
    }
    default:
      break;
  }
  return d;
}

/** `<sound>` 的播放语义（`<direction>` 里的与小节级的同一套）。 */
function readSound(sound: Element): Direction["sound"] {
  {
    const s: NonNullable<Direction["sound"]> = {};
    if (sound.getAttribute("dacapo") === "yes") s.dacapo = true;
    const ds = sound.getAttribute("dalsegno");
    if (ds) s.dalsegno = ds;
    if (sound.getAttribute("fine")) s.fine = true;
    const sg = sound.getAttribute("segno");
    if (sg) s.segno = sg;
    const cd = sound.getAttribute("coda");
    if (cd) s.coda = cd;
    const tc = sound.getAttribute("tocoda");
    if (tc) s.tocoda = tc;
    const tp = sound.getAttribute("tempo");
    if (tp) s.tempo = Number(tp);
    return Object.keys(s).length ? s : undefined;
  }
}

function readPrint(el: Element): Print | undefined {
  const p: Print = {};
  if (el.getAttribute("new-system") === "yes") p.newSystem = true;
  if (el.getAttribute("new-page") === "yes") p.newPage = true;
  const sl = child(el, "system-layout");
  if (sl) {
    const sys: NonNullable<Print["systemLayout"]> = {};
    const sd = num(sl, "system-distance");
    const td = num(sl, "top-system-distance");
    if (sd !== undefined) sys.systemDistance = sd;
    if (td !== undefined) sys.topSystemDistance = td;
    const mg = child(sl, "system-margins");
    if (mg) {
      const lm = num(mg, "left-margin");
      const rm = num(mg, "right-margin");
      if (lm !== undefined) sys.leftMargin = lm;
      if (rm !== undefined) sys.rightMargin = rm;
    }
    if (Object.keys(sys).length) p.systemLayout = sys;
  }
  const staffLayouts = children(el, "staff-layout").map((s) => {
    const out: NonNullable<Print["staffLayouts"]>[number] = {};
    const n = attrNum(s, "number");
    if (n !== undefined) out.staff = n;
    const sd = num(s, "staff-distance");
    if (sd !== undefined) out.staffDistance = sd;
    return out;
  });
  if (staffLayouts.length) p.staffLayouts = staffLayouts;
  const mn = child(el, "measure-numbering");
  if (mn?.textContent) p.measureNumbering = mn.textContent;
  return Object.keys(p).length ? p : undefined;
}

const KNOWN_MEASURE_CHILDREN = [
  "attributes", "note", "backup", "forward", "barline", "direction", "harmony", "print", "sound",
];

/** 一个 `<measure>` → `Measure`。`<backup>`/`<forward>` 按声部分轨，解析后消失。 */
function readMeasure(
  el: Element,
  ids: IdGen,
  marks: MarkSink,
): Measure {
  const m: Measure = { number: el.getAttribute("number") ?? "", elements: [] };
  const width = attrNum(el, "width");
  if (width !== undefined) m.width = width;
  if (el.getAttribute("implicit") === "yes") m.implicit = true;
  /** 和弦符号先攒着，挂到它后面第一个元素上（MusicXML 的 `<harmony>` 在音符之前）。
   *  一个长音中途换和弦时音符前会连着好几个（后面的带 offset），**全留着**——只留最后一个会丢和弦 */
  let pendingHarmonies: Harmony[] = [];
  /** `<chord>` 标记的音要并进上一个 `Chord` */
  let last: Chord | null = null;
  /** 游标（divisions）：`<backup>` 退、`<forward>` 进、非和弦音进；`end` 是前一个元素的终点（`onset` 的缺省值） */
  let cursor = 0;
  let end = 0;
  /** 游标到过的最远处与元素的最远终点：前者更远（`<forward>` 撑出空拍）才记 `Measure.duration` */
  let reach = 0;
  let maxEnd = 0;
  /** 和弦符号读到时的游标（与所挂元素的起点不同才记 `onset`） */
  let pendingOnsets: number[] = [];

  for (const c of Array.from(el.children)) {
    switch (c.tagName) {
      case "backup":
        cursor = Math.max(0, cursor - (num(c, "duration") ?? 0));
        break;
      case "forward":
        cursor += num(c, "duration") ?? 0;
        reach = Math.max(reach, cursor);
        break;
      case "attributes": {
        const a: MeasureAttrs = {};
        const div = num(c, "divisions");
        if (div !== undefined) a.divisions = div;
        const k = child(c, "key");
        if (k) a.key = readKey(k);
        const t = child(c, "time");
        if (t) a.time = readTime(t);
        const clefs = children(c, "clef");
        if (clefs.length) a.clefs = clefs.map(readClef);
        const staves = num(c, "staves");
        if (staves !== undefined) a.staves = staves;
        const tr = child(c, "transpose");
        if (tr) a.transpose = readTranspose(tr);
        const details = children(c, "staff-details");
        if (details.length) {
          a.staffDetails = details.map((sd) => {
            const out: NonNullable<MeasureAttrs["staffDetails"]>[number] = {};
            const n = sd.getAttribute("number");
            if (n) out.staff = Number(n);
            const po = sd.getAttribute("print-object");
            if (po) out.printObject = po !== "no";
            return out;
          });
        }
        if (m.elements.length === 0) m.attrs = { ...(m.attrs ?? {}), ...a };
        else {
          const later: NonNullable<Measure["laterAttrs"]>[number] = { afterElements: m.elements.length, attrs: a };
          if (cursor !== end) later.onset = cursor;
          (m.laterAttrs ??= []).push(later);
        }
        break;
      }
      case "harmony":
        pendingHarmonies.push(readHarmony(c));
        pendingOnsets.push(cursor);
        break;
      case "print": {
        const p = readPrint(c);
        if (p) m.print = { ...(m.print ?? {}), ...p };
        break;
      }
      case "direction": {
        const d = readDirection(c);
        if (d && m.elements.length > 0) d.afterElements = m.elements.length;
        if (d && cursor !== end) d.onset = cursor;
        if (d) (m.directions ??= []).push(d);
        break;
      }
      case "sound": {
        // 小节级 `<sound>`（不在 `<direction>` 里）：语料 568 份都用它记曲首速度。原文留着，写回逐字节
        const d: Direction = { type: "sound", xml: serializeDedented(c) };
        const s = readSound(c);
        if (s) d.sound = s;
        if (m.elements.length > 0) d.afterElements = m.elements.length;
        (m.directions ??= []).push(d);
        break;
      }
      case "barline":
        (m.barlines ??= []).push(readBarline(c, m.elements.length));
        break;
      case "note": {
        const isChordNote = child(c, "chord") !== null;
        const pitchEl = child(c, "pitch");
        const note: Note = {};
        if (pitchEl) {
          note.pitch = readPitch(pitchEl);
        }
        const accEl = child(c, "accidental");
        const acc = accEl?.textContent;
        if (acc) note.accidental = acc as Note["accidental"];
        if (accEl?.getAttribute("parentheses") === "yes") note.accidentalParentheses = true;
        const nh = childText(c, "notehead");
        if (nh) note.notehead = nh;
        const tie = children(c, "tie");
        if (tie.length) {
          note.tie = {};
          for (const t of tie) {
            if (t.getAttribute("type") === "start") note.tie.start = true;
            if (t.getAttribute("type") === "stop") note.tie.stop = true;
          }
        }
        const notePos = readPos(c);
        const stemEl = child(c, "stem");
        if (pitchEl) {
          if (notePos) note.pos = notePos;
          if (stemEl) {
            const dir = stemEl.textContent?.trim();
            if (dir === "up" || dir === "down" || dir === "none" || dir === "double") note.stem = dir;
            const sy = attrNum(stemEl, "default-y");
            if (sy !== undefined) note.stemY = sy;
          }
        }
        if (isChordNote && last) {
          last.notes.push(note);
          const nots = readNotations(c, marks, last.id, last.notations, last.notes.length - 1);
          if (nots) last.notations = nots;
          break;
        }
        const ch: Chord = {
          kind: "chord",
          id: ids.next(),
          notes: pitchEl ? [note] : [],
          duration: {
            divisions: num(c, "duration") ?? 0,
            dots: children(c, "dot").length,
          },
          voice: num(c, "voice") ?? 1,
          staff: num(c, "staff") ?? 1,
        };
        if (!pitchEl && notePos) ch.pos = notePos;
        if (child(c, "cue")) ch.cue = true;
        const type = childText(c, "type");
        if (type) ch.duration.type = type as NoteType;
        const typeSize = child(c, "type")?.getAttribute("size");
        if (typeSize) ch.typeSize = typeSize;
        const tm = child(c, "time-modification");
        if (tm) {
          ch.duration.timeMod = {
            actual: num(tm, "actual-notes") ?? 3,
            normal: num(tm, "normal-notes") ?? 2,
          };
        }
        const restEl = child(c, "rest");
        if (restEl) {
          ch.rest = {};
          if (restEl.getAttribute("measure") === "yes") ch.rest.measure = true;
          const ds = childText(restEl, "display-step");
          if (ds) {
            ch.rest.displayPitch = {
              step: ds as Pitch["step"],
              alter: 0,
              octave: num(restEl, "display-octave") ?? 4,
            };
          }
        }
        const graceEl = child(c, "grace");
        if (graceEl) {
          ch.grace = {};
          if (graceEl.getAttribute("slash") === "yes") ch.grace.slash = true;
        }
        if (c.getAttribute("print-object") === "no") ch.printObject = false;
        const beams = children(c, "beam");
        if (beams.length) {
          ch.beams = beams.map((b) => (b.textContent ?? "continue") as NonNullable<Chord["beams"]>[number]);
        }
        const lyr = readLyrics(c);
        if (lyr.length) ch.lyrics = lyr;
        const nots = readNotations(c, marks, ch.id, undefined);
        if (nots) ch.notations = nots;
        if (cursor !== end) ch.onset = cursor;
        if (pendingHarmonies.length) {
          pendingHarmonies.forEach((h, i) => {
            if (pendingOnsets[i] !== cursor) h.onset = pendingOnsets[i];
          });
          const [first, ...later] = pendingHarmonies;
          ch.harmony = first;
          if (later.length) ch.laterHarmonies = later;
          pendingHarmonies = [];
          pendingOnsets = [];
        }
        m.elements.push(ch);
        last = ch;
        cursor += ch.duration.divisions;
        end = cursor;
        reach = Math.max(reach, cursor);
        maxEnd = Math.max(maxEnd, cursor);
        break;
      }
      default:
        break;
    }
  }
  // **小节末尾还欠着一个和弦**：那是给下一小节的预置和弦（常带 `<offset>` 负值），
  // 后面没有音符可挂。`ScoreDoc` 的 `y` 占位符就是为这种「和弦完全没有对位音符」设的
  // （规范 §8.1，语料实测 72 次）——丢了它，往返一轮就少一个 `<harmony>`。
  pendingHarmonies.forEach((harmony, i) => {
    const sp: Space = {
      kind: "space",
      id: ids.next(),
      spacer: "y",
      voice: 1,
      staff: 1,
      harmony,
    };
    if (pendingOnsets[i] !== end) sp.onset = pendingOnsets[i];
    m.elements.push(sp);
  });
  if (reach > maxEnd) m.duration = reach;
  const raw = rawOf(el, KNOWN_MEASURE_CHILDREN);
  if (raw) m.raw = raw;
  return m;
}

// ───────────────────────── 入口 ─────────────────────────

/** MusicXML 文本 → `ScoreDoc`。**读得全**是全量重写不丢东西的前提，
 *  读不懂的子节点挂在最近的 `raw` 上，由 `toxml.ts` 原位吐回去。 */
export function loadScoreDoc(xmlText: string): ScoreDoc {
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  if (dom.querySelector("parsererror")) throw new Error("MusicXML 无法解析");
  const root = dom.documentElement;
  const doc = emptyDoc("musicxml");
  doc.source = xmlText;
  const song: Song = emptySong();
  const ids = new IdGen();
  const marks = new MarkSink();

  // work / movement
  const work = child(root, "work");
  if (work) {
    const n = childText(work, "work-number");
    const t = childText(work, "work-title");
    if (n) song.work.number = n;
    if (t) song.work.title = t;
  }
  const mt = childText(root, "movement-title");
  if (mt) {
    song.work.movementTitle = mt;
    if (song.work.title === undefined) song.work.title = mt;
  }

  // identification
  const ident = child(root, "identification");
  if (ident) {
    const creators = children(ident, "creator").map((c) => ({
      type: c.getAttribute("type") ?? "composer",
      text: c.textContent ?? "",
    }));
    song.identification = { creators };
    const rights = childText(ident, "rights");
    if (rights) song.identification.rights = rights;
    const enc = child(ident, "encoding");
    const sw = enc ? children(enc, "software").map((s) => s.textContent ?? "") : [];
    if (sw.length) song.identification.software = sw;
  }

  const credits = readCredits(root);
  if (credits.length) song.credits = credits;

  const defaultsEl = child(root, "defaults");
  if (defaultsEl) song.defaults = readDefaults(defaultsEl);

  const partList = child(root, "part-list");
  const { groups, names } = partList
    ? readPartGroups(partList)
    : { groups: [], names: new Map<string, { name?: string; abbrev?: string }>() };
  if (groups.length) song.partGroups = groups;

  for (const p of children(root, "part")) {
    const id = p.getAttribute("id") ?? "";
    const part: Part = { id, measures: [] };
    marks.nextPart();
    const nm = names.get(id);
    if (nm?.name) part.name = nm.name;
    if (nm?.abbrev) part.abbrev = nm.abbrev;
    let staves: number | undefined;
    for (const mEl of children(p, "measure")) {
      const m = readMeasure(mEl, ids, marks);
      if (m.attrs?.staves !== undefined) staves = m.attrs.staves;
      part.measures.push(m);
    }
    if (staves !== undefined) part.staffCount = staves;
    song.parts.push(part);
  }

  // 全曲共用的调号/拍号：取第一个声部第一次出现的那个
  const first = song.parts[0]?.measures.find((m) => m.attrs?.key || m.attrs?.time);
  if (first?.attrs?.key) song.key = first.attrs.key;
  if (first?.attrs?.time) song.time = first.attrs.time;
  // 简谱度数与面上的临时记号：整个声部读完再按小节内延续规则算（简谱语义层 `jianpu.ts::assignDegrees`）
  for (const part of song.parts) assignDegrees(part, song.key ?? { fifths: 0 });

  song.marks = marks.marks;
  doc.songs.push(song);
  return doc;
}

export type { DocElement };
