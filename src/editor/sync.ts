// 双向定位：**源文本偏移 ↔ 谱面元素**。
//
// 代码区的光标移到某个音符上，谱面上那个音符亮起来；点谱面上的音符，代码区光标跳过去。
// 两条方向共用这一份索引。可视化编辑（`editor/visual/`）也读它：选中、方向键导航、删除都按条目走。
//
// ## 为什么在这一层
//
// 索引建在 **`ScoreDoc` 的 `source: SourceSpan`** 上——每个音符、每个歌词音节解析时就记了它在
// 原文里的位置（文本谱经 `model/frompu.ts` 转来时照样带着）。有代码区的四种格式（文本谱、123、ABC、
// `.jpwabc`）共用同一套代码。条目按**元素 id** 认，谱面那一侧（`ScorePainter.entryEl(id)` /
// `lyricEl` / `partEls`）也按 id 取，两路页面树的差别由排版器自己消化。
//
// 这里不碰页面树，只经 App（VisualHost）拿排版器给的 `<g>`，
// 高亮靠加 CSS 类完成，**不重渲染**（沿用编辑器既有判据）。
//
// ## 条目的种类
//
// | kind | 原文 | `id`（谱面上靠哪个音符定位） |
// |---|---|---|
// | `note` | 音符/休止 token | 它自己 |
// | `lyric` | 歌词音节 | 它跟的那个音符 |
// | `sustain` | 增时线 `-` | 宿主音符（`own` 是增时线自己的 id） |
// | `barline` | 小节线 | 小节线前面那个元素 |
// | `mark` | 和弦名、装饰、注记（`AttachedSource`），slur 的 `(` 与 `)` 各一条 | 宿主 / 弧的起点 |
// | `break` | 换行/换页符号 | 符号前面那个元素 |
// | `header` | 页眉字段的值（标题、署名、调号拍号…） | 不用（-1）；模型里不记位置，按格式从原文认（`EditDialect.headerFields`），谱面按字对上（`App._bindHeader`） |
//
// 增时线、小节线、弧现在没有自己的 `<g>`，谱面上借宿主音符的 `<g>` 定位；和弦名、装饰、注记按类名在音符格里认出自己的
// （`App._markPartEl`）。统一 ScorePainter 落地后改接它的 `locate`。
//
// ## 歌词音节怎么配到音符
//
// 走排版行视图（`pu/slots.ts::docView`）：音节配给哪个音符在视图里已经定好（`syllableOwner`），
// 与排版器、简谱引擎输入用的是**同一份**，不在这里另算。

import type { AttachedSource, Chord, ElementId, Measure, Part, ScoreDoc, SourceSpan } from "../model/doc";
import { breakAfter } from "../model/helpers";
import { docView } from "../pu/slots";

export type SyncKind = "note" | "lyric" | "sustain" | "barline" | "mark" | "break" | "header";

/** 索引里的一条：原文的一段 ↔ 谱面上的一个东西。 */
export interface SyncEntry {
  kind: SyncKind;
  /** 原文区间（0 基字符偏移，`to` 不含） */
  from: number;
  to: number;
  /** 谱面上靠哪个音符定位（见文件头的表） */
  id: ElementId;
  /** 命中的是第几段歌词（0 基）；不是歌词时为 null */
  verse: number | null;
  /** 歌词：原文里的段号（`W2`、`w:` 第 2 行为 2）。一行里缺了某段时与 `verse + 1` 不同 */
  verseNo?: number;
  /** 增时线自己的 id */
  own?: ElementId;
  /** `mark`：挂的是什么（`AttachedSource.kind`，或 slur 的 `"slur"`）与记号名 */
  markKind?: AttachedSource["kind"] | "slur";
  name?: string;
  /** slur：终点音符（Tab 在起点、终点上都能轮到它） */
  end?: ElementId;
  /** 成对符号的另一半（slur 的 `(` 条目指向 `)`、`)` 条目指向 `(`；另一半没记位置时缺省） */
  pair?: { from: number; to: number };
  /** `break`：换页 */
  page?: boolean;
  /** `header`：调号、拍号、两样写在一处（`header.ts::HeaderRole`）；文字字段缺省 */
  headerRole?: "key" | "time" | "keytime";
}

/** 一处换行/换页（谱面显示换行符用）。原文里没有符号可指（文本谱另起一行 `Q:`、ABC 的代码行末）时 `span` 为 null。 */
export interface BreakMark {
  page: boolean;
  /** 符号前面那个元素：谱面上换行符画在它右边 */
  after: ElementId;
  span: { from: number; to: number } | null;
}

const spanEnd = (s: SourceSpan): number => s.offset + s.length;
const hasSpan = (s: SourceSpan | undefined): s is SourceSpan => !!s && s.length > 0;

/** 源文本偏移 ↔ 谱面元素的双向索引。`build` 之后两个方向都是 O(log n) / O(1)。 */
export class SyncIndex {
  /** 按 `from` 升序；同起点时短的在前（歌词音节的区间比曲行短） */
  private entries: SyncEntry[] = [];
  /** 音符 id → 它自己那条（`kind === "note"`） */
  private byNote = new Map<ElementId, SyncEntry>();
  private breakList: BreakMark[] = [];

  get size(): number {
    return this.entries.length;
  }

  /** 从模型重建。文本一变就要重建——偏移全变了。 */
  build(doc: ScoreDoc): void {
    const view = docView(doc);
    const out: SyncEntry[] = [];
    this.byNote.clear();
    for (const song of view.songs) {
      for (const page of song.pages) {
        for (const group of page.groups) {
          for (const row of group.voices) {
            for (const el of row.elements) {
              if (el.kind !== "note") continue;
              const id = view.idOf.get(el);
              if (id === undefined) continue;
              const e: SyncEntry = { kind: "note", from: el.source.offset, to: spanEnd(el.source), id, verse: null };
              // 零长区间（转换来的元素可能没有真实 span）不进索引：二分会退化成乱命中
              if (e.to > e.from) {
                out.push(e);
                this.byNote.set(id, e);
              }
            }
            row.lyrics.forEach((line, verse) => {
              for (const syl of line.syllables) {
                if (syl.text.length === 0) continue; // 空音节是「跳过一个音符」，没有原文可指
                const id = view.syllableOwner.get(syl);
                if (id === undefined || view.elementOf.get(id)?.kind !== "note") continue;
                const to = spanEnd(syl.source);
                if (to > syl.source.offset) out.push({ kind: "lyric", from: syl.source.offset, to, id, verse, verseNo: line.verseFrom });
              }
            });
          }
        }
      }
    }
    // 音符以外的东西直接从模型取（视图里它们不带原文区间）
    this.breakList = [];
    for (const song of doc.songs) {
      song.parts.forEach((part, pi) => {
        this.addPartExtras(part, out);
        // 换行符只按第一声部显示：多声部各行一起换，画一遍就够
        if (pi === 0) this.breakList.push(...partBreaks(part));
      });
      for (const mk of song.marks ?? []) {
        if (mk.type !== "slur" || !hasSpan(mk.openSource)) continue;
        const open = { from: mk.openSource.offset, to: spanEnd(mk.openSource) };
        const close = hasSpan(mk.closeSource) ? { from: mk.closeSource.offset, to: spanEnd(mk.closeSource) } : undefined;
        const base = { kind: "mark" as const, id: mk.start, end: mk.end, verse: null, markKind: "slur" as const, name: "slur" };
        out.push({ ...base, ...open, ...(close ? { pair: close } : {}) });
        if (close) out.push({ ...base, ...close, pair: open });
      }
    }
    for (const b of this.breakList) {
      if (b.span) out.push({ kind: "break", ...b.span, id: b.after, verse: null, page: b.page });
    }
    // **按偏移排序**——`at()` 的二分依赖它。同起点时短的在前。
    out.sort((a, b) => a.from - b.from || a.to - b.to);
    this.entries = out;
  }

  /** 一个声部里的增时线、小节线、挂载记号。 */
  private addPartExtras(part: Part, out: SyncEntry[]): void {
    let lastId: ElementId | null = null;
    for (const m of part.measures) {
      for (const bl of m.barlines ?? []) {
        if (bl.location !== "left" || !hasSpan(bl.source)) continue;
        const first = m.elements[0]?.id ?? lastId;
        if (first !== null) out.push({ kind: "barline", from: bl.source.offset, to: spanEnd(bl.source), id: first, verse: null });
      }
      for (const el of m.elements) {
        pushAttached(el.attachedSources, el.id, out);
        if (el.kind !== "chord") continue;
        for (const su of el.sustains ?? []) {
          if (hasSpan(su.source)) {
            out.push({ kind: "sustain", from: su.source.offset, to: spanEnd(su.source), id: el.id, own: su.id, verse: null });
          }
          pushAttached(su.attachedSources, el.id, out);
        }
        lastId = el.id;
      }
      for (const bl of m.barlines ?? []) {
        if (bl.location === "left" || !hasSpan(bl.source) || lastId === null) continue;
        out.push({ kind: "barline", from: bl.source.offset, to: spanEnd(bl.source), id: lastId, verse: null });
      }
    }
  }

  /** 并进页眉字段（原文里认出来的，见 `EditDialect.headerFields`）。重建索引后调一次。 */
  addHeader(fields: readonly { from: number; to: number; role: "text" | "key" | "time" | "keytime" }[]): void {
    const extra: SyncEntry[] = fields
      .filter((f) => f.to > f.from)
      .map((f) => ({ kind: "header", from: f.from, to: f.to, id: -1, verse: null, ...(f.role !== "text" ? { headerRole: f.role } : {}) }));
    if (extra.length === 0) return;
    this.entries = [...this.entries, ...extra].sort((a, b) => a.from - b.from || a.to - b.to);
  }

  /** 落在这个偏移上的那一条。命中不了返回 null（光标在头部字段、注释、空白里都算不中）。 */
  at(offset: number): SyncEntry | null {
    const es = this.entries;
    // 最后一条 from <= offset 的
    let lo = 0;
    let hi = es.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (es[mid]!.from <= offset) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // 同起点可能有多条（短的在前），往回找一条真正盖住 offset 的
    for (let i = k; i >= 0 && i > k - 8; i--) {
      const e = es[i]!;
      if (offset >= e.from && offset < e.to) return e;
    }
    return null;
  }

  /** 全部条目，**音符条目在前、其余在后**——建「谱面元素 → 条目」的反查表时，
   *  展开档里音符与它的歌词共用一个 `<g>`，增时线与记号也借宿主的 `<g>`，先来的音符条目该占住它。
   *  （`entries` 本身必须保持按偏移排序，那是 `at()` 的二分所依赖的。） */
  all(): SyncEntry[] {
    const rank = (e: SyncEntry): number => (e.kind === "note" ? 0 : e.kind === "lyric" ? 1 : 2);
    return [...this.entries].sort((a, b) => rank(a) - rank(b));
  }

  /** 按原文顺序的全部条目（方向键导航用）。 */
  ordered(): readonly SyncEntry[] {
    return this.entries;
  }

  /** 与 `[from, to)` 有交叠的全部条目（文本框选 → 谱面多处高亮）。 */
  range(from: number, to: number): SyncEntry[] {
    if (to <= from) {
      const one = this.at(from);
      return one ? [one] : [];
    }
    return this.entries.filter((e) => e.from < to && e.to > from);
  }

  /** 一个音符对应的原文区间（谱面 → 文本用）。 */
  spanOfNote(id: ElementId): { from: number; to: number } | null {
    return this.byNote.get(id) ?? null;
  }

  /** 挂在这个音符上的记号条目（和弦名、装饰、注记、从它起或到它止的弧），按原文顺序。 */
  marksOf(id: ElementId): SyncEntry[] {
    const seen = new Set<string>();
    return this.entries.filter((e) => {
      if (e.kind !== "mark" || (e.id !== id && e.end !== id)) return false;
      // 弧的 `(` 与 `)` 算一个记号，只留先出现的那条
      const key = e.pair ? `${Math.min(e.from, e.pair.from)}` : `${e.from}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** 全部换行/换页（含原文里没有符号可指的），谱面按它画换行符。 */
  breaks(): readonly BreakMark[] {
    return this.breakList;
  }
}

function pushAttached(list: AttachedSource[] | undefined, id: ElementId, out: SyncEntry[]): void {
  for (const a of list ?? []) {
    if (!hasSpan(a.source)) continue;
    out.push({ kind: "mark", from: a.source.offset, to: spanEnd(a.source), id, verse: null, markKind: a.kind, name: a.name });
  }
}

/** 一个声部里的全部换行：小节级（`Print` / `Part.endBreak`）与小节中间（`lineBreakAfter`），
 *  再按「符号前面那个元素」对上原文里记下的符号位置（`Part.breakSources`）。 */
function partBreaks(part: Part): BreakMark[] {
  const spans = new Map<ElementId | null, SourceSpan[]>();
  for (const b of part.breakSources ?? []) {
    const list = spans.get(b.after) ?? [];
    list.push(b.source);
    spans.set(b.after, list);
  }
  const take = (after: ElementId): { from: number; to: number } | null => {
    const s = spans.get(after)?.shift();
    return s ? { from: s.offset, to: spanEnd(s) } : null;
  };
  const out: BreakMark[] = [];
  const lastOf = (m: Measure): ElementId | null => m.elements[m.elements.length - 1]?.id ?? null;
  part.measures.forEach((m, i) => {
    let inline = false;
    for (const el of m.elements) {
      if (el.kind !== "chord") continue;
      const kind = inlineBreakOf(el);
      if (!kind) continue;
      out.push({ page: kind === "page", after: el.id, span: take(el.id) });
      inline = true;
    }
    // 小节中间换过行的，下一小节那份小节级换行是同一处（`Chord.lineBreakAfter` 的口径），不重复画
    const kind = breakAfter(part, i);
    const after = lastOf(m);
    if (!kind || inline || after === null) return;
    // 声部末尾的换行（`Part.endBreak`）只在原文里真有符号时画：文本谱每行行尾都记了一份
    const span = take(after);
    if (i === part.measures.length - 1 && !span) return;
    out.push({ page: kind === "page", after, span });
  });
  return out;
}

/** 和弦（或它的某条增时线）后面的小节中间换行。 */
function inlineBreakOf(ch: Chord): "system" | "page" | null {
  if (ch.lineBreakAfter) return ch.lineBreakAfter;
  for (const su of ch.sustains ?? []) if (su.lineBreakAfter) return su.lineBreakAfter;
  return null;
}
