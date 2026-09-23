// 123 原文里改扩展 meta（`I:meta 键 值` 头部行）。编辑器「曲目信息」对话框写回用。
//
// 只动**第一首**的头部：删掉它原有的 `I:meta` 行，把新的逐项逐行插在 `K:`（ABC 头部的最后一个字段）之前；
// 没有 `K:` 就插在第一首最后一个头部字段行之后。其余行一字不改。
//
// 无 DOM 依赖。
import type { SongMeta } from "../model/doc";

const FIELD = /^\s*([A-Za-z]|[一-鿿]{1,4})\s*[:：]/;
const KEY = /^\s*(K|调)\s*[:：]/;
const META = /^\s*%%meta\s|^\s*I\s*[:：]\s*meta\s/i;

export function replaceMetaLines(text: string, meta: SongMeta): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  // 第一首的范围：到第二个 X: 为止
  let end = lines.length;
  let seenX = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(X|曲号)\s*[:：]/.test(lines[i]!)) {
      if (seenX) {
        end = i;
        break;
      }
      seenX = true;
    }
  }
  const head = lines.slice(0, end).filter((l) => !META.test(l));
  const tail = lines.slice(end);
  const fresh: string[] = [];
  for (const [key, vals] of Object.entries(meta)) {
    for (const v of vals) for (const line of v.split(/\r?\n/)) if (line.trim()) fresh.push(`I:meta ${key} ${line.trim()}`);
  }
  let at = head.findIndex((l) => KEY.test(l));
  if (at < 0) {
    at = 0;
    for (let i = 0; i < head.length; i++) if (FIELD.test(head[i]!)) at = i + 1;
  }
  head.splice(at, 0, ...fresh);
  return [...head, ...tail].join(eol);
}

const STYLE = /^\s*I\s*[:：]\s*style\s/i;

/** 第一首头部的 `I:style` 引用换成 `ref`（空串 = 删掉），插在 `K:` 之前。其余行一字不改。 */
export function replaceStyleRef(text: string, ref: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let end = lines.length;
  let seenX = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(X|曲号)\s*[:：]/.test(lines[i]!)) {
      if (seenX) {
        end = i;
        break;
      }
      seenX = true;
    }
  }
  const head = lines.slice(0, end).filter((l) => !STYLE.test(l));
  const tail = lines.slice(end);
  if (ref) {
    let at = head.findIndex((l) => KEY.test(l));
    if (at < 0) {
      at = 0;
      for (let i = 0; i < head.length; i++) if (FIELD.test(head[i]!)) at = i + 1;
    }
    head.splice(at, 0, `I:style ${ref}`);
  }
  return [...head, ...tail].join(eol);
}
