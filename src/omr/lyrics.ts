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
import type { ChordCand } from "./chordline";
import { chordCandidates, isAnnotationLine, placeChords } from "./chordline";

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
// 另加**词边界**：和弦行连写成一个字母簇后，`Em G/D C G/B…` 里就藏着 `DC`，无边界约束会凭空
// 读出一个 D.C.（「立定心志」因此被展开成十遍）。带点的 `D.C.` 只要求左边界；裸 `DC` 两侧都不许挨字母。
const JUMP_MARK_RE = /(?<![A-Za-z])(D\s*[.,·]\s*[CS]\s*[.,·]?|D\s*[CS](?![A-Za-z])|Fine|To\s*Coda)/i;
// **夹在中文歌词里**的记号（「因有主同在直到永远。 Fine」——Fine 就印在歌词行末、与歌词同高，
// OCR 常把它和末几个字读进同一块）。旧规则「只在无汉字的块里找」会整个漏掉这种记号，而且拉丁串
// 还会被当成一个英文音节占掉一个音符位、把后面的歌词整体挤偏。故含汉字的块也扫，但只认**形态
// 明确**的写法：完整词 Fine / To Coda、带点的 D.C. D.S.；裸 `DC`/`DS` 不认——那在真歌词里太容易撞。
const INLINE_JUMP_RE = /(?<![A-Za-z])(D\s*[.,·]\s*[CS]\s*[.,·]?|Fine|To\s*Coda)(?![A-Za-z])/i;
// 记号连同其修饰后缀（`D.C. al Fine`）在原文里的跨度：这整段都不该进歌词。
const JUMP_SPAN_RE = /^(D\s*[.,·]?\s*[CS]\s*[.,·]?(?:\s*al\s*[.,·]?\s*(?:Fine|Coda))?|Fine|To\s*Coda)/i;
const normalizeJump = (s: string): string => {
  const t = s.replace(/\s|[.,·]/g, "").toUpperCase();
  if (t === "DC") return "D.C.";
  if (t === "DS") return "D.S.";
  if (t === "FINE") return "Fine";
  return "To Coda";
};
// 歌词行首的段号：`1.` `2.` `3.5.` `4、` `6．`。多个号并列表示这行词由这几段共用
// （`3.5.` = 第 3、5 段唱同一行）。段号小、点更小，OCR 常把点整个吞掉（实测读出 `1沧海…`、
// `35江山…`），故分隔符一律可选、连写的数字按**逐位**拆成多个段号（简谱段号极少超过 9）。
const VERSE_LABEL_RE = /^[\s(（[]*((?:\d[\s.．、,，/]*){1,4})/;
/** 行首段号 → 段号列表；不是段号则 null。 */
function parseVerseLabel(raw: string): number[] | null {
  const m = VERSE_LABEL_RE.exec(raw);
  if (!m) return null;
  const nums = [...m[1].replace(/\D/g, "")].map(Number).filter((n) => n >= 1);
  // 号后面必须真跟着一行词。房括号上的号码（`1.2.3.5.` `4.` `6.`）也会落进歌词带被当成一行，
  // 它后面没有字——据此剔掉，否则号会与真段号撞车、把整套映射作废。
  if (!nums.length || (raw.slice(m[0].length).match(/[一-鿿]/g) ?? []).length < 2) return null;
  return nums;
}
// 页脚版权/制作声明的 OCR 经常有少量错字（如「用途」→「用速」），所以不用整句精确匹配，
// 而要求一条较长文本同时命中至少两个强语义词。正常歌词偶见「制作」等单词也不会被误删。
const FOOTER_CUE_RE = /(版权|版权所有|制作|团队|原版|音频|音頻|歌谱|歌譜|商业|商業|用途|翻印|请勿|請勿|仅供|僅供)/g;
function isFooterNoticeLine(text: string): boolean {
  const compact = text.replace(/\s/g, "");
  if (compact.length < 8) return false;
  const cues = new Set(compact.match(FOOTER_CUE_RE) ?? []);
  return cues.size >= 2;
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
// above=true 的块来自**第 0 谱行上方**那条带（rowIdx=-1）：那里没有可归属的歌词行，只可能是
// 和弦/段落方框，故永不参与歌词装配。
interface Chunk { rowIdx: number; verse: number; cells: Rect[]; maxGap: number; mark?: boolean; above?: boolean; }

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

/** 多段谱的惯例：两段唱同一句的那几行只印一行词，第二段只从"两段词分岔"的那行才另起。
 *  「再次将我更新」前两谱行只有一行词（两段主歌前半同词），第 2 段从第三谱行才开始印 → 导出后
 *  第二遍前半是空的。此处按惯例补齐：某段在它**首次出现之前**的谱行整行无词、而第 1 段那几行
 *  有词时，把第 1 段的该行词整行照抄过去（连 melisma 分布一起，下游 `/` 续记号才不错位）。
 *  只补**前缀**、且要求第 1 段在该段自己的区间里也有词——反复房「二房起歌词整体上移」那类
 *  （见 Score.expandVoltaByVerse）第 1 段在分岔行反而是空的，据此排除，不会误补。 */
function fillLeadingVerses(staff: StaffRow[]): void {
  const nv = Math.max(0, ...staff.map((r) => Math.max(0, ...r.nums.map((n) => n.lyrics?.length ?? 0))));
  if (nv < 2) return;
  const has = (row: number, v: number) => staff[row].nums.some((n) => (n.lyrics?.[v] ?? "") !== "");
  for (let v = 1; v < nv; v++) {
    const first = staff.findIndex((_, r) => has(r, v));
    if (first <= 0) continue;                       // 从第一谱行就有词（或整段无词）→ 无需补
    if (!has(first, 0)) continue;                   // 分岔行第 1 段反而空 → 是"上移"结构，别碰
    for (let r = 0; r < first; r++) {
      if (has(r, v) || !has(r, 0)) continue;
      for (const n of staff[r].nums) {
        const t = n.lyrics?.[0];
        if (t) (n.lyrics ??= [])[v] = t;
      }
    }
  }
}

/** 识别歌词与和弦并写回各音符（lyrics[] / chord）；返回二者各自的源图定位+字号
 *  （识别模式按原位/原字号叠加）。staff 为乐谱行(按出现顺序)，comps 为全图连通块。 */
export async function recognizeLyrics(
  bin: Binary, comps: Component[], staff: StaffRow[], numH: number, ocr: OcrBackend,
): Promise<{ lyrics: TextRegion[]; chords: TextRegion[] }> {
  const regions: TextRegion[] = [];
  if (!ocr.recognizeTexts || !staff.length) return { lyrics: regions, chords: [] };

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

  // i 从 **-1** 起：第 i 行的「下方带」就是第 i+1 行的「上方带」，是同一条带；唯独第 0 行的
  // 上方带原先没有任何一条带覆盖，那里的和弦（多数带和弦的谱子第一行就有）落进页眉 ROI 后
  // 被 header.ts 的 `hanziCount<2` 静默丢掉。i=-1 即那条补上的带，只走和弦/段落标记通道。
  for (let i = -1; i < staff.length; i++) {
    const row = staff[Math.max(0, i)];   // i=-1 时以第 0 行作 cov/房号的参照
    if (!row.nums.length) continue;
    const above = i < 0;
    // S1 歌词带（deslant 空间）：本谱行 deslant 下缘 → 下一谱行 deslant 上缘。
    // i=-1 的上方带没有「上一行下缘」可依，改从第 0 行上缘往上量 numH*3.5 —— 和弦紧贴谱行，
    // 标题/词曲在更上方。3.5 才够得着「再次将我更新」第一谱行的和弦（它与谱行之间还隔着一排
    // 圆滑线，距顶 2.54 个字号）；代价是会把调号/表情记号一并卷进来，那些由下面几道判据挡掉：
    // 根音必须大写、`=` 后的音名算调号、整首和弦数与小节数的比例。
    const yTop = above ? Math.max(0, dTop(row.nums) - numH * 3.5) : dBot(row.nums) + numH * 0.15;
    const yBot = above ? dTop(row.nums) - numH * 0.15
      : i + 1 < staff.length && staff[i + 1].nums.length
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
    // 房（一/二房）内的第 2、3… 段词只覆盖本房，按整行宽算 cov 天生低（沧海一声笑一房里的
    // 「天知晓。」只占 0.2）会被当注记丢掉，那几遍就没词唱。故 cov 取"对整行"与"对各房"的
    // 最大值：**整条落在某房内、且铺满该房**的短行同样算真词。
    const endingSpans: Array<[number, number]> = [];
    {
      let s = -1;
      for (const n of row.nums) {
        if (n.endingStart !== undefined) s = n.bbox.x;
        if (n.endingStop !== undefined && s >= 0) { endingSpans.push([s, rright(n.bbox)]); s = -1; }
      }
    }
    const covOf = (lx0: number, lx1: number): number => {
      let best = (lx1 - lx0) / noteSpan;
      for (const [a, b] of endingSpans) {
        const ov = Math.min(lx1, b) - Math.max(lx0, a);
        if (ov <= 0 || ov < (lx1 - lx0) * 0.8) continue; // 行须基本落在这一房内
        best = Math.max(best, (lx1 - lx0) / Math.max(1, b - a));
      }
      return best;
    };
    // 「够高」的门槛按 0.5 字高而非矮行剔除用的 0.6：charH 统计自**汉字**，而和弦是拉丁字母，
    // 天然矮一截（「再次将我更新」汉字 41px、和弦 22px，卡 0.6 就一个都不算数）。放低不冒险——
    // 够高的块只用来决定「这行要不要单独送 rec 提和弦」，认不出和弦的整块作废。
    const tallMin = charH * 0.5;
    const lineInfo = mergedBlocks.map((blocks) => {
      const cells = blocks.map((b) => blockRect(b, k));
      const longGapBefore = blocks.map((b) => b.gapBefore > longGap);
      const lx0 = cells.length ? Math.min(...cells.map((c) => c.x)) : 0;
      const lx1 = cells.length ? Math.max(...cells.map((c) => rright(c))) : 0;
      // tall = 行内达到正常字高的块数。圆滑线弧被列投影切成的碎段又窄又矮，混进同一行时会把
      // 中位字高拉到弧高上（弧与其上方的和弦 deslant-y 只差十几像素，常被并成一行），整行随即
      // 被下面的「矮行剔除」丢掉——「主祢真伟大」的 C/Am/Am/F 与 C/G/Am 两条和弦行就是这么丢的。
      // 中位数照旧不动（动它会放行真正的弧线伪行），另记 tall 供那条剔除规则开一道窄口。
      return { cells, longGapBefore, cov: cells.length ? covOf(lx0, lx1) : 0,
        h: median(cells.map((c) => c.h)), tall: cells.filter((c) => c.h >= tallMin).length };
    });
    const maxCov = Math.max(0, ...lineInfo.map((L) => L.cov));
    // 圆滑线/连音线弧、下划线等：横跨谱行(cov 高)但**矮**（弧高 ~0.5 字高），会被当成一整条伪歌词行
    // （如基督更美副歌行下的 slur → 伪 W5、OCR 出 ".llr" 垃圾）。真歌词行的字≈charH，故按行内中位字高
    // 剔掉 < 0.6×charH 的矮行——提前滤掉、不白跑 OCR（下游伪 verse 过滤也会兜底，但那已浪费识别）。
    const kept = lineInfo.filter((L) => L.cells.length && L.h >= charH * 0.6 && (L.cov >= maxCov - 1e-9 || L.cov >= 0.35));

    const rowT = TR ? { rowIdx: i, yTop, yBot, charH, bandBoxes: band.map((c) => c.bbox),
      noteBoxes: row.nums.map((n) => n.bbox), verses: [] as Array<{ verse: number; cells: Rect[]; cov: number; longGapBefore?: boolean[] }> } : null;
    if (TR && rowT) TR.rows!.push(rowT);

    // 没进歌词的行里还藏着两样有用的东西，都只送 rec 提词、不参与歌词装配（`mark: true`）：
    //  ① 段落方框 Intro/Verse/Chorus/Coda —— 被 cov 过滤掉的短行，标出段落起点，供乐句排版；
    //  ② 和弦记号 —— 它与谱行上方的圆滑线 deslant-y 只差十几像素，常被并进同一行，而弧被列投影
    //     切成的碎段又矮又碎，把行的中位字高压到几像素，整行随即被上面的「矮行剔除」丢掉
    //     （「主祢真伟大」九行里有五行的和弦这么没的）。故行内有 ≥2 个**正常字高**的块时，
    //     单把这些块拎出来送 rec，滤掉同行的弧线碎段。
    // 走 mark 通道而不是放回 kept：这类行的内容未必是和弦（「世上所有的民族」row3 的弧线行里
    // 也凑得出 4 个够高的碎块，rec 出来是一串乱码），放回歌词会多出一条伪 verse，其噪声字落到
    // 休止音上，触发 jianpu.ts 的「有词的 0 必是误判」把休止复原成音——那首音符从 100% 掉下来。
    // mark 通道只在**确实认得出和弦**时才取用（isAnnotationLine），认不出就整块作废，代价为零。
    for (const L of lineInfo) {
      if (kept.includes(L) || !L.cells.length) continue;
      const cells = L.tall >= 2 ? L.cells.filter((c) => c.h >= tallMin)
        : (L.cells.length <= 5 ? L.cells : null);   // 短行（≤5 格）整块送，长行不白跑 OCR
      if (!cells?.length) continue;
      chunks.push({ rowIdx: i, verse: -1, cells, maxGap, mark: true, above });
      strips.push(buildStrip(src, cells, STRIP_H, maxGap));
      // mark 块也记进 trace：recPerChunk 是按 strips 全量记的，这里漏记会让下游调试脚本的
      // chunk↔rec 索引整体错位（曾据此误判和弦行的归属）。
      if (TR) { const x0 = Math.min(...cells.map((r) => r.x)), y0 = Math.min(...cells.map((r) => r.y));
        const x1 = Math.max(...cells.map((r) => rright(r))), y1 = Math.max(...cells.map((r) => rbottom(r)));
        (TR.chunks ??= []).push({ rowIdx: i, verse: -1, cells, crop: { x: x0 - 4, y: y0 - 4, w: x1 - x0 + 8, h: y1 - y0 + 8 }, maxGap }); }
    }

    kept.forEach(({ cells, longGapBefore, cov }, verse) => {
      if (rowT) rowT.verses.push({ verse, cells, cov, longGapBefore });
      // S5 直接按 STRIP_MAXW 宽上限把整行字格切成 rec 块（不再逐长空白断段）：散字尽量并进同一条
      // 自然区域整体 rec——多字上下文远比逐字准（实测单字 ~85% vs 自然区域 ~98%）。宽上限已含字间空白，
      // 真正的大段乐句空白会撑到上限自然断开，不会把整行压扁。
      for (const chunkCellsArr of chunkCells(cells, maxGap)) {
        chunks.push({ rowIdx: i, verse, cells: chunkCellsArr, maxGap, above });
        strips.push(buildStrip(src, chunkCellsArr, STRIP_H, maxGap));
        if (TR) { const x0 = Math.min(...chunkCellsArr.map((r) => r.x)), y0 = Math.min(...chunkCellsArr.map((r) => r.y));
          const x1 = Math.max(...chunkCellsArr.map((r) => rright(r))), y1 = Math.max(...chunkCellsArr.map((r) => rbottom(r)));
          (TR.chunks ??= []).push({ rowIdx: i, verse, cells: chunkCellsArr, crop: { x: x0 - 4, y: y0 - 4, w: x1 - x0 + 8, h: y1 - y0 + 8 }, maxGap }); }
      }
    });
  }

  if (!strips.length) return { lyrics: regions, chords: [] };
  // 优先用**带字位**的 rec：每字带 xFrac → 直接落回源图 x，免去"字数↔连通块格数"按序硬配（错位根源）。
  const posMode = !!ocr.recognizeTextsPos;
  // **上方带的块单独成一批**送 rec：歌词那批的输入必须与「没有上方带」时逐条相同，否则识别结果
  // 会漂——实测把上方带的块（多是页眉碎块与音符上方的下划线）混进同一批，「沧海一声笑」六段词的
  // 歌词从 99.4% 掉到 80.8%，而那些块本身一个字都没进歌词。分两批调用，索引按原 chunk 序填回。
  const recPos = ocr.recognizeTextsPos?.bind(ocr);
  const mainIdx: number[] = [], aboveIdx: number[] = [];
  chunks.forEach((c, i) => (c.above ? aboveIdx : mainIdx).push(i));
  const textsPos: { ch: string; xFrac: number }[][] | null = posMode ? new Array(chunks.length) : null;
  const texts: string[] | null = posMode ? null : new Array(chunks.length);
  for (const idxs of [mainIdx, aboveIdx]) {
    if (!idxs.length) continue;
    const st = idxs.map((i) => strips[i]);
    if (textsPos) { const r = await recPos!(st); idxs.forEach((ci, k) => { textsPos[ci] = r[k]; }); }
    else { const r = await ocr.recognizeTexts(st); idxs.forEach((ci, k) => { texts![ci] = r[k]; }); }
  }
  if (TR) TR.recPerChunk = textsPos ?? texts!.map((s) => [...s].map((ch) => ({ ch, xFrac: 0 })));

  // 每块识别字汇总到 (row,verse)，再按 x 单调最近分配给音符。
  // 单元 = 一个汉字 + 紧随其后的尾随标点（，。、；！？等）：简谱标点向左贴前一字、不占音符，
  // 故并入该音节字符串而非另立单元（保持单元↔音符对齐）。段号数字等非汉字非标点 → 直接丢弃、自然不占位。
  const perLine = new Map<string, Array<{ x: number; ch: string; region?: TextRegion }>>();
  const rawByKey = new Map<string, string>();   // 每 (row,verse) 的 rec 原文（供和弦/段落标记行判定）
  const lineSeen = new Set<string>();
  const marks: { rowIdx: number; word: string; x: number }[] = []; // 段落标记（印在下一谱行上方）
  const jumps: { rowIdx: number; word: string; x: number; y: number; key: string }[] = []; // 跳转记号
  const chordCands = new Map<number, ChordCand[]>();   // rowIdx（和弦所在带的上一谱行）→ 待落位的记号

  // ── 趟 1：把每块的 rec 原文定下来（含「一」改判），按 (row,verse) 拼成**整行**原文 ──
  // 和弦行判定必须以整行为单位：短块上覆盖率不稳，单个 `Be`/`Ah` 会被误当成和弦。
  const rawTexts: string[] = [];
  for (let s = 0; s < chunks.length; s++) {
    const { rowIdx, verse, cells, mark, above } = chunks[s];
    const raw0 = textsPos ? textsPos[s].map((c) => c.ch).join("") : texts![s];
    let rawText = raw0;
    // 歌词里的「一」是孤零零一根横，自成一块送 rec 时常被读成 "1"（也见过 "-"/"—"）——这些字符
    // 走不进下面任何一个装配分支，被整个丢掉，那个音符就空出来、后面一串词跟着往前挪一格
    // （「因有主同在」的 `我愿/意将一生/奉献` 读成 `我愿/意将/生/奉献`）。中文谱的歌词块里
    // 这些字符没有别的合理来源：段号在行首另有处理，英文音节的连字符必然挨着字母、不会独占一块。
    // 只在**整块就这一个字符**时改判成「一」，不动任何多字符块。
    // 例外：**行首**、落在本谱行第一个音符左侧的单字符块是歌词行首的**段号**（多段谱的 `1.`/`2.`），
    // 它本就该被丢弃、不占音符位。不排除的话「沧海一声笑」六段词的段号会全变成「一」字。
    // 上方带（above）不改判：那里根本没有歌词，把短横改成汉字只会让整行不再被判为和弦行。
    const notes0 = rowIdx >= 0 ? staff[rowIdx].nums : [];
    const beforeFirstNote = notes0.length > 0 && rright(cells[cells.length - 1]) < rcx(notes0[0].bbox);
    if (!above && !beforeFirstNote && /^[-‐‑–—1]$/.test(rawText.trim())) {
      rawText = "一";
      if (textsPos) textsPos[s] = textsPos[s].map((c) => ({ ...c, ch: "一" }));
    }
    rawTexts[s] = rawText;
    // 整行原文按**改判前**的 rec 文本拼：改判把弧线碎块读出的 `-`/`1` 一律当成歌词的「一」，
    // 而和弦行上方常有圆滑线，其碎块正落在同一行——一个凭空的「一」就让整行「含汉字」，
    // 和弦行判定当场失效（「主祢真伟大」的 C/G/Am 两行就这么丢的）。装配那一步照旧用改判后的
    // rawTexts，两者互不干扰；页脚版权那条判据看的是长中文句，用哪份都一样。
    if (!mark) rawByKey.set(`${rowIdx}:${verse}`, (rawByKey.get(`${rowIdx}:${verse}`) ?? "") + raw0);
  }
  // 和弦/段落标记行（Am、G/B、Gsus4、Chorus…）：判出后**不进歌词装配**，转走和弦通道。
  // 与旧版的差别只在时机——过去是装配完再 delete 整行，现在它根本没进来，于是它误捞的跳转
  // 记号（和弦行连写成 `G/D C` → 读出一个 `DC`）也不必再事后撤销。判据与阈值一字未改。
  const chordKeys = new Set([...rawByKey.keys()].filter((k) => isAnnotationLine(rawByKey.get(k)!)));

  // ── 趟 2：段落标记/跳转记号就地捞取 + 歌词装配 ──
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

    const rawText = rawTexts[s];
    // 段落方框 Intro/Verse/Chorus/Coda：可能独占一块（被 cov 过滤的短行），也可能与和弦行同块
    // （"Gsus4G" 与 "Chorus" 同一 verse 行）。在任何块里就地捞出，x 取该词首字。
    // **上方带（above）除外**：那条带是为和弦新开的，本不在旧管线的视野里，让它也产出段落标记
    // 就等于凭空改动既有行为——它收的多是音符上方的下划线/弧线碎块，rec 出的噪声足以命中
    // SECTION_MARK_RE，给首行安一个假段落起点，乐句排版据此硬换行，整首的 .Words 分行跟着走样
    // （「沧海一声笑」六段词的歌词准确率因此从 99.4% 掉到 80.8%）。跳转记号同理。
    if (!chunks[s].above) {
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
    // 含汉字的块用严格写法（见 INLINE_JUMP_RE），无汉字的注记块沿用宽松写法。
    let jumpSpan: [number, number] | null = null;
    if (!chunks[s].above) {
      const hit = (/[一-鿿]/.test(rawText) ? INLINE_JUMP_RE : JUMP_MARK_RE).exec(rawText);
      if (hit) {
        let acc = 0, xf = 0;
        if (textsPos) for (const c of textsPos[s]) { if (acc >= hit.index) { xf = c.xFrac; break; } acc += c.ch.length; }
        const jy = (Math.min(...cells.map((c) => c.y)) + Math.max(...cells.map((c) => rbottom(c)))) / 2;
        // 和弦行里捞出的记号是误检（连写的 `G/D C` → `DC`，「立定心志」因此被展开成十遍）：
        // 整行既然不是歌词，记号也不作数。真的 D.C./Fine 印在音符下方自己那一小块里。
        if (!chordKeys.has(key)) jumps.push({ rowIdx, word: normalizeJump(hit[0]), x: textsPos ? fracToSrcX(xf) : cells[0].x, y: jy, key });
        const span = JUMP_SPAN_RE.exec(rawText.slice(hit.index));
        jumpSpan = [hit.index, hit.index + (span?.[0].length ?? hit[0].length)];
      }
    }
    // 和弦通道：整行判为和弦行 → 就地切记号 + 取每个记号的**起始 x**（与段落方框同一取位法）。
    // 被 cov 过滤成 mark 的短和弦行也走这里，用块级判定——它本就整块丢弃，误伤代价低。
    // 但**跳转记号优先**：`D.C.` 的两个字母恰好都是合法根音、点算分隔符，覆盖率满分，块级判据
    // 会把它切成 D、C 两个和弦（「沧海一声笑」的 D.C. 就这么变出两个凭空的和弦）。整行和弦
    // 那一支不受这条约束——那里的 jumpSpan 本身才是误检（连写的 `G/D C` → `DC`）。
    const isChordChunk = chordKeys.has(key) || (chunks[s].mark === true && !jumpSpan && isAnnotationLine(rawText));
    if (isChordChunk) {
      const by0 = Math.min(...cells.map((c) => c.y)), by1 = Math.max(...cells.map((c) => rbottom(c)));
      const srcXAt = (idx: number): number => {
        if (!textsPos) return cells[0].x;
        let acc = 0;
        for (const c of textsPos[s]) { if (acc >= idx) return fracToSrcX(c.xFrac); acc += c.ch.length; }
        return fracToSrcX(1); // 下标越界（记号收在行末）→ 该条右缘
      };
      const cands = chordCandidates(rawText, srcXAt, (x0, x1) => ({ x: x0, y: by0, w: x1 - x0, h: by1 - by0 }));
      if (cands.length) chordCands.set(rowIdx, [...(chordCands.get(rowIdx) ?? []), ...cands]);
    }
    if (chunks[s].mark) continue; // 只为提段落词而 rec 的块：不参与歌词装配
    // 上方带（rowIdx=-1）没有可归属的歌词行，非和弦的内容一概丢弃。
    if (rowIdx < 0) continue;
    // 和弦行**照旧先装配、再整行剔除**（见下方 dropKeys）。看似绕，但装配这一步有下游依赖：
    // 休止复原（jianpu.ts 的「digit=0 却对齐到歌词」）看的是装配后的 lyrics[]，跳过装配会让
    // 「世上所有的民族」少复原一个被误读成 0 的音。提前分流只用于**收集和弦**，不动歌词那条路。

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
      let at = 0;
      for (const { ch, xFrac } of textsPos![s]) {
        const pos = at; at += ch.length;
        if (jumpSpan && pos >= jumpSpan[0] && pos < jumpSpan[1]) { flushLatin(); continue; } // 记号不是歌词
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
      let at = 0;
      for (const ch of texts![s]) {
        const pos = at; at += ch.length;
        if (jumpSpan && pos >= jumpSpan[0] && pos < jumpSpan[1]) { flushLatin(); continue; } // 记号不是歌词
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

  // 剔除和弦/段落标记行（判定已在装配前做好，见 chordKeys）与页脚版权声明：它们同样落在歌词带内，
  // 放开拉丁字符/最后一行开放带后会成为伪 verse。剔掉后把该谱行剩余 verse 按原顺序重新编号
  // （保持各行 W1/W2 对齐；无注记行时是恒等变换）。
  const dropped = new Set<TextRegion>();
  {
    const dropKeys = [...perLine.keys()].filter((k) => chordKeys.has(k) || isFooterNoticeLine(rawByKey.get(k) ?? ""));
    for (const k of dropKeys) {
      for (const p of perLine.get(k)!) if (p.region) dropped.add(p.region);
      perLine.delete(k);
      rawByKey.delete(k);
    }
    if (dropKeys.length) {   // 只看**真被删掉**的 perLine 行；上方带的和弦 key 不在 perLine 里，不该触发重编号
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

  // 和弦落位：和弦印在**下一谱行**音符的上方（与段落方框同理）。上方带的 rowIdx=-1 自然落到
  // 第 0 行——「第一谱行不做特例」正是这么兑现的。归到哪个音符/拍位见 chordline.placeChords。
  const chordRegions: TextRegion[] = [];
  for (const [rowIdx, cands] of chordCands) {
    const row = staff[rowIdx + 1];
    if (row) placeChords(row, cands, chordRegions);
  }
  // 全局合理性：真配了和弦的谱子基本上每小节至少一个（14 首实测最稀的一首也有 0.56 个/小节）。
  // 稀稀拉拉几个多半是页眉/调号/注记被误当和弦——放宽第 0 行上方带以后尤其容易撞上。整批作废
  // 比留着强：漏掉几个和弦只是少个记号，混进几个假和弦却会印在谱面上误导演奏。
  {
    const bars = staff.reduce((a, r) => a + r.barlineXs.length, 0);
    const chordN = staff.reduce((a, r) => a + r.nums.filter((n) => n.chord).length, 0);
    if (bars >= 4 && chordN < bars * 0.4) {
      for (const r of staff) for (const n of r.nums) { delete n.chord; delete n.chordOffset; }
      chordRegions.length = 0;
    }
  }

  // 跳转记号落位：作用于记号所在处的小节末 → 归到 x 处或其左侧最近的那个音符（记号总略偏右于末音）。
  // 归**哪一行**要看它贴着谁：记号多印在本谱行音符下方（Fine 贴在歌词行末），但 `D.C. al Fine`
  // 这类收尾记号习惯印在**末谱行音符的右上方**——那同样落在「上一行下缘→本行上缘」的歌词带里，
  // 一律归本行就会把 D.C. 挂到上一行末（本曲挂到小节 22，整首少唱一行半）。故按 y 就近取行。
  for (const jp of jumps) {
    let rowIdx = jp.rowIdx;
    const cur = staff[rowIdx], next = staff[rowIdx + 1];
    if (cur && next && next.topY - jp.y < jp.y - cur.bottomY) rowIdx += 1;
    const row = staff[rowIdx];
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
    // 去留按**视觉行序**整体决定，不逐谱行：一个行序只要在某一谱行上是完整一行词，它就是真
    // verse，它在别的谱行上的短行（房内只唱一小节的那几行，如沧海一声笑一房里的「几多娇？」）
    // 跟着保留——否则那几遍会唱空。
    const real = new Set<number>();
    for (const key of perLine.keys()) {
      const [rowIdx, verse] = key.split(":").map(Number);
      if ((rowsWithText.get(verse)?.size ?? 0) * 2 >= primary) { real.add(verse); continue; } // 行数够 → 真
      // 行数不够也可能是真词：多段谱的第 2..N 段只印在主歌那几行，啦…/间奏行下方本就没有
      // （沧海一声笑 A 段有 1./2./3.5./4./6. 五行词，只光按行数会被整片当伪 verse 删掉，
      //  六个房就全唱成第一段）。真词在它出现的那一行是**完整一行**、字数与主 verse 相当；
      // 噪声伪行（世上 row3 的「一尊心…办单办，口」）只有零星几字，仍被删。
      const ref = chars.get(`${rowIdx}:${primaryVerse}`) ?? 0;
      if (ref > 0 && (chars.get(key) ?? 0) >= ref * 0.6) real.add(verse);
    }
    for (const key of [...perLine.keys()]) {
      if (!real.has(Number(key.split(":")[1]))) perLine.delete(key);
    }
  }

  // 段号标签 → 词段映射。多段谱在歌词行首印段号（`1.` `2.` `3.5.` `4.` `6.`），**视觉行序未必
  // 等于段号**：一行可服务多遍（`3.5.` = 第 3、5 遍共用这行词），号也可能跳（`6.`）。段号是非汉字、
  // 装配时本就被丢弃、不占音符位，只需从 rec 原文行首把它取回来做重映射。
  // 标签通常只印在第一谱行；后续谱行（如房内那几行）行序与它一致，故按**视觉行序**建全局映射。
  const verseLabels = new Map<number, number[]>();
  {
    const seen = new Set<number>();
    for (const [key, raw] of rawByKey) {
      const [rowIdx, verse] = key.split(":").map(Number);
      // 上方带（rowIdx=-1）没有歌词，不该参与任何 verse 语义。它按插入序**排在最前**，
      // 不跳过就会顶掉真正的 `0:0`（标着 `1.` 的那行）占住 seen，整套段号映射随即作废、
      // 退回「行序即段号」——「沧海一声笑」的 `3.5.` 跳号失效，W5/W6 整体错位。
      if (rowIdx < 0) continue;
      if (seen.has(verse)) continue;           // 每个视觉行只看它首次出现的那一谱行（= 标号那行）
      seen.add(verse);
      const nums = parseVerseLabel(raw);
      if (nums) verseLabels.set(verse, nums);
    }
    // 只在标签成套时才信：首行必须标 1、号不重复、至少两行有标签。零星误读（歌词里恰好有
    // 数字、OCR 把字读成数字）达不到这几条，映射整体作废、退回"行序即段号"。
    const all = [...verseLabels.values()].flat();
    const ok = verseLabels.size >= 2 && verseLabels.get(0)?.[0] === 1 &&
      new Set(all).size === all.length;
    if (!ok) verseLabels.clear();
    if ((globalThis as { __omrDebug?: boolean }).__omrDebug) {
      console.log("[lyrics/verse-label]", ok ? "apply" : "ignore",
        [...verseLabels].map(([v, ns]) => `${v}->${ns.join(",")}`).join(" "));
    }
  }
  /** 视觉行序 → 段号列表（1 基）。无标签时即行序本身。 */
  const versesOf = (v: number): number[] => verseLabels.get(v) ?? [v + 1];

  if (TR) { TR.placed = {}; for (const [k, p] of perLine) TR.placed[k] = p.map(({ x, ch }) => ({ x, ch })); }

  // 投影已在自然上下文里把尾随标点并进字块、由 OCR 直接读出（并折全角）→ 不再需要几何补标点。
  for (const [key, placed] of perLine) {
    const [rowIdx, visual] = key.split(":").map(Number);
    const targets = versesOf(visual);            // 一行词可同时属于多个段（`3.5.`）
    const verse = targets[0] - 1;
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
      // 落在**延音音符**上的孤立拉丁串不是歌词。tie/slur 的收尾音唱的还是上一个音节（前一音
      // 已有词），此处本就不该另起一个新音节；中文歌里在这个位置冒出来的拉丁串只可能是记号
      // ——Fine / D.C. 就印在歌词行末尾、紧挨着延音的末音（「…直到永远。 Fine」）。这条兜住
      // INLINE_JUMP_RE 认不出的写法（OCR 把点吞了、记号被拆开）：认不出是哪个记号也罢，至少
      // 不让它挤进歌词把后面的对齐带偏。**只对拉丁串**生效——汉字落到延音音上多半只是对齐
      // 误差，丢掉就真丢词了。
      const isStrayMark = !/[一-鿿]/.test(ch) && /[A-Za-z]/.test(ch) &&
        (nt.tieStop || nt.slurStop) && !nt.tieStart && !nt.slurStart &&
        ni > 0 && !!(notes[ni - 1].lyrics?.[verse] ?? "");
      if (!isStrayMark) {
        if (!nt.lyrics) nt.lyrics = [];
        for (const p of targets) nt.lyrics[p - 1] = (nt.lyrics[p - 1] || "") + ch;
      }
      if (ni < notes.length - 1) ni++;
    }
    if (TR) (TR.aligned ??= {})[key] = notes.map((n) => ({ noteX: rcx(n.bbox), noteBox: n.bbox, lyric: n.lyrics?.[verse] || "" }));
  }

  fillLeadingVerses(staff);
  return { lyrics: dropped.size ? regions.filter((r) => !dropped.has(r)) : regions, chords: chordRegions };
}
