// 源格式之间的**转换目标注册表**：同一份 `ScoreDoc` 能写成哪几种可编辑的文本格式。
//
// 用它的有三处，以前各列各的：识别结果的输出格式（`omr/emit.ts`）、打开文件后在代码区标题栏切格式
// （`editor/formatswitch.ts`）、另存为别的源格式（`App.saveAsFormat`）。加一种目标格式 = 往这里补一项。
// 无 DOM 依赖（Node CLI 与回归脚本也用）。

import type { ScoreDoc } from "./doc";
import type { TargetFormat } from "./capability";
import { emit123 } from "../j123/emit";
import { emitAbc } from "../abcfamily/emitabc.entry";
import { emitJpwabc } from "./tojpw";
import { emitPu } from "./topu";
import { DIALECTS } from "../pu/dialect";
import { withPageMeta } from "./pagemeta";

/** 可写出的文本格式。文本谱两种方言各算一种。 */
export type ConvertTarget = "123" | "abc" | "jpwabc" | "tomato" | "shige";

export interface TargetSpec {
  id: ConvertTarget & TargetFormat;
  /** 下拉里的显示名 */
  label: string;
  /** 写出来的文本在编辑器里按哪种源格式打开（`editor/formats.ts::DocFormatId`） */
  docFormat: "123" | "abc" | "jpwabc" | "pu";
  emit(doc: ScoreDoc): string;
}

/** 顺序即下拉里的顺序；第一项是识别的默认输出格式。 */
export const CONVERT_TARGETS: readonly TargetSpec[] = [
  // 123 / ABC 把 MusicXML 的纸写成 `I:meta page …`（`pagemeta.ts`），转过去再打开纸不丢
  { id: "123", label: "简谱 123", docFormat: "123", emit: (doc) => emit123(withPageMeta(doc)) },
  {
    id: "jpwabc",
    label: "简谱 JPWABC",
    docFormat: "jpwabc",
    emit: (doc) => {
      const text = emitJpwabc(doc);
      if (text === null) throw new Error("没有可写出的曲行");
      return text;
    },
  },
  { id: "abc", label: "ABC", docFormat: "abc", emit: (doc) => emitAbc(withPageMeta(doc)) },
  { id: "tomato", label: DIALECTS.tomato.name, docFormat: "pu", emit: (doc) => emitPu(doc, "tomato") },
  { id: "shige", label: DIALECTS.shige.name, docFormat: "pu", emit: (doc) => emitPu(doc, "shige") },
];

export function isConvertTarget(v: unknown): v is ConvertTarget {
  return CONVERT_TARGETS.some((t) => t.id === v);
}

export function targetSpec(id: ConvertTarget): TargetSpec {
  return CONVERT_TARGETS.find((t) => t.id === id) ?? CONVERT_TARGETS[0]!;
}
