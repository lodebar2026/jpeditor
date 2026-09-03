// 识别模式无头校验：serve dist/，加载后用 window.__app.omr.recognizeBytes 跑真实 OMR，
// 验证自动进入识别模式、二值图 image + 叠加层渲染，截图。
// 用法: node shot-recog.mjs [outPng] [imgPath]
import { readFile } from "node:fs/promises";
import { serveDist, launchPage, loadApp } from "./harness.mjs";

const { port, close: closeServer } = await serveDist();

const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "/tmp/recog-shot.png";
const img = process.argv[3] || "testdata/日光之下/日光之下简谱.jpg";
const imgBytes = [...await readFile(img)];

const { browser, page, errors } = await launchPage({ viewport: { width: 1280, height: 1000 }, quiet: true });
await loadApp(page, port);

const result = await page.evaluate(async (bytes) => {
  const app = window.__app;
  await app.omr.recognizeBytes({ bytes: new Uint8Array(bytes), mime: "image/jpeg" });
  // 新 UI 直调 omr.recognizeBytes 不会揭开开始页覆盖层，这里手动揭开以便截到核对视图。
  document.getElementById("app")?.classList.remove("is-starting");
  const ss = document.getElementById("start-screen");
  if (ss) ss.hidden = true;
  const pane = document.getElementById("score-pane");
  const svg = pane.querySelector("svg.omr-recognize");
  return {
    mode: app.mode,
    bodyHasRecognize: document.getElementById("body").classList.contains("recognize"),
    recognizeBtnDisabled: document.getElementById("btn-recognize").disabled,
    recognizeBtnText: document.getElementById("btn-recognize").textContent,
    overlaySvgPresent: !!svg,
    viewBox: svg?.getAttribute("viewBox"),
    bgImage: !!svg?.querySelector("image"),
    overlayTexts: svg?.querySelectorAll(".omr-overlay text").length ?? 0,
    overlayBarlines: svg?.querySelectorAll(".omr-overlay .omr-barline").length ?? 0,
    overlayMarks: svg?.querySelectorAll(".omr-overlay .omr-mark").length ?? 0,
    editorPresent: !!document.querySelector(".cm-content"),
  };
}, imgBytes);
console.log(JSON.stringify(result, null, 2));
if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.filter(e => !/favicon/.test(e)).join("\n"));
await page.screenshot({ path: out, fullPage: false });
console.log("screenshot:", out);
await browser.close();
closeServer();
