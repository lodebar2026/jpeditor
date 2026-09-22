// 简谱引擎这一路的排页（`Layout.fromScore` 之后把页组装好）：原样档 / 成书 / 帮助示例的标题块与连续长纸，
// 展开档的标题页与页脚。只动 `layout.pages` 与页面树，不碰 DOM、不持有状态——排版器与导出都调它。
//
// 原样档：版面由调用方经样式表灌进 `layout.options`（`style/jianpu.ts::applyJianpuStyle`：原样档 `original` 预设、成书 `book` 预设），
// 标题排在第一页顶上（`bookHead`）或整首一张连续长纸。
// 展开档：反复与多段歌词逐遍展开（`Layout.fromScore` 走 `playData`），第一页是独立的标题词曲页、其后每页有页脚曲名 + 「i/n」页码。

import { Font } from "./font";
import { Group, PageItem, TextFrame } from "./pageitem";
import type { Layout } from "./layout";
import { MusicCommon } from "../score/jppitch";
import type { JScore } from "./input";
import { jpTimeSigItems } from "./jpglyph";

/** `h > 0` 时标题块整页居中（老行为，标题页用）；`h = 0` 时从纸顶排起（连续长纸用）。 */
export function titlePage(layout: Layout, score: JScore, w: number, h: number): Group {
  const opt = layout.options;
  const fnt = opt.lrcFont;
  const pg = new Group();
  let titleCount = 0;
  const texts: string[] = [];
  const fonts: Font[] = [];
  for (const it of score.credit) {
    const isTitle = it.type === "title";
    const sz = isTitle ? opt.titleSize : opt.creditSize;
    if (isTitle) {
      titleCount++;
      texts.unshift(it.text);
      fonts.unshift(fnt.makeWithSize(sz));
    } else {
      texts.push(it.text);
      fonts.push(fnt.makeWithSize(sz));
    }
  }
  if (titleCount === 0) {
    if (score.title.trim().length > 0) {
      titleCount = 1;
      texts.unshift(score.title);
      fonts.unshift(fnt.makeWithSize(opt.titleSize));
    }
  }
  if (titleCount !== 1) console.error("title count error!");
  let ypos = 0.3 * h;
  texts.forEach((text, idx) => {
    const font = fonts[idx];
    const obj = tagHeader(multipleLineText(text, font, w, opt.color));
    obj.y = ypos;
    obj.update();
    pg.add(obj);
    ypos += obj.height;
  });
  return pg;
}


function multipleLineText(str: string, fnt: Font, w: number, clr: number): PageItem {
  const arr = str.split("\n");
  const grp = new Group();
  let ypos = 0;
  const fm = fnt.metrics;
  const height = fm.descent - fm.ascent;
  for (const it of arr) {
    const tf = new TextFrame();
    tf.color = clr;
    tf.font = fnt;
    tf.text = it;
    const ww = tf.measureText();
    tf.x = (w - ww) / 2;
    tf.y = ypos;
    ypos += height;
    if (arr.length === 1) return tf;
    grp.add(tf);
  }
  return grp;
}


export function layoutOriginalPages(layout: Layout, score: JScore, w: number, h: number, dur: string | null): number[] {
  const opt = layout.options;
  let pageHeights: number[] = [];
  // 标题块（`bookHead`）**要在排版之前量**：分页那一路得先知道它多高，
  // 才能让首页少放几行（`LayoutOptions.firstPageHeadroom`）。
  const head = opt.continuousPage || opt.bookHead ? bookHead(layout, score, w) : null;
  if (head) head.update();
  opt.firstPageHeadroom = head && !opt.continuousPage ? head.height + opt.marginTop : 0;
  layout.fromScore(score, dur, w, h);
  // 没有页脚：原样档是印刷歌本的排法，成书（`pageFurniture: "none"`）的页眉页脚由整本那一层统一加；
  // 页脚只归展开档（`layoutExpandedPages`）。
  if (opt.continuousPage) pageHeights = stackContinuous(layout, head!);
  else if (head) attachBookHead(layout, head);
  else {
    // 既不叠标题块也不是长纸（成书、帮助示例）：标题另起一页
    const title = titlePage(layout, score, w, h);
    title.update();
    layout.pages.unshift(title);
  }
  for (const p of layout.pages) p.update();
  return pageHeights;
}

/** 分页那一路的标题块：排在**第一页顶上**，谱行已由 `firstPageHeadroom` 让开位置。
 *
 *  **另包一层 Group，不能直接 `first.add(head)`**：`Group.update` 会把子元素归一化到
 *  左上角原点、把偏移收进 group 自身的 x/y，而 `first` 早已 update 过——它的谱行 y 从 0
 *  起算，`marginTop + headroom` 那段偏移在 `first.y` 上。往里塞 head 再设 `head.y`，
 *  设的是**相对第一条谱行**的位置，标题就压到谱面上了。 */
function attachBookHead(layout: Layout, head: Group): void {
  const opt = layout.options;
  const first = layout.pages[0];
  if (!first) {
    head.y = opt.marginTop;
    layout.pages = [head];
    return;
  }
  const outer = new Group();
  outer.add(head);
  head.y = opt.marginTop;
  outer.add(first); // first.y 已是 marginTop + firstPageHeadroom，正好在标题块下方
  outer.update();
  layout.pages[0] = outer;
}

/**
 * 连续长纸（「原样」档）：标题与词曲**排在同一张纸的顶上**，谱面接在下面，
 * 整张纸多高由内容说了算——不另起标题页，也没有页脚。
 */
function stackContinuous(layout: Layout, head: Group): number[] {
  const opt = layout.options;
  const first = layout.pages[0];
  if (!first) return [];
  first.update();
  const outer = new Group();
  outer.add(head);
  head.y = opt.marginTop;
  outer.add(first);
  // 标题块与第一条谱行之间留一个上边距那么宽的空
  first.y = head.y + head.height + opt.marginTop;
  outer.update();
  layout.pages = [outer];
  return [outer.y + outer.height + opt.marginBottom];
}

/** 标题 + 词曲那一块，从 y = 0 往下排。
 *  与 `titlePage` 同一份内容，差别只在纵向落位（那个是整页居中）。 */
export function titleBlock(layout: Layout, score: JScore, w: number): Group {
  return titlePage(layout, score, w, 0);
}

/** 词曲署名拆成逐行的文本：一个字段里可能写了好几行（Finale 导出的样子），
 *  没带「作词：」这类标签的按 `type` 补一个（scripts/rebuild.mjs::decorateSong 同一份规则）。 */
function creditLines(score: JScore): string[] {
  const LABEL: Record<string, string> = {
    lyricist: "作词", poet: "作词", composer: "作曲", arranger: "编曲",
    "words-and-music": "词曲", translator: "译词", transcriber: "制谱",
  };
  const out: string[] = [];
  for (const c of score.credit) {
    if (c.type === "title" || c.type === "subtitle") continue; // 副标题跟标题一起居中，见 bookHead
    for (const raw of c.text.split(/\r?\n/)) {
      const t = raw.trim();
      if (!t) continue;
      // 已经自带标签的（「作词：X」「X 词曲」「X 曲」）照原文，不再叠一个
      const labeled = /[:：]/.test(t) || /(?:词曲|作词|作曲|编曲|译词|制谱)\s*$|(?:^|\s)[词曲]\s*$/.test(t);
      out.push(labeled || !c.type ? t : `${LABEL[c.type] ?? c.type}：${t}`);
    }
  }
  return out;
}

/**
 * 「原样」档纸顶那一块 —— **照 500 首重排的成书排版**（`scripts/rebuild.mjs::decorateSong`）：
 * 标题居中、**调号拍号排在左边**、**词曲署名右对齐逐行**。
 *
 * 原先这一块把词曲跟标题一样居中堆在标题底下，调号拍号则**根本没画**——
 * 编辑器那一路只在曲中转调/转拍号时才画（`KeySig` / `TimeSig` 两个 Entry），
 * 首调与首拍号历来只存在 `.Title` 的字段里，排不上纸。
 *
 * 纵向那几个间距按成书实测反算（基准是署名字号 `roles.credit.size` = 11.01pt，墨迹高 8.99）：
 * 行距 `creditLineGap` 13.1 = 1.19 个署名字号；调号拍号的基线与**最后一行**署名齐
 * （成书 `keyMeterBaseline` 117.94 落在第二行署名 116.08 上，两行署名是常态）。
 */
function bookHead(layout: Layout, score: JScore, w: number): Group {
  const opt = layout.options;
  const pg = new Group();
  const fnt = opt.lrcFont;
  const left = opt.marginLeft;
  const right = w - opt.marginRight;

  // 标题：居中（可多行），与 titlePage 同一份内容
  const titles: string[] = [];
  for (const it of score.credit) if (it.type === "title") titles.push(it.text);
  if (titles.length === 0 && score.title.trim().length > 0) titles.push(score.title);

  // 副标题（123/ABC 的第二条 `T:`）：标题底下居中，字号同署名
  const subtitles = score.credit.filter((c) => c.type === "subtitle").map((c) => c.text);
  const credits = creditLines(score);
  // **窄纸要缩排**：标题与署名的字号是照长图那张 1000 宽的纸定的，换到 A4/A5 就装不下
  //（署名是右对齐的，量出来比版心还长时 x 直接成负数，整块探到纸外去——
  // 基督更美在 A4 上曾左溢 294pt、整块比纸还宽 244pt）。按最宽的那一行整块等比缩，
  // **够宽时 k = 1、一点不动**，所以长图那一档的观感分毫不变。
  const headScale = (size: number, lines: readonly string[]): number => {
    const f = fnt.makeWithSize(size);
    let need = 0;
    for (const t of lines) for (const one of t.split("\n")) need = Math.max(need, f.measureText(one));
    return need > 0 ? need : 0;
  };
  const avail = Math.max(1, right - left);
  const need = Math.max(headScale(opt.titleSize, titles), headScale(opt.creditSize, [...subtitles, ...credits]));
  const k = need > avail ? avail / need : 1;
  const titleSize = opt.titleSize * k;
  const creditSize = opt.creditSize * k;

  let ypos = 0;
  for (const t of titles) {
    const obj = tagHeader(multipleLineText(t, fnt.makeWithSize(titleSize), w, opt.color));
    obj.y = ypos;
    obj.update();
    pg.add(obj);
    ypos += obj.height;
  }
  for (const t of subtitles) {
    const obj = tagHeader(multipleLineText(t, fnt.makeWithSize(creditSize), w, opt.color));
    obj.y = ypos;
    obj.update();
    pg.add(obj);
    ypos += obj.height;
  }

  // 词曲署名：右对齐，一行一条
  const cf = fnt.makeWithSize(creditSize);
  const cfm = cf.metrics;
  const gap = creditSize * 1.19;
  const base = ypos - cfm.ascent;
  credits.forEach((t, i) => {
    const tf = new TextFrame();
    tf.font = cf;
    tf.color = opt.color;
    tf.text = t;
    tf.y = base + i * gap;
    tf.x = right - tf.measureText();
    pg.add(tagHeader(tf));
  });

  // 调号拍号：左对齐，基线与最后一行署名齐
  const km = keyMeter(layout, score, left, base + Math.max(0, credits.length - 1) * gap);
  if (km) pg.add(km);
  return pg;
}

/**
 * 「1=♭B ⁴⁄₄」——调号 + 上下叠排的拍号（成书 `bookparts.ts::keyMeterItems` 的观感）。
 *
 * 两处照成书：**升降号提到音名之前**、比音名小一号并抬高（连成一串画的话 ♭ 会跟音名
 * 同基线同字号，位置就塌了）；拍号**上下叠排**、分数线与音名的墨迹中心齐平。
 * 拍号本身仍走公共那一份 `jpglyph.ts::jpTimeSigItems`（三条简谱路共用），
 * 尺寸与曲中的转拍号同一把尺子（`TimeSig.layout`），不另立一套。
 */
function keyMeter(layout: Layout, score: JScore, x: number, baseline: number): Group | null {
  const opt = layout.options;
  const m0 = score.parts[0]?.measures[0];
  if (!m0) return null;
  const g = new Group();
  // 升降号写在音名**之前**（`MusicCommon.keys` 就是这个写法，成书亦然：`♭B` / `#F`），
  // 与曲中的「转1=Bb」不同——那一处是既有观感，不在这里改。
  const name = MusicCommon.keys[m0.key.fifths + 7] ?? "C";
  const acc = /^([b#])(.+)$/.exec(name);
  const font = opt.numberFont;
  const ink = opt.numberBound("1").height;

  let cur = x;
  const put = (text: string, f: Font, y: number): number => {
    const tf = new TextFrame();
    tf.font = f;
    tf.color = opt.color;
    tf.text = text;
    tf.x = cur;
    tf.y = y;
    tf.classes.add("hdr-keysig"); // 可视化编辑认页眉的调号（`headerParts`）
    g.add(tf);
    return tf.measureText();
  };
  cur += put("1=", font, baseline);
  if (acc) {
    // 成书实测：升降号 0.72 个音名字号、墨迹顶高出音名 0.69 个音名墨迹高
    cur += put(acc[1], font.makeWithSize(font.size * 0.72), baseline - ink * 0.69) * 1.05;
    cur += put(acc[2], font, baseline);
  } else {
    cur += put(name, font, baseline);
  }

  cur += ink * 0.37;
  const top = opt.jpStaffTop;
  const bot = opt.jpStaffBottom;
  const r = jpTimeSigItems(m0.time.beats, m0.time.beatType, {
    height: bot - top,
    centerY: 0,
    // 成书这一处的拍值与音名同大小（`roles.keyMeter` 一个字号管两者），
    // 比曲中的转拍号（0.75 个音符字号）大一点。
    digitRatio: opt.numberSize / (bot - top),
    ruleWidth: opt.timeSigRuleWidth > 0 ? opt.timeSigRuleWidth : 1.5,
    color: opt.color,
    // **不加粗**：成书这一处调号与拍号同字体同字重，曲中的转拍号才是加粗的那一份。
    font: opt.numberFont,
  });
  for (const it of r.items) {
    it.x += cur;
    // 分数线与音名的**墨迹中心**齐平（成书 keyMeterItems 把线放在基线上方 0.34 个墨迹高）
    it.y += baseline - ink * 0.34;
    it.classes.add("hdr-time");
    g.add(it);
  }
  return g;
}

/** 展开档排一份引擎输入：`fromScore` → 页脚 → 标题页插到最前。`breakDesc` 是 `.jpwabc` 的 `.Layout` 分页描述（文本谱没有）。 */
export function layoutExpandedPages(layout: Layout, score: JScore, w: number, h: number, breakDesc: string | null): void {
  layout.fromScore(score, breakDesc, w, h);
  // 页码不含标题页：页脚要在标题页插进来之前加
  addFooters(layout, score, w, h, layout.pages);
  const title = titlePage(layout, score, w, h);
  title.update();
  layout.pages.unshift(title);
  for (const p of layout.pages) p.update();
}

/**
 * 每页的页脚：曲名在版心里居中 + 「i/n」页码。页码左缘落在 `左边距 + 0.8 × 纸宽`
 * （16:9 纸上即 50 + 768 = 818），**放不下时向左收回到版心右缘以内**——4:3 纸配大字号时
 * 「24/24」会伸出纸外。
 */
function addFooters(layout: Layout, score: JScore, w: number, h: number, pages: readonly Group[]): void {
  const opt = layout.options;
  const font = opt.lrcFont.scaled(0.8);
  const title = score.title.split("\n")[0] ?? "";
  const n = pages.length;
  const text = (s: string): TextFrame => {
    const tf = new TextFrame();
    tf.font = font;
    tf.text = s;
    tf.color = opt.color;
    return tf;
  };
  pages.forEach((pg, i) => {
    // 页组已由 fromScore 右移一个左边距（原点在版心左缘），且 `Group.update` 把纵向偏移收进了 pg.y
    // ——纸上坐标都要减掉这两样才落对位置
    const y = h - opt.marginBottom * 0.5 - pg.y;
    if (title) {
      const tf = text(title);
      tf.x = (w - opt.marginLeft - opt.marginRight - tf.measureText()) / 2;
      tf.y = y;
      tf.update();
      pg.add(tf);
    }
    const no = text(`${i + 1}/${n}`);
    no.x = Math.min(opt.marginLeft + 0.8 * w, w - opt.marginRight - no.measureText()) - opt.marginLeft;
    no.y = y;
    no.update();
    pg.add(no);
  });
}

/** 页眉文字标 `hdr`（多行的标题逐行标）。 */
function tagHeader<T extends PageItem>(obj: T): T {
  if (obj instanceof TextFrame) obj.classes.add("hdr");
  else for (const c of obj.children) if (c instanceof TextFrame) c.classes.add("hdr");
  return obj;
}
