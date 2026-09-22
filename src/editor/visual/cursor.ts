// 可视化编辑在**代码区**的那一半：两种光标与换行符的装饰。
//
// 光标状态只有一份——代码区的选区（非空 = 编辑模式，空 = 插入模式，见 `keys.ts::VisualMode`）。
// 代码区自己有焦点时，CodeMirror 原生的选区与光标就是这两种样子，不用另画；
// **焦点在谱面上时**原生光标不画了，这里补画：编辑模式一个方块罩住选区，插入模式一条竖线。
// 谱面那一半在 `overlay.ts`，两边读的是同一份选区。

import { type EditorState, type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

/** 谱面有没有焦点（有才补画光标）。 */
export const setScoreFocus = StateEffect.define<boolean>();
/** 拍数对不上的小节，首个 token 的位置（小节时值自检，`model/beatcheck.ts`）。 */
export const setBeatSpans = StateEffect.define<readonly { from: number; to: number }[]>();
/** 原文里换行/换页符号的位置（`SyncIndex.breaks()` 里有 span 的那些）。 */
export const setBreakSpans = StateEffect.define<readonly { from: number; to: number }[]>();

interface VisualCmState {
  scoreFocus: boolean;
  breaks: readonly { from: number; to: number }[];
  beats: readonly { from: number; to: number }[];
}

const stateField = StateField.define<VisualCmState>({
  create: () => ({ scoreFocus: false, breaks: [], beats: [] }),
  update(v, tr) {
    let next = v;
    for (const e of tr.effects) {
      if (e.is(setScoreFocus)) next = { ...next, scoreFocus: e.value };
      else if (e.is(setBreakSpans)) next = { ...next, breaks: e.value };
      else if (e.is(setBeatSpans)) next = { ...next, beats: e.value };
    }
    // 文档改了，旧的符号位置跟着映射（重排后会整份换新）
    if (tr.docChanged && (next.breaks.length || next.beats.length)) {
      const map = (list: readonly { from: number; to: number }[]) => list
        .map((b) => ({ from: tr.changes.mapPos(b.from, 1), to: tr.changes.mapPos(b.to, -1) }))
        .filter((b) => b.to > b.from);
      next = { ...next, breaks: map(next.breaks), beats: map(next.beats) };
    }
    return next;
  },
});

class CaretWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-vis-caret";
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const blockMark = Decoration.mark({ class: "cm-vis-block" });
const breakMark = Decoration.mark({ class: "cm-vis-break" });
const beatMark = Decoration.mark({ class: "cm-vis-beat", attributes: { title: "这一小节的拍数与拍号对不上" } });
const caret = Decoration.widget({ widget: new CaretWidget(), side: 1 });

function decorations(state: EditorState): DecorationSet {
  const v = state.field(stateField);
  const sel = state.selection.main;
  const items: { from: number; to: number; deco: Decoration }[] = [];
  for (const b of v.breaks) items.push({ from: b.from, to: b.to, deco: breakMark });
  for (const b of v.beats) items.push({ from: b.from, to: b.to, deco: beatMark });
  if (v.scoreFocus) {
    if (sel.empty) items.push({ from: sel.head, to: sel.head, deco: caret });
    else items.push({ from: sel.from, to: sel.to, deco: blockMark });
  }
  // RangeSetBuilder 要求按起点升序；同起点时 widget（零长）在前
  items.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const it of items) builder.add(it.from, it.to, it.deco);
  return builder.finish();
}

const decoField = StateField.define<DecorationSet>({
  create: (state) => decorations(state),
  update: (_d, tr) => decorations(tr.state),
  provide: (f) => EditorView.decorations.from(f),
});

/** 装进代码区的扩展。 */
export const visualCursorExtension: Extension = [stateField, decoField];

/** 谱面此刻有没有焦点（读代码区里记着的那份）。 */
export function scoreHasFocus(state: EditorState): boolean {
  return state.field(stateField, false)?.scoreFocus ?? false;
}
