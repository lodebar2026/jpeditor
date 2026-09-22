// 按行解析的公共件。

/** 各行起点的字符偏移，与 `text.split(/\r?\n/)` 的行一一对应。
 *  按**实际换行符的长度**累计：CRLF 文件用 `raw.length + 1` 累计时每行少算一个字符，
 *  到第 n 行就偏 n，SourceSpan 取回的原文全错位。 */
export function lineStarts(text: string): number[] {
  const out = [0];
  for (const m of text.matchAll(/\r?\n/g)) out.push(m.index + m[0].length);
  return out;
}
