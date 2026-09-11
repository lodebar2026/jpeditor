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
  pageW?: number;
  pageH?: number;
  /** **展开档**的三个字号。 */
  fontSize?: number;
  titleSize?: number;
  creditSize?: number;
  /** **原样档**的基础字号。那一档只调这一个，标题/词曲字号按比例派生，故不单独存。 */
  originalFontSize?: number;
  /** 原样档的纸（`PAPER_SIZES` 的键，「长图」是其中一档）。
   *  展开档只选比例（pageW/pageH），两种格式共用。 */
  jpPaper?: string;
  puPaper?: string;
  /** 文本谱**原样档**音符数字的字号（pt）。0 = 跟随版式量到的原尺寸。展开档与 `.jpwabc` 共用上面那三个字号。 */
  puFontSize?: number;
  /** 两档各自的前景色（谱面笔画/文字）与背景色（纸张），ARGB。 */
  expandedColor?: number;
  expandedBgColor?: number;
  originalColor?: number;
  originalBgColor?: number;
  zoom?: number;
  mixedHideBarNumber?: boolean;
  mixedShowJianpuLayer?: boolean;
  /** 交 PlaybackController 自己校验 */
  playSpeed?: unknown;
  /** 交 OmrController 自己校验 */
  omrFormat?: unknown;
  /** 当前排版输出（展开 / 原样），两种格式各记一个：简谱 normal|pptx、文本谱 print|slide（slide = 展开）。 */
  jpProfile?: "normal" | "pptx";
  puProfile?: "print" | "slide";
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
