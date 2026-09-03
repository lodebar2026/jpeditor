// Score -> .jpwabc text, ported from mp/score/jpw.kt (JpScore.fromMusicXml).

import {
  BarlineEntry,
  BarStyle,
  Chord,
  LineBreak,
  Measure,
  Part,
  Score,
} from "./score";
import { computePhraseBreaks, type FitMetric, type PhraseBreaks } from "./phrase";
import { chooseLineLayout } from "./applybreaks";

function escape(s: string): string {
  return s.replace(/\n/g, "\\n");
}

/** 编辑器文本里的一段字符区间（点选定位用）。 */
export interface JpwRange {
  from: number;
  to: number;
}

/** scoreToJpwabc 产出的「识别对象 → jpwabc 代码区间」映射，供 OMR 识别模式点选定位。
 *  noteRanges/lyricRanges 均按 **Chord 序**（== flatten(RecognizedScore.rows[].nums) 序）。 */
export interface JpwMeta {
  noteRanges: JpwRange[]; // 第 i 个音符 token（.Voice 里数字+修饰段，不含前后括号/空格）
  lyricRanges: Array<Map<number, JpwRange>>; // 平行于 noteRanges：第 i 音符各 verse(0基) 的音节区间
  titleRange?: JpwRange; // Title = 后的标题值
  authorRanges: Array<{ text: string; range: JpwRange }>; // WordsByAndMusicBy 里每个作者条目
}

/** 乐句排版时一页排几行。`balanceVoicePages` 按它分页，`computePhraseBreaks` 按它把末页排满
 *  （`PhraseOptions.pageLines`）——**两处必须是同一个数**，否则 DP 凑满的那一页排版器不认。 */
const PAGE_LINES = 4;

/** 行内相对记录（line=最终 this.lines 下标，col=行内偏移），最后统一换算成绝对偏移。 */
interface Rec {
  line: number;
  colStart: number;
  colEnd: number;
}

interface Segment {
  passFirst: number;
  passLast: number;
  measure: number;
  noteIndex: number;
}

class LyricProcessor {
  refrain: Segment | null = null;
  verses = new Map<number, Segment>();
  texts = new Map<Segment, string>();
  numVerses = 0;
  mid = 0;
  nid = 0;
  inVerse = true;
  // 逐音节记录（用于点选定位）：seg + 音节在该 seg 字符串里的起点/长度 + 所属 Chord 全局序 + verse(0基)。
  syllRecords: { seg: Segment; offsetInSeg: number; len: number; chordIdx: number; verse: number }[] = [];
  // proc.lines() 里把每个 seg 的文本行下标记下，供换算绝对偏移。
  segLineIndex = new Map<Segment, number>();
  private static readonly reg = /^\d\./;
  private static readonly punc = /[，。！？、“”：；]+/g;

  // 乐句模式下 .Voice 会在这些和弦后插入行内 $(true)；re-parse 时（assignLrcSeg）会把
  // 小节中间的 LineBreak 当作 mid++/nid=0，故此处须同步递增，否则歌词锚点 @measure,noteIndex 错位。
  constructor(public part: Part, private midBreaks: Set<Chord> | null = null) {}

  lines(res: string[]): void {
    for (const [k, v] of this.texts) {
      let head = "W" + k.passFirst;
      if (k.passFirst !== k.passLast) head += "-" + k.passLast;
      head += "@" + k.measure + "," + k.noteIndex + ":";
      res.push(head);
      let str = v;
      if (str.endsWith("/")) str = str.replace(/\/+$/, "");
      this.segLineIndex.set(k, res.length); // 文本行即将 push 到的下标
      res.push(str);
    }
  }

  private appendSlash(): void {
    if (this.inVerse) {
      for (const v of this.verses.values()) this.texts.set(v, (this.texts.get(v) ?? "") + "/");
    } else if (this.refrain) {
      this.texts.set(this.refrain, (this.texts.get(this.refrain) ?? "") + "/");
    }
  }

  private makeText(txt: string): string {
    if (txt.length === 1) return txt;
    const mat = LyricProcessor.reg.exec(txt);
    if (mat) {
      return `{${mat[0]}[${txt.substring(mat[0].length)}]}`;
    }
    const left = txt.replace(LyricProcessor.punc, "");
    const quote = left.length !== 1;
    return quote ? `{${txt}}` : txt;
  }

  private onChord(ch: Chord, chordIdx: number): void {
    const lrcs = ch.notes[0].lyrics;
    if (lrcs.length > this.numVerses) this.numVerses = lrcs.length;
    const lrc = lrcs[0];
    if (!lrc) { this.appendSlash(); return; }
    if (lrc.refrain) {
      if (!this.refrain) {
        const seg: Segment = { passFirst: 1, passLast: 1, measure: this.mid, noteIndex: this.nid };
        this.refrain = seg;
        this.texts.set(seg, "");
      }
      const prev = this.texts.get(this.refrain) ?? "";
      const out = this.makeText(lrc.text);
      this.texts.set(this.refrain, prev + out);
      this.syllRecords.push({ seg: this.refrain, offsetInSeg: prev.length, len: out.length, chordIdx, verse: 0 });
      this.inVerse = false;
    } else {
      const present = new Set<number>();
      for (const it of lrcs) {
        if (!this.verses.has(it.number)) {
          const seg: Segment = { passFirst: it.number, passLast: it.number, measure: this.mid, noteIndex: this.nid };
          this.verses.set(it.number, seg);
          this.texts.set(seg, "");
        }
        const seg = this.verses.get(it.number)!;
        const prev = this.texts.get(seg) ?? "";
        const out = this.makeText(it.text);
        this.texts.set(seg, prev + out);
        this.syllRecords.push({ seg, offsetInSeg: prev.length, len: out.length, chordIdx, verse: it.number - 1 });
        present.add(it.number);
      }
      // 某音符在部分 verse 是 melisma（该 verse 无音节）但另一 verse 有字：给缺席的 verse 补 "/"，
      // 否则该 verse 丢失续记号、其后整体错位（原 Kotlin 缺此处理，多段歌词 melisma 不对齐时会漏 /）。
      for (const [num, seg] of this.verses) {
        if (present.has(num)) continue;
        this.texts.set(seg, (this.texts.get(seg) ?? "") + "/");
      }
      this.inVerse = true;
    }
  }

  process(): void {
    let chordIdx = 0;
    for (const m of this.part.measures) {
      this.mid++;
      this.nid = 0;
      for (const ch of m.entries) {
        if (ch instanceof LineBreak) { this.mid++; this.nid = 0; continue; }
        if (!(ch instanceof Chord)) continue;
        this.nid++;
        this.onChord(ch, chordIdx++);
        // 乐句行内断点：其后插了 $(true)，re-parse 视作新行 → 与 assignLrcSeg 对齐。
        if (this.midBreaks?.has(ch)) { this.mid++; this.nid = 0; }
      }
    }
    if (this.refrain) this.refrain.passLast = this.numVerses;
  }
}

/** 副歌（refrain）的第一个和弦；用作乐句排版的「主歌 / 副歌」分页点。
 *  两道护栏：① 须在主歌之后——单段谱里 findRefrain 会把整首都标成 refrain；
 *  ② 副歌须有份量（≥8 个音且不少于全曲 1/8）——只有末尾一两个字共用时不算副歌。
 *  否则返回 null，免得断出残页。 */
function firstRefrainChord(part: Part): Chord | null {
  const chords: Chord[] = [];
  for (const m of part.measures) {
    for (const ent of m.entries) if (ent instanceof Chord) chords.push(ent);
  }
  let sawVerse = false;
  for (let i = 0; i < chords.length; i++) {
    for (const nt of chords[i].notes) {
      for (const lrc of nt.lyrics) {
        if (lrc.text.length === 0) continue;
        if (!lrc.refrain) { sawVerse = true; continue; }
        if (!sawVerse) continue;
        const rest = chords.length - i;
        return rest >= Math.max(8, chords.length / 8) ? chords[i] : null;
      }
    }
  }
  return null;
}

class JpScore {
  lines: string[] = [];
  // 点选定位用的行内相对记录（最后 computeMeta 换算成绝对偏移）。
  private noteRecs: Rec[] = []; // 按 Chord 序
  private titleRec: Rec | null = null;
  private authorRecs: Array<{ text: string; rec: Rec }> = [];
  private _proc: LyricProcessor | null = null; // 保留 LyricProcessor 以便取歌词逐音节记录
  private _breaks: PhraseBreaks | null = null;  // 乐句模式的断行，makeVoiceData / makeWordData 共用
  private _pageLines = new Set<number>(); // 乐句模式：段末（主歌/副歌分界）的乐句行号，1 基

  constructor(private phrase = false, private fit: FitMetric | null = null) {}

  fromMusicXml(scr: Score): void {
    this.lines.push("// ************** JPW-ABC File Ver 1.0 (for JP-Word v5.50m) **************");
    this.makeMetaData(scr);
    this._breaks = this.phrase ? this.makeBreaks(scr) : null;
    this.makeVoiceData(scr.parts[0]);
    this.makeWordData(scr.parts[0]);
    this.makeRepeatData(scr);
  }

  /** 行内相对记录 → 绝对字符偏移映射（须在 lines 全部构建完成后调用）。 */
  computeMeta(): JpwMeta {
    const base: number[] = [];
    let acc = 0;
    for (const ln of this.lines) { base.push(acc); acc += ln.length + 1; } // +1 为 join("\n") 的换行
    const abs = (r: Rec): JpwRange => ({ from: base[r.line] + r.colStart, to: base[r.line] + r.colEnd });
    const noteRanges = this.noteRecs.map(abs);
    const lyricRanges: Array<Map<number, JpwRange>> = noteRanges.map(() => new Map());
    if (this._proc) {
      for (const r of this._proc.syllRecords) {
        const line = this._proc.segLineIndex.get(r.seg);
        if (line === undefined || r.chordIdx >= lyricRanges.length) continue;
        lyricRanges[r.chordIdx].set(r.verse, {
          from: base[line] + r.offsetInSeg,
          to: base[line] + r.offsetInSeg + r.len,
        });
      }
    }
    return {
      noteRanges,
      lyricRanges,
      titleRange: this.titleRec ? abs(this.titleRec) : undefined,
      authorRanges: this.authorRecs.map((a) => ({ text: a.text, range: abs(a.rec) })),
    };
  }

  private makeRepeatData(scr: Score): void {
    if (scr.playData.noRepeat) return;
    if (scr.playData.measures.length === 0) return;
    this.lines.push(".Repeat");
    const items = scr.playData.measures;
    items.forEach((it, idx) => {
      const head = it.skip > 0 ? `${it.mid + 1}.${it.skip + 1}` : `${it.mid + 1}`;
      const tail = it.limit >= 0 ? `${it.end}.${it.limit}` : `${it.end}`;
      // 乐句排版：主歌 / 副歌各自成段，段末（endOfPass）单独起页；末段不用再换。
      const page = this.phrase && it.endOfPass && idx < items.length - 1 ? "P" : "";
      this.lines.push(`${head}-${tail}V${it.pass}${page}`);
    });
  }

  private makeMetaData(scr: Score): void {
    this.lines.push(".Title");
    const titlePrefix = "Title = ";
    const titleVal = escape(scr.title);
    this.titleRec = { line: this.lines.length, colStart: titlePrefix.length, colEnd: titlePrefix.length + titleVal.length };
    this.lines.push(titlePrefix + titleVal);
    const firstMea = scr.parts[0].measures[0];
    const tm = firstMea.time;
    const key = firstMea.key.name;
    this.lines.push(`KeyAndMeters = {1=${key},${tm.beats}/${tm.beatType}}`);
    const authors: string[] = [];
    for (const it of scr.credit) {
      if (it.type === "title") continue;
      if (it.page !== 0) continue;
      authors.push(escape(it.text.trim()));
    }
    const order = (s: string) =>
      s.includes("词") ? 5 : s.includes("译") ? 4 : s.includes("曲") ? 3 : s.includes("编") ? 2 : 1;
    authors.sort((a, b) => order(b) - order(a));
    // 逐作者记录其在 WordsByAndMusicBy 值里的区间（作者间以 "\\n"(2字符) 分隔）。
    const authPrefix = "WordsByAndMusicBy = ";
    const authLine = this.lines.length;
    let col = authPrefix.length;
    for (const a of authors) {
      this.authorRecs.push({ text: a, rec: { line: authLine, colStart: col, colEnd: col + a.length } });
      col += a.length + 2; // "\\n"
    }
    this.lines.push(`${authPrefix}${authors.join("\\n")}`);
    // 速度记进 JP-Word 原生的 Expression 字段，位置也依原样排在 WordsByAndMusicBy 之后。
    // 音符符号直接写 `♩`（JP-Word 自己存的是 ASCII `J`，靠音乐字体映射成四分音符；这里用真
    // Unicode 音符，源码/文本里所见即所得）。读取端两种都认。
    // 试听/导出 MIDI 靠它把 ♩= 带过「xml → jpwabc 文本 → 重解析」这一圈。
    if (scr.playData.tempo > 0) this.lines.push(`Expression = {♩=${scr.playData.tempo}}`);
  }

  private makeWordData(part: Part): void {
    const proc = new LyricProcessor(part, this._breaks?.midBreaks ?? null);
    proc.process();
    this.lines.push(".Words");
    proc.lines(this.lines);
    this._proc = proc; // computeMeta 用其 syllRecords / segLineIndex
  }

  private makeNotations(ch: Chord): string {
    return ch.fermata ? "{YanYin}" : "";
  }

  /** 倚音：`{` 一串音高 `}`，排在主音之前（文法 `Note` 里 Grace 就在 Pitch 之前）。
   *  与转调转拍号同理——文法早有这个产生式（`fragment Grace : '{' Pitch+ '}'`），
   *  只是从前生成端不写、解析端不认，musicxml 导进来的倚音在 `.jpwabc` 往返里丢了
   *  （全书只有 260《感恩的泪》5 颗、264《陶我成器》2 颗，导出的 .pptx 里一颗都没有）。
   *  倚音不带时值：排版那一端固定按八分音符画（`layout.ts::addGraceNotes`）。 */
  private graceVoice(ch: Chord): string {
    if (!ch.graceNotes.length) return "";
    let str = "";
    for (const g of ch.graceNotes) {
      switch (g.jpAlter) {
        case "n": str += "#b"; break;
        case "b": case "#": str += g.jpAlter; break;
        default: break;
      }
      str += g.number;
      for (let i = 0; i < g.jpOctave; i++) str += "'";
      for (let i = 0; i < -g.jpOctave; i++) str += ",";
    }
    return `{${str}}`;
  }

  private chordVoice(ch: Chord): string {
    const nt = ch.notes[0];
    let str = "";
    switch (nt.jpAlter) {
      case "n": str += "#b"; break;
      case "b": case "#": str += nt.jpAlter; break;
      case " ": case "": case " ": break;
      default: throw new Error("bad jpAlter");
    }
    str += nt.number;
    if (!ch.rest) {
      for (let i = 0; i < nt.jpOctave; i++) str += "'";
      for (let i = 0; i < -nt.jpOctave; i++) str += ",";
    }
    if (ch.dot === 1 && ch.beats <= 1) str += ".";
    for (let i = 0; i < ch.beams; i++) str += "_";
    for (let i = 1; i < ch.beats; i++) str += "-";
    return str;
  }

  private makeBarline(m: Measure): string {
    if (m.repeatBackward) return ":|";
    switch (m.barline) {
      case BarStyle.NONE: return "[|]";
      case BarStyle.LIGHT_LIGHT: return "||";
      case BarStyle.LIGHT_HEAVY: return "|]";
      case BarStyle.HEAVY_LIGHT: throw new Error("unsupported heavy-light");
      case null:
      case BarStyle.DOTTED:
      case BarStyle.REGULAR: return "|";
      default: throw new Error("bad barline " + m.barline);
    }
  }

  // 乐句排版：按实际乐句行数重排每页换页标记（每页至多 PAGE_LINES 行；末页仅剩 1 行的 4+1
  // 情形把最后一个换页上移一行 → 3+2）。voiceStart = .Voice 首行在 this.lines 的下标。
  private balanceVoicePages(voiceStart: number): void {
    const R = this.lines.length - voiceStart;
    if (R <= 0) return;
    const pageAt = new Set<number>(); // 1 基乐句行号：其行尾为换页
    // 主歌 / 副歌各自成段（_pageLines 记的是段末行号），段内再按每页至多 PAGE_LINES 行分。
    const rawBounds = [0, ...[...this._pageLines].filter((n) => n > 0 && n < R).sort((a, b) => a - b), R];
    // 只有 1 行的段（如前奏 Intro）单独占一页太空 → 并入下一段（丢掉它的段界）。
    const merged = [rawBounds[0]];
    for (let i = 1; i < rawBounds.length; i++) {
      if (i < rawBounds.length - 1 && rawBounds[i] - merged[merged.length - 1] < 2) continue;
      merged.push(rawBounds[i]);
    }
    // **段界换页是「放不下才换」，不是逢段必换**（用户口径：「主歌和副歌无法在一页内排下时
    // 才在副歌前换页」）。006《颂赞归与耶稣圣名》主歌 2 行 + 副歌 2 行正好一页，逢段必换
    // 会把一遍拆成两页各 2 行；005《荣耀归与天父》主歌 4 行 + 副歌 4 行放不下，那才该换。
    // 相邻的段能凑进同一页就并成一组，组界才是换页处。
    const bounds = [merged[0]];
    for (let i = 1; i < merged.length; i++) {
      const start = bounds[bounds.length - 1];
      // 把第 i 段也并进当前组就超出一页了 → 当前组到上一段末为止，本段另起一组。
      if (merged[i] - start > PAGE_LINES && merged[i - 1] > start) bounds.push(merged[i - 1]);
    }
    const last = merged[merged.length - 1];
    if (bounds[bounds.length - 1] !== last) bounds.push(last);
    for (let s = 0; s + 1 < bounds.length; s++) {
      const beg = bounds[s];
      const len = bounds[s + 1] - beg;
      for (let p = PAGE_LINES; p <= len - 1; p += PAGE_LINES) pageAt.add(beg + p);
      pageAt.add(beg + len); // 段末收尾（分隔主歌/副歌、反复段）
      if (len % PAGE_LINES === 1 && len >= PAGE_LINES + 1) {
        pageAt.delete(beg + len - 1);
        pageAt.add(beg + len - 2);
      }
    }
    for (let i = 1; i <= R; i++) {
      const idx = voiceStart + i - 1;
      const marker = pageAt.has(i) ? "$(true,0,0,true)" : "$(true)";
      this.lines[idx] = this.lines[idx].replace(/\$\(true(?:,0,0,true)?\)\s*$/, "") + marker;
    }
  }

  private makeVoiceData(part: Part): void {
    this.lines.push(".Voice");
    const voiceStart = this.lines.length;
    // 乐句排版：忽略源自带换行，按乐句分析结果断行；否则保留原始 newSystem。
    const breaks = this._breaks;
    // 乐句排版：副歌另起一页（无反复展开的多段谱走这条；有反复的靠 .Repeat 的 P 标记）。
    // 断点位置由 phrase 统一决定（它按同样的规则找副歌首音，再把弱起顺延过去），这里只在
    // phrase 没给出副歌段界时兜底——否则两边各断一次，会在副歌前甩出「我立定」这样的半行。
    const refrainChord = breaks && !breaks.refrainCut ? firstRefrainChord(part) : null;
    let l = "";
    let lineNo = 0;
    // 换行：乐句模式每 4 行自动换页（一页不超过 4 行）；否则沿用源换页标记。
    const pushBreak = (sourcePage: boolean): void => {
      lineNo++;
      const page = breaks ? lineNo % PAGE_LINES === 0 : sourcePage;
      l += page ? "$(true,0,0,true)" : "$(true)";
      this.lines.push(l);
      l = "";
    };
    part.measures.forEach((m, mid) => {
      const doBreak = mid > 0 && (breaks ? breaks.measureBreaks.has(mid) : m.newSystem);
      // l 为空说明上一乐句刚在小节内(midBreak)断过，别再补一次空行。
      if (doBreak && l.length > 0) pushBreak(m.newPage);
      // 段落起点(Verse/Chorus/Coda…)：记下上一行为段末 → balanceVoicePages 让新段另起一页
      // （否则主歌与副歌会挤在同一页）。
      if (breaks?.sectionStarts.has(mid) && lineNo > 0) this._pageLines.add(lineNo);
      if (m.repeatForward) {
        l += "|:";
        if (m.endingLeft) {
          l += "[";
          const nums = m.endingNum!;
          if (nums.size === 1) l += [...nums][0];
          else throw new Error("multi-ending");
        }
      }
      // **曲中转拍号 / 转调**：写在这一小节的音符之前。拍号用文法里现成的 TimeSig
      // （`4/4`），调号借 STRING（`"1=A"`）——两个都是 Jpwabc.g4 已有的 token
      //（`entry: … | text | timesig | …`），不动语法、不必重生成解析器。
      // 原版 JP-Word 与 2019 年那批成品 .pptx 都不记这两样（019《拥戴祂为王》后半段
      // 直接换数字写、不印 `1=A`），可排版引擎本来就画得出来
      //（`layout.ts::Line.load` 认 `Measure.timeChange` / `keyChange`）——
      // 不写进文本，musicxml 导进来的转调转拍号就在 `.jpwabc` 往返里丢了。
      // 只在**真的变了**的时候写：有些 musicxml 每个系统都重申一遍 `<attributes>`，
      // 照 `timeChange` 直接写会平白多出一堆拍号。
      const prevM = mid > 0 ? part.measures[mid - 1] : null;
      if (prevM && m.timeChange
        && (m.time.beats !== prevM.time.beats || m.time.beatType !== prevM.time.beatType)) {
        l += `${m.time.beats}/${m.time.beatType} `;
      }
      if (prevM && m.keyChange && m.key.fifths !== prevM.key.fifths) l += `"1=${m.key.name}" `;
      let hasBarline = false;
      m.entries.forEach((ch, idx) => {
        if (ch instanceof LineBreak) {
          if (!hasBarline && idx === m.entries.length - 1) {
            l += this.makeBarline(m);
            hasBarline = true;
          }
          l += ch.newPage ? "$(true,0,0,true)" : "$(true)";
          this.lines.push(l);
          l = "";
        } else if (ch instanceof Chord) {
          if (ch === refrainChord) {
            // 副歌起点：本行先收掉（已在别处断过就不重复断），并记为段末 → 副歌单独起页。
            if (l.length > 0) pushBreak(false);
            if (lineNo > 0) this._pageLines.add(lineNo);
          }
          const nt = ch.notes[0];
          if (nt.tieStart) l += "(";
          if (ch.slurStart) l += "(";
          if (nt.tupletBegin) l += "{(3}";
          l += this.makeNotations(ch);
          l += this.graceVoice(ch); // 倚音排在主音之前，不算进下面那个 token 区间
          // 记录本音符 token 区间（仅 chordVoice 段：数字+修饰，不含前后括号/记号/空格）。
          const colStart = l.length;
          l += this.chordVoice(ch);
          this.noteRecs.push({ line: this.lines.length, colStart, colEnd: l.length });
          if (nt.tieEnd) l += ")";
          if (nt.tupletEnd) l += ")";
          if (ch.slurEnd) l += ")";
          l += " ";
          // 乐句尾（弱起谱漏进本小节的休止/长音）处行内换行，不加小节线。
          if (breaks?.midBreaks.has(ch)) {
            pushBreak(false);
            // 段界顺延到小节内部（弧闭合处）时，这一行就是段末 → 记下让新段另起一页。
            if (breaks.sectionCutChords.has(ch) && lineNo > 0) this._pageLines.add(lineNo);
          }
        } else if (ch instanceof BarlineEntry) {
          if (!ch.position.equals(0)) {
            const bl = this.makeBarline(m);
            const next = part.measures[mid + 1];
            if (next?.repeatForward) {
              /* leading repeat handles its own barline */
            } else {
              // **不画线的小节线（`[|]`）也要写出来**：它是出版社把一个小节拆到两行时
              // 用的分隔，谱面上不印，但少写一根，重新解析时两个小节就并成一个，
              // 后面 `.Repeat` 里按原编号写的段落全部错位、还会越界（见 jpglyph.ts
              // 的 BarStyle.NONE 那一支）。画不画的事归排版管，不归这里。
              l += bl;
            }
            hasBarline = true;
          }
        }
      });
      if (!hasBarline) {
        const bl = this.makeBarline(m);
        const next = part.measures[mid + 1];
        if (bl === "|" && next?.repeatForward) {
          /* skip */
        } else {
          l += bl;
        }
      }
    });
    if (l.trim().length > 0) {
      l += "$(true,0,0,true)";
      this.lines.push(l);
    }
    if (breaks) this.balanceVoicePages(voiceStart);
  }

  /**
   * 断句 + **整首的排版模式阶梯**。
   *
   * 断句本身照旧（一句一行，`computePhraseBreaks` 的默认权重，15 首编辑器基线不动）；
   * 给了 `fit`（真实坐标）时再走一遍 `chooseLineLayout`——**能放得下两句就一行两句，
   * 放不下就一句一行**（用户口径），与成书那条路同一套代码、同一条判据：
   * 只在「一句一行明显太稀」（中位行长不到版心六成）时才并，并完还要真实排一遍验一次。
   *
   * 从前这里是拿 `targetMeas` 顶行长目标去逼它并行，那是错的招：目标一大，DP 就按
   * 「凑够这么多小节」断，350《主耶稣我羡慕活在祢面前》第 3 行因此断在
   * 「当世上正没有什｜么可鼓舞」句子中间、第 4 行 33 个音符明显超宽。
   */
  private makeBreaks(scr: Score): PhraseBreaks {
    const part = scr.parts[0];
    const breaks = computePhraseBreaks(part, { pageLines: PAGE_LINES });
    if (this.fit) chooseLineLayout(part, breaks, 0, { fit: this.fit });
    return breaks;
  }

  get code(): string {
    return this.lines.join("\n");
  }
}

/** MusicXML-derived Score -> .jpwabc text.
 *  opts.phrase=true 时按乐句分析重新断行（覆盖源自带换行）；默认保留原始排版。 */
export function scoreToJpwabc(score: Score, opts?: { phrase?: boolean; fit?: FitMetric | null }): string {
  return scoreToJpwabcWithMeta(score, opts).text;
}

/** 同 scoreToJpwabc，但额外产出「识别对象 → 代码区间」映射（OMR 识别模式点选定位用）。 */
export function scoreToJpwabcWithMeta(
  score: Score,
  opts?: { phrase?: boolean; fit?: FitMetric | null },
): { text: string; meta: JpwMeta } {
  const jp = new JpScore(opts?.phrase ?? false, opts?.fit ?? null);
  jp.fromMusicXml(score);
  return { text: jp.code, meta: jp.computeMeta() };
}
