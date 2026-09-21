// 谱后单独排版的附段歌词：谱行下只配第 1 段，第 2…N 段按诗行印在谱子后面，不跟音符对齐
// （圣徒诗歌 11《仰看穹苍浩大无穷》：「二」「三」各领一段四行诗）。
//
// 这块字进不了歌词通道——lyrics.ts S1 给末谱行的下方带按行距封了底（防谱后正文），本来也不该进：
// 它没有 x 可对。这里另走一路：DBNet 检测整块、逐行识别，按段号/空行切段，再照**第 1 段的音位骨架**
// 逐字填进去——第 1 段有字的音依次是各段的起字音位，melisma 的分布跟第 1 段一样。
//
// 判据只有一条：**这一段的音节数等于第 1 段的起字音位数**（容 OCR 多读漏读两个字）。
// 谱后的背景介绍/版权说明是散文，字数碰不上，整块照旧丢掉（1600《南非之行》那九段正文）。
import type { Binary, StaffRow, TextRegion } from "./types";
import { rbottom } from "./types";
import type { OcrBackend } from "./ocr";
import { CN_NUM, LYRIC_PUNCT, LYRIC_QUOTE_CLOSE, LYRIC_QUOTE_OPEN, normPunct } from "./lyrics";
import { median } from "./geom";
import { probe } from "./probe";

const isHanzi = (c: string) => /[一-鿿]/.test(c);
const isLatin = (c: string) => /[A-Za-z']/.test(c);

// 整行只有段号：「二」「2」「2.」「（二）」
const LABEL_ONLY_RE = new RegExp(`^[(（]?([${CN_NUM}]|\\d{1,2})[)）]?[.、．。:：]?$`);
// 段号领着正文：「2.夕阳…」「二、夕阳…」——必须带分隔符，裸「一面运行」的「一」是正文
const LABEL_PREFIX_RE = new RegExp(`^[(（]?([${CN_NUM}]|\\d{1,2})[)）]?[.、．](?=.)`);
/** 音节数与第 1 段音位数至多差几个还照填（OCR 多读/漏读一两个字） */
const COUNT_TOL = 2;

/** 一段诗文拆成音节：汉字一字一个，拉丁词按空白/连字符断；收尾标点、闭引号贴前字，开引号领起后字。
 *  规则与 lyrics.ts 装配谱下歌词那一路一致，两边拆出来的数才可比。 */
export function toSyllables(text: string): string[] {
  const out: string[] = [];
  let lead = "", pend = "";
  const flush = () => { if (pend) { out.push(lead + pend); lead = ""; pend = ""; } };
  for (const ch of text) {
    if (isHanzi(ch)) { flush(); out.push(lead + ch); lead = ""; }
    else if (isLatin(ch)) pend += ch;
    else if (ch === "-") { if (pend) { pend += "-"; flush(); } }
    else if (/\s/.test(ch)) flush();
    else if (LYRIC_QUOTE_OPEN.test(ch) && !pend) lead += ch;
    else if (LYRIC_PUNCT.test(ch) || LYRIC_QUOTE_CLOSE.test(ch)) {
      if (pend) pend += normPunct(ch);
      else if (out.length) out[out.length - 1] += normPunct(ch);
    }
  }
  flush();
  return out;
}

interface Stanza { label?: string; lines: { text: string; bbox: TextRegion["bbox"] }[] }

/** 识别谱后附段并按第 1 段的音位骨架写进各音符的 `lyrics[v]`。返回收下的诗文行（识别模式叠加用）。 */
export async function recognizeTrailingStanzas(
  bin: Binary, staff: StaffRow[], numH: number, ocr: OcrBackend, lyricRegions: TextRegion[] | undefined,
): Promise<TextRegion[]> {
  if (!ocr.recognizeRegion) return [];
  const rows = staff.filter((r) => r.nums.length);
  const last = rows[rows.length - 1];
  if (!last) return [];

  // 第 1 段的起字音位：谱下有字的音，按谱面顺序。
  const slots = rows.flatMap((r) => r.nums.filter((n) => n.lyrics?.[0]));
  if (slots.length < 8) return [];

  // 区域：末谱行歌词下缘 → 图底。末行下没配词（器乐尾奏）就从谱行底下一个字高起。
  const below = (lyricRegions ?? []).filter((r) => r.bbox.y >= last.bottomY - numH * 0.2);
  const y0 = Math.round((below.length ? Math.max(...below.map((r) => rbottom(r.bbox))) : last.bottomY + numH) + numH * 0.3);
  if (bin.h - y0 < numH * 2) return [];
  const dets = (await ocr.recognizeRegion(bin, { x: 0, y: y0, w: bin.w, h: bin.h - y0 }))
    .map((d) => ({ text: d.text.trim(), bbox: d.bbox }))
    .filter((d) => d.text);
  if ((globalThis as { __omrDebug?: boolean }).__omrDebug) {
    console.log("[stanzas/det]", dets.map((d) => `${Math.round(d.bbox.h)}px@${Math.round(d.bbox.y)}=${JSON.stringify(d.text)}`).join("  "));
  }
  if (!dets.length) return [];
  dets.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);

  // 切段：段号开新段；没段号时按空行（行距明显大于常规行距）断开。
  const lineH = median(dets.map((d) => d.bbox.h)) || numH;
  const stanzas: Stanza[] = [];
  let cur: Stanza | null = null;
  let prevBottom = -Infinity;
  for (const d of dets) {
    const only = LABEL_ONLY_RE.exec(d.text);
    const pre = only ? null : LABEL_PREFIX_RE.exec(d.text);
    const gapBreak = d.bbox.y - prevBottom > lineH * 1.2;
    prevBottom = rbottom(d.bbox);
    if (only) { stanzas.push(cur = { label: only[1], lines: [] }); continue; }
    if (pre) {
      stanzas.push(cur = { label: pre[1], lines: [{ text: d.text.slice(pre[0].length), bbox: d.bbox }] });
      continue;
    }
    // 段号行后面紧跟的第一行不算空行断开（段号与正文之间本来就隔着点距离）
    if (!cur || (gapBreak && cur.lines.length)) stanzas.push(cur = { lines: [] });
    cur.lines.push(d);
  }

  // 逐段对音位数；一段对不上，整块当正文丢掉（散文碰巧有一段字数对上的概率不值得冒险）。
  const S = slots.length;
  const sylls = stanzas.filter((s) => s.lines.length).map((s) => toSyllables(s.lines.map((l) => l.text).join("")));
  if (!sylls.length || sylls.some((sy) => Math.abs(sy.length - S) > COUNT_TOL)) {
    if (sylls.length) probe("stanza.rejected");
    return [];
  }

  const base = Math.max(1, ...rows.flatMap((r) => r.nums.map((n) => n.lyrics?.length ?? 0)));
  sylls.forEach((sy, k) => {
    const v = base + k;
    if (sy.length !== S) probe("stanza.countMismatch");
    slots.forEach((n, i) => { (n.lyrics ??= [])[v] = sy[i] ?? ""; });
  });
  probe("stanza");
  return stanzas.flatMap((s) => s.lines.map((l) => ({ text: l.text, bbox: l.bbox })));
}
