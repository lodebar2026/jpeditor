// 双向定位：**源文本偏移 ↔ 谱面元素**。
//
// 代码区的光标移到某个音符上，谱面上那个音符亮起来；点谱面上的音符，代码区光标跳过去。
// 两条方向共用这一份索引。
//
// ## 为什么在这一层
//
// 索引建在 **AST 的 `source: SourceSpan`** 上——每个音符、每个歌词音节解析时就记了它在
// 原文里的位置。`PuDoc` 与 `ScoreDoc` 都有这一份（123 经 `model/topu.ts` 转过来时照样带着），
// 所以文本谱与 123 两档共用同一套代码。
//
// **不进 `PagePainter` 接口**：架构 §3.1 明写「高亮不在接口里——三者语义不同」。
// 这里只用各排版器已有的公开取元素方法（`noteGroupEl` / `chordGroupEl`），
// 高亮靠加 CSS 类完成，**不重渲染**（沿用编辑器既有判据）。
//
// ## 歌词音节怎么配到音符
//
// 与 `pu/layout.ts::assignLyrics` 同一条规则：一行曲里按 `takesLyric(el)` 走，
// 逐个配 `line.syllables[cursor++]`。**这条规则不要在别处再写第四遍**——
// `layout.ts`、`toscore.ts`、`toxml.ts` 已经各有一份，再漂移就对不上位了。

import type { LyricSyllable, MusicElement, NoteElement, PuDoc, SourceSpan } from "../pu";
import { takesLyric } from "../pu/ast";

/** 索引里的一条：原文的一段 ↔ 谱面上的一个东西。 */
export interface SyncEntry {
  /** 原文区间（0 基字符偏移，`to` 不含） */
  from: number;
  to: number;
  /** 挂在哪个音符上（歌词音节也归到它跟的那个音符） */
  note: NoteElement;
  /** 命中的是第几段歌词（0 基）；命中的是音符本身时为 null */
  verse: number | null;
}

const spanEnd = (s: SourceSpan): number => s.offset + s.length;

/** 源文本偏移 ↔ 谱面元素的双向索引。`build` 之后两个方向都是 O(log n) / O(1)。 */
export class SyncIndex {
  /** 按 `from` 升序；同起点时短的在前（歌词音节的区间比曲行短） */
  private entries: SyncEntry[] = [];
  /** 音符 → 它自己那条（`verse === null`） */
  private byNote = new Map<NoteElement, SyncEntry>();

  get size(): number {
    return this.entries.length;
  }

  /** 从 AST 重建。文本一变就要重建——偏移全变了。 */
  build(doc: PuDoc): void {
    const out: SyncEntry[] = [];
    this.byNote.clear();
    for (const song of doc.songs) {
      for (const page of song.pages) {
        for (const group of page.groups) {
          for (const voice of group.voices) {
            const anchors: MusicElement[] = voice.elements.filter(takesLyric);
            for (const el of voice.elements) {
              if (el.kind !== "note") continue;
              const e: SyncEntry = {
                from: el.source.offset,
                to: spanEnd(el.source),
                note: el,
                verse: null,
              };
              // 零长区间（转换来的元素可能没有真实 span）不进索引：二分会退化成乱命中
              if (e.to > e.from) {
                out.push(e);
                this.byNote.set(el, e);
              }
            }
            // 歌词：与 `layout.ts::assignLyrics` 同一条配位规则
            voice.lyrics.forEach((line, verse) => {
              line.syllables.forEach((syl: LyricSyllable, i) => {
                const anchor = anchors[i];
                if (!anchor || anchor.kind !== "note") return;
                if (syl.text.length === 0) return; // 空音节是「跳过一个音符」，没有原文可指
                const to = spanEnd(syl.source);
                if (to > syl.source.offset) {
                  out.push({ from: syl.source.offset, to, note: anchor, verse });
                }
              });
            });
          }
        }
      }
    }
    // **按偏移排序**——`at()` 的二分依赖它。同起点时短的在前。
    out.sort((a, b) => a.from - b.from || a.to - b.to);
    this.entries = out;
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

  /** 全部条目，**音符条目在前、歌词条目在后**——建「谱面元素 → 条目」的反查表时，
   *  展开档里音符与它的歌词共用一个 `<g>`，先来的音符条目该占住它。
   *  （`entries` 本身必须保持按偏移排序，那是 `at()` 的二分所依赖的。） */
  all(): SyncEntry[] {
    return [...this.entries].sort(
      (a, b) => (a.verse === null ? 0 : 1) - (b.verse === null ? 0 : 1),
    );
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
  spanOfNote(note: NoteElement): { from: number; to: number } | null {
    return this.byNote.get(note) ?? null;
  }
}
