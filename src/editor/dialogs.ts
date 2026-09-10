// Minimal modal dialogs (replacing options.fxml / SimpleLayout.fxml).
import type { App } from "./app";
import { ORIGINAL_PAPERS, PAGE_RATIOS, PAPER_SIZES } from "./app";

function modal(title: string, body: HTMLElement, onOk: () => void, onCancel?: () => void): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box settings-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const h = document.createElement("div");
  h.className = "modal-title";
  h.id = "settings-dialog-title";
  h.textContent = title;
  box.setAttribute("aria-labelledby", h.id);
  const footer = document.createElement("div");
  footer.className = "modal-footer";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "modal-button-primary";
  ok.textContent = "确定";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  footer.append(cancel, ok);
  box.append(h, body, footer);
  overlay.append(box);
  document.body.append(overlay);

  let settled = false;
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKeyDown);
    // 取消（含 Esc / 点遮罩）也要有回声，否则确认框的调用方永远等不到答复。
    if (!settled) {
      settled = true;
      onCancel?.();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKeyDown);
  cancel.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  ok.onclick = () => {
    settled = true;
    onOk();
    close();
  };
  (body.querySelector("input,select") as HTMLElement | null)?.focus();
}

/** 是/否确认框。用同一套 modal 样式，别退回 window.confirm——桌面版观感对不上。 */
export function showConfirmDialog(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.className = "modal-row";
    body.textContent = message;
    modal(title, body, () => resolve(true), () => resolve(false));
  });
}

function labeled(label: string, el: HTMLElement): HTMLElement {
  const row = document.createElement("label");
  row.className = "modal-row";
  const span = document.createElement("span");
  span.textContent = label;
  row.append(span, el);
  return row;
}

const HANCONV_KEY = "jpeditor-hanconv-dir";

/** 简繁 — 整篇转换源码中的中文（歌词/标题/词曲）。 */
export function showHanConvDialog(app: App): void {
  const body = document.createElement("div");
  body.className = "settings-form";
  const sel = document.createElement("select");
  const opts: [string, string][] = [
    ["auto", "自动检测"],
    ["s2t", "简体 → 繁体"],
    ["t2s", "繁体 → 简体"],
  ];
  const last = localStorage.getItem(HANCONV_KEY) ?? "auto";
  for (const [v, text] of opts) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = text;
    if (v === last) o.selected = true;
    sel.append(o);
  }
  const hint = document.createElement("div");
  hint.style.cssText = "margin-top:8px;opacity:0.75;font-size:12px;line-height:1.6";
  hint.textContent = "转换源码中的歌词、标题与词曲信息，乐谱代码不变；可用 Ctrl/⌘+Z 撤销。";
  body.append(labeled("转换方向", sel), hint);
  modal("简繁转换", body, () => {
    const dir = sel.value as "auto" | "s2t" | "t2s";
    try {
      localStorage.setItem(HANCONV_KEY, dir);
    } catch { /* 隐私模式下忽略 */ }
    void app.convertHanzi(dir);
  });
}

/** ARGB → <input type="color">。取色器只认 #rrggbb，alpha 一律当不透明处理
 *  （谱面从来没用过半透明色，存量数据里的 alpha 也一直是 0xff）。 */
function colorInput(argb: number): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "color";
  el.value = "#" + ((argb >>> 0) & 0xffffff).toString(16).padStart(6, "0");
  return el;
}

/** 取色器的值读回 ARGB。浏览器给不出合法值时（理论上不会）退回原值，不要静默变黑。 */
function colorValue(el: HTMLInputElement, fallback: number): number {
  const rgb = parseInt(el.value.slice(1), 16);
  if (!Number.isFinite(rgb)) return fallback;
  return (0xff000000 | (rgb & 0xffffff)) >>> 0;
}

/** 选项。**只摆当前模式下真正生效的项**——面板是全局的，但四档视图（展开 / 原样 /
 *  五线谱 / 混排）各走各的排版器，参数并不通用：字号与颜色只有简谱排版器那条路吃
 *  （文本谱有自己的整套 metrics、混排有自己的一套色），纸张两档各记各的，
 *  「每页行数」只对分页的那一档有意义。摆出无效项等于骗人——改了没反应。
 *  背景色是唯一四档通吃的（它铺的是纸，不是谱，见 App._applyPageBg）。 */
export function showOptionsDialog(app: App): void {
  const body = document.createElement("div");
  body.className = "settings-form";

  const view = app.viewMode;
  const isPu = app.docFormat === "pu"; // 文本谱：版面全由 print/slide 两档的 metrics 定
  const isMixed = app.mode === "mixed"; // 五线谱 / 混排：走 MixedPainter
  /** 简谱排版器那条路（展开档或原样档）——下面绝大多数项只有它吃。 */
  const isJp = !isPu && !isMixed;
  const isPpt = isJp && view === "expanded";
  const isJianpu = isJp && view === "original";

  const num = (value: number, min: number, max: number): HTMLInputElement => {
    const el = document.createElement("input");
    el.type = "number";
    el.min = String(min);
    el.max = String(max);
    el.value = String(value);
    return el;
  };
  const note = (text: string): HTMLDivElement => {
    const el = document.createElement("div");
    el.style.cssText = "margin-top:4px;opacity:0.75;font-size:12px;line-height:1.6";
    el.textContent = text;
    return el;
  };

  // ---- 纸张 ----
  // 展开档取 PAGE_RATIOS 的**绝对尺寸**（导出 PPTX 就是这个纸）；原样档只取**比例**，
  // 纸宽锁定（见 App.layoutPage），所以两档虽然共用这张表，选中项各按各的算。
  /** 纸张下拉。`withSize` 时把实际尺寸写进选项文字——原样档选的是**纸**（「A4」不该还要人
   *  去猜多大）；展开档选的是**比例**（「16:9」本身就说清楚了），照旧只写键名。
   *  值为 null 的那一档是「长图」：不是纸，宽固定、高由内容定。 */
  const paperSelect = (
    keys: readonly string[],
    sizeOf: (k: string) => [number, number] | null,
    selected: (k: string) => boolean,
    withSize: boolean,
  ): HTMLSelectElement => {
    const el = document.createElement("select");
    for (const k of keys) {
      const wh = sizeOf(k);
      const o = document.createElement("option");
      o.value = k;
      o.textContent = withSize && wh ? `${k}（${wh[0]}×${wh[1]}pt）` : k;
      o.selected = selected(k);
      el.append(o);
    }
    return el;
  };

  // 展开档是投影片，选的是 16:9 / 4:3 那几个比例；原样档选的是实际纸张，外加一档长图。
  const ratio = paperSelect(
    Object.keys(PAGE_RATIOS),
    (k) => PAGE_RATIOS[k],
    (k) => PAGE_RATIOS[k][0] === app.pageW && PAGE_RATIOS[k][1] === app.pageH,
    false,
  );
  const jpPaper = paperSelect(ORIGINAL_PAPERS, (k) => PAPER_SIZES[k], (k) => k === app.jpPaper, true);

  // ---- 每页行数（写进文档 .Layout 段，只有 jpwabc 有这个段）----
  const lines = document.createElement("input");
  lines.type = "text";
  lines.placeholder = "例如 4 或 4|3|3（留空=自动）";
  lines.value = isPpt ? app.getLinesPerPage() : "";
  // 「每页行数」只归展开档：那一档是逐段展开、一屏一段，每页放几行是版面决定；
  // 原样档按原谱排一遍，行数由内容与纸说了算，人为定死只会把谱挤坏。
  const linesRow = labeled("每页行数", lines);

  // ---- 字号 ----
  const fs = num(app.fontSize, 12, 72);
  const titleSz = num(app.titleSize, 12, 120);
  const creditSz = num(app.creditSize, 12, 120);

  const color = colorInput(app.color);
  const bgColor = colorInput(app.bgColor);

  // ---- 文本谱：纸张比例 / 长图 / 字号缩放 ----
  // 文本谱的尺寸是从原书逐项量出来的一整套（pu/metrics.ts），不由一个基础字号派生，
  // 所以这里给的是**整体缩放**而不是字号——与谱面自带的 `FontSize: all=` 同一语义。
  // 展开档与 .jpwabc 同一组投影片比例（恒分页）；原样档选实际纸张，外加一档长图。
  const puIsPpt = isPu && view === "expanded";
  const puPaper = puIsPpt
    ? paperSelect(Object.keys(PAGE_RATIOS), (k) => PAGE_RATIOS[k] ?? null, (k) => k === app.puExpandedRatio, false)
    : paperSelect(ORIGINAL_PAPERS, (k) => PAPER_SIZES[k] ?? null, (k) => k === app.puPaper, true);
  // 字号留空/0 = 跟随版式量到的原尺寸；有排好的谱就把当前实际字号填进去当起点
  const puFont = num(
    (puIsPpt ? app.puExpandedFontSize : app.puFontSize) || Math.round(app.puPainter?.digitFontSize ?? 0),
    6, 200,
  );

  if (isJianpu) {
    body.append(labeled("纸张", jpPaper));
  } else if (isPpt) {
    body.append(labeled("谱面比例", ratio));
  }
  if (isPpt) body.append(linesRow);
  if (isJp) {
    body.append(labeled("基础字号", fs));
    // 原样档只调基础字号：那一档的标题与词曲字号是按比例派生的（App._setJpFontSize），
    // 摆出来只会让人以为能单独调。展开档三个都是独立设置，照旧全给。
    if (!isJianpu) body.append(labeled("标题字号", titleSz), labeled("词曲信息字号", creditSz));
    body.append(labeled("前景色", color));
  }
  if (isPu) {
    body.append(labeled(puIsPpt ? "谱面比例" : "纸张", puPaper), labeled("基础字号", puFont), labeled("前景色", color));
  }
  body.append(labeled("背景色", bgColor));

  // 混排专属：隐藏小节号。
  const hideBarNum = document.createElement("input");
  hideBarNum.type = "checkbox";
  hideBarNum.checked = app.mixedHideBarNumber;
  if (isMixed) body.append(labeled("隐藏小节号", hideBarNum));

  if (isPu) {
    body.append(note(
      "改字号会整块等比缩放版式量好的尺寸（纸与页边距不跟着缩），与谱面自带的 FontSize 指令同一语义；"
      + "两档各记一套；展开档恒分页，只选谱面比例。",
    ));
  } else if (isMixed) {
    body.append(note("五线谱与混排的纸张与字号随 MusicXML 的版面走，这里只设背景色。"));
  }

  // 播放混音：各声部音量（0–100%，播放/导出 MIDI 时按此写入 CC7；改后需重新播放）。
  const volSliders: HTMLInputElement[] = [];
  if (app.mode === "jp" && app.partCount > 1) {
    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:8px;font-weight:600;opacity:0.8";
    hint.textContent = "声部音量（播放/导出 MIDI）";
    body.append(hint);
    for (let i = 0; i < app.partCount; i++) {
      const sl = document.createElement("input");
      sl.type = "range";
      sl.min = "0";
      sl.max = "100";
      sl.value = String(Math.round(app.playback.getPartVolume(i) * 100));
      volSliders.push(sl);
      body.append(labeled(`声部 ${i + 1}`, sl));
    }
  }

  // 「长图」一勾一取消，「每页行数」要跟着出现/消失——现开现关，不必确定后才知道。
  modal("设置", body, () => {
    volSliders.forEach((sl, i) => app.playback.setPartVolume(i, (parseInt(sl.value, 10) || 0) / 100));
    // 没摆出来的项一律不回灌：把它们的初值当用户输入送回去，等于替用户做了没做过的决定。
    const [w, h] = isPpt ? PAGE_RATIOS[ratio.value] ?? [app.pageW, app.pageH] : [undefined, undefined];
    const fontSize = isJp ? parseInt(fs.value, 10) || app.fontSize : undefined;
    const titleSize = isPpt ? parseInt(titleSz.value, 10) || app.titleSize : undefined;
    const creditSize = isPpt ? parseInt(creditSz.value, 10) || app.creditSize : undefined;
    const argb = isJp || isPu ? colorValue(color, app.color) : undefined;
    if (isPpt) {
      const linesVal = lines.value.trim();
      if (linesVal !== app.getLinesPerPage()) app.setLinesPerPage(linesVal);
    }
    app.applyRenderSettings({
      pageW: w, pageH: h, fontSize, titleSize, creditSize,
      jpPaper: isJianpu ? jpPaper.value : undefined,
      puPaper: isPu && !puIsPpt ? puPaper.value : undefined,
      puExpandedRatio: puIsPpt ? puPaper.value : undefined,
      puFontSize: isPu && !puIsPpt ? parseInt(puFont.value, 10) || 0 : undefined,
      puExpandedFontSize: puIsPpt ? parseInt(puFont.value, 10) || 0 : undefined,
      color: argb, bgColor: colorValue(bgColor, app.bgColor),
    });
    if (isMixed) void app.setMixedHideBarNumber(hideBarNum.checked);
  });
}
