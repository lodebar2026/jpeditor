// DrawList：**两条重排路与 PDF 输出之间的唯一契约**。
//
//   A 路 relayout（原位替换）：PageSpec + BookStyle → specToDrawPage → DrawPage
//   B 路 rebuild（数据重排）  ：PageItem 树 + BookStyle → pageItemsToDrawPage（浏览器侧）→ DrawPage
//   两路汇合 → scripts/pdfwrite.mjs 写 PDF
//
// 为什么不是 SVG 字符串：排版引擎必须在浏览器里跑（common/measure.ts 的 getBBox），
// pdf-lib 只能在 Node。SVG 要在 Node 侧反解 transform 嵌套与字体度量，等于把 painter 再写一遍；
// 而页面树本来就只有三种叶子，扁平化一次就完事。
//
// 坐标一律 **SVG 系**（左上原点、y 向下、单位 pt），y 轴翻转只在 pdfwrite 里做一次。
//
// 无 DOM 依赖。
import type { PageSpec, TextRun, PageKind } from "./spec";
import type { AlignMode, BookStyle, StyleRole } from "./bookstyle";
import { roleOf } from "./bookstyle";

export interface DrawText {
  t: "text";
  /** 基线 y。 */
  y: number;
  text: string;
  size: number;
  role: StyleRole;
  align: AlignMode;
  /** 逐字 x。语义随 align：
   *  - `pen`：就是笔位（B 路，浏览器实测的 advance 前缀和）
   *  - 其余：**墨迹左缘**（A 路，原件量到的），pdfwrite 按 align 与字体度量换算成笔位 */
  xs: number[];
  /** 逐字墨迹宽（A 路才有，inkCenter 要用）。 */
  ws?: number[];
  /** 整 run 的墨迹包络（left 对齐时用来判自然宽是否失配）。 */
  box?: { x: number; w: number };
  color?: number;
  songId?: string | null;
}

export interface DrawPath {
  t: "path";
  d: string;
  fill?: number | null;
  stroke?: number | null;
  sw?: number;
  dash?: number[] | null;
}

export interface DrawRect {
  t: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: number | null;
  stroke?: number | null;
  sw?: number;
}

export interface DrawLine {
  t: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  sw: number;
  color?: number;
}

export type DrawItem = DrawText | DrawPath | DrawRect | DrawLine;

export interface DrawPage {
  pageNo: number;
  w: number;
  h: number;
  meta: {
    kind: PageKind;
    songs: { id: string | null; title: string | null; first: boolean }[];
    /** 页面上印的页码文本（A 路照抄原件，B 路重新生成）。 */
    pageLabel?: string | null;
  };
  items: DrawItem[];
}

export interface DrawBook {
  style: BookStyle;
  source: "relayout" | "rebuild";
  pages: DrawPage[];
}

export interface SpecToDrawOptions {
  /** 读不出的字形（PageSpec 里是 "�"）按形状键回填。 */
  fallbackChar?: (key: string) => string | null;
  /** 次号歌词的分档阈值（pt）。默认 lyric 字号 − 0.6。 */
  lyric2Cut?: number;
}

export interface SpecToDrawResult {
  page: DrawPage;
  /** 回填成功数 / 仍然读不出的字数。 */
  filled: number;
  unread: number;
  /** 字号偏离同类型中位数太多、保留了原字号的 run 数。 */
  keptOwnSize: number;
  /** 仍然读不出的字形：形状键 + 它出现在哪个角色里。落库供人工补（校对.db 的 unread_glyph）。 */
  unreadKeys: { key: string; role: StyleRole }[];
}

const UNREAD = "�";

/** 谱行上方那一带既有和弦也有署名（spec 把它们一起放进 chordLines），按非 ASCII 占比分开。
 *  与 stats.ts 的同名判据必须一致，否则统计出来的字号会套错角色。 */
export function chordLineRole(run: TextRun): StyleRole {
  const t = run.text.replace(/\s/g, "");
  if (!t) return "chord";
  const cjk = [...t].filter((c) => c.charCodeAt(0) > 0x2e7f).length;
  return cjk / t.length > 0.4 ? "credit" : "chord";
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** 一行的主字高（剔掉标点与上标）。与 stats.ts 的 runBodyHeight 同义。 */
function bodyHeight(run: TextRun): number {
  const hs = run.chars.filter((c) => c.h > 0).map((c) => c.h);
  if (!hs.length) return 0;
  const m = median(hs);
  return median(hs.filter((h) => h >= m)) || m;
}

export function specToDrawPage(spec: PageSpec, style: BookStyle, opt: SpecToDrawOptions = {}): SpecToDrawResult {
  const items: DrawItem[] = [];
  let filled = 0;
  let unread = 0;
  let keptOwnSize = 0;
  const unreadKeys: { key: string; role: StyleRole }[] = [];
  const lyric2Cut = opt.lyric2Cut ?? style.roles.lyric.size - 0.6;

  // ── 线框：image/shading 这一版不还原（原件里各只有 1 处，另走原样嵌入）
  for (const f of spec.frames) {
    if (f.type === "image" || f.type === "shading") continue;
    items.push({ t: "rect", x: f.box.x, y: f.box.y, w: f.box.w, h: f.box.h, fill: 0x000000 });
  }

  // ── 乐谱记号：曲线类照原路径画，直线类按包围盒画（坐标已是设备坐标）
  for (const m of spec.marks) {
    if (m.d) items.push({ t: "path", d: m.d, fill: 0x000000, dash: m.dash });
    else
      items.push({
        t: "rect",
        x: m.box.x,
        y: m.box.y,
        w: Math.max(m.box.w, 0.15),
        h: Math.max(m.box.h, 0.15),
        fill: 0x000000,
      });
  }

  // ── 文字
  const addRun = (run: TextRun | null | undefined, role: StyleRole, songId: string | null = null): void => {
    if (!run || !run.chars.length) return;
    const roleStyle = roleOf(style, role);
    const body = bodyHeight(run);
    // 字号一律取**同类型中位数**（这就是「保留原书字号特征」的落法）；
    // 只有当这一行明显不属于该档（差 25% 以上）时才保留它自己的字号，
    // 否则像目录里混排的大小字会被强行拉平。
    let size = roleStyle.size;
    if (body > 0 && Math.abs(body - roleStyle.size) / roleStyle.size > 0.25) {
      size = Number(body.toFixed(2));
      keptOwnSize++;
    }
    const chars = run.chars;
    const text: string[] = [];
    for (const c of chars) {
      let ch = c.ch;
      // 字典里混着几个控制字符（"=" 被学成 U+0000 那类）。它们写进 PDF 就是乱码，
      // 一律当作没读出来，走回填/留空那条路。
      if (ch && ch.charCodeAt(0) < 0x20) ch = UNREAD;
      if (ch === UNREAD || !ch) {
        const got = opt.fallbackChar?.(c.key) ?? null;
        if (got) {
          ch = got;
          filled++;
        } else {
          ch = " "; // 读不出的字留空位，绝不写问号
          unread++;
          unreadKeys.push({ key: c.key, role });
        }
      }
      text.push(ch);
    }
    const joined = text.join("");
    if (!joined.trim()) return;
    const x0 = Math.min(...chars.map((c) => c.x));
    const x1 = Math.max(...chars.map((c) => c.x + c.w));
    items.push({
      t: "text",
      y: run.baselineY - roleStyle.baselineAdjust * size,
      text: joined,
      size,
      role,
      align: roleStyle.align,
      xs: chars.map((c) => c.x),
      ws: chars.map((c) => c.w),
      box: { x: x0, w: x1 - x0 },
      songId,
    });
  };

  addRun(spec.header, "header");
  addRun(spec.footer, "footer");
  const textRole: StyleRole = spec.kind === "toc" || spec.kind === "index" ? "toc" : "story";
  for (const t of spec.textLines) addRun(t, textRole);
  for (const b of spec.storyBoxes) for (const l of b.lines) addRun(l, "story");

  for (const s of spec.songs) {
    addRun(s.numberRun, "songNumber", s.id);
    addRun(s.titleRun, "title", s.id);
    addRun(s.keyMeterRun, "keyMeter", s.id);
    addRun(s.categoryRun, "category", s.id);
    for (const c of s.creditRuns) addRun(c, "credit", s.id);
    for (const y of s.systems) {
      for (const c of y.chordLines) addRun(c, chordLineRole(c), s.id);
      for (const l of y.lyricLines) addRun(l, bodyHeight(l) < lyric2Cut ? "lyric2" : "lyric", s.id);
      // 音符不是「一行文字」，但逐字定位的写法完全一样：合成一个 run 交给同一条路。
      const noteMed = median(y.notes.filter((n) => n.h > 0).map((n) => n.h));
      const small = y.notes.filter((n) => noteMed > 0 && n.h < noteMed * 0.72);
      const big = y.notes.filter((n) => !(noteMed > 0 && n.h < noteMed * 0.72));
      const asRun = (ns: typeof y.notes): TextRun | null =>
        ns.length
          ? {
              text: ns.map((n) => n.ch).join(""),
              box: { x: 0, y: 0, w: 0, h: 0 },
              baselineY: median(ns.map((n) => n.y + n.h)),
              size: median(ns.map((n) => n.h)),
              chars: ns,
            }
          : null;
      addRun(asRun(big), "note", s.id);
      addRun(asRun(small), "tuplet", s.id);
    }
  }

  // 文字按阅读顺序（先上后下、再左到右）——PDF 里的文本顺序顺了，才搜得出词。
  const texts = items.filter((i): i is DrawText => i.t === "text").sort((a, b) => a.y - b.y || a.xs[0] - b.xs[0]);
  const others = items.filter((i) => i.t !== "text");

  return {
    page: {
      pageNo: spec.page,
      w: spec.size[0],
      h: spec.size[1],
      meta: {
        kind: spec.kind,
        songs: spec.songs.map((s) => ({ id: s.id, title: s.gtTitle ?? s.titleRun?.text ?? null, first: s.startsHere })),
        pageLabel: spec.footer?.text ?? null,
      },
      items: [...others, ...texts],
    },
    filled,
    unread,
    keptOwnSize,
    unreadKeys,
  };
}

/** 每个角色各画了多少字（报告与回归用）。 */
export function drawPageStats(p: DrawPage): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of p.items) {
    if (it.t === "text") out[it.role] = (out[it.role] ?? 0) + [...it.text].length;
    else out[it.t] = (out[it.t] ?? 0) + 1;
  }
  return out;
}
