/* 原样文档布局（src/layout/original/：文本谱、MusicXML、多声部 123/ABC 的原样档）的公共底表。
 *
 * 度量不在这里写：出厂值（番茄方言）是 `layout/original/metrics.ts::JIANPU_DEFAULTS`，
 * 诗歌本方言的差异在叠加表 original-shige.ss（MusicXML 与多声部 123/ABC 也吃那一份）。
 *
 * 这里只有页脚：BL / BC / BR（语料里 BL 常写 `-` 占位，视为空）。区域顶在本曲末页最低一行歌词/数字之下
 * 一个歌词字高处，字号按 `as 角色` 取 `JianpuMetrics.size` 的同名字段（`header` 与 TL/TR 同档）。页头仍由 compose.ts::paintHeader 画（落位是逐项实测的）。
 * 语法见 docs/格式/ss.md。 */

@template song-foot {
  flow: block;
  align-x: content;
  line-height: 1.35em;
  row { left: "{pageText.bottomLeft | dash-empty | lines-trim}" as header; }
  row(gap-before: 4) { center: "{pageText.bottomCenter | dash-empty | lines-trim}" as header; }
  row(gap-before: 4) { right: "{pageText.bottomRight | dash-empty | lines-trim}" as header; }
}
