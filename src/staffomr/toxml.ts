// 识别结果 → MusicXML。对应 musicpp `qtomr/toxml.cpp::Score::exportXml`。
//
// 字符串拼装一律复用 `src/score/xmlutil.ts`（escape / 外壳 / `<barline>` 子元素顺序），
// **别在这里另写一套** ——那份是简谱导出、文本谱导出与本文件的公共件。
import { barlineXml, escapeXml, scorePartXml, workXml, wrapPartwise } from "../score/xmlutil";
import { harmonyXml } from "../score/harmonyxml";
import type { StaffNote } from "./notedata";
import { keyFifths, timeSignatures, type StaffContext } from "./notedata";
import { Bar, type Staff } from "./model";
import type { StaffScore } from "./score";

/** 一行谱在一页上的识别结果，拼成一首曲子要按「系统顺序」把这些串起来。 */
export interface StaffLineResult {
  staff: Staff;
  ctx: StaffContext | undefined;
  notes: StaffNote[];
}

export interface StaffXmlOptions {
  title?: string;
  /** 每四分音符多少 tick。取 24 能整除 2/3/4/6/8 分音符与三连音。 */
  divisions?: number;
  partId?: string;
}

const TYPE_OF: [number, string][] = [
  [2, "breve"],
  [1, "whole"],
  [1 / 2, "half"],
  [1 / 4, "quarter"],
  [1 / 8, "eighth"],
  [1 / 16, "16th"],
  [1 / 32, "32nd"],
  [1 / 64, "64th"],
];

/** 基本时值（全音符 = 1）→ MusicXML 的 `<type>`。取最接近的一档。 */
export function noteType(base: number): string {
  let best = "quarter";
  let bd = Infinity;
  for (const [v, name] of TYPE_OF) {
    const d = Math.abs(Math.log2(v) - Math.log2(base || 1 / 4));
    if (d < bd) {
      bd = d;
      best = name;
    }
  }
  return best;
}

/**
 * 一首曲子（按系统顺序排好的若干行谱）→ MusicXML。
 *
 * 小节由**已认的小节线**切开（`Staff.bars`）。谱面上的一行谱可能只有半个小节
 * （跨行的小节），这里不做跨行合并——那是 `Score::connectSystems` 那一层的事，
 * 尚未移植，故行末与行首各算一个小节，`<measure number>` 顺序编号。
 */
export function toMusicXml(lines: StaffLineResult[], opts: StaffXmlOptions = {}): string {
  const divisions = opts.divisions ?? 24;
  const partId = opts.partId ?? "P1";
  const ticks = (dur: number) => Math.max(1, Math.round(dur * 4 * divisions));

  let body = "";
  let measureNo = 0;
  let prevFifths: number | null = null;
  let prevTime: string | null = null;
  let prevClef: string | null = null;

  for (const line of lines) {
    const { staff, ctx, notes } = line;
    // 拍号**逐小节**生效：一行谱上可能变拍好几次（见 notedata.ts::timeSignatures）
    const timeChanges = timeSignatures(ctx?.time ?? [], staff.stepDistance() * 2);
    let tc = 0;
    // 一行谱一个小节都没切出来时（谱线找到了但没认出小节线），整行当一个小节
    const bars: Bar[] = staff.bars.length ? staff.bars : [Object.assign(new Bar(staff), { left: staff.box.left, right: staff.box.right })];
    for (let bi = 0; bi < bars.length; bi++) {
      const bar = bars[bi];
      const inBar = notes.filter((n) => n.x >= bar.left && n.x < bar.right);
      measureNo++;
      let attrs = "";
      if (measureNo === 1) attrs += `<divisions>${divisions}</divisions>`;
      const fifths = ctx ? keyFifths(ctx.key) : 0;
      if (bi === 0 && ctx && fifths !== prevFifths) {
        attrs += `<key><fifths>${fifths}</fifths></key>`;
        prevFifths = fifths;
      }
      while (tc < timeChanges.length && timeChanges[tc].x < bar.right) {
        const t = timeChanges[tc++];
        const key = `${t.beats}/${t.beatType}`;
        if (key !== prevTime) {
          attrs += `<time><beats>${t.beats}</beats><beat-type>${t.beatType}</beat-type></time>`;
          prevTime = key;
        }
      }
      const clef = ctx?.clef ? clefXml(ctx.clef.code) : null;
      if (bi === 0 && clef && clef !== prevClef) {
        attrs += clef;
        prevClef = clef;
      }
      body += `<measure number="${measureNo}">`;
      if (attrs) body += `<attributes>${attrs}</attributes>`;
      // 正向反复（`|:`）挂在小节的**左端**
      body += barlineXml("left", { repeat: bar.leftRepeat, ending: bar.endingStart ? bar.endingNumber : null });
      // 一行谱上写两个声部时要分开写，中间用 `<backup>` 把时间倒回小节头
      const voices = [...new Set(inBar.map((n) => n.voice))].sort();
      voices.forEach((v, vi) => {
        let used = 0;
        for (const n of inBar) {
          if (n.voice !== v) continue;
          // `<harmony>` 与 `<direction>` 都排在它们所属的 `<note>` **之前**（MusicXML 规定）
          if (n.chord) body += harmonyXml(n.chord);
          if (n.dynamic) body += `<direction placement="below"><direction-type><dynamics><${n.dynamic}/></dynamics></direction-type></direction>`;
          body += noteXml(n, ticks(n.duration), 0, voices.length > 1);
          if (!n.chordExtra) used += ticks(n.duration);
        }
        if (vi < voices.length - 1 && used > 0) body += `<backup><duration>${used}</duration></backup>`;
      });
      // 终止线/复纵线/反向反复（`:|`）挂在小节的**右端**
      body += barlineXml("right", {
        style: bar.rightStyle,
        repeat: bar.rightRepeat,
        ending: bar.endingStop ? bar.endingNumber : null,
      });
      body += `</measure>`;
    }
  }

  return wrapPartwise({
    work: workXml(opts.title),
    partList: scorePartXml(partId),
    body: `<part id="${partId}">${body}</part>`,
  });
}

function noteXml(n: StaffNote, dur: number, staffNo = 0, withVoice = false): string {
  const type = noteType(n.base);
  const dots = "<dot/>".repeat(n.dots);
  // `<staff>` 排在 `<notations>` 之前、`<stem>` 之后（MusicXML 的子元素顺序）
  const staffEl = staffNo ? `<staff>${staffNo}</staff>` : "";
  // `<voice>` 排在 `<duration>`/`<tie>` 之后、`<type>` 之前
  const voiceEl = withVoice ? `<voice>${n.voice}</voice>` : "";
  if (n.rest)
    return `<note><rest/><duration>${dur}</duration>${voiceEl}<type>${type}</type>${dots}${staffEl}</note>`;
  // `<chord/>` 必须是 `<note>` 的**第一个**子元素
  const chord = n.chordExtra ? "<chord/>" : "";
  // `<alter>` 是**发声**的升降（含调号），`<accidental>` 是谱面上**印出来**的那个记号。
  // 两者不是一回事：G 调里一个没印记号的 F 也要写 `<alter>1</alter>`。
  const alter = n.alter !== 0 ? `<alter>${n.alter}</alter>` : "";
  const acc = n.accidental !== null ? `<accidental>${accidentalName(n.accidental)}</accidental>` : "";
  const stem = n.stemUp === null ? "" : `<stem>${n.stemUp ? "up" : "down"}</stem>`;
  // `<lyric>` 是 `<note>` 的最后一批子元素，排在 `<stem>`/`<accidental>` 之后
  const lyric = (n.lyrics ?? []).map((l) => lyricXml(l)).join("");
  // `<notations>` 排在 `<lyric>` 之前（MusicXML 的子元素顺序）
  const nots: string[] = [];
  if (n.tieStop) nots.push(`<tied type="stop"/>`);
  if (n.tieStart) nots.push(`<tied type="start"/>`);
  if (n.slurStop) nots.push(`<slur type="stop" number="1"/>`);
  if (n.slurStart) nots.push(`<slur type="start" number="1"/>`);
  if (n.tuplet) nots.push(`<tuplet type="start"/>`);
  // `<notations>` 里子元素有固定次序：tied / slur / tuplet / ornaments / articulations / fermata
  const arts: string[] = [];
  const orns: string[] = [];
  let fermata = "";
  for (const m of n.marks ?? []) {
    const a = ARTICULATION[m];
    if (a) {
      arts.push(a);
      continue;
    }
    if (m.startsWith("fermata")) fermata = `<fermata type="${m === "fermataBelow" ? "inverted" : "upright"}"/>`;
    else if (m.startsWith("ornamentTrill") || m.startsWith("wiggleTrill")) orns.push(`<trill-mark/>`);
  }
  if (orns.length) nots.push(`<ornaments>${orns.join("")}</ornaments>`);
  if (arts.length) nots.push(`<articulations>${arts.join("")}</articulations>`);
  if (fermata) nots.push(fermata);
  const notations = nots.length ? `<notations>${nots.join("")}</notations>` : "";
  const timeMod = n.tuplet
    ? `<time-modification><actual-notes>${n.tuplet.actual}</actual-notes><normal-notes>${n.tuplet.normal}</normal-notes></time-modification>`
    : "";
  // `<tie>` 是发声用的（与 `<tied>` 的图形标记分开写，MusicXML 两者都要）
  const tie = (n.tieStop ? `<tie type="stop"/>` : "") + (n.tieStart ? `<tie type="start"/>` : "");
  // 斜杠符头（前奏/间奏的「照这个节奏弹和弦」）：音高留着（它就画在第三线上），
  // 但要把符头形状写出来，不然回读时会变成一串真的 B4。`<notehead>` 排在 `<stem>` 之后、
  // `<staff>` 之前——MusicXML 的子元素次序是有规定的。
  const head = n.slash ? `<notehead>slash</notehead>` : "";
  return (
    `<note>${chord}<pitch><step>${escapeXml(n.step)}</step>${alter}<octave>${n.octave}</octave></pitch>` +
    `<duration>${dur}</duration>${tie}${voiceEl}<type>${type}</type>${dots}${acc}${timeMod}${stem}${head}${staffEl}${notations}${lyric}</note>`
  );
}

/** SMuFL 演奏法名 → MusicXML 的 `<articulations>` 子元素。 */
const ARTICULATION: Record<string, string> = {
  articAccentAbove: "<accent/>",
  articAccentBelow: "<accent/>",
  articStaccatoAbove: "<staccato/>",
  articStaccatoBelow: "<staccato/>",
  articTenutoAbove: "<tenuto/>",
  articTenutoBelow: "<tenuto/>",
  articStaccatissimoAbove: "<staccatissimo/>",
  articStaccatissimoBelow: "<staccatissimo/>",
  articMarcatoAbove: "<strong-accent/>",
  articMarcatoBelow: "<strong-accent/>",
  articAccentStaccatoAbove: "<accent/><staccato/>",
  articAccentStaccatoBelow: "<accent/><staccato/>",
  articTenutoStaccatoAbove: "<tenuto/><staccato/>",
  articTenutoStaccatoBelow: "<tenuto/><staccato/>",
  breathMarkComma: "<breath-mark/>",
  caesura: "<caesura/>",
};

/** 单个 `<lyric>`。
 *  不复用 `xmlutil.ts::lyricElementXml`：那份把 `<syllabic>` 写死成 `single`（简谱逐字挂词，
 *  没有词内断音节这回事），五线谱的拉丁歌词要区分 `begin`/`end`。 */
function lyricXml(l: { verse: number; text: string; hyphen: boolean }): string {
  const syllabic = l.hyphen ? "begin" : "single";
  return `<lyric number="${l.verse}"><syllabic>${syllabic}</syllabic><text>${escapeXml(l.text)}</text></lyric>`;
}

function accidentalName(alter: number): string {
  switch (alter) {
    case -2:
      return "flat-flat";
    case -1:
      return "flat";
    case 1:
      return "sharp";
    case 2:
      return "double-sharp";
    default:
      return "natural";
  }
}

/** SMuFL 谱号名 → `<clef>`。 */
export function clefXml(code: string): string {
  switch (code) {
    case "fClef":
      return `<clef><sign>F</sign><line>4</line></clef>`;
    case "fClef8vb":
      return `<clef><sign>F</sign><line>4</line><clef-octave-change>-1</clef-octave-change></clef>`;
    case "cClef":
      return `<clef><sign>C</sign><line>3</line></clef>`;
    case "gClef8vb":
      return `<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>`;
    case "gClef8va":
      return `<clef><sign>G</sign><line>2</line><clef-octave-change>1</clef-octave-change></clef>`;
    case "unpitchedPercussionClef1":
    case "unpitchedPercussionClef2":
      return `<clef><sign>percussion</sign></clef>`;
    default:
      return `<clef><sign>G</sign><line>2</line></clef>`;
  }
}


// ── 按声部导出 ──────────────────────────────────────────────────────────────

/**
 * 整首曲子（跨页、可含多谱表声部）→ MusicXML。
 *
 * 与 `toMusicXml` 的分工：那份把「一串谱行」当单声部串起来（领唱谱够用）；
 * 这份走 `score.ts` 认出来的 `Part`/`ScoreStaff` 结构，
 * **钢琴谱的两行会合成一个 `<part>`**（`<staves>2` + 每个音符带 `<staff>`），
 * 而不是丢掉伴奏那行。
 */
export function scoreToMusicXml(
  score: StaffScore,
  notesOf: (staff: Staff) => StaffNote[],
  opts: StaffXmlOptions = {},
): string {
  const divisions = opts.divisions ?? 24;
  const ticks = (dur: number) => Math.max(1, Math.round(dur * 4 * divisions));

  const partList: string[] = [];
  const bodies: string[] = [];
  score.parts.forEach((part, pi) => {
    const id = `P${pi + 1}`;
    partList.push(scorePartXml(id));
    let body = "";
    let measureNo = 0;
    let prevFifths: number | null = null;
    let prevTime: string | null = null;
    let prevClef: string[] = [];

    score.systems.forEach((entry, si) => {
      // 这个声部在这一系统里的各行谱（隐藏的为 null）
      const staves = part.scoreStaves.map((ss) => ss.staves[si]);
      const lead = staves.find((x) => x) ?? null;
      if (!lead) return;
      const barCount = Math.max(...staves.map((st) => st?.bars.length ?? 0));
      const ctx = entry.ctx.get(lead);
      const timeChanges = timeSignatures(ctx?.time ?? [], lead.stepDistance() * 2);
      let tc = 0;

      for (let bi = 0; bi < barCount; bi++) {
        measureNo++;
        let attrs = "";
        if (measureNo === 1) attrs += `<divisions>${divisions}</divisions>`;
        const fifths = ctx ? keyFifths(ctx.key) : 0;
        if (bi === 0 && ctx && fifths !== prevFifths) {
          attrs += `<key><fifths>${fifths}</fifths></key>`;
          prevFifths = fifths;
        }
        const bar0 = lead.bars[bi];
        while (bar0 && tc < timeChanges.length && timeChanges[tc].x < bar0.right) {
          const t = timeChanges[tc++];
          const k = `${t.beats}/${t.beatType}`;
          if (k !== prevTime) {
            attrs += `<time><beats>${t.beats}</beats><beat-type>${t.beatType}</beat-type></time>`;
            prevTime = k;
          }
        }
        if (bi === 0) {
          // 多谱表声部：`<staves>` 与逐谱表的 `<clef number=n>`
          const clefs = staves.map((st) => (st ? clefXml(entry.ctx.get(st)?.clef?.code ?? "gClef") : ""));
          if (clefs.join("|") !== prevClef.join("|")) {
            if (staves.length > 1) attrs += `<staves>${staves.length}</staves>`;
            clefs.forEach((c, k) => {
              if (!c) return;
              attrs += staves.length > 1 ? c.replace("<clef>", `<clef number="${k + 1}">`) : c;
            });
            prevClef = clefs;
          }
        }
        body += `<measure number="${measureNo}">`;
        if (attrs) body += `<attributes>${attrs}</attributes>`;
        if (bar0)
        body += barlineXml("left", {
          repeat: bar0.leftRepeat,
          ending: bar0.endingStart ? bar0.endingNumber : null,
        });

        staves.forEach((st, k) => {
          if (!st) return;
          const bar = st.bars[bi];
          if (!bar) return;
          const inBar = notesOf(st).filter((n) => n.x >= bar.left && n.x < bar.right);
          const voices = [...new Set(inBar.map((n) => n.voice))].sort();
          let used = 0;
          voices.forEach((v, vi) => {
            let vUsed = 0;
            for (const n of inBar) {
              if (n.voice !== v) continue;
              if (n.chord) body += harmonyXml(n.chord);
              if (n.dynamic)
                body += `<direction placement="below"><direction-type><dynamics><${n.dynamic}/></dynamics></direction-type></direction>`;
              body += noteXml(n, ticks(n.duration), staves.length > 1 ? k + 1 : 0, voices.length > 1);
              if (!n.chordExtra) vUsed += ticks(n.duration);
            }
            if (vi < voices.length - 1 && vUsed > 0) body += `<backup><duration>${vUsed}</duration></backup>`;
            used = Math.max(used, vUsed);
          });
          // 换到下一行谱之前要把时间**倒回**小节头（MusicXML 的 `<backup>`）
          if (k < staves.length - 1 && used > 0) body += `<backup><duration>${used}</duration></backup>`;
        });

        if (bar0)
          body += barlineXml("right", {
            style: bar0.rightStyle,
            repeat: bar0.rightRepeat,
            ending: bar0.endingStop ? bar0.endingNumber : null,
          });
        body += `</measure>`;
      }
    });
    bodies.push(`<part id="${id}">${body}</part>`);
  });

  return wrapPartwise({
    work: workXml(opts.title),
    partList: partList.join(""),
    body: bodies.join("\n"),
  });
}
