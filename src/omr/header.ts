// 简谱页眉(第一行乐谱之上)信息识别：标题、作词/作曲(及编/译)等。
// 复用歌词的"自然区域分块 rec"（lyrics.ts）：取页眉区连通块 → 按 y 分行 → 每行整体 rec →
// 按内容/字号归类：含 作/词/曲/编/译 → 著作者 credit；最大字号且较居中的中文行 → 标题。
import type { Binary, Component, Rect, TextRegion } from "./types";
import type { OcrBackend } from "./ocr";
import { mergeToChars, chunkCells, buildStrip } from "./lyrics";
import { surfaceFromBinary, type Surface } from "./surface";
import { clusterByY, median, overlapRatioX, overlapRatioY, unionRect, unionRects } from "./geom";
import { accidentalOf } from "./accidental";

const rcyOf = (r: Rect) => r.y + r.h / 2;
const hanziCount = (s: string) => (s.match(/[一-鿿]/g) || []).length;

export interface HeaderInfo {
  title?: string;
  /** 副标题：印在标题正下方、字号不大于标题、与标题居中对齐的那一行（多是曲名的英译，
   *  如「2146 奉献的心志在燃烧」下的 "The spirit of devotion is burning"）。
   *  → `Work.subtitles`（123 第二条 `T:`）、文本谱第二条标题行；.jpwabc 装不下，那一路会丢。 */
  subtitle?: string;
  /** 曲号：内联在标题前（「277 从前所珍爱」「557. …」）或单独印在标题同一排的一侧（旷野人声
   *  「不失足 … 17」、赞美诗歌 1717「1 … 圣哉三一」）。→ `Work.number`（123 `X:`）、诗歌本 `XL:`/`XR:`。 */
  number?: string;
  /** 曲号印在标题左边还是右边（内联前缀算左）。诗歌本文本谱据此选 `XL:`/`XR:`。 */
  numberSide?: "left" | "right";
  /** 著作者整行文本（如 "作词：叶薇心"），下游作为 credit 写入 WordsByAndMusicBy。 */
  credits: string[];
  /** 调号五度圈数（识别到 "1=♭B" 等时给出，否则 undefined→上游用默认 0）。 */
  fifths?: number;
  /** 速度（♩=NN），仅进 MusicXML（当前下游导入器不读 tempo，故不进 .jpwabc）。 */
  tempo?: number;
  /** 拍号分子/分母（识别到 "4/4" 等时给出，否则 undefined→上游用默认 4/4）。 */
  beats?: number;
  beatType?: number;
  /** 混合拍：页眉并排印着的**全部**拍号（"4/4 3/4 5/4"），首个即 beats/beatType。
   *  只印一个拍号时也给出（长度 1）。文本谱两家的头部都写得下多个拍号，.jpwabc 只写得下头一个。 */
  meters?: { beats: number; beatType: number }[];
  /** 拍号后面跟着的说明文字（"混合拍"），只在识别到时给出。 */
  meterNote?: string;
  /** 页眉文本的源图定位（识别模式按原位叠加）。 */
  regions: TextRegion[];
}

interface HLine { text: string; charH: number; cx: number; cy: number; n: number; bbox: Rect; chars?: { text: string; cx: number; x1?: number }[]; }

/**
 * 整句英文（副标题、英文著作者名）的词间空格：**按源图上真实的空白列**补，而不是靠 CTC 帧位
 * 算间距。早先另有一条按帧位间隙（右字左缘 − 左字右缘）判空格的路子，被同一个毛病拖垮：帧位是
 * 等宽量化的，`JohnLaudon` 的字母间隙就有 1 个基元与 2 个基元两档，而门是「>1.5 倍中位」——
 * 中位恰是 1 个基元时，2 个基元的那些全过，读成 `Joh n La ud on`。两条路合并成这一条。
 * 同一个毛病在整句英文上更明显（"It's justdifferent"、"T he spirit" 都是这么来的）；
 * 而谱面上词间那道白是实打实比字母间的白宽一截。
 *
 * 定界：把本行所有空白段按宽度排序，在**跳变最大处**切开，界取跳变两侧的中点（再要求
 * ≥0.12×行高，免得整行只有一个词时把字母间隙切出空格来）。落在界以上的空白，按它的位置
 * 找到左右两个字符，**两侧都是字母**才插空格——撇号/引号这类窄字形两边的白也很宽，
 * 但那儿不该有空格（"It's" 不能拆成 "It 's"）。
 */
/** 一行文本框里的空白列段：`[起列, 宽]`，按 x 序。两处判词间空当都用它。 */
function inkBlanks(bin: Binary, bbox: Rect): Array<[number, number]> {
  const y1 = Math.min(bin.h, bbox.y + bbox.h), x1 = Math.min(bin.w, bbox.x + bbox.w);
  const blanks: Array<[number, number]> = [];
  let s = -1;
  for (let x = Math.max(0, bbox.x); x < x1; x++) {
    let ink = false;
    for (let y = Math.max(0, bbox.y); y < y1; y++) if (bin.data[y * bin.w + x]) { ink = true; break; }
    if (!ink) { if (s < 0) s = x; }
    else if (s >= 0) { blanks.push([s, x - s]); s = -1; }
  }
  return blanks;
}

/** 第 i 个字与第 i+1 个字之间，谱面上**真有一道空当**吗？（≥1.6 倍于本行空白宽度的中位数）
 *  后缀式著作者的「名字 ↔ 职能词」之间：脚步印的是「盛晓玫 词曲」（有空当），
 *  沧海一声笑印的是「黄 霑作词、作曲」（名字里有空当、名字与职能之间没有）。rec 从不吐空格，
 *  照谱面原样输出就得回源图上量这一道。 */
function gapWideAt(bin: Binary, bbox: Rect, chars: { text: string; cx: number }[] | undefined, i: number): boolean {
  if (!chars || i < 0 || i + 1 >= chars.length) return false;
  const blanks = inkBlanks(bin, bbox);
  if (blanks.length < 3) return false;
  const med = median(blanks.map((b) => b[1])) || 1;
  const lo = chars[i].cx, hi = chars[i + 1].cx;
  return blanks.some(([bx, bw]) => bx + bw / 2 > lo && bx + bw / 2 <= hi && bw >= med * 1.6);
}

/** 中文标题的分句空当：「不怕劳累 不怕饥寒」「天不蓝了 水不清了」两半之间印着整整一字宽的白，
 *  rec 不吐空格。两道门：
 *  - **≥0.6 字高**：汉字的字间白本就只有 0.1~0.2 字高，这么宽只可能是有意排的空当；
 *  - **≥2 倍于本行字间白的中位数**：有的歌本整行拉开字距排（「赞 美 一 神」「因 有 主 同 在」），
 *    每道字间白都过得了第一道门，但它们彼此一样宽，不是分句——只有明显宽出一截的那道才算。
 *  「字间白」取每对相邻汉字之间最宽的那一道（字内偏旁之间的窄白不算）。
 *  只在两侧都是汉字时插，编号与标题之间（「1717 不怕…」）那道白不管——编号下游本来就要剥掉。 */
function recoverHanziGaps(bin: Binary, text: string, bbox: Rect, chars?: { text: string; cx: number }[]): string {
  const cs = [...text];
  if (!chars || chars.length !== cs.length || hanziCount(text) < 4) return text;
  const isHan = (c: string) => /[一-鿿]/.test(c);
  const pairGap = new Map<number, number>();              // 左字下标 → 两字之间最宽的白
  for (const [bx, bw] of inkBlanks(bin, bbox)) {
    const mid = bx + bw / 2;
    let i = -1;
    while (i + 1 < chars.length && chars[i + 1].cx < mid) i++;
    if (i >= 0 && i + 1 < cs.length && isHan(cs[i]) && isHan(cs[i + 1])) pairGap.set(i, Math.max(pairGap.get(i) ?? 0, bw));
  }
  if (pairGap.size < 3) return text;
  const med = median([...pairGap.values()]);
  const after = new Set([...pairGap].filter(([, w]) => w >= bbox.h * 0.6 && w >= med * 2).map(([i]) => i));
  return cs.map((c, i) => (after.has(i) ? c + " " : c)).join("");
}

function recoverSpacesByInk(bin: Binary, text: string, bbox: Rect, chars?: { text: string; cx: number }[]): string {
  if (!chars || chars.length !== [...text].length || !/[A-Za-z]{2}/.test(text)) return text;
  const blanks = inkBlanks(bin, bbox);
  if (blanks.length < 3) return text;
  const cs = [...text];
  const isLetter = (c: string) => /[A-Za-z]/.test(c);
  // 每道空白的左侧字符下标（右侧即 +1）。
  const leftOf = (bx: number, bw: number): number => {
    const mid = bx + bw / 2;
    let i = -1;
    while (i + 1 < chars.length && chars[i + 1].cx < mid) i++;
    return i;
  };
  // **切分门只在字母↔字母的空白上算**：括号、连字符、汉字冒号旁边的白又宽又不成比例
  // （"Assisi (1182- 1226)" 里 `(` 两侧的白比词间空白宽一截），把它们算进来，最大跳变就落在
  // 那处outlier上、门被抬到词间空白之上，整行一个空格都插不出来（15《赞美真神》的作词行）。
  // 只在这一类空白里找跳变，两簇（词内 / 词间）才分得开。够不着 3 道就退回全体。
  const ll = blanks.filter(([bx, bw]) => {
    const i = leftOf(bx, bw);
    return i >= 0 && i + 1 < cs.length && isLetter(cs[i]) && isLetter(cs[i + 1]);
  });
  const widths = [...new Set((ll.length >= 3 ? ll : blanks).map((b) => b[1]))].sort((a, b) => a - b);
  let cut = 0, jump = 0;
  for (let i = 0; i < widths.length - 1; i++) {
    if (widths[i + 1] - widths[i] >= jump) { jump = widths[i + 1] - widths[i]; cut = (widths[i] + widths[i + 1]) / 2; }
  }
  const thr = Math.max(cut, bbox.h * 0.12);
  const spaceAfter = new Set<number>();
  for (const [bx, bw] of ll) {
    if (bw < thr) continue;
    spaceAfter.add(leftOf(bx, bw));
  }
  return cs.map((c, i) => (spaceAfter.has(i) ? c + " " : c)).join("");
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
const unionBox = (cs: Component[]): Rect => unionRects(cs.map((c) => c.bbox));

/** 从页眉小字区解析调号("1=♭B")与速度("♩=76")。OCR 常把 ♭→b、♩→J；页眉碎片散落，
 *  故按碎片就地匹配、必要时空间最近邻配对，避免跨列拼接误配。 */
interface MetaInfo {
  fifths?: number; tempo?: number; beats?: number; beatType?: number;
  meters?: { beats: number; beatType: number }[]; meterNote?: string;
  fifthsLine?: HLine; tempoLine?: HLine; timeBBox?: Rect;
}

function parseMeta(lines: HLine[]): MetaInfo {
  const res: MetaInfo = {};
  const toFifths = (note: string, acc: string): number | undefined => {
    if (!(note in NAT_FIFTHS)) return undefined;
    let f = NAT_FIFTHS[note];
    if (acc === "b" || acc === "♭") f -= 7;
    else if (acc === "#" || acc === "♯") f += 7;
    return f >= -7 && f <= 7 ? f : undefined;
  };

  // 调号：先认单碎片内 "1=♭B" 或 "♭B"（升降号紧贴音名）；再认自然调 "1=G"（音名无升降号）。
  // 升降号**印在音名右上角**的写法（`1=E♭`）同样要认，但只在 `1=` 锚定的形里认——不带 `1=`
  // 的裸后缀形（"Ab"、"Fb"）在英文碎片里遍地都是，一放开就满页误判。
  for (const l of lines) {
    const acc = l.text.match(/1\s*[=＝]\s*([b#♭♯])\s*([A-G])/) || l.text.match(/([b#♭♯])\s*([A-G])(?![a-z])/);
    if (acc) { const f = toFifths(acc[2], acc[1]); if (f !== undefined) { res.fifths = f; res.fifthsLine = l; break; } }
    const post = l.text.match(/1\s*[=＝]\s*([A-G])\s*([b#♭♯])(?![a-z])/);
    if (post) { const f = toFifths(post[1], post[2]); if (f !== undefined) { res.fifths = f; res.fifthsLine = l; break; } }
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
  // 还有一路：调号与拍号并排印在**标题那一行**、且**不写 `1=`**（旷野人声那本：`F 6/8`、
  // `ᵇE 4/4`，OCR 连成 "F6/8"、"16bE4/4"）。带升降号的已被上面两条认下（`ᵇE` 里升降号紧贴
  // 音名）；单个音名没有任何前缀可认，只能靠**它右边紧跟着一个合法的斜杠拍号**定下来。
  // 音名前若是字母就不算（"16bE4/4" 的 E 前面是降号的 b，那种归上面那条），碎片也得够短
  // ——标题、英文副标题那些长碎片里恰好凑出 "E4/4" 的，不认。
  if (res.fifths === undefined) {
    for (const l of lines) {
      const t = l.text.replace(/\s+/g, "");
      if (t.length > 8) continue;
      // 升降号在音名右上角的（`E♭ 3/4`，det 读成 "Eb3/4"）一并认下：这一路本就靠「右边紧跟着
      // 一个合法拍号」定位，音名与拍号之间夹的那一个字符只可能是升降号（5《我今来就你》）。
      const m = t.match(/(?:^|[^A-Za-z])([A-G])([b#♭♯]?)(\d{1,2})[/／](\d{1,2})(?![0-9])/);
      if (!m || !(m[1] in NAT_FIFTHS)) continue;
      if (!validBeats(Number(m[3])) || !validBeatType(Number(m[4]))) continue;
      const f = m[2] ? toFifths(m[1], m[2]) : NAT_FIFTHS[m[1]];
      if (f === undefined) continue;
      res.fifths = f;
      res.fifthsLine = l;
      break;
    }
  }

  // 速度：含 "=NN" 的碎片（♩/J 常与数字同块，如 "J=76"）。
  for (const l of lines) {
    const t = l.text.match(/[=＝]\s*(\d{2,3})\b/);
    if (t) { const bpm = parseInt(t[1], 10); if (bpm >= 30 && bpm <= 300) { res.tempo = bpm; res.tempoLine = l; break; } }
  }

  // 混合拍：并排印着好几个竖排拍号（"4/4 3/4 5/4 混合拍"）。det 把上下两排各读成一行
  // （"1=D435" / "444混合拍"），先按这一路认；认不出再走单个拍号那条。
  // 同一碎片里并排写着几个斜杠式拍号（"1=A 3/4 4/4 混合拍"）先认这一路。
  const inline = parseInlineMeters(lines, res.fifthsLine);
  if (inline) {
    res.meters = inline.meters;
    res.beats = inline.meters[0]!.beats;
    res.beatType = inline.meters[0]!.beatType;
    res.meterNote = inline.note;
    res.timeBBox = inline.bbox;
    return res;
  }
  const mixed = parseMixedMeters(lines, res.fifthsLine);
  if (mixed) {
    res.meters = mixed.meters;
    res.beats = mixed.meters[0].beats;
    res.beatType = mixed.meters[0].beatType;
    res.meterNote = mixed.note;
    res.timeBBox = mixed.bbox;
    return res;
  }
  // 拍号：分子/分母。简谱常写成 "X/4"（或与调号同块 "1=C 2/4"）；OCR 偶把斜杠丢成空格或上下竖排。
  const tm = parseTime(lines, res.fifthsLine);
  if (tm) {
    res.beats = tm.beats; res.beatType = tm.beatType; res.timeBBox = tm.bbox;
    res.meters = [{ beats: tm.beats, beatType: tm.beatType }];
  }
  return res;
}

/** 合法拍号：分母为 2 的幂(2/4/8/16，偶含 1/2 拍 → beatType 2)，分子 1..16。 */
const validBeatType = (d: number) => d === 1 || d === 2 || d === 4 || d === 8 || d === 16;
const validBeats = (n: number) => n >= 1 && n <= 16;

/** 混合拍的并排拍号（谱面上「4/4 3/4 5/4 混合拍」这一串分数写在调号右边）。
 *  det 是按**行**切的，一整排分子连同调号读成一行（"1=D435"）、一整排分母连同说明文字读成
 *  下一行（"444混合拍"），谁跟谁配对全在 x 上——故按逐字 cx 就近配，没有字位时退回按序配。
 *  只在**两排都不止一个数字**时才走这条：单个拍号交给 parseTime（它还认斜杠式与调号同块的写法）。 */
function parseMixedMeters(lines: HLine[], fifthsLine?: HLine):
  { meters: { beats: number; beatType: number }[]; note?: string; bbox: Rect } | undefined {
  // 数字串：分子行取**末尾**的连续数字（前面是 "1=D" 之类的调号），分母行取**开头**的。
  const tailDigits = (l: HLine) => (/(\d{2,})\s*$/.exec(l.text.trim())?.[1] ?? "");
  const headDigits = (l: HLine) => (/^\s*(\d{2,})/.exec(l.text.trim())?.[1] ?? "");
  const digitsWithX = (l: HLine, s: string, fromTail: boolean) => {
    const ds = [...s];
    if (!l.chars?.length) return ds.map((d) => ({ d, cx: NaN }));
    const cxs = l.chars.filter((c) => /^\d$/.test(c.text)).map((c) => c.cx);
    const take = fromTail ? cxs.slice(-ds.length) : cxs.slice(0, ds.length);
    return ds.map((d, i) => ({ d, cx: take[i] ?? NaN }));
  };
  let best: { meters: { beats: number; beatType: number }[]; note?: string; bbox: Rect } | undefined;
  let bd = Infinity;
  for (const up of lines) for (const dn of lines) {
    if (up === dn) continue;
    // 分母那一排在分子这一排下面。**不能按行距卡**：det 给的两个框上下重叠得厉害
    // （分子行 y=130 高 76、分母行 y=153 高 67，中心只差 18px），够不着一个字高。
    const dy = dn.cy - up.cy;
    if (dy <= 0 || dn.bbox.y <= up.bbox.y || dy > 2.5 * up.charH) continue;
    if (overlapRatioX(up.bbox, dn.bbox) < 0.2) continue;               // 两排要大致对着
    const us = tailDigits(up), ds = headDigits(dn);
    if (us.length < 2 || us.length !== ds.length) continue;            // 只认多拍号；数量须对得上
    const un = digitsWithX(up, us, true), dnn = digitsWithX(dn, ds, false);
    const meters: { beats: number; beatType: number }[] = [];
    let bad = false;
    for (let i = 0; i < un.length && !bad; i++) {
      // 有字位就按 x 就近取分母，没有就按序取（两排数字个数已相等，按序是安全的兜底）。
      const pick = isNaN(un[i].cx) ? dnn[i]
        : dnn.reduce((a, b) => (Math.abs(b.cx - un[i].cx) < Math.abs(a.cx - un[i].cx) ? b : a));
      const n = Number(un[i].d), d = Number(pick.d);
      if (!validBeats(n) || !validBeatType(d)) { bad = true; break; }
      meters.push({ beats: n, beatType: d });
    }
    if (bad) continue;
    // 分母行数字后面剩下的短文字就是说明（"混合拍"）。长句不收，免把别的行当成说明。
    const rest = dn.text.trim().slice(ds.length).trim();
    const note = /^[^\d]{1,5}拍$/.test(rest) ? rest : undefined;
    const score = fifthsLine ? Math.abs(up.cy - fifthsLine.cy) : dy;
    if (score < bd) { bd = score; best = { meters, note, bbox: unionRect(up.bbox, dn.bbox) }; }
  }
  return best;
}

/** 一串数字与斜杠（"4/4"、"3/44/4"、"6/16"）解析成拍号序列。
 *  并排印的几个拍号被 OCR 连成一串时，分母与下一个分子之间没有分隔：`3/44/4` 里那个 "44"
 *  既可能是 44 也可能是「分母 4 + 下一个分子 4」。按「分母优先取一位；取一位后剩下的必须仍是
 *  `数字+斜杠` 开头或正好取完」定夺，`6/16` 这种真两位分母也照样认得下。 */
function parseMeterRun(run: string): { beats: number; beatType: number }[] | null {
  const out: { beats: number; beatType: number }[] = [];
  let i = 0;
  while (i < run.length) {
    const m = /^(\d{1,2})[/／]/.exec(run.slice(i));
    if (!m) return null;
    const n = Number(m[1]);
    if (!validBeats(n)) return null;
    i += m[0].length;
    let d = -1;
    for (const len of [1, 2]) {
      const t = run.slice(i, i + len);
      if (t.length !== len) continue;
      const v = Number(t);
      if (!validBeatType(v)) continue;
      const rest = run.slice(i + len);
      if (rest && !/^\d{1,2}[/／]/.test(rest)) continue;  // 剩下的接不上下一个拍号 → 分母该取长的
      d = v; i += len; break;
    }
    if (d < 0) return null;
    out.push({ beats: n, beatType: d });
  }
  return out.length ? out : null;
}

/** 并排印在同一碎片里的多个斜杠式拍号（`1=A 3/4 4/4 混合拍` → OCR "1=A3/44/4混合拍"）。
 *  det 把整行读成一块时 parseMixedMeters（分子分母分两行）无从下手，而 parseTime 的单个
 *  "数/数" 正则在 `3/44/4` 上会把分母读成 44、判为非法拍号后**整行放弃** → 退回默认 4/4
 *  （迦南诗选《主是》《祷告》全曲小节都对不上）。这里专认「一串里不止一个拍号」的情形。 */
function parseInlineMeters(lines: HLine[], fifthsLine?: HLine):
  { meters: { beats: number; beatType: number }[]; note?: string; bbox: Rect } | undefined {
  for (const l of lines) {
    const t = l.text.replace(/\s+/g, "");
    for (const m of t.matchAll(/[\d/／]+/g)) {
      const run = m[0];
      if (!/[/／]/.test(run)) continue;
      const meters = parseMeterRun(run);
      if (!meters || meters.length < 2) continue;          // 单个拍号仍交给 parseTime
      const rest = t.slice(m.index! + run.length);
      const note = /^[^\d]{1,5}拍/.test(rest) ? /^([^\d]{1,5}拍)/.exec(rest)![1] : undefined;
      // 与调号同碎片时 bbox 偏到行右侧，免得标注压在 "1=A" 上（同 parseTime）。
      const bbox = l === fifthsLine
        ? { x: l.bbox.x + l.bbox.w * 0.3, y: l.bbox.y, w: l.bbox.w * 0.7, h: l.bbox.h }
        : l.bbox;
      return { meters, note, bbox };
    }
  }
  return undefined;
}

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
    if (score < bd) { bd = score; best = { beats: n, beatType: d, bbox: unionRect(a.bbox, b.bbox) }; } // bbox 跨分子+分母
  }
  return best;
}

/** 把"同一字列里上下紧贴的碎块"竖向合并成整字高复合块。用于页眉粗体标题：复杂字(督/赢)的上下
 *  偏旁会断成多个半截连通块。条件：x 向高度重叠(同列) + 竖向近乎相接(非整行行距)。返回新连通块集
 *  (未被并的原样保留；被并的取并集包围盒，cx/cy 取包围盒中心——仅用于分层/裁剪定位，足够)。 */
function mergeStackedColumns(comps: Component[], numH: number): Component[] {
  const boxes = comps.map((c) => ({ ...c.bbox }));
  const alive = boxes.map(() => true);
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < boxes.length; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < boxes.length; j++) {
        if (!alive[j]) continue;
        const a = boxes[i], b = boxes[j];
        const top = a.y <= b.y ? a : b, bot = a.y <= b.y ? b : a;
        const gap = bot.y - (top.y + top.h);          // <0 表示竖向有重叠
        if (overlapRatioX(a, b) < 0.35 || gap > numH * 0.35) continue; // 非同列、或隔了整行行距 → 不并
        const nb = unionRect(a, b);
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
  geoMeters?: { beats: number; beatType: number; bbox: Rect }[],
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
      await classify(lines);
      return out;
    }
  }

  // 页眉区字号大小的连通块。
  const region = comps.filter((c) => {
    const b = c.bbox; const cy = b.y + b.h / 2;
    return cy < firstStaffTopY - numH * 0.1 && b.h >= numH * 0.4 && b.w >= numH * 0.2;
  });
  if (!region.length) return out;

  const src = surfaceFromBinary(bin);
  // 行 = 一组连通块；整体 rec（自然区域分块）。返回 {text,charH,cx,cy,n}。
  const ocrGroups = async (gs: Component[][]): Promise<HLine[]> => {
    const meta: Component[][] = [], strips: Surface[] = [], owner: number[] = [];
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
    // 0.6×numH：页眉是小字（比歌词/音符小），行距也更紧，容差比歌词那边(0.7)略严。
    const yRows = clusterByY(cs, (c) => c.cy, numH * 0.6);
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

  await classify(lines);
  return out;

  // 归类：以 作/词/曲/编/译 开头紧跟冒号(作词：/词曲：…) → credits；其余最大字号中文行作标题。
  // 著作者前缀须**行首**紧贴冒号——否则长句经文副标题("…正如他作更美之约…来8：6")也会因含"作"+"："被误判。
  /** 把 `1=<残字><音名>` 里的残字按形状改写成 `b`/`#`。改了返回 true。
   *  定位靠 det/CTC 给的逐字位：残字的 cx 附近那个连通块就是升降号本体（页眉里 `=` 的两横、
   *  音名字母各是独立的块，取**离它最近**的那个即可）。找不到块或形状判不出就原样不动。 */
  function repairKeyAccidental(ls: HLine[]): boolean {
    let fixed = false;
    for (const l of ls) {
      if (!l.chars?.length) continue;
      const m = l.text.match(/1\s*[=＝]\s*([^A-Ga-g0-9\s])\s*([A-G])(?![a-z])/);
      if (!m) continue;
      const idx = l.text.indexOf(m[1], l.text.indexOf(m[0]));
      const ch = l.chars[idx];
      if (!ch) continue;
      // 页眉里的块：落在本行框内（上下各放半个字高，上标本就骑得高）、且不比整行还宽。
      let best: Component | null = null, bd = Infinity;
      for (const k of comps) {
        const b = k.bbox;
        if (b.y > l.bbox.y + l.bbox.h || b.y + b.h < l.bbox.y - l.bbox.h * 0.5) continue;
        if (b.w > l.bbox.h || b.h > l.bbox.h) continue;      // 音名/数字那种整字大小的块不算
        const d = Math.abs(b.x + b.w / 2 - ch.cx);
        if (d < bd) { bd = d; best = k; }
      }
      if (!best || bd > l.bbox.h) continue;
      const kind = accidentalOf(bin, best.bbox);
      if (kind !== "flat" && kind !== "sharp") continue;
      l.text = l.text.slice(0, idx) + (kind === "flat" ? "b" : "#") + l.text.slice(idx + m[1].length);
      fixed = true;
    }
    return fixed;
  }

  /** 调号的音名整个读丢了时，回源图上**单独重读**。1697《温州的水 温州的山》印的是 `1=♭B`，♭ 与 B
   *  都是上标小字，det 把「1 = ♭B 4/4 ♩=95」切成一行，行高照大号的「1」算，两个小字缩下去只剩
   *  一个 `b`（`1=b4J=95`），parseMeta 与 repairKeyAccidental 都无从下手，整曲落回 C。
   *  做法：`=` 的两道横右边**紧挨着**的几块墨（碰到比字宽还大的空当就停，后面是拍号/速度）。
   *  其中位置明显偏高、形状判得出 ♭/♯ 的是升降号（accidentalOf），其余是音名——单独裁出来送 rec，
   *  这回行高就是音名自己的高度。读不出 A–G 就原样放弃。返回五度圈数与所在行。 */
  async function rereadKeyName(ls: HLine[]): Promise<{ fifths: number; line: HLine } | undefined> {
    const line = ls.find((l) => /[1１]\s*[=＝]/.test(l.text));
    if (!line || !ocr.recognizeTexts) return undefined;
    const lb = line.bbox;
    const band = comps
      .filter((k) => rcyOf(k.bbox) >= lb.y && rcyOf(k.bbox) <= lb.y + lb.h && k.bbox.x >= lb.x && k.bbox.x + k.bbox.w <= lb.x + lb.w)
      .sort((a, b) => a.bbox.x - b.bbox.x);
    // `=`：两道扁横，上下叠着、左右对齐
    const bars = band.filter((k) => k.bbox.w >= k.bbox.h * 2.5 && k.bbox.h <= lb.h * 0.15);
    const eq = bars.find((a) => bars.some((b) => b !== a && overlapRatioX(a.bbox, b.bbox) >= 0.6 &&
      Math.abs(rcyOf(a.bbox) - rcyOf(b.bbox)) <= lb.h * 0.3));
    if (!eq) return undefined;
    const eqRight = Math.max(...bars.filter((b) => overlapRatioX(eq.bbox, b.bbox) >= 0.6).map((b) => b.bbox.x + b.bbox.w));
    const group: Component[] = [];
    for (const k of band) {
      if (k.bbox.x < eqRight || bars.includes(k)) continue;
      const last = group[group.length - 1];
      if (last) {
        const gh = Math.max(...group.map((g) => g.bbox.h));
        if (k.bbox.x - (last.bbox.x + last.bbox.w) > Math.max(4, gh * 0.6)) break;
      } else if (k.bbox.x - eqRight > lb.h) break;                       // 离 `=` 太远：不是音名
      group.push(k);
      if (group.length > 3) return undefined;
    }
    const k = await readKeyGroup(group);
    return k ? { fifths: k.fifths, line } : undefined;
  }

  /** 读一组紧挨着的调号块（音名 + 可选升降号，1~3 块）：位置明显偏高、形状判得出 ♭/♯ 的是升降号
   *  （accidentalOf），其余拼成一条单独送 rec——行高就是音名自己的高度。rec 连着升降号一起读出来
   *  （`bB`、`Eb`）也收。读不出 A–G 就放弃。 */
  async function readKeyGroup(group: Component[]): Promise<{ fifths: number; bbox: Rect } | undefined> {
    if (!group.length || !ocr.recognizeTexts) return undefined;
    // 升降号：上标印得高——底边比其余块的底边高出两成字高以上，且形状判得出 ♭/♯
    const lowest = Math.max(...group.map((g) => g.bbox.y + g.bbox.h));
    let acc = "";
    let letters = group;
    for (const g of group) {
      const lh = Math.max(...group.filter((o) => o !== g).map((o) => o.bbox.h), 0);
      if (!lh || lowest - (g.bbox.y + g.bbox.h) < lh * 0.2) continue;
      const kind = accidentalOf(bin, g.bbox);
      if (kind !== "flat" && kind !== "sharp") continue;
      acc = kind === "flat" ? "b" : "#";
      letters = group.filter((o) => o !== g);
      break;
    }
    const [text] = await recognizeTexts([buildStrip(surfaceFromBinary(bin), [unionRects(letters.map((g) => g.bbox))])]);
    const m = /^\s*([b#♭♯]?)\s*([A-G])\s*([b#♭♯]?)\s*$/.exec(text ?? "");
    if ((globalThis as { __omrDebug?: boolean }).__omrDebug) console.log("[header/keyGroup]", JSON.stringify(text), acc, group.map((g) => `${g.bbox.x},${g.bbox.y} ${g.bbox.w}x${g.bbox.h}`).join(" | "));
    if (!m) return undefined;
    const a = acc || m[1] || m[3];
    const f = NAT_FIFTHS[m[2]] + (a === "b" || a === "♭" ? -7 : a === "#" || a === "♯" ? 7 : 0);
    return f >= -7 && f <= 7 ? { fifths: f, bbox: unionRects(group.map((g) => g.bbox)) } : undefined;
  }

  /** 调号的**单字符兜底**：det 连 `1=` 那一行都没检出来时（耶稣普治 `1 = D`：页宽 2000px 缩到 960，
   *  小字宽字距只剩一个读空的碎框），不再指望文本行，直接在页眉的连通块里按位置关系找。
   *  版式（testdata + 旷野人声/迦南诗选抽检）：调号总在第一谱行之上、**标题中线左侧**，
   *  从左到右「`1` `=`」「上标升降号 + 音名」「拍号」「♩=速度」。两个锚点：
   *  - **`=`**：两道上下对齐的扁横，左边紧挨一个读得出 1 的块——`二`/`三` 的横笔、`♩=95` 的 `=` 都靠这一条挡掉；
   *    音名组取 `=` 右侧紧挨着的块。
   *  - **拍号**：几何法认出的页眉分数拍号（geoMeters），音名组取它左侧紧挨着的块（不写 `1=` 的谱）。 */
  /** 斜杠 `/`：墨集中在右上—左下那条对角带上（左上、右下两角基本空着）。 */
  function isSlash(b: Rect): boolean {
    let diag = 0, off = 0;
    for (let y = Math.round(b.y); y < Math.round(b.y + b.h); y++) {
      for (let x = Math.round(b.x); x < Math.round(b.x + b.w); x++) {
        if (!bin.data[y * bin.w + x]) continue;
        const u = (x - b.x) / Math.max(1, b.w - 1), v = (y - b.y) / Math.max(1, b.h - 1);
        if (Math.abs(u + v - 1) <= 0.35) diag++; else off++;
      }
    }
    return diag >= 8 && off <= diag * 0.15;
  }

  async function keyByGlyphs(titleLine: HLine | null): Promise<{ fifths: number; bbox: Rect } | undefined> {
    const xMax = titleLine ? titleLine.cx : bin.w / 2;
    const yMin = titleLine ? titleLine.bbox.y : 0, yMax = firstStaffTopY - numH * 0.1;
    const inMeter = (k: Component) => !!geoMeters?.some((m) => overlapRatioX(m.bbox, k.bbox) > 0.5 &&
      rcyOf(k.bbox) >= m.bbox.y && rcyOf(k.bbox) <= m.bbox.y + m.bbox.h);
    const pool = comps
      .filter((k) => rcyOf(k.bbox) >= yMin && rcyOf(k.bbox) <= yMax && k.cx < xMax && k.bbox.h <= numH * 2 && k.bbox.w <= numH * 2)
      .sort((a, b) => a.bbox.x - b.bbox.x);
    const isBar = (k: Component) => k.bbox.w >= k.bbox.h * 2.5 && k.bbox.h <= numH * 0.25 && k.bbox.w >= numH * 0.2 && k.bbox.w <= numH * 1.2;
    const bars = pool.filter(isBar);
    const dbg = (globalThis as { __omrDebug?: boolean }).__omrDebug;
    /** 从 `from` 起沿 dir 方向取紧挨着的块（1~3 块），碰到横线、拍号块或比字宽还大的空当就停。 */
    const chain = (edge: number, dir: 1 | -1, band: Rect, firstGap: number): Component[] => {
      const cands = pool
        .filter((k) => !isBar(k) && !inMeter(k) && (dir > 0 ? k.bbox.x >= edge : k.bbox.x + k.bbox.w <= edge))
        .filter((k) => k.bbox.y <= band.y + band.h && k.bbox.y + k.bbox.h >= band.y)
        .sort((a, b) => dir * (a.bbox.x - b.bbox.x));
      const group: Component[] = [];
      let cur = edge;
      for (const k of cands) {
        const gap = dir > 0 ? k.bbox.x - cur : cur - (k.bbox.x + k.bbox.w);
        const gh = group.length ? Math.max(...group.map((g) => g.bbox.h)) : 0;
        if (gap > (group.length ? Math.max(4, gh * 0.6) : firstGap)) break;
        group.push(k);
        cur = dir > 0 ? Math.max(cur, k.bbox.x + k.bbox.w) : Math.min(cur, k.bbox.x);
        if (group.length > 3) return [];
      }
      return dir > 0 ? group : group.reverse();
    };

    // 锚点一：`1` `=`（音名在右）；也有反着印的 `C=1`（从前所珍爱，音名在左、`1` 在右）
    for (const a of bars) for (const b of bars) {
      const dy = rcyOf(b.bbox) - rcyOf(a.bbox);
      if (a === b || dy <= 0 || dy > numH * 0.5 || overlapRatioX(a.bbox, b.bbox) < 0.6) continue;
      const eq = unionRect(a.bbox, b.bbox);
      for (const dir of [1, -1] as const) {
        const gapTo = (k: Component) => (dir > 0 ? eq.x - (k.bbox.x + k.bbox.w) : k.bbox.x - (eq.x + eq.w));
        const one = pool
          .filter((k) => !isBar(k) && gapTo(k) >= -1 && gapTo(k) <= numH * 0.8 &&
            k.bbox.h >= numH * 0.4 && rcyOf(eq) >= k.bbox.y && rcyOf(eq) <= k.bbox.y + k.bbox.h && k.bbox.w <= k.bbox.h * 0.75)
          .sort((p, q) => gapTo(p) - gapTo(q))[0];
        if (dbg) console.log("[header/keyEq]", dir > 0 ? "1=" : "=1", `eq ${eq.x},${eq.y} ${eq.w}x${eq.h}`, one ? `one ${one.bbox.x},${one.bbox.y} ${one.bbox.w}x${one.bbox.h}` : "no-one", `numH ${numH.toFixed(1)}`);
        if (!one) continue;
        const [d] = await ocr.recognizeDigits(bin, [one.bbox]);
        if (d !== 1) continue;
        const group = dir > 0 ? chain(eq.x + eq.w, 1, one.bbox, Math.max(numH, one.bbox.h))
          : chain(eq.x, -1, one.bbox, Math.max(numH, one.bbox.h));
        const k = await readKeyGroup(group);
        if (k) return k;
      }
    }
    // 锚点二：拍号左边紧挨着的音名（不写 `1=` 的谱：`♭E 4/4`、`E♭ 3/4`）。
    // 拍号两种印法：几何法认出的分数拍号（geoMeters），与斜杠式——一块斜笔、左右各紧挨一个数字大小的块。
    const starts: { x: number; band: Rect; what: string }[] = [];
    for (const m of geoMeters ?? []) {
      if (rcyOf(m.bbox) < yMin || rcyOf(m.bbox) > yMax || m.bbox.x + m.bbox.w / 2 > xMax) continue;
      starts.push({ x: m.bbox.x, band: { x: m.bbox.x, y: m.bbox.y + m.bbox.h * 0.2, w: m.bbox.w, h: m.bbox.h * 0.6 }, what: `${m.beats}/${m.beatType}` });
    }
    for (const sl of pool) {
      const sb = sl.bbox;
      if (sb.h < numH * 0.4 || sb.w > sb.h * 0.8 || !isSlash(sb)) continue;
      const side = (dir: 1 | -1) => pool.filter((k) => k !== sl && !isBar(k) &&
        (dir > 0 ? k.bbox.x - (sb.x + sb.w) : sb.x - (k.bbox.x + k.bbox.w)) >= -2 &&
        (dir > 0 ? k.bbox.x - (sb.x + sb.w) : sb.x - (k.bbox.x + k.bbox.w)) <= numH * 0.5 &&
        k.bbox.h >= sb.h * 0.5 && k.bbox.h <= sb.h * 1.5 && overlapRatioY(k.bbox, sb) >= 0.5)
        .sort((p, q) => dir * (p.bbox.x - q.bbox.x))[0];
      const l = side(-1), r = side(1);
      if (dbg) console.log("[header/keySlash]", `${sb.x},${sb.y} ${sb.w}x${sb.h}`, l ? "L" : "-", r ? "R" : "-");
      if (!l || !r) continue;
      starts.push({ x: l.bbox.x, band: unionRect(l.bbox, r.bbox), what: "slash" });
    }
    for (const st of starts.sort((a, b) => a.x - b.x)) {
      const group = chain(st.x, -1, st.band, numH);
      if (dbg) console.log("[header/keyMeter]", st.what, `@${st.x}`, group.length);
      const k = await readKeyGroup(group);
      if (k) return k;
    }
    return undefined;
  }

  /** 后缀式著作者的「名字 ↔ 职能词」之间照谱面补空当：`at` 是职能词在 `text` 里的起始下标，
   *  `charAt` 是它在 OCR 原始字位里的下标（文本补过空格时两者不同，默认相同）。
   *  **写成函数声明**：`classify` 在它下面、却先被调用，写成 const 会撞 TDZ。 */
  function spaceIfGap(text: string, at: number, ln: HLine, charAt = at): string {
    const chars = ln.chars && ln.chars.length === [...text].filter((c) => c !== " ").length ? ln.chars : undefined;
    return gapWideAt(bin, ln.bbox, chars, charAt - 1)
      ? `${text.slice(0, at).trimEnd()} ${text.slice(at)}` : text;
  }

  /** 单独印在标题同一排一侧的曲号（旷野人声「不失足 … 17」、迦南诗选「1　带着你的欢笑」）。
   *  判据：纯数字 1~4 位、与标题同一排（上下重叠 ≥0.3：印在右上角的常比标题高出半截，
   *  《我今来就你》的「5」只重叠 0.48）、字高不低于标题一半——《》后面那个小号出处数字（「《旷》108」
   *  已并在标题框里）和页脚页码都过不了这两条。det 给了独立框就用它；det 把它整个漏了的
   * （赞美诗歌 1717《圣哉三一》左边那个细长的「1」，det 一个框都没给）回源图找：同一排、不在任何
   *  det 框里、够高的连通块，按横向间隙聚组后逐组 rec，读出纯数字才算。 */
  async function standaloneNumber(tl: HLine, ls: HLine[]): Promise<{ text: string; bbox: Rect } | undefined> {
    const sameRow = (b: Rect, h: number) => overlapRatioY(b, tl.bbox) >= 0.3 && h >= tl.charH * 0.5 &&
      (b.x >= tl.bbox.x + tl.bbox.w || b.x + b.w <= tl.bbox.x);
    const byDist = (a: Rect, b: Rect) => Math.abs(a.x + a.w / 2 - tl.cx) - Math.abs(b.x + b.w / 2 - tl.cx);
    const det = ls.filter((l) => l !== tl && /^\s*\d{1,4}\s*[.．、]?\s*$/.test(l.text) && sameRow(l.bbox, l.charH))
      .sort((a, b) => byDist(a.bbox, b.bbox))[0];
    if (det) return { text: det.text.replace(/\D/g, ""), bbox: det.bbox };
    // 曲号与不写 `1=` 的调号拍号挨着印，det 并成一行（旷野人声 16《爱心的功课》：`16bE4/4`）：
    // 行首数字后面**紧跟升降号或音名**才算曲号——`1=C`、`3/4` 的数字后面是 `=`、`/`，挨不上。
    for (const l of ls) {
      if (l === tl || !sameRow(l.bbox, l.charH)) continue;
      const m = /^\s*(\d{1,4})\s*(?=[b#♭♯]?[A-G](?![a-z]))/.exec(l.text);
      if (!m || m[1].split("").some((_, i) => meterInkAt(l, i))) continue;
      // 叠加框只框数字那段：右界取末位数字与下一个字的逐字位中点（逐字位对不上就框整行）
      const off = l.text.length - l.text.trimStart().length, k = off + m[1].length;
      const cs = l.chars && l.chars.length === l.text.length ? l.chars : undefined;
      const x1 = cs && k < cs.length ? (cs[k - 1].cx + cs[k].cx) / 2 : l.bbox.x + l.bbox.w;
      return { text: m[1], bbox: { ...l.bbox, w: Math.max(1, x1 - l.bbox.x) } };
    }
    const inDet = (b: Rect) => ls.some((l) => overlapRatioX(b, l.bbox) > 0 && overlapRatioY(b, l.bbox) > 0);
    const cs = comps.filter((c) => sameRow(c.bbox, c.bbox.h) && !inDet(c.bbox)).sort((a, b) => a.bbox.x - b.bbox.x);
    const groups: Component[][] = [];
    for (const c of cs) {
      const g = groups[groups.length - 1], last = g?.[g.length - 1];
      if (last && c.bbox.x - (last.bbox.x + last.bbox.w) <= tl.charH * 0.5) g.push(c);
      else groups.push([c]);
    }
    const cands = groups.map((g) => ({ g, bbox: unionRects(g.map((k) => k.bbox)) }))
      .filter(({ bbox }) => bbox.w <= tl.charH * 3.2)
      .sort((a, b) => byDist(a.bbox, b.bbox));
    if (!cands.length) return undefined;
    const src = surfaceFromBinary(bin);
    const texts = await recognizeTexts(cands.map(({ g }) => buildStrip(src, mergeToChars(g, tl.charH))));
    for (let i = 0; i < cands.length; i++) {
      const t = texts[i].trim();
      if (/^\d{1,4}$/.test(t)) return { text: t, bbox: cands[i].bbox };
    }
    return undefined;
  }

  /** 行里第 i 个字的墨是不是已被几何法认成了拍号（`geoMeters`：分数线上下各贴一个数字）。 */
  function meterInkAt(ln: HLine, i: number): boolean {
    const off = ln.text.length - ln.text.trimStart().length;
    const ch = ln.chars && ln.chars.length === ln.text.length ? ln.chars[off + i] : undefined;
    return !!ch && (geoMeters ?? []).some((m) => ch.cx >= m.bbox.x && ch.cx <= m.bbox.x + m.bbox.w && overlapRatioY(m.bbox, ln.bbox) > 0.5);
  }

  async function classify(ls: HLine[]) {
    // 著作者前缀：`作词：`/`词曲：`，也含顿号/斜杠分列的 `词、曲：`、`作词/作曲：`。
    const creditRe = /^\s*[作詞词曲編编譯译]{1,2}(?:\s*[、，,/／]\s*[作詞词曲編编譯译]{1,2})*\s*[:：]/;
    // 后缀式著作者：中文谱很常见把职能写在名字**后面**、且不带冒号——"盛晓玫 词曲"、
    // "卢永亨词曲"、"黄霑作词、作曲"。前缀式一条都认不出（实测 4 首词曲整档 0 分）。
    // 判据是整行恰好等于「人名(2~4 字，可顿号并列) + 职能词组」。**认出来后照谱面原样输出**
    // （从前归一成 `<职能>：<名字>`）：谱面怎么印就怎么写，不调换次序、不补分隔符——
    // "黄 霑作词、作曲" 那种名字与职能之间本就没有空当，补一个反倒不是原样。
    // 要求**不是最大字号行**，免得短标题被当成著作者、连标题一起丢掉。
    // 名字组**非贪婪**、职能组锚定行尾：贪婪会把「卢永亨词曲」的「词」吃进名字、只剩「曲」→
    // 出成 `作曲：卢永亨词`。非贪婪 + `$` 让引擎先给名字最短长度，回溯到「卢永亨」+「词曲」。
    // 职能词之间的分隔符**可选**：既有「作词、作曲」也有连写的「词曲」，后者若强求分隔符，
    // 职能组只吃得下一个字，剩下那个会被名字回溯吞掉（→ `作曲：卢永亨词`）。
    const creditSuffixRe = /^\s*([一-鿿·]{2,4}?(?:\s*[、，,]\s*[一-鿿·]{2,4}?)*)\s*((?:[作編编]?[詞词曲])(?:\s*[、，,/／]?\s*(?:[作編编]?[詞词曲]))*)\s*$/;
    // 后缀式著作者的名字也可能是**英文名**——"John Laudon 词曲"（1《以色列的圣者》）。上面那条
    // 正则的名字组只收汉字，整行就落到"非著作者行"里、词曲整档为空。故另走一条：先按行尾的
    // 职能词组切开，剩下的前半必须是**纯拉丁名**（字母 + 空格/点/连字符之类），再按字距补回
    // 词间空格（rec 不吐空格，读出来是 `JohnLaudon词曲`）。名字里但凡有个汉字就不走这条，
    // 仍归上面那条中文名规则，两条互不重叠。
    const creditRoleTailRe = /((?:[作編编]?[詞词曲])(?:\s*[、，,/／]?\s*(?:[作編编]?[詞词曲]))*)\s*$/;
    // 名字里还可能带生卒/出版年份与括号（"Felice de Giardini (1769) 曲"），故收数字与括号；
    // 但**必须以字母打头**——纯数字/符号的短碎块（页码、调号）不会被当成人名。
    const latinNameRe = /^[A-Za-z][A-Za-z0-9 .,'’&·()（）\-]*$/;
    const maxCharH = Math.max(0, ...ls.map((l) => l.charH));
    let titleLine: HLine | null = null;
    const rest: HLine[] = [];
    for (const ln of ls) {
      const txt = ln.text.trim();
      const sm = ln.charH < maxCharH ? creditSuffixRe.exec(txt) : null;
      if (sm && !creditRe.test(txt)) {
        // 名字与职能词之间谱面上有没有空当，回源图量（rec 从不吐空格）：脚步是「盛晓玫 词曲」，
        // 沧海一声笑是「黄 霑作词、作曲」——一个有一个没有，只能按墨列判。
        const at = txt.length - sm[2].length;                 // 职能词组的起始字符下标
        const cr = spaceIfGap(txt, at, ln);
        out.credits.push(cr);
        out.regions.push({ text: cr, bbox: ln.bbox, chars: charsForText(cr, ln.chars) });
        continue;
      }
      // 英文名同样照原样输出（"John Laudon词曲"），只把 rec 吞掉的**词间空格**补回来。
      // 空格按**源图真实空白列**补（`recoverSpacesByInk`），不走 CTC 帧位那条：这一行的
      // 帧位间隙量化成 1/2/4 个基元，字母内就有 2 个基元的（`Joh|n`、`La|u|d|on`），
      // 而 `recoverLatinSpaces` 的门是「>1.5 倍中位」——中位恰好是 1 个基元时那些全过，
      // 读成 `Joh n La ud on`。真空白只有词间那一处，按墨列量一眼就分得开。
      const lm = !sm && ln.charH < maxCharH && !creditRe.test(txt)
        ? creditRoleTailRe.exec(recoverSpacesByInk(bin, txt, ln.bbox, ln.chars)) : null;
      if (lm) {
        const name = lm.input.slice(0, lm.index).trim();
        if (latinNameRe.test(name) && /[A-Za-z]{2}/.test(name)) {
          // 下标要换算回**没补空格前**的字符序，才对得上 chars（补出来的空格没有字形）。
          const at = [...lm.input.slice(0, lm.index)].filter((c) => c !== " ").length;
          const cr = spaceIfGap(lm.input, lm.index, ln, at);
          out.credits.push(cr);
          out.regions.push({ text: cr, bbox: ln.bbox, chars: charsForText(cr, ln.chars) });
          continue;
        }
      }
      if (creditRe.test(txt)) {
        // "作曲：王丽玲1=bB4" → "作曲：王丽玲"：取 冒号前缀 + 紧随的中文名（英文名则整行保留）。
        // 名字可由顿号并列多人（"词、曲：游智婷、曾祥怡"）。
        const m = txt.match(/^(.*?[:：])\s*([一-鿿·]+(?:\s*[、，,]\s*[一-鿿·]+)*)/);
        // 中文名取前缀+名；英文名整行保留、并按字距恢复词间空格（"IsaacWatts"→"Isaac Watts"）。
        // 著作者前缀的冒号统一成全角 `：`（.jpwabc 约定；中文名行 OCR 多已全角，英文名行常落半角）。
        const credit = (m ? m[1] + m[2] : recoverSpacesByInk(bin, txt, ln.bbox, ln.chars))
          .replace(/\s*[:：]\s*/, "：");
        out.credits.push(credit);
        out.regions.push({ text: credit, bbox: ln.bbox, chars: charsForText(credit, ln.chars) });
        continue;
      }
      rest.push(ln);                                // 非著作者行：标题、副标题、调号、页码…
      if (hanziCount(txt) < 2) continue;            // 跳过页码/调号/速度等（数字/符号为主）
      // 调号行也不当标题：`1=C 3/4 4/4 5/4 混合拍` 带着「混合拍」三个汉字能过上一道门，
      // 竖排拍号又把 det 框撑到两排字高（1717《不怕劳累 不怕饥寒》79px，真标题才 49px），
      // 按字号比一比就把标题顶掉了。
      if (/[1１]\s*[=＝]/.test(txt)) continue;
      // 标题 = 最大字号的中文行；**字号差不多（15% 以内）时取更宽的那一行**。det 给的框高
      // 只是个近似，同一本书里印在右上角的出版方（迦南诗选每页都印着「迦南诗歌」）会因框
      // 松紧不同，忽而比标题矮（2157：61 vs 77）、忽而比它高（2156：79 vs 68）——单看框高，
      // 2156 的标题就成了「迦南诗歌」。整行宽度在这里是压倒性的（892 vs 289），因为标题
      // 是一整句、出版方只有四个字。
      if (!titleLine) titleLine = ln;
      else if (ln.charH > titleLine.charH * 1.25) titleLine = ln;
      else if (ln.charH >= titleLine.charH * 0.85 && ln.bbox.w > titleLine.bbox.w) titleLine = ln;
    }
    let numberBox: Rect | undefined;
    if (titleLine) {
      // 曲号前缀（"277从前所珍爱"、"557. …"）拆出来进 number；尾巴上的出处标记照旧剥掉、**不当曲号**
      // （17《不失足》标题右边印着「《旷》108」——那是选自哪本诗集的第几首，不是曲名的一部分）。
      // 前缀后面必须紧跟汉字，免得「1=C」这类残片被拆。
      let t = recoverHanziGaps(bin, titleLine.text.trim(), titleLine.bbox, titleLine.chars);
      const pm = /^\s*(\d{1,4})\s*[.．、]?\s*(?=[一-鿿])/.exec(t);
      if (pm) {
        t = t.slice(pm[0].length);
        // 竖排拍号紧贴标题时会被 det 并进标题框（175《日光之上》读成 `4日光之上`，那个 4 是 4/4 的分子）：
        // 那块墨几何法已认成拍号（geoMeters），剥掉但不当曲号。
        if (!pm[1].split("").some((_, i) => meterInkAt(titleLine!, i))) { out.number = pm[1]; out.numberSide = "left"; }
      }
      out.title = t.replace(/\s*《[^》]{0,8}》\s*\d{0,4}\s*$/, "");
      out.regions.push({ text: out.title, bbox: titleLine.bbox, chars: charsForText(out.title, titleLine.chars) });
      if (!out.number) {
        const n = await standaloneNumber(titleLine, ls);
        if (n) {
          out.number = n.text; numberBox = n.bbox;
          out.numberSide = n.bbox.x + n.bbox.w / 2 < titleLine.cx ? "left" : "right";
          out.regions.push({ text: n.text, bbox: n.bbox });
        }
      }
    }
    let meta = parseMeta(ls);
    // 副标题：标题**正下方**、字号不大于标题、与标题居中对齐的那一行。
    //  - 居中对齐这一条是关键：页眉里印在两侧的东西（左边的 `1=C 4/4`、右上角每页都有的
    //    出版方「迦南诗歌」）与标题中心差得远，靠它一并挡掉。
    //  - 调号/速度/拍号即使居中也不能当副标题，故连同 parseMeta 认下的那两行一起排除。
    // 英文副标题按字距补回词间空格（det/CTC 不吐空格，"Thespiritof…" → "The spirit of…"）。
    let subtitleLine: HLine | undefined;
    if (titleLine) {
      const tl = titleLine;
      // det 常把「曲号 曲名」切成两个框（1727《主为我》：`1727` 与 `主为我` 各一框，中间空着
      // 两个字宽）——标题框只剩曲名，中心被右推、宽度只剩一半，下面那条「与标题居中对齐」就把
      // 真副标题挡掉了（"Lord for me" 差 119px，门只有 89px）。判居中用「曲号+曲名」的合框。
      const titleBox = numberBox ? unionRect(tl.bbox, numberBox) : tl.bbox;
      const titleCx = titleBox.x + titleBox.w / 2;
      const metaRe = /[1１]\s*[=＝]|[♩♪]|\d+\s*[/／]\s*\d+/;
      // 和弦记号（"Am"、"G/D"、"Dm7"）：第一谱行的和弦印在页眉 ROI 里，一个个都是居中的短串。
      const chordRe = /^[A-G][#b♯♭]?(?:m|maj|min|dim|aug|sus|add)?\d*(?:\s*\/\s*[A-G][#b♯♭]?)?$/;
      // 副标题**贴着标题**印（多在其下，也有印在标题上方的）；和弦则贴着谱行。离谁近就归谁。
      const gapTitle = (l: HLine) => (l.cy < tl.cy ? tl.bbox.y - l.cy : l.cy - (tl.bbox.y + tl.bbox.h));
      const cand = rest
        .filter((l) => l !== tl && l !== meta.fifthsLine && l !== meta.tempoLine)
        // 纯拉丁文的行放宽到 1.3 倍：det 框要把上伸/下伸部都包进去（`Pray` 的 P 顶到大写线、y 垂到
        // 基线下），同样字号的框比汉字高一截。1677《祷告》的「Pray」框 73px、标题「1677 祷 告」才 67px，
        // 1.05 一卡副标题就没了。
        .filter((l) => l.charH <= tl.charH * (hanziCount(l.text) ? 1.05 : 1.3))
        .filter((l) => Math.abs(l.cx - titleCx) <= titleBox.w * 0.35)
        .filter((l) => gapTitle(l) < firstStaffTopY - l.cy)
        .filter((l) => { const t = l.text.trim(); return t.length >= 2 && !metaRe.test(t) && !chordRe.test(t) && /[^\d\s.,:：、·]/.test(t); })
        .sort((a, b) => gapTitle(a) - gapTitle(b))[0];
      if (cand) {
        subtitleLine = cand;
        out.subtitle = recoverSpacesByInk(bin, cand.text.trim(), cand.bbox, cand.chars);
        out.regions.push({ text: out.subtitle, bbox: cand.bbox, chars: charsForText(out.subtitle, cand.chars) });
      }
    }
    // 署名只印一个名字、不带「词/曲」的：迦南诗选每页右上角都印着「迦南诗歌」，与调号同一排、
    // 位置正是别的歌本印「作词/作曲」的地方，上面几条认职能词的规则一条都挨不上，整行被丢掉。
    // 判据：纯汉字短行（2~8 字）、不是标题/副标题、**整行落在页面右侧 40% 里**、与调号行同一排、
    // 在标题下一排，且本页没认出别的署名。后两条是抽检别的歌本收紧的：同一个位置上也常印分类标签
    //（「敬拜赞美」「颂赞」「第一首」），有的还在标题那一排或更下面；有正经「作词/作曲」的页
    // 更不该再猜（世上所有的民族的词曲档因此一度掉到 0）。
    const keyLine = ls.find((l) => /[1１]\s*[=＝]/.test(l.text));
    if (titleLine && keyLine && !out.credits.length) {
      for (const l of rest) {
        if (l === titleLine || l === subtitleLine || l === keyLine) continue;
        const t = l.text.trim();
        if (!/^[一-鿿]{2,8}$/.test(t)) continue;
        if (l.bbox.x < bin.w * 0.6) continue;
        if (Math.abs(l.cy - keyLine.cy) > Math.max(l.charH, keyLine.charH) * 0.6) continue;
        // 标题单独占一排、署名在它**下一排**：整编本、赞美诗歌等是「调号 · 标题 · 分类」挤在同一排，
        // 右边那个是分类标签（「救主耶稣」「崇敬颂赞 三一」），不是署名。
        if (l.cy - titleLine.cy < titleLine.charH) continue;
        if (/^第.{1,6}[首篇章]$/.test(t)) continue;                // 「第一首」这类编号
        out.credits.push(t);
        out.regions.push({ text: t, bbox: l.bbox, chars: charsForText(t, l.chars) });
      }
    }
    // 调号里的升降号读成了残字：`1=♭B` 的 ♭ 印成上标、只有一个数字的三分之一大，PP-OCR 常读成
    // 引号一类的东西（227《施比受更为有福》读成 `1=″B`），`parseMeta` 的 `[b#♭♯]` 一条都对不上，
    // 整个调号就落回默认的 C。此时**回头看形状**：那个字的位置上有一块墨，交给 accidentalOf
    // 判 ♯/♭，把残字改写成 `b`/`#` 再解析一遍。只在 parseMeta 什么都没认出来时兜底，
    // 认出来的（`1=bB`、`1=G`）一概不动。
    if (meta.fifths === undefined && repairKeyAccidental(ls)) meta = parseMeta(ls);
    if (meta.fifths === undefined) {
      const k = await rereadKeyName(ls);
      if (k) { meta.fifths = k.fifths; meta.fifthsLine = k.line; }
    }
    // 探针：强制走单字符兜底、只打日志不采纳（核对判据用）
    if ((globalThis as { __keyGlyphProbe?: boolean }).__keyGlyphProbe) {
      const g = await keyByGlyphs(titleLine);
      console.log("[keyProbe]", JSON.stringify({ text: meta.fifths, glyph: g?.fifths ?? null, bbox: g?.bbox ?? null, numH }));
    }
    let glyphKeyBox: Rect | undefined;
    if (meta.fifths === undefined) {
      const g = await keyByGlyphs(titleLine);
      if (g) { meta.fifths = g.fifths; glyphKeyBox = g.bbox; }
    }
    out.fifths = meta.fifths;
    out.tempo = meta.tempo;
    out.beats = meta.beats;
    out.beatType = meta.beatType;
    out.meters = meta.meters;
    out.meterNote = meta.meterNote;
    const keyBox = meta.fifthsLine?.bbox ?? glyphKeyBox;
    if (meta.fifths !== undefined && keyBox) out.regions.push({ text: `1=${fifthsToKey(meta.fifths)}`, bbox: keyBox });
    if (meta.tempo !== undefined && meta.tempoLine) out.regions.push({ text: `♩=${meta.tempo}`, bbox: meta.tempoLine.bbox });
    // **几何法读出的并排拍号优先**：det 是按行切的，`1=C 3/4 4/4` 这种调号与拍号挨得紧的
    // 页眉会被切成一整块（2156 实测读成 "1=Cz" + 孤零零一个 "4"），分子分母根本对不上，
    // parseMixedMeters 无从下手、只落下一个 4/4。而 jianpu.ts::meterCandidates 那套判据
    // （一条短分数线、上下各紧贴一个数字）在页眉上同样成立，两个拍号都干净地读了出来。
    // 只在**它数出来的更多**时接管：det 那路认得斜杠式与调号同块的写法，单个拍号仍归它。
    if (geoMeters && geoMeters.length > (meta.meters?.length ?? 0)) {
      out.meters = geoMeters.map((m) => ({ beats: m.beats, beatType: m.beatType }));
      out.beats = geoMeters[0].beats;
      out.beatType = geoMeters[0].beatType;
      // 拍号说明（「混合拍」）照旧从 det 文本里取：det 那路没凑出拍号，meterNote 也就没给。
      // 说明后面常还印着速度（1727《主为我》det 读成 `1=c4混合拍J=75`），故容一段速度标记再收尾。
      out.meterNote ??= ls.map((l) => /([一-鿿]{1,4}拍)\s*(?:[♩♪Jj]?\s*[=＝]\s*\d{1,3})?\s*$/.exec(l.text.trim())?.[1]).find(Boolean);
      const bbox = geoMeters.map((m) => m.bbox).reduce((a, b) => unionRect(a, b));
      out.regions.push({ text: out.meters.map((m) => `${m.beats}/${m.beatType}`).join(" "), bbox });
      return;
    }
    if (meta.timeBBox && meta.meters?.length) {
      const text = meta.meters.map((m) => `${m.beats}/${m.beatType}`).join(" ") + (meta.meterNote ? ` ${meta.meterNote}` : "");
      out.regions.push({ text, bbox: meta.timeBBox });
    }
  }
}
