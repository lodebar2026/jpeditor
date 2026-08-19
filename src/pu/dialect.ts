// 文本谱的两种方言与自动嗅探。
//
// - tomato：番茄简谱脚本 v1.0
// - shige ：诗歌本文本谱，番茄的变种
//
// 两家在**同一个字符上给了不同含义**，所以解析器必须先定方言再动手：
//   高低音   番茄 `'`/`,`     有谱 `g`/`d`
//   升降还原 番茄 `#`/`$`/`=` 有谱 `#♯`/`b♭`/`♮`（另有重升 `𝄪` 重降 `𝄫`）
//   数字 9   番茄是**节奏音符 X**；有谱是**隐藏休止（不跟词）**
//   节奏音符 番茄 `9`；有谱字母 `X`
// 靠扩展名分不开（两家都可能是 .txt），但头部字段互不兼容，够判。

import type { Accidental } from "./ast";

export type Dialect = "tomato" | "shige";

export interface DialectSpec {
  id: Dialect;
  name: string;
  /** 升高一个八度的字符 */
  octaveUp: string;
  /** 降低一个八度的字符 */
  octaveDown: string;
  /** 变音记号字符 → 语义（均写在数字**后方**） */
  accidentals: Readonly<Record<string, Accidental>>;
  /** 节奏音符的写法 */
  rhythmToken: string;
  /** 数字 9 是不是节奏音符（番茄）——否则是隐藏休止（有谱） */
  nineIsRhythm: boolean;
  /** 歌词里表示「跳过一个音符」的字符 */
  lyricSkip: readonly string[];
  /** 小节线写法，按**从长到短**匹配 */
  barlines: ReadonlyArray<readonly [string, import("./ast").BarlineType]>;
}

const TOMATO: DialectSpec = {
  id: "tomato",
  name: "番茄简谱",
  octaveUp: "'",
  octaveDown: ",",
  accidentals: { "#": "sharp", $: "flat", "=": "natural" },
  rhythmToken: "9",
  nineIsRhythm: true,
  lyricSkip: ["@"],
  // `||/` 必须排在 `||` 之前，否则永远匹配不到两边细双线。
  barlines: [
    [":|:", "repeat-both"],
    [":||", "repeat-end"],
    ["||/", "double"],
    ["|:", "repeat-start"],
    [":|", "repeat-end"],
    ["||", "end"],
    ["|/", "hidden"],
    ["|*", "invisible"],
    ["|", "normal"],
  ],
};

const SHIGE: DialectSpec = {
  id: "shige",
  name: "诗歌本文本谱",
  octaveUp: "g",
  octaveDown: "d",
  accidentals: {
    "#": "sharp",
    "\u266F": "sharp", // ♯
    b: "flat",
    "\u266D": "flat", // ♭
    "\u266E": "natural", // ♮
    "\u{1D12A}": "double-sharp", // 𝄪
    "\u{1D12B}": "double-flat", // 𝄫
  },
  rhythmToken: "X",
  nineIsRhythm: false,
  lyricSkip: ["@", "/"],
  // 诗歌本的小节线是 `| || ||| |: :| :|:`：`|||` 才是左细右粗的终止线。
  barlines: [
    [":|:", "repeat-both"],
    ["|||", "end"],
    // 规范未列 `||/`，但实际谱面里大量使用（沿用番茄的「两边细双线」）。
    ["||/", "double"],
    ["|:", "repeat-start"],
    [":|", "repeat-end"],
    ["||", "double"],
    ["|/", "hidden"],
    ["|*", "invisible"],
    ["|", "normal"],
  ],
};

export const DIALECTS: Readonly<Record<Dialect, DialectSpec>> = { tomato: TOMATO, shige: SHIGE };

export function dialectSpec(d: Dialect): DialectSpec {
  return DIALECTS[d];
}

/** 头部字段名 → 哪个方言独有。两边都有的（Z/J/Q/C/W）不计分。 */
const TOMATO_KEYS = /^\s*(V|B|D|P)\s*:/;
const SHIGE_KEYS = /^\s*(T|XL|XR|TL|TR|BL|BC|BR|FontSize|Margin)\s*:/i;
/** 有谱的调号拍号写成 `1=C4/4`，番茄拆成 `D:` + `P:` */
const SHIGE_KEY_METER = /^\s*1\s*=/;

export interface SniffResult {
  dialect: Dialect | null;
  /** 判据说明，认不出时用于报错 */
  reason: string;
}

/**
 * 按头部字段判方言。看不出（既没有任一方独有字段、也没有 Q:/C: 行）就返回 null，
 * 由调用方报错——`.txt` 扩展名太泛，宁可不认也别硬解成一首乱谱。
 */
export function sniffDialect(text: string): SniffResult {
  let tomato = 0;
  let shige = 0;
  let hasBody = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (TOMATO_KEYS.test(line)) tomato++;
    if (SHIGE_KEYS.test(line)) shige++;
    if (SHIGE_KEY_METER.test(line)) shige += 2; // `1=G4/4` 是有谱的强特征
    if (/^\s*[QCW]\d*\s*[<"]?/.test(line) && /^\s*[QCW]\d*(?:"[^"]*"|<[^>]*>)?\s*:/.test(line)) {
      hasBody = true;
    }
  }
  if (tomato === 0 && shige === 0) {
    return {
      dialect: null,
      reason: hasBody
        ? "找到了 Q:/C: 谱行，但没有任何头部字段，无法判断是番茄还是诗歌本文本谱"
        : "不像文本谱：既没有头部字段，也没有 Q:/C: 谱行",
    };
  }
  if (tomato > shige) return { dialect: "tomato", reason: `番茄头部字段 ${tomato} 项` };
  if (shige > tomato) return { dialect: "shige", reason: `诗歌本头部字段 ${shige} 项` };
  // 打平时偏番茄：它是原始规范，有谱是其变种。
  return { dialect: "tomato", reason: "两方言特征持平，按番茄解析" };
}
