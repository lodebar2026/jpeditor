// 文本谱（番茄简谱 / 「有谱」）的对外入口。

export { sniffDialect, dialectSpec, DIALECTS, type Dialect, type DialectSpec } from "./dialect";
export { parsePu, parseMusicLine, parseLyricBody, type ParseOptions } from "./parse";
export { eachNote, eachNoteInElements, emptyMetadata, primaryMetadata } from "./ast";
export { PuPainter } from "./painter";
// 过渡件：阶段 3 前的旧 painter，只给 scripts/pu-painter-dual.mjs 双跑对照。阶段 4 删
export { LegacyPuPainter } from "./painter.legacy";
export { puToScore, scoreDocToScore, type ToScoreOptions, type ScoreDocToScoreOptions } from "./toscore";
export { relayoutPuText } from "./relayout";
export { puPhraseLines, type PuNewLine } from "./phrase";
// 展开档应有几遍（两种格式共用的判据；回归脚本经 window.__pu 取用）
export { countPasses } from "../jianpu/expand";
export { puToMusicXml, textScoreToMusicXml, type ToXmlOptions } from "./toxml";
export { docView, scoreDocToPu, type DocView, type SongView, type RowView, type SlotRef } from "./slots";
export { puToScoreDoc } from "../model/frompu";
export { layoutDocument, layoutSong, elementBeats } from "./layout";
export { metricsFor, contentWidth, contentHeight, type PuMetrics } from "./metrics";
export type { PlacedItem, PlacedPage, PlacedScore, PlacedVoice, PlacedGroup } from "./layout";
export type {
  Accidental,
  BarlineElement,
  BarlineType,
  BeatBoundaryElement,
  Diagnostic,
  InlineLayerElement,
  LyricLine,
  LyricSyllable,
  Mark,
  MarkType,
  Metadata,
  Meter,
  MusicElement,
  NoteElement,
  Ornament,
  PuDoc,
  PuSong,
  ScoreLine,
  ScorePage,
  SourceSpan,
  SustainElement,
  TextLine,
  VoiceGroup,
} from "./ast";
