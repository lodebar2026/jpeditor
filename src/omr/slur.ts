// 圆滑线 / 连音线识别（音符上方的弧形 ⌒）。
// 简谱里弧线画在数字**正上方**、横跨 2~3 个相邻音符：圆滑线(slur，跨不同音高)用于一字多音/乐句，
// 连音线(tie，跨相邻同音高)用于延音。两者视觉相同，唯一可分的判据是端点音高是否相等。
//
// 几何特征（与八度点/增时线/减时线区分）：
//   - 弧线是「宽而薄」的连通块：w ≳ 0.8×字号、w/h ≥ 2，落在数字行**上方**（底边贴近数字顶）。
//   - 八度上点很小(w,h ≤ 0.45×字号)；增时线 '-' 在数字**中线**、减时线在数字**下方** → 都不在上方，天然不混。
//   - 数字块 h ≥ 0.55×字号 才算，弧线更矮 → 不会被当成假音符（classify 里已落到 hlines 或被丢弃）。
import type { Binary, Component, JpNum, Rect, StaffRow } from "./types";
import { rright, rbottom, rcx, RHYTHM_DIGIT } from "./types";
import { median, overlapX } from "./geom";
import { probe } from "./probe";

const between = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

/** 有墨的列里，最低墨点落在块底（末两行）的占比。字母立在基线上占比高，拱形的弧只有两脚着底。 */
function flatBottomShare(bin: Binary, b: Rect): number {
  let cols = 0, onBase = 0;
  for (let x = b.x; x < b.x + b.w; x++) {
    let low = -1;
    for (let y = b.y + b.h - 1; y >= b.y; y--) if (bin.data[y * bin.w + x]) { low = y; break; }
    if (low < 0) continue;
    cols++;
    if (low >= b.y + b.h - 2) onBase++;
  }
  return cols ? onBase / cols : 0;
}

/**
 * 一个弧连通块里**套着的内弧**：两条弧共用一个端点（外弧罩三音、内弧只罩后两音）时，
 * 内弧的收尾一段与外弧交叠、被 4-连通粘成同一个块，包围盒只剩外弧那一条。
 * 「2146 奉献的心志在燃烧」第 1 行 `2 3 2` 上就是这样一对，内弧整条被吞。
 * 一块里还可能**套着两条**：迦南诗选 1782《祝福新人》`2 3 3 2` 上一条外弧罩四音，左右各一条内弧
 * （`2⌒3`、`3⌒2`）分别并进外弧的两头，三条弧是一个块。
 *
 * 判据：逐列数竖向墨段。单条弧每列只有一段；内弧与外弧交叠的那一段 x 里每列有**上下两段**
 * （上=外弧、下=内弧，内弧必在外弧之下——它跨得窄、拱得低）。双段列按「中间单段列连着超过两列」
 * 切成几个区间，每个区间各认一条内弧：取下面那一段拼出内弧包围盒。
 *
 * 两头的处理：内弧在交点处**并进**外弧（两段的竖向间隙缩到笔画粗细内）而非在空中断掉，
 * 说明它的余下一截与外弧重合、真正的端点在外弧那一头 → 该侧延到母块边缘；否则就此打住。
 * 长度门（≥0.8 字号）看的是**延伸之后**的内弧：1777《福音传到你那里》`2 3 3` 的内弧 `3⌒3` 双段区间
 * 只有 25 列（字号 35），并进外弧右端后实为 51px；1782 的两条内弧双段只有 18、11 列。
 */
function splitNestedArcs(bin: Binary, a: Rect, numH: number): Rect[] {
  const x1 = a.x + a.w, y1 = a.y + a.h;
  // 每列的竖向墨段（只取前两段：再多的是噪点，本就不该出现在弧上方带里）。
  const runsAt = (x: number): Array<[number, number]> => {
    const runs: Array<[number, number]> = [];
    let s = -1;
    for (let y = a.y; y < y1; y++) {
      if (bin.data[y * bin.w + x]) { if (s < 0) s = y; }
      else if (s >= 0) { runs.push([s, y - 1]); s = -1; }
    }
    if (s >= 0) runs.push([s, y1 - 1]);
    return runs;
  };
  const cols = new Map<number, Array<[number, number]>>();
  for (let x = a.x; x < x1; x++) cols.set(x, runsAt(x));
  // 端点在交点处并入外弧 → 该侧延到母块边缘（重合的那一截看不出来，但弧确实画到了那里）。
  const mergedAt = (x: number): boolean => {
    const r = cols.get(x);
    if (!r || r.length < 2) return false;
    return r[r.length - 1][0] - r[r.length - 2][1] <= Math.max(3, numH * 0.12);
  };
  // 双段区间 [lo, hi] 里的内弧；认不出返回 null。
  const innerOf = (lo: number, hi: number): Rect | null => {
    const len = hi - lo + 1;
    if (len < Math.max(6, numH * 0.25)) return null;
    // 内弧包围盒 = 双段区间里**下面那一段**的并集。顺带查笔画粗细：真弧是细线，
    // 高音点、增时线这类混进包围盒的东西会撑出很厚的第二段。
    let ix0 = hi, ix1 = lo, iy0 = y1, iy1 = a.y, thick = 0, topLo = y1, topHi = a.y;
    let cnt = 0, prevTop = -1, prevX = -2, smooth = true;
    for (let x = lo; x <= hi; x++) {
      const r = cols.get(x)!;
      if (r.length < 2) continue;
      const [s, e] = r[r.length - 1];
      cnt++;
      if (x === prevX + 1 && Math.abs(s - prevTop) > 3) smooth = false; // 相邻列跳变 = 不是一笔连续的弧
      prevTop = s; prevX = x;
      if (x < ix0) ix0 = x; if (x > ix1) ix1 = x;
      if (s < iy0) iy0 = s; if (e > iy1) iy1 = e;
      if (s < topLo) topLo = s; if (s > topHi) topHi = s;
      if (e - s + 1 > thick) thick = e - s + 1;
    }
    const rise = topHi - topLo; // 下面那一段的顶边起伏 = 拱高
    // 下面那一段得是**连续一笔**：几乎每列都在、且相邻列不跳变。断断续续的多半是笔画破损的
    // 横线、点、数字顶缘凑出来的假象。
    if (!smooth || cnt < len * 0.8) return null;
    if (thick > numH * 0.3) return null;
    // **得像条弧**：下面那一段要有拱高（顶边高低差 ≥ 0.15 字号）。这一条挡住的是「弧 + 一条
    // 横线粘成一块」——减时线/增时线/三连音括线都是笔直的，顶边一路平着走，照收就会凭空
    // 多出一条弧（实测「主祢真伟大」「我说算了吧」各误加数条）。短区间只露出内弧的一截，拱高按
    // 区间长的三成要求（1782 右内弧 11 列、起伏 5px），直线照样一路平着过不了。
    if (rise < Math.max(3, Math.min(numH * 0.15, len * 0.3))) return null;
    // 两条弧本是一个连通块，必是在某处相交；相交点不在双段区间的两头，说明它们粘的是别的东西
    //（弧压着下面的横线之类），不是一对交叠的弧。
    if (!mergedAt(lo) && !mergedAt(hi)) return null;
    if (mergedAt(lo)) { ix0 = a.x; iy1 = y1 - 1; }
    if (mergedAt(hi)) { ix1 = x1 - 1; iy1 = y1 - 1; }
    const inner: Rect = { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 };
    if (inner.w < numH * 0.8) return null;           // 延伸之后仍不够一个音距 → 不成弧
    if (inner.w >= a.w * 0.95) return null;          // 与母块同宽 → 没分出新东西
    return inner;
  };
  // 双段区间：允许中间断一两列（笔画交叠处两段会短暂并成一段）。
  const spans: Array<[number, number]> = [];
  let lo = -1, hi = -1, gap = 0;
  for (let x = a.x; x < x1; x++) {
    if (cols.get(x)!.length >= 2) { if (lo < 0) lo = x; hi = x; gap = 0; }
    else if (lo >= 0 && ++gap > 2) { spans.push([lo, hi]); lo = -1; gap = 0; }
  }
  if (lo >= 0) spans.push([lo, hi]);
  const inners = spans.map(([l, h]) => innerOf(l, h)).filter((r): r is Rect => r !== null);
  for (let i = 0; i < inners.length; i++) probe(inners.length > 1 ? "nestedArc.multi" : "nestedArc");
  return [a, ...inners];
}

/** 在 comps 里为每个 staff 行检测上方弧线，置位音符的 slurStart/Stop 或 tieStart/Stop。 */
/** 一处多连音候选：括线上方那个小号数字的框（送 OCR 定「几连」）、括线两半的连通块、
 *  以及括线横向罩住的音符。 */
export interface TupletCand {
  numeral: Rect;
  arcs: Component[];
  notes: JpNum[];
}

/**
 * 多连音（三连音 ⌒3⌒）：音符上方一条**中间断开的弧**，缺口里嵌着一个小号数字。
 * 1《以色列的圣者》实测（numH 36）：左弧 54×23、数字 19×21、右弧 54×23，三块紧挨着排在
 * 数字带上方 0.6 字号处，弧的墨占比只有 0.16（细线），数字是 0.56（实心笔画）。
 *
 * 判据（都不依赖 OCR，数字读几由上层补）：
 *   ① 小号数字块：高 0.35~0.8 字号、宽高比 0.4~1.3、墨占比 ≥0.35，整块落在数字带**上方**；
 *   ② 左右各有一段**细弧**：与数字纵向重叠、墨占比 ≤0.4、宽 ≥0.6 字号，横向缝隙 ≤0.6 字号。
 *      两侧都要有——只认这一种谱面写法（手头只有这一种样张，不照着猜别的形状）。
 * 括线罩住的音符按与 `detectSlurs` 同一口径取（质心落在跨度内、左右各放宽 0.5 字号）。
 *
 * **括线的两半自己也够得着圆滑线的判据**（54/23=2.35 ≥1.8、高也够矮），只是各自只罩得住
 * 一个音符才没变成假 slur。认出多连音后要把这两块从 `detectSlurs` 的输入里摘掉，别留这个隐患。
 */
export function tupletCandidates(bin: Binary, comps: Component[], rows: StaffRow[], numH: number): TupletCand[] {
  const out: TupletCand[] = [];
  const inkFill = (b: Rect): number => {
    let ink = 0;
    for (let y = b.y; y < rbottom(b); y++)
      for (let x = b.x; x < rright(b); x++) if (bin.data[y * bin.w + x]) ink++;
    return ink / Math.max(1, b.w * b.h);
  };
  for (const row of rows) {
    if (row.nums.length < 2) continue;
    const rowTop = median(row.nums.map((n) => n.bbox.y));
    const above = comps.filter((c) => rbottom(c.bbox) <= rowTop + numH * 0.1 &&
      rbottom(c.bbox) >= rowTop - numH * 2.2);
    for (const num of above) {
      const nb = num.bbox;
      if (nb.h < numH * 0.35 || nb.h > numH * 0.8) continue;
      const r = nb.w / nb.h;
      if (r < 0.4 || r > 1.3) continue;
      if (inkFill(nb) < 0.35) continue;                       // 实心笔画（弧是细线）
      // 左右两段细弧：与数字纵向重叠、横向紧挨着。
      const arcAt = (side: -1 | 1) => above.find((c) => {
        const b = c.bbox;
        if (b === nb || b.w < numH * 0.6 || b.h > numH * 0.9) return false;
        const gap = side < 0 ? nb.x - rright(b) : b.x - rright(nb);
        if (gap < -numH * 0.15 || gap > numH * 0.6) return false;
        if (rbottom(b) < nb.y || b.y > rbottom(nb)) return false;   // 纵向不重叠
        return inkFill(b) <= 0.4;
      });
      const left = arcAt(-1), right = arcAt(1);
      if (!left || !right) continue;
      const x0 = Math.min(left.bbox.x, nb.x), x1 = Math.max(rright(right.bbox), rright(nb));
      const notes = row.nums.filter((n) => between(rcx(n.bbox), x0 - numH * 0.5, x1 + numH * 0.5));
      if (notes.length < 2) continue;
      out.push({ numeral: nb, arcs: [left, right], notes });
    }
  }
  return out;
}

export function detectSlurs(bin: Binary, comps: Component[], rows: StaffRow[], numH: number): void {
  const arcsOf = (row: StaffRow): Component[] => {
    // 用数字顶边的**中位数**（而非 min）作行顶基准：个别音符 bbox 顶边偏高（拆块/噪声）
    // 会把 min 拉到弧线高度，导致「弧底贴行顶」的判据误杀真弧（实测行4 三条弧全漏即此因）。
    const rowTop = median(row.nums.map((n) => n.bbox.y));

    // 候选弧线：宽而薄、底边贴近数字顶且不深入数字行。
    const arcs = comps.filter((c) => {
      const b = c.bbox;
      // 一房/二房（volta ending）的顶括线同样是「宽而薄」的连通块，但它几乎是一条横贯谱行的直线，
      // 两端只有很短的竖钩，bbox 宽高比通常远大于圆弧。若把它交给下面的覆盖音符逻辑，会给整行
      // 错加一组 slur。真长弧即使跨度很大也有明显拱高（现有样本 w/h≈7.3），这里用很保守的
      // w/h>=12 且至少 6 个字号宽来识别 ending 括线；短横线和正常圆弧均不受影响。
      if (b.w >= numH * 6 && b.w / b.h >= 12) { probe("arc.endingBracketReject"); return false; }
      // 弧高上限放到 ~1 字号：跨相邻两音的弧其拱高可达一个字号（实测耶稣普治 w130 h32、numH39，
      // 卡在旧的 0.8 字号=31 上被整条漏掉）；仍 < 数字块高(≥0.55~2 字号且 w/h<2)，靠 w/h≥2 兜住不误纳数字。
      // 跨多音的**长弧**拱得更高（实测「主祢真伟大」跨 `5__|5---|5` 的 tie：w205 h28、numH22，
      // 卡 1.05 字号=23 被整条漏掉 → 副歌首音丢了 tie 延续），故 h 上限随跨度放宽到 1.6 字号；
      // 但放宽后段落方框（"Chorus" 带框 w98 h36）也会挤进来，故**高过 1.05 字号的块另要求 w/h≥4**
      // ——弧越长越扁（7.3），方框接近方正（2.7）。
      const maxH = b.w > numH * 3 ? numH * 1.6 : numH * 1.05;
      // 宽度下限 0.7 字号（原 0.8）：密排版面里跨两个八分音符的小弧只有 0.77 字号宽
      // （迦南诗选《天不蓝了》实测 37×9、numH 48），卡在 0.8=38.4 上被整条漏掉——同一首里
      // 排得松一点的同形弧 39×10 就认了出来，一页八条弧丢了八条中的八条。下面还有扁平度、
      // 「整体在数字上方」、「至少罩住两个音」三道门，放宽这 0.1 不会把别的块放进来。
      if (b.w < numH * 0.7 || b.h < 2 || b.h > maxH) return false;
      // 扁平度下限 1.8（原为 2）：跨度只有一个字号的短弧拱得相对更高——714《我说算了吧》
      // 第 1 行 `1̇ (5̇ 3̇)` 那条实测 38×20 = 1.9，卡在 2 上被整条漏掉。数字块是「高而窄」
      // （w/h≈0.67）、减时线与增时线又都不在上方带里，放到 1.8 不会把它们放进来。
      if (b.w / b.h < (b.h > numH * 1.05 ? 4 : 1.8)) return false;
      // 底边落在 [数字顶 - 1.2字号, 数字顶 + 0.25字号]：即整体在数字上方、最多略压数字顶缘。
      if (!between(rbottom(b), rowTop - numH * 1.2, rowTop + numH * 0.25)) return false;
      // 和弦字母也在这一带、也够宽够扁：`Em` 连成一块（《切慕》31×15）、`Bm` 的 m（17×9），
      // 条条门都过，凭空多出 `(0 6)` 这样的弧。分开它们靠**底边**：字母立在基线上，横笔与衬线
      // 让大半列的最低墨点都落在块底；弧是拱形，只有两只脚着底，中间各列的最低点都悬在上面。
      // 只对够高的块判（≥0.4 字号）：扁平的小弧拱高只有一两像素，中间列本就贴着块底。
      if (b.h >= numH * 0.4 && flatBottomShare(bin, b) >= 0.5) { probe("arc.flatBottomReject"); return false; }
      // 汉字的底部部件：上一行歌词挨着本行时，「想」字底下的「心」是个独立的扁弯块（迦南诗选 1790《这条路》
      // 29×13、字号 36），正落在本行弧带里罩住两个音，凭空多一条 tie。真弧**正上方是空的**，汉字部件头上
      // 却紧贴着同一个字的其余部分——一块字号大小、近方形的墨（拱得高的长外弧扁而宽，不算），横向罩住它大半、
      // 底边压到或贴近它的顶。
      const hanzi = comps.some((o) => o !== c && o.bbox.h >= numH * 0.5 && o.bbox.w < o.bbox.h * 1.8 && o.bbox.y < b.y &&
        rbottom(o.bbox) >= b.y - numH * 0.2 && overlapX(o.bbox, b) >= b.w * 0.5);
      if (hanzi) probe("arc.hanziReject");
      return !hanzi;
    });
    return arcs;
  };
  const perRow = rows.map((row) => (row.nums.length ? arcsOf(row) : []));

  // **跨行圆滑线**：一条弧跨过换行时，谱面上画成两半——上一行行末一段拖到右界，下一行行首一段
  // 从左界起笔。两半各自都罩得住音符，照行内判据会变成两条闭合的弧，跨行那条就丢了
  //（1806《因着耶稣我最富有》末行 `6 5 6` 上那条本是倒数第二行 `6̣.1̇` 接下来的，识别成了
  //  `((6 5 6-))` 两条同罩三音的弧）。两头的形是可分的：
  //   · 上一行的**开口弧**右端顶到本行右界（末条小节线/终止线，实测 1333 对 1334.5）；
  //     行内正常收尾的弧离右界还差一个音（同首实测 1278/1066/1051）。
  //   · 下一行的**收口弧**左端起在首音**左缘之前**（实测 66 对 68）；行内起弧的那条从首音
  //     **质心**附近起笔（同行另一条弧的左脚在 80，首音质心 81），分得开。
  //   两条都满足才配对——单有一头（如同首第 3 行行末那条拖到右界的、下一行没有对应半弧）照旧
  //   留给行内判据与隐含 tie 兜底。
  const crossed = new Set<Component>();
  const coveredBy = (row: StaffRow, b: Rect) =>
    row.nums.filter((n) => between(rcx(n.bbox), b.x - numH * 0.5, rright(b) + numH * 0.5));
  for (let i = 0; i + 1 < rows.length; i++) {
    const row = rows[i], next = rows[i + 1];
    if (!row.nums.length || !next.nums.length) continue;
    const rowRight = Math.max(...row.barlineXs, ...row.nums.map((n) => rright(n.bbox)));
    const open = perRow[i].find((c) => rright(c.bbox) >= rowRight - numH * 0.3 && coveredBy(row, c.bbox).length);
    const head = perRow[i + 1].find((c) => c.bbox.x <= next.nums[0].bbox.x && coveredBy(next, c.bbox).length);
    if (!open || !head) continue;
    const start = coveredBy(row, open.bbox)[0];
    const stopList = coveredBy(next, head.bbox);
    probe("slur.crossRow");
    start.slurStart = (start.slurStart ?? 0) + 1;
    const stop = stopList[stopList.length - 1];
    stop.slurStop = (stop.slurStop ?? 0) + 1;
    crossed.add(open); crossed.add(head);
  }

  rows.forEach((row, ri) => {
    if (row.nums.length < 2) return;
    // 一个连通块里可能藏着几条弧（内弧与外弧交叠粘连），拆开逐条处理。
    // 内弧排在外弧之后：这样「起弧」的顺序是外→内，与 pairArcs 的栈式配对（后开先闭）对得上。
    // 已认作跨行半弧的整块不再拆内弧：续弧与同罩这几个音的行内弧收在同一只脚上、粘成一个连通块
    // （1806 末行实测 x66~230 一块），splitNestedArcs 分不出哪条是续弧的下半截，拆出来的两条会
    // 同起同止、变成一对重复的弧（旧输出 `((6 5 6-))`）。宁可只记跨行那条——**代价是同块里那条
    // 行内弧跟着丢**，但重复的弧会误导演奏，丢一条只是少个记号。
    for (const a of perRow[ri].filter((c) => !crossed.has(c)).flatMap((c) => splitNestedArcs(bin, c.bbox, numH))) {
      // 找弧线横向覆盖的音符（质心落在弧线 x 跨度内，左右各放宽 0.5 字号容端点偏移）。
      // 弧线常画在两音"符头之间"而非正压音符质心，左缘可比首音质心偏右半个字号
      //（实测基督更美行5 `(3_5_)`：弧 x129、首音 3 质心 114，差 15px≈0.3字号，0.3 容差差 0.6px 漏掉）。
      const covered = row.nums.filter((n) => between(rcx(n.bbox), a.x - numH * 0.5, rright(a) + numH * 0.5));
      if (covered.length < 2) continue;
      const start = covered[0], stop = covered[covered.length - 1];
      // tie：恰好相邻两音、且同音高(数字+八度相同)；否则按 slur。
      const sameIdx = row.nums.indexOf(start) + 1 === row.nums.indexOf(stop);
      const samePitch = start.digit === stop.digit && start.octave === stop.octave &&
        start.digit !== 0 && start.digit !== RHYTHM_DIGIT;
      if (covered.length === 2 && sameIdx && samePitch) {
        probe("tie");
        start.tieStart = true; stop.tieStop = true;
      } else {
        probe("slur");
        start.slurStart = (start.slurStart ?? 0) + 1;
        stop.slurStop = (stop.slurStop ?? 0) + 1;
      }
    }
  });
}
