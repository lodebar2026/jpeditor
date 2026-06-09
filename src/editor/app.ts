// App controller: CodeMirror editor <-> live relayout/render <-> paging <-> file I/O.
// Mirrors EditorController in CodeEditor.kt (doBind/tryLoad/updateLayout/paint/load/doSave).

import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { jpwHighlighter } from "./highlight";
import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { fromJpw } from "../score/jpwimport";
import { JinpuPainter } from "../layout/painter";
import { MetaData } from "../smufl/smufl";
import { decodeJpwabc, encodeJpwabc, isTauriRuntime } from "./fileio";

const PAGE_W = 960;
const PAGE_H = 540;

export class App {
  painter = new JinpuPainter(28);
  view!: EditorView;
  scorePane: HTMLElement;
  pageEls: SVGSVGElement[] = [];
  pageIndex = 0;
  filePath: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(meta: MetaData, scorePane: HTMLElement) {
    this.painter.layout.options.smuflMeta = meta;
    this.scorePane = scorePane;
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
      this.painter.resize(PAGE_W, PAGE_H, breakDesc);
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
    for (let i = 0; i < this.painter.pageCount; i++) {
      const svg = this.painter.renderPage(i);
      svg.style.width = `${PAGE_W}px`;
      svg.style.maxWidth = "100%";
      this.scorePane.appendChild(svg);
      this.pageEls.push(svg);
    }
    this.pageIndex = Math.min(this.pageIndex, Math.max(0, this.pageEls.length - 1));
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
  async openFile(): Promise<void> {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const sel = await open({
        multiple: false,
        filters: [{ name: "简谱", extensions: ["jpwabc", "JPWABC"] }],
      });
      if (typeof sel !== "string") return;
      const bytes = await readFile(sel);
      this.filePath = sel;
      this.setText(decodeJpwabc(bytes));
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".jpwabc";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const buf = new Uint8Array(await file.arrayBuffer());
        this.filePath = file.name;
        this.setText(decodeJpwabc(buf));
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
}
