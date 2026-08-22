// 三个排版器（JinpuPainter / PuPainter / MixedPainter）的共同契约。
//
// 以前这个契约只写在 mixed/painter.ts 的一行注释里（"接口对齐 JinpuPainter"），编译器管不着，
// 三者的签名已经漂移：pageWidth/pageHeight vs pageWidthPt/pageHeightPt。有了这个接口，
// 编辑器的「铺页」逻辑（App._renderPagesWith）只依赖它，不必认识具体是哪一种排版器。
//
// **高亮不进这个接口**：三者的高亮语义确实不同（JinpuPainter 按 Chord + 演唱遍数、
// PuPainter 按音符 + verse、MixedPainter 没有），硬凑成一个方法只会让调用方去猜。
// 需要高亮的地方按具体类型处理。
export interface PagePainter {
  /** 排好版之后的页数。 */
  readonly pageCount: number;

  /** 第 index 页的标称尺寸，**只用来定容器的宽高比**。
   *  单位随实现而异（JinpuPainter/PuPainter 是排版坐标，MixedPainter 是 MusicXML tenths），
   *  正因如此只能用于比例，不能跨排版器比较绝对值。 */
  pageSize(index: number): { w: number; h: number };

  /** 渲染第 index 页为一个独立的 <svg>。 */
  renderPage(index: number): SVGSVGElement;
}
