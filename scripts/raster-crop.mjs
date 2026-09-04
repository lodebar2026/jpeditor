// 按识别坐标（= 位图像素）裁一块出来，把识别结果**画在上面**核对。
//
//   npm run build:cli && node scripts/raster-crop.mjs 宁静 1 /tmp/a.pgm
//   node scripts/raster-crop.mjs 宁静 1 /tmp/a.pgm --staff=3      # 只裁第 3 行谱
//   node scripts/raster-crop.mjs 宁静 1 /tmp/a.pgm --box=150,320,1000,240
//
// 画法（一律描边，不填，免得盖住原图）：
//   符头 = 方框；谱线 = 左端一小截；加线 = 上下两条短横；小节线/符干 = 端点两横。
// 存 PGM（谁都打得开，不引图像库）；`--png` 需要外部工具，脚本不管。
//
// 比 `staff-crop.mjs` 简单：位图路不必起浏览器光栅化，图本来就在手上。
import { readFile, writeFile } from "node:fs/promises";
import { openPdf, eachPage, loadCli, loadChorus } from "./node-harness.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const [name, pnRaw, out] = args.filter((a) => !a.startsWith("--"));
if (!name || !out) {
  console.log("用法: node scripts/raster-crop.mjs <曲名串> <页号> <输出.pgm> [--staff=N | --box=x,y,w,h] [--marks=head,leger,bar,stem,beam]");
  process.exit(1);
}
const pn = Number(pnRaw ?? 1);
const marks = new Set((argOf("marks") ?? "head,leger,bar,stem,beam").split(","));

const cli = await loadCli();
const look = new cli.RasterGlyphLookup(JSON.parse(await readFile("src/rasteromr/rasterglyphs.json", "utf8")));
const song = (await loadChorus()).find((s) => s.name.includes(name));
if (!song) {
  console.log("没有这首");
  process.exit(1);
}
const { doc, OPS } = await openPdf(song.pdfs[0]);
await eachPage(doc, [pn], async (page) => {
  const r = await cli.recognizeRasterPage(page, OPS, look, pn, {});
  if (!r.raster) {
    console.log("这一页取不到位图");
    return;
  }
  const bin = r.raster.bin;
  const canvas = { w: bin.w, h: bin.h, data: new Uint8Array(bin.data) };
  const set = (x, y) => {
    if (x >= 0 && y >= 0 && x < canvas.w && y < canvas.h) canvas.data[y * canvas.w + x] = 1;
  };
  const rect = (x0, y0, x1, y1) => {
    for (let x = Math.round(x0); x <= Math.round(x1); x++) { set(x, Math.round(y0)); set(x, Math.round(y1)); }
    for (let y = Math.round(y0); y <= Math.round(y1); y++) { set(Math.round(x0), y); set(Math.round(x1), y); }
  };
  if (r.hasStaff) {
    if (marks.has("head")) for (const s of r.page.symbols) {
      if (!s.ownerStaff) continue;
      rect(s.box.left - 2, s.box.top - 2, s.box.right + 2, s.box.bottom + 2);
    }
    if (marks.has("leger")) for (const s of r.page.segs) {
      if (!s.hasTag("Leger")) continue;
      rect(s.left, s.cy - 3, s.right, s.cy + 3);
    }
    if (marks.has("bar")) for (const s of r.page.segsWithTag("BarLine")) rect(s.cx - 4, s.top, s.cx + 4, s.bottom);
    if (marks.has("stem")) for (const s of r.page.segsWithTag("Stem")) rect(s.cx - 3, s.top, s.cx + 3, s.bottom);
    if (marks.has("beam")) for (const b of r.beams) rect(b.box.left, b.box.top, b.box.right, b.box.bottom);
  }
  // 裁
  let box = { x: 0, y: 0, w: bin.w, h: bin.h };
  const bx = argOf("box");
  const sIdx = argOf("staff");
  if (bx) {
    const [x, y, w, h] = bx.split(",").map(Number);
    box = { x, y, w, h };
  } else if (sIdx !== undefined && r.hasStaff) {
    const st = r.page.staves[Number(sIdx)];
    if (st) {
      const sp = r.unit.space;
      box = { x: 0, y: Math.max(0, Math.round(st.box.top - sp * 5)), w: bin.w, h: Math.round(st.box.bottom - st.box.top + sp * 10) };
    }
  }
  const crop = { w: Math.min(box.w, bin.w - box.x), h: Math.min(box.h, bin.h - box.y), data: null };
  crop.data = new Uint8Array(crop.w * crop.h);
  for (let y = 0; y < crop.h; y++)
    for (let x = 0; x < crop.w; x++) crop.data[y * crop.w + x] = canvas.data[(box.y + y) * canvas.w + box.x + x];
  await writeFile(out, cli.binToPgm(crop));
  const heads = r.hasStaff ? r.page.symbols.filter((s) => s.ownerStaff).length : 0;
  console.log(`p${pn} ${bin.w}×${bin.h} 线距${r.unit?.space.toFixed(1)} 谱行${r.page.staves.length} 归属符头${heads} → ${out}（裁 ${box.x},${box.y} ${crop.w}×${crop.h}）`);
});
