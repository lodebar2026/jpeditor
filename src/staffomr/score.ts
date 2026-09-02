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
  staff: Staff;
}

/** 两个签名算不算同一行谱（`StaffToken::operator==`）。 */
export function sameToken(a: StaffToken, b: StaffToken): boolean {
  return a.clef === b.clef && a.size === b.size && a.topOfBrace === b.topOfBrace && a.bottomOfBrace === b.bottomOfBrace;
}

/** 给一行谱做签名。 */
export function tokenOf(pg: SPage, stf: Staff, ctx: Map<Staff, StaffContext>): StaffToken {
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
  return { clef: ctx.get(stf)?.clef?.code ?? "", size, topOfBrace, bottomOfBrace, staff: stf };
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
export function buildScore(pages: { page: SPage; ctx: Map<Staff, StaffContext> }[]): StaffScore {
  const systems: StaffScore["systems"] = [];
  for (const { page, ctx } of pages) for (const sys of page.systems) systems.push({ page, sys, ctx });

  const scoreStaves: ScoreStaff[] = [];
  /** 当前状态：每个 ScoreStaff 最近一次见到的签名。 */
  let state: { token: StaffToken; ss: ScoreStaff }[] = [];

  systems.forEach((entry, si) => {
    const tokens = entry.sys.staves.map((st) => tokenOf(entry.page, st, entry.ctx));
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
