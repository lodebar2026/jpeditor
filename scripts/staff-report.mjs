// 五线谱识别的逐页统计：谱行数、符头数、小节数、未归属对象数。
// 先立事实，再谈准确率——照 500 首那条路 `page-report.mjs` 的规矩。
//
//   node staff-report.mjs [--pages=100-110] [--v]
import { readFile } from "node:fs/promises";
import { openPdf, eachPage, parsePageRange, loadCli, ZMZQ_PDF } from "./node-harness.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const verbose = args.includes("--v");

const cli = await loadCli();
const dict = JSON.parse(await readFile("src/staffomr/glyphmap.json", "utf8"));
const look = cli.makeLookup(dict);
const { doc, OPS } = await openPdf(ZMZQ_PDF);
const pages = parsePageRange(argOf("pages"), doc.numPages);

let noStaff = 0, unknown = 0, staves = 0, notes = 0, bars = 0, stems = 0, barlines = 0, uSeg = 0, segs = 0;
let barChecked = 0, barFull = 0;
let grandPages = 0, exportFail = 0, notesTop = 0;
// 拍号跨页继承：续页不再印拍号
let carryTime;
const worst = [];
const t0 = Date.now();
await eachPage(doc, pages, async (page, pn) => {
  const r = await cli.recognizeStaffPage(page, OPS, look, pn, { carryTime });
  carryTime = r.carryTime;
  const pg = r.page;
  if (!r.hasStaff) { noStaff++; if (verbose) console.log(`p${pn} 无谱表 未归属${r.unknown}`); return; }
  const n = pg.symbols.filter((s) => s.hasTag("Note")).length;
  const b = pg.staves.reduce((a, s) => a + s.bars.length, 0);
  const st = pg.segsWithTag("Stem").length + pg.symbols.filter((s) => s.hasTag("Stem")).length;
  const bl = pg.segsWithTag("BarLine").length + pg.symbols.filter((s) => s.hasTag("BarLine")).length;
  staves += pg.staves.length; notes += n; bars += b; unknown += r.unknown; stems += st; barlines += bl;
  uSeg += cli.unknownSegs(pg).length; segs += pg.segs.length;
  barChecked += r.bars.length; barFull += r.bars.filter((b) => b.full).length;
  // 声部结构 + 导出冒烟：整本书都要能跑通，出一次错就是判据崩了
  const byStaff = new Map();
  for (const n of r.notes) { const a = byStaff.get(n.staff) ?? []; a.push(n); byStaff.set(n.staff, a); }
  try {
    const sc = cli.buildScore([{ page: pg, ctx: r.ctx }]);
    if (sc.parts.some((p) => p.scoreStaves.length > 1)) grandPages++;
    cli.scoreToMusicXml(sc, (st) => byStaff.get(st) ?? [], {});
    notesTop += pg.systems.reduce((a, s) => a + (byStaff.get(s.top)?.length ?? 0), 0);
  } catch {
    exportFail++;
  }
  worst.push([pn, r.unknown, pg.staves.length, n]);
  if (verbose) console.log(`p${pn} 谱行${pg.staves.length} 音符${n} 小节${b} 符干${st} 小节线${bl} 未归属${r.unknown}`);
});
console.log(`\n${pages.length} 页 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`无谱表页 ${noStaff}  谱行 ${staves}  音符 ${notes}  小节 ${bars}  符干 ${stems}  小节线 ${barlines}`);
console.log(`未归属对象 ${unknown}   未归属线段 ${uSeg}/${segs}`);
// 不靠 GT 的自检：小节里的时值加起来对不对得上拍号。
// 弱起、跨行断开的小节天然对不上，所以这个数到不了 100%——它是**相对**指标，只看涨跌。
console.log(`大谱表页 ${grandPages}；导出出错 ${exportFail} 页；` +
  `只取顶行会漏掉的音符 ${notes - notesTop}/${notes}（${(((notes - notesTop) / Math.max(notes, 1)) * 100).toFixed(1)}%，` +
  `这些是钢琴/SATB 的伴奏行，接上声部结构之前整批丢掉）`);
console.log(`小节时值自检：对得上 ${barFull}/${barChecked}（${((barFull / Math.max(barChecked, 1)) * 100).toFixed(1)}%）`);
worst.sort((a, b) => b[1] - a[1]);
console.log("未归属最多的页:", worst.slice(0, 12).map(([p, u, s, n]) => `p${p}:${u}(谱行${s} 音符${n})`).join(" "));
const noNote = worst.filter((w) => w[3] === 0);
console.log(`有谱行但一个音符都没认出的页 ${noNote.length}:`, noNote.slice(0, 15).map((w) => "p" + w[0]).join(","));
