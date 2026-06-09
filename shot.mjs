// Headless render/interaction check: serve dist/, load in Edge, optionally edit,
// screenshot, and dump diagnostics. Usage: node shot.mjs [outPng] [--edit]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const data = await readFile(join(ROOT, normalize(p)));
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

const doEdit = process.argv.includes("--edit");
if (doEdit) {
  // append a new voice measure to verify live relayout
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  // place caret at end of the 4th voice line is complex; instead change title
  await page.evaluate(() => {
    // simulate typing into CodeMirror via its API is hard; dispatch input on content
  });
}

const before = await page.evaluate(() => {
  const pane = document.getElementById("score-pane");
  const svgs = pane.querySelectorAll("svg");
  const cm = document.querySelector(".cm-content");
  const colored = document.querySelectorAll(
    ".cm-content .note, .cm-content .barline, .cm-content .break, .cm-content .lrc, .cm-content .section, .cm-content .metakey",
  );
  return {
    pages: svgs.length,
    editorPresent: !!cm,
    coloredTokens: colored.length,
    sampleClasses: [...colored].slice(0, 6).map((e) => e.className),
  };
});
console.log(JSON.stringify(before, null, 2));
if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.filter(e=>!/favicon/.test(e)).join("\n"));

const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "/tmp/jpeditor-shot.png";
await page.screenshot({ path: out, fullPage: false });
console.log("screenshot:", out);
await browser.close();
server.close();
