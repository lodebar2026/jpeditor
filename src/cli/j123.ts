// Node CLI 侧的 123 格式入口：`.123` 文本 ↔ `ScoreDoc` ↔ 其它格式，**不起浏览器**。
// 由 `npm run build:cli` 打成 dist-cli/j123.js，供 scripts/j123-*.mjs import。
//
// 与另两个入口的分工：`cli/index.ts` 是矢量 PDF 版面那一摊、`cli/omr.ts` 是位图简谱识别，
// 这个是**格式与语义模型**这一条。
//
// **只能汇出不碰 DOM 的模块**——排版件（依赖 common/measure.ts 的那些）一律不许进这条链，
// 所以这里没有 PuPainter / layout。需要排版的回归走 scripts/harness.mjs 起浏览器那条路。
export * from "../model/doc";
export * from "../j123/lex";
export * from "../j123/parse";
export * from "../j123/emit";
export { emitAbc } from "../abcfamily/emitabc.entry";
export * from "../model/capability";
export * from "../j123/fields";
export * from "../model/helpers";
export * from "../model/metakeys";
export { replaceMetaLines } from "../j123/metaedit";
export { docView } from "../pu/slots";
export { puToScoreDoc } from "../model/frompu";
export { jpwToScoreDoc } from "../model/fromjpw";
export { scoreDocToMusicXml } from "../model/toxml";
export { emitJpwabc, writeJpwabc } from "../model/tojpw";
export { emitPu, emitPuSong, keyNameOf, puArcLosses } from "../model/topu";
export { projectForJianpu } from "../model/jianpuproject";
// 文本谱与 `.jpwabc` 读入：迁移工具要拿它们当输入
export { parsePu, parsePuAst, sniffDialect } from "../pu";
export { JpwFile, RepeatSection } from "../jpword/jpwfile";
// 按乐句重排（写回原文那一步；断句本身在 score/phrase.ts）
export { relayoutDocBreaks, relayoutJpwabcText, spliceComments } from "../model/relayout";
export { phraseCuts, puPhraseLines } from "../pu/phrase";
