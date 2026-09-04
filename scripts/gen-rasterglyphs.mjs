// 位图符号的形状字典建库：扫全语料的连通块 → 32×32 签名聚类 → 形状类。
//
//   npm run build:cli && node scripts/gen-rasterglyphs.mjs
//   node scripts/gen-rasterglyphs.mjs --one=宁静        # 只扫一首（调参用）
//   node scripts/gen-rasterglyphs.mjs --min=5           # 接触表只列实例数 ≥5 的类
//
// 产物：src/rasteromr/rasterglyphs.json（字典）
//       staff-out/rasterglyphsheet.html（人工确认表，浏览器打开）
//
// **只扫干净位图那一档**：真扫描件（破碎.pdf / 主，差遣我）倾斜三四个像素，
// 谱线找不齐、块也碎，混进来会把字典撑爆。矢量那份（我的产业）根本不走这条路。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { openPdf, eachPage, loadCli, loadChorus } from "./node-harness.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const only = argOf("one");
const MIN = Number(argOf("min") ?? 3);
const DICT = "src/rasteromr/rasterglyphs.json";

const cli = await loadCli();
// 已有的定案要留住：重跑建库不该把人工标过的名字冲掉
let prev = { classes: [] };
try {
  prev = JSON.parse(await readFile(DICT, "utf8"));
} catch {
  /* 第一次跑 */
}
const prevLook = prev.classes.filter((c) => c.smufl);

const builder = new cli.RasterGlyphBuilder();
/** 每个类留一个代表实例的**原始像素**，接触表画它。
 *  签名只有 32×32，休止符与升降号在那个尺度上糊成一团，定名会标错。 */
const sample = new Map();
let blobTotal = 0;
const t0 = Date.now();

for (const song of await loadChorus()) {
  if (only && !song.name.includes(only)) continue;
  for (const pdf of song.pdfs) {
    const file = pdf.split("/").pop();
    const { doc, OPS } = await openPdf(pdf);
    let clean = 0;
    await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
      const r = await cli.rasterizePage(page, OPS);
      if (!r) return;
      const unit = cli.estimateUnit(r.bin);
      if (!unit) return;
      const lines = cli.findStaffLines(r.bin);
      const groups = cli.groupStaves(lines);
      if (!groups.length) return;
      // **干净位图那一档才收**：谱线线宽超过线距的两成、或成不了组的线太多，
      // 那是扫描件，另论。
      if (unit.lineThick > unit.space * 0.2) return;
      if (lines.length - groups.length * 5 > groups.length) return;
      clean++;
      const nl = cli.removeStaffLines(r.bin, lines.map((l) => l.y), unit);
      const prims = cli.findPrimitives(nl, unit);
      const blobs = cli.findBlobs(nl, prims, unit);
      // **符头不进字典**：它按性质判（填充率 + 有没有符干，见 `notehead.ts`），
      // 形状签名反而不稳。不剔掉的话前二十个大类全是符头的残缺变体，
      // 真正要查字典的谱号/休止/升降/拍号被埋在下面。
      const heads = new Set(cli.findRasterHeads(blobs, prims.vSegs, unit).map((h) => h.comp.id));
      for (const c of blobs) {
        if (heads.has(c.id)) continue;
        const sig = cli.binSig(nl, c.bbox);
        const w = c.bbox.w / unit.space;
        const h = c.bbox.h / unit.space;
        const i = builder.add(sig, w, h, pn);
        blobTotal++;
        if (!sample.has(i)) {
          // 原分辨率裁一小块（PNG 编码不划算，直接存 0/1 行）
          const px = [];
          for (let y = 0; y < c.bbox.h; y++) {
            let row = "";
            for (let x = 0; x < c.bbox.w; x++) row += nl.data[(c.bbox.y + y) * nl.w + c.bbox.x + x] ? "1" : "0";
            px.push(row);
          }
          sample.set(i, { px, w, h, song: song.name, page: pn });
        }
      }
    });
    console.log(`${song.name}/${file}  干净位图页 ${clean}`);
  }
}

const { origin, ...dict } = builder.finish();
// `sample` 是按建库下标存的，`finish` 重编了 id，靠 origin 对回去
const sampleOf = (c) => sample.get(origin[c.id]);
// 把上一轮的定案按签名贴回来
let kept = 0;
for (const c of dict.classes) {
  const sig = cli.decodeSig(c.sig);
  for (const p of prevLook) {
    if (Math.abs(p.w - c.w) > 0.1 || Math.abs(p.h - c.h) > 0.1) continue;
    if (cli.sigDistance(cli.decodeSig(p.sig), sig) > 30) continue;
    c.smufl = p.smufl;
    c.source = p.source;
    kept++;
    break;
  }
}
console.log(`\n块 ${blobTotal} → 形状类 ${dict.classes.length}，沿用上一轮定案 ${kept} 类，${((Date.now() - t0) / 1000).toFixed(1)}s`);
const big = dict.classes.filter((c) => c.count >= MIN);
console.log(`实例 ≥${MIN} 的类 ${big.length}（覆盖 ${((big.reduce((a, c) => a + c.count, 0) / blobTotal) * 100).toFixed(1)}% 的块）`);
console.log("最大的 25 类:", dict.classes.slice(0, 25).map((c) => `#${c.id}×${c.count}(${c.w.toFixed(1)}×${c.h.toFixed(1)}${c.smufl ? " " + c.smufl : ""})`).join(" "));

await writeFile(DICT, JSON.stringify(dict, null, 1));
await mkdir("staff-out", { recursive: true });
await writeFile("staff-out/rasterglyphsheet.html", sheet(dict, big));
console.log(`→ ${DICT}\n→ staff-out/rasterglyphsheet.html`);

/** 人工确认表：每个类一格，画它的签名，标出 id / 实例数 / 尺寸 / 已定的名。 */
function sheet(dict, big) {
  const cell = (c) => {
    const s = sampleOf(c);
    const d = s ? pxPath(s.px) : cli.sigToPath(cli.decodeSig(c.sig));
    const vb = s ? `0 0 ${s.px[0]?.length ?? 1} ${s.px.length}` : "0 0 32 32";
    return `<figure${c.smufl ? ' class="done"' : ""}>` +
      `<svg viewBox="${vb}"><path d="${d}"/></svg>` +
      `<figcaption>#${c.id} ×${c.count}<br>${c.w.toFixed(2)}×${c.h.toFixed(2)}` +
      `${c.smufl ? `<br><b>${c.smufl}</b>` : ""}</figcaption></figure>`;
  };
  return `<!doctype html><meta charset="utf-8"><title>位图符号形状类</title>
<style>
 body{font:12px/1.4 system-ui;margin:16px;background:#fff;color:#111}
 h1{font-size:15px}
 .grid{display:flex;flex-wrap:wrap;gap:6px}
 figure{margin:0;width:74px;border:1px solid #ddd;border-radius:4px;padding:3px;text-align:center}
 figure.done{border-color:#2a2;background:#f4fbf4}
 svg{width:48px;height:48px;fill:#111}
 figcaption{font-size:10px;color:#555;word-break:break-all}
</style>
<h1>位图符号形状类：共 ${dict.classes.length} 类，实例 ≥${MIN} 的 ${big.length} 类（按实例数降序）</h1>
<div class="grid">${big.map(cell).join("")}</div>`;
}

/** 0/1 行 → SVG 的 `d`（逐行合并连续的墨迹格）。 */
function pxPath(px) {
  const out = [];
  px.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "1") { x++; continue; }
      let x2 = x;
      while (x2 + 1 < row.length && row[x2 + 1] === "1") x2++;
      out.push(`M${x} ${y}h${x2 - x + 1}v1h${-(x2 - x + 1)}z`);
      x = x2 + 1;
    }
  });
  return out.join("");
}

// 排查用：把代表实例按原分辨率拼成一张 PGM（`--pgm=路径`，配合 `--min`）。
const pgmOut = argOf("pgm");
if (pgmOut) {
  const cs = big.slice(0, Number(argOf("n") ?? 60));
  const CW = 64, CH = 112, cols = 12;
  const rows = Math.ceil(cs.length / cols);
  const W = cols * CW, H = rows * CH;
  const sheet = { w: W, h: H, data: new Uint8Array(W * H) };
  cs.forEach((c, i) => {
    const s = sampleOf(c);
    if (!s) return;
    const ox = (i % cols) * CW + 2, oy = ((i / cols) | 0) * CH + 2;
    s.px.forEach((row, y) => {
      if (y >= CH - 4) return;
      for (let x = 0; x < row.length && x < CW - 4; x++) if (row[x] === "1") sheet.data[(oy + y) * W + ox + x] = 1;
    });
  });
  await writeFile(pgmOut, cli.binToPgm(sheet));
  console.log(`→ ${pgmOut}（${cs.length} 类，12 列，行内顺序即上面列出的顺序）`);
}
