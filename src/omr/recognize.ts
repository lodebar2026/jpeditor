// 简谱 OMR 顶层编排：图片 → MusicXML。两种方式：
//   "musicpp" —— 本地 TS 移植管线（连通域/几何启发式 + 本地 tesseract.js 数字 OCR）。
//                完全本地，浏览器/桌面均可，无需 agy / 网络服务。
//   "gemini"  —— 整页交 agy 让 Gemini 直接转写（对真实照片更准；仅桌面版）。
// 二者统一产出 MusicXML，交编辑器现有 loadMusicXml 导入排版。
import { decodeToBinary } from "./decode";
import { recognizeJianpu } from "./jianpu";
import { toMusicXml } from "./musicxml";
import { localOcrBackend } from "./localocr";
import { agyRecognizeImage, agyAvailable, DEFAULT_GEMINI_MODEL } from "./agy";

export type OmrMethod = "musicpp" | "gemini";

export interface OmrResult {
  musicxml: string;
  method: OmrMethod;
  ms: number;
}

/** musicpp 本地管线：图片字节 → MusicXML。完全本地（tesseract.js）。 */
export async function recognizeMusicpp(bytes: Uint8Array, mime?: string): Promise<string> {
  const bin = await decodeToBinary(bytes, mime);
  const score = await recognizeJianpu(bin, localOcrBackend());
  return toMusicXml(score);
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
