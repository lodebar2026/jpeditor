// `ScoreDoc`（MusicXML 形状）→ 演唱顺序，`docs/待办.md` §3.1 阶段 4 的新侧。
//
// **口径照 `score/musicxml.ts::loadMusicXml`**（本轮只换输入、不动判据，靠 `playorder-check --dual` 双跑逐项一致）：
//   - 只读第一声部；小节、和弦、歌词段号、房号、反复经 `phrasedoc.ts::phrasePartOfDoc` 拼（与断句同一份输入）
//   - 跳转取 `<direction><sound>`：落点是**游标当时的位置**（`parseSound` 的 `noteEnd`），
//     由 `Direction.afterElements` 还原成它前面那个音符的终点
// 简谱形状（文本谱 / 123 / ABC / `.jpwabc`）在 `pu/playsong.ts`。

import { Fraction } from "../common/fraction";
import { JumpSpec, PlayData, PlaySpecKind, TimePosition, playOrderOf } from "../score/playorder";
import { DEFAULT_VELOCITY, type PlaySource, type TimelineChord, type TimelineMeasure, type TimelinePart } from "../score/timeline";
import type { Chord, Direction, Measure, Part, Song } from "./doc";
import { midiPitch } from "./jianpu";
import { phrasePartOfDoc } from "./phrasedoc";

/** 演唱顺序（`measures` / `isSimpple` / `hasRepeat` 与跳转表；速度不在这里）。
 *  推理抛错照样抛出，与 `loadMusicXml` 一致。 */
export function playDataOfDoc(song: Song): PlayData {
  const pd = new PlayData();
  const part = song.parts[0];
  if (!part) throw new Error("no part");
  const div = part.measures[0]?.attrs?.divisions ?? 1;
  part.measures.forEach((m, mid) => {
    for (const d of m.directions ?? []) if (d.sound) addSound(pd, d, new TimePosition(mid, cursorAt(m, d).divInt(div)));
  });
  const order = playOrderOf([phrasePartOfDoc(song).part], pd);
  pd.isSimpple = order.isSimple;
  pd.measures = order.measures;
  pd.hasRepeat = order.hasRepeat;
  return pd;
}

/** `<direction>` 处的游标（divisions）：它前面最后一个非倚音和弦的终点，各声部各自累计。 */
function cursorAt(m: Measure, d: Direction): Fraction {
  const pos = new Map<number, number>();
  let end = 0;
  const n = Math.min(d.afterElements ?? 0, m.elements.length);
  for (let i = 0; i < n; i++) {
    const el = m.elements[i]!;
    if (el.kind !== "chord" || el.grace) continue;
    const p = pos.get(el.voice) ?? 0;
    end = p + el.duration.divisions;
    pos.set(el.voice, end);
  }
  return new Fraction(end);
}

/** 同 `parseSound`（速度除外）。 */
function addSound(pd: PlayData, d: Direction, tick: TimePosition): void {
  const s = d.sound!;
  if (s.coda) pd.coda.set(s.coda, tick);
  if (s.segno) pd.segno.set(s.segno, tick);
  if (s.dacapo) pd.jumpTo.set(tick, new JumpSpec(PlaySpecKind.Dacapo));
  if (s.fine) pd.jumpTo.set(tick, new JumpSpec(PlaySpecKind.Fine));
  if (s.dalsegno) {
    const j = new JumpSpec(PlaySpecKind.DalSegno);
    j.value = s.dalsegno;
    pd.jumpTo.set(tick, j);
  }
  if (s.tocoda) {
    const j = new JumpSpec(PlaySpecKind.ToCoda);
    j.value = s.tocoda;
    pd.jumpTo.set(tick, j);
  }
}

export interface PlaySourceOptions {
  /** 只取第一声部的 voice ≤ 1、和弦只取最高音，不带力度——**口径照 `loadMusicXml`**，双跑用 */
  melodyOnly?: boolean;
}

/** 试听/MIDI 的输入（`score/timeline.ts::PlaySource`）。缺省带全部声部（`part` 下标 = `Part` 序）、
 *  各 voice、和弦全部音与力度记号；光标只跟第一声部 voice ≤ 1。 */
export function playSourceOfDoc(song: Song, options: PlaySourceOptions = {}): PlaySource {
  const playData = playDataOfDoc(song);
  playData.tempo = tempoOfDoc(song);
  if (options.melodyOnly) return { parts: [phrasePartOfDoc(song).part], playData };
  return { parts: song.parts.map((p, i) => timelinePartOf(p, i === 0)), playData };
}

/** 谱面速度：第一声部里第一处 `<sound tempo>`（20..400，取整），同 `parseSound`。 */
export function tempoOfDoc(song: Song): number {
  for (const m of song.parts[0]?.measures ?? []) {
    for (const d of m.directions ?? []) {
      const t = d.sound?.tempo;
      if (t !== undefined && t >= 20 && t <= 400) return Math.round(t);
    }
  }
  return 0;
}

/** 力度记号 → note-on velocity。表外的（`sf`/`fp` 这类瞬时重音）不改当前力度。 */
const VELOCITY: Readonly<Record<string, number>> = {
  pppp: 20, ppp: 30, pp: 42, p: 56, mp: 70, mf: 84, f: 98, ff: 112, fff: 122, ffff: 127,
};

interface ChordEntry extends TimelineChord {
  readonly duration: Fraction;
}

function timelinePartOf(part: Part, lead: boolean): TimelinePart {
  // 时值按首小节 divisions 折算，与演唱顺序的落点（`playDataOfDoc`）同口径
  const div = part.measures[0]?.attrs?.divisions ?? 1;
  let time = { beats: 4, beatType: 4 };
  let velocity = DEFAULT_VELOCITY;
  const measures: TimelineMeasure[] = [];
  for (const m of part.measures) {
    if (m.attrs?.time) time = { beats: m.attrs.time.beats, beatType: m.attrs.time.beatType };
    const dyn = (m.directions ?? [])
      .filter((d) => d.type === "dynamics" && d.text !== undefined && VELOCITY[d.text] !== undefined)
      .map((d) => ({ at: cursorAt(m, d).toFloat() + (d.offset ?? 0), v: VELOCITY[d.text!]! }))
      .sort((a, b) => a.at - b.at);
    const pos = new Map<number, number>();
    const entries: ChordEntry[] = [];
    for (const el of m.elements) {
      if (el.kind !== "chord") continue;
      const onset = pos.get(el.voice) ?? 0;
      if (el.grace) continue;
      pos.set(el.voice, onset + el.duration.divisions);
      if (el.cue) continue;
      let v = velocity;
      for (const e of dyn) if (e.at <= onset) v = e.v;
      entries.push(chordEntry(el, onset, div, v, lead && el.voice <= 1));
    }
    if (dyn.length) velocity = dyn[dyn.length - 1]!.v;
    const t = time;
    measures.push({
      entries,
      time: t,
      get duration(): Fraction {
        if (entries.length === 0) throw new Error("measure has no chord");
        let end = entries[0]!.position.plus(entries[0]!.duration);
        for (const e of entries) {
          const x = e.position.plus(e.duration);
          if (x.compareTo(end) > 0) end = x;
        }
        return end;
      },
    });
  }
  return { measures };
}

function chordEntry(el: Chord, onset: number, div: number, velocity: number, cursor: boolean): ChordEntry {
  const notes = el.rest ? [] : el.notes.filter((n) => n.pitch).map((n) => ({ pitch: midiPitch(n.pitch!) }));
  return {
    notes,
    rest: notes.length === 0,
    position: new Fraction(onset).divInt(div),
    duration: new Fraction(el.duration.divisions).divInt(div),
    id: el.id,
    velocity,
    cursor,
  };
}
