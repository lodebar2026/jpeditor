// 文本谱 AST → MusicXML（直出，不经 Score）。
//
// 为什么不走 Score：Score 装不下和弦符号、力度、渐强渐弱、多声部并排，经它一道就把
// 「尽量保留信息」这个前提折掉了。这里直接从 AST 生成，Score 那条路（toscore.ts）
// 留给 `.jpwabc` / MIDI / 试听——它们本来就只需要音高与时值。
//
// 音高与时值的换算复用主谱面那套（spellPitch / typeOfDuration / MusicCommon），
// 两条路得出的结果才对得上。

import { Fraction } from "../common/fraction";
import { Key, MusicCommon } from "../score/score";
import { escapeXml, spellPitch, typeOfDuration } from "../score/musicxmlout";
import { harmonyXml } from "../score/harmonyxml";
import type {
  BarlineElement,
  Mark,
  Meter,
  MusicElement,
  NoteElement,
  PuDoc,
  PuSong,
  ScoreLine,
} from "./ast";
import { DYNAMICS, TERMS } from "./glyph";

const escapeAttr = (s: string): string => escapeXml(s).replace(/"/g, "&quot;");

/** 音符时值（以四分音符为 1）。多连音比例由调用方另乘。 */
function noteQuarters(el: NoteElement | { duration: number; dots: number }): Fraction {
  const base = new Fraction(4, el.duration);
  if (el.dots <= 0) return base;
  // 附点：×(2 − 2^−n)
  const denom = 1 << el.dots;
  return base.timesInt(2 * denom - 1).divInt(denom);
}

/** `&xx` 记号 → MusicXML 的 articulations / ornaments 元素名。 */
const ARTICULATION: Readonly<Record<string, string>> = {
  yc: "fermata",
  ycy: "fermata",
  bc: "tenuto",
  zy: "accent",
  dy: "staccato",
  hx: "breath-mark",
};
const ORNAMENT_TAG: Readonly<Record<string, string>> = {
  sby: "inverted-mordent",
  xby: "mordent",
  cy: "trill-mark",
  tr: "trill-mark",
};
/** 上下滑音在 MusicXML 里属于 technical/articulations 的 scoop / falloff。 */
const SLIDE_TAG: Readonly<Record<string, string>> = { shy: "scoop", xhy: "falloff" };

interface Ctx {
  fifths: number;
  divisions: number;
  /** 小节内延续的临时记号（唱名 → 半音） */
  alter: Record<number, number>;
}

/** 唱名 + 八度 + 临时记号 → MusicXML 的 step/alter/octave。 */
function spell(el: NoteElement, ctx: Ctx): { step: string; alter: number; octave: number } {
  const digit = String(el.pitch);
  switch (el.accidental) {
    case "sharp": ctx.alter[el.pitch] = 1; break;
    case "double-sharp": ctx.alter[el.pitch] = 2; break;
    case "flat": ctx.alter[el.pitch] = -1; break;
    case "double-flat": ctx.alter[el.pitch] = -2; break;
    case "natural": delete ctx.alter[el.pitch]; break;
    default: break;
  }
  const natural =
    MusicCommon.getBasePitch(MusicCommon.keys[ctx.fifths + 7]!) +
    12 * el.octave +
    MusicCommon.stepToPitch(digit);
  const pitch = natural + (ctx.alter[el.pitch] ?? 0);
  return spellPitch(pitch, MusicCommon.jpToStep(digit, ctx.fifths));
}

/** 某个元素下标上开始/结束的记号。 */
function marksAt(marks: readonly Mark[], index: number, type: Mark["type"]): Mark[] {
  return marks.filter((m) => m.type === type && (m.start === index || m.end === index));
}

/** 一个声部的全部曲行（跨 system 接起来）。 */
function linesOfVoice(song: PuSong, voice: number): ScoreLine[] {
  const out: ScoreLine[] = [];
  for (const page of song.pages) {
    for (const group of page.groups) {
      for (const v of group.voices) if (v.voice === voice) out.push(v);
    }
  }
  return out;
}

function voiceNumbers(song: PuSong): number[] {
  const seen: number[] = [];
  for (const page of song.pages) {
    for (const group of page.groups) {
      for (const v of group.voices) if (!seen.includes(v.voice)) seen.push(v.voice);
    }
  }
  return seen.length > 0 ? seen : [1];
}

/** 全曲扫一遍定 divisions：所有音符时值分母的最小公倍数。 */
function collectDivisions(song: PuSong): number {
  const lcm = (a: number, b: number): number => {
    const g = (x: number, y: number): number => (y === 0 ? x : g(y, x % y));
    return (a / g(a, b)) * b;
  };
  let div = 1;
  for (const voice of voiceNumbers(song)) {
    for (const line of linesOfVoice(song, voice)) {
      const ratios = tupletRatios(line);
      line.elements.forEach((el, i) => {
        if (el.kind !== "note") return;
        let q = noteQuarters(el);
        const r = ratios[i];
        if (r) q = q.timesInt(r.num).divInt(r.den);
        div = lcm(div, q.denominator);
        for (const g of [...el.graceBefore, ...el.graceAfter]) {
          div = lcm(div, noteQuarters(g).denominator);
        }
      });
    }
  }
  if (div > 1024) console.warn(`文本谱导出 MusicXML：divisions=${div} 过大`);
  return div;
}

/** 每个元素下标的多连音比例（n 连音占 n−1 个基本时值）。 */
function tupletRatios(line: ScoreLine): Array<{ num: number; den: number } | undefined> {
  const out = new Array<{ num: number; den: number } | undefined>(line.elements.length);
  for (const mk of line.marks) {
    if (mk.type !== "tuplet") continue;
    const n = mk.end - mk.start + 1;
    if (n <= 1) continue;
    for (let i = mk.start; i <= mk.end && i < out.length; i++) out[i] = { num: n - 1, den: n };
  }
  return out;
}

function meterXml(m: Meter): string {
  return `<time><beats>${m.numerator}</beats><beat-type>${m.denominator}</beat-type></time>`;
}

function barStyleOf(el: BarlineElement): string | null {
  switch (el.type) {
    case "double": return "light-light";
    case "end": return "light-heavy";
    case "repeat-end":
    case "repeat-both": return "light-heavy";
    case "repeat-start": return "heavy-light";
    case "hidden":
    case "invisible": return "none";
    default: return null;
  }
}

interface DirectionOut {
  /** 放在音符之前的 <direction> 片段 */
  before: string[];
  /** 放在音符之后的（渐强渐弱的收尾） */
  after: string[];
}

/** `&xx` 里的力度/术语/伴奏括弧 → <direction>。 */
function directionsFor(el: MusicElement, out: DirectionOut): void {
  if (el.kind !== "note" && el.kind !== "sustain" && el.kind !== "barline") return;
  for (const orn of el.ornaments) {
    if (DYNAMICS[orn.name]) {
      out.before.push(
        `<direction placement="below"><direction-type><dynamics><${orn.name}/></dynamics>` +
          `</direction-type></direction>`,
      );
    } else if (TERMS[orn.name]) {
      out.before.push(
        `<direction placement="above"><direction-type><words>${escapeXml(TERMS[orn.name]!)}` +
          `</words></direction-type></direction>`,
      );
    } else if (orn.name === "zkh" || orn.name === "ykh") {
      // 伴奏括弧 → bracket
      const type = orn.name === "zkh" ? "start" : "stop";
      out.before.push(
        `<direction placement="above"><direction-type>` +
          `<bracket type="${type}" line-end="down" line-type="solid"/>` +
          `</direction-type></direction>`,
      );
    } else if (orn.name === "fine" || orn.name === "dc" || orn.name === "ds") {
      const words = orn.name === "fine" ? "Fine" : orn.name === "dc" ? "D.C." : "D.S.";
      const sound =
        orn.name === "fine" ? `<sound fine="yes"/>` :
        orn.name === "dc" ? `<sound dacapo="yes"/>` : `<sound dalsegno="1"/>`;
      out.before.push(
        `<direction placement="above"><direction-type><words>${words}</words>` +
          `</direction-type>${sound}</direction>`,
      );
    } else if (orn.name === "ty" || orn.name === "hs") {
      const tag = orn.name === "ty" ? "coda" : "segno";
      out.before.push(
        `<direction placement="above"><direction-type><${tag}/></direction-type></direction>`,
      );
    }
  }
}

/** 音符上的演奏记号 → <notations>。 */
function notationsFor(
  el: NoteElement,
  index: number,
  line: ScoreLine,
  slurNumbers: Map<Mark, number>,
): string {
  const parts: string[] = [];

  for (const mk of marksAt(line.marks, index, "slur")) {
    const n = slurNumbers.get(mk) ?? 1;
    if (mk.start === index) parts.push(`<slur type="start" number="${n}"/>`);
    if (mk.end === index) parts.push(`<slur type="stop" number="${n}"/>`);
  }
  for (const mk of marksAt(line.marks, index, "tuplet")) {
    if (mk.start === index) parts.push(`<tuplet type="start" bracket="yes"/>`);
    if (mk.end === index) parts.push(`<tuplet type="stop"/>`);
  }

  const artic: string[] = [];
  const ornaments: string[] = [];
  let fermata = false;
  for (const orn of el.ornaments) {
    const a = ARTICULATION[orn.name];
    if (a === "fermata") { fermata = true; continue; }
    if (a) { artic.push(`<${a}/>`); continue; }
    const o = ORNAMENT_TAG[orn.name];
    if (o) { ornaments.push(`<${o}/>`); continue; }
    const s = SLIDE_TAG[orn.name];
    if (s) artic.push(`<${s}/>`);
  }
  if (fermata) parts.push(`<fermata type="upright"/>`);
  if (artic.length) parts.push(`<articulations>${artic.join("")}</articulations>`);
  if (ornaments.length) parts.push(`<ornaments>${ornaments.join("")}</ornaments>`);

  return parts.length ? `<notations>${parts.join("")}</notations>` : "";
}

/** 给重叠的弧线分配 number（MusicXML 靠它配对）。 */
function assignSlurNumbers(line: ScoreLine): Map<Mark, number> {
  const out = new Map<Mark, number>();
  const active: Array<Mark | null> = [];
  const slurs = line.marks.filter((m) => m.type === "slur").sort((a, b) => a.start - b.start);
  for (const mk of slurs) {
    let slot = active.findIndex((a) => a === null || a.end < mk.start);
    if (slot < 0) slot = active.length;
    active[slot] = mk;
    out.set(mk, slot + 1);
  }
  return out;
}

export interface ToXmlOptions {
  /** 取第几首（`-----` 分出的多唱法）。默认第一首。 */
  song?: number;
}

/** 文本谱 → MusicXML。多声部输出为多个 `<part>`。 */
export function puToMusicXml(doc: PuDoc, options: ToXmlOptions = {}): string {
  const song = doc.songs[options.song ?? 0];
  if (!song) throw new Error("这份文本谱里没有可导出的曲行");
  const meta = song.metadata;

  const key = new Key();
  key.fifths = MusicCommon.keyNameToFifth(meta.mode ?? "C");
  const divisions = collectDivisions(song);
  const meter = meta.meters[0] ?? { numerator: 4, denominator: 4, parenthesized: false };
  const tempo = meta.tempos.find((t): t is number => typeof t === "number" && t >= 20 && t <= 400);

  const voices = voiceNumbers(song);
  const partsXml = voices
    .map((v, pi) => `<part id="P${pi + 1}">${partXml(song, v, key.fifths, divisions, meter, pi === 0 ? tempo : undefined)}</part>`)
    .join("");

  const partList = voices
    .map((v, pi) => {
      const caption = firstCaption(song, v);
      const name = caption
        ? `<part-name>${escapeXml(caption)}</part-name>`
        : `<part-name print-object="no"></part-name>`;
      return `<score-part id="P${pi + 1}">${name}</score-part>`;
    })
    .join("");

  const title = meta.titles[0] ?? "";
  const workXml = title ? `<work><work-title>${escapeXml(title)}</work-title></work>` : "";
  const credits: string[] = [];
  meta.titles.forEach((t, i) => {
    if (i === 0) return;
    credits.push(`<credit page="1"><credit-type>subtitle</credit-type><credit-words>${escapeXml(t)}</credit-words></credit>`);
  });
  for (const a of [...meta.authors, ...meta.topRight]) {
    if (a) credits.push(`<credit page="1"><credit-type>composer</credit-type><credit-words>${escapeXml(a)}</credit-words></credit>`);
  }
  for (const a of meta.topLeft) {
    if (a) credits.push(`<credit page="1"><credit-type>lyricist</credit-type><credit-words>${escapeXml(a)}</credit-words></credit>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.0">
${workXml}${credits.join("")}<part-list>${partList}</part-list>
${partsXml}
</score-partwise>`;
}

function firstCaption(song: PuSong, voice: number): string | undefined {
  for (const line of linesOfVoice(song, voice)) if (line.caption) return line.caption;
  return undefined;
}

/** 一个声部的全部小节。 */
function partXml(
  song: PuSong,
  voice: number,
  fifths: number,
  divisions: number,
  meter: Meter,
  tempo: number | undefined,
): string {
  const ctx: Ctx = { fifths, divisions, alter: {} };
  const measures: string[] = [];
  let body: string[] = [];
  let measureNo = 1;
  let firstMeasure = true;
  let pendingPrint = "";
  let pendingRepeatForward = false;
  /** 本小节是否已经写过音符。行末 `|` 紧接下一行 `|:` 会连着两条小节线，
   *  中间没有音符——那不是一个小节，不能凭空造一个空的出来。 */
  let hasNote = false;
  /** 合并掉的空小节留下的房号，挪到下一小节的左侧小节线上 */
  let pendingLeftEndings: string[] = [];

  const flushMeasure = (barline: string): void => {
    const attrs = firstMeasure
      ? `<attributes><divisions>${divisions}</divisions>` +
        `<key><fifths>${fifths}</fifths></key>${meterXml(meter)}</attributes>` +
        (tempo ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>` : "")
      : "";
    const leftParts: string[] = [];
    if (pendingRepeatForward) {
      leftParts.push(`<bar-style>heavy-light</bar-style><repeat direction="forward"/>`);
    }
    leftParts.push(...pendingLeftEndings);
    const repeat = leftParts.length
      ? `<barline location="left">${leftParts.join("")}</barline>`
      : "";
    pendingRepeatForward = false;
    pendingLeftEndings = [];
    measures.push(
      `<measure number="${measureNo}">${pendingPrint}${attrs}${repeat}${body.join("")}${barline}</measure>`,
    );
    pendingPrint = "";
    firstMeasure = false;
    measureNo += 1;
    body = [];
    hasNote = false;
    ctx.alter = {};
  };

  const lines = linesOfVoice(song, voice);
  lines.forEach((line, lineIdx) => {
    if (lineIdx > 0) pendingPrint = `<print new-system="yes"/>`;
    const ratios = tupletRatios(line);
    const slurNumbers = assignSlurNumbers(line);
    const cursors = line.lyrics.map(() => 0);
    let lastNoteXmlIndex = -1;

    line.elements.forEach((el, index) => {
      if (el.kind === "beat-boundary" || el.kind === "inline-layer") return;

      if (el.kind === "sustain") {
        // 增时线并进前一个音符：把它的 duration 加一拍
        if (lastNoteXmlIndex >= 0) {
          body[lastNoteXmlIndex] = extendDuration(body[lastNoteXmlIndex]!, divisions);
        }
        return;
      }

      if (el.kind === "barline") {
        const dir: DirectionOut = { before: [], after: [] };
        directionsFor(el, dir);
        body.push(...dir.before);
        const style = barStyleOf(el);
        const parts: string[] = [];
        if (style && style !== "none") parts.push(`<bar-style>${style}</bar-style>`);
        const volta = marksAt(line.marks, index, "volta");
        for (const mk of volta) {
          const nums = (mk.caption ?? "").match(/\d+/g)?.join(",") ?? "1";
          if (mk.start === index) {
            parts.push(`<ending number="${escapeAttr(nums)}" type="start"/>`);
          } else {
            parts.push(`<ending number="${escapeAttr(nums)}" type="${mk.openEnd ? "discontinue" : "stop"}"/>`);
          }
        }
        if (el.type === "repeat-end" || el.type === "repeat-both") {
          parts.push(`<repeat direction="backward"/>`);
        }
        if (el.type === "repeat-start" || el.type === "repeat-both") pendingRepeatForward = true;
        if (!hasNote) {
          // 两条小节线挨着：不成小节。把房号顺延到下一小节的左侧，
          // 已经攒下的 direction 也留着（它们本来就该挂在下一个音符之前）。
          for (const p of parts) {
            if (p.startsWith("<ending")) pendingLeftEndings.push(p);
          }
          lastNoteXmlIndex = -1;
          if (el.temporaryMeter) {
            pendingPrint += `<attributes>${meterXml(el.temporaryMeter)}</attributes>`;
          }
          return;
        }
        const bar = parts.length ? `<barline location="right">${parts.join("")}</barline>` : "";
        flushMeasure(bar);
        lastNoteXmlIndex = -1;
        if (el.temporaryMeter) {
          // 临时拍号写进下一小节的 attributes
          pendingPrint += `<attributes>${meterXml(el.temporaryMeter)}</attributes>`;
        }
        return;
      }

      // 音符
      const dir: DirectionOut = { before: [], after: [] };
      directionsFor(el, dir);
      if (el.chord) body.push(harmonyXml(el.chord));
      if (el.annotation) {
        body.push(
          `<direction placement="above"><direction-type><words>${escapeXml(el.annotation)}` +
            `</words></direction-type></direction>`,
        );
      }
      // 渐强渐弱：起点与终点各写一个 wedge
      for (const mk of line.marks) {
        if (mk.type !== "crescendo" && mk.type !== "decrescendo") continue;
        if (mk.start === index) {
          const t = mk.type === "crescendo" ? "crescendo" : "diminuendo";
          body.push(`<direction placement="below"><direction-type><wedge type="${t}"/></direction-type></direction>`);
        }
      }
      body.push(...dir.before);

      // 倚音
      for (const g of el.graceBefore) body.push(graceXml(g, ctx));
      let q = noteQuarters(el);
      const r = ratios[index];
      if (r) q = q.timesInt(r.num).divInt(r.den);
      lastNoteXmlIndex = body.length;
      hasNote = true;
      body.push(noteXml(el, q, ctx, index, line, slurNumbers, cursors, r));
      for (const g of el.graceAfter) body.push(graceXml(g, ctx));

      for (const mk of line.marks) {
        if (mk.type !== "crescendo" && mk.type !== "decrescendo") continue;
        if (mk.end === index) {
          body.push(`<direction placement="below"><direction-type><wedge type="stop"/></direction-type></direction>`);
        }
      }
    });
  });

  if (hasNote) flushMeasure("");
  return measures.join("");
}

/** 把已生成的 `<note>` 片段里的 duration/type 加一拍（增时线）。 */
function extendDuration(noteXmlStr: string, divisions: number): string {
  const m = /<duration>(\d+)<\/duration>/.exec(noteXmlStr);
  if (!m) return noteXmlStr;
  const total = Number(m[1]) + divisions;
  let out = noteXmlStr.replace(/<duration>\d+<\/duration>/, `<duration>${total}</duration>`);
  const { type, dots } = typeOfDuration(new Fraction(total, divisions));
  out = out.replace(/<type>[^<]*<\/type>(<dot\/>)*/, `<type>${type}</type>${"<dot/>".repeat(dots)}`);
  return out;
}

function graceXml(g: NoteElement, ctx: Ctx): string {
  const p = spell(g, ctx);
  return (
    `<note><grace slash="yes"/><pitch><step>${p.step}</step>` +
    (p.alter !== 0 ? `<alter>${p.alter}</alter>` : "") +
    `<octave>${p.octave}</octave></pitch><type>eighth</type></note>`
  );
}

function noteXml(
  el: NoteElement,
  quarters: Fraction,
  ctx: Ctx,
  index: number,
  line: ScoreLine,
  slurNumbers: Map<Mark, number>,
  cursors: number[],
  ratio: { num: number; den: number } | undefined,
): string {
  const duration = Math.max(1, Math.round((quarters.numerator * ctx.divisions) / quarters.denominator));
  const { type, dots } = typeOfDuration(noteQuarters(el));

  let head: string;
  if (el.sound === "rhythm") {
    head = `<unpitched><display-step>B</display-step><display-octave>4</display-octave></unpitched>` +
      `<notehead>slash</notehead>`;
  } else if (el.sound === "rest" || el.hidden) {
    head = el.hidden ? `<rest print-object="no"/>` : `<rest/>`;
  } else {
    const p = spell(el, ctx);
    head = `<pitch><step>${p.step}</step>` +
      (p.alter !== 0 ? `<alter>${p.alter}</alter>` : "") +
      `<octave>${p.octave}</octave></pitch>`;
  }

  const timeMod = ratio
    ? `<time-modification><actual-notes>${ratio.den}</actual-notes>` +
      `<normal-notes>${ratio.num}</normal-notes></time-modification>`
    : "";

  // 歌词：按「跟词」的符号顺序发放
  let lyricXml = "";
  if (el.lyricAnchor) {
    line.lyrics.forEach((lyricLine, li) => {
      const syl = lyricLine.syllables[cursors[li]!];
      cursors[li] = (cursors[li] ?? 0) + 1;
      if (!syl || syl.text.length === 0) return;
      const text = syl.text + (syl.trailingPunctuation ?? "");
      for (let v = lyricLine.verseFrom; v <= lyricLine.verseTo; v += 1) {
        lyricXml += `<lyric number="${v}"><syllabic>single</syllabic>` +
          `<text>${escapeXml(text)}</text></lyric>`;
      }
    });
  }

  return (
    `<note>${head}<duration>${duration}</duration><voice>1</voice>` +
    `<type>${type}</type>${"<dot/>".repeat(dots)}${timeMod}` +
    notationsFor(el, index, line, slurNumbers) +
    lyricXml +
    `</note>`
  );
}

export { collectDivisions as _collectDivisions };
