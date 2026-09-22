// 简谱排版算法：谱行 Line（横向分配、上带堆叠、弧线、段落词）与 Layout（断行分页）。
// 页面树原语在 pageitem.ts，格位在 entry.ts，样式旋钮在 options.ts。

import { paginate } from "../jianpu/vertical";
import { identityPlan, walkPlay } from "../jianpu/expand";
import { Fraction } from "../common/fraction";
import { Point } from "../common/geom";
import { GlyphCodes } from "../smufl/smufl";
import { BandItem, bandTop, stackUpperBand } from "./upperband";
import { BarStyle, StartStopDiscontinue } from "../score/enums";
import { measureDuration, type JChord, type JMeasure, type JNote, type JScore } from "./input";
import { getOrNull, PageItem, GraphicPath, Group, TextFrame, SmuflText, JpNumber, Lyric, Tie, Slur, slurStyleOf, type SlurStyle, type SlurTieBase } from "./pageitem";
import { Entry, KeySig, TimeSig, NoteEntry, Barline, LineBreak, BeamLine, EntryItemInfo, entryBounds, normalizeEntryX, placeSectionWord, sectionWordHangLeft, sectionWordRun, type SectionWordSlot } from "./entry";
import { LayoutOptions } from "./options";

// ---------------- Line / layout ----------------

export class Line {
  group = new Group();
  /** 本行为行首段落词让出的左缩进（`sectionWordIndent` 定，`updateXPos` 施加）。
   *  只有让过地方的行，段落词才按「跨在音符上」摆。 */
  sectionIndent = 0;
  entries: Entry[] = [];
  beams: BeamLine[] = [];
  maxBeamLevel = 0;
  chordEntry = new Map<JChord, NoteEntry>();
  /** 段落词挪位（行末挪到下一行行首，见 `layout`）：有记录的以它为准，否则取输入。 */
  sectionWords = new Map<JChord, string | null>();
  /** 符杠分组：每装载一个小节按拍重组一次（`beamGroupsOf`），同一和弦以最后一次为准。 */
  beamGroups = new Map<JChord, BeamGroup>();
  /** Arcs drawn on this line, in line coordinates (see clipBarlinesUnderSlurs). */
  slurTies: SlurTieBase[] = [];
  /** 三连音括线的**墨迹盒**（绝对，相对 `Line.group`）。`addTuplet` 现画现记：
   *  括线是 GraphicPath + SmuflText 拼的，事后从 bound 反推不如画的时候顺手记准。
   *  上方带堆叠（`stackAbove`）与房号车道都读它。 */
  tupletBoxes: {
    key: object; x0: number; x1: number; top: number; bottom: number;
    /** 数字「3」骑在横线中间那一小段：它比横线高出半个墨迹。 */
    numX0: number; numX1: number; numTop: number;
  }[] = [];
  /** `stackAbove` 算出来的上方带各对象的墨迹盒（已含抬升），`addEnding` 定车道时要用。 */
  private bandBoxes: BandItem[] = [];
  /** 表情/跳转记号：纵向位置**堆叠之后**才定，见 placeDirections。
   *  `barLeft` 是本小节左侧那条小节线——让位不许越过它（越过去就成了上一小节的记号）。 */
  private pendingDirs: { grp: Group; anchorX: number; fallbackY: number; barLeft: number }[] = [];
  /** 弧的样式，由 addTie/addSlur 从 LayoutOptions 暂存下来（addSlurTie 拿不到 opt）。 */
  private slurStyle: SlurStyle = { thickness: 6, color: 0 };
  /** 弧罩住这么多音符就改画扁平式（0 = 只按跨度判）。见 LayoutOptions.slurFlatNotes。 */
  private slurFlatNotes = 0;

  private sectionWordOf(e: NoteEntry): string | null {
    return this.sectionWords.has(e.chord) ? this.sectionWords.get(e.chord)! : e.chord.sectionWord;
  }

  private addEntry(e: Entry): void {
    if (e instanceof NoteEntry) {
      if (e.number?.text === "-") {
        // beat-extension dash: not a chord anchor
      } else {
        this.chordEntry.set(e.chord, e);
      }
    }
    this.entries.push(e);
    this.group.add(e.group);
    e.line = this;
  }

  private entryX(e: Entry): number {
    let res = e.group.x;
    const it = e.entryItem();
    if (it === null) return res;
    res += it.x;
    return res;
  }

  private adjust(width: number, maxHorizontalScale: number): void {
    const infos: EntryItemInfo[] = [];
    let idx = 0;
    for (const e of this.entries) {
      const next = getOrNull(this.entries, idx + 1);
      if (next === null) break;
      if (next instanceof LineBreak) break;
      const xx = this.entryX(e);
      const xxNext = this.entryX(next);
      const dist = xxNext - xx - e.entryWidth();
      if (dist < -1) throw new Error("neg dist");
      const smallDist = e instanceof NoteEntry && !(next instanceof Barline);
      const it = new EntryItemInfo();
      it.entry = e;
      it.dist = dist;
      it.rate = smallDist ? 2 : 1;
      if (next instanceof TimeSig) it.rate = 0.1;
      infos.push(it);
      idx++;
      if (idx === this.entries.length - 1) break;
    }
    infos.sort((a, b) => {
      const diff = a.dist * b.rate - b.dist * a.rate;
      if (diff < 0) return -1;
      else if (diff === 0) return a.rate < b.rate ? -1 : a.rate > b.rate ? 1 : 0;
      else return 1;
    });

    let right = 0;
    let lastVisible: Entry | null = null;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!(e instanceof LineBreak)) {
        if (lastVisible === null) lastVisible = e;
      }
      const r = e.group.x + e.group.childrenBound.right;
      if (r > right) right = r;
      if (e instanceof NoteEntry) {
        if (e.lrc !== null) break;
      }
    }
    let extra = width - right;
    const maxExtra = maxHorizontalScale * right;
    let dontMoveLastBarline = false;
    if (extra > maxExtra) {
      extra = maxExtra;
      dontMoveLastBarline = true;
      // 非致命：某行内容远窄于可用宽度（如稀疏/末行），此处已 clamp 掉多余空白照常排版。
      // 仅调试时输出，避免污染控制台（识别出的谱常有短行会触发）。
      if ((globalThis as { __omrDebug?: boolean }).__omrDebug) console.debug("[layout] space too large (clamped)");
    }

    let totalDist = 0;
    let totalRate = 0;
    let end = 0;
    let share = 0;
    for (let i = 0; i <= infos.length; i++) {
      end = i;
      if (i === infos.length) break;
      const it = infos[i];
      const curShare = it.dist / it.rate;
      share = (extra + totalDist + it.dist) / (totalRate + it.rate);
      if (share < curShare) break;
      totalDist += it.dist;
      totalRate += it.rate;
    }
    share = (extra + totalDist) / totalRate;

    const offsets = new Map<Entry, number>();
    for (let i = 0; i < end; i++) {
      const it = infos[i];
      const dist = share * it.rate;
      offsets.set(it.entry!, dist - it.dist);
    }
    let offset = 0;
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        for (const dot of e.octaveDot) {
          dot.x = e.number!.x + e.number!.cx - dot.width / 2;
        }
      }
      e.group.x += offset;
      if (offsets.has(e)) offset += offsets.get(e)!;
    }
    if (!dontMoveLastBarline) this.adjustLastBarline(lastVisible, width);
  }

  private adjustLastBarline(lastVisible: Entry | null, width: number): void {
    if (!(lastVisible instanceof Barline)) return;
    const prev = this.entries.indexOf(lastVisible) - 1;
    const prevEnt = getOrNull(this.entries, prev);
    if (!(prevEnt instanceof NoteEntry)) return;
    const dx = lastVisible.group.x - (prevEnt.group.x + prevEnt.number!.right);
    const maxDx = prevEnt.number!.font.size * 3;
    const space = width - lastVisible.group.bound.right - lastVisible.group.x;
    if (space > 0) lastVisible.group.x += Math.min(space, maxDx - dx);
  }

  /** 由 layout(opt) 注入，供 calcXPos 用（Line 自己不持有 LayoutOptions）。 */
  lyricGap = 0;

  /**
   * 相邻的两条小节线只留一条。
   *
   * `‖:`（反复段起点）画在小节**开头**，而上一小节末尾本来就有一条细线，两条挨在一起
   * 就成了「细 粗 细」三条竖线（010《愿祢崇高》第一行开头）。原书是「粗 细 + 两点」。
   * 普通的那条让位；两条都不普通就看是不是**前后反复背靠背**（`:‖` 紧接 `‖:`）：
   * 那两条要合成一条「细 粗 细」+ 两侧各两点，五线谱就是这么画的
   * （J14 原来画成两根粗线并排）。其余组合仍旧都留着。
   */
  private dropDoubledBarlines(opt: LayoutOptions): void {
    for (let i = this.entries.length - 1; i > 0; i--) {
      const cur = this.entries[i];
      const prev = this.entries[i - 1];
      if (!(cur instanceof Barline) || !(prev instanceof Barline)) continue;
      // **删掉一条之后要在原地重判**：删的若是中间那条普通线，左右两条就成了新的相邻对
      //（116《献上感恩》二房 `discontinue` 小节末尾补的那条细线夹在 `:‖` 与 `‖:` 中间），
      // 照直 `i--` 会把这对跳过去，四条竖线就并排画了出来。
      if (prev.isPlain) {
        this.entries.splice(i - 1, 1);
        i++;
        continue;
      }
      if (cur.isPlain) {
        this.entries.splice(i, 1);
        i++;
        continue;
      }
      if (prev.spec.repeatBackward && cur.spec.repeatForward
          && !prev.spec.repeatForward && !cur.spec.repeatBackward) {
        const merged = new Barline(false, opt, { repeatBackward: true, repeatForward: true });
        merged.update();
        this.entries.splice(i - 1, 2, merged);
        i++;
        continue;
      }
      // 两条都不普通、又不构成 `:‖:`：只要其中一条是反复记号，仍旧只画一条
      //（116 首那处是终止线 `light-heavy` 紧挨着反复起点 `heavy-light`，
      // 照直画就是「细 粗 粗 细」四道竖线）。两条都跟反复无关的组合维持原样，不动。
      const back = prev.spec.repeatBackward || cur.spec.repeatBackward;
      const fwd = prev.spec.repeatForward || cur.spec.repeatForward;
      if (!back && !fwd) continue;
      const merged = new Barline(false, opt, {
        style: fwd ? BarStyle.HEAVY_LIGHT : BarStyle.LIGHT_HEAVY,
        repeatBackward: back,
        repeatForward: fwd,
      });
      merged.update();
      this.entries.splice(i - 1, 2, merged);
      i++;
    }
  }

  /**
   * **每个和弦的自然横向区间**（`[x0, x1]`，未分行、未 justify）。
   *
   * 「这一行放不放得下」要拿**真实坐标**判，不能按格数估（用户口径：「不要算格数，
   * 真实坐标排一遍，放不下再补刀」）。格数是近似——同样 30 格，歌词字多的行、带八度点
   * 与附点的行都更宽；估宽了排版器就会在断点之外**又折一刀**，估窄了整首白白排稀。
   *
   * 返回的坐标与 `doLineBreak` 判折行用的是**同一把尺子**（`group.x + maxX`），
   * 所以「Σ 宽度 ≤ 版心宽」与排版器的判断一致。断点不影响这些坐标（`calcXPos` 在
   * `doLineBreak` 之前跑），所以整首量一次就够。
   */
  naturalSpans(opt: LayoutOptions): Map<JChord, { x0: number; x1: number }> {
    this.lyricGap = opt.lyricGap;
    this.dropDoubledBarlines(opt);
    this.calcXPos();
    // **一个和弦可能摊成好几个 entry**（`5---` 是音符 + 三根增时线各一个 NoteEntry，
    // 共用同一个 `Chord`）：照直 `set` 会被最后那根增时线覆盖掉，而**歌词挂在头一个
    // entry 上**——「详；」两个字比一根 `-` 宽得多，右缘就这么丢了。065《马槽圣婴》
    // 因此把 24 拍的一行量成 309 宽（版心 312、看着放得下），排版器照真实坐标一量
    // 却放不下，把行末那个 `7-` 连同三段歌词折成了单独一行（中间行只有一个音）。
    // 取各 entry 的**最左左缘、最右右缘**。
    // 和弦与表情记号不算进这把尺子，理由见 `entryRight`（与 doLineBreak 共用）。
    const out = new Map<JChord, { x0: number; x1: number }>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const g = e.group;
      // 与 doLineBreak 同一把尺子：原点已归到音符内容左缘，右缘不含和弦
      const x0 = g.x;
      const x1 = g.x + entryBounds(g).right;
      const prev = out.get(e.chord);
      out.set(e.chord, prev ? { x0: Math.min(prev.x0, x0), x1: Math.max(prev.x1, x1) } : { x0, x1 });
    }
    return out;
  }

  private calcXPos(): void {
    for (const e of this.entries) normalizeEntryX(e.group);
    let curX = 0;
    this.entries.forEach((e, idx) => {
      const it = e.entryItem();
      let x = 0;
      let w = 0;
      curX += e.leadSpace; // 倚音那串小号数字（见 Entry.leadSpace）
      if (it !== null) x = it.x;
      w = e.entryWidth();
      if (e instanceof Barline && it) {
        const next = getOrNull(this.entries, idx + 1);
        if (!(next instanceof TimeSig)) curX += it.height / 5;
      }
      // 拍号前后那一格由 `TimeSig` 自己给（leadSpace + entryWidth，见 TimeSig.layout）。
      e.group.x = curX - x;
      curX += w;
    });
    curX = 0;
    let offset = 0;
    let prevBlank = 0; // 上一条歌词末字右侧的留白（见下面的「标点挤压」）
    for (const e of this.entries) {
      // **各段歌词一起算**：叠排时一个音符底下摞着好几段，只按第一段留位置的话，
      // 字更多的那几段就会互相压上去（156《百只羊有九十九》第 2 段 `主说那只亦我所有,`
      // 比第 1 段长出好几个字）。取各段里最靠左的左缘、最靠右的右缘。
      const lrcs = e instanceof NoteEntry ? e.lrcs.filter((l) => l.text) : [];
      if (!lrcs.length) {
        e.group.x += offset;
        continue;
      }
      // **前置标点悬挂**：`“凡` 这种带前引号的字，整体宽是两个字，按整体去避让上一个字
      // 就把这个音符整个往右推，一行的音符间距跟着拉开（190 首那一行）。
      // 引号只要不压到**字**上就行，压在小节线那一带没关系——所以避让只看主体（去掉左标点），
      // 让引号伸进左边的空档里。右标点仍照算，否则下一个字会压上来。
      // 悬挂**多少由墨迹说了算**（标点挤压）：引号的墨只占方框右半边，上一个字的尾标点
      //（`音:` 的冒号）右边也空着一截，两边的留白加上字距就是能挤进去的量。
      // 照整个 `leadWidth` 悬挂会把引号压在那个冒号上（376《将心给我》的 `呼召:“将心给我。”`），
      // 一律不悬挂又把音符间距白白拉开（190 首）——按墨迹算两头都占着。
      // **跨音符的那一对标点也得挤**：`召：` 的冒号与 `“将` 的引号分属两个 `<text>`，
      // OpenType 的上下文特性管不到它们，挤压由 `Lyric.update` 各自压完、这里只管避让。
      // 避让补的是一道**下限**——挤完的墨迹间距不许比「这两个字排在同一个 `<text>` 里」还紧。
      // 同 text 的墨间距 = prevBlank + headBlank（两头的留白都已经是**挤压后**的口径），
      // 跨音符的 = room − hang = prevBlank + lyricGap + headBlank − hang，
      // 两边一减，下限就是 **`hang ≤ lyricGap`**：悬挂只许吃掉字与字之间那道呼吸，
      // 不许吃到墨迹之间的距离里去。
      const room = prevBlank + this.lyricGap + Math.min(...lrcs.map((l) => l.headBlank));
      const hang = Math.max(0, Math.min(Math.min(...lrcs.map((l) => l.leadWidth)), room, this.lyricGap));
      const leftMost = Math.min(...lrcs.map((l) => l.x)) + hang;
      const rightMost = Math.max(...lrcs.map((l) => l.x + l.width));
      const xx = Math.max(curX - leftMost, e.group.x + offset);
      offset = xx - e.group.x;
      e.group.x = xx;
      curX = xx + rightMost + this.lyricGap;
      // 各段里**留白最少**的那一段说了算（有一段挤不下就是挤不下）
      prevBlank = Math.min(...lrcs.map((l) => l.tailBlank));
    }
  }

  /**
   * 在**假想的 justify 之后**跑一次 `fn`，跑完把横坐标复原。
   *
   * `adjust` 只会往空档里加距离，所以「justify 之后放得下」是比撑开更该先问的一句。
   */
  private probeJustified<T>(width: number, opt: LayoutOptions, fn: () => T): T {
    const saved = this.entries.map((e) => e.group.x);
    try {
      this.adjust(width, opt.maxHorizontalScale);
      return fn();
    } finally {
      this.entries.forEach((e, i) => { e.group.x = saved[i]; });
    }
  }

  /**
   * 为段落词（「（副歌）」）**按小节撑开**。
   *
   * 段落词印在和弦那一带、不许跨过小节线，横向地方不够时就得撑。但撑开量**不能全堆在
   * 锚点那一个音符上**——那一处的间距会突兀地大出一截。这里把需要的量**均摊到锚点所在
   * 小节里余下的每个音符间距**上，小节之后的内容整体右移同样的量。
   * 段落词本身仍可横向伸出音符的范围，撑开只为躲开**后面的和弦**。
   *
   * 撑多少**由 `placeSectionWord` 说了算**（与真正摆的 `addSectionWords` 同一个判据）：
   * 「够不够」不是「锚点到小节线放不放得下这几个字」，而是「跳过挨着的和弦之后还有没有空档」。
   * 两处各算各的会错配——129 首就是这么抬起来的：spread 按锚点算只差 2pt、撑完仍让不开。
   * 而且均摊是**整条小节一起拉伸**，末尾那个空档只分到 1/steps，所以要的是「撑多少才够」，
   * 不是「差多少」——这里按落点判据二分求最小的撑开量。
   */
  spreadForSectionWords(opt: LayoutOptions, lineWidth: number): void {
    if (opt.sectionWordSize <= 0) return;
    const size = opt.sectionWordSize;
    const font = opt.lrcFont.makeWithSize(size);
    const bars: number[] = [];
    this.entries.forEach((e, i) => { if (e instanceof Barline) bars.push(i); });
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!(e instanceof NoteEntry) || !this.sectionWordOf(e)) continue;
      const item = e.entryItem();
      if (!item) continue;
      const endIdx = bars.find((b) => b > i) ?? this.entries.length;
      const inBar: number[] = [];
      for (let k = i + 1; k < endIdx; k++) inBar.push(k);
      const steps = inBar.length + 1; // 锚点到小节线之间有这么多段间距
      /** 撑开量 S 里有多大一份落到第 k 个条目上（锚点不动、小节线整条右移 S）。 */
      const shiftFrac = (k: number): number => {
        if (k <= i) return 0;
        if (k >= endIdx) return 1;
        return (inBar.indexOf(k) + 1) / steps;
      };
      /** 从**当前坐标**造一个「撑开 spread 时段落词落哪儿」的函数。 */
      const placer = (): ((spread: number) => SectionWordSlot) => {
        const chordBase: { x0: number; x1: number; y: number; f: number }[] = [];
        this.entries.forEach((ent, k) => {
          if (!(ent instanceof NoteEntry)) return;
          for (const it of this.chordGroups(ent))
            chordBase.push({ x0: ent.group.x + it.x, x1: ent.group.x + it.x + it.width, y: ent.group.y + it.y, f: shiftFrac(k) });
        });
        const anchorX = e.group.x + item.x;
        const lastEnt = this.entries[this.entries.length - 1];
        const barRight0 = this.entries[endIdx]?.group.x ?? lastEnt.group.x + lastEnt.group.width;
        const barLeftAt = [...bars].reverse().map((b) => this.entries[b].group.x).find((bx) => bx <= anchorX);
        const barLeft = barLeftAt ?? 0;
        const width = sectionWordRun(font, this.sectionWordOf(e)!, opt.punctCompress).width;
        return (spread: number): SectionWordSlot =>
          placeSectionWord({
            anchorX,
            width,
            size,
            baseY: this.sectionWordBaseY(e, opt, chordBase),
            chords: chordBase.map((c) => ({ x0: c.x0 + spread * c.f, x1: c.x1 + spread * c.f, y: c.y })),
            barLeft,
            barRight: barRight0 + spread,
            hangLeft: sectionWordHangLeft(barLeftAt),
            rightLimit: lineWidth || this.group.width || barRight0 + spread,
            atLineStart: this.entries[0] === e,
            straddle: this.sectionIndent > 0,
            ownChordRight: this.ownChordRight(e),
          });
      };
      // **先问 justify 之后放不放得下**：本行内容窄时（副歌那种只有一个弱起音符起头的行）
      // justify 会把空档撑得很宽，段落词本来就摆得下，这时再撑一遍等于白撑——撑出来的那个
      // 大空档 justify 也收不回去（`adjust` 只加不减），音符右边就空出一大块
      //（173/175/189/193 四首的「（副歌）」）。
      if (lineWidth > 0 && !this.probeJustified(lineWidth, opt, () => placer()(0)).lifted) continue;
      const at = placer();
      // 行首那一条不在这儿撑：justify 前的间距是紧的，照它算出来的撑开量会大出一截，
      // 而 justify 随后又要把同一段空档拉开一遍——两笔叠起来就是音符右边那道大口子。
      // 它改在 justify 之后按真实坐标微调（`nudgeForSectionWords`）。
      if (this.entries[0] === e) continue;
      const now = at(0);
      if (!now.lifted) continue;
      // 上界：末尾那个空档只分到 1/steps 的撑开量（空档更靠前的话分到的更多），
      // 所以 shortfall × steps 一定够；撑到上界仍让不开就别白撑（左右都是密和弦），维持抬起。
      let hi = now.shortfall * steps + size;
      if (at(hi).lifted) continue;
      let lo = 0;
      while (hi - lo > 0.25) {
        const mid = (lo + hi) / 2;
        if (at(mid).lifted) lo = mid;
        else hi = mid;
      }
      const need = hi;
      // **撑开会把整行拉长**（小节线右边的东西整体右移 `need`），撑过头整条谱行就伸出版心去了
      //（120《耶稣是我亲爱救主》实测越出右缘 57pt——正好是这里的撑开量；段落词本身还在
      // 版心内，所以 line-check 的 L6 一直报 0，看 PDF 才发现是**整行**出去了）。
      // 撑不下就别撑：维持 `placeSectionWord` 给的抬起落点，把段落词摆到和弦上方一层
      //（用户口径：「排不下的时候就把文本放到和弦上方」）。
      const lineRight = lineWidth || this.group.width || 0;
      if (lineRight > 0) {
        const last = this.entries[this.entries.length - 1];
        if (last.group.x + last.group.width + need > lineRight) continue;
      }
      inBar.forEach((k, n) => { this.entries[k].group.x += (need * (n + 1)) / steps; });
      for (let k = endIdx; k < this.entries.length; k++) this.entries[k].group.x += need;
    }
  }

  /** 段落词的基线：本行有和弦就对到和弦那一条（原书就是并排的），一个都没有才自己算。 */
  private sectionWordBaseY(e: NoteEntry, opt: LayoutOptions, chords: { y: number }[]): number {
    if (chords.length) return chords[0].y + opt.sectionWordSize;
    const inkTop = Math.min(opt.numberBound("1").top, e.group.childrenBound.top);
    return e.group.y + inkTop - opt.chordGap;
  }

  /** 一个音符条目上挂的和弦组（`addHarmony` 打的 `chord-group` 标记）。 */
  private chordGroups(e: NoteEntry): Group[] {
    return e.group.children.filter((it): it is Group => it instanceof Group && it.classes.has("chord-group"));
  }

  /**
   * **表情/跳转记号**（`rit.` / `Fine` / `D.S.` / `mf`）：画在锚点音符上方、和弦那一带。
   *
   * 与和弦同层（`collectBandItems` 的 layer 1），但 `rank` 排在和弦之后——同一个音符
   * 上既有和弦又有记号时，让位的是记号（和弦是原书排得最齐的一档，不该被顶走）。
   * 力度记号走 Bravura 的力度字形（`mf` = mezzo + forte，与文本谱共用 pu/glyph.ts 那张表）。
   *
   * 斜体不做：底本把 `rit.` 标成 `font-style="italic"`，但 `Font` 一路到测量、
   * SVG、PDF 都只有 family/size/weight 三档，为一个记号加一档不划算。
   */
  /** 一组表情/跳转记号排出来有多宽（与 `addDirections` 同一套字体与间距）。 */
  private directionWidth(ch: JChord, opt: LayoutOptions): number {
    const size = opt.chordSize > 0 ? opt.chordSize : opt.numberSize * 0.6;
    let w = 0;
    for (const d of ch.directions) {
      w += (d.music ? opt.smuflFont : opt.numberFont).makeWithSize(size).measureText(d.text) + size * 0.25;
    }
    return Math.max(0, w - size * 0.25);
  }

  /**
   * **给小节末尾的跳转记号腾地方**（`Fine` / `D.S.`）。
   *
   * 它们贴着小节线右对齐、与和弦同一条基线（`placeDirections`）。小节末尾本来就有和弦时
   * 两者会挤在一处，让不开就只能抬到上面一层——而原书是并排印的。用户口径：
   * **需要的话把小节撑宽**。做法与段落词那套一样（`spreadForSectionWords`）：
   * 锚点不动，小节内的间距均摊拉开，小节线右边的东西整体右移。
   *
   * 撑开**不许把整行拉出版心**（同 120 首那条教训），撑不下就维持原样、让 `placeDirections`
   * 去抬那一层。要排在 justify 之前（`updateXPos` 里）：justify 只会往空档里加距离、
   * 不会收窄，这里放得下、justify 之后也放得下。
   */
  spreadForBarEndMarks(opt: LayoutOptions, lineWidth: number): void {
    const size = opt.chordSize > 0 ? opt.chordSize : opt.numberSize * 0.6;
    if (size <= 0) return;
    const bars: number[] = [];
    this.entries.forEach((e, i) => { if (e instanceof Barline) bars.push(i); });
    const done = new Set<JChord>();
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!(e instanceof NoteEntry)) continue;
      if (!e.chord.directions.some((d) => d.atBarEnd) || done.has(e.chord)) continue;
      done.add(e.chord);
      const endIdx = bars.find((b) => b > i);
      if (endIdx === undefined) continue; // 行末没有小节线：撑了也没用
      const bar = this.entries[endIdx] as Barline;
      const barLeft = bar.group.x + bar.inkRight; // 记号右缘对到整条线的右缘（见 addDirections）
      // 本小节里最靠右的和弦（记号要排在它右边）
      let rightMost = -Infinity;
      for (let k = 0; k < endIdx; k++) {
        const ent = this.entries[k];
        if (!(ent instanceof NoteEntry)) continue;
        for (const it of this.chordGroups(ent)) rightMost = Math.max(rightMost, ent.group.x + it.x + it.width);
      }
      if (!Number.isFinite(rightMost)) continue; // 没有和弦，贴线放得下
      // 记号与小节线右对齐（`addDirections`），左边只留一道对和弦的净空
      const need = rightMost + size * 0.55 + this.directionWidth(e.chord, opt) - barLeft;
      if (need <= 0) continue;
      const last = this.entries[this.entries.length - 1];
      if (lineWidth > 0 && last.group.x + last.group.width + need > lineWidth) continue; // 撑出版心就别撑
      const inBar: number[] = [];
      for (let k = i + 1; k < endIdx; k++) inBar.push(k);
      const steps = inBar.length + 1;
      inBar.forEach((k, n) => { this.entries[k].group.x += (need * (n + 1)) / steps; });
      for (let k = endIdx; k < this.entries.length; k++) this.entries[k].group.x += need;
    }
  }

  addDirections(opt: LayoutOptions, lineWidth: number): void {
    const size = opt.chordSize > 0 ? opt.chordSize : opt.numberSize * 0.6;
    if (size <= 0) return;
    const drawn = new Set<JChord>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry) || !e.chord.directions.length) continue;
      // 同一个 Chord 在一行里会摊成好几个 NoteEntry（长音的增时线各占一个），只画一次
      if (drawn.has(e.chord)) continue;
      drawn.add(e.chord);
      const num = e.number;
      if (!num) continue;
      const grp = new Group();
      grp.classes.add("direction-group");
      let pen = 0;
      for (const d of e.chord.directions) {
        const tf = d.music ? new SmuflText(opt) : new TextFrame();
        tf.classes.add("direction");
        tf.color = opt.color;
        tf.text = d.text;
        tf.font = (d.music ? opt.smuflFont : opt.numberFont).makeWithSize(size);
        tf.inkBound = true; // 乐谱字体的全局 ascent/descent 有四个字号高，不能拿它当行高
        tf.update();
        tf.x = pen;
        pen += tf.width + size * 0.25;
        grp.add(tf);
      }
      grp.update();
      // **挂在行上、不挂在音符上**：记号（`Fine`、`D.S.`）跟段落词一样只是个标记，
      // 挂到音符组里就会被 `naturalSpans` 算进谱行宽度、把断句整个带偏
      //（096《哈利路亚！感谢主》实测从 4 行变成 2 行）。行级坐标也省得堆叠再换算。
      const inkTop = Math.min(opt.numberBound("1").top, e.group.childrenBound.top);
      const cx = e.group.x + num.x + num.cx;
      // 一个字都不许出版心（与段落词同口径，见 addSectionWords）
      const right = lineWidth || this.group.width || Infinity;
      // **写在小节末尾的贴着小节线右对齐**（`Fine` / `D.S.` 就是这么标的，底本还带
      // `justify="right"`）：居中在最后那个音符上方离小节线太远，原书是紧挨着线印的。
      const atEnd = e.chord.directions.some((d) => d.atBarEnd);
      let x = cx - grp.width / 2;
      // 本小节的左右两条小节线：`Fine` / `D.S.` 贴右边那条排，让位也只在这一格里
      const bars = this.entries.filter((b): b is Barline => b instanceof Barline);
      const barRight = bars.find((b) => b.group.x + b.inkLeft > cx);
      const barLeft = [...bars].reverse().find((b) => b.group.x + b.inkRight <= cx);
      // **与小节线右对齐**（用户口径）：记号右缘对到小节线**整组墨迹的右缘**。
      // 终止线是「细 + 粗」两条，对到细线左缘的话记号还落在粗线左边一大截。
      if (atEnd && barRight) x = barRight.group.x + barRight.inkRight - grp.width;
      grp.x = Math.max(0, Math.min(x, right - grp.width));
      // **小节末尾那些留到堆叠之后再定纵向位置**（`placeBarEndDirections`）：
      // 它要跟身边的和弦排齐，而和弦被弧顶起来是 `stackAbove` 里才发生的事，
      // 在这儿对齐的话就对到了抬之前的那条线上（064《啊！圣善夜》差 6.3pt）。
      // **纵向留到堆叠之后再定**（`placeDirections`）：记号要跟身边的和弦排齐，
      // 而和弦被弧顶起来是 `stackAbove` 里才发生的事。本行一个和弦都没有时才用
      // 这里算的落点（音符墨迹顶之上一个 `chordGap`）。
      this.pendingDirs.push({
        grp,
        anchorX: grp.x,
        fallbackY: e.group.y + inkTop - (opt.chordGap > 0 ? opt.chordGap : size),
        barLeft: barLeft ? barLeft.group.x + barLeft.inkRight : 0,
      });
      this.group.add(grp);
    }
  }

  /**
   * **和弦横向去重叠**：挨上了就把后面那个往右挪一点。
   *
   * 和弦按音符墨迹中心居中（`addHarmony`），宽的那些（`E♭7` 这种带升降号加后缀的）
   * 会顶到下一个和弦上——纯文本风格下尤其明显（后缀不再缩到 75%）。原书的宽和弦本来
   * 就不严格居中，所以让位的办法是**沿 x 让**，不是往上摞（摞起来一高一低更难看）。
   *
   * 挪动量封顶（`limit`）：挪过头就成了下一个音符的和弦，那还不如让它压着——
   * 全书 568 首里够得着这条的只有 019 / 078 那几处。
   */
  spreadChordsHorizontally(opt: LayoutOptions, lineWidth: number): void {
    const size = opt.chordSize;
    if (size <= 0) return;
    const right = lineWidth || this.group.width || Infinity;
    const gap = size * 0.28;
    const limit = size * 1.2;
    const boxes: { g: Group; x0: number; x1: number }[] = [];
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      for (const it of this.chordGroups(e))
        boxes.push({ g: it, x0: e.group.x + it.x, x1: e.group.x + it.x + it.width });
    }
    boxes.sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < boxes.length; i++) {
      const prev = boxes[i - 1], cur = boxes[i];
      const need = prev.x1 + gap - cur.x0;
      if (need <= 0) continue;
      // 一个字都不许出版心（与段落词、表情记号同口径）
      const dx = Math.min(need, limit, Math.max(0, right - cur.x1));
      if (dx <= 0) continue;
      cur.g.x += dx;
      cur.x0 += dx;
      cur.x1 += dx;
    }
    // **一个字都不许出版心**：行末音符顶着版心时，居中在它上面的和弦会有半个字伸出去
    //（396《我要向高山举目》实测右缘超 4.4pt）。从右往左收回来，收到贴着前一个和弦为止
    //（和弦本来就可以不严格居中，原书也这样）。左缘同理。
    for (let i = boxes.length - 1; i >= 0; i--) {
      const cur = boxes[i];
      const prevX1 = i > 0 ? boxes[i - 1].x1 : 0;
      let dx = 0;
      if (cur.x1 > right) dx = Math.max(right - cur.x1, prevX1 + gap - cur.x0);
      if (cur.x0 + dx < 0) dx = -cur.x0;
      if (dx === 0) continue;
      cur.g.x += dx;
      cur.x0 += dx;
      cur.x1 += dx;
    }
  }

  /**
   * **上方带的对象清单**：弧 / 三连音括线 / fermata / 和弦 / 转调标记，
   * 一律折成绝对**墨迹盒**交给 `upperband.ts::stackUpperBand` 统一分层。
   *
   * 带序（自下而上）：0 弧 + 三连音 + fermata，1 和弦，2 转调标记；房号（3）不在这里，
   * 它是**画的时候**按堆叠结果定车道的（`addEnding`）。
   *
   * 口径两条，都是从前那几个 lift 函数里搬过来的：
   *   - 让位的一律是**上层**（原书的排法是和弦在弧之上，弧不为和弦让）。
   *   - 同一条弧（或同一组三连音）底下的和弦**整排一起抬**，不然一高一低比压着还难看
   *     ——靠 `spread: "chord"` 表达。
   */
  private collectBandItems(): BandItem[] {
    const items: BandItem[] = [];
    // layer 0：弧（跨度小的留在下面，大的往上让——`rank` 就是跨度）
    for (const s of this.slurTies) {
      const x0 = s.x, x1 = s.x + s.width, top = s.y, bottom = s.y + s.height;
      // 弧在某一段里到底有多高：按抛物线近似（贝塞尔弧与它差不多），
      // 端点处贴着音符、中点处才是弧顶。压着弧的 fermata 多半落在两头，
      // 照包围盒让位就抬到半空中去了（302《一切全奉献》）。
      //
      // **扁平长连音线不吃这一套**（`SlurTieBase.flatHx > 0`）：它中段一路平着顶在 `top`，
      // 只有两端 hx 那一截往下收到音符上，而那两截是**贝塞尔的钩**、一出端点就贴着顶走
      // ——照抛物线（甚至照钩的线性插值）算，末端附近都会被判成「几乎贴着音符」，
      // 于是不让位，171《回家吧》末行的延长号就直接压在扁平线上。
      // 整条按 `top` 算：扁平线本来就只有几个点高（弧高的 0.75 再乘扁平那份薄），
      // 让位让过头也就多抬那么几个点，比压上去强得多。
      const at = (x: number): number => {
        if (s.flatHx > 0) return top;
        const u = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0;
        return bottom - 4 * (bottom - top) * u * (1 - u);
      };
      const topAt = (a: number, b: number): number => {
        const lo = Math.max(a, x0), hi = Math.min(b, x1);
        if (lo > hi) return bottom;
        const mid = (x0 + x1) / 2;
        return lo <= mid && mid <= hi ? top : Math.min(at(lo), at(hi));
      };
      items.push({ key: s, x0, x1, top, bottom, layer: 0, rank: s.width, kind: "slur", topAt });
    }
    // layer 0：三连音括线（盒子是 addTuplet 现画现记的）
    for (const b of this.tupletBoxes) {
      // 只有数字那一小段是高的，横线那一截只有线宽（见 addTuplet 里记盒子那儿的注释）
      const topAt = (a: number, c: number): number =>
        c > b.numX0 && a < b.numX1 ? Math.min(b.numTop, b.top) : b.top;
      items.push({
        key: b.key, x0: b.x0, x1: b.x1, top: Math.min(b.top, b.numTop), bottom: b.bottom,
        layer: 0, rank: b.x1 - b.x0, kind: "tuplet", topAt,
      });
    }
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      // layer 0：fermata 与奏法记号（`addNotations` 挂在音符组上）
      for (const t of e.notations) {
        const bnd = t.bound; // 页面坐标（SmuflText.bound 已经翻过来了，见那儿的注释）
        items.push({
          key: t,
          x0: e.group.x + t.x, x1: e.group.x + t.x + Math.max(t.width, bnd.width),
          top: e.group.y + t.y + bnd.top, bottom: e.group.y + t.y + bnd.bottom,
          // **点状标记让弧，不是弧让它**（用户口径）：`rank` 给一个很大的值，
          // 层内最后定位、撞上就往上抬。弧要贴着音符走，抬弧等于把整条弧掀起来。
          // 让位留一个整格 `jpStackGap`（与八度点/弧共用的那把尺子）：与弧之间要有
          // 「一点点空隙」又不占地方。
          // **不为三连音括线让**：重音、延长记号是音符自己的记号，贴着音符走；
          // 罩住几个音符的括线该让开它们（`addTuplet` 把 notations 算进了高度）。
          layer: 0, rank: Number.MAX_SAFE_INTEGER, kind: "artic", skipKinds: ["tuplet"],
        });
      }
      // layer 1：和弦。用 group 的 y/height（`addHarmony` 之后那正是墨迹口径，见那儿的注释）
      for (const it of this.chordGroups(e))
        items.push({
          key: it,
          x0: e.group.x + it.x, x1: e.group.x + it.x + it.width,
          top: e.group.y + it.y, bottom: e.group.y + it.y + it.height,
          layer: 1, rank: 0, kind: "chord", spread: "chord",
        });
    }
    // 表情/跳转记号**不在这里**：它们的纵向位置是堆叠之后才定的（`placeDirections`
    // 要跟被弧抬过的和弦排齐），这会儿的盒子还是错的。定完之后由 `placeDirections`
    // 自己追加进 `bandBoxes`，房号的车道照样算得到它们。
    // layer 2：转调标记（144 首）。**判避让要用 `TextFrame.bound`**——`y` 是基线，
    // `bound.top` 才是墨迹上缘；`KeySig` 构造里已经调过 `update()`，宽高是准的。
    for (const e of this.entries) {
      if (!(e instanceof KeySig)) continue;
      const tf = e.label;
      items.push({
        key: e.group,
        x0: e.group.x + tf.x, x1: e.group.x + tf.x + tf.width,
        top: e.group.y + tf.y + tf.bound.top, bottom: e.group.y + tf.y + tf.bound.bottom,
        layer: 2, kind: "key",
      });
    }
    return items;
  }

  /**
   * **上方带堆叠**：一次把弧 / 三连音 / fermata / 和弦 / 转调标记的纵向冲突解清。
   *
   * 替代从前的 `liftChordsUnderSlurs` / `liftKeySigOverChords`——那几处各扫各的，
   * 三连音括线压根不在任何一处里（456 首的和弦从括线上穿过去），
   * 弧与括线 x 交错时也只按**端点**避（158 首）。
   *
   * 排在 `addSlur` 之后（要弧的实际位置）、`addEnding` 之前（房号的车道读堆叠结果）。
   */
  stackAbove(opt: LayoutOptions): void {
    const items = this.collectBandItems();
    this.bandBoxes = items;
    if (!items.length) return;
    const dy = stackUpperBand(items, opt.jpStackGap);
    for (const it of items) {
      const d = dy.get(it.key) ?? 0;
      if (d !== 0) (it.key as PageItem).y += d;
      it.top += d;
      it.bottom += d;
    }
  }

  /**
   * **表情/跳转记号的落位**（`rit.` / `Fine` / `D.S.` / `Segno`），排在 `stackAbove` 之后。
   *
   * 口径（用户定的）：与和弦**接近同一行**（跳转记号还要贴着小节线，见 `addDirections`）；
   * **只有真撞上了才让**，让也是先沿 x 让、让不开才抬一层——不按层级无条件往上摞。
   *
   * 之所以留到堆叠之后：它要跟身边的和弦排齐，而「和弦被弧顶起来」是 `stackAbove` 里
   * 才发生的事，在 `addDirections` 里对齐就对到了抬之前的那条线上（064 首差 6.3pt）。
   */
  placeDirections(opt: LayoutOptions): void {
    if (!this.pendingDirs.length) return;
    const size = opt.chordSize > 0 ? opt.chordSize : opt.numberSize * 0.6;
    const chords = this.chordBoxes();
    for (const { grp, anchorX, fallbackY, barLeft } of this.pendingDirs) {
      if (!chords.length) {
        grp.y += fallbackY; // 本行一个和弦都没有：退回音符上方那一带
        continue;
      }
      // 基线取**离它最近的那个和弦**，不是本行第一个：同一行的和弦并不总是等高
      //（八度点、被弧抬过的那些差半个字号），照第一个摆就与身边的错开。
      const near = chords.reduce((m, c) =>
        Math.abs((c.x0 + c.x1) / 2 - anchorX) < Math.abs((m.x0 + m.x1) / 2 - anchorX) ? c : m, chords[0]);
      const baseY = near.base;
      grp.y += baseY;
      // 撞没撞上**按墨迹盒判**，别按「基线差多少」——高低差半个字号的和弦照样压得着。
      const top = baseY - size * 0.85, bot = baseY + size * 0.25;
      // 底下那一层（弧、三连音括线）也得算：470《出到营外》的 `mf` 就压在三连音括线上。
      const low = this.bandBoxes.filter((b) => b.layer === 0);
      const hits = (x0: number): boolean =>
        chords.some((c) => c.base - size * 0.85 < bot && c.base + size * 0.25 > top
          && c.x1 > x0 - size * 0.35 && c.x0 < x0 + grp.width + size * 0.35)
        || low.some((b) => b.top < bot && b.bottom > top
          && b.x1 > x0 - size * 0.35 && b.x0 < x0 + grp.width + size * 0.35);
      if (!hits(grp.x)) continue;
      // 沿 x 让：挪到压着它的那些和弦的左边（`D.C. al Coda` 那种长记号在密和弦的
      // 小节里常常让不开，036《这是天父世界》就是）。
      // **挡路的要按 `hits` 那把尺子筛**（含那道净空容差）：照「严格重叠」筛的话，
      // 差 0.3pt 挨着的和弦一个都选不中，`left` 成了 Infinity，于是明明往左让一让就行，
      // 却直接抬到了上面一层（344《万古磐石为我开》的 `Fine`）。
      const left = chords
        .filter((c) => c.base - size * 0.85 < bot && c.base + size * 0.25 > top
          && c.x1 > grp.x - size * 0.35 && c.x0 < grp.x + grp.width + size * 0.35)
        .reduce((m, c) => Math.min(m, c.x0), Infinity);
      // **让位不许越过左边那条小节线**：`D.S.` / `Fine` 标的是**这一小节**唱到哪儿为止，
      // 挪到上一小节去就换了意思（344《万古磐石为我开》的 `Fine` 曾这么跑到前一小节）。
      const alt = left - grp.width - size * 0.3;
      if (Number.isFinite(alt) && alt >= barLeft && alt >= 0 && !hits(alt)) {
        grp.x = alt;
        continue;
      }
      // 本小节里让不开：抬到**它那一段 x 上真正的最高墨迹**之上一格（弧、三连音括线…），
      // 不是固定抬一个字号——179《我主耶稣是生命源》的 `f` 底下就一条弧，
      // 照固定量抬完离弧 8pt，空落落地飘在那儿。下面什么都没有才退回固定量。
      let lowTop = Infinity;
      for (const b of this.bandBoxes) {
        if (b.layer !== 0) continue;
        if (b.x1 <= grp.x || b.x0 >= grp.x + grp.width) continue;
        lowTop = Math.min(lowTop, b.topAt ? b.topAt(grp.x, grp.x + grp.width) : b.top);
      }
      // 和弦也在这一带（本来就是为了让开它才抬的），一并算进去——只让开弧的话
      // 正好落进和弦的墨迹里（064《啊！圣善夜》、470《出到营外》各两处）
      for (const c of chords) {
        if (c.x1 <= grp.x || c.x0 >= grp.x + grp.width) continue;
        // 和弦盒的顶是**字体 ascent**（纯文本那档 `inkBound` 是关的），比真墨迹高一截；
        // 照它让位，记号就比和弦高出一大块（064《啊！圣善夜》的 Segno）。按墨迹顶算。
        // 墨迹顶 = 基线 − 0.85 个字号（与 line-check 判压那把尺子同口径）
        lowTop = Math.min(lowTop, c.base - size * 0.85);
      }
      grp.y = Number.isFinite(lowTop) ? lowTop - opt.jpStackGap - grp.height : grp.y - size * 1.2;
    }
    // 记号定完了才进 `bandBoxes`——房号的车道要算上它们（`addEnding` 排在后面）
    for (const { grp } of this.pendingDirs)
      this.bandBoxes.push({
        key: grp, x0: grp.x, x1: grp.x + grp.width,
        top: grp.y, bottom: grp.y + grp.height, layer: 1, kind: "chord",
      });
  }

  /** 本行没有和弦时段落词的收尾：被弧或三连音括线压住就抬到它之上一格。
   *  有和弦时它的基线跟着和弦走（`sectionWordBaseY`，堆叠已经把和弦抬过了）。 */
  liftSectionWordsUnderSlurs(opt: LayoutOptions): void {
    const low = this.bandBoxes.filter((b) => b.layer === 0);
    if (!low.length) return;
    for (const tf of this.group.children) {
      if (!(tf instanceof TextFrame) || !tf.classes.has("section-word")) continue;
      const x0 = tf.x, x1 = tf.x + tf.width;
      const y0 = tf.y + tf.bound.top, y1 = tf.y + tf.bound.bottom;
      let dy = 0;
      for (const s of low) {
        if (s.x1 <= x0 || s.x0 >= x1) continue;
        if (s.top >= y1 || s.bottom <= y0) continue;
        dy = Math.min(dy, s.top - opt.jpStackGap - y1);
      }
      tf.y += dy;
    }
  }

  private doLineBreak(width: number): Line[] {
    const res: Line[] = [];
    let idx = 0;
    while (idx < this.entries.length) {
      let last = idx;
      const grp = this.entries[idx].group;
      // 组原点已经归到音符内容的左缘（`normalizeEntryX`），和弦不掺在里头
      const l = grp.x;
      while (last < this.entries.length) {
        const lastGrp = this.entries[last].group;
        if (this.entries[last] instanceof LineBreak) {
          last++;
          break;
        }
        const r = lastGrp.x + entryBounds(lastGrp).right;
        // 每行**至少收一个**：单个条目就比版心宽时（窄纸配大字号、超长的歌词音节），
        // 不收它 idx 就永远不前进，这里会无限推空行（耶稣普治 文本谱 4:3 44pt 曾卡死）。
        // 超宽的那个独占一行，之后照常由 adjust 压缩。
        if (r - l < width || last === idx) {
          last++;
          continue;
        }
        break;
      }
      const line = new Line();
      for (let i = idx; i < last; i++) line.addEntry(this.entries[i]);
      res.push(line);
      idx = last;
    }
    // 只剩小节线（连一个音符都没有）的行**并回上一行**：谱尾的终止线常被宽度判据挤到
    // 下一行去，单独占掉一整行——那是永远不该出现的排法（024《贺祂为王》）。
    // 并回去会让上一行稍稍超出版心，但小节线本来就窄，justify 收得回来。
    for (let i = res.length - 1; i > 0; i--) {
      if (res[i].entries.some((e) => e instanceof NoteEntry)) continue;
      for (const e of res[i].entries) res[i - 1].addEntry(e);
      res.splice(i, 1);
    }
    return res;
  }

  private updateXPos(l: Line, width: number, opt: LayoutOptions): void {
    const first = l.entries[0];
    const dx = first.group.x;
    for (const e of l.entries) e.group.x -= dx;
    const last = l.entries[l.entries.length - 1];
    if (last.group.width < 0) throw new Error("");
    // 段落词的撑开要在 **justify 之前、分行之后**：分行前撑的是错的锚点（段落词落到行末时
    // 会被挪到下一行行首去，见 layout() 里那段），而 justify 只会往空档里**加**距离、不会收窄，
    // 所以这里放得下，justify 之后也放得下。
    // 行首那一条段落词要挂到音符**左边**，得先给它腾出地方：整行**左缩进**一截，
    // 排版按缩进后的宽度做，排完整行右移回来（见 sectionWordIndent）。
    const indent = l.sectionWordIndent(opt, width);
    l.sectionIndent = indent;
    l.spreadForSectionWords(opt, width - indent);
    l.spreadForBarEndMarks(opt, width - indent);
    l.adjust(width - indent, opt.maxHorizontalScale);
    if (indent > 0) for (const e of l.entries) e.group.x += indent;
  }

  /**
   * 行首那一条段落词要占的**左缩进**。
   *
   * 段落词挂在行首音符上时，左边一点地方都没有——那个音符自己就贴着版心左缘
   * （「一个字都不许出版心」是定死的口径，见 `sectionWordHangLeft`）。于是它只能就地
   * 摆或往右让，右让就得撑开小节，音符与小节线之间豁开一道口子
   * （173/175/189/193 的「（副歌）」）。
   *
   * 这里换个办法：**整行往右缩进半个段落词**，谱面按 `width − indent` 排、排完整体右移，
   * 段落词就能跨在行首音符上方——左括号落到音符左边，右半边压在音符上，两头各让半个词，
   * 音符与小节线之间也不用再豁开一道口子。整个词躲到音符左边是不必要的，那样缩进太深。
   * 段号（行首的「1.」「2.」）挂的是行首音符的绝对坐标（`addVerseNumbers`），跟着一起走。
   *
   * 只在**行本身还有富余**时这么做（缩进吃掉的是 justify 本来要摊掉的空白）；
   * 富余不够就返回 0，退回原来的「撑开小节」那条路。
   */
  sectionWordIndent(opt: LayoutOptions, width: number): number {
    if (!width) return 0;
    const e = this.entries[0];
    if (!(e instanceof NoteEntry)) return 0;
    let need = 0;
    if (opt.sectionWordSize > 0 && this.sectionWordOf(e)) {
      const font = opt.lrcFont.makeWithSize(opt.sectionWordSize);
      const w = sectionWordRun(font, this.sectionWordOf(e)!, opt.punctCompress).width;
      // **就地摆得下就别折腾**：判据是「从锚点起排要压掉右边的和弦多少」——025 的
      // 「副歌」两个字后面老远才有和弦，直接排在音符上方就是了。压得不多（不到一道净空）
      // 也不缩进：那点量在 justify 之后由 `nudgeForSectionWords` 从行内匀掉就行，
      // 整行缩进反而把音符推走一大截（101 只差 1.4pt 却缩进了 10pt）。
      // 量按 **justify 之后**的间距算：justify 之前行是紧的，照它判会把一大批本来
      // 放得下的也拖进来。
      const over = this.probeJustified(width, opt, () => this.sectionWordOverlap(e, w, opt));
      if (over <= opt.sectionWordSize * 0.6) return 0;
      // 要的地方**正好是「词的左半边探出音符墨迹的那一截」**：缩进这么多之后，词的左端
      // 贴着版心左缘、中心对着锚点音符。多要一点（比如再搭个和弦净空）词就整个往右挪，
      // 左边白空一截（189 曾在版心左缘与「（副歌）」之间空出 15pt）。
      // 对齐的是**音符墨迹的中心**而不是它的左缘——按左缘算，音符连着底下的歌词
      // 整体偏右半个数字，看着就不居中（193）。
      const it = e.entryItem();
      need = w / 2 - (it ? it.x + it.width / 2 : 0);
      // 锚点音符**自己头上就有和弦**时词跨不上去，那种情形由 `placeSectionWord` 让到
      // 和弦右边（原书的 `G（副歌）`），缩进帮不上忙。
      if (this.chordGroups(e).length) return 0;
    }
    need = Math.max(need, this.verseNumberIndent(opt, e));
    if (need <= 0) return 0;
    let right = 0;
    for (const ent of this.entries) right = Math.max(right, ent.group.x + ent.group.childrenBound.right);
    return need <= width - right ? need : 0;
  }

  /** 锚点音符**自己头上**那个和弦的右缘（行坐标）。没有和弦就返回 undefined。 */
  private ownChordRight(e: NoteEntry): number | undefined {
    let right: number | undefined;
    for (const it of this.chordGroups(e)) right = Math.max(right ?? -Infinity, e.group.x + it.x + it.width);
    return right;
  }

  /** 段落词**就地从锚点起排**要压掉右边和弦多少（含净空；不压就是 0）。 */
  private sectionWordOverlap(e: NoteEntry, width: number, opt: LayoutOptions): number {
    const size = opt.sectionWordSize;
    const gap = size * 0.6;
    const chords = this.chordBoxes();
    const anchorX = e.group.x + (e.entryItem()?.x ?? 0);
    const baseY = this.sectionWordBaseY(e, opt, chords);
    let over = 0;
    for (const c of chords) {
      if (Math.abs(c.y - baseY) >= size * 1.5 || c.x1 <= anchorX) continue;
      if (c.x0 < anchorX + width + gap) over = Math.max(over, anchorX + width + gap - c.x0);
    }
    return over;
  }

  /**
   * 行首歌词的段号（「1.」「2.」…）要占的左缩进。
   *
   * 段号是**悬在首字左边**的（`addVerseNumbers` 拿行首音符的绝对坐标减去段号宽），
   * 行首音符贴着版心左缘时它就整个挂到版心外面去了。这里按「最宽的那个段号减去首字
   * 在音符里的偏移」要地方，谱面整行右移这么多，段号就落回版心内。
   */
  private verseNumberIndent(opt: LayoutOptions, e: NoteEntry): number {
    if (opt.lyricStack <= 0 || opt.verseNumbers === "never" || e.lrcs.length < 2) return 0;
    if (opt.verseNumbers === "auto") {
      let verses = 0;
      for (const ent of this.entries) if (ent instanceof NoteEntry) verses = Math.max(verses, ent.lrcs.length);
      if (verses <= opt.verseNumberAutoMin) return 0;
    }
    let need = 0;
    for (let k = 0; k < e.lrcs.length; k++) {
      const li = e.lrcs[k];
      if (!li.text) continue;
      need = Math.max(need, opt.lrcFont.measureText(`${k + 1}.`) - li.x);
    }
    return Math.max(0, need);
  }

  /**
   * 谱行进页。码放交给公共分页器（`jianpu/vertical.ts::paginate`，文本谱也走它），
   * 这里只报每条谱行的占位盒（`l.group` 的包围盒，`update` 后原点就在左上角）与强制分页。
   *
   * **一张连续长纸**（`continuousPage`，「原样」档走这条）：不分页、不为了撑满纸张
   * 摊开行距，各行首尾相接、间距恒为 `maxLineDist`。纸有多高由内容说了算
   * （`ScorePainter.pageSize` 按这一页的实际高度报），观感与文本谱的「原版」一致。
   *
   * 分页时首页要给标题块让出 `firstPageHeadroom`（「原样」档分页那一路，见 LayoutOptions.bookHead）：
   * 首页能放的行少一些，且各行整体下移。放不满的一页行距摊到 `maxLineDist` 为止，剩下的空白
   * **整块居中**——**首页有标题块时不居中**：谱面要贴着标题排，居中会把第一条谱行连同整块一起
   * 往下推，标题与音符之间平白多出一大片空。
   */
  private layoutVertically(lines: Line[], opt: LayoutOptions, height: number): Group[] {
    const top = opt.marginTop;
    const continuous = opt.continuousPage;
    const blocks = lines.map((l, i) => {
      l.group.update();
      l.group.classes.add("system"); // 页面检查按它量相邻谱行的墨迹盒
      // 上一行以「另起一页」的换行符收尾（`.Layout` 的强制分页、展开档逐遍换页）
      const prev = lines[i - 1]?.entries[lines[i - 1]!.entries.length - 1];
      const breakBefore = !continuous && prev instanceof LineBreak && prev.newPage;
      return { line: l, top: 0, bottom: l.group.height, breakBefore };
    });
    const headroom = (pageIdx: number): number => (pageIdx === 0 ? opt.firstPageHeadroom : 0);
    const pages = paginate(
      blocks,
      continuous
        ? { pageTop: () => top, bottom: Infinity, gap: opt.maxLineDist }
        : {
            pageTop: (i) => top + headroom(i),
            bottom: top + height,
            gap: opt.staffDist,
            spread: { maxGap: opt.maxLineDist, center: (i) => headroom(i) === 0 },
          },
    );
    if (continuous && pages.length === 0) return [new Group()];
    return pages.map((pg) => {
      const grp = new Group();
      for (const { block, y } of pg) {
        grp.add(block.line.group);
        block.line.group.y = y;
      }
      grp.update();
      return grp;
    });
  }

  /** 一条弧罩住几个音符（含两端）。按**和弦**数，长音的增时线不另算。 */
  private slurNoteCount(ena: NoteEntry, enb: NoteEntry): number {
    const i0 = this.entries.indexOf(ena);
    const i1 = this.entries.indexOf(enb);
    if (i0 < 0 || i1 < 0) return 0;
    const seen = new Set<JChord>();
    for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) {
      const e = this.entries[i];
      if (e instanceof NoteEntry) seen.add(e.chord);
    }
    return seen.size;
  }

  private addSlurTie(a: JNote, b: JNote, ypos: number): void {
    const ena = this.chordEntry.get(a.chord);
    const enb = this.chordEntry.get(b.chord);
    // 两端都得在**本行**里才画得出来。调用点查的是 `chord`，这里查的是 `note.chord`——
    // 两者在多声部/并音的谱里可以不是同一个和弦，查不到就只能不画（不是每一行都有两端）。
    if (!ena || !enb) {
      console.error("slur/tie 有一端不在本行，跳过");
      return;
    }
    const grp = new Tie();
    let pl = new Point(ena.cx, ypos);
    let pr = new Point(enb.cx, ypos);
    const dx = ena.number!.font.size / 14;
    if (a.tiePrev !== null || a.tupletEnd) pl = pl.offset(dx, 0);
    if (b.tieNext !== null) pr = pr.offset(-dx, 0);
    pr = pr.offset(enb.group.x - ena.group.x, 0);
    // **覆盖的音符个数**：跨度那条阈值是物理宽度，音符密的谱行上够不着——91《我灵镇静》
    // 那几条罩着五六个十六分音符的弧，跨度还不到 4 个音符步距，照旧画成了高高的月牙。
    // 数的是**和弦个数**（长音的增时线各占一个 NoteEntry，不能按 entry 数）。
    const notes = this.slurNoteCount(ena, enb);
    const flatByNotes = this.slurFlatNotes > 0 && notes >= this.slurFlatNotes;
    grp.init(pl, pr, flatByNotes ? { ...this.slurStyle, forceFlat: true } : this.slurStyle);
    grp.x += ena.group.x;
    grp.normalizeX();
    grp.normalizeY();
    this.group.add(grp);
    this.slurTies.push(grp);
  }

  /**
   * Stop barlines short of any slur/tie arching over them.
   *
   * Barlines now reach a full 1.0em above the baseline (musicpp's staff top),
   * which is *higher* than where an arc with no octave dots starts — so a tie
   * spanning a barline (last note of a bar tied into the next, the common case)
   * would be pierced from above. Neither musicpp nor the Kotlin original does
   * anything here; musicpp only gets away with it because its arcs are lifted
   * clear whenever there are octave dots.
   *
   * Uses the arc's whole bounding box bottom rather than solving the Bézier at
   * the barline's x: conservative, never intersects, and the barline loses at
   * most a hair more height than strictly necessary.
   */
  private clipBarlinesUnderSlurs(opt: LayoutOptions): void {
    if (this.slurTies.length === 0) return;
    const gap = opt.jpStackGap / 2;
    for (const e of this.entries) {
      if (!(e instanceof Barline)) continue;
      const x0 = e.group.x;
      const x1 = x0 + e.group.width;
      let top = e.group.y;
      for (const s of this.slurTies) {
        if (s.x + s.width < x0 || s.x > x1) continue;
        top = Math.max(top, s.y + s.height + gap);
      }
      e.clipTop(top);
    }
  }

  private addTie(opt: LayoutOptions): void {
    this.slurStyle = slurStyleOf(opt);
    this.slurFlatNotes = opt.slurFlatNotes;
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const nt = e.chord.notes[0];
      if (!nt.tieStart) continue;
      const ent = this.chordEntry.get(nt.chord);
      if (!ent) {
        console.error("no entry for tied");
        continue;
      }
      const endCh = nt.tieNext?.chord;
      const endEntry = endCh ? this.chordEntry.get(endCh) : undefined;
      if (!endEntry) continue;
      const ypos = Math.min(this.tiedTop(e, opt, true), this.tiedTop(endEntry, opt, false));
      this.addSlurTie(nt, nt.tieNext!, ypos);
    }
  }
  // tiedTop/slurTop sit on the octave-dot ladder (NoteEntry.slurRung), plus one
  // more rung per element that has to pass underneath.
  private tiedTop(ent: NoteEntry, opt: LayoutOptions, left: boolean): number {
    const res = ent.slurRung(opt);
    const nt = ent.chord.notes[0];
    // **旧式档（PPT）不在这里为三连音让位**：括线与弧同属上方带 layer 0，谁在下面
    // 由跨度定（`Line.stackAbove`）。这里再预先抬半个 em，就抬了两回——158《一件礼物》
    // 第二个三连音底下那条弧因此离基线 41pt（该是 27pt），括线跟着又被顶高一截
    //（用户口径：「三连音在 slur 之上，不应该抬高 slur」）。
    // 新式栅格照旧（成书那条路的观感不动）。
    if (opt.jpGridLegacy) return res;
    const rung = opt.jpDotRung;
    if (left && nt.tupletBegin) return res - rung;
    if (!left && nt.tupletEnd) return res - rung;
    return res;
  }
  private slurTop(ent: NoteEntry, opt: LayoutOptions, left: boolean): number {
    let res = ent.slurRung(opt);
    const nt = ent.chord.notes[0];
    const rung = opt.jpGridLegacy ? opt.numberSize / 8 : opt.jpDotRung;
    if (left) {
      if (nt.tieStart) res -= rung;
    } else {
      if (nt.tieEnd) res -= rung;
    }
    // 三连音括线不在这里避了（**两个栅格都是**）：它与弧同属上方带 layer 0，
    // 谁在下面由跨度定（范围小的在下），见 Line.stackAbove。旧式档从前在这里
    // 先退半个 em，与堆叠叠加就抬了两回，见 tiedTop 那儿的注释。
    return res;
  }
  private addSlur(opt: LayoutOptions): void {
    this.slurStyle = slurStyleOf(opt);
    this.slurFlatNotes = opt.slurFlatNotes;
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const nt = e.chord.notes[0];
      if (!e.chord.slurStart) continue;
      const endCh = e.chord.slurEndChord;
      const endEntry = endCh ? this.chordEntry.get(endCh) : undefined;
      if (!endEntry) continue;
      const ypos = Math.min(this.slurTop(e, opt, true), this.slurTop(endEntry, opt, false));
      const nb = endCh!.notes[0];
      this.addSlurTie(nt, nb, ypos);
    }
  }

  /** 断行之后每一行首个音符的和弦 id（`JChord.id` = `ScoreDoc` 元素 id）。五线谱自动铺排拿它当优选断点
   *  （`App.jianpuLineStarts`）；展开档一个和弦每遍出现一次，用的人自己去重。 */
  lineStarts: number[] = [];

  layout(width: number, height: number, opt: LayoutOptions): Group[] {
    this.lyricGap = opt.lyricGap;
    this.dropDoubledBarlines(opt);
    this.calcXPos();
    const lines = this.doLineBreak(width);
    this.lineStarts = lines.flatMap((l) => {
      const e = l.entries.find((x): x is NoteEntry => x instanceof NoteEntry && x.chord.id !== null);
      return e?.chord.id != null ? [e.chord.id] : [];
    });
    // 段落词挂在**行末那个音符**上时，它标的其实是下一行的起句（「（副歌）」印在主歌
    // 最后一行的行尾没有意义，副歌是从下一行开始唱的）——挪到下一行行首那个音符上。
    // 锚点是按「第几个音符」记的，重排后的断行与原书不同，落到行末是常事（013 首）。
    // 挪动记在各行共用的 `sectionWords` 上，不改输入（同一个和弦在别的遍、别的行里看到的也是挪过的）；
    // 符杠分组同样是整条装载时定的，各行共用。
    for (const l of lines) {
      l.sectionWords = this.sectionWords;
      l.beamGroups = this.beamGroups;
    }
    for (let i = 0; i + 1 < lines.length; i++) {
      const notes = lines[i].entries.filter((e): e is NoteEntry => e instanceof NoteEntry);
      const last = notes[notes.length - 1];
      if (!last || !this.sectionWordOf(last)) continue;
      const next = lines[i + 1].entries.find((e): e is NoteEntry => e instanceof NoteEntry);
      if (!next || this.sectionWordOf(next)) continue;
      this.sectionWords.set(next.chord, this.sectionWordOf(last));
      this.sectionWords.set(last.chord, null);
    }
    for (const l of lines) {
      this.updateXPos(l, width, opt);
      // 段落词要的那点地方**必须在画符杠/连音线/弧线之前**匀出来：那些东西的坐标
      // 是照音符位置算死的，之后再挪音符，减时线就跟音符错开了。
      l.nudgeForSectionWords(opt, width);
      l.addBeams(opt);
      l.addTuplet(opt);
      l.addTie(opt);
      l.addSlur(opt);
      l.spreadChordsHorizontally(opt, width);
      l.addDirections(opt, width);
      // 上方带堆叠要排在 addSlur 之后（要弧的实际位置）、addEnding 之前
      //（房号的车道读堆叠结果）。见 Line.stackAbove。
      l.stackAbove(opt);
      l.placeDirections(opt);
      l.addEnding(opt);
      l.addSectionWords(opt, width);
      l.liftSectionWordsUnderSlurs(opt);
      l.clipBarlinesUnderSlurs(opt);
      l.updateLyricY(opt);
      l.group.normalizeY();
      l.group.update();
      l.addVerseNumbers(opt);
    }
    return this.layoutVertically(lines, opt, height);
  }

  private getEntry(ch: JChord): NoteEntry | null {
    return this.chordEntry.get(ch) ?? null;
  }

  addTuplet(opt: LayoutOptions): void {
    const tuplets = new Set<NonNullable<JNote["tuplet"]>>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const t = e.chord.notes[0].tuplet;
      if (!t) continue;
      tuplets.add(t);
    }
    const numberSize = opt.numberFont.size;
    for (const t of tuplets) {
      // 两端都得在**本行**里才画得出来：窄纸配大字号时断行可能落在三连音中间，
      // 首尾分到两行（番茄语法覆盖 展开 16:9 44pt）。同 addSlurTie：只能不画这一个括线。
      const start = this.getEntry(t.first.chord);
      const end = this.getEntry(t.last.chord);
      if (!start || !end) {
        console.error("三连音有一端不在本行，跳过");
        continue;
      }
      const leftItem = start.entryItem() as JpNumber | null;
      const rightItem = end.entryItem() as JpNumber | null;
      // 三连音的两端得都有可画的音符项（休止/拖腔起头的那一端没有 JpNumber）
      if (!leftItem || !rightItem) {
        console.error("三连音有一端没有音符项，跳过");
        continue;
      }
      const left = leftItem.pos(this.group).x + leftItem.cx;
      let right = rightItem.pos(this.group).x + rightItem.cx;
      if (end.beginOfSlurTied) right -= opt.numberSize / 14;
      const width = right - left;
      // 括线与音符之间要留一道空（原来紧贴着音符墨迹顶，看着像长在数字上）
      // **跨度里所有音符都得让开**，不只两端：470《出到营外》那组三连音中间那个音符
      // 带临时升号，只看两端的话括线正好压在升号上。临时记号挂在 entry 组里
      //（`addAccidental`），八度点已经算在 `entryTop` 里了；和弦不算（它在括线**之上**）。
      const i0 = this.entries.indexOf(start), i1 = this.entries.indexOf(end);
      let inkTop = Math.min(start.entryTop(opt), end.entryTop(opt));
      if (i0 >= 0 && i1 >= 0) {
        for (let k = Math.min(i0, i1); k <= Math.max(i0, i1); k++) {
          const en = this.entries[k];
          if (!(en instanceof NoteEntry)) continue;
          inkTop = Math.min(inkTop, en.entryTop(opt));
          // 音符自己的记号（fermata / 重音）也要让开——它们贴着音符，括线在外层
          for (const nt of en.notations)
            inkTop = Math.min(inkTop, nt.y - (en.number?.y ?? 0) + nt.bound.top);
          const acc = en.accidental;
          if (acc && en.number) {
            // **换算到「相对基线」那套坐标**：`entryTop` 给的是相对基线的偏移，而条目组
            // 经 `update()` 归一化之后，子级的 `y` 是相对组原点（左上角）算的——
            // 基线在组里的位置正是主数字的 `y`。缩放也要算（`addAccidental` 缩到 0.8）。
            const sc = Math.abs(acc.matrix.scaleY) || 1;
            inkTop = Math.min(inkTop, acc.y - en.number.y + acc.bound.top * sc);
          }
        }
      }
      const ypos = inkTop - opt.jpStackGap;
      // 竖脚比房号的短：房号线是整段乐句的括线，三连音只是三个音的括号
      //（原书量到的 bracketFootLen 5.3pt 主要来自房号；三连音照它画会高出一截）。
      const y = -(opt.bracketFoot > 0 ? opt.bracketFoot * 0.55 : numberSize * 0.25);
      const tupGrp = new Group();
      tupGrp.x = left;
      tupGrp.y = ypos;
      const path = new GraphicPath();
      path.classes.add("tuplet-line"); // line-check 的 V12 靠它认（见 browser.ts::CLS_TAGS）
      // 线宽与「脚」长与房号括线同源（原书量的 bracket 那一类）
      path.strokeWidth = opt.bracketWidth > 0 ? opt.bracketWidth : 1;
      path.fill = false;
      path.stroke = true;
      path.strokeColor = opt.color;
      const txt = new SmuflText(opt);
      txt.color = opt.color;
      txt.text = GlyphCodes.tuplet3;
      // 数字要**按墨迹**与横线上下、左右都居中。这里自己拿 SMuFL 元数据算，
      // **不走 SmuflText.bound**：那个 bound 是从元数据直接换算的，y 轴还是 SMuFL 的
      // 「上为正」，与页面坐标反号（top/bottom 也因此对调）。拿它算墨迹中心会把数字
      // 往上推整整一倍墨迹高的一半（看着就是“飘在括线上方”）。
      // 按字号估偏移（0.28em 那种）同样不准——Bravura 的 tuplet 字形墨迹只占 em 的一小截。
      const box = opt.smuflMeta.getBBox(GlyphCodes.tuplet3);
      if (!box) throw new Error("no smufl bbox: tuplet3");
      const sp = txt.font.size / 4; // SMuFL：字号 = 4 个 staff space
      const inkCx = ((box.bBoxSW[0] + box.bBoxNE[0]) / 2) * sp;
      const inkCy = -((box.bBoxSW[1] + box.bBoxNE[1]) / 2) * sp; // 页面坐标上为负
      const inkHalfW = ((box.bBoxNE[0] - box.bBoxSW[0]) / 2) * sp;
      txt.x = width / 2 - inkCx;
      txt.y = y - inkCy;
      // 缺口按数字的**墨迹宽**开（原先写死的 numberSize/3 与字形无关，
      // 书级重排那一路的小字号下会宽出一大截空），两边各留一道约 0.15em 的气。
      const halfGap = inkHalfW + txt.font.size * 0.15;
      const inkHalfH = ((box.bBoxNE[1] - box.bBoxSW[1]) / 2) * sp;
      // 线那一截的顶（相对 tupGrp，负 = 上方）：括线是横线那条，两段弧是弧顶
      let lineTop = y - path.strokeWidth / 2;
      let numY = y; // 数字墨迹中心落的高度
      if (opt.tupletStyle === "arc") {
        // **两段弧**：同页 slur 那条月牙从中间挖掉数字那一截（`SlurStyle.gap`），
        // 两端照样收尖、断口处是弧中段的厚度；弧高、厚度、描边全随 `slurStyleOf`。
        const arc = new Slur();
        arc.init(new Point(0, 0), new Point(width, 0), {
          ...slurStyleOf(opt),
          gap: { x0: width / 2 - halfGap, x1: width / 2 + halfGap },
        });
        arc.update();
        arc.classes.add("tuplet-arc");
        tupGrp.add(arc);
        lineTop = arc.y;
        // 数字骑在弧顶那条线上（弧在断口处已接近顶点，取包围盒顶再往下半个厚度）
        numY = arc.y + opt.slurTieThickness / 4;
        txt.y = numY - inkCy;
      } else {
        path.moveTo(0, 0);
        path.lineTo(0, y);
        path.lineTo(width / 2 - halfGap, y);
        path.moveTo(width, 0);
        path.lineTo(width, y);
        path.lineTo(width / 2 + halfGap, y);
        tupGrp.add(path);
      }
      tupGrp.add(txt);
      this.group.add(tupGrp);
      // 墨迹盒现画现记（见 `Line.tupletBoxes`）：横线在 `y`（负 = 上方），竖脚落到 0，
      // 数字骑在横线上、上下各半个墨迹高。
      tupGrp.classes.add("tuplet");
      // 盒子分两截记：**横线**那一截只有线宽，**数字**骑在横线中间、上下各半个墨迹高。
      // 上头的和弦按「它那一段 x 上括线到底多高」让位（`topAt`），照整体盒顶让的话，
      // 括线两头的和弦也要为中间那个数字多抬三四个点（456《常常喜乐》）。
      this.tupletBoxes.push({
        key: tupGrp,
        x0: left,
        x1: left + width,
        top: ypos + lineTop,
        bottom: ypos,
        numX0: left + width / 2 - halfGap,
        numX1: left + width / 2 + halfGap,
        numTop: ypos + numY - inkHalfH,
      });
    }
  }

  /**
   * 房号（volta / ending）：`⌐1.` 那条横线 + 左端下垂 + 房号数字，画在音符上方。
   * 与五线谱同一套画法；行内画不完的房（跨行、或 `discontinue`）右端不封口。
   * 房的范围来自 `Measure.endingLeft/endingRight`，按**本行内**出现的那一段画。
   *
   * 高度与端点都照**文本谱那一路**的口径（`layout/original/place.ts`，那边是按印刷原版做的）：
   *   - 横线走一条**全行统一的车道**，不按各房各自区间的墨迹顶算。原版里一房二房的横线
   *     是同一条高度（169 首曾因一房上方有和弦、二房没有而错开）；要让开下方内容时
   *     也是整行一起抬。
   *   - 端点**贴着两侧的小节线**，不贴房内首末音符。相邻两房之间隔着一条小节线的宽度，
   *     天然分得开（158 首的一房二房曾按音符各向外扩 0.35em、顶在一起）。
   */
  addEnding(opt: LayoutOptions): void {
    if (opt.endingSize <= 0) return;
    // 先把本行按小节切开（房的起止是**小节级**的）
    const segs: { m: JMeasure; notes: NoteEntry[] }[] = [];
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const m = e.chord.measure;
      const last = segs[segs.length - 1];
      if (last && last.m === m) last.notes.push(e);
      else segs.push({ m, notes: [e] });
    }
    // 本行的小节线**墨迹**左右缘（端点要贴着它们，见 Barline.inkLeft/inkRight）
    const barInk = this.entries
      .filter((e): e is Barline => e instanceof Barline)
      .map((b) => ({ left: b.group.x + b.inkLeft, right: b.group.x + b.inkRight }))
      .sort((a, b) => a.left - b.left);
    const spans: { num: string; notes: NoteEntry[]; closed: boolean; x0: number; x1: number }[] = [];
    let num: string | null = null;
    let notes: NoteEntry[] = [];
    const flush = (closed: boolean) => {
      if (num !== null && notes.length) {
        const sp = this.endingSpan(opt, num, notes, closed, barInk);
        if (sp) spans.push(sp);
      }
      num = null;
      notes = [];
    };
    for (const seg of segs) {
      if (seg.m.endingLeft) {
        flush(false);
        // 有原文就照原文画（MusicXML `<ending>` 的元素文本），否则按房号集合拼「1.2.3.」。
        num = seg.m.endingText
          ?? (seg.m.endingNum && seg.m.endingNum.size ? [...seg.m.endingNum].sort((a, b) => a - b).join(".") + "." : "");
      }
      if (num === null) continue;
      notes.push(...seg.notes);
      // 房号线到**第一个** `<ending type=…>` 就收：`stop` 封口、`discontinue` 敞着。
      // 二房常写成「start + discontinue 在同一小节，逻辑上的 stop 在几小节之后」
      //（037《我尊崇祢》的二房 m9 就地 discontinue、m11 才 stop），
      // 线要在 m9 收住——跨过好几个小节的长横线是错的。
      if (seg.m.endingRight !== null) flush(seg.m.endingRight === StartStopDiscontinue.STOP);
    }
    flush(false); // 房跨到下一行：本行这一段不封口
    if (!spans.length) return;
    // **全行共用一个高度**：各房区间内所有已画对象的最高墨迹，取所有房里最高的那个。
    // 逐房各算就会错开（一房上方有和弦、二房没有）。
    //
    // 高度一律按**墨迹**算。从前这里扫 `this.group.children` 取 `pos().y`，那是组原点/基线
    // 而不是墨迹上缘，且**和弦挂在音符组的子级上、压根扫不到**——158 首的房号数字因此
    // 骑在和弦 `C`/`F` 上。现在读上方带堆叠的结果（`bandBoxes`，弧/三连音/和弦/转调都在里头），
    // 音符自身的墨迹顶另算。
    let above = Infinity;
    for (const sp of spans) {
      for (const e of sp.notes) {
        const p = e.group.pos(this.group);
        above = Math.min(above, p.y + Math.min(0, e.group.childrenBound.top));
      }
      // 区间**左边多看一个字号**：房号的竖脚与数字画在横线左端**外侧**，
      // 紧挨着房区间左边的那个和弦照样会被它压上（396《我要向高山举目》的 `G7`）。
      const t = bandTop(this.bandBoxes, sp.x0 - opt.endingSize, sp.x1);
      if (t !== null) above = Math.min(above, t);
    }
    if (!Number.isFinite(above)) return;
    const drop = opt.bracketFoot > 0 ? opt.bracketFoot : opt.endingSize * 0.9;
    const top = above - opt.endingSize * 0.5 - drop;
    for (const sp of spans) this.drawEnding(opt, sp, top, drop);
  }

  /** 一段房的横向范围。端点贴**小节线**（找不到才退回按首末音符外扩）。 */
  private endingSpan(
    opt: LayoutOptions, num: string, notes: NoteEntry[], closed: boolean,
    barInk: { left: number; right: number }[],
  ): { num: string; notes: NoteEntry[]; closed: boolean; x0: number; x1: number } | null {
    const leftItem = notes[0].entryItem();
    const rightItem = notes[notes.length - 1].entryItem();
    if (!leftItem || !rightItem) return null;
    const noteL = leftItem.pos(this.group).x;
    const noteR = rightItem.pos(this.group).x + rightItem.width;
    // 贴小节线：起点取房内首音**之前**最近的那条，终点取末音**之后**最近的那条，各让一点气。
    // 相邻两房之间因此隔着一条小节线的宽度，不会再顶在一起（158）。
    // 起点贴前一条小节线的**右缘**、终点贴后一条的**左缘**，各让一点气。
    // 相邻两房之间因此隔着一条小节线的宽度，不会再顶在一起（158）。
    const gap = opt.endingSize * 0.12;
    const barBefore = [...barInk].reverse().find((b) => b.right <= noteL);
    const barAfter = barInk.find((b) => b.left >= noteR);
    const x0 = barBefore !== undefined ? barBefore.right + gap : noteL - opt.numberSize * 0.35;
    const x1 = barAfter !== undefined ? barAfter.left - gap : noteR + opt.numberSize * 0.35;
    if (x1 <= x0) return null;
    return { num, notes, closed, x0, x1 };
  }

  private drawEnding(
    opt: LayoutOptions,
    sp: { num: string; closed: boolean; x0: number; x1: number },
    top: number,
    drop: number,
  ): void {
    const grp = new Group();
    grp.x = sp.x0;
    grp.y = top;
    const lw = opt.bracketWidth > 0 ? opt.bracketWidth : opt.barlineWidth;
    const path = new GraphicPath();
    path.classes.add("ending-line"); // line-check 的 L10/L11 靠它认（见 browser.ts::CLS_TAGS）
    path.stroke = true;
    path.fill = false;
    path.strokeColor = opt.color;
    path.strokeWidth = lw;
    path.moveTo(0, drop);
    path.lineTo(0, 0);
    path.lineTo(sp.x1 - sp.x0, 0);
    if (sp.closed) path.lineTo(sp.x1 - sp.x0, drop);
    grp.add(path);
    if (sp.num) {
      const tf = new TextFrame();
      tf.classes.add("ending"); // 见 browser.ts::roleOfItem（归 verseNum 那一档，别当成音符）
      tf.font = opt.numberFont.makeWithSize(opt.endingSize);
      tf.color = opt.color;
      tf.text = sp.num;
      // 数字摆在竖脚**右侧**、横线**下方**，谁也不压谁（原书就是这么排的）
      tf.x = lw + opt.endingSize * 0.28;
      tf.y = lw + opt.endingSize * 0.95;
      tf.update();
      grp.add(tf);
    }
    this.group.add(grp);
  }

  /**
   * 段落词（「（副歌）」「（间奏）」）。原书印在**和弦那一带、与和弦同一条基线**，
   * 左右并排（`G（副歌）C` 这种）——落点由 `placeSectionWord` 定（与 spreadForSectionWords
   * 同一个判据、同一份代码，见那边的注释）。
   */
  addSectionWords(opt: LayoutOptions, lineWidth: number): void {
    if (opt.sectionWordSize <= 0) return;
    const size = opt.sectionWordSize;
    const font = opt.lrcFont.makeWithSize(size);
    const chords = this.chordBoxes();
    // 版心右缘：**优先用传进来的行宽**——`group.width` 只有 justify 过的行才有，
    // 末行常是 0，段落词就没人钳得住它（106 首末行那一条伸到了版心外 25pt）。
    const lineRight = lineWidth || this.group.width || Infinity;
    // 小节线的 x：段落词让位**不许跨过它们**（跨过去就成了下一小节的标记）
    const barXs = this.entries
      .filter((e): e is Barline => e instanceof Barline)
      .map((b) => b.group.x)
      .sort((a, b) => a - b);
    // 同一个 Chord 可能在一行里出现**好几个 NoteEntry**：长音的增时线各占一个，
    // 不展开叠排时（有反复房号的谱）整条谱行还会按遍数重复装载。
    // 段落词是挂在 Chord 上的，每个 Chord 只画一次，否则就叠出两三个「（副歌）」（131 首）。
    const drawn = new Set<JChord>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry) || !this.sectionWordOf(e)) continue;
      if (drawn.has(e.chord)) continue;
      drawn.add(e.chord);
      const item = e.entryItem();
      if (!item) continue;
      const tf = new TextFrame();
      tf.classes.add("section-word");
      tf.font = font;
      tf.color = opt.color;
      tf.text = this.sectionWordOf(e)!;
      tf.update();
      // 量宽与笔位都按挤压后的来（见 sectionWordRun）；`charXs` 一路传到 `<text>` 的 `x`。
      const run = sectionWordRun(font, this.sectionWordOf(e)!, opt.punctCompress);
      tf.width = run.width;
      tf.charXs = run.xs;
      // 段落词**可以横向伸出锚点音符的范围**（它只是个标记，原书也这么印），
      // 所以不为它撑开音符间距；能不能放下只看「本小节内有没有不撞和弦的空档」。
      const anchorX = e.group.x + item.x;
      const baseY = this.sectionWordBaseY(e, opt, chords);
      const place = (): SectionWordSlot => {
        const barLeftAt = [...barXs].reverse().find((bx) => bx <= anchorX);
        return placeSectionWord({
          anchorX,
          width: tf.width,
          size,
          baseY,
          chords,
          barLeft: barLeftAt ?? 0,
          barRight: barXs.find((bx) => bx > anchorX) ?? lineRight,
          hangLeft: sectionWordHangLeft(barLeftAt),
          rightLimit: lineRight,
          atLineStart: this.entries[0] === e,
          straddle: this.sectionIndent > 0,
          ownChordRight: this.ownChordRight(e),
        });
      };
      const slot = place();
      tf.x = slot.x;
      // 行首那一条永远不抬（口径如此）：匀不出地方也就贴着和弦，不上去占一层。
      tf.y = slot.lifted && this.entries[0] !== e ? baseY - size * 1.5 : baseY;
      this.group.children.push(tf);
      tf.parent = this.group;
    }
  }

  /** 本行已经排好的和弦盒子——段落词的落位与让位都照它算。
   *  `y` 是盒顶（**字体 ascent**，不是墨迹顶），`base` 是那条基线：
   *  两者差着 ascent，按「盒顶 + 一个字号」估基线会差出一个点（Times 的 ascent 是 0.9 em）。 */
  private chordBoxes(): { x0: number; x1: number; y: number; base: number }[] {
    const out: { x0: number; x1: number; y: number; base: number }[] = [];
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      for (const it of this.chordGroups(e)) {
        const tf = it.children.find((c): c is TextFrame => c instanceof TextFrame);
        out.push({
          x0: e.group.x + it.x, x1: e.group.x + it.x + it.width,
          y: e.group.y + it.y,
          base: e.group.y + it.y + (tf ? tf.y : it.height),
        });
      }
    }
    return out;
  }

  /**
   * 行首段落词还差的那点地方——**从行内其它空档里匀**（justify 之后，行长不变）。
   *
   * 撑开（`spreadForSectionWords`）是在 justify 之前做的，那时的间距还是紧的，
   * 照它算出来的量偏大，而 justify 随后又把同一段空档拉开一遍，两笔叠起来就是
   * 音符右边那道大口子（173/175/189/193 的「（副歌）」，一处吃掉 16pt）。这里改在
   * **排完之后**按真实坐标补：锚点后面的东西右移「差的那一点」，位移沿行**线性衰减到 0**
   * （行末不动），于是那点量被后面二十来个空档各摊掉零点几 pt，眼睛看不出来，
   * 行也不会伸出版心。
   *
   * **必须在画符杠/连音线/弧线之前跑**：那些东西的坐标照音符位置算死，之后再挪音符，
   * 减时线就与音符错开了。
   */
  nudgeForSectionWords(opt: LayoutOptions, lineWidth: number): void {
    if (opt.sectionWordSize <= 0) return;
    const e = this.entries[0];
    if (!(e instanceof NoteEntry) || !this.sectionWordOf(e)) return;
    const item = e.entryItem();
    if (!item) return;
    const n = this.entries.length;
    if (n < 3) return;
    const font = opt.lrcFont.makeWithSize(opt.sectionWordSize);
    const anchorX = e.group.x + item.x;
    const chords = this.chordBoxes();
    const barXs = this.entries.filter((x): x is Barline => x instanceof Barline).map((b) => b.group.x).sort((a, b) => a - b);
    const slot = placeSectionWord({
      anchorX,
      width: sectionWordRun(font, this.sectionWordOf(e)!, opt.punctCompress).width,
      size: opt.sectionWordSize,
      baseY: this.sectionWordBaseY(e, opt, chords),
      chords,
      barLeft: 0,
      barRight: barXs[0] ?? lineWidth,
      hangLeft: 0,
      rightLimit: lineWidth || this.group.width || Infinity,
      atLineStart: true,
      straddle: this.sectionIndent > 0,
      ownChordRight: this.ownChordRight(e),
    });
    if (!slot.lifted || slot.shortfall <= 0) return;
    const need = slot.shortfall;
    this.entries.forEach((ent, k) => { if (k > 0) ent.group.x += (need * (n - 1 - k)) / (n - 2); });
  }

  addBeams(opt: LayoutOptions): void {
    const groups = new Set<BeamGroup>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const grp = this.beamGroups.get(e.chord);
      if (!grp) continue;
      groups.add(grp);
    }
    let maxLev = 0;
    for (const g of groups) {
      let level = 1;
      for (;;) {
        const pairs = new Map<NoteEntry, NoteEntry>();
        let start: NoteEntry | null = null;
        for (const ch of g.chords) {
          if (ch.beams < level) {
            start = null;
            continue;
          }
          if (start === null) start = this.getEntry(ch);
          if (start === null || this.getEntry(ch) === null) continue;
          pairs.set(start, this.getEntry(ch)!);
        }
        if (pairs.size === 0) break;
        maxLev = Math.max(maxLev, level);
        for (const [k, v] of pairs) {
          const l = new BeamLine(level, k, v, opt);
          this.beams.push(l);
          this.group.add(l);
        }
        level++;
      }
    }
    this.maxBeamLevel = maxLev;
  }

  updateLyricY(opt: LayoutOptions): void {
    let dy = opt.numberSize * 0.4;
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        const ey = e.entryBottom(opt);
        dy = Math.max(dy, ey);
      }
    }
    // 成书排版给定「歌词基线到音符基线」的定值时，按它来（减掉 addLyric 已经给的初值）：
    // 原书每一行的歌词都排在同一高度上，不管这一行有没有减时线、低音点；
    // 按自然栈高排会让带减时线的行把歌词推下去，行距忽大忽小。
    if (opt.lyricBaselineGap > 0) dy = opt.lyricBaselineGap - opt.numberFont.size;
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        if (e.lrc === null) continue;
        // 一律**累加**：`lrc.y` 是相对 NoteEntry 组原点的偏移，组早已 update 归一过，
        // 直接赋绝对值会把歌词甩到音符行里去。叠排时各段一起挪，段间距在 addLyric 里给过了。
        for (const li of e.lrcs) li.y += dy;
      }
    }
  }

  /** 叠排时给每个视觉行的**行首**歌词挂段号（原书的「1.」「2.」…，悬在第一个字左边）。
   *  段号不能直接拼进歌词文本——那会把第一个字挤离它对位的音符。 */
  addVerseNumbers(opt: LayoutOptions): void {
    if (opt.lyricStack <= 0 || opt.verseNumbers === "never") return;
    if (opt.verseNumbers === "auto") {
      // 「自动」：段数少的时候不标——两三段的谱一眼就看得清哪行是哪段，
      // 标了反而在每行行首多出一串 1. 2. 3.。段数多了才需要它带路。
      let verses = 0;
      for (const e of this.entries) if (e instanceof NoteEntry) verses = Math.max(verses, e.lrcs.length);
      if (verses <= opt.verseNumberAutoMin) return;
    }
    let atLineStart = true;
    for (const e of this.entries) {
      if (e instanceof LineBreak) {
        atLineStart = true;
        continue;
      }
      if (!(e instanceof NoteEntry) || e.lrcs.length < 2) continue;
      if (!atLineStart) continue;
      atLineStart = false;
      // **挂在行上、用绝对坐标**：挂进 NoteEntry.group 的话，随后的 update() 会把
      // 段号那点负 x 归一掉（首字被挤走、段号压在首字上）。
      // 本方法因此排在 group.update() 之后，此时各 entry 的位置已经定稿。
      for (let k = 0; k < e.lrcs.length; k++) {
        const li = e.lrcs[k];
        if (!li.text) continue;
        const tag = new TextFrame();
        tag.font = opt.lrcFont;
        tag.color = opt.color;
        tag.text = `${k + 1}.`;
        tag.update();
        tag.x = e.group.x + li.x - tag.width;
        tag.y = e.group.y + li.y;
        this.group.children.push(tag);
        tag.parent = this.group;
      }
    }
  }

  connectTextFrames(): void {
    const lrcs: Lyric[] = [];
    const numbers: TextFrame[] = [];
    for (const it of this.entries) {
      if (it instanceof Barline) {
        const tf = it.group.children[0];
        if (tf instanceof TextFrame) numbers.push(tf);
      }
      if (!(it instanceof NoteEntry)) continue;
      if (it.lrc) lrcs.push(it.lrc);
      if (it.number) numbers.push(it.number);
    }
    lrcs.forEach((it, idx) => {
      it.previous = getOrNull(lrcs, idx - 1);
      it.next = getOrNull(lrcs, idx + 1);
    });
    numbers.forEach((it, idx) => {
      it.previous = getOrNull(numbers, idx - 1);
      it.next = getOrNull(numbers, idx + 1);
    });
  }

  /** `skip`：跳过本小节开头这么多个和弦（弱起式接入，见 PlayItem.skip）。
   *  `limit`：只装载前这么多个和弦（-1 = 整节，见 PlayItem.limit）；截断时不补小节线。 */
  load(m: JMeasure, lrc: number, options: LayoutOptions, final: boolean, skip = 0, limit = -1, ignoreBreaks = false): void {
    const ents = byPosition(m.entries).filter((e) => !(ignoreBreaks && e.kind === "break"));
    if (m.timeChange && m.index !== 0) {
      const ts = TimeSig.fromTime(m.time, options);
      this.entries.push(ts);
    }
    if (m.keyChange && m.index !== 0) {
      const key = new KeySig(m.key, options);
      const first = ents[0];
      if (first?.kind === "chord" && first.slurStart) key.group.y -= options.numberSize / 4;
      this.entries.push(key);
    }
    // 小节**开头**的反复起点 `‖:`（MusicXML 的 `<barline location="left">`）。
    // 小节线本来只在小节末补，这里要额外插一条——五线谱怎么标，简谱就怎么标。
    if ((m.repeatForward || m.leftBarline !== null) && skip === 0) {
      const ent = new Barline(false, options, { style: m.leftBarline, repeatForward: m.repeatForward });
      ent.update();
      this.entries.push(ent);
    }
    let hasBarline = limit >= 0; // 截断的小节尾不补小节线（下一段接着唱同一小节）
    let taken = 0;
    for (const ch of ents) {
      if (limit >= 0 && taken >= limit) break;
      if (ch.kind === "break") {
        const ignore = ch.pass !== null && ch.pass !== lrc;
        if (!ignore) {
          const br = new LineBreak();
          br.newPage = ch.newPage;
          this.entries.push(br);
        }
        continue;
      } else if (ch.kind === "chord") {
        if (skip > 0) { skip--; continue; }
        NoteEntry.fromChord(this.entries, ch, lrc, options);
        taken++;
      } else {
        const ent = new Barline(final, options, { style: m.barline, repeatBackward: m.repeatBackward });
        ent.update();
        this.entries.push(ent);
        hasBarline = true;
      }
    }
    if (!hasBarline) {
      const ent = new Barline(final, options, { style: m.barline, repeatBackward: m.repeatBackward });
      ent.update();
      if (this.entries[this.entries.length - 1] instanceof LineBreak) {
        this.entries.splice(this.entries.length - 1, 0, ent);
      } else {
        this.entries.push(ent);
      }
    }
  }
}

export class Layout {
  options: LayoutOptions;
  pages: Group[] = [];
  /** 上一次 `fromScore` 各行首音的和弦 id，见 `Line.lineStarts` */
  lineStarts: number[] = [];
  constructor(public fontSize: number) {
    this.options = new LayoutOptions(fontSize);
  }

  private parseBreakDur(s: string): Map<string, number> {
    const pgs = s.replace(/\|/g, "\n").replace(/\./g, " ").split("\n");
    const res = new Map<string, number>();
    let last = new Fraction(0);
    for (const pg of pgs) {
      if (pg.length === 0) continue;
      const lines = pg.split(" ");
      for (const it of lines) {
        if (it.trim().length === 0) continue;
        let str = it.trim();
        let v = 1;
        if (str.includes("{")) {
          v = 0;
          str = str.replace(/\{/g, "").replace(/\}/g, "");
        }
        const dur = Fraction.fromString(str);
        last = last.plus(dur);
        res.set(last.toString(), v);
      }
      res.set(last.toString(), 2);
    }
    return res;
  }

  durationInfo(s: string, total: Fraction, pass: number | null): Map<string, number> {
    const durInfo = new Map<string, number>();
    const ss = substringAfter(s, "=").trim();
    if (s.includes("LinesPerPage")) {
      const arr = ss.split("|").map((x) => parseInt(x, 10));
      const lineCnt = arr.reduce((a, b) => a + b, 0);
      const dur = total.divInt(lineCnt);
      let pos = new Fraction(0);
      for (const it of arr) {
        for (let i = 0; i < it; i++) {
          const v = i === it - 1 ? 2 : 1;
          pos = pos.plus(dur);
          durInfo.set(pos.toString(), v);
        }
      }
    } else {
      for (const [k, v] of this.parseBreakDur(ss)) durInfo.set(k, v);
    }
    if (pass !== null) {
      const keys = [...durInfo.keys()];
      for (let i = 1; i < pass; i++) {
        for (const k of keys) {
          const t = Fraction.fromString(k).plus(total.timesInt(i));
          durInfo.set(t.toString(), durInfo.get(k)!);
        }
      }
    }
    return durInfo;
  }

  breakByDur(l: Line, s: string, total: Fraction, pass: number | null): void {
    const durInfo = this.durationInfo(s, total, pass);
    let tick = new Fraction(0);
    const newEnt: Entry[] = [];
    let lineBeg = 0;
    let lastChord: JChord | null = null;
    let lastTick: Fraction | null = null;
    for (const e of l.entries) {
      let isNote = false;
      let end = tick;
      if (e instanceof NoteEntry) {
        const ch = e.chord;
        if (ch !== lastChord) {
          isNote = true;
          end = end.plus(ch.duration!);
          lastChord = ch;
        }
      }
      let doBreak = durInfo.has(tick.toString());
      if (!(isNote || e instanceof KeySig)) doBreak = false;
      if (lastTick !== null && lastTick.equals(tick)) doBreak = false;
      if (doBreak) {
        if (durInfo.get(tick.toString()) === 0) {
          while (newEnt.length > lineBeg) newEnt.splice(lineBeg, 1);
        } else {
          const br = new LineBreak();
          br.newPage = durInfo.get(tick.toString()) === 2;
          newEnt.push(br);
          lineBeg = newEnt.length;
        }
        lastTick = tick;
      }
      newEnt.push(e);
      tick = end;
    }
    l.entries = newEnt;
  }

  /**
   * **只量不排**：把整首装成一条 Line，返回每个和弦的自然横向区间与版心宽度。
   *
   * 给「一行放不放得下」用（`applybreaks.ts::FitMetric`）。与 `fromScore` 共用同一套
   * 装载逻辑（`buildLine`），量到的坐标就是排版器折行时用的那一套。
   */
  measureNatural(scr: JScore, width: number): { width: number; spans: Map<JChord, { x0: number; x1: number }> } {
    const cw = width - this.options.marginLeft - this.options.marginRight;
    const l = this.buildLine(scr, null);
    l.connectTextFrames();
    return { width: cw, spans: l.naturalSpans(this.options) };
  }

  /** 把整首装成一条 Line（分行之前的那一条）。`fromScore` 与 `measureNatural` 共用。 */
  private buildLine(scr: JScore, dur: string | null): Line {
    const ignoreBreaks = dur !== null;
    const p = scr.parts[0];
    const l = new Line();
    // 叠排 = **按原谱排一遍**：不展开任何反复（原样档）。
    //
    // 反复本来就是用记号表示的（`‖:` `:‖`、房号、D.S.），原书 500 首就是印一遍谱 +
    // 记号 + 底下叠几段歌词。而 playData 是给**试听**用的展开序列：多段歌词在那里被摊成
    // 好几遍，064《啊！圣善夜》甚至摊成 10 遍——照着它排，一首歌能排出十几页。
    // 逐遍怎么走（首尾裁切、遍末换页）与文本谱共用 jianpu/expand.ts::walkPlay。
    const plan = this.options.lyricStack > 0 ? identityPlan(p.measures.length) : scr.playData.measures;
    walkPlay(plan, {
      measure: (mid, pass, cut) => {
        const m = p.measures[mid];
        for (const [ch, g] of beamGroupsOf(m)) l.beamGroups.set(ch, g);
        l.load(m, pass, this.options, cut.final, cut.skip, cut.limit, ignoreBreaks);
      },
      passEnd: () => {
        if (dur !== null) return;
        const lst = l.entries[l.entries.length - 1];
        if (!(lst instanceof LineBreak)) l.entries.push(new LineBreak());
        (l.entries[l.entries.length - 1] as LineBreak).newPage = true;
      },
    });
    if (dur !== null) {
      const part = scr.parts[0];
      const mea = part.measures[part.measures.length - 1];
      const total = mea.position.plus(measureDuration(mea));
      let pass: number | null = null;
      if (scr.playData.isSimpple) pass = scr.playData.measures.length;
      this.breakByDur(l, dur, total, pass);
    }
    return l;
  }

  fromScore(scr: JScore, dur: string | null, width: number, height: number): void {
    this.pages = [];
    const cw = width - this.options.marginLeft - this.options.marginRight;
    const ch = height - this.options.marginTop - this.options.marginBottom;
    const l = this.buildLine(scr, dur);
    l.connectTextFrames();
    for (const g of l.layout(cw, ch, this.options)) this.pages.push(g);
    this.lineStarts = l.lineStarts;
    this.shiftToMargin();
  }

  /** 页组右移一个左边距（版心原点）。页脚（曲名 + 页码）归 painter 那一层
   *  （`layout/jianpupages.ts::addFooters`，展开档才有）。 */
  shiftToMargin(): void {
    for (const pg of this.pages) pg.x += this.options.marginLeft;
  }
}

function substringAfter(s: string, delim: string): string {
  const i = s.indexOf(delim);
  return i < 0 ? s : s.substring(i + delim.length);
}

/** 小节条目按拍位稳定排序（不改输入）。 */
function byPosition<T extends { position: Fraction }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.position.compareTo(b.position));
}

/** 符杠分组的一组和弦。 */
export class BeamGroup {
  chords: JChord[] = [];
}

/** **按拍自动成组**：拍长一个四分（`x/8` 拍号是附点四分）；减时线为 0 或长过一拍的不进组。 */
function beamGroupsOf(m: JMeasure): Map<JChord, BeamGroup> {
  let len = new Fraction(1);
  if (m.time.beatType === 8) len = len.divInt(2).timesInt(3);
  const res = new Map<JChord, BeamGroup>();
  let cur: BeamGroup | null = null;
  let curStart: Fraction | null = null;
  for (const ent of byPosition(m.entries)) {
    if (ent.kind !== "chord") continue;
    if (ent.duration === undefined) throw new Error("");
    if (ent.beams === 0) continue;
    if (ent.duration.compareTo(len) > 0) continue;
    const start = len.timesInt(ent.position.div(len).toInt());
    if (curStart !== null && !curStart.equals(start)) curStart = null;
    if (curStart === null) cur = new BeamGroup();
    cur!.chords.push(ent);
    res.set(ent, cur!);
    curStart = start;
  }
  return res;
}
