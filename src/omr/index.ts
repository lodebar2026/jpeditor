// src/omr 公共入口：简谱图像识别（OMR）。
// 副作用：装配浏览器运行时（ort-web）。Node CLI 不走这个入口，自己 setOmrRuntime(nodeRuntime)。
import { setOmrRuntime } from "./runtime";
import { browserRuntime } from "./runtime.browser";
import { installBrowserDecoder } from "./decode.browser";
setOmrRuntime(browserRuntime);
installBrowserDecoder();

export * from "./types";
export { binarize, rgbaToBinary, toGray, otsuThreshold } from "./preprocess";
export { connectedComponents } from "./ccl";
export { recognizeJianpu } from "./jianpu";
export { toMusicXml } from "./musicxml";
export { toPuText, keyNameOf } from "./topu";
export { OMR_EMITTERS, DEFAULT_OMR_FORMAT, isOmrFormat, omrEmitter } from "./emit";
export type { OmrFormat, ScoreEmitter, EmittedScore } from "./emit";
export type { OcrBackend } from "./ocr";
export { nullOcr } from "./ocr";
export { decodeToBinary } from "./decode";
export { paddleOcrBackend } from "./paddleocr";
export { recognizeMusicpp, recognizeMusicppDetailed } from "./recognize";
export type { MusicppDetail } from "./recognize";
export { buildStrip } from "./lyrics";
export { createSurface, surfaceFromBinary, blit } from "./surface";
export type { Surface } from "./surface";
export { renderRecognitionSvg, renderRowPopup, renderHeaderPopup } from "./overlay";
export type { RecogView } from "./overlay";

export { setOmrRuntime } from "./runtime";
export type { OmrRuntime } from "./runtime";
