// 合唱谱语料的逐页事实。先立事实，再谈准确率——照 `staff-report.mjs` 的规矩。
//
//   node scripts/chorus-report.mjs                  # 全部曲目
//   node scripts/chorus-report.mjs --one=宁静       # 只跑名字含该串的曲目
//   node scripts/chorus-report.mjs --pages=1-3 --v  # 逐页明细
//
// 这一份**只量底本形态与谱行几何**，不做识别——识别在 `src/rasteromr/` 铺开之后
// 再往里加。眼下它回答三个问题：
//   1. 这份 PDF 是哪一类（矢量 / 干净位图 / 真扫描件）？
//   2. 位图的分辨率、线距、倾斜是多少？
//   3. 谱行找得出来吗、每页几行？
import { writeFile, mkdir } from "node:fs/promises";
import { openPdf, eachPage, parsePageRange, loadCli, loadChorus } from "./node-harness.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const verbose = args.includes("--v");
const only = argOf("one");

const cli = await loadCli();
const songs = (await loadChorus()).filter((s) => !only || s.name.includes(only));
if (!songs.length) {
  console.log("没有匹配的曲目");
  process.exit(1);
}

/**
 * 这一页是什么形态。三档，判据都在这里，别散到别处：
 *   - `矢量`：文字层里有音乐字体的字形（Maestro/Opus/Anastasia）——走 `src/staffomr/`。
 *   - `位图`：取得到整页位图。再按**墨迹的干净程度**分「干净」与「扫描」：
 *     排版软件贴的位图墨迹占比低、线宽整齐；真扫描件（Xerox / 手机拍）噪点多、
 *     行投影出来的谱线不齐。这里用**谱线的线宽方差**当代理量——
 *     干净位图的五条谱线线宽几乎相同（实测 2~3 px），扫描件会散开。
 *   - `空`：两样都没有（封面彩图页、纯文字页）。
 */
function classify(musicGlyphs, raster) {
  if (musicGlyphs > 50) return "矢量";
  if (!raster) return "空";
  return "位图";
}

const rows = [];
for (const song of songs) {
  for (const pdfPath of song.pdfs) {
    const file = pdfPath.split("/").pop();
    const { doc, OPS } = await openPdf(pdfPath);
    const pages = parsePageRange(argOf("pages"), doc.numPages);
    const acc = { 矢量: 0, 位图: 0, 空: 0 };
    let staffPages = 0, staves = 0, wMax = 0, spSum = 0, spN = 0, thickSum = 0, thickN = 0, skewMax = 0;
    await eachPage(doc, pages, async (page, pn) => {
      const runs = await cli.extractTextPage(page, OPS, { scale: 1 });
      let musicGlyphs = 0;
      for (const r of runs) if (cli.musicFamily(r.font)) musicGlyphs += r.glyphs.length;
      const raster = musicGlyphs > 50 ? null : await cli.rasterizePage(page, OPS);
      const kind = classify(musicGlyphs, raster);
      acc[kind]++;
      let info = "";
      if (raster) {
        wMax = Math.max(wMax, raster.bin.w);
        const g = staffGeometry(raster.bin);
        if (g) {
          staffPages++;
          staves += g.count;
          spSum += g.space * g.count; spN += g.count;
          thickSum += g.thick * g.count; thickN += g.count;
          skewMax = Math.max(skewMax, g.skew);
          info = ` 谱行${g.count} 线距${g.space.toFixed(1)}px 线宽${g.thick.toFixed(1)}px 倾斜${g.skew.toFixed(2)}px`;
        }
        info += ` 墨${(cli.inkRatio(raster.bin) * 100).toFixed(1)}% ${raster.bin.w}×${raster.bin.h}`;
      } else if (musicGlyphs) info = ` 音乐字形${musicGlyphs}`;
      if (verbose) console.log(`  p${pn} ${kind}${info}`);
    });
    rows.push({
      song: song.name, file, pages: doc.numPages, gt: !!song.gt,
      ...acc, staffPages, staves, wMax,
      space: spN ? spSum / spN : 0, thick: thickN ? thickSum / thickN : 0, skew: skewMax,
    });
    console.log(`${song.name} / ${file}  ${doc.numPages}页  矢量${acc.矢量} 位图${acc.位图} 空${acc.空}` +
      (staffPages ? `  谱行页${staffPages} 共${staves}行 线距${(spSum / spN).toFixed(1)}px 线宽${(thickSum / thickN).toFixed(1)}px 倾斜≤${skewMax.toFixed(2)}px` : "") +
      `  GT:${song.gt ? "有" : "无"}`);
  }
}

await mkdir("staff-out", { recursive: true });
await writeFile("staff-out/chorus-report.json", JSON.stringify(rows, null, 1));
console.log("\n→ staff-out/chorus-report.json");

/**
 * 行投影找谱线，顺带量线距/线宽/倾斜。**这是位图路的第一块判据**，
 * 铺开 `src/rasteromr/staffline.ts` 之前先在脚本里立事实。
 *
 * 谱线的特征：一整行几乎全是墨。门槛取「页宽的 30%」——比这更短的横线是
 * 符杠、加线、渐强线。找出来之后按「五条一组、间距相近」分组。
 *
 * 倾斜：拿每条线**左三分之一与右三分之一**的墨迹中心 y 之差当代理量，
 * 取全页最大。干净位图这个数接近 0，扫描件会有几个像素。
 */
function staffGeometry(bin) {
  const { w, h, data } = bin;
  const th = w * 0.3;
  const runs = [];
  let start = -1;
  for (let y = 0; y < h; y++) {
    let n = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) n += data[row + x];
    if (n > th) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      runs.push([start, y - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, h - 1]);
  // 太厚的不是谱线（是黑边、粗横线）：厚度超过页高的 1%
  const lines = runs.filter((r) => r[1] - r[0] + 1 <= Math.max(6, h * 0.01));
  if (lines.length < 5) return null;
  // 五条一组：相邻间距的相对差在两成以内
  let count = 0, spaceSum = 0, spaceN = 0;
  for (let i = 0; i + 4 < lines.length; ) {
    const ys = lines.slice(i, i + 5).map((r) => (r[0] + r[1]) / 2);
    const ds = [ys[1] - ys[0], ys[2] - ys[1], ys[3] - ys[2], ys[4] - ys[3]];
    const avg = ds.reduce((a, b) => a + b, 0) / 4;
    if (avg > 0 && ds.every((d) => Math.abs(d - avg) <= avg * 0.2)) {
      count++;
      spaceSum += avg; spaceN++;
      i += 5;
    } else i++;
  }
  if (!count) return null;
  const thick = lines.reduce((a, r) => a + (r[1] - r[0] + 1), 0) / lines.length;
  // 倾斜：每条线左右两段的墨迹中心 y 之差
  let skew = 0;
  for (const [y0, y1] of lines) {
    const mid = (y0 + y1) / 2;
    const band = 3;
    const cyOf = (x0, x1) => {
      let s = 0, n = 0;
      for (let y = Math.max(0, Math.round(mid - band)); y <= Math.min(h - 1, Math.round(mid + band)); y++)
        for (let x = x0; x < x1; x++) if (data[y * w + x]) { s += y; n++; }
      return n ? s / n : mid;
    };
    skew = Math.max(skew, Math.abs(cyOf(0, (w / 3) | 0) - cyOf(((2 * w) / 3) | 0, w)));
  }
  return { count, space: spaceSum / spaceN, thick, skew };
}
