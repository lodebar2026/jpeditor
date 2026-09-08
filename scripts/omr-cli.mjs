#!/usr/bin/env node
// 简谱 OMR 命令行：图片 → 文本谱 / MusicXML，**不起浏览器**（onnxruntime-node 原生推理）。
// 用法（仓库里从根跑；分发包里就在包目录跑）：
//   node scripts/omr-cli.mjs 图片.jpg                      # 默认输出诗歌本文本谱到 stdout
//   node scripts/omr-cli.mjs 图片.jpg -f jpwabc -o 曲.xml   # 换格式、写文件
//   node scripts/omr-cli.mjs 图片.jpg --profile             # 附带分段耗时与线程配置
//   node scripts/omr-cli.mjs a.jpg b.jpg 谱子目录/ -o 出目录/ # 批量：一个进程跑完整批
//   node scripts/omr-cli.mjs 图.jpg --thread-mode=always --threads=8   # 调线程策略
// 格式清单取自 src/omr/emit.ts::OMR_EMITTERS，加格式不用改本脚本。
//
// **批量比逐张起进程快得多**：模型 21MB、ONNX 图反序列化 + ORT 初始化 + JIT 预热大约要
// 2.4s（M5 实测，弱 CPU 上更久），逐张调用等于每张都付一遍；同一进程连跑只付一次。
// 服务端集成请优先用批量，或把本文件当库 import（见包内 README）。
//
// 线程策略（同一份判据在不同 CPU 上结论会反，详见 src/omr/runtime.node.ts）：
//   --thread-mode=auto    默认，按张量形状分派；单核强、核少的机器（Apple M 系）最快
//   --thread-mode=always  一律多线程；**单核弱、核多的机器（Xeon E5 那代）该用这个**
//   --thread-mode=single  一律单线程；CPU quota 只有一两核的容器里用
//   --threads=N           多线程时用几个核（默认 4）
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"]);

const argv = process.argv.slice(2);
const opts = { format: "shige", out: null, profile: false, help: false, imgs: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-f" || a === "--format") opts.format = argv[++i];
  else if (a === "-o" || a === "--out") opts.out = argv[++i];
  else if (a === "--profile") opts.profile = true;
  else if (a === "-h" || a === "--help") opts.help = true;
  // 线程开关要在 import 产物**之前**落到 env——那两个是模块顶层常量，import 完再设就晚了。
  else if (a.startsWith("--threads=")) process.env.OMR_THREADS = a.slice(10);
  else if (a.startsWith("--thread-mode=")) process.env.OMR_THREAD_MODE = a.slice(14);
  else opts.imgs.push(a);
}

function usage(emitters) {
  const list = emitters ? emitters.map((e) => `${e.id}（${e.label}）`).join("、") : "shige / tomato / jpwabc";
  console.error(`用法: omr-cli.mjs <图片…|目录…> [-f 格式] [-o 输出] [--profile]
              [--thread-mode=auto|always|single] [--threads=N]
格式: ${list}
批量: 多个图片或目录一起给，同一进程跑完（省掉每张的模型加载）；-o 给目录则逐个写文件。`);
}

// 两种布局都要认：仓库里是 ../dist-cli/omr.js，打包产物里是同目录的 ./omr.js。
const CLI_URL = ["./omr.js", "../dist-cli/omr.js"]
  .map((r) => new URL(r, import.meta.url))
  .find((u) => existsSync(fileURLToPath(u)));
if (!CLI_URL) { console.error("找不到 omr.js —— 仓库里先跑 npm run build:cli"); process.exit(1); }
const cli = await import(CLI_URL.href);

if (opts.help || !opts.imgs.length) { usage(cli.OMR_EMITTERS); process.exit(opts.help ? 0 : 1); }
if (!cli.isOmrFormat(opts.format)) {
  console.error(`未知格式 ${opts.format}`); usage(cli.OMR_EMITTERS); process.exit(1);
}

/** 展开输入：目录 → 里面的图片（不递归，按名排序）。 */
async function expand(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try { st = await stat(p); } catch { console.error(`跳过（打不开）：${p}`); continue; }
    if (!st.isDirectory()) { out.push(p); continue; }
    const files = (await readdir(p)).filter((f) => IMG_EXT.has(extname(f).toLowerCase())).sort();
    if (!files.length) console.error(`跳过（目录里没图片）：${p}`);
    for (const f of files) out.push(join(p, f));
  }
  return out;
}

const imgs = await expand(opts.imgs);
if (!imgs.length) { console.error("没有可识别的图片"); process.exit(1); }

// -o 是目录（多图，或路径本身就是已存在的目录）时逐个写文件，否则当单个输出文件。
const outIsDir = opts.out != null && (imgs.length > 1 || (existsSync(opts.out) && (await stat(opts.out)).isDirectory()));
if (outIsDir) await mkdir(opts.out, { recursive: true });
const EXT = { jpwabc: ".musicxml" };

let failed = 0;
const t0all = performance.now();
for (const img of imgs) {
  const t0 = performance.now();
  cli.omrProfileReset();
  let r;
  try {
    r = await cli.recognizeImage(new Uint8Array(await readFile(img)), {
      mime: MIME[extname(img).toLowerCase()], format: opts.format,
    });
  } catch (e) {
    console.error(`✗ ${basename(img)}: ${e instanceof Error ? e.message : String(e)}`);
    failed++;
    continue;
  }
  const wall = performance.now() - t0;

  if (outIsDir) {
    const dst = join(opts.out, basename(img, extname(img)) + (EXT[r.format] ?? ".txt"));
    await writeFile(dst, r.text, "utf-8");
    console.error(`已写入 ${dst}`);
  } else if (opts.out) {
    await writeFile(opts.out, r.text, "utf-8");
    console.error(`已写入 ${opts.out}`);
  } else {
    if (imgs.length > 1) process.stdout.write(`# ===== ${basename(img)} =====\n`);
    process.stdout.write(r.text.endsWith("\n") ? r.text : r.text + "\n");
  }

  if (opts.profile) {
    const p = cli.omrProfile();
    const rows = r.detail.score.rows ?? [];
    const notes = rows.reduce((a, x) => a + (x.nums?.length ?? 0), 0);
    const ti = cli.threadInfo();
    console.error(`[OMR] ${basename(img)} ${r.detail.bin.w}×${r.detail.bin.h} ${rows.length}行/${notes}音`
      + ` ｜ 总 ${wall.toFixed(0)}ms = infer ${p.infer.toFixed(0)}(${p.calls}次) + CTC ${p.ctc.toFixed(0)}`
      + ` + 其余 ${(wall - p.infer - p.ctc).toFixed(0)}`
      + ` ｜ 线程 ${ti.mode}/${ti.threads}`);
  }
}

if (imgs.length > 1) {
  const total = performance.now() - t0all;
  console.error(`\n共 ${imgs.length} 张，成功 ${imgs.length - failed}，合计 ${(total / 1000).toFixed(1)}s，`
    + `平均 ${(total / imgs.length).toFixed(0)}ms/张（首张含模型加载）`);
}
process.exit(failed ? 1 : 0);
