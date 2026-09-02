// 五线谱识别的**端到端**检查：起 Edge → 把一页 PDF 喂给编辑器的识别入口 →
// 看它有没有识别出来、有没有进混排视图、有没有铺出页。
//
//   npm run build && node staff-ui-check.mjs [页号]
//
// 与 staff-diff.mjs 的分工：那份量识别**准确率**（纯 Node），这份验**接线**
// （拖进来的 PDF 走没走对那条路、产物落没落到混排）。改 omrctl / app 的接线后跑它。
import { serveDist, launchPage, loadApp } from "./scripts/harness.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { ZMZQ_PDF } from "./scripts/node-harness.mjs";

const pageNo = Number(process.argv[2] ?? 154);
const SHOT = process.argv.find((a) => a.startsWith("--shot="))?.slice(7) ?? "/tmp/staff-ui.png";

// 整本 30MB 喂进浏览器太慢，先切出单页
const { PDFDocument } = await import("pdf-lib");
const src = await PDFDocument.load(await readFile(ZMZQ_PDF), { ignoreEncryption: true });
const one = await PDFDocument.create();
one.addPage((await one.copyPages(src, [pageNo - 1]))[0]);
const onePdf = "/tmp/staff-ui-one.pdf";
await writeFile(onePdf, await one.save());

const { server, port } = await serveDist();
const { browser, page } = await launchPage({ quiet: true });
const errs = [];
page.on("console", (m) => {
  // 「五线谱 → 简谱文本转换失败」是**预期**的告警（五线谱装不进 .jpwabc），不算错
  if (m.type() === "error") errs.push(m.text());
});
await loadApp(page, port, { reveal: true });

const bytes = [...new Uint8Array(await readFile(onePdf))];
const out = await page.evaluate(async (b) => {
  const app = window.__app;
  const ok = await app.omr.recognizeBytes({ bytes: new Uint8Array(b), mime: "application/pdf" });
  return {
    ok,
    mode: app.mode,
    xmlLen: app.mixedXmlText?.length ?? 0,
    pages: document.querySelectorAll("#score-pane svg").length,
    status: document.querySelector("#status")?.textContent ?? "",
  };
}, bytes);
await page.waitForTimeout(1500);
await page.screenshot({ path: SHOT });
await browser.close();
server.close();

console.log(`p${pageNo}：识别 ${out.ok ? "成功" : "失败"}，模式 ${out.mode}，混排 XML ${out.xmlLen} 字节，铺出 ${out.pages} 页`);
console.log("状态栏：" + out.status);
console.log("截图 →", SHOT);

const bad = [];
if (!out.ok) bad.push("recognizeBytes 返回 false");
if (out.mode !== "mixed") bad.push(`模式是 ${out.mode}，应为 mixed`);
if (out.xmlLen < 1000) bad.push(`混排 XML 只有 ${out.xmlLen} 字节`);
if (!out.pages) bad.push("一页都没铺出来");
if (errs.length) bad.push(`控制台报错 ${errs.length} 条：${errs[0].slice(0, 120)}`);
if (bad.length) {
  console.log("✗ " + bad.join("；"));
  process.exitCode = 1;
} else console.log("✓ 接线正常");
