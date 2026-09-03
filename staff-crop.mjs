// 赞美之泉底本的**局部截图**：按识别用的设备坐标（scale=1、y 向下）裁一块渲染出来，
// 排查「这里到底印的是什么」时用。识别侧的坐标（谱行 box、音符 x/py）可以直接抄进来。
//
//   node staff-crop.mjs 110 40,360,580,400 /tmp/a.png        # 页 x0,y0,x1,y1 输出
//   node staff-crop.mjs 110 40,360,580,400 /tmp/a.png --scale=6 --mark=307,376
//
// 起浏览器（Edge）只为光栅化——与 vector-shot.mjs 同一套引导。
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, basename, join, normalize } from "node:path";
import { mimeOf, launchPage } from "./scripts/harness.mjs";
import { ZMZQ_PDF } from "./scripts/node-harness.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const pos = args.filter((a) => !a.startsWith("--"));
const pn = Number(pos[0] ?? 1);
const [x0, y0, x1, y1] = (pos[1] ?? "0,0,612,792").split(",").map(Number);
const out = pos[2] ?? "/tmp/staff-crop.png";
const scale = Number(flags.scale ?? 4);
const marks = (flags.mark ?? "").split(";").filter(Boolean).map((m) => m.split(",").map(Number));

const PDF_DIR = dirname(ZMZQ_PDF), PDF_NAME = basename(ZMZQ_PDF);
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const root = p.startsWith("/corpus/") ? PDF_DIR : process.cwd();
    if (p.startsWith("/corpus/")) p = "/" + p.slice(8);
    const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": mimeOf(file) });
    res.end(body);
  } catch {
    res.writeHead(404).end("nope");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const { page, browser } = await launchPage({ quiet: true });
await page.goto(`http://127.0.0.1:${port}/index.html`).catch(() => {});
await page.setContent("<body style='margin:0;background:#fff'></body>");
const dataUrl = await page.evaluate(
  async ({ port, pdfName, pn, x0, y0, x1, y1, scale, marks }) => {
    const base = `http://127.0.0.1:${port}`;
    const pdfjs = await import(`${base}/node_modules/pdfjs-dist/build/pdf.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${base}/node_modules/pdfjs-dist/build/pdf.worker.min.mjs`;
    const doc = await pdfjs.getDocument({
      url: `${base}/corpus/${encodeURIComponent(pdfName)}`,
      wasmUrl: `${base}/node_modules/pdfjs-dist/wasm/`,
    }).promise;
    const p = await doc.getPage(pn);
    const vp = p.getViewport({ scale });
    const full = document.createElement("canvas");
    full.width = Math.ceil(vp.width);
    full.height = Math.ceil(vp.height);
    const fx = full.getContext("2d");
    fx.fillStyle = "#fff";
    fx.fillRect(0, 0, full.width, full.height);
    await p.render({ canvas: full, canvasContext: fx, viewport: vp }).promise;
    // 裁剪（输入坐标是 scale=1 的设备坐标）
    const c = document.createElement("canvas");
    c.width = Math.round((x1 - x0) * scale);
    c.height = Math.round((y1 - y0) * scale);
    const x = c.getContext("2d");
    x.fillStyle = "#fff";
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(full, Math.round(x0 * scale), Math.round(y0 * scale), c.width, c.height, 0, 0, c.width, c.height);
    x.strokeStyle = "#e00";
    x.lineWidth = Math.max(1, scale / 3);
    for (const [mx, my] of marks) x.strokeRect((mx - x0) * scale - 6 * scale, (my - y0) * scale - 6 * scale, 12 * scale, 12 * scale);
    return c.toDataURL("image/png");
  },
  { port, pdfName: PDF_NAME, pn, x0, y0, x1, y1, scale, marks },
);
await writeFile(out, Buffer.from(dataUrl.split(",")[1], "base64"));
console.log(`p${pn} [${x0},${y0}]-[${x1},${y1}] ×${scale} → ${out}`);
await browser.close();
server.close();
