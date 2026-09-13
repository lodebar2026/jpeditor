// 123 音乐体的词法——**薄壳**。真正的实现在 `src/abcfamily/`：
// 同源的部分（小节线、房号、装饰、和弦、倚音、多连音、行内字段…）在 `lex.ts` 基类里，
// 123 特有的音符写法在 `dialect123.ts`。为什么这么分见 `docs/模块/源格式-abc家族.md`。
//
// 这里保留 `lexMusicLine` 这个函数形态，是因为 `parse.ts` 与既有脚本都按它调用。

import { LEXER_123 } from "../abcfamily/dialect123";
import type { LexResult } from "../abcfamily/types";

export { expandEndingNumbers } from "../abcfamily/lex";
export type { LexResult, Token, TokenKind } from "../abcfamily/types";

/**
 * 扫一行 123 音乐体。
 * @param line 行文本（不含字段前缀）
 * @param lineNo 0 基行号
 * @param lineOffset 该行在全文里的 0 基偏移
 * @param columnBase 行内起始列（字段前缀的长度）
 */
export function lexMusicLine(
  line: string,
  lineNo: number,
  lineOffset: number,
  columnBase = 0,
): LexResult {
  return LEXER_123.lexLine(line, lineNo, lineOffset, columnBase);
}
