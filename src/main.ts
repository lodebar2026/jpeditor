import "./styles.css";
import { MetaData } from "./smufl/smufl";
import { ensureFontsReady } from "./common/measure";
import { App } from "./editor/app";
import { showLayoutDialog, showOptionsDialog } from "./editor/dialogs";
import { showExportDialog } from "./editor/export";
import { isTauriRuntime } from "./editor/fileio";

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
W2@1,1:
{2.[圣]}哉，圣哉，圣哉！群圣虔拜俯，各以华丽金冠奉呈宝座之前，千万天军、天使，虔敬崇拜上主，昔在而今在，永在亿万年。
W3@1,1:
{3.[圣]}哉，圣哉，圣哉！主藏黑云里，罪人焉得瞻望真主威赫荣光，耶和华惟圣哉，谁与上主堪比，权能至完备，大哉天地王。
W4@1,1:
{4.[圣]}哉，圣哉，圣哉！全能大主宰！天上地下海中万物颂主尊称，圣哉，圣哉，圣哉！恩慈永无更改，荣耀与赞美，归三一真神。
`;

async function boot() {
  await ensureFontsReady([
    { family: "Bravura", size: 40 },
    { family: "PingFang SC", size: 28 },
  ]);
  const meta = await MetaData.load();

  const codePane = document.getElementById("code-pane")!;
  const scorePane = document.getElementById("score-pane")!;

  const app = new App(meta, scorePane);
  app.mountEditor(codePane, SAMPLE);
  (window as unknown as { __app: App }).__app = app; // dev/test handle

  // toolbar
  const on = (id: string, fn: () => void) =>
    document.getElementById(id)?.addEventListener("click", fn);
  on("btn-save", () => void app.saveFile());
  on("btn-saveas", () => void app.saveFileAs());
  on("btn-prev", () => app.prevPage());
  on("btn-next", () => app.nextPage());
  on("btn-lines", () => showLayoutDialog(app));
  on("btn-options", () => showOptionsDialog(app));
  on("btn-export", () => showExportDialog(app));
  // export/play/stop wired in later phases
  const addOpen = document.getElementById("btn-open");
  addOpen?.addEventListener("click", () => void app.openFile());

  // paging keys
  window.addEventListener("keydown", (e) => {
    if (e.key === "PageDown") app.nextPage();
    else if (e.key === "PageUp") app.prevPage();
    else if (e.key === "Home" && e.ctrlKey) app.goToPage(0);
    else if (e.key === "End" && e.ctrlKey) app.goToPage(1e9);
  });

  await wireDragDrop(app, scorePane);
}

async function wireDragDrop(app: App, dropTarget: HTMLElement): Promise<void> {
  if (isTauriRuntime()) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    await getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === "drop") {
        const path = event.payload.paths[0];
        if (!path || !/\.(jpwabc|xml|musicxml)$/i.test(path)) return;
        const bytes = await readFile(path);
        app.importBytes(bytes, path);
      }
    });
  } else {
    dropTarget.addEventListener("dragover", (e) => e.preventDefault());
    dropTarget.addEventListener("drop", async (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const buf = new Uint8Array(await file.arrayBuffer());
      app.importBytes(buf, file.name);
    });
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
