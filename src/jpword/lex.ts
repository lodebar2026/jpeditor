// `.Voice` 正文的词法器。jpwabc 的乐谱正文只是一串平铺的 token（没有嵌套结构），
// 语义拆解在 `model/fromjpw.ts::readNote` 等处按 token 文本再做。
//
// 规则沿用原 JP-Word 的词法定义（见 docs/格式/jpwabc.md §4 词法表）：在当前位置把各规则都试一遍，
// **取最长匹配，等长按规则先后**；空白与 `//` 注释产出后由调用方决定跳过。
// 哪条规则都匹配不上的字符跳过 1 个，不报错（与原实现一样静默丢弃）。

export type JpwTok =
  | "preludeBeg" // `(`：前奏开始
  | "preludeEnd" // `)`：前奏结束
  | "note"
  | "lbrack" // 落单的 `[`（正文里出现即解析失败）
  | "rbrack" // 落单的 `]`（同上）
  | "barline"
  | "rbrace" // 落单的 `)`：等长时让给 preludeEnd，实际不会产出
  | "return" // `$(...)` 换行
  | "timesig"
  | "string"
  | "comment"
  | "ws";

export interface JpwToken {
  type: JpwTok;
  text: string;
  /** 在输入里的 [start, end) 偏移（UTF-16 码元） */
  start: number;
  end: number;
  /** 起点的 0 基行号与列（行以 `\n` 分） */
  line: number;
  column: number;
}

// ---- 片段 ----
const DIGIT = "[0-9]";
const INTEGER = `${DIGIT}+`;
const FLOAT = `[-+]?${DIGIT}*\\.${DIGIT}+`;
const NUMBER = `(?:${FLOAT}|${INTEGER})`;
const HEXQUAD = "[a-fA-F0-9]{4}";
const UNICHAR = `(?:\\\\x${HEXQUAD}|[\\u0100-\\udbff])`;
const PITCH = `(?:(?:#b|b|#)?[0-7][,'gd]*|[xX]${UNICHAR}?)`;
const DURATION = "(?:-+|_+\\.*|\\.*_+|\\.+)";
const VALUE = `(?:[tT][rR][uU][eE]|[fF][aA][lL][sS][eE]|${NUMBER})`;
const PARAMLIST = `\\((?:${VALUE}|,)*\\)`;
const CONTROLTYPE = "(?:UnderlineOnly|Unconnect|Connect|Other|None|All)";
const CONTROL = `(?:\\{C:${NUMBER}(?:${PARAMLIST})?(?:,${CONTROLTYPE})*\\}|\\{C:0,,\\})`;
const SLURSTART = `(?:\\(|\\{\\((?:,(?:${FLOAT})?|0:0,${FLOAT},${INTEGER})\\})`;
const TUPLET = "\\{\\([0-9]\\}";
const ARTICULATION = "(?:DunYin|BoYin|YanYin|ZhongYin)";
const ARTICULATIONS = `\\{${ARTICULATION}(?:,${ARTICULATION})*\\}`;
const GRACE = `\\{${PITCH}+\\}`;
const CHORD = `\\[${PITCH}+\\]`;
const HOUSE = `\\[(?:结束句|${DIGIT}+\\.)`;
const BARLINETYPE = "(?:\\[\\|\\]|:\\|:|\\|\\||\\|\\]|\\|:|:\\||::|\\|)";
const ESCAPE = `(?:\\\\[sbtnfr"'\\\\]|\\\\x${HEXQUAD}|\\\\0${DIGIT}{4})`;

// ---- 规则（顺序即等长时的优先级）----
const RULES: [JpwTok, RegExp][] = (
  [
    ["preludeBeg", `\\(${CONTROL}?`],
    ["preludeEnd", `\\)${CONTROL}?`],
    ["note", `${SLURSTART}*${CONTROL}?(?:${TUPLET})?(?:${ARTICULATIONS})?(?:${GRACE})?(?:${PITCH}|${CHORD})${DURATION}?${CONTROL}?\\)*`],
    ["lbrack", "\\["],
    ["rbrack", "\\]"],
    ["barline", `${BARLINETYPE}${CONTROL}?(?:${HOUSE})?`],
    ["rbrace", "\\)"],
    ["return", `\\$(?:${PARAMLIST})?`],
    ["timesig", `${INTEGER}/${INTEGER}${CONTROL}?`],
    ["string", `"(?:${ESCAPE}|[^"\\\\])*?"`],
    ["comment", "//[^\\r\\n]*"],
    ["ws", "[ \\t\\r\\n]+"],
  ] as [JpwTok, string][]
).map(([t, src]) => [t, new RegExp(src, "y")]);

/** 把 `.Voice` 正文切成 token（含 ws/comment）。认不出的字符静默跳过。 */
export function lexVoice(text: string): JpwToken[] {
  const out: JpwToken[] = [];
  let pos = 0;
  let line = 0;
  let lineStart = 0;
  const advance = (to: number): void => {
    for (let i = pos; i < to; i++) {
      if (text.charCodeAt(i) === 10) {
        line++;
        lineStart = i + 1;
      }
    }
    pos = to;
  };
  while (pos < text.length) {
    let best: JpwTok | null = null;
    let bestLen = 0;
    for (const [type, re] of RULES) {
      re.lastIndex = pos;
      const m = re.exec(text);
      if (m && m[0].length > bestLen) {
        best = type;
        bestLen = m[0].length;
      }
    }
    if (best === null) {
      advance(pos + 1);
      continue;
    }
    out.push({ type: best, text: text.substr(pos, bestLen), start: pos, end: pos + bestLen, line, column: pos - lineStart });
    advance(pos + bestLen);
  }
  return out;
}
