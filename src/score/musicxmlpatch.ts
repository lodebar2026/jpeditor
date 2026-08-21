// 在 MusicXML 底本上做**增量修改**：把用户在 .jpwabc 里改动的部分写回底本 DOM，其余节点原样保留。
//
// 为什么不整体重生成：.jpwabc 承载的信息比 MusicXML 少（丢掉 <print> 的原图行结构、<credit>
// 版式与页码、非跳转的 <direction>、divisions 精度、<time-modification>、非白名单 <words>…）。
// 识别/ABC 得来的底本是最精确的一份，整体重生成等于把它降采样一遍。所以：**只改真的变了的地方**。
//
// **不碰什么**（这些在 .jpwabc 里根本没有对应表达，按 Score 来只会把底本的信息删掉）：
//   <barline> / <ending> / <repeat>  —— jpwabc 的反复走 `.Repeat` 段的演唱顺序，不是小节线结构；
//   <direction>（段落标记 sectionMark、跳转、速度）、<print>、<credit> 的版式与页码、
//   <time-modification>、<fermata>、以及任何本模块不认识的元素。
//   代价：用户在 jpwabc 里改小节线/反复不会反映到导出的 MusicXML；相比之下把底本已有的房号
//   反复删掉是更坏的结果（沧海一声笑的一/二房就是这么丢的）。
//
// 比对基准是**简谱表述**（number/jpOctave/jpAlter），不是 Note.pitch —— jpwimport 的 basePitch
// 走 getBasePitch（A/B 用 48、其余 60），Note.init 又对 fifths 3/5/−2 做 jpOctave+1 修正，
// 直接比 MIDI pitch 会有系统性 ±12 偏差，把没改过的音判成改过。

import { Fraction } from "../common/fraction";
import { loadMusicXml } from "./musicxml";
import {
  jpSpelling, makeNoteXml, noteTypeOf, pairSlurTies, type SlurTieMap,
} from "./musicxmlout";
import { Chord, Measure, Note, Score } from "./score";
import { child, children, fragment as xmlFragment, insertOrdered, setText } from "./xmldom";
import { durationTicks, lyricElementXml } from "./xmlutil";

const fragment = (doc: Document, xml: string): Element => xmlFragment(doc, xml, "patch 片段");

export interface PatchResult {
  xml: string;
  /** 实际修改/增删的节点数，0 = 底本一字未动。 */
  changed: number;
  /** true = 改动过大无法可靠对齐，调用方应改走全量序列化。 */
  fallback: boolean;
}

// ---------------- 签名（对齐与比对的基准） ----------------
// 拼签名的分隔符：防止 ["ab"] 与 ["a","b"] 撞成同一个签名。
const SEP = "\u0001";
function noteSig(nt: Note): string {
  return `${nt.number}${nt.jpOctave}${nt.jpAlter}`;
}
function chordSig(ch: Chord): string {
  return `${ch.notes.map(noteSig).join("+")}|${ch.duration?.toString() ?? "?"}`;
}
/** 歌词比对只看**文本序列**，不看 verse 编号：底本可能把某段标成 number="chorus"（导入端
 *  findRefrain 推断出的共用副歌），而从 .jpwabc 重建的 Score 按 W 段标成 number="1"。两种写法
 *  唱出来是同一行字，判成「改动」只会白白覆盖底本更精确的表达。 */
function lyricSig(nt: Note): string {
  return [...nt.lyrics]
    .sort((a, b) => a.number - b.number)
    .filter((l) => l.text.length)
    .map((l) => l.text)
    .join(SEP);
}
function measureSig(m: Measure): string {
  return chordsOf(m).map(chordSig).join(" ");
}
function chordsOf(m: Measure): Chord[] {
  return m.entries.filter((e): e is Chord => e instanceof Chord);
}

// ---------------- LCS 对齐 ----------------
/** 返回 [aIdx, bIdx] 配对表（升序、互不交叉）；未出现的下标即为删除/新增。 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** 先按签名 LCS 对齐，再把落在两个锚点之间、数量相同的段按位置一一配对（= 内容被改过的项）。 */
function alignWithEdits(a: string[], b: string[]): Array<[number, number]> {
  const anchors = lcsPairs(a, b);
  const out: Array<[number, number]> = [];
  let pi = 0, pj = 0;
  const fillGap = (ei: number, ej: number) => {
    const ni = ei - pi, nj = ej - pj;
    const n = Math.min(ni, nj);
    for (let k = 0; k < n; k++) out.push([pi + k, pj + k]);
  };
  for (const [ai, bj] of anchors) {
    fillGap(ai, bj);
    out.push([ai, bj]);
    pi = ai + 1; pj = bj + 1;
  }
  fillGap(a.length, b.length);
  return out.sort((x, y) => x[0] - y[0]);
}


/** 底本每个 <measure> 里的 <note> 按和弦分组（<chord/> 从属音归前一组，grace 跳过，与
 *  musicxml.ts::onNote 的取舍一致），得到与 Score 的 Chord 序严格对应的结构。 */
function collectChordEls(measureEl: Element): Element[][] {
  const out: Element[][] = [];
  for (const n of children(measureEl, "note")) {
    if (child(n, "grace")) continue;
    if (child(n, "chord") && out.length) out[out.length - 1].push(n);
    else out.push([n]);
  }
  return out;
}

/** 按类别记录本次改了什么（回归脚本诊断用，正常路径不读）。 */
const detail: Record<string, number> = {};
const bump = (k: string, n: number) => { if (n) detail[k] = (detail[k] ?? 0) + n; return n; };

// ---------------- 逐项 patch ----------------
function patchPitch(noteEl: Element, ch: Chord, nt: Note, fifths: number): number {
  const isRest = ch.rest || nt.rest || nt.number === "0";
  const restEl = child(noteEl, "rest");
  const pitchEl = child(noteEl, "pitch");
  if (isRest) {
    if (restEl) return 0;
    if (pitchEl) pitchEl.remove();
    noteEl.insertBefore(noteEl.ownerDocument.createElement("rest"), noteEl.firstChild);
    return 1;
  }
  const p = jpSpelling(nt, fifths);
  const alter = p.alter;
  if (pitchEl) {
    let n = 0;
    if (setText(pitchEl, "step", p.step)) n++;
    if (setText(pitchEl, "octave", String(p.octave))) n++;
    const alterEl = child(pitchEl, "alter");
    if (alter === 0) {
      if (alterEl) { alterEl.remove(); n++; }
    } else if (alterEl) {
      if (setText(pitchEl, "alter", String(alter))) n++;
    } else {
      const e = noteEl.ownerDocument.createElement("alter");
      e.textContent = String(alter);
      const oct = child(pitchEl, "octave");
      if (oct) pitchEl.insertBefore(e, oct); else pitchEl.append(e);
      n++;
    }
    return n ? 1 : 0;
  }
  if (restEl) restEl.remove();
  const alterXml = alter ? `<alter>${alter}</alter>` : "";
  const el = fragment(noteEl.ownerDocument,
    `<pitch><step>${p.step}</step>${alterXml}<octave>${p.octave}</octave></pitch>`);
  noteEl.insertBefore(el, noteEl.firstChild);
  return 1;
}

function patchDuration(noteEl: Element, ch: Chord, divisions: number): number {
  const d = ch.duration ?? new Fraction(1);
  const dur = durationTicks(d, divisions, "MusicXML patch");
  const tp = noteTypeOf(ch);
  let n = 0;
  if (setText(noteEl, "duration", String(dur))) n++;
  if (setText(noteEl, "type", tp.type)) n++;
  const dots = children(noteEl, "dot");
  if (dots.length !== tp.dots) {
    for (const dt of dots) dt.remove();
    const typeEl = child(noteEl, "type");
    for (let i = 0; i < tp.dots; i++) {
      const e = noteEl.ownerDocument.createElement("dot");
      if (typeEl) typeEl.after(e); else noteEl.append(e);
    }
    n++;
  }
  return n ? 1 : 0;
}

function lyricSigOfEl(noteEl: Element): string {
  return children(noteEl, "lyric")
    .map((l) => children(l, "text").map((t) => t.textContent ?? "").join(""))
    .filter((s) => s.length)
    .join(SEP);
}

function patchLyrics(noteEl: Element, nt: Note): number {
  if (lyricSigOfEl(noteEl) === lyricSig(nt)) return 0;
  for (const l of children(noteEl, "lyric")) l.remove();
  const sorted = [...nt.lyrics].sort((a, b) => a.number - b.number);
  for (const l of sorted) {
    if (!l.text.length) continue;
    const num = l.refrain ? "chorus" : String(l.number);
    noteEl.append(fragment(noteEl.ownerDocument, lyricElementXml(num, l.text)));
  }
  return 1;
}

/** notations 里本模块负责的四类（tied/slur/tuplet/fermata）；其余子元素（articulations、
 *  ornaments…）底本里有就留着，不碰。 */
function patchNotations(
  noteEl: Element, ch: Chord, nt: Note, first: boolean, pairs: SlurTieMap,
): number {
  // 只认配上对的记号：源谱漏写一个 `)` 就会让后面所有弧线连锁错位（见 pairSlurTies）。
  const sl = pairs.slur.get(ch);
  const ti = pairs.tie.get(nt);
  const want: Array<[string, string | null]> = [];
  if (ti?.stop) want.push(["tied", "stop"]);
  if (ti?.start) want.push(["tied", "start"]);
  if (first && sl?.stop !== undefined) want.push(["slur", "stop"]);
  if (first && sl?.start !== undefined) want.push(["slur", "start"]);
  if (nt.tupletEnd) want.push(["tuplet", "stop"]);
  if (nt.tupletBegin) want.push(["tuplet", "start"]);
  // fermata 不进 want：.jpwabc 不表达延长记号，按 Score 来只会把底本的 fermata 删掉。
  const OWNED = ["tied", "slur", "tuplet"];
  let nts = child(noteEl, "notations");
  const have = nts
    ? Array.from(nts.children).filter((c) => OWNED.includes(c.tagName))
      .map((c) => `${c.tagName}:${c.getAttribute("type") ?? ""}`)
    : [];
  const wantKeys = want.map(([t, ty]) => `${t}:${ty ?? ""}`);
  if (have.join("|") === wantKeys.join("|")) return 0;

  if (!want.length) {
    if (!nts) return 0;
    for (const c of Array.from(nts.children)) if (OWNED.includes(c.tagName)) c.remove();
    if (!nts.children.length) nts.remove();
    return 1;
  }
  if (!nts) {
    nts = noteEl.ownerDocument.createElement("notations");
    insertOrdered(noteEl, nts, ["lyric"]);
  } else {
    for (const c of Array.from(nts.children)) if (OWNED.includes(c.tagName)) c.remove();
  }
  for (const [tag, type] of want) {
    const e = noteEl.ownerDocument.createElement(tag);
    if (type) e.setAttribute("type", type);
    nts.insertBefore(e, nts.firstChild);
  }
  // 上面倒序插入会翻转顺序，重排成 want 的顺序。
  const ordered = want.map(([tag, type]) =>
    Array.from(nts!.children).find((c) => c.tagName === tag && (c.getAttribute("type") ?? null) === type)!);
  for (const e of ordered) nts.append(e);
  return 1;
}

// ---------------- 顶层元数据 ----------------
function patchHeader(root: Element, base: Score, edited: Score): number {
  let n = 0;
  if (base.title !== edited.title) {
    const work = child(root, "work");
    if (work && setText(work, "work-title", edited.title)) n++;
    for (const cr of children(root, "credit")) {
      if (child(cr, "credit-type")?.textContent !== "title") continue;
      const w = child(cr, "credit-words");
      if (w && w.textContent !== edited.title) { w.textContent = edited.title; n++; }
    }
  }
  // 著作者行：按顺序比对非 title 的 credit 文本，逐行改写（不动 page/credit-type/坐标属性）。
  const baseCr = base.credit.filter((c) => c.type !== "title");
  const editCr = edited.credit.filter((c) => c.type !== "title");
  const els = children(root, "credit").filter((e) => child(e, "credit-type")?.textContent !== "title");
  for (let i = 0; i < Math.min(baseCr.length, editCr.length, els.length); i++) {
    if (baseCr[i].text === editCr[i].text) continue;
    const lines = editCr[i].text.split("\n").filter((s) => s.length);
    const wordEls = children(els[i], "credit-words");
    if (wordEls.length !== lines.length) continue; // 行数变了：结构性改动，交给 fallback 判定
    wordEls.forEach((w, k) => { if (w.textContent !== lines[k]) { w.textContent = lines[k]; n++; } });
  }
  return n;
}

// ---------------- 主流程 ----------------
export function patchMusicXml(baseXml: string, edited: Score): PatchResult {
  for (const k of Object.keys(detail)) delete detail[k];
  const doc = new DOMParser().parseFromString(baseXml, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("MusicXML 底本解析失败: " + err.textContent);
  const base = loadMusicXml(baseXml);

  const root = doc.documentElement;
  const partEl = children(root, "part")[0];
  if (!partEl) return { xml: baseXml, changed: 0, fallback: true };

  const firstAttr = children(partEl, "measure")[0]
    ? child(children(partEl, "measure")[0], "attributes") : null;
  const divisions = Number(firstAttr ? child(firstAttr, "divisions")?.textContent ?? "1" : "1") || 1;

  const slurTies = pairSlurTies(edited);
  const baseMeasures = base.parts[0]?.measures ?? [];
  const editMeasures = edited.parts[0]?.measures ?? [];
  const measureEls = children(partEl, "measure");
  if (measureEls.length !== baseMeasures.length) {
    // 底本与它自己的导入结果都对不上（多声部/异常结构），不冒险。
    return { xml: baseXml, changed: 0, fallback: true };
  }

  const pairs = alignWithEdits(baseMeasures.map(measureSig), editMeasures.map(measureSig));
  const matchedM = new Set(pairs.map(([i]) => i));
  const matchedE = new Set(pairs.map(([, j]) => j));
  let changed = 0;
  let matchedChords = 0, totalChords = 0;

  for (const [bi, ei] of pairs) {
    const bm = baseMeasures[bi], em = editMeasures[ei];
    const mel = measureEls[bi];
    const chordEls = collectChordEls(mel);
    const bChords = chordsOf(bm), eChords = chordsOf(em);
    if (chordEls.length !== bChords.length) { totalChords += Math.max(bChords.length, eChords.length); continue; }

    const cPairs = alignWithEdits(bChords.map(chordSig), eChords.map(chordSig));
    totalChords += Math.max(bChords.length, eChords.length);
    matchedChords += cPairs.length;
    const usedB = new Set(cPairs.map(([i]) => i));

    const fifths = bm.key.fifths;
    for (const [bci, eci] of cPairs) {
      const ech = eChords[eci];
      const els = chordEls[bci];
      // 和弦内音符数变了：整组重建（简谱几乎不会发生，稳妥起见留一条路）。
      if (els.length !== ech.notes.length) {
        const xml = ech.notes.map((nt, k) => makeNoteXml(ech, nt, divisions, fifths, k)).join("");
        const nodes = Array.from(fragment(doc, `<w>${xml}</w>`).children);
        let anchor: Element = els[0];
        anchor.replaceWith(nodes[0]);
        anchor = nodes[0];
        for (const nd of nodes.slice(1)) { anchor.after(nd); anchor = nd; }
        for (const e of els.slice(1)) e.remove();
        changed++;
        continue;
      }
      ech.notes.forEach((nt, k) => {
        const el = els[k];
        changed += bump("pitch", patchPitch(el, ech, nt, fifths));
        if (k === 0) changed += bump("duration", patchDuration(el, ech, divisions));
        changed += bump("notations", patchNotations(el, ech, nt, k === 0, slurTies));
        changed += bump("lyrics", patchLyrics(el, nt));
      });
    }
    // 被删掉的和弦
    for (let bci = 0; bci < bChords.length; bci++) {
      if (usedB.has(bci)) continue;
      for (const e of chordEls[bci]) e.remove();
      changed++;
    }
    // 新增的和弦：插到对齐位置（前一个配对和弦之后，否则小节开头）
    const usedE = new Map(cPairs.map(([i, j]) => [j, i]));
    for (let eci = 0; eci < eChords.length; eci++) {
      if (usedE.has(eci)) continue;
      const ech = eChords[eci];
      const xml = ech.notes.map((nt, k) => makeNoteXml(ech, nt, divisions, fifths, k)).join("");
      const nodes = Array.from(fragment(doc, `<w>${xml}</w>`).children);
      let prevBci = -1;
      for (const [i, j] of cPairs) if (j < eci && i > prevBci) prevBci = i;
      const prev = prevBci >= 0 ? chordEls[prevBci][chordEls[prevBci].length - 1] : null;
      let anchor: Element | null = prev && prev.isConnected ? prev : null;
      for (const nd of nodes) {
        if (anchor) anchor.after(nd);
        else insertOrdered(mel, nd, ["barline"]);
        anchor = nd;
      }
      changed++;
    }

    // barline / ending / repeat / sectionMark 一律不碰，见文件头「不碰什么」。
  }

  // 小节增删：只支持整节删除与在末尾追加，中间插入交给 fallback（结构变化太大，patch 不可靠）。
  const deleted = baseMeasures.map((_, i) => i).filter((i) => !matchedM.has(i));
  const added = editMeasures.map((_, i) => i).filter((i) => !matchedE.has(i));
  for (const i of deleted.reverse()) { measureEls[i].remove(); changed++; }
  if (added.length) {
    if (added.some((i) => i < editMeasures.length - added.length)) {
      return { xml: baseXml, changed: 0, fallback: true };
    }
    const fifths = baseMeasures[baseMeasures.length - 1]?.key.fifths ?? 0;
    for (const i of added) {
      const m = editMeasures[i];
      const notes = chordsOf(m)
        .map((ch) => ch.notes.map((nt, k) => makeNoteXml(ch, nt, divisions, fifths, k)).join("")).join("");
      partEl.append(fragment(doc, `<measure number="0">${notes}</measure>`));
      changed++;
    }
  }
  if (deleted.length || added.length) {
    children(partEl, "measure").forEach((el, i) => el.setAttribute("number", String(i + 1)));
  }

  changed += bump("header", patchHeader(root, base, edited));

  const rate = totalChords === 0 ? 1 : matchedChords / totalChords;
  if (rate < 0.5) return { xml: baseXml, changed: 0, fallback: true };

  return { xml: new XMLSerializer().serializeToString(doc), changed, fallback: false };
}

/** 供回归脚本单测对齐算法。 */
export const _internal = { lcsPairs, alignWithEdits, chordSig, measureSig, detail, lyricSig, lyricSigOfEl, collectChordEls, chordsOf };
