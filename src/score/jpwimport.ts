// Ported from JpwImport (mp/score/jpw.kt lines 13-340).
// Builds a Score from a parsed .jpwabc JpwFile (the .jpwabc edit path).

import { Fraction } from "../common/fraction";
import {
  JpwFile,
  RepeatSection,
  VoiceSection,
  WordsSection,
  WordsSegment,
} from "../jpword/jpwfile";
import type { NoteContext } from "../jpword/parser/JpwabcParser";
import {
  BarStyle,
  BarlineEntry,
  Chord,
  Credit,
  doPairTuplet,
  Key,
  LineBreak,
  Measure,
  MusicCommon,
  Note,
  Lyric,
  Part,
  PlayItem,
  RepeatSpec,
  Score,
  Time,
} from "./score";
import { applyJpPitch, type JpKeyState } from "./jppitch";

class JpState implements JpKeyState {
  inTuplet = false;
  alter: Record<string, number> = {};
  basePitch = 0;
  fifths = 0;
}

function unescape(str: string): string {
  return str.replace(/\\n/g, "\n");
}

function makeChord(note: NoteContext, mea: Measure, stat: JpState): Chord {
  const res = new Chord(mea);
  res.beats = 1;
  const nt = new Note(res);
  res.add(nt);
  let txt = note.Note().getText();
  let acc = "";
  const tupletText = "{(3}";
  if (txt.includes(tupletText)) {
    if (stat.inTuplet) throw new Error("");
    nt.tupletBegin = true;
    stat.inTuplet = true;
    txt = txt.replace(tupletText, "");
  }
  // 演奏记号 {DunYin|BoYin|YanYin|ZhongYin}（Jpwabc.g4 Articulation）。目前仅渲染延音(fermata)。
  const artMatch = txt.match(/\{(?:DunYin|BoYin|YanYin|ZhongYin)(?:,(?:DunYin|BoYin|YanYin|ZhongYin))*\}/);
  if (artMatch) {
    if (artMatch[0].includes("YanYin")) res.fermata = true;
    txt = txt.replace(artMatch[0], "");
  }
  for (const ch of txt) {
    if (ch >= "0" && ch <= "9") {
      nt.number = ch;
      switch (acc) {
        case "#": nt.jpAlter = "#"; break;
        case "b": nt.jpAlter = "b"; break;
        case "#b": nt.jpAlter = "n"; break;
      }
      continue;
    }
    switch (ch) {
      case ",": nt.jpOctave -= 1; break;
      case "'": nt.jpOctave++; break;
      case "_": res.beams += 1; break;
      case "-": res.beats++; break;
      case ".": res.dot++; break;
      case "#":
      case "b": acc += ch; break;
      case "(": res.slurStart = true; break;
      case ")":
        if (stat.inTuplet) {
          stat.inTuplet = false;
          nt.tupletEnd = true;
        } else {
          res.slurEnd = true;
        }
        break;
      default: console.log(ch);
    }
  }
  applyJpPitch(stat, nt);
  let dur = new Fraction(res.beats);
  if (res.dot > 0) {
    dur = dur.timesInt(3);
    dur = dur.divInt(2);
  }
  if (stat.inTuplet) {
    dur = dur.timesInt(2);
    dur = dur.divInt(3);
  }
  dur = dur.divInt(1 << res.beams);
  res.duration = dur;
  return res;
}

function updateTimeInf(p: Part): void {
  let pos = new Fraction(0);
  for (const m of p.measures) {
    m.position = pos;
    let mpos = new Fraction(0);
    for (const ent of m.entries) {
      ent.position = mpos;
      if (!(ent instanceof Chord)) {
        ent.duration = new Fraction(0);
        continue;
      }
      const ch = ent;
      let dur = new Fraction(ch.beats);
      dur = dur.divInt(1 << ch.beams);
      if (ch.dot === 1) {
        dur = dur.timesInt(3);
        dur = dur.divInt(2);
      }
      let tuplet = null;
      for (const nt of ch.notes) {
        if (nt.tuplet !== null) {
          tuplet = nt.tuplet;
          break;
        }
      }
      if (tuplet !== null) {
        dur = dur.timesInt(2);
        dur = dur.divInt(3);
      }
      ch.duration = dur;
      mpos = mpos.plus(dur);
    }
    pos = pos.plus(mpos);
  }
}

function makePart(sec: VoiceSection, key: Key, ts: Time): Part {
  const res = new Part();
  const data = sec.voiceData;
  let mea: Measure | null = null;
  let newMeasure = false;
  let slurStart: Chord | null = null;
  const stat = new JpState();
  stat.basePitch = MusicCommon.getBasePitchOfKey(key);
  stat.fifths = key.fifths;
  const tupNotes: Note[] = [];
  let mid = 0;

  for (const e of data.entry_list()) {
    const noteCtx = e.note();
    const barlineCtx = e.barline();
    const linebreakCtx = e.linebreak();
    if (noteCtx) {
      if (mea === null || newMeasure) {
        mea = new Measure(mid);
        mid++;
        res.measures.push(mea);
        newMeasure = false;
      }
      const chord = makeChord(noteCtx, mea, stat);
      const nt = chord.notes[0];
      if (nt.tupletEnd || nt.tupletBegin) tupNotes.push(nt);
      if (chord.slurStart) {
        slurStart = chord;
      } else if (chord.slurEnd) {
        if (slurStart !== null) slurStart.slurEndChord = chord;
        slurStart = null;
      }
      mea.entries.push(chord);
    } else if (barlineCtx) {
      const ent = new BarlineEntry(mea!);
      const txt = barlineCtx.Barline().getText();
      switch (txt) {
        case "|": ent.style = BarStyle.REGULAR; break;
        case "|]": ent.style = BarStyle.LIGHT_HEAVY; break;
        case "[|]": ent.style = BarStyle.NONE; break;
        case "||": ent.style = BarStyle.LIGHT_LIGHT; break;
        // 反复线另记 ent.repeat：`:|` 与终止线 `|]` 的 style 相同，只看 style 分不开。
        case "|:": ent.style = BarStyle.HEAVY_LIGHT; ent.repeat = "forward"; break;
        case ":|": ent.style = BarStyle.LIGHT_HEAVY; ent.repeat = "backward"; break;
        default: throw new Error(`bad barline: ${txt}`);
      }
      mea!.entries.push(ent);
      newMeasure = true;
      stat.alter = {};
    } else if (linebreakCtx) {
      const ret = linebreakCtx.Return().getText();
      const args = substringBefore(substringAfter(ret, "("), ")").split(",");
      let pg = false;
      if (args.length >= 4) pg = args[3].toLowerCase() === "true";
      mea?.lineBreak(pg);
    }
    // TextContext / TimesigContext / prelude: ignored (as in original)
  }

  doPairTuplet(tupNotes);
  updateTimeInf(res);
  // 调号与拍号都要写进小节：原先只写了 `time`，`Measure.key` 一直是默认的 C，
  // 于是「排版 → 简谱」纸顶那块调号（painter.ts::keyMeter）永远印成 `1=C`。
  // `keyChange` 不动——那是曲中转调的标志，首调不该冒出一个「转1=X」。
  for (const m of res.measures) {
    m.time = ts;
    m.key = key;
  }
  return res;
}

export function fromJpw(f: JpwFile): Score | null {
  const res = new Score();
  const title = f.getTitle();
  res.title = unescape(title?.title ?? "");
  const key = title?.key ?? "C";
  const author = title?.wordsMusicBy ?? null;
  if (author !== null) {
    const cred = new Credit();
    cred.text = unescape(author);
    // page 是 0 基的页号（MusicXML 导入端也是 attr−1）。原先写 1 与 jpscore.ts 只收 page===0
    // 的判据对不上，`.jpwabc → Score → .jpwabc` 的作者行会整条丢掉，导出的 MusicXML 里
    // 词曲也会落到第 2 页。
    cred.page = 0;
    res.credit.push(cred);
  }
  res.playData.tempo = title?.tempo ?? 0;
  const tm = title?.meter ?? "4/4";
  const tmArr = tm.split("/");
  const ts = new Time();
  ts.beatType = parseInt(tmArr[1], 10);
  ts.beats = parseInt(tmArr[0], 10);
  const kk = new Key();
  kk.fifths = MusicCommon.keyNameToFifth(key);
  const part = makePart(f.getVoice()!, kk, ts);
  const lrc = f.getLyric();
  let pass = 0;
  if (lrc !== null) {
    assignLrcSection(part, lrc);
    for (const it of lrc.segments) pass = Math.max(pass, it.passLast);
  }
  res.parts.push(part);
  processRepeat(res, part, pass, f.getSection(RepeatSection));
  return res;
}

function processRepeat(
  res: Score,
  part: Part,
  pass: number,
  rep: RepeatSection | null,
): void {
  if (rep === null) {
    for (let pp = 0; pp < pass; pp++) {
      const p = new PlayItem();
      p.pass = 1 + pp;
      p.mid = 0;
      p.end = part.measures.length;
      res.playData.measures.push(p);
    }
    res.playData.isSimpple = true;
  } else {
    const ss = rep.data.join("\n");
    const spec = new RepeatSpec(ss);
    res.doRepeat(spec);
  }
}

function assignLrcSeg(part: Part, seg: WordsSegment): void {
  const notes: Note[] = [];
  let mid = 0;
  for (const m of part.measures) {
    mid++;
    let nid = 0;
    for (const ent of m.entries) {
      if (ent instanceof LineBreak) {
        if (ent !== m.entries[m.entries.length - 1]) {
          mid++;
          nid = 0;
        }
        continue;
      }
      if (!(ent instanceof Chord)) continue;
      nid++;
      if (mid < seg.measure) continue;
      if (mid === seg.measure && nid < seg.noteIndex) continue;
      notes.push(ent.notes[0]);
    }
  }
  let idx = 0;
  for (const it of seg.data) {
    if (idx >= notes.length) break;
    for (let pass = seg.passFirst; pass <= seg.passLast; pass++) {
      const lrc = new Lyric();
      lrc.number = pass;
      if (it.text.length > 0) {
        lrc.text = it.text;
        notes[idx].lyrics.push(lrc);
      }
    }
    idx++;
  }
}

function assignLrcSection(part: Part, sec: WordsSection): void {
  for (const seg of sec.segments) assignLrcSeg(part, seg);
}

// Kotlin substringAfter/substringBefore semantics.
function substringAfter(s: string, delim: string): string {
  const i = s.indexOf(delim);
  return i < 0 ? s : s.substring(i + delim.length);
}
function substringBefore(s: string, delim: string): string {
  const i = s.indexOf(delim);
  return i < 0 ? s : s.substring(0, i);
}
