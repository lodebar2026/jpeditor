// 混排歌本（五线谱 + 简谱层）：清单里的一串 MusicXML → 整本的 DrawPage。
//
// 移植原排版程序的歌本链路（musicpp util/pao.cpp::genSongBook）：
//   ScoreMeta::updateTop / updateBottom（:42 / :95）→ 模板区域 song-head / song-foot（`.ss`，style/template.ts）
//   SongBook::addScore（:217）                       → `songFrames`：首帧带标题块、末帧带页脚块
//   flowLayout（util/layout.cpp:6）+ SongBook::layout → `flow`：帧间距取 max(上帧下间距, 本帧上间距)，放不下或强制就换页
//   SongBook::drawFrame（:371）                      → `drawPages`：标题块在 margin+ypos，谱行在 margin+ypos+topY+musicYOffset
//   SongBook::genTOC（:289）                         → `tocPage`：A4 pt 口径，点线填到页码前
// 逐曲的特殊处理（:682 fixPaoScore）不在排版里：由 scripts/kl2020-prep.mjs 事先写进 MusicXML（.fixed.xml），这里只按数据排。
//
// **浏览器侧**（混排引擎要 DOM 量字）。Node 侧的 scripts/kl2020-book.mjs 经 window.__songbook 调它，
// 拿回纯数据的 DrawPage[] 再交 scripts/pdfwrite.mjs。
import { Matrix33 } from "../common/geom";
import { punctClass } from "../common/cjkpunct";
import { Font } from "../layout/font";
import { Group, TextFrame } from "../layout/pageitem";
import { MetaData } from "../smufl/smufl";
import { loadScoreDoc } from "../model/fromxml";
import { metaFlag } from "../model/metakeys";
import { keepFirstPart } from "../model/melodyonly";
import type { Song } from "../model/doc";
import { MixedOptions, type Sys } from "../mixed/model";
import { layoutStaff } from "../mixed/layout";
import { drawSystem } from "../mixed/render";
import { formatMixedScore } from "../mixed/staffpages";
import type { StyleContext, StyleRule } from "../style/cascade";
import type { StyleRole, StyleSheet } from "../style/sheet";
import { fontOfRole as roleFont } from "../style/fonts";
import { applyStaffStyle } from "../style/staff";
import { computeStyleForPaper, THEMES } from "../style/themes";
import type { Expr, Region, Row } from "../style/ss";
import { evalNum, layoutRegion, songFields, type ComponentFn, type Placed, type RegionEnv } from "../style/template";
import { resolveLength } from "../style/units";
import { applyManifestSong, type ManifestSong } from "./manifest";
import { pageItemsToDrawPage } from "./browser";
import type { DrawItem, DrawPage } from "./drawlist";

export interface SongbookInput {
  songs: { xml: string; entry: ManifestSong }[];
  /** 歌本 `.ss` 解析出的规则 */
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
}

const FRAME_MARGIN = 20;
/** 出书纸张（pt）：原程序整本固定 A4 */
const A4_PT = { w: 595, h: 842 };
/** 书的缺省字体族：角色没写字体时用它，和弦（`MixedOptions.wordFont`）的书级缺省也是它
 *  （musicpp Engraver::wordFont，model.hpp）。 */
const BOOK_FALLBACK_FAMILY = "Source Han Sans SC";

function exprWord(e: Expr | undefined): string | undefined {
  return e && (e.k === "id" || e.k === "str") ? e.v : undefined;
}

/** 角色 → 字体（`font: 名` 引 `@font-face`，或直接 `family`）。解析在 `style/fonts.ts`，这里只补书的缺省族。 */
function fontOfRole(sheet: StyleSheet, families: Record<string, string>, role: string, size: number): Font {
  return roleFont(sheet, role as StyleRole, new Font(BOOK_FALLBACK_FAMILY, size), { size, families });
}

function songLayout(xml: string, entry: ManifestSong, input: SongbookInput, meta: MetaData, index: number): SongLayout {
  const doc = loadScoreDoc(xml);
  const song: Song = doc.songs[0]!;
  applyManifestSong(song, entry);
  const title = song.work.title ?? "";
  const ctx: StyleContext = { engine: "staff", mode: "mixed" };
  const sheet = computeStyleForPaper([THEMES.staff, input.rules], ctx);
  // 只留旋律第一步：裁到 P1（删非旋律音要等混排引擎读完整条，见 model/melodyonly.ts）
  if (metaFlag(song, "layout.melody-only")) keepFirstPart(song);

  const options = new MixedOptions(meta);
  options.hideBarNumber = true;
  options.textLineHeightBySize = true;
  options.jpKeyJianpuFont = true;
  // 歌词标点走半身式（util/pao.cpp:1002 `eng->lrcHWID = true` → 歌词字体开 hwid）
  options.lrcHWID = true;
  // 和弦字体：musicpp Engraver::wordFont 缺省是思源黑体（model.hpp），成品和弦即此；编辑器视图沿用 Times New Roman。
  // 放在 `applyStaffStyle` **之前**：这是书的缺省，样式表里 `chord { font: … }` 要盖得住它。
  options.wordFont = BOOK_FALLBACK_FAMILY;
  // 样式表最后叠：角色字体与 `@jianpu` / `@staff` 的几何开关由书定
  applyStaffStyle(options, sheet);
  if (metaFlag(song, "layout.chinese-hyphen")) options.chineseHyphen = true;
  // 只留旋律第二步：读完整条后删非旋律音 → 重猜符干（musicpp removeNoneMelody → guessStemDir）
  if (metaFlag(song, "layout.melody-only")) options.melodyOnly = true;
  const score = layoutStaff(doc, options);
  formatMixedScore(score);
  const scaling = score.scaling;
  const families = input.families ?? {};

  const sizeOf = (role: string): number => {
    const v = sheet.roles[role as keyof StyleSheet["roles"]]?.size;
    const r = v === undefined ? null : resolveLength(v, { em: 20, sp: 10, pt: 1 / scaling });
    return r ?? 20;
  };
  const tpl = sheet.template ?? {};
  // ScoreMeta::updateTop/updateBottom 用的是每首原谱页面的宽度（titlePage/lastPage->width），
  // 不是歌本样式表的 1322。最终输出纸张仍由 layoutMixedSongbook 固定为 A4；这里只决定
  // 标题的居中轴和页脚右栏的右缘。《受苦圣徒，到基督前》的源 page-width=1354，拿
  // 1322 算会让标题左移 16 tenths、右栏左移 32 tenths，正好是 flow 红蓝对照里的偏差。
  const pageW = score.defaults.pageWidth;
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
  return { title, sheet, env, frames };
}

function pageSize(sheet: StyleSheet): { w: number; h: number; margin: number } {
  const [w, h] = sheet.page.size ?? [1322, 1870];
  const margin = typeof sheet.page.margin === "number" ? sheet.page.margin : 75;
  return { w, h, margin };
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
    // 出 PDF 那头不做 GSUB，这里照歌词那条的口径（`MixedOptions.musicppHwidGlyphs`，render.ts::drawLrc）
    // 等效：**保留中文标点字形**，只把它排进半格、墨迹居中。
    const hwid = /\bhwid\b/.test(String(sheet.roles[p.role as keyof StyleSheet["roles"]]?.features ?? ""));
    tf.text = p.text;
    tf.font = font;
    // 逐字笔位自己算：单字 advance 顺排，**标点不挤压**——成品（原程序直接画字）「内。（来6：19）」「不开口。（赛53：7）」
    // 里句号与左括号都是全宽。不能拿浏览器量的前缀宽：Chrome 缺省 `text-spacing-trim` 会把「。（」里左括号的左半格压掉，
    // 前缀宽里少了半格、括号笔位却没跟着左挪，出 PDF 逐字画全宽字形时括号的墨正好被下一个字盖住
    //（「根基。（林前3：11）」的「（」看不见）。夹在两字之间量单字，避开行首行末的挤压。
    // 开 hwid 的角色里，全角标点占半格、墨迹居中（成品页脚「17：20，21；路」每个标点正是 0.5em）。
    // **不换成 ASCII 标点**：半角形只有 `：；，！？（）` 有，`《》「」【】` 换不出来，照全角画两侧各空半格，
    //《求主使我成长》页脚「SLBC增修自《恩颂圣歌》，2018」的书名号与前后字接不上；而换得出来的那几个，
    // ASCII 字形也与成品对不上（逗号落在基线上、冒号分号的墨比成品短 4~5 px @300dpi）。
    // 保留中文字形排进半格后，这一行与成品的逐字墨迹全部落在 1 px 内。
    // 西文连续段按整段前缀量宽，保住字距调整（逐字量会丢 Pa、Tr、Ya 的 kerning，「Matt Papa, Trans. Boaz Yang」越排越宽）；
    // 前缀两头各垫一个「|」再减掉：SVG 量宽会去掉首尾空白（「；」后的空格段被量成 0）
    const pad = font.measureText("一一");
    const bar = font.measureText("|");
    const chars = [...tf.text];
    /** 这个字排半格：开了 hwid，且是半格里只占一半的那几类标点。
     *  `middle`（`…—·`）不算——思源黑体的 `halt/hwid` 对破折号、省略号本来就不改 advance。 */
    const halfCell = (i: number): boolean => {
      if (!hwid) return false;
      const k = punctClass(chars[i]!);
      return k === "open" || k === "close" || k === "stop";
    };
    const latin = (i: number): boolean => chars[i]! < "\u2000";
    const xs: number[] = [];
    let w = 0;
    for (let i = 0; i < chars.length; ) {
      const c = chars[i]!;
      if (latin(i)) {
        let j = i;
        while (j < chars.length && latin(j)) j++;
        const seg = chars.slice(i, j).join("");
        for (let k = 0; k < j - i; k++) xs.push(w + (k ? font.measureText("|" + seg.slice(0, k) + "|") - 2 * bar : 0));
        w += font.measureText("|" + seg + "|") - 2 * bar;
        i = j;
      } else if (halfCell(i)) {
        const cell = font.size * 0.5;
        const ink = font.charBound(c);
        xs.push(w + (cell - (ink.right - ink.left)) / 2 - ink.left);
        w += cell;
        i++;
      } else {
        xs.push(w);
        w += font.measureText(`一${c}一`) - pad;
        i++;
      }
    }
    tf.charXs = xs;
    const x = p.align === "center" ? p.x - w / 2 : p.align === "right" ? p.x - w : p.x;
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1, x, p.y]);
    tf.matrix = m;
    page.add(tf);
  }
}

/** 全角标点 → 半角（`hwid` 的替代）。只换标点，汉字与全角字母数字不动。 */
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
  if (!songs.length) return { pages: [], toc: [], starts: [], titles: [], families: [], errors, frames: [] };

  const book = computeStyleForPaper([THEMES.staff, input.rules], { engine: "staff", mode: "mixed" });
  const { w: pageW, h: pageH, margin } = pageSize(book);
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
  // 出 PDF 按角色（= 字体族）挑字体文件；粗体、斜体各是另一份字体文件，角色名带「 Bold」「 Italic」
  //（Times New Roman Italic.ttf；思源黑体的 Bold 与 Regular 同在一个 ttc 里，face 名不同）。
  // 出 PDF 那头没有「合成粗体」这回事：不带上这个标志，`<words font-weight="bold">`
  //（《为基督大业》的 D.S.）会按常规字重画出来。
  const roleOf = (it: TextFrame): string => {
    const fam = (it.font?.family ?? "") + (it.font?.bold ? " Bold" : "") + (it.font?.italic ? " Italic" : "");
    usedFamilies.add(fam);
    return fam;
  };
  // 纸张一律 A4（genSongBook 的 CGContextBeginPage 固定 595×842），谱面按各曲 scaling 缩放后贴左上角：
  // scaling 不是 A4 口径的曲目（如 1400 tenths）内容变小、纸不变
  const pages = pageGroups.map((g, i) => ({
    ...pageItemsToDrawPage(g, pageW, pageH, { pageNo: i + 1, meta: { kind: "score", songs: [] }, scale: pageScaling[i]!, roleOf }),
    w: A4_PT.w,
    h: A4_PT.h,
  }));
  const titles = songs.map((s) => s.title);
  const toc = tocPages(book, titles, starts, families, usedFamilies);
  const frameFacts = frames.map((f) => ({
    song: f.song, height: f.height, ypos: f.ypos, newPage: f.newPage,
    head: f.first ? f.musicYOffset : 0, foot: f.last ? f.height - f.bottomTextYOffset : 0,
  }));
  return { pages, toc, starts, titles, families: [...usedFamilies], errors, frames: frameFacts };
}

function exprFlag(s: SongLayout, key: string): boolean {
  const env = s.env(0, 1);
  const v = env.field(`meta.${key}`)?.[0]?.text;
  return v === undefined ? true : v === "true";
}

// ───────────────────────── 目录（genTOC） ─────────────────────────

/**
 * 目录页（A4 pt 口径，`@template toc`）。普通行只排在首页（页题）；`repeat: toc` 的行按条目逐条重复：
 * 首条基线 = 行的 `baseline`，每条下移 `step`，过了页底另起一页、回到 `baseline`。
 * 条目里的 `leader(dots, 到)` 组件是点线：能塞多少个「.」就塞多少，右端贴 `到`，比基线高 0.3 个字号（genTOC 原式）。
 */
function tocPages(sheet: StyleSheet, titles: string[], starts: number[], families: Record<string, string>, used: Set<string>): DrawPage[] {
  const region = sheet.template?.regions?.toc as Region | undefined;
  if (!region) return [];
  const W = A4_PT.w;
  const H = A4_PT.h;
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
  const measure = (role: string, t: string, size: number): number => fontOfRole(sheet, families, role, size).measureText(t);
  const leader: ComponentFn = ({ args, y, role, size, row }) => {
    if (args[0]?.k !== "id" || args[0].v !== "dots" || args[1] === undefined) throw new Error("目录点线写 leader(dots, 右端 x)");
    const to = evalNum(args[1], e0)!;
    // 贴着左边最靠右的那段字；减法顺序照原式（`到 − 字宽 − 起点`），浮点逐位一致
    const space = Math.min(to, ...row.filter((p) => p.x < to).map((p) => to - measure(p.role, p.text, p.size) - p.x));
    let dots = "";
    for (let j = 0; j < (space * 5) / size; j++) {
      if (measure(role, dots + ".", size) > space) break;
      dots += ".";
    }
    return [text(dots, role, to - measure(role, dots, size), y - size * 0.3, size)];
  };
  const env = (fields: Record<string, string>): RegionEnv => ({
    field: songFields(undefined, fields),
    pageNo: 1,
    content: { left: 0, right: W },
    pageWidth: W,
    sizeOf: (role) => (resolveLength(sheet.roles[role as keyof StyleSheet["roles"]]?.size, { em: 12, sp: 6, pt: 1 }) ?? 12),
    measure,
    components: { leader },
  });
  const e0 = env({});
  const toItems = (placed: readonly Placed[]): DrawItem[] =>
    placed.map((p) => {
      if (p.kind === "raw") return p.item as DrawItem;
      const x = p.align === "center" ? p.x - measure(p.role, p.text, p.size) / 2 : p.align === "right" ? p.x - measure(p.role, p.text, p.size) : p.x;
      return text(p.text, p.role, x, p.y, p.size);
    });
  const pages: DrawPage[] = [];
  let items: DrawItem[] = [];
  const newPage = (): void => {
    items = [];
    pages.push({ pageNo: pages.length + 1, w: W, h: H, meta: { kind: "toc", songs: [] }, items });
  };
  newPage();
  const isRepeat = (r: Row): boolean => r.props.repeat !== undefined;
  items.push(...toItems(layoutRegion({ ...region, rows: region.rows.filter((r) => !isRepeat(r)) }, e0).items));
  for (const row of region.rows.filter(isRepeat)) {
    if (exprWord(row.props.repeat) !== "toc") throw new Error("目录区域的重复行只认 repeat: toc");
    const role = row.cells.flatMap((c) => c.lines).find((l) => l.content.kind === "text")?.role ?? "toc";
    const first = evalNum(row.props.baseline, e0);
    const step = evalNum(row.props.step, e0, role);
    if (first === undefined || step === undefined) throw new Error("目录的重复行要写 baseline 与 step");
    let y = first;
    titles.forEach((title, i) => {
      if (y > H - 40) {
        newPage();
        y = first;
      }
      const f = env({ "toc.seq": String(i + 1), "toc.pad": i < 9 ? " " : "", "work.title": title, "toc.page": String(starts[i] ?? "") });
      items.push(...toItems(layoutRegion({ ...region, rows: [{ ...row, props: { ...row.props, baseline: { k: "num", v: y } } }] }, f).items));
      y += step;
    });
  }
  return pages;
}
