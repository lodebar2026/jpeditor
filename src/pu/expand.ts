// 文本谱「展开」档：按 Score 推出的遍次序列（`playData.measures`）把 AST 重新拼一遍，
// 一段歌词一遍谱、逐遍成页。「怎么走」与 `.jpwabc` 共用 jianpu/expand.ts::walkPlay，
// 这里只写文本谱自己的「怎么放一个小节」：经 toscore.ts 的 `measureMap` 找回 AST 片段，拼成新的曲行。
//
// 拼接规则：
// - 同一源行、首尾相接的片段并回一行——守住「一行 `Q:` 就是谱面一行」；
// - 歌词只留这一遍的那几段（versesForPass），重编成第 1 段；
// - 记号按片段求交重映射，被切断的弧线/渐强标 continuation；跳房子丢掉（这一遍唱的就是这一房）；
// - 反复小节线降为普通线、跳转记号（D.C./D.S./Fine/尾声/花 S）剔除——展开之后它们都已兑现；
// - 遍次变了、`endOfPass`、源里的 `[fenye]`（源页变了）都另起一页；
// - 元素**浅拷贝**：同一个音符会出现在好几遍里，共享对象会让 PuPainter 的高亮索引只剩最后一遍。
//   展开档的试听 Score 也由这份展开后的 AST 转出（App.puScore），Chord ↔ 拷贝一一对应。

import type {
  BarlineElement,
  LyricLine,
  LyricSyllable,
  Mark,
  MusicElement,
  PuDoc,
  PuSong,
  ScoreLine,
  ScorePage,
  VoiceGroup,
} from "./ast";
import { takesLyric, voiceNumbers } from "./ast";
import { puToScore, type PuMeasureRef } from "./toscore";
import { versesForPass, walkPlay, type MeasureCut } from "../jianpu/expand";

/** 展开后已经兑现、不该再画的跳转记号。 */
const JUMP_ORNAMENTS = new Set(["dc", "ds", "fine", "ty", "hs"]);

interface Slice {
  line: ScoreLine;
  from: number;
  to: number;
  /** `limit` 把小节截短后补的收尾小节线 */
  tail?: BarlineElement;
}

interface Run {
  pass: number;
  /** 展开后的第几遍（walkPlay 每换一次遍页就 +1；源里 `[fenye]` 换页不算） */
  seg: number;
  page: number;
  group: VoiceGroup;
  slices: Map<number, Slice[]>;
  lastLine: ScoreLine | null;
  lastTo: number;
}

/** 整份文档展开。某首推不出、或各声部小节对不上，就原样留着那一首。 */
export function expandPuDoc(doc: PuDoc): PuDoc {
  return { ...doc, songs: doc.songs.map((song, i) => expandSong(doc, song, i) ?? song) };
}

function expandSong(doc: PuDoc, song: PuSong, songIndex: number): PuSong | null {
  const map = new Map<number, PuMeasureRef[]>();
  const score = puToScore(doc, { song: songIndex, measureMap: map });
  if (!score) return null;
  const voices = voiceNumbers(song).filter((v) => map.has(v));
  const count = score.parts[0]?.measures.length ?? 0;
  if (voices.length === 0 || count === 0) return null;
  const main = voices[0]!;
  const mainRefs = map.get(main)!;
  if (mainRefs.length !== count || mainRefs.some((r) => r === undefined)) return null;
  const align = alignVoices(song, map, voices, main);
  if (!align) return null;

  const home = new Map<ScoreLine, { page: number; group: VoiceGroup }>();
  song.pages.forEach((pg, pi) =>
    pg.groups.forEach((g) => g.voices.forEach((line) => home.set(line, { page: pi, group: g }))),
  );

  const pages: Run[][] = [];
  let cur: Run | null = null;
  let needPage = true;
  let seg = 0;
  // 何时换页（endOfPass、往回跳）由 walkPlay 统一判，经 passEnd 通知
  walkPlay(score.playData.measures, {
    measure: (mid, pass, cut) => {
      const ref0 = mainRefs[mid]!;
      const slices0 = cutMeasure(ref0, cut);
      if (slices0.length === 0) return;
      // 主旋律的每一段片段决定落进哪一行（跨行的小节会落进两行）
      const runs: Run[] = [];
      for (const s of slices0) {
        const h = home.get(s.line)!;
        if (cur && !needPage && h.page !== cur.page) needPage = true; // 源里的 [fenye]
        const contiguous = cur !== null && !needPage && cur.lastLine === s.line && cur.lastTo === s.from;
        if (needPage) pages.push([]);
        if (needPage || !contiguous) {
          cur = { pass, seg, page: h.page, group: h.group, slices: new Map(), lastLine: null, lastTo: -1 };
          pages[pages.length - 1]!.push(cur);
        }
        needPage = false;
        cur!.lastLine = s.line;
        cur!.lastTo = s.tail ? -1 : s.to;
        runs.push(cur!);
      }
      slices0.forEach((s, k) => appendSlice(runs[k]!, main, s));
      for (const v of voices) {
        if (v === main) continue;
        const ref = align.refFor(ref0, v);
        if (!ref) continue; // 这一行没有这个声部
        cutMeasure(ref, cut).forEach((s, k) => {
          const at = slices0.findIndex((x) => x.line === align.mainOf.get(s.line));
          appendSlice(runs[at >= 0 ? at : Math.min(k, runs.length - 1)]!, v, s);
        });
      }
    },
    passEnd: () => {
      needPage = true;
      seg++;
    },
  });
  if (pages.length === 0) return null;

  const seen = new Set<string>();
  let groupIndex = 0;
  const outPages: ScorePage[] = pages.map((runs, pi) => ({
    index: pi,
    groups: runs.map((run) => {
      const key = `${run.pass}|${song.pages[run.page]!.groups.indexOf(run.group)}|${run.page}`;
      // `W:` 说明文字只跟这一遍里该组第一次出现的地方，逐遍重复印会很吵
      const texts = seen.has(key) ? [] : run.group.texts;
      seen.add(key);
      const out: VoiceGroup = { index: groupIndex++, texts, voices: [], pass: run.seg };
      for (const v of voices) {
        const slices = run.slices.get(v);
        if (slices && slices.length > 0) out.voices.push(buildLine(slices, run.pass));
      }
      return out;
    }),
  }));
  // 整首的最后一条小节线画终止线（原谱末尾常是 `:||`，展开后降成了普通线）
  const lastGroups = outPages[outPages.length - 1]?.groups ?? [];
  const lastGroup = lastGroups[lastGroups.length - 1];
  for (const line of lastGroup?.voices ?? []) {
    const el = line.elements[line.elements.length - 1];
    if (el?.kind === "barline") line.elements[line.elements.length - 1] = { ...el, type: "end" };
  }
  return { index: song.index, metadata: song.metadata, pages: outPages };
}

type Segment = PuMeasureRef["segments"][number];

/** 有音符（或增时线）的片段。只有小节线的片段——下一行行首的 `|:` 挂在本小节上——
 *  不单独成行，否则会拼出一条只有一根线、底下挂一行空歌词的曲行（爱是不保留）。 */
function sounding(ref: PuMeasureRef): Segment[] {
  const out = ref.segments.filter((s) =>
    s.line.elements.slice(s.from, s.to).some((el) => el.kind === "note" || el.kind === "sustain"),
  );
  return out.length > 0 ? out : ref.segments;
}

/**
 * 副声部跟主旋律对齐。**不能按全曲小节序号对**：合唱谱的声部常只在某几行出现
 *（同一首歌的 Q3 只有后半首），各声部的小节数本就不一样。按「同一组里的对应曲行 +
 * 行内第几个片段」对：主旋律第 k 段 ↔ 同组该声部那一行的第 k 段。
 * 同组里某声部行的片段数与主旋律行对不上，说明源谱本身没对齐，展开只会放大错位，就不展开。
 */
function alignVoices(
  song: PuSong,
  map: Map<number, PuMeasureRef[]>,
  voices: readonly number[],
  main: number,
): { refFor: (ref0: PuMeasureRef, v: number) => PuMeasureRef | null; mainOf: Map<ScoreLine, ScoreLine> } | null {
  const segsOf = new Map<ScoreLine, Array<{ seg: Segment; ref: PuMeasureRef }>>();
  for (const v of voices) {
    for (const ref of map.get(v)!) {
      if (!ref) continue;
      for (const seg of sounding(ref)) {
        const list = segsOf.get(seg.line) ?? [];
        list.push({ seg, ref });
        segsOf.set(seg.line, list);
      }
    }
  }
  for (const list of segsOf.values()) list.sort((a, b) => a.seg.from - b.seg.from);
  const counterpart = new Map<ScoreLine, Map<number, ScoreLine>>();
  const mainOf = new Map<ScoreLine, ScoreLine>();
  for (const pg of song.pages) {
    for (const g of pg.groups) {
      const mainLine = g.voices.find((l) => l.voice === main && segsOf.has(l));
      const others = g.voices.filter((l) => l.voice !== main && voices.includes(l.voice) && segsOf.has(l));
      if (!mainLine) {
        if (others.length > 0) return null;
        continue;
      }
      const n = segsOf.get(mainLine)!.length;
      const byVoice = new Map<number, ScoreLine>();
      for (const l of others) {
        if (segsOf.get(l)!.length !== n || byVoice.has(l.voice)) return null;
        byVoice.set(l.voice, l);
        mainOf.set(l, mainLine);
      }
      counterpart.set(mainLine, byVoice);
    }
  }
  const refFor = (ref0: PuMeasureRef, v: number): PuMeasureRef | null => {
    const segments: Segment[] = [];
    const chords: PuMeasureRef["chords"] = [];
    for (const s of sounding(ref0)) {
      const lv = counterpart.get(s.line)?.get(v);
      if (!lv) continue;
      const k = segsOf.get(s.line)!.findIndex((x) => x.seg.from === s.from);
      const hit = segsOf.get(lv)![k];
      if (!hit) continue;
      segments.push(hit.seg);
      for (const c of hit.ref.chords) {
        if (c.line === lv && hit.seg.from <= c.index && c.index < hit.seg.to) chords.push(c);
      }
    }
    return segments.length > 0 ? { mid: ref0.mid, segments, chords } : null;
  };
  return { refFor, mainOf };
}

/** 一个小节在这一遍里实际唱到的片段（按和弦数裁首尾）。 */
function cutMeasure(ref: PuMeasureRef, cut: MeasureCut): Slice[] {
  let slices: Slice[] = sounding(ref).map((s) => ({ line: s.line, from: s.from, to: s.to }));
  if (cut.skip > 0) {
    const start = ref.chords[cut.skip];
    if (start) {
      const at = slices.findIndex((s) => s.line === start.line && s.from <= start.index && start.index < s.to);
      if (at >= 0) {
        slices = slices.slice(at);
        slices[0] = { ...slices[0]!, from: start.index };
      }
    }
  }
  if (cut.limit >= 0 && cut.limit < ref.chords.length) {
    const stop = ref.chords[cut.limit]!;
    const at = slices.findIndex((s) => s.line === stop.line && s.from <= stop.index && stop.index < s.to);
    if (at >= 0) {
      slices = slices.slice(0, at + 1);
      const last = slices[at]!;
      const src = last.line.elements[stop.index]!;
      const tail: BarlineElement = { kind: "barline", type: "normal", ornaments: [], code: "|", source: src.source };
      slices[at] = { ...last, to: stop.index, tail };
      if (slices[at]!.to <= slices[at]!.from && !slices[at]!.tail) slices.pop();
    }
  }
  return slices.filter((s) => s.to > s.from || s.tail);
}

function appendSlice(run: Run, voice: number, s: Slice): void {
  const list = run.slices.get(voice) ?? [];
  const last = list[list.length - 1];
  if (last && !last.tail && last.line === s.line && last.to === s.from) {
    list[list.length - 1] = { ...last, to: s.to, ...(s.tail ? { tail: s.tail } : {}) };
  } else {
    list.push(s);
  }
  run.slices.set(voice, list);
}

function cloneElement(el: MusicElement): MusicElement {
  switch (el.kind) {
    case "barline": {
      const type = el.type === "repeat-start" || el.type === "repeat-end" || el.type === "repeat-both" ? "normal" : el.type;
      return { ...el, type, ornaments: el.ornaments.filter((o) => !JUMP_ORNAMENTS.has(o.name)) };
    }
    case "note":
    case "sustain":
      return { ...el, ornaments: el.ornaments.filter((o) => !JUMP_ORNAMENTS.has(o.name)) } as MusicElement;
    default:
      return { ...el };
  }
}

/** 片段拼成一条曲行：元素浅拷贝、记号重映射、歌词按遍选段。 */
function buildLine(slices: readonly Slice[], pass: number): ScoreLine {
  const first = slices[0]!.line;
  const elements: MusicElement[] = [];
  const marks: Mark[] = [];
  const lyrics: LyricLine[] = [];
  let lyricCursor = 0; // 输出行里已发出的「跟词」位数
  for (const s of slices) {
    const offset = elements.length;
    for (let i = s.from; i < s.to; i++) elements.push(cloneElement(s.line.elements[i]!));
    if (s.tail) elements.push(s.tail);
    for (const mk of s.line.marks) {
      if (mk.type === "volta") continue;
      if (mk.end < s.from || mk.start >= s.to) continue;
      const nm: Mark = {
        ...mk,
        start: offset + Math.max(mk.start, s.from) - s.from,
        end: offset + Math.min(mk.end, s.to - 1) - s.from,
      };
      if (mk.start < s.from) nm.continuationFromPrevious = true;
      if (mk.end > s.to - 1) nm.continuationToNext = true;
      marks.push(nm);
    }
    // 歌词：音节按「跟词」符号顺序发放（同 layout.ts::assignLyrics），片段之前的那些要先数掉
    let before = 0;
    for (let i = 0; i < s.from; i++) if (takesLyric(s.line.elements[i]!)) before++;
    let n = 0;
    for (let i = s.from; i < s.to; i++) if (takesLyric(s.line.elements[i]!)) n++;
    versesForPass(s.line.lyrics, pass).forEach((ly, k) => {
      let out = lyrics[k];
      if (!out) {
        // 一律记作第 1 段：这一遍唱的就是这几行。源里同一遍叠了两行（同一首歌两行都写 `C1:`）时
        // 若编成 1、2 段，展开档的试听 Score 又会被 repeatByLyric 按两段整体再乘一遍
        out = { verseFrom: 1, verseTo: 1, annotationGap: ly.annotationGap, syllables: [], source: ly.source };
        lyrics[k] = out;
      }
      if (s.from === 0 && ly.annotation !== undefined && out.annotation === undefined) out.annotation = ly.annotation;
      while (out.syllables.length < lyricCursor) out.syllables.push(blank(ly));
      // 音节也要拷贝：只写一段、各遍共用的歌词行（副歌）若共享对象，高亮索引只剩最后一遍那页
      const got = ly.syllables.slice(before, before + n).map((syl) => ({ ...syl }));
      out.syllables.push(...got);
      for (let i = got.length; i < n; i++) out.syllables.push(blank(ly));
    });
    lyricCursor += n;
  }
  const line: ScoreLine = { voice: first.voice, elements, marks, lyrics, raw: first.raw, source: first.source };
  if (first.variant !== undefined) line.variant = first.variant;
  if (first.caption !== undefined) line.caption = first.caption;
  return line;
}

function blank(ly: LyricLine): LyricSyllable {
  return { text: "", source: ly.source };
}
