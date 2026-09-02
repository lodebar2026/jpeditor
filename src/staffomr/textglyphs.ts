// **正文字体**的字形字典：轮廓 → 汉字。
//
// 为什么要它：本书有几档 CJK 字体的 ToUnicode 是坏的（`XA7E42585` / `X3A4DAD4C` /
// `DFYuan-Lt-HK-BF` / `DFHei-Md-HKSCS-U`），读出来是乱码；`HelveticaExt-No` 更是整体 +1 位移。
// 实测「对上的 100 首里 83 首歌词读成乱码」——不修这一档，歌词与中文标题都没法用。
//
// 修法照 500 首那条路（`src/omr/glyphdict.ts` 的三步走），条件比那边好：
// **GT 的歌词是齐的**，可以直接拿 GT 的字去给字形投票，不必先跑 OCR。
//
// 与 `staffglyphs.ts` 的分工：那份认**乐谱符号**（轮廓 → SMuFL 名，176 类）、
// 这份认**汉字**（轮廓 → 字符，几千类）。聚类件都复用 `glyphdict.ts`，别再写第三套。
import { decodeSig, encodeSig, shapeKey, shapeSig, sigDistance } from "../omr/glyphdict";
import type { VecGlyph } from "../omr/vectext";

export interface TextGlyphClass {
  /** 字体家族（已去子集前缀）+ 形状键。 */
  font: string;
  key: string;
  /** 定案的字符；未定为 null。 */
  char: string | null;
  /** 定案来源：`gt` = 拿 GT 的歌词投票投出来的；`fuzzy` = 形近匹配补的；
   *  `tounicode` = 本来就没坏。 */
  source: "gt" | "fuzzy" | "tounicode" | null;
  /** 实例数。 */
  count: number;
  /** ToUnicode 读出来的字符（可能是乱码），排查用。 */
  uni: string;
  /** 相对字号的宽高（em）。 */
  w: number;
  h: number;
  /** 得票分布（排查用，`--v` 才写出来）。 */
  tally?: [string, number][];
  /** 代表实例的轮廓（SVG path 的 d，字形坐标系）。 */
  d: string;
  /** 32×32 签名（base64），形近归并用。 */
  sig?: string;
}

export interface TextGlyphDict {
  book: string;
  classes: TextGlyphClass[];
}

export const textClassId = (font: string, key: string): string => font + "|" + key;

/** 一个字形的 32×32 签名（base64）；没有轮廓返回 undefined。 */
export function glyphSig(g: VecGlyph): string | undefined {
  return g.outline && g.outline.length ? encodeSig(shapeSig(g.outline)) : undefined;
}

/** 一个字形的类键；没有轮廓返回 null（未内嵌的西文字体，用不着查字典）。 */
export function glyphClassKey(font: string, g: VecGlyph): string | null {
  if (!g.outline || !g.outline.length) return null;
  return textClassId(font, shapeKey(g.outline));
}

/** 建库累积器。 */
export class TextGlyphBuilder {
  private map = new Map<string, TextGlyphClass & { votes: Map<string, number> }>();

  add(font: string, g: VecGlyph, sizeDev: number, dPath: () => string): void {
    const id = glyphClassKey(font, g);
    if (!id) return;
    let c = this.map.get(id);
    if (!c) {
      c = {
        font,
        key: id.slice(font.length + 1),
        char: null,
        source: null,
        count: 0,
        uni: g.unicode,
        w: sizeDev > 0 ? g.bbox.w / sizeDev : 0,
        h: sizeDev > 0 ? g.bbox.h / sizeDev : 0,
        d: dPath(),
        sig: g.outline ? encodeSig(shapeSig(g.outline)) : undefined,
        votes: new Map(),
      };
      this.map.set(id, c);
    }
    c.count++;
  }

  /**
   * 登记一次出现（还没见过就按 id 建一个空壳，见过就计数加一）。
   * 建库那一路是先跑完识别拿到 id，再回头投票，所以要能只按 id 登记。
   *
   * `meta` 里的签名与宽高是**形近补字**（`fuzzyFill`）要用的：不带过来的话
   * 所有类都没有签名，那一步一个也补不出来。
   */
  ensure(id: string, meta?: { sig?: string; w?: number; h?: number; uni?: string }): void {
    const had = this.map.get(id);
    if (had) {
      had.count++;
      if (!had.sig && meta?.sig) {
        had.sig = meta.sig;
        had.w = meta.w ?? had.w;
        had.h = meta.h ?? had.h;
      }
      return;
    }
    const i = id.indexOf("|");
    this.map.set(id, {
      font: id.slice(0, i),
      key: id.slice(i + 1),
      char: null,
      source: null,
      count: 1,
      uni: meta?.uni ?? "",
      w: meta?.w ?? 0,
      h: meta?.h ?? 0,
      d: "",
      sig: meta?.sig,
      votes: new Map(),
    });
  }

  /** 给某个类投一票（GT 自举）。 */
  vote(id: string, char: string): void {
    const c = this.map.get(id);
    if (!c) return;
    c.votes.set(char, (c.votes.get(char) ?? 0) + 1);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  /**
   * 定案。**两档规则**：
   *
   *   · **全票**（只投出过一个字）——一两票也认。汉字在一首歌里多半只出现一两次，
   *     要求票多的话覆盖率上不去；而对齐本身已经在段一级筛过了。
   *   · **多数票**：票数够（`minVotes`）且最高票占到 `minShare` 以上。
   *     只用「全票」那一档的话，常用字反而定不了案——它们在很多首歌里出现，
   *     偶尔一次对齐错位就投出一票杂音，把全票破掉
   *     （实测「永:12 遠:3 投:1」这种明确的多数票被 0.8 的门槛挡在外面）。
   *
   * 默认 2 票 / 六成是扫出来的：三票门槛少认 20 类（歌词档 81.3% → 80.7%），
   * 七成门槛少认 25 类（79.4%），五成与六成打平。
   *
   * @param minVotes  走多数票那一档至少要几票
   * @param minShare  走多数票那一档最高票要占的比例
   */
  finish(book: string, minVotes = 2, minShare = 0.6): TextGlyphDict {
    const classes: TextGlyphClass[] = [];
    for (const c of this.map.values()) {
      const { votes, ...rest } = c;
      const total = [...votes.values()].reduce((a, b) => a + b, 0);
      const best = [...votes].sort((a, b) => b[1] - a[1])[0];
      const out: TextGlyphClass = { ...rest };
      out.tally = [...votes].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const unanimous = best && best[1] === total;
      const majority = best && best[1] >= minVotes && best[1] / total >= minShare;
      if (unanimous || majority) {
        out.char = best![0];
        out.source = "gt";
      }
      classes.push(out);
    }
    classes.sort((a, b) => b.count - a.count);
    return { book, classes };
  }
}

/** 识别时用的查表器：字形 → 字符。查不到就退回 ToUnicode 的结果。 */
export class TextGlyphLookup {
  private map = new Map<string, string>();
  constructor(dict: TextGlyphDict) {
    for (const c of dict.classes) if (c.char) this.map.set(textClassId(c.font, c.key), c.char);
  }
  get size(): number {
    return this.map.size;
  }
  lookup(font: string, g: VecGlyph): string {
    const id = glyphClassKey(font, g);
    if (!id) return g.unicode;
    return this.map.get(id) ?? g.unicode;
  }
}

/**
 * **形近补字**：把还没定案的类，按 32×32 签名匹配回字典里已经认得的类。
 *
 * 为什么需要：同一个字印小一号，`shapeKey`（按高度归一 + 量化的精确哈希）就变了，
 * 于是同一个字在书里落成好几个类，只有其中一两个被 GT 投到票。
 * 500 首那本也有这一步（`gen-glyphfuzzy.mjs`），是覆盖率涨得最便宜的一招。
 *
 * 两道闸，缺一不可：
 *   · **同一字体**才比——不同字体的同一个字笔形差得远，跨字体匹配会张冠李戴；
 *   · 宽高比要相当（容差 0.08），再比签名的汉明距离。
 *
 * @param maxDist 1024 位签名里允许差几位。
 */
export function fuzzyFill(dict: TextGlyphDict, maxDist = 60): number {
  const known: { font: string; w: number; h: number; sig: Uint8Array; char: string }[] = [];
  for (const c of dict.classes) {
    if (!c.char || !c.sig) continue;
    known.push({ font: c.font, w: c.w, h: c.h, sig: decodeSig(c.sig), char: c.char });
  }
  let n = 0;
  for (const c of dict.classes) {
    if (c.char || !c.sig) continue;
    const sig = decodeSig(c.sig);
    let best: string | null = null;
    let bestD = maxDist;
    for (const k of known) {
      if (k.font !== c.font) continue;
      if (Math.abs(k.w - c.w) > 0.08 || Math.abs(k.h - c.h) > 0.08) continue;
      const d = sigDistance(k.sig, sig);
      if (d < bestD) {
        bestD = d;
        best = k.char;
      }
    }
    if (!best) continue;
    c.char = best;
    c.source = "fuzzy";
    n++;
  }
  return n;
}
