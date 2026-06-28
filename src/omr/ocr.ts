// OCR 子模块（可插拔）：把数字 bbox 识别成 0-7。
// 识别策略仿 jianpu.cpp::asLine —— 把多个数字裁剪拼成一张横条图一次性 OCR，提速。
// 具体后端见 ./montage.ts（拼图）+ ./agy.ts（经 Antigravity CLI 让 Gemini 读图）。
import type { Binary, Rect } from "./types";

export interface OcrBackend {
  /** 对 bin 上的一组 bbox 识别数字，返回与 rects 等长的数字数组（0-7）。 */
  recognizeDigits(bin: Binary, rects: Rect[]): Promise<number[]>;
}

/** 占位后端：无 OCR 时返回 0（用于先打通管线/结构调试）。 */
export const nullOcr: OcrBackend = {
  async recognizeDigits(_bin, rects) { return rects.map(() => 0); },
};
