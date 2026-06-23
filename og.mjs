// Generate public/og-image.png (1200×630 social preview) from the live app.
// Serves dist/, renders the sample score, composes a branded 1200×630 card, screenshots it.
// Usage: node og.mjs            (uses built-in sample score)
//        node og.mjs --xml a.musicxml   (render a mixed MusicXML score instead)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
  ".otf": "font/otf",
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const data = await readFile(join(ROOT, normalize(p)));
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

const xmlIdx = process.argv.indexOf("--xml");
const xmlPath = xmlIdx !== -1 ? process.argv[xmlIdx + 1] : null;
const xmlText = xmlPath ? await readFile(xmlPath, "utf-8") : null;

await page.evaluate(async (xml) => {
  // Grab a rendered score SVG (mixed if xml given, else the normal sample page).
  let svg;
  if (xml) {
    const mp = window.__mixedPainter;
    await mp.load(xml);
    svg = mp.renderPage(0);
  } else {
    // First page after the title-only page (has actual notation rows).
    const svgs = [...document.querySelectorAll("#score-pane svg")];
    svg = svgs[1] ?? svgs[0];
  }
  const svgHtml = svg ? svg.outerHTML : "";

  const card = document.createElement("div");
  card.id = "og-card";
  card.innerHTML = `
    <div style="height:630px;width:1200px;box-sizing:border-box;background:
        linear-gradient(135deg,#ffffff 0%,#eef3fb 100%);display:flex;flex-direction:column;
        font-family:'PingFang SC','Microsoft YaHei',sans-serif;overflow:hidden">
      <div style="padding:40px 56px 12px;display:flex;align-items:center;gap:20px">
        <div style="width:64px;height:64px;border-radius:14px;background:#2b6cb0;color:#fff;
            display:flex;align-items:center;justify-content:center;font:700 40px Georgia,serif;
            position:relative">1<span style="position:absolute;bottom:13px;width:26px;height:4px;
            border-radius:2px;background:#fff"></span></div>
        <div>
          <div style="font-size:46px;font-weight:800;color:#1a202c;line-height:1.1">简谱编辑器 jpeditor</div>
          <div style="font-size:23px;color:#4a5568;margin-top:6px">在线简谱排版与编辑 · 简谱·五线谱混排 · MusicXML 导入 · 导出 PDF/PNG/MIDI/PPTX</div>
        </div>
      </div>
      <div style="flex:1;margin:20px 56px 44px;background:#fff;border:1px solid #d6e0ef;
          border-radius:14px;box-shadow:0 8px 30px rgba(43,108,176,.12);overflow:hidden;
          display:flex;align-items:center;justify-content:center;padding:20px">
        <div id="og-score" style="width:1040px;height:386px;overflow:hidden;display:flex;
            align-items:center;justify-content:center">${svgHtml}</div>
      </div>
    </div>`;
  document.body.innerHTML = "";
  document.body.style.margin = "0";
  document.body.appendChild(card);

  const inner = document.querySelector("#og-score svg");
  if (inner) {
    inner.style.flex = "none";
    const r = inner.getBoundingClientRect();
    const s = Math.min(1040 / r.width, 386 / r.height); // fit within the clipping holder
    inner.style.transformOrigin = "center";
    inner.style.transform = `scale(${s})`;
  }
}, xmlText);

await page.waitForTimeout(300);
await page.locator("#og-card > div").screenshot({ path: "public/og-image.png" });
console.log("wrote public/og-image.png (1200×630 @2x)");
await browser.close();
server.close();
