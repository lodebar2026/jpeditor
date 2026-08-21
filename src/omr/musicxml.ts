// 把 RecognizedScore 输出为 MusicXML 3.0 partwise（参考 musicpp omr/musicxml.cpp / qtomr/toxml.cpp）。
// 简谱数字→音高：可动 do，按 fifths 求调主音，数字 1-7 映射到自然音级，叠加八度点与升降。
import type { RecognizedScore, JpNum, StaffRow } from "./types";
import { rright } from "./types";
// 简谱数字→音高拼写：与 MusicXML 导出（score/musicxmlout.ts）共用同一份换算，见该文件说明。
import { jpPitch } from "../score/jppitch";
import { harmonyXml } from "../score/harmonyxml";

/** 数字音符 → {step, alter, octave(科学记号)}。可动 do：数字 1=主音，按调号求该音级的升降。 */
function pitchOf(num: JpNum, fifths: number): { step: string; alter: number; octave: number } {
  return jpPitch(num.digit, num.octave, fifths);
}

// 时值：基础=四分(quarter)=QUARTER 个 division；div 条下划线 → 每条减半；
// augment 增时线每条 +1 拍(四分)；dot 附点 → +半。type 从最终总时值反推（修复初版 type
// 只看基础值、augment/dot 后与 duration 不一致的 bug）。
// divisions per quarter。取 16 而不是 4：div=3（32 分）时 base = QUARTER/8，取 4 会得到 0.5、
// 被 round 成 1，时值凭空翻倍；16 能精确表示到 64 分附点。<divisions> 直接用这个常量输出。
const QUARTER = 16;

// 由总时值(divisions)反推 MusicXML 的 <type> + 附点数。**附点不只来自简谱附点**：增时线把音延长到
// 3 拍(如 3/4 的 5--)即「附点二分」、6 拍即「附点全」——必须吐成 type=half/whole + <dot/>，否则
// 下游导入器(score/musicxml.ts::parseDuration)只按 type 定 beats(half→2)，会把 5-- 还原成 5-(少一根
// 增时线)。故这里据时值匹配 基础音符×{1, ×1.5(单附点), ×1.75(双附点)}。
function noteTypeDots(divisions: number): { type: string; dots: number } {
  const q = divisions / QUARTER; // 折算成"四分音符数"
  const bases: Array<[string, number]> = [
    ["whole", 4], ["half", 2], ["quarter", 1], ["eighth", 0.5], ["16th", 0.25], ["32nd", 0.125],
  ];
  for (const [type, val] of bases) {
    if (Math.abs(q - val) < 1e-6) return { type, dots: 0 };
    if (Math.abs(q - val * 1.5) < 1e-6) return { type, dots: 1 };
    if (Math.abs(q - val * 1.75) < 1e-6) return { type, dots: 2 };
  }
  for (const [type, val] of bases) if (q >= val - 1e-6) return { type, dots: 0 }; // 非规整时值：取不超过的最大基础音符
  return { type: "16th", dots: 0 };
}

function durationOf(num: JpNum): { type: string; divisions: number; dots: number } {
  const base = QUARTER / Math.pow(2, num.div); // 下划线每条减半
  let total = base + num.augment * QUARTER;    // 增时线每条 +1 拍
  if (num.dot > 0) total += base / 2;          // 附点 +半
  const divisions = Math.max(1, Math.round(total));
  return { divisions, ...noteTypeDots(divisions) };
}

const escapeXml = (s: string) => s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));

// 歌词 <lyric number="i"><text>字</text></lyric>，按 verse 索引。下游 score/musicxml.ts 导入器接收。
function lyricsXml(num: JpNum): string {
  if (!num.lyrics) return "";
  let out = "";
  for (let v = 0; v < num.lyrics.length; v++) {
    const t = num.lyrics[v];
    if (!t) continue;
    out += `<lyric number="${v + 1}"><syllabic>single</syllabic><text>${escapeXml(t)}</text></lyric>`;
  }
  return out;
}

/** 弧线配对结果：slur 的 number，以及配上对、可以输出的 tie 端点。 */
interface ArcPairs {
  slur: Map<JpNum, { start?: number; stop?: number }>;
  tie: Map<JpNum, { start?: boolean; stop?: boolean }>;
}

/**
 * 全曲把 slur/tie 配成对，与 score/musicxmlout.ts::pairSlurTies 同一套规则。
 *
 * 识别难免出错：《主祢真伟大》识别出的 slur 虽然 start/stop 各 5 个，配对却错位（嵌套到深度 2
 * 且最后剩一个没闭合）——一条弧的 stop 被算给了错误的 start，MuseScore 就画出一条横跨很远的
 * 弧线。所以这里：栈式配对（后开先闭）、给 slur 写 `number`、**配不上对的一律剔除**。
 *
 * tie 还多一条：MusicXML 要求延音线两端音高相同。识别把两端读成不同音时那不是延音线，
 * 硬输出只会得到一条莫名其妙的长弧，剔除。
 */
function pairArcs(notes: JpNum[], fifths: number): ArcPairs {
  const slur = new Map<JpNum, { start?: number; stop?: number }>();
  const tie = new Map<JpNum, { start?: boolean; stop?: boolean }>();
  const slot = <T>(m: Map<JpNum, T>, n: JpNum, init: T): T => {
    const v = m.get(n) ?? init;
    m.set(n, v);
    return v;
  };
  const keyOf = (n: JpNum) => {
    if (n.digit === 0) return "rest";
    const p = pitchOf(n, fifths);
    return `${p.step}${p.alter}${p.octave}`;
  };
  let dropped = 0;
  // [number, 起始音符, 这条弧是否已作废]
  const openSlur: Array<[number, JpNum, boolean]> = [];
  const openTie: JpNum[] = [];
  const dropSlurStart = (n: JpNum) => { const s = slur.get(n); if (s) delete s.start; };
  for (const n of notes) {
    if (n.slurStop) {
      const top = openSlur.pop();
      // 端点落在休止符上的圆滑线是**识别错误**（弧线本该连到旁边的音符），整条作废——
      // 只丢一端会剩半条弧，MuseScore 会把它一路拖到下一条 slur 那里去。
      // 注：人工写的 .jpwabc 里 slur 连休止符是合法的，全量序列化那条路不做这个剔除。
      if (!top) dropped++;
      else if (top[2] || n.digit === 0) { dropSlurStart(top[1]); dropped++; }
      else slot(slur, n, {}).stop = top[0];
    }
    if (n.slurStart) {
      const used = new Set(openSlur.map(([k]) => k));
      let k = 1;
      while (used.has(k)) k++;
      openSlur.push([k, n, n.digit === 0]);
      slot(slur, n, {}).start = k;
    }
    if (n.tieStop) {
      const from = openTie.pop();
      // 两端音高必须相同，且都不能是休止符（延音线连到休止符在 MusicXML 里没有意义）。
      if (from && n.digit !== 0 && keyOf(from) === keyOf(n)) {
        slot(tie, n, {}).stop = true;
      } else {
        if (from) { const s = tie.get(from); if (s) delete s.start; } // 音高不符：两端一起剔除
        dropped++;
      }
    }
    if (n.tieStart && n.digit !== 0) { openTie.push(n); slot(tie, n, {}).start = true; }
    else if (n.tieStart) dropped++;
  }
  for (const [, n] of openSlur) { dropSlurStart(n); dropped++; }
  for (const n of openTie) { const s = tie.get(n); if (s) delete s.start; dropped++; }
  if (dropped) console.warn(`OMR→MusicXML：剔除了 ${dropped} 个配不上对的 slur/tie 记号`);
  return { slur, tie };
}

// <notations> 排在 <lyric> 之前。tied 是记号，播放语义的 <tie> 另外挂在 <duration> 之后
// （见 noteXml）——本应用的导入器只读 tied，但 MuseScore/Dorico 要两者齐全才算完整。
function notationsXml(num: JpNum, arcs: ArcPairs): string {
  const ns: string[] = [];
  const ti = arcs.tie.get(num);
  const sl = arcs.slur.get(num);
  if (ti?.stop) ns.push(`<tied type="stop"/>`);
  if (ti?.start) ns.push(`<tied type="start"/>`);
  if (sl?.stop !== undefined) ns.push(`<slur type="stop" number="${sl.stop}"/>`);
  if (sl?.start !== undefined) ns.push(`<slur type="start" number="${sl.start}"/>`);
  return ns.length ? `<notations>${ns.join("")}</notations>` : "";
}

/**
 * 符杠（`<beam>`）：简谱的减时线就是五线谱的符杠，一拍之内相邻的减时线音符连成一组。
 * 不写的话下游软件会按自己的规则猜，跨拍/弱起处容易与原图不一致。
 *
 * 与 score/musicxmlout.ts::collectBeams 同一套规则（那边分组复用 Measure.autoBeamGroup，
 * 这里输入是 JpNum 只能自己按拍切）：逐层找连续段，长度 ≥2 → begin/continue/end，
 * 单个 → hook（组内前面还有音就朝后勾）。
 */
function beamsOfMeasure(notes: JpNum[], beatDiv: number): Map<JpNum, Map<number, string>> {
  const out = new Map<JpNum, Map<number, string>>();
  // 按拍切组：位置落在同一拍内、且带减时线、且时值不超过一拍的音符归一组。
  const groups: JpNum[][] = [];
  let pos = 0;
  let curBeat = -1;
  for (const n of notes) {
    const d = durationOf(n);
    const beat = Math.floor(pos / beatDiv);
    if (n.div > 0 && d.divisions <= beatDiv) {
      if (beat !== curBeat || !groups.length) groups.push([]);
      groups[groups.length - 1].push(n);
      curBeat = beat;
    } else {
      curBeat = -1; // 不带减时线的音符打断分组
    }
    pos += d.divisions;
  }
  for (const g of groups) {
    if (g.length < 2) continue;
    const maxLevel = Math.max(...g.map((n) => n.div));
    for (let level = 1; level <= maxLevel; level++) {
      let i = 0;
      while (i < g.length) {
        if (g[i].div < level) { i++; continue; }
        let j = i;
        while (j + 1 < g.length && g[j + 1].div >= level) j++;
        // 简谱的减时线是画在休止符下面的（`5_ 0_ 3_` 下划线一路连过去），但五线谱的符杠
        // 挂不到休止符上——休止符没有符干。所以段内只有**实音符**承载 begin/continue/end，
        // 休止符被跨过（这正是五线谱 beam over rest 的写法，与原图观感一致）。
        const solid: JpNum[] = [];
        for (let k = i; k <= j; k++) if (g[k].digit !== 0) solid.push(g[k]);
        const put = (n: JpNum, st: string) => {
          const mm = out.get(n) ?? new Map<number, string>();
          mm.set(level, st);
          out.set(n, mm);
        };
        if (solid.length >= 2) {
          put(solid[0], "begin");
          for (let k = 1; k < solid.length - 1; k++) put(solid[k], "continue");
          put(solid[solid.length - 1], "end");
        } else if (solid.length === 1 && level > 1) {
          // 第 1 层就孤零零一个音符时它根本不成组（写成带符尾的单音即可）；
          // 更高层单独出现才是 hook（低层已经把它连进组里了）。
          put(solid[0], i > 0 ? "backward hook" : "forward hook");
        }
        i = j + 1;
      }
    }
  }
  return out;
}

function beamXml(beams: Map<number, string> | undefined): string {
  if (!beams) return "";
  return [...beams.entries()].sort((a, b) => a[0] - b[0])
    .map(([lv, v]) => `<beam number="${lv}">${v}</beam>`).join("");
}

// MusicXML 3.0 的 note 子元素顺序：(pitch|rest), duration, tie*, voice?, type?, dot*,
// time-modification?, …, beam*, notations*, lyric*。改这里务必守住这个顺序。
function noteXml(num: JpNum, fifths: number, arcs: ArcPairs, beams?: Map<number, string>): string {
  const d = durationOf(num);
  if (num.digit === 0) {
    // 休止符也要出 <notations>：圆滑线的一端落在休止符上是常有的事，早先这里直接 return
    // 把它丢了，弧线只剩半条，MuseScore 就一路拖到下一条 slur 那里去。
    return `<note><rest/><duration>${d.divisions}</duration><voice>1</voice>` +
      `<type>${d.type}</type>${"<dot/>".repeat(d.dots)}${notationsXml(num, arcs)}</note>`;
  }
  const p = pitchOf(num, fifths);
  const alterXml = p.alter ? `<alter>${p.alter}</alter>` : "";
  // <tie> 是播放语义（延音线要真的连起来），<tied> 是记号，规范要求两者齐全。
  const ti = arcs.tie.get(num);
  const ties = (ti?.stop ? `<tie type="stop"/>` : "") + (ti?.start ? `<tie type="start"/>` : "");
  return `<note><pitch><step>${p.step}</step>${alterXml}<octave>${p.octave}</octave></pitch>` +
    `<duration>${d.divisions}</duration>${ties}<voice>1</voice>` +
    `<type>${d.type}</type>${"<dot/>".repeat(d.dots)}` +
    `${beamXml(beams)}${notationsXml(num, arcs)}${lyricsXml(num)}</note>`;
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

// 一行是否以小节线收尾（最后一个音符右侧仍有小节线）。否→末小节是"开口"的，
// 即该小节跨行延续到下一行行首（弱起/续句），换行处图上本就没有小节线，不可补。
function rowEndsClosed(row: StaffRow): boolean {
  if (!row.nums.length || !row.barlineXs.length) return false;
  const lastRight = rright(row.nums[row.nums.length - 1].bbox);
  return Math.max(...row.barlineXs) >= lastRight;
}

/** 跳转记号 → MusicXML `<sound>` 属性。下游 score/musicxml.ts::parseSound 读的就是这些。 */
const JUMP_SOUND: Record<string, string> = {
  "D.C.": 'dacapo="yes"',
  "D.S.": 'dalsegno="1"',
  "Fine": 'fine="yes"',
  "To Coda": 'tocoda="1"',
};

/** 识别阶段把反复/房号锚到边界相邻音符；这里提升成 MusicXML 小节线结构。 */
function structuralBarlineXml(notes: JpNum[], location: "left" | "right"): string {
  if (location === "left") {
    const ending = notes.find((n) => n.endingStart !== undefined)?.endingStart;
    const repeat = notes.some((n) => n.repeatForward);
    if (ending === undefined && !repeat) return "";
    return `<barline location="left">${repeat ? "<bar-style>heavy-light</bar-style>" : ""}` +
      `${ending !== undefined ? `<ending number="${ending}" type="start"/>` : ""}` +
      `${repeat ? "<repeat direction=\"forward\"/>" : ""}</barline>`;
  }
  const ending = [...notes].reverse().find((n) => n.endingStop !== undefined)?.endingStop;
  const repeat = notes.some((n) => n.repeatBackward);
  if (ending === undefined && !repeat) return "";
  return `<barline location="right">${repeat ? "<bar-style>light-heavy</bar-style>" : ""}` +
    `${ending !== undefined ? `<ending number="${ending}" type="stop"/>` : ""}` +
    `${repeat ? "<repeat direction=\"backward\"/>" : ""}</barline>`;
}

export function toMusicXml(score: RecognizedScore): string {
  // 遵照图片小节线：行末无小节线时（开口收尾），本行末小节与下一行行首小节实为同一跨行小节，合并，
  // 不在换行处凭空补小节线。行末有小节线（如终止线）才各自成节。
  // 记录每个 row 在 allMeasures 中「干净起始」的小节下标（>0 才记），供输出 <print new-system>
  // 以恢复原图分行。若本行首小节被并入上一行的跨行小节（open-tail），则视觉行首落在小节内部，
  // 无法在小节边界干净断行 → 不记（与「开口不补小节线」一致）。
  const allMeasures: JpNum[][] = [];
  const rowStartIdx = new Set<number>();
  let openTail = false;
  for (const row of score.rows) {
    const ms = measuresOfRow(row);
    if (!ms.length) continue;
    if (openTail && allMeasures.length) allMeasures[allMeasures.length - 1].push(...ms.shift()!);
    else if (allMeasures.length) rowStartIdx.add(allMeasures.length);
    allMeasures.push(...ms);
    openTail = !rowEndsClosed(row);
  }

  // 弧线配对要按**输出顺序**在全曲范围内做（跨小节的弧才配得上）。
  const arcs = pairArcs(allMeasures.flat(), score.fifths);


  let mi = 0;
  const measuresXml = allMeasures.map((notes, idx) => {
    mi++;
    const printEl = rowStartIdx.has(idx) ? `<print new-system="yes"/>` : "";
    const attrs = mi === 1
      ? `<attributes><divisions>${QUARTER}</divisions><key><fifths>${score.fifths}</fifths></key>` +
        `<time><beats>${score.beats}</beats><beat-type>${score.beatType}</beat-type></time>` +
        `<clef><sign>G</sign><line>2</line></clef></attributes>`
      : "";
    // 速度记号置于首小节（♩=NN）。下游导入器暂不读 tempo，仅供 MusicXML 完整性。
    const tempoEl = mi === 1 && score.tempo
      ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>` +
        `<per-minute>${score.tempo}</per-minute></metronome></direction-type>` +
        `<sound tempo="${score.tempo}"/></direction>`
      : "";
    // 段落标记（Intro/Verse/Chorus/Coda…）：识别时标在该段首音符上 → 本小节开头的 <direction>。
    // 下游 score/musicxml.ts 收进 Measure.sectionMark，乐句排版据此按段落断行。
    const mark = notes.find((n) => n.sectionMark)?.sectionMark;
    const markEl = mark
      ? `<direction placement="above"><direction-type><words>${escapeXml(mark)}</words></direction-type></direction>`
      : "";
    // 跳转记号（D.C./D.S./Fine/To Coda）：识别时锚在本小节某音符上 → 小节末的 <direction>，
    // 带 <sound> 属性供 score.ts 的 RepeatProcessor 展开演唱顺序。
    const jump = notes.find((n) => n.jumpMark)?.jumpMark;
    const jumpEl = jump
      ? `<direction placement="above"><direction-type><words>${escapeXml(jump)}</words></direction-type>` +
        `<sound ${JUMP_SOUND[jump] ?? 'dacapo="yes"'}/></direction>`
      : "";
    // 符杠按拍分组：8 分拍号（6/8 等）一组是 3 个八分，其余一拍一组。
    const beatDiv = score.beatType === 8 ? QUARTER * 3 / 2 : QUARTER * 4 / score.beatType;
    const beams = beamsOfMeasure(notes, beatDiv);
    // 和弦符号：MusicXML 要求 <harmony> 紧接其所辖音符**之前**。chordOffset 是本音符时值内的
    // 比例（和弦印在两音符之间的拍点上时非 0），这里折成 divisions 交给 <offset>。
    const noteEls = notes.map((n) => {
      const harm = n.chord
        ? harmonyXml(n.chord, Math.round((n.chordOffset ?? 0) * durationOf(n).divisions))
        : "";
      return harm + noteXml(n, score.fifths, arcs, beams.get(n));
    }).join("");
    const leftBar = structuralBarlineXml(notes, "left");
    const rightBar = structuralBarlineXml(notes, "right");
    return `<measure number="${mi}">${printEl}${attrs}${leftBar}${tempoEl}${markEl}${noteEls}${jumpEl}${rightBar}</measure>`;
  }).join("");

  const workXml = score.title ? `<work><work-title>${escapeXml(score.title)}</work-title></work>` : "";
  // 著作者整行（作词：…/作曲：…）作为 credit；下游 jpscore 据此拼 WordsByAndMusicBy。
  const creditsXml = (score.credits ?? [])
    .map((c) => `<credit page="1"><credit-words>${escapeXml(c)}</credit-words></credit>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.0">
${workXml}${creditsXml}<part-list><score-part id="P1"><part-name print-object="no"></part-name></score-part></part-list>
<part id="P1">${measuresXml}</part>
</score-partwise>`;
}
