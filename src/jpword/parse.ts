// `.Voice` 正文 → token 序列（去掉空白与注释）。对应 jpwfile.kt 的 VoiceSection.parse()。

import { lexVoice, type JpwToken } from "./lex";

/** 解析 `.Voice` 正文；出现落单的 `[` / `]` 时返回 null（原实现同样判解析失败）。 */
export function parseVoiceText(text: string): JpwToken[] | null {
  const out: JpwToken[] = [];
  for (const t of lexVoice(text)) {
    if (t.type === "ws" || t.type === "comment") continue;
    if (t.type === "lbrack" || t.type === "rbrack" || t.type === "rbrace") return null;
    out.push(t);
  }
  return out;
}
