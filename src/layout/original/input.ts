// 原样文档布局的输入（`docs/实现/PuPainter退役.md` §4.2 / P3）：整份文档按歌曲、页、谱行组、声部行组织。
//
// **不另造语义模型**，直接用 `pu/slots.ts::docView` 的只读视图——§4.2 草案里的各层都已在其中：
//   - 歌曲：`songs[i]`（`SongView`，下标即 ScoreDoc 的歌曲下标；`metadata` 给标题与元信息，纯文字歌曲照样有）；
//   - 块：`songs[i].pages[j].groups`（`SystemView`：`voices` 为声部行，多于一行时 `place.ts` 给连谱号；`texts` 为本组之前的
//     独立 `W:` 文字行，不挂到和弦上；页即源里的显式分页 `[fenye]`）；
//   - 声部行：`RowView`（`ScoreLine` + `part` + `refs: SlotRef[]`，槽位锚到元素 id，没有 id 的符号也有槽位）；
//   - 临时层：行内的 `InlineLayerElement`（`{bz}` 伴奏 / `{dsb}` 局部多声部），宿主是它所在的槽位、
//     时长由层内元素的拍值定（`place.ts::placeLayers`）。
// 身份：`idOf` / `elementOf` / `syllableOwner` 把排版行的元素与歌词音节对回 ScoreDoc 的元素 id。
// 源码区间（SourceSpan、attachedSources、breakSources、弧两端 source、歌词源码位置）不进这份输入：
// 编辑索引（`editor/sync.ts`）每次从本版 ScoreDoc 自己读。

import type { ScoreDoc } from "../../model/doc";
import { docView, type DocView } from "../../pu/slots";

export type OriginalDocumentInput = DocView;

/** ScoreDoc → 原样文档布局输入（全部歌曲）。 */
export function originalInputOf(doc: ScoreDoc): OriginalDocumentInput {
  return docView(doc);
}
