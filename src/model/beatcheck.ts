// 小节时值自检：逐小节把时值加起来，与拍号对不上的报出来。**不需要 GT**。
//
// 两个消费者共用这一份：
// - 编辑器：谱面上把拍数不对的小节标红（录入时最容易犯的就是这一类，`editor/visual/`）；
// - 简谱识别：识别完在核对视图上标出（增时线、减时线读错，小节就凑不满，`editor/omrctl.ts`），
//   私有仓库的 `beat-check.mjs` 也经 CLI 调它，不再自己另算一份。
//
// 口径（与 `beat-check.mjs` 在迦南诗选上验过的一致）：
// - 一律折成「四分音符 = 1 拍」；附点、增时线已并在 `Chord.duration` 里，多连音按比例折实际时值；倚音、`y` 不占时值。
// - 拍号按小节生效（曲中转拍号）；混合拍（头部并排几个拍号 `Song.extraTimes`，或识别给的 `opts.meters`）对上任意一个就算过。
// - **合法的例外**只放过这几种，其余报出来的都该是真错：
//   - 弱起：首小节不满（末小节满不满都行——诗歌谱里弱起而末小节照样写满的很多）；
//     首尾相加凑满一小节时末小节一并放过。**只在调用方认它是弱起时放过**（`opts.pickup`）：
//     识别不知道原谱，一律认；编辑器只认打开时首小节就不满的（改谱删掉首小节的音得报出来）；
//   - 相邻两个都不满的小节相加恰好一小节（小节中间的反复记号把一小节劈成两半，诗歌谱里很常见）；
//   - MusicXML 标了 `implicit` 的小节；
//   - 没有拍号（散板）的整首不查。

import type { ElementId, Measure, ScoreDoc, SourceSpan, Time } from "./doc";
import { SIMPLE_DIVISIONS } from "./doc";
import { isXmlShaped } from "./xmlproject";

export interface BeatIssue {
  songIndex: number;
  partIndex: number;
  measureIndex: number;
  /** 该有几拍、实际几拍（四分音符为 1） */
  want: number;
  got: number;
  /** 这一小节里的元素 id（按顺序；高亮用） */
  ids: ElementId[];
  /** 第一个元素在原文里的位置（没有原文的来源为 undefined） */
  source?: SourceSpan;
}

export interface BeatCheckOptions {
  /** 混合拍：这些拍号对上任意一个就算过（识别结果的 `RecognizedScore.meters`）。缺省按模型里的拍号 */
  meters?: readonly { beats: number; beatType: number }[];
  /** 这个声部的首小节不满算不算弱起（放过）。缺省一律算 */
  pickup?: (songIndex: number, partIndex: number) => boolean;
}

const EPS = 1e-6;
const beatsOf = (t: { beats: number; beatType: number }): number => t.beats * (4 / t.beatType);

/** 一小节的实际时值（四分音符为 1）。多声部按第一个 voice 算。
 *  按 `divisions` 算（`<type>` 不含增时线）：MusicXML 形状的 divisions 已是实际时值，
 *  简谱形状的多连音记名义值（`omr/todoc.ts`、123 解析端同口径），要按比例折回。 */
function measureQuarters(m: Measure, divisions: number, xml: boolean): number {
  let q = 0;
  const voice = m.elements.find((e) => e.kind === "chord" && !e.grace)?.voice ?? 1;
  for (const el of m.elements) {
    if (el.voice !== voice) continue;
    if (el.kind === "chord" && el.grace) continue;
    const d = el.duration;
    if (!d) continue;
    const raw = d.divisions / divisions;
    q += !xml && d.timeMod ? (raw * d.timeMod.normal) / d.timeMod.actual : raw;
  }
  return q;
}

/** 逐小节查时值，返回对不上的那些。 */
export function checkMeasureDurations(doc: ScoreDoc, opts: BeatCheckOptions = {}): BeatIssue[] {
  const out: BeatIssue[] = [];
  doc.songs.forEach((song, songIndex) => {
    const xml = isXmlShaped(song);
    song.parts.forEach((part, partIndex) => {
      let time: Time | undefined = song.time;
      let divisions = SIMPLE_DIVISIONS;
      const rows = part.measures.map((m) => {
        if (m.attrs?.time) time = m.attrs.time;
        if (m.attrs?.divisions) divisions = m.attrs.divisions;
        // 混合拍：头部并排写的几个拍号（`Song.extraTimes`）对上任意一个都算
        const wants = opts.meters?.length ? opts.meters.map(beatsOf)
          : time ? [time, ...(song.extraTimes ?? [])].map(beatsOf) : [];
        return { m, wants, got: measureQuarters(m, divisions, xml) };
      });
      const n = rows.length;
      const ok = rows.map((r) => r.wants.length === 0 || r.m.elements.length === 0 || !!r.m.implicit
        || r.wants.some((w) => Math.abs(r.got - w) < EPS));
      const short = (i: number): boolean => rows[i]!.wants.some((w) => rows[i]!.got < w - EPS);
      const fills = (a: number, b: number): boolean =>
        rows[a]!.wants.some((w) => Math.abs(rows[a]!.got + rows[b]!.got - w) < EPS);
      const pickup = opts.pickup?.(songIndex, partIndex) ?? true;
      // 弱起：首尾相加一小节（只有一小节时首尾是同一个，不算）
      if (pickup && n >= 2 && !ok[0] && short(0) && short(n - 1) && fills(0, n - 1)) ok[0] = ok[n - 1] = true;
      // 首小节单独弱起、末小节是满的：诗歌谱里也常见，首小节不满一律放过
      if (pickup && n >= 2 && !ok[0] && short(0)) ok[0] = true;
      // 相邻两个不满的相加一小节（反复记号劈开的小节）
      for (let i = 0; i + 1 < n; i++) {
        if (!ok[i] && !ok[i + 1] && short(i) && short(i + 1) && fills(i, i + 1)) ok[i] = ok[i + 1] = true;
      }
      rows.forEach((r, measureIndex) => {
        if (ok[measureIndex]) return;
        const want = r.wants.reduce((best, w) => (Math.abs(w - r.got) < Math.abs(best - r.got) ? w : best), r.wants[0]!);
        const issue: BeatIssue = { songIndex, partIndex, measureIndex, want, got: r.got, ids: r.m.elements.map((e) => e.id) };
        const src = r.m.elements.find((e) => e.source)?.source;
        if (src) issue.source = src;
        out.push(issue);
      });
    });
  });
  return out;
}

/** 分数拍数的写法：`1/2`、`1 1/2`、`3`。 */
function beatText(q: number): string {
  for (const d of [1, 2, 4, 8, 16, 3, 6, 12]) {
    const n = Math.round(q * d);
    if (Math.abs(n / d - q) > EPS) continue;
    if (d === 1) return String(n);
    const whole = Math.floor(n / d);
    const rest = n - whole * d;
    return whole ? `${whole} ${rest}/${d}` : `${rest}/${d}`;
  }
  return q.toFixed(2);
}

/** 一条问题的说法：「差 1/2 拍」「多 1 拍」。 */
export function describeBeatIssue(i: BeatIssue): string {
  const diff = i.got - i.want;
  return `${diff < 0 ? "差" : "多"} ${beatText(Math.abs(diff))} 拍（该 ${beatText(i.want)} 拍，实际 ${beatText(i.got)} 拍）`;
}
