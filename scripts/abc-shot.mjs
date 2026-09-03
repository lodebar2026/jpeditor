// Headless end-to-end: serve dist/, load in Edge, import an .abc via window.__app, screenshot #score-pane.
// Usage: node abc-shot.mjs <abc-path> [outPng]
import { readFile } from "node:fs/promises";
import { serveDist, launchPage, loadApp } from "./harness.mjs";

const { port, close: closeServer } = await serveDist();
const abcPath = process.argv[2];
const out = process.argv[3] || "/tmp/abc-shot.png";
const abcText = await readFile(abcPath, "utf-8");

const { browser, page, errors } = await launchPage({ viewport: { width: 1280, height: 900 }, quiet: true });
await loadApp(page, port);

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
closeServer();
