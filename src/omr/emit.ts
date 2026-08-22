// 识别结果的输出格式注册表。
//
// `RecognizedScore` 是**格式无关**的那一份，识别完留在内存里；换输出格式只重走这里的
// emitter，**绝不重跑识别**（识别要几十秒，格式转换是毫秒级）。
//
// 为什么要注册表而不是 if：格式清单以前散在 editor/app.ts（类型、下拉选项、
// `_emitRecognition` 的两个分支各一处），加一种格式要同时改三处、还得记得两处的 meta
// 编号约定必须一致。现在加一种 = 往 OMR_EMITTERS 里补一项。
//
// **meta 的序号约定**：所有 emitter 产出的 `JpwMeta`，`noteRanges` / `lyricRanges`
// 一律按 `flatten(rows[].nums)` 的下标编号。识别模式「原图对照」的点选定位
// （app.ts::_rangeOfHit）因此不必分格式。
import type { RecognizedScore } from "./types";
import { toMusicXml } from "./musicxml";
import { toPuText } from "./topu";
import { DIALECTS, type Dialect } from "../pu/dialect";
import type { JpwMeta } from "../score/jpscore";

/** 识别结果的输出格式。文本谱两种方言各算一种。 */
export type OmrFormat = "jpwabc" | Dialect;

export interface EmittedScore {
  /** 产物怎么落到编辑器里：
   *  - `musicxml`：交现有的 MusicXML 导入路径（那条路自己会产出 meta，故这里 meta 为 null）；
   *  - `pu`：文本谱原文，直接设进编辑器，meta 由 emitter 给出。 */
  kind: "musicxml" | "pu";
  text: string;
  meta: JpwMeta | null;
}

export interface ScoreEmitter {
  id: OmrFormat;
  /** 下拉里的显示名 */
  label: string;
  emit(rec: RecognizedScore): EmittedScore;
}

/** 顺序即下拉里的顺序；第一项是默认。 */
export const OMR_EMITTERS: readonly ScoreEmitter[] = [
  {
    id: "jpwabc",
    label: "简谱 jpwabc",
    emit: (rec) => ({ kind: "musicxml", text: toMusicXml(rec), meta: null }),
  },
  ...(Object.values(DIALECTS).map((d) => ({
    id: d.id,
    label: d.name,
    emit: (rec: RecognizedScore): EmittedScore => {
      const { text, meta } = toPuText(rec, d.id);
      return { kind: "pu" as const, text, meta };
    },
  }))),
];

export const DEFAULT_OMR_FORMAT: OmrFormat = OMR_EMITTERS[0]!.id;

export function isOmrFormat(v: unknown): v is OmrFormat {
  return OMR_EMITTERS.some((e) => e.id === v);
}

export function omrEmitter(id: OmrFormat): ScoreEmitter {
  return OMR_EMITTERS.find((e) => e.id === id) ?? OMR_EMITTERS[0]!;
}
