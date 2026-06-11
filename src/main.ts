import "./styles.css";
import { MetaData } from "./smufl/smufl";
import { ensureFontsReady } from "./common/measure";
import { App } from "./editor/app";
import { showLayoutDialog, showOptionsDialog } from "./editor/dialogs";
import { showExportDialog } from "./editor/export";
import { isTauriRuntime } from "./editor/fileio";
import { MixedPainter } from "./mixed/painter";

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
  app.loadSettings();
  app.mountEditor(codePane, SAMPLE);
  const win = window as unknown as { __app: App; __mixedPainter: MixedPainter };
  win.__app = app;
  win.__mixedPainter = new MixedPainter();

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
  const mixedBtn = document.getElementById("btn-mixed") as HTMLButtonElement | null;
  if (mixedBtn) {
    app.setMixedBtn(mixedBtn);
    mixedBtn.addEventListener("click", () => void app.toggleMixed());
  }
  // export/play/stop wired in later phases
  const addOpen = document.getElementById("btn-open");
  addOpen?.addEventListener("click", () => void app.openFile());

  // zoom controls
  const zoomLabel = document.getElementById("btn-zoom-reset");
  const updateZoom = () => {
    if (zoomLabel) zoomLabel.textContent = `${Math.round(app.zoom * 100)}%`;
  };
  on("btn-zoom-in", () => { app.zoomBy(1.2); updateZoom(); });
  on("btn-zoom-out", () => { app.zoomBy(1 / 1.2); updateZoom(); });
  on("btn-zoom-reset", () => { app.resetZoom(); updateZoom(); });
  updateZoom();
  // 指针锚定缩放：缩放后调整滚动，让光标下的内容点保持不动。
  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const before = app.zoom;
    app.zoomBy(factor);
    const ratio = app.zoom / before;
    if (ratio !== 1) {
      const r = scorePane.getBoundingClientRect();
      const px = scorePane.scrollLeft + (clientX - r.left);
      const py = scorePane.scrollTop + (clientY - r.top);
      scorePane.scrollLeft += px * (ratio - 1);
      scorePane.scrollTop += py * (ratio - 1);
    }
    updateZoom();
  };

  // Chromium/Edge：捏合与 Ctrl+滚轮都表现为 ctrlKey 的 wheel 事件。
  scorePane.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  // WebKit/WKWebView（Tauri macOS）：触控板双指捏合走 gesture* 事件，带绝对 scale。
  let gestureBase = 1;
  let gestureCx = 0;
  let gestureCy = 0;
  type GEvt = Event & { scale: number; clientX: number; clientY: number };
  scorePane.addEventListener("gesturestart", (ev) => {
    const e = ev as GEvt;
    e.preventDefault();
    gestureBase = app.zoom;
    gestureCx = e.clientX;
    gestureCy = e.clientY;
  });
  scorePane.addEventListener("gesturechange", (ev) => {
    const e = ev as GEvt;
    e.preventDefault();
    const before = app.zoom;
    app.setZoom(gestureBase * e.scale);
    const ratio = app.zoom / before;
    if (ratio !== 1) {
      const r = scorePane.getBoundingClientRect();
      const px = scorePane.scrollLeft + (gestureCx - r.left);
      const py = scorePane.scrollTop + (gestureCy - r.top);
      scorePane.scrollLeft += px * (ratio - 1);
      scorePane.scrollTop += py * (ratio - 1);
    }
    updateZoom();
  });
  scorePane.addEventListener("gestureend", (ev) => ev.preventDefault());

  // paging / zoom keys
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); app.zoomBy(1.2); updateZoom(); }
    else if (mod && e.key === "-") { e.preventDefault(); app.zoomBy(1 / 1.2); updateZoom(); }
    else if (mod && e.key === "0") { e.preventDefault(); app.resetZoom(); updateZoom(); }
    else if (e.key === "PageDown") app.nextPage();
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
