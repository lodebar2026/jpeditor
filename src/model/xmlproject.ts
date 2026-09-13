// 简谱来源的 `Song` → **MusicXML 形状**的 `Song`：`toxml.ts` 序列化之前的投影。
//
// ## 为什么要有这一层
//
// MusicXML 只有一份写出端（`toxml.ts::scoreDocToMusicXml`），它只认 MusicXML 形状的字段：
// 绝对音高、以 `attrs.divisions` 为分母的时值、`<notations>` 元素名、带 offset 的 `<direction>`。
// MusicXML 读进来的文档（`fromxml.ts`）这些都是满的；简谱来源（文本谱/123/ABC/`.jpwabc`）
// 只填了简谱那一侧——度数、48 分的时值、记号原名（`&dy`）、增时线上的和弦。
// 这里把后者投成前者，**写出端就不必分两份**。
//
// 判据：首小节带 `attrs.divisions` 的是 MusicXML 形状，原样返回（保证 `.musicxml` 重写逐字节不变）；
// 其余在克隆上投影，不改调用方的文档。
//
// 已知不表达：承接前音的增时线（`Chord.continued`）按普通音符写、不补 tie；
// 挂在增时线上的歌词（文本谱 `-@`）与记号不写——MusicXML 里增时线不是独立的音符。

import type {
  Barline, Chord, Direction, Element, ElementId, Lyric, Mark, Measure, Notations, Part, Pitch,
  SourceOrnament, Song,
} from "./doc";
import { Fraction, lcm } from "../common/fraction";
import { jpPitch } from "../score/jppitch";
import { MusicCommon } from "../score/score";
import { typeOfDuration } from "../score/xmlutil";
import { DYNAMICS, TERMS } from "../pu/glyph";

/** 简谱来源的时值单位：一个四分音符 = 48（`frompu.ts` / `j123` / `fromscore.ts` 同口径）。 */
const SIMPLE_DIVISIONS = 48;

/** 记号原名 → `<articulations>` 元素名（`&xx` 与 123 的 `!xx!` 同名）。 */
const ARTICULATION: Readonly<Record<string, string>> = {
  bc: "tenuto",
  zy: "accent",
  dy: "staccato",
  hx: "breath-mark",
  // 上下滑音在 MusicXML 里属于 articulations 的 scoop / falloff
  shy: "scoop",
  xhy: "falloff",
};
const FERMATA = /^(yc|ycy|fermata)$/i;
const ORNAMENT_TAG: Readonly<Record<string, string>> = {
  sby: "inverted-mordent",
  xby: "mordent",
  cy: "trill-mark",
  tr: "trill-mark",
};
/** 本来就是 MusicXML 元素名的（ABC 的 `!staccato!`、`.jpwabc` 的 articulations），原样保留。 */
const XML_ARTICULATIONS = new Set([
  "accent", "strong-accent", "staccato", "tenuto", "detached-legato", "staccatissimo", "spiccato",
  "scoop", "plop", "doit", "falloff", "breath-mark", "caesura", "stress", "unstress", "soft-accent",
]);
const XML_ORNAMENTS = new Set(["trill-mark", "turn", "delayed-turn", "inverted-turn", "shake", "mordent", "inverted-mordent"]);

/** 是否已经是 MusicXML 形状（`fromxml.ts` 读进来的）。 */
export function isXmlShaped(song: Song): boolean {
  return song.parts.some((p) => p.measures[0]?.attrs?.divisions !== undefined);
}

export function projectForMusicXml(src: Song): Song {
  if (isXmlShaped(src)) return src;
  const song: Song = structuredClone(src);
  const fifths = fifthsOf(song);
  const hosts = sustainHosts(song);
  const tuplets = tupletRatios(song);
  const factor = divisionFactor(song, tuplets);
  const divisions = SIMPLE_DIVISIONS * factor;

  tiesToMarks(song);
  normalizeMarks(song, hosts);
  for (const [pi, part] of song.parts.entries()) {
    joinOpenMeasures(part);
    mergeEmptyMeasures(part);
    moveForwardRepeats(part);
    const first = part.measures[0];
    if (!first) continue;
    first.attrs = {
      ...(first.attrs ?? {}),
      divisions,
      key: { ...(song.key ?? {}), ...(first.attrs?.key ?? {}), fifths: first.attrs?.key?.fifths ?? fifths },
      time: first.attrs?.time ?? (song.time ? { beats: song.time.beats, beatType: song.time.beatType } : { beats: 4, beatType: 4 }),
    };
    for (const [i, m] of part.measures.entries()) {
      if (!m.print) continue;
      if (i === 0) {
        delete m.print.newSystem;
        delete m.print.newPage;
      }
      if (!m.print.newSystem && !m.print.newPage) delete m.print;
    }
    projectPart(part, fifths, factor, tuplets);
    wedgeDirections(song, part);
    if (pi === 0) tempoDirection(song, first);
  }
  // wedge 已经全部落成 direction，`<notations>` 那边不认它
  song.marks = song.marks.filter((m) => m.type !== "wedge");
  if (!song.credits?.length) song.credits = creditsOf(song);
  return song;
}

// ───────────────────────── 头部 ─────────────────────────

function fifthsOf(song: Song): number {
  const k = song.key;
  if (!k) return 0;
  if (k.fifths !== 0 || !k.spelling) return k.fifths;
  const f = MusicCommon.keyNameToFifth(k.spelling);
  return f >= -7 && f <= 7 ? f : 0;
}

function creditsOf(song: Song): NonNullable<Song["credits"]> {
  const out: NonNullable<Song["credits"]> = [];
  for (const t of song.work.subtitles) if (t) out.push({ type: "subtitle", text: t, page: 1 });
  for (const c of song.identification?.creators ?? []) if (c.text) out.push({ type: c.type, text: c.text, page: 1 });
  for (const t of song.pageText?.topRight ?? []) if (t) out.push({ type: "composer", text: t, page: 1 });
  for (const t of song.pageText?.topLeft ?? []) if (t) out.push({ type: "lyricist", text: t, page: 1 });
  return out;
}

function tempoDirection(song: Song, first: Measure): void {
  const bpm = song.tempos?.find((t): t is number => typeof t === "number" && t >= 20 && t <= 400);
  if (bpm === undefined) return;
  if (first.directions?.some((d) => d.type === "metronome")) return;
  (first.directions ??= []).unshift({
    type: "metronome", placement: "above", tempo: { beatUnit: "quarter", perMinute: bpm }, sound: { tempo: bpm },
  });
}

// ───────────────────────── 小节结构 ─────────────────────────

/** 行尾没有小节线的小节（文本谱/123 跨行接着写同一小节）与下一行开头并成一个：
 *  MusicXML 表达不了小节中间换行，拆成两个短小节时值就不对了。换行顺延到并完之后的下一小节。 */
function joinOpenMeasures(part: Part): void {
  const out: Measure[] = [];
  let deferred: Measure["print"];
  for (const m of part.measures) {
    const prev = out[out.length - 1];
    const prevOpen = prev && prev.elements.length > 0 && !prev.barlines?.some((b) => b.location === "right");
    if (prevOpen && m.elements.length > 0 && !m.attrs && !m.barlines?.some((b) => b.location === "left")) {
      prev.elements.push(...m.elements);
      if (m.barlines) prev.barlines = [...(prev.barlines ?? []), ...m.barlines];
      if (m.trailing) prev.trailing = [...(prev.trailing ?? []), ...m.trailing];
      if (m.print?.newSystem || m.print?.newPage) deferred = { ...(deferred ?? {}), ...m.print };
      continue;
    }
    if (deferred) {
      m.print = { ...deferred, ...(m.print ?? {}) };
      deferred = undefined;
    }
    out.push(m);
  }
  part.measures = out;
}

/** 没有元素的小节（行首 `|:`、两根小节线挨着）在 MusicXML 里不成小节：
 *  房号、左反复、行结构、拍号顺延到下一小节；是最后一个就把右线并回前一小节。 */
function mergeEmptyMeasures(part: Part): void {
  const out: Measure[] = [];
  let carry: Measure | null = null;
  for (const m of part.measures) {
    if (m.elements.length === 0 && !m.raw?.length) {
      carry = carry ? mergeInto(carry, m) : m;
      continue;
    }
    if (carry) {
      const lefts: Barline[] = [];
      for (const b of carry.barlines ?? []) {
        if (b.ending?.type === "start") lefts.push({ location: "left", ending: b.ending });
        if (b.repeat === "forward" || b.alsoForward) lefts.push({ location: "left", repeat: "forward", style: "heavy-light" });
        // 线上的记号（行首 `|:&hs`）落到下一小节起点
        if (b.ornaments?.length) lefts.push({ location: "left", ornaments: b.ornaments });
        if (b.time) (m.attrs ??= {}).time ??= b.time;
      }
      if (lefts.length) m.barlines = [...lefts, ...(m.barlines ?? [])];
      if (carry.print) m.print = { ...carry.print, ...(m.print ?? {}) };
      if (carry.attrs) m.attrs = { ...carry.attrs, ...(m.attrs ?? {}) };
      carry = null;
    }
    out.push(m);
  }
  if (carry && out.length) {
    const last = out[out.length - 1]!;
    for (const b of carry.barlines ?? []) {
      if (b.location !== "right" || b.ending?.type === "start") continue;
      const right = (last.barlines ?? []).find((x) => x.location === "right");
      if (!right) (last.barlines ??= []).push(b);
      else {
        right.ending ??= b.ending;
        right.repeat ??= b.repeat;
      }
    }
  }
  part.measures = out;
}

function mergeInto(a: Measure, b: Measure): Measure {
  return {
    ...a,
    barlines: [...(a.barlines ?? []), ...(b.barlines ?? [])],
    ...(a.print || b.print ? { print: { ...(a.print ?? {}), ...(b.print ?? {}) } } : {}),
  };
}

/** 右线上的 `|:`（与 `:|:` 的 forward 半边）是**下一小节**的左反复；右线上起头的房号同理。
 *  普通小节线在 MusicXML 里不写 `<barline>`。 */
function moveForwardRepeats(part: Part): void {
  part.measures.forEach((m, i) => {
    const next = part.measures[i + 1];
    const lefts: Barline[] = [];
    m.barlines = (m.barlines ?? []).filter((b) => {
      if (b.location !== "right") return true;
      if (b.repeat === "forward" || b.alsoForward) {
        // heavy-light 是左反复那一侧的线型，跟着挪过去；`:|:` 的右线留 light-heavy
        if (b.repeat === "forward") {
          delete b.repeat;
          if (b.style === "heavy-light") delete b.style;
        }
        delete b.alsoForward;
        lefts.push({ location: "left", repeat: "forward", style: "heavy-light" });
      }
      if (b.ending?.type === "start") {
        lefts.push({ location: "left", ending: b.ending });
        delete b.ending;
      }
      if (b.time && next) (next.attrs ??= {}).time ??= b.time;
      if (b.style === "regular") delete b.style;
      return !!(b.style || b.repeat || b.ending || b.ornaments?.length);
    });
    if (lefts.length && next) {
      const existing = new Set((next.barlines ?? []).filter((b) => b.location === "left").map((b) => (b.repeat ? "r" : "") + (b.ending ? "e" : "")));
      const add = lefts.filter((b) => !existing.has((b.repeat ? "r" : "") + (b.ending ? "e" : "")));
      next.barlines = [...add, ...(next.barlines ?? [])];
    }
    for (const b of m.barlines) if (b.location === "left" && b.style === "regular") delete b.style;
    if (!m.barlines.length) delete m.barlines;
  });
}

// ───────────────────────── 跨元素记号 ─────────────────────────

/** 增时线 id → 宿主和弦 id。记号端点落在增时线上时，MusicXML 只能挂到宿主音符。 */
function sustainHosts(song: Song): Map<ElementId, ElementId> {
  const out = new Map<ElementId, ElementId>();
  for (const p of song.parts) {
    for (const m of p.measures) {
      for (const el of m.elements) {
        if (el.kind === "chord") for (const su of el.sustains ?? []) out.set(su.id, el.id);
      }
    }
  }
  return out;
}

/** 多连音：n 个位置（增时线各占一个）占 n−1 个基本时值——与文本谱排版同口径。 */
function tupletRatios(song: Song): Map<ElementId, { actual: number; normal: number }> {
  const out = new Map<ElementId, { actual: number; normal: number }>();
  for (const p of song.parts) {
    const tokens: ElementId[] = [];
    const chordOfToken: ElementId[] = [];
    for (const m of p.measures) {
      for (const el of m.elements) {
        if (el.kind !== "chord" || el.grace) continue;
        tokens.push(el.id);
        chordOfToken.push(el.id);
        for (const su of el.sustains ?? []) {
          tokens.push(su.id);
          chordOfToken.push(el.id);
        }
      }
    }
    const at = new Map(tokens.map((id, i) => [id, i]));
    for (const mk of song.marks) {
      if (mk.type !== "tuplet") continue;
      const a = at.get(mk.start);
      const b = at.get(mk.end);
      if (a === undefined || b === undefined || b <= a) continue;
      const n = b - a + 1;
      for (let i = a; i <= b; i++) out.set(chordOfToken[i]!, { actual: n, normal: n - 1 });
    }
  }
  return out;
}

/** 连音缩放后时值不再是 48 的整数倍时，divisions 要整体放大多少倍。 */
function divisionFactor(song: Song, tuplets: Map<ElementId, { actual: number; normal: number }>): number {
  let f = 1;
  for (const p of song.parts) {
    for (const m of p.measures) {
      for (const el of m.elements) {
        if (el.kind !== "chord") continue;
        const r = el.duration.timeMod ?? tuplets.get(el.id);
        if (!r) continue;
        const q = new Fraction(Math.round(el.duration.divisions) * r.normal, r.actual);
        f = lcm(f, q.denominator);
      }
    }
  }
  return f;
}

/** 延音线：简谱来源只在音上标了起止（`Note.tie`），`<tied>` 要按 id 配成对。
 *  两端必须是同一个实音，配不上的两头都去掉——孤立的 start 会让下游软件把线一路拖下去。 */
function tiesToMarks(song: Song): void {
  if (song.marks.some((m) => m.type === "tied")) return;
  for (const p of song.parts) {
    let open: { chord: Chord; note: Chord["notes"][number] }[] = [];
    for (const m of p.measures) {
      for (const el of m.elements) {
        if (el.kind !== "chord" || el.grace) continue;
        const next: typeof open = [];
        for (const note of el.notes) {
          if (note.tie?.stop) {
            const k = open.findIndex((o) => sameDegree(o.note, note));
            if (k >= 0) {
              song.marks.push({ type: "tied", start: open[k]!.chord.id, end: el.id });
              open.splice(k, 1);
            } else {
              delete note.tie.stop;
            }
          }
          if (note.tie?.start) next.push({ chord: el, note });
        }
        for (const o of open) delete o.note.tie!.start;
        open = next;
      }
    }
    for (const o of open) delete o.note.tie!.start;
  }
}

const sameDegree = (a: Chord["notes"][number], b: Chord["notes"][number]): boolean =>
  !!a.degree && !!b.degree && a.degree.number === b.degree.number && a.degree.octaveShift === b.degree.octaveShift;

/** 记号端点归到写得出来的音符上；没收口、倒置、端点不在谱面元素上的丢掉；弧线补 number。 */
function normalizeMarks(song: Song, hosts: Map<ElementId, ElementId>): void {
  const written = new Set<ElementId>();
  const order = new Map<ElementId, number>();
  for (const p of song.parts) {
    for (const m of p.measures) {
      for (const el of m.elements) {
        if (el.kind !== "chord") continue;
        written.add(el.id);
        order.set(el.id, order.size);
      }
    }
  }
  const marks: Mark[] = [];
  for (const mk of song.marks) {
    if (mk.type === "wedge") {
      marks.push(mk);
      continue;
    }
    if (mk.collapsed || mk.start < 0) continue;
    const start = hosts.get(mk.start) ?? mk.start;
    const end = hosts.get(mk.end) ?? mk.end;
    if (!written.has(start) || !written.has(end)) continue;
    if ((mk.type === "slur" || mk.type === "tuplet") && order.get(start)! >= order.get(end)!) continue;
    marks.push({ ...mk, start, end });
  }
  // 多连音不能交叠（MusicXML 的 `<tuplet>` 没有 number 就按顺序配对），后来的那条丢掉
  let tupletEnd = -1;
  for (const mk of marks.filter((m) => m.type === "tuplet").sort((a, b) => order.get(a.start)! - order.get(b.start)!)) {
    if (order.get(mk.start)! <= tupletEnd) {
      marks.splice(marks.indexOf(mk), 1);
      continue;
    }
    tupletEnd = order.get(mk.end)!;
  }
  // 重叠的弧线靠 number 配对
  const active: Array<number | null> = [];
  const slurs = marks.filter((m) => m.type === "slur" && m.number === undefined)
    .sort((a, b) => order.get(a.start)! - order.get(b.start)!);
  for (const mk of slurs) {
    const s = order.get(mk.start)!;
    let slot = active.findIndex((e) => e === null || e < s);
    if (slot < 0) slot = active.length;
    active[slot] = order.get(mk.end)!;
    mk.number = slot + 1;
  }
  song.marks = marks;
}

/** 渐强渐弱：起点、终点各一个 `<wedge>` direction。 */
function wedgeDirections(song: Song, part: Part): void {
  const hosts = sustainHosts(song);
  const where = new Map<ElementId, { m: Measure; offset: number; end: number }>();
  for (const m of part.measures) {
    let pos = 0;
    for (const el of m.elements) {
      const d = timed(el) ? Math.round(el.duration?.divisions ?? 0) : 0;
      where.set(el.id, { m, offset: pos, end: pos + d });
      pos += d;
    }
  }
  for (const mk of song.marks) {
    if (mk.type !== "wedge" || mk.collapsed || mk.start < 0) continue;
    const s = where.get(hosts.get(mk.start) ?? mk.start);
    const e = where.get(hosts.get(mk.end) ?? mk.end);
    if (!s || !e) continue;
    const at = (x: { m: Measure; offset: number }, d: Direction): void => {
      if (x.offset > 0) d.offset = x.offset;
      (x.m.directions ??= []).push(d);
    };
    at(s, { type: "wedge", placement: "below", spanType: "start", wedgeType: mk.wedgeType ?? "crescendo" });
    at({ m: e.m, offset: e.end }, { type: "wedge", placement: "below", spanType: "stop" });
  }
}

// ───────────────────────── 元素 ─────────────────────────

const timed = (el: Element): boolean =>
  el.kind === "chord" ? !el.grace : el.spacer === "x";

function projectPart(
  part: Part,
  songFifths: number,
  factor: number,
  tuplets: Map<ElementId, { actual: number; normal: number }>,
): void {
  let fifths = part.measures[0]?.attrs?.key?.fifths ?? songFifths;
  // 文本谱/123 的 `beams` 是减时线层数的占位（全是 continue），不是符杠分组；一个 begin 都没有就不写
  const realBeams = part.measures.some((m) => m.elements.some((el) => el.kind === "chord" && el.beams?.includes("begin")));
  for (const m of part.measures) {
    if (m.attrs?.key) {
      if (m.attrs.key.fifths === 0 && m.attrs.key.spelling) {
        const f = MusicCommon.keyNameToFifth(m.attrs.key.spelling);
        if (f >= -7 && f <= 7) m.attrs.key.fifths = f;
      }
      fifths = m.attrs.key.fifths;
    }
    /** 小节内延续的临时记号（唱名 → 相对调号的半音） */
    const carry: Record<number, number> = {};
    const dirs: Direction[] = [];
    let pos = 0;
    for (const el of m.elements) {
      // 简谱来源一个 part 就是一个声部：`<voice>` 一律写 1（文本谱 `Q2:` 的声部号是 part 的事）
      el.voice = 1;
      if (el.kind === "space") {
        if (el.duration) {
          el.duration = { ...el.duration, divisions: Math.round(el.duration.divisions) * factor };
          pos += el.duration.divisions;
        }
        delete el.beams;
        continue;
      }
      const ch = el;
      for (const n of ch.notes) {
        if (!n.pitch && n.degree && n.degree.number > 0) n.pitch = pitchOf(n.degree, fifths, carry);
      }
      if (ch.grace) {
        ch.duration = { ...ch.duration, divisions: 0 };
        delete ch.beams;
        continue;
      }
      // 时值：48 分 → 放大后的 divisions；type/dots 按含增时线的名义时值重算；连音补比例
      const nominal = Math.round(ch.duration.divisions);
      // 简谱来源的 divisions 一律是名义时值；比例或者已经带着（`.jpwabc` 的连音），或者由连音记号算
      const r = ch.duration.timeMod ?? tuplets.get(ch.id);
      const { type, dots } = typeOfDuration(new Fraction(nominal, SIMPLE_DIVISIONS));
      const scaled = r ? (nominal * factor * r.normal) / r.actual : nominal * factor;
      ch.duration = {
        ...ch.duration,
        divisions: Math.round(scaled),
        type: type as NonNullable<Chord["duration"]["type"]>,
        dots,
        ...(r ? { timeMod: { ...r } } : {}),
      };
      if (!realBeams) delete ch.beams;

      // 增时线上的和弦：拍位从本音符起算（本体时值 + 前面的增时线条数）
      const bodyQuarters = (nominal - (ch.sustains?.length ?? 0) * SIMPLE_DIVISIONS) / SIMPLE_DIVISIONS;
      (ch.sustains ?? []).forEach((su, k) => {
        if (!su.harmony) return;
        const off = (bodyQuarters + k) * SIMPLE_DIVISIONS * factor * (r ? r.normal / r.actual : 1);
        su.harmony = { ...su.harmony, offset: Math.round(off) };
      });

      projectOrnaments(ch, dirs, pos);
      if (ch.sectionWord) push(dirs, pos, { type: "words", placement: "above", text: ch.sectionWord });
      ch.lyrics = lyricsOf(ch.lyrics);
      if (!ch.lyrics.length) delete ch.lyrics;
      pos += ch.duration.divisions;
    }
    for (const b of m.barlines ?? []) {
      for (const o of b.ornaments ?? []) {
        const d = directionOf(o);
        if (d) push(dirs, b.location === "left" ? 0 : pos, d);
      }
    }
    // 只挂记号的小节线在 MusicXML 里没有可写的内容
    if (m.barlines) {
      m.barlines = m.barlines.filter((b) => b.style || b.repeat || b.ending);
      if (!m.barlines.length) delete m.barlines;
    }
    if (dirs.length) m.directions = [...(m.directions ?? []), ...dirs];
  }
}

function push(dirs: Direction[], offset: number, d: Direction): void {
  if (offset > 0) d.offset = offset;
  dirs.push(d);
}

/** 唱名 + 八度点 + 临时记号（小节内延续）→ 绝对音高。拼写字母取自调号（`jppitch.ts::jpPitch`）。 */
function pitchOf(
  degree: NonNullable<Chord["notes"][number]["degree"]>,
  fifths: number,
  carry: Record<number, number>,
): Pitch {
  switch (degree.accidental) {
    case "sharp": carry[degree.number] = 1; break;
    case "double-sharp": carry[degree.number] = 2; break;
    case "flat": carry[degree.number] = -1; break;
    case "double-flat": carry[degree.number] = -2; break;
    case "natural": delete carry[degree.number]; break;
    default: break;
  }
  const p = jpPitch(degree.number, degree.octaveShift, fifths);
  return { step: p.step as Pitch["step"], alter: p.alter + (carry[degree.number] ?? 0), octave: p.octave };
}

/** 记号原名 → `<notations>` 与 `<direction>`；已经是 MusicXML 元素名的原样留下。 */
function projectOrnaments(ch: Chord, dirs: Direction[], pos: number): void {
  const names: SourceOrnament[] = ch.ornaments?.length
    ? ch.ornaments
    : (ch.notations?.articulations ?? []).map((name) => ({ name, level: 0 }));
  const n: Notations = {};
  if (ch.notations?.fermata) n.fermata = true;
  const artic: string[] = [];
  const orn: string[] = [...(ch.notations?.ornaments ?? [])];
  for (const { name } of names) {
    if (FERMATA.test(name)) { n.fermata = true; continue; }
    const a = ARTICULATION[name] ?? (XML_ARTICULATIONS.has(name) ? name : undefined);
    if (a) { if (!artic.includes(a)) artic.push(a); continue; }
    const o = ORNAMENT_TAG[name] ?? (XML_ORNAMENTS.has(name) ? name : undefined);
    if (o) { if (!orn.includes(o)) orn.push(o); continue; }
    const d = directionOf({ name, level: 0 });
    if (d) push(dirs, pos, d);
  }
  if (artic.length) n.articulations = artic;
  if (orn.length) n.ornaments = orn;
  if (ch.notations?.technical?.length) n.technical = ch.notations.technical;
  if (n.fermata || n.articulations || n.ornaments || n.technical) ch.notations = n;
  else delete ch.notations;
}

/** 力度、术语、伴奏括弧、跳转记号 → `<direction>`。 */
function directionOf(o: SourceOrnament): Direction | null {
  const name = o.name;
  if (DYNAMICS[name]) return { type: "dynamics", placement: "below", text: name };
  if (TERMS[name]) return { type: "words", placement: "above", text: TERMS[name] };
  if (name === "zkh" || name === "ykh") return { type: "bracket", placement: "above", spanType: name === "zkh" ? "start" : "stop" };
  if (name === "fine") return { type: "words", placement: "above", text: "Fine", sound: { fine: true } };
  if (name === "dc") return { type: "words", placement: "above", text: "D.C.", sound: { dacapo: true } };
  if (name === "ds") return { type: "words", placement: "above", text: "D.S.", sound: { dalsegno: "1" } };
  if (name === "ty") return { type: "coda", placement: "above" };
  if (name === "hs") return { type: "segno", placement: "above" };
  return null;
}

/** 段号区间（`w1-3:`）展开成逐段的 `<lyric>`；空字不写。副歌行（`refrain`）写一条 chorus。 */
function lyricsOf(lyrics: readonly Lyric[] | undefined): Lyric[] {
  const out: Lyric[] = [];
  for (const l of lyrics ?? []) {
    if (!l.text) continue;
    if (l.refrain || l.numberTo === undefined) {
      out.push(l);
      continue;
    }
    for (let v = l.number; v <= l.numberTo; v++) {
      const one: Lyric = { ...l, number: v };
      delete one.numberTo;
      out.push(one);
    }
  }
  return out;
}
