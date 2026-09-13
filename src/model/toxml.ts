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
  Harmony,
  Key,
  Lyric,
  Mark,
  Measure,
  Note,
  Part,
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

const tag = (name: string, text: string | number): string =>
  `<${name}>${typeof text === "string" ? esc(text) : text}</${name}>`;

// ───────────────────────── 头部 ─────────────────────────

function writeKey(o: Out, d: number, k: Key): void {
  o.push(d, "<key>");
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
  o.push(d, "</defaults>");
}

function writeCredit(o: Out, d: number, c: Credit): void {
  o.push(d, c.page ? `<credit page="${c.page}">` : '<credit page="1">');
  if (c.type) o.push(d + 1, tag("credit-type", c.type));
  const attrs: string[] = [];
  if (c.x !== undefined) attrs.push(`default-x="${c.x}"`);
  if (c.y !== undefined) attrs.push(`default-y="${c.y}"`);
  if (c.justify) attrs.push(`justify="${c.justify}"`);
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
  o.push(d, "<harmony>");
  o.push(d + 1, "<root>");
  o.push(d + 2, tag("root-step", h.root.step));
  if (h.root.alter) o.push(d + 2, tag("root-alter", h.root.alter));
  o.push(d + 1, "</root>");
  o.push(d + 1, h.kindText ? `<kind text="${escAttr(h.kindText)}">${esc(h.kind)}</kind>` : tag("kind", h.kind));
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
  o.push(d, `<lyric number="${l.refrain ? "chorus" : l.number}">`);
  if (l.syllabic) o.push(d + 1, tag("syllabic", l.syllabic));
  o.push(d + 1, tag("text", (l.leadingPunctuation ?? "") + l.text + (l.trailingPunctuation ?? "")));
  if (l.extend) o.push(d + 1, "<extend/>");
  o.push(d, "</lyric>");
}

/** 一个音符元素上要挂的 `<notations>`（含跨元素记号的起止）。 */
function notationsXml(o: Out, d: number, ch: Chord, starts: Mark[], stops: Mark[]): void {
  const n = ch.notations;
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
  o.push(d, "<notations>");
  for (const m of starts) {
    if (m.type === "slur") o.push(d + 1, `<slur type="start" number="${m.number ?? 1}"/>`);
    else if (m.type === "tied") o.push(d + 1, `<tied type="start" number="${m.number ?? 1}"/>`);
    else if (m.type === "tuplet") {
      o.push(d + 1, `<tuplet type="start" number="${m.number ?? 1}"/>`);
    }
  }
  for (const m of stops) {
    if (m.type === "slur") o.push(d + 1, `<slur type="stop" number="${m.number ?? 1}"/>`);
    else if (m.type === "tied") o.push(d + 1, `<tied type="stop" number="${m.number ?? 1}"/>`);
    else if (m.type === "tuplet") o.push(d + 1, `<tuplet type="stop" number="${m.number ?? 1}"/>`);
  }
  if (n?.fermata) o.push(d + 1, "<fermata/>");
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
    const attrs = ch.printObject === false ? ' print-object="no"' : "";
    o.push(d, `<note${attrs}>`);
    if (ch.grace) o.push(d + 1, ch.grace.slash ? '<grace slash="yes"/>' : "<grace/>");
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
    if (ch.duration.type) o.push(d + 1, tag("type", ch.duration.type));
    for (let i = 0; i < ch.duration.dots; i++) o.push(d + 1, "<dot/>");
    if (note?.accidental) o.push(d + 1, tag("accidental", note.accidental));
    if (ch.duration.timeMod) {
      o.push(d + 1, "<time-modification>");
      o.push(d + 2, tag("actual-notes", ch.duration.timeMod.actual));
      o.push(d + 2, tag("normal-notes", ch.duration.timeMod.normal));
      o.push(d + 1, "</time-modification>");
    }
    if (ch.rhythm && !isChordNote) o.push(d + 1, tag("notehead", "slash"));
    if (ch.staff > 1) o.push(d + 1, tag("staff", ch.staff));
    // number 是层号：按下标算，不能 indexOf（两层同为 begin 时会都写成 1）
    (ch.beams ?? []).forEach((b, i) => o.push(d + 1, `<beam number="${i + 1}">${esc(b)}</beam>`));
    if (withNotations) notationsXml(o, d + 1, ch, starts, stops);
    if (withNotations) for (const l of ch.lyrics ?? []) lyricXml(o, d + 1, l);
    o.push(d, "</note>");
  };

  if (ch.notes.length === 0) {
    writeOne(null, false, true);
    return;
  }
  ch.notes.forEach((n, i) => writeOne(n, i > 0, i === 0));
}

function directionXml(o: Out, d: number, dir: Direction): void {
  const pl = dir.placement ? ` placement="${dir.placement}"` : "";
  o.push(d, `<direction${pl}>`);
  o.push(d + 1, "<direction-type>");
  switch (dir.type) {
    case "dynamics":
      o.push(d + 2, `<dynamics><${dir.text || "mf"}/></dynamics>`);
      break;
    case "words":
    case "rehearsal":
      o.push(d + 2, `<${dir.type}>${esc(dir.text ?? "")}</${dir.type}>`);
      break;
    case "wedge":
      o.push(
        d + 2,
        `<wedge type="${dir.spanType === "stop" ? "stop" : dir.wedgeType ?? "crescendo"}"/>`,
      );
      break;
    case "metronome":
      o.push(d + 2, "<metronome>");
      o.push(d + 3, tag("beat-unit", dir.tempo?.beatUnit ?? "quarter"));
      o.push(d + 3, tag("per-minute", dir.tempo?.perMinute ?? 90));
      o.push(d + 2, "</metronome>");
      break;
    case "bracket":
      // 伴奏括弧（简谱来源才带起止）；MusicXML 读进来的没有 spanType，照旧写空元素
      if (dir.spanType) {
        o.push(d + 2, `<bracket type="${dir.spanType}" line-end="down" line-type="solid"/>`);
      } else {
        o.push(d + 2, "<bracket/>");
      }
      break;
    case "pedal":
    case "octave-shift":
      o.push(d + 2, `<${dir.type} type="${dir.spanType ?? "start"}"/>`);
      break;
    default:
      o.push(d + 2, `<${dir.type}/>`);
      break;
  }
  o.push(d + 1, "</direction-type>");
  if (dir.offset !== undefined) o.push(d + 1, tag("offset", dir.offset));
  if (dir.sound) {
    const a: string[] = [];
    if (dir.sound.dacapo) a.push('dacapo="yes"');
    if (dir.sound.dalsegno) a.push(`dalsegno="${escAttr(dir.sound.dalsegno)}"`);
    if (dir.sound.fine) a.push('fine="yes"');
    if (dir.sound.segno) a.push(`segno="${escAttr(dir.sound.segno)}"`);
    if (dir.sound.coda) a.push(`coda="${escAttr(dir.sound.coda)}"`);
    if (dir.sound.tocoda) a.push(`tocoda="${escAttr(dir.sound.tocoda)}"`);
    if (dir.sound.tempo !== undefined) a.push(`tempo="${dir.sound.tempo}"`);
    if (a.length) o.push(d + 1, `<sound ${a.join(" ")}/>`);
  }
  if (dir.staff !== undefined && dir.staff > 1) o.push(d + 1, tag("staff", dir.staff));
  o.push(d, "</direction>");
}

function barlineXml(o: Out, d: number, b: Barline): void {
  o.push(d, `<barline location="${b.location === "middle" ? "middle" : b.location}">`);
  if (b.style) o.push(d + 1, tag("bar-style", b.style));
  if (b.ending) {
    const t = b.ending.type;
    const nums = b.ending.numbers.join(",");
    o.push(d + 1, `<ending number="${nums}" type="${t}">${esc(b.ending.text ?? nums)}</ending>`);
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
  const hasBody = p.systemLayout || p.measureNumbering;
  if (!hasBody) {
    o.push(d, `<print${attrs}/>`);
    return;
  }
  o.push(d, `<print${attrs}>`);
  if (p.systemLayout) {
    o.push(d + 1, "<system-layout>");
    if (p.systemLayout.systemDistance !== undefined) {
      o.push(d + 2, tag("system-distance", p.systemLayout.systemDistance));
    }
    if (p.systemLayout.topSystemDistance !== undefined) {
      o.push(d + 2, tag("top-system-distance", p.systemLayout.topSystemDistance));
    }
    o.push(d + 1, "</system-layout>");
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
  o.push(d, `<measure number="${escAttr(m.number)}">`);
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
  for (const dir of m.directions ?? []) directionXml(o, d + 1, dir);
  let i = 0;
  for (const el of m.elements) {
    // 小节中间的小节线按 afterElements 插回去，丢了会把两个小节并成一个
    for (const b of m.barlines ?? []) {
      if (b.location === "middle" && b.afterElements === i) barlineXml(o, d + 1, b);
    }
    if (el.kind === "chord") {
      if (el.harmony) harmonyXml(o, d + 1, el.harmony);
      for (const h of el.laterHarmonies ?? []) harmonyXml(o, d + 1, h);
      // 长音中途换和弦（挂在增时线上）：`<harmony>` 排在所辖音符之前，拍位靠 offset
      for (const su of el.sustains ?? []) if (su.harmony) harmonyXml(o, d + 1, su.harmony);
      chordXml(o, d + 1, el, marksByStart.get(el.id) ?? [], marksByEnd.get(el.id) ?? []);
    } else if (el.spacer === "x" && el.duration) {
      // 不可见休止：占时值
      if (el.harmony) harmonyXml(o, d + 1, el.harmony);
      o.push(d + 1, '<note print-object="no">');
      o.push(d + 2, "<rest/>");
      o.push(d + 2, tag("duration", Math.max(0, Math.round(el.duration.divisions))));
      o.push(d + 2, tag("voice", el.voice));
      if (el.duration.type) o.push(d + 2, tag("type", el.duration.type));
      o.push(d + 1, "</note>");
    } else if (el.harmony) {
      // `y` 占位符只为挂和弦（规范 §8.1）——MusicXML 里就是一个孤立的 `<harmony>`
      harmonyXml(o, d + 1, el.harmony);
    }
    i += 1;
  }
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
    o.push(3, tag("software", song.identification.encoding ?? "jpeditor"));
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
