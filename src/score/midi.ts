// Ported from mp/score/midi.kt (ToMidi). Builds a Standard MIDI File (format 1)
// in pure TS: a tempo meta track + one track per part, note on/off per chord.

import { Chord, Score } from "./score";

const PPQ = 960;
const TEMPO = 90;

interface Ev {
  tick: number;
  data: number[];
  order: number; // tie-break: note-off (0) before note-on (1) at same tick
}

function varLen(n: number): number[] {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

function trackChunk(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let prev = 0;
  for (const e of events) {
    body.push(...varLen(e.tick - prev));
    body.push(...e.data);
    prev = e.tick;
  }
  body.push(...varLen(0), 0xff, 0x2f, 0x00); // end of track
  const len = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...body];
}

function tempoTrack(): number[] {
  const mpqn = Math.round(60000000 / TEMPO);
  const ev: Ev = {
    tick: 0,
    order: 0,
    data: [0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff],
  };
  return trackChunk([ev]);
}

function partTrack(score: Score, partIdx: number): number[] {
  const part = score.parts[partIdx];
  const channel = partIdx & 0x0f;
  const events: Ev[] = [];
  let pos = 0;
  for (const m of part.measures) {
    let dur = 0;
    for (const ent of m.entries) {
      if (!(ent instanceof Chord)) continue;
      const ch = ent;
      const start = Math.round(ch.position.toFloat() * PPQ);
      const end = Math.round(ch.position.plus(ch.duration!).toFloat() * PPQ);
      dur = end;
      if (ch.rest) continue;
      for (const n of ch.notes) {
        events.push({ tick: pos + start, order: 1, data: [0x90 | channel, n.pitch & 0x7f, 100] });
        events.push({ tick: pos + end, order: 0, data: [0x80 | channel, n.pitch & 0x7f, 0] });
      }
    }
    pos += dur;
  }
  return trackChunk(events);
}

export function scoreToMidi(score: Score): Uint8Array {
  const ntracks = 1 + score.parts.length;
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, // MThd, len 6
    0, 1, // format 1
    (ntracks >> 8) & 0xff, ntracks & 0xff,
    (PPQ >> 8) & 0xff, PPQ & 0xff, // division (ticks per quarter)
  ];
  const out: number[] = [...header, ...tempoTrack()];
  for (let i = 0; i < score.parts.length; i++) out.push(...partTrack(score, i));
  return new Uint8Array(out);
}
