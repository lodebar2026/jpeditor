// Node 侧的标点挤压（CLREQ）。规则本身在 src/common/cjkpunct.ts——**全仓唯一一份**，
// 这里只负责把它接到 fontkit 的度量上，让 PDF 落字与浏览器排版是同一个口径。
//
// 两条路，与 common/measure.ts::punctTrim 一一对应：
//   字体带 `chws`（CJK 上下文半角）→ 以字体的账为准，量 `w(a)+w(b)−w(ab)`；
//   不带 → 按 cjkpunct 的规则折算（相邻标点之间只留半个字宽）。
import { loadCli } from "./node-harness.mjs";

let rulesPromise = null;

/** cjkpunct 的规则（走 dist-cli，改了规则要重跑 `npm run build:cli`）。 */
export function punctRules() {
  if (!rulesPromise)
    rulesPromise = loadCli().then((m) => ({
      pairTrim: m.pairTrim,
      pairTrimIn: m.pairTrimIn,
      compressRun: m.compressRun,
      pairTrimPx: m.pairTrimPx,
    }));
  return rulesPromise;
}

/** 全书的挤压档：**一律半身**（开明式）。歌词与书级正文同一个口径。 */
export const BOOK_MODE = "halfwidth";

const featCache = new WeakMap();
function hasFeat(metric, feat) {
  if (!metric) return false;
  let m = featCache.get(metric);
  if (!m) featCache.set(metric, (m = new Map()));
  const hit = m.get(feat);
  if (hit !== undefined) return hit;
  let res = false;
  try {
    res = !!metric.availableFeatures?.includes(feat);
  } catch {
    res = false;
  }
  m.set(feat, res);
  return res;
}

/** 挤压档 → OpenType 特性（与 src/common/measure.ts::featuresFor 同一张表）。 */
const FEATURE_OF = { clreq: "chws", halfwidth: "halt", none: null };

/**
 * 造一个「相邻两个字之间该压掉多少 pt」的函数。
 * `pairTrimPx` 由 `punctRules()` 给；调用时传的 `slack` 是「一个字两侧的实际留白」，
 * 挤压量拿它封顶——只压空白不压墨。
 * `metric` 是 fontkit 的 face（两个字不同字体时传后一个的）。
 * `mode` 是挤压档，见 src/common/cjkpunct.ts。
 */
export function makeTrim(pairTrimPx) {
  return (metric, prev, next, size, mode = "clreq", slack) => {
    if (!prev || !next || mode === "none") return 0;
    const feat = FEATURE_OF[mode];
    if (feat && metric && hasFeat(metric, feat)) {
      const upem = metric.unitsPerEm || 1000;
      const w = (t, f) => {
        try {
          return (metric.layout(t, f).advanceWidth / upem) * size;
        } catch {
          return 0;
        }
      };
      const trim = w(prev) + w(next) - w(prev + next, [feat]);
      if (Number.isFinite(trim)) return Math.max(0, trim);
    }
    return pairTrimPx(mode, prev, next, size, slack);
  };
}
