// 逐元素样式（scoped 规则，docs/样式机制.md §11）落到混排版面上。
//
// 时机与原排版程序逐曲手改的位置一致（musicpp util/pao.cpp::fixPaoScore）：谱面读完、`formatMixedScore` 之后、
// 分帧装页之前。改的都是**画的时候才读**的量（歌词字体与 y、和弦与文字块的 x/y、段号原文、小音符、符干方向），
// 不牵动小节宽度与断行——那些是 MusicXML 自己带的版面。
//
// 没有 scoped 规则时一行不动（`applyScopedToStaff` 直接返回），混排的既有基线不变。
import { Font } from "../layout/font";
import type { Expr, ScopedRule } from "../style/jpcss";
import type { ChordLayout, LyricLayout, MeasureText, PartMeasureLayout, StaffLayout } from "./model";

type Ctx = Record<string, string | number | undefined>;

function valueOf(e: Expr | undefined): unknown {
  if (!e) return undefined;
  switch (e.k) {
    case "num":
      return e.v;
    case "str":
    case "id":
      return e.v === "true" ? true : e.v === "false" ? false : e.v;
    case "neg":
      return typeof valueOf(e.a) === "number" ? -(valueOf(e.a) as number) : undefined;
    case "seq":
    case "list":
      return e.items.map(valueOf);
    default:
      return undefined;
  }
}

/** `+2pt` 这类相对值：解析成 `inherit + 2`。返回新值。 */
function numberProp(e: Expr | undefined, current: number, ptToTenths: number): number | undefined {
  if (!e) return undefined;
  const unit = (x: Expr): number => (x.k === "num" ? (x.unit === "pt" ? x.v * ptToTenths : x.v) : NaN);
  if (e.k === "bin" && e.a.k === "id" && e.a.v === "inherit") {
    const d = unit(e.b);
    return e.op === "+" ? current + d : e.op === "-" ? current - d : undefined;
  }
  if (e.k === "neg" && e.a.k === "num") return -unit(e.a);
  const v = unit(e);
  return Number.isFinite(v) ? v : undefined;
}

function matches(rule: ScopedRule, ctx: Ctx): boolean {
  return rule.where.every((w) => {
    const v = ctx[w.dim];
    if (v === undefined) return false;
    const want = w.value;
    const glyph = (s: string): string => (/^U\+[0-9a-f]+$/i.test(s) ? String.fromCodePoint(parseInt(s.slice(2), 16)) : s);
    switch (w.op) {
      case "=":
        return typeof v === "number" ? v === Number(want) : glyph(String(want)) === v;
      case "!=":
        return typeof v === "number" ? v !== Number(want) : glyph(String(want)) !== v;
      case "*=":
        return String(v).includes(glyph(String(want)));
      case ">":
        return Number(v) > Number(want);
      case ">=":
        return Number(v) >= Number(want);
      case "<":
        return Number(v) < Number(want);
      case "<=":
        return Number(v) <= Number(want);
      default:
        return false;
    }
  });
}

export interface ScopedReport {
  /** 规则 → 命中几处（没命中的规则多半是写错了小节号或曲名） */
  hits: { rule: ScopedRule; count: number }[];
}

/**
 * 把本曲的 scoped 规则落到版面上。`song` 是本曲的曲名/`#曲号`（规则的 `@song` 限定）。
 * 支持的角色与属性：
 *   lyric[verse|measure|part]         family size(可 +2pt) dy
 *   verseNum[verse|measure|text]      text（改写段号原文，如 1. → 1-3.）
 *   chord[measure|beat|text]          dx dy（和弦符号）
 *   direction[measure|text|glyph]     dx dy text-split: each  blank-after: 1 3（第几项之后空一行，0 基）
 *   note[measure|beat|voice|part]     cue: true|false   stem: up|down
 *   score                             chinese-hyphen: true
 */
export function applyScopedToStaff(
  score: StaffLayout,
  rules: readonly ScopedRule[] | undefined,
  song: { title: string; number?: string },
  /** `measure`：装页前（量谱行包围盒之前）；`draw`：装页后、画之前。
   *  文字块拆行放在 draw：混排的 `getYBound` 按字体 ascent−descent 算文字高（约 1.45 个字号），
   *  原排版程序按字号算，拆行计入包围盒会把「我心等候祢」挤成两页，成品是一页。 */
  phase: "measure" | "draw" = "measure",
): ScopedReport {
  const mine = (rules ?? []).filter((r) => r.song === undefined || r.song === song.title || (song.number !== undefined && r.song === `#${song.number}`));
  const hits = mine.map((rule) => ({ rule, count: 0 }));
  if (mine.length === 0) return { hits };
  const pt = 1 / (score.scaling || 1);
  const each = (role: string, ctx: Ctx, apply: (props: Record<string, Expr>) => void): void => {
    hits.forEach((h) => {
      if (h.rule.role !== role || !matches(h.rule, ctx)) return;
      h.count++;
      apply(h.rule.props);
    });
  };

  for (const h of hits) {
    if (phase !== "measure" || h.rule.role !== "score" || h.rule.where.length) continue;
    h.count++;
    if (valueOf(h.rule.props["chinese-hyphen"]) === true) score.options.chineseHyphen = true;
  }

  for (const part of score.parts) {
    for (const md of part.measures) {
      const measure = md.measureInfo.index + 1;
      const base: Ctx = { part: part.pid, measure };
      for (const t of md.textBlocks) textRules(t, base, each, pt, phase);
      if (phase === "draw") continue;
      for (const l of md.lyrics) lyricRules(l, base, each, pt);
      for (const hm of md.harmonies) {
        // 匹配用的原文：根音 + kind 原文 + 加减音 + 低音（`C(add9)/E` 里认得出 add9）
        const deg = (hm.src.degrees ?? []).map((d) => `${d.type}${d.value}`).join("");
        const text = `${hm.src.text ?? ""}${hm.root.step}${hm.src.kindText ?? hm.src.kind ?? ""}${deg}${hm.src.bass ? `/${hm.src.bass.step}` : ""}`;
        each("chord", { ...base, beat: hm.offset.toFloat(), text }, (p) => {
          const dx = numberProp(p.dx, 0, pt);
          const dy = numberProp(p.dy, 0, pt);
          if (dx) hm.x += dx;
          if (dy) hm.y += dy;
        });
      }
      for (const ch of md.chords) chordRules(ch, md, base, each);
    }
  }
  return { hits };
}

function lyricRules(l: LyricLayout, base: Ctx, each: (role: string, ctx: Ctx, apply: (p: Record<string, Expr>) => void) => void, pt: number): void {
  const ctx: Ctx = { ...base, verse: l.src.number, name: l.num, text: l.text };
  each("lyric", ctx, (p) => {
    const family = valueOf(p.family);
    const size = numberProp(p.size, l.font.size, pt);
    if (typeof family === "string" || size !== undefined) {
      l.font = new Font(typeof family === "string" ? family : l.font.family, size ?? l.font.size, l.font.bold);
    }
    const dy = numberProp(p.dy, 0, pt);
    if (dy) l.y += dy;
  });
  if (l.prefix) {
    each("verseNum", { ...ctx, text: l.prefix }, (p) => {
      const t = valueOf(p.text);
      if (typeof t === "string") (l.src as { text: string }).text = t + l.text;
    });
  }
}

function textRules(
  t: MeasureText,
  base: Ctx,
  each: (role: string, ctx: Ctx, apply: (p: Record<string, Expr>) => void) => void,
  pt: number,
  phase: "measure" | "draw",
): void {
  const text = t.data.map((d) => d.text).join("");
  each("direction", { ...base, text, glyph: text, beat: t.offset.toFloat() }, (p) => {
    if (phase === "measure") {
      const dx = numberProp(p.dx, 0, pt);
      const dy = numberProp(p.dy, 0, pt);
      if (dx) t.x += dx;
      if (dy) t.y += dy;
      return;
    }
    const split = valueOf(p["text-split"]) === "each";
    const blankRaw = valueOf(p["blank-after"]);
    const blank = new Set((Array.isArray(blankRaw) ? blankRaw : blankRaw === undefined ? [] : [blankRaw]).map(Number));
    if (split || blank.size) {
      // 原排版程序：每项后面插换行；指定的几项之后再插一个「空格 + 换行」当空行
      const out: typeof t.data = [];
      t.data.forEach((d, i) => {
        out.push(d);
        if (d.text === "\n") return;
        if (split) out.push({ ...d, text: "\n" });
        if (blank.has(i)) out.push({ ...d, text: " " }, { ...d, text: "\n" });
      });
      t.data = out;
    }
  });
}

function chordRules(ch: ChordLayout, md: PartMeasureLayout, base: Ctx, each: (role: string, ctx: Ctx, apply: (p: Record<string, Expr>) => void) => void): void {
  void md;
  const ctx: Ctx = { ...base, beat: ch.offset.toFloat(), voice: ch.src.voice };
  each("note", ctx, (p) => {
    const cue = valueOf(p.cue);
    if (cue === true) (ch.src as { cue?: boolean }).cue = true;
    else if (cue === false) delete (ch.src as { cue?: boolean }).cue;
    const stem = valueOf(p.stem);
    if (stem === "up") ch.stemUp = true;
    else if (stem === "down") ch.stemUp = false;
  });
}
