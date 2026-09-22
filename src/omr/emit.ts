// 识别结果的输出格式。
//
// `RecognizedScore` 是**格式无关**的那一份，识别完留在内存里；换输出格式只重走这里，
// **绝不重跑识别**（识别要几十秒，格式转换是毫秒级）。
//
// 各格式一律先转成模型（`recognizedToDoc`），再由转换目标表（`model/convert.ts`）写成文本——
// 与打开文件后切格式、另存为别的格式是同一张表、同一批写出端。文本谱以前另有一个直接从识别结果写的
// emitter，已退役（`model/topu.ts` 是唯一一份）：两份写出端的判据迟早分叉。
//
// **meta 的序号约定**：所有格式的 `JpwMeta`，`noteRanges` / `lyricRanges`
// 一律按 `flatten(rows[].nums)` 的下标编号，由重解析写出的文本得到（`omr/meta.ts`）。
// 识别模式「原图对照」的点选定位（omrctl.ts::rangeOfHit）因此不必分格式。
import type { JpwMeta, RecognizedScore } from "./types";
import type { ScoreDoc } from "../model/doc";
import { CONVERT_TARGETS, type ConvertTarget } from "../model/convert";
import { recognizedToDoc } from "./todoc";
import { metaFrom123, metaFromPu } from "./meta";

/** 识别结果的输出格式：就是转换目标（文本谱两种方言各算一种）。 */
export type OmrFormat = ConvertTarget;

export interface EmittedScore {
  /** 产物在编辑器里按哪种源格式打开（123 另交 `App.importOmrDoc`，报它装不下的东西） */
  kind: "123" | "abc" | "jpwabc" | "pu";
  text: string;
  /** 点选映射。`.jpwabc` / ABC 没有（`null`） */
  meta: JpwMeta | null;
  /** 识别直出的模型（`omr/todoc.ts`），`text` 就是它写成的文本 */
  doc: ScoreDoc;
}

export interface ScoreEmitter {
  id: OmrFormat;
  /** 下拉里的显示名 */
  label: string;
  emit(rec: RecognizedScore): EmittedScore;
}

/** 顺序即下拉里的顺序；第一项是默认。 */
export const OMR_EMITTERS: readonly ScoreEmitter[] = CONVERT_TARGETS.map((t) => ({
  id: t.id,
  label: t.label,
  emit: (rec: RecognizedScore): EmittedScore => {
    const doc = recognizedToDoc(rec);
    const text = t.emit(doc);
    const meta = t.docFormat === "123" ? metaFrom123(text)
      : t.id === "tomato" || t.id === "shige" ? metaFromPu(text, t.id)
      : null;
    return { kind: t.docFormat, text, meta, doc };
  },
}));

export const DEFAULT_OMR_FORMAT: OmrFormat = OMR_EMITTERS[0]!.id;

export function isOmrFormat(v: unknown): v is OmrFormat {
  return OMR_EMITTERS.some((e) => e.id === v);
}

export function omrEmitter(id: OmrFormat): ScoreEmitter {
  return OMR_EMITTERS.find((e) => e.id === id) ?? OMR_EMITTERS[0]!;
}
