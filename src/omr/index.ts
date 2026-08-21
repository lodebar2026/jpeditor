// src/omr 公共入口：简谱图像识别（OMR）。
export * from "./types";
export { binarize, rgbaToBinary, toGray, otsuThreshold } from "./preprocess";
export { connectedComponents } from "./ccl";
export { recognizeJianpu } from "./jianpu";
export { toMusicXml } from "./musicxml";
export { toPuText, keyNameOf } from "./topu";
export type { OcrBackend } from "./ocr";
export { nullOcr } from "./ocr";
export { decodeToBinary } from "./decode";
export { paddleOcrBackend } from "./paddleocr";
export { recognizeMusicpp, recognizeMusicppDetailed } from "./recognize";
export type { MusicppDetail } from "./recognize";
export { buildStrip, srcCanvasOf } from "./lyrics";
export { renderRecognitionSvg, renderRowPopup, renderHeaderPopup } from "./overlay";
export type { RecogView } from "./overlay";
