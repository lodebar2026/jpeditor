// ABC 家族的写出端**基类**：`ScoreDoc` → 文本。往返校验与语料迁移都靠它。
//
// 123 与标准 ABC **只有音乐体不同**，所以这里装的是同源的部分：字段头、声部、歌词对位、
// 小节线与房号、Mark（弧与多连音）索引、符杠分组的连写规则、页眉页脚的 `I:` 扩展、
// `I:playorder`。方言子类只需回答四个问题：一个音怎么写、休止怎么写、时值怎么写、调号怎么写。
//
// 输出风格固定（**幂等的前提**）：
//   - 字段用 ASCII 规范形（中文别名只在读入端认，不往外写）
//   - 小节之间一个空格、小节线两侧各一个空格
//   - 符杠分组内的音符**连写**（ABC §4.7 的空白规则），组间留一个空格；123 不分组、一律空格隔开
//   - **一行曲一行词**：每个系统（`$` 换行处）写一行音乐，紧跟着这一行各段的 `w` 行（规范 §5.1），CJK 连写不加空格
//
// 幂等判据：`parse → emit → parse` 两次得到的 `ScoreDoc` 结构相等（id 除外，那是解析期分配的）。

import type {
  Barline,
  Chord,
  Element,
  Key,
  Measure,
  Note,
  Part,
  ScoreDoc,
  Song,
} from "../model/doc";
import { isLyricCjk, isLyricOpenQuote, isLyricTrailingPunct } from "../common/cjkpunct";
import { breakAfter, lyricOfVerse } from "../model/helpers";
import { lyricSlots } from "./lyricslot";
import { harmonyText } from "../model/jianpu";
import { ORNAMENT_TAG } from "../model/xmlproject";
import { BARLINE_ORNAMENT_NAME } from "./jumpmarks";

/** MusicXML 的 `<ornaments>` 元素名 → 123 记号名：`xmlproject.ts::ORNAMENT_TAG` 反过来（同名的取第一个）。 */
const ORNAMENT_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ORNAMENT_TAG).reverse().map(([name, tag]) => [tag, name]),
);

export interface MarkIndex {
  slurStart: Map<number, number>;
  slurEnd: Map<number, number>;
  tupletStart: Map<number, { actual: number; normal: number }>;
}

/** 小节线上的记号 → `!segno!` 之类的 token（认不出的名字原样写出，别默默丢）。 */
function barlineOrnaments(b: Barline): string[] {
  return (b.ornaments ?? []).map((o) => `!${BARLINE_ORNAMENT_NAME[o.name] ?? o.name}!`);
}

/** 小节线归一名 → 文本。与 `abcfamily/lex.ts::BARLINES` 互逆，两种方言共用。 */
function barlineText(b: Barline): string {
  if (b.repeat === "forward") return b.repeatTimes === 3 ? "|::" : "|:";
  if (b.repeat === "backward") return b.repeatTimes === 3 ? "::|" : ":|";
  switch (b.style) {
    case "none": return "[|]";
    case "light-light": return "||";
    case "light-heavy": return "|]";
    case "heavy-light": return "[|";
    case "dotted": return ".|";
    case "regular": return "|";
    default: return "|";
  }
}

/** 一个系统（第 `from`–`to` 小节）的歌词行。CJK 连写不加空格；收尾标点贴回前一字。
 *
 *  **必须逐个对位格走、空位补跳音符**：歌词是按音符位置对位的（规范 §5），
 *  若只把有词的音节顺序拼起来，中间空一个音符就会让后面所有字前移一格、末尾溢出丢字。
 *  读入端从块首格起挂，所以**行首**的空位要写、行尾的不必写。
 *  对位格的判据与读入端同一份（`lyricslot.ts`）。
 *
 *  **段号由 `w:` 的出现顺序定**（ABC §5.1，123 规范 §5.1）：这里从第 1 段数到本系统的最大段号，
 *  中间没词的那一段写一条空 `w:` 把段位顶住（丢了会让后面的段整体前移一段）；尾部没词的不写。
 *  段号区间（文本谱 `C1-2:`）与副歌行在这里**逐段各抄一遍**——ABC 没有区间写法。
 *  同段拆几条写的 `+:` 续行只在读入端认，写出端一段一行写完。 */
function lyricLines(part: Part, sep: string, skip: string, from: number, to: number): string[] {
  const { slots } = lyricSlots(part, from, to);
  // 本系统一共几段（区间行按上界算）
  let maxVerse = 0;
  for (const el of slots) {
    for (const l of el.lyrics ?? []) maxVerse = Math.max(maxVerse, l.numberTo ?? l.number);
  }
  const bodies: string[] = [];
  for (let verse = 1; verse <= maxVerse; verse++) {
    let body = "";
    let label: string | undefined;
    /** 末尾连续的空位不必写出来（ABC：音节少于音符是合法的） */
    let pendingSkips = "";
    /** 上一个字带了 `_`（延长到下一音符）——那个空位已由 `_` 表达，**不要再补 `*`**，
     *  否则每往返一轮就多出一个占位符、把后面的字顶错一格。 */
    let extendConsumes = false;
    /** 上一个字的 `syllabic`。词内分音节要写 `-`（`mid-dle-word`，ABC §5.1），
     *  不写就会粘成一个词、读回来音节数变少、后面所有字前移一格。 */
    let prevSyllabic: string | undefined;
    /** 上一个写出的音节以拉丁字母/数字收尾（且中间没有 `*` `_` 隔开）——下一个也是拉丁词时要空格 */
    let prevLatin = false;
    for (const el of slots) {
      // 区间与副歌的包含判断与排版取词同一份（`helpers.ts::lyricOfVerse`）
      const hit = lyricOfVerse(el.lyrics, verse) ?? undefined;
      if (hit?.verseLabel !== undefined && label === undefined) label = hit.verseLabel;
      if (hit === undefined || hit.text === "") {
        if (extendConsumes) {
          // 这一格是上一个字的延长位，`_` 已经写过了
          extendConsumes = false;
          continue;
        }
        // 空位：先攒着，后面真有字了再落下去
        pendingSkips += (pendingSkips === "" ? "" : sep) + (hit?.extend ? "_" : skip);
        continue;
      }
      // 词内分隔用 `-`，词间用方言的分隔符。
      // 123 的分隔符是空串（CJK 连写），但**两个拉丁词挨着必须空格**：`主 a b` 写成 `主ab` 读回就粘成一个音节
      const inWord = prevSyllabic === "begin" || prevSyllabic === "middle";
      const wordSep = sep === "" && prevLatin && pendingSkips === "" && isLatinStart(hit.leadingPunctuation ?? hit.text) ? " " : sep;
      body += (body === "" ? "" : inWord ? "-" : wordSep) + pendingSkips;
      pendingSkips = "";
      // **多字并一格要包 `{}`**：CJK 是逐字成音节的（规范 §5.2），
      // `1.圣` 这种并字（`.jpwabc` 的 `{1.[圣]}`）不包起来，读回时会被拆成多个音节、
      // 把后面所有字顶错一格，末尾还会溢出丢字。
      // 「一个字 + 标点」（`哦，` `“主` `主。”`）读回本来就是一个音节，不包——手写的样子就是这样。
      // 但后面要接词内 `-` 的仍然包：CJK 分支不认字后的 `-`（211《等主来》的 `{来”}-`）。
      const inWordNext = hit.syllabic === "begin" || hit.syllabic === "middle";
      const needBrace = [...hit.text].length > 1 && /[\u3400-\u9fff]/u.test(hit.text)
        && (inWordNext || !isOneCjkWithPunct(hit.text));
      // 不包 `{}` 的拉丁词里的字面 `-` 与跳音符要转义，否则读回被拆开（`and/or`）
      const bare = skip === "/" ? hit.text.replace(/[/-]/g, (c) => `\\${c}`) : hit.text;
      body += (hit.leadingPunctuation ?? "") +
        (needBrace ? `{${hit.text}}` : bare) +
        (hit.trailingPunctuation ?? "");
      prevSyllabic = hit.syllabic;
      // 以转义字符收尾（`How\-`）同样会被下一个拉丁词粘上，也要空格
      prevLatin = !hit.trailingPunctuation && (isLatinEnd(hit.text) || (!needBrace && /[/-]$/.test(bare) && bare !== hit.text));
      if (hit.extend) {
        body += sep + "_";
        extendConsumes = true;
        prevSyllabic = undefined;
        prevLatin = false;
      }
    }
    // 词内分音节跨行（`mid-` 在行末）：`-` 照写，不然读回丢了 syllabic
    if (body !== "" && (prevSyllabic === "begin" || prevSyllabic === "middle")) body += "-";
    bodies.push(body === "" ? "" : `${label !== undefined ? `<${label}>` : ""}${body}`);
  }
  // 尾部没词的段不必写（ABC：段数少于最大段号是合法的）
  while (bodies.length > 0 && bodies[bodies.length - 1] === "") bodies.pop();
  return bodies.map((b) => `w:${b}`);
}

const LATIN_CH = /[\p{L}\p{N}']/u;
/** 拉丁音节（非 CJK 的字母/数字）起头——`parseLyricLine` 的拉丁分支会把它和前面的拉丁词粘在一起 */
function isLatinStart(text: string): boolean {
  const c = [...text][0] ?? "";
  return LATIN_CH.test(c) && !isLyricCjk(c);
}
function isLatinEnd(text: string): boolean {
  const cs = [...text];
  const c = cs[cs.length - 1] ?? "";
  return LATIN_CH.test(c) && !isLyricCjk(c);
}

/** 「至多一个左引号 + 一个 CJK 字 + 若干收尾标点」——`parseLyricLine` 不包 `{}` 也读成**一个**音节的形状。
 *  口径与读入端同一份（`common/cjkpunct.ts`），改一边就要看另一边。 */
function isOneCjkWithPunct(text: string): boolean {
  const cs = [...text];
  let k = 0;
  if (cs.length > 1 && isLyricOpenQuote(cs[0]!)) k = 1;
  if (!isLyricCjk(cs[k] ?? "")) return false;
  return cs.slice(k + 1).every(isLyricTrailingPunct);
}

/** 字段值里的换行会把后续内容变成裸行（第二轮解析就当成音乐体了）。
 *  MusicXML 的 `<creator>` 常把多行塞进一个字段（Finale 的习惯），所以一律按行拆成多条同名字段。 */
function pushLines(L: string[], name: string, value: string): void {
  for (const line of value.split(/\r?\n/)) {
    const t = line.trim();
    if (t) L.push(`${name}:${t}`);
  }
}

/** 按声部的换行切出系统（小节下标闭区间）。最后一段开到无穷，别的声部小节多出来的也归它。 */
function systemRanges(part: Part | undefined): [number, number][] {
  const out: [number, number][] = [];
  if (!part) return out;
  let from = 0;
  for (let i = 0; i < part.measures.length - 1; i++) {
    if (breakAfter(part, i)) {
      out.push([from, i]);
      from = i + 1;
    }
  }
  out.push([from, Number.MAX_SAFE_INTEGER]);
  return out;
}

function playOrderText(song: Song): string {
  // skip/limit 的元素 id → 该小节第几个音符
  const noteIndex = new Map<number, { measure: number; index: number }>();
  const part = song.parts[0];
  if (part) {
    for (let mi = 0; mi < part.measures.length; mi++) {
      let k = 0;
      for (const el of part.measures[mi]!.elements) {
        if (el.kind === "chord" && !el.grace) {
          k++;
          noteIndex.set(el.id, { measure: mi + 1, index: k });
        }
      }
    }
  }
  return (song.playOrder ?? [])
    .map((p) => {
      const from = p.fromElement !== undefined ? noteIndex.get(p.fromElement) : undefined;
      const to = p.toElement !== undefined ? noteIndex.get(p.toElement) : undefined;
      let s = `${p.fromMeasure}${from && from.index > 1 ? `.${from.index}` : ""}`;
      s += `-${p.toMeasure}${to ? `.${to.index}` : ""}`;
      if (p.verse !== undefined) s += ` v${p.verse}`;
      if (p.pageBreakAfter) s += " page";
      return s;
    })
    .join(" | ");
}


export abstract class AbcFamilyEmitter {
  /** 文件头的版本声明行（`%123-1.0` / `%abc-2.1`）。 */
  protected abstract readonly versionLine: string;

  // ────────── 方言钩子 ──────────

  /** 一个音怎么写。123 是度数 + 八度点，ABC 是音名 + 大小写/撇号。 */
  protected abstract noteText(n: Note): string;

  /** 休止怎么写。`printObject === false` 是**不可见休止**，两种方言都有专门写法。 */
  protected abstract restText(ch: Chord): string;

  /** 时值怎么写（跟在音后面）。123 是 `_`/`.`，ABC 是分数。 */
  protected abstract durationText(el: Element): string;

  /** 调号怎么写。123 是首调 `1=F`，ABC 是音名 `F` / `Em`。头部 `K:` 与曲中转调 `[K:]` 共用。 */
  protected abstract keyValue(k: Key): string;

  protected keyText(song: Song): string | null {
    return song.key ? this.keyValue(song.key) : null;
  }

  /** `M:` 的值。默认只写头一个拍号——并排的混合拍是 123 的扩展，标准 ABC 读不了（见 emit123）。 */
  protected timeValue(song: Song): string | null {
    return song.time ? `${song.time.beats}/${song.time.beatType}` : null;
  }

  /** 头部里方言特有的行（ABC 的 `L:`）。默认没有。 */
  protected headerExtra(song: Song): string[] {
    void song;
    return [];
  }

  /** 增时线（123 专有；ABC 那一档没有，返回空串）。 */
  protected sustainsText(ch: Chord, mi?: MarkIndex): string {
    void ch;
    void mi;
    return "";
  }

  /** 延音线记号（MusicXML 读进来的 `tied`）写成弧线括号。123 是：简谱里延音线与圆滑线同形，
   *  123 没有单独的 tie 写法；ABC 不是，它有 `-`（见 `tieText`）。 */
  protected readonly tiesAsSlurs: boolean = false;

  /** 延音线（ABC 专有：tie 的 start 端写 `-`）。 */
  protected tieText(ch: Chord): string {
    void ch;
    return "";
  }

  /** 节奏音符 `X`（123 扩展）。 */
  protected rhythmText(): string {
    return "X";
  }

  /** 这个元素写不写。默认全写；123 只写简谱印的那一路（见 `emit123.ts`）。 */
  protected emits(el: Element, mea: Measure): boolean {
    void el;
    void mea;
    return true;
  }

  /** 一个和弦写哪几个音。默认全写；123 没有音符堆，只写简谱印的那个音。 */
  protected chordNotes(ch: Chord): Note[] {
    return ch.notes;
  }

  /** 同时发声的几个音怎么包。123 靠多声部表达、不包；ABC 是 `[CEG]`。 */
  protected chordGroupText(inner: string, noteCount: number): string {
    void noteCount;
    return inner;
  }

  /** 多连音起头怎么写。123 的冒号必需（音符是数字，`(3` 有歧义），ABC 可省。 */
  protected tupletText(actual: number, normal: number): string {
    return normal === 2 ? `(${actual}:` : `(${actual}:${normal}:${actual}`;
  }

  /** 歌词音节之间的分隔。CJK 逐字成音节、连写即可；拉丁词必须空格分开，
   *  否则读回来会粘成一个音节、把后面所有字顶错一格。 */
  protected readonly lyricSeparator: string = "";

  /** 歌词里的跳音符。123 是 `/`，ABC 是 `*`（与读入端 `ParseDialect.lyricSkip` 对称）。 */
  protected readonly lyricSkip: string = "/";

  /** 符杠分组写不写成「连写」。ABC 写（§4.7 空白即分组）；123 不写——符杠按拍自动算，音符一律空格隔开。 */
  protected readonly spaceBeams: boolean = true;

  /** 换行/换页怎么写。123 用显式的 `$`/`$$`；ABC 默认是**代码换行即谱面换行**
   *  （§6.1 的 `I:linebreak <EOL>`），所以那一档写真换行。 */
  protected breakText(newPage: boolean): string {
    return newPage ? "$$" : "$";
  }

  /** 和弦符号怎么写。ABC 只有引号形 `"Am7"`；123 能省就省（见 `emit123.ts`）。 */
  protected chordSymbolText(text: string): string {
    return `"${text}"`;
  }

  /** 最后一小节后面还写不写换行标记。123 写（`$` 无害且要保幂等）；
   *  **ABC 不写**——那是个真换行，末尾多一个就成了空行，而 ABC 的空行会终止曲体，
   *  后面的 `w:` 歌词行就成了孤儿。 */
  protected readonly trailingBreak: boolean = true;

  /** 倚音里的斜线（ABC 的 `{/g}` 短倚音）。 */
  protected graceSlashText(ch: Chord): string {
    void ch;
    return "";
  }

  // ────────── 共用组装 ──────────

  /** 整份文档 → 文本。多曲之间空一行，且**每首都带 `X:`**（分隔靠它，同 ABC tunebook）。 */
  emitDoc(doc: ScoreDoc): string {
    const multi = doc.songs.length > 1;
    const bodies = doc.songs.map((s, i) => this.emitSong(s, multi ? i + 1 : undefined));
    return [this.versionLine, ...bodies].join("\n\n") + "\n";
  }

  /** 一个和弦/占位符 → 音乐体文本（不含前置的和弦符号与装饰）。
   *  `mi` 用来给**增时线**也挂上 `(` `)`——增时线有自己的 id，弧可以在它上起止
   *  （`(6,_ 1_)` 这种写法里弧常以增时线收尾）。不查就会写出只有 `(` 没有 `)` 的非法文本。 */
  protected elementText(el: Element, mi?: MarkIndex): string {
    if (el.kind === "space") {
      let s: string = el.spacer;
      if (el.spacer === "x" && el.duration) s += this.durationText(el);
      return s;
    }
    const ch = el;
    let s = "";
    if (ch.rhythm) {
      s = this.rhythmText();
    } else if (ch.rest) {
      s = this.restText(ch);
    } else {
      const notes = this.chordNotes(ch);
      s = this.chordGroupText(notes.map((n) => this.noteText(n)).join(""), notes.length);
    }
    s += this.durationText(ch);
    s += this.tieText(ch);
    s += this.sustainsText(ch, mi);
    return s;
  }

  /** 倚音 `{6,}` / `{ab}` */
  protected graceText(ch: Chord): string {
    return `{${this.graceSlashText(ch)}${ch.notes.map((n) => this.noteText(n)).join("")}}`;
  }

  /** 一个声部的音乐体，按 `ranges`（小节下标闭区间）切成几行。按小节拼，符杠分组内连写。 */
  protected partSystems(part: Part, song: Song, ranges: readonly (readonly [number, number])[]): string[] {
    let out: string[] = [];
    const texts: string[] = [];
    let ri = 0;
    // **只收两端都在本声部里的 Mark**：`song.marks` 是全曲共用的，而一条弧的两端
    // 必须落在同一个声部才画得出来。不校验就会输出**不配对的 `(`**——那不只是往返不幂等，
    // 是写出了非法的 123（解析回来会报「圆滑线里没有音符」）。
    const own = new Set<number>();
    for (const mea of part.measures) {
      for (const el of mea.elements) {
        if (!this.emits(el, mea)) continue;
        own.add(el.id);
        if (el.kind === "chord") for (const su of el.sustains ?? []) own.add(su.id);
      }
    }
    // Mark 按起止 id 建索引，便于在元素前后插 `(` `)` 与 `(N:`
    const slurStart = new Map<number, number>();
    const slurEnd = new Map<number, number>();
    const tupletStart = new Map<number, { actual: number; normal: number }>();
    for (const m of song.marks) {
      if (!own.has(m.start) || !own.has(m.end)) continue;
      if (m.type === "slur" || (m.type === "tied" && this.tiesAsSlurs)) {
        slurStart.set(m.start, (slurStart.get(m.start) ?? 0) + 1);
        slurEnd.set(m.end, (slurEnd.get(m.end) ?? 0) + 1);
      } else if (m.type === "tuplet") {
        tupletStart.set(m.start, { actual: m.tupletActual ?? 3, normal: m.tupletNormal ?? 2 });
      }
    }

    // 曲中转调/转拍号写成行内 `[K:]` `[M:]`（解析端 `j123/parse.ts` 的 inlineField 认得）。
    // 以前不写：MusicXML 里 A♭ 转 A 的谱（019《拥戴祂为王》）转成 123 后后半首整体差半音
    let key = song.key ? this.keyValue(song.key) : "";
    const timeOf = (t: { beats: number; beatType: number } | undefined): string => (t ? `${t.beats}/${t.beatType}` : "");
    let time = timeOf(song.time);
    /** 收一行：换行标记若是（或带着）真换行，join 出来的两侧空格要收掉；末尾的换行也收掉，否则歌词行前多一个空行 */
    const flush = (): void => {
      texts.push(out.filter((x) => x !== "").join(" ").replace(/ ?\n ?/g, "\n").replace(/\n+$/, ""));
      out = [];
    };
    for (let i = 0; i < part.measures.length; i++) {
      while (ri < ranges.length - 1 && i > ranges[ri]![1]) { flush(); ri++; }
      const mea = part.measures[i]!;
      // 左线可能有**多条**（`.jpwabc` 允许 `|:|` 连写），按顺序全部输出
      const lefts = (mea.barlines ?? []).filter((b) => b.location === "left");
      // 123 一处只能起一个房号；文本谱解析器会留下与新房号重叠的不收口房号，只写最后一个（读回也只认它）
      const lastEnding = lefts.filter((b) => b.ending?.type === "start").pop();
      for (const left of lefts) {
        // 只有房号、没有实际线时不写线（`[1` 自己就是起点标记）
        if (left.style !== undefined) out.push(barlineText(left));
        // 跳转记号紧跟这条线（segno 是跳转目标，落点就是这条线）
        out.push(...barlineOrnaments(left));
        if (left === lastEnding) out.push(`[${left.ending!.numbers.join(",")}`);
      }
      const k = mea.attrs?.key ? this.keyValue(mea.attrs.key) : key;
      if (k !== key) out.push(`[K:${k}]`);
      key = k;
      const t = mea.attrs?.time ? timeOf(mea.attrs.time) : time;
      if (t !== time) out.push(`[M:${t}]`);
      time = t;
      out.push(this.measureBody(mea, { slurStart, slurEnd, tupletStart }));
      const right = (mea.barlines ?? []).find((b) => b.location === "right");
      // 右线的记号写在线**之前**（`… 6 !fine! |]`）：唱到这儿才跳，读回来也按这个位置认。
      if (right) out.push(...barlineOrnaments(right));
      out.push(right ? barlineText(right) : "|");
      // 模型记「下一小节起新系统」（`doc.ts::Print`），源码的 `$` 写在本小节之后
      const last = i === part.measures.length - 1;
      const brk = breakAfter(part, i);
      if (brk && (!last || this.trailingBreak)) out.push(this.breakText(brk === "page"));
    }
    flush();
    while (texts.length < ranges.length) texts.push("");
    return texts;
  }


  protected measureBody(mea: Measure, mi: MarkIndex): string {
    const pieces: string[] = [];
    let prevGroup: number | undefined;
    // 小节**中间**的小节线（`[|]` 不可见线多是这种）：按它在元素流里的位置插回去。
    // 小节线是独立的条目，丢了就会把两个小节并成一个。
    const mid = (mea.barlines ?? []).filter((b) => b.location === "middle");
    let midIdx = 0;
    for (const el of mea.elements) {
      if (!this.emits(el, mea)) continue;
      const ch = el.kind === "chord" ? el : null;
      if (ch?.continued) continue; // 同 `lyricLines`
      // 倚音单独成块、紧贴后一个音符
      if (ch?.grace) {
        pieces.push(this.graceText(ch));
        prevGroup = undefined;
        continue;
      }
      let s = "";
      // 和弦符号前置（规范 §8.1）
      // 从 MusicXML 读进来的和弦是结构化的（根音 + kind），没有原文就按结构拼出来
      const chordText = el.harmony ? harmonyText(el.harmony) : "";
      if (chordText) s += this.chordSymbolText(chordText);
      // 段落词/注记走 ABC §4.19 的注记写法（`^` = 标在上方）
      // 增时线上的注记（文本谱 `- "…"`）123 挂不到 `-` 上，并到宿主音符写出（宿主自己没有时）
      const word = ch?.sectionWord ?? ch?.sustains?.find((su) => su.sectionWord !== undefined)?.sectionWord;
      if (word) s += `"^${word}"`;
      if (el.notations?.fermata) s += "!fermata!";
      for (const a of el.notations?.articulations ?? []) s += `!${a}!`;
      // 从 MusicXML 读进来的波音/颤音挂在 ornaments 上（`inverted-mordent`），写回简谱来源的同名记号（`!sby!`）——
      // 不写就整个丢了：以前识别核对那条路（识别 → MusicXML → 123）里 1677《祷告》的两个波音就是这么没的。
      for (const o of el.notations?.ornaments ?? []) s += `!${ORNAMENT_NAME[o] ?? o}!`;
      const tp = mi.tupletStart.get(el.id);
      // 简写 `(N:`；normal≠2 时必须写完整形 `(N:p:q`（**两个冒号**，见 lex.ts 的正则注释）
      if (tp) s += this.tupletText(tp.actual, tp.normal);
      s += "(".repeat(mi.slurStart.get(el.id) ?? 0);
      s += this.elementText(el, mi);
      s += ")".repeat(mi.slurEnd.get(el.id) ?? 0);

      // 中间小节线按 `afterElements` 计数插入
      while (midIdx < mid.length && mid[midIdx]!.afterElements !== undefined
             && mid[midIdx]!.afterElements! <= pieces.length) {
        pieces.push(barlineText(mid[midIdx]!));
        midIdx++;
        prevGroup = undefined;
      }
      // 符杠分组（ABC）：同组连写、不同组之间留空格
      const group = ch?.beamGroup;
      const sameGroup = this.spaceBeams && group !== undefined && group === prevGroup;
      if (pieces.length && sameGroup) pieces[pieces.length - 1] += s;
      else pieces.push(s);
      prevGroup = group;
    }
    while (midIdx < mid.length) { pieces.push(barlineText(mid[midIdx]!)); midIdx++; }
    return pieces.join(" ");
  }


  /** 一首歌 → 文本。
   *  @param fallbackNumber 没有曲号时用它补一个——**多曲文件必须给**，
   *    因为 123 的多曲就是靠 `X:` 分隔（规范 §1，同 ABC tunebook）。
   *    文本谱用 `-----` 分曲、大多没有曲号，不补的话几首会连成一片、读回只剩一首。 */
  emitSong(song: Song, fallbackNumber?: number): string {
    const L: string[] = [];
    if (song.work.number) L.push(`X:${song.work.number}`);
    else if (fallbackNumber !== undefined) L.push(`X:${fallbackNumber}`);
    if (song.work.title !== undefined) pushLines(L, "T", song.work.title);
    for (const st of song.work.subtitles) pushLines(L, "T", st);
    for (const c of song.identification?.creators ?? []) pushLines(L, "C", c.text);
    const k = this.keyText(song);
    if (k) L.push(`K:${k}`);
    const mt = this.timeValue(song);
    if (mt) L.push(`M:${mt}`);
    L.push(...this.headerExtra(song));
    for (const t of song.tempos ?? []) {
      L.push(typeof t === "number" ? `Q:1/4=${t}` : `Q:"${t}"`);
    }
    // 页眉页脚（文本谱的 `XL/XR/TL/TR/BL/BC/BR`）。ABC 没有对应字段，走它的 `I:` 扩展点——
    // 规范 §3 写明未识别的 `I:` 会被忽略，所以这样扩展是安全的。语料里 绝大多数用到，不能丢。
    const pt = song.pageText;
    if (pt) {
      if (pt.indexLeft !== undefined) L.push(`I:indexleft ${pt.indexLeft}`);
      if (pt.indexRight !== undefined) L.push(`I:indexright ${pt.indexRight}`);
      for (const [key, arr] of [
        ["topleft", pt.topLeft], ["topright", pt.topRight],
        ["bottomleft", pt.bottomLeft], ["bottomcenter", pt.bottomCenter], ["bottomright", pt.bottomRight],
      ] as const) {
        for (const t of arr) for (const line of t.split(/\r?\n/)) if (line.trim()) L.push(`I:${key} ${line.trim()}`);
      }
    }
    // 扩展 meta（`model/metakeys.ts`）：一项一行；项里自带换行的拆成多行（读回是多项，按 "\n" 合起来文字不变）
    for (const [key, vals] of Object.entries(song.meta ?? {})) {
      for (const v of vals) for (const line of v.split(/\r?\n/)) L.push(`I:meta ${key} ${line}`.trimEnd());
    }
    if (song.style?.sheetRef) L.push(`I:style ${song.style.sheetRef}`);
    if (song.linesPerPage) L.push(`I:linesperpage ${song.linesPerPage}`);
    // 指令名**一律小写输出**：`parseInstruction` 读入时会归一成小写（ABC 的 `I:` 不区分大小写），
    // 这里若保留原样大小写，往返一轮就会从 `I:FontSize` 变成 `I:fontsize`
    for (const r of song.style?.raw ?? []) L.push(`I:${r.key.toLowerCase()} ${r.value}`);
    if (song.playOrder?.length) L.push(`I:playorder ${playOrderText(song)}`);
    for (const r of song.remarks ?? []) {
      // `P:` 原文在解析期被塞进 remarks，原样还回去
      if (r.startsWith("P:")) L.push(r);
      else pushLines(L, "N", r);
    }
    // 系统上方的说明文字行（文本谱 `W:`）：123 没有带位置的文字行，按出现顺序落成 `N:`
    const texts: { system: number; text: string }[] = [];
    for (const part of song.parts) {
      for (const mea of part.measures) {
        for (const t of mea.print?.texts ?? []) texts.push({ system: mea.print?.system ?? 0, text: t.trim() });
      }
    }
    for (const t of texts.sort((a, b) => a.system - b.system)) if (t.text) pushLines(L, "N", t.text);

    // **一行曲一行词**：按第一个声部的换行切系统，每个系统依次写各声部的音乐行与它的 `w` 行。
    // 读入端把「上一批 `w` 行之后的音乐行」当一个歌词块、`w` 从块首对位（规范 §5.1），与这里一一对应。
    const ranges = systemRanges(song.parts[0]);
    const bodies = song.parts.map((part) => this.partSystems(part, song, ranges));
    for (let r = 0; r < ranges.length; r++) {
      for (let i = 0; i < song.parts.length; i++) {
        const text = bodies[i]![r]!;
        if (text === "") continue;
        if (song.parts.length > 1) L.push(`V:${i + 1}`);
        L.push(text);
        const [from, to] = ranges[r]!;
        for (const line of lyricLines(song.parts[i]!, this.lyricSeparator, this.lyricSkip, from, to)) L.push(line);
      }
    }
    return L.join("\n");
  }


}
