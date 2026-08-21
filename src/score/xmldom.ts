// MusicXML **DOM 后处理**的公共件。三处各写过一份（musicxmlpatch / musicxmllayout / musicxml 导入），
// 其中 insertOrdered 逐字符相同。字符串生成那一路的工具在 ./xmlutil.ts。
//
// 一律只看**直接子元素**（`el.children`），不用 querySelector——MusicXML 里同名标签会在不同层级
// 重复出现（如 <note> 里的 <type> 与 <credit> 里的），深查会摸到别人家的。

/** el 的直接子元素中第一个 tag 标签，无则 null。 */
export function child(el: Element, tag: string): Element | null {
  for (const c of Array.from(el.children)) if (c.tagName === tag) return c;
  return null;
}

/** el 的直接子元素中全部 tag 标签，按文档序。 */
export function children(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag);
}

/** 子元素 tag 的文本，无该子元素则 null。 */
export function childText(el: Element, tag: string): string | null {
  const c = child(el, tag);
  return c ? (c.textContent ?? "") : null;
}

/** 改写子元素 tag 的文本。返回是否真的改动了（无该子元素或文本相同 → false）。 */
export function setText(el: Element, tag: string, text: string): boolean {
  const c = child(el, tag);
  if (!c) return false;
  if (c.textContent === text) return false;
  c.textContent = text;
  return true;
}

/** 在 el 内部、位于 beforeTags 里最先出现的那个子元素之前插入（维持 MusicXML 的元素顺序）。 */
export function insertOrdered(el: Element, node: Element, beforeTags: string[]): void {
  for (const c of Array.from(el.children)) {
    if (beforeTags.includes(c.tagName)) { el.insertBefore(node, c); return; }
  }
  el.append(node);
}

/** XML 片段串 → 归属 doc 的元素节点。解析失败抛错（`where` 只用于错误信息）。 */
export function fragment(doc: Document, xml: string, where = "XML 片段"): Element {
  const d = new DOMParser().parseFromString(`<r>${xml}</r>`, "application/xml");
  const err = d.querySelector("parsererror");
  if (err) throw new Error(`${where}解析失败: ` + err.textContent);
  return doc.importNode(d.documentElement.firstElementChild!, true) as Element;
}
