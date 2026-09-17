// Ported from mp/jpword/jpwfile.kt — .jpwabc section model + parsing.
// The TokenData/highlight tokenizer (parseTokens) is deferred to Phase 2;
// this module covers the semantic parse used by model/fromjpw.ts.

import { parseVoiceText, type VoiceContext } from "./parse";

export abstract class Section {
  lines: string[] = [];
  /** `lines[i]` 在原文里的 0 基行号与行首偏移（跳过的注释与空行照算）。`model/fromjpw.ts` 填 `SourceSpan` 用 */
  lineNos: number[] = [];
  lineOffsets: number[] = [];
  constructor(public name: string) {}
  parse(): boolean {
    return true;
  }

  static create(n: string): Section {
    const nn = n.toLowerCase().substring(1).trim();
    switch (nn) {
      case "voice": return new VoiceSection(nn);
      case "words": return new WordsSection(nn);
      case "attachments": return new GenericSection(nn);
      case "page": return new GenericSection(nn);
      case "title": return new TitleSection(nn);
      case "fonts": return new GenericSection(nn);
      case "options": return new GenericSection(nn);
      case "layout": return new LayoutSection(nn);
      case "repeat": return new RepeatSection(nn);
      default: throw new Error(`unknown section: ${n}`);
    }
  }
}

class GenericSection extends Section {}

export class LayoutSection extends Section {
  linesPerPage: string | null = null;
  breakPoints: string | null = null;

  get desc(): string | null {
    if (this.breakPoints !== null) return `BreakPoints = ${this.breakPoints}`;
    if (this.linesPerPage !== null) return `LinesPerPage = ${this.linesPerPage}`;
    return null;
  }

  override parse(): boolean {
    for (const l of this.lines) {
      if (!l.includes("=")) continue;
      const low = l.toLowerCase();
      const arr = low.split("=");
      if (arr.length !== 2) return false;
      switch (arr[0].trim()) {
        case "linesperpage": this.linesPerPage = arr[1].trim(); break;
        case "breakpoints": this.breakPoints = arr[1].trim(); break;
        default: return false;
      }
    }
    return true;
  }
}

export class RepeatSection extends Section {
  data: string[] = [];
  override parse(): boolean {
    const d = this.lines.join("\n").replace(/,/g, "\n");
    this.data.push(...d.split("\n"));
    return true;
  }
}

export class VoiceSection extends Section {
  voiceData!: VoiceContext;
  override parse(): boolean {
    const text = this.lines.join("\n");
    const voice = parseVoiceText(text);
    if (voice === null) return false;
    this.voiceData = voice;
    return true;
  }
}

export class WordsItem {
  text = "";
  alignPos = -1;
  constructor(s?: string) {
    if (s === undefined) return;
    this.text = "";
    for (const ch of s) {
      if (ch === "[") {
        this.alignPos = this.text.length;
        continue;
      } else if (ch === "]") {
        continue;
      } else {
        this.text += ch;
      }
    }
  }
}

export class WordsSegment {
  passFirst = 0;
  passLast = 0;
  measure = 0;
  noteIndex = 0;
  control: string[] | null = null;
  data: WordsItem[] = [];
}

const ASCII_LETTER = /[a-zA-Z]/;

export class WordsSection extends Section {
  segments: WordsSegment[] = [];

  // ctrl = "(\([0-9a-zA-Z.,]+\))?"; sticky-anchored at scan position.
  private static readonly regLrcSpec =
    /W(\d+)(-(\d+))?(\([0-9a-zA-Z.,]+\))?(@(\d+),(\d+))?(\([0-9a-zA-Z.,]+\))?:/y;

  override parse(): boolean {
    const text = this.lines.join("\n");
    let pos = 0;
    let lineBegin = true;
    const punc = ".,;'!?。：，；！？“”｡､、";
    const reg = WordsSection.regLrcSpec;
    /** 段首自成一项的「“」（见下方收尾处理） */
    const openQuoteHeads = new Set<WordsItem>();

    while (pos < text.length) {
      const ch = text[pos];
      if (ch === "\n") {
        pos++;
        lineBegin = true;
        continue;
      }
      if (lineBegin) {
        reg.lastIndex = pos;
        const m = reg.exec(text);
        if (m) {
          const seg = new WordsSegment();
          seg.passFirst = parseInt(m[1], 10);
          seg.passLast = m[3] ? parseInt(m[3], 10) : seg.passFirst;
          seg.measure = 1;
          seg.noteIndex = 1;
          if (m[6]) {
            seg.measure = parseInt(m[6], 10);
            seg.noteIndex = parseInt(m[7], 10);
          }
          if (m[8]) {
            seg.control = m[8].substring(1, m[8].length - 1).split(",");
          }
          this.segments.push(seg);
          pos += m[0].length;
          lineBegin = false;
          continue;
        }
      }
      lineBegin = false;
      if (ch === "{") {
        const end = text.indexOf("}", pos + 1);
        if (end < 0) throw new Error("");
        const t = text.substring(pos + 1, end);
        this.last().data.push(new WordsItem(t));
        pos = end + 1;
        continue;
      }
      if (this.segments.length === 0) throw new Error("");
      if (" -()".includes(ch)) {
        pos++;
        continue;
      }
      if (ch === "/") {
        pos++;
        this.last().data.push(new WordsItem());
        continue;
      }
      if (ch.charCodeAt(0) <= 0x7f && ASCII_LETTER.test(ch)) {
        let end = pos + 1;
        while (end < text.length) {
          const ch2 = text[end];
          if (ch2.charCodeAt(0) >= 0x7f) break;
          if (!ASCII_LETTER.test(ch2)) break;
          end++;
        }
        const t = text.substring(pos, end);
        this.last().data.push(new WordsItem(t));
        pos = end + 1;
        continue;
      }
      if (punc.includes(ch)) {
        const last = this.last().data;
        if (last.length > 0) {
          last[last.length - 1].text += ch;
          pos++;
          continue;
        }
      }
      if (ch.charCodeAt(0) < 0x7f) console.error("unsupported char?");
      const item = new WordsItem(ch);
      if (ch === "“" && this.last().data.length === 0) openQuoteHeads.add(item);
      this.last().data.push(item);
      pos++;
    }

    for (const s of this.segments) {
      let prev: WordsItem | null = null;
      for (const d of s.data) {
        if (prev === null) {
          prev = d;
          continue;
        }
        if (prev.text.endsWith("“")) {
          prev.text = prev.text.replace(/“$/, "");
          d.text = "“" + d.text;
        }
        prev = d;
      }
      // 段首就是「“」（`W2@1,1:` 下一行「“爱”之救赎…」）：它前面没有字可挂、自成一项，挪给下一个字后
      // 只剩一个空项——整段歌词从第 2 个音起、写出再读回每轮再错一格。这一项本不占音符，去掉。
      if (s.data.length > 1 && s.data[0]!.text === "" && openQuoteHeads.has(s.data[0]!)) s.data.shift();
    }
    return true;
  }

  private last(): WordsSegment {
    return this.segments[this.segments.length - 1];
  }
}

export class TitleSection extends Section {
  values = new Map<string, string>();

  get title(): string | null {
    return this.getValue("title");
  }
  get keyAndMeters(): string | null {
    return this.getValue("KeyAndMeters");
  }
  get wordsMusicBy(): string | null {
    return this.getValue("WordsByAndMusicBy");
  }
  /** 速度/表情记号原文。JP-Word 用 `Expression` 一个字段兼记两者：可以是纯文字
   *  （`Expression = 热烈欢快地`），也可以是速度（`Expression = {♩=80}`）。
   *  parse() 已剥掉外层 {}，故这里拿到的是 `♩=80` / `热烈欢快地`。 */
  get expression(): string | null {
    return this.getValue("Expression");
  }
  /** 从 Expression 里取 ♩=NN 的数值；没写速度（纯表情文字）或超范围则 0。
   *  本项目写出的是 `♩`；JP-Word 自己存的是 ASCII `J`（它按音乐字体映射成四分音符），
   *  两种都认，免得读别处来的谱丢速度。 */
  get tempo(): number {
    const m = /[J♩]\s*=\s*(\d+)/i.exec(this.expression ?? "");
    const v = m ? parseInt(m[1], 10) : 0;
    return v >= 20 && v <= 400 ? v : 0;
  }
  get key(): string | null {
    const km = this.keyAndMeters;
    if (km === null) return null;
    const arr = km.split(",");
    return substringAfter(arr[0], "=").trim();
  }
  get meter(): string | null {
    const km = this.keyAndMeters;
    if (km === null) return null;
    const arr = km.split(",");
    return arr[1].trim();
  }
  getValue(key: string): string | null {
    return this.values.get(key.toLowerCase()) ?? null;
  }

  override parse(): boolean {
    for (const l of this.lines) {
      if (l.trim().length === 0) continue;
      const idx = l.indexOf("=");
      if (idx > 0) {
        const key = l.substring(0, idx).trim();
        let v = l.substring(idx + 1).trim();
        v = substringAfter(v, "{");
        v = substringBeforeLast(v, "}");
        this.values.set(key.toLowerCase(), v);
      } else {
        console.error("bad line");
      }
    }
    return true;
  }
}

export class JpwFile {
  lines: string[] = [];
  sections: Section[] = [];

  static fromString(s: string): JpwFile | null {
    const res = new JpwFile();
    // parse() 对「正文出现在任何段落头之前」是抛异常的（见 parse）。fromString 的契约
    // 是「解析不了就给 null」——异常在这里吞掉，否则每个调用方都得记着包 try。
    let ok: boolean;
    try {
      ok = res.parse(s.split("\n"));
    } catch {
      return null;
    }
    return ok ? res : null;
  }

  getLyric(): WordsSection | null {
    return this.sections.find((s) => s instanceof WordsSection) as WordsSection ?? null;
  }
  getVoice(): VoiceSection | null {
    return this.sections.find((s) => s instanceof VoiceSection) as VoiceSection ?? null;
  }
  getTitle(): TitleSection | null {
    return this.sections.find((s) => s instanceof TitleSection) as TitleSection ?? null;
  }
  getSection<T extends Section>(cls: new (...args: never[]) => T): T | null {
    return (this.sections.find((s) => s instanceof cls) as T) ?? null;
  }

  parse(lines: string[]): boolean {
    let offset = 0;
    for (const [no, raw] of lines.entries()) {
      const at = offset;
      offset += raw.length + 1;
      // JP-Word 存的是 Windows 换行（\r\n）：按 \n 切完行尾还挂着 \r。不去掉的话歌词段把每个行尾的 \r
      // 当成一个音节，整段往后错一格（语料 567 份、3414 处，报「unsupported char?」）。偏移仍按原行长算。
      const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (l.startsWith("//")) continue;
      if (l.length === 0) continue;
      if (l.startsWith(".")) {
        this.sections.push(Section.create(l));
        continue;
      }
      if (this.sections.length === 0) throw new Error("");
      const sec = this.sections[this.sections.length - 1];
      sec.lines.push(l);
      sec.lineNos.push(no);
      sec.lineOffsets.push(at);
    }
    for (const s of this.sections) {
      if (!s.parse()) return false;
    }
    return true;
  }
}

// Kotlin substringAfter/substringBeforeLast semantics (return whole if not found).
function substringAfter(s: string, delim: string): string {
  const i = s.indexOf(delim);
  return i < 0 ? s : s.substring(i + delim.length);
}
function substringBeforeLast(s: string, delim: string): string {
  const i = s.lastIndexOf(delim);
  return i < 0 ? s : s.substring(0, i);
}
