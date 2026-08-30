// 书级元数据：原书上那些 musicxml 装不下的内容。
//
// 出处与去处：
//   page-report.mjs → pdf-layout.json（666 个 PageSpec）→ **本文件** → 校对.db
//   → rebuild.mjs（B 路重排）照着排回去
//
// 装不下的是哪些：调号拍号原文（`1=♭B 4/4 (1=A)`，musicxml 只有 fifths/beats，
// 而且拍号在原书是上下叠排）、段落词（副歌/间奏）、花边框里的圣诗故事与经文注解、
// 目录、首句索引、扉页与前言、页眉分类名、印刷页码。
//
// 判据一律写在各提取函数的注释里，**每条都附反例**——这些判据是拿具体页换来的。
//
// 无 DOM 依赖（Node CLI 要 import）。
import type { PageSpec, TextRun, SongPlacement, PageMapEntry } from "./spec";
import type { Rect } from "../omr/types";

/** 逐字覆盖：形状键 → 字（校对.db 的 glyph_fix）。返回 null 表示还是读不出。 */
export type CharOverride = (key: string, current: string) => string | null;

const UNREAD = "�";

/** 一个 run 的文本，套上人工/OCR 补字。读不出的位置留空（**绝不写问号**，
 *  那会跟着排进 PDF）。 */
/** 西文（拉丁字母 / 数字）—— 只有这两族之间才按字距补空格。 */
const LATIN_EDGE = /[A-Za-z0-9]$/;
const LATIN_HEAD = /^[A-Za-z0-9]/;

export function runText(run: TextRun | null | undefined, ov?: CharOverride): string {
  if (!run) return "";
  const out: string[] = [];
  let prev: { text: string; right: number; h: number } | null = null;
  for (const c of run.chars) {
    const text = ov?.(c.key, c.ch) ?? (c.ch === UNREAD ? "" : c.ch);
    if (!text) continue;
    // **空格在矢量 PDF 里没有对象**，只能按字距还原：西文词之间的空档比字内间隙宽得多
    //（037 的「Martin Luther」两个对象之间空 4.5pt，字号才 8.8）。
    // 只在两侧都是西文时补——汉字之间本来就疏，照这个补会到处塞空格。
    if (prev && LATIN_EDGE.test(prev.text) && LATIN_HEAD.test(text)) {
      const gap = c.x - prev.right;
      if (gap > Math.max(prev.h, c.h) * 0.22) out.push(" ");
    }
    out.push(text);
    prev = { text, right: c.x + c.w, h: c.h };
  }
  return out.join("");
}

/** 逐字展开（覆盖后一个元素可能是多字：花边框正文常把一段字合成一个 path 对象）。 */
export function runChars(run: TextRun, ov?: CharOverride): { ch: string; x: number; y: number; w: number; h: number }[] {
  return run.chars.map((c) => ({ ...c, ch: ov?.(c.key, c.ch) ?? (c.ch === UNREAD ? "" : c.ch) }));
}

const median = (v: number[]): number => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : 0);
const bottom = (r: { y: number; h: number }) => r.y + r.h;
const right = (r: { x: number; w: number }) => r.x + r.w;

// ────────────────────────────────────────────────────────────── 调号拍号

export interface KeyMeter {
  songId: string;
  /** 主调，形如 `C` / `♭B` / `#F`。 */
  tonic: string;
  /** 拍号（原书上下叠排，中间一条 12.3×0.3 的细横线）。 */
  beats: number | null;
  beatType: number | null;
  /** 括号里的移调建议 `(1=A)`。 */
  altTonic: string | null;
  raw: string;
  page: number;
}

/**
 * `1=♭B  4/4  (1=A)` 的原文解析。
 *
 * 判据（都不能只看文本，得看逐字的 x/y）：
 * - **`=` 读作「二」**：等号那个字形在字典里被学成「二」（两条横）。这里按位置认，
 *   不改字典——「二」在歌词里是真字，全局替换会误伤。
 * - **拍号是上下叠排**：两个数字 x 几乎相同、y 差一行，中间一条 12.3×0.3 的细横线
 *   （那条线不是字，PageSpec 里读不出，跳过就是）。12/8 拍上排是两位数，
 *   所以按 y 分上下两簇、簇内按 x 拼串，不能假定各一位。
 * - **括号里是移调建议**：`(1=A)`，给不方便唱原调的人。没有括号的占多数。
 */
export function parseKeyMeter(song: SongPlacement, page: number, ov?: CharOverride): KeyMeter | null {
  if (!song.keyMeterRun || !song.id) return null;
  const cs = runChars(song.keyMeterRun, ov)
    .filter((c) => c.ch !== "")
    .sort((a, b) => a.x - b.x);
  const raw = cs.map((c) => c.ch).join("");
  const isEq = (ch: string) => ch === "=" || ch === "二";
  const eq = cs.findIndex((c) => isEq(c.ch));
  if (eq < 0) return null;
  const open = cs.findIndex((c) => c.ch === "(" || c.ch === "（");
  // 头段（主调 + 拍号）到哪儿为止：有括号就到括号；没有括号（那两个括号字形有时读不出，
  // 019 就是这样）就到**第二个等号前一位**——「1=♭A 4/4 1=A」里那个 1 是移调建议的，
  // 混进拍号会算出 44/1。
  const eq2 = cs.findIndex((c, i) => i > eq && isEq(c.ch));
  const cut = open >= 0 ? open : eq2 >= 0 ? Math.max(eq + 1, eq2 - 1) : cs.length;
  const head = cs.slice(eq + 1, cut);
  // 主调：等号之后、第一个数字之前的字母（含升降号）
  let tonic = "";
  for (const c of head) {
    if (/[0-9]/.test(c.ch)) break;
    tonic += c.ch;
  }
  tonic = tonic.replace(/^b/, "♭").replace(/^#/, "♯").trim();
  // 拍号：等号之后的数字按 y 分上下两簇
  const digits = head.filter((c) => /^[0-9]$/.test(c.ch));
  let beats: number | null = null;
  let beatType: number | null = null;
  if (digits.length >= 2) {
    const mid = (Math.min(...digits.map((d) => d.y)) + Math.max(...digits.map((d) => bottom(d)))) / 2;
    const up = digits.filter((d) => bottom(d) <= mid + 0.5).sort((a, b) => a.x - b.x);
    const dn = digits.filter((d) => bottom(d) > mid + 0.5).sort((a, b) => a.x - b.x);
    if (up.length && dn.length) {
      beats = Number(up.map((d) => d.ch).join(""));
      beatType = Number(dn.map((d) => d.ch).join(""));
      // 拍号有常识范围：分母只可能是 1/2/4/8/16，分子不过二十几。
      // 算出 44/4143 这种就是分组分岔了，宁可留空也不写进去。
      if (!(beats >= 1 && beats <= 24 && [1, 2, 4, 8, 16].includes(beatType))) {
        beats = null;
        beatType = null;
      }
    }
  }
  // 移调建议：括号里第二个等号之后的字母
  let altTonic: string | null = null;
  if (open >= 0 || eq2 >= 0) {
    const tail = cs.slice(open >= 0 ? open + 1 : eq2 - 1);
    const e2 = tail.findIndex((c) => isEq(c.ch));
    if (e2 >= 0) {
      altTonic = tail
        .slice(e2 + 1)
        .map((c) => c.ch)
        .join("")
        .replace(/[)）]/g, "")
        .replace(/^b/, "♭")
        .replace(/^#/, "♯")
        .trim();
      // 括号右半边读不出时后面会粘上别的字（064 粘出「♭B68182」），
      // 调名就那么几种写法，不合规的一律丢掉。
      const m2 = /^([b#♭♯]?[A-G])/.exec(altTonic.replace("♭", "b").replace("♯", "#"));
      altTonic = m2 ? m2[1].replace(/^b/, "♭").replace(/^#/, "♯") : null;
    }
  }
  if (!tonic) return null;
  return { songId: song.id, tonic, beats, beatType, altTonic: altTonic || null, raw, page };
}

// ────────────────────────────────────────────────────────────── 段落词

export interface SectionWord {
  songId: string;
  text: string;
  /** 锚点：这首歌里第几个音符（只数数字音符，从 0 起）。重排时优先按它定位。 */
  noteOrdinal: number;
  /** 备用锚点：第几小节（从 0 起）。 */
  measureIndex: number;
  systemIndex: number;
  page: number;
}

/** 段落词词表。原书印在**和弦带**里（与和弦同一条 run），所以既要认得出、
 *  又不能把和弦当成段落词——`Am`/`G/B` 里没有汉字，这一条就够分。 */
const SECTION_WORDS = /(副歌|间奏|前奏|尾奏|结束句|结束|齐唱|独唱|轮唱|合唱|重唱|末节|反复|尾声)/;

/** 一行和弦带里切出段落词，连同它在行内的 x（用来找锚点音符）。 */
function sectionTokens(run: TextRun, ov?: CharOverride): { text: string; x: number }[] {
  const cs = runChars(run, ov).sort((a, b) => a.x - b.x);
  const out: { text: string; x: number }[] = [];
  // 逐字扫：汉字连成一段（和弦里没有汉字），整段命中词表才算
  let cur: typeof cs = [];
  const flush = () => {
    if (cur.length) {
      const t = cur.map((c) => c.ch).join("");
      if (SECTION_WORDS.test(t)) out.push({ text: t, x: cur[0].x });
    }
    cur = [];
  };
  for (const c of cs) {
    if (/[一-鿿（）()]/.test(c.ch)) cur.push(c);
    else flush();
  }
  flush();
  return out;
}

// ────────────────────────────────────────────────────────────── 花边框 / 经文

export interface Annotation {
  songId: string | null;
  /** 原书这一框的正文字号（墨迹高中位）。同一批花边框里 6.5~10.5 都有——
   *  原书是按剩余空间缩排的，重排时按它反算行距比例。 */
  size: number;
  /** 有没有花边框（`ornament` 纹样拼的那种）。 */
  framed: boolean;
  /** 框的样子：`tile` = 花边纹样框、`line` = 双细线矩形框（022/023 那种）、`none` = 不装框。
   *  原先只认花边框，线框被当成「没框」，重排时那一圈线就丢了。 */
  frame?: "tile" | "line" | "none";
  /** 线框的外框线宽与内外两圈的间距（pt，实测；`frame === "line"` 时有值）。 */
  frameOuterWidth?: number;
  frameInnerWidth?: number;
  frameGap?: number;
  /** 这一框用的花边样式 id（`frame === "tile"` 时有值）。全书 110 个框几乎各不相同，
   *  所以要逐框记，不能像原先那样全书共用一套母题。 */
  frameStyle?: string;
  /** 哪几条边真有纹样，如 `"TBLR"`。有的框缺一条边（原书就那样印的），缺的边不画。 */
  frameEdges?: string;
  text: string;
  box: Rect;
  page: number;
}

/** b 是否整个落在 a 里（留一点余量：文字包围盒偶尔擦着框线）。 */
function contains(a: Rect, b: Rect): boolean {
  const m = 2;
  return b.x >= a.x - m && b.y >= a.y - m && b.x + b.w <= a.x + a.w + m && b.y + b.h <= a.y + a.h + m;
}

export interface RuleFrame {
  box: Rect;
  /** 外圈线宽、内圈线宽、两圈之间的空隙（pt）。 */
  outer: number;
  inner: number;
  gap: number;
}

/**
 * 把页面上的直线（`rule-h` / `rule-v`）聚成一圈圈**矩形线框**。
 *
 * 原书的经文框是内外两圈：外圈约 1.5pt 见方、内圈约 0.4pt，中间空 1.7pt 左右
 * （022/023 那两页量到的）。识别时不分内外圈，先按「互相挨着」并成一簇，
 * 再用簇的包围盒当框；内外两圈的粗细与间距从簇里的线宽分布反推，重排照画。
 * 至少四条线才算框——单条 rule 是分隔线，不是框。
 */
export function clusterRuleFrames(frames: { type: string; box: Rect; lineWidth: number }[]): RuleFrame[] {
  const rules = frames.filter((f) => f.type === "rule-h" || f.type === "rule-v");
  if (rules.length < 4) return [];
  const parent = rules.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = (a: Rect, b: Rect): boolean => {
    const m = 4; // 内外两圈之间空 1.7pt，四角也不一定严丝合缝
    return a.x - m <= b.x + b.w && b.x - m <= a.x + a.w && a.y - m <= b.y + b.h && b.y - m <= a.y + a.h;
  };
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++)
      if (near(rules[i].box, rules[j].box)) parent[find(i)] = find(j);
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < rules.length; i++) {
    const r = find(i);
    const a = byRoot.get(r) ?? [];
    a.push(i);
    byRoot.set(r, a);
  }
  const out: RuleFrame[] = [];
  for (const idxs of byRoot.values()) {
    if (idxs.length < 4) continue;
    const bs = idxs.map((i) => rules[i].box);
    const x = Math.min(...bs.map((b) => b.x));
    const y = Math.min(...bs.map((b) => b.y));
    const w = Math.max(...bs.map((b) => b.x + b.w)) - x;
    const h = Math.max(...bs.map((b) => b.y + b.h)) - y;
    if (w < 40 || h < 10) continue; // 太小的不是框
    // 线宽：横线取 h、竖线取 w（转曲后的线是细长矩形，lineWidth 字段未必可靠）
    const ws = idxs.map((i) => (rules[i].type === "rule-h" ? rules[i].box.h : rules[i].box.w)).sort((a, b) => a - b);
    const inner = ws[0];
    const outer = ws[ws.length - 1];
    // 内外圈的间距：外圈内缘到内圈外缘
    const inners = idxs.filter((i) => (rules[i].type === "rule-h" ? rules[i].box.h : rules[i].box.w) <= (inner + outer) / 2);
    const gap = inners.length ? Math.max(0, Math.min(...inners.map((i) => rules[i].box.y - y)) - outer) : 0;
    out.push({ box: { x, y, w, h }, outer: r2(outer), inner: r2(inner), gap: r2(gap) });
  }
  return out;
}

const r2 = (v: number): number => Number(v.toFixed(2));

/**
 * 乐谱页上的注解正文行，按**框**分组。
 *
 * 两种：022/023 那种双细线矩形框（`clusterRuleFrames` 认出来的圈），
 * 以及 p36 / p39 那种没有框、直接印在谱行下方的经文。
 *
 * 框外那一路要跟「掉出谱行的一」分开：乐谱页 textLines 里 467 行是纯粹的「一」
 *（歌词里的一悬在字格中部，聚行时会掉出来），所以要求 8 个以上汉字、且不同的字有 4 个以上。
 * **框内不套这条**——框本身就是强凭据，框里那半行「(诗 150:6)」汉字不够也是正文；
 * 套上去的话读不出的字一多，整框就整个丢了。
 */
export function scoreAnnotationGroups(
  spec: PageSpec,
  lineBoxes: RuleFrame[],
  ov?: CharOverride,
): { frame: RuleFrame | null; lines: TextRun[] }[] {
  if (spec.kind !== "score" || !spec.textLines.length) return [];
  const out: { frame: RuleFrame | null; lines: TextRun[] }[] = [];
  const taken = new Set<TextRun>();
  for (const f of lineBoxes) {
    const inside = spec.textLines.filter((l) => contains(f.box, l.box));
    if (!inside.length) continue;
    for (const l of inside) taken.add(l);
    const cjk = (runText({ chars: inside.flatMap((l) => l.chars) } as TextRun, ov).match(/[一-鿿]/g) ?? []).length;
    if (cjk >= 8) out.push({ frame: f, lines: inside });
  }
  const realText = (t: string) => {
    const cjk = t.match(/[一-鿿]/g) ?? [];
    return cjk.length >= 8 && new Set(cjk).size >= 4;
  };
  const rest = spec.textLines.filter((l) => !taken.has(l) && realText(runText(l, ov)));
  if (rest.length) out.push({ frame: null, lines: rest });
  return out;
}

/**
 * 框内文字重新聚行。
 *
 * `spec.ts::groupLines` 的容差是固定 4pt，对花边框正文偏紧：p46 那一框里
 * 同一条视觉行被拆成两组（框内混着 8.2 与 10.5 两档字），拼出来是
 * 「1这一信胜的凯他心 / 《有活的确据》(3首)是首徒得歌」这种乱序。
 * 改成按**框内行距中位数的 0.45 倍**聚行，两档字号也能并回同一行。
 *
 * **矮元素（标点、引号）另走一趟**：按下缘聚行只对正文字管用——引号悬在字身上部
 *（p54 那句经文开头的「“」下缘比同行正文高 5.5pt），句读点又比正文低一点点，
 * 一趟贪心下来「“」把整组的基准带高，同一行的「，。()：」就被甩进了下一组，
 * 排出来是「…救恩代上16 23 / ，。(：)」。所以先只拿**正文高度**的元素聚出行、
 * 定出每行的字身区间，矮元素再按**中心 y** 认领最近的那一行。
 */
export function groupBoxRows(lines: TextRun[]): TextRun["chars"][] {
  const chars = lines.flatMap((l) => l.chars);
  if (!chars.length) return [];
  const baselines = [...new Set(lines.map((l) => l.baselineY))].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < baselines.length; i++) gaps.push(baselines[i] - baselines[i - 1]);
  const pitch = median(gaps.filter((g) => g > 2)) || 12;
  const tol = Math.max(3, pitch * 0.45);
  const body = median(chars.map((c) => c.h)) || 1;
  const tall = chars.filter((c) => c.h >= body * 0.5);
  const short = chars.filter((c) => c.h < body * 0.5);
  const seed = (tall.length ? tall : chars).sort((a, b) => bottom(a) - bottom(b));
  const rows: { y: number; items: TextRun["chars"] }[] = [];
  for (const c of seed) {
    const last = rows[rows.length - 1];
    // 与组内**最后一个**（下缘最大的）比，不是与组首比——组首固定的话，一组里
    // 攒够几个 1pt 的小台阶就会把后面的甩掉。
    if (last && bottom(c) - last.y <= tol) {
      last.items.push(c);
      last.y = bottom(c);
    } else rows.push({ y: bottom(c), items: [c] });
  }
  if (tall.length)
    for (const c of short) {
      const cy = c.y + c.h / 2;
      let best = rows[0];
      let bestD = Infinity;
      for (const r of rows) {
        const top = Math.min(...r.items.map((it) => it.y));
        const bot = Math.max(...r.items.map((it) => bottom(it)));
        const d = cy < top ? top - cy : cy > bot ? cy - bot : 0;
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
      if (best) best.items.push(c);
    }
  return rows.map((r) => [...r.items].sort((a, b) => a.x - b.x));
}

/** 框内文字重新聚行 → 逐行文本（聚行判据见 `groupBoxRows`）。 */
export function regroupBoxLines(lines: TextRun[], ov?: CharOverride): string[] {
  return (
    groupBoxRows(lines)
      .map((items) => runText({ chars: items } as TextRun, ov))
      // 花边框四角的纹样偶尔被当成字（读作 X / XX），一两个拉丁字母独占一行
      // 在这本书的注解正文里不可能出现，丢掉。
      .filter((t) => t.trim().length >= 2 && !/^[A-Za-z]{1,2}$/.test(t.trim()))
  );
}

// ────────────────────────────────────────────────────────────── 目录 / 索引

export interface TocRow {
  seq: number;
  kind: "category" | "subcategory" | "entry";
  text: string;
  songId: string | null;
  printedPage: number | null;
  page: number;
}

export interface IndexRow {
  seq: number;
  /** `heading` 是分节标题（笔划数「5画」、拼音字头「A」），`entry` 是条目。 */
  kind: "heading" | "entry";
  /** 哪一份索引：`title` 诗题笔划索引、`firstline` 歌词首句索引。 */
  indexName: string;
  text: string;
  /** 条目末尾那个数是**曲号**，不是页码（实测「一百只羊有九十九156」= 156 首）。
   *  两份索引都按曲号编，所以重排时不必等页码定下来。 */
  songId: string | null;
  page: number;
}

/** 目录条目：`1.圣哉，圣哉，圣哉(1)`。曲号在前、印刷页码在圆括号里。 */
const TOC_ENTRY = /^(\d+)\s*[.、·]?\s*(.*?)[（(](\d+)[)）]\s*$/;

/** 这一页是不是目录页。**不能只看 PageSpec.kind**：p13 / p32 是目录的续页，
 *  却因为读不出的字太多被判成 front-matter。按「多少行长得像目录条目」判。 */
export function isTocPage(spec: PageSpec, ov?: CharOverride): boolean {
  if (spec.songs.length) return false;
  const lines = spec.textLines.map((l) => runText(l, ov));
  const hit = lines.filter((t) => TOC_ENTRY.test(t)).length;
  return lines.length >= 8 && hit >= lines.length * 0.5;
}

/** 索引页：条目**不带圆括号**、以数字收尾，两栏并排
 *  （`groupLines` 把左右两栏并成了一行，得按「文字+数字」成对切开，
 *  不能按 x 缺口——页码紧挨着下一栏的头一个字，缺口只有半个字宽）。 */
export function isIndexPage(spec: PageSpec, ov?: CharOverride): boolean {
  if (spec.songs.length) return false;
  const lines = spec.textLines.map((l) => runText(l, ov));
  const hit = lines.filter((t) => /\d\s*$/.test(t) && !TOC_ENTRY.test(t)).length;
  return lines.length >= 10 && hit >= lines.length * 0.6;
}

/** 索引行 → 条目与分节标题。
 *
 * 一行长这样：`一百只羊有九十九156丰盛慈爱已进来291`（左右两栏并成了一行）。
 * 按「一串非数字 + 一串数字」成对切，数字就是**曲号**。
 * 另有两种插在行里的东西要认出来：`5画`（笔划索引的分节）与孤立的大写字母
 * `A`/`D`（首句索引的拼音字头，常粘在上一条的末尾）。
 */
export function parseIndexLine(text: string): { kind: "heading" | "entry"; text: string; songId: string | null }[] {
  const out: { kind: "heading" | "entry"; text: string; songId: string | null }[] = [];
  let i = 0;
  const t = text.trim();
  while (i < t.length) {
    const head = /^(\d+)\s*画/.exec(t.slice(i));
    if (head) {
      out.push({ kind: "heading", text: `${head[1]}画`, songId: null });
      i += head[0].length;
      continue;
    }
    if (/^[A-Z]$/.test(t[i]) && !/[A-Za-z]/.test(t[i + 1] ?? "")) {
      out.push({ kind: "heading", text: t[i], songId: null });
      i += 1;
      continue;
    }
    const pair = /^([^\d]+?)(\d{1,3})/.exec(t.slice(i));
    if (!pair) break;
    const label = pair[1].trim();
    // 「首数」是栏头，不是条目
    if (label && !/^(首数)+$/.test(label)) out.push({ kind: "entry", text: label, songId: pair[2].padStart(3, "0") });
    i += pair[0].length;
  }
  return out;
}

// ────────────────────────────────────────────────────────────── 扉页 / 前言

export interface FrontPage {
  page: number;
  /** `divider` 只有几个大字（「附 录」），`prose` 是整页正文（主祷文、使徒信经）。 */
  kind: "divider" | "prose";
  title: string;
  body: string;
  note: string | null;
}

// ────────────────────────────────────────────────────────────── 花边纹样

/** 花边框上的一个位置：四条边 + 四个角。 */
export type TileSlot = "top" | "bottom" | "left" | "right" | "tl" | "tr" | "bl" | "br";

export const TILE_SLOTS: TileSlot[] = ["top", "bottom", "left", "right", "tl", "tr", "bl", "br"];

export interface OrnamentTile {
  /** 同款花边共用一个 id（按八个槽的路径内容算）。 */
  style: string;
  slot: TileSlot;
  w: number;
  h: number;
  /** 相邻两片的步距（角片恒为 0）。 */
  pitch: number;
  /** 角片相对框角的偏移；边片恒为 0。角片压在角上、比边突出去一点，不存会画偏。 */
  ox: number;
  oy: number;
  /** 归一化到 (0,0) 的路径。整圈边框重排时由它平铺拼成**一条** path。 */
  path: string;
}

/** 把绝对坐标的路径平移到原点（矢量抽取器只产出绝对的 M/L/C/Z）。 */
export function translatePath(d: string, dx: number, dy: number): string {
  let i = 0;
  let out = "";
  const num = /-?\d*\.?\d+(?:e[-+]?\d+)?/gy;
  while (i < d.length) {
    const c = d[i];
    if (/[MLCZ]/i.test(c)) {
      out += c;
      i++;
      if (c.toUpperCase() === "Z") continue;
      const n = c.toUpperCase() === "C" ? 6 : 2;
      const vals: number[] = [];
      for (let k = 0; k < n; k++) {
        num.lastIndex = i;
        const m = num.exec(d);
        if (!m) break;
        vals.push(Number(m[0]));
        i = num.lastIndex;
        while (d[i] === " " || d[i] === ",") i++;
      }
      out += vals.map((v, k) => (k % 2 === 0 ? v + dx : v + dy).toFixed(2)).join(" ");
    } else i++;
  }
  return out;
}

/**
 * 从一个花边框里取出它的八片母题：四条边 + 四个角。
 *
 * **不能按长宽比分横竖**（老做法 `box.w > box.h`）。原因有两条：
 *   - 四角是**第三枚**字形，尺寸与边片不同（p42 角片 7.7×7.6，边片 10.8×5.0），
 *     按比例分只会把它塞进横或竖里去，重排时四角就没得画，只能靠边的端片重叠糊。
 *   - 有的花边母题近方形（p79 的 4.2×4.5、p253 的 9.2×8.8），横竖之比在 1 附近打转，
 *     分出来的方向纯看抖动。
 * 改按**位置**：件的中心落在框的哪条边带、哪个角容差里，就是哪个槽。
 *
 * 另外，「全书同一母题」这句是错的——实测 110 个框，把八槽的路径平移归一后
 * **量化到 1pt 仍有 107 套不同**（不是抖动，是真的不同纹样：10.8×5.0、10.7×3.6、
 * 4.2×4.5、9.2×8.8…）。老代码只存了第一页的两片，重排里 109 个框的花边全画错了。
 * 所以逐框提取、按内容去重，不做形状聚类。
 */
export function extractOrnamentTiles(spec: PageSpec, box: Rect, noteH: number): OrnamentTile[] {
  const orn = spec.marks.filter(
    (m) => m.cls === "ornament" && m.d && m.box.x >= box.x - 1 && m.box.y >= box.y - 1 && right(m.box) <= right(box) + 1 && bottom(m.box) <= bottom(box) + 1,
  );
  if (!orn.length) return [];
  const edge = Math.max(noteH * 0.8, Math.min(box.w, box.h) * 0.06);
  const near = noteH * 1.35;
  const slotOf = (b: Rect): TileSlot | null => {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const atL = cx - box.x <= near;
    const atR = right(box) - cx <= near;
    const atT = cy - box.y <= near;
    const atB = bottom(box) - cy <= near;
    if (atT && atL) return "tl";
    if (atT && atR) return "tr";
    if (atB && atL) return "bl";
    if (atB && atR) return "br";
    const dT = cy - box.y;
    const dB = bottom(box) - cy;
    const dL = cx - box.x;
    const dR = right(box) - cx;
    const mn = Math.min(dT, dB, dL, dR);
    if (mn > edge) return null;
    return mn === dT ? "top" : mn === dB ? "bottom" : mn === dL ? "left" : "right";
  };

  const bySlot = new Map<TileSlot, { box: Rect; d: string }[]>();
  for (const m of orn) {
    const s = slotOf(m.box);
    if (!s) continue;
    const a = bySlot.get(s) ?? [];
    a.push({ box: m.box, d: m.d! });
    bySlot.set(s, a);
  }

  const out: OrnamentTile[] = [];
  for (const slot of TILE_SLOTS) {
    const a = bySlot.get(slot);
    if (!a?.length) continue;
    // 代表片：该槽里出现最多的那条路径（归一到自身原点后比）
    const tally = new Map<string, { n: number; box: Rect }>();
    for (const m of a) {
      const k = translatePath(m.d, -m.box.x, -m.box.y);
      const e = tally.get(k);
      if (e) e.n++;
      else tally.set(k, { n: 1, box: m.box });
    }
    const [path, rep] = [...tally].sort((x, y) => y[1].n - x[1].n)[0];
    const horiz = slot === "top" || slot === "bottom";
    const corner = slot.length === 2;
    // 步距：同一条边上相邻两片的间距中位数（角片没有步距）
    let pitch = 0;
    if (!corner) {
      const pos = a.map((m) => (horiz ? m.box.x : m.box.y)).sort((p, q) => p - q);
      const gaps: number[] = [];
      for (let i = 1; i < pos.length; i++) gaps.push(pos[i] - pos[i - 1]);
      pitch = median(gaps) || (horiz ? rep.box.w : rep.box.h);
    }
    // 角片相对框角的偏移（角片常比边突出去一点）
    let ox = 0;
    let oy = 0;
    if (corner) {
      ox = rep.box.x - (slot[1] === "l" ? box.x : right(box) - rep.box.w);
      oy = rep.box.y - (slot[0] === "t" ? box.y : bottom(box) - rep.box.h);
    }
    out.push({
      style: "",
      slot,
      w: Number(rep.box.w.toFixed(3)),
      h: Number(rep.box.h.toFixed(3)),
      pitch: Number(pitch.toFixed(3)),
      ox: Number(ox.toFixed(3)),
      oy: Number(oy.toFixed(3)),
      path,
    });
  }
  // 样式 id：八个槽的路径内容。同款框自然并成一条。
  const id = hashHex(out.map((t) => `${t.slot}:${t.path}`).join("|"));
  for (const t of out) t.style = id;
  return out;
}

/** 哪几条边有纹样，如 `"TBLR"`。缺的边重排时不画（原书就那样印的）。 */
export function edgeMask(tiles: OrnamentTile[]): string {
  const has = new Set(tiles.map((t) => t.slot));
  return (has.has("top") ? "T" : "") + (has.has("bottom") ? "B" : "") + (has.has("left") ? "L" : "") + (has.has("right") ? "R" : "");
}

/**
 * 注解归给**框上方最近的那一首**。
 *
 * 老做法是「y 落在 `[yFrom, yTo)` 里的那首，落不进就取本页最后一首」。注解讲的是它
 * 跟着的那首歌，正确的口径就是框上方最近的一首；y 区间那套在框恰好压过区间边界、
 * 或框在页顶（上一首跨页续排）时会归错。
 */
function ownerAbove(spec: PageSpec, y: number): string | null {
  const above = spec.songs.filter((s) => s.yFrom <= y).sort((a, b) => b.yFrom - a.yFrom)[0];
  return above?.id ?? spec.songs[spec.songs.length - 1]?.id ?? null;
}

/** 短哈希（djb2+sdbm，与 glyphdict 的 `hash2` 同法）。只用来给同款花边并 id。 */
function hashHex(s: string): string {
  let a = 5381;
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = (a * 33) ^ c;
    b = (c + (b << 6) + (b << 16) - b) | 0;
  }
  return ((a >>> 0).toString(36) + "-" + (b >>> 0).toString(36)).slice(0, 14);
}

// ────────────────────────────────────────────────────────────── 总装

export interface PageLabel {
  page: number;
  label: string;
  no: number | null;
  kind: string;
}

export interface BookMeta {
  keyMeters: KeyMeter[];
  sectionWords: SectionWord[];
  annotations: Annotation[];
  toc: TocRow[];
  index: IndexRow[];
  front: FrontPage[];
  pageLabels: PageLabel[];
  ornaments: OrnamentTile[];
  /** 提取不出来的东西逐条记账——**不许静默吞**。 */
  problems: string[];
}

export interface BookMetaOptions {
  override?: CharOverride;
  /** 页 → 该页上的曲目（gen-pagemap 的结果），用来把花边框与索引条目归到曲上。 */
  entriesByPage?: Map<number, PageMapEntry[]>;
  /** 音符字号（`noteHeightOf(profile)`）。花边框分槽的边带宽与角容差都按它算。 */
  noteH?: number;
}

export function buildBookMeta(specs: PageSpec[], opt: BookMetaOptions = {}): BookMeta {
  const ov = opt.override;
  const noteH = opt.noteH ?? 8.3;
  const meta: BookMeta = {
    keyMeters: [],
    sectionWords: [],
    annotations: [],
    toc: [],
    index: [],
    front: [],
    pageLabels: [],
    ornaments: [],
    problems: [],
  };

  // 印刷页码：页脚形如 `·118·`。乐谱区的印刷页 = PDF 页 − 32，
  // 但**前置页自成一套**（目录页脚也是 ·1· 起），所以只能照抄、不能算。
  for (const s of specs) {
    const label = runText(s.footer, ov);
    const m = /(\d+)/.exec(label);
    meta.pageLabels.push({ page: s.page, label, no: m ? Number(m[1]) : null, kind: s.kind });
  }

  // 曲目级：调号拍号、段落词、花边框
  const noteBase = new Map<string, number>(); // 曲号 → 已数过的音符数
  const measBase = new Map<string, number>();
  for (const spec of specs) {
    for (const song of spec.songs) {
      if (!song.id) continue;
      if (song.keyMeterRun) {
        const km = parseKeyMeter(song, spec.page, ov);
        if (km) meta.keyMeters.push(km);
        else meta.problems.push(`p${spec.page} ${song.id}：调号拍号解析不出「${runText(song.keyMeterRun, ov)}」`);
      }
      let nOrd = noteBase.get(song.id) ?? 0;
      let nMeas = measBase.get(song.id) ?? 0;
      for (const sys of song.systems) {
        const notes = sys.notes.filter((n) => /^[0-9]$/.test(ov?.(n.key, n.ch) ?? n.ch)).sort((a, b) => a.x - b.x);
        for (const line of sys.chordLines) {
          for (const tok of sectionTokens(line, ov)) {
            // 锚点取**右侧最近**的音符：段落词印在它所辖那一段的头上，
            // 取最近的话，落在小节线左边一点点时会挂到上一小节的末音上。
            let idx = notes.findIndex((n) => n.x + n.w / 2 >= tok.x);
            if (idx < 0) idx = Math.max(0, notes.length - 1);
            const meas = sys.barlineXs.filter((x) => x < tok.x).length;
            meta.sectionWords.push({
              songId: song.id,
              text: tok.text,
              noteOrdinal: nOrd + idx,
              measureIndex: nMeas + meas,
              systemIndex: sys.index,
              page: spec.page,
            });
          }
        }
        nOrd += notes.length;
        nMeas += sys.barlineXs.length;
      }
      noteBase.set(song.id, nOrd);
      measBase.set(song.id, nMeas);
    }

    // 线框（022/023 那种双细线矩形）：把 rule-h / rule-v 按「互相挨着」聚成一圈圈框。
    // 原书这类框是**内外两圈**：外圈粗（1.5pt 见方）、内圈细（0.4pt），中间空 1.7pt 左右。
    const lineBoxes = clusterRuleFrames(spec.frames);

    // 花边框：归给**框上方最近的那一首**——注解讲的是它跟着的那首歌。
    for (const box of spec.storyBoxes) {
      const owner = ownerAbove(spec, box.box.y);
      const text = regroupBoxLines(box.lines, ov).join("\n");
      if (text.replace(/\s/g, "").length < 4) continue;
      const hs = box.lines.flatMap((l) => l.chars.map((c) => c.h)).filter((h) => h > 2);
      const tiles = extractOrnamentTiles(spec, box.box, noteH);
      if (tiles.length) meta.ornaments.push(...tiles);
      meta.annotations.push({
        songId: owner,
        framed: true,
        frame: "tile",
        size: Number(median(hs).toFixed(2)),
        text,
        box: box.box,
        page: spec.page,
        ...(tiles.length ? { frameStyle: tiles[0].style, frameEdges: edgeMask(tiles) } : {}),
      });
    }
    // 乐谱页上的注解正文：022/023 那种**双细线框**里的经文，以及 p36 / p39 那种
    // 没有框、直接印在谱行下方的。分组判据见 `scoreAnnotationGroups`。
    for (const grp of scoreAnnotationGroups(spec, lineBoxes, ov)) {
      // 框内一律走 `regroupBoxLines`：引号、句读点这些矮元素在 `groupLines` 那一层
      // 会掉出正文行自成一组（p54 开头的「“」就是），只有并回同一行才排得出来。
      const lines = regroupBoxLines(grp.lines, ov);
      const text = lines.join("\n");
      const chars = grp.lines.flatMap((l) => l.chars);
      const x = Math.min(...chars.map((c) => c.x));
      const y = Math.min(...chars.map((c) => c.y));
      const textBox = {
        x,
        y,
        w: Math.max(...chars.map((c) => c.x + c.w)) - x,
        h: Math.max(...chars.map((c) => c.y + c.h)) - y,
      };
      const lf = grp.frame;
      meta.annotations.push({
        songId: ownerAbove(spec, y),
        framed: false,
        frame: lf ? "line" : "none",
        ...(lf ? { frameOuterWidth: lf.outer, frameInnerWidth: lf.inner, frameGap: lf.gap } : {}),
        size: Number(median(chars.map((c) => c.h).filter((h) => h > 2)).toFixed(2)),
        text,
        box: lf ? lf.box : textBox,
        page: spec.page,
      });
    }
  }
  // 逐框收来的母题按 (style, slot) 去重——同款花边只存一份。
  const seen = new Set<string>();
  meta.ornaments = meta.ornaments.filter((t) => {
    const k = `${t.style}/${t.slot}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 书级：目录 / 首句索引 / 扉页
  let tocSeq = 0;
  let idxSeq = 0;
  let indexName = "title";
  for (const spec of specs) {
    if (isTocPage(spec, ov)) {
      // 分类标题的字号门槛按**本页条目**定：目录里条目字号本身就在 7.7~10.5 之间浮动
      //（原书为了塞下长曲名会压字），拿全书一个常数判会把「用一生」这种
      // 读残了的条目残片当成二级小标题。实测二级标题比同页条目大 1.15 倍以上。
      const entrySizes = spec.textLines
        .filter((l) => /[（(]\d+[)）]\s*$/.test(runText(l, ov).trim()))
        .map((l) => l.size);
      const headingCut = Math.max(9.8, (median(entrySizes) || 8) * 1.15);
      for (const line of spec.textLines) {
        const text = runText(line, ov).trim();
        if (!text) continue;
        const m = TOC_ENTRY.exec(text);
        const tail = /[（(](\d+)[)）]\s*$/.exec(text);
        if (m || tail) {
          // 带尾页码的一律算条目——曲号或曲名读不全也还是条目，
          // 不这么判的话「掰生命饼(300)」（曲号那两位没读出来）会被当成分类标题。
          meta.toc.push({
            seq: tocSeq++,
            kind: "entry",
            text: (m ? m[2] : text.replace(/[（(]\d+[)）]\s*$/, "")).trim(),
            songId: m ? m[1].padStart(3, "0") : null,
            printedPage: Number(m ? m[3] : tail![1]),
            page: spec.page,
          });
          if (!m) meta.problems.push(`目录 p${spec.page}「${text}」曲号没读出来`);
          continue;
        }
        // 分类标题：没有尾页码、两个以上汉字、不带阿拉伯数字（实测一级 13~15pt、二级 10pt 上下）。
        // 剩下的是引导点线与折行碎片（「2一」「12的一天1」这种），记账丢掉。
        const cjk = (text.match(/[一-鿿]/g) ?? []).length;
        // 16pt 以上是页题（p7 那个大大的「目录」），不是分类
        if (cjk >= 2 && !/\d/.test(text) && line.size >= headingCut && line.size < 16) {
          meta.toc.push({
            seq: tocSeq++,
            kind: line.size >= 12.5 ? "category" : "subcategory",
            text,
            songId: null,
            printedPage: null,
            page: spec.page,
          });
        } else meta.problems.push(`目录 p${spec.page} 认不出的行「${text}」`);
      }
      continue;
    }
    if (isIndexPage(spec, ov)) {
      for (const line of spec.textLines) {
        const text = runText(line, ov).trim();
        if (!text) continue;
        // 索引名从整页最大那行取（「诗题笔划索引」/「歌词首句索引」），
        // 之后的页沿用上一次看到的——续页上没有标题。
        if (line.size >= 14) {
          indexName = /首句/.test(text) ? "firstline" : "title";
          continue;
        }
        for (const r of parseIndexLine(text))
          meta.index.push({ seq: idxSeq++, kind: r.kind, indexName, text: r.text, songId: r.songId, page: spec.page });
      }
      continue;
    }
    if (spec.kind === "front-matter" && spec.textLines.length) {
      // 带谱的前置页（p4 是配了曲调的主祷文、p664 是简谱旋律索引）不算前言正文：
      // 它们的「正文」抽出来是一串音符数字，照排就是一页乱码。
      const musicMarks = spec.marks.filter((m) => m.cls === "barline" || m.cls === "divLine" || m.cls === "augmentLine").length;
      if (musicMarks >= 5) {
        meta.problems.push(`前置页 p${spec.page} 带谱（记号 ${musicMarks}），不当前言正文收`);
        continue;
      }
      const rows = spec.textLines.map((l) => ({ t: runText(l, ov).trim(), size: l.size })).filter((r) => r.t);
      if (!rows.length) continue;
      const big = [...rows].sort((a, b) => b.size - a.size)[0];
      const divider = rows.length <= 3;
      // 简谱旋律索引（p664）没有小节线、却是整页音符数字，上面那条判据够不着；
      // 前言正文里汉字总该过半。
      const all = rows.map((r) => r.t).join("");
      const cjkRatio = (all.match(/[一-鿿]/g) ?? []).length / Math.max(1, all.length);
      if (!divider && cjkRatio < 0.5) {
        meta.problems.push(`前置页 p${spec.page} 汉字只占 ${(cjkRatio * 100).toFixed(0)}%，多半是音符索引，不当前言正文收`);
        continue;
      }
      meta.front.push({
        page: spec.page,
        kind: divider ? "divider" : "prose",
        title: divider ? rows.map((r) => r.t).join("") : big.t,
        body: divider ? "" : rows.filter((r) => r !== big).map((r) => r.t).join("\n"),
        note: spec.frames.some((f) => f.type === "image") ? "整页位图" : null,
      });
    }
  }

  for (const row of meta.index)
    if (row.kind === "entry" && !row.songId) meta.problems.push(`索引 p${row.page}「${row.text}」没读出曲号`);

  return meta;
}
