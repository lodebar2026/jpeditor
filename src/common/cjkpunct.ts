// CJK 标点的分类与「标点挤压」（CLREQ 3.1.6）。
//
// **无 DOM 依赖**——Node CLI（scripts/textmetrics.mjs、scripts/line-check.mjs）要 import 它，
// 约束同 src/omr/vector.ts。度量一律由调用方传进来（`advanceOf`），这里只管规则。
//
// 挤压的道理：全角标点占一个字宽，但墨只占其中半格——句读点号与收尾类的右半是空的，
// 起始类的左半是空的。两个这样的标点相邻时（`：“`、`」「`），两截空白接在一起就是
// **整整一个字宽的空洞**。CLREQ 的口径是：相邻标点之间**只留半个字宽**，多出来的那半格压掉。
// 一侧是汉字时不压（`。人` 只空半格，本就是该有的呼吸），行末另有悬挂/压缩的规矩。
//
// 三条排版路（src/layout 简谱、src/pu 文本谱、src/mixed 混排）与成书重排的书级文本
// 共用这一份规则；OpenType 的 `chws` 特性做的是同一件事，字体支持时优先交给它
// （见 common/measure.ts::punctTrim），这里是**字体没有该特性时的等效实现**，
// 两条路必须给出同一个数。

/** 标点的挤压类别。 */
export type PunctClass =
  /** 起始类：左半空（`“（「`）。 */
  | "open"
  /** 收尾类：右半空（`”）」`）。 */
  | "close"
  /** 句读点号：右半空（`。，、；：！？`）。断句语义上与 close 不同，挤压行为相同。 */
  | "stop"
  /** 占满一格、两侧都不空（`…—·`）。 */
  | "middle"
  /** 不是标点（汉字、字母、数字…）。 */
  | "none";

// **只收全角形**。半身式压的是「方框里那半格空白」——ASCII 的 `(` `)` 与半角形 `｡` `､`
// 本来就没有那半格，再压就是压到墨上：注解框里的 `《有活的确据》(13首)`、词曲署名的
// `Elizabeth R.Charles(1828−1896)`、`(Fanny J.Crosby)` 全被括号压穿过（一次真事故）。
const OPEN = "“‘（「『《〈【〔［｛";
const CLOSE = "”’）」』》〉】〕］｝";
const STOP = "。，、；：！？";
const MIDDLE = "…—‥·・";

export function punctClass(ch: string): PunctClass {
  if (!ch) return "none";
  if (OPEN.includes(ch)) return "open";
  if (CLOSE.includes(ch)) return "close";
  if (STOP.includes(ch)) return "stop";
  if (MIDDLE.includes(ch)) return "middle";
  return "none";
}

/** 这个字左侧的空白占几个 em（能压掉的量）。 */
export function trimLeft(ch: string): number {
  return punctClass(ch) === "open" ? 0.5 : 0;
}

/** 这个字右侧的空白占几个 em（能压掉的量）。 */
export function trimRight(ch: string): number {
  const c = punctClass(ch);
  return c === "close" || c === "stop" ? 0.5 : 0;
}

/**
 * 相邻两个字之间该压掉几个 em。
 *
 * 两侧空白加起来超过半格就压到只剩半格：`：“` 空 1em → 压 0.5em；
 * `。人`、`人“` 只空 0.5em → 不压（那半格是该有的呼吸）。
 */
export function pairTrim(prev: string, next: string): number {
  if (!prev || !next) return 0;
  return Math.max(0, trimRight(prev) + trimLeft(next) - 0.5);
}

/** 行末那个字能悬挂/压缩出去的量（em）。行末点号与收尾类的右半格。 */
export function hangTrim(ch: string): number {
  return trimRight(ch);
}

/** 行首那个字能压掉的量（em）。行首起始类的左半格。 */
export function headTrim(ch: string): number {
  return trimLeft(ch);
}

/**
 * 挤压的档位。中文排版的标点挤压本来就有**两派**，这里两派都给：
 *
 * - `halfwidth`——**半身式**（开明式）：句读点号一律占半个字身，OpenType 的 `halt` 就是这个。
 *   传统竖排书、报纸与各家歌本走的都是它。**简谱歌词走这一档**：歌词逐字挂音符，
 *   标点不占音符格、只挂在字后，原书印的就是半身。
 * - `clreq`——**全身式 + 上下文挤压**：标点占满一格，只在**相邻标点**（`：“`、`」「`）
 *   与行首行末压掉多出来的那半格，OpenType 的 `chws` 是这个。CLREQ 3.1.6 主要描述这一路
 *   （它规定的是「至少」要在相邻处压，并不排斥半身式）。**书级正文**走这一档
 *   （注解、目录、索引、前言——那是成段的中文行文，不是逐字对位）。
 * - `none`：一律占满一格，不压。
 *
 * 歌词改走全身式会把音符间距整排撑开：实测全书 673 → 695 页，
 * 459《让我们在主里常喜乐》那样「四行各 16 拍」的规整分行也排不出来了。
 */
export type CompressMode = "clreq" | "halfwidth" | "none";

/**
 * 一个字**两侧的实际留白**（像素）：advance 减墨迹。挤压量拿它封顶——**只压空白，绝不压墨**。
 * 不给的话按「标点的半格空白是满的」算。
 */
export type Slack = (ch: string) => { left: number; right: number };

/** 相邻两个标点之间**收拢后**留多少（em）。取普通汉字之间的墨间距量级（实测 0.03~0.1em）。 */
export const PUNCT_PAIR_GAP = 0.1;

/** 这个字左侧能压掉多少（像素），受实际留白封顶。 */
function trimLeftPx(ch: string, em: number, slack?: Slack): number {
  const want = trimLeft(ch) * em;
  return slack ? Math.min(want, Math.max(0, slack(ch).left)) : want;
}

/** 这个字右侧能压掉多少（像素），受实际留白封顶。 */
function trimRightPx(ch: string, em: number, slack?: Slack): number {
  const want = trimRight(ch) * em;
  return slack ? Math.min(want, Math.max(0, slack(ch).right)) : want;
}

/** 相邻两个字之间该压掉几个 em——**按档**。`halfwidth` 档两侧的空白都压，不看上下文。 */
export function pairTrimIn(mode: CompressMode, prev: string, next: string): number {
  if (mode === "none") return 0;
  if (mode === "halfwidth") return trimRight(prev) + trimLeft(next);
  return pairTrim(prev, next);
}

/** 同上，但出**像素**且受墨迹封顶（`slack` 见上）。挤压量的规则出口。 */
export function pairTrimPx(mode: CompressMode, prev: string, next: string, em: number, slack?: Slack): number {
  if (mode === "none" || !prev || !next) return 0;
  const r = trimRightPx(prev, em, slack);
  const l = trimLeftPx(next, em, slack);
  if (mode === "halfwidth") return r + l;
  // 全身式：两截空白加起来超过半格才压，压到只剩半格
  return Math.max(0, Math.min(r + l, trimRight(prev) * em + trimLeft(next) * em - 0.5 * em));
}

/**
 * 一串字挤压后的逐字笔位与总宽。
 *
 * `advanceOf` 给单个字的 advance，`em` 是一个字宽（= font-size），
 * `slack` 给每个字两侧的实际留白——**压缩量一律受它封顶，只压空白不压墨**。
 * 不给 `slack` 就按「标点的半格空白是满的」算：`》《` 这类墨迹伸出半角格的字会压穿
 *（注解框里 `其它著名的圣诗有《…》《…》` 全书压了 104 处，就是漏了这道封顶）。
 * 返回的 `xs[i]` 是第 i 个字的落笔点（相对串首 0）。
 *
 * `halfwidth` 档要**分两头**算：起始类的墨在方框右半边，笔位得往左挪半格墨迹才落对地方
 * （`“` 的墨从 [0.5em,1em] 挪回 [0,0.5em]）；收尾类与点号的墨本来就在左半边，
 * 笔位不动、只是下一个字早半格接上。合起来正是「半角形」的样子。
 */
export function compressRun(
  chars: string[],
  advanceOf: (ch: string) => number,
  em: number,
  mode: CompressMode = "clreq",
  slack?: Slack,
): { xs: number[]; width: number } {
  const xs: number[] = [];
  let x = 0;
  /** 上一个字若是压过的标点，它在自己那半格里的右边距。相邻标点要按 `PUNCT_PAIR_GAP` 收拢。 */
  let prevPad = -1;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (mode === "halfwidth") {
      const adv = advanceOf(ch);
      const canTrim = trimLeft(ch) > 0 || trimRight(ch) > 0;
      if (!canTrim) {
        xs.push(x);
        x += adv;
        prevPad = -1;
        continue;
      }
      if (slack) {
        // **把字形放进半角格里居中**——真 `halt` 换的是窄字形，我们只能挪笔位，
        // 光压 advance 不够：方正楷体的全角 `（` 墨只有 0.26em 宽，左右各带一截边距，
        // 压掉「空的那半格」之后，剩下半格里字形自己的边距还在，
        // 「奇妙十架（第一调）」的括号两侧就各多出 0.37em 的空。
        // 半格放不下墨（墨比半个字身还宽）就按墨宽走，不压墨。
        const sk = slack(ch);
        const inkW = Math.max(0, adv - Math.max(0, sk.left) - Math.max(0, sk.right));
        const w = Math.max(0.5 * em, inkW);
        const pad = (w - inkW) / 2;
        // **相邻标点收拢**：两个标点各占半格、墨各自居中，中间就摞着两截边距
        //（`：「`、`！」` 实测 0.27em，而字与字之间只有 0.03~0.1em），看着散。
        // 传统印刷里连续标点是挨着的，这里收到与普通字距同量级。
        if (prevPad >= 0) x -= Math.max(0, prevPad + pad - PUNCT_PAIR_GAP * em);
        xs.push(x - Math.max(0, sk.left) + pad);
        x += w;
        prevPad = pad;
        continue;
      }
      prevPad = -1;
      const l = trimLeftPx(ch, em);
      xs.push(x - l);
      x += adv - l - trimRightPx(ch, em);
      continue;
    }
    prevPad = -1;
    if (i > 0 && mode !== "none") x -= pairTrimPx(mode, chars[i - 1], ch, em, slack);
    xs.push(x);
    x += advanceOf(ch);
  }
  return { xs, width: x };
}

// ─────────────────────────────────────────── 各调用点的具名字符表
//
// **只把定义集中过来，不强行统一语义**。这几张表内容各不相同，且差异都是拿具体曲子换来的
// （下面逐条注明）；合上去会改行为。要动某一张，先读它的注释。

/**
 * `layout.ts::Lyric.update` 把音节切成「左标点 / 主体 / 右标点」三段用的表。
 *
 * 含**数字 0-9**（行首的段号 `1.`）与**半角冒号**——与 Kotlin 原文的一处刻意背离：
 * 这批语料用半角冒号引出引语（376《将心给我》的 `呼召:“将心给我。”`），
 * 漏收它就当成正文的一部分，下一个字的前引号照旧悬挂过来，冒号与引号叠在一起。
 */
export const LYRIC_SPLIT_PUNCT = "1234567890.,;:'\"!?。：，；！？“”｡､";

/** `pu/parse.ts`：能自动附到前一个字后面、不占音符位的标点。 */
export const PU_LYRIC_PUNCTUATION = "，。！？、；：,.!?;:…—～~《》()（）";

/** `pu/parse.ts`：引号。左引号领起下一个字，右引号贴前一个字（正是 CLREQ 的 open/close 语义）。 */
export const PU_LYRIC_QUOTES = "“”‘’\"";

/** `mixed/model.ts::MLyric.widthInfo`：判「哪些字算 CJK 主体」时要排除的标点。 */
export const MIXED_PUNCT = "「」（），。！；：、“”？｡";

/** 折行禁则：不许出现在行首的收尾标点（`bookparts.ts::wrapText`）。 */
export const NO_LINE_START = /[，。、；：！？」』）〉》…·%,.;:!?)\]}]/;

/** 行末可悬挂出版心的标点（`scripts/line-check.mjs` 的 V3）。 */
export const HANG_PUNCT = /[，。、；：！？…”’）」』】》｡､｣,.;:!?)\]}]/u;
