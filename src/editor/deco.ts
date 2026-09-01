// CodeMirror 装饰的公共件。
//
// `.jpwabc`（editor/highlight.ts）与文本谱（pu/highlight.ts）两套高亮各自扫描各自的文法，
// 但**上色的 CSS 类是同一套**（note/barline/metakey/metaval/lrc/lrcspec/comment/text/
// slash/unknown），造 Decoration 的这一步也就完全一样。

import { Decoration } from "@codemirror/view";

const markCache = new Map<string, Decoration>();

/** 按 CSS 类取一个 mark 装饰（同类复用同一个对象，RangeSet 才能高效比较）。 */
export function mark(cls: string): Decoration {
  let m = markCache.get(cls);
  if (!m) {
    m = Decoration.mark({ class: cls });
    markCache.set(cls, m);
  }
  return m;
}
