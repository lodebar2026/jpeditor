// 字体资源：把 BookStyle 里的字体引用变成一份 sfnt 字节。
//
// 两个消费方必须拿到**同一份字节**，度量才一致：
//   - scripts/pdfwrite.mjs   embedFont 子集嵌入
//   - 浏览器侧 registerBookFonts 的 FontFace（B 路排版就是按它测的字宽）
//
// .ttc 走现成的 scripts/ttc.mjs::extractTtc（opentype/fontkit 都不吃 ttc 容器）。
// 只给了 family 没给 file 时按名在系统字体目录里找一次并缓存——
// macOS 的中文字体大多散在 /System/Library/AssetsV2/** 下，路径带哈希、随系统更新会变。
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractTtc } from "./ttc.mjs";

const run = promisify(execFile);

const FONT_DIRS = [
  "/System/Library/Fonts",
  "/System/Library/Fonts/Supplemental",
  "/Library/Fonts",
  `${process.env.HOME}/Library/Fonts`,
  "/System/Library/AssetsV2",
];

const bytesCache = new Map(); // "file#face" → Uint8Array
const pathCache = new Map(); // family → path | null

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 按 family 找字体文件。关键词按「去空格全名 → 首个词」的顺序试
 *  （"Weibei SC" → WeibeiSC 命中 WeibeiSC-Bold.otf；"PingFang SC" → PingFang 才命中 PingFang.ttc）。 */
export async function findFontFile(family) {
  if (pathCache.has(family)) return pathCache.get(family);
  const keys = [family.replace(/\s+/g, ""), family.split(/\s+/)[0]].filter((k, i, a) => k && a.indexOf(k) === i);
  let found = null;
  outer: for (const key of keys) {
    for (const dir of FONT_DIRS) {
      if (!(await exists(dir))) continue;
      // AssetsV2 底下有若干目录不可读，find 会打 stderr 并以非零码退出，
      // 但已经找到的结果仍在 stdout 里——所以出错也要把 stdout 拿来用。
      let stdout = "";
      try {
        ({ stdout } = await run("find", [dir, "-iname", `*${key}*`, "-type", "f"], { maxBuffer: 1 << 24 }));
      } catch (e) {
        stdout = e?.stdout ?? "";
      }
      const hit = stdout
        .split("\n")
        .filter((l) => /\.(otf|ttf|ttc)$/i.test(l))
        .sort((a, b) => a.length - b.length)[0];
      if (hit) {
        found = hit;
        break outer;
      }
    }
  }
  pathCache.set(family, found);
  return found;
}

/** FontRef → { bytes, path, face }。找不到时返回 null（调用方决定是报错还是退到替代字体）。 */
export async function resolveFont(ref) {
  const face = ref.face ?? null;
  let file = ref.file ?? null;
  if (file && !(await exists(file))) file = null;
  if (!file) file = await findFontFile(ref.family);
  if (!file) return null;
  const key = `${file}#${face ?? ""}`;
  if (!bytesCache.has(key)) {
    const bytes = /\.ttc$/i.test(file)
      ? await extractTtc(file, face ?? 0)
      : new Uint8Array(await readFile(file));
    bytesCache.set(key, bytes);
  }
  return { bytes: bytesCache.get(key), path: file, face, key };
}

/** BookStyle.fonts → { id: {bytes, path, face, key} }；解析不到的列进 missing。 */
export async function resolveBookFonts(style) {
  const out = {};
  const missing = [];
  for (const [id, ref] of Object.entries(style.fonts)) {
    const got = await resolveFont(ref);
    if (got) out[id] = { ...got, family: ref.family, bold: !!ref.bold };
    else missing.push({ id, ...ref });
  }
  return { fonts: out, missing };
}
