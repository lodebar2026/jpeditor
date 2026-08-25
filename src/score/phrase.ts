// 乐句分析：综合歌词标点 + 音乐信号（延长号/终止线/长音/休止/连线）与「重复旋律」结构，
// 在小节边界上找乐句断点，并凑成不太稀疏也不太密的行长。供 scoreToJpwabc 的乐句排版模式使用。
// 返回 measureBreaks（作为「新行起点」的小节下标，与 Measure.newSystem 同义）与 midBreaks
// （在弱起谱里乐句尾——休止/长音——被并进下一小节时，改在该「行内」和弦后换行；含标点/句号处）。

import { Chord, Part } from "./score";
import { BarStyle } from "./enums";
import { Fraction } from "../common/fraction";

export interface PhraseBreaks {
  measureBreaks: Set<number>; // 小节边界换行：在该下标小节前起新行
  midBreaks: Set<Chord>;      // 行内换行：在该和弦（乐句尾休止/长音）之后换行，不加小节线
  /** 段落（Intro/Verse/Chorus/Coda…）起点的小节下标：这些小节前不但换行，还**另起一页**
   *  ——否则主歌与副歌会挤在同一页上。measureBreaks 是其超集。 */
  sectionStarts: Set<number>;
  /** 段界落在小节内部（弧闭合处）时的断点和弦：在该和弦后换行**并另起一页**。midBreaks 是其超集。 */
  sectionCutChords: Set<Chord>;
  /** 是否已为「副歌起点」安排了段界（含弱起顺延）。jpscore 据此不再自行在副歌首音处断行。 */
  refrainCut: boolean;
}

// 句末 / 句中标点（读 Note.lyrics 原文，未被 jpscore 剥离）。
// 分号并列的是两个完整分句（「…忧伤的权利；我要宣告…」），乐句同样在此收尾 → 与句号同级。
export const PUNCT_END = /[。！？…；]$/;
export const PUNCT_MID = /[，、：]$/;

/** 一个和弦上的「主歌词」（第 1 段或副歌那一条）。断句判据与逐行报告共用同一份取法。 */
export function mainLyricText(c: Chord): string {
  const nt = c.notes[0];
  const l = nt?.lyrics.find((x) => x.number === 1 || x.refrain) ?? nt?.lyrics[0];
  return l?.text ?? "";
}

/** 歌词末尾标点的分量：句末 6 / 句中 4 / 无 0。 */
export function punctScore(text: string): number {
  return PUNCT_END.test(text) ? 6 : PUNCT_MID.test(text) ? 4 : 0;
}

// 行长以「小节数」计（简谱/圣诗按小节成行，与音符密度无关）。经验初值，可回归调参。
const DEF_MIN_MEAS = 3;
const DEF_TARGET_MEAS = 4;
const DEF_MAX_MEAS = 7;
// 但密集小节（如流行敬拜谱副歌每小节 7 个八分音符）光按小节数会排出一行 30 格、超出页宽被迫折行，
// 故再加一条**每行格数**上限。格 = 简谱横向占位：一个音符 1 格，长音的每根增时线 `-` 各占 1 格
// （`5---`=4 格）。实测印刷简谱一行 ~21~23 格。只作上限，不参与行长目标。
// 增时线渲染得比数字窄（`5 - - -` 明显短于 `3 1 2 5`），按 1 整格算会高估长音行的宽度，把
// 「超长音收尾」挤到下一行去（实测副歌 `…手心|中5---|5` 的「中」被甩到行首）。按实测比例折算。
const DEF_MAX_CELLS = 25;
// **一整句独占一行**（行尾恰是句末、行内不跨句末）时，行长上限比普通行放宽——中文简谱里
// 「一行一句」比机械地卡在 25 格 / 7 小节更能体现乐句。实测 33 格 / 8 小节仍排得进版心
//（「我們成為一家人」副歌 `因著耶穌得潔淨，…同享復活的生命；` 8 小节 32.5 格，无头渲染核对过）。
// 超出则回退到普通上限，真正的长句仍会正常分行。
const DEF_MAX_SENTENCE_CELLS = 33;
const DEF_MAX_SENTENCE_MEAS = 8;
// 行长下限也认格数：行从小节中间起头时（前一行在长音 tie 收尾处断），按小节数算会偏小，
// 但内容量其实够——`MIN_MEAS` 与 `MIN_CELLS` 满足其一即可。
const DEF_MIN_CELLS = 14;
// 「这里是乐句收尾」的音乐凭据：够长的长音（≥3 拍）、延长号、休止。作曲家在句子真正收尾处
// 留的音明显比句中的停顿长——「耶稣普治」每句中间的逗号落在 4 拍全音符上，而「我們成為一家人」
// 副歌句中的逗号只有 2 拍、句末才是 4 拍。故 2 拍不算凭据，否则两者分不开。
const LONG_NOTE_BEATS = 3;
// 「前奏/间奏」至少这么多个连续的**无词小节**，其后的交界才算乐句起点
//（按小节而不是按音符：唱段的第一个字常是弱起、写在交界小节的末尾，
//  按音符判会把断点定在那个字之前、把小节劈开；原书是整小节整小节地换行）。
const INTRO_MIN_MEAS = 2;
const DASH_W = 0.7;
const cellsOf = (c: Chord): number => 1 + Math.max(0, Math.floor(c.beats) - 1) * DASH_W;

function chordsOf(m: { entries: unknown[] }): Chord[] {
  return m.entries.filter((e): e is Chord => e instanceof Chord);
}

// 小节旋律指纹：各和弦「音级+八度」（休止记 R），供重复段检测与平行断行复用。
function measureFp(chords: Chord[]): string {
  return chords
    .map((c) => {
      const nt = c.notes[0];
      if (!nt || c.rest) return "R";
      return nt.number + ":" + nt.jpOctave;
    })
    .join(",");
}

/** 行长参数。默认值是拿具体曲子调出来的（见上面各常量的注释），**别随手改默认**；
 *  成书排版要更均匀的行长时按需收紧上限（见 rebuild.mjs）。 */
export interface PhraseOptions {
  targetMeas?: number;
  minMeas?: number;
  maxMeas?: number;
  maxSentenceMeas?: number;
  /** 一行最多几格。**成书排版按纸张宽度算**（版心宽 ÷ 音符步距），
   *  而不是用这里那个按经验定的 25——版心窄的书一行本来就放不下 25 格。 */
  maxCells?: number;
  maxSentenceCells?: number;
  /** 断点强度的权重。调大 = 更看重「断在乐句真正收尾的地方」（长音、延长号、句末标点）。
   *  默认 1 时，断点代价被钳在 0 以上（`max(0, BASE_BREAK − 强度)`），
   *  于是 8 分的强断点和 10 分的更强断点**代价一样**，「更长的音符 + 标点」体现不出优势。
   *  调大之后强断点能挣出净收益（有封顶），乐句收尾处就会压过「各行一样长」。 */
  breakWeight?: number;
  /** 「很短的分句」的字数上限：从上一个标点起唱了这么几个字以内，句末标点的分**减半**
   *  （「哈利路亚！」「阿们！」这类呼语句句带感叹号，与整句同权会主导整个行结构）。
   *  **默认 0 = 关**：编辑器那条路的分行基线是按原权重调出来的；成书排版传 5。 */
  shortSentenceWords?: number;
  /** 重复段边界是否**按重复长度加分**（越长的重复越该整段成行）。默认 false = 一律 +8，
   *  编辑器那条路行为不变；成书排版打开（015《赞美真神》结尾三句「哈利路亚！」）。 */
  repeatLenBonus?: boolean;
  /** 「末两行别一长一短」的权重。一段的最后两行长短悬殊最扎眼（125《主名至宝》、
   *  404《你若不压橄榄成渣》都是倒数第二行短、末行长），而普通的行长代价管不到它——
   *  末行本来就允许短。默认 1；0 = 关。 */
  lastPairWeight?: number;
  /** 行长代价的权重。调大 = 更看重「各行一样长」。
   *  默认 1 是编辑器那条路调出来的；成书要工整的行长，调到 2 以上，
   *  16 小节的歌才会选 4+4+4+4 而不是 4+6+6（后者行长代价 8，但少断一次省 8 分，默认权重下打平）。
   *  **`targetMeas` 由容量折算时要反过来调小**（成书那条路 0.25）：目标行长已经就是版心宽，
   *  行长代价再重就会压过「断在乐句收尾处」，把行末从标点上挪走（实测全书行末收标点 94% → 81%）。 */
  lenWeight?: number;
}

/**
 * 一行放得下 `cells` 格时，行长目标该定几小节。
 *
 * 行长目标本来是个固定的小节数（4），靠排完再两两并短行去凑满版心；但**并行只能成对**，
 * 一段里落单的那一行就并不进去，于是同一首里会出现一行 12 小节、下一行 6 小节
 * （377《我宁愿有耶稣》副歌）。目标直接按容量定，DP 一次就能挑中那个最强的断点
 * （该曲副歌「…所苦害，」的长音 tie 收尾，强度 22，是全段最高的）。
 *
 * 「一小节几格」随拍号与音符密度而变（005 每小节 3.2 格、001 每小节 4 格），所以要按本曲实测。
 */
export function targetMeasForCells(part: Part, cells: number): number {
  let tot = 0;
  let nm = 0;
  for (const m of part.measures) {
    nm++;
    for (const c of chordsOf(m)) tot += cellsOf(c);
  }
  if (!nm || !(cells > 0)) return DEF_TARGET_MEAS;
  return Math.max(3, Math.min(12, Math.round(cells / Math.max(0.5, tot / nm))));
}

export function computePhraseBreaks(part: Part, opts: PhraseOptions = {}): PhraseBreaks {
  const TARGET_MEAS = opts.targetMeas ?? DEF_TARGET_MEAS;
  const MIN_MEAS = opts.minMeas ?? DEF_MIN_MEAS;
  // 目标行长由容量折算过来（成书那条路）时，上限跟着目标走——固定的 7 / 8 小节是按
  // 「目标 4 小节」调出来的，配上 9 小节的目标就成了硬顶，DP 只能改断在别处。
  const scaled = opts.targetMeas !== undefined && opts.targetMeas > DEF_TARGET_MEAS;
  const MAX_MEAS = opts.maxMeas ?? (scaled ? Math.round(TARGET_MEAS * 1.3) : DEF_MAX_MEAS);
  const MAX_SENTENCE_MEAS = opts.maxSentenceMeas ?? (scaled ? Math.round(TARGET_MEAS * 1.4) : DEF_MAX_SENTENCE_MEAS);
  const MAX_CELLS = opts.maxCells ?? DEF_MAX_CELLS;
  const MAX_SENTENCE_CELLS = opts.maxSentenceCells ?? Math.max(DEF_MAX_SENTENCE_CELLS, MAX_CELLS);
  const LEN_WEIGHT = opts.lenWeight ?? 1;
  const SHORT_WORDS = opts.shortSentenceWords ?? 0;
  const REPEAT_LEN_BONUS = opts.repeatLenBonus ?? false;
  const BREAK_WEIGHT = opts.breakWeight ?? 1;
  const LAST_PAIR_WEIGHT = opts.lastPairWeight ?? 1;
  // 行长下限跟着上限走：版心窄时上限本来就小，14 格的下限会把断点全顶掉
  const MIN_CELLS = Math.min(DEF_MIN_CELLS, Math.round(MAX_CELLS * 0.6));
  const measures = part.measures;
  const n = measures.length;
  const measureBreaks = new Set<number>();
  const midBreaks = new Set<Chord>();
  const sectionStarts = new Set<number>();
  const sectionCutChords = new Set<Chord>();
  let refrainCut = false;
  if (n <= 1) return { measureBreaks, midBreaks, sectionStarts, sectionCutChords, refrainCut };

  const chordsPer = measures.map((m) => chordsOf(m));
  const fpPer = chordsPer.map((cs) => measureFp(cs));

  // 每小节的歌词指纹（第 1 段/副歌词）：**重复的歌词**同样是段落信号（副歌唱词一字不差地再来一遍），
  // 且在旋律略有出入时仍然稳。与旋律指纹各自独立找重复。
  const lyrPer = chordsPer.map((cs) => cs.map(mainLyricText).join(""));

  // 重复旋律/歌词：按位移 d 扫出**极大**重复连续段（长度 ≥2 小节），其两端加为断点边界。
  // 极大性很重要：逐个长度 L 枚举会把所有子段的边界也塞进来，遍地边界等于没有边界。
  // 小节下标 i → 「i 之后是重复段边界」，值是该重复段有多长（小节数）。
  // **长度要记下来**：重复越长，这个边界作为行首/行末就越有说服力。015《赞美真神》
  // 结尾三句「哈利路亚！」，按句末感叹号断会切在第一句之后，而按更长的那段重复断，
  // 第 2、4 行的开头就都是同一段旋律、对齐得上（用户口径：「2、4 行的开头重复长度值更大」）。
  const repeatEdges = new Map<number, number>();
  const markRepeats = (fp: string[]) => {
    const mark = (i: number, len: number) => repeatEdges.set(i, Math.max(repeatEdges.get(i) ?? 0, len));
    for (let d = 1; d < n; d++) {
      let i = 0;
      while (i + d < n) {
        if (!fp[i] || fp[i] !== fp[i + d]) { i++; continue; }
        let j = i;
        while (j + d < n && fp[j] && fp[j] === fp[j + d]) j++;   // [i,j) 与 [i+d,j+d) 逐节相同
        if (j - i >= 2) {
          const len = j - i;
          mark(i - 1, len); mark(j - 1, len);
          mark(i + d - 1, len); mark(j + d - 1, len);
        }
        i = j;
      }
    }
  };
  markRepeats(fpPer);
  markRepeats(lyrPer);

  // 每小节实际时值（各和弦时值之和，弱起/末小节都稳）；用于把绝对位置换算成「小节数」（单位无关）。
  const measureDur = chordsPer.map((cs) => cs.reduce((s, c) => s + (c.duration?.toFloat() ?? 0), 0) || 1);

  // 把所有和弦拍平成有序序列，逐和弦记：所在小节、是否小节末、以「小节数」为单位的结束位置（可含小数）。
  interface CInfo { chord: Chord; mi: number; isLast: boolean; pos: number; }
  const flat: CInfo[] = [];
  for (let i = 0; i < n; i++) {
    const cs = chordsPer[i];
    for (let k = 0; k < cs.length; k++) {
      const c = cs[k];
      const within = c.position.plus(c.duration ?? new Fraction(0)).toFloat() / measureDur[i];
      flat.push({ chord: c, mi: i, isLast: k === cs.length - 1, pos: i + Math.min(1, within) });
    }
  }
  const K = flat.length;
  if (K === 0) return { measureBreaks, midBreaks, sectionStarts, sectionCutChords, refrainCut };

  // slur/tie 括号**先做栈式配对**：识别(OMR)或原谱本身都可能给出不成对的弧（漏检一端）。若照单全收，
  // 一个悬空的起始就让此后 depth 永不归零 → 整曲再无候选断点、乐句排版退化成一整行（实测「主祢真伟大」
  // 第 13 小节起全被封锁）。故未配对的起始/收尾一律不计深度。同一和弦先收尾后起始，避免自我配对。
  const okStart = new Array<number>(K).fill(0);
  const okEnd = new Array<number>(K).fill(0);
  const tieFrom = new Array<number>(K).fill(-1); // 弧收尾 → 其起点下标（把起点的长音信号带过来）
  {
    const stack: number[] = [];
    for (let idx = 0; idx < K; idx++) {
      const c = flat[idx].chord;
      const nt = c.notes[0];
      const nE = (nt?.tieEnd ? 1 : 0) + (c.slurEnd ? 1 : 0);
      const nS = (nt?.tieStart ? 1 : 0) + (c.slurStart ? 1 : 0);
      for (let k = 0; k < nE; k++) {
        const s = stack.pop();
        if (s === undefined) break;   // 孤立收尾：无视
        okStart[s]++; okEnd[idx]++;
        if (tieFrom[idx] < 0 || flat[s].chord.beats > flat[tieFrom[idx]].chord.beats) tieFrom[idx] = s;
      }
      for (let k = 0; k < nS; k++) stack.push(idx);
    }
  }

  // 逐和弦：slur+tie 括号深度（>0 不可断，否则拆断 ( )）；歌词标点分「顺延」到其所在 slur/tie 组收尾、
  // 并越过紧随的休止（句号音符后常带休止，断点应落在休止之后，如基督更美的 1 0）→ 归到该可断和弦。
  const depthAfter = new Array<number>(K).fill(0);
  const punctAfter = new Array<number>(K).fill(0);
  // 标点顺延过来的源头（那个带标点的音符）。乐句在那里收尾、断点落在尾随的休止上，
  // 两者是**同一个收尾**，强度要一起算（见 scoreAt）。
  const carriedFrom = new Array<number>(K).fill(-1);
  {
    let depth = 0;
    let pending = 0;
    let pendingFrom = -1;
    let sinceLastPunct = 0; // 上一个标点之后唱了几个字
    for (let idx = 0; idx < K; idx++) {
      const c = flat[idx].chord;
      depth += okStart[idx];
      const txt = mainLyricText(c);
      if (txt) sinceLastPunct++;
      let p = punctScore(txt);
      // **很短的分句减半**：「哈利路亚！」「阿们！」这种呼语句句带感叹号，若与整句同权，
      // 连着三句就断出三个满分断点，行结构反而被它们主导
      //（015《赞美真神》结尾三句「哈利路亚！」，按句末断会把第一句留在上一行、
      //  与第 2 行开头那段更长的重复旋律对不齐）。短句仍是断点，只是让位给更长的乐句信号。
      if (p > 0 && sinceLastPunct <= SHORT_WORDS) p = Math.round(p / 2);
      if (txt && p > 0) sinceLastPunct = 0;
      if (p > pending) { pending = p; pendingFrom = idx; }
      depth -= okEnd[idx];
      depthAfter[idx] = depth;
      // 顺延规则：仅当「本音符是音符且其后紧跟本小节内的休止」时继续顺延（句号音符尾随的休止就是落点）；
      // 一旦到了休止本身就在此落定，不再卷入随后的八分弱起休止（世上句号后 0 落定、不吞下一句 0_）。
      // **八分休止也顺延**：句子收尾的长音后面跟半拍休止、再接下一句的弱起（372《跟随耶稣》的
      // `…呼，| 0_ 今. 已_ |`）时，断点该落在休止之后——否则那半拍休止挂在下一行行首，
      // 四行的弱起就长短不一。休止之后再跟休止仍在原处落定（上面那条不变）。
      const next = flat[idx + 1];
      const carryOn = !c.rest && !!next && next.chord.rest && next.mi === flat[idx].mi;
      if (depth === 0 && !carryOn) {
        punctAfter[idx] = pending;
        if (pending > 0 && pendingFrom >= 0 && pendingFrom !== idx) carriedFrom[idx] = pendingFrom;
        pending = 0;
        pendingFrom = -1;
      }
    }
  }

  // 重复边界（小节下标）→ 实际断点的 flat 下标。边界之后若紧跟一个**长音 tie/slur 组**
  // （如 `…3 5 |(5--- |5) 0…` 里的 `5---|5`），那是上一乐句的延音收尾、歌词也还是上一句的末字，
  // 不该充当新乐句的开头 → 把边界顺延到该弧闭合之后。第 1 页的段界同样这么顺延，两处behavior一致。
  const advancePastLongTie = (from: number): number => {
    let idx = from;
    while (idx + 1 < K && okStart[idx + 1] > 0 && flat[idx + 1].chord.beats >= 2) {
      let j = idx + 1;
      while (j < K && depthAfter[j] !== 0) j++;
      if (j >= K || j === idx) break;
      idx = j;
    }
    return idx;
  };
  // 反过来，重复段的起句常是**弱起**：第二遍的第一个音写在上一小节末，边界压在它之后就把
  // 那个弱起音留在了上一行（009《荣耀归与至高神》的 `…天下万有赞祂不休， | 天上众军…`：
  // 「天」是下一句的第一个字，却被留在行尾，「天上」被拆开）。往前找最多两个音，
  // 那里若有句读标点就把边界移过去——断在标点上，两句相同的旋律也各自从行首起唱。
  // 只跨得过**短音**：一旦遇上长音，那是上一句的收尾，边界本就该落在它之后。
  const retreatToPunct = (from: number): number => {
    for (let j = from - 1; j >= 0 && from - j <= 2; j--) {
      if (depthAfter[j] !== 0) break;
      if (punctAfter[j] > 0) return j;
      if (flat[j].chord.beats > 1) break;
    }
    return from;
  };
  const repeatBreakIdx = new Map<number, number>(); // flat 下标 → 重复段长度（小节）
  for (const [mi, len] of repeatEdges) {
    const idx = flat.findIndex((f) => f.isLast && f.mi === mi);
    if (idx < 0) continue;
    const at = retreatToPunct(advancePastLongTie(idx));
    repeatBreakIdx.set(at, Math.max(repeatBreakIdx.get(at) ?? 0, len));
  }

  // 反复房（ending / volta）**整体不可拆**：房是「这一遍才唱的那几小节」，
  // 断在房中间，反复记号与房号就没法画了，唱的人也读不出这是同一个房
  //（010《愿祢崇高》的第一房只有一小节 `苍。我要`，断点落在「苍。」后面就把它劈成了两行）。
  // 只有房的**最后一个小节末**可断——那里正是 `:‖` 或房的收尾。
  const inEnding = new Array<boolean>(n).fill(false);
  const endingLast = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (!measures[i].endingLeft) continue;
    // 房的收尾：`<ending type="stop|discontinue">`。**没闭合的不算房**——
    // OMR 识别出的谱常只认出房号的一端，把「开着的房」一路认到曲末，
    // 那样整首都成了不可断区（15 首基线里「爱是不保留」「沧海一声笑」就是这样被封死的）。
    // 同样地，房也不该长得离谱：超过 MAX_MEAS 就当它不是房。
    let j = i;
    while (j < n && measures[j].endingRight === null && (j === i || !measures[j].endingLeft)) j++;
    if (j >= n || measures[j].endingRight === null) continue;
    if (j - i > MAX_MEAS) continue;
    for (let k = i; k <= j; k++) inEnding[k] = true;
    endingLast[j] = true;
    i = j;
  }

  // 「本曲的弱起有多长」：首小节不完整时就是它的时值，否则没有弱起（0）。
  // 各行的行首残小节都照这个长度来，四行才齐头（372《跟随耶稣》：弱起 1 拍，
  // 第 2/4 行却从「八分休止 + 弱起」1.5 拍起头）。
  const fullMeasure = Math.max(...measureDur);
  const pickupStd = measureDur[0] < fullMeasure - 1e-6 ? measureDur[0] : 0;

  /**
   * **断点之后那一行的行首长什么样**——不好看就罚。判据只看断点后紧跟的那点内容，
   * 所以每个候选断点一次算好。三条（都是拿具体曲子换来的，别随手动）：
   *   (a) 行首残小节里一个音符都没有（半小节休止 + 小节线）：一行开头是个空拍，
   *       唱的人不知道要等谁（020）。整小节的休止不在此列——整节归上一行或下一行都行。
   *   (b) 行首残小节与本曲的弱起不一样长：四行齐头才工整（372/402）。
   *   (c) 行首是「带句读标点的长音」：那是上一句真正的收尾，该留在上一行（373《跟随我》，
   *       每行都该收在「跟随我，」的长音上）。
   * 罚而不是禁：这一行放不下时 DP 会自己改在别处断，不至于整段无解。
   */
  const headPenalty = (idx: number): number => {
    const nx = flat[idx + 1];
    if (!nx) return 0;
    let head = 0;   // 行首残小节的**时值**（Chord.beats 是增时线格数，不是时值）
    let hasNote = false;
    for (let j = idx + 1; j < K && flat[j].mi === nx.mi; j++) {
      head += flat[j].chord.duration?.toFloat() ?? 0;
      if (!flat[j].chord.rest) hasNote = true;
      if (flat[j].isLast) break;
    }
    const partial = !(nx.chord === chordsPer[nx.mi][0]);
    let s = 0;
    if (!hasNote && partial) s += 12;
    // 行首是**半拍及以下的休止**：那是下一句起唱前的留白，本该留在上一行行尾。
    // 但「半拍休止 + 半拍音符」这种弱起本身没问题——只要它与本曲的弱起一样长就不罚
    //（用户口径：为了工整，各行都以同样长的不完整小节起头是对的）。
    // 四分及以上的休止不在此列：那是上一句唱完的收气，本来就该留在上一行（见 retreatPastPickupRest）。
    const headRest = nx.chord.rest ? (nx.chord.duration?.toFloat() ?? 0) : 0;
    if (headRest > 0 && headRest <= 0.5 && Math.abs(head - pickupStd) > 0.01) s += 8;
    // 长音起头本身就不对：乐句是从短音起唱的，行首那个长音多半是上一句的延音收尾
    //（15 首基线里「一生中最可 / 贵」就是这么把词劈开的）。带标点的更是明摆着的收尾。
    if (nx.chord.beats >= 2 && punctScore(mainLyricText(nx.chord)) > 0) s += 10;
    return s;
  };

  // 断点候选的乐句强度分（在该和弦之后换行）。
  const scoreAt = (idx: number): number => {
    const ci = flat[idx];
    const c = ci.chord;
    let s = punctAfter[idx]; // 句号 6 / 逗号 4（已顺延到 slur/tie/休止 收尾）
    if (c.fermata) s += 5;
    if (c.beats >= 2) s += 4;              // 长音收尾
    // 标点是从前面那个长音顺延过来的（`5--- 0_` 这种收尾）：乐句在那里收尾、
    // 断点落在尾随的休止上，长音的分要带过来——否则「断在长音后」比「断在休止后」还便宜，
    // 那半拍休止就挂到了下一行行首（372《跟随耶稣》第 2/4 行）。
    if (carriedFrom[idx] >= 0 && flat[carriedFrom[idx]].chord.beats >= 2) s += 4;
    if (c.rest && c.beams === 0) s += 1;   // 四分及以上休止（弱信号）
    // 圆滑线/连音线刚收尾（一字多音唱完）：本身是弱信号，主要为让它**进入候选**——密集副歌里小节末
    // 全被跨小节的弧封锁时，这是唯一能切开长行的地方。但若它收的是一个**长音**（`5---|5)` 这种
    // tie 延续），乐句实际就在这里收尾，把长音的分带过来：长音落在小节内，断点自然也在小节内。
    // **前奏/间奏与唱段的交界**：连着好几个音都没有歌词（前奏、间奏、尾奏），
    // 其后第一个有词的音是新乐句的起唱——断在交界上，前奏独占一行、唱词从行首起
    //（028《全然向祢》的前奏 4 小节，不断在这里就会把弱起的「当」拽到前奏那一行行尾）。
    // 要求无词段够长（≥2 个整小节），否则一字多音（melisma）的收尾处处都成断点。
    if (ci.isLast && lyrPer[ci.mi] === "" && ci.mi + 1 < n && lyrPer[ci.mi + 1] !== "") {
      let run = 0;
      for (let j = ci.mi; j >= 0 && lyrPer[j] === "" && run < INTRO_MIN_MEAS; j--) run++;
      if (run >= INTRO_MIN_MEAS) s += 6;
    }
    if (okEnd[idx] > 0) {
      s += 1;
      const st = tieFrom[idx];
      if (st >= 0 && flat[st].chord.beats >= 2) s += 4;
    }
    if (ci.isLast) {
      const m = measures[ci.mi];
      if (m.repeatBackward || m.barline === BarStyle.LIGHT_HEAVY || m.barline === BarStyle.LIGHT_LIGHT) s += 5;
      // 房（ending）收尾：房整体不可拆，那么房的末尾就是天然的换行处——
      // 下一个房从行首起唱，反复记号与房号也才画得完整。
      if (endingLast[ci.mi]) s += 6;
    }
    // 重复段边界**优先作行首/行末**：重复的乐句排在相同的行结构里是简谱排版的惯例，
    // 也最贴近原谱分行。两小节的重复给到 BASE_BREAK 满分（在这里断行完全免罚），
    // **更长的重复再往上加**——重复得越长，把它整段排成一行就越值，
    // 值得压过「在句末标点上断」（015 结尾那三句「哈利路亚！」）。
    const rep = repeatBreakIdx.get(idx);
    // 封顶 10：再往上就会盖过「句末长音」（`6 + 4`）那种最硬的乐句收尾，
    // 把下一句的弱起拽到上一行行尾（15 首基线里「爱是不保留」的「惟求」就是这么被拽走的）。
    if (rep !== undefined) s += REPEAT_LEN_BONUS ? Math.min(10, 6 + rep) : 8;
    return s;
  };

  // 候选断点：括号闭合（depth 0）且「小节末」或「带乐句信号」的和弦；末音强制入选（曲末）。
  const cand: number[] = [];
  for (let idx = 0; idx < K; idx++) {
    if (depthAfter[idx] !== 0) continue;
    const mi = flat[idx].mi;
    if (inEnding[mi] && !(flat[idx].isLast && endingLast[mi])) continue;
    if (flat[idx].isLast || scoreAt(idx) > 0) cand.push(idx);
  }
  if (cand[cand.length - 1] !== K - 1) cand.push(K - 1);

  // 段落标记（Intro/Verse/Chorus/Coda…）：段首必起新行，且**每段独立排行长**——否则 DP 会为了
  // 凑均匀行长把上一段末尾与本段开头并进同一行，段落结构在排版上就看不出来了。
  const sectionMi = [...Array(n).keys()].filter((mi) => mi > 0 && measures[mi].sectionMark);
  // 段落标题/反复线有时与真实歌词段界错开 1~2 个短音：可能是新段弱起仍写在上一小节末，也可能是
  // 上一句收尾占了新小节开头。向两侧找最近句号，把弱起放进下一段、上一句收尾留在上一段。
  // 断点若落在**八分及更短的休止**上，那是新段弱起的起拍留白（「再次将我更新」副歌前的
  // `(2'-) 0_ 5_ 1'_ 2'_ |3'.`：休止与其后三个八分音是同一个弱起组），它属下一句，挂在上一行
  // 行尾（尤其是页尾）很难看 → 回退到休止之前。四分及以上休止相反，是上一句唱完的收气
  //（「基督更美」的 `1 0`、「世上所有的民族」句号后的 `0`），仍留在上一行。
  const retreatPastPickupRest = (at: number): number => {
    // 休止本身就收在小节线上时**不回退**：回退过去下一行就成了「半小节休止 + 小节线」，
    // 一行只有一个空拍（020《向主歌唱》第 4 行就是这么来的）。弱起留白的前提是
    // 那个休止后面还跟着同一小节里的起唱音。
    if (flat[at].isLast) return at;
    let idx = at;
    while (idx >= 0 && flat[idx].chord.rest && flat[idx].chord.beams > 0) idx--;
    return idx >= 0 && idx !== at && depthAfter[idx] === 0 ? idx : at; // 回退处在弧中不可断 → 维持原判
  };
  const aroundSectionPickup = (at0: number): number => {
    const at = retreatPastPickupRest(at0);
    // 段落标题通常标在新小节上方，但上一句的收尾偶尔占了新小节开头 1~2 个短音（「脚步」的
    // `| 路。 求给我…`）。这种情况应在句号后切段，而不是把「路。」放到副歌新页行首。
    let leadingChords = 0;
    for (let idx = at + 1; idx < K && idx <= at + 3; idx++) {
      const c = flat[idx].chord;
      if (c.beats > 1) break;
      if (!c.rest) leadingChords++;
      if (punctAfter[idx] === 6 && leadingChords > 0 && leadingChords <= 2) return idx;
      if (leadingChords > 2) break;
    }
    // 反过来，新段的弱起可能长达 3 个短音（「立定心志」的 `…路亚！ 我立定|心志，一生赞美你…`：
    // 副歌唱词从「心志」起标，但乐句实际从「我立定」起唱）。弱起放宽到 3 个音，段界就落在
    // 「亚！」的长音之后，副歌整句留在新页行首，也不会甩出「我立定」这样一行。
    let pickupChords = 0;
    for (let idx = at; idx >= 0 && at - idx <= 3; idx--) {
      if (punctAfter[idx] === 6 && pickupChords > 0 && pickupChords <= 3) return idx;
      const c = flat[idx].chord;
      if (c.beats > 1) break;
      if (!c.rest) pickupChords++;
      if (pickupChords > 3) break;
    }
    return at;
  };
  // 段界落在段首小节前；那里若 slur/tie 未闭合（长音 tie 连到段首音，如「主祢真伟大」的
  // `5__|5---|5`）就**顺延到弧闭合处**——把延续音留在上一页，弧才画得完整（跨页的弧渲染不出来）。
  // 顺延只到弧闭合，不再往后凑整小节：段首小节就此被拆成两半，新段从半个小节起头，但段落的
  // 起句（超长音收尾之后、重复段的第一个音）留在了本该在的地方。
  const sectionCutIdx = new Map<number, number>(); // 段首小节 → 断点的 flat 下标（在其后换行）
  for (const mi of sectionMi) {
    const at = flat.findIndex((f) => f.isLast && f.mi === mi - 1);
    if (at < 0) continue;
    let idx = at;
    while (idx < K && depthAfter[idx] !== 0) idx++;
    // 段首小节的头一个音若是上一乐句的**长音收尾**（「立定心志」的 `…哈利路|(2'- 2'_) 我立定|心志…`：
    // Chorus 标在长音「亚！」那一小节上），它属于上一句 → 与重复边界同样顺延到弧闭合之后。
    idx = advancePastLongTie(idx);
    idx = aroundSectionPickup(idx);
    if (idx < K) sectionCutIdx.set(mi, idx);
  }
  // 副歌（refrain）起点同样是段界：jpscore 会在它之前**强制断行并另起一页**（主歌/副歌分页）。
  // phrase 若不知情，就会按自己的乐句信号在别处断，两者叠加把中间那点内容甩成孤零零的一行
  //（实测「从前所珍爱」：phrase 断在长音 `2-` 后，jpscore 又断在其后的 `0` 后 → 一行只剩一个休止）。
  {
    let sawVerse = false, refrainIdx = -1;
    outer: for (let idx = 0; idx < K; idx++) {
      for (const nt of flat[idx].chord.notes) {
        for (const lrc of nt.lyrics) {
          if (lrc.text.length === 0) continue;
          if (!lrc.refrain) { sawVerse = true; continue; }   // 与 jpscore::firstRefrainChord 同样的两道护栏：
          if (!sawVerse) continue;                            // ① 须在主歌之后（单段谱会被整首标成 refrain）
          if (K - idx >= Math.max(8, K / 8)) refrainIdx = idx; // ② 副歌须有份量，否则不算
          break outer;
        }
      }
    }
    if (refrainIdx > 0) {
      sectionCutIdx.set(flat[refrainIdx].mi, aroundSectionPickup(refrainIdx - 1));
      refrainCut = true;
    }
  }

  // 顺延后的位置不一定在候选里（弧闭合处未必带乐句信号）→ 补进去。只对段界破例，普通断点仍不拆弧。
  for (const idx of new Set(sectionCutIdx.values())) {
    if (cand.includes(idx)) continue;
    const at = cand.findIndex((c) => c > idx);
    cand.splice(at < 0 ? cand.length : at, 0, idx);
  }
  const M = cand.length;

  const sectionCuts: number[] = [];
  for (const [, idx] of sectionCutIdx) {
    const b = cand.indexOf(idx);
    if (b < 0) continue;
    sectionCuts.push(b + 1); // dp 下标 = cand 下标 + 1
    if (flat[idx].isLast) sectionStarts.add(flat[idx].mi + 1);
    else sectionCutChords.add(flat[idx].chord);
  }

  // 全局 DP（类 Knuth-Plass）：行长以「小节数」计（含小数，跨弱起/切分仍准），
  // 最小化 Σ(行长偏差² + 断点弱罚)。断点可落在小节中间（如句号在小节内的 slur/tie 收尾）。
  const ends = [0, ...cand.map((i) => flat[i].pos)]; // ends[0]=曲首；断点 b∈1..M 对应 cand[b-1]
  const idxAt = [-1, ...cand];                       // idxAt[b]=断点在 flat 中的下标（0=曲首之前）
  const cellsUpto = new Array<number>(K + 1).fill(0); // 前缀格数：cellsUpto[i]=前 i 个和弦占的格数
  for (let i = 0; i < K; i++) cellsUpto[i + 1] = cellsUpto[i] + cellsOf(flat[i].chord);
  const cellsBetween = (a: number, b: number) => cellsUpto[idxAt[b] + 1] - cellsUpto[idxAt[a] + 1];
  // 完整句末的前缀计数。仅提高「跨过句末、把下一句弱起塞到本行」的代价；若断点本身就在
  // 句末则不罚。这样 `…便要走！ 而…`、`…长存不朽！ 谁人…` 会优先在 `！` 后换行，
  // 同时很短的句子仍可在行长收益足够大时合排，不把句末标点做成绝对硬断点。
  const endPunctUpto = new Array<number>(K + 1).fill(0);
  for (let i = 0; i < K; i++) endPunctUpto[i + 1] = endPunctUpto[i] + (punctAfter[i] === 6 ? 1 : 0);
  const crossedEndPunct = (a: number, b: number): number =>
    endPunctUpto[idxAt[b]] - endPunctUpto[idxAt[a] + 1];
  const INF = Number.POSITIVE_INFINITY;
  const BASE_BREAK = 8;
  const CROSSED_END_PUNCT_COST = 4;
  const SPLIT_SHORT_SENTENCE_COST = 24;
  // 行长约束一律是**软惩罚**而非硬禁：可断点稀疏时（弧线跨小节连成一片，如「主祢真伟大」副歌
  // 每小节末都在 slur 内）硬禁会让整段找不到任何合法切法、退化成一整行。软罚则总能挑出最不坏的一种。
  const lenCost = (meas: number, cells: number, segEnd: boolean, maxCells = MAX_CELLS, maxMeas = MAX_MEAS): number =>
    LEN_WEIGHT * (meas - TARGET_MEAS) ** 2 +
    (meas > maxMeas ? (meas - maxMeas) ** 2 * 40 : 0) +
    (cells > maxCells ? (cells - maxCells) ** 2 * 8 : 0) +
    // 段末/曲末行是唯一可短于 MIN 的行，但也**不该短到只剩一小节**——软罚让 DP 宁可把前面几行
    // 各让出一点，也别甩出一个孤零零的尾巴（"不要有只有一节的情况"）。
    (segEnd && meas < MIN_MEAS ? (MIN_MEAS - meas) ** 2 * 10 : 0) +
    // 「尾巴太短」在小节短促的谱上按小节数量不出来：「基督更美」每小节才 4 格，末行 3 小节
    // 合规、实则只有 7.7 格（同曲其余行 15.7）。故段末行的下限也认格数，与非段末行的 MIN_CELLS
    // 同一口径——非段末行是硬约束，段末行仍只软罚（末行本来就可以短一些）。
    (segEnd && cells < MIN_CELLS ? (MIN_CELLS - cells) ** 2 : 0);

  const dp = new Array<number>(M + 1).fill(INF);
  const nextB = new Array<number>(M + 1).fill(-1);
  // 按段界把 [0,M] 切成若干闭区间，逐段跑同一套 DP：段末等同曲末（末行可短、无断点罚）。
  const cuts = [0, ...new Set(sectionCuts)].sort((p, q) => p - q);
  if (cuts[cuts.length - 1] !== M) cuts.push(M);
  dp[M] = 0;
  for (let s = cuts.length - 1; s >= 1; s--) {
    // 段末 dp[hi] 已就绪：末段是曲末 dp[M]=0，其余在后一段里作为起点算过。
    const lo = cuts[s - 1], hi = cuts[s];
    for (let a = hi - 1; a >= lo; a--) {
      for (let b = a + 1; b <= hi; b++) {
        const meas = ends[b] - ends[a], cells = cellsBetween(a, b);
        // 扫描上界（两者随 b 单调增）：放到软限的两倍，超出必然亏本，不必再算。
        if (b > a + 1 && (meas > MAX_MEAS * 2 || cells > MAX_CELLS * 2)) break;
        if (b < hi && meas < MIN_MEAS && cells < MIN_CELLS) continue; // 只有段末/曲末行可短
        // 断点罚：乐句信号越强越便宜；**行内断点（非小节末）另加重罚** —— 简谱通常在小节线处换行，
        // 行内断只该用在乐句尾恰落小节内（句号/长音，那时 scoreAt 高足以抵消）或实在别无选择时。
        // 行内罚只压**弱信号**的行内断点：句号/长音/延长号/重复边界（score≥4）落在小节内时，
        // 那本就是乐句真正的收尾处，不该因为「没赶上小节线」被罚。
        const sc = b === hi ? 0 : scoreAt(cand[b - 1]);
        // 强断点可以挣出净收益（封顶 BASE_BREAK，免得一路狂断）；BREAK_WEIGHT=1 时
        // 退化成原来的 max(0, …)，编辑器那条路的行为不变。
        const bc = b === hi ? 0
          : Math.max(0, BASE_BREAK - sc * BREAK_WEIGHT) +
            (flat[cand[b - 1]].isLast || sc >= 4 ? 0 : 6) +
            headPenalty(cand[b - 1]);
        const crossed = crossedEndPunct(a, b);
        const endsAtSentence = punctAfter[idxAt[b]] === 6;
        // 若从本行起点继续到下一个句号仍不超过「完整句」宽度，就不要提前在逗号/弱音乐信号处拆开。
        // 超过该宽度则不罚，长句仍可正常分行。
        let splitSentence = 0;
        if (b < hi && !endsAtSentence) {
          // 断点处有没有「乐句在此收尾」的音乐凭据：够长的长音、延长号、休止。**歌词逗号不算凭据**
          // ——一句话的内部本来就有逗号，拿它当凭据等于允许任意在句中拆行。有凭据就照拆（作曲家
          // 确实在这里留了气口，如「耶稣普治」每句中间那个 4 拍全音符、「世上所有的民族」的休止）；
          // 没凭据（只是个 2 拍音）则宁可让整句留在一行。
          const bi = idxAt[b];
          const softCut = flat[bi].chord.beats < LONG_NOTE_BEATS && !flat[bi].chord.fermata && !flat[bi].chord.rest;
          for (let p = idxAt[b] + 1; p <= idxAt[hi]; p++) {
            if (punctAfter[p] !== 6) continue;
            const sentenceCells = cellsUpto[p + 1] - cellsUpto[idxAt[a] + 1];
            const sentenceMeas = flat[p].pos - ends[a];
            // 一句话只要放得下（MAX_SENTENCE_MEAS 小节 / MAX_SENTENCE_CELLS 格）就整句成行。
            if (softCut && sentenceCells <= MAX_SENTENCE_CELLS && sentenceMeas <= MAX_SENTENCE_MEAS) {
              splitSentence = SPLIT_SHORT_SENTENCE_COST;
            }
            break;
          }
        }
        // 「整句独占一行」（行尾恰是句末、行内不跨句末）可比普通行宽一些、长一些。
        const wholeSentence = endsAtSentence && crossed === 0 && meas <= MAX_SENTENCE_MEAS && cells <= MAX_SENTENCE_CELLS;
        const lineMaxCells = wholeSentence ? MAX_SENTENCE_CELLS : MAX_CELLS;
        const lineMaxMeas = wholeSentence ? MAX_SENTENCE_MEAS : MAX_MEAS;
        // **末两行别一长一短**：DP 是倒着算的，评估 a→b 时 `nextB[b]` 已经定了，
        // 所以这里看得到「在 b 断的话末行会有多长」。差得越多罚得越狠（封顶，免得压过乐句信号）。
        // 是个前瞻启发式（b 的后续选择理论上还会变），但实测就是它把 125/404 的
        // 「倒数第二行短、末行长」摆平的。
        const lastPair = b < hi && nextB[b] === hi
          ? Math.min(40, LAST_PAIR_WEIGHT * (meas - (ends[hi] - ends[b])) ** 2)
          : 0;
        const cost = lenCost(meas, cells, b === hi, lineMaxCells, lineMaxMeas) + bc + splitSentence +
          lastPair + crossed * CROSSED_END_PUNCT_COST + dp[b];
        if (cost < dp[a]) { dp[a] = cost; nextB[a] = b; }
      }
      // 无解（段内可断点太稀，够不着 MIN 又超不出扫描上界）→ 退到最近的候选断点，宁可短行也别整段一行。
      if (dp[a] === INF) { const b = Math.min(a + 1, hi); dp[a] = dp[b] + lenCost(ends[b] - ends[a], cellsBetween(a, b), b === hi); nextB[a] = b; }
    }
  }

  // 回溯：每个选中断点 cand[b-1]，小节末→小节边界换行，否则→行内换行。段界本身也是断点。
  const brk = (b: number) => {
    const ci = flat[cand[b - 1]];
    if (ci.isLast) measureBreaks.add(ci.mi + 1);
    else midBreaks.add(ci.chord);
  };
  for (let a = 0; a < M; ) {
    const b = nextB[a];
    if (b <= a) break;
    if (b < M) brk(b);
    a = b;
  }
  // 行首不留一个孤零零的休止：断点之后只剩一个休止就到小节线的话，下一行开头是个「空拍」，
  // 唱的人也不知道要等谁——把它并到上一行去（193《主恩更多》第二行开头就是这样）。
  // 整小节都是休止的同理，整节挂到上一行。放不下时容量保险会再切开，不会撑爆版心。
  for (const c of [...midBreaks]) {
    const idx = flat.findIndex((f) => f.chord === c);
    const nx = flat[idx + 1];
    if (idx < 0 || !nx || !nx.chord.rest || !nx.isLast) continue;
    midBreaks.delete(c);
    if (nx.isLast) measureBreaks.add(nx.mi + 1);
    else midBreaks.add(nx.chord);
  }
  for (const mi of [...measureBreaks]) {
    if (mi >= n || !chordsPer[mi].length) continue;
    if (!chordsPer[mi].every((c) => c.rest)) continue;
    measureBreaks.delete(mi);
    if (mi + 1 < n) measureBreaks.add(mi + 1);
  }

  return { measureBreaks, midBreaks, sectionStarts, sectionCutChords, refrainCut };
}
