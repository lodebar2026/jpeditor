// `ScoreDoc` → MusicXML（**直通**，不经 `Score` 也不经 `PuDoc`）。与 `fromxml.ts` 互逆。
//
// ## 为什么敢全量重写
//
// 保存策略是「模型未改动 → 原样写回；改动过 → 全量重写」。以前不敢全量重写，是因为
// `Score` 装不下的东西（和弦、力度、多声部、`<print>` 行结构、`<credit>` 版式）
// 重生成一遍就没了，所以只能 patch。现在 `ScoreDoc` 装得下，**外加 `Measure.raw`
// 把读不懂的节点原样留着**，全量重写才成了安全的默认路径。
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
  Note,
  Part,
  Position,
  Print,
  ScoreDoc,
  Song,
  Time,
} from "./doc";
import { harmonyXml as chordTextXml } from "../score/harmonyxml";
import { projectForMusicXml } from "./xmlproject";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");

/** 一层缩进两格，与 MuseScore 的输出习惯一致。 */
const ind = (depth: number): string => "  ".repeat(depth);

class Out {
  private lines: string[] = [];
  push(depth: number, text: string): void {
    this.lines.push(ind(depth) + text);
  }
  /** 原样塞回一段已序列化的 XML（`raw`）。 */
  raw(depth: number, xml: string): void {
    for (const line of xml.split("\n")) this.lines.push(ind(depth) + line);
  }
  toString(): string {
    return this.lines.join("\n");
  }
}

/** 版面坐标 → 属性串（带前导空格；没有则空串）。见 `doc.ts::Position`。 */
function posAttrs(pos: Position | undefined): string {
  if (!pos) return "";
  const a: string[] = [];
  if (pos.defaultX !== undefined) a.push(`default-x="${pos.defaultX}"`);
  if (pos.defaultY !== undefined) a.push(`default-y="${pos.defaultY}"`);
  if (pos.relativeX !== undefined) a.push(`relative-x="${pos.relativeX}"`);
  if (pos.relativeY !== undefined) a.push(`relative-y="${pos.relativeY}"`);
  return a.length ? " " + a.join(" ") : "";
}

const tag = (name: string, text: string | number): string =>
  `<${name}>${typeof text === "string" ? esc(text) : text}</${name}>`;

/** 字体 → 属性串（带前导空格；没有则空串）。见 `doc.ts::FontSpec`。 */
function fontAttrs(f: FontSpec | undefined): string {
  if (!f) return "";
  const a: string[] = [];
  if (f.family !== undefined) a.push(`font-family="${escAttr(f.family)}"`);
  if (f.size !== undefined) a.push(`font-size="${f.size}"`);
  if (f.weight !== undefined) a.push(`font-weight="${escAttr(f.weight)}"`);
  return a.length ? " " + a.join(" ") : "";
}

// ───────────────────────── 头部 ─────────────────────────

function writeKey(o: Out, d: number, k: Key): void {
  o.push(d, "<key>");
  if (k.cancel !== undefined) o.push(d + 1, tag("cancel", k.cancel));
  o.push(d + 1, tag("fifths", k.fifths));
  if (k.mode) o.push(d + 1, tag("mode", k.mode));
  for (const a of k.explicitAccidentals ?? []) {
    o.push(d + 1, tag("key-step", a.step));
    o.push(d + 1, tag("key-alter", a.alter));
  }
  o.push(d, "</key>");
}

function writeTime(o: Out, d: number, t: Time): void {
  o.push(d, t.symbol ? `<time symbol="${escAttr(t.symbol)}">` : "<time>");
  o.push(d + 1, tag("beats", t.beats));
  o.push(d + 1, tag("beat-type", t.beatType));
  o.push(d, "</time>");
}

function writeDefaults(o: Out, d: number, def: Defaults): void {
  o.push(d, "<defaults>");
  if (def.scaling) {
    o.push(d + 1, "<scaling>");
    o.push(d + 2, tag("millimeters", def.scaling.millimeters));
    o.push(d + 2, tag("tenths", def.scaling.tenths));
    o.push(d + 1, "</scaling>");
  }
  const pl = def.pageLayout;
  if (pl) {
    o.push(d + 1, "<page-layout>");
    if (pl.pageHeight !== undefined) o.push(d + 2, tag("page-height", pl.pageHeight));
    if (pl.pageWidth !== undefined) o.push(d + 2, tag("page-width", pl.pageWidth));
    if (pl.margins) {
      const t = pl.margins.oddEven ?? "both";
      o.push(d + 2, `<page-margins type="${t}">`);
      o.push(d + 3, tag("left-margin", pl.margins.left));
      o.push(d + 3, tag("right-margin", pl.margins.right));
      o.push(d + 3, tag("top-margin", pl.margins.top));
      o.push(d + 3, tag("bottom-margin", pl.margins.bottom));
      o.push(d + 2, "</page-margins>");
    }
    o.push(d + 1, "</page-layout>");
  }
  const sl = def.systemLayout;
  if (sl) {
    o.push(d + 1, "<system-layout>");
    if (sl.leftMargin !== undefined || sl.rightMargin !== undefined) {
      o.push(d + 2, "<system-margins>");
      o.push(d + 3, tag("left-margin", sl.leftMargin ?? 0));
      o.push(d + 3, tag("right-margin", sl.rightMargin ?? 0));
      o.push(d + 2, "</system-margins>");
    }
    if (sl.systemDistance !== undefined) o.push(d + 2, tag("system-distance", sl.systemDistance));
    if (sl.topSystemDistance !== undefined) {
      o.push(d + 2, tag("top-system-distance", sl.topSystemDistance));
    }
    o.push(d + 1, "</system-layout>");
  }
  if (def.staffLayout?.staffDistance !== undefined) {
    o.push(d + 1, "<staff-layout>");
    o.push(d + 2, tag("staff-distance", def.staffLayout.staffDistance));
    o.push(d + 1, "</staff-layout>");
  }
  if (def.wordFont) o.push(d + 1, `<word-font${fontAttrs(def.wordFont)}/>`);
  if (def.lyricFont) o.push(d + 1, `<lyric-font${fontAttrs(def.lyricFont)}/>`);
  o.push(d, "</defaults>");
}

function writeCredit(o: Out, d: number, c: Credit): void {
  o.push(d, c.page ? `<credit page="${c.page}">` : '<credit page="1">');
  if (c.type) o.push(d + 1, tag("credit-type", c.type));
  const attrs: string[] = [];
  if (c.x !== undefined) attrs.push(`default-x="${c.x}"`);
  if (c.y !== undefined) attrs.push(`default-y="${c.y}"`);
  if (c.justify) attrs.push(`justify="${c.justify}"`);
  if (c.halign) attrs.push(`halign="${c.halign}"`);
  if (c.fontSize !== undefined) attrs.push(`font-size="${c.fontSize}"`);
  const a = attrs.length ? " " + attrs.join(" ") : "";
  for (const line of c.text.split("\n")) {
    o.push(d + 1, `<credit-words${a}>${esc(line)}</credit-words>`);
  }
  o.push(d, "</credit>");
}

// ───────────────────────── 音符 ─────────────────────────

function harmonyXml(o: Out, d: number, h: Harmony): void {
  // 简谱来源只有和弦原文（`"Cm7"`），结构交给和弦文字解析
  if (!h.kind && h.text) {
    o.push(d, chordTextXml(h.text, h.offset ?? 0));
    return;
  }
  o.push(d, `<harmony${posAttrs(h.pos)}${h.staff !== undefined ? ` staff="${h.staff}"` : ""}>`);
  o.push(d + 1, "<root>");
  o.push(d + 2, tag("root-step", h.root.step));
  if (h.root.alter) o.push(d + 2, tag("root-alter", h.root.alter));
  o.push(d + 1, "</root>");
  const kindAttrs =
    (h.kindText !== undefined ? ` text="${escAttr(h.kindText)}"` : "") + (h.kindHalign ? ` halign="${h.kindHalign}"` : "") +
    (h.useSymbols ? ' use-symbols="yes"' : "") + (h.parenthesesDegrees ? ' parentheses-degrees="yes"' : "");
  o.push(d + 1, `<kind${kindAttrs}>${esc(h.kind)}</kind>`);
  if (h.bass) {
    o.push(d + 1, "<bass>");
    o.push(d + 2, tag("bass-step", h.bass.step));
    if (h.bass.alter) o.push(d + 2, tag("bass-alter", h.bass.alter));
    o.push(d + 1, "</bass>");
  }
  for (const g of h.degrees ?? []) {
    o.push(d + 1, "<degree>");
    o.push(d + 2, tag("degree-value", g.value));
    o.push(d + 2, tag("degree-alter", g.alter));
    o.push(d + 2, tag("degree-type", g.type));
    o.push(d + 1, "</degree>");
  }
  if (h.offset) o.push(d + 1, tag("offset", h.offset));
  o.push(d, "</harmony>");
}

function lyricXml(o: Out, d: number, l: Lyric): void {
  const just = l.justify ? ` justify="${l.justify}"` : "";
  const number = l.numberText ?? (l.refrain ? "chorus" : String(l.number));
  const name = l.name !== undefined ? ` name="${escAttr(l.name)}"` : "";
  o.push(d, `<lyric number="${escAttr(number)}"${name}${posAttrs(l.pos)}${just}>`);
  if (l.syllabic) o.push(d + 1, tag("syllabic", l.syllabic));
  o.push(d + 1, tag("text", (l.leadingPunctuation ?? "") + l.text + (l.trailingPunctuation ?? "")));
  if (l.extend) o.push(d + 1, l.extendType ? `<extend type="${l.extendType}"/>` : "<extend/>");
  o.push(d, "</lyric>");
}

/** 一个音符元素上要挂的 `<notations>`（含跨元素记号的起止）。 */
function notationsXml(o: Out, d: number, n: Chord["notations"], starts: Mark[], stops: Mark[]): void {
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
  o.push(d, "<notations>");
  for (const m of starts) {
    const pl = m.placement ? ` placement="${m.placement}"` : "";
    if (m.type === "slur") {
      const ori = m.orientation ? ` orientation="${m.orientation}"` : "";
      o.push(d + 1, `<slur type="start" number="${m.number ?? 1}"${pl}${ori}/>`);
    } else if (m.type === "tied") o.push(d + 1, `<tied type="start" number="${m.number ?? 1}"/>`);
    else if (m.type === "tuplet") {
      const br = m.bracket !== undefined ? ` bracket="${m.bracket ? "yes" : "no"}"` : "";
      o.push(d + 1, `<tuplet type="start" number="${m.number ?? 1}"${br}${pl}/>`);
    }
  }
  for (const m of stops) {
    if (m.type === "slur") o.push(d + 1, `<slur type="stop" number="${m.number ?? 1}"/>`);
    else if (m.type === "tied") o.push(d + 1, `<tied type="stop" number="${m.number ?? 1}"/>`);
    else if (m.type === "tuplet") o.push(d + 1, `<tuplet type="stop" number="${m.number ?? 1}"/>`);
  }
  if (n?.fermata) o.push(d + 1, n.fermataInverted ? '<fermata type="inverted"/>' : "<fermata/>");
  if (n?.arpeggiate) o.push(d + 1, "<arpeggiate/>");
  if (n?.articulations?.length) {
    o.push(d + 1, "<articulations>");
    for (const a of n.articulations) o.push(d + 2, `<${a}/>`);
    o.push(d + 1, "</articulations>");
  }
  if (n?.ornaments?.length) {
    o.push(d + 1, "<ornaments>");
    for (const a of n.ornaments) o.push(d + 2, `<${a}/>`);
    o.push(d + 1, "</ornaments>");
  }
  if (n?.technical?.length) {
    o.push(d + 1, "<technical>");
    for (const a of n.technical) o.push(d + 2, `<${a}/>`);
    o.push(d + 1, "</technical>");
  }
  o.push(d, "</notations>");
}

/** 一个 `Chord` → 一条或多条 `<note>`（和弦音从第二个起带 `<chord/>`）。 */
function chordXml(o: Out, d: number, ch: Chord, starts: Mark[], stops: Mark[]): void {
  const writeOne = (note: Note | null, isChordNote: boolean, withNotations: boolean): void => {
    const attrs = posAttrs(note?.pos ?? ch.pos) + (ch.printObject === false ? ' print-object="no"' : "");
    o.push(d, `<note${attrs}>`);
    if (ch.grace) o.push(d + 1, ch.grace.slash ? '<grace slash="yes"/>' : "<grace/>");
    if (ch.cue) o.push(d + 1, "<cue/>");
    if (isChordNote) o.push(d + 1, "<chord/>");
    if (ch.rest) {
      if (ch.rest.measure) o.push(d + 1, '<rest measure="yes"/>');
      else o.push(d + 1, "<rest/>");
    } else if (note?.pitch) {
      o.push(d + 1, "<pitch>");
      o.push(d + 2, tag("step", note.pitch.step));
      if (note.pitch.alter) o.push(d + 2, tag("alter", note.pitch.alter));
      o.push(d + 2, tag("octave", note.pitch.octave));
      o.push(d + 1, "</pitch>");
    } else if (ch.rhythm) {
      // 节奏音符（有声无音高）：斜线符头
      o.push(d + 1, "<unpitched>");
      o.push(d + 2, tag("display-step", "B"));
      o.push(d + 2, tag("display-octave", 4));
      o.push(d + 1, "</unpitched>");
    } else {
      o.push(d + 1, "<rest/>");
    }
    // 倚音没有 duration（MusicXML 规定）
    if (!ch.grace) o.push(d + 1, tag("duration", Math.max(0, Math.round(ch.duration.divisions))));
    for (const t of [note?.tie?.start ? "start" : null, note?.tie?.stop ? "stop" : null]) {
      if (t) o.push(d + 1, `<tie type="${t}"/>`);
    }
    o.push(d + 1, tag("voice", ch.voice));
    if (ch.duration.type) {
      o.push(d + 1, ch.typeSize ? `<type size="${escAttr(ch.typeSize)}">${ch.duration.type}</type>` : tag("type", ch.duration.type));
    }
    for (let i = 0; i < ch.duration.dots; i++) o.push(d + 1, "<dot/>");
    if (note?.accidental) {
      o.push(d + 1, note.accidentalParentheses ? `<accidental parentheses="yes">${note.accidental}</accidental>` : tag("accidental", note.accidental));
    }
    if (ch.duration.timeMod) {
      o.push(d + 1, "<time-modification>");
      o.push(d + 2, tag("actual-notes", ch.duration.timeMod.actual));
      o.push(d + 2, tag("normal-notes", ch.duration.timeMod.normal));
      o.push(d + 1, "</time-modification>");
    }
    if (note?.stem) {
      const sy = note.stemY !== undefined ? ` default-y="${note.stemY}"` : "";
      o.push(d + 1, `<stem${sy}>${note.stem}</stem>`);
    }
    if (ch.rhythm && !isChordNote) o.push(d + 1, tag("notehead", "slash"));
    else if (note?.notehead) o.push(d + 1, tag("notehead", note.notehead));
    if (ch.staff > 1) o.push(d + 1, tag("staff", ch.staff));
    // number 是层号：按下标算，不能 indexOf（两层同为 begin 时会都写成 1）
    (ch.beams ?? []).forEach((b, i) => o.push(d + 1, `<beam number="${i + 1}">${esc(b)}</beam>`));
    // 跨元素记号挂回原来那个音（`Mark.startNote/endNote`），其余记号与歌词挂首音
    const idx = note ? ch.notes.indexOf(note) : 0;
    notationsXml(
      o,
      d + 1,
      withNotations ? ch.notations : undefined,
      starts.filter((m) => (m.startNote ?? 0) === idx || (idx === 0 && (m.startNote ?? 0) >= ch.notes.length)),
      stops.filter((m) => (m.endNote ?? 0) === idx || (idx === 0 && (m.endNote ?? 0) >= ch.notes.length)),
    );
    if (withNotations) for (const l of ch.lyrics ?? []) lyricXml(o, d + 1, l);
    o.push(d, "</note>");
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

function directionXml(o: Out, d: number, dir: Direction): void {
  if (dir.type === "sound") {
    // 小节级 `<sound>`：有原文给原文，没有（程序造的）按属性写
    if (dir.xml) o.raw(d, dir.xml);
    else if (dir.sound) o.push(d, `<sound${soundAttrs(dir.sound)}/>`);
    return;
  }
  const pl = dir.placement ? ` placement="${dir.placement}"` : "";
  o.push(d, `<direction${pl}>`);
  o.push(d + 1, "<direction-type>");
  directionPartXml(o, d + 2, dir);
  for (const part of dir.more ?? []) directionPartXml(o, d + 2, part);
  o.push(d + 1, "</direction-type>");
  if (dir.offset !== undefined) o.push(d + 1, tag("offset", dir.offset));
  if (dir.sound) {
    const a = soundAttrs(dir.sound);
    if (a) o.push(d + 1, `<sound${a}/>`);
  }
  if (dir.staff !== undefined && dir.staff > 1) o.push(d + 1, tag("staff", dir.staff));
  o.push(d, "</direction>");
}

/** `<direction-type>` 下的一个子元素。 */
function directionPartXml(o: Out, d: number, dir: DirectionPart): void {
  const lay =
    posAttrs(dir.pos) +
    (dir.justify ? ` justify="${dir.justify}"` : "") +
    (dir.halign ? ` halign="${dir.halign}"` : "") +
    (dir.valign ? ` valign="${escAttr(dir.valign)}"` : "") +
    fontAttrs(dir.font);
  switch (dir.type) {
    case "dynamics":
      o.push(d, `<dynamics${lay}><${dir.text || "mf"}/></dynamics>`);
      break;
    case "words":
    case "rehearsal":
      o.push(d, `<${dir.type}${lay}>${esc(dir.text ?? "")}</${dir.type}>`);
      break;
    case "wedge":
      o.push(d, `<wedge type="${dir.spanType === "stop" ? "stop" : dir.wedgeType ?? "crescendo"}"${posAttrs(dir.pos)}/>`);
      break;
    case "metronome":
      o.push(d, `<metronome${lay}>`);
      o.push(d + 1, tag("beat-unit", dir.tempo?.beatUnit ?? "quarter"));
      o.push(d + 1, tag("per-minute", dir.tempo?.perMinute ?? 90));
      o.push(d, "</metronome>");
      break;
    case "bracket":
      // 伴奏括弧（简谱来源才带起止）；MusicXML 读进来的没有 spanType，照旧写空元素
      if (dir.spanType) {
        o.push(d, `<bracket type="${dir.spanType}" line-end="down" line-type="solid"/>`);
      } else {
        o.push(d, "<bracket/>");
      }
      break;
    case "pedal":
    case "octave-shift": {
      const line = dir.line !== undefined ? ` line="${dir.line ? "yes" : "no"}"` : "";
      o.push(d, `<${dir.type} type="${dir.spanType ?? "start"}"${line}${posAttrs(dir.pos)}/>`);
      break;
    }
    default:
      o.push(d, `<${dir.type}${posAttrs(dir.pos)}/>`);
      break;
  }
}

function barlineXml(o: Out, d: number, b: Barline): void {
  o.push(d, `<barline location="${b.location === "middle" ? "middle" : b.location}">`);
  if (b.style) o.push(d + 1, tag("bar-style", b.style));
  if (b.ending) {
    const t = b.ending.type;
    const nums = b.ending.numbers.join(",");
    const po = b.ending.printObject === false ? ' print-object="no"' : "";
    o.push(d + 1, `<ending number="${nums}" type="${t}"${po}>${esc(b.ending.text ?? nums)}</ending>`);
  }
  if (b.repeat) {
    const times = b.repeatTimes && b.repeatTimes > 2 ? ` times="${b.repeatTimes}"` : "";
    o.push(d + 1, `<repeat direction="${b.repeat}"${times}/>`);
  }
  o.push(d, "</barline>");
}

function printXml(o: Out, d: number, p: Print): void {
  const a: string[] = [];
  if (p.newSystem) a.push('new-system="yes"');
  if (p.newPage) a.push('new-page="yes"');
  const attrs = a.length ? " " + a.join(" ") : "";
  const hasBody = p.systemLayout || p.staffLayouts || p.measureNumbering;
  if (!hasBody) {
    o.push(d, `<print${attrs}/>`);
    return;
  }
  o.push(d, `<print${attrs}>`);
  if (p.systemLayout) {
    o.push(d + 1, "<system-layout>");
    const sl = p.systemLayout;
    if (sl.leftMargin !== undefined || sl.rightMargin !== undefined) {
      o.push(d + 2, "<system-margins>");
      if (sl.leftMargin !== undefined) o.push(d + 3, tag("left-margin", sl.leftMargin));
      if (sl.rightMargin !== undefined) o.push(d + 3, tag("right-margin", sl.rightMargin));
      o.push(d + 2, "</system-margins>");
    }
    if (p.systemLayout.systemDistance !== undefined) {
      o.push(d + 2, tag("system-distance", p.systemLayout.systemDistance));
    }
    if (p.systemLayout.topSystemDistance !== undefined) {
      o.push(d + 2, tag("top-system-distance", p.systemLayout.topSystemDistance));
    }
    o.push(d + 1, "</system-layout>");
  }
  for (const sl of p.staffLayouts ?? []) {
    const n = sl.staff !== undefined ? ` number="${sl.staff}"` : "";
    if (sl.staffDistance === undefined) {
      o.push(d + 1, `<staff-layout${n}/>`);
      continue;
    }
    o.push(d + 1, `<staff-layout${n}>`);
    o.push(d + 2, tag("staff-distance", sl.staffDistance));
    o.push(d + 1, "</staff-layout>");
  }
  if (p.measureNumbering) o.push(d + 1, tag("measure-numbering", p.measureNumbering));
  o.push(d, "</print>");
}

function measureXml(
  o: Out,
  d: number,
  m: Measure,
  marksByStart: Map<number, Mark[]>,
  marksByEnd: Map<number, Mark[]>,
): void {
  const mAttrs = (m.implicit ? ' implicit="yes"' : "") + (m.width !== undefined ? ` width="${m.width}"` : "");
  o.push(d, `<measure number="${escAttr(m.number)}"${mAttrs}>`);
  // 顺序是硬要求：print → 左线 → attributes → direction → (harmony/note)* → 右线
  if (m.print) printXml(o, d + 1, m.print);
  for (const b of m.barlines ?? []) if (b.location === "left") barlineXml(o, d + 1, b);
  if (m.attrs) {
    o.push(d + 1, "<attributes>");
    if (m.attrs.divisions !== undefined) o.push(d + 2, tag("divisions", m.attrs.divisions));
    if (m.attrs.key) writeKey(o, d + 2, m.attrs.key);
    if (m.attrs.time) writeTime(o, d + 2, m.attrs.time);
    if (m.attrs.staves !== undefined) o.push(d + 2, tag("staves", m.attrs.staves));
    for (const c of m.attrs.clefs ?? []) {
      o.push(d + 2, c.staff ? `<clef number="${c.staff}">` : "<clef>");
      o.push(d + 3, tag("sign", c.sign));
      if (c.line !== undefined) o.push(d + 3, tag("line", c.line));
      if (c.octaveChange !== undefined) o.push(d + 3, tag("clef-octave-change", c.octaveChange));
      o.push(d + 2, "</clef>");
    }
    for (const sd of m.attrs.staffDetails ?? []) {
      const a = (sd.staff ? ` number="${sd.staff}"` : "") +
        (sd.printObject !== undefined ? ` print-object="${sd.printObject ? "yes" : "no"}"` : "");
      o.push(d + 2, `<staff-details${a}/>`);
    }
    if (m.attrs.transpose) {
      o.push(d + 2, "<transpose>");
      if (m.attrs.transpose.diatonic !== undefined) {
        o.push(d + 3, tag("diatonic", m.attrs.transpose.diatonic));
      }
      o.push(d + 3, tag("chromatic", m.attrs.transpose.chromatic));
      if (m.attrs.transpose.octaveChange !== undefined) {
        o.push(d + 3, tag("octave-change", m.attrs.transpose.octaveChange));
      }
      o.push(d + 2, "</transpose>");
    }
    o.push(d + 1, "</attributes>");
  }
  // 记号按 afterElements 插回原位（缺省在小节开头；超出元素个数的落到小节末）
  const count = m.elements.length;
  const dirAt = (dir: Direction): number => Math.min(dir.afterElements ?? 0, count);
  // 游标：元素/记号带 `onset`（多声部）时补 `<backup>`/`<forward>` 挪过去；`end` 是前一个元素的终点（`onset` 缺省值）
  let cursor = 0;
  let end = 0;
  const moveTo = (target: number): void => {
    if (target < cursor) o.push(d + 1, `<backup>${tag("duration", cursor - target)}</backup>`);
    else if (target > cursor) o.push(d + 1, `<forward>${tag("duration", target - cursor)}</forward>`);
    cursor = target;
  };
  const writeDir = (dir: Direction): void => {
    if (dir.type !== "sound") moveTo(dir.onset ?? end);
    directionXml(o, d + 1, dir);
  };
  const writeHarmony = (h: Harmony, owner: number): void => {
    moveTo(h.onset ?? owner);
    harmonyXml(o, d + 1, h);
  };
  for (const dir of m.directions ?? []) if (dirAt(dir) === 0) writeDir(dir);
  let i = 0;
  for (const el of m.elements) {
    // 小节中间的小节线按 afterElements 插回去，丢了会把两个小节并成一个
    for (const b of m.barlines ?? []) {
      if (b.location === "middle" && b.afterElements === i) barlineXml(o, d + 1, b);
    }
    if (i > 0) for (const dir of m.directions ?? []) if (dirAt(dir) === i) writeDir(dir);
    const onset = el.onset ?? end;
    if (el.kind === "chord") {
      if (el.harmony) writeHarmony(el.harmony, onset);
      for (const h of el.laterHarmonies ?? []) writeHarmony(h, onset);
      // 长音中途换和弦（挂在增时线上）：`<harmony>` 排在所辖音符之前，拍位靠 offset
      for (const su of el.sustains ?? []) if (su.harmony) writeHarmony(su.harmony, onset);
      moveTo(onset);
      chordXml(o, d + 1, el, marksByStart.get(el.id) ?? [], marksByEnd.get(el.id) ?? []);
      if (!el.grace) cursor += Math.max(0, Math.round(el.duration.divisions));
      end = cursor;
    } else if (el.spacer === "x" && el.duration) {
      // 不可见休止：占时值
      if (el.harmony) writeHarmony(el.harmony, onset);
      moveTo(onset);
      cursor += Math.max(0, Math.round(el.duration.divisions));
      end = cursor;
      o.push(d + 1, '<note print-object="no">');
      o.push(d + 2, "<rest/>");
      o.push(d + 2, tag("duration", Math.max(0, Math.round(el.duration.divisions))));
      o.push(d + 2, tag("voice", el.voice));
      if (el.duration.type) o.push(d + 2, tag("type", el.duration.type));
      o.push(d + 1, "</note>");
    } else if (el.harmony) {
      // `y` 占位符只为挂和弦（规范 §8.1）——MusicXML 里就是一个孤立的 `<harmony>`
      writeHarmony(el.harmony, onset);
    }
    i += 1;
  }
  if (count > 0) for (const dir of m.directions ?? []) if (dirAt(dir) === count) writeDir(dir);
  for (const raw of m.raw ?? []) o.raw(d + 1, raw);
  for (const b of m.barlines ?? []) if (b.location === "right") barlineXml(o, d + 1, b);
  o.push(d, "</measure>");
}

function partXml(o: Out, d: number, part: Part, song: Song): void {
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
  o.push(d, `<part id="${escAttr(part.id)}">`);
  for (const m of part.measures) measureXml(o, d + 1, m, byStart, byEnd);
  o.push(d, "</part>");
}

export interface ToXmlOptions {
  /** 取第几首（多曲文件、文本谱 `-----` 分曲）。默认第一首 */
  song?: number;
}

/** `ScoreDoc` → MusicXML 文本（含 XML 声明与 DOCTYPE）。**MusicXML 的唯一写出端**：
 *  简谱来源先经 `xmlproject.ts` 投成 MusicXML 形状，MusicXML 读进来的原样序列化。 */
export function scoreDocToMusicXml(doc: ScoreDoc, options: ToXmlOptions = {}): string {
  const src = doc.songs[options.song ?? 0];
  if (!src) throw new Error("这份文档里没有曲子");
  const song = projectForMusicXml(src);
  const o = new Out();
  o.push(0, '<?xml version="1.0" encoding="UTF-8"?>');
  o.push(
    0,
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" ' +
      '"http://www.musicxml.org/dtds/partwise.dtd">',
  );
  o.push(0, '<score-partwise version="3.1">');
  if (song.work.number || song.work.title) {
    o.push(1, "<work>");
    if (song.work.number) o.push(2, tag("work-number", song.work.number));
    if (song.work.title) o.push(2, tag("work-title", song.work.title));
    o.push(1, "</work>");
  }
  if (song.work.movementTitle) o.push(1, tag("movement-title", song.work.movementTitle));
  if (song.identification) {
    o.push(1, "<identification>");
    for (const c of song.identification.creators) {
      o.push(2, `<creator type="${escAttr(c.type)}">${esc(c.text)}</creator>`);
    }
    if (song.identification.rights) o.push(2, tag("rights", song.identification.rights));
    o.push(2, "<encoding>");
    for (const sw of song.identification.software ?? ["jpeditor"]) o.push(3, tag("software", sw));
    o.push(2, "</encoding>");
    o.push(1, "</identification>");
  }
  if (song.defaults) writeDefaults(o, 1, song.defaults);
  for (const c of song.credits ?? []) writeCredit(o, 1, c);

  o.push(1, "<part-list>");
  const groups = song.partGroups ?? [];
  for (const g of groups) {
    o.push(2, `<part-group type="start" number="${escAttr(g.number)}">`);
    if (g.symbol) o.push(3, tag("group-symbol", g.symbol));
    if (g.name) o.push(3, tag("group-name", g.name));
    if (g.abbrev) o.push(3, tag("group-abbreviation", g.abbrev));
    if (g.groupBarline) o.push(3, tag("group-barline", "yes"));
    o.push(2, "</part-group>");
  }
  for (const p of song.parts) {
    o.push(2, `<score-part id="${escAttr(p.id)}">`);
    // MuseScore 兼容：`<part-name>` 留空并 print-object="no"（见 MusicXML-导出.md）
    if (p.name) o.push(3, tag("part-name", p.name));
    else o.push(3, '<part-name print-object="no"/>');
    if (p.abbrev) o.push(3, tag("part-abbreviation", p.abbrev));
    o.push(2, "</score-part>");
  }
  for (const g of groups) o.push(2, `<part-group type="stop" number="${escAttr(g.number)}"/>`);
  o.push(1, "</part-list>");

  for (const p of song.parts) partXml(o, 1, p, song);
  o.push(0, "</score-partwise>");
  return o.toString() + "\n";
}
