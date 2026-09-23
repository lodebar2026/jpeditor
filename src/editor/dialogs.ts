// Minimal modal dialogs (replacing options.fxml / SimpleLayout.fxml).
import type { App, PaperChoice, PaperEngine } from "./app";
import { resolvePaper, pageMargins, CUSTOM_PAPER } from "../style/paper";
import { HEADER_LABEL, HEADER_ROLES } from "../style/header";
import type { PageDecl } from "../style/sheet";
import { ORIGINAL_PAPERS, PAGE_RATIOS, PAPER_SIZES } from "../style/themes";
import { META_KEYS, metaKeyDef, splitMetaValue } from "../model/metakeys";
import { CONVERT_TARGETS } from "../model/convert";
import { replaceMetaLines } from "../j123/metaedit";
import type { SongMeta } from "../model/doc";

/** `extra`：页脚左侧再放一个按钮（点了执行并关闭，不算取消）。 */
function modal(
  title: string,
  body: HTMLElement,
  onOk: () => void,
  onCancel?: () => void,
  extra?: { label: string; onClick: () => void },
): void {
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
  const extraBtn = extra ? document.createElement("button") : null;
  if (extraBtn && extra) {
    extraBtn.type = "button";
    extraBtn.textContent = extra.label;
    extraBtn.style.marginRight = "auto";
    footer.append(extraBtn);
  }
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
  if (extraBtn && extra) {
    extraBtn.onclick = () => {
      settled = true;
      extra.onClick();
      close();
    };
  }
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

/** 单选框：列一组选项，确定返回选中的值；取消（含 Esc / 点遮罩）返回 `null`。
 *  `remember` 给了就在下面加一个「记住选择」勾选框，结果里带回它的勾选状态。 */
export function showChoiceDialog<T extends string>(
  title: string,
  message: string,
  options: readonly { value: T; label: string }[],
  opts: { defaultValue: T; remember?: string },
): Promise<{ value: T; remember: boolean } | null> {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.style.cssText = "display:flex;flex-direction:column;gap:6px";
    if (message) {
      const msg = document.createElement("div");
      msg.className = "modal-row";
      msg.textContent = message;
      body.append(msg);
    }
    const name = `choice-${Math.random().toString(36).slice(2)}`;
    const radios: HTMLInputElement[] = [];
    for (const o of options) {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer";
      const r = document.createElement("input");
      r.type = "radio";
      r.name = name;
      r.value = o.value;
      r.checked = o.value === opts.defaultValue;
      radios.push(r);
      const span = document.createElement("span");
      span.textContent = o.label;
      row.append(r, span);
      body.append(row);
    }
    const remember = document.createElement("input");
    remember.type = "checkbox";
    if (opts.remember) {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px;opacity:0.85;cursor:pointer";
      const span = document.createElement("span");
      span.textContent = opts.remember;
      row.append(remember, span);
      body.append(row);
    }
    modal(title, body, () => {
      const picked = radios.find((r) => r.checked)?.value as T | undefined;
      resolve({ value: picked ?? opts.defaultValue, remember: remember.checked });
    }, () => resolve(null));
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
const PT_PER_MM = 72 / 25.4;

/** 纸张一句话：「A4 竖」（边距在下面那一行显示）。 */
function describePage(p: PageDecl): string {
  const size = resolvePaper(p);
  if (size === null) return "长图";
  const name = p.paper === CUSTOM_PAPER && size ? `${Math.round(size.w)}×${Math.round(size.h)}pt` : p.paper ?? "";
  return `${name} ${size && size.w > size.h ? "横" : "竖"}`;
}

/** 纸张栏：纸（谱里写了纸时多一项「跟随文件」）+ 方向 + 四边距（mm，留空 = 自动）。
 *  `read()` 返回 null 表示没动过——没动过就不写用户层，免得把「跟随文件」悄悄钉成一张具体的纸。 */
function paperGroup(app: App, engine: PaperEngine): { rows: HTMLElement[]; read(): PaperChoice | null } {
  const st = app.paperState(engine);
  const following = !st.userSet && st.doc !== null;
  const paper = document.createElement("select");
  if (st.doc) {
    const o = document.createElement("option");
    o.value = "follow";
    o.textContent = `跟随文件（${describePage(st.doc)}）`;
    paper.append(o);
  }
  for (const k of ORIGINAL_PAPERS) {
    const wh = PAPER_SIZES[k];
    const o = document.createElement("option");
    o.value = k;
    o.textContent = wh ? `${k}（${wh[0]}×${wh[1]}pt）` : k;
    paper.append(o);
  }
  paper.value = following ? "follow" : isPaperKey(st.page.paper) ? st.page.paper! : "A4";

  const orient = document.createElement("select");
  for (const [v, t] of [["portrait", "竖"], ["landscape", "横"]] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    orient.append(o);
  }
  const size = resolvePaper(st.page);
  orient.value = size && size.w > size.h ? "landscape" : "portrait";

  const mgNow = pageMargins(st.page);
  const margins = ["上", "右", "下", "左"].map((label, i) => {
    const el = document.createElement("input");
    el.type = "number";
    el.min = "0";
    el.max = "100";
    el.placeholder = label;
    el.title = `${label}边距（mm），留空 = 自动`;
    el.style.width = "4.2em";
    if (mgNow) el.value = String(Math.round(mgNow[i]! / PT_PER_MM));
    return el;
  });
  const mgBox = document.createElement("span");
  mgBox.style.cssText = "display:inline-flex;gap:4px";
  mgBox.append(...margins);

  // 跟随文件 / 长图时方向与边距没有意义（长图的边距仍由排版器自己定）
  const sync = () => {
    const fixed = paper.value === "follow" || paper.value === "长图";
    orient.disabled = fixed;
    for (const m of margins) m.disabled = paper.value === "follow";
  };
  paper.onchange = sync;
  sync();

  const initial = JSON.stringify([paper.value, orient.value, margins.map((m) => m.value)]);
  return {
    rows: [labeled("纸张", paper), labeled("方向", orient), labeled("边距（mm）", mgBox)],
    read() {
      if (JSON.stringify([paper.value, orient.value, margins.map((m) => m.value)]) === initial) return null;
      if (paper.value === "follow") return "follow";
      const vals = margins.map((m) => m.value.trim());
      const margin = vals.every((v) => v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0)
        ? vals.map((v) => Math.round(Number(v) * PT_PER_MM * 10) / 10)
        : null;
      return { paper: paper.value, orientation: orient.value as "portrait" | "landscape", margin };
    },
  };
}

/** 页眉字体下拉里的几支常用字。值是 CSS 字体栈（Mac / Windows 各给一支，缺了由浏览器回退）。 */
const HEADER_FAMILIES: readonly [string, string][] = [
  ["黑体", "PingFang SC, Microsoft YaHei, sans-serif"],
  ["宋体", "Songti SC, SimSun, serif"],
  ["楷体", "Kaiti SC, STKaiti, KaiTi, serif"],
  ["仿宋", "STFangsong, FangSong, serif"],
  ["魏碑", "Weibei SC, STXinwei, serif"],
  ["圆体", "Yuanti SC, YouYuan, sans-serif"],
  ["Times", "Times New Roman, Times, serif"],
];

/** 页眉一组：标题 / 副标题 / 经文 / 词曲作者，各一个字体下拉 + 字号（pt，留空 = 跟随文件或出厂）。各档共用一份。 */
function headerGroup(app: App): { rows: HTMLElement[]; apply(): boolean } {
  const st = app.headerState();
  const rows: HTMLElement[] = [];
  const reads: (() => boolean)[] = [];
  for (const role of HEADER_ROLES) {
    const doc = st.doc[role];
    const user = st.user[role];
    const fam = document.createElement("select");
    const def = document.createElement("option");
    def.value = "";
    def.textContent = doc?.family ? `跟随文件（${doc.family.split(",")[0]}）` : "默认";
    fam.append(def);
    const known = new Set<string>();
    for (const [label, stack] of HEADER_FAMILIES) {
      const o = document.createElement("option");
      o.value = stack;
      o.textContent = label;
      fam.append(o);
      known.add(stack);
    }
    if (user?.family && !known.has(user.family)) {
      const o = document.createElement("option");
      o.value = user.family;
      o.textContent = user.family.split(",")[0]!;
      fam.append(o);
    }
    fam.value = user?.family ?? "";
    const size = document.createElement("input");
    size.type = "number";
    size.min = "6";
    size.max = "120";
    size.style.width = "4.5em";
    size.placeholder = doc?.size ? String(Math.round(doc.size)) : "默认";
    size.title = "字号（pt），留空 = " + (doc?.size ? "跟随文件" : "出厂");
    if (user?.size) size.value = String(Math.round(user.size * 10) / 10);
    const box = document.createElement("span");
    box.style.cssText = "display:inline-flex;gap:6px;align-items:center";
    box.append(fam, size);
    rows.push(labeled(HEADER_LABEL[role], box));
    const init = JSON.stringify([fam.value, size.value]);
    reads.push(() => {
      if (JSON.stringify([fam.value, size.value]) === init) return false;
      const n = parseFloat(size.value);
      app.setHeaderFont(role, { family: fam.value || null, size: Number.isFinite(n) && n > 0 ? n : null });
      return true;
    });
  }
  const title = document.createElement("div");
  title.style.cssText = "margin-top:8px;font-weight:600;opacity:0.8";
  title.textContent = "页眉（各模式共用）";
  return { rows: [title, ...rows], apply: () => reads.map((r) => r()).some(Boolean) };
}

const isPaperKey = (k: string | undefined): boolean => k !== undefined && (ORIGINAL_PAPERS as readonly string[]).includes(k);

export function showOptionsDialog(app: App): void {
  const body = document.createElement("div");
  body.className = "settings-form";

  const view = app.viewMode;
  const isMixed = app.mode === "mixed"; // 五线谱 / 混排
  /** 展开档：两种格式同一条展开档排版，摆同一组设置。 */
  const isPpt = !isMixed && view === "expanded";
  /** 原样文档那一路的**原样档**（文本谱、多声部的 123/ABC、MusicXML）：版面由量好的 metrics 定。
   *  单声部 123/ABC 的原样档走简谱引擎（`App._originalOnJianpu`），与 `.jpwabc` 原样档摆同一组设置。 */
  const isPu = !isMixed && !isPpt && app.painter.isDocumentLayout;
  /** 简谱排版器那条路（展开档，或 `.jpwabc` / 单声部 123、ABC 的原样档）——下面绝大多数项只有它吃。 */
  const isJp = !isMixed && !isPu;
  const isJianpu = isJp && view === "original";
  /** 「每页行数」写进 `.jpwabc` 的 `.Layout` 段，文本谱与 123 没有这个段
   *  （123 是 `I:linesperpage`，尚未接）。 */
  const hasLayoutSection = isPpt && app.docFormat === "jpwabc";

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
  // 纸张栏（纸 + 方向 + 边距）：简谱原样、文本谱原样、五线谱/混排三档各记各的；
  // 五线谱/混排自己一张纸（出厂 A4），不借原样档那张长图
  const paperEngine: PaperEngine | null = isMixed ? "staff" : isPu ? "pu" : isJianpu ? "jianpu" : null;
  const paperUi = paperEngine ? paperGroup(app, paperEngine) : null;

  // ---- 每页行数（写进文档 .Layout 段，只有 jpwabc 有这个段）----
  const lines = document.createElement("input");
  lines.type = "text";
  lines.placeholder = "例如 4 或 4|3|3（留空=自动）";
  lines.value = hasLayoutSection ? app.getLinesPerPage() : "";
  // 「每页行数」只归展开档：那一档是逐段展开、一屏一段，每页放几行是版面决定；
  // 原样档按原谱排一遍，行数由内容与纸说了算，人为定死只会把谱挤坏。
  const linesRow = labeled("每页行数", lines);

  // ---- 字号 ----
  const fs = num(app.fontSize, 12, 72);

  const color = colorInput(app.color);
  const bgColor = colorInput(app.bgColor);

  // ---- 文本谱原样档：纸张 / 长图 / 字号缩放 ----
  // 文本谱的尺寸是从原书逐项量出来的一整套（layout/original/metrics.ts），不由一个基础字号派生，
  // 所以这里给的是**整体缩放**而不是字号——与谱面自带的 `FontSize: all=` 同一语义。
  // 字号留空/0 = 跟随版式量到的原尺寸；有排好的谱就把当前实际字号填进去当起点
  const puFont = num(app.puFontSize || Math.round(app.painter.documentDigitFontSize ?? 0), 6, 200);

  if (paperUi) {
    body.append(...paperUi.rows);
  } else if (isPpt) {
    body.append(labeled("谱面比例", ratio));
  }
  if (hasLayoutSection) body.append(linesRow);
  if (isJp) {
    body.append(labeled("基础字号", fs));
    // 原样档只调基础字号：那一档的标题与词曲字号是按比例派生的（`style/jianpu.ts::jianpuSizes`），
    // 摆出来只会让人以为能单独调。展开档三个都是独立设置，照旧全给。
    body.append(labeled("前景色", color));
  }
  if (isPu) {
    body.append(labeled("基础字号", puFont), labeled("前景色", color));
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
      + "展开档与 .jpwabc 共用同一套设置。",
    ));
  } else if (isMixed) {
    body.append(note("谱里写了版面（<page-layout>）的，纸张默认跟随文件；换了纸就按新纸重新铺排，谱里原来的分行坐标不再用。"));
  }

  // 可视化编辑：谱面上插入/改音时响一下（只在简谱档、能改谱的格式下摆出来）
  const noteSound = document.createElement("input");
  noteSound.type = "checkbox";
  noteSound.checked = app.visual.noteSound;
  const showNoteSound = app.mode === "jp" && app.editDialect() !== null;
  if (showNoteSound) body.append(labeled("改音时发声", noteSound));

  // 页眉四项的字体字号：各档共用（展开档原来单列的标题 / 词曲字号也并在这里）
  const header = headerGroup(app);
  body.append(...header.rows);

  // 打开单声部 MusicXML 时怎么办（「记住选择」之后从这里改回「每次询问」）
  const xmlImport = document.createElement("select");
  for (const [v, label] of [
    ["ask", "每次询问"],
    ["musicxml", "保持 MusicXML"],
    ...CONVERT_TARGETS.map((t) => [t.id, `转成 ${t.label}`] as const),
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    o.selected = v === app.musicXmlImport;
    xmlImport.append(o);
  }
  body.append(labeled("打开 MusicXML", xmlImport));

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
    header.apply(); // 先落用户层，下面 applyRenderSettings 统一存盘并重排
    const argb = isJp || isPu ? colorValue(color, app.color) : undefined;
    if (hasLayoutSection) {
      const linesVal = lines.value.trim();
      if (linesVal !== app.getLinesPerPage()) app.setLinesPerPage(linesVal);
    }
    app.applyRenderSettings({
      pageW: w, pageH: h, fontSize,
      paper: (() => {
        const c = paperUi?.read();
        return paperEngine && c ? { [paperEngine]: c } : undefined;
      })(),
      puFontSize: isPu ? parseInt(puFont.value, 10) || 0 : undefined,
      color: argb, bgColor: colorValue(bgColor, app.bgColor),
    });
    if (isMixed) void app.setMixedHideBarNumber(hideBarNum.checked);
    if (xmlImport.value !== app.musicXmlImport) {
      app.musicXmlImport = xmlImport.value as typeof app.musicXmlImport;
      app.saveSettings();
    }
    if (showNoteSound && noteSound.checked !== app.visual.noteSound) app.visual.setNoteSound(noteSound.checked);
  }, undefined, isMixed ? undefined : {
    // 清掉当前档（展开 / 原样）的用户层，回到内置主题；另一档与声部音量不动
    label: "恢复本档默认",
    onClick: () => app.resetRenderSettings(),
  });
}

const CREATOR_LABEL: Record<string, string> = {
  lyricist: "作词", composer: "作曲", arranger: "编曲", translator: "译词", transcriber: "制谱", "words-and-music": "词曲", poet: "作词",
};

/**
 * 曲目信息：标题 / 词曲 / 版权（只看），扩展 meta（`Song.meta`，键见 `model/metakeys.ts`）可改。
 * **只有 123 写得回原文**（`I:meta 键 值`，见 `j123/metaedit.ts`）；其余格式装不下（能力表 `meta`），
 * 只看不改，提示另存为 123。
 */
export function showSongInfoDialog(app: App): void {
  const doc = app.docFormat === "musicxml" ? app.mixedDoc : app.currentScoreDoc();
  const song = doc?.songs[0];
  if (!song) {
    app.setStatus("当前文档读不出曲目信息");
    return;
  }
  // 123 / ABC 写回头部的 `I:meta` 行（同一个解析器认）；MusicXML 改模型整份重写（`<miscellaneous-field>`）；
  // `.jpwabc` 与文本谱没有字段可落，只看
  const editable = app.docFormat === "123" || app.docFormat === "abc" || app.docFormat === "musicxml";
  const body = document.createElement("div");
  body.className = "settings-form";
  const info = (label: string, value: string): void => {
    if (!value) return;
    const v = document.createElement("span");
    v.textContent = value;
    v.style.cssText = "white-space:pre-wrap;max-width:360px";
    body.append(labeled(label, v));
  };
  info("标题", [song.work.title ?? "", ...song.work.subtitles].filter(Boolean).join("\n"));
  info("词曲", (song.identification?.creators ?? []).map((c) => `${CREATOR_LABEL[c.type] ?? c.type}｜${c.text}`).join("\n"));
  info("版权", song.identification?.rights ?? "");

  const meta = song.meta ?? {};
  const inputs = new Map<string, HTMLTextAreaElement | HTMLInputElement>();
  for (const def of META_KEYS) {
    let el: HTMLTextAreaElement | HTMLInputElement;
    if (def.flag) {
      el = document.createElement("input");
      el.type = "checkbox";
      el.checked = (meta[def.key]?.[0] ?? "") === "true";
    } else {
      el = document.createElement("textarea");
      el.rows = def.split ? 1 : Math.max(1, (meta[def.key] ?? []).length);
      el.value = (meta[def.key] ?? []).join(def.split ? "；" : "\n");
      el.style.cssText = "min-width:320px;font:inherit";
    }
    el.disabled = !editable;
    inputs.set(def.key, el);
    body.append(labeled(def.label, el));
  }
  // 不在注册表里的键：一行一项「键: 值」
  const others = document.createElement("textarea");
  others.rows = 2;
  others.style.cssText = "min-width:320px;font:inherit";
  others.value = Object.entries(meta)
    .filter(([k]) => !metaKeyDef(k))
    .flatMap(([k, vs]) => vs.map((v) => `${k}: ${v}`))
    .join("\n");
  others.disabled = !editable;
  body.append(labeled("其他", others));
  const hint = document.createElement("div");
  hint.style.cssText = "margin-top:8px;opacity:0.75;font-size:12px;line-height:1.6";
  hint.textContent = !editable
    ? "这种格式装不下扩展曲目信息（英文标题、经文、标签等），只能查看；另存为 123 后可编辑。"
    : app.docFormat === "musicxml"
      ? "改动写进 MusicXML 的 <miscellaneous-field>（整份重写）；歌本模板（.jpcss）按键名引用这些字段。"
      : "改动写回源码头部的 I:meta 行，可用 Ctrl/⌘+Z 撤销；歌本模板（.jpcss）按键名引用这些字段。";
  body.append(hint);

  modal("曲目信息", body, () => {
    if (!editable) return;
    const out: SongMeta = {};
    for (const [key, el] of inputs) {
      const def = metaKeyDef(key)!;
      if (el instanceof HTMLInputElement) {
        if (el.checked) out[key] = ["true"];
        continue;
      }
      const text = el.value.trim();
      if (!text) continue;
      out[key] = def.split ? splitMetaValue(key, text) : text.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    }
    for (const line of others.value.split(/\r?\n/)) {
      const m = /^\s*([a-z0-9][a-z0-9.-]*)\s*[:：]\s*(.+)$/.exec(line);
      if (m) (out[m[1]!] ??= []).push(m[2]!.trim());
    }
    if (app.docFormat === "musicxml") {
      app.editScoreDoc((d) => {
        const s = d.songs[0];
        if (s) s.meta = Object.keys(out).length ? out : undefined;
      });
    } else {
      const text = app.getText();
      const next = replaceMetaLines(text, out);
      if (next !== text) app.setText(next);
    }
    app.setStatus("曲目信息已写回");
  });
}
