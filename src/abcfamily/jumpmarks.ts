// 小节线上的跳转记号（`Barline.ornaments`）在 123 里的写法。规范 §4.14：`!segno! !coda! !D.S.! !D.C.! !fine!`。
//
// 内部用的是 `.jpwabc`/文本谱那套短名（`hs`=segno 𝄋、`ty`=coda ⊕，见 `pu/glyph.ts::BARLINE_MARKS`），
// 写出去要换成规范里的名字，读回来再换一次。
//
// **写在线的哪一侧决定它挂哪条线**（emit/parse 两边同一约定）：
//   · 左线的记号写在线**之后**（`| !segno! 6 …`）——segno/coda 是跳转的目标，落点是这条线；
//   · 右线的记号写在线**之前**（`… 6 !fine! |]`）——D.S./D.C./Fine 是唱到这里才跳。

/** 内部短名 → 123 记号名。 */
export const BARLINE_ORNAMENT_NAME: Readonly<Record<string, string>> = {
  hs: "segno",
  ty: "coda",
  ds: "D.S.",
  dc: "D.C.",
  fine: "fine",
};

/** 123 记号名（小写、去掉点）→ 内部短名。`dacapo`/`dalsegno`/`dacoda` 是 ABC §4.14 的别名，只认不写。 */
const BY_123: Readonly<Record<string, string>> = {
  segno: "hs",
  coda: "ty",
  ds: "ds",
  dc: "dc",
  dalsegno: "ds",
  dacapo: "dc",
  dacoda: "ty",
  tocoda: "ty",
  fine: "fine",
};

/** 123 的 `!xx!` 名字是不是小节线上的跳转记号；是则给出内部短名。 */
export function jumpOrnamentName(deco: string): string | undefined {
  return BY_123[deco.trim().toLowerCase().replace(/[.\s]/g, "")];
}
