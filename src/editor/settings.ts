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
  /** **PPT 档**的三个字号。字段名不改是为了存量数据：默认档一直是 PPT，
   *  旧版存下来的这三个值本来就是那一档的，原地继承即可，不必迁移。 */
  fontSize?: number;
  titleSize?: number;
  creditSize?: number;
  /** **简谱档**的基础字号。那一档只调这一个，标题/词曲字号按比例派生，故不单独存。 */
  jpFontSize?: number;
  /** 简谱档 / 文本谱「原版」档的纸（`PAPER_SIZES` 的键，「长图」是其中一档）。
   *  PPT 档那张投影片仍是 pageW/pageH。 */
  jpPaper?: string;
  puPaper?: string;
  puPptPaper?: string;
  /** 文本谱音符数字的字号（pt）。0 = 跟随版式量到的原尺寸。 */
  puFontSize?: number;
  puPptFontSize?: number;
  /** **PPT 档**的前景色（谱面笔画/文字）与背景色（纸张），ARGB。
   *  字段名不改是为了存量数据：默认档一直是 PPT，旧版存的就是那一档的色。 */
  color?: number;
  bgColor?: number;
  /** **简谱档**的那一套。 */
  jianpuColor?: number;
  jianpuBgColor?: number;
  zoom?: number;
  mixedHideBarNumber?: boolean;
  mixedShowJianpuLayer?: boolean;
  /** 交 PlaybackController 自己校验 */
  playSpeed?: unknown;
  /** 交 OmrController 自己校验 */
  omrFormat?: unknown;
  /** 版面档（原版 / PPT）。两种谱各记各的：简谱 normal|pptx、文本谱 print|slide。 */
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
