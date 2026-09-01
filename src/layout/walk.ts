// 页面树遍历的公共骨架。
//
// 页面树（PageItem / Group / GraphicPath / GraphicLine / TextFrame）有**四个**消费者，
// 各自要把同一棵树变成不同的东西：
//
//   layout/painter.ts   → SVG DOM（matrix 加在包裹 <g> 上，颜色取 item）
//   mixed/painter.ts    → SVG DOM（matrix 加在**叶子**上，颜色一律 black）
//   pdflayout/browser.ts→ DrawList（矩阵累积成 Mat6，坐标烘进数据里）
//   editor/pptx.ts      → OOXML 形状（用 item.pos(null) 而不是矩阵累积）
//
// 四者的**分派**（三种叶子 + 递归）是同一件事，**坐标语义**却各不相同。所以这里只抽
// 「怎么走」，把「子级坐标系怎么从父级推出来」交给 visitor 的 `descend`——
// mixed 那条与另外三条不同（见 mixed/painter.ts 的注释），骨架不该替它们决定。
//
// 泛型 `M` 就是各家的坐标载体：SVG 那两路是父级 <g>、browser 是 Mat6、pptx 是 void。

import { GraphicLine, GraphicPath, PageItem, TextFrame } from "./layout";

export interface ItemVisitor<M> {
  /**
   * 进入 `item` 之后，它的**自身绘制与子级**该用哪个坐标载体。
   * 返回值同时传给 `path`/`line`/`text` 与子级的 `descend`。
   */
  descend(item: PageItem, parent: M): M;
  path?(item: GraphicPath, m: M): void;
  line?(item: GraphicLine, m: M): void;
  text?(item: TextFrame, m: M): void;
  /** 非叶子（Group / 裸 PageItem）也要记一笔的（nodeMap、容器 append）在这里做。 */
  other?(item: PageItem, m: M): void;
  /**
   * 要不要往 `item` 的子级走。默认全都走。
   *
   * **四个消费者在这里并不一致**：layout/painter 与 pdflayout/browser 无条件递归，
   * mixed/painter 与 editor/pptx 则在叶子上 `return`、只递归 Group。今天的页面树里
   * 叶子本来就没有子级，两种写法结果相同——但那是**巧合不是约定**，骨架不替它们决定。
   */
  descendChildren?(item: PageItem, m: M): boolean;
}

/**
 * 前序遍历：先 `descend`，再按类型分派自身，最后递归子级。
 *
 * **分派顺序照抄各消费者原来的写法**——`SmuflText`/`JpNumber`/`Lyric` 都是 `TextFrame`
 * 的派生，`instanceof` 的先后决定谁接住它们，visitor 内部自己再细分。
 */
export function walkPageItem<M>(item: PageItem, parent: M, v: ItemVisitor<M>): void {
  const m = v.descend(item, parent);
  if (item instanceof GraphicPath) v.path?.(item, m);
  else if (item instanceof GraphicLine) v.line?.(item, m);
  else if (item instanceof TextFrame) v.text?.(item, m);
  else v.other?.(item, m);
  if (v.descendChildren && !v.descendChildren(item, m)) return;
  for (const ch of item.children) walkPageItem(ch, m, v);
}
