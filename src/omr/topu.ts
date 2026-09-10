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
// 方言差异一律从 dialectSpec() 取（八度字符、变音记号、节奏音符、跳词字符、小节线写法、
// 音节分隔符、头部字段写法），**不要在两套方言之间写 if**——那正是 DialectSpec 存在的理由。

import type { RecognizedScore, JpNum, StaffRow } from "./types";
import { rright } from "./types";
import { dialectSpec, type Dialect, type DialectSpec } from "../pu/dialect";
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
    const nClose = (n.slurStop ?? 0) + (n.tieStop ? 1 : 0);
    for (let c = 0; c < nClose; c++) {
      const start = queue.shift();
      if (start === undefined) break; // 多余的收尾，丢
      bump(opens, start);
      bump(closes, i);
    }
    const nOpen = (n.slurStart ?? 0) + (n.tieStart ? 1 : 0);
    for (let o = 0; o < nOpen; o++) queue.push(i);
  });
  return { opens, closes };
}

/** 倚音串 `"yy:5 4 4"`：小号数字本身也是音符 token（八度/减时线照 noteToken 那套写法），
 *  多个之间用空格隔开（parse.ts::scanGraceNotes 认这个形）。
 *  **减时线要少写一条**：倚音的基准时值是八分音符（`scanGraceNotes` 里 `scanNote(…, 8)`），
 *  谱面上那条八分的减时线不写；识别端数出的 div 是谱面上的条数，故写出去时减一。 */
function graceToken(g: { digit: number; octave: number; div: number }, dialect: Dialect): string {
  const d = dialectSpec(dialect);
  const oct = g.octave > 0 ? d.octaveUp : d.octaveDown;
  return String(g.digit) + oct.repeat(Math.abs(g.octave)) + "/".repeat(Math.max(0, g.div - 1));
}

/** 音符 token（不含其后的增时线）。修饰顺序：变音 → 八度 → 减时线 → 附点。 */
function noteToken(n: JpNum, dialect: Dialect): string {
  const d = dialectSpec(dialect);
  // digit 0 是休止；1–7 是唱名。识别不产出隐藏音符与节奏音符，故只有这两类。
  let s = String(n.digit);
  // 临时升降号写在数字**后方**（两家都是），字符各按方言取：番茄 `#`/`$`/`=`、诗歌本 `#`/`b`/`♮`。
  if (n.accidental) {
    const ch = Object.entries(d.accidentals).find(([, sem]) => sem === n.accidental)?.[0];
    if (ch) s += ch;
  }
  const oct = n.octave > 0 ? d.octaveUp : d.octaveDown;
  s += oct.repeat(Math.abs(n.octave));
  s += "/".repeat(Math.max(0, n.div));
  s += ".".repeat(Math.max(0, n.dot));
  return s;
}

/** 头部：字段名与调号/拍号的排布全从 DialectSpec.header 取，
 *  产出必须能被 sniffDialect 判回本方言（omr-pu-check 的断言 1）。 */
function headerLines(score: RecognizedScore, d: DialectSpec, tb: TextBuilder, meta: JpwMeta): void {
  const h = d.header;
  const key = keyNameOf(score.fifths, h.keyStyle);
  // 混合拍：页眉并排印着好几个拍号，两家的头部都写得下（番茄 `P: 4/4 3/4`、
  // 诗歌本 `1=D4/4 3/4 5/4`，后者还可跟一段说明文字）。识别不到 meters 就照单个拍号写。
  const meterList = score.meters?.length ? score.meters : [{ beats: score.beats, beatType: score.beatType }];
  const meter = meterList.map((m) => `${m.beats}/${m.beatType}`).join(" ");
  const push = (s: string) => tb.push(s + "\n");

  if (h.versionLine) push(h.versionLine);
  if (score.title) {
    tb.push(`${h.titleField}:`);
    meta.titleRange = tb.push(score.title);
    tb.push("\n");
  }
  // 副标题：两家方言都是「第一条标题行是主标题，其余为副标题」，再写一条同名字段即可。
  if (score.subtitle) push(`${h.titleField}:${score.subtitle}`);
  for (const c of score.credits ?? []) {
    tb.push(`${h.creditField}:`);
    const range = tb.push(c);
    meta.authorRanges.push({ text: c, range });
    tb.push("\n");
  }
  if (h.keyMeter === "split") {
    push(`${h.keyField}:${key}`);
    push(`${h.meterField}:${meter}`);
  } else {
    push(`1=${key}${meter}${score.meterNote ? ` ${score.meterNote}` : ""}`);
  }
  if (score.tempo) push(`${h.tempoField}:${score.tempo}`);
  if (d.id !== "shige") push("");   // 诗歌本紧排：头部与曲行之间也不空行
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
  // 诗歌本的曲行是**紧排**的（`Q:3/5/|"p:5/4"6-7/…`），番茄那边照旧用空格分隔。
  // 每个音符都以数字开头、记号都跟在数字后面，紧排不会有歧义；房号 `[` 前那一个空格两家都留
  // （番茄里紧贴音符的 `[` 是倚音语法）。
  const sp = d.id === "shige" ? "" : " ";
  const skip = d.lyricSkip[0] ?? "@";
  const wordSeparator = d.wordSeparator;
  const tb = new TextBuilder();
  const meta: JpwMeta = { noteRanges: [], lyricRanges: [], authorRanges: [] };

  headerLines(score, d, tb, meta);

  const { opens, closes } = pairCurves(score.rows.flatMap((r) => r.nums));

  let noteIdx = 0; // 全曲音符序（== flatten(rows[].nums)）
  let openTail = false; // 上一行的末小节是否跨行未收（行末图上没有小节线）
  // 当前生效的拍号：起头用页眉那个（混合拍时 score.beats 就是首个），曲中由 timeChange
  // 改写。只给减时线的连断记号用（见下），跨行也要接着算，故声明在行循环之外。
  let curBeats = score.beats, curBeatType = score.beatType;
  for (const row of score.rows) {
    if (!row.nums.length) continue;
    const measures = measuresOfRow(row);
    const rowFirstIdx = noteIdx;

    // ---- 曲行 ----
    tb.push("Q:");
    // 上一行是**开口收尾**（末小节跨到本行继续，换行处图上本就没有小节线）：本行开头写一条
    // 隐藏小节线 `|/`，读回来才知道这一行接的是上一行那个没写完的小节，而不是新起一小节。
    if (openTail) tb.push(barlineCode(dialect, "hidden"));
    let pendingVolta = false; // 房号已开、等着 `]` 收尾
    // 右侧小节线不当场写，攒到下一小节的左侧再落笔：`:|` 紧接 `|:` 要合成一条 `:|:`，
    // 分开写会连着两条小节线、中间没音符，读回来就多一个空小节。
    let pendingRight: BarlineType | null = null;
    let pendingJump: string | null = null; // 跳转记号挂在这条小节线上，不能挂到音符上
    // 曲中转拍号：文本谱把临时拍号写成**小节线后面的引号备注** `"p:3/4"`
    // （解析端 interpretQuoted → BarlineElement.temporaryMeter）。识别时它锚在新小节的
    // 头一个音符上，故由那一小节的左侧小节线带出来。
    let pendingMeter: string | null = null;
    const writeBarline = (type: BarlineType): void => {
      tb.push(sp + barlineCode(dialect, type));
      if (pendingMeter) { tb.push(`"p:${pendingMeter}"`); pendingMeter = null; }
      if (pendingJump) {
        tb.push(`&${pendingJump}`); // 紧跟小节线，parse 的 lastAttachable 才挂得到它身上
        pendingJump = null;
      }
    };
    measures.forEach((notes, mi) => {
      const change = notes.find((n) => n.timeChange)?.timeChange;
      if (change) {
        pendingMeter = `${change.beats}/${change.beatType}`;
        curBeats = change.beats; curBeatType = change.beatType;
      }
      const forward = notes.some((n) => n.repeatForward);
      if (pendingRight === "repeat-end" && forward) writeBarline("repeat-both");
      else if (pendingRight !== null) writeBarline(pendingRight);
      else if (forward) writeBarline("repeat-start");
      else if (mi > 0) writeBarline("normal");
      // 行首那一小节没有左侧小节线可挂（换行处图上本就没线），临时拍号只好丢——
      // 挂到下一根线上会整整错开一小节，凭空补一根线又会多出一个空小节。
      pendingMeter = null;
      pendingRight = null;
      // 跳房子：`[` 起、`]` 止。必与前面的小节线隔一个空格——紧贴音符的 `[` 在番茄里是倚音。
      const endingStart = notes.find((n) => n.endingStart !== undefined)?.endingStart;
      if (endingStart !== undefined) {
        tb.push(` ["${endingStart}"`);
        pendingVolta = true;
      }
      // 减时线的连断：文本谱把相邻两个带减时线的音符自动连成一条线，满一拍才断
      // （`pu/layout.ts::computeUnderlines`）。本项目排版认拍号，多数地方不写记号也排得对；
      // 但**诗歌本 app 那边要照谱本的写法写出来**，故这里照它的范式生成。
      // 拍位以四分音符为 1、每小节从头算，与 pu 那边同一口径；增时线也占拍，故一并累加。
      const beatsOf = (n: JpNum) => (1 / Math.pow(2, n.div)) * (n.dot > 0 ? 1.5 : 1) + n.augment;
      // **复拍子**（分母 8、分子是 3 的倍数）一组是三个八分 = 1.5 个四分拍，两条范式：
      //   · 组界：两个音符按 `floor(绝对拍位)` 落在同一整拍里（不写就会连着）时写 `^`；
      //     9/8 的第二个组界在 2.5→3.0，本来就跨了整拍，那里不写。
      //   · 组内：以**组首**为原点，每跨一个四分拍写一个 `~`（即每组第三个八分之前）。
      // 9/8 的一小节九个八分因此写成 `1/1/~1/^2/2/~2/3/3/~3/`、6/8 写成 `1/1/~1/^2/2/~2/`。
      const groupBeats = curBeatType === 8 && curBeats % 3 === 0 ? 1.5 : 1;
      const groupOf = (b: number) => Math.floor(b / groupBeats + 1e-9);
      let prevNote: JpNum | null = null, prevBeat = 0, beat = 0, syncopated = false;
      for (const n of notes) {
        tb.push(sp);
        // 两边都得有减时线才有线可连断。复拍子照上面的范式写；其余拍号（groupBeats=1，
        // 组即整拍、组内无细分）只在**切分音**处写 `^`：小节里音符从非整拍起、又跨过整拍
        // 线之后拍位整个错开，读谱的一方最容易在「减时线层数变了」的那个交界上连错。
        if (prevNote && prevNote.div > 0 && n.div > 0) {
          const sameBeat = Math.floor(prevBeat + 1e-9) === Math.floor(beat + 1e-9);
          if (groupBeats !== 1) {
            const g = groupOf(beat);
            if (groupOf(prevBeat) !== g) {
              if (sameBeat) tb.push("^");
            } else if (Math.floor(prevBeat - g * groupBeats + 1e-9) !==
                       Math.floor(beat - g * groupBeats + 1e-9)) {
              tb.push("~");
            }
          } else if (syncopated && prevNote.div !== n.div && !sameBeat) {
            tb.push("^");
          }
        }
        prevNote = n; prevBeat = beat;
        const end = beat + beatsOf(n);
        // 切分音：从非整拍起、又跨过整拍线（整拍起头的长音不算）。
        if (beat % 1 !== 0 && Math.floor(beat + 1e-9) !== Math.floor(end - 1e-9)) syncopated = true;
        beat = end;
        tb.push("(".repeat(opens.get(noteIdx) ?? 0)); // 弧线起点在音符**之前**
        // 收弧的括号紧跟音符**本体**，附点写在括号外（`(1.1).` 而不是 `(1.1.)`）——
        // 增时线本来就在括号之后（见下），两者口径一致。
        const closeHere = closes.get(noteIdx) ?? 0;
        const tailDot = closeHere > 0 && n.dot > 0;
        meta.noteRanges[noteIdx] = tb.push(noteToken(tailDot ? { ...n, dot: 0 } : n, dialect));
        // 休止本不跟词；识别到它带词时补 `@` 翻转 lyricAnchor，否则歌词整行错位
        if (n.digit === 0 && (n.lyrics ?? []).some((t) => t)) tb.push("@");
        // 和弦 / 段落标记 → 音符上方的注释。写在音符**之后**：双引号注释挂的是前一个符号，
        // 写在前面会挂到上一个音符上（行首更是无处可挂，直接丢）。两条注释可以连着写，
        // 解析端 applyQuoted 分别落到 chord 与 annotation 两个字段上，不互相覆盖。
        // 拍内偏移（chordOffset）在文本谱里表达不了，就近挂本音符（有损，MusicXML 那路保得住）。
        // 延长记号：文本谱写作音符后的 `&yc`（parse.ts 的 NOTE_COMMANDS）。
        if (n.fermata) tb.push("&yc");
        // 波音：文本谱写作音符后的 `&sby`（上波音，parse.ts 的 NOTE_COMMANDS）。
        if (n.ornament === "upper-mordent") tb.push("&sby");
        // 顿音：文本谱写作音符后的 `&dy`（parse.ts 的 NOTE_COMMANDS）。
        if (n.articulation === "staccato") tb.push("&dy");
        // 倚音：写成音符后面的引号备注 `"yy:…"`（parse.ts::interpretQuoted → graceBefore）。
        // 番茄那边紧贴音符的 `[3]` 也是倚音，但两家都认 `"yy:"`，故不分方言。
        if (n.grace?.length) tb.push(`"yy:${n.grace.map((g) => graceToken(g, dialect)).join(" ")}"`);
        if (n.chord) tb.push(`"hx:${n.chord}"`);
        if (n.sectionMark) tb.push(`"${n.sectionMark}"`);
        tb.push(")".repeat(closeHere)); // 收弧要在增时线之前，弧才止于本音符
        if (tailDot) tb.push(".".repeat(n.dot));
        // 增时线：长音里逐拍换的和弦（extraChords）就印在它们上方，按拍位挂到对应那一条上。
        // offset 是占本音符**总时值**的比例，折成拍数后减掉音符本体占的拍，就是第几条增时线。
        const extras = n.extraChords ?? [];
        if (n.augment > 0) {
          const baseBeats = (1 / Math.pow(2, n.div)) * (n.dot > 0 ? 1.5 : 1);
          const total = baseBeats + n.augment;
          for (let k = 1; k <= n.augment; k++) {
            tb.push(sp + "-");
            const hit = extras.find((e) => {
              const idx = Math.round(e.offset * total - baseBeats) + 1;
              return Math.min(Math.max(idx, 1), n.augment) === k;
            });
            if (hit) tb.push(`"hx:${hit.tok}"`);
          }
        }
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
    openTail = !rowEndsClosed(row);
    if (pendingVolta) tb.push(" ]"); // 房号跨到行末未闭合：就地收口，免得整行的 `[` 悬空
    // 行末小节线：反复记号必须写出；普通线只在图上有时写（开口收尾说明这小节跨到下一行，不可凭空补）
    if (pendingRight !== null) writeBarline(pendingRight);
    else if (rowEndsClosed(row)) writeBarline(row.finalBarline === "end" ? "end" : "normal");
    else if (pendingJump) tb.push(`&${pendingJump}`); // 行末没有小节线可挂，退而挂在末音符上
    pendingJump = null;
    tb.push("\n");

    // ---- 歌词行 ----
    const verses = row.nums.reduce((m, n) => Math.max(m, n.lyrics?.length ?? 0), 0);
    // 只有一段歌词时行首写 `C:`（不带段号）；多段才写 `C1:` `C2:` …
    const numbered = verses > 1;
    for (let v = 0; v < verses; v++) {
      if (!row.nums.some((n) => n.lyrics?.[v])) continue;
      tb.push(numbered ? `C${v + 1}:` : "C:");
      // 谱面印在歌词行首的段号（`1.`、`3.5.`）：文本谱写作歌词行前置说明——诗歌本用尖括号
      // `<1.>`、番茄用双引号 `"1."`（两家的写法见 pu/parse.ts::stripLyricAnnotation）。
      // 它不是唱词、不对位任何音符，故不进 lyricRanges。
      const label = row.lyricLabels?.[v];
      if (label) tb.push(d.id === "shige" ? `<${label}>` : `"${label}"`);
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
    if (sp) tb.push("\n");   // 番茄那边每组曲行/歌词之间空一行；诗歌本紧排、不留空行
  }

  // noteRanges 必须逐位对齐音符序：中间不该有洞，这里补齐类型上的空洞
  for (let i = 0; i < noteIdx; i++) {
    if (!meta.noteRanges[i]) meta.noteRanges[i] = { from: 0, to: 0 };
    if (!meta.lyricRanges[i]) meta.lyricRanges[i] = new Map<number, JpwRange>();
  }

  return { text: tb.text, meta };
}
