#!/usr/bin/env node
// 桌面版 Windows：把 VC++ 运行库放到 jpeditor.exe 旁边（app-local 部署），用户不必先装
// vc_redist。DLL 怎么从官方 vc_redist.exe 里纯 Node 抠出来、分发许可如何 —— 见 vcredist.mjs。
//
//   node scripts/win-crt.mjs                       # 提取到 src-tauri/crt/（打包前跑）
//   node scripts/win-crt.mjs --verify=<exe|dll>    # 校验该二进制要的 CRT 都在清单里
//
// ## 为什么桌面版也需要
// `ort` 静态链进来的 ONNX Runtime 是微软用 /MD 编的，jpeditor.exe 因此直接导入 MSVCP140.dll /
// MSVCP140_1.dll / VCRUNTIME140*.dll 这几个——它们不在系统自带的 UCRT 里，干净的 Windows 上
// 一开就报「由于找不到 MSVCP140_1.dll，无法继续执行代码」。
//
// ## 怎么进安装包
// src-tauri/tauri.windows.conf.json 把 crt/*.dll 列成 bundle.resources，目标路径是纯文件名 →
// NSIS 装到 $INSTDIR，正好是 exe 同目录；exe 的隐式依赖搜索第一站就是自己所在目录。
// **那份 conf 是清单的唯一真源**，本脚本按它提取，要加减 DLL 改 conf 即可。
// 目录 src-tauri/crt/ 不入库（微软二进制），所以 conf 里的 beforeBuildCommand 每次打包先跑本脚本。
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { crtLibrary, crtClosure, peImports } from "./vcredist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONF = join(ROOT, "src-tauri", "tauri.windows.conf.json");
const BASE = join(ROOT, "src-tauri", "tauri.conf.json");
const OUT = join(ROOT, "src-tauri", "crt");
/** 只打 x86_64-pc-windows-msvc；arm64 的 vc_redist 没有 vcruntime140_1，清单要另列。 */
const CPU = "x64";

/** conf 里 bundle.resources 声明要带的 CRT（小写 dll 名）。 */
async function manifest() {
  const conf = JSON.parse(await readFile(CONF, "utf8"));
  const res = conf.bundle?.resources ?? {};
  // 平台 conf 的 resources 是整张表（不指望 Tauri 的合并语义），非 CRT 的那几项要跟主 conf 一字不差，
  // 免得主 conf 加了资源、Windows 包悄悄少一个文件。
  const base = JSON.parse(await readFile(BASE, "utf8")).bundle?.resources ?? {};
  for (const [k, v] of Object.entries(base)) {
    if (res[k] !== v) throw new Error(`${basename(CONF)} 的 bundle.resources 少了或改了 "${k}": "${v}"（主 conf 有）`);
  }
  const dlls = Object.keys(res)
    .filter((p) => p.startsWith("crt/"))
    .map((p) => basename(p).toLowerCase());
  if (!dlls.length) throw new Error(`${CONF} 的 bundle.resources 里没有 crt/*.dll`);
  return new Set(dlls);
}

const verify = process.argv.slice(2).find((a) => a.startsWith("--verify="))?.slice(9);
const want = await manifest();

if (verify) {
  // 编译产物实际导入了什么 CRT，清单必须盖住——ort / 依赖换版本后多要一个 DLL，在 CI 就红，
  // 而不是等用户开不了程序。
  const deps = peImports(await readFile(verify)).map((d) => d.toLowerCase());
  const crt = deps.filter((d) => /^(vcruntime140|msvcp140|concrt140|vcomp140|vcamp140|vccorlib140)/.test(d));
  const missing = crt.filter((d) => !want.has(d));
  console.log(`${verify}\n  依赖 CRT：${crt.join(" ") || "（无）"}`);
  if (missing.length) {
    console.error(`清单缺 ${missing.join(" ")} —— 请补进 ${basename(CONF)} 的 bundle.resources`);
    process.exit(1);
  }
  console.log("  清单已覆盖 ✓");
} else {
  const lib = await crtLibrary(CPU);
  // 清单里的 DLL 自己还要别的 CRT（MSVCP140_1 → MSVCP140 → VCRUNTIME140_1 → …），一并要求列全
  const closure = crtClosure(want, lib);
  const short = [...closure].filter((d) => !want.has(d));
  if (short.length) throw new Error(`清单不完整，还缺依赖 ${short.join(" ")} —— 请补进 ${basename(CONF)}`);
  await mkdir(OUT, { recursive: true });
  let bytes = 0;
  for (const name of [...want].sort()) {
    const data = lib.get(name);
    if (!data) throw new Error(`vc_redist.${CPU} 里没有 ${name}`);
    await writeFile(join(OUT, name), data);
    bytes += data.length;
  }
  console.log(`内置 VC++ 运行库 → src-tauri/crt/：${[...want].sort().join(" ")}（共 ${Math.round(bytes / 1024)}K）`);
}
