// CodeMirror 6 highlighter for .jpwabc, driven by TokenData.parse (the same
// tokenizer the original used to colorize StyleClassedTextArea). Tokens are
// contiguous over the document, so offsets accumulate from token text lengths.

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { TokenData, tokenClass } from "../jpword/tokens";

const markCache = new Map<string, Decoration>();
function mark(cls: string): Decoration {
  let m = markCache.get(cls);
  if (!m) {
    m = Decoration.mark({ class: cls });
    markCache.set(cls, m);
  }
  return m;
}

function buildDeco(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const len = text.length;
  const builder = new RangeSetBuilder<Decoration>();
  let data: TokenData;
  try {
    data = TokenData.parse(text);
  } catch {
    return builder.finish();
  }
  let pos = 0;
  for (const t of data.tokens) {
    const start = pos;
    let end = pos + t.text.length;
    pos = end;
    const cls = tokenClass[t.type];
    if (!cls || cls === "space") continue;
    if (start >= len) break;
    if (end > len) end = len;
    if (end <= start) continue;
    builder.add(start, end, mark(cls));
  }
  return builder.finish();
}

export const jpwHighlighter = ViewPlugin.fromClass(
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
