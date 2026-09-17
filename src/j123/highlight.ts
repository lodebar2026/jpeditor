// 123 格式的 CodeMirror 语法高亮。
//
// 与 `.jpwabc` / 文本谱的高亮**同一套 CSS 类**（note/barline/metakey/metaval/lrc/
// lrcspec/comment/text/slash/section/break/unknown），三种格式在同一个编辑器里观感一致。
//
// 这里是**独立的轻量扫描，不复用 `lex.ts`/`parse.ts`**（与 `pu/highlight.ts` 同一条判据）：
// 高亮要能在半截、写错的文本上照样上色，而解析器该报诊断就得报，两者目标不同。
// 行首前缀按**宽松形式**认——只要看着像字段行就当字段行上色，是不是合法字段名归解析器管。

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { mark } from "../editor/deco";

/** 字段行前缀的宽松形。与 `fields.ts::ASCII_PREFIX` / `CJK_PREFIX` 同形，但不查别名表。 */
const FIELD_PREFIX = /^\s*([A-Za-z]|[一-鿿]{1,4})(\d+)?(?:-(\d+))?(?:@(\d+),(\d+))?\s*[:：]/;

/** 小节线族，**从长到短**（否则 `||` 永远匹配不到）。与 `lex.ts::BARLINES` 同序。 */
const BARLINE_RE = /^(\[\|\]|\|::|::\||:\|:|::|\|:|:\||\|\]|\[\||\|\||\.\||\|)/;
/** 房号：`[1` `[1,3` `[1-3` `|1` `:|2` */
const ENDING_RE = /^(?:\[|\|)\d+(?:[,-]\d+)*/;
/** 多连音：`(3:` `(3:2:3`（**冒号必需**，见规范「`(` 的歧义」） */
const TUPLET_RE = /^\(\d+:(?:\d+:)?(?:\d+)?/;
/** 音符及其修饰：`#4` `b7'` `5_.` `1,,` */
const NOTE_RE = /^(?:##|bb|[#bn])?[0-7](?:['’,]|_|\.)*/;

interface Span {
  from: number;
  to: number;
  cls: string;
}

/** 到配对符为止（含），没配到就吃到行尾——半截文本也要上色。 */
function until(src: string, i: number, close: string): number {
  const end = src.indexOf(close, i + 1);
  return end < 0 ? src.length : end + close.length;
}

/** 音乐体：逐 token 分类。 */
function scanMusic(src: string, from: number, out: Span[]): void {
  let i = from;
  const push = (to: number, cls: string): void => {
    if (to > i) out.push({ from: i, to, cls });
    i = to;
  };
  while (i < src.length) {
    const ch = src[i]!;
    const rest = src.slice(i);
    if (/\s/.test(ch) || ch === "`") {
      i += 1; // 空白与反引号只为可读性——都不上色
      continue;
    }
    // 和弦 `"Am7"` 与文字标注 `"^rit."`
    if (ch === '"') {
      push(until(src, i, '"'), "text");
      continue;
    }
    // 不带引号的和弦 `Am7 1`：大写 A–G 开头、到空白为止（同 `dialect123.ts::scanBareChord`）
    if (/[A-G]/.test(ch)) {
      const m = /^\S+/.exec(rest)!;
      push(i + m[0].length, "text");
      continue;
    }
    // 装饰与记号 `!fermata!` `!D.S.!`
    if (ch === "!") {
      push(until(src, i, "!"), "lrcspec");
      continue;
    }
    // 行内字段 `[K:G]` `[M:3/4]`——要排在房号与小节线前面
    if (rest.startsWith("[") && /^\[[A-Za-z]\s*:/.test(rest)) {
      push(until(src, i, "]"), "metakey");
      continue;
    }
    // 倚音 `{6,}`
    if (ch === "{") {
      push(until(src, i, "}"), "break");
      continue;
    }
    // 房号在小节线之前判：`[1` 与 `[|` 只差一个字符
    const ending = ENDING_RE.exec(rest);
    if (ending) {
      push(i + ending[0].length, "barline");
      continue;
    }
    const bar = BARLINE_RE.exec(rest);
    if (bar) {
      push(i + bar[0].length, "barline");
      continue;
    }
    // 多连音在圆滑线之前判（都以 `(` 开头）
    const tuplet = TUPLET_RE.exec(rest);
    if (tuplet) {
      push(i + tuplet[0].length, "break");
      continue;
    }
    if (ch === "(" || ch === ")") {
      push(i + 1, "break");
      continue;
    }
    const note = NOTE_RE.exec(rest);
    if (note) {
      push(i + note[0].length, "note");
      continue;
    }
    // 占位与节奏音符：`y` 无时值、`x` 不可见休止、`X` 有声无音高
    if (ch === "y" || ch === "x" || ch === "X") {
      const m = /^[yxX](?:_|\.)*/.exec(rest)!;
      push(i + m[0].length, "note");
      continue;
    }
    // 增时线
    if (ch === "-") {
      push(i + 1, "note");
      continue;
    }
    // 换行 `$` / 换页 `$$`
    if (ch === "$") {
      push(i + (rest.startsWith("$$") ? 2 : 1), "section");
      continue;
    }
    push(i + 1, "unknown");
  }
}

/** 歌词行：对齐符号与印刷段号单独上色，其余是歌词。 */
function scanLyric(src: string, from: number, out: Span[]): void {
  let i = from;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "<") {
      // 印刷段号 `<1.>`
      const to = until(src, i, ">");
      out.push({ from: i, to, cls: "lrcspec" });
      i = to;
      continue;
    }
    if (ch === "{") {
      // 多字并一格 `{1.圣}`
      const to = until(src, i, "}");
      out.push({ from: i, to, cls: "lrc" });
      i = to;
      continue;
    }
    // `_` 续记号、`*` 跳音符、`|` 推进小节、`-` 拉丁断音节
    if (ch === "_" || ch === "*" || ch === "|" || ch === "-" || ch === "~") {
      out.push({ from: i, to: i + 1, cls: "slash" });
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < src.length && !"<{_*|-~".includes(src[end]!) && !/\s/.test(src[end]!)) end += 1;
    out.push({ from: i, to: end, cls: "lrc" });
    i = end;
  }
}

function scanLine(line: string, base: number, out: Span[]): void {
  if (line.trim().length === 0) return;
  // `%%directive` 等价 `I:`，`%` 是注释，`%abc`/`%123` 版本声明也落这儿
  if (line.trimStart().startsWith("%")) {
    out.push({ from: base, to: base + line.length, cls: "comment" });
    return;
  }
  const f = FIELD_PREFIX.exec(line);
  if (f) {
    const at = f[0].length;
    out.push({ from: base, to: base + at, cls: "metakey" });
    const spans: Span[] = [];
    const name = f[1]!;
    if (name === "w" || name === "歌词" || name === "段") scanLyric(line, at, spans);
    else if (name === "W" || name === "文字" || name === "N" || name === "注") {
      spans.push({ from: at, to: line.length, cls: "text" });
    } else spans.push({ from: at, to: line.length, cls: "metaval" });
    for (const s of spans) out.push({ from: base + s.from, to: base + s.to, cls: s.cls });
    return;
  }
  const spans: Span[] = [];
  scanMusic(line, 0, spans);
  for (const s of spans) out.push({ from: base + s.from, to: base + s.to, cls: s.cls });
}

function buildDeco(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const out: Span[] = [];
  let base = 0;
  for (const line of text.split("\n")) {
    scanLine(line, base, out);
    base += line.length + 1;
  }
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  let last = 0;
  for (const s of out) {
    if (s.from < last || s.to <= s.from) continue; // RangeSetBuilder 要求有序不重叠
    builder.add(s.from, s.to, mark(s.cls));
    last = s.to;
  }
  return builder.finish();
}

export const j123Highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDeco(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged) this.decorations = buildDeco(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
