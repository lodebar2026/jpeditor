// 把 RecognizedScore 输出为 MusicXML 3.0 partwise（参考 musicpp omr/musicxml.cpp / qtomr/toxml.cpp）。
// 简谱数字→音高：可动 do，按 fifths 求调主音，数字 1-7 映射到自然音级，叠加八度点与升降。
import type { RecognizedScore, JpNum, StaffRow } from "./types";

// C 大调音名表（fifths=0 时 1..7 对应 C D E F G A B）。
const STEPS = ["C", "D", "E", "F", "G", "A", "B"];

function tonicStep(fifths: number): number {
  // fifths→主音在五度圈上的音级索引（0=C）。简化：常见调直接给。
  const map: Record<number, number> = { 0: 0, 1: 4, 2: 1, 3: 5, 4: 2, 5: 6, 6: 3, [-1]: 3, [-2]: 0, [-3]: 4 };
  return map[fifths] ?? 0;
}

/** 数字音符 → {step, alter, octave(科学记号)} 。base 八度按数字 1 落在第 4 八度附近。 */
function pitchOf(num: JpNum, fifths: number): { step: string; alter: number; octave: number } {
  const tonic = tonicStep(fifths);
  const degree = Math.max(1, Math.min(7, num.digit)) - 1; // 0-based
  const stepIdx = (tonic + degree) % 7;
  const wrap = Math.floor((tonic + degree) / 7);
  const octave = 4 + num.octave + wrap;
  return { step: STEPS[stepIdx], alter: 0, octave };
}

// 时值：基础=四分(quarter)=QUARTER 个 division；div 条下划线 → 每条减半；
// augment 增时线每条 +1 拍(四分)；dot 附点 → +半。type 从最终总时值反推（修复初版 type
// 只看基础值、augment/dot 后与 duration 不一致的 bug）。
const QUARTER = 4; // divisions per quarter（与 <divisions>4 一致）

function typeForDivisions(div: number): string {
  const q = div / QUARTER; // 折算成"四分音符数"
  if (q >= 4) return "whole";
  if (q >= 2) return "half";
  if (q >= 1) return "quarter";
  if (q >= 0.5) return "eighth";
  return "16th";
}

function durationOf(num: JpNum): { type: string; divisions: number; dots: number } {
  const base = QUARTER / Math.pow(2, num.div); // 下划线每条减半
  let total = base + num.augment * QUARTER;    // 增时线每条 +1 拍
  const dots = num.dot > 0 ? 1 : 0;
  if (dots) total += base / 2;                 // 附点 +半
  const divisions = Math.max(1, Math.round(total));
  return { type: typeForDivisions(divisions), divisions, dots };
}

function noteXml(num: JpNum, fifths: number): string {
  if (num.digit === 0) {
    const d = durationOf(num);
    return `<note><rest/><duration>${d.divisions}</duration><type>${d.type}</type>${"<dot/>".repeat(d.dots)}</note>`;
  }
  const p = pitchOf(num, fifths);
  const d = durationOf(num);
  const alterXml = p.alter ? `<alter>${p.alter}</alter>` : "";
  return `<note><pitch><step>${p.step}</step>${alterXml}<octave>${p.octave}</octave></pitch>` +
    `<duration>${d.divisions}</duration><type>${d.type}</type>${"<dot/>".repeat(d.dots)}</note>`;
}

// 把一行按小节线 x 切成小节。
function measuresOfRow(row: StaffRow): JpNum[][] {
  if (!row.barlineXs.length) return [row.nums];
  const measures: JpNum[][] = [];
  let cur: JpNum[] = [];
  let bi = 0;
  for (const n of row.nums) {
    while (bi < row.barlineXs.length && n.bbox.x > row.barlineXs[bi]) { measures.push(cur); cur = []; bi++; }
    cur.push(n);
  }
  measures.push(cur);
  return measures.filter((m) => m.length);
}

export function toMusicXml(score: RecognizedScore): string {
  const allMeasures: JpNum[][] = [];
  for (const row of score.rows) allMeasures.push(...measuresOfRow(row));

  let mi = 0;
  const measuresXml = allMeasures.map((notes) => {
    mi++;
    const attrs = mi === 1
      ? `<attributes><divisions>4</divisions><key><fifths>${score.fifths}</fifths></key>` +
        `<time><beats>${score.beats}</beats><beat-type>${score.beatType}</beat-type></time>` +
        `<clef><sign>G</sign><line>2</line></clef></attributes>`
      : "";
    const noteEls = notes.map((n) => noteXml(n, score.fifths)).join("");
    return `<measure number="${mi}">${attrs}${noteEls}</measure>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.0">
<part-list><score-part id="P1"><part-name>Jianpu</part-name></score-part></part-list>
<part id="P1">${measuresXml}</part>
</score-partwise>`;
}
