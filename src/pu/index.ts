// 文本谱（番茄简谱 / 「有谱」）的对外入口。

export { sniffDialect, dialectSpec, DIALECTS, type Dialect, type DialectSpec } from "./dialect";
export { parsePu, parseMusicLine, parseLyricBody, type ParseOptions } from "./parse";
export { eachNote, eachNoteInElements, emptyMetadata, primaryMetadata } from "./ast";
export { PuPainter } from "./painter";
export { puToScore, type ToScoreOptions } from "./toscore";
// 展开档应有几遍（两种格式共用的判据；回归脚本经 window.__pu 取用）
export { countPasses } from "../jianpu/expand";
export { puToMusicXml, type ToXmlOptions } from "./toxml";
export { layoutDocument, layoutSong, elementBeats } from "./layout";
export { metricsFor, contentWidth, contentHeight, type PageProfileName, type PuMetrics } from "./metrics";
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
