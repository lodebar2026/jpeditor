// `<harmony>` → 和弦符号文本（"Am7"、"G/B"、"Fsus4"）。
//
// 是 score/harmonyxml.ts 的反向：那边把文本写成 MusicXML，这边读回来。
// 两边的 kind 映射必须对得上，否则往返一趟和弦就变了样。
//
// 为什么要读进 Score：成书重排要把和弦排到谱面上，而 loadMusicXml 原本整个跳过 harmony
//（docs/架构与实现.md 记的「.jpwabc/Score 装不下和弦」说的是 **jpwabc 那条路**，Score 这边只是一直没做）。
// 导出侧的既定约束不变：musicxmlpatch 仍然不碰 harmony。
//
// 无 DOM 依赖之外的东西（用的是 Element，浏览器/DOMParser 环境下调用）。

/** kind 值 → 后缀。与 harmonyxml.ts::kindOf 互逆（那边是后缀 → kind）。 */
const KIND_SUFFIX: Record<string, string> = {
  major: "",
  minor: "m",
  dominant: "7",
  "major-seventh": "maj7",
  "minor-seventh": "m7",
  diminished: "dim",
  "diminished-seventh": "dim7",
  augmented: "aug",
  "suspended-fourth": "sus4",
  "suspended-second": "sus2",
  "major-sixth": "6",
  "minor-sixth": "m6",
  "dominant-ninth": "9",
  "major-ninth": "maj9",
  "minor-ninth": "m9",
  "half-diminished": "m7-5",
  power: "5",
  none: "",
  other: "",
};

const alterSign = (v: number): string => (v > 0 ? "♯".repeat(v) : v < 0 ? "♭".repeat(-v) : "");

function textOf(parent: Element, tag: string): string | null {
  const el = parent.getElementsByTagName(tag)[0];
  return el ? (el.textContent ?? "").trim() : null;
}

function numOf(parent: Element, tag: string): number {
  const t = textOf(parent, tag);
  return t ? Number(t) || 0 : 0;
}

/** @returns 和弦文本；不是可用的和弦（无根音）时返回 null。 */
export function harmonyElemToText(el: Element): string | null {
  const step = textOf(el, "root-step");
  if (!step) return null;
  let out = step + alterSign(numOf(el, "root-alter"));

  const kindEl = el.getElementsByTagName("kind")[0];
  if (kindEl) {
    // Finale 会把用户敲的原文放在 text 属性里（"sus4"、"m7"…），那比 kind 值更准
    const raw = (kindEl.getAttribute("text") ?? "").trim();
    out += raw || KIND_SUFFIX[(kindEl.textContent ?? "").trim()] || "";
  }
  // 附加音（add9 / -5 之类）
  for (const d of Array.from(el.getElementsByTagName("degree"))) {
    const v = textOf(d, "degree-value");
    const t = (textOf(d, "degree-type") ?? "add").toLowerCase();
    if (!v) continue;
    const a = alterSign(numOf(d, "degree-alter"));
    out += t === "subtract" ? `omit${v}` : t === "alter" ? `${a}${v}` : `add${a}${v}`;
  }

  const bass = textOf(el, "bass-step");
  if (bass) out += `/${bass}${alterSign(numOf(el, "bass-alter"))}`;
  return out;
}
