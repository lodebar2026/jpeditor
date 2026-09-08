// Node CLI 侧的简谱 OMR 入口：图片字节 → 文本谱 / MusicXML，**全程不起浏览器**。
// 由 `npm run build:cli` 打成 dist-cli/omr.js，供 scripts/omr-cli.mjs 与 OMR 回归脚本 import。
//
// 与 cli/index.ts 的分工：那个是**矢量 PDF 版面**那一摊（vector/inventory/pdflayout），
// 这个是**位图简谱识别**这一条（decode → jianpu → emit）。PDF 输入不走这里。
import { installNodeDecoder } from "../omr/decode.node";
import { setOmrRuntime } from "../omr/runtime";
import { nodeRuntime, threadInfo } from "../omr/runtime.node";
import { recognizeMusicppDetailed } from "../omr/recognize";
import { OMR_EMITTERS, DEFAULT_OMR_FORMAT, isOmrFormat, omrEmitter, type OmrFormat } from "../omr/emit";
import { omrProfile, omrProfileReset } from "../omr/paddleocr";

setOmrRuntime(nodeRuntime);
installNodeDecoder();

export { OMR_EMITTERS, DEFAULT_OMR_FORMAT, isOmrFormat, omrProfile, omrProfileReset, threadInfo };
export type { OmrFormat };
export { recognizeMusicppDetailed };
// 换解码器用（默认 sharp；要接别的解码库从这里换）。
export { setImageDecoder, decodeToBinary } from "../omr/decode";
export type { ImageDecoder, RgbaImage } from "../omr/decode";
export { toMusicXml } from "../omr/musicxml";
export { toPuText } from "../omr/topu";
export type { RecognizedScore, Binary } from "../omr/types";

export interface RecognizeResult {
  /** 输出原文（文本谱原文或 MusicXML）。 */
  text: string;
  /** `musicxml` = 交 MusicXML 导入路径；`pu` = 文本谱原文。 */
  kind: "musicxml" | "pu";
  format: OmrFormat;
  /** 识别中间产物，回归脚本要拿它算指标。 */
  detail: Awaited<ReturnType<typeof recognizeMusicppDetailed>>;
}

/** 图片字节 → 指定格式的谱面原文。format 默认诗歌本文本谱之外的注册表首项，见 OMR_EMITTERS。 */
export async function recognizeImage(
  bytes: Uint8Array,
  opts: { mime?: string; format?: OmrFormat } = {},
): Promise<RecognizeResult> {
  const format = opts.format && isOmrFormat(opts.format) ? opts.format : DEFAULT_OMR_FORMAT;
  const detail = await recognizeMusicppDetailed(bytes, opts.mime);
  const emitted = omrEmitter(format).emit(detail.score);
  return { text: emitted.text, kind: emitted.kind, format, detail };
}
