// musicpp 方案的**本地**数字 OCR：PaddleOCR PP-OCRv4 识别模型（ONNX，经 onnxruntime-web 在
// 浏览器/桌面离线推理）。替代 tesseract.js —— 实测对真实扫描简谱数字 0-7 准确率 100%
// （tesseract 约 69%，常把 6 误读为 0）。模型与字典见 public/redist/ocr/，
// wasm 运行时见 public/redist/ort/（单线程，无需 COOP/COEP 跨源隔离）。
//
// 识别单元：每个数字裁成 64×64 居中白底黑字格（与回归基准一致），逐格 rec → CTC 解码 → 取 0-7。
import type { OcrBackend } from "./ocr";
import type { Binary, Rect } from "./types";
import { rright, rbottom } from "./types";

const BASE = import.meta.env.BASE_URL; // "/" 或 "/jpeditor-web/"
const REC_URL = `${BASE}redist/ocr/ch_PP-OCRv4_rec_infer.onnx`;
const DICT_URL = `${BASE}redist/ocr/ppocr_keys_v1.txt`;
const DET_URL = `${BASE}redist/ocr/ch_PP-OCRv4_det_infer.onnx`;

const REC_H = 48, REC_MAXW = 320;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ort: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _session: any = null;
let _chars: string[] | null = null;
let _initPromise: Promise<void> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _detSession: any = null;
let _detInitPromise: Promise<void> | null = null;

async function ensureSession(): Promise<void> {
  if (_session) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    // 纯 wasm 构建（非 jsep/webgpu）：CPU 单线程足够，且只需 ort-wasm-simd-threaded.wasm，
    // 省去 26MB 的 jsep wasm。
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.wasmPaths = `${BASE}redist/ort/`;
    ort.env.wasm.numThreads = 1; // 单线程：免 SharedArrayBuffer / 跨源隔离要求
    _ort = ort;
    _session = await ort.InferenceSession.create(REC_URL, { executionProviders: ["wasm"] });
    const dictText = await (await fetch(DICT_URL)).text();
    const keys = dictText.split("\n").filter((l) => l.length);
    // PaddleOCR CTC 字符表：index0=blank，随后字典，末尾可能补 space。
    _chars = ["", ...keys];
  })();
  return _initPromise;
}

/** 懒加载 PP-OCRv4 检测(DBNet)模型，仅在用到整片页眉 det+rec 时拉起。复用 rec 的 ort 运行时。 */
async function ensureDetSession(): Promise<void> {
  if (_detSession) return;
  if (_detInitPromise) return _detInitPromise;
  _detInitPromise = (async () => {
    await ensureSession(); // 复用 ort 初始化（wasmPaths/numThreads）
    _detSession = await _ort.InferenceSession.create(DET_URL, { executionProviders: ["wasm"] });
  })();
  return _detInitPromise;
}

/** DBNet 文本检测：在源画布的 region 子图内找文本行框，返回**原图坐标**的 Rect[]（已 unclip 外扩、
 *  按阅读序排好）。det 在干净二值图上同样有效（高对比）。仅供页眉(标题/著作者)整片识别用。 */
async function detectRegion(src: OffscreenCanvas, region: Rect): Promise<Rect[]> {
  await ensureDetSession();
  const rx = Math.max(0, Math.round(region.x)), ry = Math.max(0, Math.round(region.y));
  const rw = Math.min(src.width - rx, Math.round(region.w)), rh = Math.min(src.height - ry, Math.round(region.h));
  if (rw < 8 || rh < 8) return [];

  // 等比缩放到边长上限、且宽高对齐到 32 的倍数（DBNet 要求）。
  const LIMIT = 960;
  let scale = Math.min(1, LIMIT / Math.max(rw, rh));
  const round32 = (n: number) => Math.max(32, Math.round(n * scale / 32) * 32);
  const W = round32(rw), H = round32(rh);
  const sxScale = W / rw, syScale = H / rh; // 原图→det 输入 的实际缩放（各维独立）

  const tmp = new OffscreenCanvas(W, H);
  const tctx = tmp.getContext("2d");
  if (!tctx) throw new Error("无法创建 2D 画布上下文");
  tctx.drawImage(src, rx, ry, rw, rh, 0, 0, W, H);
  const px = tctx.getImageData(0, 0, W, H).data;

  // 归一化（ImageNet mean/std, RGB, CHW）。
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const chw = new Float32Array(3 * H * W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) chw[c * H * W + y * W + x] = (px[p + c] / 255 - mean[c]) / std[c];
  }
  const tensor = new _ort.Tensor("float32", chw, [1, 3, H, W]);
  const feeds: Record<string, unknown> = {};
  feeds[_detSession.inputNames[0]] = tensor;
  const out = await _detSession.run(feeds);
  const prob = out[_detSession.outputNames[0]].data as Float32Array; // [1,1,H,W]

  // 阈值二值化 → 连通域（4-邻接 BFS）→ 行框；按 DBNet 习惯外扩(unclip)。
  const THRESH = 0.3, BOX_THRESH = 0.5;
  const bm = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bm[i] = prob[i] > THRESH ? 1 : 0;
  const seen = new Uint8Array(W * H);
  const boxes: Rect[] = [];
  const stack: number[] = [];
  for (let i0 = 0; i0 < W * H; i0++) {
    if (!bm[i0] || seen[i0]) continue;
    stack.length = 0; stack.push(i0); seen[i0] = 1;
    let minX = W, minY = H, maxX = 0, maxY = 0, n = 0, probSum = 0;
    while (stack.length) {
      const idx = stack.pop()!; const x = idx % W, y = (idx / W) | 0;
      n++; probSum += prob[idx];
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && bm[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack.push(idx - 1); }
      if (x < W - 1 && bm[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack.push(idx + 1); }
      if (y > 0 && bm[idx - W] && !seen[idx - W]) { seen[idx - W] = 1; stack.push(idx - W); }
      if (y < H - 1 && bm[idx + W] && !seen[idx + W]) { seen[idx + W] = 1; stack.push(idx + W); }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw < 4 || bh < 4 || probSum / n < BOX_THRESH) continue;
    // unclip：按 dist = area*ratio/perimeter 外扩（DBNet 收缩了文字框，需还原）。
    const ratio = 1.6, dist = (bw * bh * ratio) / (2 * (bw + bh));
    const ex0 = minX - dist, ey0 = minY - dist, ex1 = maxX + dist, ey1 = maxY + dist;
    boxes.push({
      x: rx + ex0 / sxScale, y: ry + ey0 / syScale,
      w: (ex1 - ex0) / sxScale, h: (ey1 - ey0) / syScale,
    });
  }
  // 阅读序：先按行(y 接近归一行)、再按 x。
  const medH = boxes.length ? [...boxes.map((b) => b.h)].sort((a, b) => a - b)[boxes.length >> 1] : 0;
  boxes.sort((a, b) => (Math.abs(a.y - b.y) > medH * 0.6 ? a.y - b.y : a.x - b.x));
  return boxes;
}

/** 整幅二值图 → 黑字白底源画布（一次性，供逐格裁剪）。 */
function binToCanvas(bin: Binary): OffscreenCanvas {
  const cv = new OffscreenCanvas(bin.w, bin.h);
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  const img = new ImageData(bin.w, bin.h);
  for (let i = 0; i < bin.data.length; i++) {
    const v = bin.data[i] ? 0 : 255; // 前景(1)→黑，背景→白
    const p = i * 4;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** 把一个 rect 裁成 cell×cell 居中白底黑字格（等比缩放到 inner）。 */
function cellOf(src: OffscreenCanvas, bin: Binary, r: Rect, cell = 64, pad = 8): OffscreenCanvas {
  const inner = cell - pad * 2;
  const cv = new OffscreenCanvas(cell, cell);
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cell, cell);
  const sx = Math.max(0, r.x), sy = Math.max(0, r.y);
  const sw = Math.min(bin.w, rright(r)) - sx, sh = Math.min(bin.h, rbottom(r)) - sy;
  if (sw > 0 && sh > 0) {
    const scale = Math.min(inner / sw, inner / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(src, sx, sy, sw, sh, (cell - dw) / 2, (cell - dh) / 2, dw, dh);
  }
  return cv;
}

/** 对一个文本行/字符画布跑 PP-OCRv4 rec → 原始 logits [T,C]。
 *  maxW：宽度上限（rec 全卷积，宽度可变）。逐数字格/歌词块用默认 320；整行 det 框可能很长(英文著作者)，
 *  用更大上限避免被压扁成乱码。 */
async function inferLogits(cell: OffscreenCanvas, maxW = REC_MAXW): Promise<{ arr: Float32Array; T: number; C: number }> {
  // 等比缩放到高 REC_H、宽 ≤ maxW，零填充。
  const ratio = cell.width / cell.height;
  let w = Math.ceil(REC_H * ratio);
  if (w > maxW) w = maxW;
  if (w < 1) w = 1;
  // 张量宽：默认上限(320)以内时仍按 320 零填充(保持逐格 rec 既有行为/精度)；放宽上限的长行按实际宽。
  const tensorW = maxW <= REC_MAXW ? REC_MAXW : w;
  const tmp = new OffscreenCanvas(w, REC_H);
  const tctx = tmp.getContext("2d");
  if (!tctx) throw new Error("无法创建 2D 画布上下文");
  tctx.drawImage(cell, 0, 0, w, REC_H);
  const px = tctx.getImageData(0, 0, w, REC_H).data;

  const chw = new Float32Array(3 * REC_H * tensorW); // 零填充：padding 区归一化值=0
  for (let y = 0; y < REC_H; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = px[p + c] / 255;
        chw[c * REC_H * tensorW + y * tensorW + x] = (v - 0.5) / 0.5;
      }
    }
  }
  const tensor = new _ort.Tensor("float32", chw, [1, 3, REC_H, tensorW]);
  const feeds: Record<string, unknown> = {};
  feeds[_session.inputNames[0]] = tensor;
  const out = await _session.run(feeds);
  const o = out[_session.outputNames[0]];
  const [, T, C] = o.dims as number[];
  return { arr: o.data as Float32Array, T, C };
}

/** CTC 贪心解码 → 字符串。maxW 见 inferLogits。 */
async function recognizeCanvas(cell: OffscreenCanvas, maxW = REC_MAXW): Promise<string> {
  const { arr, T, C } = await inferLogits(cell, maxW);
  const chars = _chars!;
  let prev = -1, s = "";
  for (let t = 0; t < T; t++) {
    let best = 0, bv = -Infinity;
    for (let c = 0; c < C; c++) { const v = arr[t * C + c]; if (v > bv) { bv = v; best = c; } }
    if (best !== 0 && best !== prev) s += chars[best] ?? "";
    prev = best;
  }
  return s;
}

// 字符表里数字 '0'..'7' 的类别索引（首次用时据 _chars 求出）。
let _digitIdx: number[] | null = null;
function digitClassIdx(): number[] {
  if (_digitIdx) return _digitIdx;
  const chars = _chars!;
  _digitIdx = Array.from({ length: 8 }, (_, d) => chars.indexOf(String(d)));
  return _digitIdx;
}

/** 单数字格 → 候选数字按置信度降序（取各数字类在所有时间步上的最大 logit 排序）。
 * 用于退化字形（贪心解码出空/非数字、默认成 0=休止）时，由上层据上下文（如歌词）剔除 0 取次优。 */
async function rankDigitCandidates(cell: OffscreenCanvas): Promise<number[]> {
  const { arr, T, C } = await inferLogits(cell);
  const idx = digitClassIdx();
  const scored = idx.map((ci, d) => {
    let mx = -Infinity;
    if (ci >= 0) for (let t = 0; t < T; t++) { const v = arr[t * C + ci]; if (v > mx) mx = v; }
    return { d, mx };
  });
  scored.sort((a, b) => b.mx - a.mx);
  return scored.map((s) => s.d);
}

export function paddleOcrBackend(): OcrBackend {
  const backend = {
    async recognizeDigits(bin: Binary, rects: Rect[]): Promise<number[]> {
      if (!rects.length) return [];
      await ensureSession();
      const src = binToCanvas(bin);
      const out: number[] = [];
      for (const r of rects) {
        const cell = cellOf(src, bin, r);
        const text = await recognizeCanvas(cell);
        const m = text.match(/[0-7]/);
        out.push(m ? Number(m[0]) : 0);
      }
      return out;
    },
    async rankDigits(bin: Binary, rects: Rect[]): Promise<number[][]> {
      if (!rects.length) return [];
      await ensureSession();
      const src = binToCanvas(bin);
      const out: number[][] = [];
      for (const r of rects) out.push(await rankDigitCandidates(cellOf(src, bin, r)));
      return out;
    },
    async recognizeTexts(canvases: OffscreenCanvas[]): Promise<string[]> {
      if (!canvases.length) return [];
      await ensureSession();
      const out: string[] = [];
      for (const cv of canvases) out.push(await recognizeCanvas(cv));
      return out;
    },
    async recognizeRegion(bin: Binary, region: Rect): Promise<{ text: string; bbox: Rect }[]> {
      await ensureSession();
      const src = binToCanvas(bin);
      const boxes = await detectRegion(src, region);
      const out: { text: string; bbox: Rect }[] = [];
      for (const b of boxes) {
        const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y));
        const w = Math.min(bin.w - x, Math.round(b.w)), h = Math.min(bin.h - y, Math.round(b.h));
        if (w < 4 || h < 4) continue;
        const cv = new OffscreenCanvas(w, h);
        const cx = cv.getContext("2d");
        if (!cx) continue;
        cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h);
        cx.drawImage(src, x, y, w, h, 0, 0, w, h);
        const text = await recognizeCanvas(cv, 2048); // 整行可能很长(英文著作者)，放宽 rec 宽上限免压扁
        if (text.trim()) out.push({ text, bbox: { x, y, w, h } });
      }
      return out;
    },
  };
  return backend;
}
