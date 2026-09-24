// Ported from mp/jpword/jpwfile.kt TokenInfo/TokenData — the line-based
// tokenizer used for editor syntax highlighting (NOT the semantic parse).
// Produces a contiguous list of {type,text} tokens covering the whole document
// (including whitespace as Space tokens), so offsets can be accumulated.

import { lexVoice, type JpwTok } from "./lex";

// 行级 token 类型；`.Voice` 里的 token 直接用词法器的类型（`JpwTok`）
export const TokType = {
  Space: "space",
  Unknown: "unknown",
  Text: "text",
  Lrc: "lrc",
  LrcSpec: "lrcspec",
  Slash: "slash",
  MetaValue: "metaval",
  MetaKey: "metakey",
  SectionName: "section",
} as const;

export interface TokenInfo {
  type: JpwTok | (typeof TokType)[keyof typeof TokType];
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
        res.add({ type: "comment", text: l });
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

// .Voice: tokenize via lexVoice; whitespace and skipped (unrecognized) chars become Space.
function parseVoiceTokens(res: TokenData, txt: string): void {
  let last = 0;
  for (const t of lexVoice(txt)) {
    if (t.type === "ws") continue;
    if (t.start > last) res.space(txt.substring(last, t.start));
    res.add({ type: t.type, text: t.text });
    last = t.end;
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
export const tokenClass: Partial<Record<TokenInfo["type"], string>> = {
  note: "note",
  return: "break",
  barline: "barline",
  comment: "comment",
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
