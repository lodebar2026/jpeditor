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
import type { Rect } from "../omr/types";
import { findBarlines, findNoteheads, findStaves, findStems, findTails, makeBars, makeSystems, unknownObjs } from "../staffomr/page";
import { isAccidental, isClef, timeSigDigit } from "../staffomr/glyphs";
import { buildNotes, checkBars, findClefKeyTime, lastTimeSignature, type BeamShape, type StaffContext, type StaffNote, type StemInfo, type BarCheck } from "../staffomr/notedata";
import { attachDynamicTexts, attachNotations, attachWedges, findNotations, findTuplets } from "../staffomr/notations";
import type { SPage, Staff, Tag } from "../staffomr/model";
import { buildRasterPage, makeSymObj, makeTextObj, type RasterSym } from "./adapt";
import { binSig, blobImage, extendVSegs, findBlobs, findBraces, findPrimitives, groupByLeftInk, ledgerGrid, removeStaffLines, type BeamQuad, type LineSeg, type RasterPrims } from "./prims";
import { findRasterHeads, hollowHeadsFromHoles, judgeHeadBox, mergeHoles } from "./notehead";
import { bootstrapClefs, matchTemplate, RasterGlyphLookup, type BootStaff } from "./rasterglyphs";
import { findLyricRows, foldLyricChars, mapCharsToCells, stripKey, stripOf, type LyricStrip, type OcrChar } from "./lyric";
import { findHoles, traceContours, type ContourMap } from "./contour";
import { buildHeadMasks, headFromStemBlock, splitHeadCluster } from "./headmask";
import { findRasterWedges, type RasterWedge } from "./wedge";
import { groupDynamics, type RasterDynamic } from "./dynamics";
import { findRasterSlurs } from "./slur";
import { ContourLedger } from "./ledger";
import { attachLyrics, buildLyricLines, type LyricLine } from "../staffomr/textanalyze";
import { attachSlurs, markSlurNotes, reconnectSlurs, type SlurArc } from "../staffomr/slur";
import { estimateUnit, findStaffLines, groupStaves, type RasterUnit } from "./staffline";
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
function bootstrapFlags(bin: Binary, pg: SPage, beams: BeamQuad[], unit: RasterUnit): RasterSym[] {
  const sp = unit.space;
  const out: RasterSym[] = [];
  // **只看实心符头**：空心符头（二分/全音符）本来就不带符尾，
  // 给它安一个会把二分读成八分。
  const heads = pg.symbols.filter((s) => s.hasTag("Note") && s.code === "noteheadBlack");
  for (const st of pg.segsWithTag("Stem")) {
    const nt = heads.find(
      (s) => (Math.abs(s.box.left - st.cx) < sp / 3 || Math.abs(s.box.right - st.cx) < sp / 3) && s.box.top < st.bottom && st.top < s.box.bottom,
    );
    if (!nt) continue;
    const hy = (nt.box.top + nt.box.bottom) / 2;
    const far = Math.abs(st.top - hy) > Math.abs(st.bottom - hy) ? st.top : st.bottom;
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
    if (frac(0, FLAG_Y) < FLAG_INK) continue;
    // **符尾从符干尖端长出来**：贴着远端那一小截、紧挨符干右侧必须有墨。
    // 没这一条，从符干旁边路过的连音线、下一个音的符头都会把窗口填满
    // （实测只看整窗占比，小节自检 33.2% → 31.9%）。
    if (frac(0, 0.35) < FLAG_TIP) continue;
    const up = far < hy;
    // **第二个钩**：十六分的两道钩沿符干错开约一格。只认出第一道的话
    // 十六分整批读成八分（实测补上第一道之后 `16th→eighth` 一下涨到 171 处）。
    const two = frac(1.0, 2.2) >= FLAG_INK2;
    const code = two ? (up ? "flag16thUp" : "flag16thDown") : up ? "flag8thUp" : "flag8thDown";
    const h = sp * (two ? 2.2 : 1.5);
    const y0 = toward > 0 ? far : far - h;
    out.push({ box: { x: Math.round(st.cx), y: Math.round(y0), w: Math.round(sp * 1.5), h: Math.round(h) }, code });
  }
  return out;
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

/** 整小节休止的形状闸（见 `restSyms` 那一段）。放松到 1.6/0.8/0.9 与 1.5/0.75/0.95
 *  都**一个都不多认**——剩下的那些不在纸上（破碎三个女高合印一行，
 *  GT 里 P1/P2 中段的全休止根本没印出来）。 */
const REST_W = [0.9, 1.8] as const;
const REST_H = 0.8;
const REST_RATIO = 1.8;
const REST_FILL = 0.85;

/** 降号的肚子从盒顶往下第几成开始。取 0.45：盒高 2.36 格时中心正好下移 0.53 格，
 *  与实测的 0.55 格偏差吻合。 */
const FLAT_BOWL_TOP = 0.45;

/** 升降号「并回竖笔」之后与模板的签名距离上限。比通用的 90 松一点：
 *  并回来的盒是块的包围盒 + 竖段的中心线拼出来的，边界不如原块齐整。 */
const ACCID_TEMPLATE_DIST = 90;

/** 拍号数字与模板的签名距离上限。见 `bootstrapTimeSig` 那段的说明。 */
const TIME_TEMPLATE_DIST = 180;

/** 空心符头允许离谱表多远（线距的倍数）。见 `inBand` 那段的说明。 */
const HOLLOW_BAND = 3.0;

/**
 * 符尾窗口的墨占比门槛。
 *
 * 原来 0.25，收窄窗口之前是对的；收窄之后真符尾落在 **0.17~0.21**、
 * 真四分仍是 0.00（中间还是没人，只是整条尺子往下挪了）。
 * 扫过 0.10 / 0.14 / **0.16~0.18** / 0.20 / 0.22 / 0.25：
 * 时值 91.9 / 92.0 / **92.1** / 92.0 / 91.0 / 89.4%。
 */
const FLAG_INK = 0.18;
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
/** 第二道钩（十六分）的门槛。比第一道**严**：那一段窗口里还可能扫到下一个音的符干或符头。 */
const FLAG_INK2 = 0.3;

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
    /** 排查用：把连通块与「谁被认领了」带出来（`debugBlobs` 字段）。识别判据一条不改。 */
    debug?: boolean;
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
  const prims = findPrimitives(nl, unit, gridYs, staffLefts);
  const blobs = findBlobs(nl, prims, unit, ledgerGrid(gridYs, unit));

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
  const restIds = new Set<number>();
  const restSyms: RasterSym[] = [];
  for (const c of blobs) {
    const b = c.bbox;
    const w = b.w / unit.space;
    const h = b.h / unit.space;
    if (w < REST_W[0] || w > REST_W[1] || h < 0.3 || h > REST_H) continue;
    if (b.w < b.h * REST_RATIO) continue;
    if (c.area / Math.max(1, b.w * b.h) < REST_FILL) continue;
    if (!nearRestLine(b, lines, unit)) continue;
    restIds.add(c.id);
    restSyms.push({ box: b, code: "restHBar" });
  }

  const heads = findRasterHeads(nl, blobs.filter((c) => !restIds.has(c.id)), prims.vSegs, unit, onGrid, inBand, matchHollow);
  const claimed = new Set([...heads.map((h) => h.comp.id), ...restIds]);

  // ── 空心符头：按**内腔（洞）**再找一遍 ───────────────────────────────────
  //
  // 空心符头被去谱线切碎之后一块都判不成符头（实测宁静 p2 钢琴右手那个二分和弦
  // 碎成四片），而它的**内腔**还在。所以在**去谱线之前**的图上取全页的孔，
  // 尺寸像内腔的往外扩一圈就是符头；骑线的头内腔被谱线豁成两半，先并回去。
  // 判据全在 `notehead.ts::hollowHeadsFromHoles`。
  const holes = mergeHoles(findHoles(raster.bin, Math.max(4, Math.round(unit.space * unit.space * 0.06))), unit);
  const takenBoxes = heads.map((h) => h.box);
  // 带宽照 `HOLLOW_BAND`（±3 格）。扫过 ±1.5 / ±2 / ±3 格，三档一样
  // ——这一路的过检不在带边上。
  const stacked: RasterSym[] = hollowHeadsFromHoles(nl, holes, unit, prims.vSegs, inBand, takenBoxes);

  // ── 几个实心符头并成一块：按**谱内自举的 mask** 拆开 ─────────────────────
  //
  // 钢琴谱里二度、三度的和弦把两三个符头画得挨着（二度还错开在符干两侧），
  // 位图上并成一块，单头的尺寸闸一律判否——逐谱行摊开，钢琴两行漏得最狠
  //（宁静 P4.1 漏 122、破碎 P6.1 漏 213）。判据与搜索都限死在块内，见 `headmask.ts`。
  const masks = buildHeadMasks(raster.bin, [...heads.map((h) => ({ box: h.box, code: h.code })), ...stacked], unit, lines.map((l) => l.y));
  const pitchGrid = makePitchGrid(groups, unit);
  const onLineY = (y: number) => lines.some((l) => Math.abs(l.y - y) <= unit.space * 0.25);
  const split: RasterSym[] = [];
  /** 已经被认成**单个**符头、但要作废的那些（块里其实装着两三个头）。 */
  const dropHead = new Set<number>();
  if (masks.length) {
    for (const c of blobs) {
      if (claimed.has(c.id)) continue;
      const parts = splitHeadCluster(raster.bin, c.bbox, c.area, masks, unit, pitchGrid, onLineY);
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
      const parts = splitHeadCluster(raster.bin, b, h.comp.area, masks, unit, pitchGrid, onLineY);
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
  for (const c of blobs) {
    if (claimed.has(c.id)) continue;
    const code = look.lookup(binSig(nl, c.bbox), c.bbox.w / unit.space, c.bbox.h / unit.space);
    if (!code) continue;
    dictClaimed.add(c.id);
    // **半/全休止要按位置验一道**：它的字形是个 1.27×0.51 格的小实心矩形，
    // 位图上这种碎块一大把（符杠断头、粗横笔的一截），实测宁静一首认出 43 个
    // 全部被采纳，而谱面上根本没那么多。它有一条硬位置：
    // 半休止**坐在中线上**、全休止**吊在上面一线下**——不贴着这两条线的不是它。
    if ((code === "restHalf" || code === "restWhole") && !nearRestLine(c.bbox, lines, unit)) continue;
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
    // 落在这个盒里的字典结果作废（那是被切开的半截）
    for (let i = syms.length - 1; i >= 0; i--) {
      const s0 = syms[i].box;
      if (s0.x >= b.x - 1 && s0.x + s0.w <= b.x + b.w + 1 && s0.y >= b.y - 1 && s0.y + s0.h <= b.y + b.h + 1) syms.splice(i, 1);
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
        const m = matchTemplate(sig, w1, h1, look.templates ?? [], ACCID_TEMPLATE_DIST);
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
    merged.add(c.id);
    syms.push({ box: b, code: "restQuarter" });
    ledger.claim(b, "qrest:restQuarter");
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
  for (const g of groups) {
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
      if (claimed.has(c.id) || merged.has(c.id)) return false;
      const dc = dictClaimed.has(c.id) ? look.lookup(binSig(nl, b), b.w / unit.space, b.h / unit.space) : null;
      if (dc && (isClef(dc) || isAccidental(dc))) return false;
      if (b.x < left || b.x > left + unit.space * 14) return false;
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
        if (two[0] && two[1]) hits.push(two[0], two[1]);
      }
      if (!hits.length) continue;
      // 拍号**盖过字典**（与谱号同一条）：落在它盒里的字典结果作废，那是被切开的碎块
      for (let k = syms.length - 1; k >= 0; k--) {
        const s0 = syms[k].box;
        if (s0.x >= box.x - 1 && s0.x + s0.w <= box.x + box.w + 1 && s0.y >= box.y - 1 && s0.y + s0.h <= box.y + box.h + 1) syms.splice(k, 1);
      }
      syms.push(...hits);
      for (const hit of hits) ledger.claim(hit.box, `time:${hit.code}`);
      for (const id of col.ids) merged.add(id);
      break; // 一行谱只有一个拍号
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
      if (claimed.has(c.id) || dictClaimed.has(c.id) || merged.has(c.id)) continue;
      // 已经被别的路（谱号自举、拍号自举）出成 sym 的块不碰
      const b = c.bbox;
      if (syms.some((s0) => overlapFrac(b, s0.box) > 0.5)) continue;
      const r = headFromStemBlock(raster.bin, b, c.area, masks, unit, pitchGrid, onLineY);
      if (!r) continue;
      stemHeads.push({ box: r.head, code: "noteheadBlack" });
      stemSegs.push({ x0: r.stemX, y0: r.stemY0, x1: r.stemX, y1: r.stemY1, lw: unit.lineThick, maxLw: unit.lineThick * 2 });
      ledger.claim(r.head, "stemblock:noteheadBlack");
    }
    syms.push(...stemHeads);
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
    vSegs: extendVSegs(
      nl,
      [...prims.vSegs.filter((v) => !usedSegs.has(v)), ...stemSegs],
      Math.round(unit.space * 0.35),
    ),
    syms,
    braces: findBraces(nl, prims, unit, staffLefts, groups.map((g) => ({ top: g.lines[0].y, bottom: g.lines[4].y }))).map((c) => c.bbox),
    sysBrackets: groupByLeftInk(raster.bin, groups.map((g) => ({ top: g.lines[0].y, bottom: g.lines[4].y, left: Math.max(...g.lines.map((l) => l.left)) })), unit),
  });
  if (!findStaves(pg)) return empty(pg, raster, unit, opts.carryTime);

  findNoteheads(pg);
  findStems(pg);
  // 符尾**按位置自举**，不查字典（见 `bootstrapFlags`）
  for (const f of bootstrapFlags(nl, pg, prims.beams, unit)) {
    ledger.claim(f.box, `flag:${f.code}`);
    const { obj, sym } = makeSymObj(pg.objs.length + pg.segs.length + 1, f, unit.height);
    pg.objs.push(obj);
    pg.symbols.push(sym);
  }
  findTails(pg);
  findBarlines(pg);
  const ctx = findClefKeyTime(pg);
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
    const rows = findLyricRows(
      blobs.filter((c) => !claimed.has(c.id) && !dictClaimed.has(c.id)),
      pg.staves.map((st) => ({ top: st.box.top, bottom: st.box.bottom, left: st.box.left, right: st.box.right })),
      unit,
    );
    for (const row of rows) for (const cell of row.cells) ledger.claim(cell, "lyric");
    const objs = [];
    const ocr = opts.lyricOcr;
    lyricStats.rows = rows.length;
    for (const row of rows) {
      const strip = stripOf(nl, row);
      if (strip) lyricStrips.push(strip);
    }
    for (const strip of ocr ? lyricStrips : []) {
      const chars = ocr!.get(stripKey(strip));
      if (!chars) continue; // 缓存没命中：这一条没跑过 OCR，宁可留空不编造
      lyricStats.hit++;
      const cells = mapCharsToCells(strip, chars);
      if (foldLyricChars(chars).length === strip.cells.length) lyricStats.parity++;
      if (!cells.some((c) => c.ch)) continue;
      const o = makeTextObj(pg.objs.length + objs.length, { cells, sizeDev: strip.charH });
      o.addTag("Lyric");
      objs.push(o);
    }
    pg.objs.push(...objs);
    lyricLines.push(...buildLyricLines(pg, objs));
    attachLyrics(notes, lyricLines);
  }

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
    wedges,
    dynamics,
    slurs,
    lyricStats,
    debugBlobs: opts.debug ? blobs.map((c) => ({ id: c.id, box: c.bbox, area: c.area, claimed: claimed.has(c.id) })) : undefined,
    debugNl: opts.debug ? nl : undefined,
    debugPrims: opts.debug ? prims : undefined,
    debugRest: opts.debug ? blobImage(nl, prims, unit, onGrid) : undefined,
    carryTime: lastTimeSignature(pg, ctx, opts.carryTime),
  };
}

/** 两个盒的交叠占 `a` 的比例。 */
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

/** 盒的中心落在某行谱的**中线**附近吗——四分休止是竖着写在谱表正中的。 */
function midOfStaff(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) if (Math.abs(cy - ys[i + 2]) <= unit.space * 0.9) return true;
  return false;
}

function nearRestLine(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) {
    for (const k of [1, 2]) if (Math.abs(cy - ys[i + k]) <= unit.space * 0.6) return true;
  }
  return false;
}
