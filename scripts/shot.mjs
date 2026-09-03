// Headless render/interaction check: serve dist/, load in Edge, optionally edit,
// screenshot, and dump diagnostics.
// Usage: node shot.mjs [outPng] [--edit] [--xml <path>]
//   --xml <path>   render MusicXML via MixedPainter instead of normal JP score
import { readFile } from "node:fs/promises";
import { serveDist, launchPage, loadApp } from "./harness.mjs";

const { port, close: closeServer } = await serveDist();
const { browser, page, errors } = await launchPage({ viewport: { width: 1280, height: 900 }, quiet: true });
// 新 UI 启动进开始页（#start-screen 覆盖层），揭开工作区以便截到谱面。
await loadApp(page, port, { reveal: true });

// --xml mode: render MusicXML via MixedPainter
const xmlArgIdx = process.argv.indexOf("--xml");
const xmlPath = xmlArgIdx !== -1 ? process.argv[xmlArgIdx + 1] : null;

if (xmlPath) {
  const xmlText = await readFile(xmlPath, "utf-8");
  const result = await page.evaluate(async (xml) => {
    const mp = window.__mixedPainter;
    await mp.load(xml);
    const pane = document.getElementById("score-pane");
    pane.innerHTML = "";
    // clear CodeMirror pane to give more room
    const codePane = document.getElementById("code-pane");
    if (codePane) codePane.style.display = "none";
    pane.style.width = "100%";

    for (let i = 0; i < mp.pageCount; i++) {
      const svg = mp.renderPage(i);
      svg.style.width = "800px";
      svg.style.display = "block";
      svg.style.marginBottom = "8px";
      pane.appendChild(svg);
    }
    return {
      pages: mp.pageCount,
      pageWidthPt: mp.pageWidthPt,
      pageHeightPt: mp.pageHeightPt,
    };
  }, xmlText);
  console.log("mixed render:", JSON.stringify(result, null, 2));
  if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.filter(e => !/favicon/.test(e) && !/favicon\.ico/.test(e)).join("\n"));
  const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "/tmp/mixed-shot.png";
  await page.screenshot({ path: out, fullPage: true });
  console.log("screenshot:", out);
} else {
  const doEdit = process.argv.includes("--edit");
  if (doEdit) {
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
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
  if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.filter(e => !/favicon/.test(e) && !/favicon\.ico/.test(e)).join("\n"));
  const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "/tmp/jpeditor-shot.png";
  await page.screenshot({ path: out, fullPage: false });
  console.log("screenshot:", out);
}
await browser.close();
closeServer();
