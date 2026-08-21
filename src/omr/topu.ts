// 把 RecognizedScore 输出为**文本谱原文**（番茄简谱 / 诗歌本文本谱）。
//
// 与 musicxml.ts 的 toMusicXml() 平行，是识别结果的第二个 emitter。放在 src/omr/ 而不是
// src/pu/：src/pu/ 只保留「文本谱 → 模型」方向，输入既然是 OMR 的类型就归 OMR。
//
// **为什么直接从 RecognizedScore 出，而不是过一遍 Score**：
//   - 文本谱「一行 Q: 就是谱面一行」，而 RecognizedScore.rows 正是源图的行结构，天然对齐；
//   - 逐音符的多段歌词（JpNum.lyrics[verse]）原样在手，不必经 Score 的段落/副歌再拆分；
//   - 小节线位置按 row.barlineXs 落位，跨行开口小节不用像 MusicXML 那样合并再补。
//
// 方言差异一律从 dialectSpec() 取（八度字符、变音记号、节奏音符、跳词字符、小节线写法），
// **不要在两套方言之间写 if**——那正是 DialectSpec 存在的理由。

import type { RecognizedScore, JpNum, StaffRow } from "./types";
import { rright } from "./types";
import { dialectSpec, type Dialect } from "../pu/dialect";
import type { BarlineType } from "../pu/ast";
import { STEPS, tonicStep, keyAlter } from "../score/jppitch";
import type { JpwMeta, JpwRange } from "../score/jpscore";

/**
 * fifths → 调号名。与 jppitch 的主音推法同源，保证与音高换算一致。
 *
 * 升降号写在哪一侧**由方言决定，不能通用**：番茄 `D:` 两种顺序都收（`bB`/`Bb`），
 * 诗歌本的 `1=` 行却只认「字母在前」（`parseShigeKeyLine` 的 `^([A-Ga-g])([b#$♭♯]?)`），
 * 写成 `1=bB4/4` 会被读成 B 调——整首差半音，且回归只比数字时看不出来。
 */
export function keyNameOf(fifths: number, style: "prefix" | "suffix" = "prefix"): string {
  const idx = tonicStep(fifths);
  const alter = keyAlter(idx, fifths);
  const sign = alter < 0 ? "b" : alter > 0 ? "#" : "";
  return style === "suffix" ? STEPS[idx] + sign : sign + STEPS[idx];
}

/** 识别出的跳转记号 → 文本谱小节线记号（glyph.ts::BARLINE_MARKS 的命令名）。 */
const JUMP_MARK: Record<string, string> = {
  "D.C.": "dc",
  "D.S.": "ds",
  "Fine": "fine",
  "To Coda": "ty",
};

/** 一行按 barlineXs 切成小节；与 musicxml.ts::measuresOfRow 同一判据（音符左缘越过小节线即换节）。 */
function measuresOfRow(row: StaffRow): JpNum[][] {
  if (!row.barlineXs.length) return [row.nums];
  const measures: JpNum[][] = [];
  let cur: JpNum[] = [];
  let bi = 0;
  for (const n of row.nums) {
    while (bi < row.barlineXs.length && n.bbox.x > row.barlineXs[bi]!) {
      measures.push(cur);
      cur = [];
      bi++;
    }
    cur.push(n);
  }
  measures.push(cur);
  return measures.filter((m) => m.length);
}

/** 行是否以小节线收尾。否 → 末小节开口跨到下一行，行末不补小节线（与 MusicXML 那路同规矩）。 */
function rowEndsClosed(row: StaffRow): boolean {
  if (!row.nums.length || !row.barlineXs.length) return false;
  const lastRight = rright(row.nums[row.nums.length - 1]!.bbox);
  return Math.max(...row.barlineXs) >= lastRight;
}

/** 小节线类型 → 该方言的写法。方言表按「从长到短」排，这里反查取第一个匹配的。 */
function barlineCode(dialect: Dialect, type: BarlineType): string {
  const found = dialectSpec(dialect).barlines.find(([, t]) => t === type);
  return found ? found[0] : "|";
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
/** 音节尾部的标点（解析端会把它们贴到前一个字上，不占音符位）。 */
const TRAILING_PUNCT = "，。！？、；：,.!?;:…—《》()（）“”‘’\"";

/**
 * 一个识别出的歌词音节 → 文本谱写法。
 *
 * 只有「单个汉字」与「纯 ASCII 单词」能裸写：前者一字一音符，后者被解析端整段收成一个音节。
 * 其余一律用两方言通用的并字括号 `{}` 裹住，取其**原样收一个音节**的语义——
 *   - 多字（粘连误切成「哆啊」）裸写会被拆成两个音节，整行对位就错开；
 *   - 英文分音节的连字符（赞美诗里的 `How-`）在歌词行里是要被跳过的记号（同 `-` 增时线），
 *     裸写会被吞掉（判据：《主祢真伟大》第一段 16 处 `xx-` 全丢了尾巴）。
 * 尾部标点仍写在括号外——解析端会把它贴到前一字上，不占音符位，排版才对。
 */
function lyricToken(raw: string): string {
  let core = raw.replace(/[{}]/g, ""); // 括号是并字语法本身，正文里出现只会打断配对
  let tail = "";
  while (core.length > 1 && TRAILING_PUNCT.includes(core[core.length - 1]!)) {
    tail = core[core.length - 1]! + tail;
    core = core.slice(0, -1);
  }
  if (!core) return raw;
  const plain = ([...core].length === 1 && CJK_RE.test(core)) || /^[A-Za-z']+$/.test(core);
  return (plain ? core : `{${core}}`) + tail;
}

/** 相邻两个音节之间要不要插分词符：ASCII 单词紧挨着会被并成一个音节。 */
function needsSeparator(prev: string, next: string): boolean {
  return /[A-Za-z']$/.test(prev) && /^[A-Za-z']/.test(next);
}

/** 累加文本并记录区间的小工具：所有 meta 区间都由它产出，保证与文本严格同步。 */
class TextBuilder {
  private parts: string[] = [];
  private len = 0;

  push(s: string): JpwRange {
    const from = this.len;
    this.parts.push(s);
    this.len += s.length;
    return { from, to: this.len };
  }

  get text(): string {
    return this.parts.join("");
  }
}

/**
 * 圆滑线/连音线 → 文本谱的 `(` `)`（两者在文本谱里同写作弧线，不分家）。
 *
 * 配对**用队列（先开先闭）而不是栈**：`parse.ts` 的 `)` 就是 `curves.shift()`，
 * 照它配才能保证「写出去什么样、读回来就什么样」。配不上对的整条丢弃——半条弧
 * 会被下一个 `)` 认领，画出一条横跨很远的假弧（同 musicxml.ts::pairArcs 的判断）。
 * 端点落在休止符上的弧是识别错误，两端一起丢。
 *
 * 返回按**全曲音符序**索引的开/闭计数。
 */
function pairCurves(flat: readonly JpNum[]): { opens: Map<number, number>; closes: Map<number, number> } {
  const opens = new Map<number, number>();
  const closes = new Map<number, number>();
  const queue: number[] = []; // 已开未闭的弧，存起始音符序
  const bump = (m: Map<number, number>, i: number) => m.set(i, (m.get(i) ?? 0) + 1);
  flat.forEach((n, i) => {
    if (n.digit === 0) return; // 休止符上的弧端点：不开也不闭，对家因此配不上而被丢弃
    const nClose = (n.slurStop ? 1 : 0) + (n.tieStop ? 1 : 0);
    for (let c = 0; c < nClose; c++) {
      const start = queue.shift();
      if (start === undefined) break; // 多余的收尾，丢
      bump(opens, start);
      bump(closes, i);
    }
    const nOpen = (n.slurStart ? 1 : 0) + (n.tieStart ? 1 : 0);
    for (let o = 0; o < nOpen; o++) queue.push(i);
  });
  return { opens, closes };
}

/** 音符 token（不含其后的增时线）。修饰顺序：变音 → 八度 → 减时线 → 附点。 */
function noteToken(n: JpNum, dialect: Dialect): string {
  const d = dialectSpec(dialect);
  // digit 0 是休止；1–7 是唱名。识别不产出隐藏音符与节奏音符，故只有这两类。
  let s = String(n.digit);
  const oct = n.octave > 0 ? d.octaveUp : d.octaveDown;
  s += oct.repeat(Math.abs(n.octave));
  s += "/".repeat(Math.max(0, n.div));
  s += ".".repeat(Math.max(0, n.dot));
  return s;
}

/** 头部：两方言各写各的字段，且都必须能被 sniffDialect 判回本方言。 */
function headerLines(score: RecognizedScore, dialect: Dialect, tb: TextBuilder, meta: JpwMeta): void {
  const key = keyNameOf(score.fifths, dialect === "shige" ? "suffix" : "prefix");
  const push = (s: string) => tb.push(s + "\n");
  if (dialect === "tomato") {
    push("V:1.0"); // 番茄的版本行；与 D:/P: 一同构成 sniffDialect 的番茄特征
    if (score.title) {
      tb.push("B:");
      meta.titleRange = tb.push(score.title);
      tb.push("\n");
    }
    for (const c of score.credits ?? []) {
      tb.push("Z:");
      const range = tb.push(c);
      meta.authorRanges.push({ text: c, range });
      tb.push("\n");
    }
    push(`D:${key}`);
    push(`P:${score.beats}/${score.beatType}`);
  } else {
    if (score.title) {
      tb.push("T:");
      meta.titleRange = tb.push(score.title);
      tb.push("\n");
    }
    for (const c of score.credits ?? []) {
      tb.push("Z:");
      const range = tb.push(c);
      meta.authorRanges.push({ text: c, range });
      tb.push("\n");
    }
    push(`1=${key}${score.beats}/${score.beatType}`); // 诗歌本把调号与拍号写在一行
  }
  if (score.tempo) push(`J:${score.tempo}`);
  push("");
}

/**
 * RecognizedScore → 文本谱原文 + 「音符序 → 代码区间」映射。
 *
 * meta 的下标严格是 flatten(rows[].nums) 的序号——与 jpscore.ts 那条路一致，
 * 识别模式的点选定位（app.ts::_rangeOfHit）因此两种输出格式通用。
 */
export function toPuText(
  score: RecognizedScore,
  dialect: Dialect,
): { text: string; meta: JpwMeta } {
  const d = dialectSpec(dialect);
  const skip = d.lyricSkip[0] ?? "@";
  const wordSeparator = dialect === "tomato" ? "/" : " ";
  const tb = new TextBuilder();
  const meta: JpwMeta = { noteRanges: [], lyricRanges: [], authorRanges: [] };

  headerLines(score, dialect, tb, meta);

  const { opens, closes } = pairCurves(score.rows.flatMap((r) => r.nums));

  let noteIdx = 0; // 全曲音符序（== flatten(rows[].nums)）
  for (const row of score.rows) {
    if (!row.nums.length) continue;
    const measures = measuresOfRow(row);
    const rowFirstIdx = noteIdx;

    // ---- 曲行 ----
    tb.push("Q:");
    let pendingVolta = false; // 房号已开、等着 `]` 收尾
    // 右侧小节线不当场写，攒到下一小节的左侧再落笔：`:|` 紧接 `|:` 要合成一条 `:|:`，
    // 分开写会连着两条小节线、中间没音符，读回来就多一个空小节。
    let pendingRight: BarlineType | null = null;
    let pendingJump: string | null = null; // 跳转记号挂在这条小节线上，不能挂到音符上
    const writeBarline = (type: BarlineType): void => {
      tb.push(" " + barlineCode(dialect, type));
      if (pendingJump) {
        tb.push(`&${pendingJump}`); // 紧跟小节线，parse 的 lastAttachable 才挂得到它身上
        pendingJump = null;
      }
    };
    measures.forEach((notes, mi) => {
      const forward = notes.some((n) => n.repeatForward);
      if (pendingRight === "repeat-end" && forward) writeBarline("repeat-both");
      else if (pendingRight !== null) writeBarline(pendingRight);
      else if (forward) writeBarline("repeat-start");
      else if (mi > 0) writeBarline("normal");
      pendingRight = null;
      // 跳房子：`[` 起、`]` 止。必与前面的小节线隔一个空格——紧贴音符的 `[` 在番茄里是倚音。
      const endingStart = notes.find((n) => n.endingStart !== undefined)?.endingStart;
      if (endingStart !== undefined) {
        tb.push(` ["${endingStart}"`);
        pendingVolta = true;
      }
      for (const n of notes) {
        tb.push(" ");
        tb.push("(".repeat(opens.get(noteIdx) ?? 0)); // 弧线起点在音符**之前**
        meta.noteRanges[noteIdx] = tb.push(noteToken(n, dialect));
        // 休止本不跟词；识别到它带词时补 `@` 翻转 lyricAnchor，否则歌词整行错位
        if (n.digit === 0 && (n.lyrics ?? []).some((t) => t)) tb.push("@");
        // 和弦 / 段落标记 → 音符上方的注释。写在音符**之后**：双引号注释挂的是前一个符号，
        // 写在前面会挂到上一个音符上（行首更是无处可挂，直接丢）。两条注释可以连着写，
        // 解析端 applyQuoted 分别落到 chord 与 annotation 两个字段上，不互相覆盖。
        // 拍内偏移（chordOffset）在文本谱里表达不了，就近挂本音符（有损，MusicXML 那路保得住）。
        if (n.chord) tb.push(`"hx:${n.chord}"`);
        if (n.sectionMark) tb.push(`"${n.sectionMark}"`);
        tb.push(")".repeat(closes.get(noteIdx) ?? 0)); // 收弧要在增时线之前，弧才止于本音符
        tb.push(" -".repeat(Math.max(0, n.augment)));
        noteIdx += 1;
      }
      const endingStop = [...notes].reverse().find((n) => n.endingStop !== undefined)?.endingStop;
      if (endingStop !== undefined && pendingVolta) {
        tb.push(" ]");
        pendingVolta = false;
      }
      if (notes.some((n) => n.repeatBackward)) pendingRight = "repeat-end";
      const jump = notes.find((n) => n.jumpMark)?.jumpMark;
      if (jump && JUMP_MARK[jump]) pendingJump = JUMP_MARK[jump]!;
    });
    if (pendingVolta) tb.push(" ]"); // 房号跨到行末未闭合：就地收口，免得整行的 `[` 悬空
    // 行末小节线：反复记号必须写出；普通线只在图上有时写（开口收尾说明这小节跨到下一行，不可凭空补）
    if (pendingRight !== null) writeBarline(pendingRight);
    else if (rowEndsClosed(row)) writeBarline("normal");
    else if (pendingJump) tb.push(`&${pendingJump}`); // 行末没有小节线可挂，退而挂在末音符上
    pendingJump = null;
    tb.push("\n");

    // ---- 歌词行 ----
    const verses = row.nums.reduce((m, n) => Math.max(m, n.lyrics?.length ?? 0), 0);
    for (let v = 0; v < verses; v++) {
      if (!row.nums.some((n) => n.lyrics?.[v])) continue;
      tb.push(`C${v + 1}:`);
      let prevToken = "";
      row.nums.forEach((n, k) => {
        // 跟词的只有唱名音符（与解析端 takesLyric 同判据）；休止只在补了 `@` 时占位
        const text = n.lyrics?.[v] ?? "";
        const takes = n.digit !== 0 || (n.lyrics ?? []).some((t) => t);
        if (!takes) return;
        const token = text ? lyricToken(text) : skip;
        if (prevToken && needsSeparator(prevToken, token)) tb.push(wordSeparator);
        const range = tb.push(token);
        if (text) {
          const slot = meta.lyricRanges[rowFirstIdx + k] ?? new Map<number, JpwRange>();
          slot.set(v, range);
          meta.lyricRanges[rowFirstIdx + k] = slot;
        }
        prevToken = token;
      });
      // 行末落单的 `}` 会被读成「联合括号」（`parse.ts` 的 `/\}\s*$/` 只看行尾字符，
      // 不管它是不是并字括号的收口），谱面上凭空多一道大括号。补一个跳字符隔开——
      // 它在末音符之后，不对位任何音符，只是把行尾字符换掉。
      if (prevToken.endsWith("}")) tb.push(skip);
      tb.push("\n");
    }
    tb.push("\n");
  }

  // noteRanges 必须逐位对齐音符序：中间不该有洞，这里补齐类型上的空洞
  for (let i = 0; i < noteIdx; i++) {
    if (!meta.noteRanges[i]) meta.noteRanges[i] = { from: 0, to: 0 };
    if (!meta.lyricRanges[i]) meta.lyricRanges[i] = new Map<number, JpwRange>();
  }

  return { text: tb.text, meta };
}
