// 曲子一级：把各页的系统串起来，认出「跨系统的同一行谱」与「声部」。
// 移植自 musicpp `qtomr/system.cpp` 的 `Score::makeSystems` / `connectSystems` /
// `makeHidenStaves` 与 `SystemConnector` / `StaffToken`。
//
// 为什么要这一层：一首曲子印成好几个系统，**每个系统里的第 n 行谱是同一个声部**。
// 不连起来的话，钢琴谱的伴奏行会被当成一堆互不相干的谱行，导出时只能挑顶行
// （本仓在移植这一层之前就是这么做的，伴奏整个丢掉）。
import { Part, ScoreStaff, SPage, SSystem, Staff, overlapY } from "./model";
import type { StaffContext } from "./notedata";

/** 一行谱的「身份签名」。musicpp 的 `StaffToken`。 */
export interface StaffToken {
  /** 行首谱号（SMuFL 名）。 */
  clef: string;
  /** 相对本页常规谱表的大小：小谱（副谱）/常规/大谱。 */
  size: "small" | "normal" | "large";
  /** 在花括号的上半 / 下半（钢琴谱的两行分别是 top/bottom）。 */
  topOfBrace: boolean;
  bottomOfBrace: boolean;
  /** 这一行谱上挂着歌词吗。见 `assignSlots`。 */
  lyric: boolean;
  /** 这一行谱的**音域中位数**（全音阶级数，`C4` = 28）；没有音符为 null。见 `assignSlots`。 */
  pitch: number | null;
  /** 谱面印的**声部标签**（`S1`/`A`/`P`…，已归一）；没印或认不出为 null。见 `assignSlots`。 */
  label: string | null;
  staff: Staff;
}

/** 一行谱的内容剖面（`buildScore` 的调用方给，识别侧从音符里量）。 */
export interface StaffProfile {
  lyric: boolean;
  pitch: number | null;
  label?: string | null;
}

/** 两个签名算不算同一行谱（`StaffToken::operator==`）。 */
export function sameToken(a: StaffToken, b: StaffToken): boolean {
  if (a.size !== b.size) return false;
  // 谱号**没认出来**的行不拿谱号否决：认不出是识别的事，不该逼出一条新谱表
  //（实测宁静 100 行里有 3 行认不出，那三行把一条谱表劈成了两条）。
  if (a.clef && b.clef && a.clef !== b.clef) return false;
  const na = !a.topOfBrace && !a.bottomOfBrace;
  const nb = !b.topOfBrace && !b.bottomOfBrace;
  if (na || nb) return true;
  return a.topOfBrace === b.topOfBrace && a.bottomOfBrace === b.bottomOfBrace;
}

/** 给一行谱做签名。`profileOf` 没给就当没有词、没有音域（矢量路照旧只按几何连）。 */
export function tokenOf(
  pg: SPage,
  stf: Staff,
  ctx: Map<Staff, StaffContext>,
  profileOf: (s: Staff) => StaffProfile = () => ({ lyric: false, pitch: null, label: null }),
): StaffToken {
  const sp = pg.normalStaffSpace || pg.space;
  const sp1 = stf.stepDistance() * 2;
  const size = sp1 > sp * 1.15 ? "large" : sp > sp1 * 1.15 ? "small" : "normal";
  // 花括号：谱表左端那条与本行纵向相交的 `Bracket`（路径或字形）
  let topOfBrace = false;
  let bottomOfBrace = false;
  const cy = stf.cy;
  const braces = [
    ...pg.objs.filter((o) => o.hasTag("Bracket")).map((o) => o.box),
    ...pg.symbols.filter((s) => s.code === "bracket" || s.code === "brace").map((s) => s.box),
  ];
  for (const b of braces) {
    if (!overlapY(b, stf.box)) continue;
    // 括号只盖住这一行的话不算「分成上下两半」
    if (b.bottom - b.top < (stf.box.bottom - stf.box.top) * 1.5) continue;
    if (cy > (b.top + b.bottom) / 2) bottomOfBrace = true;
    else topOfBrace = true;
  }
  const pf = profileOf(stf);
  return { clef: ctx.get(stf)?.clef?.code ?? "", size, topOfBrace, bottomOfBrace, lyric: pf.lyric, pitch: pf.pitch, label: pf.label ?? null, staff: stf };
}

/** 最长公共子序列的配对（用签名相等判）。`SystemConnector` 用 dtl 的 diff，这里手写一份。 */
function lcsPairs(a: StaffToken[], b: StaffToken[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const f: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      f[i][j] = sameToken(a[i - 1], b[j - 1]) ? f[i - 1][j - 1] + 1 : Math.max(f[i - 1][j], f[i][j - 1]);
  const out: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (sameToken(a[i - 1], b[j - 1]) && f[i][j] === f[i - 1][j - 1] + 1) {
      out.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (f[i - 1][j] >= f[i][j - 1]) i--;
    else j--;
  }
  return out.reverse();
}

/**
 * **全局指派**：先定出一套「槽位」，再让每个系统的各行单调地落进槽位。
 *
 * 为什么不能只靠 `lcsPairs` 那条增量路：它拿每个系统与**前一状态**做一次 LCS，
 * 一步错步步错；而合唱谱一个系统里的人声行签名天生全都相等（同是常规大小的
 * G 谱号、花括号又多半找不到），LCS 的回溯天然「先配上面的」，
 * 于是 2 行的纯钢琴系统被配到女高女低上，那之后整条声部全串错
 * （实测破碎 headline 52.6%，同一份按谱行 69.9%；干净版 71.8% vs 92.9%）。
 *
 * 槽位取**行数最多的那一档系统**（同样多的取出现次数最多的一档），
 * 每个槽位的剖面由该档里各系统的同位行平均出来。打分三样一起：
 *
 *   - **谱号**：两边都认得出且不同 → 强否决；有一边认不出 → 不表态
 *     （认不出是识别的事，不该逼出一条新谱表——与 `sameToken` 同一条道理）。
 *   - **有没有词**：人声行印歌词、伴奏行不印。单行漏认只丢一分，不否决。
 *   - **音域中位数**：破碎那份逐系统摊开是 `36 / 34 / 32 / 30 / 26 / 31 / 21`
 *     （女高到钢琴左手），六个声部分得很开；而且它是几十个音的中位数，
 *     个别音读错不影响——这是三样里最硬的一条。
 *
 * 行落进槽位要**保序**（谱面上从上到下的次序不会变），所以是一维 DP。
 */
function assignSlots(rows: StaffToken[][]): number[][] | null {
  propagateLabels(rows);
  // ── 槽位数：行数最多的那一档（同样多取出现次数最多的） ──
  const byCount = new Map<number, StaffToken[][]>();
  for (const r of rows) {
    if (!r.length) continue;
    byCount.set(r.length, [...(byCount.get(r.length) ?? []), r]);
  }
  if (!byCount.size) return null;
  const n = Math.max(...byCount.keys());
  const full = byCount.get(n)!;
  if (n < 2) return null;
  // ── 槽位剖面：那一档里各系统同位行的平均 ──
  const slots = Array.from({ length: n }, (_, k) => {
    const ps = full.map((r) => r[k].pitch).filter((v): v is number => v !== null);
    const clefs = new Map<string, number>();
    for (const r of full) if (r[k].clef) clefs.set(r[k].clef, (clefs.get(r[k].clef) ?? 0) + 1);
    let clef = "";
    let cn = 0;
    for (const [c, v] of clefs) if (v > cn) [clef, cn] = [c, v];
    return {
      clef,
      lyric: full.filter((r) => r[k].lyric).length * 2 >= full.length,
      pitch: ps.length ? ps.sort((a, b) => a - b)[ps.length >> 1] : null,
    };
  });
  const labelOf: (string | null)[] = new Array(n).fill(null);
  /**
   * **不看 `size`。** `sameToken` 拿谱表大小当硬条件（小谱表是另一路声部），
   * 这里却**故意不用**——试过当强判据（`+1 / −6`）与弱偏好（`+0.5 / −0.5`），
   * 两种权重结果**完全相同**（其余判据在那几行上打平，大小项一票定输赢）：
   * 扫描件音符 54.90% → 54.97%、**音级 56.79% → 56.37%**，干净档不变。
   * 望十架 web 版每页有三行 14.7px 的小谱表（其余 18.1px），但它们多半是
   * **同一批声部为了排版印小了**，不是另一路——按大小硬分反而把真声部劈开。
   */
  const score = (t: StaffToken, k: number) => {
    const sl = slots[k];
    let v = 0;
    if (t.clef && sl.clef) v += t.clef === sl.clef ? CLEF_HIT : CLEF_MISS;
    v += t.lyric === sl.lyric ? LYRIC_HIT : -LYRIC_HIT;
    if (t.pitch !== null && sl.pitch !== null) v -= Math.min(PITCH_CAP, Math.abs(t.pitch - sl.pitch) * PITCH_W);
    // **标签压过音域**：谱面写着 `Soprano 1` 就是女高一部，而音域跨段落会整体挪
    // （破碎 3 行系统的女高唱 31~32、7 行系统里同一声部唱到 36，音域反而把它推走）。
    // 只在两边都有标签时表态；标签是稀疏的（只在声部进入处印）。
    if (t.label && labelOf[k]) v += t.label === labelOf[k] ? LABEL_HIT : LABEL_MISS;
    return v;
  };
  // ── 逐系统：保序地把 k 行放进 n 个槽位（DP） ──
  const assign = (): number[][] | null => {
  const out: number[][] = [];
  for (const r of rows) {
    const k = r.length;
    if (!k || k > n) return null; // 行数超过槽位数：这份谱不是「一套固定版式」，退回增量路
    const NEG = -1e9;
    const f = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(NEG));
    const from = Array.from({ length: k + 1 }, () => new Int8Array(n + 1));
    for (let j = 0; j <= n; j++) f[0][j] = 0;
    for (let i = 1; i <= k; i++)
      for (let j = 1; j <= n; j++) {
        const skip = f[i][j - 1];
        const take = f[i - 1][j - 1] + score(r[i - 1], j - 1);
        if (take >= skip) {
          f[i][j] = take;
          from[i][j] = 1;
        } else {
          f[i][j] = skip;
          from[i][j] = 0;
        }
      }
    const pick = new Array<number>(k);
    let i = k;
    let j = n;
    while (i > 0 && j > 0) {
      if (from[i][j]) pick[--i] = j - 1;
      j--;
    }
    if (i > 0) return null;
    out.push(pick);
  }
  return out;
  };
  // **两遍**：头一遍没有槽位标签（`labelOf` 全 null，标签那一项不表态），
  // 拿它的结果给每个槽位定一个标签（占多数的那个），第二遍标签才起作用。
  // 标签只在声部进入处印，一个槽位往往只有一两行带标签，所以要先有个指派才归得起来。
  const first = assign();
  if (!first) return null;
  for (let k = 0; k < n; k++) {
    const votes = new Map<string, number>();
    for (let si = 0; si < rows.length; si++) {
      const ri = first[si].indexOf(k);
      const lb = ri >= 0 ? rows[si][ri].label : null;
      if (lb) votes.set(lb, (votes.get(lb) ?? 0) + 1);
    }
    let best: string | null = null;
    let bn = 0;
    for (const [lb, v] of votes) if (v > bn) [best, bn] = [lb, v];
    // **先认「行数最满」那一档系统的同位行**：槽位本来就是从它们定出来的。
    // 投票会被**要挪走的那几行自己污染**——第一遍把 3 行系统的 `Soprano 1` 错放进
    // 槽位 2，槽位 2 的票就成了 `S1` 三对一，第二遍反倒给这个错配加分（自我强化）。
    // 那一档没读出标签时才退回投票。
    const anchor = new Map<string, number>();
    for (const r of full) if (r[k].label) anchor.set(r[k].label!, (anchor.get(r[k].label!) ?? 0) + 1);
    let ab: string | null = null;
    let an = 0;
    for (const [lb, v] of anchor) if (v > an) [ab, an] = [lb, v];
    labelOf[k] = ab ?? best;
  }
  // **标签少到区分不了任何东西时就别让它表态。** 标签只在声部进入处印，
  // 认出来的更少（实测全语料 59 条标签条只读出 8 个声部名）；只有一个槽位有名字、
  // 或几个槽位重名时，这一项不带信息，只会扰动本来就对的指派
  //（实测无条件用：干净档音符 83.02% → 82.94%）。
  const named = labelOf.filter((v): v is string => v !== null);
  return new Set(named).size >= 2 ? assign() : first;
}

/**
 * **同一档行数的系统之间，把标签传开。**
 *
 * 刻谱的版式规矩：一个声部长段不唱就不印那一行，一唱就印——所以「行数一样的系统，
 * 各行的身份也一样」（`chorus-diff.mjs::draftMap` 与人工映射的 `byRowCount` 都靠这条）。
 * 而标签**只在声部进入处印一次**：破碎那三个 3 行系统只有头一个印着 `Soprano 1`，
 * 后两个什么也没有，于是只有头一个落回槽位 0、另两个照旧按音域落进槽位 2。
 * 同一档里按行号取众数补齐，三个就一起对了。
 *
 * 只补**空着**的，不改已经读出来的——读出来的是纸上的字，比推出来的硬。
 */
function propagateLabels(rows: StaffToken[][]): void {
  const byCount = new Map<number, StaffToken[][]>();
  for (const r of rows) if (r.length) byCount.set(r.length, [...(byCount.get(r.length) ?? []), r]);
  for (const [k, group] of byCount) {
    if (group.length < 2) continue;
    for (let i = 0; i < k; i++) {
      const votes = new Map<string, number>();
      for (const r of group) if (r[i].label) votes.set(r[i].label!, (votes.get(r[i].label!) ?? 0) + 1);
      let best: string | null = null;
      let bn = 0;
      for (const [lb, v] of votes) if (v > bn) [best, bn] = [lb, v];
      if (best) for (const r of group) if (!r[i].label) r[i].label = best;
    }
  }
}

/** 谱号对上 / 对不上的分。对不上要压得住音域那一项，谱号是硬证据。 */
const CLEF_HIT = 2;
const CLEF_MISS = -6;
/** 有没有词对上的分。单行漏认只丢这么多，不否决。 */
const LYRIC_HIT = 1.5;
/** 标签对上 / 对不上的分。要压得过音域那一项（谱面写着的比量出来的硬）。 */
const LABEL_HIT = 4;
const LABEL_MISS = -8;
/** 音域每差一个音级扣多少、最多扣多少。 */
const PITCH_W = 0.35;
const PITCH_CAP = 4;

/** 一首曲子（若干页）的结构。 */
export interface StaffScore {
  systems: { page: SPage; sys: SSystem; ctx: Map<Staff, StaffContext> }[];
  scoreStaves: ScoreStaff[];
  parts: Part[];
}

/**
 * `Score::makeSystems` + `connectSystems` + `makeHidenStaves`。
 *
 * 逐个系统与「当前状态」做一次 LCS 对齐：对上的接到同一个 `ScoreStaff` 上，
 * 新出现的另起一个，这一系统里没有的记成**隐藏**（那一格留 null）。
 * 隐藏这一档是要害：合唱谱常常在只有钢琴的段落省掉人声行，
 * 不留位置的话后面所有行都会错位一格。
 */
export function buildScore(
  pages: { page: SPage; ctx: Map<Staff, StaffContext> }[],
  opts: { profileOf?: (stf: Staff) => StaffProfile } = {},
): StaffScore {
  const systems: StaffScore["systems"] = [];
  for (const { page, ctx } of pages) for (const sys of page.systems) systems.push({ page, sys, ctx });

  const tokensOf = systems.map((e) => e.sys.staves.map((st) => tokenOf(e.page, st, e.ctx, opts.profileOf)));
  const scoreStaves: ScoreStaff[] = [];

  // ── 有内容剖面时走**全局指派**（见 `assignSlots`）──────────────────────
  const slots = opts.profileOf ? assignSlots(tokensOf) : null;
  if (slots) {
    const n = Math.max(...slots.map((p) => Math.max(...p) + 1));
    for (let k = 0; k < n; k++) {
      const ss = new ScoreStaff();
      for (let si = 0; si < systems.length; si++) ss.staves[si] = null;
      scoreStaves.push(ss);
    }
    slots.forEach((pick, si) => pick.forEach((k, ri) => (scoreStaves[k].staves[si] = tokensOf[si][ri].staff)));
    return finishScore(systems, scoreStaves);
  }

  /** 当前状态：每个 ScoreStaff 最近一次见到的签名。 */
  let state: { token: StaffToken; ss: ScoreStaff }[] = [];

  systems.forEach((_entry, si) => {
    const tokens = tokensOf[si];
    const pairs = lcsPairs(
      state.map((x) => x.token),
      tokens,
    );
    const matchedLeft = new Map(pairs.map(([l, r]) => [l, r]));
    const matchedRight = new Set(pairs.map(([, r]) => r));
    const next: { token: StaffToken; ss: ScoreStaff }[] = [];
    let ri = 0;
    for (let li = 0; li < state.length; li++) {
      // 这一系统里新出现、排在本行之前的谱行，先各起一个 ScoreStaff
      const target = matchedLeft.get(li);
      while (ri < tokens.length && (target === undefined || ri < target)) {
        if (!matchedRight.has(ri)) next.push(newScoreStaff(scoreStaves, tokens[ri], si));
        ri++;
      }
      if (target !== undefined) {
        state[li].ss.staves[si] = tokens[target].staff;
        next.push({ token: tokens[target], ss: state[li].ss });
        ri = target + 1;
      } else {
        // 这一系统里没有这行：留个 null 占位（隐藏声部）
        state[li].ss.staves[si] = null;
        next.push(state[li]);
      }
    }
    while (ri < tokens.length) {
      if (!matchedRight.has(ri)) next.push(newScoreStaff(scoreStaves, tokens[ri], si));
      ri++;
    }
    state = next;
  });

  return finishScore(systems, scoreStaves);
}

/** 补齐长度、编号、分声部——两条路（增量 LCS 与全局指派）共用的收尾。 */
function finishScore(systems: StaffScore["systems"], scoreStaves: ScoreStaff[]): StaffScore {
  // 补齐长度（后面才出现的 ScoreStaff，前面那些系统都是 null）
  for (const ss of scoreStaves) {
    for (let i = 0; i < systems.length; i++) if (ss.staves[i] === undefined) ss.staves[i] = null;
  }
  scoreStaves.forEach((ss, i) => (ss.index = i));

  // 分声部：花括号的上半另起一个声部、下半接着上一个（照 `connectSystems` 原文）。
  //
  // **本书还要补一条**：Opus 那一路的花括号在页面上根本找不到（既不是路径也不是字形），
  // 只靠原文那条判据，钢琴谱的两行会各成一个声部。补的判据是刻谱的通行约定：
  // **同一系统里相邻的「G 谱号 + F 谱号」是大谱表**，合成一个声部。
  const parts: Part[] = [];
  let prevTok: StaffToken | null = null;
  for (const ss of scoreStaves) {
    const tok = lastToken(ss, systems);
    let newPart = !tok?.bottomOfBrace;
    if (!parts.length || tok?.topOfBrace) newPart = true;
    if (
      parts.length &&
      !tok?.topOfBrace &&
      prevTok?.clef.startsWith("gClef") &&
      tok?.clef.startsWith("fClef") &&
      sameSystemSomewhere(parts[parts.length - 1].scoreStaves, ss)
    ) {
      newPart = false;
    }
    if (newPart) parts.push(new Part());
    parts[parts.length - 1].scoreStaves.push(ss);
    prevTok = tok;
  }
  parts.forEach((p, i) => (p.index = i));
  return { systems, scoreStaves, parts };
}

/** 两行谱有没有在某个系统里同时出现过（同一系统 = 同时演奏）。 */
function sameSystemSomewhere(prev: ScoreStaff[], ss: ScoreStaff): boolean {
  const last = prev[prev.length - 1];
  if (!last) return false;
  for (let i = 0; i < ss.staves.length; i++) if (ss.staves[i] && last.staves[i]) return true;
  return false;
}

function newScoreStaff(all: ScoreStaff[], token: StaffToken, si: number): { token: StaffToken; ss: ScoreStaff } {
  const ss = new ScoreStaff();
  ss.staves[si] = token.staff;
  all.push(ss);
  return { token, ss };
}

/** 这一行谱最后一次出现时的签名（分声部要用花括号那两位）。 */
function lastToken(ss: ScoreStaff, systems: StaffScore["systems"]): StaffToken | null {
  for (let i = ss.staves.length - 1; i >= 0; i--) {
    const st = ss.staves[i];
    if (!st) continue;
    return tokenOf(systems[i].page, st, systems[i].ctx);
  }
  return null;
}
