// 和弦符号 → MusicXML `<harmony>`。文本谱直出（pu/toxml.ts）与简谱 OMR（omr/musicxml.ts）共用。
//
// 和弦在本项目里一律以**字符串**形态流转（`"Cm"` / `"B♭7"` / `"Fm/A♭"` / `"Cadd9"`），
// 排版走 layout/harmony.ts 的 chordTextSegs，导出走这里。两边都认 ASCII 与全角升降号。
import { escapeAttr, escapeXml } from "./xmlutil";


const alterOf = (acc: string): number => (acc === "#" || acc === "♯" ? 1 : acc === "b" || acc === "♭" ? -1 : 0);

/** `"C♯m"` → `<harmony>`。解析不出根音就退回 `<direction><words>`（至少把字面留在谱上）。
 *  offset 为**本音符时值内的 divisions 数**：和弦印在两音符之间的拍点上时用它表达，0/缺省即正对。 */
export function harmonyXml(chord: string, offset = 0): string {
  const m = /^([A-G])([#♯b♭]?)(.*)$/.exec(chord.trim());
  if (!m) {
    return `<direction placement="above"><direction-type><words>${escapeXml(chord)}</words>` +
      `</direction-type></direction>`;
  }
  const alter = alterOf(m[2]);
  let rest = m[3] ?? "";
  let bass = "";
  const slash = rest.indexOf("/");
  if (slash >= 0) {
    bass = rest.slice(slash + 1);
    rest = rest.slice(0, slash);
  }
  const kind = kindOf(rest);
  let xml = `<harmony><root><root-step>${m[1]}</root-step>` +
    (alter !== 0 ? `<root-alter>${alter}</root-alter>` : "") +
    `</root><kind text="${escapeAttr(rest)}">${kind}</kind>`;
  const b = /^([A-G])([#♯b♭]?)/.exec(bass);
  if (b) {
    const ba = alterOf(b[2]);
    xml += `<bass><bass-step>${b[1]}</bass-step>` +
      (ba !== 0 ? `<bass-alter>${ba}</bass-alter>` : "") + `</bass>`;
  }
  // <offset> 在 harmony 里排在 root/kind/bass 之后（MusicXML 3.0 DTD 的元素顺序）。
  if (offset > 0) xml += `<offset>${Math.round(offset)}</offset>`;
  return xml + `</harmony>`;
}

export function kindOf(suffix: string): string {
  const s = suffix.toLowerCase();
  if (s === "") return "major";
  if (/^m(?!aj)/.test(s)) return s.includes("7") ? "minor-seventh" : "minor";
  if (s.startsWith("maj7")) return "major-seventh";
  if (s.startsWith("dim")) return "diminished";
  if (s.startsWith("aug") || s === "+") return "augmented";
  if (s.startsWith("sus")) return "suspended-fourth";
  if (s === "7") return "dominant";
  if (s === "6") return "major-sixth";
  if (s === "9") return "dominant-ninth";
  return "other";
}
