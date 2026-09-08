// Node 侧 OMR 运行时：onnxruntime-node（原生 CPU 后端，同一套 ONNX Runtime，比浏览器 wasm 快约 2×）。
// **只有这个文件碰 onnxruntime-node 与 fs**，绝不能进 omr/index.ts 的 import 链（会把 fs 拖进网页产物）。
//
// ## 为什么 rec 建两个 session
// 实测（**M5**，同一模型同一形状）最优线程数随张量形状反转：
//   rec 歌词条 [1,3,48,320]   1 线程 8.7ms   / 4 线程 16.6ms
//   rec 长条   [1,3,48,2048]  1 线程 53.3ms  / 4 线程 76.9ms
//   rec 数字批 [16,3,48,48]   1 线程 63.4ms  / 4 线程 38.6ms
//   det 整片   [1,3,960,960]  1 线程 193.1ms / 4 线程 76.4ms
// 也就是单张小图开多线程反被调度开销吃掉，成批或整片才填得满多核。判据见 pickThreads()。
//
// **这个判据是「单核强、核少」的机器上的结论，别当成普适**：它成立靠的是 M5 单核太强、
// 多线程那点并行赚不回调度开销。换到单核弱、核多的机器（Xeon E5 那代：2.0~2.4GHz、十几二十核），
// 同一条判据会把逐条歌词 rec 全按在一个弱核上，曲子越长累积得越狠——实测有 E5 服务器上 Node 版
// 反而比浏览器 4 线程 wasm 慢 2~3× 的例子。故留 `OMR_THREAD_MODE` 出口，见下。
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OmrRunOut, OmrRuntime } from "./runtime";

const REC_FILE = "ch_PP-OCRv6_small_rec_infer.onnx";
const DET_FILE = "ch_PP-OCRv4_det_infer.onnx";
const DICT_FILE = "ppocrv6_dict.txt";

/** 模型目录。**按产物位置解析，不看 cwd**——打包分发后第三方在任意目录跑都得找得到。
 *  顺序：env `OMR_MODELS` → 产物旁的 `models/`（打包形态）→ 仓库的 `public/redist/ocr`（开发）。 */
let _modelDir: string | null = null;
function modelDir(): string {
  if (_modelDir) return _modelDir;
  const here = dirname(fileURLToPath(import.meta.url));
  const cands = [
    process.env.OMR_MODELS,
    join(here, "models"),
    join(here, "..", "public", "redist", "ocr"),
  ].filter((d): d is string => !!d);
  const hit = cands.find((d) => existsSync(join(d, DICT_FILE)));
  if (!hit) throw new Error(`找不到 OCR 模型（试过：${cands.join(" / ")}）。设 env OMR_MODELS 指向含 ${DICT_FILE} 的目录。`);
  _modelDir = hit;
  return hit;
}

/** 多线程时用几个核。env `OMR_THREADS` 可覆盖（1 = 全程单线程）。 */
const THREADS = Math.max(1, Number(process.env.OMR_THREADS) || 4);

/** 线程策略。env `OMR_THREAD_MODE`：
 *  - `auto`（默认）按张量形状分派，见 pickThreads()——在单核强的机器上最快；
 *  - `always` 一律多线程——**单核弱、核多的机器（如 Xeon E5）该用这个**；
 *  - `single` 一律单线程——CPU quota 只有一两核的容器里用，免线程池自旋空转。 */
const THREAD_MODE = (() => {
  const v = (process.env.OMR_THREAD_MODE ?? "auto").toLowerCase();
  return v === "always" || v === "single" ? v : "auto";
})();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Session = any;
const _sessions = new Map<string, Promise<Session>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ort: any = null;

async function ort(): Promise<typeof _ort> {
  if (!_ort) _ort = (await import("onnxruntime-node")).default;
  return _ort;
}

function session(model: "rec" | "det", threads: number): Promise<Session> {
  const key = `${model}@${threads}`;
  let p = _sessions.get(key);
  if (!p) {
    p = (async () => {
      const o = await ort();
      return o.InferenceSession.create(join(modelDir(), model === "det" ? DET_FILE : REC_FILE), {
        intraOpNumThreads: threads,
        executionProviders: ["cpu"],
      });
    })();
    _sessions.set(key, p);
  }
  return p;
}

/** 该形状用几线程：成批（N>1）或单张但足够大（≥1M 元素，det 整片属此类）才吃得满多核。
 *  这是 auto 策略；机器特性不同时用 OMR_THREAD_MODE 覆盖（见上）。 */
function pickThreads(dims: number[]): number {
  if (THREADS <= 1 || THREAD_MODE === "single") return 1;
  if (THREAD_MODE === "always") return THREADS;
  const n = dims.reduce((a, b) => a * b, 1);
  return dims[0] > 1 || n >= 1_000_000 ? THREADS : 1;
}

/** 本进程实际生效的线程配置（诊断用，CLI 的 --profile 会打出来）。 */
export function threadInfo(): { mode: string; threads: number } {
  return { mode: THREAD_MODE, threads: THREADS };
}

export const nodeRuntime: OmrRuntime = {
  async prepare(model) {
    // det 恒多线程；rec 先备好 auto 策略下最常用的那个 session
    await session(model, model === "det" ? THREADS : pickThreads([1, 3, 48, 320]));
  },
  async run(model, chw, dims): Promise<OmrRunOut> {
    const o = await ort();
    const sess = await session(model, pickThreads(dims));
    const feeds: Record<string, unknown> = {};
    feeds[sess.inputNames[0]] = new o.Tensor("float32", chw, dims);
    const out = (await sess.run(feeds))[sess.outputNames[0]];
    return { data: out.data as Float32Array, dims: out.dims as number[] };
  },
  async loadDict() {
    return readFile(join(modelDir(), DICT_FILE), "utf-8");
  },
};
