// 音乐字体的**字形字典**：按轮廓聚类，一类只定一次语义。
//
// 为什么不能只查码位表（`symbolmap.ts`）：同一本书里同一个字形，因为分了多个子集，
// 内容流里的码位会是 207/161/156/157/37/11/7/8/10……（子集按首次使用顺序重编码），
// ToUnicode 也跟着摇摆。实测全书 Maestro 有 113 个不同码位，其实只有 83 个不同**字形**。
// 而轮廓在同一套字体里是逐位相同的（转的是同一份字体程序），于是：
//
//   全书 17 万个音乐字形 → 175 个形状类 → 每类定一次语义，识别时纯查表。
//
// 聚类件全部复用简谱那条路的 `src/omr/glyphdict.ts`（`shapeKey` 精确键 + 32×32 `shapeSig`
// 最近邻），**别在这里另写一套**。两处唯一的差别是喂进去的轮廓来源不同：
// 那边是 `VecObj.data`（转曲路径），这边是 `VecGlyph.outline`（字体程序里的字形）。
//
// 无 DOM 依赖。
import { shapeKey, shapeSig, sigDistance, encodeSig, decodeSig } from "../omr/glyphdict";
import type { VecGlyph, VecTextRun } from "../omr/vectext";
import type { SmuflName } from "./glyphs";
import { isSmuflName } from "./glyphs";
import { guessByCode, musicFamily } from "./symbolmap";

/** 一个形状类。 */
export interface StaffGlyphClass {
  /** `shapeKey`（轮廓按高度归一 + 量化后的哈希）。 */
  key: string;
  /** 字体家族（`musicFamily` 的结果）。不同家族的同形状不并——语义可能不同。 */
  family: string;
  /** 定案的 SMuFL 名；未定为 null。 */
  smufl: SmuflName | null;
  /** 定案来源，可信度依次递减：
   *  `table` = `symbolmap.ts` 的码位表自举；`merge` = 分身归并时从同组取齐；
   *  `manual` = 人工确认表定的。 */
  source: "table" | "merge" | "manual" | null;
  /** 实例数（全书）。 */
  count: number;
  /** 见过的码位与 ToUnicode 码点，排查用。 */
  codes: number[];
  unicodes: number[];
  /** `(码位, ToUnicode 码点)` 配对，去重。自举查表用的是它，不是上面两个集合。 */
  pairs: [number, number][];
  /** 相对字号的宽高中位数（em）。判「这形状大小对不对」用。 */
  w: number;
  h: number;
  /** 32×32 签名（base64），归并分身与形近匹配用。 */
  sig: string;
  /** 代表实例的轮廓（SVG path 的 d，字形坐标系），人工确认表画它。 */
  d: string;
  /** 第一次见到它的页号，排查用。 */
  page: number;
}

export interface StaffGlyphDict {
  book: string;
  classes: StaffGlyphClass[];
}

/** 类的唯一键：家族 + 形状。 */
export const classId = (family: string, key: string): string => family + "|" + key;

// ── 建库 ────────────────────────────────────────────────────────────────────

/** 累积器：脚本逐页喂字形，最后 `finish()` 出字典。 */
export class StaffGlyphBuilder {
  private map = new Map<string, StaffGlyphClass & { ws: number[]; hs: number[] }>();

  /** 喂一页的文字对象。非音乐字体、没有轮廓的一律跳过。 */
  addPage(runs: VecTextRun[], page: number): void {
    for (const r of runs) {
      const fam = musicFamily(r.font);
      if (!fam) continue;
      for (const g of r.glyphs) this.add(fam, r, g, page);
    }
  }

  private add(family: string, run: VecTextRun, g: VecGlyph, page: number): void {
    if (!g.outline || !g.outline.length) return;
    const key = shapeKey(g.outline);
    const id = classId(family, key);
    let c = this.map.get(id);
    if (!c) {
      c = {
        key,
        family,
        smufl: null,
        source: null,
        count: 0,
        codes: [],
        unicodes: [],
        pairs: [],
        w: 0,
        h: 0,
        sig: encodeSig(shapeSig(g.outline)),
        d: outlineToPath(g.outline),
        page,
        ws: [],
        hs: [],
      };
      this.map.set(id, c);
    }
    c.count++;
    if (!c.codes.includes(g.code)) c.codes.push(g.code);
    const u = g.unicode ? g.unicode.codePointAt(0) ?? 0 : 0;
    if (u && !c.unicodes.includes(u)) c.unicodes.push(u);
    if (!c.pairs.some((p) => p[0] === g.code && p[1] === u)) c.pairs.push([g.code, u]);
    // 宽高按字号归一（同一形状印大印小都该落进同一类）
    if (run.sizeDev > 0 && c.ws.length < 400) {
      c.ws.push(g.bbox.w / run.sizeDev);
      c.hs.push(g.bbox.h / run.sizeDev);
    }
  }

  finish(book: string): StaffGlyphDict {
    const classes: StaffGlyphClass[] = [];
    for (const c of this.map.values()) {
      const { ws, hs, ...rest } = c;
      classes.push({ ...rest, w: median(ws), h: median(hs), codes: c.codes.sort((a, b) => a - b) });
    }
    classes.sort((a, b) => b.count - a.count);
    return { book, classes };
  }
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}

/** 轮廓（DrawOPS，字形坐标 em=1、y 向上）→ SVG path 的 `d`。 */
export function outlineToPath(data: Float32Array, precision = 4): string {
  // 与 vector.ts::toSvgPath 同一套编码，但那份在 vector.ts 里对的是路径对象；
  // 这里坐标只有 0~1 量级，精度要给够（默认 2 位会把符头压成方块）。
  const f = (v: number) => Number(v.toFixed(precision)).toString();
  let d = "";
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    switch (c) {
      case 0:
        d += `M${f(data[i])} ${f(data[i + 1])}`;
        i += 2;
        break;
      case 1:
        d += `L${f(data[i])} ${f(data[i + 1])}`;
        i += 2;
        break;
      case 2:
        d += `C${f(data[i])} ${f(data[i + 1])} ${f(data[i + 2])} ${f(data[i + 3])} ${f(data[i + 4])} ${f(data[i + 5])}`;
        i += 6;
        break;
      case 3:
        d += `Q${f(data[i])} ${f(data[i + 1])} ${f(data[i + 2])} ${f(data[i + 3])}`;
        i += 4;
        break;
      case 4:
        d += "Z";
        break;
      default:
        return d;
    }
  }
  return d;
}

// ── 自举与归并 ──────────────────────────────────────────────────────────────

/**
 * 用 `symbolmap.ts` 的码位表给类打标（自举）。
 *
 * 一个类见过好几个 `(码位, ToUnicode)` **配对**（同一字形分在好几个子集里）。
 * 逐对查表投票，取票数最高的。**别把码位与 unicode 拆成两个集合做叉乘**——
 * 那会让 A 子集的码位配上 B 子集的 unicode，查出根本不存在的组合。
 * 全对落空就留 null，等人工确认表。
 */
export function bootstrapByTable(dict: StaffGlyphDict): number {
  let n = 0;
  for (const c of dict.classes) {
    if (c.smufl) continue;
    const votes = new Map<SmuflName, number>();
    for (const [code, uni] of c.pairs) {
      const g = guessByCode(c.family, uni, code);
      if (g) votes.set(g, (votes.get(g) ?? 0) + 1);
    }
    if (!votes.size) continue;
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    c.smufl = best[0];
    c.source = "table";
    n++;
  }
  return n;
}

/**
 * 分身归并：同一个字形因为亚像素抖动落成两个 `shapeKey`（实测 Maestro 的实心符头
 * 就分成了两类）。按 32×32 签名把距离足够近的类归到一起，标注互相取齐。
 *
 * **只在同一家族内归并**——Maestro 的实心符头与 Anastasia 的形状确实相近，
 * 但两家的其它字形并不一一对应，跨家族并会把错标传染过去。
 *
 * @param maxDist 签名汉明距离上限（1024 位里差几位）。
 */
export function mergeTwins(dict: StaffGlyphDict, maxDist = 40): number {
  const byFam = new Map<string, StaffGlyphClass[]>();
  for (const c of dict.classes) {
    const a = byFam.get(c.family) ?? [];
    a.push(c);
    byFam.set(c.family, a);
  }
  let n = 0;
  for (const list of byFam.values()) {
    // 按实例数降序：多的那个是「本尊」，标注往少的那边传
    list.sort((a, b) => b.count - a.count);
    const sigs = list.map((c) => decodeSig(c.sig));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.smufl && b.smufl) continue;
        if (!a.smufl && !b.smufl) continue;
        // 宽高差太多的不是分身（符头与附点的签名都是一团黑，只有尺寸分得开）
        if (Math.abs(a.h - b.h) > 0.05 || Math.abs(a.w - b.w) > 0.05) continue;
        if (sigDistance(sigs[i], sigs[j]) > maxDist) continue;
        const src = a.smufl ? a : b;
        const dst = a.smufl ? b : a;
        dst.smufl = src.smufl;
        dst.source = "merge";
        n++;
      }
    }
  }
  return n;
}

/** 人工标注规则（`glyphmanual.json`）。**按 unicode + 尺寸匹配，不按 shapeKey**——
 *  shapeKey 是不可读的哈希，人改不动；unicode 与宽高是人在确认表上看得见的东西。 */
export interface ManualRule {
  family: string;
  /** 该类见过的任一 Unicode 码点（十进制）。 */
  uni: number;
  /** 期望的宽高（em），容差 0.02。同一个 unicode 在同一家族里可能对着两个不同字形。 */
  w: number;
  h: number;
  smufl: SmuflName;
  /** 判据/出处，写给下一个人看。 */
  note?: string;
}

/** 应用人工标注。返回命中的规则数与没命中的规则（后者说明字典变了，要回确认表看）。 */
export function applyManual(dict: StaffGlyphDict, rules: ManualRule[]): { hit: number; stale: ManualRule[] } {
  let hit = 0;
  const stale: ManualRule[] = [];
  for (const r of rules) {
    let any = false;
    for (const c of dict.classes) {
      if (c.family !== r.family) continue;
      if (!c.unicodes.includes(r.uni)) continue;
      if (Math.abs(c.w - r.w) > 0.02 || Math.abs(c.h - r.h) > 0.02) continue;
      c.smufl = r.smufl;
      c.source = "manual";
      any = true;
      hit++;
    }
    if (!any) stale.push(r);
  }
  return { hit, stale };
}

// ── 查表 ────────────────────────────────────────────────────────────────────

/** 识别时用的查表器：字形 → SMuFL 名。 */
export class StaffGlyphLookup {
  private byKey = new Map<string, SmuflName>();
  /** 字典里没有的形状：按签名找最近的类（形近兜底）。 */
  private sigs: { sig: Uint8Array; w: number; h: number; family: string; smufl: SmuflName }[] = [];
  /** 查不到的类：家族|键 → 见过几次。跑完打印出来就是「还差哪些字形」。 */
  readonly misses = new Map<string, { family: string; codes: Set<number>; n: number; d: string }>();

  constructor(dict: StaffGlyphDict) {
    for (const c of dict.classes) {
      if (!c.smufl || !isSmuflName(c.smufl)) continue;
      this.byKey.set(classId(c.family, c.key), c.smufl);
      this.sigs.push({ sig: decodeSig(c.sig), w: c.w, h: c.h, family: c.family, smufl: c.smufl });
    }
  }

  /** @param sizeDev run 的设备字号，用来把宽高归一（形近兜底要比尺寸）。 */
  lookup(font: string, g: VecGlyph, sizeDev: number): SmuflName | null {
    const fam = musicFamily(font);
    if (!fam) return null;
    if (!g.outline || !g.outline.length) {
      // 没有轮廓只能退回码位表
      return guessByCode(fam, g.unicode ? g.unicode.codePointAt(0) ?? 0 : 0, g.code);
    }
    const key = shapeKey(g.outline);
    const hit = this.byKey.get(classId(fam, key));
    if (hit) return hit;

    // 形近兜底：同家族、尺寸相当、签名最近
    const sig = shapeSig(g.outline);
    const w = sizeDev > 0 ? g.bbox.w / sizeDev : 0;
    const h = sizeDev > 0 ? g.bbox.h / sizeDev : 0;
    let best: SmuflName | null = null;
    let bestD = Infinity;
    for (const s of this.sigs) {
      if (s.family !== fam) continue;
      if (h > 0 && (Math.abs(s.h - h) > 0.05 || Math.abs(s.w - w) > 0.05)) continue;
      const d = sigDistance(s.sig, sig);
      if (d < bestD) {
        bestD = d;
        best = s.smufl;
      }
    }
    if (best && bestD <= 40) return best;

    const id = classId(fam, key);
    const m = this.misses.get(id);
    if (m) {
      m.n++;
      m.codes.add(g.code);
    } else {
      this.misses.set(id, { family: fam, codes: new Set([g.code]), n: 1, d: outlineToPath(g.outline) });
    }
    // 最后再试一次码位表（自举先验），它对了也算数
    return guessByCode(fam, g.unicode ? g.unicode.codePointAt(0) ?? 0 : 0, g.code);
  }
}
