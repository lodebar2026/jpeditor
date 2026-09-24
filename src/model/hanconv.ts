// 简繁转换：**以 ScoreDoc 为准**决定哪些是人读的文字、按什么上下文送词表，五种源格式通用。
//
// - 文字槽按「一起送词表的上下文」分组（`textGroups`）：头部每个字段一组；歌词同一声部、同一段号的音节
//   **整首**按元素顺序连成一组（不按系统切），词组跨音节、跨行都能按词转（`日光/之下`、行末「发」接下行「现」）。
// - MusicXML 没有代码区：改模型后整份重写（`convertScoreDoc` + `App.editScoreDoc`）。
// - 文本格式**只改原文里文字所在的位置**（`convertSourceText`）：有源区间的按区间，没有的按原字符串在原文里认领；
//   改完重新解析，逐片与期望对照，对不上的那处撤回——注释、空白、代码、中文键名（123 的 `标题：`）一字不动。
//
// 无 DOM 依赖。
import type { HanConv, HanDirection } from "../common/hanconv";
import type { Lyric, Measure, ScoreDoc, SourceSpan } from "./doc";
import { metaKeyDef } from "./metakeys";

/** 一片文字：模型里的一个字符串槽。`source` 是它在原文里的区间（区间可能比文字宽，写回时在区间内找原文字）。 */
export interface TextPiece {
  text: string;
  source?: SourceSpan;
  set(v: string): void;
}

/** 一起送词表的一组片（拼成一串转换，词组跨片也认得出）。 */
export type TextGroup = TextPiece[];

function piece(text: string | undefined, set: (v: string) => void, source?: SourceSpan): TextPiece | null {
  if (!text) return null;
  return source ? { text, source, set } : { text, set };
}

function pushGroup(out: TextGroup[], ...ps: (TextPiece | null)[]): void {
  const g = ps.filter((p): p is TextPiece => p !== null);
  if (g.length) out.push(g);
}

/** 字符串数组里每一项各成一组。 */
function arrayGroups(out: TextGroup[], arr: string[] | undefined, sources?: (SourceSpan | undefined)[]): void {
  if (!arr) return;
  arr.forEach((_, i) => pushGroup(out, piece(arr[i], (v) => (arr[i] = v), sources?.[i])));
}

/** 按元素顺序走小节（含文本谱临时伴奏/多声部层里的小节）。 */
function walkMeasures(measures: readonly Measure[], visit: (m: Measure) => void): void {
  for (const m of measures) {
    visit(m);
    const layers = (items: readonly { kind: string; measures?: Measure[] }[] | undefined): void => {
      for (const it of items ?? []) if (it.kind === "layer" && it.measures) walkMeasures(it.measures, visit);
    };
    for (const el of m.elements) {
      if (el.kind === "chord") {
        layers(el.before);
        for (const s of el.sustains ?? []) layers(s.before);
      }
    }
    layers(m.trailing);
  }
}

/** 枚举 ScoreDoc 里所有人读的文字。和弦、调号拍号、小节号、字体名、纸张等代码类字段不碰。 */
export function textGroups(doc: ScoreDoc): TextGroup[] {
  const out: TextGroup[] = [];
  for (const song of doc.songs) {
    const w = song.work;
    pushGroup(out, piece(w.title, (v) => (w.title = v)));
    pushGroup(out, piece(w.movementTitle, (v) => (w.movementTitle = v)));
    arrayGroups(out, w.subtitles);
    const id = song.identification;
    if (id) {
      for (const c of id.creators) pushGroup(out, piece(c.text, (v) => (c.text = v)));
      pushGroup(out, piece(id.rights, (v) => (id.rights = v)));
    }
    for (const c of song.credits ?? []) {
      pushGroup(out, piece(c.text, (v) => (c.text = v)));
      arrayGroups(out, c.words);
    }
    const tempos = song.tempos;
    if (tempos) tempos.forEach((t, i) => typeof t === "string" && pushGroup(out, piece(t, (v) => (tempos[i] = v))));
    pushGroup(out, piece(song.timeNote, (v) => (song.timeNote = v)));
    arrayGroups(out, song.remarks);
    const pt = song.pageText;
    if (pt) {
      pushGroup(out, piece(pt.indexLeft, (v) => (pt.indexLeft = v)));
      pushGroup(out, piece(pt.indexRight, (v) => (pt.indexRight = v)));
      for (const arr of [pt.topLeft, pt.topRight, pt.bottomLeft, pt.bottomCenter, pt.bottomRight]) arrayGroups(out, arr);
    }
    // 只转有排版角色的键（经文、标签、分类…）；字体族、纸张、开关等值是代码，转了会认不出
    for (const [key, vals] of Object.entries(song.meta ?? {})) if (metaKeyDef(key)?.role) arrayGroups(out, vals);
    for (const g of song.partGroups ?? []) {
      pushGroup(out, piece(g.name, (v) => (g.name = v)));
      pushGroup(out, piece(g.abbrev, (v) => (g.abbrev = v)));
    }

    for (const part of song.parts) {
      pushGroup(out, piece(part.name, (v) => (part.name = v)));
      pushGroup(out, piece(part.abbrev, (v) => (part.abbrev = v)));
      // 歌词：键 = 段号（+ 文本谱同段多行的行号），整首按元素顺序接成一组
      const verses = new Map<string, TextGroup>();
      const lyric = (l: Lyric): void => {
        const key = `${l.number}|${l.lineIndex ?? 0}`;
        let g = verses.get(key);
        if (!g) verses.set(key, (g = []));
        for (const p of [
          piece(l.leadingPunctuation, (v) => (l.leadingPunctuation = v)),
          piece(l.text, (v) => (l.text = v), l.source),
          piece(l.trailingPunctuation, (v) => (l.trailingPunctuation = v)),
        ]) if (p) g.push(p);
        pushGroup(out, piece(l.verseLabel, (v) => (l.verseLabel = v)));
      };
      walkMeasures(part.measures, (m) => {
        const pr = m.print;
        if (pr) {
          pushGroup(out, piece(pr.caption, (v) => (pr.caption = v)));
          arrayGroups(out, pr.texts, pr.textSources);
          for (const ll of pr.lyricLines ?? []) pushGroup(out, piece(ll.annotation, (v) => (ll.annotation = v), ll.source));
        }
        for (const d of m.directions ?? []) {
          pushGroup(out, piece(d.text, (v) => (d.text = v), d.source));
          for (const mo of d.more ?? []) pushGroup(out, piece(mo.text, (v) => (mo.text = v), d.source));
        }
        for (const el of m.elements) {
          const annot = el.attachedSources?.find((a) => a.kind === "annotation")?.source;
          if (el.kind === "chord") {
            pushGroup(out, piece(el.sectionWord, (v) => (el.sectionWord = v), annot));
            for (const l of el.lyrics ?? []) lyric(l);
            for (const s of el.sustains ?? []) {
              const sa = s.attachedSources?.find((a) => a.kind === "annotation")?.source;
              pushGroup(out, piece(s.sectionWord, (v) => (s.sectionWord = v), sa));
              for (const l of s.lyrics ?? []) lyric(l);
            }
          } else {
            for (const l of el.lyrics ?? []) lyric(l);
          }
        }
      });
      for (const g of verses.values()) out.push(g);
    }
  }
  return out;
}

/** 一组整串转换，按片切回。整串长度变了（词汇级转换偶有 1→2）就逐片转，再不行逐字；仍对不齐的片不动。 */
function convertGroup(g: TextGroup, conv: HanConv): string[] {
  const src = g.map((p) => p.text);
  const joined = src.join("");
  const all = conv(joined);
  if (all.length === joined.length) {
    const res: string[] = [];
    let at = 0;
    for (const t of src) {
      res.push(all.slice(at, at + t.length));
      at += t.length;
    }
    return res;
  }
  return src.map((t) => {
    const o = conv(t);
    if (o.length === t.length) return o;
    const c = Array.from(t, (ch) => conv(ch)).join("");
    return c.length === t.length ? c : t;
  });
}

/** 按组转换，返回与 `groups.flat()` 平行的新文字。 */
function convertAll(groups: readonly TextGroup[], conv: HanConv): string[] {
  return groups.flatMap((g) => convertGroup(g, conv));
}

/** 所有文字拼起来过一遍繁→简词表：被改动说明含繁体字形 → 转简；否则（纯简体或无中文）→ 转繁。 */
export function detectHanDirection(doc: ScoreDoc, t2s: HanConv): HanDirection {
  const text = textGroups(doc).flat().map((p) => p.text).join("\n");
  return t2s(text) === text ? "s2t" : "t2s";
}

/** 就地转换模型里的文字（没有代码区的 MusicXML 用，转完整份重写）。返回改动的片数。 */
export function convertScoreDoc(doc: ScoreDoc, conv: HanConv): number {
  const pieces = textGroups(doc);
  const outs = convertAll(pieces, conv);
  let n = 0;
  pieces.flat().forEach((p, i) => {
    if (outs[i] !== p.text) {
      p.set(outs[i]!);
      n++;
    }
  });
  return n;
}

interface Edit {
  from: number;
  to: number;
  text: string;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}

export interface SourceConvResult {
  text: string;
  /** 改动了的片数 */
  changed: number;
  /** 该转却没能写回原文的片数（找不到位置、或写回后重解析对不上而撤回） */
  missed: number;
}

/**
 * 文本格式的整篇转换：只改原文里文字所在的位置。
 *
 * 1. 解析 → 按组转换，得到每片的期望文字。
 * 2. 有源区间的片：在区间里找原文字替换（可信）。所有带区间的片（改不改都算）先把位置占住，
 *    免得下一步搜到歌词里去。
 * 3. 没有源区间的片（头部多数字段）：在原文里找第一处没被占的原字符串替换。
 * 4. 重新解析，逐片与期望对照。全对就完事；否则只留可信的编辑，再把搜来的编辑逐个试加，
 *    结构不变且对上的片变多才留（误改了中文键名之类会被撤回）。
 */
export function convertSourceText(text: string, parse: (text: string) => ScoreDoc, conv: HanConv): SourceConvResult {
  const pieces = textGroups(parse(text));
  const flat = pieces.flat();
  const expected = convertAll(pieces, conv);

  const claimed: [number, number][] = [];
  const free = (a: number, b: number): boolean => claimed.every(([x, y]) => b <= x || a >= y);
  // 同一处原文可以对应几片（`.jpwabc` 的 `W1-6:` 按段复制成几份歌词，源区间相同）：认作同一处，只改一次
  const spanAt = new Map<string, number>();
  const at: (number | null)[] = flat.map((p) => {
    const s = p.source;
    if (!s) return null;
    const k = text.slice(s.offset, s.offset + s.length).indexOf(p.text);
    if (k < 0) return null;
    const from = s.offset + k;
    const key = `${from}:${p.text}`;
    if (spanAt.has(key)) return from;
    if (!free(from, from + p.text.length)) return null;
    claimed.push([from, from + p.text.length]);
    spanAt.set(key, from);
    return from;
  });

  const trusted: Edit[] = [];
  /** 搜来的编辑，一片一批（逐段搜的几段要一起留或一起撤） */
  const searched: Edit[][] = [];
  let batch: Edit[] = [];
  /** 在 `start` 之后找第一处没被占的 `orig` 记一条编辑，返回其终点。都被占了时，已有一条同文同改的编辑
   *  （同一处原文在模型里出现两次：`.jpwabc` 的署名既是 credit 又是 creator）就算它，否则 null */
  const search = (orig: string, want: string, start: number): number | null => {
    for (let k = text.indexOf(orig, start); k >= 0; k = text.indexOf(orig, k + 1)) {
      if (!free(k, k + orig.length)) continue;
      claimed.push([k, k + orig.length]);
      batch.push({ from: k, to: k + orig.length, text: want });
      return k + orig.length;
    }
    const same = [...searched.flat(), ...batch].find((e) => e.from >= start && e.text === want && text.slice(e.from, e.to) === orig);
    return same ? same.to : null;
  };
  let changed = 0;
  flat.forEach((p, i) => {
    const want = expected[i]!;
    if (want === p.text) return;
    changed++;
    const from = at[i];
    if (from != null) {
      if (!trusted.some((e) => e.from === from)) trusted.push({ from, to: from + p.text.length, text: want });
      return;
    }
    // 整串搜不到（原文有转义：`.jpwabc` 署名的 `\n` 在模型里是换行或空格）就按非 ASCII 连续段依次搜。
    // 转换逐字等长（`convertGroup`），段在新文字里的位置不变
    if (search(p.text, want, 0) === null) {
      let pos = 0;
      for (const m of p.text.matchAll(/[^\x00-\x7f]+/g)) {
        const a = m.index, b = a + m[0].length;
        if (want.slice(a, b) === m[0]) continue;
        const end = search(m[0], want.slice(a, b), pos);
        if (end !== null) pos = end;
      }
    }
    if (batch.length) searched.push(batch);
    batch = [];
  });
  if (changed === 0) return { text, changed: 0, missed: 0 };

  /** 对不上的片数；结构变了（片数不同或解析失败）为 -1 */
  const mismatches = (cand: string): number => {
    let got: string[];
    try {
      got = textGroups(parse(cand)).flat().map((p) => p.text);
    } catch {
      return -1;
    }
    if (got.length !== expected.length) return -1;
    let n = 0;
    for (let i = 0; i < got.length; i++) if (got[i] !== expected[i]) n++;
    return n;
  };

  const full = applyEdits(text, [...trusted, ...searched.flat()]);
  const m = mismatches(full);
  if (m === 0) return { text: full, changed, missed: 0 };

  let keep = [...trusted];
  let best = mismatches(applyEdits(text, keep));
  if (best < 0) {
    keep = [];
    best = changed;
  }
  for (const b of searched) {
    const n = mismatches(applyEdits(text, [...keep, ...b]));
    if (n >= 0 && n < best) {
      keep.push(...b);
      best = n;
    }
  }
  return { text: applyEdits(text, keep), changed, missed: best };
}
