// `Score` → `ScoreDoc`：把 `.jpwabc` 与 MusicXML 来源的谱迁进 123。
//
// **过渡件**：R2 收尾后排版直接吃 `ScoreDoc`、`Score` 退役，这个文件随之删除。
//
// ## 已知有损（源头就没有，不是这里丢的）
//
// `Score` 装不下**和弦符号、力度、渐强渐弱、多声部并排**（568 份 MusicXML 100% 含
// `<harmony>`、共 12646 个，全在 `loadMusicXml` → `Score` 那一步丢掉）。所以从 `Score`
// 转出来的 `ScoreDoc` 里这些字段如实为空——**迁移报表要把它记成「降级表达」而不是规范缺口**。
//
// ## `.Repeat` 怎么来
//
// 演唱顺序表在 `.jpwabc` 的 `.Repeat` 段里，而 `Score` 只留下推导结果（`playData`）。
// 要无损就得把 `RepeatSection` 的原文一起传进来（`options.repeatRows`）。
//
// ## 导出 MusicXML 用（`options.forMusicXml`）
//
// `.jpwabc` 导出 MusicXML 也走这里再进唯一写出端（`toxml.ts`）。这时要把 `Score` 里迁移用不上、
// MusicXML 却要的东西一并带上：`playData` 的速度/跳转/段落标记、由 `.Repeat` 反推的房号、
// 按调号拼好的绝对音高、符杠分组、连音比例。迁移（`emit123`）不开这个选项，报表口径不变。
// 这些换算原在 `score/musicxmlout.ts`（已并入唯一写出端后删除），判据原样搬来。

import type { Measure as JpMeasure, Note as JpNote, Part as JpPart, Score } from "../score/score";
import { Chord as JpChord, BarlineEntry, JumpSpec, LineBreak, MusicCommon, PlaySpecKind } from "../score/score";
import { Fraction } from "../common/fraction";
import { jpPitch } from "../score/jppitch";
import type {
  Barline,
  BeamVal,
  Chord,
  Direction,
  Lyric,
  Mark,
  Measure,
  Part,
  ScoreDoc,
  Song,
  Sustain,
} from "./doc";
import { IdGen, breaksAfterToStart, emptyDoc, emptySong } from "./helpers";
import { accidentalOf, convertRepeat, durationOf } from "./fromjpw";
import type { BreakKind } from "./helpers";

const DIVISIONS = 48;

function barlineOf(m: JpMeasure, side: "left" | "right"): Barline | null {
  const style = side === "left" ? m.leftBarline : m.barline;
  const repeat = side === "left" ? m.repeatForward : m.repeatBackward;
  const ending = side === "left" ? m.endingLeft : m.endingRight;
  if (style === null && !repeat && !ending) return null;
  const b: Barline = { location: side };
  if (style !== null) b.style = String(style) as Barline["style"];
  if (repeat) b.repeat = side === "left" ? "forward" : "backward";
  if (m.endingNum && m.endingNum.size) {
    const numbers = [...m.endingNum];
    const ending = {
      numbers,
      // 房号**原文**要留住：语料里有 "1, 2" 带逗号这种写法，排版照原文画
      text: m.endingText ?? numbers.join("."),
      type: (side === "left" ? "start" : "stop") as "start" | "stop",
    };
    if (side === "left" && m.endingLeft) b.ending = ending;
    if (side === "right" && m.endingRight) b.ending = ending;
  }
  return b;
}

/** `forMusicXml` 时按全曲算一次的东西 */
interface XmlCtx {
  /** 全曲调号（`.jpwabc` 来源要推断，见 `deriveFifths`） */
  fifths: number;
  /** `Score` 里是否带了调号（MusicXML 来源），带了就照抄 `Measure.key` */
  hasKey: boolean;
  beams: Map<JpChord, Map<number, BeamVal>>;
  voltas: Map<number, Volta>;
  /** `Score` 小节序号 → 该小节起点处的 direction（速度、跳转、段落标记） */
  events: Map<number, Direction[]>;
}

function convertPart(jp: JpPart, index: number, ids: IdGen, marks: Mark[], xml?: XmlCtx): Part {
  const part: Part = { id: `P${index + 1}`, measures: [] };
  let prevKeyFifths: number | null = null;
  let prevTime = "";
  /** `LineBreak` 记在哪一小节**之后**，建完再翻成模型口径（`doc.ts::Print`） */
  const breakAfterOf = new Map<Measure, BreakKind>();
  /** 开着的弧线：`Chord.slurStart` 记起、`slurEnds` 是**计数**（嵌套双弧在末音同时收两条）。
   *  跨小节的弧线常见，所以按声部而不是按小节记 */
  const openSlurs: number[] = [];

  for (const [mid, jm] of jp.measures.entries()) {
    let mea: Measure = { number: String(part.measures.length + 1), elements: [] };
    /** 这个 `Score` 小节落成了哪几个模型小节（小节线会再切） */
    const touched: Measure[] = [mea];
    // 调号/拍号：只在变化处写 attrs（与 MusicXML 的口径一致）
    const fifths = jm.key.fifths;
    const timeKey = `${jm.time.beats}/${jm.time.beatType}`;
    if (prevKeyFifths === null || jm.keyChange || fifths !== prevKeyFifths) {
      mea.attrs = { ...(mea.attrs ?? {}), key: { fifths: xml && !xml.hasKey ? xml.fifths : fifths } };
    }
    if (prevTime === "" || jm.timeChange || timeKey !== prevTime) {
      mea.attrs = { ...(mea.attrs ?? {}), time: { beats: jm.time.beats, beatType: jm.time.beatType } };
    }
    prevKeyFifths = fifths;
    prevTime = timeKey;

    // MusicXML 的 `<print new-system/new-page>` 落在 `Measure.newSystem/newPage` 上
    // （`.jpwabc` 那一路是独立的 `LineBreak` entry，见下面的循环）。
    // **500 首 100% 的曲目都有 new-system**，原样排版全靠它，不能漏。
    if (jm.newPage) mea.print = { newPage: true };
    else if (jm.newSystem) mea.print = { newSystem: true };

    const left = barlineOf(jm, "left");
    if (left) (mea.barlines ??= []).push(left);
    if (xml) {
      const dirs = [...(jm.sectionMark ? [{ type: "rehearsal", placement: "above", text: jm.sectionMark } as Direction] : []),
        ...(xml.events.get(mid) ?? [])];
      if (dirs.length) mea.directions = dirs;
    }

    /** 开着的三连音起点 id */
    let openTuplet: number | null = null;

    for (const ent of jm.entries) {
      if (ent instanceof LineBreak) {
        // `$` 的语义是「**这一小节之后**换行」。小节线通常先到、新小节还空着，
        // 这时要挂到刚收尾的那一个——挂在空小节上会随它一起被丢掉（与 `j123/parse.ts` 同口径）。
        const target = mea.elements.length > 0
          ? mea
          : part.measures[part.measures.length - 1] ?? mea;
        breakAfterOf.set(target, ent.newPage ? "page" : "system");
        continue;
      }
      if (ent instanceof BarlineEntry) {
        // **每根小节线都是小节分隔**——与 `j123/parse.ts` 的规则一致（有元素时遇线即收尾）。
        // `jpwimport` 允许一个 Measure 里放多根线（`:| |: |` 连写），照搬过来两侧对
        // 「哪根是右线」的判断就会不同，往返永远不幂等。这里按通行语义重新切。
        const b: Barline = { location: "right" };
        if (ent.style !== null && ent.style !== undefined) b.style = String(ent.style) as Barline["style"];
        if (ent.repeat) b.repeat = ent.repeat;
        if (mea.elements.length === 0) {
          // 还没有音符：这根属于下一小节的左线（`|:|` 连写、行首线）。
          // MusicXML 来源的左线已由 `Measure.leftBarline` 记过一次（导入端另 push 了这个 entry），并进去不重复
          const left = (mea.barlines ?? []).find((x) => x.location === "left");
          if (left) {
            left.style ??= b.style;
            left.repeat ??= b.repeat;
          } else {
            (mea.barlines ??= []).push({ ...b, location: "left" });
          }
        } else {
          (mea.barlines ??= []).push(b);
          part.measures.push(mea);
          mea = { number: String(part.measures.length + 1), elements: [] };
          touched.push(mea);
        }
        continue;
      }
      if (!(ent instanceof JpChord)) continue;
      const jc = ent;
      const ch: Chord = {
        kind: "chord",
        id: ids.next(),
        notes: [],
        // `Chord.beats` 是**总拍数**（`jpwimport.ts:50` 初值 1，每个 `-` 再 ++），
        // 所以增时线条数 = beats - 1
        duration: durationOf(jc.beams, jc.dot, Math.max(0, jc.beats - 1)),
        voice: Math.max(1, jc.voice), // `.jpwabc` 来源从 0 起、MusicXML 来源从 1 起
        staff: 1,
      };
      if (jc.rest) ch.rest = {};
      for (const nt of jc.notes) {
        const num = Number(nt.number);
        if (!Number.isFinite(num) || num === 0) continue;
        const acc = accidentalOf(nt.jpAlter);
        ch.notes.push({
          degree: { number: num, octaveShift: nt.jpOctave, ...(acc ? { accidental: acc } : {}) },
          pitch: xml
            ? jpSpelling(nt, xml.fifths) as Chord["notes"][number]["pitch"]
            : nt.step.trim() ? { step: nt.step as "C", alter: nt.alter, octave: nt.octave } : undefined,
          ...(nt.tieStart || nt.tieEnd ? { tie: { ...(nt.tieStart ? { start: true } : {}), ...(nt.tieEnd ? { stop: true } : {}) } } : {}),
        } as Chord["notes"][number]);
      }
      if (xml) {
        // 符杠按排版的拍内分组算好；连音比例由实际时值与名义时值之比得出（divisions 仍记名义时值）
        const bm = xml.beams.get(jc);
        if (bm) ch.beams = [...bm.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        const nominal = new Fraction(ch.duration.divisions, DIVISIONS);
        if (jc.duration && jc.duration.numerator > 0) {
          const r = nominal.div(jc.duration);
          if (!r.equals(1)) ch.duration.timeMod = { actual: r.numerator, normal: r.denominator };
        }
      } else if (jc.beams > 0) {
        ch.beams = Array.from({ length: jc.beams }, () => "continue" as BeamVal);
      }
      // 增时线：模型里是可挂载的独立对象（和弦能挂在增时线上）
      for (let k = 0; k < jc.beats - 1; k++) {
        const su: Sustain = { id: ids.next() };
        (ch.sustains ??= []).push(su);
      }
      if (jc.fermata || jc.articulations.length) {
        ch.notations = {
          ...(jc.fermata ? { fermata: true } : {}),
          ...(jc.articulations.length ? { articulations: [...jc.articulations] } : {}),
        };
      }
      if (jc.harmony) ch.harmony = { root: { step: "C", alter: 0 }, kind: "", text: jc.harmony };
      if (jc.sectionWord) ch.sectionWord = jc.sectionWord;
      // 倚音：`Score` 挂在 Chord 上，模型里是独立的 grace 元素、排在主音符之前
      for (const g of jc.graceNotes) {
        const num = Number(g.number);
        mea.elements.push({
          kind: "chord",
          id: ids.next(),
          notes: [{ degree: { number: Number.isFinite(num) && num > 0 ? num : 1, octaveShift: g.jpOctave } }],
          duration: { divisions: 0, dots: 0 },
          grace: {},
          voice: Math.max(1, jc.voice), // `.jpwabc` 来源从 0 起、MusicXML 来源从 1 起
          staff: 1,
        });
      }
      // 歌词
      for (const nt of jc.notes) {
        for (const lr of nt.lyrics) {
          const l: Lyric = { number: lr.number, text: lr.text };
          // `W1-6:`（一行词供多段共用）在 `Score` 里是 `refrain` 标记，段号上界丢了。
          // 还原成段号区间：上界由全曲段数补（调用方在最后回填，见 `fillRefrainRange`）
          if (lr.refrain) l.refrain = true;
          (ch.lyrics ??= []).push(l);
        }
      }
      mea.elements.push(ch);

      // 先收后起（同 `jpwimport` / `ParserTemp.pairSlur`）：同一音符「收上一条、再起下一条」时，
      // 先起会把自己弹出来，造出起止同音的弧、前一条错配到后面去（037《我尊崇祢》等 21 份）
      for (let k = 0; k < jc.slurEnds; k++) {
        const start = openSlurs.pop();
        if (start !== undefined) marks.push({ type: "slur", start, end: ch.id, level: openSlurs.length });
      }
      if (jc.slurStart) openSlurs.push(ch.id);
      // 三连音：`Score` 把标记放在 Note 上（tupletBegin / tupletEnd）
      if (jc.notes.some((n) => n.tupletBegin)) openTuplet = ch.id;
      if (openTuplet !== null && jc.notes.some((n) => n.tupletEnd)) {
        const t = jc.notes.find((n) => n.tuplet)?.tuplet as { actual?: number; normal?: number } | null | undefined;
        marks.push({
          type: "tuplet",
          start: openTuplet,
          end: ch.id,
          tupletActual: t?.actual ?? 3,
          tupletNormal: t?.normal ?? 2,
        });
        openTuplet = null;
      }
    }

    if (xml) applyVolta(xml.voltas.get(mid), touched.filter((m) => m.elements.length > 0));

    // Measure 级的右线：MusicXML 那一路的小节线与反复记在 `Measure.barline` /
    // `repeatBackward` 上，没有 `BarlineEntry`，所以这里要补；`.jpwabc` 那一路已经由
    // entries 切过小节，只需把房号补上。
    const right = barlineOf(jm, "right");
    if (right) {
      const target = mea.elements.length ? mea : part.measures[part.measures.length - 1];
      if (target) {
        const rb = (target.barlines ?? []).find((x) => x.location === "right");
        if (rb) {
          if (right.ending) rb.ending = right.ending;
          if (right.repeat && !rb.repeat) rb.repeat = right.repeat;
        } else {
          (target.barlines ??= []).push(right);
        }
      }
    }
    // `Score` 的小节是真小节（MusicXML 那一路没有 BarlineEntry）：导出时补一根普通右线，
    // 否则投影层会把它当成「行尾没写小节线、跨行接着写」的半个小节并掉
    if (xml && mea.elements.length && !mea.barlines?.some((b) => b.location === "right")) {
      (mea.barlines ??= []).push({ location: "right", style: "regular" });
    }
    if (mea.elements.length || mea.barlines?.length) part.measures.push(mea);
  }
  // **空小节并入下一小节的左线**：`.jpwabc` 允许两根小节线连写（`|:|`），
  // `jpwimport` 会为此造出一个没有音符的 Measure。而 123 的读入规则是
  // 「小节里还没有元素时，小节线算**左线**」，所以空小节读回时不会重现——
  // 留着它就永远不幂等。它携带的线并到后一小节前面即可。
  const merged: Measure[] = [];
  let carry: Barline[] = [];
  let carryPrint: Measure["print"];
  const carryDirs: Direction[] = [];
  for (const m of part.measures) {
    if (m.elements.length === 0) {
      for (const b of m.barlines ?? []) carry.push({ ...b, location: "left" });
      // 空小节**之后**的换行（`LineBreak`）挂到**前一个**小节——跟着空小节一起丢掉的话，
      // 往返时换行位置会漂一格
      const after = breakAfterOf.get(m);
      if (after && merged.length) {
        const prev = merged[merged.length - 1]!;
        if (breakAfterOf.get(prev) !== "page") breakAfterOf.set(prev, after);
      }
      // 空小节**起**的新系统（MusicXML 的 `<print>`）顺延给下一个小节
      if (m.print) carryPrint = { ...(carryPrint ?? {}), ...m.print };
      if (m.directions) carryDirs.push(...m.directions);
      continue;
    }
    if (carry.length) {
      m.barlines = [...carry, ...(m.barlines ?? [])];
      carry = [];
    }
    if (carryPrint) {
      m.print = { ...carryPrint, ...(m.print ?? {}) };
      carryPrint = undefined;
    }
    if (carryDirs.length) m.directions = [...carryDirs.splice(0), ...(m.directions ?? [])];
    merged.push(m);
  }
  // 末尾残留的空小节线挂回最后一个小节的右侧
  if (carry.length && merged.length) {
    const last = merged[merged.length - 1]!;
    last.barlines = [...(last.barlines ?? []), ...carry.map((b) => ({ ...b, location: "right" as const }))];
  }
  part.measures = merged;
  breaksAfterToStart(part, breakAfterOf);
  for (let i = 0; i < part.measures.length; i++) part.measures[i]!.number = String(i + 1);
  return part;
}

/** 把 `refrain` 标记还原成段号区间（`w1-N:`）。`Score` 只留「这行是副歌」，上界得靠全曲段数推。 */
function fillRefrainRange(song: Song): void {
  let maxVerse = 1;
  for (const part of song.parts) {
    for (const mea of part.measures) {
      for (const el of mea.elements) {
        for (const l of el.lyrics ?? []) maxVerse = Math.max(maxVerse, l.numberTo ?? l.number);
      }
    }
  }
  if (maxVerse <= 1) return;
  for (const part of song.parts) {
    for (const mea of part.measures) {
      for (const el of mea.elements) {
        for (const l of el.lyrics ?? []) {
          if (l.refrain && l.numberTo === undefined) l.numberTo = maxVerse;
        }
      }
    }
  }
}

export interface FromScoreOptions {
  /** `.jpwabc` 的 `.Repeat` 段原文行。不给就没有 `playOrder`——`Score` 只留推导结果，原文在 `JpwFile` 里 */
  repeatRows?: readonly string[];
  /** 曲号（`Score` 没有这个字段） */
  songNumber?: string;
  sourceFormat?: ScoreDoc["sourceFormat"];
  /** 导出 MusicXML 用：带上速度、跳转、房号、绝对音高、符杠、连音比例（见文件头） */
  forMusicXml?: boolean;
}

/** `Score` → `ScoreDoc`。 */
export function scoreToScoreDoc(score: Score, options: FromScoreOptions = {}): ScoreDoc {
  const doc = emptyDoc(options.sourceFormat ?? "jpwabc");
  const ids = new IdGen();
  const song: Song = emptySong();
  if (options.songNumber !== undefined) song.work.number = options.songNumber;
  if (score.title) song.work.title = score.title;
  const creators: { type: string; text: string }[] = [];
  if (score.lyricist) creators.push({ type: "lyricist", text: score.lyricist });
  if (score.composer) creators.push({ type: "composer", text: score.composer });
  for (const [type, text] of score.creator ?? new Map<string, string>()) {
    if (text && !creators.some((c) => c.text === text)) creators.push({ type, text });
  }
  if (creators.length) song.identification = { creators };
  const xml = options.forMusicXml ? xmlCtxOf(score) : undefined;
  if (xml) {
    song.credits = score.credit.filter((c) => c.text).map((c) => ({
      ...(c.type ? { type: c.type } : {}), text: c.text, page: c.page + 1,
    }));
    if (score.playData.tempo > 0) song.tempos = [score.playData.tempo];
  } else if (score.credit?.length) {
    song.credits = score.credit.filter((c) => c.text).map((c) => ({ ...(c.type ? { type: c.type } : {}), text: c.text }));
  }
  // `.jpwabc` 的词曲（`WordsByAndMusicBy`）只进了 `Score.credit`，没有 creator：非标题的 credit 当作者行，123 才写得出 `C:`
  if (!song.identification?.creators.length) {
    const byline = score.credit.filter((c) => c.text && c.type !== "title" && c.type !== "subtitle" && c.text !== score.title);
    if (byline.length) {
      song.identification = { creators: byline.map((c) => ({ type: c.type ?? "composer", text: c.text.replace(/\n/g, " ") })) };
    }
  }

  const m0 = score.parts[0]?.measures[0];
  if (m0) {
    song.key = { fifths: xml && !xml.hasKey ? xml.fifths : m0.key.fifths };
    song.time = { beats: m0.time.beats, beatType: m0.time.beatType };
  }

  const marks: Mark[] = [];
  song.parts = score.parts.map((p, i) => convertPart(p, i, ids, marks, i === 0 ? xml : xml && { ...xml, voltas: new Map(), events: new Map() }));
  song.marks = marks;
  fillRefrainRange(song);
  if (options.repeatRows?.length) {
    const play = convertRepeat(options.repeatRows, song.parts[0]);
    if (play.length) song.playOrder = play;
  }
  doc.songs.push(song);
  return doc;
}

// ───────────────────────── 导出 MusicXML 用的换算（`forMusicXml`） ─────────────────────────

function xmlCtxOf(score: Score): XmlCtx {
  // keyChange 只有 MusicXML 导入路径会置 true；`.jpwabc` 路径永不置，那时才需要推断
  const hasKey = score.parts.some((p) => p.measures.some((m) => m.keyChange));
  const fifths = hasKey ? (score.parts[0]?.measures[0]?.key.fifths ?? 0) : deriveFifths(score);
  return { fifths, hasKey, beams: collectBeams(score), voltas: deriveVoltas(score), events: collectEvents(score) };
}

const PITCH_MAP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 从 MIDI pitch + 音名字母反推 {step, alter, octave}。取使 |alter| 最小的八度。 */
function spellPitch(pitch: number, step: string): { step: string; alter: number; octave: number } {
  const base = PITCH_MAP[step] ?? 0;
  const octave = Math.round((pitch - base) / 12) - 1;
  return { step, alter: pitch - (octave + 1) * 12 - base, octave };
}

/** 音符相对**调号**的额外升降（= 临时记号量）。不能读 `jpAlter`：那只标在记号出现的那个音上，
 *  同小节后续同音级由 `AccidentalStat` 延续。改按音高差算：pitch − 该数字在本调的自然音高。 */
function accidentalOffset(nt: JpNote, fifths: number): number {
  if (nt.rest || nt.number === "0") return 0;
  const natural = MusicCommon.getBasePitch(MusicCommon.keys[fifths + 7]!) +
    12 * nt.jpOctave + MusicCommon.stepToPitch(nt.number);
  return nt.pitch - natural;
}

/** 音符的五线谱拼写。走简谱表述（数字 + 八度点 + 调号）而不是按 pitch：
 *  `.jpwabc` 来源的 pitch 基准是 `getBasePitch`，直接按 pitch 定八度会差 12。 */
function jpSpelling(nt: JpNote, fifths: number): { step: string; alter: number; octave: number } {
  const digit = nt.number.charCodeAt(0) - "0".charCodeAt(0);
  if (!(digit >= 1 && digit <= 7)) return spellPitch(nt.pitch, nt.step);
  const p = jpPitch(digit, nt.jpOctave, fifths);
  return { ...p, alter: p.alter + accidentalOffset(nt, fifths) };
}

function modeOf(values: number[]): number | null {
  if (!values.length) return null;
  const cnt = new Map<number, number>();
  for (const v of values) cnt.set(v, (cnt.get(v) ?? 0) + 1);
  let best = values[0]!, bestN = 0;
  for (const [v, n] of cnt) if (n > bestN) { best = v; bestN = n; }
  return best;
}

/** 按简谱表述反推全曲调号。`jpwimport` 从不给 `Measure.key` 赋值（调号只活在 JpState 里），
 *  照抄 `m.key.fifths` 会把 1=bB 导成 C 调 + 满谱临时记号。 */
function deriveFifths(score: Score): number {
  const bases: number[] = [];
  const letters: number[] = [];
  for (const part of score.parts) {
    for (const m of part.measures) {
      for (const e of m.entries) {
        if (!(e instanceof JpChord)) continue;
        for (const nt of e.notes) {
          if (nt.rest || nt.number === "0" || nt.jpAlter !== " ") continue;
          const digit = nt.number.charCodeAt(0) - "1".charCodeAt(0);
          if (digit < 0 || digit > 6) continue;
          bases.push(nt.pitch - 12 * nt.jpOctave - MusicCommon.stepToPitch(nt.number));
          const li = MusicCommon.steps.indexOf(nt.step);
          if (li >= 0) letters.push(((li - digit) % 7 + 7) % 7);
        }
      }
    }
  }
  const base = modeOf(bases);
  const letter = modeOf(letters);
  if (base === null || letter === null) return 0;
  for (let f = -7; f <= 7; f++) {
    const name = MusicCommon.keys[f + 7]!;
    if (MusicCommon.getBasePitch(name) !== base) continue;
    // 字母不可省：#F 与 bG 的 basePitch 都是 66，只有拼写字母能分开
    if (MusicCommon.steps.indexOf(name[name.length - 1]!) !== letter) continue;
    return f;
  }
  return 0;
}

/**
 * 每个和弦各层符杠的连接状态。简谱的减时线就是五线谱的符杠：分组复用 `Measure.autoBeamGroup()`
 * （排版引擎用的就是它），导出与屏幕上看到的分组天然一致。
 *
 * 逐层在组内找连续段：长度 ≥2 → begin/continue/end；更高层只有一个音 → hook。
 * 休止符没有符干挂不了符杠，段内只有实音符承载（五线谱 beam over rest 的写法）。
 */
function collectBeams(score: Score): Map<JpChord, Map<number, BeamVal>> {
  const out = new Map<JpChord, Map<number, BeamVal>>();
  for (const part of score.parts) {
    for (const m of part.measures) {
      for (const g of m.autoBeamGroup()) {
        const chords = g.chords;
        if (chords.length < 2) continue;
        const maxLevel = Math.max(...chords.map((c) => c.beams));
        for (let level = 1; level <= maxLevel; level++) {
          let i = 0;
          while (i < chords.length) {
            if (chords[i]!.beams < level) { i++; continue; }
            let j = i;
            while (j + 1 < chords.length && chords[j + 1]!.beams >= level) j++;
            const solid: JpChord[] = [];
            for (let k = i; k <= j; k++) if (!chords[k]!.rest) solid.push(chords[k]!);
            const put = (ch: JpChord, st: BeamVal): void => {
              const mm = out.get(ch) ?? new Map<number, BeamVal>();
              mm.set(level, st);
              out.set(ch, mm);
            };
            if (solid.length >= 2) {
              put(solid[0]!, "begin");
              for (let k = 1; k < solid.length - 1; k++) put(solid[k]!, "continue");
              put(solid[solid.length - 1]!, "end");
            } else if (solid.length === 1 && level > 1) {
              put(solid[0]!, i > 0 ? "backward hook" : "forward hook");
            }
            i = j + 1;
          }
        }
      }
    }
  }
  return out;
}

export interface Volta {
  /** 本小节是某一房的开头，值为该房辖的遍数（"1,2,3"） */
  start?: string;
  /** 本小节是某一房的结尾 */
  stop?: boolean;
  /** 本小节末尾要补一个反复回头（除最后一房外，每房唱完都要回到 `|:`） */
  repeatBack?: boolean;
}

const setKey = (s: Set<number>): string => [...s].sort((a, b) => a - b).join(",");

/**
 * 从 `.Repeat` 的演唱顺序反推房号。
 *
 *  1. 算出每个小节被哪几遍唱到，按「连续且遍集合相同」切成段；
 *  2. 找**分岔点**：某段的遍集合是前一段的真子集，说明反复体在这里分头；
 *  3. 从分岔点往后连续收段，直到各段遍集合的并集**恰好等于**分岔前的全集——这一组段就是各房。
 *     并集对不上（或只有一段）就放弃：那不是房，只是「某一遍唱得短一点」。
 *
 * 判据在《沧海一声笑》上推出 `1,2,3,5` / `4` / `6`，与 OMR 从原图识别出的房号一致；
 * 《因有主同在》的 `1-28V1 / 1-8V2` 则正确地不成房。
 */
export function deriveVoltas(score: Score): Map<number, Volta> {
  const out = new Map<number, Volta>();
  const part = score.parts[0];
  const items = score.playData.measures;
  if (!part || items.length === 0) return out;
  // MusicXML 来源的 Score 已经带房号，不要再叠加推断
  if (part.measures.some((m) => m.endingLeft || m.endingRight)) return out;

  const passesOf = new Map<number, Set<number>>();
  const allPasses = new Set<number>();
  for (const it of items) {
    allPasses.add(it.pass);
    for (let mid = it.mid; mid < it.end; mid++) {
      const s = passesOf.get(mid) ?? new Set<number>();
      s.add(it.pass);
      passesOf.set(mid, s);
    }
  }
  if (allPasses.size < 2) return out;

  const segs: Array<{ from: number; to: number; passes: Set<number> }> = [];
  for (const mid of [...passesOf.keys()].sort((a, b) => a - b)) {
    const p = passesOf.get(mid)!;
    const last = segs[segs.length - 1];
    if (last && last.to + 1 === mid && setKey(last.passes) === setKey(p)) last.to = mid;
    else segs.push({ from: mid, to: mid, passes: p });
  }

  const isSubset = (a: Set<number>, b: Set<number>): boolean =>
    a.size < b.size && [...a].every((v) => b.has(v));

  for (let i = 0; i < segs.length - 1; i++) {
    if (!isSubset(segs[i + 1]!.passes, segs[i]!.passes)) continue;
    const target = segs[i]!.passes;
    const group: typeof segs = [];
    const acc = new Set<number>();
    for (let j = i + 1; j < segs.length; j++) {
      if ([...segs[j]!.passes].some((v) => acc.has(v))) break; // 遍次重叠：不是并列的房
      for (const v of segs[j]!.passes) acc.add(v);
      group.push(segs[j]!);
      if (setKey(acc) === setKey(target)) break;
    }
    if (group.length < 2 || setKey(acc) !== setKey(target)) continue;
    group.forEach((g, k) => {
      const head = out.get(g.from) ?? {};
      head.start = setKey(g.passes);
      out.set(g.from, head);
      const tail = out.get(g.to) ?? {};
      tail.stop = true;
      if (k < group.length - 1) tail.repeatBack = true;
      out.set(g.to, tail);
    });
    i = segs.indexOf(group[group.length - 1]!);
  }
  return out;
}

/** 反推出的房号落到模型小节上：起点挂左线、终点挂右线（非最后一房补反复回头）。 */
function applyVolta(v: Volta | undefined, measures: Measure[]): void {
  if (!v || !measures.length) return;
  if (v.start !== undefined) {
    const numbers = v.start.split(",").map(Number);
    const first = measures[0]!;
    const left = (first.barlines ?? []).find((b) => b.location === "left");
    const ending = { numbers, type: "start" as const, text: v.start };
    if (left) left.ending = ending;
    else (first.barlines ??= []).unshift({ location: "left", ending });
  }
  if (v.stop) {
    const last = measures[measures.length - 1]!;
    let right = (last.barlines ?? []).find((b) => b.location === "right");
    if (!right) (last.barlines ??= []).push((right = { location: "right" }));
    const nums = v.start ?? "";
    right.ending = { numbers: nums ? nums.split(",").map(Number) : [], type: "stop", text: nums };
    if (v.repeatBack) {
      right.repeat = "backward";
      right.style ??= "light-heavy";
    }
  }
}

const JUMP_WORDS: Record<PlaySpecKind, string> = {
  [PlaySpecKind.Dacapo]: "D.C.",
  [PlaySpecKind.Fine]: "Fine",
  [PlaySpecKind.DalSegno]: "D.S.",
  // 词面 "To Coda" 会被导入端当成段落标记，故这一种只写 `<sound>`
  [PlaySpecKind.ToCoda]: "",
};

/** `playData` 的 coda/segno/jumpTo → 按 `Score` 小节归拢的 direction（offset 以 48 分计）。 */
function collectEvents(score: Score): Map<number, Direction[]> {
  const out = new Map<number, Direction[]>();
  const push = (mid: number, offset: Fraction, d: Direction): void => {
    const at = Math.round(offset.numerator * DIVISIONS / offset.denominator);
    if (at > 0) d.offset = at;
    const arr = out.get(mid) ?? [];
    arr.push(d);
    out.set(mid, arr);
  };
  for (const [k, t] of score.playData.coda) push(t.mid, t.offset, { type: "coda", placement: "above", sound: { coda: k } });
  for (const [k, t] of score.playData.segno) push(t.mid, t.offset, { type: "segno", placement: "above", sound: { segno: k } });
  for (const [t, spec] of score.playData.jumpTo) {
    const js = spec as JumpSpec;
    const v = String(js.value ?? 1);
    const sound: NonNullable<Direction["sound"]> =
      js.kind === PlaySpecKind.Dacapo ? { dacapo: true }
        : js.kind === PlaySpecKind.Fine ? { fine: true }
          : js.kind === PlaySpecKind.DalSegno ? { dalsegno: v } : { tocoda: v };
    push(t.mid, t.offset, { type: "words", placement: "above", text: JUMP_WORDS[js.kind], sound });
  }
  return out;
}
