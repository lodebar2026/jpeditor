// 书籍样式：一本书「长什么样」的完整参数集——页面/版心、各角色的字体与字号、
// 各处间距。**两条重排路唯一共享的东西**：
//
//   A 路（relayout --mode=text，文字原位替换）  位置来自原件 PageSpec，样式来自这里
//   B 路（rebuild，从 musicxml 数据重排）        位置由排版引擎算，样式也来自这里
//
// 值一律由 `stats.ts` 从原书 `pdf-layout.json` 统计**中位数**得来（见 scripts/gen-bookstyle.mjs），
// 不是拍脑袋的常量——「保留原书的字体与间距特征」就落在这里。
//
// 单位约定（**改字段前先看这条**）：
//   - 角色的 `size` 是**字号**（font-size，pt），不是墨迹高。原书只量得到墨迹高，
//     换成字号在生成时做（`stats.ts::inferBookStyle` 的 `inkRatio`，按各角色的样本字实测字体）。
//   - 随字号缩放的量一律存 em（`*Em` 后缀），基准是**音符字号** `roles.note.size`；
//     换字号时版式自动跟随。
//   - 不随字号缩放的量（线宽、点直径、页面尺寸、页边距）存 pt。
//
// 无 DOM 依赖（Node CLI 与浏览器两侧都要 import）。
import { STYLE_ROLES, mergeStyle, type AlignMode, type DeepPartial, type FontRef, type StyleRole } from "../style/sheet";

export interface RoleStyle {
  /** 引用 BookStyle.fonts 的键。 */
  font: string;
  /** 字号（font-size，pt）：同类型字形墨迹高的中位数 ÷ 样本字的墨迹占比（见 `INK_SAMPLE`）。 */
  size: number;
  /** 基线修正（× size）：PageSpec 的 baselineY 是**字形下缘中位数**、不是真基线，
   *  换字体后拉丁/数字行会整体错半个字。由 `scripts/relayout.mjs --calibrate` 标定一次写回。 */
  baselineAdjust: number;
  align: AlignMode;
  color?: number;
}

/** 间距。命名规则：`*Em` 随字号缩放（基准音符字号 roles.note.size；个别项按歌词字号，见 `style/book.ts`），其余为 pt。
 *  每一项的量法见 docs/实现/矢量PDF识别.md 的「重排」一节与 stats.ts 的注释。
 *  **只留排版真正读的量**：原书量到而排版不用的（`ink*` 描边宽、各处到谱行的距离…）只进
 *  `bookstyle-report.md` 作比对，不进这里。样式表里的写法见 `style/keys.ts` 的 `book` 一列。 */
export interface BookMetrics {
  // —— 谱行与行内 ——
  systemGapEm: number; // 谱行净距：上一行末条歌词 baseline → 下一行 noteTop
  noteStepEm: number; // 同一谱行相邻音符的 x 步距（去掉跨小节线那一档）
  /** 相邻歌词字的**间隙** ÷ 歌词字号。排版器只保证歌词不重叠，字距会压到 0；
   *  原书的歌词字之间是有呼吸的，不给这道间隙，一行会挤进三十几个字。 */
  lyricGapEm?: number;
  /** 房号/三连音括线的线宽（pt）与「脚」长 ÷ 音符字号。从原书量的（inventory 的 `bracket` 类）。 */
  bracketWidth?: number;
  bracketFootEm?: number;

  // —— 纵向栅格（减时线，见 docs/实现/简谱纵向栅格.md）——
  divLineGapEm: number; // 音符墨迹下缘 → 第一条减时线（inventory 的 divLine）
  divLineStepEm: number; // 相邻减时线间距

  // —— 反复 ——
  repeatDotDiam: number; // pt

  // —— 上下带 ——
  chordToNoteEm: number; // 和弦 baseline → 音符墨迹上缘
  /** 和弦排成纯文本（原书就是一行普通文字，没有 SMuFL 字形）。见 LayoutOptions.chordPlainText。 */
  chordPlain?: boolean;
  lyricToLyricEm: number; // 相邻歌词行 baseline 差

  // —— 线与弧 ——
  //
  // 引擎的 slurTieThickness / jpBeamWidth / barlineWidth 是**按 fontSize≈28 调出来的绘制厚度**，
  // 不是原书的描边宽（0.19pt 上下），所以一律存 `*Em`（× 字号）。
  /** 弧的**凸起高度**（× 音符字号）。引擎的弧高公式是按 fontSize≈28 的绝对像素调的，
   *  换成成书的小字号后按比例缩会扁成一条线，所以这里给一个明确的物理目标，
   *  由 style/book.ts::applyBookPreset 反算缩放系数。 */
  slurArcEm: number;
  /** 弧顶的**上限**与**下限**，× 音符字号（与 `slurArcEm` 同口径）。
   *  对数公式两头都失控：长跨度一路长高去顶和弦，短跨度塌成一条直线。
   *  原书实测（1205 条，页 40-240）：跨度 0-25pt 的弧高恒为 0.41 × 音符墨迹高
   *  （最短两桶完全相同，说明原书短弧是**定高**的），60-90pt 也才 0.66；
   *  Times 数字墨迹占字号 0.674，折成字号口径是 0.276 / 0.445。
   *  上限另有一道「压在和弦带下面」的钳制，见 browser.ts。 */
  slurMaxArcEm?: number;
  slurMinArcEm?: number;
  /** 跨度超过「这么多个音符步距」就改画扁平长连音线（两端小钩 + 水平细线，
   *  open-fanqie 的 `slurStyle: auto` 就是这么干的，只是它的阈值约 4 个音符）。
   *  0 = 一律画弧。**手调常量，不从原书量。** */
  slurFlatSpanSteps?: number;
  /** 弧罩住这么多个音符就改画扁平式（与跨度阈值并用，取先满足的那个）。0 = 不看。 */
  slurFlatNotes?: number;
  /** 弧的**宽高比**（跨度 ÷ 弧顶高）超过它就改画扁平式。 */
  slurFlatRatio?: number;
  /** 引擎绘制厚度，× 歌词字号。默认取引擎在 fontSize 28 下的比例，保持它调好的观感。 */
  slurThicknessEm: number;
  barlineWidthEm: number; // × 歌词字号
  finalBarlineWidthEm: number; // × 歌词字号

  /** 统一层距（em）：高音点上距 / 低音点下距 / 减时线首层距三者的均值，校准 LayoutOptions.jpStackGap。
   *  三者差得多时 stats 报 ⚠（见 bookstyle 报告）。 */
  stackGapEm: number;
}

export interface PageMargin {
  /** 装订侧 / 切口侧（mirror 为真时按页奇偶换边）。 */
  inner: number;
  outer: number;
  top: number;
  bottom: number;
}

/** 谱面起排的几个绝对位置（页内 y，pt）。原书整本统一版式，不随内容浮动。
 *  标题块里各行的基线（标题、调号拍号、署名、页眉）直接写在歌本模板的 `row(baseline: …)` 里，不在这里。
 *  样式表里写在 `@flow` 块（`number-baseline` / `first-system-top` …）。 */
export interface TitleBlock {
  /** 曲号基线：半页起排时标题块整体下移的参照。 */
  numberBaseline: number;
  /** 首页第一条谱行的音符墨迹上缘。内容整体按它对齐（见 scripts/rebuild.mjs）。 */
  firstSystemTop: number;
  /** 续页第一条谱行的音符墨迹上缘。 */
  contSystemTop: number;
  /** **半页起排**：上一首的内容墨迹底 → 本首曲号基线的净距（原书 25 处实测中位数）。 */
  midStartGap: number;
  /** 页码基线：谱面下界按它算（页脚不压谱）。 */
  footerBaseline: number;
}

/** 断句与行宽。样式表里断句那组写在 `@break`（与谱式无关，五线谱以后也用），
 *  `verseNumbers` / `maxHorizontalScale` 写在 `@jianpu`。 */
export interface BookLayoutOpts {
  linesPerPage: number;
  phrase: boolean;
  /** 乐句排版的目标行长（小节数）。**0 = 按版心容量折算**（`phrase.ts::targetMeasForCells`），
   *  成书走这个：容量由版心宽 ÷ 音符步距实测（见 scripts/rebuild.mjs），除以本曲「每小节几格」
   *  就是一行该放几小节。给死一个小节数（原来是 4）就得靠「两两并短行」去凑满版心，
   *  而并行只能成对，段里落单的那一行并不进去——377《我宁愿有耶稣》副歌因此排成
   *  12 小节 + 6 小节两行。 */
  phraseTargetMeas: number;
  /** 行长代价的权重。**目标行长按容量折算之后要调小**（0.25）：目标本身已经是版心宽，
   *  行长代价再重就会压过「断在乐句收尾处」，把行末从标点上挪走
   *  （全书实测：行末收标点 94.1% → 81.2%，权重 4 时）。 */
  phraseLenWeight: number;
  /** 断点强度的权重：让「断在长音 + 标点上」压过「各行一样长」。 */
  phraseBreakWeight: number;
  /** **摊匀行长**的权重（`phrase.ts` 跑第二遍 DP 用；0 = 关）。行数由第一遍定，
   *  第二遍把目标改成「本段小节数 ÷ 行数」——原书每行都差不多长，只按容量排会
   *  一行顶格、一行半幅（051《赞美我主君王》12/14/24 格）。 */
  phraseEvenWeight?: number;
  /** 「别把一句话的最后一小截甩到下一行开头」的权重（`phrase.ts::headPenalty`；0 = 关）。 */
  phraseTailWeight?: number;
  /** **断句只看内容**（默认开）：与纸张有关的分（行长目标、行数、稀疏/密排）一律不进评分，
   *  版心宽度只剩「超容量是硬约束」这一个作用。见 `phrase.ts::PhraseOptions.contentOnly`
   *  与 `applybreaks.ts::chooseLineLayout` 的模式阶梯。 */
  phraseContentOnly?: boolean;
  /** **平行乐句开头**的加分（0 = 关，默认 6）。一行的头几个音与另一行相同时，把它们各自
   *  排成行首，两行就对齐得上（070 副歌两行、077 的 `13|5565|`、175 的一二行）。
   *  见 `phrase.ts::headFpOf`。 */
  phraseParallelWeight?: number;
  /** **行末收在长音上**的加分（0 = 关，成书 3；编辑器那 15 首的基线不开）。
   *  与 `phraseParallelWeight` 是一对——那条管「下一行从哪儿起」，这条管「本行在哪儿收」。
   *  见 `phrase.ts::PhraseOptions.tailLongWeight`。 */
  phraseTailLongWeight?: number;
  /** **行数多的方案优先**的容差（内容层，与版心无关；0 = 关，成书 4）。
   *  并回去是 B 档 `mergePairsUniform` 的活，而把一行劈开谁也补不回来。
   *  见 `phrase.ts::PhraseOptions.moreRowsSlack`。 */
  phraseMoreRowsSlack?: number;
  /** **纸张当平局裁判**的容差（0 = 关，成书就是 0：版心不影响断句）。
   *  见 `phrase.ts::PhraseOptions.fitSlack`。 */
  phraseFitSlack?: number;
  /** 是否允许在小节中间换行。**默认允许**：原书每行都在小节线上收尾，但那是固定版式的结果——
   *  弱起谱（005《荣耀归与天父》）每句都收在小节中间的长音上，只认小节线就一条乐句断点都找不到，
   *  只能靠容量保险每 6 小节机械切一刀，句子被拦腰截断。phrase 的 DP 本来就给行内断点加罚 6、
   *  只有句号/长音级的强信号才用得上它，交给它判断比在这里一刀切掉更准。
   *  全书实测：行末收在标点上的谱行 60.7% → 89.3%，过短行 9.4% → 7.3%，谱行数 +7%。 */
  phraseMidBreak: boolean;
  /** 允不允许**每 2 句排一行**（模式阶梯的 B 档，`applybreaks.ts::chooseLineLayout`）。
   *  原书绝大多数是一行两句：005《荣耀归与天父》每小节才 3.2 格，一句一行只用得上半幅版心
   *  （13 格 / 容量 27）；而 001《圣哉，圣哉，圣哉》两句 32 格 > 容量 31，那首本来就是一句一行。
   *  关掉 = 一律一句一行（放不下才退到均匀排版）。 */
  phraseMergeShort: boolean;
  /** 歌词段号（行首 `1.` `2.`）：`always` / `never` / `auto`（段数多于 3 才标）。
   *  成书默认 `auto`——原书两三段的谱不标段号，段数多的才标。 */
  verseNumbers: "always" | "never" | "auto";
  maxHorizontalScale: number;
}

/** 目录与索引页的几何（pt，由 stats.ts 从原书目录/索引页实测）。排法仍在 `bookparts.ts::tocPages`，
 *  样式表里写在 `@template toc`（`title-baseline`、`entry { … }`、`index { … }`）。 */
export interface TocRule {
  /** 引导点字符。 */
  leader: string;
  lineGap: number;
  firstBaseline: number;
  left: number;
  right: number;
  /** 首句/笔划索引是两栏，行距比目录紧。 */
  indexColumns: number;
  indexLineGap: number;
  indexFirstBaseline: number;
  /** 页题基线（「目录」「诗题笔划索引」）。 */
  titleBaseline: number;
  /** 分类标题上下的净距（上一条目基线 → 标题基线 / 标题基线 → 下一条目基线），
   *  由 stats.ts 从原书目录页实测。缺省时按行距推。 */
  headingGapAbove?: number;
  headingGapBelow?: number;
}

/** 成书样式的**内存形态**：由歌本 `.ss` 算出（`style/bookss.ts::bookStyleOf`），没有文件形态。 */
export interface BookStyle {
  /** 书的标识（取样式表文件名），出书时写进 DrawList。 */
  id: string;
  page: {
    w: number;
    h: number;
    /** 对开页镜像：奇数页 inner 在左、偶数页在右。 */
    mirror: boolean;
    margin: PageMargin;
  };
  fonts: Record<string, FontRef>;
  roles: Record<StyleRole, RoleStyle>;
  metrics: BookMetrics;
  layout: BookLayoutOpts;
  toc: TocRule;
  titleBlock: TitleBlock;
}

/** 本机可用的一套默认字体（原书是转曲的，PDF 里没有字体资源，只能按面貌配同族替代）。 */
export function defaultFonts(): Record<string, FontRef> {
  const FZ = `${process.env.HOME ?? ""}/Library/Fonts`;
  return {
    // 原书那四款方正字体（装在用户字体目录）。都是 TrueType，能正常子集嵌入，
    // 所以走文字不走轮廓——可选中可搜索。
    // **注意**：系统自带的 WeibeiSC-Bold.otf 是 CFF，pdf-lib 的子集产物 poppler 与 pdfjs
    // 都认不出来（"Unable to detect correct font file Type/Subtype"），那种只能 mode:"path"。
    wei: { family: "FZWeiBei-S03S", file: `${FZ}/方正魏碑简体.ttf` }, // 标题
    serif: { family: "FZBaoSong-Z04", file: `${FZ}/方正报宋_GBK.TTF` }, // 歌词与正文
    kai: { family: "FZKai-Z03", file: `${FZ}/方正楷体_GBK.TTF` }, // 词曲署名
    hei: { family: "FZHei-B01S", file: `${FZ}/方正黑体简体.TTF` }, // 曲号、分类页眉
    xingkai: { family: "FZXingKai-S04", file: `${FZ}/方正行楷_GBK.ttf` }, // 目录的分类标题
    times: { family: "Times New Roman", file: "/System/Library/Fonts/Supplemental/Times New Roman.ttf" },
    // 兜底：方正那四款是印刷字库，字表不含「祂」「衪」「啰」这些（歌本里真的会用到）。
    // 只在主字体缺字时才用得上，用不到就不会被嵌进 PDF。
    fallbackCjk: { family: "Songti SC", file: "/System/Library/Fonts/Supplemental/Songti.ttc", face: "Songti SC Regular" },
    music: { family: "Bravura", file: "public/redist/Bravura.otf", mode: "path" },
  };
}

/** 各角色量墨迹高用的样本字：原书量到的是墨迹高，除以这个字在该角色字体里的「墨迹高 ÷ 字号」就是字号。
 *  没列的角色（汉字档）一律用「国」——`stats.ts` 汉字档也只按汉字取样，两边口径一致。 */
export const INK_SAMPLE: Partial<Record<StyleRole, string>> = {
  note: "5",
  tuplet: "3",
  chord: "G",
  keyMeter: "4",
  footer: "8",
  verseNum: "1",
};

export function inkSampleOf(role: StyleRole): string {
  return INK_SAMPLE[role] ?? "国";
}

/** 各角色默认引用哪个字体（字号由统计填，这里只给字体与对齐口径）。 */
const ROLE_FONT: Record<StyleRole, { font: string; align: AlignMode }> = {
  title: { font: "wei", align: "center" },
  songNumber: { font: "hei", align: "outer" },
  category: { font: "hei", align: "outer" },
  credit: { font: "kai", align: "right" },
  keyMeter: { font: "times", align: "left" },
  note: { font: "times", align: "inkCenter" },
  tuplet: { font: "times", align: "inkCenter" },
  verseNum: { font: "times", align: "left" },
  chord: { font: "times", align: "inkCenter" },
  lyric: { font: "serif", align: "inkCenter" },
  lyric2: { font: "serif", align: "inkCenter" },
  sectionWord: { font: "serif", align: "left" },
  story: { font: "serif", align: "left" },
  // 目录：歌名用楷体、分类标题用行楷（原书就是这么排的）
  toc: { font: "kai", align: "left" },
  tocHeading: { font: "xingkai", align: "center" },
  tocSub: { font: "xingkai", align: "center" },
  frontTitle: { font: "wei", align: "center" },
  header: { font: "hei", align: "outer" },
  footer: { font: "times", align: "outer" },
  // SMuFL 走轮廓（fonts.music.mode = "path"）：PDF 里就不必嵌 Bravura，
  // 也绕开 PUA 码位在子集 cmap 上的编码风险。
  smufl: { font: "music", align: "pen" },
};

export function roleFontDefaults(): Record<StyleRole, { font: string; align: AlignMode }> {
  return { ...ROLE_FONT };
}

/** 一份可用的默认样式（A4 之外的值都是占位，实际由 stats.ts 覆盖）。 */
export function defaultBookStyle(): BookStyle {
  const roles = {} as Record<StyleRole, RoleStyle>;
  for (const r of STYLE_ROLES) {
    roles[r] = { font: ROLE_FONT[r].font, size: 10, baselineAdjust: 0, align: ROLE_FONT[r].align };
  }
  return {
    id: "default",
    page: {
      w: 425.197,
      h: 612.283,
      mirror: true,
      margin: { inner: 52, outer: 52, top: 94, bottom: 94 },
    },
    fonts: defaultFonts(),
    roles,
    metrics: {
      systemGapEm: 2.2,
      noteStepEm: 1.5,
      lyricGapEm: 0.1,
      bracketWidth: 0,
      bracketFootEm: 0,
      divLineGapEm: 0.17,
      divLineStepEm: 0.17,
      repeatDotDiam: 1.6,
      chordToNoteEm: 1.3,
      chordPlain: true,
      lyricToLyricEm: 1.5,
      // 原是 × 音符墨迹高的 0.9 / 0.66 / 0.41，× 0.674（Times 数字墨迹占字号）折成字号口径
      slurArcEm: 0.607,
      slurMaxArcEm: 0.445,
      slurMinArcEm: 0.276,
      slurFlatSpanSteps: 4,
      slurFlatNotes: 0,
      slurFlatRatio: 7,
      slurThicknessEm: 6 / 28,
      barlineWidthEm: 2 / 28,
      finalBarlineWidthEm: 3.5 / 28,
      stackGapEm: 0.1667,
    },
    layout: {
      // 0 = 一页装多少行交给排版器按页高定。成书要的是装满，硬定行数会空掉半页；
      // 编辑器那条路（原 jpscore）另有自己的 4。
      linesPerPage: 0,
      phrase: true,
      phraseTargetMeas: 0,
      phraseLenWeight: 0.25,
      phraseBreakWeight: 3,
      phraseMidBreak: true,
      phraseMergeShort: true,
      // 断句那几个开关的默认值**要写在这儿**：统计脚本（gen-bookstyle.mjs）每次按这份默认值
      // 生成歌本的实测样式表，只在生成物里调参的话，重跑一次就全丢了。
      phraseEvenWeight: 1,
      phraseTailWeight: 1,
      phraseContentOnly: true,
      phraseParallelWeight: 6,
      // 这三个是 2026-08-27/28 调好的成书口径，**同样只能写在这儿**：9 月 1 日重跑一次统计
      // 就全丢过一次——096《哈利路亚！感谢主》的四行塌回两行（补刀再切成三行）、全书 D8 9 → 12。
      phraseTailLongWeight: 3,
      phraseMoreRowsSlack: 4,
      phraseFitSlack: 0,
      verseNumbers: "auto",
      maxHorizontalScale: 2,
    },
    toc: {
      leader: "…",
      lineGap: 19.4,
      firstBaseline: 109,
      left: 52,
      right: 361.5,
      indexColumns: 2,
      indexLineGap: 15.8,
      indexFirstBaseline: 116,
      titleBaseline: 78.5,
    },
    titleBlock: {
      numberBaseline: 77.9,
      firstSystemTop: 139.95,
      contSystemTop: 106,
      midStartGap: 40,
      footerBaseline: 556.5,
    },
  };
}

/** 校验：缺角色、缺字体引用、量值不合理都列出来（不抛异常，让调用方决定）。 */
export function validateBookStyle(s: unknown): { style: BookStyle; errors: string[] } {
  const errors: string[] = [];
  const style = mergeStyle(defaultBookStyle(), (s ?? {}) as DeepPartial<BookStyle>);
  for (const r of STYLE_ROLES) {
    const rs = style.roles[r];
    if (!rs) {
      errors.push(`缺角色 ${r}`);
      continue;
    }
    if (!(rs.size > 0)) errors.push(`角色 ${r} 字号无效：${rs.size}`);
    if (!style.fonts[rs.font]) errors.push(`角色 ${r} 引用了不存在的字体 ${rs.font}`);
  }
  if (!(style.page.w > 0 && style.page.h > 0)) errors.push("页面尺寸无效");
  const m = style.metrics;
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === "boolean") continue; // chordPlain 这类开关
    if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`metrics.${k} 无效：${v}`);
  }
  return { style, errors };
}

/** 该页的四边留白。mirror 为真时按页奇偶把 inner 放到左/右。 */
export function pageMargins(s: BookStyle, pageNo: number): { left: number; right: number; top: number; bottom: number } {
  const { inner, outer, top, bottom } = s.page.margin;
  if (!s.page.mirror) return { left: inner, right: outer, top, bottom };
  const oddPage = pageNo % 2 === 1; // 奇数页在右手边，装订边在左
  return { left: oddPage ? inner : outer, right: oddPage ? outer : inner, top, bottom };
}

export function roleOf(s: BookStyle, role: StyleRole): RoleStyle {
  return s.roles[role] ?? s.roles.lyric;
}

/** em → pt（基准：音符字号）。 */
export function emToPt(s: BookStyle, em: number): number {
  return em * s.roles.note.size;
}

/** 该角色实际用哪个字体。 */
export function fontOf(s: BookStyle, role: StyleRole): FontRef {
  return s.fonts[roleOf(s, role).font] ?? Object.values(s.fonts)[0];
}
