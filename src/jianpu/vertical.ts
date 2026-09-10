// 纵向排版：谱行块 → 页。`.jpwabc` 与文本谱共用这一份（从前两边各写一套，
// 文本谱那套在「整组挪下页」时先把光标重置到页顶、再减位移，下一组被排到页顶之上）。
//
// 分页器**不认识**谱行里有什么，只认每块的**占位盒**（相对块原点的 `top`/`bottom`）：
// - `.jpwabc`：谱行 Group 的包围盒，块间留 `gap`（`staffDist`），整页再按 `spread` 摊开；
// - 文本谱：光标推进的那一段（头顶让位 + 声部 + 歌词 + 组间距都已算在块里），`gap` = 0。
// 各引擎的间距口径因此原样保留——文本谱长图是对照原书 PDF 逐音符对过的，不能漂。

/** 一个谱行块。坐标相对块原点：块排到页上后，原点落在返回的 `y`。 */
export interface SystemBlock {
  /** 占位盒上缘（相对块原点，可为负：头顶的弧线、房号） */
  top: number;
  /** 占位盒下缘 */
  bottom: number;
  /** 本块必须另起一页（展开档逐遍换页、源里的 `[fenye]`、`.Layout` 的强制分页） */
  breakBefore?: boolean;
}

export interface PaginateSpec {
  /** 第 page 页第一块占位盒上缘的 y。首页常要让过标题块。 */
  pageTop: (page: number) => number;
  /** 占位盒下缘不得超过的 y。`Infinity` = 不按高度分页（长图）。 */
  bottom: number;
  /** 相邻两块占位盒之间至少留多少 */
  gap: number;
  /**
   * 放不满的页把行距摊开（`.jpwabc` 那一路）：行距摊到 `maxGap` 为止，
   * 剩下的空白在 `center(page)` 为真时整块居中，否则堆在页底。
   * 不给 = 各块按 `gap` 紧挨着排（文本谱）。
   */
  spread?: { maxGap: number; center: (page: number) => boolean };
}

export interface PlacedBlock<B extends SystemBlock> {
  block: B;
  /** 块原点落在页上的 y */
  y: number;
}

/** 把块码进页里。每页至少一块——单块比整页还高时照样独占一页，由调用方决定怎么报。 */
export function paginate<B extends SystemBlock>(blocks: readonly B[], spec: PaginateSpec): PlacedBlock<B>[][] {
  const pages: PlacedBlock<B>[][] = [];
  let cur: PlacedBlock<B>[] | null = null;
  let lastBottom = 0; // 本页最后一块占位盒下缘的绝对 y
  for (const block of blocks) {
    const h = block.bottom - block.top;
    let fresh = cur === null || block.breakBefore === true;
    if (!fresh && lastBottom + spec.gap + h > spec.bottom) fresh = true;
    if (fresh) {
      cur = [];
      pages.push(cur);
      const y = spec.pageTop(pages.length - 1) - block.top;
      cur.push({ block, y });
      lastBottom = y + block.bottom;
    } else {
      const y = lastBottom + spec.gap - block.top;
      cur!.push({ block, y });
      lastBottom = y + block.bottom;
    }
  }
  if (spec.spread && Number.isFinite(spec.bottom)) {
    const { maxGap, center } = spec.spread;
    pages.forEach((pg, i) => {
      if (pg.length < 2) return;
      const top = spec.pageTop(i);
      const total = pg.reduce((s, p) => s + (p.block.bottom - p.block.top), 0);
      let dd = (spec.bottom - top - total) / (pg.length - 1);
      let y = top;
      if (dd > maxGap) {
        if (center(i)) y += ((dd - maxGap) * (pg.length - 1)) / 2;
        dd = maxGap;
      }
      for (const p of pg) {
        p.y = y - p.block.top;
        y += p.block.bottom - p.block.top + dd;
      }
    });
  }
  return pages;
}
