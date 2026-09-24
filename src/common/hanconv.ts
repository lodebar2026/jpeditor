// 简繁转换的词表：opencc-js，按方向分别动态 import（首屏不加载；t2cn 约 100KB，cn2t 约 1MB）。
// 转什么、怎么写回原文在 `model/hanconv.ts`（以 ScoreDoc 为准，各格式通用）。

export type HanDirection = "s2t" | "t2s";

export type HanConv = (text: string) => string;

let s2tPromise: Promise<HanConv> | null = null;
let t2sPromise: Promise<HanConv> | null = null;

/** 取（并缓存）某个方向的转换器；首次调用时才拉对应词表 chunk。 */
export function loadConverter(dir: HanDirection): Promise<HanConv> {
  if (dir === "s2t") {
    s2tPromise ??= import("opencc-js/cn2t").then((cc) => cc.Converter({ from: "cn", to: "tw" }));
    return s2tPromise;
  }
  t2sPromise ??= import("opencc-js/t2cn").then((cc) => cc.Converter({ from: "tw", to: "cn" }));
  return t2sPromise;
}
