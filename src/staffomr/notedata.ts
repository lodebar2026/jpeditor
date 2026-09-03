// 音符层：谱号 / 调号 / 拍号 / 临时记号 / 附点 / 符干符尾符杠 → 音高与时值。
// 对应 musicpp `qtomr/qomr.cpp::findClefKeyTime`、`analyzeAccidental` 与
// `qtomr/NoteData.cpp` 的 `analyzeStem/analyzeBeam/analyzeDot/analyzeClefSig/analyzeKeySig`。
//
// 坐标一律设备坐标、y 向下。
import {
  type Box,
  SPage,
  Seg,
  Staff,
  Sym,
  overlapY,
  sortByLeft,
  xSpace,
} from "./model";
import { accidentalAlter, flagLevel, isAccidental, isClef, isRest, restDuration, timeSigDigit } from "./glyphs";
import { subPaths } from "./vecgeom";

// ── 全音阶序号 ──────────────────────────────────────────────────────────────
//
// musicpp 的 `ClefSig::middleStep()`：谱表**中线**（第三线）的全音阶序号。
//   序号 = (octave + 1) × 7 + stepIdx，stepIdx: C0 D1 E2 F3 G4 A5 B6。
//   高音谱号中线 B4 → 5×7+6 = 41；低音谱号中线 D3 → 4×7+1 = 29；
//   `gClef8vb`（唱低八度）中线记 B3 → 34。**这三个数照抄原文，别自己推。**

export const STEP_LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;

/** 谱号 → 中线的全音阶序号。认不出来的谱号返回 null。 */
export function clefMiddleStep(code: string): number | null {
  switch (code) {
    case "fClef":
      return 29;
    case "fClef8vb":
      return 22;
    case "gClef":
      return 41;
    case "gClef8vb":
      return 34;
    case "gClef8va":
      return 48;
    case "cClef":
      return 35; // C 谱号（中音）中线 C4 → 5×7+0
    case "unpitchedPercussionClef1":
    case "unpitchedPercussionClef2":
      return 41;
    default:
      return null;
  }
}

/** 全音阶序号 → 音名与八度。 */
export function stepToPitch(idx: number): { step: string; octave: number } {
  const o = Math.floor(idx / 7) - 1;
  const s = ((idx % 7) + 7) % 7;
  return { step: STEP_LETTERS[s], octave: o };
}

// ── 谱号 / 拍号 / 调号 ──────────────────────────────────────────────────────

export interface StaffContext {
  staff: Staff;
  /** 本行谱起头的谱号符号。 */
  clef: Sym | null;
  /** 调号里的升降号（按 x 排）。 */
  key: Sym[];
  /** 拍号数字（按 x 排，上下两排各一半）。 */
  time: Sym[];
}

/**
 * `Page::findClefKeyTime` + `Page::analyzeAccidental`。
 *
 * 顺序有讲究（照原文）：先把「贴着某个符头左边、同高度」的升降号标成临时记号，
 * **剩下的**才可能是调号——调号的判据是「紧跟在谱号之后」「紧跟在另一个调号升降号之后」
 * 或「紧跟在小节线之后」（曲中转调）。
 */
export function findClefKeyTime(pg: SPage): Map<Staff, StaffContext> {
  const accids: Sym[] = [];
  const clefs: Sym[] = [];
  const times: Sym[] = [];
  for (const it of pg.symbols) {
    if (isAccidental(it.code)) accids.push(it);
    else if (isClef(it.code)) clefs.push(it);
    else if (timeSigDigit(it.code) >= 0 || it.code === "timeSigCommon" || it.code === "timeSigCutCommon") times.push(it);
  }

  const validClefs: Sym[] = [];
  for (const c of clefs) {
    // musicpp 判的是「基线落在谱表五条线之内」（`abs(middleStep) < 4`）。
    // 本书不行：Anastasia 的谱号基线落在第一线上（正好 -4，被判掉），整页一个谱号都认不出。
    // 改判**墨迹与谱表的纵向重叠**——谱号总是骑在它那行谱上，重叠最多的那行就是它的。
    let stf: Staff | null = null;
    let best = 0;
    for (const st of pg.staves) {
      const ov = Math.min(c.box.bottom, st.box.bottom) - Math.max(c.box.top, st.box.top);
      if (ov > best) {
        best = ov;
        stf = st;
      }
    }
    if (!stf) continue;
    c.ownerStaff = stf;
    c.addTag("Clef");
    validClefs.push(c);
  }
  for (const c of times) {
    for (const st of pg.staves) {
      if (Math.abs(st.middleStep(c.py)) <= 4) {
        c.ownerStaff = st;
        c.addTag("Time");
        break;
      }
    }
  }

  analyzeAccidental(pg, accids, validClefs);

  const ctx = new Map<Staff, StaffContext>();
  for (const st of pg.staves) {
    const cl = sortByLeft(validClefs.filter((c) => overlapY(c.box, st.box)).slice());
    const key = sortByLeft(pg.symbols.filter((s) => s.hasTag("Key") && overlapY(s.box, st.box)).slice());
    const tm = sortByLeft(pg.symbols.filter((s) => s.hasTag("Time") && s.ownerStaff === st).slice());
    ctx.set(st, { staff: st, clef: cl[0] ?? null, key, time: tm });
  }
  return ctx;
}

/** `Page::analyzeAccidental`。 */
function analyzeAccidental(pg: SPage, accids: Sym[], clefs: Sym[]): void {
  const notes = pg.symbols.filter((s) => s.hasTag("Note"));
  const sp = pg.normalStaffSpace || pg.space;
  for (const acc of accids) {
    for (const nt of notes) {
      if (!nt.ownerStaff) continue;
      if (Math.abs(nt.py - acc.py) > sp / 4) continue;
      if (nt.px < acc.px) continue;
      if (nt.box.left - acc.box.right < sp / 2) {
        acc.addTag("Accidental");
        break;
      }
    }
  }

  const poss = accids.filter((a) => !a.hasAnyTag()).sort((a, b) => a.px - b.px);
  const barlines: Box[] = [
    ...pg.segsWithTag("BarLine").map((s) => s.box),
    ...pg.symbols.filter((s) => s.hasTag("BarLine")).map((s) => s.box),
  ];
  const keyAccids: Sym[] = [];
  for (const acc of poss) {
    // 紧跟谱号
    let after = false;
    for (const c of clefs) {
      if (c.box.right > acc.box.left) continue;
      if (acc.box.left - c.box.right > sp * 3) continue;
      if (!overlapY(c.box, acc.box)) continue;
      after = true;
      break;
    }
    // 紧跟另一个调号升降号
    if (!after) {
      for (const k of keyAccids) {
        if (!overlapY(k.box, acc.box)) continue;
        const dx = acc.box.left - k.box.right;
        if (dx < 0 || dx > acc.box.right - acc.box.left) continue;
        after = true;
        break;
      }
    }
    // 紧跟小节线（曲中转调）
    if (!after) {
      for (const b of barlines) {
        if (!overlapY(b, acc.box)) continue;
        if (acc.box.left < b.left) continue;
        if (acc.box.left - b.right > sp * 2) continue;
        after = true;
        break;
      }
    }
    if (after) {
      keyAccids.push(acc);
      acc.addTag("Key");
    }
  }
}

/** `KeySig::fifth`：调号升降号数（升为正、降为负）。本位号不计。 */
export function keyFifths(key: Sym[]): number {
  let res = 0;
  for (const s of key) {
    if (s.code === "accidentalSharp") res++;
    else if (s.code === "accidentalFlat") res--;
  }
  return res;
}

/**
 * 一行谱上**最左**那处拍号。上下两排数字各拼一个数（分子在上、分母在下）。
 *
 * 一行里可能不止一处（曲中变拍），逐小节判用 `timeSignatures`；
 * 把所有数字一股脑拼起来会得出 `2424/4444` 这种东西（实测全书出过 32 处）。
 */
export function timeSignature(time: Sym[], sp?: number): { beats: number; beatType: number } | null {
  const all = timeSignatures(time, sp);
  return all.length ? { beats: all[0].beats, beatType: all[0].beatType } : null;
}

/** 一行谱上的**全部**拍号，按 x 从左到右。曲中变拍时会有好几处。 */
export function timeSignatures(time: Sym[], sp?: number): { x: number; beats: number; beatType: number }[] {
  if (!time.length) return [];
  const out: { x: number; beats: number; beatType: number }[] = [];
  const marks = time.filter((s) => s.code === "timeSigCommon" || s.code === "timeSigCutCommon");
  for (const m of marks) {
    out.push(m.code === "timeSigCommon" ? { x: m.px, beats: 4, beatType: 4 } : { x: m.px, beats: 2, beatType: 2 });
  }
  const digits = time.filter((s) => timeSigDigit(s.code) >= 0).sort((a, b) => a.px - b.px);
  if (digits.length) {
    const gap = (sp ?? (digits[0].box.right - digits[0].box.left) * 2) * 3;
    // 按 x 分簇：同一处拍号的上下两个数字 x 几乎相同，簇间隔取三个数字宽
    const clusters: Sym[][] = [[digits[0]]];
    for (let i = 1; i < digits.length; i++) {
      const cur = clusters[clusters.length - 1];
      if (digits[i].px - cur[cur.length - 1].px > gap) clusters.push([digits[i]]);
      else cur.push(digits[i]);
    }
    for (const cluster of clusters) {
      const midY = (Math.min(...cluster.map((d) => d.py)) + Math.max(...cluster.map((d) => d.py))) / 2;
      const top = cluster.filter((d) => d.py <= midY).sort((a, b) => a.px - b.px);
      const bot = cluster.filter((d) => d.py > midY).sort((a, b) => a.px - b.px);
      const num = (a: Sym[]) => Number(a.map((s) => timeSigDigit(s.code)).join("")) || 0;
      const beats = num(top);
      const beatType = num(bot);
      if (beats && beatType) out.push({ x: cluster[0].px, beats, beatType });
    }
  }
  return out.sort((a, b) => a.x - b.x);
}

// ── 符杠 ────────────────────────────────────────────────────────────────────

/** 一条符杠：粗的、（多半）倾斜的实心四边形。 */
export interface BeamShape {
  box: Box;
  /** 左右端点的中心 y，用来判「某个 x 处符杠在哪个高度」。 */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 第几层（1 = 离符头最近的那条 = 八分）。由 `calcBeamLevels` 填。 */
  level: number;
}

/** `Beam::calcY`：符杠在某个 x 处的中心 y。 */
export const beamY = (b: BeamShape, x: number): number =>
  b.x1 === b.x0 ? b.y0 : b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0);

/** 一根符干及其挂件。musicpp 的 `omr::Stem`。 */
export interface StemInfo {
  seg: Seg;
  /** 符干朝上（从符头往上伸）。 */
  up: boolean;
  notes: Sym[];
  beams: BeamShape[];
  /** 符尾字形给出的层数（八分 1、十六分 2……）；没有符尾为 0。 */
  flags: number;
}

/**
 * 找符杠。两种画法都要认：
 *   1. **实心四边形**（Finale/Sibelius 原生）：四到五个点、无曲线、够粗。
 *   2. **密排细线**（本书那批经 Distiller 的 PDF）：一条 `lw` 明显大于谱线的横段
 *      ——那是几十道 0.06pt 细线堆出来的填充，`mergeRedrawn` 已经并成一条粗段。
 */
export function findBeams(pg: SPage): BeamShape[] {
  // 谱线找到之后 `normalStaffSpace`（实测的一个线距）是更准的那个；没找到就退回 H/4。
  const sp = pg.normalStaffSpace || pg.space;
  const out: BeamShape[] = [];
  for (const o of pg.objs) {
    const p = o.path;
    if (!p || !p.paint.toLowerCase().includes("fill")) continue;
    if (p.curves) continue;
    for (const spath of subPaths(p)) {
      const pts = spath.pts;
      if (pts.length < 4 || pts.length > 5) continue;
      const xs = pts.map((q) => q.x);
      const ys = pts.map((q) => q.y);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      if (w < sp * 0.8) continue; // 太短的不是符杠
      if (h > sp * 2) continue; // 太高的不是符杠（是方框/装饰）
      // 粗细：取左右两端的纵向厚度
      const left = pts.filter((q) => q.x < Math.min(...xs) + w * 0.25).map((q) => q.y);
      const thick = left.length >= 2 ? Math.max(...left) - Math.min(...left) : h;
      if (thick < sp * 0.25) continue;
      out.push(beamFromPts(pts));
    }
  }
  // **斜符杠是一叠平行细线**（这一批 PDF 连填充也拿密排细线画，见 `model.ts` 的 `Seg` 注释）。
  // 平的那种叠出来还能并成一条横段（下面那条路收得到）；斜的每条 y 都不同，
  // `Seg` 的 `isH`/`isV` 两头不沾，整条符杠没人认——实测 p185~p204 那一带
  // 「八分音符读成四分」，一首歌能错六成的时值。
  out.push(...slantedBeams(pg, sp));

  // 密排细线画出来的符杠
  for (const s of pg.segs) {
    if (!s.isH || s.hasAnyTag()) continue;
    if (s.lw < sp * 0.3 || s.lw > sp * 1.2) continue;
    if (s.len < sp * 0.8 || s.len > sp * 20) continue;
    out.push({ box: s.box, x0: s.left, y0: s.cy, x1: s.right, y1: s.cy, level: 0 });
  }
  return dedupeBeams(out, sp / 2);
}

/** 同一条符杠会被两条路各认一遍（实心四边形那条 + 细矩形转成的横段那条），
 *  不去重的话时值每多算一条就减半——实测 p100 因此出了一堆 1/64。
 *  合并粒度按页面单位取比例（四分之一格），不写绝对点值。 */
function dedupeBeams(list: BeamShape[], unit: number): BeamShape[] {
  const seen = new Set<string>();
  const out: BeamShape[] = [];
  const q = Math.max(unit / 4, 1e-3);
  for (const b of list) {
    const k = [b.x0, b.x1, b.y0, b.y1].map((v) => Math.round(v / q)).join(",");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

/**
 * 一叠平行斜细线 → 一条符杠。
 *
 * 判据是「同起讫 x、同斜率、y 一层层错开」——这正是填充算法吐出来的样子。
 * 只收**斜的**：平的那种由横段那条路收，两头都收会把同一条符杠算两遍，
 * 层数跟着翻倍（时值减半）。
 */
function slantedBeams(pg: SPage, sp: number): BeamShape[] {
  const out: BeamShape[] = [];
  for (const o of pg.objs) {
    const p = o.path;
    if (!p || p.curves) continue;
    const groups = new Map<string, { a: { x: number; y: number }; b: { x: number; y: number } }[]>();
    for (const spath of subPaths(p)) {
      if (spath.pts.length !== 2) continue;
      let [a, b] = spath.pts;
      if (a.x > b.x) [a, b] = [b, a];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      // 太短的不是符杠；水平的走横段那条路；比 45° 还陡的不是符杠
      if (dx < sp * 0.8) continue;
      if (Math.abs(dy) < 0.02) continue;
      if (Math.abs(dy) >= dx) continue;
      const q = Math.max(sp / 8, 1e-3);
      const k = [a.x, b.x, dy / dx].map((v) => Math.round(v / q)).join(",");
      const g = groups.get(k) ?? [];
      g.push({ a, b });
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      g.sort((m, n) => m.a.y - n.a.y);
      let run: typeof g = [];
      const flush = () => {
        // 一条细线不成束（那是渐强线之类）；厚度要落在符杠的范围里
        if (run.length >= 3) {
          const th = run[run.length - 1].a.y - run[0].a.y;
          if (th >= sp * 0.2 && th <= sp * 1.2) {
            const x0 = run[0].a.x;
            const x1 = run[0].b.x;
            const y0 = (run[0].a.y + run[run.length - 1].a.y) / 2;
            const y1 = (run[0].b.y + run[run.length - 1].b.y) / 2;
            out.push({
              box: {
                left: x0,
                right: x1,
                top: Math.min(run[0].a.y, run[0].b.y),
                bottom: Math.max(run[run.length - 1].a.y, run[run.length - 1].b.y),
              },
              x0, y0, x1, y1, level: 0,
            });
          }
        }
        run = [];
      };
      for (const l of g) {
        // 一层层错开的才是同一条符杠；隔开半格的是另一条（第二、第三条符杠）
        if (run.length && l.a.y - run[run.length - 1].a.y > sp * 0.3) flush();
        run.push(l);
      }
      flush();
    }
  }
  return out;
}

function beamFromPts(pts: { x: number; y: number }[]): BeamShape {
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const at = (x: number) => {
    const near = pts.filter((q) => Math.abs(q.x - x) < (maxX - minX) * 0.25).map((q) => q.y);
    return near.length ? (Math.min(...near) + Math.max(...near)) / 2 : (Math.min(...ys) + Math.max(...ys)) / 2;
  };
  return {
    box: { left: minX, right: maxX, top: Math.min(...ys), bottom: Math.max(...ys) },
    x0: minX,
    y0: at(minX),
    x1: maxX,
    y1: at(maxX),
    level: 0,
  };
}

/** 识别的可调开关（脚本里对比两种做法用；默认全开）。 */
export const staffOmrOptions = {
  /** 时值取符杠**层级**（`BeamGroup::calcLevel`）；关掉则退回「数穿过符干的符杠条数」。
   *  两种做法的差别见 `buildNotes` 里那段注释。 */
  beamLevels: true,
  /** 应用八度移位（`8va`/`8vb`）。脚本里对比用。 */
  octaveShift: true,
};

// ── 符干与符杠分层 ──────────────────────────────────────────────────────────

/**
 * `System::analyzeStem`：把符头挂到符干上，再把符尾挂到符干上。
 *
 * 判据照原文：符头的**左缘或右缘**与符干 x 差在四分之一格以内，且纵向相交。
 * （符干贴在符头的一侧，不是穿过中心。）
 */
export function buildStems(pg: SPage, sp: number): StemInfo[] {
  const heads = pg.symbols.filter((s) => s.hasTag("Note") && !isRest(s.code) && s.ownerStaff);
  const flagSyms = pg.symbols.filter((s) => s.hasTag("Tail"));
  const out: StemInfo[] = [];
  for (const seg of pg.segsWithTag("Stem")) {
    const notes: Sym[] = [];
    for (const nt of heads) {
      if (!overlapY(seg.box, nt.box)) continue;
      const dx0 = Math.abs(nt.box.left - seg.cx);
      const dx1 = Math.abs(nt.box.right - seg.cx);
      if (dx0 > sp / 4 && dx1 > sp / 4) continue;
      notes.push(nt);
    }
    if (!notes.length) continue;
    // `Stem::up`：符干伸到符头**上方**就是朝上
    const top = Math.min(...notes.map((n) => n.box.top));
    const bottom = Math.max(...notes.map((n) => n.box.bottom));
    const up = seg.top < top ? true : seg.bottom > bottom ? false : false;
    let flags = 0;
    for (const f of flagSyms) {
      if (Math.abs(f.box.left - seg.cx) > sp / 4) continue;
      if (!overlapY(f.box, seg.box)) continue;
      flags = Math.max(flags, flagLevel(f.code));
    }
    out.push({ seg, up, notes, beams: [], flags });
  }
  return out;
}

/** `Beam::connect` 的结果。 */
type BeamHit = "none" | "begin" | "end" | "middle";

/** `Beam::connect`：这条符杠接不接得上这根符干。 */
function beamConnect(b: BeamShape, st: StemInfo, sp: number): BeamHit {
  const x = st.seg.cx;
  if (x < b.x0 - sp * 0.2) return "none";
  if (x > b.x1 + sp * 0.2) return "none";
  const y = beamY(b, x);
  // 符干的**某一端**要落在符杠附近（符杠总在符干的远端）。
  //
  // 光有这一条不够：**第二、三条符杠是往符头方向叠上去的**（每条约四分之三格），
  // 离符干末端一格开外，整条接不上符干 → 层数只剩一层 → 十六分读成八分
  // （实测这是全书时值的头号错误，一条判据吃掉 158 处）。
  // 所以再补一个窗口：从符干**离符头远的那一端**朝符头量，两格以内都算接上
  // （三条符杠正好一格半）。反方向不放宽——那一侧不该有符杠。
  const near = Math.abs(st.seg.top - y) < sp || Math.abs(st.seg.bottom - y) < sp;
  if (!near) {
    const noteY = st.notes.reduce((a, n) => a + (n.box.top + n.box.bottom) / 2, 0) / st.notes.length;
    const far = Math.abs(st.seg.top - noteY) > Math.abs(st.seg.bottom - noteY) ? st.seg.top : st.seg.bottom;
    const toward = Math.sign(noteY - far) || 1;
    const d = (y - far) * toward;
    if (d < 0 || d > sp * 2) return "none";
  }
  if (Math.abs(x - b.x0) < sp / 5) return "begin";
  if (Math.abs(x - b.x1) < sp / 5) return "end";
  return "middle";
}

/**
 * `System::analyzeBeam` + `BeamGroup::calcLevel`：把符杠归组并定层。
 *
 * 为什么不能「数穿过符干的符杠条数」了事：十六分音符的第二条符杠常常只是**半截钩**
 * （fractional beam），它盖住的符干比第一条少；反过来，同一组里不同符干盖到的条数不同，
 * 而**时值要看这根符干上最高的那一层**。musicpp 的办法是先按「共享符干且 x 区间重叠」
 * 归组，组内按「在组左端 x 处的 y」排序，逐条隔开四分之一格就升一层。
 */
export function calcBeamLevels(beams: BeamShape[], stems: StemInfo[], sp: number): void {
  const conn = new Map<BeamShape, { st: StemInfo; hit: BeamHit }[]>();
  const kept: BeamShape[] = [];
  for (const b of beams) {
    const hits: { st: StemInfo; hit: BeamHit }[] = [];
    for (const st of stems) {
      if (st.flags) continue; // 有符尾的符干不接符杠（照原文）
      const h = beamConnect(b, st, sp);
      if (h === "none") continue;
      hits.push({ st, hit: h });
      st.beams.push(b);
    }
    // 一根符干都接不上的多半不是符杠（是渐强线、下划线之类）。
    // musicpp 要求**两端**至少有一端正好落在符干上；本仓放宽成「接得上任何一根」——
    // 这一批 PDF 的符杠是密排细线堆出来的填充（见 findBeams），合并后的横段两端
    // 比真符杠宽出一截，`begin`/`end` 的五分之一格容差卡不住，整条符杠会被丢掉，
    // 于是那些页「八分音符读成四分」。
    if (!hits.length) continue;
    conn.set(b, hits);
    kept.push(b);
  }

  // 归组：x 区间重叠 + 共享符干（长的先当组头，照原文按跨度降序）
  kept.sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0));
  const done = new Set<BeamShape>();
  for (const bi of kept) {
    if (done.has(bi)) continue;
    const grp = [bi];
    done.add(bi);
    for (const bj of kept) {
      if (done.has(bj)) continue;
      if (bi.x0 > bj.x1 || bj.x0 > bi.x1) continue;
      const si = new Set(conn.get(bi)!.map((h) => h.st));
      if (!conn.get(bj)!.some((h) => si.has(h.st))) continue;
      grp.push(bj);
      done.add(bj);
    }
    // 定层：以组头的左端 x 为基准，按「离符头那一端有多远」从近到远排。
    // musicpp 是按符干朝向决定升序还是降序；本仓改用**到符头端的距离**——
    // 符干与符头常常有重叠，`Stem::up` 那条判据（符干是否伸到符头之上）会误判，
    // 一误判整组的层就反过来，十六分与八分互换。距离这个量与朝向无关。
    const x = grp[0].x0;
    // 组头的**最左**那根符干当基准（不苛求它正好是 `begin`，理由同上）
    const anchor = conn.get(grp[0])!.reduce((a, h) => (h.st.seg.cx < a.st.seg.cx ? h : a)).st;
    // 符头端 = 符干两端里离符头中心近的那一端（不问朝向，`Stem::up` 会误判）
    const noteY = anchor.notes.reduce((a, n) => a + (n.box.top + n.box.bottom) / 2, 0) / anchor.notes.length;
    const anchorY = Math.abs(anchor.seg.top - noteY) < Math.abs(anchor.seg.bottom - noteY) ? anchor.seg.top : anchor.seg.bottom;
    grp.sort((a, b) => Math.abs(beamY(a, x) - anchorY) - Math.abs(beamY(b, x) - anchorY));
    let last = beamY(grp[0], x);
    let level = 1;
    grp[0].level = 1;
    for (let i = 1; i < grp.length; i++) {
      const y = beamY(grp[i], x);
      if (Math.abs(y - last) >= sp / 4) level++;
      last = y;
      grp[i].level = level;
    }
  }
}

// ── 音符 ────────────────────────────────────────────────────────────────────

/** 一个认出来的音符（或休止）。 */
export interface StaffNote {
  sym: Sym;
  staff: Staff;
  /** 休止。 */
  rest: boolean;
  /** 全音阶序号（休止为 -1）。 */
  diatonic: number;
  step: string;
  octave: number;
  /**
   * **发声的**升降（半音数）：调号 + 小节内延续 + 临时记号一起算出来的。
   * MusicXML 的 `<alter>` 要的是这个。由 `calcAlters` 填。
   */
  alter: number;
  /** 谱面上**印出来的**临时记号（半音数）；没印为 null。MusicXML 的 `<accidental>` 要的是这个。 */
  accidental: number | null;
  /** 时值（全音符 = 1），已含附点。 */
  duration: number;
  /** 不含附点的基本时值。 */
  base: number;
  dots: number;
  /** 符干朝上。没有符干为 null。 */
  stemUp: boolean | null;
  /** 符尾/符杠条数。 */
  beams: number;
  x: number;
  /** 挂在这个音符上的歌词，按段（verse）。 */
  lyrics?: { verse: number; text: string; hyphen: boolean }[];
  /** 挂在这个音符上的和弦符号（归一后的原文，如 `Am`、`G/B`、`Dm7`）。 */
  chord?: string;
  /**
   * 这是**和弦里的附加音**（同一根符干上、与另一个音同 x，且不是最高的那个）。
   *
   * 领唱谱的引子常常是柱状和弦（实测 p205 头一行），主旋律只取最高音；
   * MusicXML 那边这些音要带 `<chord/>`，不然会被当成先后两个音、时值全乱。
   */
  chordExtra?: boolean;
  /** 挂在这个音符上的演奏法记号（SMuFL 名，见 `notations.ts`）。 */
  marks?: string[];
  /**
   * 声部号（1 起）。一行谱上写两个声部时（SATB 把女高女低挤在一行），
   * **按符干方向分**：朝上的是第一声部、朝下的是第二声部。见 `assignVoices`。
   */
  voice: number;
  /** 落在八度移位段里（音高已经移过了，这里只记一笔给 `<octave-shift>` 用）。 */
  octaveShift?: "up" | "down";
  /** 力度记号（`mp`/`f`…）。MusicXML 里出成 `<direction>`，排在这个音符之前。 */
  dynamic?: string;
  /** 连音（三连音之类）：`actual` 个音占 `normal` 个音的时值。 */
  tuplet?: { actual: number; normal: number };
  /**
   * **斜杠符头**（`noteheadSlash*`）：不是有音高的音符，而是「照这个节奏弹和弦」的记号。
   *
   * 这本书的前奏、间奏常常整行写斜杠 + 和弦名（实测 088/094/102 三首各有 16~19 个），
   * 它们全落在谱表第三线上，按符头算就成了一串 B4 四分音符——**全书「多出来的音符」
   * 里最大的一类就是它**。有音高的那些字段（`step`/`octave`/`diatonic`）对它没有意义，
   * MusicXML 那边出成 `<notehead>slash</notehead>`。
   */
  slash?: boolean;
  /** 圆滑线/连音线的起讫（见 `slur.ts`）。一个音符可以同时是上一条的收尾与下一条的起头。 */
  slurStart?: boolean;
  slurStop?: boolean;
  tieStart?: boolean;
  tieStop?: boolean;
}

/**
 * 把已归属谱表的符头/休止算成音符。
 *
 * 时值来源，按 musicpp 的口径：符头形状定基本时值（全/二分/四分），
 * 再由**符尾条数**或**穿过符干的符杠条数**逐条减半，最后乘附点。
 */
export function buildNotes(
  pg: SPage,
  ctx: Map<Staff, StaffContext>,
  beams: BeamShape[],
  /** 出参：这一页的符干（三连音那一步要用）。 */
  stemsOut?: StemInfo[],
): StaffNote[] {
  const sp = pg.normalStaffSpace || pg.space;
  const stems = buildStems(pg, sp);
  stemsOut?.push(...stems);
  calcBeamLevels(beams, stems, sp);
  // 符头 → 它那根符干
  const stemOf = new Map<Sym, StemInfo>();
  for (const st of stems) for (const n of st.notes) if (!stemOf.has(n)) stemOf.set(n, st);

  const dots = pg.symbols.filter((s) => s.code === "augmentationDot" && !s.hasAnyTag());
  const out: StaffNote[] = [];

  for (const s of pg.symbols) {
    if (!s.hasTag("Note") || !s.ownerStaff) continue;
    const stf = s.ownerStaff;
    const rest = isRest(s.code);
    const c = ctx.get(stf);
    const mid = c?.clef ? clefMiddleStep(c.clef.code) ?? 41 : 41;

    let diatonic = -1;
    let step = "";
    let octave = 0;
    if (!rest) {
      diatonic = mid + stf.middleStep(s.py);
      const p = stepToPitch(diatonic);
      step = p.step;
      octave = p.octave;
    }

    const stem = rest ? undefined : stemOf.get(s);
    const stemUp = stem ? stem.up : s.compositeStemUp ?? null;
    // **层数取符尾条数，或这根符干上最高的那一层符杠**——不是「数穿过符干几条」：
    // 十六分的第二条常常只是半截钩，盖住的符干比第一条少（见 calcBeamLevels 的注释）。
    // **层数 = 这根符干上「有几个不同的层」**，不是「最高的那一层」。
    //
    // musicpp 取最高层。实测那样更差（全书时值 71.7% → 70.3%）：`calcLevel` 把整组符杠
    // 外推到组左端的 x 处比高低，靠右那条短符杠一外推，斜率误差被放大，层就判高了；
    // 于是只压着一条符杠的符干拿到了「第 2 层」，八分读成十六分。
    // 数「不同的层」两头都占：同一条符杠被拆成两段时（同层）只算一次，
    // 而外推判错层也只影响那一层的编号、不影响个数。
    const nb = stem
      ? stem.flags ||
        (staffOmrOptions.beamLevels
          ? new Set(stem.beams.map((b, i) => (b.level > 0 ? `L${b.level}` : `u${i}`))).size
          : stem.beams.length)
      : 0;

    let base: number;
    if (s.compositeBase !== undefined) {
      // 复合音符字形（`page.ts::adoptCompositeNotes`）：没有单独的符干可数，
      // 时值由字形本身给出，符干一律朝上。
      base = s.compositeBase;
    } else if (rest) {
      base = restDuration(s.code);
      if (base < 0) base = 1; // restHBar：整小节休止，先按全音符，`toxml` 再按拍号改
      // **全休止与半休止在字体里是同一个方块**，只有落在第几线上不同：
      // 半休止**坐在中线上**（墨迹底贴中线），全休止**吊在上面一线下**（底比中线高一格）。
      // 字形字典分不开它们（轮廓逐位相同，一律标成了 `restHalf`），只能按几何判——
      // 不判的话整小节的全休止全读成半休止，小节时值自检与 GT 的时值档都跟着错。
      if (s.code === "restHalf" || s.code === "restWhole") {
        const space = (stf.stepDistance() || 0) * 2 || sp;
        const mid = (stf.box.top + stf.box.bottom) / 2;
        base = mid - s.box.bottom > space * 0.5 ? 1 : 1 / 2;
      }
    } else if (s.code === "noteheadWhole" || s.code === "noteheadDoubleWhole") {
      base = s.code === "noteheadDoubleWhole" ? 2 : 1;
    } else if (s.code === "noteheadHalf") {
      base = stem ? 1 / 2 : 1;
    } else {
      base = 1 / 4;
      for (let i = 0; i < nb; i++) base /= 2;
    }

    // 谱面上印出来的临时记号：贴在符头左边、同高度
    let accidental: number | null = null;
    for (const a of pg.symbols) {
      if (!a.hasTag("Accidental")) continue;
      if (!overlapY(a.box, s.box)) continue;
      if (a.px > s.box.left) continue;
      if (xSpace(a.box, s.box) > sp) continue;
      accidental = accidentalAlter(a.code);
      break;
    }

    out.push({ sym: s, staff: stf, rest, diatonic, step, octave, alter: 0, accidental, duration: base, base, dots: 0, stemUp, beams: nb, x: s.px, voice: 1, slash: s.code.startsWith("noteheadSlash") || undefined });
  }
  // **先按谱行、再按 x**。只按 x 排会把一页里几行谱的音符横向交织在一起
  // ——顺序一乱，与 GT 的逐音比对就全废（实测准确率卡在两成半）。
  out.sort((a, b) => a.staff.box.top - b.staff.box.top || a.x - b.x);
  attachDots(out, dots, sp);
  markChords(out, sp);
  assignVoices(pg, ctx, out);
  calcAlters(pg, ctx, out);
  return out;
}

/**
 * 附点分配：**逐个附点找主人**，而不是逐个音符找点。
 *
 * 反过来做会出两种错：同一枚点被左右两个音符各认一次（时值凭空多出来）；
 * 而线上音符的附点按惯例写在**上方那个间**里（差半格），纵向容差不够就整个漏掉
 * ——实测小节时值自检里最大的一档偏差正是 0.88（缺八分之一），那就是漏附点的特征。
 */
function attachDots(notes: StaffNote[], dots: Sym[], sp: number): void {
  for (const d of dots) {
    let best: StaffNote | undefined;
    let bd = Infinity;
    for (const n of notes) {
      if (d.px <= n.sym.box.right) continue;
      const dx = d.px - n.sym.box.right;
      if (dx > sp * 1.5) continue;
      // 线上音符的附点写在上方那个间里，差半格；再放一点余量
      if (Math.abs(d.py - n.sym.py) > sp * 0.75) continue;
      if (dx < bd) {
        bd = dx;
        best = n;
      }
    }
    if (!best) continue;
    best.dots++;
    d.addTag("Augmentation");
  }
  // 附点定了才能算时值
  for (const n of notes) {
    let dur = n.base;
    let add = n.base;
    for (let i = 0; i < n.dots; i++) {
      add /= 2;
      dur += add;
    }
    n.duration = dur;
  }
}

/**
 * `Bar::splitVoice` 的**通行判据版**：一行谱上写两个声部时按**符干方向**分。
 *
 * musicpp 那一版是拿时值凑（把小节里的和弦按时值分组、逐组试到凑满拍号为止），
 * 依赖 `guessDur`/`ChordGroup` 一整套；本书用不到那么重的做法——
 * SATB 把女高女低挤在一行时，刻谱的通行约定就是**上声部符干朝上、下声部朝下**。
 *
 * **只在单声部凑不满时才拆**（照 musicpp 的用法：`checkFull` 失败才 `splitVoice`），
 * 而且拆完要验一遍——拆出来的两个声部至少有一个要正好凑满拍号，否则退回单声部。
 * 无条件按符干方向拆是不行的：普通旋律一小节里本来就上下都有符干，
 * 实测那样全书小节自检从 80.1% 掉到 73.4%。
 */
function assignVoices(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[]): void {
  let cur = { beats: 4, beatType: 4 };
  for (const stf of pg.staves) {
    const changes = timeSignatures(ctx.get(stf)?.time ?? [], pg.normalStaffSpace || pg.space);
    let ci = 0;
    stf.bars.forEach((bar) => {
      while (ci < changes.length && changes[ci].x < bar.right) {
        cur = { beats: changes[ci].beats, beatType: changes[ci].beatType };
        ci++;
      }
      const expect = cur.beats / cur.beatType;
      const arr = notes.filter((n) => n.staff === stf && !n.chordExtra && n.x >= bar.left && n.x < bar.right);
      if (arr.length < 4) return;
      const sum = arr.reduce((a, n) => a + (n.sym.code === "restHBar" ? expect : n.duration), 0);
      if (sum <= expect + 1e-6) return; // 单声部凑得下，不拆
      const up = arr.filter((n) => n.stemUp === true);
      const down = arr.filter((n) => n.stemUp === false);
      if (up.length < 2 || down.length < 2) return;
      const sumOf = (a: StaffNote[]) => a.reduce((x, n) => x + (n.sym.code === "restHBar" ? expect : n.duration), 0);
      // **两个声部都要正好凑满**才认这次拆分。
      // 只要求一个凑满的话，另一个多半是被硬切出来的，与 GT 逐音比对反而变差
      // （实测音符准确率 93.42% → 93.21%）。
      if (Math.abs(sumOf(up) - expect) >= 1e-6 || Math.abs(sumOf(down) - expect) >= 1e-6) return;
      for (const n of down) n.voice = 2;
    });
  }
}

/** 五度圈上升降号出现的次序（全音阶序号，C=0 D=1 E=2 F=3 G=4 A=5 B=6）：
 *  升号 F♯ C♯ G♯ D♯ A♯ E♯ B♯、降号 B♭ E♭ A♭ D♭ G♭ C♭。照 musicpp 的 `circle[]`。 */
const CIRCLE = [3, 0, 4, 1, 5, 2, 6];

/**
 * `Bar::calcAlter`：算出每个音**发声**的升降。
 *
 * 三层叠加，缺一不可：
 *   1. **调号**——升降号作用于所有八度的那个音名，整首有效；
 *   2. **小节内延续**——印在某个音左边的临时记号，对**同一小节、同一八度**的后续同名音继续有效；
 *   3. 本位号把前两层都抹掉（记 0）。
 *
 * 不算这一层的话，凡是带升降号的调，导出的 `<pitch>` 就是错的
 * （`<alter>` 缺了调号那一份）。
 */
export function calcAlters(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[]): void {
  // 谱行的调号：本行没印的沿用上一行（`analyzeBarData` 的 prev 逻辑）
  let fifths = 0;
  const fifthsOf = new Map<Staff, number>();
  for (const st of pg.staves) {
    const c = ctx.get(st);
    if (c && c.key.length) fifths = keyFifths(c.key);
    fifthsOf.set(st, fifths);
  }
  // 按 (谱行, 小节) 分组，组内按 x
  const byBar = new Map<string, StaffNote[]>();
  for (const n of notes) {
    if (n.rest) continue;
    const st = n.staff;
    const bi = st.bars.findIndex((b) => n.x >= b.left && n.x < b.right);
    const key = `${st.index}#${bi}`;
    const a = byBar.get(key) ?? [];
    a.push(n);
    byBar.set(key, a);
  }
  for (const [key, arr] of byBar) {
    const st = arr[0].staff;
    const kf = fifthsOf.get(st) ?? 0;
    const stat = new Map<number, number>();
    // 调号：作用于所有八度
    for (let i = 0; i < kf; i++) for (let oct = 0; oct < 12; oct++) stat.set(oct * 7 + CIRCLE[i], 1);
    for (let i = kf; i < 0; i++) for (let oct = 0; oct < 12; oct++) stat.set(oct * 7 + CIRCLE[7 + i], -1);
    arr.sort((a, b) => a.x - b.x);
    for (const n of arr) {
      if (n.accidental !== null) stat.set(n.diatonic, n.accidental);
      n.alter = stat.get(n.diatonic) ?? 0;
    }
    void key;
  }
}


/**
 * 同一行谱上 x 相同的一撮音是**一个和弦**：留最高的那个当主音，其余标 `chordExtra`。
 *
 * 判据是 x 差不到半个符头宽——真正先后相邻的两个音至少隔一个符头。
 */
function markChords(notes: StaffNote[], sp: number): void {
  const tol = sp * 0.5;
  let i = 0;
  while (i < notes.length) {
    let j = i + 1;
    while (j < notes.length && notes[j].staff === notes[i].staff && notes[j].x - notes[i].x < tol) j++;
    if (j - i > 1) {
      const grp = notes.slice(i, j);
      // 休止不参与（休止与音符同 x 是排版上的两个声部，不是和弦）
      const pitched = grp.filter((n) => !n.rest);
      if (pitched.length > 1) {
        const top = pitched.reduce((a, b) => (b.diatonic > a.diatonic ? b : a));
        for (const n of pitched) if (n !== top) n.chordExtra = true;
      }
    }
    i = j;
  }
}

// ── 小节自检 ────────────────────────────────────────────────────────────────

/** 一个小节的时值核对结果。 */
export interface BarCheck {
  staff: Staff;
  /** 小节在本行谱里的序号。 */
  index: number;
  /** 小节里音符时值之和（全音符为 1）。和弦附音不重复计。 */
  sum: number;
  /** 拍号要求的时值。 */
  expect: number;
  /** 音符数（含休止）。 */
  count: number;
  full: boolean;
}

/**
 * `Bar::checkFull` 的**单声部子集**：小节里的时值加起来对不对得上拍号。
 *
 * musicpp 那一版顺带做多声部拆分（`splitVoice`）与「忽略小字号的倚音」两档；
 * 本书是单声部领唱谱，用不上那两档，故只留核对。
 *
 * 这是**不靠 GT 的自检**：对不上就说明这一小节里有音符读错了（时值、漏音、多音）。
 * 全书都能用，不限于对上 GT 的那 98 首。
 *
 * 三处天然对不上、不算错：整小节休止（`restHBar` 按拍号算满）、
 * **弱起**（第一小节不足拍）、跨行断开的小节。
 */
export function checkBars(
  pg: SPage,
  ctx: Map<Staff, StaffContext>,
  notes: StaffNote[],
  /** 上一页最后的拍号（跨页继承；续页上不再印拍号）。 */
  carry?: { beats: number; beatType: number },
): BarCheck[] {
  const out: BarCheck[] = [];
  let cur = { beats: carry?.beats ?? 4, beatType: carry?.beatType ?? 4 };
  for (const stf of pg.staves) {
    // **逐小节**取当时生效的拍号：一行谱上可能变拍好几次
    // （实测 Opus 那本 p663 的第三行里 4/4 → 2/4 → 4/4，按整行取最左那处会全错）
    const changes = timeSignatures(ctx.get(stf)?.time ?? [], pg.normalStaffSpace || pg.space);
    let ci = 0;
    stf.bars.forEach((bar, i) => {
      while (ci < changes.length && changes[ci].x < bar.right) {
        cur = { beats: changes[ci].beats, beatType: changes[ci].beatType };
        ci++;
      }
      const expect = cur.beats / cur.beatType;
      const inBar = notes.filter((n) => n.staff === stf && !n.chordExtra && n.x >= bar.left && n.x < bar.right);
      if (!inBar.length) return;
      // **逐声部核对**：一行谱上写两个声部时，每个声部各自要凑满拍号
      const voices = [...new Set(inBar.map((n) => n.voice))].sort();
      let sum = 0;
      let full = true;
      for (const v of voices) {
        let vs = 0;
        for (const n of inBar) if (n.voice === v) vs += n.sym.code === "restHBar" ? expect : n.duration;
        if (v === voices[0]) sum = vs;
        if (Math.abs(vs - expect) >= 1e-6) full = false;
      }
      out.push({ staff: stf, index: i, sum, expect, count: inBar.length, full });
    });
  }
  return out;
}

/** 这一页最后生效的拍号（给下一页当 `carry`）。 */
export function lastTimeSignature(
  pg: SPage,
  ctx: Map<Staff, StaffContext>,
  carry?: { beats: number; beatType: number },
): { beats: number; beatType: number } | undefined {
  let out = carry;
  for (const stf of pg.staves) {
    const all = timeSignatures(ctx.get(stf)?.time ?? [], pg.normalStaffSpace || pg.space);
    if (all.length) out = { beats: all[all.length - 1].beats, beatType: all[all.length - 1].beatType };
  }
  return out;
}
