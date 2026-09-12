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
  Note,
  Part,
  PlayPass,
  ScoreDoc,
  Song,
  SourceSpan,
  Space,
  Sustain,
} from "../model/doc";
import { IdGen, emptyDoc, emptySong } from "../model/helpers";
import {
  CJK_INSTRUCTION_ALIAS,
  parseFieldLine,
  parseInstruction,
  parseKey,
  parseLinebreak,
  parsePlayOrder,
  parseTempo,
  parseTime,
  type FieldLine,
  type RawPlayPass,
} from "./fields";
import { lexMusicLine, type Token } from "./lex";

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

/** 减时线/附点 → divisions。基准：四分音符 = `DIVISIONS`，够表达到 64 分音符与三连音。 */
const DIVISIONS = 48;

const TYPE_BY_BEAMS = ["quarter", "eighth", "16th", "32nd", "64th", "128th", "256th"] as const;

function durationOf(beams: number, dots: number, sustains: number): Chord["duration"] {
  let base = DIVISIONS >> Math.min(beams, 6);
  let total = base;
  // 附点：每个附点加上前一档的一半
  let add = base;
  for (let k = 0; k < dots; k++) {
    add = Math.floor(add / 2);
    total += add;
  }
  // 增时线：每条加一个四分音符（简谱语义：`-` 延长一拍）
  total += sustains * DIVISIONS;
  const type = TYPE_BY_BEAMS[Math.min(beams, TYPE_BY_BEAMS.length - 1)]!;
  return { divisions: total, type, dots };
}

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
): { syllables: Lyric[]; label?: string } {
  const out: Lyric[] = [];
  let i = 0;
  let label: string | undefined;

  // 印刷段号 `<1.>` / `"1."`
  const lm = /^\s*(?:<([^>]*)>|"([^"]*)")/.exec(body);
  if (lm) {
    label = lm[1] ?? lm[2];
    i = lm[0].length;
  }

  const mk = (text: string): Lyric => {
    const l: Lyric = { number: verseFrom, text };
    if (verseTo !== undefined && verseTo !== verseFrom) l.numberTo = verseTo;
    return l;
  };

  while (i < body.length) {
    const ch = body[i]!;
    if (ch === " " || ch === "\t") { i++; continue; }
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
      out.push(mk(body.slice(i + 1, close)));
      i = close + 1;
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
    // 独立的标点（前面没有字可并）——并到前一音节，没有就丢
    if (isTrailingPunct(ch)) {
      const prev = out[out.length - 1];
      if (prev) prev.trailingPunctuation = (prev.trailingPunctuation ?? "") + ch;
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
  return PU_LYRIC_PUNCTUATION.includes(ch) || "”’｡、".includes(ch);
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
  /** 同一符杠组的编号：没有空白相隔的相邻音符同组 */
  let beamGroup = 0;
  let sawSpaceSinceLastNote = true;

  const attach = (el: Element): void => {
    if (pending.chord !== undefined) {
      el.harmony = { root: { step: "C", alter: 0 }, kind: "", text: pending.chord };
      pending.chord = undefined;
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
    pending.annotations = [];
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
        const rest = t.degree === 0;
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: [],
          duration: durationOf(t.beams ?? 0, t.dots ?? 0, 0),
          voice: 1,
          staff: 1,
          source: t.source,
        };
        if (rest) {
          ch.rest = {};
        } else {
          const n: Note = { degree: { number: t.degree!, octaveShift: t.octave ?? 0 } };
          if (t.accidental) {
            n.degree!.accidental = t.accidental;
            n.accidental = t.accidental;
          }
          ch.notes.push(n);
        }
        if ((t.beams ?? 0) > 0) {
          ch.beams = Array.from({ length: t.beams! }, () => "continue" as const);
          ch.beamGroup = beamGroup;
        }
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
        host.duration = durationOf(host.beams?.length ?? 0, host.duration.dots, host.sustains.length);
        sawSpaceSinceLastNote = false;
        break;
      }

      case "spacer": {
        const sp: Space = {
          kind: "space",
          id: ctx.ids.next(),
          spacer: t.value === "x" ? "x" : "y",
          voice: 1,
          staff: 1,
          source: t.source,
        };
        if (sp.spacer === "x") {
          sp.duration = durationOf(t.beams ?? 0, t.dots ?? 0, 0);
          if ((t.beams ?? 0) > 0) sp.beams = Array.from({ length: t.beams! }, () => "continue" as const);
        }
        attach(sp);
        cur.sustainHost = null;
        break;
      }

      case "chord":
        pending.chord = t.value ?? "";
        break;

      case "annotation":
        pending.annotations.push(t.value ?? "");
        break;

      case "deco":
        pending.decos.push(t.value ?? "");
        break;

      case "grace": {
        const ch: Chord = {
          kind: "chord",
          id: ctx.ids.next(),
          notes: (t.notes ?? []).map((g) => ({
            degree: { number: g.degree ?? 1, octaveShift: g.octave ?? 0 },
          })),
          duration: { divisions: 0, dots: 0 },
          grace: {},
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
        // （`docs/架构与实现.md`：「前面的音符还欠着 `(` 就先收弧，欠完了才轮到三连音」）——
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
        target.print = t.value === "page" ? { newPage: true } : { newSystem: true };
        break;
      }

      case "inlineField": {
        const m = /^([A-Za-z])\s*[:：]\s*(.*)$/.exec(t.value ?? "");
        if (!m) break;
        const name = m[1]!.toUpperCase();
        const val = m[2] ?? "";
        pb.measure.attrs ??= {};
        if (name === "K") {
          const r = parseKey(val);
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
  void options;
  const doc = emptyDoc("123");
  doc.source = text;
  const ids = new IdGen();
  const ctx: Ctx = { ids, diagnostics: doc.diagnostics, lineNo: 0, lineOffset: 0 };

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
    const lex = lexMusicLine(raw, ln, lineOffset, 0);
    for (const e of lex.errors) report(ctx, "lex", e.message, e.source);
    buildMusicLine(ctx, p, lex.tokens, marks, openSlurs, openTuplets, pending, openEnding);
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
      (song.identification ??= { creators: [] }).creators.push({ type: "composer", text: f.value });
      break;
    case "K": {
      const r = parseKey(f.value);
      if (r.error) report(ctx, "bad-key", r.error, f.source);
      song.key = r.key;
      break;
    }
    case "M": {
      const r = parseTime(f.value);
      if (r.error) report(ctx, "bad-time", r.error, f.source);
      else if (r.time) song.time = r.time;
      break;
    }
    case "Q":
      song.tempos = parseTempo(f.value);
      break;
    case "V":
      startPart(f.voice ?? 1);
      break;
    case "w": {
      const { syllables, label } = parseLyricLine(f.value, f.verseFrom ?? 1, f.verseTo, f.source);
      // 印刷段号不占音符格，挂在该段第一个音节上，由排版画在字前
      if (label !== undefined && syllables[0]) syllables[0].verseLabel = label;
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
