// 「按乐句重排」写回文本谱原文（编辑器工具栏那个按钮的文本谱一侧）。
//
// **只做原文片段的搬运**：新的每一行都是原文里那几段字符接起来的，不重新生成任何记号——
// 和弦 `"hx:…"`、`&记号`、注释、并字号、跳词符都跟着原文走。Score 装不下的那些东西
// （见 toscore.ts 开头的「有损」一节）因此一个都不会掉。
//
// 为什么落到文本而不是往 Score 插 `LineBreak`：原样档走的是 `PuPainter`（吃 AST，不经 Score），
// Score 层的断点够不着它。而文本谱里「一行 `Q:` 就是谱面一行」，重切行两档同时就位——
// 展开档那边行边界照旧由 `toscore.ts` 转成 `LineBreak`。
//
// 切点落在**元素之间的间隙**里：元素自己的 span 不含跟在后面的和弦/注释
// （`1"hx:E♭"` 的 span 只有 `1`），所以按 span 直接切会把和弦切掉。判据是
// 「收口的（`)` `]` `"注释"`）留给上一行，起头的（`(` `[`）归下一行」——
// 跨行的弧线与跳房子因此天然成立：上一行以未闭合的 `(` 收尾，解析器会自己接到下一行
// （`parse.ts::carriedCurves` / `carriedVoltas`），不必补任何续接记号。
//
// 无 DOM 依赖。

import { takesLyric, voiceNumbers } from "./ast";
import type { LyricLine, PuDoc, PuSong, ScoreLine } from "./ast";
import { dialectSpec } from "./dialect";
import { BODY_PREFIX } from "./parse";
import { puPhraseLines, voiceStream, type FitMeasure, type PuNewLine, type VoiceStream } from "./phrase";

/** 起头的记号：它们属于**后面**那个元素，切行时归下一行。 */
const OPENERS = new Set(["(", "["]);

/** 行首的 `Q1:` / `C1-2:` / `W:` 标签（不含声部名与段号说明）。 */
function labelOf(raw: string): string {
  const m = BODY_PREFIX.exec(raw);
  if (!m) return "";
  const kind = m[1]!;
  const variant = m[2] ?? "";
  const num = m[3] ?? "";
  const range = m[4] ? `-${m[4]}` : "";
  return `${kind}${variant}${num}${range}:`;
}

/** `Q1: ` / `C1: <1.>` 这段前缀的长度（内容从这里开始）。 */
function prefixLen(raw: string): number {
  const m = BODY_PREFIX.exec(raw);
  return m ? m[0].length : 0;
}

/**
 * 在第 k 个元素**之前**下刀，刀落在原文的哪一列。
 *
 * 收口的（`)` `]`、跟在上一个元素后面的和弦与注释）留在上一行，起头的（`(` `[`）归下一行。
 */
function cutColumn(line: ScoreLine, k: number): number {
  if (k <= 0) return prefixLen(line.raw);
  const prev = line.elements[k - 1]!;
  const prevEnd = prev.source.column + prev.source.length;
  if (k >= line.elements.length) return line.raw.length;
  const next = line.elements[k]!.source.column;
  for (let i = prevEnd; i < next; i++) {
    if (OPENERS.has(line.raw[i]!)) return i;
  }
  return next;
}

/** 该行前 k 个元素里有几个跟词（== 歌词音节要跳过几个）。 */
function lyricCount(line: ScoreLine, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (takesLyric(line.elements[i]!)) n += 1;
  return n;
}

/** 一段歌词切片：段号相同的几段来自不同源行时按顺序接起来。 */
interface LyricPiece {
  /** 第一次出现时的源行（前缀、说明文字从它来） */
  head: LyricLine;
  headRaw: string;
  atHead: boolean; // 切片是否从该行第一个音节起（是则连 `<1.>` 这类说明一起带上）
  texts: string[];
  /** 平行于 texts：该片段实际给出了几个音节 */
  filled: number[];
  /** 这一段在本行上一共有几个**字**（全是跳词符就不必占一行） */
  words: number;
}

/** 一条曲行的片段（同一新行可能横跨几条源行）。 */
interface Piece {
  line: ScoreLine;
  from: number;
  to: number;
}

/**
 * 一个片段的正文，并把**跨行断开的渐强渐弱**接上。
 *
 * 弧线与跳房子跨行是解析器自己管的（`carriedCurves` / `carriedVoltas`），渐强渐弱不是：
 * `<`…`!` 必须在同一行里收口。切在中间就得在上一行行尾补一个 `!`、下一行行首再开一次
 * ——不补的话解析回来就是一对 `unclosed-wedge` / `unmatched-wedge-end`。
 */
function pieceText(p: Piece): string {
  const begin = cutColumn(p.line, p.from);
  let text = p.line.raw.slice(begin, cutColumn(p.line, p.to));
  let head = "";
  let tail = "";
  for (const mk of p.line.marks) {
    if (mk.type !== "crescendo" && mk.type !== "decrescendo") continue;
    const sign = (mk.type === "crescendo" ? "<" : ">") + "+".repeat(mk.level);
    if (mk.start < p.from && mk.end >= p.from) head = sign; // 上一行开的，这里重开
    if (mk.start <= p.to - 1 && mk.end > p.to - 1) tail = "!"; // 还没收口，本行先收
  }
  if (head) {
    // `<` 是跟在音符**后面**写的（起点就是那个音符），所以补在本片段第一个元素之后
    const first = p.line.elements[p.from]!;
    const at = first.source.column + first.source.length - begin;
    text = text.slice(0, at) + head + text.slice(at);
  }
  return (text.trimEnd() + tail).trim();
}

/** 把若干片段拼成一行 `Q` 的正文。 */
function musicText(pieces: readonly Piece[]): string {
  return pieces.map(pieceText).filter((s) => s.length > 0).join(" ");
}

/** 一条歌词行在 [s0,s1) 这几个音节上的原文切片，以及它实际给出了几个音节。 */
function lyricSlice(
  lyric: LyricLine, raw: string, s0: number, s1: number,
): { text: string; count: number; words: number } {
  const syl = lyric.syllables;
  if (s0 >= syl.length) return { text: "", count: 0, words: 0 };
  const begin = syl[s0]!.source.column;
  const stop = Math.min(s1, syl.length);
  const end = s1 >= syl.length ? raw.length : syl[s1]!.source.column;
  let words = 0;
  for (let i = s0; i < stop; i++) if (syl[i]!.text.length > 0) words += 1;
  return { text: raw.slice(begin, end).trim(), count: stop - s0, words };
}

/**
 * 按乐句重排一份文本谱原文。
 *
 * 逐首处理（`-----` 分出的多唱法各自断句）；头部字段、`W:` 文字行、`-----` 原样保留，
 * 换掉的只有曲行与歌词行所在的那一段，以及分组空行与 `[fenye]`（行结构变了，它们要重来）。
 *
 * @param text    编辑器里的原文（`doc` 必须是它解析出来的那一份）
 * @param measure 行长尺子（`App._puPhraseMeasure`）；不给就按 `phrase.ts` 的出厂目标断
 */
export function relayoutPuText(
  text: string, doc: PuDoc, opt: { measure?: FitMeasure | null } = {},
): string {
  const raws = text.split(/\r?\n/);
  const skip = dialectSpec(doc.dialect).lyricSkip[0] ?? "@";
  // 各首各排各的，但都写回同一份文本：先收集「哪一段换成什么」，最后统一拼。
  const patches: Array<{ from: number; to: number; lines: string[] }> = [];

  doc.songs.forEach((song, songIdx) => {
    const plan = puPhraseLines(doc, songIdx, { measure: opt.measure ?? null });
    if (!plan) return;
    const region = songRegion(song);
    if (!region) return;
    const streams = new Map(voiceNumbers(song).map((v) => [v, voiceStream(song, v)]));
    const out = emit(song, plan, streams, raws, skip);
    if (out.length > 0) patches.push({ from: region.from, to: region.to, lines: out });
  });

  if (patches.length === 0) return text;
  patches.sort((a, b) => a.from - b.from);
  const merged: string[] = [];
  let at = 0;
  for (const p of patches) {
    merged.push(...raws.slice(at, p.from), ...p.lines);
    at = p.to + 1;
  }
  merged.push(...raws.slice(at));
  return merged.join("\n");
}

/** 一首歌在原文里占的行区间（曲行 / 歌词行 / `W:` 行的最小外包）。 */
function songRegion(song: PuSong): { from: number; to: number } | null {
  let from = Infinity;
  let to = -1;
  const take = (line: number): void => {
    from = Math.min(from, line);
    to = Math.max(to, line);
  };
  for (const pg of song.pages) {
    for (const g of pg.groups) {
      for (const t of g.texts) take(t.source.line);
      for (const v of g.voices) {
        take(v.source.line);
        for (const l of v.lyrics) take(l.source.line);
      }
    }
  }
  return to < 0 ? null : { from, to };
}

/** 生成新的曲行 / 歌词行文本。 */
function emit(
  song: PuSong,
  plan: readonly PuNewLine[],
  streams: ReadonlyMap<number, VoiceStream>,
  raws: readonly string[],
  skip: string,
): string[] {
  // `W:` 文字行跟着它那一组走：该组的第一条源行头一次出现在哪一新行，就印在那一行之前。
  const textsOfLine = new Map<ScoreLine, string[]>();
  for (const pg of song.pages) {
    for (const g of pg.groups) {
      if (g.texts.length === 0 || g.voices.length === 0) continue;
      textsOfLine.set(g.voices[0]!, g.texts.map((t) => raws[t.source.line] ?? ""));
    }
  }
  const textDone = new Set<ScoreLine>();
  const captionDone = new Set<number>(); // 声部名（`Q1<女高>`）只在该声部第一行印一次

  const out: string[] = [];
  plan.forEach((nl, li) => {
    if (li > 0) out.push("");
    const block: string[] = [];
    for (const seg of nl.segs) {
      const st = streams.get(seg.voice)!;
      const pieces: Piece[] = [];
      for (let i = seg.from; i < seg.to; i++) {
        const o = st.origin[i]!;
        const last = pieces[pieces.length - 1];
        if (last && last.line === st.lines[o.lineIdx]) last.to = o.elIdx + 1;
        else pieces.push({ line: st.lines[o.lineIdx]!, from: o.elIdx, to: o.elIdx + 1 });
      }
      if (pieces.length === 0) continue;
      const head = pieces[0]!.line;
      for (const p of pieces) {
        const t = textsOfLine.get(p.line);
        if (t && !textDone.has(p.line)) {
          textDone.add(p.line);
          out.push(...t);
        }
      }
      // 首行保留原前缀（含声部名），其后各行只留 `Q1:`
      const prefix = captionDone.has(seg.voice)
        ? labelOf(head.raw)
        : head.raw.slice(0, prefixLen(head.raw));
      captionDone.add(seg.voice);
      block.push(`${prefix} ${musicText(pieces)}`.trimEnd());
      block.push(...lyricLines(pieces, raws, skip));
    }
    out.push(...block);
    if (nl.pageAfter) out.push("", "[fenye]");
  });
  return out;
}

/**
 * 这一新行上该跟哪几条歌词行。
 *
 * 一行横跨几条源行时按**段**把切片接起来：段的身份是「段号 + 它在源行里是同段号的第几条」
 * ——`C1:` 在同一条曲行上出现两次是番茄谱的常态（《同一首歌》两段词都写成 `C1:`），
 * 只按段号并会把两段揉成一段。
 *
 * 接的时候还要**补齐音节数**：歌词行常比曲行短（《卖报歌》14 个字配 15 个音），
 * 短了不补，后面接上来的字就整体前移一个音。
 */
function lyricLines(pieces: readonly Piece[], raws: readonly string[], skip: string): string[] {
  const order: string[] = [];
  const byKey = new Map<string, LyricPiece>();
  const needs: number[] = []; // 平行于 pieces：这一片段该有几个音节
  pieces.forEach((p, pi) => {
    const before = lyricCount(p.line, 0, p.from);
    const inside = lyricCount(p.line, p.from, p.to);
    needs.push(inside);
    const seen = new Map<string, number>();
    for (const lyric of p.line.lyrics) {
      const verse = `${lyric.verseFrom}-${lyric.verseTo}`;
      const dup = seen.get(verse) ?? 0;
      seen.set(verse, dup + 1);
      const key = `${verse}#${dup}`;
      const raw = raws[lyric.source.line] ?? "";
      const { text, count, words } = lyricSlice(lyric, raw, before, before + inside);
      let cur = byKey.get(key);
      if (!cur) {
        cur = { head: lyric, headRaw: raw, atHead: before === 0, texts: [], filled: [], words: 0 };
        byKey.set(key, cur);
        order.push(key);
      }
      while (cur.texts.length < pi) { cur.texts.push(""); cur.filled.push(0); }
      cur.texts.push(text);
      cur.filled.push(count);
      cur.words += words;
    }
    // 这一段缺的段号也要占住位置，后面的片段才不会顶上来
    for (const key of order) {
      const cur = byKey.get(key)!;
      while (cur.texts.length < pi + 1) { cur.texts.push(""); cur.filled.push(0); }
    }
  });
  const out: string[] = [];
  for (const key of order) {
    const cur = byKey.get(key)!;
    const label = labelOf(cur.headRaw);
    // **一个字都没有的段不占行**：重排后某一段在这一行上只剩跳词符（73《我主耶稣是生命源》
    // 的副歌只有第 1 段有词），照印就是三行空白。段号是写死的（`C2:`）才敢丢——
    // 番茄的裸 `C:` 按出现顺序编号，丢一条后面全串位。
    if (cur.words === 0 && /\d/.test(label)) continue;
    // 每一段都补到它该有的音节数（末段不补，行尾的跳词符没有意义）
    const parts: string[] = [];
    let tail = -1;
    cur.texts.forEach((t, i) => { if (t.length > 0) tail = i; });
    cur.texts.forEach((t, i) => {
      if (i > tail) return;
      const pad = Math.max(0, (needs[i] ?? 0) - (cur.filled[i] ?? 0));
      parts.push(t + (i < tail ? skip.repeat(pad) : ""));
    });
    const body = parts.filter((t) => t.length > 0).join(" ");
    if (body.length === 0) continue;
    // 首段连 `<1.>` 这类说明文字一起带上，其后各行只留 `C1:`
    const prefix = cur.atHead
      ? cur.headRaw.slice(0, firstSyllableColumn(cur.head, cur.headRaw))
      : `${label} `;
    out.push((prefix + body).trimEnd());
  }
  return out;
}

/** 歌词正文（第一个音节）从哪一列开始——前面那截含 `C1:` 与 `<1.>` 这类说明文字。 */
function firstSyllableColumn(lyric: LyricLine, raw: string): number {
  return lyric.syllables[0]?.source.column ?? prefixLen(raw);
}
