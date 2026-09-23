// 编辑器设置的持久化（localStorage）。
//
// **只管存取，不管应用**：哪个字段落到 App/控制器的哪个属性，仍在各自那边——那不是重复，
// 是它们各自的语义。这里要的是「JSON + localStorage + try/catch」只写一次，
// 以及**持久化的形状写在一处**（加一项设置就改这个类型，不必翻两个方法）。
//
// 存取一律吞异常：隐私模式 / 存储满 / 存量数据损坏都不该让编辑器起不来。

const KEY = "jpeditor-render-settings";

/** 存下来的东西。全部可选——旧版本存的数据缺字段是正常的。
 *  取值一律当 unknown 校验（存量数据可能是任何东西）。 */
export interface PersistedSettings {
  /** 样式用户层（`App._userLayers`：每个主题一组 `StyleRule`）。交 `sanitizeLayer` 校验。 */
  styleLayers?: unknown;
  zoom?: number;
  mixedHideBarNumber?: boolean;
  mixedShowJianpuLayer?: boolean;
  /** 打开单声部 MusicXML 时：`ask` / `musicxml` / 转换目标（`model/convert.ts`）。App 自己校验 */
  musicXmlImport?: unknown;
  /** 诗集样式表的手动指定：目录 → 路径（空串 = 不用）。App 自己校验 */
  bookSheets?: unknown;
  /** 浏览器版手动选的诗集样式表原文 `{ name, text }` */
  browserBookSheet?: unknown;
  /** 交 PlaybackController 自己校验 */
  playSpeed?: unknown;
  /** 交 OmrController 自己校验 */
  omrFormat?: unknown;
  /** 当前排版输出（展开 / 原样），两种格式各记一个：简谱 normal|pptx、文本谱 print|slide（slide = 展开）。 */
  jpProfile?: "normal" | "pptx";
  puProfile?: "print" | "slide";
  /** 谱面上显示换行/换页符号（可视化编辑，交 VisualEditController 自己校验） */
  showFormatMarks?: unknown;
  /** 小节时值自检开关（同上） */
  beatCheck?: unknown;
  /** 可视化编辑改音时发声（同上） */
  noteSound?: unknown;
  /** 可视化编辑的记号面板显示与否（同上） */
  showPalette?: unknown;
}

export function loadPersistedSettings(): PersistedSettings | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as PersistedSettings) : null;
  } catch {
    return null; // 存量数据损坏 / 存储不可用
  }
}

export function savePersistedSettings(s: PersistedSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 存储不可用（隐私模式 / 配额满）——设置丢了不影响使用
  }
}

const LAST_FILE_KEY = "jpeditor-last-file";

export function loadLastFile(): string | null {
  try {
    return localStorage.getItem(LAST_FILE_KEY);
  } catch {
    return null;
  }
}

export function saveLastFile(path: string): void {
  try {
    localStorage.setItem(LAST_FILE_KEY, path);
  } catch {
    // 同上
  }
}

export function clearLastFile(): void {
  try {
    localStorage.removeItem(LAST_FILE_KEY);
  } catch {
    // 同上
  }
}
