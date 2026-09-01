// 书级内容 → DrawList：把 bookmeta 提取到的东西排成页面元素。
//
//   校对.db（gen-bookmeta.mjs 写）→ **本文件** → DrawPage → scripts/pdfwrite.mjs
//
// 分工：`bookmeta.ts` 只管「原书上写着什么」，本文件只管「重排本里怎么摆」。
// 位置一律来自 BookStyle（原书实测），不在这里拍常数——除了几处标注了实测出处的比例。
//
// 文字宽度由调用方注入 `measure`（Node 侧是 scripts/textmetrics.mjs，与 pdfwrite
// 用同一份字体字节）。**无 DOM 依赖。**
import type { BookStyle, StyleRole } from "./bookstyle";
import type { DrawItem, DrawPage, DrawText } from "./drawlist";
import { pageMargins } from "./bookstyle";
import { NO_LINE_START } from "../common/cjkpunct";

export type Measure = (role: StyleRole, text: string, size: number) => number;

/** 一段字（连排，左/右/居中对齐由 align 决定）。x 的含义与 rebuild.mjs::decorate 一致：
 *  align 为 left 时是左缘，right/center 时是参考点。 */
export function textItem(text: string, role: StyleRole, size: number, x: number, y: number, align: DrawText["align"] = "left"): DrawText {
  return { t: "text", y, text, size, role, align, xs: [x], box: { x, w: 0 } };
}

// ─────────────────────────────────────────────── 调号拍号（拍号上下叠排）

export interface KeyMeterSpec {
  tonic: string;
  beats: number | null;
  beatType: number | null;
  altTonic: string | null;
}

/**
 * `1=♭B  4/4  (1=A)`：拍号是**上下叠排**，中间一条细横线。
 *
 * 各处比例是从原书量的（002 首，keyMeter 字号 8.14pt）：
 * 分数线宽 12.3pt = 1.51em、线粗 0.3pt，上排数字基线在主基线上方 0.65em、
 * 下排在下方 0.98em、线在上方 0.34em；主调与分数线之间空 0.37em。
 */
/**
 * 调号里升降号的字号比（÷ 音名字号）与基线抬升量（× 音名墨迹高）。
 *
 * **升降号写 ASCII 的 `#` / `b`**（用户口径，与和弦那边同一套）：`♯`/`♭` 那两个字符
 * 在成书用的方正字体里没有字形，排出来会回退到乐谱字体——绕个圈子又用上了 SMuFL。
 *
 * 原书 002 实测：♭ 墨迹高 6.3、音名 8.0，♭ 的墨迹**顶**比音名顶高 3.9pt。换算到 ASCII：
 * 小写 `b` 的墨迹高约 0.72 em、大写音名约 0.66 em，所以
 *   字号 = (6.3 / 8.0) × (0.66 / 0.72) ≈ 0.72 个音名字号
 *   抬升 = (0.66 × sz + 3.9 − 0.72 × 0.72 × sz) / 8.14 ≈ 0.69 个音名墨迹高
 * 抬得不够就成了「升降号与音名顶部对齐」，该高出去的那截没了。
 */
const KEY_ACC_SIZE = 0.72;
const KEY_ACC_RISE = 0.69;

export function keyMeterItems(style: BookStyle, km: KeyMeterSpec, x: number, baseline: number, measure: Measure, size?: number): DrawItem[] {
  const sz = size ?? style.roles.keyMeter.size;
  // **比例的基准是墨迹高（roles.keyMeter.size），不是字号**。两者差一个「墨迹占 em 的比例」
  // ——Times 的数字只占 0.66em，所以字号 12.05 时墨迹才 8.14。拿字号去乘这些比例，
  // 分数线会长出一半、上下两个数字各错开三个点（实测 005 首的 4 被线压住）。
  const ink = style.roles.keyMeter.size;
  const items: DrawItem[] = [];
  /**
   * 画一段带调号的文字（`1=♭B`，或括号里的移调建议 `(1=♭E)`）。
   * **升降号要比音名高、也比音名小**：连成一串文本画的话，♭ 会跟音名同基线、同字号，
   * 位置就塌下来了（见上面 KEY_ACC_* 的推导）。返回这一段的宽度。
   */
  const putTonic = (prefix: string, tonic: string, suffix: string, x0: number): number => {
    const acc = /^([♭♯])(.+)$/.exec(tonic);
    if (!acc) {
      const t = `${prefix}${tonic}${suffix}`;
      items.push(textItem(t, "keyMeter", sz, x0, baseline));
      return measure("keyMeter", t, sz);
    }
    let cur = x0;
    if (prefix) {
      items.push(textItem(prefix, "keyMeter", sz, cur, baseline));
      cur += measure("keyMeter", prefix, sz);
    }
    const accSz = sz * KEY_ACC_SIZE;
    const accCh = acc[1] === "♯" ? "#" : acc[1] === "♭" ? "b" : acc[1];
    items.push(textItem(accCh, "keyMeter", accSz, cur, baseline - ink * KEY_ACC_RISE));
    cur += measure("keyMeter", accCh, accSz) * 1.05;
    const tail = `${acc[2]}${suffix}`;
    items.push(textItem(tail, "keyMeter", sz, cur, baseline));
    cur += measure("keyMeter", tail, sz);
    return cur - x0;
  };
  let cx = x + putTonic("1=", km.tonic, "", x) + ink * 0.37;
  if (km.beats && km.beatType) {
    const ruleW = ink * 1.51;
    const top = String(km.beats);
    const bot = String(km.beatType);
    const mid = cx + ruleW / 2;
    items.push(textItem(top, "keyMeter", sz, mid - measure("keyMeter", top, sz) / 2, baseline - ink * 0.65));
    items.push(textItem(bot, "keyMeter", sz, mid - measure("keyMeter", bot, sz) / 2, baseline + ink * 0.98));
    items.push({ t: "rect", x: cx, y: baseline - ink * 0.34, w: ruleW, h: 0.3, fill: 0x000000 });
    cx += ruleW + ink * 0.32;
  }
  // 括号里的移调建议也走同一套（194 首的 `(1=♭E)`）
  if (km.altTonic) putTonic("(1=", km.altTonic, ")", cx);
  return items;
}

// ─────────────────────────────────────────────── 花边框

// 槽位与母题的定义在 bookmeta（提取侧）那边，这里只是照着画。
import { translatePath, type OrnamentTile, type TileSlot } from "./bookmeta";
export type { TileSlot };

/** 画一片花边要知道的东西。提取侧的 `OrnamentTile` 去掉 `style`（那是分组用的 id，
 *  排到版上时已经选定了一套，用不着）——字段原先在这里又抄了一遍，抄漏一个就画偏。 */
export type OrnamentTileSpec = Omit<OrnamentTile, "style">;

/**
 * 花边框：四条边各按自己的母题平铺、四角各摆一片，**拼成一条 path**。
 * 原书一个框 78 片（上下各 28、左右各 11，外加四角），当成 78 个对象画既慢又难改。
 *
 * 三件事跟老版本不同：
 *   - **四条边各有各的母题**（`slot`），不再是「横一片、竖一片」全书通用。实测 110 个框
 *     把八槽路径归一后量化到 1pt 仍有 107 套不同，老版本拿第一页那两片画了所有框。
 *   - **四角是独立的第三枚字形**，先摆角、边再排在两角之间。老版本没有角片，
 *     靠横竖边的端片各画一次互相重叠糊过去。
 *   - **`edges` 掩码**：原书有的框就是缺一条边，缺的边不画。
 *
 * 边的落点：从左角片内缘排到右角片内缘，`n` 向上凑，首末片贴死两角，`step ≤ pitch`，
 * 交叠不小于原书（原书步距 10.674 而母题宽 10.771，本来就微叠）。
 */
export function ornamentFramePath(tiles: OrnamentTileSpec[], box: { x: number; y: number; w: number; h: number }, edges = "TBLR"): string {
  const at = (s: TileSlot) => tiles.find((t) => t.slot === s);
  const parts: string[] = [];
  const x1 = box.x + box.w;
  const y1 = box.y + box.h;

  // 四角先摆：边要排在两角之间
  const corner = (s: TileSlot, cx: number, cy: number) => {
    const t = at(s);
    if (!t) return null;
    parts.push(translatePath(t.path, cx + t.ox, cy + t.oy));
    return t;
  };
  const tl = corner("tl", box.x, box.y);
  const tr = corner("tr", x1 - (at("tr")?.w ?? 0), box.y);
  const bl = corner("bl", box.x, y1 - (at("bl")?.h ?? 0));
  const br = corner("br", x1 - (at("br")?.w ?? 0), y1 - (at("br")?.h ?? 0));

  /** 一条边：在 [from, to] 之间铺 t，铺满且首末贴边。 */
  const run = (t: OrnamentTileSpec | undefined, from: number, to: number, place: (p: number) => void) => {
    if (!t) return;
    const size = t.slot === "top" || t.slot === "bottom" ? t.w : t.h;
    const span = to - from - size;
    if (span <= 0) {
      place(from);
      return;
    }
    const pitch = t.pitch > 0.01 ? t.pitch : size;
    const n = Math.max(1, Math.round(span / pitch));
    const step = span / n;
    for (let i = 0; i <= n; i++) place(from + i * step);
  };

  // 边的可用跨度：有角片就从角片内缘起，没有就贴框缘（老口径，行为不变）
  const lx = box.x + (tl?.w ?? bl?.w ?? 0);
  const rx = x1 - (tr?.w ?? br?.w ?? 0);
  const ty = box.y + (tl?.h ?? tr?.h ?? 0);
  const by = y1 - (bl?.h ?? br?.h ?? 0);

  if (edges.includes("T")) run(at("top"), lx, rx, (p) => parts.push(translatePath(at("top")!.path, p, box.y)));
  if (edges.includes("B")) run(at("bottom"), lx, rx, (p) => parts.push(translatePath(at("bottom")!.path, p, y1 - at("bottom")!.h)));
  if (edges.includes("L")) run(at("left"), ty, by, (p) => parts.push(translatePath(at("left")!.path, box.x, p)));
  if (edges.includes("R")) run(at("right"), ty, by, (p) => parts.push(translatePath(at("right")!.path, x1 - at("right")!.w, p)));

  return parts.join("");
}

// ─────────────────────────────────────────────── 折行

/** 中日文折行：按字宽贪心，行首不许出现收尾标点（禁则）。
 *  **宽度含标点挤压**（半身式，见 common/cjkpunct.ts）：注入的 `measure` 量的就是挤压后的宽度
 *  （Node 侧是 scripts/textmetrics.mjs，与 pdfwrite 的落笔同一个 `compressRun`）。
 *  半身式下每个字压多少与前后无关，所以逐字累加就是整行的宽度。 */
export function wrapText(text: string, role: StyleRole, size: number, width: number, measure: Measure): string[] {
  const out: string[] = [];
  let line = "";
  let w = 0;
  for (const ch of [...text.replace(/\s+/g, " ")]) {
    const cw = measure(role, ch, size);
    if (w + cw > width && line) {
      // 下一个字是收尾标点就让它跟着上一行走（挤一点也比顶行首好看）
      if (NO_LINE_START.test(ch)) {
        out.push(line + ch);
        line = "";
        w = 0;
        continue;
      }
      out.push(line);
      line = "";
      w = 0;
    }
    line += ch;
    w += cw;
  }
  if (line) out.push(line);
  return out;
}

// ─────────────────────────────────────────────── 注解块（花边框 / 未装框经文）

export interface AnnotationBlock {
  items: DrawItem[];
  /** 整块占的高度（含花边框的上下边）。 */
  height: number;
}

/** 路径坐标保留两位（DrawList 里的 d 是字符串，位数多了白白撑大 PDF）。 */
const r = (v: number): string => v.toFixed(2);

export interface AnnotationOptions {
  text: string;
  framed: boolean;
  /** 框的样子。`line` = 双细线矩形框（022/023 那种），几何用下面三个实测值。 */
  frame?: "tile" | "line" | "none";
  frameOuter?: number;
  frameInner?: number;
  frameGap?: number;
  /** 版心左右缘。 */
  left: number;
  right: number;
  /** 块顶 y。 */
  top: number;
  lineGap: number;
  tiles: OrnamentTileSpec[];
  /** 哪几条边有纹样（`"TBLR"`）。原书有的框就是缺一条边。 */
  frameEdges?: string;
  measure: Measure;
  size?: number;
}

/**
 * 注解块。原书把圣诗故事印在该曲末页的剩余空间里，框内文字左对齐、两端不撑齐。
 * 重排后行长变了，所以**重新折行**——原文里的换行是排版结果，不是内容。
 */
export function annotationBlock(style: BookStyle, o: AnnotationOptions): AnnotationBlock {
  const size = o.size ?? style.roles.story.size;
  // 边厚逐槽取：四条边的母题各不相同，厚薄能差一倍（实测 2.5 ~ 8.8）。
  // 老代码一律拿「横母题的 h」当四边的厚度，薄边那侧的正文会贴到花边上。
  const thick = (a: TileSlot, b: TileSlot, dim: "w" | "h") =>
    Math.max(o.tiles.find((t) => t.slot === a)?.[dim] ?? 0, o.tiles.find((t) => t.slot === b)?.[dim] ?? 0);
  const tileY = thick("top", "bottom", "h");
  const tileX = thick("left", "right", "w");
  const isLine = o.frame === "line";
  // 线框的边宽 = 外圈 + 空隙 + 内圈（原书实测约 1.5 + 1.7 + 0.4），再加一点文字余量
  const lineEdge = isLine ? (o.frameOuter ?? 1.5) + (o.frameGap ?? 1.7) + (o.frameInner ?? 0.4) : 0;
  const padX = isLine ? lineEdge + size * 0.6 : o.framed ? tileX + size * 0.6 : 0;
  const padY = isLine ? lineEdge + size * 0.5 : o.framed ? tileY + size * 0.5 : 0;
  const innerW = o.right - o.left - padX * 2;
  // 原文里的换行是**原书那一框的排版结果**，不是内容里的分段（gen-bookmeta 是按视觉行拼的）。
  // 照着它分段再各自折行，每行就只有原书那么长——重排后的框更宽，右边会空掉一大截
  //（037 的故事框只排到半幅宽）。所以先把软换行抹平，整段重新折。
  // 抹平时**西文之间要补回空格**：矢量层没有空格对象，行内的空档靠字距还原
  //（`bookmeta.ts::runText`），可行末那个空档无处可看——044 的
  //「(Horatius ⏎ Bonar」抹平就成了「HoratiusBonar」。两侧都是拉丁字母或数字才补，
  // 汉字之间不补；上一行末尾是连接号（`1483-` ⏎ `1546`）也不补。
  const flat = o.text
    .replace(/(.)\r?\n(.)/gs, (_m, a: string, b: string) => (/[A-Za-z0-9]/.test(a) && /[A-Za-z0-9]/.test(b) ? `${a} ${b}` : `${a}${b}`))
    .replace(/\r?\n/g, "");
  const lines = wrapText(flat, "story", size, innerW, o.measure).filter((l) => l.trim());
  const items: DrawItem[] = [];
  const textTop = o.top + padY;
  lines.forEach((l, i) => items.push(textItem(l, "story", size, o.left + padX, textTop + size + i * o.lineGap)));
  const height = padY * 2 + size + Math.max(0, lines.length - 1) * o.lineGap;
  if (o.framed && o.tiles.length) {
    const box = { x: o.left, y: o.top, w: o.right - o.left, h: height };
    const d = ornamentFramePath(o.tiles, box, o.frameEdges ?? "TBLR");
    if (d) items.unshift({ t: "path", d, fill: 0x000000 });
  } else if (isLine) {
    // 双细线矩形框：外圈粗、内圈细，中间空一道（022/023 的经文框就是这样）
    const ow = o.frameOuter ?? 1.5;
    const iw = o.frameInner ?? 0.4;
    const gap = o.frameGap ?? 1.7;
    const rect = (x: number, y: number, w: number, h: number, lw: number) =>
      `M${r(x)} ${r(y)}h${r(w)}v${r(h)}h${r(-w)}Z` +
      `M${r(x + lw)} ${r(y + lw)}v${r(h - lw * 2)}h${r(w - lw * 2)}v${r(-(h - lw * 2))}Z`;
    const w = o.right - o.left;
    const outer = rect(o.left, o.top, w, height, ow);
    const inset = ow + gap;
    const inner = rect(o.left + inset, o.top + inset, w - inset * 2, height - inset * 2, iw);
    items.unshift({ t: "path", d: `${outer} ${inner}`, fill: 0x000000 });
  }
  return { items, height };
}

// ─────────────────────────────────────────────── 目录

export interface TocEntry {
  songNo: string;
  title: string;
  page: number;
}

export interface TocHeading {
  kind: "category" | "subcategory";
  text: string;
}

export type TocItem = ({ kind: "entry" } & TocEntry) | TocHeading;

export interface PageFrameOptions {
  /** 第一页的物理页号（决定对开镜像的左右）。 */
  startPageNo: number;
  measure: Measure;
  /** 页题（只印在第一页）。 */
  title?: string;
  /** 各角色的**字号**（`browser.ts::fontSizeFor` 按墨迹比例反算过的）。
   *  不给就退回 `roles[*].size`——那是从原书量到的**墨迹高**，各字族的墨迹占比不同
   *  （行楷比黑体扁），直接当字号用会大小不一、行距也跟着错。 */
  sizes?: Partial<Record<StyleRole, number>>;
}

/** 目录页。条目是「曲号．曲名 …… 页码」，引导点按量出来的空档填。 */
export function tocPages(style: BookStyle, items: TocItem[], o: PageFrameOptions): DrawPage[] {
  const t = style.toc;
  const sizeOf = (r: StyleRole) => o.sizes?.[r] ?? style.roles[r].size;
  const size = sizeOf("toc");
  const pages: DrawPage[] = [];
  let cur: DrawItem[] | null = null;
  let y = 0;
  let pageNo = o.startPageNo;
  // 版心下界按**页脚基线**算，不是 footer.band——band 是「页脚出现过的 y 范围」的下沿，
  // 比真正的可用高度保守 30pt（原书的花边框就压到 535，band 才 518）。
  const bottomLimit = style.titleBlock.footerBaseline - style.roles.footer.size * 1.6;
  const start = (withTitle: boolean) => {
    cur = [];
    y = t.firstBaseline;
    if (withTitle && o.title) {
      cur.push(textItem(o.title, "frontTitle", style.roles.frontTitle.size, (t.left + t.right) / 2, t.titleBaseline, "center"));
    }
  };
  const flush = () => {
    if (!cur || !cur.length) return;
    pages.push({ pageNo: pageNo++, w: style.page.w, h: style.page.h, meta: { kind: "toc", songs: [] }, items: cur });
    cur = null;
  };
  const room = (need: number) => y + need <= bottomLimit;
  start(true);
  for (const it of items) {
    if (it.kind !== "entry") {
      const role: StyleRole = it.kind === "category" ? "tocHeading" : "tocSub";
      const hs = sizeOf(role);
      // 标题上下的留白**取原书实测**（headingGapAbove/Below 是基线到基线的净距，
      // 量不到时退回「上方 0.6 行、下方 0.5 行 + 字高」）。
      const above = t.headingGapAbove && t.headingGapAbove > 0 ? t.headingGapAbove : t.lineGap * 0.6 + hs;
      const below = t.headingGapBelow && t.headingGapBelow > 0 ? t.headingGapBelow : hs + t.lineGap * 0.5;
      if (!room(above + below)) {
        flush();
        start(false);
      } else y += above - t.lineGap - hs; // 条目循环末尾已经推过一个 lineGap，above 是**上一条目基线**起算的
      cur!.push(textItem(it.text, role, hs, (t.left + t.right) / 2, y + hs, "center"));
      // `y` 一直是「下一条基线」，而标题的基线被摆在 y+hs（上面 `y += above - hs` 抵掉了这个 hs，
      // 于是标题基线正好落在上一条目基线 + above）。所以往下走要**先补回 hs**再加 below，
      // 少补这一下，标题下方的空档就比上方小掉整整一个字高（14.6pt，肉眼一看就不等）。
      y += hs + below;
      continue;
    }
    if (!room(t.lineGap)) {
      flush();
      start(false);
    }
    const no = `${Number(it.songNo.replace(/^0+/, "")) || it.songNo}.`;
    const page = `(${it.page})`;
    const headText = `${no}${it.title}`;
    const headW = o.measure("toc", headText, size);
    const pageW = o.measure("toc", page, size);
    cur!.push(textItem(headText, "toc", size, t.left, y));
    cur!.push(textItem(page, "toc", size, t.right, y, "right"));
    // 引导点：把中间的空档填满，两头各留一个字的余量
    const gap = t.right - pageW - (t.left + headW) - size;
    const dotW = o.measure("toc", t.leader, size) || size;
    const n = Math.floor(gap / dotW);
    if (n > 0) cur!.push(textItem(t.leader.repeat(n), "toc", size, t.left + headW + size * 0.5, y));
    y += t.lineGap;
  }
  flush();
  return pages;
}

// ─────────────────────────────────────────────── 索引（两栏）

export interface IndexItem {
  kind: "heading" | "entry";
  text: string;
  songNo: string | null;
}

/** 索引页：两栏，条目是「首句/诗题 + 曲号」，曲号贴栏右缘。 */
export function indexPages(style: BookStyle, items: IndexItem[], o: PageFrameOptions): DrawPage[] {
  const t = style.toc;
  const sizeOf = (r: StyleRole) => o.sizes?.[r] ?? style.roles[r].size;
  const size = sizeOf("toc");
  const cols = Math.max(1, t.indexColumns);
  const colW = (t.right - t.left) / cols;
  const bottomLimit = style.titleBlock.footerBaseline - style.roles.footer.size * 1.6;
  const rowsPerCol = Math.max(1, Math.floor((bottomLimit - t.indexFirstBaseline) / t.indexLineGap) + 1);
  const perPage = rowsPerCol * cols;
  const pages: DrawPage[] = [];
  let pageNo = o.startPageNo;
  for (let i = 0; i < items.length; i += perPage) {
    const chunk = items.slice(i, i + perPage);
    const draw: DrawItem[] = [];
    if (i === 0 && o.title)
      draw.push(textItem(o.title, "frontTitle", sizeOf("frontTitle"), (t.left + t.right) / 2, t.titleBaseline, "center"));
    chunk.forEach((it, k) => {
      const col = Math.floor(k / rowsPerCol);
      const row = k % rowsPerCol;
      const x = t.left + col * colW;
      const y = t.indexFirstBaseline + row * t.indexLineGap;
      if (it.kind === "heading") {
        draw.push(textItem(it.text, "tocSub", size * 1.15, x + colW / 2, y, "center"));
        return;
      }
      const no = it.songNo ? String(Number(it.songNo.replace(/^0+/, "")) || it.songNo) : "";
      const noW = o.measure("toc", no, size);
      // 首句太长就截断——原书也截，栏宽就这么多
      let text = it.text;
      while (text.length > 1 && o.measure("toc", text, size) > colW - noW - size * 0.8) text = text.slice(0, -1);
      draw.push(textItem(text, "toc", size, x, y));
      if (no) draw.push(textItem(no, "toc", size, x + colW - size * 0.3, y, "right"));
    });
    pages.push({ pageNo: pageNo++, w: style.page.w, h: style.page.h, meta: { kind: "index", songs: [] }, items: draw });
  }
  return pages;
}

// ─────────────────────────────────────────────── 扉页 / 前言

export interface FrontPageSpec {
  kind: "divider" | "prose";
  title: string;
  body: string;
}

/** 扉页（几个大字居中）与前言（页题 + 正文）。 */
export function frontPages(style: BookStyle, specs: FrontPageSpec[], o: PageFrameOptions): DrawPage[] {
  const t = style.toc;
  const pages: DrawPage[] = [];
  let pageNo = o.startPageNo;
  for (const f of specs) {
    const items: DrawItem[] = [];
    const m = pageMargins(style, pageNo);
    const left = m.left;
    const right = style.page.w - m.right;
    if (f.kind === "divider") {
      // 扉页：字号照原书那两个大字（44/49pt），居中偏上三分之一处
      const size = style.roles.frontTitle.size * 2.4;
      items.push(textItem(f.title, "frontTitle", size, (left + right) / 2, style.page.h * 0.42, "center"));
    } else {
      items.push(textItem(f.title, "frontTitle", style.roles.frontTitle.size, (left + right) / 2, t.titleBaseline, "center"));
      const size = style.roles.story.size * 1.2;
      const gap = size * 1.6;
      let y = t.firstBaseline + gap;
      for (const para of f.body.split("\n")) {
        for (const line of wrapText(para, "story", size, right - left, o.measure)) {
          items.push(textItem(line, "story", size, left, y));
          y += gap;
        }
      }
    }
    pages.push({ pageNo: pageNo++, w: style.page.w, h: style.page.h, meta: { kind: "front-matter", songs: [] }, items });
  }
  return pages;
}
