// 简谱页眉(第一行乐谱之上)信息识别：标题、作词/作曲(及编/译)等。
// 复用歌词的"自然区域分块 rec"（lyrics.ts）：取页眉区连通块 → 按 y 分行 → 每行整体 rec →
// 按内容/字号归类：含 作/词/曲/编/译 → 著作者 credit；最大字号且较居中的中文行 → 标题。
import type { Binary, Component, Rect, TextRegion } from "./types";
import type { OcrBackend } from "./ocr";
import { srcCanvasOf, mergeToChars, chunkCells, buildStrip } from "./lyrics";

const median = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
const hanziCount = (s: string) => (s.match(/[一-鿿]/g) || []).length;

export interface HeaderInfo {
  title?: string;
  /** 著作者整行文本（如 "作词：叶薇心"），下游作为 credit 写入 WordsByAndMusicBy。 */
  credits: string[];
  /** 调号五度圈数（识别到 "1=♭B" 等时给出，否则 undefined→上游用默认 0）。 */
  fifths?: number;
  /** 速度（♩=NN），仅进 MusicXML（当前下游导入器不读 tempo，故不进 .jpwabc）。 */
  tempo?: number;
  /** 拍号分子/分母（识别到 "4/4" 等时给出，否则 undefined→上游用默认 4/4）。 */
  beats?: number;
  beatType?: number;
  /** 页眉文本的源图定位（识别模式按原位叠加）。 */
  regions: TextRegion[];
}

interface HLine { text: string; charH: number; cx: number; cy: number; n: number; bbox: Rect; chars?: { text: string; cx: number; x1?: number }[]; }

/** 英文著作者名的词间空格恢复：PP-OCR rec 不吐空格，故 "Isaac Watts" → "IsaacWatts"。
 *  用 det/CTC 给的逐字**左缘 cx + 右缘 x1**：相邻两字母的**边界间隙**(右字左缘 − 左字右缘) 明显大于
 *  字母间隙中位数处补一个空格。**关键**：用边界间隙而非中心距——中心距含字形宽度(W 宽、i 窄)会虚高、
 *  且被逗号等窄字撑大误判；边界间隙才是真实空白。只认字母-字母对(跳标点/数字，"1719" 不拆)。 */
function recoverLatinSpaces(text: string, raw?: { text: string; cx: number; x1?: number }[]): string {
  if (!raw || raw.length < 4 || !/[A-Za-z]{2}/.test(text)) return text;
  const chars = [...text];
  const cx: number[] = [], x1: number[] = []; // 每个 text 字符对位到的 raw 左缘/右缘（贪心顺序匹配）
  let ri = 0;
  for (const ch of chars) {
    let j = ri; while (j < raw.length && raw[j].text !== ch) j++;
    if (j < raw.length) { cx.push(raw[j].cx); x1.push(raw[j].x1 ?? raw[j].cx); ri = j + 1; } else { cx.push(NaN); x1.push(NaN); }
  }
  const isLetter = (c: string) => /[A-Za-z]/.test(c);
  // 相邻字母的边界间隙：右字左缘 cx[i+1] − 左字右缘 x1[i]。
  const gapAt = (i: number) => cx[i + 1] - x1[i];
  const pair = (i: number) => isLetter(chars[i]) && isLetter(chars[i + 1]) && !isNaN(x1[i]) && !isNaN(cx[i + 1]);
  const llGaps: number[] = [];
  for (let i = 0; i < chars.length - 1; i++) if (pair(i)) llGaps.push(gapAt(i));
  if (llGaps.length < 3) return text;
  const med = median(llGaps);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    out += chars[i];
    // 词内字母边界间隙落在 {1,2}×基元(实测量化)、中位≈2×基元；词间空白≈4×基元=2×中位。取 1.5×中位为
    // 界，稳落两簇之间(词内 ≤中位、词间 ≈2×中位)。含绝对下限防紧排文字里中位过小被放大误插。
    if (i < chars.length - 1 && pair(i) && gapAt(i) > med * 1.5 && gapAt(i) > med + 6) out += " ";
  }
  return out;
}

/** 把展示文本(可能已规整：去编号前缀、冒号全角化、截尾噪声)逐字对位回 OCR 原始字位，
 *  供识别模式按源图 x 逐字叠加。贪心在 raw 里顺序找等字符；标点全/半角差异等取下一个原始位近似。 */
function charsForText(text: string, raw?: { text: string; cx: number }[]): { text: string; cx: number }[] | undefined {
  if (!raw || !raw.length) return undefined;
  const res: { text: string; cx: number }[] = [];
  let ri = 0;
  for (const ch of text.trim()) {
    if (ch === " ") continue; // 恢复出来的词间空格无字形，不占原始字位
    let j = ri;
    while (j < raw.length && raw[j].text !== ch) j++;
    if (j < raw.length) { res.push({ text: ch, cx: raw[j].cx }); ri = j + 1; }        // 精确命中
    else if (ri < raw.length) { res.push({ text: ch, cx: raw[ri].cx }); ri++; }       // 归一化字符：取下一原始位
    else if (res.length) { res.push({ text: ch, cx: res[res.length - 1].cx + 1 }); }  // raw 用尽：顺延
  }
  return res.length ? res : undefined;
}

// 大调主音字母 → 五度圈数（自然，无升降）。降号 -7、升号 +7。
const NAT_FIFTHS: Record<string, number> = { C: 0, D: 2, E: 4, F: -1, G: 1, A: 3, B: 5 };

// fifths → 简谱调号 DO 位（如 -2 → "♭B"，2 → "D"），与图片 "1=♭B" 写法一致。供页眉叠加展示。
const KEY_SHARP = ["C", "G", "D", "A", "E", "B", "♯F", "♯C"];
const KEY_FLAT = ["C", "F", "♭B", "♭E", "♭A", "♭D", "♭G", "♭C"];
export function fifthsToKey(f: number | undefined): string {
  if (f === undefined) return "C";
  return f < 0 ? (KEY_FLAT[-f] ?? "C") : (KEY_SHARP[f] ?? "C");
}

/** 一组连通块的并集包围盒（源图像素坐标）。 */
function unionBox(cs: Component[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cs) { const b = c.bbox; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 从页眉小字区解析调号("1=♭B")与速度("♩=76")。OCR 常把 ♭→b、♩→J；页眉碎片散落，
 *  故按碎片就地匹配、必要时空间最近邻配对，避免跨列拼接误配。 */
function parseMeta(lines: HLine[]): { fifths?: number; tempo?: number; beats?: number; beatType?: number; fifthsLine?: HLine; tempoLine?: HLine; timeBBox?: Rect } {
  const res: { fifths?: number; tempo?: number; beats?: number; beatType?: number; fifthsLine?: HLine; tempoLine?: HLine; timeBBox?: Rect } = {};
  const toFifths = (note: string, acc: string): number | undefined => {
    if (!(note in NAT_FIFTHS)) return undefined;
    let f = NAT_FIFTHS[note];
    if (acc === "b" || acc === "♭") f -= 7;
    else if (acc === "#" || acc === "♯") f += 7;
    return f >= -7 && f <= 7 ? f : undefined;
  };

  // 调号：先认单碎片内 "1=♭B" 或 "♭B"（升降号紧贴音名）；再认自然调 "1=G"（音名无升降号）。
  for (const l of lines) {
    const acc = l.text.match(/1\s*[=＝]\s*([b#♭♯])\s*([A-G])/) || l.text.match(/([b#♭♯])\s*([A-G])(?![a-z])/);
    if (acc) { const f = toFifths(acc[2], acc[1]); if (f !== undefined) { res.fifths = f; res.fifthsLine = l; break; } }
    // 自然调："1=G"/"1=C4"(4 来自拍号)。音名后须非升降号(否则属上面的带号情形)、非小写字母。
    const nat = l.text.match(/1\s*[=＝]\s*([A-G])(?![b#♭♯a-z])/);
    if (nat && nat[1] in NAT_FIFTHS) { res.fifths = NAT_FIFTHS[nat[1]]; res.fifthsLine = l; break; }
  }
  // 否则：独立升降号碎片 + 右侧最近大写音名碎片（"♭B" 被 OCR 拆成 "b" / "B4" 两块时）。
  if (res.fifths === undefined) {
    const accs = lines.filter((l) => /^[b#♭♯]$/.test(l.text.trim()));
    const notes = lines.filter((l) => /^[A-G]/.test(l.text.trim()));
    for (const a of accs) {
      let best: HLine | null = null, bd = Infinity;
      for (const n of notes) {
        // dx 上限放宽：音名碎片常与时值数字粘连(如 "B4")，质心被右拉。
        const dx = n.cx - a.cx, dy = Math.abs(n.cy - a.cy);
        if (dx < -0.3 * a.charH || dx > 4.5 * a.charH || dy > 1.5 * a.charH) continue;
        const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = n; }
      }
      if (best) { const f = toFifths(best.text.trim()[0], a.text.trim()); if (f !== undefined) { res.fifths = f; res.fifthsLine = best; break; } }
    }
  }

  // 速度：含 "=NN" 的碎片（♩/J 常与数字同块，如 "J=76"）。
  for (const l of lines) {
    const t = l.text.match(/[=＝]\s*(\d{2,3})\b/);
    if (t) { const bpm = parseInt(t[1], 10); if (bpm >= 30 && bpm <= 300) { res.tempo = bpm; res.tempoLine = l; break; } }
  }

  // 拍号：分子/分母。简谱常写成 "X/4"（或与调号同块 "1=C 2/4"）；OCR 偶把斜杠丢成空格或上下竖排。
  const tm = parseTime(lines, res.fifthsLine);
  if (tm) { res.beats = tm.beats; res.beatType = tm.beatType; res.timeBBox = tm.bbox; }
  return res;
}

/** 合法拍号：分母为 2 的幂(2/4/8/16，偶含 1/2 拍 → beatType 2)，分子 1..16。 */
const validBeatType = (d: number) => d === 1 || d === 2 || d === 4 || d === 8 || d === 16;
const validBeats = (n: number) => n >= 1 && n <= 16;
const union2 = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** 解析拍号：先认含斜杠的碎片 "X/Y"（含调号同块 "1=C 4/4"）；否则认上下竖排两碎片(分子在上、
 *  分母在下、同列)。返回分子/分母与**叠加标注的源图 bbox**。 */
function parseTime(lines: HLine[], fifthsLine?: HLine): { beats: number; beatType: number; bbox: Rect } | undefined {
  // 斜杠式："4/4"、"6/8"，或与调号粘连 "1=C4/4"。取最右侧"数/数"。
  for (const l of lines) {
    const m = l.text.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    if (m) {
      const n = parseInt(m[1], 10), d = parseInt(m[2], 10);
      if (!validBeats(n) || !validBeatType(d)) continue;
      // 与调号同碎片("1=C4/4")：bbox 偏到行右侧，避免压在 "1=C" 标注上。
      let bbox = l.bbox;
      if (l === fifthsLine) bbox = { x: l.bbox.x + l.bbox.w * 0.62, y: l.bbox.y, w: l.bbox.w * 0.38, h: l.bbox.h };
      return { beats: n, beatType: d, bbox };
    }
  }
  // 竖排式：两个纯数字碎片，上下相邻、x 近乎对齐（分子在上 / 分母在下）。调号行附近优先。
  const digs = lines.filter((l) => /^\d{1,2}$/.test(l.text.trim()));
  let best: { beats: number; beatType: number; bbox: Rect } | undefined, bd = Infinity;
  for (const a of digs) for (const b of digs) {
    if (a === b) continue;
    const dy = b.cy - a.cy, dx = Math.abs(b.cx - a.cx);     // a 在上、b 在下
    if (dy <= 0.3 * a.charH || dy > 2.5 * a.charH || dx > 0.8 * a.charH) continue;
    const n = parseInt(a.text.trim(), 10), d = parseInt(b.text.trim(), 10);
    if (!validBeats(n) || !validBeatType(d)) continue;
    // 越靠近调号行越可信（拍号紧跟调号）；以分子块到调号行的距离择优。
    const score = fifthsLine ? Math.abs(a.cy - fifthsLine.cy) + Math.abs(a.cx - fifthsLine.cx) : dy + dx;
    if (score < bd) { bd = score; best = { beats: n, beatType: d, bbox: union2(a.bbox, b.bbox) }; } // bbox 跨分子+分母
  }
  return best;
}

/** 把"同一字列里上下紧贴的碎块"竖向合并成整字高复合块。用于页眉粗体标题：复杂字(督/赢)的上下
 *  偏旁会断成多个半截连通块。条件：x 向高度重叠(同列) + 竖向近乎相接(非整行行距)。返回新连通块集
 *  (未被并的原样保留；被并的取并集包围盒，cx/cy 取包围盒中心——仅用于分层/裁剪定位，足够)。 */
function mergeStackedColumns(comps: Component[], numH: number): Component[] {
  const boxes = comps.map((c) => ({ ...c.bbox }));
  const alive = boxes.map(() => true);
  const xOverlap = (a: typeof boxes[0], b: typeof boxes[0]) => {
    const o = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    return o / Math.min(a.w, b.w);
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < boxes.length; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < boxes.length; j++) {
        if (!alive[j]) continue;
        const a = boxes[i], b = boxes[j];
        const top = a.y <= b.y ? a : b, bot = a.y <= b.y ? b : a;
        const gap = bot.y - (top.y + top.h);          // <0 表示竖向有重叠
        if (xOverlap(a, b) < 0.35 || gap > numH * 0.35) continue; // 非同列、或隔了整行行距 → 不并
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const nb = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
        if (nb.h > numH * 3) continue;                 // 防止串列失控
        if (nb.w / nb.h < 0.5) continue;               // 合出来又高又窄 → 多半是竖排拍号(4/4)等 meta，非方块汉字，别并
        boxes[i] = nb; alive[j] = false; changed = true;
      }
    }
  }
  return boxes.filter((_, i) => alive[i]).map((b, id) => ({ id, bbox: b, area: b.w * b.h, cx: b.x + b.w / 2, cy: b.y + b.h / 2 }));
}

/** 识别页眉信息。firstStaffTopY = 第一乐谱行顶部 y；只看其上方区域。 */
export async function recognizeHeader(
  bin: Binary, comps: Component[], firstStaffTopY: number, numH: number, ocr: OcrBackend,
): Promise<HeaderInfo> {
  const out: HeaderInfo = { credits: [], regions: [] };
  if (!ocr.recognizeTexts || firstStaffTopY < numH) return out;
  const recognizeTexts = ocr.recognizeTexts.bind(ocr);

  // 优先走文本检测(DBNet)整片识别页眉：让 det 网络自己找文本行，免去靠连通域几何切行/分层的脆弱
  // 启发式（粗体复杂字裂块、字号混排都更稳）。det 返回空(漏检/无模型)时退回下方几何法。
  // 可用 (globalThis).__headerDet=false 关闭以做 A/B。
  if (ocr.recognizeRegion && (globalThis as { __headerDet?: boolean }).__headerDet !== false) {
    const dets = await ocr.recognizeRegion(bin, { x: 0, y: 0, w: bin.w, h: Math.round(firstStaffTopY - numH * 0.1) });
    if (dets.length) {
      const lines: HLine[] = dets.map((d) => ({ text: d.text, charH: d.bbox.h, cx: d.bbox.x + d.bbox.w / 2, cy: d.bbox.y + d.bbox.h / 2, n: 1, bbox: d.bbox, chars: d.chars }));
      if ((globalThis as { __omrDebug?: boolean }).__omrDebug) console.log("[header/det]", lines.map((l) => `${Math.round(l.charH)}px@${Math.round(l.cx)},${Math.round(l.cy)}=${JSON.stringify(l.text)}`).join("  "));
      classify(lines);
      return out;
    }
  }

  // 页眉区字号大小的连通块。
  const region = comps.filter((c) => {
    const b = c.bbox; const cy = b.y + b.h / 2;
    return cy < firstStaffTopY - numH * 0.1 && b.h >= numH * 0.4 && b.w >= numH * 0.2;
  });
  if (!region.length) return out;

  const src = srcCanvasOf(bin);
  // 行 = 一组连通块；整体 rec（自然区域分块）。返回 {text,charH,cx,cy,n}。
  const ocrGroups = async (gs: Component[][]): Promise<HLine[]> => {
    const meta: Component[][] = [], strips: OffscreenCanvas[] = [], owner: number[] = [];
    for (const g of gs) {
      const charH = median(g.map((k) => k.bbox.h)) || numH;
      const cells = mergeToChars(g, charH);
      if (!cells.length) continue;
      const li = meta.length; meta.push(g);
      for (const ch of chunkCells(cells)) { strips.push(buildStrip(src, ch)); owner.push(li); }
    }
    if (!strips.length) return [];
    const texts = await recognizeTexts(strips);
    const lines: HLine[] = meta.map((g) => ({ text: "", charH: median(g.map((k) => k.bbox.h)) || numH, cx: median(g.map((k) => k.cx)), cy: median(g.map((k) => k.cy)), n: g.length, bbox: unionBox(g) }));
    texts.forEach((t, i) => { lines[owner[i]].text += t; });
    return lines;
  };

  // 分块：先按 y 分行，再行内按大 x 间隙(>2×字高)切块 —— 分开页眉里横向并列的区块
  // （左:作词作曲 / 中:标题、调号 / 右:页码）。
  const splitBlocks = (cs: Component[]): Component[][] => {
    const sortedY = [...cs].sort((a, b) => a.cy - b.cy);
    const yRows: Component[][] = [];
    for (const c of sortedY) {
      const r = yRows.find((R) => Math.abs(median(R.map((k) => k.cy)) - c.cy) < numH * 0.6);
      if (r) r.push(c); else yRows.push([c]);
    }
    const blocks: Component[][] = [];
    for (const r of yRows) {
      const rowH = median(r.map((k) => k.bbox.h));
      let cur: Component[] = [];
      for (const c of [...r].sort((a, b) => a.bbox.x - b.bbox.x)) {
        const last = cur[cur.length - 1];
        if (last && c.bbox.x - (last.bbox.x + last.bbox.w) > rowH * 2) { blocks.push(cur); cur = []; }
        cur.push(c);
      }
      if (cur.length) blocks.push(cur);
    }
    return blocks;
  };

  // 粗体标题里的复杂多偏旁字(如 督/赢)常裂成上下叠放的半截块，各自达不到 1.3×numH 而错落入
  // 小字层、并在标题中间留下大间隙——结果标题被切成两段、还丢字。故先把"同一字列里上下紧贴的
  // 碎块"竖向合并成整字高的复合块，再走原大/小字分层逻辑：督/赢 复原为大字、与标题连成一气。
  // （叠放的两行著作者"作词/作曲"行距大，不会被并；故只并近乎相接的碎块。）
  const merged = mergeStackedColumns(region, numH);

  // 标题字号明显更大(≥1.3×numH)，与正文小字分两层各自分块，避免按 y 黏连。
  const big = merged.filter((c) => c.bbox.h >= numH * 1.3);
  const small = merged.filter((c) => c.bbox.h < numH * 1.3);
  const lines = await ocrGroups([...splitBlocks(big), ...splitBlocks(small)]);

  classify(lines);
  return out;

  // 归类：以 作/词/曲/编/译 开头紧跟冒号(作词：/词曲：…) → credits；其余最大字号中文行作标题。
  // 著作者前缀须**行首**紧贴冒号——否则长句经文副标题("…正如他作更美之约…来8：6")也会因含"作"+"："被误判。
  function classify(ls: HLine[]) {
    const creditRe = /^\s*[作詞词曲編编譯译]{1,4}\s*[:：]/;
    let titleLine: HLine | null = null;
    for (const ln of ls) {
      const txt = ln.text.trim();
      if (creditRe.test(txt)) {
        // "作曲：王丽玲1=bB4" → "作曲：王丽玲"：取 冒号前缀 + 紧随的中文名（英文名则整行保留）。
        const m = txt.match(/^(.*?[:：])\s*([一-鿿·]+)/);
        // 中文名取前缀+名；英文名整行保留、并按字距恢复词间空格（"IsaacWatts"→"Isaac Watts"）。
        // 著作者前缀的冒号统一成全角 `：`（.jpwabc 约定；中文名行 OCR 多已全角，英文名行常落半角）。
        const credit = (m ? m[1] + m[2] : recoverLatinSpaces(txt, ln.chars))
          .replace(/^([作詞词曲編编譯译]{1,4})\s*[:：]/, "$1：");
        out.credits.push(credit);
        out.regions.push({ text: credit, bbox: ln.bbox, chars: charsForText(credit, ln.chars) });
        continue;
      }
      if (hanziCount(txt) < 2) continue;            // 跳过页码/调号/速度等（数字/符号为主）
      if (!titleLine || ln.charH > titleLine.charH) titleLine = ln;  // 标题=最大字号中文行
    }
    if (titleLine) {
      out.title = titleLine.text.trim().replace(/^\s*\d{1,4}\s*[.．、]\s*/, ""); // 去掉 "557." 之类的诗歌编号前缀
      out.regions.push({ text: out.title, bbox: titleLine.bbox, chars: charsForText(out.title, titleLine.chars) });
    }
    const meta = parseMeta(ls);
    out.fifths = meta.fifths;
    out.tempo = meta.tempo;
    out.beats = meta.beats;
    out.beatType = meta.beatType;
    if (meta.fifths !== undefined && meta.fifthsLine) out.regions.push({ text: `1=${fifthsToKey(meta.fifths)}`, bbox: meta.fifthsLine.bbox });
    if (meta.tempo !== undefined && meta.tempoLine) out.regions.push({ text: `♩=${meta.tempo}`, bbox: meta.tempoLine.bbox });
    if (meta.beats !== undefined && meta.beatType !== undefined && meta.timeBBox) out.regions.push({ text: `${meta.beats}/${meta.beatType}`, bbox: meta.timeBBox });
  }
}
