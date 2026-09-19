// 判据命中计数：回归语料的**覆盖分析**用——哪首 GT 触发了哪条专门判据。
// 只在 `globalThis.__omrProbe` 是个对象时记（键 = 判据名，值 = 命中次数），默认关闭、零开销。
// 用法见私有仓库的 scripts/probe-coverage.mjs：逐首清零、识别、收计数，求最小集合覆盖。
// 加新判据时顺手在命中处 `probe("名字")`，以后精简 GT 才知道哪首是它唯一的看护。

export function probe(name: string): void {
  const p = (globalThis as { __omrProbe?: Record<string, number> }).__omrProbe;
  if (p) p[name] = (p[name] ?? 0) + 1;
}
