// 生成/刷新和弦 GT 底稿：跑一遍真实 OMR，把番茄文本谱原文写成 testdata/<曲名>/gt.tomato.pu。
// .jpwabc 装不下和弦，故另置这份载体；measure-all.mjs 的「和弦」档比对它里面的 `"hx:X"` 序列。
// **产出的是底稿，必须对着原图人工核对和弦再当 GT 用**——识别错的地方要手工改对，否则等于拿
// 识别结果给自己打分。用法：npm run build && node gen-pu-gt.mjs [曲名子串...]（需本地 Edge）
import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { serveDist, launchPage, loadApp, mimeOf } from "./harness.mjs";

const TESTDATA = join(process.cwd(), "testdata");
const filters = process.argv.slice(2);

const { port, close: closeServer } = await serveDist();

const songs = [];
for (const d of await readdir(TESTDATA, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name === "pu") continue;   // pu 是文本谱渲染夹具，不是识别用的歌谱
  const files = await readdir(join(TESTDATA, d.name));
  const img = files.find((f) => /\.(jpg|jpeg|png|bmp|webp)$/i.test(f)) ?? files.find((f) => /\.pdf$/i.test(f));
  if (!img) continue;
  if (filters.length && !filters.some((f) => d.name.includes(f))) continue;
  songs.push({ name: d.name, img: join(TESTDATA, d.name, img) });
}
songs.sort((a, b) => a.name.localeCompare(b.name, "zh"));

const { browser, page } = await launchPage({ viewport: { width: 1280, height: 900 } });
for (const song of songs) {
  // 每首重载页面：App/Score 在同一 page 里复用会串味（同 measure-all.mjs）。
  await loadApp(page, port);
  const b64 = Buffer.from(await readFile(song.img)).toString("base64");
  const mime = mimeOf(song.img);
  const text = await page.evaluate(async ({ b64, mime }) => {
    const omr = await window.__omr;
    const bin = await omr.decodeToBinary(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), mime);
    return omr.toPuText(await omr.recognizeJianpu(bin, omr.paddleOcrBackend()), "tomato").text;
  }, { b64, mime });
  const out = join(TESTDATA, song.name, "gt.tomato.pu");
  await writeFile(out, text, "utf8");
  const n = (text.match(/"hx:/g) ?? []).length;
  console.log(`${song.name}: ${text.split("\n").length} 行，${n} 个和弦 → ${out}`);
}
await browser.close();
closeServer();
