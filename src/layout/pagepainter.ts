// 排版器（`layout/painter.ts::ScorePainter` 与退役中的 `pu/painter.ts::PuPainter`）的共同铺页契约。
//
// 以前这个契约只写在混排排版器的一行注释里，编译器管不着，
// 三者的签名已经漂移：pageWidth/pageHeight vs pageWidthPt/pageHeightPt。有了这个接口，
// 编辑器的「铺页」逻辑（App._renderPagesWith）只依赖它，不必认识具体是哪一种排版器。
//
// **高亮不进这个接口**：两者的高亮语义不同（ScorePainter 按 Chord + 演唱遍数、
// PuPainter 按音符 + verse），硬凑成一个方法只会让调用方去猜。
// 需要高亮的地方按具体类型处理。
export interface PagePainter {
  /** 排好版之后的页数。 */
  readonly pageCount: number;

  /** 第 index 页的标称尺寸，**只用来定容器的宽高比**。
   *  单位随实现而异（ScorePainter 是 pt，PuPainter 是它的排版坐标），
   *  正因如此只能用于比例，不能跨排版器比较绝对值。 */
  pageSize(index: number): { w: number; h: number };

  /** 渲染第 index 页为一个独立的 <svg>。 */
  renderPage(index: number): SVGSVGElement;
}
