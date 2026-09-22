// 简谱谱行里的格位（Entry 层）与段落词落位；排版算法在 layout.ts 的 Line。

import { jpBarlineItems, jpTimeSigItems } from "./jpglyph";
import { Point } from "../common/geom";
import type { CompressMode } from "../common/cjkpunct";
import { Font } from "./font";
import { GlyphCodes } from "../smufl/smufl";
import { chordTextSegs, layoutHarmonySegs } from "./harmony";
import { GraceAlter, GraceMetrics, GraceNote, graceAdvance, graceBottom, graceGeometry } from "../common/gracenote";
import type { BarStyle } from "../score/enums";
import type { JChord, JKey, JTime } from "./input";
import { PageItem, GraphicPath, Group, TextFrame, GraphicLine, SmuflText, JpOctaveDot, JpNumber, Lyric } from "./pageitem";
import type { LayoutOptions } from "./options";
import type { Line } from "./layout";

// ---------------- Entry hierarchy ----------------

export abstract class Entry {
  group = new Group();
  selected = false;
  line!: Line;
  /** 这个条目**前面**要先空出多少（倚音那串小号数字就占在这儿）。
   *  `calcXPos` 在给条目定位之前先把游标推过它——不这么做的话，
   *  倚音会贴着主音符往左伸，正好压在前一个音符上。 */
  leadSpace = 0;
  constructor() {
    this.group.classes.add("entry");
  }
  update(): void {
    this.group.update();
  }
  abstract entryItem(): PageItem | null;
  entryWidth(): number {
    return this.entryItem()?.width ?? 0;
  }
}

export class KeySig extends Entry {
  /** 转调标记那个文本框。`liftOverChords` 要按它的墨迹框判避让，故留住引用。 */
  readonly label: TextFrame;
  constructor(key: JKey, opt: LayoutOptions) {
    super();
    const names = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
    const name = names[key.fifths + 7];
    const tf = new TextFrame();
    tf.classes.add("key-change"); // 见 browser.ts::roleOfItem —— line-check 的 L12 靠它认
    tf.color = opt.color;
    tf.y = -opt.numberSize;
    tf.text = `转1=${name}`;
    tf.font = opt.lrcFont.scaled(0.6);
    const w = tf.measureText();
    tf.x = -w / 2;
    // `liftKeySigOverChords` 要按 width/bound 判避让，这里就把尺寸算出来
    //（`Line.load` 之后到 `group.update()` 之间还隔着好几步）。
    tf.update();
    this.label = tf;
    this.group.add(tf);
    this.group.data = this;
  }
  entryItem(): PageItem | null {
    return null;
  }
  override entryWidth(): number {
    return 0;
  }
}

export class TimeSig extends Entry {
  hline!: GraphicLine;
  width = 0;
  beats: number;
  beatType: number;
  constructor(beats: number, beatType: number, opt: LayoutOptions) {
    super();
    this.beats = beats;
    this.beatType = beatType;
    this.layout(opt);
    this.group.data = this;
  }
  static fromTime(t: JTime, opt: LayoutOptions): TimeSig {
    return new TimeSig(t.beats, t.beatType, opt);
  }
  entryItem(): PageItem | null {
    return this.hline;
  }
  override entryWidth(): number {
    return this.width;
  }
  layout(opt: LayoutOptions): void {
    const top = opt.jpStaffTop;
    const bot = opt.jpStaffBottom;
    // 尺寸一律按**小节线高度**的比例（见 jpglyph.ts::jpTimeSigItems），三条简谱路同一份。
    const r = jpTimeSigItems(this.beats, this.beatType, {
      height: bot - top,
      centerY: (bot + top) / 2,
      // 分数线的粗细：原书量到的才 0.3pt（比小节线 1.0 还细一半多），
      // 引擎默认的 1.5 是按屏幕上 fontSize≈28 调的，缩到成书字号就成了一道黑杠。
      ruleWidth: opt.timeSigRuleWidth > 0 ? opt.timeSigRuleWidth : 1.5,
      color: opt.color,
      // **与音符同一份字体**（用户口径）。原先 `withBold()`：同一个字族但字重不同，
      // 导出到 .pptx 里就是 YaHei Bold 对 YaHei Regular，一眼看得出拍号比音符黑一档。
      font: opt.numberFont,
      // 0 = 让 jpTimeSigItems 用它自己的默认比例（编辑器/成书两条路不变）。
      // 竖向不在这里给：它只认拍值字号（jpglyph.ts::TIME_SIG_GAP_EM）。
      digitRatio: opt.timeSigDigitRatio > 0 ? opt.timeSigDigitRatio : undefined,
      ruleLengthRatio: opt.timeSigRuleLenRatio > 0 ? opt.timeSigRuleLenRatio : undefined,
    });
    // **前后各留一格**（用户口径：「拍号前后要有间距」）。`r.width` 只是分数线的长度，
    // 两个数字本身还比它宽出一点点，于是曲中转拍号紧贴着前一条小节线
    //（144《求圣灵吹我》实测净距 1.75pt）。
    //
    // 前面那一格走 `Entry.leadSpace`（`Line.calcXPos` 在定位之前先加它），**不能靠
    // 把图元整体右移**：`Group.update()` 会把组原点归到子级包围盒的左上角，右移多少
    // 就被吃掉多少。后面那一格加进 `entryWidth()` 即可。
    // 从前 `calcXPos` 里那句 `if (e instanceof TimeSig) curX += it!.height / 5` 恒等于 0
    //——拍号的 `entryItem()` 是**分数线**，横线的 height 就是 0。
    const pad = opt.numberSize / 4;
    this.leadSpace = pad;
    this.width = r.width + pad;
    this.hline = r.rule;
    for (const it of r.items) this.group.add(it);
  }
}

/**
 * 一个音符条目的**左右缘**（相对条目自己的组原点），**不含和弦与表情记号**。
 *
 * 和弦印在音符上方、可以横向伸出音符的范围（原书就这么印的），撞上了另有
 * `Line.spreadChordsHorizontally` 沿 x 让位——把它算进「这一行放不放得下」，
 * 宽和弦（`E♭7` 那种）就会把整句挤到下一行去（446《迦勒看见主》实测从原书的
 * 3 行变成 6 行）。表情记号（`rit.` / `Fine`）同理，它们本来就挂在行上。
 *
 * **`doLineBreak` 与 `naturalSpans` 必须共用这一个**：前者是排版器折行的实际判据、
 * 后者是断句量「一行放得下多少」的尺子，两把尺子不一致的话，断句算得下的行
 * 排版器会再折一刀（行尾挂着孤零零几个音）。
 */
export function entryBounds(g: Group): { left: number; right: number } {
  let lo = Infinity, hi = 0;
  for (const it of g.children) {
    if (it instanceof Group && (it.classes.has("chord-group") || it.classes.has("direction-group"))) continue;
    lo = Math.min(lo, it.x);
    hi = Math.max(hi, it.x + it.width);
  }
  // **左缘也要算**：`Group.update()` 会把组原点归到子级包围盒的左上角，宽和弦往左伸出时
  // 整个条目的原点跟着左移——只挡右缘的话，和弦仍旧从左边溜进这把尺子里
  //（446 的容量因此在纯文本 / 富文本两种和弦下差出一格）。
  return { left: Number.isFinite(lo) ? lo : 0, right: hi };
}

/**
 * 把条目的组原点归到**非标记内容**的左缘（`Group.normalizeX` 的替身）。
 *
 * `normalizeX` / `Group.update()` 都是按**所有**子级的包围盒归一的，和弦往左伸出时
 * 条目原点跟着左移——于是「这一行放不放得下」不管怎么量都掺着和弦：右缘挡住了，
 * 左缘又从原点溜进来（446《迦勒看见主》的容量因此在两种和弦风格下差出一格）。
 * 归到音符内容的左缘之后，和弦组的 `x` 允许为负（照常绘制），横向度量则完全干净。
 */
export function normalizeEntryX(g: Group): void {
  if (!g.children.length) return;
  const { left } = entryBounds(g);
  if (left === 0) return;
  for (const it of g.children) it.x -= left;
  g.x += left;
}

/** `Note.jpAlter` → 公共倚音几何的升降号名。空格（没有临时记号）不在表里。 */
const GRACE_ALTER: Record<string, GraceAlter | undefined> = {
  "#": "sharp",
  b: "flat",
  n: "natural",
};

/** 倚音升降号用的 SMuFL 字形，与主音那一套同源（`addAccidental`）。 */
const GRACE_ALTER_GLYPH: Record<GraceAlter, string | undefined> = {
  sharp: GlyphCodes.accidentalSharp,
  flat: GlyphCodes.accidentalFlat,
  natural: GlyphCodes.accidentalNatural,
  "double-sharp": undefined,
  "double-flat": undefined,
};

/** 简谱这一路的倚音度量——折算成公共几何要的那几个数（见 common/gracenote.ts）。 */
function graceMetricsOf(opt: LayoutOptions): GraceMetrics {
  const bnd = opt.numberBound("1");
  return {
    ink: bnd.height,
    // 原书 260/264 两页实测：倚音数字墨迹高 4.82~5.00、正常音符 8.33 → 0.58~0.60
    scale: 0.59,
    octaveUpY: bnd.top - opt.jpStackGap,
    octaveDownY: opt.jpDotRung,
    octaveDotGap: opt.jpDotRung,
    octaveDotRadius: opt.numberFont.size * 0.06,
    underlineGap: opt.jpBeamDist,
  };
}

export class NoteEntry extends Entry {
  chord!: JChord;
  verse = 0; // repeat pass / lyric verse this rendered entry belongs to
  lrc: Lyric | null = null;
  /** 叠排时这个音符底下的各段歌词（lrc 是其中第一段，供既有的宽度/链表逻辑用）。 */
  lrcs: Lyric[] = [];
  number: JpNumber | null = null;
  accidental: TextFrame | null = null;
  beams = 0;
  octaveDot: JpOctaveDot[] = [];
  notations: SmuflText[] = [];

  constructor() {
    super();
    this.group.data = this;
  }
  get jpOctave(): number {
    return this.chord.notes[0].jpOctave;
  }
  get numberPos(): number {
    return this.number!.numberPos;
  }
  /** 和弦符号：排在音符正上方（以数字墨迹中心对齐）。
   *  富文本分段（根音升降号走 SMuFL、后缀上标）复用 layout/harmony.ts，与五线谱、文本谱同一套。 */
  static addHarmony(ch: JChord, opt: LayoutOptions, ent: NoteEntry, num: JpNumber): void {
    if (!ch.harmony || opt.chordSize <= 0) return;
    const wordFont = opt.numberFont.makeWithSize(opt.chordSize);
    const musicFont = opt.smuflFont.makeWithSize(opt.chordSize);
    const g = layoutHarmonySegs(chordTextSegs(ch.harmony, opt.chordPlainText), wordFont, musicFont, opt.color);
    g.classes.add("chord-group"); // 段落词要按它的位置让路，见 Line.addSectionWords
    g.update();
    g.x = num.x + num.cx - g.width / 2;
    // 挂在这个音符**已有内容的栈顶**之上（八度点已经加过了），不是固定高度——
    // 否则带高音点的音符上，和弦会压到点上。原书的 chordGap 就是量的这个净距。
    //
    // 和弦一律**按基线对齐**（同一行的和弦要齐平），不能按墨迹顶或底摆：
    // 带升降号的那些用 Bravura 的 csym 字形，em 框比字母高得多，按墨迹摆会比邻近的
    // 和弦高出十来个点。`g.update()` 之后 `g.y` 正好是「墨迹顶相对基线」的偏移，
    // 所以这里**累加**目标基线，而不是赋值。
    // 基准是音符的**墨迹顶**，不是 -numberSize（那是字号，Times 的数字墨迹只占 0.66em，
    // 拿字号当墨迹顶会把和弦白白多抬三四个点）。原书量的 chordToNote 也是
    // 「音符墨迹顶 − 和弦基线」（stats.ts: noteTop − baselineY），两边口径必须一致。
    const inkTop = opt.numberBound("1").top;
    const top = Math.min(inkTop, ent.group.childrenBound.top);
    g.y += top - opt.chordGap;
    ent.group.add(g);
  }

  addAccidental(tf: TextFrame): void {
    this.accidental = tf;
    this.group.add(tf);
  }
  add(item: JpNumber | Lyric): void {
    if (item instanceof JpNumber) {
      this.number = item;
      this.group.add(item);
    } else {
      if (this.lrc === null) this.lrc = item;
      this.lrcs.push(item);
      this.group.add(item);
    }
  }
  get left(): number {
    return this.number !== null ? this.number.left : 0;
  }
  get cx(): number {
    return this.number!.x + this.number!.cx;
  }
  get right(): number {
    return this.number?.right ?? 0;
  }
  entryItem(): TextFrame | null {
    return this.number;
  }
  get beginOfSlurTied(): boolean {
    if (this.chord.slurStart) return true;
    if (this.chord.notes[0].tieStart) return true;
    return false;
  }
  get endOfSlurTied(): boolean {
    if (this.chord.slurEnds > 0) return true;
    if (this.chord.notes[0].tieEnd) return true;
    return false;
  }
  /** Ink top of the digit plus whatever octave dots sit above it — i.e. the
   * top of the shared vertical ladder, which slurs/ties then continue. */
  entryTop(opt: LayoutOptions): number {
    const oct = this.chord.notes[0].jpOctave;
    const bnd = opt.numberBound("1");
    if (opt.jpGridLegacy) {
      // 旧式：高音点那一摞按 `jpLegacyDotCenter` 排，整摞再退 numberSize/8——
      // 那个 1/8 就是当年的「gap」，所以 legacy 下 slurRung 不再额外退（见下）。
      // **没有高音点时不按 `bnd.top` 退**，直接取量自成品的那一格（见 jpLegacyBandTop）：
      // `bnd.top` 是拿排版字体（PingFang）量的，比目标字体的数字矮 0.055 em，
      // 照它退出来的弧与 fermata 在 .pptx 里贴着数字。
      if (oct > 0) {
        return opt.jpLegacyDotCenter(oct - 1, 0, true) - opt.jpDotRadius - opt.numberSize / 8;
      }
      return opt.jpLegacyBandTop;
    }
    if (oct <= 0) return bnd.top;
    return bnd.top - oct * opt.jpDotRung;
  }
  /**
   * 数字**加它上面那摞八度点**的墨迹顶——不含上方那一带的空档。
   *
   * 与 `entryTop` 的分别：旧式档（PPT）的 `entryTop` 返回的是「上方那一带的底」
   * （`jpLegacyBandTop`，比墨迹顶还高出一格，弧与 fermata 落在那儿）。倚音要**贴着音符**
   * 摆（用户口径：「倚音底部对齐正常音符顶部」），用的是这一份。
   */
  stackInkTop(opt: LayoutOptions): number {
    const oct = this.chord.notes[0].jpOctave;
    if (opt.jpGridLegacy) {
      return oct > 0
        ? opt.jpLegacyDotCenter(oct - 1, 0, true) - opt.jpDotRadius
        : opt.jpLegacyDigitInkTop;
    }
    const bnd = opt.numberBound("1");
    return oct <= 0 ? bnd.top : bnd.top - oct * opt.jpDotRung;
  }
  /** Where a slur/tie sits: one `jpStackGap` above whatever the note already
   * stacks — the same gap that separates the digit from its first octave dot,
   * and one dot from the next. */
  slurRung(opt: LayoutOptions): number {
    // 旧式栅格里 entryTop 自带了那 numberSize/8 的间隙，弧就落在它上面。
    if (opt.jpGridLegacy) return this.entryTop(opt);
    return this.entryTop(opt) - opt.jpStackGap;
  }
  /** Mirror of entryTop below the baseline (low octave dots clear the beams). */
  entryBottom(options: LayoutOptions): number {
    const oct = this.chord.notes[0].jpOctave;
    const bnd = options.numberBound("1");
    const beamBottom = options.jpBeamBottom(this.chord.beams);
    if (options.jpGridLegacy) {
      // 旧式：低音点从基线按 numberSize 的比例往下排，只让开减时线的**层号**
      // （不是墨迹底），且与数字墨迹底无关。
      let y = this.chord.beams * options.jpBeamDist;
      if (oct < 0) y += options.numberSize * ((-oct - 1) * 0.175 + 0.25) + options.numberSize / 4;
      return y;
    }
    if (oct >= 0) return beamBottom;
    const above = Math.max(bnd.bottom, beamBottom);
    return above + options.jpBelowGap + (-oct - 1) * options.jpLowDotRung + 2 * options.jpDotRadius;
  }

  static addAccidental(it: JpNumber, options: LayoutOptions, ch: JChord, ent: NoteEntry): void {
    const alt = ch.notes[0].jpAlter;
    if (alt !== " ") {
      const tf = new SmuflText(options);
      tf.color = options.color;
      if (options.smuflAsPath) tf.asPath = true;
      let smufl: string;
      switch (alt) {
        case "b": smufl = GlyphCodes.accidentalFlat; break;
        case "#": smufl = GlyphCodes.accidentalSharp; break;
        case "n": smufl = GlyphCodes.accidentalNatural; break;
        default: throw new Error("");
      }
      const yOffset = alt === "b" ? 0.1 : 0; // 简谱中降号下移
      tf.text = smufl;
      const kernMap: Record<string, number> = { "4": 0.1, "2": -0.07, "1": -0.07 };
      let xx = -tf.font.size * 0.2;
      xx += (kernMap[it.text[0]] ?? 0) * tf.font.size;
      const numBnd = options.numberBound("1");
      let yy = numBnd.top;
      yy += options.smuflFont.size * yOffset;
      const sc = 0.8;
      tf.matrix.setAffine([sc, 0, 0, sc, xx * sc, yy]);
      ent.addAccidental(tf);
    }
  }
  /**
   * Octave dots stack outward from the digit on the shared vertical ladder
   * (see LayoutOptions.jpStackGap / jpDotRung). Row `d` = 0 is the row
   * nearest the digit, so `entryTop`/`slurTop` can simply continue the same
   * ladder at row `oct`.
   *
   * NB musicpp does the opposite — it pins the *outermost* dot at a fixed y
   * and fills back down toward the digit (render.cpp:906, `octY + i*dotDist`
   * with octY independent of the dot count), which is not how jianpu is
   * normally engraved.
   */
  static octaveDot(ch: JChord, options: LayoutOptions, ent: NoteEntry): void {
    const oct = ch.notes[0].jpOctave;
    const numBound = options.numberBound("1");
    for (let d = 0; d < Math.abs(oct); d++) {
      const r = options.jpDotRadius;
      const tf = new JpOctaveDot(r, options.color);
      // 栅格是**墨迹到墨迹**量的。圆的局部包围盒就是墨迹本身（(0,0)–(2r,2r)），
      // 所以直接按上/下缘落位——不必再像字形那样倒扣 `.` 自己的基线偏移。
      if (options.jpGridLegacy) {
        // 旧式落位（展开档）：阶梯以**基线**为准，见 `LayoutOptions.jpLegacyDotCenter`。
        // 那里记的是**墨迹中心**，圆的局部原点在墨迹顶，所以退一个半径。
        tf.y = options.jpLegacyDotCenter(d, ch.beams, oct >= 0) - r;
      } else if (oct >= 0) {
        const inkBottom = numBound.top - options.jpStackGap - d * options.jpDotRung;
        tf.y = inkBottom - 2 * r;
      } else {
        const above = Math.max(numBound.bottom, options.jpBeamBottom(ch.beams));
        tf.y = above + options.jpBelowGap + d * options.jpLowDotRung;
      }
      ent.group.add(tf);
      ent.octaveDot.push(tf);
    }
  }
  static addLyric(ch: JChord, options: LayoutOptions, ent: NoteEntry, it: JpNumber, lrc: number): void {
    // 叠排：这个音符底下把各段歌词一行行摞起来（原书的排法）。段序按 lyric.number。
    const stack = options.lyricStack > 0;
    const all = stack
      ? [...ch.notes[0].lyrics].sort((a, b) => a.number - b.number)
      : ch.notes[0].lyrics;
    let row = 0;
    for (const l of all) {
      if (!stack && !l.refrain) {
        if (l.number !== lrc) continue;
      }
      let text = l.text;
      if (options.ignoreVerseNumber) {
        for (let idx = 0; idx < l.text.length; idx++) {
          const _ch = l.text[idx];
          if ((_ch >= "0" && _ch <= "9") || _ch === ".") {
            // skip leading verse number/dot
          } else {
            text = l.text.substring(idx);
            break;
          }
        }
      }
      const lit = new Lyric();
      lit.font = options.lrcFont;
      lit.y = 1.0 * options.numberFont.size + (stack ? row * options.lyricStack : 0);
      row++;
      lit.compress = options.punctCompress;
      lit.text = text;
      lit.color = options.color;
      lit.verse = l.number;
      lit.update();
      lit.x = it.left - lit.left;
      ent.add(lit);
    }
  }
  /**
   * **倚音**（`Chord.graceNotes`）：主音符左边的小号数字 + 减时线 + 连接钩。
   *
   * **几何走公共那一份**（`src/common/gracenote.ts`）——文本谱那条路
   * （`layout/original/compose.ts::paintGrace`）用的是同一套比例（照原版矢量量的），两边各自落笔。
   * 占位走 `Entry.leadSpace`：倚音在拍点**之前**唱，位置也该在主音符之前，
   * 直接往左伸会压住上一个音符。
   */
  static addGraceNotes(ch: JChord, options: LayoutOptions, ent: NoteEntry, main: JpNumber): void {
    if (!ch.graceNotes.length) return;
    const gm = graceMetricsOf(options);
    const size = options.numberFont.size * gm.scale;
    const font = options.noteFont.makeWithSize(size);
    // 公共几何按「主音数字的墨迹中心 x、基线 y」定位；这里先摆在原点，稍后整体右移。
    //
    // **倚音整组的底缘贴着主音的墨迹顶**（用户口径：「倚音底部对齐正常音符顶部」）。
    // 最低的那一笔不一定是数字——减时线在数字之下，连接钩还要再往下垂一截，
    // 有低音点时低音点更低。所以先按 `centerY = 0` 排一遍量出底缘，再回填真正的 centerY。
    // 摆的基准是 `stackInkTop`（数字加高音点那一摞的墨迹顶），不是 `entryTop`：
    // 后者在旧式档里是「上方那一带的底」，比墨迹顶还高出一格。
    const notes: GraceNote[] = ch.graceNotes.map((g) => ({
      digit: g.number,
      octave: g.jpOctave,
      duration: 8,
      ...(GRACE_ALTER[g.jpAlter] ? { alter: GRACE_ALTER[g.jpAlter]! } : {}),
    }));
    const probe = graceGeometry(notes, gm, 0, 0, -1, options.numberFont.size, 0);
    const centerY = ent.stackInkTop(options) - graceBottom(probe, gm);
    const geom = graceGeometry(notes, gm, 0, 0, -1, options.numberFont.size, centerY);
    const lead = graceAdvance(notes, gm);
    // 主音符右移，给倚音腾地方；游标也要跟着推（不然倚音会压上一个音符）
    main.x += lead;
    ent.leadSpace = lead;
    const ox = main.x + main.cx; // 倚音那一串相对主音墨迹中心排
    for (const d of geom.digits) {
      const it = new JpNumber();
      it.classes.add("grace");
      it.color = options.color;
      it.text = d.text;
      it.font = font;
      it.update();
      // 公共几何给的是**墨迹中心**，换算成落笔点与基线
      const cb = font.charBound(d.text);
      it.x = ox + d.cx - (cb.left + cb.right) / 2;
      it.y = d.cy - (cb.top + cb.bottom) / 2;
      ent.group.add(it);
    }
    // 八度点与主音同一套画法（实心圆），只取公共几何算好的位置。
    // 半径用 graceMetricsOf 里那个倚音专用的 `octaveDotRadius`（比主音的小）。
    for (const o of geom.dots) {
      // 半径用公共几何算好的那个（倚音专用，比主音小；`GraceGeom.dots[].r`）
      const r = o.r;
      const dot = new JpOctaveDot(r, options.color);
      dot.x = ox + o.cx - r;
      dot.y = o.cy - r;
      ent.group.add(dot);
    }
    // 升降号：与主音同一套 SMuFL 字形（`addAccidental`），但**按墨迹摆**——
    // 公共几何给的是墨迹右缘、竖向中心与墨迹高，字号由墨迹高反推（主音那边用的是
    // 固定的 0.8 缩放 + 常数偏移，倚音这么小，一点漂移就骑到左边那颗上）。
    for (const acc of geom.accidentals) {
      const smufl = GRACE_ALTER_GLYPH[acc.alter];
      if (!smufl) continue;
      const tf = new SmuflText(options);
      tf.color = options.color;
      if (options.smuflAsPath) tf.asPath = true;
      tf.text = smufl;
      const b0 = tf.bound;
      const h0 = b0.bottom - b0.top;
      if (h0 > 0) tf.font = options.smuflFont.makeWithSize(options.smuflFont.size * (acc.inkHeight / h0));
      const b = tf.bound;
      tf.x = ox + acc.inkRight - b.right;
      tf.y = acc.inkCy - (b.top + b.bottom) / 2;
      ent.group.add(tf);
    }
    for (const bm of geom.beams) {
      const ln = new GraphicLine();
      ln.classes.add("grace-line");
      ln.strokeColor = options.color;
      ln.strokeWidth = bm.h;
      ln.x = ox + bm.x;
      ln.y = bm.y + bm.h / 2;
      ln.p0 = new Point(0, 0);
      ln.p1 = new Point(bm.w, 0);
      ent.group.add(ln);
    }
    if (geom.hook) {
      const path = new GraphicPath();
      path.classes.add("grace-line");
      path.fill = false;
      path.stroke = true;
      path.strokeColor = options.color;
      path.strokeWidth = geom.hook.width;
      const [mx, my] = geom.hook.m;
      const c = geom.hook.c;
      path.moveTo(ox + mx, my);
      path.cubicTo(ox + c[0], c[1], ox + c[2], c[3], ox + c[4], c[5]);
      ent.group.add(path);
    }
  }

  /** 音符自己的记号（fermata / 重音）落在哪条线上：音符墨迹栈顶之上一格，
   *  **临时升降号也要让开**——它印在数字左上角，比数字墨迹顶还高（470《出到营外》
   *  那几个重音因此贴在升号上）。`addNotations` 跑在 `ent.update()` 之前，
   *  这会儿子级坐标还是「相对基线」那一套，没归一化过。 */
  private static notationTop(options: LayoutOptions, ent: NoteEntry): number {
    let y = ent.slurRung(options);
    const acc = ent.accidental;
    if (acc) {
      const sc = Math.abs(acc.matrix.scaleY) || 1;
      const top = acc instanceof SmuflText ? -acc.bound.bottom : acc.bound.top;
      // 与升降号之间留宽一点（1.6 格）：那个 `#` 本来就斜挎在数字左上角，
      // 只留一格的话 `>` 看着像挂在它身上（470《出到营外》）。
      y = Math.min(y, acc.y + top * sc - options.jpStackGap * 1.6);
    }
    return y;
  }

  static addNotations(ch: JChord, options: LayoutOptions, ent: NoteEntry): void {
    if (ch.fermata) {
      const t = new SmuflText(options);
      t.color = options.color;
      t.classes.add("artic"); // line-check 的 V12 靠它认（见 browser.ts::CLS_TAGS）
      t.text = GlyphCodes.fermataAbove;
      // Same ladder as the octave dots / slur (musicpp render.cpp:349-355 uses
      // `y -= dot*7` plus a flat -10 over a slur; both collapse to one rung).
      // 压不压弧交给上方带堆叠统一算（Line.stackAbove）——从前这里自己按
      // 「这个音符是不是弧的端点」抬一整格 `jpDotRung`，与堆叠叠加就抬了两回。
      t.y = NoteEntry.notationTop(options, ent);
      t.x += ent.number!.x + ent.number!.cx;
      t.x -= t.bound.width / 2;
      ent.group.add(t);
      ent.notations.push(t);
    }
    // 重音（原书 34 处，全是 `<accent>`）。与 fermata 同一带，堆叠时一起算（layer 0）。
    for (const a of ch.articulations) {
      if (a !== "accent") continue;
      const t = new SmuflText(options);
      t.color = options.color;
      t.classes.add("artic");
      t.text = GlyphCodes.articAccentAbove;
      t.y = NoteEntry.notationTop(options, ent);
      t.x += ent.number!.x + ent.number!.cx;
      t.x -= t.bound.width / 2;
      ent.group.add(t);
      ent.notations.push(t);
    }
  }
  /**
   * 附点 —— **一个实心矢量圆**（三条简谱路统一，见 `jpglyph.ts`；八度点、反复点同理）。
   * 大小默认照字体里那个 `·`（`jpAugDotRadius`），展开档把它与八度点设成同一个值。
   *
   * **advance 照旧留给附点**（`JpNumber.augDotAdvance`）：横向间距走 `JpNumber.right`，
   * 把 `·` 从文本里摘掉而不补回它的 advance，带附点的音符就会与后一个音符贴到一起。
   */
  static addAugDots(num: JpNumber, opt: LayoutOptions, dots: number, ent: NoteEntry): void {
    const font = opt.noteFont;
    const adv = font.measureText("·");
    const r = opt.jpAugDotRadius;
    // 数字本身的 advance。**不能用 `num.width`**——此刻 `update()` 还没跑过，它还是 0。
    const x0 = num.measureText(0, num.text.length);
    // **横向落在「数字墨迹右缘 → 条目右缘」的正中**（用户口径：附点要与音符居中对齐）。
    // 照 `·` 字形自己的位置摆不行：数字的 advance 比墨迹宽得多，宽出多少还因数字而异
    // （Times 28pt：`1` advance 11.2 而墨迹只到 8.2，`5` advance 16.8、墨迹到 15.4），
    // 于是 `1.` 的点比 `5.` 的点离数字远出 1.6pt，一眼看得出来。
    const last = num.text[num.text.length - 1] ?? "0";
    const nb = font.charBound(last);
    const inkRight = num.measureText(0, num.text.length - 1) + nb.right;
    // **纵向：圆心与数字墨迹的中心等高**（用户口径）。照 `·` 字形自己的墨迹中心摆也差不多，
    // 但那是「跟着标点走」，数字一换字体就对不齐了——直接量数字。
    const cy = (nb.top + nb.bottom) / 2;
    const runW = adv * (dots - 1) + 2 * r;
    const start = inkRight + (x0 + adv * dots - inkRight - runW) / 2;
    for (let d = 0; d < dots; d++) {
      const dot = new JpOctaveDot(r, opt.color);
      dot.x = start + adv * d;
      dot.y = cy - r;
      dot.aug = { num, index: d };
      dot.classes.add("aug-dot"); // 可视化编辑单独点选附点（`ScorePainter.partEls`）
      ent.group.add(dot);
    }
    num.augDotAdvance = adv * dots;
    num.update();
  }

  static fromChord(res: Entry[], ch: JChord, lrc: number, options: LayoutOptions): void {
    let ent = new NoteEntry();
    ent.beams = ch.beams;
    ent.chord = ch;
    ent.verse = lrc;
    let it = new JpNumber();
    it.color = options.color;
    it.text = ch.notes[0].number;
    it.font = options.noteFont;
    ent.add(it);
    NoteEntry.addAccidental(it, options, ch, ent);
    if (ch.beats <= 1 && ch.dot > 0) NoteEntry.addAugDots(it, options, ch.dot, ent);
    NoteEntry.addGraceNotes(ch, options, ent, it);
    NoteEntry.octaveDot(ch, options, ent);
    NoteEntry.addLyric(ch, options, ent, it, lrc);
    NoteEntry.addNotations(ch, options, ent);
    NoteEntry.addHarmony(ch, options, ent, it);
    ent.update();
    res.push(ent);
    for (let i = 1; i < ch.beats; i++) {
      ent = new NoteEntry();
      ent.chord = ch;
      ent.verse = lrc;
      const num = ch.rest ? "0" : "-";
      it = new JpNumber();
      it.text = num;
      it.color = options.color;
      it.font = options.noteFont;
      ent.add(it);
      ent.update();
      res.push(ent);
    }
  }
}

/** 小节线的样子：粗细组合 + 反复点。与五线谱同一套画法（`‖:` 点在右、`:‖` 点在左）。 */
export interface BarlineSpec {
  /** MusicXML 的 bar-style。null = 普通细线。 */
  style?: BarStyle | null;
  /** `:‖`（反复回到前面）——两点画在左侧。 */
  repeatBackward?: boolean;
  /** `‖:`（反复段起点）——两点画在右侧。 */
  repeatForward?: boolean;
}

export class Barline extends Entry {
  /** The vertical strokes, kept so `clipBarlinesUnderSlurs` can shorten them. */
  readonly lines: GraphicLine[] = [];
  /** 是不是「一条普通细线」（没有反复点、没有粗线）——`‖:` 会把紧挨着的这种吃掉。 */
  isPlain = false;
  readonly defaultTop: number;
  private readonly bot: number;

  /** 建这条线时用的 spec（`dropDoubledBarlines` 要拿它判断能不能把两条并成一条）。 */
  readonly spec: BarlineSpec;

  /** 这条线画在挨着的那个音符**之前**（小节开头的 `‖:`）还是**之后**（小节末的线）。
   *
   *  小节线在模型里**没有自己的 `ElementId`**（`model/doc.ts` 的 `Barline` 只有样式与 `source`），
   *  可视化编辑要点中它就得有个键，口径与 `editor/sync.ts::addPartExtras` 一致：借挨着的那个音符的 id。
   *  借哪一个由 `ScorePainter` 遍历页面树时按前后顺序定（那里才看得到跨小节、跨行的相邻关系），
   *  这里只记是哪一侧。**排版不读它**。 */
  ownerEdge: "before" | "after" = "after";

  constructor(final: boolean, opt: LayoutOptions, spec: BarlineSpec = {}) {
    super();
    this.spec = spec;
    this.group.data = this;
    const top = opt.jpStaffTop;
    const bot = opt.jpStaffBottom;
    this.defaultTop = top;
    this.bot = bot;
    // 粗细组合、反复点、间距一律走公共那一份（jpglyph.ts）——文本谱也用它。
    const r = jpBarlineItems(spec, final, {
      top,
      bot,
      light: opt.barlineWidth, // musicpp lineWidths.lightBarline (pptutil.cpp:139)
      heavy: opt.finalBarlineWidth,
      dotRadius: opt.repeatDotRadius,
      color: opt.color,
    });
    for (const it of r.items) this.group.add(it);
    this.lines.push(...r.lines);
    this.isPlain = r.isPlain;
    this.group.update();
  }

  /** 小节线**墨迹**的左右缘（相对本 entry 的组原点）。
   *
   *  `group.x` 不是线的位置：`:‖` 会先画反复点再画线，两者差着 `dotR × 2 + dotGap`
   *  （实测 4.8pt）。房号横线要贴着小节线画，拿 `group.x` 当线位就会短一截
   *  （158《一件礼物》的一房终点差了 4.3pt，看着没对齐）。 */
  get inkLeft(): number {
    const f = this.lines[0];
    return f ? f.x - f.strokeWidth / 2 : 0;
  }
  get inkRight(): number {
    const l = this.lines[this.lines.length - 1];
    return l ? l.x + l.strokeWidth / 2 : 0;
  }


  /**
   * Lower the top edge so the barline stops below a slur/tie crossing it.
   * Only ever shortens; a `top` above `defaultTop` is ignored.
   *
   * Works on the post-`update()` representation: `Group.update()` has already
   * folded each line's p0 into the group's y and left the children at y=0 with
   * p1 holding the length, so trimming means moving the group down and
   * shortening p1 by the same amount. (Re-assigning p0 instead would be folded
   * in a *second* time by GraphicLine.update(), which both moves and lengthens
   * the stroke.)
   */
  /** 小节线占多宽 —— **要把整组算进去**（粗细两条线、反复点都在 group 里）。
   *  基类只看 `entryItem()`（第一条竖线），于是 `‖:` 右边那两个反复点没有占位，
   *  后面的音符直接压上来（037 第三行的 `‖:5` 里点与 5 叠在一起）。 */
  override entryWidth(): number {
    return this.group.width;
  }

  clipTop(top: number): void {
    const y = Math.max(this.defaultTop, Math.min(top, this.bot));
    const dy = y - this.group.y;
    if (dy <= 0) return;
    for (const l of this.lines) {
      l.p1 = new Point(l.p1.x, l.p1.y - dy);
      l.height = Math.abs(l.p1.y);
    }
    this.group.y += dy;
    this.group.height -= dy;
  }
  entryItem(): PageItem | null {
    // **可能一个子级都没有**：`<bar-style>none</bar-style>` 的小节线什么也不画
    //（见 jpglyph.ts::jpBarlineWidths），`children[0]` 就是 undefined——
    // 不收成 null 的话 `calcXPos` 里那句 `if (it !== null) x = it.x` 会直接崩。
    return this.group.children[0] ?? null;
  }
}

export class LineBreak extends Entry {
  newPage = false;
  constructor() {
    super();
    this.group.width = 0;
    this.group.height = 0;
    this.group.data = this;
  }
  entryItem(): PageItem | null {
    return null;
  }
}

export class BeamLine extends GraphicLine {
  level = 0;
  left: NoteEntry | null = null;
  right: NoteEntry | null = null;
  constructor(lev: number, l: NoteEntry, r: NoteEntry, opt: LayoutOptions) {
    super();
    this.selectable = true;
    this.level = lev;
    this.left = l;
    this.right = r;
    const grp = l.line.group;
    this.p0 = l.entryItem()!.pos(grp);
    this.p1 = r.entryItem()!.pos(grp);
    this.p1 = this.p1.offset(r.numberPos, 0);
    // `lev` is 1-based here (musicpp's is 0-based), so the first beam lands on
    // jpBeamTop and each further level steps down by jpBeamDist.
    const y = opt.jpBeamTop + opt.jpBeamDist * (lev - 1);
    this.p0 = new Point(this.p0.x, y);
    this.p1 = new Point(this.p1.x, y);
    this.strokeWidth = opt.jpBeamWidth;
    this.strokeColor = opt.color;
    this.x = this.p0.x;
    this.p1 = this.p1.offset(-this.p0.x, 0);
    this.p0 = new Point(0, this.p0.y);
  }
}

export class EntryItemInfo {
  dist = 0;
  rate = 0;
  entry: Entry | null = null;
}


/** 段落词落点的几何输入（一行之内，坐标以该行的 group 为原点）。 */
export interface SectionWordGeom {
  /** 锚点音符的墨迹左缘 */
  anchorX: number;
  /** 段落词的文字宽 */
  width: number;
  /** 段落词字号：让位间隙与抬升量都按它算 */
  size: number;
  /** 和弦那条基线 */
  baseY: number;
  chords: { x0: number; x1: number; y: number }[];
  /** 本小节的左右界（上一条 / 下一条小节线） */
  barLeft: number;
  barRight: number;
  /** 段落词最左能到哪儿：一般就是 `barLeft`，行首那一条是版心左缘（见下） */
  hangLeft: number;
  /** 行的右缘（版心右缘）。**段落词一个字都不许挂到版心外面**，越过小节线也不行。 */
  rightLimit: number;
  /** 行首那一条：落点只有「就地」和「跨在锚点上」两种，不许往右让、更不许抬起来。 */
  atLineStart?: boolean;
  /** 谱面为它缩进过（`Line.sectionWordIndent`），于是**跨在锚点上方**——左括号落到
   *  音符左边、词身压着音符。没缩进过就老老实实从锚点起排。 */
  straddle?: boolean;
  /** 锚点音符**自己头上那个和弦**的右缘（没有就不给）。它跟着音符走，撑开、匀空档
   *  都够不着，所以词只能落到它右边去（原书的 `G（副歌）`）。 */
  ownChordRight?: number;
}

/** 段落词的落点。 */
export interface SectionWordSlot {
  x: number;
  /** 让不开，只能抬到和弦上方一层 */
  lifted: boolean;
  /** 要不抬起来，本小节右界还差多少（lifted 时 > 0） */
  shortfall: number;
}

/**
 * 段落词能往左挂多远。锚点左边还有小节线（`barLeft` 找得到）就不许越过它——越过去
 * 就成了上一小节的标记；**行首**那一条左边没有小节线，最多到**版心左缘**。
 *
 * 原来准它伸进左边距九成（原书在行尾也让段落词伸出版心），但那等于挂到离纸边 6pt 的地方
 * ——024/371/381 三首实测就挂在那儿。口径改成「一个字都不许出版心」。
 */
export function sectionWordHangLeft(barLeft: number | undefined): number {
  return barLeft ?? 0;
}

/**
 * 段落词摆哪儿——**纯几何，不碰页面树**。
 *
 * 先按锚点音符摆在和弦基线上，撞上和弦就**沿 x 让**：右移到那个和弦右边（一路跳过挨着的
 * 和弦找空档，和弦密的行上第一个空档往往在两三个和弦之后），右边出了小节就左移。
 * 小节首本来只许右移，但**行首**那一条例外：可以整个挂到锚点音符**左边**、伸进左边距
 * （`hangLeft`）——原书在行尾也是这么让它伸出版心的。这一步比撑开整个小节省地方，
 * 381《进深进深入主仁爱深渊》的弱起「（副歌）」原来要把弱起小节撑宽一个词。
 * 都让不开才退到和弦**上方**一行，那样虽然多占一层，至少不叠字。
 *
 * 这个判据被两处共用，**必须是同一份代码**：`Line.spreadForSectionWords`（排版前预演，
 * 据此算要撑开多少）与 `Line.addSectionWords`（justify 之后真正摆）。各写一套就会错配——
 * 129 首《荣耀的一天》的「（副歌）」曾因此被抬到和弦上方（spread 那边只按「锚点到小节线
 * 够不够放下这几个字」算，没算跳过和弦这一段）。
 */
/**
 * 段落词的字宽——**要按标点挤压量**（全书半身式，见 common/cjkpunct.ts）。
 *
 * 「（副歌）」四个字里有两个全角括号，半身档下各压掉半格，整词窄一个字身。照全宽量的话，
 * 一是**摆的时候两侧各空半格**（与「（第一调）」那个老毛病同源），二是**冲突检测偏胖**，
 * 明明躲得开和弦却判成让不开，于是去撑小节——撑开量全堆在一两个空档上，音符右边就
 * 空出一大块（173/175/189/193 四首的「（副歌）」）。量和画共用这一份笔位，两边不会错开。
 */
export function sectionWordRun(font: Font, text: string, mode: CompressMode): { width: number; xs: number[] | null } {
  if (mode === "none") return { width: font.measureText(text), xs: null };
  const { xs, width } = font.run(text, mode);
  // 首字是开括号时它的**笔位是负的**（半身档下「（」左挪半格，墨才落在半角格里）。
  // 落点是拿 `x` 当左界算的，不把这半格挪回来，段落词就整体左偏、挂出版心
  //（line-check 的 V1：106/170/189… 六首起点量到 60.x，版心左缘 62.8）。
  const lead = xs[0] ?? 0;
  return { width: width - lead, xs: xs.length > 1 ? xs.map((v) => v - lead) : null };
}

export function placeSectionWord(g: SectionWordGeom): SectionWordSlot {
  // 与和弦之间要留的净空。**半身档下末字是收口括号**，它的墨迹一直顶到 advance 的右边缘，
  // 原来那 0.3 个字身量到纸上只剩一线（173 的「（副歌）」右括号与后面的 G 描边挨着）。
  const gap = g.size * 0.6;
  // 压不压字看**全行的和弦**（段落词本来就可以伸出小节线，撞的往往是下一小节的第一个和弦）；
  // 但**让位只能在本小节内**——这两件事口径不同，别混。撞上小节外的和弦时右移左移都没用，
  // 只能靠 spreadForSectionWords 撑开本小节：小节线右边的东西整体右移，段落词留在原处，空档就出来了。
  // 「撞不撞」按**留了净空的**区间算：光看有没有重叠，落点会紧贴着和弦停下
  //（173 的「（副歌）」右括号与 G 之间只剩 0.4pt）。
  // 纵向那一档取 1.5 个字身：和弦记的是**框顶**、段落词记的是**基线**，两者同带时差
  // 恰好一个字身上下——照 `< size` 判会**整整差一线**地判成「不同带、不算撞」，
  // 于是词就直接印在和弦上（020 行首的 B）。
  const hit = (x: number): { x0: number; x1: number } | undefined =>
    g.chords.find((c) => Math.abs(c.y - g.baseY) < g.size * 1.5 && x - gap < c.x1 && c.x0 < x + g.width + gap);
  // 行首那一条先试「跨在锚点上」：谱面已经为它缩进过半个词（`sectionWordIndent`），
  // 左边那点地方就是给左括号留的。整个躲到音符左边没必要，就地从锚点起排又会把
  // 音符与小节线之间豁开一道口子——摆中间，两头都只让半个词。
  if (g.atLineStart) {
    // 行首这一条只在两个落点里挑：**就地**（从锚点起排）或**跨在锚点上**（谱面为它
    // 缩进过时）。跨在音符上是首选，但**锚点音符自己头上有和弦**时（020 行首的 B）
    // 那个和弦挪不动——它跟着锚点走，撑开、匀空档都够不着它，于是整个词让到最左边。
    // 撞上了也**摆在这儿不动**，只报「后面那个和弦还得让开多少」——不许再往右让、
    // 更不许抬到和弦上方（刻意否掉的），差的量由 `Line.nudgeForSectionWords`
    // 在 justify 之后从行内其它空档里匀出来。
    // **锚点音符自己头上压着和弦**时（020/103/131 行首的那个）它是挪不开的——它跟着
    // 音符走，撑开、匀空档都够不着。那就只有一个落点：它的右边（原书的 `G（副歌）`）。
    const cands = g.ownChordRight !== undefined
      ? [g.ownChordRight + gap]
      : g.straddle
        ? [Math.max(g.hangLeft, g.anchorX - g.width / 2), g.anchorX]
        : [g.anchorX];
    for (const x of cands) if (!hit(x)) return { x, lifted: false, shortfall: 0 };
    // 都撞就退回**首选**那个落点报差额（不是最后一个候选）：差额是拿来匀空档的，
    // 照更靠右的候选算会多推一截，词摆回首选落点后与和弦之间就空出小半个词
    // （173/189/193 空出 15pt）。
    const x = cands[0];
    const block = hit(x)!;
    return { x, lifted: true, shortfall: x + g.width + gap - block.x0 };
  }
  const first = hit(g.anchorX);
  if (!first) return { x: g.anchorX, lifted: false, shortfall: 0 };
  // 右移找空档：**只跳过本小节内的和弦**。挡路的和弦已经在小节线右边（属下一小节）时就别再跳了，
  // 再跳落点就落到下一小节里去了——那个标记看着就成了下一小节的（405《信靠顺服》的「（副歌）」
  // 曾这样越过小节线、挤到 D7 边上）。那种情形交给 `spreadForSectionWords` 撑：撑开会把小节线
  // 右边的东西整体右移，段落词留在原处，空档就出来了，而且要撑的只是「差的那一点」。
  let cand = first.x1 + gap;
  let block = hit(cand);
  while (block && block.x0 < g.barRight) {
    // **落点必须真的往前走**，否则原地打转停不下来：`hit` 现在按「留了净空的区间」判，
    // 而候选落点正是 `挡路者.x1 + gap`，浮点上 `x1 + gap - gap` 可能比 `x1` 小那么一丁点，
    // 于是又命中同一个和弦（160《我需要祢》就这样把排版卡死）。
    const next = block.x1 + gap;
    if (next <= cand) break;
    cand = next;
    block = hit(cand);
  }
  // 落点**起点必须留在本小节内**；尾巴可以伸过小节线（原书就有印到线右边的），只要不压字、不出版心。
  if (!block && cand < g.barRight && cand + g.width <= g.rightLimit)
    return { x: cand, lifted: false, shortfall: 0 };
  // 只差一点点就能摆下（挡路的是小节线右边那个和弦）——报「还差多少」，让撑开去补
  if (block && cand < g.barRight && cand + g.width <= g.rightLimit)
    return { x: cand, lifted: true, shortfall: cand + g.width - block.x0 };
  const left = first.x0 - g.width - gap;
  if (left >= g.hangLeft && !hit(left) && g.anchorX > g.hangLeft) return { x: left, lifted: false, shortfall: 0 };
  // 让不开就挂到锚点音符左边——行首那一条 `hangLeft` 在左边距里，够挂；
  // 行中的 `hangLeft` 就是 `barLeft`，挂不出去，照旧往下走抬升。
  const hang = g.anchorX - g.width - gap;
  if (hang >= g.hangLeft && !hit(hang)) return { x: hang, lifted: false, shortfall: 0 };
  // 抬起来那一层同样**一个字都不许出版心**（行末那一条锚点靠右时会伸出去）。
  // 先按右缘钳，再按 hangLeft 钳，**冲突时以不出版心为准**——原来外面套的那个
  // `Math.max(hangLeft, …)` 会在「词比 hangLeft 到版心右缘还宽」时把落点顶回去，
  // 于是仍旧挂出版心（120 首的「（副歌）」）。
  // 左界这里取的是**版心左缘（0）而不是 hangLeft**：hangLeft 是「不许越过上一条小节线」，
  // 那是就地摆放时的口径；抬起来这一层已经离开了和弦带，越过小节线也不会被读成
  // 上一小节的标记，而「出版心」是硬伤。
  const lifted = Math.max(0, Math.min(g.anchorX, g.rightLimit - g.width));
  return { x: lifted, lifted: true, shortfall: Math.max(0, cand + g.width - g.barRight) };
}
