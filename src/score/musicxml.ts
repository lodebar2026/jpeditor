// MusicXML -> Score, ported from score.kt (Score.load / Part.load / Measure.load /
// Note.load / parse*) + musicxml-ext.kt, using the browser DOMParser instead of JAXB.
// Reuses the existing TS Score model + Fraction/MusicCommon/AccidentalStat.

import { Fraction } from "../common/fraction";
import {
  BarStyle,
  BarlineEntry,
  Chord,
  Credit,
  JumpSpec,
  Lyric,
  Measure,
  Note,
  ParserTemp,
  Part,
  PlayData,
  PlaySpecKind,
  Score,
  StartStopDiscontinue,
  TimePosition,
} from "./score";

// ---------------- DOM helpers ----------------
function elems(parent: Element, tag: string): Element[] {
  const out: Element[] = [];
  for (const n of Array.from(parent.children)) if (n.tagName === tag) out.push(n);
  return out;
}
function elem(parent: Element, tag: string): Element | null {
  for (const n of Array.from(parent.children)) if (n.tagName === tag) return n;
  return null;
}
function txt(parent: Element, tag: string): string | null {
  const e = elem(parent, tag);
  return e ? (e.textContent ?? "") : null;
}
function normText(s: string | null): string | null {
  const t = s?.trim() ?? "";
  return t.length > 0 ? t : null;
}
function intOf(parent: Element, tag: string): number | null {
  const t = txt(parent, tag);
  return t === null || t.trim() === "" ? null : parseInt(t.trim(), 10);
}
function has(parent: Element, tag: string): boolean {
  return elem(parent, tag) !== null;
}

// ---------------- per-measure parse state ----------------
interface MState {
  pos: Fraction; // raw (un-divided) running position within measure
  noteEnd: Fraction;
}

function noteDuration(noteEl: Element): Fraction {
  return new Fraction(intOf(noteEl, "duration") ?? 0);
}

function parseTimeSig(timeEl: Element): [number, number] {
  let beats = 4, beatType = 4;
  for (const c of Array.from(timeEl.children)) {
    if (c.tagName === "beats") beats = parseInt(c.textContent ?? "4", 10);
    else if (c.tagName === "beat-type") beatType = parseInt(c.textContent ?? "4", 10);
  }
  return [beats, beatType];
}

// ---------------- Note ----------------
const PITCH_MAP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function loadNote(nt: Note, noteEl: Element): void {
  const pit = elem(noteEl, "pitch");
  if (pit) {
    nt.octave = intOf(pit, "octave") ?? 0;
    nt.step = (txt(pit, "step") ?? " ")[0];
    const alter = intOf(pit, "alter");
    if (alter !== null) nt.alter = alter;
    nt.pitch = (nt.octave + 1) * 12 + (PITCH_MAP[nt.step] ?? 0) + nt.alter;
  } else {
    nt.pitch = 0;
  }
  if (has(noteEl, "rest")) nt.rest = true;
  parseLrc(nt, noteEl);
  parseNotations(nt, noteEl);
}

function parseLrc(nt: Note, noteEl: Element): void {
  for (const lyricEl of elems(noteEl, "lyric")) {
    let text = "";
    for (const t of elems(lyricEl, "text")) text += t.textContent ?? "";
    if (text.length === 0) continue;
    const lrc = new Lyric();
    lrc.text = text;
    const number = lyricEl.getAttribute("number") ?? "1";
    if (number === "chorus") {
      lrc.refrain = true;
      lrc.number = 1;
    } else {
      lrc.number = number.charCodeAt(number.length - 1) - "0".charCodeAt(0);
      if (lrc.number > 10) console.error("bad lrc number " + lrc.number);
    }
    nt.lyrics.push(lrc);
  }
}

function parseNotations(nt: Note, noteEl: Element): void {
  const nts = elem(noteEl, "notations");
  if (!nts) return;
  for (const it of Array.from(nts.children)) {
    if (it.tagName === "tied") {
      const ty = it.getAttribute("type");
      if (ty === "start") nt.tieStart = true;
      else if (ty === "stop") nt.tieEnd = true;
    } else if (it.tagName === "tuplet") {
      if (it.getAttribute("type") === "start") nt.tupletBegin = true;
      else nt.tupletEnd = true;
    } else if (it.tagName === "fermata") {
      nt.chord.fermata = true;
    } else if (it.tagName === "slur") {
      const ty = it.getAttribute("type");
      if (ty === "start") nt.chord.slurStart = true;
      else if (ty === "stop") nt.chord.slurEnd = true;
    }
  }
}

function parseDuration(ch: Chord, noteEl: Element): void {
  if (has(noteEl, "dot")) ch.dot = 1;
  const type = txt(noteEl, "type");
  switch (type) {
    case "whole": ch.beats = 4; ch.beams = 0; break;
    case "half": ch.beats = 2; ch.beams = 0; break;
    case "quarter": ch.beats = 1; ch.beams = 0; break;
    case "eighth": ch.beats = 1; ch.beams = 1; break;
    case "16th": ch.beats = 1; ch.beams = 2; break;
    case "32nd": ch.beats = 1; ch.beams = 4; break;
    case null:
      if (has(noteEl, "rest")) { ch.beats = 4; ch.beams = 0; return; }
      break;
    default: throw new Error("bad note type " + type);
  }
  if (ch.dot === 1 && ch.beats > 1) { ch.beats = (ch.beats * 3) / 2; }
}

// ---------------- Measure ----------------
function onNote(m: Measure, noteEl: Element, tmp: ParserTemp, div: number, st: MState): void {
  if (has(noteEl, "grace")) return;
  const isChord = has(noteEl, "chord");
  const newChord = m.entries.length === 0 || !isChord;
  if (newChord) m.add(new Chord(m));
  const last = m.entries[m.entries.length - 1] as Chord;
  const nt = new Note(last);
  loadNote(nt, noteEl);
  if (last.slurEnd) {
    if (tmp.slurStart) tmp.slurStart.slurEndChord = last;
  } else if (last.slurStart) {
    tmp.slurStart = last;
  }
  if (nt.tieStart || nt.tieEnd) tmp.tieNotes.push(nt);
  if (nt.tupletBegin || nt.tupletEnd) tmp.tupletNotes.push(nt);
  last.add(nt);
  if (newChord) {
    st.pos = st.noteEnd;
    if (!has(noteEl, "duration")) throw new Error("note without duration");
    st.noteEnd = st.pos.plus(noteDuration(noteEl));
    parseDuration(last, noteEl);
    last.position = st.pos.divInt(div);
    last.duration = noteDuration(noteEl).divInt(div);
    last.voice = intOf(noteEl, "voice") ?? 1;
    last.rest = nt.rest;
  }
}

function parseAttribute(m: Measure, attrEl: Element): void {
  for (const k of elems(attrEl, "key")) {
    const fifths = intOf(k, "fifths");
    if (fifths !== null) { m.key.fifths = fifths; m.keyChange = true; }
  }
  for (const t of elems(attrEl, "time")) {
    const [beats, beatType] = parseTimeSig(t);
    m.time.beats = beats;
    m.time.beatType = beatType;
    m.timeChange = true;
  }
}

function parsePrint(m: Measure, printEl: Element): void {
  if (printEl.getAttribute("new-system") === "yes") m.newSystem = true;
  if (printEl.getAttribute("new-page") === "yes") { m.newSystem = true; m.newPage = true; }
}

function parseBarline(m: Measure, blEl: Element, st: MState): void {
  const loc = blEl.getAttribute("location") ?? "right";
  const st0 = txt(blEl, "bar-style");
  if (st0 !== null) {
    const style = st0 as BarStyle;
    if (loc === "left") m.leftBarline = style;
    else m.barline = style;
    const be = new BarlineEntry(m);
    be.style = style;
    be.position = st.pos;
    m.entries.push(be);
  }
  const rep = elem(blEl, "repeat");
  if (rep) {
    if (rep.getAttribute("direction") === "backward") m.repeatBackward = true;
    else m.repeatForward = true;
  }
  const ending = elem(blEl, "ending");
  if (ending) {
    if (loc === "left") {
      m.endingNum = m.parseEndingNum(ending.getAttribute("number"));
      m.endingLeft = true;
    } else {
      m.endingRight = (ending.getAttribute("type") as StartStopDiscontinue) ?? null;
    }
  }
}

function parseSound(snd: Element, pd: PlayData, mid: number, st: MState, div: number): void {
  const tick = new TimePosition(mid, st.noteEnd.divInt(div));
  const coda = snd.getAttribute("coda");
  const segno = snd.getAttribute("segno");
  if (coda) pd.coda.set(coda, tick);
  if (segno) pd.segno.set(segno, tick);
  if (snd.getAttribute("dacapo")) pd.jumpTo.set(tick, new JumpSpec(PlaySpecKind.Dacapo));
  if (snd.getAttribute("fine")) pd.jumpTo.set(tick, new JumpSpec(PlaySpecKind.Fine));
  const dalsegno = snd.getAttribute("dalsegno");
  if (dalsegno) { const s = new JumpSpec(PlaySpecKind.DalSegno); s.value = dalsegno; pd.jumpTo.set(tick, s); }
  const tocoda = snd.getAttribute("tocoda");
  if (tocoda) { const s = new JumpSpec(PlaySpecKind.ToCoda); s.value = tocoda; pd.jumpTo.set(tick, s); }
}

function loadMeasure(
  m: Measure, measureEl: Element, prev: Measure | null, div: number, tmp: ParserTemp,
): void {
  if (prev) {
    m.key.fifths = prev.key.fifths;
    m.time.beats = prev.time.beats;
    m.time.beatType = prev.time.beatType;
  }
  const st: MState = { pos: new Fraction(0), noteEnd: new Fraction(0) };
  for (const item of Array.from(measureEl.children)) {
    switch (item.tagName) {
      case "note": onNote(m, item, tmp, div, st); break;
      case "backup": st.pos = st.pos.minus(new Fraction(intOf(item, "duration") ?? 0)); st.noteEnd = st.pos; break;
      case "attributes": parseAttribute(m, item); break;
      case "print": parsePrint(m, item); break;
      case "barline": st.pos = st.noteEnd; parseBarline(m, item, st); break;
      case "sound": st.pos = st.noteEnd; parseSound(item, tmp.playData, m.index, st, div); break;
      case "direction": {
        st.pos = st.noteEnd;
        const snd = elem(item, "sound");
        if (snd) parseSound(snd, tmp.playData, m.index, st, div);
        break;
      }
    }
  }
}

// ---------------- Part ----------------
function loadPart(part: Part, partEl: Element, pd: PlayData): void {
  const measureEls = elems(partEl, "measure");
  const firstAttr = measureEls[0] ? elem(measureEls[0], "attributes") : null;
  const div = firstAttr ? intOf(firstAttr, "divisions") ?? 1 : 1;
  let pos = new Fraction(0);
  const tmp = new ParserTemp(pd);
  let cur: Measure | null = null;
  measureEls.forEach((mel, mid) => {
    const mea = new Measure(mid);
    mea.position = pos;
    loadMeasure(mea, mel, cur, div, tmp);
    part.measures.push(mea);
    tmp.pairTuplet();
    pos = pos.plus(mea.duration);
    cur = mea;
  });
  tmp.pairTie();
}

// ---------------- refrain detection (score.kt findRefrain/updateRefrain) ----------------
function findRefrain(score: Score): void {
  const countInf = new Map<string, { pos: Fraction; n: number }>();
  for (const m of score.parts[0].measures) {
    for (const ent of m.entries) {
      if (!(ent instanceof Chord)) continue;
      let cnt = 0;
      for (const n of ent.notes) for (const l of n.lyrics) if (l.text.length > 0) cnt++;
      if (cnt === 0) continue;
      const pos = m.position.plus(ent.position);
      const key = pos.toString();
      const prev = countInf.get(key);
      countInf.set(key, { pos, n: (prev?.n ?? 0) + cnt });
    }
  }
  const entries = [...countInf.values()].sort((a, b) => a.pos.compareTo(b.pos));
  let refrainPos: Fraction | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].n === 1) refrainPos = entries[i].pos;
    else if (entries[i].n > 1) break;
  }
  if (refrainPos) updateRefrain(score, refrainPos);
}

function updateRefrain(score: Score, refrainPos: Fraction): void {
  for (const m of score.parts[0].measures) {
    const end = m.position.plus(m.duration);
    if (end.compareTo(refrainPos) <= 0) continue;
    for (const ent of m.entries) {
      if (!(ent instanceof Chord)) continue;
      const pos = m.position.plus(ent.position);
      if (pos.compareTo(refrainPos) < 0) continue;
      for (const n of ent.notes) for (const l of n.lyrics) l.refrain = true;
    }
  }
}

function extractScoreTitle(root: Element): string {
  for (const cr of elems(root, "credit")) {
    if (normText(txt(cr, "credit-type")) !== "title") continue;
    const creditTitle = normText(txt(cr, "credit-words"));
    if (creditTitle) return creditTitle;
  }

  const work = elem(root, "work");
  const workTitle = normText(work ? txt(work, "work-title") : null);
  if (workTitle) return workTitle;

  const movementTitle = normText(txt(root, "movement-title"));
  if (movementTitle) return movementTitle;
  return "";
}

// ---------------- top-level ----------------
export function loadMusicXml(xmlText: string): Score {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("MusicXML 解析失败: " + err.textContent);
  const root = doc.documentElement; // score-partwise
  const score = new Score();

  score.title = extractScoreTitle(root);

  const ident = elem(root, "identification");
  if (ident) {
    for (const cr of elems(ident, "creator")) {
      score.creator.set(cr.getAttribute("type") ?? "", cr.textContent ?? "");
    }
  }
  for (const cr of elems(root, "credit")) {
    const cred = new Credit();
    const ct = txt(cr, "credit-type");
    if (ct) cred.type = ct;
    // A <credit> may hold several <credit-words> lines (e.g. 词:… / 曲:… / Public
    // Domain). Keep them all, joined by newlines so multipleLineText renders each.
    const cw = elems(cr, "credit-words")
      .map((e) => (e.textContent ?? "").trim())
      .filter((s) => s.length > 0)
      .join("\n");
    if (cw) cred.text = cw;
    cred.page = (parseInt(cr.getAttribute("page") ?? "1", 10) || 1) - 1;
    score.credit.push(cred);
  }
  for (const it of score.credit) {
    if (it.type === null && it.text === score.title) it.type = "title";
  }

  const part = new Part();
  loadPart(part, elems(root, "part")[0], score.playData);
  score.parts.push(part);
  for (const m of part.measures) m.init();
  findRefrain(score);
  score.parseRepeatInf();
  return score;
}
