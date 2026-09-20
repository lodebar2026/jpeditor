// 「按乐句重排」写回原文——**文本谱以外的那几种格式**（123 / ABC / `.jpwabc`）。
//
// 断句本身与格式无关（`score/phrase.ts`），落点也已经由 `pu/phrase.ts::phraseCuts` 换算成
// 「新行从哪个元素起」。这里只管最后一步：把那些落点写回各自的原文。两种写法：
//
// - **123 / ABC**：断点写进 `ScoreDoc` 的换行位（`Print.newSystem` / `newPage`），整份按
//   `emit123` / `emitAbc` 重出。写出端本来就按 `$` 切系统、把各段 `w:` 行跟着重新归行
//   （`abcfamily/emit.ts::partSystems`），歌词对位因此自动跟着走——这是不自己切原文的理由。
//   代价是注释与用户手写的排布被规范化，换回「原样」是把重排前那份原文整份放回去（App 存着）。
// - **`.jpwabc`**：**只挪 `$` 标记**，别的字符一个不动。`.jpwabc` 是分节文件，`.Voice` 之外
//   还有 `.Words`/`.Layout`/`.Fonts` 等节，整份重出会把写出端装不下的东西（样式、分页描述）
//   一并抹掉；而歌词在 `.Words` 里按小节/音符号锚定、与行结构无关，所以只重切 `.Voice` 的行
//   就够。`.Layout` 里按行号记的 `BreakPoints` 跟着行结构作废，重排时去掉（换页改由
//   `$(true,0,0,true)` 原位表达）。
//
// **小节中间的断点**（弱起谱的乐句尾常落在这儿）两条路不一样：`.jpwabc` 的 `$` 写得进小节中间，
// 原位保留；123 的 `$` 只落在小节之后（规范 §9，代码行中间的 `$` 读回时歌词块会跟着断，对位错位），
// 所以挪到**下一根小节线**——那半个小节留在上一行行尾，下一句从小节线起头。

import type { Chord, ElementId, Measure, ScoreDoc, Song, Sustain } from "./doc";
import { phraseCuts, type FitMeasure, type PhraseCut } from "../pu/phrase";
import { readJpwSource } from "./fromjpw";
import { JpwFile, LayoutSection, VoiceSection, WordsSection } from "../jpword/jpwfile";

/** 模型里一个元素的位置。`sustain` 是它在宿主和弦 `sustains` 里的下标（元素自己时为 null）。 */
interface Spot {
  part: number;
  measure: number;
  index: number;
  sustain: number | null;
}

/** 整首的「元素 id → 位置」。倚音也在里面（落点算小节起头时要把它们跳过）。 */
function spotsOf(song: Song): Map<ElementId, Spot> {
  const out = new Map<ElementId, Spot>();
  song.parts.forEach((part, pi) => {
    part.measures.forEach((mea, mi) => {
      mea.elements.forEach((el, ei) => {
        out.set(el.id, { part: pi, measure: mi, index: ei, sustain: null });
        if (el.kind !== "chord") return;
        (el.sustains ?? []).forEach((su, si) => {
          out.set(su.id, { part: pi, measure: mi, index: ei, sustain: si });
        });
      });
    });
  });
  return out;
}

/** 第 `ei` 个元素之前只剩倚音（或什么都没有）= 这个落点就是小节起头。 */
function atMeasureStart(mea: Measure, ei: number): boolean {
  for (let i = 0; i < ei; i++) {
    const el = mea.elements[i]!;
    if (!(el.kind === "chord" && el.grace)) return false;
  }
  return true;
}

/** 清掉整首现有的换行（重排是重新断，不是在原有行结构上加断点）。 */
function clearBreaks(song: Song): void {
  for (const part of song.parts) {
    for (const mea of part.measures) {
      if (mea.print) {
        delete mea.print.newSystem;
        delete mea.print.newPage;
      }
      for (const el of mea.elements) {
        if (el.kind !== "chord") continue; // `Space`（`y`/`x`）没有换行位
        delete el.lineBreakAfter;
        for (const su of el.sustains ?? []) delete su.lineBreakAfter;
      }
      for (const b of mea.barlines ?? []) delete b.lineBreakAfter;
    }
  }
}

/** 落点**之前**那一个挂得住换行的东西：上一个和弦的最后一根增时线，没有增时线就是和弦自己。 */
function beforeSpot(mea: Measure, spot: Spot): Chord | Sustain | null {
  // 落点在某根增时线上：换行落在它前一根上（第一根则落在宿主音符之后）
  if (spot.sustain !== null) {
    const host = mea.elements[spot.index];
    if (host?.kind !== "chord") return null;
    return spot.sustain > 0 ? (host.sustains?.[spot.sustain - 1] ?? host) : host;
  }
  const prev = mea.elements[spot.index - 1];
  if (prev?.kind !== "chord") return null; // `y`/`x` 上挂换行没有意义（`Space` 也没有这一位）
  const sustains = prev.sustains ?? [];
  return sustains[sustains.length - 1] ?? prev;
}

export interface DocRelayoutOptions {
  /** 行长尺子（见 `pu/phrase.ts::FitMeasure`）；不给就按出厂的小节数目标断。 */
  measure?: FitMeasure | null;
  /** 小节中间的断点怎么落：`inline` 原位记在和弦上；`snap` 挪到下一根小节线。 */
  midBreaks: "inline" | "snap";
}

/**
 * 把按乐句重排的断点写进 `ScoreDoc` 的换行位。逐首处理，**改的是传进来的这份文档**。
 *
 * @returns 有没有排出新的行结构（没有可排的曲行时 false）
 */
export function relayoutDocBreaks(sdoc: ScoreDoc, opt: DocRelayoutOptions): boolean {
  let changed = false;
  sdoc.songs.forEach((song, si) => {
    const cuts = phraseCuts(sdoc, si, { measure: opt.measure ?? null });
    if (!cuts || cuts.length === 0) return;
    const where = spotsOf(song);
    clearBreaks(song);
    for (const cut of cuts) {
      if (cut.id === null) continue;
      const spot = where.get(cut.id);
      if (!spot) continue;
      const mea = song.parts[spot.part]?.measures[spot.measure];
      if (!mea) continue;
      const start = spot.sustain === null && atMeasureStart(mea, spot.index);
      if (!start && opt.midBreaks === "inline") {
        const host = beforeSpot(mea, spot);
        if (host) {
          host.lineBreakAfter = cut.page ? "page" : "system";
          changed = true;
        }
        continue;
      }
      // 小节级换行：口径是「本小节起新系统」，多声部各行要在同一小节上断
      const mi = start ? spot.measure : spot.measure + 1;
      if (mi <= 0) continue;
      for (const part of song.parts) {
        const target = part.measures[mi];
        if (!target) continue;
        target.print = { ...target.print, newSystem: true };
        if (cut.page) target.print.newPage = true;
      }
      changed = true;
    }
  });
  return changed;
}

// ───────────────────────── .jpwabc ─────────────────────────

/** `.Voice` 里的换行标记（`Return: '$' ParamList?`，见 `jpword/Jpwabc.g4`）。 */
const BREAK_RE = /\$(\([^)]*\))?/g;
const BREAK_LINE = "$(true)";
const BREAK_PAGE = "$(true,0,0,true)";

/** 去掉一段 `.Voice` 原文里的换行标记，并把首尾空白收干净。 */
function stripBreaks(text: string): string {
  return text.replace(BREAK_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * 每个音符在 `.Words` 锚点坐标系里的 `(小节, 音符)`——**连小节中间的换行一起数**
 * （`fromjpw.ts::assignLyrics` 的口径：一个 `$` 写在小节中间就开出一个新的「小节」，
 * 音符序号跟着归零）。下标是这个声部的第几个音符。
 */
function anchorTable(f: JpwFile): Array<{ mid: number; nid: number }> {
  const out: Array<{ mid: number; nid: number }> = [];
  let mid = 0;
  for (const m of readJpwSource(f).measures) {
    mid++;
    let nid = 0;
    for (const ent of m.entries) {
      if (ent.kind === "break") {
        if (ent !== m.entries[m.entries.length - 1]) {
          mid++;
          nid = 0;
        }
        continue;
      }
      if (ent.kind !== "note") continue;
      nid++;
      out.push({ mid, nid });
    }
  }
  return out;
}

/** `.Words` 段头：`W1:` / `W1-2(ctrl)@5,1:`（同 `jpwfile.ts::WordsSection.regLrcSpec`，这里不带粘着标志）。 */
const WORDS_SPEC_RE = /^W(\d+)(-\d+)?(\([0-9a-zA-Z.,]+\))?@(\d+),(\d+)/;

/**
 * 重排挪了 `$`，`.Words` 的锚点跟着**换了坐标系**——不改的话第二段歌词整体错位
 * （沧海一声笑、基督更美实测错开一整句）。按「锚到第几个音符」重算：
 * 老坐标 → 音符序号（`assignLyrics` 怎么找就怎么找）→ 新坐标。
 */
function retargetWords(oldFile: JpwFile, newText: string): string {
  const newFile = JpwFile.fromString(newText);
  const words = newFile?.getSection(WordsSection);
  if (!newFile || !words) return newText;
  let before: Array<{ mid: number; nid: number }>;
  let after: Array<{ mid: number; nid: number }>;
  try {
    before = anchorTable(oldFile);
    after = anchorTable(newFile);
  } catch {
    return newText;
  }
  if (before.length === 0 || before.length !== after.length) return newText; // 音符数都对不上就别动它
  const raws = newText.split("\n");
  for (const no of words.lineNos) {
    const raw = raws[no];
    if (raw === undefined) continue;
    const m = WORDS_SPEC_RE.exec(raw);
    if (!m) continue;
    const mid = parseInt(m[4]!, 10);
    const nid = parseInt(m[5]!, 10);
    // `assignLyrics` 取的是第一个「不早于锚点」的音符
    const at = before.findIndex((p) => p.mid > mid || (p.mid === mid && p.nid >= nid));
    const to = at < 0 ? null : after[at];
    if (!to) continue;
    const head = m[0].slice(0, m[0].length - `@${m[4]},${m[5]}`.length);
    raws[no] = `${head}@${to.mid},${to.nid}${raw.slice(m[0].length)}`;
  }
  return raws.join("\n");
}

/**
 * 按乐句重排一份 `.jpwabc` 原文：**只重切 `.Voice` 的行**（挪 `$`），别的节原样。
 *
 * @param text 编辑器里的原文
 * @param sdoc 它解析出来的那一份（`jpwToScoreDoc`）
 * @returns 新原文；没有可重排的曲行时原样返回
 */
export function relayoutJpwabcText(text: string, sdoc: ScoreDoc, opt: { measure?: FitMeasure | null } = {}): string {
  const cuts = phraseCuts(sdoc, 0, { measure: opt.measure ?? null });
  if (!cuts || cuts.length === 0) return text;
  const file = JpwFile.fromString(text);
  const voice = file?.getSection(VoiceSection) ?? null;
  if (!file || !voice || voice.lines.length === 0) return text;

  // 落点按原文位置排好：`.Voice` 里一个位置只会断一次
  const at = new Map<number, PhraseCut[]>(); // 行号 → 该行上的落点
  for (const cut of cuts) {
    if (!cut.source) continue;
    const list = at.get(cut.source.line) ?? [];
    list.push(cut);
    at.set(cut.source.line, list);
  }
  if (at.size === 0) return text;

  // 末行原来那个标记照旧（JP-Word 写的是 `$(true,0,0,true)`，别的来源可能只有 `$(true)`）
  const lastRaw = voice.lines[voice.lines.length - 1]!;
  const lastMark = [...lastRaw.matchAll(BREAK_RE)].pop()?.[0] ?? BREAK_PAGE;

  const out: string[] = [];
  let buf = "";
  const push = (piece: string): void => {
    const s = stripBreaks(piece);
    if (s.length === 0) return;
    buf = buf.length === 0 ? s : `${buf} ${s}`;
  };
  const flush = (mark: string): void => {
    if (buf.length === 0) return;
    out.push(buf + mark);
    buf = "";
  };
  voice.lines.forEach((raw, i) => {
    const here = (at.get(voice.lineNos[i]!) ?? []).slice().sort((a, b) => a.source!.column - b.source!.column);
    let from = 0;
    for (const cut of here) {
      const col = cut.source!.column;
      // 落点在行首（断点与原来的行结构重合）：此前攒下的就是上一行，直接收
      if (col < from) continue;
      push(raw.slice(from, col));
      flush(cut.page ? BREAK_PAGE : BREAK_LINE);
      from = col;
    }
    push(raw.slice(from));
  });
  flush(lastMark);
  if (out.length === 0) return text;

  // 写回原文：`.Voice` 那几行换成新的，其余行原样；按行号记的分页描述跟着作废
  const raws = text.split("\n");
  const crlf = text.includes("\r\n");
  const first = voice.lineNos[0]!;
  const drop = new Set(voice.lineNos);
  const layout = file.getSection(LayoutSection);
  if (layout && layout.breakPoints !== null) {
    layout.lineNos.forEach((no, i) => {
      if (/^\s*breakpoints\s*=/i.test(layout.lines[i]!)) drop.add(no);
    });
  }
  const merged: string[] = [];
  raws.forEach((raw, no) => {
    if (no === first) merged.push(...out.map((l) => (crlf ? `${l}\r` : l)));
    if (!drop.has(no)) merged.push(raw);
  });
  // 行结构换了，`.Words` 的锚点坐标系跟着换（见 retargetWords）
  return retargetWords(file, merged.join("\n"));
}
