// 试听播放的编辑器侧控制器：播放器实例、速度倍率与分声部音量、播放按钮与速度下拉。
//
// 从 App 里切出来的一块。**谱面高亮不在这里**——简谱与文本谱的高亮走各自排版器的索引
// （JinpuPainter 按 Chord+演唱遍数、PuPainter 按 AST 节点+verse），那属于「谁在画谱面」，
// 留在 App。控制器只通过 PlaybackHost 要「当前该播哪份 Score」与「高亮到这一个和弦」。
import { ScorePlayer, type PlayState } from "./player";
import { playTempo, SPEED_STEPS, type PlayOptions } from "../score/timeline";
import type { Chord, Score } from "../score/score";

/** PlaybackController 向编辑器要的能力。 */
export interface PlaybackHost {
  /** 当前是否处于可试听的预览模式（混排/识别核对下不试听）。 */
  readonly canPlay: boolean;
  /** 当前该播哪份 Score（文本谱要先转一遍）。没有可播内容返回 null。 */
  playableScore(): Score | null;
  /** 谱面上标注的速度 ♩=NN（0 = 未标注）。 */
  readonly scoreTempo: number;
  /** 算「当前实际 BPM」用的那份 Score（速度提示文案用）。 */
  readonly tempoScore: Score;
  /** 从哪个音开始播（用户在谱面上选中了某个音时）。 */
  startPoint(): { chord: Chord; pass: number } | undefined;
  /** 播到某个和弦：把谱面高亮挪过去并保证可见。null = 清高亮。 */
  highlightPlaying(chord: Chord | null, pass: number): void;

  setStatus(text: string): void;
  saveSettings(): void;
}

export class PlaybackController {
  private player: ScorePlayer | null = null;
  private btnEl: HTMLButtonElement | null = null;
  private speedSelEl: HTMLSelectElement | null = null;
  /** 逐声部线性音量 [0,1]，下标 = 声部序号。缺省视为 1（满音量）。 */
  readonly partVolumes: number[] = [];
  /** 播放速度倍率（相对谱面标注速度）。持久化。 */
  speed = 1;

  constructor(private host: PlaybackHost) {}

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

  /** 工具条速度下拉与谱速提示的同步（换谱、改倍率后调用）。 */
  refreshSpeedUi(): void {
    const sel = this.speedSelEl;
    if (!sel) return;
    sel.value = String(this.speed);
    const bpm = Math.round(playTempo(this.host.tempoScore, this.options()));
    const marked = this.host.scoreTempo > 0 ? `谱面 ♩=${this.host.scoreTempo}` : "谱面未标速度，按 ♩=90";
    sel.title = `播放速度：${marked}，当前 ♩=${bpm}`;
  }

  /** 设置速度倍率并持久化；正在播放时按新速度重播（音已排好队，只能重来）。 */
  setSpeed(mul: number): void {
    const v = clampSpeed(mul);
    if (v === this.speed) return;
    this.speed = v;
    this.host.saveSettings();
    this.refreshSpeedUi();
    if (this.player?.state === "playing") void this.play();
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
  async play(): Promise<void> {
    if (!this.host.canPlay) return;
    const score = this.host.playableScore();
    if (!score) {
      this.host.setStatus("这份文本谱里没有可试听的曲行");
      return;
    }
    try {
      await this.instance().play(score, this.options(), this.host.startPoint());
    } catch (e) {
      console.error("playback failed", e);
      this.player?.stop();
      this.host.setStatus("试听加载失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  async toggle(): Promise<void> {
    if (this.player?.state === "playing" || this.player?.state === "loading") {
      this.stop();
      return;
    }
    await this.play();
  }

  stop(): void {
    this.player?.stop();
  }

  private instance(): ScorePlayer {
    if (!this.player) {
      this.player = new ScorePlayer(
        (chord, pass) => this.host.highlightPlaying(chord, pass),
        (state) => this.onState(state),
      );
    }
    return this.player;
  }

  private onState(state: PlayState): void {
    if (!this.btnEl) return;
    const label = state === "loading" ? "加载中" : state === "playing" ? "停止" : "播放";
    const icon = this.btnEl.querySelector<HTMLElement>(".playback-icon");
    const labelEl = this.btnEl.querySelector<HTMLElement>(".playback-label");
    this.btnEl.dataset.state = state;
    this.btnEl.disabled = state === "loading";
    this.btnEl.setAttribute("aria-label", label);
    this.btnEl.title = state === "playing" ? "停止试听" : state === "loading" ? "正在加载试听音色" : "播放试听";
    if (labelEl) labelEl.textContent = label;
    if (icon) {
      icon.classList.toggle("is-loading", state === "loading");
      icon.textContent = state === "playing" ? "■" : state === "loading" ? "" : "▶";
    }
  }
}

const clampSpeed = (v: number): number => Math.max(0.25, Math.min(3, v));
