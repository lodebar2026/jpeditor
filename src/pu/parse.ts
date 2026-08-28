// 文本谱（番茄 / 有谱）→ PuDoc。
//
// 单趟字符扫描，不额外造 token 流——中间表示没有第二个消费者，多一层只会多一处失真。
// 方言差异集中在 dialect.ts 的 DialectSpec 里。
//
// 三类行：
//   头部    `V:` `B:` `Z:` `D:` `P:` `J:`（番茄）/ `T:` `1=C4/4` `XL:` `BC:` …（有谱）
//   曲      `Q:` `Q1:` `Q1"女高":` `Q1<女高>:`
//   词/文字 `C:` `C1:` / `W:`
// 空行分组：相邻的 Q 行（连同其下的 C 行）成为一个 VoiceGroup，上下堆叠横向对齐。

import {
  emptyMetadata,
  type Accidental,
  type BarlineElement,
  type BarlineType,
  type Diagnostic,
  type LyricLine,
  type LyricSyllable,
  type Mark,
  type MarkType,
  type Metadata,
  type Meter,
  type MusicElement,
  type NoteElement,
  type Ornament,
  type PuDoc,
  type PuSong,
  type ScoreLine,
  type ScorePage,
  type SourceSpan,
  type SustainElement,
  type TextLine,
  type VoiceGroup,
} from "./ast";
import { dialectSpec, sniffDialect, type Dialect, type DialectSpec } from "./dialect";
import { PU_LYRIC_PUNCTUATION, PU_LYRIC_QUOTES } from "../common/cjkpunct";

/** 音符后可跟的记号名（`&xx`）。不在表里的会报 unknown-command 但仍保留。 */
const NOTE_COMMANDS = new Set([
  "zkh", "ykh", // 伴奏括弧
  "ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sf", "fp", "sfp", "sfz", // 力度
  "cresc", "dim", "rit", "tempo", "atempo", // 术语
  "yc", "ycy", "bc", "zy", "dy", "hx", // 延长/保持/重音/顿音/呼吸
  "shy", "xhy", "sby", "xby", "cy", "tr", // 滑音/波音/颤音
]);

/** 小节线上可跟的记号名。 */
const BARLINE_COMMANDS = new Set(["fine", "dc", "ds", "ty", "hs", "sbf"]);

/** 两表合一，按长度降序——命令名匹配须最长优先。 */
const ALL_COMMANDS = [...NOTE_COMMANDS, ...BARLINE_COMMANDS].sort((a, b) => b.length - a.length);

interface Ctx {
  dialect: DialectSpec;
  diagnostics: Diagnostic[];
  /** 当前行号（0 基） */
  line: number;
  /** 当前行首在全文里的偏移 */
  lineOffset: number;
}

function span(ctx: Ctx, column: number, length = 1): SourceSpan {
  return { line: ctx.line, column, offset: ctx.lineOffset + column, length };
}

function report(ctx: Ctx, code: string, message: string, column: number, length = 1): void {
  ctx.diagnostics.push({ severity: "warning", code, message, source: span(ctx, column, length) });
}

// ---------------- 音符 ----------------

/** 变音/八度/减时线/附点可以任意顺序跟在数字后面（实测 `5,#` 与 `5#,` 都出现）。 */
function applyModifier(ctx: Ctx, note: NoteElement, ch: string): boolean {
  const d = ctx.dialect;
  const acc: Accidental | undefined = d.accidentals[ch];
  if (ch === d.octaveUp) note.octave += 1;
  else if (ch === d.octaveDown) note.octave -= 1;
  else if (ch === "/") note.duration *= 2;
  else if (ch === ".") note.dots += 1;
  else if (acc !== undefined) note.accidental = acc;
  else return false;
  note.code += ch;
  note.source.length += ch.length;
  return true;
}

interface NoteScan {
  note: NoteElement;
  next: number;
}

/**
 * 从 `src[start]` 起读一个音符。`start` 处必须是数字或方言的节奏音符字符。
 * `baseDuration` 给倚音用（倚音默认八分音符）。
 */
function scanNote(ctx: Ctx, src: string, start: number, baseDuration = 4): NoteScan {
  const d = ctx.dialect;
  const head = src[start] ?? "0";
  let cursor = start + 1;

  let pitch: NoteElement["pitch"];
  let sound: NoteElement["sound"];
  let hidden = false;
  let lyricAnchor = true;
  if (head === d.rhythmToken && !/[0-9]/.test(head)) {
    pitch = 9;
    sound = "rhythm";
  } else if (head === "9") {
    if (d.nineIsRhythm) {
      pitch = 9;
      sound = "rhythm"; // 番茄：9 是节奏音符 X
    } else {
      pitch = 0; // 有谱：9 是隐藏休止，且**不跟歌词**
      sound = "rest";
      hidden = true;
      lyricAnchor = false;
    }
  } else if (head === "8") {
    pitch = 0; // 两家一致：8 是隐藏休止，**跟**歌词
    sound = "rest";
    hidden = true;
  } else {
    pitch = Number(head) as NoteElement["pitch"];
    sound = pitch === 0 ? "rest" : "note";
    // 显形的休止 `0` 默认不跟词（写成 `0@` 才跟）
    if (pitch === 0) lyricAnchor = false;
  }

  const note: NoteElement = {
    kind: "note",
    pitch,
    sound,
    hidden,
    lyricAnchor,
    octave: 0,
    duration: baseDuration,
    dots: 0,
    ornaments: [],
    graceBefore: [],
    graceAfter: [],
    code: head,
    source: span(ctx, start, 1),
  };
  while (cursor < src.length && applyModifier(ctx, note, src[cursor]!)) cursor += 1;
  return { note, next: cursor };
}

/** 倚音串：`{3,4,}` 里的内容 / `[2]` 里的内容 / `"yy:3/2/"` 冒号后的内容。 */
function scanGraceNotes(ctx: Ctx, body: string, columnBase: number): NoteElement[] {
  const out: NoteElement[] = [];
  const sub: Ctx = { ...ctx, lineOffset: ctx.lineOffset + columnBase };
  let cursor = 0;
  while (cursor < body.length) {
    const ch = body[cursor]!;
    if (/[0-9]/.test(ch) || ch === ctx.dialect.rhythmToken) {
      const r = scanNote(sub, body, cursor, 8); // 倚音默认八分
      r.note.source.column += columnBase;
      out.push(r.note);
      cursor = r.next;
      continue;
    }
    if (!/\s/.test(ch)) {
      report(ctx, "unsupported-grace-token", `倚音里无法识别的字符 '${ch}'`, columnBase + cursor);
    }
    cursor += 1;
  }
  return out;
}

// ---------------- 双引号内容 ----------------

interface QuotedMeaning {
  chord?: string;
  meter?: Meter;
  graceBefore?: NoteElement[];
  graceAfter?: NoteElement[];
  annotation?: string;
}

function parseMeter(raw: string, parenthesized = false): Meter | undefined {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
  if (!m) return undefined;
  const numerator = Number(m[1]);
  const denominator = Number(m[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }
  return { numerator, denominator, parenthesized };
}

/** 双引号里可能是和弦 `hx:`、临时拍号 `p:`、倚音（有谱 `yy:`/`hyy:`）或普通注释。 */
function interpretQuoted(ctx: Ctx, body: string, columnBase: number): QuotedMeaning {
  const hx = /^hx:\s*/i.exec(body);
  if (hx) return { chord: body.slice(hx[0].length) };
  const meter = /^p:\s*/i.exec(body);
  if (meter) {
    const parsed = parseMeter(body.slice(meter[0].length));
    if (parsed) return { meter: parsed };
    report(ctx, "bad-temporary-meter", `临时拍号无法解析：'${body}'`, columnBase, body.length);
    return { annotation: body };
  }
  const grace = /^(h?yy):\s*/i.exec(body);
  if (grace) {
    const notes = scanGraceNotes(ctx, body.slice(grace[0].length), columnBase + grace[0].length);
    return grace[1]!.toLowerCase() === "yy" ? { graceBefore: notes } : { graceAfter: notes };
  }
  return { annotation: body };
}

type Attachable = NoteElement | SustainElement | BarlineElement;

function applyQuoted(target: Attachable, q: QuotedMeaning): void {
  if (q.meter !== undefined && target.kind === "barline") target.temporaryMeter = q.meter;
  if (q.annotation !== undefined) target.annotation = q.annotation;
  // 和弦既可挂音符，也可挂增时线——长音里第二、三拍换和弦时，谱面就把它印在增时线上方。
  if (q.chord !== undefined && (target.kind === "note" || target.kind === "sustain")) {
    target.chord = q.chord;
  }
  if (target.kind !== "note") return;
  if (q.graceBefore) target.graceBefore.push(...q.graceBefore);
  if (q.graceAfter) target.graceAfter.push(...q.graceAfter);
}

// ---------------- 行内记号栈 ----------------

interface OpenMark {
  type: MarkType;
  start: number;
  level: number;
  column: number;
  caption?: string;
  openEnd?: boolean;
  fromPrevious?: boolean;
  /**
   * 这条弧线跨行时，已经落在各行 `marks` 里的「半条弧」。若它到最后也没等到 `)`
   * （例如源里换了声部号），就把这些半条弧全撤掉——原版渲染在这种情形下什么都不画。
   */
  pending?: Array<{ list: Mark[]; mark: Mark }>;
}

export interface MusicLineResult {
  elements: MusicElement[];
  marks: Mark[];
  /** 未闭合的弧线/多连音，交给下一行（弧线支持跨行） */
  carriedCurves: OpenMark[];
  /** 未闭合的跳房子，同样跨行 */
  carriedVoltas: OpenMark[];
}

function makeMark(open: OpenMark, end: number, ctx: Ctx, toNext = false): Mark {
  const mark: Mark = {
    type: open.type,
    start: open.start,
    end,
    level: open.level,
    source: span(ctx, open.column),
  };
  if (open.caption !== undefined) mark.caption = open.caption;
  if (open.openEnd) mark.openEnd = true;
  if (open.fromPrevious) mark.continuationFromPrevious = true;
  if (toNext) mark.continuationToNext = true;
  return mark;
}

/** 最后一个可挂记号的元素（音符/增时线/小节线）。 */
function lastAttachable(elements: MusicElement[]): Attachable | undefined {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const el = elements[i]!;
    if (el.kind === "note" || el.kind === "sustain" || el.kind === "barline") return el;
  }
  return undefined;
}

function readQuotedRun(src: string, index: number): { body: string; next: number } | undefined {
  if (src[index] !== '"') return undefined;
  const end = src.indexOf('"', index + 1);
  if (end < 0) return undefined;
  return { body: src.slice(index + 1, end), next: end + 1 };
}

function countPluses(src: string, index: number): { level: number; next: number } {
  let n = index;
  while (src[n] === "+") n += 1;
  return { level: n - index, next: n };
}

/** 解析一行曲。`carried*` 传入上一行留下的未闭合记号。 */
export function parseMusicLine(
  ctx: Ctx,
  src: string,
  startColumn: number,
  carriedCurves: OpenMark[] = [],
  carriedVoltas: OpenMark[] = [],
): MusicLineResult {
  const d = ctx.dialect;
  const elements: MusicElement[] = [];
  const marks: Mark[] = [];
  const curves: OpenMark[] = carriedCurves.map((m) => ({ ...m, start: 0, fromPrevious: true }));
  const voltas: OpenMark[] = carriedVoltas.map((m) => ({ ...m, start: 0, fromPrevious: true }));
  const wedges: OpenMark[] = [];

  let i = startColumn;
  while (i < src.length) {
    const ch = src[i]!;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // 数字音符 / 节奏音符
    if (/[0-9]/.test(ch) || ch === d.rhythmToken) {
      const r = scanNote(ctx, src, i);
      elements.push(r.note);
      i = r.next;
      continue;
    }

    // 增时线
    if (ch === "-") {
      elements.push({
        kind: "sustain",
        duration: 4,
        lyricAnchor: false,
        ornaments: [],
        code: "-",
        source: span(ctx, i),
      });
      i += 1;
      continue;
    }

    // `@`：强制让前一个符号跟一个歌词。默认不跟词的增时线 `-@`、休止 `0@`、
    // 隐藏休止 `9@` 都靠它翻转（规范只提了 `-@`，实际谱面里三者都在用）。
    if (ch === "@") {
      const prev = elements[elements.length - 1];
      if (prev?.kind === "note" || prev?.kind === "sustain") {
        prev.lyricAnchor = true;
        prev.code += "@";
        prev.source.length += 1;
      } else {
        report(ctx, "orphan-lyric-anchor", "'@' 前面没有可跟词的符号", i);
      }
      i += 1;
      continue;
    }

    // 强制连/断拍
    if (ch === "~" || ch === "^") {
      elements.push({
        kind: "beat-boundary",
        behavior: ch === "~" ? "join" : "split",
        code: ch,
        source: span(ctx, i),
      });
      i += 1;
      continue;
    }

    // 小节线（含 :| 开头的），须在弧线 `)` 之后判断，故先于 `|`/`:` 处理
    if (ch === "|" || ch === ":") {
      const found = d.barlines.find(([code]) => src.startsWith(code, i));
      if (found) {
        const [code, type] = found;
        const bar: BarlineElement = {
          kind: "barline",
          type: type as BarlineType,
          ornaments: [],
          code,
          source: span(ctx, i, code.length),
        };
        elements.push(bar);
        i += code.length;
        continue;
      }
      report(ctx, "bad-barline", `无法识别的小节线 '${ch}'`, i);
      i += 1;
      continue;
    }

    // 弧线 / 多连音 / 伴奏记号
    if (ch === "(") {
      const isTuplet = src[i + 1] === "y";
      curves.push({
        type: isTuplet ? "tuplet" : "slur",
        start: elements.length,
        level: curves.length + 1,
        column: i,
      });
      i += isTuplet ? 2 : 1;
      continue;
    }
    if (ch === ")") {
      // **先开的先闭**（队列，不是栈）：原版里 `(5 - | (5) - | (5) - | 5)` 是首尾相接的
      // 三条 tie，用栈配对会得到一条横跨四小节的长弧（判据：《太阳出来喜洋洋》末行，
      // 参考渲染画的是 206→304、306→400、402→500 三条短弧）。
      const open = curves.shift();
      if (open === undefined) {
        report(ctx, "unmatched-slur-end", "多余的 ')'", i);
      } else {
        // 队首闭合，它前面没有别的未闭合弧线，所以层号固定在第一层——
        // 链式 tie 的几条弧因此等高（原版如此）
        open.level = 1;
        marks.push(makeMark(open, Math.max(0, elements.length - 1), ctx));
      }
      i += 1;
      continue;
    }

    // 渐强渐弱：`<`/`>` 起，`!` 止；后跟的 `+` 越多位置越高
    if (ch === "<" || ch === ">") {
      const { level, next } = countPluses(src, i + 1);
      // `5<` 里的 `<` 是跟在音符**后面**写的，起点就是那个音符（和 `&xx` 一样），
      // 不是它之后的下一个音符。
      wedges.push({
        type: ch === "<" ? "crescendo" : "decrescendo",
        start: Math.max(0, elements.length - 1),
        level,
        column: i,
      });
      i = next;
      continue;
    }
    if (ch === "!") {
      const open = wedges.pop();
      if (open === undefined) report(ctx, "unmatched-wedge-end", "多余的 '!'", i);
      else marks.push(makeMark(open, Math.max(0, elements.length - 1), ctx));
      i += 1;
      continue;
    }

    // 倚音（番茄）：`1[2]` 前倚音、`1[h2]` 后倚音。与跳房子共用 `[`，靠**是否紧贴音符**区分
    // ——跳房子只写在小节线处，中间必有空格或小节线。
    if (ch === "[") {
      const prevEl = elements[elements.length - 1];
      const adjacent =
        prevEl?.kind === "note" && prevEl.source.column + prevEl.source.length === i;
      if (adjacent) {
        const end = src.indexOf("]", i + 1);
        if (end < 0) {
          report(ctx, "unterminated-grace", "倚音的 '[' 没有闭合", i);
          i += 1;
          continue;
        }
        let body = src.slice(i + 1, end);
        let after = false;
        if (/^h/i.test(body)) {
          after = true;
          body = body.slice(1);
        }
        const notes = scanGraceNotes(ctx, body, i + 1 + (after ? 1 : 0));
        if (after) prevEl.graceAfter.push(...notes);
        else prevEl.graceBefore.push(...notes);
        prevEl.code += src.slice(i, end + 1);
        prevEl.source.length += end + 1 - i;
        i = end + 1;
        continue;
      }
    }

    // 跳房子：`[` 起（可跟 `+` 抬高与 `"房号"`），`]` 止（`]/` 不封口）
    if (ch === "[") {
      const { level, next } = countPluses(src, i + 1);
      let cursor = next;
      let caption: string | undefined;
      const quoted = readQuotedRun(src, cursor);
      if (quoted) {
        caption = quoted.body;
        cursor = quoted.next;
      }
      // 番茄：`[…/` 表示右侧不封口，`/` 紧跟在房号之后
      let openEnd = false;
      if (src[cursor] === "/") {
        openEnd = true;
        cursor += 1;
      }
      const open: OpenMark = { type: "volta", start: elements.length, level, column: i };
      if (caption !== undefined) open.caption = caption;
      if (openEnd) open.openEnd = true;
      voltas.push(open);
      i = cursor;
      continue;
    }
    if (ch === "]") {
      let cursor = i + 1;
      let openEnd = false;
      if (src[cursor] === "/") {
        // 诗歌本：`]/` 右侧不封口
        openEnd = true;
        cursor += 1;
      }
      const open = voltas.pop();
      if (open === undefined) {
        report(ctx, "unmatched-volta-end", "多余的 ']'", i);
      } else {
        if (openEnd) open.openEnd = true;
        marks.push(makeMark(open, Math.max(0, elements.length - 1), ctx));
      }
      i = cursor;
      continue;
    }

    // `&xx` 记号（音符或小节线上）
    if (ch === "&") {
      // `2&yc&5/`、`5&zy&+6`：命令后可再写一个裸 `&` 作终止符（其后还可跟 `+` 调高度），
      // `&++"(副歌)"` 则是只有高度和文字的匿名标记。
      const bare = /^&(\++)?(?=["\s]|$|[0-9])/.exec(src.slice(i));
      if (bare) {
        const lvl = bare[1]?.length ?? 0;
        const host = lastAttachable(elements);
        const lastOrn = host?.ornaments[host.ornaments.length - 1];
        if (lvl > 0 && lastOrn) lastOrn.level += lvl;
        i += bare[0].length;
        continue;
      }
      // 已知命令按**最长优先**匹配，免得 `&ycd` 把八度字母 d 吞进命令名。
      const tail = src.slice(i + 1);
      let known = "";
      for (const cand of ALL_COMMANDS) {
        if (cand.length > known.length && tail.toLowerCase().startsWith(cand)) known = cand;
      }
      const m = known
        ? { 0: "&" + tail.slice(0, known.length) }
        : /^&(?:a\s+tempo|[A-Za-z]+)/.exec(src.slice(i));
      if (!m) {
        i += 1;
        continue;
      }
      const rawName = m[0].slice(1);
      const name = rawName.replace(/\s+/g, "").toLowerCase();
      const { level, next } = countPluses(src, i + m[0].length);
      const target = lastAttachable(elements);
      const orn: Ornament = { name, level, source: span(ctx, i, next - i) };
      if (target === undefined) {
        report(ctx, "orphan-command", `记号 &${rawName} 前面没有可挂载的符号`, i, next - i);
      } else {
        if (!NOTE_COMMANDS.has(name) && !BARLINE_COMMANDS.has(name)) {
          report(ctx, "unknown-command", `未知记号 &${rawName}`, i, next - i);
        }
        target.ornaments.push(orn);
      }
      i = next;
      continue;
    }

    // 番茄的倚音：`1[2]` —— 但 `[` 已被跳房子占用，故倚音只在紧跟音符时成立。
    // 实际番茄脚本里倚音写作 `1[2]`，跳房子只出现在小节线后；用「前一个元素是不是音符
    // 且中间无空格」区分。这里 `[` 分支已在上面处理，故到不了；保留分支以防将来调整。

    // 双引号：注释 / 和弦 / 临时拍号 / 有谱倚音
    if (ch === '"') {
      const quoted = readQuotedRun(src, i);
      if (!quoted) {
        report(ctx, "unterminated-quote", "双引号没有闭合", i);
        i = src.length;
        continue;
      }
      const meaning = interpretQuoted(ctx, quoted.body, i + 1);
      const target = lastAttachable(elements);
      if (target === undefined) {
        report(ctx, "orphan-annotation", `注释 "${quoted.body}" 前面没有可挂载的符号`, i);
      } else {
        applyQuoted(target, meaning);
      }
      i = quoted.next;
      continue;
    }

    // `{bz…}` 临时伴奏 / `{dsb…}` 临时多声部
    if (ch === "{") {
      const end = src.indexOf("}", i + 1);
      if (end < 0) {
        report(ctx, "unterminated-layer", "'{' 没有闭合", i);
        i = src.length;
        continue;
      }
      const inner = src.slice(i + 1, end);
      const roleMatch = /^\s*(bz|dsb)/i.exec(inner);
      const role: "accompaniment" | "voice" =
        roleMatch && roleMatch[1]!.toLowerCase() === "dsb" ? "voice" : "accompaniment";
      const bodyStart = roleMatch ? roleMatch[0].length : 0;
      const sub = parseMusicLine(ctx, src.slice(0, end), i + 1 + bodyStart);
      elements.push({
        kind: "inline-layer",
        role,
        elements: sub.elements,
        marks: sub.marks,
        code: src.slice(i, end + 1),
        source: span(ctx, i, end + 1 - i),
      });
      i = end + 1;
      continue;
    }

    // 不带引号的和弦名：`3Dm1`、`1Am.5/`、`3D/A2`。大写 A–G 打头，
    // 后面跟和弦常用字符。挂到前一个音符上，与 `"hx:…"` 等价。
    if (/[A-G]/.test(ch)) {
      const chord = /^[A-G][#b]?(?:maj|min|sus|dim|aug|add|m|M)?\d*(?:\/[A-G][#b]?)?/.exec(
        src.slice(i),
      );
      const host = lastAttachable(elements);
      if (chord && host?.kind === "note") {
        host.chord = chord[0];
        i += chord[0].length;
        continue;
      }
    }

    // `5&rit/`：记号可以插在数字与时值之间，落单的修饰符要回补给上一个音符。
    // `2~/`：`~`/`^` 只是节拍连断标记，回补时要跨过它们；但绝不跨过小节线。
    let back = elements.length - 1;
    while (back >= 0 && elements[back]!.kind === "beat-boundary") back -= 1;
    const prev = back >= 0 ? elements[back] : undefined;
    if (prev?.kind === "note" && applyModifier(ctx, prev, ch)) {
      i += 1;
      continue;
    }

    report(ctx, "unexpected-char", `无法识别的字符 '${ch}'`, i);
    i += 1;
  }

  // 行末仍未闭合的：弧线与跳房子都支持跨行，记为「延续到下一行」
  const lastIndex = Math.max(0, elements.length - 1);
  for (const open of curves) {
    const mark = makeMark(open, lastIndex, ctx, true);
    marks.push(mark);
    (open.pending ??= []).push({ list: marks, mark });
  }
  for (const open of voltas) marks.push(makeMark(open, lastIndex, ctx, true));
  for (const open of wedges) {
    report(ctx, "unclosed-wedge", "渐强/渐弱没有用 '!' 收尾", open.column);
    marks.push(makeMark(open, lastIndex, ctx));
  }

  return { elements, marks, carriedCurves: curves, carriedVoltas: voltas };
}

// ---------------- 歌词 ----------------

/** 能自动附到前一个字后面、不占音符位的标点（表在 common/cjkpunct.ts）。 */
const LYRIC_PUNCTUATION = PU_LYRIC_PUNCTUATION;
const LYRIC_QUOTES = PU_LYRIC_QUOTES;

function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x3400 && c <= 0x9fff) || // CJK 统一表意
    (c >= 0xf900 && c <= 0xfaff) || // 兼容表意
    (c >= 0x3040 && c <= 0x30ff) // 假名
  );
}

/**
 * 解析一行歌词。
 *
 * 两家共同：一个汉字对应一个音符；标点自动附到前字；`@` 跳过一个音符。
 * 分歧：番茄用 `~` 把两字并作一个音符、`/` 分隔英文单词；
 *       有谱用 `{哆啊}` 并字、`/` 也是跳过、英文靠空格分词。
 */
export function parseLyricBody(ctx: Ctx, src: string, startColumn: number): LyricSyllable[] {
  const d = ctx.dialect;
  const out: LyricSyllable[] = [];
  const skipChars = new Set(d.lyricSkip);
  const wordSeparator = d.wordSeparator;

  const pushSyllable = (text: string, column: number, length: number): void => {
    out.push({ text, source: span(ctx, column, length) });
  };

  let i = startColumn;
  while (i < src.length) {
    const ch = src[i]!;

    if (skipChars.has(ch)) {
      pushSyllable("", i, 1); // 空音节 = 跳过一个音符
      i += 1;
      continue;
    }
    if (ch === wordSeparator) {
      i += 1; // 分词符本身不产生音节
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    // `-` `0` 是照抄曲行的增时线/休止，「直接跳过」——它们本就不跟词，
    // 对位时由音符侧的 lyricAnchor 决定，歌词侧不该再占位。`^`/`()` 同理。
    // `-` `0` `^` `|` `*` 是照抄曲行的增时线/休止/小节线，歌词侧直接略过。
    // **括号不在此列**——歌词里的 `(阿们)` 是正文，印刷谱上要显示出来。
    if ("-0^|*".includes(ch)) {
      i += 1;
      continue;
    }
    // 括号：左括号领起后一个字，右括号贴前一个字（与引号同一处理）
    if (ch === "(" || ch === "（") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j]!)) j += 1;
      const cp = src.codePointAt(j);
      if (cp === undefined) {
        i += 1;
        continue;
      }
      const len = cp > 0xffff ? 2 : 1;
      pushSyllable(ch + src.slice(j, j + len), i, j + len - i);
      i = j + len;
      continue;
    }
    if (ch === ")" || ch === "）") {
      const prev = out[out.length - 1];
      if (prev) {
        prev.trailingPunctuation = (prev.trailingPunctuation ?? "") + ch;
        prev.source.length += 1;
      }
      i += 1;
      continue;
    }

    // 行中的 `<…>` 说明文字（`<？>`、`<2.%40>`）：整体略过，不占音符位。
    if (ch === "<") {
      const end = src.indexOf(">", i + 1);
      if (end < 0) {
        report(ctx, "unterminated-lyric-annotation", "歌词说明文字没有闭合", i);
        i += 1;
        continue;
      }
      i = end + 1;
      continue;
    }

    // 行末落单的 `}`：把相邻几段歌词括在一起的联合括号，不是并字，也不占音符位
    if (ch === "}") {
      i += 1;
      continue;
    }

    // 并字：番茄 `啊~哈`（后置连接号）/ 有谱 `{哆啊}`
    if (ch === "{") {
      const end = src.indexOf("}", i + 1);
      if (end < 0) {
        report(ctx, "unterminated-lyric-group", "歌词里的 '{' 没有闭合", i);
        i += 1;
        continue;
      }
      pushSyllable(src.slice(i + 1, end), i, end + 1 - i);
      i = end + 1;
      continue;
    }

    // 标点：附到前一个音节，不占音符位
    if (LYRIC_PUNCTUATION.includes(ch)) {
      const prev = out[out.length - 1];
      if (prev) {
        prev.trailingPunctuation = (prev.trailingPunctuation ?? "") + ch;
        prev.source.length += 1;
      } else {
        pushSyllable(ch, i, 1);
      }
      i += 1;
      continue;
    }
    // 引号：左引号领起下一个字，右引号贴前一个字
    if (LYRIC_QUOTES.includes(ch)) {
      const isOpen = ch === "“" || ch === "‘";
      if (isOpen) {
        const start = i;
        i += 1;
        while (i < src.length && /\s/.test(src[i]!)) i += 1;
        if (i < src.length) {
          const next = src[i]!;
          pushSyllable(ch + next, start, i + 1 - start);
          i += 1;
        }
      } else {
        const prev = out[out.length - 1];
        if (prev) {
          prev.trailingPunctuation = (prev.trailingPunctuation ?? "") + ch;
          prev.source.length += 1;
        }
        i += 1;
      }
      continue;
    }

    // 英文单词：连续 ASCII 字母算一个音节
    if (/[A-Za-z']/.test(ch)) {
      let end = i;
      while (end < src.length && /[A-Za-z']/.test(src[end]!)) end += 1;
      pushSyllable(src.slice(i, end), i, end - i);
      i = end;
      continue;
    }

    // 汉字 / 其余可见字符：一个字一个音符
    const cp = src.codePointAt(i)!;
    const chLen = cp > 0xffff ? 2 : 1;
    const text = src.slice(i, i + chLen);
    if (!isCjk(text) && cp < 0x7f) {
      report(ctx, "unexpected-lyric-char", `歌词里无法识别的字符 '${text}'`, i, chLen);
    }
    // 并字连接号（番茄的 `~`）：把本字并到前一个音节
    if (d.joinToken !== undefined && text === d.joinToken) {
      i += chLen;
      const nextCp = src.codePointAt(i);
      if (nextCp !== undefined) {
        const nextLen = nextCp > 0xffff ? 2 : 1;
        const prev = out[out.length - 1];
        if (prev) {
          prev.text += src.slice(i, i + nextLen);
          prev.source.length += 1 + nextLen;
        } else {
          pushSyllable(src.slice(i, i + nextLen), i, nextLen);
        }
        i += nextLen;
      }
      continue;
    }
    pushSyllable(text, i, chLen);
    i += chLen;
  }
  return out;
}

/** 歌词行前置说明：番茄 `"狼:"`（空格写作 `_`）；有谱 `<狼:1.%40>`（`%50` 为间隙）。 */
function stripLyricAnnotation(
  ctx: Ctx,
  src: string,
  startColumn: number,
): { annotation?: string; gap: number; next: number } {
  let i = startColumn;
  while (i < src.length && /\s/.test(src[i]!)) i += 1;
  const open = src[i];
  if (open !== '"' && open !== "<") return { gap: 20, next: startColumn };
  const close = open === '"' ? '"' : ">";
  const end = src.indexOf(close, i + 1);
  if (end < 0) {
    report(ctx, "unterminated-lyric-annotation", "歌词说明文字没有闭合", i);
    return { gap: 20, next: startColumn };
  }
  let body = src.slice(i + 1, end);
  let gap = 20;
  const gapMatch = /%(\d+)\s*$/.exec(body);
  if (gapMatch) {
    gap = Number(gapMatch[1]);
    body = body.slice(0, gapMatch.index);
  }
  // 番茄用 `_` 代替空格；有谱的 `%40` 是 URL 编码的 `@`
  body = body.replace(/_/g, " ").replace(/%40/g, "@");
  return { annotation: body, gap, next: end + 1 };
}

// ---------------- 头部 ----------------

const METADATA_KEYS = new Set([
  "V", "B", "Z", "D", "P", "J", // 番茄
  "T", "XL", "XR", "TL", "TR", "BL", "BC", "BR", // 有谱
  "FONTSIZE", "MARGIN", "SPACE", "OFF", // 版面指令：`Space: qu=10`、`Off: hx;`
]);

/** `1=Cb4/4 3/4 可跟文字`：有谱把调号与（多个）拍号写在一行。 */
function parseShigeKeyLine(meta: Metadata, value: string, tonic = "1"): void {
  const m = /^([A-Ga-g])([b#$♭♯]?)/.exec(value.trim());
  if (m) {
    const letter = m[1]!.toUpperCase();
    meta.mode = m[2] ? `${m[2]}${letter}` : letter;
  }
  if (tonic !== "1") meta.tonic = tonic;
  const rest = value.trim().slice(m ? m[0].length : 0);
  for (const mm of rest.matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
    meta.meters.push({
      numerator: Number(mm[1]),
      denominator: Number(mm[2]),
      parenthesized: false,
    });
  }
}

function applyMetadata(ctx: Ctx, meta: Metadata, key: string, value: string, column: number): void {
  const v = value.trim();
  switch (key.toUpperCase()) {
    case "V":
      meta.version = v;
      break;
    case "B":
    case "T":
      meta.titles.push(v);
      break;
    case "Z":
      meta.authors.push(v);
      break;
    case "D": {
      if (!/^(?:[A-G][#$b♭♯]?|[#$b♭♯][A-G])$/.test(v)) {
        report(ctx, "bad-mode", `调号 '${v}' 不是 A–G（可带升降号）的形式`, column, v.length);
      }
      meta.mode = v;
      break;
    }
    case "P": {
      // `P: 4/4 2/4` 或 `P: 4/4 ( 2/4 1/4 )`
      let inParen = false;
      for (const tok of v.split(/\s+/)) {
        if (tok.startsWith("(")) inParen = true;
        const parsed = parseMeter(tok.replace(/[()]/g, ""), inParen);
        if (parsed) meta.meters.push(parsed);
        if (tok.endsWith(")")) inParen = false;
      }
      if (meta.meters.length === 0) {
        report(ctx, "bad-meter", `拍号 '${v}' 无法解析`, column, v.length);
      }
      break;
    }
    case "J": {
      // 「120 欢快的」：数字与文字可并存
      const num = /^(\d+(?:\.\d+)?)\s*/.exec(v);
      if (num) {
        meta.tempos.push(Number(num[1]));
        const text = v.slice(num[0].length).trim();
        if (text) meta.tempos.push(text);
      } else if (v) {
        meta.tempos.push(v);
      }
      break;
    }
    case "XL": meta.indexLeft = v; break;
    case "XR": meta.indexRight = v; break;
    case "TL": meta.topLeft.push(v); break;
    case "TR": meta.topRight.push(v); break;
    case "BL": meta.bottomLeft.push(v); break;
    case "BC": meta.bottomCenter.push(v); break;
    case "BR": meta.bottomRight.push(v); break;
    case "FONTSIZE": meta.fontSizes.push(v); break;
    case "MARGIN": meta.margins.push(v); break;
    case "SPACE":
    case "OFF":
      meta.options.push({ key: key.toUpperCase(), value: v });
      break;
    default:
      report(ctx, "unknown-metadata", `未知头部字段 '${key}'`, column, key.length);
  }
}

// ---------------- 文档装配 ----------------

/**
 * 行首前缀：`Q`/`C`/`W`，可跟
 *   - 变体后缀 `!` / `-`（有谱实际在用，手册未载）
 *   - 段号或段号区间 `1` / `1-2`
 *   - 声部名（番茄 `"女高"` / 有谱 `<女高>`）
 */
const BODY_PREFIX = /^\s*([QCW])([!+-]?)(\d*)(?:-(\d+))?(?:"([^"]*)"|<([^>]*)>)?\s*[:：]/;
/** 头部前缀：字母或 FontSize/Margin + `:` */
const META_PREFIX = /^\s*([A-Za-z]+)\s*[:：]/;
/** 有谱的分曲线：整行都是连字符（其后是另一首） */
const SONG_SPLIT = /^-{5,}\s*$/;


export interface ParseOptions {
  /** 指定方言，跳过嗅探 */
  dialect?: Dialect;
}

export function parsePu(text: string, options: ParseOptions = {}): PuDoc {
  const diagnostics: Diagnostic[] = [];
  let dialect = options.dialect;
  if (dialect === undefined) {
    const sniffed = sniffDialect(text);
    if (sniffed.dialect === null) {
      return {
        dialect: "tomato",
        source: text,
        songs: [],
        diagnostics: [
          {
            severity: "error",
            code: "unknown-dialect",
            message: sniffed.reason,
            source: { line: 0, column: 0, offset: 0, length: 0 },
          },
        ],
      };
    }
    dialect = sniffed.dialect;
  }

  const ctx: Ctx = { dialect: dialectSpec(dialect), diagnostics, line: 0, lineOffset: 0 };
  const songs: PuSong[] = [];
  let metadata = emptyMetadata();
  let pages: ScorePage[] = [];
  let page: ScorePage = { index: 0, groups: [] };
  let group: VoiceGroup | null = null;
  let pendingTexts: TextLine[] = [];
  let lastVoice: ScoreLine | null = null;
  // 跨行未闭合的弧线 / 跳房子**按声部**存放：一行 `Q3` 里没收口的弧线要接到下一组的
  // `Q3` 上，接到别的声部去会画出一条横贯整行的假弧。
  const carriedCurves = new Map<number, OpenMark[]>();
  const carriedVoltas = new Map<number, OpenMark[]>();
  /** 到最后也没等到 `)` 的跨行弧线：把已经画出去的半条弧撤掉（原版此时什么都不画） */
  const dropUnresolvedCurves = (): void => {
    for (const list of carriedCurves.values()) {
      for (const open of list) {
        for (const { list: marks, mark } of open.pending ?? []) {
          const at = marks.indexOf(mark);
          if (at >= 0) marks.splice(at, 1);
        }
      }
    }
    carriedCurves.clear();
  };
  let autoVerse = 0;
  // 上一条 `Q:` 是空行：其后的歌词是「收尾改写」，覆盖同段歌词末尾的几个字
  let tailOverride = false;
  // 跨 flushGroup 存活的「上一条有音符的曲行」，收尾改写要用
  let lastRealVoice: ScoreLine | null = null;

  const flushGroup = (): void => {
    if (group && group.voices.length > 0) page.groups.push(group);
    group = null;
    lastVoice = null;
  };
  const flushPage = (): void => {
    flushGroup();
    if (page.groups.length > 0) pages.push(page);
    page = { index: pages.length, groups: [] };
  };
  // 诗歌本用整行 `-----` 分隔「一首多唱」——它们本就该同页展示，所以各自成曲、
  // 都保留下来，而不是只取第一首。
  const flushSong = (): void => {
    flushPage();
    if (pages.length === 0) return;
    songs.push({ index: songs.length, metadata, pages });
    metadata = emptyMetadata();
    pages = [];
    page = { index: 0, groups: [] };
  };

  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let ln = 0; ln < lines.length; ln += 1) {
    const raw = lines[ln]!;
    ctx.line = ln;
    ctx.lineOffset = offset;
    offset += raw.length + 1;
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
      flushGroup();
      continue;
    }
    if (trimmed.startsWith("#")) continue; // 注释行
    if (SONG_SPLIT.test(trimmed)) {
      flushSong();
      dropUnresolvedCurves();
      carriedVoltas.clear();
      continue;
    }
    if (/^\[fenye\]$/i.test(trimmed)) {
      flushPage();
      continue;
    }
    // `1=bD 4/4`，也有 `6=c3/2` 这样以别的音为主音的（小调）写法。
    const keyLine = /^\s*([1-7])\s*=/.exec(raw);
    if (keyLine) {
      parseShigeKeyLine(metadata, raw.slice(raw.indexOf("=") + 1), keyLine[1]!);
      continue;
    }

    const body = BODY_PREFIX.exec(raw);
    if (body) {
      const kind = body[1]!;
      const variant = body[2] ?? "";
      const numberText = body[3] ?? "";
      const rangeEnd = body[4];
      const caption = body[5] ?? body[6];
      const contentAt = body[0].length;

      if (kind === "W") {
        pendingTexts.push({
          text: raw.slice(contentAt).trim(),
          source: span(ctx, contentAt, raw.length - contentAt),
        });
        continue;
      }

      if (kind === "Q") {
        const voiceNo = numberText ? Number(numberText) : 1;
        // 声部号回到已出现过的值 → 新的一组（Q1/Q2/Q3 顺次成组）
        if (group && group.voices.some((v) => v.voice === voiceNo)) flushGroup();
        if (!group) {
          group = { index: page.groups.length, texts: pendingTexts, voices: [] };
          pendingTexts = [];
          autoVerse = 0;
        }
        // 实际谱面里有 `Q: Q:5d…`、`Q::3g/…` 这类重复前缀 / 多余冒号，跳过即可。
        let musicAt = contentAt;
        const dup = BODY_PREFIX.exec(raw.slice(musicAt));
        if (dup && dup[1] === "Q") musicAt += dup[0].length;
        while (raw[musicAt] === ":" || raw[musicAt] === " ") musicAt += 1;
        const parsed = parseMusicLine(
          ctx,
          raw,
          musicAt,
          carriedCurves.get(voiceNo) ?? [],
          carriedVoltas.get(voiceNo) ?? [],
        );
        carriedCurves.set(voiceNo, parsed.carriedCurves);
        carriedVoltas.set(voiceNo, parsed.carriedVoltas);
        const line: ScoreLine = {
          voice: voiceNo,
          elements: parsed.elements,
          marks: parsed.marks,
          lyrics: [],
          raw,
          source: span(ctx, 0, raw.length),
        };
        if (caption !== undefined) line.caption = caption;
        if (variant === "!" || variant === "-" || variant === "+") line.variant = variant;
        if (parsed.elements.length === 0) {
          // 空的 `Q:` 行（谱尾常见的 `Q:` + `C4:(阿/们。)` 收尾写法）不成声部；
          // 让它下面的歌词回到上一行真正有音符的曲上去，见下面的 tailOverride。
          tailOverride = lastRealVoice !== null;
          continue;
        }
        group.voices.push(line);
        lastVoice = line;
        lastRealVoice = line;
        tailOverride = false;
        autoVerse = 0;
        continue;
      }

      // kind === "C"：歌词，挂到上一行曲
      if (tailOverride) {
        // 空的 `Q:` 行下面的歌词没有音符可挂。印刷原版里这段并不显示
        //（谱尾 `(阿们)` 用的是上一行曲自带的歌词），所以这里丢掉并留个提示。
        report(
          ctx,
          "lyric-without-music",
          "空的 Q: 行下面的歌词没有音符可对，已忽略",
          0,
          raw.length,
        );
        continue;
      }
      if (lastVoice === null) {
        report(ctx, "orphan-lyric", "歌词行前面没有曲行", 0, raw.length);
        continue;
      }
      const ann = stripLyricAnnotation(ctx, raw, contentAt);
      const verseFrom = numberText ? Number(numberText) : ++autoVerse;
      const verseTo = rangeEnd ? Number(rangeEnd) : verseFrom;
      const lyric: LyricLine = {
        verseFrom,
        verseTo,
        annotationGap: ann.gap,
        syllables: parseLyricBody(ctx, raw, Math.max(ann.next, contentAt)),
        source: span(ctx, 0, raw.length),
      };
      if (ann.annotation !== undefined) lyric.annotation = ann.annotation;
      // 行末的 `}`：把相邻几段歌词括在一起的联合括号
      if (/\}\s*$/.test(raw)) lyric.joinBrace = true;
      lastVoice.lyrics.push(lyric);
      continue;
    }

    const meta = META_PREFIX.exec(raw);
    if (meta && METADATA_KEYS.has(meta[1]!.toUpperCase())) {
      applyMetadata(ctx, metadata, meta[1]!, raw.slice(meta[0].length), 0);
      continue;
    }

    // 无前缀的自由文字：注记、勘误、引用之类，原样收着即可。
    // 只有「像谱却没写前缀」的行才值得报警——那多半是漏了 `Q:`。
    if (/[|]/.test(trimmed) && /[0-9]/.test(trimmed)) {
      report(ctx, "unrecognized-line", `像曲行但没有 Q: 前缀：'${trimmed.slice(0, 20)}'`, 0, raw.length);
    } else {
      metadata.remarks.push(trimmed);
    }
  }
  dropUnresolvedCurves();
  flushSong();

  return { dialect, source: text, songs, diagnostics };
}
