// 简谱页眉(第一行乐谱之上)信息识别：标题、作词/作曲(及编/译)等。
// 复用歌词的"自然区域分块 rec"（lyrics.ts）：取页眉区连通块 → 按 y 分行 → 每行整体 rec →
// 按内容/字号归类：含 作/词/曲/编/译 → 著作者 credit；最大字号且较居中的中文行 → 标题。
import type { Binary, Component } from "./types";
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
}

interface HLine { text: string; charH: number; cx: number; cy: number; n: number; }

// 大调主音字母 → 五度圈数（自然，无升降）。降号 -7、升号 +7。
const NAT_FIFTHS: Record<string, number> = { C: 0, D: 2, E: 4, F: -1, G: 1, A: 3, B: 5 };

/** 从页眉小字区解析调号("1=♭B")与速度("♩=76")。OCR 常把 ♭→b、♩→J；页眉碎片散落，
 *  故按碎片就地匹配、必要时空间最近邻配对，避免跨列拼接误配。 */
function parseMeta(lines: HLine[]): { fifths?: number; tempo?: number } {
  const res: { fifths?: number; tempo?: number } = {};
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
    if (acc) { const f = toFifths(acc[2], acc[1]); if (f !== undefined) { res.fifths = f; break; } }
    // 自然调："1=G"/"1=C4"(4 来自拍号)。音名后须非升降号(否则属上面的带号情形)、非小写字母。
    const nat = l.text.match(/1\s*[=＝]\s*([A-G])(?![b#♭♯a-z])/);
    if (nat && nat[1] in NAT_FIFTHS) { res.fifths = NAT_FIFTHS[nat[1]]; break; }
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
      if (best) { const f = toFifths(best.text.trim()[0], a.text.trim()); if (f !== undefined) { res.fifths = f; break; } }
    }
  }

  // 速度：含 "=NN" 的碎片（♩/J 常与数字同块，如 "J=76"）。
  for (const l of lines) {
    const t = l.text.match(/[=＝]\s*(\d{2,3})\b/);
    if (t) { const bpm = parseInt(t[1], 10); if (bpm >= 30 && bpm <= 300) { res.tempo = bpm; break; } }
  }
  return res;
}

/** 识别页眉信息。firstStaffTopY = 第一乐谱行顶部 y；只看其上方区域。 */
export async function recognizeHeader(
  bin: Binary, comps: Component[], firstStaffTopY: number, numH: number, ocr: OcrBackend,
): Promise<HeaderInfo> {
  const out: HeaderInfo = { credits: [] };
  if (!ocr.recognizeTexts || firstStaffTopY < numH) return out;
  const recognizeTexts = ocr.recognizeTexts.bind(ocr);

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
    const lines: HLine[] = meta.map((g) => ({ text: "", charH: median(g.map((k) => k.bbox.h)) || numH, cx: median(g.map((k) => k.cx)), cy: median(g.map((k) => k.cy)), n: g.length }));
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

  // 标题字号明显更大(≥1.3×numH)，与正文小字分两层各自分块，避免按 y 黏连。
  const big = region.filter((c) => c.bbox.h >= numH * 1.3);
  const small = region.filter((c) => c.bbox.h < numH * 1.3);
  const lines = await ocrGroups([...splitBlocks(big), ...splitBlocks(small)]);

  // 归类：含 作/词/曲/编/译 且有冒号 → credits（清洗掉尾随的调号/页码杂项）；其余最大字号中文行作标题。
  const authorRe = /[作詞词曲編编譯译]/;
  let titleLine: HLine | null = null;
  for (const ln of lines) {
    const txt = ln.text.trim();
    if (authorRe.test(txt) && /[:：]/.test(txt)) {
      // "作曲：王丽玲1=bB4" → "作曲：王丽玲"：取 冒号前缀 + 紧随的中文名。
      const m = txt.match(/^(.*?[:：])\s*([一-鿿·]+)/);
      out.credits.push(m ? m[1] + m[2] : txt);
      continue;
    }
    if (hanziCount(txt) < 2) continue;            // 跳过页码/调号/速度等（数字/符号为主）
    if (!titleLine || ln.charH > titleLine.charH) titleLine = ln;  // 标题=最大字号中文行
  }
  if (titleLine) out.title = titleLine.text.trim();
  const meta = parseMeta(lines);
  out.fifths = meta.fifths;
  out.tempo = meta.tempo;
  return out;
}
