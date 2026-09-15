// `.jpcss` 歌本样式表：文本 ↔ `StyleRule[]`。语法规范见 docs/格式/jpcss.md。
//
// 手写解析（词法 → 语句），报错带 `行:列`。只做「形状」：长度表达式、字段插值、组件调用都原样存成 AST
// （`template.ts` 在排版时按上下文求值），这样 `ref(book.titleBlock.*)` 这类实测值引用在解析期不需要知道 BookStyle。
//
// 无 DOM 依赖（Node CLI 与浏览器两侧都要 import）。
import type { StyleContext, StyleRule } from "./cascade";
import type { DeepPartial, StyleSheet } from "./sheet";

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

/** 插值串里的一段：字面文字或 `{路径 | 过滤器(参数) …}`。 */
export type TextPart = string | { path: string; filters: { name: string; args: string[] }[] };

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
  /** 块形式的其余声明：dx dy line-gap avoid … */
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

export type RegionName = "song-head" | "song-foot" | "page-header" | "page-footer" | "toc" | "index" | "front";

/** `StyleSheet.template`：模板区域、装页、歌本声明、具名字体。 */
export interface TemplateSheet {
  book?: Record<string, Expr>;
  regions?: Partial<Record<string, Region>>;
  flow?: Record<string, Expr>;
  fonts?: Record<string, Record<string, Expr>>;
}

/** 逐元素样式（`角色[维度 op 值] { … }` 里带元素级维度的那些）。多层累加，不深合并。 */
export interface ScopedRule {
  role: string;
  where: { dim: string; op: string; value: string | number }[];
  props: Record<string, Expr>;
  song?: string;
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

export class JpcssError extends Error {
  constructor(msg: string, readonly line: number, readonly col: number) {
    super(`${line}:${col} ${msg}`);
  }
}

const ID_START = /[A-Za-z_\u0080-\uffff]/;
const ID_CHAR = /[A-Za-z0-9_\-.\u0080-\uffff]/;
const UNITS = ["pt", "em", "sp", "tenths", "%"];

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
      if (end < 0) throw new JpcssError("注释没有收尾", line, col);
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
          if (src[j] === "\n") throw new JpcssError("字符串没有收尾", L, C);
          v += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new JpcssError("字符串没有收尾", L, C);
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
      if (!m) throw new JpcssError("`#` 后面要跟名字", L, C);
      out.push({ t: "hash", v: m[1]!, line: L, col: C });
      adv(m[0].length);
      continue;
    }
    if (c === "@") {
      const m = /^@([A-Za-z][A-Za-z0-9-]*)/.exec(src.slice(i));
      if (!m) throw new JpcssError("`@` 后面要跟规则名", L, C);
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
    const two = src.slice(i, i + 2);
    if ([">=", "<=", "!=", "*="].includes(two)) {
      out.push({ t: "p", v: two, line: L, col: C });
      adv(2);
      continue;
    }
    if ("{}()[];:,=<>+-*/|".includes(c)) {
      out.push({ t: "p", v: c, line: L, col: C });
      adv(1);
      continue;
    }
    throw new JpcssError(`认不出的字符 ${JSON.stringify(c)}`, L, C);
  }
  out.push({ t: "eof", v: "", line, col });
  return out;
}

// ───────────────────────── 语句 ─────────────────────────

/** 规则里要求的上下文维度（直接对应 `StyleContext`）；其余维度（段号、小节、拍位…）算元素级，走 scoped。 */
const CONTEXT_DIMS = new Set(["mode", "engine", "page"]);
/** `@page :odd` 的页位写法 → `StyleContext.page`。 */
const PAGE_ALIAS: Record<string, string> = { odd: "right", even: "left", right: "right", left: "left", first: "first" };

/** 角色声明里认得的属性（`RoleDecl`）。其余属性在元素级 scoped 规则里照样收。 */
const ROLE_PROPS = new Set(["size", "color", "family", "font", "weight", "italic", "align", "line-height", "dx", "dy", "features", "visible"]);

export interface ParseResult {
  rules: StyleRule[];
  imports: string[];
}

class Parser {
  private i = 0;
  readonly rules: StyleRule[] = [];
  readonly imports: string[] = [];
  constructor(private readonly toks: Tok[]) {}

  private peek(o = 0): Tok {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)]!;
  }
  private next(): Tok {
    return this.toks[this.i++] ?? this.toks[this.toks.length - 1]!;
  }
  private fail(msg: string, tok = this.peek()): never {
    throw new JpcssError(msg, tok.line, tok.col);
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
    this.stmts({}, undefined, () => this.peek().t === "eof");
  }

  private stmts(when: StyleContext, song: string | undefined, done: () => boolean): void {
    while (!done()) {
      const t = this.peek();
      if (t.t === "at") this.atRule(when, song);
      else if (t.t === "id") this.roleRule(when, song);
      else if (this.isP(";")) this.next();
      else this.fail(`这里要规则，却是 ${JSON.stringify(t.v)}`);
    }
  }

  private push(when: StyleContext, set: DeepPartial<StyleSheet>): void {
    this.rules.push(Object.keys(when).length ? { when: { ...when }, set } : { set });
  }

  private atRule(when: StyleContext, song: string | undefined): void {
    const at = this.next() as Extract<Tok, { t: "at" }>;
    switch (at.v) {
      case "import": {
        const s = this.next();
        if (s.t !== "str") this.fail("@import 后面要字符串", s);
        this.imports.push(s.v);
        this.expectP(";");
        return;
      }
      case "book":
        this.push(when, { template: { book: this.declBlock() } });
        return;
      case "flow":
        this.push(when, { template: { flow: this.declBlock() } });
        return;
      case "font-face": {
        const name = this.expectId();
        this.push(when, { template: { fonts: { [name]: this.declBlock() } } });
        return;
      }
      case "page": {
        let w = when;
        if (this.isP(":")) {
          this.next();
          const pos = this.expectId();
          const p = PAGE_ALIAS[pos];
          if (!p) this.fail(`@page 认不出页位 :${pos}`);
          w = { ...when, page: p as StyleContext["page"] };
        }
        const decls = this.declBlock();
        this.push(w, { page: pageDecl(decls) as DeepPartial<StyleSheet>["page"] });
        return;
      }
      case "jianpu":
      case "pu":
      case "staff": {
        const decls = this.declBlock();
        const blk: Record<string, unknown> = {};
        const overrides: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(decls)) {
          if (k === "preset") blk.preset = exprWord(v);
          else overrides[k] = exprLength(v);
        }
        if (Object.keys(overrides).length) blk.overrides = overrides;
        this.push(when, { [at.v]: blk } as DeepPartial<StyleSheet>);
        return;
      }
      case "book-metrics": {
        const decls = this.declBlock();
        const book: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(decls)) setPath(book, k, exprValue(v));
        this.push(when, { book } as unknown as DeepPartial<StyleSheet>);
        return;
      }
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
          this.expectP(":");
          const v = this.next();
          if (v.t !== "id" && v.t !== "num" && v.t !== "str") this.fail("@media 的值要是名字或数字", v);
          (w as Record<string, unknown>)[dim] = v.t === "num" ? v.v : v.v;
          this.expectP(")");
          if (this.peek().t === "id" && this.peek().v === "and") {
            this.next();
            continue;
          }
          break;
        }
        this.expectP("{");
        this.stmts(w, song, () => this.isP("}"));
        this.expectP("}");
        return;
      }
      case "song": {
        const t = this.next();
        if (t.t !== "str" && t.t !== "hash") this.fail("@song 后面要曲名字符串或 #曲号", t);
        const name = t.t === "hash" ? `#${t.v}` : t.v;
        const w = { ...when, song: name } as StyleContext;
        this.expectP("{");
        this.stmts(w, name, () => this.isP("}"));
        this.expectP("}");
        return;
      }
      default:
        this.fail(`认不出的规则 @${at.v}`, at);
    }
  }

  /** `角色[限定]…, 角色… { 声明 }` */
  private roleRule(when: StyleContext, song: string | undefined): void {
    const sels: { role: string; where: ScopedRule["where"] }[] = [];
    for (;;) {
      const role = this.expectId();
      const where: ScopedRule["where"] = [];
      while (this.isP("[")) {
        this.next();
        const dim = this.expectId();
        const opTok = this.next();
        if (opTok.t !== "p" || !["=", "!=", ">", ">=", "<", "<=", "*="].includes(opTok.v)) this.fail("限定里要比较符", opTok);
        const vt = this.next();
        if (vt.t !== "str" && vt.t !== "num" && vt.t !== "id") this.fail("限定的值要是字符串、数字或名字", vt);
        where.push({ dim, op: opTok.v, value: vt.t === "num" ? vt.v : vt.v });
        this.expectP("]");
      }
      sels.push({ role, where });
      if (this.isP(",")) {
        this.next();
        continue;
      }
      break;
    }
    const decls = this.declBlock();
    for (const sel of sels) {
      const ctxWhere = sel.where.filter((w) => CONTEXT_DIMS.has(w.dim) && w.op === "=");
      const elemWhere = sel.where.filter((w) => !(CONTEXT_DIMS.has(w.dim) && w.op === "="));
      const w: StyleContext = { ...when };
      for (const c of ctxWhere) (w as Record<string, unknown>)[c.dim] = c.dim === "verse" ? Number(c.value) : c.value;
      const roleOnly = elemWhere.length === 0 && sel.role !== "score" && Object.keys(decls).every((k) => ROLE_PROPS.has(k));
      if (roleOnly) {
        this.push(w, { roles: { [sel.role]: roleDecl(decls) } } as DeepPartial<StyleSheet>);
      } else {
        const sr: ScopedRule = { role: sel.role, where: elemWhere, props: decls };
        if (song !== undefined) sr.song = song;
        const wNoSong = { ...w };
        delete (wNoSong as Record<string, unknown>).song;
        this.push(wNoSong, { scoped: [sr] } as DeepPartial<StyleSheet>);
      }
    }
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
      case "num": {
        const n: Expr = t.unit ? { k: "num", v: t.v, unit: t.unit } : { k: "num", v: t.v };
        // `+2pt`：相对继承值（写出成 `inherit + 2pt`，读回同形）
        return t.raw.startsWith("+") ? { k: "bin", op: "+", a: { k: "id", v: "inherit" }, b: n } : n;
      }
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
  throw new JpcssError("槽位的内容要是字符串或组件调用", tok.line, tok.col);
}

/** `"前缀{路径 | 过滤器(参数)}后缀"` → 段。`{{` / `}}` 是字面花括号。 */
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
      if (end < 0) throw new JpcssError(`插值没有收尾：${s}`, tok?.line ?? 0, tok?.col ?? 0);
      if (lit) parts.push(lit);
      lit = "";
      const [path, ...fs] = s.slice(i + 1, end).split("|").map((x) => x.trim());
      const filters = fs.filter(Boolean).map((f) => {
        const m = /^([a-z][a-z0-9-]*)(?:\((.*)\))?$/.exec(f);
        if (!m) throw new JpcssError(`认不出的过滤器 ${f}`, tok?.line ?? 0, tok?.col ?? 0);
        const args = m[2] === undefined ? [] : splitArgs(m[2]);
        return { name: m[1]!, args };
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

function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:'([^']*)'|"([^"]*)"|([^,]+))\s*(?:,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && m[0] !== "") out.push(m[1] ?? m[2] ?? m[3]!.trim());
  return out;
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

const ROLE_KEY: Record<string, string> = { "line-height": "lineHeight" };

function roleDecl(decls: Record<string, Expr>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decls)) out[ROLE_KEY[k] ?? k] = k === "size" || k === "dx" || k === "dy" ? exprLength(v) : exprValue(v);
  return out;
}

function pageDecl(decls: Record<string, Expr>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decls)) out[k] = exprValue(v);
  return out;
}

function setPath(obj: Record<string, unknown>, path: string, v: unknown): void {
  const ks = path.split(".");
  let cur = obj;
  for (const k of ks.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
  cur[ks[ks.length - 1]!] = v;
}

// ───────────────────────── 入口 ─────────────────────────

/** 解析一份 `.jpcss`。`@import` 不在这里展开（读文件是调用方的事，见 `parseJpcssWithImports`）。 */
export function parseJpcss(src: string): ParseResult {
  const p = new Parser(lex(src));
  p.parseSheet();
  return { rules: p.rules, imports: p.imports };
}

/** 带 `@import` 展开：被引入的规则排在本文件之前（同层按出现顺序，引入的先叠）。 */
export async function parseJpcssWithImports(src: string, load: (path: string) => Promise<string>, seen = new Set<string>()): Promise<StyleRule[]> {
  const r = parseJpcss(src);
  const out: StyleRule[] = [];
  for (const imp of r.imports) {
    if (seen.has(imp)) continue;
    seen.add(imp);
    out.push(...(await parseJpcssWithImports(await load(imp), load, seen)));
  }
  return out.concat(r.rules);
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
  if (typeof v === "string") return /^-?\d+(\.\d+)?(pt|em|sp|tenths)$/.test(v) || /^[A-Za-z_][A-Za-z0-9_-]*$/.test(v) ? v : JSON.stringify(v);
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
          : `{${[p.path, ...p.filters.map((f) => (f.args.length ? `${f.name}(${f.args.map((a) => `'${a}'`).join(", ")})` : f.name))].join(" | ")}}`,
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

function printWhere(w: ScopedRule["where"]): string {
  return w.map((c) => `[${c.dim}${c.op}${typeof c.value === "number" ? c.value : JSON.stringify(c.value)}]`).join("");
}

/** 一条规则的 `set` → 语句（不含 when 包装）。 */
function printSet(set: DeepPartial<StyleSheet>, ind: string): string[] {
  const L: string[] = [];
  const tpl = set.template as TemplateSheet | undefined;
  if (tpl?.book) L.push(`${ind}@book {`, ...printDecls(tpl.book, ind + "  "), `${ind}}`);
  for (const [name, f] of Object.entries(tpl?.fonts ?? {})) L.push(`${ind}@font-face ${name} {`, ...printDecls(f, ind + "  "), `${ind}}`);
  if (set.page) {
    L.push(`${ind}@page {`);
    for (const [k, v] of Object.entries(set.page)) L.push(`${ind}  ${k}: ${printValue(v, k)};`);
    L.push(`${ind}}`);
  }
  for (const [role, decl] of Object.entries(set.roles ?? {})) {
    const inv: Record<string, string> = { lineHeight: "line-height" };
    const body = Object.entries(decl ?? {}).map(([k, v]) => `${inv[k] ?? k}: ${printValue(v, k)};`);
    L.push(`${ind}${role} { ${body.join(" ")} }`);
  }
  for (const eng of ["jianpu", "pu", "staff"] as const) {
    const blk = set[eng] as { preset?: string; overrides?: Record<string, unknown> } | undefined;
    if (!blk) continue;
    const body: string[] = [];
    if (blk.preset) body.push(`preset: ${blk.preset};`);
    for (const [k, v] of Object.entries(blk.overrides ?? {})) body.push(`${k}: ${printValue(v)};`);
    L.push(`${ind}@${eng} { ${body.join(" ")} }`);
  }
  if (set.book) {
    L.push(`${ind}@book-metrics {`);
    const walk = (o: Record<string, unknown>, pre: string): void => {
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, `${pre}${k}.`);
        else L.push(`${ind}  ${pre}${k}: ${printValue(v)};`);
      }
    };
    walk(set.book as unknown as Record<string, unknown>, "");
    L.push(`${ind}}`);
  }
  for (const [name, reg] of Object.entries(tpl?.regions ?? {})) {
    if (!reg) continue;
    L.push(`${ind}@template ${name} {`, ...printRegionBody(reg as Region, ind + "  "), `${ind}}`);
  }
  if (tpl?.flow) L.push(`${ind}@flow {`, ...printDecls(tpl.flow, ind + "  "), `${ind}}`);
  for (const sr of (set.scoped ?? []) as ScopedRule[]) {
    const body = printDecls(sr.props, "").join(" ");
    const rule = `${sr.role}${printWhere(sr.where)} { ${body} }`;
    L.push(sr.song !== undefined ? `${ind}@song ${sr.song.startsWith("#") ? sr.song : JSON.stringify(sr.song)} { ${rule} }` : `${ind}${rule}`);
  }
  return L;
}

/** 规则 → `.jpcss` 文本。`parseJpcss(printJpcss(r)).rules` 与 `r` 逐字段一致（`jpcss-roundtrip.mjs` 把关）。 */
export function printJpcss(rules: readonly StyleRule[]): string {
  const L: string[] = [];
  for (const r of rules) {
    const w = { ...(r.when ?? {}) } as Record<string, unknown>;
    const song = w.song as string | undefined;
    delete w.song;
    const conds = Object.entries(w).filter(([, v]) => v !== undefined);
    let ind = "";
    const close: string[] = [];
    if (song !== undefined) {
      L.push(`@song ${song.startsWith("#") ? song : JSON.stringify(song)} {`);
      close.unshift("}");
      ind += "  ";
    }
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
