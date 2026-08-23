// 矢量抽取的正确性核对：同一页，pdfjs 自己渲染的位图 ‖ 由 src/omr/vector.ts 抽出的对象重绘的 SVG，
// 逐像素比墨迹差。抽取漏了对象、算错 ctm、漏了 clip，这里都会立刻暴露。
//
//   npm run build:cli && node vector-shot.mjs 60            # 单页，出 /tmp 对照图
//   npm run build:cli && node vector-shot.mjs 40-80         # 页范围，只报数字
//   npm run build:cli && node vector-shot.mjs 60 --out=/tmp/v60
//
// 这是**唯一**要起浏览器的矢量脚本（需要 canvas 光栅化来做像素比对）；
// page-report.mjs / pdf-diff.mjs 都是纯 Node。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, dirname, basename } from "node:path";
import { mimeOf, launchPage } from "./scripts/harness.mjs";
import { CORPUS_PDF, parsePageRange, loadPdfjs } from "./scripts/node-harness.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const rangeSpec = args.find((a) => !a.startsWith("--")) ?? "60";
const pdfPath = flags.pdf ?? CORPUS_PDF;
const outBase = flags.out ?? "/tmp/vector-shot";
const scale = Number(flags.scale ?? 2);
const tol = Number(flags.tol ?? 0.03); // 允许的墨迹差比例（1%~2% 是 SVG 与 canvas 的抗锯齿差，非结构差）

// 同时 serve 项目根（/dist-cli、/node_modules）与语料 PDF（/corpus/…）
const PDF_DIR = dirname(pdfPath);
const PDF_NAME = basename(pdfPath);
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const root = p.startsWith("/corpus/") ? PDF_DIR : process.cwd();
    if (p.startsWith("/corpus/")) p = "/" + p.slice("/corpus/".length);
    const data = await readFile(join(root, normalize(p)));
    res.writeHead(200, { "content-type": mimeOf(p), "access-control-allow-origin": "*" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const { doc } = await (async () => {
  const pdfjs = await loadPdfjs();
  const bytes = new Uint8Array(await readFile(pdfPath));
  return { doc: await pdfjs.getDocument({ data: bytes }).promise };
})();
const pages = parsePageRange(rangeSpec, doc.numPages);
const single = pages.length === 1;

const { page, browser } = await launchPage({ quiet: true });
await page.goto(`http://127.0.0.1:${port}/index.html`).catch(() => {});
await page.setContent("<body style='margin:0'></body>");

const result = await page.evaluate(
  async ({ port, pdfName, pages, scale, single }) => {
    const base = `http://127.0.0.1:${port}`;
    const pdfjs = await import(`${base}/node_modules/pdfjs-dist/build/pdf.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${base}/node_modules/pdfjs-dist/build/pdf.worker.min.mjs`;
    const vec = await import(`${base}/dist-cli/index.js`);
    const doc = await pdfjs.getDocument({
      url: `${base}/corpus/${encodeURIComponent(pdfName)}`,
      wasmUrl: `${base}/node_modules/pdfjs-dist/wasm/`,
    }).promise;

    const ink = (d) => {
      // 墨迹掩码：非白即墨（阈值 200）
      const n = d.length / 4;
      const m = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const a = d[i * 4 + 3];
        const l = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
        m[i] = a > 16 && l < 200 ? 1 : 0;
      }
      return m;
    };
    const draw = (w, h) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.fillStyle = "#fff";
      x.fillRect(0, 0, w, h);
      return { c, x };
    };

    const rows = [];
    let shots = null;
    for (const pn of pages) {
      const p = await doc.getPage(pn);
      const vp = p.getViewport({ scale });
      const w = Math.ceil(vp.width);
      const h = Math.ceil(vp.height);

      // (1) pdfjs 自己渲染
      const A = draw(w, h);
      await p.render({ canvas: A.c, canvasContext: A.x, viewport: vp }).promise;

      // (2) 由抽出的矢量对象重绘
      const vpage = await vec.extractVectorPage(p, pdfjs.OPS, { scale });
      const paths = vpage.objs.map((o) => vec.objToSvg(o)).join("");
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<rect width="100%" height="100%" fill="#fff"/>${paths}</svg>`;
      const img = new Image();
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      await img.decode();
      const B = draw(w, h);
      B.x.drawImage(img, 0, 0);

      const ma = ink(A.x.getImageData(0, 0, w, h).data);
      const mb = ink(B.x.getImageData(0, 0, w, h).data);
      let inkA = 0;
      let inkB = 0;
      let xor = 0;
      let and = 0;
      for (let i = 0; i < ma.length; i++) {
        if (ma[i]) inkA++;
        if (mb[i]) inkB++;
        if (ma[i] !== mb[i]) xor++;
        else if (ma[i]) and++;
      }
      rows.push({
        page: pn,
        objs: vpage.objs.length,
        images: vpage.extras.images.length,
        shadings: vpage.extras.shadings.length,
        hasText: vpage.extras.hasText,
        inkA,
        inkB,
        xor,
        iou: inkA + inkB - and > 0 ? and / (inkA + inkB - and) : 1,
        diff: inkA > 0 ? xor / inkA : inkB > 0 ? 1 : 0,
      });

      if (single) {
        // 差异热图：红=原件有而重绘没有，蓝=重绘多出来的
        const D = draw(w, h);
        const id = D.x.getImageData(0, 0, w, h);
        for (let i = 0; i < ma.length; i++) {
          const o = i * 4;
          if (ma[i] && !mb[i]) {
            id.data[o] = 220;
            id.data[o + 1] = 0;
            id.data[o + 2] = 0;
          } else if (!ma[i] && mb[i]) {
            id.data[o] = 0;
            id.data[o + 1] = 80;
            id.data[o + 2] = 220;
          } else if (ma[i]) {
            id.data[o] = id.data[o + 1] = id.data[o + 2] = 190;
          }
        }
        D.x.putImageData(id, 0, 0);
        shots = { a: A.c.toDataURL("image/png"), b: B.c.toDataURL("image/png"), d: D.c.toDataURL("image/png") };
      }
      p.cleanup?.();
    }
    return { rows, shots };
  },
  { port, pdfName: PDF_NAME, pages, scale, single },
);

if (result.shots) {
  const { writeFile } = await import("node:fs/promises");
  for (const [k, name] of [
    ["a", "pdfjs"],
    ["b", "vector"],
    ["d", "diff"],
  ]) {
    const b64 = result.shots[k].split(",")[1];
    await writeFile(`${outBase}-${name}.png`, Buffer.from(b64, "base64"));
  }
  console.log(`图已写出：${outBase}-pdfjs.png / -vector.png / -diff.png（红=漏画，蓝=多画）`);
}

// 页面上除路径外还有内嵌位图 / 渐变 / 未转曲文字时，重绘必然对不齐——那不是抽取错，
// 是这一页本就有路径以外的内容（要在版面规格里另行记载）。单独归类，不混进纯路径页的口径。
const hasExtras = (r) => r.images > 0 || r.shadings > 0 || r.hasText;

let bad = 0;
console.log("页\t对象\t图\t渐变\t文字\t原墨\t重绘墨\t差异\tIoU");
for (const r of result.rows) {
  const ext = hasExtras(r);
  const ok = ext || r.diff <= tol;
  if (!ok) bad++;
  console.log(
    [
      r.page,
      r.objs,
      r.images,
      r.shadings,
      r.hasText ? "有" : "-",
      r.inkA,
      r.inkB,
      (r.diff * 100).toFixed(2) + "%",
      (r.iou * 100).toFixed(2) + "%",
      ext ? "· 含非路径内容" : ok ? "" : "← 超差",
    ].join("\t"),
  );
}
const pure = result.rows.filter((r) => !hasExtras(r));
const ext = result.rows.filter(hasExtras);
const avg = pure.reduce((a, r) => a + r.diff, 0) / Math.max(1, pure.length);
console.log(
  `\n纯路径页 ${pure.length} 页，平均差异 ${(avg * 100).toFixed(2)}%，超差(>${(tol * 100).toFixed(0)}%) ${bad} 页` +
    (ext.length ? `；另有 ${ext.length} 页含非路径内容（位图/渐变/未转曲文字），已单列：${ext.map((r) => r.page).join(",")}` : ""),
);

await browser.close();
server.close();
process.exit(bad ? 1 : 0);
