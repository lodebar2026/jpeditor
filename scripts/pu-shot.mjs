// 文本谱渲染核对：把夹具排版后截图，人眼对照原版。
//
// 用法：npm run build && node pu-shot.mjs [曲名子串] [--slide]
// 输出 /tmp/pu-<曲名>-p<页>.png，并打印页数与控制台错误。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { serveDist, launchPage, loadApp } from "./harness.mjs";


const args = process.argv.slice(2);
const slide = args.includes("--slide");
const filter = args.find((a) => !a.startsWith("--")) ?? "";
const DIR = "testdata/pu";
const files = readdirSync(DIR).filter((f) => /\.(pu|jps|txt)$/i.test(f) && f.includes(filter));
if (files.length === 0) {
  console.error(`testdata/pu 下没有匹配 "${filter}" 的夹具`);
  process.exit(1);
}

const { port, close: closeServer } = await serveDist();
const { browser, page, pageErrors: errors } = await launchPage({ viewport: { width: 1200, height: 1000 }, quiet: true });
await loadApp(page, port);

for (const file of files) {
  const name = file.replace(/\.[^.]+$/, "");
  const source = readFileSync(join(DIR, file), "utf8");
  const info = await page.evaluate(
    async ([src, useSlide]) => {
      const pu = await window.__pu;
      const doc = pu.parsePu(src);
      const painter = new pu.PuPainter(useSlide ? "slide" : "print");
      painter.load(doc);
      const svgs = [];
      for (let i = 0; i < painter.pageCount; i++) {
        const svg = painter.renderPage(i);
        svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        svg.setAttribute("width", String(painter.pageWidth));
        svg.setAttribute("height", String(painter.pageHeight));
        svgs.push(new XMLSerializer().serializeToString(svg));
      }
      return {
        dialect: doc.dialect,
        songs: doc.songs.length,
        pages: painter.pageCount,
        notes: painter.playbackNotes().length,
        xs: (painter.placedPages?.() ?? []).map((pg) =>
          pg.groups.flatMap((g) => g.voices.map((v) => v.items.map((it) => +(83 + it.x).toFixed(1)))),
        ),
        diagnostics: doc.diagnostics.map((d) => `${d.code}@${d.source.line + 1}`),
        w: painter.pageWidth,
        h: painter.pageHeight,
        svgs,
      };
    },
    [source, slide],
  );

  // 换到干净页面截图，免得应用自身的样式干扰
  for (const [i, svg] of info.svgs.entries()) {
    await page.setContent(
      `<body style="margin:0;background:#fff">${svg}</body>`,
      { waitUntil: "load" },
    );
    await page.setViewportSize({ width: Math.ceil(info.w), height: Math.ceil(info.h) });
    await page.screenshot({ path: `/tmp/pu-${name}${slide ? "-slide" : ""}-p${i + 1}.png` });
  }
  await loadApp(page, port);

  console.log(
    `${name}: ${info.dialect} ${info.songs}首 ${info.pages}页 ${info.notes}音符 ${info.w}×${info.h}` +
      (info.diagnostics.length ? `  诊断 ${info.diagnostics.join(",")}` : ""),
  );
  if (args.includes("--geo")) {
    info.xs.forEach((pg, pi) =>
      pg.forEach((line, li) => console.log(`   p${pi + 1} 行${li + 1} x: ${line.join(" ")}`)),
    );
  }
}

if (errors.length) {
  console.log("控制台错误：");
  for (const e of errors.slice(0, 5)) console.log("  " + e);
}
await browser.close();
closeServer();
process.exit(errors.length ? 1 : 0);
