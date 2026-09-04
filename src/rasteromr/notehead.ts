// 符头：**不走形状字典，单独判**。
//
// 为什么单独判：符头是全页最多的符号（一首歌几千个），而位图上它的形状最不稳定
// ——去谱线会在骑线的符头上切一道、符干相接处会留个缺口、加线会粘上来。
// 拿 32×32 签名聚类，实测一首歌的符头被切成十几个类（宁静一首里前八个大类全是符头
// 的残缺变体），字典越滚越大而语义还是那三个。
//
// 换成按**性质**判，三档一刀分得开：
//   - **填充率**分实心与空心：实心符头是个实椭圆，墨占包围盒的四分之三；
//     空心符头只有一圈，占不到一半。
//   - **有没有符干**分二分与全音符：空心且**没有符干**的是全音符
//     （全音符本来就不带符干），空心且有符干的是二分音符。
//
// 这三条与字体无关，换一本书也成立——而形状签名是跟着字体走的。
import type { Binary, Component, Rect } from "../omr/types";
import type { SmuflName } from "../staffomr/glyphs";
import type { LineSeg } from "./prims";
import type { RasterUnit } from "./staffline";

/** 认出来的符头。 */
export interface RasterHead {
  comp: Component;
  /** 剪掉加线之后的符头盒（判音高、量尺寸都用它）。 */
  box: Rect;
  code: SmuflName;
  /** 墨迹占包围盒的比例，排查用。 */
  fill: number;
  /** 挂在它左右缘的符干（没有为 null）。 */
  stem: LineSeg | null;
  /**
   * 剪出来的**加线**（符头两侧那截细横笔；没有为 null）。
   *
   * 非补这一条不可：加线的外露部分只有三四个像素（其余被符头盖住，
   * 那里的纵向游程是整个符头的高度、不算细笔画），过不了 `findPrimitives`
   * 的长度闸，于是 `findLegers` 手里一条加线都没有，谱表外的音符全被判否。
   * 而 `trimLedger` 恰好知道剪掉了哪几列——那就是加线，顺手补出来。
   */
  ledger: LineSeg | null;
}

/** 符头宽度的上下限（线距的倍数）。实心符头约 1.3 格宽、1.0 格高。 */
const W_MIN = 0.85;
/** 上限 1.85。**全音符本身就有 1.70 格宽**（`glyphmap.json` 的 Maestro 模板），
 *  写死 1.7 等于把它卡在门口。留一点余量到 1.85。
 *  （更早试过 1.95，那时还没按宽度分全/二分，多检出的两百多个块全是噪声。） */
const W_MAX = 1.85;
/** 高度下限放得低：骑在谱线上的符头被去线切掉一道，实测能矮到 0.6 格。 */
const H_MIN = 0.55;
const H_MAX = 1.35;

/** 填充率的分界。实心椭圆理论值 π/4 ≈ 0.785，空心的一圈实测在 0.45 上下。 */
const FILL_SOLID = 0.62;

/**
 * 全音符与二分音符的**宽度**分界。
 *
 * `glyphmap.json` 的 Maestro 模板：全音符 **1.70×1.06** 格、二分音符 **1.32×1.10** 格、
 * 四分音符 1.30×1.03 格——宽度一刀分得开，而高度三者几乎相同。
 *
 * 原来按「有没有符干」分（全音符不带符干），实测**不可靠**：空心符头的右侧笔画
 * 与符干在竖笔画掩模里连成一块，抽不出独立的符干段——304 个空心符头里
 * 容差放到两格也只有 98 个找得到竖段，于是二分音符整批读成全音符
 * （宁静一首认出 145 个全音符，GT 只有 15 个）。宽度这一条不依赖符干抽得出抽不出。
 */
const W_WHOLE = 1.5;

/**
 * **空心符头**另设的宽度下限。
 *
 * 实心符头会被去谱线与符干残根啃窄，所以 `W_MIN` 放到 0.85；但空心的那一档
 * 不能跟着放——页面上又扁又空的小块太多（歌词笔画的转折、弧线的一小段），
 * 实测被收成「空心符头」的块**宽度中位数只有 0.99 格**，而真二分音符是 1.32、
 * 全音符 1.70。于是宁静一首认出 145 个全音符（GT 只有 15 个）。
 * 门槛扫过 0.85（等于不设）/1.00/1.10，取 **1.00**（音符 56.30 / 56.62 / 56.52）。
 *
 * **小节自检会跟着降**（29.1 → 27.7 → 25.8），那是**虚高被挤掉**、不是退化：
 * `checkBars` 跳过没有音符的小节，而一个假全音符恰好占满 4/4 一小节
 * ——空小节里混进一个就「通过」了。宁静一首原本认出 145 个全音符（GT 只有 15 个）。
 */
const W_HOLLOW_MIN = 1.0;

/**
 * **空心符头**另设的宽高比下限。
 *
 * 真符头是**横椭圆**：`glyphmap.json` 的 Maestro 模板给出全音符 1.70×1.06（比值 1.60）、
 * 二分 1.32×1.10（1.20）。而谱表上方的声部标签（"Women"/"Men"）与曲名里的
 * `o`/`e`/`D` 是**接近正方**的空心块，宽度又正好在 1.0~1.7 格这一档里
 * ——实测宁静 p2 的 "Women" 里那个 `o` 被收成上加一线的 A5 全音符。
 *
 * 假全音符不只是多出一个音：**它恰好占满一小节**，`checkFull` 于是把整小节判成
 * 「一个全音符 + 另一路旋律」，`splitVoice` 把真旋律整条推到第二声部去
 * （逐声部对拍只取声部号最小的那一路，那一行的音就全落在分母外了）。
 */
const R_HOLLOW_MIN = 1.05;

/**
 * 从连通块里挑出符头并定它的 SMuFL 名。
 *
 * 名字与矢量路的 `page.ts::findNoteheads` 岔开（那边是「给符头找它属于哪一行谱」，
 * 这边是「哪些块是符头、是哪一种」），两边都从 `src/cli/index.ts` 导出，不能重名。
 *
 * `stems` 传竖段（`findPrimitives` 的 `vSegs`）——判「有没有符干」要用。
 * 符干贴在符头的**一侧**，不穿过中心，所以比的是符头的左缘或右缘
 * （与矢量路 `page.ts::findStems` 同一条判据）。
 */
export function findRasterHeads(
  bin: Binary,
  blobs: Component[],
  stems: LineSeg[],
  unit: RasterUnit,
  /** 「这个 y 落在谱线网格的延长线上吗」——判剪出来的细横笔是不是加线。 */
  onLedgerGrid: (y: number) => boolean = () => false,
  /**
   * 「这个 y 在某行谱的五条线之内吗」（含上下各一格）。**只用来卡空心符头**：
   * 谱表上方的声部标签（"Women"/"Men"）、曲名里的 `o`/`e`/`D` 是接近正方的空心块，
   * 尺寸正好落在符头那一档里，`findStaffForNote` 又会拿文字自己的横笔当加线放行
   * （实测宁静 p2 的 "Women" 里那个 `o` 成了上加一线的 A5 **全音符**）。
   * 实心符头不受这一条限制——谱表外带加线的黑符头是常态。
   */
  inStaffBand: (y: number) => boolean = () => true,
  /**
   * **空心符头拿模板再验一道**（`rasterglyphs.ts::matchTemplate`，Maestro 的
   * `noteheadWhole` / `noteheadHalf`）。空心块是位图上最容易认错的一档：
   * 尺寸落在符头那一档、又不实心的东西满页都是（文字里的 `o`/`e`/`D`、
   * 弧线的一段、和弦图的方框）。填充率与宽高比只是粗判据，
   * **形状**才分得开——而且模板顺带把全音符与二分音符分开了（不必再拿宽度猜）。
   */
  matchHollow: ((box: Rect) => { smufl: SmuflName; dist: number } | null) | null = null,
): RasterHead[] {
  const sp = unit.space;
  const out: RasterHead[] = [];
  for (const c of blobs) {
    const t = trimLedger(bin, c.bbox, unit);
    const b = t.box;
    const w = b.w / sp;
    const h = b.h / sp;
    if (w < W_MIN || w > W_MAX || h < H_MIN || h > H_MAX) continue;
    // 太扁太长的不是符头（是横段残渣、连线）
    if (b.w > b.h * 2.2) continue;
    const fill = t.area / Math.max(1, b.w * b.h);
    if (fill < 0.3) continue; // 太空：是弧线的一段、方框
    const stem = stemOf(b, stems, unit);
    // 剪掉了列，且高度落在谱线网格的延长线上 → 那两截细横笔是加线
    const ledger: LineSeg | null =
      t.trimmed && t.ledgerY != null && onLedgerGrid(t.ledgerY)
        ? { x0: c.bbox.x, y0: t.ledgerY, x1: c.bbox.x + c.bbox.w - 1, y1: t.ledgerY, lw: unit.lineThick, maxLw: unit.lineThick }
        : null;
    let code: SmuflName;
    if (fill >= FILL_SOLID) code = "noteheadBlack";
    else {
      if (w < W_HOLLOW_MIN) continue;
      // **模板当附加证据，不当硬闸。** 只拿模板收（距离 ≤ `TEMPLATE_DIST`）实测更差
      //（音符 65.57% → 64.70%、小节自检 33.2% → 27.1%）：位图上的空心符头被去线
      // 切过一道、又与符干残根连着，签名与 Maestro 那份干净模板差得过闸的不到一半。
      // 反过来，模板**认得出**的就很可信，那时连全/二分也不必再拿宽度猜。
      const m = matchHollow?.(b) ?? null;
      if (m && (m.smufl === "noteheadWhole" || m.smufl === "noteheadHalf")) code = m.smufl;
      else {
        if (w / h < R_HOLLOW_MIN) continue;
        if (!inStaffBand(b.y + b.h / 2)) continue;
        // 两条线索都要：全音符**又宽又没有符干**。单看宽度，带符干残根的二分音符
        // 会被顶到 1.5 格以上；单看符干，空心符头的右侧笔画与符干在竖笔画掩模里
        // 连成一块、抽不出独立的符干段（304 个空心块里容差放到两格也只有 98 个找得到）。
        code = w >= W_WHOLE && !stem ? "noteheadWhole" : "noteheadHalf";
      }
    }
    out.push({ comp: c, box: b, code, fill, stem, ledger });
  }
  return out;
}

/**
 * 一个**已经并好的盒**像不像符头——判据与 `findRasterHeads` 同一套
 * （尺寸 + 填充率 + 空心那几条），只是不再剪加线（盒是并出来的，不是连通块）。
 *
 * 给「碎块并回再查」那一路用：空心符头骑在谱线上时，去谱线会把它切成上下两截
 * （谱线从它中间穿过，头的内腔上下都是白的，那一段线该抹也确实抹了），
 * 于是两截都不成符头、字典也认不出——实测宁静 p3 那行「附点二分音符 + 四分休止」
 * 只认出了休止，整行五个小节全成了「一个 0.25 的音」。
 */
export function judgeHeadBox(bin: Binary, box: Rect, unit: RasterUnit, stems: LineSeg[], inStaffBand: (y: number) => boolean): SmuflName | null {
  const sp = unit.space;
  const w = box.w / sp;
  const h = box.h / sp;
  if (w < W_MIN || w > W_MAX || h < H_MIN || h > H_MAX) return null;
  if (box.w > box.h * 2.2) return null;
  let area = 0;
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++)
      if (x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x]) area++;
  const fill = area / Math.max(1, box.w * box.h);
  if (fill < 0.3) return null;
  if (fill >= FILL_SOLID) return "noteheadBlack";
  if (w < W_HOLLOW_MIN || w / h < R_HOLLOW_MIN) return null;
  if (!inStaffBand(box.y + box.h / 2)) return null;
  return w >= W_WHOLE && !stemOf(box, stems, unit) ? "noteheadWhole" : "noteheadHalf";
}

/**
 * **剪掉加线**：从左右两侧削掉「只有加线那么高」的列。
 *
 * 加线是抹不掉的——它压在符头底下，照 `findPrimitives` 抽出来的段去抹会把符头
 * 一起啃掉（填充率与尺寸一变就认不出符头了，实测音符 28.5% → 27.0%）。
 * 但不剪也不行：符头连着加线之后宽度从 1.3 格涨到 **1.71 格**（刚越过上限）、
 * 填充率被稀释到 0.59（掉出实心那一档），于是高音谱表下面那些带一条加线的
 * C4 整批认不出来——实测宁静人声行开头 `C4 C4 B3 C4` 只认出 B3。
 *
 * 剪的判据：那一列的墨迹高度不超过两倍线宽，就是加线自己的列。
 * 符头那几列有一整个椭圆的高度，剪不掉。
 */
function trimLedger(bin: Binary, b: Rect, unit: RasterUnit): { box: Rect; area: number; trimmed: boolean; ledgerY: number | null } {
  const thin = Math.max(2, unit.lineThick * 2);
  const colH = new Int32Array(b.w);
  for (let x = 0; x < b.w; x++) {
    let n = 0;
    for (let y = 0; y < b.h; y++) if (bin.data[(b.y + y) * bin.w + b.x + x]) n++;
    colH[x] = n;
  }
  let l = 0;
  while (l < b.w && colH[l] > 0 && colH[l] <= thin) l++;
  let r = b.w - 1;
  while (r > l && colH[r] > 0 && colH[r] <= thin) r--;
  if (l >= r) return { box: b, area: colH.reduce((a, v) => a + v, 0), trimmed: false, ledgerY: null };
  // 纵向也收一收：剪完之后重算上下沿
  let top = b.h;
  let bottom = -1;
  let area = 0;
  for (let x = l; x <= r; x++)
    for (let y = 0; y < b.h; y++)
      if (bin.data[(b.y + y) * bin.w + b.x + x]) {
        area++;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
  const trimmed = l > 0 || r < b.w - 1;
  // **剪掉那几列的墨的 y 就是加线的 y。** 不能拿符头中心代替：
  // 符头骑在加线上时两者的确差不多，但符头落在加线**上方那一间**时差半格，
  // `ledgerGrid` 的四分之一格容差一卡，加线就被丢掉——而这正是最常见的一档
  //（实测未认领的符头里「需要 1 条加线、找到 0 条」占 159/259）。
  let ly = 0;
  let ln = 0;
  for (let x = 0; x < b.w; x++) {
    if (x >= l && x <= r) continue;
    for (let y = 0; y < b.h; y++)
      if (bin.data[(b.y + y) * bin.w + b.x + x]) {
        ly += b.y + y;
        ln++;
      }
  }
  const ledgerY = ln ? ly / ln : null;
  if (bottom < top) return { box: b, area, trimmed, ledgerY };
  return { box: { x: b.x + l, y: b.y + top, w: r - l + 1, h: bottom - top + 1 }, area, trimmed, ledgerY };
}

/** 贴在这个符头左缘或右缘、且纵向相交的竖段。 */
function stemOf(b: Rect, stems: LineSeg[], unit: RasterUnit): LineSeg | null {
  const tol = Math.max(unit.lineThick * 2, unit.space * 0.25);
  for (const s of stems) {
    const x = (s.x0 + s.x1) / 2;
    if (Math.abs(x - b.x) > tol && Math.abs(x - (b.x + b.w)) > tol) continue;
    const top = Math.min(s.y0, s.y1);
    const bottom = Math.max(s.y0, s.y1);
    if (bottom < b.y || top > b.y + b.h) continue;
    // **符头要在符干的某一端**，不能在中间——小节线也常擦着符头过
    // （与矢量路 `page.ts::findStems` 同一条闸）。
    const cy = b.y + b.h / 2;
    if (Math.abs(cy - top) > unit.space && Math.abs(cy - bottom) > unit.space) continue;
    return s;
  }
  return null;
}
