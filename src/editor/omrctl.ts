// 简谱 OMR 的编辑器侧控制器：识别 → 出文本 → 叠加核对视图 → 点选定位。
//
// 从 App 里整体切出来的一块。它自己拿着识别产物（二值图 / RecognizedScore / 代码区间映射 /
// 输出格式）与那几个工具条控件，只通过下面的 OmrHost 向 App 要能力——**故意把这个接口
// 列全**：它就是「识别这摊事到底依赖编辑器多少东西」的清单，越短越好，加东西前先想想。
//
// 识别产物的关键性质：`RecognizedScore` 与输出格式无关，留在内存里；换格式只重走
// omr/emit.ts 的 emitter，绝不重跑识别。
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  recognizeMusicppDetailed, renderRecognitionSvg, renderRowPopup, renderHeaderPopup,
  OMR_EMITTERS, DEFAULT_OMR_FORMAT, isOmrFormat, omrEmitter,
  type OmrFormat, type RecogView,
} from "../omr";
import type { Binary, RecognizedScore } from "../omr";
import type { JpwMeta } from "../score/jpscore";
import { showConfirmDialog } from "./dialogs";

/** 是否 PDF 字节（mime 或 `%PDF-` 魔数）。与 `omr/decode.ts` 里那份同判据。 */
function isPdfBytes(bytes: Uint8Array, mime?: string): boolean {
  if (mime === "application/pdf") return true;
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/** OmrController 向编辑器要的全部能力。 */
export interface OmrHost {
  /** 当前预览模式。识别模式期间为 "recognize"。 */
  readonly mode: "jp" | "mixed" | "recognize";
  /** 编辑器里的 CodeMirror 视图（点选定位要用）。 */
  readonly view: EditorView;
  /** 最近一次 MusicXML 导入产出的代码区间映射（jpwabc 那条路的 meta 从这儿接管）。 */
  readonly lastImportMeta: JpwMeta | null;

  getText(): string;
  setText(text: string): void;
  setStatus(text: string): void;
  saveSettings(): void;
  stopPlayback(): void;
  /** 重新解析并排版（退出识别模式时回到排版稿）。 */
  reload(text: string): void;
  /** 走 MusicXML/jpwabc 导入路径落地产物。 */
  importBytes(bytes: Uint8Array, name: string): void;
  /**
   * 五线谱识别产物落地：MusicXML → **混排视图**。
   *
   * 不能走 `importBytes`：那条路对单声部 MusicXML 会转成简谱 Score，
   * 而五线谱的和弦、多声部、slur 在 `.jpwabc`/Score 里装不下
   * （单声部时它直接抛 `measure has no chord`）。
   */
  adoptStaffXml(xml: string): boolean;

  /** 清空 #score-pane 与翻页状态（各预览铺页前都要做）。 */
  clearPages(): void;
  /** 铺页（见 App._renderPagesWith）。 */
  renderPagesWith(
    count: number,
    svgOf: (i: number) => SVGSVGElement,
    opts?: {
      aspectRatio?: (i: number) => string;
      width?: string;
      position?: string;
      onPage?: (svg: SVGSVGElement, wrap: HTMLDivElement, i: number) => void;
      resetPageIndex?: boolean;
    },
  ): void;

  /** 进入/退出识别模式（改 mode、退混排布局、停播放）。 */
  setRecognizeMode(on: boolean): void;
  /** 文本谱产物落地前的清场：丢掉混排底本、切 docFormat、清文件路径。 */
  adoptPuText(text: string): void;
  /** 上下文相关控件的显隐（工具条）。 */
  setContextControl(el: Element | null, on: boolean): void;
  syncContextGroup(el: Element | null | undefined): void;
}

export class OmrController {
  /** 识别模式：二值图 + 带源图坐标的识别结果，供叠加核对。 */
  private bin: Binary | null = null;
  private score: RecognizedScore | null = null;
  private btnEl: HTMLButtonElement | null = null;
  /** 叠加视图样式（原位叠加 / 附近浮窗 / 仅原图）。 */
  view: RecogView = "floating";
  private viewSelectEl: HTMLSelectElement | null = null;
  private popupEl: HTMLDivElement | null = null;
  /** 「音符/歌词/标题/著作者 → 编辑器代码区间」映射，点选定位用。 */
  private meta: JpwMeta | null = null;
  /** 识别结果的输出格式。产物本身与格式无关，切换只是重出文本，不重跑识别。 */
  format: OmrFormat = DEFAULT_OMR_FORMAT;
  private formatSelectEl: HTMLSelectElement | null = null;
  private formatFieldEl: HTMLElement | null = null;
  /** 上次由识别产出的文本；与当前文本不同即说明用户手改过。 */
  private emitted: string | null = null;

  constructor(private host: OmrHost) {}

  /** 是否有可核对的识别产物。 */
  get hasResult(): boolean {
    return this.score !== null && this.bin !== null;
  }

  // ---------------- 持久化 ----------------
  loadSettings(s: { omrFormat?: unknown; recogView?: unknown }): void {
    if (isOmrFormat(s.omrFormat)) this.format = s.omrFormat;
  }

  /** 编辑器改动时同步代码区间映射（CodeMirror 的 changes 映射）。 */
  remapMeta(map: (m: JpwMeta) => JpwMeta): void {
    if (this.meta) this.meta = map(this.meta);
  }

  // ---------------- 工具条绑定 ----------------
  /** Register the #btn-recognize element so App can enable/disable it. */
  setRecognizeBtn(el: HTMLButtonElement): void {
    this.btnEl = el;
    this.host.setContextControl(el, false);
  }

  /** Register the #sel-recog-view dropdown (识别视图切换)。 */
  setRecogViewSelect(el: HTMLSelectElement): void {
    this.viewSelectEl = el;
    el.value = this.view;
  }

  /** 注册识别输出格式下拉（选项由这里填，同 bindSpeedSelect 的写法）。 */
  bindFormatSelect(el: HTMLSelectElement): void {
    this.formatSelectEl = el;
    this.formatFieldEl = el.closest(".toolbar-select-field") ?? el;
    el.replaceChildren();
    for (const { id, label } of OMR_EMITTERS) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = label;
      el.appendChild(opt);
    }
    this.syncFormatSelect();
    el.addEventListener("change", () => void this.setFormat(el.value as OmrFormat));
    this.host.setContextControl(this.formatFieldEl, this.score !== null);
  }

  private syncFormatSelect(): void {
    if (this.formatSelectEl) this.formatSelectEl.value = this.format;
  }

  /** 切换识别视图（原位叠加/附近浮窗/仅原图）。识别模式下即时重渲。 */
  setRecogView(v: RecogView): void {
    this.view = v;
    if (this.viewSelectEl) this.viewSelectEl.value = v;
    if (this.host.mode === "recognize") this.renderPages();
  }

  /** 切换识别输出格式：有识别结果就地重出文本（不重跑识别），并持久化选择。 */
  async setFormat(format: OmrFormat): Promise<void> {
    if (this.format === format) return;
    const rec = this.score;
    const bin = this.bin;
    if (rec && bin && this.emitted !== null && this.host.getText() !== this.emitted) {
      const ok = await showConfirmDialog(
        "切换输出格式",
        "源码已手工修改过。切换格式会用识别结果重新生成文本，这些修改将丢失。要继续吗？",
      );
      if (!ok) {
        this.syncFormatSelect(); // 用户取消：把下拉拨回原值
        return;
      }
    }
    this.format = format;
    this.host.saveSettings();
    this.syncFormatSelect();
    if (rec && bin) {
      // 保持当前预览模式（对照 / 简谱），只换文本——切格式不该把用户踢出正在看的视图。
      const wasRecognize = this.host.mode === "recognize";
      this.emit(rec, bin);
      if (wasRecognize && this.host.mode !== "recognize") await this.toggle();
      this.host.setStatus(`已切换输出格式：${omrEmitter(format).label}（未重新识别）`);
    }
  }

  // ---------------- 识别 ----------------
  /** 已取得图片字节后的识别核心（供拖拽识别复用）。
   *  保留二值图+识别结果，完成后默认进入叠加核对视图（先核对；「原图对照」可切回排版稿）。 */
  async recognizeBytes(picked: { bytes: Uint8Array; mime?: string }): Promise<boolean> {
    this.host.setStatus("识别中…可能需要几十秒");
    try {
      const t0 = performance.now();
      // **文字层完整的五线谱 PDF** 走另一条路（src/staffomr/）：不栅格化、直接读文字与矢量，
      // 出 MusicXML。判据见 staffomr/browser.ts::isStaffPdf。
      if (isPdfBytes(picked.bytes, picked.mime) && (await this.tryStaffPdf(picked.bytes, t0))) return true;
      const { bin, score } = await recognizeMusicppDetailed(picked.bytes, picked.mime);
      this.emit(score, bin);
      if (this.host.mode !== "recognize") await this.toggle(); // 识别后默认进叠加核对（本仓库「先核对」取向）
      this.host.setStatus(`识别完成（${((performance.now() - t0) / 1000).toFixed(1)}s）`);
      return true;
    } catch (e) {
      console.error("OMR failed", e);
      this.host.setStatus("识别失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  }

  /**
   * 五线谱 PDF 那条路：识别 → MusicXML → 走导入路径落地。
   *
   * 与简谱那条路的分工写在 `staffomr/browser.ts` 开头。识别不出谱表就返回 false，
   * 让调用方继续走简谱那条（该 PDF 多半是扫描件或简谱）。
   */
  private async tryStaffPdf(bytes: Uint8Array, t0: number): Promise<boolean> {
    const { openStaffPdf, isStaffPdf, recognizeStaffPdf } = await import("../staffomr/browser");
    let ok = false;
    try {
      const { pdf, OPS } = await openStaffPdf(bytes);
      ok = await isStaffPdf(pdf, OPS);
      pdf.destroy?.();
    } catch {
      return false;
    }
    if (!ok) return false;
    const res = await recognizeStaffPdf(bytes, {
      onProgress: (done, total) => this.host.setStatus(`五线谱识别中… ${done}/${total} 页`),
    });
    if (!res.notes) {
      this.host.setStatus("这份 PDF 里没找到五线谱");
      return false;
    }
    // 五线谱只出 MusicXML，且只进混排视图（理由见 OmrHost.adoptStaffXml）。
    this.clear();
    const jpOk = this.host.adoptStaffXml(res.musicxml);
    this.host.setStatus(
      `五线谱识别完成（${((performance.now() - t0) / 1000).toFixed(1)}s）：` +
        `${res.pages} 页 / ${res.parts} 个声部 / ${res.notes} 个音符` +
        (res.skipped ? `，${res.skipped} 页无谱表已跳过` : "") +
        (jpOk ? "" : "；简谱文本未变——五线谱装不进 .jpwabc，请从「导出 → MusicXML」取产物"),
    );
    return true;
  }

  /**
   * 把一份识别结果按当前输出格式出成编辑器文本。格式清单与各自的产出在 omr/emit.ts 的
   * 注册表里，这里只管把产物落到编辑器（两种落法：走 MusicXML 导入路径，或直接设文本）。
   * **不重跑识别。**
   *
   * 各 emitter 的 meta 都按同一套音符序（flatten(rows[].nums)）编号，
   * 所以「原图对照」的点选定位对所有格式通用（见 rangeOfHit）。
   */
  private emit(rec: RecognizedScore, bin: Binary): void {
    const out = omrEmitter(this.format).emit(rec);
    if (out.kind === "musicxml") {
      // importBytes 开头会 clear()，故必须先导入、后回填本次产物。
      this.host.importBytes(new TextEncoder().encode(out.text), "omr.musicxml");
      this.meta = this.host.lastImportMeta; // 接管导入时序列化产出的代码区间映射
    } else {
      this.clear();
      this.host.adoptPuText(out.text);
      this.meta = out.meta;
    }
    this.bin = bin;
    this.score = rec;
    this.emitted = this.host.getText();
    if (this.btnEl) this.btnEl.textContent = "原图对照";
    this.host.setContextControl(this.btnEl, true);
    this.host.setContextControl(this.formatFieldEl, true);
  }

  // ---------------- 核对视图 ----------------
  /** 在「简谱模式」与「识别模式」（二值图+半透明识别叠加）之间切换。需先有 OMR 识别结果。 */
  async toggle(): Promise<void> {
    if (!this.hasResult) return;
    this.host.stopPlayback();
    if (this.host.mode === "recognize") {
      this.host.setRecognizeMode(false);
      this.setLayout(false);
      if (this.btnEl) this.btnEl.textContent = "原图对照";
      this.host.reload(this.host.getText());
    } else {
      this.host.setRecognizeMode(true);
      this.setLayout(true);
      if (this.btnEl) this.btnEl.textContent = "返回排版稿";
      this.renderPages();
    }
  }

  /** 识别模式布局钩子：打 body.recognize 类 + 显示/隐藏视图下拉。 */
  private setLayout(on: boolean): void {
    document.getElementById("body")?.classList.toggle("recognize", on);
    const field = this.viewSelectEl?.closest<HTMLElement>(".toolbar-select-field");
    if (field) field.hidden = !on;
    else if (this.viewSelectEl) this.viewSelectEl.hidden = !on;
    this.host.syncContextGroup(this.btnEl ?? field ?? this.viewSelectEl);
    if (!on) this.hidePopup();
  }

  /** 退出识别模式时的布局收尾（App 从别的入口切走预览模式时调用）。 */
  leaveLayout(): void {
    this.setLayout(false);
  }

  /** 渲染识别视图：二值图 + 识别结果 → 一张 SVG，沿用 score-page-wrap + zoom 容器。 */
  renderPages(): void {
    this.host.clearPages();
    this.popupEl = null;
    if (!this.bin || !this.score) return;
    const bin = this.bin;
    const score = this.score;
    this.host.renderPagesWith(1, () => renderRecognitionSvg(bin, score, this.view), {
      aspectRatio: () => `${bin.w} / ${bin.h}`,
      width: "calc(min(960px, 100%) * var(--score-zoom, 1))",
      position: "relative", // 浮窗绝对定位相对此容器
      onPage: (svg, wrap) => this.wireInteraction(svg, wrap),
      resetPageIndex: true,
    });
  }

  /** 识别 SVG 交互：点选命中对象→选中对应 jpwabc 代码；悬停高亮；floating 视图弹行/页眉浮窗。 */
  private wireInteraction(svg: SVGSVGElement, wrap: HTMLDivElement): void {
    const hitOf = (t: EventTarget | null): SVGRectElement | null =>
      (t instanceof Element ? t.closest(".omr-hits rect") : null) as SVGRectElement | null;

    let hovered: SVGRectElement | null = null;
    const setHover = (r: SVGRectElement | null): void => {
      if (hovered === r) return;
      hovered?.classList.remove("omr-hover");
      hovered = r;
      hovered?.classList.add("omr-hover");
    };

    svg.addEventListener("click", (e) => {
      const r = hitOf(e.target);
      if (!r) return;
      const range = this.rangeOfHit(r);
      if (range) this.selectCode(range);
      svg.querySelectorAll(".omr-hits rect.selected").forEach((x) => x.classList.remove("selected"));
      r.classList.add("selected");
    });

    svg.addEventListener("mousemove", (e) => {
      const r = hitOf(e.target);
      setHover(r);
      if (this.view === "floating") this.updateFloatingPopup(r, wrap);
    });
    svg.addEventListener("mouseleave", () => {
      setHover(null);
      if (this.view === "floating") this.hidePopup();
    });
  }

  /** 命中 rect → 编辑器代码区间（据 data-kind 查 meta）。 */
  private rangeOfHit(r: SVGRectElement): { from: number; to: number } | null {
    const meta = this.meta;
    if (!meta) return null;
    const kind = r.getAttribute("data-kind");
    if (kind === "note") {
      const i = Number(r.getAttribute("data-i"));
      return meta.noteRanges[i] ?? null;
    }
    if (kind === "lyric") {
      const i = Number(r.getAttribute("data-i"));
      const v = Number(r.getAttribute("data-verse"));
      return meta.lyricRanges[i]?.get(v) ?? null;
    }
    if (kind === "title") return meta.titleRange ?? null;
    if (kind === "author") {
      const text = (r.getAttribute("data-text") ?? "").trim();
      const a = meta.authorRanges.find((x) => x.text.trim() === text)
        ?? meta.authorRanges.find((x) => text.includes(x.text.trim()) || x.text.trim().includes(text));
      return a?.range ?? null;
    }
    return null;
  }

  /** 选中并滚动到编辑器里的代码区间。 */
  private selectCode(range: { from: number; to: number }): void {
    const view = this.host.view;
    const len = view.state.doc.length;
    const from = Math.max(0, Math.min(range.from, len));
    const to = Math.max(from, Math.min(range.to, len));
    view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    view.focus();
  }

  /** floating 视图：悬停对象所在行→在该行相邻固定位置弹整行浮窗；页眉命中→弹整块页眉。 */
  private updateFloatingPopup(r: SVGRectElement | null, wrap: HTMLDivElement): void {
    if (!this.bin || !this.score) { this.hidePopup(); return; }
    // 停在音符/歌词间隙（无命中）时保持当前浮窗，不隐藏——否则同 system 内移动光标会反复隐现闪烁。
    // 真正离开谱面由 svg 的 mouseleave 负责隐藏。
    if (!r) return;
    const bin = this.bin, score = this.score;
    const kind = r.getAttribute("data-kind");
    let key: string;
    let r2: { svg: SVGSVGElement; srcTop: number; srcBottom: number };
    if (kind === "title" || kind === "author") {
      key = "header";
      r2 = renderHeaderPopup(bin, score);
    } else {
      const i = Number(r.getAttribute("data-i"));
      const ri = this.rowIndexOfFlat(i);
      key = "row" + ri;
      r2 = renderRowPopup(bin, score, ri);
    }
    // 同一行/页眉不重复重建。
    if (this.popupEl?.dataset.key !== key) {
      this.showPopup(r2.svg, key, wrap, bin, r2.srcTop, r2.srcBottom);
    }
  }

  private showPopup(content: SVGSVGElement, key: string, wrap: HTMLDivElement, bin: Binary, srcTop: number, srcBottom: number): void {
    let el = this.popupEl;
    if (!el) {
      el = document.createElement("div");
      el.className = "omr-popup";
      wrap.appendChild(el);
      this.popupEl = el;
    }
    el.dataset.key = key;
    el.replaceChildren(content);
    el.style.display = "block";
    // 定位到**当前 system 之下**（srcBottom 已含本行歌词带底，故浮窗不盖当前行歌词）；
    // 靠近底部则翻到当前行之上。浮窗整幅宽、列与源图对齐，便于逐音对比。
    const topPct = (srcBottom / bin.h) * 100;
    const botPct = (srcTop / bin.h) * 100;
    if (topPct < 82) {
      el.style.top = `${topPct}%`;
      el.style.bottom = "auto";
    } else {
      el.style.bottom = `${100 - botPct}%`;
      el.style.top = "auto";
    }
  }

  private hidePopup(): void {
    if (this.popupEl) { this.popupEl.style.display = "none"; delete this.popupEl.dataset.key; }
  }

  /** flatten 音符下标 → 所属行下标。 */
  private rowIndexOfFlat(i: number): number {
    if (!this.score) return 0;
    let acc = 0;
    for (let ri = 0; ri < this.score.rows.length; ri++) {
      const n = this.score.rows[ri].nums.length;
      if (i < acc + n) return ri;
      acc += n;
    }
    return this.score.rows.length - 1;
  }

  /** 清掉本次 OMR 的识别叠加产物并禁用识别按钮；若正处识别模式则退回简谱模式。 */
  clear(): void {
    this.bin = null;
    this.score = null;
    this.meta = null;
    this.emitted = null;
    this.host.setContextControl(this.formatFieldEl, false);
    this.hidePopup();
    if (this.btnEl) this.btnEl.textContent = "原图对照";
    this.host.setContextControl(this.btnEl, false);
    if (this.host.mode === "recognize") {
      this.host.setRecognizeMode(false);
      this.setLayout(false);
    }
  }
}
