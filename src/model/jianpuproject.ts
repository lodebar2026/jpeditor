// MusicXML 形状的 `Song` → **简谱形状**的 `Song`：简谱排版（`pu/slots.ts`）与 123 写出端之前的投影。
// 与 `xmlproject.ts` 方向相反，判据同一条（`xmlproject.ts::isXmlShaped`）。
//
// ## 为什么要有这一层
//
// `fromxml.ts` 读进来的是 MusicXML 的表达：时值是 `<type>` + `<dot>` + 以 `attrs.divisions` 为分母的
// `divisions`，`beams` 是 `<beam>` 元素（没连杠的八分音符、八分休止根本没有），和弦是结构化的
// `<harmony>`、长音中途换的和弦带 `offset`。简谱侧读的却是：`beams` = 减时线条数、`dots` = 简谱附点、
// 四分以上的长音拆成增时线（`sustains`）、和弦是原文。直接喂过去，附点二分 `5 - -` 会画成附点四分、
// 单个八分音符画成四分、和弦一个都不显示——这里把前者投成后者。
//
// 模型本身不动（`.musicxml` 重写要逐字节稳定），在克隆上投影，按 `Song` 对象缓存。
//
// 判据对照：`loadMusicXml → Score`（`score/musicxml.ts::parseDuration`）读时值的口径，
// 回归 `scripts/jianpu-shape-check.mjs` 逐音比对。

import type { Chord, Element, ElementId, Harmony, Measure, Song } from "./doc";
import { harmonyText, jianpuShape, nominalQuarters } from "./jianpu";
import { isXmlShaped } from "./xmlproject";

/** 简谱来源的时值单位：一个四分音符 = 48（与 `frompu.ts` / `j123` / `xmlproject.ts` 同口径） */
const Q = 48;

const cache = new WeakMap<Song, Song>();

export function projectForJianpu(src: Song): Song {
  if (!isXmlShaped(src)) return src;
  const hit = cache.get(src);
  if (hit) return hit;
  const song: Song = structuredClone(src);
  creatorsFromCredits(song);
  let nextId = maxId(song) + 1;
  const newId = (): ElementId => nextId++;
  for (const part of song.parts) {
    let divisions = 1;
    let carry: Harmony[] = [];
    for (const m of part.measures) {
      if (m.attrs?.divisions !== undefined) divisions = m.attrs.divisions;
      carry = projectMeasure(m, divisions, newId, carry);
      if (m.attrs) delete m.attrs.divisions;
    }
    // 曲末还欠着的和弦：挂回最后一个音符（记为落不到拍位）
    const last = part.measures.flatMap((m) => m.elements).reverse().find((e): e is Chord => e.kind === "chord");
    if (carry.length && last) last.laterHarmonies = [...(last.laterHarmonies ?? []), ...carry];
  }
  cache.set(src, song);
  return song;
}

/** 123 的 `C:` 取自 `identification`。识别出的与不少排版软件导出的 MusicXML 把词曲只写在 `<credit>` 里：
 *  没有 creator 时，把标题、副标题、版权以外的 credit 当作者行（`.jpwabc` 那一路的 `WordsByAndMusicBy` 同口径） */
function creatorsFromCredits(song: Song): void {
  if (song.identification?.creators.length) return;
  const skip = new Set(["title", "subtitle", "rights", "page-number"]);
  const title = song.work.title?.trim();
  const creators = (song.credits ?? [])
    .filter((c) => !(c.type && skip.has(c.type)) && c.text.trim() && c.text.trim() !== title)
    .map((c) => ({ type: c.type ?? "composer", text: c.text.replace(/\n/g, " ").trim() }));
  if (creators.length) song.identification = { ...(song.identification ?? {}), creators };
}

function maxId(song: Song): number {
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

const textOf = (h: Harmony): Harmony => (h.text !== undefined ? h : { ...h, text: harmonyText(h) });

/** @returns 小节末尾挂不进本小节、要顺延给下一小节第一个音的和弦 */
function projectMeasure(m: Measure, divisions: number, newId: () => ElementId, carryIn: Harmony[]): Harmony[] {
  const out: Element[] = [];
  /** 每个音符的实际起点（四分音符为 1），小节末的 `y` 和弦按它找落点 */
  const startOf = new Map<Chord, number>();
  let pos = 0;
  const trailing: Harmony[] = [];
  for (const el of m.elements) {
    if (el.kind === "space" && el.spacer === "y") {
      // `fromxml.ts` 只在小节末尾造 `y`：音符后面还欠着的 `<harmony>`。简谱侧的 `y` 会画成一拍隐藏休止，这里拆掉
      if (el.harmony) trailing.push(el.harmony);
      continue;
    }
    if (el.kind === "chord" && !el.grace) {
      startOf.set(el, pos);
      pos += el.duration.divisions / divisions;
    } else if (el.kind === "space" && el.duration) {
      pos += el.duration.divisions / divisions;
    }
  }
  const measureEnd = pos;
  const firstChord = m.elements.find((e): e is Chord => e.kind === "chord" && !e.grace);
  if (firstChord && carryIn.length) {
    for (const h of carryIn) {
      if (!firstChord.harmony) firstChord.harmony = { ...h, offset: 0 };
      else (firstChord.laterHarmonies ??= []).push({ ...h, offset: 0 });
    }
  }
  for (const el of m.elements) {
    if (el.kind === "space" && el.spacer === "y") continue;
    if (el.harmony) el.harmony = textOf(el.harmony);
    if (el.kind === "space") {
      if (el.duration) {
        const s = jianpuShape(nominalQuarters(el, divisions));
        el.duration = { divisions: Math.round(nominalQuarters(el, divisions) * Q), dots: s.dots };
        el.beams = s.beams ? Array.from({ length: s.beams }, () => "continue" as const) : undefined;
        if (!el.beams) delete el.beams;
      }
      out.push(el);
      continue;
    }
    const ch = el;
    const q = nominalQuarters(ch, divisions);
    const s = jianpuShape(q);
    const shaped: Chord["duration"] = { divisions: ch.grace ? 0 : Math.round(q * Q), dots: s.dots };
    if (ch.duration.type) shaped.type = ch.duration.type;
    ch.duration = shaped;
    if (s.beams) ch.beams = Array.from({ length: s.beams }, () => "continue" as const);
    else delete ch.beams;

    if (ch.grace || s.sustains === 0) {
      placeLaterHarmonies(ch, [], divisions);
      out.push(ch);
      continue;
    }
    if (ch.rest) {
      // 简谱的长休止写成几个 0，不写增时线
      const beats = Math.floor(q + 1e-9);
      ch.duration = { divisions: Q, dots: 0 };
      const later = [...(ch.laterHarmonies ?? [])];
      delete ch.laterHarmonies;
      out.push(ch);
      for (let k = 1; k < beats; k++) {
        const r: Chord = { kind: "chord", id: newId(), notes: [], rest: {}, duration: { divisions: Q, dots: 0 }, voice: ch.voice, staff: ch.staff };
        // 长休止中途换的和弦落到对应那个 0 上
        const h = later.findIndex((x) => Math.abs((x.offset ?? 0) / divisions - k) < 1e-6);
        if (h >= 0) {
          const [placed] = later.splice(h, 1);
          r.harmony = { ...textOf(placed!) };
          delete r.harmony.offset;
        }
        out.push(r);
      }
      if (later.length) ch.laterHarmonies = later.map(textOf);
      const rest = q - beats;
      if (rest > 1e-9) {
        const r = jianpuShape(rest);
        const tail: Chord = { kind: "chord", id: newId(), notes: [], rest: {}, duration: { divisions: Math.round(rest * Q), dots: r.dots }, voice: ch.voice, staff: ch.staff };
        if (r.beams) tail.beams = Array.from({ length: r.beams }, () => "continue" as const);
        out.push(tail);
      }
      continue;
    }
    ch.sustains = Array.from({ length: s.sustains }, () => ({ id: newId() }));
    placeLaterHarmonies(ch, ch.sustains, divisions);
    out.push(ch);
  }
  m.elements = out;

  // 小节末的和弦：位置 = 小节末 + offset（负值往回数）。落进哪个音就交给那个音去挂（音符起点 / 增时线），
  // offset 不为负的是给下一小节第一个音的
  const carryOut: Harmony[] = [];
  for (const h of trailing) {
    const at = measureEnd + (h.offset ?? 0) / divisions;
    if (at >= measureEnd - 1e-9) {
      carryOut.push(textOf(h));
      continue;
    }
    let host: Chord | undefined;
    for (const [c, st] of startOf) if (st <= at + 1e-9) host = c;
    if (!host) {
      carryOut.push(textOf(h));
      continue;
    }
    const rel = at - startOf.get(host)!;
    if (Math.abs(rel) < 1e-9 && !host.harmony) {
      host.harmony = { ...textOf(h), offset: 0 };
      delete host.harmony.offset;
      continue;
    }
    const k = Math.round(rel - (host.duration.divisions - (host.sustains?.length ?? 0) * Q) / Q);
    const su = host.sustains?.[k];
    const onBeat = Math.abs(rel - (host.duration.divisions / Q - (host.sustains?.length ?? 0)) - k) < 1e-6;
    if (su && onBeat && !su.harmony) {
      su.harmony = { ...textOf(h) };
      delete su.harmony.offset;
    } else {
      // 长休止拆成的几个 0 里找对应那一拍
      const idx = out.indexOf(host);
      const beat = Math.round(rel);
      const r = out[idx + beat];
      if (host.rest && Math.abs(rel - beat) < 1e-9 && r?.kind === "chord" && r.rest && !r.harmony) {
        r.harmony = { ...textOf(h) };
        delete r.harmony.offset;
      } else {
        (host.laterHarmonies ??= []).push(textOf(h));
      }
    }
  }
  return carryOut;
}

/** 长音中途换的和弦（`offset`）挂到对应拍位的增时线上；落不到整拍上的留在原处（简谱写不出） */
function placeLaterHarmonies(ch: Chord, sustains: NonNullable<Chord["sustains"]>, divisions: number): void {
  const later = [...(ch.laterHarmonies ?? [])];
  // 只有一个和弦、但它本身带 offset（落在长音中间）的也一样处理
  if (ch.harmony?.offset && ch.harmony.offset > 0) {
    later.unshift(ch.harmony);
    delete ch.harmony;
  }
  const bodyQuarters = (ch.duration.divisions - sustains.length * Q) / Q;
  const left: Harmony[] = [];
  for (const h of later) {
    const at = (h.offset ?? 0) / divisions;
    const k = Math.round(at - bodyQuarters);
    const su = sustains[k];
    if (Math.abs(at - bodyQuarters - k) < 1e-6 && su && !su.harmony) {
      const placed = textOf(h);
      delete placed.offset;
      su.harmony = placed;
    } else if (!ch.harmony && (h.offset ?? 0) <= 0) {
      ch.harmony = textOf(h);
    } else {
      left.push(textOf(h));
    }
  }
  // 挂不到增时线上、音符本身又没有和弦的：退一步挂在音符上（位置提前了，但和弦还在谱上）
  if (!ch.harmony && left.length) {
    ch.harmony = left.shift()!;
    delete ch.harmony.offset;
  }
  if (left.length) ch.laterHarmonies = left;
  else delete ch.laterHarmonies;
}
