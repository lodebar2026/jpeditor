// 五线谱引擎建版：`ScoreDoc`（MusicXML 形状）→ `StaffLayout`（版面态，`model.ts`）。从 musicpp mxml/parser.cpp 移植，判据原样。
// 各声部读完之后的版面 pass 在 `layoutpass.ts`。
//
// **引擎里没有模型**：版面节点（`ChordLayout` / `NoteLayout` / `LyricLayout` / `HarmonyLayout`）只带 `src`
// （对应的 `ScoreDoc` 元素）与坐标、符干这类版面态，音高、时值、歌词、和弦内容一律经 `src` 取。
// 跨元素对象（slur / tie / tuplet / ending / wedge）在这里按 `ElementId` 配到版面节点上。
//
// 只读 `ScoreDoc`（不另读 MusicXML DOM）。
//
// ## 与 DOM 读法的对应
//
// - 游标：DOM 读法按 `<backup>`/`<forward>` 现算；这里取 `Chord.onset`（缺省 = 前一个元素的终点），
//   `<direction>` 取 `Direction.onset`（缺省 = `afterElements` 处前一个元素的终点），`<harmony>` 取 `Harmony.onset`（缺省 = 所挂元素的起点）
// - 同一小节里 `<attributes>` / 音符 / `<harmony>` / `<direction>` / `<barline>` 各自独立成表，
//   交错次序不影响结果，所以按类分开走（各类内部仍按原文次序）
// - slur / tuplet 由 `Song.marks` 给出（按收口先后），在收口那个音读到时建，端点音照 DOM 读法「读到此处时和弦里的最后一个音」取
//
// ## 已知与 DOM 读法不同、上述语料里 0 例的（记着，不补）
//
// - 和弦音各自的 `print-object` / `staff` / `<type size>` / 歌词：`ScoreDoc` 只存在和弦上（取首音）
// - `<dynamics>` 多个子元素 / `<other-dynamics>`、`<strong-accent type>`、`<pedal type="change">`、休止上的 `<stem>`
// - `<tuplet bracket>`：DOM 读法读的是 **stop** 上的属性（musicpp 原样），语料 51 处都写在 start 上，所以从来不认；这里照样不认
// - 一个 `<credit>` 多个 `<credit-words>`：DOM 读法只取第一个

import { Fraction } from "../common/fraction";
import { Font } from "../layout/font";
import { GlyphCodes } from "../smufl/smufl";
import type {
  Barline,
  Chord as DocChord,
  Clef as DocClef,
  Direction,
  DirectionPart,
  FontSpec,
  Harmony,
  Key as DocKey,
  Lyric,
  Mark,
  Measure,
  MeasureAttrs,
  Note as DocNote,
  Part as DocPart,
  ScoreDoc,
  Song,
  Time as DocTime,
} from "../model/doc";
import {
  Arpeggiate,
  BeamGroup,
  BeamVal,
  ClefSig,
  Encoder,
  fEq,
  GroupSymbol,
  KeySig,
  LCR,
  LrcExtend,
  ChordLayout,
  PartMeasureLayout,
  MeasureLayout,
  MeasureText,
  LyricLayout,
  MixedOptions,
  PartLayout,
  StaffLayout,
  NoteLayout,
  NotationItem,
  PartGroup,
  PartStaff,
  TimeSig,
} from "./model";
import {
  barGlyphFromStyle,
  convertDynamicsStr,
  finishMixedScore,
  hasEmbeddedLayout,
  metNoteGlyph,
  parseEndingNums,
  type LayoutInput,
  type PrintInput,
} from "./layoutpass";
import { melodyChords, topNote } from "../model/jianpu";

/** Bravura Text 里 segno/coda 相对 Bravura 同一字形的大小（见 processSegno） */
const BRAVURA_TEXT_SCALE = 0.8;
const STEP_DIATONIC: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

function makeClef(c: DocClef): ClefSig {
  const octChange = c.octaveChange ?? 0;
  const k = new ClefSig();
  switch (c.sign) {
    case "G": k.sign = octChange === -1 ? GlyphCodes.gClef8vb : GlyphCodes.gClef; break;
    case "F": k.sign = GlyphCodes.fClef; break;
    case "C": k.sign = GlyphCodes.cClef; break;
    case "percussion": k.sign = GlyphCodes.unpitchedPercussionClef1; break;
    case "TAB": k.sign = GlyphCodes.sixStringTabClef; break;
    default: k.sign = GlyphCodes.gClef;
  }
  k.line = c.line ?? 2;
  return k;
}

function makeKey(key: DocKey): KeySig {
  const k = new KeySig();
  k.fifths = key.fifths;
  if (key.cancel !== undefined) k.cancel = key.cancel;
  return k;
}

function makeTime(time: DocTime): TimeSig {
  const t = new TimeSig();
  t.beats = time.beats;
  t.beatType = time.beatType;
  t.symbol = time.symbol === "common" || time.symbol === "cut";
  return t;
}

interface TieRef { note: NoteLayout; pitch: number; endTick: Fraction }

/** 一个元素在小节里的游标（divisions）：`onset` 缺省 = 前一个元素的终点 */
function measureTiming(m: Measure): { onsets: number[]; endAfter: number[]; end: number } {
  const onsets: number[] = [];
  /** endAfter[k]：前 k 个元素之后的「前一个元素终点」 */
  const endAfter: number[] = [0];
  let prevEnd = 0;
  let maxEnd = m.duration ?? 0;
  for (const el of m.elements) {
    const on = el.onset ?? prevEnd;
    onsets.push(on);
    if (el.kind === "chord") {
      prevEnd = on + el.duration.divisions;
      if (prevEnd > maxEnd) maxEnd = prevEnd;
    }
    endAfter.push(prevEnd);
  }
  return { onsets, endAfter, end: maxEnd };
}

class DocPartLoader {
  part: PartLayout;
  score: StaffLayout;
  src: DocPart;
  /** 本声部的 slur / tuplet（按收口先后），按收口那个和弦 id 分组 */
  marksByEnd = new Map<number, Mark[]>();
  chordById = new Map<number, ChordLayout>();
  docChordById = new Map<number, DocChord>();
  stemYMap = new Map<NoteLayout, number>(); // note → stem default-y
  stemNotes = new Set<NoteLayout>(); // 有 <stem> 元素的音符（parser.cpp stemDir）
  /** 方向是猜的（整个和弦都没写 `<stem>`）的和弦：组内全是猜的符杠组整组统一方向（`BeamGroup.unifyStemDir`） */
  guessedStem = new Set<ChordLayout>();
  hasBeamEl = false; // 本声部是否出现过 <beam>（无则自动按拍分组符杠，供 OMR 谱用）
  transposeSteps = 0;
  /** 当前小节里同一谱表并存多个声部时，各声部的符干方向（`staff:voice` → 朝上）。
   *  ABC `&` 的临时多声部（§7.4）没有 `<stem>`，只按音高猜会让两条并行旋律的符干混在一起分不出层次：
   *  主声部（号最小的那个）一律朝上、其余朝下，这是制谱通例。单声部小节仍走按音高的老规则。 */
  voiceStem = new Map<string, boolean>();
  /** 方向已按声部定好的和弦（`voiceStem`）：自动分组符杠时不能再按音高统一一次，否则分层又没了 */
  forcedStem = new Set<ChordLayout>();
  /** 当前小节的 divisions 与简谱叠层的旋律（和弦 → 印的那个音） */
  curDiv = 1;
  melody = new Map<DocChord, DocNote | null>();

  tieStarts: TieRef[] = [];
  tieStops: TieRef[] = [];
  // lrc linking: num → [LyricLayout list in order]
  lrcByNum = new Map<string, LyricLayout[]>();
  // lyric extend (melisma) points, paired 2-by-2 in processLrcExtend
  lrcExtendPts: { note: NoteLayout; lrc: LyricLayout; tick: Fraction; stop: boolean }[] = [];
  // 本声部自己的 ending 端点（print-object="no" 不计入），对齐 musicpp 按 part 收集，
  // 避免反复记号在每个声部都被画一遍。
  endingPts: { mif: MeasureLayout; nums: Set<number>; text: string; start: boolean; stop: boolean }[] = [];

  // 琶音：当前小节内按 offset 聚合的音符（loadMeasure 末尾成组）。
  arpegNotes = new Map<string, NoteLayout[]>();
  // wedge/pedal 端点（parser.cpp processWedge/processPedal：全声部收集后配对）。
  wedgePts: {
    mif: MeasureLayout;
    tick: Fraction;
    staff: number;
    type: "crescendo" | "diminuendo" | "stop";
    relX: number | null;
    defY: number | null;
  }[] = [];
  pedalPts: {
    mif: MeasureLayout;
    tick: Fraction;
    staff: number;
    line: boolean;
    stop: boolean;
    ypos: number;
  }[] = [];

  constructor(part: PartLayout, score: StaffLayout, src: DocPart, marks: Mark[]) {
    this.part = part;
    this.score = score;
    this.src = src;
    const ids = new Set<number>();
    for (const m of src.measures) {
      for (const el of m.elements) {
        if (el.kind !== "chord") continue;
        ids.add(el.id);
        this.docChordById.set(el.id, el);
      }
    }
    for (const mk of marks) {
      if (mk.type !== "slur" && mk.type !== "tuplet") continue;
      if (!ids.has(mk.start) || !ids.has(mk.end)) continue;
      const list = this.marksByEnd.get(mk.end);
      if (list) list.push(mk);
      else this.marksByEnd.set(mk.end, [mk]);
    }
  }

  load(): void {
    const first = this.src.measures[0]?.attrs;
    const staveCount = first?.staves ?? 1;
    if (first?.transpose) this.transposeSteps = first.transpose.diatonic ?? 0;
    for (let i = 0; i < staveCount; i++) {
      const ps = new PartStaff(this.part, i);
      this.part.staves.push(ps);
    }

    // 绝对 tick 必须在 loadMeasure 之前就设到 mif.offset，否则 processAttributes 记录的
    // clef/key/time 变化全落在 tick 0、互相覆盖（对齐 musicpp parser.cpp:1291，offset 在
    // loadAttributes 之前赋值）。finishMixedScore 的全局 offset pass 会再统一一次（多声部规范化）。
    let div = 1;
    let runTick = new Fraction(0);
    for (let mid = 0; mid < this.src.measures.length; mid++) {
      const m = this.src.measures[mid];
      const mif = this.score.measures[mid];
      if (!mif) continue;
      mif.offset = runTick;
      div = this.loadMeasure(m, mif, div);
      runTick = runTick.plus(mif.dur);
    }

    this.calcStemLen();
    if (!this.hasBeamEl) this.autoBeamPart();
    this.formatBeams();
    // 符干/符杠就绪后再排记号（fermata 等），使 tailY 取到最终符干末端，避免 fermataBelow
    // 压住后续加长的符干（musicpp parser.cpp:2914）。
    for (const md of this.part.measures) md.layoutNotations();
    this.processTied();
    this.processEnding();
    this.pairWedges();
    this.pairPedals();
    this.processLrcExtend();
    this.part.guessTiedPlacement();
    // 只留旋律放在**最后**（util/pao.cpp:1003：load 整条跑完才 removeNoneMelody）：
    // 弧/延音线的配对与方向推断要在**完整的多声部、多音和弦**上做，删早了
    // `guessTiedPlacement` 看到的都是单音 Entry，方向退化成按符干猜，还会多加 yOffsetType 的 8 tenths。
    if (this.score.options.melodyOnly) this.removeNoneMelody();
  }

  /** Part::removeNoneMelody（model.cpp:2312）：删掉非旋律音——和弦只留简谱印的那个音
   *  （`jpMelody`，即原程序的 `layer==1`），没有旋律音的和弦整个删掉；端点落在被删音上的
   *  弧与延音线一并删。删完按首音重猜符干方向并重排符杠（原实现在 guessStemDir 里逐组 `format(0)`）。 */
  private removeNoneMelody(): void {
    const sib = this.score.encoder === Encoder.Sibelius;
    const meta = this.score.options.meta;
    // Sibelius 把两声部的弧都写在和弦首音上：按弧的方向重挂——上方弧挂最高音、下方弧挂最低音
    this.part.slurs = this.part.slurs.filter((sl) => {
      const pick = (nt: NoteLayout | null): NoteLayout | null => {
        if (!sib || !nt) return nt;
        const ns = nt.chord.notes;
        return sl.above ? ns[ns.length - 1]! : ns[0]!;
      };
      sl.startNote = pick(sl.startNote);
      if (sl.startNote && !sl.startNote.jpMelody) return false;
      sl.endNote = pick(sl.endNote);
      if (sl.endNote && !sl.endNote.jpMelody) return false;
      return true;
    });
    // 延音线按**原本挂的那个音**判，不重挂
    this.part.tied = this.part.tied.filter(
      (t) => !(t.startNote && !t.startNote.jpMelody) && !(t.endNote && !t.endNote.jpMelody),
    );
    for (const md of this.part.measures) {
      md.chords = md.chords.filter((ch) => {
        const n = ch.notes.find((nn) => nn.jpMelody);
        if (!n) return false;
        ch.notes = [n];
        return true;
      });
      for (const ent of md.noteEntries) {
        ent.notes = ent.notes.filter((n) => n.jpMelody);
        ent.layout(meta, sib);
      }
      // 组里还留着非旋律音的符杠组整组删：那几个和弦已从 md.chords 摘掉、音没被缩到旋律音
      md.beams = md.beams.filter((g) => !g.chords.some((ch) => ch.notes.some((n) => !n.jpMelody)));
    }
    this.guessStemDir();
    this.formatBeams();
  }

  private loadMeasure(m: Measure, mif: MeasureLayout, prevDiv: number): number {
    let div = prevDiv;
    const dv = m.attrs?.divisions;
    if (dv !== undefined && dv > 0) div = dv;

    const { onsets, endAfter, end } = measureTiming(m);
    const dur = new Fraction(end, div);
    if (dur.compareTo(mif.dur) > 0) mif.dur = dur;
    mif.number = m.number;
    if (m.implicit) mif.implicit = true;
    if (m.width !== undefined) mif.width = m.width;

    const md = this.part.newMeasure();
    md.measureInfo = mif;
    this.curDiv = div;
    // 简谱叠层印的那一路：语义层的旋律取音（第一谱表最小 voice 的和弦，和弦取最高音）
    this.melody = new Map(melodyChords(m, 1).map((c) => [c, topNote(c) ?? null] as const));

    this.arpegNotes.clear();
    this.loadVoiceStems(m);

    if (m.attrs) this.processAttributes(m.attrs, mif.offset);

    const tickOf = (divs: number): Fraction => new Fraction(divs, div);
    // `<harmony><offset>`（长音中间换和弦）：musicpp 只认 MuseScore 写的；本应用自己写出的（文本格式派生、导出）也认
    const enc = this.score.encoder;
    const harmonyDelta = (h: Harmony): Fraction =>
      (enc === Encoder.MuseScore || enc === Encoder.Jpeditor) && h.offset !== undefined ? new Fraction(Math.round(h.offset), div) : new Fraction(0);

    // 小节中间的 <attributes> 要在读到那个位置时就设上：后面的音读的时候就要用谱号定符干方向（nt.line()）
    const laterAttrsAt = (i: number): void => {
      for (const la of m.laterAttrs ?? []) {
        if (Math.min(la.afterElements, m.elements.length) !== i) continue;
        this.processAttributes(la.attrs, mif.offset.plus(tickOf(la.onset ?? endAfter[i])));
      }
    };
    m.elements.forEach((el, i) => {
      if (i > 0) laterAttrsAt(i);
      const on = onsets[i];
      if (el.kind === "chord") {
        for (const h of [el.harmony, ...(el.laterHarmonies ?? [])]) {
          if (h) this.processHarmony(h, md, tickOf(h.onset ?? on).plus(harmonyDelta(h)));
        }
        const tick = tickOf(on);
        let ch: ChordLayout | null = null;
        if (el.notes.length === 0) ch = this.processNote(el, null, 0, md, tick, ch);
        el.notes.forEach((n, k) => {
          ch = this.processNote(el, n, k, md, tick, ch);
        });
      } else if (el.harmony) {
        const h = el.harmony;
        this.processHarmony(h, md, tickOf(h.onset ?? on).plus(harmonyDelta(h)));
      }
    });
    for (const d of m.directions ?? []) {
      if (d.type === "sound") continue;
      const at = d.onset ?? endAfter[Math.min(d.afterElements ?? 0, m.elements.length)];
      const delta = d.offset !== undefined ? new Fraction(Math.round(d.offset), div) : new Fraction(0);
      this.processDirection(d, md, tickOf(at).plus(delta));
    }
    laterAttrsAt(m.elements.length);
    for (const b of m.barlines ?? []) this.processBarline(b, mif);

    // 整小节休止照 parser.cpp:1304：拿**当前拍号**折算的小节长 tsDur 比，不是本小节实际最大时值
    // mif.dur——弱起/不满小节里一个四分或二分休止会恰好等于 mif.dur，被误当整小节休止（换全休止
    // 字形、居中、Y 按全休止走）。tsDur 取到此刻为止最后设过的拍号（musicpp 的 stf->time.rbegin()）。
    {
      const ts = this.part.staves[0]?.time.last?.v;
      if (ts) {
        const tsDur = new Fraction(ts.beats * 4, ts.beatType);
        for (const ch of md.chords) {
          if (ch.rest && fEq(ch.dur, tsDur)) ch.measureRest = true;
        }
      }
    }

    md.sortChords();
    // 符杠组先整组定方向，再建 NoteEntry（二度错位 autoFlip 看的是方向）、算符干长（calcStemLen/formatBeams）
    for (const g of md.beams) {
      if (g.chords.every((ch) => ch.rest || this.guessedStem.has(ch))) g.unifyStemDir();
    }
    md.layoutNotes(this.score.options.meta, this.score.encoder === Encoder.Sibelius);
    // layoutNotations 不在此处调用：它依赖最终符干长度（fermataBelow 等记号按 tailY 定位），
    // 而 stemLen 要等 calcStemLen/formatBeams 之后才就绪。改在 load 里统一后处理，
    // 对齐 musicpp（parser.cpp:2914「after stem & beam info done」）。

    // 琶音成组（parser.cpp:1972）：同 offset 一组，按 staff、line 排序后回填 nt.arpeg。
    for (const notes of this.arpegNotes.values()) {
      const arp = new Arpeggiate();
      notes.sort((a, b) => (a.staff !== b.staff ? a.staff - b.staff : a.line() - b.line()));
      for (const n of notes) n.arpeg = arp;
      arp.notes = notes;
      md.arpegs.push(arp);
    }
    return div;
  }

  private processAttributes(a: MeasureAttrs, tick: Fraction): void {
    for (const c of a.clefs ?? []) {
      const num = (c.staff ?? 1) - 1;
      if (num < this.part.staves.length) this.part.staves[num].clef.set(tick, makeClef(c));
    }
    if (a.key) {
      const ks = makeKey(a.key);
      for (const stf of this.part.staves) stf.key.set(tick, ks);
    }
    if (a.time) {
      const ts = makeTime(a.time);
      for (const stf of this.part.staves) stf.time.set(tick, ts);
    }
  }

  /** 一个 `<note>`：`k` 是它在和弦里的下标（首音建 `ChordLayout`，其余并进去）。`note` 为 null 是没有音高的休止/节奏音符。 */
  private processNote(
    src: DocChord,
    note: DocNote | null,
    k: number,
    md: PartMeasureLayout,
    tick: Fraction,
    prevChord: ChordLayout | null,
  ): ChordLayout {
    let ch: ChordLayout;
    if (prevChord === null) {
      ch = md.newChord(src, this.curDiv);
      ch.offset = tick;
      this.processBeam(ch, src.beams, md);
      this.chordById.set(src.id, ch);
    } else {
      ch = prevChord;
    }

    const nt = ch.newNote();
    nt.src = note;
    const top = this.melody.get(src);
    nt.jpMelody = top !== undefined && (note === null || note === top);

    const pitch = note?.pitch;
    if (!ch.rest && pitch) nt.writtenPitch = pitch.octave * 7 + (STEP_DIATONIC[pitch.step] ?? 0) + this.transposeSteps;
    nt.x = (note ? note.pos : src.pos)?.defaultX ?? -1;

    if (note?.stem !== undefined) {
      ch.stemUp = note.stem === "up";
      this.stemNotes.add(nt);
      if (note.stemY !== undefined) this.stemYMap.set(nt, note.stemY);
    } else if (this.voiceStem.size > 0 && k === 0 && !ch.rest && ch.noteType.compareTo(new Fraction(4)) < 0
               && this.voiceStem.has(`${src.staff}:${src.voice}`)) {
      // 同一谱表并存两个声部（ABC `&` 的临时多声部）：按声部定方向，不按音高猜。
      // **不登记进 `guessedStem`**：那会让整组符杠再按音高统一一次方向，分层又没了。
      ch.stemUp = this.voiceStem.get(`${src.staff}:${src.voice}`)!;
      this.stemNotes.add(nt);
      this.forcedStem.add(ch);
    } else if (k === 0 && !ch.rest && ch.noteType.compareTo(new Fraction(4)) < 0 && !src.notes.some((n) => n.stem !== undefined)) {
      // 整个和弦都没有 <stem> 且需符干（非全音符）的谱（如 OMR 生成、未给符干方向）：按首音相对中线
      // 位置定默认方向（中线 line=-4 及以上朝下，其下朝上），并登记以便 calcStemLen 给长度。
      // **和弦里只有部分音写了 <stem> 时不猜**：musicpp parser.cpp:1586 只按写了 <stem> 的音定方向，
      // Sibelius 导出的和弦音都不写 <stem>，逐音猜会把首音明写的方向覆盖掉（KL2020《为基督大业》）。
      ch.stemUp = nt.line() < -4;
      this.stemNotes.add(nt);
      this.guessedStem.add(ch);
    }


    this.processTie(note, nt, ch.tick());
    const arp = this.processNotations(src, k, ch);
    if (arp) {
      const key = `${ch.offset.numerator}/${ch.offset.denominator}`;
      const arr = this.arpegNotes.get(key) ?? [];
      arr.push(nt);
      this.arpegNotes.set(key, arr);
    }
    if (!ch.rest && k === 0) this.processLrc(src.lyrics ?? [], md, ch, nt);
    return ch;
  }

  private processBeam(ch: ChordLayout, beams: DocChord["beams"], md: PartMeasureLayout): void {
    if (!beams || beams.length === 0) return;
    this.hasBeamEl = true;
    const beamMap = new Map<number, BeamVal>();
    beams.forEach((b, num) => {
      switch (b.trim()) {
        case "begin": beamMap.set(num, BeamVal.Begin); break;
        case "continue": beamMap.set(num, BeamVal.Continue); break;
        case "end": beamMap.set(num, BeamVal.End); break;
        case "forward hook": beamMap.set(num, BeamVal.Forward); break;
        case "backward hook": beamMap.set(num, BeamVal.Backward); break;
      }
    });
    if (beamMap.size === 0) return;
    const maxIdx = Math.max(...beamMap.keys());
    ch.beams = [];
    for (let i = 0; i <= maxIdx; i++) ch.beams.push(beamMap.get(i) ?? BeamVal.Continue);

    if (ch.beams[0] === BeamVal.Begin) {
      const g = new BeamGroup();
      (ch.grace ? md.graceBeams : md.beams).push(g);
      g.chords.push(ch);
    } else {
      const arr = ch.grace ? md.graceBeams : md.beams;
      if (arr.length > 0) arr[arr.length - 1].chords.push(ch);
    }
  }

  private processLrc(lyrics: Lyric[], md: PartMeasureLayout, ch: ChordLayout, nt: NoteLayout): void {
    for (const l of lyrics) {
      const lrc = md.newLyric(l, ch);
      lrc.offset = ch.offset;
      lrc.x = nt.x;

      let y = l.pos?.defaultY ?? -1;
      const ry = l.pos?.relativeY;
      if (ry !== undefined) y += ry;
      lrc.y = y;
      lrc.font = l.font?.family || l.font?.size
        ? new Font(l.font.family ?? this.score.defaults.lyricFont.family, l.font.size ? l.font.size / this.score.scaling : this.score.defaults.lyricFont.size)
        : this.score.defaults.lyricFont;
      // parser.cpp:2576：lrcHWID 时歌词字体开 hwid（→ OpenType `halt`），标点占半身
      lrc.compress = this.score.options.lrcHWID ? "halfwidth" : "clreq";

      lrc.updateWidth(this.score.options.meta);

      // register for prev/next linking
      const arr = this.lrcByNum.get(lrc.num) ?? [];
      arr.push(lrc);
      this.lrcByNum.set(lrc.num, arr);

      // lyric extend (melisma): collect points, paired later
      if (l.extend) {
        this.lrcExtendPts.push({ note: nt, lrc, tick: ch.tick(), stop: l.extendType === "stop" });
      }
    }
  }

  private processTie(note: DocNote | null, nt: NoteLayout, tick: Fraction): void {
    if (note?.tie?.start) {
      nt.tieBegin = true;
      this.tieStarts.push({ note: nt, pitch: nt.writtenPitch, endTick: tick.plus(nt.chord.dur) });
    }
    if (note?.tie?.stop) {
      nt.tieEnd = true;
      this.tieStops.push({ note: nt, pitch: nt.writtenPitch, endTick: tick });
    }
  }

  /** 第 `k` 个音上的记号。和弦级的（fermata/articulations/arpeggiate）挂首音；slur/tuplet 在收口那个音上建。 */
  private processNotations(src: DocChord, k: number, ch: ChordLayout): boolean {
    const n = k === 0 ? src.notations : undefined;
    // fermata（parser.cpp:1446 processNotations）。type=inverted → 下方。
    if (n?.fermata) {
      const item = new NotationItem();
      item.above = !n.fermataInverted;
      item.symbol = item.above ? GlyphCodes.fermataAbove : GlyphCodes.fermataBelow;
      ch.notations.push(item);
    }
    // arpeggiate（parser.cpp:1461）—— 实际上下竖波浪线在 loadMeasure 末尾成组。
    const arp = src.notations?.arpeggiate === true;
    // articulations（parser.cpp:1463）—— 重音/断奏/保持音/marcato/staccatissimo。
    // above/symbol 初始按上方字形，最终上下由 layoutNotations::setAbove 决定。
    for (const a of n?.articulations ?? []) {
      const item = new NotationItem();
      switch (a) {
        case "strong-accent":
          item.above = true;
          item.symbol = GlyphCodes.articMarcatoAbove;
          break;
        case "accent":
          item.symbol = GlyphCodes.articAccentAbove;
          break;
        case "staccato":
          item.symbol = GlyphCodes.articStaccatoAbove;
          break;
        case "tenuto":
          item.symbol = GlyphCodes.articTenutoAbove;
          break;
        case "staccatissimo":
          item.symbol = GlyphCodes.articStaccatissimoAbove;
          break;
        default:
          // spiccato/stress/breath-mark/caesura 等：musicpp 未绘制，忽略。
          continue;
      }
      ch.notations.push(item);
    }
    for (const mk of this.marksByEnd.get(src.id) ?? []) {
      if ((mk.endNote ?? 0) !== k) continue;
      const start = this.chordById.get(mk.start);
      if (!start) continue;
      if (mk.type === "slur") {
        // parser.cpp::processSlur —— placement 优先，缺省时退回 orientation
        // （Sibelius 导出用 orientation="over/under"，无 placement）。
        const above =
          mk.placement === "above" ? true
          : mk.placement === "below" ? false
          : mk.orientation === "over" ? true
          : mk.orientation === "under" ? false
          : null;
        const sl = this.part.newSlur();
        sl.startTick = start.tick();
        sl.endTick = ch.tick();
        sl.startNote = start.notes[start.notes.length - 1];
        sl.endNote = ch.notes[ch.notes.length - 1];
        sl.mark = mk;
        if (above !== null) sl.above = above;
        else sl.autoDir = true;
      } else {
        const tm = this.docChordById.get(mk.start)?.duration.timeMod;
        const tup = this.part.newTuplet();
        tup.startTick = start.tick();
        tup.endTick = ch.tick().plus(ch.dur);
        tup.startNote = start.notes[0];
        tup.endNote = ch.notes[0];
        tup.timeModification = new Fraction(tm?.normal ?? 2, tm?.actual ?? 3);
      }
    }
    return arp;
  }

  /** Pair lyric extend points 2-by-2 (musicpp parser.cpp:753 processLrcExtend)。 */
  processLrcExtend(): void {
    const pts = [...this.lrcExtendPts];
    const numOf = (s: string) => {
      const n = parseInt(s, 10);
      return isNaN(n) ? 0 : n;
    };
    // 仅当存在显式 <extend type="stop"> 时才按 start/stop 两两配对（musicpp parser.cpp:753）。
    // Sibelius 等导出全用裸 <extend/>（无 type），此时每个都是独立 melisma 的起点，
    // 不能两两配对（否则线会跨过中间音节连到后一个歌词上）。
    const hasStop = pts.some((p) => p.stop);
    if (hasStop) {
      pts.sort((a, b) => {
        const na = numOf(a.lrc.num);
        const nb = numOf(b.lrc.num);
        if (na !== nb) return na - nb;
        const c = a.tick.compareTo(b.tick);
        if (c !== 0) return c;
        return (a.stop ? 1 : 0) - (b.stop ? 1 : 0);
      });
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const pa = pts[i];
        const pb = pts[i + 1];
        const ext: LrcExtend = this.part.newLrcExtend();
        ext.startNote = pa.note;
        ext.endNote = pb.note;
        ext.startTick = pa.note.chord.tick();
        ext.endTick = pb.note.chord.tick();
        ext.start = pa.lrc;
        ext.stop = pb.lrc;
      }
      return;
    }

    // 裸 extend：melisma 终点 = 同一 verse 的下一个音节起点；但若中途遇到休止符
    // （该声部停唱），melisma 即结束，终点取休止前最后一个续腔音，不得跨过休止连到
    // 休止之后的歌词。先按全局 tick 收集本声部各谱表的全部和弦用于边界扫描。
    const seqByStaff = new Map<number, ChordLayout[]>();
    for (const md of this.part.measures) {
      for (const ch of md.chords) {
        const staff = ch.notes[0]?.staff ?? 0;
        let arr = seqByStaff.get(staff);
        if (!arr) {
          arr = [];
          seqByStaff.set(staff, arr);
        }
        arr.push(ch);
      }
    }
    for (const arr of seqByStaff.values()) {
      arr.sort((a, b) => a.tick().compareTo(b.tick()));
    }

    for (const pt of pts) {
      const list = this.lrcByNum.get(pt.lrc.num) ?? [];
      const idx = list.indexOf(pt.lrc);
      const nextLrc = idx >= 0 ? list[idx + 1] : null;
      const startTick = pt.note.chord.tick();
      const nextTick = nextLrc?.chord ? nextLrc.chord.tick() : null;

      // 扫描本声部（同谱表）起始音之后、下一个音节之前，寻首个休止符。
      const seq = seqByStaff.get(pt.note.staff) ?? [];
      let lastMelisma: NoteLayout | null = null;
      let restBefore = false;
      for (const ch of seq) {
        const t = ch.tick();
        if (t.compareTo(startTick) <= 0) continue;
        if (nextTick && t.compareTo(nextTick) >= 0) break;
        if (ch.rest) {
          restBefore = true;
          break;
        }
        lastMelisma = ch.notes[0] ?? lastMelisma;
      }

      const ext: LrcExtend = this.part.newLrcExtend();
      ext.startNote = pt.note;
      ext.start = pt.lrc;
      ext.startTick = startTick;
      if (restBefore) {
        // 被休止打断：止于休止前最后一个续腔音（其右缘，见 drawLrcExtend）。
        // 若休止紧跟在带 extend 的音之后（无续腔音），则不画。
        if (!lastMelisma) {
          this.part.lrcExtends.pop();
          continue;
        }
        ext.endNote = lastMelisma;
        ext.stop = null;
        ext.endTick = lastMelisma.chord.tick();
      } else if (nextLrc?.chord) {
        ext.endNote = nextLrc.chord.notes[0];
        ext.stop = nextLrc;
        ext.endTick = nextTick!;
      } else {
        // 无续腔音也无下一音节 → 撤销
        this.part.lrcExtends.pop();
      }
    }
  }

  linkLyrics(): void {
    for (const arr of this.lrcByNum.values()) {
      for (let i = 1; i < arr.length; i++) {
        const prev = arr[i - 1];
        const cur = arr[i];
        if (prev.end) continue;
        if (cur.begin) continue;
        prev.next = cur;
        cur.prev = prev;
      }
    }
  }

  /** <direction> 文本（words / dynamics / metronome），对应 musicpp loader.cpp::processDirection。 */
  private processDirection(d: Direction, md: PartMeasureLayout, tick: Fraction): void {
    const blk = md.newText();
    blk.src = d;
    blk.offset = tick;
    blk.staff = (d.staff ?? 1) - 1;
    let hasText = false;
    for (const item of [d as DirectionPart, ...(d.more ?? [])]) {
      switch (item.type) {
        case "words":
          if (this.processWords(blk, item)) hasText = true;
          break;
        case "dynamics":
          if (this.processDynamic(blk, item)) hasText = true;
          break;
        case "metronome":
          if (this.processMetronome(blk, item)) hasText = true;
          break;
        case "segno":
          this.processSegno(blk, false, item.pos);
          hasText = true;
          break;
        case "coda":
          this.processSegno(blk, true, item.pos);
          hasText = true;
          break;
        case "wedge":
          this.collectWedge(item, md, tick, blk.staff);
          break;
        case "pedal":
          this.collectPedal(item, md, tick, blk.staff);
          break;
      }
    }
    // Sibelius 右对齐文本以右边缘为锚点（parser.cpp::parse 尾部 isSib 分支）。
    if (this.score.encoder === Encoder.Sibelius && blk.justify === LCR.Right) {
      blk.x -= blk.width();
    }
    if (!hasText) md.textBlocks.pop();
  }

  /** <wedge>（渐强/渐弱松叶）端点收集，配对在 pairWedges（parser.cpp:1069 processWedge）。 */
  private collectWedge(el: DirectionPart, md: PartMeasureLayout, tick: Fraction, staff: number): void {
    const ty = el.spanType === "stop" ? "stop" : el.spanType === "start" ? el.wedgeType : undefined;
    if (ty !== "crescendo" && ty !== "diminuendo" && ty !== "stop") return;
    this.wedgePts.push({
      mif: md.measureInfo,
      tick: md.measureInfo.offset.plus(tick),
      staff,
      type: ty,
      relX: el.pos?.relativeX ?? null,
      defY: el.pos?.defaultY ?? null,
    });
  }

  /** <pedal>（踏板线）端点收集，配对在 pairPedals（parser.cpp:1150 processPedal）。 */
  private collectPedal(el: DirectionPart, md: PartMeasureLayout, tick: Fraction, staff: number): void {
    // 仅处理 start/stop 配对（sostenuto/change 等不绘制）。
    if (el.spanType !== "start" && el.spanType !== "stop") return;
    const dy = el.pos?.defaultY;
    this.pedalPts.push({
      mif: md.measureInfo,
      tick: md.measureInfo.offset.plus(tick),
      staff,
      line: el.line === true,
      stop: el.spanType === "stop",
      ypos: dy !== undefined ? -dy : 0,
    });
  }

  /** wedge 端点按 staff 配对成 Wedge（parser.cpp:1069）。 */
  private pairWedges(): void {
    const staves = this.part.staves.length;
    for (let s = 0; s < staves; s++) {
      const pts = this.wedgePts.filter((p) => p.staff === s);
      let start: (typeof pts)[number] | null = null;
      for (const p of pts) {
        if (p.type === "stop") {
          if (!start) continue;
          const w = this.part.newWedge();
          w.staff = s;
          w.crescendo = start.type === "crescendo";
          w.startTick = start.tick;
          w.endTick = p.tick;
          w.startMeasure = start.mif;
          w.endMeasure = p.mif;
          if (start.relX !== null) w.dxLeft = start.relX;
          if (p.relX !== null) w.dxRight = p.relX;
          if (start.defY !== null) w.ypos = -start.defY;
          start = null;
        } else {
          start = p;
        }
      }
    }
  }

  /** pedal 端点排序后两两配对成 PedalLine（parser.cpp:1150）。 */
  private pairPedals(): void {
    const pts = [...this.pedalPts].sort((a, b) => {
      if (a.staff !== b.staff) return a.staff - b.staff;
      if (a.line !== b.line) return (a.line ? 1 : 0) - (b.line ? 1 : 0);
      const c = a.tick.compareTo(b.tick);
      if (c !== 0) return c;
      return (a.stop ? 1 : 0) - (b.stop ? 1 : 0);
    });
    for (let i = 1; i < pts.length; ) {
      const prev = pts[i - 1];
      const cur = pts[i];
      if (prev.stop || !cur.stop || prev.line !== cur.line) {
        i++;
        continue;
      }
      const ln = this.part.newPedalLine();
      ln.sign = false;
      ln.line = prev.line;
      ln.startTick = prev.tick;
      ln.startMeasure = prev.mif;
      ln.endMeasure = cur.mif;
      ln.endTick = cur.tick;
      ln.ypos = prev.ypos;
      ln.staff = prev.staff;
      i += 2;
    }
  }

  /** <segno> / <coda> 记号（parser.cpp::processSegno / processCoda）。
   *  x 照 processTextPos：只有 default-x 时是小节内坐标、不加拍位；default-x 与 relative-x 都写了按
   *  MusicXML 的意思相加（歌本改谱脚本把原程序的 `x += n` 写成 relative-x）；只有 relative-x 或都没有才相对拍位。
   *  再 y=45、右移 15。字形照原程序用 Bravura Text（webview 只注册了 Bravura，同一套字形，
   *  Bravura Text 的 segno/coda 是 Bravura 的 0.8 倍：墨高 629/786、844/1056）。 */
  private processSegno(blk: MeasureText, coda: boolean, pos?: { defaultX?: number; relativeX?: number }): void {
    blk.y = 45; // todo: parser.cpp 同样硬编码
    const dx = pos?.defaultX;
    if (dx !== undefined && !blk.data.length) {
      blk.x = dx + (pos?.relativeX ?? 0);
      blk.relative = false;
    } else if (pos?.relativeX !== undefined) blk.x = pos.relativeX;
    blk.x += 15;
    const size = this.score.defaults.musicTextFont.size / this.score.scaling;
    blk.add(coda ? GlyphCodes.coda : GlyphCodes.segno, new Font("Bravura", BRAVURA_TEXT_SCALE * size), true, size);
  }

  /** <words> 文本（如「(副歌)」），对应 loader.cpp::processWords。 */
  private processWords(blk: MeasureText, w: DirectionPart): boolean {
    const dy = w.pos?.defaultY;
    if (dy !== undefined) blk.y = dy;
    const ry = w.pos?.relativeY;
    if (ry !== undefined) blk.y += ry;
    // x 口径同 parser.cpp::processTextPos：有 relative-x 就相对拍位（updateDataXPos 再加拍位 x）；
    // 只有 default-x 就是小节内坐标、不加拍位（Sibelius 写的就是小节内坐标）。
    // 一律加拍位的话，《求主藉异象激动我》的「(副歌)」default-x=-1 会被推到首音上、压住简谱的「5」
    const rx = w.pos?.relativeX;
    const dx = w.pos?.defaultX;
    if (rx !== undefined) blk.x = rx;
    else if (dx !== undefined && !blk.data.length) {
      blk.x = dx;
      blk.relative = false;
    }
    if (w.justify === "right") blk.justify = LCR.Right;
    else if (w.justify === "center") blk.justify = LCR.Center;
    const text = w.text ?? "";
    if (!text) return false;
    blk.add(text, this.makeWordsFont(w.font));
    return true;
  }

  /** <dynamics>（如 <mf/>、<sfz/>），对应 loader.cpp::processDynamic。
   *  标准力度子元素名逐字母转成 Bravura 力度字形。 */
  private processDynamic(blk: MeasureText, dyn: DirectionPart): boolean {
    const dy = dyn.pos?.defaultY;
    if (dy !== undefined) blk.y = dy;
    const rx = dyn.pos?.relativeX;
    if (rx !== undefined) blk.x = rx;
    const font = new Font("Bravura", 16 / this.score.scaling);
    const glyphs = dyn.text ? convertDynamicsStr(dyn.text) : "";
    if (!glyphs) return false;
    blk.add(glyphs, font, true);
    return true;
  }

  /** <metronome>（<beat-unit> + <per-minute>），对应 loader.cpp::processMetronome。 */
  private processMetronome(blk: MeasureText, met: DirectionPart): boolean {
    const dy = met.pos?.defaultY;
    if (dy !== undefined) blk.y = dy;
    const wordFont = this.makeWordsFont(met.font);
    // webview 只注册了 "Bravura" @font-face（styles.css）；"BravuraText" 未注册会回退成
    // 缺字形的方框。Bravura 含同一套 metNote 字形，故用 Bravura。
    const noteFont = new Font("Bravura", wordFont.size);
    let any = false;
    if (met.tempo?.beatUnit !== undefined) {
      blk.add(metNoteGlyph(met.tempo.beatUnit), noteFont, true);
      any = true;
    }
    const pm = met.tempo?.perMinuteText?.trim() ?? (met.tempo?.perMinute !== undefined ? String(met.tempo.perMinute) : undefined);
    if (pm !== undefined) {
      // 「=」左边用不折叠空格：SVG 吞掉文本开头的普通空格（量宽也一样），「♩」与「=」就贴死了；
      // 右边那个在字中间不会被吞，两边于是等宽
      blk.add(any ? "\u00a0= " + pm : "= " + pm, wordFont);
      any = true;
    }
    return any;
  }

  /** MusicXML <words> 字体 → tenths 空间字号（pt / scaling，对齐 loader.cpp::makeFont）。 */
  private makeWordsFont(f: FontSpec | undefined): Font {
    const fam = f?.family ?? "Times New Roman";
    const sz = f?.size !== undefined ? f.size : 16;
    const bold = f?.weight === "bold";
    return new Font(fam, sz / this.score.scaling, bold, f?.style === "italic");
  }

  private processHarmony(src: Harmony, md: PartMeasureLayout, tick: Fraction): void {
    const h = md.newHarmony(src);
    h.offset = tick;
    h.y = src.pos?.defaultY ?? -1;
  }

  private processBarline(b: Barline, mif: MeasureLayout): void {
    const loc = b.location;
    if (b.style) {
      const g = barGlyphFromStyle(b.style);
      if (g !== null) {
        if (loc === "left") mif.leftBarline = g;
        else mif.rightBarline = g;
      }
    }
    if (b.repeat) {
      if (b.repeat === "backward") mif.backward = true;
      else mif.forward = true;
    }
    const ending = b.ending;
    // print-object="no" 的 ending 不参与绘制（parser.cpp::processEnding 1232）；ending 端点按
    // 本声部收集（musicpp 逐声部读 barline），否则全局 MeasureLayout 会让每个声部都画一遍。
    if (ending && ending.printObject !== false) {
      // 房号以元素文本为准、属性兜底（同 score/musicxml.ts parseBarline）：文本才是给人看的
      // 那串「1.2.3.」，number 属性只说这一房适用于第几遍，两者常不一致。
      const text = ending.text ?? "";
      const nums = parseEndingNums(text.match(/\d+/g)?.join(",") ?? ending.numbers.join(","));
      if (nums.size > 0) {
        const ty = ending.type;
        if (loc === "left") {
          if (ty === "start") this.endingPts.push({ mif, nums, text, start: true, stop: false });
        } else {
          if (ty === "stop") this.endingPts.push({ mif, nums, text, start: false, stop: true });
          else if (ty === "discontinue")
            this.endingPts.push({ mif, nums, text, start: false, stop: false });
        }
      }
    }
  }

  /** 本小节各谱表上并存的声部 → 符干方向。同一谱表只有一个声部时不登记（照旧按音高猜）。 */
  private loadVoiceStems(m: Measure): void {
    this.voiceStem.clear();
    const byStaff = new Map<number, Set<number>>();
    for (const el of m.elements) {
      if (el.kind === "chord" && el.grace) continue;
      const staff = el.staff || 1;
      const set = byStaff.get(staff) ?? new Set<number>();
      set.add(el.voice || 1);
      byStaff.set(staff, set);
    }
    for (const [staff, voices] of byStaff) {
      if (voices.size < 2) continue;
      const sorted = [...voices].sort((a, b) => a - b);
      for (const v of sorted) this.voiceStem.set(`${staff}:${v}`, v === sorted[0]);
    }
  }

  /** 无 <beam> 的谱（OMR 生成）：按拍自动把同一声部相邻的短音符（八分及更短）分组成符杠。
   *  仅在整声部无任何 <beam> 时启用；真实制谱谱大多带 <beam>（《恩典大过我罪》TB 部没写，靠逐声部分组不误连）。 */
  private autoBeamPart(): void {
    const one = new Fraction(1);
    const levelsOf = (ch: ChordLayout) => Math.max(0, Math.round(-Math.log2(ch.noteType.toFloat())));
    for (let mi = 0; mi < this.part.measures.length; mi++) {
      const md = this.part.measures[mi];
      if (md.beams.length > 0) continue;
      const mif = this.score.measures[mi];
      const ts = this.part.staves[0]?.getTime(mif.offset);
      // 每拍时值（四分音符单位）：复拍(x/8 且 beats 为 3 的倍数)按附点四分成组，否则按分母音符。
      let beatLen = 1;
      if (ts) beatLen = ts.beatType === 8 && ts.beats % 3 === 0 ? 1.5 : 4 / ts.beatType;
      // 逐声部分组：多声部共用一个谱表时（合唱谱 TB 整部没写 <beam>），同一时刻的两个声部的音不能连成一组
      const voices = new Map<string, ChordLayout[]>();
      for (const c of md.chords) {
        if (c.grace) continue;
        const key = `${c.src.staff}:${c.src.voice}`;
        const list = voices.get(key);
        if (list) list.push(c);
        else voices.set(key, [c]);
      }
      let run: ChordLayout[] = [];
      const flush = () => {
        if (run.length >= 2) {
          const g = new BeamGroup();
          for (let i = 0; i < run.length; i++) {
            const ch = run[i];
            const lv = levelsOf(ch);
            ch.beams = [];
            for (let L = 0; L < lv; L++) {
              const prevHas = i > 0 && levelsOf(run[i - 1]) > L;
              const nextHas = i < run.length - 1 && levelsOf(run[i + 1]) > L;
              ch.beams.push(
                prevHas && nextHas ? BeamVal.Continue
                  : !prevHas && nextHas ? BeamVal.Begin
                  : prevHas && !nextHas ? BeamVal.End
                  : i === 0 ? BeamVal.Forward : BeamVal.Backward,
              );
            }
            g.chords.push(ch);
          }
          // 组是在 layoutNotes 之后才建的：定完方向把二度错位按新方向重排。
          // 方向已按声部定好的（同一谱表并存两个声部）不再按音高统一——那会把两层的符干又并回一个方向。
          if (!run.every((ch) => this.forcedStem.has(ch))) g.unifyStemDir();
          for (const ch of run) {
            for (const nt of ch.notes) nt.flipped = false;
            ch.doubleSide = false;
            ch.autoFlip();
          }
          md.beams.push(g);
        }
        run = [];
      };
      for (const list of voices.values()) {
        const chords = list.sort((a, b) => a.offset.compareTo(b.offset));
        let curBeat = -1;
        for (const ch of chords) {
          if (ch.rest || ch.noteType.compareTo(one) >= 0) { flush(); curBeat = -1; continue; }
          const beat = Math.floor(ch.offset.toFloat() / beatLen + 1e-6);
          if (run.length > 0 && beat !== curBeat) flush();
          run.push(ch);
          curBeat = beat;
        }
        flush();
      }
    }
  }

  /**
   * model.cpp::guessStemDir（musicpp 在 Part::removeNoneMelody 删完非旋律音之后调）：
   * 每个和弦按首音定方向（中线 line=-4 及以上朝下），再把每个符杠组统一——组内（跳过休止与首音正落中线的）
   * 方向不一致或都没有时朝上，一致就取那个方向。只在 `removeNoneMelody` 删完非旋律音后调。
   */
  private guessStemDir(): void {
    for (const md of this.part.measures) {
      for (const ch of md.chords) {
        if (ch.rest || ch.notes.length === 0) continue;
        const first = ch.notes[0]!;
        ch.stemUp = first.line() <= -4;
        this.stemNotes.add(first);
      }
      for (const g of md.beams) {
        const vals = new Set<boolean>();
        for (const ch of g.chords) {
          if (ch.rest || ch.notes.length === 0) continue;
          if (ch.notes[0]!.line() === -4) continue;
          vals.add(ch.stemUp);
        }
        const up = vals.size === 1 ? [...vals][0]! : true;
        for (const ch of g.chords) ch.stemUp = up;
      }
    }
  }

  private calcStemLen(): void {
    // parser.cpp::calcStemLen —— 仅有 <stem> 的音符算符干长；有 default-y 用之（长度量到**和弦尾音**：
    // `fabs(-ch->tailNote()->cy() - stemY)`，Sibelius 只在和弦首音写 <stem>，量到首音会把朝上的符干算长一截），
    // 否则回退 35（grace 乘 cueSize）。无符干（全音符）保持默认 0。
    const cueSize = this.score.options.cueSize;
    for (const nt of this.stemNotes) {
      const ch = nt.chord;
      const sy = this.stemYMap.get(nt);
      if (sy !== undefined) {
        ch.stemLen = Math.abs(-ch.tailNote().cy() - sy);
      } else {
        ch.stemLen = ch.grace ? 35 * cueSize : 35;
      }
    }
  }

  /** 符杠组符干长度/斜率（styler.cpp BeamGroup::format，经 guessStemDir/parser 2911 调用）。
   *  先按 stemUp 差异标记 doubleDir，再 format(0)。跨谱表的 dy 需系统排版后才知，此处用 0；
   *  本工程混排谱的符杠均在单一谱表内，crossStaff() 为假，format 内部也会把 dy 归零。 */
  private formatBeams(): void {
    for (const md of this.part.measures) {
      for (const g of md.beams) {
        g.refresh();
      }
    }
  }

  private processTied(): void {
    // 只记「已被吃掉的 stop」：连续延音链 A(start) → B(stop+start) → C(stop) 里，B 既是前一条的
    // 终点又是后一条的起点，若把起止端点记进同一个 done（原写法），配完 A→B 后 B 的 start 会被跳过，
    // B→C 整条丢失（《那一天正来临》末行）。musicpp parser.cpp:820 的 done 只用于报未配对端点，
    // 不参与筛选；这里保留「一个 stop 只配一次」以免重复配对。
    const usedStops = new Set<NoteLayout>();
    for (const start of this.tieStarts) {
      for (const stop of this.tieStops) {
        if (usedStops.has(stop.note)) continue;
        if (!fEq(stop.endTick, start.endTick)) continue;
        if (stop.pitch !== start.pitch) continue;
        usedStops.add(stop.note);
        const tied = this.part.newTied();
        tied.startNote = start.note;
        tied.endNote = stop.note;
        tied.startTick = start.note.chord.tick();
        tied.endTick = start.endTick;
        break;
      }
    }
  }

  /** 对齐 musicpp parser.cpp::processEnding：收集所有反复记号端点（按绝对 tick），排序后
   *  相邻两两配对。左反复记号（start）在小节起点，右反复记号（stop/discontinue）在小节末端。
   *  此处 mif.offset 已在 PartLoader 主循环里赋为绝对 tick，可直接取用。 */
  private processEnding(): void {
    type EndingPt = { tick: Fraction; mif: MeasureLayout; nums: Set<number>; text: string; stop: boolean };
    const pts: EndingPt[] = this.endingPts.map((p) => ({
      tick: p.start ? p.mif.offset : p.mif.endTick(),
      mif: p.mif,
      nums: p.nums,
      text: p.text,
      stop: p.stop,
    }));
    pts.sort((a, b) => a.tick.compareTo(b.tick));
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const a = pts[i];
      const b = pts[i + 1];
      const end = this.part.newEnding();
      end.startTick = a.tick;
      end.endTick = b.tick;
      end.startMeasure = a.mif;
      end.endMeasure = b.mif;
      end.number = a.text || [...a.nums].sort((x, y) => x - y).join(",");
      end.hasStop = b.stop;
    }
  }}

// ---------------- 版面输入与声部分组（ScoreDoc → layoutpass） ----------------

function printInput(p: NonNullable<Measure["print"]>): PrintInput {
  const sl = p.systemLayout;
  return {
    newPage: p.newPage === true,
    newSystem: p.newSystem === true,
    systemLayout: sl
      ? {
          margins:
            sl.leftMargin !== undefined || sl.rightMargin !== undefined
              ? { left: sl.leftMargin ?? null, right: sl.rightMargin ?? null }
              : null,
          topSystemDistance: sl.topSystemDistance ?? null,
          systemDistance: sl.systemDistance ?? null,
        }
      : null,
    staffLayouts: (p.staffLayouts ?? []).map((s) => ({ number: s.staff ?? 1, staffDistance: s.staffDistance ?? null })),
  };
}

function layoutInputOf(song: Song): LayoutInput {
  return song.parts.map((part) =>
    part.measures.map((m) => ({
      prints: m.print ? [printInput(m.print)] : [],
      staffDetails: [m.attrs, ...(m.laterAttrs ?? []).map((la) => la.attrs)].flatMap((a) => a?.staffDetails ?? []).map((d) => ({
        number: d.staff ?? 1,
        printObject: d.printObject === undefined ? null : d.printObject ? "yes" : "no",
      })),
    })),
  );
}

/** 声部分组。DOM 那条路按 `<part-list>` 子元素次序建：组在它的 `start` 处建、组外的声部各自成一组；
 *  `ScoreDoc` 只存组与组内声部，这里按「组在它的首个声部之前」还原那个次序。 */
function partGroupsOf(score: StaffLayout, song: Song): PartGroup[] {
  const docGroups = song.partGroups ?? [];
  const made = new Map<(typeof docGroups)[number], PartGroup>();
  const groups: PartGroup[] = [];
  const make = (g: (typeof docGroups)[number]): PartGroup => {
    const pg = new PartGroup();
    pg.number = g.number;
    if (g.symbol === "brace") pg.symbol = GroupSymbol.Brace;
    else if (g.symbol === "bracket") pg.symbol = GroupSymbol.Bracket;
    pg.barline = g.groupBarline === true;
    made.set(g, pg);
    groups.push(pg);
    return pg;
  };
  song.parts.forEach((part, i) => {
    const pp = score.parts[i];
    for (const g of docGroups) if (!made.has(g) && g.parts[0] === part.id) make(g);
    const active = docGroups.filter((g) => g.parts.includes(part.id));
    if (active.length === 0) {
      const g = new PartGroup();
      g.parts.push(pp);
      groups.push(g);
    } else {
      for (const g of active) (made.get(g) ?? make(g)).parts.push(pp);
    }
  });
  for (const g of docGroups) if (!made.has(g)) make(g);
  for (const g of groups) {
    if (g.parts.length === 1 && g.parts[0].staves.length > 1) g.barline = true;
  }
  return groups;
}

// ---------------- 入口 ----------------

/**
 * `ScoreDoc`（MusicXML 形状）→ `StaffLayout`。只取第一首。
 * 调用方给好 `MixedOptions`（含已加载的 MetaData）。
 */
export function layoutStaff(doc: ScoreDoc, options: MixedOptions): StaffLayout {
  const song = doc.songs[0];
  if (!song) throw new Error("这份文档里没有曲子");
  const score = new StaffLayout(options, song);

  const def = song.defaults;
  if (def?.scaling && def.scaling.millimeters > 0 && def.scaling.tenths > 0) {
    score.scaling = (def.scaling.millimeters * 72) / 25.4 / def.scaling.tenths;
  }
  if (def) {
    const pl = def.pageLayout;
    if (pl) {
      if (pl.pageWidth !== undefined) score.defaults.pageWidth = pl.pageWidth;
      if (pl.pageHeight !== undefined) score.defaults.pageHeight = pl.pageHeight;
      for (const mg of pl.margins ?? []) {
        if (mg.oddEven === "even") continue;
        score.defaults.leftMargin = mg.left;
        score.defaults.rightMargin = mg.right;
        score.defaults.topMargin = mg.top;
        score.defaults.bottomMargin = mg.bottom;
      }
    }
    const ptToTenths = (pt: number) => pt / score.scaling;
    if (def.lyricFont) {
      const family = def.lyricFont.family ?? score.defaults.lyricFont.family;
      const sz = def.lyricFont.size || score.defaults.lyricFont.size;
      score.defaults.lyricFont = new Font(family, ptToTenths(sz));
    }
    // parser.cpp 取 <music-font font-size> 当 musicTextFont 的字号（pt，不按 scaling 折算——用时再除）
    if (def.musicFont?.size) score.defaults.musicTextFont = new Font(score.defaults.musicTextFont.family, def.musicFont.size);
    if (def.wordFont) {
      const family = def.wordFont.family ?? score.defaults.wordFont.family;
      const sz = def.wordFont.size || score.defaults.wordFont.size;
      score.defaults.wordFont = new Font(family, ptToTenths(sz));
    }
  }
  // 谱里没写纸，或用户在设置里明确换了纸：用编辑器设置那张（长图不分页，页高由内容定）
  const page = options.page;
  const overridePage = !!page?.override && !!def?.pageLayout;
  if (page && (!def?.pageLayout || overridePage)) {
    score.defaults.pageWidth = page.widthPt / score.scaling;
    // 长图先按 √2 比例给个名义页高（标题 credit 的 y 从页底量，得有个有限值），装页后由 painter 换成内容高
    score.defaults.pageHeight = (page.heightPt ?? page.widthPt * Math.SQRT2) / score.scaling;
    score.longImage = page.heightPt === null;
    if (page.marginsPt?.length === 4) {
      const [t, r, b, l] = page.marginsPt.map((v) => v / score.scaling);
      score.defaults.topMargin = t!;
      score.defaults.rightMargin = r!;
      score.defaults.bottomMargin = b!;
      score.defaults.leftMargin = l!;
    }
  }

  for (const c of song.credits ?? []) {
    score.credits.push({
      page: (c.page ?? 1) - 1,
      text: c.text.trim(),
      type: c.type?.trim() ?? null,
      x: c.x ?? 0,
      y: c.y ?? 0,
      justify: c.justify === "right" ? LCR.Right : c.justify === "center" ? LCR.Center : LCR.Left,
      fontSize: c.fontSize || 0,
    });
  }

  // 换了纸，谱里按原纸算好的版面坐标就对不上了：整份按新纸自动铺排
  score.autoLayout = overridePage || !hasEmbeddedLayout(song);

  const numMeasures = song.parts[0]?.measures.length ?? 0;
  for (let i = 0; i < numMeasures; i++) {
    const mif = new MeasureLayout();
    mif.index = i;
    score.measures.push(mif);
  }

  for (const src of song.parts) {
    const part = new PartLayout();
    part.score = score;
    part.pid = src.id;
    score.parts.push(part);
  }

  song.parts.forEach((src, i) => {
    const pl = new DocPartLoader(score.parts[i], score, src, song.marks);
    pl.load();
    pl.linkLyrics();
  });

  finishMixedScore(score, layoutInputOf(song), partGroupsOf(score, song));
  return score;
}
