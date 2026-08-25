// B 路（从乐谱数据重排）的浏览器侧：样式注入 + 页面树 → DrawList。
//
// **这是唯一碰 measure/DOM 的重排件**，所以不能进 dist-cli（见 src/cli/index.ts 的头注释）。
// Node 侧的 rebuild.mjs 通过 window.__book 调它，拿回纯数据的 DrawPage[]，再交
// scripts/pdfwrite.mjs 出 PDF。
//
// 为什么导出 DrawList 而不是 SVG 字符串：SVG 要在 Node 侧反解嵌套 transform 与字体度量，
// 等于把 painter 再写一遍；而页面树本来就只有三种叶子（GraphicPath / GraphicLine / TextFrame），
// 照着 painter.ts::renderPageItem 的递归扁平化一次就完事，逻辑一比一对应、不冒回归风险。
import { GraphicLine, GraphicPath, JpNumber, JpOctaveDot, Lyric, PageItem, SmuflText, TextFrame } from "../layout/layout";
import { Font } from "../layout/font";
import type { LayoutOptions } from "../layout/layout";
import type { DrawItem, DrawPage, DrawText } from "./drawlist";
import type { BookStyle, StyleRole } from "./bookstyle";
import { JinpuPainter } from "../layout/painter";
import type { Score } from "../score/score";
import type { MetaData } from "../smufl/smufl";

/** 2D 仿射：[a b c d e f]，与 SVG 的 matrix(a b c d e f) 同序。 */
type Mat6 = [number, number, number, number, number, number];

/** m 之后再作用 n（即先 n 后 m 的坐标变换 = m ∘ n）。 */
function concat(m: Mat6, n: Mat6): Mat6 {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const applyX = (m: Mat6, x: number, y: number) => m[0] * x + m[2] * y + m[4];
const applyY = (m: Mat6, x: number, y: number) => m[1] * x + m[3] * y + m[5];

function matOf(it: PageItem): Mat6 {
  const a = it.matrix.mat;
  // Matrix33.mat 的排布见 common/geom.ts：[scaleX, skewX, transX, skewY, scaleY, transY, …]
  return [a[0], a[3], a[1], a[4], a[2], a[5]];
}

/** 页面树里的一个叶子该按哪个角色落字（决定字体与是否走轮廓）。
 *  用 instanceof 判，不用 classes：排版件本来就有 JpNumber / Lyric / SmuflText 这些类型。 */
/** 增时线要往上挪多少，才能让它的墨迹中心与数字的墨迹中心（＝小节线中点）齐平。 */
function dashInkShift(opt: LayoutOptions): number {
  const nb = opt.numberBound("1");
  const db = opt.numberBound("-");
  return (nb.top + nb.bottom) / 2 - (db.top + db.bottom) / 2;
}

function roleOfItem(it: TextFrame, opt: LayoutOptions): StyleRole {
  // 和弦是 layout/harmony.ts 造的普通 TextFrame，只有 classes 认得出来（见那边的注释）
  if (it.classes.has("chord-music")) return "smufl";
  if (it.classes.has("chord")) return "chord";
  // 房号（1./2.）归 verseNum 那一档：字体与段号同源，**且不能算成 note**——
  // countStaffRows / measureCellsPerLine 数「占一格的音符」时会把 "1." 当成音符，
  // 一个房号就凭空多出一条谱行（010 曾因此每轮都判成折行、迭代六轮都收不住）。
  if (it.classes.has("ending")) return "verseNum";
  // 段落词（「（副歌）」）：字体与 lyric 同源，但**要认得出来**——line-check.mjs 靠这个角色
  // 检查它有没有挂出版心，混在 lyric 里就找不着了。
  if (it.classes.has("section-word")) return "sectionWord";
  if (it instanceof SmuflText) return "smufl";
  if (it instanceof JpNumber || it instanceof JpOctaveDot) return "note";
  if (it instanceof Lyric) return "lyric";
  const s = it.font?.size ?? 0;
  if (s >= opt.titleSize * 0.9) return "title";
  if (s >= opt.creditSize * 0.9) return "credit";
  return "lyric";
}

export interface ToDrawOptions {
  style: BookStyle;
  options: LayoutOptions;
  pageNo: number;
  meta: DrawPage["meta"];
  /** 页面树的坐标单位 → pt 的缩放（排版用 px，成书要 pt）。 */
  scale?: number;
  /** 整页平移（pt）。成书首页要给标题块让出位置——**在这里平移**，
   *  而不是回头去改 DrawList：路径的坐标已经烘进 `d` 里，事后平移得重解析一遍。 */
  offset?: { x: number; y: number };
}

/** 页面树 → 扁平 DrawList。展开 matrix、逐字实测笔位、颜色照抄。 */
export function pageItemsToDrawPage(root: PageItem | undefined, w: number, h: number, o: ToDrawOptions): DrawPage {
  const items: DrawItem[] = [];
  const k = o.scale ?? 1;
  const off = o.offset ?? { x: 0, y: 0 };
  const base: Mat6 = [k, 0, 0, k, off.x, off.y];

  const walk = (it: PageItem, parent: Mat6): void => {
    const m = concat(parent, matOf(it));
    emit(it, m);
    for (const ch of it.children) walk(ch, m);
  };

  const emit = (it: PageItem, m: Mat6): void => {
    if (it instanceof GraphicPath) {
      const d = pathData(it, m);
      if (d) items.push({ t: "path", d, fill: it.fill ? argbToRgb(it.fillColor) : null, stroke: it.stroke ? argbToRgb(it.strokeColor) : null, sw: it.stroke ? it.strokeWidth * scaleOf(m) : 0 });
      return;
    }
    if (it instanceof GraphicLine) {
      items.push({
        t: "line",
        x1: applyX(m, it.p0.x, it.p0.y),
        y1: applyY(m, it.p0.x, it.p0.y),
        x2: applyX(m, it.p1.x, it.p1.y),
        y2: applyY(m, it.p1.x, it.p1.y),
        sw: it.strokeWidth * scaleOf(m),
        color: argbToRgb(it.strokeColor),
      });
      return;
    }
    if (it instanceof TextFrame) {
      if (!it.text) return;
      const chars = [...it.text];
      // 逐字笔位用**浏览器实测的 advance 前缀和**：落位就是排版器排的那一版，
      // Node 侧字体度量的微差不再影响布局。
      const xs = chars.map((_, i) => applyX(m, it.measureText(0, i), 0));
      // 增时线**按墨迹与数字（以及小节线中点）对齐**：Times 的连字符墨迹挂得比数字中线低
      //（实测差 1.37pt），照字体基线摆就一排音符里高一道低一道。
      // 只在**画的时候**补这一下——排版度量（entry 高度、纵向栅格、行容量）不能动，
      // 那是「简谱纵向栅格」那把统一的尺子。
      const role0 = roleOfItem(it, o.options);
      const dy = role0 === "note" && (it.text === "-" || it.text === "\u2013") ? dashInkShift(o.options) : 0;
      const y = applyY(m, 0, 0);
      const t: DrawText = {
        t: "text",
        y,
        ...(dy ? { dy } : {}),
        text: it.text,
        size: (it.font?.size ?? 10) * scaleOf(m),
        role: role0,
        align: "pen",
        xs,
        color: argbToRgb(it.color),
      };
      items.push(t);
    }
  };

  if (root) walk(root, base);
  return { pageNo: o.pageNo, w: w * k, h: h * k, meta: o.meta, items };
}

/** 等比缩放系数（页面树里只有平移与等比缩放，见 layout.ts 的 SmuflText / harmony）。 */
function scaleOf(m: Mat6): number {
  return Math.hypot(m[0], m[1]) || 1;
}

function argbToRgb(argb: number): number {
  return argb & 0xffffff;
}

/** GraphicPath 的 segs → 变换后的 SVG path（坐标烘进去，DrawPath 不带 transform）。 */
function pathData(p: GraphicPath, m: Mat6): string {
  let d = "";
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  for (const seg of p.segs) {
    if (seg.op === "Z") {
      d += "Z";
      continue;
    }
    const pts: string[] = [];
    for (let i = 0; i + 1 < seg.pts.length; i += 2) {
      pts.push(`${f(applyX(m, seg.pts[i], seg.pts[i + 1]))} ${f(applyY(m, seg.pts[i], seg.pts[i + 1]))}`);
    }
    d += `${seg.op}${pts.join(" ")}`;
  }
  return d;
}

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
export function applyBookStyle(opt: LayoutOptions, s: BookStyle): void {
  const note = fontSizeFor(s, "note");
  const lyric = fontSizeFor(s, "lyric");
  const em = (v: number) => v * s.roles.note.size;

  opt.applyFontSize(lyric);
  opt.lrcFont = new Font(fontFamilyOf(s, "lyric"), lyric);
  opt.numberFont = new Font(fontFamilyOf(s, "note"), note);
  opt.smuflFont = new Font(fontFamilyOf(s, "smufl"), note);
  opt.titleSize = fontSizeFor(s, "title");
  opt.creditSize = fontSizeFor(s, "credit");

  const m = s.metrics;
  opt.marginLeft = s.page.margin.inner;
  opt.marginRight = s.page.margin.outer;
  opt.marginTop = s.page.margin.top;
  opt.marginBottom = s.page.margin.bottom;
  opt.jpStackGap = em(m.stackGapEm);
  opt.jpBeamTop = em(m.divLineGapEm);
  opt.jpBeamDist = em(m.divLineStepEm);
  // 减时线用**原书实测的墨迹宽**（0.19pt 上下）：它本来就是一条细线，
  // 引擎那个 1.5（按 fontSize≈28 调的）换算过来会粗上两三倍。
  // 弧与小节线不同——那两个是有形状的笔画，按字号等比缩放才对（见下）。
  opt.jpBeamWidth = m.inkDivLineWidth > 0 ? m.inkDivLineWidth : m.beamWidthEm * lyric;
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

/** 占一格的音符：数字（含**带附点的** `5·`、休止 `0`）与增时线。
 *  八度点（`.`）也是 note 角色，但它在音符上/下方、自成一「行」，不能算格。
 *  **附点必须算进来**——漏掉它会把容量少算三成（012《主我感激祢》量出 15 格、实际放得下 22）。 */
const isCellNote = (t: string): boolean => /^[0-9]/.test(t) || t === "-" || t === "\u2013";

/** 数一份 DrawList 里有几条谱行（按音符的基线分组；只数占一格的数字与增时线）。
 *  **要按页分组**：各页的谱行落在同样几条基线上，把全书的 y 混进一个集合，
 *  第二页起的行就被当成第一页那几行、行数少算（rebuild 的「有没有被二次折行」保险因此漏判）。 */
export function countStaffRows(pages: DrawPage[]): number {
  let n = 0;
  for (const p of pages) {
    const ys = new Set<number>();
    for (const it of p.items)
      if (it.t === "text" && it.role === "note" && isCellNote(it.text)) ys.add(Math.round(it.y));
    n += ys.size;
  }
  return n;
}

/** 一份 DrawList 里**最长的那条谱行**有几格。
 *  容量（`measureCellsPerLine`）是空排量出来的近似，同样的格数、歌词字多的行就更宽；
 *  量偏了排版器会在断点之外又折一刀。折完之后**最长的那条行**才是这一首的真容量，
 *  rebuild 的重排迭代拿它当新的格数上限（按比例收紧会一步收过头：022 曾从 30 收到 15）。 */
export function maxStaffRowCells(pages: DrawPage[]): number {
  let mx = 0;
  for (const p of pages) {
    const per = new Map<number, number>();
    for (const it of p.items) {
      if (it.t !== "text" || it.role !== "note" || !isCellNote(it.text)) continue;
      const k = Math.round(it.y);
      per.set(k, (per.get(k) ?? 0) + 1);
    }
    for (const v of per.values()) mx = Math.max(mx, v);
  }
  return mx;
}

/**
 * 空排一遍，量出「一行放得下几格」。
 *
 * 格 = 简谱横向占位（一个音符 1 格，长音的每根增时线各占 1 格）。
 * 乐句排版要按这个数定行长，否则它算出来的行长与排版器实际能放的对不上，
 * 排版器会在小节中间再折一次，行尾挂着孤零零一个音。
 */
export function measureCellsPerLine(score: Score, style: BookStyle, smuflMeta?: MetaData): number {
  const p = new JinpuPainter(fontSizeFor(style, "lyric"));
  applyBookStyle(p.layout.options, style);
  // 不注入的话 layout 会在延长号/跳转记号上抛 "no smufl bbox"
  if (smuflMeta) p.layout.options.smuflMeta = smuflMeta;
  // **先清掉原谱的换行**：不清的话排版器照 musicxml 的 `<print new-system>` 分行，
  // 量到的是「原书每行几格」而不是「一行放得下几格」——005《荣耀归与天父》原书那几行是
  // 30/26/27/17 格，量出 27，可它其实放得下 30。清掉之后排版器才真的按宽度塞满再折行。
  score.clearSystemBreak();
  p.score = score;
  p.resize(style.page.w, style.page.h, null);
  const opt = p.layout.options;
  const cw = style.page.w - opt.marginLeft - opt.marginRight;

  // 真的排一遍再量：一格多宽由排版器的 entry 宽度决定（歌词字宽 + 音符间距 + 各种避让），
  // 不是「歌词字宽」那么简单——照字宽估会高估一倍，乐句断点算出的行长排版器根本放不下。
  // **按行分组**再量：全页的 x 混在一起排序，跨行的 x 会回绕，
  // 相邻差就成了八度点那种零点几个点的值（实测中位数 3.2pt，格数算出 98）。
  const byRow = new Map<string, number[]>();
  for (let i = 1; i < p.pageCount; i++) {
    const dp = pageItemsToDrawPage(p.layout.pages[i], style.page.w, style.page.h, {
      style,
      options: opt,
      pageNo: i,
      meta: { kind: "score", songs: [] },
    });
    for (const it of dp.items) {
      // 只数**占一格**的：数字与增时线。八度点（"."）也是 note 角色，
      // 但它在音符上/下方、自成一「行」，混进来会把行的计数搅乱。
      if (it.t !== "text" || it.role !== "note" || !isCellNote(it.text)) continue;
      // 按**页 + 基线**分组：各页的谱行落在同样几条基线上，只用 y 会把跨页的行并成一行、计数翻倍
      const key = `${i}:${Math.round(it.y)}`;
      const a = byRow.get(key) ?? [];
      a.push(it.xs[0]);
      byRow.set(key, a);
    }
  }
  // 空排（已清掉原谱换行）时排版器是**按宽度塞满**再折行的，所以「装得最多的那一行」就是容量。
  // 比按字宽估、或按相邻 x 差的中位数算都可靠——那些量法会被八度点、附点、
  // 增时线这些同格里的小东西带偏（实测中位数法算出 98 格，实际只放得下 13）。
  // 取**最大值**：塞满折行后每行都顶着版心宽，只有末行短，中位数反而被末行拖低
  //（005 塞满后各行 30 格上下、末行短，中位数只有 27，于是「赞美主…」那两句并不到一行去）。
  const counts = [...byRow.values()].map((r) => r.length).sort((a, b) => a - b);
  const cells = counts.length ? counts[counts.length - 1] : 0;
  return Math.max(6, cells || Math.floor(cw / opt.lrcFont.measureText("国")));
}
