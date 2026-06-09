// Thin wrapper over the ANTLR-generated lexer/parser (faithful to Jpwabc.g4).
// Mirrors VoiceSection.parse() in jpwfile.kt.

import { CharStream, CommonTokenStream } from "antlr4";
import JpwabcLexer from "./parser/JpwabcLexer.js";
import JpwabcParser, { VoiceContext } from "./parser/JpwabcParser.js";

/** Parse a .Voice section body into the ANTLR VoiceContext (entry* tree). */
export function parseVoiceText(text: string): VoiceContext | null {
  const chars = new CharStream(text);
  const lexer = new JpwabcLexer(chars);
  lexer.removeErrorListeners();
  const tokens = new CommonTokenStream(lexer);
  const parser = new JpwabcParser(tokens);
  parser.removeErrorListeners();
  try {
    const voice = parser.voice();
    // require full consumption (mirrors strm.index()!=strm.size() check)
    if (chars.index !== chars.size) return null;
    return voice;
  } catch {
    return null;
  }
}

export { JpwabcLexer, JpwabcParser };
export type { VoiceContext };
