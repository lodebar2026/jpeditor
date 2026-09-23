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
// 小节中间换行（源文写明的）拆成两个小节、中间隐藏线（`splitInlineBreaks`）。
//
// 已知不表达：承接前音的增时线（`Chord.continued`）按普通音符写、不补 tie；
// 挂在增时线上的歌词（文本谱 `-@`）与记号不写——MusicXML 里增时线不是独立的音符。

import type {
  Barline, BeamVal, Chord, Direction, Element, ElementId, Lyric, Mark, Measure, Notations, Part,
  SourceOrnament, Song,
} from "./doc";
import { SIMPLE_DIVISIONS } from "./doc";
import { Fraction, lcm } from "../common/fraction";
import { AccidentalCarry } from "./jianpu";
import { MusicCommon } from "../score/jppitch";
import { typeOfDuration } from "../score/xmlutil";
import { DYNAMICS, TERMS } from "../pu/glyph";
import { alignPartsBySystem } from "./alignparts";
import { applyPageMetaToDefaults } from "./pagemeta";
import { decoKey } from "./deconames";


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
export const ORNAMENT_TAG: Readonly<Record<string, string>> = {
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

/** 有没有小节内临时多声部（同一小节里两个以上 `voice`）。唯一来源是 ABC 的 `&`（§7.4）。 */
export function hasVoiceOverlay(song: Song): boolean {
  return song.parts.some((p) => p.measures.some((m) => {
    const first = m.elements[0]?.voice;
    return first !== undefined && m.elements.some((el) => el.voice !== first);
  }));
}

export interface ProjectOptions {
  /** 换行改照这些音起行（简谱视图实际排出的各行首音，`App.jianpuLineStarts`）。不给就用模型里的换行（源文的行） */
  lineStarts?: ReadonlySet<ElementId> | null;
}

export function projectForMusicXml(src: Song, options: ProjectOptions = {}): Song {
  if (isXmlShaped(src)) return src;
  const song: Song = structuredClone(src);
  // 123/ABC 里 `I:meta page …` 写的纸还原成 `<page-layout>`
  applyPageMetaToDefaults(song);
  // 多声部按组对齐：一组不一定含全部声部，缺席/偏短的补无声小节，各 part 小节才对得上（issue 11）
  alignPartsBySystem(song);
  // 源文的小节中间换行在下一小节上还另记了一份小节级的；照简谱视图重断的没有
  const relined = !!options.lineStarts?.size && applyLineStarts(song, options.lineStarts);
  const fifths = fifthsOf(song);
  const hosts = sustainHosts(song);
  const tuplets = tupletRatios(song);
  const factor = divisionFactor(song, tuplets);
  const divisions = SIMPLE_DIVISIONS * factor;

  tiesToMarks(song);
  normalizeMarks(song, hosts);
  const tupletInner = tupletInnerChords(song, tuplets, hosts);
  /** 拆出来的后半小节的编号（`X1`、`X2`…）；各声部同步拆，各自从头数 */
  let xno: { n: number };
  for (const [pi, part] of song.parts.entries()) {
    xno = { n: 0 };
    if (pi === 0) applyVoltas(part, voltasOfPlayOrder(song));
    splitInlineBreaks(part, tupletInner, !relined, xno);
    joinOpenMeasures(part, xno);
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

/** 换行改成「简谱视图里起行的那些音」：行首音是小节首音就在该小节起行（`print.newSystem`）。
 *  落在小节中间的：源文本来就在那里换行（`Chord.lineBreakAfter`，弱起谱的乐句尾常这样）就留着它，由 `splitInlineBreaks` 拆小节；
 *  简谱一行排不下、自己在小节中间折的，只是简谱版面宽度的产物，顺延到下一小节。多声部各声部的切点对不齐，也顺延。`newPage` 不动。行首音都在第一声部，其余声部按小节序号跟它走。
 *  一个也对不上（id 过期）就不改。 */
function applyLineStarts(song: Song, starts: ReadonlySet<ElementId>): boolean {
  const breaks = new Set<number>();
  const inline: Chord[] = [];
  for (const part of song.parts) {
    let pending = false;
    let hit = false;
    part.measures.forEach((m, i) => {
      if (i > 0 && pending) breaks.add(i);
      pending = false;
      const els = m.elements;
      const head = els.findIndex((e) => e.kind === "chord");
      els.forEach((el, k) => {
        if (el.kind !== "chord" || !starts.has(el.id)) return;
        hit = true;
        // 行首前面紧挨着的倚音跟着它走
        let j = k;
        while (j > 0 && els[j - 1]!.kind === "chord" && (els[j - 1] as Chord).grace) j--;
        if (k === head || j === 0) {
          if (i > 0) breaks.add(i);
          return;
        }
        const prev = els[j - 1]!;
        if (inlineBreakOf(prev) && song.parts.length === 1) inline.push(prev as Chord);
        else pending = true;
      });
    });
    if (hit) break;
    breaks.clear();
    inline.length = 0;
  }
  if (breaks.size === 0 && inline.length === 0) return false;
  for (const part of song.parts) {
    part.measures.forEach((m, i) => {
      for (const el of m.elements) {
        if (el.kind !== "chord") continue;
        delete el.lineBreakAfter;
        for (const su of el.sustains ?? []) delete su.lineBreakAfter;
      }
      if (m.print) delete m.print.newSystem;
      if (breaks.has(i)) m.print = { ...(m.print ?? {}), newSystem: true };
      else if (m.print && Object.keys(m.print).length === 0) delete m.print;
    });
  }
  for (const ch of inline) ch.lineBreakAfter = "system";
  return true;
}

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

// ───────────────────────── 房号（由演唱顺序反推） ─────────────────────────

export interface Volta {
  /** 本小节是某一房的开头，值为该房辖的遍数（"1,2,3"） */
  start?: string;
  /** 本小节是某一房的结尾 */
  stop?: boolean;
  /** 本小节末尾要补一个反复回头（除最后一房外，每房唱完都要回到 `|:`） */
  repeatBack?: boolean;
}

const setKey = (s: ReadonlySet<number>): string => [...s].sort((a, b) => a - b).join(",");

/**
 * 从文档自带的演唱顺序（`.jpwabc` 的 `.Repeat`）反推房号。原 `fromscore.ts::deriveVoltas`，判据原样搬来，
 * 小节序号是第一声部 `Part.measures` 的下标（`PlayPass` 1 基、`toMeasure` 含）：
 *
 *  1. 算出每个小节被哪几遍唱到，按「连续且遍集合相同」切成段；
 *  2. 找**分岔点**：某段的遍集合是前一段的真子集，说明反复体在这里分头；
 *  3. 从分岔点往后连续收段，直到各段遍集合的并集**恰好等于**分岔前的全集——这一组段就是各房。
 *     并集对不上（或只有一段）就放弃：那不是房，只是「某一遍唱得短一点」。
 *
 * 判据在《沧海一声笑》上推出 `1,2,3,5` / `4` / `6`，与 OMR 从原图识别出的房号一致；
 * 《因有主同在》的 `1-28V1 / 1-8V2` 则正确地不成房。谱面已经带房号的不推。
 */
export function voltasOfPlayOrder(song: Song): Map<number, Volta> {
  const out = new Map<number, Volta>();
  const part = song.parts[0];
  const items = song.playOrder ?? [];
  if (!part || items.length === 0) return out;
  if (part.measures.some((m) => m.barlines?.some((b) => b.ending))) return out;

  const passesOf = new Map<number, Set<number>>();
  const allPasses = new Set<number>();
  for (const it of items) {
    const pass = it.verse ?? 0;
    allPasses.add(pass);
    for (let mid = it.fromMeasure - 1; mid < it.toMeasure; mid++) {
      const s = passesOf.get(mid) ?? new Set<number>();
      s.add(pass);
      passesOf.set(mid, s);
    }
  }
  if (allPasses.size < 2) return out;

  const segs: Array<{ from: number; to: number; passes: Set<number> }> = [];
  for (const mid of [...passesOf.keys()].sort((a, b) => a - b)) {
    const p = passesOf.get(mid)!;
    const last = segs[segs.length - 1];
    if (last && last.to + 1 === mid && setKey(last.passes) === setKey(p)) last.to = mid;
    else segs.push({ from: mid, to: mid, passes: p });
  }

  const isSubset = (a: Set<number>, b: Set<number>): boolean =>
    a.size < b.size && [...a].every((v) => b.has(v));

  for (let i = 0; i < segs.length - 1; i++) {
    if (!isSubset(segs[i + 1]!.passes, segs[i]!.passes)) continue;
    const target = segs[i]!.passes;
    const group: typeof segs = [];
    const acc = new Set<number>();
    for (let j = i + 1; j < segs.length; j++) {
      if ([...segs[j]!.passes].some((v) => acc.has(v))) break; // 遍次重叠：不是并列的房
      for (const v of segs[j]!.passes) acc.add(v);
      group.push(segs[j]!);
      if (setKey(acc) === setKey(target)) break;
    }
    if (group.length < 2 || setKey(acc) !== setKey(target)) continue;
    group.forEach((g, k) => {
      const head = out.get(g.from) ?? {};
      head.start = setKey(g.passes);
      out.set(g.from, head);
      const tail = out.get(g.to) ?? {};
      tail.stop = true;
      if (k < group.length - 1) tail.repeatBack = true;
      out.set(g.to, tail);
    });
    i = segs.indexOf(group[group.length - 1]!);
  }
  return out;
}

/** 反推出的房号落到小节上：起点挂左线、终点挂右线（非最后一房补反复回头）。 */
function applyVoltas(part: Part, voltas: ReadonlyMap<number, Volta>): void {
  for (const [mid, v] of voltas) {
    const m = part.measures[mid];
    if (!m) continue;
    if (v.start !== undefined) {
      const ending = { numbers: v.start.split(",").map(Number), type: "start" as const, text: v.start };
      const left = (m.barlines ?? []).find((b) => b.location === "left");
      if (left) left.ending = ending;
      else (m.barlines ??= []).unshift({ location: "left", ending });
    }
    if (v.stop) {
      let right = (m.barlines ?? []).find((b) => b.location === "right");
      if (!right) (m.barlines ??= []).push((right = { location: "right" }));
      const nums = v.start ?? "";
      right.ending = { numbers: nums ? nums.split(",").map(Number) : [], type: "stop", text: nums };
      if (v.repeatBack) {
        right.repeat = "backward";
        right.style ??= "light-heavy";
      }
    }
  }
}

// ───────────────────────── 小节结构 ─────────────────────────

/** 小节中间换行拆出来的后半小节 → 它的前半（`autoBeams` 从前半的末尾接着数拍）。 */
const continuationOf = new WeakMap<Measure, Measure>();
/** 被切过的小节的各段（含前半）：真符杠在切点两侧要收口（`closeBeams`）。 */
const splitPieces = new WeakSet<Measure>();

/** 连音内部（不是连音最后一个）的和弦：在它后面换行会把连音劈开，不拆。 */
function tupletInnerChords(
  song: Song,
  tuplets: ReadonlyMap<ElementId, unknown>,
  hosts: ReadonlyMap<ElementId, ElementId>,
): Set<ElementId> {
  const ends = new Set<ElementId>();
  for (const mk of song.marks) if (mk.type === "tuplet") ends.add(hosts.get(mk.end) ?? mk.end);
  return new Set([...tuplets.keys()].filter((id) => !ends.has(id)));
}

/** 这个和弦（或它的增时线）之后原位换行吗。 */
function inlineBreakOf(el: Element): "system" | "page" | undefined {
  if (el.kind !== "chord") return undefined;
  return el.lineBreakAfter ?? el.sustains?.find((su) => su.lineBreakAfter)?.lineBreakAfter;
}

/**
 * **小节中间换行**（`Chord.lineBreakAfter`）拆成两个小节：前半的右线是隐藏线（`bar-style none`），
 * 后半 `implicit="yes"`（不计小节号，编号写 `X1`…）并起新行——MusicXML 只能在小节线处换行，
 * 这样五线谱与简谱在同一个音上换行，小节时值两半合起来仍是整小节。
 * 增时线上的换行按宿主和弦之后算（不在音符中间切）；切点落在连音中间的不拆，顺延到下一小节。
 * `swallow`：源文的小节中间换行在下一小节上还另记了一份小节级的（见 `Chord.lineBreakAfter`），拆过就删掉它。
 */
function splitInlineBreaks(part: Part, tupletInner: ReadonlySet<ElementId>, swallow: boolean, xno: { n: number }): void {
  const out: Measure[] = [];
  let dropPrint = false;
  let deferred: "system" | "page" | undefined;
  for (const m of part.measures) {
    if (dropPrint && m.print) {
      delete m.print.newSystem;
      delete m.print.newPage;
      if (Object.keys(m.print).length === 0) delete m.print;
    }
    dropPrint = false;
    if (deferred) {
      m.print = { ...(m.print ?? {}), ...(deferred === "page" ? { newPage: true } : { newSystem: true }) };
      deferred = undefined;
    }
    const cuts: { at: number; kind: "system" | "page" }[] = [];
    m.elements.forEach((el, k) => {
      const kind = inlineBreakOf(el);
      if (!kind || el.kind !== "chord") return;
      delete el.lineBreakAfter;
      for (const su of el.sustains ?? []) delete su.lineBreakAfter;
      const rest = m.elements.slice(k + 1);
      if (rest.length === 0 || rest.every((e) => !timed(e) && e.kind === "space")) return; // 在小节末：就是小节级换行
      if (tupletInner.has(el.id)) {
        if (!swallow) deferred = kind;
        return;
      }
      cuts.push({ at: k + 1, kind });
    });
    if (cuts.length === 0) {
      out.push(m);
      continue;
    }
    dropPrint = swallow;
    const pieces = splitMeasure(m, cuts, xno);
    out.push(...pieces);
  }
  part.measures = out;
}

/** 把一个小节在 `cuts` 各处切开。元素级的附属物（小节中间的线、direction、小节中间的 attributes）按位置分过去。 */
function splitMeasure(m: Measure, cuts: readonly { at: number; kind: "system" | "page" }[], xno: { n: number }): Measure[] {
  const bounds = [0, ...cuts.map((c) => c.at), m.elements.length];
  // 各段起点的时值（源口径的 divisions），给带 offset / onset 的附属物换基准
  const startTime: number[] = [];
  let t = 0;
  m.elements.forEach((el, k) => {
    const b = bounds.indexOf(k);
    if (b >= 0 && b < bounds.length - 1) startTime[b] = t;
    if (timed(el)) t += Math.round(el.duration?.divisions ?? 0);
  });
  const pieceOf = (after: number | undefined): number => {
    const a = after ?? 0;
    let p = 0;
    while (p + 1 < bounds.length - 1 && a >= bounds[p + 1]!) p++;
    return p;
  };
  const pieces: Measure[] = [];
  for (let p = 0; p < bounds.length - 1; p++) {
    const first = p === 0;
    const last = p === bounds.length - 2;
    const from = bounds[p]!;
    const piece: Measure = first
      ? { ...m, elements: m.elements.slice(from, bounds[p + 1]) }
      : { number: `X${++xno.n}`, implicit: true, elements: m.elements.slice(from, bounds[p + 1]) };
    if (first) {
      delete piece.barlines;
      delete piece.directions;
      delete piece.laterAttrs;
      delete piece.trailing;
    } else {
      piece.print = cuts[p - 1]!.kind === "page" ? { newPage: true } : { newSystem: true };
      continuationOf.set(piece, pieces[p - 1]!);
    }
    const bars: Barline[] = [];
    for (const b of m.barlines ?? []) {
      if (b.location === "left" ? first : b.location === "right" ? last : pieceOf(b.afterElements) === p) {
        bars.push(b.location === "middle" ? { ...b, afterElements: (b.afterElements ?? 0) - from } : b);
      }
    }
    if (!last) bars.push({ location: "right", style: "none" });
    if (bars.length) piece.barlines = bars;
    const dirs = (m.directions ?? []).filter((d) => pieceOf(d.afterElements) === p).map((d) => rebase(d, from, startTime[p]!));
    if (dirs.length) piece.directions = dirs;
    const later = (m.laterAttrs ?? []).filter((a) => pieceOf(a.afterElements) === p).map((a) => rebase(a, from, startTime[p]!));
    if (later.length) piece.laterAttrs = later;
    if (last && m.trailing) piece.trailing = m.trailing;
    splitPieces.add(piece);
    pieces.push(piece);
  }
  return pieces;
}

function rebase<T extends { afterElements?: number; offset?: number; onset?: number }>(x: T, from: number, time: number): T {
  if (from === 0) return x;
  const y = { ...x };
  if (y.afterElements !== undefined) y.afterElements -= from;
  if (y.offset !== undefined) y.offset = Math.max(0, y.offset - time);
  if (y.onset !== undefined) y.onset = Math.max(0, y.onset - time);
  return y;
}

/** 行尾没有小节线的小节（文本谱/123 跨行接着写同一小节）：下一段起新行就同 `splitInlineBreaks` 那样
 *  前半隐藏右线、后半 `implicit`；不换行的（只是没写小节线）与下一小节并成一个。 */
function joinOpenMeasures(part: Part, xno: { n: number }): void {
  const out: Measure[] = [];
  for (const m of part.measures) {
    const prev = out[out.length - 1];
    const prevOpen = prev && prev.elements.length > 0 && !prev.barlines?.some((b) => b.location === "right");
    if (prevOpen && m.elements.length > 0 && !m.attrs && !m.barlines?.some((b) => b.location === "left")) {
      if (m.print?.newSystem || m.print?.newPage) {
        (prev.barlines ??= []).push({ location: "right", style: "none" });
        m.number = `X${++xno.n}`;
        m.implicit = true;
        continuationOf.set(m, prev);
        splitPieces.add(prev);
        splitPieces.add(m);
        out.push(m);
        continue;
      }
      prev.elements.push(...m.elements);
      if (m.barlines) prev.barlines = [...(prev.barlines ?? []), ...m.barlines];
      if (m.trailing) prev.trailing = [...(prev.trailing ?? []), ...m.trailing];
      continue;
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
export function tiesToMarks(song: Song): void {
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

/** 简谱括住相邻两个同音的弧就是延音线（两者同形，文本谱/123 都只写括号）：补上两端的 `Note.tie`，
 *  五线谱画成延音线、导出的 `<tie>` 让别的软件也连着发声。后一个没写记号算沿用（`(#4 4)`），写了不同的不算 */
function tieSlur(a: Chord, b: Chord): boolean {
  const x = a.notes[0];
  const y = b.notes[0];
  if (a.rest || b.rest || a.grace || b.grace || !x || !y || !sameDegree(x, y)) return false;
  if (y.degree!.accidental && y.degree!.accidental !== x.degree!.accidental) return false;
  (x.tie ??= {}).start = true;
  (y.tie ??= {}).stop = true;
  return true;
}

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
  const chordAt = new Map<ElementId, { el: Chord; part: number }>();
  for (const [pi, p] of song.parts.entries()) {
    for (const m of p.measures) for (const el of m.elements) if (el.kind === "chord") chordAt.set(el.id, { el, part: pi });
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
    const [a, b] = [chordAt.get(start)!, chordAt.get(end)!];
    if (mk.type === "slur" && a.part === b.part && order.get(end)! === order.get(start)! + 1 && tieSlur(a.el, b.el)) {
      marks.push({ type: "tied", start, end });
      continue;
    }
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
  // 文本谱/123 的 `beams` 是减时线层数的占位（全是 continue），不是符杠分组；一个 begin 都没有就按拍自动分组（`autoBeams`）
  const realBeams = part.measures.some((m) => m.elements.some((el) => el.kind === "chord" && el.beams?.includes("begin")));
  const quarter = SIMPLE_DIVISIONS * factor;
  let time = part.measures[0]?.attrs?.time ?? { beats: 4, beatType: 4 };
  /** 各小节末在原小节里的拍位（拆开的后半从前半末尾接着数） */
  const ends = new Map<Measure, number>();
  const carries = new Map<Measure, AccidentalCarry>();
  for (const [mi, m] of part.measures.entries()) {
    const cont = continuationOf.get(m);
    const onset = cont ? (ends.get(cont) ?? 0) : 0;
    if (m.attrs?.time) time = m.attrs.time;
    /** 各元素的减时线条数（投影前的占位），自动分组用 */
    const levels = new Map<Element, number>();
    for (const el of m.elements) levels.set(el, el.beams?.length ?? 0);
    if (m.attrs?.key) {
      if (m.attrs.key.fifths === 0 && m.attrs.key.spelling) {
        const f = MusicCommon.keyNameToFifth(m.attrs.key.spelling);
        if (f >= -7 && f <= 7) m.attrs.key.fifths = f;
      }
      fifths = m.attrs.key.fifths;
    }
    /** 小节内延续的临时记号（简谱语义层，与 `assignDegrees` 同一份规则）；拆开的后半接着前半 */
    const carry = (cont && carries.get(cont)) || new AccidentalCarry();
    carries.set(m, carry);
    const dirs: Direction[] = [];
    // 小节内各声部的时间游标。一个小节里出现两个以上 voice 只有一种来源：ABC `&` 的临时多声部
    // （§7.4，`j123/parse.ts`），各分支都从小节起点重新计时；其余来源整条 part 就是一个声部。
    const cursors = new Map<number, number>();
    const overlay = new Set(m.elements.map((el) => el.voice || 1)).size > 1;
    let pos = 0;
    for (const el of m.elements) {
      // 简谱来源一个 part 就是一个声部：`<voice>` 一律写 1（文本谱 `Q2:` 的声部号是 part 的事）。
      // **临时多声部例外**：解析已经定好的分支号照原样留着，覆盖掉就把两条并行旋律串成一条了。
      const voice = el.voice > 1 ? el.voice : 1;
      el.voice = voice;
      pos = cursors.get(voice) ?? 0;
      // 实际起点与「前一个元素的终点」这个缺省不一致时必须写出来（`toxml.ts` 据此补 `<backup>`）
      if (overlay) el.onset = pos;
      if (el.kind === "space") {
        if (el.duration) {
          el.duration = { ...el.duration, divisions: Math.round(el.duration.divisions) * factor };
          pos += el.duration.divisions;
        }
        cursors.set(voice, pos);
        delete el.beams;
        continue;
      }
      const ch = el;
      for (const n of ch.notes) {
        if (!n.pitch && n.degree && n.degree.number > 0) n.pitch = carry.pitch(n.degree, { fifths });
      }
      if (ch.grace) {
        ch.duration = { ...ch.duration, divisions: 0 };
        delete ch.beams;
        if (overlay) delete ch.onset; // 倚音不占时值，起点跟着后一个音符
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
      cursors.set(voice, pos);
    }
    // 小节长度取各分支最远的终点，**不是各分支时值之和**
    pos = Math.max(0, ...cursors.values());
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
    ends.set(m, onset + pos);
    if (!realBeams) autoBeams(m, levels, quarter, time, mi === 0 && continuationOf.get(part.measures[1]!) !== m, onset);
    else if (splitPieces.has(m)) closeBeams(m);
  }
}

/**
 * 按拍自动写符杠：简谱的减时线就是五线谱的符杠。不写的话读入端各按各的规则猜，跨拍、弱起处常与原谱不一致。
 *
 * - **按拍分组**：x/8 且拍数是 3 的倍数（3/8、6/8、9/8、12/8）三个八分一组，其余一拍一组（x/8 其余按四分一组）。
 *   组里是「起点落在同一拍、带减时线、时值不超过一拍」的相邻元素；不带减时线的（四分音符、四分休止）打断分组。
 * - **弱起小节**（首小节不满）按小节末尾对齐拍位，否则整小节的拍全错开。
 * - **休止符不带 `<beam>`**：休止没有符干，挂不上符杠；但带减时线的休止照样留在组里，符杠从它上方跨过去
 *   （`5_ 0_ 3_` 的下划线本就一路连过休止），只由两侧的实音承载 begin/end。组首组尾的休止自然落在符杠之外。
 * - **逐层**：第 L 层只在第 L−1 层连上的音之间找连续段（中间有减时线少于 L 层的元素就断开），
 *   ≥2 个实音 begin/continue/end；只剩一个的写 hook——在上一层那段里不是头一个就朝前勾（backward），否则朝后（forward）。
 *   第一层只剩一个实音（其余都是休止）就整组不连，那个音按单音符尾写。
 */
function autoBeams(
  m: Measure, levels: ReadonlyMap<Element, number>, quarter: number, time: { beats: number; beatType: number },
  first: boolean, onset: number,
): void {
  const beat = time.beatType >= 8 && time.beats % 3 === 0
    ? (quarter * 4 / time.beatType) * 3
    : Math.max(quarter * 4 / time.beatType, quarter);
  const items: { el: Element; start: number; dur: number; level: number; solid: boolean; voice: number }[] = [];
  // 临时多声部（ABC `&`）：各分支从小节起点各自计时，符杠**不能跨分支连**
  const cursors = new Map<number, number>();
  let pos = onset;
  for (const el of m.elements) {
    if (!timed(el)) continue;
    const voice = el.voice > 1 ? el.voice : 1;
    const start = cursors.get(voice) ?? onset;
    const dur = el.duration?.divisions ?? 0;
    const solid = el.kind === "chord" && !el.rest && el.printObject !== false;
    items.push({ el, start, dur, level: levels.get(el) ?? 0, solid, voice });
    cursors.set(voice, start + dur);
    pos = Math.max(pos, start + dur);
  }
  const full = time.beats * quarter * 4 / time.beatType;
  const shift = first && pos > 0 && pos < full ? full - pos : 0;

  const groups: (typeof items)[] = [];
  let curBeat = -1;
  let curVoice = 0;
  for (const it of items) {
    const b = Math.floor((it.start + shift) / beat + 1e-9);
    if (it.level > 0 && it.dur <= beat) {
      if (b !== curBeat || it.voice !== curVoice) groups.push([]);
      groups[groups.length - 1]!.push(it);
      curBeat = b;
      curVoice = it.voice;
    } else {
      curBeat = -1;
      curVoice = 0;
    }
  }

  const out = new Map<Element, BeamVal[]>();
  for (const g of groups) {
    const maxLevel = Math.max(...g.map((it) => it.level));
    for (let level = 1; level <= maxLevel; level++) {
      let i = 0;
      while (i < g.length) {
        if (g[i]!.level < level) { i++; continue; }
        let j = i;
        while (j + 1 < g.length && g[j + 1]!.level >= level) j++;
        // 只有上一层连上了的实音才能往下一层连
        const solid = g.slice(i, j + 1).filter((it) => it.solid && (level === 1 || out.get(it.el)?.length === level - 1));
        const put = (it: (typeof items)[number], v: BeamVal) => out.set(it.el, [...(out.get(it.el) ?? []), v]);
        if (solid.length >= 2) {
          solid.forEach((it, k) => put(it, k === 0 ? "begin" : k === solid.length - 1 ? "end" : "continue"));
        } else if (solid.length === 1 && level > 1) {
          const it = solid[0]!;
          const upper = out.get(it.el)![level - 2]!;
          put(it, upper === "begin" || upper === "forward hook" ? "forward hook" : "backward hook");
        }
        i = j + 1;
      }
    }
  }
  for (const el of m.elements) {
    const b = out.get(el);
    if (b) el.beams = b;
    else delete el.beams;
  }
}

/** 拆开的小节：符杠不能跨过切点。段末的音 begin/continue → 收尾，段首的 continue/end → 起头；只剩自己一个的去掉。 */
function closeBeams(m: Measure): void {
  const beamed = m.elements.filter((el): el is Chord => el.kind === "chord" && !!el.beams?.length);
  const head = beamed[0];
  const tail = beamed[beamed.length - 1];
  if (head?.beams && head.beams[0] !== "begin") {
    if (head.beams[0] === "end") delete head.beams;
    else head.beams = head.beams.map((b) => (b === "continue" ? "begin" : b === "end" ? "forward hook" : b));
  }
  if (tail?.beams && tail.beams[0] !== "end") {
    if (tail.beams[0] === "begin") delete tail.beams;
    else tail.beams = tail.beams.map((b) => (b === "continue" ? "end" : b === "begin" ? "backward hook" : b));
  }
}

function push(dirs: Direction[], offset: number, d: Direction): void {
  if (offset > 0) d.offset = offset;
  dirs.push(d);
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
    // 本来就是 MusicXML 元素名的原样留（`staccatissimo` 不能归成普通顿音）；其余按别名表归一成短名再查
    // （123 的 `!uppermordent!` `!顿音!` 这类，`deconames.ts`）
    const key = XML_ARTICULATIONS.has(name) || XML_ORNAMENTS.has(name) ? name : decoKey(name) ?? name;
    if (FERMATA.test(key)) { n.fermata = true; continue; }
    const a = ARTICULATION[key] ?? (XML_ARTICULATIONS.has(key) ? key : undefined);
    if (a) { if (!artic.includes(a)) artic.push(a); continue; }
    const o = ORNAMENT_TAG[key] ?? (XML_ORNAMENTS.has(key) ? key : undefined);
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

/** 段号区间（文本谱 `C1-2:`、`.jpwabc` 的 `W1-6:`）展开成逐段的 `<lyric>`；空字不写。副歌行（`refrain`）写一条 chorus。 */
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
