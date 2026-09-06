// **页内自举的符头判别器**：拿这一页自己的正负例现训一个逻辑回归。
//
// 与 `headmask.ts` 的分别是**有没有负例**。那边把已认出的符头平均成一张概率图，
// 只回答「像不像一个符头」；哪些东西**长得像符头但不是**（谱号的圈、休止的坨、
// 升降号的肚子、歌词字的转折、噪点结块）它一概没见过。于是那条尺子只能卡得很紧
// ——实测放松到能捞回被啃窄的符头时，假头也一起进来，`attachLyrics` 的音节整行错位
//（歌词是符头查准率的探针，见文档）。
//
// 这里补上负例：
//   - **正例**：`findRasterHeads` 收下的实心符头（那批长得端正、几乎没有假的）。
//   - **负例**：字典认成**别的**符号的块、切成歌词字格的块、以及带内谁都没认领的块。
//
// 特征只用**与尺度无关**的量（都按线距归一），换一本书、换一种分辨率照样成立。
// 训练是几十行梯度下降，一页几毫秒——不引任何库，也不落盘任何模型。
import type { Binary, Rect } from "../omr/types";
import type { RasterUnit } from "./staffline";
import { scoreAt, type HeadMask } from "./headmask";

/** 特征维数（见 `features`）。 */
const D = 7;
/** 梯度下降的轮数与步长；L2 正则。样本少的时候正则救命。 */
const ITERS = 200;
const LR = 0.5;
const L2 = 0.01;
/** 正负例各要有这么多才训——太少的模型还不如那条固定的尺子。 */
const MIN_POS = 30;
const MIN_NEG = 30;

export interface HeadClassifier {
  w: Float64Array;
  b: number;
  /** 训练用的均值与标准差（推理时要用同一套标准化）。 */
  mu: Float64Array;
  sd: Float64Array;
  nPos: number;
  nNeg: number;
}

/**
 * 一个候选盒的特征。全部按线距归一，与分辨率无关。
 *
 *  0 模板得分（`headmask.ts::scoreAt`，骑线/在间各用各的模板）
 *  1 填充率
 *  2 宽（格）
 *  3 高（格）
 *  4 宽高比
 *  5 **左右墨量差**：符头是左右对称的椭圆；谱号、休止、升降号多半偏一侧
 *  6 **行墨的尖锐度**（最大行墨 / 平均行墨）：实心椭圆接近 1.3，
 *    空心的圈、带细笔画的符号会顶得很高
 */
function features(bin: Binary, masks: HeadMask[], unit: RasterUnit, box: Rect, cy: number, onLine: boolean): Float64Array {
  const sp = unit.space;
  const f = new Float64Array(D);
  const m = masks.find((k) => k.onLine === onLine) ?? masks[0];
  f[0] = m ? scoreAt(bin, m, box.x + box.w / 2, cy) : 0;
  let ink = 0;
  let left = 0;
  let right = 0;
  const rows = new Float64Array(Math.max(1, box.h));
  const half = box.x + box.w / 2;
  for (let y = 0; y < box.h; y++) {
    const sy = box.y + y;
    if (sy < 0 || sy >= bin.h) continue;
    for (let x = 0; x < box.w; x++) {
      const sx = box.x + x;
      if (sx < 0 || sx >= bin.w || !bin.data[sy * bin.w + sx]) continue;
      ink++;
      rows[y]++;
      if (sx < half) left++;
      else right++;
    }
  }
  const area = Math.max(1, box.w * box.h);
  f[1] = ink / area;
  f[2] = box.w / sp;
  f[3] = box.h / sp;
  f[4] = box.w / Math.max(1, box.h);
  f[5] = ink ? Math.abs(left - right) / ink : 1;
  let mx = 0;
  for (let y = 0; y < rows.length; y++) mx = Math.max(mx, rows[y]);
  f[6] = ink ? mx / (ink / rows.length) : 0;
  return f;
}

/**
 * 现训一个判别器。正负例都给盒；`gridY` 把中心吸到音高格上（与识别同口径）。
 * 正负例任一边太少就返回 null——那时不如不用（调用方退回原来的判据）。
 */
export function trainHeadClassifier(
  bin: Binary,
  masks: HeadMask[],
  unit: RasterUnit,
  onLine: (y: number) => boolean,
  pos: Rect[],
  neg: Rect[],
): HeadClassifier | null {
  if (pos.length < MIN_POS || neg.length < MIN_NEG || !masks.length) return null;
  const X: Float64Array[] = [];
  const y: number[] = [];
  const push = (box: Rect, label: number) => {
    const cy = box.y + box.h / 2;
    X.push(features(bin, masks, unit, box, cy, onLine(cy)));
    y.push(label);
  };
  for (const b of pos) push(b, 1);
  for (const b of neg) push(b, 0);
  // 标准化：各维减均值除标准差，否则「格」与「得分」量纲差一个数量级，梯度全被一维吃掉
  const mu = new Float64Array(D);
  const sd = new Float64Array(D);
  for (const x of X) for (let d = 0; d < D; d++) mu[d] += x[d];
  for (let d = 0; d < D; d++) mu[d] /= X.length;
  for (const x of X) for (let d = 0; d < D; d++) sd[d] += (x[d] - mu[d]) ** 2;
  for (let d = 0; d < D; d++) sd[d] = Math.sqrt(sd[d] / X.length) || 1;
  for (const x of X) for (let d = 0; d < D; d++) x[d] = (x[d] - mu[d]) / sd[d];
  // **正负例按数量配平**：负例往往多得多，不配平的话模型学成「一律判否」
  const wPos = X.length / (2 * pos.length);
  const wNeg = X.length / (2 * neg.length);
  const w = new Float64Array(D);
  let b = 0;
  for (let it = 0; it < ITERS; it++) {
    const gw = new Float64Array(D);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let d = 0; d < D; d++) z += w[d] * X[i][d];
      const p = 1 / (1 + Math.exp(-z));
      const e = (p - y[i]) * (y[i] ? wPos : wNeg);
      for (let d = 0; d < D; d++) gw[d] += e * X[i][d];
      gb += e;
    }
    for (let d = 0; d < D; d++) w[d] -= (LR * (gw[d] / X.length + L2 * w[d]));
    b -= LR * (gb / X.length);
  }
  return { w, b, mu, sd, nPos: pos.length, nNeg: neg.length };
}

/** 判一个盒是不是符头，返回 0~1 的概率。 */
export function headProb(
  clf: HeadClassifier,
  bin: Binary,
  masks: HeadMask[],
  unit: RasterUnit,
  box: Rect,
  cy: number,
  onLine: boolean,
): number {
  const f = features(bin, masks, unit, box, cy, onLine);
  let z = clf.b;
  for (let d = 0; d < D; d++) z += clf.w[d] * ((f[d] - clf.mu[d]) / clf.sd[d]);
  return 1 / (1 + Math.exp(-z));
}
