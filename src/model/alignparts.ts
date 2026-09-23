// 多声部**按组对齐**（试听、导出 MusicXML 共用；`ScoreDoc` 本身不动，调用方先克隆）。
//
// 文本谱一组不一定含全部声部（issue 11：前几行只有 `Q:`，末组才出 `Q1:`/`Q2:`），
// `frompu.ts` 按声部号建 part 时各声部首尾相接、缺席的组不占位——那样 P2 的第 1 小节其实属于末组，
// 按小节序号叠起来就和第一行同时响；同组里长短不齐（`Q1` 两小节、`Q2` 四小节）也会让后面各组错开。
//
// 做法：各 part 按 `print.system`（组序号）切段，每段以小节最多的 part 为参照，
//   - 缺席的 part 插入参照小节的**无声复制**（首小节带 `print { newSystem, system }`，行视图照样成组）；
//   - 偏短的 part 在段末补参照后几小节的无声复制。
// 无声复制：和弦改休止（新 id），留时值、减时线层、增时线（新 id，照样占拍）、连音（`tuplet` 记号改指新 id）；
// 小节线照抄（反复、房号、跳转在每个 part 上一致）；跳转记号之外的装饰、歌词、和弦记号、夹层一律不要。
// 有 part 缺 `print.system`（非文本谱来源）就不动。

import type { Barline, Chord, Element, ElementId, Mark, Measure, SourceOrnament, Song, Space } from "./doc";

/** 跳转类记号（同 `pu/phrasesong.ts::JUMP_NAMES`），无声复制里保留 */
const JUMP_NAMES = new Set(["dc", "ds", "fine", "ty", "hs"]);

/** 就地对齐 `song.parts`。有改动返回 true。
 *  新 id 从 `idFloor` 往上发（id 全文档唯一：整份文档里还有别的曲子时由调用方给全文档的最大 id，缺省只看这首）。 */
export function alignPartsBySystem(song: Song, idFloor = maxId(song)): boolean {
  if (song.parts.length < 2) return false;
  const segs = song.parts.map(segmentsOf);
  if (segs.some((s) => s === null)) return false;
  const bySystem = segs as Map<number, Measure[]>[];
  const systems = [...new Set(bySystem.flatMap((s) => [...s.keys()]))].sort((a, b) => a - b);

  let nextId = idFloor + 1;
  const tuplets = song.marks.filter((mk) => mk.type === "tuplet");
  const newMarks: Mark[] = [];
  /** 各 part 自己的 voice/staff：补位照抄参照 part 的会串声部（P1 补出 voice 2 的小节，旋律档只取 voice ≤ 1，成了空小节） */
  const homes = song.parts.map((p) => {
    for (const m of p.measures) for (const el of m.elements) if (el.kind === "chord") return { voice: el.voice, staff: el.staff };
    return undefined;
  });
  const silentCopy = (src: readonly Measure[], system: number | null, home: Home | undefined): Measure[] => {
    const idMap = new Map<ElementId, ElementId>();
    const fresh = (old: ElementId): ElementId => {
      const id = nextId++;
      idMap.set(old, id);
      return id;
    };
    const out = src.map((m, i) => {
      const mea: Measure = { number: "", elements: m.elements.flatMap((el) => silentElement(el, fresh, home)) };
      if (m.attrs) mea.attrs = structuredClone(m.attrs);
      const bars = (m.barlines ?? []).map(silentBarline);
      if (bars.length) mea.barlines = bars;
      if (i === 0 && system !== null) mea.print = { newSystem: true, system };
      return mea;
    });
    for (const mk of tuplets) {
      const start = idMap.get(mk.start);
      const end = idMap.get(mk.end);
      if (start !== undefined && end !== undefined) newMarks.push({ type: "tuplet", start, end });
    }
    return out;
  };

  let changed = false;
  const rebuilt: Measure[][] = song.parts.map(() => []);
  for (const sys of systems) {
    let ref: Measure[] = [];
    for (const s of bySystem) {
      const ms = s.get(sys);
      if (ms && ms.length > ref.length) ref = ms;
    }
    bySystem.forEach((s, pi) => {
      const own = s.get(sys);
      const out = rebuilt[pi]!;
      if (!own) {
        out.push(...silentCopy(ref, sys, homes[pi]));
        changed = true;
        return;
      }
      out.push(...own);
      if (own.length < ref.length) {
        out.push(...silentCopy(ref.slice(own.length), null, homes[pi]));
        changed = true;
      }
    });
  }
  if (!changed) return false;
  song.parts.forEach((part, pi) => {
    part.measures = rebuilt[pi]!;
    part.measures.forEach((m, i) => (m.number = String(i + 1)));
  });
  song.marks.push(...newMarks);
  return true;
}

/** 按 `print.system` 把小节切段；首小节没有组序号（非文本谱来源）返回 null。 */
function segmentsOf(part: { measures: Measure[] }): Map<number, Measure[]> | null {
  const out = new Map<number, Measure[]>();
  let cur: Measure[] | null = null;
  for (const m of part.measures) {
    const sys = m.print?.system;
    if (sys !== undefined) {
      cur = out.get(sys) ?? [];
      out.set(sys, cur);
    }
    if (!cur) return null;
    cur.push(m);
  }
  return out.size ? out : null;
}

interface Home { voice: Chord["voice"]; staff: Chord["staff"] }

function silentElement(el: Element, fresh: (old: ElementId) => ElementId, home: Home | undefined): Element[] {
  if (el.kind === "space") {
    const sp: Space = { ...structuredClone(el), id: fresh(el.id) };
    return [sp];
  }
  if (el.grace) return [];
  const ch: Chord = {
    kind: "chord",
    id: fresh(el.id),
    notes: [],
    rest: {},
    duration: { ...el.duration },
    voice: home ? home.voice : el.voice,
    staff: home ? home.staff : el.staff,
  };
  if (el.beams) ch.beams = [...el.beams];
  if (el.sustains?.length) ch.sustains = el.sustains.map((su) => ({ id: fresh(su.id) }));
  const jumps = jumpsOf(el.ornaments);
  if (jumps) ch.ornaments = jumps;
  return [ch];
}

function silentBarline(b: Barline): Barline {
  const out: Barline = { location: b.location };
  if (b.style !== undefined) out.style = b.style;
  if (b.repeat !== undefined) out.repeat = b.repeat;
  if (b.repeatTimes !== undefined) out.repeatTimes = b.repeatTimes;
  if (b.ending) out.ending = structuredClone(b.ending);
  if (b.jump !== undefined) out.jump = b.jump;
  if (b.alsoForward) out.alsoForward = true;
  if (b.noWidth) out.noWidth = true;
  if (b.time) out.time = structuredClone(b.time);
  const jumps = jumpsOf(b.ornaments);
  if (jumps) out.ornaments = jumps;
  return out;
}

function jumpsOf(os: readonly SourceOrnament[] | undefined): SourceOrnament[] | undefined {
  const kept = (os ?? []).filter((o) => JUMP_NAMES.has(o.name)).map((o) => ({ ...o }));
  return kept.length ? kept : undefined;
}

/** 这首里最大的元素 id（和弦、占位、增时线） */
export function maxId(song: Song): number {
  let max = 0;
  for (const p of song.parts) {
    for (const m of p.measures) {
      for (const el of m.elements) {
        max = Math.max(max, el.id);
        if (el.kind === "chord") for (const su of el.sustains ?? []) max = Math.max(max, su.id);
      }
    }
  }
  return max;
}
