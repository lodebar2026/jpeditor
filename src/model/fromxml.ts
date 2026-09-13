// MusicXML → `ScoreDoc`（**直通**，不经 `Score` 也不经 `MixedScore`）。
//
// ## 为什么要直通
//
// 以前两条路各有各的损失：`loadMusicXml → Score` 丢和弦、力度、多声部；
// `loadMixedXml → MixedScore` 把语义与排版（tenths）混在一起。而 `ScoreDoc` 两样都装得下，
// 所以 MusicXML 该直接读进它。
//
// ## 读不懂的怎么办：`raw` 原样留着
//
// 保存策略是「模型未改动 → 原样写回；改动过 → **全量重写**」（见 `docs/待办.md` §1 机制 A）。
// 全量重写不丢东西，靠的不是 patch，而是**读得全 + 读不懂的原样留着**：
// 凡本文件不认识的子节点，序列化成字符串挂到最近的 `raw` 上，`toxml.ts` 原位吐回去。
//
// 字段清单以 `src/mixed/loader.ts`（项目里覆盖最全的 MusicXML 读取，88 个元素）为基准。
//
// **要 DOM**（`DOMParser`），所以只能在浏览器里跑；Node 侧的脚本走 `harness.mjs` 起页面。

import type {
  Barline,
  Chord,
  Clef,
  Credit,
  Defaults,
  Direction,
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
    const mg = child(pl, "page-margins");
    if (mg) {
      page.margins = {
        left: num(mg, "left-margin") ?? 0,
        right: num(mg, "right-margin") ?? 0,
        top: num(mg, "top-margin") ?? 0,
        bottom: num(mg, "bottom-margin") ?? 0,
      };
      const t = mg.getAttribute("type");
      if (t === "odd" || t === "even" || t === "both") page.margins.oddEven = t;
    }
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
  return d;
}

function readCredits(root: Element): Credit[] {
  const out: Credit[] = [];
  for (const c of children(root, "credit")) {
    const words = children(c, "credit-words");
    if (words.length === 0) continue;
    const cr: Credit = { text: words.map((w) => w.textContent ?? "").join("\n") };
    const type = childText(c, "credit-type");
    if (type) cr.type = type;
    const first = words[0]!;
    const x = first.getAttribute("default-x");
    const y = first.getAttribute("default-y");
    const fs = first.getAttribute("font-size");
    const ha = first.getAttribute("justify") ?? first.getAttribute("halign");
    if (x) cr.x = Number(x);
    if (y) cr.y = Number(y);
    if (fs) cr.fontSize = Number(fs);
    if (ha === "left" || ha === "center" || ha === "right") cr.justify = ha;
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
  return h;
}

function readLyrics(noteEl: Element): Lyric[] {
  const out: Lyric[] = [];
  for (const l of children(noteEl, "lyric")) {
    const text = children(l, "text").map((t) => t.textContent ?? "").join("");
    const n = l.getAttribute("number");
    const lr: Lyric = { number: n ? Number(n.replace(/[^\d]/g, "")) || 1 : 1, text };
    const syl = childText(l, "syllabic");
    if (syl) lr.syllabic = syl as Lyric["syllabic"];
    if (child(l, "extend")) lr.extend = true;
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

function readNotations(noteEl: Element, marks: MarkSink, id: number): Notations | undefined {
  const nots = child(noteEl, "notations");
  if (!nots) return undefined;
  const n: Notations = {};
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
  if (child(nots, "fermata")) n.fermata = true;
  if (child(nots, "arpeggiate")) n.arpeggiate = true;
  if (child(nots, "glissando")) n.glissando = true;
  // 跨元素记号：slur / tied / tuplet，按 number 配对
  for (const tag of ["slur", "tied", "tuplet"] as const) {
    for (const s of children(nots, tag)) {
      const type = s.getAttribute("type");
      const number = Number(s.getAttribute("number") ?? 1);
      const kind = tag === "tuplet" ? "tuplet" : tag === "tied" ? "tied" : "slur";
      if (type === "start") marks.open(kind, number, id, s);
      else if (type === "stop") marks.close(kind, number, id);
    }
  }
  return Object.keys(n).length ? n : undefined;
}

/** 跨元素记号的配对池。MusicXML 用 `number` 属性配对，同类可重叠。 */
class MarkSink {
  readonly marks: Mark[] = [];
  private open_ = new Map<string, { id: number; el: Element }[]>();

  open(type: Mark["type"], number: number, id: number, el: Element): void {
    const k = `${type}#${number}`;
    const list = this.open_.get(k) ?? [];
    list.push({ id, el });
    this.open_.set(k, list);
  }

  close(type: Mark["type"], number: number, id: number): void {
    const k = `${type}#${number}`;
    const list = this.open_.get(k);
    const started = list?.pop();
    if (!started) return;
    const m: Mark = { type, number, start: started.id, end: id };
    const pl = started.el.getAttribute("placement");
    if (pl === "above" || pl === "below") m.placement = pl;
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
  }
  if (b.location === "middle") b.afterElements = elementCount;
  return b;
}

function readDirection(el: Element): Direction | null {
  const dt = child(el, "direction-type");
  if (!dt) return null;
  const first = dt.firstElementChild;
  if (!first) return null;
  const d: Direction = { type: first.tagName };
  const offset = num(el, "offset");
  if (offset !== undefined) d.offset = offset;
  const pl = el.getAttribute("placement");
  if (pl === "above" || pl === "below") d.placement = pl;
  const st = el.getAttribute("staff");
  if (st) d.staff = Number(st);
  const pos = readPos(first);
  if (pos) d.pos = pos;
  const just = readAlign(first, "justify");
  if (just) d.justify = just;
  const ha = readAlign(first, "halign");
  if (ha) d.halign = ha;
  const va = first.getAttribute("valign");
  if (va) d.valign = va;
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
      break;
    }
    case "pedal":
    case "octave-shift": {
      const t = first.getAttribute("type");
      d.spanType = t === "stop" ? "stop" : t === "continue" ? "continue" : "start";
      break;
    }
    default:
      break;
  }
  const sound = child(el, "sound");
  if (sound) {
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
    if (Object.keys(s).length) d.sound = s;
  }
  return d;
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
    if (Object.keys(sys).length) p.systemLayout = sys;
  }
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

  for (const c of Array.from(el.children)) {
    switch (c.tagName) {
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
        m.attrs = { ...(m.attrs ?? {}), ...a };
        break;
      }
      case "harmony":
        pendingHarmonies.push(readHarmony(c));
        break;
      case "print": {
        const p = readPrint(c);
        if (p) m.print = { ...(m.print ?? {}), ...p };
        break;
      }
      case "direction": {
        const d = readDirection(c);
        if (d && m.elements.length > 0) d.afterElements = m.elements.length;
        if (d) (m.directions ??= []).push(d);
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
        const acc = childText(c, "accidental");
        if (acc) note.accidental = acc as Note["accidental"];
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
        const nots = readNotations(c, marks, ch.id);
        if (nots) ch.notations = nots;
        if (pendingHarmonies.length) {
          const [first, ...later] = pendingHarmonies;
          ch.harmony = first;
          if (later.length) ch.laterHarmonies = later;
          pendingHarmonies = [];
        }
        m.elements.push(ch);
        last = ch;
        break;
      }
      default:
        break;
    }
  }
  // **小节末尾还欠着一个和弦**：那是给下一小节的预置和弦（常带 `<offset>` 负值），
  // 后面没有音符可挂。`ScoreDoc` 的 `y` 占位符就是为这种「和弦完全没有对位音符」设的
  // （规范 §8.1，语料实测 72 次）——丢了它，往返一轮就少一个 `<harmony>`。
  for (const harmony of pendingHarmonies) {
    const sp: Space = {
      kind: "space",
      id: ids.next(),
      spacer: "y",
      voice: 1,
      staff: 1,
      harmony,
    };
    m.elements.push(sp);
  }
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
    const sw = enc ? childText(enc, "software") : null;
    if (sw) song.identification.encoding = sw;
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
