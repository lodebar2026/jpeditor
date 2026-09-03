// GT 字符序列 ↔ 页面字形序列的对齐。
//
// 出处：本来长在 scripts/gen-glyphdict.mjs 里（字形自举的核心），抽出来给 scripts/gen-backfill.mjs 共用——
// 两边必须是**同一套判据**，否则「建库时认的字」和「重排时补的字」会打架。
//
// 无 DOM 依赖。
export interface AlignPair {
  /** GT 串里的下标 */
  i: number;
  /** 页面序列里的下标 */
  j: number;
}

export interface AlignResult {
  pairs: AlignPair[];
  /** 长度完全相等、且已识字大体对得上 —— 无歧义直配，一次就能定案。
   *  标题尤其依赖这条：一首一个标题、字几乎不重复，靠 DP 投票永远凑不够票数
   *  （实测只靠 DP 时标题准确率卡在 73%）。 */
  direct: boolean;
}

export interface AlignOptions {
  /** 空位罚分。 */
  gap?: number;
  /** 已知形状且字符相同 / 不同的分值。 */
  hit?: number;
  miss?: number;
  /** 未知形状（读不出的字）的中性偏正分：让它更倾向于落在对应的 GT 字符上，从而被标出来。 */
  wild?: number;
  /** 直配所需的「已识字命中率」下限。 */
  directMinHit?: number;
  /** 长度差超过 max(absTol, min(n,m) × relTol) 就认为整条错位，不对齐。 */
  absTol?: number;
  relTol?: number;
}

const DEFAULTS: Required<AlignOptions> = {
  gap: -1.2,
  hit: 2,
  miss: -1.5,
  wild: 0.6,
  directMinHit: 0.6,
  absTol: 8,
  relTol: 0.4,
};

/**
 * @param gt  GT 字符串
 * @param dec 页面字形序列翻出来的字符（读不出的位置给 null）
 * @returns   对不上（长度差太大 / 空序列）时返回 null
 */
export function alignSeq(gt: string, dec: readonly (string | null)[], opt: AlignOptions = {}): AlignResult | null {
  const o = { ...DEFAULTS, ...opt };
  const n = gt.length;
  const m = dec.length;
  if (!n || !m || Math.abs(n - m) > Math.max(o.absTol, Math.min(n, m) * o.relTol)) return null;

  if (n === m) {
    let known = 0;
    let ok = 0;
    for (let t = 0; t < m; t++) {
      if (dec[t] !== null) {
        known++;
        if (dec[t] === gt[t]) ok++;
      }
    }
    // 前提是这条序列里**已经认识的字**大体对得上，否则说明整条是错位的，不能信。
    if (known === 0 || ok / known >= o.directMinHit) {
      return { pairs: Array.from({ length: m }, (_, t) => ({ i: t, j: t })), direct: true };
    }
  }

  const score = (i: number, j: number): number => {
    const c = dec[j];
    if (c === null) return o.wild;
    return c === gt[i] ? o.hit : o.miss;
  };
  // 用普通数组存：Float32Array 会把双精度加法的结果截断，回溯时的等值比较就永远不成立。
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = i * o.gap;
  for (let j = 1; j <= m; j++) dp[0][j] = j * o.gap;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.max(dp[i - 1][j - 1] + score(i - 1, j - 1), dp[i - 1][j] + o.gap, dp[i][j - 1] + o.gap);
    }
  }
  const pairs: AlignPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (dp[i][j] === dp[i - 1][j - 1] + score(i - 1, j - 1)) {
      pairs.push({ i: i - 1, j: j - 1 });
      i--;
      j--;
    } else if (dp[i][j] === dp[i - 1][j] + o.gap) i--;
    else j--;
  }
  pairs.reverse();
  return { pairs, direct: false };
}
