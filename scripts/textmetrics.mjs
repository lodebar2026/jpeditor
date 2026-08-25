// 文字度量（Node 侧）。目录的引导点要填多宽、索引条目会不会撞上页码、注解正文
// 折在哪儿——这些都得知道一段字有多宽，而排版引擎在浏览器里、pdf-lib 只管画。
//
// **与 pdfwrite.mjs 用同一份字节**（都走 scripts/fontres.mjs::resolveBookFonts），
// 量出来的宽度才和最后画出来的一致；各自去系统里找一次字体的话，
// .ttc 抽出来的子字体可能不是同一个 face。
import { resolveBookFonts } from "./fontres.mjs";

/** BookStyle → { advance(role, text, size), hasGlyph(role, ch), missing } */
export async function makeMetrics(style) {
  const fontkit = (await import("@pdf-lib/fontkit")).default;
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

  /** 一段字的宽度（pt）。缺字按回退链换字体量，与 pdfwrite 的落字口径一致。 */
  const advance = (role, text, size) => {
    let w = 0;
    for (const ch of [...text]) {
      const id = fontFor(role, ch);
      const m = metrics.get(id);
      if (!m) continue;
      try {
        w += (m.layout(ch).advanceWidth / (m.unitsPerEm || 1000)) * size;
      } catch {
        /* 缺字按 0 算，别让度量把整本弄崩 */
      }
    }
    return w;
  };

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
      return { left: (b.minX / upem) * size, right: (b.maxX / upem) * size };
    } catch {
      return null;
    }
  };

  return { advance, ink, hasGlyph: (role, ch) => has(fontFor(role, ch), ch), missingFonts: missing };
}
