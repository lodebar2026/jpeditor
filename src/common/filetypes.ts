// 应用能打开的文件类型。**规则只在这里写一次**——以前散在四处（app.ts 的 PU_EXT_RE、
// main.ts 的 RECOG_EXT_RE、拖放分支里的内联正则、文件对话框的 accept 串），
// 而且已经不一致：浏览器拖放分支根本不做白名单，Tauri 分支做。

/** 文本谱（番茄 / 诗歌本）。`.txt` 太泛，进来后还要靠 sniffDialect 二次确认。 */
export const PU_EXT = ["pu", "fq", "jps", "txt"] as const;
/** 乐谱文档（编辑器直接打开的）。 */
export const DOC_EXT = ["jpwabc", ...PU_EXT, "xml", "musicxml", "abc"] as const;
/** 走 OMR 识别的图片 / PDF。 */
export const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "pdf"] as const;
/** 导入后不当作「当前文件路径」的那些（另存为要换格式，不能覆盖原文件）。 */
export const CONVERTED_EXT = ["xml", "musicxml", "abc"] as const;

const re = (exts: readonly string[]): RegExp => new RegExp(`\\.(${exts.join("|")})$`, "i");

export const isPuFile = (name: string): boolean => re(PU_EXT).test(name);
export const isDocFile = (name: string): boolean => re(DOC_EXT).test(name);
export const isImageFile = (name: string): boolean => re(IMAGE_EXT).test(name);
export const isConvertedFile = (name: string): boolean => re(CONVERTED_EXT).test(name);

/** `<input type=file accept>` 用的串。 */
export const acceptAttr = (exts: readonly string[]): string => exts.map((e) => `.${e}`).join(",");

/** 图片选择框的 accept（MIME + 扩展名双保险：部分浏览器只认其一）。 */
export const IMAGE_ACCEPT =
  "image/png,image/jpeg,image/webp,image/bmp,image/gif,application/pdf,.pdf";
