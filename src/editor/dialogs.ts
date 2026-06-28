// Minimal modal dialogs (replacing options.fxml / SimpleLayout.fxml).
import type { App } from "./app";

function modal(title: string, body: HTMLElement, onOk: () => void): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  const h = document.createElement("div");
  h.className = "modal-title";
  h.textContent = title;
  const footer = document.createElement("div");
  footer.className = "modal-footer";
  const ok = document.createElement("button");
  ok.textContent = "确定";
  const cancel = document.createElement("button");
  cancel.textContent = "取消";
  footer.append(cancel, ok);
  box.append(h, body, footer);
  overlay.append(box);
  document.body.append(overlay);

  const close = () => overlay.remove();
  cancel.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  ok.onclick = () => {
    onOk();
    close();
  };
  (body.querySelector("input,select") as HTMLElement | null)?.focus();
}

function labeled(label: string, el: HTMLElement): HTMLElement {
  const row = document.createElement("label");
  row.className = "modal-row";
  const span = document.createElement("span");
  span.textContent = label;
  row.append(span, el);
  return row;
}

/** 页面行数 — edit LinesPerPage in the .Layout section. */
export function showLayoutDialog(app: App): void {
  const body = document.createElement("div");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "例如 4 或 4|3|3（留空=自动）";
  input.value = app.getLinesPerPage();
  body.append(labeled("每页行数", input));
  modal("页面行数", body, () => app.setLinesPerPage(input.value.trim()));
}

/** 识图 — 选择 OMR 方式后选图识别。 */
export function showRecognizeDialog(app: App): void {
  const body = document.createElement("div");
  const sel = document.createElement("select");
  for (const [value, label] of [
    ["gemini", "Gemini（看图直转，真实照片更准，需桌面版 agy）"],
    ["musicpp", "musicpp（本地识别，离线可用，浏览器也行）"],
  ] as const) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.append(o);
  }
  const hint = document.createElement("div");
  hint.className = "modal-hint";
  hint.textContent = "确定后选择简谱图片（PNG/JPG）。Gemini 方式需桌面版并已安装 Antigravity CLI；musicpp 为本地识别。";
  body.append(labeled("识别方式", sel), hint);
  modal("从图片识别简谱", body, () => {
    void app.recognizeFromImage(sel.value as "musicpp" | "gemini");
  });
}

const RATIOS: Record<string, [number, number]> = {
  "16:9": [960, 540],
  "4:3": [720, 540],
  A4: [595, 842],
};

/** 选项 — page ratio + base font size. */
export function showOptionsDialog(app: App): void {
  const body = document.createElement("div");
  const sel = document.createElement("select");
  for (const k of Object.keys(RATIOS)) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    if (RATIOS[k][0] === app.pageW && RATIOS[k][1] === app.pageH) o.selected = true;
    sel.append(o);
  }
  const fs = document.createElement("input");
  fs.type = "number";
  fs.min = "12";
  fs.max = "72";
  fs.value = String(app.fontSize);
  const titleSz = document.createElement("input");
  titleSz.type = "number";
  titleSz.min = "12";
  titleSz.max = "120";
  titleSz.value = String(app.titleSize);
  const creditSz = document.createElement("input");
  creditSz.type = "number";
  creditSz.min = "12";
  creditSz.max = "120";
  creditSz.value = String(app.creditSize);
  const color = document.createElement("input");
  color.type = "color";
  color.value = "#" + ((app.color >>> 0) & 0xffffff).toString(16).padStart(6, "0");
  body.append(
    labeled("谱面比例", sel),
    labeled("基础字号", fs),
    labeled("标题字号", titleSz),
    labeled("词曲信息字号", creditSz),
    labeled("颜色", color),
  );
  // 混排专属：隐藏小节号（仅混排模式下显示该选项）。
  const hideBarNum = document.createElement("input");
  hideBarNum.type = "checkbox";
  hideBarNum.checked = app.mixedHideBarNumber;
  if (app.mode === "mixed") {
    body.append(labeled("隐藏小节号", hideBarNum));
  }
  modal("选项", body, () => {
    const [w, h] = RATIOS[sel.value] ?? [app.pageW, app.pageH];
    const fontSize = parseInt(fs.value, 10) || app.fontSize;
    const titleSize = parseInt(titleSz.value, 10) || app.titleSize;
    const creditSize = parseInt(creditSz.value, 10) || app.creditSize;
    const argb = 0xff000000 | (parseInt(color.value.slice(1), 16) & 0xffffff);
    app.applyRenderSettings({ pageW: w, pageH: h, fontSize, titleSize, creditSize, color: argb >>> 0 });
    if (app.mode === "mixed") void app.setMixedHideBarNumber(hideBarNum.checked);
  });
}
