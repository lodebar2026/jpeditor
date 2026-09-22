// 可视化编辑控制器：谱面上的选中、光标、键盘与点击。
//
// **源码仍是真身**：选中、移动都只是改代码区的选区；改谱的动作落成对原文的局部补丁
// （`view.dispatch({ changes })`），撤销重做直接用代码区那份 history。
// 光标状态只有一份——代码区选区（非空 = 编辑模式，空 = 插入模式），谱面光标由它推出（`overlay.ts`）。
//
// 与 omr / playback 两个控制器同一个做法：通过一个**列全了的**宿主接口 `VisualHost` 向 App 要能力。

import { redo, undo } from "@codemirror/commands";
import { type ChangeSpec, ChangeSet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { ElementId, ScoreDoc } from "../../model/doc";
import { type BeatIssue, checkMeasureDurations, describeBeatIssue } from "../../model/beatcheck";
import type { BreakMark, SyncEntry, SyncIndex } from "../sync";
import { deleteBreak, insertBreak } from "./breaks";
import { setBeatSpans, setBreakSpans, setScoreFocus } from "./cursor";
import { buildPalette, type MenuRunner, type MenuTarget, showMenu } from "./menu";
import { midiOf, NotePreview } from "./preview";
import type { EditDialect, NoteDuration } from "./dialect";
import {
  addSustain, deleteEntries, double, type EditCtx, type EditOutcome, groupEnd, halve, insertNote, insertToken,
  isError, noteCtx, noteSpans, notesIn, setAccidental, setDegree, shiftOctave, toggleDeco, toggleDot, toggleSlur, toggleTie,
} from "./ops";
import { actionOfKey, type VisualAction, type VisualMode } from "./keys";
import {
  type Box, boxInPage, charIndexAt, clearOverlay, drawBlock, drawBreak, drawCaret, hitThroughOverlay, musicBox, rightEdgeInBand,
  sameRow, setBeatIssues, textCaretInPage,
} from "./overlay";

export interface VisualHost {
  readonly view: EditorView;
  /** 当前的双向定位索引（每次重排后重建） */
  readonly sync: SyncIndex;
  readonly scorePane: HTMLElement;
  /** 此刻能不能可视化编辑：有代码区、在简谱档、不在识别核对 */
  visualEnabled(): boolean;
  /** 条目在谱面上的 `<g>`（增时线、记号借宿主音符的） */
  entryEl(entry: SyncEntry): SVGGElement | null;
  /** 音符在谱面上的 `<g>` */
  noteEl(id: ElementId): SVGGElement | null;
  /** 文字条目（歌词、页眉字段）在谱面上的 `<g>`：页眉的多行署名、调号拍号一组不止一个 */
  textEls(entry: SyncEntry): SVGGElement[];
  /** 音符的附点在谱面上的 `<g>`（每个点一个；可单独点选） */
  augDotEls(id: ElementId): SVGGElement[];
  /** 谱面上点中的 `<g>` 对应哪个条目（从事件目标往上找） */
  entryAtTarget(target: EventTarget | null): SyncEntry | null;
  /** 当前格式怎么改原文；null = 这种格式在谱面上只能选中、不能改 */
  editDialect(): EditDialect | null;
  /** 建索引用的那份模型（与 `sync` 同一版） */
  syncDoc(): ScoreDoc | null;
  /** 改完原文马上重排（不等输入防抖） */
  reloadNow(): void;
  /** 正在试听：按键发声让路 */
  playbackBusy(): boolean;
  /** 索引是不是按代码区当前的原文建的（代码区刚改过、重排还在防抖里时为 false） */
  syncFresh(): boolean;
  setStatus(text: string): void;
  saveSettings(): void;
}

/** 方向键能停的条目：音符、增时线、小节线、原文里有符号的换行 */
const NAVIGABLE = new Set<SyncEntry["kind"]>(["note", "sustain", "barline", "break"]);

export class VisualEditController {
  /** 谱面上显示换行/换页符号。持久化。 */
  showFormatMarks = true;
  /** 插入或改音后响一下（按键即发声）。持久化。 */
  noteSound = true;
  /** 发声用的音源；回归脚本可换成假的，断言它收到的音高 */
  preview: { play(midi: number): unknown } = new NotePreview();
  /** 小节时值自检：拍数对不上的小节标红。持久化。 */
  beatCheck = true;
  private beatIssues: BeatIssue[] = [];
  /** 原文里的空小节 `| |`（整小节的音删光了）。模型里没有它（解析时空小节不成小节），小节时值自检看不见，另从原文认 */
  private emptyBars: { from: number; to: number }[] = [];
  /** 打开时首小节就不满（弱起）的声部 `songIndex:partIndex`；null = 刚打开、还没查过（`documentLoaded`） */
  private pickups: Set<string> | null = null;
  private beatBtn: HTMLButtonElement | null = null;
  private beatEl: HTMLElement | null = null;
  /** 计数标签点一下跳到下一处：上次跳到第几处 */
  private beatCursor = -1;
  /** 记号面板：显示与否持久化 */
  showPalette = false;
  private paletteEl: HTMLElement | null = null;
  private paletteBtn: HTMLButtonElement | null = null;
  private paletteRefresh: (() => void) | null = null;
  private modeEl: HTMLElement | null = null;
  private marksBtn: HTMLButtonElement | null = null;
  /** 叠加层里画出来的换行符号 → 它那一处换行 */
  private breakEls = new Map<Element, BreakMark>();
  /** 点中的一处**原文里没有符号**的换行（文本谱另起一行 `Q:`）：选区表达不了它，另记一份；
   *  `sel` 是点中时的光标位置，选区一挪开就作废 */
  private pickedBreak: { after: ElementId; sel: number } | null = null;
  /** 插入模式的「当前时值」：新插的音符用它 */
  curDur: NoteDuration = { halvings: 0, dots: 0 };

  constructor(private host: VisualHost) {}

  // ---------------- 装配 ----------------

  /** 谱面可聚焦、接键盘；工具条上的模式标签与格式标记开关。 */
  attach(els: {
    mode: HTMLElement | null; marksBtn: HTMLButtonElement | null;
    beatBtn: HTMLButtonElement | null; beatCount: HTMLElement | null;
    palette: HTMLElement | null; paletteBtn: HTMLButtonElement | null;
  }): void {
    const { mode: modeEl, marksBtn, beatBtn, beatCount: beatEl } = els;
    const pane = this.host.scorePane;
    pane.addEventListener("contextmenu", (ev) => this.onContextMenu(ev));
    this.paletteEl = els.palette;
    this.paletteBtn = els.paletteBtn;
    if (els.palette) this.paletteRefresh = buildPalette(els.palette, this.runner);
    els.paletteBtn?.addEventListener("click", () => {
      this.showPalette = !this.showPalette;
      this.syncButtons();
      this.host.saveSettings();
      this.refresh();
    });
    pane.tabIndex = 0;
    pane.addEventListener("keydown", (ev) => this.onKeyDown(ev));
    pane.addEventListener("focus", () => this.setFocus(true));
    pane.addEventListener("blur", () => this.setFocus(false));
    // 点谱面就把焦点给谱面（SVG 里的点击不会自己聚焦到容器上）
    pane.addEventListener("pointerdown", () => {
      if (this.host.visualEnabled()) pane.focus({ preventScroll: true });
    });
    this.modeEl = modeEl;
    this.marksBtn = marksBtn;
    marksBtn?.addEventListener("click", () => this.toggleFormatMarks());
    this.beatBtn = beatBtn;
    this.beatEl = beatEl;
    beatBtn?.addEventListener("click", () => this.toggleBeatCheck());
    beatEl?.addEventListener("click", () => this.nextBeatIssue());
    this.syncButtons();
  }

  loadSettings(s: { showFormatMarks?: unknown; beatCheck?: unknown; noteSound?: unknown; showPalette?: unknown }): void {
    if (typeof s.showPalette === "boolean") this.showPalette = s.showPalette;
    if (typeof s.showFormatMarks === "boolean") this.showFormatMarks = s.showFormatMarks;
    if (typeof s.noteSound === "boolean") this.noteSound = s.noteSound;
    if (typeof s.beatCheck === "boolean") this.beatCheck = s.beatCheck;
    this.syncButtons();
  }

  private setFocus(on: boolean): void {
    this.host.view.dispatch({ effects: setScoreFocus.of(on && this.host.visualEnabled()) });
    this.refresh();
  }

  private syncButtons(): void {
    for (const [btn, on] of [[this.marksBtn, this.showFormatMarks], [this.beatBtn, this.beatCheck], [this.paletteBtn, this.showPalette]] as const) {
      if (!btn) continue;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  }

  setNoteSound(on: boolean): void {
    this.noteSound = on;
    this.host.saveSettings();
  }

  /** 响一下光标处的音：编辑模式是选中的第一个音，插入模式是光标前那个。 */
  private sound(): void {
    if (!this.noteSound || this.host.playbackBusy()) return;
    const c = this.editCtx(true);
    if (!c) return;
    const sel = c.state.selection.main;
    const e = sel.empty
      ? [...this.navigable()].reverse().find((x) => x.kind === "note" && x.to <= sel.head)
      : notesIn(c, sel.from, sel.to)[0];
    if (!e) return;
    const nc = noteCtx(c, e.from);
    const t = c.dialect.parseNote(c.state.doc.sliceString(e.from, e.to), nc);
    if (!t || t.degree === 0) return;
    void this.preview.play(midiOf(t.degree, t.octave, t.acc, nc.fifths));
  }

  toggleBeatCheck(): void {
    this.beatCheck = !this.beatCheck;
    this.syncButtons();
    this.host.saveSettings();
    this.afterRebuild();
  }

  /** 拍数不对的小节与空小节，按原文顺序（计数标签逐个跳）。 */
  private beatMarks(): ({ at: number; issue: BeatIssue } | { at: number; empty: { from: number; to: number } })[] {
    const out: ({ at: number; issue: BeatIssue } | { at: number; empty: { from: number; to: number } })[] = [];
    for (const issue of this.beatIssues) {
      const first = this.host.sync.ordered().find((e) => e.kind === "note" && issue.ids.includes(e.id));
      out.push({ at: first?.from ?? issue.source?.offset ?? 0, issue });
    }
    for (const empty of this.emptyBars) out.push({ at: empty.from, empty });
    return out.sort((a, b) => a.at - b.at);
  }

  /** 计数标签：选中下一处拍数不对的小节的第一个音；空小节把插入光标放进两条小节线中间。 */
  private nextBeatIssue(): void {
    const marks = this.beatMarks();
    if (marks.length === 0) return;
    this.beatCursor = (this.beatCursor + 1) % marks.length;
    const m = marks[this.beatCursor]!;
    if ("empty" in m) {
      this.select(m.empty.from + 1, m.empty.from + 1);
      this.host.setStatus("这一小节是空的：光标已放进去，可以接着输入音符");
      return;
    }
    const first = this.host.sync.ordered().find((e) => e.kind === "note" && m.issue.ids.includes(e.id));
    if (first) {
      const span = this.noteSel(first);
      this.select(span.from, span.to);
    }
    this.host.setStatus(`第 ${m.issue.measureIndex + 1} 小节${describeBeatIssue(m.issue)}`);
  }

  /** 原文里的空小节：同一行里两条小节线之间只有空白，且这一行是曲谱行（行里有音符）。 */
  private findEmptyBars(): { from: number; to: number }[] {
    const doc = this.host.view.state.doc;
    const text = doc.toString();
    const musicLines = new Set(this.host.sync.ordered().filter((e) => e.kind === "note").map((e) => doc.lineAt(e.from).number));
    const out: { from: number; to: number }[] = [];
    for (const m of text.matchAll(/\|(?=([ \t]+)\|)/g)) {
      const from = m.index!;
      if (!musicLines.has(doc.lineAt(from).number)) continue;
      out.push({ from, to: from + 1 + m[1]!.length + 1 });
    }
    return out;
  }

  toggleFormatMarks(): void {
    this.showFormatMarks = !this.showFormatMarks;
    this.syncButtons();
    this.host.saveSettings();
    this.refresh();
  }

  // ---------------- 状态 ----------------

  get mode(): VisualMode {
    return this.host.view.state.selection.main.empty ? "insert" : "edit";
  }

  private get pages(): SVGSVGElement[] {
    return [...this.host.scorePane.querySelectorAll<SVGSVGElement>("svg.score-page")];
  }

  /** 按原文顺序、方向键能停的条目。 */
  private navigable(): SyncEntry[] {
    return this.host.sync.ordered().filter((e) => NAVIGABLE.has(e.kind));
  }

  /** 换了一份文档（打开、导入、识别落地）：弱起重新认。 */
  documentLoaded(): void {
    this.pickups = null;
  }

  /** 重排之后（索引重建了）：把换行符号的原文位置交给代码区，再重画谱面叠加层。 */
  afterRebuild(): void {
    const spans = this.host.sync.breaks().flatMap((b) => (b.span ? [b.span] : []));
    const doc = this.host.syncDoc();
    if (doc && this.pickups === null) {
      // 打开后第一次查：不放过弱起查一遍，首小节不满的声部才认它是弱起。之后改谱把首小节改短了照样报
      const strict = checkMeasureDurations(doc, { pickup: () => false });
      this.pickups = new Set(strict.filter((i) => i.measureIndex === 0 && i.got < i.want).map((i) => `${i.songIndex}:${i.partIndex}`));
    }
    const pickups = this.pickups;
    this.beatIssues = this.beatCheck && doc && this.host.visualEnabled()
      ? checkMeasureDurations(doc, { pickup: (s, p) => pickups?.has(`${s}:${p}`) ?? true })
      : [];
    this.emptyBars = this.beatCheck && doc && this.host.visualEnabled() ? this.findEmptyBars() : [];
    this.beatCursor = -1;
    const beatSpans = [
      ...this.beatIssues.flatMap((i) => (i.source ? [{ from: i.source.offset, to: i.source.offset + i.source.length }] : [])),
      ...this.emptyBars,
    ].sort((a, b) => a.from - b.from);
    this.host.view.dispatch({
      effects: [setBreakSpans.of(this.showFormatMarks ? spans : []), setBeatSpans.of(beatSpans)],
    });
    this.refresh();
  }

  /** 重画谱面叠加层与模式标签。选区一动、重排之后、焦点进出都要调。 */
  refresh(): void {
    const pages = this.pages;
    clearOverlay(pages, undefined, "vis-beat");
    this.breakEls.clear();
    const on = this.host.visualEnabled();
    if (this.modeEl) {
      this.modeEl.hidden = !on;
      this.modeEl.textContent = this.mode === "edit" ? "编辑" : `插入 · ${durName(this.curDur)}`;
      this.modeEl.dataset.mode = this.mode;
    }
    if (this.paletteEl) {
      this.paletteEl.hidden = !(on && this.showPalette);
      this.paletteRefresh?.();
    }
    if (this.beatEl) {
      const n = on ? this.beatIssues.length + this.emptyBars.length : 0;
      this.beatEl.hidden = n === 0;
      this.beatEl.textContent = `${n} 小节拍数不对`;
    }
    this.drawBeatIssues(on ? this.beatIssues : [], on ? this.emptyBars : []);
    if (!on) return;
    const sel = this.host.view.state.selection.main;
    if (this.pickedBreak && (!sel.empty || sel.head !== this.pickedBreak.sel)) this.pickedBreak = null;
    if (this.showFormatMarks) this.drawBreaks(sel.from, sel.to);
    if (sel.empty) this.drawInsertCaret(sel.head);
    else if (document.activeElement === this.host.scorePane) this.drawEditBlock(sel.from, sel.to);
  }

  private boxOf(entry: SyncEntry): { svg: SVGSVGElement; box: Box } | null {
    const el = this.host.entryEl(entry);
    return el ? musicBox(el) : null;
  }

  /** 拍数不对的小节：它的音符按行各圈一个淡红底；空小节圈前后两个音之间的空当。 */
  private drawBeatIssues(issues: readonly BeatIssue[], empties: readonly { from: number; to: number }[]): void {
    const perPage = new Map<SVGSVGElement, { box: Box; title: string }[]>(this.pages.map((p) => [p, []]));
    for (const issue of issues) {
      const boxes: { svg: SVGSVGElement; box: Box }[] = [];
      for (const id of issue.ids) {
        const el = this.host.noteEl(id);
        const hit = el && musicBox(el);
        if (!hit) continue;
        const same = boxes.find((b) => b.svg === hit.svg && sameRow(b.box, hit.box));
        if (same) same.box = union(same.box, hit.box);
        else boxes.push(hit);
      }
      const title = `第 ${issue.measureIndex + 1} 小节${describeBeatIssue(issue)}`;
      for (const b of boxes) perPage.get(b.svg)?.push({ box: b.box, title });
    }
    // 空小节：谱面上没有它的音符，框住前后两个音之间的空当（前后不在同一行就在前一个音后面留一格）
    const notes = empties.length ? this.host.sync.ordered().filter((e) => e.kind === "note") : [];
    for (const empty of empties) {
      const prev = [...notes].reverse().find((e) => e.to <= empty.from);
      const next = notes.find((e) => e.from >= empty.to);
      const pb = prev ? this.boxOf(prev) : null;
      const nb = next ? this.boxOf(next) : null;
      const ref = pb ?? nb;
      if (!ref) continue;
      const h = ref.box.h;
      let x0 = pb ? pb.box.x + pb.box.w + h * 0.6 : nb!.box.x - h * 1.8;
      let x1 = x0 + h * 1.2;
      if (pb && nb && nb.svg === pb.svg && sameRow(pb.box, nb.box)) {
        x0 = pb.box.x + pb.box.w + h * 0.4;
        x1 = Math.max(x0 + h * 0.6, nb.box.x - h * 0.4);
      }
      perPage.get(ref.svg)?.push({ box: { x: x0, y: ref.box.y, w: x1 - x0, h }, title: "空小节：这一小节的音都删掉了" });
    }
    for (const [svg, items] of perPage) setBeatIssues(svg, items);
  }

  private drawBreaks(selFrom: number, selTo: number): void {
    const cache = new Map<SVGSVGElement, Box[]>();
    for (const b of this.host.sync.breaks()) {
      const el = this.host.noteEl(b.after);
      const hit = el && musicBox(el);
      if (!hit) continue;
      const selected = b.span
        ? b.span.from >= selFrom && b.span.to <= selTo && selTo > selFrom
        : this.pickedBreak?.after === b.after || this.newlineSelected(b, selFrom, selTo);
      const x = rightEdgeInBand(hit.svg, hit.box, cache);
      this.breakEls.set(drawBreak(hit.svg, x, hit.box, b.page, selected), b);
    }
  }

  /** 插入光标：画在光标前那个元素的右缘；光标在行首（前后两个元素不同行）时画在后一个的左缘。 */
  private drawInsertCaret(head: number): void {
    if (this.drawTextCaret(head)) return;
    const inside = this.host.sync.at(head);
    if (inside && inside.from < head) return; // 光标落在 token 中间：那是在改原文，谱面上已高亮该元素
    const nav = this.navigable();
    let prev: SyncEntry | null = null;
    let next: SyncEntry | null = null;
    for (const e of nav) {
      if (e.to <= head) prev = e;
      else if (e.from >= head) {
        next = e;
        break;
      }
    }
    const pb = prev && prev.kind !== "break" ? this.boxOf(prev) : null;
    const nb = next && next.kind !== "break" ? this.boxOf(next) : null;
    const brokeBetween = prev?.kind === "break";
    if (pb && !brokeBetween && (!nb || nb.svg !== pb.svg || sameRow(pb.box, nb.box))) {
      drawCaret(pb.svg, pb.box.x + pb.box.w + pb.box.h * 0.12, pb.box);
    } else if (nb) {
      drawCaret(nb.svg, nb.box.x - nb.box.h * 0.12, nb.box);
    } else if (pb) {
      drawCaret(pb.svg, pb.box.x + pb.box.w + pb.box.h * 0.12, pb.box);
    }
  }

  /** 光标落在文字条目（歌词、页眉字段）里或两端：谱面上画在那串字里对应的位置。画了返回 true。 */
  private drawTextCaret(head: number): boolean {
    const e = this.host.sync.ordered().find((x) => isText(x) && head >= x.from && head <= x.to);
    if (!e) return false;
    const src = this.host.view.state.doc.sliceString(e.from, e.to);
    const texts = this.host.textEls(e).flatMap((el) => [...el.querySelectorAll("text")]);
    for (const t of texts) {
      const disp = t.textContent ?? "";
      const shift = textShift(disp, src);
      if (shift === null) continue;
      const di = head - e.from - shift;
      if (di < 0 || di > disp.length) continue;
      const c = textCaretInPage(t, di);
      if (!c) continue;
      drawCaret(c.svg, c.x, c.box);
      return true;
    }
    // 字对不上（`♭B` 对 `bB`、叠排的拍号）：画在这一项的右边
    const els = this.host.textEls(e);
    const boxes = els.map((el) => boxInPage(el)).filter((b): b is { svg: SVGSVGElement; box: Box } => !!b);
    if (boxes.length === 0) return false;
    const box = boxes.slice(1).reduce((a, b) => (b.svg === a.svg ? { svg: a.svg, box: union(a.box, b.box) } : a), boxes[0]!);
    drawCaret(box.svg, box.box.x + box.box.w + box.box.h * 0.12, box.box);
    return true;
  }

  /** 编辑方块：选区罩住的元素，按页、按行各画一个。 */
  private drawEditBlock(from: number, to: number): void {
    const dotOf = this.pickedDot();
    if (dotOf) {
      // 选中的是附点：方块只罩附点
      let hit: { svg: SVGSVGElement; box: Box } | null = null;
      for (const el of this.host.augDotEls(dotOf.id)) {
        const b = boxInPage(el);
        if (b) hit = hit ? { svg: hit.svg, box: union(hit.box, b.box) } : b;
      }
      if (hit) {
        drawBlock(hit.svg, hit.box);
        return;
      }
    }
    const boxes: { svg: SVGSVGElement; box: Box }[] = [];
    const seen = new Set<Element>();
    for (const e of this.host.sync.range(from, to)) {
      if (isText(e) || e.kind === "break") continue;
      const el = this.host.entryEl(e);
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const hit = musicBox(el);
      if (!hit) continue;
      const same = boxes.find((b) => b.svg === hit.svg && sameRow(b.box, hit.box));
      if (same) same.box = union(same.box, hit.box);
      else boxes.push(hit);
    }
    for (const b of boxes) drawBlock(b.svg, b.box);
  }

  // ---------------- 点击 ----------------

  /** 谱面上的点击。处理了返回 true（App 就不再走音符点选那条路）。 */
  handleClick(ev: MouseEvent, entry: SyncEntry | null): boolean {
    if (!this.host.visualEnabled()) return false;
    // 点在换行符号上：选中它
    const t = ev.target instanceof Element ? ev.target.closest(".vis-break") : null;
    const brk = t ? this.breakEls.get(t) : undefined;
    if (brk) {
      if (brk.span) {
        this.select(brk.span.from, brk.span.to);
        return true;
      }
      const nl = this.newlineOf(brk);
      if (nl !== null && this.host.editDialect()?.lyricBlockByCodeLine) {
        // ABC：换行就是代码行末那个换行符，选中它
        this.select(nl, nl + 1);
        return true;
      }
      // 文本谱：另起一行 `Q:`，原文里没有符号。光标落在行末，另记「点中了这处换行」
      const at = nl ?? this.host.view.state.selection.main.head;
      this.select(at, at);
      this.pickedBreak = { after: brk.after, sel: at };
      this.host.setStatus("选中了换行（文本谱另起一行 Q:），按 Delete 与下一行合并");
      this.refresh();
      return true;
    }
    // 点在文字上（歌词、页眉）：进插入模式——光标落在原文里点中的那个字前后，焦点交给代码区，接着打字就是改原文。
    // 只有音符与挂在它上面的东西点了进编辑模式（方块）
    if (entry && isText(entry)) {
      const at = this.textCaretAt(entry, ev.clientX, ev.clientY);
      this.select(at, at);
      this.host.view.focus();
      return true;
    }
    // 点在附点上（附点很小，四周放宽几像素）：只选中附点
    if (!ev.shiftKey) {
      const dot = this.dotAtPoint(ev.clientX, ev.clientY, entry);
      if (dot) {
        this.select(dot.from, dot.to);
        return true;
      }
    }
    if (entry) {
      // Shift+点击：从原来的选区扩到这个元素
      if (ev.shiftKey) {
        const sel = this.host.view.state.selection.main;
        const span = this.spanOfEntry(entry);
        this.select(Math.min(sel.from, span.from), Math.max(sel.to, span.to));
        return true;
      }
      // 点音符：只选中音头（升降号、唱名、八度点），不带减时线、附点
      if (entry.kind === "note") {
        const span = this.noteSel(entry);
        this.select(span.from, span.to);
        return true;
      }
      return false; // 其余（歌词、记号）：App 的双向定位照旧
    }
    // 点在空白处：找同一行里离得最近的元素，光标落到它前面或后面（插入模式）
    const caret = this.caretAtPoint(ev.clientX, ev.clientY);
    if (caret !== null) {
      this.select(caret, caret);
      return true;
    }
    return false;
  }

  /** 点在文字条目的哪个字前后 → 原文偏移。字对不上（`♭B` 对 `bB`、叠排的拍号）时按点在那一项的左半还是右半落到字段两端。 */
  private textCaretAt(e: SyncEntry, cx: number, cy: number): number {
    const src = this.host.view.state.doc.sliceString(e.from, e.to);
    let best: SVGTextElement | null = null;
    let bestD = Infinity;
    for (const el of this.host.textEls(e)) {
      for (const t of el.querySelectorAll("text")) {
        const r = t.getBoundingClientRect();
        const d = Math.max(0, r.left - cx, cx - r.right) + Math.max(0, r.top - cy, cy - r.bottom);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
    }
    if (!best) return e.to;
    const disp = best.textContent ?? "";
    const i = charIndexAt(best, cx, cy);
    const shift = textShift(disp, src);
    if (shift === null) return i <= disp.length / 2 ? e.from : e.to;
    return e.from + Math.max(0, Math.min(src.length, i + shift));
  }

  /** 点击点落在哪个音符的附点上（先看点中的那个音符，再看同一带里别的音符）；返回附点的原文区间。 */
  private dotAtPoint(cx: number, cy: number, entry: SyncEntry | null): { from: number; to: number } | null {
    const c = this.editCtx(true);
    if (!c) return null;
    const notes = entry?.kind === "note" ? [entry] : [];
    for (const e of this.navigable()) if (e.kind === "note" && e !== entry) notes.push(e);
    for (const e of notes) {
      const els = this.host.augDotEls(e.id);
      if (els.length === 0) continue;
      const hit = els.some((el) => {
        const r = el.getBoundingClientRect();
        const pad = Math.max(4, r.height);
        return cx >= r.left - pad && cx <= r.right + pad && cy >= r.top - pad && cy <= r.bottom + pad;
      });
      if (!hit) continue;
      const dots = noteSpans(c, e).dots;
      if (dots) return dots;
    }
    return null;
  }

  /** 选区恰好是某个音符的附点时，返回那个音符。 */
  pickedDot(): SyncEntry | null {
    const sel = this.host.view.state.selection.main;
    if (sel.empty) return null;
    const c = this.editCtx(true);
    const e = c && this.host.sync.at(sel.from);
    if (!c || !e || e.kind !== "note" || sel.to > e.to) return null;
    const dots = noteSpans(c, e).dots;
    return dots && dots.from === sel.from && dots.to === sel.to ? e : null;
  }

  /** 换行前那个元素所在代码行的行末（换行符的位置）。 */
  private newlineOf(b: BreakMark): number | null {
    const note = this.host.sync.spanOfNote(b.after);
    if (!note) return null;
    return this.host.view.state.doc.lineAt(note.to).to;
  }

  private newlineSelected(b: BreakMark, from: number, to: number): boolean {
    if (to !== from + 1) return false;
    return this.newlineOf(b) === from;
  }

  /** 屏幕坐标 → 插入位置：同一行（纵向覆盖点击点）里水平最近的元素，点在它中线左边就落在它前面。 */
  private caretAtPoint(cx: number, cy: number): number | null {
    let best: { e: SyncEntry; r: DOMRect; d: number } | null = null;
    for (const e of this.navigable()) {
      if (e.kind === "break") continue;
      const el = this.host.entryEl(e);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const pad = r.height * 0.6;
      if (cy < r.top - pad || cy > r.bottom + pad) continue;
      const d = cx < r.left ? r.left - cx : cx > r.right ? cx - r.right : 0;
      if (!best || d < best.d) best = { e, r, d };
    }
    if (!best || best.d > best.r.height * 3) return null;
    const span = this.spanOfEntry(best.e);
    return cx < (best.r.left + best.r.right) / 2 ? span.from : this.groupEnd(best.e);
  }

  // ---------------- 键盘 ----------------

  private onKeyDown(ev: KeyboardEvent): void {
    if (!this.host.visualEnabled()) return;
    const a = actionOfKey(ev);
    if (!a) return;
    if (this.runChecked(a, ev.key)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  /** 键盘、面板、菜单共用的入口：模式不对不做；索引落后于原文（刚撤销、刚在代码区打过字）先重排，免得按旧偏移改错地方。 */
  private runChecked(a: VisualAction, key = ""): boolean {
    if (a.modes && !a.modes.includes(this.mode)) return false;
    if (!this.host.syncFresh()) this.host.reloadNow();
    return this.run(a, key);
  }

  /** 给面板与菜单用的那一面 */
  private readonly runner: MenuRunner = this.makeRunner();

  private makeRunner(): MenuRunner {
    const ctl = this;
    return {
      get mode(): VisualMode {
        return ctl.mode;
      },
      run: (a, key) => ctl.runChecked(a, key),
      refocus: () => ctl.host.scorePane.focus({ preventScroll: true }),
    };
  }

  /** 右键：先按点击的规则选中（音符 / 记号 / 换行符 / 空白处落插入光标），再按选中的是什么弹菜单。 */
  private onContextMenu(ev: MouseEvent): void {
    if (!this.host.visualEnabled()) return;
    ev.preventDefault();
    this.host.scorePane.focus({ preventScroll: true });
    if (!this.host.syncFresh()) this.host.reloadNow();
    const entry = this.host.entryAtTarget(hitThroughOverlay(ev));
    const sel = this.host.view.state.selection.main;
    let target: MenuTarget = "other";
    const onBreak = ev.target instanceof Element && ev.target.closest(".vis-break");
    if (onBreak) {
      this.handleClick(ev, null);
      target = "break";
    } else if (entry && isText(entry)) {
      this.handleClick(ev, entry);
    } else if (entry) {
      // 点在已选中的范围里就不动选区（右键一段选区整体操作）
      const inside = entry.from < sel.to && entry.to > sel.from && !sel.empty;
      if (!inside) {
        const span = this.noteSel(entry);
        this.select(span.from, span.to);
      }
      target = entry.kind === "mark" ? "mark" : entry.kind === "break" ? "break" : "note";
    } else if (this.handleClick(ev, null)) {
      target = this.mode === "insert" ? "caret" : "note";
    }
    showMenu(ev.clientX, ev.clientY, target, this.runner);
  }

  /** 执行一个动作（键盘、菜单、面板共用）。做了返回 true。`key` 是按下的键（唱名动作要知道是几）。 */
  run(a: VisualAction, key = ""): boolean {
    switch (a.id) {
      case "note.digit": return this.digit(Number(key));
      case "oct.up": return this.editNotes((c, f, t) => shiftOctave(c, f, t, 1), true);
      case "oct.down": return this.editNotes((c, f, t) => shiftOctave(c, f, t, -1), true);
      case "acc.sharp": return this.editNotes((c, f, t) => setAccidental(c, f, t, "sharp"), true);
      case "acc.flat": return this.editNotes((c, f, t) => setAccidental(c, f, t, "flat"), true);
      case "acc.natural": return this.editNotes((c, f, t) => setAccidental(c, f, t, "natural"), true);
      case "dur.dot": return this.editNotes(toggleDot);
      case "dur.halve": return this.duration(-1);
      case "dur.double": return this.duration(1);
      case "sus.add": return this.sustain();
      case "slur.toggle": return this.editNotes(toggleSlur);
      case "tie.toggle": return this.editNotes(toggleTie);
      case "deco.fermata": return this.editNotes((c, f, t) => toggleDeco(c, f, t, "fermata"));
      case "deco.accent": return this.editNotes((c, f, t) => toggleDeco(c, f, t, "accent"));
      case "bar.insert": return this.insertAtCursor((c, pos) => insertToken(c, pos, c.dialect.barline));
      case "brk.line": return this.insertBreakAt(false);
      case "brk.page": return this.insertBreakAt(true);
      case "del.forward": return this.remove(1);
      case "del.back": return this.remove(-1);
      case "mode.insert": return this.toInsert();
      case "mode.edit": return this.toEdit();
      case "nav.prev": return this.move(-1, false);
      case "nav.next": return this.move(1, false);
      case "nav.extendPrev": return this.move(-1, true);
      case "nav.extendNext": return this.move(1, true);
      case "nav.home": return this.rowEdge(-1);
      case "nav.end": return this.rowEdge(1);
      case "mark.next": return this.cycleMark(1);
      case "mark.prev": return this.cycleMark(-1);
      case "view.formatMarks": this.toggleFormatMarks(); return true;
      case "edit.undo": return this.afterHistory(undo(this.host.view));
      case "edit.redo": return this.afterHistory(redo(this.host.view));
    }
    return false;
  }

  /** 改代码区选区（谱面高亮、叠加层由 App 的选区监听刷新）。 */
  select(from: number, to: number): void {
    this.host.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  }

  /** 一个条目在原文里的区间。音符按它自己的 token（不含增时线）。 */
  private spanOfEntry(e: SyncEntry): { from: number; to: number } {
    return { from: e.from, to: e.to };
  }

  /** 选中一个条目时的区间：音符只罩音头（不带减时线、附点、括号），其余整个条目。 */
  private noteSel(e: SyncEntry): { from: number; to: number } {
    if (e.kind !== "note") return this.spanOfEntry(e);
    const c = this.editCtx(true);
    return c ? noteSpans(c, e).head : this.spanOfEntry(e);
  }

  /** 一个元素「连同它的增时线」的结尾：插入光标落在音符后面时，要落到它最后一条增时线后面。 */
  private groupEnd(e: SyncEntry): number {
    if (e.kind !== "note") return e.to;
    let end = e.to;
    for (const s of this.navigable()) {
      if (s.from < e.to) continue;
      if (s.kind === "sustain" && s.id === e.id) end = s.to;
      else break;
    }
    return end;
  }

  /** 选区碰到的条目（编辑模式；选中音头时整个音符也算选中）。 */
  private selectedEntries(): SyncEntry[] {
    const sel = this.host.view.state.selection.main;
    return this.navigable().filter((e) => e.from < sel.to && e.to > sel.from);
  }

  private toInsert(): boolean {
    const sel = this.host.view.state.selection.main;
    const last = this.selectedEntries().pop();
    const at = last ? this.groupEnd(last) : sel.to;
    this.select(at, at);
    return true;
  }

  private toEdit(): boolean {
    const head = this.host.view.state.selection.main.head;
    const nav = this.navigable();
    const before = [...nav].reverse().find((e) => e.to <= head);
    const pick = before ?? nav.find((e) => e.from >= head);
    if (!pick) return false;
    const span = this.noteSel(pick);
    this.select(span.from, span.to);
    return true;
  }

  private move(dir: -1 | 1, extend: boolean): boolean {
    const nav = this.navigable();
    if (nav.length === 0) return false;
    const sel = this.host.view.state.selection.main;
    if (sel.empty && !extend) {
      // 插入模式：光标跨过一个元素（连同音符的增时线一起跨）
      if (dir > 0) {
        const next = nav.find((e) => e.from >= sel.head);
        if (!next) return false;
        const at = this.groupEnd(next);
        this.select(at, at);
      } else {
        const prev = [...nav].reverse().find((e) => e.to <= sel.head);
        if (!prev) return false;
        // 跨过的是增时线时一直退到它的音符前面
        let from = prev.from;
        if (prev.kind === "sustain") from = this.host.sync.spanOfNote(prev.id)?.from ?? from;
        this.select(from, from);
      }
      return true;
    }
    const cur = this.selectedEntries();
    if (extend) {
      // 以选区的另一端为锚，往 dir 那边多罩一个
      if (dir > 0) {
        const next = nav.find((e) => e.from >= sel.to);
        if (!next) return false;
        this.select(sel.from, next.to);
      } else {
        const prev = [...nav].reverse().find((e) => e.to <= sel.from);
        if (!prev) return false;
        this.select(sel.to, prev.from);
      }
      return true;
    }
    let target: SyncEntry | undefined;
    if (dir > 0) {
      const edge = cur.length ? cur[cur.length - 1]!.to : sel.to;
      target = nav.find((e) => e.from >= edge);
    } else {
      const edge = cur.length ? cur[0]!.from : sel.from;
      target = [...nav].reverse().find((e) => e.to <= edge);
    }
    if (!target) return false;
    const span = this.noteSel(target);
    this.select(span.from, span.to);
    return true;
  }

  /** Home / End：沿同一行谱走到头（按谱面上的行认，与原文怎么分行无关）。 */
  private rowEdge(dir: -1 | 1): boolean {
    const nav = this.navigable().filter((e) => e.kind !== "break");
    const sel = this.host.view.state.selection.main;
    let i = nav.findIndex((e) => e.to > sel.from);
    if (i < 0) i = nav.length - 1;
    if (i < 0) return false;
    const cur = this.boxOf(nav[i]!);
    if (!cur) return false;
    let j = i;
    for (;;) {
      const k = j + dir;
      const nb = nav[k] && this.boxOf(nav[k]!);
      if (!nb || nb.svg !== cur.svg || !sameRow(nb.box, cur.box)) break;
      j = k;
    }
    const e = nav[j]!;
    if (sel.empty) {
      const at = dir < 0 ? e.from : this.groupEnd(e);
      this.select(at, at);
    } else {
      const span = this.noteSel(e);
      this.select(span.from, span.to);
    }
    return true;
  }

  /** 撤销/重做之后马上重排（谱面与索引跟上）。 */
  private afterHistory(done: boolean): boolean {
    if (done) this.host.reloadNow();
    return done;
  }

  // ---------------- 改谱 ----------------

  /** 能改谱时给出动作上下文；不能改（格式没有 dialect、没有模型）时在状态栏说明并返回 null。 */
  private editCtx(quiet = false): EditCtx | null {
    const dialect = this.host.editDialect();
    if (!dialect || !this.host.syncDoc()) {
      if (!quiet) this.host.setStatus("这种格式暂不支持在谱面上改谱，请在源码区修改");
      return null;
    }
    return { state: this.host.view.state, sync: this.host.sync, dialect, doc: this.host.syncDoc() };
  }

  /** 把一次动作的结果落进代码区（进撤销记录），马上重排。出错就在状态栏说明。 */
  private apply(out: EditOutcome, sound = false): boolean {
    if (isError(out)) {
      this.host.setStatus(out.error);
      return true; // 键已经被认下了，只是这回做不了
    }
    const { state } = this.host.view;
    let changes: ChangeSpec = out.changes;
    let anchor = out.anchor;
    let head = out.head;
    const post = this.host.editDialect()?.postEdit;
    if (post) {
      // 连带修正（`.jpwabc` 的歌词锚点）与这次改动并成一步，撤销时一起撤
      const cs = state.changes(out.changes);
      const newText = cs.apply(state.doc).toString();
      const fixed = post(state.doc.toString(), newText, (p) => cs.mapPos(p, 1));
      if (fixed !== newText) {
        const cs2 = ChangeSet.of([diffRegion(newText, fixed)], newText.length);
        changes = cs.compose(cs2);
        anchor = cs2.mapPos(anchor, -1);
        head = cs2.mapPos(head, 1);
      }
    }
    this.host.view.dispatch({
      changes,
      selection: { anchor, head },
      userEvent: "input.visual",
      scrollIntoView: true,
    });
    this.host.reloadNow();
    if (sound) this.sound();
    return true;
  }

  /** 换行不是符号的格式（文本谱）：整份重切行，补丁只取前后不同的那一段。 */
  private relayoutBreak(c: EditCtx, afterId: ElementId, add: boolean, page: boolean): boolean {
    const fn = c.dialect.relayoutBreaks;
    const doc = this.host.syncDoc();
    if (!fn || !doc) return true;
    const text = fn(c.state, doc, afterId, add, page);
    if (text === null) {
      this.host.setStatus(add ? "这里没法换行" : "这处换行删不掉");
      return true;
    }
    const old = c.state.doc.toString();
    if (text === old) return true;
    const change = diffRegion(old, text);
    const cs = c.state.changes([change]);
    const at = cs.mapPos(c.state.selection.main.head, 1);
    return this.apply({ changes: [change], anchor: at, head: at });
  }

  private editNotes(fn: (c: EditCtx, from: number, to: number) => EditOutcome, sound = false): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const sel = c.state.selection.main;
    return this.apply(fn(c, sel.from, sel.to), sound);
  }

  /** 插入模式：光标处；编辑模式：选中那段（连同最后一个音符的增时线）之后。 */
  private insertPos(c: EditCtx): number {
    const sel = c.state.selection.main;
    if (sel.empty) return sel.head;
    const last = this.selectedEntries().pop();
    return last ? groupEnd(c, last) : sel.to;
  }

  /** 换行 / 换页：换行是符号的格式插符号（`breaks.ts`），不是符号的（文本谱）重切行。 */
  private insertBreakAt(page: boolean): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const pos = this.insertPos(c);
    if (c.dialect.relayoutBreaks) {
      const prev = [...this.navigable()].reverse().find((e) => e.to <= pos && (e.kind === "note" || e.kind === "sustain"));
      if (!prev) {
        this.host.setStatus("行首不用再换行");
        return true;
      }
      return this.relayoutBreak(c, prev.id, true, page);
    }
    return this.apply(insertBreak(c, pos, page));
  }

  private insertAtCursor(fn: (c: EditCtx, pos: number) => EditOutcome): boolean {
    const c = this.editCtx();
    if (!c) return true;
    return this.apply(fn(c, this.insertPos(c)));
  }

  private digit(d: number): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const sel = c.state.selection.main;
    if (!sel.empty) return this.apply(setDegree(c, sel.from, sel.to, d), true);
    return this.apply(insertNote(c, sel.head, d, this.curDur), true);
  }

  /** `_` / `=`：编辑模式改选中音符，插入模式改「当前时值」。 */
  private duration(dir: -1 | 1): boolean {
    const sel = this.host.view.state.selection.main;
    if (sel.empty) {
      const h = this.curDur.halvings - dir;
      if (h < 0 || h > 4) {
        this.host.setStatus(h < 0 ? "当前时值最长到四分音符（更长的用增时线 -）" : "减时线最多四条");
        return true;
      }
      this.curDur = { ...this.curDur, halvings: h };
      this.refresh();
      return true;
    }
    return this.editNotes(dir < 0 ? halve : double);
  }

  /** `-`：编辑模式给选中的（最后一个）音符加增时线；插入模式在光标处插一条。 */
  private sustain(): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const sel = c.state.selection.main;
    if (!sel.empty) {
      const note = notesIn(c, sel.from, sel.to).pop();
      if (!note) {
        this.host.setStatus("先选中一个音符");
        return true;
      }
      return this.apply(addSustain(c, note));
    }
    if (c.dialect.sustain === "inline") {
      // 增时线写在音符 token 里的格式：加到光标前那个音符上
      const prev = [...this.navigable()].reverse().find((e) => e.to <= sel.head && e.kind === "note");
      if (!prev) return true;
      const out = addSustain(c, prev);
      if (!isError(out)) out.anchor = out.head; // 仍是插入模式，光标落在音符后
      return this.apply(out);
    }
    return this.apply(insertToken(c, sel.head, "-"));
  }

  /** Delete / Backspace。编辑模式删选中的；插入模式删光标后面 / 前面那个元素。 */
  private remove(dir: -1 | 1): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const sel = c.state.selection.main;
    // 点中的文本谱换行（原文里没有符号）：与下一行合并
    if (this.pickedBreak && sel.empty && sel.head === this.pickedBreak.sel) {
      const after = this.pickedBreak.after;
      this.pickedBreak = null;
      return this.relayoutBreak(c, after, false, false);
    }
    // 选中的是代码行末的换行符（ABC 的换行）
    if (!sel.empty && c.dialect.lyricBlockByCodeLine && c.state.doc.sliceString(sel.from, sel.to) === "\n") {
      return this.apply(deleteBreak(c, { kind: "break", from: sel.from, to: sel.to, id: -1, verse: null }));
    }
    // 选中的是附点：只去掉附点
    if (this.pickedDot()) return this.apply(toggleDot(c, sel.from, sel.to));
    let targets: SyncEntry[];
    if (sel.empty) {
      const nav = this.navigable();
      const t = dir > 0 ? nav.find((e) => e.from >= sel.head) : [...nav].reverse().find((e) => e.to <= sel.head);
      if (!t) return true;
      // 退格退到增时线：只删这一条增时线（不连带音符）
      targets = [t];
    } else {
      const exact = this.host.sync.ordered().find((e) => e.from === sel.from && e.to === sel.to);
      targets = exact && (exact.kind === "mark" || exact.kind === "break") ? [exact] : this.selectedEntries();
    }
    if (targets.length === 0) {
      this.host.setStatus("没有选中可删的东西");
      return true;
    }
    const brk = targets.find((e) => e.kind === "break");
    if (brk) {
      if (targets.length > 1) {
        this.host.setStatus("换行符请单独选中再删");
        return true;
      }
      return this.apply(deleteBreak(c, brk));
    }
    return this.apply(deleteEntries(c, targets));
  }

  /** Tab：在选中音符挂的记号之间轮换（选中的已经是记号时从它往下接着轮）。 */
  private cycleMark(dir: -1 | 1): boolean {
    const sel = this.host.view.state.selection.main;
    const sync = this.host.sync;
    const at = sync.at(sel.from);
    if (!at) return false;
    const owner = at.kind === "mark" ? at.id : at.kind === "note" || at.kind === "sustain" ? at.id : null;
    if (owner === null) return false;
    const marks = sync.marksOf(owner);
    if (marks.length === 0) {
      this.host.setStatus("这个音符上没有挂记号");
      return true;
    }
    const cur = marks.findIndex((m) => m.from === at.from || m.pair?.from === at.from);
    const next = cur < 0
      ? (dir > 0 ? 0 : marks.length - 1)
      : (cur + dir + marks.length) % marks.length;
    const m = marks[next]!;
    // 第一次 Tab 之后再轮回到音符本身：多一格「音符」，轮完一圈回来
    if (cur >= 0 && ((dir > 0 && cur === marks.length - 1) || (dir < 0 && cur === 0))) {
      const note = sync.ordered().find((e) => e.kind === "note" && e.id === owner);
      if (note) {
        const span = this.noteSel(note);
        this.select(span.from, span.to);
        return true;
      }
    }
    this.select(m.from, m.to);
    this.host.setStatus(`选中记号：${markLabel(m)}`);
    return true;
  }
}

/** 文字条目：歌词、页眉字段（点了进插入模式，光标落在字里） */
function isText(e: SyncEntry): boolean {
  return e.kind === "lyric" || e.kind === "header";
}

/** 画出来的字 `disp` 与原文的值 `src` 怎么对位：原文下标 = 显示下标 + 返回值；对不上为 null。
 *  署名会补「作词：」（显示包含原文），`.jpwabc` 的 `{三四}` 画出来不带括号（原文包含显示）。 */
function textShift(disp: string, src: string): number | null {
  const k = disp.indexOf(src);
  if (k >= 0) return -k;
  const k2 = src.indexOf(disp);
  return k2 >= 0 && disp.length > 0 ? k2 : null;
}

/** 两份原文前后相同的部分去掉，剩下中间不同的那一段（局部补丁，撤销与光标映射都干净）。 */
function diffRegion(a: string, b: string): { from: number; to: number; insert: string } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { from: p, to: a.length - q, insert: b.slice(p, b.length - q) };
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** 插入模式的当前时值怎么叫（模式标签上显示）。 */
function durName(d: NoteDuration): string {
  return ["四分", "八分", "十六分", "三十二分", "六十四分"][d.halvings] ?? `${d.halvings} 条减时线`;
}

/** 记号条目的中文说法（状态栏、菜单用）。 */
export function markLabel(e: SyncEntry): string {
  switch (e.markKind) {
    case "harmony": return `和弦 ${e.name ?? ""}`;
    case "annotation": return `注记 ${e.name ?? ""}`;
    case "dynamic": return `力度 ${e.name ?? ""}`;
    case "slur": return "圆滑线/延音线";
    default: return `记号 ${e.name ?? ""}`;
  }
}
