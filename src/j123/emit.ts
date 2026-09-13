// `ScoreDoc` → `.123` 文本——**薄壳**。真正的实现在 `src/abcfamily/`：
// 同源的部分（字段头、声部、歌词对位、小节线与房号、Mark 索引、符杠分组、`I:` 扩展）
// 在 `emit.ts` 基类里，123 特有的音符/休止/时值/调号写法在 `emit123.ts`。
// 为什么这么分见 `docs/模块/源格式-abc家族.md`。

import type { ScoreDoc, Song } from "../model/doc";
import { EMITTER_123 } from "../abcfamily/emit123";

/** 一首歌 → `.123` 文本。
 *  @param fallbackNumber 没有曲号时用它补一个——**多曲文件必须给**，
 *    因为 123 的多曲就是靠 `X:` 分隔（规范 §1，同 ABC tunebook）。 */
export function emitSong(song: Song, fallbackNumber?: number): string {
  return EMITTER_123.emitSong(song, fallbackNumber);
}

/** 整份文档 → `.123` 文本。多曲之间空一行，且**每首都带 `X:`**（分隔靠它）。 */
export function emit123(doc: ScoreDoc): string {
  return EMITTER_123.emitDoc(doc);
}
