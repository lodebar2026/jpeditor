// 可视化编辑控制器：谱面上的选中、光标、键盘与点击。
//
// **源码仍是真身**：选中、移动都只是改代码区的选区；改谱的动作落成对原文的局部补丁
// （`view.dispatch({ changes })`），撤销重做直接用代码区那份 history。
// 光标状态只有一份——代码区选区（非空 = 编辑模式，空 = 插入模式），谱面光标由它推出（`overlay.ts`）。
//
// 与 omr / playback 两个控制器同一个做法：通过一个**列全了的**宿主接口 `VisualHost` 向 App 要能力。

import { redo, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { ElementId } from "../../model/doc";
import type { BreakMark, SyncEntry, SyncIndex } from "../sync";
import { setBreakSpans, setScoreFocus } from "./cursor";
import { actionOfKey, type VisualAction, type VisualMode } from "./keys";
import { type Box, clearOverlay, drawBlock, drawBreak, drawCaret, musicBox, rightEdgeInBand, sameRow } from "./overlay";

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
  setStatus(text: string): void;
  saveSettings(): void;
}

/** 方向键能停的条目：音符、增时线、小节线、原文里有符号的换行 */
const NAVIGABLE = new Set<SyncEntry["kind"]>(["note", "sustain", "barline", "break"]);

export class VisualEditController {
  /** 谱面上显示换行/换页符号。持久化。 */
  showFormatMarks = true;
  private modeEl: HTMLElement | null = null;
  private marksBtn: HTMLButtonElement | null = null;
  /** 叠加层里画出来的换行符号 → 它那一处换行 */
  private breakEls = new Map<Element, BreakMark>();

  constructor(private host: VisualHost) {}

  // ---------------- 装配 ----------------

  /** 谱面可聚焦、接键盘；工具条上的模式标签与格式标记开关。 */
  attach(modeEl: HTMLElement | null, marksBtn: HTMLButtonElement | null): void {
    const pane = this.host.scorePane;
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
    this.syncButtons();
  }

  loadSettings(v: unknown): void {
    if (typeof v === "boolean") this.showFormatMarks = v;
    this.syncButtons();
  }

  private setFocus(on: boolean): void {
    this.host.view.dispatch({ effects: setScoreFocus.of(on && this.host.visualEnabled()) });
    this.refresh();
  }

  private syncButtons(): void {
    if (this.marksBtn) {
      this.marksBtn.classList.toggle("active", this.showFormatMarks);
      this.marksBtn.setAttribute("aria-pressed", String(this.showFormatMarks));
    }
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

  /** 重排之后（索引重建了）：把换行符号的原文位置交给代码区，再重画谱面叠加层。 */
  afterRebuild(): void {
    const spans = this.host.sync.breaks().flatMap((b) => (b.span ? [b.span] : []));
    this.host.view.dispatch({ effects: setBreakSpans.of(this.showFormatMarks ? spans : []) });
    this.refresh();
  }

  /** 重画谱面叠加层与模式标签。选区一动、重排之后、焦点进出都要调。 */
  refresh(): void {
    const pages = this.pages;
    clearOverlay(pages);
    this.breakEls.clear();
    const on = this.host.visualEnabled();
    if (this.modeEl) {
      this.modeEl.hidden = !on;
      this.modeEl.textContent = this.mode === "edit" ? "编辑" : "插入";
      this.modeEl.dataset.mode = this.mode;
    }
    if (!on) return;
    const sel = this.host.view.state.selection.main;
    if (this.showFormatMarks) this.drawBreaks(sel.from, sel.to);
    if (sel.empty) this.drawInsertCaret(sel.head);
    else if (document.activeElement === this.host.scorePane) this.drawEditBlock(sel.from, sel.to);
  }

  private boxOf(entry: SyncEntry): { svg: SVGSVGElement; box: Box } | null {
    const el = this.host.entryEl(entry);
    return el ? musicBox(el) : null;
  }

  private drawBreaks(selFrom: number, selTo: number): void {
    const cache = new Map<SVGSVGElement, Box[]>();
    for (const b of this.host.sync.breaks()) {
      const el = this.host.noteEl(b.after);
      const hit = el && musicBox(el);
      if (!hit) continue;
      const selected = !!b.span && b.span.from >= selFrom && b.span.to <= selTo && selTo > selFrom;
      const x = rightEdgeInBand(hit.svg, hit.box, cache);
      this.breakEls.set(drawBreak(hit.svg, x, hit.box, b.page, selected), b);
    }
  }

  /** 插入光标：画在光标前那个元素的右缘；光标在行首（前后两个元素不同行）时画在后一个的左缘。 */
  private drawInsertCaret(head: number): void {
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

  /** 编辑方块：选区罩住的元素，按页、按行各画一个。 */
  private drawEditBlock(from: number, to: number): void {
    const boxes: { svg: SVGSVGElement; box: Box }[] = [];
    const seen = new Set<Element>();
    for (const e of this.host.sync.range(from, to)) {
      if (e.kind === "lyric" || e.kind === "break") continue;
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
      if (brk.span) this.select(brk.span.from, brk.span.to);
      else this.host.setStatus("这处换行在原文里没有符号（文本谱另起一行 Q:），删除要合并两行");
      return true;
    }
    if (entry) {
      // Shift+点击：从原来的选区扩到这个元素
      if (ev.shiftKey) {
        const sel = this.host.view.state.selection.main;
        const span = this.spanOfEntry(entry);
        this.select(Math.min(sel.from, span.from), Math.max(sel.to, span.to));
        return true;
      }
      return false; // 普通点音符：App 的双向定位照旧（选中该音符 = 编辑模式）
    }
    // 点在空白处：找同一行里离得最近的元素，光标落到它前面或后面（插入模式）
    const caret = this.caretAtPoint(ev.clientX, ev.clientY);
    if (caret !== null) {
      this.select(caret, caret);
      return true;
    }
    return false;
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
    if (a.modes && !a.modes.includes(this.mode)) return;
    if (this.run(a)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  /** 执行一个动作（键盘、菜单、面板共用）。做了返回 true。 */
  run(a: VisualAction): boolean {
    switch (a.id) {
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
      case "edit.undo": return undo(this.host.view);
      case "edit.redo": return redo(this.host.view);
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

  /** 选区罩住的条目（编辑模式）。 */
  private selectedEntries(): SyncEntry[] {
    const sel = this.host.view.state.selection.main;
    return this.navigable().filter((e) => e.from >= sel.from && e.to <= sel.to);
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
    this.select(pick.from, pick.to);
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
    this.select(target.from, target.to);
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
    } else this.select(e.from, e.to);
    return true;
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
      const note = sync.spanOfNote(owner);
      if (note) {
        this.select(note.from, note.to);
        return true;
      }
    }
    this.select(m.from, m.to);
    this.host.setStatus(`选中记号：${markLabel(m)}`);
    return true;
  }
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
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
