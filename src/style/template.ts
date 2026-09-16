// 歌本模板的排版：`@template` 区域 → 定好位置的文字（和组件产出的原样图元）。语法见 docs/格式/jpcss.md。
//
// **纯函数**：字段取值、文字测量、实测值引用（`ref()`）、组件实现都由调用方经 `RegionEnv` 注入——
// 成书在 Node 侧（`scripts/rebuild.mjs`，度量走 fontres），混排/文本谱在浏览器侧，两边共用这一份。
//
// 浮点口径：区域基线 = `ref(...) + dy`，行 = 基线 + 格 dy，多行 = 行 + i × 行距。**加法顺序与原来手写的公式一致**，
// 500 首迁过来之后 DrawList 才能逐字节不变（`x + (−y)` 与 `x − y` 在 IEEE 754 下相同）。
//
// 无 DOM 依赖。
import type { Creator, Song } from "../model/doc";
import type { Cell, Expr, Region, TextPart } from "./jpcss";

/** 字段的一项值。署名带类型（`label-by-type` 要用）。 */
export interface FieldValue {
  text: string;
  type?: string;
}

export interface PlacedText {
  kind: "text";
  text: string;
  role: string;
  size: number;
  x: number;
  y: number;
  align: "left" | "center" | "right";
}

/** 组件产出的图元，调用方自己的形状，原样透传。 */
export interface PlacedRaw {
  kind: "raw";
  item: unknown;
}

export type Placed = PlacedText | PlacedRaw;

export interface ComponentCall {
  args: Expr[];
  /** 这一格的定位：已加过格 dx/dy 的笔位与基线 */
  x: number;
  y: number;
  role: string;
  size: number;
  cell: Cell;
  env: RegionEnv;
}

export type ComponentFn = (call: ComponentCall) => unknown[];

export interface RegionEnv {
  /** 字段路径 → 值。返回空数组或 undefined 都算空。 */
  field(path: string): readonly FieldValue[] | undefined;
  /** `ref(a.b.c)` 的取值（成书是 BookStyle）。 */
  ref?(path: string): unknown;
  /** 页号（奇数页 = 右手页；`inner`/`outer` 按它换边）。 */
  pageNo: number;
  /** 版心左右缘（`align-x: content`）与纸宽（`align-x: page`）。 */
  content: { left: number; right: number };
  pageWidth?: number;
  /** 区域整体下移（半页起排）。 */
  dy?: number;
  /** 角色字号。 */
  sizeOf(role: string): number;
  measure(role: string, text: string, size: number): number;
  components?: Readonly<Record<string, ComponentFn>>;
  /** 字体竖向度量（`flow: block` 要）。 */
  fontMetrics?(role: string, size: number): FontMetricsLike;
}

// ───────────────────────── 表达式求值 ─────────────────────────

export function evalExpr(e: Expr, env: RegionEnv, role = "note"): unknown {
  switch (e.k) {
    case "num":
      switch (e.unit) {
        case undefined:
        case "pt":
          return e.v;
        case "em":
          return e.v * env.sizeOf(role);
        default:
          throw new Error(`模板里不支持单位 ${e.unit}`);
      }
    case "str":
      return e.v;
    case "hash":
      return e.v;
    case "id":
      if (e.v === "true") return true;
      if (e.v === "false") return false;
      if (e.v === "content-left") return env.content.left;
      if (e.v === "content-right") return env.content.right;
      if (e.v === "page-width") return env.pageWidth;
      return e.v;
    case "call": {
      const arg = e.args[0];
      const name = arg && (arg.k === "id" || arg.k === "str") ? arg.v : "";
      if (e.name === "ref") {
        if (!env.ref) throw new Error("模板用了 ref()，但调用方没给 ref 取值");
        const v = env.ref(name.replace(/^book\./, ""));
        if (v === undefined) throw new Error(`ref(${name}) 取不到值`);
        return v;
      }
      throw new Error(`表达式里认不出函数 ${e.name}()`);
    }
    case "neg":
      return -num(evalExpr(e.a, env, role), e);
    case "bin": {
      const a = num(evalExpr(e.a, env, role), e);
      const b = num(evalExpr(e.b, env, role), e);
      return e.op === "+" ? a + b : e.op === "-" ? a - b : e.op === "*" ? a * b : a / b;
    }
    case "seq":
    case "list":
      return e.items.map((x) => evalExpr(x, env, role));
  }
}

function num(v: unknown, e: Expr): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`这里要数字：${JSON.stringify(e)}`);
  return v;
}

export function evalNum(e: Expr | undefined, env: RegionEnv, role?: string): number | undefined {
  return e === undefined ? undefined : num(evalExpr(e, env, role), e);
}

export function evalBool(e: Expr | undefined, env: RegionEnv, dflt: boolean): boolean {
  if (e === undefined) return dflt;
  const v = evalExpr(e, env);
  if (typeof v === "boolean") return v;
  if (v === "none") return false;
  return Boolean(v);
}

// ───────────────────────── 过滤器 ─────────────────────────

const CREDIT_LABEL: Readonly<Record<string, string>> = {
  lyricist: "作词", poet: "作词", composer: "作曲", arranger: "编曲",
  "words-and-music": "词曲", translator: "译词", transcriber: "制谱",
};

type Filter = (vals: FieldValue[]) => FieldValue[];

const map = (f: (t: string) => string): Filter => (vals) => vals.map((v) => ({ ...v, text: f(v.text) }));

export const FILTERS: Readonly<Record<string, Filter>> = {
  "strip-zero": map((t) => t.replace(/^0+(?=\d)/, "")),
  "cn-semicolon": map((t) => t.replace(/;/g, "；")),
  "unescape-newline": map((t) => t.replace(/\\n/g, "\n")),
  "dash-empty": (vals) => vals.filter((v) => v.text.trim() !== "-"),
  /** 去掉括号及其中内容（中英文括号都算），可以有多对。 */
  "strip-parens": map((t) => {
    let s = t;
    for (;;) {
      const m = /[(（][^()（）]*[)）]/.exec(s);
      if (!m) return s;
      s = s.slice(0, m.index) + s.slice(m.index + m[0].length);
    }
  }),
  /** `甲（乙）` → 两行（500 首页眉的分类名）。 */
  "split-paren": (vals) =>
    vals.flatMap((v) => {
      const m = /^(.+?)[（(](.+?)[）)]$/.exec(v.text);
      return m ? [{ ...v, text: m[1]! }, { ...v, text: m[2]! }] : [v];
    }),
  /** 每项按换行拆成多行，去空白行。 */
  lines: (vals) =>
    vals.flatMap((v) =>
      v.text
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((text) => ({ ...v, text })),
    ),
  /** 拆行但保留显式行首缩进；只去行尾空白和空行。 */
  "lines-indent": (vals) =>
    vals.flatMap((v) =>
      v.text
        .split(/\r?\n/)
        .map((t) => t.trimEnd())
        .filter((t) => t.trim().length > 0)
        .map((text) => ({ ...v, text })),
    ),
  /** 没带冒号标签的署名按类型补标签（`scripts/rebuild.mjs` 原 LABEL 规则）。 */
  "label-by-type": (vals) => vals.map((v) => (/[:：]/.test(v.text) ? v : { ...v, text: `${CREDIT_LABEL[v.type ?? ""] ?? v.type}：${v.text}` })),
};

// ───────────────────────── 内容 ─────────────────────────

/** 一段插值文字 → 若干行。空值折叠：所有插值字段都空时整行不出。 */
export function expandText(parts: readonly TextPart[], env: RegionEnv): string[] {
  const resolved = parts.map((p) => {
    if (typeof p === "string") return null;
    let vals = [...(env.field(p.path) ?? [])];
    for (const f of p.filters) {
      const fn = FILTERS[f];
      if (!fn) throw new Error(`认不出的过滤器 ${f}`);
      vals = fn(vals);
    }
    return vals.filter((v) => v.text !== "");
  });
  const fields = resolved.filter((r): r is FieldValue[] => r !== null);
  if (fields.length > 0 && fields.every((f) => f.length === 0)) return [];
  const n = Math.max(1, ...fields.map((f) => f.length));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = "";
    parts.forEach((p, k) => {
      if (typeof p === "string") s += p;
      else {
        const vals = resolved[k]!;
        // 单值字段每行都印；多值字段逐行取
        s += (vals.length === 1 ? vals[0]!.text : vals[i]?.text) ?? "";
      }
    });
    if (s !== "") out.push(s);
  }
  return out;
}

// ───────────────────────── 区域排版 ─────────────────────────

function slotAlign(slot: Cell["slot"], odd: boolean): "left" | "center" | "right" {
  switch (slot) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "center":
      return "center";
    case "inner":
      return odd ? "left" : "right";
    case "outer":
      return odd ? "right" : "left";
  }
}

export interface RegionResult {
  items: Placed[];
  /** fixed：首行基线到末行基线；block：区域高（`extent` 求值后，没写 extent 就是内容高）。 */
  span: number;
  /** block：内容高（各行块高之和，不含行间 gap-before）。 */
  content?: number;
}

/** 字体竖向度量（`flow: block` 用）：ascent 取正值，height = 一行的字高（ascent + descent）。 */
export interface FontMetricsLike {
  ascent: number;
  height: number;
}

/**
 * 排一个区域。`display` 为假时返回空。
 *
 * - `flow: fixed`（缺省）：写了 `baseline` 的行按它（加区域 `dy`）；格内多行按 `line-height` 递增。
 * - `flow: block`：区域从 `dy` 起往下排。行写了 `baseline` 就相对区域顶；写了 `top` 则行顶相对区域顶（基线照常加 ascent）；
 *   都没写就接上一行块底（加 `gap-before`），
 *   首行基线 = 行顶 + 该行字体 ascent。格内后续各行下移 `line-height`（`1.444em` 就是原排版程序的 1.444 倍字高）。
 *   行块高 = 各格字高之和取最大；区域高 = `extent`（其中 `content` = 各行块高之和）。
 */
export function layoutRegion(region: Region | undefined, env: RegionEnv): RegionResult {
  if (!region || !evalBool(region.props.display, env, true)) return { items: [], span: 0 };
  const odd = env.pageNo % 2 === 1;
  const dy = env.dy ?? 0;
  const block = region.props.flow?.k === "id" && region.props.flow.v === "block";
  const alignPage = region.props["align-x"]?.k === "id" && region.props["align-x"].v === "page";
  const inset = evalNum(region.props.inset, env);
  let left = alignPage ? 0 : env.content.left;
  let right = alignPage ? (env.pageWidth ?? env.content.right) : env.content.right;
  if (inset !== undefined) {
    left += inset;
    right -= inset;
  }
  const items: Placed[] = [];

  if (block) {
    let cursor = dy;
    let content = 0;
    for (const row of region.rows) {
      const gap = evalNum(row.props["gap-before"], env) ?? 0;
      const base = evalNum(row.props.baseline, env);
      const top = evalNum(row.props.top, env);
      const rowTop = base !== undefined ? dy : top !== undefined ? dy + top : cursor + (content > 0 ? gap : 0);
      let rowH = 0;
      for (const cell of row.cells) {
        const got = layoutBlockCell(region, cell, rowTop, base, left, right, odd, env);
        items.push(...got.items);
        rowH = Math.max(rowH, got.height);
      }
      if (rowH === 0) continue;
      content += rowH;
      cursor = rowTop + rowH;
    }
    const ext = region.props.extent;
    const span = ext ? evalExtent(ext, content, env) : content;
    return { items, span, content };
  }

  let firstY: number | undefined;
  let lastY: number | undefined;
  for (const row of region.rows) {
    const base = evalNum(row.props.baseline, env);
    if (base === undefined) throw new Error("flow: fixed 的区域里每行都要写 baseline");
    const rowY = base + dy;
    let rowLast = rowY;
    let any = false;
    for (const cell of row.cells) {
      const got = layoutCell(cell, rowY, left, right, odd, env);
      if (got.items.length) any = true;
      items.push(...got.items);
      rowLast = Math.max(rowLast, got.lastY);
    }
    if (!any) continue;
    firstY ??= rowY;
    lastY = rowLast;
  }
  return { items, span: firstY === undefined || lastY === undefined ? 0 : lastY - firstY };
}

/** `extent` 里的 `content` 换成内容高再求值。 */
function evalExtent(e: Expr, content: number, env: RegionEnv): number {
  const sub = (x: Expr): Expr => {
    switch (x.k) {
      case "id":
        return x.v === "content" ? { k: "num", v: content } : x;
      case "bin":
        return { ...x, a: sub(x.a), b: sub(x.b) };
      case "neg":
        return { ...x, a: sub(x.a) };
      default:
        return x;
    }
  };
  return evalNum(sub(e), env)!;
}

function fontMetrics(env: RegionEnv, role: string, size: number): FontMetricsLike {
  if (!env.fontMetrics) throw new Error("flow: block 要调用方给 fontMetrics");
  return env.fontMetrics(role, size);
}

function slotEdge(slot: Cell["slot"], left: number, right: number, odd: boolean): { align: "left" | "center" | "right"; edge: number } {
  const align = slotAlign(slot, odd);
  return { align, edge: align === "left" ? left : align === "right" ? right : (left + right) / 2 };
}

function layoutBlockCell(
  region: Region,
  cell: Cell,
  rowTop: number,
  base: number | undefined,
  left: number,
  right: number,
  odd: boolean,
  env: RegionEnv,
): { items: Placed[]; height: number } {
  const items: Placed[] = [];
  const { align, edge } = slotEdge(cell.slot, left, right, odd);
  const lhExpr = cell.props["line-height"] ?? region.props["line-height"];
  let y: number | undefined;
  let height = 0;
  for (const line of cell.lines) {
    const role = line.role ?? "note";
    const size = env.sizeOf(role);
    const x0 = line.at !== undefined ? evalNum(line.at, env, role)! : edge;
    const x = cell.props.dx !== undefined ? x0 + evalNum(cell.props.dx, env, role)! : x0;
    if (line.content.kind === "component") {
      const fn = env.components?.[line.content.name];
      if (!fn) throw new Error(`模板用了组件 ${line.content.name}()，调用方没给实现`);
      const cy = y ?? (base !== undefined ? rowTop + base : rowTop);
      for (const it of fn({ args: line.content.args, x, y: cy, role, size, cell, env })) items.push({ kind: "raw", item: it });
      continue;
    }
    const texts = expandText(line.content.parts, env).flatMap((t) => t.split("\n"));
    if (texts.length === 0) continue;
    const fm = fontMetrics(env, role, size);
    // 行距是长度：`1.444em` = 1.444 个字号（两个消费端的 fm.height 就是字号），`12pt` 是绝对值
    const lead = evalNum(lhExpr, env, role) ?? fm.height * 1.2;
    for (const text of texts) {
      if (y === undefined) y = base !== undefined ? rowTop + base : rowTop + fm.ascent;
      else y += lead;
      items.push({ kind: "text", text, role, size, x, y, align });
      // 块高就是逐行字高相加（原排版程序的 TextBlock::height）
      height += fm.height;
    }
  }
  return { items, height };
}

function layoutCell(cell: Cell, rowY: number, left: number, right: number, odd: boolean, env: RegionEnv): { items: Placed[]; lastY: number } {
  const items: Placed[] = [];
  const { align, edge } = slotEdge(cell.slot, left, right, odd);
  const cdx = cell.props.dx;
  const cdy = cell.props.dy;
  let i = 0;
  let lastY = rowY;
  for (const line of cell.lines) {
    const role = line.role ?? "note";
    const size = env.sizeOf(role);
    const x0 = line.at !== undefined ? evalNum(line.at, env, role)! : edge;
    const x = cdx !== undefined ? x0 + evalNum(cdx, env, role)! : x0;
    const y0 = cdy !== undefined ? rowY + evalNum(cdy, env, role)! : rowY;
    if (line.content.kind === "component") {
      const fn = env.components?.[line.content.name];
      if (!fn) throw new Error(`模板用了组件 ${line.content.name}()，调用方没给实现`);
      for (const it of fn({ args: line.content.args, x, y: y0, role, size, cell, env })) items.push({ kind: "raw", item: it });
      continue;
    }
    for (const text of expandText(line.content.parts, env)) {
      const y = i === 0 ? y0 : y0 + i * lineLead(cell, env, role);
      items.push({ kind: "text", text, role, size, x, y, align });
      lastY = Math.max(lastY, y);
      i++;
    }
  }
  return { items, lastY };
}

/** 格内换行的行距。`line-height` 是长度：`1.2em` 是字号的倍数，`12pt`（或 `ref()` 算出的数）是绝对值。 */
function lineLead(cell: Cell, env: RegionEnv, role: string): number {
  const g = cell.props["line-height"];
  if (g !== undefined) return evalNum(g, env, role)!;
  return env.sizeOf(role) * 1.2;
}

// ───────────────────────── 字段 ─────────────────────────

/** `Song` → 字段取值（`work.*`、`creators.<类型|*>`、`identification.rights`、`pageText.*`、`meta.*`）。
 *  `extra` 给上下文字段（`page.no`、`toc.seq`…）与调用方特有的字段，优先于模型。 */
export function songFields(song: Partial<Song> | undefined, extra: Readonly<Record<string, readonly FieldValue[] | string | undefined>> = {}): RegionEnv["field"] {
  const one = (t: string | undefined): FieldValue[] => (t ? [{ text: t }] : []);
  return (path) => {
    if (path in extra) {
      const v = extra[path];
      return typeof v === "string" ? one(v) : v;
    }
    if (!song) return undefined;
    const [head, ...rest] = path.split(".");
    const tail = rest.join(".");
    switch (head) {
      case "work": {
        const w = song.work;
        if (!w) return undefined;
        if (tail === "subtitles") return w.subtitles.map((text) => ({ text }));
        const v = (w as unknown as Record<string, unknown>)[tail];
        return typeof v === "string" ? one(v) : undefined;
      }
      case "creators": {
        const cs: readonly Creator[] = song.identification?.creators ?? [];
        return cs.filter((c) => tail === "*" || c.type === tail).map((c) => ({ text: c.text, type: c.type }));
      }
      case "identification":
        return tail === "rights" ? one(song.identification?.rights) : undefined;
      case "pageText": {
        const v = (song.pageText as unknown as Record<string, unknown> | undefined)?.[tail];
        if (typeof v === "string") return one(v);
        return Array.isArray(v) ? (v as string[]).map((text) => ({ text })) : undefined;
      }
      case "meta":
        return (song.meta?.[tail] ?? []).map((text) => ({ text }));
      default:
        return undefined;
    }
  };
}

/** `ref(a.b.c)` 从一个对象里按路径取值。 */
export function refFrom(obj: unknown): (path: string) => unknown {
  return (path) => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}
