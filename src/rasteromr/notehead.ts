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
import { scoreAt, type HeadMask } from "./headmask";

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

/** 填充率的分界。实心椭圆理论值 π/4 ≈ 0.785，空心的一圈实测在 0.45 上下。
 *  **按扫描件重扫过**（怀疑被擦线啃过的实心头掉到 0.62 以下、要去过空心那几条更严的闸）：
 *  0.55 / 0.58 / **0.62** 两档都单调变差——扫描件音符 54.36 / 54.61 / **54.90**%、
 *  干净档 84.30 / 84.71 / **84.94**%，**小节自检垮得最狠**（干净 46.58 / 52.68 / **54.97**%）：
 *  门槛一降，二分与全音符整批被判成实心，时值全错。这条不能动。 */
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
 * **按扫描件重扫过一遍**（0.85 / 1.00 / 1.02 / 1.05 / 1.15）：
 * 扫描件音符 54.21 / 54.90 / 54.90 / **55.15** / 55.10%，
 * 干净档音符 83.93 / 84.94 / 84.96 / **85.01** / 84.94%
 * ——1.05 两档音符都最高，**但干净档歌词从 82.41% 掉到 80.89%**
 * （少认出的空心头把音节挂法整段挪了）。不拿一个档的 1.5 点换另一个档的 0.25 点，
 * 维持 1.00。要动它，得先弄清那 1.5 点掉在哪几行上。
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
    // **高度上限要把粘着的谱线截扣掉**（与整小节休止那道闸同一个机理）。
    // 去谱线的判据是「上下都没墨才抹」，符头压着的那一截线因此留了下来并进块里：
    // 在间的符头上下各挨着半条线，块高多出一个线宽。线细时还挤得进闸门
    //（干净档线宽 2.5px、线距 17.1px，1.0 格的符头量出来 1.29 格，勉强过 1.35），
    // 线一粗就顶出去（破碎扫描件线宽 4.4px、线距 18.8px，量出来 1.23 格，
    // 墨稍胀一点就超限）。下限仍按原样判——那道闸防的是被啃窄的残块。
    const hFit = h - unit.lineThick / sp;
    if (w < W_MIN || w > W_MAX || h < H_MIN || hFit > H_MAX) continue;
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
  // **别按线距给这个上限封顶**（试过 `min(lineThick*2, space*0.35 / 0.4)`）：
  // 扫描件上少剪确实多认出符头——破碎按谱行音符 69.9% → 70.8%、扫描件 headline
  // 51.95% → 52.2%——但多出来的那批里有相当一部分是假头，`attachLyrics` 把音节
  // 挂了上去，**按谱行的歌词从 94.8% 掉到 88.8%**、扫描件歌词档 35.9% → 33.3%。
  // 拿六个点的歌词换零点几个点的音符不划算。
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


// ── 空心符头：**按内腔（洞）找** ────────────────────────────────────────────
//
// 空心符头在位图上最不稳：去谱线把它的圈切断、符干残根粘在旁边、叠置的和弦还会
// 碎成四五片——实测宁静 p2 钢琴右手那个二分和弦碎成 0.66×0.50 / 0.77×1.10 /
// 0.99×0.39 / 0.83×0.33 四块，一块都判不成符头，整条右手序列只剩 8 个音
// （那条谱表逐 staff 只有 56.2%，全曲最大的一个洞，GT 660 音）。
//
// 但**内腔一直在**：外圈再破，只要没破到透，中间那团白就还围着。
// 所以反过来找：在**去谱线之前**的图上取全页的孔（`contour.ts::findHoles`），
// 尺寸像符头内腔的，往外扩一圈就是符头。
//
// 骑在谱线上的头，内腔被谱线豁成上下两半（实测 0.77×0.28 两个），
// 所以先把「x 上重叠、纵向挨着」的孔并回一个。

/** 孔并回来之后，像不像符头的内腔（线距的倍数）。 */
const HOLE_W = [0.45, 1.25] as const;
const HOLE_H = [0.3, 1.0] as const;
/** 两个孔并成一个内腔：x 上要重叠这么多（窄的那个的比例），纵向缝不超过这么多格。 */
const HOLE_OVERLAP = 0.6;
const HOLE_VGAP = 0.45;
/** 内腔往外扩多少（线距）——空心符头的圈实测 0.15~0.25 格厚。 */
const RING = 0.22;
/** 扩出来的盒里墨占多少才算「一个圈」。扫过 0.18 / 0.25 / 0.30 / 0.35：
 *  音符 67.61 / 69.57 / **69.60** / 69.41%。
 *  **按扫描件重扫过**（0.25 / 0.30 / 0.35）：扫描件音符 54.78 / **54.90** / 54.91%、
 *  干净档 84.91 / **84.94** / 84.71%——0.35 扫描档只多 0.01 而干净档掉 0.23，维持 0.30。 */
/** 内腔的宽高比下限：符头是**横椭圆**，字里的框、噪声的空隙多半接近方的。 */
const HOLE_RATIO = 1.2;
/** 二分符头一定带符干（全音符才不带，靠宽度分）。放开这一条实测音符 69.57% → 67.81%。 */
const HOLE_NEED_STEM = true;
const FILL_RING = [0.3, 0.75] as const;
/** 图上量出的墨柱往一头伸出多长（格）才算符干：够一根干，又不是花括号、谱号那种长竖笔。 */
const INK_STEM = [2.5, 7] as const;
/** 叠置空心和弦里两个头的中心最多隔几格（闭合谱两声部同干可到八度多，3.5 格）。 */
const MATE_GAP = 3.5;

/** 把被谱线豁开的内腔并回一个。 */
export function mergeHoles(holes: Rect[], unit: RasterUnit): Rect[] {
  const sp = unit.space;
  // **先按尺寸筛一道再并**。页面上最大的一批「孔」是**谱线之间被小节线围住的那些间**
  // （实测 28×20 格一个），不筛就会顺着它们连锁并成整页一个盒（实测并完只剩 155 个、
  // 全是巨块）。符头的内腔连被谱线豁开的半截算在内，不会超过 1.4×1.2 格。
  const sorted = holes.filter((b) => b.w <= sp * 1.4 && b.h <= sp * 1.2).sort((a, b) => a.y - b.y);
  const used = new Uint8Array(sorted.length);
  const out: Rect[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    let box = { ...sorted[i] };
    for (let again = true; again; ) {
      again = false;
      for (let j = 0; j < sorted.length; j++) {
        if (used[j] || sorted[j] === box) continue;
        const r = sorted[j];
        const ov = Math.min(box.x + box.w, r.x + r.w) - Math.max(box.x, r.x);
        if (ov < Math.min(box.w, r.w) * HOLE_OVERLAP) continue;
        const gap = r.y > box.y ? r.y - (box.y + box.h) : box.y - (r.y + r.h);
        if (gap > sp * HOLE_VGAP) continue;
        const x0 = Math.min(box.x, r.x);
        const y0 = Math.min(box.y, r.y);
        box = { x: x0, y: y0, w: Math.max(box.x + box.w, r.x + r.w) - x0, h: Math.max(box.y + box.h, r.y + r.h) - y0 };
        used[j] = 1;
        again = true;
      }
    }
    used[i] = 1;
    out.push(box);
  }
  return out;
}

/**
 * 内腔 → 空心符头。返回还没被认出来的那些（与已认出的符头盒重叠的会跳过）。
 *
 * @param nl 去谱线之后的图（量填充率、判符干用它）。
 * @param holes **去谱线之前**取的孔，已经并过（`mergeHoles`）。
 */
export function hollowHeadsFromHoles(
  nl: Binary,
  holes: Rect[],
  unit: RasterUnit,
  stems: LineSeg[],
  inStaffBand: (y: number) => boolean,
  taken: Rect[],
): { box: Rect; code: SmuflName; weak?: boolean }[] {
  const sp = unit.space;
  const ring = Math.max(2, Math.round(sp * RING));
  const out: { box: Rect; code: SmuflName; weak?: boolean }[] = [];
  /** 过了尺寸与填充、只差「符干一端」那道闸的：叠置和弦里夹在中间的头（见下）。 */
  const midStem: { box: Rect; stem: LineSeg }[] = [];
  for (const hole of holes) {
    const hw = hole.w / sp;
    const hh = hole.h / sp;
    if (hw < HOLE_W[0] || hw > HOLE_W[1] || hh < HOLE_H[0] || hh > HOLE_H[1]) continue;
    if (hole.w / hole.h < HOLE_RATIO) continue; // 内腔是**横椭圆**：字里的框、噪声的空隙多半接近方的
    const box: Rect = { x: hole.x - ring, y: hole.y - ring, w: hole.w + ring * 2, h: hole.h + ring * 2 };
    const w = box.w / sp;
    const h = box.h / sp;
    if (w < W_HOLLOW_MIN || w > W_MAX || h < H_MIN || h > H_MAX) continue;
    if (w / h < R_HOLLOW_MIN) continue;
    if (!inStaffBand(box.y + box.h / 2)) continue;
    // 圈要**围得住**：盒里的墨占三成到七成（全实心的是实心符头、太空的是别的东西的空隙）
    let ink = 0;
    for (let y = box.y; y < box.y + box.h; y++)
      for (let x = box.x; x < box.x + box.w; x++)
        if (x >= 0 && y >= 0 && x < nl.w && y < nl.h && nl.data[y * nl.w + x]) ink++;
    const fill = ink / Math.max(1, box.w * box.h);
    if (fill < FILL_RING[0] || fill > FILL_RING[1]) continue;
    // 已经认出来的符头不重复收
    if (taken.some((t) => overlaps(t, box, sp * 0.4))) continue;
    let stem: LineSeg | true | null = stemOf(box, stems, unit);
    if (!stem) {
      // 竖段表里没有的干：闭合谱男声 B3 往下一根干穿过整个谱表到 G♯2（齐来称颂），
      // 长得像小节线，没进竖段表。照 Audiveris `HeadLinker` 的做法直接在图上沿盒边量墨柱，
      // 往一头伸出 2.5~7 格就算有干。
      const col = inkColumn(nl, box, unit);
      const cy = box.y + box.h / 2;
      const reach = col ? Math.max(cy - col[0], col[1] - cy) : 0;
      if (reach >= sp * INK_STEM[0] && reach <= sp * INK_STEM[1]) stem = true;
    }
    if (!stem) {
      const through = stemThrough(box, stems, unit);
      if (through) midStem.push({ box, stem: through });
    }
    // 二分符头一定带符干，全音符才不带（宽度那一档与 `judgeHeadBox` 共用 `W_WHOLE`）。
    // 试过把全音符的宽度门槛单独抬到 1.65：时值 90.3% → 90.5%，但音符 69.60% → 69.52%，
    // 不划算。
    if (HOLE_NEED_STEM && !stem && w < W_WHOLE) continue;
    // 靠墨柱认下的头标 `weak`：不进空心头模板的样本（`buildHollowMasks`）。它们多半拖着
    // 一根穿过窗口的长干，混进去模板就偏了——善牧恩慈歌两处真二分头认出来，却让模板
    // 再也配不上后面的全音符和弦（音符 90.0% → 89.3%，不进样本 → 91.4%）。
    out.push({ box, code: w >= W_WHOLE && !stem ? "noteheadWhole" : "noteheadHalf", ...(stem === true ? { weak: true } : {}) });
    taken.push(box);
  }
  // **叠置空心和弦**：符干从一端的头穿过另一个头往外伸（齐来称颂 A4/E4 二分和弦，
  // 干从 E4 起、穿过 A4 再往上两格），夹在中段的那个头过不了「符头在符干一端」。
  // 同一根干上 2.2 格内已有收下的空心头，它就是和弦的一员。
  //
  // 同干的另一个头只要**碰到这根干**就算（干常常只到那个头的中线上一两像素，
  // 「穿过中线」差一像素就落空），相隔放到 3.5 格（齐来称颂男声 A3/C♯3 隔 2.5 格）。
  // 这就是 Audiveris 的「符头柱」：两头都伸出去的是柱中段，由柱端那个连上干的头来定。
  const tol = Math.max(unit.lineThick * 2, sp * 0.25);
  for (const m of midStem) {
    if (taken.some((t) => overlaps(t, m.box, sp * 0.4))) continue;
    const cy = m.box.y + m.box.h / 2;
    const top = Math.min(m.stem.y0, m.stem.y1);
    const bottom = Math.max(m.stem.y0, m.stem.y1);
    const x = (m.stem.x0 + m.stem.x1) / 2;
    const mate = out.some((o) => {
      if (Math.abs(x - o.box.x) > tol && Math.abs(x - (o.box.x + o.box.w)) > tol) return false;
      if (bottom < o.box.y || top > o.box.y + o.box.h) return false;
      return Math.abs(o.box.y + o.box.h / 2 - cy) <= sp * MATE_GAP;
    });
    if (!mate) continue;
    out.push({ box: m.box, code: "noteheadHalf" });
    taken.push(m.box);
  }
  return out;
}

// ── 空心头：**按音高位置逐一配模板**（Audiveris 式）────────────────────────
//
// 叠成「8」字的三度空心和弦，两个内腔中间只隔两像素细圈，`mergeHoles` 把它们当成
// 被谱线豁开的一个内腔并掉（齐来称颂 E4/B3、G♯3/E3、C♯4/A3，并出来 1.7~1.8 格高），
// 过不了内腔尺寸闸。拦合并试过四种都不行（圣哉三一歌伴奏的斜缝内腔一个头切成三四片，
// 必须并）。Audiveris（`NoteHeadsBuilder.processStaff`）不从内腔反推头，而是沿谱线、间、
// 加线的每个音高位置逐一配模板，重叠按音级差判（`HeadInter.overlaps`：差 ≥2 级不算重叠）
// ——三度的两个头在隔两级的两个位置上各自得分，天然分得开。
//
// 这里只在**有内腔的地方**这么找：「拿模板去空地里找」对实心头每档都低于不做
// （`docs/实现/位图五线谱识别/符头与加线.md`），内腔是空心头最硬的先验，留着。

/** 候选区：并过的内腔高过一个头、又不超过两个头（格）。实测真叠头 1.69~1.87 格；
 *  八分音符的符尾弯回符干、被谱线切成几片再并起来的「孔」1.88~2.87 格（宁静的伯利恒二十多处）。 */
const STACK_H = [1.0, 2.0] as const;
/** 候选区的宽度下限（格）：真叠头的内腔 0.93~1.11 格宽；八分符尾弯回符干围出来的窄孔
 *  0.64~0.88 格（破碎干净版五处，得分也只有 0.30 上下）。 */
const STACK_W = 0.9;
// 下面三个门槛是在 `STACK_H` 上限 3.5 格、不要求两个头时扫的；加上那两条与 `STACK_W` 之后，
// 图片九首合计不变（93.41%），合唱谱两档回到基线以上。
/** 打分窗口只留中间这么高（格）。整窗 1.5 格高会把叠着的邻头的圈框进来、算成「不该有的墨」，
 *  间位的头只打到 0.26~0.33 分（线位 0.5~0.7）。扫过整窗 / 1.2 / 1.1 / **1.0** / 0.9 / 0.8：
 *  九首合计 92.39 / 92.86 / 93.41 / **93.41** / 93.41 / 92.76%，1.0 这一档对下面的门槛最不敏感。 */
const PITCH_CORE = 1.0;
/** 模板得分门槛。核心窗下扫过 0.27 / **0.30** / 0.33 / 0.40：93.51 / 93.41 / 93.41 / 92.11%。 */
const PITCH_SCORE = 0.3;
/** 内腔佐证：该位置的内腔椭圆里落在原始孔里的白像素占比。扫过 0.35 / 0.40 / 0.45 / **0.50** / 0.55：
 *  93.23 / 93.23 / 93.23 / **93.41** / 92.76%。低了圣哉三一歌伴奏的斜缝内腔只收半边、
 *  挡住模板再搜那一路（它两个都认得出）；高了齐来称颂 C4 那种骑加线的头佐证不够（0.54）。 */
const CAVITY_MIN = 0.5;

/** 一个音高位置：中心 y，以及它是不是线位（含加线位）。 */
export interface PitchStep {
  y: number;
  line: boolean;
}

/** 按音高位置配模板的公用件：核心窗模板、内腔佐证、「同一个头」判定、定干。 */
function pitchScorer(bin: Binary, nl: Binary, rawHoles: Rect[], allMasks: HeadMask[], unit: RasterUnit, stems: LineSeg[]) {
  const sp = unit.space;
  const masks = allMasks.map((m) => {
    const h = Math.min(m.h, Math.max(3, Math.round(sp * PITCH_CORE)));
    const top = Math.floor((m.h - h) / 2);
    return { ...m, h, p: m.p.slice(top * m.w, (top + h) * m.w) };
  });
  /** 内腔椭圆的半轴：内腔实测约 1.0×0.8 格。 */
  const rx = sp * 0.45;
  const ry = sp * 0.32;
  /** 该位置的内腔椭圆里，落在原始孔里的白像素占比。 */
  const cavity = (cx: number, cy: number): number => {
    let n = 0;
    let hit = 0;
    for (let y = Math.round(cy - ry); y <= Math.round(cy + ry); y++)
      for (let x = Math.round(cx - rx); x <= Math.round(cx + rx); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
        n++;
        if (x < 0 || y < 0 || x >= bin.w || y >= bin.h || bin.data[y * bin.w + x]) continue;
        if (rawHoles.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) hit++;
      }
    return n ? hit / n : 0;
  };
  /** 在 y 这个位置、x 从 xa 到 xb 扫，取骑线/在间对应模板的最高分。 */
  const best = (st: PitchStep, xa: number, xb: number): { x: number; s: number } | null => {
    const m = masks.find((k) => k.onLine === st.line) ?? masks[0];
    let b: { x: number; s: number } | null = null;
    for (let x = Math.round(xa); x <= Math.round(xb); x++) {
      const sc = scoreAt(bin, m, x, st.y);
      if (!b || sc > b.s) b = { x, s: sc };
    }
    return b;
  };
  /** 与已有的头差不到两级（同一位置或相邻半格）、横向又压着的，算同一个头。 */
  const clash = (b: Rect, list: Rect[]) =>
    list.some(
      (t) =>
        Math.abs(t.y + t.h / 2 - (b.y + b.h / 2)) < sp * 0.75 &&
        Math.abs(t.x + t.w / 2 - (b.x + b.w / 2)) < (t.w + b.w) / 2 - sp * 0.2,
    );
  /** 时值：与 `hollowHeadsFromHoles` 同一套——竖段表的干、墨柱、同干成员。没干又不够宽的返回 null。 */
  const codeOf = (box: Rect, picked: Rect[]): { code: SmuflName; ink?: LineSeg } | null => {
    let stem: LineSeg | true | null = stemOf(box, stems, unit);
    let ink: LineSeg | undefined;
    if (!stem) {
      const col = inkColumn(nl, box, unit);
      const cy = box.y + box.h / 2;
      const reach = col ? Math.max(cy - col[0], col[1] - cy) : 0;
      if (col && reach >= sp * INK_STEM[0] && reach <= sp * INK_STEM[1]) {
        stem = true;
        ink = { x0: col[2], y0: col[0], x1: col[2], y1: col[1], lw: unit.lineThick, maxLw: unit.lineThick * 2 };
      }
    }
    if (!stem) {
      const through = stemThrough(box, stems, unit);
      if (through && picked.some((o) => o !== box && Math.abs(o.y - box.y) <= sp * MATE_GAP)) stem = through;
    }
    if (!stem && box.w / sp < W_WHOLE) return null;
    return { code: stem ? "noteheadHalf" : "noteheadWhole", ink };
  };
  return { cavity, best, clash, codeOf };
}

export function hollowHeadsByPitch(
  bin: Binary,
  nl: Binary,
  rawHoles: Rect[],
  holes: Rect[],
  allMasks: HeadMask[],
  unit: RasterUnit,
  stepsIn: (y0: number, y1: number) => PitchStep[],
  stems: LineSeg[],
  inStaffBand: (y: number) => boolean,
  taken: Rect[],
): { box: Rect; code: SmuflName; weak?: boolean }[] {
  const sp = unit.space;
  if (!allMasks.length) return [];
  const { cavity, best, clash, codeOf } = pitchScorer(bin, nl, rawHoles, allMasks, unit, stems);
  const ring = Math.max(2, Math.round(sp * RING));
  const out: { box: Rect; code: SmuflName; weak?: boolean }[] = [];
  const headH = Math.round(sp * 1.1);
  for (const hole of holes) {
    const hw = hole.w / sp;
    const hh = hole.h / sp;
    if (hw < STACK_W || hw > HOLE_W[1] || hh <= STACK_H[0] || hh > STACK_H[1]) continue;
    const cx0 = hole.x + hole.w / 2;
    if (!inStaffBand(hole.y + hole.h / 2)) continue;
    const bw = hole.w + ring * 2;
    const cands: { x: number; y: number; s: number }[] = [];
    for (const st of stepsIn(hole.y - sp * 0.3, hole.y + hole.h + sp * 0.3)) {
      const b = best(st, cx0 - sp * 0.2, cx0 + sp * 0.2);
      if (!b || b.s < PITCH_SCORE) continue;
      if (cavity(b.x, st.y) < CAVITY_MIN) continue;
      cands.push({ x: b.x, y: st.y, s: b.s });
    }
    cands.sort((a, b) => b.s - a.s);
    const picked: Rect[] = [];
    for (const c of cands) {
      const box: Rect = { x: Math.round(c.x - bw / 2), y: Math.round(c.y - headH / 2), w: bw, h: headH };
      if (clash(box, picked) || clash(box, taken)) continue;
      picked.push(box);
    }
    // 两个内腔并成的区就该认出两个头。只认出一个的：符尾围出来的假孔（宁静的伯利恒），
    // 或斜缝内腔上面那个头佐证不够（圣哉三一歌伴奏）——收了半边反倒挡住「空心头按模板再搜」
    // 那一路（它两个都认得出），整区交回去。
    if (picked.length < 2) continue;
    for (const box of picked) {
      const c = codeOf(box, picked);
      if (!c) continue;
      out.push({ box, code: c.code, weak: true });
      taken.push(box);
    }
  }
  return out;
}

// ── 空心头：**沿加线按音高位置配模板** ──────────────────────────────────────
//
// 谱表外骑着加线的斜缝空心头（赞美三一真神末三小节：C4、C4/A3、C4/G3、D4/C4 二度错排），
// 内腔是一道斜缝，被加线横着切成左上、右下两截，两截横向几乎不交叠，`mergeHoles` 并不起来，
// 两端又被干封住；按内腔找、按模板再搜都认不出。Audiveris 在加线上也是逐位置配模板：
// 这里拿**没压着头的加线**当候选，在它本身和上下两个间位上逐位置打分，x 沿加线扫。

/** 加线候选的长度（格）：一个头宽出一点到两个头（二度错排）。 */
const LEDGER_LEN = [1.2, 2.8] as const;
/** 加线上的头的模板得分门槛。扫过 0.25 / 0.30 / **0.35** / 0.40：九首合计 94.53 / 94.53 / **94.53** / 94.43%；
 *  合唱谱（内腔 0.25 时）0.30 那档干净版按 staff 映射掉 0.08 点（加线旁的误收）；0.35 配内腔 0.30/0.35，
 *  干净档 85.43 → 85.50%、扫描档不降。 */
const LEDGER_SCORE = 0.35;
/** 加线上的头的内腔佐证：斜缝被切成小片，比叠头那一路（0.5）低——赞美三一真神那几个真头实测 0.36~0.39。
 *  扫过 0.15 / 0.25 / **0.30** / 0.35，九首与合唱谱都一样，取离真头留点余量的一档。 */
const LEDGER_CAVITY = 0.3;

export function hollowHeadsOnLedgers(
  bin: Binary,
  nl: Binary,
  rawHoles: Rect[],
  allMasks: HeadMask[],
  unit: RasterUnit,
  ledgers: { x0: number; x1: number; y: number }[],
  stepsIn: (y0: number, y1: number) => PitchStep[],
  stems: LineSeg[],
  taken: Rect[],
  /** 出参：靠墨柱判出来的干（竖段表里没有，`buildNotes` 定时值要用）。 */
  inkStems: LineSeg[],
): { box: Rect; code: SmuflName; weak?: boolean }[] {
  const sp = unit.space;
  if (!allMasks.length) return [];
  const { cavity, best, codeOf } = pitchScorer(bin, nl, rawHoles, allMasks, unit, stems);
  const out: { box: Rect; code: SmuflName; weak?: boolean }[] = [];
  const bw = Math.round(sp * 1.3);
  const headH = Math.round(sp * 1.1);
  const picked: Rect[] = [];
  const cands: { x: number; y: number; s: number }[] = [];
  for (const l of ledgers) {
    const len = (l.x1 - l.x0) / sp;
    if (len < LEDGER_LEN[0] || len > LEDGER_LEN[1]) continue;
    for (const st of stepsIn(l.y - sp * 0.7, l.y + sp * 0.7)) {
      const b = best(st, l.x0 + sp * 0.4, l.x1 - sp * 0.4);
      if (!b || b.s < LEDGER_SCORE) continue;
      const cv = cavity(b.x, st.y);
      if (cv < LEDGER_CAVITY) continue;
      cands.push({ x: b.x, y: st.y, s: b.s });
    }
  }
  cands.sort((a, b) => b.s - a.s);
  // 二度错排的两个头（m15 的 D4/C4）横向只差一个头宽，`clash` 的「横向压着」会把它们判成同一个；
  // 相邻音级（差半格）只在横向差不到 0.6 个头宽时才算重叠——照 Audiveris `HeadInter.overlaps`
  const second = (b: Rect, list: Rect[]) =>
    list.some((t) => {
      const dy = Math.abs(t.y + t.h / 2 - (b.y + b.h / 2));
      const dx = Math.abs(t.x + t.w / 2 - (b.x + b.w / 2));
      return dy < sp * 0.25 ? dx < (t.w + b.w) / 2 - sp * 0.2 : dy < sp * 0.75 && dx < ((t.w + b.w) / 2) * 0.6;
    });
  for (const c of cands) {
    const box: Rect = { x: Math.round(c.x - bw / 2), y: Math.round(c.y - headH / 2), w: bw, h: headH };
    if (second(box, picked) || second(box, taken)) continue;
    picked.push(box);
  }
  for (const box of picked) {
    const c = codeOf(box, picked);
    if (!c) continue;
    out.push({ box, code: c.code, weak: true });
    if (c.ink) inkStems.push(c.ink);
    taken.push(box);
  }
  return out;
}

/**
 * 竖段表之外、直接在图上量的符干：盒左右缘附近各列，从盒中心往上下沿墨走（断口 ≤2 像素），
 * 取纵向最长的一列，返回 `[上端, 下端, 列 x]`。
 */
function inkColumn(nl: Binary, b: Rect, unit: RasterUnit): [number, number, number] | null {
  const tol = Math.round(Math.max(unit.lineThick * 2, unit.space * 0.25));
  const cy = Math.round(b.y + b.h / 2);
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < nl.w && y < nl.h && nl.data[y * nl.w + x] === 1;
  const walk = (x: number, dir: number): number => {
    let last = cy;
    for (let y = cy, miss = 0; miss <= 2 && y >= 0 && y < nl.h; y += dir) {
      if (at(x, y)) {
        last = y;
        miss = 0;
      } else miss++;
    }
    return last;
  };
  let best: [number, number, number] | null = null;
  for (const edge of [b.x, b.x + b.w]) {
    for (let x = Math.round(edge) - tol; x <= Math.round(edge) + tol; x++) {
      const top = walk(x, -1);
      const bottom = walk(x, 1);
      if (!best || bottom - top > best[1] - best[0]) best = [top, bottom, x];
    }
  }
  return best;
}

/** 贴着盒左右缘、纵向穿过盒的竖段（不管盒在段的哪一截）。 */
function stemThrough(b: Rect, stems: LineSeg[], unit: RasterUnit): LineSeg | null {
  const tol = Math.max(unit.lineThick * 2, unit.space * 0.25);
  for (const s of stems) {
    const x = (s.x0 + s.x1) / 2;
    if (Math.abs(x - b.x) > tol && Math.abs(x - (b.x + b.w)) > tol) continue;
    if (Math.max(s.y0, s.y1) < b.y + b.h / 2 || Math.min(s.y0, s.y1) > b.y + b.h / 2) continue;
    return s;
  }
  return null;
}

function overlaps(a: Rect, b: Rect, tol: number): boolean {
  return Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < tol + (a.w + b.w) / 4 && Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < tol + (a.h + b.h) / 4;
}
