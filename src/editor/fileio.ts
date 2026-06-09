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
