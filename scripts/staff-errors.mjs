// 五线谱识别 ↔ GT 对拍之后的**错误清单与错因归类**，两条路（矢量 `staff-diff.mjs`、
// 位图 `chorus-diff.mjs`）与诊断报告（`gen-staff-analysis.mjs`）共用一份。
//
// 与 `staff-metrics.mjs` 的分工：那边是**准确率**的判据（acc / 移调 / 移八度），
// 这边是**错在哪、为什么错**。两边都只写一处——同一处错在两个脚本里给出不同的
// 归类，排行榜就没法看了。
//
// 纯函数，不读文件、不起浏览器。
/**
 * 逐音对齐后**逐个错误**的清单（`--errors`）：类型、GT 与识别各是什么、
 * 级差、以及那个音在页面上的盒。归因不靠猜——盒在手上，可以直接裁图核对。
 */
export function errorList(A, B, src, opts = {}) {
  // 错因文案可换：音符按级差归类（默认 `whyStep`），歌词没有级差可言，
  // 换一套「字不同 / 多字 / 少字」。对齐算法两边共用同一条，别各写各的。
  const wSub = opts.whySub ?? whyStep;
  const wIns = opts.whyIns ?? ((got) => (got === "R" ? "多出休止" : "多出音符"));
  const wDel = opts.whyDel ?? ((gt) => (gt === "R" ? "漏休止" : "漏音符"));
  const a = A, b = B;
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  const op = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(""));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const c = [[d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), "m"], [d[i - 1][j] + 1, "x"], [d[i][j - 1] + 1, "n"]].sort((p1, p2) => p1[0] - p2[0])[0];
      d[i][j] = c[0];
      op[i][j] = c[1];
    }
  const dia = (p) => (p === "R" ? null : "CDEFGAB".indexOf(p[0]) + 7 * Number(p.slice(1)));
  const out = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    const o = i > 0 && j > 0 ? op[i][j] : i > 0 ? "x" : "n";
    if (o === "m") {
      if (a[i - 1] !== b[j - 1]) {
        const [g, ex] = [dia(a[i - 1]), dia(b[j - 1])];
        const step = g == null || ex == null ? null : g - ex;
        out.push({ kind: "读错", got: a[i - 1], gt: b[j - 1], step, why: wSub(a[i - 1], b[j - 1], step), at: j - 1, src: src?.[i - 1] ?? null });
      }
      i--; j--;
    } else if (o === "x") {
      out.push({ kind: "多出", got: a[i - 1], gt: null, step: null, why: wIns(a[i - 1]), at: j, src: src?.[i - 1] ?? null });
      i--;
    } else {
      // 漏掉的音没有盒，但它**夹在两个认出来的音之间**——把左右邻居的盒记下来，
      // 那一段页面就定位得到（`raster-gap.mjs` 拿它去问账本：那里的墨归了谁）。
      out.push({
        kind: "漏掉", got: null, gt: b[j - 1], step: null,
        why: wDel(b[j - 1]), at: j - 1, src: null,
        prev: src?.[i - 1] ?? null, next: src?.[i] ?? null,
      });
      j--;
    }
  }
  return out.reverse();
}

/** 级差 → 错因大类。散着的归「未分类」，那些才要人去裁图看。 */
export function whyStep(got, gt, step) {
  if (got === "R") return "音→休（读成休止）";
  if (gt === "R") return "休→音（休止读成音）";
  if (step === null) return "未分类";
  const s = Math.abs(step);
  if (s % 7 === 0) return `八度错 ${step > 0 ? "+" : "-"}${s / 7}`;
  if (s === 1) return "吸错一格";
  if (s === 2) return "差一线（两格）";
  return "未分类";
}

/** 逐音对齐后的错型统计。 */
export function errKinds(A, B) {
  const a = A, b = B;
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  const op = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(""));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const c = [[d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), "m"], [d[i - 1][j] + 1, "x"], [d[i][j - 1] + 1, "n"]].sort((p1, p2) => p1[0] - p2[0])[0];
      d[i][j] = c[0];
      op[i][j] = c[1];
    }
  let i = a.length, j = b.length;
  // `steps`：读错的那些音**差几个音级**（GT → 识别，全音阶级差，休止另计）。
  // 光看「读错多少个」看不出该改哪儿：整条差 +2 是谱号错，±1 是线间吸错格，
  // ±7 是八度点/加线，散得没形状才是符头本身没找准。
  const t = { eq: 0, sub: 0, del: 0, ins: 0, steps: new Map() };
  const dia = (p) => (p === "R" ? null : "CDEFGAB".indexOf(p[0]) + 7 * Number(p.slice(1)));
  while (i > 0 || j > 0) {
    const o = i > 0 && j > 0 ? op[i][j] : i > 0 ? "x" : "n";
    if (o === "m") {
      if (a[i - 1] === b[j - 1]) t.eq++;
      else {
        t.sub++;
        const [g, e] = [dia(a[i - 1]), dia(b[j - 1])];
        const k = g == null || e == null ? (a[i - 1] === "R" ? "音→休" : "休→音") : g - e;
        t.steps.set(k, (t.steps.get(k) ?? 0) + 1);
      }
      i--; j--;
    }
    else if (o === "x") { t.ins++; i--; }
    else { t.del++; j--; }
  }
  return t;
}

/**
 * 漏掉的那个音**该在哪一段**：左右邻居之间那一块，纵向取谱行带
 * （用邻居盒的并集再放宽一格半）。两条路共用——矢量路没有认领账本，
 * 但「该在哪儿」这件事与账本无关。
 */
export function gapBoxOf(prev, next, sp) {
  return {
    x0: Math.min(prev.right, next.left) - sp * 0.3,
    x1: Math.max(prev.right, next.left) + sp * 0.3,
    y0: Math.min(prev.top, next.top) - sp * 1.5,
    y1: Math.max(prev.bottom, next.bottom) + sp * 1.5,
  };
}

/**
 * 一处**漏音**的病因（`raster-gap.mjs` 与诊断报告共用）：那团墨归了谁。
 *
 * 漏掉的音没有盒，但它夹在两个认出来的音之间——`errorList` 把左右邻居的盒记了下来，
 * 于是那一段页面定位得到。这里把那一段的墨翻出来，问 `ContourLedger`：这团墨被谁认领了？
 * 是**认成了别的符号**（字典/谱号/休止），是**当成原语抹掉了**（谱线/符干/符杠），
 * 还是**根本没人看见**？三种病因三种药，别混着猜。
 *
 * @param r  一页的 `recognizeRasterPage` 结果（要有 `contours` / `ledger` / `unit`）
 * @param g  一条 `errorList` 出的漏音（要有 `prev.box` / `next.box`）
 * @returns  `{ size, box }`，认得出那团墨时还带 `contour` / `claims` / `w` / `h`（单位：格）。
 *           `size` 就是给人看的判语，也是错因排行的键。
 */
export function blameGap(r, g) {
  const a = g.prev.box, b = g.next.box;
  const sp = r.unit.space;
  const box = gapBoxOf(a, b, sp);
  const { x0, x1, y0, y1 } = box;
  if (x1 - x0 < 2) return { size: "缺口为零（两邻居贴着，多半是对齐错位而非真漏）", box };
  // 这一段里有没有墨
  let any = false;
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(r.contours.h, Math.round(y1)) && !any; y++)
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(r.contours.w, Math.round(x1)); x++)
      if (r.contours.labels[y * r.contours.w + x]) { any = true; break; }
  if (!any) return { size: "缺口里没有墨（那个音**不在纸上**，多半是 GT 与谱面不符）", box };
  // **缺口里最大的那团墨有多大**：单头装得下的（≤1.85×1.35 格）说明那个音
  // 本来是独立的一块、只是没被收；大到 `splitHeadCluster` 的闸外（>6×4 格）
  // 说明它**焊进了一大团**（符杠 + 几根符干 + 几个头），拆块那条路根本够不着。
  // **取缺口中点那一团**，不取面积最大的——最大的往往是谱线本身，会把结论带偏。
  // 中点没有墨就在 ±1 格里找最近的一团。
  const mx = Math.round((x0 + x1) / 2);
  const my = Math.round(((a.top + a.bottom) / 2 + (b.top + b.bottom) / 2) / 2);
  let big = null;
  outer: for (let rr = 0; rr <= Math.round(sp); rr++)
    for (let dy = -rr; dy <= rr; dy++)
      for (let dx = -rr; dx <= rr; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rr) continue;
        const yy = my + dy, xx = mx + dx;
        if (yy < 0 || xx < 0 || yy >= r.contours.h || xx >= r.contours.w) continue;
        const id = r.contours.labels[yy * r.contours.w + xx];
        if (!id) continue;
        big = r.contours.byId.get(id) ?? null;
        if (big) break outer;
      }
  if (!big) return { size: "缺口中点附近没有墨", box };
  const w = big.bbox.w / sp, h = big.bbox.h / sp;
  const claims = r.ledger.claimsOf(big.id).map((z) => z.by.split(":")[0]);
  // 分档按**当前**的闸走（`headmask.ts::CLUSTER_W/H` 现在是 6×4 格），
  // 这样报表直接回答「够不够得着」，不必再心算。
  const size = w > 6 || h > 4
    ? "**拆块闸外**（>6×4 格）"
    : w > 1.85 || h > 1.35
      ? "拆块闸内、却没拆出来"
      : "单头大小、却没人收";
  return { size, box, contour: big, claims, w, h };
}

/** 歌词的错因文案（没有级差可言，只分「字不同 / 多字 / 少字」）。 */
export const LYRIC_WHY = {
  whySub: () => "歌词字不同",
  whyIns: () => "歌词多字",
  whyDel: () => "歌词少字",
};
