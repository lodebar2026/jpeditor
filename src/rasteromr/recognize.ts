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
import { findBarlines, findNoteheads, findStaves, findStems, findTails, makeBars, makeSystems, unknownObjs } from "../staffomr/page";
import { buildNotes, checkBars, findClefKeyTime, lastTimeSignature, type BeamShape, type StaffContext, type StaffNote, type StemInfo, type BarCheck } from "../staffomr/notedata";
import { findTuplets } from "../staffomr/notations";
import type { SPage, Staff } from "../staffomr/model";
import { buildRasterPage, makeTextObj, type RasterSym } from "./adapt";
import { binSig, findBlobs, findBraces, findPrimitives, ledgerGrid, removeStaffLines, type BeamQuad } from "./prims";
import { findRasterHeads } from "./notehead";
import { bootstrapClefs, RasterGlyphLookup, type BootStaff } from "./rasterglyphs";
import { findLyricRows, mapCharsToCells, stripKey, stripOf, type OcrChar } from "./lyric";
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
  carryTime,
});

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

  // 符头按性质判（填充率 + 有没有符干），不查字典；其余的块查字典。
  const onGrid = ledgerGrid(lines.map((l) => l.y), unit);
  const heads = findRasterHeads(nl, blobs, prims.vSegs, unit, onGrid);
  const claimed = new Set(heads.map((h) => h.comp.id));
  const syms: RasterSym[] = heads.map((h) => ({ box: h.box, code: h.code }));
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
    const code = look.lookup(binSig(nl, box), box.w / unit.space, box.h / unit.space);
    if (!code) continue;
    for (const id of group) merged.add(id);
    syms.push({ box, code });
  }

  const pg = buildRasterPage({
    index,
    width: raster.bin.w,
    height: raster.bin.h,
    unit,
    staffLines: lines,
    // 符头剪出来的加线要一并推进去，`findLegers` 才有得判
    hSegs: [...prims.hSegs, ...heads.map((h) => h.ledger).filter((l): l is NonNullable<typeof l> => !!l)],
    vSegs: prims.vSegs,
    syms,
    braces: findBraces(nl, prims, unit, staffLefts, groups.map((g) => ({ top: g.lines[0].y, bottom: g.lines[4].y }))).map((c) => c.bbox),
  });
  if (!findStaves(pg)) return empty(pg, raster, unit, opts.carryTime);

  findNoteheads(pg);
  findStems(pg);
  findTails(pg);
  findBarlines(pg);
  const ctx = findClefKeyTime(pg);
  makeSystems(pg);
  makeBars(pg);
  const beams = toBeamShapes(prims.beams);
  const stems: StemInfo[] = [];
  const notes = buildNotes(pg, ctx, beams, stems);
  findTuplets(pg, beams, stems, notes);

  // ── 歌词 ────────────────────────────────────────────────────────────────
  //
  // **不走 `analyzeText`**：那一步靠「带连字符的音节」「音节间的延长线」当锚点
  // 把文本认成歌词，中文逐字一个音节、既不连字也不拉线，一整行一个锚点都没有。
  // 位图这边本来就是**按位置**切出歌词带的（谱行下方那条带），身份已经确定，
  // 直接造成文本对象交给 `buildLyricLines` / `attachLyrics`——那两步原样跑。
  const lyricLines: LyricLine[] = [];
  if (opts.lyricOcr) {
    const rows = findLyricRows(
      blobs.filter((c) => !claimed.has(c.id) && !dictClaimed.has(c.id)),
      pg.staves.map((st) => ({ top: st.box.top, bottom: st.box.bottom, left: st.box.left, right: st.box.right })),
      unit,
    );
    const objs = [];
    for (const row of rows) {
      const strip = stripOf(nl, row);
      if (!strip) continue;
      const chars = opts.lyricOcr.get(stripKey(strip));
      if (!chars) continue; // 缓存没命中：这一条没跑过 OCR，宁可留空不编造
      const cells = mapCharsToCells(strip, chars);
      if (!cells.some((c) => c.ch)) continue;
      const o = makeTextObj(pg.objs.length + objs.length, { cells, sizeDev: strip.charH });
      o.addTag("Lyric");
      objs.push(o);
    }
    pg.objs.push(...objs);
    lyricLines.push(...buildLyricLines(pg, objs));
    attachLyrics(notes, lyricLines);
  }

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
