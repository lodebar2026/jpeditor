// `.jpwabc` → 简谱引擎的输入树 `Score`（编辑器 `.jpwabc` 谱面、帮助页样例用）。
// 原文只读一遍：切源文小节、落歌词那一步与 `jpwToScoreDoc` 共用（`model/fromjpw.ts::readJpwSource`），
// 这里只把源文小节一一落成引擎的小节。原先这里自己走一遍语法树（照 mp/score/jpw.kt 移植），
// R2 阶段 9 换成共用那一步，删前两路双跑 500 首 568 份 + testdata 14 份整棵树逐项一致（`score-dual-check.mjs --jpw`）。

import { Fraction } from "../common/fraction";
import { JpwFile, RepeatSection } from "../jpword/jpwfile";
import {
  BarStyle,
  BarlineEntry,
  Chord,
  Credit,
  doPairTuplet,
  Key,
  Measure,
  Note,
  Lyric,
  Part,
  Score,
  Time,
} from "./score";
import { readJpwSource, type SrcMeasure } from "../model/fromjpw";
import { RepeatSpec, playOrderByVerses, playOrderFromSpec } from "./playorder";

function unescape(str: string): string {
  return str.replace(/\\n/g, "\n");
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

function processRepeat(
  res: Score,
  part: Part,
  pass: number,
  rep: RepeatSection | null,
): void {
  if (rep === null) {
    res.playData.measures = playOrderByVerses(part.measures.length, pass);
    res.playData.isSimpple = true;
  } else {
    res.playData.measures = playOrderFromSpec(new RepeatSpec(rep.data.join("\n")), part);
  }
}

// ───────────────────────── 由源文小节建（R2 阶段 9） ─────────────────────────

/** 源文小节 → 引擎的小节（一一对应；时值、连音配对、调号拍号沿用照旧口径）。 */
function partOfSource(src: readonly SrcMeasure[], key: Key, ts: Time): Part {
  const res = new Part();
  const slurOpen: Chord[] = []; // 已开未闭的弧（栈：后开先闭，容嵌套的两条）
  const tupNotes: Note[] = [];
  src.forEach((sm, mid) => {
    const mea = new Measure(mid);
    res.measures.push(mea);
    if (sm.timeChange) {
      mea.time = new Time(sm.time.beats, sm.time.beatType);
      mea.timeChange = true;
    }
    if (sm.keyChange) {
      const k = new Key();
      k.fifths = sm.fifths;
      mea.key = k;
      mea.keyChange = true;
    }
    for (const e of sm.entries) {
      if (e.kind === "break") {
        mea.lineBreak(e.page);
        continue;
      }
      if (e.kind === "bar") {
        const ent = new BarlineEntry(mea);
        ent.style = e.style as BarStyle;
        if (e.repeat) ent.repeat = e.repeat;
        mea.entries.push(ent);
        continue;
      }
      const chord = new Chord(mea);
      chord.beats = e.beats;
      chord.beams = e.beams;
      chord.dot = e.dot;
      chord.slurStart = e.slurStart;
      chord.slurEnds = e.slurEnds;
      chord.fermata = e.fermata;
      chord.rest = e.rest;
      const nt = new Note(chord);
      chord.add(nt);
      for (const g of e.graces) {
        const gn = new Note(chord);
        gn.number = g.number;
        gn.jpOctave = g.jpOctave;
        gn.jpAlter = g.jpAlter;
        gn.pitch = g.pitch;
        gn.step = g.step;
        gn.rest = g.rest;
        chord.graceNotes.push(gn);
      }
      nt.number = e.number;
      nt.jpOctave = e.jpOctave;
      nt.jpAlter = e.jpAlter;
      nt.pitch = e.pitch;
      nt.step = e.step;
      nt.rest = e.rest;
      nt.tupletBegin = e.tupletBegin;
      nt.tupletEnd = e.tupletEnd;
      for (const l of e.lyrics) {
        const lrc = new Lyric();
        lrc.number = l.number;
        lrc.text = l.text;
        nt.lyrics.push(lrc);
      }
      let dur = new Fraction(chord.beats);
      if (chord.dot > 0) dur = dur.timesInt(3).divInt(2);
      if (e.tupletBegin || tupNotes.length % 2 === 1) dur = dur.timesInt(2).divInt(3);
      chord.duration = dur.divInt(1 << chord.beams);
      if (nt.tupletEnd || nt.tupletBegin) tupNotes.push(nt);
      // 收在前、起在后：同一个音符上「收上一条、再起下一条」是常见写法。
      for (let k = 0; k < chord.slurEnds; k++) {
        const from = slurOpen.pop();
        if (from) from.slurEndChord = chord;
      }
      if (chord.slurStart) slurOpen.push(chord);
      mea.entries.push(chord);
    }
  });
  doPairTuplet(tupNotes);
  updateTimeInf(res);
  let curTime = ts;
  let curKey = key;
  for (const m of res.measures) {
    if (m.timeChange) curTime = m.time;
    else m.time = curTime;
    if (m.keyChange) curKey = m.key;
    else m.key = curKey;
  }
  return res;
}

/** `.jpwabc` → 引擎输入树。读原文那一步与 `jpwToScoreDoc` 共用（`model/fromjpw.ts::readJpwSource`）。 */
export function fromJpw(f: JpwFile): Score | null {
  const res = new Score();
  const title = f.getTitle();
  res.title = unescape(title?.title ?? "");
  const author = title?.wordsMusicBy ?? null;
  if (author !== null) {
    const cred = new Credit();
    cred.text = unescape(author);
    // page 是 0 基的页号（MusicXML 导入端也是 attr−1），与写出端 tojpw.ts 只收 page===0 的判据对得上
    cred.page = 0;
    res.credit.push(cred);
  }
  res.playData.tempo = title?.tempo ?? 0;
  const src = readJpwSource(f);
  const ts = new Time();
  ts.beatType = src.time.beatType;
  ts.beats = src.time.beats;
  const kk = new Key();
  kk.fifths = src.fifths;
  const part = partOfSource(src.measures, kk, ts);
  res.parts.push(part);
  processRepeat(res, part, src.passes, f.getSection(RepeatSection));
  return res;
}
