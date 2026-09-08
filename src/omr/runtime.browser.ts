// 浏览器侧 OMR 运行时：onnxruntime-web（纯 wasm 构建）。**只有这个文件碰 ort-web 与资源 URL**，
// 识别管线其余部分经 `runtime.ts` 的注入点拿推理能力（同 staffomr/browser.ts 的分工约定）。
import type { OmrRunOut, OmrRuntime } from "./runtime";

// ort 运行时（纯 wasm，单线程，免 jsep 26MB）经 Vite `?url` 引入：dev/build 都由 Vite 解析为
// 合法资源 URL。**不能**把这两个文件放 /public 再用 wasmPaths 字符串——onnxruntime-web 会对
// 其中的 .mjs 做动态 import()，而 Vite dev 拒绝把 /public 文件当模块加载。
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";

const BASE = import.meta.env.BASE_URL; // "/" 或 "/jpeditor/"
const REC_URL = `${BASE}redist/ocr/ch_PP-OCRv6_small_rec_infer.onnx`;
const DICT_URL = `${BASE}redist/ocr/ppocrv6_dict.txt`;
const DET_URL = `${BASE}redist/ocr/ch_PP-OCRv4_det_infer.onnx`;

const REC_H = 48; // warmup 张量边长，与 paddleocr.ts 的 REC_H 一致即可

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ort: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _session: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _detSession: any = null;
let _initPromise: Promise<void> | null = null;
let _detInitPromise: Promise<void> | null = null;

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

async function ensureRec(): Promise<void> {
  if (_session) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    // 纯 wasm 构建（非 jsep/webgpu），只需 ort-wasm-simd-threaded.wasm，省去 26MB jsep。
    const ort = await import("onnxruntime-web/wasm");
    // 用 Vite 解析出的资源 URL 映射，避免 dev 下对 /public 的 .mjs 动态 import 报错。
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
    _ort = ort;
    _session = await createRecSession(); // 多线程（带超时回退）/单线程
  })();
  return _initPromise;
}

async function ensureDet(): Promise<void> {
  await ensureRec();
  if (_detSession) return;
  if (_detInitPromise) return _detInitPromise;
  _detInitPromise = (async () => {
    _detSession = await _ort.InferenceSession.create(DET_URL, { executionProviders: ["wasm"] });
  })();
  return _detInitPromise;
}

export const browserRuntime: OmrRuntime = {
  async prepare(model) {
    if (model === "det") await ensureDet();
    else await ensureRec();
  },
  async run(model, chw, dims): Promise<OmrRunOut> {
    await this.prepare(model);
    const sess = model === "det" ? _detSession : _session;
    const tensor = new _ort.Tensor("float32", chw, dims);
    const feeds: Record<string, unknown> = {}; feeds[sess.inputNames[0]] = tensor;
    const o = (await sess.run(feeds))[sess.outputNames[0]];
    return { data: o.data as Float32Array, dims: o.dims as number[] };
  },
  async loadDict() {
    return (await fetch(DICT_URL)).text();
  },
};
