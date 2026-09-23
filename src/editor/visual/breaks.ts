// 可视化编辑的**换行/换页**：123（`$` / `$$`）的增删，连带拆、并歌词行。
//
// ## 为什么不能只插一个 `$`
//
// 123 的 `$` 同时**结束一行曲**（规范 §5.1）：紧跟在代码行后面的 `w:` 只挂最后那一行曲。
// 在一行曲中间插一个 `$`，原来那几条 `w:` 就只对后半截了——前半截没词、后半截的词全错位。
// 所以插入换行 = 把代码行在光标处拆成两行，**每条 `w:` 也按对位格数拆成两半**，前一半挪到前一行曲下面；
// 删除换行反过来：两行曲并成一行，两边的 `w:` 逐段接起来（前一行曲的词不够长就用 `/` 补足格数）。
//
// ABC 同一个道理，只是换行不是符号：`w:` 对的是紧挨在前的那条**代码行**，代码行末就是谱面换行
// （`EditDialect.lyricBlockByCodeLine`）。插入换行 = 拆代码行，删除 = 把下一条代码行接上来，歌词照样拆并。
//
// 对位格按解析器同一份口径数（`abcfamily/lyricslot.ts::isLyricSlot` 数音符，`parseLyricLine` 数词行），
// 不在这里另立规则。碰上 `+:` 续行这种拆不清的写法就不动手、说明原因。

import type { EditorState, Line } from "@codemirror/state";
import type { Element, ScoreDoc } from "../../model/doc";
import { isLyricSlot } from "../../abcfamily/lyricslot";
import { parseLyricLine } from "../../j123/parse";
import { ZERO_SPAN } from "../../model/helpers";
import type { SyncEntry } from "../sync";
import { type EditCtx, type EditOutcome, spaceAround } from "./ops";

const LYRIC_RE = /^\s*w\s*:/;
const CONT_RE = /^\s*\+\s*:/;
/** 字段行（`K:`、`V:`、`I:`…）与注释：不是音乐行 */
const FIELD_RE = /^\s*(?:[A-Za-z]\s*:|%)/;

const isMusic = (text: string): boolean => text.trim() !== "" && !FIELD_RE.test(text);

/** 一条 `w:` 行拆成「字段头 + 词」：`w: 日光/之下` → `w: ` 与 `日光/之下` 的起点 */
function lyricBody(line: Line): { head: string; body: string; bodyFrom: number } {
  const m = /^\s*w\s*:\s*/.exec(line.text)!;
  return { head: "w:", body: line.text.slice(m[0].length), bodyFrom: line.from + m[0].length };
}

/** 词行 body 里第 `k` 个对位格的起点（格数不足 k 时为 body 末尾）。印刷段号 `<1.>` 不占格，留在前半。 */
function slotOffset(body: string, k: number, skip: "/" | "*"): number {
  if (k <= 0) {
    const label = /^\s*(?:<[^>]*>|"[^"]*")\s*/.exec(body);
    return label ? label[0].length : 0;
  }
  const { starts } = parseLyricLine(body, 1, ZERO_SPAN, undefined, skip);
  return k < starts.length ? starts[k]! : body.length;
}

/** 词行 body 占几个对位格。 */
function slotCount(body: string, skip: "/" | "*"): number {
  return parseLyricLine(body, 1, ZERO_SPAN, undefined, skip).starts.length;
}

/** 这一行曲从哪个偏移开始：往上找最近的 `$` 或 `w:`/`+:` 行（都结束上一行曲）。 */
function blockStart(state: EditorState, pos: number, breaks: readonly SyncEntry[], byCodeLine: boolean): number {
  if (byCodeLine) return state.doc.lineAt(pos).from;
  let start = 0;
  for (const b of breaks) if (b.to <= pos) start = Math.max(start, b.to);
  for (let n = state.doc.lineAt(pos).number - 1; n >= 1; n--) {
    const line = state.doc.line(n);
    if (LYRIC_RE.test(line.text) || CONT_RE.test(line.text) || /^\s*X\s*:/.test(line.text)) {
      start = Math.max(start, line.to + 1);
      break;
    }
  }
  return start;
}

/** `[from, to)` 里的对位格数（按模型里元素的原文位置数）。 */
function slotsBetween(doc: ScoreDoc | null, from: number, to: number): number {
  // 休止占不占格按方言分（`lyricslot.ts::LyricSlotRule`）
  const rule = doc?.sourceFormat === "abc" ? "abc" : "123";
  let n = 0;
  for (const song of doc?.songs ?? []) {
    for (const part of song.parts) {
      for (const m of part.measures) {
        for (const el of m.elements as Element[]) {
          const off = el.source?.offset;
          if (off === undefined || off < from || off >= to) continue;
          if (isLyricSlot(el, rule)) n++;
        }
      }
    }
  }
  return n;
}

/** 从第 `n` 行起往下，这一行曲最后一条音乐代码行（遇到行末 `$` 或下一行不是音乐行就停）。 */
function lastMusicLine(state: EditorState, n: number, breaks: readonly SyncEntry[], byCodeLine: boolean): Line {
  let line = state.doc.line(n);
  if (byCodeLine) return line;
  for (;;) {
    const endsWithBreak = breaks.some((b) => b.from >= line.from && b.to <= line.to && line.text.slice(b.to - line.from).trim() === "");
    if (endsWithBreak || line.number >= state.doc.lines) return line;
    const next = state.doc.line(line.number + 1);
    if (!isMusic(next.text) || LYRIC_RE.test(next.text) || CONT_RE.test(next.text)) return line;
    line = next;
  }
}

/** 紧跟在第 `n` 行后面的 `w:` 行（遇到 `+:` 报错：续行拆不清）。 */
function lyricLinesAfter(state: EditorState, n: number): Line[] | string {
  const out: Line[] = [];
  for (let k = n + 1; k <= state.doc.lines; k++) {
    const line = state.doc.line(k);
    if (CONT_RE.test(line.text)) return "这行曲的歌词用了 +: 续行，暂不能自动拆分，请在源码里改";
    if (!LYRIC_RE.test(line.text)) break;
    out.push(line);
  }
  return out;
}

/** 在 `pos`（两个 token 之间）插入换行 / 换页。 */
export function insertBreak(ctx: EditCtx, pos: number, page: boolean): EditOutcome {
  const tok = page ? ctx.dialect.pageBreak : ctx.dialect.lineBreak;
  if (tok === null) return { error: page ? "这种格式没有换页符号" : "这种格式的换行不是符号" };
  const byLine = !!ctx.dialect.lyricBlockByCodeLine;
  const { state } = ctx;
  const skip = "/";
  const breaks = ctx.sync.ordered().filter((e) => e.kind === "break");
  // 换行落在小节末（后面紧跟一根小节线）：小节线留在前一行，换行记在它后面
  const bar = ctx.sync.ordered().find((e) => e.kind === "barline" && e.from >= pos);
  if (bar && state.doc.sliceString(pos, bar.from).trim() === "") pos = bar.to;
  const line = state.doc.lineAt(pos);
  if (!isMusic(line.text)) return { error: "光标不在音乐行上" };
  const left = state.doc.sliceString(line.from, pos).trimEnd();
  const right = state.doc.sliceString(pos, line.to).trimStart();
  if (left === "") return { error: "行首不用再换行" };

  const last = lastMusicLine(state, line.number, breaks, byLine);
  const lyr = ctx.dialect.lyricsFollowBreaks ? lyricLinesAfter(state, last.number) : [];
  if (typeof lyr === "string") return { error: lyr };

  // 换行就是代码行末（ABC）时不写符号
  const head = tok ? `${left} ${tok}` : left;
  // 没有歌词：就地拆行
  if (lyr.length === 0) {
    const insert = right ? `${head}\n${right}` : head;
    return { changes: [{ from: line.from, to: line.to, insert }], anchor: line.from + head.length, head: line.from + head.length };
  }

  // 有歌词：每条 `w:` 在第 k 格处拆开，前一半挪到前一行曲下面
  const k = slotsBetween(ctx.doc, blockStart(state, pos, breaks, byLine), pos);
  const firstHalf: string[] = [];
  const secondHalf: string[] = [];
  for (const w of lyr) {
    const { head: h, body } = lyricBody(w);
    const off = slotOffset(body, k, skip);
    firstHalf.push(`${h} ${body.slice(0, off).trimEnd()}`.trimEnd());
    secondHalf.push(`${h} ${body.slice(off).trimStart()}`.trimEnd());
  }
  // 整段都没词的一半不写（段号是数出来的，只有夹在中间的空段才要占位）
  const trimEmpty = (ls: string[]): string[] => {
    const out = [...ls];
    while (out.length && /^w:\s*$/.test(out[out.length - 1]!)) out.pop();
    return out;
  };
  const a = trimEmpty(firstHalf);
  const b = trimEmpty(secondHalf);
  // 光标行之后到最后一条音乐行之间的代码行原样保留
  const middle = line.number < last.number ? state.doc.sliceString(state.doc.line(line.number + 1).from, last.to) : "";
  const parts = [head, ...a];
  const rest = [right, middle].filter((s) => s !== "");
  const tail = [...rest, ...b];
  const insert = [...parts, ...tail].join("\n");
  const end = lyr[lyr.length - 1]!.to;
  const caret = line.from + head.length;
  return { changes: [{ from: line.from, to: end, insert }], anchor: caret, head: caret };
}

/** 删掉一处换行/换页符号（`entry.kind === "break"`，有原文位置）。 */
export function deleteBreak(ctx: EditCtx, entry: SyncEntry): EditOutcome {
  const { state } = ctx;
  // 歌词不跟换行走的格式（`.jpwabc`）：只删符号
  if (!ctx.dialect.lyricsFollowBreaks) {
    const c = spaceAround(ctx, entry.from, entry.to);
    return { changes: [c], anchor: c.from, head: c.from };
  }
  const skip = "/";
  const byLine = !!ctx.dialect.lyricBlockByCodeLine;
  const breaks = ctx.sync.ordered().filter((e) => e.kind === "break");
  // ABC：`entry` 是代码行末的换行符本身
  const line = state.doc.lineAt(entry.from);
  const before = state.doc.sliceString(line.from, entry.from).trimEnd();
  const after = entry.to <= line.to ? state.doc.sliceString(entry.to, line.to).trim() : "";
  // 前一行曲的格数（`$` 之前）
  const kA = slotsBetween(ctx.doc, blockStart(state, entry.from, breaks, byLine), entry.from);
  const pad = (n: number): string => Array.from({ length: n }, () => skip).join(" ");

  if (after !== "") {
    // 行中间的 `$`：前半截不可能有词（`w:` 只跟在代码行后面），并过去后后半截的词要让出前半截的格
    const last = lastMusicLine(state, line.number, breaks.filter((b) => b.from !== entry.from), byLine);
    const lyr = lyricLinesAfter(state, last.number);
    if (typeof lyr === "string") return { error: lyr };
    const changes = [{ from: line.from, to: line.to, insert: `${before} ${after}` }];
    if (kA > 0) {
      for (const w of lyr) {
        const { body, bodyFrom } = lyricBody(w);
        const at = bodyFrom + slotOffset(body, 0, skip);
        changes.push({ from: at, to: at, insert: `${pad(kA)} ` });
      }
    }
    const caret = line.from + before.length;
    return { changes, anchor: caret, head: caret };
  }

  // 行末的 `$`：下面先是前一行曲的词，再是后一行曲的代码行与词
  const lyrA = lyricLinesAfter(state, line.number);
  if (typeof lyrA === "string") return { error: lyrA };
  const nextN = (lyrA.length ? lyrA[lyrA.length - 1]! : line).number + 1;
  if (nextN > state.doc.lines || !isMusic(state.doc.line(nextN).text)) {
    // 后面没有音乐了：直接删符号
    return { changes: [{ from: line.from, to: line.to, insert: before }], anchor: line.from + before.length, head: line.from + before.length };
  }
  const lastB = lastMusicLine(state, nextN, breaks, byLine);
  const lyrB = lyricLinesAfter(state, lastB.number);
  if (typeof lyrB === "string") return { error: lyrB };
  const merged: string[] = [];
  for (let i = 0; i < Math.max(lyrA.length, lyrB.length); i++) {
    const a = lyrA[i] ? lyricBody(lyrA[i]!).body.trim() : "";
    const b = lyrB[i] ? lyricBody(lyrB[i]!).body.trim() : "";
    const lack = Math.max(0, kA - slotCount(a, skip));
    merged.push(`w: ${[a, b ? pad(lack) : "", b].filter((s) => s !== "").join(" ")}`.trimEnd());
  }
  const codeB = state.doc.sliceString(state.doc.line(nextN).from, lastB.to);
  // ABC 的换行就是代码行末：两条代码行接成一条；123 去掉 `$` 就够了，代码行照旧分着
  const code = byLine ? [`${before} ${codeB.trim()}`] : [before, codeB];
  const insert = [...code, ...merged].join("\n");
  const end = (lyrB.length ? lyrB[lyrB.length - 1]! : lastB).to;
  const caret = line.from + before.length;
  return { changes: [{ from: line.from, to: end, insert }], anchor: caret, head: caret };
}
