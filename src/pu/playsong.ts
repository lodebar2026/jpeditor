// 简谱形状的 `ScoreDoc`（文本谱 / 123 / ABC / `.jpwabc`）→ 演唱顺序，`docs/待办.md` §3.1 阶段 4 的新侧。
//
// 与 `model/playdoc.ts`（MusicXML 形状）分工同断句那一对（`phrasesong.ts` / `phrasedoc.ts`），
// 小节序列与断句共用 `phrasesong.ts::buildMeasures`。**口径照 `toscore.ts::songToScore`**：
//   - 每个有曲行的声部都算一份（歌词段数取各声部最大值），反复与跳转只看第一份；
//     `forExpanded` 时带歌词的声部排第一、同号歌词顺延（同 `ToScoreOptions.forExpanded`）
//   - 跳转记号换算同 `applyJumps`；推不出来（抛错）才退回整曲按段数逐遍
// 另有两条 `songToScore` 没有的（`.jpwabc` 那一路，口径照 `jpwimport.ts::processRepeat`）：
//   - 文档自带演唱顺序（`Song.playOrder`，`.Repeat` 段）→ 照它排，不推
//   - `.jpwabc` 没有 `.Repeat` → 不推，整曲按段数逐遍（JP-Word 本来就这么唱）

import type { ElementId, PlayPass, ScoreDoc } from "../model/doc";
import { Fraction } from "../common/fraction";
import {
  JumpSpec, PlayData, PlaySpecKind, RepeatSpecItem, TimePosition,
  playOrderByVerses, playOrderFromSpec, playOrderOf,
} from "../score/playorder";
import { linesOfVoice, voiceNumbers } from "./ast";
import { buildMeasures, type JumpOut, type MeasureOut } from "./phrasesong";
import { docView } from "./slots";

export interface PlaySongOptions {
  /** 见 `ToScoreOptions.forExpanded` */
  forExpanded?: boolean;
}

/** 演唱顺序（`measures` / `isSimpple` / `hasRepeat` 与跳转表；速度不在这里）。这首没有曲行时返回 null。 */
export function playDataOfSong(doc: ScoreDoc, songIdx = 0, options: PlaySongOptions = {}): PlayData | null {
  const view = docView(doc);
  const song = view.songs[songIdx];
  if (!song) return null;
  let voices = voiceNumbers(song);
  if (options.forExpanded) {
    const lead = voices.find((v) => linesOfVoice(song, v).some((l) => l.lyrics.length > 0));
    if (lead !== undefined) voices = [lead, ...voices.filter((v) => v !== lead)];
  }
  const parts: MeasureOut[][] = [];
  let jumps: JumpOut[] = [];
  const idToChord = new Map<ElementId, { measure: number; index: number }>();
  for (const v of voices) {
    const lines = linesOfVoice(song, v);
    if (lines.length === 0) continue;
    const first = parts.length === 0;
    const ids = new Map<object, ElementId>();
    const built = buildMeasures(lines, (ch, el) => {
      const id = view.idOf.get(el);
      if (first && id !== undefined) ids.set(ch, id);
    }, !!options.forExpanded);
    if (first) {
      jumps = built.jumps;
      built.measures.forEach((m, measure) => m.entries.forEach((ch, index) => {
        const id = ids.get(ch);
        if (id !== undefined) idToChord.set(id, { measure, index });
      }));
    }
    parts.push(built.measures);
  }
  const main = parts[0];
  if (!main) return null;

  const pd = new PlayData();
  const docSong = doc.songs[songIdx]!;
  if (docSong.playOrder?.length) {
    pd.measures = playOrderFromSpec({ items: docSong.playOrder.map((p) => specItem(p, idToChord)) }, { measures: main });
    return pd;
  }
  // 段数 = 主旋律歌词最多的那一行的段号上限（`songToScore` 与 `fromJpw` 同一个数）
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

/** 同 `toscore.ts::applyJumps`。 */
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
