// 谱线**漏检**自检：拿逐列黑白游程当独立证据，看有没有整行谱没被行投影找出来。
//
//   npm run build:cli && node scripts/raster-lines.mjs
//   node scripts/raster-lines.mjs --one=差遣
//
// 两条证据是独立的：
//   - 行投影（`findStaffLines` + `groupStaves`）要求「一整行几乎全是墨」，页面一弯就抹平；
//   - 逐列黑白游程（`dewarp.ts::columnHits`）逐列量「五段黑夹四段白」，与斜弯无关。
//
// 判据：逐列命中里**落不进任何已检出谱行**（上下各放一格）的，按 y 聚成带
// （容差一个线距），有二十个以上取样列支持的才算「疑似漏检一行谱」。
// 不用「逐列看得见几行」直接与谱行数比——轨迹会被符号打断、带也会被倾斜拆碎，
// 那个数两头都不准（实测干净页 100 行谱只串得出 33 条轨迹、却聚出 175 条带）。
import { openPdf, eachPage, loadCli, loadChorus } from "./node-harness.mjs";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--one="))?.slice(6);
const cli = await loadCli();

let tot = { pages: 0, rows: 0, miss: 0, badPages: 0 };
for (const song of (await loadChorus()).filter((s) => !only || s.name.includes(only))) {
  for (const pdf of song.pdfs) {
    const { doc, OPS } = await openPdf(pdf);
    let rows = 0;
    let miss = 0;
    let np = 0;
    const bad = [];
    await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
      const r = await cli.rasterizePage(page, OPS);
      if (!r) return;
      // 与识别同一条路：行投影 + 逐列游程补线（`completeStaffLines`）
      const rowLines = cli.findStaffLines(r.bin);
      const { groups } = cli.completeStaffLines(r.bin, rowLines, cli.groupStaves(rowLines));
      const hits = cli.columnHits(r.bin);
      if (!groups.length && hits.length < 20) return; // 封面 / 纯文字页
      np++;
      rows += groups.length;
      const sp = groups.length ? groups[0].space : 18;
      const orphans = hits.filter((h) => !groups.some((g) => h.cy > g.lines[0].y - sp && h.cy < g.lines[4].y + sp)).sort((a, b) => a.cy - b.cy);
      let n = 0;
      for (let i = 0; i < orphans.length; ) {
        let j = i;
        while (j + 1 < orphans.length && orphans[j + 1].cy - orphans[j].cy <= sp) j++;
        if (j - i + 1 >= 20) n++;
        i = j + 1;
      }
      if (n) {
        miss += n;
        bad.push(`p${pn}:${groups.length}行+${n}漏`);
      }
    });
    if (!np) continue;
    tot.pages += np;
    tot.rows += rows;
    tot.miss += miss;
    tot.badPages += bad.length;
    console.log(`${song.name}/${pdf.split("/").pop()}  页${np} 谱行${rows}  ${bad.length ? "疑似漏检 " + bad.join(" ") : "无漏检"}`);
  }
}
console.log(`\n合计 ${tot.pages} 页、${tot.rows} 行谱：疑似漏检 ${tot.miss} 行（分布在 ${tot.badPages} 页）`);
