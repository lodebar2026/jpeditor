// 谱表**正上方的简谱行**（简线混排谱）：定位、认领、切条。
//
// 诗歌本的混排谱在每行五线谱正上方印一行简谱（数字、减时线、高低音点、增时线、
// 与五线谱**同 x** 的小节线），再往上才是和弦字母。位图路原先不知道这一行：
// 数字「0」「6」、增时线「–」落在谱表上方一两格，被收成全休止、加线上的符头
// ——实测《是谁》每行都多出两三个假音、假全休止；和弦字母又被简谱行隔在
// 和弦带窗口（顶线上方 1.0~3.2 格）之外，24 个一个没认。
//
// **判据是小节线对齐**，不看数字长什么样：简谱行的小节线是一截短竖线，
// 与谱表的小节线同 x（混排谱按小节对齐排版）。独唱谱、合唱谱的谱表上方
// 没有这种东西——那里的竖笔是符干（从谱表伸上来，不悬空）和字母笔画（短、不成排）。
// 对不上两条以上就当没有，这一段对别的底本是空转。
import type { Binary, Rect } from "../omr/types";
import type { LineSeg } from "./prims";
import type { RasterUnit } from "./staffline";

/** 简谱小节线的长度（线距的倍数）：《是谁》2.34 格；比谱表小节线（4 格）短得多。 */
const BAR_LEN = [1.2, 3.5] as const;
/** 简谱小节线的下端离谱表顶线至少多远（线距）：再近就是符干、符杠那一带。 */
const BAR_CLEAR = 0.5;
/** 往上最多找多远（线距）。 */
const BAR_REACH = 6;
/** 与谱表小节线的 x 容差（线距）。实测 2~10px / 线距 50。 */
const BAR_DX = 0.6;
/** 至少对上几条谱表小节线才算有简谱行。 */
const MIN_MATCH = 2;
/**
 * 带在小节线上下各放多少（线距）：上面要罩住高音点和圆滑线的弧顶
 * （《是谁》弧顶比小节线顶高 0.7 格），下面要罩住减时线与低音点（低 0.25 格）。
 * 下面放得少——再往下是往上的符杠（《是谁》第一行的符杠离小节线下端只有 0.4 格）。
 */
const PAD_TOP = 0.8;
const PAD_BOTTOM = 0.3;

/** 一条简谱行：它压在哪行谱上、带的盒、行内小节线的 x。 */
export interface JianpuBand {
  staff: number;
  box: Rect;
  bars: number[];
}

/** 定位各谱行上方的简谱行。`staves` 给每行谱的五线几何。 */
export function findJianpuBands(
  vSegs: LineSeg[],
  staves: { left: number; right: number; top: number; bottom: number }[],
  unit: RasterUnit,
): JianpuBand[] {
  const sp = unit.space;
  const out: JianpuBand[] = [];
  staves.forEach((st, k) => {
    const h = st.bottom - st.top;
    const span = (v: LineSeg) => [Math.min(v.y0, v.y1), Math.max(v.y0, v.y1)] as const;
    const cx = (v: LineSeg) => (v.x0 + v.x1) / 2;
    // 谱表小节线：纵贯五线
    const staffBars = vSegs
      .filter((v) => {
        const [a, b] = span(v);
        return a <= st.top + sp * 0.5 && b >= st.bottom - sp * 0.5 && b - a <= h + sp * 1.5;
      })
      .map(cx)
      .filter((x) => x > st.left + sp * 2 && x < st.right + sp);
    // 简谱行小节线候选：悬在谱表上方的短竖线
    const cands = vSegs.filter((v) => {
      const [a, b] = span(v);
      const len = (b - a) / sp;
      return len >= BAR_LEN[0] && len <= BAR_LEN[1] && b <= st.top - sp * BAR_CLEAR && b >= st.top - sp * BAR_REACH && cx(v) >= st.left - sp && cx(v) <= st.right + sp;
    });
    const matched = cands.filter((v) => staffBars.some((x) => Math.abs(cx(v) - x) <= sp * BAR_DX));
    if (matched.length < MIN_MATCH) return;
    // 带的纵向范围按对上的那几条定（行首那条可能是简谱行自己的起头线，不一定有谱表小节线对着）
    const ys = matched.map(span);
    const top = Math.min(...ys.map((s) => s[0]));
    const bot = Math.max(...ys.map((s) => s[1]));
    // 同一高度的其余短竖线（行首线）一并算作简谱行的小节线
    const bars = cands
      .filter((v) => {
        const [a, b] = span(v);
        return a <= bot && b >= top;
      })
      .map(cx)
      .sort((a, b) => a - b);
    const y0 = Math.round(top - sp * PAD_TOP);
    const y1 = Math.min(Math.round(bot + sp * PAD_BOTTOM), Math.round(st.top - sp * 0.2));
    out.push({ staff: k, box: { x: Math.round(st.left - sp), y: y0, w: Math.round(st.right - st.left + sp * 2), h: y1 - y0 }, bars });
  });
  return out;
}

/**
 * 把**整个落在带里**的连通块从各张图上抹掉（八连通），返回抹掉的像素数。
 *
 * 只抹整块在带里的：从谱表伸上来的符杠、符干，块的一部分在带外，原样留着
 * ——带的下沿离往上的符杠常常不到半格，按矩形一刀切会把符杠削掉。
 * `imgs` 里第一张用来判连通（有谱线的原图），后面几张按同样的像素一并抹。
 */
export function eraseInBand(imgs: Binary[], band: Rect): number {
  const bin = imgs[0];
  const x0 = Math.max(0, band.x);
  const y0 = Math.max(0, band.y);
  const x1 = Math.min(bin.w, band.x + band.w);
  const y1 = Math.min(bin.h, band.y + band.h);
  const W = x1 - x0;
  const seen = new Uint8Array(W * (y1 - y0));
  let erased = 0;
  const comp: number[] = [];
  const stack: number[] = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i0 = (y - y0) * W + (x - x0);
      if (seen[i0] || !bin.data[y * bin.w + x]) continue;
      // 灌一块；碰到带外的墨就记下「越界」，但带内的部分照灌完（免得同一块反复起灌）
      comp.length = 0;
      let out = false;
      seen[i0] = 1;
      stack.push(y * bin.w + x);
      while (stack.length) {
        const p = stack.pop()!;
        const py = Math.floor(p / bin.w);
        const px = p % bin.w;
        comp.push(p);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ny = py + dy;
            const nx = px + dx;
            if (ny < 0 || ny >= bin.h || nx < 0 || nx >= bin.w || !bin.data[ny * bin.w + nx]) continue;
            if (ny < y0 || ny >= y1 || nx < x0 || nx >= x1) {
              out = true;
              continue;
            }
            const j = (ny - y0) * W + (nx - x0);
            if (seen[j]) continue;
            seen[j] = 1;
            stack.push(ny * bin.w + nx);
          }
      }
      if (out) continue;
      for (const p of comp) for (const im of imgs) im.data[p] = 0;
      erased += comp.length;
    }
  return erased;
}

/** 简谱行的裸像素（抹掉之前取，`gen-rasterjianpu` 拿它离线认简谱）。 */
export interface JianpuStrip {
  staff: number;
  box: Rect;
  w: number;
  h: number;
  data: Uint8Array;
  bars: number[];
}

export function cutJianpuStrip(bin: Binary, band: JianpuBand): JianpuStrip {
  const { x, y, w, h } = band.box;
  const data = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++)
    for (let xx = 0; xx < w; xx++) {
      const sx = x + xx;
      const sy = y + yy;
      if (sx >= 0 && sy >= 0 && sx < bin.w && sy < bin.h) data[yy * w + xx] = bin.data[sy * bin.w + sx];
    }
  return { staff: band.staff, box: band.box, w, h, data, bars: band.bars };
}

/** 条的内容指纹（与 `harmonyKey` / `stripKey` 同一套）。 */
export function jianpuKey(s: JianpuStrip): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.data.length; i++) {
    h1 ^= s.data[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `J${s.w}x${s.h}-${h1.toString(36)}`;
}
