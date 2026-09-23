// 样式表：一份谱「长什么样」的唯一描述。四把尺子（简谱 `LayoutOptions`、文本谱 `PuMetrics`、
// 成书 `BookStyle`、五线谱 `MixedOptions`）都由适配器从这里取值，见 `style/jianpu.ts` 等。
//
// 形状对着 CSS：角色（选择器）→ 声明块；级联见 `cascade.ts`，命名主题见 `themes.ts`，单位见 `units.ts`。
// **各尺子实测来的常量不搬进来**：它们的公式留在适配器里，主题只选 `preset`，再叠 `overrides`。
// 常量改存比例会出浮点尾差（`em/20` 与 `em*0.05` 在 28 上差一个 ulp），几何基线就破了。
//
// 无 DOM 依赖（Node CLI 与浏览器两侧都要 import）。
import type { BookStyle } from "../pdflayout/bookstyle";
import type { TemplateSheet } from "./jpcss";
import type { Length } from "./units";

/** 版面角色。成书那一路的判定依据是 PageSpec 的字段位置（见 pdflayout/stats.ts）。 */
export type StyleRole =
  | "title" // 歌曲标题（原书是魏碑类，与歌词的宋体不是一套）
  | "songNumber" // 曲号 028 / J07
  | "category" // 分类词
  | "credit" // 词曲署名
  | "keyMeter" // 「1=F 4/4」
  | "note" // 音符数字（**em 基准**）
  | "tuplet" // 三连音数字、上标小字
  | "verseNum" // 段号
  | "chord" // 和弦符号
  | "lyric" // 主歌词
  | "lyric2" // 次号歌词
  | "sectionWord" // 段落词（副歌…）
  | "story" // 花边框内的注解正文
  | "toc" // 目录/索引正文
  | "tocHeading" // 目录里的一级分类标题
  | "tocSub" // 目录里的二级小标题
  | "frontTitle" // 扉页/前言/索引的页题（「附 录」「诗题笔划索引」）
  | "header" // 页眉
  | "footer" // 页码
  | "smufl"; // SMuFL 记号（延长号、跳转记号…）

export const STYLE_ROLES: StyleRole[] = [
  "title",
  "songNumber",
  "category",
  "credit",
  "keyMeter",
  "note",
  "tuplet",
  "verseNum",
  "chord",
  "lyric",
  "lyric2",
  "sectionWord",
  "story",
  "toc",
  "tocHeading",
  "tocSub",
  "frontTitle",
  "header",
  "footer",
  "smufl",
];

/** 只有歌本模板（`template.ts`）用的角色。不进 `StyleRole`：成书的 `BookStyle.roles` 是按 `StyleRole`
 *  穷举的，加进去就得给成书也配一份。解析期与 `STYLE_ROLES` 一起当合法角色名。 */
export const TEMPLATE_ROLES = ["titleAlt", "scripture", "scriptureRef", "rights", "relatedScriptures", "tags"] as const;

/** 一个具名字体。间接一层（角色引用字体名）是为了让同一 face 只嵌一次子集。 */
export interface FontRef {
  /** CSS font-family，浏览器排版用。 */
  family: string;
  /** 出 PDF 时怎么落字：
   *  - `font`（默认）嵌字体、写文字，可选中可搜索
   *  - `path` 转成轮廓路径画。给那些**子集化后不合规**的字体用
   *    （pdf-lib 的 CFF 子集 poppler/pdfjs 都认不出来，魏碑标题就是这种），
   *    可见层照样是原字体的面貌，搜索由隐藏文字层兜。 */
  mode?: "font" | "path";
  /** 字体文件路径；缺省时由 scripts/fontres.mjs 按 family 在系统字体目录里查。 */
  file?: string;
  /** .ttc 里的子字体名（如 "Songti SC Regular"）。 */
  face?: string;
  bold?: boolean;
}

/** 逐字定位的口径。原件量到的 x 是**墨迹左缘**，而 PDF 的 drawText 用的是**笔位**，
 *  换字体/字号后两者的差会系统化，所以每个角色都要说清按什么对齐。 */
export type AlignMode =
  | "pen" // 笔位已经算好（B 路：浏览器实测的逐字 advance），直接用
  | "inkCenter" // 墨迹居中：逐字方格定位的（歌词/音符/和弦）
  | "left" // 整 run 一次输出、左对齐（连排文字，PDF 里才搜得出词）
  | "center" // 整 run 居中（标题）
  | "right"
  | "outer"; // 贴版心外缘（按页奇偶换边）

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** 角色的声明块。**字号是 font-size**（不是墨迹高；成书也一样）。
 *  `note.size` 只收 pt 或 sp（em 相对它自己，没有意义）。 */
export interface RoleDecl {
  size?: Length;
  color?: number;
  /** 以下由歌本 `.jpcss` 写（docs/格式/jpcss.md §3）：模板排版（`template.ts`）读，
   *  尺子那边由 `style/keys.ts::ROLE_FONTS` 对到各自的字体字段（`note` → 简谱数字、`smufl` → 记号…）。
   *  对齐由槽位（`left`/`center`/`inner`…）决定，不在角色上写。 */
  font?: string;
  family?: string;
  weight?: string;
  features?: string;
  /** 成书：逐字定位的口径（`align-mode: ink-center`），见 `AlignMode`。 */
  alignMode?: AlignMode;
  /** 成书：基线修正（× 字号），见 `pdflayout/bookstyle.ts::RoleStyle.baselineAdjust`。 */
  baselineAdjust?: number;
}

/** 纸张名（`PAPER_SIZES` 的键，「长图」是其中一档）或投影片尺寸。 */
export interface PageDecl {
  /** 实际纸张（原样档、五线谱/混排）。与 `w`/`h` 二选一：给了 paper 就按纸走；
   *  `style/paper.ts::CUSTOM_PAPER`（「自定义」）时尺寸在 `w`/`h`（谱里自带的非标准纸）。 */
  paper?: string;
  /** 纸的方向。缺省竖放；横放 = 宽高对调（`style/paper.ts::resolvePaper`）。 */
  orientation?: "portrait" | "landscape";
  /** 投影片尺寸（展开档，pt）。 */
  w?: number;
  h?: number;
  /** 前景色（谱面笔画与文字），ARGB。 */
  ink?: number;
  /** 背景色（纸），ARGB。**唯一四档通吃**：它铺的是纸不是谱，排版器不认识它。 */
  background?: number;
  /** 歌本的纸：`size: 宽 高`（混排歌本是 tenths，成书是 pt）。 */
  size?: number[];
  /** 页边距：一个数（四边同）或 `上 外 下 内`（成书，配 `mirror`）；编辑器是 `上 右 下 左`（pt）。 */
  margin?: number | number[];
  /** 对开页镜像：奇数页内侧（装订边）在左。 */
  mirror?: boolean;
}

/** 简谱引擎（`LayoutOptions`）的预设。公式在 `style/jianpu.ts`。 */
export type JianpuPreset = "default" | "original" | "pptx" | "book";

export interface StyleSheet {
  roles: Partial<Record<StyleRole, RoleDecl>>;
  page: PageDecl;
  /** **简谱内容**（各模式通用）：`overrides` 的键是 `style/keys.ts::JIANPU_KEYS` 的逻辑键，
   *  纯简谱那几档落 `LayoutOptions`、混排落 `MixedOptions` 的简谱层字段，在 preset 之后叠上。 */
  jianpu: { preset?: JianpuPreset; overrides?: Record<string, Length | boolean> };
  /** **五线谱内容**（`mode: staff / mixed`）：键是 `style/keys.ts::STAFF_KEYS` 的逻辑键，落 `MixedOptions`
   *  （tenths）。长度只收 em / sp——pt 要等 MusicXML 的 `<scaling>`。 */
  staff: { preset?: "musicpp"; overrides?: Record<string, Length | boolean> };
  /** **断句**（与谱式无关）：键是 `style/keys.ts::BREAK_KEYS`。现在只有成书读。 */
  break?: { overrides?: Record<string, Length | boolean> };
  /** 成书的完整样式（`BookStyle`）。只有 `engine: "book"` 用。 */
  book?: BookStyle;
  /** 歌本模板：区域、装页、具名字体（`.jpcss` 的 `@template`/`@flow`/`@font-face`）。 */
  template?: TemplateSheet;
}

export function emptySheet(): StyleSheet {
  return { roles: {}, page: {}, jianpu: {}, staff: {} };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 深合并（数组整体替换，与 JSON 配置的直觉一致）。不改入参。 */
export function mergeStyle<T>(base: T, patch: DeepPartial<T> | undefined | null): T {
  if (patch === undefined || patch === null) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeStyle(out[k], v as never) : v;
  }
  return out as T;
}
