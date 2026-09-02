// 五线谱识别用的**符号词汇表**：SMuFL 规范名（字符串），不是码位。
//
// 为什么不直接用 `src/smufl/smufl.ts::GlyphCodes`：那份是**绘制**侧的（Bravura 的 PUA 码位 +
// 度量，给混排排版用）。识别侧要的是**语义**——「这是个实心符头」——而且词汇量比绘制侧大得多
// （musicpp 的表里有 restHBar / ottavaAlta / graceNoteSlashStemUp 这些排版根本不画的）。
// 两边按名字对得上：需要画的时候 `GlyphCodes[name]` 取码位即可。
//
// 名字一律照 SMuFL 官方 glyphnames（musicpp 的 `smufl::Glyph::g_xxx` 去掉 `g_` 前缀就是它）。

/** 识别侧认得的 SMuFL 字形名。加新名字只在这里加一次。 */
export const SMUFL_NAMES = [
  // 谱号
  "gClef", "gClef8vb", "gClef8va", "fClef", "fClef8vb", "cClef",
  "unpitchedPercussionClef1", "unpitchedPercussionClef2", "sixStringTabClef", "clef8",
  // 符头
  "noteheadDoubleWhole", "noteheadWhole", "noteheadHalf", "noteheadBlack",
  "noteheadXBlack", "noteheadSlashVerticalEnds", "noteheadSlashHorizontalEnds",
  "noteheadSlashDiamondWhite", "noteheadDiamondBlack", "noteheadDiamondWhite",
  // 符尾
  "flag8thUp", "flag8thDown", "flag16thUp", "flag16thDown", "flag32ndUp", "flag32ndDown",
  "flag64thUp", "flag64thDown",
  // 休止
  "restDoubleWhole", "restWhole", "restHalf", "restQuarter", "rest8th", "rest16th",
  "rest32nd", "rest64th", "restHBar",
  // 附点
  "augmentationDot",
  // 拍号
  "timeSig0", "timeSig1", "timeSig2", "timeSig3", "timeSig4", "timeSig5",
  "timeSig6", "timeSig7", "timeSig8", "timeSig9", "timeSigCommon", "timeSigCutCommon",
  // 升降号
  "accidentalFlat", "accidentalNatural", "accidentalSharp",
  "accidentalDoubleSharp", "accidentalDoubleFlat",
  "accidentalNaturalParens", "accidentalParensLeft", "accidentalParensRight",
  // 括号与谱表装饰
  "brace", "bracket", "bracketTop", "bracketBottom", "repeatDots", "repeatDot",
  // 演奏法
  "fermataAbove", "fermataBelow",
  "articAccentAbove", "articAccentBelow",
  "articStaccatoAbove", "articStaccatoBelow",
  "articTenutoAbove", "articTenutoBelow",
  "articStaccatissimoAbove", "articStaccatissimoBelow",
  "articMarcatoAbove", "articMarcatoBelow",
  "articAccentStaccatoAbove", "articAccentStaccatoBelow",
  "articTenutoStaccatoAbove", "articTenutoStaccatoBelow",
  // 装饰音与记号
  "ornamentTrill", "wiggleTrill", "wiggleTrillSlow", "tremolo1", "tremolo2", "tremolo3",
  "graceNoteSlashStemUp", "graceNoteSlashStemDown",
  "segno", "coda", "caesura", "breathMarkComma",
  "ottavaAlta", "ottavaBassaVb", "ottava",
  // 力度
  "dynamicPiano", "dynamicMezzo", "dynamicForte", "dynamicRinforzando",
  "dynamicSforzando", "dynamicZ", "dynamicNiente",
  "dynamicPP", "dynamicPPP", "dynamicMP", "dynamicMF", "dynamicFF", "dynamicFFF",
  // 节拍/文字里的音符
  "metNoteQuarterUp", "metNote8thUp", "metNoteHalfUp", "metAugmentationDot",
  // 和弦符号里的
  "csymAugmented", "csymDiminished", "csymHalfDiminished",
  "csymParensLeftTall", "csymParensRightTall",
  "csymAccidentalFlat", "csymAccidentalNatural", "csymAccidentalSharp",
  // 三连音数字（OpusText 里有）
  "tuplet0", "tuplet3",
  // 踏板
  "keyboardPedalPed", "keyboardPedalUp",
  // **结构件**：Sibelius 的手写体（Anastasia）把谱线/符干/加线/小节线都当**字形**画，
  // 不是路径（Anastasia 那 115 页实测一条长横路径都没有）。识别侧必须认得它们，
  // 否则 findStaves 在那些页上会一无所获。
  "staff5Lines", "stem", "legerLine",
  "barlineSingle", "barlineHeavy", "barlineFinal", "barlineDouble",
  "repeatLeft", "repeatRight", "repeatRightLeft",
] as const;

export type SmuflName = (typeof SMUFL_NAMES)[number];

const NAME_SET: ReadonlySet<string> = new Set(SMUFL_NAMES);

export function isSmuflName(s: string): s is SmuflName {
  return NAME_SET.has(s);
}

// ── 语义分类（musicpp 的 Clefs::inRange / Rests::inRange / Noteheads::inRange） ──

const CLEFS: ReadonlySet<string> = new Set([
  "gClef", "gClef8vb", "gClef8va", "fClef", "fClef8vb", "cClef",
  "unpitchedPercussionClef1", "unpitchedPercussionClef2", "sixStringTabClef",
]);

const RESTS: ReadonlySet<string> = new Set([
  "restDoubleWhole", "restWhole", "restHalf", "restQuarter", "rest8th",
  "rest16th", "rest32nd", "rest64th", "restHBar",
]);

const HEADS: ReadonlySet<string> = new Set([
  "noteheadDoubleWhole", "noteheadWhole", "noteheadHalf", "noteheadBlack",
  "noteheadXBlack", "noteheadSlashVerticalEnds", "noteheadSlashHorizontalEnds",
  "noteheadSlashDiamondWhite", "noteheadDiamondBlack", "noteheadDiamondWhite",
]);

const ACCIDENTALS: ReadonlySet<string> = new Set([
  "accidentalFlat", "accidentalNatural", "accidentalSharp",
  "accidentalDoubleSharp", "accidentalDoubleFlat", "accidentalNaturalParens",
]);

const TIMESIGS: ReadonlySet<string> = new Set([
  "timeSig0", "timeSig1", "timeSig2", "timeSig3", "timeSig4", "timeSig5",
  "timeSig6", "timeSig7", "timeSig8", "timeSig9", "timeSigCommon", "timeSigCutCommon",
]);

const FLAGS: ReadonlySet<string> = new Set([
  "flag8thUp", "flag8thDown", "flag16thUp", "flag16thDown",
  "flag32ndUp", "flag32ndDown", "flag64thUp", "flag64thDown",
]);

export const isClef = (g: string): boolean => CLEFS.has(g);
export const isRest = (g: string): boolean => RESTS.has(g);
/** musicpp `Symbol::isNoteHead()`：**休止也算**（它占一个「音符位」）。 */
export const isNoteHead = (g: string): boolean => RESTS.has(g) || HEADS.has(g);
/** 真符头（不含休止）。 */
export const isPitchedHead = (g: string): boolean => HEADS.has(g);
export const isAccidental = (g: string): boolean => ACCIDENTALS.has(g);
export const isTimeSig = (g: string): boolean => TIMESIGS.has(g);
export const isFlag = (g: string): boolean => FLAGS.has(g);

/** 符尾条数（八分 1、十六分 2……）；不是符尾返回 0。 */
export function flagLevel(g: string): number {
  switch (g) {
    case "flag8thUp":
    case "flag8thDown":
      return 1;
    case "flag16thUp":
    case "flag16thDown":
      return 2;
    case "flag32ndUp":
    case "flag32ndDown":
      return 3;
    case "flag64thUp":
    case "flag64thDown":
      return 4;
    default:
      return 0;
  }
}

/** 符尾朝向：向上的符尾挂在朝上的符干右侧。 */
export function flagUp(g: string): boolean {
  return g.endsWith("Up");
}

/** 休止符 → 时值（全音符为 1）。`restHBar` 是「整小节休止」，时值随拍号，这里给 -1。 */
export function restDuration(g: string): number {
  switch (g) {
    case "restDoubleWhole":
      return 2;
    case "restWhole":
      return 1;
    case "restHalf":
      return 1 / 2;
    case "restQuarter":
      return 1 / 4;
    case "rest8th":
      return 1 / 8;
    case "rest16th":
      return 1 / 16;
    case "rest32nd":
      return 1 / 32;
    case "rest64th":
      return 1 / 64;
    case "restHBar":
      return -1;
    default:
      return 0;
  }
}

/** 升降号 → 半音数。 */
export function accidentalAlter(g: string): number {
  switch (g) {
    case "accidentalFlat":
      return -1;
    case "accidentalDoubleFlat":
      return -2;
    case "accidentalSharp":
      return 1;
    case "accidentalDoubleSharp":
      return 2;
    case "accidentalNatural":
    case "accidentalNaturalParens":
      return 0;
    default:
      return 0;
  }
}

/** 拍号数字 → 值；不是数字拍号返回 -1（`timeSigCommon` 等另判）。 */
export function timeSigDigit(g: string): number {
  if (g.startsWith("timeSig") && g.length === 8) {
    const d = g.charCodeAt(7) - 48;
    if (d >= 0 && d <= 9) return d;
  }
  return -1;
}
