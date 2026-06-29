// 简谱 OMR（移植自 ~/proj/musicpp/omr/jianpu.cpp 的 recognition_jp 管线）。
// 不依赖 OpenCV/Tesseract 原生库：像素运算用纯 TS，OCR 子模块可插拔（tesseract.js / Gemini）。

/** 二值图：1=前景(黑/有墨)，0=背景。row-major，w*h。 */
export interface Binary {
  w: number;
  h: number;
  data: Uint8Array; // 长度 w*h，值 0/1
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rright = (r: Rect) => r.x + r.w;
export const rbottom = (r: Rect) => r.y + r.h;
export const rcx = (r: Rect) => r.x + r.w / 2;
export const rcy = (r: Rect) => r.y + r.h / 2;

/** 连通域：包围盒 + 像素数 + 质心。 */
export interface Component {
  id: number;
  bbox: Rect;
  area: number; // 前景像素数
  cx: number;
  cy: number;
}

/** jianpu.cpp: struct jpnum —— 一个简谱音符（数字 + 修饰）。 */
export interface JpNum {
  digit: number; // 0-7（0=休止）
  bbox: Rect;
  dot: number; // 附点数（右侧点）
  octave: number; // 八度偏移（上点+，下点-）
  div: number; // 下划线条数（每条时值减半）
  augment: number; // 增时线 '-' 数（延长拍）
  lyrics?: string[]; // 歌词：按声部(verse)索引，lyrics[0]=第一段(W1)、lyrics[1]=第二段……
}

/** 一行（一个 staff 行）识别出的内容。 */
export interface StaffRow {
  topY: number;
  bottomY: number;
  nums: JpNum[]; // 按 x 排序
  barlineXs: number[]; // 小节线 x 位置
}

export interface RecognizedScore {
  key: string; // 如 "C"
  fifths: number;
  beats: number;
  beatType: number;
  rows: StaffRow[];
  title?: string;
  credits?: string[]; // 著作者整行文本（作词/作曲…），→ MusicXML <credit>
}
