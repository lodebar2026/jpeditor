// Minimal xml.etree.ElementTree-compatible shim for abc2xml.ts.
// Only the subset used by abc2xml is implemented: Element(tag, attrib), .text,
// .set/.get, .append/.insert/.remove, .find/.findall (slash-separated tag paths),
// child iteration, and tostring().

export class Element {
  tag: string;
  attrib: Record<string, string>;
  text: string | null = null;
  _children: Element[] = [];

  constructor(tag: string, attrib: Record<string, string | number> = {}) {
    this.tag = tag;
    this.attrib = {};
    for (const k of Object.keys(attrib)) this.attrib[k] = String(attrib[k]);
  }

  set(k: string, v: string | number): void {
    this.attrib[k] = String(v);
  }
  get(k: string, def: string | null = null): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrib, k) ? this.attrib[k] : def;
  }
  append(c: Element): void {
    this._children.push(c);
  }
  insert(i: number, c: Element): void {
    this._children.splice(i, 0, c);
  }
  remove(c: Element): void {
    const i = this._children.indexOf(c);
    if (i >= 0) this._children.splice(i, 1);
  }
  find(path: string): Element | null {
    return this._findall(path)[0] ?? null;
  }
  findtext(path: string): string | null {
    const e = this.find(path);
    return e ? e.text : null;
  }
  findall(path: string): Element[] {
    return this._findall(path);
  }
  private _findall(path: string): Element[] {
    const segs = path.split("/");
    let cur: Element[] = [this];
    for (const seg of segs) {
      const next: Element[] = [];
      for (const e of cur) for (const ch of e._children) if (ch.tag === seg) next.push(ch);
      cur = next;
    }
    return cur;
  }
  get length(): number {
    return this._children.length;
  }
  [Symbol.iterator](): Iterator<Element> {
    return this._children[Symbol.iterator]();
  }
}

// factory mirroring E.Element(tag, **attrib)
export function E(tag: string, attrib: Record<string, string | number> = {}): Element {
  return new Element(tag, attrib);
}

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}

export function tostring(e: Element): string {
  const out: string[] = [];
  serialize(e, out);
  return out.join("");
}

function serialize(e: Element, out: string[]): void {
  out.push("<" + e.tag);
  for (const k of Object.keys(e.attrib)) out.push(` ${k}="${escAttr(e.attrib[k])}"`);
  const hasText = e.text !== null && e.text !== undefined && e.text !== "";
  if (e._children.length === 0 && !hasText) {
    out.push(" />");
    return;
  }
  out.push(">");
  if (hasText) out.push(escText(e.text as string));
  for (const ch of e._children) serialize(ch, out);
  out.push("</" + e.tag + ">");
}
