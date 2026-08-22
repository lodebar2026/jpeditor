// App controller: CodeMirror editor <-> live relayout/render <-> paging <-> file I/O.
// Mirrors EditorController in CodeEditor.kt (doBind/tryLoad/updateLayout/paint/load/doSave).

import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { jpwHighlighter } from "./highlight";
import { puHighlighter } from "../pu/highlight";
import { PuPainter } from "../pu/painter";
import { parsePu, puToScore, sniffDialect, dialectSpec } from "../pu";
import type { Chord, Score } from "../score/score";
import type { NoteElement as PuNoteElement, PuDoc } from "../pu";
import type { PageProfileName } from "../pu/metrics";
import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { fromJpw } from "../score/jpwimport";
import { PlayItem } from "../score/score";
import { JinpuPainter } from "../layout/painter";
import { JpNumber, Lyric as LayoutLyric, TextFrame, type PageItem } from "../layout/layout";
import { Point } from "../common/geom";
import { MetaData } from "../smufl/smufl";
import { loadMusicXml } from "../score/musicxml";
import { abcToMusicXml } from "../abc/abc2xml";
import { scoreToJpwabc, scoreToJpwabcWithMeta, type JpwMeta, type JpwRange } from "../score/jpscore";
import { convertJpwabc, detectDirection, type HanDirection } from "../jpword/hanconv";
import { decodeJpwabc, encodeJpwabc, isTauriRuntime, saveBytes } from "./fileio";
import { MixedPainter } from "../mixed/painter";
import { ScorePlayer, type PlayState } from "./player";
import { playTempo, SPEED_STEPS, type PlayOptions } from "../score/timeline";
import { OmrController, type OmrHost } from "./omrctl";
export type { OmrFormat } from "../omr";

/** 文本谱的扩展名。`.txt` 太泛，靠 sniffDialect 兜底，认不出就不动。 */
const PU_EXT_RE = /\.(pu|fq|jps|txt)$/i;

export class App implements OmrHost {
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
  private meta: MetaData;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private zoomSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private selectedEl: SVGGElement | null = null;
  statusEl: HTMLElement | null = null;
  private _player: ScorePlayer | null = null;
  private _playBtnEl: HTMLButtonElement | null = null;
  private _speedSelEl: HTMLSelectElement | null = null;
  /** Per-part linear volume in [0,1]; index = part index. Missing = 1 (full). */
  partVolumes: number[] = [];
  /** 试听/导出 MIDI 的速度倍率（1 = 谱面标注速度）。持久化。 */
  playSpeed = 1;
  // Selected note (for "play from here"): its chord + which verse/pass row.
  private _selectedChord: import("../score/score").Chord | null = null;
  private _selectedVerse = 0;

  private static readonly SETTINGS_KEY = "jpeditor-render-settings";
  private static readonly LAST_FILE_KEY = "jpeditor-last-file";

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

  /** Restore persisted render settings; call before mountEditor() so first render uses them. */
  loadSettings(): void {
    try {
      const raw = localStorage.getItem(App.SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<{
        pageW: number; pageH: number; fontSize: number;
        titleSize: number; creditSize: number; color: number; zoom: number;
        mixedHideBarNumber: boolean; mixedShowJianpuLayer: boolean; playSpeed: number;
        omrFormat: unknown;
      }>;
      this.omr.loadSettings(s);
      if (s.playSpeed) this.playSpeed = Math.max(0.25, Math.min(3, s.playSpeed));
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
    } catch {
      // corrupt storage — ignore
    }
  }

  /** OmrHost 也要用（切输出格式后持久化）。 */
  saveSettings(): void {
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
        mixedShowJianpuLayer: this.mixedShowJianpuLayer,
        playSpeed: this.playSpeed,
        omrFormat: this.omr.format,
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
        this.omr.remapMeta((m) => mapMeta(m, u.changes));
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
  }

  getText(): string {
    return this.view.state.doc.toString();
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
    const breakDesc = f.getSection(LayoutSection)?.desc ?? null;
    try {
      this.painter.resize(this.pageW, this.pageH, breakDesc);
    } catch (e) {
      console.error("layout failed", e);
      return false;
    }
    this.renderPages();
    this.refreshSpeedUi(); // 谱面 ♩= 随文本走，速度提示要跟着换
    return true;
  }

  /**
   * Render a standalone `.jpwabc` snippet to its own `<svg>` for the help /
   * notation documentation examples. Uses a throwaway painter (does not touch
   * the live score) sharing this app's SMuFL metadata. Returns null on parse/
   * layout failure so the caller can silently drop unsupported examples.
   * The svg keeps the full page viewBox; crop to content via getBBox after it
   * is attached to the DOM.
   *
   * `titlePage: true` renders the standalone title page (Title/SubTitle/credit/
   * expression layout); otherwise renders the first content page with its
   * footer (running title + page number) stripped so only the music remains.
   */
  renderExampleSvg(jpwabc: string, opts: { width?: number; height?: number; titlePage?: boolean } = {}): SVGSVGElement | null {
    const width = opts.width ?? 1600;
    const height = opts.height ?? 540;
    let f: JpwFile | null;
    try {
      f = JpwFile.fromString(jpwabc);
    } catch {
      return null;
    }
    if (!f) return null;
    let score;
    try {
      score = fromJpw(f);
    } catch {
      return null;
    }
    if (!score) return null;
    // Lyric-less snippets get pass=0 → empty playData → blank layout. Synthesize
    // a single play pass over all measures so examples without .Words still render.
    if (score.playData.measures.length === 0 && score.parts[0]) {
      const pi = new PlayItem();
      pi.pass = 1;
      pi.mid = 0;
      pi.end = score.parts[0].measures.length;
      score.playData.measures.push(pi);
      score.playData.isSimpple = true;
    }
    const p = new JinpuPainter(this.fontSize);
    p.layout.options.smuflMeta = this.meta;
    // 示例画在压暗的米白纸上（styles.css 的 --help-paper），墨色也从纯黑收一档，
    // 免得深色界面上黑白对比过硬。真正的谱面预览仍是纯白纸 + 用户设定的颜色。
    p.layout.options.color = 0xff1a1a1a;
    p.score = score;
    const breakDesc = f.getSection(LayoutSection)?.desc ?? null;
    try {
      if (opts.titlePage) {
        // resize() prepends a standalone title page at index 0.
        p.resize(width, height, breakDesc);
        return p.renderPage(0);
      }
      p.pageWidth = width;
      p.pageHeight = height;
      p.layout.fromScore(score, breakDesc, width, height);
      const pg = p.layout.pages[0];
      if (!pg) return null;
      // fromScore appends a running-title + page-number footer as the last two
      // children of each page; drop them so examples show only the music.
      if (pg.children.length > 2) pg.children.splice(pg.children.length - 2, 2);
      pg.update();
      return p.renderPage(0);
    } catch {
      return null;
    }
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
    this._player?.stop();
    this.selectedEl = null;
    this._renderPagesWith(painter.pageCount, (i) => painter.renderPage(i), {
      aspectRatio: (i) => {
        // 文本谱的「原版」是连续长图，宽高比随谱而变，不能用 CSS 里写死的 960/540
        const { w, h } = painter.pageSize(i);
        return `${w} / ${h}`;
      },
    });
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
    this._player?.stop(); // relayout invalidates chord objects / highlight
    this.selectedEl = null;
    this._renderPagesWith(this.painter.pageCount, (i) => this.painter.renderPage(i), {
      onPage: (svg, _wrap, i) => svg.addEventListener("click", (e) => this.onPageClick(i, svg, e)),
    });
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

  // ---------------- paging ----------------
  goToPage(i: number): void {
    const np = Math.max(0, Math.min(i, this.pageEls.length - 1));
    this.pageIndex = np;
    this.pageEls[np]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // ---------------- playback ----------------
  setPlaybackBtn(el: HTMLButtonElement): void {
    this._playBtnEl = el;
    this.onPlayState("stopped");
  }

  private player(): ScorePlayer {
    if (!this._player) {
      this._player = new ScorePlayer(
        (chord, pass) => this.onPlayChord(chord, pass),
        (state) => this.onPlayState(state),
      );
    }
    return this._player;
  }

  private onPlayChord(chord: import("../score/score").Chord | null, pass: number): void {
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

  private onPlayState(state: PlayState): void {
    if (!this._playBtnEl) return;
    const label = state === "loading" ? "加载中" : state === "playing" ? "停止" : "播放";
    const icon = this._playBtnEl.querySelector<HTMLElement>(".playback-icon");
    const labelEl = this._playBtnEl.querySelector<HTMLElement>(".playback-label");
    this._playBtnEl.dataset.state = state;
    this._playBtnEl.disabled = state === "loading";
    this._playBtnEl.setAttribute("aria-label", label);
    this._playBtnEl.title = state === "playing" ? "停止试听" : state === "loading" ? "正在加载试听音色" : "播放试听";
    if (labelEl) labelEl.textContent = label;
    if (icon) {
      icon.classList.toggle("is-loading", state === "loading");
      icon.textContent = state === "playing" ? "■" : state === "loading" ? "" : "▶";
    }
  }

  /** Number of parts in the current score (for the mixer UI). */
  get partCount(): number {
    return this.painter.score.parts.length;
  }
  getPartVolume(i: number): number {
    const v = this.partVolumes[i];
    return v === undefined ? 1 : v;
  }
  setPartVolume(i: number, v: number): void {
    this.partVolumes[i] = Math.max(0, Math.min(1, v));
  }

  /** 试听/导出 MIDI 共用的播放参数。 */
  playOptions(): PlayOptions {
    return { partVolumes: this.partVolumes, speed: this.playSpeed };
  }

  /** 谱面标注的速度 ♩=NN（0 = 未标注，试听按默认 90）。 */
  get scoreTempo(): number {
    return this.painter.score.playData.tempo;
  }

  /** 设置速度倍率并持久化；正在播放时按新速度重播（音已排好队，只能重来）。 */
  setPlaySpeed(mul: number): void {
    const v = Math.max(0.25, Math.min(3, mul));
    if (v === this.playSpeed) return;
    this.playSpeed = v;
    this.saveSettings();
    this.refreshSpeedUi();
    if (this._player?.state === "playing") void this.playScore();
  }

  /** 工具条速度下拉与谱速提示的同步（换谱、改倍率后调用）。 */
  refreshSpeedUi(): void {
    const sel = this._speedSelEl;
    if (!sel) return;
    sel.value = String(this.playSpeed);
    const bpm = Math.round(playTempo(this.painter.score, this.playOptions()));
    const marked = this.scoreTempo > 0 ? `谱面 ♩=${this.scoreTempo}` : "谱面未标速度，按 ♩=90";
    sel.title = `播放速度：${marked}，当前 ♩=${bpm}`;
  }

  bindSpeedSelect(el: HTMLSelectElement): void {
    this._speedSelEl = el;
    el.innerHTML = "";
    for (const v of SPEED_STEPS) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = v === 1 ? "原速" : `×${v}`;
      el.append(o);
    }
    el.addEventListener("change", () => this.setPlaySpeed(parseFloat(el.value) || 1));
    this.refreshSpeedUi();
  }

  async playScore(): Promise<void> {
    if (this.mode !== "jp") return; // playback is jianpu-mode only
    // 文本谱先转成 Score（谱面高亮走 PuPainter 自己的索引，见 _puPlaybackScore）
    const score = this.docFormat === "pu" ? this.puScore() : this.painter.score;
    if (!score) {
      this.setStatus("这份文本谱里没有可试听的曲行");
      return;
    }
    const start =
      this._selectedChord !== null
        ? { chord: this._selectedChord, pass: this._selectedVerse }
        : undefined;
    try {
      await this.player().play(score, this.playOptions(), start);
    } catch (e) {
      console.error("playback failed", e);
      this._player?.stop();
      this.setStatus("试听加载失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  async togglePlayback(): Promise<void> {
    if (this._player?.state === "playing" || this._player?.state === "loading") {
      this.stopPlayback();
      return;
    }
    await this.playScore();
  }

  stopPlayback(): void {
    this._player?.stop();
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
    if (PU_EXT_RE.test(name)) {
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
      if (this.mode === "mixed") {
        this.mode = "jp";
        this._setMixedLayout(false);
        this._setPreviewModeActive("jp");
      }
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
        if (autoMixed) {
          this.mode = "mixed";
          this._setMixedLayout(true);
          this._setPreviewModeActive("mixed");
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
      if (this.mode === "mixed") {
        this.mode = "jp";
        this._setMixedLayout(false);
        this._setPreviewModeActive("jp");
      }
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
    if (this.mode === "recognize") {
      this.mode = "jp";
      this.omr.leaveLayout();
    } else if (this.mode === "mixed") {
      this.mode = "jp";
      this._setMixedLayout(false);
      this._setPreviewModeActive("jp");
    }
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
    if (on) {
      // 从混排切入识别：先退混排布局
      if (this.mode === "mixed") {
        this._setMixedLayout(false);
        this._setPreviewModeActive("jp");
      }
      this.mode = "recognize";
    } else {
      this.mode = "jp";
    }
  }

  /** 文本谱产物落地：丢掉混排底本、切 docFormat、清文件路径，再设文本。 */
  adoptPuText(text: string): void {
    this.mixedXmlText = null;
    this._mixedPainter = null;
    this._setMixedAvailable(false);
    if (this.mode === "mixed") {
      this.mode = "jp";
      this._setMixedLayout(false);
      this._setPreviewModeActive("jp");
    }
    this._setDocFormat("pu");
    this.filePath = null;
    this.setText(text);
  }

  async showJpPreview(): Promise<void> {
    if (this.mode === "jp") return;
    this.stopPlayback();
    if (this.mode === "recognize") this.omr.leaveLayout();
    if (this.mode === "mixed") this._setMixedLayout(false);
    this.mode = "jp";
    this._setPreviewModeActive("jp");
    this.reload(this.getText());
  }

  async showStaffPreview(): Promise<void> {
    if (!this.mixedXmlText) return;
    if (this.mode === "mixed") return;
    this.stopPlayback();
    if (this.mode === "recognize") this.omr.leaveLayout();
    this.mode = "mixed";
    this._setMixedLayout(true);
    this._setPreviewModeActive("mixed");
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
    this.view.dispatch({
      effects: this._readOnlyCompartment.reconfigure(EditorState.readOnly.of(on)),
    });
    document.getElementById("body")?.classList.toggle("mixed", on);
    const meta = document.getElementById("code-pane-meta");
    if (meta) meta.textContent = on ? "只读" : this._formatLabel();
  }

  /** 已解析出的文本谱方言，用于代码区标签（解析前未知）。 */
  private _puDialect: "tomato" | "shige" | null = null;
  private _puDoc: { text: string; doc: PuDoc } | null = null;
  private _puScoreCache: {
    text: string;
    score: Score | null;
    noteMap: Map<Chord, PuNoteElement>;
  } | null = null;

  /** 代码区右上角的格式标签。 */
  private _formatLabel(): string {
    if (this.docFormat !== "pu") return "JPWABC";
    if (this._puDialect === null) return "文本谱";
    return `文本谱·${dialectSpec(this._puDialect).shortName}`;
  }

  private _syncFormatLabel(): void {
    const meta = document.getElementById("code-pane-meta");
    if (meta && meta.textContent !== "只读") meta.textContent = this._formatLabel();
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
      input.accept = ".jpwabc,.pu,.fq,.jps,.txt,.xml,.musicxml,.abc";
      input.onchange = async () => {
        changeStarted = true;
        const file = input.files?.[0];
        if (!file) { finish(false); return; }
        const buf = new Uint8Array(await file.arrayBuffer());
        this.importBytes(buf, file.name);
        if (!/\.(xml|musicxml|abc)$/i.test(file.name)) this.filePath = file.name;
        finish(true);
      };
      window.addEventListener("focus", () => setTimeout(() => {
        if (!changeStarted) finish(false);
      }, 500), { once: true });
      input.click();
    });
  }

  async saveFile(): Promise<void> {
    if (this.filePath && isTauriRuntime()) {
      await this.writeTo(this.filePath);
      return;
    }
    await this.saveFileAs();
  }

  async saveFileAs(): Promise<void> {
    // 落盘细节（对话框 / a[download]）统一在 fileio.saveBytes，这里只管记住路径。
    const dest = await saveBytes(this.encodeForSave(), this.defaultSaveName());
    if (!dest) return;
    this.filePath = dest;
    this.rememberLastFile(dest);
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
  private encodeForSave(): Uint8Array {
    return this.docFormat === "pu"
      ? new TextEncoder().encode(this.getText())
      : encodeJpwabc(this.getText());
  }

  private async writeTo(path: string): Promise<void> {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(path, this.encodeForSave());
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
