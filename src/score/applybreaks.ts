// 把乐句分析的断点写到 Score 上（成书重排用）。
//
// 与 jpscore.ts 那条路的分工：
//   scoreToJpwabc({phrase:true})  Score → .jpwabc 文本，断点写成 `$(true)` / `$(true,0,0,true)`，
//                                 编辑器要的是文本，所以走那条；代价是**经过 jpwabc 这层会降采样**
//                                 （和弦、装饰音、部分 barline 装不下）。
//   applyPhraseBreaks（本文件）    Score → Score，断点直接写成 `LineBreak` entry，
//                                 就是 layout.ts:1402 消费的那个东西。成书重排走这条，
//                                 数据一路不落地成文本，和弦与结构都能带到排版。
//
// 无 DOM 依赖。
import { Chord, LineBreak, Measure, Part } from "./score";
import { headFpOf, lyricPunctScore, mainLyricText, type CutCandidate, type FitMetric, type PhraseBreaks } from "./phrase";

export type { FitMetric };

export interface ApplyBreakOptions {
  /** 每页几行。**0 = 不按行数换页**——成书排版走这个：一页装多少行交给
   *  layout 的 layoutVertically 按页高决定，硬定 4 行会让每页空掉半页。
   *  编辑器那条路（jpscore）仍是 4。 */
  linesPerPage?: number;
  /** 段落起点（主歌/副歌…）是否另起一页。成书里一首歌通常连排，默认不换。 */
  sectionNewPage?: boolean;
  /** 是否采用**行内断点**（`midBreaks`：在小节中间的和弦后换行）。
   *  弱起谱里乐句尾常被并进下一小节，行内断点就是为那种情形留的；
   *  但成书要的是**每行都在小节线上收尾**（原书就是这样），所以那边关掉它。 */
  useMidBreaks?: boolean;
}

export interface ApplyBreakResult {
  lines: number;
  pages: number;
}

function chordsOf(m: Measure): Chord[] {
  return m.entries.filter((e): e is Chord => e instanceof Chord);
}

function insertAfter(m: Measure, c: Chord, newPage: boolean): void {
  const i = m.entries.indexOf(c);
  const lb = new LineBreak(m);
  lb.newPage = newPage;
  // 与 Measure.lineBreak 同理：位置要跟着断点和弦走，否则 autoBeamGroup 的排序会把它挪到节首。
  lb.position = c.duration ? c.position.plus(c.duration) : c.position;
  m.entries.splice(i < 0 ? m.entries.length : i + 1, 0, lb);
}

/**
 * @param part   一般是 score.parts[0]
 * @param breaks computePhraseBreaks(part) 的结果
 */
export function applyPhraseBreaks(part: Part, breaks: PhraseBreaks, opt: ApplyBreakOptions = {}): ApplyBreakResult {
  const linesPerPage = opt.linesPerPage ?? 4;
  const sectionNewPage = opt.sectionNewPage ?? false;
  const useMidBreaks = opt.useMidBreaks ?? true;
  const ms = part.measures;
  let lines = 0;
  let pages = 1;
  // 段落起点一定换页，但**不能连着换两次**：段界落在小节内部（sectionCutChords）时，
  // 那个小节的末尾往往同时也是 measureBreaks 里的一条。
  let justPaged = false;

  const brk = (write: (page: boolean) => void, forcePage: boolean): void => {
    lines++;
    const page = forcePage || (linesPerPage > 0 && !justPaged && lines % linesPerPage === 0);
    write(page);
    if (page) {
      pages++;
      lines = 0;
    }
    justPaged = page;
  };

  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    for (const c of chordsOf(m)) {
      if (!useMidBreaks) break;
      if (!breaks.midBreaks.has(c) && !breaks.sectionCutChords.has(c)) continue;
      brk((page) => insertAfter(m, c, page), sectionNewPage && breaks.sectionCutChords.has(c));
    }
    const next = i + 1;
    if (next < ms.length && (breaks.measureBreaks.has(next) || breaks.sectionStarts.has(next))) {
      brk((page) => m.lineBreak(page), sectionNewPage && breaks.sectionStarts.has(next));
    }
  }
  return { lines, pages };
}


/**
 * 容量保险：把**放不下的行**按乐句子句断点切开。
 *
 * 乐句分析给的是「哪里断最自然」，但断点凭据稀疏时（弱起、整段连着圆滑线）它会交出
 * 一个九小节的长行；排版器随后按宽度硬折，甩出一个只剩两三个音的尾巴
 * （实测 006《颂赞归与耶稣圣名》就是这样：一行塞满 + 一行 "3 2 1--"）。
 * 所以在写 LineBreak 之前先按容量补几刀，落点由 `pickCuts` 挑。
 *
 * @param cells 一行放得下几格（由排版器实测，见 browser.ts::measureCellsPerLine）
 * @param useMidBreaks 调用方是否会采用行内断点（与 applyPhraseBreaks 的同名选项保持一致）。
 *        不采用时行内断点不切行，这里也不能把它当行边界、更不能往那儿落刀。
 */
export function enforceLineCapacity(part: Part, breaks: PhraseBreaks, cells: number, targetMeas = 4,
                                    useMidBreaks = true, fit?: FitMetric): void {
  applyCapacityCuts(part, breaks, cells, { targetMeas, useMidBreaks, avoidSpans: false, fit });
}

/**
 * **一行内部的落点选择**：把 [from,to] 这一行切成 k 段，返回 k−1 个落点。
 *
 * 原来是 `splitEvenly`：在「理想位置 ±22% 的硬窗口」里按凭据挑一条**小节线**，贪心逐刀落。
 * 那条路走到头了——补刀口径在「挑好落点」与「行长别悬殊」之间对角摆动，扫过六档参数
 * 没有拐点（λ=1 时行长悬殊 7 → 80 首，λ=6 时行首带标点 0 → 71 处；换成硬窗口也只是
 * 把两头的数字对调）。根子有两条，这里一起改掉：
 *
 *   1. **落点不该只在小节线上**。乐句的自然子句断点常落在小节中间（弱起谱尤其如此），
 *      而 `PhraseBreaks.cuts` 原来只带小节末的候选。现在行内候选一并带出，
 *      「后带小节线」降格成一项**加分**（`BAR_END_BONUS`），不再是硬约束。
 *   2. **贪心逐刀落不出整体工整**。改成一次 DP 把 k−1 个落点一起挑：
 *      工整性（各段时值偏离目标多少）与乐句凭据（标点/长音/休止/小节线）同场竞价，
 *      不再靠一个硬窗口把两件事隔开。
 *
 * 代价 = Σ 工整项 − Σ 凭据；容量是**不可行标记**而不是事后再验：`k = ⌈格数/容量⌉` 只保证
 * 平均放得下，落点一旦被强凭据拉离中点（句号在 2/3 处）前半段照样超。整条行怎么切都超
 * （k 给小了）时退化成软罚，保证总有解。
 */
/** 工整性权重：一段的时值偏离目标 20% 约值 5 分（与一个中等强度的断点凭据相当）。 */
const EVEN_W = 60;
/** 「后带小节线」的加分。与 `phrase.ts::breakCost` 里「行内弱断点 +6」同量级。 */
const BAR_END_BONUS = 3;
/**
 * **切开之后下一行是平行乐句开头**的加分（`CutCandidate.parallel`，按公共前缀长度折算）。
 *
 * 原书的分行大量是「平行乐句各自成行、对齐着排」，而强度分里平行只值 2 分
 * （`scoreAt` 拿它打平局）。补刀这一层尤其需要它：一行要切两半时，两个候选的
 * 标点/长音凭据常常一模一样（144《求圣灵吹我》的 `m1|`「气，」与 `m3|`「气：」都是
 * 10 分、行首罚也都是 16），这时候「切完两行开头旋律一样」就是决定性的一票。
 */
const PARALLEL_BONUS = 12;
/** 乐句凭据的倍率。补刀这一层比 DP **更该听凭据的**：DP 已经把整首排匀了，这里是
 *  「这一行放不下、非切不可」，切在哪儿决定的正是行首行末好不好看（D3/D4/D5/D6 全是
 *  头尾判据）。凭据的量程（0~24）本来是按 DP 的代价盘调的，直接拿来与工整项同场竞价太轻。 */
const EVIDENCE_W = 4;
/** 切出来的两段各自不许短于原行的这个比例（时值）。照搬已删除的 `phrase.ts::splitLongest`。 */
const SPLIT_MIN_FRAC = 0.3;
/** 切出来的每一段也不该短于容量的这个比例（格数）。与 D7「中间行不足容量四成」同口径
 *  ——拆完甩出个短行反而更难看（`splitLongest` 实测：不设这道闸全书 D7 会 2 → 13 处）。 */
const SPLIT_MIN_CELLS_FRAC = 0.4;

interface CutPos { cand: CutCandidate; i: number }

/** 全曲拍平的和弦序列 + 前缀量（格数/时值）。补刀入口建一次，逐行共用。 */
interface FlatBook {
  chords: Chord[];
  /** 每个和弦是不是所在小节的最后一个（`tidyLineHeads` 找行首残小节要用）。 */
  isLast: boolean[];
  idxOf: Map<Chord, number>;
  cellUpto: number[];
  durUpto: number[];
}

function flattenBook(part: Part): FlatBook {
  const chords: Chord[] = [];
  const isLast: boolean[] = [];
  for (const m of part.measures) {
    const cs = chordsOf(m);
    cs.forEach((c, k) => { chords.push(c); isLast.push(k === cs.length - 1); });
  }
  const idxOf = new Map<Chord, number>();
  chords.forEach((c, i) => idxOf.set(c, i));
  const cellUpto = [0];
  const durUpto = [0];
  chords.forEach((c, i) => {
    cellUpto[i + 1] = cellUpto[i] + cellsOfChord(c);
    durUpto[i + 1] = durUpto[i] + (c.duration?.toFloat() ?? 0);
  });
  return { chords, isLast, idxOf, cellUpto, durUpto };
}

function pickCuts(part: Part, book: FlatBook, line: LineInfo, k: number, breaks: PhraseBreaks,
                  f: Fit, useMidBreaks: boolean, avoidSpans: boolean, allowSoft = true): CutCandidate[] {
  if (k <= 1) return [];
  const { durUpto, idxOf } = book;
  const cells = f.capacity;
  // 候选：本行**内部**的乐句断点（行末那个不算——它已经是断点了）
  const pool: CutPos[] = [];
  for (const cand of breaks.cuts) {
    const i = idxOf.get(cand.chord);
    if (i === undefined || i <= line.from || i >= line.to) continue;
    if (!cand.isLast && !useMidBreaks) continue;                    // 行内断点不采用时落不了刀
    if (cand.isLast && avoidSpans && cutsThroughSpan(part, cand.mi + 1)) continue;
    pool.push({ cand, i });
  }
  // 一段 `(a, b]` 有多宽：**真实坐标**（`Fit`），不是格数
  const cellsOfSeg = (a: number, b: number) => f.spanOf(a + 1, b);
  const durOfSeg = (a: number, b: number) => durUpto[b + 1] - durUpto[a + 1];
  const total = durOfSeg(line.from - 1, line.to);
  const target = total / k;
  const minDur = total * SPLIT_MIN_FRAC * (2 / k);          // k=2 时就是「各占三成」
  const minCells = cells > 0 ? cells * SPLIT_MIN_CELLS_FRAC : 0;
  if (!pool.length) return [];

  // 一段（a,b] 的代价：工整项 + 超容量罚。
  //
  // `hard` 那一遍**两条硬闸都验**（切出来的两半都不许太短、都得放得下），
  // 软的那一遍只留「不许太短」——「这一行怎么切都超容量」（k 给小了）时总得有个解。
  const segCost = (a: number, b: number, hard: boolean): number => {
    const d = durOfSeg(a, b);
    const c = cellsOfSeg(a, b);
    if (d < minDur) return Infinity;
    let v = target > 0 ? EVEN_W * ((d - target) / target) ** 2 : 0;
    // 「切出来的一半不足版心四成」是**硬闸**（与 D7「中间行过短」同口径）：切完甩出个短行
    // 比刀落得不好还难看。试过改成重罚、让强落点买下一个略短的一半（438《祢是我藏身处》
    // 那条 +14 分的「中。」），全书 D7 立刻 0 → 18~38 处，不划算——**别再试**。
    // 那类曲子真正缺的是版心（见「补刀补不了的」一节）。
    if (hard && minCells > 0 && c < minCells) return Infinity;
    const over = c - cells;
    if (cells > 0 && over > 0) {
      if (hard) return Infinity;
      v += 100 + over ** 2 * 8;
    }
    return v;
  };

  const run = (hard: boolean): CutCandidate[] | null => {
    // dp[j][t] = 已落 j 刀、最后一刀落在 pool[t] 时的最小代价
    const N = pool.length;
    const dp: number[][] = [];
    const from: number[][] = [];
    for (let j = 0; j <= k - 1; j++) { dp.push(new Array<number>(N).fill(Infinity)); from.push(new Array<number>(N).fill(-1)); }
    for (let t = 0; t < N; t++) dp[0][t] = segCost(line.from - 1, pool[t].i, hard) - value(pool[t].cand);
    for (let j = 1; j < k - 1; j++) {
      for (let t = 0; t < N; t++) {
        for (let u = 0; u < t; u++) {
          if (!isFinite(dp[j - 1][u])) continue;
          const v = dp[j - 1][u] + segCost(pool[u].i, pool[t].i, hard) - value(pool[t].cand);
          if (v < dp[j][t]) { dp[j][t] = v; from[j][t] = u; }
        }
      }
    }
    let best = Infinity;
    let bestT = -1;
    for (let t = 0; t < N; t++) {
      if (!isFinite(dp[k - 2][t])) continue;
      const v = dp[k - 2][t] + segCost(pool[t].i, line.to, hard);
      if (v < best) { best = v; bestT = t; }
    }
    if (bestT < 0 || !isFinite(best)) return null;
    const out: CutCandidate[] = [];
    for (let j = k - 2, t = bestT; j >= 0 && t >= 0; t = from[j][t], j--) out.unshift(pool[t].cand);
    return out;
  };
  // `allowSoft` = 排不下也非切不可（容量补刀）；整段统一断那一路不许退让——切不出像样的
  // 两半就整段放弃，宁可维持原样（`applyCapacityCuts` 的第 3 步）。
  const got = run(true) ?? (allowSoft ? run(false) : null) ?? [];
  // @ts-ignore 调试钩子：这一行的候选落点与各自的分。页面里先 `window.__pickDebug = []`。
  //「为什么切在这儿不切在那儿」光看结果猜不出来——009 的「天上众军」就是靠它看出
  // 那个 15 分的平行落点被「两半都不许太短」的硬闸挡在外面。
  if (typeof window !== "undefined" && Array.isArray((window as any).__pickDebug))
    (window as any).__pickDebug.push({
      k, from: line.from, to: line.to, dur: line.dur,
      pool: pool.map((p) => ({ i: p.i, mi: p.cand.mi, isLast: p.cand.isLast, score: p.cand.score,
        par: p.cand.parallel, v: Math.round(value(p.cand) * 10) / 10 })),
      got: got.map((c) => c.mi),
    });
  return got;
}

/** 一个候选断点值多少分：乐句凭据（标点/长音/休止/延长号/反复…，已减行首罚）+ 收在小节线上。 */
// **「落在句号上」不再另外加分**：试过给 `CutCandidate.end` 加 8~14 分（强度分里句号与逗号
// 只差 2 分，「短分句减半」还会把句号折成 3），全书七档没有收益、D8 反而 +1 处，
// 168《爱喜乐生命》那处「忧愁不再。」也没被拉过来（用户核对后表示两种断法都可接受）。
const value = (c: CutCandidate): number =>
  EVIDENCE_W * c.score + (c.isLast ? BAR_END_BONUS : 0) + PARALLEL_BONUS * (c.parallel / 12);

/**
 * **容量补刀**：一行放不下就在它内部切开，落点由 `pickCuts` 按乐句凭据 + 工整性挑。
 *
 * 两条口径：
 *
 * 1. **工整的段落要整段一起断**（用户口径：「工整的段落如果有一句排不下断成两句，
 *    要求整段每一行都断成两句」）。逐行独立补刀的话，段里只有一行被切成两截、
 *    其余行不动，行长立刻悬殊。这与 `mergePairsUniform`「全首一个口径」是同一条道理的反向；
 *    已删除的 `phrase.ts::splitLongest` 也早写着同一条实测结论——「一条一条来会把同一段
 *    拆得参差：374《跟随救主》段 2 两行各 16 拍、都是段 1 的两倍，只拆一条就成了 16/8/8」。
 * 2. **只拆一轮**。拆完行长全变了，再判一次很容易把本来正常的行也判成过长
 *    （`splitLongest` 实测：142《圣灵请来》被连拆四轮成了 8 行）。真还超容量，
 *    交给 `rebuild.mjs` 的容量收敛循环下一轮。
 */
export function applyCapacityCuts(part: Part, breaks: PhraseBreaks, cells: number,
                                  opt: { targetMeas?: number; useMidBreaks: boolean; avoidSpans: boolean; fit?: FitMetric }): void {
  const ms = part.measures;
  const { useMidBreaks, avoidSpans } = opt;
  const book = flattenBook(part);
  const f = new Fit(opt.fit, cells).bind(book);
  if (!ms.length || !f.on) return;
  // 小节数也设一道闸：**真实坐标只管宽度**，管不到「九小节一行」这种——006 的主歌
  // 每小节只有两三个音，宽度上放得下，可一行九小节读起来就是不像话。
  // C 档（avoidSpans）只看宽度，与原 evenLayout 一致。
  const targetMeas = opt.targetMeas ?? 0;
  const hardMeas = targetMeas > 0 ? Math.max(targetMeas + 1, Math.ceil(targetMeas * 1.5)) : 0;
  // **照真正的行来判**（`describeLines`），别拿小节下标去重建行边界：行内断点落在小节中间，
  // 按「该小节归上一行」近似出来的边界与真实的行差着一格，于是一条本来放得下的行被判成超容量
  // 又切一刀，甩出个六格的小尾巴（286《耶和华祝福满满》的第 3 行）。
  const lines = describeLines(part, breaks, useMidBreaks);
  /**
   * 这一行要切成几段。宽度按**真实坐标**（`Fit`）判——排版器折不折行看的就是这个。
   * **只超一丁点的不切**（`CUT_TOL`，按版心宽度的比例）：切开的代价是段内立刻悬殊
   * （061《坚固保障》三行各 24 拍，第 1 行只超一点点，切开就成了 13/11/24/24 拍），
   * 而 justify 一挤就下去了。
   */
  const kOf = (l: LineInfo): number => {
    const w = f.ofLine(l);
    return Math.max(w >= f.capacity * (1 + CUT_TOL) ? Math.max(2, Math.ceil(w / f.capacity)) : 1,
      hardMeas > 0 ? Math.ceil(l.bars / hardMeas) : 1);
  };

  const write = (cand: CutCandidate): void => {
    if (cand.isLast) {
      breaks.measureBreaks.add(cand.mi + 1);
      breaks.capacityCuts.add(cand.mi + 1);
    } else {
      breaks.midBreaks.add(cand.chord);
      breaks.capacityCuts.add(cand.chord);
    }
  };

  // 按段分组（段界 = 该行的行末是段界），与 line-check 的 D8 同一口径
  const segs: LineInfo[][] = [[]];
  for (const l of lines) {
    segs[segs.length - 1].push(l);
    if (l.section) segs.push([]);
  }
  /** 这一行切成 k 段：`hard` 一遍（两半都得放得下、都不许太短）切不出来就返回空。 */
  const cutsFor = (l: LineInfo, k: number, allowSoft: boolean): CutCandidate[] =>
    pickCuts(part, book, l, k, breaks, f, useMidBreaks, avoidSpans, allowSoft);
  /**
   * **k 不够就加 k**，别指望「先切两半、下一轮再各切一半」。
   *
   * `k = ⌈格数/容量⌉` 只是下限：60 格 / 容量 30 要求切得分毫不差的 30+30，落点上根本没有
   * 那条小节线，于是这一刀切不出来（或勉强切出 31 格的一半），下一轮再各切一半——
   * 224《献上你虔诚的祈祷》就是这么从「12 小节一行」一路劈成 3 小节一行的（原书是 4 小节）。
   * 让 k 自己往上找一格，60 格就是 20/20/20，正好每行 4 小节。
   */
  const K_SLACK = 2;
  const bestCuts = (l: LineInfo): CutCandidate[] => {
    const k0 = kOf(l);
    for (let k = k0; k <= k0 + K_SLACK; k++) {
      const p = cutsFor(l, k, false);
      if (p.length === k - 1) return p;
    }
    return cutsFor(l, k0, true);   // 怎么切都放不下（容量给死了）→ 退让，至少切开
  };

  const done = new Set<LineInfo>();
  /** 段内统一那一步真切下去的「行宽 → 用的 k」，给下面「别的段也跟着切」用。 */
  const cutAs: { w: number; k: number }[] = [];
  for (const seg of segs) {
    if (seg.length < 2) continue;
    if (!seg.some((l) => kOf(l) > 1)) continue;            // 这一段没有排不下的行
    // **工整段**：段内各行长短本来就相近（按时值，与 line-check 的 D8 同一把尺子）
    const ds = seg.map((l) => l.dur);
    const lo = Math.min(...ds);
    const hi = Math.max(...ds);
    if (!(hi > 0 && lo / hi >= UNIFORM_RATIO)) continue;
    // **整段一个 k**：段内每行都断成同样的份数，否则又不齐了。k 从「最长那行至少要几段」
    // 起往上找，找到第一个**段内每行都断得出来**的（都不许太短、都得放得下）。
    const k0 = Math.max(2, ...seg.map(kOf));
    let picks: CutCandidate[][] | null = null;
    let used = 0;
    for (let k = k0; k <= k0 + K_SLACK && !picks; k++) {
      const got = seg.map((l) => cutsFor(l, k, false));
      if (got.every((p) => p.length === k - 1)) { picks = got; used = k; }
    }
    // @ts-ignore 调试钩子：整段统一断这一步为什么成/为什么没成
    //（页面里先 `window.__cutDebug = []`，排完读它。光看结果猜不出是哪一行卡住的。）
    if (typeof window !== "undefined" && Array.isArray((window as any).__cutDebug))
      (window as any).__cutDebug.push({
        seg: seg.map((l) => ({ dur: l.dur, cells: l.cells, k: kOf(l) })),
        uniform: lo / hi, k0, used, ok: !!picks,
      });
    if (!picks) continue;                                  // 有一行断不出来 → 整段放弃统一
    picks.forEach((p) => p.forEach(write));
    seg.forEach((l) => done.add(l));
    for (const l of seg) cutAs.push({ w: f.ofLine(l), k: used });
  }
  // **别的段切了，本来就一样长的这一行也得跟着切**：段内统一只管一个段，段与段之间
  // 同样要齐——446《迦勒看见主》断句给的是三行各 32 拍（314 / 310 / 311 宽），
  // 主歌那两行在上一步按 k=2 切成四行各 16 拍，副歌那一行 311 宽、卡着版心刚好放得下，
  // 于是原样留着：一页上主歌四行各 155 宽、副歌一行 311 宽，长了整整一倍。
  // 段内统一那一步对**只有一行的段**（`seg.length < 2`）本来就直接跳过，够不着它。
  // **按行宽比，不按时值**，门槛也比段内那把尺子严得多（`SAME_WIDTH_RATIO` 0.97 vs
  // `UNIFORM_RATIO` 0.8）：段内是「长短相近就统一」，这里是「本来就一样满的才跟着切」。
  // 时值分不开这两首——436《信靠亲爱救主》主歌两行 24 拍、副歌两行 24 / 30 拍，
  // 357《祈祷》主歌四行 16 拍、副歌两行 16 / 20 拍，形状一模一样，可
  //   436 主歌 300 / 301 宽、副歌那条被切的也是 300 宽（一样满 → 该跟着切）；
  //   357 主歌 288 / 268 宽、副歌那条被切的是 309 宽（差着一截 → 不该跟）。
  // 「这一行有多满」本来就是决定切不切的那个量，拿它比才对得上。
  // 副歌本来就可以比主歌长（用户口径），这里只管「一样满的要一样切」。
  if (cutAs.length) for (const l of lines) {
    if (done.has(l)) continue;
    const lw = f.ofLine(l);
    const m = cutAs.find((c) => lw > 0 && c.w > 0
      && Math.min(c.w, lw) / Math.max(c.w, lw) >= SAME_WIDTH_RATIO);
    if (!m) continue;
    const p = cutsFor(l, m.k, false);
    if (p.length !== m.k - 1) continue;
    p.forEach(write);
    done.add(l);
  }
  for (const l of lines) {
    if (done.has(l)) continue;
    if (kOf(l) <= 1) continue;
    for (const cand of bestCuts(l)) write(cand);
  }
}

/**
 * 补刀的容差（版心宽度的比例）。
 *
 * **真实坐标下应当是 0**：排版器的判据就是「自然宽度 < 版心宽」（`layout.ts::doLineBreak`），
 * justify 只会往空档里**加**距离、不会压缩，所以超出一点点也一定会折行。
 * 留这个常量是给退化那条路（按格数估）用的——格数本来就不准，卡死反而多切。
 */
const CUT_TOL = 0;

/** 「工整段」的门槛：段内最短行 ÷ 最长行（按时值）到这个比例才算工整，才要求整段一起断。 */
const UNIFORM_RATIO = 0.8;
/** 「本来就一样满」——跨段跟着切那一步的门槛（按行宽比，见 `applyCapacityCuts` 里那段注释）。 */
const SAME_WIDTH_RATIO = 0.97;

/**
 * 「放不放得下」的两把尺子：有真实坐标就用它，没有就退回按格数估（编辑器那条路、
 * 以及量不出坐标的场合）。**成书一律走真实坐标。**
 */
class Fit {
  constructor(private readonly metric: FitMetric | undefined, private readonly cells: number) {}
  /** 版心「装得下多少」的量纲：真实坐标下是宽度，退化时是格数。 */
  get capacity(): number {
    return this.metric ? this.metric.width : this.cells;
  }
  get on(): boolean {
    return this.capacity > 0;
  }
  /** 拍平序列（由 `bind` 注入）。 */
  book: FlatBook = { chords: [], isLast: [], idxOf: new Map(), cellUpto: [0], durUpto: [0] };
  bind(book: FlatBook): this {
    this.book = book;
    return this;
  }
  /** 一行有多宽。 */
  ofLine(l: LineInfo): number {
    return this.spanOf(l.from, l.to);
  }
  /** 全曲拍平序列里 `[from, to]`（含端点）这一段有多宽。 */
  spanOf(from: number, to: number): number {
    const b = this.book;
    if (from > to) return 0;
    if (this.metric) {
      const a = this.metric.spans.get(b.chords[from]);
      const z = this.metric.spans.get(b.chords[to]);
      if (a && z) return z.x1 - a.x0;
    }
    return b.cellUpto[to + 1] - b.cellUpto[from];
  }
}

/** 一行的行首「残小节」：从行首到第一条小节线之间的那点内容。 */
export interface LineHead {
  /** 残小节的**时值**（`Chord.duration` 之和；`Chord.beats` 是增时线格数，不是时值）。
   *  整小节起头时就是该小节的全长。 */
  dur: number;
  /** 行首是不是小节起点（false = 从小节中间起头，弱起/长音收尾之后） */
  full: boolean;
  /** 残小节里有没有音符（false = 只有休止） */
  hasNote: boolean;
  /** 残小节占多少**格**（`tidyLineHeads` 判「并到上一行放不放得下」要用它，
   *  不能拿整行的格数——那会把「并两拍休止」误判成「并一整行」）。 */
  cells: number;
  /** 行首第一个和弦：是不是休止、几条符杠、几拍 */
  rest: boolean;
  beams: number;
  firstBeats: number;
  /** 行首第一个和弦的**时值**（判「行首是不是半拍休止」用） */
  firstDur: number;
  /** 行首第一个和弦的歌词标点分：**带标点的长音**是上一句的收尾，不该出现在行首（373） */
  firstPunct: number;
  /** 行首第一个和弦的主歌词（「这一行从哪个字起唱」，line-check 的定点断言要用） */
  text: string;
}

/** 一行的行末：最后一个和弦的歌词末字与其标点分（句末 6 / 句中 4 / 无 0）。 */
export interface LineTail {
  text: string;
  punct: number;
  beats: number;
  /** 行末往前**最近的那个有词的字**。行末落在延音（tie）或休止上时 `text` 是空的，
   *  可这一句唱到哪儿是明摆着的——往前找到那个字才知道「这一行收在哪里」。
   *  断句方案快照记的就是它。 */
  lastWord: string;
  /** 同上，那个字的标点分。行末落在无词的拖腔上时 `text` 是空的，光看它分不出
   *  「乐句唱完了、行末是收尾的长音」与「句子没唱完、断在了拖腔中间」
   *  ——后者会把词从中间劈开（077《耶稣我主荣耀王》的「殷｜勤」）。 */
  lastWordPunct: number;
}

/** 断点把曲子切成的一行。`mi`/`chord` 是**这一行末尾**那个断点（小节末 `mi`：在第 mi 小节后换行；
 *  行内：`chord`）；末行没有断点，两者皆 null。 */
export interface LineInfo {
  cells: number;
  /** 这一行的**时值**（Σ `Chord.duration`，即多少拍）。
   *  `beats` 是增时线格数、`cells` 是视觉宽度，都不是时长；断句方案快照记的是这个。 */
  dur: number;
  /** 这一行覆盖的小节下标区间（含端点；从小节中间起头/收尾时与相邻行共享一个小节） */
  fromMi: number;
  toMi: number;
  /** 整小节数（行内收在小节线上的次数） */
  bars: number;
  beats: number;
  head: LineHead;
  tail: LineTail;
  /** 行首的旋律指纹（`phrase.ts::headFpOf`）：两行相同 = 平行乐句开头。 */
  headFp: string;
  mi: number | null;
  chord: Chord | null;
  /** 段界（另起一页）不可合并。 */
  section: boolean;
  /** 这一行覆盖的和弦在**全曲拍平序列**里的下标区间（含端点）。补刀要在行内部找落点。 */
  from: number;
  to: number;
  /** 这一行的**行首**那个断点是不是**容量补刀**落的（`applyCapacityCuts`）。
   *  补刀是为了「这一行放不下」才在行内部落刀，落点由乐句凭据定，后半截的行首残小节
   *  自然可能与本段其余行不一样长——那不是断句挑错了地方，`line-check.mjs` 的 D2
   *  据此豁免（用户口径：拆分导致的弱起不一致不算错误）。 */
  fromCut: boolean;
}

/** 一个和弦占多少格（一个音符 1 格，长音的每根增时线各占 1 格）。 */
const cellsOfChord = (c: Chord): number => Math.max(1, Math.floor(c.beats) || 1);

/**
 * 按断点把 part 切成行，并把**判断版面好坏要用的事实**一并算出来
 * （行首残小节、行末歌词标点、格数、小节数）。
 *
 * `mergeShortLines` / `tidyLineHeads` / `rebuild.mjs` 的逐行报告共用这一份——
 * 各数各的就会出现「检查脚本说没问题、排出来还是难看」。
 */
export function describeLines(part: Part, breaks: PhraseBreaks, useMidBreaks: boolean): LineInfo[] {
  interface FC { chord: Chord; mi: number; k: number; isLast: boolean }
  const flat: FC[] = [];
  part.measures.forEach((m, i) => {
    const cs = chordsOf(m);
    cs.forEach((c, k) => flat.push({ chord: c, mi: i, k, isLast: k === cs.length - 1 }));
  });
  const out: LineInfo[] = [];
  let start = 0;
  const emit = (end: number, mi: number | null, chord: Chord | null, section: boolean): void => {
    const seg = flat.slice(start, end + 1);
    if (!seg.length) return;
    const from = start;
    start = end + 1;
    // 行首残小节：从行首到第一条小节线（整行都在一个小节里时就是整行）
    const headEnd = seg.findIndex((f) => f.isLast);
    const head = seg.slice(0, headEnd < 0 ? seg.length : headEnd + 1);
    const last = seg[seg.length - 1];
    const text = mainLyricText(last.chord);
    out.push({
      cells: seg.reduce((n, f) => n + cellsOfChord(f.chord), 0),
      dur: seg.reduce((n, f) => n + (f.chord.duration?.toFloat() ?? 0), 0),
      fromMi: seg[0].mi,
      toMi: last.mi,
      bars: seg.filter((f) => f.isLast).length,
      beats: seg.reduce((n, f) => n + f.chord.beats, 0),
      head: {
        dur: head.reduce((n, f) => n + (f.chord.duration?.toFloat() ?? 0), 0),
        full: seg[0].k === 0,
        hasNote: head.some((f) => !f.chord.rest),
        cells: head.reduce((n, f) => n + cellsOfChord(f.chord), 0),
        rest: seg[0].chord.rest,
        beams: seg[0].chord.beams,
        firstBeats: seg[0].chord.beats,
        firstDur: seg[0].chord.duration?.toFloat() ?? 0,
        firstPunct: lyricPunctScore(seg[0].chord),
        text: mainLyricText(seg[0].chord),
      },
      tail: (() => {
        // 行末落在延音／休止上时 `text` 是空的，往前找到最后一个有词的字
        let lastWord = "";
        let lastWordPunct = 0;
        for (let j = seg.length - 1; j >= 0; j--) {
          const t = mainLyricText(seg[j].chord);
          if (!t) continue;
          lastWord = t;
          lastWordPunct = lyricPunctScore(seg[j].chord);
          break;
        }
        return { text, punct: lyricPunctScore(last.chord), beats: last.chord.beats, lastWord, lastWordPunct };
      })(),
      headFp: headFpOf(seg.map((f) => f.chord)),
      mi,
      chord,
      section,
      from,
      to: end,
      fromCut: from > 0
        && (breaks.capacityCuts.has(flat[from - 1].chord)
          || (flat[from - 1].isLast && breaks.capacityCuts.has(flat[from - 1].mi + 1))),
    });
  };
  flat.forEach((f, idx) => {
    if (useMidBreaks && (breaks.midBreaks.has(f.chord) || breaks.sectionCutChords.has(f.chord)))
      return emit(idx, null, f.chord, breaks.sectionCutChords.has(f.chord));
    if (f.isLast && (breaks.measureBreaks.has(f.mi + 1) || breaks.sectionStarts.has(f.mi + 1)))
      emit(idx, f.mi + 1, null, breaks.sectionStarts.has(f.mi + 1));
  });
  emit(flat.length - 1, null, null, false);
  return out;
}

/**
 * 逐行的**真实宽度**（自然坐标，未 justify）与版心宽度。
 *
 * 给 `rebuild.mjs` 的逐行事实用——`line-check.mjs` 判「这一行是不是太短 / 放不放得下」
 * 也要按真实宽度，不能按格数（用户口径，见 `FitMetric`）。
 */
export function measureLines(part: Part, lines: LineInfo[], fit?: FitMetric): { width: number; widths: number[] } {
  const f = new Fit(fit, 0).bind(flattenBook(part));
  return { width: f.capacity, widths: lines.map((l) => f.ofLine(l)) };
}

/**
 * **行首不留半个小节的休止**：一行从「休止 + 小节线」起头（残小节里一个音符都没有）时，
 * 把那点休止并到上一行去——下一行开头是个空拍，唱的人不知道要等谁
 * （020《向主歌唱》、193《主恩更多》第二行）。整小节的休止同理（整节挂到上一行；
 * 用户口径：完整的休止小节放上一行或下一行都行，有问题的是**半个小节**的休止）。
 *
 * 这是**兜底**：断句本身在 phrase.ts 的 DP 里就按同一条判据罚过了，但
 * `enforceLineCapacity` / `mergeShortLines` 会在 DP 之后造出新的行首，那些 DP 管不到。
 *
 * @param cells 退化时的容量（格数）；有 `fit` 时一律按**真实坐标**判「并过去放不放得下」
 */
export function tidyLineHeads(part: Part, breaks: PhraseBreaks,
                              opt: { useMidBreaks?: boolean; cells?: number; fit?: FitMetric } = {}): number {
  const useMidBreaks = opt.useMidBreaks ?? true;
  const f = new Fit(opt.fit, opt.cells ?? 0).bind(flattenBook(part));
  const lines = describeLines(part, breaks, useMidBreaks);
  let moved = 0;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (cur.head.hasNote) continue;
    if (prev.section) continue;          // 段界（另起一页）不能挪
    if (cur.fromMi === cur.toMi && cur.bars === 0) continue; // 整行都在一个小节里：没有小节线可挪到
    // 并过去的**只是行首那个残小节**，不是整行——原来这里拿的是 `cur.cells`（整行格数），
    // 于是「并两拍休止」被算成「并一整行」，放不下就不并了
    //（282《我的灯需要油》第 3 行：上一行 32 格 + 本行 22 格 = 54 > 容量 33，
    //   实际要并过去的只有 2 格）。
    // 并过去之后那一行有多宽：**真实坐标**（行首残小节的最后一个和弦到 prev 的行首）
    let headEnd = cur.from;
    while (headEnd < cur.to && !f.book.isLast[headEnd]) headEnd++;
    if (f.on && f.spanOf(prev.from, headEnd) >= f.capacity) continue;
    if (prev.mi !== null) breaks.measureBreaks.delete(prev.mi);
    if (prev.chord) breaks.midBreaks.delete(prev.chord);
    breaks.measureBreaks.add(cur.fromMi + 1);
    moved++;
  }
  return moved;
}

/**
 * **每两句并一行**（B 档，见 `chooseLineLayout`）。
 *
 * 乐句分析给的是「一句一行」，而原书绝大多数是**一行两句**：005《荣耀归与天父》每小节才
 * 3.2 格，4 小节只有 13 格，版心却放得下 27 格——一句一行每行只用半幅版心，还要被 justify
 * 拉开，看着空。反过来 001《圣哉，圣哉，圣哉》一句 16 格、两句 32 格 > 容量 31，两句一行
 * 就放不下，那首本来也确实是一句一行。
 *
 * 与旧的 `mergeShortLines` 的差别：那个是**逐对局部判**（两行都短于容量六成才并），
 * 同一首里于是有的地方并了、有的地方没并，行长反而更不齐。这里改成**全首一个口径**：
 * 段内从头起两两并，段界处重新起对，段内落单的末行留着。放不放得下由调用方统一验。
 *
 * 只删断点、不新造断点。但**并出来的行末必须仍是乐句边界**——删掉 a 的断点等于让
 * a+b 合成一行，那一行的行末就是 b 的行末，b 收在哪儿决定了并出来好不好看。
 * 096《哈利路亚！感谢主》的「哈利路亚」唱好几遍，某个断点正落在「哈利｜路亚」中间，
 * 一并行就把「哈利」留在了行末。判据是**行末收在标点上、或收在长音上**——
 * 长音收尾（一字多音唱完、行末那个音没有词）同样是乐句的落点，只认标点会把它们也挡掉。
 *
 * @returns 并掉的断点数
 */
export function mergePairsUniform(part: Part, breaks: PhraseBreaks, useMidBreaks: boolean): number {
  const lines = describeLines(part, breaks, useMidBreaks);
  // **先看能不能全首一致地并**：一半并一半不并，行长反而更不齐——020《向主歌唱》
  // 前四行各 4~5 小节没并、末两行并成 8 小节，那一行就明显比谁都长。
  // 并不齐就整档放弃（`chooseLineLayout` 会退到一句一行）。
  const canPairAt = (i: number): boolean => {
    const a = lines[i];
    const b = lines[i + 1];
    if (!b) return false;
    if (a.section) return false;
    if (a.mi !== null && breaks.forced?.has(a.mi)) return false;
    if (a.mi === null && a.chord === null) return false;
    // b 是并出来那一行的行末：它没收在乐句落点上就别并（末行除外，末行本来就是曲末）
    const bIsLast = i + 1 === lines.length - 1;
    // **标点要往前找到那个字**：行末那个音常常是没有词的收尾（拖腔、句末的收气休止），
    // 它自己既没标点也不是长音，可乐句明明收得好好的——312《我真快乐》第 6 行收在
    // 「…平安；」后面那个八分休止上（`tail.punct` 0、`tail.beats` 1），
    // 一条 `canPairAt` 判否，整首八行 2 小节（134 / 312）就全并不成了。
    // 与 096《哈利路亚！感谢主》那个坑不冲突：那里行末的「利」自己带词却没有标点，
    // `lastWordPunct` 照样是 0，仍旧挡得住。
    return bIsLast || b.tail.punct > 0 || b.tail.beats >= 2 || b.tail.lastWordPunct > 0;
  };
  for (let i = 0; i + 1 < lines.length; i += 2) if (!canPairAt(i)) return 0;
  let merged = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const a = lines[i];
    if (a.mi !== null) breaks.measureBreaks.delete(a.mi);
    if (a.chord) breaks.midBreaks.delete(a.chord);
    merged++;
  }
  return merged;
}

/** 一行放不放得下、是不是碎行——`chooseLineLayout` 判「这一档可不可行」的两条。 */
function linesAreOk(lines: LineInfo[], f: Fit): boolean {
  for (let i = 0; i < lines.length; i++) {
    // 「放不放得下」按**真实坐标**判——排版器折不折行看的就是这个（用户口径）
    if (f.on && f.ofLine(lines[i]) >= f.capacity) return false;
    // 中间行只剩一小节（且不足四拍/八拍）= 碎行。末行本来就可以短。
    if (i < lines.length - 1 && !lines[i].section) {
      const l = lines[i];
      if (l.bars <= 1 && l.beats < (l.head.full ? 4 : 8)) return false;
    }
  }
  return true;
}

/** `PhraseBreaks` 的浅拷贝（Chord 引用共享，只复制四个 Set）。 */
function cloneBreaks(b: PhraseBreaks): PhraseBreaks {
  return {
    measureBreaks: new Set(b.measureBreaks),
    midBreaks: new Set(b.midBreaks),
    sectionStarts: new Set(b.sectionStarts),
    sectionCutChords: new Set(b.sectionCutChords),
    cuts: b.cuts,           // 只读的候选断点表，拷贝时共享
    capacityCuts: new Set(b.capacityCuts),
    refrainCut: b.refrainCut,
    forced: new Set(b.forced),
  };
}

/** 在第 mi 小节**之前**断行会不会切断一条圆滑线／连音线／反复房。 */
function cutsThroughSpan(part: Part, mi: number): boolean {
  const ms = part.measures;
  if (mi <= 0 || mi >= ms.length) return false;
  // 反复房：房整体不可拆，只有房的收尾处才能断
  let inEnding = false;
  for (let i = 0; i < mi; i++) {
    if (ms[i].endingLeft) inEnding = true;
    if (ms[i].endingRight !== null) inEnding = false;
  }
  if (inEnding) return true;
  // 弧线：上一小节最后一个和弦起了弧／连音线，而本小节头一个和弦收它
  const prev = chordsOf(ms[mi - 1]);
  const cur = chordsOf(ms[mi]);
  const a = prev[prev.length - 1];
  const b = cur[0];
  if (!a || !b) return false;
  if (a.slurStart && b.slurEnd) return true;
  if (a.notes[0]?.tieStart && b.notes[0]?.tieEnd) return true;
  return false;
}

/**
 * **均匀排版**（C 档）：乐句断点排出来的行放不下版心时的兜底。
 *
 * **不丢开乐句断点**——试过完全按容量机械均分（169《全新的你》排出 13 行、215 甩出一行
 * 只有 9 格），比原样还难看。做法是在乐句断点的基础上收拾两件事：
 *   1. 放不下的行在**行内部**补刀（`applyCapacityCuts`，与 `enforceLineCapacity` 同一份），
 *      落点按乐句凭据 + 工整性挑；会切断圆滑线／反复房的小节线一律不选
 *      ——用户口径「尽量避免 slur/ending 等跨行」；
 *   2. 补出来的**碎行**（只剩一小节）并回上一行。
 * 段界（主歌↔副歌）自始至终保留——「尽量主歌副歌不同行」。
 */
function evenLayout(part: Part, breaks: PhraseBreaks, cells: number, fit?: FitMetric): PhraseBreaks {
  const out = cloneBreaks(breaks);
  if (cells <= 0 || !part.measures.length) return out;
  applyCapacityCuts(part, out, cells, { useMidBreaks: true, avoidSpans: true, fit });
  mergeSliverLines(part, out, true, cells, fit);
  return out;
}

/**
 * **碎行并回上一行**：只剩一小节、又唱不满一句的行（497《这世界非我家》曾切出一行 2 格）。
 *
 * 碎行是**按容量补刀**留下的（`enforceLineCapacity` / `evenLayout` 都按格数均分，
 * 遇上格数分布不均的段就会切出个尾巴），断句本身不会这么断。所以这是一道**收尾**：
 * 排版模式定下来、容量保险也补完刀之后再跑一次。
 *
 * 段界与跳转记号处的断点（`PhraseBreaks.forced`）不动。并过去放不下就维持原判——
 * 宁可留个短行，也别撑爆版心。
 *
 * @param cells 退化时的容量（格数）；有 `fit` 时按**真实坐标**判「并过去放不放得下」
 * @returns 并掉的断点数
 */
export function mergeSliverLines(part: Part, breaks: PhraseBreaks, useMidBreaks: boolean, cells = 0,
                                 fit?: FitMetric): number {
  const lines = describeLines(part, breaks, useMidBreaks);
  const f = new Fit(fit, cells).bind(flattenBook(part));
  let merged = 0;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (prev.section) continue;
    if (cur.bars > 1 || cur.beats >= (cur.head.full ? 4 : 8)) continue;
    if (prev.mi !== null && breaks.forced.has(prev.mi)) continue;
    if (f.on && f.spanOf(prev.from, cur.to) >= f.capacity) continue;   // 并过去放不下就维持原判
    if (prev.mi !== null) breaks.measureBreaks.delete(prev.mi);
    else if (prev.chord) breaks.midBreaks.delete(prev.chord);
    else continue;
    merged++;
  }
  return merged;
}

/**
 * **整首的排版模式阶梯**（成书那条路）。
 *
 * 「排不排得下」只在这里用——断句本身只看内容（见 `phrase.ts::PhraseOptions.contentOnly`）。
 * 按 **B → A → C** 取第一个可行的（原书绝大多数是一行两句，所以两句一行是首选；
 * 一句一行是它放不下时的退让；均匀排版是乐句根本排不下时的兜底）：
 *
 *   B  每 2 句一行（`mergePairsUniform`）
 *   A  按乐句排版（断点原样用）
 *   C  均匀排版（`evenLayout`）
 *
 * 「可行」= 每行都放得下，且中间没有只剩一小节的碎行。
 * 选中的那一档**写回 `breaks`**（原地改，调用方拿到的就是最终断点）。
 *
 * @param cells 一行放得下几格（`browser.ts::measureCellsPerLine` 实测）
 * @returns 选中的档
 */
export function chooseLineLayout(
  part: Part,
  breaks: PhraseBreaks,
  cells: number,
  opt: { useMidBreaks?: boolean; allowPairs?: boolean; fit?: FitMetric } = {},
): "pairs" | "phrase" | "even" {
  const useMidBreaks = opt.useMidBreaks ?? true;
  const allowPairs = opt.allowPairs ?? true;
  const f = new Fit(opt.fit, cells).bind(flattenBook(part));
  const write = (from: PhraseBreaks): void => {
    breaks.measureBreaks.clear();
    for (const v of from.measureBreaks) breaks.measureBreaks.add(v);
    breaks.midBreaks.clear();
    for (const v of from.midBreaks) breaks.midBreaks.add(v);
    // **补刀记号也要写回**：C 档是在克隆上补的刀，不带回来的话 `LineInfo.fromCut` 全是 false，
    // line-check 的 D2 豁免（补刀造出来的行首不算弱起不一致）就永远用不上。
    breaks.capacityCuts.clear();
    for (const v of from.capacityCuts) breaks.capacityCuts.add(v);
  };
  const phrase = cloneBreaks(breaks);
  const phraseLines = describeLines(part, phrase, useMidBreaks);
  // **只在一句一行明显太稀时才考虑两句一行**。用户口径：「排不排得下只用于……是否采用
  // 每 2 句放在一行的按乐句排版」。不设这道闸的话，凡是并得下的都会去并——实测全书
  // 184 首改走 pairs、行数直接减半，那不是「原书一行两句」，那是把谱压扁。
  // 判据取中位行长：多数行还不到版心六成，才说明一句一行确实空。
  const medCells = (() => {
    const cs = phraseLines.map((l) => f.ofLine(l)).sort((x, y) => x - y);
    return cs.length ? cs[Math.floor(cs.length / 2)] : 0;
  })();
  const sparse = f.on && medCells > 0 && medCells < f.capacity * 0.6;
  if (allowPairs && sparse) {
    const pairs = cloneBreaks(breaks);
    // 返回 0 = 并不成（不能全首一致地并），那就不是 pairs 档——原来这里不看返回值，
    // 于是「没并」也被标成 pairs，行数一行没少（全书 40 首都这样）。
    const merged = mergePairsUniform(part, pairs, useMidBreaks);
    // **并完也要真实排一遍**（用户口径：「合并时也真实排一下，如果合并后放不下就保持原版」）
    if (merged > 0 && linesAreOk(describeLines(part, pairs, useMidBreaks), f)) {
      write(pairs);
      return "pairs";
    }
  }
  if (linesAreOk(phraseLines, f)) return "phrase";
  write(evenLayout(part, phrase, cells, opt.fit));
  return "even";
}
