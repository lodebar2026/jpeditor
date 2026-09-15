// 混排 `StaffLayout` 读入的公共部分：纯函数小工具与各声部读完之后的版面 pass。
// `layout.ts` 把各声部读成 `StaffLayout` 后调这里的 `finishMixedScore` 排版。从 musicpp mxml/parser.cpp 移植，判据原样。

import { Fraction } from "../common/fraction";
import { GlyphCodes } from "../smufl/smufl";
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
// <print new-system/new-page>，本工程默认信任之。OMR（omr/musicxml.ts）产出的 MusicXML
// 只有音高/时值、没有任何版面坐标 → 所有音符坍缩到 x≈0、谱表零宽。此处按节奏自动计算
// 小节宽度、折行、并把音符横向铺开，使无坐标的谱也能正常混排显示。

// 每音符按时值给一个"槽宽"（tenths）。时值越长间距越大（近似 Gould 的次线性增长）。
const AUTO_MIN_SLOT = 22;
const AUTO_END_PAD = 16;   // 末音符到小节线的余量
const AUTO_LEFT_DATA = 16; // 小节左侧到首音符的名义留白（折行用的自然宽）
const AUTO_FIRST_LEAD = 60; // 行首小节谱号/调号/拍号占位估算
const AUTO_NOTE_PAD = 8;    // 铺开音符时两端留白

function autoSlotWidth(durQuarters: number): number {
  const d = durQuarters > 0 ? durQuarters : 0.25;
  return Math.max(AUTO_MIN_SLOT, 30 * Math.pow(d, 0.6));
}

/** 该 MusicXML 是否自带版面坐标（任一小节有 width 或任一音符有 default-x）。 */
function hasEmbeddedLayout(score: StaffLayout): boolean {
  for (const mif of score.measures) if (mif.width > 0) return true;
  for (const part of score.parts) {
    for (const md of part.measures) {
      for (const ch of md.chords) {
        for (const nt of ch.notes) if (nt.x >= 0) return true;
      }
    }
  }
  return false;
}

/** 某小节内所有声部音符的节奏槽：offset(measure-relative) → 自然累计 x + 该 offset 的槽宽。 */
function autoMeasureSlots(score: StaffLayout, mi: number): { offset: Fraction; nat: number; slot: number }[] {
  const durAt = new Map<string, { offset: Fraction; dur: number }>();
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
  }
  const entries = [...durAt.values()].sort((a, b) => a.offset.compareTo(b.offset));
  const slots: { offset: Fraction; nat: number; slot: number }[] = [];
  let nat = 0;
  for (const e of entries) {
    const slot = autoSlotWidth(e.dur);
    slots.push({ offset: e.offset, nat, slot });
    nat += slot;
  }
  return slots;
}

/** 计算每小节自然宽度 + 按页宽折行，返回强制换行的小节索引集合。 */
function autoLayoutWidths(score: StaffLayout): Set<number> {
  const natSpan: number[] = [];
  for (let i = 0; i < score.measures.length; i++) {
    const slots = autoMeasureSlots(score, i);
    const span = slots.length ? slots[slots.length - 1].nat + slots[slots.length - 1].slot : AUTO_MIN_SLOT;
    natSpan[i] = span;
    score.measures[i].width = AUTO_LEFT_DATA + span + AUTO_END_PAD;
  }

  const d = score.defaults;
  const avail = d.pageWidth - d.leftMargin - d.rightMargin;
  const breaks = new Set<number>([0]);
  let cur = AUTO_FIRST_LEAD;
  let firstInLine = true;
  for (let i = 0; i < score.measures.length; i++) {
    const w = score.measures[i].width;
    if (!firstInLine && cur + w > avail) {
      breaks.add(i);
      cur = AUTO_FIRST_LEAD + w;
      firstInLine = false;
    } else {
      cur += w;
      firstInLine = false;
    }
  }
  return breaks;
}

/** 折行后拉伸每个 system 的小节宽度以铺满页宽（末行保持自然宽，不拉伸）。 */
function autoJustifySystems(score: StaffLayout): void {
  const d = score.defaults;
  for (let si = 0; si < score.systems.length; si++) {
    const sys = score.systems[si];
    if (!sys.measures.length) continue;
    const avail = d.pageWidth - d.leftMargin - d.rightMargin - sys.leftMargin - sys.rightMargin;
    // 行首小节预留谱号/调号/拍号占位，使拉伸后仍有容纳区。
    sys.measures[0].width += AUTO_FIRST_LEAD;
    let sum = 0;
    for (const m of sys.measures) sum += m.width;
    if (sum <= 0) continue;
    const isLast = si === score.systems.length - 1;
    // 末行只在溢出时缩，不主动拉满（符合常规制谱：不把弱起短行撑满）。
    let scale = avail / sum;
    if (isLast && scale > 1) scale = 1;
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
      for (const g of md.beams) {
        if (g.chords.length === 0) continue;
        const ref = g.chords.find((c) => !c.rest) ?? g.chords[0];
        for (const c of g.chords) if (c.rest) c.stemUp = ref.stemUp;
        g.doubleDir = g.chords.some((c) => c.stemUp !== ref.stemUp);
        g.format(0);
      }
      // 歌词：解析时 lrc.x 取的是尚未定位的音符 x(-1)，此处按音符最终位置补正 x
      //（否则 drawLrc 里 x<0 被跳过，歌词不显示）。y 在下面按 system 统一定。
      for (const lrc of md.lyrics) {
        const x = xOf.get(lrc.offset.toString());
        if (x !== undefined) lrc.x = x;
      }
      // 速度/文字记号：无 default-y 时默认落在谱表内（y≈0）与音符重叠，抬到谱表上方；
      // 字号统一到歌词字号（含节拍音符字形），避免 OMR 速度记号偏小。
      const lyrSize = score.defaults.lyricFont.size;
      for (const t of md.textBlocks) {
        if (t.y <= 0) t.y = AUTO_DIRECTION_Y;
        for (const it of t.data) {
          if (it.font.size > 0) it.font = it.font.scaled(lyrSize / it.font.size);
        }
      }
    }
  }

  // 歌词 y：逐 system 取该行音符/符干/下方 slur-tie 的最低点统一下移，让各 verse 行整齐
  // 且不与下探的符干/加线/符杠/圆滑线重叠（固定偏移在低音+朝下符干/下方 slur 时会被压住）。
  const four = new Fraction(4);
  const chordLow = (ch: ChordLayout): number => {
    let low = 0;
    for (const nt of ch.notes) low = Math.max(low, nt.cy());
    if (!ch.stemUp && ch.noteType.compareTo(four) < 0) low = Math.max(low, ch.tailY(false));
    return low;
  };
  for (const sys of score.systems) {
    let maxDown = 40; // 谱表底线（cy 向下为正）
    const t0 = sys.measures[0].offset;
    const t1 = sys.measures[sys.measures.length - 1].endTick();
    for (const mif of sys.measures) {
      for (const part of score.parts) {
        const md = part.measures[mif.index];
        if (!md) continue;
        for (const ch of md.chords) {
          if (ch.grace || ch.rest) continue;
          const low = chordLow(ch);
          if (low > maxDown) maxDown = low;
        }
      }
    }
    // 实际画在谱表下方的 slur/tie 才参与避让：渲染层对 简谱/混排 记号一律把 slur/tie 画到
    // 上方（render.ts drawSlur/drawTied，jianpu 惯例），故那些谱表用 above=true 不下探；仅当
    // 该谱表是普通五线谱且 slur/tie 判为下方(above=false)时，弧线在端点音符下方再下探 SAG。
    for (const part of score.parts) {
      for (const sp of [...part.slurs, ...part.tied]) {
        if (!sp.startNote || !sp.endNote) continue;
        if (sp.endTick.compareTo(t0) <= 0 || sp.startTick.compareTo(t1) >= 0) continue;
        const nota = part.staves[sp.startNote.staff]?.getNotation(sp.startTick);
        const drawnAbove = nota === Notation.Mixed || nota === Notation.JianPu ? true : sp.above;
        if (drawnAbove) continue;
        const low = Math.max(chordLow(sp.startNote.chord), chordLow(sp.endNote.chord)) + AUTO_SLUR_SAG;
        if (low > maxDown) maxDown = low;
      }
    }
    const base = maxDown + AUTO_LYRIC_GAP;
    for (const mif of sys.measures) {
      for (const part of score.parts) {
        const md = part.measures[mif.index];
        if (!md) continue;
        for (const lrc of md.lyrics) {
          const verse = Math.max(0, (parseInt(lrc.num, 10) || 1) - 1);
          lrc.y = -(base + verse * AUTO_LYRIC_ROW);
        }
      }
    }
  }
}

// 标题/词曲信息：OMR MusicXML 的 <credit> 无 default-x/-y/font-size，且标题只在
// <work-title> 里（未作为 credit）→ 全挤在页首同一位置、无字号区分。此处按页面重排：
// 标题居中大字，作词/作曲逐行居中小字，堆叠在标题下方。
const AUTO_TITLE_FS = 26;
const AUTO_CREDIT_FS = 14;
const AUTO_LYRIC_GAP = 20;   // 音符/符干/slur 最低点到首行歌词基线的净空（tenths）
const AUTO_LYRIC_ROW = 22;   // 相邻 verse 行距
const AUTO_DIRECTION_Y = 46; // 速度记号默认高度（谱表上方）
const AUTO_ATTR_GAP = 16;    // 行首小节谱号/调号/拍号右缘到首音符的额外净空
const AUTO_SLUR_SAG = 16;    // 下方 slur/tie 弧线相对端点音符再下探的量

function autoLayoutHeader(score: StaffLayout): void {
  const d = score.defaults;
  const cx = d.pageWidth / 2;
  const creds: ScoreCredit[] = [];
  let yTop = d.topMargin + 8; // 自上边距向下累积基线（top-down）
  if (score.title) {
    yTop += AUTO_TITLE_FS;
    creds.push({
      page: 0, text: score.title, type: "title",
      x: cx, y: d.pageHeight - yTop, justify: LCR.Center, fontSize: AUTO_TITLE_FS,
    });
    yTop += 10;
  }
  // 原有 credit（作词/作曲…）按顺序堆到标题下方，居中小字。
  for (const c of score.credits) {
    if (!c.text) continue;
    yTop += AUTO_CREDIT_FS + 4;
    creds.push({
      page: 0, text: c.text, type: c.type,
      x: cx, y: d.pageHeight - yTop, justify: LCR.Center, fontSize: AUTO_CREDIT_FS,
    });
  }
  score.credits = creds;
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
        const w = timeSigWidthCalc(ts);
        if (w > timeWidth) timeWidth = w;
      }
    }

    let xpos = 5;
    if (hasClef) { mif.clefPos = xpos; xpos += 32; }
    if (hasKey || keyChange) { mif.keyPos = xpos; xpos += keyWidth; }
    if (timeChange) { mif.timePos = xpos; xpos += timeWidth; }
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

function timeSigWidthCalc(ts: TimeSig): number {
  if (ts.symbol) return 30;
  const digits = (n: number) => String(n).length;
  return Math.max(digits(ts.beats), digits(ts.beatType)) * 10;
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

function buildSystemsAndPages(score: StaffLayout, input: LayoutInput, extraBreaks?: Set<number>): void {
  const newSystem = new Set<number>(extraBreaks ?? []);
  const newPage = new Set<number>();

  for (const pt of input) {
    let mid = 0;
    for (const mea of pt) {
      for (const pr of mea.prints) {
        if (pr.newPage) {
          newPage.add(mid);
          newSystem.add(mid);
          if (mid > 0) score.measures[mid].showBarNumber = true;
        } else if (pr.newSystem) {
          newSystem.add(mid);
          if (mid > 0) score.measures[mid].showBarNumber = true;
        }
      }
      mid++;
    }
  }
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
  const autoLayout = !hasEmbeddedLayout(score);
  if (autoLayout) autoLayoutHeader(score);
  const autoBreaks = autoLayout ? autoLayoutWidths(score) : undefined;
  buildSystemsAndPages(score, input, autoBreaks);
  applyStaffVisibility(score, input);
  updateLayoutByPrint(score, input);
  if (autoLayout) autoJustifySystems(score);
  layoutAttr(score);
  if (autoLayout) autoPlaceNotes(score);
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
