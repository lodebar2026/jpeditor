// 样式值的长度单位。**只在适配器里换算**，排版引擎一律只见数字（各自的口径：pt / tenths / px）。
//
// 本轮支持三种：
//   pt  绝对长度（裸数字也按 pt）
//   em  所在角色的字号（CSS 语义）；不属于角色的度量量取 `note` 角色的字号
//   sp  线距 = 名义谱高 / 4。名义谱高就是小节线高度的**名义值**：五线谱 = 五条线的跨度（= SMuFL 字号），
//       简谱 = 小节线上下缘的跨度。改实际画出的小节线高不牵动 sp——那样全谱会跟着缩放。
//
// 墨迹口径（成书 `BookStyle.metrics.*Em`、文本谱 `digitInkHeight`）不开放成可写单位，留在各自块里原样用。
//
// 无 DOM 依赖。

export type LengthUnit = "pt" | "em" | "sp";

export type Length = number | `${number}pt` | `${number}em` | `${number}sp`;

/** 换算上下文：1em 与 1sp 各是多少（引擎自己的口径）。 */
export interface LengthContext {
  em: number;
  sp: number;
  /** 1pt 折成引擎口径是多少。缺省 1（简谱/文本谱/成书的排版单位就是 pt）；
   *  五线谱的 tenths 要等 MusicXML 的 `<scaling>` 读进来才知道，那一路不给 → pt 视为不可用。 */
  pt?: number;
}

const LENGTH_RE = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*(pt|em|sp)\s*$/;

/** 解析一个长度。认不出（含不支持的单位）返回 null——由调用方决定报错还是跳过。 */
export function parseLength(v: unknown): { value: number; unit: LengthUnit } | null {
  if (typeof v === "number") return Number.isFinite(v) ? { value: v, unit: "pt" } : null;
  if (typeof v !== "string") return null;
  const m = LENGTH_RE.exec(v);
  return m ? { value: Number(m[1]), unit: m[2] as LengthUnit } : null;
}

/** 长度 → 引擎口径的数字。**裸数字原样返回**（不乘 1），内置主题的常量才能逐位不变。
 *  认不出或该口径下不可用（五线谱给 pt）时返回 null。 */
export function resolveLength(v: unknown, ctx: LengthContext): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    if (ctx.pt === undefined || ctx.pt === 1) return v;
    return Number.isFinite(ctx.pt) ? v * ctx.pt : null;
  }
  const p = parseLength(v);
  if (!p) return null;
  switch (p.unit) {
    case "em":
      return p.value * ctx.em;
    case "sp":
      return p.value * ctx.sp;
    case "pt": {
      const k = ctx.pt ?? 1;
      return Number.isFinite(k) ? p.value * k : null;
    }
  }
}
