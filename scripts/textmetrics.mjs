// 文字度量（Node 侧）。目录的引导点要填多宽、索引条目会不会撞上页码、注解正文
// 折在哪儿——这些都得知道一段字有多宽，而排版引擎在浏览器里、pdf-lib 只管画。
//
// **与 pdfwrite.mjs 用同一份字节**（都走 scripts/fontres.mjs::resolveBookFonts），
// 量出来的宽度才和最后画出来的一致；各自去系统里找一次字体的话，
// .ttc 抽出来的子字体可能不是同一个 face。
import { resolveBookFonts } from "./fontres.mjs";
import { BOOK_MODE, makeTrim, punctRules } from "./punctshape.mjs";

/** BookStyle → { advance(role, text, size), ink, hasGlyph, punctTrim, missing } */
export async function makeMetrics(style) {
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  const { pairTrimPx, compressRun } = await punctRules();
  const { fonts, missing } = await resolveBookFonts(style);
  const metrics = new Map();
  for (const [id, f] of Object.entries(fonts)) metrics.set(id, fontkit.create(Buffer.from(f.bytes)));

  const chainOf = (role) => {
    const main = style.roles[role]?.font;
    return [main, ...Object.keys(fonts).filter((id) => id !== main)].filter((id) => id && fonts[id]);
  };
  const has = (id, ch) => {
    const cp = ch.codePointAt(0);
    const m = metrics.get(id);
    try {
      return cp !== undefined && (m?.hasGlyphForCodePoint ? m.hasGlyphForCodePoint(cp) : !!m);
    } catch {
      return false;
    }
  };
  const fontFor = (role, ch) => chainOf(role).find((id) => has(id, ch)) ?? chainOf(role)[0] ?? null;

  /** 一个字两侧的实际留白（pt）。挤压量拿它封顶——只压空白，绝不压墨。 */
  const slackFor = (role, size) => (ch) => {
    const b = ink(role, ch, size);
    const a = rawAdvance(role, ch, size);
    return b ? { left: b.left, right: a - b.right } : { left: 0, right: 0 };
  };

  const trimOf = makeTrim(pairTrimPx);

  /** 相邻两个字之间的**标点挤压**量（pt）。见 scripts/punctshape.mjs。 */
  const punctTrim = (role, prev, next, size, mode = BOOK_MODE) =>
    trimOf(metrics.get(fontFor(role, next)), prev, next, size, mode, slackFor(role, size));

  /** 单个字的 advance（未挤压）。缺字按回退链换字体量。 */
  const rawAdvance = (role, ch, size) => {
    const m = metrics.get(fontFor(role, ch));
    if (!m) return 0;
    try {
      return (m.layout(ch).advanceWidth / (m.unitsPerEm || 1000)) * size;
    } catch {
      return 0; /* 缺字按 0 算，别让度量把整本弄崩 */
    }
  };

  /** 一段字的逐字笔位与总宽（pt）。**含标点挤压**，与 pdfwrite 的落字同一个 `compressRun`。 */
  const run = (role, text, size, mode = BOOK_MODE) =>
    compressRun([...text], (ch) => rawAdvance(role, ch, size), size, mode, slackFor(role, size));

  /** 一段字的宽度（pt）。折行、目录引导点、line-check 的判据都拿这个数，
   *  跟落笔的账不一致就会处处差半格。 */
  const advance = (role, text, size, mode = BOOK_MODE) => run(role, text, size, mode).width;

  /** 一个字的**墨迹**左右缘（相对落笔点，pt）。判「压没压到字」要按墨迹算，
   *  按 advance 算会把标点的两侧留白也算成墨（全角逗号的墨只占右下角一小块）。 */
  const ink = (role, ch, size) => {
    const m = metrics.get(fontFor(role, ch));
    if (!m) return null;
    try {
      const g = m.layout(ch).glyphs[0];
      const b = g?.bbox;
      if (!b || !Number.isFinite(b.minX)) return null;
      const upem = m.unitsPerEm || 1000;
      // y 方向也给出来：字形的 bbox 是**字体坐标**（y 向上为正），转成页面坐标
      //（相对基线，向下为正）时要翻号——`maxY` 是墨迹上缘、`minY` 是下缘。
      return {
        left: (b.minX / upem) * size,
        right: (b.maxX / upem) * size,
        top: Number.isFinite(b.maxY) ? (-b.maxY / upem) * size : undefined,
        bottom: Number.isFinite(b.minY) ? (-b.minY / upem) * size : undefined,
      };
    } catch {
      return null;
    }
  };

  return { advance, run, rawAdvance, ink, punctTrim, hasGlyph: (role, ch) => has(fontFor(role, ch), ch), missingFonts: missing };
}
