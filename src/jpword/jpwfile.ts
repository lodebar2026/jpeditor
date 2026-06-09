// Ported from mp/jpword/jpwfile.kt — .jpwabc section model + parsing.
// The TokenData/highlight tokenizer (parseTokens) is deferred to Phase 2;
// this module covers the semantic parse used by JpwImport.fromJpw.

import { parseVoiceText, type VoiceContext } from "./parse";

export abstract class Section {
  lines: string[] = [];
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
      switch (arr[0]) {
        case "linesperpage": this.linesPerPage = arr[1]; break;
        case "breakpoints": this.breakPoints = arr[1]; break;
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
      this.last().data.push(new WordsItem(ch));
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
    const ok = res.parse(s.split("\n"));
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
    for (const l of lines) {
      if (l.startsWith("//")) continue;
      if (l.length === 0) continue;
      if (l.startsWith(".")) {
        this.sections.push(Section.create(l));
        continue;
      }
      if (this.sections.length === 0) throw new Error("");
      this.sections[this.sections.length - 1].lines.push(l);
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
