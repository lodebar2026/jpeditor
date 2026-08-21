// 简谱 OMR 顶层编排：图片 → MusicXML。
// 本地 TS 移植管线（连通域/几何启发式 + 本地 PaddleOCR(PP-OCRv6_small/onnx) 数字与歌词 OCR），
// 完全在浏览器/桌面本地运行、可离线，无需网络服务。产出 MusicXML，交编辑器现有 loadMusicXml 导入排版。
import { decodeToBinary } from "./decode";
import { recognizeJianpu } from "./jianpu";
import { toMusicXml } from "./musicxml";
import { paddleOcrBackend, omrProfile, omrProfileReset } from "./paddleocr";
import type { Binary, RecognizedScore } from "./types";

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
