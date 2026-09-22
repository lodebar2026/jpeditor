// 唯一的排版器 `ScorePainter`：按请求排版（简谱原样 / 展开、原样文档、五线谱 / 混排），持有提交后的结果、
// 页面渲染（DOM 映射）、点选与播放高亮索引。排页算法在各自模块（`jianpupages.ts`、`original/compose.ts`、
// `mixed/staffpages.ts`），SVG 出口在 `render.ts`，这里只管请求版本、结果提交与交互状态。
// 设计与迁移记录见 docs/实现/PuPainter退役.md。
//
// 点选 / 高亮部分移植自 mp/layout/draw.kt。

import { Rect } from "../common/geom";
import { Group, Lyric, PageItem, findByClass } from "./pageitem";
import { NoteEntry } from "./entry";
import { Layout } from "./layout";
import { emptyScore, type JScore } from "./input";
import type { ElementId, ScoreDoc } from "../model/doc";
import { headerPartsOf, mixedVisitor, renderPageSvg, type HeaderPart } from "./render";
import { layoutExpandedPages, layoutOriginalPages } from "./jianpupages";
import { fromPt, pageGeometry, type LayoutHit, type LayoutPage, type LayoutResult, type PaintTarget } from "./result";
import { MetaData } from "../smufl/smufl";
import { applyJianpuStyle, jianpuFontSize } from "../style/jianpu";
import type { StyleSheet } from "../style/sheet";
import { applyStaffStyle } from "../style/staff";
import { computeStyleForPaper, THEMES } from "../style/themes";
import { MixedOptions, type StaffLayout, type Sys } from "../mixed/model";
import { layoutStaff } from "../mixed/layout";
import { layoutStaffPages, PAGE_HEIGHT_FALLBACK } from "../mixed/staffpages";
import { layoutOriginalDocument, type OriginalDocumentLayout } from "./original/compose";
import type { PlacedPage } from "./original/place";
import type { PuMetrics } from "./original/metrics";
import { puUserOptionsOf } from "../style/pu";

// ---------------------------------------------------------------- 请求与资源

/** 简谱引擎的排版设置（原样 / 展开 / 成书 / 帮助示例 / 量宽共用）。 */
export interface JianpuConfig {
  /** 已计算样式表，按它灌 `LayoutOptions`（`style/jianpu.ts::applyJianpuStyle`）；null = 引擎缺省（帮助示例）。 */
  readonly style: StyleSheet | null;
  /** `style` 为 null 时的字号。 */
  readonly fontSize?: number;
  /** 覆盖墨色（帮助示例画在压暗的纸上）。 */
  readonly ink?: number;
  /** 覆盖多段歌词叠排行距（自然量宽要 > 0：不展开反复，一遍就够量）。 */
  readonly lyricStack?: number;
}

/** 简谱引擎这一路的请求。原样 / 展开的输入由调用方投影好（文档级原样投影见退役计划 P3）。 */
export interface JianpuPaintRequest extends JianpuConfig {
  readonly view: "original" | "expanded";
  readonly score: JScore;
  /** `.jpwabc` 的 `.Layout` 分页描述（其他格式没有）。 */
  readonly breakDesc: string | null;
  /** 原样档的纸（排版单位 = pt）。展开档取 `style.page`。 */
  readonly page?: { w: number; h: number };
  /** 只排版面、不加标题页也不叠标题块（帮助示例的谱行片段）。 */
  readonly snippet?: boolean;
}

/** 五线谱 / 混排的请求（`doc` 须是 MusicXML 形状，见 `mixed/layout.ts`）。 */
export interface StaffPaintRequest {
  readonly view: "staff" | "mixed";
  readonly doc: ScoreDoc;
  /** computed 样式表（主题 `staff`）；缺省取内置那份。 */
  readonly style?: StyleSheet;
  /** 谱里没写纸时用的那张（pt；`heightPt` null = 长图），见 `MixedOptions.page`。 */
  readonly page: MixedOptions["page"];
  readonly hideBarNumber: boolean;
}

/** 原样文档这一路（文本谱与多声部 123/ABC、MusicXML 的原样档）：整份 `ScoreDoc` 按源行排，印刷原版观感。 */
export interface DocumentPaintRequest {
  readonly view: "original";
  readonly doc: ScoreDoc;
  /** computed 样式表（`engine: "pu"` 那份）：面板字号、纸 / 长图、前景色。null = 版式原样。 */
  readonly style: StyleSheet | null;
}

export type PaintRequest = JianpuPaintRequest | DocumentPaintRequest | StaffPaintRequest;
/** 同步入口收的请求（排版不等资源的两路）。 */
export type SyncPaintRequest = JianpuPaintRequest | DocumentPaintRequest;
export type LoadOutcome = "committed" | "superseded";

export interface PreparedResources {
  /** SMuFL 元数据（延长号、跳转记号的包围盒）。简谱这一路缺了只在用到那几个记号时报错。 */
  readonly smuflMeta: MetaData | undefined;
}

/** 排版资源。字体测量沿用 `Font` 自己的机制，这里只管 SMuFL 元数据。
 *  `fixed` = 调用方手里已有（App 构造时就拿到了），同步入口随时可用；`shared` = 首次异步加载、失败不缓存。 */
export class PaintResources {
  private _ready: PreparedResources | null;
  private _pending: Promise<PreparedResources> | null = null;

  private constructor(ready: PreparedResources | null) {
    this._ready = ready;
  }

  static fixed(smuflMeta?: MetaData): PaintResources {
    return new PaintResources({ smuflMeta });
  }

  static shared(): PaintResources {
    return new PaintResources(null);
  }

  /** 已就绪则同步给出，否则 null。同步排版入口只经它取资源。 */
  ready(): PreparedResources | null {
    return this._ready;
  }

  prepare(): Promise<PreparedResources> {
    if (this._ready) return Promise.resolve(this._ready);
    return (this._pending ??= MetaData.shared().then(
      (smuflMeta) => (this._ready = { smuflMeta }),
      (e: unknown) => {
        this._pending = null;
        throw e;
      },
    ));
  }
}

/** 按设置新造一份简谱引擎（选项是单向覆写的，每次排版都要一份干净的）。 */
export function jianpuLayoutOf(cfg: JianpuConfig, res: PreparedResources): Layout {
  const layout = new Layout(cfg.style ? jianpuFontSize(cfg.style) : cfg.fontSize ?? 28);
  const opt = layout.options;
  if (res.smuflMeta) opt.smuflMeta = res.smuflMeta;
  if (cfg.style) applyJianpuStyle(opt, cfg.style);
  if (cfg.ink !== undefined) opt.color = cfg.ink;
  if (cfg.lyricStack !== undefined) opt.lyricStack = cfg.lyricStack;
  return layout;
}

/** 自然量宽：整首排成一条（分行之前）量每个和弦的横向区间，不分页、不产 DOM。
 *  直接复用 `Layout.measureNatural`，`spans` 的键就是输入的 `JChord`。 */
export function measureJianpu(
  score: JScore,
  width: number,
  cfg: JianpuConfig,
  res: PreparedResources,
): ReturnType<Layout["measureNatural"]> {
  return jianpuLayoutOf(cfg, res).measureNatural(score, width);
}

// ---------------------------------------------------------------- 排版器

/** 五线谱 / 混排提交的状态。 */
interface StaffState {
  score: StaffLayout;
  pages: Group[];
  placed: { sys: Sys; page: number; top: number }[];
}

const isStaffRequest = (r: PaintRequest): r is StaffPaintRequest => r.view === "staff" || r.view === "mixed";
const isDocumentRequest = (r: PaintRequest): r is DocumentPaintRequest => r.view === "original" && "doc" in r;

/** 可视化编辑选中挂在音符上的子项的角色（两路页面树的类名不同，映射见 `partClass`）。 */
export type VisualPartRole = "aug-dot" | "harmony" | "deco" | "annotation";

const defaultStaffStyle = (): StyleSheet => computeStyleForPaper([THEMES.staff], { engine: "staff" });

/** 五线谱 / 混排的排版选项：按样式表（缺省取内置 `staff` 主题）灌好，纸与小节号由请求再覆写。 */
export function staffOptionsOf(meta: MetaData, style?: StyleSheet): MixedOptions {
  const options = new MixedOptions(meta);
  applyStaffStyle(options, style ?? defaultStaffStyle());
  return options;
}

export class ScorePainter {
  /** 最近一次提交的简谱引擎（成书、PPTX、脚本读它的页面树与选项）。五线谱结果提交时保留不动。 */
  layout: Layout = new Layout(28);
  /** 最近一次提交的简谱引擎输入（标题、导出 PPTX 用）。五线谱结果提交时保留不动。 */
  score: JScore = emptyScore();
  /** 最近一次提交的简谱档；还没排过简谱为 null。 */
  jianpuView: "original" | "expanded" | null = null;
  pageWidth = 0;
  pageHeight = 0;
  /** 当前结果。null = 还没排过。 */
  result: LayoutResult | null = null;
  /** PageItem -> rendered <g>, populated each renderPage (for DOM picking). */
  nodeMap = new WeakMap<PageItem, SVGGElement>();
  /** 元素 id → 它的音符格（每遍/每段各一个），试听高亮与起播点用。 */
  private chordItem = new Map<ElementId, { page: number; item: PageItem; verse: number }[]>();
  private highlighted: PageItem[] = [];
  /** 逐页高度。空 = 各页同高（`pageHeight`）；连续长纸那一档按内容逐页给。 */
  private pageHeights: number[] = [];
  private staff: StaffState | null = null;
  /** 原样文档这一路提交的结果（页面、定位结构与 note / syllable 身份索引）。与 staff 互斥。 */
  private original: OriginalDocumentLayout | null = null;
  private version = 0;

  constructor(readonly resources: PaintResources = PaintResources.shared()) {}

  /** 当前结果是哪一路画的。 */
  get renderer(): "jianpu" | "staff" | null {
    return this.staff ? "staff" : this.result ? "jianpu" : null;
  }

  /** 排版并提交。资源等待后与提交前各核一次版本：期间来了新请求就丢掉这份（`superseded`），
   *  不边算边改当前结果；最新请求失败则抛出、保留上次成功的结果。 */
  async load(request: PaintRequest): Promise<LoadOutcome> {
    const v = ++this.version;
    const res = await this.resources.prepare();
    if (v !== this.version) return "superseded";
    let commit: () => void;
    try {
      if (isStaffRequest(request)) {
        const meta = res.smuflMeta ?? (await MetaData.shared());
        if (v !== this.version) return "superseded";
        commit = this._staffCommit(request, meta);
      } else {
        commit = this._syncCommit(request, res);
      }
    } catch (e) {
      if (v !== this.version) return "superseded";
      throw e;
    }
    if (v !== this.version) return "superseded";
    commit();
    return "committed";
  }

  /** 资源已就绪时同步排版并提交（编辑器预览的简谱路与原样文档、成书、帮助、量断行）。也作废在途的异步请求。 */
  loadSync(request: SyncPaintRequest): void {
    const res = this.resources.ready();
    if (!res) throw new Error("排版资源还没准备好");
    ++this.version;
    this._syncCommit(request, res)();
  }

  private _syncCommit(request: SyncPaintRequest, res: PreparedResources): () => void {
    return isDocumentRequest(request) ? this._documentCommit(request) : this._jianpuCommit(request, res);
  }

  /** 让未完成的请求作废，放掉持有的 DOM 引用。 */
  dispose(): void {
    ++this.version;
    this.nodeMap = new WeakMap();
    this.chordItem.clear();
    this.highlighted = [];
    this.original = null;
  }

  /** 简谱引擎这一路：在局部变量里排完，返回提交动作。 */
  private _jianpuCommit(req: JianpuPaintRequest, res: PreparedResources): () => void {
    const layout = jianpuLayoutOf(req, res);
    let w: number;
    let h: number;
    let pageHeights: number[] = [];
    if (req.view === "expanded") {
      w = req.style?.page.w ?? 960;
      h = req.style?.page.h ?? 540;
      layoutExpandedPages(layout, req.score, w, h, req.breakDesc);
    } else {
      w = req.page?.w ?? 0;
      h = req.page?.h ?? 0;
      if (req.snippet) {
        layout.fromScore(req.score, req.breakDesc, w, h);
        layout.pages[0]?.update();
      } else {
        pageHeights = layoutOriginalPages(layout, req.score, w, h, req.breakDesc);
      }
    }
    const pages: LayoutPage[] = layout.pages.map((root, i) => ({
      root,
      geometry: pageGeometry(w, pageHeights[i] ?? h, 1),
      renderer: "jianpu",
      songIndexes: [0],
    }));
    const result: LayoutResult = {
      title: req.score.title,
      pages,
      hits: [],
      diagnostics: [],
      staffPlacements: [],
      jianpuLineStarts: [...layout.lineStarts],
    };
    return () => {
      this.layout = layout;
      this.score = req.score;
      this.jianpuView = req.view;
      this.pageWidth = w;
      this.pageHeight = h;
      this.pageHeights = pageHeights;
      this.staff = null;
      this.original = null;
      this.result = result;
      this.nodeMap = new WeakMap();
      this.buildChordIndex();
    };
  }

  /** 原样文档这一路：整份文档排好（不等资源，`Font` 同步量字），返回提交动作。
   *  简谱引擎的 `layout` / `score` 保留不动（标题等取用）；`jianpuView` 记成原样档，PPTX 因此不会拿旧引擎页复用。 */
  private _documentCommit(req: DocumentPaintRequest): () => void {
    const r = layoutOriginalDocument(req.doc, {
      user: req.style ? puUserOptionsOf(req.style) : null,
      ink: req.style?.page.ink ?? null,
    });
    const result: LayoutResult = {
      title: r.view.songs[0]?.metadata.titles[0] ?? "",
      pages: r.pages.map((root, i) => ({
        root,
        geometry: pageGeometry(r.width, r.height, 1),
        renderer: "jianpu",
        songIndexes: [r.placed.pages[i]?.song ?? 0],
      })),
      hits: [],
      diagnostics: [],
      staffPlacements: [],
      jianpuLineStarts: null,
    };
    return () => {
      this.original = r;
      this.staff = null;
      this.jianpuView = "original";
      this.pageWidth = r.width;
      this.pageHeight = r.height;
      this.pageHeights = [];
      this.result = result;
      this.nodeMap = new WeakMap();
      this.chordItem.clear();
      this.highlighted = [];
    };
  }

  /** 五线谱 / 混排这一路：读谱 → 排页，返回提交动作。 */
  private _staffCommit(req: StaffPaintRequest, meta: MetaData): () => void {
    const options = staffOptionsOf(meta, req.style);
    options.hideBarNumber = req.hideBarNumber;
    options.page = req.page;
    const score = layoutStaff(req.doc, options);
    const { pages, placed } = layoutStaffPages(score, req.view === "mixed");
    const d = score.defaults;
    const wT = d.pageWidth ?? 1200;
    const hT = d.pageHeight ?? PAGE_HEIGHT_FALLBACK;
    const result: LayoutResult = {
      title: score.title,
      pages: pages.map((root) => ({ root, geometry: pageGeometry(wT, hT, score.scaling), renderer: "staff", songIndexes: [0] })),
      hits: [],
      diagnostics: [],
      staffPlacements: [{ songIndex: 0, score, systems: placed }],
      jianpuLineStarts: null,
    };
    return () => {
      this.staff = { score, pages, placed };
      this.original = null;
      this.result = result;
      this.nodeMap = new WeakMap();
      this.chordItem.clear();
      this.highlighted = [];
    };
  }

  /** 当前结果的曲名（导出文件名取首行）。 */
  get title(): string {
    return this.result?.title ?? this.score.title;
  }

  /** 当前结果是不是原样文档这一路排的（按源行排，没有几何拾取；面板按它摆原样档的设置）。 */
  get isDocumentLayout(): boolean {
    return this.original !== null;
  }

  /** 原样文档这一路音符数字的字号（pt），面板「基础字号」显示它；别的路为 null。 */
  get documentDigitFontSize(): number | null {
    return this.original?.digitFontSize ?? null;
  }

  /** 原样文档这一路定稿的度量（方言版式 + 谱内指令 + 面板那层；样式快照脚本核对用）；别的路为 null。 */
  get documentMetrics(): PuMetrics | null {
    return this.original?.metrics ?? null;
  }

  /** 原样文档的定位结构（回归脚本核对几何用）；别的路为空。 */
  placedPages(): PlacedPage[] {
    return this.original?.placed.pages ?? [];
  }

  /** 原样文档按播放顺序列出全部音符的 id（第一声部为主旋律）；别的路为空。 */
  playbackNotes(): ElementId[] {
    const r = this.original;
    const out: ElementId[] = [];
    for (const page of r?.placed.pages ?? []) {
      for (const group of page.groups) {
        const voice = group.voices[0];
        if (!voice) continue;
        for (const it of voice.items) {
          const id = it.element.kind === "note" ? r!.view.idOf.get(it.element) : undefined;
          if (id !== undefined) out.push(id);
        }
      }
    }
    return out;
  }

  /** 五线谱排好的版面与各系统落位（MusicXML 布局导出写版面坐标用，`mixed/engrave.ts`）。 */
  get staffPlacement(): LayoutResult["staffPlacements"][number] | null {
    return this.result?.staffPlacements[0] ?? null;
  }

  /** 逐页走一遍页面树，把每个和弦的元素 id 对到它的音符格上。 */
  private buildChordIndex(): void {
    this.chordItem.clear();
    this.highlighted = [];
    const walk = (item: PageItem, page: number): void => {
      if (item.data instanceof NoteEntry) {
        const id = item.data.chord?.id;
        if (id !== null && id !== undefined) {
          const list = this.chordItem.get(id) ?? [];
          list.push({ page, item, verse: item.data.verse });
          this.chordItem.set(id, list);
        }
      }
      for (const c of item.children) walk(c, page);
    };
    this.layout.pages.forEach((pg, i) => walk(pg, i));
  }

  /** 某个和弦在第几遍的音符格（找不到那一遍就取第一个）。 */
  private hitFor(id: ElementId, pass: number): { page: number; item: PageItem } | null {
    const list = this.chordItem.get(id);
    if (!list || list.length === 0) return null;
    return list.find((h) => h.verse === pass) ?? list[0];
  }

  /** 元素 `id` 的音符格：简谱引擎按第 `pass` 遍（找不到那一遍取第一个），原样文档一个元素只画一次。 */
  private noteHit(id: ElementId, pass = 0): { page: number; item: PageItem } | null {
    if (this.original) return this.original.noteItems.get(id) ?? null;
    return this.hitFor(id, pass);
  }

  private elsOf(items: readonly PageItem[]): SVGGElement[] {
    return items.flatMap((it) => {
      const el = this.nodeMap.get(it);
      return el ? [el] : [];
    });
  }

  /** 播放高亮元素 `id` 第 `pass` 遍的音（先清掉上一处；null = 只清）。返回所在页。
   *  简谱引擎按遍次取音符格（歌词收在格里一并亮）；原样文档亮音符与第 `pass - 1` 段（0 起）的那个歌词音节。 */
  highlight(id: ElementId | null, pass = 0): number | null {
    for (const item of this.highlighted) this.nodeMap.get(item)?.classList.remove("playing");
    this.highlighted = [];
    if (id === null) return null;
    const hit = this.noteHit(id, pass);
    if (!hit) return null;
    const targets: PageItem[] = [hit.item];
    const syl = this.original?.syllableItems.get(`${id}:${Math.max(0, pass - 1)}`);
    if (syl) targets.push(syl.item);
    for (const item of targets) {
      this.nodeMap.get(item)?.classList.add("playing");
      this.highlighted.push(item);
    }
    return hit.page;
  }

  /** 元素 `id` 第一次出现在第几页（光标同步翻页用）；没画出来为 null。 */
  pageOf(id: ElementId): number | null {
    return this.noteHit(id)?.page ?? null;
  }

  /** 元素 `id` 第 `pass` 遍那个音的 `<g>`（点选、滚动到可见用）；没画出来为 null。 */
  entryEl(id: ElementId, pass = 0): SVGGElement | null {
    const hit = this.noteHit(id, pass);
    return hit ? this.nodeMap.get(hit.item) ?? null : null;
  }

  /** 元素 `id` 第 `verse` 段（行内 0 起）歌词的那个字的 `<g>`；`verseNo` 是源段号（缺省 = verse + 1）。
   *  原样文档一段一个音节；简谱引擎的音符格把各段歌词收在同一个 `<g>` 里，按段号取这一段自己的那个字，
   *  取不到（格里没有歌词图元）就退回整个音符格。 */
  lyricEl(id: ElementId, verse = 0, verseNo?: number): SVGGElement | null {
    if (this.original) {
      const hit = this.original.syllableItems.get(`${id}:${verse}`);
      return hit ? this.nodeMap.get(hit.item) ?? null : null;
    }
    const ls = this.cellLyrics(id, verse);
    const one = ls.find((l) => l.verse === (verseNo ?? verse + 1)) ?? (ls.length === 1 ? ls[0] : undefined);
    return one ? one.el : this.entryEl(id, verse);
  }

  /** 收在元素 `id` 音符格里的各段歌词 `<g>`（只亮音符时要把它们摘出来）。原样文档的歌词不在格里，为空。 */
  cellLyricEls(id: ElementId): SVGGElement[] {
    return this.original ? [] : this.cellLyrics(id, 0).map((l) => l.el);
  }

  /** 元素 `id` 第 `pass` 遍那个音符格里各段歌词的 `<g>` 与段号（`Lyric.verse`）。 */
  private cellLyrics(id: ElementId, pass: number): { el: SVGGElement; verse: number }[] {
    const hit = this.hitFor(id, pass);
    if (!hit) return [];
    return findByClass(hit.item, "lyric").flatMap((it) => {
      const el = this.nodeMap.get(it);
      return el ? [{ el, verse: it instanceof Lyric ? it.verse : 0 }] : [];
    });
  }

  /** 两路页面树给子项的类名：原样文档画和弦名 `chord`、`&xx` 记号 `ornament`、注记 `annotation`；
   *  简谱引擎是和弦名 `chord-group`、装饰 `artic`，注记没有独立图元。附点两路都是 `aug-dot`。 */
  private partClass(role: VisualPartRole): string | null {
    const doc = this.original !== null;
    switch (role) {
      case "aug-dot": return "aug-dot";
      case "harmony": return doc ? "chord" : "chord-group";
      case "deco": return doc ? "ornament" : "artic";
      case "annotation": return doc ? "annotation" : null;
    }
  }

  /** 元素 `id` 音符格里某角色子项的 `<g>`，按页面树顺序（可视化编辑选中附点与挂在音符上的记号）。 */
  partEls(id: ElementId, role: VisualPartRole, pass = 0): SVGGElement[] {
    const cls = this.partClass(role);
    const hit = cls ? this.noteHit(id, pass) : null;
    return hit && cls ? this.elsOf(findByClass(hit.item, cls)) : [];
  }

  /** 页眉里画出来的东西（标题、署名、调号拍号）：`<g>`、所画的字、是不是调号拍号。可视化编辑按字对回原文字段。 */
  headerParts(): HeaderPart[] {
    return this.staff ? [] : headerPartsOf(this.result?.pages.map((p) => p.root) ?? [], this.nodeMap);
  }

  // ---------------- SVG rendering ----------------

  /** 第 `pageIndex` 页渲染成独立的 `<svg>`（viewBox 是原生坐标：简谱排版单位 / 五线谱 tenths）。 */
  renderPage(pageIndex: number): SVGSVGElement {
    if (this.staff) {
      const page = this.result?.pages[pageIndex];
      if (!page) throw new Error(`ScorePainter: 没有第 ${pageIndex + 1} 页`);
      const { w, h } = page.geometry.viewBox;
      return renderPageSvg(page.root, w, h, { cls: "score-page mixed-page", visitor: mixedVisitor });
    }
    const page = this.result?.pages[pageIndex];
    if (!page) throw new Error(`ScorePainter: 没有第 ${pageIndex + 1} 页`);
    const { w, h } = page.geometry.viewBox;
    return renderPageSvg(page.root, w, h, this.nodeMap);
  }

  /** Walk up from a picked item to its enclosing "entry" group (else the item). */
  entryGroupOf(item: PageItem): PageItem {
    let cur: PageItem | null = item;
    while (cur) {
      if (cur.classes.has("entry")) return cur;
      cur = cur.parent;
    }
    return item;
  }

  get pageCount(): number {
    return this.result?.pages.length ?? 0;
  }

  /** 第 `index` 页的物理尺寸（pt）。简谱排版单位就是 pt；五线谱按谱里的 scaling 从 tenths 换算。 */
  pageSize(index: number): { w: number; h: number } {
    const g = this.result?.pages[index]?.geometry ?? this.result?.pages[0]?.geometry;
    if (g) return { ...g.sizePt };
    return { w: this.pageWidth, h: this.pageHeights[index] ?? this.pageHeight };
  }

  // ---------------- picking (Phase 3) ----------------

  private calcDist(x: number, y: number, inn: Rect): number {
    let dx = 0;
    if (x < inn.left) dx = inn.left - x;
    else if (x > inn.right) dx = x - inn.right;
    let dy = 0;
    if (y < inn.top) dy = inn.top - y;
    else if (y > inn.bottom) dy = y - inn.bottom;
    return dx + dy;
  }

  pick(root: PageItem, x: number, y: number): [PageItem | null, number] {
    let bnd = root.bound;
    bnd = bnd.offset(root.x, root.y);
    const edge = 5;
    const dist = this.calcDist(x, y, bnd);
    if (root.children.length === 0) {
      let outer = new Rect(bnd.left, bnd.top, bnd.right, bnd.bottom);
      const dx = Math.min(bnd.width - edge * 2, 0) / 2;
      const dy = Math.min(bnd.height - edge * 2, 0) / 2;
      outer = outer.inset(dx, dy);
      return outer.contains(x, y) ? [root, dist] : [null, dist];
    }
    let outer = new Rect(bnd.left, bnd.top, bnd.right, bnd.bottom);
    outer = outer.inset(-edge, -edge);
    if (outer.contains(x, y)) {
      const xx = x - bnd.left;
      const yy = y - bnd.top;
      const items: PageItem[] = [];
      let minDist = Number.MAX_VALUE;
      let best: PageItem | null = null;
      let small: PageItem | null = null;
      for (const ch of root.children) {
        const [p, pd] = this.pick(ch, xx, yy);
        if (p !== null) {
          if (pd < minDist) {
            best = p;
            minDist = pd;
            items.length = 0;
            items.push(p);
          }
          if (pd === minDist) items.push(p);
          if (ch.bound.width < edge || ch.bound.height < edge) small = ch;
        }
      }
      if (small !== null) return [small, 0];
      let area = Number.MAX_VALUE;
      for (const it of items) {
        const a = it.bound.width * it.bound.height;
        if (a < area) {
          best = it;
          area = a;
        }
      }
      return [best, minDist];
    }
    return [null, Number.MAX_VALUE];
  }

  /** 页面 pt 坐标处的图元（简谱引擎这一路；五线谱与原样文档没有几何拾取，后者靠事件冒泡找 `<g>`）。
   *  `target` 是它所在音符格的元素，页眉等为 null。 */
  pickPage(page: number, pointPt: { x: number; y: number }): LayoutHit | null {
    const lp = this.result?.pages[page];
    if (!lp || lp.renderer !== "jianpu" || this.original) return null;
    const pos = fromPt(lp.geometry, pointPt.x, pointPt.y);
    const [item] = this.pick(lp.root, pos.x, pos.y);
    if (!item) return null;
    const entry = this.entryGroupOf(item).data;
    const id = entry instanceof NoteEntry ? entry.chord?.id : undefined;
    const target: PaintTarget | null = entry instanceof NoteEntry && id !== null && id !== undefined
      ? { kind: "element", songIndex: 0, id, occurrence: entry.verse }
      : null;
    return { target, pageIndex: page, item, boundsPt: absBounds(item, lp.geometry.ptPerUnit), layer: "jianpu" };
  }
}

/** 图元在页上的包围盒（pt）：沿父链累加各级 x/y 偏移（简谱这一路的页面树不带旋转缩放）。 */
function absBounds(item: PageItem, ptPerUnit: number): { x: number; y: number; w: number; h: number } {
  let x = item.bound.left;
  let y = item.bound.top;
  for (let cur: PageItem | null = item; cur; cur = cur.parent) {
    x += cur.x;
    y += cur.y;
  }
  return { x: x * ptPerUnit, y: y * ptPerUnit, w: item.bound.width * ptPerUnit, h: item.bound.height * ptPerUnit };
}
