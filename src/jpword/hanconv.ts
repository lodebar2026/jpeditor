// 简繁转换：整篇改写 .jpwabc 源码里的中文（歌词、标题、词曲等），不碰乐谱代码。
// 词表用 opencc-js，按方向分别动态 import（首屏不加载；t2cn 约 100KB，cn2t 约 1MB）。

export type HanDirection = "s2t" | "t2s";

type Conv = (text: string) => string;

let s2tPromise: Promise<Conv> | null = null;
let t2sPromise: Promise<Conv> | null = null;

/** 取（并缓存）某个方向的转换器；首次调用时才拉对应词表 chunk。 */
export function loadConverter(dir: HanDirection): Promise<Conv> {
  if (dir === "s2t") {
    s2tPromise ??= import("opencc-js/cn2t").then((cc) => cc.Converter({ from: "cn", to: "tw" }));
    return s2tPromise;
  }
  t2sPromise ??= import("opencc-js/t2cn").then((cc) => cc.Converter({ from: "tw", to: "cn" }));
  return t2sPromise;
}

/**
 * 判断该往哪个方向转：拿轻量的繁→简词表过一遍，文本若被改动说明含繁体字形 → 转简；
 * 否则（纯简体或无中文）→ 转繁。
 */
export async function detectDirection(text: string): Promise<HanDirection> {
  const t2s = await loadConverter("t2s");
  return t2s(text) === text ? "s2t" : "t2s";
}

/** 非 ASCII 才算「内容字符」（汉字与全角标点）；ASCII 一律是 jpwabc 代码符号，原样保留。 */
function isContentChar(ch: string): boolean {
  return ch.charCodeAt(0) > 0x7f;
}

/**
 * 把一行里的内容字符抽出来拼成一串送词表（跨过 `/` `-` `()` 等代码符号，
 * 免得 `日光/之下` 这样的词组被拆开导致词汇级转换失效），再按原位置逐字回填。
 * 转换结果长度与原串不一致时（词汇级转换偶有 1→2），退回逐字转换，保证不错位。
 */
function convertContentChars(line: string, conv: Conv): string {
  const idx: number[] = [];
  let src = "";
  for (let i = 0; i < line.length; i++) {
    if (isContentChar(line[i])) {
      idx.push(i);
      src += line[i];
    }
  }
  if (src.length === 0) return line;

  let out = conv(src);
  if (out.length !== src.length) out = Array.from(src, (ch) => conv(ch)).join("");
  if (out.length !== src.length) return line; // 仍对不齐则整行不动，宁可不转也不错位

  const chars = Array.from(line);
  for (let k = 0; k < idx.length; k++) chars[idx[k]] = out[k];
  return chars.join("");
}

// 与 WordsSection.regLrcSpec 同款的歌词段规格前缀（W1@1,1: 之类），前缀不参与转换。
const LRC_SPEC = /^W(\d+)(-(\d+))?(\([0-9a-zA-Z.,]+\))?(@(\d+),(\d+))?(\([0-9a-zA-Z.,]+\))?:/;

/** 按 .jpwabc 分段转换整篇文本：只动 .Title 的字段值与 .Words 的歌词内容。 */
export function convertJpwabcText(text: string, conv: Conv): string {
  let section = "";
  return text.split("\n").map((line) => {
    if (line.startsWith("//")) return line;
    if (line.startsWith(".")) {
      section = line.toLowerCase().substring(1).trim();
      return line;
    }
    if (section === "title") {
      // Key = Value，只转 Value（KeyAndMeters = {1=bB,4/4} 无中文，天然不受影响）。
      const eq = line.indexOf("=");
      if (eq < 0) return line;
      return line.substring(0, eq + 1) + convertContentChars(line.substring(eq + 1), conv);
    }
    if (section === "words") {
      const m = LRC_SPEC.exec(line);
      const head = m ? m[0].length : 0;
      return line.substring(0, head) + convertContentChars(line.substring(head), conv);
    }
    return line; // .Voice/.Layout/.Repeat 等不含中文的段一字不动
  }).join("\n");
}

/** 载入词表并转换整篇 .jpwabc 文本。 */
export async function convertJpwabc(text: string, dir: HanDirection): Promise<string> {
  const conv = await loadConverter(dir);
  return convertJpwabcText(text, conv);
}
