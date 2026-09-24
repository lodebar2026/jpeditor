// `.123` 文本 → `ScoreDoc`。规范见 `docs/格式/123格式.md`。
//
// 分工：词法（切 token）在 `lex.ts`，字段与指令在 `fields.ts`，**本文件只做组装**——
// 小节切分、时值累计、符杠分组、Mark 配对、歌词对位、`I:playorder` 的音符级端点回填。
//
// 几条判据（改之前先读）：
//   - **123 的空白不表示符杠分组**：符杠按拍自动算（排版 `beamGroupsOf`），空格只为好读。
//     只有 ABC 方言按 §4.7 把「连写」落成 `Chord.beamGroup`（`ParseDialect.spaceBeams`）。
//   - **歌词 CJK 连写逐字成音节**（规范 §5.2，对 ABC 的扩展）；拉丁词仍按空格/连字符分。
//     收尾标点**并入前一字、不占音符格**，规则复用 `common/cjkpunct.ts`，别再写一份。
//   - **`(N:` 的冒号必需**：简谱音符是数字，裸 `(3` 与圆滑线冲突，见规范「`(` 的歧义」。
//   - 认不出的东西一律**报诊断、继续往下**——半截或写错的文本也要给出大部分结果。

import { lineStarts } from "../common/lines";
import { jumpOrnamentName } from "../abcfamily/jumpmarks";
import {
  PU_LYRIC_QUOTES,
  isLyricCjk as isCjk,
  isLyricOpenQuote as isOpenQuote,
  isLyricTrailingPunct as isTrailingPunct,
} from "../common/cjkpunct";
import type {
  AttachedSource,
  Barline,
  Chord,
  Diagnostic,
  Element,
  ElementId,
  Lyric,
  Mark,
  Measure,
  NoteType,
  Part,
  PlayPass,
  ScoreDoc,
  Song,
  SourceSpan,
  Space,
  Sustain,
} from "../model/doc";
import { IdGen, breaksAfterToStart, emptyDoc, emptySong } from "../model/helpers";
import { resolveAbcPitches } from "../abcfamily/abcpitch";
import { addMeta, creatorOf, isMetaKey } from "../model/metakeys";
import type { BreakKind } from "../model/helpers";
import {
  CJK_INSTRUCTION_ALIAS,
  parseFieldLine,
  parseInstruction,
  parseLinebreak,
  parsePlayOrder,
  parseTempo,
  parseTempoBeat,
  parseTime,
  parseTimes,
  type FieldLine,
  type FieldName,
  type RawPlayPass,
} from "./fields";
import type { Token } from "../abcfamily/types";
import { isLyricSlot, lyricSlots, type LyricSlotRule } from "../abcfamily/lyricslot";
import {
  DIALECT_123, DIALECT_ABC, typeAndDots, type DefaultLen, type ParseDialect,
} from "../abcfamily/parsedialect";

/** 歌词块：一行曲（到 `$` 换行为止的连续音乐行），紧跟其后的 `w` 行从块的第一个对位格起对位
 *  （规范 §5.1，同 ABC §5.1、文本谱 `Q:` 后跟 `C1:`）。
 *  块在两处断开：跟过 `w` 行之后、或已经见过换行（`$`；ABC 是每个代码行）之后，下一条音乐行开新块。
 *  只靠「跟过 `w`」不够：没有词的一行（前奏）会和下一行并成一块，下一行的词就从前奏第一个音挂起。 */
interface LyricBlock {
  /** 块首的对位格序号（声部内全局，`abcfamily/lyricslot.ts` 口径） */
  start: number;
  /** 块尾（不含）。下一块开始或整首收尾时才定 */
  end?: number;
  /** 块内各段写到哪一格：同一段用 `+:` 分几条写时接着往下挂 */
  cursor: Map<number, number>;
  /** 块内 `w:` 的条数：按出现顺序编段号 1、2、3…（规范 §5.1，同 ABC §5.1） */
  verses: number;
  /** 上一条 `w:` 是第几段：`+:` 续行接着写它 */
  lastVerse?: number;
  /** 块里已经换过行：下一条音乐行开新块 */
  broken: boolean;
}

/** 一个声部在组装期的累积状态。 */
interface PartBuild {
  part: Part;
  /** 当前小节（还没收尾） */
  measure: Measure;
  /** 本小节内已出现的音符数（`I:playorder` 的 skip/limit 按它定位） */
  noteCount: number;
  /** 小节号计数 */
  measureNo: number;
  /** 本小节里当前写到第几个临时声部（ABC `&`，§7.4）。主分支 1，每个 `&` 切到下一个；
   *  真正的小节线复位回 1。**必须存在声部级**：一个小节可以跨几个代码行，`&` 的作用域不随行结束 */
  voice: number;
  /** 本小节最后一个 `&` 在原文里的位置：分支收尾时发现它是空的，诊断要指到这儿 */
  overlaySource?: SourceSpan;
  /** 开着的弧/多连音、欠着的和弦记号、开着的房号。**按声部各存一份**：
   *  交错写法里 `V:1` 的弧常跨行，中间隔着 `V:2` 的行，共用一份会配错对 */
  openSlurs: OpenMark[];
  openTuplets: OpenMark[];
  /** `srcs`：欠着的这些记号在原文里的位置（`AttachedSource`，只给编辑用），随记号一起落到元素上 */
  pending: { chord?: string; annotations: string[]; decos: string[]; srcs: AttachedSource[] };
  openEnding: number[][];
  /** 当前歌词块；`afterLyrics` 表示上一块已经跟过 `w` 行，下一条音乐行开新块 */
  block?: LyricBlock;
  afterLyrics: boolean;
  /** 刚见过的 `$` 落在小节中间还是小节末，要看后面先来的是音符还是小节线：先记下 `$` 前的最后一个和弦
   *  （及它当时有几条增时线），同一小节里再来音符才落成 `lineBreakAfter`（同 `.jpwabc`，见 `fromjpw.ts`） */
  inlineBreak: { host: Chord; sustains: number; kind: BreakKind } | null;
}

/** 见到 `$`（或 ABC 的代码行末）：当前小节已有和弦时先记下，是不是小节中间换行等后面来的是什么再定（`PartBuild.inlineBreak`）。 */
function noteInlineBreak(pb: PartBuild, kind: BreakKind): void {
  const last = pb.measure.elements[pb.measure.elements.length - 1];
  pb.inlineBreak = last?.kind === "chord" ? { host: last, sustains: last.sustains?.length ?? 0, kind } : null;
}

/** 声部里到目前为止的最后一个元素（含还没收尾的小节）。 */
function lastElementId(pb: PartBuild): ElementId | null {
  const els = pb.measure.elements;
  if (els.length) return els[els.length - 1]!.id;
  for (let i = pb.part.measures.length - 1; i >= 0; i--) {
    const m = pb.part.measures[i]!.elements;
    if (m.length) return m[m.length - 1]!.id;
  }
  return null;
}

/** 声部里到目前为止的对位格数（含还没收尾的小节）。 */
function slotCount(pb: PartBuild, rule: LyricSlotRule): number {
  let n = 0;
  for (const m of pb.part.measures) for (const el of m.elements) if (isLyricSlot(el, rule)) n++;
  for (const el of pb.measure.elements) if (isLyricSlot(el, rule)) n++;
  return n;
}

interface Ctx {
  ids: IdGen;
  diagnostics: Diagnostic[];
  lineNo: number;
  lineOffset: number;
  /** 方言钩子：时值、音符、调号、`-` 的语义。组装逻辑本身两种方言共用。 */
  d: ParseDialect;
  /** ABC 的 `L:` 默认音长（123 用不到，恒为 1/4）。 */
  len: DefaultLen;
  /** 见过显式 `L:` 没有——没见过时 `M:` 要按 ABC §3.1.7 反推默认音长。 */
  sawL: boolean;
  /** 当前拍号：ABC 多连音的默认比例要看是不是复拍子（§4.13） */
  time: { beats: number; beatType: number } | null;
  /** `$` 记在哪一小节**之后**。一首收尾时经 `breaksAfterToStart` 翻成模型口径（`doc.ts::Print`） */
  breakAfter: Map<Measure, BreakKind>;
}

function report(ctx: Ctx, code: string, message: string, source: SourceSpan): void {
  ctx.diagnostics.push({ severity: "warning", code, message, source });
}

/** 小节线归一名 → MusicXML 的 bar-style + repeat。 */
function barlineFrom(value: string, times: number | undefined, source: SourceSpan): Barline {
  const b: Barline = { location: "right", source };
  switch (value) {
    case "normal": b.style = "regular"; break;
    case "double": b.style = "light-light"; break;
    case "final": b.style = "light-heavy"; break;
    case "reverse-final": b.style = "heavy-light"; break;
    case "dotted": b.style = "dotted"; break;
    case "none": b.style = "none"; break;
    case "repeat-start": b.style = "heavy-light"; b.repeat = "forward"; break;
    case "repeat-end": b.style = "light-heavy"; b.repeat = "backward"; break;
    case "repeat-both": b.style = "light-heavy"; b.repeat = "backward"; break;
    case "heavy-light": b.style = "heavy-light"; b.repeat = "forward"; break;
    case "light-heavy": b.style = "light-heavy"; b.repeat = "backward"; break;
    default: b.style = "regular"; break;
  }
  if (times) b.repeatTimes = times;
  return b;
}

// 时值换算（基准 `model/doc.ts::SIMPLE_DIVISIONS`，两种方言各自的算法）在 `abcfamily/parsedialect.ts`。

/** 歌词行 → 音节数组。
 *
 *  - **CJK 连写逐字成音节**（规范 §5.2）；拉丁按空格与 `-` 分。
 *  - `_` 前一音节延长一音（melisma）、跳音符（123 `/`、ABC `*`，见 `ParseDialect.lyricSkip`）、
 *    `~` 与 `{}` 多字一音、`|` 推进到下一小节；`\-` `\/` 是字面字符。
 *  - 123 里写了旧的 `*`：报 `lyric-old-skip`，仍当跳音符（不然整行静默错一格）。
 *  - 收尾标点并入前一字、不占音符格（`common/cjkpunct.ts` 的同一份规则）。
 *  - 段首 `<1.>` 是**印刷段号**，不占音符格（语料 55.6% 这么写）。 */
export function parseLyricLine(
  body: string,
  verse: number,
  source: SourceSpan,
  valueOffset?: number,
  skip: "/" | "*" = "/",
  warn?: (code: string, message: string) => void,
): { syllables: Lyric[]; label?: string; starts: number[] } {
  const out: Lyric[] = [];
  /** 各音节（含跳音符、续记号这类空音节）在 body 里的起点，与 `out` 一一对应——
   *  可视化编辑按对位格数拆 `w:` 行要它（空音节不记 `source`） */
  const starts: number[] = [];
  let i = 0;
  /** 当前音节在 body 里的起点：给音节记源区间（识别核对的点选定位落到字上） */
  let tokStart = 0;
  let label: string | undefined;

  // 印刷段号 `<1.>`。**不认 `"1."`**：直引号在歌词里是贴前字的标点（规范 §5.2），
  // 行首 `"主啊"，我…` 会被误吞成段号
  const lm = /^\s*<([^>]*)>/.exec(body);
  if (lm) {
    label = lm[1];
    i = lm[0].length;
  }

  /** 还没有前字可并的行首标点，攒着挂到下一个音节前面 */
  let prefix = "";

  const push = (l: Lyric): void => {
    out.push(l);
    starts.push(tokStart);
  };

  const mk = (text: string): Lyric => {
    const l: Lyric = { number: verse, text };
    if (prefix && text !== "") {
      l.leadingPunctuation = prefix;
      prefix = "";
    }
    if (valueOffset !== undefined && text !== "") {
      l.source = { line: source.line, column: valueOffset - source.offset + tokStart, offset: valueOffset + tokStart, length: text.length };
    }
    return l;
  };

  while (i < body.length) {
    const ch = body[i]!;
    if (ch === " " || ch === "\t") { i++; continue; }
    tokStart = i;
    // 跳一个音符（该音符不配字）
    if (ch === skip) { push(mk("")); i++; continue; }
    if (ch === "*") {
      warn?.("lyric-old-skip", "歌词跳音符已改用 `/`，`*` 暂按跳音符读");
      push(mk(""));
      i++;
      continue;
    }
    // 前一音节延长到这个音符
    if (ch === "_") {
      const prev = out[out.length - 1];
      if (prev) prev.extend = true;
      push(mk(""));
      i++;
      continue;
    }
    // 推进到下一小节：对齐自检用，不产生音节
    if (ch === "|") { i++; continue; }
    // 多字一音：`~` 连接，或 `{多字}`
    if (ch === "{") {
      const close = body.indexOf("}", i);
      if (close < 0) { i++; continue; }
      const l = mk(body.slice(i + 1, close));
      i = close + 1;
      // 紧跟的 `-` 同拉丁音节：词内断音节（写出端 `emit123` 会写 `{来”}-`，从前这里读丢，211《等主来》往返不幂等）
      if (body[i] === "-") {
        l.syllabic = "begin";
        i++;
      }
      push(l);
      continue;
    }
    // 转义的真连字符 / 斜杠（拉丁词中间的在下面拉丁分支里吃掉，这里是紧跟在 CJK 或 `}` 后的）
    if (ch === "\\" && (body[i + 1] === "-" || body[i + 1] === "/")) {
      const prev = out[out.length - 1];
      if (prev) prev.text += body[i + 1]!;
      i += 2;
      continue;
    }
    // CJK：一字一音节，随后的收尾标点并进来
    if (isCjk(ch)) {
      let text = ch;
      i++;
      // `~` 把后续词并到同一个音符下
      while (body[i] === "~" && body[i + 1] !== undefined) {
        i++;
        text += body[i]!;
        i++;
      }
      let trailing = "";
      while (i < body.length && isTrailingPunct(body[i]!)) {
        trailing += body[i]!;
        i++;
      }
      const l = mk(text);
      if (trailing) l.trailingPunctuation = trailing;
      push(l);
      continue;
    }
    // 左引号：领起**后**一个字，所以先吃住、挂到下一个音节前缀
    if (PU_LYRIC_QUOTES.includes(ch) && isOpenQuote(ch)) {
      const next = body[i + 1];
      if (next !== undefined && isCjk(next)) {
        let text = ch + next;
        i += 2;
        let trailing = "";
        while (i < body.length && isTrailingPunct(body[i]!)) { trailing += body[i]!; i++; }
        const l = mk(text);
        if (trailing) l.trailingPunctuation = trailing;
        push(l);
        continue;
      }
      i++;
      continue;
    }
    // 标点并到前一音节；**前面没字可并时不能丢**——`《圣经》…` 行首那个 `《`
    // 丢了就会让整行少一个字符、往返不稳
    if (isTrailingPunct(ch)) {
      const prev = out[out.length - 1];
      if (prev) prev.trailingPunctuation = (prev.trailingPunctuation ?? "") + ch;
      else prefix += ch;
      i++;
      continue;
    }
    // 拉丁：到空白 / `-` / `_` / 跳音符为止算一个音节；`-` 表示词内断音节，`\-` `\/` 是词里的字面字符
    {
      let j = i;
      let text = "";
      while (j < body.length) {
        const c = body[j]!;
        if (c === "\\" && (body[j + 1] === "-" || body[j + 1] === "/")) { text += body[j + 1]!; j += 2; continue; }
        if (/[\s\-_*|{}\\]/.test(c) || c === skip || isCjk(c) || isTrailingPunct(c)) break;
        text += c;
        j++;
      }
      if (j === i) { i++; continue; }
      i = j;
      let syllabic: Lyric["syllabic"] | undefined;
      if (body[i] === "-") {
        syllabic = "begin";
        i++;
      }
      let trailing = "";
      while (i < body.length && isTrailingPunct(body[i]!)) { trailing += body[i]!; i++; }
      const l = mk(text);
      if (syllabic) l.syllabic = syllabic;
      if (trailing) l.trailingPunctuation = trailing;
      push(l);
    }
  }
  const res: { syllables: Lyric[]; label?: string; starts: number[] } = { syllables: out, starts };
  if (label !== undefined) res.label = label;
  void source;
  return res;
}



// ───────────────────────── 组装 ─────────────────────────

interface OpenMark {
  type: Mark["type"];
  /** 0 = 还没遇到第一个元素，等 `attach` 回填 */
  start: ElementId;
  level: number;
  tupletActual?: number;
  tupletNormal?: number;
  /** 三连音还差几个音符收尾（ABC §4.13：`(3` 作用于随后 3 个音符，不需要显式收尾）。
   *  123 的多连音由 `)` 收（`ParseDialect.tupletClose`），不用它 */
  remaining?: number;
  /** `(` 在原文里的位置（见 `Mark.openSource`） */
  openSource?: SourceSpan;
}

/** `(` 在原文里的位置：123 的 `)` 收最近开的那个，弧与多连音两个栈靠它比先后 */
function openOffset(o: OpenMark): number {
  return o.openSource?.offset ?? -1;
}

/** 把一行音乐体的 token 组装进声部。 */
function buildMusicLine(
  ctx: Ctx,
  pb: PartBuild,
  tokens: readonly Token[],
  marks: Mark[],
): void {
  const { openSlurs, openTuplets, pending, openEnding } = pb;
  // 用对象持有：`attach` 是闭包，直接给局部 let 赋值会让 TS 的控制流分析把它窄成 never
  const cur: {
    last: Element | null;
    sustainHost: Chord | null;
    /** 刚按计数收掉一个多连音——紧随的 `)` 是写谱人的习惯写法，静默消费、不报「多余」 */
    justClosedTuplet: boolean;
  } = { last: null, sustainHost: null, justClosedTuplet: false };
  /** ABC：上一个 `-` 还没配到下一个音符（tie 的 stop 端） */
  let pendingTie = false;
  /** ABC：上一个 `>`/`<` 还欠着——正数表示下一个音符要减半、上一个加附点 */
  let pendingBroken = 0;
  /** ABC：结算欠着的 tie 与破碎节奏。123 永远不会触发（那两种 token 不产生）。 */
  const applyTieAndBroken = (ch: Chord): void => {
    if (pendingTie) {
      for (const n of ch.notes) n.tie = { ...(n.tie ?? {}), stop: true };
      pendingTie = false;
    }
    if (pendingBroken !== 0 && cur.sustainHost) {
      // `>` n 个：前音 ×(2-2^-n)、后音 ×2^-n；`<` 反过来
      const k = Math.abs(pendingBroken);
      const f = 1 / (1 << k);
      const prev = cur.sustainHost;
      const long = pendingBroken > 0 ? prev : ch;
      const short = pendingBroken > 0 ? ch : prev;
      const lo = Math.round(long.duration.divisions * (2 - f));
      const sh = Math.round(short.duration.divisions * f);
      // **type/dots 必须跟着 divisions 重算**：只改 divisions 会写出 `B/` 却读回
      // 「八分音符 12 divisions」，往返一轮就变形
      long.duration = { ...long.duration, divisions: lo, ...typeAndDots(lo) };
      short.duration = { ...short.duration, divisions: sh, ...typeAndDots(sh) };
      pendingBroken = 0;
    }
  };

  /** 同一符杠组的编号：没有空白相隔的相邻音符同组 */
  let beamGroup = 0;
  let sawSpaceSinceLastNote = true;

  const attach = (el: Element): void => {
    if (pending.chord !== undefined) {
      el.harmony = { root: { step: "C", alter: 0 }, kind: "", text: pending.chord };
      pending.chord = undefined;
    }
    if (pending.annotations.length) {
      const text = pending.annotations.join(" ");
      if (el.kind === "chord") el.sectionWord = text;
      pending.annotations = [];
    }
    if (pending.decos.length) {
      const fermata = pending.decos.some((d) => /^fermata$/i.test(d));
      const arts = pending.decos.filter((d) => !/^fermata$/i.test(d));
      el.notations = {
        ...(fermata ? { fermata: true } : {}),
        ...(arts.length ? { articulations: arts } : {}),
      };
      pending.decos = [];
    }
    if (pending.srcs.length) {
      // `y` 上不落段落词（上面只给 chord 设 sectionWord），它的位置也不记
      const srcs = el.kind === "chord" ? pending.srcs : pending.srcs.filter((a) => a.kind !== "annotation");
      if (srcs.length) el.attachedSources = srcs;
      pending.srcs = [];
    }
    // 上一个 `$` 后面同一小节里又来了音符：那是**小节中间**换行，在原位记一份（`Chord.lineBreakAfter`；
    // `$` 之后才补上的增时线不算——那时换行落在已有的最后一条增时线后面）
    if (pb.inlineBreak) {
      const { host, sustains, kind } = pb.inlineBreak;
      const su = host.sustains ?? [];
      const at = su.length > sustains && sustains > 0 ? su[sustains - 1]! : host;
      at.lineBreakAfter = kind;
      pb.inlineBreak = null;
    }
    // 123：`$` 同时结束这一批歌词（`ParseDialect.breakEndsLyricBlock`），同一代码行里 `$` 之后的音符另起一批
    if (ctx.d.breakEndsLyricBlock && pb.block?.broken) {
      const at = slotCount(pb, ctx.d.id);
      pb.block.end = at;
      pb.block = { start: at, cursor: new Map(), verses: 0, broken: false };
      pb.afterLyrics = false;
    }
    pb.measure.elements.push(el);
    cur.last = el;
    // 回填还没拿到起点的开弧/开连音——它们的起点就是「`(` 之后的第一个元素」
    for (const o of openSlurs) if (!o.start) o.start = el.id;
    for (const o of openTuplets) if (!o.start) o.start = el.id;
    // 123：组内**所有**占时值的元素（音符、`0`、`x`、`X`）都按比例折算；嵌套的比例相乘
    if (ctx.d.tupletClose === "paren" && el.kind === "chord" && !el.grace && openTuplets.length) {
      let actual = 1;
      let normal = 1;
      for (const tp of openTuplets) {
        actual *= tp.tupletActual!;
        normal *= tp.tupletNormal!;
      }
      el.duration.timeMod = { actual, normal };
    }
  };

  for (const t of tokens) {
    switch (t.kind) {
      case "space":
        // 只影响 ABC 的符杠分组（123 不看）。**不能清 `sustainHost`**——`5 - 3 -` 这种带空格的写法是常态，
        // 增时线仍归最近的那个音符
        sawSpaceSinceLastNote = true;
        break;

      case "note": {
        cur.justClosedTuplet = false;
        if (sawSpaceSinceLastNote) beamGroup++;
        sawSpaceSinceLastNote = false;
        const rest = ctx.d.isRest(t);
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: [],
          duration: ctx.d.duration(t, ctx.len),
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        if (rest) {
          ch.rest = {};
        } else {
          ch.notes.push(ctx.d.note(t));
        }
        if ((t.beams ?? 0) > 0) {
          ch.beams = Array.from({ length: t.beams! }, () => "continue" as const);
          if (ctx.d.spaceBeams) ch.beamGroup = beamGroup;
        }
        applyTieAndBroken(ch);
        attach(ch);
        cur.sustainHost = ch;
        if (pb.voice === 1) pb.noteCount++;
        // ABC：多连音按音符计数收尾，并给组内音符打 time-modification（123 在 `attach` 里打、由 `)` 收）
        if (ctx.d.tupletClose === "count") for (let k = openTuplets.length - 1; k >= 0; k--) {
          const tp = openTuplets[k]!;
          tp.remaining = (tp.remaining ?? 0) - 1;
          ch.duration.timeMod = { actual: tp.tupletActual ?? 3, normal: tp.tupletNormal ?? 2 };
          if (tp.remaining <= 0) {
            if (tp.start) {
              marks.push({
                type: "tuplet",
                start: tp.start,
                end: ch.id,
                level: 0,
                tupletActual: tp.tupletActual ?? 3,
                tupletNormal: tp.tupletNormal ?? 2,
              });
            }
            openTuplets.splice(k, 1);
            cur.justClosedTuplet = true;
          }
        }
        break;
      }

      case "sustain": {
        // 增时线并进前一个和弦的时值，但**自己有 id**——和弦可以挂在它上面（规范 §8.1，语料 190 次）
        const host = cur.sustainHost;
        if (!host) {
          report(ctx, "orphan-sustain", "增时线前面没有音符", t.source);
          break;
        }
        const s: Sustain = { id: ctx.ids.next(), source: t.source };
        if (pending.chord !== undefined) {
          s.harmony = { root: { step: "C", alter: 0 }, kind: "", text: pending.chord };
          pending.chord = undefined;
          const hs = pending.srcs.filter((a) => a.kind === "harmony");
          if (hs.length) s.attachedSources = hs;
          pending.srcs = pending.srcs.filter((a) => a.kind !== "harmony");
        }
        (host.sustains ??= []).push(s);
        host.duration = ctx.d.reduration(host, ctx.len);
        sawSpaceSinceLastNote = false;
        break;
      }

      // ── 下面四种只有标准 ABC 会产生（123 的休止走 note(degree=0)、`-` 是增时线）──

      case "rest": {
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: [],
          rest: {},
          duration: ctx.d.duration(t, ctx.len),
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        applyTieAndBroken(ch);
        attach(ch);
        cur.sustainHost = ch;
        if (pb.voice === 1) pb.noteCount++;
        break;
      }

      case "chordGroup": {
        // `[CEG]`：同时发声的几个音 —— `ScoreDoc.Chord.notes[]` 本来就装得下
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: (t.notes ?? []).map((g) => ctx.d.note(g)),
          duration: ctx.d.duration(
            { ...t, num: t.num ?? (t.notes?.[0]?.num ?? 1), den: t.den ?? (t.notes?.[0]?.den ?? 1) },
            ctx.len,
          ),
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        applyTieAndBroken(ch);
        attach(ch);
        cur.sustainHost = ch;
        if (pb.voice === 1) pb.noteCount++;
        break;
      }

      case "tie":
        // ABC 的 `-`：给前一个和弦的音打 start，下一个音打 stop
        if (cur.sustainHost) {
          for (const n of cur.sustainHost.notes) n.tie = { ...(n.tie ?? {}), start: true };
          pendingTie = true;
        } else {
          report(ctx, "orphan-tie", "延音线前面没有音符", t.source);
        }
        break;

      case "broken":
        // `a>b`：前音附点、后音减半（ABC §4.4）。欠着，等下一个音符来结算
        pendingBroken = t.broken ?? 1;
        break;

      case "rhythm": {
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: [],
          rhythm: true,
          duration: ctx.d.duration(t, ctx.len),
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        if ((t.beams ?? 0) > 0) ch.beams = Array.from({ length: t.beams! }, () => "continue" as const);
        attach(ch);
        cur.sustainHost = ch;
        if (pb.voice === 1) pb.noteCount++;
        break;
      }

      case "spacer": {
        // **`x` 是不可见休止**：有时值、占对位格（对应文本谱的隐藏休止 `8`），
        // 所以它是 `Chord`（rest + printObject=false）而不是 `Space`——
        // 若做成 `Space`，`attachLyrics` 不给它配词而 emit 的对位槽又含它，歌词就会错一格。
        // **`y` 才是 `Space`**：无时值、不占对位格，只为挂和弦（规范 §8.1）。
        if (t.value === "x") {
          const ch: Chord = {
            kind: "chord",
            id: ctx.ids.next(),
            notes: [],
            rest: {},
            printObject: false,
            duration: ctx.d.duration(t, ctx.len),
            voice: pb.voice,
            staff: 1,
            source: t.source,
          };
          if ((t.beams ?? 0) > 0) ch.beams = Array.from({ length: t.beams! }, () => "continue" as const);
          attach(ch);
          cur.sustainHost = ch;
          if (pb.voice === 1) pb.noteCount++;
          break;
        }
        const sp: Space = {
          kind: "space",
          id: ctx.ids.next(),
          spacer: "y",
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        attach(sp);
        cur.sustainHost = null;
        break;
      }

      case "chord":
        pending.chord = t.value ?? "";
        // 连写两个和弦名只留后一个（上面覆盖），位置也只留后一个
        pending.srcs = pending.srcs.filter((a) => a.kind !== "harmony");
        pending.srcs.push({ kind: "harmony", name: pending.chord, source: t.source });
        break;

      case "annotation":
        // `"^文字"` / `"_文字"`（ABC §4.19 的注记，`^` 上方 `_` 下方）——
        // 段落词（`（副歌）` 这类）就走这条，与 emit 对称
        pending.annotations.push((t.value ?? "").replace(/^[\^_<>@]/, ""));
        pending.srcs.push({ kind: "annotation", name: pending.annotations[pending.annotations.length - 1]!, source: t.source });
        break;

      case "deco": {
        const deco = t.value ?? "";
        // 跳转记号不是音符上的装饰，而是挂在小节线上的（`Barline.ornaments`）。
        // 写在线**之后**（小节还一个元素都没有）的是**左线**上的记号——segno/coda 这类跳转目标；
        // 写在线之前的攒着，等下面 `case "barline"` 把它挂到那条右线上。
        const jump = jumpOrnamentName(deco);
        if (jump && pb.measure.elements.length === 0) {
          const bls = (pb.measure.barlines ??= []);
          const left = bls.find((b) => b.location === "left");
          if (left) (left.ornaments ??= []).push({ name: jump, level: 0 });
          else bls.push({ location: "left", ornaments: [{ name: jump, level: 0 }], source: t.source });
          break;
        }
        pending.decos.push(deco);
        pending.srcs.push({ kind: "deco", name: deco, source: t.source });
        break;
      }

      case "grace": {
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: (t.notes ?? []).map((g) => ctx.d.note(g)),
          duration: { divisions: 0, dots: 0, type: graceType(t.notes?.[0]) },
          grace: t.acciaccatura ? { slash: true } : {},
          voice: pb.voice,
          staff: 1,
          source: t.source,
        };
        pb.measure.elements.push(ch);
        break;
      }

      case "slurStart":
        // 起点未定：等 `attach` 把「`(` 之后的第一个元素」回填进来
        openSlurs.push({ type: "slur", start: 0, level: openSlurs.length, openSource: t.source });
        break;

      case "slurEnd": {
        // 123：`)` 收**最近开的那个**括号，圆滑线与多连音同一套嵌套（规范 §4「多连音」）。
        // 谁更近看 `(` 在原文里的位置——两者各有一个栈，但在原文里是交替嵌套的
        if (ctx.d.tupletClose === "paren") {
          const tp = openTuplets[openTuplets.length - 1];
          const sl = openSlurs[openSlurs.length - 1];
          if (tp && (!sl || openOffset(tp) > openOffset(sl))) {
            openTuplets.pop();
            if (tp.start && cur.last) {
              marks.push({
                type: "tuplet",
                start: tp.start,
                end: cur.last.id,
                level: 0,
                tupletActual: tp.tupletActual!,
                tupletNormal: tp.tupletNormal!,
              });
            } else {
              report(ctx, "empty-tuplet", "多连音里没有音符", t.source);
            }
            break;
          }
        }
        // **`)` 是二义符号**：收圆滑线 还是 收多连音？判据照 `.jpwabc` 那条
        // （`docs/模块/源格式-jpwabc.md`：「前面的音符还欠着 `(` 就先收弧，欠完了才轮到三连音」）——
        // ABC 的多连音本不需要 `)`，但写谱人习惯带上，照收不误。
        if (openSlurs.length === 0 && ctx.d.tupletClose === "count") {
          if (cur.justClosedTuplet) {
            cur.justClosedTuplet = false;
            break;
          }
          const tp = openTuplets.pop();
          if (tp) {
            if (tp.start && cur.last) {
              marks.push({
                type: "tuplet",
                start: tp.start,
                end: cur.last.id,
                level: 0,
                tupletActual: tp.tupletActual ?? 3,
                tupletNormal: tp.tupletNormal ?? 2,
              });
            }
          } else {
            report(ctx, "unmatched-slur", "多余的 `)`", t.source);
          }
          break;
        }
        if (openSlurs.length === 0) {
          report(ctx, "unmatched-slur", "多余的 `)`", t.source);
          break;
        }
        // 一个音符**收一条又起一条**（ABC §4.11 `(c d (e) f g a)` = c→e、e→a 两条）：栈顶那条正是
        // 在本音符上刚起的，`)` 收的是它底下那条更早的；只有一条开着时 `(1)` 才是单音弧。
        // 识别出的 `5 3 3` 上外弧 + 首尾相接的两条内弧就写作 `((5 (3) 3))`（1863）。
        // 123 里这条特判只在「下面那层也是弧」时走：两条弧之间夹着一个开着的多连音，就按单音弧收
        const top = openSlurs[openSlurs.length - 1];
        const below = openSlurs[openSlurs.length - 2];
        const innerTuplet = openTuplets[openTuplets.length - 1];
        const chain = top && top.start && top.start === cur.last?.id && below
          && !(ctx.d.tupletClose === "paren" && innerTuplet && openOffset(innerTuplet) > openOffset(below));
        const open = chain ? openSlurs.splice(openSlurs.length - 2, 1)[0] : openSlurs.pop();
        if (!open) {
          report(ctx, "unmatched-slur", "多余的 `)`", t.source);
          break;
        }
        // `open.start` 由 `attach` 回填；同音起止（`(1)`）时起点就是终点，合法（ABC §4.11）
        if (open.start && cur.last) {
          const mk: Mark = { type: "slur", start: open.start, end: cur.last.id, level: open.level, closeSource: t.source };
          if (open.openSource) mk.openSource = open.openSource;
          marks.push(mk);
        } else {
          report(ctx, "empty-slur", "圆滑线里没有音符", t.source);
        }
        break;
      }

      case "tuplet": {
        const actual = Number(t.value ?? 3);
        openTuplets.push({
          type: "tuplet",
          start: 0,
          level: 0,
          tupletActual: actual,
          // p 是「占几个的时间」，没写（0）取方言的默认表（`ParseDialect.tupletNormal`）
          tupletNormal: t.numbers?.[1] || ctx.d.tupletNormal(actual, ctx.time),
          // ABC `(n:p:q` 的 q 是「作用于几个音符」，缺省就是 n（123 由 `)` 收，不用它）
          remaining: t.numbers?.[2] || actual,
          openSource: t.source,
        });
        break;
      }

      case "ending": {
        // `[N` 标记第 N 房**开始**（ABC §4.9/§4.10），它总出现在小节开头，
        // 所以挂在**所属小节的左线**上；房号的 stop 由后面那根结束线给出
        const nums = t.numbers ?? [];
        const ending = { numbers: nums, type: "start" as const, text: nums.join(",") };
        // `|1` 会先产生一根左线，房号挂到它上面；行首直接写 `[1` 时才新建
        const existingLeft = (pb.measure.barlines ?? []).find((b) => b.location === "left");
        if (existingLeft) existingLeft.ending = ending;
        else (pb.measure.barlines ??= []).push({ location: "left", ending, source: t.source });
        openEnding.push(nums);
        break;
      }

      case "barline": {
        const bl = barlineFrom(t.value ?? "normal", t.repeatTimes, t.source);
        // 线**之前**攒下的跳转记号（`… 6 !fine! |]`）挂这条线，别落到音符的 articulations 上
        const jumps = pending.decos.map((d) => jumpOrnamentName(d)).filter((v): v is string => !!v);
        if (jumps.length) {
          pending.decos = pending.decos.filter((d) => !jumpOrnamentName(d));
          pending.srcs = pending.srcs.filter((a) => a.kind !== "deco" || !jumpOrnamentName(a.name));
          bl.ornaments = jumps.map((name) => ({ name, level: 0 }));
        }
        // **小节里还没有元素 = 这是左线**（行首的 `|`、或紧跟上一根），不收尾，
        // 否则会凭空多出一个空小节
        if (pb.measure.elements.length === 0) {
          bl.location = "left";
          (pb.measure.barlines ??= []).push(bl);
          break;
        }
        // 结束类小节线收掉开着的房号
        const isEndingStop = ["light-light", "light-heavy", "heavy-light"].includes(bl.style ?? "");
        if (isEndingStop && openEnding.length) {
          const nums = openEnding.pop()!;
          bl.ending = { numbers: nums, type: "stop", text: nums.join(",") };
        }
        (pb.measure.barlines ??= []).push(bl);
        pb.inlineBreak = null; // `$` 之后先到的是小节线：小节末换行，小节级那一份就够了
        closeMeasure(ctx, pb);
        beamGroup = 0;
        sawSpaceSinceLastNote = true;
        cur.sustainHost = null;
        // 多连音跨不过小节线，收掉。123 要求 `)`，走到这里就是漏写了
        if (ctx.d.tupletClose === "paren") {
          for (const tp of openTuplets) report(ctx, "unclosed-tuplet", "多连音缺 `)`", tp.openSource ?? t.source);
        }
        openTuplets.length = 0;
        break;
      }

      case "overlay": {
        // ABC §7.4：`&` 把时间退回本小节起点，后面是与前一分支**同时发声**的临时声部。
        // 这里只切声部号（元素仍按原文顺序存在同一个小节里），小节内各声部的实际起点
        // 由投影按每声部的游标算（`model/xmlproject.ts`），因为那时才折算完多连音与 divisions。
        if (openSlurs.length) {
          report(ctx, "overlay-open-slur", "圆滑线跨过了 `&`", t.source);
          openSlurs.length = 0;
        }
        if (openTuplets.length) {
          report(ctx, "overlay-open-tuplet", "多连音跨过了 `&`", t.source);
          openTuplets.length = 0;
        }
        if (!pb.measure.elements.some((el) => el.voice === pb.voice)) {
          report(ctx, "empty-overlay", "`&` 前面这个临时声部是空的", t.source);
        }
        pb.voice++;
        pb.overlaySource = t.source;
        // 分支各自从头计时，所以分支间的状态一律不继承：tie、破碎节奏、增时线宿主、符杠分组
        pendingTie = false;
        pendingBroken = 0;
        cur.sustainHost = null;
        cur.last = null;
        cur.justClosedTuplet = false;
        beamGroup++;
        sawSpaceSinceLastNote = true;
        break;
      }

      case "break": {
        // `$` 的语义是「**这一小节之后**换行」。小节线通常先到、当前小节已被推进 `measures`，
        // 所以要赋给刚收尾的那一个；否则每次往返都会把换行往后挪一格。
        const target = pb.measure.elements.length > 0
          ? pb.measure
          : pb.part.measures[pb.part.measures.length - 1] ?? pb.measure;
        ctx.breakAfter.set(target, t.value === "page" ? "page" : "system");
        (pb.part.breakSources ??= []).push({ page: t.value === "page", after: lastElementId(pb), source: t.source });
        noteInlineBreak(pb, t.value === "page" ? "page" : "system");
        if (pb.block) pb.block.broken = true;
        break;
      }

      case "inlineField": {
        const m = /^([A-Za-z])\s*[:：]\s*(.*)$/.exec(t.value ?? "");
        if (!m) break;
        const name = m[1]!.toUpperCase();
        const val = m[2] ?? "";
        pb.measure.attrs ??= {};
        if (name === "K") {
          const r = ctx.d.parseKey(val);
          if (r.error) report(ctx, "bad-key", r.error, t.source);
          pb.measure.attrs.key = r.key;
        } else if (name === "M") {
          const r = parseTime(val);
          if (r.error) report(ctx, "bad-time", r.error, t.source);
          else if (r.time) {
            pb.measure.attrs.time = r.time;
            ctx.time = r.time;
          }
        }
        break;
      }

      case "unknown":
        break;
    }
  }
}

/** 小节收尾：推进到下一小节。空小节（连续两根小节线）不产生。 */
function closeMeasure(ctx: Ctx, pb: PartBuild): void {
  if (pb.measure.elements.length === 0 && !pb.measure.barlines?.length) return;
  // 末尾那个分支是空的（`… & |`）：`&` 写了却没有音，多半是漏了内容
  if (pb.voice > 1 && pb.overlaySource && !pb.measure.elements.some((el) => el.voice === pb.voice)) {
    report(ctx, "empty-overlay", "`&` 后面这个临时声部是空的", pb.overlaySource);
  }
  pb.overlaySource = undefined;
  pb.part.measures.push(pb.measure);
  pb.measureNo++;
  pb.measure = { number: String(pb.measureNo), elements: [] };
  pb.noteCount = 0;
  // `&` 的临时声部只活到小节线（ABC §7.4），下一小节从主声部重新开始
  pb.voice = 1;
}

/** 把 `I:playorder` 的「第几个音符」换成元素 id。 */
function resolvePlayOrder(song: Song, raw: readonly RawPlayPass[]): PlayPass[] {
  const out: PlayPass[] = [];
  const part = song.parts[0];
  for (const r of raw) {
    const p: PlayPass = { fromMeasure: r.fromMeasure, toMeasure: r.toMeasure };
    if (r.verse !== undefined) p.verse = r.verse;
    if (r.pageBreakAfter) p.pageBreakAfter = true;
    if (part) {
      if (r.fromNoteIndex !== undefined) {
        const id = nthNoteId(part, r.fromMeasure, r.fromNoteIndex);
        if (id !== undefined) p.fromElement = id;
      }
      if (r.toNoteIndex !== undefined) {
        const id = nthNoteId(part, r.toMeasure, r.toNoteIndex);
        if (id !== undefined) p.toElement = id;
      }
    }
    out.push(p);
  }
  return out;
}

/** 第 `measureNo` 小节（1 基）里第 `n` 个音符（1 基）的元素 id。 */
function nthNoteId(part: Part, measureNo: number, n: number): ElementId | undefined {
  const m = part.measures[measureNo - 1];
  if (!m) return undefined;
  let k = 0;
  for (const el of m.elements) {
    if (el.kind === "chord" && !el.grace) {
      k++;
      if (k === n) return el.id;
    }
  }
  return undefined;
}

/** 歌词挂到对位格上：从 `start` 格起、到 `end` 格为止（歌词块的范围，规范 §5.1）。
 *
 *  返回**超出块尾、有字的音节数**。多余的被忽略（ABC §5.1 的标准行为），
 *  但必须报出来——ABC 规范自己就写了「the program should warn the user」，
 *  而静默丢字在语料迁移时是灾难（迁移报表要靠这条诊断发现对位错）。
 *  超出的只是 `_` 与跳音符不算：行末 melisma 写 `主_`，那个 `_` 本就落在下一行的格上。 */
function attachLyrics(
  slots: readonly Element[],
  syllables: readonly Lyric[],
  start: number,
  end: number,
): number {
  let over = 0;
  for (let si = 0; si < syllables.length; si++) {
    const syl = syllables[si]!;
    const k = start + si;
    if (k >= end || k >= slots.length) {
      if (syl.text !== "") over++;
      continue;
    }
    if (syl.text === "" && !syl.extend) continue; // 跳音符：该音符不配字
    (slots[k]!.lyrics ??= []).push(syl);
  }
  return over;
}

export interface ParseOptions {
  /** 文件名，仅用于诊断 */
  name?: string;
}

/** `.123` 文本 → `ScoreDoc`。 */
/** 倚音不占拍（divisions 0），印出来的时值记在 `type` 上。长度**相对倚音单位（八分）**
 *  （ABC 2.1 §4.12：花括号里照普通音符写长度，单位另定）：123 每个 `_` 减半（`{2_}` 十六分），
 *  ABC 按 num/den（`{d/}` 十六分、`{d2}` 四分）；什么都不写就是八分。 */
function graceType(g: Token | undefined): NoteType {
  const ratio = (g?.num ?? 1) / (g?.den ?? 1) / 2 ** (g?.beams ?? 0);
  const k = Math.round(Math.log2(ratio));
  return (["64th", "32nd", "16th", "eighth", "quarter", "half"] as const)[Math.max(0, Math.min(5, k + 3))]!;
}

export function parse123(text: string, options: ParseOptions = {}): ScoreDoc {
  return parseAbcFamily(text, DIALECT_123, options);
}

/** `.abc` 文本 → `ScoreDoc`（**原生解析**，不经 MusicXML）。
 *
 *  为什么不复用 `abc/abc2xml.ts`：那条路把源字符偏移丢光了，编辑器的双向定位最多到小节级、
 *  往返也只能「原文或全量重写」二选一。见 `docs/模块/源格式-abc家族.md`。
 *  `abc2xml` 仍留着做对照基准与 fallback。 */
export function parseAbc(text: string, options: ParseOptions = {}): ScoreDoc {
  return parseAbcFamily(text, DIALECT_ABC, options);
}

/** ABC 家族的通用解析：**组装逻辑两种方言共用**，差异全在 `dialect` 那几个钩子里。
 *  见 `docs/模块/源格式-abc家族.md`。 */
export function parseAbcFamily(
  text: string,
  dialect: ParseDialect,
  options: ParseOptions = {},
): ScoreDoc {
  void options;
  const doc = emptyDoc(dialect.id);
  doc.source = text;
  const ids = new IdGen();
  const ctx: Ctx = {
    ids,
    diagnostics: doc.diagnostics,
    lineNo: 0,
    lineOffset: 0,
    d: dialect,
    len: dialect.defaultLen(4, 4),
    sawL: false,
    time: null,
    breakAfter: new Map(),
  };

  const lines = text.split(/\r?\n/);
  const starts = lineStarts(text);
  let song: Song | null = null;
  /** 当前声部 */
  let pb: PartBuild | null = null;
  /** 本曲各声部，按首次出现的顺序。`V:n` 再次出现是**续写**该声部（ABC 语义，交错写法靠它） */
  let builds = new Map<number, PartBuild>();
  let rawPlay: RawPlayPass[] = [];
  let marks: Mark[] = [];
  /** 待挂的歌词行：整首读完、小节都收尾后才挂 */
  let pendingLyrics: PendingLyric[] = [];

  const finishSong = (): void => {
    if (!song) return;
    for (const b of builds.values()) {
      if (ctx.d.tupletClose === "paren") {
        for (const tp of b.openTuplets) report(ctx, "unclosed-tuplet", "多连音缺 `)`", tp.openSource!);
        b.openTuplets.length = 0;
      }
      closeMeasure(ctx, b);
      if (b.block && b.block.end === undefined) b.block.end = slotCount(b, ctx.d.id);
      if (b.part.measures.length) song.parts.push(b.part);
    }
    const slotsOf = new Map<Part, Element[]>();
    for (const { f, verse, syl, part, block, start } of pendingLyrics) {
      // 歌词挂在它**紧跟的那个声部**上（四声部谱里词常挂在某一个声部下）
      let slots = slotsOf.get(part);
      if (!slots) slotsOf.set(part, (slots = lyricSlots(part, undefined, undefined, undefined, undefined, ctx.d.id).slots));
      const left = attachLyrics(slots, syl, start, block.end ?? slots.length);
      if (left > 0) {
        report(
          ctx,
          "lyric-overflow",
          `第 ${verse} 段歌词比这几行的音符多 ${left} 个音节，多出的被忽略`,
          f.source,
        );
      }
    }
    pendingLyrics = [];
    // **ABC 只给音名，简谱那一侧要度数**（排版、`emit123`、播放都按度数走）。
    // 先按调号与小节内延续把音名换成实际音高，度数再从音高推（`abcpitch.ts`，写出端同一份规则）。
    if (ctx.d.id === "abc") resolveAbcPitches(song);
    for (const part of song.parts) breaksAfterToStart(part, ctx.breakAfter);
    ctx.breakAfter.clear();
    song.marks = marks;
    if (rawPlay.length) song.playOrder = resolvePlayOrder(song, rawPlay);
    doc.songs.push(song);
    song = null;
    pb = null;
    builds = new Map();
    marks = [];
    rawPlay = [];
  };

  const ensureSong = (): Song => {
    if (!song) song = emptySong();
    return song;
  };
  const newPart = (voice: number): PartBuild => ({
    part: { id: `P${voice}`, measures: [] },
    measure: { number: "1", elements: [] },
    noteCount: 0,
    measureNo: 1,
    voice: 1,
    openSlurs: [],
    openTuplets: [],
    pending: { annotations: [], decos: [], srcs: [] },
    openEnding: [],
    afterLyrics: false,
    inlineBreak: null,
  });
  /** `V:n` 切到声部 n：没有就新开，有就**续写**（不收尾它开着的小节）。四声部谱靠这个分开，否则会被拼成一串小节。 */
  const startPart = (voice: number): PartBuild => {
    ensureSong();
    let b = builds.get(voice);
    if (!b) builds.set(voice, (b = newPart(voice)));
    pb = b;
    return b;
  };
  const ensurePart = (): PartBuild => pb ?? startPart(1);

  /** 上一条字段名：`+:` 续行接着写它（ABC §3.1.18） */
  let lastField: FieldName | undefined;
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln]!;
    const lineOffset = starts[ln]!;
    ctx.lineNo = ln;
    ctx.lineOffset = lineOffset;
    const line = raw.trim();
    if (line === "") continue;
    // 版本声明与注释
    if (line.startsWith("%")) {
      // `%%directive` 等价 `I:directive`（ABC §11.0.2）
      if (line.startsWith("%%")) {
        applyInstruction(ctx, ensureSong(), parseInstruction(line.slice(2)), { line: ln, column: 0, offset: lineOffset, length: raw.length }, (r) => { rawPlay = rawPlay.concat(r); });
      }
      continue;
    }

    const f = parseFieldLine(raw, ln, lineOffset);
    if (f) {
      // `+:` 续行（ABC §3.1.18）：只支持歌词行——`w:` 太长要拆几条写时用它，
      // 别的字段续行语料里没有、也没有消费方，报一条提示后丢掉
      if (f.cont) {
        if (lastField === "w") addLyricLine(ctx, ensurePart(), f, pendingLyrics);
        else {
          report(ctx, "cont-unsupported", "`+:` 只支持歌词行续写（紧跟在 `w:` 之后）", f.source);
        }
        continue;
      }
      lastField = f.name;
      // `X:` 开新曲
      if (f.name === "X") {
        finishSong();
        const s = ensureSong();
        s.work.number = f.value;
        continue;
      }
      if (f.name === "w") {
        addLyricLine(ctx, ensurePart(), f, pendingLyrics);
        continue;
      }
      applyField(ctx, ensureSong(), f, startPart, (r) => { rawPlay = rawPlay.concat(r); });
      continue;
    }

    // 音乐体
    lastField = undefined;
    const s = ensureSong();
    void s;
    const p = ensurePart();
    // 上一块已经跟过歌词（或还没有块）：这一行开新歌词块
    if (!p.block || p.afterLyrics || p.block.broken) {
      const at = slotCount(p, ctx.d.id);
      if (p.block) p.block.end = at;
      p.block = { start: at, cursor: new Map(), verses: 0, broken: false };
      p.afterLyrics = false;
    }
    const lex = ctx.d.lex(raw, ln, lineOffset, 0);
    for (const e of lex.errors) report(ctx, "lex", e.message, e.source);
    buildMusicLine(ctx, p, lex.tokens, marks);
    // ABC §6.1：**代码里的换行就是谱面换行**（默认 `I:linebreak <EOL>`）。
    // 123 不吃这一条——它用显式的 `$`，简谱一行常写得很长，不该被源码折行绑死。
    // 语义同 `$`：「这一小节之后换行」，所以挂在刚收尾的那一个上。
    if (ctx.d.lineEndIsBreak) {
      const target = p.measure.elements.length > 0
        ? p.measure
        : p.part.measures[p.part.measures.length - 1];
      if (target && !ctx.breakAfter.has(target)) {
        ctx.breakAfter.set(target, "system");
        noteInlineBreak(p, "system");
      } else if (target === p.measure && p.inlineBreak?.host !== p.measure.elements[p.measure.elements.length - 1]) {
        // 同一小节里第二个代码行末：又是一刀小节中间换行（行尾写了 `$` 的，那一刀已经记在同一个音上）
        noteInlineBreak(p, "system");
      }
      if (p.block) p.block.broken = true;
    }
  }
  finishSong();
  return doc;
}

/** 待挂的一条歌词行 */
interface PendingLyric {
  f: FieldLine;
  /** 这一行是第几段（段号由 `w:` 的出现顺序定） */
  verse: number;
  syl: Lyric[];
  part: Part;
  block: LyricBlock;
  /** 从第几个对位格起挂 */
  start: number;
}

/** `w` 行：挂到当前声部**当前歌词块**上（规范 §5.1）。
 *  `f.cont`（`+:`）接着写上一条 `w:` 的那一段，不占新段位。 */
function addLyricLine(ctx: Ctx, pb: PartBuild, f: FieldLine, pendingLyrics: PendingLyric[]): void {
  // 旧写法 `w1:`／`w1-2:`：段号已废（段号由出现顺序定），这一行整条丢掉并报错——
  // 放进去会把段位算错，掉进音乐体又会炸出一串词法错
  if (f.legacyVerse !== undefined) {
    report(
      ctx,
      "lyric-verse-number",
      `歌词行不带段号（\`w${f.legacyVerse}:\` 已废）：写 \`w:\`，一行曲下按出现顺序编段，同段续写用 \`+:\`。这一行已丢弃`,
      f.source,
    );
    return;
  }
  // 音乐行之前就写了词：给它一个从当前位置起的空块（多半全部超出、报 overflow）
  const block: LyricBlock = pb.block ??= { start: slotCount(pb, ctx.d.id), cursor: new Map(), verses: 0, broken: false };
  pb.afterLyrics = true;
  // `w:` 按块内顺序编段号（ABC §5.1：同一行音乐下的几条 `w:` 依次是各段）
  const from = f.cont ? block.lastVerse ?? ++block.verses : ++block.verses;
  block.lastVerse = from;
  const { syllables, label } = parseLyricLine(
    f.value, from, f.source, f.valueOffset, ctx.d.lyricSkip,
    (code, message) => report(ctx, code, message, f.source),
  );
  // 印刷段号不占音符格，挂在该段**第一个非空**音节上——空音节（跳音符）不会被挂到元素上
  // （`attachLyrics` 会跳过），label 跟着它一起丢
  if (label !== undefined) {
    const first = syllables.find((x) => x.text !== "");
    if (first) first.verseLabel = label;
  }
  const start = block.cursor.get(from) ?? block.start;
  block.cursor.set(from, start + syllables.length);
  pendingLyrics.push({ f, verse: from, syl: syllables, part: pb.part, block, start });
}

function applyField(
  ctx: Ctx,
  song: Song,
  f: FieldLine,
  startPart: (voice: number) => void,
  addPlay: (r: RawPlayPass[]) => void,
): void {
  switch (f.name) {
    case "T":
      if (song.work.title === undefined) song.work.title = f.value;
      else song.work.subtitles.push(f.value);
      break;
    case "C":
      (song.identification ??= { creators: [] }).creators.push(creatorOf(f.value));
      break;
    case "K": {
      const r = ctx.d.parseKey(f.value);
      if (r.error) report(ctx, "bad-key", r.error, f.source);
      song.key = r.key;
      break;
    }
    case "M": {
      // 头部可并排写几个拍号（混合拍）＋一段说明文字；首个是起头拍号，其余进 `extraTimes`。
      const r = parseTimes(f.value);
      if (r.error) report(ctx, "bad-time", r.error, f.source);
      const [first, ...rest] = r.times;
      if (first) {
        song.time = first;
        ctx.time = first;
        if (rest.length) song.extraTimes = rest;
        if (r.note) song.timeNote = r.note;
        // ABC §3.1.7：没写 `L:` 时默认音长由 `M:` 推出来
        if (!ctx.sawL) ctx.len = ctx.d.defaultLen(first.beats, first.beatType);
      }
      break;
    }
    case "L": {
      // ABC 的默认音长 `L:1/8`。123 里可省（时值由 `_`/`-`/`.` 相对表达），故只有 ABC 用
      const m = /^(\d+)\s*\/\s*(\d+)$/.exec(f.value.trim());
      if (m) {
        ctx.len = { num: Number(m[1]), den: Number(m[2]) };
        ctx.sawL = true;
      } else {
        report(ctx, "bad-length", `看不懂的默认音长：${f.value}`, f.source);
      }
      break;
    }
    case "Q": {
      // **追加不覆盖**：源里常有两条（`Q:1/4=130` 与 `Q:"热情地"`），
      // 直接赋值会让后一条把前一条顶掉，往返一轮速度就丢了
      song.tempos = [...(song.tempos ?? []), ...parseTempo(f.value)];
      // 拍单位（`Q:3/8=60` 附点四分）另记，缺省四分
      const tb = parseTempoBeat(f.value);
      if (tb) song.tempoBeat = tb;
      break;
    }
    case "V":
      startPart(f.voice ?? 1);
      break;
    case "W":
      (song.remarks ??= []).push(f.value);
      break;
    case "N":
      (song.remarks ??= []).push(f.value);
      break;
    case "I":
      applyInstruction(ctx, song, parseInstruction(f.value), f.source, addPlay);
      break;
    case "P":
      // ABC 的段落顺序串（`P:A2`）。**本轮只存原文**，展开语义归后续
      (song.remarks ??= []).push(`P:${f.value}`);
      break;
    default:
      break;
  }
}

function emptyPageText(): NonNullable<Song["pageText"]> {
  return { topLeft: [], topRight: [], bottomLeft: [], bottomCenter: [], bottomRight: [] };
}

function applyInstruction(
  ctx: Ctx,
  song: Song,
  ins: { name: string; value: string },
  source: SourceSpan,
  addPlay: (r: RawPlayPass[]) => void,
): void {
  const name = CJK_INSTRUCTION_ALIAS[ins.name] ?? ins.name;
  switch (name) {
    case "playorder":
      addPlay(parsePlayOrder(ins.value, source, ctx.diagnostics));
      break;
    case "style":
      (song.style ??= {}).sheetRef = ins.value.trim();
      break;
    // 扩展 meta：`I:meta 键 值`（键见 model/metakeys.ts；多值写多行）
    case "meta": {
      const m = /^\s*(\S+)(?:\s+(.*))?$/.exec(ins.value);
      if (m && isMetaKey(m[1]!)) addMeta(song, m[1]!, (m[2] ?? "").trim());
      else (song.style ??= {}).raw = [...(song.style.raw ?? []), { key: name, value: ins.value }];
      break;
    }
    // 页眉页脚：与 emit 对称（见 `j123/emit.ts` 的同名指令）
    case "indexleft": (song.pageText ??= emptyPageText()).indexLeft = ins.value; break;
    case "indexright": (song.pageText ??= emptyPageText()).indexRight = ins.value; break;
    case "topleft": (song.pageText ??= emptyPageText()).topLeft.push(ins.value); break;
    case "topright": (song.pageText ??= emptyPageText()).topRight.push(ins.value); break;
    case "bottomleft": (song.pageText ??= emptyPageText()).bottomLeft.push(ins.value); break;
    case "bottomcenter": (song.pageText ??= emptyPageText()).bottomCenter.push(ins.value); break;
    case "bottomright": (song.pageText ??= emptyPageText()).bottomRight.push(ins.value); break;
    case "linesperpage": {
      const n = Number(ins.value.trim());
      if (Number.isFinite(n) && n > 0) song.linesPerPage = n;
      break;
    }
    case "linebreak":
      (song.style ??= {}).raw = [...(song.style.raw ?? []), { key: "linebreak", value: parseLinebreak(ins.value) }];
      break;
    default:
      (song.style ??= {}).raw = [...(song.style.raw ?? []), { key: name, value: ins.value }];
      break;
  }
}
