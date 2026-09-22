// `ScoreDoc` → 文本谱原文（番茄简谱 / 诗歌本文本谱）。文本谱**唯一**的写出端：
// 打开别的格式后切成文本谱、另存为文本谱、识别结果出文本谱（`recognizedToDoc` 之后），都走这里。
//
// 映射照 `model/frompu.ts` 反着写，每一处写法以 `pu/parse.ts` 为准：
//   - 文本谱的小节线一律「收」一个小节，没有左线：模型里的左线（123/ABC 的 `|:`）并到前一小节的右线上写；
//   - 弧线与多连音共用**一个队列**（`)` 永远收最早开的那条），真嵌套的写不出来，按优先级留（`planArcs`）；
//   - 休止缺省不跟词、音符一律跟词，例外靠 `@` 翻（`0@` / `-@`）；
//   - 一行 `Q:` 就是谱面一行（不自动断行），所以模型里没有换行的曲子先按乐句断好再写。
//
// 方言差异一律从 `dialectSpec()` 取（`header` 管头部、`emit` 管曲行与歌词行），**不要在两套方言之间写 if**。

import type {
  Barline,
  Chord,
  Element,
  ElementId,
  InlineItem,
  Key,
  Lyric,
  LyricLineInfo,
  Mark,
  Measure,
  Part,
  ScoreDoc,
  Song,
  SourceOrnament,
  Sustain,
  Time,
} from "./doc";
import { SIMPLE_DIVISIONS } from "./doc";
import type { BarlineType } from "../pu/ast";
import { dialectSpec, type Dialect, type DialectSpec } from "../pu/dialect";
import { DYNAMICS, TERMS } from "../pu/glyph";
import { STEPS, keyAlter, tonicStep } from "../score/jppitch";
import { PU_LYRIC_PUNCTUATION } from "../common/cjkpunct";
import { projectForJianpu } from "./jianpuproject";
import { fillDegreesFromPitch, harmonyText, keySpelling, melodyLane, topNote } from "./jianpu";
import { ownIds, ownMarks, systemRanges, type SystemRange } from "./emitutil";
import { relayoutDocBreaks } from "./relayout";

// ───────────────────────── 头部 ─────────────────────────

/**
 * fifths → 调号名。与 jppitch 的主音推法同源，保证与音高换算一致。
 *
 * 升降号写在哪一侧**由方言决定，不能通用**：番茄 `D:` 两种顺序都收（`bB`/`Bb`），
 * 诗歌本的 `1=` 行却只认「字母在前」（`parseShigeKeyLine` 的 `^([A-Ga-g])([b#$♭♯]?)`），
 * 写成 `1=bB4/4` 会被读成 B 调——整首差半音，且回归只比数字时看不出来。
 */
export function keyNameOf(fifths: number, style: "prefix" | "suffix" = "prefix"): string {
  const idx = tonicStep(fifths);
  const alter = keyAlter(idx, fifths);
  const sign = alter < 0 ? "b" : alter > 0 ? "#" : "";
  return style === "suffix" ? STEPS[idx] + sign : sign + STEPS[idx];
}

/** 番茄 `D:` 收的调号原文（`parse.ts::applyMetadata` 的校验）；诗歌本 `1=` 行只认字母在前。 */
const KEY_DISPLAY: Readonly<Record<"prefix" | "suffix", RegExp>> = {
  prefix: /^(?:[A-G][#$b♭♯]?|[#$b♭♯][A-G])$/,
  suffix: /^[A-G][b#$♭♯]?$/,
};

/** 调号写法。优先原文（`♭A` 这类照印），其次拼写，最后才从 fifths 推。 */
function keyText(k: Key | undefined, style: "prefix" | "suffix"): string {
  if (!k) return "C";
  if (k.display && KEY_DISPLAY[style].test(k.display)) return k.display;
  const sp = k.spelling && k.spelling !== "none" ? k.spelling : keySpelling(k);
  const m = /^([#b]?)([A-G])([#b]?)$/.exec(sp);
  if (!m) return keyNameOf(k.fifths, style);
  const sign = m[1] || m[3] || "";
  return style === "suffix" ? m[2]! + sign : sign + m[2]!;
}

/** 头部拍号：`4/4 (2/4 1/4)`（辅助拍号带括号，番茄 `P:` 认这个形；诗歌本的 `1=` 行不认括号，照写也只丢括号）。 */
function meterText(song: Song): string {
  const parts: string[] = [];
  let inParen = false;
  for (const t of [song.time, ...(song.extraTimes ?? [])]) {
    if (!t) continue;
    const paren = t.parenthesized === true;
    if (!paren && inParen) parts[parts.length - 1] += ")";
    parts.push((paren && !inParen ? "(" : "") + `${t.beats}/${t.beatType}`);
    inParen = paren;
  }
  if (inParen) parts[parts.length - 1] += ")";
  return parts.join(" ");
}

/** 字段值里的换行会把后续内容变成裸行：一律按行拆成多条同名字段（同 `abcfamily/emit.ts::pushLines`）。 */
function pushField(L: string[], name: string, value: string): void {
  for (const line of value.split(/\r?\n/)) {
    const t = line.trim();
    if (t) L.push(`${name}:${t}`);
  }
}

/** 这行自由文字原样写回去会不会被读成别的东西（字段、曲行、注释、分曲线）。会就不写——宁丢一行注记，也别凭空多一行谱。 */
function isSafeRemark(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith("#") || /^-{5,}$/.test(t) || /^\[fenye\]$/i.test(t)) return false;
  if (/^\s*[A-Za-z]+\s*[:：]/.test(t) || /^\s*[1-7]\s*=/.test(t)) return false;
  return !(/[|]/.test(t) && /[0-9]/.test(t));
}

function headerLines(song: Song, d: DialectSpec, opts: EmitPuOptions): string[] {
  const h = d.header;
  const L: string[] = [];
  if (h.versionLine) L.push(song.work.version ? `V:${song.work.version}` : h.versionLine);
  // 曲号：诗歌本按印在标题哪一侧写 `XL:`/`XR:`；番茄没有曲号字段，拼回标题前（谱面上本来也是连着印的）。
  // ABC 的 `X:` 只是文件里的编号（规范要求每首都有），不是印在谱上的曲号，不写。
  const number = opts.fromAbc ? undefined : song.work.number;
  const inTitle = number && !h.indexFields ? `${number} ` : "";
  if (song.work.title !== undefined || inTitle) {
    L.push(`${h.titleField}:${inTitle}${(song.work.title ?? "").split(/\r?\n/).join(" ")}`);
  }
  for (const st of song.work.subtitles) pushField(L, h.titleField, st);
  const pt = song.pageText;
  if (h.indexFields && d.emit.pageFields) {
    const left = pt?.indexLeft ?? (pt?.indexRight === undefined ? number : undefined);
    if (left !== undefined) L.push(`${h.indexFields.left}:${left}`);
    if (pt?.indexRight !== undefined) L.push(`${h.indexFields.right}:${pt.indexRight}`);
  }
  for (const c of song.identification?.creators ?? []) pushField(L, h.creditField, c.text);
  const key = keyText(song.key, h.keyStyle);
  const meter = meterText(song);
  if (h.keyMeter === "split") {
    L.push(`${h.keyField}:${key}`);
    if (meter) L.push(`${h.meterField}:${meter}`);
  } else {
    const tonic = song.key?.tonicDegree ?? "1";
    const note = song.timeNote ? ` ${song.timeNote}` : "";
    L.push(`${tonic}=${key}${meter}${meter ? note : ""}`);
  }
  if (song.tempos?.length) L.push(`${h.tempoField}:${song.tempos.join(" ")}`);
  if (d.emit.pageFields) {
    for (const [field, arr] of [
      ["TL", pt?.topLeft], ["TR", pt?.topRight],
      ["BL", pt?.bottomLeft], ["BC", pt?.bottomCenter], ["BR", pt?.bottomRight],
    ] as const) {
      // 空的 `TR:` 也要写：谱本拿空行把右侧的字往下顶（「戴克斯曲」印在第三行）
      for (const t of arr ?? []) for (const line of t.split(/\r?\n/)) L.push(`${field}:${line.trim()}`);
    }
    for (const r of song.style?.raw ?? []) {
      if (/^(fontsize|margin|space|off)$/i.test(r.key)) L.push(`${r.key}:${r.value}`);
    }
  }
  for (const r of song.remarks ?? []) for (const line of r.split(/\r?\n/)) if (isSafeRemark(line)) L.push(line.trim());
  return L;
}

// ───────────────────────── 音符与记号 ─────────────────────────

/** 模型里的记号名 → 文本谱的 `&xx`。原名（`SourceOrnament`，文本谱读进来的）原样写；
 *  别的来源只有 `notations` 那一侧的语义名，照 `xmlproject.ts` 的投影表反查。 */
const COMMAND_OF: Readonly<Record<string, string>> = {
  fermata: "yc",
  invertedfermata: "yc",
  tenuto: "bc",
  accent: "zy",
  // ABC 的装饰名（`!>!`、`!emphasis!`、`!uppermordent!`…，`j123/parse.ts` 原样存进 articulations）
  ">": "zy",
  emphasis: "zy",
  breath: "hx",
  uppermordent: "sby",
  pralltriller: "sby",
  lowermordent: "xby",
  "strong-accent": "zy",
  staccato: "dy",
  staccatissimo: "dy",
  "breath-mark": "hx",
  scoop: "shy",
  falloff: "xhy",
  "inverted-mordent": "sby",
  mordent: "xby",
  "trill-mark": "tr",
  trill: "tr",
  segno: "hs",
  coda: "ty",
  fine: "fine",
  "D.C.": "dc",
  "D.S.": "ds",
};
/** 文本谱认的记号名（`parse.ts` 的 NOTE_COMMANDS / BARLINE_COMMANDS）。不在表里的不写：写了读回也只是 unknown-command。 */
const PU_COMMANDS = new Set([
  "zkh", "ykh", ...Object.keys(DYNAMICS), ...Object.keys(TERMS),
  "yc", "ycy", "bc", "zy", "dy", "hx", "shy", "xhy", "sby", "xby", "cy", "tr",
  "fine", "dc", "ds", "ty", "hs", "sbf",
]);
/** 文字术语 → 记号名（MusicXML 的 `<words>rit.</words>`）。 */
const TERM_OF: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TERMS).map(([name, text]) => [text, name]),
);

function commandText(o: SourceOrnament): string {
  return `&${o.name}${"+".repeat(Math.max(0, o.level))}`;
}

/** 元素上的记号：原名优先；没有原名时从 `notations` 反查。 */
function ornamentsOf(el: { ornaments?: SourceOrnament[]; notations?: Chord["notations"] }): SourceOrnament[] {
  if (el.ornaments?.length) return el.ornaments.filter((o) => PU_COMMANDS.has(o.name));
  const out: SourceOrnament[] = [];
  const add = (name: string | undefined): void => {
    if (name && PU_COMMANDS.has(name) && !out.some((o) => o.name === name)) out.push({ name, level: 0 });
  };
  const n = el.notations;
  if (n?.fermata) add("yc");
  for (const a of n?.articulations ?? []) add(PU_COMMANDS.has(a) ? a : COMMAND_OF[a]);
  for (const o of n?.ornaments ?? []) add(PU_COMMANDS.has(o) ? o : COMMAND_OF[o]);
  return out;
}

/** 小节里的 `<direction>`（MusicXML / `.jpwabc` 来的力度与术语）→ 挂在第几个元素上的记号。 */
function directionCommands(mea: Measure): Map<number, SourceOrnament[]> {
  const out = new Map<number, SourceOrnament[]>();
  for (const dir of mea.directions ?? []) {
    let name: string | undefined;
    if (dir.type === "dynamics" && dir.text && dir.text in DYNAMICS) name = dir.text;
    else if (dir.type === "words" && dir.text) name = TERM_OF[dir.text.trim()] ?? COMMAND_OF[dir.text.trim()];
    else if (dir.type === "segno" || dir.type === "coda") name = COMMAND_OF[dir.type];
    if (!name) continue;
    const at = Math.min(dir.afterElements ?? 0, Math.max(0, mea.elements.length - 1));
    const list = out.get(at) ?? [];
    list.push({ name, level: 0 });
    out.set(at, list);
  }
  return out;
}

function accidentalChar(d: DialectSpec, acc: string | undefined): string {
  if (!acc) return "";
  const exact = Object.entries(d.accidentals).find(([, sem]) => sem === acc)?.[0];
  if (exact) return exact;
  // 没有重升重降写法的方言退成单个（音高差半音，好过整个丢掉）
  const single = acc === "double-sharp" ? "sharp" : acc === "double-flat" ? "flat" : undefined;
  return single ? Object.entries(d.accidentals).find(([, sem]) => sem === single)?.[0] ?? "" : "";
}

function octaveText(d: DialectSpec, shift: number | undefined): string {
  if (!shift) return "";
  return (shift > 0 ? d.octaveUp : d.octaveDown).repeat(Math.abs(shift));
}

/** 音符/休止本体（数字、变音、八度；不含时值）。变音写在数字**后方**（两家都是）。 */
function headText(ch: Chord, d: DialectSpec, anchored: boolean): string {
  if (ch.rhythm) return d.rhythmToken;
  if (ch.rest) {
    if (ch.printObject === false) return anchored ? "8" : d.emit.hiddenRestNoLyric ?? "0";
    return "0" + octaveText(d, ch.rest.octaveShift);
  }
  const deg = topNote(ch)?.degree;
  if (!deg) return "0";
  return String(deg.number) + accidentalChar(d, deg.accidental) + octaveText(d, deg.octaveShift);
}

function durationText(beams: number, dots: number): string {
  return "/".repeat(beams) + ".".repeat(dots);
}

/** 倚音串里的一个音。**减时线少写一条**：倚音的基准时值是八分（`scanGraceNotes` 里 `scanNote(…, 8)`）。 */
function graceText(ch: Chord, d: DialectSpec): string {
  return headText(ch, d, false) + "/".repeat(Math.max(0, (ch.beams?.length ?? 1) - 1));
}

// ───────────────────────── 弧线与多连音的写法规划 ─────────────────────────

interface ArcPlan {
  /** 元素 id → 写在它前面的开口（按顺序，`(` 或 `(y`） */
  opens: Map<ElementId, string[]>;
  /** 元素 id → 紧跟它的 `)` 个数 */
  closes: Map<ElementId, number>;
  /** 渐强渐弱：id → 写在它后面的 `<`/`>` 与 `!` */
  wedgeStart: Map<ElementId, string[]>;
  wedgeEnd: Map<ElementId, number>;
  /** 写不出来、只好丢掉的弧/多连音条数（真嵌套，或多连音的比例不是 n:n−1） */
  dropped: { nested: number; oddTuplet: number };
  /** 落在多连音里的元素位次（自动补的 `~`/`^` 会算进多连音的元素个数，不能往里插） */
  inTuplet: Set<number>;
}

/**
 * 弧线（含延音线）与多连音 → 括号。文本谱的 `)` 是 `curves.shift()`（**先开先闭**），
 * 所以两条弧只要「先开的先收」就写得出来；一条完全包住另一条（后开的先收）写不出来。
 * 按优先级挑：多连音（管时值）> 延音线（管发声）> 圆滑线（只管画），挑不进来的丢掉。
 * 多连音另有一条：文本谱里 n 个符号的多连音一律占 n−1 个基本时值，别的比例写不出来。
 */
function planArcs(marks: readonly Mark[], pos: ReadonlyMap<ElementId, number>): ArcPlan {
  const plan: ArcPlan = {
    opens: new Map(), closes: new Map(), wedgeStart: new Map(), wedgeEnd: new Map(),
    dropped: { nested: 0, oddTuplet: 0 }, inTuplet: new Set(),
  };
  const PRIO: Partial<Record<Mark["type"], number>> = { tuplet: 0, tied: 1, slur: 2 };
  type Arc = { m: Mark; s: number; e: number };
  const cands: Arc[] = [];
  for (const m of marks) {
    const s = pos.get(m.start);
    const e = pos.get(m.end);
    if (s === undefined || e === undefined || e < s) continue;
    if (m.type === "wedge") {
      if (e === s) continue;
      const sign = (m.wedgeType === "diminuendo" ? ">" : "<") + "+".repeat(m.level ?? 0);
      const list = plan.wedgeStart.get(m.start) ?? [];
      list.push(sign);
      plan.wedgeStart.set(m.start, list);
      plan.wedgeEnd.set(m.end, (plan.wedgeEnd.get(m.end) ?? 0) + 1);
      continue;
    }
    if (PRIO[m.type] === undefined) continue;
    if (m.collapsed) continue;
    if (m.type === "tuplet") {
      // 没写显示数字的（文本谱读进来的就是这种）本来就是 n:n−1，不必校验
      const n = e - s + 1;
      const odd = m.tupletActual !== undefined && (m.tupletActual !== n || (m.tupletNormal ?? 2) !== n - 1);
      if (n < 2 || odd) {
        plan.dropped.oddTuplet++;
        continue;
      }
    }
    cands.push({ m, s, e });
  }
  cands.sort((a, b) => PRIO[a.m.type]! - PRIO[b.m.type]! || a.s - b.s || a.e - b.e);
  const kept: Arc[] = [];
  // 先开的必须不晚于后开的收（同一处开的，先收的先开——下面按终点排开口顺序）
  const fits = (a: Arc, b: Arc): boolean => {
    if (a.e < b.s || b.e < a.s || a.s === b.s) return true;
    const [x, y] = a.s < b.s ? [a, b] : [b, a];
    return x.e <= y.e;
  };
  for (const c of cands) {
    if (kept.every((k) => fits(k, c))) kept.push(c);
    else if (c.m.type === "tuplet") plan.dropped.oddTuplet++;
    else plan.dropped.nested++;
  }
  kept.sort((a, b) => a.s - b.s || a.e - b.e || PRIO[a.m.type]! - PRIO[b.m.type]!);
  for (const k of kept) {
    const list = plan.opens.get(k.m.start) ?? [];
    list.push(k.m.type === "tuplet" ? "(y" : "(");
    plan.opens.set(k.m.start, list);
    plan.closes.set(k.m.end, (plan.closes.get(k.m.end) ?? 0) + 1);
    if (k.m.type === "tuplet") for (let p = k.s + 1; p <= k.e; p++) plan.inTuplet.add(p);
  }
  return plan;
}

// ───────────────────────── 一行曲 ─────────────────────────

/** 对位格：这个位置跟不跟词、跟的是哪几个字。 */
interface Slot {
  lyrics: readonly Lyric[] | undefined;
}

/** 写哪些元素：倚音另写进 `"yy:"`、无时值占位 `y` 没有写法；和弦只写简谱印的那一路（同 123）。 */
function isStreamElement(el: Element, mea: Measure): boolean {
  if (el.kind === "space") return el.spacer === "x";
  if (el.grace) return false;
  const lane = melodyLane(mea);
  return !lane || (el.staff === lane.staff && el.voice === lane.voice);
}

const hasText = (ls: readonly Lyric[] | undefined): boolean =>
  !!ls?.some((l) => l.text !== "" || !!l.trailingPunctuation);

/** 文本谱里这个和弦跟不跟词：音符一律跟（写不出「不跟」）；休止缺省不跟，`lyricAnchor` 或带着字才跟。 */
function chordAnchored(ch: Chord): boolean {
  if (ch.continued) return ch.lyricAnchor ?? (!ch.rest || !!ch.rhythm);
  if (!ch.rest || ch.rhythm) return true;
  return ch.lyricAnchor === true || hasText(ch.lyrics);
}

/** 声部级的写出状态：跨行接着用的都在这儿。 */
interface PartState {
  d: DialectSpec;
  plan: ArcPlan;
  /** 元素 id → 全声部写出位次（弧的规划与「落在多连音里」要它） */
  pos: Map<ElementId, number>;
  /** 房号起头 → 它的收尾是不是不封口（番茄的 `/` 写在起头那一端） */
  voltaOpenEnd: WeakMap<NonNullable<Barline["ending"]>, boolean>;
  /** 已开未收的房号 */
  openVoltas: number;
  /** 当前生效的拍号（曲中转拍写 `"p:3/4"`；减时线连断的拍位也按它算） */
  time: Time | undefined;
  /** 是否由写出端补 `~`/`^`（原文就有连断记号的——文本谱读进来的——照原样写，不补） */
  autoBoundaries: boolean;
  /** 已经并到上一小节右线里写掉的左线 */
  consumedLeft: Set<Barline>;
  /** 没有收尾记号的房号由写出端收口（新房号起头处、曲末）。123/ABC 的 `[1 … [2` 靠下一个房号收前一个；
   *  文本谱读进来的不收——原文里就开着的房号照原样开着 */
  closeOpenVoltas: boolean;
  /** 上一行开口收尾的那个小节写到的拍位（续行接着算） */
  carryBeat: number;
}

/** 小节线类型（`frompu.ts::fromPuBarline` 的逆）。只有房号、没有线的返回 null。 */
function barlineType(b: Barline): BarlineType | null {
  if (b.repeat === "backward") return b.alsoForward ? "repeat-both" : "repeat-end";
  if (b.repeat === "forward") return "repeat-start";
  switch (b.style) {
    case undefined: return null;
    case "light-heavy": case "heavy-heavy": return "end";
    case "light-light": case "heavy-light": return "double";
    case "none": return b.noWidth ? "hidden" : "invisible";
    default: return "normal";
  }
}

/** 小节线类型 → 该方言的写法。方言表按「从长到短」排，这里反查、取**最后**一条匹配：
 *  同一种线有几种写法时，长的那些是规范外写法（只认不写），为了切得开才排在前面——
 *  诗歌本的复纵线 `||/` 排在 `||` 前、番茄的反复线 `:||` 排在 `:|` 前。 */
function barlineCode(d: DialectSpec, type: BarlineType): string {
  const found = [...d.barlines].reverse().find(([, t]) => t === type);
  return found ? found[0] : "|";
}

/** 一行里的片段：写出时按方言的 `tokenGap` 连起来。 */
class Line {
  readonly tokens: string[] = [];
  push(s: string): void {
    if (s) this.tokens.push(s);
  }
  /** 贴在上一个片段后面（记号、注释、收弧） */
  glue(s: string): void {
    if (!s) return;
    if (this.tokens.length) this.tokens[this.tokens.length - 1] += s;
    else this.tokens.push(s);
  }
  get empty(): boolean {
    return this.tokens.length === 0;
  }
  text(gap: string): string {
    return this.tokens.join(gap);
  }
}

function quoted(s: string): string {
  return `"${s.replace(/"/g, "'")}"`;
}

/** `before` 上的夹层：`~`/`^` 连断、`{bz…}`/`{dsb…}` 临时层。 */
function writeInline(items: readonly InlineItem[] | undefined, line: Line, st: PartState): void {
  for (const it of items ?? []) {
    if (it.kind === "boundary") {
      line.push(it.behavior === "join" ? "~" : "^");
      continue;
    }
    // 临时层是一段自带小节与记号的独立元素流：按主旋律的写法写一遍，弧的规划各算各的
    const sub = new Line();
    const pos = new Map<ElementId, number>();
    let p = 0;
    for (const m of it.measures) {
      for (const el of m.elements) {
        pos.set(el.id, p++);
        if (el.kind === "chord") for (const su of el.sustains ?? []) pos.set(su.id, p++);
      }
    }
    const subSt: PartState = {
      ...st, plan: planArcs(it.marks, pos), pos, openVoltas: 0, autoBoundaries: false, consumedLeft: new Set(),
    };
    it.measures.forEach((m, mi) => {
      writeMeasureBody(m, 0, Infinity, sub, subSt, []);
      writeRightBarline(it.measures, mi, sub, subSt, true);
    });
    line.push(`{${it.role === "voice" ? "dsb" : "bz"}${sub.text(" ")}}`);
  }
}

/** 一个可跟弧/记号的符号收尾：跟词翻转、记号、注释、收弧、渐强渐弱。 */
function writeTail(
  id: ElementId,
  host: { ornaments?: SourceOrnament[]; notations?: Chord["notations"]; harmony?: Chord["harmony"]; sectionWord?: string },
  line: Line,
  st: PartState,
  opts: { at: boolean; extra?: readonly SourceOrnament[]; quotes?: readonly string[] },
): void {
  if (opts.at) line.glue("@");
  for (const o of [...ornamentsOf(host), ...(opts.extra ?? [])]) line.glue(commandText(o));
  if (host.harmony) {
    const text = harmonyText(host.harmony);
    if (text) line.glue(quoted(`hx:${text}`));
  }
  if (host.sectionWord) line.glue(quoted(host.sectionWord));
  for (const q of opts.quotes ?? []) line.glue(q);
  for (const w of st.plan.wedgeStart.get(id) ?? []) line.glue(w);
  line.glue(")".repeat(st.plan.closes.get(id) ?? 0));
  line.glue("!".repeat(st.plan.wedgeEnd.get(id) ?? 0));
}

/** 本小节第 `from`–`to` 个元素（系统切在小节中间时只写一段）。对位格按写出顺序收进 `slots`。
 *  `startBeat`：小节开头的拍位——上一行开口收尾的小节在这一行接着写时，拍位要接着算（同 `pu/layout.ts` 的 `carryIn`），
 *  否则读回来成了两个小节、续行从 0 重算，补的连断记号就落到别处去了。
 *  @returns 写到的末尾拍位 */
function writeMeasureBody(
  mea: Measure, from: number, to: number, line: Line, st: PartState, slots: Slot[], startBeat = 0,
): number {
  const d = st.d;
  const dirs = directionCommands(mea);
  const mids = (mea.barlines ?? []).filter((b) => b.location === "middle");
  let midIdx = 0;
  /** 等着挂到下一个音上的前倚音、`y` 占位上的和弦 */
  let pendingGrace: Chord[] = [];
  let pendingHarmony: Chord["harmony"];
  /** 上一个写出的主音：后倚音 `"hyy:…"` 挂它 */
  let lastMain = -1;
  // 减时线连断（照诗歌本谱本的范式，见 `writeBoundary`）
  let beat = startBeat;
  let prev: { beams: number; beat: number } | null = null;
  let syncopated = false;
  const groupBeats = st.time && st.time.beatType === 8 && st.time.beats % 3 === 0 ? 1.5 : 1;

  for (const [j, el] of mea.elements.entries()) {
    const dur = (el.kind === "chord" ? el.duration.divisions : el.duration?.divisions ?? 0) / SIMPLE_DIVISIONS;
    if (j < from || j >= to) {
      if (el.kind === "chord" && !el.grace) beat += dur;
      continue;
    }
    while (midIdx < mids.length && (mids[midIdx]!.afterElements ?? 0) <= j) {
      const t = barlineType(mids[midIdx]!);
      if (t) line.push(barlineCode(d, t));
      midIdx++;
    }
    if (el.kind === "chord" && el.grace) {
      if (el.grace.after && lastMain >= 0) {
        line.tokens[lastMain] += quoted(`hyy:${graceText(el, d)}`);
      } else if (!el.grace.after) {
        pendingGrace.push(el);
      }
      continue;
    }
    if (el.kind === "space" && el.spacer === "y") {
      pendingHarmony ??= el.harmony;
      continue;
    }
    if (!isStreamElement(el, mea)) continue;
    const p = st.pos.get(el.id) ?? -1;
    const beams = el.beams?.length ?? 0;

    if (el.kind === "chord") writeInline(el.before, line, st);
    // 自动补的连断：两边都带减时线才有线可连断
    if (st.autoBoundaries && prev && prev.beams > 0 && beams > 0 && !st.plan.inTuplet.has(p)) {
      const sameBeat = Math.floor(prev.beat + 1e-9) === Math.floor(beat + 1e-9);
      if (groupBeats !== 1) {
        const g = Math.floor(beat / groupBeats + 1e-9);
        if (Math.floor(prev.beat / groupBeats + 1e-9) !== g) {
          if (sameBeat) line.push("^");
        } else if (Math.floor(prev.beat - g * groupBeats + 1e-9) !== Math.floor(beat - g * groupBeats + 1e-9)) {
          line.push("~");
        }
      } else if (syncopated && prev.beams !== beams && !sameBeat) {
        line.push("^");
      }
    }
    prev = { beams, beat };
    const end = beat + dur;
    if (beat % 1 !== 0 && Math.floor(beat + 1e-9) !== Math.floor(end - 1e-9)) syncopated = true;
    beat = end;

    const opens = (st.plan.opens.get(el.id) ?? []).join("");
    const extra = dirs.get(j) ?? [];
    if (el.kind === "space") {
      // 不可见休止 `x`：文本谱的隐藏休止 `8` 跟词
      line.push(opens + "8" + durationText(beams, el.duration?.dots ?? 0));
      slots.push({ lyrics: el.lyrics });
      writeTail(el.id, { ...el, harmony: el.harmony ?? pendingHarmony }, line, st, { at: false, extra });
      pendingHarmony = undefined;
      continue;
    }
    const ch = el;
    const anchored = chordAnchored(ch);
    const graceQuote = pendingGrace.length ? [quoted(`yy:${pendingGrace.map((g) => graceText(g, d)).join(" ")}`)] : [];
    pendingGrace = [];
    // 收弧的 `)` 紧跟音符**本体**，附点写在括号外（`(1.1).` 而不是 `(1.1.)`，谱本的写法；
    // 增时线本来就在括号之后，两者口径一致）。读回来落单的 `.` 照样补给这个音
    const tailDots = (st.plan.closes.get(ch.id) ?? 0) > 0 ? ch.duration.dots : 0;
    if (ch.continued) {
      // 承接前音的延长：行首/小节线后的 `-`，读回来就是它
      line.push(opens + "-");
    } else {
      line.push(opens + headText(ch, d, anchored) + durationText(beams, ch.duration.dots - tailDots));
    }
    lastMain = line.tokens.length - 1;
    if (anchored) slots.push({ lyrics: ch.lyrics });
    // `@` 翻的是缺省：休止与承接的 `-` 缺省不跟词
    const at = anchored && (ch.continued || (!!ch.rest && !ch.rhythm && ch.printObject !== false));
    const host = ch.harmony || !pendingHarmony ? ch : { ...ch, harmony: pendingHarmony };
    pendingHarmony = undefined;
    writeTail(ch.id, host, line, st, { at, extra, quotes: graceQuote });
    line.glue(".".repeat(tailDots));
    for (const su of ch.sustains ?? []) writeSustain(su, line, st, slots);
  }
  // 小节末没等到主音的前倚音：挂到最后一个主音后面当后倚音，别丢
  if (pendingGrace.length && lastMain >= 0) {
    line.tokens[lastMain] += quoted(`hyy:${pendingGrace.map((g) => graceText(g, d)).join(" ")}`);
  }
  if (to >= mea.elements.length) {
    for (; midIdx < mids.length; midIdx++) {
      const t = barlineType(mids[midIdx]!);
      if (t) line.push(barlineCode(d, t));
    }
    writeInline(mea.trailing, line, st);
  }
  return beat;
}

function writeSustain(su: Sustain, line: Line, st: PartState, slots: Slot[]): void {
  writeInline(su.before, line, st);
  line.push((st.plan.opens.get(su.id) ?? []).join("") + "-");
  const anchored = su.lyricAnchor === true || hasText(su.lyrics);
  if (anchored) slots.push({ lyrics: su.lyrics });
  writeTail(su.id, su, line, st, { at: anchored });
}

/** 房号起头的写法：`["1."`（`+` 抬高），番茄不封口的 `/` 也写在这一头。 */
function voltaOpenText(e: NonNullable<Barline["ending"]>, st: PartState): string {
  let s = "[" + "+".repeat(e.level ?? 0);
  if (!e.captionless) s += quoted(e.text ?? e.numbers.join(","));
  if (st.d.emit.voltaOpenEnd === "start" && st.voltaOpenEnd.get(e)) s += "/";
  return s;
}

/** 本小节的左线（只有房号的不算线）与房号起头。左线已并进上一小节右线的就不再写。 */
function writeLeft(mea: Measure, line: Line, st: PartState): void {
  const lefts = (mea.barlines ?? []).filter((b) => b.location === "left");
  for (const b of lefts) {
    if (st.consumedLeft.has(b)) continue;
    const t = barlineType(b);
    const orns = (b.ornaments ?? []).map(commandText).join("");
    if (t) {
      writeInline(b.before, line, st);
      line.push(barlineCode(st.d, t) + orns);
    } else if (orns) {
      // 只挂着跳转记号的左线（123 的 `!segno!` 写在小节头）：挂到上一根线上；行首没有线可挂就补一条虚拟线立住它
      if (line.empty) line.push(barlineCode(st.d, "hidden") + orns);
      else line.glue(orns);
    }
  }
  for (const b of lefts) {
    const e = b.ending;
    if (!e || e.type !== "start" || e.collapsed || e.danglingLead) continue;
    // 新房号起头就是上一个房号的尽头（ABC 的 `[1 … [2`，前一个没有结束线收）：先收掉，别叠成嵌套
    closeVoltas(line, st);
    if (st.d.emit.voltaLeadBarline && line.empty) line.push(barlineCode(st.d, "hidden"));
    line.push(voltaOpenText(e, st));
    st.openVoltas++;
  }
}

/** 收掉所有开着的房号：收在刚写完的那根小节线所在的小节上。
 *  番茄的 `]` 写在线**前**（与有收尾记号的房号同一写法，往返才幂等），诗歌本写在线后。 */
function closeVoltas(line: Line, st: PartState): void {
  if (st.openVoltas <= 0 || !st.closeOpenVoltas) return;
  const text = "]".repeat(st.openVoltas);
  st.openVoltas = 0;
  if (st.d.emit.voltaCloseAfterBarline) {
    line.glue(text);
    return;
  }
  const last = line.tokens.length - 1;
  if (last >= 0 && /^[|:]/.test(line.tokens[last]!)) line.tokens.splice(last, 0, text);
  else line.push(text);
}

/** 第 `mi` 小节的右线。文本谱没有左线：下一小节的 `|:` 并到这里写（`:|` + `|:` = `:|:`）。
 *  `lineEnd`：这是本行最后一小节——没有右线时就开口收尾，接下一行（不凭空补线）。
 *  @returns 是否开口收尾（没写线） */
function writeRightBarline(measures: readonly Measure[], mi: number, line: Line, st: PartState, lineEnd: boolean): boolean {
  const d = st.d;
  const mea = measures[mi]!;
  const rights = (mea.barlines ?? []).filter((b) => b.location === "right");
  const bar = rights.find((b) => barlineType(b) !== null);
  const next = measures[mi + 1];
  const nextLeft = next?.barlines?.find((b) => b.location === "left" && barlineType(b) !== null);
  let type = bar ? barlineType(bar) : null;
  if (nextLeft) {
    const lt = barlineType(nextLeft)!;
    if (lt === "repeat-start") type = type === "repeat-end" || type === "repeat-both" ? "repeat-both" : "repeat-start";
    else if (type === null || type === "normal") type = lt;
    st.consumedLeft.add(nextLeft);
  }
  // 房号收尾：番茄写在线前（`3 ] |`），诗歌本写在线后（`3|]`）
  const stops = rights.filter((b) => b.ending && (b.ending.type === "stop" || b.ending.type === "discontinue"));
  let closeText = "";
  for (const b of stops) {
    if (st.openVoltas <= 0) break;
    st.openVoltas--;
    closeText += "]" + (b.ending!.type === "discontinue" && d.emit.voltaOpenEnd === "end" ? "/" : "");
  }
  if (closeText && !d.emit.voltaCloseAfterBarline) {
    line.push(closeText);
    closeText = "";
  }
  // 曲中转拍：`"p:3/4"` 写在线后面，自下一小节起生效
  const nextTime = next?.attrs?.time;
  const meter = bar?.time ?? (nextTime && (!st.time || nextTime.beats !== st.time.beats || nextTime.beatType !== st.time.beatType) ? nextTime : undefined);
  if (type === null && !lineEnd && next) type = "normal";
  if (type === null && meter) type = "hidden";
  if (type !== null) {
    if (bar) writeInline(bar.before, line, st);
    let s = barlineCode(d, type);
    s += closeText;
    for (const o of [...(bar?.ornaments ?? []), ...(nextLeft?.ornaments ?? [])]) s += commandText(o);
    if (meter) s += quoted(`p:${meter.beats}/${meter.beatType}`);
    if (bar?.annotation) s += quoted(bar.annotation);
    line.push(s);
  } else if (closeText) {
    line.glue(closeText);
  }
  if (nextTime) st.time = nextTime;
  // 曲末还开着的房号（没有结束线收）：就地收口，免得一直开到下一首
  if (!next) closeVoltas(line, st);
  return type === null;
}

// ───────────────────────── 歌词行 ─────────────────────────

const CJK_ONE = /^[぀-ヿ㐀-鿿豈-﫿]$/u;
/** 读入端会贴回前一字、不占音符位的收尾字符（`parse.ts::parseLyricBody`）。 */
const TRAILING_OK = PU_LYRIC_PUNCTUATION + "”’\"）)";

/**
 * 一个音节 → 文本谱写法。
 *
 * 只有「单个汉字」与「纯 ASCII 单词」能裸写：前者一字一音符，后者被解析端整段收成一个音节。
 * 其余一律用两方言通用的并字括号 `{}` 裹住，取其**原样收一个音节**的语义——
 * 多字裸写会被拆成几个音节、整行对位错开；`-` `0` `^` `|` 在歌词行里是要被跳过的记号，裸写会被吞掉。
 * 尾部标点写在括号外——解析端会把它贴到前一字上，不占音符位。
 */
function lyricToken(l: Lyric): string {
  let core = ((l.leadingPunctuation ?? "") + l.text).replace(/[{}]/g, "");
  let tail = l.trailingPunctuation ?? "";
  if ([...tail].some((c) => !TRAILING_OK.includes(c))) {
    core += tail;
    tail = "";
  }
  // 字里连着的收尾标点（`.jpwabc` 的「恶，」）也拆到括号外：读回来照样贴在这个字上
  while (core.length > 1 && TRAILING_OK.includes(core[core.length - 1]!)) {
    tail = core[core.length - 1]! + tail;
    core = core.slice(0, -1);
  }
  if (!core) return tail ? `{${tail}}` : "";
  const plain = CJK_ONE.test(core) || /^[A-Za-z']+$/.test(core);
  return (plain ? core : `{${core}}`) + tail;
}

/** 一行歌词的版式：段号区间、印刷段号、间隙、联合括号。 */
interface LyricSpec {
  from: number;
  to: number;
  label?: string;
  gap: number;
  joinBrace: boolean;
  /** 同一段号在本行出现多行时，这是第几行（`Lyric.lineIndex`，文本谱读进来的） */
  lineIndex?: number;
  /** 别的来源同一格同一段挂了几个字（`.jpwabc` 同一段写了两行词）：这一行取第几个 */
  nth?: number;
}

/** 本行要写哪几行歌词：文本谱读进来的按原来的行版式（`Print.lyricLines`）；别的来源按字上的段号归行。 */
function lyricSpecs(slots: readonly Slot[], infos: readonly LyricLineInfo[] | undefined): LyricSpec[] {
  if (infos?.length) {
    const key = (i: LyricLineInfo): string => `${i.verseFrom}-${i.verseTo}`;
    const counts = new Map<string, number>();
    for (const i of infos) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1);
    return infos.map((i, idx) => ({
      from: i.verseFrom,
      to: i.verseTo,
      ...(i.annotation !== undefined ? { label: i.annotation } : {}),
      gap: i.annotationGap,
      joinBrace: !!i.joinBrace,
      ...(counts.get(key(i))! > 1 ? { lineIndex: idx } : {}),
    }));
  }
  const specs = new Map<string, LyricSpec>();
  for (const s of slots) {
    const seen = new Map<string, number>();
    for (const l of s.lyrics ?? []) {
      if (l.text === "" && !l.trailingPunctuation) continue;
      const to = l.numberTo ?? l.number;
      const range = `${l.number}-${to}`;
      const nth = seen.get(range) ?? 0;
      seen.set(range, nth + 1);
      const k = `${range}#${nth}`;
      let spec = specs.get(k);
      if (!spec) specs.set(k, (spec = { from: l.number, to, gap: 20, joinBrace: false, ...(nth ? { nth } : {}) }));
      if (spec.label === undefined && l.verseLabel !== undefined) spec.label = l.verseLabel;
    }
  }
  return [...specs.values()].sort((a, b) => a.from - b.from || a.to - b.to || (a.nth ?? 0) - (b.nth ?? 0));
}

function lyricLine(slots: readonly Slot[], spec: LyricSpec, single: boolean, d: DialectSpec): string | null {
  const skip = d.lyricSkip[0] ?? "@";
  const pieces: string[] = [];
  let pendingSkips = 0;
  let any = false;
  let prev = "";
  for (const s of slots) {
    const hit = s.lyrics?.filter((l) =>
      l.number === spec.from && (l.numberTo ?? l.number) === spec.to &&
      (spec.lineIndex === undefined || l.lineIndex === undefined || l.lineIndex === spec.lineIndex))[spec.nth ?? 0];
    const tok = hit ? lyricToken(hit) : "";
    if (!tok) {
      pendingSkips++;
      continue;
    }
    // 空位先攒着，后面真有字了再落下去（行尾的空位不必写）
    if (pendingSkips) {
      pieces.push(skip.repeat(pendingSkips));
      prev = skip;
      pendingSkips = 0;
    }
    // ASCII 单词紧挨着会被并成一个音节
    if (/[A-Za-z']$/.test(prev) && /^[A-Za-z']/.test(tok)) pieces.push(d.wordSeparator);
    pieces.push(tok);
    prev = tok;
    any = true;
  }
  if (!any) return null;
  let body = pieces.join("");
  // 行末的 `}` 会被读成联合括号：真要的照写，不要的补一个跳字符隔开
  if (spec.joinBrace) body += "}";
  else if (body.endsWith("}")) body += skip;
  const num = single && spec.from === 1 && spec.to === 1 ? "" : `${spec.from}${spec.to !== spec.from ? `-${spec.to}` : ""}`;
  let label = "";
  if (spec.label !== undefined) {
    const [open, close] = d.emit.labelWrap;
    const enc = spec.label.replace(/ /g, "_").replace(/@/g, "%40").replace(/["<>]/g, "");
    label = open + enc + (spec.gap !== 20 ? `%${spec.gap}` : "") + close;
  }
  return `C${num}:${label}${body}`;
}

// ───────────────────────── 整首 ─────────────────────────

/** 写出顺序里的位次：主旋律上的和弦、不可见休止、增时线各占一位（倚音与 `y` 不占）。 */
function positions(part: Part): Map<ElementId, number> {
  const pos = new Map<ElementId, number>();
  let p = 0;
  for (const mea of part.measures) {
    for (const el of mea.elements) {
      if (!isStreamElement(el, mea)) continue;
      pos.set(el.id, p++);
      if (el.kind === "chord") for (const su of el.sustains ?? []) pos.set(su.id, p++);
    }
  }
  return pos;
}

/** 房号起头 → 收尾是不是不封口。按 `pair` 配；没有配对号的按先后（后开的先收，同解析端的栈）。 */
function voltaEnds(part: Part): WeakMap<NonNullable<Barline["ending"]>, boolean> {
  const out = new WeakMap<NonNullable<Barline["ending"]>, boolean>();
  const open: NonNullable<Barline["ending"]>[] = [];
  for (const mea of part.measures) {
    for (const b of mea.barlines ?? []) {
      const e = b.ending;
      if (!e) continue;
      if (e.type === "start") {
        open.push(e);
        continue;
      }
      const at = e.pair !== undefined ? open.findIndex((s) => s.pair === e.pair) : open.length - 1;
      if (at < 0) continue;
      out.set(open[at]!, e.type === "discontinue");
      open.splice(at, 1);
    }
  }
  return out;
}

/** 兜底断行：按乐句断不出来时每几小节一行（简谱里一句最常见的长度）。 */
const FALLBACK_MEASURES_PER_LINE = 4;

/** 模型里没有任何行结构的曲子（ABC 整首写在一行里、不带 `<print new-system>` 的 MusicXML）：先按乐句断行——
 *  文本谱一行 `Q:` 就是谱面一行、不自动断行，不断就是一整首挤在一行里。
 *  乐句断不出来的（断句按歌词的收尾标点，MusicXML 的字常把标点连在字里、认不出）每 4 小节断一行。 */
function withLines(song: Song): Song {
  const part = song.parts[0];
  if (!part || part.measures.length <= 8) return song;
  const hasBreaks = (s: Song): boolean => {
    const p = s.parts[0]!;
    return p.measures.some((m, i) => i > 0 && (m.print?.newSystem || m.print?.newPage)) ||
      p.measures.some((m) => m.elements.some((el) => el.kind === "chord" && !!el.lineBreakAfter));
  };
  if (hasBreaks(song)) return song;
  const doc: ScoreDoc = { sourceFormat: "123", songs: [structuredClone(song)], diagnostics: [] };
  const phrased = doc.songs[0]!;
  if (relayoutDocBreaks(doc, { measure: null, midBreaks: "snap" }) && hasBreaks(phrased)) return phrased;
  for (const p of phrased.parts) {
    p.measures.forEach((m, i) => {
      if (i > 0 && i % FALLBACK_MEASURES_PER_LINE === 0) m.print = { ...m.print, newSystem: true };
    });
  }
  return phrased;
}

/** 简谱形状的歌：音高要有度数。MusicXML 来的只有绝对音高时补上（在克隆上补，模型本身不动）。 */
function withDegrees(song: Song): Song {
  const missing = song.parts.some((p) => p.measures.some((m) => m.elements.some((el) =>
    el.kind === "chord" && el.notes.some((n) => n.pitch && !n.degree))));
  if (!missing) return song;
  const copy = structuredClone(song);
  fillDegreesFromPitch(copy);
  return copy;
}

/** 这首歌转成文本谱时写不出来的弧线与多连音（给丢失清单用，判据与写出时同一份）。 */
export function puArcLosses(src: Song): { nested: number; oddTuplet: number } {
  const song = projectForJianpu(src);
  const out = { nested: 0, oddTuplet: 0 };
  for (const part of song.parts) {
    const own = ownIds(part, (el, mi) => isStreamElement(el, part.measures[mi]!));
    const plan = planArcs(ownMarks(song, own), positions(part));
    out.nested += plan.dropped.nested;
    out.oddTuplet += plan.dropped.oddTuplet;
  }
  return out;
}

/** 声部行首：`Q` + 变体 + 声部号 + 声部名 + `:`。 */
function qPrefix(song: Song, pi: number, first: Measure | undefined, firstSystem: boolean, d: DialectSpec): string {
  const [open, close] = d.emit.labelWrap;
  const caption = first?.print?.caption ?? (firstSystem ? song.parts[pi]?.name : undefined);
  const num = song.parts.length > 1 ? String(pi + 1) : "";
  const cap = caption ? open + caption.replace(/["<>]/g, "") + close : "";
  return `Q${first?.print?.variant ?? ""}${num}${cap}:`;
}

export interface EmitPuOptions {
  /** 模型来自文本谱本身（`ScoreDoc.sourceFormat === "pu"`）：照原文的写法还原，不替它收口房号 */
  fromPu?: boolean;
  /** 模型来自 ABC：`X:` 是文件内编号、不是曲号 */
  fromAbc?: boolean;
}

/** 一首歌 → 文本谱原文（不带结尾换行）。 */
export function emitPuSong(src: Song, dialect: Dialect, opts: EmitPuOptions = {}): string {
  const d = dialectSpec(dialect);
  const song = withDegrees(withLines(projectForJianpu(src)));
  const L = headerLines(song, d, opts);
  if (d.emit.blankBetweenGroups) L.push("");

  // 原文就有连断记号的（文本谱读进来的）照原样写；别的来源由写出端按拍补
  const hasBoundaries = song.parts.some((p) => p.measures.some((m) => m.elements.some((el) =>
    el.kind === "chord" && (el.before ?? []).some((it) => it.kind === "boundary"))));
  const states = song.parts.map((part): PartState => {
    const own = ownIds(part, (el, mi) => isStreamElement(el, part.measures[mi]!));
    const pos = positions(part);
    return {
      d, plan: planArcs(ownMarks(song, own), pos), pos, voltaOpenEnd: voltaEnds(part), openVoltas: 0,
      time: song.time, autoBoundaries: !hasBoundaries, consumedLeft: new Set(), closeOpenVoltas: !opts.fromPu, carryBeat: 0,
    };
  });

  const ranges = systemRanges(song.parts[0]);
  ranges.forEach((range, ri) => {
    const group: string[] = [];
    song.parts.forEach((part, pi) => {
      const sys: SystemRange = pi === 0 ? range : { ...range, fromEl: 0, toEl: Infinity };
      const st = states[pi]!;
      const last = Math.min(sys.to, part.measures.length - 1);
      if (sys.from > last) return;
      const first = part.measures[sys.from];
      if (pi === 0 && ri > 0 && first?.print?.newPage && sys.fromEl === 0) group.push("[fenye]");
      // 系统上方的说明文字行（`W:`）挂在该系统第一个声部的首小节
      if (pi === 0 && sys.fromEl === 0) for (const t of first?.print?.texts ?? []) pushField(group, "W", t);
      const line = new Line();
      const slots: Slot[] = [];
      for (let mi = sys.from; mi <= last; mi++) {
        const mea = part.measures[mi]!;
        const fromEl = mi === sys.from ? sys.fromEl : 0;
        const toEl = mi === sys.to ? sys.toEl : Infinity;
        if (fromEl === 0) writeLeft(mea, line, st);
        const end = writeMeasureBody(mea, fromEl, toEl, line, st, slots, fromEl === 0 ? st.carryBeat : 0);
        st.carryBeat = 0;
        if (toEl >= mea.elements.length && writeRightBarline(part.measures, mi, line, st, mi === last)) st.carryBeat = end;
      }
      if (line.empty) return;
      group.push(qPrefix(song, pi, first, ri === 0, d) + line.text(d.emit.tokenGap));
      const infos = sys.fromEl === 0 && song.parts.length && first?.print?.lyricLines;
      const specs = lyricSpecs(slots, infos || undefined);
      for (const spec of specs) {
        const text = lyricLine(slots, spec, specs.length === 1, d);
        if (text !== null) group.push(text);
      }
    });
    if (!group.length) return;
    L.push(...group);
    if (d.emit.blankBetweenGroups) L.push("");
  });
  while (L.length && L[L.length - 1] === "") L.pop();
  return L.join("\n");
}

/** 整份文档 → 文本谱原文。多首之间用整行 `-----` 分隔（两家的解析端都认）。 */
export function emitPu(doc: ScoreDoc, dialect: Dialect): string {
  const opts: EmitPuOptions = { fromPu: doc.sourceFormat === "pu", fromAbc: doc.sourceFormat === "abc" };
  return doc.songs.map((s) => emitPuSong(s, dialect, opts)).join("\n-----\n") + "\n";
}
