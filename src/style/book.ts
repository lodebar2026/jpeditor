// 成书那把尺子的适配器：`BookStyle`（原书实测，字号是**墨迹高**）→ 简谱引擎的 `LayoutOptions`。
//
// 由 `style/jianpu.ts` 的 `book` 预设调用；`fontSizeFor` 另供 scripts/rebuild.mjs（经 `window.__book`）
// 把书首/目录那些不进引擎的角色换成字号。要量字体，所以**只能在浏览器里跑**。
import { Font } from "../layout/font";
import type { LayoutOptions } from "../layout/options";
import type { BookStyle } from "../pdflayout/bookstyle";
import type { StyleRole } from "./sheet";

/** 减时线宽 ÷ 小节线宽。取自混排简谱层的 `MixedOptions.lineWidths`（jpBeam 1 : lightBarline 1.5）。 */
const JP_BEAM_TO_BARLINE = 2 / 3;

/**
 * 把书籍样式灌进排版选项。**在 painter 构造之后、resize 之前调**。
 *
 * 只改常量的来源，不动 layout.ts 的算法：`jpDotRung` / `jpStaffTop` 那些都是 getter，
 * 覆写字段就全局生效——《简谱纵向栅格》那把尺子一个常量都不用动。
 *
 * 层距（高音点上距 / 低音点下距 / 减时线首层距）在原书里并不相等，而 `jpStackGap` 只有一个。
 * 这里取三者的中位（`metrics.stackGapEm`）；要分开还原得先把 layout.ts 里那三处使用点拆开，
 * 那是背离《简谱纵向栅格》的既定写法，需要单独记账。
 */
export function applyBookPreset(opt: LayoutOptions, s: BookStyle): void {
  const note = fontSizeFor(s, "note");
  const lyric = fontSizeFor(s, "lyric");
  const em = (v: number) => v * s.roles.note.size;

  opt.applyFontSize(lyric);
  opt.lrcFont = new Font(fontFamilyOf(s, "lyric"), lyric);
  opt.numberFont = new Font(fontFamilyOf(s, "note"), note);
  // 成书是逐像素复刻印刷底本，字重由 BookStyle 的 roles.note 说了算，不跟编辑器那档加粗
  opt.noteBold = false;
  opt.smuflFont = new Font(fontFamilyOf(s, "smufl"), note);
  opt.titleSize = fontSizeFor(s, "title");
  opt.creditSize = fontSizeFor(s, "credit");

  const m = s.metrics;
  opt.marginLeft = s.page.margin.inner;
  opt.marginRight = s.page.margin.outer;
  opt.marginTop = s.page.margin.top;
  opt.marginBottom = s.page.margin.bottom;
  opt.jpStackGap = em(m.stackGapEm);
  // 向下那条阶梯（数字↓减时线↓低音点）成书仍用同一个 `stackGapEm`——编辑器新调的
  // `jpBelowGap`（1/9 em，见 LayoutOptions）是屏幕观感，原书量到的是这个。
  opt.jpBelowGap = opt.jpStackGap;
  // 附点也按原书那个大小：引擎默认让它与八度点同大（`.` 的墨迹高折半），
  // 而原书印的是 `·`，墨迹高出一截——照默认排全书会差出两页。
  opt.augDotRadius = opt.numberBound("·").height / 2;
  opt.jpBeamTop = em(m.divLineGapEm);
  opt.jpBeamDist = em(m.divLineStepEm);
  // 减时线宽**按小节线宽折算**，比例照混排的简谱层（`MixedOptions.lineWidths`：
  // jpBeam 1 : lightBarline 1.5 = 2/3）。用户口径：「成书重排减时线太细了」
  // ——原来取的是原书**实测的墨迹宽**（0.19pt 上下），那是扫描件里的一条细线，
  // 排出来几乎看不见；小节线本来就是按字号等比缩的，拿它当基准，两条线的粗细关系才稳定。
  opt.jpBeamWidth = m.barlineWidthEm * lyric * JP_BEAM_TO_BARLINE;
  opt.slurTieThickness = m.slurThicknessEm * lyric;
  // 弧高：**按物理目标反算**，不是按字号等比缩。
  // 引擎的 `log10(dist)*17−16` 是 fontSize≈28 下的绝对像素，等比缩到成书的小字号
  // 会把弧压成一条平线（实测 0.42 倍时几乎看不出弧度）。
  // 这里让「典型跨度（3 个音符步距）的弧」达到 slurArcEm × 音符字高。
  {
    const noteSize = s.roles.note.size;
    const typicalDist = m.noteStepEm * noteSize * 3;
    const rawH = Math.max(Math.log10(Math.max(typicalDist, 2)) * 17 - 16, 1.2);
    opt.slurHeightScale = (m.slurArcEm * noteSize) / (rawH * 0.75);
    // 弧高的上下限按**原书实测**给（× 音符字高），再换算回引擎那个「控制点高」的口径：
    // 弧顶 ≈ 0.75 × 控制点高 × heightScale。实测 1205 条（页 40-240）：
    // 跨度 0-25pt 的弧高恒为 0.41 × 音符高（最短两桶完全相同 → 原书短弧是**定高**的），
    // 25-40 是 0.53、40-60 是 0.59、60-90 才 0.66。对数公式两头都失控：
    // 长跨度一路长高去顶和弦，短跨度塌成一条直线。
    // ⚠️ 这几个是**手调常量**，而 bookstyle.json 是 stats 实测出来的产物——旧的 JSON 里
    // 没有这些字段，不兜底的话 `rawH * undefined` = NaN（等于不封顶）、
    // `undefined > 0` = false（等于关掉扁平），整条改动会静悄悄地不生效。
    const toRaw = (pt: number): number => pt / (0.75 * opt.slurHeightScale);
    opt.slurMaxHeight = toRaw((m.slurMaxArcEm ?? 0.66) * noteSize);
    opt.slurMinHeight = toRaw((m.slurMinArcEm ?? 0.41) * noteSize);
    const flatSteps = m.slurFlatSpanSteps ?? 4;
    opt.slurFlatSpan = flatSteps > 0 ? m.noteStepEm * noteSize * flatSteps : -1;
    // 跨度那条阈值是物理宽度，音符密的谱行上够不着（91《我灵镇静》罩着五六个十六分音符
    // 的弧，跨度还不到 4 个音符步距）。再按**音符个数**兜一条。
    opt.slurFlatNotes = m.slurFlatNotes ?? 0;
    // 「看着扁不扁」按宽高比判（跨度 ÷ 弧顶高）——绝对跨度那条阈值跟不上字号与弧高上限
    opt.slurFlatRatio = m.slurFlatRatio ?? 7;
    // 扁平长连音线的中段厚度取**小节线宽**：按弧厚折算（× 0.45）在成书的小字号下
    // 显得太肥，长长一条粗线很扎眼。
    opt.slurFlatWidth = m.barlineWidthEm * lyric;
  }
  opt.slurOutlineWidth = 0.7 * (lyric / 28);
  opt.barlineWidth = m.barlineWidthEm * lyric;
  opt.finalBarlineWidth = m.finalBarlineWidthEm * lyric;
  // 谱行净距：layout 用 staffDist（行间额外间距）与 maxLineDist（页内均分上限）表达
  opt.staffDist = 0;
  opt.maxLineDist = em(m.systemGapEm);
  opt.maxHorizontalScale = s.layout.maxHorizontalScale;
  opt.chordSize = fontSizeFor(s, "chord");
  opt.lyricBaselineGap = 0; // 歌词基线交给引擎自算（覆盖它会把带减时线的行推歪）
  opt.lyricStack = em(m.lyricToLyricEm); // 多段歌词叠排，段间距取原书的行距
  opt.lyricGap = (m.lyricGapEm ?? 0) * lyric; // 歌词字距（排版器自己只保证不重叠）
  // 反复点与房号：原书的谱面本来就有 `‖:`、`:‖`、1./2. 房，重排要照画
  opt.repeatDotRadius = m.repeatDotDiam > 0 ? m.repeatDotDiam / 2 : 0;
  // 房号数字用**三连音那一档**：原书房号与三连音数字同号（墨迹高 4.92pt，
  // 对应 musicxml 里 `<ending font-size="6.25">`）。verseNum 是歌词那么大的段号，会大三倍。
  opt.endingSize = fontSizeFor(s, "tuplet");
  // 房号/三连音括线：线宽与「脚」长都用原书量到的（inventory 的 bracket 那一类，n=233）
  opt.bracketWidth = m.inkBracketWidth && m.inkBracketWidth > 0 ? m.inkBracketWidth : opt.barlineWidth;
  // 转拍号的分数线：与书首那个拍号同一根尺子（bookparts.ts::keyMeterItems 画的 rect h=0.3）
  opt.timeSigRuleWidth = 0.3;
  opt.verseNumbers = s.layout.verseNumbers ?? "auto";
  opt.bracketFoot = m.bracketFootEm && m.bracketFootEm > 0 ? em(m.bracketFootEm) : 0;
  opt.chordGap = em(m.chordToNoteEm);
  // 原书的和弦是纯文本（见 layout/harmony.ts）；旧的 bookstyle.json 里没这个字段，缺省即为真
  opt.chordPlainText = m.chordPlain !== false;
  opt.sectionWordSize = fontSizeFor(s, "sectionWord");
  opt.pageFurniture = "none";
}

function fontFamilyOf(s: BookStyle, role: StyleRole): string {
  const id = s.roles[role]?.font;
  return s.fonts[id]?.family ?? "serif";
}

/** 各角色量字号用的样本字：拿它的**墨迹高**代表这一档的字号。 */
const SAMPLE: Partial<Record<StyleRole, string>> = {
  note: "5",
  tuplet: "3",
  chord: "G",
  keyMeter: "4",
  footer: "8",
  verseNum: "1",
};
const CJK_SAMPLE = "国";

const inkRatioCache = new Map<string, number>();

/**
 * BookStyle 里的 size 是从原书量到的**墨迹高度**，而排版引擎要的是 **font-size**。
 * 两者差一个「墨迹占 em 的比例」，而这个比例各族不同：Times 的数字约 0.66em、
 * 宋体汉字约 0.9em。直接把墨迹高当字号灌进去，数字会比歌词多缩三成——
 * 音符与歌词的大小关系就跟原书对不上了（这正是肉眼一看就别扭的地方）。
 *
 * 所以这里**实测**该字体样本字的墨迹比例，再反算出字号。测量走的还是
 * common/measure.ts 那一套（「在哪测量就在哪绘制」）。
 */
export function fontSizeFor(s: BookStyle, role: StyleRole): number {
  const target = s.roles[role]?.size ?? 10;
  const family = fontFamilyOf(s, role);
  const sample = SAMPLE[role] ?? CJK_SAMPLE;
  const key = `${family}|${sample}`;
  let ratio = inkRatioCache.get(key);
  if (ratio === undefined) {
    const probe = new Font(family, 100);
    const b = probe.charBound(sample);
    ratio = Math.abs(b.bottom - b.top) / 100;
    if (!(ratio > 0.2) || ratio > 1.6) ratio = 0.72; // 量不出来时的兜底
    inkRatioCache.set(key, ratio);
  }
  return Number((target / ratio).toFixed(3));
}
