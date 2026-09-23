// 试听播放的编辑器侧控制器：播放器实例、速度倍率与分声部音量、播放/暂停/停止按钮、进度条与速度下拉。
//
// 从 App 里切出来的一块。**谱面高亮不在这里**——按元素 id + 遍次找到画出来的那个音
// （`ScorePainter.highlight`），那属于「谁在画谱面」，由 App 转给排版器。
// 控制器只通过 PlaybackHost 要「当前该播哪份谱」（由 ScoreDoc 拼的 `PlaySource`）与「高亮到这个元素」。
import { anchorSeconds, ScorePlayer, timelineSeconds, type PlayPoint, type PlayState } from "./player";
import { SPEED_STEPS, TEMPO, type PlayOptions, type PlaySource, type Timeline } from "../score/timeline";
import type { ElementId } from "../model/doc";

/** PlaybackController 向编辑器要的能力。 */
export interface PlaybackHost {
  /** 当前是否处于可试听的预览模式（识别核对下不试听）。 */
  readonly canPlay: boolean;
  /** 光标跟各声部起音（五线谱 / 混排的竖直播放线），而不是只跟旋律（简谱逐音着色）。 */
  readonly cursorAllParts: boolean;
  /** 当前该播的谱（各声部 + 演唱顺序 + 速度）。没有可播内容返回 null。 */
  playable(): PlaySource | null;
  /** 从哪个音开始播（用户在谱面上选中了某个音时）。 */
  startPoint(): PlayPoint | undefined;
  /** 播到某个元素：把谱面高亮挪过去并保证可见。null = 清高亮。 */
  highlightPlaying(id: ElementId | null, pass: number): void;

  setStatus(text: string): void;
  saveSettings(): void;
}

/** 秒 → `m:ss`。 */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class PlaybackController {
  private player: ScorePlayer | null = null;
  private btnEl: HTMLButtonElement | null = null;
  private stopBtnEl: HTMLButtonElement | null = null;
  private speedSelEl: HTMLSelectElement | null = null;
  private progressEl: HTMLInputElement | null = null;
  private timeEl: HTMLElement | null = null;
  /** 时间显示「剩余」而不是「已播」（点时间切换）。 */
  private showRemaining = false;
  /** 正在拖进度条：播放器的位置回报先不往进度条上写。 */
  private scrubbing = false;
  /** 停止状态下拖进度条 / 点音符定下的起播秒数；开播后清掉。 */
  private cueSec: number | null = null;
  /** 停止状态下算总长、换算起播点用的时间线（按谱与速度缓存）。 */
  private tlCache: { src: PlaySource; speed: number; tl: Timeline; spq: number } | null = null;
  /** 逐声部线性音量 [0,1]，下标 = 声部序号。缺省视为 1（满音量）。 */
  readonly partVolumes: number[] = [];
  /** 播放速度倍率（相对谱面标注速度）。持久化。 */
  speed = 1;

  constructor(private host: PlaybackHost) {}

  get state(): PlayState {
    return this.player?.state ?? "stopped";
  }

  /** 正在试听（或在加载音源）。可视化编辑的按键发声在这时让路。 */
  get busy(): boolean {
    return this.state === "playing" || this.state === "loading";
  }

  /** 有一个播放会话（播放中或暂停中）：点音符、拖进度条直接在会话里定位。 */
  get active(): boolean {
    return this.state === "playing" || this.state === "paused";
  }

  // ---------------- 持久化 ----------------
  loadSettings(s: { playSpeed?: unknown }): void {
    if (typeof s.playSpeed === "number" && s.playSpeed > 0) {
      this.speed = clampSpeed(s.playSpeed);
    }
  }

  // ---------------- 工具条绑定 ----------------
  setPlaybackBtn(el: HTMLButtonElement): void {
    this.btnEl = el;
    this.onState("stopped");
  }

  setStopBtn(el: HTMLButtonElement): void {
    this.stopBtnEl = el;
    el.addEventListener("click", () => this.stop());
    this.onState(this.state);
  }

  /** 进度条（`<input type=range>`）与时间显示。拖动时只改显示，松手才定位。 */
  bindProgress(range: HTMLInputElement, time: HTMLElement | null): void {
    this.progressEl = range;
    this.timeEl = time;
    range.min = "0";
    range.step = "any";
    range.addEventListener("input", () => {
      this.scrubbing = true;
      this.renderProgress(parseFloat(range.value) || 0);
    });
    range.addEventListener("change", () => {
      this.scrubbing = false;
      void this.seekSec(parseFloat(range.value) || 0);
    });
    time?.addEventListener("click", () => {
      this.showRemaining = !this.showRemaining;
      this.refreshProgress();
    });
    this.refreshProgress();
  }

  bindSpeedSelect(el: HTMLSelectElement): void {
    this.speedSelEl = el;
    el.innerHTML = "";
    for (const v of SPEED_STEPS) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = v === 1 ? "原速" : `×${v}`;
      el.append(o);
    }
    el.addEventListener("change", () => this.setSpeed(parseFloat(el.value) || 1));
    this.refreshSpeedUi();
  }

  /** 工具条速度下拉与谱速提示的同步（换谱、改倍率后调用）。进度条总长随之刷新。 */
  refreshSpeedUi(): void {
    this.refreshProgress();
    const sel = this.speedSelEl;
    if (!sel) return;
    sel.value = String(this.speed);
    const src = this.host.playable();
    const tempo = src?.playData.tempo ?? 0;
    const bpm = Math.round((tempo > 0 ? tempo : TEMPO) * clampSpeed(this.speed)); // 同 `playTempo`
    const marked = tempo > 0 ? `谱面 ♩=${tempo}` : "谱面未标速度，按 ♩=90";
    sel.title = `播放速度：${marked}，当前 ♩=${bpm}`;
  }

  /** 设置速度倍率并持久化；有播放会话时从当前位置按新速度接着播（暂停中仍停着）。 */
  setSpeed(mul: number): void {
    const v = clampSpeed(mul);
    if (v === this.speed) return;
    const old = this.speed;
    this.speed = v;
    this.host.saveSettings();
    this.refreshSpeedUi();
    const p = this.player;
    if (!p || !this.active) return;
    // 谱面 ♩= 不变，秒数只随倍率反比缩放
    const at = (p.position * old) / v;
    const paused = p.state === "paused";
    const src = this.host.playable();
    if (!src) return;
    p.cursorAllParts = this.host.cursorAllParts;
    void this.run(() => p.play(src, this.options(), at, paused));
  }

  // ---------------- 音量 ----------------
  getPartVolume(i: number): number {
    const v = this.partVolumes[i];
    return v === undefined ? 1 : v;
  }

  setPartVolume(i: number, v: number): void {
    this.partVolumes[i] = Math.max(0, Math.min(1, v));
  }

  /** 试听/导出 MIDI 共用的播放参数。 */
  options(): PlayOptions {
    return { partVolumes: this.partVolumes, speed: this.speed };
  }

  // ---------------- 播放 ----------------
  /** 开播：起点依次取拖进度条定的位置、选中的音、曲首。 */
  async play(): Promise<void> {
    if (!this.host.canPlay) return;
    const src = this.host.playable();
    if (!src) {
      this.host.setStatus("这份谱里没有可试听的曲行");
      return;
    }
    let start = this.cueSec;
    if (start === null) {
      const pt = this.host.startPoint();
      const t = pt ? this.timeline(src) : null;
      start = pt && t ? anchorSeconds(t.tl, t.spq, pt) : null;
    }
    this.cueSec = null;
    const p = this.instance();
    p.cursorAllParts = this.host.cursorAllParts;
    await this.run(() => p.play(src, this.options(), start ?? 0));
  }

  /** 播放按钮：停止 → 播放，播放中 → 暂停，暂停中 → 继续，加载中 → 停止。 */
  async toggle(): Promise<void> {
    const p = this.player;
    switch (this.state) {
      case "playing":
        p?.pause();
        return;
      case "paused":
        await this.run(() => p!.resume());
        return;
      case "loading":
        this.stop();
        return;
      default:
        await this.play();
    }
  }

  /** 停止：清高亮、回到曲首（起播点仍按选中的音）。 */
  stop(): void {
    this.cueSec = null;
    this.player?.stop();
    this.refreshProgress();
  }

  /** 点中了某个音：有播放会话就跳过去接着播（暂停中只挪位置），停止中记为下次的起点。 */
  seekTo(point: PlayPoint): void {
    const p = this.player;
    if (p && this.active) {
      const t = p.timeOf(point);
      if (t !== null) void this.run(() => p.seek(t));
      return;
    }
    const src = this.host.playable();
    const t = src ? this.timeline(src) : null;
    this.cueSec = t ? anchorSeconds(t.tl, t.spq, point) : null;
    this.refreshProgress();
  }

  /** 定位到第 `sec` 秒（进度条松手）。 */
  async seekSec(sec: number): Promise<void> {
    const p = this.player;
    if (p && this.active) {
      await this.run(() => p.seek(sec));
      return;
    }
    this.cueSec = Math.max(0, sec);
    this.refreshProgress();
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error("playback failed", e);
      this.player?.stop();
      this.host.setStatus("试听加载失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  /** 停止状态下的时间线（总长、起播点换算）；按谱与速度缓存。 */
  private timeline(src: PlaySource): { tl: Timeline; spq: number } | null {
    const c = this.tlCache;
    if (c && c.src === src && c.speed === this.speed) return c;
    try {
      const { tl, spq } = timelineSeconds(src, this.options());
      this.tlCache = { src, speed: this.speed, tl, spq };
      return this.tlCache;
    } catch (e) {
      console.error("试听时间线拼不出", e);
      return null;
    }
  }

  private instance(): ScorePlayer {
    if (!this.player) {
      this.player = new ScorePlayer(
        (id, pass) => this.host.highlightPlaying(id, pass),
        (state) => this.onState(state),
        (pos) => {
          if (!this.scrubbing) this.renderProgress(pos);
        },
      );
    }
    return this.player;
  }

  /** 进度条与时间显示按当前状态重画（换谱、停止、切换显示方式后）。 */
  private refreshProgress(): void {
    const p = this.player;
    if (p && this.active) {
      this.renderProgress(p.position);
      return;
    }
    this.renderProgress(this.cueSec ?? 0);
  }

  private durationSec(): number {
    const p = this.player;
    if (p && this.active) return p.duration;
    if (!this.progressEl && !this.timeEl) return 0;
    const src = this.host.canPlay ? this.host.playable() : null;
    const t = src ? this.timeline(src) : null;
    return t ? t.tl.duration * t.spq : 0;
  }

  private renderProgress(pos: number): void {
    const range = this.progressEl;
    const time = this.timeEl;
    if (!range && !time) return;
    const dur = this.durationSec();
    const at = Math.max(0, Math.min(pos, dur));
    if (range) {
      range.max = String(dur || 1);
      range.value = String(at);
      range.disabled = dur <= 0;
      range.style.setProperty("--progress", `${dur > 0 ? (at / dur) * 100 : 0}%`);
    }
    if (time) {
      time.textContent = this.showRemaining ? `-${fmtTime(dur - at)} / ${fmtTime(dur)}` : `${fmtTime(at)} / ${fmtTime(dur)}`;
      time.title = `已播 ${fmtTime(at)}，剩余 ${fmtTime(dur - at)}，总长 ${fmtTime(dur)}（点击切换已播 / 剩余）`;
    }
  }

  private onState(state: PlayState): void {
    if (this.stopBtnEl) this.stopBtnEl.disabled = state === "stopped";
    if (state === "stopped" || state === "paused") this.refreshProgress();
    if (!this.btnEl) return;
    const label = state === "loading" ? "加载中" : state === "playing" ? "暂停" : state === "paused" ? "继续" : "播放";
    const icon = this.btnEl.querySelector<HTMLElement>(".playback-icon");
    const labelEl = this.btnEl.querySelector<HTMLElement>(".playback-label");
    this.btnEl.dataset.state = state;
    this.btnEl.disabled = state === "loading";
    this.btnEl.setAttribute("aria-label", label);
    this.btnEl.title =
      state === "playing" ? "暂停试听" : state === "paused" ? "从暂停处接着播" : state === "loading" ? "正在加载试听音色" : "播放试听";
    if (labelEl) labelEl.textContent = label;
    if (icon) {
      icon.classList.toggle("is-loading", state === "loading");
      icon.textContent = state === "playing" ? "❚❚" : state === "loading" ? "" : "▶";
    }
  }
}

const clampSpeed = (v: number): number => Math.max(0.25, Math.min(3, v));
