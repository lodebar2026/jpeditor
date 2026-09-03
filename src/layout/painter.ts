// Ported from mp/layout/draw.kt (JinpuPainter). Renders the page tree to SVG
// (replacing Skija Canvas drawing) and provides resize/title-page/pick.

import { Point, Rect, colorToCss } from "../common/geom";
import { Font } from "./font";
import {
  Group,
  Layout,
  NoteEntry,
  PageItem,
  TextFrame,
  SmuflText,
} from "./layout";
import { Chord, MusicCommon, Score } from "../score/score";
import { jpTimeSigItems } from "./jpglyph";
import type { PagePainter } from "./pagepainter";
import { walkPageItem, type ItemVisitor } from "./walk";

const SVG_NS = "http://www.w3.org/2000/svg";

export class JinpuPainter implements PagePainter {
  layout: Layout;
  score = new Score();
  pageWidth = 0;
  pageHeight = 0;
  /** PageItem -> rendered <g>, populated each renderPage (for DOM picking). */
  nodeMap = new WeakMap<PageItem, SVGGElement>();
  /** Chord -> its note-entry groups (one per rendered verse/pass), for playback cursor. */
  private chordItem = new Map<Chord, { page: number; item: PageItem; verse: number }[]>();
  private highlighted: PageItem | null = null;
  /** 逐页高度。空 = 各页同高（`pageHeight`）；连续长纸那一档按内容逐页给。 */
  private pageHeights: number[] = [];

  constructor(fontSize: number) {
    this.layout = new Layout(fontSize);
  }

  resize(w: number, h: number, dur: string | null): void {
    this.pageWidth = w;
    this.pageHeight = h;
    this.pageHeights = [];
    this.layout.fromScore(this.score, dur, w, h);
    if (this.layout.options.continuousPage) this.stackContinuous(w);
    else this.layout.pages.unshift(this.titlePage(w, h));
    for (const p of this.layout.pages) p.update();
    this.buildChordIndex();
  }

  /**
   * 连续长纸（「简谱」档）：标题与词曲**排在同一张纸的顶上**，谱面接在下面，
   * 整张纸多高由内容说了算——不另起标题页，也没有页脚。
   */
  private stackContinuous(w: number): void {
    const opt = this.layout.options;
    const score = this.layout.pages[0];
    if (!score) return;
    score.update();
    const head = this.bookHead(w);
    head.update();
    const outer = new Group();
    outer.add(head);
    head.y = opt.marginTop;
    outer.add(score);
    // 标题块与第一条谱行之间留一个上边距那么宽的空
    score.y = head.y + head.height + opt.marginTop;
    outer.update();
    this.layout.pages = [outer];
    this.pageHeights = [outer.y + outer.height + opt.marginBottom];
  }

  /** Walk each page tree, mapping every Chord to its note-entry group(s). */
  private buildChordIndex(): void {
    this.chordItem.clear();
    this.highlighted = null;
    const walk = (item: PageItem, page: number): void => {
      if (item.data instanceof NoteEntry) {
        const ch = item.data.chord;
        if (ch) {
          const list = this.chordItem.get(ch) ?? [];
          list.push({ page, item, verse: item.data.verse });
          this.chordItem.set(ch, list);
        }
      }
      for (const c of item.children) walk(c, page);
    };
    this.layout.pages.forEach((pg, i) => walk(pg, i));
  }

  /** The rendered entry for a chord at a given pass/verse (falls back to first). */
  private hitFor(chord: Chord, pass: number): { page: number; item: PageItem } | null {
    const list = this.chordItem.get(chord);
    if (!list || list.length === 0) return null;
    return list.find((h) => h.verse === pass) ?? list[0];
  }

  /** Highlight the note of `chord` at `pass` (clearing any previous). Returns page index. */
  highlightChord(chord: Chord | null, pass = 0): number | null {
    if (this.highlighted) {
      this.nodeMap.get(this.highlighted)?.classList.remove("playing");
      this.highlighted = null;
    }
    if (!chord) return null;
    const hit = this.hitFor(chord, pass);
    if (!hit) return null;
    this.nodeMap.get(hit.item)?.classList.add("playing");
    this.highlighted = hit.item;
    return hit.page;
  }

  /** SVG <g> for a chord's note at `pass` (for scroll-into-view); null if not rendered. */
  chordGroupEl(chord: Chord, pass = 0): SVGGElement | null {
    const hit = this.hitFor(chord, pass);
    return hit ? this.nodeMap.get(hit.item) ?? null : null;
  }

  private multipleLineText(str: string, fnt: Font, w: number, clr: number): PageItem {
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

  /** 标题 + 词曲那一块，从 y = 0 往下排。
   *  与 `titlePage` 同一份内容，差别只在纵向落位（那个是整页居中）。 */
  titleBlock(w: number): Group {
    return this.titlePage(w, 0);
  }

  /** 词曲署名拆成逐行的文本：一个字段里可能写了好几行（Finale 导出的样子），
   *  没带「作词：」这类标签的按 `type` 补一个（scripts/rebuild.mjs::decorateSong 同一份规则）。 */
  private creditLines(): string[] {
    const LABEL: Record<string, string> = {
      lyricist: "作词", poet: "作词", composer: "作曲", arranger: "编曲",
    };
    const out: string[] = [];
    for (const c of this.score.credit) {
      if (c.type === "title") continue;
      for (const raw of c.text.split(/\r?\n/)) {
        const t = raw.trim();
        if (!t) continue;
        out.push(/[:：]/.test(t) || !c.type ? t : `${LABEL[c.type] ?? c.type}：${t}`);
      }
    }
    return out;
  }

  /**
   * 「简谱」档纸顶那一块 —— **照 500 首重排的成书排版**（`scripts/rebuild.mjs::decorateSong`）：
   * 标题居中、**调号拍号排在左边**、**词曲署名右对齐逐行**。
   *
   * 原先这一块把词曲跟标题一样居中堆在标题底下，调号拍号则**根本没画**——
   * 编辑器那一路只在曲中转调/转拍号时才画（`KeySig` / `TimeSig` 两个 Entry），
   * 首调与首拍号历来只存在 `.Title` 的字段里，排不上纸。
   *
   * 纵向那几个间距按成书实测反算（基准是署名字号 `roles.credit.size` = 8.99pt）：
   * 行距 `creditLineGap` 13.1 = 1.46 个署名字号；调号拍号的基线与**最后一行**署名齐
   * （成书 `keyMeterBaseline` 117.94 落在第二行署名 116.08 上，两行署名是常态）。
   */
  private bookHead(w: number): Group {
    const opt = this.layout.options;
    const pg = new Group();
    const fnt = opt.lrcFont;
    const left = opt.marginLeft;
    const right = w - opt.marginRight;

    // 标题：居中（可多行），与 titlePage 同一份内容
    const titles: string[] = [];
    for (const it of this.score.credit) if (it.type === "title") titles.push(it.text);
    if (titles.length === 0 && this.score.title.trim().length > 0) titles.push(this.score.title);

    let ypos = 0;
    for (const t of titles) {
      const obj = this.multipleLineText(t, fnt.makeWithSize(opt.titleSize), w, opt.color);
      obj.y = ypos;
      obj.update();
      pg.add(obj);
      ypos += obj.height;
    }

    // 词曲署名：右对齐，一行一条
    const credits = this.creditLines();
    const cf = fnt.makeWithSize(opt.creditSize);
    const cfm = cf.metrics;
    const gap = opt.creditSize * 1.46;
    const base = ypos - cfm.ascent;
    credits.forEach((t, i) => {
      const tf = new TextFrame();
      tf.font = cf;
      tf.color = opt.color;
      tf.text = t;
      tf.y = base + i * gap;
      tf.x = right - tf.measureText();
      pg.add(tf);
    });

    // 调号拍号：左对齐，基线与最后一行署名齐
    const km = this.keyMeter(left, base + Math.max(0, credits.length - 1) * gap);
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
  private keyMeter(x: number, baseline: number): Group | null {
    const opt = this.layout.options;
    const m0 = this.score.parts[0]?.measures[0];
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
      g.add(it);
    }
    return g;
  }

  /** `h > 0` 时标题块整页居中（老行为，标题页用）；`h = 0` 时从纸顶排起（连续长纸用）。 */
  titlePage(w: number, h: number): Group {
    const opt = this.layout.options;
    const fnt = opt.lrcFont;
    const pg = new Group();
    let titleCount = 0;
    const texts: string[] = [];
    const fonts: Font[] = [];
    for (const it of this.score.credit) {
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
      if (this.score.title.trim().length > 0) {
        titleCount = 1;
        texts.unshift(this.score.title);
        fonts.unshift(fnt.makeWithSize(opt.titleSize));
      }
    }
    if (titleCount !== 1) console.error("title count error!");
    let ypos = 0.3 * h;
    texts.forEach((text, idx) => {
      const font = fonts[idx];
      const obj = this.multipleLineText(text, font, w, opt.color);
      obj.y = ypos;
      obj.update();
      pg.add(obj);
      ypos += obj.height;
    });
    return pg;
  }

  // ---------------- SVG rendering ----------------

  /** Render one page group into a standalone <svg> of pageWidth x pageHeight. */
  renderPage(pageIndex: number): SVGSVGElement {
    const { w, h } = this.pageSize(pageIndex);
    return renderPageSvg(this.layout.pages[pageIndex], w, h, this.nodeMap);
  }

  /** Walk up from a picked item to its enclosing "entry" group (else the item). */
  entryGroupOf(item: PageItem): PageItem {
    let cur: PageItem | null = item;
    while (cur) {
      if (cur.classes.has("entry")) return cur;
      cur = cur.parent;
    }
    return item;
  }

  get pageCount(): number {
    return this.layout.pages.length;
  }

  /** PagePainter：一般各页同尺寸（resize 给定的纸张）；连续长纸那一档按内容逐页给高。 */
  pageSize(index: number): { w: number; h: number } {
    return { w: this.pageWidth, h: this.pageHeights[index] ?? this.pageHeight };
  }

  // ---------------- picking (Phase 3) ----------------

  private calcDist(x: number, y: number, inn: Rect): number {
    let dx = 0;
    if (x < inn.left) dx = inn.left - x;
    else if (x > inn.right) dx = x - inn.right;
    let dy = 0;
    if (y < inn.top) dy = inn.top - y;
    else if (y > inn.bottom) dy = y - inn.bottom;
    return dx + dy;
  }

  pick(root: PageItem, x: number, y: number): [PageItem | null, number] {
    let bnd = root.bound;
    bnd = bnd.offset(root.x, root.y);
    const edge = 5;
    const dist = this.calcDist(x, y, bnd);
    if (root.children.length === 0) {
      let outer = new Rect(bnd.left, bnd.top, bnd.right, bnd.bottom);
      const dx = Math.min(bnd.width - edge * 2, 0) / 2;
      const dy = Math.min(bnd.height - edge * 2, 0) / 2;
      outer = outer.inset(dx, dy);
      return outer.contains(x, y) ? [root, dist] : [null, dist];
    }
    let outer = new Rect(bnd.left, bnd.top, bnd.right, bnd.bottom);
    outer = outer.inset(-edge, -edge);
    if (outer.contains(x, y)) {
      const xx = x - bnd.left;
      const yy = y - bnd.top;
      const items: PageItem[] = [];
      let minDist = Number.MAX_VALUE;
      let best: PageItem | null = null;
      let small: PageItem | null = null;
      for (const ch of root.children) {
        const [p, pd] = this.pick(ch, xx, yy);
        if (p !== null) {
          if (pd < minDist) {
            best = p;
            minDist = pd;
            items.length = 0;
            items.push(p);
          }
          if (pd === minDist) items.push(p);
          if (ch.bound.width < edge || ch.bound.height < edge) small = ch;
        }
      }
      if (small !== null) return [small, 0];
      let area = Number.MAX_VALUE;
      for (const it of items) {
        const a = it.bound.width * it.bound.height;
        if (a < area) {
          best = it;
          area = a;
        }
      }
      return [best, minDist];
    }
    return [null, Number.MAX_VALUE];
  }

  pickPage(page: number, pos: Point): PageItem | null {
    const pg = this.layout.pages[page];
    const [p] = this.pick(pg, pos.x, pos.y);
    return p;
  }
}

/** `renderPageSvg` 的可选项。第四个参数直接给 WeakMap 是老写法，保留不动。 */
export interface PageSvgOptions {
  nodeMap?: WeakMap<PageItem, SVGGElement>;
  /** `<svg>` 的 class，默认 `score-page`。混排那一路还要加 `mixed-page`。 */
  cls?: string;
  /** 页面树怎么变成 DOM。默认谱面那一路的语义；混排传它自己那份（见 mixed/painter.ts）。 */
  visitor?: ItemVisitor<SVGGElement>;
}

/** 一页的页面树 → 独立 `<svg>`。JinpuPainter / PuPainter / MixedPainter 共用
 *  （三者的页面树是同一套 PageItem，只是排版器与 visitor 不同）。
 *  `root` 为空时给出一个空白页而不是抛错。 */
export function renderPageSvg(
  root: PageItem | undefined,
  width: number,
  height: number,
  opts?: WeakMap<PageItem, SVGGElement> | PageSvgOptions,
): SVGSVGElement {
  const o: PageSvgOptions = opts instanceof WeakMap ? { nodeMap: opts } : (opts ?? {});
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", o.cls ?? "score-page");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  if (root) {
    const holder = document.createElementNS(SVG_NS, "g");
    walkPageItem(root, holder, o.visitor ?? svgVisitor(o.nodeMap));
    // visitor 可能不为根产生 <g>（混排那份只给 Group 造），所以整批搬过去
    while (holder.firstChild) svg.appendChild(holder.firstChild);
  }
  return svg;
}

/**
 * 谱面这一路的 visitor：**每个** PageItem 都产生一个 <g>，matrix 加在它身上，
 * 自身图形与子级都放进去（所以叶子元素自己不带 transform）。
 * 与 mixed 那份的语义差别见 mixed/painter.ts::mixedVisitor 的注释。
 */
function svgVisitor(nodeMap?: WeakMap<PageItem, SVGGElement>): ItemVisitor<SVGGElement> {
  const enter = (item: PageItem, parent: SVGGElement): SVGGElement => {
    const g = document.createElementNS(SVG_NS, "g");
    if (!item.matrix.isIdentity) g.setAttribute("transform", item.matrix.toSvg());
    parent.appendChild(g);
    nodeMap?.set(item, g);
    return g;
  };
  return {
    descend: enter,
    path: (item, g) => {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", item.d);
      if (item.fill) p.setAttribute("fill", colorToCss(item.fillColor));
      else p.setAttribute("fill", "none");
      if (item.stroke) {
        p.setAttribute("stroke", colorToCss(item.strokeColor));
        p.setAttribute("stroke-width", String(item.strokeWidth));
      }
      g.appendChild(p);
    },
    line: (item, g) => {
      const l = document.createElementNS(SVG_NS, "line");
      l.setAttribute("x1", String(item.p0.x));
      l.setAttribute("y1", String(item.p0.y));
      l.setAttribute("x2", String(item.p1.x));
      l.setAttribute("y2", String(item.p1.y));
      l.setAttribute("stroke", colorToCss(item.strokeColor));
      l.setAttribute("stroke-width", String(item.strokeWidth));
      l.setAttribute("stroke-linecap", "butt");
      g.appendChild(l);
    },
    text: (item, g) => {
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", "0");
      t.setAttribute("y", "0");
      const family = item instanceof SmuflText ? "Bravura" : item.font.family;
      t.setAttribute("font-family", family);
      t.setAttribute("font-size", String(item.font.size));
      if (item.font.bold) t.setAttribute("font-weight", "bold");
      t.setAttribute("fill", colorToCss(item.color));
      // 逐字笔位（标点挤压后的坐标，排版期量的那一串）。给了 `x` 列表就由它定位，
      // **不再叠 font-feature-settings**——测量已经把挤压算进去了，再叠一层会挤两遍。
      if (item.charXs && item.charXs.length > 1)
        t.setAttribute("x", item.charXs.map((v) => v.toFixed(2)).join(" "));
      t.textContent = item.text;
      g.appendChild(t);
    },
    // Group / 裸 PageItem：只有子级，descend 里那个 <g> 就是全部
  };
}
