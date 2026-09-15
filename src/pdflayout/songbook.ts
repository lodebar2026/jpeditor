// 混排歌本（五线谱 + 简谱层）：清单里的一串 MusicXML → 整本的 DrawPage。
//
// 移植原排版程序的歌本链路（musicpp util/pao.cpp::genSongBook）：
//   ScoreMeta::updateTop / updateBottom（:42 / :95）→ 模板区域 song-head / song-foot（`.jpcss`，style/template.ts）
//   SongBook::addScore（:217）                       → `songFrames`：首帧带标题块、末帧带页脚块
//   flowLayout（util/layout.cpp:6）+ SongBook::layout → `flow`：帧间距取 max(上帧下间距, 本帧上间距)，放不下或强制就换页
//   SongBook::drawFrame（:371）                      → `drawPages`：标题块在 margin+ypos，谱行在 margin+ypos+topY+musicYOffset
//   SongBook::genTOC（:289）                         → `tocPage`：A4 pt 口径，点线填到页码前
// 逐曲的特殊处理（:682 fixPaoScore）不写在这里，写成清单/样式表里的 scoped 规则。
//
// **浏览器侧**（混排引擎要 DOM 量字）。Node 侧的 scripts/kl2020-book.mjs 经 window.__songbook 调它，
// 拿回纯数据的 DrawPage[] 再交 scripts/pdfwrite.mjs。
import { Matrix33 } from "../common/geom";
import { Font } from "../layout/font";
import { Group, TextFrame } from "../layout/pageitem";
import { MetaData } from "../smufl/smufl";
import { loadScoreDoc } from "../model/fromxml";
import { metaFlag } from "../model/metakeys";
import { keepMelodyOnly } from "../model/melodyonly";
import type { Song } from "../model/doc";
import { MixedOptions, type Sys } from "../mixed/model";
import { layoutStaff } from "../mixed/layout";
import { drawSystem } from "../mixed/render";
import { formatMixedScore } from "../mixed/painter";
import { applyScopedToStaff } from "../mixed/scoped";
import { computeStyle, type StyleContext, type StyleRule } from "../style/cascade";
import type { StyleSheet } from "../style/sheet";
import { applyStaffStyle } from "../style/staff";
import { THEMES } from "../style/themes";
import { parseJpcss, type Expr, type Region } from "../style/jpcss";
import { evalNum, expandText, layoutRegion, songFields, type Placed, type RegionEnv } from "../style/template";
import { resolveLength } from "../style/units";
import { applyManifestSong, type ManifestSong } from "./manifest";
import { pageItemsToDrawPage } from "./browser";
import type { DrawItem, DrawPage } from "./drawlist";

export interface SongbookInput {
  songs: { xml: string; entry: ManifestSong }[];
  /** 歌本 `.jpcss` 解析出的规则 */
  rules: StyleRule[];
  /** 覆盖 `@flow song-start`：new-page 每首另起一页（单曲版）；continue 按清单逐曲的 layout.new-page */
  songStart?: "new-page" | "continue";
  /** `@font-face` 名 → 已在页面里注册好的 CSS 字体族（Node 侧读字体文件、`FontFace` 注册） */
  families?: Record<string, string>;
}

export interface SongbookResult {
  pages: DrawPage[];
  toc: DrawPage[];
  /** 每首的起始页（1 基，不含目录页） */
  starts: number[];
  titles: string[];
  /** 文字角色 → 字体族（pdfwrite 按角色选字体；混排里角色就是字体族） */
  families: string[];
  errors: { title: string; error: string }[];
  /** 逐帧装页事实（tenths）：第几首、帧高、页内 y、是否换页、标题块/页脚块占高。核对分页用 */
  frames: { song: number; height: number; ypos: number; newPage: boolean; head: number; foot: number }[];
  /** 逐曲 scoped 规则的命中数（0 = 多半写错了小节号或曲名） */
  scoped: { title: string; rule: string; count: number }[];
}

// ───────────────────────── 帧 ─────────────────────────

interface Frame {
  sys: Sys;
  song: number;
  topY: number;
  height: number;
  musicYOffset: number;
  first: boolean;
  last: boolean;
  forceNewPage: boolean;
  bottomTextYOffset: number;
  head?: Placed[];
  foot?: Placed[];
  /** 流式装页的结果 */
  ypos: number;
  newPage: boolean;
}

interface SongLayout {
  title: string;
  sheet: StyleSheet;
  env: (dy: number, pageNo: number) => RegionEnv;
  frames: Frame[];
  scoped: SongbookResult["scoped"];
  /** 装页之后、画之前那一轮 scoped（文字块拆行） */
  drawPhase: () => void;
}

const FRAME_MARGIN = 20;

function exprWord(e: Expr | undefined): string | undefined {
  return e && (e.k === "id" || e.k === "str") ? e.v : undefined;
}

/** 角色 → 字体（`font: 名` 引 `@font-face`，或直接 `family`）。 */
function fontOfRole(sheet: StyleSheet, families: Record<string, string>, role: string, size: number): Font {
  const decl = sheet.roles[role as keyof StyleSheet["roles"]];
  const face = decl?.font ? sheet.template?.fonts?.[decl.font] : undefined;
  const family = (decl?.font && families[decl.font]) ?? decl?.family ?? exprWord(face?.family) ?? "Source Han Sans SC";
  const bold = decl?.weight === "bold" || exprWord(face?.bold) === "true";
  return new Font(family, size, bold);
}

function songLayout(xml: string, entry: ManifestSong, input: SongbookInput, meta: MetaData, index: number): SongLayout {
  const doc = loadScoreDoc(xml);
  const song: Song = doc.songs[0]!;
  applyManifestSong(song, entry);
  const title = song.work.title ?? "";
  const ctx: StyleContext = { engine: "staff", mode: "mixed", song: title, songNumber: entry.number ?? String(index + 1) };
  const layers = [THEMES.staff, input.rules];
  if (entry.style) layers.push(parseJpcss(entry.style).rules);
  const sheet = computeStyle(layers, ctx);
  if (metaFlag(song, "layout.melody-only")) keepMelodyOnly(song);

  const options = new MixedOptions(meta);
  applyStaffStyle(options, sheet);
  options.hideBarNumber = true;
  if (metaFlag(song, "layout.chinese-hyphen")) options.chineseHyphen = true;
  const score = layoutStaff(doc, options);
  formatMixedScore(score);
  // 逐曲定制（原排版程序 fixPaoScore 的那几首）：`.jpcss` 的 `@song` / 清单本曲的 style 片段
  const report = applyScopedToStaff(score, sheet.scoped, { title, number: ctx.songNumber });
  const scoped = report.hits.map((h) => ({ title, rule: `${h.rule.role}${h.rule.where.map((w) => `[${w.dim}${w.op}${w.value}]`).join("")}`, count: h.count }));
  const drawPhase = (): void => void applyScopedToStaff(score, sheet.scoped, { title, number: ctx.songNumber }, "draw");
  const scaling = score.scaling;
  const families = input.families ?? {};

  const sizeOf = (role: string): number => {
    const v = sheet.roles[role as keyof StyleSheet["roles"]]?.size;
    const r = v === undefined ? null : resolveLength(v, { em: 20, sp: 10, pt: 1 / scaling });
    return r ?? 20;
  };
  const tpl = sheet.template ?? {};
  const pageW = pageSize(tpl.book, sheet).w;
  const env = (dy: number, pageNo: number): RegionEnv => ({
    field: songFields(song),
    pageNo,
    content: { left: 0, right: pageW },
    pageWidth: pageW,
    dy,
    sizeOf,
    measure: (role, text, size) => fontOfRole(sheet, families, role, size).measureText(text),
    // 原排版程序的 Font::height() 就是字号（font.cpp:1095），ascent 取字体的 ascent
    fontMetrics: (role, size) => ({ ascent: -fontOfRole(sheet, families, role, size).metrics.ascent, height: size }),
    tenths: 1,
  });

  // SongBook::addScore：首帧带标题块（块高 + 20），末帧带页脚块
  const frames: Frame[] = score.systems.map((sys) => {
    const [topY, bottomY] = sys.getYBound();
    return { sys, song: index, topY, height: topY - bottomY, musicYOffset: 0, first: false, last: false, forceNewPage: false, bottomTextYOffset: 0, ypos: 0, newPage: false };
  });
  if (frames.length) {
    const f0 = frames[0]!;
    f0.first = true;
    const head = layoutRegion(tpl.regions?.["song-head"] as Region | undefined, env(0, 1));
    const gapAfter = evalNum((tpl.regions?.["song-head"] as Region | undefined)?.props["gap-after"], env(0, 1)) ?? 0;
    f0.head = head.items;
    f0.musicYOffset = head.span + gapAfter;
    f0.height += head.span + gapAfter;
    const fl = frames[frames.length - 1]!;
    fl.last = true;
    const foot = layoutRegion(tpl.regions?.["song-foot"] as Region | undefined, env(0, 1));
    fl.foot = foot.items;
    fl.bottomTextYOffset = fl.height;
    fl.height += foot.span;
  }
  void scaling;
  return { title, sheet, env, frames, scoped, drawPhase };
}

function pageSize(book: Record<string, Expr> | undefined, sheet: StyleSheet): { w: number; h: number; margin: number } {
  void book;
  const p = sheet.page as Record<string, unknown>;
  const size = p.size;
  const [w, h] = Array.isArray(size) ? (size as number[]) : [1322, 1870];
  const margin = typeof p.margin === "number" ? p.margin : 75;
  return { w: w!, h: h!, margin };
}

/** flowLayout（util/layout.cpp:6）。 */
function flow(frames: Frame[], contentHeight: number): void {
  let ypos = contentHeight * 2;
  let lastMrg = 0;
  for (const frm of frames) {
    const mrg = Math.max(lastMrg, FRAME_MARGIN);
    let np = frm.forceNewPage;
    if (ypos + frm.height + mrg > contentHeight) np = true;
    frm.newPage = np;
    if (np) {
      lastMrg = 0;
      ypos = 0;
    } else ypos += mrg;
    frm.ypos = ypos;
    ypos += frm.height;
    lastMrg = FRAME_MARGIN;
  }
}

function placedToTextFrames(page: Group, placed: readonly Placed[], sheet: StyleSheet, families: Record<string, string>): void {
  for (const p of placed) {
    if (p.kind !== "text") continue;
    const font = fontOfRole(sheet, families, p.role, p.size);
    const tf = new TextFrame();
    // `features: hwid`（半宽标点）：原排版程序开 OpenType hwid，标点印成半宽。
    // 出 PDF 那头不做 GSUB，这里直接换成对应的半角字符（面貌同为半宽标点）
    const hwid = /\bhwid\b/.test(String(sheet.roles[p.role as keyof StyleSheet["roles"]]?.features ?? ""));
    tf.text = hwid ? toHalfWidthPunct(p.text) : p.text;
    tf.font = font;
    // 逐字笔位要自己量：前缀串末尾的空格量不进宽度（SVG 包围盒），「Crown Him」的 H 会落到空格上
    const bar = font.measureText("|");
    tf.charXs = [...tf.text].map((_, i, cs) => (i === 0 ? 0 : font.measureText(cs.slice(0, i).join("") + "|") - bar));
    const w = font.measureText(tf.text);
    const x = p.align === "center" ? p.x - w / 2 : p.align === "right" ? p.x - w : p.x;
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1, x, p.y]);
    tf.matrix = m;
    page.add(tf);
  }
}

/** 全角标点 → 半角（`hwid` 的替代）。只换标点，汉字与全角字母数字不动。 */
function toHalfWidthPunct(s: string): string {
  return s.replace(/[：；，！？（）]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// ───────────────────────── 入口 ─────────────────────────

export async function layoutMixedSongbook(input: SongbookInput): Promise<SongbookResult> {
  const meta = await MetaData.load();
  const families = input.families ?? {};
  const songs: SongLayout[] = [];
  const errors: SongbookResult["errors"] = [];
  input.songs.forEach(({ xml, entry }, i) => {
    try {
      songs.push(songLayout(xml, entry, input, meta, i));
    } catch (e) {
      errors.push({ title: entry.title ?? entry.file, error: String((e as Error)?.stack ?? e) });
    }
  });
  if (!songs.length) return { pages: [], toc: [], starts: [], titles: [], families: [], errors, frames: [], scoped: [] };

  const book = computeStyle([THEMES.staff, input.rules], { engine: "staff", mode: "mixed" });
  const { w: pageW, h: pageH, margin } = pageSize(book.template?.book, book);
  const songStart = input.songStart ?? (exprWord(book.template?.flow?.["song-start"]) as SongbookInput["songStart"]) ?? "new-page";

  const frames: Frame[] = [];
  for (const s of songs) {
    const f0 = s.frames[0];
    if (!f0) continue;
    // 单曲版：每首强制换页；接排版：按清单的 layout.new-page（genSongBook 的 `dontMerge || meta.newPage`）
    const np = songStart === "new-page" ? true : exprFlag(s, "layout.new-page");
    f0.forceNewPage = np;
    frames.push(...s.frames);
  }
  flow(frames, pageH - margin * 2);
  for (const s of songs) s.drawPhase();

  // SongBook::drawFrame
  const pageGroups: Group[] = [];
  const pageScaling: number[] = [];
  const starts: number[] = [];
  let page: Group | null = null;
  for (const frm of frames) {
    const s = songs[frm.song]!;
    if (frm.newPage || !page) {
      page = new Group();
      pageGroups.push(page);
      pageScaling.push(frm.sys.score.scaling);
    }
    if (frm.first) starts.push(pageGroups.length);
    const pageNo = pageGroups.length;
    if (frm.head) {
      const env = s.env(margin + frm.ypos, pageNo);
      const head = layoutRegion(s.sheet.template?.regions?.["song-head"] as Region | undefined, env);
      placedToTextFrames(page, head.items, s.sheet, families);
    }
    const sysGrp = drawSystem(page, frm.sys);
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1, margin + frm.sys.leftMargin, margin + frm.ypos + frm.topY + frm.musicYOffset]);
    sysGrp.matrix = m;
    if (frm.foot) {
      const env = s.env(margin + frm.ypos + frm.bottomTextYOffset, pageNo);
      const foot = layoutRegion(s.sheet.template?.regions?.["song-foot"] as Region | undefined, env);
      placedToTextFrames(page, foot.items, s.sheet, families);
    }
  }

  const usedFamilies = new Set<string>();
  const roleOf = (it: TextFrame): string => {
    const fam = it.font?.family ?? "";
    usedFamilies.add(fam);
    return fam;
  };
  const pages = pageGroups.map((g, i) =>
    pageItemsToDrawPage(g, pageW, pageH, { pageNo: i + 1, meta: { kind: "score", songs: [] }, scale: pageScaling[i]!, roleOf }),
  );
  const titles = songs.map((s) => s.title);
  const toc = tocPages(book, titles, starts, families, usedFamilies);
  const frameFacts = frames.map((f) => ({
    song: f.song, height: f.height, ypos: f.ypos, newPage: f.newPage,
    head: f.first ? f.musicYOffset : 0, foot: f.last ? f.height - f.bottomTextYOffset : 0,
  }));
  return { pages, toc, starts, titles, families: [...usedFamilies], errors, frames: frameFacts, scoped: songs.flatMap((s) => s.scoped) };
}

function exprFlag(s: SongLayout, key: string): boolean {
  const env = s.env(0, 1);
  const v = env.field(`meta.${key}`)?.[0]?.text;
  return v === undefined ? true : v === "true";
}

// ───────────────────────── 目录（genTOC） ─────────────────────────

/**
 * 目录页（A4 pt 口径，`@template toc`）。条目 = `entry` 子块：左格文字 `at x`、右格页码 `at x`、`leader: dots to x`。
 * 点线：能塞多少个「.」就塞多少，右端贴 `to`，比基线高 0.3 个字号（genTOC 原式）。
 */
function tocPages(sheet: StyleSheet, titles: string[], starts: number[], families: Record<string, string>, used: Set<string>): DrawPage[] {
  const region = sheet.template?.regions?.toc as Region | undefined;
  if (!region) return [];
  const entry = region.blocks?.entry;
  const W = 595;
  const H = 842;
  const env = (fields: Record<string, string>): RegionEnv => ({
    field: songFields(undefined, fields),
    pageNo: 1,
    content: { left: 0, right: W },
    pageWidth: W,
    sizeOf: (role) => (resolveLength(sheet.roles[role as keyof StyleSheet["roles"]]?.size, { em: 12, sp: 6, pt: 1 }) ?? 12),
    measure: (role, text, size) => fontOfRole(sheet, families, role, size).measureText(text),
  });
  const e0 = env({});
  const text = (t: string, role: string, x: number, y: number, size: number): DrawItem => {
    const font = fontOfRole(sheet, families, role, size);
    used.add(font.family);
    const xs: number[] = [];
    let acc = x;
    for (const ch of t) {
      xs.push(acc);
      acc += font.measureText(ch);
    }
    return { t: "text", y, text: t, size, role: font.family as never, align: "pen", xs };
  };
  const pages: DrawPage[] = [];
  let items: DrawItem[] = [];
  const newPage = (): void => {
    items = [];
    pages.push({ pageNo: pages.length + 1, w: W, h: H, meta: { kind: "toc", songs: [] }, items });
  };
  newPage();
  // 页题
  const titleSeq = region.props.title;
  if (titleSeq) {
    const parts = titleSeq.k === "seq" ? titleSeq.items : [titleSeq];
    const str = parts[0]?.k === "str" ? parts[0].v : "";
    const asIdx = parts.findIndex((p) => p.k === "id" && p.v === "as");
    const role = asIdx >= 0 ? exprWord(parts[asIdx + 1]) ?? "frontTitle" : "frontTitle";
    const size = e0.sizeOf(role);
    const w = fontOfRole(sheet, families, role, size).measureText(str);
    items.push(text(str, role, W / 2 - w / 2, evalNum(region.props["title-baseline"], e0) ?? 60, size));
  }
  if (!entry) return pages;
  const leftCell = entry.rows[0]?.cells.find((c) => c.slot === "left");
  const rightCell = entry.rows[0]?.cells.find((c) => c.slot === "right");
  const role = leftCell?.lines[0]?.role ?? "toc";
  const size = e0.sizeOf(role);
  const lh = (evalNum(entry.props["line-height"], e0) ?? 1.5) * size;
  const first = evalNum(entry.props["first-baseline"], e0) ?? 100;
  const leaderSeq = entry.props.leader;
  const leaderTo = leaderSeq?.k === "seq" ? evalNum(leaderSeq.items[2], e0) : undefined;
  let y = first;
  titles.forEach((title, i) => {
    if (y > H - 40) {
      newPage();
      y = first;
    }
    const f = env({ "toc.seq": String(i + 1), "toc.pad": i < 9 ? " " : "", "work.title": title, "toc.page": String(starts[i] ?? "") });
    const leftX = leftCell?.lines[0]?.at ? evalNum(leftCell.lines[0].at, f)! : 100;
    const leftText = leftCell?.lines[0]?.content.kind === "text" ? expandText(leftCell.lines[0].content.parts, f).join("") : title;
    items.push(text(leftText, role, leftX, y, size));
    if (leaderTo !== undefined) {
      const font = fontOfRole(sheet, families, role, size);
      const space = leaderTo - font.measureText(leftText) - leftX;
      let dots = "";
      for (let j = 0; j < (space * 5) / size; j++) {
        if (font.measureText(dots + ".") > space) break;
        dots += ".";
      }
      items.push(text(dots, role, leaderTo - font.measureText(dots), y - size * 0.3, size));
    }
    const rl = rightCell?.lines[0];
    if (rl && rl.content.kind === "text") {
      const rx = rl.at ? evalNum(rl.at, f)! : leaderTo !== undefined ? leaderTo + 5 : W - 90;
      items.push(text(expandText(rl.content.parts, f).join(""), role, rx, y, size));
    }
    y += lh;
  });
  return pages;
}
