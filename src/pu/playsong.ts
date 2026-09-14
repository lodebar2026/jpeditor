// 简谱形状的 `ScoreDoc`（文本谱 / 123 / ABC / `.jpwabc`）→ 演唱顺序、试听输入、`.jpwabc` 写出端输入。
//
// 与 `model/playdoc.ts`（MusicXML 形状）分工同断句那一对（`phrasesong.ts` / `phrasedoc.ts`），
// 小节序列与断句共用 `phrasesong.ts::buildMeasures`。**口径同简谱引擎输入 `jianpuinput.ts::jianpuInputOfDoc`**：
//   - 每个有曲行的声部都算一份（歌词段数取各声部最大值），反复与跳转只看第一份；
//     `forExpanded` 时带歌词的声部排第一、同号歌词顺延（同 `ToScoreOptions.forExpanded`）
//   - 跳转记号换算同 `applyJumps`；推不出来（抛错）才退回整曲按段数逐遍
// 另有两条只归 `.jpwabc` 的：
//   - 文档自带演唱顺序（`Song.playOrder`，`.Repeat` 段）→ 照它排，不推
//   - `.jpwabc` 没有 `.Repeat` → 不推，整曲按段数逐遍（JP-Word 本来就这么唱）

import type { ElementId, PlayPass, ScoreDoc } from "../model/doc";
import { Fraction } from "../common/fraction";
import {
  JumpSpec, PlayData, PlaySpecKind, RepeatSpecItem, TimePosition,
  playOrderByVerses, playOrderFromSpec, playOrderOf,
} from "../score/playorder";
import { linesOfVoice, voiceNumbers, type PuSong } from "./ast";
import { Key, MusicCommon } from "../score/jppitch";
import type { PlaySource } from "../score/timeline";
import type { JpwChordIn, JpwMeasureIn, JpwScoreIn } from "../model/tojpw";
import { buildMeasures, type JumpOut, type MeasureOut } from "./phrasesong";
import { docView } from "./slots";

export interface PlaySongOptions {
  /** 见 `ToScoreOptions.forExpanded` */
  forExpanded?: boolean;
}

/** 演唱顺序（`measures` / `isSimpple` / `hasRepeat` 与跳转表；速度不在这里）。这首没有曲行时返回 null。 */
export function playDataOfSong(doc: ScoreDoc, songIdx = 0, options: PlaySongOptions = {}): PlayData | null {
  const built = songMeasures(doc, songIdx, options, false);
  return built && playDataOf(doc, songIdx, built);
}

/** 试听/MIDI 的输入（`score/timeline.ts::PlaySource`）：各声部小节序列 + 演唱顺序 + 速度，和弦带元素 id。
 *  口径同 `jianpuInputOfDoc`（声部顺序；音高换算 `applyJpPitch`、速度取 `meta.tempos` 首个 20..400 的数）。 */
export function playSourceOfSong(doc: ScoreDoc, songIdx = 0, options: PlaySongOptions = {}): PlaySource | null {
  const built = songMeasures(doc, songIdx, options, true);
  if (!built) return null;
  const playData = playDataOf(doc, songIdx, built);
  for (const tempo of built.song.metadata.tempos) {
    if (typeof tempo === "number" && tempo >= 20 && tempo <= 400) {
      playData.tempo = tempo;
      break;
    }
  }
  return { parts: built.parts.map((measures) => ({ measures })), playData };
}

interface SongMeasures {
  song: PuSong;
  key: Key;
  time: { beats: number; beatType: number };
  voices: number[];
  parts: MeasureOut[][];
  jumps: JumpOut[];
  idToChord: Map<ElementId, { measure: number; index: number }>;
}

function songMeasures(doc: ScoreDoc, songIdx: number, options: PlaySongOptions, withPitch: boolean): SongMeasures | null {
  const view = docView(doc);
  const song = view.songs[songIdx];
  if (!song) return null;
  let voices = voiceNumbers(song);
  if (options.forExpanded) {
    const lead = voices.find((v) => linesOfVoice(song, v).some((l) => l.lyrics.length > 0));
    if (lead !== undefined) voices = [lead, ...voices.filter((v) => v !== lead)];
  }
  // 调号/拍号同 `songToScore`：全曲一个，取头部
  const meta = song.metadata;
  const meter = meta.meters[0];
  const time = meter ? { beats: meter.numerator, beatType: meter.denominator } : { beats: 4, beatType: 4 };
  const key = new Key();
  // 调名缺省时取模型的 fifths：`.jpwabc` 来源只记 fifths、不记调名拼写（`.Title` 的调号）
  const fifths = doc.songs[songIdx]!.key?.fifths;
  key.fifths = meta.mode === undefined && fifths !== undefined ? fifths : MusicCommon.keyNameToFifth(meta.mode ?? "C");
  const parts: MeasureOut[][] = [];
  let jumps: JumpOut[] = [];
  const idToChord = new Map<ElementId, { measure: number; index: number }>();
  for (const v of voices) {
    const lines = linesOfVoice(song, v);
    if (lines.length === 0) continue;
    const first = parts.length === 0;
    const pitch = withPitch
      ? { key: { basePitch: MusicCommon.getBasePitchOfKey(key), fifths: key.fifths, alter: {} }, time }
      : undefined;
    const built = buildMeasures(lines, (ch, el) => {
      const id = view.idOf.get(el);
      if (id !== undefined) ch.id = id;
    }, !!options.forExpanded, pitch);
    if (first) {
      jumps = built.jumps;
      built.measures.forEach((m, measure) => m.entries.forEach((ch, index) => {
        if (ch.id !== undefined) idToChord.set(ch.id, { measure, index });
      }));
    }
    parts.push(built.measures);
  }
  if (parts.length === 0) return null;
  return { song, key, time, voices, parts, jumps, idToChord };
}

function playDataOf(doc: ScoreDoc, songIdx: number, { song, voices, parts, jumps, idToChord }: SongMeasures): PlayData {
  const main = parts[0]!;
  const pd = new PlayData();
  const docSong = doc.songs[songIdx]!;
  if (docSong.playOrder?.length) {
    pd.measures = playOrderFromSpec({ items: docSong.playOrder.map((p) => specItem(p, idToChord)) }, { measures: main });
    return pd;
  }
  // 段数 = 主旋律歌词最多的那一行的段号上限（`.jpwabc` 即 `.Words` 各段的遍数上限）
  let passes = 0;
  for (const line of linesOfVoice(song, voices[0]!)) {
    for (const l of line.lyrics) passes = Math.max(passes, l.verseTo);
  }
  if (doc.sourceFormat === "jpwabc") {
    pd.measures = playOrderByVerses(main.length, passes);
    pd.isSimpple = true;
    return pd;
  }

  applyJumps(pd, main, jumps);
  try {
    const order = playOrderOf(parts.map((measures) => ({ measures })), pd);
    pd.isSimpple = order.isSimple;
    pd.hasRepeat = order.hasRepeat;
    pd.measures = order.measures;
    if (pd.measures.length > 0) return pd;
  } catch (e) {
    console.warn("文本谱反复推理失败，按段数逐遍", e);
  }
  pd.measures = playOrderByVerses(main.length, Math.max(1, passes));
  pd.isSimpple = true;
  return pd;
}

/** `PlayPass` → `.Repeat` 的一条（小节 1 基 → 0 基；接入/收尾的元素 id → 小节内和弦序号）。 */
function specItem(p: PlayPass, idToChord: ReadonlyMap<ElementId, { measure: number; index: number }>): RepeatSpecItem {
  const from = p.fromElement !== undefined ? idToChord.get(p.fromElement) : undefined;
  const to = p.toElement !== undefined ? idToChord.get(p.toElement) : undefined;
  return new RepeatSpecItem(
    p.fromMeasure - 1,
    p.toMeasure - 1,
    p.verse ?? 0,
    from ? from.index : 0,
    p.pageBreakAfter ?? false,
    to ? to.index + 1 : -1,
  );
}

/** 跳转记号 → 演唱顺序的跳转表。 */
function applyJumps(pd: PlayData, measures: readonly MeasureOut[], jumps: readonly JumpOut[]): void {
  const count = measures.length;
  const end = (mid: number): TimePosition => new TimePosition(mid, measures[mid]!.duration);
  const target = (j: JumpOut): TimePosition =>
    j.onBarline && j.measure + 1 < count
      ? new TimePosition(j.measure + 1, new Fraction(0))
      : new TimePosition(j.measure, new Fraction(0));
  const codas = jumps.filter((j) => j.name === "ty");
  for (const j of jumps) {
    switch (j.name) {
      case "dc":
        pd.jumpTo.set(end(j.measure), new JumpSpec(PlaySpecKind.Dacapo));
        break;
      case "fine":
        pd.jumpTo.set(end(j.measure), new JumpSpec(PlaySpecKind.Fine));
        break;
      case "ds": {
        const s = new JumpSpec(PlaySpecKind.DalSegno);
        s.value = "1";
        pd.jumpTo.set(end(j.measure), s);
        break;
      }
      case "hs":
        pd.segno.set("1", target(j));
        break;
      case "ty":
        // 两处尾声记号：前一处是 To Coda，后一处是尾声的起点；只有一处就只当起点
        if (codas.length >= 2 && j === codas[0]) {
          const s = new JumpSpec(PlaySpecKind.ToCoda);
          s.value = "1";
          pd.jumpTo.set(end(j.measure), s);
        } else {
          pd.coda.set("1", target(j));
        }
        break;
    }
  }
}

/** `.jpwabc` 写出端的输入（`model/tojpw.ts::JpwScoreIn`），**口径同 `jianpuInputOfDoc`**（非展开档那一份）：
 *  第一个有曲行的声部；小节线条目与行末换行按原次序；标题/credit 同 `songToScore`。这首没有曲行时返回 null。 */
export function jpwInputOfSong(doc: ScoreDoc, songIdx = 0): JpwScoreIn | null {
  const built = songMeasures(doc, songIdx, {}, false);
  if (!built) return null;
  const playData = playDataOf(doc, songIdx, built);
  const meta = built.song.metadata;
  for (const tempo of meta.tempos) {
    if (typeof tempo === "number" && tempo >= 20 && tempo <= 400) {
      playData.tempo = tempo;
      break;
    }
  }
  const credit: { type: string | null; page: number; text: string }[] = [];
  const push = (text: string, type: string | null): void => {
    if (text) credit.push({ type, text, page: 0 });
  };
  meta.titles.forEach((t, i) => push(t, i === 0 ? "title" : "subtitle"));
  // 作者条目在排版行视图里是一行（换行换成了空格）；模型的 credit 里还留着原来的换行（`.jpwabc` 的
  // `WordsByAndMusicBy` 一条多行），写回时照 credit 原文
  const credits = doc.songs[songIdx]!.credits ?? [];
  const original = (a: string): string => credits.find((c) => c.text !== a && c.text.replace(/\n/g, " ") === a)?.text ?? a;
  for (const a of meta.authors) push(original(a), "composer");
  for (const t of meta.topRight) push(t, "composer");
  for (const t of meta.topLeft) push(t, "lyricist");

  const key = { fifths: built.key.fifths, name: built.key.name };
  const measures: JpwMeasureIn[] = built.parts[0]!.map((m) => {
    let chords = 0;
    const entries = m.seq.map((it): object => {
      if (it === "break") return { newPage: false, pass: null };
      if (it === "barline") return { style: null, repeat: null, position: new Fraction(chords > 0 ? 1 : 0) };
      chords++;
      const n = it.notes[0]!;
      const chord: JpwChordIn = {
        notes: [{
          number: n.number, jpOctave: n.jpOctave, jpAlter: n.jpAlter,
          tieStart: n.tieStart, tieEnd: n.tieEnd, tupletBegin: it.tupletBegin, tupletEnd: it.tupletEnd,
          lyrics: n.lyrics,
        }],
        rest: it.rest,
        dot: it.dot,
        beats: it.beats,
        beams: it.beams,
        slurStart: it.slurStart,
        slurEnds: it.slurEnds,
        fermata: it.fermata,
        graceNotes: [],
      };
      return chord;
    });
    return {
      entries,
      newSystem: false,
      newPage: false,
      repeatForward: m.repeatForward,
      repeatBackward: m.repeatBackward,
      endingLeft: m.endingLeft,
      endingNum: m.endingNum,
      timeChange: false,
      keyChange: false,
      time: built.time,
      key,
      barline: m.barline,
    };
  });
  return { title: meta.titles[0] ?? "", credit, parts: [{ measures }], playData };
}
