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
  /** 可选：识别一组文本画布，**每字带其在该画布内容宽度上的水平位置** xFrac∈[0,1]（取 CTC 峰值时间步）。
   *  歌词↔音符对齐用：据此把识别字落回源图 x，免去"字数↔连通块格数"按序硬配（错位根源）。 */
  recognizeTextsPos?(canvases: OffscreenCanvas[]): Promise<{ ch: string; xFrac: number }[][]>;
  /** 可选：对每个 bbox 返回数字候选 0-7 的置信度降序排列（首位即 recognizeDigits 的次优来源）。
   *  用于上层据上下文（如有歌词的音符不可能是休止 0）剔除误判、取次优候选。 */
  rankDigits?(bin: Binary, rects: Rect[]): Promise<number[][]>;
  /** 可选：用文本检测(DBNet)在 region 内自动找文本行 + 逐行识别，返回 {文本, 框}（原图坐标，阅读序）。
   *  仅 PaddleOCR(含 det 模型)实现。页眉(标题/著作者)整片识别用，免去靠连通域几何切行的脆弱启发式。 */
  recognizeRegion?(bin: Binary, region: Rect): Promise<{ text: string; bbox: Rect; chars?: { text: string; cx: number; x1?: number }[] }[]>;
}

/** 占位后端：无 OCR 时返回 0（用于先打通管线/结构调试）。 */
export const nullOcr: OcrBackend = {
  async recognizeDigits(_bin, rects) { return rects.map(() => 0); },
};
