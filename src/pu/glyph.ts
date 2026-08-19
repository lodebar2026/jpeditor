// 文本谱的记号字形：`&xx` → Bravura（SMuFL）码位。
//
// PUA 码位一律用 String.fromCharCode 写，**切勿在源码里写字面 PUA 字符**
// （编辑工具会损坏这些字节）。这里不引用项目主谱面的 GlyphCodes，是因为文本谱要的
// 记号集与它只有部分重叠，各自维护更清楚。

const C = (n: number): string => String.fromCharCode(n);

/** 记号在音符的哪一侧。 */
export type OrnamentPlacement = "above" | "below";

export interface OrnamentGlyph {
  /** Bravura 字符 */
  glyph: string;
  placement: OrnamentPlacement;
  /** 相对数字字号的缩放 */
  scale: number;
  /** 中文名，用于提示与诊断 */
  label: string;
}

/** `&xx` 记号表。名称取符号中文名的拼音首字母（两种方言一致）。 */
export const ORNAMENTS: Readonly<Record<string, OrnamentGlyph>> = {
  yc: { glyph: C(0xe4c0), placement: "above", scale: 1.0, label: "延长记号" },
  ycy: { glyph: C(0xe4c0), placement: "above", scale: 1.0, label: "延长记号" },
  bc: { glyph: C(0xe4a4), placement: "above", scale: 0.9, label: "保持音" },
  zy: { glyph: C(0xe4a0), placement: "above", scale: 0.9, label: "重音" },
  dy: { glyph: C(0xe4a2), placement: "above", scale: 0.9, label: "顿音" },
  hx: { glyph: C(0xe4ce), placement: "above", scale: 0.9, label: "呼吸记号" },
  shy: { glyph: C(0xe5d0), placement: "above", scale: 0.9, label: "上滑音" },
  xhy: { glyph: C(0xe5d3), placement: "above", scale: 0.9, label: "下滑音" },
  sby: { glyph: C(0xe56c), placement: "above", scale: 0.9, label: "上波音" },
  xby: { glyph: C(0xe56d), placement: "above", scale: 0.9, label: "下波音" },
  cy: { glyph: C(0xe566), placement: "above", scale: 0.9, label: "颤音" },
  tr: { glyph: C(0xe566), placement: "above", scale: 0.9, label: "颤音" },
};

/** 力度记号：由 Bravura 的单字母力度字形拼成（`mf` = mezzo + forte）。 */
const DYN = {
  p: C(0xe520),
  m: C(0xe521),
  f: C(0xe522),
  r: C(0xe523),
  s: C(0xe524),
  z: C(0xe525),
  n: C(0xe526),
};

export const DYNAMICS: Readonly<Record<string, string>> = {
  ppp: DYN.p + DYN.p + DYN.p,
  pp: DYN.p + DYN.p,
  p: DYN.p,
  mp: DYN.m + DYN.p,
  mf: DYN.m + DYN.f,
  f: DYN.f,
  ff: DYN.f + DYN.f,
  fff: DYN.f + DYN.f + DYN.f,
  sf: DYN.s + DYN.f,
  fp: DYN.f + DYN.p,
  sfp: DYN.s + DYN.f + DYN.p,
  sfz: DYN.s + DYN.f + DYN.z,
};

/** 术语类记号：直接排文字。 */
export const TERMS: Readonly<Record<string, string>> = {
  cresc: "cresc.",
  dim: "dim.",
  rit: "rit.",
  tempo: "a tempo",
  atempo: "a tempo",
};

/** 小节线上的反复/导航记号。 */
export const BARLINE_MARKS: Readonly<Record<string, { text?: string; glyph?: string; label: string }>> =
  {
    fine: { text: "Fine", label: "曲终" },
    dc: { text: "D.C.", label: "从头反复" },
    ds: { text: "D.S.", label: "大反复" },
    ty: { glyph: C(0xe048), label: "跳跃记号" },
    hs: { glyph: C(0xe047), label: "花 S 记号" },
    sbf: { label: "声部括弧起点" },
  };

/** 临时升降号：与 .jpwabc 谱面同一套 SMuFL 字形（不是 ♯♭♮ 文字符号）。 */
export const ACCIDENTAL_GLYPH: Readonly<Record<string, string>> = {
  flat: C(0xe260),
  natural: C(0xe261),
  sharp: C(0xe262),
  "double-sharp": C(0xe263),
  "double-flat": C(0xe264),
};

/** 连谱号（声部括弧）：SMuFL 的上下两截，中间用竖线接起来。 */
export const BRACKET = {
  top: C(0xe003), // bracketTop
  bottom: C(0xe004), // bracketBottom
  /** 花括号，用于歌词的联合括号（非等比缩放后使用） */
  brace: C(0xe000),
  /** Bravura 的可选字形：窄→宽依次 braceLarger/braceLarge/brace/braceSmall */
  braceSmall: C(0xf400),
};

/** 伴奏括弧：写在音符后的 `&zkh` / `&ykh`。 */
export const ACCOMP_BRACKET = new Set(["zkh", "ykh"]);

/** 该记号是不是「画在谱上的东西」——不是的话（如 sbf）只影响排版。 */
export function isDrawable(name: string): boolean {
  return (
    name in ORNAMENTS ||
    name in DYNAMICS ||
    name in TERMS ||
    name in BARLINE_MARKS ||
    ACCOMP_BRACKET.has(name)
  );
}
