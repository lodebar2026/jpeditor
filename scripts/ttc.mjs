// 从 TrueType Collection（.ttc）里抽出单个字体的 sfnt 字节。
//
// 为什么要它：macOS 的中文字体（Songti / STHeiti / Kaiti / Lantinghei）几乎都是 ttc，
// 而 pdf-lib 的 embedFont 与 opentype.js 都只吃单个 sfnt——直接喂 ttc 会报
// `Unsupported OpenType signature ttcf`。
//
// ttc 的结构：`ttcf` 头 + 每个子字体的表目录偏移；**各子字体常常共享同一份表数据**，
// 所以不能整段切，得按表记录重新拼一个独立的 sfnt。
import { readFile } from "node:fs/promises";

/** 列出 ttc 里的子字体（返回每个的 name 表里的全名）。 */
export async function listTtc(path) {
  const buf = await readFile(path);
  const offsets = ttcOffsets(buf);
  if (!offsets) return [{ index: 0, name: null }];
  return offsets.map((off, i) => ({ index: i, name: sfntName(buf, off) }));
}

function ttcOffsets(buf) {
  if (buf.toString("latin1", 0, 4) !== "ttcf") return null;
  const n = buf.readUInt32BE(8);
  const offs = [];
  for (let i = 0; i < n; i++) offs.push(buf.readUInt32BE(12 + i * 4));
  return offs;
}

/** 读某个子字体 name 表里的 nameID=4（完整名）。 */
function sfntName(buf, off) {
  const numTables = buf.readUInt16BE(off + 4);
  for (let i = 0; i < numTables; i++) {
    const rec = off + 12 + i * 16;
    if (buf.toString("latin1", rec, rec + 4) !== "name") continue;
    const tOff = buf.readUInt32BE(rec + 8);
    const count = buf.readUInt16BE(tOff + 2);
    const strOff = tOff + buf.readUInt16BE(tOff + 4);
    for (let k = 0; k < count; k++) {
      const r = tOff + 6 + k * 12;
      const nameId = buf.readUInt16BE(r + 6);
      if (nameId !== 4) continue;
      const platform = buf.readUInt16BE(r);
      const len = buf.readUInt16BE(r + 8);
      const o = strOff + buf.readUInt16BE(r + 10);
      const raw = buf.subarray(o, o + len);
      // **必须先拷贝**：`swap16()` 是原地改的，而 raw 是文件缓冲的视图——
      // 直接换字节序会把 name 表本身改坏，随后按表记录拷出来的 sfnt 里，
      // 字体全名就成了字节颠倒的乱码（各子字体还共用这份表）。
      // 长度为奇数时 swap16 会抛，退回 latin1。
      if ((platform === 3 || platform === 0) && len % 2 === 0) return Buffer.from(raw).swap16().toString("utf16le");
      return raw.toString("latin1");
    }
  }
  return null;
}

/**
 * 抽出 ttc 里的一个子字体，返回独立 sfnt 的 Uint8Array。
 * `pick` 可以是下标，也可以是名字里的子串（如 "Songti SC"）。
 * 传入的若本就是单字体文件，原样返回。
 */
export async function extractTtc(path, pick = 0) {
  const buf = await readFile(path);
  const offsets = ttcOffsets(buf);
  if (!offsets) return new Uint8Array(buf);

  let idx = typeof pick === "number" ? pick : -1;
  if (idx < 0) {
    for (let i = 0; i < offsets.length; i++) {
      const nm = sfntName(buf, offsets[i]);
      if (nm && nm.toLowerCase().includes(String(pick).toLowerCase())) {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0 || idx >= offsets.length) throw new Error(`ttc 里没有 ${pick}：${offsets.map((o) => sfntName(buf, o)).join(" / ")}`);

  const off = offsets[idx];
  const sfntVersion = buf.readUInt32BE(off);
  const numTables = buf.readUInt16BE(off + 4);
  const records = [];
  for (let i = 0; i < numTables; i++) {
    const r = off + 12 + i * 16;
    records.push({
      tag: buf.toString("latin1", r, r + 4),
      checksum: buf.readUInt32BE(r + 4),
      offset: buf.readUInt32BE(r + 8),
      length: buf.readUInt32BE(r + 12),
    });
  }
  records.sort((a, b) => (a.tag < b.tag ? -1 : 1)); // 表目录按 tag 升序

  const dirSize = 12 + numTables * 16;
  const pad4 = (n) => (n + 3) & ~3;
  let total = dirSize;
  for (const r of records) total += pad4(r.length);
  const out = Buffer.alloc(total);

  out.writeUInt32BE(sfntVersion, 0);
  out.writeUInt16BE(numTables, 4);
  // searchRange / entrySelector / rangeShift
  const p2 = Math.pow(2, Math.floor(Math.log2(numTables)));
  out.writeUInt16BE(p2 * 16, 6);
  out.writeUInt16BE(Math.log2(p2), 8);
  out.writeUInt16BE(numTables * 16 - p2 * 16, 10);

  let cursor = dirSize;
  records.forEach((r, i) => {
    const rec = 12 + i * 16;
    out.write(r.tag, rec, 4, "latin1");
    out.writeUInt32BE(r.checksum, rec + 4);
    out.writeUInt32BE(cursor, rec + 8);
    out.writeUInt32BE(r.length, rec + 12);
    buf.copy(out, cursor, r.offset, r.offset + r.length);
    cursor += pad4(r.length);
  });
  return new Uint8Array(out);
}
