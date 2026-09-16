// 样式级联：若干层规则按序叠成一份 computed 样式表（后者覆盖前者）。
//
//   内置主题（themes.ts）
//     → 书样式表（歌本 .jpcss；成书的 BookStyle 由它算出，见 style/bookjpcss.ts）
//       → 曲内局部覆盖（文本谱 `FontSize:`/`Margin:` 是乘法，留在 pu 适配器里，不走深合并）
//         → 用户面板（编辑器，localStorage）
//
// 没有 DOM 树，所以不做 CSS 全量选择器：规则只按上下文限定（档位 / 引擎 / 页位 / 段号）过滤。
// `page` / `verse` 目前只实现匹配，还没有消费者。
//
// 无 DOM 依赖。
import { emptySheet, mergeStyle, type DeepPartial, type StyleSheet } from "./sheet";

/** 排版模式（档位）。 */
export type StyleMode = "expanded" | "original" | "staff" | "mixed";
/** 哪把尺子在吃这份样式。四把尺子口径不同，面板本来就分开记文本谱与 `.jpwabc` 的纸与字号。 */
export type StyleEngine = "jianpu" | "pu" | "book" | "staff";

export interface StyleContext {
  mode?: StyleMode;
  engine?: StyleEngine;
  /** 分页（有实际纸张）还是长图（一张连续长纸）。由纸张反推，见 `themes.ts::computeStyleForPaper`。 */
  paged?: boolean;
  page?: "left" | "right" | "first";
  verse?: number;
}

export interface StyleRule {
  /** 限定：给了的每一项都要与上下文相等才生效；不给 = 恒生效。 */
  when?: StyleContext;
  set: DeepPartial<StyleSheet>;
}

export type StyleLayer = readonly StyleRule[];

/** 规则的限定是否命中上下文。上下文里没有的维度，带这个限定的规则不生效。 */
export function ruleMatches(when: StyleContext | undefined, ctx: StyleContext): boolean {
  if (!when) return true;
  return (Object.keys(when) as (keyof StyleContext)[]).every((k) => when[k] === undefined || when[k] === ctx[k]);
}

/** 按层序、层内按规则序叠出 computed 样式表。 */
export function computeStyle(layers: readonly StyleLayer[], ctx: StyleContext): StyleSheet {
  let out = emptySheet();
  for (const layer of layers) {
    for (const rule of layer) {
      if (ruleMatches(rule.when, ctx)) out = mergeStyle(out, rule.set);
    }
  }
  return out;
}

/** 往一层里写一条规则：**限定完全相同**的规则就地合并，否则追加。面板每改一次就调一次，
 *  层不会越写越长。返回新数组（不改入参）。 */
export function upsertRule(layer: StyleLayer, when: StyleContext | undefined, set: DeepPartial<StyleSheet>): StyleRule[] {
  const key = whenKey(when);
  const out = layer.map((r) => ({ ...r }));
  const hit = out.find((r) => whenKey(r.when) === key);
  if (hit) hit.set = mergeStyle(hit.set, set);
  else out.push(when ? { when: { ...when }, set } : { set });
  return out;
}

function whenKey(when: StyleContext | undefined): string {
  if (!when) return "";
  return (Object.keys(when) as (keyof StyleContext)[])
    .filter((k) => when[k] !== undefined)
    .sort()
    .map((k) => `${k}=${when[k]}`)
    .join(";");
}

/** 校验一层用户规则（存量数据可能是任何东西）：形状不对的规则丢掉。 */
export function sanitizeLayer(v: unknown): StyleRule[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (r): r is StyleRule =>
      typeof r === "object" && r !== null && typeof (r as StyleRule).set === "object" && (r as StyleRule).set !== null,
  );
}
