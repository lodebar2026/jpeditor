// 代码区标题栏的**格式下拉**：代码区里这份文本换成别的源格式。
//
// 两种东西用它，下拉本身（控件、显隐、手改确认）共用这一份，切换怎么做各自实现 `FormatSource`：
//   - 识别结果（`OmrController`）：真身是 `RecognizedScore`，切格式 = 从识别结果重出文本、不重跑识别；
//   - 打开的文件（下面的 `FileFormatSource`）：真身是**原文**。切到别的格式 = 从原文的模型写出；
//     切回原格式 = 逐字还原原文与文件路径。在原格式里改过再切走，转换基于改过的文本。
// 两者出文本走同一张转换目标表（`model/convert.ts`）。
//
// 下拉顶掉格式标签（`index.html` 的 `#doc-format-field`）：切的本来就是代码区里这份文本是什么格式。

import type { ScoreDoc } from "../model/doc";
import { CONVERT_TARGETS, targetSpec, type ConvertTarget } from "../model/convert";
import { describeLosses, planSave } from "../model/capability";
import type { DocFormatId } from "./formats";
import { showConfirmDialog } from "./dialogs";

/** 下拉里的一项。 */
export interface FormatOption {
  value: string;
  label: string;
}

/** 一种「代码区文本从哪儿来、能换成哪些格式」。 */
export interface FormatSource {
  options(): readonly FormatOption[];
  /** 当前选中的那一项 */
  current(): string;
  /** 切到 `value`。返回 false 表示没切（用户取消、转换失败），下拉拨回原值 */
  switchTo(value: string): Promise<boolean>;
}

/** 代码区文本被手工改过时，切格式会用真身重出文本、丢掉这些改动：先问一声。 */
export function confirmDiscardEdits(): Promise<boolean> {
  return showConfirmDialog(
    "切换格式",
    "源码已手工修改过。切换格式会重新生成文本，这些修改将丢失。要继续吗？",
  );
}

export interface FormatSwitchHost {
  /** 上下文相关控件的显隐 */
  setContextControl(el: Element | null, on: boolean): void;
  /** 下拉显隐变了：格式标签跟着让位 */
  syncFormatLabel(): void;
}

export class FormatSwitch {
  private selectEl: HTMLSelectElement | null = null;
  private fieldEl: HTMLElement | null = null;
  private src: FormatSource | null = null;

  constructor(private host: FormatSwitchHost) {}

  get source(): FormatSource | null {
    return this.src;
  }

  bind(el: HTMLSelectElement): void {
    this.selectEl = el;
    this.fieldEl = el.closest<HTMLElement>(".pane-select-field, .toolbar-select-field") ?? el;
    el.addEventListener("change", () => void this.choose(el.value));
    this.render();
  }

  /** 换来源（`null` = 没有可切的，收起下拉、露出格式标签）。 */
  use(source: FormatSource | null): void {
    this.src = source;
    this.render();
  }

  /** 来源的当前格式变了（不经下拉切的）：同步下拉的值。 */
  sync(): void {
    if (this.selectEl && this.src) this.selectEl.value = this.src.current();
  }

  private async choose(value: string): Promise<void> {
    const src = this.src;
    if (!src || value === src.current()) return;
    await src.switchTo(value);
    this.sync(); // 没切成就拨回原值
  }

  private render(): void {
    const el = this.selectEl;
    if (el) {
      el.replaceChildren();
      for (const { value, label } of this.src?.options() ?? []) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        el.appendChild(opt);
      }
      this.sync();
    }
    this.host.setContextControl(this.fieldEl, this.src !== null);
    this.host.syncFormatLabel();
  }
}

// ───────────────────────── 打开的文件 ─────────────────────────

/** 打开的文件那一侧向 App 要的能力。 */
export interface FileSwitchHost {
  getText(): string;
  readonly filePath: string | null;
  /** 按当前格式解析当前文本（App 那边有缓存）；读不出返回 null */
  scoreDoc(): ScoreDoc | null;
  /** 换成某种源格式的文本：切格式、设文件路径、设文本 */
  adoptText(format: DocFormatId, text: string, filePath: string | null): void;
  setStatus(text: string): void;
}

/** 原文是什么格式：可写出的文本格式（`123` / `tomato` …），或只能读的 `musicxml`。 */
export type OriginFormat = ConvertTarget | "musicxml";

/** 下拉里原文那一项的显示名。 */
function originLabel(origin: OriginFormat): string {
  return (origin === "musicxml" ? "MusicXML" : targetSpec(origin).label) + "（原文）";
}

/**
 * 打开的文件：原文是真身。
 *
 * - 切到别的格式：从原文的模型写出，先列出装不下的东西（`planSave`）；文件路径清空（存盘走另存为，原文件不动）。
 * - 切回原格式：逐字还原原文与文件路径。
 * - 在原格式里改过再切走：以改过的文本为准（它就是新的原文）；在转出来的格式里改过再切：问一声再丢。
 */
export class FileFormatSource implements FormatSource {
  private cur: OriginFormat;
  /** 上次写进代码区的文本；与当前文本不同即说明手改过 */
  private emitted: string;
  /** 原文的模型（在原格式里改过就重建） */
  private doc: ScoreDoc | null = null;
  private filePath: string | null;

  constructor(
    private host: FileSwitchHost,
    private readonly origin: { format: OriginFormat; docFormat: DocFormatId; text: string },
  ) {
    this.cur = origin.format;
    this.emitted = origin.text;
    this.filePath = host.filePath;
  }

  options(): readonly FormatOption[] {
    const out: FormatOption[] = [];
    if (this.origin.format === "musicxml") out.push({ value: "musicxml", label: originLabel("musicxml") });
    for (const t of CONVERT_TARGETS) {
      out.push({ value: t.id, label: t.id === this.origin.format ? originLabel(t.id) : t.label });
    }
    return out;
  }

  current(): string {
    return this.cur;
  }

  async switchTo(value: string): Promise<boolean> {
    if (value === this.cur) return true;
    const text = this.host.getText();
    const onOrigin = this.cur === this.origin.format;
    if (onOrigin) {
      // 在原格式里：当前文本就是原文（改过的也是）。模型按它重建，文件路径以此刻为准（打开后才设上）
      if (text !== this.emitted || !this.doc) {
        const doc = this.host.scoreDoc();
        if (!doc) {
          this.host.setStatus("这份谱现在读不出来，无法转换格式");
          return false;
        }
        this.doc = doc;
        this.origin.text = text;
        this.emitted = text;
      }
      this.filePath = this.host.filePath;
    } else if (text !== this.emitted && !(await confirmDiscardEdits())) {
      return false;
    }

    if (value === this.origin.format) {
      this.host.adoptText(this.origin.docFormat, this.origin.text, this.filePath);
      this.cur = this.origin.format;
      this.emitted = this.origin.text;
      this.host.setStatus(`已切回原文（${originLabel(this.origin.format).replace("（原文）", "")}）`);
      return true;
    }
    const spec = CONVERT_TARGETS.find((t) => t.id === value);
    if (!spec || !this.doc) return false;
    const losses = planSave(this.doc, spec.id);
    if (losses.length && !(await showConfirmDialog("转换会丢东西", describeLosses(spec.id, losses)))) return false;
    let out: string;
    try {
      out = spec.emit(this.doc);
    } catch (e) {
      console.error("转换失败", e);
      this.host.setStatus("转换失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
    this.host.adoptText(spec.docFormat, out, null);
    this.cur = spec.id;
    this.emitted = out;
    this.host.setStatus(`已转成 ${spec.label}（未保存，原文件未改动；切回「原文」可还原）`);
    return true;
  }
}
