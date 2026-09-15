// 书清单 `book.json`：一本歌本有哪些歌、什么顺序、逐曲 meta 覆盖、引用哪份 `.jpcss`。
// 格式见 docs/格式/jpcss.md §8。清单是**数据**，版式在 `.jpcss` 里。
//
// 无 DOM 依赖。
import type { Creator, Song, SongMeta } from "../model/doc";
import { overlayMeta } from "../model/metakeys";

export interface ManifestSong {
  /** 谱文件，相对清单里的 `root`（或清单文件所在目录） */
  file: string;
  /** 曲号（目录、`@song #曲号` 限定用） */
  number?: string;
  /** 覆盖谱文件里的标题（目录与标题块都用它） */
  title?: string;
  /** 覆盖词曲署名（整组替换）。`type` 缺省时按原文标签定。 */
  creators?: Creator[];
  /** 覆盖版权 */
  rights?: string;
  /** 按键浅覆盖 `Song.meta` */
  meta?: SongMeta;
}

export interface BookManifest {
  id: string;
  title: string;
  /** 歌本样式表（`.jpcss`）路径 */
  style: string;
  /** 按装页口径叠加的样式表：键是 `@flow song-start` 的档，值是 `.jpcss` 路径，
   *  解析出的规则接在 `style` 之后（后者覆盖前者）。同一本书两种口径的差异写在这里，
   *  不要为此复制整份样式表。 */
  styleByFlow?: Partial<Record<"new-page" | "continue", string>>;
  /** 谱文件根目录 */
  root?: string;
  songs: ManifestSong[];
}

/** 清单项覆盖到读进来的谱上（就地改）。 */
export function applyManifestSong(song: Song, entry: ManifestSong): void {
  if (entry.title !== undefined) song.work.title = entry.title;
  if (entry.number !== undefined) song.work.number = entry.number;
  if (entry.creators !== undefined || entry.rights !== undefined) {
    const id = (song.identification ??= { creators: [] });
    if (entry.creators !== undefined) id.creators = entry.creators.map((c) => ({ ...c }));
    if (entry.rights !== undefined) id.rights = entry.rights;
  }
  const meta = overlayMeta(song.meta, entry.meta);
  if (meta) song.meta = meta;
}

/** 校验清单形状（手写的 JSON 可能是任何东西）。 */
export function parseManifest(text: string): BookManifest {
  const m = JSON.parse(text) as BookManifest;
  if (!m || typeof m !== "object" || !Array.isArray(m.songs) || typeof m.style !== "string") {
    throw new Error("book.json 至少要有 style 与 songs");
  }
  for (const [i, s] of m.songs.entries()) {
    if (typeof s.file !== "string") throw new Error(`book.json songs[${i}] 缺 file`);
  }
  return m;
}
