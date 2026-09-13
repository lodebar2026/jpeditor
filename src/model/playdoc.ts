// `ScoreDoc`（MusicXML 形状）→ 演唱顺序，`docs/待办.md` §3.1 阶段 4 的新侧。
//
// **口径照 `score/musicxml.ts::loadMusicXml`**（本轮只换输入、不动判据，靠 `playorder-check --dual` 双跑逐项一致）：
//   - 只读第一声部；小节、和弦、歌词段号、房号、反复经 `phrasedoc.ts::phrasePartOfDoc` 拼（与断句同一份输入）
//   - 跳转取 `<direction><sound>`：落点是**游标当时的位置**（`parseSound` 的 `noteEnd`），
//     由 `Direction.afterElements` 还原成它前面那个音符的终点
// 简谱形状（文本谱 / 123 / ABC / `.jpwabc`）在 `pu/playsong.ts`。

import { Fraction } from "../common/fraction";
import { JumpSpec, PlayData, PlaySpecKind, TimePosition, playOrderOf } from "../score/playorder";
import type { Direction, Measure, Song } from "./doc";
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
