// Ported from mp/jpword/jpwfile.kt TokenInfo/TokenData — the line-based
// tokenizer used for editor syntax highlighting (NOT the semantic parse).
// Produces a contiguous list of {type,text} tokens covering the whole document
// (including whitespace as Space tokens), so offsets can be accumulated.

import { CharStream, CommonTokenStream } from "antlr4";
import JpwabcLexer from "./parser/JpwabcLexer.js";

// custom token types (must not collide with ANTLR lexer types 1..12)
export const TokType = {
  Space: 98,
  Unknown: 99,
  Text: 100,
  Lrc: 101,
  LrcSpec: 102,
  Slash: 103,
  MetaValue: 104,
  MetaKey: 105,
  SectionName: 106,
} as const;

export interface TokenInfo {
  type: number;
  text: string;
}

export class TokenData {
  tokens: TokenInfo[] = [];

  add(t: TokenInfo): void {
    this.tokens.push(t);
  }
  space(s: string): void {
    this.tokens.push({ type: TokType.Space, text: s });
  }
  newLine(): void {
    this.space("\n");
  }

  static parse(txt: string): TokenData {
    const lines = txt.split("\n");
    const res = new TokenData();
    let lid = 0;
    while (lid < lines.length) {
      const l = lines[lid];
      if (l.startsWith("//")) {
        res.add({ type: JpwabcLexer.LINE_COMMENT, text: l });
        res.newLine();
        lid++;
      } else if (l.startsWith(".")) {
        res.add({ type: TokType.SectionName, text: l });
        res.newLine();

        const trim = l.trim().toLowerCase();
        const first = lid + 1;
        let end = lid + 1;
        while (end < lines.length) {
          if (lines[end].startsWith(".")) break;
          end++;
        }
        const arr: string[] = [];
        for (let i = first; i < end; i++) arr.push(lines[i]);
        lid = end;

        switch (trim.substring(1)) {
          case "voice":
            parseVoiceTokens(res, arr.join("\n") + "\n");
            break;
          case "words":
            parseWordsTokens(res, arr.join("\n") + "\n");
            break;
          case "title":
            parseTitleTokens(res, arr.join("\n"));
            break;
          default:
            for (const ll of arr) {
              res.add({ type: TokType.Unknown, text: ll });
              res.newLine();
            }
        }
      } else {
        // blank / stray line between sections — keep verbatim so offsets stay aligned
        res.space(l);
        if (lid < lines.length - 1) res.newLine();
        lid++;
      }
    }
    return res;
  }
}

// .Voice: tokenize via the ANTLR lexer, emitting Space for skipped gaps.
function parseVoiceTokens(res: TokenData, txt: string): void {
  const chars = new CharStream(txt);
  const lexer = new JpwabcLexer(chars);
  lexer.removeErrorListeners();
  const tokStrm = new CommonTokenStream(lexer);
  tokStrm.fill();
  let last = 0;
  for (const t of tokStrm.tokens) {
    if (t.type === -1 /* EOF */) continue;
    const startIndex = (t as unknown as { start: number }).start;
    const stopIndex = (t as unknown as { stop: number }).stop;
    if (startIndex > last) res.space(txt.substring(last, startIndex));
    res.add({ type: t.type, text: t.text ?? "" });
    last = stopIndex + 1;
  }
  if (txt.length > last) res.space(txt.substring(last));
}

// .Words: lyric-spec lines vs. lyric text split on '/'.
const regLrcSpec = /W(\d+)(-(\d+))?(\([0-9a-zA-Z.,]+\))?(@(\d+),(\d+))?(\([0-9a-zA-Z.,]+\))?:/;

function parseWordsTokens(res: TokenData, txt: string): void {
  const lines = txt.split("\n");
  lines.forEach((l, idx) => {
    if (regLrcSpec.test(l) && regLrcSpec.exec(l)?.index === 0) {
      res.add({ type: TokType.LrcSpec, text: l });
      res.newLine();
    } else {
      let offset = 0;
      const re = /\//g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(l)) !== null) {
        const st = m.index;
        if (st > offset) res.add({ type: TokType.Lrc, text: l.substring(offset, st) });
        res.add({ type: TokType.Slash, text: "/" });
        offset = re.lastIndex;
      }
      if (l.length > offset) res.add({ type: TokType.Lrc, text: l.substring(offset) });
      if (idx !== lines.length - 1) res.newLine();
    }
  });
}

// .Title: KEY = VALUE pairs.
function parseTitleTokens(res: TokenData, txt: string): void {
  const lines = txt.split("\n");
  for (const l of lines) {
    if (l.trim().length === 0) {
      res.newLine();
      continue;
    }
    const idx = l.indexOf("=");
    if (idx > 0) {
      res.add({ type: TokType.MetaKey, text: l.substring(0, idx + 1) });
      res.add({ type: TokType.MetaValue, text: l.substring(idx + 1) });
      res.newLine();
    } else {
      console.error("bad line");
    }
  }
}

// token type -> CSS class (from CodeEditor.kt `classes`)
export const tokenClass: Record<number, string> = {
  [JpwabcLexer.Note]: "note",
  [JpwabcLexer.Return]: "break",
  [JpwabcLexer.Barline]: "barline",
  [JpwabcLexer.LINE_COMMENT]: "comment",
  [TokType.Text]: "text",
  [TokType.Lrc]: "lrc",
  [TokType.Slash]: "slash",
  [TokType.LrcSpec]: "lrcspec",
  [TokType.MetaKey]: "metakey",
  [TokType.MetaValue]: "metaval",
  [TokType.Unknown]: "unknown",
  [TokType.SectionName]: "section",
  [TokType.Space]: "space",
};
