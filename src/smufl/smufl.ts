// Ported from mp/smufl/smufl.kt - SMuFL (Bravura) glyph codes + metadata.
// Use fromCharCode to keep the PUA codepoints unambiguous in source.
import { asset } from "../common/asset";

export const GlyphCodes = {
  // Clefs
  gClef: String.fromCharCode(0xe050),
  gClef8vb: String.fromCharCode(0xe052),
  fClef: String.fromCharCode(0xe062),
  cClef: String.fromCharCode(0xe05c),
  unpitchedPercussionClef1: String.fromCharCode(0xe069),
  sixStringTabClef: String.fromCharCode(0xe06d),
  // Noteheads
  noteheadWhole: String.fromCharCode(0xe0a2),
  noteheadHalf: String.fromCharCode(0xe0a3),
  noteheadBlack: String.fromCharCode(0xe0a4),
  noteheadSlashVerticalEnds: String.fromCharCode(0xe100),
  noteheadSlashDiamondWhite: String.fromCharCode(0xe104),
  // Flags
  flag8thUp: String.fromCharCode(0xe240),
  flag8thDown: String.fromCharCode(0xe241),
  flag16thUp: String.fromCharCode(0xe242),
  flag16thDown: String.fromCharCode(0xe243),
  flag32ndUp: String.fromCharCode(0xe244),
  flag32ndDown: String.fromCharCode(0xe245),
  // Rests
  restWhole: String.fromCharCode(0xe4e3),
  restHalf: String.fromCharCode(0xe4e4),
  restQuarter: String.fromCharCode(0xe4e5),
  rest8th: String.fromCharCode(0xe4e6),
  rest16th: String.fromCharCode(0xe4e7),
  rest32nd: String.fromCharCode(0xe4e8),
  // Augmentation dot
  augmentationDot: String.fromCharCode(0xe1e7),
  // Time signatures
  timeSig0: String.fromCharCode(0xe080),
  timeSig1: String.fromCharCode(0xe081),
  timeSig2: String.fromCharCode(0xe082),
  timeSig3: String.fromCharCode(0xe083),
  timeSig4: String.fromCharCode(0xe084),
  timeSig5: String.fromCharCode(0xe085),
  timeSig6: String.fromCharCode(0xe086),
  timeSig7: String.fromCharCode(0xe087),
  timeSig8: String.fromCharCode(0xe088),
  timeSig9: String.fromCharCode(0xe089),
  timeSigCommon: String.fromCharCode(0xe08a),
  timeSigCutCommon: String.fromCharCode(0xe08b),
  // Accidentals
  accidentalFlat: String.fromCharCode(0xe260),
  accidentalNatural: String.fromCharCode(0xe261),
  accidentalSharp: String.fromCharCode(0xe262),
  accidentalDoubleSharp: String.fromCharCode(0xe263),
  // Chord-symbol accidentals/qualities (sit on the text baseline).
  csymDiminished: String.fromCharCode(0xe870),
  csymHalfDiminished: String.fromCharCode(0xe871),
  csymAugmented: String.fromCharCode(0xe872),
  csymAccidentalFlat: String.fromCharCode(0xed60),
  csymAccidentalNatural: String.fromCharCode(0xed61),
  csymAccidentalSharp: String.fromCharCode(0xed62),
  accidentalDoubleFlat: String.fromCharCode(0xe264),
  accidentalParensLeft: String.fromCharCode(0xe26a),
  accidentalParensRight: String.fromCharCode(0xe26b),
  // Barlines / repeats
  brace: String.fromCharCode(0xe000),
  bracket: String.fromCharCode(0xe002),
  bracketTop: String.fromCharCode(0xe003),
  bracketBottom: String.fromCharCode(0xe004),
  repeatDot: String.fromCharCode(0xe044),
  // Tuplets
  tuplet0: String.fromCharCode(0xe880),
  tuplet3: String.fromCharCode(0xe883),
  // Articulations / ornaments
  fermataAbove: String.fromCharCode(0xe4c0),
  fermataBelow: String.fromCharCode(0xe4c1),
  articAccentAbove: String.fromCharCode(0xe4a0),
  articAccentBelow: String.fromCharCode(0xe4a1),
  articStaccatoAbove: String.fromCharCode(0xe4a2),
  articStaccatoBelow: String.fromCharCode(0xe4a3),
  articTenutoAbove: String.fromCharCode(0xe4a4),
  articTenutoBelow: String.fromCharCode(0xe4a5),
  articStaccatissimoAbove: String.fromCharCode(0xe4a6),
  articStaccatissimoBelow: String.fromCharCode(0xe4a7),
  articMarcatoAbove: String.fromCharCode(0xe4ac),
  articMarcatoBelow: String.fromCharCode(0xe4ad),
  wiggleTrillSlow: String.fromCharCode(0xeaa5),
  // Repeats / navigation
  segno: String.fromCharCode(0xe047),
  coda: String.fromCharCode(0xe048),
  // Dynamics (单字母组合成 mf/sfz 等；见 loader.ts::convertDynamicsStr)
  dynamicPiano: String.fromCharCode(0xe520),
  dynamicMezzo: String.fromCharCode(0xe521),
  dynamicForte: String.fromCharCode(0xe522),
  dynamicRinforzando: String.fromCharCode(0xe523),
  dynamicSforzando: String.fromCharCode(0xe524),
  dynamicZ: String.fromCharCode(0xe525),
  dynamicNiente: String.fromCharCode(0xe526),
  // Metronome（节拍记号音符）
  metNoteQuarterUp: String.fromCharCode(0xeca5),
};

const codeToName: Record<string, string> = {
  [GlyphCodes.gClef]: "gClef",
  [GlyphCodes.gClef8vb]: "gClef8vb",
  [GlyphCodes.fClef]: "fClef",
  [GlyphCodes.cClef]: "cClef",
  [GlyphCodes.unpitchedPercussionClef1]: "unpitchedPercussionClef1",
  [GlyphCodes.sixStringTabClef]: "sixStringTabClef",
  [GlyphCodes.noteheadWhole]: "noteheadWhole",
  [GlyphCodes.noteheadHalf]: "noteheadHalf",
  [GlyphCodes.noteheadBlack]: "noteheadBlack",
  [GlyphCodes.noteheadSlashVerticalEnds]: "noteheadSlashVerticalEnds",
  [GlyphCodes.flag8thUp]: "flag8thUp",
  [GlyphCodes.flag8thDown]: "flag8thDown",
  [GlyphCodes.flag16thUp]: "flag16thUp",
  [GlyphCodes.flag16thDown]: "flag16thDown",
  [GlyphCodes.flag32ndUp]: "flag32ndUp",
  [GlyphCodes.flag32ndDown]: "flag32ndDown",
  [GlyphCodes.restWhole]: "restWhole",
  [GlyphCodes.restHalf]: "restHalf",
  [GlyphCodes.restQuarter]: "restQuarter",
  [GlyphCodes.rest8th]: "rest8th",
  [GlyphCodes.rest16th]: "rest16th",
  [GlyphCodes.rest32nd]: "rest32nd",
  [GlyphCodes.augmentationDot]: "augmentationDot",
  [GlyphCodes.timeSig0]: "timeSig0",
  [GlyphCodes.timeSig1]: "timeSig1",
  [GlyphCodes.timeSig2]: "timeSig2",
  [GlyphCodes.timeSig3]: "timeSig3",
  [GlyphCodes.timeSig4]: "timeSig4",
  [GlyphCodes.timeSig5]: "timeSig5",
  [GlyphCodes.timeSig6]: "timeSig6",
  [GlyphCodes.timeSig7]: "timeSig7",
  [GlyphCodes.timeSig8]: "timeSig8",
  [GlyphCodes.timeSig9]: "timeSig9",
  [GlyphCodes.timeSigCommon]: "timeSigCommon",
  [GlyphCodes.timeSigCutCommon]: "timeSigCutCommon",
  [GlyphCodes.accidentalFlat]: "accidentalFlat",
  [GlyphCodes.accidentalNatural]: "accidentalNatural",
  [GlyphCodes.accidentalSharp]: "accidentalSharp",
  [GlyphCodes.accidentalDoubleSharp]: "accidentalDoubleSharp",
  [GlyphCodes.accidentalDoubleFlat]: "accidentalDoubleFlat",
  [GlyphCodes.accidentalParensLeft]: "accidentalParensLeft",
  [GlyphCodes.accidentalParensRight]: "accidentalParensRight",
  [GlyphCodes.csymAccidentalFlat]: "csymAccidentalFlat",
  [GlyphCodes.csymAccidentalNatural]: "csymAccidentalNatural",
  [GlyphCodes.csymAccidentalSharp]: "csymAccidentalSharp",
  [GlyphCodes.brace]: "brace",
  [GlyphCodes.bracket]: "bracket",
  [GlyphCodes.bracketTop]: "bracketTop",
  [GlyphCodes.bracketBottom]: "bracketBottom",
  [GlyphCodes.repeatDot]: "repeatDot",
  [GlyphCodes.tuplet0]: "tuplet0",
  [GlyphCodes.tuplet3]: "tuplet3",
  [GlyphCodes.fermataAbove]: "fermataAbove",
  [GlyphCodes.fermataBelow]: "fermataBelow",
  [GlyphCodes.articAccentAbove]: "articAccentAbove",
  [GlyphCodes.articAccentBelow]: "articAccentBelow",
  [GlyphCodes.articStaccatoAbove]: "articStaccatoAbove",
  [GlyphCodes.articStaccatoBelow]: "articStaccatoBelow",
  [GlyphCodes.articTenutoAbove]: "articTenutoAbove",
  [GlyphCodes.articTenutoBelow]: "articTenutoBelow",
  [GlyphCodes.articStaccatissimoAbove]: "articStaccatissimoAbove",
  [GlyphCodes.articStaccatissimoBelow]: "articStaccatissimoBelow",
  [GlyphCodes.articMarcatoAbove]: "articMarcatoAbove",
  [GlyphCodes.articMarcatoBelow]: "articMarcatoBelow",
  [GlyphCodes.wiggleTrillSlow]: "wiggleTrillSlow",
  [GlyphCodes.segno]: "segno",
  [GlyphCodes.coda]: "coda",
  [GlyphCodes.dynamicPiano]: "dynamicPiano",
  [GlyphCodes.dynamicMezzo]: "dynamicMezzo",
  [GlyphCodes.dynamicForte]: "dynamicForte",
  [GlyphCodes.dynamicRinforzando]: "dynamicRinforzando",
  [GlyphCodes.dynamicSforzando]: "dynamicSforzando",
  [GlyphCodes.dynamicZ]: "dynamicZ",
  [GlyphCodes.dynamicNiente]: "dynamicNiente",
  [GlyphCodes.metNoteQuarterUp]: "metNoteQuarterUp",
};

export function glyphCodeName(c: string): string | undefined {
  return codeToName[c];
}

export interface GlyphBBox {
  bBoxNE: [number, number];
  bBoxSW: [number, number];
}

export interface GlyphAnchor {
  cutOutSE?: [number, number];
  cutOutNW?: [number, number];
  cutOutNE?: [number, number];
  cutOutSW?: [number, number];
}

interface RawMetadata {
  fontName?: string;
  fontVersion?: string;
  glyphBBoxes?: Record<string, GlyphBBox>;
  glyphsWithAnchors?: Record<string, GlyphAnchor>;
}

export class MetaData {
  fontName = "";
  fontVersion = "";
  glyphBBoxes: Record<string, GlyphBBox> = {};
  glyphsWithAnchors: Record<string, GlyphAnchor> = {};

  getBBoxByName(n: string): GlyphBBox | undefined {
    return this.glyphBBoxes[n];
  }
  getBBox(c: string): GlyphBBox | undefined {
    const n = glyphCodeName(c);
    if (!n) throw new Error(`unknown smufl glyph: ${c.charCodeAt(0).toString(16)}`);
    return this.getBBoxByName(n);
  }
  getAnchorByName(n: string): GlyphAnchor | undefined {
    return this.glyphsWithAnchors[n];
  }
  getAnchor(c: string): GlyphAnchor | undefined {
    const n = glyphCodeName(c);
    if (!n) return undefined;
    return this.getAnchorByName(n);
  }

  static fromJson(raw: RawMetadata): MetaData {
    const md = new MetaData();
    md.fontName = raw.fontName ?? "";
    md.fontVersion = raw.fontVersion ?? "";
    md.glyphBBoxes = raw.glyphBBoxes ?? {};
    md.glyphsWithAnchors = raw.glyphsWithAnchors ?? {};
    return md;
  }

  static async load(url = asset("redist/bravura_metadata.json")): Promise<MetaData> {
    const resp = await fetch(url);
    const raw = (await resp.json()) as RawMetadata;
    return MetaData.fromJson(raw);
  }
}
