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
  /**
   * **在这条小节线上断行有多少乐句凭据**（小节下标，语义同 `measureBreaks`：
   * `mi + 1` = 在第 mi 小节之后断）。值 = 断点强度 − 行首罚，可以是负的。
   *
   * 给**容量补刀**用（`applybreaks.ts::splitEvenly`）：断句本身不看纸张，
   * 排不下就整首换档，而换的那个档也得挑个像样的落点——原来它只按格数找最接近的
   * 小节线，不看标点、不看长音、不看行首罚，刀常落在句子中间（全书行首带标点 190 处）。
   */
  cutScore: Map<number, number>;
  /** **不许删的断点**（小节下标，语义同 `measureBreaks`）：跳转记号（Fine / D.C. / D.S. /
   *  To Coda）所在的小节末。`measureBreaks` 的子集。后续的并行/补刀（`chooseLineLayout`）
   *  一律绕开它们——记号是给唱的人看路标的，印在一行的中段读不出来。 */
  forced: Set<number>;
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

/** 一行开头拿几个音做「平行乐句」的指纹。 */
export const HEAD_FP_LEN = 8;

/** 一个和弦的旋律键（音级+八度，休止记 R）。与 `measureFp` 同一套写法。 */
export function noteKeyOf(c: Chord): string {
  const nt = c.notes[0];
  return !nt || c.rest ? "R" : nt.number + ":" + nt.jpOctave;
}

/**
 * 一行开头的旋律指纹（前 `HEAD_FP_LEN` 个音）。**两行的指纹相同 = 平行乐句开头**，
 * 排成各自的行首就对得齐——原书的分行大量是这个样子（070 的副歌两行、077 的 `13|5565|`、
 * 175 的一二行）。重复段检测（`repeatEdges`）管的是「整段重复」，管不到这个：
 * 平行的两句往往只有开头几个音相同，后半句各走各的。
 *
 * **跳过行首的休止**：那是弱起的留白，不是旋律的一部分。同一段旋律有的行从休止起头、
 * 有的直接从弱起音起头（363《倾听我的心》第 1 行 `0_ 5,_ |3. 3_ 2.`、第 3 行
 * `5,_ |3. 3_ 2.`），不跳过就对不上，明明平行的两行认不出来。
 *
 * 不足 `HEAD_FP_LEN` 个音返回空串（不参与比对）。
 */
export function headFpOf(chords: Chord[]): string {
  let i = 0;
  while (i < chords.length && chords[i].rest) i++;
  const notes = chords.slice(i, i + HEAD_FP_LEN);
  if (notes.length < HEAD_FP_LEN) return "";
  return notes.map(noteKeyOf).join(",");
}

/** 收尾的引号/括号。判标点前要先剥掉它们——「再相亲，”」是个收了尾的分句，
 *  而不是「没有标点」（068《天使报信》的引文就这么收尾，断句因此认不出乐句的落点）。 */
const TRAIL_QUOTE = /[”’＂"』」）)〉》〕】]+$/;

/** 歌词末尾标点的分量：句末 6 / 句中 4 / 无 0。 */
export function punctScore(text: string): number {
  const t = text.replace(TRAIL_QUOTE, "");
  return PUNCT_END.test(t) ? 6 : PUNCT_MID.test(t) ? 4 : 0;
}

/**
 * 一个和弦上**各段歌词**的标点分，取**均值**（只算这个音符上真有词的段）。
 *
 * 断句要看的是「这个位置是不是乐句的落点」，那是**旋律**的性质——多段歌词共用同一条旋律，
 * 各段的收句位置本来就该在同一处。只看第 1 段会漏掉别的段在这里收句的事实。
 *
 * **取中位数**。先试过最大值：五段里只有一段点了句号就把这里判成乐句落点，那多半是那一段的
 * 抄写差异。再试过均值，却把分稀释得太狠——各段标点录得不齐时（原书本来就有漏点的），
 * 一个真落点的分能掉到零头，断点强度整体塌下来，DP 于是少断、行拉长、词被劈开
 * （077《耶稣我主荣耀王》实测从 7 行塌成 5 行，「宝座｜亲来」「忍｜饥」都断在词中间）。
 * 中位数两头都躲开：**多数段认同才算数，而认同了就给足分**。
 *
 * 分母只数**有词的段**：一字多音时别的段在这个音符上是空的（词在前一个音符上），
 * 拿整首的段数当分母会把分稀释掉。
 *
 * 与 `mainLyricText` 的分工：那个取的是**要显示的**主歌词（行首/行末报什么字），
 * 这个只管**标点判定**，两者别混。
 */
export function lyricPunctScore(c: Chord): number {
  const ps: number[] = [];
  for (const nt of c.notes) for (const l of nt.lyrics) if (l.text) ps.push(punctScore(l.text));
  if (!ps.length) return 0;
  ps.sort((a, b) => a - b);
  return ps[Math.floor(ps.length / 2)];
}

/** 一个和弦是不是**句末**（口径同 `lyricPunctScore`：多数段在这里收句才算）。 */
export function lyricIsSentenceEnd(c: Chord): boolean {
  let end = 0;
  let n = 0;
  for (const nt of c.notes) for (const l of nt.lyrics) {
    if (!l.text) continue;
    if (isSentenceEnd(l.text)) end++;
    n++;
  }
  return n > 0 && end * 2 > n;
}

/** 这个字是不是**句末**（句号/问号/叹号/省略号/分号）。
 *  与 `punctScore` 的分工：分量会被「很短的分句减半」打对折（见 `SHORT_WORDS`），
 *  拿 `=== 6` 去判句末就会漏掉那些被减半的（077《耶稣我主荣耀王》的「难当；」
 *  从上一个标点起只唱了「厌弃难当」四个字，分被折成 3，(d) 那条因此判不到它、
 *  把「当；」甩到了下一行行首）。**要句末就问这个，别拿分数去比。** */
export function isSentenceEnd(text: string): boolean {
  return PUNCT_END.test(text.replace(TRAIL_QUOTE, ""));
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
  /** `maxCells` 的单位是不是**排版器数出来的「个数」**（音符与增时线各算一个）。
   *  成书那条路的容量由 `measureCellsPerLine` 数出来，就是这个单位；而 `cellsOf` 为了行长目标
   *  把增时线折算成 0.7 格，两把尺子混用会把长音多的行判成「放得下」而实际折行
   *  （378《主耶稣我爱祢》副歌 32 个格、容量 31，折算后只有 28.x）。
   *  **默认 false**：编辑器那条路的 `DEF_MAX_CELLS = 25` 是按折算后的格数调出来的。 */
  cellsAreItems?: boolean;
  /** 「别把一句话的最后一小截甩到下一行开头」的权重（0 = 关）。
   *  419《人生崎岖路》第 6 行开头的「却成了祝福。」——上一行明明还差好几格。
   *  **默认关**：15 首编辑器基线里它会把「至高的爱尽见于刺 / 穿的手」这样的词劈开
   *  （断点被推去了别处），成书那条路才打开。 */
  tailWeight?: number;
  /** **摊匀行长**的权重（0 = 关）。开着时 DP 跑两遍：第一遍定下「这一段要几行」，
   *  第二遍把行长目标改成「本段小节数 ÷ 行数」、行长代价按这个权重加重，
   *  在同样的行数里挑长短最接近的那套断点。默认 0——编辑器那条路的基线是按一遍调出来的；
   *  成书排版打开（原书每一行都差不多长，我们却会一行顶格、一行半幅）。 */
  evenWeight?: number;
  /** 多排一行的代价（`evenWeight > 0` 时的方案评分用）。默认 20。 */
  rowCost?: number;
  /** 「末两行别一长一短」的权重。一段的最后两行长短悬殊最扎眼（125《主名至宝》、
   *  404《你若不压橄榄成渣》都是倒数第二行短、末行长），而普通的行长代价管不到它——
   *  末行本来就允许短。默认 1；0 = 关。 */
  lastPairWeight?: number;
  /** **断句只看内容**（成书那条路开着）。开着时 DP 与方案评分里**一切与纸张有关的分都不算**：
   *  行长目标 `(meas − target)²`（target 由版心容量折算而来）、`maxMeas` 罚、
   *  `MIN_MEAS` / `MIN_CELLS` 那一路「行太稀」的罚、以及「每多排一行 `rowCost` 分」。
   *  版心宽度只剩一个作用：**超容量是硬约束**（排不下的方案不能选）。
   *  抑制「断得太碎」交回 `BASE_BREAK`（每断一次都要付费），抑制「一行太长」交给超容量罚。
   *  **默认 false**：编辑器那条路的 15 首基线是按旧口径调出来的。 */
  contentOnly?: boolean;
  /** 跳转记号（Fine / D.C. / D.S. / To Coda）所在的小节下标。这些地方**要高优先级断开**
   *  ——`Fine` 落在主歌多段歌词中间时，不断在那儿的话记号就印在了一行的中段（096）。
   *  Score 里它们只存在 `playData` 里（供 `play()` 展开），排版层拿不到，所以由调用方传进来。 */
  jumpMeasures?: Set<number>;
  /** **平行乐句开头**的加分（0 = 关）。一行的头几个音与另一行的头几个音相同时，
   *  把它们排成各自的行首，两行就对齐得上——简谱排版的惯例，也最贴近原谱分行
   *  （070 副歌两行同开头、077 的 `13|5565|`、175 的一二行）。默认 0；成书传 6。 */
  parallelWeight?: number;
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
  const EVEN_WEIGHT = opts.evenWeight ?? 0;
  const TAIL_WEIGHT = opts.tailWeight ?? 0;
  const CELLS_ARE_ITEMS = opts.cellsAreItems ?? false;
  const CONTENT_ONLY = opts.contentOnly ?? false;
  const JUMP_MEAS = opts.jumpMeasures ?? new Set<number>();
  const PARALLEL_WEIGHT = opts.parallelWeight ?? 0;
  // 多排一行的代价（评分用）。定得太低会把每首都摊成一堆短行；太高就退回「能挤则挤」。
  // 20 是拿 051/052/378/374 试出来的：副歌那种「一行顶格、主歌两行很稀」会拆成两行，
  // 而本来就匀的谱不会平白多出一行。
  const ROW_COST = opts.rowCost ?? 20;
  /** 方案评分里「断点弱度」相对「行长匀度」的权重（contentOnly 用，见 quality）。 */
  const BREAK_QUALITY_WEIGHT = 8;
  /** 末两行「短的 ÷ 长的」低于此就开始罚（contentOnly 用，见 quality 的 lastPair）。
   *  与 line-check 的 L5 同一口径、同一个 0.6。 */
  const LAST_PAIR_QUALITY_RATIO = 0.6;
  const LAST_PAIR_QUALITY_WEIGHT = 60;
  /** 「有一行明显比同曲其它行短」的门槛（contentOnly 用，见 quality 的 shortOutlier）：
   *  最短的那一行（末行除外）不到中位数的这个比例就开始罚。 */
  const SHORT_OUTLIER_RATIO = 0.6;
  /** 「有一行明显比同曲其它行长」的权重（contentOnly 用，见 quality 的 outlier）。 */
  const OUTLIER_WEIGHT = 60;
  /**
   * 候选方案那几遍 DP 的行长权重（`runWith`）。
   *
   * 它**不是评分**，只是「让 DP 真能排出指定的行数」的手段——评分用的是 `quality`，
   * 那边的行长项走 `EVEN_WEIGHT`。原来这里也用 `EVEN_WEIGHT`（1），太轻，压不住断点代价：
   * 374《跟随救主》段 2 要排 4 行每行 2 小节，DP 算下来
   * 「4 行 = 行长代价 0 + 断三刀 24」比「3 行 = 行长代价 4 + 断两刀 16」还贵，于是交出 3 行
   * （`want [4,4] → got [4,3]`），那套方案就被「行数对不上」丢弃了，候选池里根本没有它。
   * 调到 2 之后 DP 排得出来：070《天使歌唱》终于排出了主歌 16/16 + 副歌 30/34 那 4 行。
   * （374 还另有一处：`splitSentence` 拿 `punctAfter === 6` 判句末，把「跟随！」这种
   * 被 SHORT_WORDS 折半的呼语句一律当成非句末，见 `isSentenceEndAt`。）
   * 再往上调反而过头——行长压过断点强度，374 又散成 7 行 13/13/14/12/17/17/12（权重 3）。
   */
  const RUN_WITH_LEN_WEIGHT = 2;
  // 行长下限跟着上限走：版心窄时上限本来就小，14 格的下限会把断点全顶掉
  const MIN_CELLS = Math.min(DEF_MIN_CELLS, Math.round(MAX_CELLS * 0.6));
  const measures = part.measures;
  const n = measures.length;
  const measureBreaks = new Set<number>();
  const midBreaks = new Set<Chord>();
  const sectionStarts = new Set<number>();
  const cutScore = new Map<number, number>();
  const sectionCutChords = new Set<Chord>();
  const forced = new Set<number>();
  let refrainCut = false;
  if (n <= 1) return { measureBreaks, midBreaks, sectionStarts, sectionCutChords, refrainCut, forced, cutScore };

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
  interface CInfo { chord: Chord; mi: number; isLast: boolean; isFirst: boolean; pos: number; }
  const flat: CInfo[] = [];
  for (let i = 0; i < n; i++) {
    const cs = chordsPer[i];
    for (let k = 0; k < cs.length; k++) {
      const c = cs[k];
      const within = c.position.plus(c.duration ?? new Fraction(0)).toFloat() / measureDur[i];
      flat.push({ chord: c, mi: i, isLast: k === cs.length - 1, isFirst: k === 0, pos: i + Math.min(1, within) });
    }
  }
  const K = flat.length;
  if (K === 0) return { measureBreaks, midBreaks, sectionStarts, sectionCutChords, refrainCut, forced, cutScore };

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
  /** 这一处的标点是不是**句末**（不受「短分句减半」影响，见 isSentenceEnd）。 */
  const endAfter = new Array<boolean>(K).fill(false);
  // 标点顺延过来的源头（那个带标点的音符）。乐句在那里收尾、断点落在尾随的休止上，
  // 两者是**同一个收尾**，强度要一起算（见 scoreAt）。
  const carriedFrom = new Array<number>(K).fill(-1);
  {
    let depth = 0;
    let pending = 0;
    let pendingFrom = -1;
    let pendingEnd = false;
    let sinceLastPunct = 0; // 上一个标点之后唱了几个字
    for (let idx = 0; idx < K; idx++) {
      const c = flat[idx].chord;
      depth += okStart[idx];
      const txt = mainLyricText(c);
      if (txt) sinceLastPunct++;
      // 多段歌词一起看**只在成书那条路**（见 lyricPunctScore）。编辑器那条路的 15 首基线
      // 是按「只看第 1 段」调出来的，换了口径就会把「至高的爱尽见于刺 / 穿的手」劈开。
      let p = CONTENT_ONLY ? lyricPunctScore(c) : punctScore(txt);
      const pIsEnd = CONTENT_ONLY ? lyricIsSentenceEnd(c) : isSentenceEnd(txt);
      // **很短的分句减半**：「哈利路亚！」「阿们！」这种呼语句句带感叹号，若与整句同权，
      // 连着三句就断出三个满分断点，行结构反而被它们主导
      //（015《赞美真神》结尾三句「哈利路亚！」，按句末断会把第一句留在上一行、
      //  与第 2 行开头那段更长的重复旋律对不齐）。短句仍是断点，只是让位给更长的乐句信号。
      if (p > 0 && sinceLastPunct <= SHORT_WORDS) p = Math.round(p / 2);
      if (txt && p > 0) sinceLastPunct = 0;
      if (p > pending) { pending = p; pendingFrom = idx; pendingEnd = pIsEnd; }
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
        endAfter[idx] = pendingEnd;
        if (pending > 0 && pendingFrom >= 0 && pendingFrom !== idx) carriedFrom[idx] = pendingFrom;
        pending = 0;
        pendingFrom = -1;
        pendingEnd = false;
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
  /** 在 idx 之后换行的话，下一行的**行首残小节**有多长（时值；`Chord.beats` 是增时线格数、不是时值）。
   *  `headPenalty` 的 (b)/(b3) 与段界的 `retreatPastPickupRest` 共用这一把尺子。 */
  const headDurAfter = (idx: number): number => {
    const nx = flat[idx + 1];
    if (!nx) return 0;
    let head = 0;
    for (let j = idx + 1; j < K && flat[j].mi === nx.mi; j++) {
      head += flat[j].chord.duration?.toFloat() ?? 0;
      if (flat[j].isLast) break;
    }
    return head;
  };
  const headPenalty = (idx: number): number => {
    const nx = flat[idx + 1];
    if (!nx) return 0;
    const head = headDurAfter(idx);   // 行首残小节的时值
    let hasNote = false;
    for (let j = idx + 1; j < K && flat[j].mi === nx.mi; j++) {
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
    // (b3) **各行的行首残小节要一样长**（凑整拍），不限于行首是休止的那种。
    // (b) 只认「行首是半拍及以下休止」，行首是**音符**的弱起它管不着：363《倾听我的心》
    // 的行 1/2/4 从 1 拍起头（`0_ 5,_` / `3_ 4_`），行 3/5/6 却只有半拍（`5,_` / `3__ 4__`）
    // ——上一行行尾那个 `0_` 该挪到下一行去，与后面的弱起音凑成整拍，六行才齐头。
    // 用户口径：「都与第一行的开始一样一拍残小节；休止后有音符的残小节是可以接受的」。
    // 只在成书那条路、且**本曲确实有弱起**时开（`pickupStd > 0`）：从整小节起唱的谱没有
    // 「标准行首残小节」可言，一律罚就等于禁掉所有行内断点。
    // 罚得比 (b2) 重（12 vs 8）——两条会打架：(b2) 要把收气休止留在上一行，(b3) 要把它
    // 挪下去凑整拍。**能凑成标准弱起的就该挪**（363 的 `0_` + `5,_` 正好一拍），
    // 凑不成的（077《耶稣我主荣耀王》那种）(b3) 本来就不罚，(b2) 照旧管用。
    // 编辑器基线里这一条曾把「一生中最可 / 贵」劈开（见 (b) 的注释），故只在成书开。
    // 只罚**比标准弱起短**的：那才是「差一点没凑齐、该把上一行行尾那点挪过来」。
    // 比标准长的是另一回事（行内断点落在别处），一并罚就太宽了——实测全书末两行悬殊
    // 7 → 14 首、收气休止被甩到行首 12 → 28 处。
    if (CONTENT_ONLY && pickupStd > 0 && head > 0 && head < pickupStd - 0.01) s += 12;
    // (b2) **句末标点之后的那个休止是上一句唱完的收气，该留在上一行**：
    // 上一行行末带句读标点、下一行却从休止起头的话，那口气就被甩到了行首
    // （077《耶稣我主荣耀王》的「历风霜；」之后那个休止）。
    // 与 (b) 的分工：(b) 管「半拍休止的弱起长短不一」，管不到四分及以上的收气休止
    // ——那一条的注释早就写着「本来就该留在上一行」，却一直没有对应的罚。
    // **除非这样起头正好凑成本曲的标准弱起**——那时休止是下一句弱起的一部分，不是上一句的
    // 收气，挪下去反而齐头（363《倾听我的心》的 `0_` + `5,_` 正好一拍，与首行一样；
    // 用户口径：「休止后有音符的残小节是可以接受的」）。凑不成的照罚（077 的「历风霜；」）。
    if (CONTENT_ONLY && nx.chord.rest && lyricPunctScore(flat[idx].chord) > 0
        && !(pickupStd > 0 && Math.abs(head - pickupStd) < 0.01)) s += 8;
    // (g) **断点落在「无词的拖腔」上、而拖腔所属的那个字没有标点收尾** → 句子还没唱完，
    // 断在这儿就把词从中间劈开了：077 的「殷｜勤」——「殷」留在行末、「勤服事…」另起一行。
    // 拖腔所属的字**带标点**时相反（乐句真收尾了），不罚，那正是 (b2) 要保住的情形。
    if (CONTENT_ONLY && !nx.chord.rest && !mainLyricText(flat[idx].chord) && !flat[idx].chord.rest) {
      let j = idx;
      while (j >= 0 && !mainLyricText(flat[j].chord)) j--;
      if (j >= 0 && lyricPunctScore(flat[j].chord) === 0) s += 8;
    }
    // (c) **行首那个字带着句读标点**：一句话的最后一个字落到了行首，上一句的尾巴被甩过来了
    //（077《耶稣我主荣耀王》的「厌弃难当；」被劈成「…难」＋「当；…」）。
    // 长音起头更是明摆着的延音收尾，再加重（15 首基线里「一生中最可 / 贵」就是这么把词劈开的）。
    // **这一条只看行首那个字自己**，与 (d)「别把一句的最后一小截甩到下一行」不同——
    // (d) 是往后数几个字才到句号，判据宽、牵动面大，改它会连累别处的断点（实测把
    // 077 的「役｜于」「四｜方」劈开了）。
    // **要上一行自己没收尾才算**：断点处已经带标点的话，行首那个「啊，」「哦！」是新一句
    // 自己的开头（020《向主歌唱》每段都从「啊，」起唱），不是上一句的尾巴。
    // 断点落在无词的拖腔上时要**往前追到真正的字**——拖腔自己当然没有标点。
    // 行首那个字**自成一句**时两条都不罚：它前面那个字就带着标点，说明这一句从它起唱、
    // 不是上一句的尾巴（131《无他，只有耶稣宝血》的「血！」是感叹词长音，
    // 142《圣灵请来》的「来，」是命令语气——两个标点之间只有一个字）。
    const prevWordPunct = (() => {
      let j = idx;
      while (j >= 0 && !mainLyricText(flat[j].chord)) j--;
      return j < 0 ? 0 : lyricPunctScore(flat[j].chord);
    })();
    if (CONTENT_ONLY && lyricPunctScore(nx.chord) > 0 && prevWordPunct === 0) s += 8;
    if (nx.chord.beats >= 2 && lyricPunctScore(nx.chord) > 0 && prevWordPunct === 0) s += 10;
    // (d) **别把一句话的最后一小截甩到下一行开头**：断点之后没几个字就到句号了的话，
    // 那截尾巴属于本行（419《人生崎岖路》第 6 行开头的「却成了祝福。」，
    // 上一行明明还差好几格）。越近罚得越狠；离得够远（一行的三成以上）就不管——
    // 长句本来就要分行。
    // (e) **行末别只挂着下一句的头一两个字**：断点前一两个字就是句号的话，
    // 那一两个字是下一句的起唱，跟着下一行走才对（062《神的保护》四行行末各挂着
    // 「从」「祂」「白」「荣」，下一行从「上主而来」「永不困倦」起唱）。
    // 与 (d) 对称：(d) 管「别把上一句的尾巴甩到下一行」，(e) 管「别把下一句的头留在本行」。
    if (TAIL_WEIGHT > 0) {
      let words = 0;
      for (let j = idx; j >= 0; j--) {
        if (punctAfter[j] === 6) { if (words >= 1) s += TAIL_WEIGHT * 8; break; }
        const c = flat[j].chord;
        // 断点本身落在长音上不算数（那个长音可能正是被留下的那一个字）；
        // 再往前遇上长音就停——那是乐句真正的落点。
        if (j < idx && c.beats >= 2) break;
        if (!c.rest && mainLyricText(c)) words++;
        if (words > 2) break;
      }
    }
    const tailMax = MAX_CELLS * 0.35;
    // (d) 在**断点落在「带标点的长音」上**时不成立——那是乐句真正的收尾（用户口径就是
    // 「长音 + 标点」），下一行开头那一小截是新的一句，不是被甩出去的尾巴：068《天使报信》
    // 的「兴起！」跟在「再相亲，”」（4 拍长音 + 逗号）之后，是独立的一句呼召，(d) 却按
    // 「上一句的尾巴」罚了 7.7 分，把断点顶到「兴起」之后、让行末挂着「兴起！」。
    // 419《人生崎岖路》那种「却成了祝福。」的上一行收在一个普通音符上，不受影响。
    const strongEnd = punctAfter[idx] > 0 && flat[idx].chord.beats >= 2;
    if (TAIL_WEIGHT > 0 && !strongEnd) {
      let run = 0;
      for (let j = idx + 1; j < K; j++) {
        run += cellsOf(flat[j].chord);
        if (run > tailMax) break;
        if (punctAfter[j] === 6 && j < K - 1) { s += TAIL_WEIGHT * 10 * (1 - run / tailMax); break; }
      }
    }
    return s;
  };

  // 断点候选的乐句强度分（在该和弦之后换行）。
  // **平行乐句开头**（判据与来由见 `headFpOf`）。
  // 潜在行首 = **上一个音符是个乐句落点**（小节末 / 带标点 / 长音 / 休止）的那些位置。
  // 原来只认「小节起点」，弱起谱整个漏掉——363《倾听我的心》六行全是从小节中间的弱起
  // 起唱（`3_ 4_ |5- …`），三对平行开头一个都没进候选池。判据与 `startsParallel` 的
  // 门槛保持一致：那边要求断点本身先是个乐句收尾，这边就按同样的口径找行首。
  // 同一指纹出现两次以上才算平行。
  /** 比到第几个音为止（够长了就不必再比，也免得两两比较太贵）。 */
  const PARALLEL_MAX = 16;
  /** 至少这么多个音一样才算平行——三两个音相同到处都是，不算数。 */
  const PARALLEL_MIN = 4;
  /**
   * 潜在行首 → 它与**别的**潜在行首的**最长公共前缀**（音符数，0 = 不平行）。
   *
   * 原来是按固定长度（6 / 10 个音）取指纹、比是否全等，长度定多少都不对：
   * 定短了噪声大（随便两处开头几个音相同就算平行），定长了又漏——072《信徒欢唱》
   * 的两处平行开头是 `5 6 5 4 | 3 2 1`，第 8 个音就分岔了，10 音指纹认不出来。
   * 改成动态算公共前缀，**重复得越长得分越高**，不必再拍一个长度出来。
   *
   * 行首的休止先跳掉（弱起的留白，不是旋律的一部分）：同一段旋律有的行从休止起头、
   * 有的直接从弱起音起头（363《倾听我的心》第 1 行 `0_ 5,_`、第 3 行 `5,_`）。
   */
  const parallelLen = new Map<number, number>();
  if (PARALLEL_WEIGHT > 0) {
    const heads: { at: number; keys: string[] }[] = [];
    for (let i = 0; i < K; i++) {
      if (i > 0) {
        const pv = flat[i - 1];
        if (!(pv.isLast || punctAfter[i - 1] > 0 || pv.chord.beats >= 2 || pv.chord.rest)) continue;
      }
      let j = i;
      while (j < K && flat[j].chord.rest) j++;
      const keys: string[] = [];
      for (let t = j; t < K && keys.length < PARALLEL_MAX; t++) keys.push(noteKeyOf(flat[t].chord));
      if (keys.length >= PARALLEL_MIN) heads.push({ at: i, keys });
    }
    for (let a = 0; a < heads.length; a++) {
      for (let b = a + 1; b < heads.length; b++) {
        const ka = heads[a].keys;
        const kb = heads[b].keys;
        let n = 0;
        while (n < ka.length && n < kb.length && ka[n] === kb[n]) n++;
        if (n < PARALLEL_MIN) continue;
        parallelLen.set(heads[a].at, Math.max(parallelLen.get(heads[a].at) ?? 0, n));
        parallelLen.set(heads[b].at, Math.max(parallelLen.get(heads[b].at) ?? 0, n));
      }
    }
  }
  /**
   * 在 idx 之后断行的话，下一行的开头与别处重合了几个音（0 = 不平行）。
   *
   * **要求断点本身先是个像样的乐句收尾**（句读标点 / 长音 / 休止 / 延长号）。
   * 只看旋律重复会把词拦腰切开：096《哈利路亚！感谢主》的「哈利路亚」唱好几遍，
   * 「路亚」的开头旋律自然与别处相同，于是「哈利｜路亚」之间被判成平行乐句、拿到 14 分，
   * 一并行就把「哈利」留在了行末。旋律重复只是**佐证**，断不断得看乐句本身收没收尾。
   */
  const parallelAt = (idx: number): number => {
    if (!(PARALLEL_WEIGHT > 0) || idx + 1 >= K) return 0;
    const c = flat[idx].chord;
    if (!(punctAfter[idx] > 0 || c.beats >= 2 || c.rest || c.fermata)) return 0;
    return parallelLen.get(idx + 1) ?? 0;
  };
  const startsParallel = (idx: number): boolean => parallelAt(idx) >= PARALLEL_MIN;

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
    // **休止本身就是乐句的气口**：唱的人在这儿换气，断在这里天然合适。
    // 原来只给四分及以上 +1，弱得几乎不起作用；成书那条路按长短给分、八分休止也算。
    // 编辑器那条路维持 +1（基线是按它调出来的）。
    if (c.rest) s += CONTENT_ONLY ? (c.beams === 0 ? 4 : 2) : (c.beams === 0 ? 1 : 0);
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
    // 跳转记号（Fine / D.C. / D.S. / To Coda）落在哪个小节，那个小节末就**高优先级断开**
    //（+10，比房尾 +6、终止线 +5 都高）：记号是给唱的人看路标的，印在一行的中段读不出来。
    if (ci.isLast && JUMP_MEAS.has(ci.mi)) s += 10;
    // **平行乐句开头在这里只给一点分，用来打平局**（主力在 quality，见那边）。
    // 给足分会让 DP 为了凑一个平行开头就断出短行（实测全书中间行过短 4 → 18 处、
    // 行长悬殊 6 → 12 首）；但一分不给也不行——070《天使歌唱》的
    // `m12|「最」→「高」` 与 `m13|「神，」→「荣」` 强度都是 8 分，DP 任选其一，
    // 挑中前者就把「最高神」劈开了。后者是平行开头，该赢下这个平局。
    if (startsParallel(idx)) s += 2;
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
    if (!(idx >= 0 && idx !== at && depthAfter[idx] === 0)) return at; // 回退处在弧中不可断 → 维持原判
    // **回退之后的行首残小节要与本曲的弱起一样长**，否则不退：337《活着为耶稣》的弱起是
    // 1.5 拍（行 1/2/4 都是），副歌那个段界一路退到半拍休止之前，第 3 行就成了 2 拍
    // （0.5 休止 + 1.5）。`headPenalty` 的 (b2)/(b3) 早有这个口径——「能凑成标准弱起的
    // 就挪下去，凑不成的留在上一行」——只是段界这条路一直没走那套判断。
    // 只在**退了不齐、不退正好齐**时拦下来，别的情形维持原判（363《倾听我的心》那种
    // `0_` + `5,_` 正好凑成一拍的仍照退）。编辑器那条路不变（15 首基线按旧口径调过）。
    if (CONTENT_ONLY && pickupStd > 0 && Math.abs(headDurAfter(idx) - pickupStd) > 0.01
        && Math.abs(headDurAfter(at) - pickupStd) < 0.01) return at;
    return idx;
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

  // **跳转记号处强制断行**（Fine / D.C. / D.S. / To Coda）。只加进 DP 的分段边界 `cuts`，
  // **不写 sectionStarts**——那些是「另起一页」，这里只要换行。
  // 光靠 `scoreAt` 的 +10 压不住：断点代价的量程只有 0~8，而「各行一样长」那一项能到几十分，
  // 096《哈利路亚！感谢主》实测就是被行长匀度盖过去、Fine 印在了第二行的中段。
  // 全局 DP（类 Knuth-Plass）：行长以「小节数」计（含小数，跨弱起/切分仍准），
  // 最小化 Σ(行长偏差² + 断点弱罚)。断点可落在小节中间（如句号在小节内的 slur/tie 收尾）。
  const ends = [0, ...cand.map((i) => flat[i].pos)]; // ends[0]=曲首；断点 b∈1..M 对应 cand[b-1]
  const idxAt = [-1, ...cand];                       // idxAt[b]=断点在 flat 中的下标（0=曲首之前）
  const cellsUpto = new Array<number>(K + 1).fill(0); // 前缀格数：cellsUpto[i]=前 i 个和弦占的格数
  for (let i = 0; i < K; i++) cellsUpto[i + 1] = cellsUpto[i] + cellsOf(flat[i].chord);
  const cellsBetween = (a: number, b: number) => cellsUpto[idxAt[b] + 1] - cellsUpto[idxAt[a] + 1];
  // **容量那一档要按「整格」数**：`cellsOf` 把增时线折算成 0.7 格（它们画得比数字窄，
  // 用于行长目标很合适），但**容量是排版器数出来的**（`measureCellsPerLine` 数的是音符与增时线的
  // 个数，一根算一个）。两把尺子混用，长音多的谱就会被判成「放得下」而实际折行——
  // 378《主耶稣我爱祢》的副歌 32 个格、容量 31，DP 按 0.7 折算成 28.x，以为宽宽有余。
  const cellsIntUpto = new Array<number>(K + 1).fill(0);
  for (let i = 0; i < K; i++) cellsIntUpto[i + 1] = cellsIntUpto[i] + Math.max(1, Math.floor(flat[i].chord.beats) || 1);
  const cellsIntBetween = (a: number, b: number) =>
    CELLS_ARE_ITEMS ? cellsIntUpto[idxAt[b] + 1] - cellsIntUpto[idxAt[a] + 1] : cellsBetween(a, b);
  // 一行有多长，**按时值算**（Σ `Chord.duration`）。
  // 不用小节数——太粗，同样两小节可以差一倍的音；也不用格数——那是视觉宽度，
  // 掺着增时线与歌词字数（`Chord.beats` 本身就是增时线格数、不是时值）。
  // 时值才是这一行在音乐上到底有多长，「一行相当于其它行的两倍长度」说的就是它。
  const durUpto = new Array<number>(K + 1).fill(0);
  for (let i = 0; i < K; i++) durUpto[i + 1] = durUpto[i] + (flat[i].chord.duration?.toFloat() ?? 0);
  const durBetween = (a: number, b: number) => durUpto[idxAt[b] + 1] - durUpto[idxAt[a] + 1];

  // 完整句末的前缀计数。仅提高「跨过句末、把下一句弱起塞到本行」的代价；若断点本身就在
  // 句末则不罚。这样 `…便要走！ 而…`、`…长存不朽！ 谁人…` 会优先在 `！` 后换行，
  // 同时很短的句子仍可在行长收益足够大时合排，不把句末标点做成绝对硬断点。
  //
  // **「是不是句末」要问 `endAfter`，别拿 `punctAfter` 的分数去比 6**（见 isSentenceEnd 的注释）：
  // 「很短的分句减半」会把「跟随！」「主！」这种呼语句的 6 折成 3，于是它们在下面几处
  // 一律不算句末——374《跟随救主》段 2 整段都是这种短句，`splitSentence` 因此认定
  // 「后面还有个句号、整句放得下」，给每一处 2 小节的断法压上 24 分的重罚，
  // DP 于是**排不出**「每行 2 小节」那 4 行（`want [4,4] → got [4,3]`）。
  // 编辑器那条路的 15 首基线是按旧口径调出来的，仍走 `punctAfter === 6`。
  const isSentenceEndAt = (i: number): boolean => (CONTENT_ONLY ? endAfter[i] : punctAfter[i] === 6);
  const endPunctUpto = new Array<number>(K + 1).fill(0);
  for (let i = 0; i < K; i++) endPunctUpto[i + 1] = endPunctUpto[i] + (punctAfter[i] === 6 ? 1 : 0);
  const crossedEndPunct = (a: number, b: number): number =>
    endPunctUpto[idxAt[b]] - endPunctUpto[idxAt[a] + 1];
  const INF = Number.POSITIVE_INFINITY;
  const BASE_BREAK = 8;
  /** contentOnly 下把断点强度归一化到 `[0, BASE_BREAK]` 的分母：要盖得住最强的断点
   *  （实测 24 分上下），强度才分得出高下，而总量程不变。 */
  const CONTENT_BASE_BREAK = 24;
  /** 在 b 处断行要付的代价（不含行长）：乐句信号越强越便宜。段末（b === hi）不付。
   *  **强断点可以挣出净收益**（封顶 BASE_BREAK，免得一路狂断）；BREAK_WEIGHT=1 时
   *  退化成原来的 max(0, …)，编辑器那条路的行为不变。
   *  **行内断点（非小节末）另加重罚**——简谱通常在小节线处换行，行内断只该用在乐句尾恰落小节内
   *  （句号/长音，那时 scoreAt 高足以抵消）或实在别无选择时；只压**弱信号**（score < 4）。 */
  const breakCost = (b: number, hi: number): number => {
    if (b === hi) return 0;
    const sc = scoreAt(cand[b - 1]);
    // **contentOnly 下强度要真的分得出高下**：旧式 `max(0, BASE_BREAK − sc × 3)` 在
    // `sc ≥ 3` 之后一律钳成 0，于是「断在长音+标点上（13 分）」与「断在一个普通小节线上
    // （9 分）」代价一模一样，断在哪儿全由别的项说了算（175《人惟以信得称义》的
    // 「能大力，」就是这么被让掉的）。
    //
    // 改法是**把强度的量程铺满 `[0, BASE_BREAK]`**：分母取盖得住最强断点的那个数
    // （实测最强的在 24 分上下），于是 9 分与 13 分不再打平，而**总量程仍是原来的 0~8**
    // ——`headPenalty`（行首判据）、`lastPair`（末两行）、`crossedEndPunct` 那几项
    // 都是按 0~8 这个尺度调出来的，量程一放大它们就被稀释（实测全书 L1~L5 六档一起变差）。
    //
    // 不允许负收益：代价在 DP 里是累加的，负收益会让它一路狂断（068《天使报信》试出来
    // 排了 10 行，其中四行只有一小节）。非负且单调，强断点便宜但仍要付费，
    // 于是「断得少」与「断在强点上」自己去权衡，上界由超容量罚兜住。
    // 代价一律**非负**。试过把零点摆到量程中间让强断点挣净收益，全书立刻碎化
    //（中间行过短 5 → 61 处）——DP 里代价是累加的，一给负收益就一路狂断。
    // 「少断更便宜」的偏向改在**方案评分**那一层纠正（见 quality 的 BREAK_QUALITY_WEIGHT）。
    const base = CONTENT_ONLY
      ? Math.max(0, BASE_BREAK * (1 - sc / CONTENT_BASE_BREAK))
      : Math.max(0, BASE_BREAK - sc * BREAK_WEIGHT);
    return base +
      (flat[cand[b - 1]].isLast || sc >= 4 ? 0 : 6) +
      headPenalty(cand[b - 1]);
  };
  const CROSSED_END_PUNCT_COST = 4;
  const SPLIT_SHORT_SENTENCE_COST = 24;
  // 行长约束一律是**软惩罚**而非硬禁：可断点稀疏时（弧线跨小节连成一片，如「主祢真伟大」副歌
  // 每小节末都在 slur 内）硬禁会让整段找不到任何合法切法、退化成一整行。软罚则总能挑出最不坏的一种。
  const lenCost = (meas: number, cells: number, segEnd: boolean, maxCells = MAX_CELLS, maxMeas = MAX_MEAS,
                   target = TARGET_MEAS, lenW = LEN_WEIGHT, cellsInt = cells): number =>
    // **contentOnly 下只剩「排不排得下」这一条**：小节数上限、行太稀那几项都是绝对量、
    // 直接挂在版心容量上，不该由它们决定乐句断在哪儿（见 PhraseOptions.contentOnly）。
    // 行长目标这一项留着，但**由调用方决定用不用**：第一遍 DP 传 lenW = 0（纯内容断句），
    // 方案选优那几遍传的 target 是「本段小节数 ÷ 行数」——那是个**相对**量，不含纸张，
    // 只是让 DP 排得出指定的行数（行数本身不进 quality 的评分）。
    lenW * (meas - target) ** 2 +
    (!CONTENT_ONLY && meas > maxMeas ? (meas - maxMeas) ** 2 * 40 : 0) +
    (cellsInt > maxCells ? (cellsInt - maxCells) ** 2 * 8 : 0) +
    // 段末/曲末行是唯一可短于 MIN 的行，但也**不该短到只剩一小节**——软罚让 DP 宁可把前面几行
    // 各让出一点，也别甩出一个孤零零的尾巴（"不要有只有一节的情况"）。
    (!CONTENT_ONLY && segEnd && meas < MIN_MEAS ? (MIN_MEAS - meas) ** 2 * 10 : 0) +
    // 「尾巴太短」在小节短促的谱上按小节数量不出来：「基督更美」每小节才 4 格，末行 3 小节
    // 合规、实则只有 7.7 格（同曲其余行 15.7）。故段末行的下限也认格数，与非段末行的 MIN_CELLS
    // 同一口径——非段末行是硬约束，段末行仍只软罚（末行本来就可以短一些）。
    (!CONTENT_ONLY && segEnd && cells < MIN_CELLS ? (MIN_CELLS - cells) ** 2 : 0);

  // **后面剩不下半行内容的不强制**：Fine 常写在临近曲末处（`D.C. al Fine` 唱两遍的谱），
  // 在那里硬断一刀就甩出个两三格的尾巴（018 实测末两行 21 / 2 格、497 甩出一行 2 格）。
  // 按**格数**判而不是小节数——小节的长短随拍号差得远。
  const FORCED_CUT_TAIL_CELLS = 8;
  const forcedCuts: number[] = [];
  if (JUMP_MEAS.size) {
    for (let i = 0; i < M; i++) {
      const idx = cand[i];
      if (idx === K - 1 || !flat[idx].isLast || !JUMP_MEAS.has(flat[idx].mi)) continue;
      if (cellsUpto[K] - cellsUpto[idx + 1] < FORCED_CUT_TAIL_CELLS) continue;
      forcedCuts.push(i + 1);
      forced.add(flat[idx].mi + 1); // 后续的并行/补刀不许删（见 PhraseBreaks.forced）
    }
  }

  // 按段界把 [0,M] 切成若干闭区间，逐段跑同一套 DP：段末等同曲末（末行可短、无断点罚）。
  const cuts = [0, ...new Set([...sectionCuts, ...forcedCuts])].sort((p, q) => p - q);
  if (cuts[cuts.length - 1] !== M) cuts.push(M);
  /** 跑一遍 DP。`targetFor(s)` 给第 s 段的行长目标（小节数），`lenW` 是行长代价的权重。 */
  const runDP = (targetFor: (s: number) => number, lenW: number): { dp: number[]; nextB: number[] } => {
  const dp = new Array<number>(M + 1).fill(INF);
  const nextB = new Array<number>(M + 1).fill(-1);
  dp[M] = 0;
  for (let s = cuts.length - 1; s >= 1; s--) {
    // 段末 dp[hi] 已就绪：末段是曲末 dp[M]=0，其余在后一段里作为起点算过。
    const lo = cuts[s - 1], hi = cuts[s];
    const target = targetFor(s);
    for (let a = hi - 1; a >= lo; a--) {
      for (let b = a + 1; b <= hi; b++) {
        const meas = ends[b] - ends[a], cells = cellsBetween(a, b);
        // 扫描上界（两者随 b 单调增）：放到软限的两倍，超出必然亏本，不必再算。
        if (b > a + 1 && (meas > MAX_MEAS * 2 || cells > MAX_CELLS * 2)) break;
        // 只有段末/曲末行可短。contentOnly 下放宽——一个短乐句就该占一短行，「行太稀」
        // 是纸张的事——但仍不许**只剩一小节**的碎行（那不是乐句，是被切剩的）。
        if (b < hi && (CONTENT_ONLY ? (meas < 2 && scoreAt(cand[b - 1]) < 4) : meas < MIN_MEAS && cells < MIN_CELLS)) continue;
        // 断点罚：乐句信号越强越便宜；**行内断点（非小节末）另加重罚** —— 简谱通常在小节线处换行，
        // 行内断只该用在乐句尾恰落小节内（句号/长音，那时 scoreAt 高足以抵消）或实在别无选择时。
        // 行内罚只压**弱信号**的行内断点：句号/长音/延长号/重复边界（score≥4）落在小节内时，
        // 那本就是乐句真正的收尾处，不该因为「没赶上小节线」被罚。
        const bc = breakCost(b, hi);
        const crossed = crossedEndPunct(a, b);
        const endsAtSentence = isSentenceEndAt(idxAt[b]);
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
            // **「这句放得下」要与容量判据用同一把尺子**：`cellsAreItems`（成书那条路）下
            // 容量数的是格子个数（`cellsIntUpto`），而这里原来拿的是折算过的小数格。
            // 215《同心合意》第 2 段整段是一句「…主爱无尽。」，小数格 32.8 ≤ 33 判成「放得下」，
            // 于是从任何位置断开都被罚 24 分、DP 排不出 2 行（`want [x,2] → got [x,1]`）；
            // 而它按格子数其实是 34 格、根本放不下，那一行只好交给容量保险按宽度硬折，
            // 折点落在「人，」的头上。
            const sentenceCells = CELLS_ARE_ITEMS
              ? cellsIntUpto[p + 1] - cellsIntUpto[idxAt[a] + 1]
              : cellsUpto[p + 1] - cellsUpto[idxAt[a] + 1];
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
        const cost = lenCost(meas, cells, b === hi, lineMaxCells, lineMaxMeas, target, lenW, cellsIntBetween(a, b)) + bc + splitSentence +
          lastPair + crossed * CROSSED_END_PUNCT_COST + dp[b];
        if (cost < dp[a]) { dp[a] = cost; nextB[a] = b; }
      }
      // 无解（段内可断点太稀，够不着 MIN 又超不出扫描上界）→ 退到最近的候选断点，宁可短行也别整段一行。
      if (dp[a] === INF) { const b = Math.min(a + 1, hi); dp[a] = dp[b] + lenCost(ends[b] - ends[a], cellsBetween(a, b), b === hi, MAX_CELLS, MAX_MEAS, target, lenW); nextB[a] = b; }
    }
  }
  return { dp, nextB };
  };

  /** 一段里排了几行（从回溯链上数）。 */
  const linesPerSeg = (nb: number[]): number[] => {
    const out = new Array<number>(cuts.length - 1).fill(0);
    for (let a = 0; a < M; ) {
      const b = nb[a];
      if (b <= a) break;
      const s = cuts.findIndex((c) => c >= b);
      if (s >= 1) out[s - 1]++;
      a = b;
    }
    return out;
  };

  // 第一遍：contentOnly 下 `lenW = 0`，纯按内容断，行数自然涌现（作为下面候选方案的底）。
  let { nextB } = runDP(() => TARGET_MEAS, CONTENT_ONLY ? 0 : LEN_WEIGHT);
  // **出几种方案再评分选优**（`evenWeight > 0` 时）。
  //
  // 第一遍只保证「每行都放得下」，于是一段顶着版心、另一段只有半幅——051《赞美我主君王》
  // 排成 12/14/24 格，378《主耶稣我爱祢》17/15/32：副歌那 9 小节挤成一行，主歌两行却很稀。
  // 光在**段内**摊匀没用（副歌本来就只有一行），得允许某一段**多排一行**。
  //
  // 所以：以第一遍的行数为底，让每段各自试「+0 / +1 / +2 行」，逐个组合跑一遍 DP，
  // 再按同一把尺子评分选优——行长越匀越好、断点越强越好、行数越少越好。
  if (EVEN_WEIGHT > 0) {
    const segs = cuts.length - 1;
    const base = linesPerSeg(nextB);
    /**
     * 一套方案的分：越小越好。
     *
     * **contentOnly 下这把尺子是无量纲的、与行数无关的**（见 PhraseOptions.contentOnly）：
     *   - 行长不匀按**变异系数**（标准差 ÷ 均值）算，不用方差——方差随格数量纲变化，
     *     等于又把版心宽度请了回来。
     *   - 断点弱度取**均值**而不是总和。这一条是要害：去掉「每多一行 rowCost 分」之后，
     *     总和会让「多断几刀」平白变好（每一刀都挑最强的断点，总弱度反而降），
     *     于是每首都摊成一堆短行。
     *   - **平行乐句开头**按行数占比给负分（越多行对得齐越好）。
     *   - 行数、短行（稀疏）都不算分；超容量仍是硬伤（排版器会照宽度硬折，甩出个两三格的尾巴）。
     */
    const quality = (nb: number[]): number => {
      const cells: number[] = [];
      const durs: number[] = [];
      /** 按段分组的行时值：主歌一组、副歌一组。 */
      const bySeg = new Map<number, number[]>();
      let weak = 0;
      let parallel = 0;
      for (let a = 0; a < M; ) {
        const b = nb[a];
        if (b <= a) break;
        cells.push(cellsBetween(a, b));
        durs.push(durBetween(a, b));
        // 按**段**归组（主歌一组、副歌一组），见下面 cv 的注释
        const segNo = cuts.findIndex((c) => c >= b);
        if (!bySeg.has(segNo)) bySeg.set(segNo, []);
        bySeg.get(segNo)!.push(durBetween(a, b));
        const hi = cuts.find((c) => c >= b) ?? M;
        weak += breakCost(b, hi);
        const over = cellsIntBetween(a, b) - MAX_CELLS;
        if (over > 0) weak += 100 + over ** 2 * 8;
        if (!CONTENT_ONLY) {
          // 短行同样难看（058《耶和华的心》曾在中间甩出一行只有 5 格）。末行不算——它本来可以短。
          const short = MIN_CELLS - cellsIntBetween(a, b);
          if (short > 0 && b < M) weak += short ** 2;
        }
        // 这一行的**下一行**是不是平行开头（断点 b 之后那个和弦起头）
        // **按公共前缀的长度给分**：重复得越长，把它们排成各自的行首就越值
        // （比到 12 个音封顶，再长也不多给了）。
        if (b < M) parallel += Math.min(parallelAt(cand[b - 1]), 12) / 12;
        a = b;
      }
      if (!cells.length) return INF;
      const mean = cells.reduce((x, y) => x + y, 0) / cells.length;
      const variance = cells.reduce((x, c) => x + (c - mean) ** 2, 0) / cells.length;
      if (!CONTENT_ONLY) return variance + weak + ROW_COST * cells.length;
      // **行长不匀按「变异系数」算**（标准差 ÷ 均值）：无量纲，不随格数的绝对值变化。
      // 用方差不行——那是「格²」，容量大的谱天生分高，等于又把纸张请了回来。
      // 试过在 contentOnly 下干脆不算这一项，全书立刻崩（中间行过短 5 → 70 处、
      // 行长悬殊 6 → 51 首）：行与行的长短差异确实要算权重。
      //
      // 另一项是断点弱度，取**均值**（不是总和）——总和会让「多断几刀」平白变好，
      // 每一刀都挑最强的断点，总弱度反而降。均值让行数保持中性。
      // contentOnly 下再乘 BREAK_QUALITY_WEIGHT：DP 第一遍（代价非负、累加）总是交出
      // 「行数最少、每行顶着容量」的那一套，而它的行长天然最匀，不加权就永远赢。
      // 行长匀度**按段各算各的**，再按行数加权平均。用户口径：「副歌可以接受比主歌长
      // 比较多，主歌内/副歌内每行尽量相近的长度」——全曲一把尺子会把副歌那几行压到与
      // 主歌一样长（070《天使歌唱》主歌两行 16 拍、副歌两行 24/28 拍，全曲看差 1.75 倍，
      // 按段看两边各自都很齐）。
      // 「可以更长」不等于「一定要更长」：整段偏长的情形交给下面的 `outlier`（那一项看全曲），
      // 374《跟随救主》段 2 的两行各 23 格彼此很匀、却是段 1 的近两倍，照样要拆。
      const segCv = (xs: number[]): number => {
        if (xs.length < 2) return 0;
        const mu = xs.reduce((x, y) => x + y, 0) / xs.length;
        if (!(mu > 0)) return 0;
        return Math.sqrt(xs.reduce((x, c) => x + (c - mu) ** 2, 0) / xs.length) / mu;
      };
      let cv: number;
      if (CONTENT_ONLY) {
        let acc = 0;
        let cnt = 0;
        for (const xs of bySeg.values()) { acc += segCv(xs) * xs.length; cnt += xs.length; }
        cv = cnt ? acc / cnt : 0;
      } else {
        cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
      }
      // **有一行明显比同曲其它行长就罚**（用户口径：「拆开的依据是现在一行相当于其它行的
      // 2 倍长度了」）。变异系数对「只有一行特别长」不敏感——它被其余齐整的行摊平了
      //（374《跟随救主》13/13/14/12/**23**/11/12 的 cv 只有 0.28）。
      // 拿中位数作基准（均值会被那一行自己抬高），超过 1.4 倍才算。
      // 按**时值**判（小节数太粗、格数掺着增时线与歌词字数），同样**按段**各算各的。
      const segOutlier = (xs: number[]): number => {
        if (xs.length < 2) return 0;
        const m = [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] || 1;
        return Math.max(0, Math.max(...xs) / m - 1.4);
      };
      // **这一项看全曲**（cv 才按段）：两把尺子分工——cv 管「同一段里各行长短相近」，
      // 它管「别有哪一行长到顶别人两个」。按段算会漏掉整段偏长的情形：374《跟随救主》
      // 段 2 的两行各 23 格彼此很匀，可段 1 每行才 13 格，那两行该各拆成两行才对
      //（用户口径：「374 应该是每行 2 小节」）。
      const outlier = segOutlier(durs);
      // **镜像的另一半：别有哪一行短到只剩别人一半**。cv 管「同段各行相近」、`outlier` 管
      // 「别有哪一行长到顶别人两个」，短的那头原来没人管——本来是靠「DP 排不出那么多行」
      // 挡着的，判据修好之后要在评分这一层补上。**末行不算**（它本来就可以短）。
      const segShortOutlier = (xs: number[]): number => {
        if (xs.length < 3) return 0;
        const m = [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] || 1;
        return Math.max(0, SHORT_OUTLIER_RATIO - Math.min(...xs.slice(0, -1)) / m);
      };
      const shortOutlier = CONTENT_ONLY ? segShortOutlier(durs) : 0;
      // **末两行别一长一短**。DP 里的 `lastPair` 是一遍之内的前瞻，只管得住那一遍自己的选择，
      // 方案与方案之间比不了；断句判据修好之后（见 `isSentenceEndAt` / `sentenceCells`）
      // 可选的行数变多，这一条就得在评分这一层也说一次。按时值比，无量纲。
      const lastPair = durs.length >= 2
        ? Math.max(0, LAST_PAIR_QUALITY_RATIO
            - Math.min(durs[durs.length - 1], durs[durs.length - 2])
              / Math.max(durs[durs.length - 1], durs[durs.length - 2], 1e-9))
        : 0;
      const breakW = CONTENT_ONLY ? BREAK_QUALITY_WEIGHT : 1;
      // @ts-ignore 调试钩子：一套方案的分是怎么摊出来的。页面里先 `window.__qDebug = []`，
      // 排完读它——`__evenDebug` 只给总分，看不出「这一版明明更匀却输了」输在哪一项
      //（133《以马内利，恳求降临》的 3 行版 cv 只有 7.4、4 行版 22.9，却因为 4 行版
      //  多出一个平行乐句开头、拿了 −27.5 的奖励而落败）。
      if (typeof window !== "undefined" && (window as any).__qDebug) (window as any).__qDebug.push({
        lines: cells.length, durs: durs.map((d) => Math.round(d * 10) / 10),
        cv: +(EVEN_WEIGHT * 100 * cv).toFixed(2), outlier: +(OUTLIER_WEIGHT * outlier).toFixed(2),
        shortOut: +(OUTLIER_WEIGHT * shortOutlier).toFixed(2),
        lastPair: +((CONTENT_ONLY ? LAST_PAIR_QUALITY_WEIGHT * lastPair : 0)).toFixed(2),
        weak: +(breakW * (weak / cells.length)).toFixed(2),
        parallel: +(-PARALLEL_WEIGHT * (parallel / cells.length) * 10).toFixed(2) });
      return EVEN_WEIGHT * 100 * cv + OUTLIER_WEIGHT * (outlier + shortOutlier)
        + (CONTENT_ONLY ? LAST_PAIR_QUALITY_WEIGHT * lastPair : 0)
        + breakW * (weak / cells.length)
        - PARALLEL_WEIGHT * (parallel / cells.length) * 10;
    };
    const runWith = (want: number[]): { nb: number[]; lines: number[] } => {
      const r = runDP((sIdx) => {
        const span = ends[cuts[sIdx]] - ends[cuts[sIdx - 1]];
        const k = want[sIdx - 1];
        return k > 0 ? span / k : TARGET_MEAS;
      }, RUN_WITH_LEN_WEIGHT);
      return { nb: r.nextB, lines: linesPerSeg(r.nextB) };
    };
    // 候选：每段在第一遍的行数上下各试几档。
    // **contentOnly 下要双向**（−2…+2）：第一遍已经不受行长目标约束，行数是「照内容断」
    // 自然涌现的，既可能偏多也可能偏少——117《祂名称为奇妙》头三句各有一个 24 分的强断点，
    // 第一遍照着断出 7/7/13/27/24/25 格六行，而更匀的四行方案压根没被生成过。
    // 旧口径下第一遍是按行长目标排的，行数只会偏少，所以单向就够（编辑器那条路不变）。
    const deltas = CONTENT_ONLY ? [-2, -1, 0, 1, 2] : [0, 1, 2];
    const options: number[][] = [];
    const add = (w: number[]) => {
      if (w.some((v) => v < 1)) return;
      if (!options.some((o) => o.every((v, i) => v === w[i]))) options.push(w);
    };
    add(base.slice());
    if (segs <= 3) {
      const grid = (i: number, acc: number[]) => {
        if (i === segs) return add(acc.slice());
        for (const d of deltas) { acc.push(base[i] + d); grid(i + 1, acc); acc.pop(); }
      };
      grid(0, []);
    } else {
      for (let i = 0; i < segs; i++)
        for (const d of deltas) { if (d === 0) continue; const w = base.slice(); w[i] += d; add(w); }
    }
    let best = { score: INF, nb: nextB };
    for (const want of options) {
      const got = runWith(want);
      // 段里排不出想要的行数就不算（DP 会退回它自己觉得合适的行数）
      if (!got.lines.every((v, i) => v === want[i])) continue;
      const sc = quality(got.nb);
      if (sc < best.score) best = { score: sc, nb: got.nb };
    }
    // @ts-ignore 临时调试
    if (typeof window !== "undefined" && (window as any).__evenDebug) (window as any).__evenDebug = { base, tried: options.map((w) => { const g = runWith(w); return { want: w, got: g.lines, q: g.lines.every((v, i) => v === w[i]) ? quality(g.nb) : null }; }), first: quality(nextB) };
    // @ts-ignore 调试钩子：每个候选断点的位置、歌词、强度分与行首罚。
    // 页面里先 `window.__phraseDebug = null`，排完读它——「为什么断在这儿不断在那儿」
    // 只看结果是猜不出来的（175 的「能大力，」是靠它看出两个断点代价被钳成了同一个 0）。
    if (typeof window !== "undefined" && (window as any).__phraseDebug !== undefined) {
      (window as any).__phraseDebug = cand.map((idx, i) => ({
        i, mi: flat[idx].mi, isLast: flat[idx].isLast,
        text: mainLyricText(flat[idx].chord),
        next: idx + 1 < K ? mainLyricText(flat[idx + 1].chord) : "",
        score: scoreAt(idx), head: headPenalty(idx),
        parallel: startsParallel(idx),
      }));
    }
    // 第一遍那套也要参与评分（它可能就是最好的）
    if (quality(nextB) <= best.score) best = { score: quality(nextB), nb: nextB };
    // @ts-ignore 调试钩子：段界
    if (typeof window !== "undefined" && (window as any).__cutsDebug !== undefined)
      (window as any).__cutsDebug = { cuts: cuts.map((c) => (c === 0 ? 0 : flat[cand[c - 1]].mi + 1)), M, segs: cuts.length - 1 };
    nextB = best.nb;
  }

  // 每条小节线上「断行有多少凭据」（见 PhraseBreaks.cutScore）。候选之外的小节线不填——
  // 那些地方连乐句信号都没有，补刀落在那儿本来就该按位置挑。
  for (const idx of cand) {
    if (!flat[idx].isLast) continue;
    cutScore.set(flat[idx].mi + 1, scoreAt(idx) - headPenalty(idx));
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

  return { measureBreaks, midBreaks, sectionStarts, sectionCutChords, refrainCut, forced, cutScore };
}
