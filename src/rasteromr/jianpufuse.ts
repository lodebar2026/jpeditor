// 简线混排谱：拿**简谱行**给五线谱纠错（互证）。
//
// 混排谱上同一段旋律印了两遍：五线谱给音高的绝对位置，简谱给级数、高低点和时值。
// 两条路错的地方不一样——位图五线谱在高分辨率页上会把八分音符的符头定到符干
// 另一头（《是谁》G4 读成 E5、B4 读成 B3），附点二分音符的附点也常漏；
// 简谱数字大而清楚，简谱那条路又调熟了，认错的多半是个别数字（`0` 读成 `1`）。
// 所以**音高信简谱、时值看谁跟拍号自洽**，逐小节、按 x 一对一配对：
//
//   - 配对：简谱数字就印在对应符头的正上方（混排谱按列对齐），扣掉全页平移后 x 差 0.8 格以内算一对；
//   - 八度：简谱只给相对八度，绝对八度由全页配上的那些对「投票」定（取众数）；
//   - 音高：配上的音，简谱这一小节**拍数自洽**就照简谱改；
//   - 时值：配上的音，简谱自洽而五线谱**不自洽**时照简谱改（反过来不动）；
//   - 多出来的音：配上的音所在和弦的其余音（简谱是单旋律）删掉；
//     简谱自洽、五线谱超拍，没配上的那几个五线谱音符删掉正好补平才删。
//
// 简谱行的识别结果来自离线缓存（`gen-rasterjianpu.mjs`），缓存没命中就不互证。
import type { StaffNote } from "../staffomr/notedata";
import type { Staff } from "../staffomr/model";
import type { JianpuStrip } from "./jianpuband";
import type { RasterUnit } from "./staffline";

/** 缓存里一个简谱数字（x 是条内坐标）。字段名缩写见 `gen-rasterjianpu.mjs`。 */
export interface JianpuNum {
  d: number;
  x: number;
  oct: number;
  div: number;
  dot: number;
  aug: number;
}
export interface JianpuRow {
  bars: number[];
  nums: JianpuNum[];
}

export interface FuseStats {
  pairs: number;
  pitch: number;
  duration: number;
  removed: number;
  inserted: number;
}

/** 配对的 x 容差（线距，扣掉全页平移之后）。相邻两个八分音符隔一格半上下；
 *  符干另一头的假头比真头偏出去 0.7 格上下（真头没检出、只剩它时要配得上）。 */
const PAIR_DX = 0.8;
const STEP_LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const SHARPS = "FCGDAEB";
const FLATS = "BEADGCF";
/** fifths → 大调主音的音级（C=0）。简谱是首调的，`1` 就是调号那个大调的主音（小调曲子也一样按关系大调唱名）。 */
const tonicOf = (fifths: number) => (((fifths * 4) % 7) + 7) % 7;
const keyAlter = (step: string, fifths: number) =>
  fifths > 0 ? (SHARPS.slice(0, fifths).includes(step) ? 1 : 0) : fifths < 0 ? (FLATS.slice(0, -fifths).includes(step) ? -1 : 0) : 0;

/** 简谱数字的时值（四分音符 = 1）：减时线逐条减半、附点、增时线各加一拍。 */
const qOf = (n: JianpuNum) => {
  let q = 1 / 2 ** n.div;
  let add = q / 2;
  for (let i = 0; i < n.dot; i++, add /= 2) q += add;
  return q + n.aug;
};
/** 四分为 1 的时值 → 五线谱的「基本时值（全音符 = 1）+ 附点数」。凑不成整齐的就 null。 */
function baseDots(q: number): { base: number; dots: number } | null {
  for (const base of [1, 0.5, 0.25, 0.125, 0.0625])
    for (let dots = 0; dots <= 2; dots++) {
      let d = base;
      for (let i = 0, add = base / 2; i < dots; i++, add /= 2) d += add;
      if (Math.abs(d * 4 - q) < 1e-6) return { base, dots };
    }
  return null;
}
/** 删掉 `from` 之前，把它身上 `to` 还没有的那几段歌词过继过去（挂词在互证之前，
 *  字常挂在和弦里的假音上——实测《是谁》「從」「認」就这样跟着假音一起没了）。 */
function adopt(to: StaffNote, from: StaffNote): void {
  for (const l of from.lyrics ?? []) {
    if (to.lyrics?.some((m) => m.verse === l.verse)) continue;
    (to.lyrics ??= []).push(l);
  }
  if (!to.chord && from.chord) to.chord = from.chord;
}

const mode = (xs: number[]) => {
  const m = new Map<number, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  let best = NaN;
  let bn = 0;
  for (const [k, v] of m) if (v > bn) (best = k), (bn = v);
  return best;
};

export function fuseJianpu(
  notes: StaffNote[],
  strips: JianpuStrip[],
  staffOf: (strip: JianpuStrip) => Staff | undefined,
  rowsOf: (strip: JianpuStrip) => JianpuRow[] | undefined,
  fifthsOf: (st: Staff) => number,
  unit: RasterUnit,
): FuseStats {
  const stats: FuseStats = { pairs: 0, pitch: 0, duration: 0, removed: 0, inserted: 0 };
  const sp = unit.space;
  /** 符头（休止）的中心 x。`StaffNote.x` 是符号盒的左缘。 */
  const cx = (n: StaffNote) => (n.sym.box.left + n.sym.box.right) / 2;
  // **全页的 x 平移**：简谱数字不一定正对符头中心（《是谁》整页偏右半格上下），
  // 先拿每个数字到最近符头的差取中位数，配对时扣掉它，容差才收得紧
  const shift = (() => {
    const ds: number[] = [];
    for (const strip of strips) {
      const st = staffOf(strip);
      const row = rowsOf(strip)?.[0];
      if (!st || !row) continue;
      const xs = notes.filter((n) => n.staff === st).map(cx);
      for (const j of row.nums) {
        const jx = strip.box.x + j.x;
        let best = Infinity;
        for (const x of xs) if (Math.abs(x - jx) < Math.abs(best)) best = x - jx;
        if (Math.abs(best) <= sp * 1.5) ds.push(best);
      }
    }
    ds.sort((a, b) => a - b);
    return ds.length ? ds[ds.length >> 1] : 0;
  })();
  // 先把每条简谱行拆成小节、与五线谱的音配好对，八度等全页投完票再定
  type Meas = { jn: { n: JianpuNum; x: number; q: number }[]; sn: StaffNote[]; pairs: [JianpuNum, StaffNote][] };
  const all: { st: Staff; fifths: number; meas: Meas[] }[] = [];
  const votes: number[] = [];
  for (const strip of strips) {
    const st = staffOf(strip);
    const rows = rowsOf(strip);
    if (!st || !rows?.length) continue;
    const row = rows.reduce((a, r) => (r.nums.length > a.nums.length ? r : a));
    const fifths = fifthsOf(st);
    const tonic = tonicOf(fifths);
    // 小节线：并掉复纵线那种挨着的两根
    const bars: number[] = [];
    for (const b of [...row.bars].sort((a, c) => a - c).map((b) => strip.box.x + b))
      if (!bars.length || b - bars[bars.length - 1] > sp * 0.5) bars.push(b);
    const edges = [-Infinity, ...bars, Infinity];
    const staffNotes = notes.filter((n) => n.staff === st && !n.chordExtra && !n.grace && n.voice === 1);
    const meas: Meas[] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      const [a, b] = [edges[i], edges[i + 1]];
      const jn = row.nums.map((n) => ({ n, x: strip.box.x + n.x, q: qOf(n) })).filter((j) => j.x > a && j.x < b);
      const sn = staffNotes.filter((n) => cx(n) > a && cx(n) < b);
      if (!jn.length && !sn.length) continue;
      // 一对一配对：按 x 距离从近到远贪心
      const cand: [number, number, number][] = [];
      jn.forEach((j, ji) => sn.forEach((n, si) => {
        const dx = Math.abs(cx(n) - shift - j.x);
        // 休止与音符也配：简谱的 `0` 与 `1` 最容易读混（《是谁》首小节第一个 `0` 读成 `1`），
        // 配上了才不会被当成「没配上的简谱音」去补。休止对音符的那一对下面什么也不改。
        if (dx <= sp * PAIR_DX) cand.push([dx, ji, si]);
      }));
      cand.sort((p, q) => p[0] - q[0]);
      const usedJ = new Set<number>();
      const usedS = new Set<number>();
      const pairs: [JianpuNum, StaffNote][] = [];
      for (const [, ji, si] of cand) {
        if (usedJ.has(ji) || usedS.has(si)) continue;
        usedJ.add(ji);
        usedS.add(si);
        pairs.push([jn[ji].n, sn[si]]);
        const j = jn[ji].n;
        if (j.d >= 1 && j.d <= 7 && !sn[si].rest) votes.push(sn[si].diatonic - (tonic + j.d - 1 + 7 * j.oct));
      }
      meas.push({ jn, sn, pairs });
    }
    all.push({ st, fifths, meas });
  }
  if (!all.length) return stats;
  // 八度基准：`1` 在全音阶序号上的位置 − 主音音级，取全页众数（配错的对各投各的，压不过众数）
  const base = mode(votes);
  const qSums = all.flatMap((r) => r.meas.map((m) => m.jn.reduce((s, j) => s + j.q, 0)));
  const full = mode(qSums.filter((q) => q > 0));
  for (const { fifths, meas } of all) {
    const tonic = tonicOf(fifths);
    for (const m of meas) {
      const jSum = m.jn.reduce((s, j) => s + j.q, 0);
      if (Math.abs(jSum - full) > 1e-6) continue; // 简谱这一小节自己都不自洽：不拿它纠
      const sSum = () => m.sn.reduce((s, n) => s + n.duration * 4, 0);
      const staffOk = Math.abs(sSum() - full) < 1e-6;
      for (const [j, n] of m.pairs) {
        stats.pairs++;
        if (!n.rest && j.d >= 1 && j.d <= 7 && Number.isFinite(base)) {
          const dia = base + tonic + j.d - 1 + 7 * j.oct;
          if (dia !== n.diatonic) {
            const s = ((dia % 7) + 7) % 7;
            const step = STEP_LETTERS[s];
            const keep = step === n.step; // 只差八度：发声的升降照旧
            n.diatonic = dia;
            n.step = step;
            n.octave = Math.floor(dia / 7) - 1;
            if (!keep) {
              n.alter = keyAlter(step, fifths);
              n.accidental = null;
            }
            stats.pitch++;
          }
        }
        // 时值只改音符对音符的：休止在简谱里是按拍拆开写的（二分休止写成 `0 0`），对不成一对一
        if (!staffOk && !n.rest && j.d !== 0) {
          const bd = baseDots(qOf(j));
          if (bd && Math.abs(bd.base * (2 - 1 / 2 ** bd.dots) - n.duration) > 1e-6) {
            n.base = bd.base;
            n.dots = bd.dots;
            n.duration = bd.base * (2 - 1 / 2 ** bd.dots);
            stats.duration++;
          }
        }
      }
      // **配上的音同一和弦里的其余音都是假的**：简谱行是单旋律，一个数字只对一个音。
      // 假的多半是符干另一头被当成符头（《是谁》G4 的符干顶上多出个 E5、B4 的符干底下多出个 B3），
      // 与真符头拼成和弦，写出时还排在真的前面。
      for (const [, p] of m.pairs) {
        for (let i = notes.length - 1; i >= 0; i--) {
          const n = notes[i];
          if (n === p || n.staff !== p.staff || n.rest || n.grace) continue;
          if ((p.group && n.group === p.group) || Math.abs(cx(n) - cx(p)) < sp * 0.3) {
            adopt(p, n);
            notes.splice(i, 1);
            stats.removed++;
          }
        }
        if (p.chordExtra) p.chordExtra = undefined;
      }
      // 五线谱超拍、简谱不超：没配上的五线谱音删掉正好补平，才删
      if (sSum() > full + 1e-6) {
        const paired = new Set(m.pairs.map((p) => p[1]));
        const extra = m.sn.filter((n) => !paired.has(n));
        const drop = extra.reduce((s, n) => s + n.duration * 4, 0);
        if (extra.length && Math.abs(sSum() - drop - full) < 1e-6) {
          for (const n of extra) {
            // 歌词过继给 x 最近的留下来的音
            const keep = m.sn.filter((o) => !extra.includes(o) && !o.rest);
            if (keep.length) adopt(keep.reduce((a, o) => (Math.abs(cx(o) - cx(n)) < Math.abs(cx(a) - cx(n)) ? o : a)), n);
            const i = notes.indexOf(n);
            if (i >= 0) notes.splice(i, 1);
            stats.removed++;
          }
        }
      }
      // 五线谱缺拍、简谱不缺：没配上的简谱音正好补平缺口，就照简谱补进去
      //（《是谁》首小节那个 E4：符头贴着圆滑线，并成一块没认出来）。
      // 新音照最近那个已配对的音抄一份，改音高、时值、x；不挂和弦组（它的小节退回按顺序写）。
      const paired = new Set(m.pairs.map((p) => p[0]));
      const miss = m.jn.filter((j) => !paired.has(j.n) && j.n.d >= 1 && j.n.d <= 7);
      const gap = full - sSum();
      if (miss.length && gap > 1e-6 && Math.abs(miss.reduce((a, j) => a + j.q, 0) - gap) < 1e-6 && Number.isFinite(base) && m.pairs.length) {
        for (const j of miss) {
          const tpl = m.pairs.map((p) => p[1]).reduce((a, n) => (Math.abs(cx(n) - shift - j.x) < Math.abs(cx(a) - shift - j.x) ? n : a));
          const bd = baseDots(j.q);
          if (!bd) continue;
          const dia = base + tonic + j.n.d - 1 + 7 * j.n.oct;
          const step = STEP_LETTERS[((dia % 7) + 7) % 7];
          const x = j.x + shift;
          const n: StaffNote = {
            ...tpl, rest: false, diatonic: dia, step, octave: Math.floor(dia / 7) - 1,
            alter: keyAlter(step, fifths), accidental: null, base: bd.base, dots: bd.dots, duration: bd.base * (2 - 1 / 2 ** bd.dots),
            x: x - (cx(tpl) - tpl.x), chordExtra: undefined, group: undefined, lyrics: undefined, chord: undefined,
            slurStart: undefined, slurStop: undefined, tieStart: undefined, tieStop: undefined, marks: undefined,
          };
          if (tpl.group) tpl.group = undefined; // 同一小节里有了没分组的音，整小节退回按顺序写，别让它一半按拍位一半按顺序
          const at = notes.findIndex((o) => o.staff === tpl.staff && o.x > n.x);
          notes.splice(at < 0 ? notes.length : at, 0, n);
          m.sn.push(n);
          stats.inserted++;
        }
      }
    }
  }
  return stats;
}
