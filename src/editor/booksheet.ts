// 诗集样式表（歌本 `.ss`）进编辑器：按谱文件所在目录自动找，也能手动指定。
//
// 查找顺序（先找到的生效，见 docs/模块/样式与设置.md）：
//   1. 文件里写明的：123 / ABC 的 `I:style xxx.ss`，按谱文件所在目录解析相对路径
//   2. 手动指定过的：设置里给某个目录选过（或选了「不用」），对该目录及子目录生效
//   3. 自动发现：从谱文件所在目录往上逐级找（本级 + `样式/`、`style/` 子目录），最多 3 级，到家目录为止；
//      同一级多份时挑与目录同名的 → `book.ss` → 文件名排序第一个
// 浏览器版拿不到目录，只有手动选（存原文）。
//
// **编辑器只取样式表里各尺子口径一致的部分**（`editorRules`）：角色的字体（族、字重、`@font-face`）、
// 页眉四项的字号（pt，三档同一口径）、纸与方向、配色。间距覆写、模板、成书块不用——
// 四把尺子的单位不同（成书 pt、五线谱 tenths），整份照搬会把混排的简谱数字缩成一点。
import type { StyleRule } from "../style/cascade";
import { parseSs } from "../style/ss";
import { HEADER_ROLES, type HeaderRole } from "../style/header";
import type { DeepPartial, RoleDecl, StyleSheet } from "../style/sheet";
import { isTauriRuntime } from "./fileio";

export type BookSheetSource = "ref" | "manual" | "auto";

export interface BookSheet {
  /** 样式表路径（浏览器版手动选的是文件名） */
  path: string;
  source: BookSheetSource;
  text: string;
  /** 自动发现时同一级另外还有几份 */
  others: number;
}

/** 手动指定：目录 → 样式表路径（空串 = 这个目录不用样式表）。 */
export type BookSheetMap = Record<string, string>;

const SEP = /[\\/]/;
export const dirOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, "");
const baseOf = (p: string): string => p.split(SEP).pop() ?? p;
const join = (dir: string, rel: string): string => {
  if (/^([\\/]|[A-Za-z]:)/.test(rel)) return rel;
  const parts = dir.split(SEP);
  for (const seg of rel.split(SEP)) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
};

/** 某路径相对某目录（`I:style` 写进文件用）。 */
export function relativePath(fromDir: string, to: string): string {
  const a = fromDir.split(SEP).filter(Boolean);
  const b = to.split(SEP).filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/") || baseOf(to);
}

/** 目录最近的手动指定（本目录或祖先目录）。 */
function manualFor(dir: string, map: BookSheetMap): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const [d, p] of Object.entries(map)) {
    if ((dir === d || dir.startsWith(d + "/") || dir.startsWith(d + "\\")) && d.length > bestLen) {
      best = p;
      bestLen = d.length;
    }
  }
  return best;
}

/** 按顺序找（Tauri 版）。`ref` 是谱里 `I:style` 写的相对路径。 */
export async function findBookSheet(docPath: string, ref: string | undefined, map: BookSheetMap): Promise<BookSheet | null> {
  if (!isTauriRuntime() || !docPath) return null;
  const fs = await import("@tauri-apps/plugin-fs");
  const read = async (path: string, source: BookSheetSource, others = 0): Promise<BookSheet | null> => {
    try {
      return { path, source, text: await fs.readTextFile(path), others };
    } catch {
      return null;
    }
  };
  const dir = dirOf(docPath);
  if (ref) {
    const hit = await read(join(dir, ref), "ref");
    if (hit) return hit;
  }
  const manual = manualFor(dir, map);
  if (manual !== undefined) return manual ? read(manual, "manual") : null;

  let home = "";
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    home = await homeDir();
  } catch {
    home = "";
  }
  home = home.replace(/[\\/]$/, "");
  let cur = dir;
  for (let level = 0; level <= 3 && cur; level++) {
    for (const sub of ["", "样式", "style"]) {
      const d = sub ? `${cur}/${sub}` : cur;
      let names: string[] = [];
      try {
        names = (await fs.readDir(d)).filter((e) => e.isFile && /\.ss$/i.test(e.name)).map((e) => e.name).sort();
      } catch {
        continue;
      }
      if (!names.length) continue;
      const own = baseOf(cur) + ".ss";
      const pick = names.find((n) => n === own) ?? names.find((n) => n.toLowerCase() === "book.ss") ?? names[0]!;
      const hit = await read(`${d}/${pick}`, "auto", names.length - 1);
      if (hit) return hit;
    }
    if (home && (cur === home || !cur.startsWith(home))) break;
    const up = dirOf(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/** 样式表 → 编辑器用的那几条规则（见文件头）。解析错误原样抛出（带 `行:列`）。 */
export function editorRules(text: string): StyleRule[] {
  const out: StyleRule[] = [];
  for (const r of parseSs(text).rules) {
    const set: DeepPartial<StyleSheet> = {};
    const roles: Record<string, RoleDecl> = {};
    for (const [role, d] of Object.entries(r.set.roles ?? {})) {
      if (!d) continue;
      const keep: RoleDecl = {};
      if (d.font !== undefined) keep.font = d.font;
      if (d.family !== undefined) keep.family = d.family;
      if (d.weight !== undefined) keep.weight = d.weight;
      if (d.color !== undefined) keep.color = d.color;
      if (d.size !== undefined && (HEADER_ROLES as readonly string[]).includes(role as HeaderRole)) keep.size = d.size;
      if (Object.keys(keep).length) roles[role] = keep;
    }
    if (Object.keys(roles).length) set.roles = roles;
    const pg = r.set.page;
    if (pg) {
      const page: DeepPartial<StyleSheet["page"]> = {};
      if (pg.paper !== undefined) page.paper = pg.paper;
      if (pg.orientation !== undefined) page.orientation = pg.orientation;
      if (pg.ink !== undefined) page.ink = pg.ink;
      if (pg.background !== undefined) page.background = pg.background;
      if (Object.keys(page).length) set.page = page;
    }
    const fonts = r.set.template?.fonts;
    if (fonts && Object.keys(fonts).length) set.template = { fonts } as DeepPartial<StyleSheet>["template"];
    if (Object.keys(set).length) out.push(r.when ? { when: r.when, set } : { set });
  }
  return out;
}

/** 样式表里 `@font-face` 带文件的，在页面里注册（Tauri 读字体文件；读不到就靠系统里装的同名字体）。 */
export async function registerFontFaces(rules: readonly StyleRule[], sheetPath: string): Promise<void> {
  if (!isTauriRuntime() || typeof FontFace === "undefined") return;
  const fs = await import("@tauri-apps/plugin-fs");
  for (const r of rules) {
    for (const f of Object.values(r.set.template?.fonts ?? {})) {
      if (!f?.file || !f.family) continue;
      try {
        const bytes = await fs.readFile(join(dirOf(sheetPath), f.file));
        const face = new FontFace(f.family, bytes);
        await face.load();
        document.fonts.add(face);
      } catch {
        // 系统里装了同名字体也能用；装不了不影响打开谱
      }
    }
  }
}
