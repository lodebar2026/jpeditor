// src/omr 公共入口：简谱图像识别（OMR）。
export * from "./types";
export { binarize, rgbaToBinary, toGray, otsuThreshold } from "./preprocess";
export { connectedComponents } from "./ccl";
export { recognizeJianpu } from "./jianpu";
export { toMusicXml } from "./musicxml";
export type { OcrBackend } from "./ocr";
export { nullOcr } from "./ocr";
export { decodeToBinary } from "./decode";
export { buildMontage } from "./montage";
export { localOcrBackend } from "./localocr";
export { paddleOcrBackend } from "./paddleocr";
export { agyAvailable, agyRecognizeImage, DEFAULT_GEMINI_MODEL } from "./agy";
export { recognizeImage, recognizeMusicpp, recognizeMusicppDetailed } from "./recognize";
export type { OmrMethod, OmrResult, MusicppDetail } from "./recognize";
export { renderRecognitionSvg, renderRowPopup, renderHeaderPopup } from "./overlay";
export type { RecogView } from "./overlay";
