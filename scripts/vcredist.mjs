#!/usr/bin/env node
// 从微软官方 vc_redist.<arch>.exe 里抽出 VC++ 运行库 DLL，供 pack-omr 做 **app-local 部署**
// （把 CRT 放到用它的二进制旁边，用户就不必先装 vc_redist）。
//
//   node scripts/vcredist.mjs x64              # 列出该架构能提供的 CRT
//   node scripts/vcredist.mjs arm64 --out=dir  # 提取到目录
//   node scripts/vcredist.mjs x64 --imports=<某个 dll/exe/node>   # 打印它的导入表
//
// ## 为什么不静态链接
// 包里的 onnxruntime.dll / onnxruntime_binding.node 是 ORT 官方用 /MD 编好发到 npm 的预编译
// 产物，要静态就得自己重编 ONNX Runtime + N-API binding（需要 Windows + VS 工具链，还废掉
// 交叉打包）。app-local 部署这几个 DLL 效果等价，代价不到 1M。
//
// ## app-local 为什么能生效
// Node 的 process.dlopen 走 libuv 的 uv_dlopen → LoadLibraryExW(..., LOAD_WITH_ALTERED_SEARCH_PATH)，
// 被加载的 .node **所在目录**先于系统目录参与依赖搜索。包里 onnxruntime.dll 本来就是靠这条被
// onnxruntime_binding.node 找到的，CRT 放同一目录同样能找到。注意搜索的是**加载者自己那个目录**，
// 所以哪个目录下的二进制要 CRT，就得往哪个目录放一份。
//
// ## 解包路径（全程纯 Node，不依赖 7z / cabextract / bsdtar）
// vc_redist 是 WiX Burn 自解压 exe：PE 后面附着一个 CAB（attached container），里面是 a0…aN，
// 其中若干个又是 CAB，CRT 的 DLL 以 `msvcp140.dll_amd64` 这种「名字 + _架构」的形式躺在里面。
// CAB 用的是 MSZIP 压缩 = 分块 raw deflate，块间沿用前一块输出的末 32K 作预置字典，
// zlib.inflateRawSync 的 dictionary 选项正好对得上。解出的字节与 bsdtar 解同一个 cab 完全一致。
//
// 分发许可：这些是微软明示的 redistributable files，随应用分发（含 app-local）是允许的。代价是
// 它们不再跟着 Windows Update 走安全更新——升级得靠我们重打包。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 下载缓存：node_modules 下，不入库、也不会被清 dist-pkg 时带走。 */
const CACHE = join(ROOT, "node_modules", ".cache", "vcredist");
/** 打包目标 cpu → vc_redist 包名 / CAB 里的架构后缀。 */
const ARCH = { x64: { pkg: "x64", suffix: "amd64" }, arm64: { pkg: "arm64", suffix: "arm64" } };
/** 只认这几族——redist 里还有 mfc140* 等一堆用不到的。 */
const CRT_PREFIX = /^(vcruntime140|msvcp140|concrt140|vcomp140|vcamp140|vccorlib140)/i;

/* ------------------------------------------------------------------ CAB */

/** 找出 buf 里所有像 CAB 头的偏移（vc_redist 是自解压 exe，CAB 附在 PE 后面）。 */
function cabOffsets(b) {
  const offs = [];
  for (let i = b.indexOf("MSCF", 0, "latin1"); i >= 0; i = b.indexOf("MSCF", i + 1, "latin1")) {
    // reserved1/2/3 必须为 0，且声明的长度不能超出文件——够把误报的字节串排掉。
    if (b.readUInt32LE(i + 4) !== 0 || b.readUInt32LE(i + 12) !== 0 || b.readUInt32LE(i + 20) !== 0) continue;
    const len = b.readUInt32LE(i + 8);
    if (len > 44 && i + len <= b.length) offs.push({ off: i, len });
  }
  return offs;
}

/** 解一个 CAB。want 给了就先看文件表，没有想要的就整个跳过（省下解压大块 folder 的时间）。 */
function cabExtract(b, off = 0, want = () => true) {
  const coffFiles = b.readUInt32LE(off + 16);
  const cFolders = b.readUInt16LE(off + 26), cFiles = b.readUInt16LE(off + 28);
  const flags = b.readUInt16LE(off + 30);
  let p = off + 36, cbCFFolder = 0, cbCFData = 0;
  if (flags & 4) { // cfhdrRESERVE_PRESENT：三个保留区长度，后面每个结构都要按它跳
    cbCFFolder = b[p + 2]; cbCFData = b[p + 3];
    p += 4 + b.readUInt16LE(p);
  }
  for (const f of [1, 2]) if (flags & f) { p = b.indexOf(0, p) + 1; p = b.indexOf(0, p) + 1; } // 前/后继 cab 名

  const folders = [];
  for (let i = 0; i < cFolders; i++) {
    folders.push({ start: off + b.readUInt32LE(p), n: b.readUInt16LE(p + 4), comp: b.readUInt16LE(p + 6) });
    p += 8 + cbCFFolder;
  }
  const files = [];
  for (let i = 0, q = off + coffFiles; i < cFiles; i++) {
    const end = b.indexOf(0, q + 16);
    files.push({ name: b.toString("latin1", q + 16, end), size: b.readUInt32LE(q), at: b.readUInt32LE(q + 4), folder: b.readUInt16LE(q + 8) });
    q = end + 1;
  }
  const hits = files.filter((f) => want(f.name));
  if (!hits.length) return new Map();

  const cache = new Map();
  const unfold = (i) => {
    if (cache.has(i)) return cache.get(i);
    const f = folders[i];
    if ((f.comp & 0x0f) !== 1) throw new Error(`CAB 用了 MSZIP 以外的压缩（typeCompress=${f.comp}）`);
    const parts = [];
    let d = f.start, dict = null;
    for (let k = 0; k < f.n; k++) {
      const cbData = b.readUInt16LE(d + 4), cbUncomp = b.readUInt16LE(d + 6);
      const s = d + 8 + cbCFData;
      if (b.toString("latin1", s, s + 2) !== "CK") throw new Error("MSZIP 块头不是 CK");
      // MSZIP：每块独立 raw deflate，但沿用前一块输出的末 32K 当预置字典
      const out = inflateRawSync(b.subarray(s + 2, s + cbData), dict ? { dictionary: dict } : {});
      if (out.length !== cbUncomp) throw new Error(`MSZIP 块解出 ${out.length} 字节，头里写的是 ${cbUncomp}`);
      parts.push(out);
      dict = (dict ? Buffer.concat([dict, out]) : out).subarray(-32768);
      d += 8 + cbCFData + cbData;
    }
    const buf = Buffer.concat(parts);
    cache.set(i, buf);
    return buf;
  };
  return new Map(hits.map((f) => [f.name, unfold(f.folder).subarray(f.at, f.at + f.size)]));
}

/* ------------------------------------------------------------------ PE 导入表 */

/** 读 PE 的导入表，返回它依赖的 DLL 名（原样大小写）。exe / dll / .node 都能读。 */
export function peImports(buf) {
  const b = Buffer.isBuffer(buf) ? buf : null;
  if (!b) throw new Error("peImports 要 Buffer");
  if (b.readUInt16LE(0) !== 0x5a4d) return []; // 不是 MZ，不是 PE
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) return [];
  const nSec = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20), opt = pe + 24;
  const impRva = b.readUInt32LE(opt + (b.readUInt16LE(opt) === 0x20b ? 112 : 96) + 8); // 数据目录 [1]
  if (!impRva) return [];
  const secs = [];
  for (let i = 0, s = opt + optSize; i < nSec; i++, s += 40) {
    secs.push({ va: b.readUInt32LE(s + 12), vs: b.readUInt32LE(s + 8), ptr: b.readUInt32LE(s + 20) });
  }
  const off = (rva) => {
    const s = secs.find((s) => rva >= s.va && rva < s.va + Math.max(s.vs, 1));
    return s ? rva - s.va + s.ptr : -1;
  };
  const out = [];
  for (let p = off(impRva); p > 0; p += 20) {
    const rva = b.readUInt32LE(p + 12);
    if (!rva) break;
    const q = off(rva);
    if (q < 0) break;
    out.push(b.toString("latin1", q, b.indexOf(0, q)));
  }
  return out;
}

/* ------------------------------------------------------------------ 取 CRT */

async function download(cpu) {
  const { pkg } = ARCH[cpu];
  const file = join(CACHE, `vc_redist.${pkg}.exe`);
  if (existsSync(file)) return readFile(file);
  const url = `https://aka.ms/vs/17/release/vc_redist.${pkg}.exe`;
  console.log(`下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 vc_redist.${pkg}.exe 失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, buf);
  console.log(`缓存到 ${file.replace(ROOT + "/", "")}（${Math.round(buf.length / (1 << 20))}M）`);
  return buf;
}

/** 该架构 vc_redist 里能提供的 CRT：Map<小写 dll 名, Buffer>。 */
export async function crtLibrary(cpu) {
  if (!ARCH[cpu]) throw new Error(`没有 ${cpu} 的 vc_redist`);
  const suffix = `_${ARCH[cpu].suffix}`;
  const exe = await download(cpu);
  // 外层是附在 PE 后面的 attached container（最大的那个 CAB；另一个小的是 Burn 的 UX 资源）
  const outer = cabOffsets(exe).sort((a, b) => b.len - a.len)[0];
  if (!outer) throw new Error("vc_redist 里没找到 CAB");
  const payload = cabExtract(exe, outer.off);
  // a0…aN 里有 MSI 也有 CAB，CRT 在其中几个 CAB 里，名字形如 msvcp140.dll_amd64
  const want = (n) => n.toLowerCase().endsWith(suffix) && CRT_PREFIX.test(n) && n.slice(0, -suffix.length).toLowerCase().endsWith(".dll");
  const lib = new Map();
  for (const part of payload.values()) {
    if (part.toString("latin1", 0, 4) !== "MSCF") continue;
    for (const [name, data] of cabExtract(part, 0, want)) {
      const dll = name.slice(0, -suffix.length).toLowerCase();
      if (!lib.has(dll)) lib.set(dll, data);
    }
  }
  if (!lib.size) throw new Error(`vc_redist.${ARCH[cpu].pkg}.exe 里没抽到 ${ARCH[cpu].suffix} 的 CRT`);
  return lib;
}

/** 从 needs 出发在 lib 里求依赖闭包（MSVCP140_1 还要 MSVCP140，MSVCP140 还要 VCRUNTIME140…）。 */
export function crtClosure(needs, lib) {
  const out = new Set();
  const queue = [...needs].map((n) => n.toLowerCase());
  while (queue.length) {
    const dll = queue.pop();
    if (out.has(dll) || !lib.has(dll)) continue;
    out.add(dll);
    for (const dep of peImports(lib.get(dll))) {
      const d = dep.toLowerCase();
      if (lib.has(d) && !out.has(d)) queue.push(d);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ CLI */

if (basename(process.argv[1] ?? "") === "vcredist.mjs") {
  const argv = process.argv.slice(2);
  const imp = argv.find((a) => a.startsWith("--imports="));
  if (imp) {
    const f = imp.slice(10);
    console.log(`${f}\n  ${peImports(await readFile(f)).join(" ")}`);
  } else {
    const cpu = argv.find((a) => !a.startsWith("--")) ?? "x64";
    const out = argv.find((a) => a.startsWith("--out="))?.slice(6);
    const lib = await crtLibrary(cpu);
    for (const [name, data] of [...lib].sort()) {
      console.log(`${name}\t${Math.round(data.length / 1024)}K\t→ ${peImports(data).filter((d) => CRT_PREFIX.test(d)).join(" ") || "（不依赖其他 CRT）"}`);
      if (out) { await mkdir(out, { recursive: true }); await writeFile(join(out, name), data); }
    }
    if (out) console.log(`已写入 ${out}`);
  }
}
