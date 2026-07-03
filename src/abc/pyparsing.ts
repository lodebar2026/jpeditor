// Minimal pyparsing-compatible parser-combinator shim.
// Ported to support abc2xml.ts (faithful TS port of Willem Vree's abc2xml.py).
// Only the pyparsing subset actually used by abc2xml is implemented.
//
// Semantics replicated from pyparsing 2.x:
//  - default whitespace (" \t\n\r") skipped before every element (preParse),
//    disabled recursively by leaveWhitespace() which *copies* children first
//    (so shared leaf elements are not corrupted — as in ParseExpression.leaveWhitespace).
//  - parse actions get called (instring, loc, tokens) trimmed by fn.length, and
//    their return value (if not undefined/null) replaces the tokens (list => tokens,
//    scalar/object => single token, [] => discard).
//  - `loc` handed to actions is the match start *after* whitespace skipping.

export type Action = (...args: any[]) => any;

// ---------------- exceptions ----------------
export class ParseException extends Error {
  loc: number;
  pstr: string;
  constructor(pstr: string, loc: number, msg: string) {
    super(msg);
    this.pstr = pstr;
    this.loc = loc;
  }
  get line(): string {
    const s = this.pstr;
    const a = s.lastIndexOf("\n", this.loc - 1) + 1;
    let b = s.indexOf("\n", this.loc);
    if (b < 0) b = s.length;
    return s.slice(a, b);
  }
  get col(): number {
    return this.loc - this.pstr.lastIndexOf("\n", this.loc - 1);
  }
}

// ---------------- ParseResults ----------------
export class ParseResults extends Array<any> {
  asList(): any[] {
    return Array.from(this);
  }
}
function toResults(toks: any[]): ParseResults {
  const pr = new ParseResults();
  for (const t of toks) pr.push(t);
  return pr;
}

const DEFAULT_WHITE = " \t\n\r";

function callAction(act: Action, instring: string, loc: number, toks: any[]): any {
  const n = act.length;
  if (n >= 3) return act(instring, loc, toks);
  if (n === 2) return act(loc, toks);
  return act(toks);
}

// ---------------- base element ----------------
export abstract class P {
  skipWs = true;
  whiteChars = DEFAULT_WHITE;
  actions: Action[] = [];

  abstract parseImpl(instring: string, loc: number): [number, any[]];

  // list of directly-nested child elements (for leaveWhitespace copy-recursion)
  children(): P[] {
    return [];
  }
  setChildren(_ch: P[]): void {
    /* overridden by composites */
  }

  preParse(instring: string, loc: number): number {
    if (this.skipWs) {
      const w = this.whiteChars;
      while (loc < instring.length && w.indexOf(instring[loc]) >= 0) loc++;
    }
    return loc;
  }

  _parse(instring: string, loc: number): [number, any[]] {
    const preloc = this.preParse(instring, loc);
    let [end, toks] = this.parseImpl(instring, preloc);
    if (this.actions.length) {
      for (const act of this.actions) {
        const ret = callAction(act, instring, preloc, toks);
        if (ret !== undefined && ret !== null) {
          toks = Array.isArray(ret) ? ret.slice() : [ret];
        }
      }
    }
    return [end, toks];
  }

  parseString(instring: string): ParseResults {
    const [, toks] = this._parse(instring, 0);
    return toResults(toks);
  }

  setParseAction(...fns: Action[]): this {
    this.actions = fns;
    return this;
  }
  addParseAction(fn: Action): this {
    this.actions.push(fn);
    return this;
  }
  suppress(): P {
    return new Suppress(this);
  }

  copy(): P {
    const c: P = Object.create(Object.getPrototypeOf(this));
    Object.assign(c, this);
    c.actions = this.actions.slice();
    return c;
  }

  leaveWhitespace(): this {
    this.skipWs = false;
    const ch = this.children();
    if (ch.length) {
      const cp = ch.map((c) => c.copy().leaveWhitespace());
      this.setChildren(cp);
    }
    return this;
  }
}

// coerce string -> Literal
function ub(x: P | string): P {
  return typeof x === "string" ? new Literal(x) : x;
}

// ---------------- leaves ----------------
export class Literal extends P {
  constructor(public s: string) {
    super();
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    if (instring.startsWith(this.s, loc)) return [loc + this.s.length, [this.s]];
    throw new ParseException(instring, loc, `Expected "${this.s}"`);
  }
}

export class Word extends P {
  chars: string;
  exact: number;
  constructor(chars: string, opts?: { exact?: number }) {
    super();
    this.chars = chars;
    this.exact = opts?.exact ?? 0;
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    let i = loc;
    while (i < instring.length && this.chars.indexOf(instring[i]) >= 0) i++;
    if (this.exact) {
      if (i - loc < this.exact) throw new ParseException(instring, loc, "Expected Word");
      i = loc + this.exact;
    }
    if (i === loc) throw new ParseException(instring, loc, "Expected Word");
    return [i, [instring.slice(loc, i)]];
  }
}

export class CharsNotIn extends P {
  min: number;
  exact: number;
  constructor(public notChars: string, opts?: { exact?: number; min?: number }) {
    super();
    this.exact = opts?.exact ?? 0;
    this.min = this.exact || (opts?.min ?? 1);
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    let i = loc;
    while (i < instring.length && this.notChars.indexOf(instring[i]) < 0) i++;
    if (this.exact) {
      if (i - loc < this.exact) throw new ParseException(instring, loc, "Expected CharsNotIn");
      i = loc + this.exact;
    }
    if (i - loc < this.min) throw new ParseException(instring, loc, "Expected CharsNotIn");
    return [i, [instring.slice(loc, i)]];
  }
}

export class Regex extends P {
  re: RegExp;
  constructor(public pattern: string) {
    super();
    this.re = new RegExp(pattern, "y");
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    this.re.lastIndex = loc;
    const m = this.re.exec(instring);
    if (!m || m.index !== loc) throw new ParseException(instring, loc, "Expected regex");
    return [loc + m[0].length, [m[0]]];
  }
}

export class StringEnd extends P {
  parseImpl(instring: string, loc: number): [number, any[]] {
    if (loc === instring.length) return [loc, []];
    throw new ParseException(instring, loc, "Expected end of text");
  }
}

// ---------------- lookahead ----------------
export class FollowedBy extends P {
  constructor(public expr: P) {
    super();
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    this.expr._parse(instring, loc); // throws if not matched
    return [loc, []];
  }
  children(): P[] {
    return [this.expr];
  }
  setChildren(ch: P[]): void {
    this.expr = ch[0];
  }
}

export class NotAny extends P {
  constructor(public expr: P) {
    super();
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    let ok = false;
    try {
      this.expr._parse(instring, loc);
      ok = true;
    } catch {
      ok = false;
    }
    if (ok) throw new ParseException(instring, loc, "Found unwanted token");
    return [loc, []];
  }
  children(): P[] {
    return [this.expr];
  }
  setChildren(ch: P[]): void {
    this.expr = ch[0];
  }
}

// ---------------- unary wrappers ----------------
export class Suppress extends P {
  constructor(public expr: P) {
    super();
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    const [end] = this.expr._parse(instring, loc);
    return [end, []];
  }
  children(): P[] {
    return [this.expr];
  }
  setChildren(ch: P[]): void {
    this.expr = ch[0];
  }
}

export class Group extends P {
  constructor(public expr: P) {
    super();
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    const [end, toks] = this.expr._parse(instring, loc);
    return [end, [toks]]; // one token that is a nested list
  }
  children(): P[] {
    return [this.expr];
  }
  setChildren(ch: P[]): void {
    this.expr = ch[0];
  }
}

// Combine: adjacent (no internal whitespace) + join string tokens.
export class Combine extends P {
  constructor(public expr: P, public joinString = "") {
    super();
    this.expr = expr.copy().leaveWhitespace(); // adjacent=True
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    const [end, toks] = this.expr._parse(instring, loc);
    return [end, [toks.map((t) => String(t)).join(this.joinString)]];
  }
  children(): P[] {
    return [this.expr];
  }
  setChildren(ch: P[]): void {
    this.expr = ch[0];
  }
}

export class Optional extends P {
  expr: P;
  hasDefault: boolean;
  defaultVal: any;
  constructor(expr: P | string, ...defaultVal: any[]) {
    super();
    this.expr = ub(expr);
    this.hasDefault = defaultVal.length > 0;
    this.defaultVal = this.hasDefault ? defaultVal[0] : undefined;
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    try {
      return this.expr._parse(instring, loc);
    } catch {
      if (this.hasDefault) return [loc, [this.defaultVal]];
      return [loc, []];
    }
  }
  children(): P[] {
    return [this.expr];
  }
  setChildren(ch: P[]): void {
    this.expr = ch[0];
  }
}

export class ZeroOrMore extends P {
  expr: P;
  constructor(expr: P | string) {
    super();
    this.expr = ub(expr);
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    const toks: any[] = [];
    for (;;) {
      let end: number, t: any[];
      try {
        [end, t] = this.expr._parse(instring, loc);
      } catch {
        break;
      }
      if (end === loc && t.length === 0) break; // no progress guard
      loc = end;
      for (const x of t) toks.push(x);
    }
    return [loc, toks];
  }
  children(): P[] {
    return [this.expr];
  }
  setChildren(ch: P[]): void {
    this.expr = ch[0];
  }
}

export class OneOrMore extends P {
  expr: P;
  constructor(expr: P | string) {
    super();
    this.expr = ub(expr);
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    let [end, toks] = this.expr._parse(instring, loc); // require >=1
    loc = end;
    for (;;) {
      let t: any[];
      try {
        [end, t] = this.expr._parse(instring, loc);
      } catch {
        break;
      }
      if (end === loc && t.length === 0) break;
      loc = end;
      for (const x of t) toks.push(x);
    }
    return [loc, toks];
  }
  children(): P[] {
    return [this.expr];
  }
  setChildren(ch: P[]): void {
    this.expr = ch[0];
  }
}

// ---------------- n-ary composites ----------------
export class And extends P {
  constructor(public exprs: P[]) {
    super();
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    const toks: any[] = [];
    for (const e of this.exprs) {
      const [end, t] = e._parse(instring, loc);
      loc = end;
      for (const x of t) toks.push(x);
    }
    return [loc, toks];
  }
  children(): P[] {
    return this.exprs;
  }
  setChildren(ch: P[]): void {
    this.exprs = ch;
  }
}

export class MatchFirst extends P {
  constructor(public exprs: P[]) {
    super();
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    let err: ParseException | null = null;
    for (const e of this.exprs) {
      try {
        return e._parse(instring, loc);
      } catch (pe) {
        const ex = pe as ParseException;
        if (!err || ex.loc > err.loc) err = ex;
      }
    }
    throw err ?? new ParseException(instring, loc, "no alternative matched");
  }
  children(): P[] {
    return this.exprs;
  }
  setChildren(ch: P[]): void {
    this.exprs = ch;
  }
}

// Or (^): try all, keep the longest match.
export class Or extends P {
  constructor(public exprs: P[]) {
    super();
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    let best: [number, any[]] | null = null;
    let err: ParseException | null = null;
    for (const e of this.exprs) {
      try {
        const r = e._parse(instring, loc);
        if (!best || r[0] > best[0]) best = r;
      } catch (pe) {
        const ex = pe as ParseException;
        if (!err || ex.loc > err.loc) err = ex;
      }
    }
    if (!best) throw err ?? new ParseException(instring, loc, "no alternative matched");
    return best;
  }
  children(): P[] {
    return this.exprs;
  }
  setChildren(ch: P[]): void {
    this.exprs = ch;
  }
}

// ---------------- Forward (recursive) ----------------
export class Forward extends P {
  expr: P | null = null;
  set(expr: P): this {
    this.expr = expr;
    return this;
  }
  parseImpl(instring: string, loc: number): [number, any[]] {
    if (!this.expr) throw new ParseException(instring, loc, "empty Forward");
    return this.expr._parse(instring, loc);
  }
  // No copy-recursion: Forward is only used in whitespace-sensitive-free grammars.
  children(): P[] {
    return [];
  }
}

// ---------------- helpers / factories ----------------
export const nums = "0123456789";
export const alphas = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const alphanums = alphas + nums;

// expand an srange expression like "[H-Wh-w~]" into an explicit character set string
export function srange(spec: string): string {
  let body = spec;
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (i + 2 < body.length && body[i + 1] === "-") {
      const a = body.charCodeAt(i);
      const b = body.charCodeAt(i + 2);
      for (let c = a; c <= b; c++) out += String.fromCharCode(c);
      i += 2;
    } else {
      out += body[i];
    }
  }
  return out;
}

// oneOf: whitespace-separated alternatives, longest-first (prefix-safe) MatchFirst of Literals.
export function oneOf(spec: string): P {
  const alts = spec.split(/\s+/).filter((x) => x.length > 0);
  alts.sort((a, b) => b.length - a.length); // longer alternatives first
  return new MatchFirst(alts.map((a) => new Literal(a)));
}

// infix helpers replacing python operators
export function seq(...xs: (P | string)[]): And {
  return new And(xs.map(ub));
}
export function alt(...xs: (P | string)[]): MatchFirst {
  return new MatchFirst(xs.map(ub));
}
export function longest(...xs: (P | string)[]): Or {
  return new Or(xs.map(ub));
}
