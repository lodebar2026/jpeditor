// Antigravity CLI (`agy`) 桥：经 Tauri 自定义命令 `omr_gemini_cmd` 驱动 Gemini 看整页简谱图
// 直接转写成 MusicXML（Gemini 方案）。agy 是命令行工具，只能在桌面版(Tauri)经 Rust shell
// 调用；浏览器内不可用。musicpp 方案的数字 OCR 走本地 tesseract.js（见 ./localocr.ts），
// 不经 agy——因为整页识别本就是 Gemini 方案在做的事，没必要再让 agy 逐格读数字。
import { isTauriRuntime } from "../editor/fileio";

export const DEFAULT_GEMINI_MODEL = "Gemini 3.1 Pro (High)";

/** agy 是否可用（仅桌面版）。 */
export function agyAvailable(): boolean {
  return isTauriRuntime();
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** 整页简谱图（磁盘路径）→ MusicXML（Gemini 方案）。 */
export async function agyRecognizeImage(imagePath: string, model = DEFAULT_GEMINI_MODEL): Promise<string> {
  if (!agyAvailable()) throw new Error("Gemini 识别需要桌面版（Antigravity CLI / agy）");
  return invoke<string>("omr_gemini_cmd", { imagePath, model });
}
