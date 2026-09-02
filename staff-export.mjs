// 把指定页范围的识别结果导出成 MusicXML（每个系统的**顶行**串成单声部主旋律）。
//
//   npm run build:cli && node staff-export.mjs 154 /tmp/out.musicxml
//   node staff-export.mjs 99-100 /tmp/out.musicxml --title="Let the Light of Your Face"
import { readFile, writeFile } from "node:fs/promises";
import { openPdf, loadCli, ZMZQ_PDF, parsePageRange } from "./scripts/node-harness.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const spec = args.find((a) => !a.startsWith("--")) ?? "154";
const out = args.filter((a) => !a.startsWith("--"))[1] ?? "/tmp/staff.musicxml";

const cli = await loadCli();
const look = cli.makeLookup(JSON.parse(await readFile("src/staffomr/glyphmap.json", "utf8")));
const { doc, OPS } = await openPdf(ZMZQ_PDF);
const pages = parsePageRange(spec, doc.numPages);

// 逐页识别，再按 `score.ts` 把系统串成声部（钢琴谱两行合成一个 <part>）
const entries = [];
const notesByStaff = new Map();
let carryTime;
for (const pn of pages) {
  const page = await doc.getPage(pn);
  const r = await cli.recognizeStaffPage(page, OPS, look, pn, { carryTime });
  carryTime = r.carryTime;
  if (!r.hasStaff) { page.cleanup?.(); continue; }
  entries.push({ page: r.page, ctx: r.ctx });
  for (const n of r.notes) {
    const a = notesByStaff.get(n.staff) ?? [];
    a.push(n);
    notesByStaff.set(n.staff, a);
  }
  page.cleanup?.();
}
const score = cli.buildScore(entries);
const xml = cli.scoreToMusicXml(score, (st) => notesByStaff.get(st) ?? [], { title: argOf("title") });
await writeFile(out, xml);
const total = [...notesByStaff.values()].reduce((a, v) => a + v.length, 0);
console.log(`${pages.length} 页 → ${score.systems.length} 个系统 / ${score.parts.length} 个声部` +
  `（每声部 ${score.parts.map((p) => p.scoreStaves.length).join(",")} 行谱） / ${total} 个音符 → ${out}`);
