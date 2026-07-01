// 简谱 OMR 顶层编排：图片 → MusicXML。两种方式：
//   "musicpp" —— 本地 TS 移植管线（连通域/几何启发式 + 本地 PaddleOCR(PP-OCRv4/onnx) 数字 OCR）。
//                完全本地，浏览器/桌面均可，无需 agy / 网络服务。
//   "gemini"  —— 整页交 agy 让 Gemini 直接转写（对真实照片更准；仅桌面版）。
// 二者统一产出 MusicXML，交编辑器现有 loadMusicXml 导入排版。
import { decodeToBinary } from "./decode";
import { recognizeJianpu } from "./jianpu";
import { toMusicXml } from "./musicxml";
import { paddleOcrBackend, omrProfile, omrProfileReset } from "./paddleocr";
import { agyRecognizeImage, agyAvailable, DEFAULT_GEMINI_MODEL } from "./agy";
import type { Binary, RecognizedScore } from "./types";

export type OmrMethod = "musicpp" | "gemini";

export interface OmrResult {
  musicxml: string;
  method: OmrMethod;
  ms: number;
}

/** musicpp 本地管线的详尽产物：MusicXML + 二值图 + 带源图坐标的识别结果（供识别模式叠加）。 */
export interface MusicppDetail {
  musicxml: string;
  bin: Binary;
  score: RecognizedScore;
}

/** musicpp 本地管线：图片字节 → 二值图 + RecognizedScore + MusicXML。完全本地（PaddleOCR PP-OCRv4）。 */
export async function recognizeMusicppDetailed(bytes: Uint8Array, mime?: string): Promise<MusicppDetail> {
  const _t0 = performance.now();
  const bin = await decodeToBinary(bytes, mime);
  const _tDecode = performance.now();
  omrProfileReset();
  const score = await recognizeJianpu(bin, paddleOcrBackend());
  // 分阶段计时诊断：设 globalThis.__omrDebug=true 打印（decode / infer(IPC+推理) / CTC / 预处理+几何）。
  if ((globalThis as { __omrDebug?: boolean }).__omrDebug) {
    const p = omrProfile();
    const total = performance.now() - _t0, decode = _tDecode - _t0, recog = performance.now() - _tDecode;
    // eslint-disable-next-line no-console
    console.log(`[OMR profile] 总 ${total.toFixed(0)}ms = decode ${decode.toFixed(0)} + recognize ${recog.toFixed(0)}`
      + `  ｜ infer ${p.infer.toFixed(0)}ms(${p.calls}次) · CTC ${p.ctc.toFixed(0)}ms · 预处理+几何 ${(recog - p.infer - p.ctc).toFixed(0)}ms`);
  }
  return { musicxml: toMusicXml(score), bin, score };
}

/** musicpp 本地管线：图片字节 → MusicXML。完全本地（PaddleOCR PP-OCRv4 / onnxruntime-web）。 */
export async function recognizeMusicpp(bytes: Uint8Array, mime?: string): Promise<string> {
  return (await recognizeMusicppDetailed(bytes, mime)).musicxml;
}

/** 统一入口。gemini 方式需图片磁盘路径（agy 直接读盘，仅桌面）；musicpp 用字节即可。 */
export async function recognizeImage(
  method: OmrMethod,
  input: { bytes: Uint8Array; mime?: string; path?: string | null },
  model = DEFAULT_GEMINI_MODEL,
): Promise<OmrResult> {
  const t0 = performance.now();
  let musicxml: string;
  if (method === "gemini") {
    if (!agyAvailable()) throw new Error("Gemini 识别需要桌面版（Antigravity CLI / agy）");
    if (!input.path) throw new Error("Gemini 方式需要图片文件路径");
    musicxml = await agyRecognizeImage(input.path, model);
  } else {
    musicxml = await recognizeMusicpp(input.bytes, input.mime);
  }
  return { musicxml, method, ms: performance.now() - t0 };
}
