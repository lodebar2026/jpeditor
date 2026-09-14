// `.123` 文本 → `ScoreDoc`。规范见 `docs/格式/123格式.md`。
//
// 分工：词法（切 token）在 `lex.ts`，字段与指令在 `fields.ts`，**本文件只做组装**——
// 小节切分、时值累计、符杠分组、Mark 配对、歌词对位、`I:playorder` 的音符级端点回填。
//
// 几条判据（改之前先读）：
//   - **符杠分组由空白决定**（ABC §4.7）：相邻音符之间没有 `space` token 就是同一组。
//     落成 `Chord.beamGroup` 编号，不设 `~`/`^` 控制符。
//   - **歌词 CJK 连写逐字成音节**（规范 §5.2，对 ABC 的扩展）；拉丁词仍按空格/连字符分。
//     收尾标点**并入前一字、不占音符格**，规则复用 `common/cjkpunct.ts`，别再写一份。
//   - **`(N:` 的冒号必需**：简谱音符是数字，裸 `(3` 与圆滑线冲突，见规范「`(` 的歧义」。
//   - 认不出的东西一律**报诊断、继续往下**——半截或写错的文本也要给出大部分结果。

import { PU_LYRIC_PUNCTUATION, PU_LYRIC_QUOTES } from "../common/cjkpunct";
import type {
  Barline,
  Chord,
  Diagnostic,
  Element,
  ElementId,
  Lyric,
  Mark,
  Measure,
  Part,
  PlayPass,
  ScoreDoc,
  Song,
  SourceSpan,
  Space,
  Sustain,
} from "../model/doc";
import { IdGen, breaksAfterToStart, emptyDoc, emptySong } from "../model/helpers";
import { fillDegreesFromPitch } from "../model/jianpu";
import { addMeta, creatorOf, isMetaKey } from "../model/metakeys";
import type { BreakKind } from "../model/helpers";
import {
  CJK_INSTRUCTION_ALIAS,
  parseFieldLine,
  parseInstruction,
  parseLinebreak,
  parsePlayOrder,
  parseTempo,
  parseTime,
  type FieldLine,
  type RawPlayPass,
} from "./fields";
import type { Token } from "../abcfamily/types";
import {
  DIALECT_123, DIALECT_ABC, typeAndDots, type DefaultLen, type ParseDialect,
} from "../abcfamily/parsedialect";

/** 一个声部在组装期的累积状态。 */
interface PartBuild {
  part: Part;
  /** 当前小节（还没收尾） */
  measure: Measure;
  /** 本小节内已出现的音符数（`I:playorder` 的 skip/limit 按它定位） */
  noteCount: number;
  /** 小节号计数 */
  measureNo: number;
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

// 时值换算（`DIVISIONS` 与两种方言各自的算法）在 `abcfamily/parsedialect.ts`。

/** 歌词行 → 音节数组。
 *
 *  - **CJK 连写逐字成音节**（规范 §5.2）；拉丁按空格与 `-` 分。
 *  - `_` 前一音节延长一音（melisma）、`*` 跳一个音符、`~` 与 `\-` 多字一音、`|` 推进到下一小节。
 *  - 收尾标点并入前一字、不占音符格（`common/cjkpunct.ts` 的同一份规则）。
 *  - 段首 `<1.>` 是**印刷段号**，不占音符格（语料 55.6% 这么写）。 */
export function parseLyricLine(
  body: string,
  verseFrom: number,
  verseTo: number | undefined,
  source: SourceSpan,
  valueOffset?: number,
): { syllables: Lyric[]; label?: string } {
  const out: Lyric[] = [];
  let i = 0;
  /** 当前音节在 body 里的起点：给音节记源区间（识别核对的点选定位落到字上） */
  let tokStart = 0;
  let label: string | undefined;

  // 印刷段号 `<1.>` / `"1."`
  const lm = /^\s*(?:<([^>]*)>|"([^"]*)")/.exec(body);
  if (lm) {
    label = lm[1] ?? lm[2];
    i = lm[0].length;
  }

  /** 还没有前字可并的行首标点，攒着挂到下一个音节前面 */
  let prefix = "";

  const mk = (text: string): Lyric => {
    const l: Lyric = { number: verseFrom, text };
    if (prefix && text !== "") {
      l.leadingPunctuation = prefix;
      prefix = "";
    }
    if (verseTo !== undefined && verseTo !== verseFrom) l.numberTo = verseTo;
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
    if (ch === "*") { out.push(mk("")); i++; continue; }
    // 前一音节延长到这个音符
    if (ch === "_") {
      const prev = out[out.length - 1];
      if (prev) prev.extend = true;
      out.push(mk(""));
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
      out.push(l);
      continue;
    }
    // 转义的真连字符
    if (ch === "\\" && body[i + 1] === "-") {
      const prev = out[out.length - 1];
      if (prev) prev.text += "-";
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
      out.push(l);
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
        out.push(l);
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
    // 拉丁：到空白 / `-` / `_` / `*` 为止算一个音节；`-` 表示词内断音节
    {
      let j = i;
      while (j < body.length && !/[\s\-_*|{}]/.test(body[j]!) && !isCjk(body[j]!) && !isTrailingPunct(body[j]!)) j++;
      if (j === i) { i++; continue; }
      let text = body.slice(i, j);
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
      out.push(l);
    }
  }
  const res: { syllables: Lyric[]; label?: string } = { syllables: out };
  if (label !== undefined) res.label = label;
  void source;
  return res;
}

function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0x20000 && c <= 0x2ebef)
  );
}

function isTrailingPunct(ch: string): boolean {
  // **引号也不占音符格**。直引号 `"` 分不出开闭，一律贴前字——位置上略有出入，
  // 但对位是对的；而把它当成一个音节会让后面整行错位、末尾溢出丢字。
  return PU_LYRIC_PUNCTUATION.includes(ch) || "”’｡、\"".includes(ch);
}

function isOpenQuote(ch: string): boolean {
  return ch === "“" || ch === "‘";
}


// ───────────────────────── 组装 ─────────────────────────

interface OpenMark {
  type: Mark["type"];
  /** 0 = 还没遇到第一个元素，等 `attach` 回填 */
  start: ElementId;
  level: number;
  tupletActual?: number;
  tupletNormal?: number;
  /** 三连音还差几个音符收尾（ABC §4.13：`(3` 作用于随后 3 个音符，不需要显式收尾） */
  remaining?: number;
}

/** 把一行音乐体的 token 组装进声部。 */
function buildMusicLine(
  ctx: Ctx,
  pb: PartBuild,
  tokens: readonly Token[],
  marks: Mark[],
  openSlurs: OpenMark[],
  openTuplets: OpenMark[],
  pending: { chord?: string; annotations: string[]; decos: string[] },
  openEnding: number[][],
): void {
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
    pb.measure.elements.push(el);
    cur.last = el;
    // 回填还没拿到起点的开弧/开连音——它们的起点就是「`(` 之后的第一个元素」
    for (const o of openSlurs) if (!o.start) o.start = el.id;
    for (const o of openTuplets) if (!o.start) o.start = el.id;
  };

  for (const t of tokens) {
    switch (t.kind) {
      case "space":
        // 只影响符杠分组。**不能清 `sustainHost`**——`5 - 3 -` 这种带空格的写法是常态，
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
          voice: 1,
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
          ch.beamGroup = beamGroup;
        }
        applyTieAndBroken(ch);
        attach(ch);
        cur.sustainHost = ch;
        pb.noteCount++;
        // 三连音按音符计数收尾，并给组内音符打 time-modification
        for (let k = openTuplets.length - 1; k >= 0; k--) {
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
          voice: 1,
          staff: 1,
          source: t.source,
        };
        applyTieAndBroken(ch);
        attach(ch);
        cur.sustainHost = ch;
        pb.noteCount++;
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
          voice: 1,
          staff: 1,
          source: t.source,
        };
        applyTieAndBroken(ch);
        attach(ch);
        cur.sustainHost = ch;
        pb.noteCount++;
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
          voice: 1,
          staff: 1,
          source: t.source,
        };
        if ((t.beams ?? 0) > 0) ch.beams = Array.from({ length: t.beams! }, () => "continue" as const);
        attach(ch);
        cur.sustainHost = ch;
        pb.noteCount++;
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
            voice: 1,
            staff: 1,
            source: t.source,
          };
          if ((t.beams ?? 0) > 0) ch.beams = Array.from({ length: t.beams! }, () => "continue" as const);
          attach(ch);
          cur.sustainHost = ch;
          pb.noteCount++;
          break;
        }
        const sp: Space = {
          kind: "space",
          id: ctx.ids.next(),
          spacer: "y",
          voice: 1,
          staff: 1,
          source: t.source,
        };
        attach(sp);
        cur.sustainHost = null;
        break;
      }

      case "chord":
        pending.chord = t.value ?? "";
        break;

      case "annotation":
        // `"^文字"` / `"_文字"`（ABC §4.19 的注记，`^` 上方 `_` 下方）——
        // 段落词（`（副歌）` 这类）就走这条，与 emit 对称
        pending.annotations.push((t.value ?? "").replace(/^[\^_<>@]/, ""));
        break;

      case "deco":
        pending.decos.push(t.value ?? "");
        break;

      case "grace": {
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: (t.notes ?? []).map((g) => ctx.d.note(g)),
          duration: { divisions: 0, dots: 0 },
          grace: t.acciaccatura ? { slash: true } : {},
          voice: 1,
          staff: 1,
          source: t.source,
        };
        pb.measure.elements.push(ch);
        break;
      }

      case "slurStart":
        // 起点未定：等 `attach` 把「`(` 之后的第一个元素」回填进来
        openSlurs.push({ type: "slur", start: 0, level: openSlurs.length });
        break;

      case "slurEnd": {
        // **`)` 是二义符号**：收圆滑线 还是 收多连音？判据照 `.jpwabc` 那条
        // （`docs/模块/源格式-jpwabc.md`：「前面的音符还欠着 `(` 就先收弧，欠完了才轮到三连音」）——
        // ABC 的多连音本不需要 `)`，但写谱人习惯带上，照收不误。
        if (openSlurs.length === 0) {
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
        const open = openSlurs.pop();
        if (!open) {
          report(ctx, "unmatched-slur", "多余的 `)`", t.source);
          break;
        }
        // `open.start` 由 `attach` 回填；同音起止（`(1)`）时起点就是终点，合法（ABC §4.11）
        if (open.start && cur.last) {
          marks.push({ type: "slur", start: open.start, end: cur.last.id, level: open.level });
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
          // `(n:p:q` 的 p 是「占几个的时间」；简写 `(n:` 按 ABC 的默认取 2
          tupletNormal: t.numbers?.[1] ?? 2,
          // `(n:p:q` 的 q 是「作用于几个音符」，缺省就是 n
          remaining: t.numbers?.[2] ?? actual,
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
        closeMeasure(ctx, pb);
        beamGroup = 0;
        sawSpaceSinceLastNote = true;
        cur.sustainHost = null;
        // 三连音跨不过小节线，收掉
        openTuplets.length = 0;
        break;
      }

      case "break": {
        // `$` 的语义是「**这一小节之后**换行」。小节线通常先到、当前小节已被推进 `measures`，
        // 所以要赋给刚收尾的那一个；否则每次往返都会把换行往后挪一格。
        const target = pb.measure.elements.length > 0
          ? pb.measure
          : pb.part.measures[pb.part.measures.length - 1] ?? pb.measure;
        ctx.breakAfter.set(target, t.value === "page" ? "page" : "system");
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
          else if (r.time) pb.measure.attrs.time = r.time;
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
  pb.part.measures.push(pb.measure);
  pb.measureNo++;
  pb.measure = { number: String(pb.measureNo), elements: [] };
  pb.noteCount = 0;
  void ctx;
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

/** 歌词挂到音符上。按**规范 §5.1**：锚点 `@m,n` 决定起点，缺省从声部第一个音符起。
 *
 *  返回**没挂上的音节数**。音节多于音符时多余的被忽略（ABC §5.1 的标准行为），
 *  但必须报出来——ABC 规范自己就写了「the program should warn the user」，
 *  而静默丢字在语料迁移时是灾难（迁移报表要靠这条诊断发现对位错）。 */
function attachLyrics(
  part: Part,
  syllables: readonly Lyric[],
  anchor: { measure: number; note: number } | undefined,
): number {
  let mi = (anchor?.measure ?? 1) - 1;
  let skip = (anchor?.note ?? 1) - 1;
  let si = 0;
  for (; mi < part.measures.length && si < syllables.length; mi++) {
    const m = part.measures[mi]!;
    for (const el of m.elements) {
      if (el.kind !== "chord" || el.grace) continue;
      if (skip > 0) { skip--; continue; }
      if (si >= syllables.length) break;
      const syl = syllables[si++]!;
      if (syl.text === "" && !syl.extend) continue; // `*` 跳音符：该音符不配字
      (el.lyrics ??= []).push(syl);
    }
  }
  return syllables.length - si;
}

export interface ParseOptions {
  /** 文件名，仅用于诊断 */
  name?: string;
}

/** `.123` 文本 → `ScoreDoc`。 */
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
    breakAfter: new Map(),
  };

  const lines = text.split(/\r?\n/);
  let song: Song | null = null;
  let pb: PartBuild | null = null;
  let rawPlay: RawPlayPass[] = [];
  let marks: Mark[] = [];
  const openSlurs: OpenMark[] = [];
  const openTuplets: OpenMark[] = [];
  const pending = { chord: undefined as string | undefined, annotations: [] as string[], decos: [] as string[] };
  /** 开着的房号（`[1` 到结束线之间）。嵌套不合法，但用栈更稳 */
  const openEnding: number[][] = [];
  /** 待挂的歌词行：音乐体行读完后才挂 */
  let pendingLyrics: { f: FieldLine; syl: Lyric[]; part?: Part }[] = [];

  const finishSong = (): void => {
    if (!song) return;
    if (pb) {
      closeMeasure(ctx, pb);
      if (pb.part.measures.length) song.parts.push(pb.part);
    }
    for (const { f, syl, part } of pendingLyrics) {
      // 歌词挂在它**紧跟的那个声部**上（四声部谱里词常挂在某一个声部下）
      const target = part ?? song.parts[0];
      if (!target) continue;
      const left = attachLyrics(target, syl, f.anchor);
      if (left > 0) {
        report(
          ctx,
          "lyric-overflow",
          `第 ${f.verseFrom ?? 1} 段歌词比音符多 ${left} 个音节，多出的被忽略`,
          f.source,
        );
      }
    }
    pendingLyrics = [];
    // **ABC 只给绝对音高，简谱那一侧要度数**（排版、`emit123`、播放都按度数走）。
    // 换算走 `helpers.ts::degreeFromPitch`——那一处与 `jppitch.ts` 同源，
    // 「两份实现一旦漂移，往返数字就会错」，所以不许在这里另写一份。
    // 反方向（度数 → 音高）留到 `ScoreDoc ↔ MusicXML` 直通那一轮一起补。
    if (ctx.d.id === "abc") fillDegreesFromPitch(song);
    for (const part of song.parts) breaksAfterToStart(part, ctx.breakAfter);
    ctx.breakAfter.clear();
    song.marks = marks;
    if (rawPlay.length) song.playOrder = resolvePlayOrder(song, rawPlay);
    doc.songs.push(song);
    song = null;
    pb = null;
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
  });
  const ensurePart = (voice = 1): PartBuild => {
    pb ??= newPart(voice);
    return pb;
  };
  /** 当前声部。包一层是为了避开 TS 对闭包外 `let` 的控制流窄化（直接写 `pb?.part` 会被当成 never）。 */
  const currentPart = (): Part | undefined => pb?.part;
  /** `V:n` 开新声部：收掉当前声部、换一个。四声部谱靠这个分开，否则会被拼成一串小节。 */
  const startPart = (voice: number): void => {
    const s = ensureSong();
    if (pb) {
      closeMeasure(ctx, pb);
      if (pb.part.measures.length) s.parts.push(pb.part);
    }
    pb = newPart(voice);
  };

  let offset = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln]!;
    const lineOffset = offset;
    offset += raw.length + 1;
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
      // `X:` 开新曲
      if (f.name === "X") {
        finishSong();
        const s = ensureSong();
        s.work.number = f.value;
        continue;
      }
      applyField(ctx, ensureSong(), f, startPart, currentPart(), pendingLyrics, (r) => { rawPlay = rawPlay.concat(r); });
      continue;
    }

    // 音乐体
    const s = ensureSong();
    void s;
    const p = ensurePart();
    const lex = ctx.d.lex(raw, ln, lineOffset, 0);
    for (const e of lex.errors) report(ctx, "lex", e.message, e.source);
    buildMusicLine(ctx, p, lex.tokens, marks, openSlurs, openTuplets, pending, openEnding);
    // ABC §6.1：**代码里的换行就是谱面换行**（默认 `I:linebreak <EOL>`）。
    // 123 不吃这一条——它用显式的 `$`，简谱一行常写得很长，不该被源码折行绑死。
    // 语义同 `$`：「这一小节之后换行」，所以挂在刚收尾的那一个上。
    if (ctx.d.lineEndIsBreak) {
      const target = p.measure.elements.length > 0
        ? p.measure
        : p.part.measures[p.part.measures.length - 1];
      if (target && !ctx.breakAfter.has(target)) ctx.breakAfter.set(target, "system");
    }
  }
  finishSong();
  return doc;
}

function applyField(
  ctx: Ctx,
  song: Song,
  f: FieldLine,
  startPart: (voice: number) => void,
  curPart: Part | undefined,
  pendingLyrics: { f: FieldLine; syl: Lyric[]; part?: Part }[],
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
      const r = parseTime(f.value);
      if (r.error) report(ctx, "bad-time", r.error, f.source);
      else if (r.time) {
        song.time = r.time;
        // ABC §3.1.7：没写 `L:` 时默认音长由 `M:` 推出来
        if (!ctx.sawL) ctx.len = ctx.d.defaultLen(r.time.beats, r.time.beatType);
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
    case "Q":
      // **追加不覆盖**：源里常有两条（`Q:1/4=130` 与 `Q:"热情地"`），
      // 直接赋值会让后一条把前一条顶掉，往返一轮速度就丢了
      song.tempos = [...(song.tempos ?? []), ...parseTempo(f.value)];
      break;
    case "V":
      startPart(f.voice ?? 1);
      break;
    case "w": {
      const { syllables, label } = parseLyricLine(f.value, f.verseFrom ?? 1, f.verseTo, f.source, f.valueOffset);
      // 印刷段号不占音符格，挂在该段**第一个非空**音节上——空音节（`*`）不会被挂到元素上
      // （`attachLyrics` 会跳过），label 跟着它一起丢
      if (label !== undefined) {
        const first = syllables.find((x) => x.text !== "");
        if (first) first.verseLabel = label;
      }
      pendingLyrics.push({ f, syl: syllables, ...(curPart ? { part: curPart } : {}) });
      break;
    }
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
