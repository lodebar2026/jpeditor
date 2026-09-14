// App controller: CodeMirror editor <-> live relayout/render <-> paging <-> file I/O.
// Mirrors EditorController in CodeEditor.kt (doBind/tryLoad/updateLayout/paint/load/doSave).

import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { PuPainter } from "../pu/painter";
import { parsePu, scoreDocToScore, relayoutPuText, sniffDialect, dialectSpec, type Dialect } from "../pu";
import { parse123, parseAbc } from "../j123/parse";
import { eachChord, emptyDoc } from "../model/helpers";
import type { ElementId, ScoreDoc } from "../model/doc";
import { Chord, type Score } from "../score/score";
import type { PuDoc } from "../pu";
import type { PuUserOptions } from "../pu/metrics";
import { ExpandedPainter, type ExpandedOptions } from "../jianpu/expanded";
import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { fromJpw } from "../score/jpwimport";
import { JinpuPainter } from "../layout/painter";
import { PPTX_PAGE, type JpProfileName } from "../layout/pptxstyle";
import { JpNumber, Lyric as LayoutLyric, TextFrame, type PageItem } from "../layout/pageitem";
import { Point, colorToCss } from "../common/geom";
import { MetaData } from "../smufl/smufl";
import { loadMusicXml } from "../score/musicxml";
import type { FitMetric } from "../score/phrase";
import type { FitMeasure } from "../pu/phrase";
import { abcToMusicXml } from "../abc/abc2xml";
import { scoreToJpwabc, type JpwMeta, type JpwRange } from "../score/jpscore";
import { convertJpwabc, detectDirection, type HanDirection } from "../jpword/hanconv";
import { isTauriRuntime, saveBytes } from "./fileio";
import { DOC_EXT, acceptAttr, is123File, isPuFile } from "../common/filetypes";
import { formatOf, type DocFormatId, type FormatAdapter, type FormatHost } from "./formats";
import { SyncIndex, type SyncEntry } from "./sync";
import { describeLosses, planSave, type TargetFormat } from "../model/capability";
import { showConfirmDialog } from "./dialogs";
import { buildMusicXml, finishMusicXmlText } from "./export";
import { scoreDocToMusicXml } from "../model/toxml";
import { emit123 } from "../j123/emit";
import { metaFrom123 } from "./omrmeta";
import { emitAbc } from "../abcfamily/emitabc.entry";
import { puToScoreDoc } from "../model/frompu";
import { jpwToScoreDoc } from "../model/fromjpw";
import { MixedPainter } from "../mixed/painter";
import { PlaybackController, type PlaybackHost } from "./playback";
import { OmrController, type OmrHost } from "./omrctl";
import type { JianpuLayoutMode } from "../jianpu/profile";
import {
  loadPersistedSettings, savePersistedSettings, loadLastFile, saveLastFile, clearLastFile,
} from "./settings";
export type { OmrFormat } from "../omr";

/** 两档字号的出厂值（= 老版展开档的那三个，见 layout/pptxstyle.ts::PPTX_PAGE）。 */
const JP_SIZE_DEFAULTS = {
  fontSize: PPTX_PAGE.fontSize,
  titleSize: PPTX_PAGE.titleSize,
  creditSize: PPTX_PAGE.creditSize,
};

/** 原样档标题/词曲字号 ÷ 基础字号。取出厂那三个数的比（48/28、36/28）——
 *  那一档不单独设标题与词曲，字号一改整块跟着缩放，观感与出厂值一致。 */
const JP_TITLE_RATIO = PPTX_PAGE.titleSize / PPTX_PAGE.fontSize;
const JP_CREDIT_RATIO = PPTX_PAGE.creditSize / PPTX_PAGE.fontSize;

/** 「展开」档只有这两种投影片比例（1 排版单位 = 1pt，导出 PPTX 要的就是这个）。
 *  **不给实际纸张**：展开是投影用的，一屏一段（用户口径：「不需要纸张设置，只要 2 种比例」）。
 *  两种格式共用（展开档是同一个排版器，见 `App.expandedOptions`）。 */
export const PAGE_RATIOS: Record<string, [number, number]> = {
  "16:9": [960, 540],
  "4:3": [720, 540],
};

/** 原样档与文本谱「原版」档能选的纸：**实际纸张尺寸**（pt，1pt = 1/72 in），
 *  外加一档「长图」。长图不是纸——它是一张连续长纸，宽度取 `LONG_IMAGE_WIDTH`、
 *  高度由内容说了算。**这里没有 16:9 / 4:3**：那是投影片的比例，只归展开档。 */
export const PAPER_SIZES: Record<string, [number, number] | null> = {
  A4: [595, 842],
  A5: [420, 595],
  B5: [499, 709],
  Letter: [612, 792],
  长图: null,
};

/** 「原样」档能选的纸（含长图）。 */
export const ORIGINAL_PAPERS = ["A4", "A5", "B5", "Letter", "长图"] as const;

/** 「长图」那一档的纸宽。取文本谱「原版」量到的那一份（`pu/metrics.ts::PRINT.pageWidth`）
 *  ——两者本就是同一种观感，长图也就该同宽。 */
export const LONG_IMAGE_WIDTH = 1000;

/** 出厂纸。原样档与文本谱「原版」档一贯的观感都是长图。 */
export const PAPER_DEFAULT = "长图";

/** 这个纸张名在不在表里。 */
const isPaper = (k: string): boolean => Object.prototype.hasOwnProperty.call(PAPER_SIZES, k);

/** 谱面区的四档排版模式。见 `App.setViewModeButtons` 的注释：这是两组正交状态的组合。 */
export type ViewMode = JianpuLayoutMode | "staff" | "mixed";

/** 文本谱的扩展名。`.txt` 太泛，靠 sniffDialect 兜底，认不出就不动。 */

export class App implements OmrHost, PlaybackHost, FormatHost {
  /** 简谱排版器：展开档是 ExpandedPainter（两种格式共用），`.jpwabc` 原样档是 JinpuPainter。
   *  文本谱原样档另走 `_puPainter`，那时这个闲着。 */
  painter: ExpandedPainter | JinpuPainter;
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
  private _puPainter: PuPainter | null = null;
  /** 最近一次排版用的 `.Layout` 分页描述（导出 PPTX 按展开档另排一遍时要用同一份）。 */
  private _breakDesc: string | null = null;
  /** 已解析出的文本谱方言，用于代码区标签（解析前未知）。 */
  private _puDialect: Dialect | null = null;
  /** 上次解析结果的缓存（同一份文本不重复解析）。文本谱另留解析器直出的 `PuDoc`——
   *  乐句重排改写的是原文本身，要它的原文列号（`pu/relayout.ts`）。 */
  private _scoreDoc: { text: string; doc: ScoreDoc; pu: PuDoc | null } | null = null;
  /** 上次转出的 Score 及「Chord → 元素 id」的对照（试听逐字高亮靠它搭桥）。 */
  private _puScoreCache: {
    text: string;
    /** 转出这份 Score 的模型（排版器、同步索引认的是它的排版行视图） */
    doc: ScoreDoc;
    /** 展开档那一份调过声部顺序与段号（`ToScoreOptions.forExpanded`），与原样档那份不通用 */
    forExpanded: boolean;
    score: Score | null;
    chordIds: Map<Chord, ElementId>;
  } | null = null;
  private _highlightCompartment = new Compartment();

  // ---- 双向定位（代码区光标 ↔ 谱面元素，见 editor/sync.ts）----
  private _sync = new SyncIndex();
  /** 谱面 `<g>` → 索引条目（点谱面时从事件目标往上找） */
  private _syncEls = new Map<Element, SyncEntry>();
  /** 条目 → 谱面 `<g>`（光标移动时直接取） */
  private _syncElOf = new Map<SyncEntry, SVGGElement>();
  /** 当前被光标点亮的那些 `<g>` */
  private _syncMarked: Element[] = [];
  /** 防回环：两条方向互相触发时，被动的那一侧不要再反推一次 */
  private _syncing = false;
  /** 展开档：元素 id → Score 和弦（`_puScoreCache.chordIds` 的反向） */
  private _noteToChord: Map<ElementId, Chord> | null = null;
  /** `.jpwabc`：元素 id → 谱面 Score 和弦（`_buildJpwSync` 建） */
  private _jpwNoteToChord: Map<ElementId, Chord> | null = null;

  mixedXmlText: string | null = null;
  private _mixedPainter: MixedPainter | null = null;
  /** 排版模式切换（展开 / 原样 / 五线谱 / 混排）的四个按钮，见 `ViewMode`。 */
  private _viewBtns = new Map<ViewMode, HTMLButtonElement>();
  private _viewSwitchEl: HTMLElement | null = null;
  /** 有没有 MusicXML 底本——没有就排不出五线谱/混排，那两档置灰。 */
  private _mixedAvailable = false;
  /** 简谱 OMR 的那一摊（识别、叠加核对、点选定位、输出格式）——见 editor/omrctl.ts。 */
  readonly omr: OmrController = new OmrController(this);
  /** 最近一次 xml 导入的序列化映射，供 OmrController 接管为它的点选映射。 */
  private _lastImportMeta: JpwMeta | null = null;
  /** 识别核对：从识别底本转出的 123 原文。文本仍与它逐字相同 = 没改过，存回时给底本 */
  private _omrBaseText: string | null = null;
  // 乐句排版：缓存导入时的「原始排版」文本以便无损切回；_phraseOn 记当前是否乐句排版。
  private _originalLayoutBtnEl: HTMLButtonElement | null = null;
  private _phraseBtnEl: HTMLButtonElement | null = null;
  private _origLayoutText: string | null = null;
  private _phraseOn = false;
  /** 文本谱：上一次重排**产出的**那份原文。文本与它不同了就说明用户自己动过手。 */
  private _phraseText: string | null = null;
  private _hanziBtnEl: HTMLButtonElement | null = null;
  private _readOnlyCompartment = new Compartment();
  // render settings (app-level, not part of the .jpwabc document)
  pageW = 960;
  pageH = 540;
  /** 两档各记一套字号，切档互不影响（用户口径：「区分 展开/原样的字号设置」）。
   *  展开档三个都能调；原样档**只调基础字号**，标题与词曲按 `_setJpFontSize` 派生。
   *  当前生效的那一套走下面三个 getter——排版器、设置面板、帮助示例都只认「当前档」。 */
  private _sizes: Record<JpProfileName, { fontSize: number; titleSize: number; creditSize: number }> = {
    pptx: { ...JP_SIZE_DEFAULTS },
    normal: { ...JP_SIZE_DEFAULTS },
  };
  get fontSize(): number {
    return this._sizes[this.jpProfile].fontSize;
  }
  get titleSize(): number {
    return this._sizes[this.jpProfile].titleSize;
  }
  get creditSize(): number {
    return this._sizes[this.jpProfile].creditSize;
  }
  /** 某一档的那套字号（只读快照）。导出 PPTX 要按 **展开档**另排一遍，
   *  用的就得是那一档的字号，哪怕屏幕正停在原样档。 */
  sizesOf(profile: JpProfileName): { fontSize: number; titleSize: number; creditSize: number } {
    return { ...this._sizes[profile] };
  }
  /** 当前档实际排版用的那张纸。展开档就是 `pageW`/`pageH` 那张投影片；原样档宽度锁定、
   *  原样档取 `PAPER_SIZES` 里那张实际纸（长图那一档不分页，返回的高度只是个占位）。
   *  排版、分行度量（`_phraseFit`）都认它——两处若各用各的纸，行长会按 A 张纸算、
   *  按 B 张纸排。 */
  get layoutPage(): { w: number; h: number } {
    if (this.jpProfile === "pptx") return { w: this.pageW, h: this.pageH };
    const paper = PAPER_SIZES[this.jpPaper];
    // 长图：宽固定，高度由内容说了算（传进去的只是个不参与分页的占位）
    if (!paper) return { w: LONG_IMAGE_WIDTH, h: LONG_IMAGE_WIDTH };
    return { w: paper[0], h: paper[1] };
  }

  /** 原样档当前是不是长图那一档。 */
  get jpLongImage(): boolean {
    return PAPER_SIZES[this.jpPaper] == null;
  }

  /** 文本谱**原样档**的面板设置 → PuPainter 的覆盖层（展开档不走 PuPainter，见 `expandedOptions`）。 */
  puUserOptions(): PuUserOptions {
    const digitFontSize = this.puFontSize || undefined;
    const paper = PAPER_SIZES[this.puPaper];
    if (!paper) return { digitFontSize, continuous: true }; // 长图：纸交给内容定
    return { digitFontSize, pageWidth: paper[0], pageHeight: paper[1], continuous: false };
  }

  /** 原样档换纸（「长图」也是其中一档）。 */
  setJpPaper(paper: string): void {
    this.applyRenderSettings({ jpPaper: paper });
  }

  /** 原样档只暴露基础字号，标题/词曲按展开档的出厂比例派生（见 JP_TITLE_RATIO）。 */
  private _setJpFontSize(v: number): void {
    this._sizes.normal = {
      fontSize: v,
      titleSize: Math.round(v * JP_TITLE_RATIO),
      creditSize: Math.round(v * JP_CREDIT_RATIO),
    };
  }
  /** 前景色与背景色，**两档各记一套**（同纸张与字号：档与档之间的设置不该串味）。
   *  档指的是「展开 / 原样」那一对排版方式，跨文档格式——`.jpwabc` 与文本谱在同一档下共用同一份色。
   *  背景色只作用于「纸」（预览页的底、导出 PNG 的底、PPTX 的幻灯片底），排版器不认识它。 */
  private _colors: Record<JianpuLayoutMode, { fg: number; bg: number }> = {
    expanded: { fg: 0xff000000, bg: 0xffffffff },
    original: { fg: 0xff000000, bg: 0xffffffff },
  };
  /** 当前档的键。`_slideProfile()` 已经把两种格式各自的档统一成这一对了。 */
  private get _colorKey(): JianpuLayoutMode {
    return this.layoutMode;
  }
  get color(): number {
    return this._colors[this._colorKey].fg;
  }
  get bgColor(): number {
    return this._colors[this._colorKey].bg;
  }
  /** 某一档的配色。导出 PPTX 要按 **展开档**另排一遍，用的就得是那一档的色。 */
  colorsOf(profile: JianpuLayoutMode): { fg: number; bg: number } {
    return { ...this._colors[profile] };
  }
  /** 原样档的纸（键取自 `PAPER_SIZES`，「长图」是其中一档）。 */
  jpPaper = PAPER_DEFAULT;
  /** 文本谱「原样」档的纸（展开档与 `.jpwabc` 共用 pageW/pageH）。 */
  puPaper = PAPER_DEFAULT;
  /** 文本谱原样档音符数字的字号（pt）。0 = 跟随版式量到的原尺寸。展开档与 `.jpwabc` 共用 `_sizes.pptx`。 */
  puFontSize = 0;
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


  constructor(meta: MetaData, scorePane: HTMLElement) {
    this.meta = meta;
    this.painter = new JinpuPainter(this.fontSize);
    this.painter.layout.options.smuflMeta = meta;
    this.scorePane = scorePane;
    // 默认档是 PPT，构造出来的 painter 也要带上那一档的笔画常量
    // （loadSettings 在没有持久化设置时会直接 return，不能指望它来灌）。
    this._rebuildPainter();
  }

  /** 按当前档与设置重建排版器，保留已排好的 Score。选项都是构造时一次灌定的
   *  （`applyPptxStyle` 是**单向覆写**，切回原样只能换一份干净的 LayoutOptions），
   *  所以档位或设置一变就整个重建——排版器本身很轻，重的是随后的 reload。 */
  private _rebuildPainter(): void {
    const score = this.painter.score;
    if (this.layoutMode === "expanded") {
      this.painter = new ExpandedPainter(this.expandedOptions());
    } else {
      const p = new JinpuPainter(this.fontSize);
      const opt = p.layout.options;
      opt.smuflMeta = this.meta;
      opt.color = this.color;
      opt.titleSize = this.titleSize;
      opt.creditSize = this.creditSize;
      // 排版输出的选项最后灌，覆盖在上面那几个之上（契约见 JinpuPainter.applyOriginal）
      p.applyOriginal({ longImage: this.jpLongImage });
      this.painter = p;
    }
    this.painter.score = score;
  }

  /** 展开档的设置——**只在这里组一次**：两种格式、屏幕预览与导出 PPTX 都吃这一份。 */
  expandedOptions(): ExpandedOptions {
    const s = this._sizes.pptx;
    return {
      pageW: this.pageW,
      pageH: this.pageH,
      fontSize: s.fontSize,
      titleSize: s.titleSize,
      creditSize: s.creditSize,
      color: this._colors.expanded.fg,
      smuflMeta: this.meta,
    };
  }

  /** 把一份 Score 交给当前排版器排版（展开档用自己的投影片尺寸，原样档用 `layoutPage`）。 */
  private _layoutScore(score: Score, breakDesc: string | null): void {
    const p = this.painter;
    if (p instanceof ExpandedPainter) {
      p.load(score, breakDesc);
      return;
    }
    p.score = score;
    const { w, h } = this.layoutPage;
    p.resize(w, h, breakDesc);
  }

  /** 简谱版面切换（原版 / PPT）。展开档 = 2026-08 排版重构之前的笔画观感，
   *  也是「导出 PPTX」用的那一档，见 layout/pptxstyle.ts。 */
  setJpProfile(profile: JpProfileName): void {
    if (this.jpProfile === profile) return;
    this.jpProfile = profile;
    // 换档连字号与配色也换了一套（两档各记各的）：_rebuildPainter 按新档的 fontSize 重建，
    // 纸底那层是 CSS 变量、不经排版器，得单独刷一次
    this._rebuildPainter();
    this._applyPageBg();
    this._syncViewModeButtons();
    this.saveSettings();
    if (this.adapter.profileKnob === "jp") this.reload(this.getText());
  }

  /** Apply page-size / font-size / title-size / credit-size / color render settings and re-render. */
  applyRenderSettings(opts: {
    pageW?: number; pageH?: number; jpPaper?: string;
    puPaper?: string; puFontSize?: number;
    fontSize?: number; titleSize?: number; creditSize?: number; color?: number; bgColor?: number;
  }): void {
    if (opts.pageW) this.pageW = opts.pageW;
    if (opts.pageH) this.pageH = opts.pageH;
    // 原样档的纸要在 _rebuildPainter 之前定好——那里按 jpLongImage 灌 continuousPage
    if (opts.jpPaper && isPaper(opts.jpPaper)) this.jpPaper = opts.jpPaper;
    if (opts.puPaper && isPaper(opts.puPaper)) this.puPaper = opts.puPaper;
    if (opts.puFontSize !== undefined) this.puFontSize = Math.min(200, Math.max(0, opts.puFontSize));
    if (opts.color !== undefined) this._colors[this._colorKey].fg = opts.color;
    if (opts.bgColor !== undefined) {
      this._colors[this._colorKey].bg = opts.bgColor;
      this._applyPageBg();
    }
    this._applySizes(opts);
    this._rebuildPainter();
    this.saveSettings();
    this.reload(this.getText());
  }

  /** 字号落到**当前档**那一套里。原样档只收基础字号——那一档的标题/词曲是派生的，
   *  面板上根本不显示（见 editor/dialogs.ts），收了也只会被下一次派生覆盖掉。 */
  private _applySizes(opts: { fontSize?: number; titleSize?: number; creditSize?: number }): void {
    // 按**当前档**分：文本谱的展开档也落 `_sizes.pptx`（与 `.jpwabc` 共用），那时 jpProfile 未必是 pptx
    if (this.layoutMode === "original") {
      if (opts.fontSize) this._setJpFontSize(opts.fontSize);
      return;
    }
    const s = this._sizes.pptx;
    if (opts.fontSize) s.fontSize = opts.fontSize;
    if (opts.titleSize !== undefined) s.titleSize = opts.titleSize;
    if (opts.creditSize !== undefined) s.creditSize = opts.creditSize;
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
    // 展开档只有 PAGE_RATIOS 那两种比例；存下来的尺寸不在表里（从前还能选 A4）就留出厂的 16:9
    if (s.pageW && s.pageH && Object.values(PAGE_RATIOS).some(([w, h]) => w === s.pageW && h === s.pageH)) {
      this.pageW = s.pageW;
      this.pageH = s.pageH;
    }
    // 字号分两档存：fontSize/titleSize/creditSize 是展开档（存量数据的语义），
    // jpFontSize 是原样档；后者缺省就按出厂比例从出厂字号派生。
    if (s.fontSize) this._sizes.pptx.fontSize = s.fontSize;
    if (s.titleSize !== undefined) this._sizes.pptx.titleSize = s.titleSize;
    if (s.creditSize !== undefined) this._sizes.pptx.creditSize = s.creditSize;
    this._setJpFontSize(s.originalFontSize || JP_SIZE_DEFAULTS.fontSize);
    // 存量数据里的 color/bgColor 是展开档的（默认档一直是 PPT），原地继承、不必迁移
    if (s.expandedColor !== undefined) this._colors.expanded.fg = s.expandedColor;
    if (s.expandedBgColor !== undefined) this._colors.expanded.bg = s.expandedBgColor;
    if (s.originalColor !== undefined) this._colors.original.fg = s.originalColor;
    if (s.originalBgColor !== undefined) this._colors.original.bg = s.originalBgColor;
    if (s.zoom) this.zoom = s.zoom;
    if (s.jpPaper && isPaper(s.jpPaper)) this.jpPaper = s.jpPaper;
    if (s.puPaper && isPaper(s.puPaper)) this.puPaper = s.puPaper;
    if (s.puFontSize !== undefined) this.puFontSize = s.puFontSize;
    if (s.jpProfile === "normal" || s.jpProfile === "pptx") this.jpProfile = s.jpProfile;
    if (s.puProfile === "print" || s.puProfile === "slide") this.puProfile = s.puProfile;
    this._applyZoom();
    this._applyPageBg();
    // jpProfile 要在重建之前定好——_rebuildPainter 既按它取那一档的字号，
    // 末尾又按它灌展开档的笔画常量
    this._rebuildPainter();
  }

  /** 两个控制器也要用（切输出格式 / 改速度后持久化）。 */
  saveSettings(): void {
    savePersistedSettings({
      pageW: this.pageW,
      pageH: this.pageH,
      fontSize: this._sizes.pptx.fontSize,
      titleSize: this._sizes.pptx.titleSize,
      creditSize: this._sizes.pptx.creditSize,
      originalFontSize: this._sizes.normal.fontSize,
      jpPaper: this.jpPaper,
      puPaper: this.puPaper,
      puFontSize: this.puFontSize,
      expandedColor: this._colors.expanded.fg,
      expandedBgColor: this._colors.expanded.bg,
      originalColor: this._colors.original.fg,
      originalBgColor: this._colors.original.bg,
      zoom: this.zoom,
      mixedHideBarNumber: this.mixedHideBarNumber,
      mixedShowJianpuLayer: this.mixedShowJianpuLayer,
      playSpeed: this.playback.speed,
      omrFormat: this.omr.format,
      jpProfile: this.jpProfile,
      puProfile: this.puProfile,
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
      if (u.selectionSet && !u.docChanged) this._syncCursorToScore();
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

  /** 当前文本是否与「识别底本转出的 123」逐字相同。
   *  true = 用户没改过谱面，MusicXML 导出可以直接给底本原文（零损耗）。 */
  get importUnchanged(): boolean {
    return this._omrBaseText !== null && this.mixedXmlText !== null && this.getText() === this._omrBaseText;
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
    return this.adapter.reload(this, text);
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
    let score;
    try {
      score = fromJpw(f);
    } catch (e) {
      console.error("import failed", e);
      return false;
    }
    if (!score) return false;

    const breakDesc = f.getSection(LayoutSection)?.desc ?? null;
    this._breakDesc = breakDesc; // 导出 PPTX 时另排一遍要用同一份分页描述
    try {
      this._layoutScore(score, breakDesc);
    } catch (e) {
      console.error("layout failed", e);
      return false;
    }
    this.renderPages();
    this.playback.refreshSpeedUi(); // 谱面 ♩= 随文本走，速度提示要跟着换
    this._buildJpwSync(f, score);
    return true;
  }

  /** `.jpwabc` 的双向定位：索引建在 `jpwToScoreDoc` 带 span 的模型上，谱面仍是 `fromJpw` 的 Score，
   *  两边按和弦次序（跳倚音）配出「元素 id → 和弦」。两路和弦逐个一致由 `jpw-doc-check` 保证；
   *  个数对不上就不建索引（宁可不亮，不亮错）。阶段 9 引擎直吃 ScoreDoc 后这层配对消失。 */
  private _buildJpwSync(f: JpwFile, score: Score): void {
    const m = new Map<ElementId, Chord>();
    let doc: ScoreDoc;
    try {
      doc = jpwToScoreDoc(f);
    } catch (e) {
      console.warn("jpwabc 定位索引建不出", e);
      doc = emptyDoc("jpwabc");
    }
    const chords: Chord[] = [];
    for (const mea of score.parts[0]?.measures ?? []) for (const ent of mea.entries) if (ent instanceof Chord) chords.push(ent);
    const ids: ElementId[] = [];
    for (const song of doc.songs) for (const { chord } of eachChord(song)) if (!chord.grace) ids.push(chord.id);
    if (ids.length === chords.length) ids.forEach((id, i) => m.set(id, chords[i]!));
    else {
      console.warn(`jpwabc 定位：模型 ${ids.length} 个和弦、谱面 ${chords.length} 个，对不上，不建索引`);
      doc = emptyDoc("jpwabc");
    }
    this._jpwNoteToChord = m;
    this._buildSync(doc);
  }


  /** 文本谱（番茄 / 诗歌本）：解析 → 排版 → 渲染。展开档先转成 Score、与 `.jpwabc` 同一个排版器；
   *  原样档走文本谱专用的 PuPainter（印刷原版的观感）。 */
  reloadPu(text: string): boolean {
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
    let sdoc: ScoreDoc;
    try {
      sdoc = puToScoreDoc(doc);
    } catch (e) {
      console.error("文本谱转模型失败", e);
      this.setStatus("文本谱转模型失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
    this._scoreDoc = { text, doc: sdoc, pu: doc };
    this._puScoreCache = null; // 文本变了，Score 与 chordIds 都要重建
    this._noteToChord = null;
    // 乐句重排：**用户手改过的文本就是新的「原样」基准**（切回按钮要还原到它）。
    // 重排后又手改的，也按「这就是新的原样」算——否则一按「原样」就把用户后来的编辑抹了。
    if (this._phraseOn && text !== this._phraseText) {
      this._phraseOn = false;
      this._setPhraseActive(false);
    }
    if (!this._phraseOn) this._origLayoutText = text;
    this._setPhraseAvailable(true);
    this._puDialect = doc.dialect;
    this._syncFormatLabel();
    if (!this._layoutScoreDoc(sdoc, "文本谱")) return false;
    // 解析告警不拦排版，但要让用户看得见（谱面往往仍然是对的）
    this._reportDiagnostics(dialectSpec(doc.dialect).name, doc.diagnostics);
    return true;
  }

  /** FormatHost：`.123`（简谱主格式）解析 → 排版 → 渲染。
   *  原生解析直出 `ScoreDoc`，与文本谱共用同一对排版器（原样档 `PuPainter` / 展开档 `ExpandedPainter`）。 */
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
    this._scoreDoc = { text, doc, pu: null };
    this._puScoreCache = null; // 文本变了，Score 与 noteMap 都要重建
    this._noteToChord = null;
    // 乐句重排认的是文本谱语法（`pu/relayout.ts` 重排的是原文本身），123 这一档不给
    this._disablePhrase();
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
    this._scoreDoc = { text, doc, pu: null };
    this._puScoreCache = null;
    this._noteToChord = null;
    this._disablePhrase();
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
      const score = loadMusicXml(xml);
      this.mixedXmlText = xml;
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

  /** 经 `ScoreDoc` 排版并铺页（文本谱、123、ABC 共用）：
   *  展开档先转 `Score`、与 `.jpwabc` 同一个排版器；原样档走 `PuPainter`（印刷原版的观感）。 */
  private _layoutScoreDoc(doc: ScoreDoc, what: string): boolean {
    try {
      if (this.layoutMode === "expanded") {
        this._puPainter = null;
        // 试听、点选与高亮认的都是这同一份 Score 对象（puScore 有缓存）
        const score = this.puScore();
        if (!score) {
          this.setStatus(`这份${what}里没有可排的曲行`);
          return false;
        }
        this._layoutScore(score, null);
      } else {
        this._puPainter ??= new PuPainter();
        this._puPainter.setUserOptions(this.puUserOptions(), this.color);
        this._puPainter.load(doc);
      }
    } catch (e) {
      console.error(`${what}排版失败`, e);
      this.setStatus(`${what}排版失败：` + (e instanceof Error ? e.message : String(e)));
      return false;
    }
    if (this._puPainter) this.renderPuPages();
    else this.renderPages();
    this._buildSync(doc);
    return true;
  }

  // ---------------- 双向定位（代码区光标 ↔ 谱面元素）----------------

  /** 重建索引与「条目 ↔ 谱面 `<g>`」两张反查表。**每次重排后都要建**——页面节点全换了。 */
  private _buildSync(doc: ScoreDoc): void {
    this._sync.build(doc);
    this._syncEls.clear();
    this._syncElOf.clear();
    this._syncMarked = [];
    for (const entry of this._sync.all()) {
      const el = this._syncGroupEl(entry);
      if (!el) continue;
      this._syncElOf.set(entry, el);
      // 展开档里音符与它的歌词共用一个 `<g>`，先来的音符条目占住它（`all()` 已排好序）
      if (!this._syncEls.has(el)) this._syncEls.set(el, entry);
    }
    this._syncCursorToScore();
  }

  /** 一个条目对应的谱面 `<g>`：原样档问 `PuPainter`，展开档经 Score 的和弦问排版器。 */
  private _syncGroupEl(entry: SyncEntry): SVGGElement | null {
    const p = this._puPainter;
    if (p) {
      return entry.verse === null
        ? p.noteGroupEl(entry.id)
        : p.syllableGroupEl(entry.id, entry.verse);
    }
    const chord = this._chordOfNote(entry.id);
    return chord ? this.painter.chordGroupEl(chord, entry.verse ?? 0) : null;
  }

  /** 展开档：元素 id → Score 和弦（`puScore` 建的 chordIds 的反向，用时才建）。 */
  private _chordOfNote(id: ElementId): Chord | null {
    if (this.adapter.caps.layout === "jpwabc") return this._jpwNoteToChord?.get(id) ?? null;
    if (!this._noteToChord) {
      const m = new Map<ElementId, Chord>();
      // puScore() 会填 _puScoreCache；展开档下它与谱面是同一份 Score
      this.puScore();
      for (const [chord, n] of this._puScoreCache?.chordIds ?? []) if (!m.has(n)) m.set(n, chord);
      this._noteToChord = m;
    }
    return this._noteToChord.get(id) ?? null;
  }

  /** 文本 → 谱面：光标/选区落在哪些音符上，就给哪些 `<g>` 加 `cursor-at`。
   *  **走 CSS 类、不重渲染**（沿用编辑器既有判据）。 */
  private _syncCursorToScore(): void {
    if (this._syncing) return;
    for (const el of this._syncMarked) el.classList.remove("cursor-at");
    this._syncMarked = [];
    if (this.mode !== "jp") return;
    const sel = this.view.state.selection.main;
    const entries = this._sync.range(sel.from, sel.to);
    if (entries.length === 0) return;
    for (const entry of entries) {
      const el = this._syncElOf.get(entry);
      if (!el) continue;
      el.classList.add("cursor-at");
      this._syncMarked.push(el);
      // 光标停在音符上时，它的第一段歌词也一起亮（与播放高亮同一套观感）
      if (entry.verse === null && this._puPainter) {
        const syl = this._puPainter.syllableGroupEl(entry.id, 0);
        if (syl) {
          syl.classList.add("cursor-at");
          this._syncMarked.push(syl);
        }
      }
    }
    this._scrollSyncIntoView(this._syncMarked[0], entries[0]!);
  }

  /** 谱面 → 文本：把光标放到这个条目对应的原文区间上。 */
  private _syncScoreToCursor(entry: SyncEntry): void {
    const span = entry.verse === null
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
    for (const el of this._syncMarked) el.classList.remove("cursor-at");
    this._syncMarked = [];
    const el = this._syncElOf.get(entry);
    if (!el) return;
    el.classList.add("cursor-at");
    this._syncMarked.push(el);
  }

  /** 需要的话翻页并滚动到可视区（复用播放高亮那一套做法）。 */
  private _scrollSyncIntoView(el: Element | undefined, entry: SyncEntry): void {
    if (!el) return;
    const page = this._puPainter?.pageOfNote(entry.id) ?? null;
    if (page !== null && page !== this.pageIndex) this.pageIndex = page;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ---- 下面三个供脚本化测试（`window.__app`，见 scripts/sync-check.mjs）----
  /** 索引里的全部条目，只给可序列化的那几个字段。 */
  syncEntries(): Array<{ from: number; to: number; verse: number | null }> {
    return this._sync.all().map((e) => ({ from: e.from, to: e.to, verse: e.verse }));
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
      // 原样档没有几何拾取（PuPainter 不做 pickPage），双向定位靠事件冒泡找 `<g>`
      onPage: (svg) => svg.addEventListener("click", (ev) => this._onSyncClick(ev)),
    });
  }

  /** 文本谱版面切换（原版 / PPT）。 */
  setPuProfile(profile: "print" | "slide"): void {
    if (this.puProfile === profile) return;
    this.puProfile = profile;
    this._rebuildPainter(); // 展开档要一个 ExpandedPainter
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

  /** 当前文档的 `ScoreDoc`（文本谱/123/ABC；排版器、Score、同步索引共用同一份对象）。 */
  currentScoreDoc(): ScoreDoc | null {
    const toScoreDoc = this.adapter.toScoreDoc;
    if (!toScoreDoc) return null;
    const text = this.getText();
    if (this._scoreDoc?.text === text) return this._scoreDoc.doc;
    try {
      const doc = toScoreDoc(text);
      this._scoreDoc = { text, doc, pu: null };
      return doc;
    } catch {
      return null;
    }
  }

  /** 文本谱解析器直出的 `PuDoc`——**只给乐句重排**（它改写原文，要原文列号）。 */
  private puSource(): PuDoc | null {
    if (this.docFormat !== "pu") return null;
    const text = this.getText();
    if (this._scoreDoc?.text === text && this._scoreDoc.pu) return this._scoreDoc.pu;
    try {
      const pu = parsePu(text);
      this._scoreDoc = { text, doc: puToScoreDoc(pu), pu };
      return pu;
    } catch {
      return null;
    }
  }

  /** 当前文档对应的 Score（导出 .jpwabc / MIDI、试听与展开档排版共用）。
   *  `forExpanded`：展开档那一份（带歌词的声部换到最前、同号歌词顺延，见 `ToScoreOptions.forExpanded`）。
   *  默认跟当前档走——展开档里谱面、试听与高亮必须是**同一份** Score 对象（高亮按 Chord 身份认）。 */
  puScore(forExpanded = this.layoutMode === "expanded"): Score | null {
    if (this.adapter.caps.layout !== "scoredoc") return null;
    const text = this.getText();
    const doc = this.currentScoreDoc();
    if (!doc) return null;
    const c = this._puScoreCache;
    if (c && c.text === text && c.doc === doc && c.forExpanded === forExpanded) return c.score;
    const chordIds = new Map<Chord, ElementId>();
    let score: Score | null;
    try {
      score = scoreDocToScore(doc, { chordIds, forExpanded });
    } catch (e) {
      console.error("转 Score 失败", e);
      return null;
    }
    this._puScoreCache = { text, doc, score, chordIds, forExpanded };
    this._noteToChord = null;
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

  /** FormatHost：谱面排版器认得的标题。 */
  get painterTitle(): string {
    return this.painter.score.title;
  }

  get puPainter(): PuPainter | null {
    return this.adapter.caps.layout === "scoredoc" ? this._puPainter : null;
  }

  /** 切换编辑的源格式：换高亮、清掉另一路的状态。 */
  private _setDocFormat(format: DocFormatId): void {
    if (this.docFormat === format) return;
    this.docFormat = format;
    this.view.dispatch({
      effects: this._highlightCompartment.reconfigure(this.adapter.highlighter),
    });
    if (!this.adapter.caps.mixed) {
      // 混排是简谱那侧的上下文工具，文本谱不适用；乐句重排两种格式都有
      // （文本谱走 `pu/relayout.ts`，重排的是原文本身），可用性由 reloadPu 定。
      this._disablePhrase();
      this.mixedXmlText = null;
      this._setMixedAvailable(false);
    } else {
      this._puPainter = null;
      this._puDialect = null;
      this._scoreDoc = null;
      this._puScoreCache = null;
      this._noteToChord = null;
    }
    // 没有代码区的格式（`.musicxml`）把代码区收起来
    document.getElementById("body")?.classList.toggle("no-code", !this.adapter.caps.textEditor);
    // 两种格式各记一个档位（jpProfile / puProfile），换格式可能就换了档
    this._rebuildPainter();
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
      onPage: (svg, _wrap, i) => svg.addEventListener("click", (e) => this.onPageClick(i, svg, e)),
    });
  }

  // ---------------- picking / selection ----------------
  private onPageClick(pageIndex: number, svg: SVGSVGElement, ev: MouseEvent): void {
    // 双向定位先走一遍：它按 `<g>` 认（事件冒泡即可），**不依赖几何拾取**——
    // 两个档因此共用同一条路径，也不受 pickPage 拾取不到时的早退影响。
    this._onSyncClick(ev);
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

  /** 谱面被点击 → 代码区光标跳到对应原文。找不到对应条目就什么都不做
   *  （点在标题、小节线上都算找不到）。 */
  private _onSyncClick(ev: Event): void {
    if (this.mode !== "jp") return;
    const entry = this._syncEntryAt(ev.target);
    if (entry) this._syncScoreToCursor(entry);
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
    return this.adapter.caps.layout === "scoredoc" ? this.puScore() : this.painter.score;
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
    // 原样档：播放器给的是 Chord，「原版」谱面按元素 id 索引，靠 chordIds 搭桥。
    // 展开档与 .jpwabc 同一个排版器，照下面按 Chord 高亮。
    if (this.adapter.caps.layout === "scoredoc" && this.layoutMode === "original") {
      const painter = this._puPainter;
      if (!painter) return;
      const id = chord ? this._puScoreCache?.chordIds.get(chord) : undefined;
      const pg = painter.highlight(id ?? null, Math.max(0, pass - 1));
      if (id !== undefined && pg !== null) {
        if (pg !== this.pageIndex) this.pageIndex = pg;
        painter.noteGroupEl(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  /** 按扩展名落地：.abc / .123 / 文本谱 / .musicxml（无代码区）各进原生格式；其余按 UTF-16 .jpwabc 读。 */
  importBytes(bytes: Uint8Array, name: string): void {
    // 任何新导入都使上一次的识别叠加产物失效（识别结果由 OmrController 在本调用之后重设）。
    this.omr.clear();
    this._omrBaseText = null;
    // ABC 记谱：**原文就是源格式**，原生解析直接进编辑器（`reloadAbc`），不再转 MusicXML。
    // 原生解析读不动时由 `reloadAbc` 自己回落 abc2xml，这里不预先转。
    if (/\.abc$/i.test(name)) {
      this.mixedXmlText = null;
      this._mixedPainter = null;
      this._setMixedAvailable(false);
      this._setMode("jp");
      this._setDocFormat("abc");
      this.setText(formatOf("abc").decode(bytes));
      return;
    }
    // 123（简谱主格式）：原文就是源格式，直接进编辑器，不做任何转换。
    if (is123File(name)) {
      this.mixedXmlText = null;
      this._mixedPainter = null;
      this._setMode("jp");
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
      this.mixedXmlText = null;
      this._mixedPainter = null;
      this._setMode("jp");
      this._setDocFormat("pu");
      this.setText(puText);
      return;
    }
    if (/\.(xml|musicxml)$/i.test(name)) {
      // MusicXML：**没有代码区**，只进谱面视图（五线谱/混排，或由 `ScoreDoc` 排出的简谱）。
      // 编辑器文档里存的就是 XML 原文（不显示）：存回原文件时没改过就是原文，零损耗。
      // 要编辑就「转成文本格式」，那是另一份新文档（`convertToTextDoc`）。
      const xml = formatOf("musicxml").decode(bytes);
      this._mixedPainter = null;
      this._setDocFormat("musicxml");
      this.mixedXmlText = xml;
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
      this.mixedXmlText = null;
      this._mixedPainter = null;
      this._setMixedAvailable(false);
      this._disablePhrase();
      this._setMode("jp");
      this.setText(formatOf("jpwabc").decode(bytes));
    }
  }

  /**
   * 简谱识别产物落地（`OmrHost.importOmrMusicXml`）：MusicXML 底本 + 可编辑的 123 转换文本。
   *
   * 与用户打开 `.musicxml` 不同：识别核对要在代码区里改简谱文本、点选定位靠转换文本的源区间
   * （`lastImportMeta`，见 `omrmeta.ts`）。底本留在 `mixedXmlText`：没改过就原样存回，
   * 改过就由 123 文本整份重写（`export.ts::buildMusicXml`）。
   */
  importOmrMusicXml(xml: string): void {
    this.omr.clear();
    const doc = formatOf("musicxml").toScoreDoc!(xml);
    const text = emit123(doc);
    const losses = planSave(doc, "123");
    this._setDocFormat("123");
    this.mixedXmlText = xml;
    this._mixedPainter = null; // reset so next showStaffPreview re-loads
    this._setMixedAvailable(true);
    this._setMode("jp");
    this._syncViewModeButtons();
    this._lastImportMeta = metaFrom123(text); // 供 OmrController 接管为它的点选映射
    this._omrBaseText = text; // 供「未改动就存回底本」判断
    this.setText(text);
    if (losses.length) {
      this.setStatus(`识别结果已转成 123 核对文本；有 ${losses.length} 样 123 表达不了，改动后导出 MusicXML 会丢`);
    }
  }

  /**
   * 五线谱识别产物落地：与打开 `.musicxml` 同一个模式（无代码区、谱面由 XML 出），默认进混排。
   * 五线谱识别的产物带和弦、多声部、slur，`.jpwabc` 装不下，所以不再转简谱文本。
   */
  adoptStaffXml(xml: string): boolean {
    this._mixedPainter = null;
    this._setDocFormat("musicxml");
    this.mixedXmlText = xml;
    this._setMixedAvailable(true);
    this._setMode("mixed");
    this.filePath = null;
    this.setText(xml);
    void this._renderMixedPages();
    return true;
  }

  /** FormatHost：`.musicxml` 读成 `ScoreDoc` → 简谱档排版（五线谱/混排档另由 `MixedPainter` 吃原文）。 */
  reloadMusicXml(text: string): boolean {
    this.mixedXmlText = text;
    this._mixedPainter = null;
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
    this._scoreDoc = { text, doc, pu: null };
    this._puScoreCache = null;
    this._noteToChord = null;
    this._disablePhrase();
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
    this.setText(finishMusicXmlText(scoreDocToMusicXml(doc)));
    if (this.mode === "mixed") void this._renderMixedPages();
    return true;
  }

  /**
   * 把当前 `.musicxml` **转成文本格式的新文档**再编辑：先列出目标格式装不下的东西，确认后
   * 换成该格式、清掉文件路径（原 `.musicxml` 不动），代码区出现。
   */
  async convertToTextDoc(target: "123" | "abc" | "jpwabc"): Promise<void> {
    if (this.docFormat !== "musicxml") return;
    const doc = this.currentScoreDoc();
    const xml = this.getText();
    if (!doc) {
      this.setStatus("这份 MusicXML 读不出来，无法转换");
      return;
    }
    const losses = planSave(doc, target);
    if (losses.length) {
      const ok = await showConfirmDialog("转换会丢东西", describeLosses(target, losses));
      if (!ok) return;
    }
    let text: string;
    try {
      // `.jpwabc` 走既有的 MusicXML → Score → jpwabc（那条路对 500 首实测过）
      text = target === "123" ? emit123(doc) : target === "abc" ? emitAbc(doc) : scoreToJpwabc(loadMusicXml(xml));
    } catch (e) {
      console.error("转换失败", e);
      this.setStatus("转换失败：" + (e instanceof Error ? e.message : String(e)));
      return;
    }
    this.mixedXmlText = null;
    this._mixedPainter = null;
    this._setMixedAvailable(false);
    this._setMode("jp");
    this._setDocFormat(target);
    this.filePath = null;
    this.setText(text);
    this.setStatus(`已转成 ${target} 新文档（未保存，原 MusicXML 未改动）`);
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

  /** 原样排版与按乐句重排之间切换。只有文本谱支持（重排的是原文本身）。 */
  setPhraseLayout(phrase: boolean): void {
    if (this.adapter.caps.phraseRelayout) this._setPuPhraseLayout(phrase);
  }

  /**
   * 文本谱的「按乐句重排」：**重排的是原文本身**（`pu/relayout.ts`），两档因此同时就位
   * ——原样档一行 `Q:` 就是谱面一行，展开档的行边界由 `toscore.ts` 转成 `LineBreak`。
   * 切回「原样」= 把重排前那份原文放回去（逐字相同，Ctrl+Z 也能整体撤销）。
   */
  private _setPuPhraseLayout(phrase: boolean): void {
    if (this._phraseOn === phrase) return;
    const base = this._origLayoutText;
    if (!phrase) {
      if (base === null) return;
      this._phraseOn = false;
      this._setPhraseActive(false);
      this.setText(base);
      return;
    }
    const text = this.getText();
    const doc = this.puSource();
    if (!doc) {
      this.setStatus("文本谱解析失败，无法按乐句重排");
      return;
    }
    try {
      const out = relayoutPuText(text, doc, { measure: this._puPhraseMeasure() });
      if (out === text) {
        this.setStatus("这份文本谱没有可重排的曲行");
        return;
      }
      this._origLayoutText = text;
      this._phraseText = out;
      this._phraseOn = true;
      this._setPhraseActive(true);
      this.setText(out);
    } catch (e) {
      console.error("文本谱乐句重排失败", e);
      this.setStatus("按乐句重排失败");
    }
  }

  /**
   * 文本谱的行长尺子。
   *
   * **只有展开档有**：那一档两种格式同走 `ExpandedPainter`，量它的 `JinpuPainter` 与真正排版的
   * 是同一套坐标。原样档走的是 `PuPainter`——固定步进的另一套尺子、另一套字号，拿简谱那把尺子
   * 去量会以为「两句并一行还宽绰」，排出来却要硬折（73《我主耶稣是生命源》一行 8 小节）。
   * 没有尺子时 `phrase.ts` 按出厂的小节数目标断，也就是一句一行——印刷原版要的正是这个。
   */
  private _puPhraseMeasure(): FitMeasure | null {
    if (this.layoutMode !== "expanded") return null;
    // 量的必须是**断行模块自己那份 Score**（span 以 Chord 身份为键），所以给的是函数不是结果。
    return (score) => this._fitOf(score, this.pageW, this._sizes.pptx.fontSize);
  }

  /** 乐句重排的行长度量：按实际纸宽与字号量出每小节自然宽度（`phrase.ts::targetMeasForFit`）。
   *  另起一个 painter 来量，且要 `lyricStack > 0`：展开档会按反复与多段各排一遍，按小节取跨度就成了整首。 */
  private _fitOf(score: Score, width: number, fontSize: number): FitMetric {
    const p = new JinpuPainter(fontSize);
    p.layout.options.smuflMeta = this.meta;
    p.layout.options.lyricStack = fontSize; // 只要 > 0：不展开反复，一遍就够量
    score.clearSystemBreak();
    return p.layout.measureNatural(score, width);
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
      if (!this.mixedXmlText) return;
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

  private _setMixedAvailable(available: boolean): void {
    this._mixedAvailable = available;
    this._syncViewModeButtons();
  }

  private _syncViewModeButtons(): void {
    if (this._viewSwitchEl) this._viewSwitchEl.hidden = this._viewBtns.size === 0;
    const active = this.viewMode;
    for (const [mode, btn] of this._viewBtns) {
      const needsXml = mode === "staff" || mode === "mixed";
      btn.disabled = needsXml && !this._mixedAvailable;
      const on = mode === active;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
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

  /** 代码区右上角的格式标签。 */
  private _formatLabel(): string {
    return this.adapter.label(this);
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
  async saveAsFormat(target: TargetFormat): Promise<void> {
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
    const adapter = target === "musicxml" ? null : formatOf(target);
    const bytes = adapter ? adapter.encode(text) : new TextEncoder().encode(text);
    const ext = adapter ? adapter.defaultExt : ".musicxml";
    const dest = await saveBytes(bytes, (this.documentTitle() || "未命名") + ext);
    if (!dest) return;
    this.setStatus(`已另存为 ${ext}`);
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

  /** 当前文档 → 目标格式的文本。转不了返回 null。 */
  private convertTo(target: TargetFormat): string | null {
    if (target === this.docFormat) return this.getText();
    const doc = this.scoreDoc();
    if (!doc) return null;
    if (target === "123") return emit123(doc);
    if (target === "abc") return emitAbc(doc);
    return null; // jpwabc / pu / musicxml 各有既有的导出路径，见 editor/export.ts
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

  /** 盘上那份文件是不是 MusicXML（识别核对另存到 XML 路径时，编辑器里是简谱转换文本、盘上是 XML 底本）。 */
  private get onDiskIsXml(): boolean {
    return this.filePath !== null && /\.(xml|musicxml)$/i.test(this.filePath);
  }

  private async writeTo(path: string): Promise<void> {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    // `.musicxml` 那一档：文档里就是 XML（未改动是原文，改过的已由 `editScoreDoc` 整份重写）。
    // 其余格式存到 XML 路径上（识别核对的 123 转换文本）：未改动给底本，改过由唯一写出端整份重写。
    const bytes = this.docFormat === "musicxml"
      ? this.encodeForSave()
      : this.onDiskIsXml
        ? new TextEncoder().encode(buildMusicXml(this))
        : this.encodeForSave();
    await writeFile(path, bytes);
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
