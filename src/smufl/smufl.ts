// Ported from mp/smufl/smufl.kt - SMuFL (Bravura) glyph codes + metadata.
// Use fromCharCode to keep the PUA codepoints unambiguous in source.

export const GlyphCodes = {
  accidentalFlat: String.fromCharCode(0xe260),
  accidentalSharp: String.fromCharCode(0xe262),
  accidentalNatural: String.fromCharCode(0xe261),
  tuplet3: String.fromCharCode(0xe883),
  fermataAbove: String.fromCharCode(0xe4c0),
};

const codeToName: Record<string, string> = {
  [GlyphCodes.accidentalFlat]: "accidentalFlat",
  [GlyphCodes.accidentalNatural]: "accidentalNatural",
  [GlyphCodes.accidentalSharp]: "accidentalSharp",
  [GlyphCodes.tuplet3]: "tuplet3",
  [GlyphCodes.fermataAbove]: "fermataAbove",
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

  static async load(url = "/redist/bravura_metadata.json"): Promise<MetaData> {
    const resp = await fetch(url);
    const raw = (await resp.json()) as RawMetadata;
    return MetaData.fromJson(raw);
  }
}
