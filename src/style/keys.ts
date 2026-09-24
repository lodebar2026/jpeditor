// 样式表对外的名字 → 各把尺子的内部字段（`layout` 简谱引擎、`mixed` 混排、`book` 成书、`original` 原样文档布局）。
//
// `.ss` 里只见**逻辑键**（kebab-case，按谱面内容分），`LayoutOptions` / `MixedOptions`
// 的字段名（`jpBeamTopY`、`lineWidths.stem`、`musicppJpTimeSig`…）不外露：
//
//   `@jianpu` = 简谱内容（各模式通用）：纯简谱落 `LayoutOptions`，混排落 `MixedOptions` 的简谱层字段
//   `@staff`  = 五线谱内容：只在 `mode: staff / mixed` 有效，落 `MixedOptions`
//
// 模式差异由 `@media (mode: …)` 限定，不靠「写进哪个块」。字体不在这两张表里——
// 字体走角色声明（`note { font: hei }`），角色 → 字体字段的对照是 `ROLE_FONTS`。
//
// 表里缺一边 = 那个模式不支持这个键，解析期就报错（`ss.ts`），不静默忽略。
import type { StyleRole } from "./sheet";

/** 值的种类：长度（收 em/sp/裸数）、纯数（比例、层数）、开关、词（枚举值）。 */
export type KeyKind = "len" | "num" | "bool" | "word";

export interface KeyDef {
  kind: KeyKind;
  /** `LayoutOptions` 上的字段名；缺 = 纯简谱那几档不支持。 */
  layout?: string;
  /** `MixedOptions` 上的字段名（可带一级子路径，如 `lineWidths.stem`）；缺 = 混排/五线谱不支持。 */
  mixed?: string;
  /** 成书 `BookStyle` 上的路径（`metrics.systemGapEm`、`layout.verseNumbers`…）；缺 = 成书不读。
   *  字段名以 `Em` 结尾的，样式表里**必须**写 `em` 单位（基准是字号，不是墨迹高），数值原样存进字段（不乘字号，浮点逐位不变）；
   *  其余长度写裸数（pt）。成书这一路由 `style/bookss.ts` 读，不经 `LayoutOptions` 的覆写。 */
  book?: string;
  /** 原样文档布局 `JianpuMetrics` 上的路径（`note.beamWidth`…）；缺 = 那一路不读。只给内置方言表
   *  （`style/books/original-*.ss`）用到的键配了这一列，由 `style/original.ts::jianpuMetricsOf` 读。 */
  original?: string;
  /** 不支持的那一侧的说法，进报错信息。 */
  note?: string;
}

/** 角色 → 两把尺子上的字体字段。`chord` 在混排是族名串（`wordFont`），不是 `Font`。 */
export const ROLE_FONTS: Partial<Record<StyleRole, { layout?: string; mixed?: string; mixedFamilyOnly?: boolean }>> = {
  note: { layout: "numberFont", mixed: "jianpuFont" },
  lyric: { layout: "lrcFont" }, // 混排歌词字体由 MusicXML <defaults> 给
  smufl: { layout: "smuflFont", mixed: "musicFont" },
  chord: { mixed: "wordFont", mixedFamilyOnly: true },
};

/** `@jianpu`：简谱内容。
 *  成书一列（`book`）里 `em` 的基准是音符字号，只有 `lyric-gap` / `slur-thickness` / `barline` /
 *  `final-barline` 按歌词字号——`style/book.ts::applyBookPreset` 原来就是这么乘的。 */
export const JIANPU_KEYS: Record<string, KeyDef> = {
  "note-bold": { kind: "bool", layout: "noteBold", note: "混排的简谱数字不单独加粗" },
  "beam-width": { kind: "len", layout: "jpBeamWidth", mixed: "lineWidths.jpBeam", original: "note.beamWidth" },
  "beam-top": { kind: "len", layout: "jpBeamTop", book: "metrics.divLineGapEm" },
  "beam-dist": { kind: "len", layout: "jpBeamDist", mixed: "beamDistJP", book: "metrics.divLineStepEm" },
  "octave-dot-dist": { kind: "len", layout: "jpStackGap", mixed: "octaveDotDist", book: "metrics.stackGapEm" },
  "system-gap": { kind: "len", layout: "maxLineDist", book: "metrics.systemGapEm", original: "spacing.systemGap" },
  "note-step": { kind: "len", book: "metrics.noteStepEm", note: "音符步距只有成书断句用" },
  "lyric-gap": { kind: "len", layout: "lyricGap", book: "metrics.lyricGapEm", original: "lyricSpacing.lyricGap" },
  "lyric-stack": { kind: "len", layout: "lyricStack", book: "metrics.lyricToLyricEm", original: "lyricSpacing.lyricStack" },
  "chord-gap": { kind: "len", layout: "chordGap", book: "metrics.chordToNoteEm" },
  "chord-plain": { kind: "bool", layout: "chordPlainText", book: "metrics.chordPlain" },
  "bracket-width": { kind: "len", layout: "bracketWidth", book: "metrics.bracketWidth" },
  "bracket-foot": { kind: "len", layout: "bracketFoot", book: "metrics.bracketFootEm" },
  "tuplet-style": { kind: "word", layout: "tupletStyle", note: "取 bracket（括线）/ arc（两段弧）；成书与混排不支持" },
  "repeat-dot-diameter": { kind: "len", book: "metrics.repeatDotDiam", note: "纯简谱的反复点按半径（repeatDotRadius）自算" },
  "slur-thickness": { kind: "len", layout: "slurTieThickness", book: "metrics.slurThicknessEm" },
  "slur-arc": { kind: "len", book: "metrics.slurArcEm", note: "弧高目标只有成书反算缩放用" },
  "slur-max-arc": { kind: "len", book: "metrics.slurMaxArcEm", note: "同上" },
  "slur-min-arc": { kind: "len", book: "metrics.slurMinArcEm", note: "同上" },
  "slur-flat-span": { kind: "num", book: "metrics.slurFlatSpanSteps", note: "纯简谱的扁平阈值是物理宽度（slurFlatSpan）" },
  "slur-flat-notes": { kind: "num", layout: "slurFlatNotes", book: "metrics.slurFlatNotes" },
  "slur-flat-ratio": { kind: "num", layout: "slurFlatRatio", book: "metrics.slurFlatRatio" },
  barline: { kind: "len", layout: "barlineWidth", book: "metrics.barlineWidthEm" },
  "final-barline": { kind: "len", layout: "finalBarlineWidth", book: "metrics.finalBarlineWidthEm" },
  "verse-numbers": { kind: "word", layout: "verseNumbers", book: "layout.verseNumbers" },
  "max-horizontal-scale": { kind: "num", layout: "maxHorizontalScale", book: "layout.maxHorizontalScale" },
  "grace-scale": { kind: "num", mixed: "jpGraceScale", note: "纯简谱的倚音缩放由排版器自算" },
  // 以下几个笔位在纯简谱那一路是算出来的（`layout/options.ts` 的 getter），只有混排给常量
  "octave-up-y": { kind: "len", mixed: "jpOctaveUpY", note: "纯简谱的八度点笔位由排版器自算" },
  "octave-down-dy": { kind: "len", mixed: "jpOctaveDownDy", note: "同上" },
  "beam-top-y": { kind: "len", mixed: "jpBeamTopY", note: "纯简谱的减时线基准由排版器自算" },
  "dot-dx": { kind: "len", mixed: "jpDotDx", note: "纯简谱的附点笔位由排版器自算" },
  "dot-dy": { kind: "len", mixed: "jpDotDy", note: "同上" },
  "top-dy": { kind: "len", mixed: "jpTopDy", note: "只有混排的简谱层要整体上提" },
  "show-key-change": { kind: "bool", mixed: "showKeyChangeJp", note: "纯简谱一定画调号" },
  "key-uses-full-font": { kind: "bool", mixed: "jpKeyJianpuFont", note: "纯简谱没有缩小的简谱层" },
  "legacy-time-sig": { kind: "bool", mixed: "musicppJpTimeSig", note: "旧版拍号笔位只在混排有" },
  "legacy-hwid-glyphs": { kind: "bool", mixed: "musicppHwidGlyphs", note: "同上" },
  "lrc-half-punct": { kind: "bool", mixed: "lrcHWID", note: "纯简谱的歌词标点按上下文挤压" },
  "chinese-hyphen": { kind: "bool", mixed: "chineseHyphen", note: "纯简谱不画中文连字符" },
  // 以下只有原样文档布局（`layout/original/`）有：多声部、按实测落值的小节线与增时线
  "voice-gap": { kind: "len", original: "spacing.voiceGap", note: "只有原样文档布局排多声部" },
  "barline-height": { kind: "len", original: "note.barlineHeight", note: "只有原样文档布局单给小节线高" },
  "double-barline-gap": { kind: "len", original: "stroke.doubleBarlineGap", note: "同上" },
  "dash-width": { kind: "len", original: "note.dashWidth", note: "只有原样文档布局单给增时线尺寸" },
  "dash-half-length": { kind: "len", original: "note.dashHalfLength", note: "同上" },
};

/** `@staff`：五线谱内容。纯简谱那几档整块不适用（简谱的小节线宽写在 `@jianpu` 的 `barline`）。 */
export const STAFF_KEYS: Record<string, KeyDef> = {
  "staff-height": { kind: "len", mixed: "mixStaffHeight" },
  "staff-dist": { kind: "len", mixed: "mixStaffDist" },
  "barline-dist": { kind: "len", mixed: "barlineDist" },
  "slur-stem-dy": { kind: "len", mixed: "slurStemDy" },
  "harmony-size": { kind: "len", mixed: "harmonySize" },
  "harmony-y-pos": { kind: "len", mixed: "harmonyYPos" },
  "cue-size": { kind: "num", mixed: "cueSize" },
  "hide-bar-number": { kind: "bool", mixed: "hideBarNumber" },
  "initial-key-time": { kind: "bool", mixed: "initialKeyTime" },
  "melody-only": { kind: "bool", mixed: "melodyOnly" },
  "text-line-height-by-size": { kind: "bool", mixed: "textLineHeightBySize" },
  // 线宽：样式表里是一级键，内部才是 `lineWidths.*`
  "staff-line": { kind: "len", mixed: "lineWidths.staff" },
  leger: { kind: "len", mixed: "lineWidths.leger" },
  stem: { kind: "len", mixed: "lineWidths.stem" },
  beam: { kind: "len", mixed: "lineWidths.beam" },
  barline: { kind: "len", mixed: "lineWidths.lightBarline" },
  "final-barline": { kind: "len", mixed: "lineWidths.heavyBarline" },
};

/** `@break`：断句（行怎么断）。**与谱式无关**——现在只有成书读，五线谱以后也用这一块。 */
export const BREAK_KEYS: Record<string, KeyDef> = {
  enable: { kind: "bool", book: "layout.phrase" },
  "lines-per-page": { kind: "num", book: "layout.linesPerPage" },
  "target-measures": { kind: "num", book: "layout.phraseTargetMeas" },
  "length-weight": { kind: "num", book: "layout.phraseLenWeight" },
  "break-weight": { kind: "num", book: "layout.phraseBreakWeight" },
  "mid-break": { kind: "bool", book: "layout.phraseMidBreak" },
  "merge-short": { kind: "bool", book: "layout.phraseMergeShort" },
  "even-weight": { kind: "num", book: "layout.phraseEvenWeight" },
  "tail-weight": { kind: "num", book: "layout.phraseTailWeight" },
  "content-only": { kind: "bool", book: "layout.phraseContentOnly" },
  "parallel-weight": { kind: "num", book: "layout.phraseParallelWeight" },
  "tail-long-weight": { kind: "num", book: "layout.phraseTailLongWeight" },
  "more-rows-slack": { kind: "num", book: "layout.phraseMoreRowsSlack" },
  "fit-slack": { kind: "num", book: "layout.phraseFitSlack" },
};

/** 块名 → 键表。 */
export function keysOfBlock(block: "jianpu" | "staff" | "break"): Record<string, KeyDef> {
  return block === "jianpu" ? JIANPU_KEYS : block === "staff" ? STAFF_KEYS : BREAK_KEYS;
}
