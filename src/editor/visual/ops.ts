// 可视化编辑的**动作**：每个动作算出对原文的局部补丁（`changes`）与补丁之后的选区。
//
// 与格式无关，格式差异全在 `EditDialect`（`dialect.ts`）。动作只读 `SyncIndex` 给的原文区间，
// 不碰模型——补丁落进代码区之后，重排、重建索引照常走。
// token 读不懂（`parseNote` 返回 null）就拒绝执行、说明原因，不硬改。

import type { ChangeSpec, EditorState } from "@codemirror/state";
import type { ScoreDoc } from "../../model/doc";
import type { SyncEntry, SyncIndex } from "../sync";
import { type DecoKind, type EditDialect, keyFifthsAt, type NoteCtx, type NoteDuration, type NoteToken } from "./dialect";

export interface EditCtx {
  state: EditorState;
  sync: SyncIndex;
  dialect: EditDialect;
  /** 建索引用的那份模型（数对位格、查调号、认已有的弧） */
  doc: ScoreDoc | null;
}

/** 这个位置上读写音符的上下文（dialect 没给就只按模型取调号：发声要它）。 */
export function noteCtx(ctx: EditCtx, pos: number): NoteCtx {
  return ctx.dialect.contextAt?.(ctx.state, ctx.doc, pos) ?? { fifths: keyFifthsAt(ctx.doc, pos), unitQuarters: 1 };
}

/** 读一个音符条目的 token。 */
function readNote(ctx: EditCtx, e: SyncEntry): NoteToken | null {
  return ctx.dialect.parseNote(ctx.state.doc.sliceString(e.from, e.to), noteCtx(ctx, e.from));
}

/** 一个音符条目在原文里的音头与附点（绝对偏移）。dialect 读不懂时整个 token 算音头。 */
export function noteSpans(ctx: EditCtx, e: SyncEntry): { head: Span; dots: Span | null } {
  return partsAt(ctx, e.from, ctx.state.doc.sliceString(e.from, e.to), noteCtx(ctx, e.from));
}

type Span = { from: number; to: number };

/** token `src` 从 `start` 起时各部分的绝对位置。 */
function partsAt(ctx: EditCtx, start: number, src: string, nc: NoteCtx): { head: Span; dots: Span | null } {
  const p = ctx.dialect.noteParts?.(src, nc);
  if (!p) return { head: { from: start, to: start + src.length }, dots: null };
  return {
    head: { from: start + p.head[0], to: start + p.head[1] },
    dots: p.dots ? { from: start + p.dots[0], to: start + p.dots[1] } : null,
  };
}

/** 一次动作的结果：补丁 + 补丁之后的选区（新文档里的偏移）。 */
export interface EditResult {
  changes: { from: number; to: number; insert: string }[];
  anchor: number;
  head: number;
}

export type EditOutcome = EditResult | { error: string };

export const isError = (o: EditOutcome): o is { error: string } => "error" in o;

/** 补丁落下之后，原文偏移映射到新文档。 */
function mapper(state: EditorState, changes: ChangeSpec[]): (pos: number, assoc?: -1 | 1) => number {
  const cs = state.changes(changes);
  return (pos, assoc = -1) => cs.mapPos(pos, assoc);
}

/** 选区覆盖（或光标所在）的音符条目。 */
export function notesIn(ctx: EditCtx, from: number, to: number): SyncEntry[] {
  if (to <= from) {
    const at = ctx.sync.at(from);
    return at?.kind === "note" ? [at] : [];
  }
  return ctx.sync.range(from, to).filter((e) => e.kind === "note");
}

/** 一个音符的增时线条目（独立 token 的那种）。 */
function sustainsOf(ctx: EditCtx, note: SyncEntry): SyncEntry[] {
  return ctx.sync.ordered().filter((e) => e.kind === "sustain" && e.id === note.id);
}

/** 音符连同它的增时线的结尾。 */
export function groupEnd(ctx: EditCtx, note: SyncEntry): number {
  if (note.kind !== "note") return note.to;
  const su = sustainsOf(ctx, note);
  return su.length ? su[su.length - 1]!.to : note.to;
}

// ───────────────────────── 改音符 ─────────────────────────

/** 对选中的每个音符 token 做一次改写。`fn` 返回 null = 这个音符不改；返回字符串 = 出错说明。 */
function rewriteNotes(
  ctx: EditCtx, from: number, to: number,
  fn: (t: NoteToken, e: SyncEntry) => NoteToken | null | string,
): EditOutcome {
  const notes = notesIn(ctx, from, to);
  if (notes.length === 0) return { error: "先选中一个音符" };
  const text = ctx.state.doc;
  const changes: EditResult["changes"] = [];
  let single: string | null = null;
  for (const e of notes) {
    const src = text.sliceString(e.from, e.to);
    const nc = noteCtx(ctx, e.from);
    const t = ctx.dialect.parseNote(src, nc);
    if (!t) return { error: `看不懂这个音符的写法：${src}` };
    const r = fn({ ...t }, e);
    if (typeof r === "string") return { error: r };
    if (!r) continue;
    const bad = ctx.dialect.validate?.(r);
    if (bad) return { error: bad };
    const out = ctx.dialect.printNote(r, nc);
    single = out;
    if (out !== src) changes.push({ from: e.from, to: e.to, insert: out });
  }
  // 只改了额外补丁（加减增时线）时 token 本身没变，交给 `withExtra` 并进去
  changes.sort((a, b) => a.from - b.from);
  const map = mapper(ctx.state, changes);
  // 单个音符：方块罩住改过的 token 的音头（不带减时线、附点）；多个：罩住原选区映射过去的范围
  if (notes.length === 1 && to - from <= notes[0]!.to - notes[0]!.from) {
    const e = notes[0]!;
    const start = map(e.from, -1);
    const { head } = partsAt(ctx, start, single ?? text.sliceString(e.from, e.to), noteCtx(ctx, e.from));
    return { changes, anchor: head.from, head: head.to };
  }
  return { changes, anchor: map(from, -1), head: map(to, 1) };
}

export function setDegree(ctx: EditCtx, from: number, to: number, degree: number): EditOutcome {
  return rewriteNotes(ctx, from, to, (t) => {
    t.degree = degree;
    t.acc = null; // 换了唱名，原来的升降号不跟着走
    if (degree === 0) {
      t.acc = null;
      t.octave = 0;
    }
    return t;
  });
}

export function shiftOctave(ctx: EditCtx, from: number, to: number, delta: number): EditOutcome {
  return rewriteNotes(ctx, from, to, (t) => {
    if (t.degree === 0) return null; // 休止不带八度点
    t.octave += delta;
    return Math.abs(t.octave) > 3 ? "八度点最多三个" : t;
  });
}

export function toggleDot(ctx: EditCtx, from: number, to: number): EditOutcome {
  return rewriteNotes(ctx, from, to, (t) => {
    t.dots = t.dots > 0 ? 0 : 1;
    return t;
  });
}

export function setAccidental(ctx: EditCtx, from: number, to: number, acc: NoteToken["acc"]): EditOutcome {
  return rewriteNotes(ctx, from, to, (t) => {
    if (t.degree === 0) return null;
    t.acc = t.acc === acc ? null : acc; // 再按一次取消
    return t;
  });
}

/** 时值减半：有增时线先去掉一半拍数（`5 - - -` → `5 -`），否则加一条减时线。 */
export function halve(ctx: EditCtx, from: number, to: number): EditOutcome {
  const removals: EditResult["changes"] = [];
  const out = rewriteNotes(ctx, from, to, (t, e) => {
    const su = ctx.dialect.sustain === "token" ? sustainsOf(ctx, e) : [];
    const beats = 1 + (ctx.dialect.sustain === "token" ? su.length : t.inlineSustains);
    if (beats > 1) {
      const keep = Math.floor(beats / 2) - 1;
      if (ctx.dialect.sustain === "inline") t.inlineSustains = keep;
      else for (const s of su.slice(keep)) removals.push(spaceAround(ctx, s.from, s.to));
      return t;
    }
    if (t.halvings >= 4) return "减时线最多四条";
    t.halvings += 1;
    return t;
  });
  return withExtra(ctx, out, removals);
}

/** 时值加倍：有减时线先去一条，否则拍数翻倍（加增时线）。 */
export function double(ctx: EditCtx, from: number, to: number): EditOutcome {
  const inserts: EditResult["changes"] = [];
  const out = rewriteNotes(ctx, from, to, (t, e) => {
    if (t.halvings > 0) {
      t.halvings -= 1;
      return t;
    }
    const su = ctx.dialect.sustain === "token" ? sustainsOf(ctx, e) : [];
    const beats = 1 + (ctx.dialect.sustain === "token" ? su.length : t.inlineSustains);
    if (beats >= 8) return "已经够长了";
    if (ctx.dialect.sustain === "inline") t.inlineSustains += beats;
    else {
      const at = groupEnd(ctx, e);
      inserts.push({ from: at, to: at, insert: (ctx.dialect.sep + "-").repeat(beats) });
    }
    return t;
  });
  return withExtra(ctx, out, inserts);
}

/** 把额外的补丁（增删增时线）并进一次改写的结果，选区重新映射。 */
function withExtra(ctx: EditCtx, out: EditOutcome, extra: EditResult["changes"]): EditOutcome {
  if (isError(out) || extra.length === 0) return out;
  // `out` 的选区是按它自己那组补丁映射的；并进额外补丁后要按全部补丁重映射回原文再映射
  const base = out.changes;
  const inv = ctx.state.changes(base);
  const origAnchor = inv.invertedDesc.mapPos(out.anchor, -1);
  const origHead = inv.invertedDesc.mapPos(out.head, 1);
  const changes = [...base, ...extra].sort((a, b) => a.from - b.from);
  const map = mapper(ctx.state, changes);
  // 加在音符后面的增时线不进选区：选区末端贴着原来的 token 尾（assoc -1）
  return { changes, anchor: map(origAnchor, 1), head: map(origHead, -1) };
}

// ───────────────────────── 插入 ─────────────────────────

/** 在 `pos` 处插入一段 token，按需补分隔（两边不是空白、行首行尾、括号时才补）。 */
export function spacedInsert(ctx: EditCtx, pos: number, tok: string): { change: EditResult["changes"][number]; start: number; end: number } {
  const doc = ctx.state.doc;
  const left = pos > 0 ? doc.sliceString(pos - 1, pos) : "\n";
  const right = pos < doc.length ? doc.sliceString(pos, pos + 1) : "\n";
  const sep = ctx.dialect.sep;
  const before = /\s|\(/.test(left) ? "" : sep;
  const after = /\s|\)/.test(right) ? "" : sep;
  const insert = before + tok + after;
  return { change: { from: pos, to: pos, insert }, start: pos + before.length, end: pos + before.length + tok.length };
}

/** 插入一个音符（插入模式）。插完光标落在它后面，仍是插入模式。 */
export function insertNote(ctx: EditCtx, pos: number, degree: number, dur: NoteDuration): EditOutcome {
  const r = spacedInsert(ctx, pos, ctx.dialect.newNote(degree, dur, noteCtx(ctx, pos)));
  return { changes: [r.change], anchor: r.end, head: r.end };
}

/** 在 `pos` 处插入一个独立 token（小节线、换行符……），光标落在它后面。 */
export function insertToken(ctx: EditCtx, pos: number, tok: string): EditOutcome {
  const r = spacedInsert(ctx, pos, tok);
  return { changes: [r.change], anchor: r.end, head: r.end };
}

/** 在音符后面加一条增时线（编辑模式：选中音符之后；插入模式：光标前那个音符之后）。 */
export function addSustain(ctx: EditCtx, note: SyncEntry): EditOutcome {
  if (ctx.dialect.sustain === "inline") {
    return rewriteNotes(ctx, note.from, note.to, (t) => {
      t.inlineSustains += 1;
      return t;
    });
  }
  const at = groupEnd(ctx, note);
  const insert = ctx.dialect.sep + "-";
  const map = mapper(ctx.state, [{ from: at, to: at, insert }]);
  const { head } = noteSpans(ctx, note);
  return { changes: [{ from: at, to: at, insert }], anchor: map(head.from, -1), head: map(head.to, -1) };
}

// ───────────────────────── 删除 ─────────────────────────

/** 删掉 `[from, to)` 时顺手带走一侧的空白，免得留下两个空格或行尾空格。 */
export function spaceAround(ctx: EditCtx, from: number, to: number): EditResult["changes"][number] {
  const doc = ctx.state.doc;
  const ch = (i: number): string => (i >= 0 && i < doc.length ? doc.sliceString(i, i + 1) : "\n");
  if (ch(from - 1) === " " && /[ \n]/.test(ch(to))) return { from: from - 1, to, insert: "" };
  if (ch(to) === " " && /[\n(]/.test(ch(from - 1))) return { from, to: to + 1, insert: "" };
  return { from, to, insert: "" };
}

/** 一个条目删的时候连带删掉的原文区间：音符带上它的增时线与挂在它上面的和弦名、装饰；弧成对删括号。 */
function spansToDelete(ctx: EditCtx, e: SyncEntry): { from: number; to: number }[] {
  if (e.kind === "note") {
    const out = [{ from: e.from, to: e.to }];
    for (const s of sustainsOf(ctx, e)) out.push({ from: s.from, to: s.to });
    for (const m of ctx.sync.marksOf(e.id)) if (m.markKind !== "slur" && m.id === e.id) out.push({ from: m.from, to: m.to });
    return out;
  }
  if (e.kind === "mark" && e.pair) return [{ from: e.from, to: e.to }, e.pair];
  return [{ from: e.from, to: e.to }];
}

/** 删掉这些条目。删完光标落在删除处（插入模式）。 */
export function deleteEntries(ctx: EditCtx, entries: SyncEntry[]): EditOutcome {
  if (entries.length === 0) return { error: "没有选中可删的东西" };
  const raw = entries.flatMap((e) => spansToDelete(ctx, e)).sort((a, b) => a.from - b.from);
  // 合并重叠的区间，再逐段带走空白
  const merged: { from: number; to: number }[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  const changes = merged.map((r) => spaceAround(ctx, r.from, r.to));
  // 带走的空白可能让相邻两段重叠，再并一次
  const final: EditResult["changes"] = [];
  for (const c of changes) {
    const last = final[final.length - 1];
    if (last && c.from <= last.to) last.to = Math.max(last.to, c.to);
    else final.push({ ...c });
  }
  const map = mapper(ctx.state, final);
  const at = map(merged[0]!.from, -1);
  return { changes: final, anchor: at, head: at };
}

// ───────────────────────── 圆滑线 / 延音线 ─────────────────────────

/** 已有的一条从 `startId` 到 `endId` 的弧（`(` 条目，带 `pair`）。 */
function slurBetween(ctx: EditCtx, startId: number, endId: number): SyncEntry | null {
  return ctx.sync.ordered().find((e) => e.kind === "mark" && e.markKind === "slur" && e.id === startId && e.end === endId && !!e.pair && e.from < e.pair.from) ?? null;
}

/** 在 `first` 与 `last` 两个音符之间加一条弧；已有同样起止的就去掉（两个括号一起删）。 */
function toggleArc(ctx: EditCtx, first: SyncEntry, last: SyncEntry, keep: { from: number; to: number }): EditOutcome {
  const d = ctx.dialect;
  const existing = slurBetween(ctx, first.id, last.id);
  let changes: EditResult["changes"];
  if (!existing && !d.slurNesting && crossesSlur(ctx, first, last)) {
    return { error: "这种格式的弧不能嵌套或交叠（括号按先开先闭配对），请先去掉相交的那条" };
  }
  if (d.slurInToken) {
    // 括号写在音符 token 里（`.jpwabc`）：起点 token 前加 `(`、终点 token 后加 `)`；已有同样起止的就各去一个
    if (first === last) return { error: "圆滑线至少连两个音" };
    const a = readNote(ctx, first);
    const b = readNote(ctx, last);
    if (!a || !b) return { error: "看不懂这个音符的写法" };
    const had = ctx.doc?.songs.some((s) => (s.marks ?? []).some((m) => m.type === "slur" && m.start === first.id && m.end === last.id));
    if (had) {
      if (!a.pre.includes(d.slurOpen) || !b.post.includes(d.slurClose)) return { error: "找不到这条弧的括号" };
      a.pre = a.pre.replace(d.slurOpen, "");
      b.post = b.post.replace(d.slurClose, "");
    } else {
      a.pre = d.slurOpen + a.pre;
      b.post = b.post + d.slurClose;
    }
    changes = [
      { from: first.from, to: first.to, insert: d.printNote(a, noteCtx(ctx, first.from)) },
      { from: last.from, to: last.to, insert: d.printNote(b, noteCtx(ctx, last.from)) },
    ];
  } else if (existing) {
    changes = [spaceAroundParen(ctx, existing.from, existing.to), spaceAroundParen(ctx, existing.pair!.from, existing.pair!.to)];
  } else {
    const end = groupEnd(ctx, last);
    changes = [
      { from: first.from, to: first.from, insert: d.slurOpen },
      { from: end, to: end, insert: d.slurClose },
    ];
  }
  changes.sort((x, y) => x.from - y.from);
  const map = mapper(ctx.state, changes);
  return { changes, anchor: map(keep.from, 1), head: map(keep.to, -1) };
}

/** `first`–`last` 这一段与已有的弧交叠（一端在里、一端在外）。 */
function crossesSlur(ctx: EditCtx, first: SyncEntry, last: SyncEntry): boolean {
  const lo = first.from;
  const hi = last.to;
  return ctx.sync.ordered().some((e) => {
    if (e.kind !== "mark" || e.markKind !== "slur" || !e.pair || e.from > e.pair.from) return false;
    const a = e.from;
    const b = e.pair.to;
    return (a < lo && b > lo && b < hi) || (a > lo && a < hi && b > hi) || (a > lo && b < hi) || (a < lo && b > hi);
  });
}

/** 删掉弧的一个括号：括号与相邻的音符之间没有空白，只在它两侧都是空白时带走一个空格。 */
function spaceAroundParen(ctx: EditCtx, from: number, to: number): EditResult["changes"][number] {
  const doc = ctx.state.doc;
  const ch = (i: number): string => (i >= 0 && i < doc.length ? doc.sliceString(i, i + 1) : "\n");
  if (ch(from - 1) === " " && ch(to) === " ") return { from: from - 1, to, insert: "" };
  return { from, to, insert: "" };
}

/** 圆滑线：选区首尾两个音符之间加上或去掉。 */
export function toggleSlur(ctx: EditCtx, from: number, to: number): EditOutcome {
  const notes = notesIn(ctx, from, to);
  if (notes.length < 2) return { error: "先选中要连起来的几个音（至少两个）" };
  return toggleArc(ctx, notes[0]!, notes[notes.length - 1]!, { from, to });
}

/** 延音线：选中的（最后一个）音与后面那个同音高的音之间加上或去掉。 */
export function toggleTie(ctx: EditCtx, from: number, to: number): EditOutcome {
  const note = notesIn(ctx, from, to).pop();
  if (!note) return { error: "先选中一个音符" };
  const after = groupEnd(ctx, note);
  const next = ctx.sync.ordered().find((e) => e.kind === "note" && e.from >= after);
  if (!next) return { error: "后面没有音了" };
  const a = readNote(ctx, note);
  const b = readNote(ctx, next);
  if (!a || !b) return { error: "看不懂这个音符的写法" };
  if (a.degree === 0 || a.degree !== b.degree || a.octave !== b.octave || (a.acc ?? null) !== (b.acc ?? null)) {
    return { error: "延音线只连同音高的两个音；不同音用圆滑线（s）" };
  }
  const tie = ctx.dialect.tie;
  if (tie) {
    // 另有写法的延音线（ABC 的 `-`）：紧跟在前一个音后面
    const at = note.to;
    const has = ctx.state.doc.sliceString(at, at + tie.length) === tie;
    const changes = [has ? { from: at, to: at + tie.length, insert: "" } : { from: at, to: at, insert: tie }];
    const map = mapper(ctx.state, changes);
    return { changes, anchor: map(from, -1), head: map(to, 1) };
  }
  return toggleArc(ctx, note, next, { from, to });
}

// ───────────────────────── 装饰 ─────────────────────────

/** `.jpwabc` token 前缀里的记号组 `{YanYin,ZhongYin}`（文法里 `Articulations` 只有一组）加上或去掉一个名字。 */
function toggleInPre(pre: string, name: string): string {
  const m = /\{((?:DunYin|BoYin|YanYin|ZhongYin)(?:,(?:DunYin|BoYin|YanYin|ZhongYin))*)\}/.exec(pre);
  if (!m) return `{${name}}${pre}`;
  const names = m[1]!.split(",");
  const next = names.includes(name) ? names.filter((n) => n !== name) : [...names, name];
  const group = next.length ? `{${next.join(",")}}` : "";
  return pre.slice(0, m.index) + group + pre.slice(m.index + m[0].length);
}

/** 选中的音符加上或去掉一个常用装饰（延长号、重音）。 */
export function toggleDeco(ctx: EditCtx, from: number, to: number, kind: DecoKind): EditOutcome {
  const deco = ctx.dialect.deco;
  if (!deco) return { error: "这种格式暂不支持在谱面上加记号" };
  const name = deco.names[kind];
  if (deco.place === "inToken") {
    return rewriteNotes(ctx, from, to, (t) => {
      t.pre = toggleInPre(t.pre, name);
      return t;
    });
  }
  const notes = notesIn(ctx, from, to);
  if (notes.length === 0) return { error: "先选中一个音符" };
  const changes: EditResult["changes"] = [];
  for (const e of notes) {
    const has = ctx.sync.marksOf(e.id).find((m) => m.markKind === "deco" && m.name === name && m.id === e.id);
    if (has) changes.push({ from: has.from, to: has.to, insert: "" });
    else {
      const at = deco.place === "before" ? e.from : e.to;
      changes.push({ from: at, to: at, insert: deco.text(name) });
    }
  }
  changes.sort((a, b) => a.from - b.from);
  const map = mapper(ctx.state, changes);
  if (notes.length === 1) {
    const { head } = noteSpans(ctx, notes[0]!);
    return { changes, anchor: map(head.from, 1), head: map(head.to, -1) };
  }
  return { changes, anchor: map(from, -1), head: map(to, 1) };
}
