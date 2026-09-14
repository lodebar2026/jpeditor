// `.jpwabc` 写出端（原 `score/jpscore.ts`，ported from mp/score/jpw.kt `JpScore.fromMusicXml`）。
//
// 输入形状（`docs/待办.md` §3.1 阶段 8③）：只经下面这组接口读谱，不认 `Score` 的类——`Score` 结构上满足，
// `ScoreDoc` 那一侧由 `emitJpwabc` 按形状拼（MusicXML 形状照 `loadMusicXml`、简谱形状照 `scoreDocToScore`）。
// 字段名与口径沿用 `Score`；判据原样搬来，靠 `scripts/jpw-emit-check.mjs` 双跑逐字节一致。
//
// JP-Word 的 `.Voice` 只有单声部：只写第一声部。和弦符号、力度、slur 以外的弧等装不下的，见 `capability.ts`。

import type { Fraction } from "../common/fraction";
import { BarStyle } from "../score/enums";
import type { ScoreDoc } from "./doc";
import { jpwInputOfDoc } from "./playdoc";
import { isXmlShaped } from "./xmlproject";
import { jpwInputOfSong } from "../pu/playsong";

function escape(s: string): string {
  return s.replace(/\n/g, "\\n");
}

// ───────────────────────── 输入形状 ─────────────────────────

export interface JpwLyricIn {
  readonly text: string;
  readonly number: number;
  readonly refrain: boolean;
}

/** 简谱写法的一个音：数字、八度点、面上的记号（`b` / `#` / `n` / 空）。 */
export interface JpwPitchIn {
  readonly number: string;
  readonly jpOctave: number;
  readonly jpAlter: string;
}

export interface JpwNoteIn extends JpwPitchIn {
  readonly tieStart: boolean;
  readonly tieEnd: boolean;
  readonly tupletBegin: boolean;
  readonly tupletEnd: boolean;
  readonly lyrics: readonly JpwLyricIn[];
}

export interface JpwChordIn {
  /** 只读 `notes[0]` */
  readonly notes: readonly JpwNoteIn[];
  readonly rest: boolean;
  readonly dot: number;
  readonly beats: number;
  readonly beams: number;
  readonly slurStart: boolean;
  readonly slurEnds: number;
  readonly fermata: boolean;
  readonly graceNotes: readonly JpwPitchIn[];
}

/** 行内换行（`Score.LineBreak`）。 */
export interface JpwLineBreakIn {
  readonly newPage: boolean;
  readonly pass: number | null;
}

/** 小节线条目（`Score.BarlineEntry`）：只看位置——不在小节开头的就地写一根。 */
export interface JpwBarlineIn {
  readonly style: BarStyle | null;
  readonly repeat: "forward" | "backward" | null;
  readonly position: Fraction;
}

export interface JpwMeasureIn {
  /** 和弦、换行、小节线按原次序混排 */
  readonly entries: readonly object[];
  readonly newSystem: boolean;
  readonly newPage: boolean;
  readonly repeatForward: boolean;
  readonly repeatBackward: boolean;
  readonly endingLeft: boolean;
  readonly endingNum: ReadonlySet<number> | null;
  readonly timeChange: boolean;
  readonly keyChange: boolean;
  readonly time: { readonly beats: number; readonly beatType: number };
  readonly key: { readonly fifths: number; readonly name: string };
  readonly barline: BarStyle | null;
}

export interface JpwPlayItemIn {
  readonly mid: number;
  readonly end: number;
  readonly pass: number;
  readonly skip: number;
  readonly limit: number;
}

export interface JpwScoreIn {
  readonly title: string;
  readonly credit: readonly { readonly type: string | null; readonly page: number; readonly text: string }[];
  readonly parts: readonly { readonly measures: readonly JpwMeasureIn[] }[];
  readonly playData: { readonly noRepeat: boolean; readonly tempo: number; readonly measures: readonly JpwPlayItemIn[] };
}

const isChord = (e: object): e is JpwChordIn => "notes" in e && "beats" in e;
const isLineBreak = (e: object): e is JpwLineBreakIn => "newPage" in e && "pass" in e;
const isBarline = (e: object): e is JpwBarlineIn => "style" in e && "repeat" in e;

// ───────────────────────── 歌词 ─────────────────────────

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
  private static readonly reg = /^\d\./;
  private static readonly punc = /[，。！？、“”：；]+/g;

  constructor(public part: { readonly measures: readonly JpwMeasureIn[] }) {}

  lines(res: string[]): void {
    for (const [k, v] of this.texts) {
      let head = "W" + k.passFirst;
      if (k.passFirst !== k.passLast) head += "-" + k.passLast;
      head += "@" + k.measure + "," + k.noteIndex + ":";
      res.push(head);
      let str = v;
      if (str.endsWith("/")) str = str.replace(/\/+$/, "");
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

  private onChord(ch: JpwChordIn): void {
    const lrcs = ch.notes[0]!.lyrics;
    if (lrcs.length > this.numVerses) this.numVerses = lrcs.length;
    const lrc = lrcs[0];
    if (!lrc) { this.appendSlash(); return; }
    if (lrc.refrain) {
      if (!this.refrain) {
        const seg: Segment = { passFirst: 1, passLast: 1, measure: this.mid, noteIndex: this.nid };
        this.refrain = seg;
        this.texts.set(seg, "");
      }
      this.texts.set(this.refrain, (this.texts.get(this.refrain) ?? "") + this.makeText(lrc.text));
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
        this.texts.set(seg, (this.texts.get(seg) ?? "") + this.makeText(it.text));
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
    for (const m of this.part.measures) {
      this.mid++;
      this.nid = 0;
      for (const ch of m.entries) {
        // 口径同读入端（`fromjpw.ts` / `jpwimport.ts` 的 `assignLyrics`）：只有**小节中间**的换行才算开出一个新小节，
        // 小节末尾的不算。从前每个换行都算，歌词段起点 `W2@m,n` 在第一行之后就错位（018 原文 `@9` 写成 `@11`）
        if (isLineBreak(ch)) {
          if (ch !== m.entries[m.entries.length - 1]) { this.mid++; this.nid = 0; }
          continue;
        }
        if (!isChord(ch)) continue;
        this.nid++;
        this.onChord(ch);
      }
    }
    if (this.refrain) this.refrain.passLast = this.numVerses;
  }
}

// ───────────────────────── 写出 ─────────────────────────

class JpwWriter {
  lines: string[] = [];

  write(scr: JpwScoreIn): void {
    this.lines.push("// ************** JPW-ABC File Ver 1.0 (for JP-Word v5.50m) **************");
    this.makeMetaData(scr);
    this.makeVoiceData(scr.parts[0]!);
    this.makeWordData(scr.parts[0]!);
    this.makeRepeatData(scr);
  }

  private makeRepeatData(scr: JpwScoreIn): void {
    if (scr.playData.noRepeat) return;
    if (scr.playData.measures.length === 0) return;
    this.lines.push(".Repeat");
    for (const it of scr.playData.measures) {
      const head = it.skip > 0 ? `${it.mid + 1}.${it.skip + 1}` : `${it.mid + 1}`;
      const tail = it.limit >= 0 ? `${it.end}.${it.limit}` : `${it.end}`;
      this.lines.push(`${head}-${tail}V${it.pass}`);
    }
  }

  private makeMetaData(scr: JpwScoreIn): void {
    this.lines.push(".Title");
    this.lines.push("Title = " + escape(scr.title));
    const firstMea = scr.parts[0]!.measures[0]!;
    const tm = firstMea.time;
    this.lines.push(`KeyAndMeters = {1=${firstMea.key.name},${tm.beats}/${tm.beatType}}`);
    const authors: string[] = [];
    for (const it of scr.credit) {
      if (it.type === "title") continue;
      // 副标题不是著作者。`.jpwabc` 的 `.Title` 段没有副标题字段（既定，不扩语法），只能丢；
      // 混进 WordsByAndMusicBy 会在版面上把曲名英译印成作者名。
      if (it.type === "subtitle") continue;
      if (it.page !== 0) continue;
      authors.push(escape(it.text.trim()));
    }
    const order = (s: string) =>
      s.includes("词") ? 5 : s.includes("译") ? 4 : s.includes("曲") ? 3 : s.includes("编") ? 2 : 1;
    authors.sort((a, b) => order(b) - order(a));
    this.lines.push(`WordsByAndMusicBy = ${authors.join("\\n")}`);
    // 速度记进 JP-Word 原生的 Expression 字段，位置也依原样排在 WordsByAndMusicBy 之后。
    // 音符符号直接写 `♩`（JP-Word 自己存的是 ASCII `J`，靠音乐字体映射成四分音符；这里用真
    // Unicode 音符，源码/文本里所见即所得）。读取端两种都认。
    if (scr.playData.tempo > 0) this.lines.push(`Expression = {♩=${scr.playData.tempo}}`);
  }

  private makeWordData(part: { readonly measures: readonly JpwMeasureIn[] }): void {
    const proc = new LyricProcessor(part);
    proc.process();
    this.lines.push(".Words");
    proc.lines(this.lines);
  }

  private makeNotations(ch: JpwChordIn): string {
    return ch.fermata ? "{YanYin}" : "";
  }

  private static alter(p: JpwPitchIn): string {
    switch (p.jpAlter) {
      case "n": return "#b";
      case "b": case "#": return p.jpAlter;
      case " ": case "": case " ": return "";
      default: throw new Error("bad jpAlter");
    }
  }

  /** 倚音：`{` 一串音高 `}`，排在主音之前（文法 `Note` 里 Grace 就在 Pitch 之前）。
   *  倚音不带时值：排版那一端固定按八分音符画（`layout.ts::addGraceNotes`）。 */
  private graceVoice(ch: JpwChordIn): string {
    if (!ch.graceNotes.length) return "";
    let str = "";
    for (const g of ch.graceNotes) {
      if (g.jpAlter === "n" || g.jpAlter === "b" || g.jpAlter === "#") str += JpwWriter.alter(g);
      str += g.number;
      for (let i = 0; i < g.jpOctave; i++) str += "'";
      for (let i = 0; i < -g.jpOctave; i++) str += ",";
    }
    return `{${str}}`;
  }

  private chordVoice(ch: JpwChordIn): string {
    const nt = ch.notes[0]!;
    let str = JpwWriter.alter(nt);
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

  private makeBarline(m: JpwMeasureIn): string {
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

  private makeVoiceData(part: { readonly measures: readonly JpwMeasureIn[] }): void {
    this.lines.push(".Voice");
    let l = "";
    part.measures.forEach((m, mid) => {
      if (mid > 0 && m.newSystem && l.length > 0) {
        l += m.newPage ? "$(true,0,0,true)" : "$(true)";
        this.lines.push(l);
        l = "";
      }
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
      const prevM = mid > 0 ? part.measures[mid - 1]! : null;
      if (prevM && m.timeChange
        && (m.time.beats !== prevM.time.beats || m.time.beatType !== prevM.time.beatType)) {
        l += `${m.time.beats}/${m.time.beatType} `;
      }
      if (prevM && m.keyChange && m.key.fifths !== prevM.key.fifths) l += `"1=${m.key.name}" `;
      let hasBarline = false;
      m.entries.forEach((ch, idx) => {
        if (isLineBreak(ch)) {
          if (!hasBarline && idx === m.entries.length - 1) {
            l += this.makeBarline(m);
            hasBarline = true;
          }
          l += ch.newPage ? "$(true,0,0,true)" : "$(true)";
          this.lines.push(l);
          l = "";
        } else if (isChord(ch)) {
          const nt = ch.notes[0]!;
          if (nt.tieStart) l += "(";
          if (ch.slurStart) l += "(";
          if (nt.tupletBegin) l += "{(3}";
          l += this.makeNotations(ch);
          l += this.graceVoice(ch);
          l += this.chordVoice(ch);
          if (nt.tieEnd) l += ")";
          if (nt.tupletEnd) l += ")";
          l += ")".repeat(ch.slurEnds);
          l += " ";
        } else if (isBarline(ch)) {
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
  }

  get code(): string {
    return this.lines.join("\n");
  }
}

/** 一份满足输入形状的谱 → `.jpwabc` 文本（保留原始排版的换行）。 */
export function writeJpwabc(score: JpwScoreIn): string {
  const w = new JpwWriter();
  w.write(score);
  return w.code;
}

/** `ScoreDoc` → `.jpwabc` 文本（第 `songIdx` 首）。MusicXML 形状照 `loadMusicXml` 的口径，简谱形状照 `scoreDocToScore`。
 *  这首没有曲行时返回 null。 */
export function emitJpwabc(doc: ScoreDoc, songIdx = 0): string | null {
  const song = doc.songs[songIdx];
  if (!song) return null;
  const src = isXmlShaped(song) ? jpwInputOfDoc(song) : jpwInputOfSong(doc, songIdx);
  return src ? writeJpwabc(src) : null;
}
