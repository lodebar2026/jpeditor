// MusicXML **字符串生成**的公共件。五线谱识别的直出（staffomr/toxml.ts）
// 与唯一写出端的投影（model/xmlproject.ts 用 typeOfDuration）共用。
// 抽到这里的都是「几处各写一份、且已经或即将漂移」的东西——尤其是 <barline> 的子元素顺序
// （bar-style → ending → repeat，MusicXML DTD 强制），以前由几处各自记着，改一处漏一处。
// DOM 后处理那一路的工具在 ./xmldom.ts。
import { Fraction } from "../common/fraction";

export const escapeXml = (s: string): string =>
  s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));

export const escapeAttr = (s: string): string => escapeXml(s).replace(/"/g, "&quot;");

const BASES: Array<[string, number]> = [
  ["whole", 4], ["half", 2], ["quarter", 1], ["eighth", 0.5],
  ["16th", 0.25], ["32nd", 0.125], ["64th", 0.0625],
];

/** BASES 里的值都是 2 的幂或其倒数，×16 后必为整数。 */
const frac = (v: number): Fraction => new Fraction(Math.round(v * 16), 16);

/** 由总时值（四分音符为 1）反推 `<type>` + 附点数，Fraction 精确比较。 */
export function typeOfDuration(duration: Fraction): { type: string; dots: number } {
  const q = duration;
  for (const [type, val] of BASES) {
    const b = frac(val);
    if (q.equals(b)) return { type, dots: 0 };
    if (q.equals(b.times(new Fraction(3, 2)))) return { type, dots: 1 };
    if (q.equals(b.times(new Fraction(7, 4)))) return { type, dots: 2 };
  }
  for (const [type, val] of BASES) if (q.compareTo(frac(val)) >= 0) return { type, dots: 0 };
  return { type: "64th", dots: 0 };
}

export interface BarlineParts {
  /** `<bar-style>` 内容，null/undefined 则不写。 */
  style?: string | null;
  /** `<ending number>` 的值，null/undefined 则不写 `<ending>`。 */
  ending?: string | null;
  /** `<ending type>`；left 侧恒为 "start"，right 侧可为 stop/discontinue。 */
  endingType?: string;
  /** `<ending>` 的元素文本（给人看的房号，如 "1.2.3."）。空则写成自闭合元素。 */
  endingText?: string | null;
  repeat?: boolean;
}

/** `<barline>`，**子元素顺序由这里唯一保证**：bar-style → ending → repeat。
 *  repeat 方向按 location 定（left=forward、right=backward）。三项皆空则返回 ""。 */
export function barlineXml(location: "left" | "right", p: BarlineParts): string {
  const hasEnding = p.ending !== null && p.ending !== undefined;
  if (!p.style && !hasEnding && !p.repeat) return "";
  const type = p.endingType ?? (location === "left" ? "start" : "stop");
  return `<barline location="${location}">` +
    (p.style ? `<bar-style>${p.style}</bar-style>` : "") +
    (hasEnding
      ? `<ending number="${escapeAttr(p.ending!)}" type="${type}"` +
        (p.endingText ? `>${escapeXml(p.endingText)}</ending>` : "/>")
      : "") +
    (p.repeat ? `<repeat direction="${location === "left" ? "forward" : "backward"}"/>` : "") +
    `</barline>`;
}

/** `<work>`，标题为空则返回 ""。 */
export function workXml(title: string | undefined | null): string {
  return title ? `<work><work-title>${escapeXml(title)}</work-title></work>` : "";
}

/** score-partwise 文档外壳：XML 声明 + DOCTYPE + 根元素。 */
export function wrapPartwise(parts: {
  work?: string;
  identification?: string;
  credits?: string;
  partList: string;
  body: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.0">
${parts.work ?? ""}${parts.identification ?? ""}${parts.credits ?? ""}<part-list>${parts.partList}</part-list>
${parts.body}
</score-partwise>`;
}

/** `<score-part>`：不给乐器名——Dorico/MuseScore 会把 `<part-name>` 当乐器名显示在谱前，
 *  简谱没有这个概念。空内容 + print-object="no"，两种软件都不显示。 */
export function scorePartXml(id: string, name?: string): string {
  const n = name ? `<part-name>${escapeXml(name)}</part-name>` : `<part-name print-object="no"></part-name>`;
  return `<score-part id="${escapeAttr(id)}">${n}</score-part>`;
}
