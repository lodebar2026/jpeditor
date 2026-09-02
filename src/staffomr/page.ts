// 页面级识别。逐条对应 musicpp `qtomr/qomr.cpp` 的 `Page::findXxx`，
// 调用顺序照 `Score::process`（**别调**）。改行为前先核对那边的原文。
//
// 与 musicpp 的一处结构性差别：那边一个 pdfium PageObject 就是一条线，标记挂在对象上；
// 本书有一批 PDF 把整行谱的所有线画进**一个** path 对象，故先拆成 `Seg`（见 model.ts），
// **标记挂在段上**。凡 musicpp 写 `o->addTag(...)` 的地方，这里都是 `seg.addTag(...)`。
//
// 坐标一律设备坐标、y 向下（见 model.ts 开头那段）。
import type { VecObj } from "../omr/vector";
import type { VecTextRun } from "../omr/vectext";
import { musicFamily } from "./symbolmap";
import { StaffGlyphLookup } from "./staffglyphs";
import {
  type Box,
  Bar,
  PObj,
  SPage,
  SSystem,
  Seg,
  Staff,
  Sym,
  between,
  boxH,
  overlapX,
  overlapY,
  sortByLeft,
  sortByTop,
} from "./model";
import { isFlag, isNoteHead, isRest } from "./glyphs";
import { isWhite, subPaths, thinRectAxis } from "./vecgeom";
import { classifyBarlines, tagRepeatDots } from "./barlines";

// 以下比例一律相对**小节线高度 H**（`SPage.barlineHeight`），别改成绝对点值。

/** 一条段最短要多长才收：H 的 4%（约六分之一格）。比这更短的是圆点、装饰片的边。 */
const MIN_SEG_RATIO = 0.04;

/** 重描合并的中心线容差：H 的 1.75%（约十四分之一格）。
 *  重描的偏移实测在这个量级，而真谱线的线距是 H/4——中间有一个数量级的余量。 */
const MERGE_TOL_RATIO = 0.0175;

/** 谱线间距的下限：H 的 10%。比这更近的两条「线」是同一条线的重描残留。 */
const MIN_LINE_GAP_RATIO = 0.1;

/** 谱线间距的上限：H 的 40%（名义值是 25%，留足小谱/大谱的余量）。 */
const MAX_LINE_GAP_RATIO = 0.4;

/** 谱行的**长宽比**下限：谱表宽度至少是它高度的这么多倍。
 *  吉他和弦图是 14×16pt 的方块，五条品格线间距也均匀——只靠「等距五条」分不开，
 *  靠这条分得开（真谱行宽 388pt、高 17pt）。 */
const STAFF_ASPECT_MIN = 4;

/** 谱线候选的长度门槛：整页最长横线的这个比例。符杠、加线都短得多。 */
const STAFF_LINE_LEN_RATIO = 0.35;

/**
 * 量出这一页的小节线高度 H（见 `SPage.barlineHeight` 的注释）。
 *
 * 取音乐字体 run 的**字号中位数**（按字形个数加权，正谱的字形远多于小谱，
 * 中位数因此落在正谱上）。一个音乐字形都没有的页（封面/目录）退回按页宽估——
 * 那些页反正没有谱表，H 只用来滤掉过短的段。
 */
function estimateBarlineHeight(runs: VecTextRun[], width: number): number {
  const sizes: number[] = [];
  for (const r of runs) {
    if (!musicFamily(r.font) || r.sizeDev <= 0) continue;
    for (let i = 0; i < r.glyphs.length; i++) sizes.push(r.sizeDev);
  }
  if (!sizes.length) return width / 25;
  sizes.sort((a, b) => a - b);
  return sizes[sizes.length >> 1];
}

/** 从一个路径对象里抽出所有直线段。
 *  两种来源：两点的直线子路径；以及**细长的轴对齐矩形**子路径（Finale 有时把
 *  符干/小节线画成填充矩形而不是描边直线），后者取它的中心线、线宽取短边。 */
function segsOf(o: PObj, minLen: number): Seg[] {
  const p = o.path;
  if (!p) return [];
  const out: Seg[] = [];
  const lw = Math.max(p.lineWidth, 0.3);
  for (const sp of subPaths(p)) {
    if (sp.pts.some((q) => q.curve)) continue;
    if (sp.pts.length === 2) {
      const [a, b] = sp.pts;
      const s = new Seg(o, a.x, a.y, b.x, b.y, lw);
      if (s.len >= minLen && (s.isH || s.isV)) out.push(s);
      continue;
    }
    const r = thinRectAxis(sp);
    if (r) {
      const s = new Seg(o, r.x0, r.y0, r.x1, r.y1, r.w);
      if (s.len >= minLen) out.push(s);
      continue;
    }
    // 多段折线：逐段收（这一批 PDF 里整行谱线就是这么画的）
    if (sp.pts.length > 2) {
      for (let i = 1; i < sp.pts.length; i++) {
        const a = sp.pts[i - 1];
        const b = sp.pts[i];
        const s = new Seg(o, a.x, a.y, b.x, b.y, lw);
        if (s.len >= minLen && (s.isH || s.isV)) out.push(s);
      }
    }
  }
  return out;
}

/**
 * 合并**重描**出来的段。
 *
 * 本书有一批 PDF（Finale 经 Distiller 那一路）把每条线用 `lw=0.06` 描五六遍、
 * 每遍偏 0.06pt 来凑出视觉线宽。不合并的话：一条谱线变成六条（「连续五条等距」
 * 会全落在同一条线的重描上）、一条小节线变成六条（实测全书小节线数虚高到 29 万）。
 *
 * **只在同一个 path 对象内部合并**。这条是要害：这一批 PDF 连**填充**也是拿密排细线
 * 画出来的（实测 p185 的符杠 = 14pt 宽的横线密排 2.5pt 高），跨对象合并会把谱线
 * 与压在它上面的符杠串成一条 2.3pt 粗的「线」，那一行谱的线距就废了。
 * 同一条线的重描一定在同一个对象里，所以按对象分组不会漏合。
 *
 * 判据：同向、中心线相距不到 `tol`、且在长轴方向上**真的重叠**。
 * 重叠而不是「首尾相接」是要害：同一条 y 上的加线与谱线是首尾相接的两条，
 * 接起来会把加线并进谱线、谱线左端跟着变长。
 * 合并后的线宽取「重描的跨度」与「最大原始线宽」中的大者——那才是视觉线宽。
 * `tol` 按页面单位取比例（`MERGE_TOL_RATIO`），别写绝对点值：同一本书里谱表大小差一倍。
 */
function mergeRedrawn(all: Seg[], tol: number): Seg[] {
  const out: Seg[] = [];
  const byObj = new Map<PObj, Seg[]>();
  for (const s of all) {
    const a = byObj.get(s.obj) ?? [];
    a.push(s);
    byObj.set(s.obj, a);
  }
  for (const segs of byObj.values()) mergeOne(segs, tol, out);
  return out;
}

function mergeOne(segs: Seg[], tol: number, out: Seg[]): void {
  for (const dir of [true, false]) {
    const list = segs.filter((s) => (dir ? s.isH : s.isV) && !(s.isH && s.isV));
    // 键：横段按 cy、竖段按 cx
    const key = (s: Seg) => (dir ? s.cy : s.cx);
    const lo = (s: Seg) => (dir ? s.left : s.top);
    const hi = (s: Seg) => (dir ? s.right : s.bottom);
    list.sort((a, b) => key(a) - key(b) || lo(a) - lo(b));
    let i = 0;
    while (i < list.length) {
      // 同一「带」里的段（中心线彼此相距不到 tol，链式）
      let j = i + 1;
      while (j < list.length && key(list[j]) - key(list[j - 1]) < tol) j++;
      const band = list.slice(i, j);
      i = j;
      // 带内按长轴分簇（重叠或相接的算一条）
      band.sort((a, b) => lo(a) - lo(b));
      let cluster: Seg[] = [];
      const flush = () => {
        if (!cluster.length) return;
        const a = cluster[0];
        const k0 = Math.min(...cluster.map(key));
        const k1 = Math.max(...cluster.map(key));
        const span = Math.max(k1 - k0, ...cluster.map((s) => s.lw));
        const c = (k0 + k1) / 2;
        const p0 = Math.min(...cluster.map(lo));
        const p1 = Math.max(...cluster.map(hi));
        out.push(dir ? new Seg(a.obj, p0, c, p1, c, span) : new Seg(a.obj, c, p0, c, p1, span));
        cluster = [];
      };
      for (const s of band) {
        if (!cluster.length) {
          cluster.push(s);
          continue;
        }
        const end = Math.max(...cluster.map(hi));
        if (lo(s) < end) cluster.push(s);
        else {
          flush();
          cluster.push(s);
        }
      }
      flush();
    }
  }
  // 既非水平也非垂直的段（斜线）原样留着
  out.push(...segs.filter((s) => !s.isH && !s.isV));
}

/** 建页：路径对象与文字对象各包一层 `PObj`，再从路径里抽出直线段。 */
export function buildPage(index: number, width: number, height: number, paths: VecObj[], runs: VecTextRun[]): SPage {
  const pg = new SPage(index, width, height);
  let id = 0;
  pg.barlineHeight = estimateBarlineHeight(runs, width);
  const raw: Seg[] = [];
  for (const p of paths) {
    const o = new PObj(id++, p, null);
    pg.objs.push(o);
    raw.push(...segsOf(o, pg.barlineHeight * MIN_SEG_RATIO));
  }
  pg.segs = mergeRedrawn(raw, pg.barlineHeight * MERGE_TOL_RATIO);
  for (const r of runs) pg.objs.push(new PObj(id++, null, r));
  return pg;
}

// ── findSymbols ─────────────────────────────────────────────────────────────

/**
 * `Page::findSymbols`：把音乐字体的文字对象拆成 `Sym`。
 *
 * musicpp 那边靠一张写死的字体名白名单加 `getSmufl` 的码位表，
 * **认不出来整个对象就丢掉**（`if(gl.empty()) return;`）。本仓换成 `StaffGlyphLookup`
 * （轮廓聚类字典，见 staffglyphs.ts），并且**逐字形判**而不是整对象判——
 * 一次 showText 里混着认得与不认得的字形是常态。
 */
export function findSymbols(pg: SPage, look: StaffGlyphLookup): void {
  for (const o of pg.objs) {
    if (o.hasAnyTag()) continue;
    const run = o.run;
    if (!run) continue;
    if (!musicFamily(run.font)) continue;
    let i = 0;
    for (const g of run.glyphs) {
      const code = look.lookup(run.font, g, run.sizeDev);
      if (!code) continue;
      const s = new Sym(o, i++, g, code);
      o.symbols.push(s);
      pg.symbols.push(s);
    }
    if (o.symbols.length) o.addTag("Symbol");
  }
}

// ── findStaves ──────────────────────────────────────────────────────────────

/**
 * `Page::findStaves`：找出这一页的谱行。
 *
 * 两条来源，缺一不可：
 *   1. **路径谱线**（Maestro/Opus 页）：左端对齐、等距、连着五条的水平段。
 *   2. **字形谱线**（Anastasia 页）：`staff5Lines` 字形横向平铺成一行——
 *      那 115 页**一条长横路径都没有**，只走第 1 条会一无所获。
 *
 * 打击谱（`unpitchedPercussionClef2` 旁边的单条横线）照 musicpp 单独收，
 * 它的 `lineYs` 只有一条，`stepDistance()` 返回 0。
 */
export function findStaves(pg: SPage): boolean {
  const hlines = pg.segs.filter((s) => s.isH);
  const done = new Set<Seg>();

  // 1) 打击谱
  const perc: Staff[] = [];
  for (const s of pg.symbols) {
    if (s.code !== "unpitchedPercussionClef2") continue;
    for (const hl of hlines) {
      if (done.has(hl)) continue;
      if (!overlapX(hl.box, s.box) || !overlapY(hl.box, s.box)) continue;
      const stf = new Staff();
      stf.lines.push(hl);
      hl.addTag("Staff");
      stf.init();
      perc.push(stf);
      done.add(hl);
    }
  }

  // 2) 路径谱线：**以「顶线 + 线距」为假设去凑五条**，不要求候选在数组里连续。
  //
  //    musicpp 是先按「左端点 x 相同」分组再找连续五条——本书行不通，两处都会崴：
  //      · 第一线与第五线常常比中间三条往左多探出 2pt（系统线的收口），左端并不相同；
  //      · 重描合并偶尔把一条线拆成相距 0.6pt 的两簇（p185 的第五线），
  //        「连续五条」会被那个多出来的候选顶掉，整行谱就找不着。
  //    改成：拿第 i 条当顶线，试它后面几条各自当第二线定出线距 d，
  //    再去 y+2d / y+3d / y+4d 附近找线（容差 0.2d）。多出来的重复候选自然被跳过。
  //
  //    候选还要先滤一道长度：符杠（横的那些）在 `thinRectAxis` 之后也是横段，
  //    混进来会把搜索打乱。谱线是整页最长的横线，取「最长横线的 35%」当门槛。
  const maxLen = Math.max(0, ...hlines.map((l) => l.len));
  const cands = hlines.filter((l) => !done.has(l) && l.len >= maxLen * STAFF_LINE_LEN_RATIO);
  cands.sort((a, b) => a.cy - b.cy);
  const used = new Set<Seg>();
  for (let i = 0; i < cands.length; i++) {
    if (used.has(cands[i])) continue;
    let picked: Seg[] | null = null;
    for (let k = i + 1; k < Math.min(cands.length, i + 4) && !picked; k++) {
      if (used.has(cands[k])) continue;
      const d = cands[k].cy - cands[i].cy;
      // 线距既有下限也有**上限**：谱表高度就是 H，一格是 H/4。
      // 没有上限的话，吉他和弦图的品格线会被逐个系统各取一条凑成一行「谱表」
      // ——实测 p40 出过一条从 y273 拉到 y590 的假谱行，音高全废。
      if (d < pg.barlineHeight * MIN_LINE_GAP_RATIO) continue;
      if (d > pg.barlineHeight * MAX_LINE_GAP_RATIO) break;
      const five = [cands[i], cands[k]];
      let ok = true;
      for (let n = 2; n <= 4; n++) {
        const want = cands[i].cy + d * n;
        let best: Seg | null = null;
        let bestD = d * 0.2;
        for (const c of cands) {
          if (used.has(c) || five.includes(c)) continue;
          const dd = Math.abs(c.cy - want);
          if (dd < bestD) {
            bestD = dd;
            best = c;
          }
        }
        if (!best) {
          ok = false;
          break;
        }
        five.push(best);
      }
      if (!ok) continue;
      // x 区间要彼此大幅重叠（同一行谱的五条线跨度几乎相同）
      const left = Math.max(...five.map((l) => l.left));
      const right = Math.min(...five.map((l) => l.right));
      const shortest = Math.min(...five.map((l) => l.len));
      if (right - left < shortest * 0.8) continue;
      if (right - left < d * 4 * STAFF_ASPECT_MIN) continue;
      picked = five.sort((a, b) => a.cy - b.cy);
    }
    if (!picked) continue;
    const stf = new Staff();
    for (const l of picked) {
      l.addTag("Staff");
      used.add(l);
      stf.lines.push(l);
    }
    stf.init();
    pg.staves.push(stf);
  }

  // 3) 字形谱线（Anastasia）
  pg.staves.push(...glyphStaves(pg));
  pg.staves.push(...perc);

  sortByTop(pg.staves);
  const dists: number[] = [];
  pg.staves.forEach((stf, i) => {
    stf.index = i;
    stf.page = pg;
    if (stf.lineYs.length <= 1) return;
    dists.push(stf.stepDistance());
  });
  dists.sort((a, b) => a - b);
  if (dists.length) {
    pg.normalStaffSpace = dists[Math.floor(dists.length / 2)] * 2;
    pg.largestSP = dists[dists.length - 1] * 2;
  }
  return pg.staves.length > 0;
}

/** `staff5Lines` 字形平铺出来的谱行（Sibelius/Anastasia 那条路）。 */
function glyphStaves(pg: SPage): Staff[] {
  const tiles = pg.symbols.filter((s) => s.code === "staff5Lines");
  if (!tiles.length) return [];
  const rows: Sym[][] = [];
  for (const t of tiles.slice().sort((a, b) => a.box.left - b.box.left)) {
    const tol = boxH(t.box) * 0.2;
    const row = rows.find((r) => Math.abs(r[0].box.top - t.box.top) < tol);
    if (row) row.push(t);
    else rows.push([t]);
  }
  const out: Staff[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.box.left - b.box.left);
    const left = row[0].box.left;
    const right = row[row.length - 1].box.right;
    const top = Math.min(...row.map((t) => t.box.top));
    const bottom = Math.max(...row.map((t) => t.box.bottom));
    const stf = new Staff();
    // 字形盒的上下沿就是第一线与第五线（`staff5Lines` 的墨迹恰好到边）
    for (let i = 0; i < 5; i++) stf.lineYs.push(top + ((bottom - top) * i) / 4);
    stf.init(left, right);
    for (const t of row) t.addTag("Staff");
    out.push(stf);
  }
  return out;
}

// ── findNoteheads ───────────────────────────────────────────────────────────

/** `Page::findNoteheads`：给每个符头/休止找它属于哪一行谱。 */
export function findNoteheads(pg: SPage): boolean {
  if (!pg.staves.length) return false;
  // 加线候选：长度在**一到三个线距**之间的横段。
  // 不加这道门槛，吉他和弦图的格线（本书每首歌上方都有一排）会被当成加线，
  // 把图里的黑点收成谱表上方的高音符头——实测 038 首因此多出十几个 E5/C5。
  const space = pg.normalStaffSpace || pg.space;
  const hlines = pg.segs.filter((s) => s.isH && !s.hasAnyTag() && s.len >= space * 0.8 && s.len <= space * 3);
  for (const s of pg.symbols) {
    if (!isNoteHead(s.code)) continue;
    findStaffForNote(pg, s, hlines);
  }
  return true;
}

/** `Page::findStaffForNote`。落在谱表纵向范围内（含上下各半格）的直接归属；
 *  否则休止取最近的一行，符头要靠**加线**确认（`findLegers`）。 */
export function findStaffForNote(pg: SPage, nt: Sym, lines: Seg[]): boolean {
  const y = nt.py;
  // 照 musicpp：`stfA` = 音符**下方**没有的那一侧，也就是音符**挂在它下面**的那行谱
  // （y 向上时 `dist<0` 即「音符在谱表中线之下」）。y 向下要反过来判，**别照抄符号**。
  let stfA: Staff | null = null; // 音符上方最近的那行谱（音符挂在它下面）
  let stfB: Staff | null = null; // 音符下方最近的那行谱（音符浮在它上面）
  let distA = Infinity;
  let distB = Infinity;
  for (const st of pg.staves) {
    const dist = y - st.cy;
    const dd = Math.abs(dist);
    let sp = st.stepDistance();
    let valid = false;
    if (sp === 0) {
      if (dd < pg.normalStaffSpace && nt.code === "restHBar") valid = true;
      sp = pg.normalStaffSpace / 2;
    }
    if (y > st.box.top - sp && y < st.box.bottom + sp) valid = true;
    if (valid) {
      nt.ownerStaff = st;
      nt.addTag("Note");
      return true;
    }
    // y 向下：dist > 0 表示音符在这行谱**下方**（谱行在音符上方）
    if (dist > 0) {
      if (dd < distA) {
        stfA = st;
        distA = dd;
      }
    } else if (dd < distB) {
      stfB = st;
      distB = dd;
    }
  }
  if (isRest(nt.code)) {
    nt.ownerStaff = distA < distB ? stfA : stfB;
    if (nt.ownerStaff) {
      nt.addTag("Note");
      return true;
    }
    return false;
  }
  // **先试音符上方那行**（照 musicpp 的次序）。反过来的话，大谱表里挂在顶行下沿的音符
  // 会先去试下面那行谱，归错行——实测多行系统的顶行小节自检因此只有 43.9%，
  // 而下行反而多出一截时值。
  if (stfA && findLegers(nt, stfA, lines)) return true;
  if (stfB && findLegers(nt, stfB, lines)) return true;
  return false;
}

/** `Page::findLegers`：谱表外的符头要有足够多条加线撑着才认。 */
export function findLegers(nt: Sym, stf: Staff, lines: Seg[]): boolean {
  const y2 = stf.cy;
  const stepDist = stf.stepDistance();
  // 往谱表反方向再让半格，免得贴着符头的那条加线被区间端点切掉
  const y1 = nt.py > y2 ? nt.py + stepDist : nt.py - stepDist;

  const poss: Seg[] = [];
  for (const l of lines) {
    // 加线要**横跨**符头（musicpp 只比左端点，那是因为它的加线对象与符头同起点；
    // 本书的加线两端都伸出符头，只比左端会把附近别的短横线也算进来）
    if (nt.px < l.left || nt.px > l.right) continue;
    if (between(l.cy, y1, y2)) poss.push(l);
  }
  // **整数除**：musicpp 是 `abs(step)/2-2`，C++ 的整数除法让 |step| ≤ 5 时 need ≤ 0
  // ——谱表外一两级的音符（下加一间的 D4、上加一间的 G5）不需要加线就收，
  // 因为它们本来就没有加线。移植成浮点除再加一道 `need > 0` 的闸，
  // 这些音符会全被丢掉；丢掉的符头连带它的符干也无人认领，那根符干随后被当成小节线
  // （实测 p100 的 x=409 就是这么来的）。
  const need = Math.floor(Math.abs(stf.middleStep(nt.py)) / 2) - 2;
  if (poss.length >= need) {
    nt.ownerStaff = stf;
    for (const it of poss) it.addTag("Leger");
    nt.addTag("Note");
    return true;
  }
  return false;
}

// ── findStems / findTails ───────────────────────────────────────────────────

/**
 * `Page::findStems`：符头左右两侧、纵向相交的竖线就是符干。
 *
 * 两种画法都要认，而且**都要落成 `Seg`**：
 *   1. 路径竖线（Maestro/Opus 页）。
 *   2. Anastasia 的 `stem` 字形——**符干是一个线距高的竖段沿 y 堆出来的**。
 *      不把它们拼成 Seg 的话，那 115 页一根符干都取不到，于是
 *      「八分音符读成四分、二分音符读成全音符」（实测时值混淆里最大的两项）。
 */
export function findStems(pg: SPage): void {
  // 先把 Anastasia 的符干字形拼成竖段，拼好的段与路径竖线一视同仁
  pg.segs.push(...glyphStems(pg));

  const vlines = pg.segs.filter((s) => s.isV && !s.hasAnyTag());
  for (const nt of pg.symbols) {
    if (!nt.ownerStaff) continue;
    if (nt.code !== "noteheadBlack" && nt.code !== "noteheadHalf") continue;
    const stf = nt.ownerStaff;
    const lw = (stf.lines[0]?.lw ?? pg.barlineHeight * 0.02) * 2;
    const space = stf.stepDistance() * 2 || pg.space;
    // 试过一条「两端正好压在第五线与第一线上的竖线是小节线、不是符干」的判据，
    // **实测更差**（全书小节自检 80.1% → 75.9%）：符头落在第一线、符干朝上伸到第五线
    // 的情形太常见，那条会把大批真符干判掉。留着这行注释，别再试第二遍。
    for (const l of vlines) {
      if (Math.abs(nt.box.left - l.cx) >= lw && Math.abs(nt.box.right - l.cx) >= lw) continue;
      if (!overlapY(l.box, nt.box)) continue;
      // **符头要在符干的某一端**，不能在中间：小节线也常常擦着符头过，
      // 那时符头落在它跨度的中段。不加这条，真小节线会被当成符干抢走
      // （实测 p227 每行只剩三个小节，音符全挤在一起）。
      const cy = (nt.box.top + nt.box.bottom) / 2;
      if (Math.abs(cy - l.top) > space && Math.abs(cy - l.bottom) > space) continue;
      l.addTag("Stem");
    }
  }
}

/** `stem` 字形 → 竖段：按 x 归列，列内纵向相接的一串并成一条。 */
function glyphStems(pg: SPage): Seg[] {
  const tiles = pg.symbols.filter((s) => s.code === "stem");
  if (!tiles.length) return [];
  for (const t of tiles) t.addTag("Stem");
  const xTol = pg.barlineHeight * 0.02; // 同一根符干的各段 x 完全相同，容差只为浮点
  const cols = new Map<number, Sym[]>();
  for (const t of tiles) {
    const k = Math.round((t.box.left + t.box.right) / 2 / Math.max(xTol, 1e-3));
    const a = cols.get(k) ?? [];
    a.push(t);
    cols.set(k, a);
  }
  const out: Seg[] = [];
  for (const col of cols.values()) {
    col.sort((a, b) => a.box.top - b.box.top);
    let run: Sym[] = [];
    const flush = () => {
      if (!run.length) return;
      const top = Math.min(...run.map((t) => t.box.top));
      const bottom = Math.max(...run.map((t) => t.box.bottom));
      const x = (run[0].box.left + run[0].box.right) / 2;
      const w = run[0].box.right - run[0].box.left;
      out.push(new Seg(run[0].parent, x, top, x, bottom, Math.max(w, 0.3)));
      run = [];
    };
    for (const t of col) {
      if (run.length) {
        const prevBottom = Math.max(...run.map((q) => q.box.bottom));
        // 相接（含轻微重叠）才算同一根；隔开的是另一根符干
        if (t.box.top > prevBottom + (t.box.bottom - t.box.top) * 0.5) flush();
      }
      run.push(t);
    }
    flush();
  }
  return out;
}

/** `Page::findTails`：符尾挂在与它同 x、纵向相交的符干上。 */
export function findTails(pg: SPage): boolean {
  const stems = pg.segsWithTag("Stem");
  let found = false;
  for (const t of pg.symbols) {
    if (!isFlag(t.code)) continue;
    for (const l of stems) {
      if (Math.abs(l.box.left - t.box.left) > l.lw) continue;
      if (!overlapY(t.box, l.box)) continue;
      found = true;
      t.addTag("Tail");
      break;
    }
  }
  return found;
}

// ── findBarlines ────────────────────────────────────────────────────────────

/** `Page::findBarlines`：竖线中，上端到第五线、下端到第一线的那些是小节线；
 *  与谱表左端重合的是系统线（`SysLine`），不算小节线。 */
export function findBarlines(pg: SPage): boolean {
  const vlines = pg.segs.filter((s) => s.isV && !s.hasAnyTag());
  const syslines: Seg[] = [];
  for (const l of vlines) {
    let isSys = false;
    for (const st of pg.staves) {
      if (Math.abs(st.box.left - l.cx) < Math.max(l.lw, 1)) isSys = true;
    }
    if (isSys) {
      l.addTag("SysLine");
      syslines.push(l);
    }
  }

  // 小节线 = **纵向盖满某一行谱**的竖线。
  //
  // musicpp 判的是「上端正好在第五线、下端正好在第一线」（`middleStep` 恰为 ±4）。
  // 那条在大谱表上不成立：钢琴/SATB 的小节线**贯穿两行谱**，对上面那行来说下端远在 −4 之外
  // ——实测 Opus 那 68 页（都是大谱表）因此一条小节线都没认出来，整页只切出一个小节。
  // 改判「盖满」：上端不低于第五线、下端不高于第一线，容差半格。
  const topStaff = new Map<Seg, Staff>();
  const covers = new Set<Seg>();
  const heads = pg.symbols.filter((s) => s.hasTag("Note") && !isRest(s.code));
  for (const l of vlines) {
    if (l.hasAnyTag()) continue;
    // **贴着某个符头左右缘的竖线是符干，不是小节线**。`findStems` 已经标过一遍，
    // 但它按「符头 → 找符干」走，符头没归到谱行上时那根符干就漏标了；
    // 这里按「竖线 → 找符头」再挡一道（实测 p100 的 x=409 就是这么混进来的）。
    if (heads.some((h) => overlapY(l.box, h.box) && (Math.abs(h.box.left - l.cx) < l.lw * 2 || Math.abs(h.box.right - l.cx) < l.lw * 2))) continue;
    for (const st of pg.staves) {
      // 容差取**四分之一格**：小节线的两端正落在第一线与第五线上。
      // 放宽到半格的话，从低音伸到符杠的长符干也会「盖满」谱行，被当成小节线
      // （实测 p100 因此在 x=409 处凭空多出一条）。
      const tol = (st.stepDistance() || 1) * 0.5;
      if (l.top <= st.box.top + tol && l.bottom >= st.box.bottom - tol) {
        topStaff.set(l, st);
        covers.add(l);
        break;
      }
    }
  }

  let found = false;
  const barX = new Set<number>();
  for (const it of covers) {
    const ts = topStaff.get(it)!;
    // 与谱表左端重合的是系统线，不算小节线
    if (Math.abs(ts.box.left - it.cx) >= Math.max(it.lw, 1)) {
      it.addTag("BarLine");
      barX.add(it.cx);
    }
    found = true;
  }

  // 短小节线（只跨一部分谱表的，如钢琴谱中间那截）：与已认小节线同 x 的收进来。
  // **长度要够**（至少半个谱表高）：`barX` 是整页共用的，别的谱行上的小节线 x
  // 会把这一行上一两 pt 长的碎段也收成小节线，`classifyBarlines` 随后就在那儿切一刀
  // （实测 p351 因此一行切出 14 个小节）。
  const minLen = Math.min(...pg.staves.map((s) => boxH(s.box))) * 0.5;
  for (const l of vlines) {
    if (l.hasAnyTag()) continue;
    if (l.len < minLen) continue;
    for (const x of barX) {
      if (Math.abs(l.cx - x) < Math.max(l.lw, 1)) {
        l.addTag("BarLine");
        break;
      }
    }
  }

  // Anastasia：小节线是字形
  for (const s of pg.symbols) {
    if (s.code === "barlineSingle" || s.code === "barlineFinal" || s.code === "barlineDouble") s.addTag("BarLine");
  }
  void syslines;
  return found;
}

// ── makeSystems ─────────────────────────────────────────────────────────────

/**
 * `Page::makeSystems`：把谱行归成**系统**。
 *
 * musicpp 靠 `SysLine`（谱行左端那条竖线）串：一条系统线纵向盖住的几行谱是一个系统。
 * 本书还要补一条：Anastasia 那 115 页的系统左端画的是 `bracket` **字形**、不是路径竖线，
 * 只认路径会把 SATB 的四行谱各算一个系统。没有任何左端标记的（独唱谱）各自成系统。
 */
export function makeSystems(pg: SPage): void {
  const marks: Box[] = [
    ...pg.segsWithTag("SysLine").map((s) => s.box),
    ...pg.symbols.filter((s) => s.code === "bracket" || s.code === "brace").map((s) => s.box),
  ];
  const done = new Set<Staff>();
  for (const b of marks) {
    const arr = pg.staves.filter((st) => overlapY(st.box, b));
    if (arr.length < 2) continue; // 只盖住一行的左端线不构成「系统」，留给下面各自成系统
    if (arr.some((st) => done.has(st))) continue;
    const sys = new SSystem();
    sys.staves = arr.slice().sort((a, b2) => a.box.top - b2.box.top);
    sys.init();
    pg.systems.push(sys);
    for (const st of arr) done.add(st);
  }
  for (const st of pg.staves) {
    if (done.has(st)) continue;
    const sys = new SSystem();
    sys.staves = [st];
    sys.init();
    pg.systems.push(sys);
  }
  pg.systems.sort((a, b) => a.box.top - b.box.top);
  pg.systems.forEach((s, i) => (s.index = i));
}

// ── 收尾 ────────────────────────────────────────────────────────────────────

/** `Page::removeWhite`：纯白填充是排版软件铺的底衬，原件上看不见，别当墨迹。 */
export function removeWhite(pg: SPage): void {
  pg.objs = pg.objs.filter((o) => !(o.path && isWhite(o.path) && !o.hasAnyTag()));
}

/**
 * `Page::markUnknown`：还没有主的对象。这个数是识别覆盖率的硬指标。
 *
 * 「有主」有三种：对象自己带标记（文字对象）、对象拆出来的**任一段**带标记
 * （谱线/符干/小节线都挂在段上）、对象拆出来的字形里有认出来的符号。
 */
export function unknownObjs(pg: SPage): PObj[] {
  const owned = new Set<PObj>();
  for (const s of pg.segs) if (s.hasAnyTag()) owned.add(s.obj);
  return pg.objs.filter((o) => !o.hasAnyTag() && !owned.has(o));
}

/** 还没有主的**线段**。段级覆盖率——比对象级细，动几何判据时看它。 */
export function unknownSegs(pg: SPage): Seg[] {
  return pg.segs.filter((s) => !s.hasAnyTag());
}

/** 谱表的小节：由已认的小节线切开。`System::makeBars` 的页面级前身。
 *  小节线的**样式与反复**由 `barlines.ts` 归组后给出，这里顺带记到 `Bar` 上。 */
export function makeBars(pg: SPage): void {
  for (const stf of pg.staves) {
    const marks = classifyBarlines(pg, stf);
    tagRepeatDots(pg, stf, marks);
    const xs = marks.map((m) => m.x);
    let left = stf.box.left;
    let pendingLeftRepeat = false;
    // 一行谱的第一小节，左端反复要从**上一行末尾**接过来（跨行的 `|:` 印在行首）
    let prevLeftRepeat = marks[0]?.repeat === "forward" || marks[0]?.repeat === "both";
    // **两条小节线挨得比两个线距还近，就是同一处**（细+粗的终止线、反复线的两笔）。
    // 原先用半个线距当门槛，实测会在终止线处切出一个 4pt 宽、一个音符都没有的空小节。
    const minBar = (stf.stepDistance() || 1) * 4;
    for (const x of xs) {
      if (x - left < minBar) {
        left = x;
        continue;
      }
      const bar = new Bar(stf);
      bar.left = left;
      bar.right = x;
      const mk = marks.find((m) => m.x === x);
      bar.rightStyle = mk?.style ?? null;
      bar.rightRepeat = mk?.repeat === "backward" || mk?.repeat === "both";
      // `|:` 记在**下一小节**的左端（MusicXML 的 forward repeat 挂在 location="left"）
      pendingLeftRepeat = mk?.repeat === "forward" || mk?.repeat === "both";
      bar.leftRepeat = prevLeftRepeat;
      prevLeftRepeat = pendingLeftRepeat;
      stf.bars.push(bar);
      left = x;
    }
    if (stf.box.right - left > minBar) {
      const bar = new Bar(stf);
      bar.left = left;
      bar.right = stf.box.right;
      bar.leftRepeat = prevLeftRepeat;
      stf.bars.push(bar);
    }
    void pendingLeftRepeat;
    for (const s of pg.symbols) {
      if (!s.hasTag("Note") || s.ownerStaff !== stf) continue;
      const b = stf.bars.find((x) => s.px >= x.left && s.px < x.right);
      if (b) b.notes.push(s);
    }
    for (const b of stf.bars) sortByLeft(b.notes);
  }
}
