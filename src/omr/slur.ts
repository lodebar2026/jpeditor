// 圆滑线 / 连音线识别（音符上方的弧形 ⌒）。
// 简谱里弧线画在数字**正上方**、横跨 2~3 个相邻音符：圆滑线(slur，跨不同音高)用于一字多音/乐句，
// 连音线(tie，跨相邻同音高)用于延音。两者视觉相同，唯一可分的判据是端点音高是否相等。
//
// 几何特征（与八度点/增时线/减时线区分）：
//   - 弧线是「宽而薄」的连通块：w ≳ 0.8×字号、w/h ≥ 2，落在数字行**上方**（底边贴近数字顶）。
//   - 八度上点很小(w,h ≤ 0.45×字号)；增时线 '-' 在数字**中线**、减时线在数字**下方** → 都不在上方，天然不混。
//   - 数字块 h ≥ 0.55×字号 才算，弧线更矮 → 不会被当成假音符（classify 里已落到 hlines 或被丢弃）。
import type { Binary, Component, Rect, StaffRow } from "./types";
import { rright, rbottom, rcx } from "./types";
import { median } from "./geom";

const between = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

/**
 * 一个弧连通块里**套着的第二条弧**：两条弧共用一个端点（外弧罩三音、内弧只罩后两音）时，
 * 内弧的收尾一段与外弧交叠、被 4-连通粘成同一个块，包围盒只剩外弧那一条。
 * 「2146 奉献的心志在燃烧」第 1 行 `2 3 2` 上就是这样一对，内弧整条被吞。
 *
 * 判据：逐列数竖向墨段。单条弧每列只有一段；两条弧交叠的那一段 x 里每列有**上下两段**
 * （上=外弧、下=内弧，内弧必在外弧之下——它跨得窄、拱得低）。取下面那一段拼出内弧包围盒。
 *
 * 两头的处理：内弧在交点处**并进**外弧（两段的竖向间隙缩到笔画粗细内）而非在空中断掉，
 * 说明它的余下一截与外弧重合、真正的端点在外弧那一头 → 该侧延到母块边缘；否则就此打住。
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
  // 双段区间：允许中间断一两列（笔画交叠处两段会短暂并成一段）。
  let lo = -1, hi = -1, gap = 0;
  const cols = new Map<number, Array<[number, number]>>();
  for (let x = a.x; x < x1; x++) {
    const r = runsAt(x);
    cols.set(x, r);
    if (r.length >= 2) { if (lo < 0) lo = x; hi = x; gap = 0; }
    else if (lo >= 0 && ++gap > 2 && hi - lo >= numH * 0.8) break; // 已够长，后面的不要了
  }
  if (lo < 0 || hi - lo < numH * 0.8) return [a]; // 没有够长的双段区间 → 就一条弧
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
  if (!smooth || cnt < (hi - lo + 1) * 0.8) return [a];
  if (thick > numH * 0.3) return [a];
  // **得像条弧**：下面那一段要有拱高（顶边高低差 ≥ 0.15 字号）。这一条挡住的是「弧 + 一条
  // 横线粘成一块」——减时线/增时线/三连音括线都是笔直的，顶边一路平着走，照收就会凭空
  // 多出一条弧（实测「主祢真伟大」「我说算了吧」各误加数条）。
  if (rise < Math.max(3, numH * 0.15)) return [a];
  // 端点在交点处并入外弧 → 该侧延到母块边缘（重合的那一截看不出来，但弧确实画到了那里）。
  const mergedAt = (x: number): boolean => {
    const r = cols.get(x);
    if (!r || r.length < 2) return false;
    return r[r.length - 1][0] - r[r.length - 2][1] <= Math.max(3, numH * 0.12);
  };
  // 两条弧本是一个连通块，必是在某处相交；相交点不在双段区间的两头，说明它们粘的是别的东西
  //（弧压着下面的横线之类），不是一对交叠的弧。
  if (!mergedAt(lo) && !mergedAt(hi)) return [a];
  if (mergedAt(lo)) { ix0 = a.x; iy1 = y1 - 1; }
  if (mergedAt(hi)) { ix1 = x1 - 1; iy1 = y1 - 1; }
  const inner: Rect = { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 };
  if (inner.w >= a.w * 0.95) return [a]; // 与母块同宽 → 没分出新东西
  return [a, inner];
}

/** 在 comps 里为每个 staff 行检测上方弧线，置位音符的 slurStart/Stop 或 tieStart/Stop。 */
export function detectSlurs(bin: Binary, comps: Component[], rows: StaffRow[], numH: number): void {
  for (const row of rows) {
    if (row.nums.length < 2) continue;
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
      if (b.w >= numH * 6 && b.w / b.h >= 12) return false;
      // 弧高上限放到 ~1 字号：跨相邻两音的弧其拱高可达一个字号（实测耶稣普治 w130 h32、numH39，
      // 卡在旧的 0.8 字号=31 上被整条漏掉）；仍 < 数字块高(≥0.55~2 字号且 w/h<2)，靠 w/h≥2 兜住不误纳数字。
      // 跨多音的**长弧**拱得更高（实测「主祢真伟大」跨 `5__|5---|5` 的 tie：w205 h28、numH22，
      // 卡 1.05 字号=23 被整条漏掉 → 副歌首音丢了 tie 延续），故 h 上限随跨度放宽到 1.6 字号；
      // 但放宽后段落方框（"Chorus" 带框 w98 h36）也会挤进来，故**高过 1.05 字号的块另要求 w/h≥4**
      // ——弧越长越扁（7.3），方框接近方正（2.7）。
      const maxH = b.w > numH * 3 ? numH * 1.6 : numH * 1.05;
      if (b.w < numH * 0.8 || b.h < 2 || b.h > maxH) return false;
      // 扁平度下限 1.8（原为 2）：跨度只有一个字号的短弧拱得相对更高——714《我说算了吧》
      // 第 1 行 `1̇ (5̇ 3̇)` 那条实测 38×20 = 1.9，卡在 2 上被整条漏掉。数字块是「高而窄」
      // （w/h≈0.67）、减时线与增时线又都不在上方带里，放到 1.8 不会把它们放进来。
      if (b.w / b.h < (b.h > numH * 1.05 ? 4 : 1.8)) return false;
      // 底边落在 [数字顶 - 1.2字号, 数字顶 + 0.25字号]：即整体在数字上方、最多略压数字顶缘。
      return between(rbottom(b), rowTop - numH * 1.2, rowTop + numH * 0.25);
    });

    // 一个连通块里可能藏着两条弧（内弧与外弧交叠粘连），拆开逐条处理。
    // 内弧排在外弧之后：这样「起弧」的顺序是外→内，与 pairArcs 的栈式配对（后开先闭）对得上。
    for (const a of arcs.flatMap((c) => splitNestedArcs(bin, c.bbox, numH))) {
      // 找弧线横向覆盖的音符（质心落在弧线 x 跨度内，左右各放宽 0.5 字号容端点偏移）。
      // 弧线常画在两音"符头之间"而非正压音符质心，左缘可比首音质心偏右半个字号
      //（实测基督更美行5 `(3_5_)`：弧 x129、首音 3 质心 114，差 15px≈0.3字号，0.3 容差差 0.6px 漏掉）。
      const covered = row.nums.filter((n) => between(rcx(n.bbox), a.x - numH * 0.5, rright(a) + numH * 0.5));
      if (covered.length < 2) continue;
      const start = covered[0], stop = covered[covered.length - 1];
      // tie：恰好相邻两音、且同音高(数字+八度相同)；否则按 slur。
      const sameIdx = row.nums.indexOf(start) + 1 === row.nums.indexOf(stop);
      const samePitch = start.digit === stop.digit && start.octave === stop.octave && start.digit !== 0;
      if (covered.length === 2 && sameIdx && samePitch) {
        start.tieStart = true; stop.tieStop = true;
      } else {
        start.slurStart = (start.slurStart ?? 0) + 1;
        stop.slurStop = (stop.slurStop ?? 0) + 1;
      }
    }
  }
}
