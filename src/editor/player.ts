// In-editor playback. The front-end always owns the play clock and drives the
// cursor-follow highlight; the audio itself comes from one of two sources:
//   - SamplerSource: Web Audio + smplr SoundFont (browser & desktop, sampled timbre)
//   - NativeSource:  macOS AVMIDIPlayer via Rust (best timbre, desktop only)
// See ~/.claude/plans/midi-serialized-snowflake.md.

import { Soundfont } from "smplr";
import { Chord } from "../score/score";
import { buildTimeline, partGain, PlayOptions, TEMPO } from "../score/timeline";
import { scoreToMidi } from "../score/midi";
import { Score } from "../score/score";
import { isTauriRuntime } from "./fileio";

const SPQ = 60 / TEMPO; // seconds per quarter note

export type PlayState = "stopped" | "loading" | "playing";

interface Anchor {
  t: number; // seconds
  chord: Chord;
  pass: number;
}

export class ScorePlayer {
  state: PlayState = "stopped";

  private ctx: AudioContext | null = null;
  private inst: ReturnType<typeof Soundfont> | null = null;
  private useNative = false;
  private raf = 0;
  private startCtxTime = 0; // AudioContext time at note t=0 (sampler)
  private startPerf = 0; // performance.now()/1000 at play start (native)
  private startSec = 0; // timeline seconds the cursor begins at (selection start)
  private anchors: Anchor[] = [];
  private duration = 0; // seconds
  private curIdx = -1;
  private gen = 0; // invalidates in-flight async play() when stop()/replay happens

  constructor(
    private onChord: (chord: Chord | null, pass: number) => void,
    private onStateChange: (state: PlayState) => void,
  ) {}

  get playing(): boolean {
    return this.state === "playing";
  }

  async play(
    score: Score,
    opts?: PlayOptions,
    start?: { chord: Chord; pass: number },
  ): Promise<void> {
    this.stop();
    const gen = this.gen;
    const tl = buildTimeline(score);
    if (tl.notes.length === 0) return;

    this.anchors = tl.anchors.map((a) => ({ t: a.t0 * SPQ, chord: a.chord, pass: a.pass }));
    this.duration = tl.duration * SPQ;
    this.curIdx = -1;
    this.useNative = isTauriRuntime();

    // Start offset: if a note is selected, begin at that anchor's time.
    let startSec = 0;
    if (start) {
      const a =
        tl.anchors.find((x) => x.chord === start.chord && x.pass === start.pass) ??
        tl.anchors.find((x) => x.chord === start.chord);
      if (a) startSec = a.t0 * SPQ;
    }
    this.startSec = startSec;

    this.setState("loading");

    if (this.useNative) {
      try {
        const bytes = scoreToMidi(score, opts); // per-part CC7 volume baked in
        const { invoke } = await import("@tauri-apps/api/core");
        if (gen !== this.gen) return;
        await invoke("midi_play_cmd", { bytes: Array.from(bytes), startSeconds: startSec });
        if (gen !== this.gen) {
          void invoke("midi_stop_cmd").catch(() => {});
          return;
        }
        this.startPerf = performance.now() / 1000 - startSec;
      } catch (e) {
        console.warn("native MIDI playback failed, falling back to sampler", e);
        this.useNative = false;
      }
    }

    if (!this.useNative) {
      const ctx = new AudioContext();
      await ctx.resume();
      if (gen !== this.gen) {
        void ctx.close();
        return;
      }
      const inst = Soundfont(ctx, { kit: "FluidR3_GM", instrument: "acoustic_grand_piano" });
      await inst.ready;
      if (gen !== this.gen) {
        inst.dispose();
        void ctx.close();
        return;
      }
      // base maps timeline second `startSec` to `ctx.currentTime + lead`.
      const lead = 0.15;
      const base = ctx.currentTime + lead - startSec;
      for (const n of tl.notes) {
        const t1 = n.t1 * SPQ;
        if (t1 <= startSec) continue; // already finished before the start point
        inst.start({
          note: n.pitch,
          time: Math.max(ctx.currentTime + lead, base + n.t0 * SPQ),
          duration: Math.max(0.05, t1 - Math.max(n.t0 * SPQ, startSec)),
          velocity: Math.max(1, Math.round(100 * partGain(opts, n.part))),
        });
      }
      this.ctx = ctx;
      this.inst = inst;
      this.startCtxTime = base;
    }

    if (gen !== this.gen) return;
    this.setState("playing");
    this.tick();
  }

  stop(): void {
    this.gen++; // invalidate any in-flight play()
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.inst) {
      this.inst.stop();
      this.inst.dispose();
      this.inst = null;
    }
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    if (this.useNative) {
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("midi_stop_cmd")).catch(() => {});
    }
    this.curIdx = -1;
    this.onChord(null, 0);
    this.setState("stopped");
  }

  private now(): number {
    return this.useNative
      ? performance.now() / 1000 - this.startPerf
      : this.ctx!.currentTime - this.startCtxTime;
  }

  private tick = (): void => {
    if (this.state !== "playing") return;
    // Clamp to the start point so the sampler's lead-in never lands the cursor
    // on the note just before a selection start.
    const t = Math.max(this.startSec, this.now());
    if (t >= this.duration + 0.3) {
      this.stop();
      return;
    }
    // Cursor only advances forward; playback time is monotonic.
    let idx = this.curIdx;
    while (idx + 1 < this.anchors.length && this.anchors[idx + 1].t <= t) idx++;
    if (idx !== this.curIdx) {
      this.curIdx = idx;
      const a = idx >= 0 ? this.anchors[idx] : null;
      this.onChord(a ? a.chord : null, a ? a.pass : 0);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private setState(s: PlayState): void {
    if (this.state === s) return;
    this.state = s;
    this.onStateChange(s);
  }
}
