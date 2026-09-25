// 位图五线谱的单页识别：位图 → `StaffPageResult`（与矢量路同一个返回类型）。
//
// **下游全部复用 `src/staffomr/`**，那边一行不改。本文件只做两件事：
//   1. 把位图变成 `Staff` / `Seg` / `Sym`（`adapt.ts`）；
//   2. 按矢量路 `staffomr/index.ts::recognizeStaffPage` 的**同一个次序**往下调。
//
// 与矢量路的差别只有三处，都是「那边从路径对象里取、这边从像素里取」：
//   - 符杠：矢量路 `findBeams` 读 `pg.objs` 的填充路径；位图路自己找（`prims.ts`）。
//   - 符头：矢量路查字形字典；位图路按性质判（`notehead.ts`）。
//   - 文本层：矢量路读文字对象；位图路要 OCR（尚未接，故歌词/力度/速度暂缺）。
import type { Binary } from "../omr/types";
import type { Box } from "../staffomr/model";
import type { Component, Rect } from "../omr/types";
import { findBarlines, findNoteheads, findStaves, findStems, findTails, makeBars, makeSystems, unknownObjs } from "../staffomr/page";
import { accidentalAlter, isAccidental, isClef, timeSigDigit, type SmuflName } from "../staffomr/glyphs";
import { buildNotes, calcAlters, checkBars, findClefKeyTime, keyFifths, lastTimeSignature, type BeamShape, type StaffContext, type StaffNote, type StemInfo, type BarCheck } from "../staffomr/notedata";
import { attachDynamicTexts, attachNotations, attachWedges, findNotations, findTuplets } from "../staffomr/notations";
import type { SPage, Staff, Sym, Tag } from "../staffomr/model";
import { overlapY } from "../staffomr/model";
import { buildRasterPage, makeSymObj, makeTextObj, type RasterSym } from "./adapt";
import { binSig, blobImage, extendVSegs, findBlobs, findBraces, findPrimitives, groupByLeftInk, ledgerGrid, removeStaffLines, type BeamQuad, type LineSeg, type RasterPrims } from "./prims";
import { findRasterHeads, hollowHeadsByPitch, hollowHeadsFromHoles, hollowHeadsOnLedgers, judgeHeadBox, mergeHoles, type PitchStep } from "./notehead";
import { bootstrapClefs, matchTemplate, RasterGlyphLookup, type BootStaff } from "./rasterglyphs";
import { sigDistance } from "../omr/glyphdict";
import { cutJianpuStrip, eraseInBand, findJianpuBands, jianpuKey, type JianpuStrip } from "./jianpuband";
import { fuseJianpu, type FuseStats, type JianpuRow } from "./jianpufuse";
import { findLyricRows, foldLyricChars, isLatinRow, latinCells, mapCharsToCells, stripKey, stripOf, type LyricRow, type LyricStrip, type OcrChar } from "./lyric";
import { findHoles, traceContours, type ContourMap } from "./contour";
import { buildHeadMasks, buildHollowMasks, headFromStemBlock, splitHeadCluster } from "./headmask";
import { headProb, trainHeadClassifier } from "./headclass";
import { findStaffLabels, labelKey, normalizeLabel, type LabelStrip } from "./stafflabel";
import { findHarmonyStrips, harmonyKey, harmonyLine, readHarmonyStrip, type HarmonyStrip, type HarmonyToken } from "./harmony";
import { findRasterWedges, type RasterWedge } from "./wedge";
import { groupDynamics, type RasterDynamic } from "./dynamics";
import { findRasterSlurs } from "./slur";
import { ContourLedger } from "./ledger";
import { attachHarmonies, attachLyrics, buildLyricLines, type LyricLine } from "../staffomr/textanalyze";
import { attachSlurs, markSlurNotes, reconnectSlurs, type SlurArc } from "../staffomr/slur";
import { estimateUnit, findStaffLines, groupStaves, traceLeft, type RasterUnit, type StaffLineRun } from "./staffline";
import { completeStaffLines } from "./dewarp";
import { rasterizePage, type RasterPage } from "./rasterpage";

export interface RasterPageResult {
  page: SPage;
  hasStaff: boolean;
  unknown: number;
  unit: RasterUnit | null;
  /** 取到的位图（排查、裁图用）。 */
  raster: RasterPage | null;
  ctx: Map<Staff, StaffContext>;
  beams: BeamShape[];
  notes: StaffNote[];
  bars: BarCheck[];
  /** 认出来的歌词行（没接 OCR 字典时为空）。 */
  lyricLines: LyricLine[];
  /**
   * contour 层与**认领账本**（`contour.ts` / `ledger.ts`）：这一页的每一团墨、
   * 以及谁认走了它。识别本身不看这两样，它们只回答「还有什么是我们从没看见的」
   * ——`ledger.unclaimed()` 就是无主的那些，`scripts/raster-unclaimed.mjs` 拿它出表。
   */
  contours: ContourMap | null;
  ledger: ContourLedger | null;
  /** 认出来的松叶（渐强/渐弱），见 `wedge.ts`。 */
  wedges: RasterWedge[];
  /** 认出来的力度记号（拼好的文本），见 `dynamics.ts`。 */
  dynamics: RasterDynamic[];
  /** 认出来的弧（圆滑线 / 连音线），见 `slur.ts`。 */
  slurs: SlurArc[];
  /**
   * 这一页切出来的**歌词条**（`gen-rasterlyrics.mjs` 拿它送 OCR）。
   *
   * **生成器必须与识别走同一条路**：它原来自己复制了一份流程
   *（另一套 `findStaffLines`/`findBlobs`/`findLyricRows`），识别这边一改判据就对不上，
   * 指纹全变、缓存整份落空——实测歌词从 85.0% 掉到 42.7%，还查了半天。
   * 现在条子从这里出，两边不可能再走样。
   */
  lyricStrips: LyricStrip[];
  /**
   * 这一页各谱行的**声部标签条**（`gen-rasterlabels.mjs` 拿它送 OCR）。
   * 与歌词条同一套架构：这里只切条，认字靠离线缓存。见 `stafflabel.ts`。
   */
  labelStrips: LabelStrip[];
  /**
   * 这一页各谱行上方的**和弦带**（`gen-rasterharmony.mjs` 拿它送 OCR）。
   * 与歌词条、标签条同一套架构：这里只切条，认字靠离线缓存。见 `harmony.ts`。
   */
  harmonyStrips: HarmonyStrip[];
  /** 谱表正上方的简谱行（混排谱；`gen-rasterjianpu.mjs` 拿它离线认简谱）。见 `jianpuband.ts`。 */
  jianpuStrips: JianpuStrip[];
  /** 简谱互证改了几处（没有简谱行或缓存没命中为 null）。 */
  jianpuFix?: FuseStats | null;
  /** 切出来的和弦记号（缓存里查得到才有）。已挂到音符的 `chord` 上。 */
  harmonies: HarmonyToken[];
  /** 和弦带里认出的文本（不是和弦的字母串，见 `readHarmonyStrip`）。 */
  harmonyTexts: HarmonyToken[];
  /** 谱行下标 → 规范化的声部名（`S1`/`A`/`P`…）。缓存里查得到才有。 */
  staffLabels: Map<number, string>;
  /**
   * 歌词切格的**结构指标**：切出几条、缓存命中几条、其中**字格数与 OCR 字数相等**的几条。
   * 最后那个数是切格好坏的直接尺子——相等才走得上「按序号一一对应」那条准路
   * （不等就得按 `xFrac` 摊，而那是 CTC 估的位置，误差常有半个字）。
   */
  lyricStats: { rows: number; hit: number; parity: number };
  /** 排查用（`opts.debug`）：连通块与「谁被认领了」。识别本身不看。 */
  debugBlobs?: { id: number; box: Rect; area: number; claimed: boolean }[];
  /** 排查用（`opts.debug`）：去谱线图、以及抹掉原语之后送去找块的那张图。 */
  debugNl?: Binary;
  debugPrims?: RasterPrims;
  /** 排查用（`opts.debug`）：分好组的谱行（`findStaves` 之前）。 */
  debugGroups?: { top: number; bottom: number; space: number }[];
  debugRest?: Binary;
  carryTime?: { beats: number; beatType: number };
}

const empty = (page: SPage, raster: RasterPage | null, unit: RasterUnit | null, carryTime?: { beats: number; beatType: number }): RasterPageResult => ({
  page,
  hasStaff: false,
  unknown: 0,
  unit,
  raster,
  ctx: new Map(),
  beams: [],
  notes: [],
  bars: [],
  lyricLines: [],
  contours: null,
  ledger: null,
  wedges: [],
  dynamics: [],
  slurs: [],
  lyricStrips: [],
  labelStrips: [],
  harmonyStrips: [],
  jianpuStrips: [],
  harmonies: [],
  harmonyTexts: [],
  staffLabels: new Map(),
  lyricStats: { rows: 0, hit: 0, parity: 0 },
  carryTime,
});

/**
 * **符尾按位置自举**（不查字典）。
 *
 * 字典对符尾几乎没用：`rasterglyphs.json` 里 4144 个类**没定名**，符尾只有 8 个类有名字
 * ——实测全书只认出 1 个 `flag8thUp`。更要命的是符尾在位图上**根本不成为独立的块**：
 * 它上半截是根粗竖笔，横向游程短，`findPrimitives` 把它当竖笔画抽走了；
 * 剩下的钩尾细而弯，落在窗口里的残块高度中位数只有 0.53 格（真符尾有一格半）。
 *
 * 所以改从**原始像素**上量，绕开原语划分：符尾一定长在符干**远离符头的那一端**、
 * 一定在符干**右侧**（刻谱通例，朝上朝下都在右）。量那个窗口里的墨占比，
 * 实测分得很开——没有符杠的音符里，占比要么是 0（真四分），要么在 0.35 以上
 *（破碎前三页 121 个里 27 个），中间几乎没有。
 *
 * **有符杠的符干不看**：符杠也横在这个窗口里，一量必中；而符杠那一路
 * 已经把层数算进时值了（`calcBeamLevels`），再补个符尾反而把十六分压回八分
 *（`buildStems` 里「有符尾的符干不接符杠」）。
 */
function bootstrapFlags(bin: Binary, pg: SPage, beams: BeamQuad[], unit: RasterUnit, avoid: Rect[] = []): RasterSym[] {
  const sp = unit.space;
  const out: RasterSym[] = [];
  // **只看实心符头**：空心符头（二分/全音符）本来就不带符尾，
  // 给它安一个会把二分读成八分。
  const heads = pg.symbols.filter((s) => s.hasTag("Note") && s.code === "noteheadBlack");
  const lineYs = pg.staves.flatMap((stf) => stf.lineYs);
  for (const st of pg.segsWithTag("Stem")) {
    const on = heads.filter(
      (s) => (Math.abs(s.box.left - st.cx) < sp / 3 || Math.abs(s.box.right - st.cx) < sp / 3) && s.box.top < st.bottom && st.top < s.box.bottom,
    );
    if (!on.length) continue;
    // **远端按符干上所有的头定**：和弦的符干串着好几个头，只拿其中一个量，
    // 挂在中间的那个会把另一头的符头当成「远端」（《赞美一神》D4/D3 共干，
    // 拿 D3 量出远端在 D4 那头，D4 符头连着加线把窗口填满，整批读成八分）。
    const ys = on.map((s) => (s.box.top + s.box.bottom) / 2);
    const dTop = Math.min(...ys.map((y) => Math.abs(st.top - y)));
    const dBot = Math.min(...ys.map((y) => Math.abs(st.bottom - y)));
    // 两端都贴着符头：这是两个头之间被切出来的一截符干（加线、谱线把符干切断），没有自由端
    if (Math.max(dTop, dBot) < sp * 0.75) continue;
    const far = dTop > dBot ? st.top : st.bottom;
    const hy = far === st.top ? Math.min(...ys) : Math.max(...ys);
    // 符杠横在这个窗口里的，不看（理由见上）
    // 符杠斜着搭在符干中段的也算（不只远端那一小截）
    if (beams.some((b) => b.x0 - sp * 0.5 <= st.cx && st.cx <= b.x1 + sp * 0.5 && st.top - sp * 0.5 < (b.y0 + b.y1) / 2 && (b.y0 + b.y1) / 2 < st.bottom + sp * 0.5)) continue;
    const toward = Math.sign(hy - far) || 1;
    const frac = (d0: number, d1: number) => {
      const x0 = Math.round(st.cx + sp * FLAG_X[0]);
      const x1 = Math.round(st.cx + sp * FLAG_X[1]);
      let ink = 0;
      let tot = 0;
      for (let dy = sp * d0; dy < sp * d1; dy++) {
        const y = Math.round(far + toward * dy);
        if (y < 0 || y >= bin.h) continue;
        for (let x = x0; x < x1; x++) {
          if (x < 0 || x >= bin.w) continue;
          tot++;
          ink += bin.data[y * bin.w + x];
        }
      }
      return tot ? ink / tot : 0;
    };
    // **符尾从符干尖端长出来**：贴着远端那一小截、紧挨符干右侧必须有墨。
    // 没这一条，从符干旁边路过的连音线、下一个音的符头都会把窗口填满
    // （实测只看整窗占比，小节自检 33.2% → 31.9%）。
    // 粗线扫描中符干可能伸出连接点几像素；在半格、两倍线宽以内找连接处。
    // 细线页仍用原尖端，避免把附近的弧线误认成符尾。
    // 整窗墨占比也按连接点量，不在这之前按尖端先筛一道：干伸出符尾半格的，按尖端量窗口只罩到钩尾一角
    //（《向主唱新歌》下声部的八分 B3 读成四分，后面的休止整排错拍）。
    let offset = 0;
    const reach = unit.lineThick > sp * 0.2 ? Math.min(sp * 0.5, unit.lineThick * 2) : 0;
    while (frac(offset, offset + FLAG_TIP_Y) < FLAG_TIP && offset * sp < reach) offset += 1 / sp;
    if (frac(offset, offset + FLAG_TIP_Y) < FLAG_TIP || frac(offset, offset + FLAG_Y) < FLAG_INK) continue;
    const up = far < hy;
    // **第二个钩**：十六分的两道钩沿符干错开约一格。只认出第一道的话
    // 十六分整批读成八分（实测补上第一道之后 `16th→eighth` 一下涨到 171 处）。
    // 窗口截在最近的符头边缘之前：朝下的短符干上，符头就在符干右边，离尖端一格多就罩到它
    //（《主我敬拜你》朝下的八分整批读成十六分）。截下来不到 0.6 格的就不看第二道钩。
    const room = Math.abs(hy - far) / sp - 0.6;
    const twoEnd = Math.min(offset + 2.2, room);
    // 还要**右缘轮廓有两个峰**：从尖端往符头走，逐行量钩的最右缘，先涨后落（第一道钩）再涨起来（第二道）
    // 才是两道钩。一道长钩（《主我敬拜你》的八分符尾有 2.3 格长）外沿也会填满第二道钩的窗口，但右缘只有一个峰。
    // 低分辨率放大的万古磐石歌两道钩在干边粘成一段，靠这一条。谱线那几行不算。
    // 或者**贴着干的那一窄条里墨分成两段**（两道钩各自连在干上，右缘对齐的字体靠这一条：来敬拜荣耀王）。
    const hookRuns = () => {
      const x0 = Math.round(st.cx + unit.lineThick);
      const x1 = Math.round(st.cx + sp * 0.35);
      let runs = 0;
      let gap = 2;
      for (let dy = offset * sp; dy < Math.min(offset + 2.4, room) * sp; dy++) {
        const y = Math.round(far + toward * dy);
        if (y < 0 || y >= bin.h || lineYs.some((ly) => Math.abs(ly - y) <= unit.lineThick)) continue;
        let ink = false;
        for (let x = Math.max(0, x0); x <= Math.min(x1, bin.w - 1) && !ink; x++) if (bin.data[y * bin.w + x]) ink = true;
        if (ink) {
          if (gap >= 2) runs++;
          gap = 0;
        } else gap++;
      }
      return runs;
    };
    const twoPeaks = () => {
      const x0 = Math.round(st.cx + unit.lineThick);
      const x1 = Math.round(st.cx + sp * 1.2);
      const prom = sp * HOOK_PROM;
      let max = -1;
      let dip = Infinity;
      for (let dy = offset * sp; dy < Math.min(offset + 2.4, room) * sp; dy++) {
        const y = Math.round(far + toward * dy);
        if (y < 0 || y >= bin.h || lineYs.some((ly) => Math.abs(ly - y) <= unit.lineThick)) continue;
        let r = -1;
        for (let x = Math.min(x1, bin.w - 1); x >= Math.max(0, x0); x--) if (bin.data[y * bin.w + x]) { r = x; break; }
        if (r < 0) continue;
        if (dip < Infinity && r - dip >= prom) return true;
        if (r > max) max = r;
        if (max - r >= prom) dip = Math.min(dip, r);
      }
      return false;
    };
    const two = twoEnd - (offset + 1.0) >= 0.6 && frac(offset + 1.0, twoEnd) >= FLAG_INK2 && (twoPeaks() || hookRuns() >= 2);
    const code = two ? (up ? "flag16thUp" : "flag16thDown") : up ? "flag8thUp" : "flag8thDown";
    const h = sp * (two ? 2.2 : 1.5);
    // 出块也从**连接点**起算：`offset` 找到的才是符尾真正长出来的地方，
    // 还按符干末端 `far` 出块的话，粗线扫描件上整块会偏出半格。
    const anchor = far + toward * offset * sp;
    const y0 = toward > 0 ? anchor : anchor - h;
    const fbox = { x: Math.round(st.cx), y: Math.round(y0), w: Math.round(sp * 1.5), h: Math.round(h) };
    // **和弦字母不是符尾**：符干朝上顶到和弦行时，窗口里那点墨是「C/E」的 E、「Csus4」的 sus
    //（《主我敬拜你》三处，八分附点、附点二分都读成了带尾的八分）
    if (avoid.some((m) => overlapFrac(fbox, m) > FLAG_AVOID)) continue;
    out.push({ box: fbox, code });
  }
  return out;
}

/**
 * 加线候选（`hollowHeadsOnLedgers` 用）：每行谱上下第 1~4 条加线的位置上，**直接在原图上**找横向墨段
 *（上下各放一像素，断口 ≤ 1 像素）。不用 `prims.hSegs`：骑在加线上的空心头，那几列的纵向墨是
 * 圈 + 加线一整条，过不了横笔画「细」的那道闸，加线抽不出来（赞美三一真神 m16 的 C4）。
 * 真假交给模板得分与内腔佐证。
 */
function ledgerCandidates(bin: Binary, groups: { lines: StaffLineRun[]; space: number }[]): { x0: number; x1: number; y: number }[] {
  const out: { x0: number; x1: number; y: number }[] = [];
  for (const g of groups) {
    const left = Math.max(...g.lines.map((l) => l.left));
    const right = Math.min(...g.lines.map((l) => l.right));
    const ys: number[] = [];
    for (let k = 1; k <= 4; k++) ys.push(g.lines[0].y - k * g.space, g.lines[4].y + k * g.space);
    for (const fy of ys) {
      const y = Math.round(fy);
      if (y < 1 || y >= bin.h - 1) continue;
      const ink = (x: number) => !!(bin.data[(y - 1) * bin.w + x] || bin.data[y * bin.w + x] || bin.data[(y + 1) * bin.w + x]);
      let start = -1;
      let miss = 0;
      for (let x = Math.max(0, Math.round(left)); x <= Math.min(bin.w - 1, Math.round(right)) + 1; x++) {
        const on = x <= Math.min(bin.w - 1, Math.round(right)) && ink(x);
        if (on) {
          if (start < 0) start = x;
          miss = 0;
          continue;
        }
        if (start >= 0 && ++miss > 1) {
          out.push({ x0: start, x1: x - miss, y: fy });
          start = -1;
          miss = 0;
        }
      }
    }
  }
  return out;
}

/** 区间 [y0, y1] 里的全部音高位置（与 `makePitchGrid` 同一张表：每行谱顶线上下各五条加线的线位与间位）。 */
function makePitchSteps(groups: { lines: { y: number }[]; space: number }[]): (y0: number, y1: number) => PitchStep[] {
  const steps: PitchStep[] = [];
  for (const g of groups) {
    const top = g.lines[0].y;
    const half = g.space / 2;
    for (let k = -10; k <= 18; k++) steps.push({ y: top + k * half, line: k % 2 === 0 });
  }
  return (y0, y1) => steps.filter((s) => s.y >= y0 && s.y <= y1);
}

/**
 * 音高格：把一个 y 吸到最近的**线/间中心**（差半格音高就错一级）。
 * 谱表之外也给（加线那一带），上下各放几格；离得太远返回 null。
 */
function makePitchGrid(groups: { lines: { y: number }[]; space: number }[], unit: RasterUnit): (y: number) => number | null {
  const steps: number[] = [];
  for (const g of groups) {
    const top = g.lines[0].y;
    const half = g.space / 2;
    for (let k = -10; k <= 18; k++) steps.push(top + k * half);
  }
  steps.sort((a, b) => a - b);
  return (y: number) => {
    let best: number | null = null;
    let bd = unit.space * 0.3;
    for (const s of steps) {
      const d = Math.abs(s - y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  };
}

/** 记账时算「这条段有主」的标记。见 `makeBars` 之后那一段。 */
const SEG_TAGS: Tag[] = ["Staff", "Leger", "Stem", "BarLine", "SysLine", "Tail", "Beam", "Bracket"];

/** 判别器只看这个尺寸包络内的块（线距的倍数）——比 `findRasterHeads` 的闸宽一圈，
 *  正是要捞被啃窄、被粘宽的那一批；再宽就成了「拿模板去空地里找东西」。 */
const CLF_W = [0.5, 2.2] as const;
const CLF_H = [0.4, 1.6] as const;
/** 判别器收下的概率门槛。扫过 0.6 / 0.7 / **0.8** / 0.9 / 0.95：
 *  扫描件音符 65.45 / 65.16 / **65.46** / 65.06 / 64.95%，
 *  干净档音符 84.89 / 84.94 / **84.94** / 84.94 / 84.94%——0.8 是扫描档见顶
 *  且干净档一分不动的那一点（0.6 扫描相当但干净档掉 0.05）。 */
const CLF_P = 0.8;
/** 第二遍拆块的尺寸上限（线距的倍数）。取的正是 `findBlobs` 自己的上限
 *  （宽 6 格、高 9 格）——**等于不再设限**，拆出来的头全交给判别器把关。
 *  写成 9×5.5 / 12×7 / 16×9 实测结果完全相同，因为再大的块 `findBlobs` 根本不出。 */
const BIG_W = 6;
const BIG_H = 9;

/** 整小节休止的形状闸（见 `restSyms` 那一段）。放松到 1.6/0.8/0.9 与 1.5/0.75/0.95
 *  都**一个都不多认**——剩下的那些不在纸上（破碎三个女高合印一行，
 *  GT 里 P1/P2 中段的全休止根本没印出来）。
 *  这三个数量的是**休止本身**，量块之前要把粘着的谱线截扣掉，见那里的说明。
 *  填充 0.85 → 0.75：网纹印的休止块里散着白点，《向主唱新歌》第 14 小节那个只有 0.79，被收成 C5。 */
const REST_W = [0.9, 1.8] as const;
const REST_H = 0.8;
const REST_RATIO = 1.8;
const REST_FILL = 0.75;

/** 降号的肚子从盒顶往下第几成开始。取 0.45：盒高 2.36 格时中心正好下移 0.53 格，
 *  与实测的 0.55 格偏差吻合。 */
const FLAT_BOWL_TOP = 0.45;

/** 升降号「并回竖笔」之后与模板的签名距离上限。比通用的 90 松一点：
 *  并回来的盒是块的包围盒 + 竖段的中心线拼出来的，边界不如原块齐整。 */
const ACCID_TEMPLATE_DIST = 90;
/** 紧跟谱号的**调号位置**上再放宽到这一档：颂赞与尊贵的调号降号是细网点印的，并回竖笔后
 *  距离 95。全页一律放宽的话合唱谱干净档多认假降号（小节自检 59.5 → 59.02）。 */
const KEY_ACCID_TEMPLATE_DIST = 100;

/** 空心头按模板再搜的得分门槛。见「空心头按模板再搜」那一段。 */
const HOLLOW_MASK_SCORE = 0.38;
/** 演奏记号离谱表最远几格（线距）：带加线的低音再往下一格，四格半够了。 */
const ARTIC_REACH = 4.5;

/** 调号兜底：相邻两个升降号（或谱号与第一个升降号）之间最多隔几个线距。 */
const KEY_GAP = 1.5;
/** 歌词条字高不到本页中位数的这个比例就不是歌词（页脚版权小字）。 */
const LYRIC_MIN_H = 0.4;
/** 调号**第一个**记号离谱号右缘的上限（线距）：低音谱号的两点在谱号盒外（齐来称颂 1.77 格）。 */
const KEY_GAP_FIRST = 2.0;
/** 调号串里后一个记号的左缘可以伸进前一个右缘多少格。 */
const KEY_OVERLAP = 0.5;
/** 不带连字符的拉丁行离带连字符的那行多近（字高的倍数）算同一块歌词。 */
const LATIN_CHAIN = 2.5;
/** 上下贴着的两个头（`isStackedPair`）拆分时每个头的得分门槛。 */
const PAIR_SCORE_MIN = 0.4;

/** 拍号数字与模板的签名距离上限。见 `bootstrapTimeSig` 那段的说明。 */
const TIME_TEMPLATE_DIST = 180;
/** 调号串里按「前一个记号」认下一个的签名距离上限（同一本同一种记号，比模板近得多）。 */
const KEY_SELF_DIST = 120;
/** 几何闸收下的实心头，矮于这个数（线距的倍数）又压在符杠中线上的，是杠头。 */
const BEAM_STUMP_H = 0.65;
/** 结构还原号：两根竖笔的间距（格）。 */
const NAT_GAP = [0.35, 0.8] as const;
/** 按角色限定认拍号数字（见拍号那一段）：分子只在 2~9 里挑，分母只在 2、4、8 里挑。
 *  距离上限：万古磐石歌的铅字「3」到 `timeSig3` 186/214，齐来谢主歌分母「4」181/230，
 *  万古磐石歌分母「4」246/275（去线切得最狠）。 */
const NUM_DIGITS = [2, 3, 4, 5, 6, 7, 8, 9] as const;
const DEN_DIGITS = [2, 4, 8] as const;
const TIME_NUM_DIST = 230;
const TIME_DEN_DIST = 300;
/** 派生的「9」要比别的数字近出这么多才采信（见 `digitOf`）。 */
const NINE_MARGIN = 30;

/** 空心符头允许离谱表多远（线距的倍数）。见 `inBand` 那段的说明。 */
const HOLLOW_BAND = 3.0;

/**
 * 符尾窗口的墨占比门槛。
 *
 * 原来 0.25，收窄窗口之前是对的；收窄之后真符尾落在 **0.17~0.21**、
 * 真四分仍是 0.00（中间还是没人，只是整条尺子往下挪了）。
 * 扫过 0.10 / 0.14 / **0.16~0.18** / 0.20 / 0.22 / 0.25：
 * 时值 91.9 / 92.0 / **92.1** / 92.0 / 91.0 / 89.4%。
 * 0.18 → 0.15：低分辨率放大的万古磐石歌符尾只有三五像素粗，窗口占比 0.13~0.16。独唱谱时值 84.44 → 84.50%
 *（主使我喜乐 87.4 → 88.5、万古磐石歌 38.5 → 39.1%），合唱谱各档不退；0.12 时合唱谱干净档满拍自检 66.02 → 65.69%。
 */
const FLAG_INK = 0.15;
/**
 * 符尾那个窗口的**横向范围**（线距的倍数，从符干中心往右算）。
 *
 * 原来放到 1.5 格，太宽：这套底本的八分符尾是**一条细弧**，
 * 从符干尖端斜挂下来、横跨也只有 0.9 格（实测破碎 p2 x453 那个八分，
 * 符尾占 x453~468、纵跨 2.7 格，每行只有两三个像素）。
 * 窗口比符尾宽出一半，占比就被空白摊薄。
 * 扫过 0.8 / **1.0** / 1.3：时值 92.1 / 92.1 / 90.9%。
 */
const FLAG_X = [0.15, 1.0] as const;
/** 符尾窗口的**纵向长度**（线距的倍数，从符干尖端往符头方向）。
 *  放到 2.5 格（罩住整条符尾）实测更差：符尾下半截是根细线，多罩进来的全是白的。 */
const FLAG_Y = 1.5;
/**
 * 贴着符干尖端那一小截要的墨（`FLAG_INK` 的伙伴）。
 *
 * 这一档**比整窗那一档松得多**：符尾在尖端是**贴着符干**走的（实测破碎 p2 x453
 * 那个八分，尖端往下 0.35 格里符尾只占符干右侧一两列，而窗口从 0.15 格外才开始数），
 * 拿整窗的门槛卡这一截，真符尾一个都过不去。这条闸要的只是「符尾确实从尖端长出来」，
 * 不是「这里墨很多」。
 */
const FLAG_TIP = 0.05;
/**
 * 那一小截的**纵向长度**（线距的倍数）。原来 0.35：合唱谱那套符尾在尖端就贴着符干。
 * 万古磐石歌那种老铅字的符尾从尖端**细细地**长出来，往下 0.3 格才变粗（放大后线距 22px，
 * 尖端 8 行里符干右侧只有一两个像素），八分整批读成四分。
 * 扫过 0.35 / 0.5 / **0.6**：万古磐石歌时值 22.4 / 23.0 / **31.6**%，别的曲子与合唱谱不动。
 */
const FLAG_TIP_Y = 0.6;
/** 第二道钩（十六分）的门槛。比第一道**严**：那一段窗口里还可能扫到下一个音的符干或符头。 */
const FLAG_INK2 = 0.3;
/** 两道钩的右缘轮廓中间要凹下去这么多格。 */
const HOOK_PROM = 0.15;
/** 符尾窗口与和弦字母条交叠超过这一成就不认。 */
const FLAG_AVOID = 0.2;

/**
 * **几个音共用的那条长加线，要按符头切成短段补进去。**
 *
 * 相邻几个音落在同一条加线上时，谱面上画的是**一条通长的横线**
 *（实测破碎 p4 两个音共用的那条 x[616,723]、长 **6.25 格**）。
 * 而下游有两道长度闸都是按「一个符头的加线」定的：
 * `findNoteheads` 只收 ≤ 6 格的横段、`findLegers` 还要求不超过符头宽的三倍。
 * 通长的那条两道都过不了，于是这些音**一条加线都找不到**
 *（实测未认领的符头里「需要 1 条、找到 0 条」占 155/259，这是头号成因）。
 *
 * 不去动那两道闸——它们防的是「和弦图的格线被当成加线」，是拿具体页换来的。
 * 改成在位图这边**按符头把长线切成短段**补进去：加线本来就是给符头垫的，
 * 一个符头配一小段，长度取符头宽的一倍半，语义与「剪出来的加线」那一路一致。
 *
 * 只切**落在谱线网格延长线上**的横段（`ledgerGrid`），那是加线的硬判据。
 */
function sharedLegers(hSegs: LineSeg[], heads: { box: Rect }[], onGrid: (y: number) => boolean, unit: RasterUnit): LineSeg[] {
  const out: LineSeg[] = [];
  for (const seg of hSegs) {
    const y = (seg.y0 + seg.y1) / 2;
    if (Math.abs(seg.x1 - seg.x0) <= unit.space * 3) continue; // 短的下游本来就收得下
    if (!onGrid(y)) continue;
    const left = Math.min(seg.x0, seg.x1);
    const right = Math.max(seg.x0, seg.x1);
    for (const h of heads) {
      const cx = h.box.x + h.box.w / 2;
      if (cx < left || cx > right) continue;
      // 窗口要放到三格：谱表外两三格的音，**里面那几条加线上并没有符头**
      //（实测「需要 2 条、找到 1 条」占 66 处，缺的就是里侧那条）。
      // 放宽不怕误收——`findLegers` 自己还要判「加线落在符头与谱表之间」。
      if (Math.abs(y - (h.box.y + h.box.h / 2)) > unit.space * 3.2) continue;
      const half = h.box.w * 0.8;
      out.push({ x0: Math.max(left, cx - half), y0: y, x1: Math.min(right, cx + half), y1: y, lw: seg.lw, maxLw: seg.maxLw });
    }
  }
  return out;
}

/**
 * 骑在加线上的符头，按它自己的位置补一条加线（验过那一带确实有墨）。
 *
 * 判据：中心落在加线网格上（`ledgerGrid`）、且沿中心线左右各半个符头宽的范围内，
 * 六成以上的列在 ±线宽 内有墨。补出来的段按符头宽的一倍二，与 `trimLedger` 那条同口径。
 */
function ownLegers(heads: { box: Rect }[], bin: Binary, onGrid: (y: number) => boolean, unit: RasterUnit): LineSeg[] {
  const out: LineSeg[] = [];
  const th = Math.max(1, Math.round(unit.lineThick));
  for (const h of heads) {
    const cy = h.box.y + h.box.h / 2;
    const cx = h.box.x + h.box.w / 2;
    const half = h.box.w * 0.6;
    // 候选位置：符头**自己骑着的**那条网格线，以及**上下各半格**的那条
    // ——符头落在加线上面/下面那一间时，压着它的那条加线同样抽不出来
    //（那一带的纵向游程是「符头 + 线」的高度，出了「细」的那道闸），
    // 而它正是 `findLegers` 要数的那一条。
    for (const y of [cy, cy - unit.space / 2, cy + unit.space / 2]) {
      if (!onGrid(y)) continue;
      let ink = 0;
      let n = 0;
      for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) {
        if (x < 0 || x >= bin.w) continue;
        n++;
        for (let d = -th; d <= th; d++) {
          const yy = Math.round(y) + d;
          if (yy >= 0 && yy < bin.h && bin.data[yy * bin.w + x]) {
            ink++;
            break;
          }
        }
      }
      if (!n || ink < n * 0.6) continue;
      out.push({ x0: cx - half, y0: y, x1: cx + half, y1: y, lw: th, maxLw: th });
    }
  }
  return out;
}

/** `staffBandOnly` 时谱表上下各留这么多个线距。扫过 1.5 / 2 / 3.5 格（《坚固保障》，和弦字母在上方 1.6 格处）：
 *  音符 74 / 75 / 80，其中 3.5 格那档有 5 个是被当成全音符的和弦字母。2 格是拐点。 */
const STAFF_BAND = 2;

/** 位图符杠 → 矢量路的 `BeamShape`（`buildNotes` / `findTuplets` 吃这个）。 */
function toBeamShapes(beams: BeamQuad[]): BeamShape[] {
  return beams.map((b) => {
    const box: Box = { left: b.box.x, right: b.box.x + b.box.w, top: b.box.y, bottom: b.box.y + b.box.h };
    return { box, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, level: 0 };
  });
}

/** 认一页。顺序照 `staffomr/index.ts::recognizeStaffPage`，**别调**。 */
export async function recognizeRasterPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfPage: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  OPS: any,
  look: RasterGlyphLookup,
  index: number,
  opts: {
    carryTime?: { beats: number; beatType: number };
    /**
     * 歌词条的 OCR 结果，**按条的内容指纹寻址**（`stripKey`）。
     *
     * 直接用 OCR 的文本，不做形状聚类——聚类那一版实测把四成多的字格丢在
     * 「类里投不出过半票」上（覆盖 52%，歌词 35%）。
     * 缓存由 `scripts/gen-rasterlyrics.mjs` 生成：起一次浏览器把全语料的条跑完落盘，
     * 之后识别命中缓存，仍然不起浏览器。
     */
    lyricOcr?: Map<string, OcrChar[]>;
    /** 声部标签的 OCR 缓存（`scripts/gen-rasterlabels.mjs` 的产物）。见 `stafflabel.ts`。 */
    labelOcr?: Map<string, string>;
    /** 和弦条的 OCR 缓存（`scripts/gen-rasterharmony.mjs` 的产物）。见 `harmony.ts`。
     *  值的类型与歌词缓存共用（`OcrChar`）——两边都是「整条送 rec，回来字符带条内 x」。 */
    harmonyOcr?: Map<string, OcrChar[]>;
    /** 简谱行的离线识别缓存（`scripts/gen-rasterjianpu.mjs` 的产物）。混排谱拿它给五线谱纠错，见 `jianpufuse.ts`。 */
    jianpuOcr?: Map<string, JianpuRow[]>;
    /** 排查用：把连通块与「谁被认领了」带出来（`debugBlobs` 字段）。识别判据一条不改。 */
    debug?: boolean;
    /**
     * 谱表带之外的墨一律抹掉（上下各 `STAFF_BAND` 个线距）。**排查用，正路别开**。
     *
     * 从前立 GT 底稿要靠它挡住和弦字母（字母被收成符头，见下面那一处的实测）；
     * 现在和弦带在找符头**之前**就按检测框认领掉了（`harmony.ts`），那条理由没了。
     * 留着是因为排查「某个东西是不是带外的墨引起的」时一开就见分晓。
     * **开了歌词与和弦都没有**。
     */
    staffBandOnly?: boolean;
  } = {},
): Promise<RasterPageResult> {
  const raster = await rasterizePage(pdfPage, OPS);
  const blank = buildRasterPage({ index, width: raster?.bin.w ?? 1, height: raster?.bin.h ?? 1, unit: { lineThick: 1, space: 1, height: 4 }, staffLines: [], hSegs: [], vSegs: [] });
  if (!raster) return empty(blank, null, null, opts.carryTime);
  const unit = estimateUnit(raster.bin);
  if (!unit) return empty(blank, raster, null, opts.carryTime);
  // 行投影找谱线；**明显不够的页面**（扫得糊、线细断）再拿逐列游程的轨迹补上
  // ——判据与推平同一道闸，见 `dewarp.ts::completeStaffLines`。
  const rowLines = findStaffLines(raster.bin);
  const { lines, groups } = completeStaffLines(raster.bin, rowLines, groupStaves(rowLines));
  if (!groups.length) return empty(blank, raster, unit, opts.carryTime);
  // 谱线左端顺着线再往左追（弯页左段落在横带外，见 `traceLeft`）。一行谱五条线的左端
  // 本该一致，追的时候中间几条常被谱号挡住（齐来称颂第一行追到 153/209/216/193/153），
  // 取**至少两条吻合的最小左端**统一给五条线——下游一律拿五条线左端的最大值当谱行左缘。
  for (const g of groups) {
    const ls = g.lines.map((l) => traceLeft(raster.bin, l.left, l.y0, l.y1)).sort((a, b) => a - b);
    const agreed = ls.find((v) => ls.filter((u) => Math.abs(u - v) <= 3).length >= 2);
    // 只在差出两格以上时改：扫描件的左端本来就参差几个像素，照改会把谱号、括号的窗口
    // 挪动一点点，合唱谱扫描件歌词实测跌 5 个点。
    const cur = Math.max(...g.lines.map((l) => l.left));
    if (agreed !== undefined && cur - agreed > unit.space * 2) for (const l of g.lines) l.left = Math.min(l.left, agreed);
  }

  // **只留谱表带**（默认不开，立 GT 底稿时才开）。独唱谱那种谱表上方印和弦字母的底本，
  // 字母「C」是个圈，正落在空心符头那一档里（`HOLLOW_BAND` 上下各让三格，字母就在里面）；
  // 谱表下方的歌词字同理被收成实心符头——实测《坚固保障》整页多出六个 D6/E6 全音符、
  // 四个 C3 四分音符。歌词与和弦都不要的场合（出 GT 底稿）直接把带外的墨抹掉最省事。
  // **识别判据一条不改**：抹的是输入，不是判据。
  if (opts.staffBandOnly) {
    const bin = raster.bin;
    const keep = new Uint8Array(bin.h);
    for (const g of groups) {
      const sp = (g.lines[4].y - g.lines[0].y) / 4;
      const y0 = Math.max(0, Math.round(g.lines[0].y - sp * STAFF_BAND));
      const y1 = Math.min(bin.h - 1, Math.round(g.lines[4].y + sp * STAFF_BAND));
      for (let y = y0; y <= y1; y++) keep[y] = 1;
    }
    for (let y = 0; y < bin.h; y++) if (!keep[y]) bin.data.fill(0, y * bin.w, (y + 1) * bin.w);
  }

  const nl = removeStaffLines(raster.bin, lines.map((l) => l.y), unit);
  const staffLefts = groups.map((g) => Math.max(...g.lines.map((l) => l.left)));
  // **加线网格只认分好组的线**。`ledgerGrid` 按「五条一组」取锚点，
  // 混进没成组的线（通长的加线、噪声横线）锚点就全错位，
  // 于是加线判不出来——而谱表外的符头**要有加线撑着才归得了谱行**
  // （实测宁静 p5 八度跑动上方那七个符头，认出来了却一个都没归属，窗口里一条横段都没有）。
  const gridYs = groups.flatMap((g) => g.lines.map((l) => l.y));
  // 没进任何一组的行投影线：多半是**通长的加线**（见 `staffLines` 那一处的说明）
  const groupedLines = new Set(groups.flatMap((g) => g.lines));
  const strayLines: LineSeg[] = lines
    .filter((l) => !groupedLines.has(l))
    .map((l) => ({ x0: l.left, y0: l.y, x1: l.right, y1: l.y, lw: l.y1 - l.y0 + 1, maxLw: l.y1 - l.y0 + 1 }));
  const prims = findPrimitives(nl, unit, gridYs, staffLefts, raster.faint);

  // ── 简谱行（混排谱）：**先于一切**认领 ─────────────────────────────────────
  //
  // 谱表正上方那行简谱的数字、增时线、高低音点，不挡就被收成全休止和加线上的符头
  //（见 `jianpuband.ts`）。整块落在带里的墨从两张图上抹掉，带里的原语一并摘掉；
  // 抹之前把条切下来，留给离线认简谱。定位判据是「短竖线与谱表小节线同 x」，
  // 独唱谱、合唱谱对不上，这一段对它们空转。
  const jianpuBands = findJianpuBands(
    prims.vSegs,
    groups.map((g) => ({ left: Math.max(...g.lines.map((l) => l.left)), right: Math.min(...g.lines.map((l) => l.right)), top: g.lines[0].y, bottom: g.lines[4].y })),
    unit,
  );
  const jianpuStrips = jianpuBands.map((b) => cutJianpuStrip(raster.bin, b));
  if (jianpuBands.length) {
    for (const b of jianpuBands) eraseInBand([raster.bin, nl], b.box);
    const inJp = (x: number, y: number) => jianpuBands.some((b) => x >= b.box.x && x <= b.box.x + b.box.w && y >= b.box.y && y <= b.box.y + b.box.h);
    const outside = (v: { x0: number; y0: number; x1: number; y1: number }) => !(inJp(v.x0, v.y0) && inJp(v.x1, v.y1));
    prims.vSegs = prims.vSegs.filter(outside);
    prims.hSegs = prims.hSegs.filter(outside);
    prims.beams = prims.beams.filter(outside);
  }
  const blobs = findBlobs(nl, prims, unit, ledgerGrid(gridYs, unit));

  // ── 和弦带：**先于符头认领** ──────────────────────────────────────────────
  //
  // 独唱谱在谱表上方印和弦字母。`C`、`D`、`G` 都是圈，正落在空心符头那一档里
  // （`HOLLOW_BAND` 上下各让三格，字母就在里面）——实测《坚固保障》整页因此
  // 多出六个 D6/E6 全音符、四个 C3 四分音符。从前是拿 `staffBandOnly` 把带外的墨
  // 整片抹掉换干净的，那是遮挡不是识别，和弦与歌词一起没了。
  //
  // 现在按**检测框**认领：缓存里有这条带的 OCR 结果才认领，没有就什么也不做
  // ——合唱谱那批没有和弦带缓存，这一段对它是空转，基线不动。
  // **只看系统的首行**：闭合谱、合唱谱下面几行谱表的上方不印和弦，那里是上一行的歌词与
  // 带加线的高音符头（《赞美一神》低音谱表上方的男高 D4 被读成「D」）。
  // 判据是谱表左端的系统线从上一行连下来。
  const joinedAbove = (i: number) =>
    i > 0 &&
    prims.vSegs.some((v) => {
      const left = Math.max(...groups[i].lines.map((l) => l.left));
      return Math.abs((v.x0 + v.x1) / 2 - left) <= unit.space && Math.min(v.y0, v.y1) <= groups[i - 1].lines[4].y + unit.space * 0.5 && Math.max(v.y0, v.y1) >= groups[i].lines[0].y + unit.space * 0.5;
    });
  const pageRight = Math.max(...groups.flatMap((g) => g.lines.map((l) => l.right)));
  const harmonyStrips = findHarmonyStrips(
    raster.bin,
    groups.flatMap((g, i) => joinedAbove(i) ? [] : [{
      box: {
        left: Math.max(...g.lines.map((l) => l.left)),
        // 右界取**全页谱线右端的最大值**：网点水印把谱线右段打断，五条线量出来的右端
        // 多数停在 1018~1233（真右端 1360），取最小值就切不到行尾的和弦（《求主同住》缺三个）
        right: pageRight,
        top: g.lines[0].y,
      },
      index: i,
      // 有简谱行的谱表，和弦字母印在简谱行上方
      ceiling: jianpuBands.find((b) => b.staff === i)?.box.y,
    }]),
    unit,
  );
  const harmonies: HarmonyToken[] = [];
  /** 和弦带里认出来的**文本**（词曲署名、Fine 之类）：不进和弦，单独交出去。 */
  const harmonyTexts: HarmonyToken[] = [];
  const harmonyIds = new Set<number>();
  const harmonyMasks: Rect[] = [];
  {
    // 一行谱一行：先逐条读，再按整行判是和弦行还是文本行（`harmonyLine`）
    const lines = new Map<number, { strip: HarmonyStrip; chords: HarmonyToken[] }[]>();
    const lineTexts = new Map<number, HarmonyToken[]>();
    for (const strip of harmonyStrips) {
      const chars = opts.harmonyOcr?.get(harmonyKey(strip));
      if (!chars?.length) continue; // 缓存没命中：这条没跑过 OCR，宁可不认领
      const { chords, texts } = readHarmonyStrip(strip, chars);
      if (!lines.has(strip.staff)) lines.set(strip.staff, []), lineTexts.set(strip.staff, []);
      lines.get(strip.staff)!.push({ strip, chords });
      lineTexts.get(strip.staff)!.push(...texts);
    }
    for (const [staff, rows] of lines) {
      const r = harmonyLine(rows.flatMap((x) => x.chords), lineTexts.get(staff)!);
      harmonyTexts.push(...r.texts);
      if (!r.chords.length) continue;
      harmonies.push(...r.chords);
      // 切不出和弦记号的条不认领：闭合谱低音谱表的顶上那条带里是带加线的高音符头
      //（《赞美一神》男高 D4/E4），OCR 读出几个字符、文法一个也不收，整条认领就把符头吃了。
      // **认领按条的盒，不按切出来的记号**：记号的 x 是 CTC 估的，误差常有半个字；
      // 条的盒是列投影裁紧的，正是要挡掉的那一簇墨。
      for (const x of rows) if (x.chords.length) harmonyMasks.push(x.strip.box);
    }
    // 条贴着墨迹裁，往外放半格容下笔画的毛边
    const pad = unit.space * 0.5;
    for (const c of blobs) {
      const b = c.bbox;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (harmonyMasks.some((m) => cx > m.x - pad && cx < m.x + m.w + pad && cy > m.y - pad && cy < m.y + m.h + pad))
        harmonyIds.add(c.id);
    }
  }

  // ── contour 层与认领账本 ─────────────────────────────────────────────────
  //
  // 在**去谱线图**上取轮廓（原图上五条谱线把整行谱连成一团），一团墨一个号；
  // 下面每认出一样东西就按它的盒记一笔。识别判据一条不改——账本只记账。
  const cmap = traceContours(nl, unit, groups.map((g) => ({
    top: g.lines[0].y,
    bottom: g.lines[4].y,
    left: Math.max(...g.lines.map((l) => l.left)),
    right: Math.min(...g.lines.map((l) => l.right)),
  })));
  const ledger = new ContourLedger(cmap);
  // **段要等下游挂上标记再记**（`findStaves` / `findLegers` / `findStems` /
  // `findBarlines` 之后，见下面那一处）：`findPrimitives` 抽出来的横段里混着松叶的臂、
  // 连音线的一截——照抽出来就记，这些正是要找的东西反而成了「有主的」。
  // 符杠**按中心线那条带记账**，与 `blobImage` 抹墨的口径一致。
  // 记包围盒会把贴着符杠的符头也算成「有主」——账本于是查不出钢琴行漏在哪
  //（实测那一带无主 contour 只剩 8 个碎点，而那一行少了 9 个音）。
  for (const b of prims.beams) {
    const x0 = Math.min(b.x0, b.x1);
    const x1 = Math.max(b.x0, b.x1);
    const half = Math.max(1, b.lw / 2 + 2);
    const steps = Math.max(1, Math.round((x1 - x0) / Math.max(1, unit.space / 2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const cy = b.y0 + (b.y1 - b.y0) * t;
      ledger.claim({ x, y: cy - half, w: Math.max(2, (x1 - x0) / steps), h: half * 2 }, "beam");
    }
  }

  // 符头按性质判（填充率 + 有没有符干），不查字典；其余的块查字典。
  const onGrid = ledgerGrid(gridYs, unit);
  // 空心符头要卡在谱表带里（见 `findRasterHeads` 的说明）。
  //
  // **上下各让三格**，不是一格：一格只罩得住谱表之内，可**谱表外一两格的空心符头
  // 是常态**（间里的、带一两条加线的）——实测宁静 p1 那行叠置的空心和弦，
  // 有一个头的中心只比「一格」的边界多出半个像素就被拒了，整行五个小节只剩一个音。
  // 门槛扫过 1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 格：
  // 音符 67.68 / 67.72 / 67.96 / 68.08 / **68.10** / 68.08 / 68.08，
  // 小节自检 37.7 / 38.2 / 39.5 / 39.9 / **40.1** / 40.1 / 40.1，
  // 而**歌词在四格以上开始垮**（50.0 → 46.8 → 45.1，歌词带里的字被收成空心符头）。
  // 三格是拐点。
  const inBand = (y: number) =>
    groups.some((g) => y > g.lines[0].y - unit.space * HOLLOW_BAND && y < g.lines[4].y + unit.space * HOLLOW_BAND);
  /** 中心在某行谱五条线之外、隔着至少一格（延长记号只在这里出现）。 */
  const offStaff = (y: number) =>
    !groups.some((g) => y > g.lines[0].y - unit.space && y < g.lines[4].y + unit.space);
  const matchHollow = look.templates
    ? (box: Rect) => matchTemplate(binSig(nl, box), box.w / unit.space, box.h / unit.space, look.templates!)
    : null;
  // ── 整小节休止：**先摘出来，别让符头那一路吃掉** ─────────────────────
  //
  // 全休止是个 1.34×0.64 格、填充 0.92 的实心小矩形——**正好落在实心符头那一档里**
  //（宽 0.85~1.85、高 ≥0.55、填充 ≥0.62），于是整批被判成 `noteheadBlack`：
  // 实测破碎 GT 中段有 129 个全休止，我们只出 33 个休止，多出来的音符正是它们。
  // 字典也指望不上（那三页 25 个休止大小的块只认出 11 个）。
  //
  // 判据是**形状 + 位置**：矩形（填充 ≥0.85）、扁（宽高比 ≥1.8，符头是 1.3 的椭圆）、
  // 高不过 0.8 格，再过一道 `nearRestLine`（全休止吊在二线下、半休止坐在三线上）。
  // 全/半由 `notedata.ts` 按几何再分。
  // **一头贴着竖笔的是符杠，不是休止**：两个八分音符的短符杠斜着穿过谱线，
  // 去谱线后夹在两线之间的那一截正是个扁实心矩形——整小节休止这一路与字典那一路
  // 都会收它（《是谁》每行一两处，认成全休止/二分休止，那一小节随之作废）。
  // 斜着切的，那一截只挨得着一头的符干；休止两头都不挨符干（后面紧跟的音符，符干离它至少一格）。
  const besideStem = (b: Rect) => {
    const stemAt = (x: number) =>
      prims.vSegs.some((v) => {
        const vx = (v.x0 + v.x1) / 2;
        return Math.abs(vx - x) <= unit.space * 0.4 && Math.min(v.y0, v.y1) <= b.y + b.h + unit.space * 0.5 && Math.max(v.y0, v.y1) >= b.y - unit.space * 0.5;
      });
    return stemAt(b.x) || stemAt(b.x + b.w);
  };
  const restIds = new Set<number>();
  const restSyms: RasterSym[] = [];
  for (const c of blobs) {
    const b = c.bbox;
    const w = b.w / unit.space;
    const h = b.h / unit.space;
    // **高度要把粘着的那截谱线扣掉**。全/半休止是贴着谱线画的（全休止吊在第二线下、
    // 半休止坐在第三线上），去谱线时它底下/头上那一截「上方有墨」，照判据留了下来，
    // 并进同一个块——块高于是多出一个线宽，宽高比也跟着掉。线细时还挤得进闸门，
    // 线一粗就整批卡死：破碎扫描件线宽 4.4px、线距 18.8px，1.34×0.64 格的全休止
    // 量出来是 **0.87 格高、宽高比 1.54**，`REST_H` 与 `REST_RATIO` 两道全过不去
    // ——实测 GT 475 个休止只出 178 个，漏的那 300 个正是全休止（GT 里有 306 个）。
    // 干净版也只是勉强擦边（0.79 格），所以两档一起受益。
    const hRest = Math.max(0.1, h - unit.lineThick / unit.space);
    if (w < REST_W[0] || w > REST_W[1] || hRest < 0.3 || hRest > REST_H) continue;
    if (w < hRest * REST_RATIO) continue;
    if (c.area / Math.max(1, b.w * b.h) < REST_FILL) continue;
    if (!nearRestLine(b, lines, unit)) continue;
    if (besideStem(b)) continue;
    restIds.add(c.id);
    restSyms.push({ box: b, code: restKind(b, lines, unit) });
  }
  // **斜笔被抽成竖段的八分休止**：斜笔陡，原语那一步当竖段提走，块图里只剩上头的球
  //（《向主唱新歌》高音谱表下声部一排八分休止，球被歌词行收走）。拿球在去线图上把整个连通域
  // 回填出来，再按八分休止的形状判（`isEighthRest`）。
  for (const c of blobs) {
    if (restIds.has(c.id)) continue;
    const b = c.bbox;
    if (b.w > unit.space * 0.8 || b.h > unit.space * 1.0 || b.h < unit.space * 0.4) continue;
    if (!inBand(b.y + b.h / 2)) continue;
    const full = fillAround(nl, b, unit);
    if (!full || full.box.h < b.h * 1.8) continue;
    if (!isEighthRest(nl, full.box, full.area, unit)) continue;
    restIds.add(c.id);
    restSyms.push({ box: full.box, code: "rest8th" });
  }

  /** 块的中心压在某条符杠的中线上（半个杠厚以内）：那是提走符杠之后剩下的杠头，不是符头。 */
  const onBeamLine = (b: Rect) => {
    const cxb = b.x + b.w / 2;
    const cyb = b.y + b.h / 2;
    return prims.beams.some((q) => {
      if (cxb < Math.min(q.x0, q.x1) || cxb > Math.max(q.x0, q.x1)) return false;
      const t = q.x1 === q.x0 ? 0 : (cxb - q.x0) / (q.x1 - q.x0);
      return Math.abs(cyb - (q.y0 + (q.y1 - q.y0) * t)) <= Math.max(q.lw, unit.space * 0.25);
    });
  };
  // 几何闸那一路同样要剔杠头：善牧恩慈歌放大后，符杠左端提剩的一截 0.86×0.6 格，
  // 刚好卡过实心头的尺寸下限，出了个 F5。只剔**矮**的（不到 0.65 格）：贴着符杠、又被去线
  // 削扁的真头中心也会落在杠的中线上（宁静的伯利恒三个 1.1×0.72 格的，门槛 0.75 时被剔掉）。
  const heads = findRasterHeads(nl, blobs.filter((c) => !restIds.has(c.id) && !harmonyIds.has(c.id)), prims.vSegs, unit, onGrid, inBand, matchHollow, offStaff)
    .filter((hd) => hd.code !== "noteheadBlack" || hd.box.h >= unit.space * BEAM_STUMP_H || !onBeamLine(hd.box));
  const claimed = new Set([...heads.map((h) => h.comp.id), ...restIds, ...harmonyIds]);

  // ── 空心符头：按**内腔（洞）**再找一遍 ───────────────────────────────────
  //
  // 空心符头被去谱线切碎之后一块都判不成符头（实测宁静 p2 钢琴右手那个二分和弦
  // 碎成四片），而它的**内腔**还在。所以在**去谱线之前**的图上取全页的孔，
  // 尺寸像内腔的往外扩一圈就是符头；骑线的头内腔被谱线豁成两半，先并回去。
  // 判据全在 `notehead.ts::hollowHeadsFromHoles`。
  const rawHoles = findHoles(raster.bin, Math.max(4, Math.round(unit.space * unit.space * 0.06)));
  // 缝落在谱线或加线上都算（`onGrid` 只管谱表外的加线位置）：《高举主大能》第三线上的 B4 二分头
  // 被第三线切成 10×5 与 13×5 两半，谱线上的不认就并不回来，头盒只剩下半截、读低一格
  const onLineOrGrid = (y: number) => onGrid(y) || gridYs.some((ly) => Math.abs(ly - y) <= unit.space * 0.25);
  const holes = mergeHoles(rawHoles, unit, onLineOrGrid);
  // 和弦字母的**内腔**也是洞（`D`/`G`/`B`/`A` 都有），不挡住就从这一路漏回来
  // ——检测框一并算「已被占」。
  const takenBoxes = [...heads.map((h) => h.box), ...harmonyMasks];
  // 带宽照 `HOLLOW_BAND`（±3 格）。扫过 ±1.5 / ±2 / ±3 格，三档一样
  // ——这一路的过检不在带边上。
  const stacked: RasterSym[] = hollowHeadsFromHoles(nl, holes, unit, prims.vSegs, inBand, takenBoxes);
  // 并成一个高内腔的叠置空心和弦：按音高位置逐一配模板（`notehead.ts::hollowHeadsByPitch`），
  // 模板拿本页已认出的空心头（骑线 / 在间各一张）
  const lineYs = lines.map((l) => l.y);
  const hollowSamples = [...heads.map((h) => ({ box: h.box, code: h.code })), ...stacked].filter((s0) => !(s0 as { weak?: boolean }).weak);
  const hollowMasks = buildHollowMasks(raster.bin, hollowSamples, unit, lineYs);
  stacked.push(...hollowHeadsByPitch(raster.bin, nl, rawHoles, holes, hollowMasks, unit, makePitchSteps(groups), prims.vSegs, inBand, takenBoxes));
  // 谱表外骑加线的斜缝空心头：沿加线逐位置配同一组模板（`notehead.ts::hollowHeadsOnLedgers`）
  // 竖段表里没有、靠墨柱判出来的干：只进 `SPage`（与 `stemSegs` 同理），`buildNotes` 定时值要它
  const inkStems: LineSeg[] = [];
  stacked.push(...hollowHeadsOnLedgers(raster.bin, nl, rawHoles, hollowMasks, unit, ledgerCandidates(raster.bin, groups), makePitchSteps(groups), prims.vSegs, takenBoxes, inkStems));

  // ── 几个实心符头并成一块：按**谱内自举的 mask** 拆开 ─────────────────────
  //
  // 钢琴谱里二度、三度的和弦把两三个符头画得挨着（二度还错开在符干两侧），
  // 位图上并成一块，单头的尺寸闸一律判否——逐谱行摊开，钢琴两行漏得最狠
  //（宁静 P4.1 漏 122、破碎 P6.1 漏 213）。判据与搜索都限死在块内，见 `headmask.ts`。
  const masks = buildHeadMasks(raster.bin, [...heads.map((h) => ({ box: h.box, code: h.code })), ...stacked], unit, lines.map((l) => l.y));
  // **拆和弦另用一张「符杠已擦」的图**，模板也在这张图上自举。
  //
  // 病因是量出来的（`scripts/raster-gap.mjs`）：漏掉的音里 **63.6% 焊在一团
  // 大于 4×3.2 格的墨里**——符杠 + 几根符干 + 几个头。在原图上给这种块打分，
  // 模板窗口上下那片「该有白」正压着符杠，spill 一扣分就没了。
  // 试过放松 spill（整体压到 0.5、或只算左右两侧）：**两次都把干净档打崩**
  //（85.09% → 78.63% / 75.71%），那一项正是拆块不出假头的关键，动不得。
  // 换图就两全：符杠不在图里，spill 照旧全额算。
  const noBeam = blobImage(nl, prims, unit, onGrid);
  const masksNB = buildHeadMasks(noBeam, [...heads.map((h) => ({ box: h.box, code: h.code })), ...stacked], unit, lines.map((l) => l.y));
  const pitchGrid = makePitchGrid(groups, unit);
  const onLineY = (y: number) => lines.some((l) => Math.abs(l.y - y) <= unit.space * 0.25);
  const split: RasterSym[] = [];
  /** 已经被认成**单个**符头、但要作废的那些（块里其实装着两三个头）。 */
  const dropHead = new Set<number>();
  const restTpl = (look.templates ?? []).filter((t) => t.smufl === "restQuarter" || t.smufl === "rest8th");
  if (masks.length) {
    for (const c of blobs) {
      if (claimed.has(c.id)) continue;
      let parts = splitHeadCluster(noBeam, c.bbox, c.area, masksNB.length ? masksNB : masks, unit, pitchGrid, onLineY);
      // **上下贴着的两个头**（三度和弦，一个头宽、两个头高、很实）：模板要头的上下是白的，
      // 贴着就各扣一截，两个都卡在门槛下（《来敬拜荣耀王》低音谱表的 E3/G♯3 得 0.45 / 0.42，门槛 0.46）。
      // 只对这种形状放到 0.40，而且要正好拆出两个、上下隔开 0.8 格以上。
      if (!parts.length && isStackedPair(c.bbox, c.area, unit)) {
        const p2 = splitHeadCluster(noBeam, c.bbox, c.area, masksNB.length ? masksNB : masks, unit, pitchGrid, onLineY, false, undefined, 2, PAIR_SCORE_MIN);
        if (p2.length === 2 && Math.abs(p2[0].y - p2[1].y) >= unit.space * 0.8) parts = p2;
      }
      if (!parts.length) continue;
      claimed.add(c.id);
      for (const b of parts) split.push({ box: b, code: "noteheadBlack" });
    }
    // **已经认成一个符头的块也要再看一眼**：漏掉的和弦成员多半就藏在这里
    // ——块被认成「一个符头」，实际装着两个（三度上下贴着、二度错开），
    // 而账本上它是「有主」的，无主报表里根本看不见（钢琴带内只剩碎点）。
    // 实测破碎钢琴右手纸上 1188 个符头，只检出 911。
    // 拆得出两个以上才作废原来那一个，拆不出就当没看过。
    for (const h of heads) {
      const b = h.comp.bbox;
      if (b.h < unit.space * 1.5 && b.w < unit.space * 1.9) continue; // 单头装得下，不动
      const parts = splitHeadCluster(noBeam, b, h.comp.area, masksNB.length ? masksNB : masks, unit, pitchGrid, onLineY);
      if (parts.length < 2) continue;
      dropHead.add(h.comp.id);
      for (const p of parts) split.push({ box: p, code: h.code === "noteheadBlack" ? "noteheadBlack" : h.code });
    }
  }

  const syms: RasterSym[] = [
    ...heads.filter((h) => !dropHead.has(h.comp.id)).map((h) => ({ box: h.box, code: h.code })),
    ...stacked,
    ...split,
    ...restSyms,
  ];
  for (const h of heads) ledger.claim(h.box, `head:${h.code}`);
  for (const s0 of stacked) ledger.claim(s0.box, `stack:${s0.code}`);
  for (const s0 of split) ledger.claim(s0.box, "cluster:noteheadBlack");
  for (const s0 of restSyms) ledger.claim(s0.box, "rest:restHBar");
  const dictClaimed = new Set<number>();
  const metIds = new Set<number>();
  for (const c of blobs) {
    if (claimed.has(c.id)) continue;
    const code = look.lookup(binSig(nl, c.bbox), c.bbox.w / unit.space, c.bbox.h / unit.space);
    if (!code) continue;
    // **演奏记号贴着音符**：离所有谱表都四格半开外的「保持音」「断奏」是歌词字的横笔、点
    //（《赞美一神》「上」「军」底下那一横，吃掉之后那个字就从歌词行里缺了）
    // **复合音符字形先记下**：字典里 `metNote*` 这几类是「头 + 干（+ 尾）」连成一块的音符，
    // 按类名定时值会把带尾的八分当四分（《主我敬拜你》五处）。「头 + 干」那一路再试一次，
    // 摘得出头就换成它（符干进 SPage、符尾照常补），摘不出才留字典这一个（颂赞与尊贵的 A4 四分）。
    if (code.startsWith("metNote")) metIds.add(c.id);
    if (code.startsWith("artic") && !groups.some((g) => c.bbox.y + c.bbox.h > g.lines[0].y - unit.space * ARTIC_REACH && c.bbox.y < g.lines[4].y + unit.space * ARTIC_REACH)) continue; // 不记账：留给歌词
    dictClaimed.add(c.id);
    // **半/全休止要按位置验一道**：它的字形是个 1.27×0.51 格的小实心矩形，
    // 位图上这种碎块一大把（符杠断头、粗横笔的一截），实测宁静一首认出 43 个
    // 全部被采纳，而谱面上根本没那么多。它有一条硬位置：
    // 半休止**坐在中线上**、全休止**吊在上面一线下**——不贴着这两条线的不是它。
    if (isBarRest(code) && (!nearRestLine(c.bbox, lines, unit) || besideStem(c.bbox))) continue;
    syms.push({ box: c.bbox, code });
    ledger.claim(c.bbox, `dict:${code}`);
  }

  // **谱号兜底**：字典查不到的谱行，按位置补一个。
  //
  // 谱号是音高的基准，缺一行整行的音高就错；而它还是 `buildScore` 连跨系统谱行的
  // 主要凭据（`StaffToken` 的第一项就是行首谱号），缺了那一行会另起一个声部，
  // 一个声部因此碎成好几条——实测宁静一首 GT 5 条谱表、识别出 9 条，
  // 六成的音落在没配上的那几条里，准确率逐段漂到 0。
  // 字典能查到 85/100 行，位置自举能到 91/100，两者并起来才够。
  const bootStaves: BootStaff[] = groups.map((g) => ({
    left: Math.max(...g.lines.map((l) => l.left)),
    right: Math.min(...g.lines.map((l) => l.right)),
    lineYs: g.lines.map((l) => l.y),
  }));
  const boxes = blobs.map((c) => ({ x: c.bbox.x, y: c.bbox.y, w: c.bbox.w, h: c.bbox.h }));
  // 谱号**盖过字典**：字典按连通块查，谱号被自己的笔画切开时它只看到半截，
  // 尺寸恰好像另一种谱号（宁静 p7 的高音谱号上半截 2.76×2.65 与 Maestro 的
  // fClef 模板 2.84×3.34 只差一点），认成 fClef 比认不出来更糟。
  // 自举那一路先把 x 上重叠的碎块并回一个盒，再拿模板签名比——那才是完整的谱号。
  for (const h of bootstrapClefs(boxes, bootStaves, unit.space, look.templates ? { tpl: look.templates, sigOf: (b) => binSig(nl, b) } : undefined)) {
    const b = h.box ?? blobs[h.index].bbox;
    // 落在这个盒里的字典结果作废（那是被切开的半截）。**按中心判**，不要求整个在盒里：
    // 低音谱号的圆头被当成全音符符头时，盒比谱号盒高出几个像素（《善牧恩慈歌》第二行
    // 出了个 G3 全音符；坚固保障高音谱号底下的圆球也被认成过两个黑符头），整盒判就漏了。
    // 谱号盒里不会有真音符。
    for (let i = syms.length - 1; i >= 0; i--) {
      const s0 = syms[i].box;
      const cx0 = s0.x + s0.w / 2;
      const cy0 = s0.y + s0.h / 2;
      if (cx0 >= b.x - 1 && cx0 <= b.x + b.w + 1 && cy0 >= b.y - 1 && cy0 <= b.y + b.h + 1) syms.splice(i, 1);
    }
    syms.push({ box: b, code: h.code });
    ledger.claim(b, `clef:${h.code}`);
  }

  // ── 碎块并起来再查一次字典 ────────────────────────────────────────────────
  //
  // 谱号那一路证明了这条：符号常被自己的笔画切开（中央竖笔、两道横笔被当成原语抽走），
  // 按连通块查字典就只看到半截。休止符与升降号同理——它们也压在谱线上、也有细笔画。
  // 把**x 上重叠、上下又贴着**的未识别块并起来（谱线间距的四成以内算贴着），
  // 并完再查一次；查得到才认。x 分开的不并（那是相邻的两个符号）。
  const unmatched = blobs.filter((c) => !claimed.has(c.id) && !dictClaimed.has(c.id));
  const merged = new Set<number>();
  for (const a of unmatched) {
    if (merged.has(a.id)) continue;
    let box = { ...a.bbox };
    const group = [a.id];
    for (let again = true; again; ) {
      again = false;
      for (const b of unmatched) {
        if (group.includes(b.id) || merged.has(b.id)) continue;
        const r = b.bbox;
        if (r.x > box.x + box.w || r.x + r.w < box.x) continue; // x 不重叠
        const gap = r.y > box.y ? r.y - (box.y + box.h) : box.y - (r.y + r.h);
        if (gap > unit.space * 0.4) continue;
        const x0 = Math.min(box.x, r.x);
        const y0 = Math.min(box.y, r.y);
        box = { x: x0, y: y0, w: Math.max(box.x + box.w, r.x + r.w) - x0, h: Math.max(box.y + box.h, r.y + r.h) - y0 };
        group.push(b.id);
        again = true;
      }
    }
    if (group.length < 2) continue;
    // 字典认不出就**按性质判一次符头**：空心符头骑在谱线上时会被去谱线切成两截，
    // 两截都不成符头、字典里也没有二分符头的类（见 `judgeHeadBox`）。
    const code = look.lookup(binSig(nl, box), box.w / unit.space, box.h / unit.space) ?? judgeHeadBox(nl, box, unit, prims.vSegs, inBand);
    if (!code) continue;
    if (isBarRest(code) && besideStem(box)) continue;
    for (const id of group) merged.add(id);
    syms.push({ box, code });
    ledger.claim(box, `merge:${code}`);
  }

  // ── 升降号：把**被抽走的那道竖笔**并回来 ─────────────────────────────────
  //
  // 降号是「一根细长的竖笔 + 底下一个小肚子」。竖笔沿途两侧都空着，
  // `isolated` 判它是原语、`findPrimitives` 把它抽成竖段，`blobImage` 随后照段抹墨
  // ——剩下的只有那个 0.58×1.05 格的小肚子，字典当然认不出
  //（实测破碎 p4 y=314 那行的调号降号就是这么丢的：竖段 x=113 y[285,324]，
  // 块只剩 [117,304]）。升号与还原号同理，只是它们有两道竖笔、丢得没这么彻底。
  //
  // 这一条是升降号的**主要漏因**：破碎 105 行谱有 31 行的调号一个升降号都没认出来，
  // 全谱升降号块 148 个，而调号加临时记号至少要 200 个。
  //
  // 还原号同理，只是它有**两道**竖笔：左边那道与横笔连成块、右边那道被抽走
  //（实测破碎 p10 那个还原号剩下 [582,1005] 0.53×2.34 格的块 + 竖段 x=593）。
  //
  // 修法照「碎块并回再查」那一条，只是这回要并的是**竖段**：块的左边或右边紧挨着
  // 一条纵向搭得上的竖段，就把两者的盒并起来重查一次字典。
  // 并完要把那条竖段**从 `vSegs` 里摘掉**——留着的话 `findStems` 会把它当符干，
  // `findBarlines` 会把它当小节线。
  const usedSegs = new Set<LineSeg>();
  // 调号位置：同一行谱的谱号右缘往右四格以内
  const clefSyms = syms.filter((s) => s.code === "gClef" || s.code === "fClef" || s.code === "cClef");
  const atKeySlot = (b: Rect) =>
    clefSyms.some((c) => b.y < c.box.y + c.box.h && b.y + b.h > c.box.y && b.x >= c.box.x + c.box.w - 1 && b.x <= c.box.x + c.box.w + unit.space * 4);
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    const bw = b.w / unit.space;
    const bh = b.h / unit.space;
    // 窄块才试：太宽的是符头或别的东西，太小的是噪点
    if (bw < 0.25 || bw > 1.3 || bh < 0.4 || bh > 3.4) continue;
    for (const v of prims.vSegs) {
      if (usedSegs.has(v)) continue;
      const vx = (v.x0 + v.x1) / 2;
      const vTop = Math.min(v.y0, v.y1);
      const vBot = Math.max(v.y0, v.y1);
      // 竖笔要**紧贴着块**（左边或右边都算）、纵向要与块搭上
      if (vx < b.x - unit.space * 0.5 || vx > b.x + b.w + unit.space * 0.5) continue;
      if (vBot < b.y || vTop > b.y + b.h) continue;
      const x0 = Math.min(b.x, Math.round(vx - v.maxLw / 2));
      const y0 = Math.min(b.y, Math.round(vTop));
      const box = {
        x: x0,
        y: y0,
        w: Math.max(b.x + b.w, Math.round(vx + v.maxLw / 2)) - x0,
        h: Math.max(b.y + b.h, Math.round(vBot)) - y0,
      };
      const w1 = box.w / unit.space;
      const h1 = box.h / unit.space;
      if (w1 < 0.4 || w1 > 1.7 || h1 < 1.5 || h1 > 3.6) continue;
      const sig = binSig(nl, box);
      let code = look.lookup(sig, w1, h1);
      if (!code || !isAccidental(code)) {
        // 字典不认就拿模板验。**只收降号**：它才是「一根竖笔 + 一个小肚子」、
        // 竖笔一被抽走就什么都不剩的那一种；升号与还原号各有两道竖笔，
        // 丢不干净，靠这条路补反而是过检（实测放开三种，破碎的还原号
        // 从 17 个涨到 70 个，而 GT 只有 24 个）。
        const m = matchTemplate(sig, w1, h1, look.templates ?? [], atKeySlot(box) ? KEY_ACCID_TEMPLATE_DIST : ACCID_TEMPLATE_DIST);
        code = m && isAccidental(m.smufl) ? m.smufl : null;
      }
      if (!code) continue;
      syms.push({ box, code });
      ledger.claim(box, `accid:${code}`);
      merged.add(c.id);
      usedSegs.add(v);
      break;
    }
  }

  // **两道横笔压在谱线上的还原号**：横笔与谱线重合，去线后只剩两根竖笔、切成几块碎墨，
  // 字典与上面那条都认不出（《向主唱新歌》高音谱表的 F♮ 三处，读成调号里的 F♯）。
  // 按结构认：从无主的窄碎块出发，在去线图上沿列量出整根竖笔；右边 0.35~0.8 格处另有一根，
  // 左高右低错开、纵向搭上一格以上，两根之间在**原图**上有两道横墨（整行从左笔连到右笔），
  // 各比谱线厚、相隔 0.6 格以上。
  // 字典认领过的窄块也当种子：竖笔单独一块时字典会把它认成 `wiggleTrill` 之类
  for (const c of blobs) {
    if (claimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    if (b.w > unit.space * 0.4 || b.h < unit.space * 0.3) continue;
    const sx = b.x + Math.floor(b.w / 2);
    const seed = vRunAt(nl, sx, b.y + Math.floor(b.h / 2));
    if (!seed) continue;
    let hit: Rect | null = null;
    for (const side of [1, -1]) {
      for (let dx = Math.round(unit.space * NAT_GAP[0]); dx <= unit.space * NAT_GAP[1] && !hit; dx++) {
        const ox = sx + side * dx;
        const [lx, rx] = side > 0 ? [sx, ox] : [ox, sx];
        // 搭档那根：在种子的纵向范围里找一行有墨的地方起量
        let other: [number, number] | null = null;
        for (let y = seed[0]; y <= seed[1] && !other; y++) if (nl.data[y * nl.w + ox]) other = vRunAt(nl, ox, y);
        if (!other) continue;
        const [L, R] = side > 0 ? [seed, other] : [other, seed];
        if (L[1] - L[0] < unit.space * 1.5 || R[1] - R[0] < unit.space * 1.5 || L[1] - L[0] > unit.space * 3.4 || R[1] - R[0] > unit.space * 3.4) continue;
        if (R[0] - L[0] < unit.space * 0.3 || R[1] - L[1] < unit.space * 0.3) continue;
        const ya = Math.max(L[0], R[0]);
        const yb = Math.min(L[1], R[1]);
        if (yb - ya < unit.space) continue;
        const bars = crossRuns(raster.bin, lx, rx, Math.round(ya - unit.space * 0.3), Math.round(yb + unit.space * 0.3));
        const thick = bars.filter((r) => r[1] - r[0] + 1 >= Math.max(unit.lineThick + 2, unit.space * 0.25));
        if (thick.length < 2 || thick[thick.length - 1][0] - thick[0][1] < unit.space * 0.6) continue;
        const x0 = lx - Math.round(unit.lineThick);
        hit = { x: x0, y: L[0], w: rx + Math.round(unit.lineThick) - x0 + 1, h: R[1] - L[0] + 1 };
      }
      if (hit) break;
    }
    if (!hit) continue;
    const box = hit;
    // 盒里的碎符号（竖笔认成的装饰音之类）换掉；与盒大片相交的别的符号在，就不认
    const inner = syms.filter((s0) => overlapFrac(s0.box, box) > 0.8 && s0.box.w * s0.box.h < box.w * box.h * 0.5);
    if (syms.some((s0) => !inner.includes(s0) && overlapFrac(box, s0.box) > 0.3)) continue;
    for (const s0 of inner) syms.splice(syms.indexOf(s0), 1);
    syms.push({ box, code: "accidentalNatural" });
    ledger.claim(box, "accid:accidentalNatural");
    for (const c2 of blobs) if (!claimed.has(c2.id) && overlapFrac(c2.bbox, box) > 0.8) merged.add(c2.id);
    for (const v of prims.vSegs) if ((v.x0 + v.x1) / 2 >= box.x && (v.x0 + v.x1) / 2 <= box.x + box.w && Math.min(v.y0, v.y1) >= box.y - 2 && Math.max(v.y0, v.y1) <= box.y + box.h + 2) usedSegs.add(v);
  }

  // ── 四分休止：**位置 + 形状自举**，字典兜不住 ──────────────────────────
  //
  // 四分休止在位图上被切得五花八门（它压着三条谱线，去谱线之后每一段的断法
  // 都不一样），签名于是散进一堆没定名的类里——实测全份只认出 90 个，
  // 而它是序列里最常见的休止（逐音比下来「漏掉」里 P6.1 有 27 个、P6.2 有 20 个是休止）。
  // 谱号与拍号走的是同一条路：**字典靠不住的那几类，改按位置 + 形状认**。
  //
  // 判据（都从认出来的那批量出来）：0.75~1.10 格宽、2.2~3.1 格高、填充 0.33~0.62，
  // 再要求**盒的中心落在谱表中线附近**（四分休止是竖着写在谱表正中的）。
  // 这三条合起来在谱面上几乎没有别的东西能同时满足：符干太窄、符头太矮、
  // 连音线太空、升降号在 0.6 格上下。
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    const w = b.w / unit.space;
    const h = b.h / unit.space;
    if (w < QREST_W[0] || w > QREST_W[1] || h < QREST_H[0] || h > QREST_H[1]) continue;
    const fill = c.area / Math.max(1, b.w * b.h);
    if (fill < QREST_FILL[0] || fill > QREST_FILL[1]) continue;
    if (!midOfStaff(b, lines, unit)) continue;
    // **行首的谱号 + 调号那一段里没有四分休止。**
    //
    // 降号是「一根竖笔 + 一个小肚子」，在这套底本上与四分休止太像；
    // 而降调的调号降号**正好落在中线上**，`midOfStaff` 这条位置判据非但拦不住它，
    // 反而给它放行。升降号自举那一路认不出的（字典没中、模板也没过）就漏到这里，
    // 被当成四分休止收走——实测破碎的 `restQuarter` 误检里裁图核对的三处**全是调号降号**
    // （`chorus-diff --errors` 出的清单：多出休止 36/50、音→休 31/53 都是 `restQuarter`）。
    //
    // 谱面上行首那一段是死的：谱号 + 调号最多占几格，真正的休止在它右边。
    if (nearStaffStart(b, groups, staffLefts, unit)) continue;
    merged.add(c.id);
    const code = isEighthRest(nl, b, c.area, unit) ? "rest8th" : "restQuarter";
    syms.push({ box: b, code });
    ledger.claim(b, `qrest:${code}`);
  }

  // ── 拍号：位置自举 + 模板验 ────────────────────────────────────────────────
  //
  // 字典里**一个拍号类都没有**（`rasterglyphs.json` 4144 个类未定名，拍号一个没定），
  // 所以拍号的识别率是 0——全语料一个都没认出来。这批曲子恰好都是 4/4、
  // 下游按缺省当 4/4 办，所以没露馅；换一首 3/4 的就整首错。
  //
  // 拍号数字还被自己的笔画切开（「4」的竖笔横向游程短，被当竖笔画抽走），
  // 按连通块查必然是碎的——实测宁静 p1 那个 4/4 切成 1.60×2.76 与 1.60×1.71
  // 两个**互相重叠**的盒。所以照谱号那条路走：先按位置圈出候选、
  // 把碎块并回上下两个盒，再拿模板签名验。
  /** 拍号数字模板，外加由「6」转 180° 派生的「9」（Maestro 那本没出现过 9，字形上 9 就是倒过来的 6）。 */
  const digitTpl = (look.templates ?? []).filter((t) => timeSigDigit(t.smufl) >= 0);
  digitTpl.push(...digitTpl.filter((t) => t.smufl === "timeSig6").map((t) => ({ ...t, smufl: "timeSig9" as SmuflName, sig: t.sig.slice().reverse() })));
  /** 在 `allowed` 这几个数字里取签名最近的；尺寸只卡高度（宽度随字体差得多，签名按长边归一、不拉伸）。 */
  const digitOf = (b: Rect, allowed: readonly number[], maxDist: number): RasterSym | null => {
    const h = b.h / unit.space;
    const sig = binSig(nl, b);
    let best: { code: SmuflName; d: number } | null = null;
    let bestNot9: { code: SmuflName; d: number } | null = null;
    for (const t of digitTpl) {
      if (!allowed.includes(timeSigDigit(t.smufl)) || Math.abs(t.h - h) > 0.2 + 0.12 * t.h) continue;
      const d = sigDistance(t.sig, sig);
      if (d > maxDist) continue;
      if (!best || d < best.d) best = { code: t.smufl, d };
      if (t.smufl !== "timeSig9" && (!bestNot9 || d < bestNot9.d)) bestNot9 = { code: t.smufl, d };
    }
    // 派生的「9」不是真字形，要**明显**近过别的数字才采信：万古磐石歌的铅字「3」上头带个球，
    // 到 9 是 179、到 3 是 186，几乎打平；晨曦破晓真的 9 是 139 对 240。
    if (best?.code === "timeSig9" && bestNot9 && bestNot9.d - best.d < NINE_MARGIN) best = bestNot9;
    return best && { box: b, code: best.code };
  };
  // **第二趟：照同页已认出的拍号补缺**（Audiveris `TimeColumn`：一个系统里每行谱的拍号必须同值）。
  // 缺拍号的那行，允许已被符头那几路认领的块（休止、和弦字母除外）进候选（Audiveris 先认行首段、再找符头；
  // 我们的顺序反过来，粗体 4/4 一整块被并块拆分那一路拆成两个黑头——《欢然颂主》高音谱表），
  // 但只认与已认出的拍号**同值、x 对齐**（1.5 格内）的那一对；认中了，盒里的假头随下面「盖过字典」一并删掉。
  const timeFound: { x: number; codes: string }[] = [];
  const timeDone = new Set<(typeof groups)[number]>();
  for (const pass of [0, 1])
  for (const g of groups) {
    if (timeDone.has(g) || (pass === 1 && !timeFound.length)) continue;
    const left = Math.max(...g.lines.map((l) => l.left));
    const mid = g.lines[2].y;
    const top = g.lines[0].y;
    const bottom = g.lines[4].y;
    // 行首那一段：谱号 + 调号之后、第一个音符之前。放到十四格——
    // 七个升降号的调号就占了八格多。
    // **字典认走的也进来**（谱号与调号升降号除外）：C 拍号与字典里那个
    // `csymParensRightTall`（大括号）形状相近，认错了照样要能被拍号盖过。
    const cands = blobs.filter((c) => {
      const b = c.bbox;
      if ((claimed.has(c.id) && !(pass === 1 && !restIds.has(c.id) && !harmonyIds.has(c.id))) || merged.has(c.id)) return false;
      const dc = dictClaimed.has(c.id) ? look.lookup(binSig(nl, b), b.w / unit.space, b.h / unit.space) : null;
      if (dc && (isClef(dc) || isAccidental(dc))) return false;
      if (b.x < left || b.x > left + unit.space * 14) return false;
      if (pass === 1 && !timeFound.some((t) => Math.abs(t.x - b.x) <= unit.space * 1.5)) return false;
      return b.y + b.h > top - unit.space * 0.5 && b.y < bottom + unit.space * 0.5;
    });
    if (!cands.length) continue;
    // 按 x 聚成**若干列**，逐列去试。
    //
    // 只试最左那一列不行：行首除了拍号还有谱号被切下来的碎块、调号里字典没认出的
    // 升降号，最左那一列往往是它们（实测你要等候 p2 最左是谱号的下半截，
    // 真正的 C 拍号在它右边两列开外）。
    //
    // 容一点缝（0.4 格）：C 拍号被自己的笔画切成好几块，块与块之间差几个像素
    //（实测破碎 p2 那个 C 切成 0.76×2.16 / 0.64×0.93 / 0.58×0.12 / 0.41×0.58）。
    cands.sort((a, b) => a.bbox.x - b.bbox.x);
    const cols: { box: Rect; ids: number[] }[] = [];
    for (const c of cands) {
      const b = c.bbox;
      const last = cols[cols.length - 1];
      if (last && b.x <= last.box.x + last.box.w + unit.space * 0.4) {
        const x0 = Math.min(last.box.x, b.x);
        const y0 = Math.min(last.box.y, b.y);
        last.box = { x: x0, y: y0, w: Math.max(last.box.x + last.box.w, b.x + b.w) - x0, h: Math.max(last.box.y + last.box.h, b.y + b.h) - y0 };
        last.ids.push(c.id);
      } else cols.push({ box: { ...b }, ids: [c.id] });
    }
    for (const col of cols) {
      const box = col.box;
      if (box.w > unit.space * 2.5 || box.w < unit.space * 0.8) continue;
      // 距离上限比通用的 `TEMPLATE_DIST`（90）松：拍号被**五条谱线横穿**，
      // 去线在它身上切了好几道口子，退化比谱号重（实测宁静那个 4/4 上下两半
      // 到 `timeSig4` 是 104 与 95，破碎那个 C 到 `timeSigCommon` 是 168）。
      // 松得起，是因为位置先验很硬：行首那一列、骑在中线上、高约两格或四格。
      const tpl = look.templates ?? [];
      const hits: RasterSym[] = [];
      if (box.h < unit.space * 3) {
        // **C 拍号**（`timeSigCommon` / `timeSigCutCommon`）是一个块、骑在中线上
        if (Math.abs(box.y + box.h / 2 - mid) > unit.space * 0.8) continue;
        const m = matchTemplate(binSig(nl, box), box.w / unit.space, box.h / unit.space, tpl, TIME_TEMPLATE_DIST);
        if (m && (m.smufl === "timeSigCommon" || m.smufl === "timeSigCutCommon")) hits.push({ box, code: m.smufl });
      } else {
        // **两个数字摞起来**：按中线几何切开，不按碎块自己的位置分上下半
        // ——碎块的盒互相重叠（实测上半那块高 2.76 格、已经探进下半的地界）。
        // 拍号的版式是死的：上面那个坐在第五线到第三线之间、下面那个第三线到第一线。
        const up: Rect = { x: box.x, y: box.y, w: box.w, h: Math.round(mid) - box.y };
        const dn: Rect = { x: box.x, y: Math.round(mid), w: box.w, h: box.y + box.h - Math.round(mid) };
        if (up.h < unit.space || dn.h < unit.space) continue;
        const two = [up, dn].map((b) => {
          const m = matchTemplate(binSig(nl, b), b.w / unit.space, b.h / unit.space, tpl, TIME_TEMPLATE_DIST);
          return m && timeSigDigit(m.smufl) >= 0 ? { box: b, code: m.smufl } : null;
        });
        // **分子至少是 2**：1/x 的拍号谱面上不出现，出现只说明两个数字都是硬凑上的
        // ——旧字体（《善牧恩慈歌》那种铅字本）的「4」只有 1.1 格宽，过不了 `timeSig4`
        // 模板的宽度闸，却以 141/166 的距离过了放宽到 180 的 `timeSig1`，整首读成 1/1。
        // 拒掉之后下游按缺省拍号办，比错成 1/1 强得多（1/1 让每个四分音符都「满小节」）。
        // 分母同理只认 2、4、8：齐来谢主歌放大后分母「4」到 `timeSig1` 170、到 `timeSig4` 181，读成 4/1。
        if (two[0] && two[1] && timeSigDigit(two[0].code) >= 2 && (DEN_DIGITS as readonly number[]).includes(timeSigDigit(two[1].code))) hits.push(two[0], two[1]);
        else {
          // **按角色限定再认一次**：别的书的数字字形与 Maestro 差得远（万古磐石歌、齐来谢主歌的
          // 铅字「3」「4」只有 1.1~1.2 格宽，模板 1.5~1.6 格），过不了尺寸闸，最近的又总是
          // 一根竖笔的 `timeSig1`。可位置先验已经钉死了这两格里是什么：分子是 2~9，
          // 分母只有 2、4、8。于是只在合法的数字里取最近、尺寸只卡高度；分子认得出才认分母，
          // 分母再放宽一档（被第二、四线横穿，去线切掉的最多）。
          const num = digitOf(up, NUM_DIGITS, TIME_NUM_DIST);
          const den = num ? digitOf(dn, DEN_DIGITS, TIME_DEN_DIST) : null;
          if (num && den) hits.push(num, den);
        }
      }
      if (!hits.length) continue;
      if (pass === 1 && !timeFound.some((t) => t.codes === hits.map((h0) => h0.code).join("/") && Math.abs(t.x - box.x) <= unit.space * 1.5)) continue;
      // 拍号**盖过字典**（与谱号同一条）：落在它盒里的字典结果作废，那是被切开的碎块
      for (let k = syms.length - 1; k >= 0; k--) {
        const s0 = syms[k].box;
        if (s0.x >= box.x - 1 && s0.x + s0.w <= box.x + box.w + 1 && s0.y >= box.y - 1 && s0.y + s0.h <= box.y + box.h + 1) syms.splice(k, 1);
      }
      syms.push(...hits);
      for (const hit of hits) ledger.claim(hit.box, `time:${hit.code}`);
      for (const id of col.ids) merged.add(id);
      timeFound.push({ x: box.x, codes: hits.map((h0) => h0.code).join("/") });
      timeDone.add(g);
      break; // 一行谱只有一个拍号
    }
  }

  // ── 调号：紧跟谱号的升降号，**位置兜底** ─────────────────────────────────
  //
  // 字典与模板都认不出的调号升降号，按「谱号右边第一串又窄又高的块」补认。
  // 病例是铅字本的细长升号（《善牧恩慈歌》0.82×2.36 格，Maestro 模板 0.95×2.73）：
  // 到 `accidentalSharp` 的签名距离 130，通用的 90 那道闸过不去，调号整个丢了，
  // 全曲的 F 都成了还原（调号错一个，测评按「移调」整首平移，音符档掉到两成）。
  // 松到拍号那一档是因为位置先验够硬：紧贴谱号、一串挨着、骑在谱表上。
  // 形状另卡**窄**（宽不过高的 0.5）：拍号数字 0.67 以上，挡得住。
  // 只吃谁都没认领的块（外加字典认成调号区不该有之物的块，见下）；字典已经认出的前几个不动，
  // 从它们的串尾接着往右认。
  //
  // 另一种丢法是**升号被符头那一路先吃了**：粗体升号的两道横笔又粗又斜，
  // 去掉竖笔后就是两个上下叠着的「黑符头」（《赞美一神》低音谱表两行都是：
  // 升号骑在 F3 线上，出了一对 F#3/A3 和弦）。认回来的判据：
  //   - 谱号右缘 2 格内（低音谱号的两点不在谱号盒里，要多让半格）、x 差不到 0.3 格、上下隔 0.7~1.3 格的两个黑符头；
  //   - 原图上盒里有**两根**竖笔（相隔 0.4 格以上）贯穿上下两头，且没有哪一列伸出一格以上
  //     ——三度和弦的符干往一头伸 2.5 格以上；升号的竖笔只探出半格（右竖笔下端还短，不能要求两头都伸）；
  //   - 只被认成**一个**头的（第二行低音谱表）：竖笔上下都要探出 0.3 格以上、最长 1.6 格。
  const keySp = unit.space;
  const keyBin = raster.bin;
  function sharpAsHeads(ss: RasterSym[], edge: number, onStaff: (r: Rect) => boolean): { heads: RasterSym[]; box: Rect } | null {
    const sp = keySp;
    // 从左往右找：串是逐个往右认的，先配上右边那个会跳过左边那个（齐来称颂低音谱表第二、三个升号）
    const hs = ss.filter((s0) => s0.code === "noteheadBlack" && onStaff(s0.box) && s0.box.x >= edge - 1 && s0.box.x < edge + sp * 2).sort((a, b) => a.box.x - b.box.x);
    // 候选：上下叠着的一对，或者单独一个（另一道横笔没被认成头）
    const sets: RasterSym[][] = [];
    for (const a of hs)
      for (const b of hs) {
        const dy = (b.box.y - a.box.y) / sp;
        if (dy >= 0.7 && dy <= 1.3 && Math.abs(a.box.x - b.box.x) <= sp * 0.3) sets.push([a, b]);
      }
    for (const a of hs) sets.push([a]);
    for (const set of sets) {
      const box = sharpBox(set);
      if (box) return { heads: set, box };
    }
    return null;
  }
  /** 这一对（或一个）黑符头其实是升号吗：原图上有两根竖笔贯穿，且探出不多。是就返回升号的盒。 */
  /** 两个头的盒里，上下贯穿的竖笔之间有没有**不贯穿**的列（升号两根竖笔中间是空的）。 */
  function hasGapColumn(set: RasterSym[]): boolean {
    const bin = keyBin;
    const x0 = Math.min(...set.map((s0) => s0.box.x));
    const x1 = Math.max(...set.map((s0) => s0.box.x + s0.box.w));
    const u0 = set[0].box.y;
    const u1 = set[set.length - 1].box.y + set[set.length - 1].box.h - 1;
    const full: boolean[] = [];
    for (let x = x0; x < x1; x++) {
      let ok = true;
      for (let y = u0; y <= u1 && ok; y++) ok = !!bin.data[y * bin.w + x];
      full.push(ok);
    }
    const first = full.indexOf(true);
    const last = full.lastIndexOf(true);
    return first >= 0 && full.slice(first, last + 1).some((f) => !f);
  }
  function sharpBox(set: RasterSym[]): Rect | null {
    const sp = keySp;
    const bin = keyBin;
    const at = (x: number, y: number) => y >= 0 && y < bin.h && !!bin.data[y * bin.w + x];
    const x0 = Math.min(...set.map((s0) => s0.box.x));
    const x1 = Math.max(...set.map((s0) => s0.box.x + s0.box.w));
    const u0 = set[0].box.y;
    const u1 = set[set.length - 1].box.y + set[set.length - 1].box.h - 1;
    const cols: number[] = [];
    let y0 = u0;
    let y1 = u1;
    let over = 0;
    let up = 0;
    let down = 0;
    for (let x = x0; x < x1; x++) {
      let ok = true;
      // 竖笔一两像素的抖动算连着
      for (let y = u0; y <= u1 && ok; y++) ok = at(x, y) || at(x - 1, y) || at(x + 1, y);
      if (!ok) continue;
      cols.push(x);
      let t = u0;
      let d = u1;
      while (at(x, t - 1)) t--;
      while (at(x, d + 1)) d++;
      over = Math.max(over, u0 - t, d - u1);
      up = Math.max(up, u0 - t);
      down = Math.max(down, d - u1);
      y0 = Math.min(y0, t);
      y1 = Math.max(y1, d);
    }
    if (!cols.length || cols[cols.length - 1] - cols[0] < sp * 0.4) return null;
    // 一对：竖笔探出不过一格。单个：另一道横笔还挂在竖笔上，下探可到一格半，
    // 但**上下都要探出去**——带干的音只往一头伸，而且一伸就是两格半以上
    if (set.length === 2 ? over > sp : over > sp * 1.6 || up < sp * 0.3 || down < sp * 0.3) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 + 1 };
  }
  for (const g of groups) {
    const left = Math.max(...g.lines.map((l) => l.left));
    const top = g.lines[0].y;
    const bottom = g.lines[4].y;
    const clef = syms.find((s0) => isClef(s0.code) && s0.box.x < left + unit.space * 4 && s0.box.y < bottom && s0.box.y + s0.box.h > top);
    if (!clef) continue;
    let edge = clef.box.x + clef.box.w;
    const onStaff = (r: Rect) => r.y < bottom && r.y + r.h > top;
    // 字典已经认出的那一串先走完，**从串尾接着认**：字典只认出前几个、后面断了的也要补。
    // 病例《圣哉三一歌伴奏》三个降号：前两个的竖笔被当成线段抹掉、只剩肚子，字典认得；
    // 第三个的竖笔没抹、与肚子断成两块，竖笔被字典认成 wiggleTrill——以前见字典有就不插手，
    // 整首少一个降号，A 全成了还原。
    let fromDict = false;
    // 相接的容差放到**半格**：错开排的窄升号，后一个的左缘常在前一个右缘左边（《来敬拜荣耀王》
    // 三个升号，C# 左缘在 F# 右缘左边 5px，接不上，A 大调读成 D 大调，整曲音级错一个五度）。
    // 只在**前面已有调号记号**时放宽：从谱号右缘起算也放宽的话，会把谱号自己的碎块收进来（《主使我喜乐》−2.3）
    const overlapTol = unit.space * KEY_OVERLAP;
    const taken = new Set<RasterSym>();
    for (;;) {
      const nx = syms
        .filter((s0) => !taken.has(s0) && isAccidental(s0.code) && onStaff(s0.box) && s0.box.x >= edge - (taken.size ? overlapTol : 1) && s0.box.x < edge + unit.space * KEY_GAP)
        .sort((a, b) => a.box.x - b.box.x)[0];
      if (!nx) break;
      taken.add(nx);
      edge = Math.max(edge, nx.box.x + nx.box.w);
      fromDict = true;
    }
    // 字典认成**调号区不该有的东西**（演奏记号之类）的块也算候选：那多半是升降号断出来的半截。
    // 谱号、升降号、拍号、符头、休止照旧不碰。
    const dictSym = new Map<number, RasterSym>();
    for (const c of blobs) {
      if (!dictClaimed.has(c.id) || claimed.has(c.id) || merged.has(c.id)) continue;
      const s0 = syms.find((x) => x.box === c.bbox);
      if (s0 && !isClef(s0.code) && !isAccidental(s0.code) && timeSigDigit(s0.code) < 0 && !/^(notehead|rest)/.test(s0.code)) dictSym.set(c.id, s0);
    }
    const cand = blobs
      .filter((c) => !claimed.has(c.id) && (!dictClaimed.has(c.id) || dictSym.has(c.id)) && !merged.has(c.id))
      .filter((c) => onStaff(c.bbox))
      .sort((a, b) => a.bbox.x - b.bbox.x);
    const union = (a: Rect, b: Rect): Rect => {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
    };
    // 串里**逐个**往右认，每一步先看「被当成符头的升号」、再看普通块：齐来称颂的低音谱表
    // 三个升号，第一个是普通块、后两个各被认成一对黑符头，只认一路就断在第二个上。
    // 第一个记号离谱号右缘放到两格：低音谱号的两点在谱号盒外，实测 1.77 格。
    let prevKey: { box: Rect; code: SmuflName; sig: Uint8Array } | null = null;
    for (let first = !fromDict; ; first = false) {
      const gap = unit.space * (first ? KEY_GAP_FIRST : KEY_GAP);
      const pair = sharpAsHeads(syms, edge, onStaff);
      if (pair && pair.box.x <= edge + gap) {
        for (const s0 of pair.heads) syms.splice(syms.indexOf(s0), 1);
        syms.push({ box: pair.box, code: "accidentalSharp" });
        ledger.claim(pair.box, "key:accidentalSharp");
        edge = pair.box.x + pair.box.w;
        continue;
      }
      let took = false;
      const keyTpl = (look.templates ?? []).filter((t) => t.smufl === "accidentalSharp" || t.smufl === "accidentalFlat");
      // 过得了尺寸闸与模板才算；宽另卡 1.2 格：齐来称颂的拍号「3」与「4」的上半连成一块（1.37×3.2 格），
      // 紧挨着最后一个升号，宽高比过得了 0.5 那道闸，被当成第四个升号吃掉，拍号就没了
      const asKey = (b: Rect) => {
        const w = b.w / unit.space;
        const h = b.h / unit.space;
        // 下限 1.6：小号升号（2 格上下）去线后被削到 1.76 格（《来敬拜荣耀王》的 C#）；
        // 宽高比放到 0.6：同一本的 F# 1.02×1.97 格（0.52）
        if (h < 1.6 || h > 3.4 || w < 0.4 || w > h * 0.6 || w > 1.2) return null;
        // 串里后面的记号不会比前一个矮一截：拍号 C 的上半弧（2.2 格）紧挨着最后一个升号（3.0 格），
        // 模板距离 156 过得了拍号那道宽闸，被当成第五个升号（《主使我喜乐》四个升号认成五个）
        if (prevKey && b.h < prevKey.box.h * 0.8) return null;
        const sig = binSig(nl, b);
        const m = matchTemplate(sig, w, h, keyTpl, TIME_TEMPLATE_DIST);
        if (m) return m;
        // 模板尺寸闸没过、却与**前一个已认出的记号**一般大、签名也像：粗体铅字本的升号比模板高
        // （3.3 格，模板 2.7 格的容差到 3.2），同一串里前面的认得、这一个卡在闸上
        if (prevKey && Math.abs(b.h - prevKey.box.h) <= prevKey.box.h * 0.15 && Math.abs(b.w - prevKey.box.w) <= prevKey.box.w * 0.3) {
          const d = sigDistance(sig, prevKey.sig);
          if (d <= KEY_SELF_DIST) return { smufl: prevKey.code, dist: d };
        }
        // 还认不出、又**比模板小一号**的：数竖笔。小号升号（2 格，模板 2.7 格）过不了模板的尺寸闸，
        // 可去线之前的图上两根竖笔都在（《来敬拜荣耀王》A 大调三个升号）。只认升号：两根通高的竖笔，
        // 降号、拍号数字、带干的符头都凑不出两根。
        if (h < 2.5) {
          const pad = Math.round(unit.space * 0.3);
          if (tallStrokes(raster.bin, { x: b.x - pad, y: b.y, w: b.w + pad * 2, h: b.h }) === 2) return { smufl: "accidentalSharp" as SmuflName, dist: KEY_SELF_DIST };
        }
        return null;
      };
      for (let i = 0; i < cand.length; i++) {
        const c = cand[i];
        const b = c.bbox;
        if (b.x < edge - (fromDict || prevKey ? overlapTol : 1) || merged.has(c.id)) continue;
        if (b.x > edge + gap) break; // 串断了
        if (b.w / unit.space < 0.6 && b.h / unit.space < 0.6) continue; // 噪点、谱号的小尾巴：跳过，不算断串
        let box = b;
        let used = [c];
        let m = asKey(b);
        // 单块不像，就与**右边紧挨着、上下有交叠**的下一块并起来再认（降号断成竖笔与肚子两块）
        if (!m) {
          const c2 = cand.slice(i + 1).find((d) => !merged.has(d.id) && d.bbox.x >= b.x && d.bbox.x <= b.x + b.w + unit.space * 0.3);
          if (c2 && c2.bbox.y < b.y + b.h && c2.bbox.y + c2.bbox.h > b.y) {
            box = union(b, c2.bbox);
            used = [c, c2];
            m = asKey(box);
          }
        }
        if (!m) break;
        for (const u of used) {
          const d = dictSym.get(u.id);
          if (d) syms.splice(syms.indexOf(d), 1);
          merged.add(u.id);
        }
        syms.push({ box, code: m.smufl });
        ledger.claim(box, `key:${m.smufl}`);
        prevKey = { box, code: m.smufl, sig: binSig(nl, box) };
        edge = Math.max(edge, box.x + box.w);
        took = true;
        break;
      }
      if (!took) break;
    }
  }

  // ── 调号记号**按竖笔数**再定一次升降 ─────────────────────────────────────
  //
  // 升号的两道横笔很细，常常正好压在谱线上，去线时一起抹掉，只剩两根竖笔
  //（《来敬拜荣耀王》A 大调三个升号全被模板认成降号，整曲音高错一片）。
  // **通高的竖笔**数得清：升号两根（右边那根高一点）、降号一根（右下是个肚子）。只拿它把降号改回升号。
  // 只改谱号右边调号区里的记号，谱中的临时记号不碰。
  for (const g of groups) {
    const top = g.lines[0].y;
    const bottom = g.lines[4].y;
    const clef = syms.find((s0) => isClef(s0.code) && s0.box.y < bottom && s0.box.y + s0.box.h > top && s0.box.x < Math.max(...g.lines.map((l) => l.left)) + unit.space * 4);
    if (!clef) continue;
    const right = clef.box.x + clef.box.w + unit.space * 6;
    const inKey = (s0: RasterSym) => !(s0.box.x < clef.box.x + clef.box.w - 1 || s0.box.x > right || s0.box.y > bottom || s0.box.y + s0.box.h < top);
    for (const s0 of syms) {
      if (s0.code !== "accidentalFlat" && s0.code !== "accidentalSharp") continue;
      if (!inKey(s0)) continue;
      // 数竖笔要在**去线之前**的图上、左右各放宽 0.3 格：细的那根竖笔常被当成竖段抽走，去线图上只剩一根
      const pad = Math.round(unit.space * 0.3);
      const n = tallStrokes(raster.bin, { x: s0.box.x - pad, y: s0.box.y, w: s0.box.w + pad * 2, h: s0.box.h });
      // 只往升号改：扫描件放大后升号的竖笔断断续续，数不满两根（《善牧恩慈歌》G 大调因此读成 F 大调，音符 91 → 26%）
      if (n === 2 && s0.code === "accidentalFlat") s0.code = "accidentalSharp";
    }
    // 夹在一串升号里的**还原号**是升号：去线后升号的横笔没了、两根竖笔上下错开，字典认成还原号
    //（《来敬拜荣耀王》的 C#）。调号里的还原号只在转调取消时出现，不会与升号混排在同一串。
    const ks = syms.filter((s0) => isAccidental(s0.code) && inKey(s0));
    if (ks.some((s0) => s0.code === "accidentalSharp") && !ks.some((s0) => s0.code === "accidentalFlat"))
      for (const s0 of ks) if (s0.code === "accidentalNatural") s0.code = "accidentalSharp";
  }

  // ── 谱中的升号被当成两个黑符头 ───────────────────────────────────────────
  //
  // 与调号那段同一个病（粗体升号的两道横笔去掉竖笔后就是两个上下叠着的黑头），只是出在谱中：
  // 齐来称颂 m14 低音那个 E♯3 的升号成了一对 D3/F♯3 黑头，多出两个音、升号也丢了。
  // 几何判据同 `sharpBox`；谱中没有「紧贴谱号」那条先验，另要**右边 1.5 格内有个同高的符头**
  //（升号中心与头中心差不到四分之一格）——那是它要升的音。只认成对的，单个的太像带干的头。
  for (let i = 0; i < syms.length; i++) {
    const a = syms[i];
    if (a.code !== "noteheadBlack") continue;
    const b = syms.find((s0) => s0 !== a && s0.code === "noteheadBlack" && Math.abs(s0.box.x - a.box.x) <= keySp * 0.3 && (s0.box.y - a.box.y) / keySp >= 0.7 && (s0.box.y - a.box.y) / keySp <= 1.3);
    if (!b) continue;
    const box = sharpBox([a, b]);
    if (!box) continue;
    // 升号的两根竖笔之间是空的；上下贴着的两个实心头（三度和弦）每一列都有墨，`sharpBox` 分不开
    //（善牧恩慈歌线距 11px，m2 的一对黑头被当成升号）
    if (!hasGapColumn([a, b])) continue;
    const cy = box.y + box.h / 2;
    const right = box.x + box.w;
    const owner = syms.some((s0) => s0 !== a && s0 !== b && /^notehead/.test(s0.code) && s0.box.x >= right - 2 && s0.box.x - right <= keySp * 1.5 && Math.abs(s0.box.y + s0.box.h / 2 - cy) <= keySp / 4);
    if (!owner) continue;
    syms.splice(syms.indexOf(b), 1);
    syms.splice(syms.indexOf(a), 1, { box, code: "accidentalSharp" });
    ledger.claim(box, "acc:accidentalSharp");
  }

  // ── 谱中没人认领的升降还原号：按位置先验配模板 ───────────────────────────
  //
  // 字典认不出、也没人认领的块，**右边 1.5 格内有个同高的符头**（升/还原看盒中心，降看肚子），
  // 形状又像升降号（高 1.8~3.4 格、宽 0.4~1.2 格），就拿模板配（门槛见 `LOOSE_ACC_DIST`）。病例齐来称颂 m5 那个 D♯4 的升号，两道横笔分得开，
  // 字典不认，整块没人要。
  {
    const accTpl = (look.templates ?? []).filter((t) => t.smufl === "accidentalSharp" || t.smufl === "accidentalFlat" || t.smufl === "accidentalNatural");
    const sp = unit.space;
    for (const c of blobs) {
      if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
      const b = c.bbox;
      const w = b.w / sp;
      const h = b.h / sp;
      if (h < 1.8 || h > 3.4 || w < 0.4 || w > 1.2) continue;
      if (syms.some((s0) => overlapFrac(b, s0.box) > 0.3)) continue;
      const m = matchTemplate(binSig(nl, b), w, h, accTpl, LOOSE_ACC_DIST);
      if (!m) continue;
      const py = m.smufl === "accidentalFlat" ? b.y + (b.h * (1 + FLAT_BOWL_TOP)) / 2 : b.y + b.h / 2;
      const right = b.x + b.w;
      if (!syms.some((s0) => /^notehead/.test(s0.code) && s0.box.x >= right - 2 && s0.box.x - right <= sp * LOOSE_ACC_GAP && Math.abs(s0.box.y + s0.box.h / 2 - py) <= sp / 4)) continue;
      merged.add(c.id);
      syms.push({ box: b, code: m.smufl });
      ledger.claim(b, `acc:${m.smufl}`);
    }
  }

  // ── 降号的盒要收到**下面那个肚子**上 ─────────────────────────────────────
  //
  // 降号的音高位置是肚子，不是盒中心：它的字形是「一根竖笔往上伸 + 底下一个肚子」，
  // Maestro 模板 0.84×2.36 格，肚子只占下面一格左右。而 `analyzeAccidental`
  // 判「这个记号是不是那个符头的」用的是**盒中心与符头中心同高**（容差四分之一格）
  // ——实测降号的盒中心比符头中心**高 0.55 格**，16 个里**一个都过不了**那道闸
  //（升号与还原号上下对称，中位数 0.03 格，33/36 与 10/11 都过）。
  //
  // 位图这边的 `Sym.py` 是从盒算的（`adapt.ts` 造的是假字形），所以在这里把盒
  // 收到肚子上最省事：`py` 跟着落到肚子中心，`overlapY` 与 x 上的判据都不受影响。
  // **不动 `staffomr`**——那边的 `py` 从真字形来，两条路的成因不是一回事。
  for (const s of syms) {
    if (s.code !== "accidentalFlat") continue;
    const cut = Math.round(s.box.h * FLAT_BOWL_TOP);
    s.box = { x: s.box.x, y: s.box.y + cut, w: s.box.w, h: s.box.h - cut };
  }

  // ── 符头 + 符干（+ 符尾）并成一块：把头摘出来 ────────────────────────────
  //
  // 符尾贴着符干走大半程，`isolated` 判那条符干「属于某个符号」，于是抽不成原语、
  // `blobImage` 也不照它抹墨——头、干、尾连成一块（实测 1.99×3.91 格），
  // 单头的尺寸闸一律判否。只有符干的那些同理（弧线蹭着符干时也过不了孤立性）。
  // 判据见 `headmask.ts::headFromStemBlock`；**只吃谁都没认领的块**，
  // 谱号、休止、升降号、拍号那几路已经先收过一遍。
  const stemHeads: RasterSym[] = [];
  /** 摘出来的头自带的符干（只进 `SPage`，不回写 `prims`——那边的墨已经抹过了）。 */
  const stemSegs: LineSeg[] = [];
  if (masks.length) {
    for (const c of blobs) {
      const met = metIds.has(c.id) && !merged.has(c.id);
      if (!met && (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id))) continue;
      // 已经被别的路（谱号自举、拍号自举）出成 sym 的块不碰
      const b = c.bbox;
      const metSym = met ? syms.find((s0) => s0.box === b || (s0.code.startsWith("metNote") && overlapFrac(b, s0.box) > 0.9)) : undefined;
      if (met && !metSym) continue;
      if (syms.some((s0) => s0 !== metSym && overlapFrac(b, s0.box) > 0.5)) continue;
      // **长得像休止的块先按休止收**：粗体铅字本的四分休止（1.0×3.1 格）字典里没有这一类，
      // 尺寸又正落在「头 + 干」这一档，被摘出一个假头（《主我敬拜你》第八小节的休止成了 E4）。
      // 与 Maestro 的休止模板比，距离 77；真的「头 + 干（+ 尾）」块一个都比不上。
      const rm = matchTemplate(binSig(nl, b), b.w / unit.space, b.h / unit.space, restTpl);
      const rs = rm ?? (isEighthRest(nl, b, c.area, unit) ? { smufl: "rest8th" as SmuflName } : null);
      if (rs) {
        stemHeads.push({ box: b, code: rs.smufl });
        ledger.claim(b, `rest:${rs.smufl}`);
        continue;
      }
      const r = headFromStemBlock(raster.bin, b, c.area, masks, unit, pitchGrid, onLineY);
      if (!r) continue;
      // 已有符头压着的不重复出（长干两头的那一档：万古磐石歌的 B♭3/B♭2 别的路已认出，再出一遍成了四个音）
      const dup = (hb: Rect) => [...syms, ...stemHeads].some((s0) => /^notehead/.test(s0.code) && overlapFrac(hb, s0.box) > 0.3);
      if (dup(r.head)) continue;
      if (metSym) syms.splice(syms.indexOf(metSym), 1);
      stemHeads.push({ box: r.head, code: "noteheadBlack" });
      for (const e of r.extra) {
        if (dup(e)) continue;
        stemHeads.push({ box: e, code: "noteheadBlack" });
        ledger.claim(e, "stemblock:noteheadBlack");
      }
      stemSegs.push({ x0: r.stemX, y0: r.stemY0, x1: r.stemX, y1: r.stemY1, lw: unit.lineThick, maxLw: unit.lineThick * 2 });
      ledger.claim(r.head, "stemblock:noteheadBlack");
    }
    syms.push(...stemHeads);
  }

  // ── **被几何闸判否的块，交给页内自举的判别器再判一次** ────────────────────
  //
  // `findRasterHeads` 的尺寸 + 填充率是一把**没见过负例**的尺子：它只知道符头长什么样，
  // 不知道「长得像符头但不是」的东西长什么样。扫描件上符头被擦线啃窄、被符干粘住，
  // 尺寸一出闸就没人管了（实测破碎扫描版带内「够得上符头那一档」的块只有 42.7%
  // 被认领，干净版 65.9%）；而闸一放宽假头就跟着进来——歌词那条探针每次都先报警。
  //
  // 这里现训一个**带负例**的逻辑回归（`headclass.ts`）：
  // **正例**：这一页**已经认出来的全部实心符头**——不只 `findRasterHeads` 那批，
  // 还有拆块、按内腔、摘符干块捞回来的。只用「过了几何闸」的那批，样本会偏向
  // 长得端正的那一档，而判别器要判的恰恰是被啃过、被粘住的那些。
  //
  // **负例**：这一页**认出来的全部非符头符号**——谱号、休止、升降号、拍号，
  // 不论来自字典还是位置自举。正是「长得像符头但不是」的那一批，
  // 也正是那把没见过负例的尺子分不开的东西。
  //（歌词字格是更靠后才切的，这里取不到。）
  const clfPos = [
    ...heads.filter((h) => !dropHead.has(h.comp.id) && h.code === "noteheadBlack").map((h) => h.box),
    ...split.filter((s0) => s0.code === "noteheadBlack").map((s0) => s0.box),
    ...stemHeads.map((s0) => s0.box),
    ...stacked.filter((s0) => s0.code === "noteheadBlack").map((s0) => s0.box),
  ];
  const clfNeg: Rect[] = syms.filter((s0) => !/notehead/i.test(s0.code)).map((s0) => s0.box);
  const clf = masks.length ? trainHeadClassifier(raster.bin, masks, unit, onLineY, clfPos, clfNeg) : null;
  const clfHeads: RasterSym[] = [];
  /** 已有符头压着的位置不再出（「头 + 干」那一路只记账、不标块，这一遍会在同一块里再拆一次）。 */
  const headTaken = (hb: Rect) => [...syms, ...clfHeads].some((s0) => /^notehead/.test(s0.code) && overlapFrac(hb, s0.box) > 0.3);
  if (clf) {
    for (const c of blobs) {
      if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
      const b = c.bbox;
      if (syms.some((s0) => overlapFrac(b, s0.box) > 0.5)) continue;
      const w = b.w / unit.space;
      const h = b.h / unit.space;
      if (w < CLF_W[0] || w > CLF_W[1] || h < CLF_H[0] || h > CLF_H[1]) continue;
      // 符杠的断头不是符头：块的中心压在某条符杠的中线上（半个杠厚以内）
      //（《是谁》朝下八分音符的符杠末端 1.06×0.48 格，判别器给过了，出了个 B3）
      if (onBeamLine(b)) continue;
      const gy = pitchGrid(b.y + b.h / 2);
      if (gy === null) continue;
      if (headProb(clf, raster.bin, masks, unit, b, gy, onLineY(gy)) < CLF_P) continue;
      const hw = Math.round(unit.space * 1.25);
      const hh = Math.round(unit.space * 0.95);
      const box = { x: Math.round(b.x + b.w / 2 - hw / 2), y: Math.round(gy - hh / 2), w: hw, h: hh };
      if (headTaken(box)) continue;
      clfHeads.push({ box, code: "noteheadBlack" });
      ledger.claim(box, "clf:noteheadBlack");
    }
    // ── **大团再拆一遍，拆出来的每个头都要过判别器** ────────────────────────
    //
    // `splitHeadCluster` 的尺寸闸是 6×4 格，而 `raster-gap.mjs` 量出漏音里
    // **53.8% 焊在更大的团里**。直接把闸放大试过：小节自检涨（真音确实捞回来了）
    // 而音符不涨——大团里挑出来的头对错各半，没人验。
    // 判别器（带负例、见 `headclass.ts`）恰好补上这一关，而它要等字典那一路跑完
    // 才训得出来，所以放在这里做第二遍：**闸放大，但每个头都要过判别器**。
    if (masks.length) {
      for (const c of blobs) {
        if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
        const b = c.bbox;
        if (syms.some((s0) => overlapFrac(b, s0.box) > 0.5)) continue;
        const w = b.w / unit.space;
        const h = b.h / unit.space;
        if (w > BIG_W || h > BIG_H) continue; // 再大就不是一团连桁了
        const parts = splitHeadCluster(noBeam, b, c.area, masksNB.length ? masksNB : masks, unit, pitchGrid, onLineY, true, (pb, gy) =>
          headProb(clf, raster.bin, masks, unit, pb, gy, onLineY(gy)) >= CLF_P,
        );
        if (parts.length < 2) continue;
        for (const pb of parts) {
          if (headTaken(pb)) continue;
          clfHeads.push({ box: pb, code: "noteheadBlack" });
          ledger.claim(pb, "clfsplit:noteheadBlack");
        }
        claimed.add(c.id);
      }
    }
    syms.push(...clfHeads);
  }

  // ── 空心头按模板再搜 ─────────────────────────────────────────────────────
  //
  // 低分辨率的全音符（《善牧恩慈歌》线距 11px）两路都认不出：叠成「8」字的三度
  // 两个头并成一块，内腔被谱线切成四片、又是斜缝，过不了内腔那一路的「横宽」闸；
  // 贴着谱线的那个被去谱线切成左右两半。可同一页上别处的空心头是认出来了的——
  // 拿它们平均出模板（`buildHollowMasks`），在**有内腔的无主块**里做匹配追踪。
  // 先把 x 上重叠、上下贴着的无主块并起来（被切成两半的头要并回一个）。
  {
    const hollowMask = buildHollowMasks(raster.bin, syms.filter((s0) => !(s0 as { weak?: boolean }).weak), unit, [])[0] ?? null;
    if (hollowMask) {
      const free = blobs.filter((c) => !claimed.has(c.id) && !dictClaimed.has(c.id) && !merged.has(c.id) && inBand(c.bbox.y + c.bbox.h / 2));
      const used = new Set<number>();
      for (const a of free) {
        if (used.has(a.id)) continue;
        let box = { ...a.bbox };
        let area = a.area;
        const group = [a.id];
        for (let again = true; again; ) {
          again = false;
          for (const b of free) {
            if (group.includes(b.id) || used.has(b.id)) continue;
            const r = b.bbox;
            const ov = Math.min(box.x + box.w, r.x + r.w) - Math.max(box.x, r.x);
            const gap = r.y > box.y ? r.y - (box.y + box.h) : box.y - (r.y + r.h);
            if (ov < Math.min(box.w, r.w) * 0.3 && !(gap < 0 && Math.abs(r.x - (box.x + box.w)) <= unit.lineThick * 2 + 1)) continue;
            if (gap > unit.lineThick * 2 + 1) continue;
            const x0 = Math.min(box.x, r.x);
            const y0 = Math.min(box.y, r.y);
            box = { x: x0, y: y0, w: Math.max(box.x + box.w, r.x + r.w) - x0, h: Math.max(box.y + box.h, r.y + r.h) - y0 };
            area += b.area;
            group.push(b.id);
            again = true;
          }
        }
        const w = box.w / unit.space;
        const h = box.h / unit.space;
        if (w < 0.8 || w > 2.2 || h < 0.6 || h > 3.2) continue; // 粗体全音符宽到 1.96 格（《赞美一神》）
        // 块里要有内腔（空心头的先验）
        if (!holes.some((o) => o.x >= box.x && o.x + o.w <= box.x + box.w && o.y >= box.y - 1 && o.y + o.h <= box.y + box.h + 1)) continue;
        if (syms.some((s0) => overlapFrac(box, s0.box) > 0.3)) continue;
        const parts = splitHeadCluster(raster.bin, box, area, [hollowMask], unit, pitchGrid, onLineY, true, undefined, 1, HOLLOW_MASK_SCORE);
        if (!parts.length) continue;
        for (const id of group) used.add(id), merged.add(id);
        for (const pb of parts) {
          const stemmed = prims.vSegs.some((v) => {
            const vx = (v.x0 + v.x1) / 2;
            return (Math.abs(vx - pb.x) <= unit.space * 0.2 || Math.abs(vx - (pb.x + pb.w)) <= unit.space * 0.2) && Math.min(v.y0, v.y1) <= pb.y + pb.h && Math.max(v.y0, v.y1) >= pb.y;
          });
          const code: SmuflName = stemmed ? "noteheadHalf" : "noteheadWhole";
          syms.push({ box: pb, code });
          ledger.claim(pb, `hollowmask:${code}`);
        }
      }
    }
  }

  // ── 终止线/段落线：纵贯谱表的**实心条**补成竖段 ────────────────────────────
  //
  // 「细 + 粗」双线里那根粗线有 0.6 格宽，过不了竖段的宽度闸；紧贴着它的细线
  // 又过不了孤立性判据——两根都成了没人认领的块，小节线那一步看不见它们。
  // 《善牧恩慈歌》延长记号后、「阿们」之前那道双线就这样丢了，后面一小节并进了前一小节。
  // 判据：上下两端贴着五线的顶线与底线（各 0.4 格内）、宽不过一格、填充八成以上。
  for (const c of blobs) {
    if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
    const b = c.bbox;
    if (b.w > unit.space || c.area < b.w * b.h * 0.8) continue;
    const g = groups.find((g0) => Math.abs(b.y - g0.lines[0].y) <= unit.space * 0.4 && Math.abs(b.y + b.h - g0.lines[4].y) <= unit.space * 0.4);
    if (!g) continue;
    if (syms.some((s0) => overlapFrac(b, s0.box) > 0.3)) continue;
    const x = b.x + b.w / 2;
    prims.vSegs.push({ x0: x, y0: b.y, x1: x, y1: b.y + b.h, lw: b.w, maxLw: b.w });
    merged.add(c.id);
    ledger.claim(b, "bar:thick");
  }

  // **谱号左边没有音符**、谱号右边紧挨着的「符头」可能是调号：花括号、方括号的弯钩落在谱表上下，圆滚滚的像个全音符
  // （《赞美一神》第二行低音谱表顶上那一个，出了个 G3 全音符）。
  for (const g of groups) {
    const top = g.lines[0].y - unit.space * 2;
    const bottom = g.lines[4].y + unit.space * 2;
    const clef = syms.find((s0) => isClef(s0.code) && s0.box.y < g.lines[4].y && s0.box.y + s0.box.h > g.lines[0].y);
    if (!clef) continue;
    // 调号兜底之后才摘出来的「符头」（符头连符干那一路把升号的竖笔当成符干）再验一次
    const onStaff = (r: Rect) => r.y < g.lines[4].y && r.y + r.h > g.lines[0].y;
    const edge = clef.box.x + clef.box.w;
    if (!syms.some((s0) => isAccidental(s0.code) && onStaff(s0.box) && s0.box.x >= edge - 1 && s0.box.x < edge + unit.space * KEY_GAP)) {
      const pair = sharpAsHeads(syms, edge, onStaff);
      if (pair) {
        for (const s0 of pair.heads) syms.splice(syms.indexOf(s0), 1);
        syms.push({ box: pair.box, code: "accidentalSharp" });
        ledger.claim(pair.box, "key:accidentalSharp");
      }
    }
    for (let i = syms.length - 1; i >= 0; i--) {
      const b = syms[i].box;
      if (/notehead/i.test(syms[i].code) && b.x + b.w / 2 < clef.box.x && b.y + b.h / 2 >= top && b.y + b.h / 2 <= bottom) syms.splice(i, 1);
    }
  }

  // ── 附点：**位置 + 形状自举**，字典兜不住 ─────────────────────────────────
  //
  // 附点在位图路原先只靠字典认（`augmentationDot`），字典是在线距 15~19px 的合唱谱上建的：
  // 《是谁》线距 50px，附点直径 18px，还被横段那一步连着符头的边抽成了一截横线；
  // 《善牧恩慈歌》线距 11px，附点只有 3px。两首的附点二分、附点四分一个都没认出来。
  // 附点的位置是死的：符头右边一格之内、同一个间（线上的音写在上方那个间）。
  // 在去谱线图上找那个窗口里**孤立、近圆的小墨团**，找到就补一个附点，时值交给 `attachDots`。
  for (const d of findDots(nl, syms, unit)) {
    syms.push({ box: d, code: "augmentationDot" });
    ledger.claim(d, "dot:augmentationDot");
  }

  // **大半落在升降号盒里的符头不要**：调号升号认出来了，同一块又被拆块那一路拆出两个「头」
  //（《向主唱新歌》两行行首的 F♯ 各多出一个 G5）。临时记号只挨着符头左边，交叠不到七成。
  {
    const accs = syms.filter((s0) => isAccidental(s0.code));
    for (let i = syms.length - 1; i >= 0; i--)
      if (/^notehead/.test(syms[i].code) && accs.some((a) => overlapFrac(syms[i].box, a.box) > 0.7)) syms.splice(i, 1);
  }

  // **切加线要用最终认出来的全部符头**：除了 `findRasterHeads`，还有按内腔找的、
  // 拆块拆出来的、字典查出来的、碎块并回再判出来的——少算哪一路，那一路的符头
  // 就只能蹭邻居的加线，`findLegers` 判否、整批挂不上谱行。
  const headBoxes = syms.filter((s0) => /notehead/i.test(s0.code)).map((s0) => ({ box: s0.box }));

  const pg = buildRasterPage({
    index,
    width: raster.bin.w,
    height: raster.bin.h,
    unit,
    // **只把分好组的那些线交下去**。`findStaves` 会拿 segs 自己再分一次组，
    // 而没进组的线里混着**通长的加线**（八度跑动共用的那条，实测宁静 p5
    // y=1004、x[244,1906]），它会顶掉真正的第五线、把整行谱上移一条线
    // ——那一行的音高整段低两级。分组那一步已经按「五条线左缘要一致」把它挡掉了，
    // 这里就别再把它递下去。
    staffLines: groups.flatMap((g) => g.lines),
    // 符头剪出来的加线要一并推进去，`findLegers` 才有得判
    // **没成组的那些行投影线要当加线用**，不能整个丢掉：密集八度跑动上方那一排短加线
    // 被行投影连成一条通长的线，它不是谱线（左缘对不上，见 `groupStaves`），
    // 但确实是加线——丢了的话上方那些符头一条加线都没有、`findLegers` 全判否，
    // 认出来的符头一个都归不了谱行（实测宁静 p5 那七个 C6 就是这样）。
    // 交给 `sharedLegers` 按符头切成短段，长度才过得了 `findLegers` 那道闸。
    hSegs: [
      ...prims.hSegs,
      ...heads.map((h) => h.ledger).filter((l): l is NonNullable<typeof l> => !!l),
      // **所有认出来的符头都要参与切加线**，不只 `findRasterHeads` 那一批：
      // 按内腔找出来的（`stacked`）、拆块拆出来的（`split`）也压在加线上。
      // 少了它们，那些头的加线是按**邻居**切的、盖不住自己，`findLegers` 就判否
      // ——实测宁静钢琴右手 663 个带内符头只归属 574 个，差的 89 个几乎全是
      // 谱表上方一到两格、等着加线撑的那些。
      ...sharedLegers([...prims.hSegs, ...strayLines], headBoxes, onGrid, unit),
      // **骑在加线上的符头，自己那条加线要补出来。**
      // 它压在符头底下，`findPrimitives` 抽不出来（那一带的纵向游程是整个符头的高度）；
      // `trimLedger` 只给 `findRasterHeads` 那一批补，按内腔找出来的、拆块拆出来的都没有。
      // 于是谱表外一到两格的音「符头认出来了却挂不上谱行」——实测宁静钢琴右手
      // 120 个未归属的头里 89 个是这一类。
      // **要验墨**：那一带真有一条横墨才补，不然等于把 `findLegers` 那道防线拆了。
      ...ownLegers(headBoxes, raster.bin, onGrid, unit),
    ],
    // 符干要**续到符头里**才与符头纵向相交（`findStems` / `buildStems` 的硬判据）。
    // 续过的段只进 `SPage`，不回写 `prims`——`findBlobs` 那边仍按原段抹墨，
    // 免得把符头啃掉（见 `extendVSegs` 的说明）。
    // 被并进升降号的竖段要摘掉（留着会被当成符干或小节线）
    vSegs: snapHollowToStems(syms, splitVoiceStems(extendVSegs(
      nl,
      [...prims.vSegs.filter((v) => !usedSegs.has(v)), ...stemSegs, ...inkStems],
      Math.round(unit.space * 0.35),
    ), headBoxes.map((h) => h.box), unit), unit),
    syms,
    braces: findBraces(nl, prims, unit, staffLefts, groups.map((g) => ({ top: g.lines[0].y, bottom: g.lines[4].y }))).map((c) => c.bbox),
    sysBrackets: groupByLeftInk(raster.bin, groups.map((g) => ({ top: g.lines[0].y, bottom: g.lines[4].y, left: Math.max(...g.lines.map((l) => l.left)) })), unit),
  });
  if (!findStaves(pg)) return empty(pg, raster, unit, opts.carryTime);

  findNoteheads(pg);
  findStems(pg);
  tagLooseStems(pg);
  // 符尾**按位置自举**，不查字典（见 `bootstrapFlags`）
  for (const f of bootstrapFlags(nl, pg, prims.beams, unit, harmonyMasks)) {
    ledger.claim(f.box, `flag:${f.code}`);
    const { obj, sym } = makeSymObj(pg.objs.length + pg.segs.length + 1, f, unit.height);
    pg.objs.push(obj);
    pg.symbols.push(sym);
  }
  findTails(pg);
  findBarlines(pg);
  const ctx = findClefKeyTime(pg);
  demoteMidKeys(pg, ctx);
  extendKeyChains(pg, ctx);
  shareKeySignature(ctx);
  keyFromChords(pg, ctx, harmonies.map((h) => h.text), unit);
  fixFlatReadAsSix(harmonies, ctx);
  makeSystems(pg);
  makeBars(pg);
  // 段的认领：**只记挂上标记的**（谱线/加线/符干/小节线/系统线/符尾）。
  // 没挂上标记的段是「抽出来了却没人要」的，留着当无主，那才是线索。
  for (const sg of pg.segs) {
    const tag = SEG_TAGS.find((t) => sg.hasTag(t));
    if (tag) ledger.claim({ x: sg.box.left, y: sg.box.top, w: sg.box.right - sg.box.left, h: sg.box.bottom - sg.box.top }, `seg:${tag}`);
  }
  const beams = toBeamShapes(prims.beams);
  const stems: StemInfo[] = [];
  const notes = buildNotes(pg, ctx, beams, stems);
  attachAccidentalsByPitch(pg, ctx, notes);
  splitUnisons(notes, stems);
  findTuplets(pg, beams, stems, notes);

  // ── 演奏法与力度 ─────────────────────────────────────────────────────────
  //
  // 这三步矢量路一直在跑（`staffomr/index.ts`），位图路**从来没调过**——所以力度
  // 一个都没进过 MusicXML，而字典其实早就认得出：实测宁静 p2 那个 `f`
  // 到 Maestro 的 `dynamicForte` 模板只有 19（字典里 `dynamicForte` 26 个实例、
  // `dynamicMP` 8 个）。缺的只是这一句挂接。
  const marks = findNotations(pg);
  attachNotations(pg, notes, marks.marks);
  // `mf` 印出来是**两个字母**，字典只认得出 `f`——先按版式把一串字母拼起来
  // （`dynamics.ts`），再按力度文本挂接，不走 `attachDynamics` 那条按单个 SMuFL 名的路。
  const dynamics = groupDynamics(marks.dynamics, cmap, unit);
  attachDynamicTexts(pg, notes, dynamics);

  // ── 声部标签 ────────────────────────────────────────────────────────────
  //
  // 条子**不论有没有缓存都要切**（与歌词字格同一条道理：切出来这件事本身
  // 就是「这块墨是标签」的判断）；认字靠 `labelOcr` 缓存，没缓存就只出条子。
  const labelStrips = findStaffLabels(raster.bin, pg.staves, unit);
  const staffLabels = new Map<number, string>();
  for (const st of labelStrips) {
    const txt = opts.labelOcr?.get(labelKey(st));
    const name = txt ? normalizeLabel(txt) : null;
    if (name) staffLabels.set(st.staff, name);
  }

  // ── 和弦：挂到音符上 ────────────────────────────────────────────────────
  //
  // 记号在上面（找符头之前）就切好了，这里只把它们造成文本对象交给矢量路那一套
  // ——分行、拼根音与后缀、挂给**下方 x 最近**的音符，一行不改。
  if (harmonies.length) {
    const objs = harmonies.map((t, i) =>
      makeTextObj(pg.objs.length + i, { cells: [{ box: t.box, ch: t.text }], sizeDev: t.box.h }));
    for (const o of objs) o.addTag("Harmony");
    pg.objs.push(...objs);
    // `merge = false`：记号已经按和弦文法切好了，别再按左右相接拼一次
    attachHarmonies(pg, notes, objs, false);
    liftHarmonies(notes, pg.normalStaffSpace || pg.space);
  }

  // ── 歌词 ────────────────────────────────────────────────────────────────
  //
  // **不走 `analyzeText`**：那一步靠「带连字符的音节」「音节间的延长线」当锚点
  // 把文本认成歌词，中文逐字一个音节、既不连字也不拉线，一整行一个锚点都没有。
  // 位图这边本来就是**按位置**切出歌词带的（谱行下方那条带），身份已经确定，
  // 直接造成文本对象交给 `buildLyricLines` / `attachLyrics`——那两步原样跑。
  const lyricLines: LyricLine[] = [];
  const lyricStats = { rows: 0, hit: 0, parity: 0 };
  const lyricStrips: LyricStrip[] = [];
  // 字格**不论有没有 OCR 缓存都要切**：切出来的字格是「这块墨是歌词」这一判断本身，
  // 与认不认得出那个字是两回事。账本按字格记一笔，无主表里才不会把整页歌词
  // 当成「从没看见的墨」（缓存没命中时曾经就是这样，覆盖率一下子低二十个点）。
  {
    // **认领了却没落成音符的「符头」也还给歌词**：歌词字的笔画（点、口字框）常被收成符头，
    // 归不上谱表又被扔掉，可认领还在，那一格字就从歌词行里缺了
    //（《善牧恩慈歌》第 4 段行首的「主」整字没了）。只看最终的音符在不在块里，不看 OCR，
    // 条子才与离线生成缓存时切得一模一样。
    const noteCenters = notes.map((n) => ({ x: (n.sym.box.left + n.sym.box.right) / 2, y: (n.sym.box.top + n.sym.box.bottom) / 2 }));
    const orphanHead = (c: Component) =>
      claimed.has(c.id) && !restIds.has(c.id) && !harmonyIds.has(c.id) &&
      !noteCenters.some((p) => p.x >= c.bbox.x - 1 && p.x <= c.bbox.x + c.bbox.w + 1 && p.y >= c.bbox.y - 1 && p.y <= c.bbox.y + c.bbox.h + 1);
    // **没人要的横段、竖段也是歌词的笔画**：「一」整字、「下」「生」的横笔、「上」的竖笔
    // 被原语那一步当成线段抽走，不成块，字格里就缺了那个字（《赞美一神》两行各缺一两个）。
    // 挂上了标记的（谱线、加线、符干、小节线、符杠……）不算。
    const segBlobs: Component[] = pg.segs
      .filter((sg) => !sg.hasAnyTag())
      .map((sg, k) => {
        const b = { x: Math.round(sg.box.left), y: Math.round(sg.box.top), w: Math.max(1, Math.round(sg.box.right - sg.box.left)), h: Math.max(1, Math.round(sg.box.bottom - sg.box.top)) };
        return { id: -1 - k, bbox: b, area: b.w * b.h, cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
      });
    const rows = findLyricRows(
      [...blobs.filter((c) => (!claimed.has(c.id) || orphanHead(c)) && !dictClaimed.has(c.id)), ...segBlobs],
      pg.staves.map((st) => ({ top: st.box.top, bottom: st.box.bottom, left: st.box.left, right: st.box.right })),
      unit,
    );
    for (const row of rows) for (const cell of row.cells) ledger.claim(cell, "lyric");
    const objs = [];
    const ocr = opts.lyricOcr;
    lyricStats.rows = rows.length;
    const stripRow = new Map<LyricStrip, LyricRow>();
    for (const row of rows) {
      const strip = stripOf(nl, row);
      if (strip) {
        lyricStrips.push(strip);
        stripRow.set(strip, row);
      }
    }
    /** OCR 认得出字的歌词行（剔「字的笔画被收成符头」要用，见下）。 */
    const readRows: LyricRow[] = [];
    const latinRows = new Set<LyricRow>();
    // 本页歌词条字高的中位数（只算命中缓存的条）：页脚小字与歌词字号差着三倍
    const hitH = (ocr ? lyricStrips : []).filter((st) => ocr!.get(stripKey(st))).map((st) => st.charH).sort((a, b) => a - b);
    const medH = hitH.length ? hitH[hitH.length >> 1] : 0;
    // **拉丁行的连字符闸只卡种子**：同一谱行下、上下紧挨着（2.5 个字高以内）一条带连字符的拉丁行的，
    // 过得了前两道闸就不要连字符——整行单音节词的歌词行常有（《奇异恩典》四段英文一半行没有连字符，
    // 漏掉的行让后面各段整体错位，拉丁歌词 20%）。书眉不会紧挨着歌词块；版权行会（晨曦破晓末行下面），
    // 但字号小：比相邻拉丁行矮两成以上的不链。
    const latinStrips = new Set<LyricStrip>();
    {
      const cand = (ocr ? lyricStrips : []).filter((st) => { const ch = ocr!.get(stripKey(st)); return ch && isLatinRow(ch, false); });
      for (const st of cand) if (isLatinRow(ocr!.get(stripKey(st))!)) latinStrips.add(st);
      const yOf = (st: LyricStrip) => Math.min(...stripRow.get(st)!.cells.map((c) => c.y));
      for (let grew = true; grew; ) {
        grew = false;
        for (const st of cand) {
          if (latinStrips.has(st)) continue;
          const r = stripRow.get(st)!;
          if ([...latinStrips].some((o) => stripRow.get(o)!.staffIndex === r.staffIndex && st.charH >= o.charH * 0.8 && Math.abs(yOf(o) - yOf(st)) <= Math.max(o.charH, st.charH) * LATIN_CHAIN)) {
            latinStrips.add(st);
            grew = true;
          }
        }
      }
    }
    for (const strip of ocr ? lyricStrips : []) {
      const chars = ocr!.get(stripKey(strip));
      if (!chars) continue; // 缓存没命中：这一条没跑过 OCR，宁可留空不编造
      lyricStats.hit++;
      // **页脚小字不是歌词**：赞美三一真神末行下面的版权行（字高 12，歌词 34~41）离低音谱表
      // 不到两个谱表高，被收成男声的第 1 段
      if (strip.charH < medH * LYRIC_MIN_H) continue;
      // **三格以内、认不出一半字的条不收**：谱表紧下方带加线的低音被切成一条（赞美三一真神
      // 末系统 3 格只认出一个「户」），占掉第 1 段，后面四段整体下移一段
      if (strip.cells.length <= 3 && foldLyricChars(chars).length < strip.cells.length * 0.5) continue;
      // **拉丁行绕开字格**：字格那一套是按汉字等宽见方切的，英文词宽差着数倍。
      // 逐字造盒、按间距补词间空格，断词断音节交给 `splitSyllables`（见 `lyric.ts`）。
      const latin = latinStrips.has(strip);
      // 拉丁行也算：齐来称颂英文第一行紧贴低音谱表，「we」的 e 被收成空心符头，还配上了加线
      if (latin || chars.some((c) => /\p{Script=Han}/u.test(c.ch))) readRows.push(stripRow.get(strip)!);
      if (latin) latinRows.add(stripRow.get(strip)!);
      // **只认出一个字的不是歌词行**：谱表与歌词之间的一横被切成一条、认成「一」，占掉第 1 段，
      // 后面几段整体下移（《高举主大能》第二系统）
      // 行里的笔画照样当字剔（上面已进 `readRows`），只是不出歌词：直接跳过的话，那一行被收成符头的
      // 笔画留下来成了假音（齐来称颂 −1.3、父恩广大 −0.6）
      if (!latin && foldLyricChars(chars).length <= 1) continue;
      const cells = latin ? latinCells(strip, chars) : mapCharsToCells(strip, chars);
      // 「字数 == 格数」这个结构指标只对汉字行有意义（拉丁行压根不切格）
      if (!latin && foldLyricChars(chars).length === strip.cells.length) lyricStats.parity++;
      if (!cells.some((c) => c.ch)) continue;
      const o = makeTextObj(pg.objs.length + objs.length, { cells, sizeDev: strip.charH });
      o.addTag("Lyric");
      objs.push(o);
    }
    pg.objs.push(...objs);
    // **歌词行里的「符头」是字的笔画**：歌词离谱表近的底本（《是谁》第一段歌词只在谱表下
    // 1.8 格），字里的横笔被当成加线、口字框被当成符头，认成谱表下五六条加线的 G3/C3
    // ——一行两三个，整首十来个假音。只剔**认得出汉字**的那几行、**中心**落在行内的；
    // 真的低音符头中心离谱表不过一两格，碰不到歌词行（行上沿在谱表下 1.8 格）。
    if (readRows.length) {
      const inRow = (n: StaffNote) => {
        const cx = (n.sym.box.left + n.sym.box.right) / 2;
        const cy = (n.sym.box.top + n.sym.box.bottom) / 2;
        if (cy < n.staff.box.bottom + unit.space) return false;
        // 中心要落在（贴着）某个字格上：字被拆散时，剩下的笔画就在旁边成了字格；
        // 真的低音符头旁边没有字格压着（合唱谱谱表间距窄，歌词行离低音符头常只有一格，
        // 只看「落在行里」实测会误删真音）
        const pad = (r: LyricRow) => r.charH * 0.25;
        return readRows.some((r) => {
          const top = Math.min(...r.cells.map((c) => c.y));
          const bot = Math.max(...r.cells.map((c) => c.y + c.h));
          if (cy <= top || cy >= bot) return false;
          // 拉丁行：字母被收成符头之后就不在字格里了（「we」的 e），落在行的左右端之内就算
          if (latinRows.has(r)) return cx > Math.min(...r.cells.map((c) => c.x)) && cx < Math.max(...r.cells.map((c) => c.x + c.w));
          return r.cells.some((c) => cx > c.x - pad(r) && cx < c.x + c.w + pad(r) && cy > c.y - pad(r) && cy < c.y + c.h + pad(r));
        });
      };
      for (let i = notes.length - 1; i >= 0; i--) if (inRow(notes[i])) notes.splice(i, 1);
    }
    lyricLines.push(...buildLyricLines(pg, objs));
    foldBilingualLyrics(pg, lyricLines);
    attachLyrics(notes, lyricLines);
  }

  // ── 拍号兜底：整页一个拍号都没认出、前页也没传下来 ─────────────────────────
  //
  // 拍号数字认不出来是常事（铅字本的「4」比模板窄一截，见上面拍号那一段的「分子至少是 2」），
  // 缺了它写出来的 MusicXML 就没有 `<time>`。按**第一声部每小节的时值和**取众数推一个 n/4，
  // 造成两个拍号数字放进首行的 ctx——写出端、跨页传递（`lastTimeSignature`）照常走。
  // 只推 2~9 拍的整拍（拍号字形只有一位数），至少要三个小节撑着。
  if (!opts.carryTime && pg.staves.every((st) => !(ctx.get(st)?.time.length))) {
    const sums: number[] = [];
    for (const st of pg.staves)
      for (const bar of st.bars) {
        const q = notes
          .filter((n) => n.staff === st && n.voice === 1 && !n.chordExtra && !n.grace && n.x >= bar.left && n.x < bar.right)
          .reduce((a, n) => a + n.duration * 4, 0);
        if (q > 0) sums.push(Math.round(q * 4) / 4);
      }
    const count = new Map<number, number>();
    for (const q of sums) count.set(q, (count.get(q) ?? 0) + 1);
    const ranked = [...count].filter(([q0]) => Number.isInteger(q0) && q0 >= 2 && q0 <= 9).sort((a, b) => b[1] - a[1]);
    // 4/4 是下游本来就缺省的拍号：证据不反对（4 拍的小节不少于最多那档的八成）就写它；
    // 别的拍数要明显压过第二名才采信——多声部谱认错的音会把小节和撑得五花八门
    //（《善牧恩慈歌》低音谱表那几行，4 拍与 5 拍各六个小节）
    const n4 = count.get(4) ?? 0;
    let q = 0;
    if (ranked.length && n4 >= 3 && n4 >= ranked[0][1] * 0.8) q = 4;
    else if (ranked.length && ranked[0][1] >= 3 && ranked[0][1] >= (ranked[1]?.[1] ?? 0) * 1.5) q = ranked[0][0];
    const first = pg.staves[0];
    const c0 = first && ctx.get(first);
    if (c0 && q) {
      const x = (c0.key.length ? Math.max(...c0.key.map((s0) => s0.box.right)) : (c0.clef?.box.right ?? first.box.left)) + unit.space * 0.5;
      const mid = (first.box.top + first.box.bottom) / 2;
      const w = unit.space;
      const up = makeSymObj(pg.objs.length, { box: { x, y: Math.round(first.box.top), w, h: Math.round(mid - first.box.top) }, code: `timeSig${q}` as SmuflName }, first.box.bottom - first.box.top);
      const dn = makeSymObj(pg.objs.length + 1, { box: { x, y: Math.round(mid), w, h: Math.round(first.box.bottom - mid) }, code: "timeSig4" }, first.box.bottom - first.box.top);
      c0.time.push(up.sym, dn.sym);
    }
  }

  // ── 混排谱：简谱行给五线谱纠错 ──────────────────────────────────────────
  //
  // 放在歌词挂完之后：纠的是音高与时值，删的是简谱对不上的多余音——
  // 挂歌词那一步要看到**所有**候选音才挂得准，先删了反而让字挂错位。
  const jianpuFix = opts.jianpuOcr && jianpuStrips.length
    ? fuseJianpu(
      notes,
      jianpuStrips,
      (strip) => pg.staves.find((st) => Math.abs(st.box.top - groups[strip.staff].lines[0].y) < unit.space),
      (strip) => opts.jianpuOcr!.get(jianpuKey(strip)),
      (st) => keyFifths(ctx.get(st)?.key ?? []),
      unit,
    )
    : null;

  // ── 松叶 ────────────────────────────────────────────────────────────────
  //
  // 只在**无主**的 contour 里找：认出来的符号不必再判一遍，而松叶从来没人认领。
  const wedges = findRasterWedges(cmap, unit, ledger.unclaimed());
  for (const wg of wedges) {
    for (const id of [wg.contourId, wg.pairedId]) {
      const c = id === undefined ? null : cmap.byId.get(id);
      if (c) ledger.claim(c.bbox, `wedge:${wg.type}`);
    }
  }
  attachWedges(pg, notes, wedges);

  // ── 弧线（圆滑线 / 连音线）────────────────────────────────────────────────
  //
  // 无主报表里最大的一类带外图形（GT 里宁静 283 条、破碎 326 条，位图路至今一条不认）。
  // 认出来之后交给矢量路现成的那一套：挂两端 → 接回跨行的 → 落到音符上，
  // `toxml` 出 `<slur>` / `<tied>`。判据与松叶正好相反（逐列一段墨、而且拱着），
  // 所以要在松叶**之后**跑，把松叶认走的先剔掉。
  const slurs = findRasterSlurs(cmap, unit, ledger.unclaimed(), pg.objs.length + pg.segs.length + 1000);
  for (const sl of slurs) ledger.claim({ x: sl.obj.box.left, y: sl.obj.box.top, w: sl.obj.box.right - sl.obj.box.left, h: sl.obj.box.bottom - sl.obj.box.top }, "slur");
  attachSlurs(slurs, notes, unit.space);
  reconnectSlurs(pg, slurs);
  markSlurNotes(slurs);

  return {
    page: pg,
    hasStaff: true,
    unknown: unknownObjs(pg).length,
    unit,
    raster,
    ctx,
    beams,
    notes,
    bars: checkBars(pg, ctx, notes, opts.carryTime),
    lyricLines,
    contours: cmap,
    ledger,
    lyricStrips,
    harmonyStrips,
    jianpuStrips,
    jianpuFix,
    harmonies,
    harmonyTexts,
    labelStrips,
    staffLabels,
    wedges,
    dynamics,
    slurs,
    lyricStats,
    debugBlobs: opts.debug ? blobs.map((c) => ({ id: c.id, box: c.bbox, area: c.area, claimed: claimed.has(c.id) })) : undefined,
    debugNl: opts.debug ? nl : undefined,
    debugPrims: opts.debug ? prims : undefined,
    debugGroups: opts.debug ? groups.map((g) => ({ top: g.lines[0].y, bottom: g.lines[4].y, space: g.space })) : undefined,
    debugRest: opts.debug ? blobImage(nl, prims, unit, onGrid) : undefined,
    carryTime: lastTimeSignature(pg, ctx, opts.carryTime),
  };
}

/**
 * **中英对照的闭合谱：下一行谱底下的拉丁歌词并到上一行谱，段号接着排。**
 *
 * 齐来称颂伟大之神那种排法：中文四段印在女声谱表下（两谱表之间），英文四段印在男声谱表下。
 * `buildLyricLines` 按「上方最近的谱行」收，两边各编 1~4 段，中文第 1 段与英文第 1 段
 * 就成了同一段，混成一串。照独唱谱的约定（坚固保障：中文 1~4、英文 5~8，都挂在旋律上）
 * 把英文挂回上一行谱、段号续在中文后面。
 *
 * 只在同一系统里**上一行谱全是汉字段、下一行谱全是拉丁段**时并——合唱谱四个声部
 * 各印各的中文词，那是各声部自己的第 1 段，不能动。
 */
function foldBilingualLyrics(pg: SPage, lines: LyricLine[]): void {
  const latin = (l: LyricLine) => {
    const t = l.syllables.map((s) => s.text).join("");
    const cjk = [...t].filter((c) => /[\u3400-\u9fff]/.test(c)).length;
    const lat = [...t].filter((c) => /[A-Za-z]/.test(c)).length;
    return lat > cjk * 3;
  };
  for (const sys of pg.systems) {
    for (let i = 0; i + 1 < sys.staves.length; i++) {
      const up = lines.filter((l) => l.staff === sys.staves[i]);
      const lo = lines.filter((l) => l.staff === sys.staves[i + 1]);
      if (!up.length || !lo.length || up.some(latin) || !lo.every(latin)) continue;
      const base = Math.max(...up.map((l) => l.verse));
      for (const l of lo) {
        l.staff = sys.staves[i];
        l.verse += base;
      }
    }
  }
}

/**
 * **调号串往右接**：`analyzeAccidental` 串调号要求相邻两个升降号**上下交叠**，
 * 而位图这边降号的盒收到了肚子上（见 `FLAT_BOWL_TOP`）——三个降号时 E♭ 的肚子在上间、
 * A♭ 的肚子在下面第二间，一点不交叠，离谱号又超过三格，第三个降号就接不上
 *（《圣哉三一歌伴奏》整首少一个降号，A 全读成还原）。升号上下对称、盒不收，不受影响。
 * 这里只补位图这一路：已有调号的谱行，右边**横向紧挨着**（间隙在 0 到自身宽之间，
 * 与 `analyzeAccidental` 同一条）、谁都没认领的升降号接到串尾。不动 `staffomr`。
 */
function extendKeyChains(pg: SPage, ctx: Map<Staff, StaffContext>): void {
  for (const c of ctx.values()) {
    if (!c.key.length) continue;
    const onStaff = (b: Box) => b.top < c.staff.box.bottom && b.bottom > c.staff.box.top;
    for (;;) {
      const last = c.key[c.key.length - 1];
      const nx = pg.symbols.find((s0) => {
        if (!isAccidental(s0.code) || s0.hasAnyTag() || !onStaff(s0.box)) return false;
        const dx = s0.box.left - last.box.right;
        return dx >= 0 && dx <= s0.box.right - s0.box.left;
      });
      if (!nx) break;
      nx.addTag("Key");
      c.key = [...c.key, nx];
    }
  }
}

/**
 * **和弦挂到同一拍的上声部**。`attachHarmonies` 只按 x 远近挑音，同一拍上下两个声部的头
 * 横向只差几个像素，谁近谁得；挂到下声部，写出来就排在 `<backup>` 后面，与 GT 的次序对不上
 *（圣哉三一歌伴奏 m5、m15：头的干一补上、时值一改，和弦就跳到了下声部，和弦档 100% → 86.7%）。
 * 和弦记号印在谱表上方，归上面那个音：同一谱行、x 差不到半格、位置更高又没挂和弦的音，挪过去。
 * 只补位图这一路，不动 `staffomr`。
 */
function liftHarmonies(notes: StaffNote[], sp: number): void {
  for (const n of notes) {
    if (!n.chord || n.rest) continue;
    let top: StaffNote | null = null;
    for (const m of notes) {
      if (m === n || m.rest || m.chord || m.staff !== n.staff || Math.abs(m.x - n.x) >= sp * 0.5) continue;
      if (m.sym.box.top >= (top ?? n).sym.box.top) continue;
      top = m;
    }
    if (!top) continue;
    top.chord = n.chord;
    n.chord = undefined;
  }
}

/**
 * **`findStems` 漏挂的符干**（位图路补，不动 `staffomr`）。那边两道判据在细线扫描件上太紧：
 *   - 符头边缘离竖段中线要不到**两倍谱线粗**：齐来称颂谱线一两个像素，窗口两像素半，
 *     符头盒偏出两像素半就挂不上；
 *   - 头要在竖段**一端**（一格之内）：叠置和弦里靠干尾那个头在中段，单看它判不过。
 * 这里对没挂标记的竖段，窗口放到 0.2 格，按贴着它的**整组头**判：最上那个头贴上端、或最下那个贴下端，
 * 且竖段从那组头往外伸出一格半以上（小节线擦过符头时头在它中段，挡得住）；
 * 或者左右两侧各贴一个头、上下都伸出去（两个声部共线的干，见下）。
 * 病例齐来称颂末三小节低音的附点二分和弦，干在盒左缘往下伸四格，读成全音符。
 */
function tagLooseStems(pg: SPage): void {
  const sp = pg.normalStaffSpace || pg.space;
  const heads = pg.symbols.filter((s0) => s0.ownerStaff && (s0.code === "noteheadBlack" || s0.code === "noteheadHalf"));
  for (const l of pg.segs) {
    if (!l.isV || l.hasAnyTag()) continue;
    const on = heads.filter((n) => overlapY(l.box, n.box) && (Math.abs(n.box.left - l.cx) < sp * 0.2 || Math.abs(n.box.right - l.cx) < sp * 0.2));
    if (!on.length) continue;
    const top = Math.min(...on.map((n) => (n.box.top + n.box.bottom) / 2));
    const bottom = Math.max(...on.map((n) => (n.box.top + n.box.bottom) / 2));
    const upEnd = Math.abs(top - l.top) <= sp && l.bottom - bottom >= sp * 1.5;
    const downEnd = Math.abs(bottom - l.bottom) <= sp && top - l.top >= sp * 1.5;
    // 二度错排的两个声部：左边的头朝上的干（贴右缘）与右边的头朝下的干（贴左缘）在同一列，
    // 连成一根两头都伸出去的竖段，两个头都落在中段（赞美三一真神 m15 的 D4/C4）。
    // 小节线擦过符头不会左右两侧各贴一个
    const twoSides =
      on.some((n) => Math.abs(n.box.right - l.cx) < sp * 0.2) &&
      on.some((n) => Math.abs(n.box.left - l.cx) < sp * 0.2) &&
      top - l.top >= sp * 1.5 &&
      l.bottom - bottom >= sp * 1.5;
    if (upEnd || downEnd || twoSides) l.addTag("Stem");
  }
}

/**
 * **曲中「转调」其实是临时记号**：`analyzeAccidental` 把紧跟小节线两格内、没挂上符头的升降号
 * 当成曲中转调的调号。可这本谱的临时记号离符头有 0.6~1.1 格，挂不上（见 `attachAccidentalsByPitch`），
 * 小节线后第一个音的升号就被当成了调号（齐来称颂 m5 的 D♯4：第一行高音谱表成了四个升号，
 * 整首音高掉到两成）。这里把**不接在谱号那一串后面**、右边 1.5 格内又有同高符头的调号升降号
 * 从 `ctx.key` 里摘出来，交给临时记号那一步。标记摘不掉（`staffomr` 不动），挂靠那一步按 `ctx.key` 认。
 */
function demoteMidKeys(pg: SPage, ctx: Map<Staff, StaffContext>): void {
  const sp = pg.normalStaffSpace || pg.space;
  const heads = pg.symbols.filter((s0) => s0.hasTag("Note"));
  for (const c of ctx.values()) {
    if (!c.clef || !c.key.length) continue;
    let edge = c.clef.box.right;
    const keep: Sym[] = [];
    for (const [i, k] of c.key.entries()) {
      const chained = k.box.left - edge <= sp * (i === 0 ? KEY_GAP_FIRST : KEY_GAP);
      const right = k.box.right;
      const owned = heads.some((n) => Math.abs(n.py - k.py) <= sp / 4 && n.box.left >= right - 2 && n.box.left - right <= sp * LOOSE_ACC_GAP);
      if (!chained && owned) continue;
      keep.push(k);
      if (chained) edge = k.box.right;
    }
    c.key = keep;
  }
}

/** 临时记号离符头最远多少格还算它的（见 `attachAccidentalsByPitch`）。 */
const LOOSE_ACC_GAP = 1.5;
/**
 * 谱中无主块配升降号模板的签名距离上限（见「谱中没人认领的升降还原号」）。
 * 实测真升号 46~68（齐来称颂 m5、赞美三一真神 m8/m9），误配的最近一个 87（善牧恩慈歌线距 11px
 * 的一截竖笔），再往上是 102~180 一大片；拍号那一档 180 太松，通用的 90 也挡不住 87。
 */
const LOOSE_ACC_DIST = 80;

/**
 * **临时记号按音高找主人**（位图路整个重分一遍，不动 `staffomr`）。两处不合用：
 *   - `analyzeAccidental` 要记号右缘到符头左缘不到半格、`buildNotes` 套用时又卡一格之内——
 *     齐来称颂这本谱实测 0.62~1.13 格（m3 E♯3、m7 D♯4、m13 的 C♮4 与 D♯3），认出来了也挂不上，全按调号读；
 *   - `buildNotes` 套用只看**盒子上下交叠**，升号盒有三格高，和弦里下面那个音也被盖进去
 *    （赞美三一真神 m8 F♯3 的升号给了 B2、m9 F♯3 的给了 D3）。
 * 这里按**同高**（中心差 ≤ 四分之一格；降号盒已收到肚子上）找右边第一个音，间隙放到 1.5 格：
 * 和弦里错开排的记号（还原号在上、升号在左下）各找各的。调号（`ctx.key`）不参与，重分完重算变音。
 */
function attachAccidentalsByPitch(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  const keys = new Set([...ctx.values()].flatMap((c) => c.key));
  for (const n of notes) n.accidental = null;
  const taken = new Set<Sym>();
  for (const a of pg.symbols) {
    if (!isAccidental(a.code) || keys.has(a)) continue;
    let best: StaffNote | null = null;
    let bd = Infinity;
    for (const n of notes) {
      if (n.rest || taken.has(n.sym)) continue;
      if (Math.abs(n.sym.py - a.py) > sp / 4) continue;
      const gap = n.sym.box.left - a.box.right;
      if (gap < -2 || gap > sp * LOOSE_ACC_GAP || gap >= bd) continue;
      best = n;
      bd = gap;
    }
    if (!best) continue;
    // 同一个头拆出来的同音两声部一起填
    for (const n of notes) if (n.sym === best.sym) n.accidental = accidentalAlter(a.code);
    taken.add(best.sym);
    a.addTag("Accidental");
  }
  calcAlters(pg, ctx, notes);
}

/**
 * **调号不全的谱行照抄同页的**：整首不转调是常态，同页各行调号本该一样。
 * 取**至少两行认得一模一样**的调号里最长的那个，一个都没认出、或只认出同类（全升/全降）
 * 前几个的谱行照它补齐。
 *
 *   - 颂赞与尊贵第一行的降号贴着高音谱号，去谱线后残留的一行墨把两者连成一块，
 *     被谱号盒整个吞掉；导出取第一行的调号，整首按 C 大调读、再按调号差移调，字母全错。
 *   - 齐来称颂的低音谱表三个升号，后两个在调号那一步已被别的路认领（当成符头），
 *     两行低音谱表只认出一个，G# 全读成 G。
 */
/**
 * **全页一个调号都没认出、和弦却指向别的调**：按和弦拼写补调号。
 *
 * 病例《主我敬拜你》（粗体铅字本）：F 大调的那一个降号印得极小、压在高音谱号右侧的弯钩上，
 * 与谱号连成一块，按块分不出来；六行全按 C 大调读，B♭ 全成了 B。可谱面上的和弦是
 * F、C/E、Dm、B♭、Gm7、C7……——**和弦的根音与低音是按调拼写的**，B♭ 这种拼写本身就说明了调。
 *
 * 做法：数根音与斜线后的低音，挑能容纳最多个的调（同分取升降号少的）。
 * 只在三件事都成立时才补：全页没有任何调号、和弦记号至少六个、那个调比 C 大调多容纳至少两个、
 * 带升降号拼写的根音至少两次、且容纳了八成以上——临时变化的和弦（副属和弦的根音）只是零星几个，推不动。
 */
function keyFromChords(pg: SPage, ctx: Map<Staff, StaffContext>, texts: string[], unit: { space: number; height: number }): void {
  const all = [...ctx.values()];
  if (!all.length || all.some((c) => c.key.length)) return;
  const notes: string[] = [];
  for (const t of texts)
    for (const m of t.matchAll(/(^|\/)([A-G])([#b♯♭]?)/g)) notes.push(m[2] + (m[3] === "#" || m[3] === "♯" ? "#" : m[3] ? "b" : ""));
  if (notes.length < 6) return;
  const scale = (f: number) =>
    new Set(
      "CDEFGAB".split("").map((l) =>
        f > 0 && "FCGDAEB".slice(0, f).includes(l) ? l + "#" : f < 0 && "BEADGCF".slice(0, -f).includes(l) ? l + "b" : l,
      ),
    );
  const score = (f: number) => {
    const sc = scale(f);
    return notes.filter((n) => sc.has(n)).length;
  };
  let best = 0;
  for (let f = -6; f <= 6; f++) if (score(f) > score(best) || (score(f) === score(best) && Math.abs(f) < Math.abs(best))) best = f;
  // 带升降号拼写的根音（B♭、F♯……）至少出现两次，才算和弦「说出了」调号；
  // 差额只要两个：OCR 常把 B♭ 读岔成 B6 之类，抵掉一个（《主我敬拜你》39 比 37）
  const spelled = notes.filter((n) => n.length === 2 && scale(best).has(n)).length;
  if (best === 0 || spelled < 2 || score(best) < score(0) + 2 || score(best) < notes.length * 0.8) return;
  const code: SmuflName = best > 0 ? "accidentalSharp" : "accidentalFlat";
  for (const c of all) {
    if (!c.clef) continue;
    const cb = c.clef.box;
    c.key = Array.from({ length: Math.abs(best) }, (_, i) => {
      const box = { x: cb.right + 1 + i * unit.space * 0.8, y: cb.top, w: unit.space * 0.7, h: unit.space * 2.5 };
      return makeSymObj(pg.objs.length + pg.segs.length + 1 + i, { box, code }, unit.height).sym;
    });
  }
}

/**
 * **和弦根音的降号读成了 6**：OCR 把「B♭」读成「B6」（《主我敬拜你》F 大调，B♭ 和弦两处都是）。
 * 调号定了之后按调纠：根音字母的**本音不在调内、降音在调内**，后面紧跟的 6 就是那个降号。
 * 调内有这个本音的（C 大调的 B6、G 大调的 E6）不动——那可能真是六和弦。
 */
function fixFlatReadAsSix(harmonies: HarmonyToken[], ctx: Map<Staff, StaffContext>): void {
  const c0 = [...ctx.values()].find((c) => c.key.length);
  const f = c0 ? keyFifths(c0.key) : 0;
  if (f >= 0) return;
  const flats = "BEADGCF".slice(0, -f);
  for (const h of harmonies) {
    const m = /^([A-G])6(.*)$/.exec(h.text);
    if (m && flats.includes(m[1])) h.text = `${m[1]}b${m[2]}`;
  }
}

function shareKeySignature(ctx: Map<Staff, StaffContext>): void {
  const all = [...ctx.values()];
  const sigOf = (c: StaffContext) => c.key.map((k) => k.code).join(",");
  const count = new Map<string, number>();
  for (const c of all) if (c.key.length) count.set(sigOf(c), (count.get(sigOf(c)) ?? 0) + 1);
  let best: StaffContext | null = null;
  for (const c of all) if (c.key.length && count.get(sigOf(c))! >= 2 && (!best || c.key.length > best.key.length)) best = c;
  // 最长的那个只出现一次也行——只要别的行（至少两行）认出的都是它的**前几个**：
  // 敬拜万世之王五行里一行认出两个降号、四行只认出头一个（第二个降号被去谱线切碎）
  const longest = all.filter((c) => c.key.length).sort((a, b) => b.key.length - a.key.length)[0];
  const others = all.filter((c) => c.key.length && c !== longest);
  if (longest && others.length >= 2 && (!best || longest.key.length > best.key.length) && others.every((c) => c.key.every((k, i) => k.code === longest.key[i].code)))
    best = longest;
  if (!best) return;
  const kind = best.key[0].code;
  if (best.key.some((k) => k.code !== kind)) return;
  for (const c of all) if (c.key.length < best.key.length && c.key.every((k) => k.code === kind)) c.key = best.key;
}

/** 两个盒的交叠占 `a` 的比例。 */
/**
 * **同音两声部**：一个符头右边一根朝上的干、左边一根朝下的干——闭合谱里
 * 女高女低（男高男低）唱同一个音时就这么记，一个头算两个音。
 * 认成一个音的话，多声部 GT 每个同音处都少一个（《赞美一神》十处）。
 * 克隆出来的那个挂朝下的干，不带歌词与和弦（那两样挂接在后面，挂给原来那个）。
 */
function splitUnisons(notes: StaffNote[], stems: StemInfo[]): void {
  // 朝上的干在头的**右缘**、朝下的在**左缘**。和弦共用一根干时，干常被中间的头
  // 切成两段，下面那段对上面那个头来说也「朝下」，但它还在右缘，不算。
  const up = new Set<Sym>();
  const down = new Set<Sym>();
  for (const st of stems) {
    const cx = (st.seg.box.left + st.seg.box.right) / 2;
    for (const s of st.notes) {
      const w = s.box.right - s.box.left;
      if (st.up && cx > s.box.left + w * 0.6) up.add(s);
      if (!st.up && cx < s.box.left + w * 0.4) down.add(s);
    }
  }
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n.rest || !up.has(n.sym) || !down.has(n.sym)) continue;
    n.stemUp = true;
    notes.splice(i + 1, 0, { ...n, stemUp: false, chordExtra: true, lyrics: undefined, chord: undefined });
  }
}

function overlapFrac(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.max(1, a.w * a.h) : 0;
}

/** 排查用：把一页的二值图取出来（识别坐标 = 像素坐标）。 */
export type { Binary };

/**
 * 半/全休止的位置闸：块的纵向中心要贴着某行谱的**第二线或第三线**（自上而下数）。
 *
 * 全休止吊在第二线下方、半休止坐在第三线上方，两者的墨迹都紧贴那条线，
 * 中心离线不超过半格。`buildNotes` 随后再按「在线上还是线下」分全与半
 * （那两个字形逐位相同，只能按几何判）。
 */
/** 四分休止的尺寸与填充率（从字典认出来的那批量出来的）。见 `bootstrapQuarterRest` 那一段。 */
const QREST_W = [0.75, 1.1] as const;
const QREST_H = [2.2, 3.1] as const;
const QREST_FILL = [0.33, 0.62] as const;

/** 行首「谱号 + 调号」那一段占几格（线距的倍数）。谱号约 2 格宽，
 *  七个降号排开也就再占 4 格，留一点余量。 */
const STAFF_START = 6;

/** 盒落在某行谱的**行首那一段**里吗（谱号 + 调号的地盘）。见 `bootstrapQuarterRest` 那一段。 */
function nearStaffStart(
  box: { x: number; y: number; h: number },
  groups: { lines: { y: number }[] }[],
  lefts: number[],
  unit: RasterUnit,
): boolean {
  const cy = box.y + box.h / 2;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (cy < g.lines[0].y - unit.space || cy > g.lines[4].y + unit.space) continue;
    if (box.x < lefts[i] + unit.space * STAFF_START) return true;
  }
  return false;
}

/** 盒的中心落在某行谱的**中线**附近吗——四分休止是竖着写在谱表正中的。 */
/** 八分休止的尺寸（格）与填充：顶上一个球、下面一根斜笔。 */
const EIGHTH_REST_W = [0.85, 1.3] as const;
const EIGHTH_REST_H = [1.7, 2.4] as const;
const EIGHTH_REST_FILL = [0.3, 0.5] as const;
const EIGHTH_REST_SLANT = 0.1;

/**
 * **八分休止按形状认**：顶上三成有一个够宽的球，下半截每行只有一笔细墨，而且这一笔
 * **越往下越往左**。「头 + 干」块（符干朝下）下半截也是一笔细墨，可那是竖的，不往左斜。
 * 《向主唱新歌》伴奏满页八分休止（约 1.1×2.0 格），与模板的距离 97~138，过不了门槛，
 * 于是被当成「头 + 干」摘出假头、或被当成四分休止收走。
 */
function isEighthRest(bin: Binary, b: Rect, area: number, unit: RasterUnit): boolean {
  const sp = unit.space;
  const w = b.w / sp;
  const h = b.h / sp;
  if (w < EIGHTH_REST_W[0] || w > EIGHTH_REST_W[1] || h < EIGHTH_REST_H[0] || h > EIGHTH_REST_H[1]) return false;
  const fill = area / Math.max(1, b.w * b.h);
  if (fill < EIGHTH_REST_FILL[0] || fill > EIGHTH_REST_FILL[1]) return false;
  const rows: { y: number; x0: number; x1: number; ink: number }[] = [];
  for (let y = b.y; y < b.y + b.h; y++) {
    let x0 = -1, x1 = -1, ink = 0;
    for (let x = b.x; x < b.x + b.w; x++) {
      if (!bin.data[y * bin.w + x]) continue;
      if (x0 < 0) x0 = x;
      x1 = x;
      ink++;
    }
    if (ink) rows.push({ y, x0, x1, ink });
  }
  const topRows = rows.filter((r) => r.y < b.y + b.h * 0.35);
  if (!topRows.length || Math.max(...topRows.map((r) => r.ink)) < sp * 0.55) return false;
  const low = rows.filter((r) => r.y >= b.y + b.h * 0.55);
  if (low.length < b.h * 0.3) return false;
  // 按**跨度**量，不按墨量：符干旁蹭着一截圆滑线的，墨不多、跨度宽（齐来称颂的 G3 −1.3）
  if (low.some((r) => r.x1 - r.x0 + 1 > sp * 0.4)) return false;
  // 下半截那一笔中心的斜率（最小二乘，x 对 y）：往下每行左移一成以上像素。实测斜笔 −0.2，符干 0 上下
  const my = low.reduce((a, r) => a + r.y, 0) / low.length;
  const mx = low.reduce((a, r) => a + (r.x0 + r.x1) / 2, 0) / low.length;
  let sxy = 0, syy = 0;
  for (const r of low) { sxy += (r.y - my) * ((r.x0 + r.x1) / 2 - mx); syy += (r.y - my) ** 2; }
  return syy > 0 && sxy / syy <= -EIGHTH_REST_SLANT;
}

/** 从块里的墨出发，在去线图上 8 连通回填整个连通域；出了窗口（左右各 1 格、上 0.5 格、下 2.6 格）就不算。 */
function fillAround(bin: Binary, b: Rect, unit: RasterUnit): { box: Rect; area: number } | null {
  const sp = unit.space;
  const x0 = Math.max(0, Math.floor(b.x - sp));
  const y0 = Math.max(0, Math.floor(b.y - sp * 0.5));
  const x1 = Math.min(bin.w - 1, Math.ceil(b.x + b.w + sp));
  const y1 = Math.min(bin.h - 1, Math.ceil(b.y + sp * 2.6));
  const seen = new Set<number>();
  const stack: number[] = [];
  for (let y = b.y; y < b.y + b.h && !stack.length; y++)
    for (let x = b.x; x < b.x + b.w; x++)
      if (bin.data[y * bin.w + x]) { stack.push(y * bin.w + x); seen.add(y * bin.w + x); break; }
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % bin.w;
    const y = (i - x) / bin.w;
    if (x <= x0 || x >= x1 || y <= y0 || y >= y1) return null;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const j = i + dy * bin.w + dx;
        if (!seen.has(j) && bin.data[j]) { seen.add(j); stack.push(j); }
      }
  }
  if (maxX < 0) return null;
  return { box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, area: seen.size };
}

/** `[x0,x1]` 整段都是墨的那些行，连成段返回（`[起行, 止行]`）。 */
function crossRuns(bin: Binary, x0: number, x1: number, y0: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = Math.max(0, y0); y <= Math.min(bin.h - 1, y1); y++) {
    let full = true;
    for (let x = x0; x <= x1 && full; x++) if (!bin.data[y * bin.w + x]) full = false;
    if (!full) continue;
    const last = out[out.length - 1];
    if (last && last[1] === y - 1) last[1] = y;
    else out.push([y, y]);
  }
  return out;
}

/** 列 `x` 上过 `(x,y)` 的竖墨段（允许左右各偏一像素续上）。 */
function vRunAt(bin: Binary, x: number, y: number): [number, number] | null {
  const ink = (xx: number, yy: number) => yy >= 0 && yy < bin.h && xx >= 0 && xx < bin.w && !!bin.data[yy * bin.w + xx];
  const at = (yy: number) => ink(x, yy) || ink(x - 1, yy) || ink(x + 1, yy);
  if (!at(y)) return null;
  let a = y;
  let b = y;
  while (at(a - 1)) a--;
  while (at(b + 1)) b++;
  return [a, b];
}

/**
 * **两个声部贴着的头各用一根干**：上声部的头在右缘出朝上的干，下声部的头在左缘出朝下的干，
 * 两头相距三度时上下贴着，下声部那根干的墨一直连到上面那个头的中心——`buildNotes` 于是把上面那个头
 * 同时挂到两根干上，出两遍（《向主唱新歌》D4/B3、A4/F4 一共五处）。
 * 这里把这种干的端点缩回到本声部的头：朝下的干顶端停在「右缘另有朝上干」的头上、
 * 同一根干上往下 0.6~1.6 格还有头、干从那个头再往下伸 1.5 格以上，就把顶端挪到下面那个头的中心；朝上的对称。
 * 「再伸 1.5 格」挡的是两个头左缘连成的竖墨（齐来称颂一根朝上的干挂两个头，左缘被当成下干，歌词 96 → 54）。
 */
function splitVoiceStems(segs: LineSeg[], heads: Rect[], unit: RasterUnit): LineSeg[] {
  const sp = unit.space;
  const tol = sp * 0.3;
  const xOf = (v: LineSeg) => (v.x0 + v.x1) / 2;
  const top = (v: LineSeg) => Math.min(v.y0, v.y1);
  const bot = (v: LineSeg) => Math.max(v.y0, v.y1);
  const cy = (h: Rect) => h.y + h.h / 2;
  const vertical = segs.filter((v) => bot(v) - top(v) > sp);
  return segs.map((v) => {
    if (bot(v) - top(v) <= sp) return v;
    const vx = xOf(v);
    // 朝下的干：挂在头的左缘，顶端落在头里
    const hTop = heads.find((h) => Math.abs(h.x - vx) <= tol && top(v) >= h.y - tol && top(v) <= h.y + h.h);
    if (hTop) {
      const below = heads.filter((h) => h !== hTop && Math.abs(h.x - hTop.x) <= sp * 0.4 && cy(h) - cy(hTop) >= sp * 0.6 && cy(h) - cy(hTop) <= sp * 1.6 && cy(h) <= bot(v));
      const up = vertical.some((u) => u !== v && Math.abs(xOf(u) - (hTop.x + hTop.w)) <= tol && bot(u) >= hTop.y - tol && bot(u) <= hTop.y + hTop.h + tol && top(u) < hTop.y - sp);
      if (below.length && up && bot(v) - Math.max(...below.map(cy)) >= sp * 1.5) {
        const ny = Math.min(...below.map(cy));
        return { ...v, y0: v.y0 < v.y1 ? ny : v.y0, y1: v.y0 < v.y1 ? v.y1 : ny };
      }
    }
    // 朝上的干：挂在头的右缘，底端落在头里
    const hBot = heads.find((h) => Math.abs(h.x + h.w - vx) <= tol && bot(v) >= h.y && bot(v) <= h.y + h.h + tol);
    if (hBot) {
      const above = heads.filter((h) => h !== hBot && Math.abs(h.x + h.w - (hBot.x + hBot.w)) <= sp * 0.4 && cy(hBot) - cy(h) >= sp * 0.6 && cy(hBot) - cy(h) <= sp * 1.6 && cy(h) >= top(v));
      const down = vertical.some((u) => u !== v && Math.abs(xOf(u) - hBot.x) <= tol && top(u) >= hBot.y - tol && top(u) <= hBot.y + hBot.h + tol && bot(u) > hBot.y + hBot.h + sp);
      if (above.length && down && Math.min(...above.map(cy)) - top(v) >= sp * 1.5) {
        const ny = Math.max(...above.map(cy));
        return { ...v, y0: v.y0 > v.y1 ? ny : v.y0, y1: v.y0 > v.y1 ? v.y1 : ny };
      }
    }
    return v;
  });
}

/**
 * **空心头的盒缘收到它的干上**：按内腔外扩一圈得来的头盒比墨宽，干常落在盒里离边缘三四个像素，
 * `findStems` 挂得上（两倍线宽），`buildStems` 认头却只容四分之一格，于是干有了、头没归上，
 * 下游把「没干的空心头」当全音符（《主我敬拜你》附点二分读成附点全音符）。只动 x，不动 y（音高不变）。
 * 原地改 `syms` 里的盒，原样返回竖段。
 */
function snapHollowToStems(syms: RasterSym[], segs: LineSeg[], unit: RasterUnit): LineSeg[] {
  const sp = unit.space;
  for (const s0 of syms) {
    if (s0.code !== "noteheadHalf") continue;
    const b = s0.box;
    for (const v of segs) {
      const vx = (v.x0 + v.x1) / 2;
      const top = Math.min(v.y0, v.y1);
      const bot = Math.max(v.y0, v.y1);
      if (bot - top < sp * 2 || bot < b.y || top > b.y + b.h) continue;
      const cy = b.y + b.h / 2;
      // 头在干的一端（与 findStems 同口径），**另一端不能已有别的符头**：符杠与谱线之间的空隙也会被当成
      // 内腔认出个「空心头」，它挂的那根干下端本有自己的黑头（坚固保障小节数 19 → 18）
      if (Math.abs(cy - top) > sp && Math.abs(cy - bot) > sp) continue;
      const farY = Math.abs(cy - top) < Math.abs(cy - bot) ? bot : top;
      if (syms.some((o) => o !== s0 && /^notehead/.test(o.code) && Math.abs(o.box.y + o.box.h / 2 - farY) <= sp && o.box.x - sp * 0.5 <= vx && vx <= o.box.x + o.box.w + sp * 0.5)) continue;
      if (vx > b.x + b.w - sp * 0.35 && vx < b.x + b.w) {
        s0.box = { ...b, w: Math.round(vx) - b.x };
        break;
      }
      if (vx > b.x && vx < b.x + sp * 0.35) {
        const nx = Math.round(vx);
        s0.box = { ...b, x: nx, w: b.x + b.w - nx };
        break;
      }
    }
  }
  return segs;
}

function midOfStaff(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) if (Math.abs(cy - ys[i + 2]) <= unit.space * 0.9) return true;
  return false;
}

/**
 * 符头右边的附点（见识别主流程「附点」那一段）。窗口：符头右缘往右 0.05~1.3 格、
 * 符头中心往上 0.85 格到往下 0.35 格。墨团要整个落在窗口里（孤立），
 * 大小 0.15~0.6 格、宽高比 0.6~1.7、填充过半；已经有符号压着的不算；
 * 同一列上下一格处还有一个这样的点，那是反复记号的两点，不算。
 */
function findDots(bin: Binary, syms: RasterSym[], unit: RasterUnit): Rect[] {
  const sp = unit.space;
  const out: Rect[] = [];
  const heads = syms.filter((s0) => /^notehead/.test(s0.code));
  const blobsIn = (x0: number, y0: number, x1: number, y1: number): Rect[] => {
    x0 = Math.max(0, Math.round(x0));
    y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(bin.w, Math.round(x1));
    y1 = Math.min(bin.h, Math.round(y1));
    const W = x1 - x0;
    if (W <= 0 || y1 <= y0) return [];
    const seen = new Uint8Array(W * (y1 - y0));
    const found: Rect[] = [];
    const stack: number[] = [];
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (seen[(y - y0) * W + (x - x0)] || !bin.data[y * bin.w + x]) continue;
        let minX = x, maxX = x, minY = y, maxY = y, area = 0, edge = false;
        seen[(y - y0) * W + (x - x0)] = 1;
        stack.push(x, y);
        while (stack.length) {
          const py = stack.pop()!;
          const px = stack.pop()!;
          area++;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = px + dx;
              const ny = py + dy;
              if (nx < 0 || ny < 0 || nx >= bin.w || ny >= bin.h || !bin.data[ny * bin.w + nx]) continue;
              if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) {
                edge = true;
                continue;
              }
              const j = (ny - y0) * W + (nx - x0);
              if (seen[j]) continue;
              seen[j] = 1;
              stack.push(nx, ny);
            }
        }
        if (edge) continue;
        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        if (w < Math.max(2, sp * 0.15) || h < Math.max(2, sp * 0.15) || w > sp * 0.6 || h > sp * 0.6) continue;
        if (w / h < 0.6 || w / h > 1.7 || area < w * h * 0.5) continue;
        found.push({ x: minX, y: minY, w, h });
      }
    return found;
  };
  /** 点落在这个头的附点窗口里吗。 */
  const inWindow = (b: Rect, d: Rect) => {
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    const hy = b.y + b.h / 2;
    return cx > b.x + b.w + sp * 0.05 && cx < b.x + b.w + sp * 1.3 && cy > hy - sp * 0.85 && cy < hy + sp * 0.35;
  };
  for (const hd of heads) {
    const b = hd.box;
    const cy = b.y + b.h / 2;
    for (const d of blobsIn(b.x + b.w + sp * 0.05, cy - sp * 0.85, b.x + b.w + sp * 1.3, cy + sp * 0.35)) {
      if (out.some((o) => overlapFrac(o, d) > 0)) continue;
      if (syms.some((s0) => overlapFrac(d, s0.box) > 0.3)) continue;
      // 反复记号的两点：同一列上下一格处还有一个点。
      // 但**和弦的附点**也是这样上下一格排着：另一个点若落在同列**另一个头**的附点窗口里，
      // 它就有自己的主人、不是反复记号（齐来称颂 m4/m17~m19、赞美三一真神 m5/m8 的附点二分和弦
      // 以前全被这条毙掉，读成二分或全音符）
      const dcx = d.x + d.w / 2;
      const dcy = d.y + d.h / 2;
      const twins = blobsIn(dcx - sp * 0.5, dcy - sp * 1.5, dcx + sp * 0.5, dcy + sp * 1.5)
        .filter((o) => Math.abs(o.y + o.h / 2 - dcy) > sp * 0.6)
        .filter((o) => !heads.some((h2) => h2 !== hd && h2.box.x < b.x + b.w && h2.box.x + h2.box.w > b.x && inWindow(h2.box, o)));
      if (twins.length) continue;
      out.push(d);
    }
  }
  return out;
}

/** 扁矩形的休止（全休止、二分休止、整小节休止）：形状都是一个贴着谱线的小实心矩形。 */
const isBarRest = (code: string) => code === "restHalf" || code === "restWhole" || code === "restHBar";

/**
 * 扁矩形休止分全、半：**全休止吊在第二线下，二分休止坐在中线上**。
 * 两者形状一样，只差位置（中心差半格），按中心在第二线与中线的哪一半判。
 * 全休止仍记 `restHBar`（整小节休止，时值随拍号），二分休止记 `restHalf`
 * ——原先一律记成整小节休止，《是谁》首小节「二分休止 + 四分休止 + 两个八分」因此多出三拍。
 */
function restKind(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): SmuflName {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) {
    if (cy < ys[i] - unit.space || cy > ys[i + 4] + unit.space) continue;
    return cy > (ys[i + 1] + ys[i + 2]) / 2 ? "restHalf" : "restHBar";
  }
  return "restHBar";
}

function nearRestLine(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) {
    for (const k of [1, 2]) if (Math.abs(cy - ys[i + k]) <= unit.space * 0.6) return true;
  }
  return false;
}

/** 块里**通高的竖笔**有几根：连续墨长过块高 55% 的列，按相邻成组数组数（隔一列以上算两根）。 */
function tallStrokes(bin: Binary, box: Rect): number {
  let groups = 0;
  let prev = -2;
  for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(bin.w, Math.ceil(box.x + box.w)); x++) {
    let run = 0;
    let best = 0;
    for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(bin.h, Math.ceil(box.y + box.h)); y++) {
      if (bin.data[y * bin.w + x]) best = Math.max(best, ++run);
      else run = 0;
    }
    if (best < box.h * 0.55) continue;
    if (x - prev > 1) groups++;
    prev = x;
  }
  return groups;
}

/** 两个头上下贴着的块：宽 0.9~1.7 格（一个头）、高 1.7~2.4 格（两个头）、填充率 ≥ 0.7。 */
function isStackedPair(box: Rect, area: number, unit: { space: number }): boolean {
  const w = box.w / unit.space;
  const h = box.h / unit.space;
  return w >= 0.9 && w <= 1.7 && h >= 1.7 && h <= 2.4 && area / Math.max(1, box.w * box.h) >= 0.7;
}
