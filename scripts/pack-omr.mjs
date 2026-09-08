#!/usr/bin/env node
// 把简谱 OMR 命令行打成**自包含**分发包：解压即用，不联网、不装依赖（只要机器上有 Node ≥20）。
// 支持交叉打包——在 mac 上就能打出 Linux / Windows 的包。
//
// 用法（从仓库根跑，先 npm run build:cli）：
//   node scripts/pack-omr.mjs                                 # 当前平台
//   node scripts/pack-omr.mjs --targets=all                   # 全部 5 个目标
//   node scripts/pack-omr.mjs --targets=linux-x64,win32-x64   # 挑几个
//   node scripts/pack-omr.mjs --targets=linux-x64 --libc=musl # Alpine 那类 musl 发行版
//   node scripts/pack-omr.mjs --slim                          # Windows 包去掉 DirectML（见下）
//   node scripts/pack-omr.mjs --keep                          # 保留目录、不打压缩包
//
// 产物：dist-pkg/jpeditor-omr-<版本>-<os>-<cpu>[-musl].{tar.gz|zip}
//
// ## 交叉打包靠什么成立
// 两个原生依赖都是**预编译分发**，不在安装时编译：
//   - sharp 按平台拆成 @img/sharp-<os>-<cpu> 子包，`npm i --os= --cpu= --libc=` 能精确拉到；
//   - onnxruntime-node 是**单包内含全平台**二进制，装完再裁掉别的平台。
// 所以交叉打包不需要目标平台的工具链。但**产物没在目标平台上跑过**，务必在目标机上
// 用 `omr-cli.mjs <图>` 自检一次；本脚本只做静态校验（该在的文件在不在）。
//
// ## 各平台的裁剪要点
//   darwin  libonnxruntime.1.dylib 与 libonnxruntime.1.29.0.dylib 是两个完整副本（各 42MB），
//           换成硬链接，tar 存成 hardlink 记录 → 省 42MB。
//   win32   除 onnxruntime.dll 外还带 DirectML.dll / dxcompiler.dll / dxil.dll 共 ~36MB，那是
//           DirectML EP 用的，我们只跑 CPU EP。`--slim` 会删掉它们——**没在 Windows 上验证过**，
//           默认保留，要用请先在目标机上自检。
import { readFile, writeFile, mkdir, rm, cp, readdir, link, unlink, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "jpeditor-omr";
const OUT = join(ROOT, "dist-pkg");

/** ORT 有预编译二进制的目标（`node_modules/onnxruntime-node/bin/napi-v6/` 下的实际目录）。 */
const TARGETS = ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];
/** 只跑 CPU EP，Windows 上这三个 DirectML 相关的 dll 用不到（--slim 时删）。 */
const WIN_DML = ["DirectML.dll", "dxcompiler.dll", "dxil.dll"];

const argv = process.argv.slice(2);
const opt = (k, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : dflt;
};
const KEEP = argv.includes("--keep");
const SLIM = argv.includes("--slim");
const DEDUPE = !argv.includes("--no-dedupe");
const LIBC = opt("libc", "glibc");
const targetsArg = opt("targets", `${process.platform}-${process.arch}`);
const targets = targetsArg === "all" ? TARGETS : targetsArg.split(",").map((t) => t.trim());

for (const t of targets) {
  if (!TARGETS.includes(t)) {
    console.error(`不认识的目标 ${t}；可选：${TARGETS.join(" / ")} 或 all`);
    process.exit(1);
  }
}
if (!existsSync(join(ROOT, "dist-cli", "omr.js"))) {
  console.error("缺 dist-cli/omr.js —— 先跑 npm run build:cli");
  process.exit(1);
}

const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
const VER = pkg.version;
const du = (p) => execFileSync("du", ["-sh", p]).toString().split("\t")[0].trim();

/** vite 多入口会把 omr.js 与 index.js 的公共代码拆成共享 chunk（如 lyrics.js），
 *  只拷 omr.js 会 ERR_MODULE_NOT_FOUND → 顺着相对 import 递归收全。 */
async function copyWithChunks(dir, entry) {
  const seen = new Set();
  const walk = async (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const src = join(ROOT, "dist-cli", name);
    await cp(src, join(dir, name));
    const code = await readFile(src, "utf-8");
    for (const m of code.matchAll(/(?:from|import\()\s*["'](\.\/[^"']+\.js)["']/g)) await walk(m[1].slice(2));
  };
  await walk(entry);
  return [...seen];
}

/** 装完之后静态校验：目标平台的 ORT 二进制与 sharp 平台包必须真的在包里。
 *  交叉打包最容易出的错就是 npm 静默装了宿主平台的包，跑到目标机上才炸。 */
async function verify(dir, os, cpu, libcTag) {
  const problems = [];
  const ortDir = join(dir, "node_modules", "onnxruntime-node", "bin");
  const napi = existsSync(ortDir) ? (await readdir(ortDir))[0] : null;
  const binDir = napi ? join(ortDir, napi, os, cpu) : null;
  if (!binDir || !existsSync(join(binDir, "onnxruntime_binding.node"))) {
    problems.push(`缺 onnxruntime_binding.node（${os}/${cpu}）`);
  }
  const libRe = os === "win32" ? /^onnxruntime\.dll$/ : os === "darwin" ? /\.dylib$/ : /\.so(\.\d+)?$/;
  if (binDir && existsSync(binDir) && !(await readdir(binDir)).some((f) => libRe.test(f))) {
    problems.push(`缺 ${os} 的 onnxruntime 运行库`);
  }
  const sharpPkg = `@img/sharp-${libcTag === "musl" ? `${os}musl` : os}-${cpu}`;
  if (!existsSync(join(dir, "node_modules", sharpPkg))) problems.push(`缺 ${sharpPkg}`);
  for (const f of ["omr.js", "omr-cli.mjs", "models/ppocrv6_dict.txt"]) {
    if (!existsSync(join(dir, f))) problems.push(`缺 ${f}`);
  }
  return problems;
}

async function build(target) {
  const [os, cpu] = target.split("-");
  const libcTag = os === "linux" && LIBC === "musl" ? "musl" : null;
  const suffix = `${target}${libcTag ? "-musl" : ""}`;
  const dir = join(OUT, `${NAME}-${suffix}`);
  console.log(`\n===== ${target}${libcTag ? " (musl)" : ""} =====`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // 1. 代码 + 模型
  const chunks = await copyWithChunks(dir, "omr.js");
  await cp(join(ROOT, "scripts", "omr-cli.mjs"), join(dir, "omr-cli.mjs"));
  await chmod(join(dir, "omr-cli.mjs"), 0o755);
  await mkdir(join(dir, "models"), { recursive: true });
  for (const f of await readdir(join(ROOT, "public", "redist", "ocr"))) {
    await cp(join(ROOT, "public", "redist", "ocr", f), join(dir, "models", f));
  }
  console.log(`代码 ${chunks.join(", ")} + 模型 ${du(join(dir, "models"))}`);

  // 2. package.json：只留运行期真正要的两个依赖
  await writeFile(join(dir, "package.json"), JSON.stringify({
    name: NAME,
    version: VER,
    description: "简谱图像识别命令行（图片 → 诗歌本/番茄文本谱 或 MusicXML），自包含离线运行",
    type: "module",
    bin: { [NAME]: "./omr-cli.mjs" },
    exports: { ".": "./omr.js" },
    engines: { node: ">=20" },
    license: pkg.license,
    // 目标平台只做记录用：**不能写 os/cpu 字段**——npm 会拿它跟宿主比，交叉打包时
    // 自己 install 到这个目录就先 EBADPLATFORM 挂掉了。
    target: `${os}-${cpu}${libcTag ? "-musl" : ""}`,
    dependencies: {
      "onnxruntime-node": pkg.devDependencies["onnxruntime-node"],
      sharp: pkg.dependencies.sharp,
    },
  }, null, 2) + "\n");

  // 3. 装依赖（npm 自己解依赖树，比手工拷可靠）
  const flags = ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock",
    `--os=${os}`, `--cpu=${cpu}`];
  if (os === "linux") flags.push(`--libc=${LIBC}`);
  execFileSync("npm", flags, { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });

  // 4. 裁掉 ORT 的其余平台
  const ortBin = join(dir, "node_modules", "onnxruntime-node", "bin");
  for (const napi of await readdir(ortBin)) {
    for (const plat of await readdir(join(ortBin, napi))) {
      if (plat !== os) { await rm(join(ortBin, napi, plat), { recursive: true, force: true }); continue; }
      for (const a of await readdir(join(ortBin, napi, plat))) {
        if (a !== cpu) await rm(join(ortBin, napi, plat, a), { recursive: true, force: true });
      }
    }
  }
  const binDir = join(ortBin, (await readdir(ortBin))[0], os, cpu);

  // 5. darwin：同一 dylib 的重复副本 → 硬链接
  if (DEDUPE && os === "darwin" && existsSync(binDir)) {
    const libs = (await readdir(binDir)).filter((f) => f.endsWith(".dylib")).sort((a, b) => a.length - b.length);
    for (const dup of libs.slice(1)) {
      const [a, b] = [join(binDir, libs[0]), join(binDir, dup)];
      if ((await stat(a)).size !== (await stat(b)).size) continue; // 不是同一份就别动
      await unlink(b);
      await link(a, b);
      console.log(`去重 ${dup} → 硬链到 ${libs[0]}`);
    }
  }
  // 5b. win32：--slim 去掉 DirectML 那套（只跑 CPU EP 用不上）
  if (SLIM && os === "win32" && existsSync(binDir)) {
    for (const f of WIN_DML) await rm(join(binDir, f), { force: true });
    console.log(`slim：删掉 ${WIN_DML.join(" / ")}（未在 Windows 上验证，请在目标机自检）`);
  }

  // 5c. win32：给个 .cmd 入口——shebang 在 Windows 上不起作用，自包含包又没有 npm 生成的 shim
  if (os === "win32") {
    await writeFile(join(dir, "omr-cli.cmd"),
      "@echo off\r\nsetlocal\r\nnode \"%~dp0omr-cli.mjs\" %*\r\n", "utf-8");
  }

  // 6. README
  await writeFile(join(dir, "README.md"), `# ${NAME} ${VER}

简谱图像识别命令行。自包含：解压即用，不联网、不装依赖，只要机器上有 Node ≥ 20。
本包目标平台 **${os}/${cpu}${libcTag ? " (musl)" : ""}**。

${os === "win32" ? `\`\`\`bat
omr-cli.cmd 图片.jpg                      :: 默认输出诗歌本文本谱到 stdout
omr-cli.cmd 图片.jpg -f tomato -o 曲.txt  :: 换格式、写文件
omr-cli.cmd 图片.jpg --profile            :: 附带分段耗时
\`\`\`

需要 **Microsoft Visual C++ 2015–2022 可再发行组件**（\`vc_redist.${cpu === "arm64" ? "arm64" : "x64"}.exe\`）：
包里的 \`onnxruntime.dll\` 与 \`onnxruntime_binding.node\` 动态链接 \`MSVCP140.dll\` / \`VCRUNTIME140.dll\`，
那几个不在系统自带的 UCRT 里。（sharp 那部分是静态链接的，不需要。）
Win10/11 多半已装过，报「找不到 VCRUNTIME140.dll」时到微软官网下载安装即可。
输出编码为 UTF-8，用 \`-o\` 写文件最稳；直接看 stdout 的话先 \`chcp 65001\`。` : `\`\`\`bash
./omr-cli.mjs 图片.jpg                      # 默认输出诗歌本文本谱到 stdout
./omr-cli.mjs 图片.jpg -f tomato -o 曲.txt   # 换格式、写文件
./omr-cli.mjs 图片.jpg --profile             # 附带分段耗时
\`\`\``}

格式：\`shige\`（诗歌本文本谱，默认）、\`tomato\`（番茄简谱）、\`jpwabc\`（MusicXML）。
输入只吃位图（jpg/png/webp/bmp/tiff），**不吃 PDF**。

当库用：

\`\`\`js
import { recognizeImage } from "./omr.js";
const { text } = await recognizeImage(bytes, { mime: "image/jpeg", format: "shige" });
\`\`\`

环境变量：\`OMR_MODELS\` 指定模型目录（默认包内 \`models/\`），\`OMR_THREADS\` 调线程数（默认 4）。
`);

  // 7. 校验 + 压缩
  const problems = await verify(dir, os, cpu, libcTag);
  if (problems.length) {
    console.error(`✗ ${suffix} 校验不过：${problems.join("；")}`);
    return { target: suffix, ok: false };
  }
  const size = du(dir);
  if (KEEP) { console.log(`✓ ${suffix}  ${size}  → ${dir}`); return { target: suffix, ok: true, size }; }
  // Windows 用 zip（解压即用不必依赖 tar），其余 tar.gz（能保住硬链接与可执行位）
  const isWin = os === "win32";
  const file = join(OUT, `${NAME}-${VER}-${suffix}.${isWin ? "zip" : "tar.gz"}`);
  await rm(file, { force: true });
  if (isWin) execFileSync("zip", ["-qry", file, `${NAME}-${suffix}`], { cwd: OUT });
  else execFileSync("tar", ["czf", file, "-C", OUT, `${NAME}-${suffix}`]);
  await rm(dir, { recursive: true, force: true });
  console.log(`✓ ${suffix}  目录 ${size} → ${file.replace(ROOT + "/", "")} (${du(file)})`);
  return { target: suffix, ok: true, size, file };
}

console.log(`打包 ${NAME} ${VER}：${targets.join(", ")}`);
await mkdir(OUT, { recursive: true });
const results = [];
for (const t of targets) results.push(await build(t));

const bad = results.filter((r) => !r.ok);
console.log(`\n完成 ${results.length - bad.length}/${results.length}`);
if (bad.length) { console.error(`失败：${bad.map((r) => r.target).join(", ")}`); process.exit(1); }
console.log("交叉打包的产物没在目标平台上跑过，请在目标机上 omr-cli.mjs <图> 自检一次。");
