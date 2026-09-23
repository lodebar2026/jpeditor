// 谱里自带的纸：MusicXML 的 `<page-layout>`（tenths）与 123/ABC 的 `I:meta page …`（pt）互转。
//
// 以前 MusicXML 转成 123 就把纸丢了，再打开时五线谱/混排只能用设置里那张（见 docs/模块/编辑器.md）。
// 现在转换时把纸写成 meta（`withPageMeta`），123/ABC 写 MusicXML 时再还原成 `<page-layout>`（`xmlproject.ts`）。
// 编辑器里「跟随文件」读的也是这里（`style/paper.ts::songPageDecl`）。
//
// meta 键（`metakeys.ts` 注册）：
//   page              A4 / A5 / B5 / Letter，或「宽 高」（pt）
//   page-orientation  portrait / landscape（只对纸名有意义：「宽 高」本身就带方向）
//   page-margin       上 右 下 左（pt）
//   staff-size        谱表高（五条线的跨度，mm；MusicXML `<scaling>` 的 40 tenths）
//   lyric-size        歌词字号（pt；MusicXML `<lyric-font font-size>`）
//   font-title / font-subtitle / font-scripture / font-credit
//                     页眉四项的字体：「字号 [bold] 字体族」，字号 pt，`-` = 不定字号（MusicXML `<credit-words>` 的字体）
//
// 无 DOM 依赖。
import type { Defaults, ScoreDoc, Song } from "./doc";
import { getMeta } from "./metakeys";

/** 标准纸（pt，竖放）。编辑器纸张表（`style/themes.ts::PAPER_SIZES`）在它之上再加一档「长图」。 */
export const STANDARD_PAPERS: Readonly<Record<string, readonly [number, number]>> = {
  A4: [595, 842],
  A5: [420, 595],
  B5: [499, 709],
  Letter: [612, 792],
};

/** 实际的纸（pt，已按方向转好）与边距 `[上, 右, 下, 左]`。 */
export interface PagePt {
  w: number;
  h: number;
  margins?: [number, number, number, number];
}

/** MusicXML 缺 `<scaling>` 时的换算（与五线谱引擎 `mixed/model.ts::DEFAULT_SCALING` 同值：7mm / 40 tenths）。 */
const DEFAULT_SCALING = { millimeters: 7, tenths: 40 } as const;

const ptPerTenth = (sc: Defaults["scaling"]): number => {
  const s = sc && sc.millimeters > 0 && sc.tenths > 0 ? sc : DEFAULT_SCALING;
  return (s.millimeters * 72) / 25.4 / s.tenths;
};

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** `<page-layout>` → pt。边距取非偶数页那组。 */
export function pageOfDefaults(song: Song): PagePt | null {
  const pl = song.defaults?.pageLayout;
  if (!pl?.pageWidth || !pl.pageHeight) return null;
  const k = ptPerTenth(song.defaults?.scaling);
  const out: PagePt = { w: round1(pl.pageWidth * k), h: round1(pl.pageHeight * k) };
  const mg = pl.margins?.find((m) => m.oddEven !== "even");
  if (mg) out.margins = [round1(mg.top * k), round1(mg.right * k), round1(mg.bottom * k), round1(mg.left * k)];
  return out;
}

/** `I:meta page …` → pt。认不出的写法返回 null。 */
export function pageOfMeta(song: Song): PagePt | null {
  const v = getMeta(song, "page")[0]?.trim();
  if (!v) return null;
  let w: number, h: number;
  const nums = v.split(/\s+/).map(Number);
  const std = Object.entries(STANDARD_PAPERS).find(([k]) => k.toLowerCase() === v.toLowerCase())?.[1];
  if (std) {
    [w, h] = std;
    if (getMeta(song, "page-orientation")[0]?.trim() === "landscape") [w, h] = [h, w];
  } else if (nums.length === 2 && nums.every((n) => Number.isFinite(n) && n > 0)) {
    [w, h] = nums as [number, number];
  } else {
    return null;
  }
  const out: PagePt = { w, h };
  const mg = getMeta(song, "page-margin")[0]?.trim().split(/\s+/).map(Number);
  if (mg?.length === 4 && mg.every((n) => Number.isFinite(n) && n >= 0)) out.margins = mg as PagePt["margins"];
  return out;
}

/** 谱里自带的纸：MusicXML 的优先，其次 meta。 */
export function songPage(song: Song): PagePt | null {
  return pageOfDefaults(song) ?? pageOfMeta(song);
}

/** 标准纸名（±2pt，横竖都认）。 */
export function standardPaperOf(w: number, h: number): { name: string; landscape: boolean } | null {
  const [a, b] = w > h ? [h, w] : [w, h];
  for (const [name, [pw, ph]] of Object.entries(STANDARD_PAPERS)) {
    if (Math.abs(pw - a) <= 2 && Math.abs(ph - b) <= 2) return { name, landscape: w > h };
  }
  return null;
}

/** 纸 → meta 键值。 */
export function pageMeta(page: PagePt): Record<string, string[]> {
  const std = standardPaperOf(page.w, page.h);
  const out: Record<string, string[]> = { page: [std ? std.name : `${page.w} ${page.h}`] };
  if (std?.landscape) out["page-orientation"] = ["landscape"];
  if (page.margins) out["page-margin"] = [page.margins.join(" ")];
  return out;
}

/** 谱表高（mm）：MusicXML `<scaling>` 优先（40 tenths 的毫米数），其次 `I:meta staff-size`。 */
export function songStaffSize(song: Song): number | null {
  const sc = song.defaults?.scaling;
  if (sc && sc.millimeters > 0 && sc.tenths > 0) return round2((sc.millimeters * 40) / sc.tenths);
  const v = Number(getMeta(song, "staff-size")[0]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 歌词字号（pt）：MusicXML `<lyric-font font-size>` 优先，其次 `I:meta lyric-size`。 */
export function songLyricSize(song: Song): number | null {
  const fs = song.defaults?.lyricFont?.size;
  if (fs && fs > 0) return fs;
  const v = Number(getMeta(song, "lyric-size")[0]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 转成 123/ABC 之前：MusicXML 的纸、谱表大小、歌词字号、页眉字体写进 meta（meta 里已有的不动）。返回新文档，不改入参。 */
export function withPageMeta(doc: ScoreDoc): ScoreDoc {
  const extra = (s: Song): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    const page = pageOfDefaults(s);
    if (page && !getMeta(s, "page").length) Object.assign(out, pageMeta(page));
    const sc = s.defaults?.scaling;
    if (sc && sc.millimeters > 0 && sc.tenths > 0 && !getMeta(s, "staff-size").length) out["staff-size"] = [String(songStaffSize(s))];
    const ly = s.defaults?.lyricFont?.size;
    if (ly && !getMeta(s, "lyric-size").length) out["lyric-size"] = [String(ly)];
    Object.assign(out, headerFontMeta(s));
    return out;
  };
  if (!doc.songs.some((s) => Object.keys(extra(s)).length)) return doc;
  return {
    ...doc,
    songs: doc.songs.map((s) => {
      const add = extra(s);
      return Object.keys(add).length ? { ...s, meta: { ...(s.meta ?? {}), ...add } } : s;
    }),
  };
}

/** 写 MusicXML 之前：没有 `<page-layout>`、但 meta 里写了纸的，还原成 `<page-layout>`（按缺省 scaling 折 tenths）。
 *  就地改（调用方传的是投影用的副本）。 */
export function applyPageMetaToDefaults(song: Song): void {
  // 谱表大小与歌词字号：`<scaling>` / `<lyric-font>` 没写才补
  const mm = Number(getMeta(song, "staff-size")[0]);
  if (!song.defaults?.scaling && Number.isFinite(mm) && mm > 0) {
    song.defaults = { ...(song.defaults ?? {}), scaling: { millimeters: mm, tenths: 40 } };
  }
  const ly = Number(getMeta(song, "lyric-size")[0]);
  if (!song.defaults?.lyricFont?.size && Number.isFinite(ly) && ly > 0) {
    song.defaults = { ...(song.defaults ?? {}), lyricFont: { ...(song.defaults?.lyricFont ?? {}), size: ly } };
  }
  if (song.defaults?.pageLayout?.pageWidth) return;
  const page = pageOfMeta(song);
  if (!page) return;
  const scaling = song.defaults?.scaling ?? { ...DEFAULT_SCALING };
  const k = ptPerTenth(scaling);
  const t = (pt: number) => round1(pt / k);
  song.defaults = {
    ...(song.defaults ?? {}),
    scaling,
    pageLayout: {
      pageWidth: t(page.w),
      pageHeight: t(page.h),
      ...(page.margins
        ? { margins: [{ top: t(page.margins[0]), right: t(page.margins[1]), bottom: t(page.margins[2]), left: t(page.margins[3]), oddEven: "both" as const }] }
        : {}),
    },
  };
}

// ───────────────────────── 页眉字体 ─────────────────────────

export type HeaderRole = "title" | "subtitle" | "scripture" | "credit";
export const HEADER_ROLES: readonly HeaderRole[] = ["title", "subtitle", "scripture", "credit"];

/** 页眉一项的字体：族（CSS font-family）、字号（pt）、粗体。 */
export interface HeaderFontSpec {
  family?: string;
  size?: number;
  bold?: boolean;
}

/** MusicXML 的 `<credit>` 按类型归到页眉角色（`credit-type`；没写类型的按版面：页首最大号且不靠右的是标题，靠右的是词曲）。
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

/** `<credit-words>` 的字体（同一角色取第一条；没写族退到 `<defaults><word-font>`）。 */
export function headerFontsOfCredits(song: Song): Partial<Record<HeaderRole, HeaderFontSpec>> {
  const credits = song.credits ?? [];
  const maxSize = Math.max(0, ...credits.map((c) => c.fontSize ?? 0));
  const out: Partial<Record<HeaderRole, HeaderFontSpec>> = {};
  for (const c of credits) {
    const role = headerRoleOfCredit(c.type, c.justify, maxSize > 0 && c.fontSize === maxSize);
    if (!role || out[role]) continue;
    const f: HeaderFontSpec = {};
    const family = c.fontFamily ?? song.defaults?.wordFont?.family;
    if (family) f.family = family;
    if (c.fontSize) f.size = c.fontSize;
    if (c.fontWeight === "bold") f.bold = true;
    if (Object.keys(f).length) out[role] = f;
  }
  return out;
}

/** `I:meta font-<角色> 字号 [bold] 字体族`。 */
export function headerFontsOfMeta(song: Song): Partial<Record<HeaderRole, HeaderFontSpec>> {
  const out: Partial<Record<HeaderRole, HeaderFontSpec>> = {};
  for (const role of HEADER_ROLES) {
    const v = getMeta(song, `font-${role}`)[0]?.trim();
    if (!v) continue;
    const m = /^(\S+)\s*(bold\s+)?(.*)$/i.exec(v);
    if (!m) continue;
    const f: HeaderFontSpec = {};
    const size = Number(m[1]);
    if (Number.isFinite(size) && size > 0) f.size = size;
    if (m[2]) f.bold = true;
    if (m[3]?.trim()) f.family = m[3].trim();
    if (Object.keys(f).length) out[role] = f;
  }
  return out;
}

/** 谱里写的页眉字体：MusicXML 的 credit 优先，其次 meta。 */
export function songHeaderFonts(song: Song): Partial<Record<HeaderRole, HeaderFontSpec>> {
  return song.credits?.length ? headerFontsOfCredits(song) : headerFontsOfMeta(song);
}

function headerFontMeta(song: Song): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!song.credits?.length) return out;
  for (const [role, f] of Object.entries(headerFontsOfCredits(song)) as [HeaderRole, HeaderFontSpec][]) {
    if (getMeta(song, `font-${role}`).length) continue;
    out[`font-${role}`] = [[f.size ? String(f.size) : "-", f.bold ? "bold" : "", f.family ?? ""].filter(Boolean).join(" ")];
  }
  return out;
}
