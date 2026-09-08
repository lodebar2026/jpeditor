// Node 侧 OMR 运行时：onnxruntime-node（原生 CPU 后端，同一套 ONNX Runtime，比浏览器 wasm 快约 2×）。
// **只有这个文件碰 onnxruntime-node 与 fs**，绝不能进 omr/index.ts 的 import 链（会把 fs 拖进网页产物）。
//
// ## 为什么 rec 建两个 session
// 实测（M5，同一模型同一形状）最优线程数随张量形状反转：
//   rec 歌词条 [1,3,48,320]   1 线程 8.7ms   / 4 线程 16.6ms
//   rec 长条   [1,3,48,2048]  1 线程 53.3ms  / 4 线程 76.9ms
//   rec 数字批 [16,3,48,48]   1 线程 63.4ms  / 4 线程 38.6ms
//   det 整片   [1,3,960,960]  1 线程 193.1ms / 4 线程 76.4ms
// 也就是单张小图开多线程反被调度开销吃掉，成批或整片才填得满多核。判据见 pickThreads()。
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

/** 该形状用几线程：成批（N>1）或单张但足够大（≥1M 元素，det 整片属此类）才吃得满多核。 */
function pickThreads(dims: number[]): number {
  if (THREADS <= 1) return 1;
  const n = dims.reduce((a, b) => a * b, 1);
  return dims[0] > 1 || n >= 1_000_000 ? THREADS : 1;
}

export const nodeRuntime: OmrRuntime = {
  async prepare(model) {
    await session(model, model === "det" ? THREADS : 1); // det 恒多线程；rec 先备好单线程那个
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
