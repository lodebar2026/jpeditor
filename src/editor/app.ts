// App controller: CodeMirror editor <-> live relayout/render <-> paging <-> file I/O.
// Mirrors EditorController in CodeEditor.kt (doBind/tryLoad/updateLayout/paint/load/doSave).

import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { jpwHighlighter } from "./highlight";
import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { fromJpw } from "../score/jpwimport";
import { JinpuPainter } from "../layout/painter";
import { JpNumber, Lyric as LayoutLyric, TextFrame, type PageItem } from "../layout/layout";
import { Point } from "../common/geom";
import { MetaData } from "../smufl/smufl";
import { loadMusicXml } from "../score/musicxml";
import { scoreToJpwabc } from "../score/jpscore";
import { decodeJpwabc, encodeJpwabc, isTauriRuntime } from "./fileio";
import { MixedPainter } from "../mixed/painter";

export class App {
  painter: JinpuPainter;
  view!: EditorView;
  scorePane: HTMLElement;
  pageEls: HTMLElement[] = [];
  pageIndex = 0;
  filePath: string | null = null;
  mode: "jp" | "mixed" = "jp";
  mixedXmlText: string | null = null;
  private _mixedPainter: MixedPainter | null = null;
  private _mixedBtnEl: HTMLButtonElement | null = null;
  private _readOnlyCompartment = new Compartment();
  // render settings (app-level, not part of the .jpwabc document)
  pageW = 960;
  pageH = 540;
  fontSize = 28;
  titleSize = 48;
  creditSize = 36;
  color = 0xff000000; // ARGB
  zoom = 1; // 谱面显示缩放（应用到 #score-pane 的 --score-zoom）
  private meta: MetaData;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private zoomSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private selectedEl: SVGGElement | null = null;
  statusEl: HTMLElement | null = null;

  private static readonly SETTINGS_KEY = "jpeditor-render-settings";
  private static readonly LAST_FILE_KEY = "jpeditor-last-file";

  constructor(meta: MetaData, scorePane: HTMLElement) {
    this.meta = meta;
    this.painter = new JinpuPainter(this.fontSize);
    this.painter.layout.options.smuflMeta = meta;
    this.scorePane = scorePane;
  }

  /** Apply page-size / font-size / title-size / credit-size / color render settings and re-render. */
  applyRenderSettings(opts: { pageW?: number; pageH?: number; fontSize?: number; titleSize?: number; creditSize?: number; color?: number }): void {
    if (opts.pageW) this.pageW = opts.pageW;
    if (opts.pageH) this.pageH = opts.pageH;
    if (opts.color !== undefined) this.color = opts.color;
    if (opts.titleSize !== undefined) this.titleSize = opts.titleSize;
    if (opts.creditSize !== undefined) this.creditSize = opts.creditSize;
    if (opts.fontSize && opts.fontSize !== this.fontSize) {
      this.fontSize = opts.fontSize;
      const score = this.painter.score;
      this.painter = new JinpuPainter(this.fontSize);
      this.painter.layout.options.smuflMeta = this.meta;
      this.painter.score = score;
    }
    this.painter.layout.options.color = this.color;
    this.painter.layout.options.titleSize = this.titleSize;
    this.painter.layout.options.creditSize = this.creditSize;
    this.saveSettings();
    this.reload(this.getText());
  }

  /** Restore persisted render settings; call before mountEditor() so first render uses them. */
  loadSettings(): void {
    try {
      const raw = localStorage.getItem(App.SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<{
        pageW: number; pageH: number; fontSize: number;
        titleSize: number; creditSize: number; color: number; zoom: number;
      }>;
      if (s.pageW) this.pageW = s.pageW;
      if (s.pageH) this.pageH = s.pageH;
      if (s.titleSize !== undefined) this.titleSize = s.titleSize;
      if (s.creditSize !== undefined) this.creditSize = s.creditSize;
      if (s.color !== undefined) this.color = s.color;
      if (s.zoom) this.zoom = s.zoom;
      this._applyZoom();
      if (s.fontSize && s.fontSize !== this.fontSize) {
        this.fontSize = s.fontSize;
        const score = this.painter.score;
        this.painter = new JinpuPainter(this.fontSize);
        this.painter.layout.options.smuflMeta = this.meta;
        this.painter.score = score;
      }
      this.painter.layout.options.color = this.color;
      this.painter.layout.options.titleSize = this.titleSize;
      this.painter.layout.options.creditSize = this.creditSize;
    } catch {
      // corrupt storage — ignore
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(App.SETTINGS_KEY, JSON.stringify({
        pageW: this.pageW,
        pageH: this.pageH,
        fontSize: this.fontSize,
        titleSize: this.titleSize,
        creditSize: this.creditSize,
        color: this.color,
        zoom: this.zoom,
      }));
    } catch {
      // storage unavailable — ignore
    }
  }

  // ---------------- zoom ----------------
  /** 设置谱面缩放（夹在 [0.25, 4]），持久化。 */
  setZoom(z: number): void {
    this.zoom = Math.min(4, Math.max(0.25, z));
    this._applyZoom();
    // 连续缩放（滚轮/捏合）期间不每帧写盘，停止后再持久化一次。
    clearTimeout(this.zoomSaveTimer);
    this.zoomSaveTimer = setTimeout(() => this.saveSettings(), 400);
  }
  zoomBy(factor: number): void {
    this.setZoom(this.zoom * factor);
  }
  resetZoom(): void {
    this.setZoom(1);
  }
  private _applyZoom(): void {
    this.scorePane.style.setProperty("--score-zoom", String(this.zoom));
  }

  mountEditor(parent: HTMLElement, initialText: string): void {
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) this.scheduleReload();
    });
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          jpwHighlighter,
          updateListener,
          this._readOnlyCompartment.of(EditorState.readOnly.of(false)),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-content": { fontFamily: "ui-monospace, Menlo, Consolas, monospace" },
          }),
        ],
      }),
    });
    this.reload(initialText);
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  setText(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
    // dispatch triggers updateListener -> scheduleReload, but reload now for snappiness
    this.reload(text);
  }

  private scheduleReload(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.reload(this.getText()), 200);
  }

  /** parse -> import -> layout -> render. Returns false on parse failure (text kept). */
  reload(text: string): boolean {
    if (this.mode === "mixed") return true;
    let f: JpwFile | null;
    try {
      f = JpwFile.fromString(text);
    } catch {
      return false;
    }
    if (!f) return false;
    let score;
    try {
      score = fromJpw(f);
    } catch (e) {
      console.error("import failed", e);
      return false;
    }
    if (!score) return false;

    this.painter.score = score;
    const breakDesc = f.getSection(LayoutSection)?.desc ?? null;
    try {
      this.painter.resize(this.pageW, this.pageH, breakDesc);
    } catch (e) {
      console.error("layout failed", e);
      return false;
    }
    this.renderPages();
    return true;
  }

  private renderPages(): void {
    this.scorePane.replaceChildren();
    this.pageEls = [];
    this.selectedEl = null;
    for (let i = 0; i < this.painter.pageCount; i++) {
      const svg = this.painter.renderPage(i);
      const wrap = document.createElement("div");
      wrap.className = "score-page-wrap";
      wrap.appendChild(svg);
      const idx = i;
      svg.addEventListener("click", (e) => this.onPageClick(idx, svg, e));
      this.scorePane.appendChild(wrap);
      this.pageEls.push(wrap);
    }
    this.pageIndex = Math.min(this.pageIndex, Math.max(0, this.pageEls.length - 1));
  }

  // ---------------- picking / selection ----------------
  private onPageClick(pageIndex: number, svg: SVGSVGElement, ev: MouseEvent): void {
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    const picked = this.painter.pickPage(pageIndex, new Point(pt.x, pt.y));
    this.deselect();
    if (!picked) {
      this.setStatus("");
      return;
    }
    const target = picked.selectable ? picked : this.painter.entryGroupOf(picked);
    const el = this.painter.nodeMap.get(target);
    if (el) {
      el.classList.add("selected");
      this.selectedEl = el;
    }
    this.setStatus(describePick(picked));
  }

  private deselect(): void {
    this.selectedEl?.classList.remove("selected");
    this.selectedEl = null;
  }

  private setStatus(s: string): void {
    if (!this.statusEl) this.statusEl = document.getElementById("status");
    if (this.statusEl) this.statusEl.textContent = s;
  }

  // ---------------- paging ----------------
  goToPage(i: number): void {
    const np = Math.max(0, Math.min(i, this.pageEls.length - 1));
    this.pageIndex = np;
    this.pageEls[np]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  nextPage(): void {
    this.goToPage(this.pageIndex + 1);
  }
  prevPage(): void {
    this.goToPage(this.pageIndex - 1);
  }

  // ---------------- file I/O ----------------
  /** Decode bytes by extension: .xml/.musicxml -> import to .jpwabc; else UTF-16 .jpwabc. */
  importBytes(bytes: Uint8Array, name: string): void {
    if (/\.(xml|musicxml)$/i.test(name)) {
      const xml = new TextDecoder(
        bytes[0] === 0xff || bytes[0] === 0xfe ? "utf-16" : "utf-8",
      ).decode(bytes);
      this.mixedXmlText = xml;
      this._mixedPainter = null; // reset so next toggleMixed re-loads
      if (this._mixedBtnEl) this._mixedBtnEl.disabled = false;

      // 多声部（SATB 等）歌谱默认进入混排模式
      const autoMixed = this.mode !== "mixed" && isMultiPartXml(xml);
      if (this.mode === "mixed" || autoMixed) {
        if (autoMixed) {
          this.mode = "mixed";
          this._setMixedLayout(true);
          if (this._mixedBtnEl) this._mixedBtnEl.textContent = "简谱";
        }
        // 仍填充编辑器的简谱转换文本，便于切回「简谱」（best-effort）
        try {
          const score = loadMusicXml(xml);
          this.filePath = null;
          this.setText(scoreToJpwabc(score));
        } catch (e) {
          console.error("jp import (for toggle) failed", e);
        }
        void this._renderMixedPages();
        return;
      }

      const score = loadMusicXml(xml);
      this.filePath = null; // imported; save as new .jpwabc
      this.setText(scoreToJpwabc(score));
    } else {
      this.mixedXmlText = null;
      this._mixedPainter = null;
      if (this._mixedBtnEl) this._mixedBtnEl.disabled = true;
      if (this.mode === "mixed") {
        this.mode = "jp";
        this._setMixedLayout(false);
        if (this._mixedBtnEl) this._mixedBtnEl.textContent = "混排";
      }
      this.setText(decodeJpwabc(bytes));
    }
  }

  /** Register the #btn-mixed element so App can enable/disable it. */
  setMixedBtn(el: HTMLButtonElement): void {
    this._mixedBtnEl = el;
  }

  /** Toggle between JP mode and Mixed (五线谱+简谱) mode. */
  async toggleMixed(): Promise<void> {
    if (!this.mixedXmlText) return;
    if (this.mode === "jp") {
      this.mode = "mixed";
      this._setMixedLayout(true);
      if (this._mixedBtnEl) this._mixedBtnEl.textContent = "简谱";
      await this._renderMixedPages();
    } else {
      this.mode = "jp";
      this._setMixedLayout(false);
      if (this._mixedBtnEl) this._mixedBtnEl.textContent = "混排";
      this.reload(this.getText());
    }
  }

  /** Mixed mode: editor read-only + hide the code pane entirely. */
  private _setMixedLayout(on: boolean): void {
    this.view.dispatch({
      effects: this._readOnlyCompartment.reconfigure(EditorState.readOnly.of(on)),
    });
    document.getElementById("body")?.classList.toggle("mixed", on);
  }

  private async _renderMixedPages(): Promise<void> {
    if (!this._mixedPainter) {
      this._mixedPainter = new MixedPainter();
    }
    if (this.mixedXmlText) {
      await this._mixedPainter.load(this.mixedXmlText);
    }
    // Portrait paper sized from the MusicXML page dimensions.
    const aspect = `${this._mixedPainter.pageWidthTenths} / ${this._mixedPainter.pageHeightTenths}`;
    this.scorePane.replaceChildren();
    this.pageEls = [];
    for (let i = 0; i < this._mixedPainter.pageCount; i++) {
      const svg = this._mixedPainter.renderPage(i);
      svg.style.width = "100%";
      svg.style.display = "block";
      const wrap = document.createElement("div");
      wrap.className = "score-page-wrap";
      wrap.style.aspectRatio = aspect;
      wrap.style.width = "calc(min(620px, 100%) * var(--score-zoom, 1))";
      wrap.appendChild(svg);
      this.scorePane.appendChild(wrap);
      this.pageEls.push(wrap);
    }
    this.pageIndex = 0;
  }

  /** 记住上次打开/保存的文件路径（仅 Tauri：浏览器路径不可复读）。 */
  rememberLastFile(path: string): void {
    try {
      localStorage.setItem(App.LAST_FILE_KEY, path);
    } catch {
      // storage unavailable — ignore
    }
  }

  private clearLastFile(): void {
    try {
      localStorage.removeItem(App.LAST_FILE_KEY);
    } catch {
      // ignore
    }
  }

  /** 启动时尝试复读上次打开的文件（仅 Tauri）。返回 true 表示已加载，false 则保持示例文本。 */
  async tryRestoreLastFile(): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    let path: string | null;
    try {
      path = localStorage.getItem(App.LAST_FILE_KEY);
    } catch {
      return false;
    }
    if (!path) return false;
    try {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const bytes = await readFile(path);
      this.importBytes(bytes, path);
      if (!/\.(xml|musicxml)$/i.test(path)) this.filePath = path;
      return true;
    } catch {
      // 文件已被移动/删除/不可读 — 忘掉它，回退到示例
      this.clearLastFile();
      return false;
    }
  }

  async openFile(): Promise<void> {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const sel = await open({
        multiple: false,
        filters: [{ name: "简谱 / MusicXML", extensions: ["jpwabc", "JPWABC", "xml", "musicxml"] }],
      });
      if (typeof sel !== "string") return;
      const bytes = await readFile(sel);
      this.importBytes(bytes, sel);
      if (!/\.(xml|musicxml)$/i.test(sel)) this.filePath = sel;
      this.rememberLastFile(sel);
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".jpwabc,.xml,.musicxml";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const buf = new Uint8Array(await file.arrayBuffer());
        this.importBytes(buf, file.name);
        if (!/\.(xml|musicxml)$/i.test(file.name)) this.filePath = file.name;
      };
      input.click();
    }
  }

  async saveFile(): Promise<void> {
    if (this.filePath && isTauriRuntime()) {
      await this.writeTo(this.filePath);
      return;
    }
    await this.saveFileAs();
  }

  async saveFileAs(): Promise<void> {
    const name = (this.painter.score.title.split("\n")[0] || "未命名") + ".jpwabc";
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({ defaultPath: name });
      if (!dest) return;
      await this.writeTo(dest);
      this.filePath = dest;
      this.rememberLastFile(dest);
    } else {
      const blob = new Blob([encodeJpwabc(this.getText())], {
        type: "application/octet-stream",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }

  private async writeTo(path: string): Promise<void> {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(path, encodeJpwabc(this.getText()));
  }

  /** Load dropped file content (already decoded). */
  loadText(text: string, path: string | null): void {
    this.filePath = path;
    this.setText(text);
  }

  /** Set LinesPerPage in the document's .Layout section (empty string clears it). */
  setLinesPerPage(value: string): void {
    this.setText(upsertLayoutLines(this.getText(), value));
  }

  /** Current LinesPerPage value from the document, if any. */
  getLinesPerPage(): string {
    const f = JpwFile.fromString(this.getText());
    return f?.getSection(LayoutSection)?.linesPerPage?.trim() ?? "";
  }
}

/** Insert/update/remove `LinesPerPage = N` within a `.Layout` section. */
function upsertLayoutLines(doc: string, value: string): string {
  const lines = doc.split("\n");
  const isSection = (l: string) => l.startsWith(".");
  let layoutAt = lines.findIndex((l) => l.trim().toLowerCase() === ".layout");

  if (layoutAt < 0) {
    if (!value) return doc;
    const block = lines[lines.length - 1] === "" ? "" : "\n";
    return doc + `${block}.Layout\nLinesPerPage = ${value}\n`;
  }
  // find section body bounds
  let end = layoutAt + 1;
  while (end < lines.length && !isSection(lines[end])) end++;
  let lpIdx = -1;
  for (let i = layoutAt + 1; i < end; i++) {
    if (lines[i].toLowerCase().includes("linesperpage")) lpIdx = i;
  }
  if (!value) {
    if (lpIdx >= 0) lines.splice(lpIdx, 1);
    return lines.join("\n");
  }
  if (lpIdx >= 0) lines[lpIdx] = `LinesPerPage = ${value}`;
  else lines.splice(layoutAt + 1, 0, `LinesPerPage = ${value}`);
  return lines.join("\n");
}

function describePick(item: PageItem): string {
  if (item instanceof LayoutLyric) return `歌词: ${item.text}`;
  if (item instanceof JpNumber) return `音符: ${item.text}`;
  if (item instanceof TextFrame) return `文本: ${item.text}`;
  const cls = [...item.classes].filter((c) => c !== "entry");
  return cls.length ? `已选: ${cls.join(",")}` : "已选: 元素";
}

/** 判断 MusicXML 是否多声部（≥2 part、单 part 多谱表、或 ≥2 voice）→ 默认混排。 */
function isMultiPartXml(xml: string): boolean {
  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return false;
    if (doc.getElementsByTagName("score-part").length >= 2) return true;
    for (const s of Array.from(doc.getElementsByTagName("staves"))) {
      if (parseInt(s.textContent ?? "1", 10) >= 2) return true;
    }
    const voices = new Set<string>();
    for (const v of Array.from(doc.getElementsByTagName("voice"))) {
      const t = v.textContent?.trim();
      if (t) voices.add(t);
    }
    return voices.size >= 2;
  } catch {
    return false;
  }
}
