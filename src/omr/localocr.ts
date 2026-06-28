// musicpp 方案的**本地**数字 OCR：tesseract.js（不依赖 agy/网络服务，浏览器/桌面均可离线跑）。
// 把数字按网格拼成 montage，再逐格(PSM 单字)识别 0-7，按读取顺序回填。
import type { OcrBackend } from "./ocr";
import type { Binary, Rect } from "./types";
import { buildMontage } from "./montage";

export function localOcrBackend(): OcrBackend {
  return {
    async recognizeDigits(bin: Binary, rects: Rect[]): Promise<number[]> {
      if (!rects.length) return [];
      const m = await buildMontage(bin, rects, 16, 64, 10);
      if (!m) return rects.map(() => 0);
      const { createWorker, PSM } = await import("tesseract.js");
      const blob = new Blob([m.png as BlobPart], { type: "image/png" });
      const worker = await createWorker("eng");
      await worker.setParameters({
        tessedit_char_whitelist: "01234567",
        tessedit_pageseg_mode: PSM.SINGLE_CHAR,
      });
      const sep = 2;
      const out: number[] = [];
      try {
        for (let i = 0; i < m.count; i++) {
          const col = i % m.cols, row = (i / m.cols) | 0;
          const left = col * (m.cell + sep), top = row * (m.cell + sep);
          const { data } = await worker.recognize(blob, {
            rectangle: { left, top, width: m.cell, height: m.cell },
          });
          const d = data.text.match(/[0-7]/);
          out.push(d ? Number(d[0]) : 0);
        }
      } finally {
        await worker.terminate();
      }
      return out;
    },
  };
}
