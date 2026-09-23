// `.ss` 歌本样式表：文本 ↔ `StyleRule[]`。语法规范见 docs/格式/ss.md。
//
// 手写解析（词法 → 语句），报错带 `行:列`。只做「形状」：长度表达式、字段插值、组件调用都原样存成 AST
// （`template.ts` 在排版时按上下文求值）。成书的 `BookStyle` 由解析结果另算（`bookss.ts`）。
//
// 无 DOM 依赖（Node CLI 与浏览器两侧都要 import）。
import type { StyleContext, StyleRule } from "./cascade";
import { keysOfBlock } from "./keys";
import { STYLE_ROLES, TEMPLATE_ROLES, type DeepPartial, type FontRef, type StyleSheet } from "./sheet";

// ───────────────────────── AST ─────────────────────────

/** 表达式。长度、数字、布尔、标识符、函数调用、四则运算、空格序列、逗号列表。 */
export type Expr =
  | { k: "num"; v: number; unit?: string }
  | { k: "str"; v: string }
  | { k: "id"; v: string }
  | { k: "hash"; v: string }
  | { k: "call"; name: string; args: Expr[] }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Expr; b: Expr }
  | { k: "neg"; a: Expr }
  | { k: "seq"; items: Expr[] }
  | { k: "list"; items: Expr[] };

export type Slot = "left" | "center" | "right" | "inner" | "outer";
export const SLOTS: readonly Slot[] = ["left", "center", "right", "inner", "outer"];

/** 插值串里的一段：字面文字或 `{路径 | 过滤器 …}`。 */
export type TextPart = string | { path: string; filters: string[] };

export type Content =
  | { kind: "text"; parts: TextPart[] }
  | { kind: "component"; name: string; args: Expr[] };

export interface CellLine {
  content: Content;
  role?: string;
  at?: Expr;
}

export interface Cell {
  slot: Slot;
  lines: CellLine[];
  /** 块形式的其余声明：dx dy line-height avoid … */
  props: Record<string, Expr>;
}

export interface Row {
  props: Record<string, Expr>;
  cells: Cell[];
}

export interface Region {
  props: Record<string, Expr>;
  rows: Row[];
  /** 目录的 `entry { … }` 这类具名子块 */
  blocks?: Record<string, Region>;
}

export type RegionName = "song-head" | "song-foot" | "page-header" | "page-footer" | "toc";

/** `StyleSheet.template`：模板区域、装页、具名字体。 */
export interface TemplateSheet {
  regions?: Partial<Record<string, Region>>;
  flow?: Record<string, Expr>;
  /** `@font-face` 具名字体，解析期就归一化成 `FontRef`（角色的 `font:` 引它）。 */
  fonts?: Record<string, FontRef>;
}


// ───────────────────────── 词法 ─────────────────────────

type Tok =
  | { t: "id"; v: string; line: number; col: number }
  | { t: "str"; v: string; line: number; col: number }
  | { t: "num"; v: number; unit?: string; raw: string; line: number; col: number }
  | { t: "hash"; v: string; line: number; col: number }
  | { t: "at"; v: string; line: number; col: number }
  | { t: "p"; v: string; line: number; col: number }
  | { t: "eof"; v: ""; line: number; col: number };

export class SsError extends Error {
  constructor(msg: string, readonly line: number, readonly col: number) {
    super(`${line}:${col} ${msg}`);
  }
}

const ID_START = /[A-Za-z_\u0080-\uffff]/;
const ID_CHAR = /[A-Za-z0-9_\-.\u0080-\uffff]/;
const UNITS = ["pt", "em", "sp"];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const adv = (n: number): void => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      adv(1);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new SsError("注释没有收尾", line, col);
      adv(end + 2 - i);
      continue;
    }
    const L = line;
    const C = col;
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1]!;
          v += n === "n" ? "\n" : n;
          j += 2;
        } else {
          if (src[j] === "\n") throw new SsError("字符串没有收尾", L, C);
          v += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new SsError("字符串没有收尾", L, C);
      out.push({ t: "str", v, line: L, col: C });
      adv(j + 1 - i);
      continue;
    }
    // 数字：`-` 只有紧跟数字、且前一个记号不是能当左操作数的东西时才算负号的一部分
    const prev = out[out.length - 1];
    const prevIsOperand = prev && (prev.t === "num" || prev.t === "id" || prev.t === "str" || (prev.t === "p" && prev.v === ")"));
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? "")) || ((c === "-" || c === "+") && /[0-9.]/.test(src[i + 1] ?? "") && !prevIsOperand)) {
      const m = /^[+-]?(\d+(\.\d+)?|\.\d+)/.exec(src.slice(i))!;
      let raw = m[0];
      let unit: string | undefined;
      const rest = src.slice(i + raw.length);
      for (const u of UNITS) {
        if (rest.startsWith(u) && !ID_CHAR.test(rest[u.length] ?? " ")) {
          unit = u;
          break;
        }
      }
      const tok: Tok = { t: "num", v: Number(raw), raw, line: L, col: C };
      if (unit) {
        tok.unit = unit;
        raw += unit;
        tok.raw = raw;
      }
      out.push(tok);
      adv(raw.length);
      continue;
    }
    if (c === "#") {
      const m = /^#([A-Za-z0-9_\-.]+)/.exec(src.slice(i));
      if (!m) throw new SsError("`#` 后面要跟名字", L, C);
      out.push({ t: "hash", v: m[1]!, line: L, col: C });
      adv(m[0].length);
      continue;
    }
    if (c === "@") {
      const m = /^@([A-Za-z][A-Za-z0-9-]*)/.exec(src.slice(i));
      if (!m) throw new SsError("`@` 后面要跟规则名", L, C);
      out.push({ t: "at", v: m[1]!, line: L, col: C });
      adv(m[0].length);
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_CHAR.test(src[j]!)) j++;
      // 标识符里的 `-` 不能收尾（`a- b`），`.` 也不能收尾
      while (j > i + 1 && /[-.]/.test(src[j - 1]!)) j--;
      out.push({ t: "id", v: src.slice(i, j), line: L, col: C });
      adv(j - i);
      continue;
    }
    // `[` `]` 只为撞上元素选择器时能报出那条错（roleRule）
    if ("{}()[];:,+-*/|".includes(c)) {
      out.push({ t: "p", v: c, line: L, col: C });
      adv(1);
      continue;
    }
    throw new SsError(`认不出的字符 ${JSON.stringify(c)}`, L, C);
  }
  out.push({ t: "eof", v: "", line, col });
  return out;
}

// ───────────────────────── 语句 ─────────────────────────

/** 角色声明认得的属性（`RoleDecl`）。**只有样式**：谱面内容与逐曲的位置微调改数据（MusicXML），不在样式表里。 */
const ROLE_PROPS = new Set(["size", "color", "family", "font", "weight", "features", "align-mode", "baseline-adjust"]);

/** 角色声明里 kebab-case 的属性 → `RoleDecl` 字段；`align-mode` 的值也是 kebab ↔ camel（`ink-center` ↔ `inkCenter`）。 */
const ROLE_PROP_FIELD: Record<string, string> = { "align-mode": "alignMode", "baseline-adjust": "baselineAdjust" };
const kebabToCamel = (v: string): string => v.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const camelToKebab = (v: string): string => v.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** 合法角色名：尺子与成书的 `STYLE_ROLES` + 模板专用的 `TEMPLATE_ROLES`。 */
const KNOWN_ROLES = new Set<string>([...STYLE_ROLES, ...TEMPLATE_ROLES]);

/** `@font-face` 认得的属性（`FontRef`）。 */
const FONT_FACE_PROPS = new Set(["family", "file", "face", "mode", "bold"]);

/** `@media` 认得的维度（`StyleContext`）。 */
const MEDIA_DIMS = new Set(["mode", "engine", "paged", "page", "verse"]);

export interface ParseResult {
  rules: StyleRule[];
}

class Parser {
  private i = 0;
  readonly rules: StyleRule[] = [];
  constructor(private readonly toks: Tok[]) {}

  private peek(o = 0): Tok {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)]!;
  }
  private next(): Tok {
    return this.toks[this.i++] ?? this.toks[this.toks.length - 1]!;
  }
  private fail(msg: string, tok = this.peek()): never {
    throw new SsError(msg, tok.line, tok.col);
  }
  private isP(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t.t === "p" && t.v === v;
  }
  private expectP(v: string): Tok {
    if (!this.isP(v)) this.fail(`这里要 \`${v}\`，却是 ${JSON.stringify(this.peek().v)}`);
    return this.next();
  }
  private expectId(): string {
    const t = this.next();
    if (t.t !== "id") this.fail(`这里要名字，却是 ${JSON.stringify(t.v)}`, t);
    return t.v;
  }

  parseSheet(): void {
    this.stmts({}, () => this.peek().t === "eof");
  }

  private stmts(when: StyleContext, done: () => boolean): void {
    while (!done()) {
      const t = this.peek();
      if (t.t === "at") this.atRule(when);
      else if (t.t === "id") this.roleRule(when);
      else if (this.isP(";")) this.next();
      else this.fail(`这里要规则，却是 ${JSON.stringify(t.v)}`);
    }
  }

  private push(when: StyleContext, set: DeepPartial<StyleSheet>): void {
    this.rules.push(Object.keys(when).length ? { when: { ...when }, set } : { set });
  }

  private atRule(when: StyleContext): void {
    const at = this.next() as Extract<Tok, { t: "at" }>;
    switch (at.v) {
      case "flow":
        this.push(when, { template: { flow: this.declBlock() } });
        return;
      case "font-face": {
        const name = this.expectId();
        const decls = this.declBlock();
        const face: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(decls)) {
          if (!FONT_FACE_PROPS.has(k)) this.fail(`@font-face 认不出属性 ${k}`, at);
          face[k] = exprValue(v);
        }
        if (typeof face.family !== "string") this.fail(`@font-face ${name} 缺 family`, at);
        this.push(when, { template: { fonts: { [name]: face as unknown as FontRef } } });
        return;
      }
      case "page":
        this.push(when, { page: pageDecl(this.declBlock()) as DeepPartial<StyleSheet>["page"] });
        return;
      case "jianpu":
      case "staff":
      case "break": {
        const table = keysOfBlock(at.v);
        const decls = this.declBlock();
        const blk: Record<string, unknown> = {};
        const overrides: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(decls)) {
          if (k === "preset" && at.v !== "break") {
            blk.preset = exprWord(v);
            continue;
          }
          if (!table[k]) this.fail(`@${at.v} 认不出的键 ${k}（键名见 src/style/keys.ts；字体写在角色上，如 note { font: hei }）`, at);
          overrides[k] = exprLength(v);
        }
        if (Object.keys(overrides).length) blk.overrides = overrides;
        this.push(when, { [at.v]: blk } as DeepPartial<StyleSheet>);
        return;
      }
      case "pu":
        this.fail("`@pu` 已删：文本谱原样档照原版实测，不由样式表逐字段覆盖", at);
        break;
      case "template": {
        const name = this.expectId();
        this.push(when, { template: { regions: { [name]: this.regionBlock() } } } as DeepPartial<StyleSheet>);
        return;
      }
      case "media": {
        const w = { ...when };
        for (;;) {
          this.expectP("(");
          const dim = this.expectId();
          if (!MEDIA_DIMS.has(dim)) this.fail(`@media 认不出的维度 ${dim}`);
          this.expectP(":");
          const v = this.next();
          if (v.t !== "id" && v.t !== "num" && v.t !== "str") this.fail("@media 的值要是名字或数字", v);
          let val: string | number | boolean = v.v;
          if (dim === "paged") {
            if (val !== "true" && val !== "false") this.fail("@media (paged: …) 只收 true / false", v);
            val = val === "true";
          }
          (w as Record<string, unknown>)[dim] = val;
          this.expectP(")");
          if (this.peek().t === "id" && this.peek().v === "and") {
            this.next();
            continue;
          }
          break;
        }
        this.expectP("{");
        this.stmts(w, () => this.isP("}"));
        this.expectP("}");
        return;
      }
      case "song":
        this.fail("样式表不做逐曲规则：改谱面内容或逐曲微调位置请改 MusicXML（如 scripts/kl2020-prep.mjs）", at);
        break;
      default:
        this.fail(`认不出的规则 @${at.v}`, at);
    }
  }

  /** `角色, 角色… { 声明 }`。只认角色名，不做元素级限定（改数据，不改样式表）。 */
  private roleRule(when: StyleContext): void {
    const roles: string[] = [];
    for (;;) {
      roles.push(this.expectId());
      if (this.isP("[")) this.fail("样式表不做元素级限定：改谱面内容或逐曲微调位置请改 MusicXML");
      if (this.isP(",")) {
        this.next();
        continue;
      }
      break;
    }
    const decls = this.declBlock();
    for (const r of roles) if (!KNOWN_ROLES.has(r)) this.fail(`认不出的角色 ${r}（角色表见 src/style/sheet.ts::STYLE_ROLES / TEMPLATE_ROLES）`);
    for (const k of Object.keys(decls)) if (!ROLE_PROPS.has(k)) this.fail(`角色声明认不出属性 ${k}`);
    for (const role of roles) this.push(when, { roles: { [role]: roleDecl(decls) } } as DeepPartial<StyleSheet>);
  }

  private declBlock(): Record<string, Expr> {
    this.expectP("{");
    const out: Record<string, Expr> = {};
    while (!this.isP("}")) {
      if (this.isP(";")) {
        this.next();
        continue;
      }
      const name = this.expectId();
      this.expectP(":");
      out[name] = this.exprList(() => this.isP(";") || this.isP("}"));
      if (this.isP(";")) this.next();
    }
    this.expectP("}");
    return out;
  }

  /** `@template` 体：属性声明、`row(…) { … }`、具名子块 `entry { … }`、槽位（区域级直接写槽位 = 一行）。 */
  private regionBlock(): Region {
    this.expectP("{");
    const reg: Region = { props: {}, rows: [] };
    while (!this.isP("}")) {
      if (this.isP(";")) {
        this.next();
        continue;
      }
      const t = this.peek();
      if (t.t !== "id") this.fail(`模板里要属性或 row，却是 ${JSON.stringify(t.v)}`);
      if (t.v === "row") {
        this.next();
        reg.rows.push(this.rowBlock());
        continue;
      }
      if (this.peek(1).t === "p" && this.peek(1).v === "{") {
        const name = this.expectId();
        (reg.blocks ??= {})[name] = this.subRegion();
        continue;
      }
      const name = this.expectId();
      this.expectP(":");
      reg.props[name] = this.exprList(() => this.isP(";") || this.isP("}"));
      if (this.isP(";")) this.next();
    }
    this.expectP("}");
    return reg;
  }

  /** 具名子块（目录的 `entry`）：槽位写法同 row，其余是属性。 */
  private subRegion(): Region {
    const row = this.rowBody();
    return { props: row.props, rows: row.cells.length ? [{ props: {}, cells: row.cells }] : [] };
  }

  private rowBlock(): Row {
    const props: Record<string, Expr> = {};
    if (this.isP("(")) {
      this.next();
      while (!this.isP(")")) {
        const name = this.expectId();
        this.expectP(":");
        props[name] = this.exprList(() => this.isP(";") || this.isP(")"));
        if (this.isP(";")) this.next();
      }
      this.expectP(")");
    }
    const body = this.rowBody();
    return { props: { ...props, ...body.props }, cells: body.cells };
  }

  private rowBody(): Row {
    this.expectP("{");
    const row: Row = { props: {}, cells: [] };
    while (!this.isP("}")) {
      if (this.isP(";")) {
        this.next();
        continue;
      }
      const name = this.expectId();
      const slot = (SLOTS as readonly string[]).includes(name) ? (name as Slot) : null;
      if (slot && this.isP("{")) {
        const decls = this.declBlock();
        const cell: Cell = { slot, lines: [], props: {} };
        let role: string | undefined;
        let at: Expr | undefined;
        for (const [k, v] of Object.entries(decls)) {
          if (k === "content") continue;
          if (k === "role") role = exprWord(v);
          else if (k === "at") at = v;
          else cell.props[k] = v;
        }
        const content = decls.content;
        if (!content) this.fail(`槽位 ${slot} 的块里要写 content`);
        const items = content.k === "list" ? content.items : [content];
        for (const it of items) {
          const line = this.lineOf(it);
          if (role !== undefined && line.role === undefined) line.role = role;
          if (at !== undefined && line.at === undefined) line.at = at;
          cell.lines.push(line);
        }
        row.cells.push(cell);
        continue;
      }
      this.expectP(":");
      const v = this.exprList(() => this.isP(";") || this.isP("}"));
      if (this.isP(";")) this.next();
      if (slot) {
        const items = v.k === "list" ? v.items : [v];
        const lines = items.map((it) => this.lineOf(it));
        // `as` 写在最后一行时往前继承（`left: "a", "b" as credit;`）
        let last: string | undefined;
        for (let k = lines.length - 1; k >= 0; k--) {
          if (lines[k]!.role !== undefined) last = lines[k]!.role;
          else if (last !== undefined) lines[k]!.role = last;
        }
        row.cells.push({ slot, lines, props: {} });
      } else {
        row.props[name] = v;
      }
    }
    this.expectP("}");
    return row;
  }

  /** 槽位里的一行：`内容 [as 角色] [at 表达式]`。 */
  private lineOf(e: Expr): CellLine {
    const items = e.k === "seq" ? e.items : [e];
    const head = items[0];
    if (!head) this.fail("槽位里是空的");
    const line: CellLine = { content: contentOf(head, this.peek()) };
    for (let k = 1; k < items.length; k++) {
      const w = items[k]!;
      if (w.k === "id" && w.v === "as" && items[k + 1]?.k === "id") {
        line.role = (items[k + 1] as { v: string }).v;
        k++;
      } else if (w.k === "id" && w.v === "at" && items[k + 1]) {
        // `at` 后面到下一个关键字为止是表达式
        const rest: Expr[] = [];
        while (items[k + 1] && !(items[k + 1]!.k === "id" && ["as", "at"].includes((items[k + 1] as { v: string }).v))) rest.push(items[++k]!);
        line.at = rest.length === 1 ? rest[0]! : { k: "seq", items: rest };
      } else {
        this.fail("槽位里的一行只能写 `内容 [as 角色] [at 位置]`");
      }
    }
    return line;
  }

  // —— 表达式 ——

  private exprList(stop: () => boolean): Expr {
    const items: Expr[] = [];
    for (;;) {
      items.push(this.exprSeq(() => stop() || this.isP(",")));
      if (this.isP(",")) {
        this.next();
        continue;
      }
      break;
    }
    return items.length === 1 ? items[0]! : { k: "list", items };
  }

  private exprSeq(stop: () => boolean): Expr {
    const items: Expr[] = [];
    while (!stop() && this.peek().t !== "eof") items.push(this.exprAdd());
    if (items.length === 0) this.fail("这里缺值");
    return items.length === 1 ? items[0]! : { k: "seq", items };
  }

  private exprAdd(): Expr {
    let a = this.exprMul();
    while ((this.isP("+") || this.isP("-")) && this.spaced()) {
      const op = this.next().v as "+" | "-";
      a = { k: "bin", op, a, b: this.exprMul() };
    }
    return a;
  }

  private exprMul(): Expr {
    let a = this.exprUnary();
    while (this.isP("*") || this.isP("/")) {
      const op = this.next().v as "*" | "/";
      a = { k: "bin", op, a, b: this.exprUnary() };
    }
    return a;
  }

  /** `+`/`-` 当二元运算符，要求它和左边隔着空格（CSS calc 的规矩），免得与负数、连字符名混淆。 */
  private spaced(): boolean {
    const op = this.peek();
    const prev = this.toks[this.i - 1];
    if (!prev) return false;
    return op.line !== prev.line || op.col > prev.col + tokLen(prev);
  }

  private exprUnary(): Expr {
    if (this.isP("-")) {
      this.next();
      return { k: "neg", a: this.exprUnary() };
    }
    return this.exprPrimary();
  }

  private exprPrimary(): Expr {
    const t = this.next();
    switch (t.t) {
      case "num":
        return t.unit ? { k: "num", v: t.v, unit: t.unit } : { k: "num", v: t.v };
      case "str":
        return { k: "str", v: t.v };
      case "hash":
        return { k: "hash", v: t.v };
      case "id":
        if (this.isP("(") && this.toks[this.i]!.col === t.col + t.v.length && this.toks[this.i]!.line === t.line) {
          this.next();
          const args: Expr[] = [];
          while (!this.isP(")")) {
            args.push(this.exprSeq(() => this.isP(",") || this.isP(")")));
            if (this.isP(",")) this.next();
          }
          this.expectP(")");
          return { k: "call", name: t.v, args };
        }
        return { k: "id", v: t.v };
      case "p":
        if (t.v === "(") {
          const e = this.exprAdd();
          this.expectP(")");
          return e;
        }
        break;
    }
    return this.fail(`这里要值，却是 ${JSON.stringify(t.v)}`, t);
  }
}

function tokLen(t: Tok): number {
  switch (t.t) {
    case "str":
      return t.v.length + 2;
    case "num":
      return t.raw.length;
    case "hash":
    case "at":
      return t.v.length + 1;
    default:
      return t.v.length;
  }
}

/** 槽位里的内容：字符串 = 插值文字；函数调用 = 组件。 */
function contentOf(e: Expr, tok: Tok): Content {
  if (e.k === "str") return { kind: "text", parts: parseInterp(e.v, tok) };
  if (e.k === "call") return { kind: "component", name: e.name, args: e.args };
  throw new SsError("槽位的内容要是字符串或组件调用", tok.line, tok.col);
}

/** `"前缀{路径 | 过滤器}后缀"` → 段。`{{` / `}}` 是字面花括号。 */
export function parseInterp(s: string, tok?: { line: number; col: number }): TextPart[] {
  const parts: TextPart[] = [];
  let lit = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "{" && s[i + 1] === "{") {
      lit += "{";
      i += 2;
      continue;
    }
    if (c === "}" && s[i + 1] === "}") {
      lit += "}";
      i += 2;
      continue;
    }
    if (c === "{") {
      const end = s.indexOf("}", i);
      if (end < 0) throw new SsError(`插值没有收尾：${s}`, tok?.line ?? 0, tok?.col ?? 0);
      if (lit) parts.push(lit);
      lit = "";
      const [path, ...fs] = s.slice(i + 1, end).split("|").map((x) => x.trim());
      const filters = fs.filter(Boolean).map((f) => {
        if (!/^[a-z][a-z0-9-]*$/.test(f)) throw new SsError(`认不出的过滤器 ${f}`, tok?.line ?? 0, tok?.col ?? 0);
        return f;
      });
      parts.push({ path: path!, filters });
      i = end + 1;
      continue;
    }
    lit += c;
    i++;
  }
  if (lit) parts.push(lit);
  return parts;
}

// ───────────────────────── 声明 → 样式表字段 ─────────────────────────

function exprWord(e: Expr): string {
  if (e.k === "id" || e.k === "str") return e.v;
  if (e.k === "num") return String(e.v);
  throw new Error(`这里要一个词：${printExpr(e)}`);
}

/** 长度：裸数字 → number（内置主题逐位不变），带单位 → `"12pt"` 这类 `Length` 串。 */
function exprLength(e: Expr): unknown {
  if (e.k === "num") return e.unit ? `${e.v}${e.unit}` : e.v;
  if (e.k === "neg" && e.a.k === "num") return exprLength({ ...e.a, v: -e.a.v });
  return exprValue(e);
}

function exprValue(e: Expr): unknown {
  switch (e.k) {
    case "num":
      return exprLength(e);
    case "str":
      return e.v;
    case "hash":
      return parseColor(e.v);
    case "id":
      return e.v === "true" ? true : e.v === "false" ? false : e.v;
    case "neg":
      return exprLength(e);
    case "seq":
    case "list":
      return e.items.map(exprValue);
    default:
      return e;
  }
}

/** `#rrggbb` / `#aarrggbb` → ARGB 数字（样式表里颜色一律 ARGB）。 */
function parseColor(hex: string): number {
  const h = hex.toLowerCase();
  if (/^[0-9a-f]{6}$/.test(h)) return (0xff000000 + parseInt(h, 16)) >>> 0;
  if (/^[0-9a-f]{8}$/.test(h)) return parseInt(h, 16) >>> 0;
  throw new Error(`颜色要写 #rrggbb 或 #aarrggbb：#${hex}`);
}

function roleDecl(decls: Record<string, Expr>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decls)) {
    const field = ROLE_PROP_FIELD[k] ?? k;
    const val = k === "size" || k === "baseline-adjust" ? exprLength(v) : exprValue(v);
    out[field] = k === "align-mode" && typeof val === "string" ? kebabToCamel(val) : val;
  }
  return out;
}

function pageDecl(decls: Record<string, Expr>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decls)) out[k] = exprValue(v);
  return out;
}


// ───────────────────────── 入口 ─────────────────────────

/** 解析一份 `.ss`。 */
export function parseSs(src: string): ParseResult {
  const p = new Parser(lex(src));
  p.parseSheet();
  return { rules: p.rules };
}


// ───────────────────────── 写出 ─────────────────────────

export function printExpr(e: Expr): string {
  switch (e.k) {
    case "num":
      return `${e.v}${e.unit ?? ""}`;
    case "str":
      return JSON.stringify(e.v);
    case "id":
      return e.v;
    case "hash":
      return `#${e.v}`;
    case "call":
      return `${e.name}(${e.args.map(printExpr).join(", ")})`;
    case "bin": {
      const wrap = (x: Expr): string => (x.k === "bin" && (x.op === "+" || x.op === "-") && (e.op === "*" || e.op === "/") ? `(${printExpr(x)})` : printExpr(x));
      const right = e.b.k === "bin" && (e.op === "-" || e.op === "/" || ((e.b.op === "+" || e.b.op === "-") && (e.op === "*"))) ? `(${printExpr(e.b)})` : wrap(e.b);
      return `${wrap(e.a)} ${e.op} ${right}`;
    }
    case "neg":
      return `-${printExpr(e.a)}`;
    case "seq":
      return e.items.map(printExpr).join(" ");
    case "list":
      return e.items.map(printExpr).join(", ");
  }
}

function printValue(v: unknown, key?: string): string {
  if (typeof v === "number") {
    if ((key === "ink" || key === "background" || key === "color") && Number.isInteger(v) && v > 0xffffff) {
      return `#${(v >>> 0).toString(16).padStart(8, "0")}`;
    }
    return String(v);
  }
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return /^-?\d+(\.\d+)?(pt|em|sp)$/.test(v) || /^[A-Za-z_][A-Za-z0-9_-]*$/.test(v) ? v : JSON.stringify(v);
  if (Array.isArray(v)) return v.map((x) => printValue(x)).join(" ");
  if (v && typeof v === "object" && "k" in v) return printExpr(v as Expr);
  return JSON.stringify(v);
}

function printInterp(parts: TextPart[]): string {
  return JSON.stringify(
    parts
      .map((p) =>
        typeof p === "string"
          ? p.replace(/\{/g, "{{").replace(/\}/g, "}}")
          : `{${[p.path, ...p.filters].join(" | ")}}`,
      )
      .join(""),
  );
}

function printContent(c: Content): string {
  return c.kind === "text" ? printInterp(c.parts) : `${c.name}(${c.args.map(printExpr).join(", ")})`;
}

function printDecls(d: Record<string, Expr>, ind: string): string[] {
  return Object.entries(d).map(([k, v]) => `${ind}${k}: ${printExpr(v)};`);
}

function printRegionBody(reg: Region, ind: string): string[] {
  const L = printDecls(reg.props, ind);
  for (const row of reg.rows) {
    const rp = Object.entries(row.props);
    L.push(`${ind}row${rp.length ? `(${rp.map(([k, v]) => `${k}: ${printExpr(v)}`).join("; ")})` : ""} {`);
    for (const cell of row.cells) L.push(...printCell(cell, ind + "  "));
    L.push(`${ind}}`);
  }
  for (const [name, b] of Object.entries(reg.blocks ?? {})) {
    L.push(`${ind}${name} {`);
    L.push(...printDecls(b.props, ind + "  "));
    for (const row of b.rows) for (const cell of row.cells) L.push(...printCell(cell, ind + "  "));
    L.push(`${ind}}`);
  }
  return L;
}

function printCell(cell: Cell, ind: string): string[] {
  const simple = Object.keys(cell.props).length === 0;
  if (simple) {
    const lines = cell.lines.map((l) => `${printContent(l.content)}${l.role ? ` as ${l.role}` : ""}${l.at ? ` at ${printExpr(l.at)}` : ""}`);
    return [`${ind}${cell.slot}: ${lines.join(", ")};`];
  }
  const L = [`${ind}${cell.slot} {`];
  L.push(`${ind}  content: ${cell.lines.map((l) => printContent(l.content)).join(", ")};`);
  const role = cell.lines[0]?.role;
  if (role) L.push(`${ind}  role: ${role};`);
  const at = cell.lines[0]?.at;
  if (at) L.push(`${ind}  at: ${printExpr(at)};`);
  L.push(...printDecls(cell.props, ind + "  "));
  L.push(`${ind}}`);
  return L;
}


/** 一条规则的 `set` → 语句（不含 when 包装）。 */
function printSet(set: DeepPartial<StyleSheet>, ind: string): string[] {
  const L: string[] = [];
  const tpl = set.template as TemplateSheet | undefined;
  for (const [name, f] of Object.entries(tpl?.fonts ?? {})) {
    const body = Object.entries(f ?? {}).map(([k, v]) => `${ind}  ${k}: ${printValue(v)};`);
    L.push(`${ind}@font-face ${name} {`, ...body, `${ind}}`);
  }
  if (set.page) {
    L.push(`${ind}@page {`);
    for (const [k, v] of Object.entries(set.page)) L.push(`${ind}  ${k}: ${printValue(v, k)};`);
    L.push(`${ind}}`);
  }
  for (const [role, decl] of Object.entries(set.roles ?? {})) {
    const body = Object.entries(decl ?? {}).map(([k, v]) => {
      const prop = Object.entries(ROLE_PROP_FIELD).find(([, f]) => f === k)?.[0] ?? k;
      return `${prop}: ${printValue(k === "alignMode" && typeof v === "string" ? camelToKebab(v) : v, k)};`;
    });
    L.push(`${ind}${role} { ${body.join(" ")} }`);
  }
  for (const eng of ["jianpu", "staff", "break"] as const) {
    const blk = set[eng] as { preset?: string; overrides?: Record<string, unknown> } | undefined;
    if (!blk) continue;
    const body: string[] = [];
    if (blk.preset) body.push(`preset: ${blk.preset};`);
    for (const [k, v] of Object.entries(blk.overrides ?? {})) body.push(`${k}: ${printValue(v)};`);
    L.push(`${ind}@${eng} { ${body.join(" ")} }`);
  }
  for (const [name, reg] of Object.entries(tpl?.regions ?? {})) {
    if (!reg) continue;
    L.push(`${ind}@template ${name} {`, ...printRegionBody(reg as Region, ind + "  "), `${ind}}`);
  }
  if (tpl?.flow) L.push(`${ind}@flow {`, ...printDecls(tpl.flow, ind + "  "), `${ind}}`);
  return L;
}

/** 规则 → `.ss` 文本。`parseSs(printSs(r)).rules` 与 `r` 逐字段一致（`ss-roundtrip.mjs` 把关）。 */
export function printSs(rules: readonly StyleRule[]): string {
  const L: string[] = [];
  for (const r of rules) {
    const w = { ...(r.when ?? {}) } as Record<string, unknown>;
    const conds = Object.entries(w).filter(([, v]) => v !== undefined);
    let ind = "";
    const close: string[] = [];
    if (conds.length) {
      L.push(`${ind}@media ${conds.map(([k, v]) => `(${k}: ${v})`).join(" and ")} {`);
      close.unshift(`${ind}}`);
      ind += "  ";
    }
    L.push(...printSet(r.set, ind));
    L.push(...close);
  }
  return L.join("\n") + "\n";
}
