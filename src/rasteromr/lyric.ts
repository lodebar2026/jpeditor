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
  /** 这一行的原始连通块（量全页字宽要用）。 */
  blocks: Component[];
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
const CHAR_MAX = 2.8; // 《赞美一神》的宋体「美」整字 2.6 格

/** 断行的空白：相邻两个块的纵向中心差过这么多（相对线距）才算换了一行。
 *  扫过 0.45 / 0.6 / 0.75 / 0.9 / 1.1 / 1.4：歌词 71.14 / 71.19 / 71.34 / 71.34 /
 *  71.34 / 71.39%——0.75 往上是一整片平台，取中间的 0.9。
 *  再往上会把相邻两段词并成一行（两段的中心差约 1.5 格），平台就到头了。 */
const ROW_GAP = 0.9;

/** 一行歌词至少要有几个字格才算数（少于这个多半是力度记号、小节号一类）。 */
const MIN_CELLS = 3;

/** **最后一行谱**下方的歌词带留多少个线距（中间的谱行以下一行的上缘为界）。
 *  原来是 16 格（四个谱表高），够合唱谱那种两三段词；
 *  独唱谱一页八段词（《坚固保障》中文四段 + 英文四段）要 20 格开外
 *  ——16 格时末行谱下面的英文第 2、3、4 段整片落在带外，一条都切不出来。
 *  取 24 格；再往下就是页脚的版权行了。 */
const TAIL_BAND = 24;

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
    // 带的下界：下一行谱的上缘；最后一行取 `TAIL_BAND` 个线距
    // ——够罩住整页最多的那几段歌词，又不至于把页脚的版权行收进来。
    const limit = i + 1 < staves.length ? staves[i + 1].top : st.bottom + sp * TAIL_BAND;
    const band = blobs.filter((c) => {
      const b = c.bbox;
      if (b.y < st.bottom + sp * 0.3 || rbottom(b) > limit) return false;
      if (rright(b) < st.left - sp || b.x > st.right + sp) return false;
      const h = b.h / sp;
      // 偏旁可以很矮，整字的高度另在下面卡；扁而宽的横笔（「一」「上」的底横）也收
      return (h >= CHAR_MIN * 0.4 || b.w / sp >= CHAR_MIN) && h <= CHAR_MAX;
    });
    // 扁块**不参与切行与量字号**：它们的中心会把上下两行连成一行（简谱行与歌词行之间的
    // 减时线、符杠碎段），块高又会把字号拉到偏旁以下。切完行再按 y 落进哪一行就并进哪一行。
    const isFlat = (c: Component) => c.bbox.h / sp < CHAR_MIN * 0.4;
    const flat = band.filter(isFlat);
    const solid = band.filter((c) => !isFlat(c));
    if (solid.length < MIN_CELLS) continue;
    for (const row of splitRows(solid, sp)) {
      // 这一行的字号：块高的中位数（偏旁比整字矮，所以只是个初值，下面还要按字格改）
      const charH = Math.max(median(row.map((c) => c.bbox.h)), sp * CHAR_MIN);
      const top = Math.min(...row.map((c) => c.bbox.y));
      const bot = Math.max(...row.map((c) => rbottom(c.bbox)));
      const x0 = Math.min(...row.map((c) => c.bbox.x)) - sp * 2;
      const x1 = Math.max(...row.map((c) => rright(c.bbox))) + sp * 2;
      const strokes = flat.filter((c) => c.cy > top && c.cy < bot && c.bbox.x >= x0 && rright(c.bbox) <= x1);
      // 扁而宽的也留：「一」只有一道横
      const cells = mergeToChars([...row, ...strokes], charH).filter((r) => r.h >= sp * CHAR_MIN * 0.5 || r.w >= sp * CHAR_MIN * 1.5);
      if (cells.length < MIN_CELLS) continue;
      raw.push({ staffIndex: i, verse: 0, cells, charH, blocks: row });
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
  // **字宽按块高的 85 分位数量，不拿字格宽度的中位数当尺子。**
  // 字格是 `mergeToChars` 按「块高中位数」并出来的，而块高的中位数是**偏旁**的高度
  // ——并出来的格多半只有半个字宽。汉字是**方**的，整字的高度就是字宽，
  // 取全页块高的 85 分位数：那一档正是「一整个字的高度」，偏旁再多也压不下去。
  // 这个字宽只用来挑「宽度接近一个字」的格去量字高（`charH`），不参与切格
  // ——拿它去等分粘连字实测是净亏，见下面那条记账。
  const heights = raw.flatMap((r) => r.blocks.map((c) => c.bbox.h)).sort((a, b) => a - b);
  const charW = heights.length ? heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.85))] : sp;
  for (const r of raw) {
    // 扁格不算：竖笔被当成线段抽走之后，「王」「万」「之」的横笔各自成一格（善牧恩慈歌放大后
    // 第一段那行十来个 40×2 的扁格），宽度正好一个字，把字高的中位数压到下限，整行被当成页脚小字剔掉。
    const near = r.cells.filter((c) => c.w >= charW * 0.7 && c.w <= charW * 1.3 && c.h >= c.w * 0.5);
    const charH = Math.max(median(near.map((c) => c.h)), sp * CHAR_MIN);
    // **字格按全页字宽重并**（见 `squareCells`）：汉字等宽，左右结构的字偏旁隔得开时
    // 第一遍那个 `mergeToChars`（按偏旁高的 0.28 当缝）并不回来。
    // 字宽取全页字宽、本行块高的 85 分位、本行字高三者最大：前两个都被碎偏旁拉低（《赞美一神》全页 25px、字 52px）
    const hs = r.blocks.map((c) => c.bbox.h).sort((a, b) => a - b);
    const rowW = hs[Math.min(hs.length - 1, Math.floor(hs.length * 0.85))];
    out.push({ ...r, charH, cells: squareCells(r.cells, Math.max(charW, rowW, charH)) });
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
 * **半字并回整字**：相邻两格合起来不超过 1.4 个字宽、中间的缝不过 0.35 个字宽，
 * 就是同一个字的左右两半。
 *
 * 《赞美一神》的宋体「赞」「神」「福」「源」「颂」偏旁之间隔着 0.3 个字宽，
 * 第一遍按偏旁高的 0.28 当缝，一行十九个字切成三十一格；字数与格数对不上，
 * OCR 的字只能按 CTC 估的位置摊到格上，「美」落到了「赞」的右半格里，整行往左错两个音。
 * 真的相邻两字合起来总有两个字宽开外（《赞美一神》最挤的「心赞美」两字也有 2.2 个），过不了 1.4 那道。
 */
function squareCells(cells: Rect[], charW: number): Rect[] {
  const out: Rect[] = [];
  for (const c of cells) {
    const last = out[out.length - 1];
    // 尾随的标点（逗号、句号）不论宽窄都并进前一字——OCR 那一侧也是把它并进前一字的（`foldLyricChars`）
    const punct = c.w < charW * 0.4 && c.h < charW * 0.4 && c.y > (last?.y ?? 0) + (last?.h ?? 0) * 0.4;
    if (last && c.x - rright(last) <= charW * 0.35 && (punct || rright(c) - last.x <= charW * 1.4)) {
      const x = Math.min(last.x, c.x);
      const y = Math.min(last.y, c.y);
      last.w = Math.max(rright(last), rright(c)) - x;
      last.h = Math.max(rbottom(last), rbottom(c)) - y;
      last.x = x;
      last.y = y;
    } else out.push({ ...c });
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
  return rows.flatMap(splitTall).filter((r) => r.length >= MIN_CELLS);
}

/**
 * **两行并成了一行**的，按纵向覆盖量的谷切开。
 *
 * 按中心差断行，两段词之间只要有一串块的中心一个挨一个（标点落在行底、下一行的偏旁
 * 落在行顶、扫描噪点），就连成一片——《善牧恩慈歌》第一行谱下六段词只隔 0.6 格，
 * 1、2 段与 5、6 段各并成一条送 OCR，两段只认出半段。
 * 只动**太高**的行（高过块高中位数的 1.7 倍），在中间那四成里找覆盖最少的 y，
 * 那里几乎没墨（不到峰值的一成五）才切，递归到切不动为止。
 */
/** `splitTall` 找谷的范围（行高的比例）与谷底门槛（相对峰值）。原来 0.3~0.7、0.15；
 *  英文行距只有 30px 时上一行的降部（g、y、p）与下一行的升部（l、h、撇号）搭进谷里，
 *  谷底到不了一成五（《求主同住》两处两三行英文并成一条）。 */
const TALL_MID = [0.25, 0.75] as const;
const TALL_VALLEY = 0.3;

function splitTall(row: Component[]): Component[][] {
  if (row.length < MIN_CELLS * 2) return [row];
  const top = Math.min(...row.map((c) => c.bbox.y));
  const bot = Math.max(...row.map((c) => c.bbox.y + c.bbox.h));
  const H = bot - top;
  if (H <= median(row.map((c) => c.bbox.h)) * 1.7) return [row];
  const cov = new Float64Array(H);
  for (const c of row) for (let y = c.bbox.y; y < c.bbox.y + c.bbox.h; y++) cov[y - top] += c.bbox.w;
  const peak = Math.max(...cov);
  let at = -1;
  for (let y = Math.round(H * TALL_MID[0]); y < Math.round(H * TALL_MID[1]); y++) if (at < 0 || cov[y] < cov[at]) at = y;
  if (at < 0 || cov[at] > peak * TALL_VALLEY) return [row];
  const cut = top + at;
  const up = row.filter((c) => c.cy < cut);
  const dn = row.filter((c) => c.cy >= cut);
  if (up.length < MIN_CELLS || dn.length < MIN_CELLS) return [row];
  return [...splitTall(up), ...splitTall(dn)];
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
  /** 这条在**页面**上的盒。拉丁行按 `xFrac` 算字的位置要用它（汉字行走字格，用不上）。 */
  box: Rect;
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
    box: { x: x0, y: y0, w, h },
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

/** 丢一个字的代价（条宽的分数）。比「摊到最近的格」贵一点：
 *  字多于格时多半是 OCR 多读了一个，宁可丢，也别把整句往后顶。 */
const DROP_COST = 0.08;

/** OCR 认出来的一个字符：字符 + 它在条内的 x（0~1 的分数）。 */
export interface OcrChar {
  ch: string;
  xFrac: number;
}

/** 收得下的歌词字符：汉字与全角标点。PP-OCR 认不出时会吐拉丁字母或占位符，
 *  收进来就成了歌词里凭空多出的字（实测 `l` 一个就出现二十几次）。 */
const LYRIC_CH = /[一-鿿，。、；：！？“”‘’（）—…]/;
/** 贴在字**尾**的标点：并进前一个字，不另占一个字格（也就不占一个音符）。
 *  与 `src/omr/lyrics.ts` 的 `LYRIC_PUNCT` 同一套，那边已经调熟。 */
const TRAIL_PUNCT = /[，。、；：！？…—”’）]/;
/** 领起下一个字的标点（开引号、开括号）。 */
const LEAD_PUNCT = /[“‘（]/;

/**
 * **标点贴到相邻的字上**，不单独占一个位置。
 *
 * 字格那一侧已经把标点并进了相邻的格（`squareCells`），字符这一侧要同样并，
 * 两边的个数才对得上——「字数相等按序号」是映射里唯一准的那条路。
 * 一个字格于是拿到「字 + 尾随标点」（如「深，」），与简谱那条路的口径一致。
 */
export function foldLyricChars(chars: OcrChar[]): OcrChar[] {
  chars = chars.filter((c) => LYRIC_CH.test(c.ch));
  const out: OcrChar[] = [];
  let lead = "";
  for (const c of chars) {
    if (LEAD_PUNCT.test(c.ch)) {
      lead += c.ch;
      continue;
    }
    if (TRAIL_PUNCT.test(c.ch) && out.length) {
      out[out.length - 1].ch += c.ch;
      continue;
    }
    out.push({ ch: lead + c.ch, xFrac: c.xFrac });
    lead = "";
  }
  return out;
}

/**
 * **OCR 读出的字比字格多时**，把宽到约两个字的格等分开，最多补 `extra` 格。
 *
 * 粗体铅字本词是两字一组排的（「我要 称谢 称谢」），组内两字几乎贴着，
 * `squareCells` 按「缝不过 0.35 字宽、合起来不过 1.4 字宽」并不开它们，却也切不开：
 * 两字本就粘成一块。字数比格数多，单调对齐只能丢字——《主使我喜乐》每个「我要」丢一个「我」。
 * 分割那一步一律等分粘连字实测是净亏（见 `findLyricRows` 的记账），这里只在 OCR 字数佐证时才分。
 */
function splitWideCells(strip: LyricStrip, extra: number): LyricStrip {
  const unit = strip.charH;
  if (!(unit > 0)) return strip;
  const wide = strip.cells
    .map((c, i) => ({ i, k: Math.min(3, Math.round(c.box.w / unit)) }))
    .filter((e) => e.k >= 2 && strip.cells[e.i].box.w >= unit * 1.7)
    .sort((a, b) => strip.cells[b.i].box.w - strip.cells[a.i].box.w);
  const parts = new Map<number, number>();
  for (const e of wide) {
    if (extra <= 0) break;
    const k = Math.min(e.k, extra + 1);
    parts.set(e.i, k);
    extra -= k - 1;
  }
  if (!parts.size) return strip;
  const cells: LyricStrip["cells"] = [];
  strip.cells.forEach((c, i) => {
    const k = parts.get(i) ?? 1;
    for (let t = 0; t < k; t++) {
      const x0 = c.x0 + ((c.x1 - c.x0) * t) / k;
      const x1 = c.x0 + ((c.x1 - c.x0) * (t + 1)) / k;
      const bw = c.box.w / k;
      cells.push({ x0, x1, box: { x: c.box.x + bw * t, y: c.box.y, w: bw, h: c.box.h } });
    }
  });
  return { ...strip, cells };
}

/**
 * OCR 的字符序列 → 逐字格的字符。
 *
 * 字数与字格数相同就**按序号一一对应**（最稳）；否则按位置取**最近**的字格。
 * 不能要求「落在字格区间内」——`xFrac` 是 CTC 估出来的位置，误差常有半个字，
 * 实测那样会丢掉近一半的字（1221 个字里丢 566）。
 */
export function mapCharsToCells(strip0: LyricStrip, chars: OcrChar[]): { box: Rect; ch: string }[] {
  const keep = foldLyricChars(chars);
  const strip = keep.length > strip0.cells.length ? splitWideCells(strip0, keep.length - strip0.cells.length) : strip0;
  const out = strip.cells.map((c) => ({ box: c.box, ch: "" }));
  if (!keep.length) return out;
  if (keep.length === strip.cells.length) {
    keep.forEach((c, i) => (out[i].ch = c.ch));
    return out;
  }
  // **单调对齐**：字与格的次序是一样的（都是从左到右的一句词），
  // 逐字各取最近的格会**乱序**——两个字抢同一格时后一个被丢掉，
  // 而它本该落在下一格里。改成一趟 DP：保序地把字摊到格上，
  // 允许跳过空格（字少于格）、也允许丢字（字多于格，多半是 OCR 多读了）。
  const n = keep.length;
  const m = strip.cells.length;
  const center = strip.cells.map((c) => (c.x0 + c.x1) / 2);
  const INF = 1e9;
  const f: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  const from: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  f[0][0] = 0;
  for (let j = 1; j <= m; j++) {
    f[0][j] = 0; // 前面的格空着不要钱
    from[0][j] = 1;
  }
  for (let i = 1; i <= n; i++)
    for (let j = 0; j <= m; j++) {
      // 丢掉这个字
      let best = f[i - 1][j] + DROP_COST;
      let how = 2;
      if (j > 0) {
        const skip = f[i][j - 1]; // 这一格空着
        if (skip < best) {
          best = skip;
          how = 1;
        }
        const put = f[i - 1][j - 1] + Math.abs(keep[i - 1].xFrac - center[j - 1]);
        if (put < best) {
          best = put;
          how = 3;
        }
      }
      f[i][j] = best;
      from[i][j] = how;
    }
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const how = from[i][j];
    if (how === 3) {
      out[j - 1].ch = keep[i - 1].ch;
      i--;
      j--;
    } else if (how === 1) j--;
    else if (how === 2) i--;
    else break;
  }
  return out;
}


// ── 拉丁歌词 ────────────────────────────────────────────────────────────────
//
// 汉字那一套（`mergeToChars` 按字高并格 → `mapCharsToCells` 把 OCR 的字摊到格上）
// 立在**汉字等宽见方**这个前提上。英文词宽差着数倍，照搬必错位。
// 所以拉丁行**绕开字格**，直接拿 OCR 的 `{ch, xFrac}` 逐字造盒，
// 断词断音节交给矢量路现成的 `splitSyllables`——那一步本来就是给拉丁歌词写的
// （遇空格断词、遇 `-` 断音节并记下 `hyphen`），一行不改就能用。
//
// 语种**按 OCR 的结果判，不按几何猜**：几何上中英文行的高度、字距都重叠得厉害，
// 而字认出来之后是哪种文字一目了然。

/** 判拉丁行的三道闸：拉丁字母在**成字的字符**（字母 + 汉字）里占到这个比例、
 *  整行的字母不少于这么多个、并且**至少有一个连字符**。
 *
 *  三道都要。前两道挡 OCR 的垫背字：认不出的墨迹会吐拉丁字母
 *  （`LYRIC_CH` 那条注记着「实测 `l` 一个就出现二十几次」），汉字行只收 CJK、
 *  这些字自然被滤掉；拉丁行一开，它们就成了假英文行。
 *
 *  第三道挡**页眉页脚与版权行**，它们是货真价实的整行英文，前两道拦不住
 *  ——实测破碎那份六页的书眉（`NEWHEARTMUSICMINISTRIES73REVEREYOURGLORY`）
 *  与版权行整片被收成歌词，谱行的「有没有词」一变，`score.ts::assignSlots`
 *  的跨系统连接跟着变，扫描件音符档 67.07% → 66.72%。
 *  判据是**连字符**：歌词是逐音节排在音符下面的（`Mas-ter`、`Up-on`、`bul-wark`），
 *  一整行下来必带；书眉、版权、脚注一个也没有。
 *  代价是整行全是单音节词的歌词行会漏掉（实测主，差遣我有一行 `takeupthecross;`），
 *  拿它换掉六行书眉，划算。**紧挨着带连字符的拉丁行**的那几行不要连字符（见 `recognize.ts`，
 *  《奇异恩典》四段英文里有一半行没有连字符）。 */
const LATIN_FRAC = 0.9;
const LATIN_MIN = 20;
const LATIN_MIN_HYPHEN = 1;

/** 收得下的拉丁歌词字符：字母、撇号（`God's`）、连字符、以及贴字尾的半角标点。 */
const LATIN_CH = /[A-Za-z'\u2019\-\u2013\u2014,.;:!?]/;

/** 词间空白：条子里连着这么多列没有墨（相对字号）就算一个词界。
 *  PP-OCR 的 rec **不吐空格**（字表里没有），词界只能自己判。
 *  **按条子里真的空白判，不按 `xFrac` 的间距判**：`xFrac` 是 CTC 估的位置，
 *  一个字常差半个字宽，按它判出来的词界一半是错的
 *  （实测 `bul-wark nev-er` 判成 `warkney- er`，音节一错位整行就对不上音符）。
 *  **0.7 个字号**，不是排印意义上的词距（0.3~0.5 em）：歌词是**逐音节排在音符下面**的，
 *  词与词之间拉开的是音符间距。实测十二行英文歌词的空白游程：中位 2~5px、
 *  七成位 7~15px、九成位 18~35px（字号 13~17px）——两头分得很开，
 *  0.7 个字号落在中间那片空当里。取 0.28 那一档（照排印词距）整行碎成单字母
 *  （`w orld`、`M an`）。 */
const SPACE_GAP = 0.7;

/** 这一行是拉丁歌词吗。 */
export function isLatinRow(chars: OcrChar[], needHyphen = true): boolean {
  let latin = 0;
  let cjk = 0;
  for (const c of chars) {
    if (/[A-Za-z]/.test(c.ch)) latin++;
    else if (/[\u4e00-\u9fff]/.test(c.ch)) cjk++;
  }
  const hyphens = chars.filter((c) => /[-\u2013\u2014]/.test(c.ch)).length;
  return latin >= LATIN_MIN && (!needHyphen || hyphens >= LATIN_MIN_HYPHEN) && latin / (latin + cjk) >= LATIN_FRAC;
}

/**
 * 拉丁行：OCR 字符 → 逐字符的盒（页面坐标），**词间的空格按间距补出来**。
 *
 * 出来的东西交给 `makeTextObj` 造成文本对象，再由 `splitSyllables` 断成音节。
 * 盒的高度一律取整条的高：`xFrac` 只给得出 x，字的上下缘量不出来，
 * 而下游只拿 x 去对音符。
 */
export function latinCells(strip: LyricStrip, chars: OcrChar[]): { box: Rect; ch: string }[] {
  const keep = chars.filter((c) => LATIN_CH.test(c.ch)).sort((a, b) => a.xFrac - b.xFrac);
  if (!keep.length) return [];
  // 条内的**空白列区间**（分数坐标），按 x 排：词界就在这些区间里
  const col = new Int32Array(strip.w);
  for (let y = 0; y < strip.h; y++)
    for (let x = 0; x < strip.w; x++) if (strip.data[y * strip.w + x]) col[x]++;
  const minGap = Math.max(2, strip.charH * SPACE_GAP);
  const blanks: [number, number][] = [];
  let run = 0;
  for (let x = 0; x <= strip.w; x++) {
    if (x < strip.w && !col[x]) {
      run++;
      continue;
    }
    if (run >= minGap) blanks.push([(x - run) / strip.w, x / strip.w]);
    run = 0;
  }
  const gaps = keep.slice(1).map((c, i) => c.xFrac - keep[i].xFrac).filter((g) => g > 0).sort((a, b) => a - b);
  const pitch = gaps.length ? gaps[gaps.length >> 1] : 1 / Math.max(1, keep.length);
  const out: { box: Rect; ch: string }[] = [];
  // 盒高取**条中间一个字高**：条四周留了边，相邻两行英文只隔 30px 时整条高的盒上下各叠一两个像素，
  // `buildLyricLines` 按纵向重叠把两行并成一行（《求主同住》第 3、4 段英文交错成一串）
  const hh = Math.min(strip.box.h, Math.max(1, strip.charH));
  const yy = strip.box.y + (strip.box.h - hh) / 2;
  const boxAt = (x0: number, x1: number, ch: string) => ({
    box: {
      x: strip.box.x + x0 * strip.box.w,
      y: yy,
      w: Math.max(1, (x1 - x0) * strip.box.w),
      h: hh,
    },
    ch,
  });
  keep.forEach((c, i) => {
    const next = keep[i + 1];
    const end = next ? Math.min(c.xFrac + pitch, next.xFrac) : Math.min(1, c.xFrac + pitch);
    out.push(boxAt(c.xFrac, end, c.ch));
    // 两个字之间**夹着一段空白列**就补个空格（`splitSyllables` 见空格断词）
    if (next && blanks.some((b) => b[0] >= c.xFrac && b[1] <= next.xFrac)) out.push(boxAt(end, next.xFrac, " "));
  });
  return out;
}
