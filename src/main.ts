import "./styles.css";
import { MetaData } from "./smufl/smufl";
import { ensureFontsReady } from "./common/measure";
import { JpwFile } from "./jpword/jpwfile";
import { fromJpw } from "./score/jpwimport";
import { JinpuPainter } from "./layout/painter";

// Built-in sample (圣哉，圣哉，圣哉) — same content as CodeEditor.kt `scr`.
const SAMPLE = `// ************** JPW-ABC File Ver 1.0 (for JP-Word v5.50m) **************
.Title
Title = {圣哉，圣哉，圣哉}
KeyAndMeters = {1=D,4/4}
.Voice
1 1 3 3 |5- 5- |6- 6 6 |5- 3- |$(true)
5. 5_ 5 5 |1'- 7 5 |2 5 6. 5_ |5--- |$(true)
1 1 3 3 |5- 5- |6. 6_ 6 6 |5- 5- |$(true)
1'- 5 5 |6- 3- |4 2 2. 1_ |1--- |]$(true,0,0,true)
.Words
W1@1,1:
{1.[圣]}哉，圣哉，圣哉！全能大主宰！清晨欢悦歌咏高声颂主圣恩，圣哉，圣哉，圣哉！恩慈永无更改，荣耀与赞美，归三一真神。
`;

const PAGE_W = 960;
const PAGE_H = 540;

async function boot() {
  await ensureFontsReady([
    { family: "Bravura", size: 40 },
    { family: "PingFang SC", size: 28 },
  ]);
  const meta = await MetaData.load();

  const codePane = document.getElementById("code-pane")!;
  const pre = document.createElement("pre");
  pre.style.cssText = "margin:0;padding:8px;white-space:pre-wrap;font-size:13px";
  pre.textContent = SAMPLE;
  codePane.appendChild(pre);

  const scorePane = document.getElementById("score-pane")!;

  const f = JpwFile.fromString(SAMPLE);
  if (!f) {
    scorePane.textContent = "解析失败";
    return;
  }
  const score = fromJpw(f);
  if (!score) {
    scorePane.textContent = "导入失败";
    return;
  }

  const painter = new JinpuPainter(28);
  painter.layout.options.smuflMeta = meta;
  painter.score = score;
  painter.resize(PAGE_W, PAGE_H, null);

  for (let i = 0; i < painter.pageCount; i++) {
    const svg = painter.renderPage(i);
    svg.style.width = `${PAGE_W}px`;
    svg.style.maxWidth = "100%";
    scorePane.appendChild(svg);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  boot().catch((e) => {
    console.error(e);
    document.body.insertAdjacentHTML(
      "beforeend",
      `<pre style="color:red;white-space:pre-wrap">${String(e?.stack ?? e)}</pre>`,
    );
  });
});
