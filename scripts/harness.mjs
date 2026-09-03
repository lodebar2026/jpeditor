// 无头回归脚本的公共引导。22 个 .mjs 以前各自复制了一份「MIME 表 + serve dist/ + 起 Edge +
// 遍历 testdata 夹具 + 读 GT」，MIME 表一度有 5 个互不相同的版本（缺 .wasm/.onnx 就 404）。
// 这里只放引导，**断言逻辑留在各脚本里**——那才是每个脚本真正的内容。
//
// 用法：import { serveDist, launchPage, loadApp, findSongFixtures, imageArg } from "./harness.mjs";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

/** 静态资源 MIME。**唯一一张表**——加新资源类型只改这里。 */
export const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".txt": "text/plain",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ttc": "font/collection",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** 按扩展名取 MIME（大小写不敏感）。 */
export const mimeOf = (path) => MIME[extname(path).toLowerCase()] ?? "application/octet-stream";

/** serve 一个目录（默认 dist/），监听随机端口。返回 { server, port, close }。 */
export async function serveDist(root = "dist") {
  const ROOT = join(process.cwd(), root);
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
      if (p === "/") p = "/index.html";
      const data = await readFile(join(ROOT, normalize(p)));
      res.writeHead(200, { "content-type": mimeOf(p) });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((r) => server.listen(0, r));
  return { server, port: server.address().port, close: () => server.close() };
}

/** 起本地 Edge（免下载 chromium）并开一页。
 *  `errors` 收 console error + pageerror；`pageErrors` 只收 pageerror——
 *  用 page.setContent 另开干净页截图的脚本要用后者，否则那张空白页的资源 404 会算成失败。 */
export async function launchPage({ quiet = false, ...pageOptions } = {}) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage(Object.keys(pageOptions).length ? pageOptions : undefined);
  const errors = [];
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => {
    pageErrors.push(String(e));
    errors.push("pageerror: " + e.message);
    if (!quiet) console.log("  [pageerror]", String(e).slice(0, 160));
  });
  return { browser, page, errors, pageErrors, close: () => browser.close() };
}

/** 载入应用并等它稳定。批量脚本**每首之间都要重新 goto**——App/Score 在同一 page 里复用会串味。
 *  `reveal` 揭开开始页覆盖层（截谱面时需要）。 */
export async function loadApp(page, port, { wait = 800, reveal = false } = {}) {
  await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
  if (reveal) {
    await page.evaluate(() => {
      document.getElementById("app")?.classList.remove("is-starting");
      const ss = document.getElementById("start-screen");
      if (ss) ss.hidden = true;
    });
  }
  await page.waitForTimeout(wait);
}

const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif"]);

/** 遍历 testdata/ 每个歌谱文件夹，取第一张图片（没有图就取 PDF）+ 同目录的 .jpwabc GT。
 *  跳过 `pu` 文件夹（那是文本谱语料，不走 OMR）。filters 为曲名子串，空则全取。 */
export async function findSongFixtures(filters = [], { allowPdf = true } = {}) {
  const TESTDATA = join(process.cwd(), "testdata");
  const out = [];
  for (const d of await readdir(TESTDATA, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "pu") continue;
    if (filters.length && !filters.some((f) => d.name.includes(f))) continue;
    const dir = join(TESTDATA, d.name);
    const files = await readdir(dir);
    const img = files.find((f) => IMG_EXT.has(extname(f).toLowerCase()))
      ?? (allowPdf ? files.find((f) => extname(f).toLowerCase() === ".pdf") : undefined);
    if (!img) continue;
    const gt = files.find((f) => extname(f).toLowerCase() === ".jpwabc");
    out.push({
      name: d.name,
      img: join(dir, img),
      mime: mimeOf(img),
      gt: gt ? join(dir, gt) : null,
      dir,
    });
  }
  return out;
}

/** 图片文件 → page.evaluate 的入参 { b64, mime }。页面里用
 *  `Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))` 还原。 */
export async function imageArg(path) {
  return { b64: Buffer.from(await readFile(path)).toString("base64"), mime: mimeOf(path) };
}

/** .jpwabc 的 BOM 探测解码（src/editor/fileio.ts::decodeJpwabc 的 Node 版）。 */
export function decodeJpwabc(bytes) {
  const b = Uint8Array.from(bytes);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(b.subarray(2));
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(b.subarray(2));
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(b.subarray(3));
  }
  let zeroHigh = 0;
  const sample = Math.min(b.length, 200);
  for (let i = 1; i < sample; i += 2) if (b[i] === 0) zeroHigh++;
  if (sample > 0 && zeroHigh / (sample / 2) > 0.3) return new TextDecoder("utf-16le").decode(b);
  return new TextDecoder("utf-8").decode(b);
}

/** 读一份 .jpwabc GT。 */
export async function readJpwabc(path) {
  return decodeJpwabc(await readFile(path));
}
