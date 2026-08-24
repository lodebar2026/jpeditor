// 和弦符号的富文本分段与绘制——五线谱与文本谱共用。
//
// 和弦符号不是一串普通文字：根音的升降号要用 SMuFL 的 csym 小号字形，后缀（7 / maj7 /
// sus4 …）要上标，`m` 留在基线，低音 `/G` 跟在后面。五线谱那侧原本把这套排版逻辑
// 内联在 drawHarmony 里，这里抽出来，文本谱直接复用同一套，两边观感才一致。

import { GlyphCodes } from "../smufl/smufl";
import { Font } from "./font";
import { Group, TextFrame } from "./layout";
import { Matrix33 } from "../common/geom";

/** 和弦符号的一段：文字或 SMuFL 字形，可上标（1）/下标（-1）。 */
export interface HarmonySeg {
  text: string;
  music: boolean;
  superscript: number;
  dy: number;
}

/** 分段总宽（未缩放的 advance 之和，与居中口径一致）。 */
export function harmonyWidth(segs: readonly HarmonySeg[], wordFont: Font, musicFont: Font): number {
  let w = 0;
  for (const s of segs) w += (s.music ? musicFont : wordFont).measureText(s.text);
  return w;
}

/**
 * 把分段排成一个 Group（原点在左侧基线）。上标缩到 75% 并上移 1/4 字号。
 * 由 mixed/render.ts::drawHarmony 与文本谱共用。
 */
export function layoutHarmonySegs(
  segs: readonly HarmonySeg[],
  wordFont: Font,
  musicFont: Font,
  color: number,
): Group {
  const grp = new Group();
  // 标记成和弦：成书重排把页面树扁平化成 DrawList 时靠它认角色（选字体、选是否走轮廓）。
  // 不标的话这几个 TextFrame 只是「小一号的普通文字」，会被当歌词排。
  grp.classes.add("chord");
  let xpos = 0;
  for (const s of segs) {
    const font = s.music ? musicFont : wordFont;
    const t = new TextFrame();
    t.classes.add(s.music ? "chord-music" : "chord");
    // 音乐字体（Bravura）的全局 ascent/descent 是 4 个字号高，不能拿它当行高
    t.inkBound = s.music;
    t.text = s.text;
    t.font = font;
    t.color = color;
    let scl = 1;
    if (s.superscript === 1 || s.superscript === -1) {
      scl = 0.75;
      const dy = s.superscript === 1 ? -font.size / 4 : font.size / 4;
      const g = new Group();
      const m = new Matrix33();
      m.setAffine([scl, 0, 0, scl, xpos, dy]);
      g.matrix = m;
      g.add(t);
      grp.add(g);
    } else {
      t.x = xpos;
      t.y = s.dy;
      grp.add(t);
    }
    xpos += font.measureText(s.text) * scl;
  }
  return grp;
}

const SHARP_CHARS = "#♯";
const FLAT_CHARS = "b♭";

/** 根音/低音的「字母 + 升降号」。 */
function pushStepAlter(segs: HarmonySeg[], letter: string, accidental: string): void {
  segs.push({ text: letter, music: false, superscript: 0, dy: 0 });
  // 注意：String.includes("") 恒为真，没有升降号时必须先挡掉空串
  if (accidental === "") {
    return;
  }
  if (SHARP_CHARS.includes(accidental)) {
    segs.push({ text: GlyphCodes.csymAccidentalSharp, music: true, superscript: 0, dy: 0 });
  } else if (FLAT_CHARS.includes(accidental)) {
    segs.push({ text: GlyphCodes.csymAccidentalFlat, music: true, superscript: 0, dy: 0 });
  }
}

/** 后缀里能直接用 SMuFL 记号表示的质量。 */
const QUALITY_SYMBOL: ReadonlyArray<[RegExp, string]> = [
  [/^(?:ø|m7b5|min7b5|halfdim)/i, GlyphCodes.csymHalfDiminished],
  [/^(?:aug|\+)/, GlyphCodes.csymAugmented],
  [/^(?:dim|°|o)(?![a-z])/i, GlyphCodes.csymDiminished],
];

/**
 * 把和弦**文字**（`Cm`、`B♭7`、`C♯m`、`Fm/A♭`、`Cadd9`）解析成分段。
 *
 * 文本谱里和弦本来就是写死的字符串（`"hx:C♯m"` 或不带引号的 `Dm`），没有 MusicXML
 * 那样的 kind/degree 结构，所以按写法拆：根音 → 质量后缀 → `/低音`。
 * 认不出来的整段按原文排，不猜。
 */
export function chordTextSegs(text: string): HarmonySeg[] {
  const segs: HarmonySeg[] = [];
  const src = text.trim();
  const root = /^([A-G])([#♯b♭]?)/.exec(src);
  if (!root) {
    // 不是「字母打头」的和弦（例如汉字注记），原样排
    return [{ text: src, music: false, superscript: 0, dy: 0 }];
  }
  pushStepAlter(segs, root[1]!, root[2] ?? "");
  let rest = src.slice(root[0].length);

  // 低音：`/G`、`/A♭`
  let bass = "";
  const slash = rest.indexOf("/");
  if (slash >= 0) {
    bass = rest.slice(slash + 1);
    rest = rest.slice(0, slash);
  }

  // 前导 m 留在基线（与五线谱侧一致），其余后缀上标
  if (/^m(?!aj)/i.test(rest)) {
    segs.push({ text: "m", music: false, superscript: 0, dy: 0 });
    rest = rest.slice(1);
  }
  if (rest) {
    let matched = false;
    for (const [re, sym] of QUALITY_SYMBOL) {
      const m = re.exec(rest);
      if (!m) continue;
      segs.push({ text: sym, music: true, superscript: 1, dy: 0 });
      rest = rest.slice(m[0].length);
      matched = true;
      break;
    }
    if (rest) {
      // 后缀里的升降号也用 csym 字形（`C7♭9`）
      for (const part of rest.split(/([#♯b♭])/).filter(Boolean)) {
        if (SHARP_CHARS.includes(part) && part.length === 1) {
          segs.push({ text: GlyphCodes.csymAccidentalSharp, music: true, superscript: 1, dy: 0 });
        } else if (FLAT_CHARS.includes(part) && part.length === 1 && matched) {
          segs.push({ text: GlyphCodes.csymAccidentalFlat, music: true, superscript: 1, dy: 0 });
        } else {
          segs.push({ text: part, music: false, superscript: 1, dy: 0 });
        }
      }
    }
  }

  if (bass) {
    segs.push({ text: "/", music: false, superscript: 0, dy: 0 });
    const b = /^([A-G])([#♯b♭]?)/.exec(bass);
    if (b) pushStepAlter(segs, b[1]!, b[2] ?? "");
    else segs.push({ text: bass, music: false, superscript: 0, dy: 0 });
  }
  return segs;
}
