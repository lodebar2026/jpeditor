// 页眉字段在原文里的位置（标题、副标题、署名、调号拍号…）。
//
// 模型里这些字段不记原文位置（`Work.title`、`Creator.text` 都只是字符串），可视化编辑要点谱面上的标题跳到原文、
// 光标停在 `T:` 行时点亮标题，就按格式从原文里认出字段行（`EditDialect.headerFields`）。
// 谱面那一侧按**字**对上（`App._bindHeader`：画出来的字包含原文的值，或反过来），调号、拍号按 `role` 对。

export interface HeaderField {
  /** 字段值在原文里的区间（两端空白去掉） */
  from: number;
  to: number;
  /** 文字按字对；调号、拍号的字与原文写法不同（`bB` 画成 `♭B`、`3/4` 画成上下叠排），按角色对。
   *  `keytime` 是一个字段写了两样（文本谱 `1=C4/4`、`.jpwabc` 的 `KeyAndMeters`） */
  role: HeaderRole;
}

export type HeaderRole = "text" | "key" | "time" | "keytime";

/** 按行认 `键: 值` 形的字段。`keys` 给出要认的键与它的角色；调号、拍号每个键只认第一处（后面的是曲中转调）。
 *  `keyLine` 认调号拍号写成一行的（文本谱 `1=C4/4`）。 */
export function colonFields(text: string, keys: Readonly<Record<string, HeaderRole>>, keyLine?: RegExp): HeaderField[] {
  const out: HeaderField[] = [];
  const seenKey = new Set<string>();
  let at = 0;
  for (const raw of text.split("\n")) {
    const lineStart = at;
    at += raw.length + 1;
    const line = raw.replace(/\r$/, "");
    const m = /^(\s*)([A-Za-z]+)\s*:/.exec(line);
    if (m) {
      const k = m[2]!;
      const role = keys[k];
      if (role === undefined) continue;
      if (role !== "text") {
        if (seenKey.has(k)) continue;
        seenKey.add(k);
      }
      const span = trimmed(line, m[0].length, line.length);
      if (span) out.push({ from: lineStart + span[0], to: lineStart + span[1], role });
      continue;
    }
    // 文本谱把调号拍号写成一行 `1=C4/4`
    if (keyLine && keyLine.test(line) && !seenKey.has("keyLine")) {
      seenKey.add("keyLine");
      const span = trimmed(line, 0, line.length);
      if (span) out.push({ from: lineStart + span[0], to: lineStart + span[1], role: "keytime" });
    }
  }
  return out;
}

/** `.jpwabc` 的 `.Title` 段：`Title = {t}`、`KeyAndMeters = {1=C,4/4}`……值取花括号里面（没有花括号取 `=` 后面）。 */
export function jpwTitleFields(text: string): HeaderField[] {
  const out: HeaderField[] = [];
  let at = 0;
  let inTitle = false;
  for (const raw of text.split("\n")) {
    const lineStart = at;
    at += raw.length + 1;
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(".")) {
      inTitle = line.slice(1).trim().toLowerCase() === "title";
      continue;
    }
    if (!inTitle) continue;
    const m = /^\s*(\w+)\s*=\s*/.exec(line);
    if (!m) continue;
    let from = m[0].length;
    let to = line.length;
    const open = line.indexOf("{", from);
    if (open === from) {
      const close = line.lastIndexOf("}");
      if (close > open) {
        from = open + 1;
        to = close;
      }
    }
    const span = trimmed(line, from, to);
    if (span) out.push({ from: lineStart + span[0], to: lineStart + span[1], role: m[1] === "KeyAndMeters" ? "keytime" : "text" });
  }
  return out;
}

/** `[from, to)` 去掉两端空白；空了返回 null。 */
function trimmed(line: string, from: number, to: number): [number, number] | null {
  while (from < to && /\s/.test(line[from]!)) from++;
  while (to > from && /\s/.test(line[to - 1]!)) to--;
  return to > from ? [from, to] : null;
}
