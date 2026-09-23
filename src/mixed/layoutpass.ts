// 混排 `StaffLayout` 读入的公共部分：纯函数小工具与各声部读完之后的版面 pass。
// `layout.ts` 把各声部读成 `StaffLayout` 后调这里的 `finishMixedScore` 排版。从 musicpp mxml/parser.cpp 移植，判据原样。

import { Fraction } from "../common/fraction";
import { Font } from "../layout/font";
import { GlyphCodes, type MetaData } from "../smufl/smufl";
import type { Song } from "../model/doc";
import {
  BarGlyph,
  Encoder,
  fEq,
  LCR,
  ChordLayout,
  StaffLayout,
  MPage,
  Notation,
  PartGroup,
  ScoreCredit,
  Sys,
  SysStaff,
  TimeSig,
  Tuplet,
  arcExtent,
  slurEnds,
  smuflBottom,
  smuflTop,
  tiedEnds,
} from "./model";

// ---------------- Note type ----------------


// ---------------- Barline ----------------

export function barGlyphFromStyle(style: string): BarGlyph | null {
  switch (style) {
    case "regular": return BarGlyph.Single;
    case "light-light": return BarGlyph.Double;
    case "light-heavy": return BarGlyph.Final;
    case "heavy-light": return BarGlyph.ReverseFinal;
    case "heavy-heavy": return BarGlyph.HeavyHeavy;
    case "none": return BarGlyph.None;
    default: return null;
  }
}

/** 力度元素名（如「mf」「sfz」）逐字母 → Bravura 力度字形串，对齐 loader.cpp::convertDynamicsStr。 */
export function convertDynamicsStr(s: string): string {
  const map: Record<string, string> = {
    p: GlyphCodes.dynamicPiano,
    m: GlyphCodes.dynamicMezzo,
    f: GlyphCodes.dynamicForte,
    r: GlyphCodes.dynamicRinforzando,
    s: GlyphCodes.dynamicSforzando,
    z: GlyphCodes.dynamicZ,
    n: GlyphCodes.dynamicNiente,
  };
  let res = "";
  for (const c of s) {
    const g = map[c];
    if (g === undefined) return ""; // 非标准力度名（musicpp 此处 assert），忽略
    res += g;
  }
  return res;
}

/** <beat-unit> 音符类型 → 节拍记号字形，对齐 loader.cpp::makeMetronomeStr（仅四分音符）。 */
export function metNoteGlyph(noteType: string): string {
  // musicpp 只实现了四分音符；其余暂以四分音符字形兜底。
  if (noteType !== "quarter") console.warn("metronome beat-unit not supported:", noteType);
  return GlyphCodes.metNoteQuarterUp;
}

export function parseEndingNums(s: string): Set<number> {
  const res = new Set<number>();
  for (const part of s.split(",")) {
    const n = parseInt(part.trim(), 10);
    if (!isNaN(n)) res.add(n);
  }
  return res;
}

// ---------------- Layout pass ----------------

// ---- 自动版面（无内嵌坐标时，如 OMR 生成的 MusicXML）----
// 真实制谱软件（Sibelius/Finale）导出的 MusicXML 自带 <measure width>、音符 default-x、
// <print new-system/new-page>，本工程默认信任之。识别产出的 MusicXML（staffomr/toxml.ts）
// 只有音高/时值、没有任何版面坐标 → 所有音符坍缩到 x≈0、谱表零宽。此处按节奏自动计算
// 小节宽度、折行、并把音符横向铺开，使无坐标的谱也能正常混排显示。

// 每音符按时值给一个"槽宽"（tenths）。时值越长间距越大（近似 Gould 的次线性增长）。
const AUTO_MIN_SLOT = 22;
const AUTO_END_PAD = 16;   // 末音符到小节线的余量
const AUTO_LEFT_DATA = 16; // 小节左侧到首音符的名义留白（折行用的自然宽）
const AUTO_NOTE_PAD = 8;    // 铺开音符时两端留白
const AUTO_LYRIC_SPACE = 6;  // 相邻两个字之间至少留的空
const AUTO_HARMONY_SPACE = 8; // 相邻两个和弦符号之间至少留的空

function autoSlotWidth(durQuarters: number): number {
  const d = durQuarters > 0 ? durQuarters : 0.25;
  return Math.max(AUTO_MIN_SLOT, 30 * Math.pow(d, 0.6));
}

/** 该 MusicXML 是否自带版面坐标（任一小节有 width 或任一音符有 default-x）。读谱之前就要知道（弧的缺省朝向跟它走），
 *  所以直接看 `ScoreDoc`：音符 x 读自 `note.pos`（休止等无音的取和弦的 `pos`）。 */
export function hasEmbeddedLayout(song: Song): boolean {
  for (const part of song.parts) {
    for (const m of part.measures) {
      if (m.width !== undefined && m.width > 0) return true;
      for (const el of m.elements) {
        if (el.kind !== "chord") continue;
        if (el.notes.length === 0 ? el.pos?.defaultX !== undefined : el.notes.some((n) => n.pos?.defaultX !== undefined)) return true;
      }
    }
  }
  return false;
}

type Slot = { offset: Fraction; nat: number; slot: number };
const slotCache = new WeakMap<StaffLayout, Slot[][]>();

/** 某小节内所有声部音符的节奏槽：offset(measure-relative) → 自然累计 x + 该 offset 的槽宽。
 *  槽宽按时值给，但至少放得下挂在这一拍上的歌词（各段取最宽）与和弦符号——否则字挤在一起。 */
function autoMeasureSlots(score: StaffLayout, mi: number): Slot[] {
  let cache = slotCache.get(score);
  if (!cache) slotCache.set(score, (cache = []));
  const hit = cache[mi];
  if (hit) return hit;
  const durAt = new Map<string, { offset: Fraction; dur: number }>();
  const textAt = new Map<string, number>();
  const harms: { t: number; w: number }[] = [];
  const minText = (key: string, w: number) => textAt.set(key, Math.max(textAt.get(key) ?? 0, w));
  const eng = score.options;
  const harmFont = new Font(eng.wordFont, eng.harmonySize / score.scaling);
  for (const part of score.parts) {
    const md = part.measures[mi];
    if (!md) continue;
    for (const ch of md.chords) {
      if (ch.grace) continue;
      const key = ch.offset.toString();
      const dq = ch.dur.toFloat();
      const prev = durAt.get(key);
      // 同 offset 多声部/和弦取最短时值定间距（较密者主导）。
      if (!prev || dq < prev.dur) durAt.set(key, { offset: ch.offset, dur: dq });
    }
    for (const l of md.lyrics) if (!l.empty) minText(l.offset.toString(), l.width + AUTO_LYRIC_SPACE);
    for (const h of md.harmonies) {
      harms.push({ t: h.offset.toFloat(), w: harmFont.measureText(h.asPlainText()) });
    }
  }
  const entries = [...durAt.values()].sort((a, b) => a.offset.compareTo(b.offset));
  // 和弦符号：相邻两个的中心距至少各自半宽之和。落在长音中间的（`<offset>`）按拍位在音符之间线性取 x
  //（`getEntPos`），所以要求折到它所在的那个音的槽宽上：slot × 拍位比例 ≥ 中心距
  const onsets = entries.map((e) => e.offset.toFloat());
  const measEnd = score.measures[mi]!.dur.toFloat();
  harms.sort((a, b) => a.t - b.t);
  for (let k = 1; k < harms.length; k++) {
    const a = harms[k - 1]!, b = harms[k]!;
    const need = (a.w + b.w) / 2 + AUTO_HARMONY_SPACE;
    // a 所在的音：起点 ≤ a.t 的最后一个。b 越过了下一个音的（中间隔着音符）不管，那几个槽各自已按字宽撑开
    let ia = onsets.length - 1;
    while (ia > 0 && onsets[ia]! > a.t + 1e-9) ia--;
    if (ia < 0) continue;
    const c0 = onsets[ia]!;
    const c1 = onsets[ia + 1] ?? measEnd;
    if (b.t <= c1 + 1e-9) {
      // a、b 在同一个音的槽里（或 b 正落在下一个音上）：slot × (b − a)/(c1 − c0) ≥ need
      const f = (b.t - a.t) / (c1 - c0 || 1);
      if (f > 0) minText(entries[ia]!.offset.toString(), need / f);
    }
  }
  for (const h of harms) {
    const e = entries.find((x) => Math.abs(x.offset.toFloat() - h.t) < 1e-9);
    if (e) minText(e.offset.toString(), h.w + AUTO_HARMONY_SPACE);
  }
  const slots: Slot[] = [];
  let nat = 0;
  for (const e of entries) {
    const slot = Math.max(autoSlotWidth(e.dur), textAt.get(e.offset.toString()) ?? 0);
    slots.push({ offset: e.offset, nat, slot });
    nat += slot;
  }
  cache[mi] = slots;
  return slots;
}

// 断行的代价（整体最优，见 autoLayoutWidths）。按下面两个用例校准：
//  - 简谱一行 6 小节、五线谱一行只放得下 4 个：拆 3+3（各填 0.74），不拆 4+2（0.96 + 0.51）；
//  - 相邻两行都只填到一半上下（0.5 + 0.5、0.55 + 0.4）：并成一行，免得各自拉伸成稀稀拉拉的两行（长图一行 4 小节常这样）。
/** 在简谱没换行的地方断行 */
const BREAK_OFF_PREFERRED = 0.4;
/** 跨过一处简谱换行（把两行并成一行） */
const BREAK_MERGE = 0.35;
/** 末行最多拉伸到自然宽的几倍（再短就不拉满，右边留空） */
const LAST_LINE_MAX_STRETCH = 1.6;
/** 填不到一半的行（拉伸一倍以上，稀得不成样子）代价加重：简谱那边窄纸大字、小节中间换行，常剩半小节一行 */
const UNDERFULL = 3;
/** 末行不拉伸、短一点无妨，填不到这么多才算代价（免得末了孤零零一个小节） */
const LAST_LINE_MIN_FILL = 0.5;

/** 计算每小节自然宽度 + 按页宽断行，返回起行的小节序号（含 0）。
 *  `<print new-system>`（简谱视图实际排出的行，或识别出的原图分行）是**优选断点**，不是硬断点：
 *  一行放不下就在行内均匀地拆，太短就与邻行合并；`new-page` 是硬断点。
 *  代价 = Σ 非末行 (1 − 填充率)² + 末行过短 + 各处罚分，动态规划取最小（小节数不过几百，O(n²) 足够）。 */
function autoLayoutWidths(score: StaffLayout, input: LayoutInput): Set<number> {
  const n = score.measures.length;
  const w: number[] = [];
  for (let i = 0; i < n; i++) {
    const slots = autoMeasureSlots(score, i);
    const span = slots.length ? slots[slots.length - 1].nat + slots[slots.length - 1].slot : AUTO_MIN_SLOT;
    w[i] = score.measures[i].width = AUTO_LEFT_DATA + span + AUTO_END_PAD;
  }
  const preferred = new Set<number>();
  const hard = new Set<number>();
  for (const pt of input) {
    pt.forEach((mea, i) => {
      for (const pr of mea.prints) {
        if (pr.newPage) hard.add(i);
        else if (pr.newSystem) preferred.add(i);
      }
    });
  }

  const d = score.defaults;
  const avail = d.pageWidth - d.leftMargin - d.rightMargin;
  const best: number[] = [0];
  const from: number[] = [0];
  const lead = score.measures.map((_, i) => autoLead(score, i));
  for (let j = 1; j <= n; j++) {
    best[j] = Infinity;
    from[j] = j - 1;
    let sum = 0;
    let merged = 0;
    for (let i = j - 1; i >= 0; i--) {
      sum += w[i];
      const width = lead[i] + sum;
      if (width > avail && i < j - 1) break; // 单小节超宽也得放
      const fill = width / avail;
      const slack = j === n ? Math.max(0, LAST_LINE_MIN_FILL - fill) * 3 : 1 - Math.min(fill, 1);
      let cost = best[i] + slack ** 2 * (j < n && fill < 0.5 ? UNDERFULL : 1) + merged * BREAK_MERGE;
      if (i > 0 && !preferred.has(i) && !hard.has(i)) cost += BREAK_OFF_PREFERRED;
      if (cost < best[j]) {
        best[j] = cost;
        from[j] = i;
      }
      if (hard.has(i)) break; // 不能跨过换页
      if (preferred.has(i)) merged++;
    }
  }
  const breaks = new Set<number>();
  for (let j = n; j > 0; j = from[j]) breaks.add(from[j]);
  breaks.add(0);
  return breaks;
}

/** 行首小节谱号、调号（拍号变了连拍号）占的宽，与 `layoutAttr` 同一套量法，再加首音前的净空（`autoPlaceNotes`）。
 *  从前写死 60：四个升号带拍号就不够，首音挤到小节线外。 */
function autoLead(score: StaffLayout, mi: number): number {
  const mif = score.measures[mi]!;
  let key = 0;
  let time = 0;
  for (const part of score.parts) {
    for (const ps of part.staves) {
      const ks = ps.getKey(mif.offset);
      key = Math.max(key, keyChangeWidthCalc(ks.cancel, ks.fifths));
      if (mi === 0 || ps.timeChange(mif.offset)) time = Math.max(time, timeSigWidthCalc(ps.getTime(mif.offset), score.options.meta));
    }
  }
  return 5 + 32 + key + time + AUTO_ATTR_GAP;
}

/** 折行后拉伸每个 system 的小节宽度以铺满页宽（末行保持自然宽，不拉伸）。 */
function autoJustifySystems(score: StaffLayout): void {
  const d = score.defaults;
  for (let si = 0; si < score.systems.length; si++) {
    const sys = score.systems[si];
    if (!sys.measures.length) continue;
    const avail = d.pageWidth - d.leftMargin - d.rightMargin - sys.leftMargin - sys.rightMargin;
    // 行首小节预留谱号/调号/拍号占位，使拉伸后仍有容纳区。
    sys.measures[0].width += autoLead(score, sys.firstMeasure);
    let sum = 0;
    for (const m of sys.measures) sum += m.width;
    if (sum <= 0) continue;
    const isLast = si === score.systems.length - 1;
    // 末行也拉满，但最多拉到自然宽的 LAST_LINE_MAX_STRETCH 倍：太短的末行（剩一两个小节）照拉满就稀得不成样子，
    // 拉到上限为止、右边留空
    let scale = avail / sum;
    if (isLast && scale > LAST_LINE_MAX_STRETCH) scale = LAST_LINE_MAX_STRETCH;
    for (const m of sys.measures) m.width *= scale;
  }
}

/** layoutAttr 之后：把每小节音符横向铺到 [dataPos, dataEnd] 内（按节奏槽比例）。 */
function autoPlaceNotes(score: StaffLayout): void {
  for (let i = 0; i < score.measures.length; i++) {
    const mif = score.measures[i];
    const slots = autoMeasureSlots(score, i);
    if (!slots.length) continue;
    const natTotal = slots[slots.length - 1].nat + slots[slots.length - 1].slot;
    // 行首小节 dataPos 紧贴谱号/调号/拍号右缘，首音符须再留一段净空，否则贴着拍号。
    const hasAttr = mif.clefPos !== null || mif.keyPos !== null || mif.timePos !== null;
    const left = mif.dataPos + AUTO_NOTE_PAD + (hasAttr ? AUTO_ATTR_GAP : 0);
    const right = mif.dataEnd - AUTO_NOTE_PAD;
    const inner = Math.max(right - left, AUTO_MIN_SLOT);
    const xOf = new Map<string, number>();
    for (const s of slots) {
      xOf.set(s.offset.toString(), left + (natTotal > 0 ? (s.nat / natTotal) * inner : 0));
    }
    const meta = score.options.meta;
    for (const part of score.parts) {
      const md = part.measures[i];
      if (!md) continue;
      for (const ch of md.chords) {
        if (ch.grace) continue;
        const x = xOf.get(ch.offset.toString());
        if (x === undefined) continue;
        for (const nt of ch.notes) nt.x = x;
      }
      // NoteEntry（加线/附点/临时记号）在解析期 layoutNotes 时按未定位的 x(-1) 算过一次，
      // 加线会画到谱表最左端而非音符下方；音符 x 定好后按最终位置重排。
      for (const ent of md.noteEntries) ent.layout(meta, false);
      // 符杠斜率/端点依赖音符 x，解析期(x=-1)算出的是 NaN/退化值 → 重排。
      for (const g of md.beams) g.refresh();
      // 歌词：解析时 lrc.x 取的是尚未定位的音符 x(-1)，此处按音符最终位置补正 x
      //（否则 drawLrc 里 x<0 被跳过，歌词不显示）。y 由 autoPlaceLyricsY 按 system 统一定。
      for (const lrc of md.lyrics) {
        const x = xOf.get(lrc.offset.toString());
        if (x !== undefined) lrc.x = x;
      }
      // 速度/文字记号：无 default-y 时默认落在谱表内（y≈0）与音符重叠，抬到谱表上方；
      // 字号统一到歌词字号（含节拍音符字形），避免 OMR 速度记号偏小。
      const lyrSize = score.defaults.lyricFont.size;
      for (const t of md.textBlocks) {
        if (t.y <= 0) {
          t.y = AUTO_DIRECTION_Y;
          t.autoY = true;
        }
        for (const it of t.data) {
          if (it.font.size > 0) it.font = it.font.scaled(lyrSize / it.font.size);
        }
      }
    }
  }
}

/** 歌词 y：逐 system 取该行符头/朝下符干/下方记号/下方连音数字/下方 slur-tie 的最低点，各 verse 行整齐地排在它下面；
 *  离谱表底线至少 `AUTO_LYRIC_STAFF_GAP`。
 *  弧取画出来的真实曲线底（`slurEnds`/`tiedEnds` + `arcExtent`，与绘制同一份几何），跨行的弧按本行那一截。
 *  要在 `autoPlaceTuplets` 之后：连音数字的上下在那里才定。 */
function autoPlaceLyricsY(score: StaffLayout): void {
  const four = new Fraction(4);
  const eng = score.options;
  const chordLow = (ch: ChordLayout): number => {
    let low = 0;
    for (const nt of ch.notes) low = Math.max(low, nt.cy() + 6);
    if (!ch.stemUp && ch.noteType.compareTo(four) < 0) low = Math.max(low, ch.tailY(false));
    if (ch.hasNotation(false)) low += 20;
    return low;
  };
  const font = score.defaults.lyricFont;
  const ascent = -font.metrics.ascent;
  const row = Math.max(AUTO_LYRIC_ROW, font.size * 1.1);
  for (const sys of score.systems) {
    let maxDown = 40; // 谱表底线（cy 向下为正）
    for (const mif of sys.measures) {
      for (const part of score.parts) {
        const md = part.measures[mif.index];
        if (!md) continue;
        for (const ch of md.chords) {
          if (ch.grace || ch.rest || ch.notes[0]?.staff !== 0) continue;
          maxDown = Math.max(maxDown, chordLow(ch));
        }
      }
    }
    for (const part of score.parts) {
      // 混排里 slur/tie 画在简谱层上方；这时候谱表记法还没定（formatMixedScore 在后头），按五线谱的画法量，
      // 画在下方的才算数
      const arcs = [
        ...part.slurs.filter((sl) => sl.startNote?.staff === 0).map((sl) => slurEnds(sys, eng, sl, Notation.Normal)),
        ...part.tied.filter((t) => t.startNote?.staff === 0).map((t) => tiedEnds(sys, eng, t, Notation.Normal)),
      ];
      for (const e of arcs) if (e && !e.above) maxDown = Math.max(maxDown, arcExtent(e)[1] + 2);
      const fsScale = eng.musicFont.size / 40;
      for (const t of part.tuplets) {
        if (t.above || !t.startNote || t.startNote.staff !== 0) continue;
        if (!sys.contains(t.startTick) || !sys.contains(t.endTick)) continue;
        const [ly, ry] = t.staffEnds();
        const g0 = Tuplet.makeNumber(t.timeModification.denominator)[0] ?? "";
        const numH = (smuflTop(eng.meta, g0) - smuflBottom(eng.meta, g0)) * fsScale;
        maxDown = Math.max(maxDown, (ly + ry) / 2 + numH / 2 + 2);
      }
    }
    const base = Math.max(maxDown + AUTO_LYRIC_GAP, 40 + AUTO_LYRIC_STAFF_GAP) + ascent;
    for (const mif of sys.measures) {
      for (const part of score.parts) {
        const md = part.measures[mif.index];
        if (!md) continue;
        for (const lrc of md.lyrics) {
          const verse = Math.max(0, (parseInt(lrc.num, 10) || 1) - 1);
          lrc.y = -(base + verse * row);
        }
      }
    }
  }
}

/** 多谱表的谱（合唱 SATB、钢琴）：上一谱表往下伸的（歌词、低音、朝下符干）与本谱表往上伸的（高音、朝上符干）
 *  之间留够净空，缺省 80 只管得了没歌词的谱。只撑大、不缩小。系统之间的距离由装页按包围盒另算（`painter.ts::flowLayout`）。 */
function autoStaffDistances(score: StaffLayout): void {
  for (const sys of score.systems) {
    let prev: SysStaff | null = null;
    for (const st of sys.staves) {
      if (!st.staffVisible) continue;
      if (prev) {
        const [, bot] = prev.getYBound(sys);
        const [top] = st.getYBound(sys);
        st.distance = Math.max(st.distance, -bot - prev.height() + top + AUTO_STAFF_GAP);
      }
      prev = st;
    }
  }
}

// 标题/词曲信息：OMR MusicXML 的 <credit> 无 default-x/-y/font-size，且标题只在
// <work-title> 里（未作为 credit）→ 全挤在页首同一位置、无字号区分。此处按页面重排：
// 标题居中大字，作词/作曲逐行居中小字，堆叠在标题下方。
const AUTO_TITLE_FS = 20;   // pt
const AUTO_CREDIT_FS = 11;  // pt
const AUTO_LYRIC_GAP = 10;   // 音符/符干/弧最低点到首行歌词字顶的净空（tenths）
const AUTO_LYRIC_STAFF_GAP = 20; // 谱表底线到首行歌词字顶至少留的距离（音符都在谱表里时不至于贴着线）
const AUTO_LYRIC_ROW = 22;   // 相邻 verse 行距的下限（按字号 × 1.1 取大）
const AUTO_DIRECTION_Y = 46; // 速度记号默认高度（谱表上方）
const AUTO_STAFF_GAP = 12;   // 上一谱表最低处到下一谱表最高处的净空
const AUTO_ATTR_GAP = 16;    // 行首小节谱号/调号/拍号右缘到首音符的额外净空

function autoLayoutHeader(score: StaffLayout): void {
  const d = score.defaults;
  const cx = d.pageWidth / 2;
  // credit 字号是 pt（画时除 scaling），纵向累积在 tenths 里，得换算
  const tenths = (pt: number) => pt / score.scaling;
  // 页眉字号：设置面板「页眉」一组给了就用（`style/header.ts`），没给按出厂 20 / 11
  const hf = score.options.headerFonts;
  const titleFs = hf.title?.size ?? AUTO_TITLE_FS;
  const creditFs = hf.credit?.size ?? AUTO_CREDIT_FS;
  const creds: ScoreCredit[] = [];
  let yTop = d.topMargin + 8; // 自上边距向下累积基线（top-down）
  if (score.title) {
    yTop += tenths(titleFs);
    creds.push({
      page: 0, text: score.title, type: "title",
      x: cx, y: d.pageHeight - yTop, justify: LCR.Center, fontSize: titleFs,
    });
    yTop += tenths(titleFs) * 0.4;
  }
  // 标题下依次：副标题 → 题下经文 → 其余 credit（作词/作曲…），各自按原顺序，居中小字
  const push = (text: string, type: string | null, fs: number): void => {
    yTop += tenths(fs) * 1.3;
    creds.push({ page: 0, text, type, x: cx, y: d.pageHeight - yTop, justify: LCR.Center, fontSize: fs });
  };
  const rest = score.credits.filter((c) => c.text);
  for (const c of rest) if (c.type === "subtitle") push(c.text, c.type, hf.subtitle?.size ?? creditFs);
  for (const t of score.scripture) push(t, "scripture", hf.scripture?.size ?? creditFs);
  for (const c of rest) if (c.type !== "subtitle") push(c.text, c.type, creditFs);
  score.credits = creds;
}


/** 自动铺排的谱（文本格式转来的、识别出的）：连音的音符全在同一组符杠下、符干同向时，
 *  数字放到符杠那一端、不画方括号（常规制谱做法）。缺省画在符头一侧带括号，
 *  会与同在符头一侧的延音线/圆滑线挤在一起。带版面坐标的 MusicXML 不走这里，仍照 musicpp。 */
function autoPlaceTuplets(score: StaffLayout): void {
  for (const part of score.parts) {
    const groups = part.measures.flatMap((md) => md.beams);
    for (const t of part.tuplets) {
      if (!t.startNote || !t.endNote || t.bracket !== null) continue;
      const chl = t.startChord();
      const chr = t.endChord();
      const g = groups.find((bg) => bg.chords.includes(chl) && bg.chords.includes(chr));
      if (!g || g.doubleDir) continue;
      const span = g.chords.slice(g.chords.indexOf(chl), g.chords.indexOf(chr) + 1);
      if (span.some((c) => !c.rest && c.stemUp !== chl.stemUp)) continue;
      t.above = chl.stemUp;
      t.bracket = false;
    }
  }
}

function layoutAttr(score: StaffLayout): void {
  for (const mif of score.measures) {
    const sys = mif.system;
    const nsys = sys.firstMeasure === mif.index;

    let hasClef = nsys;
    let hasKey = nsys;
    let keyChange = false;
    let timeChange = false;
    let keyWidth = 0;
    let timeWidth = 0;

    for (const st of sys.staves) {
      if (!st.staffVisible) continue;
      const ps = st.partStaff;
      if (ps.keyChange(mif.offset)) {
        if (nsys && mif.index > 0) {
          const prev = score.measures[mif.index - 1];
          const prevStf = prev.system.staves.find((s) => s.partStaff === ps);
          if (prevStf?.staffVisible) keyChange = true;
        } else {
          keyChange = true;
        }
      }
      if (ps.timeChange(mif.offset)) timeChange = true;

      if (hasKey || keyChange) {
        const ks = ps.getKey(mif.offset);
        const w = keyChangeWidthCalc(ks.cancel, ks.fifths);
        if (w > keyWidth) keyWidth = w;
        for (const part of score.parts) {
          const md = part.measures[mif.index];
          if (md) {
            for (const h of md.harmonies) {
              if (fEq(h.offset, new Fraction(0))) mif.keyOffestJP = -20;
            }
          }
        }
      }
      if (timeChange) {
        const ts = ps.getTime(mif.offset);
        const w = timeSigWidthCalc(ts, score.options.meta);
        if (w > timeWidth) timeWidth = w;
      }
    }

    // parser.cpp::layoutAttr 里 `auto xpos = 5` 是 int，累加拍号宽（字形 bbox，带小数）时逐次截断
    let xpos = 5;
    if (hasClef) { mif.clefPos = xpos; xpos += 32; }
    if (hasKey || keyChange) { mif.keyPos = xpos; xpos = Math.trunc(xpos + keyWidth); }
    if (timeChange) { mif.timePos = xpos; xpos = Math.trunc(xpos + timeWidth); }
    if (mif.forward && nsys) { mif.leftBarlinePos = xpos + 20; xpos += 30; }
    mif.dataPos = xpos;
    mif.dataEnd = mif.width;

    if (nsys && mif.index > 0) {
      const prev = score.measures[mif.index - 1];
      const psys = prev.system;
      if (keyChange) {
        psys.keyChangeWidth = keyWidth;
        prev.dataEnd -= keyWidth + 5;
      }
      if (timeChange) {
        psys.timeChangeWidth = timeWidth;
        prev.dataEnd -= timeWidth + 5;
        const last = psys.measures[psys.measures.length - 1];
        if (last) last.width += timeWidth + 5;
      }
    }

    // 宽右小节线（终止线/双线等）占的横向宽度从 dataEnd 扣除，使 ending 括号右端与
    // 反复记号留出间隙（parser.cpp:2828-2848）。
    if (mif.rightBarline !== null) {
      const lws = score.options.lineWidths;
      const dist = score.options.barlineDist;
      let blw = 0;
      switch (mif.rightBarline) {
        case BarGlyph.Final:
          blw = lws.heavyBarline + lws.lightBarline + dist;
          break;
        case BarGlyph.Double:
          blw = lws.lightBarline * 2 + dist;
          break;
        case BarGlyph.HeavyHeavy:
          blw = lws.heavyBarline * 2 + dist;
          break;
        default:
          break;
      }
      mif.dataEnd -= blw;
    }
  }
}

function keyChangeWidthCalc(cancel: number, key: number): number {
  let res = 5;
  if (cancel * key < 0) {
    res += (Math.abs(cancel) + Math.abs(key)) * 10;
  } else {
    res += Math.max(Math.abs(key), Math.abs(cancel)) * 10;
    if (Math.abs(cancel) > 0 && Math.abs(key) > 0 && Math.sign(cancel) !== Math.sign(key)) {
      res += Math.min(Math.abs(key), Math.abs(cancel)) * 10;
    }
  }
  return res;
}

/** parser.cpp::timeChangeWidth：分子、分母各自逐位累加 timeSigN 字形 bbox 宽（TimeSig::width），取大者。 */
function timeSigWidthCalc(ts: TimeSig, meta: MetaData): number {
  if (ts.symbol) return 30;
  const width = (n: number) => {
    let w = 0;
    for (const c of String(n)) {
      const b = meta.getBBoxByName(`timeSig${c}`);
      w += b ? (b.bBoxNE[0] - b.bBoxSW[0]) * 10 : 10;
    }
    return w;
  };
  return Math.max(width(ts.beats), width(ts.beatType));
}

function updateEntPos(score: StaffLayout): void {
  for (let i = 0; i < score.measures.length; i++) {
    const mif = score.measures[i];
    for (const part of score.parts) {
      const md = part.measures[i];
      if (!md) continue;
      for (const ch of md.chords) {
        if (ch.rest && fEq(ch.dur, mif.dur)) continue;
        mif.entPos.set(ch.offset, ch.entX());
      }
    }
  }
}

function updateDataXPos(score: StaffLayout): void {
  for (const part of score.parts) {
    for (let i = 0; i < score.measures.length; i++) {
      const mif = score.measures[i];
      const md = part.measures[i];
      if (!md) continue;
      // `<harmony relative-x>`：和弦相对拍位的横向微调（歌本改谱脚本写进 XML 的那种）
      for (const h of md.harmonies) h.x = mif.getEntPos(h.offset) + (h.src.pos?.relativeX ?? 0);
      for (const t of md.textBlocks) {
        if (t.data.length && t.relative) t.x += mif.getEntPos(t.offset);
      }
    }
  }
}

// ---- 系统/分页/谱表间距：读 `<print>` 与 `<staff-details>` 的那三步 ----
// 输入由 `layout.ts` 从 `ScoreDoc` 拼，判据原样。

/** 一个 `<print>`。`systemLayout` / `margins` 为 null 表示元素不在（与「在但没写数」不同）。 */
export interface PrintInput {
  newPage: boolean;
  newSystem: boolean;
  systemLayout: {
    margins: { left: number | null; right: number | null } | null;
    topSystemDistance: number | null;
    systemDistance: number | null;
  } | null;
  /** `<staff-layout>`：`number` 为 1 基谱表号 */
  staffLayouts: { number: number; staffDistance: number | null }[];
}

/** 一个声部的一个小节里，版面那几步要读的东西。 */
export interface MeasureLayoutInput {
  prints: PrintInput[];
  /** `<staff-details>`：`number` 为 1 基谱表号，`printObject` 为属性原文（缺省 null） */
  staffDetails: { number: number; printObject: string | null }[];
}

/** 声部 → 小节 → 版面输入 */
export type LayoutInput = MeasureLayoutInput[][];

/** 分行分页。`autoBreaks`（自动铺排算好的起行小节）给了就只认它与 `new-page`——`new-system` 已被它当优选断点吸收；
 *  带版面的谱逐字认 `<print>`。 */
function buildSystemsAndPages(score: StaffLayout, input: LayoutInput, autoBreaks?: Set<number>): void {
  const newSystem = new Set<number>(autoBreaks ?? []);
  const newPage = new Set<number>();

  for (const pt of input) {
    let mid = 0;
    for (const mea of pt) {
      for (const pr of mea.prints) {
        if (pr.newPage) {
          newPage.add(mid);
          newSystem.add(mid);
        } else if (pr.newSystem && !autoBreaks) {
          newSystem.add(mid);
        }
      }
      mid++;
    }
  }
  for (const i of newSystem) if (i > 0 && !score.measures[i].implicit) score.measures[i].showBarNumber = true;
  for (let i = 0; i < score.measures.length; i++) {
    const mif = score.measures[i];
    const needNewSys = score.systems.length === 0 || newSystem.has(i);
    if (!needNewSys) {
      const sys = score.systems[score.systems.length - 1];
      sys.measures.push(mif);
      mif.system = sys;
    } else {
      const sys = new Sys();
      sys.score = score;
      sys.firstMeasure = i;
      sys.measures.push(mif);
      mif.system = sys;
      sys.index = score.systems.length;
      for (const part of score.parts) {
        for (const ps of part.staves) {
          sys.staves.push(new SysStaff(ps));
        }
      }
      score.systems.push(sys);
    }
  }

  for (const sys of score.systems) {
    const needNewPage = score.pages.length === 0 || newPage.has(sys.firstMeasure);
    if (needNewPage) {
      const pg = new MPage();
      pg.systems.push(sys);
      score.pages.push(pg);
    } else {
      score.pages[score.pages.length - 1].systems.push(sys);
    }
  }
}

/**
 * 空谱表隐藏：MusicXML 用 <attributes><staff-details print-object="no/yes"> 切换某谱表可见性，
 * 状态跨系统延续（loader.cpp::processStaffDetails + updateSystemLayout 的 visPrev）。
 * 在每个 system 的 firstMeasure 处应用累积可见性快照。
 */
function applyStaffVisibility(score: StaffLayout, input: LayoutInput): void {
  // measureIdx → (全局谱表序号 → 可见)
  const changes = new Map<number, Map<number, boolean>>();
  let stfOff = 0;
  let pid = 0;
  for (const pt of input) {
    const part = score.parts[pid++];
    let mid = 0;
    for (const mea of pt) {
      for (const det of mea.staffDetails) {
        const po = det.printObject;
        if (po === null) continue;
        const num = det.number - 1;
        const g = stfOff + num;
        let m = changes.get(mid);
        if (!m) {
          m = new Map();
          changes.set(mid, m);
        }
        m.set(g, po !== "no");
      }
      mid++;
    }
    stfOff += part.staves.length;
  }
  if (changes.size === 0) return;

  const total = stfOff;
  const sysByFirst = new Map<number, Sys>();
  for (const sys of score.systems) sysByFirst.set(sys.firstMeasure, sys);

  const visPrev = new Array<boolean>(total).fill(true);
  for (let mid = 0; mid < score.measures.length; mid++) {
    const ch = changes.get(mid);
    if (ch) for (const [g, v] of ch) visPrev[g] = v;
    const sys = sysByFirst.get(mid);
    if (sys) {
      for (let i = 0; i < sys.staves.length && i < total; i++) {
        sys.staves[i].staffVisible = visPrev[i];
      }
    }
  }
}

function updateLayoutByPrint(score: StaffLayout, input: LayoutInput): void {
  for (const sys of score.systems) {
    let stfOff = 0;
    let pid = 0;
    for (const pt of input) {
      const part = score.parts[pid++];
      const mea = pt[sys.firstMeasure];
      if (!mea) { stfOff += part.staves.length; continue; }
      for (const pr of mea.prints) {
        const sl = pr.systemLayout;
        if (sl) {
          const sm = sl.margins;
          if (sm) {
            sys.leftMargin = sm.left ?? sys.leftMargin;
            sys.rightMargin = sm.right ?? sys.rightMargin;
          }
          const dist = sl.topSystemDistance ?? sl.systemDistance;
          if (dist !== null) sys.distance = dist;
        }
        for (const stfLay of pr.staffLayouts) {
          const num = stfLay.number - 1;
          const dist = stfLay.staffDistance;
          const stfIdx = stfOff + num;
          if (dist !== null && stfIdx < sys.staves.length) {
            sys.staves[stfIdx].distance = dist;
          }
        }
      }
      stfOff += part.staves.length;
    }
  }
  // Default distances
  for (const sys of score.systems) {
    let firstVisible = true;
    for (const st of sys.staves) {
      if (!st.staffVisible) { st.distance = 0; continue; }
      if (firstVisible) { st.distance = 0; firstVisible = false; }
      else if (st.distance === 0) st.distance = 80;
    }
    if (sys.distance === 0) sys.distance = 80;
  }

  // Convert relative system distances to absolute Y positions per page.
  // MusicXML: top-system-distance (first system per page) = absolute from page top margin.
  //           system-distance (subsequent systems) = gap from previous system bottom.
  for (const pg of score.pages) {
    let absY = 0;
    let prevHeight = 0;
    for (let si = 0; si < pg.systems.length; si++) {
      const sys = pg.systems[si];
      if (si === 0) {
        absY = sys.distance; // already absolute
      } else {
        absY = absY + prevHeight + sys.distance;
        sys.distance = absY;
      }
      prevHeight = sys.height();
    }
  }
}

/**
 * 各声部读完之后的收尾：全局 tick、跨小节对象的绝对 tick、简谱符杠、整个版面 pass、声部分组、Sibelius 修正。
 * 与来源无关。
 */
export function finishMixedScore(score: StaffLayout, input: LayoutInput, partGroups: PartGroup[]): void {
  // Staff order
  let ord = 0;
  for (const part of score.parts) for (const st of part.staves) st.order = ord++;

  // Global measure offsets
  let tick = new Fraction(0);
  for (const mif of score.measures) {
    mif.offset = tick;
    tick = tick.plus(mif.dur);
  }

  // 跨小节对象的 startTick/endTick 必须在 mif.offset 赋值后再算：slur/tied 在
  // PartLoader 阶段解析（那时 mif.offset 还是 0），故此处用真实绝对 tick 重算，
  // 否则系统归属判定（drawSlur/drawTied 的 begin/end 比较）全错，slur/tie 会错画到
  // 第一小节。对应 musicpp mxml/loader.cpp::processSlur（在整 part 加载后统一解析）。
  for (const part of score.parts) {
    for (const sl of part.slurs) {
      sl.startTick = sl.startChord().tick();
      sl.endTick = sl.endChord().tick();
    }
    for (const t of part.tied) {
      t.startTick = t.startChord().tick();
      t.endTick = t.endChord().tick();
    }
    // ending 同理：startMeasure/endMeasure 在 PartLoader 阶段就确定，但其绝对 tick
    // 依赖 mif.offset（此处才赋值）。左反复记号 tick = 起始小节 offset，右反复记号
    // tick = 结束小节末端，对齐 musicpp parser.cpp 用 offsets[bl]+mif->offset 配对。
    for (const e of part.endings) {
      e.startTick = e.startMeasure.offset;
      e.endTick = e.endMeasure.endTick();
    }
  }

  // processJpBeam
  for (const part of score.parts) {
    for (const md of part.measures) md.processJpBeam();
  }

  // Layout pass。无内嵌版面坐标（OMR 生成谱）时自动计算小节宽度/折行/音符横向位置。
  const autoLayout = score.autoLayout; // layoutStaff 读谱前已按 hasEmbeddedLayout 定好
  if (autoLayout) autoLayoutHeader(score);
  const autoBreaks = autoLayout ? autoLayoutWidths(score, input) : undefined;
  buildSystemsAndPages(score, input, autoBreaks);
  applyStaffVisibility(score, input);
  updateLayoutByPrint(score, input);
  if (autoLayout) autoJustifySystems(score);
  layoutAttr(score);
  if (autoLayout) autoPlaceNotes(score);
  if (autoLayout) autoPlaceTuplets(score);
  if (autoLayout) autoPlaceLyricsY(score);
  if (autoLayout) autoStaffDistances(score);
  updateEntPos(score);
  updateDataXPos(score);

  // Part groups
  score.partGroups = partGroups;

  // Sibelius fixes（parser.cpp:2890-2895，行首调号变更偏移须在 layoutAttr/updateDataXPos 之后）
  if (score.encoder === Encoder.Sibelius) {
    for (const sys of score.systems) sys.fixSibKeyChange();
    for (const part of score.parts) part.fixTieForSib();
  }

}
