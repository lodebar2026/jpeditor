// 乐句分析：综合歌词标点 + 音乐信号（延长号/终止线/长音/休止/连线）与「重复旋律」结构，
// 在小节边界上找乐句断点，并凑成不太稀疏也不太密的行长。供 scoreToJpwabc 的乐句排版模式使用。
// 返回 measureBreaks（作为「新行起点」的小节下标，与 Measure.newSystem 同义）与 midBreaks
// （在弱起谱里乐句尾——休止/长音——被并进下一小节时，改在该「行内」和弦后换行；含标点/句号处）。

import { Chord, Part } from "./score";
import { BarStyle } from "./enums";
import { Fraction } from "../common/fraction";

/**
 * **「一行放不放得下」的真实判据**（`pdflayout/browser.ts::measureChordSpans` 量出来的）。
 *
 * 用户口径：**「不要算格数，真实坐标排一遍，放不下再补刀」**。格数（`LineInfo.cells`）
 * 是近似——同样 30 格，歌词字多的行、带八度点与附点的行都更宽；照它判，排版器会在我们的
 * 断点之外**又折一刀**，而 `rebuild.mjs` 的容量收敛循环随后把容量越收越小
 * （064《啊！圣善夜》本来 7 行的方案被一路收成 9 行 13 格）。
 *
 * `spans` 与排版器折行用的是同一把尺子（`layout.ts::Line.naturalSpans`），
 * 且**与断点无关**（自然位置在分行之前就算完），所以整首量一次，补刀/合并反复试都能用。
 */
export interface FitMetric {
  /** 版心宽度。 */
  width: number;
  /** 每个和弦的自然横向区间。 */
  spans: Map<Chord, { x0: number; x1: number }>;
}

/**
 * 一个**可落刀的乐句子句断点**（`PhraseBreaks.cuts` 的元素）。断句本身选哪些断点由 DP
 * 做完了，这张表是给**补刀层**看的：「一行排不下、非得在它内部再切一刀」时，
 * 哪些位置有乐句凭据、各值多少分。
 */
export interface CutCandidate {
  /** 在该和弦**之后**断行。 */
  chord: Chord;
  mi: number;
  /** 收在小节线上（写 `measureBreaks`）；否则是行内断点（写 `midBreaks`）。 */
  isLast: boolean;
  /** 断点强度 − 行首罚（`scoreAt` − `headPenalty`），**可以是负的**。 */
  score: number;
  /**
   * 在这里断，**下一行的开头与前面某一行的开头是同一段旋律**吗——是的话公共前缀有多长
   * （`parallelAt`，比到 12 个音封顶）。0 = 不是平行乐句开头。
   *
   * 补刀要看它：原书的分行大量是「平行乐句各自成行、对齐着排」，而强度分里
   * 平行只值 2 分（`scoreAt` 拿它打平局用）。144《求圣灵吹我》两句「求主圣灵向我吹气」
   * 该各自成行、168《爱喜乐生命》后三行该按两句「让主爱…」并成两行，都是这一条。
   */
  parallel: number;
  /**
   * 这里是不是**句末**（`isSentenceEnd` 的口径，不受「短分句减半」影响）。
   *
   * 单独带出来是因为强度分**分不出句号与逗号**：`punctScore` 里两者只差 2 分
   * （6 vs 4），而「很短的分句减半」还会把句号折成 3——168《爱喜乐生命》的
   * 「忧愁不再。」只跟在「心底，」后面四个字，句号被折成 3，输给了「心底，」的 10 分
   * （逗号 4 + 长音 4 + 小节线加分），一整句就被劈到了下一行开头。
   * 补刀这一层要的正是「落在句号上」，所以它在 `pickCuts` 里另有加分。
   */
  end: boolean;
}

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
   * **全部候选断点**（按位置升序，含落在小节中间的那些）。
   *
   * 给**容量补刀**用（`applybreaks.ts::pickCuts`）：断句本身不看纸张，排不下就整首换档，
   * 而换的那个档也得挑个像样的落点——原来它只按格数找最接近的小节线，不看标点、
   * 不看长音、不看行首罚，刀常落在句子中间（全书行首带标点 190 处）。
   *
   * **行内候选一并带出**：乐句的自然子句断点常落在小节中间（弱起谱尤其如此），
   * 原来这里 `if (!isLast) continue` 把它们全丢了，补刀只能在小节线里挑。
   * 落不落在小节线上改由补刀层按权重定（`BAR_END_BONUS`），不再是硬约束。
   */
  cuts: CutCandidate[];
  /** **容量补刀落下的断点**（`applybreaks.ts::applyCapacityCuts` 写，两种键与
   *  `measureBreaks` / `midBreaks` 同义）。断句本身不产生它们——它们是「这一行放不下」
   *  才切出来的。`describeLines` 据此给 `LineInfo.fromCut` 打记号，`line-check.mjs`
   *  的 D2 据此豁免（拆分导致的弱起不一致不算错误）。 */
  capacityCuts: Set<Chord | number>;
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
  /**
   * **「放得下」当平局裁判的容差**（方案评分用，`contentOnly` 那一路才有意义）。默认 0 = 关。
   *
   * 断句层照旧不把容量算进代价（见 `contentOnly`）；这一项只让纸张当**平局的裁判**：
   * 「每行都放得下」的那套方案与最优方案差距在这个数以内，就用前者。
   * 详见 `computePhraseBreaks` 里用到它的那段注释（070《天使歌唱》的 0.85 分之差）。
   */
  fitSlack?: number;
  /** **行数多的方案优先**：与最优方案差在这个数以内就选行数最多的那套（0 = 关）。
   *  内容层的规则，与版心无关——原委见 `computePhraseBreaks` 里用到它的那段注释。 */
  moreRowsSlack?: number;
  /** **平行乐句开头**在断点强度里值多少分（按公共前缀长度折算）。
   *  用户口径：不管成书还是其它歌谱排版，平行句都更优先于标点（逗号 4、句号 6）。默认 8。 */
  parallelScore?: number;
  /**
   * **真实坐标**（`pdflayout/browser.ts::measureChordSpans`）。给了它，「这一套方案放不放得下」
   * 就按真实宽度判（与排版器折行同一把尺子）；没给就退回按格数（`maxCells`）估。
   * 用户口径：不要算格数，真实坐标排一遍。
   */
  fit?: FitMetric;
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
  /** **行末收在长音上**的加分（0 = 关；成书传 4，编辑器不开）。一行收在一个长音上，
   *  唱的人有地方换气、看的人一眼看得出乐句到头了——原书的分行大量是这个样子。
   *  与 `parallelWeight` 是一对：那条管「下一行从哪儿起」，这条管「这一行在哪儿收」。
   *  用户口径：「应该通过平行句 + 长音结尾让 4 行赢过 3 行」（061《坚固保障》）。 */
  tailLongWeight?: number;
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
  const TAIL_LONG_WEIGHT = opts.tailLongWeight ?? 0;
  // 多排一行的代价（评分用）。定得太低会把每首都摊成一堆短行；太高就退回「能挤则挤」。
  // 20 是拿 051/052/378/374 试出来的：副歌那种「一行顶格、主歌两行很稀」会拆成两行，
  // 而本来就匀的谱不会平白多出一行。
  const ROW_COST = opts.rowCost ?? 20;
  /** 平行乐句开头在 `scoreAt` 里值多少分。用户口径：**不管成书还是其它歌谱排版，
   *  平行句都更优先于标点**（逗号 4、句号 6），所以默认 8。 */
  const PARALLEL_SCORE = opts.parallelScore ?? 8;
  const FIT_SLACK = opts.fitSlack ?? 0;
  /** 「行数多的优先」的容差（内容层，见用到它的那段注释）。 */
  const MORE_ROWS_SLACK = opts.moreRowsSlack ?? 0;
  const FIT = opts.fit;
  /** 最长的一行超过版心这么多倍 = 断句层撂挑子了，「放得下」那一票不再受容差限制。 */
  const ABDICATE_RATIO = 1.8;
  /** 方案评分里「断点弱度」相对「行长匀度」的权重（contentOnly 用，见 quality）。 */
  const BREAK_QUALITY_WEIGHT = 8;
  /** 末两行「短的 ÷ 长的」低于此就开始罚（contentOnly 用，见 quality 的 lastPair）。
   *  与 line-check 的 D8 同一口径、同一个 0.6。 */
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
  const cutList: CutCandidate[] = [];
  const capacityCuts = new Set<Chord | number>();
  const sectionCutChords = new Set<Chord>();
  const forced = new Set<number>();
  let refrainCut = false;
  if (n <= 1) return { measureBreaks, midBreaks, sectionStarts, sectionCutChords, refrainCut, forced, cuts: cutList, capacityCuts };

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
  if (K === 0) return { measureBreaks, midBreaks, sectionStarts, sectionCutChords, refrainCut, forced, cuts: cutList, capacityCuts };

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
  /** 标点被**顺延走了**的那些位置（`carriedFrom` 的反向）：乐句真正的收尾在后面
   *  那个休止/拖腔上，不在这个音上。见 `tailLong`。 */
  const carriedAway = new Set<number>();
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
        if (pending > 0 && pendingFrom >= 0 && pendingFrom !== idx) {
          carriedFrom[idx] = pendingFrom;
          carriedAway.add(pendingFrom);
        }
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

  /**
   * **行长要认识反复房**：一行里的几个房是**二选一**唱的（1 房 / 2 房），谱面上它们并排，
   * 时值上却不能相加——158《一件礼物》末行含两个房，累加成 28.5 拍、成了全曲最长的一行，
   * 于是「把『机会难留。』并到上一行」（凭据更好、断点代价也更低的那个落点）
   * 因为「第 3 行只剩 17.5 拍、太不匀」被行长项否掉了。
   *
   * 折算按**行**记账：一行**完整包含**一组房时，把第一房之后那几房的量减掉；只含半组
   * （行首落在房中间）就不减。试过更省事的办法——直接把后几房的小节权重记 0，让前缀和
   * 自动带上——**不行**：含后一房的那一行看着 0 拍，DP 会拼命往里并
   * （编辑器那 15 首里「爱是不保留」的第 2 行并成了 8 小节 42 拍）。
   *
   * **展开过反复的谱用不着这套**（PPT 那条路把反复摊平了，谱面上没有房）：
   * `inEnding` 找不到闭合的房，`endingGroups` 就是空的，这里整段是空转。
   */
  interface EndingGroup { startMi: number; endMi: number; dur: number; cells: number; cellsInt: number }
  const endingGroups: EndingGroup[] = [];
  {
    let i = 0;
    while (i < n) {
      if (!inEnding[i]) { i++; continue; }
      const startMi = i;
      let first = true;
      let dur = 0;
      let cells = 0;
      let cellsInt = 0;
      let endMi = i;
      while (i < n && inEnding[i]) {
        const from = i;
        while (i < n && inEnding[i] && !endingLast[i]) i++;
        const to = Math.min(i, n - 1);
        i = to + 1;
        endMi = to;
        if (!first) {
          for (let k = from; k <= to; k++) for (const c of chordsPer[k]) {
            dur += c.duration?.toFloat() ?? 0;
            cells += cellsOf(c);
            cellsInt += Math.max(1, Math.floor(c.beats) || 1);
          }
        }
        first = false;
      }
      if (dur > 0) endingGroups.push({ startMi, endMi, dur, cells, cellsInt });
    }
  }
  /** 一行（flat 下标区间 `[i0, i1]`）里要减掉的「后几房」的量。 */
  const endingCut = (i0: number, i1: number, key: "dur" | "cells" | "cellsInt"): number => {
    if (!endingGroups.length || i0 > i1) return 0;
    const a = flat[i0].mi;
    const b = flat[i1].mi;
    let v = 0;
    for (const g of endingGroups) if (a <= g.startMi && b >= g.endMi) v += g[key];
    return v;
  };

  // 「本曲的弱起有多长」：首小节不完整时就是它的时值，否则没有弱起（0）。
  // 各行的行首残小节都照这个长度来，四行才齐头（372《跟随耶稣》：弱起 1 拍，
  // 第 2/4 行却从「八分休止 + 弱起」1.5 拍起头）。
  const fullMeasure = Math.max(...measureDur);
  const pickupStd = measureDur[0] < fullMeasure - 1e-6 ? measureDur[0] : 0;

  /**
   * **本曲的起唱样式**：没有弱起、整首却从小节头上的一个短休止起唱时，那个休止就是
   * 这首歌每一句的起唱样式（144《求圣灵吹我》六句全是 `0 3 2 3 5 6 1 | 2 3 2--`），
   * 不是上一句唱完的收气。`headPenalty` 的 (b)/(b2) 都按「上一句的收气被甩到行首」罚，
   * 于是这类谱子**每一个乐句开头都被罚 16 分**，断点只好落到句子中间去
   * （144 排成「求主圣灵向我吹气：赦我一切罪过…」两句挤一行）。
   * 只认**小节头上、与首小节一样长**的休止：短了长了都是别的事，仍旧照罚。
   */
  const openingRest = pickupStd === 0 && flat[0]?.chord.rest
    ? (flat[0].chord.duration?.toFloat() ?? 0) : 0;
  /** 断点之后那一行是不是「照本曲的起唱样式」起头（见 `openingRest`）。 */
  const startsLikeSong = (idx: number): boolean => {
    if (!(openingRest > 0)) return false;
    const nx = flat[idx + 1];
    if (!nx || !nx.chord.rest || nx.chord !== chordsPer[nx.mi][0]) return false;
    return Math.abs((nx.chord.duration?.toFloat() ?? 0) - openingRest) < 0.01;
  };

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
    const songOpen = startsLikeSong(idx);   // 照本曲的起唱样式起头（见 `openingRest`）
    if (headRest > 0 && headRest <= 0.5 && Math.abs(head - pickupStd) > 0.01 && !songOpen) s += 8;
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
        && !(pickupStd > 0 && Math.abs(head - pickupStd) < 0.01) && !songOpen) s += 8;
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
    // **断点本身就是句末的话 (d) 不成立**：下一行开头那一小截是**自成一句**的新句子，
    // 不是被甩出去的尾巴。判据与 (c) 的 `prevWordPunct === 0` 是同一条道理
    // ——020《向主歌唱》副歌每段从「啊！」起唱，上一行收在「…路亚！」上，
    // (d) 却按「一个字就到句末」罚了 4.5 分，把「啊！」拽回了上一行行尾。
    const sentenceEndHere = CONTENT_ONLY ? endAfter[idx] : punctAfter[idx] === 6;
    // **「还有几个字到句号」量到最后那个字为止，不算它的拖腔**：`punctAfter` 是顺延到
    // slur/tie/休止收尾的（见它的注释），照直累加就把句末长音的格子全算进「距离」里
    // ——158《一件礼物》断在「…不珍惜，｜机会难留。」上，尾巴只有四个字，
    // 可「留。」拖着 `2--- 2--` 七格，距离一算就成了 13 格（上限 13.65），罚几乎归零，
    // 那半句于是被甩到了下一行行首。
    if (TAIL_WEIGHT > 0 && !strongEnd && !sentenceEndHere) {
      let run = 0;
      let runWord = 0;   // 到最后一个**有词的字**为止的距离
      for (let j = idx + 1; j < K; j++) {
        run += cellsOf(flat[j].chord);
        if (mainLyricText(flat[j].chord)) runWord = run;
        if (runWord > tailMax) break;
        // **「是不是句末」要问 `endAfter`**（见 isSentenceEnd 的注释）：`punctAfter` 的分
        // 会被 SHORT_WORDS 折半，拿 `=== 6` 去比就漏掉所有短句——158《一件礼物》的
        // 「机会难留。」从上一个标点起只有四个字、分被折成 3，(d) 因此一分没罚，
        // 那半句被甩到了下一行行首。
        if ((CONTENT_ONLY ? endAfter[j] : punctAfter[j] === 6) && j < K - 1) {
          // 分量跟着 `punctAfter` 走（短呼语句被 SHORT_WORDS 折半，这里也只罚一半）：
          // 「哈利路亚！」那种句子本来就该能独占行首，一视同仁会把 020《向主歌唱》
          // 副歌的断点全推走。
          const w = CONTENT_ONLY ? punctAfter[j] / 6 : 1;
          s += TAIL_WEIGHT * 10 * (1 - runWord / tailMax) * w; break;
        }
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
    /**
     * 两个行首重合几个音。**允许一个音的出入**：同一段旋律在两处只差一个装饰音是常事
     * ——158《一件礼物》的「生命有限，时光也会走…」与「礼物，虽然好，如果你不要…」
     * 从第 5 个音起差一个（`5 1 2 3 7…` / `5 1 2 1 7…`），严格前缀只有 3 个音、
     * 连 `PARALLEL_MIN` 都不够，那一对平行乐句整个判没了。
     * 差的那个音**不计入**长度，且前后都要接得上（各至少 2 个音）才算——
     * 否则随便两处「开头两个音相同」都能靠一次豁免攀上亲。
     */
    const commonPrefix = (ka: string[], kb: string[]): number => {
      let n = 0;
      while (n < ka.length && n < kb.length && ka[n] === kb[n]) n++;
      if (n >= 2 && n + 1 < ka.length && n + 1 < kb.length) {
        let m = n + 1;
        while (m < ka.length && m < kb.length && ka[m] === kb[m]) m++;
        if (m - n - 1 >= 2) return m - 1;
      }
      return n;
    };
    for (let a = 0; a < heads.length; a++) {
      for (let b = a + 1; b < heads.length; b++) {
        const n = commonPrefix(heads[a].keys, heads[b].keys);
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
  /** **够当「乐句在此收尾」的凭据**要重合这么多个音。`PARALLEL_MIN`（4 个）只够当加分的
   *  佐证，拿它去顶掉「整句放得下就别拆」的 24 分罚就太松了：169《全新的你》的 `m14·`
   *  只重合 7 个音，「期待有人能够了解你心，｜能够爱你赐你力量更新。」被就地拆成
   *  8 拍 + 27 拍两行；副歌那几处「耶稣能够…」重合满 12 个音，才是真凭据。 */
  const PARALLEL_STRONG = 8;
  const strongParallel = (idx: number): boolean => parallelAt(idx) >= PARALLEL_STRONG;

  /** **这里像不像一个乐句落点**（不含平行奖励）。候选池按它收人，见 `scoreAt`。 */
  const scoreBase = (idx: number): number => {
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
    // **转调之前断开**（用户口径：144《求圣灵吹我》「在转调的地方应该断开」）。
    // 调号一换就是新的一段，原书几乎都在那里换行；而这里往往并没有别的信号
    // ——144 的 `m9|`「气。」本身是句末长音，却被行首罚压成了 −9 分。
    // 与跳转记号（+10）同量级：那也是「读谱的人要在这里换口气」的路标。
    if (ci.isLast && ci.mi + 1 < n && measures[ci.mi + 1].keyChange) s += 10;
    // **反复段的开头也尽量断开**（用户口径：009《荣耀归与至高神》「反复的开始也应该
    // 尽量断开」）。`‖:` 画在小节开头，唱的人要在这里回头——它与 `:‖`（下面那条 +5）
    // 是一对，原来只认收尾那一半。这里给的是**加分**不是强制：反复段的开头常常正是
    // 乐句的开头，多数时候别的信号也会指向同一处。
    if (ci.isLast && ci.mi + 1 < n && measures[ci.mi + 1].repeatForward) s += 8;
    // **试过并否掉**：把这 +5 按 `retreatToPunct` 往前退（弱起音写在反复线之前时，
    // 那个音是下一句的起句——「…便要走！ 而 :‖」「…万世不休！ 惟求 :‖」，
    // 断在小节线上就把它留在了上一行行尾）。那两处没被修好，全书反而变差
    // （断句族 24 → 25、定点 6 → 8 条不过）。要修得另找落点。
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
    //
    // **重复段边界得先是个真正的乐句收尾**（标点／休止／延长号／弧收尾），否则只给 2 分
    // 打平局——`parallelAt` 的头注释早写着这条道理（096「哈利｜路亚」那个坑），
    // 重复加分一直没这道门：299《我一生一世要赞美主》的 m8|「着」是个**没有标点的长音**，
    // 却因为重复边界拿到 16 分，压过了 m6|「华，」的 10 分，「我还活着 / 的时候」
    // 就被从词中间劈开了。只在成书那条路收紧（编辑器 15 首基线按旧口径调过）。
    const repIsEnd = punctAfter[idx] > 0 || c.rest || c.fermata || okEnd[idx] > 0;
    if (rep !== undefined) {
      const full = REPEAT_LEN_BONUS ? Math.min(10, 6 + rep) : 8;
      s += CONTENT_ONLY && !repIsEnd ? 2 : full;
    }
    // 跳转记号（Fine / D.C. / D.S. / To Coda）落在哪个小节，那个小节末就**高优先级断开**
    //（+10，比房尾 +6、终止线 +5 都高）：记号是给唱的人看路标的，印在一行的中段读不出来。
    if (ci.isLast && JUMP_MEAS.has(ci.mi)) s += 10;
    // **平行乐句开头在这里只给一点分，用来打平局**（主力在 quality，见那边）。
    // **平行乐句开头要明显高于标点**（用户口径：不管成书还是其它歌谱排版，平行句都更优先
    // 于标点）。原来只给 2 分、注释写着「只用来打平局」——逗号 4、句号 6，等于把最像
    // 「原书分行依据」的信号排在标点之后。066《普世欢腾》中间一个句号都没有，全靠逗号 4 分
    // + 平行 2 分，断两刀要付约 50 分，DP 于是十九个小节排成一行到底。
    //
    // **按公共前缀的长度给分**：重复得越长，把它们排成各自的行首就越值
    //（`parallelAt`，比到 12 个音封顶）。**两条路都用同一口径**。
    // **只用来打平局**：`scoreAt` 不止喂断点代价，它还决定「哪些位置进候选池」
    // （`scoreAt > 0` 才是候选）与强制断点的判定，抬高它会全盘搅动——实测把它按平行长度
    // 抬到 8 分，定点断言 12 → 18 条不过，363《倾听我的心》的「三对平行行」反而只剩一对。
    // **「平行优先于标点」那条口径落在方案级**（`quality` 的 `parallel` 项 / `PARALLEL_WEIGHT`），
    // 那一层只管「哪套方案的行首平行得多」，不动候选池。
    return s;
  };

  /**
   * **断在这里有多好**（= 乐句凭据 + 平行奖励）。
   *
   * 与 `scoreBase` 分开是因为这两件事本来就不是一回事（用户指出的）：
   *   `scoreBase`  **这里像不像一个落点**——有没有标点、长音、休止、延长号、弧收尾、
   *                终止线/反复/房尾、跳转记号、转调、前奏交界。**候选池按它收人**。
   *   `scoreAt`    断在这里有多好——在凭据之上再加「下一行是平行乐句开头」的奖励。
   *
   * 原来两者是同一个函数，于是「平行分」既是奖励又是**入池门槛**：把它抬高一点，
   * 大量没有任何气口的位置就涌进候选池，DP 的结构整个变样（实测平行分 2 → 8：
   * 定点断言 12 → 18 条不过，363《倾听我的心》的「三对平行行」反而只剩一对）。
   * 拆开之后，平行分只影响「在几个候选之间挑谁」，不再影响「有哪些候选」。
   */
  const scoreAt = (idx: number): number =>
    scoreBase(idx) + (startsParallel(idx) ? PARALLEL_SCORE : 0);

  // 候选断点：括号闭合（depth 0）且「小节末」或「带乐句信号」的和弦；末音强制入选（曲末）。
  const cand: number[] = [];
  for (let idx = 0; idx < K; idx++) {
    if (depthAfter[idx] !== 0) continue;
    const mi = flat[idx].mi;
    if (inEnding[mi] && !(flat[idx].isLast && endingLast[mi])) continue;
    // **候选池按「有没有乐句凭据」收人**，不看平行奖励（见 scoreAt 的注释）
    if (flat[idx].isLast || scoreBase(idx) > 0) cand.push(idx);
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
  const cellsBetween = (a: number, b: number) =>
    cellsUpto[idxAt[b] + 1] - cellsUpto[idxAt[a] + 1] - endingCut(idxAt[a] + 1, idxAt[b], "cells");
  // **容量那一档要按「整格」数**：`cellsOf` 把增时线折算成 0.7 格（它们画得比数字窄，
  // 用于行长目标很合适），但**容量是排版器数出来的**（`measureCellsPerLine` 数的是音符与增时线的
  // 个数，一根算一个）。两把尺子混用，长音多的谱就会被判成「放得下」而实际折行——
  // 378《主耶稣我爱祢》的副歌 32 个格、容量 31，DP 按 0.7 折算成 28.x，以为宽宽有余。
  const cellsIntUpto = new Array<number>(K + 1).fill(0);
  for (let i = 0; i < K; i++) cellsIntUpto[i + 1] = cellsIntUpto[i] + Math.max(1, Math.floor(flat[i].chord.beats) || 1);
  const cellsIntBetween = (a: number, b: number) =>
    CELLS_ARE_ITEMS
      ? cellsIntUpto[idxAt[b] + 1] - cellsIntUpto[idxAt[a] + 1] - endingCut(idxAt[a] + 1, idxAt[b], "cellsInt")
      : cellsBetween(a, b);
  // 一行有多长，**按时值算**（Σ `Chord.duration`）。
  // 不用小节数——太粗，同样两小节可以差一倍的音；也不用格数——那是视觉宽度，
  // 掺着增时线与歌词字数（`Chord.beats` 本身就是增时线格数、不是时值）。
  // 时值才是这一行在音乐上到底有多长，「一行相当于其它行的两倍长度」说的就是它。
  const durUpto = new Array<number>(K + 1).fill(0);
  for (let i = 0; i < K; i++) durUpto[i + 1] = durUpto[i] + (flat[i].chord.duration?.toFloat() ?? 0);
  const durBetween = (a: number, b: number) =>
    durUpto[idxAt[b] + 1] - durUpto[idxAt[a] + 1] - endingCut(idxAt[a] + 1, idxAt[b], "dur");

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
  // **「跨了几个句号」也要问 `endAfter`**（成书那条路；见 isSentenceEnd 的注释）：
  // `punctAfter` 的分会被 SHORT_WORDS 折半，`=== 6` 于是漏掉短句——355《你已否祷告》的
  // 「是否已祷告？」从上一个标点起只有五个字、分被折成 3，于是「…家前，是否已祷告？
  // 是否已奉基督圣名，」挤成一行也不算跨句，DP 反倒挑了后面那个凭据更高的逗号落点。
  const endPunctUpto = new Array<number>(K + 1).fill(0);
  for (let i = 0; i < K; i++)
    endPunctUpto[i + 1] = endPunctUpto[i] + ((CONTENT_ONLY ? endAfter[i] : punctAfter[i] === 6) ? 1 : 0);
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
    // 都是按 0~8 这个尺度调出来的，量程一放大它们就被稀释（实测全书 D1~D8 六档一起变差）。
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
    // **连一点乐句信号都没有的小节线，断在那儿也不好**（成书那条路，2026-08-27）：
    // 「简谱通常在小节线处换行」只说明小节线是**可以**断的地方，不等于哪条小节线都行。
    // 355《你已否祷告》段 1 十小节要排两行，`m3|`「祷告？」凭据 19、`m4|`「基督｜圣名」
    // 凭据 0，DP 却选了后者——因为 5+5 小节比 4+6 匀，`lenCost`（+4）与 `lastPair`（+4）
    // 加起来盖过了凭据那 6.33 分的差。凭据的量程只有 0~8（`BASE_BREAK`，见上），
    // 而行长那几项是**没有上界的平方**，零凭据的落点白拿一分不花的小节线就成了漏洞。
    // 罚一半（行内断是 6）：小节线终究比句中好断，只是不该白拿。
    const noEvidence = CONTENT_ONLY && sc < 1 ? 3 : 0;
    return base + noEvidence +
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
    (!CONTENT_ONLY && cellsInt > maxCells ? (cellsInt - maxCells) ** 2 * 8 : 0) +
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
  {
    // **转调之前也强制断开**（用户口径：144《求圣灵吹我》「在转调的地方应该断开」）。
    // 调号一换就是新的一段，原书都在那里换行。光加分压不住：144 的 `m9|`「气。」
    // 强度 25（句末 + 长音 + 转调），可行首罚也是 24——下一句的弱起休止叠着句末收气，
    // 两条罚项一起压上来，净值只剩 1 分，DP 于是从中间跨了过去。
    const keyChangeMeas = new Set<number>();
    if (CONTENT_ONLY) for (let mi = 1; mi < n; mi++) if (measures[mi].keyChange) keyChangeMeas.add(mi - 1);
    // **前奏之后也强制断开**（用户口径：028《全然向祢》「前奏刚好单独一句」）。
    // 前奏是整段没有词的小节，唱的人一眼要看出「从这里起唱」；原书都让它独占一行。
    // `scoreAt` 里那 +6 压不住行长代价——028 的前奏只有 4 小节 12 拍，DP 宁可把它
    // 与第一句并成 26 拍的一行（行末还落在「的」上）。
    if (CONTENT_ONLY) {
      for (let mi = INTRO_MIN_MEAS - 1; mi + 1 < n; mi++) {
        if (lyrPer[mi] !== "" || lyrPer[mi + 1] === "") continue;
        let run = 0;
        for (let j = mi; j >= 0 && lyrPer[j] === "" && run < INTRO_MIN_MEAS; j--) run++;
        if (run >= INTRO_MIN_MEAS) keyChangeMeas.add(mi);
      }
    }
    for (let i = 0; i < M; i++) {
      const idx = cand[i];
      if (idx === K - 1 || !flat[idx].isLast) continue;
      if (!JUMP_MEAS.has(flat[idx].mi) && !keyChangeMeas.has(flat[idx].mi)) continue;
      if (cellsUpto[K] - cellsUpto[idx + 1] < FORCED_CUT_TAIL_CELLS) continue;
      // **前奏的收尾长音留在前奏那一行**：028《全然向祢》的前奏收在 `1-- 0` 上，而它写在
      // 起唱那一小节的开头（`|1-- 0 5当…`）。照小节线断，那个 `1-- 0` 就成了下一行的行首。
      // 往后挪到「第一个有词的音」之前——与段界的 `aroundSectionPickup` 同一条道理。
      let at = i;
      if (!JUMP_MEAS.has(flat[idx].mi)) {
        let sung = idx + 1;
        while (sung < K && !mainLyricText(flat[sung].chord)) sung++;
        for (let j = i + 1; j < M && cand[j] < sung; j++) at = j;
      }
      forcedCuts.push(at + 1);
      const fi = flat[cand[at]];
      if (fi.isLast) forced.add(fi.mi + 1); // 后续的并行/补刀不许删（见 PhraseBreaks.forced）
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
          // **下一行起头是平行乐句的话，这里就是凭据**：`startsParallel` 本身已经要求
          // 断点先是个像样的乐句收尾（标点/长音/休止），再加上「后面那段旋律在别处
          // 原样重来」，比一个 3 拍长音硬气得多。少了这一条，169《全新的你》副歌
          // 「…体会你的心情，｜耶稣能够改变…」被罚 24 分（`情，` 只有 2 拍、算 softCut），
          // DP 只好改断在下一句的「够」上（`5--` 是 3 拍长音、白拿凭据），
          // 整个副歌的断点全体错开一句。
          const softCut = flat[bi].chord.beats < LONG_NOTE_BEATS && !flat[bi].chord.fermata
            && !flat[bi].chord.rest && !strongParallel(bi);
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
    /** 这一行（断点 a→b）按**真实坐标**放得下吗（没有真实坐标时一律当放得下）。 */
    const lineFits = (a: number, b: number): boolean => {
      if (!FIT) return true;
      const p0 = FIT.spans.get(flat[idxAt[a] + 1]?.chord);
      const p1 = FIT.spans.get(flat[idxAt[b]]?.chord);
      return !(p0 && p1) || p1.x1 - p0.x0 < FIT.width;
    };

    const quality = (nb: number[]): number => {
      const cells: number[] = [];
      const durs: number[] = [];
      /** 按段分组的行时值：主歌一组、副歌一组。 */
      const bySeg = new Map<number, number[]>();
      let weak = 0;
      let parallel = 0;
      let tailLong = 0;
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
        // **容量不卡断句**（用户口径）：「排不排得下」交给 `chooseLineLayout` 的档
        // ——排不下就整首换档，由 C 档在行内部按乐句凭据补刀（applybreaks.ts::pickCuts）。
        // 这里只留两样：非 contentOnly 那条路的老硬伤（编辑器基线按它调过，不动），
        // contentOnly 那一路一分不罚——纸张只在**方案选优**那一步当平局裁判（见 FIT_SLACK）。
        if (!CONTENT_ONLY) {
          const over = cellsIntBetween(a, b) - MAX_CELLS;
          if (over > 0) weak += 100 + over ** 2 * 8;
        }
        if (!CONTENT_ONLY) {
          // 短行同样难看（058《耶和华的心》曾在中间甩出一行只有 5 格）。末行不算——它本来可以短。
          const short = MIN_CELLS - cellsIntBetween(a, b);
          if (short > 0 && b < M) weak += short ** 2;
        }
        // 这一行的**下一行**是不是平行开头（断点 b 之后那个和弦起头）
        // **按公共前缀的长度给分**：重复得越长，把它们排成各自的行首就越值
        //（比到 12 个音封顶，再长也不多给了）。
        //
        // 试过改成「按**行首配对**算」（这一套方案里有几行的开头与另一行相同）——
        // 那更贴近「平行乐句各自成行」的本意，但奖励是**按行数归一**的，
        // 「所有行都平行」在 3 行和 6 行下都是 1.0、分不出高下，而行数少的断点也少、
        // 反而更便宜：363《倾听我的心》因此从 5 行变成 3 行（每行两个乐句）。
        // 全书 29 → 32 处、定点 15 → 23 条不过。**别再试**，除非先给内容层
        // 补上「一行该装几个乐句」的锚点。
        // **放不下的行不给平行奖励**：这条奖励的前提是「平行乐句各自成行、对齐着排」，
        // 而一行放不下就一定会被补刀切开，切完那份对齐也就没了。009《荣耀归与至高神》
        // 的「天上众军」正是靠这道闸才断在了该断的地方（全书 36 → 29 处、定点 19 → 15）。
        if (b < M && (!FIT || lineFits(a, b))) parallel += Math.min(parallelAt(cand[b - 1]), 12) / 12;
        // **这一行收在长音上吗**（`parallel` 的镜像：那条看下一行从哪儿起，这条看本行在哪儿收）。
        // 判据与 `scoreBase` 的「长音收尾」同一把尺子——标点顺延到休止/拖腔上时要往前追
        //（`carriedFrom`），行末那个音自己是不是长音不算数。
        // 「放不下的行不给奖励」也照 `parallel` 的口径：那一行终归要被补刀切开。
        if (b < M && (!FIT || lineFits(a, b))) {
          const ti = cand[b - 1];
          const tc = flat[ti].chord;
          const carried = carriedFrom[ti] >= 0 ? flat[carriedFrom[ti]].chord : null;
          // **标点被顺延走了的长音不给分**：那一句真正的收尾在后面那个收气休止上
          //（`5--- 0_` 这种），断在长音后面就把那口气甩到了下一行行首（D5）。
          // 139《主爱有多少》三行都是这么被拽过去的。
          // **后面就是收气休止的也不给分**：那口气是这一句唱完的，该留在本行行尾
          //（`headPenalty` 的 (b2) 是同一条道理）。`carriedAway` 只管本小节内的顺延，
          // 休止落在下一小节头上时它看不见——139《主爱有多少》每句都是
          // `|5-多 5-深？|0 3主 1恩 3有|`，四行因此全被拽到长音后面断开，
          // 那个 `0` 全挂到了下一行行首。
          const breath = punctAfter[ti] > 0 && !!flat[ti + 1] && flat[ti + 1].chord.rest;
          const long = carriedAway.has(ti) || breath ? false : (tc.beats >= 2 || tc.fermata);
          if (long || (carried && carried.beats >= 2)) tailLong += 1;
        }
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
        widths: (() => { const o: number[] = []; for (let a = 0; a < M; ) { const b = nb[a]; if (b <= a) break; o.push(Math.round(lineSpan(a, b))); a = b; } return o; })(),
        cv: +(EVEN_WEIGHT * 100 * cv).toFixed(2), outlier: +(OUTLIER_WEIGHT * outlier).toFixed(2),
        shortOut: +(OUTLIER_WEIGHT * shortOutlier).toFixed(2),
        lastPair: +((CONTENT_ONLY ? LAST_PAIR_QUALITY_WEIGHT * lastPair : 0)).toFixed(2),
        weak: +(breakW * (weak / cells.length)).toFixed(2),
        parallel: +(-PARALLEL_WEIGHT * (parallel / cells.length) * 10).toFixed(2),
        tailLong: +(-TAIL_LONG_WEIGHT * (tailLong / cells.length) * 10).toFixed(2) });
      return EVEN_WEIGHT * 100 * cv + OUTLIER_WEIGHT * (outlier + shortOutlier)
        + (CONTENT_ONLY ? LAST_PAIR_QUALITY_WEIGHT * lastPair : 0)
        + breakW * (weak / cells.length)
        - PARALLEL_WEIGHT * (parallel / cells.length) * 10
        - TAIL_LONG_WEIGHT * (tailLong / cells.length) * 10;
    };
    const runWith = (want: number[], lenW = RUN_WITH_LEN_WEIGHT): { nb: number[]; lines: number[] } => {
      const r = runDP((sIdx) => {
        const span = ends[cuts[sIdx]] - ends[cuts[sIdx - 1]];
        const k = want[sIdx - 1];
        return k > 0 ? span / k : TARGET_MEAS;
      }, lenW);
      return { nb: r.nextB, lines: linesPerSeg(r.nextB) };
    };
    // 候选：每段在第一遍的行数上下各试几档。
    // **contentOnly 下要双向**（−2…+2）：第一遍已经不受行长目标约束，行数是「照内容断」
    // 自然涌现的，既可能偏多也可能偏少——117《祂名称为奇妙》头三句各有一个 24 分的强断点，
    // 第一遍照着断出 7/7/13/27/24/25 格六行，而更匀的四行方案压根没被生成过。
    // 旧口径下第一遍是按行长目标排的，行数只会偏少，所以单向就够（编辑器那条路不变）。
    // **±3 而不是 ±2**：363《倾听我的心》第一遍断出 3 行，而它该是 6 行（三对平行乐句
    // 各自成行）——6 = 3 + 3，在 ±2 的窗口外，那套方案**压根没被生成过**，
    // 平行奖励再高也选不到它。搜多宽是**内容层**的事，与纸张无关。
    const deltas = CONTENT_ONLY ? [-3, -2, -1, 0, 1, 2, 3] : [0, 1, 2];
    const options: number[][] = [];
    const add = (w: number[]) => {
      if (w.some((v) => v < 1)) return;
      if (!options.some((o) => o.every((v, i) => v === w[i]))) options.push(w);
    };
    add(base.slice());
    // **另加两档倍数**：「一行一句」与「一行两句」正是原书的两种排法，两者常常差着一倍，
    // 而 ±3 的窗口够不着——169《全新的你》第一遍断出 8 行（每行两句「耶稣能够…」），
    // 它该是 12 行，12 = 8 + 4 在窗外，那套方案压根没被生成过。倍数档只多两次 DP。
    add(base.map((v) => Math.ceil(v * 1.5)));
    add(base.map((v) => v * 2));
    // **base 很小时两倍也够不着**：第一遍是「照内容断」，遇上乐句短、断点弱的谱它会
    // 交出两三行（139《主爱有多少》34 小节交出 2 行），±3 与两倍档一起才摸到 5 行，
    // 而它该是 8 行（每行两句「主爱有多少？主恩有多深？」）。再往上加两档，
    // 每档只多一次 DP；排不排得下、碎不碎由 `notTooThin` 与 `quality` 把关。
    add(base.map((v) => v * 3));
    add(base.map((v) => v * 4));
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
    /**
     * 这一套方案**排得下吗**（`FIT_SLACK` 用，见下）：既没有超出版心的行，
     * 也没有短到不足版心四成的中间行（与 line-check 的 D7 同口径——「行数多的优先」
     * 若不设这道下限，全书立刻甩出一堆短行，实测 D7 0 → 53 处）。末行不算，它本来可以短。
     */
    /** 这一套方案里**最长的一行**超出版心多少倍（1 = 正好放得下）。 */
    const overRatio = (nb: number[]): number => {
      if (!(paperCap > 0)) return 1;
      let mx = 0;
      for (let a = 0; a < M; ) { const b = nb[a]; if (b <= a) break; mx = Math.max(mx, lineSpan(a, b)); a = b; }
      return mx / paperCap;
    };
    /** 一行有多宽 / 版心有多宽：有真实坐标就用真实坐标，没有就退回格数（见 PhraseOptions.fit）。 */
    const paperCap = FIT ? FIT.width : MAX_CELLS;
    const lineSpan = (a: number, b: number): number => {
      if (!FIT) return cellsIntBetween(a, b);
      const p0 = FIT.spans.get(flat[idxAt[a] + 1]?.chord);
      const p1 = FIT.spans.get(flat[idxAt[b]]?.chord);
      return p0 && p1 ? p1.x1 - p0.x0 : cellsIntBetween(a, b);
    };
    /** 每一行（末行除外）都不短于**版心三分之一**。见 `tryWant` 里那段注释。
     *  比 `fitsPaper` 的四成松一档：144《求圣灵吹我》一句一行的八行正落在 40% 上
     *  （124 / 312），那是用户认可的排法；355《你已否祷告》被硬排出来的九行只有 34%
     *  （105 / 312），一页排下来空着三分之二。两者之间就这么一档。 */
    const notTooThin = (nb: number[], frac = 1 / 3, withLast = false): boolean => {
      if (!(paperCap > 0)) return true;
      const floor = paperCap * frac;
      const segsOf: number[] = [];
      for (let a = 0; a < M; ) { const b = nb[a]; if (b <= a) break; segsOf.push(lineSpan(a, b)); a = b; }
      return segsOf.every((c, i) => (!withLast && i === segsOf.length - 1) || c >= floor);
    };
    const fitsPaper = (nb: number[]): boolean => {
      if (!(paperCap > 0)) return true;
      const floor = paperCap * 0.4;
      const segsOf: number[] = [];
      for (let a = 0; a < M; ) { const b = nb[a]; if (b <= a) break; segsOf.push(lineSpan(a, b)); a = b; }
      return segsOf.every((c, i) => c < paperCap && (i === segsOf.length - 1 || c >= floor));
    };
    let best = { score: INF, nb: nextB };
    /** 每行都放得下的方案，连同它的行数（见 FIT_SLACK）。 */
    const fits: { score: number; nb: number[]; rows: number }[] = [];
    const rowsOf = (nb: number[]): number => {
      let n = 0;
      for (let a = 0; a < M; ) { const b = nb[a]; if (b <= a) break; n++; a = b; }
      return n;
    };
    /** 所有评过分的方案（`MORE_ROWS_SLACK` 用）。 */
    const all: { score: number; nb: number[]; rows: number }[] = [];
    const consider = (sc: number, nb: number[]): void => {
      if (sc < best.score) best = { score: sc, nb };
      all.push({ score: sc, nb, rows: rowsOf(nb) });
      if (fitsPaper(nb)) fits.push({ score: sc, nb, rows: rowsOf(nb) });
    };
    const tryWant = (want: number[]): void => {
      const got = runWith(want);
      // **要几行就真排出几行**：行长权重只有 2，断点代价一压就把行数拉回去——144
      // 《求圣灵吹我》的 `[3,1,4]`（每句一行，正是原书的排法）DP 交出的是 3 行，
      // 那套方案于是从没被评过分。排不出想要的行数就**加重行长项再排一遍**，
      // 让它真排出来，好不好交给 `quality` 说了算（权重本身不动——调高它全书会散架，
      // 见 `RUN_WITH_LEN_WEIGHT` 的注释）。
      if (CONTENT_ONLY && !got.lines.every((v, i) => v === want[i])) {
        const hard = runWith(want, RUN_WITH_LEN_WEIGHT * 4);
        // **硬排出来的那套不许细成一条线**：`quality` 里的项全是**相对**量
        // （cv / outlier / shortOutlier 都拿同一套方案里的行互比），把整首均匀切碎
        // 天生满分——355《你已否祷告》被硬排成九行，每行 2 小节、只占版心三分之一
        // （105 / 312），cv 0、每行都是平行乐句开头，分数反倒最好。
        // 原来靠「DP 自己排不出那么多行」挡着（`breakCost` 累加且非负），
        // 加重行长项就把那道闸拆了，得在这里补一条**绝对**下限。
        // 用的是 `fitsPaper` 的那条地板（版心四成，与 line-check 的 D7 同口径），
        // **只取下限不取上限**——「排不下」照旧交给补刀，不在断句层设限。
        if (notTooThin(hard.nb)) consider(quality(hard.nb), hard.nb);
      }
      // **排不出想要的行数也照样评分**：DP 会退回它自己觉得合适的行数，而那套方案本身
      // 是完全合法的——原来一句 `if (行数对不上) return` 把它当废票丢掉，于是
      // 169《全新的你》要 14 行、DP 交出 12 行（正是该要的那套），却从没进过候选池。
      // 重复的方案再评一次分无害（同一套 nb，分数一样）。
      consider(quality(got.nb), got.nb);
    };
    for (const want of options) tryWant(want);
    // **一套放得下的都没有 → 往行数多的方向再找**（`FIT_SLACK` 开着时）。
    // 候选行数只在第一遍的基础上 ±2 里挑，而第一遍是「照内容断」出来的，可能整整差一倍：
    // 139《主爱有多少》容量 31，候选只有 2/3/4 行（每行 28~37 格），没有一套放得下，
    // 补刀于是逐行开刀，排出 4/5/5/4/4/4/8 小节这样参差的七行。按容量估出「这一段至少要
    // 几行」再往上试两档，DP 自己就能排出每行 4 小节。
    if (FIT_SLACK > 0 && !fits.length && MAX_CELLS > 0) {
      const need = base.map((_, i) => {
        const lo = cuts[i];
        const hi = cuts[i + 1] ?? M;
        return Math.max(1, Math.ceil(lineSpan(lo, hi) / paperCap));
      });
      for (let d = 0; d <= 2; d++) tryWant(need.map((v, i) => Math.max(base[i], v) + d));
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
    consider(quality(nextB), nextB);
    /**
     * **纸张只当平局的裁判**（用户口径：「断句结果只有 2 行超长行的，应该选 4 行更短的」）。
     *
     * 断句层照旧不把容量算进代价——试过给 `quality` 加一项软的超容量代价，全书七档一起变差
     * （D7 0→2、D3 3→4、D8 11→13、D6 4→5，定点 9→12），**别再试**。真正的毛病不是
     * 「DP 不知道纸有多宽」，而是**它把一套明明放得下、分数只差一点的方案丢掉了**：
     * 070《天使歌唱》容量 36 时最优的 `[1,1]` 是 2 行、其中一行 64 格（q=−30），
     * 而 4 行的 `[2,2]`（16/16/30/34 格，全放得下）只差 0.85 分。选了前者，
     * 补刀就得替 DP 做分行的活，排版器照样折行，容量收敛循环再把 36 一路收到 26。
     *
     * 所以只做一件事：**在「每行都放得下」的方案里挑最好的那套，只要它与最优方案的差距
     * 在 `FIT_SLACK` 之内就用它**。代价函数一分没动，纸张只在两套方案难分高下时开口。
     */
    /**
     * **行数多的方案优先**（用户口径：「优先选择行数更多的结果，最后再看是否要两行两行
     * 合并」）——并回去是 B 档 `mergePairsUniform` 的活，而把一行劈开谁也补不回来。
     *
     * 这是**内容层**的规则，与版心无关。它要顶掉的是评分里的一处结构性偏袒：
     * `breakCost` 在 contentOnly 下是 `8 × (1 − 强度/24)`，**永远 ≥ 0**——强断点只是便宜、
     * 从不赚钱，于是「每断一刀都付钱、不断一刀不付钱」；而 cv 与 outlier 都是**相对**量
     * （一行到底天然最匀、max/median 就是 1）。凭据弱的谱子因此必然排成一行：
     * 066《普世欢腾》十九个小节一个断点都没有（它的乐句落点只有逗号 4 分 + 平行 2 分，
     * 中间**一个句号都没有**）。
     */
    if (MORE_ROWS_SLACK > 0) {
      // **多出来的那一行得是一整行**：这条口径要顶掉的是「宁可把一行劈开也不多排一行」，
      // 可要是多排出来的行只占版心三成，那不是多排一行、那是甩出个碎行——355《你已否祷告》
      // 「是否已奉基督圣名，」被单摆成 2 小节一行（105 / 312），而它本该与后两句合成
      // 6 小节的一行（288 / 312）。
      // 门槛 **35%**，两头都是拿具体曲子卡出来的：355 那条碎行 105 / 312 = 33.7%（要挡掉），
      // 096《哈利路亚！感谢主》用户认可的四行里最短的 111 / 312 = 35.6%（要放行）。
      // 比硬排那道闸（三分之一）严一点点——那边只要求「别细成一条线」，这边还要求
      // 「多出来的确实算一行」。
      // **末行也要算**（与别处不同）：末行本来可以短，可这里比的是「多排一行值不值」
      // ——多切一刀把末行削成一小截，那截短的正是多出来的那一行。103《我主耶稣，惟祢是配》
      // 副歌本该两行各 4 小节（205 / 208 宽、各收在一个长音上），却被切成 3+3+2，
      // 末行只剩 97 / 312。
      const ok = all.filter((f) => f.score <= best.score + MORE_ROWS_SLACK && notTooThin(f.nb, 0.35, true));
      ok.sort((a, b) => b.rows - a.rows || a.score - b.score);
      if (ok.length) best = { score: ok[0].score, nb: ok[0].nb };
    }
    // 容差之内**优先行数多的那套**（纸张那一层；`phraseFitSlack = 0` 时整层关掉）。
    // **但「撂挑子」那一档与 `FIT_SLACK` 无关**：DP 交出一行长到版心的 1.8 倍，
    // 那不是「差一点放不下」、也不是「纸张来影响断句」，那是断句层根本没干活
    // ——`weak` 取行均值，一行到底连一个可选断点都没有、均值天然是 0，
    // `cv` 也是 0（每段只有一行，`segCv` 直接返回 0），这种退化解在评分上永远赢。
    // 297《让神儿子的爱围绕你》整个主歌 17 小节排成一行（765 / 312），
    // 四行的方案（每行 4 小节、一三行与二四行各自开头相同）q 差了 5.2 分选不上，
    // 主歌于是全交给补刀，按匀度切成 18 / 24 / 25 拍，平行乐句的开头一个也没对齐。
    const abdicated = overRatio(best.nb) >= ABDICATE_RATIO;
    if (FIT_SLACK > 0 || abdicated) {
      // **DP 交出一行长到两倍版心时，容差不设上限**：那不是「差一点放不下」，那是断句层
      // 撂挑子了——066《普世欢腾》十九个小节一个断点都没有（`weak` 取行均值，一行到底
      // 连断点都没有、均值天然是 0，永远赢；cv 也是 0）。这种退化解不能靠补刀去救：
      // 补刀只在那一行内部挑落点，挑出来的三行 13.5/8/16.5 拍照样不齐。
      const slack = abdicated ? Infinity : FIT_SLACK;
      const ok = fits.filter((f) => f.score <= best.score + slack);
      ok.sort((a, b) => b.rows - a.rows || a.score - b.score);
      if (ok.length) best = { score: ok[0].score, nb: ok[0].nb };
    }
    // @ts-ignore 调试钩子：段界
    if (typeof window !== "undefined" && (window as any).__cutsDebug !== undefined)
      (window as any).__cutsDebug = { cuts: cuts.map((c) => (c === 0 ? 0 : flat[cand[c - 1]].mi + 1)), M, segs: cuts.length - 1 };
    nextB = best.nb;
  }

  // 全部候选断点连同凭据分带出去（见 PhraseBreaks.cuts）。候选之外的位置不带——
  // 那些地方连乐句信号都没有（`cand` 收的是「小节末」或「有乐句信号」的可断处），
  // 补刀落在那儿本来就该按位置挑。**行内候选也带**：落不落在小节线上由补刀层按权重定。
  for (const idx of cand) {
    cutList.push({ chord: flat[idx].chord, mi: flat[idx].mi, isLast: flat[idx].isLast,
      score: scoreAt(idx) - headPenalty(idx), end: endAfter[idx], parallel: Math.min(parallelAt(idx), 12) });
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

  return { measureBreaks, midBreaks, sectionStarts, sectionCutChords, refrainCut, forced, cuts: cutList, capacityCuts };
}
