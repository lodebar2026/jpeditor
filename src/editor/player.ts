// In-editor playback. The front-end always owns the play clock and drives the
// cursor-follow highlight; the audio itself comes from one of two sources:
//   - SamplerSource: Web Audio + smplr SoundFont (browser & desktop, sampled timbre)
//   - NativeSource:  macOS AVMIDIPlayer via Rust (best timbre, desktop only)
//
// 一次「会话」= 一份谱 × 一组播放参数排出来的时间线；会话内可暂停、续播、按秒定位（进度条、点音符跳转）。
// 采样音源的 AudioContext 与音色跨会话保留（停止时挂起），定位与重播都不再重新载入音色。

import { Soundfont } from "smplr";
import type { ElementId } from "../model/doc";
import { buildTimeline, partGain, PlayOptions, PlaySource, playTempo, type Timeline } from "../score/timeline";
import { toMidi } from "../score/midi";
import { isTauriRuntime } from "./fileio";

export type PlayState = "stopped" | "loading" | "playing" | "paused";

interface Anchor {
  t: number; // seconds
  id: ElementId | undefined;
  pass: number;
}

/** 起播点 / 光标：模型元素 id + 演唱遍数。 */
export interface PlayPoint {
  id: ElementId;
  pass: number;
}

/** 时间线换成秒的那一份（会话内不变）。 */
interface Session {
  /** 光标跟的锚点（旋律，或各声部起音去重） */
  anchors: Anchor[];
  /** 所有声部的起音和弦（点音符换算秒数用：低音声部的音也要找得到） */
  lookup: Anchor[];
  /** 按起音排好的音（秒） */
  notes: { t0: number; t1: number; pitch: number; velocity: number }[];
  duration: number;
  /** 原生音源要的 MIDI（首次用到时才生成） */
  src: PlaySource;
  opts: PlayOptions | undefined;
  midi: number[] | null;
}

/** 采样音源一次往 smplr 里递多远的音（秒）。后台标签页的定时器会被限到 1 秒一次，窗口要比它长。 */
const FEED_AHEAD = 2;
/** 起播前留的一点余量（秒），免得第一个音被 AudioContext 的调度延迟吃掉头。 */
const LEAD = 0.15;

/** 一份谱按给定播放参数的时间线（秒）：锚点与总长。控制器在没开播时也要用它（进度条总长、点音符换算秒数）。 */
export function timelineSeconds(src: PlaySource, opts?: PlayOptions): { tl: Timeline; spq: number } {
  return { tl: buildTimeline(src), spq: 60 / playTempo(src, opts) };
}

/** 锚点里找 `point` 的起音秒数（找不到那一遍取任一遍；旋律里没有再找其它声部）；没有这个音为 null。 */
export function anchorSeconds(tl: Timeline, spq: number, point: PlayPoint): number | null {
  const a = findAnchor(tl.anchors, point, (x) => x.chord.id) ?? findAnchor(tl.allAnchors, point, (x) => x.chord.id);
  return a ? a.t0 * spq : null;
}

function findAnchor<A extends { pass: number }>(
  list: readonly A[],
  point: PlayPoint,
  idOf: (a: A) => ElementId | undefined,
): A | undefined {
  return list.find((x) => idOf(x) === point.id && x.pass === point.pass) ?? list.find((x) => idOf(x) === point.id);
}

/** 各声部起音按时刻去重（同刻留声部序最前的那个）：五线谱竖直播放线一刻只停一处。 */
function onsetAnchors(tl: Timeline): Timeline["anchors"] {
  const out: Timeline["anchors"] = [];
  for (const a of tl.allAnchors) {
    if (out.length > 0 && Math.abs(out[out.length - 1].t0 - a.t0) < 1e-6) continue;
    out.push(a);
  }
  return out;
}

export class ScorePlayer {
  state: PlayState = "stopped";
  /** 光标跟各声部起音（五线谱 / 混排的竖直播放线），而不是只跟旋律。下一次 `play()` 起生效。 */
  cursorAllParts = false;

  private ctx: AudioContext | null = null;
  private inst: ReturnType<typeof Soundfont> | null = null;
  private instLoading: Promise<ReturnType<typeof Soundfont>> | null = null;
  /** 原生音源：undefined = 还没试过；false = 试过不行（非 macOS 等），本次运行一直用采样 */
  private nativeOk: boolean | undefined = undefined;
  private useNative = false;
  private raf = 0;
  private feedTimer = 0;

  private session: Session | null = null;
  /** 采样：时间线第 0 秒对应的 AudioContext 时刻 */
  private base = 0;
  /** 原生：时间线第 0 秒对应的 performance.now()/1000 */
  private startPerf = 0;
  /** 本段起点（秒）：光标不早于它（采样那 LEAD 的余量里不回退到前一个音） */
  private segStart = 0;
  /** 暂停时的位置（秒） */
  private pausedAt = 0;
  /** 采样：下一个要递给 smplr 的音 */
  private feedIdx = 0;
  /** 采样：已递出去、可能还没响完的音的撤销函数（定位 / 停止时撤掉） */
  private fed: { end: number; stop: (time?: number) => void }[] = [];
  private curIdx = -1;
  private gen = 0; // invalidates in-flight async play() when stop()/replay happens

  constructor(
    private onChord: (id: ElementId | null, pass: number) => void,
    private onStateChange: (state: PlayState) => void,
    /** 播放中每帧报一次位置（秒），进度条用 */
    private onTick: (pos: number) => void = () => {},
  ) {}

  get playing(): boolean {
    return this.state === "playing";
  }

  /** 当前会话总长（秒）；没有会话为 0。 */
  get duration(): number {
    return this.session?.duration ?? 0;
  }

  /** 当前位置（秒）：播放中取时钟，暂停取停下那一刻；没有会话为 0。 */
  get position(): number {
    if (this.state === "paused") return this.pausedAt;
    if (this.state !== "playing" || !this.session) return 0;
    return Math.min(this.session.duration, Math.max(this.segStart, this.now()));
  }

  /** 开一个新会话，从 `startSec` 起播；`paused` = 备好后停在那儿不出声（暂停中改速度）。 */
  async play(src: PlaySource, opts?: PlayOptions, startSec = 0, paused = false): Promise<void> {
    this.stop();
    const gen = this.gen;
    const { tl, spq } = timelineSeconds(src, opts);
    if (tl.notes.length === 0) return;

    const toSec = (a: Timeline["anchors"][number]): Anchor => ({ t: a.t0 * spq, id: a.chord.id, pass: a.pass });
    this.session = {
      anchors: (this.cursorAllParts ? onsetAnchors(tl) : tl.anchors).map(toSec),
      lookup: [...tl.anchors, ...tl.allAnchors].map(toSec),
      notes: tl.notes
        .map((n) => ({
          t0: n.t0 * spq,
          t1: n.t1 * spq,
          pitch: n.pitch,
          velocity: Math.max(1, Math.round(n.velocity * partGain(opts, n.part))),
        }))
        .sort((a, b) => a.t0 - b.t0),
      duration: tl.duration * spq,
      src,
      opts,
      midi: null,
    };
    const start = Math.max(0, Math.min(startSec, this.session.duration));

    this.setState("loading");
    this.useNative = this.nativeOk !== false && isTauriRuntime();
    if (!this.useNative) {
      try {
        await this.ensureSampler();
      } catch (e) {
        if (gen === this.gen) this.stop();
        throw e;
      }
      if (gen !== this.gen) return;
    }

    if (paused) {
      this.pausedAt = start;
      this.moveCursor(start);
      this.setState("paused");
      return;
    }
    await this.startAt(start, gen);
  }

  /** 暂停：采样挂起 AudioContext（排好的音原样留着），原生停掉播放器、记下位置。 */
  pause(): void {
    if (this.state !== "playing") return;
    this.pausedAt = this.position;
    this.gen++;
    this.stopClock();
    if (this.useNative) this.nativeStop();
    else void this.ctx?.suspend();
    this.setState("paused");
  }

  /** 从暂停处接着播。 */
  async resume(): Promise<void> {
    if (this.state !== "paused") return;
    const gen = ++this.gen;
    if (!this.useNative && this.ctx && this.feedIdx > 0) {
      // 暂停时排好的队列还在：解挂即可
      this.setState("loading");
      await this.ctx.resume();
      if (gen !== this.gen) return;
      this.setState("playing");
      this.runClock();
      return;
    }
    this.setState("loading");
    await this.startAt(this.pausedAt, gen);
  }

  /** 定位到第 `sec` 秒：播放中接着从那儿播，暂停中只挪位置。 */
  async seek(sec: number): Promise<void> {
    const s = this.session;
    if (!s || (this.state !== "playing" && this.state !== "paused")) return;
    const t = Math.max(0, Math.min(sec, s.duration));
    if (this.state === "paused") {
      this.pausedAt = t;
      this.unfeed();
      this.feedIdx = 0; // 采样：队列作废，续播时重排
      this.moveCursor(t);
      this.onTick(t);
      return;
    }
    const gen = ++this.gen;
    this.stopClock();
    await this.startAt(t, gen);
  }

  /** 当前会话里某个音的起音秒数（点音符跳转用）；不在这份会话里为 null。 */
  timeOf(point: PlayPoint): number | null {
    const s = this.session;
    if (!s) return null;
    return findAnchor(s.lookup, point, (x) => x.id)?.t ?? null;
  }

  stop(): void {
    this.gen++; // invalidate any in-flight play()
    this.stopClock();
    this.unfeed();
    this.inst?.stop();
    if (this.ctx && this.ctx.state === "running") void this.ctx.suspend();
    if (this.useNative) this.nativeStop();
    this.session = null;
    this.feedIdx = 0;
    this.pausedAt = 0;
    this.curIdx = -1;
    this.onChord(null, 0);
    this.setState("stopped");
  }

  // ---------------- 内部 ----------------

  /** 从第 `t` 秒起出声并走钟。调用方已把状态置为 loading / playing。 */
  private async startAt(t: number, gen: number): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.segStart = t;
    if (this.useNative) {
      try {
        s.midi ??= Array.from(toMidi(s.src, s.opts)); // per-part CC7 volume baked in
        const { invoke } = await import("@tauri-apps/api/core");
        if (gen !== this.gen) return;
        await invoke("midi_play_cmd", { bytes: s.midi, startSeconds: t });
        if (gen !== this.gen) {
          this.nativeStop();
          return;
        }
        this.nativeOk = true;
        this.startPerf = performance.now() / 1000 - t;
      } catch (e) {
        console.warn("native MIDI playback failed, falling back to sampler", e);
        this.nativeOk = false;
        this.useNative = false;
        await this.ensureSampler();
        if (gen !== this.gen) return;
      }
    }
    if (!this.useNative) {
      const ctx = this.ctx!;
      // 先撤旧音再解挂：暂停中定位时，挂起前那几个音不能在解挂的一瞬间冒出来
      this.unfeed();
      this.inst?.stop();
      await ctx.resume();
      if (gen !== this.gen) return;
      this.base = ctx.currentTime + LEAD - t;
      // 跨过起点的长音截短了照样起音；其余从起点之后按窗口陆续递
      let i = 0;
      for (; i < s.notes.length && s.notes[i].t0 < t; i++) {
        const n = s.notes[i];
        if (n.t1 > t + 0.05) this.feedNote(n, t);
      }
      this.feedIdx = i;
      this.feed();
    }
    this.moveCursor(t);
    this.setState("playing");
    this.runClock();
  }

  private async ensureSampler(): Promise<void> {
    if (!this.ctx) this.ctx = new AudioContext();
    await this.ctx.resume();
    if (this.inst) return;
    if (!this.instLoading) {
      const inst = Soundfont(this.ctx, { kit: "FluidR3_GM", instrument: "acoustic_grand_piano" });
      this.instLoading = inst.ready.then(() => inst);
    }
    try {
      this.inst = await this.instLoading;
    } finally {
      this.instLoading = null;
    }
  }

  /** 采样：把起音落在 [now, now + FEED_AHEAD) 里的音递给 smplr。 */
  private feed = (): void => {
    const s = this.session;
    const ctx = this.ctx;
    const inst = this.inst;
    if (!s || !ctx || !inst || this.useNative) return;
    const horizon = ctx.currentTime - this.base + FEED_AHEAD;
    while (this.feedIdx < s.notes.length && s.notes[this.feedIdx].t0 < horizon) {
      this.feedNote(s.notes[this.feedIdx], this.segStart);
      this.feedIdx++;
    }
    const now = ctx.currentTime;
    if (this.fed.length > 64) this.fed = this.fed.filter((f) => f.end > now);
  };

  private feedNote(n: Session["notes"][number], from: number): void {
    const ctx = this.ctx!;
    const t0 = Math.max(n.t0, from);
    const time = Math.max(ctx.currentTime + LEAD * 0.5, this.base + t0);
    const duration = Math.max(0.05, n.t1 - t0);
    const stop = this.inst!.start({ note: n.pitch, time, duration, velocity: n.velocity });
    this.fed.push({ end: time + duration, stop });
  }

  /** 采样：撤掉递出去的音（还在 smplr 队列里的取消，已发声的停掉）。 */
  private unfeed(): void {
    for (const f of this.fed) f.stop();
    this.fed = [];
  }

  private nativeStop(): void {
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("midi_stop_cmd")).catch(() => {});
  }

  private now(): number {
    return this.useNative ? performance.now() / 1000 - this.startPerf : this.ctx!.currentTime - this.base;
  }

  private runClock(): void {
    this.stopClock();
    if (!this.useNative) this.feedTimer = window.setInterval(this.feed, 250);
    this.tick();
  }

  private stopClock(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.feedTimer) {
      clearInterval(this.feedTimer);
      this.feedTimer = 0;
    }
  }

  /** 光标挪到第 `t` 秒那个音（定位后可能往回走，重新找）。 */
  private moveCursor(t: number): void {
    const anchors = this.session?.anchors ?? [];
    let lo = 0;
    let hi = anchors.length; // 第一个 t > 当前时刻的锚点
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].t <= t + 1e-6) lo = mid + 1;
      else hi = mid;
    }
    const idx = lo - 1;
    if (idx === this.curIdx) return;
    this.curIdx = idx;
    const a = idx >= 0 ? anchors[idx] : null;
    this.onChord(a?.id ?? null, a ? a.pass : 0);
  }

  private tick = (): void => {
    if (this.state !== "playing" || !this.session) return;
    const t = Math.max(this.segStart, this.now());
    if (t >= this.session.duration + 0.3) {
      this.stop();
      return;
    }
    // 播放中时间单调，往前走即可
    const anchors = this.session.anchors;
    let idx = this.curIdx;
    while (idx + 1 < anchors.length && anchors[idx + 1].t <= t) idx++;
    if (idx !== this.curIdx) {
      this.curIdx = idx;
      const a = idx >= 0 ? anchors[idx] : null;
      this.onChord(a?.id ?? null, a ? a.pass : 0);
    }
    this.onTick(Math.min(t, this.session.duration));
    this.raf = requestAnimationFrame(this.tick);
  };

  private setState(s: PlayState): void {
    if (this.state === s) return;
    this.state = s;
    this.onStateChange(s);
  }
}
