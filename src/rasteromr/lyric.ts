// 歌词带的切分：把谱行下方那条带里的连通块并成**字格**。
//
// 位图没有文字层，歌词字要 OCR 出来。但**识别时不该起浏览器**——
// 照 `scripts/gen-staffocr.mjs` 的套路：建库时把字格按形状聚类、每类只送一次 OCR，
// 产物落盘；识别时纯查表。所以本文件只管「切出字格」，不碰 OCR，也不碰 DOM。
//
// 切分的思路照 `src/omr/lyrics.ts::recognizeLyrics`（简谱那条路，已经调熟）：
//   1. 每个谱行下方一条「歌词带」（本行下缘 → 下一行上缘）；
//   2. 带内按 y 把块分成若干 verse 行（一首歌可能有两三段歌词）；
//   3. 行内把块按 x 邻近并成字格——**汉字常由多个偏旁连通块组成**，这一步不能省。
import type { Component, Rect } from "../omr/types";
import { mergeToChars } from "../omr/lyrics";
import type { RasterUnit } from "./staffline";

/** 一条歌词行（某个谱行下方的某一段）。 */
export interface LyricRow {
  /** 这一行歌词挂在第几个谱行下面（`staves` 的下标）。 */
  staffIndex: number;
  /** 第几段（0 起，按 y 从上到下）。 */
  verse: number;
  /** 字格，按 x 排。 */
  cells: Rect[];
  /** 这一行的字号（字格高度的中位数）。 */
  charH: number;
}

/** 谱行的纵向范围（切歌词带要用）。 */
export interface LyricStaff {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 歌词字号相对线距的上下限。汉字歌词实测在一个到两个线距之间。 */
const CHAR_MIN = 0.7;
const CHAR_MAX = 2.4;

/** 断行的空白：相邻两个块的纵向中心差过这么多（相对线距）才算换了一行。
 *  扫过 0.45 / 0.6 / 0.75 / 0.9 / 1.1 / 1.4：歌词 71.14 / 71.19 / 71.34 / 71.34 /
 *  71.34 / 71.39%——0.75 往上是一整片平台，取中间的 0.9。
 *  再往上会把相邻两段词并成一行（两段的中心差约 1.5 格），平台就到头了。 */
const ROW_GAP = 0.9;

/** 一行歌词至少要有几个字格才算数（少于这个多半是力度记号、小节号一类）。 */
const MIN_CELLS = 3;

const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);

const rbottom = (r: Rect) => r.y + r.h;
const rright = (r: Rect) => r.x + r.w;

/**
 * 切出全页的歌词行。
 *
 * @param blobs 连通块。**要先把已归属的音乐符号剔掉**（符头、谱号、休止…），
 *              否则谱表内的符号会混进歌词带。
 * @param staves 谱行的纵向范围，按 y 排好。
 */
export function findLyricRows(blobs: Component[], staves: LyricStaff[], unit: RasterUnit): LyricRow[] {
  const out: LyricRow[] = [];
  /** 先按几何切一遍，**全页的字宽要等切完才量得出来**，剔假字格是第二遍的事。 */
  const raw: LyricRow[] = [];
  const sp = unit.space;
  for (let i = 0; i < staves.length; i++) {
    const st = staves[i];
    // 带的下界：下一行谱的上缘；最后一行取「四个谱表高」——够罩住两三段歌词，
    // 又不至于把页脚的版权行收进来。
    const limit = i + 1 < staves.length ? staves[i + 1].top : st.bottom + sp * 16;
    const band = blobs.filter((c) => {
      const b = c.bbox;
      if (b.y < st.bottom + sp * 0.3 || rbottom(b) > limit) return false;
      if (rright(b) < st.left - sp || b.x > st.right + sp) return false;
      const h = b.h / sp;
      return h >= CHAR_MIN * 0.4 && h <= CHAR_MAX; // 偏旁可以很矮，整字的高度另在下面卡
    });
    if (band.length < MIN_CELLS) continue;
    for (const row of splitRows(band, sp)) {
      // 这一行的字号：块高的中位数（偏旁比整字矮，所以只是个初值，下面还要按字格改）
      const charH = Math.max(median(row.map((c) => c.bbox.h)), sp * CHAR_MIN);
      const cells = mergeToChars(row, charH).filter((r) => r.h >= sp * CHAR_MIN * 0.5);
      if (cells.length < MIN_CELLS) continue;
      raw.push({ staffIndex: i, verse: 0, cells, charH });
    }
  }

  // ── 字号按**全页字宽**重算 ────────────────────────────────────────────────
  //
  // 逐行那个初值是**偏旁块高**的中位数，偏小（偏旁比整字矮）。汉字是等宽的，
  // 所以先量出全页的字宽，再只拿「宽度接近一个字」的那些格去量字高
  // ——照简谱那条路 `src/omr/lyrics.ts` 的 `charW` / `candH`。
  //
  // > **拿这个字宽去剔假字格，试过两条，都是净亏。**
  // > ① 宽度闸（丢掉 `w` 不在 0.55~1.7 字宽的格）：歌词 71.2% → **67.2%**；
  // > ② 中心 y 对齐闸（丢掉偏离行中位数超过 0.35 字高的格）：71.2% → **65.6%**。
  // > 原因是同一个字的偏旁**并不总能并成一格**（实测一行里既有 5px 的碎片
  // > 也有 37px 的两字连体），按宽度或对齐去砍，砍掉的多是真字的一半。
  // > 整行送 OCR 时那些碎片有上下文兜着，反而认得回来。
  const charW = median(raw.flatMap((r) => r.cells.map((c) => c.w)));
  for (const r of raw) {
    const near = r.cells.filter((c) => c.w >= charW * 0.7 && c.w <= charW * 1.3);
    const charH = Math.max(median(near.map((c) => c.h)), sp * CHAR_MIN);
    out.push({ ...r, charH });
  }
  // 同一个谱行下面的几行按 y 编 verse 号
  const byStaff = new Map<number, LyricRow[]>();
  for (const r of out) {
    const a = byStaff.get(r.staffIndex) ?? [];
    a.push(r);
    byStaff.set(r.staffIndex, a);
  }
  for (const a of byStaff.values()) {
    a.sort((x, y) => Math.min(...x.cells.map((c) => c.y)) - Math.min(...y.cells.map((c) => c.y)));
    a.forEach((r, k) => (r.verse = k));
  }
  return out;
}

/**
 * 把一条带里的块按 y 分成若干行。
 *
 * 判据：按块的**纵向中心**排序，**相邻两个中心之间拉开一段空白**才断行。
 * 不能按包围盒重叠判——「一」那种只有一横的字与相邻字纵向不重叠，会被分到别的行去。
 *
 * **不能用「离本行第一个块不超过 0.9 格」那种定宽窗口**（原来那一版）：一行歌词里
 * 各块的中心本来就散得开——「宀」的头在上、「，」在下、「一」在中间，字高又常有
 * 1.2 格，整行的中心跨度轻松超过 0.9 格。于是同一行歌词被劈成两行，两边各拿到
 * 半拉偏旁，OCR 出来是同一句词的两个残本（实测宁静 p3 那行「平安的夜已深」
 * 被切成 13 格与 12 格两条，都挂上了谱行 #9），字格宽度也全成了碎片。
 */
function splitRows(band: Component[], sp: number): Component[][] {
  const sorted = [...band].sort((a, b) => a.cy - b.cy);
  const rows: Component[][] = [];
  let cur: Component[] = [];
  let prev = 0;
  for (const c of sorted) {
    if (cur.length && c.cy - prev > sp * ROW_GAP) {
      rows.push(cur);
      cur = [];
    }
    cur.push(c);
    prev = c.cy;
  }
  if (cur.length) rows.push(cur);
  return rows.filter((r) => r.length >= MIN_CELLS);
}

// ── 歌词条：送 OCR 的单位 ──────────────────────────────────────────────────
//
// **整行送，不逐格送**：PP-OCR 的 rec 是序列模型，一整条歌词的上下文能把单字
// 认不准的救回来；`recognizeTextsPos` 顺带给出每个字在条内的 x，按 x 映回字格即可。
//
// 条里只带**裸像素**，不碰 canvas——`src/rasteromr/` 全链要能进 Node CLI。
// 画成 canvas、跑模型是调用方（浏览器）的事。

/** 一条要送 OCR 的歌词条。 */
export interface LyricStrip {
  w: number;
  h: number;
  /** 逐像素 0/1，长 `w*h`，1 = 墨。 */
  data: Uint8Array;
  /** 每个字格在条内的 x 区间（0~1 的分数），按 x 排。 */
  cells: { x0: number; x1: number; box: Rect }[];
  /** 字号（字格高的中位数），合成文本对象时当 `sizeDev`。 */
  charH: number;
}

/** 从二值图里裁出一条歌词条。 */
export function stripOf(bin: { w: number; h: number; data: Uint8Array }, row: LyricRow, pad = 2): LyricStrip | null {
  const x0 = Math.max(0, Math.min(...row.cells.map((c) => c.x)) - pad);
  const x1 = Math.min(bin.w, Math.max(...row.cells.map((c) => c.x + c.w)) + pad);
  const y0 = Math.max(0, Math.min(...row.cells.map((c) => c.y)) - pad);
  const y1 = Math.min(bin.h, Math.max(...row.cells.map((c) => c.y + c.h)) + pad);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 8 || h < 8) return null;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) data[y * w + x] = bin.data[(y0 + y) * bin.w + x0 + x];
  return {
    w,
    h,
    data,
    charH: row.charH,
    cells: row.cells.map((c) => ({ x0: (c.x - x0) / w, x1: (c.x + c.w - x0) / w, box: c })),
  };
}

/**
 * 条的**内容指纹**：缓存的键。
 *
 * 按内容寻址而不是按「第几页第几行」：几何判据一动，行的编号就全变了，
 * 按位置存的缓存整份作废；按内容存的只要那一条的像素没变就还能用。
 * FNV-1a，够用且不引依赖（`src/` 两端都要能跑，别用 node:crypto）。
 */
export function stripKey(s: LyricStrip): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.data.length; i++) {
    h1 ^= s.data[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `${s.w}x${s.h}-${h1.toString(36)}`;
}

/** OCR 认出来的一个字符：字符 + 它在条内的 x（0~1 的分数）。 */
export interface OcrChar {
  ch: string;
  xFrac: number;
}

/** 收得下的歌词字符：汉字与全角标点。PP-OCR 认不出时会吐拉丁字母或占位符，
 *  收进来就成了歌词里凭空多出的字（实测 `l` 一个就出现二十几次）。 */
const LYRIC_CH = /[一-鿿，。、；：！？“”‘’（）—…]/;

/**
 * OCR 的字符序列 → 逐字格的字符。
 *
 * 字数与字格数相同就**按序号一一对应**（最稳）；否则按位置取**最近**的字格。
 * 不能要求「落在字格区间内」——`xFrac` 是 CTC 估出来的位置，误差常有半个字，
 * 实测那样会丢掉近一半的字（1221 个字里丢 566）。
 */
export function mapCharsToCells(strip: LyricStrip, chars: OcrChar[]): { box: Rect; ch: string }[] {
  const out = strip.cells.map((c) => ({ box: c.box, ch: "" }));
  const keep = chars.filter((c) => LYRIC_CH.test(c.ch));
  if (!keep.length) return out;
  if (keep.length === strip.cells.length) {
    keep.forEach((c, i) => (out[i].ch = c.ch));
    return out;
  }
  for (const ch of keep) {
    let best = -1;
    let bd = Infinity;
    strip.cells.forEach((c, i) => {
      const d = Math.abs(ch.xFrac - (c.x0 + c.x1) / 2);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    if (best < 0 || bd > 0.06) continue;
    // 同一个字格已经有字了就跳过（CTC 偶尔把两个字定位到同一处）
    if (!out[best].ch) out[best].ch = ch.ch;
  }
  return out;
}
