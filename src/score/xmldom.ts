// MusicXML **DOM 读取**的小工具（`model/fromxml.ts` 用）。字符串生成那一路的工具在 ./xmlutil.ts。
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
