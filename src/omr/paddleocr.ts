// musicpp 方案的**本地**数字 OCR：PaddleOCR PP-OCRv4 识别模型（ONNX，经 onnxruntime-web 在
// 浏览器/桌面离线推理）。替代 tesseract.js —— 实测对真实扫描简谱数字 0-7 准确率 100%
// （tesseract 约 69%，常把 6 误读为 0）。模型与字典见 public/redist/ocr/，
// wasm 运行时经 onnxruntime-web 包用 Vite `?url` 引入（见下，单线程，无需 COOP/COEP 跨源隔离）。
//
// 识别单元：每个数字裁成 64×64 居中白底黑字格（与回归基准一致），逐格 rec → CTC 解码 → 取 0-7。
import type { OcrBackend } from "./ocr";
import type { Binary, Rect } from "./types";
import { rright, rbottom } from "./types";
// ort 运行时（纯 wasm，单线程，免 jsep 26MB）经 Vite `?url` 引入：dev/build 都由 Vite 解析为
// 合法资源 URL。**不能**把这两个文件放 /public 再用 wasmPaths 字符串——onnxruntime-web 会对
// 其中的 .mjs 做动态 import()，而 Vite dev 拒绝把 /public 文件当模块加载。
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";

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
let _ready = false; // 字典(+ 浏览器下 ort session)就绪

type OnnxOut = { data: Float32Array; dims: number[] };

// 分阶段计时（临时 profiling）：infer=IPC+推理，ctc=CTC 解码，其余在 backend 内即预处理(canvas+归一化)。
const _prof = { infer: 0, ctc: 0, calls: 0 };
export function omrProfile(): { infer: number; ctc: number; calls: number } { return { ..._prof }; }
export function omrProfileReset(): void { _prof.infer = 0; _prof.ctc = 0; _prof.calls = 0; }

// ── 原生 OCR（Tauri 桌面）：把张量交给 Rust ort 跑 session.run，比浏览器 wasm 多线程快 ~3×，
//    且完全绕开 WebKit(WKWebView) 多线程 wasm worker 冷启动挂死的问题（桌面不再依赖浏览器推理）。──
function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}
/** 桌面默认走原生；globalThis.__omrNative=false 可强制回退浏览器 wasm（调试/对比用）。 */
function nativeOcr(): boolean {
  const ov = (globalThis as { __omrNative?: boolean }).__omrNative;
  return typeof ov === "boolean" ? ov : isTauri();
}

type ArgmaxOut = { idx: Int32Array; N: number; T: number };

/** 底层：Tauri 原始字节 IPC。withGlobalTauri=true → window.__TAURI__.core.invoke 全局可用。 */
async function tauriInvokeRaw(cmd: string, req: ArrayBuffer): Promise<ArrayBuffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoke = (window as any).__TAURI__?.core?.invoke as
    | ((cmd: string, args?: unknown) => Promise<ArrayBuffer>)
    | undefined;
  if (!invoke) throw new Error("Tauri invoke 不可用");
  const raw = await invoke(cmd, req);
  // invoke 对返回 ipc::Response 一般给 ArrayBuffer；防御性兼容 TypedArray 视图。
  return raw instanceof ArrayBuffer
    ? raw
    : (raw as ArrayBufferView).buffer.slice(
        (raw as ArrayBufferView).byteOffset,
        (raw as ArrayBufferView).byteOffset + (raw as ArrayBufferView).byteLength,
      );
}

/** 单张量 omr_onnx：请求 int32[model,mode,ndims,dims...]+f32[data]。 */
async function nativeInvoke(model: number, mode: number, chw: Float32Array, dims: number[]): Promise<ArrayBuffer> {
  const nInts = 3 + dims.length;
  const req = new ArrayBuffer(nInts * 4 + chw.byteLength);
  const iv = new Int32Array(req, 0, nInts);
  iv[0] = model; iv[1] = mode; iv[2] = dims.length;
  for (let i = 0; i < dims.length; i++) iv[3 + i] = dims[i];
  new Float32Array(req, nInts * 4).set(chw); // nInts*4 恒为 4 的倍数 → 对齐合法
  return tauriInvokeRaw("omr_onnx", req);
}

/** 完整 f32 输出（mode=0）：原生走 Rust，浏览器走 ort-web。用于需原始 logits/概率图的路径
 *  （rankDigits 取各类最大分、det 取概率图做连通域）。 */
async function nativeRun(model: number, chw: Float32Array, dims: number[]): Promise<OnnxOut> {
  const resp = await nativeInvoke(model, 0, chw, dims);
  const nd = new Int32Array(resp, 0, 1)[0];
  const outDims = Array.from(new Int32Array(resp, 4, nd));
  const data = new Float32Array(resp, (1 + nd) * 4); // (1+nd)*4 对齐合法
  return { data, dims: outDims };
}
async function runRec(chw: Float32Array, dims: number[]): Promise<OnnxOut> {
  if (nativeOcr()) return nativeRun(0, chw, dims);
  const tensor = new _ort.Tensor("float32", chw, dims);
  const feeds: Record<string, unknown> = {}; feeds[_session.inputNames[0]] = tensor;
  const o = (await _session.run(feeds))[_session.outputNames[0]];
  return { data: o.data as Float32Array, dims: o.dims as number[] };
}
async function runDet(chw: Float32Array, dims: number[]): Promise<OnnxOut> {
  if (nativeOcr()) return nativeRun(1, chw, dims);
  const tensor = new _ort.Tensor("float32", chw, dims);
  const feeds: Record<string, unknown> = {}; feeds[_detSession.inputNames[0]] = tensor;
  const o = (await _detSession.run(feeds))[_detSession.outputNames[0]];
  return { data: o.data as Float32Array, dims: o.dims as number[] };
}

/** wasm 单张量 rec → 每时间步 argmax [N,T]（TS 内做 argmax，成本同原先 CTC 内层）。 */
async function wasmRecArgmax(chw: Float32Array, dims: number[]): Promise<ArgmaxOut> {
  const tensor = new _ort.Tensor("float32", chw, dims);
  const feeds: Record<string, unknown> = {}; feeds[_session.inputNames[0]] = tensor;
  const o = (await _session.run(feeds))[_session.outputNames[0]];
  const [N, T, C] = o.dims as number[];
  const arr = o.data as Float32Array;
  const idx = new Int32Array(N * T);
  for (let i = 0; i < N * T; i++) {
    const base = i * C; let best = 0, bv = -Infinity;
    for (let c = 0; c < C; c++) { const v = arr[base + c]; if (v > bv) { bv = v; best = c; } }
    idx[i] = best;
  }
  return { idx, N, T };
}

/** **一次 IPC 跑多个 rec 输入**，各自返回 argmax [N,T]。原生：单次 omr_onnx_batch 携带全部张量，
 *  Rust 内部逐个 session.run（逐个=算力最优）→ 把 Tauri 每次往返(~数 ms)从 N 次压到 1 次；
 *  wasm：本地逐个（无 IPC 成本）。这是原生下的关键优化（IPC 往返开销 >> 批量算力差异）。 */
async function runRecArgmaxMany(inputs: { chw: Float32Array; dims: number[] }[]): Promise<ArgmaxOut[]> {
  if (!inputs.length) return [];
  const _t = performance.now(); _prof.calls++;
  if (nativeOcr()) {
    // 请求：int32[count] + count×(int32[model=0,mode=1,ndims,dims...] + f32[data])
    let bytes = 4;
    for (const inp of inputs) bytes += (3 + inp.dims.length) * 4 + inp.chw.byteLength;
    const req = new ArrayBuffer(bytes);
    const dv = new DataView(req);
    const u8 = new Uint8Array(req);
    let off = 0;
    dv.setInt32(off, inputs.length, true); off += 4;
    for (const inp of inputs) {
      dv.setInt32(off, 0, true); off += 4;                    // model=rec
      dv.setInt32(off, 1, true); off += 4;                    // mode=argmax
      dv.setInt32(off, inp.dims.length, true); off += 4;
      for (const d of inp.dims) { dv.setInt32(off, d, true); off += 4; }
      u8.set(new Uint8Array(inp.chw.buffer, inp.chw.byteOffset, inp.chw.byteLength), off);
      off += inp.chw.byteLength; // 恒 4 的倍数
    }
    const resp = await tauriInvokeRaw("omr_onnx_batch", req);
    const rv = new DataView(resp);
    let ro = 0;
    const count = rv.getInt32(ro, true); ro += 4;
    const out: ArgmaxOut[] = [];
    for (let i = 0; i < count; i++) {
      const nd = rv.getInt32(ro, true); ro += 4;
      const N = rv.getInt32(ro, true), T = rv.getInt32(ro + 4, true); ro += nd * 4;
      const idx = new Int32Array(resp.slice(ro, ro + N * T * 4)); ro += N * T * 4;
      out.push({ idx, N, T });
    }
    _prof.infer += performance.now() - _t;
    return out;
  }
  const out: ArgmaxOut[] = [];
  for (const inp of inputs) out.push(await wasmRecArgmax(inp.chw, inp.dims));
  _prof.infer += performance.now() - _t;
  return out;
}

/** 是否 Chromium 系引擎（Chrome/Edge/Chromium/Windows WebView2）。
 *  仅这些引擎上 onnxruntime 的多线程 wasm worker 经验证稳定；WebKit（Tauri 在 macOS=WKWebView、
 *  Linux=WebKitGTK，及 Safari）的线程化 wasm worker 冷启动会挂死，且 ort 的 wasm 模块是全局单例，
 *  一旦卡住连单线程回退也救不回来 → 故 WebKit 上绝不尝试多线程。 */
function isChromiumEngine(): boolean {
  const uaData = (globalThis.navigator as { userAgentData?: { brands?: { brand: string }[] } } | undefined)?.userAgentData;
  if (uaData?.brands?.length) return uaData.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand));
  return /Chrome\/\d/.test((globalThis.navigator as { userAgent?: string } | undefined)?.userAgent ?? "");
}

/** 期望线程数：显式 __ortThreads 优先（高级覆盖，自负 WebKit 风险）；否则需同时满足
 *  跨源隔离(SharedArrayBuffer 可用) + Chromium 引擎才开多线程，取 min(4, 核数)，否则恒为 1。 */
function desiredThreads(): number {
  const ov = (globalThis as { __ortThreads?: number }).__ortThreads;
  if (typeof ov === "number") return Math.max(1, ov);
  if (!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) return 1;
  if (!isChromiumEngine()) return 1;
  const hw = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4;
  return Math.min(4, Math.max(1, hw));
}

/** Promise 超时包装：超时即 reject（底层操作无法取消，由调用方走回退）。 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} 超时 ${ms}ms`)), ms))]);
}

/** 单线程建 rec session（回退用，必定可用）。 */
async function createRecSingle(): Promise<unknown> {
  _ort.env.wasm.numThreads = 1;
  return _ort.InferenceSession.create(REC_URL, { executionProviders: ["wasm"] });
}

/** 按期望线程数建 rec session。多线程下额外做一次极小 warmup run 确认 worker 池真能响应
 *  （worker 冷启动在部分 webview/真实浏览器里会让 create 成功但首个 run 永久挂起）；
 *  create 或 warmup 任一超时/报错即回退单线程。保证绝不永久卡"识别中"。 */
async function createRecSession(): Promise<unknown> {
  const threads = desiredThreads();
  if (threads <= 1) { _ort.env.wasm.numThreads = 1; return _ort.InferenceSession.create(REC_URL, { executionProviders: ["wasm"] }); }
  try {
    _ort.env.wasm.numThreads = threads;
    const sess = await withTimeout(_ort.InferenceSession.create(REC_URL, { executionProviders: ["wasm"] }), 8000, "多线程 OCR create");
    // warmup：一张 1×3×48×48 全零张量，确认 worker 池能跑通 run。
    const warm = new _ort.Tensor("float32", new Float32Array(3 * REC_H * REC_H), [1, 3, REC_H, REC_H]);
    const feeds: Record<string, unknown> = {}; feeds[(sess as { inputNames: string[] }).inputNames[0]] = warm;
    await withTimeout((sess as { run: (f: unknown) => Promise<unknown> }).run(feeds), 8000, "多线程 OCR warmup");
    return sess;
  } catch (e) {
    console.warn("[OMR] 多线程 OCR 初始化失败/超时，回退单线程：", e);
    return createRecSingle();
  }
}

async function ensureSession(): Promise<void> {
  if (_ready) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    // 字典两端都要（CTC 解码在前端）。PaddleOCR CTC 字符表：index0=blank，随后字典，末尾可能补 space。
    const dictText = await (await fetch(DICT_URL)).text();
    _chars = ["", ...dictText.split("\n").filter((l) => l.length)];
    if (nativeOcr()) { _ready = true; return; } // 原生(Tauri)：推理在 Rust，无需加载 ort-web
    // 浏览器：纯 wasm 构建（非 jsep/webgpu），只需 ort-wasm-simd-threaded.wasm，省去 26MB jsep。
    const ort = await import("onnxruntime-web/wasm");
    // 用 Vite 解析出的资源 URL 映射，避免 dev 下对 /public 的 .mjs 动态 import 报错。
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
    _ort = ort;
    _session = await createRecSession(); // 多线程（带超时回退）/单线程
    _ready = true;
  })();
  return _initPromise;
}

/** 懒加载 PP-OCRv4 检测(DBNet)模型。原生下推理在 Rust，只需 ensureSession(字典)；浏览器下拉起 ort-web det session。 */
async function ensureDetSession(): Promise<void> {
  await ensureSession();
  if (nativeOcr() || _detSession) return;
  if (_detInitPromise) return _detInitPromise;
  _detInitPromise = (async () => {
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
  const prob = (await runDet(chw, [1, 3, H, W])).data; // [1,1,H,W]

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

/** 画布 → rec 输入张量（等比缩放到高 REC_H、宽 ≤ maxW、零填充到 tensorW）。返回 chw + dims + 内容宽 w。
 *  maxW≤320 时 tensorW=320（保持逐格既有行为/精度）；放宽上限的长行按实际宽。 */
function prepCell(cell: OffscreenCanvas, maxW = REC_MAXW): { chw: Float32Array; dims: number[]; w: number; tensorW: number } {
  let w = Math.ceil(REC_H * (cell.width / cell.height));
  if (w > maxW) w = maxW;
  if (w < 1) w = 1;
  const tensorW = maxW <= REC_MAXW ? REC_MAXW : w;
  const tmp = new OffscreenCanvas(w, REC_H);
  const tctx = tmp.getContext("2d");
  if (!tctx) throw new Error("无法创建 2D 画布上下文");
  tctx.drawImage(cell, 0, 0, w, REC_H);
  const px = tctx.getImageData(0, 0, w, REC_H).data;
  const chw = new Float32Array(3 * REC_H * tensorW); // 零填充：padding 区归一化值=0
  for (let y = 0; y < REC_H; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) chw[c * REC_H * tensorW + y * tensorW + x] = (px[p + c] / 255 - 0.5) / 0.5;
  }
  return { chw, dims: [1, 3, REC_H, tensorW], w, tensorW };
}

/** 对一个文本行/字符画布跑 rec → 原始 logits [T,C]（供 rankDigits 取各类最大分）。 */
async function inferLogits(cell: OffscreenCanvas, maxW = REC_MAXW): Promise<{ arr: Float32Array; T: number; C: number; w: number; tensorW: number }> {
  const { chw, dims, w, tensorW } = prepCell(cell, maxW);
  const o = await runRec(chw, dims);
  const [, T, C] = o.dims;
  return { arr: o.data, T, C, w, tensorW };
}

/** 批量 CTC 带位解码：多个画布 → 各自 [{ch,xFrac,x1Frac}]，**一次 IPC**。xFrac/x1Frac∈[0,1]：该字在
 *  输入内容宽度上的**左缘/右缘**（CTC 非空标签连续run 的起止时间步换算）。xFrac 沿用原「起点」语义
 *  (歌词按它对齐音符，勿动)；x1Frac 为新增右缘，供按**字符边界间隙**(右字左缘−左字右缘)判词间空格。
 *  用于歌词条 & 页眉框——把逐条 N 次 IPC 压到 1 次。 */
async function recognizeCharsPosMany(cells: OffscreenCanvas[], maxW = REC_MAXW): Promise<{ ch: string; xFrac: number; x1Frac: number }[][]> {
  if (!cells.length) return [];
  const preps = cells.map((c) => prepCell(c, maxW));
  const results = await runRecArgmaxMany(preps.map((p) => ({ chw: p.chw, dims: p.dims })));
  const chars = _chars!;
  const _t0 = performance.now();
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const out = preps.map((p, i) => {
    const { idx, T } = results[i];
    const res: { ch: string; xFrac: number; x1Frac: number }[] = [];
    // 逐字符 = 一段连续非空标签run（run 之间以 blank 或换标签分隔，同原 CTC 折叠语义、发射次数不变）。
    // 记录 run 的起止时间步 [i0,t) → 左缘/右缘 frac，比原来只取起点更能量出字符间真实空隙。
    let prev = -1, i0 = 0;
    for (let t = 0; t <= T; t++) {
      const best = t < T ? idx[t] : -1;
      if (best !== prev) {
        if (prev > 0) { // 上一段是非空字符 run，落在 [i0, t)
          const ch = chars[prev] ?? "";
          if (ch) res.push({ ch, xFrac: clamp((i0 * p.tensorW / T) / p.w), x1Frac: clamp((t * p.tensorW / T) / p.w) });
        }
        i0 = t; prev = best;
      }
    }
    return res;
  });
  _prof.ctc += performance.now() - _t0;
  return out;
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

// 批量数字 rec：数字格是近方形单字（cellOf 出 64×64），统一缩到 REC_H×DIGIT_W(48×48) 堆成
// 一个 [N,3,48,48] 张量分块推理。相比逐格 N 次 `session.run` 且每格零填充到 320 宽：
//   ① 宽 48≪320 → 单格计算量降 ~2.8x；② 批量摊薄每次 run 的固定开销 → 再 ~1.85x。
// 数字 OCR 实测从 ~6.2s 降到 ~1.2s。宽 48 足够（单字方形，CTC 时间步够分辨 0-7）。
const DIGIT_W = REC_H;       // 数字格宽（=48，近方形）
// 每批格数=64：窄张量(48宽)批量对原生 onnxruntime 算力无害(实测 64 批甚至略优于逐格)，又把数字
// IPC 次数压到 ~3。注意**歌词条(320宽)相反**——大 batch 会让算力暴跌(+200ms)，故歌词逐条不批。
const DIGIT_BATCH = 64;

/** 批量识别数字格 → 各格 CTC 解码字符串。数字格统一缩到 48×48，按 DIGIT_BATCH 分块成若干张量，
 *  **一次 IPC** 发全部块（Rust 内部逐块 session.run）。 */
async function recognizeDigitCells(cells: OffscreenCanvas[]): Promise<string[]> {
  await ensureSession();
  const chars = _chars!;
  const tmp = new OffscreenCanvas(DIGIT_W, REC_H);
  const tctx = tmp.getContext("2d");
  if (!tctx) throw new Error("无法创建 2D 画布上下文");
  const inputs: { chw: Float32Array; dims: number[] }[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < cells.length; i += DIGIT_BATCH) {
    const chunk = cells.slice(i, i + DIGIT_BATCH);
    const N = chunk.length;
    const chw = new Float32Array(N * 3 * REC_H * DIGIT_W); // 零填充：不足区归一化值=0
    for (let n = 0; n < N; n++) {
      tctx.clearRect(0, 0, DIGIT_W, REC_H);
      tctx.drawImage(chunk[n], 0, 0, DIGIT_W, REC_H);
      const px = tctx.getImageData(0, 0, DIGIT_W, REC_H).data;
      const base = n * 3 * REC_H * DIGIT_W;
      for (let y = 0; y < REC_H; y++) for (let x = 0; x < DIGIT_W; x++) {
        const p = (y * DIGIT_W + x) * 4;
        for (let c = 0; c < 3; c++) chw[base + c * REC_H * DIGIT_W + y * DIGIT_W + x] = (px[p + c] / 255 - 0.5) / 0.5;
      }
    }
    inputs.push({ chw, dims: [N, 3, REC_H, DIGIT_W] });
    sizes.push(N);
  }
  const results = await runRecArgmaxMany(inputs); // 一次 IPC
  const out: string[] = [];
  const _t0 = performance.now();
  results.forEach((r, bi) => {
    const { idx, T } = r;
    for (let n = 0; n < sizes[bi]; n++) {
      const off = n * T;
      let prev = -1, s = "";
      for (let t = 0; t < T; t++) {
        const best = idx[off + t];
        if (best !== 0 && best !== prev) s += chars[best] ?? "";
        prev = best;
      }
      out.push(s);
    }
  });
  _prof.ctc += performance.now() - _t0;
  return out;
}

export function paddleOcrBackend(): OcrBackend {
  const backend = {
    async recognizeDigits(bin: Binary, rects: Rect[]): Promise<number[]> {
      if (!rects.length) return [];
      await ensureSession();
      const src = binToCanvas(bin);
      const texts = await recognizeDigitCells(rects.map((r) => cellOf(src, bin, r)));
      return texts.map((text) => { const m = text.match(/[0-7]/); return m ? Number(m[0]) : 0; });
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
      // 全部歌词条一次 IPC（Rust 内部逐条推理=算力最优，往返只 1 次）。
      return (await recognizeCharsPosMany(canvases)).map((cp) => cp.map((c) => c.ch).join(""));
    },
    async recognizeTextsPos(canvases: OffscreenCanvas[]): Promise<{ ch: string; xFrac: number }[][]> {
      if (!canvases.length) return [];
      await ensureSession();
      return recognizeCharsPosMany(canvases); // 一次 IPC
    },
    async recognizeRegion(bin: Binary, region: Rect): Promise<{ text: string; bbox: Rect; chars?: { text: string; cx: number; x1?: number }[] }[]> {
      await ensureSession();
      const src = binToCanvas(bin);
      const boxes = await detectRegion(src, region);
      // 先裁出所有页眉框画布，再一次 IPC 批量 rec（放宽宽上限免长英文行被压扁）。
      const items: { cv: OffscreenCanvas; x: number; y: number; w: number; h: number }[] = [];
      for (const b of boxes) {
        const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y));
        const w = Math.min(bin.w - x, Math.round(b.w)), h = Math.min(bin.h - y, Math.round(b.h));
        if (w < 4 || h < 4) continue;
        const cv = new OffscreenCanvas(w, h);
        const cx = cv.getContext("2d");
        if (!cx) continue;
        cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h);
        cx.drawImage(src, x, y, w, h, 0, 0, w, h);
        items.push({ cv, x, y, w, h });
      }
      const cps = await recognizeCharsPosMany(items.map((it) => it.cv), 2048);
      const out: { text: string; bbox: Rect; chars?: { text: string; cx: number; x1?: number }[] }[] = [];
      items.forEach((it, i) => {
        const cp = cps[i];
        const text = cp.map((c) => c.ch).join("");
        if (text.trim()) out.push({ text, bbox: { x: it.x, y: it.y, w: it.w, h: it.h }, chars: cp.map((c) => ({ text: c.ch, cx: it.x + c.xFrac * it.w, x1: it.x + c.x1Frac * it.w })) });
      });
      return out;
    },
  };
  return backend;
}
