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
export function runText(run: TextRun | null | undefined, ov?: CharOverride): string {
  if (!run) return "";
  return run.chars
    .map((c) => {
      const fixed = ov?.(c.key, c.ch) ?? null;
      if (fixed) return fixed;
      return c.ch === UNREAD ? "" : c.ch;
    })
    .join("");
}

/** 逐字展开（覆盖后一个元素可能是多字：花边框正文常把一段字合成一个 path 对象）。 */
export function runChars(run: TextRun, ov?: CharOverride): { ch: string; x: number; y: number; w: number; h: number }[] {
  return run.chars.map((c) => ({ ...c, ch: ov?.(c.key, c.ch) ?? (c.ch === UNREAD ? "" : c.ch) }));
}

const median = (v: number[]): number => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : 0);
const bottom = (r: { y: number; h: number }) => r.y + r.h;

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
  /** 有没有花边框。经文有时不装框，直接印在谱行下方（p36 / p39）。 */
  framed: boolean;
  text: string;
  box: Rect;
  page: number;
}

/**
 * 框内文字重新聚行。
 *
 * `spec.ts::groupLines` 的容差是固定 4pt，对花边框正文偏紧：p46 那一框里
 * 同一条视觉行被拆成两组（框内混着 8.2 与 10.5 两档字），拼出来是
 * 「1这一信胜的凯他心 / 《有活的确据》(3首)是首徒得歌」这种乱序。
 * 改成按**框内行距中位数的 0.45 倍**聚行，两档字号也能并回同一行。
 */
export function regroupBoxLines(lines: TextRun[], ov?: CharOverride): string[] {
  const chars = lines.flatMap((l) => runChars(l, ov));
  if (!chars.length) return [];
  const baselines = [...new Set(lines.map((l) => l.baselineY))].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < baselines.length; i++) gaps.push(baselines[i] - baselines[i - 1]);
  const pitch = median(gaps.filter((g) => g > 2)) || 12;
  const tol = Math.max(3, pitch * 0.45);
  const sorted = [...chars].sort((a, b) => bottom(a) - bottom(b));
  const rows: { y: number; items: typeof sorted }[] = [];
  for (const c of sorted) {
    const last = rows[rows.length - 1];
    if (last && bottom(c) - last.y <= tol) last.items.push(c);
    else rows.push({ y: bottom(c), items: [c] });
  }
  return rows
    .map((r) =>
      r.items
        .sort((a, b) => a.x - b.x)
        .map((c) => c.ch)
        .join(""),
    )
    // 花边框四角的纹样偶尔被当成字（读作 X / XX），一两个拉丁字母独占一行
    // 在这本书的注解正文里不可能出现，丢掉。
    .filter((t) => t.trim().length >= 2 && !/^[A-Za-z]{1,2}$/.test(t.trim()));
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

export interface OrnamentTile {
  orient: "h" | "v";
  w: number;
  h: number;
  /** 相邻两片的步距。 */
  pitch: number;
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

/** 从一页的记号里取出花边纹样母题：横向一片、纵向一片，外加铺排步距。
 *  全书 110 个框同一母题，取实例最多的那一页就够。 */
export function extractOrnamentTiles(spec: PageSpec): OrnamentTile[] {
  const orn = spec.marks.filter((m) => m.cls === "ornament" && m.d);
  if (!orn.length) return [];
  const out: OrnamentTile[] = [];
  for (const orient of ["h", "v"] as const) {
    const set = orn.filter((m) => (orient === "h" ? m.box.w > m.box.h : m.box.h > m.box.w));
    if (!set.length) continue;
    // 步距：同一条边上相邻两片的间距（横边按 x、纵边按 y）
    const edge = set.filter((m) => (orient === "h" ? m.box.y : m.box.x) === (orient === "h" ? set[0].box.y : set[0].box.x));
    const pos = (orient === "h" ? edge.map((m) => m.box.x) : edge.map((m) => m.box.y)).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < pos.length; i++) gaps.push(pos[i] - pos[i - 1]);
    const t = set[0];
    out.push({
      orient,
      w: Number(t.box.w.toFixed(3)),
      h: Number(t.box.h.toFixed(3)),
      pitch: Number((median(gaps) || (orient === "h" ? t.box.w : t.box.h)).toFixed(3)),
      path: translatePath(t.d!, -t.box.x, -t.box.y),
    });
  }
  return out;
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
}

export function buildBookMeta(specs: PageSpec[], opt: BookMetaOptions = {}): BookMeta {
  const ov = opt.override;
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

    // 花边框：归给 y 区间包住它的那首（一页两首时靠这个分开）
    for (const box of spec.storyBoxes) {
      const owner =
        spec.songs.find((s) => box.box.y >= s.yFrom && box.box.y < s.yTo)?.id ??
        spec.songs[spec.songs.length - 1]?.id ??
        null;
      const text = regroupBoxLines(box.lines, ov).join("\n");
      if (text.replace(/\s/g, "").length < 4) continue;
      const hs = box.lines.flatMap((l) => l.chars.map((c) => c.h)).filter((h) => h > 2);
      meta.annotations.push({ songId: owner, framed: true, size: Number(median(hs).toFixed(2)), text, box: box.box, page: spec.page });
    }
    // 未装框的经文（p36 / p39 那种，印在谱行下方、没有花边）。
    // 门槛 4 个字：乐谱页的 textLines 里绝大多数是掉出谱行的「一」，那些不能算。
    if (spec.kind === "score" && spec.textLines.length) {
      // 未装框的经文得跟「掉出谱行的一」分开：乐谱页 textLines 里 467 行是纯粹的「一」
      // （歌词里的一因为悬在字格中部，聚行时会掉出来），所以要求 8 个以上汉字、
      // 且不同的字有 4 个以上。
      const realText = (t: string) => {
        const cjk = t.match(/[一-鿿]/g) ?? [];
        return cjk.length >= 8 && new Set(cjk).size >= 4;
      };
      const rows = spec.textLines.map((l) => ({ t: runText(l, ov), l })).filter((r) => realText(r.t));
      if (rows.length) {
        const owner = spec.songs[spec.songs.length - 1]?.id ?? null;
        const x = Math.min(...rows.map((r) => r.l.box.x));
        const y = Math.min(...rows.map((r) => r.l.box.y));
        meta.annotations.push({
          songId: owner,
          framed: false,
          size: Number(median(rows.flatMap((r) => r.l.chars.map((c) => c.h)).filter((h) => h > 2)).toFixed(2)),
          text: rows.map((r) => r.t).join("\n"),
          box: {
            x,
            y,
            w: Math.max(...rows.map((r) => r.l.box.x + r.l.box.w)) - x,
            h: Math.max(...rows.map((r) => r.l.box.y + r.l.box.h)) - y,
          },
          page: spec.page,
        });
      }
    }

    if (!meta.ornaments.length && spec.storyBoxes.length) meta.ornaments = extractOrnamentTiles(spec);
  }

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
