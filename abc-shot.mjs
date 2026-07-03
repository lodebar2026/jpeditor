// Headless end-to-end: serve dist/, load in Edge, import an .abc via window.__app, screenshot #score-pane.
// Usage: node abc-shot.mjs <abc-path> [outPng]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const MIME = { ".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".woff2":"font/woff2",".svg":"image/svg+xml",".wasm":"application/wasm",".mjs":"text/javascript" };
const server = createServer(async (req, res) => {
  try { let p = decodeURIComponent((req.url ?? "/").split("?")[0]); if (p === "/") p = "/index.html";
    const data = await readFile(join(ROOT, normalize(p)));
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" }); res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const abcPath = process.argv[2];
const out = process.argv[3] || "/tmp/abc-shot.png";
const abcText = await readFile(abcPath, "utf-8");

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

const result = await page.evaluate((abc) => {
  const app = window.__app;
  const bytes = new TextEncoder().encode(abc);
  app.importBytes(bytes, "test.abc");
  const pane = document.getElementById("score-pane");
  const svgs = pane ? pane.querySelectorAll("svg") : [];
  return {
    title: app.painter?.score?.title ?? null,
    parts: app.painter?.score?.parts?.length ?? null,
    measures: app.painter?.score?.parts?.[0]?.measures?.length ?? null,
    pageSvgs: svgs.length,
    textLen: (app.getText?.() || "").length,
    status: document.getElementById("status")?.textContent ?? null,
  };
}, abcText);
console.log("result:", JSON.stringify(result, null, 2));
if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.filter(e=>!/favicon/.test(e)).join("\n"));
await page.waitForTimeout(300);
await page.screenshot({ path: out, fullPage: true });
console.log("screenshot:", out);
await browser.close();
server.close();
