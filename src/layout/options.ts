import { Font } from "./font";
import { MetaData } from "../smufl/smufl";
import { Rect, Colors } from "../common/geom";
import type { CompressMode } from "../common/cjkpunct";

// ---------------- options / CJK util ----------------

export class LayoutOptions {
  color = Colors.black;
  lrcFont: Font;
  numberFont: Font;
  /**
   * 音符数字是否加粗。**只管数字与倚音**——`numberFont` 还派生出和弦、房号、
   * 调号拍号那一行，那些不跟着粗，所以这里是个开关而不是把 `numberFont` 换成粗体。
   * 展开档（`applyPptxStyle`）与成书排版（`applyBookStyle`）关掉：前者是投影的既有观感、
   * 后者要逐像素复刻印刷底本，都不能凭空变粗。
   */
  noteBold = true;
  smuflFont: Font;
  smuflMeta = new MetaData();
  titleSize = 48;
  creditSize = 36;

  smuflAsPath = false;
  /** 和弦符号的字号与它到音符墨迹上缘的距离。0 = 不排和弦（默认：编辑器与 OMR 那两条路
   *  的 Score 里本来就没有 harmony，排了也不会变，但留一道闸更明确）。 */
  chordSize = 0;
  /** 段落词（「（副歌）」）的字号。0 = 不排（编辑器与 OMR 那两条路的 Score 里没有这东西）。 */
  sectionWordSize = 0;
  chordGap = 0;
  /** 歌词基线到音符基线的距离。0 = 用引擎自算的（贴着音符下方的减时线/低音点）。
   *  成书排版给原书量到的定值，让每一行的歌词都排在同一高度上；
   *  某一行的栈比它还深时仍按栈走（**只放大不缩小**，不会压到减时线上）。 */
  lyricBaselineGap = 0;
  /** 相邻歌词字之间的**最小间隙**。0 = 字紧挨着字（引擎老行为：只保证不重叠）。
   *  印刷歌本的歌词字之间是有呼吸的（原书量到的步距 ≈ 字宽 × 1.32），
   *  不留这道间隙，排版器会以为一行塞得下三十几个字、把整段挤成密不透风的一行
   *  （001《圣哉，圣哉，圣哉》曾因此排成 2 行、字距 9.1pt 小于 11.8pt 的字宽）。 */
  lyricGap = 0;
  /** 反复点的半径。0 = 按小节线宽推算。成书排版给原书量到的值（metrics.repeatDotDiam）。 */
  repeatDotRadius = 0;
  /** 八度点（实心圆）的半径。0 = 按数字字体里 `.` 字形的**墨迹高**折半推算——
   *  纵向栅格是墨迹到墨迹量的（见《简谱纵向栅格》），取墨迹高才能与原来的字形等大。 */
  octaveDotRadius = 0;
  /** 附点（实心圆）的半径。**0 = 与八度点同大**（`jpDotRadius`）。
   *  附点一律是矢量圆、且圆心与数字墨迹的中心等高，见 `NoteEntry.addAugDots`。 */
  augDotRadius = 0;
  /** 和弦排成**纯文本**（升降号不换 SMuFL 的 csym 字形、后缀不上标）。
   *  原书 500 首就是这么印的，成书重排由 `applyBookStyle` 打开；
   *  编辑器 / 五线谱 / 文本谱三路维持富文本排法。见 layout/harmony.ts。 */
  chordPlainText = false;
  /** 房号（1./2.）的字号。0 = 不画房号。 */
  endingSize = 0;
  /** 歌词段号（行首的 `1.` `2.`）标不标：
   *  `always` 一律标（编辑器那条路的老行为）、`never` 一律不标、
   *  `auto` = 段数多于 `verseNumberAutoMin` 才标。 */
  verseNumbers: "always" | "never" | "auto" = "always";
  /** `auto` 的门槛：段数**多于**这个数才标段号。默认 3（三段以内不标）。 */
  verseNumberAutoMin = 3;
  /** 转拍号那条分数线的粗细。0 = 用引擎默认的 1.5（编辑器那条路不变）。 */
  timeSigRuleWidth = 0;
  /** 拍号的两个比例（都是 ÷ 小节线高度 H）。0 = 用 `jpglyph.ts::TIME_SIG_DEFAULTS`。
   *  单独提出来是因为 H 一变（见 `jpStaffTopOverride`），照默认比例算出来的拍号会跟着
   *  整体缩放。**竖向没有旋钮**：上下两个数字各离分数线一格「减时线与音符」的距离，
   *  只认拍值字号（`jpglyph.ts::TIME_SIG_GAP_EM`）。 */
  timeSigDigitRatio = 0;
  timeSigRuleLenRatio = 0;
  /** 房号/三连音括线的线宽与「脚」（下垂那一小段）的长度。0 = 按字号推算。 */
  bracketWidth = 0;
  bracketFoot = 0;
  /** 多段歌词的排法：0 = **逐段重复整条谱行**（jpword/musicpp 的老行为，流行敬拜谱常见）；
   *  >0 = **一行谱下叠多行词**（传统圣诗本的排法，原书 500 首就是这样），值为段间行距。
   *  只在「无反复、纯多段」（PlayData.isSimpple）的曲子上生效——有反复房号的谱
   *  每一遍的谱面本来就不同，叠不到一起。 */
  lyricStack = 0;
  /** **一张连续长纸**：不按纸张高度分页，所有谱行首尾相接排成一页（高度由内容定）。
   *  「原样」档走它——那一档是「原样展示」，与文本谱的「原版」同一种观感；
   *  展开档仍按 16:9 的纸分页。见 `Line.layoutVertically` 与 `JinpuPainter.resize`。 */
  continuousPage = false;
  /** 标题与词曲**排在第一页的顶上**（印刷歌本的排法），而不是另起一张标题页。
   *  「原样」档走它——长图那一档由 `continuousPage` 隐含，分页那一档靠这个字段。
   *  展开档仍是标题页独占第一屏。见 `JinpuPainter.resize`。 */
  bookHead = false;
  /** 第一页顶部为标题块预留的高度。分页时首页可用高度按它扣减、首页各行整体下移。
   *  由 `JinpuPainter.resize` 量出 `bookHead` 的实际高度后填，**不是给人配的**。 */
  firstPageHeadroom = 0;
  /** 歌词标点挤压的档（见 common/cjkpunct.ts::CompressMode）。
   *
   *  默认 `halfwidth`：**简谱歌词的标点不占音符格**，原书印的就是压缩形。
   *  换成 CLREQ 的上下文挤压（孤立标点占满一格）会把音符间距整排撑开——
   *  实测全书 655 → 695 页，定点断言里 459/363/355/446 的规整分行全都排不出来。
   *  中文**正文**（注解、目录、索引、前言）不受此限，那条路走 `clreq`，见 bookparts.ts。
   *
   *  **原来这里是 `halfWidthPunct = true`**：把 `。，、？！：；` 换成 U+FF61 系半角**字符**。
   *  字符替换的账很难算——印刷字库多半没有那些码位（PDF 端要换回全角、line-check 的 V2
   *  因此跳过 121 处），半角 `,` 又是西文逗号、不在中文逗号该在的位置。挤压是**排版**的事，
   *  不该改内容里的字，所以改成压 advance（字体有 `halt` 就交给字体）。 */
  punctCompress: CompressMode = "halfwidth";
  ignoreVerseNumber = true;
  slurTieThickness = 6; // musicpp render.cpp:1076 (`lw0 = 6/cos`)，按 fontSize≈28 调
  /** 弧高与弧描边宽。同样是按 fontSize≈28 调出来的绝对值，换字号排版要跟着缩。 */
  slurHeightScale = 1;
  slurOutlineWidth = 0.7;
  /** 弧高的**上限**（未乘 slurHeightScale 的原始像素口径；贝塞尔的弧顶约为它的 0.75）。
   *  对数公式没有上限，长跨度的弧会一路长到顶掉上方的和弦符号：28px 字号下实测
   *  跨度 30px 的弧顶 6.6px、跨度 218px 的弧顶 17.8px，差 2.7 倍。
   *  18 = 典型跨度（3 个音符步距、dist≈100）的弧高，也就是「长弧最多长到典型那么高」，
   *  短弧（跨度 < 100px，两三个音符）一点不受影响。<=0 = 不封顶（老行为）。 */
  slurMaxHeight = 18;
  /** 弧高的**下限**（同一口径）。公式在短跨度上塌得很快（dist=20px 时弧顶只剩 4.6px），
   *  短弧几乎成了一条直线。open-fanqie 没有短弧特例——它的弧高**恒定** 10px，短弧自然不塌；
   *  这里取 10（弧顶 7.5px，与它同量级），影响的只有跨度 < 35px 的那批。<=0 = 只用公式自带的 1.2。 */
  slurMinHeight = 10;
  /** 跨度超过它就改画**扁平长连音线**（两端小钩 + 水平细线，见 SlurTieBase.initFlat）。
   *  0 = 按字号自动取 `numberSize * 5`（28px → 140px，约 4 个音符，
   *  与 open-fanqie 的 100px 阈值同一量级）。<0 = 一律画弧。 */
  slurFlatSpan = 0;
  /** **弧覆盖到这么多个音符就改画扁平长连音线**（0 = 只按跨度判）。
   *  跨度那条阈值是物理宽度，音符密的谱行上够不着——91《我灵镇静》那几条覆盖五六个
   *  十六分音符的弧，跨度还不到 4 个音符步距，照旧画成了高高的月牙。 */
  slurFlatNotes = 0;
  /** 弧的**宽高比**超过它就改画扁平式（0 = 不看）。见 SlurStyle.flatRatio。 */
  slurFlatRatio = 0;
  /** 扁平长连音线**中段**的墨迹厚度（两端收尖）。0 = `slurTieThickness * 0.45`。 */
  slurFlatWidth = 0;
  /** 小节线粗细。musicpp lineWidths.lightBarline / heavyBarline（pptutil.cpp:139），
   *  同样是按 fontSize≈28 调出来的绝对值——换字号排版时要等比缩，否则小节线相对字会变粗。 */
  barlineWidth = 2;
  finalBarlineWidth = 3.5;
  staffDist = 0;
  marginTop!: number;
  marginBottom!: number;
  marginLeft = 50;
  /** 右边距。默认与 marginLeft 相同（原来左右共用一个值）；成书排版要对开页镜像时分开给。 */
  marginRight = 50;
  /** 页面装饰：`song` = 每页底部印「曲名 + 第 i/n 页」（编辑器/单曲预览的老行为）；
   *  `none` = 什么都不印，页眉页脚由整本合成那一层统一加（见 scripts/rebuild.mjs）。 */
  pageFurniture: "song" | "none" = "song";
  maxLineDist!: number;
  maxHorizontalScale = 2.0;
  jpBeamDist!: number;

  // --- jianpu vertical grid ---------------------------------------------
  // Everything stacked above (and below) a jianpu digit — octave dots, the
  // slur/tie arc, the tuplet bracket — is separated by ONE gap, `jpStackGap`,
  // measured ink-to-ink. So digit→dot, dot→dot and dot→slur are all equal and
  // the stack reads as an even ladder.
  //
  // musicpp is *not* even here: it steps the dots by `octaveDotDist = 6` but
  // lifts the slur a further 6 per dot from a different origin
  // (render.cpp:906 vs model.cpp:2649), giving ~6.4px digit→dot against
  // ~2.3px dot→slur at this font size. Its absolute slur height is still a
  // good sanity check: with one octave dot the ladder below lands within
  // 0.1px of it.
  //
  // (Before this, the project mixed three unrelated steps —
  // `dotBound.height*1.5` ≈ 4.2px, `numberSize/8` = 3.5px and
  // `numberSize/2` = 14px.)
  jpStackGap!: number;
  /** Baseline → first beam (减时线). musicpp draws level 0 at y=35 with the
   * digit baseline at 30 (render.cpp:161, and processLevelJp's `lev >= cnt`
   * makes the level 0-based), i.e. 5 units at jianpuFont 30 = 1/6 em.
   * Without it the first beam sat at `jpBeamDist` (1/8 em) and crowded the
   * digit, more so once the stroke widened to musicpp's 1.5. */
  jpBeamTop!: number;
  jpBeamWidth = 1.5; // musicpp lineWidths.jpBeam (pptutil.cpp:138)
  /**
   * 数字 ↓ 减时线 ↓ 低音点 这条**向下**阶梯的墨迹净距（用户口径：「音符、减时线、
   * 低音点之间的距离要相等、均匀排布」）。
   *
   * 为什么不跟上方共用 `jpStackGap`：上方那一格要给弧/三连音括线留手，量出来是 1/6 em；
   * 下方三样是紧挨着排的一摞，1/6 em 会把低音点推得离减时线明显比减时线离数字远
   * （实测 3.9 : 4.7，因为减时线原来是按**线心**摆在 `jpStackGap` 上、而低音点是按**墨迹**
   * 摆在减时线墨迹之下，两处口径不一致）。这里取展开档实测的那个距离（≈ 1/9 em，
   * 那一档是 2.9 / 3.0），并且两处都按墨迹算，看着才是均匀的一摞。
   */
  jpBelowGap!: number;

  /** `jpStaffTop` / `jpStaffBottom` 的覆写（0 = 按字号推算，见那两个 getter）。
   *  展开档要回到本项目原来的 −23/28 em 与 +5/28 em。 */
  jpStaffTopOverride = 0;
  jpStaffBottomOverride = 0;

  /**
   * **旧式纵向栅格**（展开档专用；默认 false = 等距的单一 `jpStackGap`）。
   *
   * 打开后，数字上下堆叠的那几样东西回到 2026-08 重构之前的**三套步长**：
   * 高音点按 `dotBound.height * 1.5` 步进、`entryTop` 在此之上再退 `numberSize/8`
   * （弧就落在这里，不再额外让一个 gap）、三连音退 `numberSize/2`、tie 退 `numberSize/8`，
   * 低音点按 `numberSize * (d*0.175 + 0.25)` 排。
   *
   * 这几个数彼此对不齐（数字↔点 ≈ 2.0px 而点↔弧 ≈ 4.4px，故有了后来的等距栅格），
   * 但那正是老 PPTX 的观感。**只在展开档打开**，默认那条路一个数都不许受影响。
   * 换算不成单纯的 gap/rung 两个数——老式带 0.5 格偏移，且八度点当年是字形、
   * 按基线落位，今天是矢量圆、按墨迹落位，两者差一个 `dotBound.top`。
   */
  jpGridLegacy = false;

  /** One rung of the stack: a dot plus the gap above it. Also the amount by
   * which anything that must clear a slur (a second arc, a tuplet bracket)
   * steps up. */
  get jpDotRung(): number {
    return this.jpStackGap + this.numberBound(".").height;
  }

  /** 低音点那一摞的步距：一个点加它上面那道空（口径同 `jpDotRung`，只是用向下那个 gap）。 */
  get jpLowDotRung(): number {
    return this.jpBelowGap + 2 * this.jpDotRadius;
  }

  /**
   * 旧式（展开档）数字的**墨迹顶**——按**目标字体**（Microsoft YaHei，`.pptx` 里真正
   * 渲染的那一份）算，不是拿排版字体量的 `numberBound("1").top`。
   *
   * 两者差了 0.0585 em（PingFang 的 "1" 墨迹高 0.714 em、YaHei 的 0.7725）——28pt 上
   * 1.64pt。凡是「贴着数字顶」的东西（倚音）照排版字体量，导到 .pptx 里就压进数字里
   * （用户口径：「倚音底部还是没有对齐正常音符的顶部，要求做到墨迹对齐」）。
   * 这一档的其它落点（`jpLegacyBandTop` / `jpLegacyDotCenter`）本来就是从成品 .pptx
   * 量回来的、已经是目标字体的口径，这里补齐最后一处。
   */
  get jpLegacyDigitInkTop(): number {
    return -this.numberSize * 0.7725;
  }

  /**
   * 旧式（展开档，`jpGridLegacy`）八度点阶梯：第 `d` 级（0 = 离数字最近）那个点的
   * **墨迹中心**离基线多远，`up` 为真是高音点（返回负值）。
   *
   * 两个系数是从 2019 年那批成品 .pptx（`ppt500/`，原桌面版在 Windows 上导的）
   * 量回来的：28pt 上高音点的 `.` 基线在 −26.13、低音点在 +7.47，各自再补上
   * Microsoft YaHei 那个 `.` 的墨迹半高（0.0506 em）就是墨迹中心，
   * 也就是 −0.9839 em 与 +0.2161 em。逐级、以及低音点让开减时线的那几格，
   * 一律走 `jpBeamDist`（同一批成品里量到 3.267pt @28pt，见 `pptxstyle.ts`）。
   */
  /**
   * 旧式（展开档）音符**上方那一带的底**：弧 / fermata / 三连音括线 / 和弦 / 房号
   * 都落在它上面（`NoteEntry.entryTop` 在没有高音点时直接返回它）。
   *
   * 同样量自 2019 年那批成品（`ppt500/`）：28pt 上圆滑线外弧的两端（也就是弧的下缘）
   * 恒在基线上方 27.07、fermata 的下缘在 26.04，取前者 → −0.967 em。
   * **不按 `numberBound("1").top` 往上退**：那是拿排版字体量的，PingFang 的数字比
   * 目标字体（YaHei，0.769 em）矮 0.055 em，照它退出来的弧在 .pptx 里贴着数字。
   */
  get jpLegacyBandTop(): number {
    return -this.numberSize * 0.967;
  }

  jpLegacyDotCenter(d: number, beams: number, up: boolean): number {
    return up
      ? -(this.numberSize * 0.9839 + d * this.jpBeamDist)
      : this.numberSize * 0.2161 + (d + beams) * this.jpBeamDist;
  }

  /** Bottom edge of the lowest of `n` beams, or the digit baseline if n = 0.
   * Low octave dots hang one `jpStackGap` below this, mirroring the top side. */
  jpBeamBottom(n: number): number {
    if (n <= 0) return 0;
    return this.jpBeamTop + this.jpBeamDist * (n - 1) + this.jpBeamWidth / 2;
  }

  constructor(public fontSize: number) {
    // Original used 苹方-简 / Microsoft YaHei; in the webview we rely on the
    // system CJK font via a CSS stack.
    const cjk = "PingFang SC, Microsoft YaHei, sans-serif";
    this.lrcFont = new Font(cjk, fontSize);
    this.numberFont = new Font(cjk, fontSize);
    this.smuflFont = new Font("Bravura", fontSize);
    this.applyFontSize(fontSize);
  }

  /** 由字号派生的那几个间距。构造时算一次；成书排版会在之后按 BookStyle 逐项覆盖
   *  （见 src/pdflayout/browser.ts::applyBookStyle）——**默认值必须原样保持**，
   *  编辑器与 OMR 那两条路的观感不能变。 */
  applyFontSize(fontSize: number): void {
    this.fontSize = fontSize;
    this.marginTop = fontSize * 1.5;
    this.marginBottom = fontSize * 3;
    this.maxLineDist = fontSize * 0.75;
    this.jpBeamDist = fontSize / 8;
    this.jpStackGap = fontSize / 6;
    this.jpBelowGap = fontSize / 9;
    // 减时线按**墨迹上缘**离数字 `jpBelowGap`（字段本身记的是线心，故加半个线宽）
    this.jpBeamTop = this.jpBelowGap + this.jpBeamWidth / 2;
  }

  get lrcSize(): number {
    return this.lrcFont.size;
  }
  set lrcSize(v: number) {
    this.lrcFont = this.lrcFont.makeWithSize(v);
  }
  get numberSize(): number {
    return this.numberFont.size;
  }
  set numberSize(v: number) {
    this.numberFont = this.numberFont.makeWithSize(v);
  }

  /** 八度点的实际半径（`octaveDotRadius` 为 0 时按 `.` 的墨迹高折半）。 */
  get jpDotRadius(): number {
    if (this.octaveDotRadius > 0) return this.octaveDotRadius;
    const b = this.numberBound(".");
    return (b.bottom - b.top) / 2;
  }

  /** 附点的实际半径。0 = **与八度点同大**（用户口径：三种点一个大小）。
   *  别拿 `·` 字形的墨迹高折半——那是 ⌀4.06 @28pt，比八度点的 ⌀3.44 明显胖一圈。 */
  get jpAugDotRadius(): number {
    return this.augDotRadius > 0 ? this.augDotRadius : this.jpDotRadius;
  }

  /** 音符数字实际用的那支字（`numberFont` 加不加粗，见 `noteBold`）。 */
  get noteFont(): Font {
    return this.noteBold ? this.numberFont.withBold() : this.numberFont;
  }

  /** Tight glyph box of a jianpu number/dot. Was measured on `lrcFont`, which
   * is a no-op only as long as the two fonts stay identical (they do today,
   * but `lrcSize` is settable) — the numbers are drawn with `noteFont`. */
  numberBound(ch: string): Rect {
    return this.noteFont.charBound(ch);
  }

  /**
   * Vertical extent of barlines and time signatures, relative to the digit
   * baseline. musicpp spans the whole 40-unit jianpu staff at jianpuFont 30
   * (render.cpp:802, :1793): 1.0em above the baseline — which is exactly the
   * high octave-dot row — down to 0.333em below, the low octave-dot row.
   * This project used 23/28 and 5/28, a third shorter, whose lower edge did
   * not even reach the first low octave dot.
   */
  get jpStaffTop(): number {
    if (this.jpStaffTopOverride !== 0) return this.jpStaffTopOverride;
    return -this.numberSize;
  }
  get jpStaffBottom(): number {
    if (this.jpStaffBottomOverride !== 0) return this.jpStaffBottomOverride;
    return this.numberSize / 3;
  }
}
