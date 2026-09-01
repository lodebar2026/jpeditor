// App controller: CodeMirror editor <-> live relayout/render <-> paging <-> file I/O.
// Mirrors EditorController in CodeEditor.kt (doBind/tryLoad/updateLayout/paint/load/doSave).

import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { jpwHighlighter } from "./highlight";
import { puHighlighter } from "../pu/highlight";
import { PuPainter } from "../pu/painter";
import { parsePu, puToScore, sniffDialect, dialectSpec, type Dialect } from "../pu";
import { Chord, type Score } from "../score/score";
import type { NoteElement as PuNoteElement, PuDoc } from "../pu";
import type { PageProfileName } from "../pu/metrics";
import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { fromJpw } from "../score/jpwimport";
import { JinpuPainter } from "../layout/painter";
import { JpNumber, Lyric as LayoutLyric, TextFrame, type PageItem } from "../layout/layout";
import { Point } from "../common/geom";
import { MetaData } from "../smufl/smufl";
import { loadMusicXml } from "../score/musicxml";
import { abcToMusicXml } from "../abc/abc2xml";
import { scoreToJpwabc, scoreToJpwabcWithMeta, type JpwMeta, type JpwRange } from "../score/jpscore";
import { convertJpwabc, detectDirection, type HanDirection } from "../jpword/hanconv";
import { decodeJpwabc, encodeJpwabc, isTauriRuntime, saveBytes, writeBytesInPlace } from "./fileio";
import { TokenData } from "../jpword/tokens";
import { JpwabcLexer } from "../jpword/parse";
import { DOC_EXT, acceptAttr, isPuFile } from "../common/filetypes";
import { MixedPainter } from "../mixed/painter";
import { PlaybackController, type PlaybackHost } from "./playback";
import { OmrController, type OmrHost } from "./omrctl";
import {
  loadPersistedSettings, savePersistedSettings, loadLastFile, saveLastFile, clearLastFile,
} from "./settings";
export type { OmrFormat } from "../omr";

/** 文本谱的扩展名。`.txt` 太泛，靠 sniffDialect 兜底，认不出就不动。 */

export class App implements OmrHost, PlaybackHost {
  painter: JinpuPainter;
  view!: EditorView;
  scorePane: HTMLElement;
  pageEls: HTMLElement[] = [];
  pageIndex = 0;
  filePath: string | null = null;
  mode: "jp" | "mixed" | "recognize" = "jp";
  /** 当前编辑的是哪种源格式：`.jpwabc` 还是文本谱（番茄 / 诗歌本）。 */
  docFormat: "jpwabc" | "pu" = "jpwabc";
  /** 文本谱的版面：原版 A4 / PPT 16:9。 */
  puProfile: PageProfileName = "print";
  private _puPainter: PuPainter | null = null;
  /** 已解析出的文本谱方言，用于代码区标签（解析前未知）。 */
  private _puDialect: Dialect | null = null;
  /** 上次解析结果的缓存（同一份文本不重复解析）。 */
  private _puDoc: { text: string; doc: PuDoc } | null = null;
  /** 上次转出的 Score 及「Chord → AST 音符」的对照（试听逐字高亮靠它搭桥）。 */
  private _puScoreCache: {
    text: string;
    score: Score | null;
    noteMap: Map<Chord, PuNoteElement>;
  } | null = null;
  private _puHighlightCompartment = new Compartment();
  private _puProfileSwitchEl: HTMLElement | null = null;
  private _puPrintBtnEl: HTMLButtonElement | null = null;
  private _puSlideBtnEl: HTMLButtonElement | null = null;
  mixedXmlText: string | null = null;
  private _mixedPainter: MixedPainter | null = null;
  private _mixedBtnEl: HTMLButtonElement | null = null;
  private _jpPreviewBtnEl: HTMLButtonElement | null = null;
  private _staffJianpuToggleEl: HTMLInputElement | null = null;
  /** 简谱 OMR 的那一摊（识别、叠加核对、点选定位、输出格式）——见 editor/omrctl.ts。 */
  readonly omr: OmrController = new OmrController(this);
  /** 最近一次 xml 导入的序列化映射，供 OmrController 接管为它的点选映射。 */
  private _lastImportMeta: JpwMeta | null = null;
  // 乐句排版：缓存导入时的「原始排版」文本以便无损切回；_phraseOn 记当前是否乐句排版。
  private _originalLayoutBtnEl: HTMLButtonElement | null = null;
  private _phraseBtnEl: HTMLButtonElement | null = null;
  private _origLayoutText: string | null = null;
  private _phraseOn = false;
  private _hanziBtnEl: HTMLButtonElement | null = null;
  private _readOnlyCompartment = new Compartment();
  // render settings (app-level, not part of the .jpwabc document)
  pageW = 960;
  pageH = 540;
  fontSize = 28;
  titleSize = 48;
  creditSize = 36;
  color = 0xff000000; // ARGB
  mixedHideBarNumber = false; // 混排：隐藏小节号
  mixedShowJianpuLayer = true;
  zoom = 1; // 谱面显示缩放（应用到 #score-pane 的 --score-zoom）
  /** SMuFL 字体元数据。help.ts 渲染记谱法示例时也要用同一份。 */
  readonly meta: MetaData;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private zoomSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private selectedEl: SVGGElement | null = null;
  statusEl: HTMLElement | null = null;
  /** 试听播放的那一摊（播放器、速度倍率、分声部音量）——见 editor/playback.ts。 */
  readonly playback: PlaybackController = new PlaybackController(this);
  /** 试听/导出 MIDI 的速度倍率（1 = 谱面标注速度）。持久化。 */
  // Selected note (for "play from here"): its chord + which verse/pass row.
  private _selectedChord: import("../score/score").Chord | null = null;
  private _selectedVerse = 0;
  /** `.Voice` 源码 token 与排版后 Chord 的同序映射，驱动右侧绿色编辑光标。 */
  private _jpCursorTargets: Array<{ from: number; to: number; chord: Chord }> = [];
  private _savedText = "";
  private _dirty = false;
  private _readOnly = false;
  private _saveTask: Promise<void> | null = null;
  private _saveFeedbackTimer: ReturnType<typeof setTimeout> | undefined;


  constructor(meta: MetaData, scorePane: HTMLElement) {
    this.meta = meta;
    this.painter = new JinpuPainter(this.fontSize);
    this.painter.layout.options.smuflMeta = meta;
    this.scorePane = scorePane;
  }

  /** 换字号要重建 painter（字号是 JinpuPainter 的构造参数），保留已排好的 Score。
   *  随后把 color/titleSize/creditSize 三个选项同步进新 painter。两个调用点共用。 */
  private _rebuildPainter(fontSize?: number): void {
    if (fontSize && fontSize !== this.fontSize) {
      this.fontSize = fontSize;
      const score = this.painter.score;
      this.painter = new JinpuPainter(this.fontSize);
      this.painter.layout.options.smuflMeta = this.meta;
      this.painter.score = score;
    }
    this.painter.layout.options.color = this.color;
    this.painter.layout.options.titleSize = this.titleSize;
    this.painter.layout.options.creditSize = this.creditSize;
  }

  /** Apply page-size / font-size / title-size / credit-size / color render settings and re-render. */
  applyRenderSettings(opts: { pageW?: number; pageH?: number; fontSize?: number; titleSize?: number; creditSize?: number; color?: number }): void {
    if (opts.pageW) this.pageW = opts.pageW;
    if (opts.pageH) this.pageH = opts.pageH;
    if (opts.color !== undefined) this.color = opts.color;
    if (opts.titleSize !== undefined) this.titleSize = opts.titleSize;
    if (opts.creditSize !== undefined) this.creditSize = opts.creditSize;
    this._rebuildPainter(opts.fontSize);
    this.saveSettings();
    this.reload(this.getText());
  }

  /** Restore persisted render settings; call before mountEditor() so first render uses them.
   *  存取机制在 editor/settings.ts；这里只管「哪个值落到哪个属性」。 */
  loadSettings(): void {
    const s = loadPersistedSettings();
    if (!s) return;
    this.omr.loadSettings(s);
    this.playback.loadSettings(s);
    if (s.mixedHideBarNumber !== undefined) this.mixedHideBarNumber = s.mixedHideBarNumber;
    if (s.mixedShowJianpuLayer !== undefined) this.mixedShowJianpuLayer = s.mixedShowJianpuLayer;
    if (s.pageW) this.pageW = s.pageW;
    if (s.pageH) this.pageH = s.pageH;
    if (s.titleSize !== undefined) this.titleSize = s.titleSize;
    if (s.creditSize !== undefined) this.creditSize = s.creditSize;
    if (s.color !== undefined) this.color = s.color;
    if (s.zoom) this.zoom = s.zoom;
    this._applyZoom();
    this._rebuildPainter(s.fontSize);
  }

  /** 两个控制器也要用（切输出格式 / 改速度后持久化）。 */
  saveSettings(): void {
    savePersistedSettings({
      pageW: this.pageW,
      pageH: this.pageH,
      fontSize: this.fontSize,
      titleSize: this.titleSize,
      creditSize: this.creditSize,
      color: this.color,
      zoom: this.zoom,
      mixedHideBarNumber: this.mixedHideBarNumber,
      mixedShowJianpuLayer: this.mixedShowJianpuLayer,
      playSpeed: this.playback.speed,
      omrFormat: this.omr.format,
    });
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
    this._savedText = initialText;
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        // 识别映射随用户编辑迁移偏移，保持点选仍落在正确 token。
        this.omr.remapMeta((m) => mapMeta(m, u.changes));
        this.scheduleReload();
      }
      if (u.docChanged || u.selectionSet) this._syncEditorState();
    });
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([
            {
              key: "Mod-s",
              run: () => { void this.saveFile(); return true; },
              preventDefault: true,
              stopPropagation: true,
            },
            {
              key: "Mod-Shift-s",
              run: () => { void this.saveFileAs(); return true; },
              preventDefault: true,
              stopPropagation: true,
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          this._puHighlightCompartment.of(jpwHighlighter),
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
    this._syncEditorState();
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  /** 打开/恢复成功后把当前内容设为存盘基线；之后撤销回该文本也会自动恢复“未修改”。 */
  markDocumentClean(text = this.getText()): void {
    this._savedText = text;
    this._syncEditorState();
  }

  private _syncEditorState(): void {
    if (!this.view) return;
    const text = this.getText();
    this._dirty = text !== this._savedText;
    const saveBtn = document.getElementById("btn-save") as HTMLButtonElement | null;
    saveBtn?.classList.toggle("has-unsaved", this._dirty);
    if (saveBtn) {
      const shortcut = navigator.platform.toLowerCase().includes("mac") ? "⌘S" : "Ctrl+S";
      saveBtn.title = this._dirty ? `保存修改 (${shortcut})` : `已保存 (${shortcut})`;
    }
    this._syncEditorMeta();
    this._syncEditingCursor();
  }

  private _syncEditorMeta(): void {
    if (!this.view) return;
    const pos = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(pos);
    const prefix = this._readOnly ? "只读" : this._formatLabel();
    const dirty = this._dirty ? " · 已修改" : "";
    const meta = document.getElementById("code-pane-meta");
    if (meta) meta.textContent = `${prefix}${dirty} · 行 ${line.number}，列 ${pos - line.from + 1}`;
  }

  /** 把源码 caret 投射到当前简谱预览；光标只滚动右侧容器，不改变源码焦点。 */
  private _syncEditingCursor(): void {
    if (!this.view) return;
    if (this.mode !== "jp") {
      this.painter.highlightEditingChord(null);
      this._puPainter?.highlightEditingAt(-1, -1);
      return;
    }
    const offset = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(offset);
    if (this.docFormat === "pu") {
      const hit = this._puPainter?.highlightEditingAt(offset, line.number - 1) ?? null;
      if (hit) {
        this.pageIndex = hit.page;
        hit.el.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      return;
    }
    const sameLine = this._jpCursorTargets.filter((r) => r.from <= line.to && r.to >= line.from);
    const target = sameLine.find((r) => r.from <= offset && offset <= r.to)
      ?? sameLine.sort((a, b) => rangeDistance(a, offset) - rangeDistance(b, offset))[0];
    const hit = this.painter.highlightEditingChord(target?.chord ?? null);
    if (hit) {
      this.pageIndex = hit.page;
      hit.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /** 当前文本是否与「导入 MusicXML 时生成的 .jpwabc」逐字相同。
   *  true = 用户没改过谱面，MusicXML 导出可以直接给底本原文（零损耗）。 */
  get importUnchanged(): boolean {
    return this._origLayoutText !== null && this.getText() === this._origLayoutText;
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
    if (this.docFormat === "pu") return this.reloadPu(text);
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
    this._jpCursorTargets = buildJpwCursorTargets(text, score);
    const breakDesc = f.getSection(LayoutSection)?.desc ?? null;
    try {
      this.painter.resize(this.pageW, this.pageH, breakDesc);
    } catch (e) {
      console.error("layout failed", e);
      return false;
    }
    this.renderPages();
    this.playback.refreshSpeedUi(); // 谱面 ♩= 随文本走，速度提示要跟着换
    return true;
  }


  /** 文本谱（番茄 / 诗歌本）：解析 → 专用排版 → 渲染。 */
  private reloadPu(text: string): boolean {
    let doc;
    try {
      doc = parsePu(text);
    } catch (e) {
      console.error("文本谱解析失败", e);
      this.setStatus("文本谱解析失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
    const fatal = doc.diagnostics.find((d) => d.severity === "error");
    if (fatal) {
      this.setStatus(`文本谱无法解析：${fatal.message}`);
      return false;
    }
    if (!this._puPainter) this._puPainter = new PuPainter(this.puProfile);
    else if (this._puPainter.metrics.profile !== this.puProfile) {
      this._puPainter = new PuPainter(this.puProfile);
    }
    try {
      this._puPainter.load(doc);
    } catch (e) {
      console.error("文本谱排版失败", e);
      this.setStatus("文本谱排版失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
    this._puDoc = { text, doc };
    this._puScoreCache = null; // 文本变了，Score 与 noteMap 都要重建
    this._puDialect = doc.dialect;
    this._syncFormatLabel();
    this.renderPuPages();
    // 解析告警不拦排版，但要让用户看得见（谱面往往仍然是对的）
    const warns = doc.diagnostics.length;
    this.setStatus(
      warns === 0
        ? ""
        : `${dialectSpec(doc.dialect).name}：${warns} 处需要留意` +
            `（第 ${doc.diagnostics[0]!.source.line + 1} 行 ${doc.diagnostics[0]!.message}）`,
    );
    return true;
  }

  private renderPuPages(): void {
    const painter = this._puPainter;
    if (!painter) return;
    this.playback.stop();
    this.selectedEl = null;
    this._renderPagesWith(painter.pageCount, (i) => painter.renderPage(i), {
      aspectRatio: (i) => {
        // 文本谱的「原版」是连续长图，宽高比随谱而变，不能用 CSS 里写死的 960/540
        const { w, h } = painter.pageSize(i);
        return `${w} / ${h}`;
      },
    });
    this._syncEditingCursor();
  }

  /** 文本谱版面切换（原版 / PPT）。 */
  setPuProfile(profile: PageProfileName): void {
    if (this.puProfile === profile) return;
    this.puProfile = profile;
    this._syncPuProfileButtons();
    if (this.docFormat === "pu") this.reload(this.getText());
  }

  /** 注册文本谱版面切换按钮（原版 / PPT）。 */
  setPuProfileButtons(
    switchEl: HTMLElement,
    printBtn: HTMLButtonElement,
    slideBtn: HTMLButtonElement,
  ): void {
    this._puProfileSwitchEl = switchEl;
    this._puPrintBtnEl = printBtn;
    this._puSlideBtnEl = slideBtn;
    this._setPuControlsAvailable(this.docFormat === "pu");
  }

  private _setPuControlsAvailable(available: boolean): void {
    if (this._puProfileSwitchEl) this._puProfileSwitchEl.hidden = !available;
    this._syncPuProfileButtons();
  }

  private _syncPuProfileButtons(): void {
    const slide = this.puProfile === "slide";
    for (const [btn, on] of [
      [this._puPrintBtnEl, !slide],
      [this._puSlideBtnEl, slide],
    ] as const) {
      if (!btn) continue;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  }

  /** 当前文本谱的 AST（MusicXML 直出用；与排版器共用同一份对象）。 */
  puDoc(): PuDoc | null {
    if (this.docFormat !== "pu") return null;
    const text = this.getText();
    if (this._puDoc?.text === text) return this._puDoc.doc;
    try {
      const doc = parsePu(text);
      this._puDoc = { text, doc };
      return doc;
    } catch {
      return null;
    }
  }

  /** 当前文本谱对应的 Score（导出 .jpwabc / MusicXML / MIDI 与试听共用）。
   *  Score 装不下和弦与力度，那些信息只在「原版」谱面上有。 */
  puScore(): Score | null {
    if (this.docFormat !== "pu") return null;
    const text = this.getText();
    if (this._puScoreCache && this._puScoreCache.text === text) return this._puScoreCache.score;
    let score: Score | null = null;
    const noteMap = new Map<Chord, PuNoteElement>();
    try {
      // **必须复用排版时那份 AST**：PuPainter 的高亮索引是按节点对象身份建的，
      // 重新 parse 一遍会得到另一批对象，播放高亮就永远找不到。
      const doc = this._puDoc?.text === text ? this._puDoc.doc : parsePu(text);
      score = puToScore(doc, { noteMap });
    } catch (e) {
      console.error("文本谱转 Score 失败", e);
      return null;
    }
    this._puScoreCache = { text, score, noteMap };
    return score;
  }

  /** 当前文本谱的排版器（播放高亮 / 导出用）。 */
  get puPainter(): PuPainter | null {
    return this.docFormat === "pu" ? this._puPainter : null;
  }

  /** 切换编辑的源格式：换高亮、清掉另一路的状态。 */
  private _setDocFormat(format: "jpwabc" | "pu"): void {
    if (this.docFormat === format) return;
    this.docFormat = format;
    this.view.dispatch({
      effects: this._puHighlightCompartment.reconfigure(
        format === "pu" ? puHighlighter : jpwHighlighter,
      ),
    });
    if (format === "pu") {
      // 文本谱走自己的排版器，简谱那侧的上下文工具（乐句重排 / 混排）不适用
      this._disablePhrase();
      this.mixedXmlText = null;
      this._setMixedAvailable(false);
    } else {
      this._puPainter = null;
      this._puDialect = null;
      this._puDoc = null;
      this._puScoreCache = null;
    }
    this._setPuControlsAvailable(format === "pu");
    this._syncFormatLabel();
  }

  /** 把若干页铺进 #score-pane。四种预览（简谱 / 文本谱 / 识别核对 / 混排）共用这一条骨架，
   *  差异全走 opts：各自的容器样式、每页要挂的事件、页码是清零还是夹取。 */
  private _renderPagesWith(
    count: number,
    svgOf: (i: number) => SVGSVGElement,
    opts: {
      /** 容器宽高比（连续长图/混排纸张随谱而变，不能用 CSS 里写死的 960/540）。 */
      aspectRatio?: (i: number) => string;
      /** 容器宽度（覆盖 CSS 默认）。 */
      width?: string;
      /** 容器 position（识别浮窗要相对它绝对定位）。 */
      position?: string;
      /** 每页渲染完的额外处理（挂事件、改样式）。 */
      onPage?: (svg: SVGSVGElement, wrap: HTMLDivElement, i: number) => void;
      /** true = 页码清零（单页视图/换文档），false = 夹到新页数内（重排后保持当前页）。 */
      resetPageIndex?: boolean;
    } = {},
  ): void {
    this.scorePane.replaceChildren();
    this.pageEls = [];
    for (let i = 0; i < count; i++) {
      const svg = svgOf(i);
      const wrap = document.createElement("div");
      wrap.className = "score-page-wrap";
      if (opts.aspectRatio) wrap.style.aspectRatio = opts.aspectRatio(i);
      if (opts.width) wrap.style.width = opts.width;
      if (opts.position) wrap.style.position = opts.position;
      wrap.appendChild(svg);
      opts.onPage?.(svg, wrap, i);
      this.scorePane.appendChild(wrap);
      this.pageEls.push(wrap);
    }
    this.pageIndex = opts.resetPageIndex
      ? 0
      : Math.min(this.pageIndex, Math.max(0, this.pageEls.length - 1));
  }

  private renderPages(): void {
    this.playback.stop(); // relayout invalidates chord objects / highlight
    this.selectedEl = null;
    this._renderPagesWith(this.painter.pageCount, (i) => this.painter.renderPage(i), {
      onPage: (svg, _wrap, i) => svg.addEventListener("click", (e) => this.onPageClick(i, svg, e)),
    });
    this._syncEditingCursor();
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
    // Remember the note entry so playback can start from here.
    const d = target.data;
    if (d && typeof (d as { verse?: unknown }).verse === "number" && (d as { chord?: unknown }).chord) {
      const ne = d as { chord: import("../score/score").Chord; verse: number };
      this._selectedChord = ne.chord;
      this._selectedVerse = ne.verse;
    }
    this.setStatus(describePick(picked));
  }

  private deselect(): void {
    this.selectedEl?.classList.remove("selected");
    this.selectedEl = null;
    this._selectedChord = null;
    this._selectedVerse = 0;
  }

  setStatus(s: string): void {
    if (!this.statusEl) this.statusEl = document.getElementById("status");
    if (this.statusEl) this.statusEl.textContent = s;
  }

  /** 当前状态栏文本。main.ts 以前直接 getElementById("status").textContent 反读，
   *  两边各自硬编码同一个 DOM id 做通信。 */
  get status(): string {
    if (!this.statusEl) this.statusEl = document.getElementById("status");
    return this.statusEl?.textContent ?? "";
  }

  // ---------------- paging ----------------
  goToPage(i: number): void {
    const np = Math.max(0, Math.min(i, this.pageEls.length - 1));
    this.pageIndex = np;
    this.pageEls[np]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // ---------------- playback（控制器在 editor/playback.ts，这里只留与谱面相关的部分） ----------------
  /** PlaybackHost：混排/识别核对下不试听。 */
  get canPlay(): boolean {
    return this.mode === "jp";
  }

  /** PlaybackHost：当前该播哪份 Score（文本谱要先转一遍）。 */
  playableScore(): Score | null {
    return this.docFormat === "pu" ? this.puScore() : this.painter.score;
  }

  /** PlaybackHost：谱面标注的速度 ♩=NN（0 = 未标注，试听按默认 90）。 */
  get scoreTempo(): number {
    return this.painter.score.playData.tempo;
  }

  /** PlaybackHost：算「当前实际 BPM」用的那份 Score。 */
  get tempoScore(): Score {
    return this.painter.score;
  }

  /** PlaybackHost：用户在谱面上选中了某个音就从那儿起播。 */
  startPoint(): { chord: Chord; pass: number } | undefined {
    return this._selectedChord !== null
      ? { chord: this._selectedChord, pass: this._selectedVerse }
      : undefined;
  }

  /** PlaybackHost：播到某个和弦 → 谱面高亮 + 保证可见。
   *  高亮留在 App 而不进控制器：简谱与文本谱走各自排版器的索引，那属于「谁在画谱面」。 */
  highlightPlaying(chord: Chord | null, pass: number): void {
    // 文本谱：播放器给的是 Chord，「原版」谱面按 AST 节点索引，靠 noteMap 搭桥
    if (this.docFormat === "pu") {
      const painter = this._puPainter;
      if (!painter) return;
      const note = chord ? this._puScoreCache?.noteMap.get(chord) : null;
      const pg = painter.highlight(note ?? null, Math.max(0, pass - 1));
      if (note && pg !== null) {
        if (pg !== this.pageIndex) this.pageIndex = pg;
        painter.noteGroupEl(note)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      return;
    }
    const page = this.painter.highlightChord(chord, pass);
    if (chord && page !== null) {
      if (page !== this.pageIndex) this.pageIndex = page;
      // keep the sounding note visible (no-op when already in view)
      this.painter.chordGroupEl(chord, pass)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /** Number of parts in the current score (for the mixer UI). */
  get partCount(): number {
    return this.painter.score.parts.length;
  }

  /** 停止试听。四处铺页前都要调，故留一个短名字在 App 上。 */
  stopPlayback(): void {
    this.playback.stop();
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
    // 任何新导入都使上一次的识别叠加产物失效（识别结果由 OmrController 在本调用之后重设）。
    this.omr.clear();
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
    // 文本谱（番茄 / 诗歌本）：原文就是源格式，直接进编辑器，不做任何转换。
    if (isPuFile(name)) {
      const puText = new TextDecoder(
        bytes[0] === 0xff || bytes[0] === 0xfe ? "utf-16" : "utf-8",
      ).decode(bytes);
      const sniffed = sniffDialect(puText);
      if (sniffed.dialect === null) {
        // `.txt` 太泛，认不出宁可不动——硬解只会得到一首乱谱
        this.setStatus(`这不像文本谱：${sniffed.reason}`);
        return;
      }
      this.mixedXmlText = null;
      this._mixedPainter = null;
      this._setMode("jp");
      this._setDocFormat("pu");
      this.setText(puText);
      return;
    }
    if (/\.(xml|musicxml)$/i.test(name)) {
      const xml = new TextDecoder(
        bytes[0] === 0xff || bytes[0] === 0xfe ? "utf-16" : "utf-8",
      ).decode(bytes);
      this._setDocFormat("jpwabc");
      this.mixedXmlText = xml;
      this._mixedPainter = null; // reset so next showStaffPreview re-loads
      this._setMixedAvailable(true);

      // 多声部（SATB 等）歌谱默认进入混排模式
      const autoMixed = this.mode !== "mixed" && isMultiPartXml(xml);
      if (this.mode === "mixed" || autoMixed) {
        if (autoMixed) this._setMode("mixed");
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
      this._setPreviewModeActive("jp");
      this.filePath = null; // imported; save as new .jpwabc
      const { text, meta } = scoreToJpwabcWithMeta(score);
      this._lastImportMeta = meta; // 供 OmrController 接管为它的点选映射
      this._applyImportedJp(text);
    } else {
      this._setDocFormat("jpwabc");
      this.mixedXmlText = null;
      this._mixedPainter = null;
      this._setMixedAvailable(false);
      this._disablePhrase();
      this._setMode("jp");
      this.setText(decodeJpwabc(bytes));
    }
  }

  /** 导入 MusicXML/OMR 得到的默认（原始排版）文本：缓存以便乐句排版无损切回，并启用切换按钮。 */
  private _applyImportedJp(text: string): void {
    this._origLayoutText = text;
    this._phraseOn = false;
    this._setPhraseActive(false);
    this._setPhraseAvailable(true);
    this.setText(text);
  }

  private _disablePhrase(): void {
    this._origLayoutText = null;
    this._phraseOn = false;
    this._setPhraseActive(false);
    this._setPhraseAvailable(false);
  }

  /** OmrHost：上下文相关控件的显隐。 */
  setContextControl(el: Element | null, visible: boolean): void {
    this._setContextControl(el as HTMLElement | null, visible);
  }

  /** OmrHost：所在 context-tool-group 的整体显隐同步。 */
  syncContextGroup(el: Element | null | undefined): void {
    this._syncContextGroup((el ?? null) as HTMLElement | null);
  }

  private _setContextControl(el: HTMLElement | null, visible: boolean): void {
    if (!el) return;
    el.hidden = !visible;
    if (el instanceof HTMLButtonElement) el.disabled = !visible;
    this._syncContextGroup(el);
  }

  private _syncContextGroup(el: HTMLElement | null): void {
    if (!el) return;
    const group = el.closest<HTMLElement>(".context-tool-group");
    if (group) group.hidden = !group.querySelector("[data-context-control]:not([hidden])");
  }

  setPhraseButtons(original: HTMLButtonElement, phrase: HTMLButtonElement): void {
    this._originalLayoutBtnEl = original;
    this._phraseBtnEl = phrase;
    this._setPhraseActive(false);
    this._setPhraseAvailable(false);
  }

  private _setPhraseAvailable(available: boolean): void {
    const switchEl = this._phraseBtnEl?.closest<HTMLElement>(".layout-mode-switch");
    if (!switchEl) return;
    switchEl.hidden = !available;
    if (this._originalLayoutBtnEl) this._originalLayoutBtnEl.disabled = !available;
    if (this._phraseBtnEl) this._phraseBtnEl.disabled = !available;
    this._syncContextGroup(switchEl);
  }

  private _setPhraseActive(phrase: boolean): void {
    this._originalLayoutBtnEl?.classList.toggle("active", !phrase);
    this._phraseBtnEl?.classList.toggle("active", phrase);
    this._originalLayoutBtnEl?.setAttribute("aria-pressed", String(!phrase));
    this._phraseBtnEl?.setAttribute("aria-pressed", String(phrase));
  }

  /** Switch between the imported line layout and phrase-aware relayout. */
  setPhraseLayout(phrase: boolean): void {
    if (!this.mixedXmlText || !this._origLayoutText) return;
    if (this._phraseOn === phrase) return;
    // 乐句排版要看的是排版结果 → 先退出识别/混排叠加视图，回到简谱模式，否则 reload 直接返回不重排。
    this._setMode("jp");
    if (!phrase) {
      this._phraseOn = false;
      this._setPhraseActive(false);
      this.setText(this._origLayoutText);
    } else {
      try {
        const score = loadMusicXml(this.mixedXmlText);
        this.setText(scoreToJpwabc(score, { phrase: true }));
        this._phraseOn = true;
        this._setPhraseActive(true);
      } catch (e) {
        console.error("phrase relayout failed", e);
      }
    }
  }

  /** 注册工具栏「简繁」按钮，供转换期间切换加载中状态。 */
  setHanziButton(el: HTMLButtonElement): void {
    this._hanziBtnEl = el;
  }

  /**
   * 整篇简繁转换：改写源码文本本身（单个 CodeMirror transaction，Ctrl+Z 可整体撤销）。
   * dir = "auto" 时按当前文本字形自动判定方向。
   */
  async convertHanzi(dir: "auto" | HanDirection): Promise<void> {
    if (this.mode !== "jp") return;
    if (this.docFormat === "pu") {
      // convertJpwabc 认的是 .Title/.Words 段结构，文本谱是另一套语法
      this.setStatus("文本谱暂不支持整篇简繁转换");
      return;
    }
    const btn = this._hanziBtnEl;
    const label = btn?.textContent ?? "简繁";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "加载中";
    }
    try {
      const text = this.getText();
      const d = dir === "auto" ? await detectDirection(text) : dir;
      const out = await convertJpwabc(text, d);
      if (this._origLayoutText) this._origLayoutText = await convertJpwabc(this._origLayoutText, d);
      if (out !== text) this.setText(out);
      this.setStatus(d === "s2t" ? "已转为繁体" : "已转为简体");
    } catch (e) {
      console.error("hanzi conversion failed", e);
      this.setStatus("简繁转换失败");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  }

  /** Register the right-preview segmented control. */
  setPreviewModeButtons(jp: HTMLButtonElement, mixed: HTMLButtonElement): void {
    this._jpPreviewBtnEl = jp;
    this._mixedBtnEl = mixed;
    this._setMixedAvailable(false);
    this._setPreviewModeActive("jp");
  }

  setStaffJianpuToggle(el: HTMLInputElement): void {
    this._staffJianpuToggleEl = el;
    el.checked = this.mixedShowJianpuLayer;
    const label = el.closest<HTMLElement>(".staff-layer-toggle");
    if (label) label.hidden = this.mode !== "mixed";
  }

  private _setMixedAvailable(available: boolean): void {
    const switchEl = this._mixedBtnEl?.closest<HTMLElement>(".preview-mode-switch");
    if (switchEl) switchEl.hidden = !available;
    if (this._mixedBtnEl) this._mixedBtnEl.disabled = !available;
    if (!available) {
      const label = this._staffJianpuToggleEl?.closest<HTMLElement>(".staff-layer-toggle");
      if (label) label.hidden = true;
    }
    if (!available) this._setPreviewModeActive("jp");
  }

  private _setPreviewModeActive(mode: "jp" | "mixed"): void {
    const mixed = mode === "mixed";
    this._jpPreviewBtnEl?.classList.toggle("active", !mixed);
    this._mixedBtnEl?.classList.toggle("active", mixed);
    this._jpPreviewBtnEl?.setAttribute("aria-pressed", String(!mixed));
    this._mixedBtnEl?.setAttribute("aria-pressed", String(mixed));
    const label = this._staffJianpuToggleEl?.closest<HTMLElement>(".staff-layer-toggle");
    if (label) label.hidden = !mixed;
  }

  // ---------------- OmrHost：识别控制器要的那几样能力 ----------------
  /** 混排排版器（导出 PDF/PNG 要）。没进过混排预览就是 null。
   *  以前导出侧靠 `app["_mixedPainter"]` 索引签名绕过 private——字段一改名，编译期静默
   *  通过、运行期直接 return，「导出 PDF 点了没反应」且无报错。 */
  get mixedPainter(): MixedPainter | null {
    return this._mixedPainter;
  }

  /** 最近一次 MusicXML 导入产出的代码区间映射。 */
  get lastImportMeta(): JpwMeta | null {
    return this._lastImportMeta;
  }

  /** 清空谱面区与翻页/选中状态。 */
  clearPages(): void {
    this.scorePane.replaceChildren();
    this.pageEls = [];
    this.selectedEl = null;
  }

  /** 铺页（供识别核对视图复用同一条骨架）。 */
  renderPagesWith(
    count: number,
    svgOf: (i: number) => SVGSVGElement,
    opts: Parameters<App["_renderPagesWith"]>[2] = {},
  ): void {
    this._renderPagesWith(count, svgOf, opts);
  }

  /** 进入/退出识别模式：改 mode，并在进入时先退掉混排布局。 */
  setRecognizeMode(on: boolean): void {
    this._setMode(on ? "recognize" : "jp");
  }

  /** 文本谱产物落地：丢掉混排底本、切 docFormat、清文件路径，再设文本。 */
  adoptPuText(text: string): void {
    this.mixedXmlText = null;
    this._mixedPainter = null;
    this._setMixedAvailable(false);
    this._setMode("jp");
    this._setDocFormat("pu");
    this.filePath = null;
    this.setText(text);
  }

  /** 预览模式切换的**唯一**入口：退出当前模式的副作用 + 进入新模式的副作用。
   *
   *  以前这三连（`mode = …` / `_setMixedLayout` / `_setPreviewModeActive`）在五处各写一遍，
   *  漏一处就出「按钮亮着但布局是另一个模式」。识别模式的那套布局由 OmrController 自己接管
   *  （omrctl.ts::setLayout），这里只管 mode 与混排布局。 */
  private _setMode(next: "jp" | "mixed" | "recognize"): void {
    if (this.mode === next) return;
    if (this.mode === "recognize") this.omr.leaveLayout();
    if (this.mode === "mixed") this._setMixedLayout(false);
    this.mode = next;
    if (next === "mixed") this._setMixedLayout(true);
    // 识别模式沿用「简谱」这个预览档（工具条上它不是独立一档）。
    this._setPreviewModeActive(next === "mixed" ? "mixed" : "jp");
  }

  async showJpPreview(): Promise<void> {
    if (this.mode === "jp") return;
    this.stopPlayback();
    this._setMode("jp");
    this.reload(this.getText());
  }

  async showStaffPreview(): Promise<void> {
    if (!this.mixedXmlText) return;
    if (this.mode === "mixed") return;
    this.stopPlayback();
    this._setMode("mixed");
    await this._renderMixedPages();
  }

  /** 设置混排是否隐藏小节号，持久化；当前处于混排模式时立即重排。 */
  async setMixedHideBarNumber(on: boolean): Promise<void> {
    if (this.mixedHideBarNumber === on) return;
    this.mixedHideBarNumber = on;
    this.saveSettings();
    if (this.mode === "mixed") await this._renderMixedPages();
  }

  async setStaffJianpuLayer(on: boolean): Promise<void> {
    if (this.mixedShowJianpuLayer === on) return;
    this.mixedShowJianpuLayer = on;
    if (this._staffJianpuToggleEl) this._staffJianpuToggleEl.checked = on;
    this._mixedPainter = null;
    this.saveSettings();
    if (this.mode === "mixed") await this._renderMixedPages();
  }

  /** Staff preview is rendered from MusicXML, so the visible JP source is read-only. */
  private _setMixedLayout(on: boolean): void {
    this._readOnly = on;
    this.view.dispatch({
      effects: this._readOnlyCompartment.reconfigure(EditorState.readOnly.of(on)),
    });
    document.getElementById("body")?.classList.toggle("mixed", on);
    this._syncEditorMeta();
  }

  /** 代码区右上角的格式标签。 */
  private _formatLabel(): string {
    if (this.docFormat !== "pu") return "JPWABC";
    if (this._puDialect === null) return "文本谱";
    return `文本谱·${dialectSpec(this._puDialect).shortName}`;
  }

  private _syncFormatLabel(): void {
    this._syncEditorMeta();
  }

  private async _renderMixedPages(): Promise<void> {
    if (!this._mixedPainter) {
      this._mixedPainter = new MixedPainter();
      this._mixedPainter.showJianpuLayer = this.mixedShowJianpuLayer;
    }
    this._mixedPainter.hideBarNumber = this.mixedHideBarNumber;
    if (this.mixedXmlText) {
      await this._mixedPainter.load(this.mixedXmlText);
    }
    const painter = this._mixedPainter;
    this._renderPagesWith(painter.pageCount, (i) => painter.renderPage(i), {
      // Portrait paper sized from the MusicXML page dimensions.
      aspectRatio: (i) => {
        const { w, h } = painter.pageSize(i);
        return `${w} / ${h}`;
      },
      width: "calc(min(620px, 100%) * var(--score-zoom, 1))",
      onPage: (svg) => {
        svg.style.width = "100%";
        svg.style.display = "block";
      },
      resetPageIndex: true,
    });
  }

  /** 记住上次打开/保存的文件路径（仅 Tauri：浏览器路径不可复读）。 */
  rememberLastFile(path: string): void {
    saveLastFile(path);
  }

  /** 启动时尝试复读上次打开的文件（仅 Tauri）。返回 true 表示已加载，false 则保持示例文本。 */
  async tryRestoreLastFile(): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    const path = loadLastFile();
    if (!path) return false;
    try {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const bytes = await readFile(path);
      this.importBytes(bytes, path);
      if (!/\.(xml|musicxml|abc)$/i.test(path)) this.filePath = path;
      this.markDocumentClean();
      return true;
    } catch {
      // 文件已被移动/删除/不可读 — 忘掉它，回退到示例
      clearLastFile();
      return false;
    }
  }

  async openFile(): Promise<boolean> {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const sel = await open({
        multiple: false,
        filters: [
          {
            name: "简谱 / 文本谱 / MusicXML / ABC",
            extensions: ["jpwabc", "JPWABC", "pu", "fq", "jps", "txt", "xml", "musicxml", "abc"],
          },
        ],
      });
      if (typeof sel !== "string") return false;
      const bytes = await readFile(sel);
      this.importBytes(bytes, sel);
      if (!/\.(xml|musicxml|abc)$/i.test(sel)) this.filePath = sel;
      this.rememberLastFile(sel);
      this.markDocumentClean();
      return true;
    }

    return await new Promise<boolean>((resolve) => {
      const input = document.createElement("input");
      let settled = false;
      let changeStarted = false;
      const finish = (opened: boolean) => {
        if (settled) return;
        settled = true;
        resolve(opened);
      };
      input.type = "file";
      input.accept = acceptAttr(DOC_EXT);
      input.onchange = async () => {
        changeStarted = true;
        const file = input.files?.[0];
        if (!file) { finish(false); return; }
        const buf = new Uint8Array(await file.arrayBuffer());
        this.importBytes(buf, file.name);
        if (!/\.(xml|musicxml|abc)$/i.test(file.name)) this.filePath = file.name;
        this.markDocumentClean();
        finish(true);
      };
      window.addEventListener("focus", () => setTimeout(() => {
        if (!changeStarted) finish(false);
      }, 500), { once: true });
      input.click();
    });
  }

  async saveFile(): Promise<void> {
    await this._save(false);
  }

  async saveFileAs(): Promise<void> {
    await this._save(true);
  }

  private async _save(forceSaveAs: boolean): Promise<void> {
    if (this._saveTask) return this._saveTask;
    this._saveTask = this._performSave(forceSaveAs).finally(() => { this._saveTask = null; });
    return this._saveTask;
  }

  private async _performSave(forceSaveAs: boolean): Promise<void> {
    const text = this.getText();
    const bytes = this.encodeForSave(text);
    this._setSaveFeedback("保存中…");
    try {
      if (!forceSaveAs && this.filePath && isTauriRuntime()) {
        await this.writeTo(this.filePath, bytes);
      } else {
        // 首次保存/另存为才弹路径选择；有路径的 Cmd/Ctrl+S 永远原地写回。
        const dest = await saveBytes(bytes, this.defaultSaveName());
        if (!dest) {
          this._setSaveFeedback("保存", false);
          return;
        }
        this.filePath = dest;
        this.rememberLastFile(dest);
      }
      // 保存期间仍可继续输入；只把真正写入磁盘的快照设为基线。
      this.markDocumentClean(text);
      const name = this.filePath?.split(/[\\/]/).pop();
      this.setStatus(name ? `已保存：${name}` : "已保存");
      this._setSaveFeedback("已保存", false, 1200);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("save failed", e);
      this.setStatus(`保存失败：${message}`);
      this._setSaveFeedback("保存失败", true, 2200);
    }
  }

  /** 存盘用的文件名：文本谱存 `.pu`，其余存 `.jpwabc`。 */
  private defaultSaveName(): string {
    const base = this.documentTitle() || "未命名";
    return base + (this.docFormat === "pu" ? ".pu" : ".jpwabc");
  }

  /** 当前文档的标题（文本谱取头部第一条 T:/B:）。 */
  private documentTitle(): string {
    if (this.docFormat === "pu") {
      const first = this.getText()
        .split(/\r?\n/)
        .map((l) => /^\s*[TB]\s*[:：](.*)$/.exec(l))
        .find((m) => m !== null);
      return first ? first[1]!.trim() : "";
    }
    return this.painter.score.title.split("\n")[0] ?? "";
  }

  /** 文本谱是纯文本源格式，存 UTF-8 原文；`.jpwabc` 仍按 JP-Word 的 UTF-16LE+BOM。 */
  private encodeForSave(text = this.getText()): Uint8Array {
    return this.docFormat === "pu"
      ? new TextEncoder().encode(text)
      : encodeJpwabc(text);
  }

  private async writeTo(path: string, bytes = this.encodeForSave()): Promise<void> {
    await writeBytesInPlace(path, bytes);
  }

  private _setSaveFeedback(label: string, error = false, restoreAfter = 0): void {
    const btn = document.getElementById("btn-save") as HTMLButtonElement | null;
    if (!btn) return;
    clearTimeout(this._saveFeedbackTimer);
    btn.textContent = label;
    btn.classList.toggle("save-error", error);
    btn.disabled = label === "保存中…";
    if (restoreAfter > 0) {
      this._saveFeedbackTimer = setTimeout(() => {
        btn.textContent = "保存";
        btn.classList.remove("save-error");
        btn.disabled = false;
        this._syncEditorState();
      }, restoreAfter);
    } else if (label === "保存") {
      btn.classList.remove("save-error");
      btn.disabled = false;
    }
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

function rangeDistance(range: { from: number; to: number }, offset: number): number {
  return offset < range.from ? range.from - offset : offset > range.to ? offset - range.to : 0;
}

/** TokenData 与 fromJpw 都按 `.Voice` 的出现顺序工作，因此可稳定地把第 N 个源码音符
 * 对到第 N 个 Chord；格式空白和注释不会影响映射。 */
function buildJpwCursorTargets(
  text: string,
  score: Score,
): Array<{ from: number; to: number; chord: Chord }> {
  const ranges: Array<{ from: number; to: number }> = [];
  try {
    let pos = 0;
    for (const token of TokenData.parse(text).tokens) {
      const from = pos;
      pos += token.text.length;
      if (token.type === JpwabcLexer.Note) ranges.push({ from, to: pos });
    }
  } catch {
    return [];
  }
  const chords: Chord[] = [];
  for (const measure of score.parts[0]?.measures ?? []) {
    for (const entry of measure.entries) if (entry instanceof Chord) chords.push(entry);
  }
  return ranges.slice(0, chords.length).map((range, i) => ({ ...range, chord: chords[i]! }));
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
