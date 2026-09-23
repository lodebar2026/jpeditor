// 页眉四项（标题、副标题、经文、词曲作者）的字体与字号：三档排版器（简谱引擎、文本谱原样、五线谱/混排）共用一份。
//
// 来源按级联：内置主题 → 曲内层（MusicXML `<credit-words>` 的字体，`headerLayerOfSong`）→ 用户层（设置面板「页眉」一组，
// 不带限定、各档共用）。**没写的项返回 undefined**，各排版器保留自己的出厂值——不改设置时版面一点不动。
//
// 无 DOM 依赖。
import type { Song } from "../model/doc";
import type { StyleRule } from "./cascade";
import { familyOfRole } from "./fonts";
import type { RoleDecl, StyleSheet } from "./sheet";
import { resolveLength } from "./units";

export type HeaderRole = "title" | "subtitle" | "scripture" | "credit";
export const HEADER_ROLES: readonly HeaderRole[] = ["title", "subtitle", "scripture", "credit"];
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

/** MusicXML 的 `<credit>` 按类型归到页眉角色（`credit-type`；没写类型的按版面：页首居中最大的是标题，靠右的是词曲）。
 *  五线谱排版器画 credit 时也用它（`mixed/staffpages.ts`）。 */
export function headerRoleOfCredit(type: string | undefined, justify: string | undefined, biggest: boolean): HeaderRole | null {
  switch (type?.trim()) {
    case "title": return "title";
    case "subtitle": return "subtitle";
    case "scripture": return "scripture";
    case "composer": case "lyricist": case "arranger": case "poet": case "words": case "translator": return "credit";
    case undefined: case "": break;
    default: return null;
  }
  if (biggest && justify !== "right") return "title";
  if (justify === "right") return "credit";
  return null;
}

/** 曲内层：谱里 `<credit-words>` 自带的字体（同一角色取第一条）；某角色没写族时退到 `<defaults><word-font>`。
 *  `sizes: false`：只要族与字重（展开档是投影片，印刷纸上的字号搬过去就太小了）。 */
export function headerLayerOfSong(song: Song | undefined, { sizes = true }: { sizes?: boolean } = {}): StyleRule[] {
  const credits = song?.credits ?? [];
  if (!credits.length) return [];
  const maxSize = Math.max(0, ...credits.map((c) => c.fontSize ?? 0));
  const roles: Partial<Record<HeaderRole, RoleDecl>> = {};
  for (const c of credits) {
    const role = headerRoleOfCredit(c.type, c.justify, maxSize > 0 && c.fontSize === maxSize);
    if (!role || roles[role]) continue;
    const d: RoleDecl = {};
    const family = c.fontFamily ?? song?.defaults?.wordFont?.family;
    if (family) d.family = family;
    if (sizes && c.fontSize) d.size = c.fontSize;
    if (c.fontWeight === "bold") d.weight = "bold";
    if (Object.keys(d).length) roles[role] = d;
  }
  return Object.keys(roles).length ? [{ set: { roles } }] : [];
}
