// 音符记号的别名表。123 的 `!xx!` **几种记法都认**（规范 §8.3）：文本谱的拼音短名（`dy`）、
// ABC 名（`staccato` `uppermordent`）、MusicXML 元素名（`inverted-mordent`）、中文名（`顿音`）。
//
// 模型里记号**原名照存**（写回 123 时原样写，作者写什么就还是什么），**用的地方先归一**：
// 简谱排版（`pu/slots.ts`，字形表 `pu/glyph.ts::ORNAMENTS` 按短名查）、文本谱写出（`topu.ts`）、
// MusicXML 投影（`xmlproject.ts`）、识别回归的奏法档。以前各处只认自己那一种，
// `!staccato!` 读得进来、简谱里却不画（识别写出的正是这个名字）。
//
// 归一后的键就是文本谱的 `&xx` 短名——排版字形表、文本谱写出端都按它查。

/** 短名 → 别名。别名里的拉丁字母不分大小写。 */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  yc: ["fermata", "invertedfermata", "延长", "延长记号"],
  ycy: [],
  bc: ["tenuto", "保持音"],
  zy: ["accent", ">", "emphasis", "strong-accent", "重音"],
  dy: ["staccato", "staccatissimo", "顿音"],
  hx: ["breath", "breath-mark", "呼吸", "呼吸记号"],
  shy: ["scoop", "上滑音"],
  xhy: ["falloff", "下滑音"],
  sby: ["uppermordent", "pralltriller", "inverted-mordent", "上波音"],
  xby: ["lowermordent", "mordent", "下波音"],
  cy: [],
  tr: ["trill", "trill-mark", "颤音"],
  // 小节线上的跳转记号（123 的写法与归属见 `abcfamily/jumpmarks.ts`）
  hs: ["segno"],
  ty: ["coda"],
  fine: [],
  dc: ["d.c."],
  ds: ["d.s."],
};

const KEY: ReadonlyMap<string, string> = new Map(
  Object.entries(ALIASES).flatMap(([key, names]) => [[key, key], ...names.map((n) => [n.toLowerCase(), key] as [string, string])]),
);

/** 记号名（任一种记法）→ 短名；认不出返回 undefined。 */
export function decoKey(name: string): string | undefined {
  return KEY.get(name) ?? KEY.get(name.toLowerCase());
}
