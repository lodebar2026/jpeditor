// 音乐字体的字符 → SMuFL 语义名。
//
// 移植自 musicpp：`qtomr/qomr.cpp::getSmufl()` 里那张内联表 + `omr/symbolmap.cpp` 的
// `SymbolMap::convert`（各家共用的那半张）/ `MaestroMap` / `OpusMap`。改这些表之前先核对原文。
//
// ## 查表用哪个键
//
// musicpp 查的是 pdfium 的 `UnicodeFromCharCode(code)`，即**字体编码解出来的 Unicode**。
// 本仓两个键都有（`VecGlyph.unicode` 与 `VecGlyph.code`），实测**两个都不够可靠**：
//
//   - 同一本书里同一个字形，因为分了多个子集，`code` 会是 207/161/156/157/37/11/7/8/10……
//     （子集按首次使用顺序重编码），`unicode` 也跟着在 U+153 与「码位原样」之间摇摆。
//   - 但 Adobe Sonata 那一系（Maestro / Opus / Doremi / Petrucci）的**原始编码是同一套**
//     （MacRoman：0xCF = 实心符头、0xFA = 空心符头、0xCE = 四分休止……），
//     musicpp 的 Maestro 表与 Opus 表因此逐条重合。
//
// 所以这里按 **unicode → 表**、**code → 表** 依次查，两条都落空才算未知；
// 真正的定案靠 `glyphdict.ts` 的**轮廓聚类**（见 `staffglyphs.ts` 与 `glyphmap.json`），
// 这张表只作**自举的先验**与没有轮廓时的兜底。
import type { SmuflName } from "./glyphs";

/** 各家音乐字体共用的那半张表（`omr/symbolmap.cpp::SymbolMap::convert`）。
 *  键是 Unicode 码点（ASCII 直接写字符码）。 */
const COMMON: Record<number, SmuflName> = {
  0x3f: "fClef", // '?'
  0x26: "gClef", // '&'
  0x42: "cClef", // 'B'

  0x63: "timeSigCommon", // 'c'
  0x43: "timeSigCutCommon", // 'C'
  0x30: "timeSig0",
  0x31: "timeSig1",
  0x32: "timeSig2",
  0x33: "timeSig3",
  0x34: "timeSig4",
  0x35: "timeSig5",
  0x36: "timeSig6",
  0x37: "timeSig7",
  0x38: "timeSig8",
  0x39: "timeSig9",

  0x153: "noteheadBlack", // œ
  0x2d9: "noteheadHalf", // ˙
  0x77: "noteheadWhole", // 'w'
  0x57: "noteheadDoubleWhole", // 'W'

  0x152: "restQuarter", // Œ
  0x2030: "rest8th", // ‰
  0xd3: "restHalf", // Ó
  0x2211: "restHBar", // ∑
  0x2248: "rest16th", // ≈

  0x6a: "flag8thUp", // 'j'
  0x4a: "flag8thDown", // 'J'
  0x72: "flag16thUp", // 'r'
  0x52: "flag16thDown", // 'R'

  0x2e: "augmentationDot", // '.'

  0x62: "accidentalFlat", // 'b'
  0x6e: "accidentalNatural", // 'n'
  0x23: "accidentalSharp", // '#'

  0x55: "fermataAbove", // 'U'
  0x75: "fermataBelow", // 'u'

  0x71: "metNoteQuarterUp", // 'q'
};

/** Maestro 专有部分（`qomr.cpp::getSmufl` 的内联表 + `symbolmap.cpp::MaestroMap`）。 */
const MAESTRO: Record<number, SmuflName> = {
  0xf0ee: "restHalf",
  0x2248: "rest16th",
  0xd3: "restHalf",
  0x152: "restQuarter",
  0x153: "noteheadBlack",
  0x2d9: "noteheadHalf",
  0x56: "gClef8vb", // 'V'
  0xf7: "unpitchedPercussionClef2", // '÷'
  0x3e: "articAccentAbove", // '>'
  0x2030: "rest8th",
  0x221a: "ottavaAlta", // '√'
  0x2211: "restHBar",
  0x25ca: "ottavaBassaVb", // '◊'
  0x3c0: "dynamicPP", // 'π'
  0x67: "wiggleTrill", // 'g'
  0xdf: "dynamicSforzando", // 'ß'
  0x50: "dynamicMP", // 'P'
  0x70: "dynamicMF", // 'p' —— 照 musicpp 原文（Maestro 里 'p' 是 mf 的合字）
  0x46: "dynamicMF", // 'F'
  0x66: "dynamicForte", // 'f'
  0x192: "dynamicFF", // 'ƒ'
  0x2c: "breathMarkComma", // ','
  0x76: "articMarcatoBelow", // 'v'
  0xfb02: "articAccentStaccatoBelow", // 'ﬂ'
  0xfb01: "segno", // 'ﬁ'
  0x3c: "articTenutoStaccatoBelow", // '<'
  0x65: "metNote8thUp", // 'e'
  0x2d: "articTenutoBelow", // '-'
  0xf0b7: "restHBar",
  0xf0fa: "restHalf",
  0x6f: "csymDiminished", // 'o'
  0x28: "csymParensLeftTall", // '('
  0x29: "csymParensRightTall", // ')'
  0x2b: "csymAugmented", // '+'
  0x25: "segno", // '%'
  0xdb: "noteheadSlashVerticalEnds", // 'Û'
  0x7c: "noteheadSlashDiamondWhite", // '|'
  0xc7: "noteheadHalf", // 'Ç'
  0x87: "restHBar",
  0xbb: "restHalf", // '»'
  0x2039: "accidentalDoubleSharp", // '‹'
  0x4e: "accidentalNaturalParens", // 'N'
  0x2019: "noteheadSlashHorizontalEnds", // '’'
};

/** MaestroWide（`qomr.cpp` 的 `maestroWide`）。 */
const MAESTRO_WIDE: Record<number, SmuflName> = {
  0x21: "restHBar", // '!'
};

/** Opus（Sibelius）。`omr/symbolmap.cpp::OpusMap`，非 Std 版要先把 0xF000 私用区偏移减掉。 */
const OPUS: Record<number, SmuflName> = {
  0xcf: "noteheadBlack",
  0xfa: "noteheadHalf",
  0xce: "restQuarter",
  0xe4: "rest8th",
  0xc5: "rest16th",
  0xee: "restHalf",
  0xb7: "restHBar",
  0xd9: "ornamentTrill",
};

const OPUS_STD: Record<number, SmuflName> = {
  0x25: "segno", // '%'
  0x2211: "restHBar",
  0xbf: "noteheadXBlack",
};

const OPUS_SPECIAL: Record<number, SmuflName> = {
  0xa1: "bracketTop",
  0xa2: "bracketBottom",
  0x7b: "brace", // '{'
  0xdc: "clef8",
  0xaa: "augmentationDot",
};

const OPUS_SPECIAL_STD: Record<number, SmuflName> = {
  0xb0: "bracketTop",
  0xa2: "bracketBottom",
  0x2122: "augmentationDot",
  0x220f: "wiggleTrill",
  0x2039: "clef8",
  0x7b: "brace",
};

const OPUS_TEXT: Record<number, SmuflName> = {
  0x71: "metNoteQuarterUp", // 'q'
  0x70: "dynamicPiano", // 'p'
  0x66: "dynamicForte", // 'f'
  0x6d: "dynamicMezzo", // 'm'
  0x33: "tuplet3", // '3'
};

/** Petrucci（同属 Sonata 一系，编码与 Opus 重合，musicpp 里没有单独表）。 */
const PETRUCCI: Record<number, SmuflName> = OPUS;

/** 这些字体名当作音乐符号字体处理。`EngraverTextT` 照 musicpp **不收**
 *  （那是刻谱文字字体：力度、速度术语，走文本那条路）。 */
export type MusicFontFamily =
  | "Maestro"
  | "MaestroWide"
  | "Opus"
  | "OpusStd"
  | "OpusSpecial"
  | "OpusSpecialStd"
  | "OpusText"
  | "Petrucci"
  | "Anastasia";

/** 字体名（已去子集前缀）→ 家族；不是音乐字体返回 null。 */
export function musicFamily(font: string): MusicFontFamily | null {
  if (font.startsWith("MaestroWide")) return "MaestroWide";
  if (font.startsWith("Maestro")) return "Maestro";
  if (font.startsWith("OpusSpecialStd")) return "OpusSpecialStd";
  if (font.startsWith("OpusSpecial")) return "OpusSpecial";
  if (font.startsWith("OpusText")) return "OpusText";
  if (font.startsWith("OpusStd")) return "OpusStd";
  if (font.startsWith("OpusChords")) return null; // 和弦后缀字体，走文本
  if (font.startsWith("Opus")) return "Opus";
  if (font.startsWith("Petrucci")) return "Petrucci";
  if (font.startsWith("Anastasia")) return "Anastasia";
  return null;
}

function tableOf(family: MusicFontFamily): Record<number, SmuflName>[] {
  switch (family) {
    case "Maestro":
      return [MAESTRO, COMMON];
    case "MaestroWide":
      return [MAESTRO_WIDE, MAESTRO, COMMON];
    case "Opus":
      return [OPUS, COMMON];
    case "OpusStd":
      return [OPUS_STD, COMMON];
    case "OpusSpecial":
      return [OPUS_SPECIAL];
    case "OpusSpecialStd":
      return [OPUS_SPECIAL_STD];
    case "OpusText":
      return [OPUS_TEXT];
    case "Petrucci":
      return [PETRUCCI, COMMON];
    case "Anastasia":
      // Sibelius 的手写体。musicpp 全仓没有它的表——本书 115 页用的是它，
      // 只能靠轮廓聚类 + 人工确认建（见 staffglyphs.ts / glyphmap.json）。
      return [];
  }
}

/**
 * 按**码位表**猜一个字形的语义。这是自举的先验，不是定案——
 * 定案在 `glyphmap.json`（轮廓聚类 + 人工确认），见 `staffglyphs.ts::lookupGlyph`。
 *
 * @param unicode ToUnicode 解出的码点（可能不可靠，传 0 表示没有）
 * @param code    内容流里的原始码位
 */
export function guessByCode(font: string, unicode: number, code: number): SmuflName | null {
  const fam = musicFamily(font);
  if (!fam) return null;
  const tables = tableOf(fam);
  // 键的优先次序要紧：**私用区剥掉 0xF000 之后的码点 > ToUnicode 原值 > 内容流码位**。
  // 反过来会错——Opus 的 U+F0C5（= 0xC5 十六分休止）子集码位恰好是 63（'?'），
  // 而 '?' 在共用表里是低音谱号：先查码位就把十六分休止读成了 F 谱号。
  // 子集码位是排版软件按首次使用顺序重编的，含义最弱，永远排最后。
  const keys: number[] = [];
  if (unicode > 0xf000) keys.push(unicode - 0xf000); // 照 OpusMap::convert 的私用区偏移
  keys.push(unicode, code);
  for (const k of keys) {
    if (!k) continue;
    for (const t of tables) {
      const v = t[k];
      if (v) return v;
    }
  }
  return null;
}
