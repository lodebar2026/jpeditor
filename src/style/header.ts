// 页眉四项（标题、副标题、经文、词曲作者）的字体与字号：三档排版器（简谱引擎、文本谱原样、五线谱/混排）共用一份。
//
// 来源按级联：内置主题 → 曲内层（MusicXML `<credit-words>` 的字体，`headerLayerOfSong`）→ 用户层（设置面板「页眉」一组，
// 不带限定、各档共用）。**没写的项返回 undefined**，各排版器保留自己的出厂值——不改设置时版面一点不动。
//
// 无 DOM 依赖。
import type { Song } from "../model/doc";
import { HEADER_ROLES, songHeaderFonts, type HeaderFontSpec, type HeaderRole } from "../model/pagemeta";
import type { StyleRule } from "./cascade";
import { familyOfRole } from "./fonts";
import type { RoleDecl, StyleSheet } from "./sheet";
import { resolveLength } from "./units";

export { HEADER_ROLES, headerRoleOfCredit, type HeaderRole } from "../model/pagemeta";
export const HEADER_LABEL: Readonly<Record<HeaderRole, string>> = {
  title: "标题",
  subtitle: "副标题",
  scripture: "经文",
  credit: "词曲作者",
};

/** 一项页眉文字的字体：族（CSS font-family）、字号（pt）、粗体。 */
export interface HeaderFont {
  family?: string;
  size?: number;
  bold?: boolean;
}
export type HeaderFonts = Partial<Record<HeaderRole, HeaderFont>>;

/** 样式表 → 页眉四项。只报写了的。 */
export function headerFontsOf(sheet: StyleSheet): HeaderFonts {
  const out: HeaderFonts = {};
  for (const role of HEADER_ROLES) {
    const f: HeaderFont = {};
    const fam = familyOfRole(sheet, role);
    if (fam?.family) f.family = fam.family;
    if (fam?.bold) f.bold = true;
    const v = sheet.roles[role]?.size;
    const pt = v === undefined ? null : resolveLength(v, { em: NaN, sp: NaN });
    if (pt !== null && Number.isFinite(pt) && pt > 0) f.size = pt;
    if (Object.keys(f).length) out[role] = f;
  }
  return out;
}

/** 曲内层：谱里写的页眉字体——MusicXML `<credit-words>`（同一角色取第一条，没写族退到 `<word-font>`），
 *  或 123/ABC 的 `I:meta font-<角色>`（`model/pagemeta.ts`）。
 *  `sizes: false`：只要族与字重（展开档是投影片，印刷纸上的字号搬过去就太小了）。 */
export function headerLayerOfSong(song: Song | undefined, { sizes = true }: { sizes?: boolean } = {}): StyleRule[] {
  if (!song) return [];
  const roles: Partial<Record<HeaderRole, RoleDecl>> = {};
  for (const [role, f] of Object.entries(songHeaderFonts(song)) as [HeaderRole, HeaderFontSpec][]) {
    const d: RoleDecl = {};
    if (f.family) d.family = f.family;
    if (sizes && f.size) d.size = f.size;
    if (f.bold) d.weight = "bold";
    if (Object.keys(d).length) roles[role] = d;
  }
  return Object.keys(roles).length ? [{ set: { roles } }] : [];
}
