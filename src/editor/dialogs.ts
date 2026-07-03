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
  const lines = document.createElement("input");
  lines.type = "text";
  lines.placeholder = "例如 4 或 4|3|3（留空=自动）";
  lines.value = app.getLinesPerPage();
  body.append(
    labeled("谱面比例", sel),
    labeled("每页行数", lines),
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
  // 播放混音：各声部音量（0–100%，播放/导出 MIDI 时按此写入 CC7；改后需重新播放）。
  const volSliders: HTMLInputElement[] = [];
  if (app.mode === "jp" && app.partCount > 1) {
    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:8px;font-weight:600;opacity:0.8";
    hint.textContent = "声部音量（播放/导出 MIDI）";
    body.append(hint);
    for (let i = 0; i < app.partCount; i++) {
      const s = document.createElement("input");
      s.type = "range";
      s.min = "0";
      s.max = "100";
      s.value = String(Math.round(app.getPartVolume(i) * 100));
      volSliders.push(s);
      body.append(labeled(`声部 ${i + 1}`, s));
    }
  }
  modal("选项", body, () => {
    volSliders.forEach((s, i) => app.setPartVolume(i, (parseInt(s.value, 10) || 0) / 100));
    const [w, h] = RATIOS[sel.value] ?? [app.pageW, app.pageH];
    const fontSize = parseInt(fs.value, 10) || app.fontSize;
    const titleSize = parseInt(titleSz.value, 10) || app.titleSize;
    const creditSize = parseInt(creditSz.value, 10) || app.creditSize;
    const argb = 0xff000000 | (parseInt(color.value.slice(1), 16) & 0xffffff);
    const linesVal = lines.value.trim();
    if (linesVal !== app.getLinesPerPage()) app.setLinesPerPage(linesVal);
    app.applyRenderSettings({ pageW: w, pageH: h, fontSize, titleSize, creditSize, color: argb >>> 0 });
    if (app.mode === "mixed") void app.setMixedHideBarNumber(hideBarNum.checked);
  });
}
