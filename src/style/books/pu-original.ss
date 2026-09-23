/* 文本谱等原样档（src/layout/original/compose.ts）。
 *
 * 页头（标题、Z 词曲、TL/TR、XL/XR、调号拍号、J 速度文字）仍由 compose.ts::paintHeader 画——
 * 那一套的落位是逐项对原版渲染实测的（PuMetrics），先不迁；这里只管原先**没画**的页脚：
 * BL / BC / BR（语料里 BL 常写 `-` 占位，视为空）。区域顶在本曲末页最低一行歌词/数字之下一个歌词字高处。
 * 字号取 PuMetrics.topTextSize（与 TL/TR 同档）。语法见 docs/格式/ss.md。 */

@template song-foot {
  flow: block;
  align-x: content;
  line-height: 1.35em;
  row { left: "{pageText.bottomLeft | dash-empty | lines}" as note; }
  row(gap-before: 4) { center: "{pageText.bottomCenter | dash-empty | lines}" as note; }
  row(gap-before: 4) { right: "{pageText.bottomRight | dash-empty | lines}" as note; }
}
