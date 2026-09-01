// 谱行**上方那一带**的纵向堆叠：弧 / 三连音括线 / fermata / 和弦 / 段落词 / 转调标记 / 房号
// 共用一把尺子，一次算清各自该抬多少。
//
// 从前这件事散在四五处各自为政的避让函数里（`liftChordsUnderSlurs` /
// `liftKeySigOverChords` / `addEnding` 各扫各的），彼此不知情：三连音括线压根不在任何一处
// 里，房号的高度还按**基线**算。记号一多就撞（158 首的弧压三连音、房号数字压和弦；
// 456 首的和弦穿过三连音括线）。这里把它们统一成「带序 + 扫描线」两条规则。
//
// **只管 y**。段落词那套「优先横向找空档」的让位（`Line.placeSectionWord`）是既定口径，
// 仍在它自己那儿做，做完了才把结果送进来。
//
// 纯几何，不依赖 Score / DOM，好单测。

/** 一个待堆叠的对象。`top`/`bottom` 一律是**墨迹**上下缘（y 向下为正），绝不能传基线。 */
export interface BandItem {
  /** 调用方用来回填 dy 的钥匙（通常就是那个 Group / TextFrame）。 */
  key: object;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** 带序，自下而上：0 弧/三连音/fermata/奏法记号，1 和弦/段落词/表情记号，2 转调标记，3 房号。 */
  layer: number;
  /** 同层内的排序键（一般是 x 跨度）：**小的排在下面**，大的往上让。 */
  rank?: number;
  /** 种类。**同一种类之间不互避**：弧与弧交错本来就是嵌套着画的（长弧罩住短弧，
   *  原书就这样），互避会把整本撑高十几页；要分层的是弧与三连音括线这种**异类**。 */
  kind?: string;
  /** 非空时，被同一个下层对象压住的这一类要**整排取齐**（和弦就是这样，一高一低比压着还难看）。 */
  spread?: string;
  /**
   * **这一段 x 区间内**本对象的墨迹顶（相对未抬升时）。弧要给一个：它的包围盒顶是
   * **中段**那个最高点，而压着它的记号多半落在两头（那儿的弧几乎贴着音符），
   * 照包围盒让位会把 fermata 抬到半空中（302《一切全奉献》实测高出 15pt）。
   * 省略 = 就用 `top`。
   */
  topAt?: (x0: number, x1: number) => number;
  /** 让位时这个对象与下方对象之间的净距按 `gap × 这个系数`。fermata 这类点状标记要**贴着弧**
   *  （用户口径「两者要靠近，节省空间」），整格 `jpStackGap` 会把它顶得老高。省略 = 1。 */
  gapScale?: number;
  /** 对这些 `kind` **不让位**。点状记号（fermata / 重音）贴着音符走，
   *  罩住几个音符的三连音括线该让开它们——让位的方向反过来，靠这个开口子。 */
  skipKinds?: readonly string[];
}

interface Box {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

function xHit(a: Box, b: Box): boolean {
  return a.x1 > b.x0 && a.x0 < b.x1;
}

/**
 * 算出每个对象该抬多少（返回的 dy ≤ 0，页面坐标里负数是往上）。
 *
 * 规则两条：
 *   - **层内**按 `rank` 升序定位，先定的留在下面；后定的撞上就抬到它墨迹顶之上一个 `gap`。
 *   - **跨层**只往上让：上层撞下层，抬的永远是上层（原书的排法就是和弦在弧之上）。
 */
export function stackUpperBand(items: readonly BandItem[], gap: number): Map<object, number> {
  const dy = new Map<object, number>();
  for (const it of items) dy.set(it.key, 0);
  const boxOf = (it: BandItem): Box => {
    const d = dy.get(it.key) ?? 0;
    return { x0: it.x0, x1: it.x1, top: it.top + d, bottom: it.bottom + d };
  };
  const placed: BandItem[] = [];
  const layers = [...new Set(items.map((i) => i.layer))].sort((a, b) => a - b);
  for (const layer of layers) {
    const cur = items
      .filter((i) => i.layer === layer)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const done: BandItem[] = [];
    for (const it of cur) {
      // 抬起来之后可能撞上更高的那个，所以要迭代到稳定
      for (let iter = 0; iter < 8; iter++) {
        const me = boxOf(it);
        let d = dy.get(it.key) ?? 0;
        for (const p of [...placed, ...done]) {
          if (p.layer === it.layer && p.kind === it.kind) continue; // 同类不互避（见 BandItem.kind）
          if (it.skipKinds && p.kind && it.skipKinds.includes(p.kind)) continue;
          const pb = boxOf(p);
          if (!xHit(me, pb)) continue;
          // 让位按**这一段 x 里**对方的墨迹顶算（弧给了 `topAt`，见那儿的注释）
          const pTop = p.topAt ? p.topAt(me.x0, me.x1) + ((dy.get(p.key) ?? 0)) : pb.top;
          if (me.bottom <= pTop || me.top >= pb.bottom) continue; // 没真压上就不动
          d = Math.min(d, pTop - gap * (it.gapScale ?? 1) - it.bottom);
        }
        if (d === dy.get(it.key)) break;
        dy.set(it.key, d);
      }
      done.push(it);
    }
    // **整排取齐**：同一个下层对象底下的同类（`spread`）要抬得一样高，
    // 一条弧底下的和弦一高一低比压着还难看。传播到不动点（一个和弦可以同时在两条弧底下）。
    const spreadable = done.filter((i) => i.spread);
    if (spreadable.length && placed.length) {
      for (let iter = 0; iter < 8; iter++) {
        let changed = false;
        for (const p of placed) {
          const pb = boxOf(p);
          const byKind = new Map<string, BandItem[]>();
          for (const it of spreadable) {
            if (!xHit({ x0: it.x0, x1: it.x1, top: 0, bottom: 0 }, pb)) continue;
            const arr = byKind.get(it.spread!) ?? [];
            arr.push(it);
            byKind.set(it.spread!, arr);
          }
          for (const arr of byKind.values()) {
            // **只有真让了位的才取齐**：一条长弧底下，被它压住的那几个和弦要抬得一样高
            //（一高一低比压着还难看），但**没被压上的一个都不动**——照直整排抬就成了
            //「不冲突也一层层往上摞」，全书白白长高十几页。
            const lifted = arr.filter((i) => (dy.get(i.key) ?? 0) < 0);
            if (lifted.length < 2) continue;
            const lo = Math.min(...lifted.map((i) => dy.get(i.key) ?? 0));
            for (const it of lifted) {
              if ((dy.get(it.key) ?? 0) > lo) {
                dy.set(it.key, lo);
                changed = true;
              }
            }
          }
        }
        if (!changed) break;
      }
    }
    placed.push(...done);
  }
  return dy;
}

/** 一段 x 区间内、**抬完之后**的最高墨迹（房号那条统一车道就按它定）。空集返回 null。
 *  传进来的 `items` 必须是 `stackUpperBand` 跑完、`top/bottom` 已经加过 dy 的那一份。 */
export function bandTop(items: readonly BandItem[], x0: number, x1: number): number | null {
  let top = Infinity;
  for (const it of items) {
    if (it.x1 <= x0 || it.x0 >= x1) continue;
    top = Math.min(top, it.top);
  }
  return Number.isFinite(top) ? top : null;
}
