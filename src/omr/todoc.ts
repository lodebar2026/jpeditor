// 识别结果 → `ScoreDoc`（**简谱形状**，与 `j123/parse.ts` 的产物同口径：度数、48 分时值、增时线、减时线）。
//
// 识别出来的本来就是简谱：数字、八度点、减时线、增时线。以前先拼成 MusicXML 再读回来、由
// `model/jianpuproject.ts` 猜回简谱形状——绝对音高、divisions、`<type>` 转一圈，附点加增时线（2.5 拍）这种
// `<type>` 表达不了的时值就丢了半拍；速度、副标题、段落词、歌词段号在 MusicXML 读回那一步也全丢。
// 现在直出模型：123 核对文本 = `emit123(本文件产物)`，要 MusicXML 就走唯一写出端 `model/toxml.ts`（经 `xmlproject.ts` 投影）。
//
// **无 DOM 依赖**（Node CLI 要 import 它）。
import { SIMPLE_DIVISIONS as Q, type Barline, type Chord, type ElementId, type Harmony, type Mark, type Measure, type Note, type ScoreDoc, type Song, type Sustain } from "../model/doc";
import { IdGen, emptyDoc } from "../model/helpers";
import { creatorOf } from "../model/metakeys";
import { duration123 } from "../abcfamily/parsedialect";
import { jpPitch } from "../score/jppitch";
import type { RecognizedScore, JpNum, StaffRow } from "./types";
import { rright, RHYTHM_DIGIT } from "./types";

/** 一行切出来的一个小节：音符，以及它右边界那根线的 x（行末开口收尾时为 null）。 */
interface RowMeasure { notes: JpNum[]; rightX: number | null }

// 把一行按小节线 x 切成小节。
function measuresOfRow(row: StaffRow): RowMeasure[] {
  if (!row.barlineXs.length) return [{ notes: row.nums, rightX: null }];
  const measures: RowMeasure[] = [];
  let cur: JpNum[] = [];
  let bi = 0;
  for (const n of row.nums) {
    while (bi < row.barlineXs.length && n.bbox.x > row.barlineXs[bi]!) {
      measures.push({ notes: cur, rightX: row.barlineXs[bi]! }); cur = []; bi++;
    }
    cur.push(n);
  }
  // 行末剩下的线（若最后一个音符右侧还有线）里取最后一根：那才是本行末小节的右界。
  measures.push({ notes: cur, rightX: bi < row.barlineXs.length ? row.barlineXs[row.barlineXs.length - 1]! : null });
  // 空小节（复纵线/终止线并排两根之间切出来的）不成节，但它的右界要**顺延给前一个小节**——
  // 否则小节右界停在左边那根上，认不出复纵线（doubleBarXs 记的是右边那根）。
  const out: RowMeasure[] = [];
  for (const m of measures) {
    if (m.notes.length) out.push(m);
    else if (out.length && m.rightX !== null) out[out.length - 1]!.rightX = m.rightX;
  }
  return out;
}

// 一行是否以小节线收尾（最后一个音符右侧仍有小节线）。否→末小节是"开口"的，
// 即该小节跨行延续到下一行行首（弱起/续句），换行处图上本就没有小节线，不可补。
function rowEndsClosed(row: StaffRow): boolean {
  if (!row.nums.length || !row.barlineXs.length) return false;
  const lastRight = rright(row.nums[row.nums.length - 1].bbox);
  return Math.max(...row.barlineXs) >= lastRight;
}

/** 弧线配对结果：slur 的 number（嵌套双弧时一个音符可收/起多条，故是数组），
 *  以及配上对、可以输出的 tie 端点。 */
interface ArcPairs {
  slur: Map<JpNum, { starts: number[]; stops: number[] }>;
  tie: Map<JpNum, { start?: boolean; stop?: boolean }>;
}

/**
 * 全曲把 slur/tie 配成对。
 *
 * 识别难免出错：《主祢真伟大》识别出的 slur 虽然 start/stop 各 5 个，配对却错位（嵌套到深度 2
 * 且最后剩一个没闭合）——一条弧的 stop 被算给了错误的 start，就画出一条横跨很远的
 * 弧线。所以这里：栈式配对（后开先闭）、给 slur 编 `number`、**配不上对的一律剔除**。
 *
 * tie 还多一条：延音线两端音高必须相同。识别把两端读成不同音时那不是延音线，
 * 硬输出只会得到一条莫名其妙的长弧，剔除。
 */
function pairArcs(notes: JpNum[], fifths: number): ArcPairs {
  const slur = new Map<JpNum, { starts: number[]; stops: number[] }>();
  const tie = new Map<JpNum, { start?: boolean; stop?: boolean }>();
  const slot = <T>(m: Map<JpNum, T>, n: JpNum, init: T): T => {
    const v = m.get(n) ?? init;
    m.set(n, v);
    return v;
  };
  const keyOf = (n: JpNum) => {
    if (n.digit === 0) return "rest";
    if (n.digit === RHYTHM_DIGIT) return "rhythm";
    const p = jpPitch(n.digit, n.octave, fifths);
    return `${p.step}${p.alter}${p.octave}`;
  };
  let dropped = 0;
  // [number, 起始音符, 这条弧是否已作废]
  const openSlur: Array<[number, JpNum, boolean]> = [];
  const openTie: JpNum[] = [];
  // 起点作废：把它那条 number 从起点音符的 starts 里摘掉（一个音符可能起了不止一条）。
  const dropSlurStart = (n: JpNum, k: number) => {
    const s = slur.get(n);
    if (s) s.starts = s.starts.filter((v) => v !== k);
  };
  for (const n of notes) {
    // 嵌套双弧（外弧罩三音、内弧只罩后两音）在末音上同时收两条，故按条数循环。
    for (let c = 0; c < (n.slurStop ?? 0); c++) {
      const top = openSlur.pop();
      // 端点落在休止符上的圆滑线是**识别错误**（弧线本该连到旁边的音符），整条作废——
      // 只丢一端会剩半条弧，一路拖到下一条 slur 那里去。
      // 注：人工写的谱里 slur 连休止符是合法的，只有识别这一路做这个剔除。
      if (!top) dropped++;
      else if (top[2] || n.digit === 0) { dropSlurStart(top[1], top[0]); dropped++; }
      else slot(slur, n, { starts: [], stops: [] }).stops.push(top[0]);
    }
    for (let o = 0; o < (n.slurStart ?? 0); o++) {
      const used = new Set(openSlur.map(([k]) => k));
      let k = 1;
      while (used.has(k)) k++;
      openSlur.push([k, n, n.digit === 0]);
      slot(slur, n, { starts: [], stops: [] }).starts.push(k);
    }
    if (n.tieStop) {
      const from = openTie.pop();
      // 两端音高必须相同，且都不能是休止符（延音线连到休止符没有意义）。
      if (from && n.digit !== 0 && n.digit !== RHYTHM_DIGIT && keyOf(from) === keyOf(n)) {
        slot(tie, n, {}).stop = true;
      } else {
        if (from) { const s = tie.get(from); if (s) delete s.start; } // 音高不符：两端一起剔除
        dropped++;
      }
    }
    if (n.tieStart && n.digit !== 0 && n.digit !== RHYTHM_DIGIT) { openTie.push(n); slot(tie, n, {}).start = true; }
    else if (n.tieStart) dropped++;
  }
  for (const [k, n] of openSlur) { dropSlurStart(n, k); dropped++; }
  for (const n of openTie) { const s = tie.get(n); if (s) delete s.start; dropped++; }
  if (dropped) console.warn(`OMR→ScoreDoc：剔除了 ${dropped} 个配不上对的 slur/tie 记号`);
  return { slur, tie };
}

/** 跳转记号 → 小节线上的记号原名（`xmlproject.ts::directionOf` 认的那几个，导出 MusicXML 时落成 `<direction>`+`<sound>`）。 */
/** 倚音底下的减时线条数 → 符号时值 */
const GRACE_TYPE: Readonly<Record<number, Chord["duration"]["type"]>> = { 1: "eighth", 2: "16th", 3: "32nd" };

const JUMP_ORNAMENT: Record<string, string> = {
  "D.C.": "dc",
  "D.S.": "ds",
  "Fine": "fine",
  "To Coda": "ty",
};

const chordSymbol = (text: string): Harmony => ({ root: { step: "C", alter: 0 }, kind: "", text });

/**
 * 和弦落点。识别给的是「本音符时值内的比例」：主和弦 `chordOffset`、长音上逐拍换的 `extraChords`。
 * 简谱侧只有两个位置可挂：音符本身、它的某条增时线（`Sustain.harmony`）。
 * - 正落在第 k 条增时线那一拍上 → 挂那条增时线；
 * - 落不到整拍上的：音符本身还空着就挂音符（位置提前了，但和弦还在谱上），否则留在 `laterHarmonies`（123 写不出）。
 * 长音里的后续和弦印在增时线上方，必落在**整拍**上：先量化到拍，免得插值出的 1.89 拍哪条增时线都挂不上。
 */
function placeChords(n: JpNum, ch: Chord, fullDivisions: number): void {
  if (!n.chord) return;
  const sustains = ch.sustains ?? [];
  const body = (ch.duration.divisions - sustains.length * Q) / Q; // 本体时值（拍）
  const all = [
    { text: n.chord, offset: Math.round((n.chordOffset ?? 0) * fullDivisions) },
    ...(n.extraChords ?? []).map((c) => ({
      text: c.tok,
      offset: Math.max(0, Math.min(Math.round(c.offset * fullDivisions / Q) * Q, fullDivisions - 1)),
    })),
  ];
  const later: typeof all = [];
  for (const h of all) {
    if (h.offset <= 0 && !ch.harmony) { ch.harmony = chordSymbol(h.text); continue; }
    const at = h.offset / Q;
    const k = Math.round(at - body);
    const su = sustains[k];
    if (Math.abs(at - body - k) < 1e-6 && su && !su.harmony) su.harmony = chordSymbol(h.text);
    else later.push(h);
  }
  if (!ch.harmony && later.length) ch.harmony = chordSymbol(later.shift()!.text);
  if (later.length) ch.laterHarmonies = later.map((h) => chordSymbol(h.text));
}

/** @param numOf 可选：记下每个和弦来自哪个识别符号（小节时值自检要按源图坐标标出问题小节，`omr/beats.ts`） */
export function recognizedToDoc(score: RecognizedScore, numOf?: Map<ElementId, JpNum>): ScoreDoc {
  const ids = new IdGen();
  // 遵照图片小节线：行末无小节线时（开口收尾），本行末小节与下一行行首小节实为同一跨行小节，合并，
  // 不在换行处凭空补小节线。行末有小节线（如终止线）才各自成节。
  // 记录每个 row 在 allMeasures 中「干净起始」的小节下标（>0 才记），供换行（`Print.newSystem`）
  // 恢复原图分行。若本行首小节被并入上一行的跨行小节（open-tail），则视觉行首落在小节内部，
  // 无法在小节边界干净断行 → 不记（与「开口不补小节线」一致）。
  const allMeasures: JpNum[][] = [];
  const rowStartIdx = new Set<number>();
  const endStyleIdx = new Set<number>();   // 右边界是终止线（‖）的小节
  const doubleIdx = new Set<number>();     // 右边界是复纵线（细细双线 ‖）的小节
  // 行首段号（`1.`）挂到该行每段第一个有词的音符上（`Lyric.verseLabel`）
  const labelOf = new Map<JpNum, string[]>();
  let openTail = false;
  for (const row of score.rows) {
    if (row.lyricLabels?.length) {
      row.lyricLabels.forEach((label, v) => {
        const first = row.nums.find((n) => n.lyrics?.[v]);
        if (label && first) (labelOf.get(first) ?? labelOf.set(first, []).get(first)!)[v] = label;
      });
    }
    const ms = measuresOfRow(row);
    if (!ms.length) continue;
    const doubleXs = new Set(row.doubleBarXs ?? []);
    const markDouble = (m: RowMeasure, idx: number) => {
      if (m.rightX !== null && doubleXs.has(m.rightX)) doubleIdx.add(idx);
    };
    if (openTail && allMeasures.length) {
      const first = ms.shift()!;
      allMeasures[allMeasures.length - 1].push(...first.notes);
      markDouble(first, allMeasures.length - 1);
    } else if (allMeasures.length) rowStartIdx.add(allMeasures.length);
    for (const m of ms) { allMeasures.push(m.notes); markDouble(m, allMeasures.length - 1); }
    if (row.finalBarline === "end") endStyleIdx.add(allMeasures.length - 1);
    openTail = !rowEndsClosed(row);
  }

  // 弧线配对要按**谱面顺序**在全曲范围内做（跨小节的弧才配得上）。
  const arcs = pairArcs(allMeasures.flat(), score.fifths);
  const marks: Mark[] = [];
  const openSlurs = new Map<number, number>(); // slur number → 起点元素 id
  const openTies: number[] = [];
  let tupletStart: number | null = null;

  let curBeats = score.beats, curBeatType = score.beatType;
  const measures: Measure[] = allMeasures.map((notes, idx) => {
    const m: Measure = { number: String(idx + 1), elements: [] };
    if (rowStartIdx.has(idx)) m.print = { newSystem: true };
    // 曲中转拍号：识别时锚在该小节头一个音符上（JpNum.timeChange），提升为本小节的 `attrs.time`。
    const change = notes.find((n) => n.timeChange)?.timeChange;
    if (change && idx > 0 && (change.beats !== curBeats || change.beatType !== curBeatType)) {
      curBeats = change.beats; curBeatType = change.beatType;
      m.attrs = { time: { beats: curBeats, beatType: curBeatType } };
    }

    for (const n of notes) {
      // 倚音：主音符左上角的小号数字，不占拍位，排在它修饰的那个音符**之前**。
      // 简谱的小音符一律带斜杠符干（acciaccatura）。
      for (const g of n.grace ?? []) {
        m.elements.push({
          kind: "chord", id: ids.next(),
          notes: [{ degree: { number: g.digit, octaveShift: g.octave } }],
          duration: { divisions: 0, dots: 0, ...(GRACE_TYPE[g.div] ? { type: GRACE_TYPE[g.div] } : {}) },
          grace: { slash: true }, voice: 1, staff: 1,
        });
      }

      const rest = n.digit === 0;
      // 简谱的长休止写成几个 0，不写增时线
      const sustainCount = rest ? 0 : n.augment;
      const ch: Chord = {
        kind: "chord", id: ids.next(), notes: [],
        duration: duration123(n.div, n.dot > 0 ? 1 : 0, sustainCount),
        voice: 1, staff: 1,
      };
      numOf?.set(ch.id, n);
      if (rest) ch.rest = {};
      else if (n.digit === RHYTHM_DIGIT) ch.rhythm = true;
      else {
        // 临时升降号只记谱面上印的；按简谱规矩在小节内延续由读端（`model/jianpu.ts::AccidentalCarry`）管。
        const note: Note = { degree: { number: n.digit, octaveShift: n.octave } };
        if (n.accidental) { note.degree!.accidental = n.accidental; note.accidental = n.accidental; }
        ch.notes.push(note);
      }
      if (n.div > 0) ch.beams = Array.from({ length: n.div }, () => "continue" as const);
      if (sustainCount) ch.sustains = Array.from({ length: sustainCount }, (): Sustain => ({ id: ids.next() }));

      // 多连音：组里每个音符都带同一份比例，首尾另记一条 `tuplet` Mark。时值记名义值（同 123 解析端）。
      const t = n.tuplet;
      if (t) {
        ch.duration.timeMod = { actual: t.actual, normal: t.normal };
        if (t.start) tupletStart = ch.id;
        if (t.stop && tupletStart !== null) {
          marks.push({ type: "tuplet", start: tupletStart, end: ch.id, tupletActual: t.actual, tupletNormal: t.normal });
          tupletStart = null;
        }
      }

      placeChords(n, ch, t ? Math.round(ch.duration.divisions * t.normal / t.actual) : ch.duration.divisions);

      const notations: NonNullable<Chord["notations"]> = {};
      if (n.fermata) notations.fermata = true;
      // 顿音 ▼ = staccato（与文本谱 `&dy` 同一口径）、重音 > = accent（`&zy`）；上波音 ∿ = inverted-mordent（123 写回 `!sby!`），
      // 带竖杠的下波音 = mordent（`!xby!`）。
      if (n.articulation) notations.articulations = [n.articulation];
      if (n.ornament === "upper-mordent") notations.ornaments = ["inverted-mordent"];
      else if (n.ornament === "lower-mordent") notations.ornaments = ["mordent"];
      if (Object.keys(notations).length) ch.notations = notations;

      // 段落标记（Intro/Verse/Chorus/Coda…，谱面上多印成方框）→ 段落词
      if (n.sectionMark) ch.sectionWord = n.sectionMark;

      // 歌词：按 verse 索引，逐字挂音符
      if (n.lyrics) {
        const labels = labelOf.get(n);
        const lyrics = n.lyrics.flatMap((text, v) => {
          if (!text) return [];
          const l: NonNullable<Chord["lyrics"]>[number] = { number: v + 1, text, syllabic: "single" };
          if (labels?.[v]) l.verseLabel = labels[v];
          return [l];
        });
        if (lyrics.length) ch.lyrics = lyrics;
      }

      // 弧线：slur 按 number 配对，tie 两端音高已在 pairArcs 里验过（延音线同时记在音上与 Mark 上，同 xmlproject 的口径）
      const sl = arcs.slur.get(n);
      for (const k of sl?.stops ?? []) {
        const start = openSlurs.get(k);
        if (start !== undefined) { marks.push({ type: "slur", number: k, start, end: ch.id }); openSlurs.delete(k); }
      }
      for (const k of sl?.starts ?? []) openSlurs.set(k, ch.id);
      const ti = arcs.tie.get(n);
      if (ti?.stop && ch.notes[0]) {
        const start = openTies.pop();
        if (start !== undefined) marks.push({ type: "tied", start, end: ch.id });
        ch.notes[0].tie = { ...(ch.notes[0].tie ?? {}), stop: true };
      }
      if (ti?.start && ch.notes[0]) {
        openTies.push(ch.id);
        ch.notes[0].tie = { ...(ch.notes[0].tie ?? {}), start: true };
      }

      m.elements.push(ch);
      // 长休止：增时线换成几个一拍的 0
      if (rest) {
        for (let k = 0; k < n.augment; k++) {
          m.elements.push({ kind: "chord", id: ids.next(), notes: [], rest: {}, duration: { divisions: Q, dots: 0 }, voice: 1, staff: 1 });
        }
      }
    }

    // 反复与一/二房：识别阶段锚到边界相邻音符，这里提升成小节左右线。
    const barlines: Barline[] = [];
    const endingStart = notes.find((n) => n.endingStart !== undefined)?.endingStart;
    const repeatForward = notes.some((n) => n.repeatForward);
    // segno 是跳转的**目标**（D.S. 跳回来落在这条线上），故挂左线；图上它印在本小节起头的上方。
    const segno = notes.some((n) => n.segno);
    if (endingStart !== undefined || repeatForward || segno) {
      const b: Barline = { location: "left" };
      if (repeatForward) { b.style = "heavy-light"; b.repeat = "forward"; }
      if (endingStart !== undefined) b.ending = endingOf(endingStart, "start");
      if (segno) b.ornaments = [{ name: "hs", level: 0 }];
      barlines.push(b);
    }
    const endingStop = [...notes].reverse().find((n) => n.endingStop !== undefined)?.endingStop;
    const repeatBackward = notes.some((n) => n.repeatBackward);
    const jump = notes.find((n) => n.jumpMark)?.jumpMark;
    // 普通小节线也要显式写出：`.jpwabc` 写出端按右线出 `|`，没有就把相邻小节并成一个。
    // 曲末那小节图上没收线的不补（遵图片小节线）。
    const closed = idx < allMeasures.length - 1 || !openTail;
    if (endingStop !== undefined || repeatBackward || endStyleIdx.has(idx) || jump || closed) {
      const b: Barline = { location: "right" };
      // 反复线与终止线不叠（终止线由 StaffRow.finalBarline 另管）
      if (repeatBackward) { b.style = "light-heavy"; b.repeat = "backward"; }
      else if (endingStop === undefined && endStyleIdx.has(idx)) b.style = "light-heavy";
      // 复纵线与房尾**可以同时出现**（76《天上有粮》一房末就是 `[1 … ||`，图上没画反复冒号），
      // 故不像终止线那样给 endingStop 让位。
      else if (doubleIdx.has(idx)) b.style = "light-light";
      else if (closed) b.style = "regular";
      if (endingStop !== undefined) b.ending = endingOf(endingStop, "stop");
      // 跳转记号（D.C./D.S./Fine/To Coda）：识别时锚在本小节某音符上，记在小节末
      if (jump) {
        const name = JUMP_ORNAMENT[jump];
        if (name) b.ornaments = [{ name, level: 0 }];
        else b.annotation = jump;
      }
      barlines.push(b);
    }
    if (barlines.length) m.barlines = barlines;
    return m;
  });

  const title = score.title;
  const song: Song = {
    work: { subtitles: score.subtitle ? [score.subtitle] : [] },
    key: { fifths: score.fifths },
    time: { beats: score.beats, beatType: score.beatType },
    parts: [{ id: "P1", measures }],
    marks,
  };
  if (title !== undefined) song.work.title = title;
  if (score.number) song.work.number = score.number;
  // 页眉并排印着的其余拍号（混合拍）与拍号后面那段说明文字（「混合拍」）
  if (score.meters && score.meters.length > 1) {
    song.extraTimes = score.meters.slice(1).map((mt) => ({ beats: mt.beats, beatType: mt.beatType }));
  }
  if (score.meterNote) song.timeNote = score.meterNote;
  // 著作者整行（作词：…/作曲：…）：按行首标签定类型，没有标签的记 composer
  const creators = (score.credits ?? [])
    .map((c) => c.replace(/\n/g, " ").trim())
    .filter((c) => c && c !== title?.trim())
    .map(creatorOf);
  if (creators.length) song.identification = { creators };
  if (score.tempo) song.tempos = [score.tempo];
  if (score.tempo && score.tempoBeat) song.tempoBeat = score.tempoBeat;

  const doc = emptyDoc("omr");
  doc.songs.push(song);
  return doc;
}

/** 房号原文 "1,2,3,5" → `Ending` */
function endingOf(text: string, type: "start" | "stop"): NonNullable<Barline["ending"]> {
  const numbers = text.split(/[,，.\s]+/).map(Number).filter((v) => Number.isFinite(v) && v > 0);
  return { numbers, text, type };
}
