// App controller: CodeMirror editor <-> live relayout/render <-> paging <-> file I/O.
// Mirrors EditorController in CodeEditor.kt (doBind/tryLoad/updateLayout/paint/load/doSave).

import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { parsePu, sniffDialect, dialectSpec, type Dialect } from "../pu";
import { parse123, parseAbc } from "../j123/parse";
import { eachChord } from "../model/helpers";
import type { ElementId, ScoreDoc } from "../model/doc";
import type { JScore } from "../layout/input";
import { clearBreaks } from "../layout/input";
import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { measureJianpu, PaintResources, ScorePainter, type JianpuPaintRequest } from "../layout/painter";
import { toPt } from "../layout/result";
import { computeStyle, sanitizeLayer, upsertRule, type StyleEngine, type StyleRule } from "../style/cascade";
import { docPageLayer, pageMargins, resolvePaper, songPageDecl } from "../style/paper";
import type { PageDecl } from "../style/sheet";
import { isLongImage, jianpuSizes } from "../style/jianpu";
import type { DeepPartial, StyleSheet } from "../style/sheet";
import { LONG_IMAGE_WIDTH, PAGE_RATIOS, STAFF_LONG_IMAGE_WIDTH, STAFF_PAPER_DEFAULT, THEMES, computeStyleForPaper, isPaper, themeOfMode } from "../style/themes";
import { JpNumber, Lyric as LayoutLyric, TextFrame, type PageItem } from "../layout/pageitem";
import { colorToCss } from "../common/geom";
import { MetaData } from "../smufl/smufl";
import { jianpuInputOfDoc, jianpuInputOfJpw, jianpuInputOfXml } from "../model/jianpuinput";
import type { FitMeasure } from "../pu/phrase";
import { abcToMusicXml } from "../abc/abc2xml";
import type { JpwMeta, JpwRange } from "../omr/types";
import { convertJpwabc, detectDirection, type HanDirection } from "../jpword/hanconv";
import { isTauriRuntime, saveBytes } from "./fileio";
import { DOC_EXT, acceptAttr, is123File, isPuFile } from "../common/filetypes";
import { formatOf, type DocFormatId, type FormatAdapter, type FormatHost } from "./formats";
import { SyncIndex, type SyncEntry } from "./sync";
import { VisualEditController, type VisualHost } from "./visual/controller";
import { visualCursorExtension } from "./visual/cursor";
import { hitThroughOverlay } from "./visual/overlay";
import type { EditDialect } from "./visual/dialect";
import { describeLosses, planSave } from "../model/capability";
import { CONVERT_TARGETS, isConvertTarget, targetSpec, type ConvertTarget } from "../model/convert";
import { showChoiceDialog, showConfirmDialog } from "./dialogs";
import { buildMusicXml, sourceMusicXmlBare } from "./export";
import { scoreDocToMusicXml } from "../model/toxml";
import { jpwToScoreDoc } from "../model/fromjpw";
import { PlaybackController, type PlaybackHost } from "./playback";
import type { PlayPoint } from "./player";
import type { PlaySource } from "../score/timeline";
import { playSourceOf } from "../model/playsong";
import { OmrController, type OmrHost } from "./omrctl";
import { FileFormatSource, FormatSwitch, type FileSwitchHost, type FormatSwitchHost, type OriginFormat } from "./formatswitch";
import type { JianpuLayoutMode, JpProfileName } from "../jianpu/profile";
import {
  loadPersistedSettings, savePersistedSettings, loadLastFile, saveLastFile, clearLastFile,
} from "./settings";
export type { OmrFormat } from "../omr";

/** 有纸张设置的三把尺子：简谱原样档、文本谱原样档、五线谱/混排。 */
export type PaperEngine = "jianpu" | "pu" | "staff";
/** 纸张栏的一次选择：纸名 + 方向 + 边距（`[上, 右, 下, 左]` pt，null = 自动），或跟随文件。 */
export type PaperChoice = "follow" | { paper: string; orientation: "portrait" | "landscape"; margin: number[] | null };

/** 谱面区的四档排版模式。见 `App.setViewModeButtons` 的注释：这是两组正交状态的组合。 */
export type ViewMode = JianpuLayoutMode | "staff" | "mixed";

/** 文本谱的扩展名。`.txt` 太泛，靠 sniffDialect 兜底，认不出就不动。 */

export class App implements OmrHost, PlaybackHost, FormatHost, FormatSwitchHost, FileSwitchHost, VisualHost {
  /** 预览排版器（唯一的 `ScorePainter`）：简谱原样 / 展开档、原样文档（文本谱与多声部）、五线谱 / 混排档
   *  都由它排、铺页、高亮。 */
  painter: ScorePainter;
  view!: EditorView;
  scorePane: HTMLElement;
  pageEls: HTMLElement[] = [];
  pageIndex = 0;
  filePath: string | null = null;
  mode: "jp" | "mixed" | "recognize" = "jp";
  /** 当前编辑的是哪种源格式。每种格式的差异全在 `editor/formats.ts` 的适配器表里，
   *  **不要在这里再长出 `docFormat === …` 的三目式**。 */
  docFormat: DocFormatId = "jpwabc";
  /** 文本谱当前的排版输出：`slide` = 展开、`print` = 原样（名字沿用存量设置）。 */
  puProfile: "print" | "slide" = "slide";
  /** 简谱版面档：`normal` = 当前观感；`pptx` = 排版重构之前的笔画（导出 PPTX 用的那一档）。 */
  jpProfile: JpProfileName = "pptx";
  /** 最近一次排版用的 `.Layout` 分页描述（导出 PPTX 按展开档另排一遍时要用同一份）。 */
  private _breakDesc: string | null = null;
  /** 已解析出的文本谱方言，用于代码区标签（解析前未知）。 */
  private _puDialect: Dialect | null = null;
  /** 上次解析结果的缓存（同一份文本不重复解析）。文本谱的乐句重排也读它（原文区间在模型上，`pu/relayout.ts`）。 */
  private _scoreDoc: { text: string; doc: ScoreDoc } | null = null;
  /** 上次投影出的引擎输入（展开档谱面、导出 PPTX 共用）。 */
  private _puScoreCache: {
    text: string;
    /** 投影出这份输入的模型（排版器、同步索引认的是它的排版行视图） */
    doc: ScoreDoc;
    /** 展开档那一份调过声部顺序与段号（`JianpuInputOptions.forExpanded`），与原样档那份不通用 */
    forExpanded: boolean;
    score: JScore | null;
  } | null = null;
  private _highlightCompartment = new Compartment();

  // ---- 双向定位（代码区光标 ↔ 谱面元素，见 editor/sync.ts）----
  private _sync = new SyncIndex();
  /** 谱面 `<g>` → 索引条目（点谱面时从事件目标往上找） */
  private _syncEls = new Map<Element, SyncEntry>();
  /** 条目 → 谱面 `<g>`（光标移动时直接取） */
  private _syncElOf = new Map<SyncEntry, SVGGElement>();
  /** 页眉字段 → 谱面上画它的那几个 `<g>`（多行署名、调号拍号一组都不止一个） */
  private _syncHeaderEls = new Map<SyncEntry, SVGGElement[]>();
  /** 当前被光标点亮的那些 `<g>` */
  private _syncMarked: Element[] = [];
  /** 防回环：两条方向互相触发时，被动的那一侧不要再反推一次 */
  private _syncing = false;
  /** 建 `_sync` 用的那份模型（可视化编辑按它数对位格） */
  private _syncDoc: ScoreDoc | null = null;
  /** 建 `_sync` 时代码区的原文：与当前原文不同就说明索引落后了（重排还在防抖里） */
  private _syncText = "";
  /** `.jpwabc`：`jpwToScoreDoc` 的结果（试听读它；转不出来为 null） */
  private _jpwDoc: ScoreDoc | null = null;
  /** 试听输入的缓存：同一份模型、同一档只拼一次（`refreshSpeedUi` 每次重排都要取速度） */
  private _playCache: { doc: ScoreDoc; forExpanded: boolean; src: PlaySource | null } | null = null;

  /** 五线谱/混排档读的模型（MusicXML 形状）；null = 还没有（或读不出）五线谱视图。
   *  `.musicxml`：底本原文在 `mixedDoc.source`，混排档导出 MusicXML 原样给出（`export.ts::buildMusicXml`）；
   *  文本格式：进五线谱时由源文派生（`_ensureMixedDoc`），`_mixedDerivedText` 记它由哪份源文与哪套简谱设置来（`_mixedDeriveKey`）。 */
  mixedDoc: ScoreDoc | null = null;
  private _mixedDerivedText: string | null = null;
  /** 在途的五线谱 / 混排排版（异步），`whenIdle` 等它。 */
  private _pendingStaff: Promise<void> | null = null;
  /** 排版模式切换（展开 / 原样 / 五线谱 / 混排）的四个按钮，见 `ViewMode`。 */
  private _viewBtns = new Map<ViewMode, HTMLButtonElement>();
  private _viewSwitchEl: HTMLElement | null = null;
  /** `.musicxml` 读不出来时五线谱/混排两档置灰；文本格式一律可点（派生失败在点的时候报）。 */
  private _mixedAvailable = false;
  /** 代码区标题栏的格式下拉：识别结果与打开的文件共用（见 editor/formatswitch.ts）。 */
  readonly formats: FormatSwitch = new FormatSwitch(this);
  /** 简谱 OMR 的那一摊（识别、叠加核对、点选定位、输出格式）——见 editor/omrctl.ts。 */
  readonly omr: OmrController = new OmrController(this);
  // 乐句排版：缓存导入时的「原始排版」文本以便无损切回；_phraseOn 记当前是否乐句排版。
  private _originalLayoutBtnEl: HTMLButtonElement | null = null;
  private _phraseBtnEl: HTMLButtonElement | null = null;
  private _origLayoutText: string | null = null;
  private _phraseOn = false;
  /** 文本谱：上一次重排**产出的**那份原文。文本与它不同了就说明用户自己动过手。 */
  private _phraseText: string | null = null;
  private _hanziBtnEl: HTMLButtonElement | null = null;
  private _readOnlyCompartment = new Compartment();
  // ---- 渲染设置（应用级，不属于文档）：一律经样式层（src/style/）----
  /** 用户层：每个主题一层规则，**两档各记一套**（用户口径：「区分 展开/原样的字号设置」）。
   *  展开档（主题 projection）的字号、比例、配色两种格式共用，规则不带限定；
   *  原样档（主题 print）的纸与字号 `.jpwabc` 与文本谱各记各的（`engine` 限定），配色共用。 */
  private _userLayers: Record<"projection" | "print" | "staff", StyleRule[]> = { projection: [], print: [], staff: [] };

  /** 某一档、某把尺子看到的 computed 样式表（内置主题 → 曲内层 → 用户层）。
   *  曲内层（谱里自带的纸，`style/paper.ts`）只垫在原样档下面：展开档是投影片，不认纸。 */
  styleOf(mode: JianpuLayoutMode, engine: StyleEngine = "jianpu"): StyleSheet {
    const theme = themeOfMode(mode);
    const doc = theme === "print" && !(engine === "jianpu" || engine === "pu" ? this._userSetsPaper(engine) : false) ? this._docLayer() : [];
    return computeStyleForPaper([THEMES[theme], doc, this._userLayers[theme]], { mode, engine });
  }

  /** 五线谱/混排看到的 computed 样式表（主题 staff → 曲内层 → 它自己那层用户规则）。
   *  **纸不借简谱原样档的**：那边出厂是长图，五线谱排成长图就是一张 1000pt 宽的扁图。 */
  staffStyle(): StyleSheet {
    const doc = this._userSetsPaper("staff") ? [] : this._docLayer();
    return computeStyleForPaper([THEMES.staff, doc, this._userLayers.staff], { mode: "staff", engine: "staff" });
  }

  /** 曲内层：当前文档自带的纸（MusicXML `<page-layout>`、123/ABC `I:meta page …`）。`.jpwabc` 与文本谱没有。
   *  **用户在这一档明确选过纸就整层不用**（`styleOf` / `staffStyle` 判）：选了 A4、边距留空是要排版器自己的边距，
   *  不是「A4 + 文件里那组边距」。目前曲内层只有纸，将来放别的东西要改成按键剔。 */
  private _docLayer(): StyleRule[] {
    if (!this.adapter.toScoreDoc) return [];
    return docPageLayer(this.currentScoreDoc()?.songs[0]);
  }

  /** 设置面板的纸张那一栏：谱里自带的纸（「跟随文件」显示用）、用户层有没有明确选过纸、算出来实际用的那张。 */
  paperState(engine: PaperEngine): { doc: PageDecl | null; userSet: boolean; page: PageDecl } {
    const song = this.adapter.toScoreDoc ? this.currentScoreDoc()?.songs[0] : undefined;
    const doc = song ? songPageDecl(song) : null;
    const page = engine === "staff" ? this.staffStyle().page : this.styleOf("original", engine).page;
    return { doc, userSet: this._userSetsPaper(engine), page };
  }

  /** 用户层有没有明确选过纸/方向/边距（五线谱/混排据此决定要不要盖过谱里的 `<page-layout>`）。 */
  private _userSetsPaper(engine: PaperEngine): boolean {
    const layer = engine === "staff" ? this._userLayers.staff : this._userLayers.print;
    const pg = computeStyle([layer], { mode: engine === "staff" ? "staff" : "original", engine }).page;
    return pg.paper !== undefined || pg.orientation !== undefined || pg.margin !== undefined;
  }

  /** 设纸：`follow` = 跟随文件（清掉用户层里的纸、方向、边距；谱里没写纸就回到出厂那张）。 */
  private _setPaper(engine: PaperEngine, choice: PaperChoice): void {
    const key = engine === "staff" ? "staff" : "print";
    const when = engine === "staff" ? undefined : { engine };
    if (choice === "follow") {
      this._userLayers[key] = this._userLayers[key].map((r) => {
        if ((r.when?.engine ?? undefined) !== when?.engine || !r.set.page) return r;
        const { paper: _p, orientation: _o, margin: _m, ...rest } = r.set.page;
        return { ...r, set: { ...r.set, page: rest } };
      });
      return;
    }
    if (!isPaper(choice.paper)) return;
    const page: DeepPartial<PageDecl> = { paper: choice.paper, orientation: choice.orientation };
    this._userLayers[key] = upsertRule(this._userLayers[key], when, { page });
    // 边距整组替换（深合并会把数组整体换掉）；null = 清掉，回到各排版器自己的缺省
    const hit = this._userLayers[key].find((r) => (r.when?.engine ?? undefined) === when?.engine);
    if (hit?.set.page) {
      if (choice.margin) hit.set.page.margin = [...choice.margin];
      else delete hit.set.page.margin;
    }
  }

  /** 往某一档的用户层写一条规则（限定相同的就地合并）。 */
  private _setStyle(mode: JianpuLayoutMode, engine: StyleEngine | undefined, set: DeepPartial<StyleSheet>): void {
    const theme = themeOfMode(mode);
    this._userLayers[theme] = upsertRule(this._userLayers[theme], engine ? { engine } : undefined, set);
  }

  /** 展开档的投影片尺寸（`PAGE_RATIOS` 那几张）。 */
  get pageW(): number {
    return this.styleOf("expanded").page.w ?? PAGE_RATIOS["16:9"][0];
  }
  get pageH(): number {
    return this.styleOf("expanded").page.h ?? PAGE_RATIOS["16:9"][1];
  }
  /** 当前档的简谱字号（展开档三个都能调；原样档**只调基础字号**，标题与词曲按出厂比例派生，见 `style/jianpu.ts`）。
   *  排版器、设置面板、帮助示例都只认「当前档」。 */
  get fontSize(): number {
    return jianpuSizes(this.styleOf(this.layoutMode)).fontSize;
  }
  get titleSize(): number {
    return jianpuSizes(this.styleOf(this.layoutMode)).titleSize;
  }
  get creditSize(): number {
    return jianpuSizes(this.styleOf(this.layoutMode)).creditSize;
  }
  /** 当前档实际排版用的那张纸。展开档就是 `pageW`/`pageH` 那张投影片；原样档宽度锁定、
   *  原样档取 `PAPER_SIZES` 里那张实际纸（长图那一档不分页，返回的高度只是个占位）。
   *  排版、分行度量（`_phraseFit`）都认它——两处若各用各的纸，行长会按 A 张纸算、
   *  按 B 张纸排。 */
  get layoutPage(): { w: number; h: number } {
    if (this.layoutMode === "expanded") return { w: this.pageW, h: this.pageH };
    const paper = resolvePaper(this.styleOf("original", "jianpu").page);
    // 长图：宽固定，高度由内容说了算（传进去的只是个不参与分页的占位）
    if (!paper) return { w: LONG_IMAGE_WIDTH, h: LONG_IMAGE_WIDTH };
    return paper;
  }

  /** 原样档当前是不是长图那一档。 */
  get jpLongImage(): boolean {
    return isLongImage(this.styleOf("original", "jianpu"));
  }

  /** 原样档换纸（「长图」也是其中一档）。 */
  setJpPaper(paper: string): void {
    this.applyRenderSettings({ jpPaper: paper });
  }

  /** 前景色（谱面笔画/文字）与背景色（纸张）。档指的是「展开 / 原样」那一对排版方式，
   *  跨文档格式——`.jpwabc` 与文本谱在同一档下共用同一份色。
   *  背景色只作用于「纸」（预览页的底、导出 PNG 的底、PPTX 的幻灯片底），排版器不认识它。 */
  get color(): number {
    return this.colorsOf(this.layoutMode).fg;
  }
  get bgColor(): number {
    return this.colorsOf(this.layoutMode).bg;
  }
  /** 某一档的配色。导出 PPTX 要按 **展开档**另排一遍，用的就得是那一档的色。 */
  colorsOf(mode: JianpuLayoutMode): { fg: number; bg: number } {
    const page = this.styleOf(mode).page;
    return { fg: page.ink ?? 0xff000000, bg: page.background ?? 0xffffffff };
  }
  /** 原样档的纸（键取自 `PAPER_SIZES`，「长图」是其中一档）。 */
  get jpPaper(): string {
    return this.styleOf("original", "jianpu").page.paper ?? "长图";
  }
  /** 文本谱「原样」档的纸。 */
  get puPaper(): string {
    return this.styleOf("original", "pu").page.paper ?? "长图";
  }
  /** 文本谱原样档音符数字的字号（pt）。0 = 跟随版式量到的原尺寸。 */
  get puFontSize(): number {
    const v = this.styleOf("original", "pu").roles.note?.size;
    return typeof v === "number" ? v : 0;
  }
  mixedHideBarNumber = false; // 混排：隐藏小节号
  /** 用户打开单声部 MusicXML 时怎么办：`ask` 每次问；`musicxml` 保持原文进五线谱；其余是转成哪种源格式编辑。 */
  musicXmlImport: "ask" | "musicxml" | ConvertTarget = "ask";
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
  /** 可视化编辑（谱面上选中、光标、快捷键），入口 `app.visual.*` */
  readonly visual: VisualEditController = new VisualEditController(this);
  /** 试听/导出 MIDI 的速度倍率（1 = 谱面标注速度）。持久化。 */
  // Selected note (for "play from here"): its chord + which verse/pass row.
  private _selectedId: ElementId | null = null;
  private _selectedVerse = 0;


  constructor(meta: MetaData, scorePane: HTMLElement) {
    this.meta = meta;
    this.painter = new ScorePainter(PaintResources.fixed(meta));
    this.scorePane = scorePane;
  }

  /** 按当前档与设置组一份简谱引擎的排版请求（预览与 `jianpuLineStarts` 共用）。
   *  展开档取展开档样式里的投影片尺寸，原样档取 `layoutPage` 那张纸。 */
  private _jianpuRequest(score: JScore, breakDesc: string | null): JianpuPaintRequest {
    if (this.layoutMode === "expanded") return { view: "expanded", score, breakDesc, style: this.styleOf("expanded") };
    return { view: "original", score, breakDesc, style: this.styleOf("original", "jianpu"), page: this.layoutPage };
  }

  /** 把一份引擎输入交给排版器排版（资源在构造时已就绪，同步提交）。 */
  private _layoutScore(score: JScore, breakDesc: string | null, p = this.painter): void {
    p.loadSync(this._jianpuRequest(score, breakDesc));
  }

  /** 简谱版面切换（原版 / PPT）。展开档 = 2026-08 排版重构之前的笔画观感，
   *  也是「导出 PPTX」用的那一档，见 style/jianpu.ts 的 `pptx` 预设。 */
  setJpProfile(profile: JpProfileName): void {
    if (this.jpProfile === profile) return;
    this.jpProfile = profile;
    // 换档连字号与配色也换了一套（两档各记各的，排版时按档取样式）；
    // 纸底那层是 CSS 变量、不经排版器，得单独刷一次
    this._applyPageBg();
    this._syncViewModeButtons();
    this.saveSettings();
    if (this.adapter.profileKnob === "jp") this.reload(this.getText());
  }

  /** 面板那几项设置落进**样式层的用户层**并重排。签名沿用（回归脚本也走它）。
   *  纸与字号按档、按格式分开记；配色按档记；投影片比例只归展开档。 */
  applyRenderSettings(opts: {
    pageW?: number; pageH?: number; jpPaper?: string;
    puPaper?: string; puFontSize?: number; staffPaper?: string;
    /** 纸张栏（纸 + 方向 + 边距，或跟随文件）。给了就盖过上面三个只换纸名的。 */
    paper?: Partial<Record<PaperEngine, PaperChoice>>;
    fontSize?: number; titleSize?: number; creditSize?: number; color?: number; bgColor?: number;
  }): void {
    const mode = this.layoutMode;
    if (opts.pageW || opts.pageH) {
      this._setStyle("expanded", undefined, { page: { ...(opts.pageW ? { w: opts.pageW } : {}), ...(opts.pageH ? { h: opts.pageH } : {}) } });
    }
    // 原样档的纸要在重排之前定好——排版时按长图灌 continuousPage
    if (opts.jpPaper && isPaper(opts.jpPaper)) this._setStyle("original", "jianpu", { page: { paper: opts.jpPaper } });
    if (opts.puPaper && isPaper(opts.puPaper)) this._setStyle("original", "pu", { page: { paper: opts.puPaper } });
    if (opts.staffPaper && isPaper(opts.staffPaper)) this._userLayers.staff = upsertRule(this._userLayers.staff, undefined, { page: { paper: opts.staffPaper } });
    for (const [engine, choice] of Object.entries(opts.paper ?? {}) as [PaperEngine, PaperChoice][]) this._setPaper(engine, choice);
    if (opts.puFontSize !== undefined) {
      this._setStyle("original", "pu", { roles: { note: { size: Math.min(200, Math.max(0, opts.puFontSize)) } } });
    }
    if (opts.color !== undefined) this._setStyle(mode, undefined, { page: { ink: opts.color } });
    if (opts.bgColor !== undefined) this._setStyle(mode, undefined, { page: { background: opts.bgColor } });
    this._applySizes(mode, opts);
    this._applyPageBg();
    this.saveSettings();
    this.reload(this.getText());
    // `.musicxml` 的五线谱/混排不经 reload 重排；谱里没写纸的要跟设置里的纸走
    if (this.mode === "mixed" && this.docFormat === "musicxml") void this._renderMixedPages();
  }

  /** 字号落到**当前档**那一套里。原样档只收基础字号——那一档的标题/词曲是派生的，
   *  面板上根本不显示（见 editor/dialogs.ts），收了也只会被下一次派生覆盖掉。 */
  private _applySizes(mode: JianpuLayoutMode, opts: { fontSize?: number; titleSize?: number; creditSize?: number }): void {
    if (mode === "original") {
      if (opts.fontSize) this._setStyle("original", "jianpu", { roles: { note: { size: opts.fontSize } } });
      return;
    }
    const roles: DeepPartial<StyleSheet["roles"]> = {};
    if (opts.fontSize) roles.note = { size: opts.fontSize };
    if (opts.titleSize !== undefined) roles.title = { size: opts.titleSize };
    if (opts.creditSize !== undefined) roles.credit = { size: opts.creditSize };
    if (Object.keys(roles).length) this._setStyle("expanded", undefined, { roles });
  }

  /** 恢复当前档的主题默认（清掉那一档的用户层）。 */
  resetRenderSettings(): void {
    this._userLayers[themeOfMode(this.layoutMode)] = [];
    this._applyPageBg();
    this.saveSettings();
    this.reload(this.getText());
    // `.musicxml` 的五线谱/混排不经 reload 重排；谱里没写纸的要跟设置里的纸走
    if (this.mode === "mixed" && this.docFormat === "musicxml") void this._renderMixedPages();
  }

  /** Restore persisted render settings; call before mountEditor() so first render uses them.
   *  存取机制在 editor/settings.ts；这里只管「哪个值落到哪个属性」。 */
  loadSettings(): void {
    const s = loadPersistedSettings();
    if (!s) return;
    this.omr.loadSettings(s);
    this.playback.loadSettings(s);
    this.visual.loadSettings(s);
    if (s.mixedHideBarNumber !== undefined) this.mixedHideBarNumber = s.mixedHideBarNumber;
    if (s.mixedShowJianpuLayer !== undefined) this.mixedShowJianpuLayer = s.mixedShowJianpuLayer;
    if (s.musicXmlImport === "ask" || s.musicXmlImport === "musicxml" || isConvertTarget(s.musicXmlImport)) {
      this.musicXmlImport = s.musicXmlImport;
    }
    // 样式用户层（旧版散存的字号/纸/配色字段不读——不做存量迁移）
    const layers = (s.styleLayers ?? {}) as Record<string, unknown>;
    this._userLayers = { projection: sanitizeLayer(layers.projection), print: sanitizeLayer(layers.print), staff: sanitizeLayer(layers.staff) };
    if (s.zoom) this.zoom = s.zoom;
    if (s.jpProfile === "normal" || s.jpProfile === "pptx") this.jpProfile = s.jpProfile;
    if (s.puProfile === "print" || s.puProfile === "slide") this.puProfile = s.puProfile;
    this._applyZoom();
    this._applyPageBg();
  }

  /** 两个控制器也要用（切输出格式 / 改速度后持久化）。 */
  saveSettings(): void {
    savePersistedSettings({
      styleLayers: this._userLayers,
      zoom: this.zoom,
      mixedHideBarNumber: this.mixedHideBarNumber,
      mixedShowJianpuLayer: this.mixedShowJianpuLayer,
      musicXmlImport: this.musicXmlImport,
      playSpeed: this.playback.speed,
      omrFormat: this.omr.format,
      jpProfile: this.jpProfile,
      puProfile: this.puProfile,
      showFormatMarks: this.visual.showFormatMarks,
      beatCheck: this.visual.beatCheck,
      noteSound: this.visual.noteSound,
      showPalette: this.visual.showPalette,
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

  /** 背景色灌进 #score-pane 的自定义属性，由 .score-page-wrap 继承。
   *  写在容器上而不是逐页写：页元素每次重排都重建（_renderPagesWith），
   *  写在容器上就不必在每条铺页路径里各记一次。 */
  private _applyPageBg(): void {
    this.scorePane.style.setProperty("--score-page-bg", colorToCss(this.bgColor));
  }

  mountEditor(parent: HTMLElement, initialText: string): void {
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        // 识别映射随用户编辑迁移偏移，保持点选仍落在正确 token。
        this.omr.remapMeta((m) => mapMeta(m, u.changes));
        this.scheduleReload();
      }
      // 光标/选区一动就同步到谱面。文档改了不在这里同步——索引还是旧偏移，
      // 等 reload 重建完索引再由 _buildSync 刷一次。
      if (u.selectionSet && !u.docChanged) {
        this._syncCursorToScore();
        this.visual.refresh();
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
          this._highlightCompartment.of(this.adapter.highlighter),
          updateListener,
          visualCursorExtension,
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
    // 识别模式：谱面区是核对视图，编辑文本不重排冲掉它。
    if (this.mode === "recognize") return true;
    if (this.mode === "mixed") {
      // `.musicxml` 没有代码区，谱面由 `editScoreDoc` 自己重排；文本格式改了源文就重新派生五线谱
      if (this.docFormat === "musicxml") return true;
      if (this.adapter.caps.layout === "jpwabc") this._refreshJpwDoc(text); // 导出 MIDI 读它
      if (!this._ensureMixedDoc()) return false;
      void this._renderMixedPages();
      return true;
    }
    return this.adapter.reload(this, text);
  }

  /** 混排档下 `.jpwabc` 不走 `reloadJpwabc`，`_jpwDoc` 在这里跟上源文。 */
  private _refreshJpwDoc(text: string): void {
    try {
      const f = JpwFile.fromString(text);
      this._jpwDoc = f ? jpwToScoreDoc(f) : null;
    } catch {
      this._jpwDoc = null;
    }
  }

  /** 简谱视图此刻会排出的各行首音（和弦 id），五线谱自动铺排拿它当优选断点（`xmlproject.ts::applyLineStarts`）。
   *  另造一个排版器按当前档与纸排一遍，不动屏幕上那个（混排档里屏幕上那个可能还是旧文本排的）。
   *  走原样文档布局的（文本谱原样档、多声部）返回 null：那一路一行就是 `ScoreDoc` 里的一行，不用另给。 */
  jianpuLineStarts(): ReadonlySet<number> | null {
    let score: JScore | null = null;
    let breakDesc: string | null = null;
    try {
      if (this.adapter.caps.layout === "jpwabc") {
        const f = JpwFile.fromString(this.getText());
        const doc = this.jpwDoc;
        if (!f || !doc) return null;
        score = jianpuInputOfJpw(doc);
        breakDesc = f.getSection(LayoutSection)?.desc ?? null;
      } else if (this.layoutMode === "expanded" || this._originalOnJianpu()) {
        score = this.puScore();
      }
      if (!score) return null;
      // 另一个排版器实例按当前档与纸排一遍，不动屏幕上那个
      const p = new ScorePainter(this.painter.resources);
      this._layoutScore(score, breakDesc, p);
      return new Set(p.result?.jianpuLineStarts ?? []);
    } catch (e) {
      console.warn("量简谱断行失败，按源文换行", e);
      return null;
    }
  }

  /** `.jpwabc` 当前源文的模型（与简谱排版器、导出同一份，元素 id 对得上）。 */
  get jpwDoc(): ScoreDoc | null {
    return this._jpwDoc;
  }

  /** 五线谱/混排档的纸（键取自 `PAPER_SIZES`），出厂 A4。 */
  get staffPaper(): string {
    return this.staffStyle().page.paper ?? STAFF_PAPER_DEFAULT;
  }

  /** 五线谱/混排档的纸：设置里五线谱那张（谱里写了纸就是谱里那张，见曲内层）；长图按 A4 宽、`heightPt = null`。
   *  `override`：用户明确选过纸——谱里的 `<page-layout>` 连同版面坐标都不用了，按这张纸重新铺排。 */
  get staffPage(): { widthPt: number; heightPt: number | null; marginsPt?: number[]; override: boolean } {
    const pg = this.staffStyle().page;
    const paper = resolvePaper(pg);
    const marginsPt = pageMargins(pg);
    const override = this._userSetsPaper("staff");
    return paper
      ? { widthPt: paper.w, heightPt: paper.h, marginsPt, override }
      : { widthPt: STAFF_LONG_IMAGE_WIDTH, heightPt: null, marginsPt, override };
  }

  /** 派生五线谱要看的设置：简谱的档、纸、字号变了，断点跟着变，得重新派生。 */
  private _mixedDeriveKey(): string {
    const pg = this.layoutPage;
    return [this.getText(), this.layoutMode, this.jpPaper, this.puPaper, this.fontSize, pg.w, pg.h].join("\u0000");
  }

  /** 五线谱/混排档的模型备好了没有。`.musicxml` 就是打开时读的那份；文本格式把**当前源文**经
   *  唯一写出端投成 MusicXML（`export.ts::sourceMusicXmlBare`，与导出 MusicXML 同一条路、只是不补版面坐标）
   *  再读回——混排排版器只吃 MusicXML 形状。源文没变不重做。 */
  private _ensureMixedDoc(): boolean {
    if (this.docFormat === "musicxml") return this.mixedDoc !== null;
    const key = this._mixedDeriveKey();
    if (this.mixedDoc && this._mixedDerivedText === key) return true;
    try {
      this.mixedDoc = formatOf("musicxml").toScoreDoc!(sourceMusicXmlBare(this));
      this._mixedDerivedText = key;
      return true;
    } catch (e) {
      console.error("转五线谱失败", e);
      this.setStatus("转五线谱失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  }

  /** FormatHost：`.jpwabc` 解析 → 排版 → 渲染。 */
  reloadJpwabc(text: string): boolean {
    let f: JpwFile | null;
    try {
      f = JpwFile.fromString(text);
    } catch {
      return false;
    }
    if (!f) return false;
    let doc: ScoreDoc;
    let score: JScore | null;
    try {
      doc = jpwToScoreDoc(f);
      score = jianpuInputOfJpw(doc);
    } catch (e) {
      console.error("import failed", e);
      this._jpwDoc = null;
      return false;
    }
    this._jpwDoc = doc;
    if (!score) return false;
    this._syncPhraseBase(text);

    const breakDesc = f.getSection(LayoutSection)?.desc ?? null;
    this._breakDesc = breakDesc; // 导出 PPTX 时另排一遍要用同一份分页描述
    try {
      this._layoutScore(score, breakDesc);
    } catch (e) {
      console.error("layout failed", e);
      return false;
    }
    this.renderPages();
    this._buildSync(doc);
    this.playback.refreshSpeedUi(); // 谱面 ♩= 随文本走，速度提示要跟着换（读 `_jpwDoc`）
    return true;
  }



  /** 文本谱（番茄 / 诗歌本）：解析 → 排版 → 渲染。展开档先投影成简谱引擎输入、与 `.jpwabc` 同一个排版器；
   *  原样档走原样文档布局（印刷原版的观感）。 */
  reloadPu(text: string): boolean {
    let sdoc: ScoreDoc;
    try {
      sdoc = parsePu(text);
    } catch (e) {
      console.error("文本谱解析失败", e);
      this.setStatus("文本谱解析失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
    const fatal = sdoc.diagnostics.find((d) => d.severity === "error");
    if (fatal) {
      this.setStatus(`文本谱无法解析：${fatal.message}`);
      return false;
    }
    this._scoreDoc = { text, doc: sdoc };
    this._puScoreCache = null; // 文本变了，引擎输入要重建
    this._syncPhraseBase(text);
    const dialect = (sdoc.puDialect ?? "tomato") as Dialect;
    this._puDialect = dialect;
    this._syncFormatLabel();
    if (!this._layoutScoreDoc(sdoc, "文本谱")) return false;
    // 解析告警不拦排版，但要让用户看得见（谱面往往仍然是对的）
    this._reportDiagnostics(dialectSpec(dialect).name, sdoc.diagnostics);
    return true;
  }

  /** FormatHost：`.123`（简谱主格式）解析 → 排版 → 渲染。
   *  原生解析直出 `ScoreDoc`，与文本谱共用同一套排版（原样档看声部数选布局 / 展开档投影成简谱引擎输入）。 */
  reload123(text: string): boolean {
    let doc: ScoreDoc;
    try {
      doc = parse123(text);
    } catch (e) {
      console.error("123 解析失败", e);
      this.setStatus("123 解析失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
    const fatal = doc.diagnostics.find((d) => d.severity === "error");
    if (fatal) {
      this.setStatus(`123 无法解析：第 ${fatal.source.line + 1} 行 ${fatal.message}`);
      return false;
    }
    this._scoreDoc = { text, doc };
    this._puScoreCache = null; // 文本变了，引擎输入要重建
    this._syncPhraseBase(text);
    this._syncFormatLabel();
    if (!this._layoutScoreDoc(doc, "123")) return false;
    this._reportDiagnostics("123", doc.diagnostics);
    return true;
  }

  /** FormatHost：`.abc` 解析 → 排版 → 渲染。
   *
   *  **原生解析直出 `ScoreDoc`**（`parseAbc`），不经 `abc2xml → MusicXML` 转一手——
   *  那条路把源字符偏移丢光了，双向定位最多到小节级、往返也只能「原文或全量重写」二选一。
   *  原生解析读不出音符时**自动回落 abc2xml**（只读，提示降级），沿用项目既有的兜底模式。 */
  reloadAbc(text: string): boolean {
    let doc: ScoreDoc;
    try {
      doc = parseAbc(text);
    } catch (e) {
      console.error("ABC 解析失败", e);
      return this._reloadAbcFallback(text, e instanceof Error ? e.message : String(e));
    }
    const notes = doc.songs.reduce((n, song) => n + [...eachChord(song)].length, 0);
    if (notes === 0) return this._reloadAbcFallback(text, "原生解析没读出音符");
    this._scoreDoc = { text, doc };
    this._puScoreCache = null;
    this._syncPhraseBase(text);
    this._syncFormatLabel();
    if (!this._layoutScoreDoc(doc, "ABC")) return false;
    this._reportDiagnostics("ABC", doc.diagnostics);
    return true;
  }

  /** 原生 ABC 读不动时回落 `abc2xml`：转成 MusicXML 走既有那条路，谱面照样看得到，
   *  但双向定位降到小节级、存回原文只能原样。**只在这条路上提示降级**。 */
  private _reloadAbcFallback(text: string, why: string): boolean {
    try {
      const xml = abcToMusicXml(text);
      this._setMixedXml(xml);
      if (!this.mixedDoc) return false;
      this._mixedDerivedText = this._mixedDeriveKey(); // 进五线谱就用这份，不再走原生那条（它读不动）
      const score = jianpuInputOfXml(this.mixedDoc.songs[0]!);
      this._layoutScore(score, null);
      this.renderPages();
      this.setStatus(`ABC 原生解析未成功（${why}），已回落 abc2xml——谱面可看，定位只到小节`);
      return true;
    } catch (e) {
      console.error("ABC 回落也失败", e);
      this.setStatus("ABC 解析失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  }

  /** 原样档这一份 `ScoreDoc` 走不走简谱引擎布局：格式说走（`caps.originalLayout`），
   *  且投影出来只有一条旋律——引擎只排 `parts[0]`，多声部的曲子仍回落原样文档布局。 */
  private _originalOnJianpu(): boolean {
    if (this.adapter.caps.originalLayout !== "jianpu" || this.layoutMode !== "original") return false;
    const score = this.puScore(false);
    return score !== null && score.parts.length === 1;
  }

  /** 经 `ScoreDoc` 排版并铺页（文本谱、123、ABC 共用）：
   *  展开档先投影成简谱引擎输入、与 `.jpwabc` 同一个排版器；原样档 123/ABC 的单声部曲子同样投影后
   *  交给引擎（与 `.jpwabc` 原样档同一套），文本谱与多声部走原样文档布局（印刷原版的观感）。都由同一个 `ScorePainter` 排。 */
  private _layoutScoreDoc(doc: ScoreDoc, what: string): boolean {
    try {
      if (this.layoutMode === "expanded" || this._originalOnJianpu()) {
        // 同一份文本只投影一次（puScore 有缓存）；点选与高亮按元素 id 认
        const score = this.puScore();
        if (!score) {
          this.setStatus(`这份${what}里没有可排的曲行`);
          return false;
        }
        this._layoutScore(score, null);
      } else {
        this.painter.loadSync({ view: "original", doc, style: this.styleOf("original", "pu") });
      }
    } catch (e) {
      console.error(`${what}排版失败`, e);
      this.setStatus(`${what}排版失败：` + (e instanceof Error ? e.message : String(e)));
      return false;
    }
    this.renderPages();
    this._buildSync(doc);
    return true;
  }

  // ---------------- 双向定位（代码区光标 ↔ 谱面元素）----------------

  /** 重建索引与「条目 ↔ 谱面 `<g>`」两张反查表。**每次重排后都要建**——页面节点全换了。 */
  private _buildSync(doc: ScoreDoc): void {
    this._sync.build(doc);
    this._syncDoc = doc;
    this._syncText = this.getText();
    this._syncEls.clear();
    this._syncElOf.clear();
    this._syncHeaderEls.clear();
    this._syncMarked = [];
    for (const entry of this._sync.all()) {
      const el = this._syncGroupEl(entry);
      if (!el) continue;
      this._syncElOf.set(entry, el);
      // 展开档里音符与它的歌词共用一个 `<g>`，先来的音符条目占住它（`all()` 已排好序）
      if (!this._syncEls.has(el)) this._syncEls.set(el, entry);
    }
    // 兜底第二趟：`.jpwabc` 的增时线写在音符 token 里、没有自己的条目，它那几个「-」格于是谁也不指——
    // 指到宿主音符上，点中了才有得选（点的是第几条由控制器按格认，见 `VisualHost.inlineSustainEls`）。
    // **必须等第一趟走完**：123 / 文本谱的增时线有自己的条目、那几个格归它们，先兜底就把它们抢了
    for (const entry of this._sync.all()) {
      if (entry.kind !== "note") continue;
      for (const cell of this.inlineSustainEls(entry.id)) if (!this._syncEls.has(cell)) this._syncEls.set(cell, entry);
    }
    this._bindHeader();
    this._syncCursorToScore();
    this.visual.afterRebuild();
  }

  // ---- VisualHost（可视化编辑向 App 要的能力，见 `visual/controller.ts`）----
  get sync(): SyncIndex {
    return this._sync;
  }

  visualEnabled(): boolean {
    return this.mode === "jp" && this.adapter.caps.textEditor && this._sync.size > 0;
  }

  entryEl(entry: SyncEntry): SVGGElement | null {
    return this._syncElOf.get(entry) ?? this._syncGroupEl(entry);
  }

  editDialect(): EditDialect | null {
    return this.adapter.editDialect ?? null;
  }

  syncDoc(): ScoreDoc | null {
    return this._syncDoc;
  }

  playbackBusy(): boolean {
    return this.playback.busy;
  }

  syncFresh(): boolean {
    return this._syncText === this.getText();
  }

  reloadNow(): void {
    clearTimeout(this.debounceTimer);
    this.reload(this.getText());
  }

  entryAtTarget(target: EventTarget | null): SyncEntry | null {
    return this._syncEntryAt(target);
  }

  noteEl(id: ElementId): SVGGElement | null {
    return this.painter.entryEl(id, 0);
  }

  augDotEls(id: ElementId): SVGGElement[] {
    return this.painter.partEls(id, "aug-dot");
  }

  barlineEl(entry: SyncEntry): SVGGElement | null {
    return this.painter.barlineEl(entry.id, entry.edge ?? "after");
  }

  sustainEl(entry: SyncEntry): SVGGElement | null {
    return this.painter.sustainEl(entry.id, entry.ord ?? 0, entry.own, entry.verse ?? 0);
  }

  slurEl(entry: SyncEntry): SVGGElement | null {
    return entry.end === undefined ? null : this.painter.slurEl(entry.id, entry.end);
  }

  inlineSustainEls(id: ElementId): SVGGElement[] {
    return this.painter.sustainCellEls(id);
  }

  /** 一个条目对应的谱面 `<g>`：按元素 id 问排版器（歌词按段取那一个字）。
   *  小节线与增时线有自己的图元（它们不按自己的 id 定位，见 `ScorePainter.barlineEl` / `sustainEl`）——
   *  取到了就归它们自己，点击才落得到它们头上；取不到退回宿主音符（旧行为）。 */
  private _syncGroupEl(entry: SyncEntry): SVGGElement | null {
    if (entry.kind === "mark") {
      // 弧有自己的图元（`(` 与 `)` 两条都指向同一条弧）；其余记号按类名在音符格里认
      if (entry.markKind === "slur") {
        const arc = this.slurEl(entry);
        if (arc) return arc;
      }
      const part = this._markPartEl(entry);
      if (part) return part;
    }
    if (entry.kind === "lyric") return this.painter.lyricEl(entry.id, entry.verse ?? 0, entry.verseNo);
    if (entry.kind === "barline") return this.barlineEl(entry) ?? this.painter.entryEl(entry.id, 0);
    if (entry.kind === "sustain") return this.sustainEl(entry) ?? this.painter.entryEl(entry.id, 0);
    return this.painter.entryEl(entry.id, entry.verse ?? 0);
  }

  /** 页眉：从原文认出字段（`EditDialect.headerFields`）并进索引，再按字对上谱面上画出来的页眉项。
   *  字对得上的（画出来的字就是原文的值、或包含它——署名会补「作词：」）归它；调号、拍号按角色归。 */
  private _bindHeader(): void {
    const fields = this.editDialect()?.headerFields?.(this._syncText) ?? [];
    if (fields.length === 0) return;
    this._sync.addHeader(fields);
    const entries = this._sync.ordered().filter((e) => e.kind === "header");
    const parts = this.painter.headerParts();
    const norm = (t: string): string => t.replace(/\s+/g, "");
    const bind = (e: SyncEntry, el: SVGGElement): void => {
      const list = this._syncHeaderEls.get(e) ?? [];
      if (list.length === 0) {
        this._syncHeaderEls.set(e, list);
        this._syncElOf.set(e, el);
      }
      list.push(el);
      if (!this._syncEls.has(el)) this._syncEls.set(el, e);
    };
    for (const p of parts) {
      if (p.role !== "text") {
        // 调号、拍号：字与原文写法不同，按角色对（`1=C4/4` 这种一处写两样的两者都归它）
        const e = entries.find((x) => x.headerRole === p.role || x.headerRole === "keytime");
        if (e) bind(e, p.el);
        continue;
      }
      const t = norm(p.text);
      let best: SyncEntry | null = null;
      let score = 0;
      for (const e of entries) {
        if (e.headerRole) continue;
        const v = norm(this._syncText.slice(e.from, e.to));
        if (!v || !t) continue;
        const sc = t === v ? 3 : t.includes(v) ? 2 : t.length >= 2 && v.includes(t) ? 1 : 0;
        if (sc > score) {
          best = e;
          score = sc;
        }
      }
      if (best) bind(best, p.el);
    }
  }

  textEls(entry: SyncEntry): SVGGElement[] {
    const hdr = this._syncHeaderEls.get(entry);
    if (hdr) return hdr;
    const el = this._syncElOf.get(entry);
    return el ? [el] : [];
  }

  /** 点亮一个条目。音符只亮音乐那部分：展开档的音符格里收着各段歌词，整格点亮会把每段的字都染上色，
   *  所以格里的歌词另标 `cursor-off`（CSS 不给它上光标色）；那段歌词自己也被选中时再摘掉。 */
  private _syncMark(entry: SyncEntry, el: Element): void {
    el.classList.add("cursor-at");
    el.classList.remove("cursor-off");
    this._syncMarked.push(el);
    if (entry.kind !== "note") return;
    for (const l of this.painter.cellLyricEls(entry.id)) {
      if (l.classList.contains("cursor-at")) continue;
      l.classList.add("cursor-off");
      this._syncMarked.push(l);
    }
  }

  /** 挂在音符上的记号自己的 `<g>`（和弦名、装饰、注记）：按类名在音符格里找，
   *  同类记号按原文顺序对第几个。弧、画不出来的记号（引擎只画延长号与重音）取不到，借宿主音符的 `<g>`。 */
  private _markPartEl(entry: SyncEntry): SVGGElement | null {
    const role = entry.markKind === "harmony" || entry.markKind === "deco" || entry.markKind === "annotation" ? entry.markKind : null;
    if (!role) return null;
    const els = this.painter.partEls(entry.id, role);
    const same = this._sync.marksOf(entry.id).filter((m) => m.markKind === entry.markKind);
    const nth = same.findIndex((m) => m.from === entry.from);
    return els.length === same.length && nth >= 0 ? els[nth] ?? null : null;
  }

  /** 文本 → 谱面：光标/选区落在哪些音符上，就给哪些 `<g>` 加 `cursor-at`。
   *  **走 CSS 类、不重渲染**（沿用编辑器既有判据）。 */
  private _syncCursorToScore(): void {
    if (this._syncing) return;
    for (const el of this._syncMarked) el.classList.remove("cursor-at", "cursor-off");
    this._syncMarked = [];
    if (this.mode !== "jp") return;
    const sel = this.view.state.selection.main;
    // 选中的是附点：只点亮附点
    const dotOf = this.visual.pickedDot();
    if (dotOf) {
      for (const el of this.augDotEls(dotOf.id)) {
        el.classList.add("cursor-at");
        this._syncMarked.push(el);
      }
      if (this._syncMarked.length) return;
    }
    const entries = this._sync.range(sel.from, sel.to);
    if (entries.length === 0) return;
    // 选中音符只亮音符，选中歌词只亮那一段的那个字（不连带别的段）
    for (const entry of entries) {
      for (const el of this._syncHeaderEls.get(entry) ?? [this._syncElOf.get(entry)]) if (el) this._syncMark(entry, el);
    }
    this._scrollSyncIntoView(this._syncMarked[0], entries[0]!);
  }

  /** 谱面 → 文本：把光标放到这个条目对应的原文区间上。 */
  private _syncScoreToCursor(entry: SyncEntry): void {
    const span = entry.kind === "note"
      ? this._sync.spanOfNote(entry.id)
      : { from: entry.from, to: entry.to };
    if (!span) return;
    this._syncing = true;
    try {
      this.view.dispatch({
        selection: { anchor: span.from, head: span.to },
        scrollIntoView: true,
      });
    } finally {
      this._syncing = false;
    }
    // 谱面这一侧的高亮照旧自己刷一次（上面被 _syncing 挡掉了）
    this._syncMarkOnly(entry);
  }

  /** 只点亮这一个条目（谱面点选时用；文本那侧已经跳好了，不必再反推）。 */
  private _syncMarkOnly(entry: SyncEntry): void {
    for (const el of this._syncMarked) el.classList.remove("cursor-at", "cursor-off");
    this._syncMarked = [];
    for (const el of this._syncHeaderEls.get(entry) ?? [this._syncElOf.get(entry)]) if (el) this._syncMark(entry, el);
  }

  /** 需要的话翻页并滚动到可视区（复用播放高亮那一套做法）。 */
  private _scrollSyncIntoView(el: Element | undefined, entry: SyncEntry): void {
    if (!el) return;
    const page = this.painter.pageOf(entry.id);
    if (page !== null && page !== this.pageIndex) this.pageIndex = page;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ---- 下面三个供脚本化测试（`window.__app`，见 scripts/sync-check.mjs）----
  /** 索引里的全部条目，只给可序列化的那几个字段。 */
  syncEntries(): Array<{ from: number; to: number; verse: number | null }> {
    // 只给音符与歌词（`sync-check` 按它们验两个方向；增时线、记号借宿主的 `<g>`，不单独验）
    return this._sync.all()
      .filter((e) => e.kind === "note" || e.kind === "lyric")
      .map((e) => ({ from: e.from, to: e.to, verse: e.verse }));
  }

  /** 某条目对应的谱面 `<g>`（按 `from` + `verse` 认，跨 evaluate 边界不能靠对象身份）。 */
  syncElAt(from: number, verse: number | null): SVGGElement | null {
    for (const [entry, el] of this._syncElOf) {
      if (entry.from === from && entry.verse === verse) return el;
    }
    return null;
  }

  /** 谱面 `<g>` → 条目（反查表命中与否）。 */
  syncEntryOfEl(el: Element): { from: number; to: number; verse: number | null } | null {
    const e = this._syncEls.get(el);
    return e ? { from: e.from, to: e.to, verse: e.verse } : null;
  }

  /** 谱面上点到的 `<g>` → 索引条目（从事件目标往上找最近的那个）。 */
  private _syncEntryAt(target: EventTarget | null): SyncEntry | null {
    let el = target instanceof Element ? target : null;
    while (el) {
      const hit = this._syncEls.get(el);
      if (hit) return hit;
      el = el.parentElement ?? (el.parentNode as Element | null);
      if (el && el.nodeType !== 1) return null;
    }
    return null;
  }

  /** 解析诊断 → 状态栏。不拦排版：谱面往往仍然是对的，但要让用户看得见。 */
  private _reportDiagnostics(
    what: string,
    diags: readonly { message: string; source: { line: number } }[],
  ): void {
    this.setStatus(
      diags.length === 0
        ? ""
        : `${what}：${diags.length} 处需要留意` +
            `（第 ${diags[0]!.source.line + 1} 行 ${diags[0]!.message}）`,
    );
  }

  /** 文本谱版面切换（原版 / PPT）。 */
  setPuProfile(profile: "print" | "slide"): void {
    if (this.puProfile === profile) return;
    this.puProfile = profile;
    this._applyPageBg(); // 同 setJpProfile：配色两档各记各的，纸底那层不经排版器
    this._syncViewModeButtons();
    this.saveSettings();
    if (this.adapter.profileKnob === "pu") this.reload(this.getText());
  }

  /** 当前档下切「展开」/「原样」该做什么——按文档格式分派：文本谱换整套 metrics
   *  （print/slide），简谱只换笔画常量（normal/pptx）。 */
  setProfile(slide: boolean): void {
    if (this.adapter.profileKnob === "pu") this.setPuProfile(slide ? "slide" : "print");
    else this.setJpProfile(slide ? "pptx" : "normal");
  }

  /** 当前是哪一种排版输出（文本谱看 puProfile，简谱看 jpProfile——那两个只是引擎内部的尺寸档名）。 */
  get layoutMode(): JianpuLayoutMode {
    const slide =
      this.adapter.profileKnob === "pu" ? this.puProfile === "slide" : this.jpProfile === "pptx";
    return slide ? "expanded" : "original";
  }

  /** 当前文档的 `ScoreDoc`（文本谱/123/ABC；排版器、引擎输入、同步索引共用同一份对象）。 */
  currentScoreDoc(): ScoreDoc | null {
    const toScoreDoc = this.adapter.toScoreDoc;
    if (!toScoreDoc) return null;
    const text = this.getText();
    if (this._scoreDoc?.text === text) return this._scoreDoc.doc;
    try {
      const doc = toScoreDoc(text);
      this._scoreDoc = { text, doc };
      return doc;
    } catch {
      return null;
    }
  }


  /** 当前文档投影出的引擎输入（展开档谱面与导出 PPTX 共用）。
   *  `forExpanded`：展开档那一份（带歌词的声部换到最前、同号歌词顺延，见 `JianpuInputOptions.forExpanded`）。 */
  puScore(forExpanded = this.layoutMode === "expanded"): JScore | null {
    if (this.adapter.caps.layout !== "scoredoc") return null;
    const text = this.getText();
    const doc = this.currentScoreDoc();
    if (!doc) return null;
    const c = this._puScoreCache;
    if (c && c.text === text && c.doc === doc && c.forExpanded === forExpanded) return c.score;
    let score: JScore | null;
    try {
      score = jianpuInputOfDoc(doc, { forExpanded });
    } catch (e) {
      console.error("投影引擎输入失败", e);
      return null;
    }
    this._puScoreCache = { text, doc, score, forExpanded };
    return score;
  }

  /** 当前文本谱的排版器（播放高亮 / 导出用）。 */
  /** 见 `_breakDesc`。 */
  get breakDesc(): string | null {
    return this._breakDesc;
  }

  /** 当前源格式的适配器（高亮 / 编解码 / 标签 / 档位旋钮 / 能力位全走它）。 */
  get adapter(): FormatAdapter {
    return formatOf(this.docFormat);
  }

  // ---------------- FormatHost ----------------
  /** FormatHost：文本谱方言短名，供代码区标签用。 */
  get puDialectName(): string | null {
    return this._puDialect === null ? null : dialectSpec(this._puDialect).shortName;
  }

  /** 当前文本谱的方言（非文本谱为 null）。 */
  get puDialect(): Dialect | null {
    return this.docFormat === "pu" ? this._puDialect : null;
  }

  /** FormatHost：谱面排版器认得的标题。 */
  get painterTitle(): string {
    return this.painter.score.title;
  }

  /** 切换编辑的源格式：换高亮、清掉另一路的状态。 */
  private _setDocFormat(format: DocFormatId): void {
    if (this.docFormat === format) return;
    this.docFormat = format;
    this.view.dispatch({
      effects: this._highlightCompartment.reconfigure(this.adapter.highlighter),
    });
    this._dropMixedDoc(); // 换了格式，五线谱/混排的模型由新格式重新派生（`.musicxml` 由调用方随后读入）
    if (this.adapter.caps.layout === "scoredoc" && this.adapter.caps.textEditor) {
      // 乐句重排各格式各有写回原文的办法（`formats.ts::relayoutText`），可用性由各自的 reload 定。
      this._disablePhrase();
    } else {
      this._puDialect = null;
      this._scoreDoc = null;
      this._puScoreCache = null;
      }
    // 没有代码区的格式（`.musicxml`）把代码区收起来
    document.getElementById("body")?.classList.toggle("no-code", !this.adapter.caps.textEditor);
    if (this.mode === "mixed") this._syncMixedReadOnly(); // 混排档里换格式：只读随格式走
    // 两种格式各记一个档位（jpProfile / puProfile），换格式可能就换了档：下次重排按新档取样式
    this._syncViewModeButtons();
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
      // 连续长纸的宽高比逐页不同（CSS 里写死的 960/540 只对 PPT 那张纸成立）
      aspectRatio: (i) => {
        const { w, h } = this.painter.pageSize(i);
        return `${w} / ${h}`;
      },
      // 原样文档没有几何拾取，双向定位靠事件冒泡找 `<g>`
      onPage: this.painter.isDocumentLayout
        ? (svg) => {
          svg.addEventListener("click", (ev) => this._onSyncClick(ev));
          svg.addEventListener("dblclick", (ev) => this._onSyncDblClick(ev));
        }
        : (svg, _wrap, i) => {
          svg.addEventListener("click", (e) => this.onPageClick(i, svg, e));
          svg.addEventListener("dblclick", (e) => this._onSyncDblClick(e));
        },
    });
  }

  // ---------------- picking / selection ----------------
  private onPageClick(pageIndex: number, svg: SVGSVGElement, ev: MouseEvent): void {
    // 双向定位先走一遍：它按 `<g>` 认（事件冒泡即可），**不依赖几何拾取**——
    // 两个档因此共用同一条路径，也不受 pickPage 拾取不到时的早退影响。
    // 可视化编辑接走了（点换行符、点空白落插入光标、Shift+点扩选）就到此为止。
    if (this._onSyncClick(ev)) {
      this.deselect(); // 旧的点选高亮也清掉，谱面上只留一处选中
      return;
    }
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    const geom = this.painter.result?.pages[pageIndex]?.geometry;
    const picked = geom ? this.painter.pickPage(pageIndex, toPt(geom, pt.x, pt.y))?.item ?? null : null;
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
      const ne = d as { chord: import("../layout/input").JChord; verse: number };
      this._selectedId = ne.chord.id;
      this._selectedVerse = ne.verse;
    }
    this.setStatus(describePick(picked));
  }

  /** 谱面被点击 → 代码区光标跳到对应原文。找不到对应条目就什么都不做
   *  （点在标题、小节线上都算找不到）。 */
  private _onSyncClick(ev: MouseEvent): boolean {
    if (this.mode !== "jp") return false;
    const entry = this._syncEntryAt(hitThroughOverlay(ev));
    if (this.visual.handleClick(ev, entry)) return true;
    if (entry) this._syncScoreToCursor(entry);
    return false;
  }

  /** 谱面被双击 → 文字对象进插入模式（单击只选中，见 `VisualEditController.handleDoubleClick`）。
   *  浏览器先发两次 `click` 再发这一下，所以选中在前、进编辑在后。 */
  private _onSyncDblClick(ev: MouseEvent): void {
    if (this.mode !== "jp") return;
    this.visual.handleDoubleClick(ev, this._syncEntryAt(hitThroughOverlay(ev)));
  }

  private deselect(): void {
    this.selectedEl?.classList.remove("selected");
    this.selectedEl = null;
    this._selectedId = null;
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

  /** PlaybackHost：当前该播的谱，由 ScoreDoc 拼。
   *  MusicXML 形状（`.musicxml`、ABC 回落）带全部声部、voice 与力度；简谱形状（文本谱/123/ABC/`.jpwabc`）
   *  口径同 `jianpuInputOfDoc`，展开档那一份带歌词的声部当主旋律。 */
  playable(): PlaySource | null {
    const jpw = this.adapter.caps.layout === "jpwabc";
    const doc = jpw ? this._jpwDoc : this.currentScoreDoc();
    if (!doc) return null;
    const forExpanded = !jpw && this.layoutMode === "expanded";
    const c = this._playCache;
    if (c && c.doc === doc && c.forExpanded === forExpanded) return c.src;
    let src: PlaySource | null = null;
    try {
      src = playSourceOf(doc, 0, forExpanded ? { forExpanded } : {});
    } catch (e) {
      console.error("试听输入拼不出", e);
    }
    this._playCache = { doc, forExpanded, src };
    return src;
  }

  /** PlaybackHost：用户在谱面上选中了某个音就从那儿起播。 */
  startPoint(): PlayPoint | undefined {
    const id = this._selectedId;
    return id === null ? undefined : { id, pass: this._selectedVerse };
  }

  /** PlaybackHost：播到某个元素 → 谱面高亮 + 保证可见。
   *  高亮留在 App 而不进控制器：各排版器按 id 找音的办法不同，那属于「谁在画谱面」。 */
  highlightPlaying(id: ElementId | null, pass: number): void {
    const page = this.painter.highlight(id, pass);
    if (id !== null && page !== null) {
      if (page !== this.pageIndex) this.pageIndex = page;
      // keep the sounding note visible (no-op when already in view)
      this.painter.entryEl(id, pass)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /** Number of parts in the current score (for the mixer UI). */
  get partCount(): number {
    return this.playable()?.parts.length ?? 1;
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
  /** 按扩展名落地：.abc / .123 / 文本谱 / .musicxml（无代码区）各进原生格式；其余按 UTF-16 .jpwabc 读。 */
  importBytes(bytes: Uint8Array, name: string): void {
    // 任何新导入都使上一次的识别叠加产物失效（识别结果由 OmrController 在本调用之后重设）。
    this.omr.clear();
    this.visual.documentLoaded();
    this.formats.use(null);
    this._importBytes(bytes, name);
    // 原文是真身：代码区标题栏的格式下拉可以换成别的格式看、切回来逐字还原（`FileFormatSource`）
    const origin = this._originFormat();
    if (origin) {
      this.formats.use(new FileFormatSource(this, { format: origin, docFormat: this.docFormat, text: this.getText() }));
    }
  }

  /** 用户**亲手打开**单声部 MusicXML 之后调（打开对话框、拖入；重开上次文件与回归脚本不走这里）：
   *  问要保持 MusicXML 看五线谱，还是转成哪种简谱源格式来编辑。多声部不问（简谱装不下，照旧进混排）。
   *  转过去是一份新文档（`convertToTextDoc`：先列装不下的，文件路径清空，原 `.musicxml` 不动）。 */
  async promptMusicXmlImport(): Promise<void> {
    if (this.docFormat !== "musicxml" || this.mode === "mixed") return;
    let choice = this.musicXmlImport;
    if (choice === "ask") {
      const res = await showChoiceDialog(
        "导入 MusicXML",
        "这是单声部歌谱，可以转成简谱来编辑（原 MusicXML 文件不动）。",
        [
          ...CONVERT_TARGETS.map((t) => ({ value: t.id as "musicxml" | ConvertTarget, label: `转成 ${t.label} 编辑` })),
          { value: "musicxml" as const, label: "保持 MusicXML（看五线谱）" },
        ],
        { defaultValue: "123", remember: "记住选择，以后不再询问（可在设置里改回）" },
      );
      // 取消 = 保持 MusicXML：文件已经打开了，不必中断
      choice = res?.value ?? "musicxml";
      if (res?.remember) {
        this.musicXmlImport = res.value;
        this.saveSettings();
      }
    }
    if (choice !== "musicxml") {
      await this.convertToTextDoc(choice);
      if (this.docFormat !== "musicxml") return;
      // 丢失提示里取消了：留在 MusicXML
    }
    await this.setViewMode("staff");
  }

  /** 刚打开的原文是哪种格式（下拉里「原文」那一项）。文本谱按嗅探出的方言算。 */
  private _originFormat(): OriginFormat | null {
    switch (this.docFormat) {
      case "musicxml": return "musicxml";
      case "pu": return this._puDialect ?? sniffDialect(this.getText()).dialect;
      default: return this.docFormat;
    }
  }

  private _importBytes(bytes: Uint8Array, name: string): void {
    // ABC 记谱：**原文就是源格式**，原生解析直接进编辑器（`reloadAbc`），不再转 MusicXML。
    // 原生解析读不动时由 `reloadAbc` 自己回落 abc2xml，这里不预先转。
    if (/\.abc$/i.test(name)) {
      this._dropMixedDoc(); // 原来在五线谱/混排就留在那档：setText → reload 会重新派生
      this._setDocFormat("abc");
      this.setText(formatOf("abc").decode(bytes));
      return;
    }
    // 123（简谱主格式）：原文就是源格式，直接进编辑器，不做任何转换。
    if (is123File(name)) {
      this._dropMixedDoc();
      this._setDocFormat("123");
      this.setText(formatOf("123").decode(bytes));
      return;
    }
    // 文本谱（番茄 / 诗歌本）：原文就是源格式，直接进编辑器，不做任何转换。
    if (isPuFile(name)) {
      const puText = formatOf("pu").decode(bytes);
      const sniffed = sniffDialect(puText);
      if (sniffed.dialect === null) {
        // `.txt` 太泛，认不出宁可不动——硬解只会得到一首乱谱
        this.setStatus(`这不像文本谱：${sniffed.reason}`);
        return;
      }
      this._dropMixedDoc();
      this._setDocFormat("pu");
      this.setText(puText);
      return;
    }
    if (/\.(xml|musicxml)$/i.test(name)) {
      // MusicXML：**没有代码区**，只进谱面视图（五线谱/混排，或由 `ScoreDoc` 排出的简谱）。
      // 编辑器文档里存的就是 XML 原文（不显示）：存回原文件时没改过就是原文，零损耗。
      // 要编辑就「转成文本格式」，那是另一份新文档（`convertToTextDoc`）。
      const xml = formatOf("musicxml").decode(bytes);
      this._setDocFormat("musicxml");
      if (!this._setMixedXml(xml)) return;
      this._setMixedAvailable(true);
      // 多声部（SATB 等）歌谱默认进入混排模式
      const toMixed = this.mode === "mixed" || isMultiPartXml(xml);
      if (toMixed) this._setMode("mixed");
      else this._setMode("jp");
      this.setText(xml);
      if (toMixed) void this._renderMixedPages();
      return;
    } else {
      this._setDocFormat("jpwabc");
      this._dropMixedDoc();
      this._disablePhrase();
      this.setText(formatOf("jpwabc").decode(bytes));
    }
  }

  /**
   * 简谱识别产物落地（`OmrHost.importOmrDoc`）：识别直出的模型（`omr/todoc.ts`）写成 123 核对文本，
   * 之后就是一份普通的 123 文档（导出 MusicXML 也由这份文本整份写出）。
   */
  importOmrDoc(doc: ScoreDoc, text: string): void {
    this.omr.clear();
    this.visual.documentLoaded();
    const losses = planSave(doc, "123");
    this._dropMixedDoc();
    this._setMode("jp"); // 识别之后先核对（omrctl 接着进叠加视图）；五线谱/混排从工具条切
    this._setDocFormat("123");
    this.filePath = null;
    this.setText(text);
    if (losses.length) {
      this.setStatus(`识别结果已转成 123 核对文本；有 ${losses.length} 样 123 表达不了，已略去`);
    }
  }

  /**
   * 五线谱识别产物落地：与打开 `.musicxml` 同一个模式（无代码区、谱面由 XML 出），默认进混排。
   * 五线谱识别的产物带和弦、多声部、slur，`.jpwabc` 装不下，所以不再转简谱文本。
   */
  adoptStaffXml(xml: string): boolean {
    this._setDocFormat("musicxml");
    if (!this._setMixedXml(xml)) return false;
    this._setMixedAvailable(true);
    this._setMode("mixed");
    this.filePath = null;
    this.setText(xml);
    void this._renderMixedPages();
    return true;
  }

  /** 五线谱/混排档的模型：MusicXML 读成 `ScoreDoc`（与简谱档那份分开读——那份会被投影、断句层补字段，混排只读原样的）。
   *  读不出来时置空并提示，返回 false。 */
  private _setMixedXml(xml: string): boolean {
    this._mixedDerivedText = null;
    try {
      this.mixedDoc = formatOf("musicxml").toScoreDoc!(xml);
      return true;
    } catch (e) {
      this.mixedDoc = null;
      console.error("MusicXML 读取失败", e);
      this.setStatus("MusicXML 读取失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  }

  /** FormatHost：`.musicxml` 读成 `ScoreDoc` → 简谱档排版；五线谱/混排档另读一份（`mixedDoc`）。 */
  reloadMusicXml(text: string): boolean {
    this._setMixedXml(text);
    let doc: ScoreDoc;
    try {
      doc = formatOf("musicxml").toScoreDoc!(text);
    } catch (e) {
      console.error("MusicXML 读取失败", e);
      this.setStatus("MusicXML 读取失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
    const notes = doc.songs.reduce((n, song) => n + [...eachChord(song)].length, 0);
    if (notes === 0) {
      this.setStatus("这份 MusicXML 里没有音符");
      return false;
    }
    this._scoreDoc = { text, doc };
    this._puScoreCache = null;
    this._syncPhraseBase(text);
    this._syncFormatLabel();
    if (!this._layoutScoreDoc(doc, "MusicXML")) return false;
    this._reportDiagnostics("MusicXML", doc.diagnostics);
    return true;
  }

  /**
   * 改动 `.musicxml` 的模型（五线谱编辑的入口）：改完**整份重写**成 XML 放回文档，谱面跟着重排。
   * 存回原文件写的就是这份——`fromxml.ts` 把读不懂的原样挂在 `raw` 上，全量重写不丢东西
   * （`xml-direct-check.mjs`：568 份十类关键元素一个没掉），所以不再走底本 patch。
   */
  editScoreDoc(mutate: (doc: ScoreDoc) => void): boolean {
    if (this.docFormat !== "musicxml") return false;
    const doc = this.currentScoreDoc();
    if (!doc) return false;
    mutate(doc);
    this.setText(scoreDocToMusicXml(doc));
    if (this.mode === "mixed") void this._renderMixedPages();
    return true;
  }

  /**
   * 把当前 `.musicxml` **转成文本格式**再编辑：与代码区标题栏的格式下拉同一条路（`FileFormatSource`）——
   * 先列出目标格式装不下的东西，确认后换成该格式、清掉文件路径（原 `.musicxml` 不动），代码区出现；
   * 下拉里「MusicXML（原文）」切得回来。
   */
  async convertToTextDoc(target: ConvertTarget): Promise<void> {
    if (this.docFormat !== "musicxml") return;
    const src = this.formats.source;
    if (!src) {
      this.setStatus("这份 MusicXML 读不出来，无法转换");
      return;
    }
    // 谱里写的纸：123/ABC 带得过去（`I:meta page …`）；`.jpwabc`、文本谱没有字段，改记进设置里的纸
    const song = this.currentScoreDoc()?.songs[0];
    const page = song ? songPageDecl(song) : null;
    const ok = await src.switchTo(target);
    this.formats.sync();
    if (!ok || !page || !isPaper(page.paper)) return;
    const now = targetSpec(target).docFormat;
    const engine: PaperEngine | null = now === "jpwabc" ? "jianpu" : now === "pu" ? "pu" : null;
    if (!engine) return;
    const choice: PaperChoice = { paper: page.paper!, orientation: page.orientation ?? "portrait", margin: pageMargins(page) ?? null };
    this._setPaper(engine, choice);
    this._setPaper("staff", choice);
    this.saveSettings();
    this.reload(this.getText());
  }

  /** 每次重排/重渲染后同步乐句重排的基准文本与按钮可用性。
   *
   *  **用户手改过的文本就是新的「原样」基准**（切回按钮要还原到它）。重排后又手改的，
   *  也按「这就是新的原样」算——否则一按「原样」就把用户后来的编辑抹了。 */
  private _syncPhraseBase(text: string): void {
    if (!this.adapter.caps.phraseRelayout) {
      this._disablePhrase();
      return;
    }
    if (this._phraseOn && text !== this._phraseText) {
      this._phraseOn = false;
      this._setPhraseActive(false);
    }
    if (!this._phraseOn) this._origLayoutText = text;
    this._setPhraseAvailable(true);
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

  /** 原样排版与按乐句重排之间切换。 */
  setPhraseLayout(phrase: boolean): void {
    if (this.adapter.caps.phraseRelayout) this._setPhraseLayout(phrase);
  }

  /**
   * 「按乐句重排」：**重排的是原文本身**，两档因此同时就位——文本谱一行 `Q:`（123 一个 `$`）
   * 就是谱面一行，展开档的行边界由 `model/jianpuinput.ts` 转成换行条目。怎么写回原文由各格式
   * 的适配器给（`editor/formats.ts::relayoutText`）。
   * 切回「原样」= 把重排前那份原文放回去（逐字相同，Ctrl+Z 也能整体撤销）。
   */
  private _setPhraseLayout(phrase: boolean): void {
    if (this._phraseOn === phrase) return;
    const base = this._origLayoutText;
    if (!phrase) {
      if (base === null) return;
      this._phraseOn = false;
      this._setPhraseActive(false);
      this.setText(base);
      return;
    }
    const relayout = this.adapter.relayoutText;
    if (!relayout) return;
    const text = this.getText();
    try {
      const out = relayout(text, this._puPhraseMeasure());
      if (out === text) {
        this.setStatus("行结构没变：乐句断点与现在的分行一致");
        return;
      }
      this._origLayoutText = text;
      this._phraseText = out;
      this._phraseOn = true;
      this._setPhraseActive(true);
      this.setText(out);
    } catch (e) {
      console.error("乐句重排失败", e);
      this.setStatus("按乐句重排失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * 文本谱的行长尺子。
   *
   * **只有展开档有**：那一档两种格式同走 `ScorePainter` 展开档，量宽（`measureJianpu`）与真正排版的
   * 是同一套坐标。原样档走的是原样文档布局——固定步进的另一套尺子、另一套字号，拿简谱那把尺子
   * 去量会以为「两句并一行还宽绰」，排出来却要硬折（73《我主耶稣是生命源》一行 8 小节）。
   * 没有尺子时 `phrase.ts` 按出厂的小节数目标断，也就是一句一行——印刷原版要的正是这个。
   */
  private _puPhraseMeasure(): FitMeasure | null {
    // 123/ABC 原样档走引擎时（`_originalOnJianpu`）量它自己那张纸、那个字号，与 `.jpwabc` 原样档同口径
    if (this._originalOnJianpu()) return (score) => this._fitOf(score, this.layoutPage.w, this.fontSize);
    if (this.layoutMode !== "expanded") return null;
    // 量的是断行模块自己投影的那份输入，所以给的是函数不是结果。
    return (score) => this._fitOf(score, this.pageW, jianpuSizes(this.styleOf("expanded")).fontSize);
  }

  /** 乐句重排的行长度量：按实际纸宽与字号量出每小节自然宽度（`phrase.ts::targetMeasForFit`）。
   *  另起一个 painter 来量，且要 `lyricStack > 0`：展开档会按反复与多段各排一遍，按小节取跨度就成了整首。 */
  private _fitOf(score: JScore, width: number, fontSize: number): ReturnType<FitMeasure> {
    clearBreaks(score);
    // lyricStack 只要 > 0：不展开反复，一遍就够量
    return measureJianpu(score, width, { style: null, fontSize, lyricStack: fontSize }, { smuflMeta: this.meta });
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
    if (!this.adapter.caps.hanConvert) {
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

  /** 注册「展开 / 原样 / 五线谱 / 混排」四档排版模式按钮。
   *
   *  这四档是**两组正交状态的组合**，不是四个独立视图：
   *  前两档走简谱/文本谱排版器（`mode = "jp"`），差别只在版面档（`setProfile`）；
   *  后两档走混排排版器（`mode = "mixed"`），差别只在要不要叠简谱层
   *  （`mixedShowJianpuLayer`——「五线谱」= 关，「混排」= 开）。 */
  setViewModeButtons(switchEl: HTMLElement, btns: ReadonlyMap<ViewMode, HTMLButtonElement>): void {
    this._viewSwitchEl = switchEl;
    this._viewBtns = new Map(btns);
    this._syncViewModeButtons();
  }

  /** 当前处于哪一档。识别模式沿用「简谱那一侧」的档（工具条上它不是独立一档）。 */
  get viewMode(): ViewMode {
    if (this.mode === "mixed") return this.mixedShowJianpuLayer ? "mixed" : "staff";
    return this.layoutMode;
  }

  /** 切档。**唯一入口**：两组状态该怎么配由这里说了算。 */
  async setViewMode(mode: ViewMode): Promise<void> {
    if (mode === "staff" || mode === "mixed") {
      if (!this._ensureMixedDoc()) return;
      // 先定简谱层再进混排：setStaffJianpuLayer 会作废 painter，进去后只排一遍
      await this.setStaffJianpuLayer(mode === "mixed");
      await this.showStaffPreview();
    } else {
      // 反过来：先换版面档（此时 mode 还是 mixed，reload 直接返回、不白排一遍），再回简谱
      this.setProfile(mode === "expanded");
      await this.showJpPreview();
    }
    this._syncViewModeButtons();
  }

  /** 丢掉五线谱/混排档的模型与排版器（换文档/换格式时）。 */
  private _dropMixedDoc(): void {
    this.mixedDoc = null;
    this._mixedDerivedText = null;
    this._setMixedAvailable(false);
  }

  private _setMixedAvailable(available: boolean): void {
    this._mixedAvailable = available;
    this._syncViewModeButtons();
  }

  private _syncViewModeButtons(): void {
    if (this._viewSwitchEl) this._viewSwitchEl.hidden = this._viewBtns.size === 0;
    const active = this.viewMode;
    for (const [mode, btn] of this._viewBtns) {
      const needsXml = mode === "staff" || mode === "mixed";
      // 文本格式由源文派生五线谱，一律可点；`.musicxml` 读不出来才置灰
      btn.disabled = needsXml && this.docFormat === "musicxml" && !this._mixedAvailable;
      const on = mode === active;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  }

  // ---------------- OmrHost：识别控制器要的那几样能力 ----------------
  /** 识别产物有无变了，重算排版档按钮的显隐。 */
  syncViewModes(): void {
    this._syncViewModeButtons();
  }

  /** 混排排版器（导出 PDF/PNG 要）。没进过混排预览就是 null。
   *  以前导出侧靠 `app["_mixedPainter"]` 索引签名绕过 private——字段一改名，编译期静默
   *  通过、运行期直接 return，「导出 PDF 点了没反应」且无报错。 */
  get mixedPainter(): ScorePainter | null {
    return this.mode === "mixed" && this.painter.renderer === "staff" ? this.painter : null;
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

  /**
   * 换成某种源格式的文本（`OmrHost` / `FileSwitchHost`）：识别产物落地、代码区格式下拉切格式都走这里。
   * 丢掉混排底本、切 docFormat、设文件路径，再设文本（在五线谱/混排档就留在那档）。
   * 切回 `.musicxml` 原文时照打开 `.musicxml` 那样落地（无代码区）；从 `.musicxml` 转出来的回简谱档看代码区对应的谱面。
   */
  adoptText(format: DocFormatId, text: string, filePath: string | null): void {
    this.visual.documentLoaded();
    if (format === "musicxml") {
      this._setDocFormat("musicxml");
      this.filePath = filePath;
      if (!this._setMixedXml(text)) return;
      this._setMixedAvailable(true);
      this.setText(text);
      if (this.mode === "mixed") void this._renderMixedPages();
      return;
    }
    const fromXml = this.docFormat === "musicxml";
    this._dropMixedDoc();
    if (fromXml) this._setMode("jp");
    if (format === "jpwabc") this._disablePhrase();
    this._setDocFormat(format);
    this.filePath = filePath;
    this.setText(text);
  }

  /** 预览模式切换的**唯一**入口：退出当前模式的副作用 + 进入新模式的副作用。
   *
   *  以前这三连（`mode = …` / `_setMixedLayout` / 按钮同步）在五处各写一遍，
   *  漏一处就出「按钮亮着但布局是另一个模式」。识别模式的那套布局由 OmrController 自己接管
   *  （omrctl.ts::setLayout），这里只管 mode 与混排布局。 */
  private _setMode(next: "jp" | "mixed" | "recognize"): void {
    if (this.mode === next) return;
    if (this.mode === "recognize") this.omr.leaveLayout();
    if (this.mode === "mixed") this._setMixedLayout(false);
    this.mode = next;
    if (next === "mixed") this._setMixedLayout(true);
    // 识别模式沿用「简谱」这个预览档（工具条上它不是独立一档）。
    this._syncViewModeButtons();
  }

  async showJpPreview(): Promise<void> {
    if (this.mode === "jp") return;
    this.stopPlayback();
    this._setMode("jp");
    this.reload(this.getText());
  }

  async showStaffPreview(): Promise<void> {
    if (!this._ensureMixedDoc()) return;
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
    this.saveSettings();
    if (this.mode === "mixed") await this._renderMixedPages();
  }

  /** 进出五线谱/混排的布局。文本格式在这两档仍可编辑源文（`reload` 会重新派生五线谱）；
   *  只读只对没有代码区的格式（`.musicxml`）成立。 */
  private _setMixedLayout(on: boolean): void {
    document.getElementById("body")?.classList.toggle("mixed", on);
    this._syncMixedReadOnly(on);
  }

  private _syncMixedReadOnly(mixed = this.mode === "mixed"): void {
    const ro = mixed && !this.adapter.caps.textEditor;
    this.view.dispatch({
      effects: this._readOnlyCompartment.reconfigure(EditorState.readOnly.of(ro)),
    });
    const meta = document.getElementById("code-pane-meta");
    if (meta) meta.textContent = ro ? "只读" : this._formatLabel();
  }

  /** 代码区右上角的格式标签。 */
  private _formatLabel(): string {
    return this.adapter.label(this);
  }

  /** `FormatSwitchHost`：格式下拉显隐变了，格式标签跟着让位。 */
  syncFormatLabel(): void {
    this._syncFormatLabel();
  }

  /** 同步代码区右上角：有可切的格式时那儿是格式下拉（`#doc-format-field`），标签让位。 */
  private _syncFormatLabel(): void {
    const meta = document.getElementById("code-pane-meta");
    if (!meta) return;
    if (meta.textContent !== "只读") meta.textContent = this._formatLabel();
    const field = document.getElementById("doc-format-field");
    meta.hidden = !!field && !field.hidden;
  }

  private _renderMixedPages(): Promise<void> {
    const job = this._layoutStaff();
    this._pendingStaff = job;
    void job.finally(() => {
      if (this._pendingStaff === job) this._pendingStaff = null;
    });
    return job;
  }

  private async _layoutStaff(): Promise<void> {
    const doc = this.mixedDoc;
    if (!doc) {
      this._renderPagesWith(0, () => { throw new Error("没有五线谱页"); }, { resetPageIndex: true });
      return;
    }
    const outcome = await this.painter.load({
      view: this.mixedShowJianpuLayer ? "mixed" : "staff",
      doc,
      page: this.staffPage,
      hideBarNumber: this.mixedHideBarNumber,
    });
    // 排的时候又来了新请求（快速切档、改设置）：这份作废，由新的那份铺页
    if (outcome === "superseded" || this.mode !== "mixed") return;
    const painter = this.painter;
    this._renderPagesWith(painter.pageCount, (i) => painter.renderPage(i), {
      // Portrait paper sized from the MusicXML page dimensions.
      // **纸宽不在这里给**：简谱/五线谱/混排共用 `--score-page-max`（styles.css）。
      // 这里原先单独写 620px，切到混排纸就窄了三分之一。
      aspectRatio: (i) => {
        const { w, h } = painter.pageSize(i);
        return `${w} / ${h}`;
      },
      onPage: (svg) => {
        svg.style.width = "100%";
        svg.style.display = "block";
      },
      resetPageIndex: true,
    });
  }

  /** 等在途的异步排版（五线谱 / 混排）落定。简谱这一路是同步的，调用返回时已铺好。无头校验脚本用。 */
  async whenIdle(): Promise<void> {
    while (this._pendingStaff) await this._pendingStaff.catch(() => undefined);
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
      this.filePath = path;
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
            name: "简谱 / 123 / 文本谱 / MusicXML / ABC",
            // 白名单只在 `common/filetypes.ts` 写一次；`.jpwabc` 另给大写形（部分系统区分）
            extensions: [...DOC_EXT, "JPWABC"],
          },
        ],
      });
      if (typeof sel !== "string") return false;
      const bytes = await readFile(sel);
      this.importBytes(bytes, sel);
      this.filePath = sel;
      this.rememberLastFile(sel);
      void this.promptMusicXmlImport();
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
        this.filePath = file.name;
        finish(true);
        void this.promptMusicXmlImport();
      };
      window.addEventListener("focus", () => setTimeout(() => {
        if (!changeStarted) finish(false);
      }, 500), { once: true });
      input.click();
    });
  }

  async saveFile(): Promise<void> {
    if (this.filePath && isTauriRuntime()) {
      // 存回原文件 = 原格式进原格式出，不会丢东西，不必问
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

  /** 跨格式另存为：**先算会丢什么，列给用户，确认了再写**（`model/capability.ts`）。
   *  同格式存回不走这条——那是原文进原文出。 */
  async saveAsFormat(target: ConvertTarget): Promise<void> {
    const doc = this.scoreDoc();
    if (doc) {
      const losses = planSave(doc, target);
      if (losses.length) {
        const ok = await showConfirmDialog("另存为会丢东西", describeLosses(target, losses));
        if (!ok) return;
      }
    }
    const text = this.convertTo(target);
    if (text === null) {
      this.setStatus(`暂不支持另存为 ${target}`);
      return;
    }
    const adapter = formatOf(targetSpec(target).docFormat);
    const dest = await saveBytes(adapter.encode(text), (this.documentTitle() || "未命名") + adapter.defaultExt);
    if (!dest) return;
    this.setStatus(`已另存为 ${targetSpec(target).label}（${adapter.defaultExt}）`);
  }

  /** 当前文档的 `ScoreDoc`（能力表与丢失清单要用）。拿不到就返回 null。 */
  scoreDoc(): ScoreDoc | null {
    const text = this.getText();
    try {
      if (this.adapter.caps.layout === "scoredoc") return this.currentScoreDoc();
      const f = JpwFile.fromString(text);
      return f ? jpwToScoreDoc(f) : null;
    } catch {
      return null;
    }
  }

  /** 当前文档 → 目标格式的文本（转换目标表 `model/convert.ts`）。同格式原文照给；转不了返回 null。 */
  private convertTo(target: ConvertTarget): string | null {
    const spec = targetSpec(target);
    if (spec.docFormat === this.docFormat && (spec.docFormat !== "pu" || this.puDialect === target)) return this.getText();
    const doc = this.scoreDoc();
    if (!doc) return null;
    try {
      return spec.emit(doc);
    } catch (e) {
      console.error("转换失败", e);
      return null;
    }
  }

  /** 存盘用的文件名：扩展名由适配器给。 */
  private defaultSaveName(): string {
    return (this.documentTitle() || "未命名") + this.adapter.defaultExt;
  }

  /** 当前文档的标题（取法因格式而异，见适配器的 `title`）。 */
  private documentTitle(): string {
    return this.adapter.title(this);
  }

  /** 存盘编码：文本谱等是 UTF-8 原文，`.jpwabc` 是 JP-Word 的 UTF-16LE+BOM。 */
  private encodeForSave(): Uint8Array {
    return this.adapter.encode(this.getText());
  }

  /** 盘上那份文件是不是 MusicXML（文本格式另存到 XML 路径时，编辑器里是简谱文本、盘上是 XML）。 */
  private get onDiskIsXml(): boolean {
    return this.filePath !== null && /\.(xml|musicxml)$/i.test(this.filePath);
  }

  private async writeTo(path: string): Promise<void> {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    // `.musicxml` 那一档：文档里就是 XML（未改动是原文，改过的已由 `editScoreDoc` 整份重写）。
    // 其余格式存到 XML 路径上：由唯一写出端整份重写。
    const bytes = this.docFormat === "musicxml"
      ? this.encodeForSave()
      : this.onDiskIsXml
        ? new TextEncoder().encode(await buildMusicXml(this))
        : this.encodeForSave();
    await writeFile(path, bytes);
  }

  /** Load dropped file content (already decoded). */
  loadText(text: string, path: string | null): void {
    this.visual.documentLoaded();
    this.formats.use(null);
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
