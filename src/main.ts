import "./styles.css";
import { MetaData } from "./smufl/smufl";
import { ensureFontsReady } from "./common/measure";
import { asset } from "./common/asset";
import { App } from "./editor/app";
import { showOptionsDialog } from "./editor/dialogs";
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

// 注册 Bravura @font-face（替代 styles.css 里的静态声明），按 Vite base 解析字体 URL。
async function registerBravura() {
  if (typeof FontFace === "undefined") return;
  const face = new FontFace("Bravura", `url(${asset("redist/Bravura.woff2")}) format("woff2")`);
  await face.load();
  (document.fonts as FontFaceSet).add(face);
}

async function boot() {
  await registerBravura();
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
  const win = window as unknown as { __app: App; __mixedPainter: MixedPainter; __omr: unknown; __abc2musicxml: unknown };
  win.__app = app;
  win.__mixedPainter = new MixedPainter();
  // OMR 原语暴露（便于脚本化测试/准确率回归，同 __app 约定）。
  win.__omr = import("./omr");
  // ABC → MusicXML 移植版暴露（便于 abc-check.mjs 回归，同 __app 约定）。
  win.__abc2musicxml = import("./abc/abc2xml");

  // toolbar
  const on = (id: string, fn: () => void) =>
    document.getElementById(id)?.addEventListener("click", fn);
  on("btn-save", () => void app.saveFile());
  on("btn-saveas", () => void app.saveFileAs());
  on("btn-prev", () => app.prevPage());
  on("btn-next", () => app.nextPage());
  on("btn-options", () => showOptionsDialog(app));
  on("btn-export", () => showExportDialog(app));
  const mixedBtn = document.getElementById("btn-mixed") as HTMLButtonElement | null;
  if (mixedBtn) {
    app.setMixedBtn(mixedBtn);
    mixedBtn.addEventListener("click", () => void app.toggleMixed());
  }
  const recognizeBtn = document.getElementById("btn-recognize") as HTMLButtonElement | null;
  if (recognizeBtn) {
    app.setRecognizeBtn(recognizeBtn);
    recognizeBtn.addEventListener("click", () => void app.toggleRecognize());
  }
  const recogViewSel = document.getElementById("sel-recog-view") as HTMLSelectElement | null;
  if (recogViewSel) {
    app.setRecogViewSelect(recogViewSel);
    recogViewSel.addEventListener("change", () => app.setRecogView(recogViewSel.value as import("./omr").RecogView));
  }
  const phraseBtn = document.getElementById("btn-phrase") as HTMLButtonElement | null;
  if (phraseBtn) {
    app.setPhraseBtn(phraseBtn);
    phraseBtn.addEventListener("click", () => app.togglePhrase());
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
  // 指针锚定缩放：以触点为中心，缩放后让触点下的内容点保持在原屏幕位置
  // （与双指预览图片一致）。连续的滚轮/捏合事件累积到 pending，按 rAF 每帧
  // 只应用一次——避免每个事件都触发一次「改 CSS 变量 → 强制同步布局」的抖动。
  let pendingZoom: number | null = null; // 目标 zoom（绝对值），null 表示无待处理
  let anchorX = 0, anchorY = 0;
  let rafId = 0;
  // 找触点落在哪一页（缩放前），间隙/页外则取最接近的页。页内 SVG 等比缩放，
  // 故基于该页自身的包围盒做锚定，天然规避了 score-pane 的居中/内边距偏移。
  const anchorPage = (y: number): HTMLElement | null => {
    const wraps = scorePane.querySelectorAll<HTMLElement>(".score-page-wrap");
    let best: HTMLElement | null = null;
    let bestDist = Infinity;
    for (const w of wraps) {
      const rc = w.getBoundingClientRect();
      if (y >= rc.top && y <= rc.bottom) return w;
      const d = y < rc.top ? rc.top - y : y - rc.bottom;
      if (d < bestDist) { bestDist = d; best = w; }
    }
    return best;
  };
  // 内容锚点：一段手势内固定的「谱面上的点」（锚定页 + 页内归一化坐标）。
  // 在手势开始时算一次并保持，避免低 zoom 居中阶段页位置变化污染归一化坐标；
  // 当前手指屏幕坐标 (anchorX/anchorY) 每个事件更新，故捏合平移时谱面随手指走。
  let gAnchor: { page: HTMLElement; fx: number; fy: number } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const beginOrKeepAnchor = (clientX: number, clientY: number) => {
    if (!gAnchor) {
      const page = anchorPage(clientY);
      if (page) {
        const rc = page.getBoundingClientRect();
        gAnchor = { page, fx: (clientX - rc.left) / rc.width, fy: (clientY - rc.top) / rc.height };
      }
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { gAnchor = null; }, 250); // 手势空闲即结束
  };
  const flushZoom = () => {
    rafId = 0;
    if (pendingZoom === null) return;
    app.setZoom(pendingZoom);
    pendingZoom = null;
    if (gAnchor) {
      // 同步读取缩放后的包围盒，调整滚动让固定的内容点回到当前手指屏幕坐标
      const post = gAnchor.page.getBoundingClientRect();
      const wantLeft = anchorX - gAnchor.fx * post.width;
      const wantTop = anchorY - gAnchor.fy * post.height;
      scorePane.scrollLeft += post.left - wantLeft;
      scorePane.scrollTop += post.top - wantTop;
    }
    updateZoom();
  };
  const scheduleZoom = (target: number, clientX: number, clientY: number) => {
    pendingZoom = target;
    anchorX = clientX;
    anchorY = clientY;
    beginOrKeepAnchor(clientX, clientY);
    if (!rafId) rafId = requestAnimationFrame(flushZoom);
  };
  const zoomBy = (clientX: number, clientY: number, factor: number) => {
    const base = pendingZoom ?? app.zoom;
    scheduleZoom(base * factor, clientX, clientY);
  };

  // Chromium/Edge：捏合与 Ctrl+滚轮都表现为 ctrlKey 的 wheel 事件。
  scorePane.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  // WebKit/WKWebView（Tauri macOS）：触控板双指捏合走 gesture* 事件，带绝对 scale。
  let gestureBase = 1;
  type GEvt = Event & { scale: number; clientX: number; clientY: number };
  scorePane.addEventListener("gesturestart", (ev) => {
    const e = ev as GEvt;
    e.preventDefault();
    gestureBase = app.zoom;
    gAnchor = null; // 新捏合以新的双指中心为锚
  });
  scorePane.addEventListener("gesturechange", (ev) => {
    const e = ev as GEvt;
    e.preventDefault();
    scheduleZoom(gestureBase * e.scale, e.clientX, e.clientY);
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

  // 自动加载上次打开的文件（仅 Tauri；失败则保持示例文本）
  await app.tryRestoreLastFile();
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

async function wireDragDrop(app: App, dropTarget: HTMLElement): Promise<void> {
  if (isTauriRuntime()) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    await getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === "drop") {
        const path = event.payload.paths[0];
        if (!path) return;
        if (IMAGE_EXT_RE.test(path)) {
          // 拖入图片 → 本地 OMR 识别并自动进识别模式叠加核对。
          const bytes = await readFile(path);
          await app.recognizeBytes("musicpp", { bytes, path });
          return;
        }
        if (!/\.(jpwabc|xml|musicxml|abc)$/i.test(path)) return;
        const bytes = await readFile(path);
        app.importBytes(bytes, path);
        if (!/\.(xml|musicxml|abc)$/i.test(path)) app.filePath = path;
        app.rememberLastFile(path);
      }
    });
  } else {
    dropTarget.addEventListener("dragover", (e) => e.preventDefault());
    dropTarget.addEventListener("drop", async (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const buf = new Uint8Array(await file.arrayBuffer());
      if (IMAGE_EXT_RE.test(file.name) || file.type.startsWith("image/")) {
        await app.recognizeBytes("musicpp", { bytes: buf, mime: file.type, path: null });
        return;
      }
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
