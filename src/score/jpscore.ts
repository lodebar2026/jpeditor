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
import { computePhraseBreaks, type PhraseBreaks } from "./phrase";

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

class JpScore {
  lines: string[] = [];
  // 点选定位用的行内相对记录（最后 computeMeta 换算成绝对偏移）。
  private noteRecs: Rec[] = []; // 按 Chord 序
  private titleRec: Rec | null = null;
  private authorRecs: Array<{ text: string; rec: Rec }> = [];
  private _proc: LyricProcessor | null = null; // 保留 LyricProcessor 以便取歌词逐音节记录
  private _breaks: PhraseBreaks | null = null;  // 乐句模式的断行，makeVoiceData / makeWordData 共用

  constructor(private phrase = false) {}

  fromMusicXml(scr: Score): void {
    this.lines.push("// ************** JPW-ABC File Ver 1.0 (for JP-Word v5.50m) **************");
    this.makeMetaData(scr);
    this._breaks = this.phrase ? computePhraseBreaks(scr.parts[0]) : null;
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
    for (const it of scr.playData.measures) {
      this.lines.push(`${it.mid + 1}-${it.end}V${it.pass}`);
    }
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

  // 乐句排版：按实际乐句行数重排每页换页标记（每页至多 4 行；末页仅剩 1 行的 4+1
  // 情形把最后一个换页上移一行 → 3+2）。voiceStart = .Voice 首行在 this.lines 的下标。
  private balanceVoicePages(voiceStart: number): void {
    const R = this.lines.length - voiceStart;
    if (R <= 0) return;
    const pageAt = new Set<number>(); // 1 基乐句行号：其行尾为换页
    for (let p = 4; p <= R - 1; p += 4) pageAt.add(p);
    pageAt.add(R); // 末行收尾（分隔反复段）
    if (R % 4 === 1 && R >= 5) {
      pageAt.delete(R - 1);
      pageAt.add(R - 2);
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
    let l = "";
    let lineNo = 0;
    // 换行：乐句模式每 4 行自动换页（一页不超过 4 行）；否则沿用源换页标记。
    const pushBreak = (sourcePage: boolean): void => {
      lineNo++;
      const page = breaks ? lineNo % 4 === 0 : sourcePage;
      l += page ? "$(true,0,0,true)" : "$(true)";
      this.lines.push(l);
      l = "";
    };
    part.measures.forEach((m, mid) => {
      const doBreak = mid > 0 && (breaks ? breaks.measureBreaks.has(mid) : m.newSystem);
      // l 为空说明上一乐句刚在小节内(midBreak)断过，别再补一次空行。
      if (doBreak && l.length > 0) pushBreak(m.newPage);
      if (m.repeatForward) {
        l += "|:";
        if (m.endingLeft) {
          l += "[";
          const nums = m.endingNum!;
          if (nums.size === 1) l += [...nums][0];
          else throw new Error("multi-ending");
        }
      }
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
          const nt = ch.notes[0];
          if (nt.tieStart) l += "(";
          if (ch.slurStart) l += "(";
          if (nt.tupletBegin) l += "{(3}";
          l += this.makeNotations(ch);
          // 记录本音符 token 区间（仅 chordVoice 段：数字+修饰，不含前后括号/记号/空格）。
          const colStart = l.length;
          l += this.chordVoice(ch);
          this.noteRecs.push({ line: this.lines.length, colStart, colEnd: l.length });
          if (nt.tieEnd) l += ")";
          if (nt.tupletEnd) l += ")";
          if (ch.slurEnd) l += ")";
          l += " ";
          // 乐句尾（弱起谱漏进本小节的休止/长音）处行内换行，不加小节线。
          if (breaks?.midBreaks.has(ch)) pushBreak(false);
        } else if (ch instanceof BarlineEntry) {
          if (!ch.position.equals(0)) {
            const bl = this.makeBarline(m);
            const next = part.measures[mid + 1];
            if (next?.repeatForward) {
              /* leading repeat handles its own barline */
            } else if (m.barline !== BarStyle.NONE) {
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

  get code(): string {
    return this.lines.join("\n");
  }
}

/** MusicXML-derived Score -> .jpwabc text.
 *  opts.phrase=true 时按乐句分析重新断行（覆盖源自带换行）；默认保留原始排版。 */
export function scoreToJpwabc(score: Score, opts?: { phrase?: boolean }): string {
  return scoreToJpwabcWithMeta(score, opts).text;
}

/** 同 scoreToJpwabc，但额外产出「识别对象 → 代码区间」映射（OMR 识别模式点选定位用）。 */
export function scoreToJpwabcWithMeta(score: Score, opts?: { phrase?: boolean }): { text: string; meta: JpwMeta } {
  const jp = new JpScore(opts?.phrase ?? false);
  jp.fromMusicXml(score);
  return { text: jp.code, meta: jp.computeMeta() };
}
