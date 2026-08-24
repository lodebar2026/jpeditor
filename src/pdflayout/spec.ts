// 版面规格：把一页的矢量内容整理成「足以照着排回去」的结构化描述。
//
// 与 inventory.ts 的分工：inventory 回答「这个对象是什么」，本文件回答
// 「这一页由哪些版面元素构成、各在什么位置、写着什么字」。
//
// 要求是**不漏内容、不漏格式**：页面上每一个对象都要落到某个字段里，
// `coverage.unplaced` 是硬指标。
//
// 无 DOM 依赖（Node CLI 要用）。
import type { Rect } from "../omr/types";
import type { ClassifiedObj, ObjClass, PageInventory } from "../omr/inventory";
import { toSvgPathTransformed } from "../omr/vector";
import type { VecPage } from "../omr/vector";

/** 一段文字：位置、字号、逐字 x（重排时逐字定位要用）。 */
export interface TextRun {
  text: string;
  box: Rect;
  /** 基线 y（取该行字形下缘的中位数）。 */
  baselineY: number;
  /** 字号（轮廓高度中位数）。 */
  size: number;
  /** 逐字：**各自的**位置与尺寸、字符，以及原字形的形状键。
   *  - `key`：保真复现（relayout --mode=outline）靠它取回原件的轮廓。不能走
   *    「字符 → 代表字形」那一层：读不出的字没有代表字形，同字不同字号也会串。
   *  - `y`/`h` 要逐字记，不能用整行的中位数：标点只占字格下部、歌词里的「一」悬在字格中部，
   *    拿行中位数去摆它们，位置会差出好几个点。 */
  chars: { x: number; y: number; w: number; h: number; ch: string; key: string }[];
}

/** 版面线框。 */
export interface FrameSpec {
  type: "rule-h" | "rule-v" | "box" | "ornament" | "bracket" | "image" | "shading";
  box: Rect;
  lineWidth: number;
  dash: number[] | null;
  /** ornament：纹样片数与单片尺寸，重排时照着铺。 */
  tiles?: number;
  tileW?: number;
  tileH?: number;
}

/** 歌谱后的带花边文字框（圣诗故事 / 经文 / 注解）。 */
export interface StoryBox {
  box: Rect;
  frame: FrameSpec;
  lines: TextRun[];
}

/** 一首歌在本页的落位。 */
export interface SongPlacement {
  id: string | null;
  /** GT 里的曲名（映射得到），与 titleRun.text 可对照。 */
  gtTitle: string | null;
  startsHere: boolean;
  yFrom: number;
  yTo: number;
  numberRun: TextRun | null;
  titleRun: TextRun | null;
  /** 调号拍号「1=F 4/4 (1=D)」。印在第一谱行上方，与和弦同一带，靠等号认出来。 */
  keyMeterRun: TextRun | null;
  categoryRun: TextRun | null;
  creditRuns: TextRun[];
  /** 谱行：位置 + 小节线 + 逐音符 x。 */
  systems: {
    index: number;
    noteTop: number;
    noteBottom: number;
    x0: number;
    x1: number;
    barlineXs: number[];
      notes: { x: number; y: number; w: number; h: number; ch: string; key: string }[];
    /** 谱行上方的和弦/署名，按行分组——那一带常常不止一行（和弦一行、词曲署名两行），
     *  并成一个 run 会让几行的字交错，PDF 里就搜不出「作词：某某」了。 */
    chordLines: TextRun[];
    lyricLines: TextRun[];
  }[];
}

/** 乐谱记号：减时线/增时线/小节线/圆滑线/各种点。不是字，重排时按几何原样画。 */
export interface MarkSpec {
  cls: string;
  box: Rect;
  lineWidth: number;
  dash: number[] | null;
  /** 曲线类（圆滑线、花边纹样）才存路径；直线类靠 box 就能画回去。
   *  坐标**已套上 ctm**（设备坐标），这样不支持 transform 的消费方（pdf-lib）也能直接用。 */
  d?: string;
}

export type PageKind = "cover" | "front-matter" | "toc" | "index" | "score" | "blank" | "unknown";

export interface PageSpec {
  page: number;
  size: [number, number];
  rotation: number;
  kind: PageKind;
  songs: SongPlacement[];
  header: TextRun | null;
  footer: TextRun | null;
  /** 目录 / 索引 / 前言页的正文行。**只收文字**，乐谱记号在 `marks` 里。 */
  textLines: TextRun[];
  /** 乐谱记号（减时线/小节线/圆滑线/点…）。 */
  marks: MarkSpec[];
  storyBoxes: StoryBox[];
  frames: FrameSpec[];
  /** 未转曲的真实文字对象（这一页有文字层）。 */
  hasRawText: boolean;
  coverage: {
    total: number;
    byClass: Record<string, number>;
    /** 没被任何字段收进去的对象数。
     *  注意：`textLines` 是兜底字段，会把所有剩下的对象都收走，所以这个数**结构上恒为 0**，
     *  别拿它当「都看懂了」的凭据。真正说明问题的是下面的 `fallback`，
     *  以及 relayout --mode=outline 的对象级核对。 */
    unplaced: number;
    /** 只被 `textLines` 兜底收走、没能落进任何结构化字段（曲目/页眉/页脚/花边框）的对象数。
     *  这才是「还没被理解」的那部分。 */
    fallback: number;
    /** 读不出字符的字形数。 */
    unread: number;
  };
}

const bottom = (r: Rect) => r.y + r.h;
const right = (r: Rect) => r.x + r.w;

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function unionBox(rs: Rect[]): Rect {
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map(right));
  const y1 = Math.max(...rs.map(bottom));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 读字符的回调：对象 → { 字符（读不出给 null）, 形状键 }。 */
export type CharLookup = (o: ClassifiedObj) => { ch: string | null; key: string };

/** 一组对象 → TextRun（按 x 排序，逐字记位置）。 */
export function toTextRun(objs: ClassifiedObj[], lookup: CharLookup): TextRun | null {
  if (!objs.length) return null;
  const sorted = [...objs].sort((a, b) => a.obj.bbox.x - b.obj.bbox.x);
  const chars = sorted.map((o) => {
    const r = lookup(o);
    return {
      x: Math.round(o.obj.bbox.x * 100) / 100,
      y: Math.round(o.obj.bbox.y * 100) / 100,
      w: Math.round(o.obj.bbox.w * 100) / 100,
      h: Math.round(o.obj.bbox.h * 100) / 100,
      ch: r.ch ?? "�",
      key: r.key,
    };
  });
  const boxes = sorted.map((o) => o.obj.bbox);
  return {
    text: chars.map((c) => c.ch).join(""),
    box: unionBox(boxes),
    // 行基线取中位数，且「一」用它的参照基线参与（见 baseOf）——否则一行里有几个「一」
    // 就会把整行的基线拉高。
    baselineY: Math.round(median(sorted.map(baseOf)) * 100) / 100,
    size: Math.round(median(boxes.map((b) => b.h)) * 100) / 100,
    chars,
  };
}

/** 归行用的基线：一般取字形下缘；`lyricYi`（歌词里的「一」）只有一横、悬在字格中部，
 *  它的下缘比同行汉字高半个字，得用 inventory 记下的参照基线，否则自成一行。 */
const baseOf = (o: ClassifiedObj) => o.baseline ?? bottom(o.obj.bbox);

/** 按**下缘**（基线）把对象聚成行。标点只占字格下部，按顶边聚会把它们拆成独立行。 */
export function groupLines(objs: ClassifiedObj[], tol = 4): ClassifiedObj[][] {
  const sorted = [...objs].sort((a, b) => baseOf(a) - baseOf(b));
  const lines: { y: number; items: ClassifiedObj[] }[] = [];
  for (const o of sorted) {
    const last = lines[lines.length - 1];
    if (last && baseOf(o) - last.y <= tol) last.items.push(o);
    else lines.push({ y: baseOf(o), items: [o] });
  }
  return lines.map((l) => l.items.sort((a, b) => a.obj.bbox.x - b.obj.bbox.x));
}

/** pagemap 里的一条。 */
export interface PageMapEntry {
  page: number;
  id: string;
  title: string;
  startsHere: boolean;
  yFrom?: number;
  yTo?: number;
}

/**
 * 组装一页的版面规格。
 *
 * `entries` 是 pagemap 里落在本页的那些条目（一页可能不止一首，也可能是别人的续页）。
 * 归类结果 `inv` 已经带足了尺度信息（谱行带、花边框），这里不再需要 profile。
 */
export function buildPageSpec(
  vec: VecPage,
  inv: PageInventory,
  lookup: CharLookup,
  entries: PageMapEntry[] = [],
): PageSpec {
  const used = new Set<ClassifiedObj>();
  const take = (o: ClassifiedObj) => {
    used.add(o);
    return o;
  };
  const pick = (cls: ObjClass, yFrom = -Infinity, yTo = Infinity) =>
    inv.objs.filter((o) => o.cls === cls && !o.dup && o.obj.bbox.y >= yFrom && o.obj.bbox.y < yTo).map(take);
  // dup（重复描边）不进任何 run，但要算作已安置——它是本体的影子
  for (const o of inv.objs) if (o.dup) used.add(o);

  const header = toTextRun(pick("category"), lookup);
  const footer = toTextRun(pick("footer"), lookup);

  // ── 花边框
  const storyBoxes: StoryBox[] = inv.ornaments.map((orn) => {
    const inside = inv.objs.filter(
      (o) =>
        !o.dup &&
        (o.cls === "storyText" || o.cls === "textLine") &&
        o.obj.bbox.x >= orn.box.x &&
        o.obj.bbox.y >= orn.box.y &&
        right(o.obj.bbox) <= right(orn.box) &&
        bottom(o.obj.bbox) <= bottom(orn.box),
    );
    for (const o of inside) used.add(o);
    return {
      box: orn.box,
      frame: { type: "ornament", box: orn.box, lineWidth: 0, dash: null, tiles: orn.tiles, tileW: orn.tileW, tileH: orn.tileH },
      lines: groupLines(inside)
        .map((ln) => toTextRun(ln, lookup))
        .filter((r): r is TextRun => !!r),
    };
  });
  // 注意别在这里把 ornament 标成已用——花边纹样要由下面的 marks 收，
  // 提前标掉就谁也不收它们了（全书 9324 个纹样会凭空消失在重排结果里）。

  // ── 线框
  const frames: FrameSpec[] = [];
  for (const o of inv.objs) {
    if (o.dup) continue;
    if (o.cls === "frame" || o.cls === "rule" || o.cls === "bracket") {
      const b = o.obj.bbox;
      frames.push({
        type: o.cls === "frame" ? "box" : o.cls === "bracket" ? "bracket" : b.w >= b.h ? "rule-h" : "rule-v",
        box: b,
        lineWidth: Math.round(o.obj.lineWidth * 100) / 100,
        dash: o.obj.dash,
      });
      used.add(o);
    }
  }
  for (const im of vec.extras.images) frames.push({ type: "image", box: im.bbox, lineWidth: 0, dash: null });
  for (const sh of vec.extras.shadings) if (sh.bbox) frames.push({ type: "shading", box: sh.bbox, lineWidth: 0, dash: null });

  // ── 曲目落位
  const songs: SongPlacement[] = [];
  const spans = entries.length ? entries : [];
  for (const e of spans) {
    const yFrom = e.yFrom ?? 0;
    const yTo = e.yTo ?? vec.height;
    const systems = inv.bands
      .filter((b) => b.noteTop >= yFrom && b.noteTop < yTo)
      .map((b) => {
        // 必须跳过已被收走的对象：同一页有多条 pagemap 条目（续页 + 新曲）时，
        // 两个 song 的 systems 可能圈到同一个谱行，不去重就会把那一行的字收两遍
        //（重排核对里表现为凭空多出的对象）。
        const inBand = (cls: ObjClass) =>
          inv.objs.filter((o) => o.cls === cls && !o.dup && o.row === b.index && !used.has(o)).map(take);
        const notes = inBand("note").sort((a, b2) => a.obj.bbox.x - b2.obj.bbox.x);
        const chordObjs = inBand("chord");
        // 「一」也是歌词字（inventory 单列成 lyricYi 只因为它的轮廓与短圆滑线同形）。
        // 不收的话它会掉进 textLines 兜底，重排出来歌词就少字：「一生一世」变成「生世」。
        const lyricObjs = [...inBand("lyric"), ...inBand("lyricYi")];
        return {
          index: b.index,
          noteTop: Math.round(b.noteTop * 100) / 100,
          noteBottom: Math.round(b.noteBottom * 100) / 100,
          x0: Math.round(b.x0 * 100) / 100,
          x1: Math.round(b.x1 * 100) / 100,
          barlineXs: b.barlineXs.map((x) => Math.round(x * 100) / 100),
          notes: notes.map((o) => {
            const r = lookup(o);
            return {
              x: Math.round(o.obj.bbox.x * 100) / 100,
              y: Math.round(o.obj.bbox.y * 100) / 100,
              w: Math.round(o.obj.bbox.w * 100) / 100,
              h: Math.round(o.obj.bbox.h * 100) / 100,
              ch: r.ch ?? "�",
              key: r.key,
            };
          }),
          chordLines: groupLines(chordObjs)
            .map((ln) => toTextRun(ln, lookup))
            .filter((r): r is TextRun => !!r),
          lyricLines: groupLines(lyricObjs)
            .map((ln) => toTextRun(ln, lookup))
            .filter((r): r is TextRun => !!r),
        };
      });
    songs.push({
      id: e.id,
      gtTitle: e.title,
      startsHere: e.startsHere,
      yFrom,
      yTo,
      numberRun: toTextRun(pick("songNumber", yFrom, yTo), lookup),
      titleRun: toTextRun(pick("title", yFrom, yTo), lookup),
      keyMeterRun: toTextRun(pick("keyMeter", yFrom, yTo), lookup),
      categoryRun: null,
      creditRuns: groupLines(pick("credit", yFrom, yTo))
        .map((ln) => toTextRun(ln, lookup))
        .filter((r): r is TextRun => !!r),
      systems,
    });
  }

  // ── 乐谱记号：不是字，按几何原样记下来。
  //    **必须在 textLines 之前收走**，否则它们会被当成「剩余的文字」收进文本行，
  //    重排时和记号那条路径重复画一遍（核对里表现为凭空多出的对象）。
  const MARKS = new Set(["divLine", "augmentLine", "barline", "slur", "octaveDot", "augmentDot", "repeatDot", "ornament"]);
  const marks: MarkSpec[] = [];
  for (const o of inv.objs) {
    if (o.dup || used.has(o) || !MARKS.has(o.cls)) continue;
    used.add(o);
    const curved = o.obj.curves > 0;
    marks.push({
      cls: o.cls,
      box: o.obj.bbox,
      lineWidth: Math.round(o.obj.lineWidth * 100) / 100,
      dash: o.obj.dash,
      ...(curved ? { d: toSvgPathTransformed(o.obj.data, o.obj.ctm) } : {}),
    });
  }

  // ── 目录 / 索引 / 前言等纯文字页
  const rest = inv.objs.filter((o) => !used.has(o) && !o.dup);
  const textLines = groupLines(rest)
    .map((ln) => {
      for (const o of ln) used.add(o);
      return toTextRun(ln, lookup);
    })
    .filter((r): r is TextRun => !!r);

  // ── 页型
  // 页型。目录/索引的判据不能只看 tocEntry 计数——那一类只在「整页无谱行」时才兜底赋值，
  // 而目录页偶尔会因为引导点线判出零星谱行。改看**行尾是不是页码**：
  // 目录与首句索引每一行都以页码收尾，前言/说明页不会。
  const leaderN = inv.counts.leader ?? 0;
  const tailNumbers = textLines.filter((l) => /\d\s*$/.test(l.text)).length;
  let kind: PageKind = "unknown";
  if (vec.extras.shadings.length) kind = "cover";
  else if (!inv.objs.length) kind = vec.extras.images.length ? "front-matter" : "blank";
  else if (songs.length) kind = "score";
  else if (
    textLines.length >= 20 &&
    ((inv.counts.tocEntry ?? 0) > 50 || leaderN > 10 || tailNumbers >= textLines.length * 0.5)
  )
    kind = leaderN > 10 ? "toc" : "index";
  else kind = "front-matter";

  const byClass: Record<string, number> = {};
  for (const o of inv.objs) byClass[o.cls] = (byClass[o.cls] ?? 0) + 1;
  const allRuns = [
    header,
    footer,
    ...textLines,
    ...storyBoxes.flatMap((s) => s.lines),
    ...songs.flatMap((s) => [s.numberRun, s.titleRun, ...s.creditRuns, ...s.systems.flatMap((y) => [...y.chordLines, ...y.lyricLines])]),
  ].filter((r): r is TextRun => !!r);
  const unread =
    allRuns.reduce((a, r) => a + (r.text.match(/�/g)?.length ?? 0), 0) +
    songs.flatMap((s) => s.systems).reduce((a, y) => a + y.notes.filter((n) => n.ch === "�").length, 0);

  return {
    page: vec.page,
    size: [Math.round(vec.width * 100) / 100, Math.round(vec.height * 100) / 100],
    rotation: vec.rotation,
    kind,
    songs,
    header,
    footer,
    textLines,
    marks,
    storyBoxes,
    frames,
    hasRawText: vec.extras.hasText,
    coverage: {
      total: inv.objs.length,
      byClass,
      unplaced: inv.objs.filter((o) => !used.has(o)).length,
      fallback: textLines.reduce((a, r) => a + r.chars.length, 0),
      unread,
    },
  };
}
