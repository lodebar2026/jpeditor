// 简谱歌词识别 + 逐音节↔音符对齐。
// musicpp 的 jianpu.cpp::processLrc 只找出歌词行范围，真正"字↔符头"对齐(text.cpp::mergeLyricByNotes)
// 在另一套 PDF 模型里、按 x 重叠完成。这里照其原则用 x 对齐：
//   1. 在每个乐谱行下方的"歌词带"里取字号大小的连通块；按 y 分成若干 verse 行(W1/W2…)。
//   2. 行内把连通块(汉字常由多个偏旁连通块组成)按 x 邻近并成"字格"。
//   3. 每个字格裁成画布 → PaddleOCR 识别汉字。
//   4. 按 x 单调最近，把每个汉字分配给本乐谱行里 x 最接近的音符(melisma→某些音符无字，正确)。
import type { Binary, Component, JpNum, Rect, StaffRow, TextRegion } from "./types";
import { rright, rbottom, rcx, rcy } from "./types";
import type { OcrBackend } from "./ocr";

const median = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
const isHanzi = (c: string) => /[一-鿿]/.test(c);
// 歌词里贴在字尾的标点。简谱印刷用全角，但 PP-OCR 常把 ，；：！？ 识成半角 , ; : ! ? ——
// 一并收下、统一折成全角（与 GT 一致；半角句点 . 不收，避免撞段号 "1." / 小数点）。
const LYRIC_PUNCT = /[，。、；：！？…—,;:!?]/;
const PUNCT_FULL: Record<string, string> = { ",": "，", ";": "；", ":": "：", "!": "！", "?": "？" };
const normPunct = (ch: string) => PUNCT_FULL[ch] ?? ch;
// 引号（都不占音符）：开引号 “‘ **领起后一字**（如 “阿门”里的 “ 贴 阿），闭引号 ”’ **贴前一字**。
// PP-OCR 对中文引号输出全角（实测 rec 已能读出 “ ”），故一并收下；半/全角开闭都认。
const LYRIC_QUOTE_OPEN = /[“‘"']/;
const LYRIC_QUOTE_CLOSE = /[”’]/;
// 英文歌词：一个音节 = 一串字母(可含撇号 don't)，音节间以连字符相连（"How-awe-some-you-are"），
// 词间以空白相隔。故拉丁串按 **连字符** 与 **空白**(rec 不吐空格 → 按源图字距)切成音节单元，
// 每个音节占一个音符，与汉字单元同等对待。
const isLatin = (c: string) => /[A-Za-z]/.test(c);
const isApostrophe = (c: string) => /['’]/.test(c);
const isHyphen = (c: string) => /[-‐‑–—]/.test(c);

// ── 和弦/段落标记行 ────────────────────────────────────────────────────────
// 吉他和弦(C / G/B / Am / Gsus4)与段落方框(Intro/Verse/Chorus/Coda)印在**下一乐谱行音符的上方**，
// 同样落在"本行下缘→下一行上缘"的歌词带里，被当成一条 verse 行。汉字歌词时它们被字符过滤滤空、
// 无害；放开拉丁字符后就会变成伪 verse 污染 .Words，故按文本形态显式剔除（须在 rec 之后）。
// 段落**起点**方框（用于给乐句排版分段）：Fine/D.C./D.S. 是终止/反复记号而非段落起点，故不在此列。
const SECTION_MARK_RE = /(intro|verse|chorus|pre-?chorus|bridge|coda|outro|ending|interlude|solo|refrain|tag)\d*/i;
// 跳转记号 D.C./D.S./Fine/To Coda：不是段落起点（故不进 SECTION_MARK_RE），但它决定演唱顺序，
// 必须输出到 MusicXML 才能正确展开反复。谱面印在**本谱行**音符的下方近旁（沧海一声笑的 D.C.
// 印在二房末音右上），因此与段落方框归行方式不同（那个归下一行）。
// 点号常被 OCR 吞掉或读成逗号，故点一律可选；`D.S. al Coda` 之类的后缀在此不细分。
const JUMP_MARK_RE = /(D\s*[.,·]?\s*[CS]\s*[.,·]?|Fine|To\s*Coda)/i;
const normalizeJump = (s: string): string => {
  const t = s.replace(/\s|[.,·]/g, "").toUpperCase();
  if (t === "DC") return "D.C.";
  if (t === "DS") return "D.S.";
  if (t === "FINE") return "Fine";
  return "To Coda";
};
// 注记行判定用（比上面多收 fine 等，这类行同样不是歌词、要从歌词带里剔掉）。
const SECTION_RE = /(intro|verse|chorus|pre-?chorus|bridge|coda|outro|ending|interlude|solo|fine|tag|refrain)\d*/gi;
const CHORD_SUFFIX_RE = /(maj|min|sus|dim|aug|add)/gi;
// 中文谱常把备选和弦写成 `F或C`，升降根音也可能写成 `升F` / `降B`。这些少量汉字属于
// 和弦语法而非歌词；先折成分隔符再做根音形态判断。除此以外只要含汉字，仍按真歌词处理。
const CHORD_HANZI_RE = /[或升降]/g;
// 页脚版权/制作声明的 OCR 经常有少量错字（如「用途」→「用速」），所以不用整句精确匹配，
// 而要求一条较长文本同时命中至少两个强语义词。正常歌词偶见「制作」等单词也不会被误删。
const FOOTER_CUE_RE = /(版权|版权所有|制作|团队|原版|音频|音頻|歌谱|歌譜|商业|商業|用途|翻印|请勿|請勿|仅供|僅供)/g;
function isFooterNoticeLine(text: string): boolean {
  const compact = text.replace(/\s/g, "");
  if (compact.length < 8) return false;
  const cues = new Set(compact.match(FOOTER_CUE_RE) ?? []);
  return cues.size >= 2;
}
/** 整行 rec 原文是否为和弦/段落标记行（而非歌词）。
 *  一行里的和弦常被连写成一个字母簇（"CG/BAm"、"AmC"、"EmF"），故不逐 token 匹配，而看形态：
 *  ① 无歌词汉字（只允许和弦语法里的「或/升/降」）；② 每个字母簇（先剥去 maj/min/sus… 性质后缀）
 *  **首字母是 A-G 的根音**；
 *  ③ 簇内最长连续小写段 ≤2（和弦性质符 m/dim 短，英文音节 "awe"/"some"/"ther" 则长）。
 *  不依赖大小写正确（OCR 常把 C 读成 c），也不会误伤英文歌词——只要行内有一个音节不合和弦形态即否决。 */
function isAnnotationLine(text: string): boolean {
  const hanzi = text.match(/[一-鿿]/g) ?? [];
  if (hanzi.some((ch) => !/[或升降]/.test(ch))) return false;  // 除和弦连接/升降记号外有汉字 → 真歌词行
  const rest = text.replace(SECTION_RE, " ").replace(CHORD_HANZI_RE, " ");
  if (!rest.trim()) return text.trim().length > 0;              // 纯段落标记（Intro/Chorus…）
  const clusters = rest.match(/[A-Za-z]+/g) ?? [];
  if (!clusters.length) return false;                            // 无字母 → 交给下游伪 verse 过滤
  return clusters.every((c0) => {
    const root = c0[0].toUpperCase();
    if (root < "A" || root > "G") return false;
    const c = c0.replace(CHORD_SUFFIX_RE, "");
    const lower = c.match(/[a-z]+/g) ?? [];
    return lower.every((seg) => seg.length <= 2);
  });
}

/** 把一行(同 y)的连通块按 x 邻近并成字格。返回每个字格的合并包围盒，按 x 排序。 */
export function mergeToChars(line: Component[], charH: number): Rect[] {
  const sorted = [...line].sort((a, b) => a.bbox.x - b.bbox.x);
  const cells: Rect[] = [];
  const gap = charH * 0.28;       // 偏旁间距 < 此值算同字
  const maxW = charH * 1.7;       // 单字最大宽度，避免把两字并一起
  for (const c of sorted) {
    const b = c.bbox;
    const last = cells[cells.length - 1];
    if (last && b.x <= rright(last) + gap && (rright(b) - last.x) <= maxW) {
      // 并入上一个字格
      const x = Math.min(last.x, b.x), y = Math.min(last.y, b.y);
      last.w = Math.max(rright(last), rright(b)) - x;
      last.h = Math.max(rbottom(last), rbottom(b)) - y;
      last.x = x; last.y = y;
    } else {
      cells.push({ ...b });
    }
  }
  return cells;
}

// 一个 rec 块：本乐谱行(rowIdx)某 verse 的若干相邻字格（拼一条横图整体 rec）。
interface Chunk { rowIdx: number; verse: number; cells: Rect[]; maxGap: number; mark?: boolean; }

// 调试可视化用：设 globalThis.__lyricTrace={} 后 recognizeLyrics 逐步把各阶段 I/O 记进来（供生成算法说明 HTML）。
export interface LyricTrace {
  numH?: number; charMin?: number; slope?: number; charW?: number;
  rows?: Array<{ rowIdx: number; yTop: number; yBot: number; charH: number;
    bandBoxes: Rect[]; noteBoxes: Rect[]; verses: Array<{ verse: number; cells: Rect[]; cov: number; longGapBefore?: boolean[] }> }>;
  chunks?: Array<{ rowIdx: number; verse: number; cells: Rect[]; crop: Rect; maxGap: number }>;
  recPerChunk?: Array<Array<{ ch: string; xFrac: number }>>;
  placed?: Record<string, Array<{ x: number; ch: string }>>;
  aligned?: Record<string, Array<{ noteX: number; noteBox: Rect; lyric: string }>>;
}
const STRIP_H = 48, STRIP_MAXW = 300; // rec 宽上限 320 → 单条限 ~5 字免压扁
const STRIP_PAD = 4; // 拼条时字格两侧留白（也是 xFrac↔源图 x 换算的边距）

/** 压缩字格间过宽空白的布局：每个字间 gap 上限压到 maxGap（默认 ∞=不压，保留自然排版）。
 *  歌词字距过大时（如基督更美 ~1 字宽的间隔）自然区域会超 rec 宽上限被迫拆成单字；压掉多余空白后
 *  同样几个字能并进一条整体 rec（字形/字序不动，只去纯空白 → 不伤"自然排版"那点优势）。
 *  返回各格在压缩条内容坐标(从 0 起)的 x 区间 + 对应源图 x，供 buildStrip 画 / chunkCells 量宽 / 对齐映回。 */
function compactSegs(cells: Rect[], maxGap: number): { segs: { cx0: number; cx1: number; sx0: number; sw: number }[]; contentW: number } {
  const segs: { cx0: number; cx1: number; sx0: number; sw: number }[] = [];
  let cx = 0;
  for (let i = 0; i < cells.length; i++) {
    const w = cells[i].w;
    segs.push({ cx0: cx, cx1: cx + w, sx0: cells[i].x, sw: w });
    cx += w;
    if (i < cells.length - 1) cx += Math.max(0, Math.min(cells[i + 1].x - (cells[i].x + w), maxGap));
  }
  return { segs, contentW: cx };
}

/** 整幅二值图 → 黑字白底源画布（供拼条裁剪）。 */
export function srcCanvasOf(bin: Binary): OffscreenCanvas {
  const cv = new OffscreenCanvas(bin.w, bin.h);
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  const img = new ImageData(bin.w, bin.h);
  for (let i = 0; i < bin.data.length; i++) { const v = bin.data[i] ? 0 : 255; const p = i * 4; img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** 裁一块字格所覆盖的**自然连续区域**(保留原始字间距/渲染，不重拼)，缩到高 STRIP_H 整体 rec。
 *  自然排版让 PP-OCR 远比逐字/拼接 rec 准；块按宽度上限切，避免长行被压扁(rec 宽上限 320)。 */
export function buildStrip(src: OffscreenCanvas, cells: Rect[], H = STRIP_H, maxGap = Infinity): OffscreenCanvas {
  const y0 = Math.min(...cells.map((r) => r.y));
  const y1 = Math.max(...cells.map((r) => r.y + r.h));
  const { segs, contentW } = compactSegs(cells, maxGap);
  const sh = y1 - y0 + STRIP_PAD * 2;
  const sw = contentW + STRIP_PAD * 2;
  const scale = H / sh;
  const W = Math.max(1, Math.round(sw * scale));
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  // 逐格从源图取整列高切片，画到压缩后位置（去掉多余字间空白；空白无墨，故不丢内容）。
  for (const sg of segs) {
    ctx.drawImage(src, sg.sx0, y0 - STRIP_PAD, sg.sw, sh,
      Math.round((sg.cx0 + STRIP_PAD) * scale), 0, Math.max(1, Math.round(sg.sw * scale)), H);
  }
  return cv;
}

/** 把一行字格切成若干块（每块缩到 H 后 ≤ ~300px → 不超 rec 宽上限 320）。
 *  **均匀切分**：先按整行宽算出需要的块数 k=ceil(总宽/上限)，再让各块宽度尽量接近 总宽/k，
 *  避免贪心填满后末块只剩一两字（单字 rec 差、易漏，如基督更美末字「敞」）。硬上限仍不突破。 */
export function chunkCells(cells: Rect[], maxGap = Infinity): Rect[][] {
  const n = cells.length;
  if (n <= 1) return n ? [cells] : [];
  const widthAtH = (rs: Rect[]) => {
    const y0 = Math.min(...rs.map((r) => r.y)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    return compactSegs(rs, maxGap).contentW * STRIP_H / (y1 - y0);
  };
  const k = Math.max(1, Math.ceil(widthAtH(cells) / STRIP_MAXW)); // 需要的块数
  if (k <= 1) return [cells];
  const target = widthAtH(cells) / k; // 均匀目标宽（≤ STRIP_MAXW）
  const chunks: Rect[][] = [];
  let cur: Rect[] = [];
  for (let i = 0; i < n; i++) {
    if (cur.length && widthAtH([...cur, cells[i]]) > STRIP_MAXW) { chunks.push(cur); cur = []; } // 防压扁：不越硬上限
    cur.push(cells[i]);
    const remainingChunks = k - chunks.length - 1; // 关掉当前块后仍需几块
    const remainingCells = n - 1 - i;
    if (remainingChunks > 0 &&
        // 达均匀目标且剩余格够分给剩余块 → 关块；或剩余格数刚够每块留一个 → 必须关
        ((widthAtH(cur) >= target && remainingCells > remainingChunks) || remainingCells <= remainingChunks)) {
      chunks.push(cur); cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ── 全局斜率 + 错切（deslant）───────────────────────────────────────────────
// 前设：音符/歌词各在同一条（可能倾斜）线上，全图共用一个斜率 k=dy/dx。
// 用每个谱行「最左 vs 最右音符」中心连线的斜率、跨行取中位得 k（小节线竖直不粘连，音符即便
// 粘连其中心仍给可用基线）。deslant-y：dcy = y - k*x —— 同一斜线上的点 dcy 相同 → 斜线变水平，
// 便于按 y 分 verse 行、按 x 做列投影分字。x 不受斜率影响，故 x 方向的分割仍在原坐标进行。
export function globalSlope(staff: StaffRow[]): number {
  const slopes: number[] = [];
  for (const row of staff) {
    if (row.nums.length < 2) continue;
    let L = row.nums[0], R = row.nums[0];
    for (const n of row.nums) {
      if (n.bbox.x < L.bbox.x) L = n;
      if (rright(n.bbox) > rright(R.bbox)) R = n;
    }
    const dx = rcx(R.bbox) - rcx(L.bbox);
    if (Math.abs(dx) < 1) continue;
    const s = (rcy(R.bbox) - rcy(L.bbox)) / dx;
    if (Math.abs(s) < 0.5) slopes.push(s); // 防退化（几乎不可能 >0.5）
  }
  return slopes.length ? median(slopes) : 0;
}

// 一个投影字块：源图 x 区间 + deslant-y 上下界（ink 实际纵向范围）+ 与前一块的原始间隙(px)。
interface ProjBlock { x0: number; x1: number; dyTop: number; dyBot: number; gapBefore: number; }

/** 对一条 verse 行做**斜率感知的列投影**分字（替代连通域 mergeToChars）。
 *  在该行 ink 的 deslant-y 窗口内逐列累加前景像素 → 成 run；相邻 run 间隙 < mergeGap（偏旁内间隙）
 *  并成一个字块（**粘连字整体保留、绝不硬切**）；每块记与前块的原始间隙(px)，供上层据 charW 判长空白。
 *  同时记每列 ink 的 deslant-y 上下界，产出每块真实 y 范围（供裁条/定位/字高统计）。 */
function projectLine(bin: Binary, line: Component[], k: number, mergeGap: number, numH: number): ProjBlock[] {
  const w = bin.w, h = bin.h, data = bin.data;
  const x0 = Math.max(0, Math.min(...line.map((c) => c.bbox.x)));
  const x1 = Math.min(w - 1, Math.max(...line.map((c) => rright(c.bbox))));
  if (x1 <= x0) return [];
  // 本行 ink 的 deslant-y 窗口（用连通块的 deslant 上下界 + 少量留白）。
  const dyLo = Math.min(...line.map((c) => c.bbox.y - k * rcx(c.bbox))) - 2;
  const dyHi = Math.max(...line.map((c) => rbottom(c.bbox) - k * rcx(c.bbox))) + 2;
  const n = x1 - x0 + 1;
  const cnt = new Int32Array(n);
  const colTop = new Float64Array(n).fill(Infinity);
  const colBot = new Float64Array(n).fill(-Infinity);
  for (let x = x0; x <= x1; x++) {
    const yLo = Math.max(0, Math.round(dyLo + k * x));
    const yHi = Math.min(h - 1, Math.round(dyHi + k * x));
    const i = x - x0;
    for (let y = yLo; y <= yHi; y++) {
      if (data[y * w + x]) { cnt[i]++; const dyv = y - k * x; if (dyv < colTop[i]) colTop[i] = dyv; if (dyv > colBot[i]) colBot[i] = dyv; }
    }
  }
  // 列廓 → run（含 ink 的连续列）→ 按间隙并成字块。
  const runs: { x0: number; x1: number; dyTop: number; dyBot: number }[] = [];
  let rs = -1;
  for (let i = 0; i < n; i++) {
    if (cnt[i] > 0) { if (rs < 0) rs = i; }
    else if (rs >= 0) { pushRun(rs, i - 1); rs = -1; }
  }
  if (rs >= 0) pushRun(rs, n - 1);
  // 二值化残留的散点（w=1~2、墨极少）会各成一个游离 run → 假字格、被 OCR 读成 · / . 等。
  // 丢弃「窄且墨少」的 run（窄=≤3列 且 墨<numH*0.5）：真笔画即便只 1~2 列也够高(墨多)→保留；
  // 淡逗号更宽(≥~0.2charW)不受影响。宽 run 一律保留（不误伤细横笔"一"等）。
  function pushRun(a: number, b: number) {
    let t = Infinity, bo = -Infinity, ink = 0;
    for (let i = a; i <= b; i++) { ink += cnt[i]; if (colTop[i] < t) t = colTop[i]; if (colBot[i] > bo) bo = colBot[i]; }
    if (b - a + 1 <= 3 && ink < numH * 0.5) return; // 散点噪声
    runs.push({ x0: x0 + a, x1: x0 + b, dyTop: t, dyBot: bo });
  }
  const blocks: ProjBlock[] = [];
  for (const r of runs) {
    const last = blocks[blocks.length - 1];
    const gap = last ? r.x0 - last.x1 : Infinity;
    if (last && gap < mergeGap) { // 偏旁内间隙 → 并入上一字块（不切）
      last.x1 = r.x1; last.dyTop = Math.min(last.dyTop, r.dyTop); last.dyBot = Math.max(last.dyBot, r.dyBot);
    } else {
      blocks.push({ x0: r.x0, x1: r.x1, dyTop: r.dyTop, dyBot: r.dyBot, gapBefore: gap });
    }
  }
  return blocks;
}

/** 把「尾随标点大小的小墨块」并入前一字块：小墨块(宽<0.45charW)、紧贴前字(自身间隙非长空白)、
 *  且其后就是乐句断点(长空白/行末) → 判为该字的尾随标点，并入前块。使字块=汉字+尾随标点，
 *  裁条时标点落进同一自然区域整体 rec（读得出淡逗号则免几何补回；结构上也不再是游离小格）。 */
function mergePunctBlocks(blocks: ProjBlock[], charW: number, longGap: number): ProjBlock[] {
  if (blocks.length < 2) return blocks;
  const out = blocks.map((b) => ({ ...b }));
  for (let i = out.length - 1; i >= 1; i--) {
    const b = out[i];
    if (b.x1 - b.x0 + 1 >= charW * 0.45) continue;   // 只并标点大小的小墨块
    if (b.gapBefore > longGap) continue;             // 它自己在长空白后 → 是下句首字，别并
    if (i !== out.length - 1 && out[i + 1].gapBefore <= longGap) continue; // 后面不是乐句断点 → 不像尾随标点
    const p = out[i - 1];
    p.x1 = Math.max(p.x1, b.x1); p.dyTop = Math.min(p.dyTop, b.dyTop); p.dyBot = Math.max(p.dyBot, b.dyBot);
    out.splice(i, 1);                                 // 移除后：其后块的 gapBefore（即那道长空白）不变，仍正确
  }
  return out;
}

/** 把「相邻的小字块」并成一个字块：英文歌词字号比汉字小得多（约半个字高），一串音节
 *  "How-awe-some-you-are" 本是连排的一段，但淡印处笔画断开时投影会把它切成两块，落进不同 rec 块
 *  → 各自读到半个音节（"How-awe-s" / "ome-you-are"）。故把**两块都矮**(< 0.8×charH，汉字不满足)
 *  且间隙小于半个汉字宽的相邻块并回一块，整串在同一自然区域里 rec。 */
function mergeSmallTextBlocks(blocks: ProjBlock[], charW: number, charH: number): ProjBlock[] {
  if (blocks.length < 2) return blocks;
  const out = [{ ...blocks[0] }];
  const isSmall = (b: ProjBlock) => b.dyBot - b.dyTop < charH * 0.8;
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i], p = out[out.length - 1];
    if (isSmall(b) && isSmall(p) && b.gapBefore < charW * 0.5) {
      p.x1 = b.x1; p.dyTop = Math.min(p.dyTop, b.dyTop); p.dyBot = Math.max(p.dyBot, b.dyBot);
    } else out.push({ ...b });
  }
  return out;
}

/** 投影字块 → 源图 Rect（deslant-y 在块中心 x 处折回原坐标；小块内斜率影响可忽略）。 */
function blockRect(b: ProjBlock, k: number): Rect {
  const xc = (b.x0 + b.x1) / 2;
  const y = b.dyTop + k * xc, yb = b.dyBot + k * xc;
  return { x: b.x0, y, w: b.x1 - b.x0 + 1, h: Math.max(1, yb - y) };
}

/** 识别歌词并写回各音符的 lyrics[]；返回每个歌词单元的源图定位+字号（识别模式按原位/原字号叠加）。
 *  staff 为乐谱行(按出现顺序)，comps 为全图连通块。 */
export async function recognizeLyrics(
  bin: Binary, comps: Component[], staff: StaffRow[], numH: number, ocr: OcrBackend,
): Promise<TextRegion[]> {
  const regions: TextRegion[] = [];
  if (!ocr.recognizeTexts || !staff.length) return regions;

  const charMin = numH * 0.5; // 歌词字号下限（约等于音符字号）
  const src = srcCanvasOf(bin);
  const chunks: Chunk[] = [];
  const strips: OffscreenCanvas[] = [];
  const TR = (globalThis as { __lyricTrace?: LyricTrace }).__lyricTrace; // 调试可视化：设置后逐步记录 I/O

  // S0 全局斜率 + deslant-y（同一斜线上的点 dcy 相同 → 斜线变水平）。
  const k = globalSlope(staff);
  const dcy = (c: Component) => c.cy - k * c.cx;             // 连通块中心的 deslant-y
  const dTop = (nums: JpNum[]) => Math.min(...nums.map((n) => n.bbox.y - k * rcx(n.bbox)));
  const dBot = (nums: JpNum[]) => Math.max(...nums.map((n) => rbottom(n.bbox) - k * rcx(n.bbox)));
  if (TR) { TR.numH = numH; TR.charMin = charMin; TR.slope = k; TR.rows = []; }

  for (let i = 0; i < staff.length; i++) {
    const row = staff[i];
    if (!row.nums.length) continue;
    // S1 歌词带（deslant 空间）：本谱行 deslant 下缘 → 下一谱行 deslant 上缘。
    const yTop = dBot(row.nums) + numH * 0.15;
    const yBot = i + 1 < staff.length && staff[i + 1].nums.length
      ? dTop(staff[i + 1].nums) - numH * 0.15 : Infinity;
    if (yBot - yTop < charMin) continue;

    const inBand = (c: Component) => { const y = dcy(c); return y >= yTop && y <= yBot; };
    const band = comps.filter((c) => { const b = c.bbox; return inBand(c) && b.h >= charMin && b.w >= charMin * 0.4; });
    if (!band.length) continue;

    // S2① 按 deslant-y 分 verse 行（斜线已拉平，同一行 dcy 相近）。
    const sortedY = [...band].sort((a, b) => dcy(a) - dcy(b));
    const lines: Component[][] = [];
    for (const c of sortedY) {
      const ln = lines.find((L) => Math.abs(median(L.map(dcy)) - dcy(c)) < numH * 0.7);
      if (ln) ln.push(c); else lines.push([c]);
    }
    // 细而宽的横笔（如"一"，高度不足 charMin）：并入 deslant-y 足够近的 verse 行，扩其 x 范围/投影窗口。
    for (const c of comps) {
      const b = c.bbox;
      if (!inBand(c) || b.h >= charMin || b.h < 2 || b.w < charMin * 0.6) continue;
      const ln = lines.find((L) => Math.abs(median(L.map(dcy)) - dcy(c)) < numH * 0.45);
      if (ln) ln.push(c);
    }
    // 行末/句末标点（；。，等）小巧、不在 band，落在末字右侧空档 → 只扫到字身右缘就永远采不到。
    // 把**紧邻行左右缘（±~1 字宽）的 punct 尺寸小墨块**并入该行，精确扩 x 窗口（不盲扫空白，避免
    // 引入杂点/邻行噪声）；随后投影成块、由 mergePunctBlocks 并入相邻汉字。
    // 宽度上限用 numH*0.8 而非 charMin(=numH*0.5)：句号是小圆，实测 w 可达 ~numH*0.5（恰等 charMin），
    // 卡 `w>=charMin` 会把它漏掉（W1 句号 w9 收下、W3 句号 w10 被漏 → 丢末尾句号）。h<charMin 已保证
    // 只收矮块（真汉字 h≈1.7×charMin 早被排除），故放宽宽度安全，仍远低于汉字宽。
    for (const c of comps) {
      const b = c.bbox;
      if (!inBand(c) || b.h >= charMin || b.h < 3 || b.w >= numH * 0.8) continue; // 只收小墨块(punct 尺寸)
      // 垂直容差用 numH*0.9：句末标点坐在**基线**、其中心比本行字心低约半个字高（实测 dcy 差 ~9~11px），
      // 卡在原来的 numH*0.5(=10) 边界上——不同浏览器/WebView 的 JPEG 解码有 ±1px 抖动即可让它时收时漏
      // （同一图在无头 Edge 收得到、在 tauri WebView 却漏 W1 句号）。放宽到 0.9 远离边界，仍远小于 verse
      // 行距一半(~1.3字号)，不会误挂到相邻 verse 行。
      const ln = lines.find((L) => Math.abs(median(L.map(dcy)) - dcy(c)) < numH * 0.9);
      if (!ln) continue;
      const lx0 = Math.min(...ln.map((k2) => k2.bbox.x)), lx1 = Math.max(...ln.map((k2) => rright(k2.bbox)));
      if ((c.cx > lx1 && c.cx <= lx1 + numH * 1.1) || (c.cx < lx0 && c.cx >= lx0 - numH * 1.1)) ln.push(c);
    }

    // S3 逐 verse 行投影分字 → 字块（原始间隙待定长空白）。
    const mergeGap = numH * 0.22; // 偏旁内间隙上限（charW≈numH，用于初并；不切粘连）
    const lineBlocks = lines.map((ln) => projectLine(bin, ln, k, mergeGap, numH));
    // S2② 字宽统计 → 筛等宽候选 → 字高统计。
    const allBlocks = lineBlocks.flat();
    const widths = allBlocks.map((b) => b.x1 - b.x0 + 1).filter((w) => w >= numH * 0.4 && w <= numH * 1.8);
    const charW = median(widths) || numH;
    const candH = allBlocks.filter((b) => { const w = b.x1 - b.x0 + 1; return w >= charW * 0.7 && w <= charW * 1.3; })
      .map((b) => b.dyBot - b.dyTop);
    const charH = median(candH) || charW;
    const longGap = charW * 0.6; // 长空白（乐句/标点后）→ 分块边界
    const maxGap = charW * 0.35; // 拼条时字间空白上限（去掉过宽字距 → 同条能多并几字，不压扁）
    // 把尾随标点小墨块并入前一字块（字块 = 汉字 + 尾随标点，裁条时一起 rec）。
    const mergedBlocks = lineBlocks.map((blocks) => mergeSmallTextBlocks(mergePunctBlocks(blocks, charW, longGap), charW, charH));
    if (TR) TR.charW = charW;

    // S4 注记过滤：真歌词行横向铺满谱行；"(副歌)"/"徐震宇译"/CCLI 版权等注记只占局部。
    const noteX0 = Math.min(...row.nums.map((n) => n.bbox.x));
    const noteX1 = Math.max(...row.nums.map((n) => rright(n.bbox)));
    const noteSpan = Math.max(1, noteX1 - noteX0);
    const lineInfo = mergedBlocks.map((blocks) => {
      const cells = blocks.map((b) => blockRect(b, k));
      const longGapBefore = blocks.map((b) => b.gapBefore > longGap);
      const lx0 = cells.length ? Math.min(...cells.map((c) => c.x)) : 0;
      const lx1 = cells.length ? Math.max(...cells.map((c) => rright(c))) : 0;
      return { cells, longGapBefore, cov: cells.length ? (lx1 - lx0) / noteSpan : 0, h: median(cells.map((c) => c.h)) };
    });
    const maxCov = Math.max(0, ...lineInfo.map((L) => L.cov));
    // 圆滑线/连音线弧、下划线等：横跨谱行(cov 高)但**矮**（弧高 ~0.5 字高），会被当成一整条伪歌词行
    // （如基督更美副歌行下的 slur → 伪 W5、OCR 出 ".llr" 垃圾）。真歌词行的字≈charH，故按行内中位字高
    // 剔掉 < 0.6×charH 的矮行——提前滤掉、不白跑 OCR（下游伪 verse 过滤也会兜底，但那已浪费识别）。
    const kept = lineInfo.filter((L) => L.cells.length && L.h >= charH * 0.6 && (L.cov >= maxCov - 1e-9 || L.cov >= 0.35));

    const rowT = TR ? { rowIdx: i, yTop, yBot, charH, bandBoxes: band.map((c) => c.bbox),
      noteBoxes: row.nums.map((n) => n.bbox), verses: [] as Array<{ verse: number; cells: Rect[]; cov: number; longGapBefore?: boolean[] }> } : null;
    if (TR && rowT) TR.rows!.push(rowT);

    // 被 cov 过滤掉的**短行**（占谱行宽不足 35%）里混着段落方框 Intro/Verse/Chorus/Coda —— 它们
    // 不是歌词（丢弃是对的），但标出了段落起点，对乐句排版有用。故也送去 rec，只用来提段落词
    // （`mark: true` 的块不参与歌词装配）。限短行（≤5 格）以免白跑 OCR。
    for (const L of lineInfo) {
      if (kept.includes(L) || !L.cells.length || L.cells.length > 5) continue;
      chunks.push({ rowIdx: i, verse: -1, cells: L.cells, maxGap, mark: true });
      strips.push(buildStrip(src, L.cells, STRIP_H, maxGap));
    }

    kept.forEach(({ cells, longGapBefore, cov }, verse) => {
      if (rowT) rowT.verses.push({ verse, cells, cov, longGapBefore });
      // S5 直接按 STRIP_MAXW 宽上限把整行字格切成 rec 块（不再逐长空白断段）：散字尽量并进同一条
      // 自然区域整体 rec——多字上下文远比逐字准（实测单字 ~85% vs 自然区域 ~98%）。宽上限已含字间空白，
      // 真正的大段乐句空白会撑到上限自然断开，不会把整行压扁。
      for (const chunkCellsArr of chunkCells(cells, maxGap)) {
        chunks.push({ rowIdx: i, verse, cells: chunkCellsArr, maxGap });
        strips.push(buildStrip(src, chunkCellsArr, STRIP_H, maxGap));
        if (TR) { const x0 = Math.min(...chunkCellsArr.map((r) => r.x)), y0 = Math.min(...chunkCellsArr.map((r) => r.y));
          const x1 = Math.max(...chunkCellsArr.map((r) => rright(r))), y1 = Math.max(...chunkCellsArr.map((r) => rbottom(r)));
          (TR.chunks ??= []).push({ rowIdx: i, verse, cells: chunkCellsArr, crop: { x: x0 - 4, y: y0 - 4, w: x1 - x0 + 8, h: y1 - y0 + 8 }, maxGap }); }
      }
    });
  }

  if (!strips.length) return regions;
  // 优先用**带字位**的 rec：每字带 xFrac → 直接落回源图 x，免去"字数↔连通块格数"按序硬配（错位根源）。
  const posMode = !!ocr.recognizeTextsPos;
  const textsPos = posMode ? await ocr.recognizeTextsPos!(strips) : null;
  const texts = posMode ? null : await ocr.recognizeTexts(strips);
  if (TR) TR.recPerChunk = textsPos ?? texts!.map((s) => [...s].map((ch) => ({ ch, xFrac: 0 })));

  // 每块识别字汇总到 (row,verse)，再按 x 单调最近分配给音符。
  // 单元 = 一个汉字 + 紧随其后的尾随标点（，。、；！？等）：简谱标点向左贴前一字、不占音符，
  // 故并入该音节字符串而非另立单元（保持单元↔音符对齐）。段号数字等非汉字非标点 → 直接丢弃、自然不占位。
  const perLine = new Map<string, Array<{ x: number; ch: string; region?: TextRegion }>>();
  const rawByKey = new Map<string, string>();   // 每 (row,verse) 的 rec 原文（供和弦/段落标记行判定）
  const lineSeen = new Set<string>();
  const marks: { rowIdx: number; word: string; x: number }[] = []; // 段落标记（印在下一谱行上方）
  const jumps: { rowIdx: number; word: string; x: number }[] = []; // 跳转记号（印在本谱行下方）
  for (let s = 0; s < chunks.length; s++) {
    const { rowIdx, verse, cells, maxGap } = chunks[s];
    const key = `${rowIdx}:${verse}`;
    const isFirstChunk = !lineSeen.has(key);
    lineSeen.add(key);
    // 用 OCR 字位 xFrac → 源图 x。strip 是**压缩条**（字间空白被压到 maxGap），故按同一压缩布局
    // 把 xFrac 落到对应字格、再映回该格源图 x（不能再用自然 span 线性映，否则压缩处会错位）。
    const { segs, contentW } = compactSegs(cells, maxGap);
    const stripW = contentW + STRIP_PAD * 2;
    const fracToSrcX = (xFrac: number) => {
      const cc = xFrac * stripW - STRIP_PAD; // 压缩条内容坐标
      for (const sg of segs) if (cc <= sg.cx1) {
        const t = Math.max(0, Math.min(1, (cc - sg.cx0) / Math.max(1, sg.cx1 - sg.cx0)));
        return sg.sx0 + t * sg.sw;
      }
      const last = segs[segs.length - 1];
      return last.sx0 + last.sw;
    };

    const rawText = textsPos ? textsPos[s].map((c) => c.ch).join("") : texts![s];
    // 段落方框 Intro/Verse/Chorus/Coda：可能独占一块（被 cov 过滤的短行），也可能与和弦行同块
    // （"Gsus4G" 与 "Chorus" 同一 verse 行）。在任何块里就地捞出，x 取该词首字。
    {
      const hit = SECTION_MARK_RE.exec(rawText);
      if (hit) {
        let acc = 0, xf = 0;
        if (textsPos) for (const c of textsPos[s]) { if (acc >= hit.index) { xf = c.xFrac; break; } acc += c.ch.length; }
        const word = hit[0][0].toUpperCase() + hit[0].slice(1).toLowerCase();
        marks.push({ rowIdx, word, x: textsPos ? fracToSrcX(xf) : cells[0].x });
      }
    }
    // 跳转记号 D.C./D.S./Fine：与段落方框同样可能独占短块、也可能混在别的块里就地捞。
    // 只在**无汉字**的块里找，免得歌词里的 "Do"/"Si" 等被误当记号。
    if (!/[一-鿿]/.test(rawText)) {
      const hit = JUMP_MARK_RE.exec(rawText);
      if (hit) {
        let acc = 0, xf = 0;
        if (textsPos) for (const c of textsPos[s]) { if (acc >= hit.index) { xf = c.xFrac; break; } acc += c.ch.length; }
        jumps.push({ rowIdx, word: normalizeJump(hit[0]), x: textsPos ? fracToSrcX(xf) : cells[0].x });
      }
    }
    if (chunks[s].mark) continue; // 只为提段落词而 rec 的块：不参与歌词装配

    rawByKey.set(key, (rawByKey.get(key) ?? "") + rawText);
    if (!perLine.has(key)) perLine.set(key, []);
    const placed = perLine.get(key)!;
    // 字格纵向范围 + 中位字宽（仅供识别模式叠加按源图定位/取大小）
    const cy0 = Math.min(...cells.map((c) => c.y)), cy1 = Math.max(...cells.map((c) => rbottom(c)));
    const charW = median(cells.map((c) => c.w)) || (cy1 - cy0);

    if (posMode) {
      let lead = "";                                                // 待领起后一字的开引号
      // 英文音节缓冲：连字符/词间空白/汉字/行末 → 结算成一个单元（与汉字同等占一个音符）。
      let pend: { text: string; x0: number; x1: number } | null = null;
      const flushLatin = () => {
        if (!pend) return;
        const text = lead + pend.text; lead = "";
        // 音节宽度取**实际跨度** + 末字符估宽。不能拿 charW 兜底：英文行的字格是整串音节合成的
        // 一个大块（`How-awe-some-you-are` 宽两百多像素），charW 就是那个块宽，用它算出的中心
        // 会把音节整体右移一个多字位（实测 How- 落到 x233、该在 170 的 `5` 音上）。
        const w = Math.max(1, pend.x1 - pend.x0) + (cy1 - cy0) * 0.6;
        const region: TextRegion = { text, bbox: { x: pend.x0, y: cy0, w, h: cy1 - cy0 } };
        // 对齐点用音节**起始 x**，与汉字（用字位左缘 sx）同一基准。
        placed.push({ x: pend.x0, ch: text, region });
        regions.push(region);
        pend = null;
      };
      for (const { ch, xFrac } of textsPos![s]) {
        const sx = fracToSrcX(xFrac);
        if (isHanzi(ch)) {
          flushLatin();
          const text = lead + ch; lead = "";                        // 开引号并入本字前缀（“阿）
          const region: TextRegion = { text, bbox: { x: sx - charW / 2, y: cy0, w: charW, h: cy1 - cy0 } };
          placed.push({ x: sx, ch: text, region });
          regions.push(region);
        } else if (isLatin(ch) || (pend && isApostrophe(ch))) {
          // rec 不吐空格 → 用源图字距断词：间隙明显大于字母间距即另起一个音节单元。
          if (pend && sx - pend.x1 > charW * 0.5) flushLatin();
          if (!pend) pend = { text: "", x0: sx, x1: sx };
          pend.text += ch; pend.x1 = sx;
        } else if (isHyphen(ch)) {
          if (pend) { pend.text += "-"; pend.x1 = sx; flushLatin(); } // 连字符=音节边界，随音节保留
        } else if (LYRIC_QUOTE_OPEN.test(ch) && !pend) {
          lead += ch;                                               // 开引号：领起后一字，不另立单元
        } else if (LYRIC_PUNCT.test(ch) || LYRIC_QUOTE_CLOSE.test(ch)) {
          const p = normPunct(ch);
          if (pend) { pend.text += p; pend.x1 = sx; }               // 贴在当前英文音节尾
          else if (placed.length) {
            placed[placed.length - 1].ch += p;                      // 尾随标点/闭引号贴前一字（折全角，不移位、不另立单元）
            if (regions.length) regions[regions.length - 1].text += p;
          }
        }
      }
      flushLatin();
    } else {
      // 回退：后端无字位时，沿用"字↔连通块格"按序映射 + 段号几何剔除（首格落在第一个音符中心左侧 → 段号丢弃）。
      const toks: string[] = [];
      let lead = "";
      let pend = "";                                   // 英文音节缓冲（无字位时只能按连字符断，词间空白读不到）
      const flushLatin = () => { if (pend) { toks.push(lead + pend); lead = ""; pend = ""; } };
      for (const ch of texts![s]) {
        if (isHanzi(ch)) { flushLatin(); toks.push(lead + ch); lead = ""; }
        else if (isLatin(ch) || (pend && isApostrophe(ch))) pend += ch;
        else if (isHyphen(ch)) { if (pend) { pend += "-"; flushLatin(); } }
        else if (LYRIC_QUOTE_OPEN.test(ch) && !pend) lead += ch;
        else if (LYRIC_PUNCT.test(ch) || LYRIC_QUOTE_CLOSE.test(ch)) {
          if (pend) pend += normPunct(ch);
          else if (toks.length) toks[toks.length - 1] += normPunct(ch);
        }
      }
      flushLatin();
      if (!toks.length) continue;
      let mapCells = cells;
      const notes0 = staff[rowIdx].nums;
      if (isFirstChunk && cells.length > 1 && notes0.length &&
          rright(cells[0]) < rcx(notes0[0].bbox)) mapCells = cells.slice(1);
      for (let j = 0; j < toks.length; j++) {
        const ci = toks.length === mapCells.length ? j : Math.min(mapCells.length - 1, Math.floor(j * mapCells.length / toks.length));
        const region: TextRegion = { text: toks[j], bbox: mapCells[ci] };
        placed.push({ x: rcx(mapCells[ci]), ch: toks[j], region });
        regions.push(region);
      }
    }
  }

  // 剔除和弦/段落标记行（Am、G/B、Gsus4、Chorus…）及页脚版权声明：它们同样可能落在歌词带内，
  // 放开拉丁字符/最后一行开放带后会成为伪 verse。按整行 rec 原文形态判，剔掉后把该谱行剩余 verse
  // 按原顺序重新编号（保持各行 W1/W2 对齐；无注记行时是恒等变换）。
  const dropped = new Set<TextRegion>();
  {
    const annotKeys = [...perLine.keys()].filter((k) => {
      const raw = rawByKey.get(k) ?? "";
      return isAnnotationLine(raw) || isFooterNoticeLine(raw);
    });
    for (const k of annotKeys) {
      for (const p of perLine.get(k)!) if (p.region) dropped.add(p.region);
      perLine.delete(k);
      rawByKey.delete(k);
    }
    if (annotKeys.length) {
      const byRow = new Map<number, number[]>();
      for (const k of perLine.keys()) {
        const [rowIdx, verse] = k.split(":").map(Number);
        let vs = byRow.get(rowIdx);
        if (!vs) byRow.set(rowIdx, (vs = []));
        vs.push(verse);
      }
      const renamed = new Map<string, Array<{ x: number; ch: string; region?: TextRegion }>>();
      for (const [rowIdx, verses] of byRow) {
        verses.sort((a, b) => a - b);
        verses.forEach((v, nv) => renamed.set(`${rowIdx}:${nv}`, perLine.get(`${rowIdx}:${v}`)!));
      }
      perLine.clear();
      for (const [k, v] of renamed) perLine.set(k, v);
    }
  }

  // 段落标记落位：方框印在**下一谱行**音符的上方 → 归到该行、该标记 x 所在**小节的第一个音符**
  // （谱面上段落总从整小节起；标记框略偏左于段首音符，故先按 x 找起点音符再回退到本小节首音）。
  for (const mk of marks) {
    const row = staff[mk.rowIdx + 1];
    if (!row?.nums.length) continue;
    let bi = row.nums.findIndex((nn) => rcx(nn.bbox) >= mk.x - numH * 0.5);
    if (bi < 0) bi = 0;
    const barX = row.barlineXs.filter((x) => x < rcx(row.nums[bi].bbox)).pop() ?? -Infinity;
    while (bi > 0 && rcx(row.nums[bi - 1].bbox) > barX) bi--;
    row.nums[bi].sectionMark = mk.word;
  }

  // 跳转记号落位：D.C./Fine 印在**本谱行**音符下方，作用于它所在处的小节末 →
  // 归到 x 处或其左侧最近的那个音符（记号总略偏右于末音）。
  for (const jp of jumps) {
    const row = staff[jp.rowIdx];
    if (!row?.nums.length) continue;
    let bi = row.nums.length - 1;
    while (bi > 0 && rcx(row.nums[bi].bbox) > jp.x) bi--;
    row.nums[bi].jumpMark = jp.word;
  }

  // 剔除伪 verse：谱行下方噪声/记号被误当额外歌词行，rec 出来多为空、偶尔一行垃圾字（如世上 row3 的
  // 「一尊心…办单办，口」→ 伪 W3）。真 verse 有字的谱行横跨全曲；伪 verse 只在个别行出字。留下不但污染
  // .Words，更会让下游 findRefrain 误判：伪词与真词在某行重叠制造 n>1 断点，其后整段被当副歌拆段，
  // 跨段 melisma 的 `/` 在段尾被抹掉（世上 W1「一生/事奉」对位破）。按「有字谱行数」过滤（须在 rec 之后）。
  {
    const rowsWithText = new Map<number, Set<number>>();
    for (const [key, placed] of perLine) {
      if (!placed.length) continue;
      const [rowIdx, verse] = key.split(":").map(Number);
      let s = rowsWithText.get(verse);
      if (!s) rowsWithText.set(verse, (s = new Set()));
      s.add(rowIdx);
    }
    const primary = Math.max(0, ...[...rowsWithText.values()].map((s) => s.size));
    // 主 verse（有字谱行最多的那个）逐行字数 → 作"一行完整歌词有多长"的参照。
    const primaryVerse = [...rowsWithText.entries()].sort((a, b) => b[1].size - a[1].size)[0]?.[0] ?? 0;
    const chars = new Map<string, number>();
    for (const [key, placed] of perLine) chars.set(key, placed.reduce((a, p) => a + p.ch.length, 0));
    for (const key of [...perLine.keys()]) {
      const [rowIdx, verse] = key.split(":").map(Number);
      if ((rowsWithText.get(verse)?.size ?? 0) * 2 >= primary) continue; // 行数够 → 真
      // 行数不够也可能是真词：多段谱的第 2..N 段只印在主歌那几行，啦…/间奏行下方本就没有
      // （沧海一声笑 A 段有 1./2./3.5./4./6. 五行词，只光按行数会被整片当伪 verse 删掉，
      //  六个房就全唱成第一段）。真词在它出现的那一行是**完整一行**、字数与主 verse 相当；
      // 噪声伪行（世上 row3 的「一尊心…办单办，口」）只有零星几字，仍被删。
      const ref = chars.get(`${rowIdx}:${primaryVerse}`) ?? 0;
      if (ref > 0 && (chars.get(key) ?? 0) >= ref * 0.6) continue;
      perLine.delete(key);
    }
  }

  if (TR) { TR.placed = {}; for (const [k, p] of perLine) TR.placed[k] = p.map(({ x, ch }) => ({ x, ch })); }

  // 投影已在自然上下文里把尾随标点并进字块、由 OCR 直接读出（并折全角）→ 不再需要几何补标点。
  for (const [key, placed] of perLine) {
    const [rowIdx, verse] = key.split(":").map(Number);
    const notes = staff[rowIdx].nums;
    if (!notes.length) continue;
    placed.sort((a, b) => a.x - b.x);
    const M = placed.length;
    let ni = 0;
    for (let k = 0; k < M; k++) {
      const { x, ch } = placed[k];
      // 给后续字各留一个音符的上限：第 k 字最多落到 notes.length-(M-k)。
      // 否则贪心 x-最近会因某字 x 略偏右而跳格(多留一个空白 melisma)，
      // 误差向行尾累积，把末尾两字挤进同一音符（实测「人·心怎能说尽」错位即此）。
      const maxNi = Math.max(0, notes.length - (M - k));
      while (ni + 1 < notes.length && ni + 1 <= maxNi &&
             Math.abs(rcx(notes[ni + 1].bbox) - x) <= Math.abs(rcx(notes[ni].bbox) - x)) ni++;
      if (ni > maxNi) ni = maxNi;
      const nt = notes[ni];
      if (!nt.lyrics) nt.lyrics = [];
      nt.lyrics[verse] = (nt.lyrics[verse] || "") + ch;
      if (ni < notes.length - 1) ni++;
    }
    if (TR) (TR.aligned ??= {})[key] = notes.map((n) => ({ noteX: rcx(n.bbox), noteBox: n.bbox, lyric: n.lyrics?.[verse] || "" }));
  }
  return dropped.size ? regions.filter((r) => !dropped.has(r)) : regions;
}
