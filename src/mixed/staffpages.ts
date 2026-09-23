// 五线谱 / 混排的版面：混排简谱层与谱表上方那一摞（formatMixedScore / placeAboveStaff），
// 以及分页 + 标题块（paoSingleScore 的 getFrames / flowLayout / drawFrames 移植）。
// 页面尺寸/边距以 MusicXML <defaults> 为准（不固定画布），单位 tenths。只产页面树，不碰 DOM。
// 从 musicpp util/pao.cpp 移植（formatScorePAO + paoSingleScore，不含 fixPaoScore 逐曲 hack）。

import { headerRoleOfCredit } from "../style/header";
import { Fraction } from "../common/fraction";
import { Matrix33 } from "../common/geom";
import { Font } from "../layout/font";
import { Group, TextFrame } from "../layout/pageitem";
import { harmonyBand, LCR, StaffLayout, Notation, ScoreCredit, Sys } from "./model";
import { drawSystem } from "./render";

// -----------------------------------------------------------------------
// formatMixedScore（formatScorePAO port, without per-song hacks）

/**
 * Post-process the loaded StaffLayout to set up Mixed notation on the first part:
 * - Set staves[0].notation[0] = Mixed
 * - Run calcMixedStaffY (needs notes already in place)
 * - Move harmonies to harmonyY
 * - Scale P2 lyric font × 0.8
 */
/** 混排简谱层顶（数字顶）到自动放置的文字记号基线的净空：留给简谱层上方的弧与高音点（tenths） */
const MIXED_TEXT_CLEAR = 16;
/** 五线谱档：谱表内容上沿到和弦符号墨迹底的净空（tenths） */
const HARMONY_STAFF_GAP = 6;

export function formatMixedScore(score: StaffLayout): void {
  if (score.parts.length === 0) return;

  const p = score.parts[0];
  if (p.staves.length === 0) return;

  // Set Mixed notation for first staff from tick 0
  p.staves[0].notation.set(new Fraction(0), Notation.Mixed);

  placeAboveStaff(score, true);

  // P2 lyric font × 0.8
  const lastPart = score.parts[score.parts.length - 1];
  if (lastPart !== p && lastPart.pid === "P2") {
    const refFont = score.defaults.lyricFont;
    const fnt2 = refFont.scaled(0.8);
    lastPart.setLyricFont(fnt2);
  }
  // 谱表间距照 MusicXML 的 staff-distance，不按包围盒抬高（formatScorePAO 没有这一步；
  // 成品《受苦圣徒，到基督前》各行谱表间距正是 staff-distance 原值）
}

/** 第一声部谱表上方那一摞：量上沿（`calcMixedStaffY`）→ 和弦 y → 自动放置的速度/文字记号抬过去。
 *  混排（`formatMixedScore`）与自动铺排的五线谱档共用；带坐标的五线谱档不走（和弦、文字照原文的 default-y）。 */
export function placeAboveStaff(score: StaffLayout, mixed: boolean): void {
  const p = score.parts[0];
  if (!p || p.staves.length === 0) return;
  // Calculate mixed staff y positions (needs chords/slurs in place)
  p.calcMixedStaffY();

  const eng = score.options;
  const [harmTop, harmBot] = harmonyBand(score);
  for (const sys of score.systems) {
    for (const st of sys.staves) {
      if (st.part() !== p) continue;
      // 纯五线谱：和弦底贴着谱表上沿（高音、朝上符干、上方弧）再留一点空。`calcMixedStaffY` 的 harmonyY
      // 是给混排算的——里头按简谱层的高音点、弧中段再往上加，放到五线谱上就离得太远
      if (!mixed) st.harmonyY = -st.minY + HARMONY_STAFF_GAP - harmBot - 3;
      // Move harmony y to harmonyY
      for (const m of sys.measures) {
        for (const h of p.measures[m.index]?.harmonies ?? []) h.y = st.harmonyY + 3;
      }
      if (st.partStaff !== p.staves[0]) continue;
      // 自动铺排的速度/文字记号：缺省高度只让开了五线谱。混排时简谱层（连同其上的弧、高音点）在它上面，抬过去；
      // 自动铺排时和弦行也在它下面，再抬过和弦。带 default-y 的原文不动（照 musicpp）。
      let floor = mixed ? -st.minY + eng.mixStaffDist + eng.mixStaffHeight + MIXED_TEXT_CLEAR : -st.minY + MIXED_TEXT_CLEAR;
      if (score.autoLayout && st.hasHarmony) floor = Math.max(floor, st.harmonyY + 3 + harmTop + MIXED_TEXT_CLEAR / 2);
      for (const m of sys.measures) {
        for (const t of p.measures[m.index]?.textBlocks ?? []) {
          if (t.autoY && t.staff === 0 && t.y < floor) t.y = floor;
        }
      }
    }
  }
}

// -----------------------------------------------------------------------
// M5: 分页+标题块（paoSingleScore 的 getFrames/flowLayout/drawFrames 移植）

// 页面高度/边距来自 MusicXML <defaults>（score.defaults）；以下仅作未提供时的回退。
export const PAGE_HEIGHT_FALLBACK = 1870;
const FRAME_GAP = 20;
const TITLE_OFFSET = 170; // hh(150) + 20
/** 自动铺排：标题块最低一行的基线到首行谱内容顶的余量（含该行字的下伸） */
const TITLE_GAP = 30;

interface FrameItem {
  system: Sys;
  topY: number;
  bottomY: number;
  height: number;
  musicYOffset: number;
  credits: ScoreCredit[];
}

interface LayoutFrame {
  height: number;
  ypos: number;
  newPage: boolean;
}

function getFrames(score: StaffLayout): FrameItem[] {
  const items: FrameItem[] = [];
  for (const sys of score.systems) {
    // System::getYBound（model.ts）：忠实移植，topY 为上方延伸量，bottomY 为下方（负）。
    const [topY, bottomY] = sys.getYBound();
    items.push({
      system: sys,
      topY,
      bottomY,
      height: topY - bottomY,
      musicYOffset: 0,
      credits: [],
    });
  }
  return items;
}

function flowLayout(items: FrameItem[], ph: number): LayoutFrame[] {
  const result: LayoutFrame[] = [];
  let ypos = 0;
  let lastMrg = 0;
  for (const [i, frm] of items.entries()) {
    const mrg = Math.max(lastMrg, FRAME_GAP);
    const bot = ypos + frm.height;
    // 首帧总是开新页；长图（ph = Infinity）此后不再分页
    const np = i === 0 || bot + mrg > ph;
    const lf: LayoutFrame = { height: frm.height, ypos: 0, newPage: np };
    if (np) {
      lastMrg = 0;
      ypos = 0;
    } else {
      ypos += mrg;
    }
    lf.ypos = ypos;
    ypos += frm.height;
    lastMrg = FRAME_GAP;
    result.push(lf);
  }
  return result;
}

function drawFrames(
  score: StaffLayout,
  items: FrameItem[],
  lf: LayoutFrame[],
  leftMargin: number,
  topMargin: number,
  pageHeight: number,
  pageWidthTenths: number,
): Group[] {
  const pages: Group[] = [];
  let page: Group | null = null;

  for (let i = 0; i < items.length; i++) {
    const data = items[i];
    const it = lf[i];
    const sys = data.system;

    if (it.newPage || !page) {
      page = new Group();
      pages.push(page);
    }

    // Credits (title block text) for this frame. credit-words 可含换行 → 逐行排版。
    const pg = page; // non-null here (ensured above); capture for closure

    // Sibelius MusicXML 导出 bug：credit-words 的 default-y 被整体压到页面底部
    //（绝对原点错误，但各 credit 间的相对间距仍然正确）。
    // 检测：最高的 credit（default-y 最大者）按 spec 解释（pageHeight - y）后仍落在
    // 页面下半 → 判定为该 bug，以页首为锚重排整个标题块，保留相对间距与水平对齐。
    // 正常文件标题 default-y≈页高（落在上半），不触发，绝对定位照旧。
    const creditMaxY = data.credits.length
      ? Math.max(...data.credits.map((c) => c.y))
      : 0;
    const reanchorTop = data.credits.length > 0 && pageHeight - creditMaxY > pageHeight / 2;
    // 重排时把最高 credit（标题）的基线放在上边距下方一个标题字高处。
    const titleCredit = data.credits.find((c) => c.y === creditMaxY);
    const titleFontSz = titleCredit && titleCredit.fontSize > 0
      ? titleCredit.fontSize / score.scaling
      : 20;

    const maxCreditSize = Math.max(0, ...data.credits.map((c) => c.fontSize));
    for (const cr of data.credits) {
      // 页眉字体（设置面板「页眉」一组 / 谱里 credit 自带的，`style/header.ts`）：给了的盖过 credit 自己的
      const justify = cr.justify === LCR.Right ? "right" : cr.justify === LCR.Center ? "center" : "left";
      const role = headerRoleOfCredit(cr.type ?? undefined, justify, maxCreditSize > 0 && cr.fontSize === maxCreditSize);
      const hf = role ? score.options.headerFonts[role] : undefined;
      const fntSz = hf?.size ? hf.size / score.scaling : cr.fontSize > 0 ? cr.fontSize / score.scaling : 20;
      const family = hf?.family ?? cr.family ?? (cr.fontSize > 0 ? score.defaults.lyricFont.family : "PingFang SC");
      const font = new Font(family, fntSz, hf?.bold ?? cr.bold ?? false);
      const anchorX = cr.x > 0 ? cr.x : pageWidthTenths / 2;
      // MusicXML y from page bottom → SVG top-down；Sibelius bug 时改以页首为锚。
      const baseY = reanchorTop
        ? topMargin + titleFontSz + (creditMaxY - cr.y)
        : pageHeight - cr.y;
      const lineH = fntSz * 1.2;
      const lines = cr.text.split(/\r?\n/);
      // 右对齐的多行 credit：Sibelius 把整块按最宽行右对齐，块内各行左缘对齐
      //（参考 PDF 里"词曲…/翻译…"两行 xMin 相同、右缘不同），而非逐行各自右对齐。
      const blockW = cr.justify === LCR.Right
        ? Math.max(...lines.map((l) => font.measureText(l)))
        : 0;
      lines.forEach((line, li) => {
        const tf = new TextFrame();
        tf.text = line;
        tf.font = font;
        let x = anchorX;
        const w = font.measureText(line);
        if (cr.justify === LCR.Center) x -= w / 2;
        else if (cr.justify === LCR.Right) x -= blockW;
        const m = new Matrix33();
        m.setAffine([1, 0, 0, 1, x, baseY + li * lineH]);
        tf.matrix = m;
        pg.add(tf);
      });
    }

    // System group positioned at (leftMargin+sys.leftMargin, topMargin+ypos+topY+musicYOffset)
    const sysGrp = drawSystem(page, sys);
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1,
      leftMargin + sys.leftMargin,
      topMargin + it.ypos + data.topY + data.musicYOffset,
    ]);
    sysGrp.matrix = m;
  }

  return pages;
}

/** 排好的五线谱页：各页页面树，连同各系统落在第几页（0 基）、首谱表顶线离页顶多远（tenths）。 */
export interface StaffPages {
  pages: Group[];
  placed: { sys: Sys; page: number; top: number }[];
}

/** 一份已读入的 `StaffLayout` 排成页（`showJianpuLayer` = 混排叠简谱层）。长图会改写 `score.defaults.pageHeight`。 */
export function layoutStaffPages(score: StaffLayout, showJianpuLayer: boolean): StaffPages {
  if (showJianpuLayer) formatMixedScore(score);
  else if (score.autoLayout) placeAboveStaff(score, false);

  // M5: flow layout
  const items = getFrames(score);
  if (items.length > 0) {
    // Add title block (credits) to first frame
    items[0].credits = score.credits.filter(c => c.page === 0);
    // 自动铺排的标题块由 autoLayoutHeader 从上往下堆，词曲行多了会高过缺省的 TITLE_OFFSET：按最低那行让开
    const d = score.defaults;
    const lowest = Math.min(...items[0].credits.map((c) => c.y));
    const offset = score.autoLayout && items[0].credits.length
      ? Math.max(TITLE_OFFSET, d.pageHeight - lowest - d.topMargin + TITLE_GAP)
      : TITLE_OFFSET;
    items[0].musicYOffset = offset;
    items[0].height += offset;
  }
  const d = score.defaults;
  let pageHeight = d.pageHeight ?? PAGE_HEIGHT_FALLBACK;
  const layout = flowLayout(items, score.longImage ? Infinity : pageHeight - d.topMargin - d.bottomMargin);
  if (score.longImage) {
    // 长图：整首一页，页高 = 内容底 + 上下边距。credit 的 y 从页底量，页高变了整体跟着挪，离页顶的距离不变
    const last = layout[layout.length - 1];
    const contentH = last ? last.ypos + last.height : 0;
    const h = Math.max(contentH + d.topMargin + d.bottomMargin, d.topMargin + d.bottomMargin + TITLE_OFFSET);
    for (const c of score.credits) c.y += h - pageHeight;
    d.pageHeight = pageHeight = h;
  }
  let pageNo = -1;
  const placed = items.map((it, i) => {
    if (layout[i]!.newPage) pageNo++;
    return { sys: it.system, page: pageNo, top: d.topMargin + layout[i]!.ypos + it.topY + it.musicYOffset };
  });
  const pages = drawFrames(
    score, items, layout, d.leftMargin, d.topMargin, pageHeight, d.pageWidth ?? 1200,
  );
  return { pages, placed };
}
