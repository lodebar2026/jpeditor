// App controller: CodeMirror editor <-> live relayout/render <-> paging <-> file I/O.
// Mirrors EditorController in CodeEditor.kt (doBind/tryLoad/updateLayout/paint/load/doSave).

import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState, EditorSelection } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { jpwHighlighter } from "./highlight";
import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { fromJpw } from "../score/jpwimport";
import { JinpuPainter } from "../layout/painter";
import { JpNumber, Lyric as LayoutLyric, TextFrame, type PageItem } from "../layout/layout";
import { Point } from "../common/geom";
import { MetaData } from "../smufl/smufl";
import { loadMusicXml } from "../score/musicxml";
import { abcToMusicXml } from "../abc/abc2xml";
import { scoreToJpwabc, scoreToJpwabcWithMeta, type JpwMeta, type JpwRange } from "../score/jpscore";
import { decodeJpwabc, encodeJpwabc, isTauriRuntime } from "./fileio";
import { MixedPainter } from "../mixed/painter";
import { recognizeImage, recognizeMusicppDetailed, agyAvailable, renderRecognitionSvg, renderRowPopup, renderHeaderPopup, type OmrMethod, type RecogView } from "../omr";
import type { Binary, RecognizedScore } from "../omr";

export class App {
  painter: JinpuPainter;
  view!: EditorView;
  scorePane: HTMLElement;
  pageEls: HTMLElement[] = [];
  pageIndex = 0;
  filePath: string | null = null;
  mode: "jp" | "mixed" | "recognize" = "jp";
  mixedXmlText: string | null = null;
  private _mixedPainter: MixedPainter | null = null;
  private _mixedBtnEl: HTMLButtonElement | null = null;
  // 识别模式：二值图 + 带源图坐标的识别结果（仅 musicpp 本地路产出），供叠加核对。
  private _recogBin: Binary | null = null;
  private _recogScore: RecognizedScore | null = null;
  private _recognizeBtnEl: HTMLButtonElement | null = null;
  // 识别视图（原位叠加/附近浮窗/仅原图）+ 下拉选择器 + 悬停浮窗 div。
  recogView: RecogView = "floating";
  private _recogViewSelectEl: HTMLSelectElement | null = null;
  private _recogPopupEl: HTMLDivElement | null = null;
  // 识别对象 → jpwabc 代码区间映射（导入时序列化产出，随编辑经 mapPos 迁移）。
  private _recogMeta: JpwMeta | null = null;
  private _lastImportMeta: JpwMeta | null = null; // 最近一次 xml 导入的序列化映射，供 recognizeBytes 接管
  // 乐句排版：缓存导入时的「原始排版」文本以便无损切回；_phraseOn 记当前是否乐句排版。
  private _phraseBtnEl: HTMLButtonElement | null = null;
  private _origLayoutText: string | null = null;
  private _phraseOn = false;
  private _readOnlyCompartment = new Compartment();
  // render settings (app-level, not part of the .jpwabc document)
  pageW = 960;
  pageH = 540;
  fontSize = 28;
  titleSize = 48;
  creditSize = 36;
  color = 0xff000000; // ARGB
  mixedHideBarNumber = false; // 混排：隐藏小节号
  zoom = 1; // 谱面显示缩放（应用到 #score-pane 的 --score-zoom）
  private meta: MetaData;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private zoomSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private selectedEl: SVGGElement | null = null;
  statusEl: HTMLElement | null = null;

  private static readonly SETTINGS_KEY = "jpeditor-render-settings";
  private static readonly LAST_FILE_KEY = "jpeditor-last-file";

  constructor(meta: MetaData, scorePane: HTMLElement) {
    this.meta = meta;
    this.painter = new JinpuPainter(this.fontSize);
    this.painter.layout.options.smuflMeta = meta;
    this.scorePane = scorePane;
  }

  /** Apply page-size / font-size / title-size / credit-size / color render settings and re-render. */
  applyRenderSettings(opts: { pageW?: number; pageH?: number; fontSize?: number; titleSize?: number; creditSize?: number; color?: number }): void {
    if (opts.pageW) this.pageW = opts.pageW;
    if (opts.pageH) this.pageH = opts.pageH;
    if (opts.color !== undefined) this.color = opts.color;
    if (opts.titleSize !== undefined) this.titleSize = opts.titleSize;
    if (opts.creditSize !== undefined) this.creditSize = opts.creditSize;
    if (opts.fontSize && opts.fontSize !== this.fontSize) {
      this.fontSize = opts.fontSize;
      const score = this.painter.score;
      this.painter = new JinpuPainter(this.fontSize);
      this.painter.layout.options.smuflMeta = this.meta;
      this.painter.score = score;
    }
    this.painter.layout.options.color = this.color;
    this.painter.layout.options.titleSize = this.titleSize;
    this.painter.layout.options.creditSize = this.creditSize;
    this.saveSettings();
    this.reload(this.getText());
  }

  /** Restore persisted render settings; call before mountEditor() so first render uses them. */
  loadSettings(): void {
    try {
      const raw = localStorage.getItem(App.SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<{
        pageW: number; pageH: number; fontSize: number;
        titleSize: number; creditSize: number; color: number; zoom: number;
        mixedHideBarNumber: boolean;
      }>;
      if (s.mixedHideBarNumber !== undefined) this.mixedHideBarNumber = s.mixedHideBarNumber;
      if (s.pageW) this.pageW = s.pageW;
      if (s.pageH) this.pageH = s.pageH;
      if (s.titleSize !== undefined) this.titleSize = s.titleSize;
      if (s.creditSize !== undefined) this.creditSize = s.creditSize;
      if (s.color !== undefined) this.color = s.color;
      if (s.zoom) this.zoom = s.zoom;
      this._applyZoom();
      if (s.fontSize && s.fontSize !== this.fontSize) {
        this.fontSize = s.fontSize;
        const score = this.painter.score;
        this.painter = new JinpuPainter(this.fontSize);
        this.painter.layout.options.smuflMeta = this.meta;
        this.painter.score = score;
      }
      this.painter.layout.options.color = this.color;
      this.painter.layout.options.titleSize = this.titleSize;
      this.painter.layout.options.creditSize = this.creditSize;
    } catch {
      // corrupt storage — ignore
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(App.SETTINGS_KEY, JSON.stringify({
        pageW: this.pageW,
        pageH: this.pageH,
        fontSize: this.fontSize,
        titleSize: this.titleSize,
        creditSize: this.creditSize,
        color: this.color,
        zoom: this.zoom,
        mixedHideBarNumber: this.mixedHideBarNumber,
      }));
    } catch {
      // storage unavailable — ignore
    }
  }

  // ---------------- zoom ----------------
  /** 设置谱面缩放（夹在 [0.25, 4]），持久化。 */
  setZoom(z: number): void {
    this.zoom = Math.min(4, Math.max(0.25, z));
    this._applyZoom();
    // 连续缩放（滚轮/捏合）期间不每帧写盘，停止后再持久化一次。
    clearTimeout(this.zoomSaveTimer);
    this.zoomSaveTimer = setTimeout(() => this.saveSettings(), 400);
  }
  zoomBy(factor: number): void {
    this.setZoom(this.zoom * factor);
  }
  resetZoom(): void {
    this.setZoom(1);
  }
  private _applyZoom(): void {
    this.scorePane.style.setProperty("--score-zoom", String(this.zoom));
  }

  mountEditor(parent: HTMLElement, initialText: string): void {
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        // 识别映射随用户编辑迁移偏移，保持点选仍落在正确 token。
        if (this._recogMeta) this._recogMeta = mapMeta(this._recogMeta, u.changes);
        this.scheduleReload();
      }
    });
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          jpwHighlighter,
          updateListener,
          this._readOnlyCompartment.of(EditorState.readOnly.of(false)),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-content": { fontFamily: "ui-monospace, Menlo, Consolas, monospace" },
          }),
        ],
      }),
    });
    this.reload(initialText);
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  setText(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
    // dispatch triggers updateListener -> scheduleReload, but reload now for snappiness
    this.reload(text);
  }

  private scheduleReload(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.reload(this.getText()), 200);
  }

  /** parse -> import -> layout -> render. Returns false on parse failure (text kept). */
  reload(text: string): boolean {
    // 混排/识别模式：谱面区显示各自专属视图，编辑文本不重排冲掉它。
    if (this.mode !== "jp") return true;
    let f: JpwFile | null;
    try {
      f = JpwFile.fromString(text);
    } catch {
      return false;
    }
    if (!f) return false;
    let score;
    try {
      score = fromJpw(f);
    } catch (e) {
      console.error("import failed", e);
      return false;
    }
    if (!score) return false;

    this.painter.score = score;
    const breakDesc = f.getSection(LayoutSection)?.desc ?? null;
    try {
      this.painter.resize(this.pageW, this.pageH, breakDesc);
    } catch (e) {
      console.error("layout failed", e);
      return false;
    }
    this.renderPages();
    return true;
  }

  private renderPages(): void {
    this.scorePane.replaceChildren();
    this.pageEls = [];
    this.selectedEl = null;
    for (let i = 0; i < this.painter.pageCount; i++) {
      const svg = this.painter.renderPage(i);
      const wrap = document.createElement("div");
      wrap.className = "score-page-wrap";
      wrap.appendChild(svg);
      const idx = i;
      svg.addEventListener("click", (e) => this.onPageClick(idx, svg, e));
      this.scorePane.appendChild(wrap);
      this.pageEls.push(wrap);
    }
    this.pageIndex = Math.min(this.pageIndex, Math.max(0, this.pageEls.length - 1));
  }

  // ---------------- picking / selection ----------------
  private onPageClick(pageIndex: number, svg: SVGSVGElement, ev: MouseEvent): void {
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    const picked = this.painter.pickPage(pageIndex, new Point(pt.x, pt.y));
    this.deselect();
    if (!picked) {
      this.setStatus("");
      return;
    }
    const target = picked.selectable ? picked : this.painter.entryGroupOf(picked);
    const el = this.painter.nodeMap.get(target);
    if (el) {
      el.classList.add("selected");
      this.selectedEl = el;
    }
    this.setStatus(describePick(picked));
  }

  private deselect(): void {
    this.selectedEl?.classList.remove("selected");
    this.selectedEl = null;
  }

  private setStatus(s: string): void {
    if (!this.statusEl) this.statusEl = document.getElementById("status");
    if (this.statusEl) this.statusEl.textContent = s;
  }

  // ---------------- paging ----------------
  goToPage(i: number): void {
    const np = Math.max(0, Math.min(i, this.pageEls.length - 1));
    this.pageIndex = np;
    this.pageEls[np]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  nextPage(): void {
    this.goToPage(this.pageIndex + 1);
  }
  prevPage(): void {
    this.goToPage(this.pageIndex - 1);
  }

  // ---------------- file I/O ----------------
  /** Decode bytes by extension: .xml/.musicxml -> import to .jpwabc; else UTF-16 .jpwabc. */
  importBytes(bytes: Uint8Array, name: string): void {
    // 任何新导入都使上一次的识别叠加产物失效（识别结果由 recognizeBytes 在本调用之后重设）。
    this._clearRecognition();
    // ABC 记谱：先用移植版 abc2xml 转成 MusicXML，再复用现有 MusicXML 导入路径。
    if (/\.abc$/i.test(name)) {
      const abcText = new TextDecoder(
        bytes[0] === 0xff || bytes[0] === 0xfe ? "utf-16" : "utf-8",
      ).decode(bytes);
      try {
        const xml = abcToMusicXml(abcText);
        bytes = new TextEncoder().encode(xml);
        name = name.replace(/\.abc$/i, ".musicxml");
      } catch (e) {
        console.error("ABC 转换失败", e);
        this.setStatus("ABC 转换失败：" + (e instanceof Error ? e.message : String(e)));
        return;
      }
    }
    if (/\.(xml|musicxml)$/i.test(name)) {
      const xml = new TextDecoder(
        bytes[0] === 0xff || bytes[0] === 0xfe ? "utf-16" : "utf-8",
      ).decode(bytes);
      this.mixedXmlText = xml;
      this._mixedPainter = null; // reset so next toggleMixed re-loads
      if (this._mixedBtnEl) this._mixedBtnEl.disabled = false;

      // 多声部（SATB 等）歌谱默认进入混排模式
      const autoMixed = this.mode !== "mixed" && isMultiPartXml(xml);
      if (this.mode === "mixed" || autoMixed) {
        if (autoMixed) {
          this.mode = "mixed";
          this._setMixedLayout(true);
          if (this._mixedBtnEl) this._mixedBtnEl.textContent = "简谱";
        }
        // 仍填充编辑器的简谱转换文本，便于切回「简谱」（best-effort）
        try {
          const score = loadMusicXml(xml);
          this.filePath = null;
          this._applyImportedJp(scoreToJpwabc(score));
        } catch (e) {
          console.error("jp import (for toggle) failed", e);
        }
        void this._renderMixedPages();
        return;
      }

      const score = loadMusicXml(xml);
      this.filePath = null; // imported; save as new .jpwabc
      const { text, meta } = scoreToJpwabcWithMeta(score);
      this._lastImportMeta = meta; // 供 recognizeBytes（OMR）接管为 _recogMeta
      this._applyImportedJp(text);
    } else {
      this.mixedXmlText = null;
      this._mixedPainter = null;
      if (this._mixedBtnEl) this._mixedBtnEl.disabled = true;
      this._disablePhrase();
      if (this.mode === "mixed") {
        this.mode = "jp";
        this._setMixedLayout(false);
        if (this._mixedBtnEl) this._mixedBtnEl.textContent = "混排";
      }
      this.setText(decodeJpwabc(bytes));
    }
  }

  /** 导入 MusicXML/OMR 得到的默认（原始排版）文本：缓存以便乐句排版无损切回，并启用切换按钮。 */
  private _applyImportedJp(text: string): void {
    this._origLayoutText = text;
    this._phraseOn = false;
    if (this._phraseBtnEl) { this._phraseBtnEl.disabled = false; this._phraseBtnEl.textContent = "乐句排版"; }
    this.setText(text);
  }

  private _disablePhrase(): void {
    this._origLayoutText = null;
    this._phraseOn = false;
    if (this._phraseBtnEl) { this._phraseBtnEl.disabled = true; this._phraseBtnEl.textContent = "乐句排版"; }
  }

  /** Register the #btn-phrase element so App can enable/disable it. */
  setPhraseBtn(el: HTMLButtonElement): void {
    this._phraseBtnEl = el;
  }

  /** 在「原始排版」与「乐句排版」间切换（保留原始排版文本，无损切回）。 */
  togglePhrase(): void {
    if (!this.mixedXmlText || !this._origLayoutText) return;
    // 乐句排版要看的是排版结果 → 先退出识别/混排叠加视图，回到简谱模式，否则 reload 直接返回不重排。
    if (this.mode === "recognize") {
      this.mode = "jp";
      this._setRecognizeLayout(false);
      if (this._recognizeBtnEl) this._recognizeBtnEl.textContent = "识别";
    } else if (this.mode === "mixed") {
      this.mode = "jp";
      this._setMixedLayout(false);
      if (this._mixedBtnEl) this._mixedBtnEl.textContent = "混排";
    }
    if (this._phraseOn) {
      this._phraseOn = false;
      if (this._phraseBtnEl) this._phraseBtnEl.textContent = "乐句排版";
      this.setText(this._origLayoutText);
    } else {
      try {
        const score = loadMusicXml(this.mixedXmlText);
        this.setText(scoreToJpwabc(score, { phrase: true }));
        this._phraseOn = true;
        if (this._phraseBtnEl) this._phraseBtnEl.textContent = "原始排版";
      } catch (e) {
        console.error("phrase relayout failed", e);
      }
    }
  }

  /** Register the #btn-mixed element so App can enable/disable it. */
  setMixedBtn(el: HTMLButtonElement): void {
    this._mixedBtnEl = el;
  }

  /** Register the #btn-recognize element so App can enable/disable it. */
  setRecognizeBtn(el: HTMLButtonElement): void {
    this._recognizeBtnEl = el;
  }

  /** Register the #sel-recog-view dropdown (识别视图切换)。 */
  setRecogViewSelect(el: HTMLSelectElement): void {
    this._recogViewSelectEl = el;
    el.value = this.recogView;
  }

  /** 切换识别视图（原位叠加/附近浮窗/仅原图）。识别模式下即时重渲。 */
  setRecogView(v: RecogView): void {
    this.recogView = v;
    if (this._recogViewSelectEl) this._recogViewSelectEl.value = v;
    if (this.mode === "recognize") this._renderRecognizePages();
  }

  /** 在「简谱模式」与「识别模式」（二值图+半透明识别叠加）之间切换。需先有 OMR 识别结果。 */
  async toggleRecognize(): Promise<void> {
    if (!this._recogScore || !this._recogBin) return;
    if (this.mode === "recognize") {
      this.mode = "jp";
      this._setRecognizeLayout(false);
      if (this._recognizeBtnEl) this._recognizeBtnEl.textContent = "识别";
      this.reload(this.getText());
    } else {
      // 从混排切入识别：先退混排布局
      if (this.mode === "mixed") this._setMixedLayout(false);
      this.mode = "recognize";
      this._setRecognizeLayout(true);
      if (this._recognizeBtnEl) this._recognizeBtnEl.textContent = "排版";
      this._renderRecognizePages();
    }
  }

  /** 识别模式布局钩子：打 body.recognize 类 + 显示/隐藏视图下拉。 */
  private _setRecognizeLayout(on: boolean): void {
    document.getElementById("body")?.classList.toggle("recognize", on);
    if (this._recogViewSelectEl) this._recogViewSelectEl.hidden = !on;
    if (!on) this._hideRecogPopup();
  }

  /** 渲染识别视图：二值图 + 识别结果 → 一张 SVG，沿用 score-page-wrap + zoom 容器。 */
  private _renderRecognizePages(): void {
    this.scorePane.replaceChildren();
    this.pageEls = [];
    this.selectedEl = null;
    this._recogPopupEl = null;
    if (!this._recogBin || !this._recogScore) return;
    const bin = this._recogBin;
    const svg = renderRecognitionSvg(bin, this._recogScore, this.recogView);
    const wrap = document.createElement("div");
    wrap.className = "score-page-wrap";
    wrap.style.position = "relative"; // 浮窗绝对定位相对此容器
    wrap.style.aspectRatio = `${bin.w} / ${bin.h}`;
    wrap.style.width = "calc(min(960px, 100%) * var(--score-zoom, 1))";
    wrap.appendChild(svg);
    this._wireRecognizeInteraction(svg, wrap);
    this.scorePane.appendChild(wrap);
    this.pageEls.push(wrap);
    this.pageIndex = 0;
  }

  /** 识别 SVG 交互：点选命中对象→选中对应 jpwabc 代码；悬停高亮；floating 视图弹行/页眉浮窗。 */
  private _wireRecognizeInteraction(svg: SVGSVGElement, wrap: HTMLDivElement): void {
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
      const range = this._rangeOfHit(r);
      if (range) this._selectCode(range);
      svg.querySelectorAll(".omr-hits rect.selected").forEach((x) => x.classList.remove("selected"));
      r.classList.add("selected");
    });

    svg.addEventListener("mousemove", (e) => {
      const r = hitOf(e.target);
      setHover(r);
      if (this.recogView === "floating") this._updateFloatingPopup(r, wrap);
    });
    svg.addEventListener("mouseleave", () => {
      setHover(null);
      if (this.recogView === "floating") this._hideRecogPopup();
    });
  }

  /** 命中 rect → jpwabc 代码区间（据 data-kind 查 _recogMeta）。 */
  private _rangeOfHit(r: SVGRectElement): { from: number; to: number } | null {
    const meta = this._recogMeta;
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
  private _selectCode(range: { from: number; to: number }): void {
    const len = this.view.state.doc.length;
    const from = Math.max(0, Math.min(range.from, len));
    const to = Math.max(from, Math.min(range.to, len));
    this.view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    this.view.focus();
  }

  /** floating 视图：悬停对象所在行→在该行相邻固定位置弹整行浮窗；页眉命中→弹整块页眉。 */
  private _updateFloatingPopup(r: SVGRectElement | null, wrap: HTMLDivElement): void {
    if (!this._recogBin || !this._recogScore) { this._hideRecogPopup(); return; }
    // 停在音符/歌词间隙（无命中）时保持当前浮窗，不隐藏——否则同 system 内移动光标会反复隐现闪烁。
    // 真正离开谱面由 svg 的 mouseleave 负责隐藏。
    if (!r) return;
    const bin = this._recogBin, score = this._recogScore;
    const kind = r.getAttribute("data-kind");
    let key: string;
    let r2: { svg: SVGSVGElement; srcTop: number; srcBottom: number };
    if (kind === "title" || kind === "author") {
      key = "header";
      r2 = renderHeaderPopup(bin, score);
    } else {
      const i = Number(r.getAttribute("data-i"));
      const ri = this._rowIndexOfFlat(i);
      key = "row" + ri;
      r2 = renderRowPopup(bin, score, ri);
    }
    // 同一行/页眉不重复重建。
    if (this._recogPopupEl?.dataset.key !== key) {
      this._showRecogPopup(r2.svg, key, wrap, bin, r2.srcTop, r2.srcBottom);
    }
  }

  private _showRecogPopup(content: SVGSVGElement, key: string, wrap: HTMLDivElement, bin: Binary, srcTop: number, srcBottom: number): void {
    let el = this._recogPopupEl;
    if (!el) {
      el = document.createElement("div");
      el.className = "omr-popup";
      wrap.appendChild(el);
      this._recogPopupEl = el;
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

  private _hideRecogPopup(): void {
    if (this._recogPopupEl) { this._recogPopupEl.style.display = "none"; delete this._recogPopupEl.dataset.key; }
  }

  /** flatten 音符下标 → 所属行下标。 */
  private _rowIndexOfFlat(i: number): number {
    if (!this._recogScore) return 0;
    let acc = 0;
    for (let ri = 0; ri < this._recogScore.rows.length; ri++) {
      const n = this._recogScore.rows[ri].nums.length;
      if (i < acc + n) return ri;
      acc += n;
    }
    return this._recogScore.rows.length - 1;
  }

  /** 清掉本次 OMR 的识别叠加产物并禁用识别按钮；若正处识别模式则退回简谱模式。 */
  private _clearRecognition(): void {
    this._recogBin = null;
    this._recogScore = null;
    this._recogMeta = null;
    this._hideRecogPopup();
    if (this._recognizeBtnEl) {
      this._recognizeBtnEl.disabled = true;
      this._recognizeBtnEl.textContent = "识别";
    }
    if (this.mode === "recognize") {
      this.mode = "jp";
      this._setRecognizeLayout(false);
    }
  }

  /** Toggle between JP mode and Mixed (五线谱+简谱) mode. */
  async toggleMixed(): Promise<void> {
    if (!this.mixedXmlText) return;
    if (this.mode === "jp") {
      this.mode = "mixed";
      this._setMixedLayout(true);
      if (this._mixedBtnEl) this._mixedBtnEl.textContent = "简谱";
      await this._renderMixedPages();
    } else {
      this.mode = "jp";
      this._setMixedLayout(false);
      if (this._mixedBtnEl) this._mixedBtnEl.textContent = "混排";
      this.reload(this.getText());
    }
  }

  /** 设置混排是否隐藏小节号，持久化；当前处于混排模式时立即重排。 */
  async setMixedHideBarNumber(on: boolean): Promise<void> {
    if (this.mixedHideBarNumber === on) return;
    this.mixedHideBarNumber = on;
    this.saveSettings();
    if (this.mode === "mixed") await this._renderMixedPages();
  }

  /** Mixed mode: editor read-only + hide the code pane entirely. */
  private _setMixedLayout(on: boolean): void {
    this.view.dispatch({
      effects: this._readOnlyCompartment.reconfigure(EditorState.readOnly.of(on)),
    });
    document.getElementById("body")?.classList.toggle("mixed", on);
  }

  private async _renderMixedPages(): Promise<void> {
    if (!this._mixedPainter) {
      this._mixedPainter = new MixedPainter();
    }
    this._mixedPainter.hideBarNumber = this.mixedHideBarNumber;
    if (this.mixedXmlText) {
      await this._mixedPainter.load(this.mixedXmlText);
    }
    // Portrait paper sized from the MusicXML page dimensions.
    const aspect = `${this._mixedPainter.pageWidthTenths} / ${this._mixedPainter.pageHeightTenths}`;
    this.scorePane.replaceChildren();
    this.pageEls = [];
    for (let i = 0; i < this._mixedPainter.pageCount; i++) {
      const svg = this._mixedPainter.renderPage(i);
      svg.style.width = "100%";
      svg.style.display = "block";
      const wrap = document.createElement("div");
      wrap.className = "score-page-wrap";
      wrap.style.aspectRatio = aspect;
      wrap.style.width = "calc(min(620px, 100%) * var(--score-zoom, 1))";
      wrap.appendChild(svg);
      this.scorePane.appendChild(wrap);
      this.pageEls.push(wrap);
    }
    this.pageIndex = 0;
  }

  /** 记住上次打开/保存的文件路径（仅 Tauri：浏览器路径不可复读）。 */
  rememberLastFile(path: string): void {
    try {
      localStorage.setItem(App.LAST_FILE_KEY, path);
    } catch {
      // storage unavailable — ignore
    }
  }

  private clearLastFile(): void {
    try {
      localStorage.removeItem(App.LAST_FILE_KEY);
    } catch {
      // ignore
    }
  }

  /** 启动时尝试复读上次打开的文件（仅 Tauri）。返回 true 表示已加载，false 则保持示例文本。 */
  async tryRestoreLastFile(): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    let path: string | null;
    try {
      path = localStorage.getItem(App.LAST_FILE_KEY);
    } catch {
      return false;
    }
    if (!path) return false;
    try {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const bytes = await readFile(path);
      this.importBytes(bytes, path);
      if (!/\.(xml|musicxml)$/i.test(path)) this.filePath = path;
      return true;
    } catch {
      // 文件已被移动/删除/不可读 — 忘掉它，回退到示例
      this.clearLastFile();
      return false;
    }
  }

  async openFile(): Promise<void> {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const sel = await open({
        multiple: false,
        filters: [{ name: "简谱 / MusicXML / ABC", extensions: ["jpwabc", "JPWABC", "xml", "musicxml", "abc"] }],
      });
      if (typeof sel !== "string") return;
      const bytes = await readFile(sel);
      this.importBytes(bytes, sel);
      if (!/\.(xml|musicxml|abc)$/i.test(sel)) this.filePath = sel;
      this.rememberLastFile(sel);
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".jpwabc,.xml,.musicxml,.abc";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const buf = new Uint8Array(await file.arrayBuffer());
        this.importBytes(buf, file.name);
        if (!/\.(xml|musicxml|abc)$/i.test(file.name)) this.filePath = file.name;
      };
      input.click();
    }
  }

  // ---------------- OMR：从图片识别简谱 ----------------
  /** 已取得图片字节后的识别核心（供拖拽识别复用）。
   *  musicpp 本地路额外保留二值图+识别结果并自动进入识别模式叠加核对；gemini 路只导入排版。 */
  async recognizeBytes(method: OmrMethod, picked: { bytes: Uint8Array; mime?: string; path?: string | null }): Promise<void> {
    if (method === "gemini" && !agyAvailable()) {
      this.setStatus("Gemini 识别需要桌面版（Antigravity CLI / agy），浏览器内不可用");
      return;
    }
    const label = method === "gemini" ? "Gemini" : "musicpp";
    this.setStatus(`识别中（${label}）…可能需要几十秒`);
    try {
      const t0 = performance.now();
      if (method === "musicpp") {
        const { musicxml, bin, score } = await recognizeMusicppDetailed(picked.bytes, picked.mime);
        this.importBytes(new TextEncoder().encode(musicxml), "omr.musicxml"); // 先导入（会清旧识别）
        this._recogBin = bin; // 再设本次识别产物
        this._recogScore = score;
        this._recogMeta = this._lastImportMeta; // 接管导入时序列化产出的代码区间映射
        if (this._recognizeBtnEl) this._recognizeBtnEl.disabled = false;
        if (this.mode !== "recognize") await this.toggleRecognize(); // 自动进识别模式叠加
        this.setStatus(`识别完成（${label}，${((performance.now() - t0) / 1000).toFixed(1)}s）`);
      } else {
        const { musicxml, ms } = await recognizeImage(method, picked);
        this.importBytes(new TextEncoder().encode(musicxml), "omr.musicxml");
        this.setStatus(`识别完成（${label}，${(ms / 1000).toFixed(1)}s）`);
      }
    } catch (e) {
      console.error("OMR failed", e);
      this.setStatus("识别失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  async saveFile(): Promise<void> {
    if (this.filePath && isTauriRuntime()) {
      await this.writeTo(this.filePath);
      return;
    }
    await this.saveFileAs();
  }

  async saveFileAs(): Promise<void> {
    const name = (this.painter.score.title.split("\n")[0] || "未命名") + ".jpwabc";
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({ defaultPath: name });
      if (!dest) return;
      await this.writeTo(dest);
      this.filePath = dest;
      this.rememberLastFile(dest);
    } else {
      const blob = new Blob([encodeJpwabc(this.getText())], {
        type: "application/octet-stream",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }

  private async writeTo(path: string): Promise<void> {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(path, encodeJpwabc(this.getText()));
  }

  /** Load dropped file content (already decoded). */
  loadText(text: string, path: string | null): void {
    this.filePath = path;
    this.setText(text);
  }

  /** Set LinesPerPage in the document's .Layout section (empty string clears it). */
  setLinesPerPage(value: string): void {
    this.setText(upsertLayoutLines(this.getText(), value));
  }

  /** Current LinesPerPage value from the document, if any. */
  getLinesPerPage(): string {
    const f = JpwFile.fromString(this.getText());
    return f?.getSection(LayoutSection)?.linesPerPage?.trim() ?? "";
  }
}

/** Insert/update/remove `LinesPerPage = N` within a `.Layout` section. */
function upsertLayoutLines(doc: string, value: string): string {
  const lines = doc.split("\n");
  const isSection = (l: string) => l.startsWith(".");
  let layoutAt = lines.findIndex((l) => l.trim().toLowerCase() === ".layout");

  if (layoutAt < 0) {
    if (!value) return doc;
    const block = lines[lines.length - 1] === "" ? "" : "\n";
    return doc + `${block}.Layout\nLinesPerPage = ${value}\n`;
  }
  // find section body bounds
  let end = layoutAt + 1;
  while (end < lines.length && !isSection(lines[end])) end++;
  let lpIdx = -1;
  for (let i = layoutAt + 1; i < end; i++) {
    if (lines[i].toLowerCase().includes("linesperpage")) lpIdx = i;
  }
  if (!value) {
    if (lpIdx >= 0) lines.splice(lpIdx, 1);
    return lines.join("\n");
  }
  if (lpIdx >= 0) lines[lpIdx] = `LinesPerPage = ${value}`;
  else lines.splice(layoutAt + 1, 0, `LinesPerPage = ${value}`);
  return lines.join("\n");
}

function describePick(item: PageItem): string {
  if (item instanceof LayoutLyric) return `歌词: ${item.text}`;
  if (item instanceof JpNumber) return `音符: ${item.text}`;
  if (item instanceof TextFrame) return `文本: ${item.text}`;
  const cls = [...item.classes].filter((c) => c !== "entry");
  return cls.length ? `已选: ${cls.join(",")}` : "已选: 元素";
}

/** 判断 MusicXML 是否多声部（≥2 part、单 part 多谱表、或 ≥2 voice）→ 默认混排。 */
function isMultiPartXml(xml: string): boolean {
  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return false;
    if (doc.getElementsByTagName("score-part").length >= 2) return true;
    for (const s of Array.from(doc.getElementsByTagName("staves"))) {
      if (parseInt(s.textContent ?? "1", 10) >= 2) return true;
    }
    const voices = new Set<string>();
    for (const v of Array.from(doc.getElementsByTagName("voice"))) {
      const t = v.textContent?.trim();
      if (t) voices.add(t);
    }
    return voices.size >= 2;
  } catch {
    return false;
  }
}

/** 把识别映射的所有代码区间经 CodeMirror 变更集迁移到新文档位置（保持编辑后点选仍准）。 */
function mapMeta(meta: JpwMeta, ch: { mapPos(pos: number, assoc?: number): number }): JpwMeta {
  const mr = (r: JpwRange): JpwRange => ({ from: ch.mapPos(r.from, 1), to: ch.mapPos(r.to, -1) });
  return {
    noteRanges: meta.noteRanges.map(mr),
    lyricRanges: meta.lyricRanges.map((m) => {
      const nm = new Map<number, JpwRange>();
      for (const [k, v] of m) nm.set(k, mr(v));
      return nm;
    }),
    titleRange: meta.titleRange ? mr(meta.titleRange) : undefined,
    authorRanges: meta.authorRanges.map((a) => ({ text: a.text, range: mr(a.range) })),
  };
}
