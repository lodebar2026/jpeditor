// MusicXML **字符串生成**的公共件。三条互不相干的导出路径共用：
//   score/musicxmlout.ts（Score → 全量序列化）、pu/toxml.ts（文本谱直出）、omr/musicxml.ts（识别结果直出）。
// 抽到这里的都是「三处各写一份、且已经或即将漂移」的东西——尤其是 <barline> 的子元素顺序
// （bar-style → ending → repeat，MusicXML DTD 强制），以前由三处各自记着，改一处漏两处。
// DOM 后处理那一路的工具在 ./xmldom.ts。
import type { Fraction } from "../common/fraction";

export const escapeXml = (s: string): string =>
  s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));

export const escapeAttr = (s: string): string => escapeXml(s).replace(/"/g, "&quot;");

/** Fraction 时值 → `<duration>` 的整数刻度。分母除不尽会告警（时值与 divisions 不匹配）。 */
export function durationTicks(d: Fraction, divisions: number, where = "MusicXML 导出"): number {
  const num = d.numerator * divisions;
  if (num % d.denominator !== 0) {
    console.warn(`${where}：时值 ${d} 无法被 divisions=${divisions} 整除`);
  }
  return Math.max(1, Math.round(num / d.denominator));
}

/** `<beam number="n">begin|continue|end</beam>`，按层号升序。 */
export function beamXml(beams: Map<number, string> | undefined): string {
  if (!beams) return "";
  return [...beams.entries()].sort((a, b) => a[0] - b[0])
    .map(([lv, v]) => `<beam number="${lv}">${v}</beam>`).join("");
}

/** 单个 `<lyric>`。number 可以是数字串，也可以是 "chorus"。 */
export function lyricElementXml(number: string, text: string): string {
  return `<lyric number="${escapeAttr(number)}"><syllabic>single</syllabic>` +
    `<text>${escapeXml(text)}</text></lyric>`;
}

/** `<credit>`。type 省略则不写 `<credit-type>`。 */
export function creditWordsXml(text: string, page = 1, type?: string): string {
  const t = type ? `<credit-type>${escapeXml(type)}</credit-type>` : "";
  return `<credit page="${page}">${t}<credit-words>${escapeXml(text)}</credit-words></credit>`;
}

export interface BarlineParts {
  /** `<bar-style>` 内容，null/undefined 则不写。 */
  style?: string | null;
  /** `<ending number>` 的值，null/undefined 则不写 `<ending>`。 */
  ending?: string | null;
  /** `<ending type>`；left 侧恒为 "start"，right 侧可为 stop/discontinue。 */
  endingType?: string;
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
    (hasEnding ? `<ending number="${escapeAttr(p.ending!)}" type="${type}"/>` : "") +
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
