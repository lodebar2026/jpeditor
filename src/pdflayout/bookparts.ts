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
export function keyMeterItems(style: BookStyle, km: KeyMeterSpec, x: number, baseline: number, measure: Measure, size?: number): DrawItem[] {
  const sz = size ?? style.roles.keyMeter.size;
  // **比例的基准是墨迹高（roles.keyMeter.size），不是字号**。两者差一个「墨迹占 em 的比例」
  // ——Times 的数字只占 0.66em，所以字号 12.05 时墨迹才 8.14。拿字号去乘这些比例，
  // 分数线会长出一半、上下两个数字各错开三个点（实测 005 首的 4 被线压住）。
  const ink = style.roles.keyMeter.size;
  const items: DrawItem[] = [];
  const head = `1=${km.tonic}`;
  items.push(textItem(head, "keyMeter", sz, x, baseline));
  let cx = x + measure("keyMeter", head, sz) + ink * 0.37;
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
  if (km.altTonic) items.push(textItem(`(1=${km.altTonic})`, "keyMeter", sz, cx, baseline));
  return items;
}

// ─────────────────────────────────────────────── 花边框

export interface OrnamentTileSpec {
  orient: "h" | "v";
  w: number;
  h: number;
  pitch: number;
  path: string;
}

/** 把一条已归一化到原点的路径平移到 (x,y)。 */
function movePath(d: string, x: number, y: number): string {
  return d.replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g, (_m, a, b) => `${(Number(a) + x).toFixed(2)} ${(Number(b) + y).toFixed(2)}`);
}

/**
 * 花边框：横母题沿上下边平铺、纵母题沿左右边平铺，**拼成一条 path**。
 * 原书一个框 78 片（上下各 28、左右各 11），当成 78 个对象画既慢又难改。
 * 末片按余量把步距均分（原书就是均分的：实测步距 10.674 而母题宽 10.771，略有交叠）。
 */
export function ornamentFramePath(tiles: OrnamentTileSpec[], box: { x: number; y: number; w: number; h: number }): string {
  const h = tiles.find((t) => t.orient === "h");
  const v = tiles.find((t) => t.orient === "v");
  const parts: string[] = [];
  if (h) {
    const n = Math.max(1, Math.round((box.w - h.w) / h.pitch));
    const step = (box.w - h.w) / n;
    for (let i = 0; i <= n; i++) {
      parts.push(movePath(h.path, box.x + i * step, box.y));
      parts.push(movePath(h.path, box.x + i * step, box.y + box.h - h.h));
    }
  }
  if (v) {
    const n = Math.max(1, Math.round((box.h - v.h) / v.pitch));
    const step = (box.h - v.h) / n;
    for (let i = 0; i <= n; i++) {
      parts.push(movePath(v.path, box.x, box.y + i * step));
      parts.push(movePath(v.path, box.x + box.w - v.w, box.y + i * step));
    }
  }
  return parts.join("");
}

// ─────────────────────────────────────────────── 折行

/** 中日文折行：按字宽贪心，行首不许出现收尾标点（禁则）。 */
export function wrapText(text: string, role: StyleRole, size: number, width: number, measure: Measure): string[] {
  const NO_LINE_START = /[，。、；：！？」』）〉》…·%,.;:!?)\]}]/;
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

export interface AnnotationOptions {
  text: string;
  framed: boolean;
  /** 版心左右缘。 */
  left: number;
  right: number;
  /** 块顶 y。 */
  top: number;
  lineGap: number;
  tiles: OrnamentTileSpec[];
  measure: Measure;
  size?: number;
}

/**
 * 注解块。原书把圣诗故事印在该曲末页的剩余空间里，框内文字左对齐、两端不撑齐。
 * 重排后行长变了，所以**重新折行**——原文里的换行是排版结果，不是内容。
 */
export function annotationBlock(style: BookStyle, o: AnnotationOptions): AnnotationBlock {
  const size = o.size ?? style.roles.story.size;
  const tileH = o.tiles.find((t) => t.orient === "h")?.h ?? 0;
  const padX = o.framed ? tileH + size * 0.6 : 0;
  const padY = o.framed ? tileH + size * 0.5 : 0;
  const innerW = o.right - o.left - padX * 2;
  const lines = o.text
    .split("\n")
    .flatMap((para) => wrapText(para, "story", size, innerW, o.measure))
    .filter((l) => l.trim());
  const items: DrawItem[] = [];
  const textTop = o.top + padY;
  lines.forEach((l, i) => items.push(textItem(l, "story", size, o.left + padX, textTop + size + i * o.lineGap)));
  const height = padY * 2 + size + Math.max(0, lines.length - 1) * o.lineGap;
  if (o.framed && o.tiles.length) {
    const box = { x: o.left, y: o.top, w: o.right - o.left, h: height };
    const d = ornamentFramePath(o.tiles, box);
    if (d) items.unshift({ t: "path", d, fill: 0x000000 });
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
}

/** 目录页。条目是「曲号．曲名 …… 页码」，引导点按量出来的空档填。 */
export function tocPages(style: BookStyle, items: TocItem[], o: PageFrameOptions): DrawPage[] {
  const t = style.toc;
  const size = style.roles.toc.size;
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
      const hs = style.roles[role].size;
      // 标题上下都要留白：上方一行、下方半行（原书就是这样，不然标题贴着上一条）
      if (!room(t.lineGap * 2 + hs)) {
        flush();
        start(false);
      } else y += t.lineGap * 0.6;
      cur!.push(textItem(it.text, role, hs, (t.left + t.right) / 2, y + hs, "center"));
      y += hs + t.lineGap * 0.5;
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
  const size = style.roles.toc.size;
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
      draw.push(textItem(o.title, "frontTitle", style.roles.frontTitle.size, (t.left + t.right) / 2, t.titleBaseline, "center"));
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
