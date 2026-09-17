// 简谱引擎那把尺子的适配器：computed `StyleSheet` → `LayoutOptions`。
//
// 契约（沿用原来两个「样式表应用器」的）：**painter 构造之后、`resize` 之前调**；构造字号取 `jianpuFontSize`。
// 只改常量的来源，不动 layout.ts 的算法——`jpDotRung` / `jpStaffTop` 那些都是 getter，覆写字段就全局生效。
//
// 顺序：前景色 / 标题 / 词曲字号 → 预设（`jianpu.preset`）→ 角色字体 → `jianpu.overrides`。
// 预设里的公式**原样保留**（常量改存比例会出浮点尾差，见 sheet.ts 头注释）。
import type { LayoutOptions } from "../layout/options";
import { Font } from "../layout/font";
import { LYRIC_STACK_RATIO } from "../layout/painter";
import { applyBookPreset } from "./book";
import { familyOfRole } from "./fonts";
import { JIANPU_KEYS, ROLE_FONTS, type KeyDef } from "./keys";
import type { StyleRole, StyleSheet } from "./sheet";
import { isPagedSheet, PPTX_PAGE } from "./themes";
import { resolveLength } from "./units";

/** 原样档标题/词曲字号 ÷ 基础字号。取出厂那三个数的比（48/28、36/28）——
 *  那一档不单独设标题与词曲，字号一改整块跟着缩放，观感与出厂值一致。 */
const TITLE_RATIO = PPTX_PAGE.titleSize / PPTX_PAGE.fontSize;
const CREDIT_RATIO = PPTX_PAGE.creditSize / PPTX_PAGE.fontSize;

/** 角色字号（pt）。只认 pt——note 是 em 的基准，不能相对自己。 */
function rolePt(sheet: StyleSheet, role: "note" | "title" | "credit"): number | undefined {
  const v = sheet.roles[role]?.size;
  if (v === undefined) return undefined;
  const pt = resolveLength(v, { em: NaN, sp: NaN });
  return pt !== null && Number.isFinite(pt) && pt > 0 ? pt : undefined;
}

/** 排版器的构造字号。成书取歌词那一档，其余取音符字号。 */
export function jianpuFontSize(sheet: StyleSheet): number {
  if (sheet.jianpu.preset === "book" && sheet.book) return sheet.book.roles.lyric.size;
  return rolePt(sheet, "note") ?? PPTX_PAGE.fontSize;
}

/** 原样档是不是长图。判据与 `@media (paged: …)` 共用一处（`themes.ts::isPagedSheet`）。 */
export function isLongImage(sheet: StyleSheet): boolean {
  return !isPagedSheet(sheet);
}

/** 字号标题、词曲的实际值：给了就用；原样档没给就按出厂比例派生。 */
export function jianpuSizes(sheet: StyleSheet): { fontSize: number; titleSize: number; creditSize: number } {
  const fontSize = jianpuFontSize(sheet);
  return {
    fontSize,
    titleSize: rolePt(sheet, "title") ?? Math.round(fontSize * TITLE_RATIO),
    creditSize: rolePt(sheet, "credit") ?? Math.round(fontSize * CREDIT_RATIO),
  };
}

export function applyJianpuStyle(opt: LayoutOptions, sheet: StyleSheet): void {
  const preset = sheet.jianpu.preset ?? "default";
  if (preset === "book") {
    if (!sheet.book) throw new Error("book 预设缺 BookStyle");
    applyBookPreset(opt, sheet.book);
  } else {
    if (sheet.page.ink !== undefined) opt.color = sheet.page.ink;
    if (preset !== "default") {
      const s = jianpuSizes(sheet);
      opt.titleSize = s.titleSize;
      opt.creditSize = s.creditSize;
    }
    if (preset === "original") applyOriginalPreset(opt, isLongImage(sheet));
    else if (preset === "pptx") applyPptxPreset(opt);
  }
  applyFonts(opt, sheet);
  applyOverrides(opt, sheet);
}

/** 角色 → 字体族与字重（`note` → 数字、`lyric` → 歌词、`smufl` → 记号）。
 *  **字号不动**：这一路的字号由 `jianpuFontSize` 定、`applyFontSize` 还要由它派生一串间距。 */
function applyFonts(opt: LayoutOptions, sheet: StyleSheet): void {
  const rec = opt as unknown as Record<string, unknown>;
  for (const [role, def] of Object.entries(ROLE_FONTS)) {
    const field = def.layout;
    if (!field) continue;
    const f = familyOfRole(sheet, role as StyleRole);
    if (!f) continue;
    const base = rec[field] as Font;
    rec[field] = new Font(f.family || base.family, base.size, f.bold || base.bold, base.italic);
  }
}

/** `@jianpu` / `@staff` 的逻辑键 → `LayoutOptions` 的字段（`style/keys.ts` 的 `layout` 一列）。
 *  em = 音符字号，sp = 名义谱高 / 3（简谱的名义谱高是默认小节线跨度 4/3 字号，不随 `jpStaffTopOverride` 变）。 */
function applyOverrides(opt: LayoutOptions, sheet: StyleSheet): void {
  const em = opt.numberSize;
  const ctx = { em, sp: em / 3 };
  applyBlock(opt, sheet.jianpu.overrides, JIANPU_KEYS, "jianpu", ctx);
}

function applyBlock(
  opt: LayoutOptions,
  ov: Record<string, unknown> | undefined,
  table: Record<string, KeyDef>,
  block: string,
  ctx: { em: number; sp: number },
): void {
  if (!ov) return;
  const rec = opt as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(ov)) {
    const def = table[k];
    if (!def) {
      console.warn(`样式 @${block} 的 ${k}：认不出的键，忽略`);
      continue;
    }
    if (!def.layout) {
      console.warn(`样式 @${block} 的 ${k}：纯简谱不支持${def.note ? `（${def.note}）` : ""}，忽略`);
      continue;
    }
    if (def.kind === "bool") {
      if (typeof v === "boolean") rec[def.layout] = v;
      else console.warn(`样式 @${block} 的 ${k}：开关只收 true / false，${JSON.stringify(v)} 忽略`);
      continue;
    }
    if (def.kind === "word") {
      if (typeof v === "string") rec[def.layout] = v;
      else console.warn(`样式 @${block} 的 ${k}：要一个词，${JSON.stringify(v)} 忽略`);
      continue;
    }
    const n = resolveLength(v as never, ctx);
    if (n === null) console.warn(`样式 @${block} 的 ${k}：认不出的长度 ${JSON.stringify(v)}，忽略`);
    else rec[def.layout] = n;
  }
}

/**
 * 「原样」档。按原谱排一遍（`lyricStack > 0`，多段叠在同一条谱行下），标题排在第一页顶上
 * （`bookHead`）——印刷歌本的排法；`longImage` = 一张连续长纸（观感同文本谱的「原版」）。
 */
function applyOriginalPreset(opt: LayoutOptions, longImage: boolean): void {
  opt.lyricStack = opt.lrcFont.size * LYRIC_STACK_RATIO;
  opt.continuousPage = longImage;
  opt.bookHead = true;
}

// 「PPT 版面」档：投影/导出 .pptx 用的那一档，编辑器的**默认档**。
//
// 底子是 2026-08 那次排版重构**之前**的观感（下面 `2a8aa85` 那一段），
// 但已有几处**刻意背离**，都写在各自的赋值旁边：小节线的上下缘改用原样档那一份
// （老档矮三分之一，投影上看不出是小节线）、拍号比例跟着回默认、
// 附点/高音点/低音点三种点统一成同一个半径。回归在 `scripts/pptx-check.mjs`。
//
// 为什么要有这一档：`editor/pptx.ts` 只是序列化器——它把排版好的页面树 1:1 翻成 OOXML
// （1 排版单位 = 1pt），本身没有任何排版参数。于是谱面观感一改，导出的 .pptx 跟着改。
//
// 与「原样」档的另一处分工在 `editor/app.ts::_rebuildPainter`：
// **展开档逐段展开**（一段歌词一遍谱、一屏一段），原样档 `lyricStack > 0`
// **按原谱排一遍**、多段歌词叠在同一条谱行下。
//
// 基准是 `2a8aa85`（「新增 MusicXML 导出」，即观感大改 `29ae9dd` 的父提交）。
// 不取更早的 `9abacb3`（PPTX 导出刚落地那次）是因为两者的**笔画与尺寸完全相同**
// （`git diff 9abacb3 2a8aa85 -- src/layout/` 只有 verse 索引、播放高亮、弱起装载、
// titleSize/creditSize 提成字段这些），而 `2a8aa85` 里已经带上了 `a6a6013` 对 pptx.ts
// 本身的三处修复（字体栈压成单个 DrawingML typeface、noAutofit、无条件给 <a:ea>）。
//
// **不覆写字体与页面尺寸**：字号、纸张、标题/词曲字号由样式表的角色与 page 说了算，
// 这里只固定那些本来就没有 UI 的**笔画类**常量。
function applyPptxPreset(opt: LayoutOptions): void {
  const em = opt.numberSize;

  // 纵向堆叠回到旧式三套步长（数字↔点、点↔弧、三连音各走各的）。见 jpGridLegacy 的注释。
  opt.jpGridLegacy = true;

  // 音符数字**不加粗**：投影那一档的观感是既有的，原样档才照印刷谱加粗。
  opt.noteBold = false;

  // **小节线的上下缘不再覆写**（用户口径：「PPT 模式的小节线有点短，用简谱模式的高度」）。
  // 老展开档是 −23/28 em 与 +5/28 em（合起来正好 1 em），比今天的 −1 em / +1/3 em
  // （合起来 4/3 em）矮三分之一；投影上那截线短得不像小节线。于是 H 回到 4/3 em，
  // 下面的拍号比例也跟着**回默认**——`TIME_SIG_DEFAULTS` 正好是老那四个数的 3/4
  // （0.75/0.1/0.625/0.375 × 3/4 = 0.5625/0.075/0.46875/0.28125），
  // 拍号画出来与老档一模一样，只有小节线变高了。

  // 小节线细线 1.5（今 2）；终止线的粗线 3.5 两版相同，写出来是为了这一档自洽。
  opt.barlineWidth = 1.5;
  opt.finalBarlineWidth = 3.5;

  // 减时线：线宽 1.4（= em/20，同样量自成品；老档 1.25、今默认 1.5）。
  // **第一道的高度与层间步距也改按 2019 年那批成品
  // .pptx 量回来的**（`ppt500/`，28pt 上是 4.667 与 3.267）——原先两者都取 `jpBeamDist`
  // = em/8 = 3.5，减时线贴着数字，投影上看着像粘在音符底下（用户口径：
  // 「减时线离音符太近」）。低音点那一摞按 `jpBeamDist` 让开减时线、
  // 旧式八度点阶梯（`LayoutOptions.jpLegacyDotCenter`）也逐级走它，所以两个数一起改。
  opt.jpBeamWidth = em / 20;
  opt.jpBeamDist = (em * 7) / 60; // 0.11667 em
  opt.jpBeamTop = em / 6;

  // 拍号只留分数线粗细（比例走默认，见上面小节线那一段）。
  opt.timeSigRuleWidth = 1.5;

  // **附点 / 高音点 / 低音点三者同大**（用户口径）。默认两者各按自己那个字形的墨迹高折半
  // （附点照 `·` 是 ⌀4.06 @28pt、八度点照 `.` 是 ⌀3.44），附点明显更胖。
  // 这一档取两者之间的一个整数比例：⌀2r = em/7.5，附点缩一点、八度点放一点。
  opt.octaveDotRadius = em / 15;
  opt.augDotRadius = em / 15;

  // 弧线：旧版厚 4、无描边，且没有高度上下限、没有扁平长连音线——
  // 一律退化成 musicpp 的裸对数公式。
  opt.slurTieThickness = 4;
  opt.slurOutlineWidth = 0;
  opt.slurMaxHeight = 0;
  opt.slurMinHeight = 0;
  opt.slurFlatSpan = -1;
  opt.slurFlatNotes = 0;
  opt.slurFlatRatio = 0;
}
