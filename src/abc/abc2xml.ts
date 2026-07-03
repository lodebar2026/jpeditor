// Faithful TypeScript port of Willem G. Vree's abc2xml.py (ABC -> MusicXML).
// Original: Copyright (C) 2012-2018 Willem G. Vree, LGPL. See ~/proj/zanmeigepu/abc2xml.py.
// Ported nearly line-by-line; python function/class names are kept.
// Uses the local pyparsing shim (./pyparsing) and ElementTree shim (./eltree).
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as PP from "./pyparsing";
import { E, Element, tostring } from "./eltree";
import { addPageCredits, deriveComposers } from "./credits";

export const VERSION = 220;

// ---------------- python-ish helpers ----------------
function info(s: string): void {
  // abc2xml writes diagnostics to stderr; keep them low-noise in the browser.
  if (typeof console !== "undefined") console.debug("abc2xml: " + s);
}
function simplify(a: number, b: number): [number, number] {
  const x = a, y = b;
  let aa = a, bb = b;
  while (bb) { const t = aa % bb; aa = bb; bb = t; }
  return [Math.trunc(x / aa), Math.trunc(y / aa)];
}
function getattr(o: any, name: string, def: any): any {
  return o != null && name in o && o[name] !== undefined ? o[name] : def;
}
function hasattr(o: any, name: string): boolean {
  return o != null && name in o && o[name] !== undefined;
}
function stripChars(s: string, chars: string): string {
  let a = 0, b = s.length;
  while (a < b && chars.indexOf(s[a]) >= 0) a++;
  while (b > a && chars.indexOf(s[b - 1]) >= 0) b--;
  return s.slice(a, b);
}
function rstripChars(s: string, chars: string): string {
  let b = s.length;
  while (b > 0 && chars.indexOf(s[b - 1]) >= 0) b--;
  return s.slice(0, b);
}
function sum(xs: number[]): number {
  let t = 0; for (const x of xs) t += x; return t;
}
function maxOf(xs: number[]): number {
  let m = xs[0]; for (const x of xs) if (x > m) m = x; return m;
}
// %.2f / %g formatting
function f2(x: number): string { return x.toFixed(2); }
function fg(x: number): string {
  // approximate python "%g": up to 6 significant digits, strip trailing zeros
  let s = x.toPrecision(6);
  if (s.indexOf(".") >= 0 && s.indexOf("e") < 0) s = s.replace(/\.?0+$/, "");
  return s;
}

// ---------------- pyparsing local factories (readable grammar) ----------------
const co = (x: PP.P | string): PP.P => (typeof x === "string" ? new PP.Literal(x) : x);
const Word = (c: string, o?: { exact?: number }) => new PP.Word(c, o);
const Literal = (s: string) => new PP.Literal(s);
const Regex = (p: string) => new PP.Regex(p);
const CharsNotIn = (c: string, o?: { exact?: number; min?: number }) => new PP.CharsNotIn(c, o);
const Optional = (e: PP.P | string, ...d: any[]) => new PP.Optional(co(e), ...d);
const ZeroOrMore = (e: PP.P | string) => new PP.ZeroOrMore(co(e));
const OneOrMore = (e: PP.P | string) => new PP.OneOrMore(co(e));
const Group = (e: PP.P | string) => new PP.Group(co(e));
const Combine = (e: PP.P | string) => new PP.Combine(co(e));
const Suppress = (e: PP.P | string) => new PP.Suppress(co(e));
const FollowedBy = (e: PP.P | string) => new PP.FollowedBy(co(e));
const NotAny = (e: PP.P | string) => new PP.NotAny(co(e));
const StringEnd = () => new PP.StringEnd();
const Forward = () => new PP.Forward();
const { seq, alt, longest, oneOf, srange, nums, alphanums } = PP;

// ---------------- pObj (AST node) ----------------
export class pObj {
  name: string;
  t: any[];
  objs: any[];
  [k: string]: any;
  constructor(name: string, t: any, seq = 0) {
    this.name = name;
    const items: any[] = typeof t === "string" ? t.split("") : Array.from(t);
    const rest: any[] = [];
    const attrs: Record<string, any[]> = {};
    for (const x of items) {
      if (x instanceof pObj) (attrs[x.name] = attrs[x.name] || []).push(x);
      else rest.push(x);
    }
    for (const nm of Object.keys(attrs)) {
      const xs = attrs[nm];
      this[nm] = xs.length === 1 ? xs[0] : xs;
    }
    this.t = rest;
    this.objs = seq ? items : [];
  }
}

// ---------------- grammar (abc_grammar) ----------------
let prevloc = 0; // remember previous match position of a note/rest (beam detection)

function detectBeamBreak(line: string, loc: number, t: any[]): void {
  let xs = line.slice(prevloc, loc + 1);
  xs = xs.replace(/^\s+/, ""); // lstrip
  prevloc = loc;
  const b = new pObj("bbrk", [xs.indexOf(" ") >= 0]);
  t.splice(0, 0, b);
}
function noteActn(line: string, loc: number, t: any[]): any {
  if (t[0].t.indexOf("y") >= 0) return []; // discard spacer
  detectBeamBreak(line, loc, t);
  return new pObj("note", t);
}
function restActn(line: string, loc: number, t: any[]): any {
  detectBeamBreak(line, loc, t);
  return new pObj("rest", t);
}
function errorWarn(_line: string, _loc: number, t: any[]): any {
  if (!t[0]) return [];
  info("**misplaced symbol: " + t[0]);
  return [];
}

interface Grammar {
  abc_header: PP.P;
  abc_voice: PP.P;
  abc_scoredef: PP.P;
  abc_percmap: PP.P;
}

function abc_grammar(): Grammar {
  const b1 = Word("-,'’<>#", { exact: 1 }); // catch misplaced chars in chords
  const b2 = Regex("[^H-Wh-w~=]*");
  const b3 = Regex("[^=]*");

  const number = Word(nums).setParseAction((t: any[]) => parseInt(t[0], 10));
  const field_str = Regex("[^\\]]*").setParseAction((t: any[]) => t[0].trim());

  const userdef_symbol = Word(srange("[H-Wh-w~]"), { exact: 1 });
  const fieldId = oneOf("K L M Q P I T C O A Z N G H R B D F S E r Y");
  const X_field = seq(Literal("X"), Suppress(":"), field_str);
  const U_field = seq(Literal("U"), Suppress(":"), b2, Optional(userdef_symbol, "H"), b3, Suppress("="), field_str);
  const V_field = seq(Literal("V"), Suppress(":"), Word(alphanums + "_"), field_str);
  const inf_fld = seq(fieldId, Suppress(":"), field_str);
  const ifield = seq(Suppress("["), alt(X_field, U_field, V_field, inf_fld), Suppress("]"));
  const abc_header = seq(OneOrMore(ifield), StringEnd());

  // I:score with recursive part groups and {* grand staff marker
  const voiceId = seq(Suppress(Optional("*")), Word(alphanums + "_"));
  const voice_gr = seq(Suppress("("), OneOrMore(alt(voiceId, Suppress("|"))), Suppress(")"));
  const simple_part = alt(voiceId, voice_gr, Suppress("|"));
  const grand_staff = seq(oneOf("{* {"), OneOrMore(simple_part), Suppress("}"));
  const part = Forward();
  const part_seq = OneOrMore(alt(part, Suppress("|")));
  const brace_gr = seq(Suppress("{"), part_seq, Suppress("}"));
  const bracket_gr = seq(Suppress("["), part_seq, Suppress("]"));
  part.set(alt(simple_part, grand_staff, brace_gr, bracket_gr, Suppress("|")));
  const abc_scoredef = seq(Suppress(oneOf("staves score")), OneOrMore(part));

  // ABC lyric lines (white space sensitive)
  const skip_note = oneOf("* - ~");
  const extend_note = Literal("_");
  const measure_end = Literal("|");
  const syl_str = CharsNotIn("*~-_| \t\n\\]");
  const syl_chars = Combine(OneOrMore(alt(syl_str, Regex("\\\\."))));
  const white = Word(" \t");
  const syllable = seq(
    Combine(seq(Optional("~"), syl_chars, ZeroOrMore(seq(Literal("~"), syl_chars)))),
    Optional("-"),
  );
  const lyr_elem = seq(alt(syllable, skip_note, extend_note, measure_end), Optional(white).suppress());
  const lyr_line = seq(Optional(white).suppress(), ZeroOrMore(lyr_elem));

  syllable.setParseAction((t: any[]) => new pObj("syl", t));
  skip_note.setParseAction((t: any[]) => new pObj("skip", t));
  extend_note.setParseAction((t: any[]) => new pObj("ext", t));
  measure_end.setParseAction((t: any[]) => new pObj("sbar", t));
  const lyr_line_wsp = lyr_line.leaveWhitespace();

  // ABC voice
  const inline_field = seq(Suppress("["), alt(inf_fld, U_field, V_field), Suppress("]"));
  const lyr_fld = seq(Suppress("["), Suppress("w"), Suppress(":"), lyr_line_wsp, Suppress("]"));
  const lyr_blk = OneOrMore(lyr_fld);
  const fld_or_lyr = alt(inline_field, lyr_blk);

  const note_length = seq(Optional(number, 1), Group(ZeroOrMore("/")), Optional(number, 2));
  const octaveHigh = OneOrMore("'").setParseAction((t: any[]) => t.length);
  const octaveLow = OneOrMore(",").setParseAction((t: any[]) => -t.length);
  const octave = alt(octaveHigh, octaveLow);

  const basenote = oneOf("C D E F G A B c d e f g a b y");
  const accidental = oneOf("^^ __ ^ _ =");
  const rest_sym = oneOf("x X z Z");
  const slur_beg = seq(oneOf("( (, (' .( .(, .('"), NotAny(Word(nums)));
  const slur_ends = OneOrMore(oneOf(") .)"));

  const long_decoration = Combine(seq(oneOf("! +"), CharsNotIn("!+ \n"), oneOf("! +")));
  const staccato = seq(Literal("."), NotAny(Literal("|")));
  const pizzicato = Literal("!+!");
  const decoration = alt(slur_beg, staccato, userdef_symbol, long_decoration, pizzicato);
  const decorations = OneOrMore(decoration);

  const tie = oneOf(".- -");
  const rest = seq(Optional(accidental), rest_sym, note_length);
  const pitch = seq(Optional(accidental), basenote, Optional(octave, 0));
  const note = seq(pitch, note_length, Optional(tie), Optional(slur_ends));
  const dec_note = seq(Optional(decorations), pitch, note_length, Optional(tie), Optional(slur_ends));
  const chord_note = alt(dec_note, rest, b1);
  const grace_notes = Forward();
  const chord = seq(Suppress("["), OneOrMore(alt(chord_note, grace_notes)), Suppress("]"), note_length, Optional(tie), Optional(slur_ends));
  const stem = alt(note, chord, rest);

  const broken = Combine(alt(OneOrMore("<"), OneOrMore(">")));

  const tuplet_num = seq(Suppress("("), number);
  const tuplet_into = seq(Suppress(":"), Optional(number, 0));
  const tuplet_notes = seq(Suppress(":"), Optional(number, 0));
  const tuplet_start = seq(tuplet_num, Optional(seq(tuplet_into, Optional(tuplet_notes))));

  const acciaccatura = Literal("/");
  const grace_stem = seq(Optional(decorations), stem);
  grace_notes.set(Group(seq(Suppress("{"), Optional(acciaccatura), OneOrMore(grace_stem), Suppress("}"))));

  const text_expression = seq(Optional(oneOf("^ _ < > @"), "^"), Optional(CharsNotIn('"'), ""));
  const chord_accidental = oneOf("# b =");
  const triad = oneOf("ma Maj maj M mi min m aug dim o + -");
  const seventh = oneOf("7 ma7 Maj7 M7 maj7 mi7 m7 dim7 o7 -7 aug7 +7 m7b5 mi7b5");
  const sixth = oneOf("6 ma6 M6 m6 mi6");
  const ninth = oneOf("9 ma9 M9 maj9 Maj9 mi9 m9");
  const elevn = oneOf("11 ma11 M11 maj11 Maj11 mi11 m11");
  const suspended = oneOf("sus sus2 sus4");
  const chord_degree = Combine(seq(Optional(chord_accidental), oneOf("2 4 5 6 7 9 11 13")));
  const chord_kind = seq(Optional(alt(seventh, sixth, ninth, elevn, triad), "_"), Optional(suspended));
  const chord_root = seq(oneOf("C D E F G A B"), Optional(chord_accidental));
  const chord_bass = seq(oneOf("C D E F G A B"), Optional(chord_accidental));
  const chordsym = seq(chord_root, chord_kind, ZeroOrMore(chord_degree), Optional(seq(Suppress("/"), chord_bass)));
  const chord_sym = seq(chordsym, Optional(seq(Literal("("), CharsNotIn(")"), Literal(")"))).suppress());
  const chord_or_text = seq(Suppress('"'), longest(chord_sym, text_expression), Suppress('"'));

  const volta_nums = seq(Optional("[").suppress(), Combine(seq(Word(nums), ZeroOrMore(seq(oneOf(", -"), Word(nums))))));
  const volta_text = seq(Literal("[").suppress(), Regex('"[^"]+"'));
  const volta = alt(volta_nums, volta_text);
  const invisible_barline = oneOf("[|] []");
  const dashed_barline = oneOf(": .|");
  const double_rep = seq(Literal(":"), FollowedBy(":"));
  const voice_overlay = Combine(OneOrMore("&"));
  const bare_volta = FollowedBy(seq(Literal("["), Word(nums)));
  const bar_left = alt(
    seq(oneOf("[|: |: [: :"), Optional(volta)),
    seq(Optional("|").suppress(), volta),
    oneOf("| [|"),
  );
  const bars = seq(ZeroOrMore(":"), ZeroOrMore("["), OneOrMore(oneOf("| ]")));
  const bar_right = alt(invisible_barline, double_rep, Combine(bars), dashed_barline, voice_overlay, bare_volta);

  const errors = seq(NotAny(bar_right), Optional(Word(" \n")), CharsNotIn(":&|", { exact: 1 }));
  const linebreak = alt(Literal("$"), seq(NotAny(decorations), Literal("!")));
  const element = alt(fld_or_lyr, broken, decorations, stem, chord_or_text, grace_notes, tuplet_start, linebreak, errors);
  const measure = Group(seq(ZeroOrMore(inline_field), Optional(bar_left), ZeroOrMore(element), bar_right, Optional(linebreak), Optional(lyr_blk)));
  const noBarMeasure = Group(seq(ZeroOrMore(inline_field), Optional(bar_left), OneOrMore(element), Optional(linebreak), Optional(lyr_blk)));
  const abc_voice = seq(ZeroOrMore(measure), Optional(alt(noBarMeasure, Group(bar_left))), ZeroOrMore(inline_field).suppress(), StringEnd());

  // I:percmap note [step] [midi] [note-head]
  const white2 = alt(white, StringEnd()).suppress();
  const w3 = Optional(white2);
  const percid = Word(alphanums + "-");
  const step = seq(basenote, Optional(octave, 0));
  const pitchg = Group(seq(Optional(accidental, ""), step, FollowedBy(white2)));
  const stepg = alt(Group(seq(step, FollowedBy(white2))), Literal("*"));
  const midi = alt(Literal("*"), number, pitchg, percid);
  const nhd = Optional(Combine(seq(percid, Optional("+"))), "");
  const perc_wsp = seq(Literal("percmap"), w3, pitchg, w3, Optional(stepg, "*"), w3, Optional(midi, "*"), w3, nhd);
  const abc_percmap = perc_wsp.leaveWhitespace();

  // Parse actions -> pObj AST
  ifield.setParseAction((t: any[]) => new pObj("field", t));
  grand_staff.setParseAction((t: any[]) => new pObj("grand", t, 1));
  brace_gr.setParseAction((t: any[]) => new pObj("bracegr", t, 1));
  bracket_gr.setParseAction((t: any[]) => new pObj("bracketgr", t, 1));
  voice_gr.setParseAction((t: any[]) => new pObj("voicegr", t, 1));
  voiceId.setParseAction((t: any[]) => new pObj("vid", t, 1));
  abc_scoredef.setParseAction((t: any[]) => new pObj("score", t, 1));
  note_length.setParseAction((t: any[]) => new pObj("dur", [t[0], (t[2] << t[1].length) >> 1]));
  chordsym.setParseAction((t: any[]) => new pObj("chordsym", t));
  chord_root.setParseAction((t: any[]) => new pObj("root", t));
  chord_kind.setParseAction((t: any[]) => new pObj("kind", t));
  chord_degree.setParseAction((t: any[]) => new pObj("degree", t));
  chord_bass.setParseAction((t: any[]) => new pObj("bass", t));
  text_expression.setParseAction((t: any[]) => new pObj("text", t));
  inline_field.setParseAction((t: any[]) => new pObj("inline", t));
  lyr_fld.setParseAction((t: any[]) => new pObj("lyr_fld", t, 1));
  lyr_blk.setParseAction((t: any[]) => new pObj("lyr_blk", t, 1));
  grace_notes.setParseAction(doGrace);
  acciaccatura.setParseAction((t: any[]) => new pObj("accia", t));
  note.setParseAction(noteActn);
  rest.setParseAction(restActn);
  decorations.setParseAction((t: any[]) => new pObj("deco", t));
  pizzicato.setParseAction((_t: any[]) => ["!plus!"]);
  slur_ends.setParseAction((t: any[]) => new pObj("slurs", t));
  chord.setParseAction((t: any[]) => new pObj("chord", t, 1));
  dec_note.setParseAction(noteActn);
  tie.setParseAction((t: any[]) => new pObj("tie", t));
  pitch.setParseAction((t: any[]) => new pObj("pitch", t));
  bare_volta.setParseAction((_t: any[]) => ["|"]);
  dashed_barline.setParseAction((_t: any[]) => [".|"]);
  bar_right.setParseAction((t: any[]) => new pObj("rbar", t));
  bar_left.setParseAction((t: any[]) => new pObj("lbar", t));
  broken.setParseAction((t: any[]) => new pObj("broken", t));
  tuplet_start.setParseAction((t: any[]) => new pObj("tup", t));
  linebreak.setParseAction((t: any[]) => new pObj("linebrk", t));
  measure.setParseAction(doMaat);
  noBarMeasure.setParseAction(doMaat);
  b1.setParseAction(errorWarn);
  b2.setParseAction(errorWarn);
  b3.setParseAction(errorWarn);
  errors.setParseAction(errorWarn);

  return { abc_header, abc_voice, abc_scoredef, abc_percmap };
}

// ---------------- measure transformations ----------------
function doBroken(prev: any, brk: string, x: any): void {
  if (!prev) { info("error in broken rhythm: " + x); return; }
  let [nom1, den1] = prev.dur.t;
  let [nom2, den2] = x.dur.t;
  if (brk === ">") { [nom1, den1] = simplify(3 * nom1, 2 * den1); [nom2, den2] = simplify(1 * nom2, 2 * den2); }
  else if (brk === "<") { [nom1, den1] = simplify(1 * nom1, 2 * den1); [nom2, den2] = simplify(3 * nom2, 2 * den2); }
  else if (brk === ">>") { [nom1, den1] = simplify(7 * nom1, 4 * den1); [nom2, den2] = simplify(1 * nom2, 4 * den2); }
  else if (brk === "<<") { [nom1, den1] = simplify(1 * nom1, 4 * den1); [nom2, den2] = simplify(7 * nom2, 4 * den2); }
  else return;
  prev.dur.t = [nom1, den1];
  x.dur.t = [nom2, den2];
}
function convertBroken(t: any[]): void {
  let prev: any = null;
  let brk = "";
  const remove: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (x.name === "note" || x.name === "chord" || x.name === "rest") {
      if (brk) { doBroken(prev, brk, x); brk = ""; }
      else prev = x;
    } else if (x.name === "broken") {
      brk = x.t[0];
      remove.unshift(i);
    }
  }
  for (const i of remove) t.splice(i, 1);
}
function ptc2midi(n: any): number {
  const pt = getattr(n, "pitch", "");
  let midi: number;
  if (pt) {
    const p = pt.t;
    let acc: string, step: string, oct: any;
    if (p.length === 3) { [acc, step, oct] = p; } else { acc = ""; [step, oct] = p; }
    const nUp = step.toUpperCase();
    oct = (nUp === step ? 4 : 5) + parseInt(oct, 10);
    midi = oct * 12 + [0, 2, 4, 5, 7, 9, 11]["CDEFGAB".indexOf(nUp)] + (({ "^": 1, "_": -1 } as any)[acc] ?? 0) + 12;
  } else midi = 130;
  return midi;
}
function convertChord(t: any[]): void {
  const ins: [number, any[]][] = [];
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (x.name === "chord") {
      if (hasattr(x, "rest") && !hasattr(x, "note")) {
        if (Array.isArray(x.rest)) x.rest = x.rest[0];
        ins.unshift([i, [x.rest]]);
        continue;
      }
      const [num1, den1] = x.dur.t;
      const tie = getattr(x, "tie", null);
      const slurs = getattr(x, "slurs", []);
      if (!Array.isArray(x.note)) x.note = [x.note];
      const elms: any[] = [];
      let j = 0;
      const nss = mxm.orderChords
        ? x.objs.slice().sort((a: any, b: any) => ptc2midi(b) - ptc2midi(a))
        : x.objs;
      for (const nt of nss) {
        if (nt.name === "note") {
          const [num2, den2] = nt.dur.t;
          nt.dur.t = simplify(num1 * num2, den1 * den2);
          if (tie) nt.tie = tie;
          if (j === 0 && slurs && (Array.isArray(slurs) ? slurs.length : true)) nt.slurs = slurs;
          if (j > 0) nt.chord = new pObj("chord", [1]);
          else {
            const pitches = x.note.map((n: any) => n.pitch);
            nt.pitches = new pObj("pitches", pitches);
          }
          j += 1;
        }
        if (["dur", "tie", "slurs", "rest"].indexOf(nt.name) < 0) elms.push(nt);
      }
      ins.unshift([i, elms]);
    }
  }
  for (const [i, notes] of ins) {
    for (let k = notes.length - 1; k >= 0; k--) t.splice(i + 1, 0, notes[k]);
    t.splice(i, 1);
  }
}
function doMaat(t: any[]): void {
  convertBroken(t[0]);
  convertChord(t[0]);
}
function doGrace(t: any[]): any {
  convertChord(t[0]);
  for (const nt of t[0]) if (nt.name === "note") nt.grace = 1;
  return t[0];
}

// ---------------- musicXML helper builders ----------------
function compChordTab(): Record<string, string> {
  const [maj, min, aug, dim, dom, ch7, ch6, ch9, ch11, hd] =
    "major minor augmented diminished dominant -seventh -sixth -ninth -11th half-diminished".split(" ");
  const put = (m: Record<string, string>, keys: string, vals: string[]): void => {
    const ks = keys.split(" ");
    ks.forEach((k, i) => { m[k] = vals[i]; });
  };
  const m: Record<string, string> = {};
  put(m, "ma Maj maj M mi min m aug dim o + -", [maj, maj, maj, maj, min, min, min, aug, dim, dim, aug, min]);
  put(m, "7 ma7 Maj7 M7 maj7 mi7 m7 dim7 o7 -7 aug7 +7 m7b5 mi7b5",
    [dom, maj + ch7, maj + ch7, maj + ch7, maj + ch7, min + ch7, min + ch7, dim + ch7, dim + ch7, min + ch7, aug + ch7, aug + ch7, hd, hd]);
  put(m, "6 ma6 M6 mi6 m6", [maj + ch6, maj + ch6, maj + ch6, min + ch6, min + ch6]);
  put(m, "9 ma9 M9 maj9 Maj9 mi9 m9", [dom + ch9, maj + ch9, maj + ch9, maj + ch9, maj + ch9, min + ch9, min + ch9]);
  put(m, "11 ma11 M11 maj11 Maj11 mi11 m11", [dom + ch11, maj + ch11, maj + ch11, maj + ch11, maj + ch11, min + ch11, min + ch11]);
  return m;
}

function addElem(parent: Element, child: Element, _level: number): void {
  parent.append(child);
}
function addElemT(parent: Element, tag: string, text: string, level: number): Element {
  const e = E(tag);
  e.text = text;
  addElem(parent, e, level);
  return e;
}
function mkTmod(tmnum: number, tmden: number, lev: number): Element {
  const tmod = E("time-modification");
  addElemT(tmod, "actual-notes", String(tmnum), lev + 1);
  addElemT(tmod, "normal-notes", String(tmden), lev + 1);
  return tmod;
}
function addDirection(
  parent: Element, elems: any, lev: number, gstaff: number,
  subelms: Element[] = [], placement = "below", cue_on = 0,
): Element {
  const dir = E("direction", { placement });
  addElem(parent, dir, lev);
  let list: [Element, Element[]][];
  if (!Array.isArray(elems)) list = [[elems, subelms]];
  else list = elems;
  for (const [elem, sub] of list) {
    const typ = E("direction-type");
    addElem(dir, typ, lev + 1);
    addElem(typ, elem, lev + 2);
    for (const subel of sub) addElem(elem, subel, lev + 3);
  }
  if (cue_on) addElem(dir, E("level", { size: "cue" }), lev + 1);
  if (gstaff) addElemT(dir, "staff", String(gstaff), lev + 1);
  return dir;
}
function removeElems(root_elem: Element, parent_str: string, elem_str: string): void {
  for (const p of root_elem.findall(parent_str)) {
    const e = p.find(elem_str);
    if (e != null) p.remove(e);
  }
}
function alignLyr(vce: any[], lyrs: any[]): any[] {
  const empty_el = new pObj("leeg", "*");
  for (let k = 0; k < lyrs.length; k++) {
    const lyr = lyrs[k];
    let i = 0;
    for (const elem of vce) {
      if (elem.name === "note" && !(hasattr(elem, "chord") || hasattr(elem, "grace"))) {
        let lr: any;
        if (i >= lyr.length) lr = empty_el;
        else lr = lyr[i];
        lr.t[0] = lr.t[0].replace(/%5d/g, "]");
        elem.objs.push(lr);
        if (lr.name !== "sbar") i += 1;
      }
      if (elem.name === "rbar" && i < lyr.length && lyr[i].name === "sbar") i += 1;
    }
  }
  return vce;
}

const mm_rest = /([XZ])(\d+)/g;
const bar_space = /([:|][ |[\]]+[:|])/g;
function fixSlurs(x: string): string {
  x = x.replace(mm_rest, (_m, g1, g2) => {
    const n = parseInt(g2, 10);
    return (g1 + "|").repeat(n).slice(0, -1);
  });
  x = x.replace(bar_space, (_m, g1) => g1.replace(/ /g, ""));
  // slur_move with negative lookbehind (?<![!+])
  return x.replace(/([!+]?)([}><][<>]?)(\)+)/g, (m, pre, g1, g2) => (pre ? m : g2 + g1));
}

// ---------------- header / voice splitting ----------------
function splitHeaderVoices(abctext: string): [string, [string, string][]] {
  const escField = (x: string): string => "[" + x.replace(/]/g, "%5d") + "]";
  const r1 = /%.*$/;
  const r2 = /^([A-Zw]:.*$)|\[[A-Zw]:[^\]]*]$/;
  const r3 = /^%%(?=[^%])/;
  const xs: string[] = [];
  let nx = 0, mcont = 0, fcont = 0;
  let mln = "", fln = "";
  for (let x of abctext.split("\n")) {
    x = x.trim();
    if (!x && nx === 1) break;
    if (x.startsWith("X:")) {
      if (nx === 1) break;
      nx = 1;
    }
    x = x.replace(r3, "I:");
    let x2 = x.replace(r1, "");
    while (x2.endsWith("*") && !(x2.startsWith("w:") || x2.startsWith("+:") || x2.indexOf("percmap") >= 0)) {
      x2 = x2.slice(0, -1);
    }
    if (!x2) continue;
    if (x2.slice(0, 2) === "W:") {
      const field = x2.slice(2).trim();
      const ftype = (mxm.metaMap as any)["W"] ?? "W";
      const c = (mxm.metadata as any)[ftype] ?? "";
      (mxm.metadata as any)[ftype] = c ? c + "\n" + field : field;
      continue;
    }
    if (x2.slice(0, 2) === "+:") { fln += x2.slice(2); continue; }
    const ro = r2.exec(x2);
    if (ro) {
      if (fcont) {
        fcont = x2[x2.length - 1] === "\\" ? 1 : 0;
        fln += x2.replace(/^.:(.*?)\\*$/, "$1");
        continue;
      }
      if (fln) mln += escField(fln);
      if (x2.startsWith("[")) x2 = stripChars(x2, "[]");
      fcont = x2[x2.length - 1] === "\\" ? 1 : 0;
      fln = rstripChars(x2, "\\");
      continue;
    }
    if (nx === 1) {
      fcont = 0;
      if (fln) { mln += escField(fln); fln = ""; }
      if (mcont) { mcont = x2[x2.length - 1] === "\\" ? 1 : 0; mln += rstripChars(x2, "\\"); }
      else {
        if (mln) { xs.push(mln); mln = ""; }
        mcont = x2[x2.length - 1] === "\\" ? 1 : 0;
        mln = rstripChars(x2, "\\");
      }
      if (!mcont) { xs.push(mln); mln = ""; }
    }
  }
  if (fln) mln += escField(fln);
  if (mln) xs.push(mln);

  const hs = splitKeep(xs[0], /(\[K:[^\]]*\])/);
  let header: string;
  if (hs.length === 1) { header = hs[0]; xs[0] = ""; }
  else { header = hs[0] + hs[1]; xs[0] = hs.slice(2).join(""); }
  let abctext2 = xs.join("\n");
  const hfs: string[] = [], vfs: string[] = [];
  for (const x of header.slice(1, -1).split("][")) {
    if (x[0] === "V") vfs.push(x);
    else if (x.slice(0, 6) === "I:MIDI") vfs.push(x);
    else if (x.slice(0, 9) === "I:percmap") vfs.push(x);
    else hfs.push(x);
  }
  header = "[" + hfs.join("][") + "]";
  abctext2 = (vfs.length ? "[" + vfs.join("][") + "]" : "") + abctext2;

  let sp = abctext2.split("[V:");
  if (sp.length === 1) abctext2 = "[V:1]" + abctext2;
  else if (sp[0].replace(/\[[A-Z]:[^\]]*\]/g, "").trim()) abctext2 = "[V:1]" + abctext2;

  const rid = /\[V:\s*(\S*)[ \]]/;
  const vmap: Record<string, string[]> = {};
  const vorder: Record<string, number> = {};
  const xs2 = splitKeep(abctext2, /(\[V:[^\]]*\])/);
  if (xs2.length === 1) throw new Error("bugs ...");
  const pm = xs2[0].match(/\[P:.\]/g) || [];
  if (pm.length) xs2[2] = pm.join("") + xs2[2];
  header += xs2[0].replace(/\[P:.\]/g, "");
  let i = 1;
  while (i < xs2.length) {
    let vce = xs2[i];
    const abc = xs2[i + 1] ?? "";
    const mo = rid.exec(vce);
    let id = mo ? mo[1] : "";
    if (!id) { id = "1"; vce = "[V:1]"; }
    vmap[id] = (vmap[id] || []).concat([vce, abc]);
    if (!(id in vorder)) vorder[id] = i;
    i += 2;
  }
  const voices: [string, string][] = [];
  const ixs = Object.keys(vorder).map((id) => [vorder[id], id] as [number, string]).sort((a, b) => a[0] - b[0]);
  for (const [, id] of ixs) {
    let voice = vmap[id].join("");
    voice = fixSlurs(voice);
    voices.push([id, voice]);
  }
  return [header, voices];
}

// python re.split keeps the capturing group; JS String.split with capturing group does too.
function splitKeep(s: string, re: RegExp): string[] {
  return s.split(re);
}

// ---------------- part merging (multi-voice / grand staff) ----------------
function mergeMeasure(m1: Element, m2: Element, slur_offset: number, voice_offset: number, rOpt: boolean, is_grand = 0): void {
  for (const slr of m2.findall("note/notations/slur")) {
    const slrnum = parseInt(slr.get("number") as string, 10) + slur_offset;
    slr.set("number", String(slrnum));
  }
  for (const v of m2.findall("note/voice")) v.text = String(voice_offset + parseInt(v.text as string, 10));
  const ls1 = m1.findall("note/lyric");
  const lnum_max = maxOf(ls1.map((l) => parseInt(l.get("number") as string, 10)).concat([0]));
  for (const el of m2.findall("note/lyric")) {
    const n = parseInt(el.get("number") as string, 10);
    el.set("number", String(n + lnum_max));
  }
  const ns = m1.findall("note");
  let dur1 = sum(ns.filter((n) => n.find("grace") == null && n.find("chord") == null)
    .map((n) => parseInt(n.find("duration")!.text as string, 10)));
  dur1 -= sum(m1.findall("backup/duration").map((b) => parseInt(b.text as string, 10)));
  let nns = 0;
  const es: Element[] = [];
  for (const e of Array.from(m2)) {
    if (e.tag === "attributes") { if (!is_grand) continue; else nns += 1; }
    if (e.tag === "print") continue;
    if (e.tag === "note" && (rOpt || e.find("rest") == null)) nns += 1;
    es.push(e);
  }
  if (nns > 0) {
    if (dur1 > 0) {
      const b = E("backup");
      addElem(m1, b, 3);
      addElemT(b, "duration", String(dur1), 4);
    }
    for (const e of es) addElem(m1, e, 3);
  }
}
function mergePartList(parts: Element[], rOpt: boolean, is_grand = 0): Element {
  const delAttrs = (part: Element): void => {
    const xs: [Element, Element][] = [];
    for (const m of part.findall("measure")) for (const e of m.findall("attributes")) xs.push([m, e]);
    for (const [m, e] of xs) {
      for (const c of Array.from(e)) {
        if (c.tag === "clef") continue;
        if (c.tag === "staff-details") continue;
        e.remove(c);
      }
      if (e.length === 0) m.remove(e);
    }
  };
  const p1 = parts[0];
  for (const p2 of parts.slice(1)) {
    if (is_grand) delAttrs(p2);
    for (let i = p1.length + 1; i <= p2.length; i++) {
      const maat = E("measure", { number: String(i) });
      addElem(p1, maat, 2);
    }
    const slurs = p1.findall("measure/note/notations/slur");
    const slur_max = maxOf(slurs.map((slr) => parseInt(slr.get("number") as string, 10)).concat([0]));
    const vs = p1.findall("measure/note/voice");
    const vnum_max = maxOf(vs.map((v) => parseInt(v.text as string, 10)).concat([0]));
    p2.findall("measure").forEach((m2, im) => {
      mergeMeasure((p1 as any)._children[im], m2, slur_max, vnum_max, rOpt, is_grand);
    });
  }
  return p1;
}
function mergeParts(parts: Element[], vids: string[], staves: any[], rOpt: boolean, is_grand = 0): [Element[], string[]] {
  if (!staves || staves.length === 0) return [parts, vids];
  const partsnew: Element[] = [], vidsnew: string[] = [];
  for (const voice_ids of staves) {
    const pixs: number[] = [];
    for (const vid of voice_ids) {
      if (vids.indexOf(vid) >= 0) pixs.push(vids.indexOf(vid));
      else info("score partname " + vid + " does not exist");
    }
    if (pixs.length) {
      const xparts = pixs.map((pix) => parts[pix]);
      const mergedpart = xparts.length > 1 ? mergePartList(xparts, rOpt, is_grand) : xparts[0];
      partsnew.push(mergedpart);
      vidsnew.push(vids[pixs[0]]);
    }
  }
  return [partsnew, vidsnew];
}
function mergePartMeasure(part: Element, msre: Element, ovrlaynum: number, rOpt: boolean): void {
  const slurs = part.findall("measure/note/notations/slur");
  const slur_max = maxOf(slurs.map((slr) => parseInt(slr.get("number") as string, 10)).concat([0]));
  const last_msre = (part as any)._children[part.length - 1];
  mergeMeasure(last_msre, msre, slur_max, ovrlaynum, rOpt);
}
function setFristVoiceNameFromGroup(vids: string[], vdefs: Record<string, any>): Record<string, any> {
  vids = vids.filter((v) => v in vdefs);
  if (!vids.length) return vdefs;
  const vid0 = vids[0];
  const vdef0 = vdefs[vid0][2];
  for (const vid of vids) {
    const [nm, snm] = vdefs[vid];
    if (nm) { vdefs[vid0] = [nm, snm, vdef0]; break; }
  }
  return vdefs;
}
function mkGrand(p: any, vdefs: Record<string, any>): any[] {
  const xs: any[] = [];
  for (let i = 0; i < p.objs.length; i++) {
    const x = p.objs[i];
    if (x instanceof pObj) {
      const us = mkGrand(x, vdefs);
      if (x.name === "grand") {
        const vids = x.objs.slice(1).map((y: any) => y.objs[0]);
        const nms = vids.filter((u: string) => u in vdefs).map((u: string) => vdefs[u][0]);
        const accept = sum(nms.map((nm: string) => (nm ? 1 : 0))) === 1;
        if (accept || us[0] === "{*") {
          xs.push(us.slice(1));
          vdefs = setFristVoiceNameFromGroup(vids, vdefs);
          p.objs[i] = x.objs[1];
        } else xs.push(...us.slice(1));
      } else xs.push(...us);
    } else xs.push(p.t[0]);
  }
  return xs;
}
function mkStaves(p: any, vdefs: Record<string, any>): any[] {
  const xs: any[] = [];
  for (let i = 0; i < p.objs.length; i++) {
    const x = p.objs[i];
    if (x instanceof pObj) {
      const us = mkStaves(x, vdefs);
      if (x.name === "voicegr") {
        xs.push(us);
        const vids = x.objs.map((y: any) => y.objs[0]);
        vdefs = setFristVoiceNameFromGroup(vids, vdefs);
        p.objs[i] = x.objs[0];
      } else xs.push(...us);
    } else {
      if ("{*".indexOf(p.t[0]) < 0) xs.push(p.t[0]);
    }
  }
  return xs;
}
function mkGroups(p: any): any[] {
  const xs: any[] = [];
  for (const x of p.objs) {
    if (x instanceof pObj) {
      if (x.name === "vid") xs.push(...mkGroups(x));
      else if (x.name === "bracketgr") xs.push("[", ...mkGroups(x), "]");
      else if (x.name === "bracegr") xs.push("{", ...mkGroups(x), "}");
      else xs.push(...mkGroups(x), "}");
    } else xs.push(p.t[0]);
  }
  return xs;
}
function stepTrans(step: string, soct: number, clef: string): [string, number] {
  if (clef.startsWith("bass")) {
    const nm7 = "C,D,E,F,G,A,B".split(",");
    const n = 14 + nm7.indexOf(step) - 12;
    step = nm7[((n % 7) + 7) % 7];
    soct = soct + Math.floor(n / 7) - 2;
  }
  return [step, soct];
}
function reduceMids(parts: Element[], vidsnew: string[], midiInst: Record<string, any[]>): void {
  vidsnew.forEach((pid, idx) => {
    const part = parts[idx];
    const mids: Record<string, string> = {}, repls: Record<string, string> = {};
    let has_perc = 0;
    // iterate instruments in sorted order (python sorts by tuple value)
    const entries = Object.keys(midiInst).map((k) => [k, midiInst[k]] as [string, any[]])
      .sort((a, b) => cmpArr(a[1], b[1]));
    for (const [, v] of entries) {
      const [ipid, ivid, ch, prg] = v;
      if (ipid !== pid) continue;
      if (ch === "10") { has_perc = 1; continue; }
      const instId = "I" + ipid + "-" + ivid;
      const inst = ch + "" + prg;
      if (inst in mids) { repls[instId] = mids[inst]; delete midiInst[instId]; }
      else mids[inst] = instId;
    }
    if (Object.keys(mids).length < 2 && !has_perc) {
      removeElems(part, "measure/note", "instrument");
    } else {
      for (const e of part.findall("measure/note/instrument")) {
        const id = e.get("id") as string;
        if (id in repls) e.set("id", repls[id]);
      }
    }
  });
}
function cmpArr(a: any[], b: any[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// ---------------- string allocation for tab staves ----------------
class stringAlloc {
  snaarVrij: [number, number][][] = [];
  snaarIx: number[] = [];
  curstaff = -1;
  beginZoek(): void {
    this.snaarIx = [];
    for (let i = 0; i < this.snaarVrij.length; i++) this.snaarIx.push(0);
  }
  setlines(stflines: number, stfnum: string): void {
    if (stfnum !== (this.curstaff as any)) {
      this.curstaff = stfnum as any;
      this.snaarVrij = [];
      for (let i = 0; i < stflines; i++) this.snaarVrij.push([]);
      this.beginZoek();
    }
  }
  isVrij(snaar: number, t1: number, t2: number): number {
    const xs = this.snaarVrij[snaar];
    for (let i = this.snaarIx[snaar]; i < xs.length; i++) {
      const [tb, te] = xs[i];
      if (t1 >= te) continue;
      if (t1 >= tb) { this.snaarIx[snaar] = i; return 0; }
      if (t2 > tb) { this.snaarIx[snaar] = i; return 0; }
      this.snaarIx[snaar] = i;
      xs.splice(i, 0, [t1, t2]);
      return 1;
    }
    xs.push([t1, t2]);
    this.snaarIx[snaar] = xs.length - 1;
    return 1;
  }
  bezet(snaar: number, t1: number, t2: number): void {
    const xs = this.snaarVrij[snaar];
    for (let i = 0; i < xs.length; i++) {
      const [, te] = xs[i];
      if (t1 >= te) continue;
      xs.splice(i, 0, [t1, t2]);
      return;
    }
    xs.push([t1, t2]);
  }
}

// mxm holds the active MusicXml instance (set by parse); referenced by module helpers.
export let mxm: any = { orderChords: 0, metaMap: {}, metadata: {} };

// grammar cache (like the python globals abc_header / abc_voice / ...)
let GRAMMAR: Grammar | null = null;
function grammar(): Grammar {
  if (!GRAMMAR) GRAMMAR = abc_grammar();
  return GRAMMAR;
}

// ==== MusicXml constant maps ====
const typeMap: Record<number, string> = { 1: "long", 2: "breve", 4: "whole", 8: "half", 16: "quarter", 32: "eighth", 64: "16th", 128: "32nd", 256: "64th" };
const typeMapKeys = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const dynaMap: Record<string, number> = { p: 1, pp: 1, ppp: 1, pppp: 1, f: 1, ff: 1, fff: 1, ffff: 1, mp: 1, mf: 1, sfz: 1 };
const tempoMap: Record<string, number> = { larghissimo: 40, moderato: 104, adagissimo: 44, allegretto: 112, lentissimo: 48, allegro: 120, largo: 56, vivace: 168, adagio: 59, vivo: 180, lento: 62, presto: 192, larghetto: 66, allegrissimo: 208, adagietto: 76, vivacissimo: 220, andante: 88, prestissimo: 240, andantino: 96 };
const wedgeMap: Record<string, number> = { ">(": 1, ">)": 1, "<(": 1, "<)": 1, "crescendo(": 1, "crescendo)": 1, "diminuendo(": 1, "diminuendo)": 1 };
const artMap: Record<string, string> = { ".": "staccato", ">": "accent", accent: "accent", wedge: "staccatissimo", tenuto: "tenuto", breath: "breath-mark", marcato: "strong-accent", "^": "strong-accent", slide: "scoop" };
const ornMap: Record<string, string> = { trill: "trill-mark", T: "trill-mark", turn: "turn", uppermordent: "inverted-mordent", lowermordent: "mordent", pralltriller: "inverted-mordent", mordent: "mordent", invertedturn: "inverted-turn" };
const tecMap: Record<string, string> = { upbow: "up-bow", downbow: "down-bow", plus: "stopped", open: "open-string", snap: "snap-pizzicato", thumb: "thumb-position" };
const capoMap: Record<string, [string, string, string]> = { fine: ["Fine", "fine", "yes"], "D.S.": ["D.S.", "dalsegno", "segno"], "D.C.": ["D.C.", "dacapo", "yes"], dacapo: ["D.C.", "dacapo", "yes"], dacoda: ["To Coda", "tocoda", "coda"], coda: ["coda", "coda", "coda"], segno: ["segno", "segno", "segno"] };
const sharpness = ["Fb", "Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#", "E#", "B#"];
const offTab: Record<string, number> = { maj: 8, m: 11, min: 11, mix: 9, dor: 10, phr: 12, lyd: 7, loc: 13 };
const modTab: Record<string, string> = { maj: "major", m: "minor", min: "minor", mix: "mixolydian", dor: "dorian", phr: "phrygian", lyd: "lydian", loc: "locrian" };
const clefMap: Record<string, [string, string]> = { alto1: ["C", "1"], alto2: ["C", "2"], alto: ["C", "3"], alto4: ["C", "4"], tenor: ["C", "4"], bass3: ["F", "3"], bass: ["F", "4"], treble: ["G", "2"], perc: ["percussion", ""], none: ["", ""], tab: ["TAB", "5"] };
const clefLineMap: Record<string, string> = { B: "treble", G: "alto1", E: "alto2", C: "alto", A: "tenor", F: "bass3", D: "bass" };
const alterTab: Record<string, string> = { "=": "0", "_": "-1", "__": "-2", "^": "1", "^^": "2" };
const accTab: Record<string, string> = { "=": "natural", "_": "flat", "__": "flat-flat", "^": "sharp", "^^": "sharp-sharp" };
const chordTab = compChordTab();
const uSyms: Record<string, string> = { "~": "roll", H: "fermata", L: ">", M: "lowermordent", O: "coda", P: "uppermordent", S: "segno", T: "trill", u: "upbow", v: "downbow" };
const pageFmtDef = [0.75, 297, 210, 18, 18, 10, 10];
const metaTab: Record<string, string> = { O: "origin", A: "area", Z: "transcription", N: "notes", G: "group", H: "history", R: "rhythm", B: "book", D: "discography", F: "fileurl", S: "source", P: "partmap", W: "lyrics" };
const metaTypes: Record<string, number> = { composer: 1, lyricist: 1, poet: 1, arranger: 1, translator: 1, rights: 1 };
const tuningDef = "E2,A2,D3,G3,B3,E4".split(",");
const CH10 = "acoustic-bass-drum,35;bass-drum-1,36;side-stick,37;acoustic-snare,38;hand-clap,39;electric-snare,40;low-floor-tom,41;closed-hi-hat,42;high-floor-tom,43;pedal-hi-hat,44;low-tom,45;open-hi-hat,46;low-mid-tom,47;hi-mid-tom,48;crash-cymbal-1,49;high-tom,50;ride-cymbal-1,51;chinese-cymbal,52;ride-bell,53;tambourine,54;splash-cymbal,55;cowbell,56;crash-cymbal-2,57;vibraslap,58;ride-cymbal-2,59;hi-bongo,60;low-bongo,61;mute-hi-conga,62;open-hi-conga,63;low-conga,64;high-timbale,65;low-timbale,66;high-agogo,67;low-agogo,68;cabasa,69;maracas,70;short-whistle,71;long-whistle,72;short-guiro,73;long-guiro,74;claves,75;hi-wood-block,76;low-wood-block,77;mute-cuica,78;open-cuica,79;mute-triangle,80;open-triangle,81";

const PC = [0, 2, 4, 5, 7, 9, 11]; // 'CDEFGAB' pitch classes

// tuple-keyed map (python dict with tuple keys)
class TMap {
  m = new Map<string, { k: any[]; v: any }>();
  private key(k: any[]): string { return k.map((x) => typeof x + ":" + x).join("|"); }
  has(k: any[]): boolean { return this.m.has(this.key(k)); }
  get(k: any[], def: any = undefined): any { const e = this.m.get(this.key(k)); return e ? e.v : def; }
  set(k: any[], v: any): void { this.m.set(this.key(k), { k: k.slice(), v }); }
  del(k: any[]): void { this.m.delete(this.key(k)); }
  items(): [any[], any][] { return [...this.m.values()].map((e) => [e.k, e.v] as [any[], any]); }
  get size(): number { return this.m.size; }
}
function zipMap(keys: any[], val: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of keys) m.set(k, val);
  return m;
}
function evalBeats(s: string): number {
  // supports M: like "2+3/4" numerator "2+3" -> sum
  return sum(s.split("+").map((x) => parseInt(x.trim(), 10) || 0));
}

// ==== MusicXml ====
class MusicXml {
  [k: string]: any;
  constructor() {
    this.pageFmtCmd = [];
    this.reset();
  }
  reset(fOpt = false): void {
    this.divisions = 120;
    this.ties = new TMap();
    this.slurstack = [];
    this.slurbeg = [];
    this.tmnum = 0; this.tmden = 0; this.ntup = 0; this.trem = 0; this.intrem = 0;
    this.tupnts = []; this.irrtup = 0; this.ntype = "";
    this.unitL = [1, 8]; this.unitLcur = [1, 8];
    this.keyAlts = new Map<string, string>();
    this.msreAlts = new TMap();
    this.curVolta = "";
    this.title = "";
    this.creator = {};
    this.metadata = {};
    this.metaMap = { C: "composer" };
    this.lyrdash = {};
    this.usrSyms = { ...uSyms };
    this.prevNote = null;
    this.grcbbrk = false;
    this.linebrk = 0;
    this.nextdecos = [];
    this.prevmsre = null;
    this.supports_tag = 0;
    this.staveDefs = [];
    this.staves = [];
    this.groups = [];
    this.grands = [];
    this.gStaffNums = new Map<string, number>();
    this.gNstaves = new Map<string, number>();
    this.pageFmtAbc = [];
    this.mdur = [4, 4];
    this.gtrans = 0;
    this.midprg = ["", "", "", ""];
    this.vid = ""; this.pid = "";
    this.gcue_on = 0;
    this.percVoice = 0;
    this.percMap = new TMap();
    this.pMapFound = 0;
    this.vcepid = new Map<string, string>();
    this.midiInst = {};
    this.capo = 0;
    this.tunmid = []; this.tunTup = [];
    this.fOpt = fOpt;
    this.orderChords = 0;
    this.chordDecos = {};
    this.percsnd = CH10.split(";").map((x) => x.split(","));
    this.gTime = [0, 0];
    this.tabStaff = "";
    this.overlayVnum = 0;
    this.glisnum = 0; this.slidenum = 0;
    this.acciatura = 0;
    this.nostems = 0;
    this.curClef = "";
    this.tuning = tuningDef;
    this.diafret = 0;
    this.gStaffNumsOrg = new Map<string, number>();
  }

  mkPitch(acc: string, note: string, oct: any, lev: number): [Element, string, string, string] {
    if (this.percVoice) {
      const octq = parseInt(oct, 10) + this.gtrans;
      const tup = this.percMap.get([this.pid, acc + note, octq], this.percMap.get(["", acc + note, octq], 0));
      let step: string, soct: any, midi: any = "", notehead: any = "";
      if (tup) { [step, soct, midi, notehead] = tup; } else { step = note; soct = octq; }
      let octnum = (step.toUpperCase() === step ? 4 : 5) + parseInt(soct, 10);
      if (!tup) {
        midi = String(octnum * 12 + PC["CDEFGAB".indexOf(step.toUpperCase())] + (({ "^": 1, "_": -1 } as any)[acc] ?? 0) + 12);
        notehead = ({ "^": "x", "_": "circle-x" } as any)[acc] ?? "normal";
        if (this.pMapFound) info("no I:percmap for: " + acc + note);
        this.percMap.set([this.pid, acc + note, octq], [note, octq, midi, notehead]);
      } else {
        [step, octnum] = stepTrans(step.toUpperCase(), octnum, this.curClef);
      }
      const pitch = E("unpitched");
      addElemT(pitch, "display-step", step.toUpperCase(), lev + 1);
      addElemT(pitch, "display-octave", String(octnum), lev + 1);
      return [pitch, "", midi, notehead];
    }
    const nUp = note.toUpperCase();
    const octnum = (nUp === note ? 4 : 5) + parseInt(oct, 10) + this.gtrans;
    const pitch = E("pitch");
    addElemT(pitch, "step", nUp, lev + 1);
    let alter = "";
    if (this.ties.has([note, oct])) {
      const [tied_alter, , vnum] = this.ties.get([note, oct]);
      if (vnum === this.overlayVnum) alter = tied_alter;
    } else if (acc) {
      this.msreAlts.set([nUp, octnum], alterTab[acc]);
      alter = alterTab[acc];
    } else if (this.msreAlts.has([nUp, octnum])) alter = this.msreAlts.get([nUp, octnum]);
    else if (this.keyAlts.has(nUp)) alter = this.keyAlts.get(nUp) as string;
    if (alter) addElemT(pitch, "alter", alter, lev + 1);
    addElemT(pitch, "octave", String(octnum), lev + 1);
    return [pitch, alter, "", ""];
  }

  getNoteDecos(n: any): string[] {
    let decos: string[] = this.nextdecos;
    const ndeco = getattr(n, "deco", 0);
    if (ndeco) decos = decos.concat(ndeco.t.map((d: string) => stripChars(this.usrSyms[d] ?? d, "!+")));
    this.nextdecos = [];
    if (this.tabStaff === this.pid && this.fOpt && n.name !== "rest") {
      if (decos.filter((d) => "0123456789".indexOf(d) >= 0).length === 0) decos.push("0");
    }
    return decos;
  }

  mkNote(n: any, lev: number): Element {
    const isgrace = getattr(n, "grace", "");
    const ischord = getattr(n, "chord", "");
    if (this.ntup >= 0 && !isgrace && !ischord) {
      this.ntup -= 1;
      if (this.ntup === -1 && this.trem <= 0) this.intrem = 0;
    }
    let [nnum, nden] = n.dur.t;
    if (this.intrem) nnum += nnum;
    if (nden === 0) nden = 1;
    let [num, den] = simplify(nnum * this.unitLcur[0], nden * this.unitLcur[1]);
    if (den > 64) {
      num = Math.round(64 * num / den);
      [num, den] = simplify(Math.max(num, 1), 64);
      info("duration too small: rounded");
    }
    if (n.name === "rest" && (n.t.indexOf("Z") >= 0 || n.t.indexOf("X") >= 0)) { [num, den] = this.mdur; }
    let dvs = Math.trunc(4 * this.divisions * num / den);
    let rdvs = dvs;
    [num, den] = simplify(num, den * 4);
    let ndot = 0;
    if (num === 3) { ndot = 1; den = Math.trunc(den / 2); }
    if (num === 7) { ndot = 2; den = Math.trunc(den / 4); }
    const nt = E("note");
    if (isgrace) {
      const grace = E("grace");
      if (this.acciatura) { grace.set("slash", "yes"); this.acciatura = 0; }
      addElem(nt, grace, lev + 1);
      dvs = rdvs = 0;
      if (den <= 16) den = 32;
    }
    if (this.gcue_on) addElem(nt, E("cue"), lev + 1);
    if (ischord) { addElem(nt, E("chord"), lev + 1); rdvs = 0; }
    if (!(den in typeMap)) {
      info("illegal duration");
      den = Math.min(...typeMapKeys.filter((x) => x > den));
    }
    const xmltype = String(typeMap[den]);
    let acc = "", step = "C", oct: any = "0";
    let alter = "", midi = "", notehead = "";
    if (n.name === "rest") {
      if (n.t.indexOf("x") >= 0 || n.t.indexOf("X") >= 0) nt.set("print-object", "no");
      addElem(nt, E("rest"), lev + 1);
    } else {
      const p = n.pitch.t;
      if (p.length === 3) { [acc, step, oct] = p; } else { [step, oct] = p; }
      let pitch: Element;
      [pitch, alter, midi, notehead] = this.mkPitch(acc, step, oct, lev + 1);
      if (midi) acc = "";
      addElem(nt, pitch, lev + 1);
    }
    if (this.ntup >= 0) dvs = Math.trunc(dvs * this.tmden / this.tmnum);
    if (dvs) {
      addElemT(nt, "duration", String(dvs), lev + 1);
      if (!ischord) this.gTime = [this.gTime[1], this.gTime[1] + dvs];
    }
    if ((!arraysEq(this.midprg, ["", "", "", ""]) || midi) && n.name !== "rest") {
      const instId = "I" + this.pid + "-" + (midi ? "X" + midi : this.vid);
      let chan: string;
      if (midi) { chan = "10"; } else { chan = this.midprg[0]; midi = this.midprg[1]; }
      const inst = E("instrument", { id: instId });
      addElem(nt, inst, lev + 1);
      if (!(instId in this.midiInst)) this.midiInst[instId] = [this.pid, this.vid, chan, midi, this.midprg[2], this.midprg[3]];
    }
    addElemT(nt, "voice", "1", lev + 1);
    addElemT(nt, "type", xmltype, lev + 1);
    for (let i = 0; i < ndot; i++) addElem(nt, E("dot"), lev + 1);
    const ptup = [step, oct];
    const tstop = this.ties.has(ptup) && this.ties.get(ptup)[2] === this.overlayVnum;
    const decos = this.getNoteDecos(n);
    if (acc && !tstop) {
      const e = E("accidental");
      if (decos.indexOf("courtesy") >= 0) { e.set("parentheses", "yes"); decos.splice(decos.indexOf("courtesy"), 1); }
      e.text = accTab[acc];
      addElem(nt, e, lev + 1);
    }
    let tupnotation = "";
    if (this.ntup >= 0) {
      const tmod = mkTmod(this.tmnum, this.tmden, lev + 1);
      addElem(nt, tmod, lev + 1);
      if (this.ntup > 0 && !this.tupnts.length) tupnotation = "start";
      this.tupnts.push([rdvs, tmod]);
      if (this.ntup === 0) {
        if (rdvs) tupnotation = "stop";
        this.cmpNormType(rdvs, lev + 1);
      }
    }
    let hasStem = 1;
    if (!ischord) this.chordDecos = {};
    if (decos.indexOf("stemless") >= 0 || (this.nostems && n.name !== "rest") || "stemless" in this.chordDecos) {
      hasStem = 0;
      addElemT(nt, "stem", "none", lev + 1);
      if (decos.indexOf("stemless") >= 0) decos.splice(decos.indexOf("stemless"), 1);
      if (hasattr(n, "pitches")) this.chordDecos["stemless"] = 1;
    }
    if (notehead) {
      const nh = addElemT(nt, "notehead", notehead.replace(/[+-]$/, ""), lev + 1);
      if ("+-".indexOf(notehead[notehead.length - 1]) >= 0) nh.set("filled", notehead[notehead.length - 1] === "+" ? "yes" : "no");
    }
    const gstaff = this.gStaffNums.get(this.vid) ?? 0;
    if (gstaff) addElemT(nt, "staff", String(gstaff), lev + 1);
    if (hasStem) this.doBeams(n, nt, den, lev + 1);
    this.doNotations(n, decos, ptup, alter, tupnotation, tstop, nt, lev + 1);
    if (n.objs.length) this.doLyr(n, nt, lev + 1);
    return nt;
  }

  cmpNormType(rdvs: number, lev: number): void {
    if (rdvs) {
      const durs = this.tupnts.filter(([dur]: any) => dur > 0).map(([dur]: any) => dur);
      const ndur = Math.trunc(sum(durs) / this.tmnum);
      this.irrtup = durs.some((dur: number) => dur !== ndur) ? 1 : 0;
      const tix = Math.trunc(16 * this.divisions / ndur);
      if (tix in typeMap) this.ntype = String(typeMap[tix]);
      else this.irrtup = 0;
    }
    if (this.irrtup) for (const [, tmod] of this.tupnts) addElemT(tmod, "normal-type", this.ntype, lev + 1);
    this.tupnts = [];
  }

  doNotations(n: any, decos: string[], ptup: any[], alter: string, tupnotation: string, tstop: boolean, nt: Element, lev: number): any {
    let slurs = getattr(n, "slurs", 0);
    let pts: any = getattr(n, "pitches", []);
    if (pts && pts.length !== 0 && pts !== 0) {
      if (pts.pitch instanceof pObj) pts = [pts.pitch];
      else pts = pts.pitch.map((p: any) => p.t.slice(-2));
    } else pts = [];
    for (const [pt, val] of this.ties.items().sort((a: any, b: any) => cmpArr(a[0], b[0]))) {
      const [, nts, vnum] = val;
      if (vnum !== this.overlayVnum) continue;
      if (pts.length && pts.some((p: any) => cmpArr(p, pt) === 0)) continue;
      if (getattr(n, "chord", 0)) continue;
      if (cmpArr(pt, ptup) === 0) continue;
      if (getattr(n, "grace", 0)) continue;
      info("tie between different pitches converted to slur");
      this.ties.del(pt);
      const e = nts.findall("tied").filter((t: Element) => t.get("type") === "start")[0];
      e.tag = "slur";
      const slurnum = this.slurstack.length + 1;
      this.slurstack.push(slurnum);
      e.set("number", String(slurnum));
      if (slurs) slurs.t.push(")");
      else slurs = new pObj("slurs", [")"]);
    }
    const tstart = getattr(n, "tie", 0);
    if (!(tstop || tstart || decos.length || slurs || this.slurbeg.length || tupnotation || this.trem)) return nt;
    const nots = E("notations");
    if (this.trem) {
      if (this.trem < 0) { tupnotation = "single"; this.trem = -this.trem; }
      if (!tupnotation) return;
      const orn = E("ornaments");
      const trm = E("tremolo", { type: tupnotation });
      trm.text = String(this.trem);
      addElem(nots, orn, lev + 1);
      addElem(orn, trm, lev + 2);
      if (tupnotation === "stop" || tupnotation === "single") this.trem = 0;
    } else if (tupnotation) {
      const tup = E("tuplet", { type: tupnotation });
      if (tupnotation === "start") tup.set("bracket", "yes");
      addElem(nots, tup, lev + 1);
    }
    if (tstop) {
      this.ties.del(ptup);
      addElem(nots, E("tied", { type: "stop" }), lev + 1);
    }
    if (tstart) {
      this.ties.set(ptup, [alter, nots, this.overlayVnum]);
      const tie = E("tied", { type: "start" });
      if (tstart.t[0] === ".-") tie.set("line-type", "dotted");
      addElem(nots, tie, lev + 1);
    }
    if (decos.length) {
      const slurMap: Record<string, number> = { "(": 1, ".(": 1, "(,": 1, "('": 1, ".(,": 1, ".('": 1 };
      const arts: string[] = [];
      for (const d of decos) {
        let ntn: Element;
        if (d in slurMap) { this.slurbeg.push(d); continue; }
        else if (d === "fermata" || d === "H") ntn = E("fermata", { type: "upright" });
        else if (d === "arpeggio") ntn = E("arpeggiate", { number: "1" });
        else if (d === "~(" || d === "~)") {
          let tp: string, gn: number;
          if (d[1] === "(") { tp = "start"; this.glisnum += 1; gn = this.glisnum; }
          else { tp = "stop"; gn = this.glisnum; this.glisnum -= 1; }
          if (this.glisnum < 0) { this.glisnum = 0; continue; }
          ntn = E("glissando", { "line-type": "wavy", number: String(gn), type: tp });
        } else if (d === "-(" || d === "-)") {
          let tp: string, gn: number;
          if (d[1] === "(") { tp = "start"; this.slidenum += 1; gn = this.slidenum; }
          else { tp = "stop"; gn = this.slidenum; this.slidenum -= 1; }
          if (this.slidenum < 0) { this.slidenum = 0; continue; }
          ntn = E("slide", { "line-type": "solid", number: String(gn), type: tp });
        } else { arts.push(d); continue; }
        addElem(nots, ntn, lev + 1);
      }
      if (arts.length) {
        const rest = this.doArticulations(nt, nots, arts, lev + 1);
        if (rest.length) info("unhandled note decorations: " + rest);
      }
    }
    if (slurs) {
      for (const _d of slurs.t) {
        if (!this.slurstack.length) break;
        const slurnum = this.slurstack.pop();
        addElem(nots, E("slur", { number: String(slurnum), type: "stop" }), lev + 1);
      }
    }
    while (this.slurbeg.length) {
      const stp = this.slurbeg.shift();
      const slurnum = this.slurstack.length + 1;
      this.slurstack.push(slurnum);
      const ntn = E("slur", { number: String(slurnum), type: "start" });
      if (stp.indexOf(".") >= 0) ntn.set("line-type", "dotted");
      if (stp.indexOf(",") >= 0) ntn.set("placement", "below");
      if (stp.indexOf("'") >= 0) ntn.set("placement", "above");
      addElem(nots, ntn, lev + 1);
    }
    if (nots.length !== 0) addElem(nt, nots, lev);
  }

  doArticulations(nt: Element, nots: Element, arts: string[], lev: number): string[] {
    const decos: string[] = [];
    for (let a of arts) {
      if (a in artMap) {
        const art = E("articulations");
        addElem(nots, art, lev);
        addElem(art, E(artMap[a]), lev + 1);
      } else if (a in ornMap) {
        const orn = E("ornaments");
        addElem(nots, orn, lev);
        addElem(orn, E(ornMap[a]), lev + 1);
      } else if (a === "trill(" || a === "trill)") {
        const orn = E("ornaments");
        addElem(nots, orn, lev);
        const type = a.endsWith("(") ? "start" : "stop";
        if (type === "start") addElem(orn, E("trill-mark"), lev + 1);
        addElem(orn, E("wavy-line", { type }), lev + 1);
      } else if (a in tecMap) {
        const tec = E("technical");
        addElem(nots, tec, lev);
        addElem(tec, E(tecMap[a]), lev + 1);
      } else if ("0123456".indexOf(a) >= 0 && a !== "") {
        const tec = E("technical");
        addElem(nots, tec, lev);
        if (this.tabStaff === this.pid) {
          const alt = parseInt(nt.findtext("pitch/alter") || "0", 10);
          const step = nt.findtext("pitch/step") as string;
          const oct = parseInt(nt.findtext("pitch/octave") as string, 10);
          const midi = oct * 12 + PC["CDEFGAB".indexOf(step)] + alt + 12;
          let isvrij: any = 1;
          if (a === "0") {
            let firstFit = "";
            for (const [smid, istr] of this.tunTup) {
              if (midi >= smid) {
                isvrij = this.strAlloc.isVrij(istr - 1, this.gTime[0], this.gTime[1]);
                a = String(istr);
                if (!firstFit) firstFit = a;
                if (isvrij) break;
              }
            }
            if (!isvrij) { a = firstFit; this.strAlloc.bezet(parseInt(a, 10) - 1, this.gTime[0], this.gTime[1]); }
          } else this.strAlloc.bezet(parseInt(a, 10) - 1, this.gTime[0], this.gTime[1]);
          const bmidi = this.tunmid[parseInt(a, 10) - 1];
          const fret = midi - bmidi;
          if (fret < 25 && fret >= 0) addElemT(tec, "fret", String(fret), lev + 1);
          else info("fret out of range");
          addElemT(tec, "string", a, lev + 1);
        } else addElemT(tec, "fingering", a, lev + 1);
      } else decos.push(a);
    }
    return decos;
  }

  doLyr(n: any, nt: Element, lev: number): void {
    n.objs.forEach((lyrobj: any, i: number) => {
      if (lyrobj.name !== "syl") return;
      const dash = lyrobj.t.length === 2;
      let type: string;
      if (dash) {
        if (i in this.lyrdash) type = "middle";
        else { type = "begin"; this.lyrdash[i] = 1; }
      } else {
        if (i in this.lyrdash) { type = "end"; delete this.lyrdash[i]; }
        else type = "single";
      }
      const lyrel = E("lyric", { number: String(i + 1) });
      addElem(nt, lyrel, lev);
      addElemT(lyrel, "syllabic", type, lev + 1);
      let txt = lyrobj.t[0];
      txt = txt.replace(/(?<!\\)~/g, " ");
      txt = txt.replace(/\\(.)/g, "$1");
      addElemT(lyrel, "text", txt, lev + 1);
    });
  }

  doBeams(n: any, nt: Element, den: number, lev: number): void {
    if (hasattr(n, "chord") || hasattr(n, "grace")) {
      this.grcbbrk = this.grcbbrk || n.bbrk.t[0];
      return;
    }
    const bbrk = this.grcbbrk || n.bbrk.t[0] || den < 32;
    this.grcbbrk = false;
    let pbm: Element | null = null;
    if (this.prevNote) pbm = this.prevNote.find("beam");
    const bm = E("beam", { number: "1" });
    bm.text = "begin";
    if (pbm != null) {
      if (bbrk) {
        if (pbm.text === "begin") this.prevNote.remove(pbm);
        else if (pbm.text === "continue") pbm.text = "end";
        this.prevNote = null;
      } else bm.text = "continue";
    }
    if (den >= 32 && n.name !== "rest") {
      addElem(nt, bm, lev);
      this.prevNote = nt;
    }
  }

  stopBeams(): void {
    if (!this.prevNote) return;
    const pbm = this.prevNote.find("beam");
    if (pbm != null) {
      if (pbm.text === "begin") this.prevNote.remove(pbm);
      else if (pbm.text === "continue") pbm.text = "end";
    }
    this.prevNote = null;
  }

  staffDecos(decos: string[], maat: Element, lev: number): void {
    const gstaff = this.gStaffNums.get(this.vid) ?? 0;
    for (let d of decos) {
      d = stripChars(this.usrSyms[d] ?? d, "!+");
      if (d in dynaMap) {
        addDirection(maat, E("dynamics"), lev, gstaff, [E(d)], "below", this.gcue_on);
      } else if (d in wedgeMap) {
        let type: string;
        if (d.indexOf(")") >= 0) type = "stop";
        else type = (d.indexOf("<") >= 0 || d.indexOf("crescendo") >= 0) ? "crescendo" : "diminuendo";
        addDirection(maat, E("wedge", { type }), lev, gstaff);
      } else if (d.startsWith("8v")) {
        let type: string, plce: string;
        if (d.indexOf("a") >= 0) { type = "down"; plce = "above"; } else { type = "up"; plce = "below"; }
        if (d.indexOf(")") >= 0) type = "stop";
        addDirection(maat, E("octave-shift", { type, size: "8" }), lev, gstaff, [], plce);
      } else if (d === "ped" || d === "ped-up") {
        const type = d.endsWith("up") ? "stop" : "start";
        addDirection(maat, E("pedal", { type }), lev, gstaff);
      } else if (d === "coda" || d === "segno") {
        const [text, attr, val] = capoMap[d];
        const dir = addDirection(maat, E(text), lev, gstaff, [], "above");
        const sound = E("sound"); sound.set(attr, val);
        addElem(dir, sound, lev + 1);
      } else if (d in capoMap) {
        const [text, attr, val] = capoMap[d];
        const words = E("words"); words.text = text;
        const dir = addDirection(maat, words, lev, gstaff, [], "above");
        const sound = E("sound"); sound.set(attr, val);
        addElem(dir, sound, lev + 1);
      } else if (d === "(" || d === ".(") this.slurbeg.push(d);
      else if (["/-", "//-", "///-", "////-"].indexOf(d) >= 0) {
        this.tmnum = 2; this.tmden = 1; this.ntup = 2; this.trem = d.length - 1; this.intrem = 1;
      } else if (["/", "//", "///"].indexOf(d) >= 0) this.trem = -d.length;
      else this.nextdecos.push(d);
    }
  }

  doFields(maat: Element, fieldmap: Map<string, string>, lev: number): void {
    const atts: [number, Element][] = [];
    let gstaff = this.gStaffNums.get(this.vid) ?? 0;
    const instDir = (midelm: string, midnum: string, dirtxt: string): void => {
      const instId = "I" + this.pid + "-" + this.vid;
      const words = E("words"); words.text = dirtxt.replace("%s", midnum);
      const snd = E("sound");
      const mi = E("midi-instrument", { id: instId });
      const dir = addDirection(maat, words, lev, gstaff, [], "above");
      addElem(dir, snd, lev + 1);
      addElem(snd, mi, lev + 2);
      addElemT(mi, midelm, midnum, lev + 3);
    };
    const addTrans = (n: string): void => {
      const e = E("transpose");
      addElemT(e, "chromatic", n, lev + 2);
      atts.push([9, e]);
    };
    const doClef = (field: string): void => {
      if (/perc|map/.test(field)) {
        const r = /(perc|map)\s*=\s*(\S*)/.exec(field);
        this.percVoice = r && ["on", "true", "perc"].indexOf(r[2]) < 0 ? 0 : 1;
        field = field.replace(/(perc|map)\s*=\s*(\S*)/g, "");
      }
      let clef: any = 0, gtrans = 0;
      const clefn = /alto1|alto2|alto4|alto|tenor|bass3|bass|treble|perc|none|tab/.exec(field);
      const clefm = /(?:^m=| m=|middle=)([A-Ga-g])([,']*)/.exec(field);
      const trans_oct2 = /octave=([-+]?\d)/.exec(field);
      const trans = /(?:^t=| t=|transpose=)(-?[\d]+)/.exec(field);
      const trans_oct = /([+-^_])(8|15)/.exec(field);
      const cue_onoff = /cue=(on|off)/.exec(field);
      const strings = /strings=(\S+)/.exec(field);
      const stafflines = /stafflines=\s*(\d)/.exec(field);
      const capo = /capo=(\d+)/.exec(field);
      if (clefn) clef = clefn[0];
      if (clefm) {
        const note = clefm[1], octstr = clefm[2];
        const nUp = note.toUpperCase();
        const octnum = (nUp === note ? 4 : 5) + (octstr.indexOf("'") >= 0 ? octstr.length : -octstr.length);
        gtrans = ("AFD".indexOf(nUp) >= 0 ? 3 : 4) - octnum;
        if (clef !== "perc" && clef !== "none") clef = clefLineMap[nUp];
      }
      if (clef) {
        this.gtrans = gtrans;
        if (clef !== "none") this.curClef = clef;
        const [sign, line] = clefMap[clef];
        if (!sign) return;
        const c = E("clef");
        if (gstaff) c.set("number", String(gstaff));
        addElemT(c, "sign", sign, lev + 2);
        if (line) addElemT(c, "line", line, lev + 2);
        if (trans_oct) {
          let nn = ("-_".indexOf(trans_oct[1]) >= 0) ? -1 : 1;
          if (trans_oct[2] === "15") nn *= 2;
          addElemT(c, "clef-octave-change", String(nn), lev + 2);
          if ("+-".indexOf(trans_oct[1]) >= 0) this.gtrans += nn;
        }
        atts.push([7, c]);
      }
      if (trans_oct2) { const nn = parseInt(trans_oct2[1], 10); this.gtrans = gtrans + nn; }
      if (trans != null) {
        const e = E("transpose");
        addElemT(e, "chromatic", String(trans[1]), lev + 3);
        atts.push([9, e]);
      }
      if (cue_onoff) this.gcue_on = cue_onoff[1] === "on" ? 1 : 0;
      let nlines: any = 0;
      if (clef === "tab") {
        this.tabStaff = this.pid;
        if (capo) this.capo = parseInt(capo[1], 10);
        if (strings) this.tuning = strings[1].split(",");
        this.tunmid = this.tuning.map((bt: string) => parseInt(bt[1], 10) * 12 + PC["CDEFGAB".indexOf(bt[0])] + 12 + this.capo);
        this.tunTup = this.tunmid.map((mid: number, i: number) => [mid, this.tunmid.length - i]).sort((a: any, b: any) => cmpArr(b, a));
        this.tunmid.reverse();
        nlines = String(this.tuning.length);
        this.strAlloc.setlines(this.tuning.length, this.pid);
        this.nostems = field.indexOf("nostems") >= 0 ? 1 : 0;
        this.diafret = field.indexOf("diafret") >= 0 ? 1 : 0;
      }
      if (stafflines || nlines) {
        const e = E("staff-details");
        if (gstaff) e.set("number", String(gstaff));
        if (!nlines) nlines = (stafflines as RegExpExecArray)[1];
        addElemT(e, "staff-lines", nlines, lev + 2);
        if (clef === "tab") {
          this.tuning.forEach((t: string, line: number) => {
            const st = E("staff-tuning", { line: String(line + 1) });
            addElemT(st, "tuning-step", t[0], lev + 3);
            addElemT(st, "tuning-octave", t[1], lev + 3);
            addElem(e, st, lev + 2);
          });
        }
        if (this.capo) addElemT(e, "capo", String(this.capo), lev + 2);
        atts.push([8, e]);
      }
    };
    this.diafret = 0;
    for (const [ftype, field] of fieldmap) {
      if (!field) continue;
      if (ftype === "Div") { const d = E("divisions"); d.text = field; atts.push([1, d]); }
      else if (ftype === "gstaff") { const e = E("staves"); e.text = String(field); atts.push([4, e]); }
      else if (ftype === "M") {
        let fld = field;
        if (fld === "none") continue;
        if (fld === "C") fld = "4/4"; else if (fld === "C|") fld = "2/2";
        const t = E("time");
        if (fld.indexOf("/") < 0) { info("M not recognized"); fld = "4/4"; }
        let [beats, btype] = fld.split("/").slice(0, 2);
        try { this.mdur = simplify(evalBeats(beats), parseInt(btype, 10)); }
        catch { info("error in M"); this.mdur = [4, 4]; beats = "4"; btype = "4"; }
        addElemT(t, "beats", beats, lev + 2);
        addElemT(t, "beat-type", btype, lev + 2);
        atts.push([3, t]);
      } else if (ftype === "K") {
        const accs = ["F", "C", "G", "D", "A", "E", "B"];
        let mode = "";
        const key = /^\s*([A-G][#b]?)\s*([a-zA-Z]*)/.exec(field);
        let alts: any = /\s((\s?[=^_][A-Ga-g])+)/.exec(" " + field);
        let fifths = 0;
        if (key) {
          const kk = key[1];
          mode = key[2].toLowerCase().slice(0, 3);
          if (!(mode in offTab)) mode = "maj";
          fifths = sharpness.indexOf(kk) - offTab[mode];
          if (fifths >= 0) this.keyAlts = zipMap(accs.slice(0, fifths), "1");
          else this.keyAlts = zipMap(accs.slice(fifths), "-1");
        } else if (field.startsWith("none") || field === "") { fifths = 0; mode = "maj"; }
        if (alts) {
          const altList = (alts[1].match(/[=^_][A-Ga-g]/g) || []).map((x: string) => [x[1], alterTab[x[0]]]);
          for (const [stp, alter] of altList) this.keyAlts.set(stp.toUpperCase(), alter);
          const k = E("key");
          const koctave: string[] = [];
          const lowerCaseSteps = altList.filter(([stp]: any) => stp >= "a" && stp <= "z").map(([stp]: any) => stp.toUpperCase());
          for (const [stp, alter] of [...this.keyAlts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
            if (alter === "0") { this.keyAlts.delete(stp.toUpperCase()); continue; }
            addElemT(k, "key-step", stp.toUpperCase(), lev + 2);
            addElemT(k, "key-alter", alter, lev + 2);
            koctave.push(lowerCaseSteps.indexOf(stp) >= 0 ? "5" : "4");
          }
          if (koctave.length) {
            for (const oct of koctave) addElem(k, E("key-octave", { number: oct }), lev + 2);
            atts.push([2, k]);
          }
        } else if (mode) {
          const k = E("key");
          addElemT(k, "fifths", String(fifths), lev + 2);
          addElemT(k, "mode", modTab[mode], lev + 2);
          atts.push([2, k]);
        }
        doClef(field);
      } else if (ftype === "L") {
        try { this.unitLcur = field.split("/").map((x) => parseInt(x, 10)); } catch { this.unitLcur = [1, 8]; }
        if (this.unitLcur.length === 1 || !(this.unitLcur[1] in typeMap)) { info("L not allowed"); this.unitLcur = [1, 8]; }
      } else if (ftype === "V") doClef(field);
      else if (ftype === "I") this.doField_I(ftype, field, instDir, addTrans);
      else if (ftype === "Q") this.doTempo(maat, field, lev);
      else if (ftype === "P") {
        const words = E("rehearsal");
        words.set("font-weight", "bold");
        words.text = field;
        addDirection(maat, words, lev, gstaff, [], "above");
      } else if ("TCOAZNGHRBDFSU".indexOf(ftype) >= 0) info("illegal header field in body: " + ftype);
      else info("unhandled field: " + ftype);
    }
    if (atts.length) {
      const att = E("attributes");
      addElem(maat, att, lev);
      for (const [, att_elem] of atts.slice().sort((a, b) => a[0] - b[0])) addElem(att, att_elem, lev + 1);
    }
    if (this.diafret) {
      const other = E("other-direction"); other.text = "diatonic fretting";
      addDirection(maat, other, lev, 0);
    }
    void gstaff;
  }

  doTempo(maat: Element, field: string, lev: number): void {
    const gstaff = this.gStaffNums.get(this.vid) ?? 0;
    const t = /(\d)\/(\d\d?)\s*=\s*(\d[.\d]*)|(\d[.\d]*)/.exec(field);
    const rtxt = /"([^"]*)"/.exec(field);
    if (!t && !rtxt) return;
    const elems: [Element, Element[]][] = [];
    let num = 1, den = 4, upm = 120;
    if (rtxt) {
      num = 1; den = 4; upm = tempoMap[rtxt[1].toLowerCase().trim()] ?? 120;
      const words = E("words"); words.text = rtxt[1];
      elems.push([words, []]);
    }
    if (t) {
      try {
        if (t[4]) { num = 1; den = this.unitLcur[1]; upm = parseFloat(t[4]); }
        else { num = parseInt(t[1], 10); den = parseInt(t[2], 10); upm = parseFloat(t[3]); }
      } catch { info("conversion error: " + field); return; }
      [num, den] = simplify(num, den);
      const dotted = num === 3 ? 1 : 0;
      const den_not = num === 3 ? Math.trunc(den / 2) : den;
      const metro = E("metronome");
      const u = E("beat-unit"); u.text = typeMap[4 * den_not] ?? "quarter";
      const pm = E("per-minute"); pm.text = rstripChars(rstripChars(f2(upm), "0"), ".");
      const subelms = dotted ? [u, E("beat-unit-dot"), pm] : [u, pm];
      elems.push([metro, subelms]);
    }
    const dir = addDirection(maat, elems, lev, gstaff, [], "above");
    if (num !== 1 && num !== 3) info("Q numerator not supported");
    const qpm = 4 * num * upm / den;
    const sound = E("sound"); sound.set("tempo", f2(qpm));
    addElem(dir, sound, lev + 1);
  }

  mkBarline(maat: Element, loc: string, lev: number, style = "", dir = "", ending = ""): void {
    const b = E("barline", { location: loc });
    if (style) addElemT(b, "bar-style", style, lev + 1);
    if (this.curVolta) {
      const end = E("ending", { number: this.curVolta, type: "stop" });
      this.curVolta = "";
      if (loc === "left") {
        const bp = E("barline", { location: "right" });
        addElem(bp, end, lev + 1);
        addElem(this.prevmsre, bp, lev);
      } else addElem(b, end, lev + 1);
    }
    if (ending) {
      let end_ = ending.replace(/-/g, ",");
      let endtxt = "";
      if (end_.startsWith('"')) { endtxt = stripChars(end_, '"'); end_ = "33"; }
      const end = E("ending", { number: end_, type: "start" });
      if (endtxt) end.text = endtxt;
      addElem(b, end, lev + 1);
      this.curVolta = end_;
    }
    if (dir) addElem(b, E("repeat", { direction: dir }), lev + 1);
    addElem(maat, b, lev);
  }

  doChordSym(maat: Element, sym: any, lev: number): void {
    const alterMap: Record<string, string> = { "#": "1", "=": "0", b: "-1" };
    const rnt = sym.root.t;
    const chord = E("harmony");
    addElem(maat, chord, lev);
    const root = E("root");
    addElem(chord, root, lev + 1);
    addElemT(root, "root-step", rnt[0], lev + 2);
    if (rnt.length === 2) addElemT(root, "root-alter", alterMap[rnt[1]], lev + 2);
    const kind = chordTab[sym.kind.t[0]] ?? "major";
    addElemT(chord, "kind", kind, lev + 1);
    let degs: any = getattr(sym, "degree", "");
    if (degs) {
      if (!Array.isArray(degs)) degs = [degs];
      for (const dego of degs) {
        let deg = dego.t[0];
        let alter: string;
        if (deg[0] === "#") { alter = "1"; deg = deg.slice(1); }
        else if (deg[0] === "b") { alter = "-1"; deg = deg.slice(1); }
        else alter = "0";
        const degree = E("degree");
        addElem(chord, degree, lev + 1);
        addElemT(degree, "degree-value", deg, lev + 2);
        addElemT(degree, "degree-alter", alter, lev + 2);
        addElemT(degree, "degree-type", "add", lev + 2);
      }
    }
  }

  mkMeasure(i: number, t: any[], lev: number, fieldmap: Map<string, string> = new Map()): [Element, number] {
    this.msreAlts = new TMap();
    this.ntup = -1; this.trem = 0; this.intrem = 0;
    this.acciatura = 0;
    let overlay = 0;
    const maat = E("measure", { number: String(i) });
    if (fieldmap.size) this.doFields(maat, fieldmap, lev + 1);
    if (this.linebrk) {
      const e = E("print"); e.set("new-system", "yes");
      addElem(maat, e, lev + 1);
      this.linebrk = 0;
    }
    t.forEach((x: any, it: number) => {
      if (x.name === "note" || x.name === "rest") {
        if (x.dur.t[0] === 0) x.dur.t = [1, x.dur.t[1]];
        addElem(maat, this.mkNote(x, lev + 1), lev + 1);
      } else if (x.name === "lbar") {
        const bar = x.t[0];
        if (bar === "|" || bar === "[|") { /* skip */ }
        else if (bar.indexOf(":") >= 0) {
          const volta = x.t.length === 2 ? x.t[1] : "";
          this.mkBarline(maat, "left", lev + 1, "heavy-light", "forward", volta);
        } else this.mkBarline(maat, "left", lev + 1, "", "", bar);
      } else if (x.name === "rbar") {
        const bar = x.t[0];
        if (bar === ".|") this.mkBarline(maat, "right", lev + 1, "dotted");
        else if (bar.indexOf(":") >= 0) this.mkBarline(maat, "right", lev + 1, "light-heavy", "backward");
        else if (bar === "||") this.mkBarline(maat, "right", lev + 1, "light-light");
        else if (bar === "[|]" || bar === "[]") this.mkBarline(maat, "right", lev + 1, "none");
        else if (bar.indexOf("[") >= 0 || bar.indexOf("]") >= 0) this.mkBarline(maat, "right", lev + 1, "light-heavy");
        else if (bar[0] === "&") overlay = 1;
      } else if (x.name === "tup") {
        let n: number, into: number, nts: number;
        if (x.t.length === 3) { [n, into, nts] = x.t; } else { n = x.t[0]; into = 0; nts = 0; }
        if (into === 0) into = [2, 4, 8].indexOf(n) >= 0 ? 3 : 2;
        if (nts === 0) nts = n;
        this.tmnum = n; this.tmden = into; this.ntup = nts;
      } else if (x.name === "deco") this.staffDecos(x.t, maat, lev + 1);
      else if (x.name === "text") {
        const pos = x.t[0], text = x.t[1];
        const place = pos === "^" ? "above" : "below";
        const words = E("words"); words.text = text;
        const gstaff = this.gStaffNums.get(this.vid) ?? 0;
        addDirection(maat, words, lev + 1, gstaff, [], place);
      } else if (x.name === "inline") {
        const fieldtype = x.t[0], fieldval = x.t.slice(1).join(" ");
        this.doFields(maat, new Map([[fieldtype, fieldval]]), lev + 1);
      } else if (x.name === "accia") this.acciatura = 1;
      else if (x.name === "linebrk") {
        this.supports_tag = 1;
        if (it > 0 && t[it - 1].name === "lbar") {
          const e = E("print"); e.set("new-system", "yes");
          addElem(maat, e, lev + 1);
        } else this.linebrk = 1;
      } else if (x.name === "chordsym") this.doChordSym(maat, x, lev + 1);
    });
    this.stopBeams();
    this.prevmsre = maat;
    return [maat, overlay];
  }

  mkPart(maten: any[], id: string, lev: number, attrs: Map<string, string>, nstaves: number, rOpt: boolean): Element {
    this.slurstack = [];
    this.glisnum = 0; this.slidenum = 0;
    this.unitLcur = this.unitL;
    this.curVolta = "";
    this.lyrdash = {};
    this.linebrk = 0;
    this.midprg = ["", "", "", ""];
    this.gcue_on = 0;
    this.gtrans = 0;
    this.percVoice = 0;
    this.curClef = "";
    this.nostems = 0;
    this.tuning = tuningDef;
    const part = E("part", { id });
    this.overlayVnum = 0;
    const gstaff = this.gStaffNums.get(this.vid) ?? 0;
    const attrs_cpy = new Map(attrs);
    if (gstaff === 1) attrs_cpy.set("gstaff", String(nstaves));
    if ((attrs_cpy.get("V") ?? "").indexOf("perc") >= 0) attrs_cpy.delete("K");
    let [msre, overlay] = this.mkMeasure(1, maten[0], lev + 1, attrs_cpy);
    addElem(part, msre, lev + 1);
    maten.slice(1).forEach((maat: any, i: number) => {
      this.overlayVnum = overlay ? this.overlayVnum + 1 : 0;
      const [m2, next_overlay] = this.mkMeasure(i + 2, maat, lev + 1);
      if (overlay) mergePartMeasure(part, m2, this.overlayVnum, rOpt);
      else addElem(part, m2, lev + 1);
      overlay = next_overlay;
    });
    return part;
  }

  mkScorePart(id: string, vids_p: any, partAttr: Record<string, any>, lev: number): Element {
    void vids_p;
    const mkInst = (instId: string, vid: string, midchan: string, midprog: string, midnot: string, vol: string, pan: string): [Element, Element] => {
      const si = E("score-instrument", { id: instId });
      addElemT(si, "instrument-name", (partAttr[vid] ?? [""])[0], lev + 2);
      const mi = E("midi-instrument", { id: instId });
      if (midchan) addElemT(mi, "midi-channel", midchan, lev + 2);
      if (midprog) addElemT(mi, "midi-program", String(parseInt(midprog, 10) + 1), lev + 2);
      if (midnot) addElemT(mi, "midi-unpitched", String(parseInt(midnot, 10) + 1), lev + 2);
      if (vol) addElemT(mi, "volume", f2(parseInt(vol, 10) / 1.27), lev + 2);
      if (pan) addElemT(mi, "pan", f2(parseInt(pan, 10) / 127 * 180 - 90), lev + 2);
      return [si, mi];
    };
    const [naam, subnm] = partAttr[id];
    const sp = E("score-part", { id: "P" + id });
    const nm = E("part-name"); nm.text = naam;
    addElem(sp, nm, lev + 1);
    const snm = E("part-abbreviation"); snm.text = subnm;
    if (subnm) addElem(sp, snm, lev + 1);
    const inst: [Element, Element][] = [];
    const entries = Object.keys(this.midiInst).map((k) => [k, this.midiInst[k]] as [string, any[]]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [instId, v] of entries) {
      const [pid, vid, chan, midprg0, vol, pan] = v;
      const [midprg, midnot] = chan === "10" ? ["0", midprg0] : [midprg0, ""];
      if (pid === id) inst.push(mkInst(instId, vid, chan, midprg, midnot, vol, pan));
    }
    for (const [si] of inst) addElem(sp, si, lev + 1);
    for (const [, mi] of inst) addElem(sp, mi, lev + 1);
    return sp;
  }

  mkPartlist(vids: string[], partAttr: Record<string, any>, lev: number): Element {
    const partlist = E("part-list");
    let g_num = 0;
    const addPartGroup = (sym: string, num: number): void => {
      const pg = E("part-group", { number: String(num), type: "start" });
      addElem(partlist, pg, lev + 1);
      addElemT(pg, "group-symbol", sym, lev + 2);
      addElemT(pg, "group-barline", "yes", lev + 2);
    };
    const groups = this.groups.length ? this.groups : vids;
    for (const g of groups) {
      if (g === "[") { g_num += 1; addPartGroup("bracket", g_num); }
      else if (g === "{") { g_num += 1; addPartGroup("brace", g_num); }
      else if (g === "}" || g === "]") {
        const pg = E("part-group", { number: String(g_num), type: "stop" });
        addElem(partlist, pg, lev + 1);
        g_num -= 1;
      } else {
        if (vids.indexOf(g) < 0) continue;
        addElem(partlist, this.mkScorePart(g, vids, partAttr, lev + 1), lev + 1);
      }
    }
    return partlist;
  }

  doField_I(_type: string, x: string, instDir: any, addTrans: any): void {
    const instChange = (midchan: string, midprog: string): void => {
      if (midchan && midchan !== this.midprg[0]) instDir("midi-channel", midchan, "chan: %s");
      if (midprog && midprog !== this.midprg[1]) instDir("midi-program", String(parseInt(midprog, 10) + 1), "prog: %s");
    };
    const readPfmt = (xx: string, n: number): void => {
      if (!this.pageFmtAbc.length) this.pageFmtAbc = pageFmtDef.slice();
      const ro = /[^.\d]*([\d.]+)\s*(cm|in|pt)?/.exec(xx);
      if (ro) {
        const val = ro[1], unit = ro[2];
        const u = unit ? ({ cm: 10, in: 25.4, pt: 25.4 / 72 } as any)[unit] : 1;
        this.pageFmtAbc[n] = parseFloat(val) * u;
      } else info("error in page format: " + xx);
    };
    const readPercMap = (xx: string): void => {
      const getMidNum = (sndnm: string): string => {
        const pnms = sndnm.split("-");
        let ps = this.percsnd.slice();
        const _f = (ip: number, xs: string[], pnm: string): boolean => ip < xs.length && xs[ip].indexOf(pnm) > -1;
        for (let ip = 0; ip < pnms.length; ip++) {
          ps = ps.filter(([nm]: any) => _f(ip, nm.split("-"), pnms[ip]));
          if (ps.length <= 1) break;
        }
        if (ps.length === 0) { info("drum sound not found: " + sndnm); return "38"; }
        return ps[0][1];
      };
      const midiVal = (acc: string, step: string, oct: any): number => {
        const o = (step.toUpperCase() === step ? 4 : 5) + parseInt(oct, 10);
        return o * 12 + PC["CDEFGAB".indexOf(step.toUpperCase())] + (({ "^": 1, "_": -1, "=": 0 } as any)[acc] ?? 0) + 12;
      };
      const [, p1, p2, p3, p4] = grammar().abc_percmap.parseString(xx).asList();
      const [acc, astep, aoct] = p1;
      const [nstep, noct] = p2 === "*" ? [astep, aoct] : p2;
      let midi: string;
      if (p3 === "*") midi = String(midiVal(acc, astep, aoct));
      else if (Array.isArray(p3)) midi = String(midiVal(p3[0], p3[1], p3[2]));
      else if (typeof p3 === "number") midi = String(p3);
      else midi = getMidNum(p3.toLowerCase());
      const head = p4.replace(/(.)-([^x])/g, "$1 $2");
      this.percMap.set([this.pid, acc + astep, aoct], [nstep, noct, midi, head]);
    };
    if (x.startsWith("score") || x.startsWith("staves")) this.staveDefs.push(x);
    else if (x.startsWith("staffwidth")) info("skipped I-field: " + x);
    else if (x.startsWith("staff")) {
      const r1 = /staff *([+-]?)(\d)/.exec(x);
      if (r1) {
        const sign = r1[1];
        let num = parseInt(r1[2], 10);
        const gstaff = this.gStaffNums.get(this.vid) ?? 0;
        if (sign) num = sign === "-" ? gstaff - num : gstaff + num;
        else {
          let vabc: any;
          try { vabc = this.staves[num - 1][0]; } catch { vabc = 0; info("abc staff does not exist"); }
          num = this.gStaffNumsOrg.get(vabc) ?? 0;
        }
        if (gstaff && num > 0 && num <= (this.gNstaves.get(this.vid) ?? 0)) this.gStaffNums.set(this.vid, num);
        else info("could not relocate to staff");
      } else info("not a valid staff redirection: " + x);
    } else if (x.startsWith("scale")) readPfmt(x, 0);
    else if (x.startsWith("pageheight")) readPfmt(x, 1);
    else if (x.startsWith("pagewidth")) readPfmt(x, 2);
    else if (x.startsWith("leftmargin")) readPfmt(x, 3);
    else if (x.startsWith("rightmargin")) readPfmt(x, 4);
    else if (x.startsWith("topmargin")) readPfmt(x, 5);
    else if (x.startsWith("botmargin")) readPfmt(x, 6);
    else if (x.startsWith("MIDI") || x.startsWith("midi")) {
      const r1 = /program *(\d*) +(\d+)/.exec(x);
      const r2 = /channel *(\d+)/.exec(x);
      const r3 = /drummap\s+([_=^]*)([A-Ga-g])([,']*)\s+(\d+)/.exec(x);
      const r4 = /control *(\d+) +(\d+)/.exec(x);
      let ch_nw = "", prg_nw = "", vol_nw = "", pan_nw = "";
      if (r1) { ch_nw = r1[1]; prg_nw = r1[2]; }
      if (r2) ch_nw = r2[1];
      if (r4) { const cnum = r4[1], cval = r4[2]; if (cnum === "7") vol_nw = cval; if (cnum === "10") pan_nw = cval; }
      if (r1 || r2 || r4) {
        const ch = ch_nw || this.midprg[0];
        const prg = prg_nw || this.midprg[1];
        const vol = vol_nw || this.midprg[2];
        const pan = pan_nw || this.midprg[3];
        const instId = "I" + this.pid + "-" + this.vid;
        if (instId in this.midiInst) instChange(ch, prg);
        this.midprg = [ch, prg, vol, pan];
      }
      if (r3) {
        const acc = r3[1], step = r3[2], octs = r3[3], midi = r3[4];
        const oct = x.indexOf(",") >= 0 ? -octs.length : octs.length;
        const notehead = acc === "^" ? "x" : acc === "_" ? "circle-x" : "normal";
        this.percMap.set([this.pid, acc + step, oct], [step, oct, midi, notehead]);
      }
      const r = /transpose[^-\d]*(-?\d+)/.exec(x);
      if (r) addTrans(r[1]);
    } else if (x.startsWith("percmap")) { readPercMap(x); this.pMapFound = 1; }
    else info("skipped I-field: " + x);
  }

  parseStaveDef(vdefs: Record<string, any>): Record<string, any> {
    for (const vid of Object.keys(vdefs)) this.vcepid.set(vid, vid);
    if (!this.staveDefs.length) return vdefs;
    for (const x of this.staveDefs.slice(1)) info("multiple stave mappings not supported: " + x);
    const x = this.staveDefs[0];
    const score = grammar().abc_scoredef.parseString(x).asList()[0];
    const f = (y: any): any => (typeof y === "string" ? [y] : y);
    this.staves = mkStaves(score, vdefs).map(f);
    this.grands = mkGrand(score, vdefs).map(f);
    this.groups = mkGroups(score);
    const vce_groups = this.staves.filter((vids: any[]) => vids.length > 1);
    const d: Record<string, any> = {};
    for (const vgr of vce_groups) d[vgr[0]] = vgr;
    for (const gstaff of this.grands) {
      if (gstaff.length === 1) continue;
      gstaff.forEach((v: string, idx: number) => {
        const stf_num = idx + 1;
        for (const vx of (d[v] ?? [v])) { this.gStaffNums.set(vx, stf_num); this.gNstaves.set(vx, gstaff.length); }
      });
    }
    this.gStaffNumsOrg = new Map(this.gStaffNums);
    for (const xmlpart of this.grands) {
      const pid = xmlpart[0];
      const vces: string[] = [];
      for (const stf of xmlpart) for (const v of (d[stf] ?? [stf])) vces.push(v);
      for (const v of vces) this.vcepid.set(v, pid);
    }
    return vdefs;
  }

  voiceNamesAndMaps(ps: any[]): Record<string, any> {
    const vdefs: Record<string, any> = {};
    for (const [vid, vcedef, vce] of ps) {
      let pname = "", psubnm = "";
      if (!vcedef) vdefs[vid] = [pname, psubnm, ""];
      else {
        if (vid !== vcedef.t[1]) info("voice ids unequal");
        let rn = /(?:name|nm)="([^"]*)"/.exec(vcedef.t[2]);
        if (rn) pname = rn[1];
        rn = /(?:subname|snm|sname)="([^"]*)"/.exec(vcedef.t[2]);
        if (rn) psubnm = rn[1];
        vcedef.t[2] = vcedef.t[2].split('"' + pname + '"').join('""').split('"' + psubnm + '"').join('""');
        vdefs[vid] = [pname, psubnm, vcedef.t[2]];
      }
      const xs: string[] = [];
      for (const maat of vce) for (const po of maat) if (po.name === "inline") xs.push(po.t[1]);
      for (const xx of xs) if (xx.startsWith("score") || xx.startsWith("staves")) this.staveDefs.push(xx.replace(/%5d/g, "]"));
    }
    return vdefs;
  }

  doHeaderField(fld: any, attrmap: Map<string, string>): void {
    let type = fld.t[0];
    const value = fld.t[1].replace(/%5d/g, "]");
    if (!value) return;
    if (type === "M") attrmap.set(type, value);
    else if (type === "L") {
      try { this.unitL = fld.t[1].split("/").map((x: string) => parseInt(x, 10)); }
      catch { info("illegal unit length"); this.unitL = [1, 8]; }
      if (this.unitL.length === 1 || !(this.unitL[1] in typeMap)) { info("L not allowed"); this.unitL = [1, 8]; }
    } else if (type === "K") attrmap.set(type, value);
    else if (type === "T") this.title = this.title ? this.title + "\n" + value : value;
    else if (type === "U") { const sym = stripChars(fld.t[2], "!+"); this.usrSyms[value] = sym; }
    else if (type === "I") this.doField_I(type, value, () => 0, () => 0);
    else if (type === "Q") attrmap.set(type, value);
    else if ("CRZNOAGHBDFSP".indexOf(type) >= 0) {
      type = this.metaMap[type] ?? type;
      const c = this.metadata[type] ?? "";
      this.metadata[type] = c ? c + "\n" + value : value;
    } else info("skipped header: " + JSON.stringify(fld));
  }

  mkIdentification(score: Element, lev: number): void {
    if (this.title) {
      const xs = this.title.split("\n");
      const ys = xs.slice(1).join("\n");
      const w = E("work");
      addElem(score, w, lev + 1);
      if (ys) addElemT(w, "work-number", ys, lev + 2);
      addElemT(w, "work-title", xs[0], lev + 2);
    }
    const ident = E("identification");
    addElem(score, ident, lev + 1);
    for (const [mtype, mval] of Object.entries(this.metadata)) {
      if (mtype in metaTypes && mtype !== "rights") {
        const c = E("creator", { type: mtype });
        c.text = mval as string;
        addElem(ident, c, lev + 2);
      }
    }
    if ("rights" in this.metadata) addElemT(ident, "rights", this.metadata["rights"], lev + 2);
    const encoding = E("encoding");
    addElem(ident, encoding, lev + 2);
    const encoder = E("encoder");
    encoder.text = "abc2xml version " + VERSION;
    addElem(encoding, encoder, lev + 3);
    if (this.supports_tag) {
      addElem(encoding, E("supports", { attribute: "new-system", element: "print", type: "yes", value: "yes" }), lev + 3);
    }
    const encodingDate = E("encoding-date");
    encodingDate.text = new Date().toISOString().slice(0, 10);
    addElem(encoding, encodingDate, lev + 3);
    this.addMeta(ident, lev + 2);
  }

  mkDefaults(score: Element, lev: number): void {
    if (this.pageFmtCmd.length) this.pageFmtAbc = this.pageFmtCmd;
    if (!this.pageFmtAbc.length) return;
    const [abcScale, h, w, l, r, t, b] = this.pageFmtAbc;
    const space = abcScale * 2.117;
    const mils = 4 * space;
    const scale = 40 / mils;
    const dflts = E("defaults");
    addElem(score, dflts, lev);
    const scaling = E("scaling");
    addElem(dflts, scaling, lev + 1);
    addElemT(scaling, "millimeters", fg(mils), lev + 2);
    addElemT(scaling, "tenths", "40", lev + 2);
    const layout = E("page-layout");
    addElem(dflts, layout, lev + 1);
    addElemT(layout, "page-height", fg(h * scale), lev + 2);
    addElemT(layout, "page-width", fg(w * scale), lev + 2);
    const margins = E("page-margins", { type: "both" });
    addElem(layout, margins, lev + 2);
    addElemT(margins, "left-margin", fg(l * scale), lev + 3);
    addElemT(margins, "right-margin", fg(r * scale), lev + 3);
    addElemT(margins, "top-margin", fg(t * scale), lev + 3);
    addElemT(margins, "bottom-margin", fg(b * scale), lev + 3);
  }

  addMeta(parent: Element, lev: number): void {
    const misc = E("miscellaneous");
    let mf = 0;
    for (const [mtype, mval] of Object.entries(this.metadata).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      if (mtype === "S") addElemT(parent, "source", mval as string, lev);
      else if (mtype in metaTypes) continue;
      else {
        const mfe = E("miscellaneous-field", { name: metaTab[mtype] });
        mfe.text = mval as string;
        addElem(misc, mfe, lev + 1);
        mf = 1;
      }
    }
    if (mf !== 0) addElem(parent, misc, lev);
  }

  parse(abc_string: string, rOpt = false, bOpt = false, fOpt = false): Element {
    const abctext = abc_string.replace(/\[I:staff /g, "[I:staff");
    this.reset(fOpt);
    const [header, voices] = splitHeaderVoices(abctext);
    const ps: any[] = [];
    const lbrk_insert = /I:linebreak\s*([!$]|none)|I:continueall\s*(1|true)/.test(header) ? 0 : (bOpt ? 1 : 0);
    const hs = header ? grammar().abc_header.parseString(header).asList() : [];
    for (let [id, voice] of voices) {
      if (lbrk_insert) {
        const r1 = /\[[wA-Z]:[^\]]*\]/g;
        const has_abc = (v: string): string => v.replace(r1, "").trim();
        voice = voice.split("\n").map((balk) => (has_abc(balk) ? rstripChars(balk, "$!") + "$" : balk)).join("\n");
      }
      const prevLeftBar: any = null;
      this.orderChords = this.fOpt && (voice.slice(0, 200).indexOf("tab") >= 0 || hs.some((h: any) => h.t[0] === "K" && String(h.t[1]).indexOf("tab") >= 0)) ? 1 : 0;
      prevloc = 0;
      const vce = grammar().abc_voice.parseString(voice).asList();
      let lyr_notes: any[] = [];
      for (const m of vce) {
        for (const e of m) {
          if (e.name === "lyr_blk") {
            const lyr = e.objs.map((line: any) => line.objs);
            alignLyr(lyr_notes, lyr);
            lyr_notes = [];
          } else lyr_notes.push(e);
        }
      }
      let vcelyr = vce;
      if (!vce.length) vcelyr = [[new pObj("inline", ["I", "empty voice"])]];
      if (prevLeftBar) { vcelyr[0].splice(0, 0, prevLeftBar); }
      if (vcelyr[vcelyr.length - 1] && vcelyr[vcelyr.length - 1].length && vcelyr[vcelyr.length - 1][vcelyr[vcelyr.length - 1].length - 1].name === "lbar") {
        if (vcelyr.length > 1) vcelyr.splice(vcelyr.length - 1, 1);
      }
      const elem1 = vcelyr[0][0];
      let voicedef: any = "";
      if (elem1.name === "inline" && elem1.t[0] === "V") { voicedef = elem1; vcelyr[0].splice(0, 1); }
      ps.push([id, voicedef, vcelyr]);
    }

    const score = E("score-partwise");
    const attrmap = new Map<string, string>([["Div", String(this.divisions)], ["K", "C treble"], ["M", "4/4"]]);
    for (const res of hs) {
      if (res.name === "field") this.doHeaderField(res, attrmap);
      else info("unexpected header item");
    }

    let vdefs = this.voiceNamesAndMaps(ps);
    vdefs = this.parseStaveDef(vdefs);

    const lev = 0;
    const vids: string[] = [], parts: Element[] = [], partAttr: Record<string, any> = {};
    this.strAlloc = new stringAlloc();
    for (const [vid, , vce] of ps) {
      const [pname, psubnm, voicedef] = vdefs[vid];
      attrmap.set("V", voicedef);
      const pid = "P" + vid;
      this.vid = vid;
      this.pid = this.vcepid.get(this.vid) as string;
      this.gTime = [0, 0];
      this.strAlloc.beginZoek();
      const part = this.mkPart(vce, pid, lev + 1, attrmap, this.gNstaves.get(vid) ?? 0, rOpt);
      if (attrmap.has("Q")) attrmap.delete("Q");
      parts.push(part);
      vids.push(vid);
      partAttr[vid] = [pname, psubnm, this.midprg];
      if (!arraysEq(this.midprg, ["", "", "", ""]) && !this.percVoice) {
        const instId = "I" + this.pid + "-" + this.vid;
        if (!(instId in this.midiInst)) this.midiInst[instId] = [this.pid, this.vid, this.midprg[0], this.midprg[1], this.midprg[2], this.midprg[3]];
      }
    }
    let [parts2, vidsnew] = mergeParts(parts, vids, this.staves, rOpt);
    [parts2, vidsnew] = mergeParts(parts2, vidsnew, this.grands, rOpt, 1);
    reduceMids(parts2, vidsnew, this.midiInst);

    this.mkIdentification(score, lev);
    this.mkDefaults(score, lev + 1);

    const partlist = this.mkPartlist(vids, partAttr, lev + 1);
    addElem(score, partlist, lev + 1);
    for (const part of parts2) addElem(score, part, lev + 1);
    return score;
  }
}

function arraysEq(a: any[], b: any[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------- top level ----------------
const XML_DECL = "<?xml version='1.0' encoding='utf-8'?>";
function fixDoctype(elem: Element): string {
  const xs = tostring(elem);
  return [
    XML_DECL,
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    xs,
  ].join("\n");
}

/**
 * Convert one ABC tune to a MusicXML (score-partwise) string.
 * When `pageCredits` (default true), also applies the zanmeigepu post-processing ported from
 * download_score.py: derive 作词/作曲/编曲 from the C: fields, move them from <identification>
 * into page-aligned <credit> elements (see credits.ts). No-op for ABC without those prefixes.
 */
export function abcToMusicXml(abcText: string, opts: { pageCredits?: boolean } = {}): string {
  mxm = new MusicXml();
  const score = mxm.parse(abcText);
  if (opts.pageCredits !== false) {
    addPageCredits(score, deriveComposers(mxm.metadata["composer"] ?? ""));
  }
  return fixDoctype(score);
}

