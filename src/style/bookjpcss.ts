// 成书样式 ↔ 歌本 `.jpcss`。**成书没有 json**：`BookStyle` 只是内存里的中间对象，由样式表算出。
//
//   bookStyleOf(sheet, id)   computed 样式表 → BookStyle（rebuild / relayout / 各检查脚本的入口）
//   printBookJpcss(style)    BookStyle → 样式表文本（统计脚本 gen-bookstyle.mjs 用它生成歌本的实测部分）
//
// 两个方向读同一张对照表，逐字段往返（`bookStyleOf(parse(print(s)))` 与 `s` 相同）：
//
//   page                @page { size: 宽 高; margin: 上 外 下 内; mirror }
//   fonts               @font-face 名 { family; file; face; mode; bold }
//   roles               角色 { font; size; align-mode; baseline-adjust; color }
//   metrics / layout    @jianpu 与 @break 的逻辑键（style/keys.ts 的 book 一列）
//   titleBlock          @flow { number-baseline; first-system-top; cont-system-top; mid-start-gap; footer-baseline }
//   toc                 @template toc { title-baseline; heading-gap-above/below; entry { … } index { … } }
//
// **数值原样进出**：`*Em` 字段在样式表里写 `em` 单位，读回时只剥单位、不乘字号；文本 ↔ double
// 用的是 `String(number)` / `Number(raw)`，两边逐位还原。**不补默认值**：样式表没写的字段就不出现，
// 由消费端原来的 `??` 兜底——补了默认值，出书结果就会变。
//
// 无 DOM 依赖。
import type { BookStyle, RoleStyle } from "../pdflayout/bookstyle";
import type { Expr } from "./jpcss";
import { BREAK_KEYS, JIANPU_KEYS, type KeyDef } from "./keys";
import { STYLE_ROLES, type AlignMode, type StyleRole, type StyleSheet } from "./sheet";

/** `@flow` 键 → `titleBlock` 字段。 */
const FLOW_KEYS: Record<string, keyof BookStyle["titleBlock"]> = {
  "number-baseline": "numberBaseline",
  "first-system-top": "firstSystemTop",
  "cont-system-top": "contSystemTop",
  "mid-start-gap": "midStartGap",
  "footer-baseline": "footerBaseline",
};

/** `@template toc` 的属性 → `toc` 字段。区域上一层、`entry { }`、`index { }` 三处。 */
const TOC_REGION: Record<string, keyof BookStyle["toc"]> = {
  "title-baseline": "titleBaseline",
  "heading-gap-above": "headingGapAbove",
  "heading-gap-below": "headingGapBelow",
};
const TOC_ENTRY: Record<string, keyof BookStyle["toc"]> = {
  leader: "leader",
  "line-height": "lineGap",
  "first-baseline": "firstBaseline",
  "left-edge": "left",
  "right-edge": "right",
};
const TOC_INDEX: Record<string, keyof BookStyle["toc"]> = {
  columns: "indexColumns",
  "line-height": "indexLineGap",
  "first-baseline": "indexFirstBaseline",
};

const bookKeys = (table: Record<string, KeyDef>): [string, KeyDef][] => Object.entries(table).filter(([, d]) => d.book);

// ───────────────────────── 样式表 → BookStyle ─────────────────────────

export function bookStyleOf(sheet: StyleSheet, id: string): BookStyle {
  const out: Record<string, unknown> = { id };

  const p = sheet.page;
  const size = p.size;
  const margin = p.margin;
  if (!Array.isArray(size) || size.length !== 2) throw new Error("成书样式表缺 @page { size: 宽 高 }");
  if (!Array.isArray(margin) || margin.length !== 4) throw new Error("成书样式表的 @page margin 要写四个数：上 外 下 内");
  out.page = {
    w: size[0],
    h: size[1],
    mirror: p.mirror === true,
    margin: { inner: margin[3], outer: margin[1], top: margin[0], bottom: margin[2] },
  };

  out.fonts = { ...(sheet.template?.fonts ?? {}) };

  const roles: Record<string, RoleStyle> = {};
  for (const [role, d] of Object.entries(sheet.roles)) {
    if (!(STYLE_ROLES as readonly string[]).includes(role) || !d) continue;
    if (d.font === undefined || typeof d.size !== "number" || d.alignMode === undefined) {
      throw new Error(`成书样式表的角色 ${role} 要写 font / size（裸数 pt）/ align-mode`);
    }
    const r: RoleStyle = { font: d.font, align: d.alignMode as AlignMode, size: d.size, baselineAdjust: d.baselineAdjust ?? 0 };
    if (d.color !== undefined) r.color = d.color;
    roles[role] = r;
  }
  out.roles = roles;

  const metrics: Record<string, unknown> = {};
  const layout: Record<string, unknown> = {};
  const take = (ov: Record<string, unknown> | undefined, table: Record<string, KeyDef>, block: string) => {
    for (const [k, v] of Object.entries(ov ?? {})) {
      const def = table[k];
      if (!def?.book) continue; // 纯简谱/混排那一侧的键，成书不读
      const [group, field] = def.book.split(".") as [string, string];
      (group === "metrics" ? metrics : layout)[field] = bookValue(block, k, def, field, v);
    }
  };
  take(sheet.jianpu.overrides, JIANPU_KEYS, "jianpu");
  take(sheet.break?.overrides, BREAK_KEYS, "break");
  out.metrics = metrics;
  out.layout = layout;

  const toc: Record<string, unknown> = {};
  const region = sheet.template?.regions?.toc;
  const pick = (props: Record<string, Expr> | undefined, table: Record<string, string>, where: string) => {
    for (const [k, e] of Object.entries(props ?? {})) {
      const field = table[k];
      if (!field) continue; // 目录区域的其他属性（混排歌本的 title 等）归模板排版
      toc[field] = field === "leader" ? exprText(e, `${where} ${k}`) : exprNumber(e, `${where} ${k}`);
    }
  };
  pick(region?.props, TOC_REGION, "@template toc");
  pick(region?.blocks?.entry?.props, TOC_ENTRY, "@template toc entry");
  pick(region?.blocks?.index?.props, TOC_INDEX, "@template toc index");
  out.toc = toc;

  const titleBlock: Record<string, unknown> = {};
  for (const [k, e] of Object.entries(sheet.template?.flow ?? {})) {
    const field = FLOW_KEYS[k];
    if (field) titleBlock[field] = exprNumber(e, `@flow ${k}`);
  }
  out.titleBlock = titleBlock;

  return out as unknown as BookStyle;
}

function bookValue(block: string, key: string, def: KeyDef, field: string, v: unknown): unknown {
  const where = `@${block} 的 ${key}`;
  switch (def.kind) {
    case "bool":
      if (typeof v !== "boolean") throw new Error(`${where}：开关只收 true / false`);
      return v;
    case "word":
      if (typeof v !== "string") throw new Error(`${where}：要一个词`);
      return v;
    case "num":
      if (typeof v !== "number") throw new Error(`${where}：要一个数`);
      return v;
    case "len": {
      if (field.endsWith("Em")) {
        const m = typeof v === "string" ? /^(-?\d+(?:\.\d+)?|-?\.\d+)em$/.exec(v) : null;
        if (!m) throw new Error(`${where}：成书这一项按字号缩放，要写 em（如 1.2em），却是 ${JSON.stringify(v)}`);
        return Number(m[1]);
      }
      if (typeof v !== "number") throw new Error(`${where}：成书这一项是 pt，写裸数，却是 ${JSON.stringify(v)}`);
      return v;
    }
  }
}

function exprNumber(e: Expr, where: string): number {
  if (e.k === "num" && !e.unit) return e.v;
  if (e.k === "neg" && e.a.k === "num" && !e.a.unit) return -e.a.v;
  throw new Error(`${where}：要一个裸数（pt）`);
}

function exprText(e: Expr, where: string): string {
  if (e.k === "str" || e.k === "id") return e.v;
  throw new Error(`${where}：要一个字符串`);
}

// ───────────────────────── BookStyle → 样式表 ─────────────────────────

/** 数值写成文本：`String(number)` 是能还原出同一个 double 的最短写法。词法不认指数形式，遇到就报错。 */
function num(v: number, where: string): string {
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`${where}：${s} 写不成样式表的数字（指数形式或非有限数）`);
  return s;
}

const str = (v: string): string => JSON.stringify(v);

/** 生成歌本样式表的**实测部分**（纸、字体、角色、间距、断句、起排位置、目录几何）。
 *  模板（标题块、页眉页脚的排法）与手调常量不在这里，写在歌本自己的 `.jpcss`，加载时排在这份之后。 */
export function printBookJpcss(style: BookStyle): string {
  const L: string[] = [];
  const { page } = style;
  const m = page.margin;
  L.push(`@page { size: ${num(page.w, "page.w")} ${num(page.h, "page.h")}; margin: ${num(m.top, "margin.top")} ${num(m.outer, "margin.outer")} ${num(m.bottom, "margin.bottom")} ${num(m.inner, "margin.inner")}; mirror: ${page.mirror}; }`, "");

  for (const [name, f] of Object.entries(style.fonts)) {
    const body = [`family: ${str(f.family)};`];
    if (f.file !== undefined) body.push(`file: ${str(f.file)};`);
    if (f.face !== undefined) body.push(`face: ${str(f.face)};`);
    if (f.mode !== undefined) body.push(`mode: ${f.mode};`);
    if (f.bold !== undefined) body.push(`bold: ${f.bold};`);
    L.push(`@font-face ${name} { ${body.join(" ")} }`);
  }
  L.push("");

  for (const [role, r] of Object.entries(style.roles) as [StyleRole, RoleStyle][]) {
    const body = [`font: ${r.font};`, `size: ${num(r.size, `${role}.size`)};`, `align-mode: ${r.align.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)};`];
    if (r.baselineAdjust !== 0) body.push(`baseline-adjust: ${num(r.baselineAdjust, `${role}.baselineAdjust`)};`);
    if (r.color !== undefined) body.push(`color: #${(r.color >>> 0).toString(16).padStart(8, "0")};`);
    L.push(`${role} { ${body.join(" ")} }`);
  }
  L.push("");

  // 一块里的键按 BookStyle 的字段顺序写（先 metrics 后 layout），生成物稳定、与旧数据逐项可比；
  // 表里没有的字段说明排版不读，不写
  const block = (name: string, table: Record<string, KeyDef>) => {
    const byPath = new Map(bookKeys(table).map(([k, d]) => [d.book!, [k, d] as const]));
    const body: string[] = [];
    for (const group of ["metrics", "layout"] as const) {
      for (const [field, v] of Object.entries(style[group])) {
        const hit = byPath.get(`${group}.${field}`);
        if (!hit || v === undefined) continue;
        const [key, def] = hit;
        if (def.kind === "bool" || def.kind === "word") body.push(`  ${key}: ${String(v)};`);
        else body.push(`  ${key}: ${num(v as number, `${group}.${field}`)}${field.endsWith("Em") ? "em" : ""};`);
      }
    }
    if (body.length) L.push(`@${name} {`, ...body, "}", "");
  };
  block("jianpu", JIANPU_KEYS);
  block("break", BREAK_KEYS);

  const tb = style.titleBlock as unknown as Record<string, number | undefined>;
  const flow = Object.entries(FLOW_KEYS).filter(([, f]) => tb[f] !== undefined).map(([k, f]) => `${k}: ${num(tb[f]!, `titleBlock.${f}`)};`);
  if (flow.length) L.push(`@flow { ${flow.join(" ")} }`, "");

  const toc = style.toc as unknown as Record<string, number | string | undefined>;
  const props = (table: Record<string, string>) =>
    Object.entries(table)
      .filter(([, f]) => toc[f] !== undefined)
      .map(([k, f]) => `${k}: ${typeof toc[f] === "string" ? str(toc[f] as string) : num(toc[f] as number, `toc.${f}`)};`);
  const region = props(TOC_REGION);
  const entry = props(TOC_ENTRY);
  const index = props(TOC_INDEX);
  if (region.length || entry.length || index.length) {
    L.push("@template toc {", ...region.map((x) => `  ${x}`));
    if (entry.length) L.push(`  entry { ${entry.join(" ")} }`);
    if (index.length) L.push(`  index { ${index.join(" ")} }`);
    L.push("}", "");
  }
  return L.join("\n");
}
