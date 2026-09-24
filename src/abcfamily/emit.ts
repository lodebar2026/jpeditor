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
  Mark,
  Measure,
  Note,
  Part,
  ScoreDoc,
  Song,
} from "../model/doc";
import { breakAfter, lyricOfVerse, type BreakKind } from "../model/helpers";
import { lyricSlots, type LyricSlotRule } from "./lyricslot";
import { isLatinEnd, isLatinStart, isOneCjkWithPunct, nestArcsInTuplets, ownIds, ownMarks, systemRanges, type SystemRange } from "../model/emitutil";
import { harmonyText } from "../model/jianpu";
import { ORNAMENT_TAG } from "../model/xmlproject";
import { BARLINE_ORNAMENT_NAME } from "./jumpmarks";
import { tupletNormal123 } from "./parsedialect";

/** MusicXML 的 `<ornaments>` 元素名 → 123 记号名：`xmlproject.ts::ORNAMENT_TAG` 反过来（同名的取第一个）。 */
const ORNAMENT_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ORNAMENT_TAG).reverse().map(([name, tag]) => [tag, name]),
);

export interface MarkIndex {
  slurStart: Map<number, number>;
  slurEnd: Map<number, number>;
  /** 在这个音上起头的多连音，外层在前（嵌套的几层可以同起）；
   *  `outerArcs`：同一个音上起头、却在最外层组外收的弧数，它们的 `(` 写在所有 `(n:` 之前 */
  tupletStart: Map<number, { ratios: { actual: number; normal: number }[]; outerArcs: number }>;
  /** 123 的多连音收在哪（写 `)`）；`outerArcs`：组外起头、收在这个音上的弧数，它们的 `)` 写在多连音的 `)` 之后 */
  tupletEnd: Map<number, { count: number; outerArcs: number }>;
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
function lyricLines(part: Part, sep: string, skip: string, sys: SystemRange, rule: LyricSlotRule): string[] {
  const { slots } = lyricSlots(part, sys.from, sys.to, sys.fromEl, sys.toEl, rule);
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

/** 字段值里的换行会把后续内容变成裸行（第二轮解析就当成音乐体了）。
 *  MusicXML 的 `<creator>` 常把多行塞进一个字段（Finale 的习惯），所以一律按行拆成多条同名字段。 */
function pushLines(L: string[], name: string, value: string): void {
  for (const line of value.split(/\r?\n/)) {
    const t = line.trim();
    if (t) L.push(`${name}:${t}`);
  }
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

  /** 多连音起头怎么写。123：`(n:`，比例不是默认值时 `(n:p:`（以冒号收尾，见 `lex.ts::matchTuplet`）；ABC 见 `emitabc.ts`。 */
  protected tupletText(actual: number, normal: number): string {
    return normal === tupletNormal123(actual) ? `(${actual}:` : `(${actual}:${normal}:`;
  }

  /** 多连音要不要写收尾的 `)`。123 必需（与圆滑线同一套嵌套）；ABC 按个数收尾、不写。 */
  protected readonly tupletCloses: boolean = true;

  /** 歌词音节之间的分隔。CJK 逐字成音节、连写即可；拉丁词必须空格分开，
   *  否则读回来会粘成一个音节、把后面所有字顶错一格。 */
  protected readonly lyricSeparator: string = "";

  /** 歌词里的跳音符。123 是 `/`，ABC 是 `*`（与读入端 `ParseDialect.lyricSkip` 对称）。 */
  protected readonly lyricSkip: string = "/";

  /** 休止占不占歌词对位格（`lyricslot.ts::LyricSlotRule`，与读入端 `ParseDialect.id` 同口径）。 */
  protected readonly lyricSlotRule: LyricSlotRule = "123";

  /** 符杠分组写不写成「连写」。ABC 写（§4.7 空白即分组）；123 不写——符杠按拍自动算，音符一律空格隔开。 */
  protected readonly spaceBeams: boolean = true;

  /** 小节内临时多声部的分隔符（ABC 的 `&`，§7.4）。123 没有这个记号，恒为 null。 */
  protected readonly overlayText: string | null = null;

  /** 临时声部起点晚于小节起点时，用来占住前面那段时间的不可见休止（ABC 的 `x`）。
   *  `divisions` 是写出端口径（四分 = `SIMPLE_DIVISIONS`）。 */
  protected overlayPad(divisions: number): string {
    void divisions;
    return "";
  }

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
    const dur = this.graceDurationText(ch);
    return `{${this.graceSlashText(ch)}${ch.notes.map((n) => this.noteText(n) + dur).join("")}}`;
  }

  /** 倚音里每个音后面的时值（123 的 `{2__}`）。ABC 的倚音一律按默认写，不带。 */
  protected graceDurationText(ch: Chord): string {
    void ch;
    return "";
  }

  /** 一个声部的音乐体，按 `ranges` 切成几行。按小节拼，符杠分组内连写。
   *  `inlineCuts`：照 `ranges` 在小节中间切（只有切系统所依据的那个声部才这么做）。 */
  protected partSystems(part: Part, song: Song, ranges: readonly SystemRange[], inlineCuts: boolean): string[] {
    let out: string[] = [];
    const texts: string[] = [];
    let ri = 0;
    const own = ownIds(part, (el, mi) => this.emits(el, part.measures[mi]!));
    // Mark 按起止 id 建索引，便于在元素前后插 `(` `)` 与 `(N:`
    const slurStart = new Map<number, number>();
    const slurEnd = new Map<number, number>();
    const tupletStart = new Map<number, { ratios: { actual: number; normal: number }[]; outerArcs: number }>();
    /** 同起的几层按终点从远到近排（外层先写） */
    const tupletEndOrder = new Map<number, number>();
    part.measures.forEach((mea) => mea.elements.forEach((el) => tupletEndOrder.set(el.id, tupletEndOrder.size)));
    const nested = [...ownMarks(song, own)].filter((m) => m.type === "tuplet")
      .sort((a, b) => (tupletEndOrder.get(b.end) ?? 0) - (tupletEndOrder.get(a.end) ?? 0));
    const tupletEnd = new Map<number, { count: number; outerArcs: number }>();
    const isArc = (m: Mark): boolean => m.type === "slur" || (m.type === "tied" && this.tiesAsSlurs);
    let marks = ownMarks(song, own);
    // 123 的多连音与弧共用括号、只许嵌套：跨出组的弧截进组内（`planSave` 另报 `slurCrossTuplet`）
    const nest = this.tupletCloses ? nestArcsInTuplets(part, marks, isArc) : null;
    if (nest) marks = nest.marks;
    for (const m of marks) {
      if (isArc(m)) {
        slurStart.set(m.start, (slurStart.get(m.start) ?? 0) + 1);
        slurEnd.set(m.end, (slurEnd.get(m.end) ?? 0) + 1);
      } else if (m.type === "tuplet") {
        if (this.tupletCloses) {
          const te = tupletEnd.get(m.end);
          if (te) te.count++;
          else tupletEnd.set(m.end, { count: 1, outerArcs: nest?.outerClose.get(m.end) ?? 0 });
        }
      }
    }
    for (const m of nested) {
      const ts = tupletStart.get(m.start) ?? { ratios: [], outerArcs: nest?.outerOpen.get(m.start) ?? 0 };
      ts.ratios.push({ actual: m.tupletActual ?? 3, normal: m.tupletNormal ?? 2 });
      tupletStart.set(m.start, ts);
    }

    // 曲中转调/转拍号写成行内 `[K:]` `[M:]`（解析端 `j123/parse.ts` 的 inlineField 认得）。
    // 以前不写：MusicXML 里 A♭ 转 A 的谱（019《拥戴祂为王》）转成 123 后后半首整体差半音
    let key = song.key ? this.keyValue(song.key) : "";
    const timeOf = (t: { beats: number; beatType: number } | undefined): string => (t ? `${t.beats}/${t.beatType}` : "");
    let time = timeOf(song.time);
    /** 收一行：换行标记若是（或带着）真换行，join 出来的两侧空格要收掉；末尾的换行也收掉，否则歌词行前多一个空行。
     *  代码行以「字母（+ 数字）+ 冒号」起头（小节中间换行后 `C :|`、`C4 :|`、123 的 `x :|`）会被读成字段行
     *  （`fields.ts::ASCII_PREFIX` 容忍 `V1:` 式编号与冒号前的空格），前面垫一个空格 */
    const flush = (): void => {
      texts.push(out.filter((x) => x !== "").join(" ").replace(/ ?\n ?/g, "\n").replace(/\n+$/, "")
        .replace(/^(?=[A-Za-z]\d*(?:-\d+)?\s*[:：])/gm, " "));
      out = [];
    };
    for (let i = 0; i < part.measures.length; i++) {
      while (ri < ranges.length - 1 && i > ranges[ri]!.to) { flush(); ri++; }
      const mea = part.measures[i]!;
      // 本小节里的原位换行：切成几段，各段之间写 `$` 并收一行（左线、调号拍号归首段，右线归末段）
      const cuts: { at: number; kind: BreakKind }[] = [];
      if (inlineCuts) {
        for (let r = ri; r < ranges.length - 1 && ranges[r]!.to === i; r++) {
          const inl = ranges[r]!.inline;
          if (inl) cuts.push({ at: ranges[r]!.toEl, kind: inl });
        }
      }
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
      let el0 = 0;
      for (const cut of cuts) {
        out.push(this.measureBody(mea, { slurStart, slurEnd, tupletStart, tupletEnd }, el0, cut.at));
        out.push(this.breakText(cut.kind === "page"));
        flush();
        ri++;
        el0 = cut.at;
      }
      out.push(this.measureBody(mea, { slurStart, slurEnd, tupletStart, tupletEnd }, el0));
      const right = (mea.barlines ?? []).find((b) => b.location === "right");
      // 右线的记号写在线**之前**（`… 6 !fine! |]`）：唱到这儿才跳，读回来也按这个位置认。
      if (right) out.push(...barlineOrnaments(right));
      out.push(right ? barlineText(right) : "|");
      // 模型记「下一小节起新系统」（`doc.ts::Print`），源码的 `$` 写在本小节之后
      const last = i === part.measures.length - 1;
      // 原位换行过的小节，下一小节上那份小节级 `print` 是同一处换行，不再写第二个 `$`
      const brk = cuts.length ? null : breakAfter(part, i);
      if (brk && (!last || this.trailingBreak)) out.push(this.breakText(brk === "page"));
    }
    flush();
    while (texts.length < ranges.length) texts.push("");
    return texts;
  }


  /** `from` / `to`：只写这一段元素（小节中间换行时一小节分两段写，见 `partSystems`）。 */
  protected measureBody(mea: Measure, mi: MarkIndex, from = 0, to = Infinity): string {
    const pieces: string[] = [];
    let prevGroup: number | undefined;
    // 小节**中间**的小节线（`[|]` 不可见线多是这种）：按它在元素流里的位置插回去。
    // 小节线是独立的条目，丢了就会把两个小节并成一个。
    const mid = (mea.barlines ?? []).filter((b) => b.location === "middle");
    let midIdx = 0;
    // 临时多声部（ABC `&`）：按声部分段写，段间插 `&`。原生解析出来的元素本就按原文顺序、
    // 一个声部连着一个声部，所以这里只在**声部号变了**的地方断开；MusicXML 读进来的交错
    // 多声部先按声部归并（只在整小节写出时才归并——小节中间换行那条路按下标切片，不能重排）。
    const order = this.voiceOrder(mea, from, to);
    let prevVoice: number | undefined;
    for (const j of order) {
      const el = mea.elements[j]!;
      if (!this.emits(el, mea)) continue;
      const ch = el.kind === "chord" ? el : null;
      if (ch?.continued) continue; // 同 `lyricLines`
      const voice = el.voice > 1 ? el.voice : 1;
      if (this.overlayText && prevVoice !== undefined && voice !== prevVoice) {
        pieces.push(this.overlayText);
        prevGroup = undefined;
        // 这一支不是从小节起点开的（MusicXML 的交错多声部会这样）：用不可见休止占住前面那段
        const pad = el.onset ? this.overlayPad(el.onset) : "";
        if (pad) pieces.push(pad);
      }
      prevVoice = voice;
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
      // 同一个音上的开、收按嵌套排：包住多连音组的弧在外层（`((3: 1_ 2_ 3_) 4)`），其余在里层
      const tp = mi.tupletStart.get(el.id);
      const opens = mi.slurStart.get(el.id) ?? 0;
      s += "(".repeat(tp?.outerArcs ?? 0);
      // ABC 按个数收尾、没有嵌套的写法，同起的几层只写最外层（以前就是这样）
      for (const r of this.tupletCloses ? tp?.ratios ?? [] : (tp?.ratios ?? []).slice(0, 1)) s += this.tupletText(r.actual, r.normal);
      s += "(".repeat(opens - (tp?.outerArcs ?? 0));
      s += this.elementText(el, mi);
      const te = mi.tupletEnd.get(el.id);
      const closes = mi.slurEnd.get(el.id) ?? 0;
      s += ")".repeat(closes - (te?.outerArcs ?? 0));
      if (te) s += ")".repeat(te.count + te.outerArcs);

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
    // 余下的中间线归末段（小节中间换行时前一段不带它们）
    if (to >= mea.elements.length) while (midIdx < mid.length) { pieces.push(barlineText(mid[midIdx]!)); midIdx++; }
    return pieces.join(" ");
  }


  /** 小节里元素的写出顺序（下标）。单声部就是原顺序；多声部按**声部首次出现的先后**归并，
   *  好让 `&` 落在段与段之间。`from`/`to` 切片（小节中间换行）不重排——那时下标要与切片口径一致。 */
  private voiceOrder(mea: Measure, from: number, to: number): number[] {
    const all = mea.elements.map((_, j) => j).filter((j) => j >= from && j < to);
    if (!this.overlayText || from > 0 || to < mea.elements.length) return all;
    const groups = new Map<number, number[]>();
    for (const j of all) {
      const v = mea.elements[j]!.voice > 1 ? mea.elements[j]!.voice : 1;
      const g = groups.get(v);
      if (g) g.push(j);
      else groups.set(v, [j]);
    }
    if (groups.size < 2) return all;
    return [...groups.values()].flat();
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
      const beat = song.tempoBeat ? `${song.tempoBeat.num}/${song.tempoBeat.den}` : "1/4";
      L.push(typeof t === "number" ? `Q:${beat}=${t}` : `Q:"${t}"`);
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
    const bodies = song.parts.map((part, pi) => this.partSystems(part, song, ranges, pi === 0));
    for (let r = 0; r < ranges.length; r++) {
      for (let i = 0; i < song.parts.length; i++) {
        const text = bodies[i]![r]!;
        if (text === "") continue;
        if (song.parts.length > 1) L.push(`V:${i + 1}`);
        L.push(text);
        // 原位切只对第一声部成立，别的声部按整小节取词
        const sys = i === 0 ? ranges[r]! : { ...ranges[r]!, fromEl: 0, toEl: Infinity };
        for (const line of lyricLines(song.parts[i]!, this.lyricSeparator, this.lyricSkip, sys, this.lyricSlotRule)) L.push(line);
      }
    }
    return L.join("\n");
  }


}
