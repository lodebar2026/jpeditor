// `.abc` 写出端的函数入口（与 `j123/emit.ts` 的 `emit123` 对称）。

import type { ScoreDoc } from "../model/doc";
import { EMITTER_ABC } from "./emitabc";

/** 整份文档 → `.abc` 文本。多曲之间空一行，每首都带 `X:`（ABC tunebook 的分隔）。 */
export function emitAbc(doc: ScoreDoc): string {
  return EMITTER_ABC.emitDoc(doc);
}
