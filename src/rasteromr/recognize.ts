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
import { buildRasterPage, type RasterSym } from "./adapt";
import { binSig, findBlobs, findPrimitives, removeStaffLines, type BeamQuad } from "./prims";
import { findRasterHeads } from "./notehead";
import { RasterGlyphLookup } from "./rasterglyphs";
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
  opts: { carryTime?: { beats: number; beatType: number } } = {},
): Promise<RasterPageResult> {
  const raster = await rasterizePage(pdfPage, OPS);
  const blank = buildRasterPage({ index, width: raster?.bin.w ?? 1, height: raster?.bin.h ?? 1, unit: { lineThick: 1, space: 1, height: 4 }, staffLines: [], hSegs: [], vSegs: [] });
  if (!raster) return empty(blank, null, null, opts.carryTime);
  const unit = estimateUnit(raster.bin);
  if (!unit) return empty(blank, raster, null, opts.carryTime);
  const lines = findStaffLines(raster.bin);
  if (!groupStaves(lines).length) return empty(blank, raster, unit, opts.carryTime);

  const nl = removeStaffLines(raster.bin, lines.map((l) => l.y), unit);
  const prims = findPrimitives(nl, unit, lines.map((l) => l.y));
  const blobs = findBlobs(nl, prims, unit);

  // 符头按性质判（填充率 + 有没有符干），不查字典；其余的块查字典。
  const heads = findRasterHeads(blobs, prims.vSegs, unit);
  const claimed = new Set(heads.map((h) => h.comp.id));
  const syms: RasterSym[] = heads.map((h) => ({ box: h.comp.bbox, code: h.code }));
  for (const c of blobs) {
    if (claimed.has(c.id)) continue;
    const code = look.lookup(binSig(nl, c.bbox), c.bbox.w / unit.space, c.bbox.h / unit.space);
    if (code) syms.push({ box: c.bbox, code });
  }

  const pg = buildRasterPage({
    index,
    width: raster.bin.w,
    height: raster.bin.h,
    unit,
    staffLines: lines,
    hSegs: prims.hSegs,
    vSegs: prims.vSegs,
    syms,
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
    carryTime: lastTimeSignature(pg, ctx, opts.carryTime),
  };
}

/** 排查用：把一页的二值图取出来（识别坐标 = 像素坐标）。 */
export type { Binary };
