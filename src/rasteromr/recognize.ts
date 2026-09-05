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
import { binSig, extendVSegs, findBlobs, findBraces, findPrimitives, ledgerGrid, removeStaffLines, type BeamQuad, type LineSeg } from "./prims";
import { findRasterHeads, judgeHeadBox, type RasterHead } from "./notehead";
import { bootstrapClefs, matchTemplate, RasterGlyphLookup, type BootStaff } from "./rasterglyphs";
import { findLyricRows, foldLyricChars, mapCharsToCells, stripKey, stripOf, type OcrChar } from "./lyric";
import { traceContours, type ContourMap } from "./contour";
import { findRasterWedges, type RasterWedge } from "./wedge";
import { groupDynamics, type RasterDynamic } from "./dynamics";
import { ContourLedger } from "./ledger";
import { attachLyrics, buildLyricLines, type LyricLine } from "../staffomr/textanalyze";
import { estimateUnit, findStaffLines, groupStaves, type RasterUnit } from "./staffline";
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
  /**
   * 歌词切格的**结构指标**：切出几条、缓存命中几条、其中**字格数与 OCR 字数相等**的几条。
   * 最后那个数是切格好坏的直接尺子——相等才走得上「按序号一一对应」那条准路
   * （不等就得按 `xFrac` 摊，而那是 CTC 估的位置，误差常有半个字）。
   */
  lyricStats: { rows: number; hit: number; parity: number };
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
      const x0 = Math.round(st.cx + sp * 0.2);
      const x1 = Math.round(st.cx + sp * 1.5);
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
    if (frac(0, 1.5) < FLAG_INK) continue;
    // **符尾从符干尖端长出来**：贴着远端那一小截、紧挨符干右侧必须有墨。
    // 没这一条，从符干旁边路过的连音线、下一个音的符头都会把窗口填满
    // （实测只看整窗占比，小节自检 33.2% → 31.9%）。
    if (frac(0, 0.35) < FLAG_INK) continue;
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

/** 记账时算「这条段有主」的标记。见 `makeBars` 之后那一段。 */
const SEG_TAGS: Tag[] = ["Staff", "Leger", "Stem", "BarLine", "SysLine", "Tail", "Beam", "Bracket"];

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

/** 符尾窗口的墨占比门槛。实测没有符杠的音符要么 0（真四分）、要么 0.35 以上，中间没人。 */
const FLAG_INK = 0.25;
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
function sharedLegers(hSegs: LineSeg[], heads: RasterHead[], onGrid: (y: number) => boolean, unit: RasterUnit): LineSeg[] {
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
  } = {},
): Promise<RasterPageResult> {
  const raster = await rasterizePage(pdfPage, OPS);
  const blank = buildRasterPage({ index, width: raster?.bin.w ?? 1, height: raster?.bin.h ?? 1, unit: { lineThick: 1, space: 1, height: 4 }, staffLines: [], hSegs: [], vSegs: [] });
  if (!raster) return empty(blank, null, null, opts.carryTime);
  const unit = estimateUnit(raster.bin);
  if (!unit) return empty(blank, raster, null, opts.carryTime);
  const lines = findStaffLines(raster.bin);
  const groups = groupStaves(lines);
  if (!groups.length) return empty(blank, raster, unit, opts.carryTime);

  const nl = removeStaffLines(raster.bin, lines.map((l) => l.y), unit);
  const staffLefts = groups.map((g) => Math.max(...g.lines.map((l) => l.left)));
  const prims = findPrimitives(nl, unit, lines.map((l) => l.y), staffLefts);
  const blobs = findBlobs(nl, prims, unit);

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
  for (const b of prims.beams) ledger.claim(b.box, "beam");

  // 符头按性质判（填充率 + 有没有符干），不查字典；其余的块查字典。
  const onGrid = ledgerGrid(lines.map((l) => l.y), unit);
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
  const heads = findRasterHeads(nl, blobs, prims.vSegs, unit, onGrid, inBand, matchHollow);
  const claimed = new Set(heads.map((h) => h.comp.id));
  const syms: RasterSym[] = heads.map((h) => ({ box: h.box, code: h.code }));
  for (const h of heads) ledger.claim(h.box, `head:${h.code}`);
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

  const pg = buildRasterPage({
    index,
    width: raster.bin.w,
    height: raster.bin.h,
    unit,
    staffLines: lines,
    // 符头剪出来的加线要一并推进去，`findLegers` 才有得判
    hSegs: [...prims.hSegs, ...heads.map((h) => h.ledger).filter((l): l is NonNullable<typeof l> => !!l), ...sharedLegers(prims.hSegs, heads, onGrid, unit)],
    // 符干要**续到符头里**才与符头纵向相交（`findStems` / `buildStems` 的硬判据）。
    // 续过的段只进 `SPage`，不回写 `prims`——`findBlobs` 那边仍按原段抹墨，
    // 免得把符头啃掉（见 `extendVSegs` 的说明）。
    // 被并进升降号的竖段要摘掉（留着会被当成符干或小节线）
    vSegs: extendVSegs(
      nl,
      prims.vSegs.filter((v) => !usedSegs.has(v)),
      Math.round(unit.space * 0.35),
    ),
    syms,
    braces: findBraces(nl, prims, unit, staffLefts, groups.map((g) => ({ top: g.lines[0].y, bottom: g.lines[4].y }))).map((c) => c.bbox),
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
    for (const row of ocr ? rows : []) {
      const strip = stripOf(nl, row);
      if (!strip) continue;
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
    const c = cmap.byId.get(wg.contourId);
    if (c) ledger.claim(c.bbox, `wedge:${wg.type}`);
  }
  attachWedges(pg, notes, wedges);

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
    wedges,
    dynamics,
    lyricStats,
    carryTime: lastTimeSignature(pg, ctx, opts.carryTime),
  };
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
function nearRestLine(box: { y: number; h: number }, lines: { y: number }[], unit: RasterUnit): boolean {
  const cy = box.y + box.h / 2;
  const ys = [...lines].map((l) => l.y).sort((a, b) => a - b);
  for (let i = 0; i + 4 < ys.length; i += 5) {
    for (const k of [1, 2]) if (Math.abs(cy - ys[i + k]) <= unit.space * 0.6) return true;
  }
  return false;
}
