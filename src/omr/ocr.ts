// OCR 子模块（可插拔）：把数字 bbox 识别成 0-7。
// 识别策略仿 jianpu.cpp::asLine —— 把多个数字裁剪拼成一张横条图一次性 OCR，提速。
// 具体后端见 ./montage.ts（拼图）+ ./agy.ts（经 Antigravity CLI 让 Gemini 读图）。
import type { Binary, Rect } from "./types";

export interface OcrBackend {
  /** 对 bin 上的一组 bbox 识别数字，返回与 rects 等长的数字数组（0-7）。 */
  recognizeDigits(bin: Binary, rects: Rect[]): Promise<number[]>;
  /** 可选：识别一组文本画布（用于中文歌词）。返回与输入等长的字符串数组。
   *  仅支持中文的后端（PaddleOCR）实现此方法；不实现 → 管线跳过歌词识别。 */
  recognizeTexts?(canvases: OffscreenCanvas[]): Promise<string[]>;
  /** 可选：对每个 bbox 返回数字候选 0-7 的置信度降序排列（首位即 recognizeDigits 的次优来源）。
   *  用于上层据上下文（如有歌词的音符不可能是休止 0）剔除误判、取次优候选。 */
  rankDigits?(bin: Binary, rects: Rect[]): Promise<number[][]>;
}

/** 占位后端：无 OCR 时返回 0（用于先打通管线/结构调试）。 */
export const nullOcr: OcrBackend = {
  async recognizeDigits(_bin, rects) { return rects.map(() => 0); },
};
