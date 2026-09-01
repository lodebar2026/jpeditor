// .jpwabc encoding helpers. JP-Word writes UTF-16LE; we read BOM-aware and
// write UTF-16LE with a BOM for unambiguous round-tripping.

import { isTauri } from "@tauri-apps/api/core";

export function isTauriRuntime(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

export function decodeJpwabc(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  // No BOM: heuristically detect UTF-16LE (ASCII-heavy text -> many 0x00 high bytes).
  let zeroHigh = 0;
  const sample = Math.min(bytes.length, 200);
  for (let i = 1; i < sample; i += 2) if (bytes[i] === 0) zeroHigh++;
  if (sample > 0 && zeroHigh / (sample / 2) > 0.3) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** 桌面端统一交给 Rust 写盘。除了绕开 WebView 的文件权限差异，也保证“保存”写回
 *  当前文件本身，而不是再次弹出下载/另存为。 */
export async function writeBytesInPlace(path: string, bytes: Uint8Array): Promise<void> {
  if (!isTauriRuntime()) throw new Error("原地写入只在桌面版可用");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_file_cmd", { path, bytes: Array.from(bytes) });
}

/** 落盘：Tauri 走保存对话框 + 原生写盘命令，浏览器走 a[download]。
 *  返回落盘路径（仅 Tauri；用户取消或浏览器下载返回 null）。 */
export async function saveBytes(
  bytes: Uint8Array,
  defaultName: string,
  mime = "application/octet-stream",
): Promise<string | null> {
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({ defaultPath: defaultName });
    if (!dest) return null;
    await writeBytesInPlace(dest, bytes);
    return dest;
  } else {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const blob = new Blob([ab], { type: mime });
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = defaultName;
    a.style.display = "none";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return null;
  }
}

export function encodeJpwabc(text: string): Uint8Array {
  const units = text.length;
  const out = new Uint8Array(2 + units * 2);
  out[0] = 0xff; // BOM LE
  out[1] = 0xfe;
  for (let i = 0; i < units; i++) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[2 + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return out;
}
