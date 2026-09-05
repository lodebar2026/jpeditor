// 位图路的**无主 contour**报表：整页的墨里，还有多少是识别从没看见的。
//
//   npm run build:cli && node scripts/raster-unclaimed.mjs
//   node scripts/raster-unclaimed.mjs --one=宁静 --v      # 逐页明细
//   node scripts/raster-unclaimed.mjs --top=30            # 形状类排行取前几名
//
// 与 `chorus-symbols.mjs` 的分工：那边量「认出来的对不对」，这边量
// **「有什么是我们从没看见的」**——松叶、力度、表情文字、段落记号至今一个不认，
// 在别的报表上一点痕迹都不留。判据全在 `src/rasteromr/ledger.ts`，这里只出表。
//
// 三张表：
//   1. 墨覆盖率（认领过的 contour 的墨 / 全页墨）逐曲；
//   2. 无主 contour 按 **32×32 签名**聚类的排行（尺寸、孔数、典型位置、样本坐标）；
//   3. 无主按**位置**分档（谱表带内 / 上方 / 下方 / 远处）。
//
// 只跑**干净位图**那一档（与基线同口径：线宽 ≤ 线距的两成）。
import { readFile } from "node:fs/promises";
import { openPdf, eachPage, loadCli, loadChorus } from "./node-harness.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const verbose = args.includes("--v");
const only = argOf("one");
const topN = Number(argOf("top") ?? 20);
/** 签名聚类的汉明距离上限。与 `rasterglyphs.ts` 建库那一路同量级。 */
const SIG_DIST = 60;

const cli = await loadCli();
/** 歌词条的 OCR 缓存（`gen-rasterlyrics.mjs` 的产物）。缓存与否不影响字格的认领
 *  （字格照切照记账），带上只是让这份报表与识别时跑的是同一条路。 */
let lyricOcr = null;
try {
  lyricOcr = new Map(Object.entries(JSON.parse(await readFile("src/rasteromr/rasterlyrics.json", "utf8"))));
} catch {
  console.log("（没有 src/rasteromr/rasterlyrics.json，歌词按纯几何字格记账）");
}
const look = new cli.RasterGlyphLookup(JSON.parse(await readFile("src/rasteromr/rasterglyphs.json", "utf8")));
look.templates = cli.outlineTemplates(JSON.parse(await readFile("src/staffomr/glyphmap.json", "utf8")));

const ham = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
};

/** 一类无主形状：签名代表 + 实例。 */
const classes = [];
function addToClass(sig, inst) {
  let best = null;
  let bd = Infinity;
  for (const c of classes) {
    // 尺寸先粗筛（同一个符号在两种谱表大小下也差不了两成）
    if (Math.abs(c.w - inst.w) > 0.5 || Math.abs(c.h - inst.h) > 0.5) continue;
    const d = ham(c.sig, sig);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  if (best && bd <= SIG_DIST) {
    best.items.push(inst);
    return;
  }
  classes.push({ sig, w: inst.w, h: inst.h, items: [inst] });
}

const totals = { ink: 0, claimed: 0, contours: 0, unclaimed: 0, unclaimedInk: 0 };
const zones = new Map();
const songRows = [];

for (const song of (await loadChorus()).filter((s) => !only || s.name.includes(only))) {
  for (const pdf of song.pdfs) {
    const file = pdf.split("/").pop();
    const { doc, OPS } = await openPdf(pdf);
    const acc = { ink: 0, claimed: 0, contours: 0, unclaimed: 0, unclaimedInk: 0 };
    let carry, cleanPages = 0, allPages = 0;
    const pending = [];
    await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
      const r = await cli.recognizeRasterPage(page, OPS, look, pn, { carryTime: carry, lyricOcr });
      carry = r.carryTime;
      if (!r.hasStaff || !r.ledger || !r.raster) return;
      allPages++;
      if (r.unit && r.unit.lineThick <= r.unit.space * 0.2) cleanPages++;
      const cov = r.ledger.coverage();
      const un = r.ledger.unclaimed();
      acc.ink += cov.ink;
      acc.claimed += cov.claimed;
      acc.contours += cov.total;
      acc.unclaimed += un.length;
      for (const c of un) acc.unclaimedInk += c.area;
      if (verbose)
        console.log(
          `  p${pn}  墨 ${cov.ink}  覆盖 ${(cov.ratio * 100).toFixed(1)}%  contour ${cov.total}（无主 ${un.length}）`,
        );
      // 太小的（不到 0.1 格见方）是二值化的毛刺，不进形状表——但仍计进上面的数
      for (const c of un) {
        if (c.w < 0.2 && c.h < 0.2) continue;
        pending.push({
          sig: cli.binSig(r.raster.bin, c.bbox),
          w: c.w,
          h: c.h,
          holes: c.holes,
          compact: c.compact,
          zone: c.place.zone,
          gap: c.place.gap,
          where: `${song.name}/${file} p${pn} (${c.bbox.x},${c.bbox.y},${c.bbox.w}x${c.bbox.h})`,
        });
      }
    });
    if (!allPages) continue;
    const clean = cleanPages >= allPages * 0.8;
    songRows.push({ song: song.name, file, clean, ...acc });
    console.log(
      `${clean ? "[干净]" : "[扫描]"} ${song.name}/${file}  墨覆盖 ${((acc.claimed / Math.max(1, acc.ink)) * 100).toFixed(1)}%  ` +
        `contour ${acc.contours}（无主 ${acc.unclaimed}，占墨 ${((acc.unclaimedInk / Math.max(1, acc.ink)) * 100).toFixed(1)}%）`,
    );
    if (!clean) continue; // 形状表只收干净位图那一档
    totals.ink += acc.ink;
    totals.claimed += acc.claimed;
    totals.contours += acc.contours;
    totals.unclaimed += acc.unclaimed;
    totals.unclaimedInk += acc.unclaimedInk;
    for (const it of pending) {
      addToClass(it.sig, it);
      const key = it.zone === "in" ? "谱表带内" : it.gap > 6 ? "远处（页眉/页脚/页边）" : it.zone === "above" ? "谱表上方" : "谱表下方";
      zones.set(key, (zones.get(key) ?? 0) + 1);
    }
  }
}

const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
console.log(
  `\n【干净位图合计】墨覆盖 ${((totals.claimed / Math.max(1, totals.ink)) * 100).toFixed(1)}%　` +
    `contour ${totals.contours}，无主 ${totals.unclaimed}（占墨 ${((totals.unclaimedInk / Math.max(1, totals.ink)) * 100).toFixed(1)}%）`,
);

console.log(`\n【无主 contour 按位置】`);
for (const [k, v] of [...zones].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);

console.log(`\n【无主 contour 形状类排行】前 ${topN}（共 ${classes.length} 类）`);
classes.sort((a, b) => b.items.length - a.items.length);
for (const c of classes.slice(0, topN)) {
  const it = c.items;
  console.log(
    `  ${String(it.length).padStart(5)} 个  ` +
      `${med(it.map((x) => x.w)).toFixed(2)}×${med(it.map((x) => x.h)).toFixed(2)} 格  ` +
      `孔${med(it.map((x) => x.holes))}  团状${med(it.map((x) => x.compact)).toFixed(2)}  ` +
      `${it.filter((x) => x.zone === "in").length}内/${it.filter((x) => x.zone === "above").length}上/${it.filter((x) => x.zone === "below").length}下  ` +
      `例 ${it[0].where}`,
  );
}
