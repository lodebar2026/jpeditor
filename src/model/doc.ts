// `ScoreDoc`——歌谱的**语义模型**，123 格式（简谱主格式）与 MusicXML（五线谱主格式）共用。
//
// ## 它在四个模型里的位置（**改这个文件前先读这一段**）
//
// | 模型 | 现在 | 终局 |
// |---|---|---|
// | **`ScoreDoc`**（本文件） | 123 的原生模型 | **唯一语义模型**，其余向它汇聚 |
// | `Score`（`score/score.ts`） | 简谱排版/MIDI/乐句断句吃它，**装不下力度/多声部**；和弦只在 MusicXML 进来那一路留得住 | 退役 |
// | ~~`MixedScore`~~ | 原先五线谱**语义 + 排版**混在一起 | **已删**（R2 阶段 10）：五线谱引擎只留版面态 `StaffLayout`（`mixed/model.ts`），语义一律从这里取 |
// | `PuDoc`（`pu/ast.ts`） | 文本谱解析器的产物，**只在进 `ScoreDoc` 之前与乐句重排（改写原文）里活着** | 退役 |
//
// 文本谱/123/ABC 的排版、`Score`、MusicXML 导出、双向定位都直接吃 `ScoreDoc`，
// 经 `pu/slots.ts::docView` 线性化成排版行（那是排版的事，不是模型的事）。
//
// ## 设计依据（不是凭空设计）
//
// - 层级照 MusicXML：声部 → 小节 → 元素。`PuDoc` 那种扁平元素流每次对接 MusicXML 都得重摊一遍。
// - 字段清单以混排原先直接读 DOM 的 `mixed/loader.ts` 实读的 88 个 MusicXML 元素为基准（阶段 6 混排改读本模型，缺的补齐后删掉了它），叠加 `scripts/census-123.mjs`
//   对 500 首的实测（`<harmony>` 100% 的曲目都有、`<print new-system>` 100%、`lyric number` 到 8 段）。
// - **绝对音高与简谱度数并存、可互推**：沿用 `score.ts::Note` 的既有做法（`pitch` + `number/jpOctave`），
//   换算判据含「无点 1 的绝对音高」那条国标规则，**必须与 `jppitch.ts::jpTonicOctaveShift` 同源**。
// - **元素一律带稳定 `id`**，`Mark` / 歌词锚点 / `playOrder` 全部引用 id。`PuDoc` 用数组下标区间，
//   插一个元素就全错；MusicXML 用 `number` 属性配对，同样需要显式 id。
//
// ## 本轮填到哪
//
// 字段**全部定义**（含五线谱侧），但只填 123 与现有来源给得出的部分。标 `[五线谱]` 的本轮
// **定义但留空**，等 `ScoreDoc ↔ MusicXML` 直通那一轮再填——先把位置留正确，免得将来改结构。
// 直通已落地；版面坐标（`Position`、小节宽、符干、`staff-details`）也由 `fromxml.ts` 填上了，
// 只为整份重写不丢，排版不读。
//
// 枚举一律用**字符串字面量联合**、取值与 MusicXML token 同名：JSON 化干净，且与
// `score/enums.ts` 的字符串枚举值可直接互转。
//
// **无 DOM 依赖**（Node CLI 要 import 它）。

// ───────────────────────── 基础 ─────────────────────────

/** 源码区间。语法高亮、谱面点选定位、诊断报错全靠它。
 *  结构与 `pu/ast.ts::SourceSpan` 相同，TS 结构化类型下可直接互转。 */
export interface SourceSpan {
  /** 0 基行号 */
  line: number;
  /** 行内 0 基列 */
  column: number;
  /** 全文 0 基字符偏移 */
  offset: number;
  length: number;
}

export type DiagnosticSeverity = "warning" | "error";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** 机器可读短代码，如 "unknown-field" */
  code: string;
  message: string;
  source: SourceSpan;
}

/** 元素 id。解析期分配、全文档唯一、**不随数组增删变化**。 */
export type ElementId = number;

/** [五线谱] 版面坐标（tenths，口径同 MusicXML 的 `default-x/-y`、`relative-x/-y`）。
 *  **只为 `.musicxml` 改动后整份重写不丢版面**：`fromxml.ts` 读、`toxml.ts` 写，排版不读。
 *  断行也是「这份谱怎么印」的事实，同理随文档保存（`Print`），见 `docs/待办.md` §3.1。 */
export interface Position {
  defaultX?: number;
  defaultY?: number;
  relativeX?: number;
  relativeY?: number;
}

/** 水平/竖直对齐（`justify` / `halign` / `valign`）。 */
export type HAlign = "left" | "center" | "right";

// ───────────────────────── 头部与元信息 ─────────────────────────

/** 曲目标识。← 123 的 `X:` / `T:`（第一条主标题，其后为副标题） */
export interface Work {
  /** 曲号原文（可能是 "J07" 这种带字母的） */
  number?: string;
  title?: string;
  /** MusicXML 的 `<movement-title>` */
  movementTitle?: string;
  subtitles: string[];
  /** 文本谱 `V:` 版本号原文 */
  version?: string;
}

/** ← 123 的 `C:` / 文本谱 `Z:` / MusicXML `<identification><creator>` */
export interface Creator {
  /** MusicXML 的 `type`：composer / lyricist / arranger / translator… */
  type: string;
  text: string;
}

export interface Identification {
  creators: Creator[];
  rights?: string;
  /** `<encoding><software>`，按出现顺序全留（Sibelius 导出写两条，混排按任一条认编码软件） */
  software?: string[];
}

/** `<credit>`：带版式与坐标的标题块文字。导出 MusicXML 时要照原样写回
 *  （`docs/实现/MusicXML-导出.md`：有任何 `<credit>` 就不再用 `<work-title>` 生成标题）。 */
export interface Credit {
  /** `credit-type`：title / subtitle / composer / lyricist / rights… */
  type?: string;
  text: string;
  /** 左下原点坐标系，与 MusicXML 一致 */
  x?: number;
  y?: number;
  fontSize?: number;
  /** `<credit-words justify>`。与 `halign` 分开存：混排只认 `justify`（语料 5 份只写了 `halign`） */
  justify?: HAlign;
  halign?: HAlign;
  page?: number;
}

/** 字体属性（`font-family` / `font-size`（pt）/ `font-weight`）。 */
export interface FontSpec {
  family?: string;
  size?: number;
  weight?: string;
}

/** [五线谱] `<defaults>`：版面默认值。本轮留空。 */
export interface Defaults {
  /** `<scaling>`：millimeters / tenths */
  scaling?: { millimeters: number; tenths: number };
  pageLayout?: {
    pageWidth?: number;
    pageHeight?: number;
    /** `<page-margins>`，按出现顺序全留（奇偶页分开写时有两份） */
    margins?: { left: number; right: number; top: number; bottom: number; oddEven?: "odd" | "even" | "both" }[];
  };
  systemLayout?: { systemDistance?: number; topSystemDistance?: number; leftMargin?: number; rightMargin?: number };
  staffLayout?: { staffDistance?: number };
  /** `<lyric-font>` / `<word-font>`：歌词与文字的缺省字体（语料 100% 都有） */
  lyricFont?: FontSpec;
  wordFont?: FontSpec;
}

/** [五线谱] `<part-group>`：SATB 的括号分组。← 123 的 `%%score {(S A) (T B)}` */
export interface PartGroup {
  number: string;
  /** `<group-symbol>`：brace / bracket / line / square / none */
  symbol?: "brace" | "bracket" | "line" | "square" | "none";
  name?: string;
  abbrev?: string;
  /** 组内是否连小节线 */
  groupBarline?: boolean;
  /** 组覆盖的 part id */
  parts: string[];
}

// ───────────────────────── 调号 / 拍号 / 谱号 ─────────────────────────

/** 调号。**简谱要首调、五线谱要记谱调，两者并存**：
 *  `fifths` 是 MusicXML 的升降号数（-7..7），`tonicDegree` 是简谱的主音唱名
 *  （`1=G` 记 "1"，小调写法 `6=E` 记 "6"，语料里占 0.01% 但真实存在）。 */
export interface Key {
  fifths: number;
  /** major / minor / dorian…；`K:Em` 这类带 mode 的写法靠它表达 */
  mode?: string;
  /** 调号**拼写**，如 "bB" / "#F"。不能只存 fifths——
   *  `1=#C`/`1=bD`/`1=#F`/`1=bG` 四个调整首排不出来（见 `MusicCommon.jpToStep` 那条判据）。 */
  spelling?: string;
  /** 简谱主音唱名，缺省 "1" */
  tonicDegree?: string;
  /** 调号在谱面上的**原文**（文本谱写 `♭A`，`spelling` 归一成 `bA`）。排版照原文印 */
  display?: string;
  /** `<key>` 的显式临时记号（`K:D exp _b _e ^f`） */
  explicitAccidentals?: { step: string; alter: number }[];
  /** [五线谱] `<cancel>`：转调时先印的还原号个数（带号，同 `fifths` 口径） */
  cancel?: number;
}

export interface Time {
  beats: number;
  beatType: number;
  /** `<time symbol>`：common / cut / single-number / normal */
  symbol?: string;
  /** 辅助拍号写在括号里（文本谱 `P: 4/4 ( 2/4 )`） */
  parenthesized?: boolean;
}

/** [五线谱] `<clef>` */
export interface Clef {
  sign: "G" | "F" | "C" | "percussion" | "TAB" | "none";
  line?: number;
  /** `<clef-octave-change>`：treble-8 那种 */
  octaveChange?: number;
  /** 多谱表时这个谱号属于第几谱表 */
  staff?: number;
}

/** [五线谱] `<transpose>`：移调乐器 */
export interface Transpose {
  diatonic?: number;
  chromatic: number;
  octaveChange?: number;
}

// ───────────────────────── 音高与时值 ─────────────────────────

/** 绝对音高（MusicXML 侧） */
export interface Pitch {
  step: "A" | "B" | "C" | "D" | "E" | "F" | "G";
  /** 半音升降，-2..2 */
  alter: number;
  /** MusicXML 八度，中央 C 所在八度为 4 */
  octave: number;
}

export type Accidental =
  | "sharp"
  | "flat"
  | "natural"
  | "double-sharp"
  | "double-flat";

/** 简谱度数（123 侧）。与 `Pitch` 并存、可互推（见 `helpers.ts`）。 */
export interface Degree {
  /** 唱名 0..7，`0` 是休止 */
  number: number;
  /** 八度点：正为高音点个数、负为低音点个数 */
  octaveShift: number;
  accidental?: Accidental;
}

/** MusicXML `<type>` */
export type NoteType =
  | "maxima" | "long" | "breve" | "whole" | "half" | "quarter"
  | "eighth" | "16th" | "32nd" | "64th" | "128th" | "256th";

/** 时值。`divisions` 相对所在小节 `MeasureAttrs.divisions`（MusicXML 的算法）。 */
export interface Duration {
  divisions: number;
  /** 符号时值。倚音与无时值占位可缺省 */
  type?: NoteType;
  dots: number;
  /** `<time-modification>`：三连音等 */
  timeMod?: { actual: number; normal: number; normalType?: NoteType };
}

/** 符杠逐层状态。取值同 MusicXML `<beam>`。 */
export type BeamVal = "begin" | "continue" | "end" | "forward hook" | "backward hook";

// ───────────────────────── 和弦符号 / 歌词 / 记号 ─────────────────────────

/** 和弦符号 `<harmony>`。**500 首 MusicXML 100% 都有，共 12646 个**——
 *  经 `Score` 会全部丢失，这是新模型存在的首要理由。 */
export interface Harmony {
  root: { step: string; alter: number };
  /** `<kind>`：major / minor / dominant / major-seventh… */
  kind: string;
  /** 面上要印的原文（`<kind text=>`），如 "m7"、"Δ" */
  kindText?: string;
  bass?: { step: string; alter: number };
  degrees?: { value: number; alter: number; type: "add" | "alter" | "subtract" }[];
  /** 整段和弦只有文字、解析不出结构时的原文兜底（识别结果常是这种） */
  text?: string;
  /** `<offset>`：相对所修饰音符起点的 divisions（增时线上的和弦由 `xmlproject.ts` 填） */
  offset?: number;
  /** [五线谱] 见 `Position` */
  pos?: Position;
  /** [五线谱] `<kind halign>` */
  kindHalign?: HAlign;
  /** [五线谱] `<kind use-symbols>` / `<kind parentheses-degrees>` */
  useSymbols?: boolean;
  parenthesesDegrees?: boolean;
  /** [五线谱] `<harmony staff>`（多谱表时挂在哪个谱表） */
  staff?: number;
  /** [五线谱] 见 `Chord.onset`。缺省 = 所挂元素的起点 */
  onset?: number;
}

export interface Lyric {
  /** 段号。MusicXML 的 `number`，123 的 `w1:` */
  number: number;
  /** 段号区间的上界：`w1-6:` 时为 6，单段时缺省 */
  numberTo?: number;
  text: string;
  /** `<syllabic>`：single / begin / middle / end */
  syllabic?: "single" | "begin" | "middle" | "end";
  /** `<extend>`：续记号（一字多音），123 的 `_` */
  extend?: boolean;
  /** [五线谱] `<extend type>`。有 stop 的谱按起止两两配对，裸 `<extend/>` 不写（混排两种画法不同） */
  extendType?: "start" | "stop" | "continue";
  /** [五线谱] `<lyric number>` 不是纯数字时的原文（Sibelius 写 `part1verse1` / `chorus`）。
   *  `number` 是解析出的段号；混排按原文分段 */
  numberText?: string;
  /** [五线谱] `<lyric name>` */
  name?: string;
  /** `<elision>`：一音多字的连接（123 的 `{多字}` / ABC 的 `~`） */
  elision?: string;
  /** 副歌：这一行词被多遍共用（`Lyric.refrain` 的对应物） */
  refrain?: boolean;
  /** 收尾标点。**并入前一字、不占音符格**（规则在 `common/cjkpunct.ts`） */
  trailingPunctuation?: string;
  /** 印刷段号（`<1.>`）：印在该段歌词首字之前、**不占音符格**。语料 55.6% 这么写 */
  verseLabel?: string;
  /** 字前的标点（行首的 `《`、`（` 这类没有前字可并的）。
   *  **不能并进 `text`**——并进去会改变音节的字数，让 emit 的「多字并一格要包 `{}`」
   *  判断在往返中翻来覆去。 */
  leadingPunctuation?: string;
  /** 文本谱同一行曲下**同一段号出现多行歌词**（收尾改写）时，这个字属于 `Print.lyricLines` 的第几行。
   *  只在有歧义时写 */
  lineIndex?: number;
  /** [五线谱] 见 `Position` */
  pos?: Position;
  /** [五线谱] `<lyric justify>` */
  justify?: HAlign;
  source?: SourceSpan;
}

/** 音符上的各类记号 `<notations>` */
export interface Notations {
  /** accent / staccato / tenuto / marcato… */
  articulations?: string[];
  /** trill-mark / mordent / turn…（[五线谱] 本轮留空） */
  ornaments?: string[];
  /** [五线谱] `<technical>`。本轮留空 */
  technical?: string[];
  fermata?: boolean;
  /** [五线谱] `<fermata type="inverted">`：倒置延长记号（画在下方） */
  fermataInverted?: boolean;
  arpeggiate?: boolean;
  glissando?: boolean;
}

/** 简谱记号**原名**（文本谱的 `&xx`，`level` = 紧跟的 `+` 个数，抬高位置/区分变体）。
 *
 *  为什么不只存 `Notations`：简谱记号有六十来种，排版要照原名画、按 level 抬高，
 *  而 MusicXML 那一侧只认得其中一部分（fermata / 力度 / 跳转…）。所以两份并存：
 *  `ornaments` 是排版依据，`notations` / `Measure.directions` 是它的语义投影（导出、123 用）。 */
export interface SourceOrnament {
  name: string;
  level: number;
}

/** 文本谱里**夹在符号之间**、自己不占时值的东西，挂在紧随其后的那个符号上（行末的挂 `Measure.trailing`）。
 *
 *  - `boundary`：`~` 强制连进一拍 / `^` 强制切开，只影响减时线连断
 *  - `layer`：`{bz…}` 临时伴奏（上方小字一行）/ `{dsb…}` 临时多声部（并排块），
 *    内容是一段自带小节与记号的独立元素流，排在宿主符号处 */
export type InlineItem =
  | { kind: "boundary"; behavior: "join" | "split"; source?: SourceSpan }
  | { kind: "layer"; role: "accompaniment" | "voice"; measures: Measure[]; marks: Mark[]; source?: SourceSpan };

// ───────────────────────── 元素 ─────────────────────────

/** 增时线（简谱的 `-`）。
 *
 *  **为什么它是独立可挂载的东西，而时值仍记在 `Chord.duration` 上**：
 *  语义上 `5 - -` 就是一个三拍音符（与 MusicXML 一致，所以时值归 `duration`），
 *  但简谱排版要逐条画，而且**和弦可以挂在增时线上**（语料实测 190 次，规范 §8.1）——
 *  所以每条增时线要有自己的 id 与挂载位。 */
export interface Sustain {
  id: ElementId;
  harmony?: Harmony;
  notations?: Notations;
  /** 见 `SourceOrnament` */
  ornaments?: SourceOrnament[];
  /** 增时线上方的注记（文本谱 `- "…"`） */
  sectionWord?: string;
  /** 是否跟歌词。缺省不跟；文本谱 `-@` 为 true */
  lyricAnchor?: boolean;
  /** `-@` 跟的那个字 */
  lyrics?: Lyric[];
  /** 见 `InlineItem` */
  before?: InlineItem[];
  source?: SourceSpan;
}

/** 倚音信息 `<grace>` */
export interface GraceInfo {
  /** `<grace slash=>`：倚音符杠上的斜线 */
  slash?: boolean;
  stealTimePrevious?: number;
  stealTimeFollowing?: number;
  /** 后倚音（文本谱 `"hyy:…"` / `[h…]`）：排在主音**之后** */
  after?: boolean;
}

/** 休止信息。`<rest measure="yes">` 是整小节休止。 */
export interface RestInfo {
  measure?: boolean;
  /** 休止也可以定在某个音高上（`<rest><display-step>`） */
  displayPitch?: Pitch;
  /** 文本谱里休止符上带的八度点（`0'`，语料里真有），排版照画 */
  octaveShift?: number;
}

/** 一个时间位置上的内容：一个音、一组同时发声的音（和弦音）、或一个休止。
 *  容器式（与 `Score.Chord` / `MixedScore.MChord` 一致），便于把 MusicXML 的
 *  `<chord>` 标记聚合回同一时间点。 */
export interface Chord {
  kind: "chord";
  id: ElementId;
  /** 同时发声的音。休止时为空数组 */
  notes: Note[];
  /** 非空即休止 */
  rest?: RestInfo;
  /** 非空即倚音（倚音不占 `duration`） */
  grace?: GraceInfo;
  duration: Duration;
  /** 增时线，按出现顺序 */
  sustains?: Sustain[];
  voice: number;
  staff: number;
  /** 逐层符杠状态（减时线层数 = 数组长度） */
  beams?: BeamVal[];
  /** 123 的**空白分组**落点：同号者在一条符杠下。由解析器按 ABC §4.7 的空白规则算出 */
  beamGroup?: number;
  /** 和弦符号可挂在任意元素上（音符 / 休止 / 增时线 / 占位符）——规范 §8.1 的四种锚定 */
  harmony?: Harmony;
  /** 同一个音前面连着的**后续**和弦（MusicXML 一个 `<note>` 前多个 `<harmony>`，后面的带 `offset` 落在长音中间）。
   *  简谱侧没有这个位置：进简谱形状时挂到对应的增时线上（`jianpuproject.ts`） */
  laterHarmonies?: Harmony[];
  lyrics?: Lyric[];
  notations?: Notations;
  /** 段落词（「（副歌）」这类印在谱上的提示） */
  sectionWord?: string;
  /** 节奏音符：**有声但无音高**（文本谱的 `X` / 番茄的 `9`）。
   *  与休止不同（休止无声），也与不可见休止 `x` 不同（那个无声）。123 写成 `X`。 */
  rhythm?: boolean;
  /** `print-object="no"`：不可见 */
  printObject?: boolean;
  /** 是否参与歌词对位。**缺省 = 非休止**；只在与缺省不同时写（文本谱的 `0@`、隐藏休止 `8`/`9`） */
  lyricAnchor?: boolean;
  /** 见 `SourceOrnament` */
  ornaments?: SourceOrnament[];
  /** **承接前音的延长**：小节线/换行之后开头的增时线（文本谱 `5 - | - -`）。
   *  这个和弦本身印成一条增时线、不印符头，音高照抄前音——只为文本谱排版无损而留。
   *  **不需要支持**别的表达：123 写出端跳过它，导出 MusicXML 按普通音符写（不补 tie） */
  continued?: boolean;
  /** 见 `InlineItem` */
  before?: InlineItem[];
  /** [五线谱] `<cue/>`：提示音（不发声的小音符） */
  cue?: boolean;
  /** [五线谱] `<type size>`：cue / grace-cue / large… */
  typeSize?: string;
  /** [五线谱] 没有 `Note` 可挂时（休止、节奏音符）的 `<note default-x…>`；有音时坐标在各 `Note.pos` */
  pos?: Position;
  /** [五线谱] 小节内起点（divisions）：MusicXML 靠 `<backup>`/`<forward>` 挪游标，多声部同一小节里各声部从头排。
   *  **缺省 = 前一个元素的终点**（首个元素为 0）；只在与缺省不同时写。`toxml.ts` 按它补回 `<backup>`/`<forward>` */
  onset?: number;
  source?: SourceSpan;
}

/** 单个音。音高两侧并存：`pitch` 给五线谱、`degree` 给简谱，由 `helpers.ts` 互推。 */
export interface Note {
  pitch?: Pitch;
  degree?: Degree;
  /** 面上要印的临时记号（与 `pitch.alter` 不同：alter 是音高，这个是**是否画出来**） */
  accidental?: Accidental;
  /** [五线谱] `<accidental parentheses="yes">` */
  accidentalParentheses?: boolean;
  /** 延音线。跨小节、跨行都靠它 */
  tie?: { start?: boolean; stop?: boolean };
  /** [五线谱] `<notehead>` */
  notehead?: string;
  /** [五线谱] 符干方向 */
  stem?: "up" | "down" | "none" | "double";
  /** [五线谱] `<stem default-y>`：符干末端 */
  stemY?: number;
  /** [五线谱] 这个音所在 `<note>` 的坐标，见 `Position` */
  pos?: Position;
}

/** 无时值占位 `y` 与不可见休止 `x`。
 *
 *  - `y`：**不占时间**，专供挂和弦与记号——这是规范 §8.1「和弦完全没有对位音符」
 *    （小节起始、跨行延音、只有和弦的前奏/间奏，语料实测 72 次）的承载处。沿用 ABC 的 spacer。
 *  - `x`：**占**时值的不可见休止，对应文本谱的隐藏休止 `8`（跟词）/ `9`（诗歌本，不跟词）。 */
export interface Space {
  kind: "space";
  id: ElementId;
  spacer: "y" | "x";
  /** `y` 无时值；`x` 有 */
  duration?: Duration;
  /** 逐层符杠（`x` 也能带减时线：`x_`） */
  beams?: BeamVal[];
  voice: number;
  staff: number;
  harmony?: Harmony;
  lyrics?: Lyric[];
  notations?: Notations;
  /** [五线谱] 见 `Chord.onset`（`y` 不占时值，只标位置） */
  onset?: number;
  source?: SourceSpan;
}

export type Element = Chord | Space;

// ───────────────────────── 小节 ─────────────────────────

/** 小节线样式。取值同 MusicXML `<bar-style>`，与 `score/enums.ts::BarStyle` 可直接互转。 */
export type BarStyle =
  | "regular" | "dotted" | "dashed" | "heavy"
  | "light-light" | "light-heavy" | "heavy-light" | "heavy-heavy"
  | "tick" | "short" | "none";

/** 房号 `<ending>`。
 *  **`text` 存原文**：排版要照原文画（语料里有 "1, 2" 带逗号、"1.-3." 带区间这些写法，
 *  `line-check` 的 V5 判据就卡在这儿）。 */
export interface Ending {
  numbers: number[];
  text?: string;
  type: "start" | "stop" | "discontinue";
  /** 抬高级别（文本谱 `[+1`），挂在 start 上 */
  level?: number;
  /** 跨行时后续各行那一段的抬高级别（文本谱续行会重新编 level），挂在 start 上 */
  continuationLevels?: number[];
  /** 文本谱把 `[` 写在**上一行行尾**（最后一根小节线之后）：上一行留一段空的起头。挂在 start 上 */
  leadInPreviousLine?: boolean;
  /** 文本谱房号起点相对「该小节第一个符号」的偏移（写在前一根小节线上为 -1）。挂在 start 上 */
  startOffset?: number;
  /** 文本谱房号终点相对「该小节最后一个符号（含右小节线）」的偏移。挂在 stop 上 */
  endOffset?: number;
  /** start 与 stop 的配对号。文本谱解析器会留下跨行永不收口的房号、与后面的房号**重叠**，按先后配不对 */
  pair?: number;
  /** 行尾起头、但后面**再没有续行**接上的房号（解析器留下的）：挂在本行末小节一条无样式的右线上，只画那段空起头 */
  danglingLead?: boolean;
  /** 原文没写房号文字（`numbers` 是缺省补的 1），排版不印数字。挂在 start 上 */
  captionless?: boolean;
  /** 起止倒置的空房号（原文 `[1` 紧跟着就收了）：只有 start，不画线段。挂在 start 上 */
  collapsed?: boolean;
  /** [五线谱] `<ending print-object="no">`：只记遍次、不画 */
  printObject?: boolean;
}

export interface Barline {
  location: "left" | "right" | "middle";
  style?: BarStyle;
  /** `|:` / `:|` */
  repeat?: "forward" | "backward";
  /** 反复次数（`|::` 唱三遍） */
  repeatTimes?: number;
  ending?: Ending;
  /** 小节线上的跳转记号：segno / coda / fine / D.C. / D.S.（123 的 `!xx!`） */
  jump?: string;
  /** 文本谱 `:|:`（左右都反复）：`repeat` 记 backward，这一位补上 forward */
  alsoForward?: boolean;
  /** 不显形**也不占宽**（文本谱 `|/`）。`style: "none"` 单独出现是不显形但占宽（`|*`） */
  noWidth?: boolean;
  /** 小节线上的记号原名（`&fine` `&dc` `&ds` `&sbf`…），见 `SourceOrnament` */
  ornaments?: SourceOrnament[];
  /** 小节线上标注的临时拍号（文本谱 `"p:3/4"`），自下一小节起生效 */
  time?: Time;
  /** 小节线上的注记文字 */
  annotation?: string;
  /** 见 `InlineItem` */
  before?: InlineItem[];
  /** `location === "middle"` 时：它排在本小节第几个元素之后。
   *  不可见小节线 `[|]` 常落在小节中间，丢了位置就会把两个小节并成一个 */
  afterElements?: number;
  source?: SourceSpan;
}

export interface MeasureAttrs {
  divisions?: number;
  key?: Key;
  time?: Time;
  /** [五线谱] */
  clefs?: Clef[];
  /** [五线谱] 本小节起的谱表数 */
  staves?: number;
  /** [五线谱] */
  transpose?: Transpose;
  /** [五线谱] `<staff-details>`：`print-object="no"` 是空谱表隐藏（混排 `applyStaffVisibility` 读它） */
  staffDetails?: { staff?: number; printObject?: boolean }[];
}

/** `<direction>`：挂在小节某个时间点上的指示。 */
export interface Direction {
  /** 相对小节起点的 divisions 偏移 */
  offset?: number;
  /** 它排在本小节第几个元素之后（MusicXML 源里 `<direction>` 前面有几个音符，同 `Barline.afterElements`）。
   *  缺省 = 小节开头。`<direction>` 的拍位就是游标当时的位置：`Fine` / `D.S.` / segno 常写在小节末尾，
   *  丢了它，演唱顺序的跳转落点（segno/coda 的小节内位置）和写回的位置都不对 */
  afterElements?: number;
  /** dynamics / wedge / words / metronome / segno / coda / pedal / octave-shift / rehearsal；
   *  `sound` 是小节级的 `<sound>`（不在 `<direction>` 里，只有 `sound` 与 `xml`） */
  type: string;
  /** `type: "sound"` 时的原文（`<sound>` 可带 `<swing>` 等子元素），`toxml.ts` 原样写回 */
  xml?: string;
  /** 力度名（`f` / `mf`…）或文字内容 */
  text?: string;
  /** `<metronome>`：♩=76。`perMinuteText` 是 `<per-minute>` 不是纯数字时的原文（「132 温馨、期盼的」） */
  tempo?: { beatUnit?: NoteType; perMinute?: number; perMinuteText?: string };
  /** wedge / pedal / octave-shift 的起止，与 `Mark` 配对用 */
  spanType?: "start" | "stop" | "continue";
  /** `<wedge type>`：crescendo / diminuendo */
  wedgeType?: "crescendo" | "diminuendo";
  /** 上方还是下方 */
  placement?: "above" | "below";
  /** `<sound>` 的播放语义：dacapo / dalsegno / fine / segno / coda / tempo */
  sound?: { dacapo?: boolean; dalsegno?: string; fine?: boolean; segno?: string; coda?: string; tocoda?: string; tempo?: number };
  voice?: number;
  staff?: number;
  /** [五线谱] 首个 direction-type 子元素（words/dynamics…）上的坐标，见 `Position` */
  pos?: Position;
  /** [五线谱] 同上那个子元素的 `justify` / `halign` / `valign` */
  justify?: HAlign;
  halign?: HAlign;
  valign?: string;
  /** [五线谱] 同上那个子元素的字体（`words` / `metronome`） */
  font?: FontSpec;
  /** [五线谱] `<pedal line>` */
  line?: boolean;
  /** [五线谱] 同一 `<direction>` 里其余的子元素（多行诗文写成几个 `<words>`），字段口径同上 */
  more?: DirectionPart[];
  /** [五线谱] 见 `Chord.onset`。缺省 = 它前面那个元素的终点（`afterElements` 为 0 时是 0） */
  onset?: number;
  source?: SourceSpan;
}

/** `Direction.more` 的一项：`<direction-type>` 下的一个子元素。 */
export type DirectionPart = Pick<
  Direction,
  "type" | "text" | "tempo" | "spanType" | "wedgeType" | "pos" | "justify" | "halign" | "valign" | "font" | "line"
>;

/** `<print>`：版面指示。123 的 `$`（换行）/ `$$`（换页）落在这里。
 *
 *  **口径与 MusicXML 一致：`newSystem`/`newPage` 表示「本小节起新系统/新页」**。
 *  源码里的 `$` 写在小节**之后**，解析器按「之后」收集、收尾时经
 *  `helpers.ts::breaksAfterToStart` 统一翻成这个口径；写出端反向翻回去。
 *  以前 123/文本谱/`.jpwabc` 那几路记「之后」、MusicXML 那一路记「起」，两套混用会把行结构错开一小节。
 *  声部最后一小节之后的换行没有「下一小节」可挂，记在 `Part.endBreak`。 */
export interface Print {
  newSystem?: boolean;
  newPage?: boolean;
  /** [五线谱] */
  systemLayout?: { systemDistance?: number; topSystemDistance?: number; leftMargin?: number; rightMargin?: number };
  /** [五线谱] `<staff-layout number>`：本系统各谱表离上一谱表的距离 */
  staffLayouts?: { staff?: number; staffDistance?: number }[];
  staffSpacing?: number;
  /** `<measure-numbering>` */
  measureNumbering?: string;
  /** 本系统是全曲第几个系统（0 基）。文本谱**一组不一定含全部声部**，多声部时靠它把各声部的行对回同一组 */
  system?: number;
  /** 印在本系统上方的说明文字行（文本谱 `W:`）。挂在该系统第一个声部的首小节 */
  texts?: string[];
  /** 本行的声部名（文本谱每行都可以写 `Q1<女高>`）；`Part.name` 只是第一行的 */
  caption?: string;
  /** 文本谱 `Q!:` / `Q-:` / `Q+:` 的后缀原文（语义未明，保留） */
  variant?: "!" | "-" | "+";
  /** 本行挂的歌词行版式：段号区间、印刷段号、段号与字的间隙、联合括号、音节个数。
   *  字本身挂在各元素的 `lyrics` 上；这里只记「行」这一级才有的东西，排版要原样还原 */
  lyricLines?: LyricLineInfo[];
}

/** 见 `Print.lyricLines` */
export interface LyricLineInfo {
  verseFrom: number;
  verseTo: number;
  annotation?: string;
  /** 段号与歌词之间的间隙（字宽百分比，文本谱 `%50`） */
  annotationGap: number;
  joinBrace?: boolean;
  /** 原文里这一行有几个音节（含空音节）。多于对位格时多出的排版不用 */
  count: number;
}

export interface Measure {
  /** 小节号**原文**——可能是 "12a" 这种，不能当数字存 */
  number: string;
  /** [五线谱] `<measure width>`（tenths），见 `Position` */
  width?: number;
  /** [五线谱] `<measure implicit="yes">`：弱起等不计小节号的小节 */
  implicit?: boolean;
  /** [五线谱] 小节时长（divisions）。**只在比元素的最远终点更长时写**：`<forward>` 撑出来的空拍（赞美之泉 016 末尾的 `<forward>`） */
  duration?: number;
  /** 本小节**第一个元素之前**的属性（多个 `<attributes>` 合并） */
  attrs?: MeasureAttrs;
  /** [五线谱] 小节中间的 `<attributes>`（合唱谱在小节中间换谱号），位置口径同 `Direction.afterElements` / `onset`。
   *  **简谱侧只看 `attrs`**：小节中间转调/转拍号（语料 0 例）那一侧不认 */
  laterAttrs?: { afterElements: number; onset?: number; attrs: MeasureAttrs }[];
  /** 按时间序。MusicXML 的 `<backup>`/`<forward>` 解析成各 `voice` 分轨后消失 */
  elements: Element[];
  /** 左右小节线都在这里，按 `location` 区分 */
  barlines?: Barline[];
  directions?: Direction[];
  print?: Print;
  /** 行末（最后一个符号之后）的 `InlineItem` */
  trailing?: InlineItem[];
  /** **读不懂的原样留着**：`fromxml.ts` 把本小节里它不认识的子节点序列化成字符串挂这儿，
   *  `toxml.ts` 原位吐回去。保存策略是「改动过就全量重写」，全量重写不丢东西**靠的就是这个**，
   *  不是 patch（见 `docs/待办.md` §1 机制 A）。 */
  raw?: string[];
  source?: SourceSpan;
}

export interface Part {
  /** `<score-part id>` */
  id: string;
  name?: string;
  abbrev?: string;
  /** [五线谱] 多谱表（钢琴谱） */
  staffCount?: number;
  measures: Measure[];
  /** 最后一小节**之后**的换行/换页（123 行末的 `$`）。见 `Print` 的口径说明 */
  endBreak?: "system" | "page";
  /** 见 `Measure.raw` */
  raw?: string[];
}

// ───────────────────────── 跨元素的东西 ─────────────────────────

export type MarkType =
  | "slur"
  | "tied"
  | "tuplet"
  | "wedge"
  | "pedal"
  | "octaveShift"
  | "lyricExtend";

/** 跨元素的记号。**用元素 id 配对**，不用数组下标区间——
 *  `PuDoc` 那种下标区间插一个元素就全错。 */
export interface Mark {
  type: MarkType;
  /** MusicXML 的 `number` 属性：同类记号重叠时靠它配对 */
  number?: number;
  start: ElementId;
  end: ElementId;
  /** [五线谱] 起止写在和弦的第几个音上（`Chord.notes` 下标；缺省 0）。混排的弧按这个音定端点 */
  startNote?: number;
  endNote?: number;
  /** 嵌套层级（简谱的双弧 / 房号抬高） */
  level?: number;
  placement?: "above" | "below";
  /** [五线谱] `<slur orientation>`：Sibelius 导出只写它不写 `placement` */
  orientation?: "over" | "under";
  /** [五线谱] `<tuplet bracket>` */
  bracket?: boolean;
  /** 虚线弧（ABC 的 `.(cde)`，规范自称多段歌词时有用） */
  dashed?: boolean;
  /** 渐强/渐弱（`type === "wedge"` 时） */
  wedgeType?: "crescendo" | "diminuendo";
  /** 跨行时后续各行那一段的 level（文本谱续行会重新编号，见过 3 → 1） */
  continuationLevels?: number[];
  /** 文本谱记号起点写在小节线/`~`/夹层上（`[|](5`）：原起点在 `start` 那个符号之前第几个位置。
   *  **不能归并到最近的音符**——`Score` 只在音符上认端点，落在小节线上的端点等于没收口，弧会接到下一行 */
  startLead?: number;
  /** 同上，终点写在 `end` 那个符号之后第几个位置（`(5_ [|]`） */
  endTrail?: number;
  /** 起止倒置的空记号（文本谱 `(` 写在行末最后一个符号之后、本行就收了）：`start`=`end`=那个符号，排版不画 */
  collapsed?: boolean;
  /** 起点写在**上一行行尾**（最后一个符号之后）：上一行留一段空的起头，`start` 是续行的首个符号 */
  leadInPreviousLine?: boolean;
  /** `leadInPreviousLine` 时，上一行那段起头离行尾差几个位置（写在最后一根小节线上为 1） */
  leadBack?: number;
  /** 三连音等的显示数字 */
  tupletActual?: number;
  tupletNormal?: number;
  /** 跨行时的续接标记：排版要在行末/行首画半条 */
  continuesToNext?: boolean;
  continuesFromPrevious?: boolean;
  source?: SourceSpan;
}

/** 演唱顺序的一遍。← 123 的 `I:playorder`
 *
 *  **MusicXML 装不下这个**：`<ending>` 只能整小节，表达不了「从第 11 小节第 2 个音符接入」
 *  （`docs/实现/MusicXML-导出.md` 记了这条损失）。所以它只在 `ScoreDoc` 与 `.123` 里活着，
 *  这正是 123 当简谱主格式的价值所在。语义对照 `.jpwabc` 的 `.Repeat` 段。 */
export interface PlayPass {
  /** 起止小节（1 基，与 `.Repeat` 原文一致） */
  fromMeasure: number;
  toMeasure: number;
  /** skip：从该小节第 n 个音符接入（`.Repeat` 的 `11.2-`）。引用元素 id，解析期解析 */
  fromElement?: ElementId;
  /** limit：只唱到该小节第 n 个音符（`.Repeat` 的 `-20.1`） */
  toElement?: ElementId;
  /** 这一遍配第几段歌词。**可以不等于遍序**——语料里 6 首是非顺序映射，
   *  ABC 的「相邻 w: 依次对应」表达不了，这是 `I:playorder` 存在的硬理由 */
  verse?: number;
  /** 这一遍唱完换页（`.Repeat` 的 `P` 后缀）。展开档逐遍成页时用 */
  pageBreakAfter?: boolean;
}

/** 样式引用。← 123 的 `I:style` 与 inline `[I:style …]`。
 *  样式**本体**在独立样式表里，见 `docs/样式机制.md`；这里只存引用与局部覆盖。 */
export interface StyleRef {
  /** 样式表文件名 */
  sheetRef?: string;
  /** 曲内局部覆盖：`role=lyric size=0.92em` 这类键值 */
  inline?: { role?: string; props: Record<string, string>; scope?: ElementId }[];
  /** 文档内的版面指令原文（文本谱的 `FontSize:` / `Margin:` / `Space:` / `Off:`），交样式层解释 */
  raw?: { key: string; value: string }[];
}

/** 页眉页脚文字（文本谱的 `XL/XR/TL/TR/BL/BC/BR`）。
 *  MusicXML 侧没有对应物，导出时只能落进 `<credit>`。 */
export interface PageText {
  indexLeft?: string;
  indexRight?: string;
  topLeft: string[];
  topRight: string[];
  bottomLeft: string[];
  bottomCenter: string[];
  bottomRight: string[];
}

// ───────────────────────── 顶层 ─────────────────────────

/** 一首歌。多曲文件（123 的 tunebook、文本谱的 `-----` 分曲）是 `ScoreDoc.songs` 多项。 */
export interface Song {
  work: Work;
  identification?: Identification;
  credits?: Credit[];
  /** 首调号与拍号的初值（曲中变更走 `Measure.attrs`） */
  key?: Key;
  time?: Time;
  /** 头部的其余拍号（文本谱 `P: 4/4 3/4`，第一个在 `time`） */
  extraTimes?: Time[];
  /** 速度：数字为 BPM，字符串为文字术语（「欢快地」）。两者可并存 */
  tempos?: (number | string)[];
  /** [五线谱] */
  defaults?: Defaults;
  /** [五线谱] */
  partGroups?: PartGroup[];
  parts: Part[];
  marks: Mark[];
  playOrder?: PlayPass[];
  style?: StyleRef;
  pageText?: PageText;
  /** 无前缀的自由文字行（注记、勘误、版权说明） */
  remarks?: string[];
  /** 每页谱行数（`.jpwabc` 的 `.Layout LinesPerPage`，只对展开档有意义） */
  linesPerPage?: number;
  source?: SourceSpan;
}

export interface ScoreDoc {
  /** 产出它的源格式，用于诊断与导出默认 */
  sourceFormat: "123" | "abc" | "musicxml" | "jpwabc" | "pu" | "omr";
  /** 文本谱方言（`pu/dialect.ts::Dialect`）。排版取度量用 */
  puDialect?: string;
  /** 源文本（有的话）。点选定位要回指原文 */
  source?: string;
  songs: Song[];
  diagnostics: Diagnostic[];
}
