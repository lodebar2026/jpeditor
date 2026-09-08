#!/usr/bin/env node
// 简谱 OMR 命令行：图片 → 文本谱 / MusicXML，**不起浏览器**（onnxruntime-node 原生推理）。
// 用法（一律从仓库根跑）：
//   node scripts/omr-cli.mjs 图片.jpg                     # 默认输出诗歌本文本谱到 stdout
//   node scripts/omr-cli.mjs 图片.jpg -f jpwabc -o 曲.xml  # 换格式、写文件
//   node scripts/omr-cli.mjs 图片.jpg --profile            # 附带分段耗时
// 格式清单取自 src/omr/emit.ts::OMR_EMITTERS，加格式不用改本脚本。
// 模型默认读 public/redist/ocr/，env OMR_MODELS 可改；env OMR_THREADS 调线程数。
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

function usage(emitters) {
  const list = emitters.map((e) => `${e.id}（${e.label}）`).join("、");
  console.error(`用法: node scripts/omr-cli.mjs <图片> [-f 格式] [-o 输出] [--profile]\n格式: ${list}`);
}

const argv = process.argv.slice(2);
const opts = { format: "shige", out: null, profile: false, img: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-f" || a === "--format") opts.format = argv[++i];
  else if (a === "-o" || a === "--out") opts.out = argv[++i];
  else if (a === "--profile") opts.profile = true;
  else if (a === "-h" || a === "--help") opts.help = true;
  else if (!opts.img) opts.img = a;
}

// 两种布局都要认：仓库里是 ../dist-cli/omr.js，打包产物里是同目录的 ./omr.js。
const CLI_URL = ["./omr.js", "../dist-cli/omr.js"]
  .map((r) => new URL(r, import.meta.url))
  .find((u) => existsSync(fileURLToPath(u)));
if (!CLI_URL) { console.error("找不到 omr.js —— 仓库里先跑 npm run build:cli"); process.exit(1); }
const cli = await import(CLI_URL.href);
if (opts.help || !opts.img) { usage(cli.OMR_EMITTERS); process.exit(opts.help ? 0 : 1); }
if (!cli.isOmrFormat(opts.format)) {
  console.error(`未知格式 ${opts.format}`); usage(cli.OMR_EMITTERS); process.exit(1);
}

const bytes = new Uint8Array(await readFile(opts.img));
const mime = MIME[extname(opts.img).toLowerCase()];
const t0 = performance.now();
cli.omrProfileReset();
const r = await cli.recognizeImage(bytes, { mime, format: opts.format });
const wall = performance.now() - t0;

if (opts.out) { await writeFile(opts.out, r.text, "utf-8"); console.error(`已写入 ${opts.out}`); }
else process.stdout.write(r.text.endsWith("\n") ? r.text : r.text + "\n");

if (opts.profile) {
  const p = cli.omrProfile();
  const rows = r.detail.score.rows ?? [];
  const notes = rows.reduce((a, x) => a + (x.nums?.length ?? 0), 0);
  console.error(`[OMR] ${basename(opts.img)} ${r.detail.bin.w}×${r.detail.bin.h} ${rows.length}行/${notes}音`
    + ` ｜ 总 ${wall.toFixed(0)}ms = infer ${p.infer.toFixed(0)}(${p.calls}次) + CTC ${p.ctc.toFixed(0)}`
    + ` + 其余 ${(wall - p.infer - p.ctc).toFixed(0)}`);
}
