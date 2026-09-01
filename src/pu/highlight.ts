// 文本谱的 CodeMirror 语法高亮。
//
// 与 .jpwabc 的高亮同一套 CSS 类（note/barline/metakey/metaval/lrc/lrcspec/comment/
// text/slash/unknown），这样两种格式在同一个编辑器里观感一致。
//
// 这里是**独立的轻量扫描**，不复用 parse.ts：高亮要能在半截、写错的文本上照样上色，
// 而语义解析器该报错就得报错，两者目标不同。行首前缀一律按方言无关的宽松形式认。

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { mark } from "../editor/deco";


/** 行首前缀：`Q1"女高":` / `C1-2:` / `W:` */
const BODY_PREFIX = /^\s*([QCW])([!+-]?)(\d*)(?:-\d+)?(?:"[^"]*"|<[^>]*>)?\s*[:：]/;
/** 头部字段：`T:` `1=C4/4` `FontSize:` … */
const META_PREFIX = /^\s*([A-Za-z]+)\s*[:：]/;
const KEY_LINE = /^\s*[1-7]\s*=/;

interface Span {
  from: number;
  to: number;
  cls: string;
}

/** 曲行：逐字符分类。 */
function scanMusic(src: string, from: number, out: Span[]): void {
  let i = from;
  const push = (to: number, cls: string): void => {
    if (to > i) out.push({ from: i, to, cls });
    i = to;
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    // 双引号：注释 / 和弦 / 临时拍号 / 倚音
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      push(end < 0 ? src.length : end + 1, "text");
      continue;
    }
    // `&xx` 记号
    if (ch === "&") {
      const m = /^&\+*[A-Za-z]*\+*/.exec(src.slice(i));
      push(i + (m ? m[0].length : 1), "lrcspec");
      continue;
    }
    // 小节线与反复
    if (ch === "|" || ch === ":") {
      const m = /^[|:*/]+/.exec(src.slice(i));
      push(i + (m ? m[0].length : 1), "barline");
      continue;
    }
    // 音符数字与紧跟的修饰
    if (/[0-9X]/.test(ch)) {
      const m = /^[0-9X][',gd.\/#$=b♭♮♯]*/.exec(src.slice(i));
      push(i + (m ? m[0].length : 1), "note");
      continue;
    }
    // 增时线 / 跟词标记
    if (ch === "-" || ch === "@") {
      push(i + 1, "note");
      continue;
    }
    // 弧线、跳房子、内联层、渐强渐弱、连断拍
    if ("()[]{}<>!~^+".includes(ch)) {
      push(i + 1, "break");
      continue;
    }
    // 落单的修饰符（`5&rit/` 里的 `/`）
    if ("./',gd#$=b".includes(ch)) {
      push(i + 1, "note");
      continue;
    }
    push(i + 1, "unknown");
  }
}

/** 词行：说明文字与跳过记号单独上色，其余是歌词。 */
function scanLyric(src: string, from: number, out: Span[]): void {
  let i = from;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "<") {
      const end = src.indexOf(">", i + 1);
      const to = end < 0 ? src.length : end + 1;
      out.push({ from: i, to, cls: "lrcspec" });
      i = to;
      continue;
    }
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      const to = end < 0 ? src.length : end + 1;
      out.push({ from: i, to, cls: "lrcspec" });
      i = to;
      continue;
    }
    if (ch === "@" || ch === "/") {
      out.push({ from: i, to: i + 1, cls: "slash" });
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < src.length && !"<\"@/".includes(src[end]!) && !/\s/.test(src[end]!)) end += 1;
    out.push({ from: i, to: end, cls: "lrc" });
    i = end;
  }
}

function scanLine(line: string, base: number, out: Span[]): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  if (trimmed.startsWith("#")) {
    out.push({ from: base, to: base + line.length, cls: "comment" });
    return;
  }
  if (/^-{5,}\s*$/.test(trimmed) || /^\[fenye\]$/i.test(trimmed)) {
    out.push({ from: base, to: base + line.length, cls: "section" });
    return;
  }
  if (KEY_LINE.test(line)) {
    const eq = line.indexOf("=") + 1;
    out.push({ from: base, to: base + eq, cls: "metakey" });
    out.push({ from: base + eq, to: base + line.length, cls: "metaval" });
    return;
  }
  const body = BODY_PREFIX.exec(line);
  if (body) {
    const at = body[0].length;
    out.push({ from: base, to: base + at, cls: "lrcspec" });
    const spans: Span[] = [];
    if (body[1] === "C") scanLyric(line, at, spans);
    else if (body[1] === "W") spans.push({ from: at, to: line.length, cls: "text" });
    else scanMusic(line, at, spans);
    for (const s of spans) out.push({ from: base + s.from, to: base + s.to, cls: s.cls });
    return;
  }
  const meta = META_PREFIX.exec(line);
  if (meta) {
    const at = meta[0].length;
    out.push({ from: base, to: base + at, cls: "metakey" });
    out.push({ from: base + at, to: base + line.length, cls: "metaval" });
    return;
  }
  // 无前缀的自由文字（注记、勘误）
  out.push({ from: base, to: base + line.length, cls: "comment" });
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
    if (s.from < last || s.to <= s.from) continue; // 重叠的丢掉，RangeSetBuilder 要求有序不重叠
    builder.add(s.from, s.to, mark(s.cls));
    last = s.to;
  }
  return builder.finish();
}

export const puHighlighter = ViewPlugin.fromClass(
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
